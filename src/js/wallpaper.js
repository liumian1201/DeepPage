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
      _imgDB.onversionchange = function () { _imgDB.close(); _imgDB = null; };
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
    // 收集所有有效卡片的 image 引用
    var validKeys = new Set();
    var result = await new Promise(function (resolve) {
      chrome.storage.sync.get(['groups'], function (data) { resolve(data); });
    });
    var groups = result.groups || [];
    for (var i = 0; i < groups.length; i++) {
      var cards = groups[i].cards || [];
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
async function applyWallpaper(settings) {
  var body = document.body;
  body.style.backgroundImage = '';
  body.classList.remove('has-wallpaper', 'wallpaper-bing');
  var mode = settings.wallpaperMode || 'bing';
  try {
    if (mode === 'bing') { body.classList.add('wallpaper-bing'); await applyBingWallpaper(settings); }
    else if (mode === 'custom') await applyCustomWallpaper(settings.wallpaperUrl);
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

function setBackgroundImage(url) {
  var prevBlob = _currentBlobUrl;
  var body = document.body;
  var img = new Image();
  img.onload = function () {
    body.style.backgroundImage = 'url("' + url.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '') + '")';
    body.classList.add('has-wallpaper');
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
