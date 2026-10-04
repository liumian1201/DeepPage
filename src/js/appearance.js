/* ============================================================
   appearance.js — 外观配色与卡片尺寸实时预览
   ============================================================ */

function applyAppearance(settings) {
  var root = document.documentElement;
  // 颜色类：仅在用户自定义时覆盖，否则交由主题 CSS 变量控制
  if (settings.bgColor) { root.style.setProperty('--bg-primary', settings.bgColor); root.style.setProperty('--topbar-bg', settings.bgColor); }
  if (settings.cardBgColor) root.style.setProperty('--bg-card', settings.cardBgColor);
  if (settings.cardTextColor) { root.style.setProperty('--topbar-text', settings.cardTextColor); root.style.setProperty('--text-on-card', settings.cardTextColor); }
  // 尺寸类：始终应用
  root.style.setProperty('--card-font-size', (settings.cardFontSize || 13) + 'px');
  root.style.setProperty('--card-width', (settings.cardWidth || 270) + 'px');
  root.style.setProperty('--card-height', (settings.cardHeight || 270) + 'px');
  root.style.setProperty('--card-radius', (settings.cardBorderRadius || 14) + 'px');
  root.style.setProperty('--card-opacity', (settings.cardOpacity != null ? settings.cardOpacity : 100) / 100);
  // 同步 Grid 列布局
  updateGridColumns(settings.columns);
}

function updateGridColumns(cols) {
  // BUG-016: rAF 节流，避免 input 事件每帧触发 Grid layout 重算
  if (updateGridColumns._pending) return;
  updateGridColumns._pending = true;
  requestAnimationFrame(function () {
    updateGridColumns._pending = false;
    var grid = document.getElementById('speeddial-grid');
    if (!grid) return;
    if (cols === undefined) {
      // BUG-048: 回退源必须是「设置数据」，不能读 #setting-columns-slider ——
      // 面板懒初始化，未打开过面板时滑块只有 HTML 默认值 5，resize 会把已保存的列数改掉
      cols = (typeof currentSettings !== 'undefined' && currentSettings && currentSettings.columns) || 5;
    }
    // v1.3.3: 卡片宽度改从 CSS 变量读取，不再读设置面板的滑块 ——
    // 面板已改为「首次打开才初始化」，此时滑块可能仍是 HTML 默认值（270）
    var w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--card-width'), 10) || 270;
    var gap = 16; // 与 main.css .speeddial-grid gap 一致

    grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(' + w + 'px, 1fr))';

    // 根据父容器宽度算实际能放几列（上限滑块列数）
    // BUG-084（#8-6 沉浸模式变 1 列）：沉浸模式把 .speeddial-section 设为 display:none，
    // 网格父容器 clientWidth = 0 → 下面会算出 actualCols = 1，并把 grid.style.width 写成
    // 「一张卡宽」(270px)；而这个内联宽度在退出沉浸模式后没有任何路径重算 → 卡片就永久
    // 变成每行 1 个（刷新恢复，因为刷新会重跑 applyAppearance 拿到真实宽度）。
    // 修法：**隐藏/零宽容器下不做测量、也不写样式** —— 与 BUG-048「别拿不可信测量结果
    // 覆盖状态」同一原则。退出沉浸模式时由 main.js 显式重算一次兜底。
    // 网格不在 DOM 里时同样「测不到就不写」（原来回退 window.innerWidth，会把视口宽度当成
    // 容器宽度写进内联样式 —— 同族错误）。
    if (!grid.parentElement) return;
    var parentWidth = grid.parentElement.clientWidth;
    if (!(parentWidth > 0)) return;
    var actualCols = Math.max(1, Math.min(cols, Math.floor((parentWidth + gap) / (w + gap))));
    var gridWidth = actualCols * w + (actualCols - 1) * gap;

    // 宽屏：滑块列数为上限；窄屏：实际列数 < 滑块 → Grid 窄于父容器 → margin 居中
    grid.style.width = gridWidth + 'px';
    grid.style.maxWidth = '100%';
    grid.style.marginLeft = 'auto';
    grid.style.marginRight = 'auto';
  });
}

// 窗口 resize 时重算 Grid
var _gridResizeTimer = 0;
window.addEventListener('resize', function () {
  if (_gridResizeTimer) clearTimeout(_gridResizeTimer);
  _gridResizeTimer = setTimeout(function () {
    _gridResizeTimer = 0;
    updateGridColumns();
  }, 150);
});

function bindAppearancePreview(dom, onChanged) {
  ['bgColor', 'cardBgColor', 'cardTextColor'].forEach(function (key) {
    var el = dom[key]; if (!el) return;
    el.addEventListener('input', function () {
      var m = { bgColor: '--topbar-bg', cardBgColor: '--bg-card', cardTextColor: '--topbar-text' };
      var v = el.value;
      if (v) {
        document.documentElement.style.setProperty(m[key], v);
        if (key === 'cardTextColor') document.documentElement.style.setProperty('--text-on-card', v);
        if (key === 'bgColor') document.documentElement.style.setProperty('--bg-primary', v);
      }
    });
  });

  var fs = dom.cardFontSize, fsv = dom.cardFontSizeVal;
  if (fs && fsv) fs.addEventListener('input', function () {
    fsv.textContent = fs.value + 'px';
    document.documentElement.style.setProperty('--card-font-size', fs.value + 'px');
  });

  var rs = dom.cardBorderRadius, rsv = dom.cardBorderRadiusVal;
  if (rs && rsv) rs.addEventListener('input', function () {
    rsv.textContent = rs.value + 'px';
    document.documentElement.style.setProperty('--card-radius', rs.value + 'px');
  });

  var os = dom.cardOpacity, osv = dom.cardOpacityVal;
  if (os && osv) os.addEventListener('input', function () {
    osv.textContent = os.value + '%';
    document.documentElement.style.setProperty('--card-opacity', parseInt(os.value, 10) / 100);
  });

  var cs = dom.columnsSlider, csv = dom.columnsSliderVal;
  if (cs && csv) cs.addEventListener('input', function () {
    csv.textContent = cs.value;
    updateGridColumns(parseInt(cs.value, 10));
  });

  var ws = dom.cardWidth, wsv = dom.cardWidthVal;
  if (ws && wsv) ws.addEventListener('input', function () {
    wsv.textContent = ws.value + 'px';
    document.documentElement.style.setProperty('--card-width', ws.value + 'px');
    updateGridColumns();
  });

  var hs = dom.cardHeight, hsv = dom.cardHeightVal;
  if (hs && hsv) hs.addEventListener('input', function () {
    hsv.textContent = hs.value + 'px';
    document.documentElement.style.setProperty('--card-height', hs.value + 'px');
    // v1.2.9: 同步更新所有可见卡片的 inline height，绕过 display:contents 继承问题
    var cards = document.querySelectorAll('.speeddial-card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].style.height = hs.value + 'px';
    }
  });

  var resetBtn = document.getElementById('btn-reset-card-size');
  if (resetBtn) resetBtn.addEventListener('click', function () {
    // BUG-082：程序化赋值不触发 input 事件 → 必须走 _setRangeValue 同步 --pct，
    // 否则滑块拇指与标签都回到 270px 了，进度填充还停在用户拖拽时的旧位置
    _setRangeValue(ws, 270);
    if (wsv) wsv.textContent = '270px';
    _setRangeValue(hs, 270);
    if (hsv) hsv.textContent = '270px';
    _setRangeValue(rs, 14);
    if (rsv) rsv.textContent = '14px';
    _setRangeValue(os, 100);
    if (osv) osv.textContent = '100%';
    document.documentElement.style.setProperty('--card-width', '270px');
    document.documentElement.style.setProperty('--card-height', '270px');
    document.documentElement.style.setProperty('--card-radius', '14px');
    document.documentElement.style.setProperty('--card-opacity', '1');
    // BUG-049: 高度滑块在 input 时给每张卡片写了内联 height，内联优先级高于
    // `height: var(--card-height)`，只改 CSS 变量的话高度看起来"重置无效" → 必须清掉
    document.querySelectorAll('.speeddial-card').forEach(function (c) { c.style.height = ''; });
    updateGridColumns();
    // BUG-049: 重置只改 DOM 不落盘（程序化赋值不触发 change）→ 显式保存，
    // 否则刷新后重置意图丢失（与「↺ 重置看板大小」的 onSettingChanged() 一致）
    if (onChanged) onChanged();
  });

  var resetTopbar = document.getElementById('btn-reset-topbar');
  if (resetTopbar) resetTopbar.addEventListener('click', function () {
    var bc = document.getElementById('setting-bg-color');
    var tc = document.getElementById('setting-card-text-color');
    // 颜色控件不能赋 ''（input[type=color] 会回落成 #000000，落盘后变成「自定义黑色」）
    // → 赋主题默认值，collectAppearanceForm 的 val() 会把它映射回 ''（= 未自定义）
    if (bc) bc.value = '#f0f2f5';
    if (tc) tc.value = '#202124';
    if (fs) _setRangeValue(fs, 13);
    if (fsv) fsv.textContent = '13px';
    document.documentElement.style.removeProperty('--topbar-bg');
    document.documentElement.style.removeProperty('--bg-primary');
    document.documentElement.style.removeProperty('--topbar-text');
    document.documentElement.style.removeProperty('--text-on-card');
    document.documentElement.style.setProperty('--card-font-size', '13px');
    // BUG-049: 同上，重置信息栏也必须落盘
    if (onChanged) onChanged();
  });

  var resetSearch = document.getElementById('btn-reset-search-pos');
  if (resetSearch) resetSearch.addEventListener('click', function () {
    var st = document.getElementById('setting-search-top');
    var sg = document.getElementById('setting-search-gap');
    var stv = document.getElementById('search-top-val');
    var sgv = document.getElementById('search-gap-val');
    if (st) _setRangeValue(st, 60);
    if (sg) _setRangeValue(sg, 48);
    if (stv) stv.textContent = '60px';
    if (sgv) sgv.textContent = '48px';
    document.documentElement.style.setProperty('--search-top', '60px');
    document.documentElement.style.setProperty('--search-gap', '48px');
    // BUG-074: 按钮此前在 HTML 里不存在（死分支），补上入口的同时按 BUG-049 的约定落盘 ——
    // 程序化赋值不触发 change，不显式保存的话刷新后重置意图丢失
    if (onChanged) onChanged();
  });

  if (onChanged) {
    // BUG-014: 仅外观专属控件绑定 onChanged，避免与 bindSettingsEvents 双重绑定
    var appearanceEls = [dom.bgColor, dom.cardBgColor, dom.cardTextColor, dom.cardFontSize, dom.cardWidth, dom.cardHeight, dom.columnsSlider, dom.cardBorderRadius, dom.cardOpacity];
    appearanceEls.forEach(function (el) {
      if (el) el.addEventListener('change', onChanged);
    });
  }
}

/** 把外观数据回填到表单控件（与 collectAppearanceForm 严格对称）。
 *  BUG-039: 单独抽出 —— 设置面板每次打开都必须「以数据为准」回填，
 *  否则表单停留在 HTML 默认值 / 陈旧值，下一次任意设置变更就会把它写回数据。 */
function populateAppearanceForm(dom, settings) {
  var dc = { bgColor: '#f0f2f5', cardBgColor: '#ffffff', cardTextColor: '#202124' };
  if (dom.bgColor) dom.bgColor.value = settings.bgColor || dc.bgColor;
  if (dom.cardBgColor) dom.cardBgColor.value = settings.cardBgColor || dc.cardBgColor;
  if (dom.cardTextColor) dom.cardTextColor.value = settings.cardTextColor || dc.cardTextColor;
  if (dom.cardFontSize) dom.cardFontSize.value = settings.cardFontSize || 13;
  if (dom.cardFontSizeVal) dom.cardFontSizeVal.textContent = (settings.cardFontSize || 13) + 'px';
  if (dom.columnsSlider) dom.columnsSlider.value = settings.columns || 5;
  if (dom.columnsSliderVal) dom.columnsSliderVal.textContent = settings.columns || 5;
  if (dom.cardWidth) dom.cardWidth.value = settings.cardWidth || 270;
  if (dom.cardWidthVal) dom.cardWidthVal.textContent = (settings.cardWidth || 270) + 'px';
  if (dom.cardHeight) dom.cardHeight.value = settings.cardHeight || 270;
  if (dom.cardHeightVal) dom.cardHeightVal.textContent = (settings.cardHeight || 270) + 'px';
  if (dom.cardBorderRadius) dom.cardBorderRadius.value = settings.cardBorderRadius || 14;
  if (dom.cardBorderRadiusVal) dom.cardBorderRadiusVal.textContent = (settings.cardBorderRadius || 14) + 'px';
  if (dom.cardOpacity) dom.cardOpacity.value = settings.cardOpacity != null ? settings.cardOpacity : 100;
  if (dom.cardOpacityVal) dom.cardOpacityVal.textContent = (settings.cardOpacity != null ? settings.cardOpacity : 100) + '%';
}

function initAppearance(dom, settings, cb) {
  populateAppearanceForm(dom, settings);
  applyAppearance(settings);
  bindAppearancePreview(dom, cb || function () {});
}

function collectAppearanceForm(dom) {
  var dc = { bgColor: '#f0f2f5', cardBgColor: '#ffffff', cardTextColor: '#202124' };
  // 未自定义时返回空，避免 fallback 值覆盖主题 CSS 变量
  function val(el, d) { var v = (el && el.value) || ''; return v === d ? '' : v; }
  return {
    bgColor: val(dom.bgColor, dc.bgColor),
    cardBgColor: val(dom.cardBgColor, dc.cardBgColor),
    cardTextColor: val(dom.cardTextColor, dc.cardTextColor),
    cardFontSize: dom.cardFontSize ? parseInt(dom.cardFontSize.value, 10) : 13,
    cardWidth: dom.cardWidth ? parseInt(dom.cardWidth.value, 10) : 270,
    cardHeight: dom.cardHeight ? parseInt(dom.cardHeight.value, 10) : 270,
    columns: dom.columnsSlider ? parseInt(dom.columnsSlider.value, 10) : 5,
    cardBorderRadius: dom.cardBorderRadius ? parseInt(dom.cardBorderRadius.value, 10) : 14,
    cardOpacity: dom.cardOpacity ? parseInt(dom.cardOpacity.value, 10) : 100
  };
}
