/* ============================================================
   storage.js — chrome.storage.sync 封装层
   负责所有数据的读写，含默认值合并 + 旧版数据迁移
   ============================================================ */

var STORAGE_KEYS = {
  GROUPS: 'groups',
  ACTIVE_GROUP: 'activeGroup',
  SETTINGS: 'settings',
  // BUG-036: 分组数据的写入版本号 —— sync 与 local 各存一份，
  // 用来判断「哪一份更新」，而不是「sync 里有没有值」（后者在配额拒绝时永远为真）
  GROUPS_REV: 'groups_rev',
  SPEEDDIALS: 'speeddials' // 旧版，用于迁移
};

// 默认分组（首次安装时使用）
var DEFAULT_GROUPS = [
  { id: 'g1', name: '常用', sortMode: 'manual', cards: [
    { id: '1', name: 'GitHub',       url: 'https://github.com',        color: '#24292e', visitCount: 0, createdAt: Date.now() },
    { id: '2', name: '哔哩哔哩',     url: 'https://www.bilibili.com',  color: '#fb7299', visitCount: 0, createdAt: Date.now() },
    { id: '3', name: 'YouTube',      url: 'https://www.youtube.com',   color: '#ff0000', visitCount: 0, createdAt: Date.now() },
    { id: '4', name: 'Google 翻译',   url: 'https://translate.google.com', color: '#4285f4', visitCount: 0, createdAt: Date.now() },
    { id: '5', name: 'Gmail',        url: 'https://mail.google.com',   color: '#ea4335', visitCount: 0, createdAt: Date.now() }
  ]}
];

// 默认设置
var DEFAULT_SETTINGS = {
  searchEngine: 'google', // deprecated, migrated to activeSearchEngine
  activeSearchEngine: 'google',
  searchEngines: [
    { id: 'google',  name: 'Google',  url: 'https://www.google.com/search?q={q}', enabled: true },
    { id: 'baidu',   name: '百度',    url: 'https://www.baidu.com/s?wd={q}',       enabled: true },
    { id: 'bing',    name: 'Bing',    url: 'https://www.bing.com/search?q={q}',     enabled: true },
    { id: 'sogou',   name: '搜狗',    url: 'https://www.sogou.com/web?query={q}',   enabled: false },
    { id: 'yandex',  name: 'Yandex',  url: 'https://yandex.com/search/?text={q}',   enabled: false }
  ],
  columns: 5,
  showClock: true,
  showLunar: true,
  showWeather: true,
  showTodo: true,          // v1.5.0: 看板待办组件
  todoItems: [],
  searchSuggestions: false,   // v1.5.0: 历史/书签搜索建议（需可选权限）
  useFavicon: false,          // v1.5.0: 可选 favicon（离线缓存 + 首字符兜底）
  localWallpapers: [],        // v1.5.0: 本地多图壁纸 [{ key, name, opacity }]
  wallpaperRotate: 'off',     // off | newtab | interval
  wallpaperRotateMin: 30,
  theme: 'light',
  showAddButton: true,
  showCardTitle: true,
  pureTextCards: false,
  weatherType: 'openmeteo',
  weatherCity: '',
  weatherApiUrl: '',
  weatherApiKey: '',
  weatherRefreshMin: 15,
  wallpaperMode: 'bing',
  wallpaperUrl: '',
  wallpaperColor: '#1a1a2e',
  wallpaperOpacity: 30,
  bingUHD: false,
  bingRegion: 'zh-CN',
  bingAutoRefresh: true,
  bingRefreshMin: 360,
  showSearch: true,
  searchMarginTop: 60,
  searchMarginBottom: 48,
  groupPosition: 'left',
  groupOffset: 16,
  dashboardLayout: 'row',
  dashLeft: 0,
  dashBottom: 0,
  dashItemW: 140,
  dashItemH: 0,
  dashGap: 16,
  clockFormat: '24h',
  clockShowSeconds: true,
  lunarStyle: 'double',
  confirmDelete: true,
  disableWheelSwitch: false,
  showGroupName: 'all',
  showGroupIndicator: true,
  isLocked: false,
  bgColor: '',
  cardBgColor: '',
  cardTextColor: '',
  cardFontSize: 13,
  cardWidth: 270,
  cardHeight: 270,
  cardBorderRadius: 14,
  cardOpacity: 100,
  cardOpenMode: 'current',
  showVisitCount: true,
  cardsMarginTop: 0,
  groupDotSize: 10,
  groupTabSize: 13,
  backupMode: 'off',
  backupRemindDays: 7,
  backupIncludeImages: true,   // v1.3.3: 关闭则云端只同步配置（不含图片）
  cardThemeColor: true
};

/** BUG-075: 已下线的设置字段 —— 历次迁移的残留，全仓库无任何读取方：
 *  presetSize（卡片尺寸预设，已下线）、backupRemind / webdavAutoBackup（被 backupMode 取代）、
 *  bingIdx（Bing 序号实际存在 local 的 bing_wallpapers_cache.idx）。
 *  getSettings 时从内存副本剔除：老数据里若还留着，下一次整份回写就自然从 storage 消失，
 *  不需要额外写一次盘（也不占 sync 配额）。 */
var DEAD_SETTINGS_KEYS = ['presetSize', 'backupRemind', 'webdavAutoBackup', 'bingIdx'];

function loadFromStorage(key, defaultValue) {
  return new Promise(function (resolve) {
    chrome.storage.sync.get([key], function (result) {
      resolve(result[key] !== undefined ? result[key] : defaultValue);
    });
  });
}

/* ==================== 写入合并层（v1.3.3） ====================
   chrome.storage.sync 有 MAX_WRITE_OPERATIONS_PER_MINUTE = 120 的硬配额，
   超限时写入会静默失败（lastError）。滚轮切分组、连点卡片、拖设置滑块都会产生突发写入，
   因此对「高频且可重建」的数据（settings / activeGroup / 访问计数）做合并写：
   同一 key 在窗口内只写最后一次，窗口取 500ms（理论上限 120 次/分钟，正好卡在配额内）。
   结构性数据（增删改卡片、分组增删）仍走立即写，避免崩溃/关页丢用户数据。
*/

var SYNC_WRITE_COALESCE_MS = 500;
var _pendingSyncWrites = {};   // key → { value, afterFlush }
var _pendingWriteTimers = {};  // key → timerId
var _selfWriteJson = {};       // key → 本页最后写出的值（稳定序列化；回声判定按「值」而非「时间」）

/** 稳定序列化：对象键名递归排序后再 stringify。
 *  chrome.storage 读回的对象键序与写入时不同（实测读回是字母序），
 * 直接 JSON.stringify 比对会永远不相等，无法用于回声判定。 */
function _stableJson(value) {
  try {
    return JSON.stringify(value, function (k, v) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        var out = {};
        Object.keys(v).sort().forEach(function (key) { out[key] = v[key]; });
        return out;
      }
      return v;
    });
  } catch (e) { return null; }
}

/** 立即写入 sync；失败只告警不抛（回退逻辑由调用方决定）
 *  BUG-036: 返回「本次写入是否成功」—— 原先无论 lastError 都 resolve()，
 *  调用方无法区分「写成功」与「被配额拒绝」，导致 local 兜底永不触发。
 *  extra 可传对象或求值函数：与主键在同一次 set 调用里写入（不额外消耗写入配额）。 */
function _writeSyncKey(key, value, extra) {
  return new Promise(function (resolve) {
    var items = {};
    items[key] = value;
    if (typeof extra === 'function') {
      try { extra = extra(); } catch (e) { extra = null; }
    }
    if (extra) Object.keys(extra).forEach(function (k) { items[k] = extra[k]; });
    // BUG-037 / BUG-055: onChanged 可能先于 set 回调触发（实测：回调里读到的状态还是上一次写入的），
    // 因此回声标记必须在调用 set 之前打上，并且按「值」比对（isSelfSyncValue）
    _selfWriteJson[key] = _stableJson(value);
    if (_selfWriteJson[key] === null) delete _selfWriteJson[key];
    try {
      chrome.storage.sync.set(items, function () {
        var err = chrome.runtime.lastError;
        if (err) {
          console.warn('[storage] sync 写入失败（' + key + '）:', err.message);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    } catch (e) {
      // 同步抛异常（如配额校验前置失败）同样视为写入失败，交给 local 兜底
      console.warn('[storage] sync 写入异常（' + key + '）:', e && e.message);
      resolve(false);
    }
  });
}

/** 合并写：窗口内多次调用只保留最后一次；afterFlush 在真正写完后执行（如超限回退、菜单刷新），
 *  参数为本次写入是否成功（BUG-036）；extra 同 _writeSyncKey */
function scheduleSyncWrite(key, value, afterFlush, extra) {
  _pendingSyncWrites[key] = { value: value, afterFlush: afterFlush, extra: extra };
  if (_pendingWriteTimers[key]) clearTimeout(_pendingWriteTimers[key]);
  _pendingWriteTimers[key] = setTimeout(function () {
    flushSyncWrites([key]);
  }, SYNC_WRITE_COALESCE_MS);
}

/** 立即写出待写数据（key 数组省略则全部）；pagehide / 导出导入前调用 */
function flushSyncWrites(keys) {
  var list = keys || Object.keys(_pendingSyncWrites);
  var jobs = [];
  list.forEach(function (key) {
    var job = _pendingSyncWrites[key];
    if (!job) return;
    delete _pendingSyncWrites[key];
    if (_pendingWriteTimers[key]) {
      clearTimeout(_pendingWriteTimers[key]);
      delete _pendingWriteTimers[key];
    }
    var p = _writeSyncKey(key, job.value, job.extra);
    if (typeof job.afterFlush === 'function') {
      p = p.then(function (ok) { return job.afterFlush(ok); });
    }
    jobs.push(p);
  });
  return Promise.all(jobs);
}

/** BUG-037 / BUG-055: 本次 onChanged 携带的值是否就是本页刚写出去的那一份。
 *  按「值」判定（键序无关），不受 onChanged / set 回调的先后顺序影响；
 *  别的标签页的真实改动 → 值不同 → 判定为外部变更（必须合并，否则本页随后整份回写会把它回滚）。
 *  注意：早期版本按「key + 时间戳」判定，会把另一个标签页在 1.5s 内的改动整段丢弃（BUG-055）。 */
function isSelfSyncValue(key, value) {
  var j = _selfWriteJson[key];
  if (!j) return false;
  var got = _stableJson(value);
  return got !== null && j === got;
}

// 关页/切后台前尽力落盘（合并写窗口内的数据不丢）
window.addEventListener('pagehide', function () { flushSyncWrites(); });
document.addEventListener('visibilitychange', function () {
  if (document.hidden) flushSyncWrites();
});

function saveToStorage(key, value) {
  return _writeSyncKey(key, value);
}

/** chrome.storage.local 读写封装（供 wallpaper.js / weather.js 使用） */
function loadFromLocal(key, defaultValue) {
  return new Promise(function (resolve) {
    chrome.storage.local.get([key], function (result) {
      resolve(result[key] !== undefined ? result[key] : defaultValue);
    });
  });
}

function saveToLocal(key, value) {
  return new Promise(function (resolve) {
    chrome.storage.local.set({ [key]: value }, function () { resolve(); });
  });
}

// ---- 分组数据 ----

/** 版本号取值（缺失/非法一律视为 0，兼容升级前的数据） */
function _groupsRevOf(v) {
  return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

async function getGroups() {
  // BUG-036: 两侧都读出来，按写入版本号决定哪一份更新。
  // 原实现是「sync 非空就信 sync」—— sync 写入被配额拒绝时旧值原样留着（非空），
  // 于是 local 里的兜底数据永远读不到，刷新后回到超限前的旧版本（静默丢数据）。
  var syncData = await new Promise(function (resolve) {
    chrome.storage.sync.get([STORAGE_KEYS.GROUPS, STORAGE_KEYS.GROUPS_REV], function (r) { resolve(r || {}); });
  });
  var localData = await new Promise(function (resolve) {
    chrome.storage.local.get([STORAGE_KEYS.GROUPS, STORAGE_KEYS.GROUPS_REV], function (r) { resolve(r || {}); });
  });
  var syncGroups = syncData[STORAGE_KEYS.GROUPS];
  var localGroups = localData[STORAGE_KEYS.GROUPS];
  var syncOk = Array.isArray(syncGroups) && syncGroups.length > 0;
  var localOk = Array.isArray(localGroups) && localGroups.length > 0;
  if (syncOk && localOk) {
    // 版本号相同（或都没有版本号）时以 sync 为准 —— 保持升级前的语义
    return _groupsRevOf(localData[STORAGE_KEYS.GROUPS_REV]) > _groupsRevOf(syncData[STORAGE_KEYS.GROUPS_REV])
      ? localGroups : syncGroups;
  }
  if (syncOk) return syncGroups;
  if (localOk) return localGroups;
  // 尝试从旧版 speeddials 迁移
  var oldCards = await loadFromStorage(STORAGE_KEYS.SPEEDDIALS, null);
  if (oldCards && Array.isArray(oldCards) && oldCards.length > 0) {
    var migrated = [{ id: 'g1', name: '常用', cards: oldCards }];
    await _writeSyncKey(STORAGE_KEYS.GROUPS, migrated, function () {
      return { [STORAGE_KEYS.GROUPS_REV]: Date.now() };
    });
    await saveToStorage(STORAGE_KEYS.ACTIVE_GROUP, 0);
    chrome.storage.sync.remove(STORAGE_KEYS.SPEEDDIALS);
    return migrated;
  }
  // 全新安装
  await _writeSyncKey(STORAGE_KEYS.GROUPS, DEFAULT_GROUPS, function () {
    return { [STORAGE_KEYS.GROUPS_REV]: Date.now() };
  });
  await saveToStorage(STORAGE_KEYS.ACTIVE_GROUP, 0);
  return DEFAULT_GROUPS;
}

/** 分组写入的版本号载荷（求值函数，在真正写入时取时间戳，避免合并写窗口内产生陈旧版本号） */
function _groupsRevPayload() {
  return { [STORAGE_KEYS.GROUPS_REV]: Date.now() };
}

/** 把分组数据 + 版本号写入 local（sync 写入被拒时的兜底路径） */
function _fallbackGroupsToLocal(groups) {
  return new Promise(function (resolve) {
    chrome.storage.local.set({
      [STORAGE_KEYS.GROUPS]: groups,
      [STORAGE_KEYS.GROUPS_REV]: Date.now()
    }, function () {
      if (chrome.runtime.lastError) {
        console.warn('[storage] local 兜底写入失败:', chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

var _syncWriteRejectedWarned = false;
/** 写入被配额拒绝是用户可感知的数据安全事件 —— 提示一次，不再静默（BUG-036） */
function _warnSyncWriteRejected() {
  if (_syncWriteRejectedWarned) return;
  _syncWriteRejectedWarned = true;
  if (typeof showToast === 'function') {
    showToast('云同步空间不足，已自动保存到本地（数据未丢失）', 'warning');
  }
}

async function saveGroups(groups, opts) {
  opts = opts || {};
  // v1.2.1: 写入前保存上一版快照到 local（后悔药）
  if (typeof getGroups === 'function') {
    try {
      var prev = await getGroups();
      if (prev && Array.isArray(prev) && prev.length > 0) {
        await new Promise(function (r) { chrome.storage.local.set({ groups_local_bak: prev, bak_timestamp: Date.now() }, r); });
      }
    } catch (e) { console.error('local_bak save failed:', e); }
  }

  // v1.3.3: 高频路径（滚轮切分组 / 访问计数）走合并写，避免连续触发 120 次/分钟配额；
  // 超限回退校验与右键菜单刷新挂到真正写完之后
  if (opts.coalesce) {
    scheduleSyncWrite(STORAGE_KEYS.GROUPS, groups, function (ok) {
      return _finalizeGroupsWrite(groups, ok);
    }, _groupsRevPayload);
    return;
  }

  // BUG-028: _savingGroups 未定义时默认视为已在保存中，避免误复位
  var _wasSaving = typeof _savingGroups !== 'undefined' ? _savingGroups : true;
  if (typeof _savingGroups !== 'undefined') _savingGroups = true;
  var ok = await _writeSyncKey(STORAGE_KEYS.GROUPS, groups, _groupsRevPayload);
  if (typeof _savingGroups !== 'undefined' && !_wasSaving) _savingGroups = false;
  await _finalizeGroupsWrite(groups, ok);
}

/** 写入收尾（BUG-036）：sync 被拒 → 无条件落 local 兜底 + 版本号 + 提示，绝不静默丢数据 */
async function _finalizeGroupsWrite(groups, syncOk) {
  if (syncOk === false) {
    await _fallbackGroupsToLocal(groups);
    _warnSyncWriteRejected();
  }
  await _verifyGroupsWrite(groups);
}

/** 写入后校验：sync 里没有该键/为空数组时回退到 local（同时刷新右键菜单） */
async function _verifyGroupsWrite(groups) {
  // 同步存储超限时自动回退到本地存储
  await new Promise(function (resolve) {
    chrome.storage.sync.get([STORAGE_KEYS.GROUPS], function (result) {
      if (!result[STORAGE_KEYS.GROUPS] || (Array.isArray(result[STORAGE_KEYS.GROUPS]) && result[STORAGE_KEYS.GROUPS].length === 0)) {
        _fallbackGroupsToLocal(groups).then(resolve);
      } else { resolve(); }
    });
  });
  try { chrome.runtime.sendMessage({ type: 'refresh-context-menus' }); } catch (e) {}
}

async function getActiveGroup() {
  var idx = await loadFromStorage(STORAGE_KEYS.ACTIVE_GROUP, 0);
  if (idx !== 0) return idx;
  return loadFromLocal(STORAGE_KEYS.ACTIVE_GROUP, 0);
}

async function saveActiveGroup(index) {
  // v1.3.3: 滚轮连续切分组会产生突发写入 → 合并写（local 仍立即写，保证回退路径新鲜）
  scheduleSyncWrite(STORAGE_KEYS.ACTIVE_GROUP, index);
  saveToLocal(STORAGE_KEYS.ACTIVE_GROUP, index);
}

// 兼容旧代码
async function getSpeeddials() {
  var groups = await getGroups();
  var idx = await getActiveGroup();
  if (groups[idx]) return groups[idx].cards;
  return groups[0] ? groups[0].cards : [];
}

async function saveSpeeddials(cards) {
  var groups = await getGroups();
  var idx = await getActiveGroup();
  if (!groups[idx]) groups[idx] = { id: 'g' + Date.now(), name: '默认', cards: [] };
  groups[idx].cards = cards;
  await saveGroups(groups);
}

// ---- 设置 ----
async function getSettings() {
  var stored = await loadFromStorage(STORAGE_KEYS.SETTINGS, null);
  // 如果 sync 读取不到，尝试从 local 回退（与 getGroups/getActiveGroup 行为一致）
  if (!stored || Object.keys(stored).length === 0) {
    stored = await loadFromLocal(STORAGE_KEYS.SETTINGS, {});
  }
  var merged = { ...DEFAULT_SETTINGS, ...stored };
  // BUG-075: 剔除已下线字段（见 DEAD_SETTINGS_KEYS），避免迁移残留被一直回写下去
  DEAD_SETTINGS_KEYS.forEach(function (k) { delete merged[k]; });
  // 迁移旧版 searchEngine
  if (merged.searchEngine && !merged.activeSearchEngine) {
    merged.activeSearchEngine = merged.searchEngine;
  }
  if (merged.searchEngines) {
    // 确保默认引擎都在列表中
    DEFAULT_SETTINGS.searchEngines.forEach(function (d) {
      if (!merged.searchEngines.find(function (e) { return e.id === d.id; })) {
        merged.searchEngines.push({ id: d.id, name: d.name, url: d.url, enabled: d.enabled });
      }
    });
  }
  return merged;
}

async function saveSettings(settings) {
  // v1.3.3: 设置变更频繁且可重建（滑块/开关/引擎切换）→ 合并写；
  // 真正需要落盘的时刻（导出、导入、关页）由 flushSyncWrites 兜底
  scheduleSyncWrite(STORAGE_KEYS.SETTINGS, settings);
}
