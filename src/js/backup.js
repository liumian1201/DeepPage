/* ============================================================
   backup.js — 数据管理模块
   分体导出/导入：配置(JSON) + 图片库(IndexedDB → base64 JSON)
   ============================================================ */

// ==================== 配置数据（chrome.storage.sync） ====================

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

async function exportConfig() {
  try {
    var data = await new Promise(function (resolve) {
      chrome.storage.sync.get(null, function (result) { resolve(result); });
    });

    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    downloadFile(blob, getTimestamp() + '_DeepPage_Config.json');
    showToast('配置导出成功', 'success');
  } catch (err) {
    showToast('导出失败：' + err.message, 'error');
  }
}

function importConfig() {
  pickFile('.json', async function (file) {
    try {
      var text = await file.text();
      var data = JSON.parse(text);

      if (typeof data !== 'object' || data === null) {
        throw new Error('文件格式无效');
      }

      showImportConfirm('导入将覆盖当前所有分组、卡片和设置数据，确定继续吗？', async function () {
        await new Promise(function (resolve) {
          chrome.storage.sync.clear(function () {
            chrome.storage.sync.set(data, resolve);
          });
        });
        showToast('配置导入成功，页面将自动刷新。', 'success');
        setTimeout(function () { window.location.reload(); }, 800);
      });
    } catch (err) {
      showToast('导入失败：' + err.message, 'error');
    }
  });
}

// ==================== 图片库（IndexedDB → fflate Zip） ====================

async function exportImageDB() {
  try {
    var db = await openImgDB();
    var items = await new Promise(function (resolve, reject) {
      var tx = db.transaction('images', 'readonly');
      var store = tx.objectStore('images');
      var result = [];
      var cursorReq = store.openCursor();
      cursorReq.onsuccess = function (e) {
        var cursor = e.target.result;
        if (cursor) {
          result.push({ key: cursor.key, blob: cursor.value });
          cursor.continue();
        } else {
          resolve(result);
        }
      };
      cursorReq.onerror = function (e) { reject(e.target.error); };
    });

    if (!items || items.length === 0) {
      showToast('图片库为空，无需导出', 'info');
      return;
    }

    // 构建 zip：manifest.json + 每个 Blob 作为二进制文件
    var manifest = [];
    var zipFiles = {};

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var buf = await item.blob.arrayBuffer();
      zipFiles[item.key] = new Uint8Array(buf);
      manifest.push({ key: item.key, type: item.blob.type || 'image/png', size: buf.byteLength });
    }

    zipFiles['manifest.json'] = fflate.strToU8(JSON.stringify({ version: 2, images: manifest }));

    var zipU8 = fflate.zipSync(zipFiles, { level: 6 });
    var zipBlob = new Blob([zipU8], { type: 'application/zip' });
    downloadFile(zipBlob, getTimestamp() + '_DeepPage_Images.zip');
    showToast('图片库导出成功（' + items.length + ' 张）', 'success');
  } catch (err) {
    showToast('导出图片库失败：' + err.message, 'error');
  }
}

function importImageDB() {
  pickFile('.zip,.json', async function (file) {
    try {
      var isZip = file.name.toLowerCase().endsWith('.zip');
      var isOldJson = file.name.toLowerCase().endsWith('.json');

      if (isZip) {
        // 新格式：fflate zip
        var zipU8 = new Uint8Array(await file.arrayBuffer());
        var unzipped = fflate.unzipSync(zipU8);

        // 读取 manifest
        var manifestRaw = unzipped['manifest.json'];
        if (!manifestRaw) throw new Error('找不到 manifest.json，文件可能已损坏');
        var manifest = JSON.parse(fflate.strFromU8(manifestRaw));
        if (!manifest.images || !Array.isArray(manifest.images)) {
          throw new Error('无效的图片库备份文件');
        }

        var count = manifest.images.length;
        if (count === 0) { showToast('备份文件中没有图片', 'info'); return; }

        showImportConfirm('将导入 ' + count + ' 张图片到本地图片库，同名图片将被覆盖。确定继续吗？', async function () {
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
          showToast('图片库导入成功（' + imported + '/' + count + ' 张）', 'success');
          if (typeof renderSpeeddials === 'function') renderSpeeddials();
          setTimeout(function () { window.location.reload(); }, 1200);
        });

      } else if (isOldJson) {
        // 旧格式兼容：base64 JSON（v1.0.5 及之前）
        var text = await file.text();
        var data = JSON.parse(text);
        if (!data || !data.images || !Array.isArray(data.images)) {
          throw new Error('无效的图片库备份文件（缺少 images 数组）');
        }
        var count = data.images.length;
        if (count === 0) { showToast('备份文件中没有图片', 'info'); return; }

        showImportConfirm('检测到旧格式备份，将导入 ' + count + ' 张图片。确定继续吗？', async function () {
          var db = await openImgDB();
          var imported = 0;
          for (var i = 0; i < data.images.length; i++) {
            var img = data.images[i];
            if (!img.key || !img.data) continue;
            try {
              var blob = base64ToBlob(img.data, img.type || 'image/png');
              await new Promise(function (resolve, reject) {
                var tx = db.transaction('images', 'readwrite');
                tx.objectStore('images').put(blob, img.key);
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
              });
              imported++;
            } catch (e) { console.warn('导入图片失败:', img.key, e); }
          }
          showToast('图片库导入成功（' + imported + '/' + count + ' 张）', 'success');
          if (typeof renderSpeeddials === 'function') renderSpeeddials();
          setTimeout(function () { window.location.reload(); }, 1200);
        });

      } else {
        throw new Error('不支持的文件格式，请选择 .zip 或 .json 文件');
      }
    } catch (err) {
      showToast('导入图片库失败：' + err.message, 'error');
    }
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
  // 保底：5 秒后无论如何都刷新
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

function blobToBase64(blob) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = function () { reject(reader.error); };
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, type) {
  // base64 = "data:image/png;base64,xxxxx"
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
  var btnExportCfg  = document.getElementById('btn-export-config');
  var btnImportCfg  = document.getElementById('btn-import-config');
  var btnExportImg  = document.getElementById('btn-export-images');
  var btnImportImg  = document.getElementById('btn-import-images');
  var btnReset      = document.getElementById('btn-reset-all');

  if (btnExportCfg) btnExportCfg.addEventListener('click', exportConfig);
  if (btnImportCfg) btnImportCfg.addEventListener('click', importConfig);
  if (btnExportImg) btnExportImg.addEventListener('click', exportImageDB);
  if (btnImportImg) btnImportImg.addEventListener('click', importImageDB);
  if (btnReset)     btnReset.addEventListener('click', resetAll);
}
