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

/* ==================== 渲染竞态防护 ==================== */
var _renderId = 0;

/* ==================== 图片 Blob URL 缓存层 ==================== */
var _cardBlobCache = {};

function _clearCardBlobCache(cardId) {
  var old = _cardBlobCache[cardId];
  if (old) {
    URL.revokeObjectURL(old);
    delete _cardBlobCache[cardId];
  }
}

function _clearAllBlobCaches() {
  Object.keys(_cardBlobCache).forEach(function (k) {
    URL.revokeObjectURL(_cardBlobCache[k]);
  });
  _cardBlobCache = {};
}

/** 获取卡片图片 URL（优先缓存，否则从 IndexedDB 加载并缓存） */
async function _getCardImgUrl(imgKey) {
  if (_cardBlobCache[imgKey]) return _cardBlobCache[imgKey];
  var blob = await loadImage(imgKey);
  if (blob) {
    var url = URL.createObjectURL(blob);
    _cardBlobCache[imgKey] = url;
    return url;
  }
  return null;
}

/* ==================== 截图主题色提取 ==================== */
function _extractThemeColorFromBlob(blob) {
  return new Promise(function (resolve) {
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement('canvas');
      var w = Math.min(img.width, 200);
      var h = Math.round(img.height * (w / img.width));
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      var data = ctx.getImageData(0, 0, w, h).data;
      var r = 0, g = 0, b = 0, count = 0;
      for (var y = Math.floor(h * 0.1); y < h * 0.9; y += 3) {
        for (var x = 0; x < w; x += 3) {
          var i = (y * w + x) * 4;
          var pr = data[i], pg = data[i + 1], pb = data[i + 2];
          if ((pr > 240 && pg > 240 && pb > 240) || (pr < 20 && pg < 20 && pb < 20)) continue;
          r += pr; g += pg; b += pb; count++;
        }
      }
      if (!count) { resolve(null); return; }
      r = Math.round(r / count * 0.8);
      g = Math.round(g / count * 0.8);
      b = Math.round(b / count * 0.8);
      resolve('#' + [r, g, b].map(function (v) { var s = v.toString(16); return s.length === 1 ? '0' + s : s; }).join(''));
    };
    img.onerror = function () { resolve(null); };
    img.src = URL.createObjectURL(blob);
  });
}

async function _extractAndSaveTheme(cardId) {
  var card = speeddials.find(function (c) { return c.id === cardId; });
  if (!card || !card.image) return;
  if (!card.image.startsWith('idx:')) {
    if (typeof showToast === 'function') showToast('仅支持本地图片，请先上传或截图', 'warning');
    return;
  }
  var key = card.image.replace('idx:', '');
  var blob = await loadImage(key);
  if (!blob) return;
  var color = await _extractThemeColorFromBlob(blob);
  if (color) {
    card.themeColor = color;
    if (typeof saveSpeeddials === 'function') saveSpeeddials(speeddials);
    renderSpeeddials();
    if (typeof showToast === 'function') showToast('主题色采样完成：' + color, 'success');
  }
}

/* ==================== DOM 分组容器缓存（LRU 3组） ==================== */
var _groupContainers = {};   // { groupIndex: div }
var _groupLru = [];          // [groupIndex, ...] 最近使用的在前

function _ensureGroupContainer(groupIndex) {
  if (_groupContainers[groupIndex]) {
    var pos = _groupLru.indexOf(groupIndex);
    if (pos >= 0) _groupLru.splice(pos, 1);
    _groupLru.unshift(groupIndex);
    return _groupContainers[groupIndex];
  }
  var div = document.createElement('div');
  div.className = 'speeddial-group';
  div.dataset.group = groupIndex;
  div.style.display = 'none';
  domMain.grid.appendChild(div);
  _groupContainers[groupIndex] = div;
  _groupLru.unshift(groupIndex);
  // LRU 驱逐：超过 3 组时销毁最久未用的
  while (_groupLru.length > 3) {
    var oldIdx = _groupLru.pop();
    var oldDiv = _groupContainers[oldIdx];
    if (oldDiv) { oldDiv.remove(); delete _groupContainers[oldIdx]; }
  }
  return div;
}

function _showCurrentGroup() {
  Object.keys(_groupContainers).forEach(function (gi) {
    _groupContainers[gi].style.display = gi == activeGroupIndex ? 'contents' : 'none';
  });
}

/** 检查当前分组是否已有缓存 DOM */
function _groupHasDOM(groupIndex) {
  var c = _groupContainers[groupIndex];
  return c && c.children.length > 0;
}

/* ==================== 卡片渲染 ==================== */
function renderSpeeddials() {
  if (!domMain.grid) return;
  if (typeof _renderDebounce !== 'undefined') clearTimeout(_renderDebounce);

  var cols = (currentSettings && currentSettings.columns) ? currentSettings.columns : 5;
  if (typeof updateGridColumns === 'function') updateGridColumns(cols);

  var sortMode = (groups[activeGroupIndex] && groups[activeGroupIndex].sortMode) ? groups[activeGroupIndex].sortMode : 'manual';
  var displayCards = getSortedCards(speeddials, sortMode);

  var container = _ensureGroupContainer(activeGroupIndex);
  _showCurrentGroup();

  // 空状态
  var showAdd = (!currentSettings || currentSettings.showAddButton !== false) && !isLocked;
  if (speeddials.length === 0 && !showAdd) {
    container.innerHTML = '<div class="empty-state"><p>📌 还没有快捷方式</p><p class="empty-hint">打开设置面板，开启「+ 添加按钮」来添加快捷导航</p></div>';
    domMain.grid.classList.add('rendered');
    return;
  }

  // 构建卡片 HTML（复用现有模板逻辑）
  var html = '';
  var enableTheme = currentSettings && currentSettings.cardThemeColor === true;
  displayCards.forEach(function (card, index) {
    var hasCustomImage = card.image && card.image.trim();
    var isLocal = hasCustomImage && card.image.startsWith('idx:');
    var imgSrc = isLocal ? null : (hasCustomImage ? escapeHtml(card.image.trim()) : '');
    var showTitle = !currentSettings || currentSettings.showCardTitle !== false;
    var firstChar = (card.name || '?').charAt(0).toUpperCase();
    var bgColor = card.color || stringToColor(card.url || card.name);
    var showCounter = currentSettings && currentSettings.showVisitCount === true;
    var visitCount = card.visitCount || 0;
    var pureText = currentSettings && currentSettings.pureTextCards === true;

    var topBarHtml = '';
    if (showTitle || showCounter) {
      topBarHtml = '<div class="card-top-bar">';
      if (showTitle) topBarHtml += '<span class="card-top-title">' + escapeHtml(card.name) + '</span>';
      if (showCounter) topBarHtml += '<span class="card-top-counter">👁 ' + visitCount + '</span>';
      topBarHtml += '</div>';
    }

    if (pureText) {
      var themeStyle = card.themeColor && enableTheme ? ' style="--theme-glow:' + card.themeColor + '"' : '';
      html += '<div class="card-wrapper' + (card.themeColor && enableTheme ? ' has-theme-glow' : '') + '"' + themeStyle + ' data-index="' + index + '" data-id="' + card.id + '" data-url="' + escapeHtml(card.url) + '" title="' + escapeHtml(card.name) + ' — ' + escapeHtml(card.url) + '">' + topBarHtml + '<div class="speeddial-card card-pure-text" draggable="true"><div class="card-pure-text-inner" style="background:' + bgColor + ';"><span class="card-pure-text-char">' + firstChar + '</span><span class="card-pure-text-name">' + escapeHtml(card.name) + '</span></div><div class="card-actions"><button class="btn-card-edit" data-action="edit" data-id="' + card.id + '" title="编辑">✎</button><button class="btn-card-delete" data-action="delete" data-id="' + card.id + '" title="删除">✕</button></div></div></div>';
      return;
    }

    var themeStyle2 = card.themeColor && enableTheme ? ' style="--theme-glow:' + card.themeColor + '"' : '';
    html += '<div class="card-wrapper' + (card.themeColor && enableTheme ? ' has-theme-glow' : '') + '"' + themeStyle2 + ' data-index="' + index + '" data-id="' + card.id + '" data-url="' + escapeHtml(card.url) + '" ' + (isLocal ? 'data-local-img="' + card.image + '"' : '') + ' title="' + escapeHtml(card.name) + ' — ' + escapeHtml(card.url) + '">' + topBarHtml + '<div class="speeddial-card" draggable="true"><div class="card-thumb">' + (hasCustomImage ? (isLocal ? '<img class="card-thumb-img" alt="' + escapeHtml(card.name) + '" data-local="1">' : '<img class="card-thumb-img" src="' + imgSrc + '" alt="' + escapeHtml(card.name) + '" loading="lazy">') : '<div class="card-fallback" style="background:' + bgColor + ';">' + firstChar + '</div>') + '</div><div class="card-actions"><button class="btn-card-edit" data-action="edit" data-id="' + card.id + '" title="编辑">✎</button><button class="btn-card-delete" data-action="delete" data-id="' + card.id + '" title="删除">✕</button></div></div></div>';
  });

  if (showAdd) {
    html += '<div class="card-wrapper card-wrapper-add"><div class="speeddial-card card-add" data-action="add" title="添加快捷方式（Alt+N）"><span class="card-add-icon">+</span></div></div>';
  }

  container.innerHTML = html;
  domMain.grid.classList.add('rendered');

  var thisRenderId = ++_renderId;
  loadLocalCardImages(container, thisRenderId);
  bindDragEvents();
}

/** 加载卡片中的本地 IndexedDB 图片（仅操作指定容器内的新 img，带 renderId） */
async function loadLocalCardImages(container, renderId) {
  var imgs = container.querySelectorAll('img[data-local="1"]:not([src])');
  for (var i = 0; i < imgs.length; i++) {
    if (renderId !== _renderId) return;
    var img = imgs[i];
    try {
      var wrapper = img.closest('.card-wrapper');
      var key = wrapper ? wrapper.dataset.localImg : null;
      if (!key) { var card = img.closest('.speeddial-card'); var w2 = card ? card.parentElement : null; key = w2 && w2.classList.contains('card-wrapper') ? w2.dataset.localImg : null; }
      if (!key) continue;
      key = key.replace('idx:', '');
      var url = await _getCardImgUrl(key);
      if (renderId !== _renderId) return;
      if (url) {
        img.src = url;
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
    // 点击空白处不再关闭弹窗
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
  if (card && card.image && card.image.startsWith('idx:')) {
    _clearCardBlobCache(card.image.replace('idx:', ''));
    if (typeof deleteCardIcon === 'function') deleteCardIcon(id);
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

  // v1.2.5: 根据开关和图片状态显示/隐藏采样主题色按钮
  var extractBtn = document.getElementById('dialog-extract-theme');
  if (extractBtn) {
    var hasImg = !!(card.image && card.image.trim());
    extractBtn.style.display = (hasImg && currentSettings && currentSettings.cardThemeColor) ? '' : 'none';
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
      // v1.2.5: 截图后自动提取主题色
      if (currentSettings && currentSettings.cardThemeColor && gcards[ci]) {
        var capturedCard = gcards[ci];
        var color = await _extractThemeColorFromBlob(blob);
        if (color) capturedCard.themeColor = color;
        await saveGroups(groups);
      }
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
        _clearCardBlobCache(oldCard.image.replace('idx:', ''));
        deleteCardIcon(editingId);
      }
    }
    await editSpeeddial(editingId, name, url, image);
  } else {
    await addSpeeddial(name, url, image);
  }

  // v1.2.5: 保存后自动提取主题色（编辑含图片的卡片时）
  if (editingId && currentSettings && currentSettings.cardThemeColor && image && image.startsWith('idx:')) {
    if (typeof _extractAndSaveTheme === 'function') _extractAndSaveTheme(editingId);
  }

  closeDialog();
}

/* ==================== 访问计数（v1.0.9） ==================== */

/** 对指定卡片访问计数 +1（全局扫描所有分组），自动保存 */
async function incrementVisitCount(cardId, render) {
  if (render === undefined) render = true;
  for (var gi = 0; gi < groups.length; gi++) {
    var cards = groups[gi].cards || [];
    for (var ci = 0; ci < cards.length; ci++) {
      if (cards[ci].id === cardId) {
        cards[ci].visitCount = (cards[ci].visitCount || 0) + 1;
        await saveGroups(groups);
        // 仅在当前活动分组时才更新 speeddials 和重渲染
        if (gi === activeGroupIndex) {
          speeddials = cards;
          if (render) renderSpeeddials();
        }
        return;
      }
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
