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
      // v1.2.9: 为旧卡片补全 lastOpened 字段
      if (card.lastOpened === undefined) { card.lastOpened = card.createdAt || 0; changed = true; }
    }
  }
  if (changed) {
    saveGroups(groups);
  }
}

/* ==================== v1.5.0: 可选 favicon（离线缓存 + 首字符兜底） ====================
   仅对「没有自定义图」的卡片生效；直接取站点自身的 /favicon.ico（不经过第三方图标服务），
   经 SW 代理下载后存 IndexedDB（离线可用）。失败则标记 faviconFailed，不再反复重试，
   渲染仍走首字符色块兜底。
*/

var FAVICON_CONCURRENCY = 3;

/** 从卡片 URL 推导 favicon 地址（站点根目录，忽略子路径） */
function _faviconUrlFor(cardUrl) {
  try {
    var u = new URL(cardUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin + '/favicon.ico';
  } catch (e) { return null; }
}

/** 为缺图卡片补 favicon；返回 { fetched, failed }
 *  BUG-076: 可传 { cardIds: [...] } 只处理指定卡片（新增卡片后立即补图用） */
async function enrichCardFavicons(options) {
  options = options || {};
  if (!(currentSettings && currentSettings.useFavicon)) return { fetched: 0, failed: 0 };
  if (typeof cacheCardIcon !== 'function') return { fetched: 0, failed: 0 };

  var onlyIds = Array.isArray(options.cardIds) && options.cardIds.length ? options.cardIds : null;

  var candidates = [];
  (groups || []).forEach(function (g) {
    (g.cards || []).forEach(function (c) {
      if (!c || c.image) return;                 // 已有图（自定义或 favicon）不动
      if (c.faviconFailed) return;               // 失败过的不再重试
      if (onlyIds && onlyIds.indexOf(c.id) === -1) return;
      if (!_faviconUrlFor(c.url)) return;
      candidates.push(c);
    });
  });
  if (options.limit) candidates = candidates.slice(0, options.limit);

  var fetched = 0, failed = 0, idx = 0;
  async function worker() {
    while (idx < candidates.length) {
      var card = candidates[idx++];
      var iconUrl = _faviconUrlFor(card.url);
      var ref = await cacheCardIcon(iconUrl, card.id);
      if (ref) { card.image = ref; fetched++; }
      else { card.faviconFailed = true; failed++; }   // 首字符兜底继续生效
    }
  }
  var workers = [];
  for (var i = 0; i < Math.min(FAVICON_CONCURRENCY, candidates.length); i++) workers.push(worker());
  await Promise.all(workers);

  if (fetched > 0 || failed > 0) {
    // 合并写：favicon 是装饰性数据，不必立即落盘
    if (typeof saveGroups === 'function') await saveGroups(groups, { coalesce: true });
  }
  return { fetched: fetched, failed: failed };
}

/** 单张卡片手动刷新图标（右键/编辑弹窗可用） */
async function refreshCardFavicon(cardId) {
  var card = null;
  (groups || []).forEach(function (g) {
    (g.cards || []).forEach(function (c) { if (c.id === cardId) card = c; });
  });
  if (!card) return false;
  var iconUrl = _faviconUrlFor(card.url);
  if (!iconUrl) { if (typeof showToast === 'function') showToast('该卡片不是 http/https 地址', 'warning'); return false; }
  var ref = await cacheCardIcon(iconUrl, card.id);
  if (!ref) {
    card.faviconFailed = true;
    if (typeof showToast === 'function') showToast('未取到网站图标，继续使用首字符', 'warning');
  } else {
    card.image = ref;
    delete card.faviconFailed;
    if (typeof showToast === 'function') showToast('已更新网站图标', 'success');
  }
  await saveGroups(groups);
  if (typeof renderSpeeddials === 'function') renderSpeeddials();
  return !!ref;
}

/* ==================== v1.5.0: 卡片多选批量操作 ====================
   Ctrl/⌘ + 单击 = 切换选中；Shift + 单击 = 从锚点到该卡片的区间选中。
   选中态只切 DOM class，不重渲染；批量操作走结构性立即写盘（saveGroups 不带 coalesce）。
*/
var _selectedCardIds = [];
var _selectionAnchorId = null;

function getSelectedCardIds() { return _selectedCardIds.slice(); }
function hasCardSelection() { return _selectedCardIds.length > 0; }

/** 当前分组的展示顺序（DOM 顺序即视觉顺序）
 *  v1.5.1: 必须限定当前分组的容器 —— DOM 池会同时保留其它分组的容器，
 *  否则 Ctrl+A / Shift 区间会把隐藏分组里的卡片也算进来 */
function _displayedCardIds() {
  var grid = document.getElementById('speeddial-grid');
  if (!grid) return [];
  var containers = grid.querySelectorAll('.speeddial-group');
  var scope = [];
  if (containers.length) {
    for (var i = 0; i < containers.length; i++) {
      if (containers[i].style.display !== 'none') scope.push(containers[i]);
    }
  } else {
    scope = [grid];
  }
  var out = [];
  Array.prototype.forEach.call(scope, function (c) {
    c.querySelectorAll('.card-wrapper[data-id]').forEach(function (el) { out.push(el.dataset.id); });
  });
  return out;
}

function _syncSelectionDom() {
  // v1.5.1: 只标记当前分组的容器 —— DOM 池会同时保留其它分组的容器，
  // 全局查询会把同名卡片的隐藏容器也标上（切组后看起来像被选中）
  var grid = document.getElementById('speeddial-grid');
  if (grid) {
    var containers = grid.querySelectorAll('.speeddial-group');
    var scope = containers.length ? containers : [grid];
    Array.prototype.forEach.call(scope, function (container) {
      var isActive = !container.classList || container === grid ||
        container.style.display !== 'none';
      container.querySelectorAll('.card-wrapper[data-id]').forEach(function (el) {
        el.classList.toggle('selected', isActive && _selectedCardIds.indexOf(el.dataset.id) !== -1);
      });
    });
  }
  updateBatchBar();
}

function toggleCardSelection(id) {
  if (!id) return;
  var i = _selectedCardIds.indexOf(id);
  if (i === -1) { _selectedCardIds.push(id); _selectionAnchorId = id; }
  else { _selectedCardIds.splice(i, 1); if (_selectionAnchorId === id) _selectionAnchorId = null; }
  _syncSelectionDom();
}

/** 区间选中：从锚点（或首张）到目标卡片 */
function selectCardRange(id) {
  var order = _displayedCardIds();
  var to = order.indexOf(id);
  if (to === -1) return;
  var from = order.indexOf(_selectionAnchorId);
  if (from === -1) from = 0;
  var lo = Math.min(from, to), hi = Math.max(from, to);
  _selectedCardIds = order.slice(lo, hi + 1);
  if (_selectionAnchorId === null) _selectionAnchorId = order[from];
  _syncSelectionDom();
}

function selectAllCards() {
  _selectedCardIds = _displayedCardIds();
  _syncSelectionDom();
}

function clearCardSelection() {
  if (_selectedCardIds.length === 0) return;
  _selectedCardIds = [];
  _selectionAnchorId = null;
  _syncSelectionDom();
}

/** 工具栏显隐与计数 */
function updateBatchBar() {
  var bar = document.getElementById('batch-bar');
  var count = document.getElementById('batch-count');
  if (!bar) return;
  if (_selectedCardIds.length === 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  if (count) count.textContent = '已选 ' + _selectedCardIds.length + ' 张';
}

/** 批量删除（走与单张删除一致的确认弹窗） */
async function batchDeleteSelected() {
  if (isLockedNow()) { showToast('界面已锁定，请右键 → 解锁', 'warning'); return; }
  var ids = getSelectedCardIds();
  if (ids.length === 0) return;
  try {
    await showImportConfirmAsync('确定要删除选中的 ' + ids.length + ' 张卡片吗？', { title: '🗑️ 批量删除', okLabel: '删除' });
  } catch (e) { return; }
  // BUG-068：先收集待删卡片（要拿它们的 image 引用回收缓存），再 splice 数据
  var doomed = speeddials.filter(function (c) { return ids.indexOf(c.id) !== -1; });
  for (var i = speeddials.length - 1; i >= 0; i--) {
    if (ids.indexOf(speeddials[i].id) !== -1) speeddials.splice(i, 1);
  }
  if (groups[activeGroupIndex]) groups[activeGroupIndex].cards = speeddials;
  await saveGroups(groups);
  for (var di = 0; di < doomed.length; di++) await _releaseCardImage(doomed[di]);
  clearCardSelection();
  renderSpeeddials();
  showToast('已删除 ' + ids.length + ' 张卡片', 'success');
}

/** 批量移动到指定分组 */
async function batchMoveSelected(targetGroupId) {
  if (isLockedNow()) { showToast('界面已锁定，请右键 → 解锁', 'warning'); return; }
  var ids = getSelectedCardIds();
  if (ids.length === 0) return;
  var target = (groups || []).find(function (g) { return g.id === targetGroupId; });
  if (!target) return;
  var moved = 0;
  for (var i = speeddials.length - 1; i >= 0; i--) {
    if (ids.indexOf(speeddials[i].id) !== -1) {
      target.cards = target.cards || [];
      target.cards.push(speeddials[i]);
      speeddials.splice(i, 1);
      moved++;
    }
  }
  if (groups[activeGroupIndex]) groups[activeGroupIndex].cards = speeddials;
  await saveGroups(groups);
  clearCardSelection();
  renderSpeeddials();
  showToast('已移动 ' + moved + ' 张卡片到「' + target.name + '」', 'success');
}

/** 锁定判定（isLocked 由 main.js 用 let 声明，需防 TDZ） */
function isLockedNow() {
  try { return typeof isLocked !== 'undefined' && !!isLocked; } catch (e) { return false; }
}

/** 批量工具栏事件绑定（由 main.js 初始化时调用） */
function initBatchBar() {
  var bar = document.getElementById('batch-bar');
  if (!bar) return;
  var clearBtn = document.getElementById('batch-clear');
  if (clearBtn) clearBtn.addEventListener('click', function (e) { e.stopPropagation(); clearCardSelection(); });
  var delBtn = document.getElementById('batch-delete');
  if (delBtn) delBtn.addEventListener('click', function (e) { e.stopPropagation(); batchDeleteSelected(); });
  var moveBtn = document.getElementById('batch-move');
  if (moveBtn) moveBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (isLockedNow()) { showToast('界面已锁定，请右键 → 解锁', 'warning'); return; }
    _showBatchMoveMenu(moveBtn);
  });
  // 点击工具栏空白处不冒泡到 body（避免触发搜索框聚焦）
  bar.addEventListener('click', function (e) { e.stopPropagation(); });
}

/** 批量移动的分组选择菜单 */
function _showBatchMoveMenu(anchorEl) {
  var old = document.getElementById('batch-move-menu');
  if (old) old.remove();
  var others = (groups || []).filter(function (g, i) { return i !== activeGroupIndex; });
  if (others.length === 0) { showToast('没有其它分组可移动', 'info'); return; }

  var menu = document.createElement('div');
  menu.id = 'batch-move-menu';
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = others.map(function (g) {
    return '<div role="menuitem" tabindex="-1" class="context-menu-item" data-group-id="' + g.id + '">📂 ' + escapeHtml(g.name) + '</div>';
  }).join('');
  document.body.appendChild(menu);

  var r = anchorEl.getBoundingClientRect();
  menu.style.left = Math.max(8, r.left) + 'px';
  menu.style.top = (r.bottom + 6) + 'px';

  menu.querySelectorAll('.context-menu-item').forEach(function (item) {
    item.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var gid = this.dataset.groupId;
      menu.remove();
      batchMoveSelected(gid);
    });
  });
  setTimeout(function () {
    document.addEventListener('click', function onDoc() {
      document.removeEventListener('click', onDoc);
      var m = document.getElementById('batch-move-menu');
      if (m) m.remove();
    });
  }, 0);
}

/* ==================== 卡片排序（v1.0.9 / v1.2.9 最近访问） ==================== */
function getSortedCards(cards, sortMode) {
  if (!sortMode || sortMode === 'manual') return cards;
  var sorted = cards.slice();
  switch (sortMode) {
    case 'time-asc':   return sorted.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    case 'time-desc':  return sorted.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    case 'visits-asc':  return sorted.sort(function (a, b) { return (a.visitCount || 0) - (b.visitCount || 0); });
    case 'visits-desc': return sorted.sort(function (a, b) { return (b.visitCount || 0) - (a.visitCount || 0); });
    case 'lastOpened-desc': return sorted.sort(function (a, b) { return (b.lastOpened || 0) - (a.lastOpened || 0); });
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

/** BUG-059 / BUG-068：回收一张卡片占用的本地图片资源（blob URL 缓存 + IndexedDB 实体）
 *  ⚠️ 必须按卡片真实的 image 引用删除：上传图的键是 card_<时间戳>_<随机>，不是 cardimg_<卡片id>，
 *  按 id 拼前缀的写法（原 deleteCardIcon，已随本批删除）永远删不掉上传图 —— 这正是 BUG-059。
 *  批量删除 / 去重删除原先只 splice 数据，连 blob URL 缓存都不清（BUG-068），一律走这里。 */
function _releaseCardImage(card) {
  if (!card || !card.image || !card.image.startsWith('idx:')) return Promise.resolve();
  _clearCardBlobCache(card.image.replace('idx:', ''));
  if (typeof deleteCardImageRef === 'function') return deleteCardImageRef(card.image);
  return Promise.resolve();
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
    // BUG-051：objectURL 必须显式释放 —— 原先每次调用都泄漏一个 blob: URL（截图 PNG 可达数 MB），
    // 且 blob URL store 会一直持有该 Blob 直到文档卸载。同仓 wallpaper.js 就是「用完即 revoke」的写法。
    var objUrl = URL.createObjectURL(blob);
    var finish = function (color) {
      URL.revokeObjectURL(objUrl);
      resolve(color);
    };
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
      if (!count) { finish(null); return; }
      r = Math.round(r / count * 0.8);
      g = Math.round(g / count * 0.8);
      b = Math.round(b / count * 0.8);
      finish('#' + [r, g, b].map(function (v) { var s = v.toString(16); return s.length === 1 ? '0' + s : s; }).join(''));
    };
    img.onerror = function () { finish(null); };
    img.src = objUrl;
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

/* ==================== DOM 分组容器缓存（LRU 3组） ====================
   BUG-038: 缓存键必须是「分组 id」而不是「数组下标」—— 删组 / 拖拽重排会让下标整体平移，
   按下标缓存会把「旧下标 → 旧分组的 DOM」在切组时原样显示（显示已删除分组的卡片）。
   容器上的 data-group-id 记录归属，命中前一律校验，对不上就丢弃重建。 */
var _groupContainers = {};   // { groupKey: div }
var _groupLru = [];          // [groupKey, ...] 最近使用的在前

/** 分组缓存键：优先用分组 id（不随下标平移），无 id 时退化为下标 */
function _groupKey(groupIndex) {
  var g = groups && groups[groupIndex];
  if (g && g.id) return 'id:' + g.id;
  return 'idx:' + groupIndex;
}

/** 容器归属校验：该容器是否确实属于当前下标对应的分组 */
function _containerBelongsTo(container, groupIndex) {
  if (!container) return false;
  var g = groups && groups[groupIndex];
  if (g && g.id) return container.dataset.groupId === String(g.id);
  return container.dataset.group === String(groupIndex);
}

function _ensureGroupContainer(groupIndex) {
  var key = _groupKey(groupIndex);
  var cached = _groupContainers[key];
  if (cached && _containerBelongsTo(cached, groupIndex)) {
    var pos = _groupLru.indexOf(key);
    if (pos >= 0) _groupLru.splice(pos, 1);
    _groupLru.unshift(key);
    return cached;
  }
  // 归属不符（下标平移后残留）→ 丢弃重建，绝不复用别的分组的 DOM
  if (cached) { cached.remove(); delete _groupContainers[key]; }
  var div = document.createElement('div');
  div.className = 'speeddial-group';
  div.dataset.group = groupIndex;
  div.dataset.groupId = (groups && groups[groupIndex] && groups[groupIndex].id) ? String(groups[groupIndex].id) : '';
  div.style.display = 'none';
  domMain.grid.appendChild(div);
  _groupContainers[key] = div;
  _groupLru.unshift(key);
  // LRU 驱逐：超过 3 组时销毁最久未用的
  while (_groupLru.length > 3) {
    var oldKey = _groupLru.pop();
    var oldDiv = _groupContainers[oldKey];
    if (oldDiv) { oldDiv.remove(); delete _groupContainers[oldKey]; }
  }
  return div;
}

/** BUG-052: 失效单个分组的容器（该组数据被改动但当前不是活动组时用，如「移动到分组」） */
function _invalidateGroupContainer(groupIndex) {
  var key = _groupKey(groupIndex);
  var el = _groupContainers[key];
  if (el && typeof el.remove === 'function') el.remove();
  delete _groupContainers[key];
  var pos = _groupLru.indexOf(key);
  if (pos >= 0) _groupLru.splice(pos, 1);
}

/** BUG-035 / BUG-038 / BUG-055: 分组增删 / 重排 / 外部数据变更后失效 DOM 池（移除容器节点）。
 *  keepIndex 指定要保留的容器（通常是当前活动分组）：它的内容会由紧随其后的
 *  renderSpeeddials() 重建，保留它可以避免「先清空再渲染」之间的一帧闪白。 */
function _invalidateGroupDOMCache(keepIndex) {
  var keepKey = (typeof keepIndex === 'number') ? _groupKey(keepIndex) : null;
  Object.keys(_groupContainers).forEach(function (key) {
    if (keepKey !== null && key === keepKey) return;
    var el = _groupContainers[key];
    if (el && typeof el.remove === 'function') el.remove();
    delete _groupContainers[key];
    var pos = _groupLru.indexOf(key);
    if (pos >= 0) _groupLru.splice(pos, 1);
  });
}

/** 当前活动分组的容器（不存在或不归属则为 null）——供拖拽等模块使用，避免外部按下标取缓存 */
function _activeGroupContainer() {
  var c = _groupContainers[_groupKey(activeGroupIndex)];
  return _containerBelongsTo(c, activeGroupIndex) ? c : null;
}

function _showCurrentGroup() {
  // v1.2.9: 确保缓存的卡片高度与当前 CSS 变量一致（display:contents 下变量可能丢失）
  _syncCardHeights();

  var activeKey = _groupKey(activeGroupIndex);
  Object.keys(_groupContainers).forEach(function (key) {
    _groupContainers[key].style.display = key === activeKey ? 'contents' : 'none';
  });
}

/** v1.2.9: 将所有可见卡片的 height 同步为当前 CSS 变量值 */
function _syncCardHeights() {
  var cardH = document.documentElement.style.getPropertyValue('--card-height');
  if (!cardH) return;
  var cards = document.querySelectorAll('.speeddial-card');
  for (var i = 0; i < cards.length; i++) {
    cards[i].style.height = cardH;
  }
}

/** 检查当前分组是否已有缓存 DOM（必须校验容器归属，见 BUG-038） */
function _groupHasDOM(groupIndex) {
  var c = _groupContainers[_groupKey(groupIndex)];
  return !!(c && c.children.length > 0 && _containerBelongsTo(c, groupIndex));
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
      html += '<div class="card-wrapper' + (card.themeColor && enableTheme ? ' has-theme-glow' : '') + '"' + themeStyle + ' data-index="' + index + '" data-id="' + card.id + '" data-url="' + escapeHtml(card.url) + '" title="' + escapeHtml(card.name) + ' — ' + escapeHtml(card.url) + '">' + topBarHtml + '<div class="speeddial-card card-pure-text" draggable="true"><div class="card-pure-text-inner" style="background:' + bgColor + ';"><span class="card-pure-text-char">' + firstChar + '</span><span class="card-pure-text-name">' + escapeHtml(card.name) + '</span></div><div class="card-actions"><button class="btn-card-edit" data-action="edit" data-id="' + card.id + '" title="编辑" aria-label="编辑卡片">✎</button><button class="btn-card-delete" data-action="delete" data-id="' + card.id + '" title="删除" aria-label="删除卡片">✕</button></div></div></div>';
      return;
    }

    var themeStyle2 = card.themeColor && enableTheme ? ' style="--theme-glow:' + card.themeColor + '"' : '';
    html += '<div class="card-wrapper' + (card.themeColor && enableTheme ? ' has-theme-glow' : '') + '"' + themeStyle2 + ' data-index="' + index + '" data-id="' + card.id + '" data-url="' + escapeHtml(card.url) + '" ' + (isLocal ? 'data-local-img="' + card.image + '"' : '') + ' title="' + escapeHtml(card.name) + ' — ' + escapeHtml(card.url) + '">' + topBarHtml + '<div class="speeddial-card" draggable="true"><div class="card-thumb">' + (hasCustomImage ? (isLocal ? '<img class="card-thumb-img" alt="' + escapeHtml(card.name) + '" data-local="1">' : '<img class="card-thumb-img" src="' + imgSrc + '" alt="' + escapeHtml(card.name) + '" loading="lazy">') : '<div class="card-fallback" style="background:' + bgColor + ';">' + firstChar + '</div>') + '</div><div class="card-actions"><button class="btn-card-edit" data-action="edit" data-id="' + card.id + '" title="编辑" aria-label="编辑卡片">✎</button><button class="btn-card-delete" data-action="delete" data-id="' + card.id + '" title="删除" aria-label="删除卡片">✕</button></div></div></div>';
  });

  if (showAdd) {
    html += '<div class="card-wrapper card-wrapper-add"><div class="speeddial-card card-add" data-action="add" title="添加快捷方式（Alt+N）"><span class="card-add-icon">+</span></div></div>';
  }

  container.innerHTML = html;
  domMain.grid.classList.add('rendered');

  // v1.2.9: 新渲染的卡片同步当前高度，防 display:contents 变量继承丢失
  _syncCardHeights();

  var thisRenderId = ++_renderId;
  loadLocalCardImages(container, thisRenderId);
  bindDragEvents();

  // v1.5.1: 重渲染后恢复多选样式 ——
  // 后台刷新（storage.onChanged / 外部变更）会重建卡片 DOM 并丢掉 .selected，
  // 造成「数据里还选中着、界面上却看不到」，批量操作看起来失灵
  if (typeof _syncSelectionDom === 'function' && typeof hasCardSelection === 'function' && hasCardSelection()) {
    _syncSelectionDom();
  }
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

/** v1.2.8: 检查完整 URL 是否已存在于任意分组（非仅域名），返回 { groupName, cardName } 或 null */
function findDuplicate(url) {
  try {
    var u = new URL(url);
    var normalized = u.hostname.replace('www.', '') + u.pathname + u.search;
    for (var gi = 0; gi < groups.length; gi++) {
      var cards = groups[gi].cards || [];
      for (var ci = 0; ci < cards.length; ci++) {
        try {
          var cu = new URL(cards[ci].url);
          if (cu.hostname.replace('www.', '') + cu.pathname + cu.search === normalized) {
            return { groupName: groups[gi].name, cardName: cards[ci].name };
          }
        } catch (e) { /* best-effort: 单张卡片的 URL 非法就跳过它，继续比对其余卡片（不是失败） */ }
      }
    }
  } catch (e) {
    // DEBT-02: 传入的 URL 自己就解析不了 → 查重只能放弃（返回 null）。降级可用，但必须留痕。
    _warnDegraded('重复卡片检查（URL 无法解析）', e);
  }
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

/* ==================== v1.2.9: 全量重复卡片检查 ==================== */

/** 扫描所有分组，返回按 URL 分组的重复卡片 */
function findAllDuplicates() {
  var urlMap = {};
  for (var gi = 0; gi < groups.length; gi++) {
    var cards = groups[gi].cards || [];
    for (var ci = 0; ci < cards.length; ci++) {
      var card = cards[ci];
      var url = (card.url || '').trim();
      if (!url) continue;
      if (!urlMap[url]) urlMap[url] = [];
      urlMap[url].push({
        groupIndex: gi,
        cardIndex: ci,
        groupName: groups[gi].name || '未命名',
        cardName: card.name || url,
        cardId: card.id
      });
    }
  }
  // 只保留重复项
  var result = {};
  Object.keys(urlMap).forEach(function (u) {
    if (urlMap[u].length > 1) result[u] = urlMap[u];
  });
  return result;
}

/** 显示重复卡片检查弹窗 */
function showDuplicateCheckDialog() {
  var dupMap = findAllDuplicates();
  var urls = Object.keys(dupMap);
  var totalCards = 0;
  urls.forEach(function (u) { totalCards += dupMap[u].length; });

  var dlg = document.getElementById('dialog-duplicate-check');
  var msg = document.getElementById('dup-check-msg');
  var list = document.getElementById('dup-check-list');
  var cleanBtn = document.getElementById('dup-check-clean-all');
  var closeBtn = document.getElementById('dup-check-close');

  if (!dlg || !msg || !list) return;

  if (urls.length === 0) {
    if (typeof showToast === 'function') showToast('✅ 未发现重复卡片', 'success');
    return;
  }

  msg.textContent = '发现 ' + urls.length + ' 组重复（共 ' + totalCards + ' 张卡片）';

  var html = '';
  urls.forEach(function (url) {
    var entries = dupMap[url];
    html += '<div class="dup-check-group"><div class="dup-check-url">' + url.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>';
    entries.forEach(function (e) {
      html += '<div class="dup-check-row" data-card-id="' + e.cardId + '" data-group-index="' + e.groupIndex + '">';
      html += '<span class="dup-check-group-name">' + e.groupName.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</span>';
      html += '<span class="dup-check-card-name" title="' + e.cardName.replace(/"/g,'&quot;') + '">' + e.cardName.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</span>';
      html += '<button class="dup-check-delete" title="删除此卡片">🗑️</button>';
      html += '</div>';
    });
    html += '</div>';
  });
  list.innerHTML = html;

  // 绑定删除按钮
  list.querySelectorAll('.dup-check-delete').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var row = btn.closest('.dup-check-row');
      var cardId = row.getAttribute('data-card-id');
      var groupIdx = parseInt(row.getAttribute('data-group-index'), 10);
      // 确认
      try {
        await showImportConfirmAsync('确定要删除此卡片吗？', { title: '🗑️ 删除卡片', okLabel: '删除', cancelLabel: '取消' });
      } catch (e) { return; }
      // 删除
      if (groups[groupIdx]) {
        // BUG-068：先取出卡片对象，删除数据后按它真实的 image 引用回收缓存
        var doomedOne = (groups[groupIdx].cards || []).filter(function (c) { return c.id === cardId; });
        groups[groupIdx].cards = (groups[groupIdx].cards || []).filter(function (c) { return c.id !== cardId; });
        await saveGroups(groups);
        for (var doi = 0; doi < doomedOne.length; doi++) await _releaseCardImage(doomedOne[doi]);
        // 从弹窗中移除该行
        var groupEl = row.closest('.dup-check-group');
        row.remove();
        // 如果该组只剩一个，移除整组
        if (groupEl) {
          var rows = groupEl.querySelectorAll('.dup-check-row');
          if (rows.length <= 1) groupEl.remove();
        }
        // 刷新主页卡片
        if (groupIdx === activeGroupIndex) {
          speeddials = groups[groupIdx].cards;
          renderSpeeddials();
        }
        if (typeof showToast === 'function') showToast('已删除', 'info');
        // 如果所有重复都清完了，关闭弹窗
        if (list.querySelectorAll('.dup-check-row').length === 0) {
          dlg.classList.add('hidden');
          if (typeof showToast === 'function') showToast('✅ 所有重复卡片已清理', 'success');
        }
      }
    });
  });

  // 一键清理重复
  if (cleanBtn) {
    cleanBtn.style.display = 'block';
    cleanBtn.onclick = async function () {
      var msg2 = '将为每组重复保留第一张卡片，删除其余 ' + (totalCards - urls.length) + ' 张，是否继续？';
      try {
        await showImportConfirmAsync(msg2, { title: '🗑️ 一键清理重复', okLabel: '确认清理', cancelLabel: '取消' });
      } catch (e) { return; }
      // BUG-068：一边剔除数据一边收集待回收的卡片对象（原先只 filter，缓存全留着）
      var doomedAll = [];
      urls.forEach(function (url) {
        var entries = dupMap[url];
        // 保留第一张，删除其余
        for (var i = 1; i < entries.length; i++) {
          var e = entries[i];
          if (groups[e.groupIndex]) {
            doomedAll = doomedAll.concat((groups[e.groupIndex].cards || []).filter(function (c) { return c.id === e.cardId; }));
            groups[e.groupIndex].cards = (groups[e.groupIndex].cards || []).filter(function (c) { return c.id !== e.cardId; });
          }
        }
      });
      await saveGroups(groups);
      for (var dai = 0; dai < doomedAll.length; dai++) await _releaseCardImage(doomedAll[dai]);
      // 刷新
      if (groups[activeGroupIndex]) {
        speeddials = groups[activeGroupIndex].cards;
        renderSpeeddials();
      }
      dlg.classList.add('hidden');
      if (typeof showToast === 'function') showToast('✅ 已清理 ' + (totalCards - urls.length) + ' 张重复卡片', 'success');
    };
  }

  dlg.classList.remove('hidden');
  if (closeBtn) closeBtn.onclick = function () { dlg.classList.add('hidden'); };
}

async function addSpeeddial(name, url, image) {
  var dup = findDuplicate(url);
  if (dup) {
    var proceed = await showDuplicateConfirm(name, url, dup);
    if (!proceed) return;
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  speeddials.push({ id, name, url, image: image || '', color: stringToColor(url), visitCount: 0, createdAt: Date.now(), lastOpened: 0 });
  await saveSpeeddials(speeddials);
  renderSpeeddials();
  // BUG-076: 新增卡片后立刻补一次网站图标 —— 原先只有 main.js 的首屏 idle 回调会补，
  // 于是新加的卡片要等下次打开新标签页才出图标（期间一直是首字符色块）。
  // 只针对这一张，且不 await：图标是装饰性数据，不挡保存流程。
  if (!image && currentSettings && currentSettings.useFavicon && typeof enrichCardFavicons === 'function') {
    enrichCardFavicons({ cardIds: [id] }).then(function (r) {
      if (r && r.fetched > 0 && typeof renderSpeeddials === 'function') renderSpeeddials();
    }).catch(function (e) { _warnDegraded('新卡片补网站图标', e); });
  }
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
  // BUG-059：按卡片真实的 image 引用回收（cardimg_<id> 与上传图 card_<ts>_<rand> 都要能删掉）
  await _releaseCardImage(card);
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
  // v1.3.3: http 页面截图需可选权限，否则无法注入截图按钮
  if (typeof ensurePermissionForUrl === 'function' && !(await ensurePermissionForUrl(card.url))) return;
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
    var oldCard = speeddials.find(function (c) { return c.id === editingId; });
    if (oldCard && oldCard.image && oldCard.image.startsWith('idx:') && oldCard.image !== image) {
      // BUG-059：按旧引用删除（上传图是 card_* 前缀，原先按 id 拼 cardimg_ 删不掉）
      await _releaseCardImage(oldCard);
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
  var now = Date.now();
  for (var gi = 0; gi < groups.length; gi++) {
    var cards = groups[gi].cards || [];
    for (var ci = 0; ci < cards.length; ci++) {
      if (cards[ci].id === cardId) {
        cards[ci].visitCount = (cards[ci].visitCount || 0) + 1;
        cards[ci].lastOpened = now;
        // v1.3.3: 连续点卡片会逐次写盘 → 合并写
        await saveGroups(groups, { coalesce: true });
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
