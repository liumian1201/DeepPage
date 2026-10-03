/* ============================================================
   clock.js — 数字时钟组件
   ============================================================ */

function updateClock() {
  var clockEl = document.querySelector('.clock-time');
  var secondsEl = document.querySelector('.clock-seconds');
  var dateEl = document.querySelector('.clock-date');
  var periodEl = document.querySelector('.clock-period');
  var now = new Date();

  var fmt = (currentSettings && currentSettings.clockFormat === '12h') ? 12 : 24;
  var is12 = fmt === 12;
  var h = is12 ? (now.getHours() % 12 || 12) : now.getHours();
  var hh = String(h).padStart(2, '0');
  var mm = String(now.getMinutes()).padStart(2, '0');
  var ss = String(now.getSeconds()).padStart(2, '0');
  if (clockEl) clockEl.textContent = hh + ':' + mm;
  // BUG-069：12 小时制必须带午别 —— 否则 13:45 显示成 01:45，与凌晨 01:45 逐字节相同（差 12 小时的歧义）
  if (periodEl) {
    periodEl.textContent = is12 ? (now.getHours() < 12 ? '上午' : '下午') : '';
    periodEl.style.display = is12 ? '' : 'none';
  }
  if (secondsEl) {
    secondsEl.style.display = (currentSettings && currentSettings.clockShowSeconds === false) ? 'none' : '';
    secondsEl.textContent = ':' + ss;
  }

  var weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  var y = now.getFullYear();
  var M = String(now.getMonth() + 1).padStart(2, '0');
  var d = String(now.getDate()).padStart(2, '0');
  var w = weekdays[now.getDay()];
  if (dateEl) dateEl.textContent = y + '年' + M + '月' + d + '日 星期' + w;
}

function initClock() {
  updateClock();
  setInterval(updateClock, 1000);
}
