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
  var toggleWebdavAuto = document.getElementById('toggle-webdav-auto');

  // ---- 状态提示 ----
  function _showWStatus(msg, ok) {
    if (webdavStatus) {
      webdavStatus.textContent = msg;
      webdavStatus.style.color = ok === false ? '#ef4444' : ok ? '#16a34a' : '';
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
      _showWStatus('配置已保存', true);
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

  // ---- 立即备份 ----
  var btnBackup = document.getElementById('btn-webdav-backup');
  if (btnBackup) btnBackup.addEventListener('click', async function () {
    _showWStatus('正在备份...');
    try {
      var remoteTime = null;
      try { remoteTime = await webdavCheckConflict(); } catch (e) {}
      if (remoteTime) {
        var rd = new Date(remoteTime);
        getWebdavLastBackup(function (lt) {
          if (lt && rd.getTime() > new Date(lt).getTime()) {
            _showWStatus('⚠️ 云端有更新的备份 (' + rd.toLocaleString('zh-CN') + ')，已覆盖', false);
          }
        });
      }
      var config = await _collectAllData();
      var zipBlob = await _buildZipBlob(config);
      await webdavUpload(zipBlob);
      setWebdavLastBackup(new Date().toISOString());
      if (typeof updateWebdavStatus === 'function') updateWebdavStatus();
      _showWStatus('备份成功 ✅', true);
      if (typeof showToast === 'function') showToast('☁️ 已备份到 WebDAV', 'success');
    } catch (e) { _showWStatus('备份失败: ' + e.message, false); }
  });

  // ---- 从云端恢复 ----
  var btnRestore = document.getElementById('btn-webdav-restore');
  if (btnRestore) btnRestore.addEventListener('click', async function () {
    var remoteTime = null;
    try {
      var ts = await webdavCheckConflict();
      if (ts) remoteTime = new Date(ts).toLocaleString('zh-CN');
    } catch (e) {}
    var msg = '从云端恢复将覆盖当前所有数据';
    if (remoteTime) msg += '\n🕐 云端备份时间：' + remoteTime;
    msg += '，是否继续？';
    try {
      await showImportConfirmAsync(msg);
    } catch (e) { return; }
    _showWStatus('正在下载...');
    try {
      var zipBlob = await webdavDownload();
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
      if (remoteTime) setWebdavLastBackup(new Date(remoteTime).toISOString());
      if (typeof updateWebdavStatus === 'function') updateWebdavStatus();
      _showWStatus('恢复成功，即将刷新...', true);
      if (typeof showToast === 'function') showToast('☁️ 已从 WebDAV 恢复，即将刷新...', 'success');
      setTimeout(function () { window.location.reload(); }, 1500);
    } catch (e) { _showWStatus('恢复失败: ' + e.message, false); }
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
    if (typeof updateWebdavStatus === 'function') updateWebdavStatus();
  });
}
