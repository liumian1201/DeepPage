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

// ---- 网页截图（v1.1.5） ----

async function captureScreenshot(url) {
  // 后台开 popup 窗口（不聚焦，隐藏在后面）
  var win = await chrome.windows.create({
    url: url,
    type: 'popup',
    width: 1024,
    height: 768,
    focused: false
  });
  var tabId = win.tabs[0].id;

  await new Promise(function (resolve, reject) {
    var timeout = setTimeout(function () { reject(new Error('页面加载超时')); }, 30000);
    chrome.tabs.onUpdated.addListener(function onUpdated(tid, info) {
      if (tid === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    });
  });

  // 短暂聚焦窗口 → 截图 → 关闭
  await chrome.windows.update(win.id, { focused: true });
  await new Promise(function (r) { setTimeout(r, 500); });
  var dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: 'png' });
  chrome.windows.remove(win.id);

  return dataUrl;
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

// ---- 初始创建 ----
chrome.runtime.onInstalled.addListener(function () {
  rebuildContextMenus();
});

chrome.runtime.onStartup.addListener(function () {
  rebuildContextMenus();
});
