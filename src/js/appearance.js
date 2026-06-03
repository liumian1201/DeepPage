/* ============================================================
   appearance.js — 外观配色与卡片尺寸实时预览
   ============================================================ */

function applyAppearance(settings) {
  var root = document.documentElement;
  root.style.setProperty('--bg-primary', settings.bgColor || '#f0f2f5');
  root.style.setProperty('--topbar-bg', settings.bgColor || '#f0f2f5');
  root.style.setProperty('--bg-card', settings.cardBgColor || '#ffffff');
  root.style.setProperty('--topbar-text', settings.cardTextColor || '#202124');
  root.style.setProperty('--text-on-card', settings.cardTextColor || '#202124');
  root.style.setProperty('--card-font-size', (settings.cardFontSize || 13) + 'px');
  root.style.setProperty('--card-width', (settings.cardWidth || 270) + 'px');
  root.style.setProperty('--card-height', (settings.cardHeight || 270) + 'px');
  root.style.setProperty('--card-radius', (settings.cardBorderRadius || 14) + 'px');
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
      var s = document.getElementById('setting-columns-slider');
      cols = s ? parseInt(s.value, 10) : 5;
    }
    var ws = document.getElementById('setting-card-width');
    var w = ws ? ws.value : 270;
    grid.style.gridTemplateColumns = 'repeat(' + cols + ', ' + w + 'px)';
  });
}

function bindAppearancePreview(dom, onChanged) {
  ['bgColor', 'cardBgColor', 'cardTextColor'].forEach(function (key) {
    var el = dom[key]; if (!el) return;
    el.addEventListener('input', function () {
      var m = { bgColor: '--topbar-bg', cardBgColor: '--bg-card', cardTextColor: '--topbar-text' };
      var defaults = { bgColor: '#f0f2f5', cardBgColor: '#ffffff', cardTextColor: '#202124' };
      document.documentElement.style.setProperty(m[key], el.value || defaults[key]);
      if (key === 'cardTextColor') document.documentElement.style.setProperty('--text-on-card', el.value || defaults[key]);
      if (key === 'bgColor') document.documentElement.style.setProperty('--bg-primary', el.value || defaults[key]);
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
  });

  var resetBtn = document.getElementById('btn-reset-card-size');
  if (resetBtn) resetBtn.addEventListener('click', function () {
    if (ws) ws.value = 270;
    if (wsv) wsv.textContent = '270px';
    if (hs) hs.value = 270;
    if (hsv) hsv.textContent = '270px';
    if (rs) rs.value = 14;
    if (rsv) rsv.textContent = '14px';
    document.documentElement.style.setProperty('--card-width', '270px');
    document.documentElement.style.setProperty('--card-height', '270px');
    document.documentElement.style.setProperty('--card-radius', '14px');
    updateGridColumns();
  });

  var resetTopbar = document.getElementById('btn-reset-topbar');
  if (resetTopbar) resetTopbar.addEventListener('click', function () {
    var bc = document.getElementById('setting-bg-color');
    var tc = document.getElementById('setting-card-text-color');
    if (bc) bc.value = '#f0f2f5';
    if (tc) tc.value = '#202124';
    if (fs) fs.value = 13;
    if (fsv) fsv.textContent = '13px';
    document.documentElement.style.setProperty('--topbar-bg', '#f0f2f5');
    document.documentElement.style.setProperty('--bg-primary', '#f0f2f5');
    document.documentElement.style.setProperty('--topbar-text', '#202124');
    document.documentElement.style.setProperty('--text-on-card', '#202124');
    document.documentElement.style.setProperty('--card-font-size', '13px');
  });

  var resetSearch = document.getElementById('btn-reset-search-pos');
  if (resetSearch) resetSearch.addEventListener('click', function () {
    var st = document.getElementById('setting-search-top');
    var sg = document.getElementById('setting-search-gap');
    var stv = document.getElementById('search-top-val');
    var sgv = document.getElementById('search-gap-val');
    if (st) st.value = 60;
    if (sg) sg.value = 48;
    if (stv) stv.textContent = '60px';
    if (sgv) sgv.textContent = '48px';
    document.documentElement.style.setProperty('--search-top', '60px');
    document.documentElement.style.setProperty('--search-gap', '48px');
  });

  if (onChanged) {
    // BUG-014: 仅外观专属控件绑定 onChanged，避免与 bindSettingsEvents 双重绑定
    var appearanceEls = [dom.bgColor, dom.cardBgColor, dom.cardTextColor, dom.cardFontSize, dom.cardWidth, dom.cardHeight, dom.columnsSlider, dom.cardBorderRadius];
    appearanceEls.forEach(function (el) {
      if (el) el.addEventListener('change', onChanged);
    });
  }
}

function initAppearance(dom, settings, cb) {
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
  applyAppearance(settings);
  bindAppearancePreview(dom, cb || function () {});
}

function collectAppearanceForm(dom) {
  var dc = { bgColor: '#f0f2f5', cardBgColor: '#ffffff', cardTextColor: '#202124' };
  return {
    bgColor: (dom.bgColor && dom.bgColor.value) || dc.bgColor,
    cardBgColor: (dom.cardBgColor && dom.cardBgColor.value) || dc.cardBgColor,
    cardTextColor: (dom.cardTextColor && dom.cardTextColor.value) || dc.cardTextColor,
    cardFontSize: dom.cardFontSize ? parseInt(dom.cardFontSize.value, 10) : 13,
    cardWidth: dom.cardWidth ? parseInt(dom.cardWidth.value, 10) : 270,
    cardHeight: dom.cardHeight ? parseInt(dom.cardHeight.value, 10) : 270,
    columns: dom.columnsSlider ? parseInt(dom.columnsSlider.value, 10) : 5,
    cardBorderRadius: dom.cardBorderRadius ? parseInt(dom.cardBorderRadius.value, 10) : 14
  };
}
