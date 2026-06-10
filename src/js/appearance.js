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

function updateGridColumns(cols, force) {
  // BUG-016: rAF 节流，避免 input 事件每帧触发 Grid layout 重算
  if (!force && updateGridColumns._pending) return;
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
    var w = parseInt(ws ? ws.value : 270, 10);
    var gap = 16;

    // 统计当前可见卡片数（排除 + 按钮）
    var cards = grid.querySelectorAll('.speeddial-card:not(.card-add)');
    var cardCount = cards.length;
    var usedCols = Math.max(1, Math.min(cardCount, cols));
    var idealWidth = usedCols * w + (usedCols - 1) * gap;
    var parentWidth = window.innerWidth;

    // 先彻底清理残留样式，再按模式设置
    grid.style.display = '';
    grid.style.gridTemplateColumns = '';
    grid.style.justifyItems = '';
    grid.style.justifyContent = '';
    grid.style.flexWrap = '';
    grid.style.width = '';
    grid.style.maxWidth = '';
    grid.style.marginLeft = '';
    grid.style.marginRight = '';
    grid.style.gap = '';
    grid.classList.remove('narrow-grid');

    if (cardCount > 0 && idealWidth < parentWidth) {
      // —— 宽屏模式：Grid + 精确宽度 + margin 居中 ——
      grid.style.display = 'grid';
      grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(' + w + 'px, 1fr))';
      grid.style.justifyItems = 'center';
      grid.style.justifyContent = 'center';
      grid.style.width = idealWidth + 'px';
      grid.style.marginLeft = 'auto';
      grid.style.marginRight = 'auto';
      grid.style.gap = gap + 'px';
    } else {
      // —— 窄屏 / 无卡片模式：Flexbox 自动换行，每行独立居中 ——
      grid.classList.add('narrow-grid');
      grid.style.display = 'flex';
      grid.style.flexWrap = 'wrap';
      grid.style.justifyContent = 'center';
      grid.style.gap = gap + 'px';
      grid.style.maxWidth = '100%';
      grid.style.setProperty('--card-width', w + 'px');
    }
  });
}

// 窗口 resize 时重算 Grid（处理窄↔宽切换），force 绕过节流
var _gridResizeTimer = 0;
window.addEventListener('resize', function () {
  if (_gridResizeTimer) clearTimeout(_gridResizeTimer);
  _gridResizeTimer = setTimeout(function () {
    _gridResizeTimer = 0;
    updateGridColumns(undefined, true);
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
    if (ws) ws.value = 270;
    if (wsv) wsv.textContent = '270px';
    if (hs) hs.value = 270;
    if (hsv) hsv.textContent = '270px';
    if (rs) rs.value = 14;
    if (rsv) rsv.textContent = '14px';
    if (os) os.value = 100;
    if (osv) osv.textContent = '100%';
    document.documentElement.style.setProperty('--card-width', '270px');
    document.documentElement.style.setProperty('--card-height', '270px');
    document.documentElement.style.setProperty('--card-radius', '14px');
    document.documentElement.style.setProperty('--card-opacity', '1');
    updateGridColumns();
  });

  var resetTopbar = document.getElementById('btn-reset-topbar');
  if (resetTopbar) resetTopbar.addEventListener('click', function () {
    var bc = document.getElementById('setting-bg-color');
    var tc = document.getElementById('setting-card-text-color');
    if (bc) bc.value = '';
    if (tc) tc.value = '';
    if (fs) fs.value = 13;
    if (fsv) fsv.textContent = '13px';
    document.documentElement.style.removeProperty('--topbar-bg');
    document.documentElement.style.removeProperty('--bg-primary');
    document.documentElement.style.removeProperty('--topbar-text');
    document.documentElement.style.removeProperty('--text-on-card');
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
    var appearanceEls = [dom.bgColor, dom.cardBgColor, dom.cardTextColor, dom.cardFontSize, dom.cardWidth, dom.cardHeight, dom.columnsSlider, dom.cardBorderRadius, dom.cardOpacity];
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
  if (dom.cardOpacity) dom.cardOpacity.value = settings.cardOpacity != null ? settings.cardOpacity : 100;
  if (dom.cardOpacityVal) dom.cardOpacityVal.textContent = (settings.cardOpacity != null ? settings.cardOpacity : 100) + '%';
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
