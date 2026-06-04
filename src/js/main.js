/* ============================================================
   main.js — 主程序入口
   负责：初始化、事件绑定、键盘快捷键、锁定/解锁、Toast 通知
   卡片/分组/拖拽/搜索/右键菜单已拆分至独立模块
   ============================================================ */

/* ==================== 全局状态 ==================== */
let speeddials = [];
let groups = [];
let activeGroupIndex = 0;
let isLocked = false;
let confirmDeleteId = null;

/* ==================== DOM 引用 ==================== */
const domMain = {
  grid:          document.getElementById('speeddial-grid'),
  searchInput:   document.getElementById('search-input'),
  searchIcon:    document.getElementById('search-engine-icon'),
  contextMenu:   document.getElementById('context-menu'),

  dialog:        document.getElementById('dialog-card'),
  dialogTitle:   document.getElementById('dialog-title'),
  dialogName:    document.getElementById('dialog-name'),
  dialogUrl:     document.getElementById('dialog-url'),
  dialogImage:   document.getElementById('dialog-image'),
  dialogSave:    document.getElementById('dialog-save'),
  dialogCancel:  document.getElementById('dialog-cancel'),
  dialogDelete:  document.getElementById('dialog-delete'),

  groupIndicator: document.getElementById('group-indicator'),
  groupDots:      document.getElementById('group-dots'),
  groupAddBtn:    document.getElementById('group-add'),

  confirmDialog:    document.getElementById('dialog-confirm'),
  confirmName:      document.getElementById('confirm-delete-name'),
  confirmNoAsk:      document.getElementById('confirm-no-ask'),
  confirmOk:        document.getElementById('confirm-ok'),
  confirmCancel:    document.getElementById('confirm-cancel')
};

/* ==================== 初始化 ==================== */
async function init() {
  await initSettings();
  groups = await getGroups();
  activeGroupIndex = await getActiveGroup();
  speeddials = (groups[activeGroupIndex] && groups[activeGroupIndex].cards) ? groups[activeGroupIndex].cards : [];
  if (currentSettings && currentSettings.isLocked) {
    setLocked(true, true);
  }
  var wrapper = document.createElement('div');
  wrapper.style.cssText = 'flex-basis:100%;display:flex;justify-content:center';
  var indicator = document.createElement('div');
  indicator.className = 'lock-indicator';
  indicator.textContent = '\u{1F512} \u754C\u9762\u5DF2\u9501\u5B9A\uFF08\u53EA\u8BFB\u6A21\u5F0F\uFF09';
  wrapper.appendChild(indicator);
  var dashboard = document.querySelector('.dashboard-section');
  if (dashboard) {
    dashboard.insertBefore(wrapper, dashboard.firstChild);
  }

  // v1.0.3: 迁移现有 URL 图标到本地缓存
  if (typeof migrateCardIcons === 'function') await migrateCardIcons();
  // v1.0.9: 为旧卡片补全 visitCount / createdAt 字段
  if (typeof migrateCardFields === 'function') migrateCardFields();
  // v1.1.0+: 清理 IndexedDB 无主卡片图标
  if (typeof collectCardImageGarbage === 'function') collectCardImageGarbage();

  renderSpeeddials();
  bindMainEvents();
  if (currentSettings && currentSettings.showClock) {
    initClock();
  }
  if (currentSettings && currentSettings.showLunar) {
    initLunar();
  }
  if (currentSettings && currentSettings.showWeather) {
    initWeather();
  }
  initWallpaper();
  initContextMenu();
  renderGroupDots();

  // v1.0.7: 离线指示器
  if (!navigator.onLine) document.body.classList.add('offline');
  window.addEventListener('online', function () { document.body.classList.remove('offline'); });
  window.addEventListener('offline', function () { document.body.classList.add('offline'); });

  // 点击页面空白处自动聚焦搜索框（新标签页焦点在地址栏，需用户先点一下页面）
  document.body.addEventListener('click', function (e) {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select') ||
        e.target.closest('textarea') || e.target.closest('.context-menu') ||
        e.target.closest('.settings-panel') || e.target.closest('.dialog-overlay')) return;
    domMain.searchInput.focus();
  });

  // v1.1.0: 沉浸模式 — 双击空白隐藏/恢复界面
  var _immClick = 0;
  document.addEventListener('click', function (e) {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select') || e.target.closest('.settings-panel') || e.target.closest('.dialog-overlay')) return;
    var now = Date.now();
    if (now - _immClick < 350) {
      document.body.classList.toggle('immersive');
      showToast(document.body.classList.contains('immersive') ? '已进入沉浸模式，再次双击恢复界面' : '界面已恢复', 'info');
      _immClick = 0;
    } else {
      _immClick = now;
    }
  });
}

/* ==================== 外部变更监听（v1.0.7 防抖+隐身跳过） ==================== */
var _savingGroups = false;
var _renderDebounce = null;
var _visPending = false;  // BUG-005: 防止 hidden 状态下重复注册 visibilitychange

function _debouncedRefresh() {
  clearTimeout(_renderDebounce);
  _renderDebounce = setTimeout(function () {
    if (document.hidden) {
      if (_visPending) return;
      _visPending = true;
      document.addEventListener('visibilitychange', function onVis() {
        if (!document.hidden) {
          _visPending = false;
          renderSpeeddials();
          renderGroupDots();
          document.removeEventListener('visibilitychange', onVis);
        }
      });
    } else {
      renderSpeeddials();
      renderGroupDots();
    }
  }, 300);
}

chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName !== 'sync') return;
  if (changes.groups && !_savingGroups) {
    var newGroups = changes.groups.newValue;
    if (newGroups && Array.isArray(newGroups)) {
      groups = newGroups;
      speeddials = (groups[activeGroupIndex] && groups[activeGroupIndex].cards)
        ? groups[activeGroupIndex].cards : [];
      _debouncedRefresh();
    }
  }
  if (changes.settings && changes.settings.newValue) {
    var newLocked = changes.settings.newValue.isLocked;
    if (typeof newLocked === 'boolean') {
      setLocked(newLocked, true);
    }
  }
});

/* ==================== 主事件绑定 ==================== */
function bindMainEvents() {
  domMain.grid.addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-action="edit"]');
    if (editBtn) {
      e.stopPropagation();
      if (isLocked) { showToast('界面已锁定，请右键 → 解锁', 'warning'); return; }
      const id = editBtn.dataset.id;
      if (id) openEditDialog(id);
      return;
    }
    const deleteBtn = e.target.closest('[data-action="delete"]');
    if (deleteBtn) {
      e.stopPropagation();
      if (isLocked) { showToast('界面已锁定，请右键 → 解锁', 'warning'); return; }
      const id = deleteBtn.dataset.id;
      if (id) handleDeleteClick(id);
      return;
    }
    const addBtn = e.target.closest('[data-action="add"]');
    if (addBtn) {
      e.stopPropagation();
      if (isLocked) return;
      openAddDialog();
      return;
    }
    const cardEl = e.target.closest('.speeddial-card:not(.card-add)');
    if (cardEl) {
      var wrapper = cardEl.closest('.card-wrapper');
      var cardUrl = (wrapper && wrapper.dataset.url) ? wrapper.dataset.url : cardEl.dataset.url;
      var cardId = (wrapper && wrapper.dataset.id) ? wrapper.dataset.id : cardEl.dataset.id;
      if (!cardUrl) return;
      // 刚完成拖拽，忽略本次点击
      if (window._justDragged && Date.now() - window._justDragged < 300) return;
      if (cardId && typeof incrementVisitCount === 'function') incrementVisitCount(cardId);
      var mode = currentSettings ? currentSettings.cardOpenMode : 'current';
      if (mode === 'foreground') {
        chrome.tabs.create({ url: cardUrl, active: true });
      } else if (mode === 'background') {
        chrome.tabs.create({ url: cardUrl, active: false });
      } else {
        window.location.href = cardUrl;
      }
    }
  });

  // 鼠标中键 → 新标签页打开卡片
  domMain.grid.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const cardEl = e.target.closest('.speeddial-card:not(.card-add)');
    if (cardEl) {
      var wrapper = cardEl.closest('.card-wrapper');
      var cardUrl = (wrapper && wrapper.dataset.url) ? wrapper.dataset.url : cardEl.dataset.url;
      var cardId = (wrapper && wrapper.dataset.id) ? wrapper.dataset.id : cardEl.dataset.id;
      if (cardUrl) {
        e.preventDefault();
        if (cardId && typeof incrementVisitCount === 'function') incrementVisitCount(cardId);
        window.open(cardUrl, '_blank');
      }
    }
  });

  // 锁定状态下拖拽卡片 → 指示器闪烁抖动
  domMain.grid.addEventListener('mousedown', function (e) {
    if (!isLocked || e.button !== 0) return;
    if (e.target.closest('.card-actions') || e.target.closest('button')) return;
    var cardEl = e.target.closest('.speeddial-card:not(.card-add)');
    if (!cardEl) return;
    var wrapper = cardEl.closest('.card-wrapper');
    if (!wrapper) return;
    e.preventDefault();
    var indicator = document.querySelector('.lock-indicator');
    if (indicator) {
      indicator.classList.remove('shake');
      void indicator.offsetWidth;
      indicator.classList.add('shake');
    }
  });

  domMain.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      performSearch();
    }
  });

  domMain.searchIcon.addEventListener('click', function (e) {
    e.stopPropagation();
    showSearchEngineDropdown();
  });

  document.addEventListener('click', function () {
    var dd = document.getElementById('search-engine-dropdown');
    if (dd) dd.classList.add('hidden');
  });

  domMain.dialogSave.addEventListener('click', saveDialog);
  domMain.dialogCancel.addEventListener('click', closeDialog);
  domMain.dialogDelete.addEventListener('click', function () {
    if (editingId) {
      handleDeleteClick(editingId);
      closeDialog();
    }
  });
  domMain.dialog.addEventListener('click', (e) => {
    if (e.target === domMain.dialog) closeDialog();
  });

  domMain.dialogUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveDialog();
  });
  domMain.dialogName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') domMain.dialogUrl.focus();
  });

  const uploadBtn = document.getElementById('dialog-image-upload');
  const fileInput = document.getElementById('dialog-image-file');
  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const key = await uploadImage(file, 'card');
      domMain.dialogImage.value = 'idx:' + key;
    });
  }

  bindConfirmDialogEvents();
  bindGroupEvents();
  bindGroupDialogEvents();
  bindKeyboardShortcuts();
}

/* ==================== 删除确认弹窗 ==================== */
function bindConfirmDialogEvents() {
  if (!domMain.confirmDialog) return;
  domMain.confirmOk.addEventListener('click', function () {
    if (domMain.confirmNoAsk && domMain.confirmNoAsk.checked && currentSettings) {
      currentSettings.confirmDelete = false;
      saveSettings(currentSettings);
    }
    if (confirmDeleteId) {
      deleteSpeeddialById(confirmDeleteId);
    }
    closeConfirmDialog();
  });
  domMain.confirmCancel.addEventListener('click', closeConfirmDialog);
  domMain.confirmDialog.addEventListener('click', function (e) {
    if (e.target === domMain.confirmDialog) closeConfirmDialog();
  });
}

function handleDeleteClick(id) {
  if (currentSettings && currentSettings.confirmDelete === false) {
    deleteSpeeddialById(id);
    return;
  }
  confirmDeleteId = id;
  var card = speeddials.find(function (c) { return c.id === id; });
  if (domMain.confirmName && card) {
    domMain.confirmName.textContent = '确定要删除「' + card.name + '」吗？';
  }
  if (domMain.confirmNoAsk) domMain.confirmNoAsk.checked = false;
  domMain.confirmDialog.classList.remove('hidden');
}

function closeConfirmDialog() {
  if (domMain.confirmDialog) domMain.confirmDialog.classList.add('hidden');
  confirmDeleteId = null;
}

/* ==================== 分组事件（滚轮切换 + 按钮） ==================== */
var _scrollEdge = 0;      // 0=正常, 1=向上到底, -1=向下到底
var _scrollEdgeTimer = null;

function bindGroupEvents() {
  document.addEventListener('wheel', function (e) {
    if (!groups || groups.length <= 1) return;
    if (typeof dragCard !== 'undefined' && dragCard) return;
    if (e.target.closest('.settings-panel') || e.target.closest('.dialog-overlay') ||
        e.target.closest('.context-menu')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    var dir = e.deltaY > 0 ? 1 : -1;
    var atEdge = false;
    var st = document.documentElement.scrollTop;
    var sh = document.documentElement.scrollHeight;
    var ch = document.documentElement.clientHeight;
    if (dir > 0 && st + ch >= sh - 8) atEdge = true;
    if (dir < 0 && st < 8) atEdge = true;

    // 未到底 → 正常滚动卡片，重置状态
    if (!atEdge) {
      _scrollEdge = 0;
      clearTimeout(_scrollEdgeTimer);
      return;
    }

    // 到底部 → 需要两次同方向滚轮才切换分组
    if (_scrollEdge === dir) {
      // 第二次同方向：切换分组
      _scrollEdge = 0;
      clearTimeout(_scrollEdgeTimer);
      if (dir > 0) {
        var next = activeGroupIndex + 1;
        if (next >= groups.length) next = 0;
        switchGroup(next);
      } else {
        var prev = activeGroupIndex - 1;
        if (prev < 0) prev = groups.length - 1;
        switchGroup(prev);
      }
    } else {
      // 第一次到底：标记方向，2 秒后自动重置
      _scrollEdge = dir;
      clearTimeout(_scrollEdgeTimer);
      _scrollEdgeTimer = setTimeout(function () { _scrollEdge = 0; }, 2000);
    }
  }, { passive: true });

  if (domMain.groupAddBtn) {
    domMain.groupAddBtn.addEventListener('click', addGroup);
  }
  var manageBtn = document.getElementById('group-manage');
  if (manageBtn) {
    manageBtn.addEventListener('click', openGroupManager);
  }
}

/* ==================== 键盘快捷键 ==================== */
function bindKeyboardShortcuts() {
  document.addEventListener('keydown', function (e) {
    var tag = e.target.tagName;
    var isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;

    if (!isInput && e.key === '/') {
      e.preventDefault();
      domMain.searchInput.focus();
      domMain.searchInput.select();
      return;
    }

    // Alt+, 打开设置面板（全局，不受输入框焦点影响）
    if (e.key === ',' && e.altKey) {
      e.preventDefault();
      if (typeof openSettingsPanel === 'function') openSettingsPanel();
      return;
    }

    // Alt+N 新建卡片（全局，不受输入框焦点影响）
    if (e.key === 'n' && e.altKey) {
      e.preventDefault();
      if (isLocked) { showToast('界面已锁定，请右键 → 解锁', 'warning'); return; }
      openAddDialog();
      return;
    }

    if (e.key === 'Escape') {
      hideContextMenu();
      if (typeof closeSettingsPanel === 'function') {
        var panel = document.getElementById('settings-panel');
        if (panel && !panel.classList.contains('hidden')) {
          closeSettingsPanel();
        }
      }
      closeDialog();
    }
  });
}

/* ==================== 锁定/解锁 ==================== */
function setLocked(state, silent) {
  isLocked = state;
  if (state) {
    document.body.classList.add('is-locked');
  } else {
    document.body.classList.remove('is-locked');
  }
  if (currentSettings) {
    currentSettings.isLocked = state;
    saveSettings(currentSettings);
  }
  // BUG-008: silent 模式跳过渲染，由 _debouncedRefresh 统一控制
  if (!silent) {
    renderSpeeddials();
    showToast(state ? '🔒 界面已锁定（只读模式）' : '🔓 界面已解锁', 'info');
  }
}

/* ==================== Toast 通知 ==================== */
function showToast(message, type) {
  type = type || 'info';
  var container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  var toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(function () {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, 2600);
}

/* ==================== 工具函数 ==================== */

/** 根据字符串生成固定的哈希颜色 */
function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  const s = 55 + (Math.abs(hash) % 25);
  const l = 35 + (Math.abs(hash >> 8) % 20);
  return 'hsl(' + h + ', ' + s + '%, ' + l + '%)';
}

/** HTML 转义 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ==================== 启动 ==================== */
document.addEventListener('DOMContentLoaded', init);
