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
  cardOpenMode: 'current',
  showVisitCount: true,
  cardsMarginTop: 0,
  groupDotSize: 10,
  groupTabSize: 13
};

function loadFromStorage(key, defaultValue) {
  return new Promise(function (resolve) {
    chrome.storage.sync.get([key], function (result) {
      resolve(result[key] !== undefined ? result[key] : defaultValue);
    });
  });
}

function saveToStorage(key, value) {
  return new Promise(function (resolve) {
    chrome.storage.sync.set({ [key]: value }, function () { resolve(); });
  });
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

async function saveGroups(groups) {
  if (typeof _savingGroups !== 'undefined') _savingGroups = true;
  await saveToStorage(STORAGE_KEYS.GROUPS, groups);
  if (typeof _savingGroups !== 'undefined') _savingGroups = false;
  // 同步存储超限时自动回退到本地存储
  await new Promise(function (resolve) {
    chrome.storage.sync.get([STORAGE_KEYS.GROUPS], function (result) {
      if (!result[STORAGE_KEYS.GROUPS] || (Array.isArray(result[STORAGE_KEYS.GROUPS]) && result[STORAGE_KEYS.GROUPS].length === 0)) {
        chrome.storage.local.set({ [STORAGE_KEYS.GROUPS]: groups }, resolve);
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
  await saveToStorage(STORAGE_KEYS.ACTIVE_GROUP, index);
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
  var stored = await loadFromStorage(STORAGE_KEYS.SETTINGS, {});
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
  return saveToStorage(STORAGE_KEYS.SETTINGS, settings);
}
