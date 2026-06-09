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
  DELETE: 'webdav:delete',
  // v1.2.8: 增量备份消息类型
  MANIFEST_GET: 'webdav:manifest-get',
  MANIFEST_PUT: 'webdav:manifest-put',
  CONFIG_PUT: 'webdav:config-put',
  CONFIG_GET: 'webdav:config-get',
  CONFIG_LIST: 'webdav:config-list',
  CONFIG_DELETE: 'webdav:config-delete',
  IMG_PUT: 'webdav:img-put',
  IMG_GET: 'webdav:img-get',
  IMG_DELETE: 'webdav:img-delete',
  IMG_LIST: 'webdav:img-list'
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

/** v1.2.8: 生成配置快照文件名 */
function _genConfigName() {
  var now = new Date();
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  return now.getFullYear()
    + pad(now.getMonth() + 1)
    + pad(now.getDate()) + '_'
    + pad(now.getHours())
    + pad(now.getMinutes())
    + pad(now.getSeconds()) + '.json';
}

// ==================== v1.2.8: 增量备份 API ====================

/** 获取云端 manifest.json */
async function webdavGetManifest() {
  return _wdSend(WEBDAV_MSG.MANIFEST_GET);
}

/** 上传 manifest.json */
async function webdavPutManifest(manifest) {
  return _wdSend(WEBDAV_MSG.MANIFEST_PUT, { body: JSON.stringify(manifest) });
}

/** 上传配置快照 config/<name>.json */
async function webdavPutConfig(name, config) {
  return _wdSend(WEBDAV_MSG.CONFIG_PUT, { _filename: name, body: JSON.stringify(config) });
}

/** 下载配置快照 */
async function webdavGetConfig(name) {
  return _wdSend(WEBDAV_MSG.CONFIG_GET, { _filename: name });
}

/** 列出所有配置快照 */
async function webdavListConfigs() {
  return _wdSend(WEBDAV_MSG.CONFIG_LIST);
}

/** 删除配置快照 */
async function webdavDeleteConfig(name) {
  return _wdSend(WEBDAV_MSG.CONFIG_DELETE, { _filename: name });
}

/** 上传图片到 img/<md5>.bin */
async function webdavPutImage(md5, blob) {
  var buf = await blob.arrayBuffer();
  return _wdSend(WEBDAV_MSG.IMG_PUT, { _filename: md5, body: Array.from(new Uint8Array(buf)), _mime: blob.type || 'image/png' });
}

/** 下载图片 */
async function webdavGetImage(md5) {
  var resp = await _wdSend(WEBDAV_MSG.IMG_GET, { _filename: md5 });
  if (Array.isArray(resp)) return new Blob([new Uint8Array(resp)], { type: 'image/png' });
  return new Blob([resp], { type: 'image/png' });
}

/** 删除图片 */
async function webdavDeleteImage(md5) {
  return _wdSend(WEBDAV_MSG.IMG_DELETE, { _filename: md5 });
}

/** 列出云端 img/ 目录所有文件 */
async function webdavListImages() {
  return _wdSend(WEBDAV_MSG.IMG_LIST);
}

/** 静默备份（beforeunload 调用，v1.2.8: 支持增量标记） */
function webdavSilentPut(zipBlob) {
  _wdGetCreds().then(function (c) {
    if (!c.url) return;
    // v1.2.8: 传递增量标记，SW 侧尝试增量备份
    chrome.runtime.sendMessage({ type: WEBDAV_MSG.SILENT_PUT, payload: { _incremental: true, _url: c.url, _user: c.user, _pass: c.pass } });
  });
}

/** v1.2.8: 增量静默备份（传入收集好的数据） */
function webdavSilentPutIncremental(data) {
  if (!data || !data.config || !data.images) return;
  _wdGetCreds().then(function (c) {
    if (!c.url) return;
    chrome.runtime.sendMessage({
      type: WEBDAV_MSG.SILENT_PUT,
      payload: {
        _incremental: true,
        _url: c.url, _user: c.user, _pass: c.pass,
        _config: JSON.stringify(data.config),
        _images: data.images.map(function (img) {
          return { key: img.key, type: img.blob.type || 'image/png' };
        })
      }
    });
    // 图片 Blob 无法通过 sendMessage 传递，SW 侧自行从 IndexedDB 读取
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
