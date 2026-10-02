/* ============================================================
   storage.js — chrome.storage.sync 封装层
   负责所有数据的读写，含默认值合并 + 旧版数据迁移
   ============================================================ */

var STORAGE_KEYS = {
  GROUPS: 'groups',
  ACTIVE_GROUP: 'activeGroup',
  SETTINGS: 'settings',
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
  bingIdx: 0,
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
  presetSize: 'medium',
  cardWidth: 270,
  cardHeight: 270,
  cardBorderRadius: 14,
  cardOpacity: 100,
  cardOpenMode: 'current',
  showVisitCount: true,
  cardsMarginTop: 0,
  groupDotSize: 10,
  groupTabSize: 13,
  webdavAutoBackup: false,
  backupRemind: true,
  backupMode: 'off',
  backupRemindDays: 7,
  backupIncludeImages: true,   // v1.3.3: 关闭则云端只同步配置（不含图片）
  cardThemeColor: true
};

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
var _selfWriteAt = {};         // key → 本页写入时间戳（用于忽略 onChanged 回声）

/** 立即写入 sync；失败只告警不抛（回退逻辑由调用方决定） */
function _writeSyncKey(key, value) {
  return new Promise(function (resolve) {
    chrome.storage.sync.set({ [key]: value }, function () {
      _selfWriteAt[key] = Date.now();
      if (chrome.runtime.lastError) {
        console.warn('[storage] sync 写入失败（' + key + '）:', chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

/** 合并写：窗口内多次调用只保留最后一次；afterFlush 在真正写完后执行（如超限回退、菜单刷新） */
function scheduleSyncWrite(key, value, afterFlush) {
  _pendingSyncWrites[key] = { value: value, afterFlush: afterFlush };
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
    var p = _writeSyncKey(key, job.value);
    if (typeof job.afterFlush === 'function') {
      p = p.then(function () { return job.afterFlush(); });
    }
    jobs.push(p);
  });
  return Promise.all(jobs);
}

/** 某 key 最近是否由本页写入（onChanged 回声判定，避免合并写晚到触发自刷新） */
function isSelfSyncWrite(key, withinMs) {
  var t = _selfWriteAt[key];
  return !!t && (Date.now() - t) < (withinMs || 1500);
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
async function getGroups() {
  var groups = await loadFromStorage(STORAGE_KEYS.GROUPS, null);
  if (groups && Array.isArray(groups) && groups.length > 0) return groups;
  // 大容量回退：sync 为空时检查 local（导入超限场景）
  groups = await loadFromLocal(STORAGE_KEYS.GROUPS, null);
  if (groups && Array.isArray(groups) && groups.length > 0) return groups;
  // 尝试从旧版 speeddials 迁移
  var oldCards = await loadFromStorage(STORAGE_KEYS.SPEEDDIALS, null);
  if (oldCards && Array.isArray(oldCards) && oldCards.length > 0) {
    var migrated = [{ id: 'g1', name: '常用', cards: oldCards }];
    await saveToStorage(STORAGE_KEYS.GROUPS, migrated);
    await saveToStorage(STORAGE_KEYS.ACTIVE_GROUP, 0);
    chrome.storage.sync.remove(STORAGE_KEYS.SPEEDDIALS);
    return migrated;
  }
  // 全新安装
  await saveToStorage(STORAGE_KEYS.GROUPS, DEFAULT_GROUPS);
  await saveToStorage(STORAGE_KEYS.ACTIVE_GROUP, 0);
  return DEFAULT_GROUPS;
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
    scheduleSyncWrite(STORAGE_KEYS.GROUPS, groups, function () {
      return _verifyGroupsWrite(groups);
    });
    return;
  }

  // BUG-028: _savingGroups 未定义时默认视为已在保存中，避免误复位
  var _wasSaving = typeof _savingGroups !== 'undefined' ? _savingGroups : true;
  if (typeof _savingGroups !== 'undefined') _savingGroups = true;
  await saveToStorage(STORAGE_KEYS.GROUPS, groups);
  if (typeof _savingGroups !== 'undefined' && !_wasSaving) _savingGroups = false;
  await _verifyGroupsWrite(groups);
}

/** 写入后校验：sync 超限被拒时回退到 local（同时刷新右键菜单） */
async function _verifyGroupsWrite(groups) {
  // 同步存储超限时自动回退到本地存储
  await new Promise(function (resolve) {
    chrome.storage.sync.get([STORAGE_KEYS.GROUPS], function (result) {
      if (!result[STORAGE_KEYS.GROUPS] || (Array.isArray(result[STORAGE_KEYS.GROUPS]) && result[STORAGE_KEYS.GROUPS].length === 0)) {
        chrome.storage.local.set({ [STORAGE_KEYS.GROUPS]: groups }, function () {
          if (chrome.runtime.lastError) { /* 静默处理：resize 后 resolve */ }
          resolve();
        });
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
