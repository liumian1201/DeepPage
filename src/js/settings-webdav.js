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
    // v1.3.3: http 地址（本地 NAS 等）需先申请可选权限
    if (!(await ensurePermissionForUrl(webdavUrlEl.value.trim()))) return;
    _showWStatus('正在测试连接...');
    try {
      await new Promise(function (r) {
        chrome.storage.local.set({
          webdav_url: webdavUrlEl.value.trim(),
          webdav_user: webdavUserEl.value.trim(),
          // BUG-054：UTF-8 安全编码（原先 btoa 遇中文/emoji 密码抛 InvalidCharacterError）
          webdav_pass: b64EncodeUtf8(webdavPassEl.value)
        }, r);
      });
      await webdavTestConnection();
      _showWStatus('连接成功 ✅', true);
    } catch (e) { _showWStatus('连接失败: ' + e.message, false); }
  });

  // ---- 保存配置 ----
  var btnSave = document.getElementById('btn-webdav-save');
  if (btnSave) btnSave.addEventListener('click', function () {
    // BUG-054：整段补 try/catch —— 原先 btoa 在 storage.set 的实参求值阶段抛异常，
    // 直接冒泡出 click 监听器：不落库、无提示，用户只看到「点了没反应」
    var passEncoded;
    try {
      passEncoded = b64EncodeUtf8(webdavPassEl.value);
    } catch (e) {
      _showConfigStatus('❌ 密码编码失败: ' + e.message, false);
      if (typeof showToast === 'function') showToast('WebDAV 配置未保存: ' + e.message, 'error');
      return;
    }
    chrome.storage.local.set({
      webdav_url: webdavUrlEl.value.trim(),
      webdav_user: webdavUserEl.value.trim(),
      webdav_pass: passEncoded
    }, function () {
      if (chrome.runtime.lastError) {
        _showConfigStatus('❌ 保存失败: ' + chrome.runtime.lastError.message, false);
        if (typeof showToast === 'function') showToast('WebDAV 配置保存失败', 'error');
        return;
      }
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
          // BUG-036: 兜底数据带版本号，保证 getGroups 认定 local 更新
          chrome.storage.local.set({ groups: r.groups_local_bak, activeGroup: 0, groups_rev: Date.now() }, function () {
            if (typeof collectCardImageGarbage === 'function') collectCardImageGarbage();
            if (typeof showToast === 'function') showToast('已恢复，即将刷新...', 'success');
            setTimeout(function () { window.location.reload(); }, 1000);
          });
        });
      }).catch(function (e) {
        // DEBT-02: 用户点「取消」时该弹窗以 CANCELLED 拒绝 —— 正常选择，不算失败；其它错误必须留痕
        if (!e || e.message !== 'CANCELLED') _warnDegraded('恢复上一次改动的确认弹窗', e);
      });
    });
  });

  // ---- 立即备份（v1.2.8: 增量备份） ----
  var btnBackup = document.getElementById('btn-webdav-backup');
  if (btnBackup) btnBackup.addEventListener('click', async function () {
    if (!(await ensurePermissionForUrl(webdavUrlEl.value.trim()))) return;
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
        webdavCleanupBackups(5).catch(function (e) { _warnDegraded('手动备份后清理旧 ZIP', e); });
      } catch (e) { _showWStatus('备份失败: ' + e.message, false); }
    }
  });

  // ---- 从云端恢复（v1.2.6: 版本选择器） ----
  var btnRestore = document.getElementById('btn-webdav-restore');
  var versionPicker = document.getElementById('webdav-version-picker');
  var versionList = document.getElementById('webdav-version-list');

  // 显示备份版本选择器
  async function _showVersionPicker() {
    if (!(await ensurePermissionForUrl(webdavUrlEl.value.trim()))) return;
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
    // BUG-050：统一走 _renderVersionListHTML（转义 + 文件名白名单），不再各处手工拼 HTML
    versionList.innerHTML = _renderVersionListHTML(backupList.map(function (f) {
      return { name: f.name, label: f.name, sub: f.lastModified || '-' };
    }), 'zip');
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
    // BUG-050：跳过被白名单拦下的非法行（它们是 disabled 的，不能作为「最新」被选中）
    var first = versionList ? versionList.querySelector('input[name="webdav-version"]:not(:disabled)') : null;
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
  chrome.storage.local.get(['webdav_url','webdav_user','webdav_pass'], function (r) {
    if (webdavUrlEl) webdavUrlEl.value = r.webdav_url || '';
    if (webdavUserEl) webdavUserEl.value = r.webdav_user || '';
    // BUG-054：损坏/非 base64 的值不能让回调整个中断（否则下面的 _updateBackupModeUI 不再执行）
    if (webdavPassEl) {
      try {
        webdavPassEl.value = r.webdav_pass ? b64DecodeUtf8(r.webdav_pass) : '';
      } catch (e) {
        webdavPassEl.value = '';
        console.warn('[WebDAV] 已保存的密码无法解码，请重新填写:', e.message);
      }
    }
    if (typeof _updateBackupModeUI === 'function') _updateBackupModeUI();
  });
}
