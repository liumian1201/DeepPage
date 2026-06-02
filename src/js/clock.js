/* ============================================================
   clock.js — 数字时钟组件
   ============================================================ */

function updateClock() {
  var clockEl = document.querySelector('.clock-time');
  var secondsEl = document.querySelector('.clock-seconds');
  var dateEl = document.querySelector('.clock-date');
  var now = new Date();

  var fmt = (currentSettings && currentSettings.clockFormat === '12h') ? 12 : 24;
  var h = fmt === 12 ? (now.getHours() % 12 || 12) : now.getHours();
  var hh = String(h).padStart(2, '0');
  var mm = String(now.getMinutes()).padStart(2, '0');
  var ss = String(now.getSeconds()).padStart(2, '0');
  if (clockEl) clockEl.textContent = hh + ':' + mm;
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
