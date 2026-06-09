/* ============================================================
   backup.js — 数据管理模块
   一键全部导出/导入：fflate Zip（配置 + 图片库）
   兼容旧版 .json 格式
   ============================================================ */

// ==================== 确认对话框 ====================

function showImportConfirm(msg, onOk, onCancel, opts) {
  opts = opts || {};
  var dlg = document.getElementById('dialog-import-confirm');
  var msgEl = document.getElementById('import-confirm-msg');
  var titleEl = dlg ? dlg.querySelector('h3') : null;
  var cardEl = dlg ? dlg.querySelector('.dialog-card') : null;
  var okBtn = document.getElementById('import-confirm-ok');
  var cancelBtn = document.getElementById('import-confirm-cancel');
  if (!dlg) { if (onOk) onOk(); return; }
  if (msgEl) msgEl.textContent = msg;
  if (titleEl) titleEl.textContent = opts.title || '确认导入';
  if (okBtn) okBtn.textContent = opts.okLabel || '确认导入';
  if (cancelBtn) cancelBtn.textContent = opts.cancelLabel || '取消';
  if (cardEl && opts.wider) cardEl.style.width = '420px';
  dlg.style.zIndex = '1010';
  dlg.classList.remove('hidden');

  var cleanup = function () {
    dlg.classList.add('hidden');
    dlg.style.zIndex = '';
    if (titleEl) titleEl.textContent = '确认导入';
    if (okBtn) okBtn.textContent = '确认导入';
    if (cancelBtn) cancelBtn.textContent = '取消';
    if (cardEl) cardEl.style.width = '';
  };
  if (okBtn) { okBtn.onclick = function () { cleanup(); if (onOk) onOk(); }; }
  if (cancelBtn) { cancelBtn.onclick = function () { cleanup(); if (onCancel) onCancel(); }; }
}

function showImportConfirmAsync(msg, opts) {
  return new Promise(function (resolve, reject) {
    showImportConfirm(msg, function () { resolve(); }, function () { reject(new Error('CANCELLED')); }, opts);
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
  // 点击空白处不再关闭弹窗
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

  // v1.2.2: 备份状态与下次提醒时间
  var statusEl = document.getElementById('backup-status-info');
  var nextEl = document.getElementById('backup-next-info');
  if (!statusEl || !nextEl) return;
  chrome.storage.sync.get(['settings'], function (sr) {
    var mode = (sr.settings && sr.settings.backupMode) || 'off';
    if (mode === 'off') { statusEl.style.display = 'none'; nextEl.style.display = 'none'; return; }
    statusEl.style.display = ''; nextEl.style.display = '';
    var timeStr = function (ts) { return new Date(ts).toLocaleString('zh-CN'); };
    if (mode === 'webdav') {
      chrome.storage.local.get(['webdav_last_backup'], function (r) {
        if (r.webdav_last_backup) {
          statusEl.textContent = '☁️ 上次云端备份：' + timeStr(r.webdav_last_backup);
        } else {
          statusEl.textContent = '☁️ 尚未进行云端备份';
        }
        nextEl.style.display = 'none';
      });
      // v1.2.6: 同步更新 WebDAV 配置状态
      chrome.storage.local.get(['webdav_url'], function (r2) {
        var cfgEl = document.getElementById('webdav-config-status');
        if (cfgEl && r2.webdav_url) {
          cfgEl.textContent = '✅ WebDAV 已配置：' + r2.webdav_url;
          cfgEl.style.color = '#16a34a';
          cfgEl.style.display = '';
        }
      });
    } else if (mode === 'remind') {
      chrome.storage.local.get(['remind_last_backup','remind_backup_skipped'], function (r) {
        if (r.remind_last_backup) {
          if (r.remind_backup_skipped) {
            statusEl.textContent = '⚠️ 上次备份已跳过（计时已开始）';
          } else {
            statusEl.textContent = '📥 上次本地备份：' + timeStr(r.remind_last_backup);
          }
          var days = (sr.settings && sr.settings.backupRemindDays) || 7;
          var next = new Date(new Date(r.remind_last_backup).getTime() + days * 86400 * 1000);
          nextEl.textContent = '⏰ 下次提醒时间：' + timeStr(next.toISOString());
        } else {
          statusEl.textContent = '📥 尚未进行本地备份';
          nextEl.textContent = '⏰ 开启后首次打开页面时将引导备份';
        }
      });
    }
  });
}

// ==================== v1.2.8: 增量备份核心 ====================

/** Web Crypto API 计算 Blob SHA-256，返回 hex 字符串 */
async function computeSHA256(blob) {
  var buf = await blob.arrayBuffer();
  var hash = await crypto.subtle.digest('SHA-256', buf);
  var hex = Array.from(new Uint8Array(hash)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  return hex;
}

/** 进度弹窗 DOM 引用与状态 */
var _progressState = { cancelled: false };

function _getProgressEls() {
  return {
    dlg: document.getElementById('dialog-backup-progress'),
    title: document.getElementById('backup-progress-title'),
    fill: document.getElementById('backup-progress-fill'),
    pct: document.getElementById('backup-progress-pct'),
    cancel: document.getElementById('backup-progress-cancel'),
    stages: {
      hash: document.getElementById('stage-hash'),
      diff: document.getElementById('stage-diff'),
      upload: document.getElementById('stage-upload'),
      config: document.getElementById('stage-config'),
      cleanup: document.getElementById('stage-cleanup')
    }
  };
}

function _showProgress(title) {
  var els = _getProgressEls();
  if (!els.dlg) return;
  _progressState.cancelled = false;
  els.title.textContent = title || '☁️ 正在备份到云端...';
  els.fill.style.width = '0%';
  els.pct.textContent = '0%';
  // 重置所有阶段状态
  var stageNames = ['hash', 'diff', 'upload', 'config', 'cleanup'];
  for (var i = 0; i < stageNames.length; i++) {
    var s = els.stages[stageNames[i]];
    if (s) { s.className = 'progress-stage pending'; s.innerHTML = s.innerHTML.replace(/^[⏳✅❌⏸]/, '⏸').replace(/^[⏳✅❌⏸]/, '⏸'); }
  }
  els.dlg.classList.remove('hidden');
  if (els.cancel) els.cancel.onclick = function () { _progressState.cancelled = true; };
}

function _hideProgress() {
  var dlg = document.getElementById('dialog-backup-progress');
  if (dlg) dlg.classList.add('hidden');
}

function _updateProgress(pct, stageKey, status, text) {
  var els = _getProgressEls();
  if (els.fill) els.fill.style.width = pct + '%';
  if (els.pct) els.pct.textContent = pct + '%';
  if (stageKey && els.stages[stageKey]) {
    var s = els.stages[stageKey];
    var icon = status === 'active' ? '⏳' : status === 'done' ? '✅' : status === 'error' ? '❌' : '⏸';
    s.className = 'progress-stage ' + status;
    s.innerHTML = icon + ' ' + (text || s.innerHTML.replace(/^[⏳✅❌⏸]\s*/, ''));
  }
}

/** 检测是否需要首次迁移（云端有旧 ZIP 但无 manifest） */
async function _checkMigrationNeeded() {
  try {
    var manifest = await webdavGetManifest();
    if (manifest && manifest.version) return false; // manifest 已存在，无需迁移
    var backups = await webdavListBackups();
    return backups && Array.isArray(backups) && backups.length > 0; // 有旧 ZIP
  } catch (e) { return false; }
}

/** 首次迁移：提示用户导出本地全量 ZIP，然后清理旧 ZIP 初始化 manifest */
async function _doFirstMigration() {
  var hasOld = await _checkMigrationNeeded();
  if (!hasOld) return true; // 无需迁移，直接继续

  return new Promise(function (resolve) {
    // 弹窗：建议导出本地备份
    var msg = '检测到云端有旧格式全量备份，即将切换为增量备份模式。\n建议先导出一份当前数据的本地备份：';
    showImportConfirmAsync(msg, { title: '🔄 切换增量备份', okLabel: '📥 导出本地备份', cancelLabel: '跳过，直接切换', wider: true }).then(function () {
      // 用户确认 → 导出本地 ZIP
      if (typeof showToast === 'function') showToast('请在下载完成后等待备份继续...', 'info');
      exportAll();
      // 清理旧 ZIP 文件
      webdavListBackups().then(function (files) {
        if (Array.isArray(files)) {
          var delTasks = files.map(function (f) { return webdavDeleteBackup(f.name).catch(function () {}); });
          return Promise.all(delTasks);
        }
      }).then(function () {
        resolve(true);
      }).catch(function () { resolve(true); });
    }).catch(function () {
      // 用户跳过 → 也继续（旧 ZIP 后续 GC 会清理）
      resolve(true);
    });
  });
}

/** 增量备份主函数 */
async function _incrementalBackup(data, isSilent) {
  var config = data.config;
  var images = data.images;
  var totalImages = images.length;

  // 显示进度
  if (!isSilent) _showProgress('☁️ 正在备份到云端...');
  var cancelCheck = function () { return _progressState.cancelled; };

  try {
    // 阶段 1: 计算图片哈希
    if (!isSilent) _updateProgress(0, 'hash', 'active', '计算图片哈希... (0/' + totalImages + ')');
    var hashMap = {};
    for (var i = 0; i < totalImages; i++) {
      if (cancelCheck()) { if (!isSilent) _hideProgress(); return false; }
      var img = images[i];
      try {
        hashMap[img.key] = await computeSHA256(img.blob);
      } catch (e) { hashMap[img.key] = 'err_' + img.key; }
      if (!isSilent && totalImages > 0) {
        _updateProgress(Math.round((i + 1) / totalImages * 25), 'hash', 'active', '计算图片哈希... (' + (i + 1) + '/' + totalImages + ')');
      }
    }
    if (!isSilent) _updateProgress(25, 'hash', 'done', '计算图片哈希... (' + totalImages + '/' + totalImages + ')');

    // 阶段 2: 对比云端 manifest
    if (!isSilent) _updateProgress(25, 'diff', 'active', '对比云端清单...');
    if (cancelCheck()) { if (!isSilent) _hideProgress(); return false; }

    var manifest = null;
    try { manifest = await webdavGetManifest(); } catch (e) { manifest = null; }
    if (!manifest || !manifest.images) manifest = { version: 1, images: {}, configs: [] };

    // 找出新增/变更的图片（MD5 不在 manifest 中的）
    var newImages = [];
    var existingMd5s = new Set();
    var manifestImages = manifest.images || {};
    var keys = Object.keys(manifestImages);
    for (var ki = 0; ki < keys.length; ki++) {
      existingMd5s.add(manifestImages[keys[ki]].md5);
    }

    for (var j = 0; j < totalImages; j++) {
      var md5 = hashMap[images[j].key];
      if (!md5 || md5.startsWith('err_')) continue;
      if (!existingMd5s.has(md5)) {
        newImages.push({ key: images[j].key, blob: images[j].blob, md5: md5 });
      }
    }
    if (!isSilent) _updateProgress(30, 'diff', 'done', '对比云端清单... (' + newImages.length + ' 张新图片)');

    // 阶段 3: 上传新图片
    var uploadedCount = 0;
    if (newImages.length > 0) {
      if (!isSilent) _updateProgress(30, 'upload', 'active', '上传图片... (0/' + newImages.length + ')');
      for (var ni = 0; ni < newImages.length; ni++) {
        if (cancelCheck()) { if (!isSilent) _hideProgress(); return false; }
        try {
          await webdavPutImage(newImages[ni].md5, newImages[ni].blob);
          uploadedCount++;
        } catch (e) {
          if (!isSilent) console.warn('图片上传失败:', newImages[ni].key, e.message);
        }
        if (!isSilent) {
          var upPct = 30 + Math.round((ni + 1) / newImages.length * 55);
          _updateProgress(upPct, 'upload', 'active', '上传图片... (' + (ni + 1) + '/' + newImages.length + ')');
        }
      }
    }
    if (!isSilent) _updateProgress(85, 'upload', 'done', '上传图片... (' + uploadedCount + '/' + newImages.length + ')');

    // 更新 manifest（记录所有图片的 MD5 和 refs）
    var configName = _genConfigName();
    for (var kj = 0; kj < totalImages; kj++) {
      var img2 = images[kj];
      var md5_2 = hashMap[img2.key];
      if (!md5_2 || md5_2.startsWith('err_')) continue;
      if (!manifestImages[img2.key]) {
        manifestImages[img2.key] = { md5: md5_2, size: img2.blob.size, type: img2.blob.type || 'image/png', refs: [] };
      }
      // 更新 refs
      var refs = manifestImages[img2.key].refs || [];
      if (refs.indexOf(configName) === -1) refs.push(configName);
      manifestImages[img2.key].refs = refs;
    }

    // 阶段 4: 保存配置快照 + 上传 manifest
    if (!isSilent) _updateProgress(85, 'config', 'active', '保存配置快照...');
    if (cancelCheck()) { if (!isSilent) _hideProgress(); return false; }

    var configSnapshot = {
      settings: config.settings || {},
      groups: config.groups || [],
      activeGroup: config.activeGroup || 0,
      imageRefs: {}
    };
    for (var mk = 0; mk < totalImages; mk++) {
      var k = images[mk].key;
      if (hashMap[k] && !hashMap[k].startsWith('err_')) {
        configSnapshot.imageRefs[k] = hashMap[k];
      }
    }

    try { await webdavPutConfig(configName, configSnapshot); } catch (e) {
      if (!isSilent) { _updateProgress(85, 'config', 'error', '保存配置失败: ' + e.message); _hideProgress(); }
      return false;
    }

    // 更新 configs 列表
    var configs = manifest.configs || [];
    configs.unshift({ name: configName, time: new Date().toISOString(), cardCount: _countCards(config.groups) });
    // 保留最近 5 个 config
    var oldConfigs = configs.slice(5);
    configs = configs.slice(0, 5);
    manifest.configs = configs;
    manifest.images = manifestImages;

    try { await webdavPutManifest(manifest); } catch (e) {
      if (!isSilent) { _updateProgress(85, 'config', 'error', '上传清单失败: ' + e.message); _hideProgress(); }
      return false;
    }
    if (!isSilent) _updateProgress(92, 'config', 'done', '配置快照已保存');

    // 阶段 5: 孤儿 GC — 清理无引用的图片和过期 config
    if (!isSilent) _updateProgress(92, 'cleanup', 'active', '清理旧文件...');
    // 收集所有被引用的 MD5
    var referencedMd5s = new Set();
    var allImages = manifest.images || {};
    var imgKeys = Object.keys(allImages);
    for (var ri = 0; ri < configs.length; ri++) {
      var cfgName = configs[ri].name;
      for (var rj = 0; rj < imgKeys.length; rj++) {
        var refs2 = allImages[imgKeys[rj]].refs || [];
        if (refs2.indexOf(cfgName) !== -1) {
          referencedMd5s.add(allImages[imgKeys[rj]].md5);
        }
      }
    }

    // 删除过期 config 文件
    for (var oc = 0; oc < oldConfigs.length; oc++) {
      try { await webdavDeleteConfig(oldConfigs[oc].name); } catch (e) {}
    }

    // 列出云端 img 目录，删除无引用的图片
    try {
      var imgFiles = await webdavListImages();
      if (Array.isArray(imgFiles)) {
        for (var fi = 0; fi < imgFiles.length; fi++) {
          var md5InCloud = imgFiles[fi].name.replace(/\.bin$/i, '');
          if (md5InCloud && !referencedMd5s.has(md5InCloud)) {
            try { await webdavDeleteImage(imgFiles[fi].name); } catch (e) {}
          }
        }
      }
    } catch (e) { /* GC 失败不影响主流程 */ }

    // 清理 manifest.images 中无引用的条目
    var cleanedImages = {};
    for (var ci = 0; ci < imgKeys.length; ci++) {
      var key = imgKeys[ci];
      var item = allImages[key];
      var itemRefs = item.refs || [];
      var stillReferenced = false;
      for (var sr = 0; sr < configs.length; sr++) {
        if (itemRefs.indexOf(configs[sr].name) !== -1) { stillReferenced = true; break; }
      }
      if (stillReferenced) cleanedImages[key] = item;
    }
    manifest.images = cleanedImages;

    if (!isSilent) _updateProgress(100, 'cleanup', 'done', '清理完成');

    // 更新备份时间
    setWebdavLastBackupFilename(configName);
    setWebdavLastBackup(new Date().toISOString());

    if (!isSilent) {
      _updateProgress(100, 'cleanup', 'done', '备份完成！');
      setTimeout(function () { _hideProgress(); }, 800);
      if (typeof showToast === 'function') showToast('☁️ 增量备份完成' + (newImages.length > 0 ? '（' + uploadedCount + ' 张新图片已上传）' : ''), 'success');
    }
    return true;
  } catch (e) {
    if (!isSilent) { _hideProgress(); if (typeof showToast === 'function') showToast('备份失败: ' + e.message, 'error'); }
    return false;
  }
}

/** 统计卡片总数 */
function _countCards(groups) {
  if (!groups || !Array.isArray(groups)) return 0;
  var total = 0;
  for (var i = 0; i < groups.length; i++) {
    total += (groups[i].cards || []).length;
  }
  return total;
}

/** v1.2.8: 增量备份入口（手动触发） */
async function webdavIncrementalBackup() {
  // 检查是否需要迁移
  var needMigration = await _checkMigrationNeeded();
  if (needMigration) {
    var migrated = await _doFirstMigration();
    if (!migrated) return;
  }

  // 收集数据
  var data = await _collectAllData();
  // 执行增量备份
  var ok = await _incrementalBackup(data, false);
  if (ok) {
    // 提示导出本地 ZIP
    setTimeout(function () {
      var msg = '增量备份完成！建议同时导出一份本地全量备份：';
      showImportConfirmAsync(msg, { title: '☁️ 备份完成', okLabel: '📥 导出本地备份', cancelLabel: '以后再说', wider: true }).then(function () { exportAll(); }).catch(function () {});
    }, 1200);
    // 清理旧 ZIP（如果还有残留）
    webdavCleanupBackups(1).catch(function () {});
  }
}

/** v1.2.8: 增量恢复入口 */
async function webdavIncrementalRestore() {
  // 获取 manifest
  var manifest = null;
  try { manifest = await webdavGetManifest(); } catch (e) {
    if (typeof showToast === 'function') showToast('获取云端备份失败: ' + e.message, 'error');
    return;
  }
  if (!manifest || !manifest.configs || manifest.configs.length === 0) {
    // 回退到旧 ZIP 恢复：触发按钮 click 走原有流程
    if (typeof showToast === 'function') showToast('云端暂无增量备份，列出旧格式备份...', 'info');
    var btnRestore = document.getElementById('btn-webdav-restore');
    if (btnRestore) {
      // 临时解除增量恢复绑定，直接列出旧 ZIP
      webdavListBackups().then(function (backupList) {
        var versionPicker = document.getElementById('webdav-version-picker');
        var versionList = document.getElementById('webdav-version-list');
        if (!versionPicker || !versionList) return;
        if (!Array.isArray(backupList) || backupList.length === 0) {
          if (typeof showToast === 'function') showToast('云端暂无备份文件', 'warning');
          return;
        }
        var html = '';
        for (var i = 0; i < backupList.length; i++) {
          var f = backupList[i];
          var fn = f.name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
          var timeStr = (f.lastModified || '-').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          var checked = i === 0 ? ' checked' : '';
          html += '<label class="webdav-version-item"><input type="radio" name="webdav-version" value="' + fn + '"' + checked + '><span class="webdav-version-info"><strong>' + fn + '</strong><br><small>' + timeStr + '</small></span><span class="version-delete" data-name="' + fn + '" data-type="zip" title="删除此备份">🗑️</span></label>';
        }
        versionList.innerHTML = html;
        versionPicker.classList.remove('hidden');
      }).catch(function () {
        if (typeof showToast === 'function') showToast('无法连接 WebDAV', 'error');
      });
    }
    return;
  }

  var configs = manifest.configs;
  // 显示版本列表
  var versionPicker = document.getElementById('webdav-version-picker');
  var versionList = document.getElementById('webdav-version-list');
  if (!versionPicker || !versionList) return;
  var html = '';
  for (var i = 0; i < configs.length; i++) {
    var c = configs[i];
    var checked = i === 0 ? ' checked' : '';
    var timeStr = c.time ? new Date(c.time).toLocaleString('zh-CN') : '-';
    html += '<label class="webdav-version-item"><input type="radio" name="webdav-version" value="' + c.name + '"' + checked + '><span class="webdav-version-info"><strong>' + timeStr + '</strong><br><small>' + c.cardCount + ' 张卡片</small></span><span class="version-delete" data-name="' + c.name + '" data-type="config" title="删除此备份">🗑️</span></label>';
  }
  versionList.innerHTML = html;
  versionPicker.classList.remove('hidden');
}

/** v1.2.8: 执行增量恢复（下载选定版本的 config + 按需下载图片） */
async function _doIncrementalRestore(configName) {
  var msg = '从云端恢复将覆盖当前所有数据，是否继续？';
  try { await showImportConfirmAsync(msg); } catch (e) { return; }

  var loading = document.getElementById('backup-loading');
  if (loading) loading.classList.remove('hidden');

  try {
    // 1. 下载配置快照
    var config = await webdavGetConfig(configName);
    if (!config || !config.groups) throw new Error('配置快照无效');

    // 2. 按需下载图片
    var imageRefs = config.imageRefs || {};
    var md5Keys = Object.keys(imageRefs);
    var db = await openImgDB();
    var downloadedCount = 0;

    if (md5Keys.length > 0) {
      // 并行下载，每次最多 4 个
      var batchSize = 4;
      for (var bi = 0; bi < md5Keys.length; bi += batchSize) {
        var batch = md5Keys.slice(bi, bi + batchSize);
        var results = await Promise.all(batch.map(function (key) {
          var md5 = imageRefs[key];
          return webdavGetImage(md5).then(function (blob) {
            return { key: key, blob: blob };
          }).catch(function () { return null; });
        }));

        for (var ri = 0; ri < results.length; ri++) {
          if (!results[ri]) continue;
          try {
            await new Promise(function (resolve, reject) {
              var tx = db.transaction('images', 'readwrite');
              tx.objectStore('images').put(results[ri].blob, results[ri].key);
              tx.oncomplete = function () { resolve(); };
              tx.onerror = function () { reject(tx.error); };
            });
            downloadedCount++;
          } catch (e) { console.warn('写入图片失败:', results[ri].key, e); }
        }
      }
    }

    // 3. 写入配置到 storage
    var syncFailed = false;
    await new Promise(function (resolve) {
      chrome.storage.sync.set({
        settings: config.settings || {},
        groups: config.groups || [],
        activeGroup: config.activeGroup || 0
      }, function () {
        if (chrome.runtime.lastError) syncFailed = true;
        resolve();
      });
    });
    if (syncFailed) {
      var fSettings = config.settings || {};
      fSettings.storageFallback = 'local';
      await new Promise(function (resolve) {
        chrome.storage.local.set({ groups: config.groups || [], activeGroup: config.activeGroup || 0 }, resolve);
      });
      var ssf2 = false;
      await new Promise(function (resolve) {
        chrome.storage.sync.set({ settings: fSettings, groups: [], activeGroup: 0 }, function () {
          if (chrome.runtime.lastError) ssf2 = true;
          resolve();
        });
      });
      if (ssf2) {
        await new Promise(function (resolve) { chrome.storage.local.set({ settings: fSettings }, resolve); });
      }
    }

    if (typeof collectCardImageGarbage === 'function') await collectCardImageGarbage();

    setWebdavLastBackupFilename(configName);
    setWebdavLastBackup(new Date().toISOString());

    if (typeof showToast === 'function') showToast('☁️ 已从云端恢复（' + downloadedCount + ' 张图片），即将刷新...', 'success');
    setTimeout(function () { window.location.reload(); }, 1500);
  } catch (e) {
    if (typeof showToast === 'function') showToast('恢复失败: ' + e.message, 'error');
  } finally {
    if (loading) loading.classList.add('hidden');
  }
}

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
  // v1.2.6: 并行读取 sync 和 IndexedDB
  var [syncData, db] = await Promise.all([
    new Promise(function (resolve) {
      chrome.storage.sync.get(null, function (result) { resolve(result); });
    }),
    openImgDB()
  ]);

  var config = syncData;
  if (!config.groups || (Array.isArray(config.groups) && config.groups.length === 0)) {
    var localData = await new Promise(function (resolve) {
      chrome.storage.local.get(['groups', 'activeGroup'], function (result) { resolve(result); });
    });
    if (localData.groups && Array.isArray(localData.groups) && localData.groups.length > 0) {
      config = config || {};
      config.groups = localData.groups;
      config.activeGroup = localData.activeGroup;
    }
  }
  if (config.settings) config.settings._exportTime = new Date().toLocaleString('zh-CN');

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

  // v1.2.9: 重复卡片检查
  var btnDupCheck = document.getElementById('btn-check-duplicates');
  if (btnDupCheck) btnDupCheck.addEventListener('click', function () {
    if (typeof showDuplicateCheckDialog === 'function') showDuplicateCheckDialog();
  });

  // v1.2.8: 版本列表删除按钮事件委托
  var versionList = document.getElementById('webdav-version-list');
  if (versionList) {
    versionList.addEventListener('click', async function (e) {
      var delBtn = e.target.closest('.version-delete');
      if (!delBtn) return;
      e.stopPropagation();
      e.preventDefault();
      var name = delBtn.getAttribute('data-name');
      var type = delBtn.getAttribute('data-type');
      if (!name) return;
      try {
        // 确认删除
        await showImportConfirmAsync('确定要删除此备份版本吗？\n删除后无法恢复。', { title: '🗑️ 确认删除', okLabel: '删除', cancelLabel: '取消' });
      } catch (e) { return; } // 用户取消
      try {
        if (type === 'zip') {
          await webdavDeleteBackup(name);
        } else if (type === 'config') {
          await webdavDeleteConfig(name);
          // 更新云端 manifest 移除该 config
          try {
            var m = await webdavGetManifest();
            if (m && m.configs) {
              m.configs = m.configs.filter(function (c) { return c.name !== name; });
              await webdavPutManifest(m);
            }
          } catch (e) {}
        }
        // 从 DOM 移除该行
        var label = delBtn.closest('.webdav-version-item');
        if (label) {
          var radio = label.querySelector('input[type="radio"]');
          var wasChecked = radio && radio.checked;
          label.remove();
          // 如果删除的是选中项，自动选第一个
          if (wasChecked) {
            var first = versionList.querySelector('input[type="radio"]');
            if (first) first.checked = true;
          }
        }
        if (typeof showToast === 'function') showToast('已删除', 'info');
      } catch (err) {
        if (typeof showToast === 'function') showToast('删除失败: ' + err.message, 'error');
      }
    });
  }
}
