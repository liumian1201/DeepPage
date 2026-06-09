/* ============================================================
   groups.js — 分组管理（指示器、切换、对话框、管理器）
   ============================================================ */

/* ==================== 分组指示器 ==================== */
function renderGroupDots() {
  if (!domMain.groupDots) return;
  var showIndicator = !currentSettings || currentSettings.showGroupIndicator !== false;
  domMain.groupIndicator.style.display = showIndicator ? '' : 'none';
  if (!showIndicator) return;

  var html = '';
  var sel = document.getElementById('setting-group-name-mode');
  var mode = sel ? sel.value : 'all';
  if (mode !== 'all' && mode !== 'active' && mode !== 'off') mode = 'all';

  var pos = domMain.groupIndicator.getAttribute('data-position') || 'left';
  var isTab = pos === 'top' || pos === 'bottom';

  groups.forEach(function (g, i) {
    if (isTab) {
      if (mode === 'off') {
        // 不显示：圆点
        var cls = i === activeGroupIndex ? 'group-dot active' : 'group-dot';
        html += '<div class="' + cls + '" data-group="' + i + '" title="' + escapeHtml(g.name || '未命名') + '"></div>';
      } else if (mode === 'active') {
        // 仅当前：当前组文字，其他圆点
        if (i === activeGroupIndex) {
          html += '<div class="group-tab active" data-group="' + i + '" title="' + escapeHtml(g.name || '未命名') + '">' + escapeHtml(g.name || '未命名') + '</div>';
        } else {
          html += '<div class="group-dot" data-group="' + i + '" title="' + escapeHtml(g.name || '未命名') + '"></div>';
        }
      } else {
        // 全部：文字标签
        var cls = i === activeGroupIndex ? 'group-tab active' : 'group-tab';
        html += '<div class="' + cls + '" data-group="' + i + '" title="' + escapeHtml(g.name || '未命名') + '">' + escapeHtml(g.name || '未命名') + '</div>';
      }
    } else {
      var cls = i === activeGroupIndex ? 'group-dot active' : 'group-dot';
      var showName = mode === 'all' || (mode === 'active' && i === activeGroupIndex);
      var nameExtra = (mode === 'all') ? ' style="opacity:1"' : '';
      var nameLabel = showName ? '<span class="group-dot-name"' + nameExtra + '>' + escapeHtml(g.name || '未命名') + '</span>' : '';
      html += '<div class="' + cls + '" data-group="' + i + '" title="' + escapeHtml(g.name || '未命名') + '">' + nameLabel + '</div>';
    }
  });
  domMain.groupDots.innerHTML = html;

  domMain.groupDots.querySelectorAll('.group-tab, .group-dot').forEach(function (dot) {
    dot.addEventListener('click', function () {
      var idx = parseInt(this.dataset.group, 10);
      if (idx !== activeGroupIndex) switchGroup(idx);
    });
    dot.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var idx = parseInt(this.dataset.group, 10);
      showGroupContextMenu(e.clientX, e.clientY, idx);
    });
  });
}

/* ==================== 分组切换 ==================== */
async function switchGroup(index) {
  // v1.2.9: 切换分组时恢复原始排序
  if (typeof _resetRecentSort === 'function') _resetRecentSort();
  if (index === activeGroupIndex || !groups[index]) return;
  if (groups[activeGroupIndex]) {
    groups[activeGroupIndex].cards = speeddials;
  }
  activeGroupIndex = index;
  speeddials = groups[index].cards || [];

  // DOM 分组缓存命中：只切换显示，不重建 DOM
  if (typeof _groupHasDOM === 'function' && _groupHasDOM(activeGroupIndex) && typeof _showCurrentGroup === 'function') {
    _showCurrentGroup();
  } else {
    renderSpeeddials();
  }
  renderGroupDots();
  if (typeof updateSortModeSelect === 'function') updateSortModeSelect();
  // v1.2.6: 分组切换后检测看板碰撞
  if (typeof _debounceCollisionCheck === 'function') _debounceCollisionCheck();
  // 异步保存，不阻塞 UI；延迟释放 _savingGroups 确保 onChanged 被拦截
  if (typeof _savingGroups !== 'undefined') _savingGroups = true;
  saveGroups(groups);
  saveActiveGroup(activeGroupIndex);
  setTimeout(function () { _savingGroups = false; }, 200);
}

/* ==================== 分组 CRUD ==================== */
async function addGroup() {
  openGroupDialog('add', -1);
}

async function renameGroup(index) {
  openGroupDialog('rename', index);
}

var _pendingDeleteGroup = -1;

async function deleteGroup(index) {
  if (groups.length <= 1) { showToast('至少保留一个分组', 'warning'); return; }
  if (!groups[index]) return;
  _pendingDeleteGroup = index;
  var g = groups[index];
  if (domMain.confirmName) {
    domMain.confirmName.textContent = '确定删除分组「' + g.name + '」及其所有卡片？';
  }
  if (domMain.confirmNoAsk) domMain.confirmNoAsk.checked = false;
  domMain.confirmDialog.classList.remove('hidden');
}

async function doDeleteGroup() {
  var index = _pendingDeleteGroup;
  _pendingDeleteGroup = -1;
  if (index < 0 || !groups[index]) return;
  var g = groups[index];

  // v1.2.1: 删组前先保存 bak（含 IndexedDB 图片引用），避免恢复后破图
  if (typeof getGroups === 'function') {
    try {
      var prev = await getGroups();
      if (prev && Array.isArray(prev) && prev.length > 0) {
        await new Promise(function (r) { chrome.storage.local.set({ groups_local_bak: prev, bak_timestamp: Date.now() }, r); });
      }
    } catch (e) {}
  }

  // v1.2.1: 不在此处删除 IndexedDB 图片（保留给 bak 恢复用，GC 后续清理）
  // 原 deleteCardIcon 调用已移除

  var cards = g.cards || [];

  groups.splice(index, 1);
  if (activeGroupIndex >= groups.length) activeGroupIndex = groups.length - 1;
  if (activeGroupIndex === index) activeGroupIndex = Math.min(activeGroupIndex, groups.length - 1);
  speeddials = groups[activeGroupIndex] ? groups[activeGroupIndex].cards : [];
  await saveGroups(groups);
  await saveActiveGroup(activeGroupIndex);
  renderSpeeddials();
  renderGroupDots();
}

function showGroupContextMenu(x, y, index) {
  domMain.contextMenu.querySelectorAll('.context-menu-item').forEach(function (item) {
    var a = item.dataset.action;
    if (a === 'groupRename' || a === 'groupDelete') {
      item.classList.toggle('hidden', isLocked);
      if (a === 'groupRename') item.dataset.group = index;
      if (a === 'groupDelete') item.dataset.group = index;
    } else {
      item.classList.add('hidden');
    }
  });
  domMain.contextMenu.querySelectorAll('.context-menu-separator').forEach(function (s) { s.classList.add('hidden'); });
  domMain.contextMenu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  domMain.contextMenu.style.top = Math.min(y, window.innerHeight - 120) + 'px';
  domMain.contextMenu.classList.remove('hidden');
}

/* ==================== 分组名称弹窗 ==================== */
var groupDialogMode = 'add';
var groupDialogIndex = -1;
var _groupMgrWasOpen = false;  // BUG-022: 跟踪管理器是否需在对话框关闭后重开

function openGroupDialog(mode, index) {
  groupDialogMode = mode;
  groupDialogIndex = index;
  // BUG-022: 记录管理器打开状态
  var mgr = document.getElementById('dialog-group-manager');
  _groupMgrWasOpen = mgr && !mgr.classList.contains('hidden');
  var dlg = document.getElementById('dialog-group');
  var title = document.getElementById('dialog-group-title');
  var input = document.getElementById('dialog-group-name');
  if (!dlg || !title || !input) return;
  if (mode === 'add') {
    title.textContent = '新建分组';
    input.value = '';
  } else {
    var g = groups[index];
    title.textContent = '重命名分组';
    input.value = g ? g.name : '';
  }
  dlg.classList.remove('hidden');
  input.focus();
  input.select();
}

function closeGroupDialog() {
  var dlg = document.getElementById('dialog-group');
  if (dlg) dlg.classList.add('hidden');
  groupDialogIndex = -1;
  // BUG-022: 对话框关闭后，若管理器之前打开则重开
  if (_groupMgrWasOpen) {
    _groupMgrWasOpen = false;
    openGroupManager();
  }
}

async function saveGroupDialog() {
  var input = document.getElementById('dialog-group-name');
  var name = input ? input.value.trim() : '';
  if (!name) { showToast('请输入分组名称', 'warning'); return; }
  if (groupDialogMode === 'add') {
    var id = 'g' + Date.now().toString(36);
    groups.push({ id: id, name: name, sortMode: 'manual', cards: [] });
    await saveGroups(groups);
    renderGroupDots();
    switchGroup(groups.length - 1);
  } else if (groupDialogMode === 'rename' && groups[groupDialogIndex]) {
    groups[groupDialogIndex].name = name;
    await saveGroups(groups);
    renderGroupDots();
  }
  closeGroupDialog();
}

function bindGroupDialogEvents() {
  var dlg = document.getElementById('dialog-group');
  var saveBtn = document.getElementById('dialog-group-save');
  var cancelBtn = document.getElementById('dialog-group-cancel');
  var input = document.getElementById('dialog-group-name');
  if (!dlg) return;
  if (saveBtn) saveBtn.addEventListener('click', saveGroupDialog);
  if (cancelBtn) cancelBtn.addEventListener('click', closeGroupDialog);
  // 点击空白处不再关闭弹窗
  if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') saveGroupDialog(); });
}

/* ==================== 分组管理器弹窗 ==================== */
function openGroupManager() {
  var dlg = document.getElementById('dialog-group-manager');
  if (!dlg) return;
  renderGroupManagerList();
  dlg.classList.remove('hidden');

  var closeBtn = document.getElementById('group-mgr-close');
  var cancelBtn = document.getElementById('group-mgr-cancel');
  var addBtn = document.getElementById('group-mgr-add');
  if (closeBtn) closeBtn.onclick = closeGroupManager;
  if (cancelBtn) cancelBtn.onclick = closeGroupManager;
  if (addBtn) addBtn.onclick = function () {
    closeGroupManager();
    // BUG-022: 在 saveGroupDialog 中重开管理器，替代 setTimeout 盲等
    addGroup();
  };
  // 点击空白处不再关闭弹窗
}

function closeGroupManager() {
  var dlg = document.getElementById('dialog-group-manager');
  if (dlg) dlg.classList.add('hidden');
  renderGroupDots();
  renderSpeeddials();
}

/** 分组上移/下移公共逻辑 */
async function swapGroups(from, to) {
  var tmp = groups[from];
  groups[from] = groups[to];
  groups[to] = tmp;
  if (activeGroupIndex === from) activeGroupIndex = to;
  else if (activeGroupIndex === to) activeGroupIndex = from;
  await saveGroups(groups);
  await saveActiveGroup(activeGroupIndex);
  renderGroupManagerList();
  renderGroupDots();
  speeddials = groups[activeGroupIndex] ? groups[activeGroupIndex].cards : [];
  renderSpeeddials();
}

function renderGroupManagerList() {
  var list = document.getElementById('group-manager-list');
  if (!list) return;
  var html = '';
  groups.forEach(function (g, i) {
    var activeCls = i === activeGroupIndex ? ' active' : '';
    var cardCount = (g.cards && g.cards.length) ? g.cards.length : 0;
    html += '<div class="group-mgr-item' + activeCls + '" data-index="' + i + '">' +
      '<span class="mgr-card-count">' + cardCount + '</span>' +
      '<input class="group-mgr-name" value="' + escapeHtml(g.name) + '" data-index="' + i + '">' +
      '<div class="group-mgr-actions">' +
      '<button class="group-mgr-btn" data-action="mgr-up" data-index="' + i + '" title="上移">▲</button>' +
      '<button class="group-mgr-btn" data-action="mgr-down" data-index="' + i + '" title="下移">▼</button>' +
      '<button class="group-mgr-btn danger" data-action="mgr-delete" data-index="' + i + '" title="删除">✕</button>' +
      '</div></div>';
  });
  list.innerHTML = html;

  list.querySelectorAll('.group-mgr-name').forEach(function (input) {
    input.addEventListener('change', function () {
      var idx = parseInt(this.dataset.index, 10);
      var name = this.value.trim();
      if (name && groups[idx]) { groups[idx].name = name; saveGroups(groups); }
    });
  });
  // BUG-021: click 绑定在 .group-mgr-item 整行上，排除 input/button
  list.querySelectorAll('.group-mgr-item').forEach(function (row) {
    row.addEventListener('click', function (e) {
      if (e.target.closest('input') || e.target.closest('button')) return;
      var idx = parseInt(this.dataset.index, 10);
      if (idx !== activeGroupIndex) switchGroup(idx);
    });
  });
  list.querySelectorAll('.group-mgr-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var idx = parseInt(this.dataset.index, 10);
      var action = this.dataset.action;
      if (action === 'mgr-up' && idx > 0) {
        swapGroups(idx, idx - 1);
      } else if (action === 'mgr-down' && idx < groups.length - 1) {
        swapGroups(idx, idx + 1);
      } else if (action === 'mgr-delete') {
        deleteGroup(idx);
        renderGroupManagerList();
      }
    });
  });
}

/* ==================== v1.2.9: 最近访问排序 ==================== */
var _recentSortActive = false;
var _origSortMode = null;

function toggleRecentSort() {
  var btn = document.getElementById('group-recent');
  if (!btn) return;
  if (_recentSortActive) {
    _resetRecentSort();
    renderSpeeddials();
    if (typeof updateSortModeSelect === 'function') updateSortModeSelect();
  } else {
    _recentSortActive = true;
    btn.classList.add('active-sort');
    if (groups[activeGroupIndex]) {
      _origSortMode = groups[activeGroupIndex].sortMode || 'manual';
      groups[activeGroupIndex].sortMode = 'lastOpened-desc';
    }
    renderSpeeddials();
    if (typeof updateSortModeSelect === 'function') updateSortModeSelect();
  }
}

function _resetRecentSort() {
  if (!_recentSortActive) return;
  _recentSortActive = false;
  var btn = document.getElementById('group-recent');
  if (btn) btn.classList.remove('active-sort');
  if (groups[activeGroupIndex] && _origSortMode) {
    groups[activeGroupIndex].sortMode = _origSortMode;
  }
  _origSortMode = null;
}

// 页面加载后绑定事件
(function () {
  var btn = document.getElementById('group-recent');
  if (btn) btn.addEventListener('click', toggleRecentSort);
})();
