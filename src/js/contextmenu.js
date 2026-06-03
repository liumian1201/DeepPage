/* ============================================================
   contextmenu.js — 右键上下文菜单
   ============================================================ */

let contextCardId = null;

function initContextMenu() {
  document.addEventListener('contextmenu', function (e) {
    if (!e.target.closest('.container')) return;
    // 设置面板、弹窗内不拦截右键，交给浏览器
    if (e.target.closest('.settings-panel') || e.target.closest('.dialog-overlay')) return;

    var cardEl = e.target.closest('.speeddial-card:not(.card-add)');
    if (cardEl) {
      e.preventDefault();
      var wrapper = cardEl.closest('.card-wrapper');
      contextCardId = wrapper ? wrapper.dataset.id : cardEl.dataset.id;
      showContextMenu(e.clientX, e.clientY, 'card');
      return;
    }
    e.preventDefault();
    contextCardId = null;
    showContextMenu(e.clientX, e.clientY, 'grid');
  });

  // BUG-017: 一次性绑定 moveToGroup 悬停，避免每次右键重建匿名函数
  var moveItem = domMain.contextMenu.querySelector('[data-action="moveToGroup"]');
  var sub = document.getElementById('move-group-sub');
  if (moveItem) {
    moveItem.addEventListener('mouseenter', showMoveSubmenu);
  }
  if (sub) {
    sub.addEventListener('mouseenter', function () { sub.classList.remove('hidden'); });
    sub.addEventListener('mouseleave', hideMoveSubmenu);
  }

  domMain.contextMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.context-menu-item');
    if (!item) return;
    const action = item.dataset.action;
    handleContextAction(action, item.dataset);
    hideContextMenu();
  });

  document.addEventListener('click', (e) => {
    if (!domMain.contextMenu.contains(e.target) && !e.target.closest('#move-group-sub')) {
      hideContextMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
  });

  window.addEventListener('scroll', hideContextMenu, true);
  window.addEventListener('resize', hideContextMenu);
}

function showContextMenu(x, y, source) {
  const menu = domMain.contextMenu;
  const items = menu.querySelectorAll('.context-menu-item');
  const seps = menu.querySelectorAll('.context-menu-separator');

  items.forEach((item) => {
    const action = item.dataset.action;
    if (source === 'card') {
      var allowed = ['open', 'copyurl', 'edit', 'moveToGroup', 'delete'];
      if (action === 'lock' || action === 'unlock') {
        item.classList.toggle('hidden', true);
      } else {
        item.classList.toggle('hidden', !allowed.includes(action));
        if (isLocked && (action === 'edit' || action === 'delete' || action === 'moveToGroup')) {
          item.classList.add('hidden');
        }
        // 移动到分组：仅多分组时显示
        if (action === 'moveToGroup' && (!groups || groups.length <= 1)) {
          item.classList.add('hidden');
        }
      }
    } else {
      var gridAllowed = ['add', 'refresh', 'nextWallpaper', 'settings', 'lock', 'unlock'];
      item.classList.toggle('hidden', !gridAllowed.includes(action));
      if (action === 'lock') item.classList.toggle('hidden', isLocked);
      if (action === 'unlock') item.classList.toggle('hidden', !isLocked);
      if (isLocked && action === 'add') item.classList.toggle('hidden', true);
      if (!isLocked && action === 'add') item.classList.toggle('hidden', false);
    }
  });

  seps.forEach(function (sep, i) {
    if (source === 'card') {
      sep.classList.add('hidden');
    } else {
      // grid: 隐藏顶部和底部分隔线，仅保留 添加/刷新/设置 与 锁定/解锁 之间的
      sep.classList.toggle('hidden', i !== 1);
    }
  });

  let posX = x;
  let posY = y;
  const menuW = menu.offsetWidth || 180;
  const menuH = menu.offsetHeight || 160;

  if (posX + menuW > window.innerWidth) posX = window.innerWidth - menuW - 8;
  if (posY + menuH > window.innerHeight) posY = window.innerHeight - menuH - 8;

  menu.style.left = posX + 'px';
  menu.style.top = posY + 'px';
  menu.classList.remove('hidden');

  // 构建移动到分组子菜单数据（不立即显示）
  if (source === 'card' && groups && groups.length > 1) {
    buildMoveSubmenu();
  } else {
    hideMoveSubmenu();
  }
}

function buildMoveSubmenu() {
  var sub = document.getElementById('move-group-sub');
  if (!sub) return;
  var html = '';
  groups.forEach(function (g, i) {
    if (i === activeGroupIndex) return;
    html += '<div class="context-menu-item" data-group="' + i + '">📂 ' + escapeHtml(g.name) + '</div>';
  });
  sub.innerHTML = html;
  sub.querySelectorAll('.context-menu-item').forEach(function (item) {
    item.addEventListener('click', function (e) {
      e.stopPropagation();
      var targetIdx = parseInt(this.dataset.group, 10);
      handleMoveToGroup(targetIdx);
    });
  });
  // BUG-017: hover 绑定已移至 initContextMenu，此处不再重建
}

function hideContextMenu() {
  domMain.contextMenu.classList.add('hidden');
  hideMoveSubmenu();
  contextCardId = null;
}

/** 显示移动到分组子菜单 */
function showMoveSubmenu() {
  var sub = document.getElementById('move-group-sub');
  if (!sub || !sub.children.length) return;
  var menuRect = domMain.contextMenu.getBoundingClientRect();
  var itemRect = domMain.contextMenu.querySelector('[data-action="moveToGroup"]').getBoundingClientRect();
  var subX = menuRect.right + 4;
  var subY = itemRect.top;
  if (subX + 140 > window.innerWidth) subX = menuRect.left - 144;
  sub.style.left = subX + 'px';
  sub.style.top = subY + 'px';
  sub.classList.remove('hidden');
}

function hideMoveSubmenu() {
  var sub = document.getElementById('move-group-sub');
  if (sub) sub.classList.add('hidden');
}

async function handleMoveToGroup(targetIdx) {
  if (!contextCardId || targetIdx === activeGroupIndex) return;
  var card = speeddials.find(function (c) { return c.id === contextCardId; });
  if (!card) return;
  // 从当前组移除
  speeddials = speeddials.filter(function (c) { return c.id !== contextCardId; });
  groups[activeGroupIndex].cards = speeddials;
  // 加入目标组
  if (!groups[targetIdx].cards) groups[targetIdx].cards = [];
  groups[targetIdx].cards.push(card);
  await saveGroups(groups);
  renderSpeeddials();
  hideContextMenu();
  if (typeof showToast === 'function') showToast('已移动到「' + groups[targetIdx].name + '」', 'success');
}

function handleContextAction(action, ds) {
  ds = ds || {};
  switch (action) {
    case 'open':
      if (contextCardId) {
        const card = speeddials.find((c) => c.id === contextCardId);
        if (card) {
          if (typeof incrementVisitCount === 'function') incrementVisitCount(contextCardId);
          var mode = (typeof currentSettings !== 'undefined' && currentSettings) ? currentSettings.cardOpenMode : 'current';
          if (mode === 'foreground') {
            chrome.tabs.create({ url: card.url, active: true });
          } else if (mode === 'background') {
            chrome.tabs.create({ url: card.url, active: false });
          } else {
            window.location.href = card.url;
          }
        }
      }
      break;
    case 'copyurl':
      if (contextCardId) {
        var c = speeddials.find(function (x) { return x.id === contextCardId; });
        if (c && c.url) {
          navigator.clipboard.writeText(c.url).then(function () {
            showToast('已复制: ' + c.url, 'success');
          }).catch(function () {
            showToast('复制失败', 'error');
          });
        }
      }
      break;
    case 'edit':
      if (contextCardId) openEditDialog(contextCardId);
      break;
    case 'delete':
      if (contextCardId) handleDeleteClick(contextCardId);
      break;
    case 'add':
      openAddDialog();
      break;
    case 'refresh':
      window.location.reload();
      break;
    case 'nextWallpaper':
      if (typeof nextWallpaper === 'function') nextWallpaper();
      break;
    case 'settings':
      if (typeof openSettingsPanel === 'function') openSettingsPanel();
      break;
    case 'lock':
      setLocked(true);
      break;
    case 'unlock':
      setLocked(false);
      break;
    case 'groupRename':
      renameGroup(parseInt(ds.group, 10));
      break;
    case 'groupDelete':
      deleteGroup(parseInt(ds.group, 10));
      break;
  }
}
