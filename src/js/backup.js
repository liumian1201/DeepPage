/* ============================================================
   backup.js — 数据管理模块
   一键全部导出/导入：fflate Zip（配置 + 图片库）
   兼容旧版 .json 格式
   ============================================================ */

// ==================== 确认对话框 ====================

function showImportConfirm(msg, onOk) {
  var dlg = document.getElementById('dialog-import-confirm');
  var msgEl = document.getElementById('import-confirm-msg');
  if (!dlg) { if (onOk) onOk(); return; }
  if (msgEl) msgEl.textContent = msg;
  dlg.classList.remove('hidden');

  var okBtn = document.getElementById('import-confirm-ok');
  var cancelBtn = document.getElementById('import-confirm-cancel');
  var cleanup = function () { dlg.classList.add('hidden'); };
  if (okBtn) { okBtn.onclick = function () { cleanup(); if (onOk) onOk(); }; }
  if (cancelBtn) cancelBtn.onclick = cleanup;
  dlg.onclick = function (e) { if (e.target === dlg) cleanup(); };
}

function showImportConfirmAsync(msg) {
  return new Promise(function (resolve) {
    showImportConfirm(msg, function () { resolve(); });
  });
}

// ==================== 一键全部导出（fflate Zip） ====================

async function exportAll() {
  try {
    // 1. 读取配置
    var config = await new Promise(function (resolve) {
      chrome.storage.sync.get(null, function (result) { resolve(result); });
    });

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

        // 恢复配置
        if (hasConfig) {
          var config = JSON.parse(fflate.strFromU8(unzipped['config.json']));
          if (typeof config === 'object' && config !== null) {
            await new Promise(function (resolve) {
              chrome.storage.sync.clear(function () {
                chrome.storage.sync.set(config, resolve);
              });
            });
          }
        }

        // 恢复图片
        if (hasImages) {
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
            } catch (e) { console.warn('导入图片失败:', img.key, e); }
          }
          showToast('全部导入成功（配置 + ' + imported + '/' + manifest.images.length + ' 张图片），即将刷新...', 'success');
        } else {
          showToast('配置导入成功，即将刷新...', 'success');
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
          await new Promise(function (resolve) {
            chrome.storage.sync.clear(function () {
              chrome.storage.sync.set(data, resolve);
            });
          });
          showToast('配置导入成功，即将刷新...', 'success');

        } else {
          throw new Error('无法识别的备份文件格式');
        }
      }
    } catch (err) {
      showToast('导入失败：' + err.message, 'error');
    }

    if (loading) loading.classList.add('hidden');
    setTimeout(function () { window.location.reload(); }, 1000);
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

  chrome.storage.sync.clear(function () {
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
  });
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
