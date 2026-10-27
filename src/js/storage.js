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
    var p = (key === STORAGE_KEYS.GROUPS && typeof GroupsStore === 'object' && GroupsStore)
      ? _writeGroupsSyncRaw(job.value, job.extra)   // BUG-089: 分组走分片写入
      : _writeSyncKey(key, job.value, job.extra);
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

/** BUG-089: 分组数据不再写单个 `groups` 项（单项 8KB 上限会把整份数据锁死），
 *  改由 GroupsStore 分片写入（groups_meta + gc_* ，见 groups-store.js）。
 *  extra 支持求值函数（版本号要等真正写入时再取时间戳）。 */
function _writeGroupsSyncRaw(groups, extra) {
  var extraObj = extra;
  if (typeof extraObj === 'function') {
    try { extraObj = extraObj(); } catch (e) { extraObj = null; }
  }
  return GroupsStore.writeSync(groups, extraObj || null);
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
  // BUG-089: sync 侧改为分片读取（groups_meta + gc_*，兼容旧版单项 `groups` 以完成迁移）
  var syncRead = await GroupsStore.readSync();
  var localData = await new Promise(function (resolve) {
    chrome.storage.local.get([STORAGE_KEYS.GROUPS, STORAGE_KEYS.GROUPS_REV], function (r) { resolve(r || {}); });
  });
  var syncGroups = syncRead.groups;
  var localGroups = localData[STORAGE_KEYS.GROUPS];
  var syncOk = Array.isArray(syncGroups) && syncGroups.length > 0;
  var localOk = Array.isArray(localGroups) && localGroups.length > 0;
  if (syncOk && localOk) {
    // 版本号相同（或都没有版本号）时以 sync 为准 —— 保持升级前的语义
    return _groupsRevOf(localData[STORAGE_KEYS.GROUPS_REV]) > _groupsRevOf(syncRead.rev)
      ? localGroups : syncGroups;
  }
  if (syncOk) return syncGroups;
  if (localOk) return localGroups;
  // 尝试从旧版 speeddials 迁移
  var oldCards = await loadFromStorage(STORAGE_KEYS.SPEEDDIALS, null);
  if (oldCards && Array.isArray(oldCards) && oldCards.length > 0) {
    var migrated = [{ id: 'g1', name: '常用', cards: oldCards }];
    await _writeGroupsSyncRaw(migrated, function () {
      return { [STORAGE_KEYS.GROUPS_REV]: Date.now() };
    });
    await saveToStorage(STORAGE_KEYS.ACTIVE_GROUP, 0);
    chrome.storage.sync.remove(STORAGE_KEYS.SPEEDDIALS);
    return migrated;
  }
  // 全新安装
  await _writeGroupsSyncRaw(DEFAULT_GROUPS, function () {
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
  // BUG-090: 写入前先看有没有「同一张卡被写进两个分组」的异常（正常情况永远不该出现）
  if (typeof _warnCrossGroupCardIds === 'function') _warnCrossGroupCardIds(groups);
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
  var ok = await _writeGroupsSyncRaw(groups, _groupsRevPayload);
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

/** 写入后校验：sync 里没有分组数据时回退到 local（同时刷新右键菜单）
 *  BUG-089: 分组现在存在分片里 —— 只看 `groups_meta` / 旧版 `groups` 是否存在，
 *  不去读全部 chunk（省一次 10KB 级拷贝）。 */
async function _verifyGroupsWrite(groups) {
  // 同步存储超限时自动回退到本地存储
  await new Promise(function (resolve) {
    chrome.storage.sync.get([GroupsStore.META_KEY, GroupsStore.LEGACY_KEY], function (result) {
      var meta = result[GroupsStore.META_KEY];
      var legacy = result[GroupsStore.LEGACY_KEY];
      var hasMeta = !!(meta && Array.isArray(meta.g) && meta.g.length > 0);
      var hasLegacy = !!(Array.isArray(legacy) && legacy.length > 0);
      if (!hasMeta && !hasLegacy) {
        _fallbackGroupsToLocal(groups).then(resolve);
      } else { resolve(); }
    });
  });
  // DEBT-02: 扩展上下文失效（重载 / 更新中）时 sendMessage 会**同步抛错** ——
  // 右键菜单晚一点刷新即可，不影响已落盘的数据（可降级），但要让失败可见
  try { chrome.runtime.sendMessage({ type: 'refresh-context-menus' }); } catch (e) { _warnDegraded('刷新右键菜单', e); }
}

/** 当前活动分组索引。
 *  BUG-090: **必须先读 local**。`saveActiveGroup` 里 local 是立即写的，而 sync 走 500ms 合并窗口；
 *  原实现「先读 sync，只有它等于 0 才回退 local」，于是「切到 0 号分组（常用）」后立刻读到 sync 里的
 *  旧值 1 就直接返回 1 —— 调用方（saveSpeeddials）会把当前分组的卡片写进上一个分组。
 *  local 代表「本机此刻在看的组」，用它比用跨设备同步值更符合语义。 */
async function getActiveGroup() {
  var localIdx = await loadFromLocal(STORAGE_KEYS.ACTIVE_GROUP, null);
  if (typeof localIdx === 'number' && isFinite(localIdx)) return localIdx;
  var idx = await loadFromStorage(STORAGE_KEYS.ACTIVE_GROUP, 0);
  return (typeof idx === 'number' && isFinite(idx)) ? idx : 0;
}

/** BUG-090: 页面上正在显示的那个分组（内存里的那一份）。
 *  `groups` / `activeGroupIndex` 是 main.js 用 `let` 声明的全局 —— 读它们要防 TDZ
 *  （与 cards.js 的 isLockedNow() 同一写法），取不到就返回 null 交给调用方兜底。 */
function _displayedGroup() {
  try {
    if (typeof groups === 'undefined' || !Array.isArray(groups)) return null;
    if (typeof activeGroupIndex === 'undefined') return null;
    return groups[activeGroupIndex] || null;
  } catch (e) {
    return null;
  }
}

/** 写入前的完整性巡警：同一个卡片 id 出现在两个分组里 = 数据已被写坏（BUG-090）。
 *  修好根因后不应再出现；留一道可见痕迹，避免同类回归再次静默扩散。 */
function _warnCrossGroupCardIds(groupsList) {
  if (!Array.isArray(groupsList)) return;
  var owner = {};
  var bad = [];
  groupsList.forEach(function (g) {
    ((g && g.cards) || []).forEach(function (c) {
      if (!c || !c.id) return;
      if (!owner[c.id]) { owner[c.id] = (g && g.id) || '?'; return; }
      if (owner[c.id] !== ((g && g.id) || '?') && bad.indexOf(c.id) === -1) bad.push(c.id);
    });
  });
  if (bad.length) {
    console.warn('[storage] 同一卡片同时存在于多个分组（数据异常，共 ' + bad.length + ' 张）:',
      bad.slice(0, 5).join(','));
  }
}

async function saveActiveGroup(index) {
  // v1.3.3: 滚轮连续切分组会产生突发写入 → 合并写（local 仍立即写，保证回退路径新鲜）
  scheduleSyncWrite(STORAGE_KEYS.ACTIVE_GROUP, index);
  saveToLocal(STORAGE_KEYS.ACTIVE_GROUP, index);
}

/** DEBT-02: 删组前的「后悔药」快照（写 local.groups_local_bak，供「恢复上一次改动」用）。
 *  抽成具名函数的原因：① 降级路径要可断言 —— 内联在删除流程里没法单独触发失败；
 *  ② 让「快照失败不阻断删除」这条约定有一个明确的落点。
 *  失败不抛出（可降级：用户要删的组照删），但必须留痕 —— 否则「恢复上一次改动」
 *  会静默回退到更早的状态，用户以为拿到的是删除前的快照。 */
async function _snapshotGroupsForUndo() {
  if (typeof getGroups !== 'function') return;
  try {
    var prev = await getGroups();
    if (prev && Array.isArray(prev) && prev.length > 0) {
      await new Promise(function (r) { chrome.storage.local.set({ groups_local_bak: prev, bak_timestamp: Date.now() }, r); });
    }
  } catch (e) {
    _warnDegraded('删组前的本地快照（后悔药）', e);
  }
}

/** 把「当前分组的卡片」落盘。
 *  BUG-090: 必须按**当前显示的分组 id** 定位要写的组，不能读 storage 里的 activeGroup 索引 ——
 *  那个写盘走 500ms 合并窗口（saveActiveGroup），切组后立刻加卡会拿到**上一个**分组的索引，
 *  于是把当前分组的整份卡片写进上一个分组（两组指向同一份数据：用户实测 10+21+4+3 → 21+21+4+3 = 49 张，
 *  常用里显示的变成「本地」的卡片）。用 id 锚定还有一个好处：分组顺序被别的标签页改过也不会错位。 */
async function saveSpeeddials(cards) {
  var latest = await getGroups();
  var shown = _displayedGroup();
  var idx = -1;
  if (shown && shown.id) {
    idx = latest.findIndex(function (g) { return g && g.id === shown.id; });
  }
  if (idx < 0) idx = await getActiveGroup();   // 内存里取不到（启动早期 / TDZ）才回退
  if (!latest[idx]) {
    latest[idx] = {
      id: (shown && shown.id) || ('g' + Date.now()),
      name: (shown && shown.name) || '默认',
      cards: []
    };
  }
  latest[idx].cards = cards;
  await saveGroups(latest);
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
