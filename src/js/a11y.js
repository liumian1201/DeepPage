/* ============================================================
   a11y.js — 无障碍增强（v1.3.3）
   1) 弹窗/面板焦点管理：打开时把焦点移入，关闭时归还给打开前的元素
   2) 纯图标按钮：把 title 补成 aria-label（屏幕阅读器更可靠）
   3) 设置面板 tab：保持 aria-selected 与实际选中同步
   4) 分组指示器：补 role/aria-label（原本是纯 div 点击）
   静态结构标注（role="dialog"/aria-modal/aria-labelledby 等）在 index.html 中
   ============================================================ */

var _a11yFocusReturn = [];   // 打开弹窗前聚焦的元素栈
var _a11yFocusHistory = [];  // document 级焦点历史（focusin）

/**
 * 记录焦点历史：不能只在 MutationObserver 回调里读 activeElement ——
 * 各 open* 函数通常是「先移除 .hidden，再同步 focus 到弹窗输入框」，
 * 而 MutationObserver 是微任务，回调时焦点已在弹窗内部，会记错归还目标。
 */
function _a11yTrackFocus() {
  document.addEventListener('focusin', function (e) {
    if (!e.target || e.target === document.body) return;
    _a11yFocusHistory.push(e.target);
    if (_a11yFocusHistory.length > 20) _a11yFocusHistory.shift();
  }, true);
}

/** 回溯最近一个「不在该弹窗内」的焦点元素，作为关闭后的归还目标 */
function _a11yLastOutsideFocus(overlayEl) {
  for (var i = _a11yFocusHistory.length - 1; i >= 0; i--) {
    var el = _a11yFocusHistory[i];
    if (!el || !document.contains(el)) continue;
    if (overlayEl && overlayEl.contains(el)) continue;
    return el;
  }
  return null;
}

/** 可聚焦元素选择器 */
var _FOCUSABLE = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function _a11yFocusableIn(root) {
  return Array.prototype.filter.call(root.querySelectorAll(_FOCUSABLE), function (el) {
    return el.offsetParent !== null || el === document.activeElement;
  });
}

/** 弹窗显示：记住打开前的焦点并把焦点移入（优先首个输入框，其次首个可聚焦元素） */
function _a11yOnOverlayShown(el) {
  var back = _a11yLastOutsideFocus(el);
  if (back) _a11yFocusReturn.push(back);
  // 进度类弹窗（无输入）不抢焦点，避免打断朗读
  if (el.getAttribute('data-no-autofocus') === 'true') return;
  setTimeout(function () {
    if (el.classList.contains('hidden')) return;
    if (el.contains(document.activeElement)) return; // 打开函数已自行聚焦，不再干预
    var target = el.querySelector('input:not([type="hidden"]):not([disabled]), textarea, select') || _a11yFocusableIn(el)[0];
    if (target && typeof target.focus === 'function') target.focus();
  }, 0);
}

/** 弹窗关闭：焦点归还给打开前的元素 */
function _a11yOnOverlayHidden() {
  var back = _a11yFocusReturn.pop();
  if (back && document.contains(back) && typeof back.focus === 'function') {
    setTimeout(function () { back.focus(); }, 0);
  }
}

/** 监听所有弹窗/面板的显示与隐藏（无需改动各 open/close 函数） */
function _a11yWatchOverlays() {
  var overlays = document.querySelectorAll('.dialog-overlay, #settings-panel');
  Array.prototype.forEach.call(overlays, function (el) {
    var wasHidden = el.classList.contains('hidden');
    new MutationObserver(function () {
      var isHidden = el.classList.contains('hidden');
      if (wasHidden === isHidden) return;
      wasHidden = isHidden;
      if (isHidden) _a11yOnOverlayHidden();
      else _a11yOnOverlayShown(el);
    }).observe(el, { attributes: true, attributeFilter: ['class'] });
  });
}

/** 纯图标按钮（无可见文字）用 title 补 aria-label */
function _a11yLabelIconButtons() {
  var btns = document.querySelectorAll('button, [role="button"]');
  Array.prototype.forEach.call(btns, function (btn) {
    if (btn.getAttribute('aria-label')) return;
    var text = (btn.textContent || '').replace(/[\s\u200b]/g, '');
    if (text.length > 1) return;                 // 有可见文字的不动
    if (/[\u4e00-\u9fa5A-Za-z0-9]/.test(text)) return;  // 「是」「否」这类短文本是有意义的，不动
    var title = btn.getAttribute('title');
    if (title) btn.setAttribute('aria-label', title);
  });
}

/** 设置面板 tab：点击后同步 aria-selected */
function _a11yBindTabs() {
  var tabs = document.querySelectorAll('.settings-tabs .tab-btn');
  Array.prototype.forEach.call(tabs, function (tab) {
    tab.addEventListener('click', function () {
      Array.prototype.forEach.call(tabs, function (t) {
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
    });
  });
}

/** 分组指示器：把纯 div 的点击目标补上按钮语义 */
function _a11yLabelGroupDots() {
  var dots = document.querySelectorAll('#group-dots .group-tab, #group-dots .group-dot, #group-indicator .group-tab, #group-indicator .group-dot');
  Array.prototype.forEach.call(dots, function (dot, i) {
    dot.setAttribute('role', 'button');
    dot.setAttribute('tabindex', '0');
    if (!dot.getAttribute('aria-label')) {
      dot.setAttribute('aria-label', (dot.getAttribute('title') || dot.textContent || ('分组 ' + (i + 1))).trim());
    }
    if (dot.classList.contains('active')) dot.setAttribute('aria-current', 'true');
    else dot.removeAttribute('aria-current');
  });
}

/** Toast 容器：屏幕阅读器播报 */
function _a11yEnsureToastLiveRegion() {
  var container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  if (!container.getAttribute('role')) {
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'false');
  }
}

function initA11y() {
  _a11yTrackFocus();
  _a11yWatchOverlays();
  _a11yLabelIconButtons();
  _a11yBindTabs();
  _a11yEnsureToastLiveRegion();
  // 分组圆点是动态渲染的，跟随渲染补语义
  _a11yLabelGroupDots();
  var dotsRoot = document.getElementById('group-dots') || document.getElementById('group-indicator');
  if (dotsRoot && window.MutationObserver) {
    new MutationObserver(function () { _a11yLabelGroupDots(); })
      .observe(dotsRoot, { childList: true, subtree: true });
  }
}
