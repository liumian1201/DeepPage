/* ============================================================
   webdav.js — WebDAV 云备份前端 API 层（v1.2.0）
   所有网络请求通过 background.js SW 代理，彻底免疫 CORS
   ============================================================ */

var WEBDAV_MSG = {
  PUT: 'webdav:put',
  GET: 'webdav:get',
  PROPFIND: 'webdav:propfind',
  TEST: 'webdav:test',
  SILENT_PUT: 'webdav:silent-put'
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

/** 上传备份 zip 到 WebDAV */
async function webdavUpload(zipBlob) {
  var buf = await zipBlob.arrayBuffer();
  return _wdSend(WEBDAV_MSG.PUT, { body: Array.from(new Uint8Array(buf)) });
}

/** 从 WebDAV 下载备份 zip */
async function webdavDownload() {
  var resp = await _wdSend(WEBDAV_MSG.GET);
  if (Array.isArray(resp)) return new Blob([new Uint8Array(resp)], { type: 'application/zip' });
  return new Blob([resp], { type: 'application/zip' });
}

/** 获取云端备份最后修改时间 */
async function webdavCheckConflict() {
  return _wdSend(WEBDAV_MSG.PROPFIND);
}

/** 测试 WebDAV 连接（支持直接传凭据，不依赖先保存） */
async function webdavTestConnection(creds) {
  return _wdSend(WEBDAV_MSG.TEST, null, creds);
}

/** 静默备份（beforeunload 调用，保留兼容） */
function webdavSilentPut(zipBlob) {
  _wdGetCreds().then(function (c) {
    return zipBlob.arrayBuffer().then(function (buf) {
      chrome.runtime.sendMessage({ type: WEBDAV_MSG.SILENT_PUT, payload: { body: Array.from(new Uint8Array(buf)), _url: c.url, _user: c.user, _pass: c.pass } });
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
