/* ============================================================
   dashboard.js — 看板编辑态（◀▶ 箭头换位）
   v1.3.0: 箭头换位 + dashboardOrder 持久化
   v1.3.1: ESC 退出 + 锁定禁用 + 保存防抖 + 箭头事件委托
   ============================================================ */

var _dashEditing = false;
var _dashSaveTimer = null;

function initDashboardGrid() {
  var grid = document.getElementById('dashboard-grid');
  if (!grid) return;

  // 恢复保存顺序
  if (currentSettings && currentSettings.dashboardOrder) {
    applyDashboardOrder(currentSettings.dashboardOrder);
  }

  // 编辑按钮（设置面板内）
  var editBtn = document.getElementById('btn-dash-edit');
  if (editBtn) {
    editBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleDashEdit();
    });
  }

  // 完成按钮（编辑态浮动在看板旁）
  var doneBtn = document.getElementById('btn-dash-done');
  if (doneBtn) {
    doneBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleDashEdit();
    });
  }

  // v1.3.1: 箭头改用事件委托 —— 组件动态增删后无需重新绑定
  grid.addEventListener('click', _onDashGridClick);
}

/* 箭头点击（事件委托）：仅在编辑态响应 */
function _onDashGridClick(e) {
  if (!_dashEditing) return;
  var arrow = e.target && e.target.closest ? e.target.closest('.dash-arrow') : null;
  if (!arrow) return;
  e.stopPropagation();

  var grid = document.getElementById('dashboard-grid');
  if (!grid || !grid.contains(arrow)) return;

  var item = arrow.closest('.dashboard-item');
  if (!item) return;

  var siblings = Array.prototype.slice.call(grid.querySelectorAll('.dashboard-item'));
  var idx = siblings.indexOf(item);
  if (idx === -1) return;

  var dir = arrow.dataset.dir;
  if (dir === 'left' && idx > 0) {
    grid.insertBefore(item, siblings[idx - 1]);
  } else if (dir === 'right' && idx < siblings.length - 1) {
    grid.insertBefore(siblings[idx + 1], item);
  } else {
    return; // 已在边界，不写盘
  }
  _saveOrder();
}

/* v1.3.1: 锁定判定（main.js 用 let 声明，需防 TDZ） */
function _dashIsLocked() {
  try {
    return typeof isLocked !== 'undefined' && !!isLocked;
  } catch (err) {
    return false;
  }
}

function toggleDashEdit() {
  // v1.3.1: 锁定状态下不允许进入编辑态
  if (!_dashEditing && _dashIsLocked()) {
    if (typeof showToast === 'function') showToast('🔒 界面已锁定，无法编辑看板', 'info');
    return;
  }

  _dashEditing = !_dashEditing;
  var btn = document.getElementById('btn-dash-edit');

  if (_dashEditing) {
    document.body.classList.add('dash-editing');
    if (btn) btn.textContent = '✅ 完成编辑';
    // 关闭设置面板让用户看到看板
    if (typeof closeSettingsPanel === 'function') closeSettingsPanel();
  } else {
    document.body.classList.remove('dash-editing');
    if (btn) btn.textContent = '✋ 编辑组件顺序';
    _flushOrder(); // 退出编辑态立即落盘，不等防抖
  }
}

function isDashEditing() { return _dashEditing; }

/* v1.3.1: 防抖保存 —— 连点箭头只写一次 storage.sync */
function _saveOrder() {
  if (_dashSaveTimer) clearTimeout(_dashSaveTimer);
  _dashSaveTimer = setTimeout(_flushOrder, 300);
}

function _flushOrder() {
  if (_dashSaveTimer) {
    clearTimeout(_dashSaveTimer);
    _dashSaveTimer = null;
  }
  var grid = document.getElementById('dashboard-grid');
  if (!grid) return;

  var order = [];
  grid.querySelectorAll('.dashboard-item[data-widget]').forEach(function (item) {
    order.push(item.dataset.widget);
  });

  if (!currentSettings) currentSettings = {};

  // 顺序未变化则不写盘
  var prev = currentSettings.dashboardOrder;
  if (Array.isArray(prev) && prev.length === order.length &&
      prev.every(function (v, i) { return v === order[i]; })) {
    return;
  }

  currentSettings.dashboardOrder = order;
  if (typeof saveSettings === 'function') saveSettings(currentSettings);
}

function applyDashboardOrder(order) {
  if (!order || !Array.isArray(order)) return;
  var grid = document.getElementById('dashboard-grid');
  if (!grid) return;
  order.forEach(function (id) {
    var el = grid.querySelector('.dashboard-item[data-widget="' + id + '"]');
    if (el) grid.appendChild(el);
  });
}
