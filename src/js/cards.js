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

    html += '\n      <div class="speeddial-card"\n           draggable="true"\n           data-index="' + index + '"\n           data-id="' + card.id + '"\n           data-url="' + escapeHtml(card.url) + '"\n           ' + (isLocal ? 'data-local-img="' + card.image + '"' : '') + '\n           title="' + escapeHtml(card.name) + ' — ' + escapeHtml(card.url) + '">\n        ' + ((showIcon || showTitle) ? '\n        <div class="card-header">\n          ' + (showIcon ? '<img class="card-header-icon" src="' + headerIconSrc + '" alt=""' + (isLocal ? ' data-local="1"' : '') + ' onerror="this.style.display=\'none\'">' : '') + '\n          ' + (showTitle ? '<span class="card-header-title">' + escapeHtml(card.name) + '</span>' : '') + '\n        </div>' : '') + '\n        <div class="card-thumb">\n          ' + (hasCustomImage ? '\n            <img class="card-thumb-img" src="' + (isLocal ? '' : imgSrc) + '" alt="' + escapeHtml(card.name) + '" loading="lazy"\n                 ' + (isLocal ? 'data-local="1"' : '') + '>\n          ' : '\n            <img class="card-favicon-center" src="' + (imgSrc || 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(card.url) + '&sz=64') + '" alt="' + escapeHtml(card.name) + '" loading="lazy"\n                 onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">\n            <div class="card-fallback" style="display:none;background:' + bgColor + ';">' + firstChar + '</div>\n          ') + '\n        </div>\n        <div class="card-actions">\n          <button class="btn-card-edit" data-action="edit" data-id="' + card.id + '" title="编辑">✎</button>\n          <button class="btn-card-delete" data-action="delete" data-id="' + card.id + '" title="删除">✕</button>\n        </div>\n      </div>';
  });

  var showAdd = (!currentSettings || currentSettings.showAddButton !== false) && !isLocked;
  if (showAdd) {
    html += '\n      <div class="speeddial-card card-add" data-action="add" title="添加快捷方式（Ctrl+N）">\n        <span class="card-add-icon">+</span>\n      </div>';
  }

  domMain.grid.innerHTML = html;

  if (speeddials.length === 0 && !showAdd) {
    domMain.grid.innerHTML = '<div class="empty-state"><p>📌 还没有快捷方式</p><p class="empty-hint">打开设置面板，开启「+ 添加按钮」来添加快捷导航</p></div>';
  }

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

/** Favicon 加载失败 → 显示兜底文字 */
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
}

/* ==================== 卡片 CRUD ==================== */
async function addSpeeddial(name, url, image) {
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
