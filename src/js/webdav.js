/* ============================================================
   webdav.js — WebDAV 云备份前端 API 层（v1.2.0）
   所有网络请求通过 background.js SW 代理，彻底免疫 CORS
   ============================================================ */

var WEBDAV_MSG = {
  PUT: 'webdav:put',
  GET: 'webdav:get',
  PROPFIND: 'webdav:propfind',
  TEST: 'webdav:test',
  SILENT_PUT: 'webdav:silent-put',
  LIST: 'webdav:list',
  DELETE: 'webdav:delete'
};

function _wdGetCreds() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(['webdav_url','webdav_user','webdav_pass'], function (r) {
      resolve({ url: r.webdav_url || '', user: r.webdav_user || '', pass: r.webdav_pass || '' });
    });
  });
}

function _wdSend(type, payload, creds) {
  return new Promise(function (resolve, reject) {
    var p = Promise.resolve(creds);
    if (!creds) p = _wdGetCreds();
    p.then(function (c) {
      payload = payload || {};
      payload._url = c.url;
      payload._user = c.user;
      payload._pass = c.pass;
      chrome.runtime.sendMessage({ type: type, payload: payload }, function (resp) {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (!resp || !resp.ok) { reject(new Error((resp && resp.error) || 'unknown')); return; }
        resolve(resp.data);
      });
    });
  });
}

/** 上传备份 zip 到 WebDAV（v1.2.6: 支持版本化文件名） */
async function webdavUpload(zipBlob, filename) {
  var buf = await zipBlob.arrayBuffer();
  var payload = { body: Array.from(new Uint8Array(buf)) };
  if (filename) payload._filename = filename;
  return _wdSend(WEBDAV_MSG.PUT, payload);
}

/** 从 WebDAV 下载备份 zip（v1.2.6: 支持指定文件名） */
async function webdavDownload(filename) {
  var payload = {};
  if (filename) payload._filename = filename;
  var resp = await _wdSend(WEBDAV_MSG.GET, payload);
  if (Array.isArray(resp)) return new Blob([new Uint8Array(resp)], { type: 'application/zip' });
  return new Blob([resp], { type: 'application/zip' });
}

/** 获取云端备份最后修改时间 */
async function webdavCheckConflict() {
  return _wdSend(WEBDAV_MSG.PROPFIND);
}

/** v1.2.6: 列出云端所有备份文件 */
async function webdavListBackups() {
  return _wdSend(WEBDAV_MSG.LIST);
}

/** v1.2.6: 删除云端的指定备份文件 */
async function webdavDeleteBackup(filename) {
  return _wdSend(WEBDAV_MSG.DELETE, { _filename: filename });
}

/** v1.2.6: 清理旧备份（保留最近 N 个） */
async function webdavCleanupBackups(keepCount) {
  keepCount = keepCount || 5;
  var files = await webdavListBackups();
  if (!Array.isArray(files) || files.length <= keepCount) return { deleted: 0, kept: files ? files.length : 0 };
  var toDelete = files.slice(keepCount);
  for (var i = 0; i < toDelete.length; i++) {
    try { await webdavDeleteBackup(toDelete[i].name); } catch (e) { console.warn('cleanup delete fail:', toDelete[i].name, e); }
  }
  return { deleted: toDelete.length, kept: keepCount };
}

/** v1.2.6: 生成版本化备份文件名 */
function _genBackupFilename() {
  var now = new Date();
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  return 'DeepPage_' + now.getFullYear()
    + pad(now.getMonth() + 1)
    + pad(now.getDate()) + '_'
    + pad(now.getHours())
    + pad(now.getMinutes())
    + pad(now.getSeconds()) + '.zip';
}

/** 静默备份（beforeunload 调用，v1.2.6: 版本化文件名） */
function webdavSilentPut(zipBlob) {
  _wdGetCreds().then(function (c) {
    if (!c.url) return;
    var fname = _genBackupFilename();
    return zipBlob.arrayBuffer().then(function (buf) {
      // BUG-031: filename 写入在 SW 侧 silent-put 处理器中完成，避免 beforeunload 丢失
      chrome.runtime.sendMessage({ type: WEBDAV_MSG.SILENT_PUT, payload: { body: Array.from(new Uint8Array(buf)), _filename: fname, _url: c.url, _user: c.user, _pass: c.pass } });
    });
  });
}

/** 读取上次备份时间 */
function getWebdavLastBackup(callback) {
  chrome.storage.local.get(['webdav_last_backup'], function (r) {
    callback(r.webdav_last_backup || null);
  });
}

/** 更新上次备份时间 */
function setWebdavLastBackup(timeStr) {
  chrome.storage.local.set({ webdav_last_backup: timeStr || new Date().toISOString() });
}

/** v1.2.6: 获取上次备份文件名 */
function getWebdavLastBackupFilename(callback) {
  chrome.storage.local.get(['webdav_last_backup_filename'], function (r) {
    callback(r.webdav_last_backup_filename || null);
  });
}

/** v1.2.6: 存储上次备份文件名 */
function setWebdavLastBackupFilename(name) {
  if (!name) return;
  chrome.storage.local.set({ webdav_last_backup_filename: name });
}
