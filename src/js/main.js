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
}

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
    const card = e.target.closest('.speeddial-card:not(.card-add)');
    if (card && card.dataset.url) {
      // 刚完成拖拽，忽略本次点击
      if (window._justDragged && Date.now() - window._justDragged < 300) return;
      window.location.href = card.dataset.url;
    }
  });

  // 鼠标中键 → 新标签页打开卡片
  domMain.grid.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const card = e.target.closest('.speeddial-card:not(.card-add)');
    if (card && card.dataset.url) {
      e.preventDefault();
      window.open(card.dataset.url, '_blank');
    }
  });

  // 锁定状态下拖拽卡片 → 指示器闪烁抖动
  domMain.grid.addEventListener('mousedown', function (e) {
    if (!isLocked || e.button !== 0) return;
    if (e.target.closest('.card-actions') || e.target.closest('button')) return;
    var card = e.target.closest('.speeddial-card:not(.card-add)');
    if (!card) return;
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
function bindGroupEvents() {
  document.addEventListener('wheel', function (e) {
    if (!groups || groups.length <= 1) return;
    if (typeof dragCard !== 'undefined' && dragCard) return;
    if (e.target.closest('.settings-panel') || e.target.closest('.dialog-overlay') ||
        e.target.closest('.context-menu')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    if (e.deltaY > 0) {
      var next = activeGroupIndex + 1;
      if (next >= groups.length) next = 0;
      switchGroup(next);
    } else if (e.deltaY < 0) {
      var prev = activeGroupIndex - 1;
      if (prev < 0) prev = groups.length - 1;
      switchGroup(prev);
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

    if (!isInput && (e.key === '/' || (e.key === 'f' && e.ctrlKey && e.shiftKey))) {
      e.preventDefault();
      domMain.searchInput.focus();
      domMain.searchInput.select();
      return;
    }

    if (!isInput && e.key === ',' && e.ctrlKey) {
      e.preventDefault();
      if (typeof openSettingsPanel === 'function') openSettingsPanel();
      return;
    }

    if (!isInput && e.key === 'n' && e.ctrlKey) {
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
  renderSpeeddials();
  if (!silent) {
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
