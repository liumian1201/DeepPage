/* ============================================================
   background.js — Service Worker
   代理天气 API + 图片下载，绕过 chrome://newtab 的 fetch/CORS 限制
   v1.0.5: 浏览器右键菜单「添加当前页面到指定分组」
   v1.0.7: 审计确认无 setInterval/全局持久变量，SW 可正常休眠
   ============================================================ */

// ---- 消息代理 ----

/**
 * v1.3.1 (BUG-018 安全侧修复): SW 代理协议白名单
 * 只允许 http:/https:，阻断 file: / chrome: / chrome-extension: / data: / javascript: 等
 * 说明：host_permissions 仍为 <all_urls> —— 截图(scripting)、图片代理、WebDAV(含本地 http NAS)
 *       都依赖 CORS 绕过能力，权限收窄需配合 optional_host_permissions + 运行时授权，另行处理。
 */
function isProxyUrlAllowed(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    var u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.type === 'weather-fetch') {
    if (!isProxyUrlAllowed(request.url)) {
      sendResponse({ ok: false, error: 'unsupported protocol' });
      return false;
    }
    fetch(request.url)
      .then(function (res) { return res.text(); })
      .then(function (text) { sendResponse({ ok: true, data: text }); })
      .catch(function (err) { sendResponse({ ok: false, error: err.message }); });
    return true;
  }

  if (request.type === 'image-fetch') {
    if (!isProxyUrlAllowed(request.url)) {
      sendResponse({ ok: false, error: 'unsupported protocol' });
      return false;
    }
    fetch(request.url)
      .then(function (res) { return res.blob(); })
      .then(function (blob) {
        var reader = new FileReader();
        reader.onloadend = function () {
          sendResponse({ ok: true, data: reader.result, type: blob.type });
        };
        reader.onerror = function () { sendResponse({ ok: false, error: 'read failed' }); };
        reader.readAsDataURL(blob);
      })
      .catch(function (err) { sendResponse({ ok: false, error: err.message }); });
    return true;
  }

  // v1.0.5: 扩展页面通知刷新右键菜单
  if (request.type === 'refresh-context-menus') {
    rebuildContextMenus().then(function () {
      sendResponse({ ok: true });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  // v1.2.0: WebDAV 代理 — 所有云请求走 SW 绕过 CORS
  if (request.type === 'webdav:put') { webdavProxy('PUT', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:get') { webdavProxy('GET', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:propfind') { webdavProxy('PROPFIND', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:test') { webdavProxy('OPTIONS', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  // v1.2.6: 版本化备份
  if (request.type === 'webdav:list') { webdavProxy('PROPFIND_LIST', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:delete') { webdavProxy('DELETE', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }

  // v1.2.8: 增量备份 — manifest / config / img 子路径操作
  if (request.type === 'webdav:manifest-get') { webdavProxy('MANIFEST_GET', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:manifest-put') { webdavProxy('MANIFEST_PUT', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:config-put') { webdavProxy('CONFIG_PUT', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:config-get') { webdavProxy('CONFIG_GET', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:config-list') { webdavProxy('CONFIG_LIST', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:config-delete') { webdavProxy('CONFIG_DELETE', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:img-put') { webdavProxy('IMG_PUT', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:img-get') { webdavProxy('IMG_GET', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:img-delete') { webdavProxy('IMG_DELETE', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:img-list') { webdavProxy('IMG_LIST', request.payload).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }

  // v1.1.5: 网页截图 — 后台弹出窗口截图后关闭
  if (request.type === 'capture-screenshot') {
    var url = request.url;
    if (!url || !/^https?:\/\//i.test(url)) {
      sendResponse({ ok: false, error: 'invalid url' });
      return;
    }
    captureScreenshot(url).then(function (dataUrl) {
      sendResponse({ ok: true, dataUrl: dataUrl });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  // v1.2.9: 批量自动截图
  if (request.type === 'batch-capture-one') {
    var url = request.url;
    if (!url || !/^https?:\/\//i.test(url)) {
      sendResponse({ ok: false, error: 'invalid url' });
      return;
    }
    batchCaptureOne(url).then(function (dataUrl) {
      sendResponse({ ok: true, dataUrl: dataUrl });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }
});

// ---- WebDAV 云备份代理（v1.2.0 / v1.2.6 版本化） ----

var WEBDAV_BACKUP_FILE = 'DeepPage_Backup.zip';

/** BUG-054 纵深防御：UTF-8 安全的 base64 编解码
 *  btoa/atob 只接受码点 ≤ 0xFF 的字符串，含中文/emoji 的密码会抛 InvalidCharacterError。
 *  ⚠️ SW 与页面是两个独立上下文，页面侧（webdav.js）有同名的一份实现，改动请同步。 */
function b64EncodeUtf8(str) {
  var bytes = new TextEncoder().encode(String(str == null ? '' : str));
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64DecodeUtf8(b64) {
  var bin = atob(String(b64 == null ? '' : b64));
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** BUG-042 / AUD-003：远端可控文件名净化（CWE-22 目录穿越）
 *
 *  config/ 与 img/ 子路径的文件名有两个来源是**服务端可控**的：
 *    · manifest.json 的 configs[].name（GET/DELETE 配置快照）
 *    · PROPFIND 列表项 name（GC 删除图片、删除旧配置）
 *  原先直接拼进 URL：baseUrl + '/config/' + '../../Documents/tax.pdf'，经 WHATWG URL 归一化后
 *  会越出备份目录，对同源**任意路径**发 GET/DELETE（用用户自己的 WebDAV 凭据）。
 *  这里集中收口，只放行「单层普通文件名」：
 *    · 仅 [A-Za-z0-9._-]，长度 1~128
 *    · 不得以 '.' 开头（一并挡住 '.'、'..'、'.hidden'）
 *    · 因此 '/'、'\'、'?'、'#'、'%'、控制字符与任何多段路径全部被拒
 *  合法名全部通过：_genConfigName() 的 20261003_120000.json（20 字符）、图片 md5（64 字符）、
 *  **旧格式的 <md5>.bin（68 字符 —— 上限必须容得下它，否则 GC 会静默删不掉历史图片文件）**、manifest.json。
 *  zip 分支（GET/PUT/DELETE）本就用 encodeURIComponent，不受影响。 */
function sanitizeRemoteName(name) {
  var n = String(name == null ? '' : name);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(n)) return null;
  if (n.charAt(0) === '.') return null;
  return n;
}

/** BUG-042 纵深防御：断言最终 URL 归一化后仍落在 baseUrl 目录之内（净化之外的第二道闸） */
function isWithinBase(baseUrl, subUrl) {
  try {
    var b = new URL(baseUrl), s = new URL(subUrl);
    if (b.origin !== s.origin) return false;
    var bp = b.pathname.replace(/\/+$/, '');
    return s.pathname === bp || s.pathname.indexOf(bp + '/') === 0;
  } catch (e) { return false; }
}

async function webdavProxy(method, payload) {
  payload = payload || {};
  // BUG-064：区分「未提供凭据」与「显式空值」——
  //   · payload 上完全没有 _url/_user/_pass（也没有 _hasCreds 标记）→ 回退 storage.local
  //   · 任一字段显式提供（哪怕是空串）→ 按提供值使用，允许空密码（NAS 匿名/访客共享）
  // 原先的 `!url || !user || !pass` 把「空密码」当成「没传凭据」，于是：空密码服务器恒报
  // 「WebDAV 未配置」（假阴性）；只传部分字段时会静默回退到 storage 里的旧服务器（假阳性）。
  var provided = payload._hasCreds === true ||
    payload._url !== undefined || payload._user !== undefined || payload._pass !== undefined;
  var url = payload._url, user = payload._user, pass = payload._pass;
  if (!provided) {
    var cfg = await new Promise(function (r) { chrome.storage.local.get(['webdav_url','webdav_user','webdav_pass'], r); });
    url = cfg.webdav_url; user = cfg.webdav_user; pass = cfg.webdav_pass;
  }
  if (!url || !user) {
    return { ok: false, error: !url ? 'WebDAV 未配置：缺少服务器地址' : 'WebDAV 未配置：缺少用户名' };
  }
  // v1.3.1: 协议白名单（允许本地 http WebDAV，阻断其它协议）
  if (!isProxyUrlAllowed(url)) {
    return { ok: false, error: 'WebDAV 地址必须是 http/https' };
  }
  var baseUrl = url.replace(/\/$/, '');
  // BUG-054：凭据按 UTF-8 解码后再 base64（原先 atob(pass) 只支持 Latin-1，中文密码变乱码）
  var auth;
  try {
    auth = 'Basic ' + b64EncodeUtf8(user + ':' + b64DecodeUtf8(pass));
  } catch (e) {
    return { ok: false, error: 'WebDAV 凭据解码失败，请在设置中重新保存密码' };
  }
  var headers = { Authorization: auth };

  // v1.2.6: PROPFIND 列表（列出所有 .zip 备份文件）
  if (method === 'PROPFIND_LIST') {
    headers.Depth = '1';
    var res = await fetch(baseUrl, { method: 'PROPFIND', headers: headers });
    if (!res.ok) return { ok: false, error: 'PROPFIND ' + res.status };
    var text = await res.text();
    // SW 无 DOMParser，正则提取所有 .zip 文件信息
    var files = [];
    var hrefRe = /<[^:>]*:href>([^<]+)<\/[^:>]*:href>/gi;
    var lmRe = /<[^>]*getlastmodified[^>]*>([^<]+)<\/[^>]*getlastmodified[^>]*>/i;
    var responses = text.split(/<D:response>/i);
    for (var i = 0; i < responses.length; i++) {
      var segment = responses[i];
      hrefRe.lastIndex = 0;
      var hm = hrefRe.exec(segment);
      if (!hm) continue;
      var h = hm[1].replace(/^\/+/, '').replace(/\/+$/, '');
      if (!/\.zip$/i.test(h)) continue;
      // v1.2.6 fix: 从完整路径提取纯文件名，避免 GET URL 双重路径 404
      var parts = h.split('/');
      h = parts[parts.length - 1];
      var lm = (segment.match(lmRe) || [])[1] || '';
      files.push({ name: h, lastModified: lm });
    }
    files.sort(function (a, b) { return b.lastModified.localeCompare(a.lastModified); });
    return { ok: true, data: files };
  }

  if (method === 'PROPFIND') {
    headers.Depth = '1';
    var res = await fetch(baseUrl, { method: 'PROPFIND', headers: headers });
    if (!res.ok) return { ok: false, error: 'PROPFIND ' + res.status };
    var text = await res.text();
    var m = text.match(/<[^>]*getlastmodified[^>]*>([^<]+)<\/[^>]*getlastmodified[^>]*>/i);
    return { ok: true, data: m ? m[1] : null };
  }

  if (method === 'GET') {
    // v1.2.6: 支持指定文件名下载
    var fname = payload._filename || WEBDAV_BACKUP_FILE;
    var dlUrl = baseUrl + '/' + encodeURIComponent(fname);
    var res = await fetch(dlUrl, { method: 'GET', headers: headers });
    if (!res.ok) return { ok: false, error: 'GET ' + res.status };
    var ab = await res.arrayBuffer();
    return { ok: true, data: Array.from(new Uint8Array(ab)) };
  }

  if (method === 'PUT') {
    try { await fetch(baseUrl, { method: 'MKCOL', headers: headers }); } catch (e) {}
    // v1.2.6: 支持版本化文件名
    var fname = payload._filename || WEBDAV_BACKUP_FILE;
    var putUrl = baseUrl + '/' + encodeURIComponent(fname);
    var body = payload.body;
    if (Array.isArray(body)) body = new Uint8Array(body);
    if (!body || !body.byteLength) return { ok: false, error: 'empty body' };
    var putHeaders = Object.assign({}, headers, { 'Content-Type': 'application/zip' });
    var res = await fetch(putUrl, { method: 'PUT', headers: putHeaders, body: body });
    if (!res.ok) {
      var errText = '';
      try { errText = ' ' + (await res.text()).slice(0, 200); } catch (e) {}
      return { ok: false, error: 'PUT ' + res.status + ' ' + res.statusText + errText };
    }
    return { ok: true, data: new Date().toISOString() };
  }

  // v1.2.6: DELETE 删除指定备份文件
  if (method === 'DELETE') {
    var fname = payload._filename || WEBDAV_BACKUP_FILE;
    var delUrl = baseUrl + '/' + encodeURIComponent(fname);
    var res = await fetch(delUrl, { method: 'DELETE', headers: headers });
    if (!res.ok) return { ok: false, error: 'DELETE ' + res.status };
    return { ok: true, data: 'deleted' };
  }

  if (method === 'OPTIONS') {
    var res = await fetch(baseUrl, { method: 'OPTIONS', headers: headers });
    if (!res.ok) return { ok: false, error: '连接失败 ' + res.status };
    return { ok: true, data: 'connected' };
  }

  // v1.2.8: 增量备份子路径操作
  // BUG-042：文件名先净化再拼路径（子路径名可能来自远端 manifest / PROPFIND 列表）
  var subPath = '';
  if (method === 'MANIFEST_GET' || method === 'MANIFEST_PUT') subPath = 'manifest.json';
  else if (method === 'CONFIG_LIST') subPath = 'config/';
  else if (method === 'IMG_LIST') subPath = 'img/';
  else if (method.startsWith('CONFIG_')) {
    var rawCfg = payload._filename;
    var cfgName = (rawCfg === undefined || rawCfg === null || rawCfg === '')
      ? 'latest.json' : sanitizeRemoteName(rawCfg);
    if (!cfgName) return { ok: false, error: '非法文件名（仅允许字母数字._-，且不得以点开头）' };
    subPath = 'config/' + cfgName;
  } else if (method.startsWith('IMG_') && method !== 'IMG_LIST') {
    var rawImg = payload._filename;
    var imgName = (rawImg === undefined || rawImg === null || rawImg === '')
      ? 'unknown.bin' : sanitizeRemoteName(rawImg);
    if (!imgName) return { ok: false, error: '非法文件名（仅允许字母数字._-，且不得以点开头）' };
    subPath = 'img/' + imgName;
  }

  if (subPath) {
    var subUrl = baseUrl + '/' + subPath;
    // 纵深防御：净化之后仍断言最终路径没越出备份目录
    if (!isWithinBase(baseUrl, subUrl)) {
      return { ok: false, error: '非法路径（越出备份目录）' };
    }
    if (method === 'MANIFEST_GET' || method === 'CONFIG_GET' || method === 'IMG_GET') {
      var res = await fetch(subUrl, { method: 'GET', headers: headers });
      if (res.status === 404) return { ok: true, data: null };
      if (!res.ok) return { ok: false, error: 'GET ' + res.status };
      if (method === 'IMG_GET') {
        var ab = await res.arrayBuffer();
        var ct = res.headers.get('Content-Type') || 'image/png';
        return { ok: true, data: Array.from(new Uint8Array(ab)), _mime: ct };
      }
      var text = await res.text();
      try { return { ok: true, data: JSON.parse(text) }; } catch (e) { return { ok: true, data: text }; }
    }
    if (method === 'MANIFEST_PUT' || method === 'CONFIG_PUT' || method === 'IMG_PUT') {
      // 确保父目录存在
      if (subPath.indexOf('/') !== -1) {
        var dirPath = subPath.substring(0, subPath.lastIndexOf('/'));
        try { await fetch(baseUrl + '/' + dirPath, { method: 'MKCOL', headers: headers }); } catch (e) {}
      }
      var body = payload.body;
      if (typeof body === 'string') body = new TextEncoder().encode(body);
      if (Array.isArray(body)) body = new Uint8Array(body);
      if (!body || !body.byteLength) return { ok: false, error: 'empty body' };
      var ct = payload._mime || (method === 'IMG_PUT' ? 'application/octet-stream' : 'application/json');
      var putHeaders = Object.assign({}, headers, { 'Content-Type': ct });
      var res = await fetch(subUrl, { method: 'PUT', headers: putHeaders, body: body });
      if (!res.ok) return { ok: false, error: 'PUT ' + res.status };
      return { ok: true, data: new Date().toISOString() };
    }
    if (method === 'CONFIG_LIST' || method === 'IMG_LIST') {
      var listDir = method === 'CONFIG_LIST' ? 'config/' : 'img/';
      var listUrl = baseUrl + '/' + listDir;
      // PROPFIND on subdirectory
      var subHeaders = Object.assign({}, headers, { Depth: '1' });
      var res = await fetch(listUrl, { method: 'PROPFIND', headers: subHeaders });
      if (res.status === 404) return { ok: true, data: [] };
      if (!res.ok) return { ok: false, error: 'PROPFIND ' + res.status };
      var text = await res.text();
      var files = [];
      var hrefRe = /<[^:>]*:href>([^<]+)<\/[^:>]*:href>/gi;
      var lmRe = /<[^>]*getlastmodified[^>]*>([^<]+)<\/[^>]*getlastmodified[^>]*>/i;
      var responses = text.split(/<D:response>/i);
      for (var j = 0; j < responses.length; j++) {
        var segment = responses[j];
        hrefRe.lastIndex = 0;
        var hm = hrefRe.exec(segment);
        if (!hm) continue;
        var h = hm[1];
        // 跳过目录本身
        if (h === '/' + listDir || h === listDir || h.endsWith('/' + listDir)) continue;
        var parts = h.split('/');
        var fn = parts[parts.length - 1];
        if (!fn || fn === listDir.replace(/\/$/, '')) continue;
        var lm = (segment.match(lmRe) || [])[1] || '';
        files.push({ name: fn, lastModified: lm });
      }
      files.sort(function (a, b) { return b.lastModified.localeCompare(a.lastModified); });
      return { ok: true, data: files };
    }
    if (method === 'CONFIG_DELETE' || method === 'IMG_DELETE') {
      var res = await fetch(subUrl, { method: 'DELETE', headers: headers });
      if (!res.ok && res.status !== 404) return { ok: false, error: 'DELETE ' + res.status };
      return { ok: true, data: 'deleted' };
    }
  }

  return { ok: false, error: 'unknown method' };
}

// ---- 网页截图（v1.1.5） ----

/** BUG-046：http 页面需要可选的 host 权限（manifest 的 optional_host_permissions）
 *  未授权时 chrome.scripting.executeScript 必被拒，页面里永远不会出现截图按钮。 */
async function swHasHttpHostPermission() {
  try {
    return await new Promise(function (resolve) {
      chrome.permissions.contains({ origins: ['http://*/*'] }, function (has) { resolve(!!has); });
    });
  } catch (e) { return false; }
}

async function captureScreenshot(url) {
  // v1.3.1: 只对 http/https 页面开截图窗口（chrome:// / file:// 无法注入脚本）
  if (!isProxyUrlAllowed(url)) {
    throw new Error('unsupported protocol');
  }
  // BUG-046：http 未授权时**不要开窗**（原先会开一个 1280×720 窗口，注入静默失败，
  // 用户干等 120 秒才收到与真实原因无关的「用户超时未截图」）
  if (/^http:\/\//i.test(url) && !(await swHasHttpHostPermission())) {
    throw new Error('需要「访问 http 网站」权限才能截取 http 页面，请先在设置中授权');
  }
  var win = await chrome.windows.create({
    url: url,
    type: 'normal',
    width: 1280,
    height: 720,
    state: 'normal',
    focused: true
  });
  var tabId = win.tabs[0].id;
  var closed = false;
  // BUG-046：注入失败要立刻结束等待（下面 Promise 里的 doReject 挂到这里），
  // 原先 injectButton 的 catch 是空的 → Promise 只能等 120s 超时。
  var rejectCapture = null;

  function injectButton() {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function () {
        if (document.getElementById('dp-capture-btn')) return;
        var btn = document.createElement('div');
        btn.id = 'dp-capture-btn';
        btn.textContent = '📸 截图';
        btn.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:999999;padding:10px 20px;background:#2563eb;color:#fff;border-radius:8px;font-size:15px;font-family:system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3);user-select:none;';
        btn.onclick = function () {
          btn.textContent = '⏳ 截图中...';
          btn.style.background = '#666';
          btn.onclick = null;
          document.body.style.overflow = 'hidden';
          setTimeout(function () { btn.style.display = 'none'; }, 50);
          setTimeout(function () { chrome.runtime.sendMessage({ type: 'capture-done' }); }, 100);
        };
        document.body.appendChild(btn);
      }
    }).catch(function (err) {
      // BUG-046：注入失败（权限不足 / 页面限制）必须回传真实原因，不能静默等 120s 超时
      if (rejectCapture) rejectCapture('无法注入截图按钮：' + ((err && err.message) || '未知原因'));
    });
  }

  // 页面每次导航完成后重新注入按钮
  var onNav = function (tid, info) {
    if (closed) { chrome.tabs.onUpdated.removeListener(onNav); return; }
    if (tid === tabId && info.status === 'complete') {
      injectButton();
    }
  };
  chrome.tabs.onUpdated.addListener(onNav);

  // 等待用户点击截图按钮
  return new Promise(function (resolve, reject) {
    var done = false;
    var timeout;

    function cleanup() {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(onCaptureDone);
      chrome.windows.onRemoved.removeListener(onWinRemoved);
      chrome.tabs.onUpdated.removeListener(onNav);
    }

    function doReject(msg, skipWinRemove) {
      cleanup();
      if (!skipWinRemove) { try { chrome.windows.remove(win.id); } catch (e) {} }
      reject(new Error(msg));
    }
    // BUG-046：把提前失败的出口交给 injectButton（同一时刻只有一个有效）
    rejectCapture = doReject;

    timeout = setTimeout(function () { doReject('用户超时未截图'); }, 120000);

    // 用户手动关闭截图窗口 → 立即清理（窗口已关，不重复 remove）
    function onWinRemoved(removedId) {
      if (removedId === win.id) doReject('截图窗口已关闭', true);
    }
    chrome.windows.onRemoved.addListener(onWinRemoved);

    function onCaptureDone(request) {
      if (request.type === 'capture-done') {
        cleanup();
        chrome.tabs.captureVisibleTab(win.id, { format: 'png' }).then(function (dataUrl) {
          chrome.windows.remove(win.id);
          resolve(dataUrl);
        }).catch(function (err) {
          chrome.windows.remove(win.id);
          reject(err);
        });
      }
    }
    chrome.runtime.onMessage.addListener(onCaptureDone);
  });
}

// ---- v1.2.9: 批量自动截图（无需人工点击） ----

/** 自动截取单个页面：打开窗口 → 等加载 → 截图 → 关闭 */
async function batchCaptureOne(url) {
  // v1.3.1: 同 captureScreenshot，仅允许 http/https
  if (!isProxyUrlAllowed(url)) {
    throw new Error('unsupported protocol');
  }
  var win = await chrome.windows.create({
    url: url,
    type: 'normal',
    width: 1280,
    height: 720,
    state: 'normal',
    focused: true
  });
  var tabId = win.tabs[0].id;

  return new Promise(function (resolve, reject) {
    var done = false;
    var timeout;

    function cleanup() {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onLoad);
      chrome.windows.onRemoved.removeListener(onRemoved);
    }

    function finish(err, dataUrl) {
      cleanup();
      try { chrome.windows.remove(win.id); } catch (e) {}
      if (err) reject(new Error(err));
      else resolve(dataUrl);
    }

    timeout = setTimeout(function () { finish('截图超时'); }, 30000);

    function onRemoved(removedId) {
      if (removedId === win.id) finish('窗口已关闭');
    }
    chrome.windows.onRemoved.addListener(onRemoved);

    function onLoad(tid, info) {
      if (tid !== tabId || info.status !== 'complete') return;
      // 页面加载完成后等 3 秒让懒加载内容渲染
      setTimeout(function () {
        if (done) return;
        chrome.tabs.captureVisibleTab(win.id, { format: 'png' })
          .then(function (dataUrl) { finish(null, dataUrl); })
          .catch(function (err) { finish(err.message); });
      }, 3000);
    }
    chrome.tabs.onUpdated.addListener(onLoad);
  });
}

// ---- 浏览器右键菜单（v1.0.5） ----

var _rebuildingMenus = false;

/** 根据当前分组数据重建右键菜单 */
async function rebuildContextMenus() {
  if (_rebuildingMenus) return;
  _rebuildingMenus = true;
  try {
    // 清除所有菜单项
    await new Promise(function (r) { chrome.contextMenus.removeAll(r); });

    // 读取分组（大容量用户数据在 local，需回退）
    var result = await chrome.storage.sync.get(['groups']);
    var groups = result.groups;
    if (!groups || !Array.isArray(groups) || groups.length === 0) {
      var localResult = await chrome.storage.local.get(['groups']);
      groups = localResult.groups;
    }
    if (!groups || !Array.isArray(groups) || groups.length === 0) return;

    // 创建父菜单
    chrome.contextMenus.create({
      id: 'deeppage-add-to-group',
      title: '➕ 添加到 DeepPage',
      contexts: ['page']
    });

    // 为每个分组创建子菜单
    groups.forEach(function (g, i) {
      chrome.contextMenus.create({
        id: 'deeppage-group-' + i,
        parentId: 'deeppage-add-to-group',
        title: '📂 ' + (g.name || '未命名') + ' (' + ((g.cards && g.cards.length) || 0) + ')',
        contexts: ['page']
      });
    });
  } finally {
    _rebuildingMenus = false;
  }
}

/** 监听 storage 变更：分组数据变化时自动刷新右键菜单（sync + local 双通道） */
chrome.storage.onChanged.addListener(function (changes, areaName) {
  if ((areaName === 'sync' || areaName === 'local') && changes.groups) {
    rebuildContextMenus();
  }
});

/** 处理右键菜单点击 */
chrome.contextMenus.onClicked.addListener(async function (info, tab) {
  var menuId = info.menuItemId;
  if (typeof menuId !== 'string' || !menuId.startsWith('deeppage-group-')) return;

  var groupIndex = parseInt(menuId.replace('deeppage-group-', ''), 10);
  var pageUrl = info.pageUrl;
  var pageTitle = tab.title || pageUrl;

  if (!pageUrl || pageUrl.startsWith('chrome://') || pageUrl.startsWith('chrome-extension://')) {
    // 无法添加浏览器内部页面
    return;
  }

  // 读取当前分组数据（大容量用户数据在 local，需回退）
  var result = await chrome.storage.sync.get(['groups']);
  var groups = result.groups;
  if (!groups || !Array.isArray(groups) || groups.length === 0) {
    var localResult = await chrome.storage.local.get(['groups']);
    groups = localResult.groups;
  }
  if (!groups || !groups[groupIndex]) return;

  // v1.2.8: 检查重复（完整 URL 匹配，非仅域名）→ 当前页面弹确认框
  var normalizedUrl = '';
  try { var u = new URL(pageUrl); normalizedUrl = u.hostname.replace('www.', '') + u.pathname + u.search; } catch (e) {}
  var dupGroup = null, dupCardName = '';
  if (normalizedUrl) {
    for (var gi = 0; gi < groups.length; gi++) {
      var cards = groups[gi].cards || [];
      for (var ci = 0; ci < cards.length; ci++) {
        try {
          var cu = new URL(cards[ci].url);
          if (cu.hostname.replace('www.', '') + cu.pathname + cu.search === normalizedUrl) {
            dupGroup = groups[gi].name;
            dupCardName = cards[ci].name;
            break;
          }
        } catch (e) {}
      }
      if (dupGroup) break;
    }
  }

  if (dupGroup) {
    // 在当前网页弹出确认框
    try {
      var result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function (name, groupName, cardName) {
          return confirm('「' + name + '」已在「' + groupName + '」分组中存在（' + cardName + '），是否继续添加？');
        },
        args: [pageTitle || pageUrl, dupGroup, dupCardName]
      });
      if (!result || !result[0] || !result[0].result) return; // 用户取消
    } catch (e) {
      // executeScript 失败（如 chrome:// 页面），静默添加
    }
  }

  // BUG-010: 补全 visitCount/createdAt；统一 ID 生成策略
  var card = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: pageTitle || pageUrl,
    url: pageUrl,
    color: stringToColor(pageUrl),
    visitCount: 0,
    createdAt: Date.now()
  };

  if (!groups[groupIndex].cards) groups[groupIndex].cards = [];
  groups[groupIndex].cards.push(card);

  // v1.2.8: 写入 sync，超限则回退 local（try-catch 防 reject 跳过回退）
  // BUG-036: 必须按「这次写入是否成功」决定回退 —— 原先只看 sync 里有没有值，
  // 配额拒绝时旧值原样留着（非空），新卡片只留在内存里，刷新即丢失
  var groupsSyncOk = true;
  try {
    await chrome.storage.sync.set({ groups: groups, groups_rev: Date.now() });
  } catch (e) { groupsSyncOk = false; }
  if (!groupsSyncOk) {
    chrome.storage.local.set({ groups: groups, groups_rev: Date.now() }).catch(function (e) {
      console.warn('[bg] groups 本地兜底写入失败:', e && e.message);
    });
  }
  chrome.storage.sync.get(['groups'], function (check) {
    if (!check.groups || !Array.isArray(check.groups) || check.groups.length === 0) {
      chrome.storage.local.set({ groups: groups, groups_rev: Date.now() }).catch(function (e) {
        console.warn('[bg] groups 本地兜底写入失败:', e && e.message);
      });
    }
  });

  // v1.0.5: 不在此处重建菜单（onChanged 会自动触发）
});

// ⚠️ BUG-013: stringToColor 两处定义（background.js + main.js），修改时需保持同步
/** 从 URL 生成稳定的 HSL 颜色（与 main.js 逻辑一致） */
function stringToColor(str) {
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  var h = Math.abs(hash) % 360;
  var s = 55 + (Math.abs(hash) % 25);
  var l = 35 + (Math.abs(hash >> 8) % 20);
  return 'hsl(' + h + ', ' + s + '%, ' + l + '%)';
}

// ---- 初始创建 & SW 唤醒恢复 ----
chrome.runtime.onInstalled.addListener(function () {
  rebuildContextMenus();
});

chrome.runtime.onStartup.addListener(function () {
  rebuildContextMenus();
});

// Manifest V3 SW 每次唤醒都需重建 ephemeral contextMenus
rebuildContextMenus();
