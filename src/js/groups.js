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


/**
 * BUG-088: 分组行排序的鼠标拖拽状态（模块级，不放在渲染闭包里）。
 * 形如 { from: 源下标, startY: 按下时的 clientY, active: 是否已越过阈值 }。
 */
var _gmgrDrag = null;
/** 文档级 mousemove/mouseup 只绑一次（列表元素可能被重渲染/重建） */
var _gmgrDocBound = false;
/** 拖拽刚结束的时间戳：短时间内忽略 click，避免"松手即切分组"（原生拖拽不会产生 click，鼠标拖拽会） */
var _gmgrDragEndAt = 0;

/** 落点 clientY 对应的目标行下标：与各行中线比较；都在上方则归到末尾 */
function _gmgrTargetIndex(clientY) {
  var list = document.getElementById('group-manager-list');
  if (!list) return -1;
  var rows = [].slice.call(list.querySelectorAll('.group-mgr-item'));
  if (!rows.length) return -1;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return rows.length - 1;
}

/** 拖拽中的视觉反馈：源行半透明、目标行顶部高亮（每次重新按**下标**取行，重渲染后也不会丢） */
function _gmgrPaintDrag(fromIdx, toIdx) {
  var list = document.getElementById('group-manager-list');
  if (!list) return;
  [].slice.call(list.querySelectorAll('.group-mgr-item')).forEach(function (el, i) {
    el.classList.toggle('dragging', i === fromIdx);
    el.classList.toggle('drag-over', i === toIdx && i !== fromIdx);
  });
}

/** 清掉拖拽中的全部视觉状态 */
function _gmgrClearDragPaint() {
  var list = document.getElementById('group-manager-list');
  if (!list) return;
  [].slice.call(list.querySelectorAll('.group-mgr-item')).forEach(function (el) {
    el.classList.remove('dragging', 'drag-over');
  });
}

function renderGroupManagerList() {
  var list = document.getElementById('group-manager-list');
  if (!list) return;
  var html = '';
  groups.forEach(function (g, i) {
    var activeCls = i === activeGroupIndex ? ' active' : '';
    var cardCount = (g.cards && g.cards.length) ? g.cards.length : 0;
    // BUG-088: **整行**可拖（用户直觉就是拖整行），但走的是鼠标事件而非原生 HTML5 拖拽；
    // 行内 input/button 上按下不启动拖拽（见下面的 mousedown 委托），保证输入框能选字、按钮能点。
    html += '<div class="group-mgr-item' + activeCls + '" data-index="' + i + '">' +
      '<span class="mgr-card-count">' + cardCount + '</span>' +
      '<input type="color" class="group-mgr-color" data-index="' + i + '" value="' + escapeHtml(g.color || '#4a90d9') + '" title="分组颜色" aria-label="分组颜色">' +
      '<input type="text" class="group-mgr-icon" data-index="' + i + '" maxlength="2" placeholder="图标" value="' + escapeHtml(g.icon || '') + '" title="分组图标（emoji，最多 2 字）" aria-label="分组图标">' +
      '<input class="group-mgr-name" value="' + escapeHtml(g.name) + '" data-index="' + i + '">' +
      '<span class="group-mgr-drag" tabindex="0" role="button" data-index="' + i + '" title="拖拽调整顺序（聚焦后按 ↑↓ 也可移动）" aria-label="拖拽调整分组顺序，聚焦后按上下方向键移动">⠿</span>' +
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

  /* ============================================================
     BUG-088: 分组行排序 = **鼠标事件拖拽**（与看板编辑态同一套机制），不再用原生 HTML5 拖拽。
     为什么换掉原生拖拽（用户真实浏览器实测，取证包日志）：
       在同一浏览器里，卡片拖拽、看板编辑态拖拽都正常，唯独分组行 —— `dragstart` 正常触发、
       `dragenter` 也送到了列表、我们内部"正在拖第几行"的标记也设对了，但**从头到尾一次 `drop`
       都不派发**，光标全程 🚫，顺序自然不变。规范上此时页面已经 `preventDefault` 接受放置，
       该派发 `drop` 才对 —— 这属于该浏览器/环境对这类元素原生拖拽的处置，我们改不动，
       于是改用**已经验证过可用**的鼠标事件路径（看板编辑态就是它，用户实测能拖）。
     顺带解决两个老问题：① 不再有"落点必须在列表内才接受"的小放置区（现在按落点 Y 找最近行，
     在弹窗哪儿松手都算）；② 不再出现原生拖拽的 🚫 光标。
     旧的原生拖拽实现（逐行绑定 → 事件委托 → 空隙接受放置 → mousedown 改 draggable → hover 摆属性）
     一路打的全是这条链路上的补丁，现在整条链路不再需要。
     注意：点击语义保持不变 —— 没越过阈值就是"点击"，仍由下面的 click 处理器切分组。
     ============================================================ */
  if (!list.dataset.gmgrSortBound) {
    list.dataset.gmgrSortBound = '1';
    list.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      var row = e.target.closest && e.target.closest('.group-mgr-item');
      if (!row) return;
      if (e.target.closest('input') || e.target.closest('button')) return;   // 行内控件保持原交互
      _gmgrDrag = { from: parseInt(row.dataset.index, 10), startY: e.clientY, active: false };
      e.preventDefault();   // 阻止文本选中；**不**阻止 click → 轻点仍能切分组
    });
  }
  if (!_gmgrDocBound) {
    _gmgrDocBound = true;
    document.addEventListener('mousemove', function (e) {
      if (!_gmgrDrag) return;
      if (!_gmgrDrag.active) {
        if (Math.abs(e.clientY - _gmgrDrag.startY) < 4) return;   // 4px 阈值：以内算点击
        _gmgrDrag.active = true;
        document.body.classList.add('gmgr-dragging');
      }
      _gmgrPaintDrag(_gmgrDrag.from, _gmgrTargetIndex(e.clientY));
    });
    document.addEventListener('mouseup', function (e) {
      if (!_gmgrDrag) return;
      var drag = _gmgrDrag;
      _gmgrDrag = null;
      document.body.classList.remove('gmgr-dragging');
      _gmgrClearDragPaint();
      if (!drag.active) return;                       // 没越阈值 → 交给 click（切分组）
      _gmgrDragEndAt = Date.now();                   // 真拖过 → 抑制随后的 click
      var to = _gmgrTargetIndex(e.clientY);
      if (isNaN(to) || to === drag.from || to < 0 || to >= groups.length) return;
      moveGroupTo(drag.from, to);
    });
  }
  // v1.5.1: 手柄支持键盘排序（去掉 ▲▼ 后保留无障碍路径）
  list.querySelectorAll('.group-mgr-drag').forEach(function (handle) {
    handle.addEventListener('keydown', function (e) {
      var idx = parseInt(this.dataset.index, 10);
      if (e.key === 'ArrowUp' && idx > 0) { e.preventDefault(); moveGroupTo(idx, idx - 1); }
      else if (e.key === 'ArrowDown' && idx < groups.length - 1) { e.preventDefault(); moveGroupTo(idx, idx + 1); }
    });
  });

  // BUG-021: click 绑定在 .group-mgr-item 整行上，排除 input/button
  list.querySelectorAll('.group-mgr-item').forEach(function (row) {
    row.addEventListener('click', function (e) {
      if (e.target.closest('input') || e.target.closest('button')) return;
      if (Date.now() - _gmgrDragEndAt < 300) return;   // BUG-088: 刚拖完那一下不算点击（否则会误切分组）
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
