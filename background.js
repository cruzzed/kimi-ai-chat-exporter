// Kimi Conversation Exporter
// Firefox MV3 background script: exports Kimi.ai chats as Markdown/JSON/ZIP.

// --- State ---

var authToken = null;
var activeExport = null;
var exportPorts = [];

// Upper bound for request pacing delays.
var MAX_REQUEST_DELAY = 10000;

var PUA = /[\ue000-\uf8ff]/g;
var KIMI_HEADERS = {
  'Content-Type': 'application/json',
  'connect-protocol-version': '1',
  'x-msh-platform': 'web',
  'x-msh-version': '1.0.0',
  'x-language': 'en-US'
};

// Default export options (synced from storage on startup).
var opts = { thinking: false, tools: false, refs: true, format: 'both', requestDelay: 250 };

// --- Request pacing helpers ---

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// Read the base per-request delay (ms) from storage; fall back to the
// cached startup value, then to 250 ms.
async function getRequestDelay() {
  try {
    var s = await browser.storage.local.get('requestDelay');
    if (s.requestDelay) return s.requestDelay;
  } catch (e) { /* storage unavailable — use fallback */ }
  return opts.requestDelay || 250;
}

// --- Messaging (progress broadcast + port lifecycle) ---

function broadcast(type, data) {
  exportPorts = exportPorts.filter(function(p) {
    try {
      p.postMessage(Object.assign({ type: type }, data));
      return true;
    } catch (e) {
      return false;
    }
  });
}

browser.runtime.onConnect.addListener(function(port) {
  if (port.name !== 'export') return;
  exportPorts.push(port);
  port.onDisconnect.addListener(function() {
    exportPorts = exportPorts.filter(function(p) { return p !== port; });
  });

  // Send current status if an export is already running
  if (activeExport) {
    broadcast('progress', { pct: activeExport.pct, text: activeExport.text });
  }

  port.onMessage.addListener(async function(msg) {
    var s = await browser.storage.local.get(['thinking', 'tools', 'format']);
    var opt = { thinking: s.thinking || false, tools: s.tools || false, refs: true, format: s.format || 'both' };
    if (msg.options) opt = msg.options;
    try {
      if (msg.type === 'exportSingle') {
        activeExport = { pct: 0, text: '' };
        await exportChat(msg.chatId, opt);
        activeExport = null;
        broadcast('done', { ok: true });
      } else if (msg.type === 'exportBatch') {
        if (activeExport) return; // already running
        activeExport = { pct: 0, text: '0/0' };
        await exportAllWithProgress(msg.chatIds || [], opt);
        activeExport = null;
        broadcast('done', { ok: true });
      }
    } catch (e) {
      activeExport = null;
      broadcast('done', { ok: false, error: e.message });
    }
  });
});

// --- Runtime message handling ---

browser.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === 'setToken' && msg.token) authToken = msg.token;
  if (msg.type === 'getChatInfo') { handleGetChatInfo(msg.chatId).then(sendResponse); return true; }
  if (msg.type === 'getChatText') { handleGetChatText(msg.chatId, msg.options).then(sendResponse); return true; }
  if (msg.type === 'listChats') { handleListChats().then(sendResponse); return true; }
  if (msg.type === 'exportSingle') {
    exportChat(msg.chatId, msg.options || {})
      .then(function() { sendResponse({ ok: true }); })
      .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }
  if (msg.type === 'exportBatch') {
    exportAll(msg.options || {})
      .then(function() { sendResponse({ ok: true }); })
      .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }
});

// --- API client ---

async function getToken() {
  if (authToken) return authToken;
  var tabs = await browser.tabs.query({ url: 'https://www.kimi.ai/*' });
  if (!tabs.length) return null;
  return new Promise(function(resolve) {
    browser.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: function() { return localStorage.getItem('access_token'); }
    }).then(function(results) {
      if (results && results[0] && results[0].result) authToken = results[0].result;
      resolve(authToken);
    });
  });
}

// Single request attempt. Errors carry flags so the retry wrapper can
// distinguish auth failures (no retry) from retryable failures.
async function kimiFetchOnce(endpoint, body) {
  var token = await getToken();
  var headers = Object.assign({}, KIMI_HEADERS);
  if (token) headers['Authorization'] = 'Bearer ' + token;
  var r;
  try {
    r = await fetch('https://www.kimi.ai' + endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      credentials: 'include'
    });
  } catch (e) {
    e.networkError = true; // NetworkError / CORS / offline
    throw e;
  }
  if (!r.ok) {
    var text = await r.text();
    var err;
    if (r.status === 401 || r.status === 403) {
      err = new Error('Not logged into Kimi');
      err.authError = true;
    } else {
      err = new Error('API error ' + r.status + ': ' + text.substring(0, 100));
    }
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// Retries network failures and 429/5xx responses with linear backoff
// (baseDelay * attempt, up to 4 attempts total). 401/403 fail immediately.
async function kimiFetch(endpoint, body) {
  var baseDelay = await getRequestDelay();
  var lastError = null;
  for (var attempt = 1; attempt <= 4; attempt++) {
    try {
      return await kimiFetchOnce(endpoint, body);
    } catch (e) {
      lastError = e;
      if (e.authError) throw e;
      var retryable = e.networkError || e.status === 429 || (e.status >= 500 && e.status < 600);
      if (!retryable || attempt === 4) throw e;
      await sleep(baseDelay * attempt);
    }
  }
  throw lastError;
}

// --- Chat listing ---

// Tolerant next-page token extraction (response field naming varies).
function nextToken(d) {
  return d.nextPageToken || d.next_page_token || d.nextToken || d.next_token || null;
}

// Paginated ListChats: page_size 50, stops on empty page or after 200 pages.
async function listAllChats() {
  var chats = [];
  var token = null;
  var guard = 0;
  do {
    var body = token ? { page_size: 50, page_token: token, query: '' } : { page_size: 50, query: '' };
    var d = await kimiFetch('/apiv2/kimi.chat.v1.ChatService/ListChats', body);
    var page = d.chats || [];
    if (!page.length) break;
    chats = chats.concat(page);
    token = nextToken(d);
    if (token && page.length < 50) break; // no more pages
    if (++guard > 200) break; // safety
  } while (token);
  return chats;
}

async function handleGetChatInfo(chatId) {
  try {
    var name = chatId;
    var createTime = null;
    var chats = await listAllChats();
    var found = chats.find(function(c) { return c.id === chatId; });
    if (found) {
      name = found.name;
      createTime = found.createTime;
    }
    var data = await kimiFetch('/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages', { chatId: chatId });
    var msgs = data.messages || [];
    return {
      ok: true,
      title: name,
      messageCount: msgs.length,
      date: createTime || (msgs.length ? msgs[msgs.length - 1].createTime : 'Unknown')
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleListChats() {
  try {
    var chats = await listAllChats();
    return {
      ok: true,
      chats: chats.map(function(c) {
        return { id: c.id, name: c.name, createTime: c.createTime, updateTime: c.updateTime };
      })
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleGetChatText(chatId, options) {
  try {
    var name = chatId;
    var chats = await listAllChats();
    var found = chats.find(function(c) { return c.id === chatId; });
    if (found) name = found.name;
    var data = await kimiFetch('/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages', { chatId: chatId });
    var msgs = data.messages || [];
    if (!msgs.length) return { ok: false, error: 'No messages' };
    var mergedOpts = { thinking: options.thinking || false, tools: options.tools || false, refs: true, format: 'both' };
    var md = buildMD(msgs, name, chatId, mergedOpts);
    return { ok: true, text: md };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- Markdown builder ---

function strip(s) {
  return (s || '').replace(PUA, '');
}

function safeFn(n) {
  return (n || 'untitled')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80) || 'untitled';
}

function walkMsgs(msgs) {
  var map = new Map();
  msgs.forEach(function(m) { map.set(m.id, m); });
  var root = msgs.find(function(m) {
    return m.parentId === '00000000-0000-0000-0000-000000000000' || m.role === 'system';
  });
  if (!root) return [].concat(msgs).reverse();
  var res = [];
  function walk(id) {
    var m = map.get(id);
    if (!m) return;
    if (m.role !== 'system') res.push(m);
    (m.childrenMessageIds || []).forEach(walk);
  }
  if (root.role === 'system') {
    (root.childrenMessageIds || []).forEach(walk);
  } else {
    res.push(root);
    (root.childrenMessageIds || []).forEach(walk);
  }
  return res;
}

function buildMD(msgs, title, chatId, options) {
  var ord = walkMsgs(msgs);
  var dt = msgs[msgs.length - 1] ? msgs[msgs.length - 1].createTime : 'Unknown';
  var md = '# Kimi: ' + strip(title) + '\n'
    + '**Date:** ' + dt + '\n'
    + '**Chat ID:** ' + chatId + '\n'
    + '**Messages:** ' + ord.length + '\n\n---\n\n';
  var refs = [];
  ord.forEach(function(m) {
    var role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Kimi' : 'System';
    var parts = [];
    (m.blocks || []).forEach(function(b) {
      if (b.text && b.text.content) parts.push(strip(b.text.content));
      else if (b.file && b.file.meta) parts.push('📎 **' + strip(b.file.meta.name) + '** (' + (b.file.meta.sizeBytes || '?') + ' bytes)');
      else if (b.think && b.think.content && options.thinking) parts.push('<details>\n<summary>💭 Thinking</summary>\n\n' + strip(b.think.content) + '\n</details>');
      else if (b.tool && b.tool.name && options.tools) parts.push('_🔧 ' + b.tool.name + '_');
    });
    if (!parts.length) return;
    md += '### ' + role + '\n' + parts.join('\n\n') + '\n\n';
    if (options.refs && m.references) {
      m.references.forEach(function(r) {
        (r.items || []).forEach(function(i) {
          if (i.search && i.search.base && i.search.base.url) {
            refs.push({ t: i.search.base.title || i.search.base.url, u: i.search.base.url });
          }
        });
      });
    }
  });
  if (options.refs && refs.length) {
    var seen = new Set();
    md += '## References\n\n';
    refs.forEach(function(r) {
      if (!seen.has(r.u)) {
        seen.add(r.u);
        md += '- [' + strip(r.t) + '](' + r.u + ')\n';
      }
    });
  }
  return md;
}

// --- ZIP writer ---

function createZip(files) {
  var encoder = new TextEncoder();
  var centralDir = [];
  var localHeaders = [];
  var offset = 0;
  files.forEach(function(f) {
    var data = typeof f.data === 'string' ? encoder.encode(f.data) : f.data;
    var nameBytes = encoder.encode(f.name);

    // Local file header (30-byte fixed part + name + data)
    var local = new Uint8Array(30 + nameBytes.length + data.length);
    var lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);   // no flags
    lv.setUint16(8, 0, true);   // method: stored
    lv.setUint16(10, 0, true);  // mod time
    lv.setUint16(12, 0, true);  // mod date
    lv.setUint32(14, crc32(data), true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);  // extra length
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    localHeaders.push(local);

    // Central directory entry (46-byte fixed part + name)
    var cd = new Uint8Array(46 + nameBytes.length);
    var cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc32(data), true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    centralDir.push(cd);
    offset += local.length;
  });

  var cdOffset = offset;
  var cdSize = 0;
  centralDir.forEach(function(c) { cdSize += c.length; });

  // End of central directory record
  var eocd = new Uint8Array(22);
  var ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);

  var result = new Uint8Array(offset + cdSize + 22);
  var pos = 0;
  localHeaders.forEach(function(l) { result.set(l, pos); pos += l.length; });
  centralDir.forEach(function(c) { result.set(c, pos); pos += c.length; });
  result.set(eocd, pos);
  return result;
}

function crc32(data) {
  var crc = 0xFFFFFFFF;
  var arr = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  for (var i = 0; i < arr.length; i++) {
    crc ^= arr[i];
    for (var j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// --- Filename helpers ---

// Build the "YYYY-MM-DD-<title>-Kimi" base name plus ZIP-name dedup suffix.
function buildFileBase(safeTitle, usedNames) {
  var now = new Date();
  var dateStamp = now.getFullYear() + '-'
    + String(now.getMonth() + 1).padStart(2, '0') + '-'
    + String(now.getDate()).padStart(2, '0');
  var fileBase = dateStamp + '-' + safeTitle + '-Kimi';
  if (usedNames[fileBase]) {
    usedNames[fileBase]++;
    fileBase = fileBase + '-' + usedNames[fileBase];
  } else {
    usedNames[fileBase] = 1;
  }
  return fileBase;
}

// --- Exports ---

async function exportChat(chatId, options) {
  var name = chatId;
  var chats = await listAllChats();
  var found = chats.find(function(c) { return c.id === chatId; });
  if (found) name = found.name;
  var data = await kimiFetch('/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages', { chatId: chatId });
  var msgs = data.messages || [];
  if (!msgs.length) throw new Error('No messages');
  var fmt = options.format || 'both';
  var md = buildMD(msgs, name, chatId, options);
  var json = JSON.stringify(data, null, 2);
  var fileBase = buildFileBase(safeFn(name), {});

  if (fmt === 'both') {
    var zipData = createZip([
      { name: fileBase + '.md', data: md },
      { name: fileBase + '.json', data: json }
    ]);
    var zipUrl = URL.createObjectURL(new Blob([zipData], { type: 'application/zip' }));
    await browser.downloads.download({ url: zipUrl, filename: fileBase + '.zip', saveAs: false });
    setTimeout(function() { URL.revokeObjectURL(zipUrl); }, 5000);
  } else if (fmt === 'md') {
    var mdUrl = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    await browser.downloads.download({ url: mdUrl, filename: fileBase + '.md', saveAs: false });
    setTimeout(function() { URL.revokeObjectURL(mdUrl); }, 5000);
  } else {
    var jsonUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    await browser.downloads.download({ url: jsonUrl, filename: fileBase + '.json', saveAs: false });
    setTimeout(function() { URL.revokeObjectURL(jsonUrl); }, 5000);
  }
}

async function exportAllWithProgress(chatIds, options) {
  var baseDelay = await getRequestDelay();
  var allChats = null;
  if (!chatIds || !chatIds.length) {
    allChats = await listAllChats();
    chatIds = allChats.map(function(c) { return c.id; });
  }
  var chats = chatIds;
  var total = chats.length;
  var files = [];
  var errs = [];
  var usedNames = {};
  var nameMap = {};
  (allChats || []).forEach(function(c) { nameMap[c.id] = c.name; });

  activeExport = { pct: 0, text: '0/' + total };
  broadcast('progress', { pct: 0, text: '0/' + total });

  for (var i = 0; i < chats.length; i++) {
    // Linear pacing: chat 1 fires immediately, chat 2 waits baseDelay, etc.
    var pause = Math.min(baseDelay * i, MAX_REQUEST_DELAY);
    if (pause > 0) await sleep(pause);
    var chatId = chats[i];
    var name = chatId;
    try {
      var data = await kimiFetch('/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages', { chatId: chatId });
      var msgs = data.messages || [];
      if (!msgs.length) {
        errs.push(chatId + '|' + name + '|No messages');
        continue;
      }
      if (nameMap[chatId]) name = nameMap[chatId];
      var fmt = options.format || 'both';
      var md = buildMD(msgs, name, chatId, options);
      var fileBase = buildFileBase(safeFn(name), usedNames);
      if (fmt === 'both' || fmt === 'md') files.push({ name: fileBase + '.md', data: md });
      if (fmt === 'both' || fmt === 'json') files.push({ name: fileBase + '.json', data: JSON.stringify(data, null, 2) });
    } catch (e) {
      errs.push(chatId + '|' + name + '|' + e.message);
    }
    var pct = Math.round((i + 1) / total * 100);
    var progressText = (i + 1) + '/' + total + ' (+' + (pause / 1000).toFixed(1) + 's pause)';
    activeExport = { pct: pct, text: progressText };
    broadcast('progress', { pct: pct, text: progressText });
  }

  if (errs.length) files.push({ name: '_export-errors.txt', data: errs.join('\n') });
  var zipData = createZip(files);
  var blobUrl = URL.createObjectURL(new Blob([zipData], { type: 'application/zip' }));
  await browser.downloads.download({
    url: blobUrl,
    filename: 'Kimi-export-' + new Date().toISOString().split('T')[0] + '.zip',
    saveAs: false
  });
  setTimeout(function() { URL.revokeObjectURL(blobUrl); }, 5000);
}

async function exportAll(options) {
  var baseDelay = await getRequestDelay();
  var chats = await listAllChats();
  var ids = chats.map(function(c) { return c.id; });
  var files = [];
  var errs = [];
  var usedNames = {};

  browser.action.setBadgeBackgroundColor({ color: '#4ade80' });

  for (var i = 0; i < ids.length; i++) {
    // Linear pacing: chat 1 fires immediately, chat 2 waits baseDelay, etc.
    var pause = Math.min(baseDelay * i, MAX_REQUEST_DELAY);
    if (pause > 0) await sleep(pause);
    var chatId = ids[i];
    var name = chatId;
    browser.action.setBadgeText({ text: (i + 1) + '/' + ids.length });
    try {
      var found = chats.find(function(c) { return c.id === chatId; });
      if (found) name = found.name;
      var data = await kimiFetch('/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages', { chatId: chatId });
      var msgs = data.messages || [];
      if (!msgs.length) {
        errs.push(chatId + '|' + name + '|No messages');
        continue;
      }
      var fmt = options.format || 'both';
      var md = buildMD(msgs, name, chatId, options);
      var fileBase = buildFileBase(safeFn(name), usedNames);
      if (fmt === 'both' || fmt === 'md') files.push({ name: fileBase + '.md', data: md });
      if (fmt === 'both' || fmt === 'json') files.push({ name: fileBase + '.json', data: JSON.stringify(data, null, 2) });
    } catch (e) {
      errs.push(chatId + '|' + name + '|' + e.message);
    }
  }

  browser.action.setBadgeText({ text: errs.length ? 'DONE' : 'OK' });
  setTimeout(function() { browser.action.setBadgeText({ text: '' }); }, 3000);

  if (errs.length) files.push({ name: '_export-errors.txt', data: errs.join('\n') });
  var zipData = createZip(files);
  var blobUrl = URL.createObjectURL(new Blob([zipData], { type: 'application/zip' }));
  await browser.downloads.download({
    url: blobUrl,
    filename: 'Kimi-export-' + new Date().toISOString().split('T')[0] + '.zip',
    saveAs: false
  });
  setTimeout(function() { URL.revokeObjectURL(blobUrl); }, 5000);
}

// --- Context menus ---

function createMenus() {
  browser.menus.removeAll(function() {
    browser.menus.create({
      id: 'export-chat',
      title: 'Export this conversation',
      contexts: ['page'],
      documentUrlPatterns: ['https://www.kimi.ai/chat/*']
    });
    browser.menus.create({
      id: 'export-all',
      title: 'Export all conversations',
      contexts: ['page'],
      documentUrlPatterns: ['https://www.kimi.ai/*']
    });
  });
}

browser.runtime.onInstalled.addListener(createMenus);

// Also register immediately (for first install before onInstalled fires)
createMenus();

browser.menus.onClicked.addListener(async function(info, tab) {
  if (!tab || !tab.url || !tab.url.includes('kimi.ai')) return;
  var s = await browser.storage.local.get(['thinking', 'tools', 'format']);
  var opt = { thinking: s.thinking || false, tools: s.tools || false, refs: true, format: s.format || 'both' };
  if (info.menuItemId === 'export-chat') {
    var m = tab.url.match(/\/chat\/([a-f0-9-]+)/);
    if (!m) return;
    try {
      activeExport = { pct: 0, text: '' };
      await exportChat(m[1], opt);
    } catch (e) {
      console.error(e);
    }
    activeExport = null;
    broadcast('done', { ok: true });
  } else if (info.menuItemId === 'export-all') {
    try {
      activeExport = { pct: 0, text: '0/0' };
      await exportAllWithProgress([], opt);
    } catch (e) {
      console.error(e);
    }
    activeExport = null;
    broadcast('done', { ok: true });
  }
});

// --- Startup ---

browser.storage.local.get(['thinking', 'tools', 'format', 'requestDelay']).then(function(s) {
  opts.thinking = s.thinking || false;
  opts.tools = s.tools || false;
  opts.format = s.format || 'both';
  opts.requestDelay = s.requestDelay || 250;
});

console.log('Kimi Export ready');
