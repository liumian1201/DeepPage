/* ============================================================
   dashboard.js — 看板布局与编辑态
   v1.3.0: 箭头换位 + dashboardOrder 持久化
   v1.3.1: ESC 退出 + 锁定禁用 + 保存防抖 + 箭头事件委托
   v1.4.0: 12 列 grid-area 布局 + 组件注册表 + 拖拽换位 + 宽度（跨列）调节
   ============================================================ */

/* ---------- 组件注册表 ----------
   新增看板组件只需：① 在 index.html 加一个 data-widget="<id>" 的 .dashboard-item
   ② 在此登记 id/label/默认与最小跨列数。
   布局、开关、编辑态、尺寸控制都由注册表驱动，不再有「HTML 改了 ID 忘了同步」的问题。
*/
var DASHBOARD_WIDGETS = [
  // minSpan 统一为 1：12 列栅格下让用户自己决定多窄（默认值合计仍为 12，正好一行）
  { id: 'clock',   label: '时间',  elementId: 'dash-clock',   defaultSpan: 3, minSpan: 1, settingKey: 'showClock' },
  { id: 'weather', label: '天气',  elementId: 'dash-weather', defaultSpan: 4, minSpan: 1, settingKey: 'showWeather' },
  { id: 'todo',    label: '待办',  elementId: 'dash-todo',    defaultSpan: 3, minSpan: 1, settingKey: 'showTodo' },
  { id: 'lunar',   label: '农历',  elementId: 'dash-lunar',   defaultSpan: 2, minSpan: 1, settingKey: 'showLunar' }
];

var DASHBOARD_COLUMNS = 12;

var _dashEditing = false;
var _dashSaveTimer = null;
/* 编辑期间的「工作副本」：落盘是 300ms 防抖的，若每次都从 currentSettings 重新读，
   防抖窗口内的连续操作（连点 ＋/◀▶、拖拽）会基于同一份陈旧基准，改动互相覆盖 */
var _dashWorkingLayout = null;
/* 上次落盘的快照：必须与工作副本**不共享引用** —— 否则「顺序未变化」的判断会变成
   自己跟自己比较，永远相等，导致改动永远不落盘（E2E 实测踩到过） */
var _dashSavedLayout = null;

/* ==================== 布局模型 ==================== */

/* 组件布局的存储键。
   注意不能再用 dashboardLayout —— 那是「布局方向」（row/column 字符串）的字段，
   v1.5.0 曾把布局对象写进去，导致设置里下拉框空白、且每次保存设置又会把对象覆盖成 ''，
   用户的组件布局被静默重置（v1.5.2 修正）。 */
var DASH_LAYOUT_KEY = 'dashboardWidgetLayout';
var DASH_LAYOUT_LEGACY_KEY = 'dashboardLayout';

function _dashWidget(id) {
  for (var i = 0; i < DASHBOARD_WIDGETS.length; i++) {
    if (DASHBOARD_WIDGETS[i].id === id) return DASHBOARD_WIDGETS[i];
  }
  return null;
}

function _clampSpan(span, widget) {
  var n = parseInt(span, 10);
  if (isNaN(n)) n = widget.defaultSpan;
  var min = widget.minSpan || 1;
  return Math.max(min, Math.min(DASHBOARD_COLUMNS, n));
}

/**
 * 读取布局：{ <widgetId>: { order, span } }
 * v1.4.0 数据迁移：老版本只有 dashboardOrder（数组）→ 下标即顺序，宽度取默认值。
 */
function getDashboardLayout(settings) {
  var s = settings || currentSettings || {};
  var layout = {};
  DASHBOARD_WIDGETS.forEach(function (w, i) {
    layout[w.id] = { order: i, span: w.defaultSpan };
  });

  var stored = s[DASH_LAYOUT_KEY];
  if (!stored && s[DASH_LAYOUT_LEGACY_KEY] && typeof s[DASH_LAYOUT_LEGACY_KEY] === 'object') {
    stored = s[DASH_LAYOUT_LEGACY_KEY];   // 旧版本误写的位置
  }
  if (stored && typeof stored === 'object') {
    DASHBOARD_WIDGETS.forEach(function (w) {
      var e = stored[w.id];
      if (!e) return;
      if (typeof e.order === 'number') layout[w.id].order = e.order;
      layout[w.id].span = _clampSpan(e.span, w);
    });
  } else if (Array.isArray(s.dashboardOrder)) {
    // 迁移：dashboardOrder = ['weather','clock','lunar']
    s.dashboardOrder.forEach(function (id, i) {
      if (layout[id]) layout[id].order = i;
    });
  }
  return layout;
}

/** 当前布局：编辑期间优先用内存工作副本，保证连续操作可累积 */
function _dashCurrentLayout() {
  if (!_dashWorkingLayout) _dashWorkingLayout = getDashboardLayout();
  return _dashWorkingLayout;
}

/** 外部数据变化（导入/重置）后丢弃工作副本 */
function resetDashWorkingLayout() {
  _dashWorkingLayout = null;
}

/**
 * 把布局应用到 DOM：跨列写 grid-column，顺序**物理重排 DOM**（不用 CSS order）。
 * 用 CSS order 会让 DOM 顺序与视觉顺序不一致 —— 屏幕阅读器与键盘 Tab 会按 DOM 顺序走，
 * 与用户看到的顺序不符（无障碍反模式），因此这里直接重排节点。
 */
function applyDashWidgetLayout(layout) {
  var grid = document.getElementById('dashboard-grid');
  if (!grid) return;
  layout = layout || _dashCurrentLayout();

  var ordered = DASHBOARD_WIDGETS.slice().sort(function (a, b) {
    var oa = (layout[a.id] || {}).order;
    var ob = (layout[b.id] || {}).order;
    return (typeof oa === 'number' ? oa : 0) - (typeof ob === 'number' ? ob : 0);
  });

  ordered.forEach(function (w) {
    var el = document.getElementById(w.elementId) ||
             grid.querySelector('.dashboard-item[data-widget="' + w.id + '"]');
    if (!el) return;
    var span = _clampSpan((layout[w.id] || {}).span, w);
    el.style.gridColumn = 'span ' + span;
    el.dataset.span = String(span);
    el.style.order = '';
    grid.appendChild(el);          // 按 order 依次落到末尾 → DOM 顺序即视觉顺序
  });
}

/** 兼容旧 API（v1.3.x 的 dashboardOrder 数组） */
function applyDashboardOrder(order) {
  if (!Array.isArray(order)) return;
  var layout = _dashCurrentLayout();
  order.forEach(function (id, i) {
    if (layout[id]) layout[id].order = i;
  });
  applyDashWidgetLayout(layout);
}

/* ==================== 初始化 ==================== */

function initDashboardGrid() {
  var grid = document.getElementById('dashboard-grid');
  if (!grid) return;

  // v1.5.2: 启动自愈 —— 旧版本把布局对象写进了「布局方向」字段（与 row/column 冲突），
  // 这里把它搬到新键并修正方向字段，否则设置面板下拉框空白、且保存设置会覆盖掉布局
  if (currentSettings && currentSettings[DASH_LAYOUT_LEGACY_KEY] &&
      typeof currentSettings[DASH_LAYOUT_LEGACY_KEY] === 'object') {
    currentSettings[DASH_LAYOUT_KEY] = currentSettings[DASH_LAYOUT_LEGACY_KEY];
    currentSettings[DASH_LAYOUT_LEGACY_KEY] = 'row';
    if (typeof saveSettings === 'function') saveSettings(currentSettings);
  }

  // v1.5.2: 迁移结果规范化落盘 —— 读时迁移（旧数组/旧对象）后立刻写回新键，
  // 这样后续加载不再依赖迁移分支，设置面板也不会读到半旧半新的状态
  var _needsNormalize = !currentSettings || !currentSettings[DASH_LAYOUT_KEY];

  _dashWorkingLayout = getDashboardLayout();
  _dashSavedLayout = JSON.parse(JSON.stringify(_dashWorkingLayout));
  applyDashWidgetLayout(_dashWorkingLayout);

  if (_needsNormalize && typeof saveSettings === 'function') {
    _dashSavedLayout = null;          // 强制认为是「有变化」，让 _flushLayout 真正写盘
    _saveLayout(_dashWorkingLayout);
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

  // 编辑态控件（箭头 / 宽度）——由注册表驱动，动态挂到每个组件上
  _dashBuildControls(grid);

  // 事件委托：箭头/宽度按钮点击
  grid.addEventListener('click', _onDashGridClick);
  // 拖拽换位
  grid.addEventListener('mousedown', _onDashMouseDown);
}

/** 为每个组件挂上编辑态控件（◀ ▶ 换位 + −/+ 调宽度） */
function _dashBuildControls(grid) {
  DASHBOARD_WIDGETS.forEach(function (w) {
    var el = document.getElementById(w.elementId) ||
             grid.querySelector('.dashboard-item[data-widget="' + w.id + '"]');
    if (!el || el.querySelector('.dash-span-btn')) return;   // 已生成过控件则不重复添加
    var label = w.label || w.id;

    var left = document.createElement('button');
    left.className = 'dash-arrow dash-arrow-left';
    left.dataset.dir = 'left';
    left.title = '左移 ' + label;
    left.setAttribute('aria-label', '左移 ' + label);
    left.textContent = '◀';

    var right = document.createElement('button');
    right.className = 'dash-arrow dash-arrow-right';
    right.dataset.dir = 'right';
    right.title = '右移 ' + label;
    right.setAttribute('aria-label', '右移 ' + label);
    right.textContent = '▶';

    var shrink = document.createElement('button');
    shrink.className = 'dash-span-btn dash-span-shrink';
    shrink.dataset.dir = 'shrink';
    shrink.title = '减小 ' + label + ' 宽度';
    shrink.setAttribute('aria-label', '减小 ' + label + ' 宽度');
    shrink.textContent = '−';

    var grow = document.createElement('button');
    grow.className = 'dash-span-btn dash-span-grow';
    grow.dataset.dir = 'grow';
    grow.title = '增大 ' + label + ' 宽度';
    grow.setAttribute('aria-label', '增大 ' + label + ' 宽度');
    grow.textContent = '＋';

    el.appendChild(left);
    el.appendChild(right);
    el.appendChild(shrink);
    el.appendChild(grow);
  });
}

/* ==================== 编辑态交互 ==================== */

function _onDashGridClick(e) {
  if (!_dashEditing) return;
  var btn = e.target && e.target.closest ? e.target.closest('.dash-arrow, .dash-span-btn') : null;
  if (!btn) return;
  e.stopPropagation();

  var grid = document.getElementById('dashboard-grid');
  if (!grid || !grid.contains(btn)) return;

  var item = btn.closest('.dashboard-item');
  if (!item) return;

  var widgetId = item.dataset.widget;
  var widget = _dashWidget(widgetId);
  if (!widget) return;

  var layout = _dashCurrentLayout();
  var dir = btn.dataset.dir;
  var changed = false;

  if (dir === 'left' || dir === 'right') {
    var siblings = Array.prototype.slice.call(grid.querySelectorAll('.dashboard-item'));
    siblings.sort(function (a, b) {
      return (layout[a.dataset.widget] || {}).order - (layout[b.dataset.widget] || {}).order;
    });
    var idx = siblings.indexOf(item);
    var swapWith = dir === 'left' ? siblings[idx - 1] : siblings[idx + 1];
    if (!swapWith) return;                       // 已在边界，不写盘
    var otherId = swapWith.dataset.widget;
    var tmp = layout[widgetId].order;
    layout[widgetId].order = layout[otherId].order;
    layout[otherId].order = tmp;
    changed = true;
  } else if (dir === 'grow' || dir === 'shrink') {
    var cur = layout[widgetId].span;
    var next = _clampSpan(cur + (dir === 'grow' ? 1 : -1), widget);
    if (next === cur) {
      // v1.5.2: 已到上下限 —— 抖一下给出反馈，避免看起来像按钮失效
      _dashFlashLimit(item);
      return;
    }
    layout[widgetId].span = next;
    changed = true;
  }

  if (!changed) return;
  applyDashWidgetLayout(layout);
  _saveLayout(layout);
}

/** 到达宽度上下限时的视觉反馈（抖动 300ms） */
function _dashFlashLimit(el) {
  if (!el || !el.classList) return;   // 桩测试里的假元素没有 classList
  el.classList.remove('dash-span-limit');
  void el.offsetWidth;                 // 强制重排，保证动画能重新触发
  el.classList.add('dash-span-limit');
  setTimeout(function () { el.classList.remove('dash-span-limit'); }, 400);
}

/* ---- 拖拽换位（编辑态） ---- */
var _dashDrag = null;

function _onDashMouseDown(e) {
  if (!_dashEditing) return;
  if (e.button !== 0) return;
  if (e.target.closest('button')) return;        // 控件不触发拖拽
  if (e.target.closest('input, textarea, select, label')) return;  // 组件内表单控件（如待办输入框）不触发拖拽
  var item = e.target.closest('.dashboard-item');
  if (!item) return;
  _dashDrag = { item: item, startX: e.clientX, startY: e.clientY, active: false };
  e.preventDefault();
}

document.addEventListener('mousemove', function (e) {
  if (!_dashDrag) return;
  var dx = e.clientX - _dashDrag.startX;
  var dy = e.clientY - _dashDrag.startY;
  if (!_dashDrag.active && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
  if (!_dashDrag.active) {
    _dashDrag.active = true;
    _dashDrag.item.classList.add('dash-dragging');
    document.body.classList.add('dash-drag-cursor');
  }
  _dashDrag.item.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  _dashDrag.item.style.zIndex = '20';
});

document.addEventListener('mouseup', function (e) {
  if (!_dashDrag) return;
  var drag = _dashDrag;
  _dashDrag = null;
  drag.item.classList.remove('dash-dragging');
  drag.item.style.transform = '';
  drag.item.style.zIndex = '';
  document.body.classList.remove('dash-drag-cursor');
  if (!drag.active) return;

  var grid = document.getElementById('dashboard-grid');
  if (!grid) return;
  var target = null;
  var best = Infinity;
  grid.querySelectorAll('.dashboard-item').forEach(function (el) {
    if (el === drag.item) return;
    var r = el.getBoundingClientRect();
    var dist = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    if (dist < best) { best = dist; target = el; }
  });
  if (!target || best > 400) return;             // 丢得太远视为取消

  var layout = _dashCurrentLayout();
  var a = drag.item.dataset.widget;
  var b = target.dataset.widget;
  if (!layout[a] || !layout[b]) return;
  var tmp = layout[a].order;
  layout[a].order = layout[b].order;
  layout[b].order = tmp;
  applyDashWidgetLayout(layout);
  _saveLayout(layout);
});

/* ==================== 编辑态开关 ==================== */

/* v1.3.1: 锁定判定（main.js 用 let 声明，需防 TDZ） */
function _dashIsLocked() {
  try {
    return typeof isLocked !== 'undefined' && !!isLocked;
  } catch (err) {
    return false;
  }
}

function toggleDashEdit() {
  if (!_dashEditing && _dashIsLocked()) {
    if (typeof showToast === 'function') showToast('🔒 界面已锁定，无法编辑看板', 'info');
    return;
  }

  _dashEditing = !_dashEditing;
  var btn = document.getElementById('btn-dash-edit');

  if (_dashEditing) {
    document.body.classList.add('dash-editing');
    if (btn) btn.textContent = '✅ 完成编辑';
    if (typeof closeSettingsPanel === 'function') closeSettingsPanel();
  } else {
    document.body.classList.remove('dash-editing');
    if (btn) btn.textContent = '✋ 编辑组件顺序';
    _flushLayout(); // 退出编辑态立即落盘，不等防抖
  }
}

function isDashEditing() { return _dashEditing; }

/* ==================== 持久化（防抖） ==================== */

/* v1.3.1: 防抖保存 —— 连点箭头只写一次 storage.sync */
function _saveLayout(layout) {
  _dashWorkingLayout = layout;
  if (_dashSaveTimer) clearTimeout(_dashSaveTimer);
  _dashSaveTimer = setTimeout(_flushLayout, 300);
}

function _flushLayout() {
  if (_dashSaveTimer) {
    clearTimeout(_dashSaveTimer);
    _dashSaveTimer = null;
  }
  var layout = _dashWorkingLayout;
  if (!layout) return;
  if (!currentSettings) currentSettings = {};

  // 与上次落盘快照比对：未变化则不写盘（注意用值比较，不能比引用）
  var snapshot = JSON.parse(JSON.stringify(layout));
  if (_dashSavedLayout && DASHBOARD_WIDGETS.every(function (w) {
    var a = _dashSavedLayout[w.id] || {};
    var b = snapshot[w.id] || {};
    return a.order === b.order && a.span === b.span;
  })) {
    return;
  }
  _dashSavedLayout = snapshot;

  currentSettings[DASH_LAYOUT_KEY] = snapshot;
  // 把此前误写进「布局方向」字段的对象清掉，否则设置面板下拉框会是空白
  if (currentSettings[DASH_LAYOUT_LEGACY_KEY] && typeof currentSettings[DASH_LAYOUT_LEGACY_KEY] === 'object') {
    currentSettings[DASH_LAYOUT_LEGACY_KEY] = 'row';
  }
  // 兼容旧版本读取：同时写一份 dashboardOrder 数组
  currentSettings.dashboardOrder = DASHBOARD_WIDGETS
    .slice()
    .sort(function (a, b) { return layout[a.id].order - layout[b.id].order; })
    .map(function (w) { return w.id; });

  if (typeof saveSettings === 'function') saveSettings(currentSettings);
}
