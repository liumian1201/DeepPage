/* ============================================================
   settings-webdav.js — WebDAV 云备份配置区 UI 逻辑
   从 settings.js 抽离，自含 DOM 查询与事件绑定
   由 settings.js 的 bindSettingsEvents() 尾部调用 initWebdavSection()
   ============================================================ */

function initWebdavSection() {
  // ---- DOM 引用 ----
  var webdavUrlEl   = document.getElementById('webdav-url');
  var webdavUserEl  = document.getElementById('webdav-user');
  var webdavPassEl  = document.getElementById('webdav-pass');
  var webdavStatus  = document.getElementById('webdav-status');
  var webdavCfgStatus = document.getElementById('webdav-config-status');
  var toggleWebdavAuto = document.getElementById('toggle-webdav-auto');

  // ---- 状态提示（webdav-status 用于临时消息，webdav-config-status 用于持久状态） ----
  function _showWStatus(msg, ok) {
    if (webdavStatus) {
      webdavStatus.textContent = msg;
      webdavStatus.style.color = ok === false ? '#ef4444' : ok ? '#16a34a' : '';
    }
  }
  function _showConfigStatus(msg, ok) {
    if (webdavCfgStatus) {
      webdavCfgStatus.textContent = msg;
      webdavCfgStatus.style.color = ok ? '#16a34a' : '#ef4444';
      webdavCfgStatus.style.display = '';
    }
  }

  // ---- 测试连接 ----
  var btnTest = document.getElementById('btn-webdav-test');
  if (btnTest) btnTest.addEventListener('click', async function () {
    _showWStatus('正在测试连接...');
    try {
      await new Promise(function (r) {
        chrome.storage.local.set({
          webdav_url: webdavUrlEl.value.trim(),
          webdav_user: webdavUserEl.value.trim(),
          webdav_pass: btoa(webdavPassEl.value)
        }, r);
      });
      await webdavTestConnection();
      _showWStatus('连接成功 ✅', true);
    } catch (e) { _showWStatus('连接失败: ' + e.message, false); }
  });

  // ---- 保存配置 ----
  var btnSave = document.getElementById('btn-webdav-save');
  if (btnSave) btnSave.addEventListener('click', function () {
    chrome.storage.local.set({
      webdav_url: webdavUrlEl.value.trim(),
      webdav_user: webdavUserEl.value.trim(),
      webdav_pass: btoa(webdavPassEl.value),
      webdav_auto_backup: toggleWebdavAuto ? toggleWebdavAuto.checked : false
    }, function () {
      _showConfigStatus('✅ WebDAV 配置已保存', true);
      if (typeof showToast === 'function') showToast('WebDAV 配置已保存', 'success');
    });
  });

  // ---- 恢复上一次改动（local_bak 快照） ----
  var btnRestoreBak = document.getElementById('btn-restore-bak');
  if (btnRestoreBak) btnRestoreBak.addEventListener('click', function () {
    chrome.storage.local.get(['groups_local_bak','bak_timestamp'], function (r) {
      if (!r.groups_local_bak || !Array.isArray(r.groups_local_bak)) {
        if (typeof showToast === 'function') showToast('没有可恢复的备份', 'warning');
        return;
      }
      var msg = '恢复到上一次改动';
      if (r.bak_timestamp) msg += '\n🕐 备份时间：' + new Date(r.bak_timestamp).toLocaleString('zh-CN');
      msg += '\n当前数据将被覆盖，是否继续？';
      showImportConfirmAsync(msg).then(function () {
        chrome.storage.sync.set({ groups: [], activeGroup: 0 }, function () {
          chrome.storage.local.set({ groups: r.groups_local_bak, activeGroup: 0 }, function () {
            if (typeof collectCardImageGarbage === 'function') collectCardImageGarbage();
            if (typeof showToast === 'function') showToast('已恢复，即将刷新...', 'success');
            setTimeout(function () { window.location.reload(); }, 1000);
          });
        });
      }).catch(function () {});
    });
  });

  // ---- 立即备份（v1.2.8: 增量备份） ----
  var btnBackup = document.getElementById('btn-webdav-backup');
  if (btnBackup) btnBackup.addEventListener('click', async function () {
    if (typeof webdavIncrementalBackup === 'function') {
      webdavIncrementalBackup();
    } else {
      // 回退到旧版全量备份
      _showWStatus('正在备份...');
      try {
        var config = await _collectAllData();
        var zipBlob = await _buildZipBlob(config);
        var fname = _genBackupFilename();
        await webdavUpload(zipBlob, fname);
        setWebdavLastBackupFilename(fname);
        setWebdavLastBackup(new Date().toISOString());
        _showWStatus('备份成功 ✅', true);
        webdavCleanupBackups(5).catch(function () {});
      } catch (e) { _showWStatus('备份失败: ' + e.message, false); }
    }
  });

  // ---- 从云端恢复（v1.2.6: 版本选择器） ----
  var btnRestore = document.getElementById('btn-webdav-restore');
  var versionPicker = document.getElementById('webdav-version-picker');
  var versionList = document.getElementById('webdav-version-list');

  // 显示备份版本选择器
  async function _showVersionPicker() {
    _showWStatus('正在获取备份列表...');
    var backupList = [];
    try { backupList = await webdavListBackups(); } catch (e) {
      _showWStatus('获取备份列表失败: ' + e.message, false);
      return;
    }
    if (!Array.isArray(backupList) || backupList.length === 0) {
      _showWStatus('云端暂无备份文件', false);
      return;
    }
    if (!versionList || !versionPicker) return;
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
    _showWStatus('');
  }

  // 执行恢复
  async function _doRestoreFrom(filename) {
    var msg = '从云端恢复将覆盖当前所有数据，是否继续？';
    try { await showImportConfirmAsync(msg); } catch (e) { return; }
    _showWStatus('正在下载...');
    try {
      var zipBlob = await webdavDownload(filename);
      var loading = document.getElementById('backup-loading');
      if (loading) loading.classList.remove('hidden');
      try {
        var buf = await zipBlob.arrayBuffer();
        var unzipped = fflate.unzipSync(new Uint8Array(buf));
        if (typeof doImportFromUnzipped === 'function') {
          await doImportFromUnzipped(unzipped, false);
        }
      } finally {
        if (loading) loading.classList.add('hidden');
      }
      setWebdavLastBackupFilename(filename);
      setWebdavLastBackup(new Date().toISOString());
      _showWStatus('恢复成功，即将刷新...', true);
      if (versionPicker) versionPicker.classList.add('hidden');
      if (typeof showToast === 'function') showToast('☁️ 已从 WebDAV 恢复，即将刷新...', 'success');
      setTimeout(function () { window.location.reload(); }, 1500);
    } catch (e) { _showWStatus('恢复失败: ' + e.message, false); }
  }

  if (btnRestore) btnRestore.addEventListener('click', function () {
    // v1.2.8: 优先尝试增量恢复
    if (typeof webdavIncrementalRestore === 'function') {
      webdavIncrementalRestore();
    } else {
      _showVersionPicker();
    }
  });

  // 恢复选中版本（v1.2.8: 增量恢复）
  var btnRestoreSelected = document.getElementById('btn-webdav-restore-selected');
  if (btnRestoreSelected) btnRestoreSelected.addEventListener('click', function () {
    var sel = versionList ? versionList.querySelector('input[name="webdav-version"]:checked') : null;
    if (!sel) { _showWStatus('请先选择一个版本', false); return; }
    if (typeof _doIncrementalRestore === 'function') {
      _doIncrementalRestore(sel.value);
    } else {
      _doRestoreFrom(sel.value);
    }
  });

  // 恢复最新（快捷按钮，v1.2.8: 增量恢复）
  var btnRestoreLatest = document.getElementById('btn-webdav-restore-latest');
  if (btnRestoreLatest) btnRestoreLatest.addEventListener('click', function () {
    var first = versionList ? versionList.querySelector('input[name="webdav-version"]') : null;
    if (!first) { _showWStatus('无可用版本', false); return; }
    if (typeof _doIncrementalRestore === 'function') {
      _doIncrementalRestore(first.value);
    } else {
      _doRestoreFrom(first.value);
    }
  });

  // ---- 密码显隐切换 ----
  var passToggle = document.getElementById('webdav-pass-toggle');
  var passInput  = document.getElementById('webdav-pass');
  if (passToggle && passInput) {
    passToggle.addEventListener('click', function () {
      if (passInput.type === 'password') {
        passInput.type = 'text'; passToggle.textContent = '🙈';
      } else {
        passInput.type = 'password'; passToggle.textContent = '👁';
      }
    });
  }

  // ---- 加载已保存的 WebDAV 配置 ----
  chrome.storage.local.get(['webdav_url','webdav_user','webdav_pass','webdav_auto_backup'], function (r) {
    if (webdavUrlEl) webdavUrlEl.value = r.webdav_url || '';
    if (webdavUserEl) webdavUserEl.value = r.webdav_user || '';
    if (webdavPassEl) webdavPassEl.value = r.webdav_pass ? atob(r.webdav_pass) : '';
    if (typeof _updateBackupModeUI === 'function') _updateBackupModeUI();
  });
}
