/* ============================================================
   dragdrop.js — 卡片拖拽排序（鼠标事件实现）
   ============================================================ */

var dragCard = null;
var dragClone = null;
var dragStartX = 0;
var dragStartY = 0;
var dragOrigIndex = -1;

function bindDragEvents() {
  if (isLocked) return;
  domMain.grid.addEventListener('mousedown', onMouseDown);
}

/** 拖拽中拦截滚轮，防止触发分组切换 */
function blockWheelDuringDrag(e) {
  e.preventDefault();
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  if (isLocked) return;
  if (e.target.closest('.card-actions') || e.target.closest('button')) return;
  var card = e.target.closest('.speeddial-card:not(.card-add)');
  if (!card) return;

  dragCard = card;
  dragOrigIndex = parseInt(card.dataset.index, 10);
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  // 按下即拦截滚轮，防止分组切换破坏 DOM
  document.addEventListener('wheel', blockWheelDuringDrag, { passive: false });
  e.preventDefault();
}

document.addEventListener('mousemove', function (e) {
  if (!dragCard) return;

  var dx = e.clientX - dragStartX;
  var dy = e.clientY - dragStartY;
  if (!dragClone && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;

  if (!dragClone) {
    dragCard.classList.add('dragging');
    dragClone = dragCard.cloneNode(true);
    dragClone.style.position = 'fixed';
    dragClone.style.zIndex = '999';
    dragClone.style.pointerEvents = 'none';
    dragClone.style.opacity = '0.85';
    dragClone.style.width = dragCard.offsetWidth + 'px';
    dragClone.style.height = dragCard.offsetHeight + 'px';
    dragClone.style.transform = 'scale(1.05)';
    dragClone.style.boxShadow = '0 8px 30px rgba(0,0,0,0.3)';
    document.body.appendChild(dragClone);
  }

  dragClone.style.left = (e.clientX - 80) + 'px';
  dragClone.style.top = (e.clientY - 40) + 'px';

  highlightDropTarget(e);
});

document.addEventListener('mouseup', function (e) {
  document.removeEventListener('wheel', blockWheelDuringDrag);
  if (!dragCard) return;
  if (!dragClone) { dragCard = null; return; }

  // 标记拖拽过，阻止后续 click 误触发打开卡片
  window._justDragged = Date.now();

  dragCard.classList.remove('dragging');
  dragClone.parentNode.removeChild(dragClone);
  dragClone = null;
  domMain.grid.querySelectorAll('.drag-over').forEach(function (el) { el.classList.remove('drag-over'); });

  var targetCard = getTargetCard(e);
  if (!targetCard) { dragCard = null; return; }

  var targetIndex = parseInt(targetCard.dataset.index, 10);
  if (targetIndex === dragOrigIndex) { dragCard = null; return; }

  var rect = targetCard.getBoundingClientRect();
  var midX = rect.left + rect.width / 2;
  var to = e.clientX < midX ? targetIndex : targetIndex + 1;
  if (dragOrigIndex < to) to--;
  if (to < 0) to = 0;
  if (to >= speeddials.length) to = speeddials.length;
  if (to === dragOrigIndex) { dragCard = null; return; }

  doReorder(dragOrigIndex, to);
  dragCard = null;
});

function getTargetCard(e) {
  if (dragClone) dragClone.style.display = 'none';
  var el = document.elementFromPoint(e.clientX, e.clientY);
  if (dragClone) dragClone.style.display = '';
  var card = el ? el.closest('.speeddial-card:not(.card-add)') : null;
  if (!card) {
    var cards = Array.from(domMain.grid.querySelectorAll('.speeddial-card:not(.card-add)'));
    var best = null, bestD = Infinity;
    cards.forEach(function (c) {
      var r = c.getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var d = (e.clientX - cx) * (e.clientX - cx) + (e.clientY - cy) * (e.clientY - cy);
      if (d < bestD) { bestD = d; best = c; }
    });
    return best;
  }
  return card;
}

function highlightDropTarget(e) {
  domMain.grid.querySelectorAll('.drag-over').forEach(function (el) { el.classList.remove('drag-over'); });
  var target = getTargetCard(e);
  if (target && parseInt(target.dataset.index, 10) !== dragOrigIndex) {
    target.classList.add('drag-over');
  }
}

async function doReorder(from, to) {
  var moved = speeddials.splice(from, 1)[0];
  speeddials.splice(to, 0, moved);
  await saveSpeeddials(speeddials);
  renderSpeeddials();
}
