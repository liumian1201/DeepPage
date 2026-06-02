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

// ==================== 图片库（IndexedDB） ====================

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

    // Blob → base64
    var exportData = [];
    for (var i = 0; i < items.length; i++) {
      var base64 = await blobToBase64(items[i].blob);
      exportData.push({
        key: items[i].key,
        type: items[i].blob.type || 'image/png',
        data: base64
      });
    }

    var json = JSON.stringify({ version: 1, images: exportData }, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    downloadFile(blob, getTimestamp() + '_DeepPage_Images.json');
    showToast('图片库导出成功（' + exportData.length + ' 张）', 'success');
  } catch (err) {
    showToast('导出图片库失败：' + err.message, 'error');
  }
}

function importImageDB() {
  pickFile('.json', async function (file) {
    try {
      var text = await file.text();
      var data = JSON.parse(text);

      if (!data || !data.images || !Array.isArray(data.images)) {
        throw new Error('无效的图片库备份文件（缺少 images 数组）');
      }

      var count = data.images.length;
      if (count === 0) {
        showToast('备份文件中没有图片', 'info');
        return;
      }

      showImportConfirm('将导入 ' + count + ' 张图片到本地图片库，同名图片将被覆盖。确定继续吗？', async function () {
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
          } catch (e) {
            console.warn('导入图片失败:', img.key, e);
          }
        }
        showToast('图片库导入成功（' + imported + '/' + count + ' 张），建议刷新页面。', 'success');
        // 立即刷新卡片以加载新导入的图片
        if (typeof renderSpeeddials === 'function') renderSpeeddials();
        setTimeout(function () { window.location.reload(); }, 1200);
      });
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
