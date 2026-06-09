/* ============================================================
   dashboard.js — v1.3.0 看板编辑态（◀▶ 箭头换位）
   ============================================================ */

var _dashEditing = false;

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

  // 箭头按钮
  grid.querySelectorAll('.dash-arrow').forEach(function (arrow) {
    arrow.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!_dashEditing) return;
      var dir = this.dataset.dir;
      var item = this.closest('.dashboard-item');
      if (!item) return;
      var siblings = Array.from(grid.querySelectorAll('.dashboard-item'));
      var idx = siblings.indexOf(item);
      if (dir === 'left' && idx > 0) {
        grid.insertBefore(item, siblings[idx - 1]);
      } else if (dir === 'right' && idx < siblings.length - 1) {
        grid.insertBefore(siblings[idx + 1], item);
      }
      _saveOrder();
    });
  });
}

function toggleDashEdit() {
  _dashEditing = !_dashEditing;
  if (_dashEditing) {
    document.body.classList.add('dash-editing');
    var btn = document.getElementById('btn-dash-edit');
    if (btn) btn.textContent = '✅ 完成编辑';
    // 关闭设置面板让用户看到看板
    if (typeof closeSettingsPanel === 'function') closeSettingsPanel();
  } else {
    document.body.classList.remove('dash-editing');
    var btn2 = document.getElementById('btn-dash-edit');
    if (btn2) btn2.textContent = '✋ 编辑组件顺序';
  }
}

function isDashEditing() { return _dashEditing; }

function _saveOrder() {
  var grid = document.getElementById('dashboard-grid');
  if (!grid) return;
  var order = [];
  grid.querySelectorAll('.dashboard-item[data-widget]').forEach(function (item) {
    order.push(item.dataset.widget);
  });
  if (!currentSettings) currentSettings = {};
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
