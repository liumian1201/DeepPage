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
    // v1.3.3: 合并写窗口内可能有未落盘的设置/分组 → 导出前先 flush，否则备份的是旧数据
    if (typeof flushSyncWrites === 'function') await flushSyncWrites();
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

    zipFiles['config.json'] = fflate.strToU8(JSON.stringify(_withSchemaVersion(config)));
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
    // v1.3.3: 先把合并写窗口内的待写数据落盘，否则它可能在导入完成后才落地，把导入的数据覆盖回去
    if (typeof flushSyncWrites === 'function') await flushSyncWrites();
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
              activeGroup: data.activeGroup || 0,
              // BUG-036: 与数据同一次写入版本号，避免旧 local 兜底数据反超 sync
              groups_rev: Date.now()
            }, function () {
              if (chrome.runtime.lastError) oldSyncFailed = true;
              resolve();
            });
          });
          if (oldSyncFailed) {
            var oldFSettings = data.settings || {};
            oldFSettings.storageFallback = 'local';
            await new Promise(function (resolve) {
              chrome.storage.local.set({ groups: data.groups || [], activeGroup: data.activeGroup || 0, groups_rev: Date.now() }, resolve);
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

async function doResetAll() {
  // v1.3.3: 先落盘再清空，避免清空后仍有待写数据落地
  if (typeof flushSyncWrites === 'function') await flushSyncWrites();
  // BUG-068：兜底清空 blob URL 缓存 —— 整库即将删除，所有 blob: URL 都会失效。
  // 该函数原先全仓库无调用方（死代码），这里接上真正的「重置全部数据」路径。
  if (typeof _clearAllBlobCaches === 'function') _clearAllBlobCaches();
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

/** v1.3.3: 文本 sha256（用于配置快照完整性校验） */
async function computeSHA256Text(text) {
  var bytes = new TextEncoder().encode(text);
  var hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

/* ==================== v1.3.3: 备份重试队列 ====================
   云端备份失败（断网/服务不可达）不再静默丢弃：写入 local 队列，联网或下次启动时按退避重试。
   最多 3 次，之后清除并提示用户手动备份。
*/
var BACKUP_RETRY_KEY = 'webdav_retry_job';
var BACKUP_RETRY_MAX = 3;
var BACKUP_RETRY_BACKOFF_MS = [2 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000];

function _enqueueBackupRetry(reason) {
  return new Promise(function (resolve) {
    chrome.storage.local.get([BACKUP_RETRY_KEY], function (r) {
      var job = r[BACKUP_RETRY_KEY] || { attempts: 0 };
      job.attempts = (job.attempts || 0) + 1;
      job.reason = reason || job.reason || 'unknown';
      job.lastAttemptAt = new Date().toISOString();
      job.nextAt = Date.now() + (BACKUP_RETRY_BACKOFF_MS[Math.min(job.attempts - 1, BACKUP_RETRY_BACKOFF_MS.length - 1)]);
      chrome.storage.local.set({ [BACKUP_RETRY_KEY]: job }, function () { resolve(job); });
    });
  });
}

function _clearBackupRetry() {
  return new Promise(function (resolve) { chrome.storage.local.remove([BACKUP_RETRY_KEY], resolve); });
}

function _getBackupRetry() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([BACKUP_RETRY_KEY], function (r) { resolve(r[BACKUP_RETRY_KEY] || null); });
  });
}

/** 有待重试任务且已到退避时间 → 静默重试一次 */
async function _processBackupRetry() {
  var job = await _getBackupRetry();
  if (!job) return false;
  if (job.attempts >= BACKUP_RETRY_MAX) {
    await _clearBackupRetry();
    if (typeof showToast === 'function') showToast('⚠️ 云端备份连续失败 ' + job.attempts + ' 次，已停止重试，请手动备份', 'warning');
    return false;
  }
  if (!navigator.onLine) return false;
  if (job.nextAt && Date.now() < job.nextAt) return false;
  try {
    var data = await _collectAllData();
    var ok = await _incrementalBackup(data, true);
    if (ok === false) throw new Error('备份返回失败');
    await _clearBackupRetry();
    if (typeof showToast === 'function') showToast('✅ 云端备份重试成功', 'success');
    return true;
  } catch (e) {
    await _enqueueBackupRetry(e.message || 'retry failed');
    return false;
  }
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
          var delTasks = files.map(function (f) { return webdavDeleteBackup(f.name).catch(function (e) { _warnDegraded('清理旧全量备份 ' + f.name, e); }); });
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
  // v1.3.3: 「仅配置」模式跳过图片，只上传配置快照（省流量/时间）
  var configOnly = !!(config.settings && config.settings.backupIncludeImages === false);
  var images = configOnly ? [] : data.images;
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
    // BUG-040：上传失败的图片**绝不能**写进 manifest / imageRefs
    //  （原先 catch 只 console.warn，随后无条件把每张本地图片都记进 manifest；
    //    下一轮备份又按 manifest 里的 md5 判定「已在云端」而跳过重传 → 云端永久缺图且不可自愈）
    var failedMd5s = new Set();
    if (newImages.length > 0) {
      if (!isSilent) _updateProgress(30, 'upload', 'active', '上传图片... (0/' + newImages.length + ')');
      for (var ni = 0; ni < newImages.length; ni++) {
        if (cancelCheck()) { if (!isSilent) _hideProgress(); return false; }
        try {
          await webdavPutImage(newImages[ni].md5, newImages[ni].blob);
          uploadedCount++;
        } catch (e) {
          failedMd5s.add(newImages[ni].md5);
          if (!isSilent) console.warn('图片上传失败（不记入清单，下次重试）:', newImages[ni].key, e.message);
        }
        if (!isSilent) {
          var upPct = 30 + Math.round((ni + 1) / newImages.length * 55);
          _updateProgress(upPct, 'upload', 'active', '上传图片... (' + (ni + 1) + '/' + newImages.length + ')');
        }
      }
    }
    if (!isSilent) _updateProgress(85, 'upload', 'done', '上传图片... (' + uploadedCount + '/' + newImages.length + ')');

    // 更新 manifest（记录所有图片的 MD5 和 refs）—— 跳过上传失败的 md5
    var configName = _genConfigName();
    for (var kj = 0; kj < totalImages; kj++) {
      var img2 = images[kj];
      var md5_2 = hashMap[img2.key];
      if (!md5_2 || md5_2.startsWith('err_')) continue;
      if (failedMd5s.has(md5_2)) continue;   // BUG-040
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
      if (hashMap[k] && !hashMap[k].startsWith('err_') && !failedMd5s.has(hashMap[k])) {
        configSnapshot.imageRefs[k] = { md5: hashMap[k], type: images[mk].blob.type || 'image/png' };
      }
    }

    try { await webdavPutConfig(configName, configSnapshot); } catch (e) {
      if (!isSilent) { _updateProgress(85, 'config', 'error', '保存配置失败: ' + e.message); _hideProgress(); }
      return false;
    }

    // 更新 configs 列表（v1.3.3: 记录配置快照的 sha256，恢复时校验完整性）
    var configs = manifest.configs || [];
    var configSha = null;
    try { configSha = await computeSHA256Text(JSON.stringify(configSnapshot)); } catch (e) { configSha = null; }
    configs.unshift({
      name: configName,
      time: new Date().toISOString(),
      cardCount: _countCards(config.groups),
      sha256: configSha,
      configOnly: configOnly
    });
    // 保留最近 5 个 config
    var oldConfigs = configs.slice(5);
    configs = configs.slice(0, 5);
    manifest.configs = configs;
    // 注意：manifest 的上传移到阶段 5 的清理之后（BUG-061），避免「清理结果永不落云端」

    // 阶段 5: 孤儿 GC — 清理无引用的图片和过期 config
    if (!isSilent) _updateProgress(92, 'cleanup', 'active', '清理旧文件...');

    // 5.1 先在内存里收缩 manifest.images：丢掉无引用的条目，并把已淘汰 config 名从 refs 里剔除
    //     （refs 不收缩的话，下一轮备份会读到陈旧引用，判定「仍被引用」而永不回收）
    var allImages = manifestImages;
    var imgKeys = Object.keys(allImages);
    var keptNames = configs.map(function (c) { return c.name; });
    var cleanedImages = {};
    var referencedMd5s = new Set();
    for (var ci = 0; ci < imgKeys.length; ci++) {
      var key = imgKeys[ci];
      var item = allImages[key] || {};
      var itemRefs = (item.refs || []).filter(function (r) { return keptNames.indexOf(r) !== -1; });
      if (!itemRefs.length) continue;
      cleanedImages[key] = { md5: item.md5, size: item.size, type: item.type, refs: itemRefs };
      referencedMd5s.add(item.md5);
    }
    manifest.images = cleanedImages;

    // 5.2 上传收缩后的 manifest（含本轮新 config）
    //     BUG-061：原先这一步在清理**之前**执行，之后算出的 cleanedImages 只改了内存、
    //     没有任何一次上传 → 云端 manifest.json 只增不减（幽灵引用还会让同内容图片不再重传）。
    //     顺序选择：先上传清单再删文件 —— 中途失败只会留下多余文件（无害），不会出现「清单引用了已删文件」。
    try { await webdavPutManifest(manifest); } catch (e) {
      if (!isSilent) { _updateProgress(92, 'config', 'error', '上传清单失败: ' + e.message); _hideProgress(); }
      return false;
    }
    if (!isSilent) _updateProgress(95, 'config', 'done', '配置快照已保存');

    // 5.3 删除过期 config 文件
    for (var oc = 0; oc < oldConfigs.length; oc++) {
      try { await webdavDeleteConfig(oldConfigs[oc].name); } catch (e) { _warnDegraded('删除过期配置快照 ' + oldConfigs[oc].name, e); }
    }

    // 5.4 列出云端 img 目录，删除无引用的图片
    try {
      var imgFiles = await webdavListImages();
      if (Array.isArray(imgFiles)) {
        for (var fi = 0; fi < imgFiles.length; fi++) {
          var md5InCloud = imgFiles[fi].name.replace(/\.bin$/i, '');
          if (md5InCloud && !referencedMd5s.has(md5InCloud)) {
            try { await webdavDeleteImage(imgFiles[fi].name); } catch (e) { _warnDegraded('删除云端孤儿图片 ' + imgFiles[fi].name, e); }
          }
        }
      }
    } catch (e) { /* GC 失败不影响主流程 */ }

    if (!isSilent) _updateProgress(100, 'cleanup', 'done', '清理完成');

    // 更新备份时间
    setWebdavLastBackupFilename(configName);
    setWebdavLastBackup(new Date().toISOString());

    // BUG-040：有图片没传上去 → 本次备份不算成功，交给重试队列；manifest 里也没有它们的记录，
    // 所以下一轮会重新尝试上传（而不是像修复前那样永远跳过）。
    if (failedMd5s.size > 0) {
      if (!isSilent) {
        _updateProgress(100, 'cleanup', 'error', failedMd5s.size + ' 张图片上传失败，将在下次备份重试');
        _hideProgress();
        if (typeof showToast === 'function') showToast('⚠️ ' + failedMd5s.size + ' 张图片上传失败，已从本次云端清单中排除，下次备份会自动重试', 'warning');
      }
      return false;
    }

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
      showImportConfirmAsync(msg, { title: '☁️ 备份完成', okLabel: '📥 导出本地备份', cancelLabel: '以后再说', wider: true }).then(function () { exportAll(); }).catch(function (e) {
        // DEBT-02: 用户点「以后再说」时该弹窗以 CANCELLED 拒绝 —— 那是正常选择，不算失败；
        // 其它错误（弹窗链路真坏了）必须留下痕迹，否则「备份完成后建议导出」这条提示会静默消失。
        if (!e || e.message !== 'CANCELLED') _warnDegraded('备份完成后的导出提示', e);
      });
    }, 1200);
    // 清理旧 ZIP（如果还有残留）
    webdavCleanupBackups(1).catch(function (e) { _warnDegraded('清理旧 ZIP 备份', e); });
  }
}

/** BUG-050：属性/文本安全的 HTML 转义
 *  注意不能用 main.js 的 escapeHtml()（走 div.innerHTML，只转义 &<> ，**不转义引号**），
 *  属性值里出现引号会截断 value="" / data-name=""，使「看到的行」与「删掉的文件」不一致。 */
function _escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** BUG-050：版本列表渲染（原先三处手工拼 HTML，只有两处做了转义 → 云端 manifest 的 name/cardCount 可注入）
 *  同时接上 BUG-042 的文件名白名单：非法名的行**不可选、不可删**，只留一行警告，
 *  这样服务端返回 '"><img src=...>' 这类名字时既注入不了，也不会成为删除目标。
 *  @param {Array<{name:string,label:string,sub:string}>} items
 *  @param {'zip'|'config'} type
 */
function _renderVersionListHTML(items, type) {
  var html = '';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var safe = isSafeRemoteName(it.name);
    var nm = _escapeAttr(it.name);
    var checked = (i === 0 && safe) ? ' checked' : '';
    html += '<label class="webdav-version-item' + (safe ? '' : ' webdav-version-invalid') + '">'
      + '<input type="radio" name="webdav-version" value="' + nm + '"' + checked + (safe ? '' : ' disabled') + '>'
      + '<span class="webdav-version-info"><strong>' + _escapeAttr(it.label) + '</strong>'
      + '<br><small>' + _escapeAttr(it.sub) + '</small></span>'
      + (safe
        ? '<span class="version-delete" data-name="' + nm + '" data-type="' + type + '" title="删除此备份">🗑️</span>'
        : '<span class="version-invalid-tip" title="云端返回了非法文件名，已拒绝操作">⚠️ 已忽略</span>')
      + '</label>';
  }
  return html;
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
        var html = _renderVersionListHTML(backupList.map(function (f) {
          return { name: f.name, label: f.name, sub: f.lastModified || '-' };
        }), 'zip');
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
  // BUG-050：c.name / c.cardCount 来自云端 manifest，必须转义 + 白名单（原先这一支零转义）
  versionList.innerHTML = _renderVersionListHTML(configs.map(function (c) {
    return {
      name: c && c.name,
      label: (c && c.time) ? new Date(c.time).toLocaleString('zh-CN') : '-',
      sub: String((c && c.cardCount) != null ? c.cardCount : 0) + ' 张卡片'
    };
  }), 'config');
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

    // v1.3.3: 完整性校验 —— 用 manifest 里记录的 sha256 比对，损坏/截断时中止
    try {
      var manifestForCheck = await webdavGetManifest();
      var entry = (manifestForCheck && manifestForCheck.configs || []).find(function (c) { return c.name === configName; });
      if (entry && entry.sha256) {
        var actual = await computeSHA256Text(JSON.stringify(config));
        if (actual !== entry.sha256) {
          if (loading) loading.classList.add('hidden');
          throw new Error('配置快照校验失败（sha256 不匹配），已中止恢复');
        }
      } else if (entry && entry.configOnly && typeof showToast === 'function') {
        showToast('ℹ️ 该备份为「仅配置」模式，不包含图片', 'info');
      }
    } catch (e) {
      if (/校验失败/.test(e.message)) throw e;
      console.warn('[恢复] 完整性校验跳过:', e.message);
    }

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
          var ref = imageRefs[key];
          // 兼容旧格式（纯字符串 md5）和新格式（{ md5, type }）
          var md5 = typeof ref === 'string' ? ref : (ref && ref.md5 ? ref.md5 : ref);
          var mime = (ref && ref.type) ? ref.type : 'image/png';
          return webdavGetImage(md5).then(function (blob) {
            // 用正确的 MIME 重新创建 blob
            if (blob.type !== mime) {
              blob = new Blob([blob], { type: mime });
            }
            return { key: key, blob: blob };
          }).catch(function (e) { console.warn('[恢复] 下载失败:', key, e.message); return null; });
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
    // BUG-043：云端恢复与 ZIP 导入共用同一套白名单（manifest 同样来自服务端，不可信）
    var safeSettings = normalizeImportedSettings(config.settings);
    var rejected = countRejectedSettings(config.settings, safeSettings);
    if (rejected > 0) {
      console.warn('[恢复] 已忽略 ' + rejected + ' 项未知/不合法的设置');
      if (typeof showToast === 'function') {
        showToast('⚠️ 已忽略 ' + rejected + ' 项未知或不合法的设置（备份可能被篡改）', 'warning');
      }
    }
    var syncFailed = false;
    await new Promise(function (resolve) {
      chrome.storage.sync.set({
        settings: safeSettings,
        groups: config.groups || [],
        activeGroup: config.activeGroup || 0,
        groups_rev: Date.now()   // BUG-036: 版本号随数据同写
      }, function () {
        if (chrome.runtime.lastError) syncFailed = true;
        resolve();
      });
    });
    if (syncFailed) {
      var fSettings = safeSettings;
      fSettings.storageFallback = 'local';
      await new Promise(function (resolve) {
        chrome.storage.local.set({ groups: config.groups || [], activeGroup: config.activeGroup || 0, groups_rev: Date.now() }, resolve);
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

/* ==================== BUG-043 / AUD-004：导入设置白名单 ====================
   导入（ZIP）与云端恢复原先把 config.settings **原样**写进 storage，而全仓唯一的 URL 校验
   在搜索引擎 UI 里（search-engines.js 的 /^https:\/\/.+\{q\}/i），导入路径完全绕过它。
   于是一份不可信备份就能：把搜索重定向到攻击者站点、让每个新标签页向任意地址发请求
   （wallpaperUrl → new Image().src）、把天气 API key 发到攻击者服务器
   （weatherApiUrl 里的 {key} 会被替换成真实 key）。
   这里做三件事：① 以 DEFAULT_SETTINGS 的键集合为白名单取交集（未知键一律丢弃，
   同时天然挡住 __proto__ / constructor 这类原型污染键）；② 逐键类型/范围/枚举校验，
   不合法就回落默认值；③ URL 类字段强制 https。
   两条导入路径（ZIP 导入 / WebDAV 云端恢复）共用本函数，避免再次分叉。 */

/** 当前导出格式版本（写入 config.schemaVersion，供将来迁移） */
var IMPORT_SCHEMA_VERSION = 1;

/** 不在 DEFAULT_SETTINGS 里、但确属合法设置数据的键（表单管不到，由看板模块写入） */
var IMPORT_EXTRA_KEYS = ['dashboardWidgetLayout', 'dashboardOrder'];

/** 枚举白名单：取值必须来自这里，否则回落默认值（与 index.html 的下拉选项一一对应） */
var IMPORT_ENUMS = {
  theme: ['light', 'dark', 'auto'],
  cardOpenMode: ['current', 'foreground', 'background'],
  groupPosition: ['left', 'top', 'right', 'bottom'],
  showGroupName: ['active', 'all', 'off'],
  dashboardLayout: ['row', 'column'],
  clockFormat: ['24h', '12h'],
  lunarStyle: ['double', 'single'],
  wallpaperMode: ['bing', 'custom', 'none'],
  wallpaperRotate: ['off', 'newtab', 'interval'],
  weatherType: ['openmeteo', 'hefeng', 'openweathermap', 'custom'],
  backupMode: ['off', 'remind', 'webdav'],
  bingRegion: ['zh-CN', 'en-US', 'ja-JP', 'de-DE', 'en-GB', 'fr-FR']
};

/** 数值范围：取「比 UI 滑块更宽」的区间 —— 目的是挡住荒谬值（负数/1e9/NaN），
 *  而不是把老版本留下的合法值强行夹到当前滑块范围（那会变成另一种静默改设置）。 */
var IMPORT_RANGES = {
  columns: [1, 12],
  searchMarginTop: [0, 1000], searchMarginBottom: [0, 1000],
  groupOffset: [0, 200], groupDotSize: [4, 48], groupTabSize: [8, 48],
  dashLeft: [0, 2000], dashBottom: [0, 2000], dashItemW: [40, 600], dashItemH: [0, 600], dashGap: [0, 200],
  cardWidth: [50, 2000], cardHeight: [0, 2000], cardBorderRadius: [0, 200], cardOpacity: [0, 100],
  cardFontSize: [8, 48], cardsMarginTop: [0, 2000],
  wallpaperOpacity: [0, 100], wallpaperRotateMin: [1, 1440],
  bingRefreshMin: [1, 1440], weatherRefreshMin: [1, 1440], backupRemindDays: [1, 365]
};

/** 只允许 https 的 URL 类字段（http 会把 key/请求暴露给中间人；空串表示未设置） */
var IMPORT_HTTPS_FIELDS = ['wallpaperUrl', 'weatherApiUrl'];

/** 颜色类字段：只接受 #rgb/#rrggbb/#rrggbbaa 或空串 */
var IMPORT_COLOR_FIELDS = ['bgColor', 'cardBgColor', 'cardTextColor', 'wallpaperColor'];

/** 元素级校验：搜索引擎（URL 必须 https 且带 {q}，与 UI 的校验规则一致） */
function _normalizeSearchEngines(list) {
  if (!Array.isArray(list)) return null;
  var out = [];
  for (var i = 0; i < list.length && out.length < 30; i++) {
    var e = list[i];
    if (!e || typeof e !== 'object') continue;
    var id = String(e.id == null ? '' : e.id);
    var name = String(e.name == null ? '' : e.name);
    var url = String(e.url == null ? '' : e.url);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
    if (!name || name.length > 60) continue;
    if (!/^https:\/\/.+\{q\}/i.test(url)) continue;   // 与 search-engines.js 的 UI 校验同规则
    out.push({ id: id, name: name, url: url, enabled: e.enabled !== false });
  }
  return out;
}

/** 元素级校验：本地壁纸（key 必须是 IndexedDB 键格式 wp_...，name 是显示名） */
function _normalizeLocalWallpapers(list) {
  if (!Array.isArray(list)) return null;
  var out = [];
  for (var i = 0; i < list.length && out.length < 50; i++) {
    var w = list[i];
    if (!w || typeof w !== 'object') continue;
    var key = String(w.key == null ? '' : w.key);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) continue;
    var op = (w.opacity === null || w.opacity === undefined) ? null : Number(w.opacity);
    if (op !== null && (!isFinite(op) || op < 0 || op > 100)) op = null;
    out.push({ key: key, name: String(w.name == null ? '' : w.name).slice(0, 120), opacity: op });
  }
  return out;
}

/** 元素级校验：待办（上限与 todo.js 的 TODO_MAX_ITEMS 一致） */
function _normalizeTodoItems(list) {
  if (!Array.isArray(list)) return null;
  var out = [];
  for (var i = 0; i < list.length && out.length < 50; i++) {
    var t = list[i];
    if (!t || typeof t !== 'object') continue;
    var text = String(t.text == null ? '' : t.text).slice(0, 200);
    if (!text) continue;
    out.push({ id: String(t.id == null ? '' : t.id).slice(0, 64) || ('t' + i), text: text, done: t.done === true });
  }
  return out;
}

/** 元素级校验：看板组件布局（只保留已知组件与数值字段；getDashboardLayout 还会再夹一次） */
function _normalizeDashLayout(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  var out = {};
  for (var i = 0; i < DASHBOARD_WIDGETS.length; i++) {
    var id = DASHBOARD_WIDGETS[i].id;
    var e = obj[id];
    if (!e || typeof e !== 'object') continue;
    var order = Number(e.order), span = Number(e.span);
    if (!isFinite(order) || !isFinite(span)) continue;
    out[id] = { order: Math.max(0, Math.min(99, Math.round(order))), span: Math.max(1, Math.min(DASHBOARD_COLUMNS, Math.round(span))) };
  }
  return Object.keys(out).length ? out : null;
}

/** 主函数：把「不可信的 settings 对象」规范化成「只含已知键 + 合法值」的对象 */
function normalizeImportedSettings(raw) {
  var src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  var out = {};
  var allowed = Object.keys(DEFAULT_SETTINGS).concat(IMPORT_EXTRA_KEYS);

  for (var i = 0; i < allowed.length; i++) {
    var key = allowed[i];
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    var val = src[key];

    // ---- 表单管不到的看板字段 ----
    if (key === 'dashboardWidgetLayout') {
      var layout = _normalizeDashLayout(val);
      if (layout) out[key] = layout;
      continue;
    }
    if (key === 'dashboardOrder') {
      if (Array.isArray(val)) {
        var order = val.filter(function (id) { return typeof id === 'string' && DASHBOARD_WIDGETS.some(function (w) { return w.id === id; }); });
        if (order.length) out[key] = order.slice(0, DASHBOARD_WIDGETS.length);
      }
      continue;
    }

    // ---- 数组类字段：元素级校验 ----
    if (key === 'searchEngines') { var se = _normalizeSearchEngines(val); if (se && se.length) out[key] = se; continue; }
    if (key === 'localWallpapers') { var lw = _normalizeLocalWallpapers(val); if (lw) out[key] = lw; continue; }
    if (key === 'todoItems') { var td = _normalizeTodoItems(val); if (td) out[key] = td; continue; }

    // ---- 其余按键的默认值类型做通用校验 ----
    var def = DEFAULT_SETTINGS[key];
    if (typeof def === 'boolean') {
      if (typeof val === 'boolean') out[key] = val;
      continue;
    }
    if (typeof def === 'number') {
      var n = Number(val);
      if (!isFinite(n)) continue;
      var range = IMPORT_RANGES[key];
      if (range && (n < range[0] || n > range[1])) continue;   // 越界 → 用默认值，不夹紧
      if (Math.abs(n) > 1e9) continue;
      out[key] = n;
      continue;
    }
    if (typeof def === 'string') {
      if (typeof val !== 'string') continue;
      if (val.length > 4096) continue;
      if (IMPORT_ENUMS[key] && IMPORT_ENUMS[key].indexOf(val) === -1) continue;
      if (IMPORT_HTTPS_FIELDS.indexOf(key) !== -1 && val !== '' && !/^https:\/\/[^\s]+$/i.test(val)) continue;
      if (IMPORT_COLOR_FIELDS.indexOf(key) !== -1 && val !== '' && !/^#[0-9a-fA-F]{3,8}$/.test(val)) continue;
      if ((key === 'searchEngine' || key === 'activeSearchEngine') && !/^[A-Za-z0-9_-]{1,40}$/.test(val)) continue;
      if (key === 'weatherApiKey' && val.length > 512) continue;
      out[key] = val;
      continue;
    }
    // 其它类型（对象等）不在设置数据模型内，丢弃
  }
  return out;
}

/** 导出时给 config 打上格式版本（BUG-043：供将来迁移，也便于识别「由本扩展导出」的备份） */
function _withSchemaVersion(config) {
  var out = {};
  var src = config || {};
  for (var k in src) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  out.schemaVersion = IMPORT_SCHEMA_VERSION;
  return out;
}

/** 统计被白名单/校验拒掉的键数（0 表示这份备份的设置全部合法）。
 *  ⚠️ 必须排除「本扩展自己注入的元数据」，否则**自己导出的备份再导入时会误报**
 *  「已忽略 N 项未知或不合法的设置（备份可能被篡改）」—— 把安全告警变成噪音（v1.6.1 修复）：
 *    · `storageFallback`：v1.1.9 的 sync/local 回退标记（内部标记，不是用户设置）
 *    · `_exportTime`：`exportAll()` 与 `_collectAllData()` 写入的导出时间，导入预览要读它
 *  只放行「单下划线 + 小写字母」这一条元数据约定：`__proto__` 这类原型污染键**仍要被计数告警**。 */
function countRejectedSettings(raw, safe) {
  if (!raw || typeof raw !== 'object') return 0;
  var n = 0;
  var keys = Object.keys(raw);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (k === 'storageFallback') continue;
    if (/^_[a-z]/.test(k)) continue;
    if (!Object.prototype.hasOwnProperty.call(safe, k)) n++;
  }
  return n;
}

/** 导入配置到 storage */
async function _importConfig(unzipped, manifest) {
  var config = JSON.parse(fflate.strFromU8(unzipped['config.json']));
  if (typeof config !== 'object' || config === null) return 0;
  var dupCount = dedupCardIds(config.groups, manifest, unzipped);
  // BUG-043：白名单 + 逐键校验后再落盘（不再原样写入不可信备份里的 settings）
  var safeSettings = normalizeImportedSettings(config.settings);
  var rejectedCount = countRejectedSettings(config.settings, safeSettings);
  if (rejectedCount > 0) console.warn('[导入] 已忽略 ' + rejectedCount + ' 项未知/不合法的设置');
  var syncFailed = false;
  await new Promise(function (resolve) {
    chrome.storage.sync.set({
      settings: safeSettings,
      groups: config.groups || [],
      activeGroup: config.activeGroup || 0,
      groups_rev: Date.now()   // BUG-036: 版本号随数据同写
    }, function () {
      if (chrome.runtime.lastError) { syncFailed = true; }
      resolve();
    });
  });
  if (syncFailed) {
    var fSettings = safeSettings;
    fSettings.storageFallback = 'local';
    await new Promise(function (resolve) {
      chrome.storage.local.set({ groups: config.groups || [], activeGroup: config.activeGroup || 0, groups_rev: Date.now() }, resolve);
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

/** 收集全量数据（供 WebDAV 备份复用 exportAll 逻辑） */
async function _collectAllData() {
  // v1.3.3: 同上，读云端数据前先落盘
  if (typeof flushSyncWrites === 'function') await flushSyncWrites();
  // v1.2.6: 并行读取 sync 和 IndexedDB
  var [syncData, db] = await Promise.all([
    new Promise(function (resolve) {
      chrome.storage.sync.get(null, function (result) { resolve(result); });
    }),
    openImgDB()
  ]);

  var config = syncData;
  // BUG-036: 与 getGroups 同规则 —— sync 里没有数据、或 local 兜底数据的版本更新时，
  // 导出必须以 local 为准；否则 sync 写入被配额拒绝的用户会导出「超限前的旧数据」
  var localData = await new Promise(function (resolve) {
    chrome.storage.local.get(['groups', 'activeGroup', 'groups_rev'], function (result) { resolve(result); });
  });
  var syncRev = typeof config.groups_rev === 'number' ? config.groups_rev : 0;
  var localRev = typeof localData.groups_rev === 'number' ? localData.groups_rev : 0;
  var syncGroupsEmpty = !config.groups || (Array.isArray(config.groups) && config.groups.length === 0);
  if (localData.groups && Array.isArray(localData.groups) && localData.groups.length > 0 &&
      (syncGroupsEmpty || localRev > syncRev)) {
    config = config || {};
    config.groups = localData.groups;
    config.activeGroup = localData.activeGroup;
  }
  // groups_rev 只是本机判定 sync/local 谁更新的内部标记，不写进备份
  if (config && config.groups_rev !== undefined) delete config.groups_rev;
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
  zipFiles['config.json'] = fflate.strToU8(JSON.stringify(_withSchemaVersion(data.config)));
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

/* ==================== v1.3.3: 单分组导出 / 导入 ====================
   用于把一套 speed dial 分享给别人，或单独备份某个分组。
   格式：{ type:'deeppage-group', version:1, group:{name, sortMode, cards:[...]}, images:{key: dataURL} }
   本地图片（IndexedDB 中的 idx: 键）以 dataURL 内联，保证接收方拿到完整分组。
*/

/** 组装分组导出数据（纯逻辑，便于测试） */
async function _buildGroupExport(groupId) {
  var group = (groups || []).find(function (g) { return g.id === groupId; });
  if (!group) throw new Error('分组不存在');
  var out = {
    type: 'deeppage-group',
    version: 1,
    exportedAt: new Date().toISOString(),
    group: {
      name: group.name || '未命名',
      sortMode: group.sortMode || 'manual',
      cards: (group.cards || []).map(function (c) {
        return {
          name: c.name, url: c.url, color: c.color,
          visitCount: c.visitCount || 0, createdAt: c.createdAt || 0,
          lastOpened: c.lastOpened || 0, image: c.image || ''
        };
      })
    },
    images: {}
  };
  // 内联本地图片（仅 idx: 前缀的是 IndexedDB 里的图）
  for (var i = 0; i < (group.cards || []).length; i++) {
    var img = group.cards[i].image;
    if (!img || img.indexOf('idx:') !== 0) continue;
    try {
      // BUG-044：IndexedDB 的键**不带** idx: 前缀（写入时 saveImage(key) 再置 card.image='idx:'+key，
      // 读取时一律先剥前缀 —— cards.js 就是这么做的）。原先直接把 'idx:cardimg_x' 传进 loadImage，
      // store.get() 精确匹配必然 miss → 导出文件里 images 永远为空，接收方导入后本地图片全丢。
      var blob = await loadImage(String(img).replace('idx:', ''));
      if (blob) out.images[img] = await new Promise(function (resolve) {
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { resolve(null); };
        fr.readAsDataURL(blob);
      });
    } catch (e) { /* 图片缺失则跳过 */ }
  }
  return out;
}

/** dataURL → Blob（不用 fetch：扩展页 CSP 的 connect-src 不含 data:，会被拦截） */
function _dataUrlToBlob(dataUrl) {
  var parts = String(dataUrl).split(',');
  var mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/png';
  var bin = atob(parts[1] || '');
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** 把导出的分组数据写入本地（新增一个分组，图片重新落到 IndexedDB） */
async function _applyGroupImport(data) {
  if (!data || data.type !== 'deeppage-group' || !data.group || !Array.isArray(data.group.cards)) {
    throw new Error('不是有效的 DeepPage 分组文件');
  }
  var baseName = (data.group.name || '导入分组').slice(0, 40);
  var name = baseName;
  var n = 2;
  while ((groups || []).some(function (g) { return g.name === name; })) { name = baseName + ' (' + n + ')'; n++; }

  var newGroup = {
    id: 'g' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    name: name,
    sortMode: data.group.sortMode || 'manual',
    cards: []
  };

  for (var i = 0; i < data.group.cards.length; i++) {
    var c = data.group.cards[i];
    if (!c || !c.url) continue;
    var card = {
      id: Date.now() + '_' + i + '_' + Math.floor(Math.random() * 10000),
      name: c.name || c.url,
      url: c.url,
      color: c.color || '#4285f4',
      visitCount: c.visitCount || 0,
      createdAt: c.createdAt || Date.now(),
      lastOpened: c.lastOpened || 0,
      image: ''
    };
    // 恢复内联图片到 IndexedDB，并重映射 image 键
    if (c.image && data.images && data.images[c.image]) {
      try {
        var blob = _dataUrlToBlob(data.images[c.image]);
        var key = 'cardimg_' + card.id;
        await saveImage(key, blob);
        // 约定：image = 'idx:' + IndexedDB 键（cards.js 用 card.image.replace('idx:','') 取值）
        card.image = 'idx:' + key;
      } catch (e) { console.warn('[导入分组] 图片恢复失败:', e.message); }
    } else if (c.image && c.image.indexOf('http') === 0) {
      card.image = c.image;   // 远端图片 URL 原样保留
    }
    newGroup.cards.push(card);
  }

  groups.push(newGroup);
  await saveGroups(groups);   // 结构性改动：立即落盘
  if (typeof renderGroupDots === 'function') renderGroupDots();
  return newGroup;
}

/** 导出分组为 .json 文件 */
async function exportGroup(groupId) {
  try {
    var data = await _buildGroupExport(groupId);
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (data.group.name || 'group').replace(/[\\/:*?"<>|]/g, '_') + '_DeepPage分组.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    showToast('📤 已导出分组「' + data.group.name + '」（' + data.group.cards.length + ' 张卡片）', 'success');
  } catch (e) {
    showToast('导出分组失败: ' + e.message, 'error');
  }
}

/** 从文件导入分组 */
function importGroup() {
  pickFile('.json', async function (file) {
    try {
      var text = await file.text();
      var data = JSON.parse(text);
      var g = await _applyGroupImport(data);
      if (typeof renderSpeeddials === 'function') renderSpeeddials();
      showToast('📥 已导入分组「' + g.name + '」（' + g.cards.length + ' 张卡片）', 'success');
    } catch (e) {
      showToast('导入分组失败: ' + e.message, 'error');
    }
  });
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
          } catch (e) { _warnDegraded('从云端 manifest 移除已删配置 ' + name, e); }
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
