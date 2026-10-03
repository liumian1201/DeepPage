/* ============================================================
   wallpaper.js — 壁纸管理 + IndexedDB 图片存储
   Bing 多图浏览 / UHD / 区域 / 刷新间隔
   ============================================================ */

var BING_WALLPAPERS_KEY = 'bing_wallpapers_cache';
var IMG_DB = 'DeepPageImages';
var _imgDB = null;  // BUG-004: IndexedDB 连接单例缓存

/* ========== IndexedDB 通用图片存储 ========== */
function openImgDB() {
  if (_imgDB) return Promise.resolve(_imgDB);
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(IMG_DB, 1);
    req.onupgradeneeded = function () {
      if (!req.result.objectStoreNames.contains('images')) req.result.createObjectStore('images');
    };
    req.onsuccess = function () {
      _imgDB = req.result;
      _imgDB.onclose = function () { _imgDB = null; };
      _imgDB.onversionchange = function () { if (_imgDB) { _imgDB.close(); _imgDB = null; } };
      resolve(_imgDB);
    };
    req.onerror = function () { reject(req.error); };
  });
}

function withImgStore(mode, callback) {
  return openImgDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('images', mode);
      callback(tx.objectStore('images'), resolve, reject);
    });
  });
}

async function saveImage(key, blob) {
  var db = await openImgDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction('images', 'readwrite');
    tx.objectStore('images').put(blob, key);
    tx.oncomplete = function () { resolve(key); };
    tx.onerror = function () { reject(tx.error); };
  });
}

async function loadImage(key) {
  try {
    var db = await openImgDB();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('images', 'readonly');
      var req = tx.objectStore('images').get(key);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  } catch (e) { return null; }
}

async function deleteImage(key) {
  try {
    var db = await openImgDB();
    return new Promise(function (resolve) {
      var tx = db.transaction('images', 'readwrite');
      tx.objectStore('images').delete(key);
      tx.oncomplete = function () { resolve(); };
    });
  } catch (e) {}
}

async function uploadImage(file, prefix) {
  var key = prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  await saveImage(key, file);
  return key;
}

/* ========== 卡片图标缓存 ========== */

/** 从 URL 下载并缓存卡片图标（Service Worker 代理绕过 CORS），返回 idx: 引用 */
async function cacheCardIcon(url, cardId) {
  try {
    var blob = await new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage({ type: 'image-fetch', url: url }, function (resp) {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (resp && resp.ok) {
          var base64 = resp.data;
          var parts = base64.split(',');
          var byteStr = atob(parts.length > 1 ? parts[1] : parts[0]);
          var bytes = new Uint8Array(byteStr.length);
          for (var i = 0; i < byteStr.length; i++) { bytes[i] = byteStr.charCodeAt(i); }
          resolve(new Blob([bytes], { type: resp.type || 'image/png' }));
        } else {
          reject(new Error((resp && resp.error) || 'fetch failed'));
        }
      });
    });
    var key = 'cardimg_' + cardId;
    await saveImage(key, blob);
    return 'idx:' + key;
  } catch (e) {
    console.warn('卡片图标缓存失败:', url, e);
    return null;
  }
}

/** 删除卡片图标缓存 */
async function deleteCardIcon(cardId) {
  var key = 'cardimg_' + cardId;
  await deleteImage(key);
}

/* ========== IndexedDB 垃圾回收 (GC) ========== */

/**
 * 清理 IndexedDB 中无主卡片图标（已删除卡片/分组的残留 cardimg_* 图片）
 * 静默执行，不影响用户操作
 */
async function collectCardImageGarbage() {
  try {
    var validKeys = new Set();
    // 检查 sync 和 local 两处存储（大容量数据在 local）
    var result = await new Promise(function (resolve) {
      chrome.storage.sync.get(['groups'], function (data) { resolve(data); });
    });
    var groups = result.groups;
    if (!groups || !Array.isArray(groups) || groups.length === 0) {
      var localResult = await new Promise(function (resolve) {
        chrome.storage.local.get(['groups'], function (data) { resolve(data); });
      });
      groups = localResult.groups || [];
    }
    // v1.2.1: 同时检查 local_bak 中的图片引用，避免误删恢复数据
    var bakResult = await new Promise(function (resolve) {
      chrome.storage.local.get(['groups_local_bak'], function (data) { resolve(data); });
    });
    var bakGroups = bakResult.groups_local_bak || [];
    var allGroups = groups.concat(bakGroups);
    for (var i = 0; i < allGroups.length; i++) {
      var cards = allGroups[i].cards || [];
      for (var j = 0; j < cards.length; j++) {
        var img = cards[j].image;
        if (img && img.startsWith('idx:')) {
          validKeys.add(img.slice(4)); // 'idx:cardimg_xxx' → 'cardimg_xxx'
        }
      }
    }

    // 遍历 IndexedDB，删除不在有效集合中的 cardimg_ 条目
    var db = await openImgDB();
    var orphans = [];
    await new Promise(function (resolve) {
      var tx = db.transaction('images', 'readwrite');
      var store = tx.objectStore('images');
      var cursorReq = store.openCursor();
      cursorReq.onsuccess = function (e) {
        var cursor = e.target.result;
        if (cursor) {
          var key = cursor.key;
          if (typeof key === 'string' && key.startsWith('cardimg_') && !validKeys.has(key)) {
            orphans.push(key);
            cursor.delete();
          }
          cursor.continue();
        } else { resolve(); }
      };
    });

    if (orphans.length > 0) {
      console.log('GC: 清理了 ' + orphans.length + ' 个无主图片:', orphans);
    }
  } catch (e) {
    console.warn('GC 执行失败:', e);
  }
}

/* ========== Bing 壁纸多图缓存 ========== */
var bingCache = null;

async function getBingCache() {
  if (bingCache) return bingCache;
  var cached = await loadFromLocal(BING_WALLPAPERS_KEY, null);
  if (cached && cached.images && cached.images.length) bingCache = cached;
  return bingCache;
}

async function setBingCache(data) {
  bingCache = data;
  await saveToLocal(BING_WALLPAPERS_KEY, data);
}

function getBingRefreshMs() {
  var min = (currentSettings && currentSettings.bingRefreshMin) ? currentSettings.bingRefreshMin : 360;
  return min * 60 * 1000;
}

function isBingCacheValid(cache, settings) {
  if (!cache || !cache.images || !cache.images.length) return false;
  if (cache.region !== (settings.bingRegion || 'zh-CN')) return false;
  if (!settings.bingAutoRefresh) return true;
  return (Date.now() - cache.timestamp) < getBingRefreshMs();
}

/* ========== 拉取 Bing 壁纸（一次 8 张） ========== */
async function fetchBingWallpapers(settings) {
  var region = settings.bingRegion || 'zh-CN';
  var apiUrl = 'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=' + region;
  var res = await fetch(apiUrl);
  var data = await res.json();
  if (!data || !data.images || !data.images.length) throw new Error('Bing API 无数据');

  var uhd = settings.bingUHD === true;
  var images = data.images.map(function (img) {
    var baseUrl = 'https://www.bing.com' + img.url;
    return {
      url: uhd ? baseUrl.replace('1920x1080', 'UHD') : baseUrl,
      copyright: img.copyright || '',
      title: img.title || ''
    };
  });

  var cache = { images: images, timestamp: Date.now(), region: region, idx: 0 };
  await setBingCache(cache);
  return cache;
}

/* ========== 壁纸应用与导航 ========== */
/** 当前展示的本地壁纸的单张遮罩（null = 跟随全局）。v1.5.0 规则：单张遮罩优先。
 *  任意一次「应用全局遮罩」（如其它标签页改了设置触发 applyAllSettings）都不得把它覆盖掉。 */
var _localWallpaperOpacityOverride = null;

/** 当前生效的遮罩透明度：本地壁纸设了单张遮罩时以单张为准，否则用全局值 */
function getEffectiveWallpaperOpacity(settings) {
  var global = ((settings || currentSettings || {}).wallpaperOpacity) || 30;
  return typeof _localWallpaperOpacityOverride === 'number' ? _localWallpaperOpacityOverride : global;
}

async function applyWallpaper(settings) {
  var body = document.body;
  body.style.backgroundImage = '';
  body.classList.remove('has-wallpaper', 'wallpaper-bing');
  // 非本地壁纸没有「单张遮罩」概念 → 清掉 override，让全局值生效
  _localWallpaperOpacityOverride = null;
  var mode = settings.wallpaperMode || 'bing';
  try {
    if (mode === 'bing') { body.classList.add('wallpaper-bing'); await applyBingWallpaper(settings); }
    else if (mode === 'custom') {
      // v1.5.0: 本地多图优先；列表为空时回退到旧的单图/URL 逻辑
      var applied = await applyLocalWallpapers(settings);
      if (!applied) await applyCustomWallpaper(settings.wallpaperUrl);
    }
  } catch (e) {
    console.warn('壁纸加载失败:', e);
  }
}

async function applyBingWallpaper(settings) {
  var cache = await getBingCache();
  if (!isBingCacheValid(cache, settings)) {
    try {
      cache = await fetchBingWallpapers(settings);
    } catch (e) {
      console.warn('Bing 壁纸获取失败:', e);
      if (cache && cache.images) {
        console.log('使用过期缓存');
      } else {
        return;
      }
    }
  }

  if (cache.idx >= cache.images.length || cache.idx < 0) cache.idx = 0;
  var img = cache.images[cache.idx];
  setBackgroundImage(img.url);
  updateWallpaperInfo(img, cache.idx, cache.images.length);
}

function nextWallpaper() {
  if (!bingCache || !bingCache.images) return;
  bingCache.idx = (bingCache.idx + 1) % bingCache.images.length;
  setBingCache(bingCache);
  var img = bingCache.images[bingCache.idx];
  setBackgroundImage(img.url);
  updateWallpaperInfo(img, bingCache.idx, bingCache.images.length);
}

function prevWallpaper() {
  if (!bingCache || !bingCache.images) return;
  bingCache.idx = (bingCache.idx - 1 + bingCache.images.length) % bingCache.images.length;
  setBingCache(bingCache);
  var img = bingCache.images[bingCache.idx];
  setBackgroundImage(img.url);
  updateWallpaperInfo(img, bingCache.idx, bingCache.images.length);
}

async function refreshBingWallpaper() {
  bingCache = null;
  if (!currentSettings) currentSettings = await getSettings();
  await applyBingWallpaper(currentSettings);
}

/* ========== 壁纸信息显示 ========== */
function updateWallpaperInfo(img, idx, total) {
  var el = document.getElementById('wallpaper-copyright');
  if (!el) return;
  el.textContent = (idx + 1) + '/' + total + '  ' + (img.copyright || '');
  el.title = img.copyright || '';
}

/* ========== 自定义壁纸 ========== */
async function applyCustomWallpaper(url) {
  if (!url || !url.trim()) { await loadWallpaperFromDB(); return; }
  if (url.trim().startsWith('[本地文件]')) await loadWallpaperFromDB();
  else setBackgroundImage(url.trim());
}

async function loadWallpaperFromDB() {
  var blob = await loadImage('wallpaper');
  if (blob) setBackgroundImage(URL.createObjectURL(blob));
}

var _currentBlobUrl = null;

/**
 * @param {string} url 图片地址
 * @param {number} [opacityOverride] 该张壁纸自己的遮罩（v1.5.0 单张遮罩）；
 *        不传则用全局 wallpaperOpacity。必须在 onload 里用同一个值 ——
 *        否则异步 onload 会用全局值覆盖调用方刚设好的单张遮罩
 */
function setBackgroundImage(url, opacityOverride) {
  var prevBlob = _currentBlobUrl;
  var body = document.body;
  var img = new Image();
  img.onload = function () {
    body.style.backgroundImage = 'url("' + url.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '') + '")';
    body.classList.add('has-wallpaper');
    // 同步遮罩透明度到新壁纸（单张优先）
    var opacity = (opacityOverride !== undefined && opacityOverride !== null)
      ? opacityOverride
      : ((currentSettings && currentSettings.wallpaperOpacity !== undefined) ? currentSettings.wallpaperOpacity : 30);
    document.documentElement.style.setProperty('--wallpaper-opacity', opacity / 100);
    // CSS 已内部持有图片，Blob URL 可安全释放
    if (url.startsWith('blob:')) _currentBlobUrl = url;
    else _currentBlobUrl = null;
    if (prevBlob && prevBlob.startsWith('blob:')) URL.revokeObjectURL(prevBlob);
  };
  img.onerror = function () {
    console.warn('壁纸图片加载失败:', url);
    body.style.backgroundImage = '';
    body.classList.remove('has-wallpaper');
    if (prevBlob && prevBlob.startsWith('blob:')) URL.revokeObjectURL(prevBlob);
  };
  img.src = url;
}

/* ========== v1.5.0: 本地多图壁纸 + 轮播 + 单张遮罩 ========== */

var LOCAL_WP_ROTATE_IDX_KEY = 'wallpaper_rotate_idx';

function getLocalWallpapers(settings) {
  var list = (settings || currentSettings || {}).localWallpapers;
  return Array.isArray(list) ? list : [];
}

/**
 * 选出当前应展示的本地壁纸下标
 *   off      → 0（固定第一张）
 *   newtab   → 每次新标签页 +1（序号存 local，多标签页各自递增）
 *   interval → 按时间片计算 floor(now / interval)，所有标签页一致且到点自动切换
 */
async function _pickLocalWallpaperIndex(list, settings) {
  var mode = settings.wallpaperRotate || 'off';
  if (list.length <= 1) return 0;
  if (mode === 'newtab') {
    var cur = await new Promise(function (r) {
      chrome.storage.local.get([LOCAL_WP_ROTATE_IDX_KEY], function (d) { r(d[LOCAL_WP_ROTATE_IDX_KEY] || 0); });
    });
    var next = (cur + 1) % list.length;
    chrome.storage.local.set({ [LOCAL_WP_ROTATE_IDX_KEY]: next });
    return next;
  }
  if (mode === 'interval') {
    var min = settings.wallpaperRotateMin || 30;
    return Math.floor(Date.now() / (min * 60000)) % list.length;
  }
  return 0;
}

/** 应用本地多图壁纸（含单张独立遮罩） */
async function applyLocalWallpapers(settings) {
  var list = getLocalWallpapers(settings);
  if (list.length === 0) return false;
  var idx = await _pickLocalWallpaperIndex(list, settings);
  var item = list[idx];
  var blob = await loadImage(item.key);
  if (!blob) { console.warn('本地壁纸缺失:', item.key); return false; }
  // 单张遮罩优先，未设置则沿用全局；一并传给 setBackgroundImage，避免 onload 回调覆盖
  var opacity = (item.opacity !== undefined && item.opacity !== null)
    ? item.opacity
    : (settings.wallpaperOpacity !== undefined ? settings.wallpaperOpacity : 30);
  // 记录当前这张的 override，供 applyWallpaperOpacity 复用（全局遮罩不得覆盖单张）
  _localWallpaperOpacityOverride = (item.opacity !== undefined && item.opacity !== null) ? item.opacity : null;
  setBackgroundImage(URL.createObjectURL(blob), opacity);
  document.documentElement.style.setProperty('--wallpaper-opacity', opacity / 100);
  if (typeof updateWallpaperInfo === 'function') {
    updateWallpaperInfo({ copyright: item.name || '本地壁纸' }, idx, list.length);
  }
  return true;
}

/** 保存本地壁纸列表 */
function saveLocalWallpapers(list) {
  if (!currentSettings) currentSettings = {};
  currentSettings.localWallpapers = list;
  if (typeof saveSettings === 'function') saveSettings(currentSettings);
}

/** 添加多张本地壁纸（文件来自 input 或拖拽） */
async function addLocalWallpapers(files) {
  var list = getLocalWallpapers().slice();
  var added = 0;
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (!f || !/^image\//.test(f.type)) continue;
    if (f.size > 20 * 1024 * 1024) { console.warn('跳过过大的壁纸:', f.name); continue; }
    try {
      var key = await uploadImage(f, 'wp_');
      list.push({ key: key, name: f.name || ('壁纸 ' + (list.length + 1)), opacity: null });
      added++;
    } catch (e) { console.warn('壁纸保存失败:', e.message); }
  }
  if (added === 0) return 0;
  saveLocalWallpapers(list);
  renderLocalWallpaperList();
  if (typeof showToast === 'function') showToast('已添加 ' + added + ' 张本地壁纸', 'success');
  await applyLocalWallpapers(currentSettings);
  return added;
}

/** 删除一张本地壁纸 */
async function deleteLocalWallpaper(key) {
  var list = getLocalWallpapers().filter(function (it) { return it.key !== key; });
  saveLocalWallpapers(list);
  try { await deleteImage(key); } catch (e) { /* 忽略 */ }
  renderLocalWallpaperList();
  if (list.length === 0) {
    // 列表清空 → 回到无自定义壁纸状态
    document.body.style.backgroundImage = '';
    document.body.classList.remove('has-wallpaper');
  } else {
    await applyLocalWallpapers(currentSettings);
  }
}

/** 设置某张壁纸的独立遮罩（null = 跟随全局） */
function setLocalWallpaperOpacity(key, opacity) {
  var list = getLocalWallpapers();
  var it = list.find(function (x) { return x.key === key; });
  if (!it) return;
  it.opacity = (opacity === null || opacity === undefined || opacity === '') ? null : parseInt(opacity, 10);
  saveLocalWallpapers(list);
  renderLocalWallpaperList();          // 同步该项标签/滑块，避免 UI 与数据不一致
  applyLocalWallpapers(currentSettings);
}

/** 渲染本地壁纸列表（缩略图 + 单张遮罩 + 删除） */
function renderLocalWallpaperList() {
  var wrap = document.getElementById('local-wallpaper-list');
  if (!wrap) return;
  var list = getLocalWallpapers();
  if (list.length === 0) {
    wrap.innerHTML = '<div class="lw-empty">还没有本地壁纸，点下面的按钮添加（可多选）</div>';
    return;
  }
  var globalOp = (currentSettings && currentSettings.wallpaperOpacity !== undefined) ? currentSettings.wallpaperOpacity : 30;
  wrap.innerHTML = list.map(function (it, i) {
    var op = (it.opacity === undefined || it.opacity === null) ? '' : it.opacity;
    return '<div class="lw-item" data-key="' + escapeHtml(it.key) + '">' +
      '<img class="lw-thumb" data-key="' + escapeHtml(it.key) + '" alt="' + escapeHtml(it.name) + '">' +
      '<div class="lw-meta">' +
        '<span class="lw-name" title="' + escapeHtml(it.name) + '">' + (i + 1) + '. ' + escapeHtml(it.name) + '</span>' +
        '<div class="lw-opacity">' +
          '<span class="lw-op-label">遮罩</span>' +
          '<input type="range" class="lw-op" data-key="' + escapeHtml(it.key) + '" min="0" max="100" step="5" value="' + (op === '' ? globalOp : op) + '">' +
          '<span class="lw-op-val">' + (op === '' ? '跟随全局' : op + '%') + '</span>' +
        '</div>' +
      '</div>' +
      '<button class="lw-del" data-key="' + escapeHtml(it.key) + '" title="删除这张壁纸" aria-label="删除壁纸">✕</button>' +
      '</div>';
  }).join('');

  // 缩略图（异步读 IndexedDB，读完即回收 Blob URL）
  wrap.querySelectorAll('.lw-thumb').forEach(function (imgEl) {
    loadImage(imgEl.dataset.key).then(function (blob) {
      if (!blob) return;
      var u = URL.createObjectURL(blob);
      imgEl.src = u;
      imgEl.onload = function () { URL.revokeObjectURL(u); };
    });
  });
  wrap.querySelectorAll('.lw-del').forEach(function (btn) {
    btn.addEventListener('click', function (e) { e.stopPropagation(); deleteLocalWallpaper(this.dataset.key); });
  });
  wrap.querySelectorAll('.lw-op').forEach(function (slider) {
    slider.addEventListener('input', function () {
      var val = this.parentElement.querySelector('.lw-op-val');
      if (val) val.textContent = this.value + '%';
      document.documentElement.style.setProperty('--wallpaper-opacity', this.value / 100);
    });
    slider.addEventListener('change', function () { setLocalWallpaperOpacity(this.dataset.key, this.value); });
  });
}

/** 绑定列表相关的上传/轮播控件（由设置面板初始化时调用） */
function initLocalWallpaperUI() {
  renderLocalWallpaperList();
  var multiBtn = document.getElementById('btn-wallpaper-upload-multi');
  var multiInput = document.getElementById('wallpaper-file-input-multi');
  if (multiBtn && multiInput) {
    multiBtn.addEventListener('click', function () { multiInput.click(); });
    multiInput.addEventListener('change', function () {
      if (this.files && this.files.length) addLocalWallpapers(this.files);
      this.value = '';
    });
  }
  var rotateSel = document.getElementById('setting-wallpaper-rotate');
  if (rotateSel) {
    var syncRow = function () {
      var row = document.getElementById('wallpaper-rotate-min-row');
      if (row) row.style.display = rotateSel.value === 'interval' ? '' : 'none';
    };
    rotateSel.addEventListener('change', function () {
      syncRow();
      if (typeof onSettingChanged === 'function') onSettingChanged();
    });
    syncRow();
  }
}

/* ========== 初始化 ========== */
async function initWallpaper() {
  if (!currentSettings) currentSettings = await getSettings();
  // 新标签页：从缓存中随机选一张壁纸
  var cache = await getBingCache();
  if (cache && cache.images && cache.images.length > 1) {
    cache.idx = Math.floor(Math.random() * cache.images.length);
    await setBingCache(cache);
  }
  await applyWallpaper(currentSettings);
  bindWallpaperUpload();
  bindWallpaperNav();
}

function bindWallpaperUpload() {
  var up = document.getElementById('btn-wallpaper-upload');
  var fi = document.getElementById('wallpaper-file-input');
  var ui = document.getElementById('setting-wallpaper-url');
  if (!up || !fi || !ui) return;
  up.addEventListener('click', function () { fi.click(); });
  fi.addEventListener('change', function () {
    var file = fi.files[0]; if (!file) return;
    var blobUrl = URL.createObjectURL(file);
    setBackgroundImage(blobUrl);
    ui.value = '[本地文件] ' + file.name;
    ui.dispatchEvent(new Event('change', { bubbles: true }));
    saveImage('wallpaper', file).then(function () {
      if (typeof showToast === 'function') showToast('壁纸已保存', 'success');
    }).catch(function (err) {
      console.warn('壁纸保存失败:', err);
      if (typeof showToast === 'function') showToast('壁纸保存失败', 'error');
    });
  });
}

function bindWallpaperNav() {
  var prevBtn = document.getElementById('btn-wallpaper-prev');
  var nextBtn = document.getElementById('btn-wallpaper-next');
  if (prevBtn) prevBtn.addEventListener('click', prevWallpaper);
  if (nextBtn) nextBtn.addEventListener('click', nextWallpaper);
}
