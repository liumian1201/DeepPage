/* ============================================================
   background.js — Service Worker
   代理天气 API + 图片下载，绕过 chrome://newtab 的 fetch/CORS 限制
   v1.0.5: 浏览器右键菜单「添加当前页面到指定分组」
   v1.0.7: 审计确认无 setInterval/全局持久变量，SW 可正常休眠
   ============================================================ */

// ---- 消息代理 ----

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.type === 'weather-fetch') {
    fetch(request.url)
      .then(function (res) { return res.text(); })
      .then(function (text) { sendResponse({ ok: true, data: text }); })
      .catch(function (err) { sendResponse({ ok: false, error: err.message }); });
    return true;
  }

  if (request.type === 'image-fetch') {
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
  if (request.type === 'webdav:get') { webdavProxy('GET').then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:propfind') { webdavProxy('PROPFIND').then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:test') { webdavProxy('OPTIONS').then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message }); }); return true; }
  if (request.type === 'webdav:silent-put') { webdavProxy('PUT', request.payload).catch(function (e) { console.warn('silent-put:', e.message); }); sendResponse({ ok: true }); return false; }

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
});

// ---- WebDAV 云备份代理（v1.2.0） ----

var WEBDAV_BACKUP_FILE = 'DeepPage_Backup.zip';

async function webdavProxy(method, payload) {
  payload = payload || {};
  // 支持直接传凭据（测试连接等场景），回退到 storage.local
  var url = payload._url, user = payload._user, pass = payload._pass;
  if (!url || !user || !pass) {
    var cfg = await new Promise(function (r) { chrome.storage.local.get(['webdav_url','webdav_user','webdav_pass'], r); });
    url = cfg.webdav_url; user = cfg.webdav_user; pass = cfg.webdav_pass;
  }
  if (!url || !user || !pass) {
    return { ok: false, error: 'WebDAV 未配置' };
  }
  var baseUrl = url.replace(/\/$/, '');
  var auth = 'Basic ' + btoa(user + ':' + atob(pass));
  var headers = { Authorization: auth };

  if (method === 'PROPFIND') {
    headers.Depth = '1';
    var res = await fetch(baseUrl, { method: 'PROPFIND', headers: headers });
    if (!res.ok) return { ok: false, error: 'PROPFIND ' + res.status };
    var text = await res.text();
    // SW 无 DOMParser，正则提取 getlastmodified
    var m = text.match(/<[^>]*getlastmodified[^>]*>([^<]+)<\/[^>]*getlastmodified[^>]*>/i);
    return { ok: true, data: m ? m[1] : null };
  }

  if (method === 'GET') {
    var url = baseUrl + '/' + WEBDAV_BACKUP_FILE;
    var res = await fetch(url, { method: 'GET', headers: headers });
    if (!res.ok) return { ok: false, error: 'GET ' + res.status };
    var ab = await res.arrayBuffer();
    return { ok: true, data: Array.from(new Uint8Array(ab)) };
  }

  if (method === 'PUT') {
    try { await fetch(baseUrl, { method: 'MKCOL', headers: headers }); } catch (e) {}
    var url = baseUrl + '/' + WEBDAV_BACKUP_FILE;
    var body = payload.body;
    if (Array.isArray(body)) body = new Uint8Array(body);
    if (!body || !body.byteLength) return { ok: false, error: 'empty body' };
    var putHeaders = Object.assign({}, headers, { 'Content-Type': 'application/zip' });
    var res = await fetch(url, { method: 'PUT', headers: putHeaders, body: body });
    if (!res.ok) {
      var errText = '';
      try { errText = ' ' + (await res.text()).slice(0, 200); } catch (e) {}
      return { ok: false, error: 'PUT ' + res.status + ' ' + res.statusText + errText };
    }
    return { ok: true, data: new Date().toISOString() };
  }

  if (method === 'OPTIONS') {
    var res = await fetch(baseUrl, { method: 'OPTIONS', headers: headers });
    if (!res.ok) return { ok: false, error: '连接失败 ' + res.status };
    return { ok: true, data: 'connected' };
  }

  return { ok: false, error: 'unknown method' };
}

// ---- 网页截图（v1.1.5） ----

async function captureScreenshot(url) {
  var win = await chrome.windows.create({
    url: url,
    type: 'popup',
    width: 1400,
    height: 900,
    focused: true
  });
  var tabId = win.tabs[0].id;
  var closed = false;

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
    }).catch(function () {});
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

// ---- 浏览器右键菜单（v1.0.5） ----

var _rebuildingMenus = false;

/** 根据当前分组数据重建右键菜单 */
async function rebuildContextMenus() {
  if (_rebuildingMenus) return;
  _rebuildingMenus = true;
  try {
    // 清除所有菜单项
    await new Promise(function (r) { chrome.contextMenus.removeAll(r); });

    // 读取分组
    var result = await chrome.storage.sync.get(['groups']);
    var groups = result.groups;
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

/** 监听 storage 变更：分组数据变化时自动刷新右键菜单 */
chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName === 'sync' && changes.groups) {
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

  // 读取当前分组数据
  var result = await chrome.storage.sync.get(['groups']);
  var groups = result.groups;
  if (!groups || !groups[groupIndex]) return;

  // v1.0.8: 检查重复 → 当前页面弹确认框
  var hostname = '';
  try { hostname = new URL(pageUrl).hostname.replace('www.', ''); } catch (e) {}
  var dupGroup = null, dupCardName = '';
  if (hostname) {
    for (var gi = 0; gi < groups.length; gi++) {
      var cards = groups[gi].cards || [];
      for (var ci = 0; ci < cards.length; ci++) {
        try {
          if (new URL(cards[ci].url).hostname.replace('www.', '') === hostname) {
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

  await chrome.storage.sync.set({ groups: groups });

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
