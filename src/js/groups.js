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
      var idx = parseInt(this.dataset.group, 10);
      showGroupContextMenu(e.clientX, e.clientY, idx);
    });
  });
}

/* ==================== 分组切换 ==================== */
async function switchGroup(index) {
  if (index === activeGroupIndex || !groups[index]) return;
  if (groups[activeGroupIndex]) {
    groups[activeGroupIndex].cards = speeddials;
  }
  activeGroupIndex = index;
  speeddials = groups[index].cards || [];
  domMain.grid.classList.add('switching');
  await new Promise(function (r) { setTimeout(r, 80); });
  renderSpeeddials();
  domMain.grid.classList.remove('switching');
  saveGroups(groups);
  saveActiveGroup(activeGroupIndex);
  renderGroupDots();
}

/* ==================== 分组 CRUD ==================== */
async function addGroup() {
  openGroupDialog('add', -1);
}

async function renameGroup(index) {
  openGroupDialog('rename', index);
}

async function deleteGroup(index) {
  if (groups.length <= 1) { showToast('至少保留一个分组', 'warning'); return; }
  var g = groups[index];
  if (!confirm('确定删除分组「' + g.name + '」及其所有卡片？')) return;
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

function openGroupDialog(mode, index) {
  groupDialogMode = mode;
  groupDialogIndex = index;
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
}

async function saveGroupDialog() {
  var input = document.getElementById('dialog-group-name');
  var name = input ? input.value.trim() : '';
  if (!name) { showToast('请输入分组名称', 'warning'); return; }
  if (groupDialogMode === 'add') {
    var id = 'g' + Date.now().toString(36);
    groups.push({ id: id, name: name, cards: [] });
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
  dlg.addEventListener('click', function (e) { if (e.target === dlg) closeGroupDialog(); });
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
  if (addBtn) addBtn.onclick = function () { addGroup(); closeGroupManager(); setTimeout(openGroupManager, 300); };
  dlg.onclick = function (e) { if (e.target === dlg) closeGroupManager(); };
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
    input.addEventListener('click', function () {
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
