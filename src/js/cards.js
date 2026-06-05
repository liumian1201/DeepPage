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

/** v1.0.9: 为旧卡片补全 visitCount / createdAt 字段 */
function migrateCardFields() {
  var changed = false;
  for (var gi = 0; gi < groups.length; gi++) {
    var cards = groups[gi].cards || [];
    for (var ci = 0; ci < cards.length; ci++) {
      var card = cards[ci];
      if (card.visitCount === undefined) { card.visitCount = 0; changed = true; }
      if (card.createdAt === undefined) { card.createdAt = 0; changed = true; }
    }
  }
  if (changed) {
    saveGroups(groups);
  }
}

/* ==================== 卡片排序（v1.0.9） ==================== */
function getSortedCards(cards, sortMode) {
  if (!sortMode || sortMode === 'manual') return cards;
  var sorted = cards.slice();
  switch (sortMode) {
    case 'time-asc':   return sorted.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    case 'time-desc':  return sorted.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    case 'visits-asc':  return sorted.sort(function (a, b) { return (a.visitCount || 0) - (b.visitCount || 0); });
    case 'visits-desc': return sorted.sort(function (a, b) { return (b.visitCount || 0) - (a.visitCount || 0); });
    default: return cards;
  }
}

/* ==================== 卡片渲染 ==================== */
function renderSpeeddials() {
  if (!domMain.grid) return;

  var cols = (currentSettings && currentSettings.columns) ? currentSettings.columns : 5;
  if (typeof updateGridColumns === 'function') {
    updateGridColumns(cols);
  }

  var sortMode = (groups[activeGroupIndex] && groups[activeGroupIndex].sortMode) ? groups[activeGroupIndex].sortMode : 'manual';
  var displayCards = getSortedCards(speeddials, sortMode);

  var html = '';

  displayCards.forEach((card, index) => {
    const hasCustomImage = card.image && card.image.trim();
    const isLocal = hasCustomImage && card.image.startsWith('idx:');
    const imgSrc = isLocal ? '' : (hasCustomImage ? escapeHtml(card.image.trim()) : '');
    const showTitle = !currentSettings || currentSettings.showCardTitle !== false;
    const firstChar = (card.name || '?').charAt(0).toUpperCase();
    const bgColor = card.color || stringToColor(card.url || card.name);
    const showCounter = currentSettings && currentSettings.showVisitCount === true;
    const visitCount = card.visitCount || 0;
    const pureText = currentSettings && currentSettings.pureTextCards === true;

    // 顶部信息栏：标题 + 计数（v1.1.0: 移除图标）
    var topBarHtml = '';
    if (showTitle || showCounter) {
      topBarHtml = '<div class="card-top-bar">';
      if (showTitle) {
        topBarHtml += '<span class="card-top-title">' + escapeHtml(card.name) + '</span>';
      }
      if (showCounter) {
        topBarHtml += '<span class="card-top-counter">👁 ' + visitCount + '</span>';
      }
      topBarHtml += '</div>';
    }

    if (pureText) {
      html += '\n      <div class="card-wrapper"\n           data-index="' + index + '"\n           data-id="' + card.id + '"\n           data-url="' + escapeHtml(card.url) + '"\n           title="' + escapeHtml(card.name) + ' — ' + escapeHtml(card.url) + '">\n        ' + topBarHtml + '\n        <div class="speeddial-card card-pure-text" draggable="true">\n          <div class="card-pure-text-inner" style="background:' + bgColor + ';">\n            <span class="card-pure-text-char">' + firstChar + '</span>\n            <span class="card-pure-text-name">' + escapeHtml(card.name) + '</span>\n          </div>\n          <div class="card-actions">\n            <button class="btn-card-edit" data-action="edit" data-id="' + card.id + '" title="编辑">✎</button>\n            <button class="btn-card-delete" data-action="delete" data-id="' + card.id + '" title="删除">✕</button>\n          </div>\n        </div>\n      </div>';
      return;
    }

    html += '\n      <div class="card-wrapper"\n           data-index="' + index + '"\n           data-id="' + card.id + '"\n           data-url="' + escapeHtml(card.url) + '"\n           ' + (isLocal ? 'data-local-img="' + card.image + '"' : '') + '\n           title="' + escapeHtml(card.name) + ' — ' + escapeHtml(card.url) + '">\n        ' + topBarHtml + '\n        <div class="speeddial-card" draggable="true">\n          <div class="card-thumb">\n            ' + (hasCustomImage ? '\n              <img class="card-thumb-img" src="' + (isLocal ? '' : imgSrc) + '" alt="' + escapeHtml(card.name) + '" loading="lazy"\n                   ' + (isLocal ? 'data-local="1"' : '') + '>\n            ' : '\n              <div class="card-fallback" style="background:' + bgColor + ';">' + firstChar + '</div>\n            ') + '\n          </div>\n          <div class="card-actions">\n            <button class="btn-card-edit" data-action="edit" data-id="' + card.id + '" title="编辑">✎</button>\n            <button class="btn-card-delete" data-action="delete" data-id="' + card.id + '" title="删除">✕</button>\n          </div>\n        </div>\n      </div>';
  });

  var showAdd = (!currentSettings || currentSettings.showAddButton !== false) && !isLocked;
  if (showAdd) {
    html += '\n      <div class="card-wrapper card-wrapper-add">\n        <div class="speeddial-card card-add" data-action="add" title="添加快捷方式（Alt+N）">\n          <span class="card-add-icon">+</span>\n        </div>\n      </div>';
  }

  domMain.grid.innerHTML = html;

  if (speeddials.length === 0 && !showAdd) {
    domMain.grid.innerHTML = '<div class="empty-state"><p>📌 还没有快捷方式</p><p class="empty-hint">打开设置面板，开启「+ 添加按钮」来添加快捷导航</p></div>';
  }

  domMain.grid.classList.add('rendered');

  loadLocalCardImages();
  bindDragEvents();
}

/** 加载卡片中的本地 IndexedDB 图片 */
async function loadLocalCardImages() {
  // BUG-009: for...of 串行加载，避免 IndexedDB 并发风暴 + 异常静默丢失
  var imgs = domMain.grid.querySelectorAll('img[data-local="1"]');
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i];
    try {
      var wrapper = img.closest('.card-wrapper');
      var key = wrapper ? wrapper.dataset.localImg : null;
      if (!key) {
        var card = img.closest('.speeddial-card');
        var w2 = card ? card.parentElement : null;
        key = w2 && w2.classList.contains('card-wrapper') ? w2.dataset.localImg : null;
      }
      if (!key) continue;
      key = key.replace('idx:', '');
      var blob = await loadImage(key);
      if (blob) {
        if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
        img.src = URL.createObjectURL(blob);
      } else {
        var wrapper2 = img.closest('.card-wrapper');
        if (wrapper2) {
          var cid = wrapper2.dataset.id;
          for (var gi = 0; gi < groups.length; gi++) {
            var gcards = groups[gi].cards || [];
            for (var ci = 0; ci < gcards.length; ci++) {
              if (gcards[ci].id === cid && gcards[ci].image && gcards[ci].image.startsWith('idx:')) {
                gcards[ci].image = '';
                if (typeof saveGroups === 'function') saveGroups(groups);
                break;
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('本地图片加载失败:', img, e);
    }
  }
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
  speeddials.push({ id, name, url, image: image || '', color: stringToColor(url), visitCount: 0, createdAt: Date.now() });
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

  // v1.0.9: 异步检查 idx 引用是否有效（不阻塞对话框打开）
  if (card.image && card.image.startsWith('idx:') && typeof loadImage === 'function') {
    var imgKey = card.image.replace('idx:', '');
    loadImage(imgKey).then(function (blob) {
      if (!blob) {
        card.image = '';
        domMain.dialogImage.value = '';
        showToast('自定义图片数据已丢失，已切换为自动图标', 'warning');
      }
    });
  }
}

function closeDialog() {
  domMain.dialog.classList.add('hidden');
  editingId = null;
}

/* ==================== 网页截图（v1.1.5） ==================== */

async function refreshCardCapture(cardId) {
  var card = speeddials.find(function (c) { return c.id === cardId; });
  if (!card || !card.url) { showToast('卡片无效', 'error'); return; }
  showToast('正在截取 ' + card.name + ' ...', 'info');

  chrome.runtime.sendMessage({ type: 'capture-screenshot', url: card.url }, async function (resp) {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      showToast('截图失败: ' + ((resp && resp.error) || 'unknown'), 'error');
      return;
    }
    var parts = resp.dataUrl.split(',');
    var byteStr = atob(parts.length > 1 ? parts[1] : parts[0]);
    var bytes = new Uint8Array(byteStr.length);
    for (var i = 0; i < byteStr.length; i++) { bytes[i] = byteStr.charCodeAt(i); }
    var blob = new Blob([bytes], { type: 'image/png' });
    var key = 'cardimg_' + cardId;
    await saveImage(key, blob);

    // 仅更新当前活动分组的卡片（避免跨组覆盖同 ID 但不同 URL 的卡片）
    var latestGroups = await getGroups();
    var gcards = (latestGroups[activeGroupIndex] && latestGroups[activeGroupIndex].cards) || [];
    var found = false;
    for (var ci = 0; ci < gcards.length; ci++) {
      if (gcards[ci].id === cardId) {
        gcards[ci].image = 'idx:' + key;
        speeddials = gcards;
        found = true;
        break;
      }
    }
    if (found) {
      groups = latestGroups;
      await saveGroups(groups);
      renderSpeeddials();
      if (typeof updateImageDBInfo === 'function') updateImageDBInfo();
      showToast('截图已更新', 'success');
    } else {
      // 卡片已被删除
      showToast('截图完成但卡片已被删除', 'warning');
    }
  });
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

  // idx: 引用若 IndexedDB 中 blob 已丢失（如重置后导入），清除引用
  if (image && image.startsWith('idx:')) {
    var key = image.replace('idx:', '');
    if (typeof loadImage === 'function') {
      var blob = await loadImage(key);
      if (!blob) {
        image = '';
        showToast('自定义图片数据已丢失，已切换为自动图标', 'warning');
      }
    }
  }

  if (editingId) {
    // 编辑时清理旧缓存（仅当图片被更换为新值时）
    if (typeof deleteCardIcon === 'function') {
      var oldCard = speeddials.find(function (c) { return c.id === editingId; });
      if (oldCard && oldCard.image && oldCard.image.startsWith('idx:') && oldCard.image !== image) {
        deleteCardIcon(editingId);
      }
    }
    await editSpeeddial(editingId, name, url, image);
  } else {
    await addSpeeddial(name, url, image);
  }

  closeDialog();
}

/* ==================== 访问计数（v1.0.9） ==================== */

/** 对指定卡片访问计数 +1，自动保存并重渲染当前分组 */
async function incrementVisitCount(cardId, render) {
  if (render === undefined) render = true;
  // 仅更新当前活动分组（避免跨组重复 ID 计数到错误卡片）
  var cards = groups[activeGroupIndex] ? (groups[activeGroupIndex].cards || []) : [];
  for (var ci = 0; ci < cards.length; ci++) {
    if (cards[ci].id === cardId) {
      cards[ci].visitCount = (cards[ci].visitCount || 0) + 1;
      await saveGroups(groups);
      speeddials = cards;
      if (render) renderSpeeddials();
      return;
    }
  }
}

/* ==================== 卡片点击跳转 ==================== */
function openCard(index) {
  const card = speeddials[index];
  if (card && card.url) {
    incrementVisitCount(card.id);
    window.location.href = card.url;
  }
}
