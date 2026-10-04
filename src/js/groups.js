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
  // v1.5.4: 显示规则必须读设置数据，不能读设置面板里的下拉框 ——
  // 面板是懒初始化的，未打开时下拉框只有 HTML 默认值（第一个选项「仅当前组」），
  // 于是每次刷新后指示器都被"限定"成仅当前组，看起来像设置保存不了
  var mode = (currentSettings && currentSettings.showGroupName) || 'all';
  if (mode !== 'all' && mode !== 'active' && mode !== 'off') mode = 'all';

  var pos = domMain.groupIndicator.getAttribute('data-position') || 'left';
  var isTab = pos === 'top' || pos === 'bottom';

  // v1.5.0: 分组颜色 / 图标
  var groupFace = function (g) {
    var icon = g.icon ? '<span class="group-icon">' + escapeHtml(g.icon) + '</span>' : '';
    var style = g.color ? ' style="--group-color:' + escapeHtml(g.color) + '"' : '';
    return { icon: icon, style: style, label: escapeHtml(g.icon ? g.icon + ' ' + (g.name || '未命名') : (g.name || '未命名')) };
  };

  groups.forEach(function (g, i) {
    var cls;
    var face = groupFace(g);
    if (isTab) {
      if (mode === 'off') {
        // 不显示：圆点
        cls = i === activeGroupIndex ? 'group-dot active' : 'group-dot';
        html += '<div class="' + cls + '" data-group="' + i + '"' + face.style + ' title="' + face.label + '">' + face.icon + '</div>';
      } else if (mode === 'active') {
        // 仅当前：当前组文字，其他圆点
        if (i === activeGroupIndex) {
          html += '<div class="group-tab active" data-group="' + i + '"' + face.style + ' title="' + face.label + '">' + face.icon + escapeHtml(g.name || '未命名') + '</div>';
        } else {
          html += '<div class="group-dot" data-group="' + i + '"' + face.style + ' title="' + face.label + '">' + face.icon + '</div>';
        }
      } else {
        // 全部：文字标签
        cls = i === activeGroupIndex ? 'group-tab active' : 'group-tab';
        html += '<div class="' + cls + '" data-group="' + i + '"' + face.style + ' title="' + face.label + '">' + face.icon + escapeHtml(g.name || '未命名') + '</div>';
      }
    } else {
      cls = i === activeGroupIndex ? 'group-dot active' : 'group-dot';
      var showName = mode === 'all' || (mode === 'active' && i === activeGroupIndex);
      var nameExtra = (mode === 'all') ? ' style="opacity:1"' : '';
      var nameLabel = showName ? '<span class="group-dot-name"' + nameExtra + '>' + face.icon + escapeHtml(g.name || '未命名') + '</span>' : face.icon;
      html += '<div class="' + cls + '" data-group="' + i + '"' + face.style + ' title="' + face.label + '">' + nameLabel + '</div>';
    }
  });
  domMain.groupDots.innerHTML = html;

  domMain.groupDots.querySelectorAll('.group-tab, .group-dot').forEach(function (dot) {
    var activate = function () {
      var idx = parseInt(dot.dataset.group, 10);
      if (idx !== activeGroupIndex) switchGroup(idx);
    };
    dot.addEventListener('click', activate);
    // BUG-047: a11y.js 给圆点加了 role=button + tabindex=0，但 div 不会像 <button> 那样
    // 把 Enter/Space 合成为 click —— 只有 click 监听时键盘用户根本切不了分组。
    dot.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();   // 防止 Space 把页面往下滚
        activate();
      }
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
  // v1.5.1: 切换分组后清空多选（选中是针对某个分组的，跨组保留会造成误导）
  if (typeof clearCardSelection === 'function') clearCardSelection();
  // v1.2.6: 分组切换后检测看板碰撞
  if (typeof _debounceCollisionCheck === 'function') _debounceCollisionCheck();
  // 异步保存，不阻塞 UI；延迟释放 _savingGroups 确保 onChanged 被拦截
  if (typeof _savingGroups !== 'undefined') _savingGroups = true;
  // v1.3.3: 滚轮连续切分组会产生突发写入 → 合并写（结构性改动仍走立即写）
  saveGroups(groups, { coalesce: true });
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
  // v1.5.15: 抽到 storage.js 的 _snapshotGroupsForUndo()（失败只 warn，不阻断删除）
  await _snapshotGroupsForUndo();

  // v1.2.1: 不在此处删除 IndexedDB 图片（保留给 bak 恢复用，GC 后续清理）
  // 原 deleteCardIcon 调用已移除

  // 活动分组按 id 跟随（与 moveGroupTo 一致）：删掉活动组之前的分组时，
  // 原实现只做「越界夹紧」，会让用户莫名其妙切到另一个分组
  var activeId = groups[activeGroupIndex] ? groups[activeGroupIndex].id : null;
  groups.splice(index, 1);
  if (activeId) {
    var ni = groups.findIndex(function (gg) { return gg.id === activeId; });
    activeGroupIndex = ni !== -1 ? ni : Math.min(index, groups.length - 1);
  } else {
    activeGroupIndex = Math.min(activeGroupIndex, groups.length - 1);
  }
  speeddials = groups[activeGroupIndex] ? groups[activeGroupIndex].cards : [];
  // BUG-038: 下标整体平移 → DOM 池缓存必须整体失效，否则切组会显示已删除分组的卡片
  if (typeof _invalidateGroupDOMCache === 'function') _invalidateGroupDOMCache();
  if (typeof clearCardSelection === 'function') clearCardSelection();
  await saveGroups(groups);
  await saveActiveGroup(activeGroupIndex);
  renderSpeeddials();
  renderGroupDots();
  // BUG-035: 删除真正完成后才重渲染分组管理器列表 ——
  // 原实现在「点删除按钮时」就重渲染（此时还没 splice），列表行上的 data-index
  // 与 groups 数组错位，用户再点某行的 ✕ 会删掉另一个分组
  renderGroupManagerList();
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
  var importBtn = document.getElementById('group-mgr-import');
  if (importBtn) importBtn.onclick = function () {
    // v1.3.3: 导入分组（导入完成后刷新列表）
    if (typeof importGroup === 'function') importGroup();
  };
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
/** v1.5.0: 把分组从 from 移动到 to 位置（拖拽排序，非交换） */
async function moveGroupTo(from, to) {
  if (from === to || from < 0 || to < 0 || from >= groups.length || to >= groups.length) return;
  var activeId = groups[activeGroupIndex] ? groups[activeGroupIndex].id : null;
  var moved = groups.splice(from, 1)[0];
  groups.splice(to, 0, moved);
  // 活动分组跟随（按 id 重新定位，避免索引错乱）
  if (activeId) {
    var ni = groups.findIndex(function (g) { return g.id === activeId; });
    if (ni !== -1) activeGroupIndex = ni;
  }
  // BUG-038: 下标整体平移 → DOM 池缓存必须整体失效，否则切组会显示别的分组的卡片
  if (typeof _invalidateGroupDOMCache === 'function') _invalidateGroupDOMCache();
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
      '<input type="color" class="group-mgr-color" data-index="' + i + '" value="' + escapeHtml(g.color || '#4a90d9') + '" title="分组颜色" aria-label="分组颜色">' +
      '<input type="text" class="group-mgr-icon" data-index="' + i + '" maxlength="2" placeholder="图标" value="' + escapeHtml(g.icon || '') + '" title="分组图标（emoji，最多 2 字）" aria-label="分组图标">' +
      '<input class="group-mgr-name" value="' + escapeHtml(g.name) + '" data-index="' + i + '">' +
      '<span class="group-mgr-drag" draggable="true" tabindex="0" role="button" data-index="' + i + '" title="拖拽调整顺序（聚焦后按 ↑↓ 也可移动）" aria-label="拖拽调整分组顺序，聚焦后按上下方向键移动">⠿</span>' +
      '<div class="group-mgr-actions">' +
      '<button class="group-mgr-btn" data-action="mgr-export" data-index="' + i + '" title="导出此分组">📤</button>' +
      '<button class="group-mgr-btn danger" data-action="mgr-delete" data-index="' + i + '" title="删除">✕</button>' +
      '</div></div>';
  });
  list.innerHTML = html;

  list.querySelectorAll('.group-mgr-name').forEach(function (input) {
    input.addEventListener('change', function () {
      var idx = parseInt(this.dataset.index, 10);
      var name = this.value.trim();
      if (name && groups[idx]) { groups[idx].name = name; saveGroups(groups); renderGroupDots(); }
    });
  });

  // v1.5.0: 分组颜色 / 图标
  list.querySelectorAll('.group-mgr-color').forEach(function (input) {
    input.addEventListener('change', function () {
      var idx = parseInt(this.dataset.index, 10);
      if (!groups[idx]) return;
      groups[idx].color = this.value;
      saveGroups(groups);
      renderGroupDots();
    });
  });
  list.querySelectorAll('.group-mgr-icon').forEach(function (input) {
    input.addEventListener('change', function () {
      var idx = parseInt(this.dataset.index, 10);
      if (!groups[idx]) return;
      groups[idx].icon = this.value.trim().slice(0, 2);
      this.value = groups[idx].icon;
      saveGroups(groups);
      renderGroupDots();
    });
  });

  // v1.5.0: 拖拽排序（拖手柄，落到目标行上）
  var dragFrom = null;
  list.querySelectorAll('.group-mgr-drag').forEach(function (handle) {
    handle.addEventListener('dragstart', function (e) {
      dragFrom = parseInt(this.dataset.index, 10);
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch (err) { /* best-effort: 排序用的是上面的 dragFrom 变量，dataTransfer 只是给外部拖放留的标记 */ }
      this.closest('.group-mgr-item').classList.add('dragging');
    });
    handle.addEventListener('dragend', function () {
      dragFrom = null;
      list.querySelectorAll('.group-mgr-item').forEach(function (el) { el.classList.remove('dragging', 'drag-over'); });
    });
  });
  // v1.5.1: 手柄支持键盘排序（去掉 ▲▼ 后保留无障碍路径）
  list.querySelectorAll('.group-mgr-drag').forEach(function (handle) {
    handle.addEventListener('keydown', function (e) {
      var idx = parseInt(this.dataset.index, 10);
      if (e.key === 'ArrowUp' && idx > 0) { e.preventDefault(); moveGroupTo(idx, idx - 1); }
      else if (e.key === 'ArrowDown' && idx < groups.length - 1) { e.preventDefault(); moveGroupTo(idx, idx + 1); }
    });
  });

  list.querySelectorAll('.group-mgr-item').forEach(function (row) {
    row.addEventListener('dragover', function (e) {
      if (dragFrom === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', function () { row.classList.remove('drag-over'); });
    row.addEventListener('drop', function (e) {
      e.preventDefault();
      row.classList.remove('drag-over');
      if (dragFrom === null) return;
      var to = parseInt(this.dataset.index, 10);
      if (isNaN(to) || to === dragFrom) return;
      moveGroupTo(dragFrom, to);
      dragFrom = null;
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
      if (action === 'mgr-export') {
        // v1.3.3: 单分组导出
        if (typeof exportGroup === 'function' && groups[idx]) exportGroup(groups[idx].id);
      } else if (action === 'mgr-delete') {
        // BUG-035: 此处不再提前重渲染 —— 真正的 splice 发生在确认之后（doDeleteGroup），
        // 提前重渲染只会留下与 groups 数组错位的 data-index
        deleteGroup(idx);
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
