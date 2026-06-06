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

  // v1.1.9: 数据超限回退到本地存储时，提醒多设备用户用 zip 同步（每设备仅弹一次）
  if (currentSettings && currentSettings.storageFallback === 'local') {
    var fbKey = '_fallback_toast_shown';
    chrome.storage.local.get([fbKey], function (r) {
      if (!r[fbKey]) {
        chrome.storage.local.set({ [fbKey]: true });
        showToast('⚠️ 数据量较大，使用本地存储。多设备同步请用设置→导出/导入 .zip 备份', 'warning');
      }
    });
  }

  // v1.2.1: 打开页面后延迟自动备份（12h 限频 + 冲突检测）
  setTimeout(function () {
    _autoBackupIfNeeded();
  }, 5000);

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
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select') || e.target.closest('.settings-panel') || e.target.closest('.dialog-overlay') || e.target.closest('.toast') || e.target.closest('.group-indicator')) return;
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

/* ==================== 自动备份调度（v1.2.1） ==================== */

async function _autoBackupIfNeeded() {
  var mode = currentSettings ? currentSettings.backupMode : 'off';
  if (!mode || mode === 'off') return;

  if (mode === 'webdav') {
    var wcfg = await new Promise(function (r) { chrome.storage.local.get(['webdav_url','webdav_last_backup'], r); });
    if (!wcfg.webdav_url) return;
    var wLastTs = wcfg.webdav_last_backup ? new Date(wcfg.webdav_last_backup).getTime() : 0;
    if (Date.now() - wLastTs < 12 * 3600 * 1000) return;
    var remoteTime = null;
    try { remoteTime = await webdavCheckConflict(); } catch (e) { return; }
    if (remoteTime && new Date(remoteTime).getTime() > wLastTs) return;
    try {
      var data = await _collectAllData();
      var zipBlob = await _buildZipBlob(data);
      await webdavUpload(zipBlob);
      setWebdavLastBackup(new Date().toISOString());
    } catch (e) { /* 静默 */ }
    return;
  }

  // remind 模式：使用独立时间戳 remind_last_backup，不与 WebDAV 共用
  var rcfg = await new Promise(function (r) { chrome.storage.local.get(['remind_last_backup'], r); });
  var rLastTs = rcfg.remind_last_backup ? new Date(rcfg.remind_last_backup).getTime() : 0;
  var neverReminded = !rcfg.remind_last_backup;

  // 首次引导：弹出自定义对话框，清晰说明原因
  if (neverReminded) {
    var dialog = document.getElementById('dialog-backup-guide');
    if (dialog) {
      dialog.classList.remove('hidden');
      var exportBtn = document.getElementById('backup-guide-export');
      var laterBtn = document.getElementById('backup-guide-later');
      var closeDialog = function () { dialog.classList.add('hidden'); };
      if (exportBtn) {
        exportBtn.onclick = function () {
          if (typeof exportAll === 'function') exportAll();
          chrome.storage.local.set({ remind_last_backup: new Date().toISOString(), remind_backup_skipped: false });
          closeDialog();
          showToast('✅ 首次备份完成，计时已开始', 'success');
        };
      }
      if (laterBtn) {
        laterBtn.onclick = function () {
          chrome.storage.local.set({ remind_last_backup: new Date().toISOString(), remind_backup_skipped: true });
          closeDialog();
        };
      }
    }
    return;
  }

  if (document.activeElement && document.activeElement.id === 'search-input') {
    setTimeout(function () { _autoBackupIfNeeded(); }, 30000);
    return;
  }

  var days = (currentSettings && currentSettings.backupRemindDays) || 7;
  if (Date.now() - rLastTs > days * 86400 * 1000) {
    showToast('📥 已超 ' + days + ' 天未备份，点击此处导出数据', 'warning');
    var toast2 = document.querySelector('.toast');
    if (toast2) {
      toast2.style.cursor = 'pointer';
      toast2.onclick = function () {
        if (typeof exportAll === 'function') exportAll();
        chrome.storage.local.set({ remind_last_backup: new Date().toISOString() });
      };
    }
  }
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
      if (cardId && typeof incrementVisitCount === 'function') {
        var mode = currentSettings ? currentSettings.cardOpenMode : 'current';
        // 仅在切换标签页（foreground）时重渲染；current/background 用户仍在本页，不重建 DOM
        incrementVisitCount(cardId, mode === 'foreground');
      }
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
        if (cardId && typeof incrementVisitCount === 'function') incrementVisitCount(cardId, false);
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
    // > 本地卡片搜索（拦截方向键/回车/ESC）
    if (typeof handleLocalSearchKeydown === 'function' && handleLocalSearchKeydown(e)) {
      return;
    }
    if (e.key === 'Enter') {
      // 本地搜索面板打开时优先选结果，否则走搜索引擎
      var dd = document.getElementById('local-search-dropdown');
      if (dd && !dd.classList.contains('hidden')) return;
      performSearch();
    }
  });

  domMain.searchInput.addEventListener('input', function () {
    var val = this.value;
    if (val.startsWith('>')) {
      var query = val.substring(1).trim();
      if (typeof performLocalSearch === 'function') performLocalSearch(query);
    } else {
      if (typeof hideLocalSearchDropdown === 'function') hideLocalSearchDropdown();
    }
  });

  // 搜索框失焦时延迟关闭本地搜索（给点击事件留时间）
  domMain.searchInput.addEventListener('blur', function () {
    setTimeout(function () {
      if (typeof hideLocalSearchDropdown === 'function') hideLocalSearchDropdown();
    }, 200);
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
  // 点击空白处不再关闭弹窗

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

  // v1.1.5: 编辑弹窗「截取网页」按钮
  var captureBtn = document.getElementById('dialog-image-capture');
  if (captureBtn) {
    captureBtn.addEventListener('click', function () {
      var url = domMain.dialogUrl.value.trim();
      if (!url || !/^https?:\/\//i.test(url)) {
        showToast('请先填写有效的网站地址', 'warning');
        return;
      }
      var cardId = editingId || ('new_' + Date.now());
      showToast('正在截取网页...', 'info');
      chrome.runtime.sendMessage({ type: 'capture-screenshot', url: url }, async function (resp) {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          showToast('截图失败: ' + ((resp && resp.error) || 'unknown'), 'error');
          return;
        }
        var parts = resp.dataUrl.split(',');
        var byteStr = atob(parts.length > 1 ? parts[1] : parts[0]);
        var bytes = new Uint8Array(byteStr.length);
        for (var i = 0; i < byteStr.length; i++) { bytes[i] = byteStr.charCodeAt(i); }
        var blob = new Blob([bytes], { type: 'image/png' });
        var key = 'cardimg_' + cardId;
        await saveImage(key, blob);
        domMain.dialogImage.value = 'idx:' + key;
        if (typeof updateImageDBInfo === 'function') updateImageDBInfo();
        showToast('截图完成', 'success');
      });
    });
  }

  // v1.2.5: 编辑弹窗「采样主题色」按钮
  var extractBtn = document.getElementById('dialog-extract-theme');
  if (extractBtn) {
    extractBtn.addEventListener('click', function () {
      if (editingId && typeof _extractAndSaveTheme === 'function') _extractAndSaveTheme(editingId);
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
    if (typeof _pendingDeleteGroup !== 'undefined' && _pendingDeleteGroup >= 0) {
      if (typeof doDeleteGroup === 'function') doDeleteGroup();
    }
    closeConfirmDialog();
  });
  domMain.confirmCancel.addEventListener('click', closeConfirmDialog);
  // 点击空白处不再关闭确认弹窗
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
  if (typeof _pendingDeleteGroup !== 'undefined') _pendingDeleteGroup = -1;
}

/* ==================== 分组事件（滚轮切换 + 按钮） ==================== */
var _scrollEdge = 0;      // 0=正常, 1=向上到底, -1=向下到底
var _scrollEdgeTimer = null;

function bindGroupEvents() {
  document.addEventListener('wheel', function (e) {
    if (!groups || groups.length <= 1) return;
    if (currentSettings && currentSettings.disableWheelSwitch) return;
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

    // Alt+↑/↓ 切换分组（全局，不受输入框焦点影响）
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (!groups || groups.length <= 1) return;
      if (e.key === 'ArrowUp') {
        var prev = activeGroupIndex - 1;
        if (prev < 0) prev = groups.length - 1;
        if (typeof switchGroup === 'function') switchGroup(prev);
      } else {
        var next = activeGroupIndex + 1;
        if (next >= groups.length) next = 0;
        if (typeof switchGroup === 'function') switchGroup(next);
      }
      return;
    }

    if (e.key === 'Escape') {
      // 链式按优先级关闭弹窗（从高层到底层）
      // 1. 确认删除弹窗（z-index 最高）
      if (domMain.confirmDialog && !domMain.confirmDialog.classList.contains('hidden')) {
        closeConfirmDialog();
        return;
      }
      // 2. 分组命名弹窗
      var groupDlg = document.getElementById('dialog-group');
      if (groupDlg && !groupDlg.classList.contains('hidden')) {
        if (typeof closeGroupDialog === 'function') closeGroupDialog();
        return;
      }
      // 3. 分组管理器
      var groupMgr = document.getElementById('dialog-group-manager');
      if (groupMgr && !groupMgr.classList.contains('hidden')) {
        if (typeof closeGroupManager === 'function') closeGroupManager();
        return;
      }
      // 4. 搜索引擎管理器
      var searchMgr = document.getElementById('dialog-search-engines');
      if (searchMgr && !searchMgr.classList.contains('hidden')) {
        searchMgr.classList.add('hidden');
        return;
      }
      // 5. 备份引导弹窗
      var backupGuide = document.getElementById('dialog-backup-guide');
      if (backupGuide && !backupGuide.classList.contains('hidden')) {
        backupGuide.classList.add('hidden');
        return;
      }
      // 6. 导入确认弹窗
      var importConfirm = document.getElementById('dialog-import-confirm');
      if (importConfirm && !importConfirm.classList.contains('hidden')) {
        importConfirm.classList.add('hidden');
        return;
      }
      // 7. 重置确认弹窗
      var resetDlg = document.getElementById('dialog-reset');
      if (resetDlg && !resetDlg.classList.contains('hidden')) {
        resetDlg.classList.add('hidden');
        return;
      }
      // 8. 重复卡片弹窗
      var dupDlg = document.getElementById('dialog-duplicate');
      if (dupDlg && !dupDlg.classList.contains('hidden')) {
        dupDlg.classList.add('hidden');
        return;
      }
      // 9. 卡片编辑弹窗
      if (!domMain.dialog.classList.contains('hidden')) {
        closeDialog();
        return;
      }
      // 10. 设置面板
      if (typeof closeSettingsPanel === 'function') {
        var panel = document.getElementById('settings-panel');
        if (panel && !panel.classList.contains('hidden')) {
          closeSettingsPanel();
          return;
        }
      }
      // 8. 右键菜单
      hideContextMenu();
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
