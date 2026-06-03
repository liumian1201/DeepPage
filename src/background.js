/* ============================================================
   background.js — Service Worker
   代理天气 API + 图片下载，绕过 chrome://newtab 的 fetch/CORS 限制
   v1.0.5: 新增浏览器右键菜单「添加当前页面到指定分组」
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
});

// ---- 浏览器右键菜单（v1.0.5） ----

/** 根据当前分组数据重建右键菜单 */
async function rebuildContextMenus() {
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

  var card = {
    id: Date.now().toString(),
    name: pageTitle || pageUrl,
    url: pageUrl,
    color: stringToColor(pageUrl)
  };

  if (!groups[groupIndex].cards) groups[groupIndex].cards = [];
  groups[groupIndex].cards.push(card);

  await chrome.storage.sync.set({ groups: groups });

  // v1.0.5: 不在此处重建菜单（onChanged 会自动触发）
});

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

// ---- 初始创建 ----
chrome.runtime.onInstalled.addListener(function () {
  rebuildContextMenus();
});

chrome.runtime.onStartup.addListener(function () {
  rebuildContextMenus();
});
