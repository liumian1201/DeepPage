/* ============================================================
   cards.js — 快捷导航卡片渲染与 CRUD
   ============================================================ */

/** 自动缓存现有卡片的 URL 图标（v1.0.3 迁移） */
async function migrateCardIcons() {
  var changed = false;
  for (var gi = 0; gi < groups.length; gi++) {
    var cards = groups[gi].cards || [];
    for (var ci = 0; ci < cards.length; ci++) {
      var card = cards[ci];
      if (card.image && !card.image.startsWith('idx:') && /^https?:\/\//i.test(card.image)) {
        var cached = await cacheCardIcon(card.image, card.id);
        if (cached) {
          card.image = cached;
          changed = true;
        }
      }
    }
  }
  if (changed && typeof saveGroups === 'function') {
    await saveGroups(groups);
    if (typeof updateImageDBInfo === 'function') updateImageDBInfo();
  }
}

/* ==================== 卡片渲染 ==================== */
function renderSpeeddials() {
  if (!domMain.grid) return;

  var cols = (currentSettings && currentSettings.columns) ? currentSettings.columns : 5;
  if (typeof updateGridColumns === 'function') {
    updateGridColumns(cols);
  }

  var html = '';

  speeddials.forEach((card, index) => {
    const hasCustomImage = card.image && card.image.trim();
    const isLocal = hasCustomImage && card.image.startsWith('idx:');
    const imgSrc = isLocal ? '' : (hasCustomImage ? escapeHtml(card.image.trim()) : '');
    const faviconUrl = 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(card.url) + '&sz=32';
    const headerIconSrc = hasCustomImage ? imgSrc : faviconUrl;
    const firstChar = (card.name || '?').charAt(0).toUpperCase();
    const bgColor = card.color || stringToColor(card.url || card.name);
    const showIcon = !currentSettings || currentSettings.showCardIcon !== false;
    const showTitle = !currentSettings || currentSettings.showCardTitle !== false;
    const pureText = currentSettings && currentSettings.pureTextCards === true;

    if (pureText) {
      // v1.0.7: 极简纯色文字卡片 — 跳过所有图片加载
      html += '\n      <div class="speeddial-card card-pure-text"\n           draggable="true"\n           data-index="' + index + '"\n           data-id="' + card.id + '"\n           data-url="' + escapeHtml(card.url) + '"\n           title="' + escapeHtml(card.name) + ' — ' + escapeHtml(card.url) + '">\n        <div class="card-pure-text-inner" style="background:' + bgColor + ';">\n          <span class="card-pure-text-char">' + firstChar + '</span>\n          <span class="card-pure-text-name">' + escapeHtml(card.name) + '</span>\n        </div>\n        <div class="card-actions">\n          <button class="btn-card-edit" data-action="edit" data-id="' + card.id + '" title="编辑">✎</button>\n          <button class="btn-card-delete" data-action="delete" data-id="' + card.id + '" title="删除">✕</button>\n        </div>\n      </div>';
      return;
    }

    html += '\n      <div class="speeddial-card"\n           draggable="true"\n           data-index="' + index + '"\n           data-id="' + card.id + '"\n           data-url="' + escapeHtml(card.url) + '"\n           ' + (isLocal ? 'data-local-img="' + card.image + '"' : '') + '\n           title="' + escapeHtml(card.name) + ' — ' + escapeHtml(card.url) + '">\n        ' + ((showIcon || showTitle) ? '\n        <div class="card-header">\n          ' + (showIcon ? '<img class="card-header-icon" src="' + headerIconSrc + '" alt=""' + (isLocal ? ' data-local="1"' : '') + '>' : '') + '\n          ' + (showTitle ? '<span class="card-header-title">' + escapeHtml(card.name) + '</span>' : '') + '\n        </div>' : '') + '\n        <div class="card-thumb">\n          ' + (hasCustomImage ? '\n            <img class="card-thumb-img" src="' + (isLocal ? '' : imgSrc) + '" alt="' + escapeHtml(card.name) + '" loading="lazy"\n                 ' + (isLocal ? 'data-local="1"' : '') + '>\n          ' : '\n            <img class="card-favicon-center" src="' + (imgSrc || 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(card.url) + '&sz=64') + '" alt="' + escapeHtml(card.name) + '" loading="lazy">\n            <div class="card-fallback" style="display:none;background:' + bgColor + ';">' + firstChar + '</div>\n          ') + '\n        </div>\n        <div class="card-actions">\n          <button class="btn-card-edit" data-action="edit" data-id="' + card.id + '" title="编辑">✎</button>\n          <button class="btn-card-delete" data-action="delete" data-id="' + card.id + '" title="删除">✕</button>\n        </div>\n      </div>';
  });

  var showAdd = (!currentSettings || currentSettings.showAddButton !== false) && !isLocked;
  if (showAdd) {
    html += '\n      <div class="speeddial-card card-add" data-action="add" title="添加快捷方式（Ctrl+N）">\n        <span class="card-add-icon">+</span>\n      </div>';
  }

  domMain.grid.innerHTML = html;

  if (speeddials.length === 0 && !showAdd) {
    domMain.grid.innerHTML = '<div class="empty-state"><p>📌 还没有快捷方式</p><p class="empty-hint">打开设置面板，开启「+ 添加按钮」来添加快捷导航</p></div>';
  }

  domMain.grid.classList.add('rendered');

  loadLocalCardImages();
  bindDragEvents();
  bindFaviconErrors();
}

/** 加载卡片中的本地 IndexedDB 图片 */
async function loadLocalCardImages() {
  domMain.grid.querySelectorAll('img[data-local="1"]').forEach(async (img) => {
    var card = img.closest('.speeddial-card');
    var key = card ? card.dataset.localImg : null;
    if (!key) return;
    key = key.replace('idx:', '');
    var blob = await loadImage(key);
    if (blob) {
      if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(blob);
    }
  });
}

/** 图片加载失败处理（JS 监听替代 inline onerror，符合 CSP） */
function bindFaviconErrors() {
  domMain.grid.querySelectorAll('.card-favicon-center').forEach((img) => {
    img.addEventListener('error', function () {
      this.style.display = 'none';
      const fallback = this.nextElementSibling;
      if (fallback && fallback.classList.contains('card-fallback')) {
        fallback.style.display = 'flex';
      }
    });
  });
  domMain.grid.querySelectorAll('.card-header-icon').forEach((img) => {
    img.addEventListener('error', function () {
      this.style.display = 'none';
    });
  });
}

/* ==================== 卡片 CRUD ==================== */

/** v1.0.8: 检查 URL 域名是否已存在于任意分组，返回 { groupName, cardName } 或 null */
function findDuplicate(url) {
  try {
    var host = new URL(url).hostname.replace('www.', '');
    for (var gi = 0; gi < groups.length; gi++) {
      var cards = groups[gi].cards || [];
      for (var ci = 0; ci < cards.length; ci++) {
        try {
          if (new URL(cards[ci].url).hostname.replace('www.', '') === host) {
            return { groupName: groups[gi].name, cardName: cards[ci].name };
          }
        } catch (e) {}
      }
    }
  } catch (e) {}
  return null;
}

/** 显示重复卡片确认对话框，返回 Promise<boolean> */
function showDuplicateConfirm(name, url, dup) {
  return new Promise(function (resolve) {
    var dlg = document.getElementById('dialog-duplicate');
    var msg = document.getElementById('duplicate-msg');
    var okBtn = document.getElementById('duplicate-ok');
    var cancelBtn = document.getElementById('duplicate-cancel');
    if (!dlg) { resolve(true); return; }
    msg.textContent = '「' + name + '」(' + url + ') 已在「' + dup.groupName + '」分组中存在（' + dup.cardName + '），是否继续添加？';
    dlg.classList.remove('hidden');
    function cleanup() { dlg.classList.add('hidden'); }
    okBtn.onclick = function () { cleanup(); resolve(true); };
    cancelBtn.onclick = function () { cleanup(); resolve(false); };
    dlg.onclick = function (e) { if (e.target === dlg) { cleanup(); resolve(false); } };
  });
}

async function addSpeeddial(name, url, image) {
  var dup = findDuplicate(url);
  if (dup) {
    var proceed = await showDuplicateConfirm(name, url, dup);
    if (!proceed) return;
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  speeddials.push({ id, name, url, image: image || '', color: stringToColor(url) });
  await saveSpeeddials(speeddials);
  renderSpeeddials();
}

async function editSpeeddial(id, name, url, image) {
  const card = speeddials.find((c) => c.id === id);
  if (card) {
    card.name = name;
    card.url = url;
    card.image = image || '';
    card.color = stringToColor(url);
    await saveSpeeddials(speeddials);
    renderSpeeddials();
  }
}

async function deleteSpeeddialById(id) {
  var card = speeddials.find(function (c) { return c.id === id; });
  if (card && card.image && card.image.startsWith('idx:') && typeof deleteCardIcon === 'function') {
    deleteCardIcon(id);
  }
  speeddials = speeddials.filter((c) => c.id !== id);
  await saveSpeeddials(speeddials);
  renderSpeeddials();
}

/* ==================== 对话框 ==================== */
let editingId = null;

function openAddDialog() {
  editingId = null;
  domMain.dialogTitle.textContent = '添加快捷方式';
  domMain.dialogName.value = '';
  domMain.dialogUrl.value = '';
  domMain.dialogImage.value = '';
  domMain.dialog.classList.remove('hidden');
  if (domMain.dialogDelete) domMain.dialogDelete.classList.add('hidden');
  domMain.dialogName.focus();
}

function openEditDialog(id) {
  const card = speeddials.find((c) => c.id === id);
  if (!card) return;
  editingId = id;
  domMain.dialogTitle.textContent = '编辑快捷方式';
  domMain.dialogName.value = card.name;
  domMain.dialogUrl.value = card.url;
  domMain.dialogImage.value = card.image || '';
  domMain.dialog.classList.remove('hidden');
  if (domMain.dialogDelete) domMain.dialogDelete.classList.remove('hidden');
  domMain.dialogName.focus();
}

function closeDialog() {
  domMain.dialog.classList.add('hidden');
  editingId = null;
}

async function saveDialog() {
  const name = domMain.dialogName.value.trim();
  let url = domMain.dialogUrl.value.trim();
  let image = domMain.dialogImage.value.trim();

  if (!name || !url) {
    showToast('请填写网站名称和地址', 'warning');
    return;
  }

  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  // 图片 URL：下载并缓存到本地 IndexedDB
  if (image && !image.startsWith('idx:') && /^https?:\/\//i.test(image)) {
    var idForCache = editingId || ('new_' + Date.now());
    var cached = await cacheCardIcon(image, idForCache);
    if (cached) {
      image = cached;
      if (typeof updateImageDBInfo === 'function') updateImageDBInfo();
    }
  }

  if (editingId) {
    // 编辑时清理旧缓存
    if (typeof deleteCardIcon === 'function') {
      var oldCard = speeddials.find(function (c) { return c.id === editingId; });
      if (oldCard && oldCard.image && oldCard.image.startsWith('idx:')) {
        deleteCardIcon(editingId);
      }
    }
    await editSpeeddial(editingId, name, url, image);
  } else {
    await addSpeeddial(name, url, image);
  }

  closeDialog();
}

/* ==================== 卡片点击跳转 ==================== */
function openCard(index) {
  const card = speeddials[index];
  if (card && card.url) {
    window.location.href = card.url;
  }
}
