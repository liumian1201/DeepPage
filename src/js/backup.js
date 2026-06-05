/* ============================================================
   backup.js — 数据管理模块
   一键全部导出/导入：fflate Zip（配置 + 图片库）
   兼容旧版 .json 格式
   ============================================================ */

// ==================== 确认对话框 ====================

function showImportConfirm(msg, onOk, onCancel) {
  var dlg = document.getElementById('dialog-import-confirm');
  var msgEl = document.getElementById('import-confirm-msg');
  if (!dlg) { if (onOk) onOk(); return; }
  if (msgEl) msgEl.textContent = msg;
  dlg.classList.remove('hidden');

  var okBtn = document.getElementById('import-confirm-ok');
  var cancelBtn = document.getElementById('import-confirm-cancel');
  var cleanup = function () { dlg.classList.add('hidden'); };
  if (okBtn) { okBtn.onclick = function () { cleanup(); if (onOk) onOk(); }; }
  if (cancelBtn) { cancelBtn.onclick = function () { cleanup(); if (onCancel) onCancel(); }; }
  dlg.onclick = function (e) { if (e.target === dlg) { cleanup(); if (onCancel) onCancel(); } };
}

function showImportConfirmAsync(msg) {
  return new Promise(function (resolve, reject) {
    showImportConfirm(msg, function () { resolve(); }, function () { reject(new Error('CANCELLED')); });
  });
}

/** 对导入数据去重：同一 ID 出现在多个分组时，为重复项生成新 ID，同时重映射 IndexedDB key */
function dedupCardIds(groups, manifest, unzipped) {
  var seen = new Set();
  var dupCount = 0;
  var keyRemap = {};
  for (var gi = 0; gi < (groups || []).length; gi++) {
    var cards = groups[gi].cards || [];
    for (var ci = 0; ci < cards.length; ci++) {
      var card = cards[ci];
      if (seen.has(card.id)) {
        var newId = card.id + '_dup' + (++dupCount);
        if (card.image && card.image.startsWith('idx:cardimg_')) {
          keyRemap['cardimg_' + card.id] = 'cardimg_' + newId;
          card.image = 'idx:cardimg_' + newId;
        }
        card.id = newId;
      } else {
        seen.add(card.id);
      }
    }
  }
  var remapKeys = Object.keys(keyRemap);
  if (remapKeys.length > 0) {
    if (manifest && manifest.images) {
      for (var mi = 0; mi < manifest.images.length; mi++) {
        var img = manifest.images[mi];
        if (keyRemap[img.key]) { img.key = keyRemap[img.key]; }
      }
    }
    if (unzipped) {
      for (var ki = 0; ki < remapKeys.length; ki++) {
        var oldK = remapKeys[ki];
        var newK = keyRemap[oldK];
        if (unzipped[oldK]) { unzipped[newK] = unzipped[oldK]; unzipped[oldK] = undefined; }
      }
    }
  }
  return dupCount;
}

// ==================== 一键全部导出（fflate Zip） ====================

async function exportAll() {
  try {
    // 1. 读取配置（sync + local 回退，确保超限数据也被导出）
    var config = await new Promise(function (resolve) {
      chrome.storage.sync.get(null, function (result) { resolve(result); });
    });
    // 如果 sync 中的分组为空（可能因为超限存在 local），从 local 补充
    if (!config.groups || (Array.isArray(config.groups) && config.groups.length === 0)) {
      var localData = await new Promise(function (resolve) {
        chrome.storage.local.get(['groups', 'activeGroup'], function (result) { resolve(result); });
      });
      if (localData.groups && Array.isArray(localData.groups) && localData.groups.length > 0) {
        config.groups = localData.groups;
        config.activeGroup = localData.activeGroup;
      }
    }
    // 写入导出时间戳，供导入预览使用
    if (config.settings) {
      config.settings._exportTime = new Date().toLocaleString('zh-CN');
    }

    // 2. 读取图片库
    var db = await openImgDB();
    var images = await new Promise(function (resolve, reject) {
      var tx = db.transaction('images', 'readonly');
      var store = tx.objectStore('images');
      var result = [];
      var cursorReq = store.openCursor();
      cursorReq.onsuccess = function (e) {
        var cursor = e.target.result;
        if (cursor) {
          result.push({ key: cursor.key, blob: cursor.value });
          cursor.continue();
        } else { resolve(result); }
      };
      cursorReq.onerror = function (e) { reject(e.target.error); };
    });

    // 3. 构建 zip
    var zipFiles = {};
    var imageManifest = [];

    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      var buf = await img.blob.arrayBuffer();
      zipFiles[img.key] = new Uint8Array(buf);
      imageManifest.push({ key: img.key, type: img.blob.type || 'image/png', size: buf.byteLength });
    }

    zipFiles['config.json'] = fflate.strToU8(JSON.stringify(config));
    zipFiles['manifest.json'] = fflate.strToU8(JSON.stringify({
      version: 3, type: 'backup',
      hasConfig: true, imageCount: imageManifest.length, images: imageManifest
    }));

    var zipU8 = fflate.zipSync(zipFiles, { level: 6 });
    var zipBlob = new Blob([zipU8], { type: 'application/zip' });
    downloadFile(zipBlob, getTimestamp() + '_DeepPage_Backup.zip');
    showToast('全部导出成功（配置 + ' + imageManifest.length + ' 张图片）', 'success');
  } catch (err) {
    showToast('导出失败：' + err.message, 'error');
  }
}

// ==================== 一键全部导入（兼容新旧格式） ====================

function importAll() {
  var _importCancelled = false;
  pickFile('.zip,.json', async function (file) {
    var loading = document.getElementById('backup-loading');
    if (loading) loading.classList.remove('hidden');

    try {
      var isZip = file.name.toLowerCase().endsWith('.zip');
      var isJson = file.name.toLowerCase().endsWith('.json');

      if (isZip) {
        var zipU8 = new Uint8Array(await file.arrayBuffer());
        var unzipped = fflate.unzipSync(zipU8);

        var manifestRaw = unzipped['manifest.json'];
        var manifest = manifestRaw ? JSON.parse(fflate.strFromU8(manifestRaw)) : null;

        var hasConfig = manifest && manifest.hasConfig && unzipped['config.json'];
        var hasImages = manifest && manifest.images && manifest.images.length > 0;

        if (!hasConfig && !hasImages) throw new Error('备份文件中没有有效数据');

        // 预览摘要：先读取 config.json 统计分组和卡片数
        var preview = '';
        if (hasConfig) {
          var previewConfig = JSON.parse(fflate.strFromU8(unzipped['config.json']));
          var previewGroups = previewConfig.groups || [];
          var totalCards = 0;
          for (var pi = 0; pi < previewGroups.length; pi++) {
            totalCards += (previewGroups[pi].cards || []).length;
          }
          var exportTime = previewConfig.settings && previewConfig.settings._exportTime;
          preview = '📂 ' + previewGroups.length + ' 个分组，🗂️ ' + totalCards + ' 张卡片';
          if (exportTime) preview += '\n🕐 导出时间：' + exportTime;
          if (hasImages) preview += '\n🖼️ ' + manifest.images.length + ' 张缓存图片';
        } else {
          preview = '🖼️ ' + manifest.images.length + ' 张缓存图片（无配置）';
        }
        preview += '\n\n⚠️ 导入将覆盖当前所有数据，是否继续？';

        await showImportConfirmAsync(preview);

        // 先恢复图片（IndexedDB），再恢复配置（storage.sync）
        // 避免 storage.onChanged 触发渲染时 IndexedDB 还没写完
        var imported = 0;
        if (hasImages) {
          imported = await _importImages(unzipped, manifest);
        }

        // 恢复配置（storage.sync 写在图片之后）
        var dupCount = 0, syncFailed = false;
        if (hasConfig) {
          var cfgResult = await _importConfig(unzipped, manifest);
          dupCount = cfgResult.dupCount;
          syncFailed = cfgResult.syncFailed;
        }

        // BUG-002: 导入后清理旧卡片残留的孤儿图片
        if (typeof collectCardImageGarbage === 'function') await collectCardImageGarbage();

        if (hasImages) {
          showToast('全部导入成功（配置 + ' + imported + '/' + manifest.images.length + ' 张图片）' + (dupCount > 0 ? '，修复 ' + dupCount + ' 个重复 ID' : '') + '，即将刷新...', 'success');
        } else if (syncFailed) {
          showToast('导入成功（数据量较大，使用本地存储）' + (dupCount > 0 ? '，修复 ' + dupCount + ' 个重复 ID' : '') + '，即将刷新...', 'success');
        } else {
          showToast('配置导入成功' + (dupCount > 0 ? '，修复 ' + dupCount + ' 个重复 ID' : '') + '，即将刷新...', 'success');
        }

      } else if (isJson) {
        // 旧格式兼容
        var text = await file.text();
        var data = JSON.parse(text);

        if (data.images && Array.isArray(data.images)) {
          // 旧图片库 JSON（base64 格式）
          var count = data.images.length;
          if (count === 0) { showToast('备份文件中没有图片', 'info'); if (loading) loading.classList.add('hidden'); return; }
          await showImportConfirmAsync('检测到旧格式图片备份，将导入 ' + count + ' 张图片。');

          var db2 = await openImgDB();
          var imported2 = 0;
          for (var j = 0; j < data.images.length; j++) {
            var oldImg = data.images[j];
            if (!oldImg.key || !oldImg.data) continue;
            try {
              var oldBlob = base64ToBlob(oldImg.data, oldImg.type || 'image/png');
              await new Promise(function (resolve, reject) {
                var tx = db2.transaction('images', 'readwrite');
                tx.objectStore('images').put(oldBlob, oldImg.key);
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
              });
              imported2++;
            } catch (e) { console.warn('导入图片失败:', oldImg.key, e); }
          }
          showToast('图片导入成功（' + imported2 + '/' + count + ' 张），即将刷新...', 'success');

        } else if (typeof data === 'object' && data !== null) {
          // 旧配置 JSON
          await showImportConfirmAsync('检测到旧格式配置备份，导入将覆盖当前所有数据。');
          var oldSyncFailed = false;
          await new Promise(function (resolve) {
            chrome.storage.sync.set({
              settings: data.settings || {},
              groups: data.groups || [],
              activeGroup: data.activeGroup || 0
            }, function () {
              if (chrome.runtime.lastError) oldSyncFailed = true;
              resolve();
            });
          });
          if (oldSyncFailed) {
            var oldFSettings = data.settings || {};
            oldFSettings.storageFallback = 'local';
            await new Promise(function (resolve) {
              chrome.storage.local.set({ groups: data.groups || [], activeGroup: data.activeGroup || 0 }, resolve);
            });
            var oldSettingsFailed = false;
            await new Promise(function (resolve) {
              chrome.storage.sync.set({ settings: oldFSettings, groups: [], activeGroup: 0 }, function () {
                if (chrome.runtime.lastError) oldSettingsFailed = true;
                resolve();
              });
            });
            if (oldSettingsFailed) {
              await new Promise(function (resolve) {
                chrome.storage.local.set({ settings: oldFSettings }, resolve);
              });
            }
            showToast('导入成功（数据量较大，使用本地存储），即将刷新...', 'success');
          } else {
            showToast('配置导入成功，即将刷新...', 'success');
          }

        } else {
          throw new Error('无法识别的备份文件格式');
        }
      }
    } catch (err) {
      if (err.message === 'CANCELLED') {
        _importCancelled = true;
      } else {
        showToast('导入失败：' + err.message, 'error');
      }
    }

    if (loading) loading.classList.add('hidden');
    if (!_importCancelled) {
      setTimeout(function () { window.location.reload(); }, 1000);
    }
    _importCancelled = false;
  });
}

// ==================== 重置全部 ====================

function resetAll() {
  var dlg = document.getElementById('dialog-reset');
  if (!dlg) { showToast('对话框未找到', 'error'); return; }
  dlg.classList.remove('hidden');

  var cancelBtn = document.getElementById('reset-cancel');
  var okBtn = document.getElementById('reset-ok');
  if (cancelBtn) cancelBtn.onclick = function () { dlg.classList.add('hidden'); };
  if (okBtn) okBtn.onclick = function () { dlg.classList.add('hidden'); doResetAll(); };
  dlg.onclick = function (e) { if (e.target === dlg) dlg.classList.add('hidden'); };
}

function doResetAll() {
  var fallback = setTimeout(function () { window.location.reload(); }, 5000);

  // 清理 sync + local（大容量回退数据在 local）
  chrome.storage.sync.clear(function () {
    chrome.storage.local.clear(function () {
    var req = indexedDB.deleteDatabase('DeepPageImages');
    req.onsuccess = function () {
      clearTimeout(fallback);
      showToast('全部数据已重置，页面将自动刷新。', 'info');
      setTimeout(function () { window.location.reload(); }, 600);
    };
    req.onerror = function () {
      clearTimeout(fallback);
      showToast('配置已重置（图片库清除失败），页面将刷新。', 'warning');
      setTimeout(function () { window.location.reload(); }, 600);
    };
    req.onblocked = function () {
      clearTimeout(fallback);
      showToast('配置已重置（图片库被占用），页面将刷新。', 'warning');
      setTimeout(function () { window.location.reload(); }, 600);
    };
    }); // local.clear
  }); // sync.clear
}

// ==================== 图片库信息 ====================

async function updateImageDBInfo() {
  var el = document.getElementById('image-db-info');
  if (!el) return;
  try {
    var db = await openImgDB();
    var count = await new Promise(function (resolve) {
      var tx = db.transaction('images', 'readonly');
      var req = tx.objectStore('images').count();
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(0); };
    });
    if (count === 0) {
      el.textContent = '暂无图片数据';
    } else {
      el.textContent = '共 ' + count + ' 张图片（壁纸 + 卡片图标）';
    }
  } catch (e) {
    el.textContent = '无法读取图片库';
  }
}

// ==================== v1.2.0 WebDAV 辅助 ====================

/** 导入图片到 IndexedDB */
async function _importImages(unzipped, manifest) {
  var db = await openImgDB();
  var imported = 0;
  for (var i = 0; i < manifest.images.length; i++) {
    var img = manifest.images[i];
    var raw = unzipped[img.key];
    if (!img.key || !raw) continue;
    try {
      var blob = new Blob([raw], { type: img.type || 'image/png' });
      await new Promise(function (resolve, reject) {
        var tx = db.transaction('images', 'readwrite');
        tx.objectStore('images').put(blob, img.key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
      imported++;
      unzipped[img.key] = undefined;
    } catch (e) { console.warn('导入图片失败:', img.key, e); }
  }
  return imported;
}

/** 导入配置到 storage */
async function _importConfig(unzipped, manifest) {
  var config = JSON.parse(fflate.strFromU8(unzipped['config.json']));
  if (typeof config !== 'object' || config === null) return 0;
  var dupCount = dedupCardIds(config.groups, manifest, unzipped);
  var syncFailed = false;
  await new Promise(function (resolve) {
    chrome.storage.sync.set({
      settings: config.settings || {},
      groups: config.groups || [],
      activeGroup: config.activeGroup || 0
    }, function () {
      if (chrome.runtime.lastError) { syncFailed = true; }
      resolve();
    });
  });
  if (syncFailed) {
    var fSettings = config.settings || {};
    fSettings.storageFallback = 'local';
    await new Promise(function (resolve) {
      chrome.storage.local.set({ groups: config.groups || [], activeGroup: config.activeGroup || 0 }, resolve);
    });
    var ssf = false;
    await new Promise(function (resolve) {
      chrome.storage.sync.set({ settings: fSettings, groups: [], activeGroup: 0 }, function () {
        if (chrome.runtime.lastError) ssf = true;
        resolve();
      });
    });
    if (ssf) {
      await new Promise(function (resolve) { chrome.storage.local.set({ settings: fSettings }, resolve); });
    }
  }
  return { dupCount: dupCount, syncFailed: syncFailed };
}

/** 供 WebDAV 恢复使用的统一入口 */
async function doImportFromUnzipped(unzipped, showToastResult) {
  var manifestRaw = unzipped['manifest.json'];
  var manifest = manifestRaw ? JSON.parse(fflate.strFromU8(manifestRaw)) : null;
  var hasConfig = manifest && manifest.hasConfig && unzipped['config.json'];
  var hasImages = manifest && manifest.images && manifest.images.length > 0;
  var imported = 0, dupCount = 0;
  if (hasImages) imported = await _importImages(unzipped, manifest);
  if (hasConfig) { var r = await _importConfig(unzipped, manifest); dupCount = r.dupCount; }
  if (typeof collectCardImageGarbage === 'function') await collectCardImageGarbage();
  if (showToastResult && typeof showToast === 'function') {
    var msg = '全部导入成功（配置 + ' + imported + '/' + (manifest ? manifest.images.length : 0) + ' 张图片）';
    if (dupCount > 0) msg += '，修复 ' + dupCount + ' 个重复 ID';
    showToast(msg + '，即将刷新...', 'success');
  }
}

/** 更新 WebDAV 状态显示 */
function updateWebdavStatus() {
  var el = document.getElementById('webdav-status');
  if (!el) return;
  getWebdavLastBackup(function (t) {
    if (t) {
      el.textContent = '上次备份: ' + new Date(t).toLocaleString('zh-CN');
    } else {
      el.textContent = '尚未备份';
    }
  });
}

/** 收集全量数据（供 WebDAV 备份复用 exportAll 逻辑） */
async function _collectAllData() {
  var config = await new Promise(function (resolve) {
    chrome.storage.sync.get(null, function (result) { resolve(result); });
  });
  if (!config.groups || (Array.isArray(config.groups) && config.groups.length === 0)) {
    var localData = await new Promise(function (resolve) {
      chrome.storage.local.get(['groups', 'activeGroup'], function (result) { resolve(result); });
    });
    if (localData.groups && Array.isArray(localData.groups) && localData.groups.length > 0) {
      config.groups = localData.groups;
      config.activeGroup = localData.activeGroup;
    }
  }
  if (config.settings) config.settings._exportTime = new Date().toLocaleString('zh-CN');

  var db = await openImgDB();
  var images = await new Promise(function (resolve) {
    var tx = db.transaction('images', 'readonly');
    var result = [];
    tx.objectStore('images').openCursor().onsuccess = function (e) {
      var cursor = e.target.result;
      if (cursor) { result.push({ key: cursor.key, blob: cursor.value }); cursor.continue(); }
      else resolve(result);
    };
  });
  return { config: config, images: images };
}

/** 构建 zip Blob */
async function _buildZipBlob(data) {
  var zipFiles = {};
  var imageManifest = [];
  for (var i = 0; i < data.images.length; i++) {
    var img = data.images[i];
    var buf = await img.blob.arrayBuffer();
    zipFiles[img.key] = new Uint8Array(buf);
    imageManifest.push({ key: img.key, type: img.blob.type || 'image/png', size: buf.byteLength });
  }
  zipFiles['config.json'] = fflate.strToU8(JSON.stringify(data.config));
  zipFiles['manifest.json'] = fflate.strToU8(JSON.stringify({
    version: 3, type: 'backup', hasConfig: true, imageCount: imageManifest.length, images: imageManifest
  }));
  return new Blob([fflate.zipSync(zipFiles, { level: 6 })], { type: 'application/zip' });
}

// ==================== 工具函数 ====================

function getTimestamp() {
  var now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '_',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');
}

function downloadFile(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function pickFile(accept, callback) {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.style.cssText = 'position:fixed;top:-100px;left:0;width:1px;height:1px';
  input.addEventListener('change', function () {
    var file = input.files[0];
    if (file) callback(file);
    document.body.removeChild(input);
  });
  input.addEventListener('cancel', function () {
    document.body.removeChild(input);
  });
  document.body.appendChild(input);
  input.click();
}

function base64ToBlob(base64, type) {
  var parts = base64.split(',');
  var byteStr = atob(parts.length > 1 ? parts[1] : parts[0]);
  var bytes = new Uint8Array(byteStr.length);
  for (var i = 0; i < byteStr.length; i++) {
    bytes[i] = byteStr.charCodeAt(i);
  }
  return new Blob([bytes], { type: type });
}

// ==================== 事件绑定 ====================

function bindBackupEvents() {
  var btnExport  = document.getElementById('btn-export-all');
  var btnImport  = document.getElementById('btn-import-all');
  var btnReset   = document.getElementById('btn-reset-all');

  if (btnExport) btnExport.addEventListener('click', exportAll);
  if (btnImport) btnImport.addEventListener('click', importAll);
  if (btnReset)  btnReset.addEventListener('click', resetAll);
}
