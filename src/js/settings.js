/* ============================================================
   settings.js — 设置面板交互逻辑
   负责：打开/关闭面板、表单绑定、设置保存与应用
   ============================================================ */

let currentSettings = {};

/* ---------- DOM 引用 ---------- */
const domSettings = {
  panel:      document.getElementById('settings-panel'),
  overlay:    document.getElementById('settings-overlay'),
  btnOpen:    document.getElementById('btn-settings'),
  btnClose:   document.getElementById('btn-settings-close'),

  searchEngine: document.getElementById('setting-search-engine'),
  toggleClock:  document.getElementById('toggle-clock'),
  toggleLunar:  document.getElementById('toggle-lunar'),
  toggleWeather: document.getElementById('toggle-weather'),
  toggleAddBtn:  document.getElementById('toggle-add-button'),
  toggleCardTitle: document.getElementById('toggle-card-title'),
  toggleShowVisitCount: document.getElementById('toggle-show-visit-count'),
  togglePureTextCards: document.getElementById('toggle-pure-text-cards'),
  toggleConfirmDelete: document.getElementById('toggle-confirm-delete'),
  toggleShowGroupIndicator: document.getElementById('toggle-show-group-indicator'),
  groupNameMode:   document.getElementById('setting-group-name-mode'),
  toggleLock:    document.getElementById('toggle-lock'),
  theme:         document.getElementById('setting-theme'),
  weatherType:   document.getElementById('setting-weather-type'),
  weatherCity:   document.getElementById('setting-weather-city'),
  weatherApi:    document.getElementById('setting-weather-api'),
  weatherKey:    document.getElementById('setting-weather-key'),
  weatherApiLink: document.getElementById('weather-api-link'),
  weatherRefresh: document.getElementById('setting-weather-refresh'),
  weatherRefreshVal: document.getElementById('refresh-interval-val'),
  weatherLimitInfo: document.getElementById('weather-limit-info'),
  weatherCacheStatus: document.getElementById('weather-cache-status'),
  customWeatherGroup: document.getElementById('custom-weather-group'),
  wallpaperMode: document.getElementById('setting-wallpaper-mode'),
  wallpaperUrl:  document.getElementById('setting-wallpaper-url'),
  customWallpaperGroup: document.getElementById('custom-wallpaper-group'),
  bingWallpaperGroup: document.getElementById('bing-wallpaper-group'),
  bingRegion:    document.getElementById('setting-bing-region'),
  bingUHD:       document.getElementById('toggle-bing-uhd'),
  bingAutoRefresh: document.getElementById('toggle-bing-auto-refresh'),
  bingRefresh:   document.getElementById('setting-bing-refresh'),
  bingRefreshVal: document.getElementById('bing-refresh-val'),

  // 布局
  toggleShowSearch: document.getElementById('toggle-show-search'),
  searchMarginTop:  document.getElementById('setting-search-top'),
  searchTopVal:     document.getElementById('search-top-val'),
  searchMarginBottom: document.getElementById('setting-search-gap'),
  searchGapVal:     document.getElementById('search-gap-val'),
  groupPosition:    document.getElementById('setting-group-position'),
  groupOffset:      document.getElementById('setting-group-offset'),
  groupOffsetVal:   document.getElementById('group-offset-val'),

  // 看板
  dashboardLayout:  document.getElementById('setting-dashboard-layout'),
  clockFormat:      document.getElementById('setting-clock-format'),
  toggleClockSeconds: document.getElementById('toggle-clock-seconds'),
  dashLeft:         document.getElementById('setting-dash-left'),
  dashLeftVal:      document.getElementById('dash-left-val'),
  dashBottom:       document.getElementById('setting-dash-bottom'),
  dashBottomVal:    document.getElementById('dash-bottom-val'),
  dashItemW:        document.getElementById('setting-dash-item-w'),
  dashItemWVal:     document.getElementById('dash-item-w-val'),
  dashItemH:        document.getElementById('setting-dash-item-h'),
  dashItemHVal:     document.getElementById('dash-item-h-val'),
  dashGap:          document.getElementById('setting-dash-gap'),
  dashGapVal:       document.getElementById('dash-gap-val'),
  lunarStyle:       document.getElementById('setting-lunar-style'),

  // 外观配色
  bgColor:       document.getElementById('setting-bg-color'),
  cardBgColor:   document.getElementById('setting-card-bg-color'),
  cardTextColor: document.getElementById('setting-card-text-color'),
  cardFontSize:  document.getElementById('setting-card-font-size'),
  cardFontSizeVal: document.getElementById('font-size-val'),

  // 卡片尺寸
  cardWidth:     document.getElementById('setting-card-width'),
  cardWidthVal:  document.getElementById('card-width-val'),
  cardHeight:    document.getElementById('setting-card-height'),
  cardHeightVal: document.getElementById('card-height-val'),
  columnsSlider:  document.getElementById('setting-columns-slider'),
  columnsSliderVal: document.getElementById('columns-slider-val'),
  cardBorderRadius: document.getElementById('setting-card-radius'),
  cardBorderRadiusVal: document.getElementById('radius-val'),
  cardOpenMode:    document.getElementById('setting-card-open-mode')
};

/* ---------- 初始化 ---------- */
async function initSettings() {
  currentSettings = await getSettings();
  populateSettingsForm(currentSettings);
  applyAllSettings(currentSettings);
  bindSettingsEvents();
  // 初始化外观实时预览
  initAppearance(domSettings, currentSettings, onAppearanceChanged);
  // 初始化数据管理按钮
  bindBackupEvents();
}

/** 将设置数据填入表单 */
function populateSettingsForm(settings) {
  domSettings.searchEngine.value = settings.activeSearchEngine || 'google';
  updateSearchEngineSelectOptions();
  domSettings.toggleClock.checked  = settings.showClock;
  domSettings.toggleLunar.checked  = settings.showLunar;
  domSettings.toggleWeather.checked = settings.showWeather;
  domSettings.toggleAddBtn.checked  = settings.showAddButton !== false;
  domSettings.toggleCardTitle.checked = settings.showCardTitle !== false;
  if (domSettings.toggleShowVisitCount) domSettings.toggleShowVisitCount.checked = settings.showVisitCount !== false;
  if (domSettings.togglePureTextCards) domSettings.togglePureTextCards.checked = settings.pureTextCards === true;
  if (domSettings.toggleConfirmDelete) domSettings.toggleConfirmDelete.checked = settings.confirmDelete !== false;
  if (domSettings.toggleLock) domSettings.toggleLock.checked = settings.isLocked === true;
  if (domSettings.toggleShowGroupIndicator) domSettings.toggleShowGroupIndicator.checked = settings.showGroupIndicator !== false;
  if (domSettings.groupNameMode) domSettings.groupNameMode.value = settings.showGroupName || 'all';
  domSettings.toggleShowSearch.checked = settings.showSearch !== false;
  if (domSettings.cardOpenMode) domSettings.cardOpenMode.value = settings.cardOpenMode || 'current';
  if (domSettings.groupPosition) domSettings.groupPosition.value = settings.groupPosition || 'left';
  if (domSettings.groupOffset) domSettings.groupOffset.value = settings.groupOffset || 16;
  if (domSettings.groupOffsetVal) domSettings.groupOffsetVal.textContent = (settings.groupOffset || 16) + 'px';
  if (domSettings.dashboardLayout) domSettings.dashboardLayout.value = settings.dashboardLayout || 'row';
  if (domSettings.dashLeft) domSettings.dashLeft.value = settings.dashLeft || 0;
  if (domSettings.dashLeftVal) domSettings.dashLeftVal.textContent = (settings.dashLeft || 0) === 0 ? '居中' : ((settings.dashLeft || 0) > 0 ? '右' : '左') + Math.abs(settings.dashLeft || 0) + 'px';
  if (domSettings.dashBottom) domSettings.dashBottom.value = settings.dashBottom || 0;
  if (domSettings.dashBottomVal) domSettings.dashBottomVal.textContent = (settings.dashBottom || 0) === 0 ? '底部' : (settings.dashBottom || 0) + 'px';
  if (domSettings.dashItemW) domSettings.dashItemW.value = settings.dashItemW || 140;
  if (domSettings.dashItemWVal) domSettings.dashItemWVal.textContent = (settings.dashItemW || 140) + 'px';
  if (domSettings.dashItemH) domSettings.dashItemH.value = settings.dashItemH || 0;
  if (domSettings.dashItemHVal) domSettings.dashItemHVal.textContent = (settings.dashItemH || 0) === 0 ? '自适应' : (settings.dashItemH || 0) + 'px';
  if (domSettings.dashGap) domSettings.dashGap.value = settings.dashGap || 16;
  if (domSettings.dashGapVal) domSettings.dashGapVal.textContent = (settings.dashGap || 16) + 'px';
  domSettings.theme.value         = settings.theme;
  domSettings.weatherType.value   = settings.weatherType || 'openmeteo';
  domSettings.weatherCity.value   = settings.weatherCity || '';
  domSettings.weatherApi.value    = settings.weatherApiUrl || '';
  domSettings.weatherKey.value    = settings.weatherApiKey || '';
  domSettings.wallpaperMode.value = settings.wallpaperMode || 'bing';
  domSettings.wallpaperUrl.value  = settings.wallpaperUrl || '';
  if (domSettings.bingRegion) domSettings.bingRegion.value = settings.bingRegion || 'zh-CN';
  if (domSettings.bingUHD) domSettings.bingUHD.checked = settings.bingUHD === true;
  if (domSettings.bingAutoRefresh) domSettings.bingAutoRefresh.checked = settings.bingAutoRefresh !== false;
  var bingMin = settings.bingRefreshMin || 360;
  if (domSettings.bingRefresh) domSettings.bingRefresh.value = Math.round(bingMin / 60);
  if (domSettings.bingRefreshVal) domSettings.bingRefreshVal.textContent = Math.round(bingMin / 60) + '小时';

  var searchTop = settings.searchMarginTop || 60;
  var searchGap = settings.searchMarginBottom || 48;
  if (domSettings.searchMarginTop) domSettings.searchMarginTop.value = searchTop;
  if (domSettings.searchTopVal) domSettings.searchTopVal.textContent = searchTop + 'px';
  if (domSettings.searchMarginBottom) domSettings.searchMarginBottom.value = searchGap;
  if (domSettings.searchGapVal) domSettings.searchGapVal.textContent = searchGap + 'px';

  // 刷新间隔
  var refreshMin = settings.weatherRefreshMin || 15;
  if (domSettings.weatherRefresh) domSettings.weatherRefresh.value = refreshMin;
  if (domSettings.weatherRefreshVal) domSettings.weatherRefreshVal.textContent = refreshMin + '分钟';

  // 根据 weatherType 显示/隐藏相关控件
  toggleCustomWeatherGroup(settings.weatherType || 'openmeteo');
  // 根据 wallpaperMode 显示/隐藏对应控件
  toggleCustomWallpaperGroup(settings.wallpaperMode || 'bing');
  toggleBingWallpaperGroup(settings.wallpaperMode || 'bing');
}

/** 应用所有设置到 UI */
function applyAllSettings(settings) {
  applyTheme(settings.theme);
  applyColumns(settings.columns);
  applySearchEngineIcon(settings.activeSearchEngine || 'google');
  applyComponentVisibility(settings);
  applyAddButtonVisibility(settings);
  applySearchSectionVisibility(settings);
  applySearchPosition(settings);
  applyGroupPosition(settings);
  applyDashboardLayout(settings);
  if (typeof renderGroupDots === 'function') renderGroupDots();
}

/** 应用主题 */
function applyTheme(theme) {
  if (theme === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

/** 应用卡片列数 */
function applyColumns(columns) {
  if (typeof updateGridColumns === 'function') {
    updateGridColumns(columns);
  }
}

/** 应用搜索引擎图标 */
function applySearchEngineIcon(engineId) {
  var iconEl = document.getElementById('search-engine-icon');
  if (!iconEl) return;
  var engines = currentSettings.searchEngines || [];
  var eng = engines.find(function (e) { return e.id === engineId; });
  var name = eng ? eng.name : '搜索';
  var icons = { google: '🔍', baidu: '🐾', bing: '🔎', sogou: '🐶', yandex: '🔍' };
  iconEl.textContent = icons[engineId] || '🔍';
  iconEl.title = name + ' 搜索（点击切换）';
}

/** 应用 + 号按钮可见性 */
function applyAddButtonVisibility(settings) {
  const addBtn = document.querySelector('.speeddial-card.card-add');
  if (addBtn) {
    addBtn.style.display = settings.showAddButton !== false ? '' : 'none';
  }
}

/** 切换自定义壁纸 URL 输入框显隐 */
function toggleCustomWallpaperGroup(mode) {
  if (domSettings.customWallpaperGroup) {
    if (mode === 'custom') {
      domSettings.customWallpaperGroup.classList.remove('hidden');
    } else {
      domSettings.customWallpaperGroup.classList.add('hidden');
    }
  }
}

/** 切换 Bing 壁纸高级设置显隐 */
function toggleBingWallpaperGroup(mode) {
  if (domSettings.bingWallpaperGroup) {
    if (mode === 'bing') {
      domSettings.bingWallpaperGroup.classList.remove('hidden');
    } else {
      domSettings.bingWallpaperGroup.classList.add('hidden');
    }
  }
}

/** 切换自定义天气 API 输入框显隐 + API Key 获取链接 + 限制说明 */
function toggleCustomWeatherGroup(type) {
  // 切换自定义 API 输入框
  if (domSettings.customWeatherGroup) {
    if (type === 'custom') {
      domSettings.customWeatherGroup.classList.remove('hidden');
    } else {
      domSettings.customWeatherGroup.classList.add('hidden');
    }
  }

  // API Key 输入框：Open-Meteo 不需要，隐藏
  var keyGroup = domSettings.weatherKey ? domSettings.weatherKey.closest('.setting-group') : null;
  var apiInfo = {
    openmeteo:       { needsKey: false, link: 'https://open-meteo.com/',         label: '↗ Open-Meteo 官网（无需注册）',   limit: '免费 · 每天 10,000 次 · 无需 API Key' },
    hefeng:          { needsKey: true,  link: 'https://dev.qweather.com/',       label: '↗ 前往和风天气控制台获取 Key',    limit: '免费版 · 每天 1,000 次 · 需要注册' },
    openweathermap:  { needsKey: true,  link: 'https://home.openweathermap.org/api_keys', label: '↗ 前往 OpenWeatherMap 获取 Key', limit: '免费版 · 每分钟 60 次 · 需要注册' },
    custom:          { needsKey: true,  link: '',                                 label: '',                               limit: '取决于你的 API 提供商' }
  };

  var info = apiInfo[type] || apiInfo.hefeng;

  // 显示/隐藏 API Key 输入框
  if (keyGroup) {
    keyGroup.style.display = info.needsKey ? '' : 'none';
  }

  // 更新获取渠道链接
  if (domSettings.weatherApiLink) {
    if (info.link) {
      domSettings.weatherApiLink.href = info.link;
      domSettings.weatherApiLink.textContent = info.label || '';
      domSettings.weatherApiLink.style.display = '';
    } else {
      domSettings.weatherApiLink.style.display = 'none';
    }
  }

  // 显示限制说明
  if (domSettings.weatherLimitInfo) {
    domSettings.weatherLimitInfo.textContent = info.limit || '';
  }
}

/** 搜索栏显隐 */
function applySearchSectionVisibility(settings) {
  var el = document.querySelector('.search-section');
  if (el) el.style.display = settings.showSearch !== false ? '' : 'none';
}

/** 搜索框垂直位置 */
function applySearchPosition(settings) {
  var top = (settings.searchMarginTop || 60) + 'px';
  var gap = (settings.searchMarginBottom || 48) + 'px';
  document.documentElement.style.setProperty('--search-top', top);
  document.documentElement.style.setProperty('--search-gap', gap);
}

/** 分组指示器位置 */
function applyGroupPosition(settings) {
  var el = document.getElementById('group-indicator');
  if (!el) return;
  var pos = settings.groupPosition || 'left';
  el.setAttribute('data-position', pos);
  document.documentElement.style.setProperty('--group-offset', (settings.groupOffset || 16) + 'px');
}

/** 看板布局 */
function applyDashboardLayout(settings) {
  var el = document.querySelector('.dashboard-section');
  if (!el) return;
  el.setAttribute('data-layout', settings.dashboardLayout || 'row');
  var hOff = (settings.dashLeft || 0);
  document.documentElement.style.setProperty('--dash-h-offset', hOff + 'px');
  document.documentElement.style.setProperty('--dash-bottom', (settings.dashBottom || 0) + 'px');
  document.documentElement.style.setProperty('--dash-gap', (settings.dashGap || 16) + 'px');
  var w = (settings.dashItemW || 140) + 'px';
  var h = (settings.dashItemH || 0) === 0 ? 'auto' : (settings.dashItemH || 0) + 'px';
  document.querySelectorAll('.dashboard-item').forEach(function (item) {
    item.style.width = w;
    item.style.height = h;
  });
}

/** 应用组件可见性 */
function applyComponentVisibility(settings) {
  const clockEl   = document.getElementById('dashboard-clock');
  const lunarEl   = document.getElementById('dashboard-lunar');
  const weatherEl = document.getElementById('dashboard-weather');

  if (clockEl)   clockEl.style.display   = settings.showClock   ? '' : 'none';
  if (lunarEl)   lunarEl.style.display   = settings.showLunar   ? '' : 'none';
  if (weatherEl) weatherEl.style.display = settings.showWeather ? '' : 'none';
}

/** 收集表单中当前的设置值 */
function collectSettingsFromForm() {
  return {
    searchEngine: domSettings.searchEngine.value, // deprecated
    activeSearchEngine: domSettings.searchEngine.value,
    searchEngines: currentSettings ? currentSettings.searchEngines : undefined,
    showClock:    domSettings.toggleClock.checked,
    showLunar:    domSettings.toggleLunar.checked,
    showWeather:  domSettings.toggleWeather.checked,
    showAddButton: domSettings.toggleAddBtn.checked,
    showCardTitle: domSettings.toggleCardTitle.checked,
    showVisitCount: domSettings.toggleShowVisitCount ? domSettings.toggleShowVisitCount.checked : true,
    pureTextCards: domSettings.togglePureTextCards ? domSettings.togglePureTextCards.checked : false,
    confirmDelete: domSettings.toggleConfirmDelete ? domSettings.toggleConfirmDelete.checked : true,
    showGroupName: domSettings.groupNameMode ? domSettings.groupNameMode.value : 'all',
    showGroupIndicator: domSettings.toggleShowGroupIndicator ? domSettings.toggleShowGroupIndicator.checked : true,
    dashboardLayout: domSettings.dashboardLayout ? domSettings.dashboardLayout.value : 'row',
    dashLeft: domSettings.dashLeft ? parseInt(domSettings.dashLeft.value, 10) : 0,
    dashBottom: domSettings.dashBottom ? parseInt(domSettings.dashBottom.value, 10) : 24,
    dashItemW: domSettings.dashItemW ? parseInt(domSettings.dashItemW.value, 10) : 140,
    dashItemH: domSettings.dashItemH ? parseInt(domSettings.dashItemH.value, 10) : 0,
    dashGap: domSettings.dashGap ? parseInt(domSettings.dashGap.value, 10) : 16,
    clockFormat: domSettings.clockFormat ? domSettings.clockFormat.value : '24h',
    clockShowSeconds: domSettings.toggleClockSeconds ? domSettings.toggleClockSeconds.checked : true,
    lunarStyle: domSettings.lunarStyle ? domSettings.lunarStyle.value : 'double',
    searchMarginTop: domSettings.searchMarginTop ? parseInt(domSettings.searchMarginTop.value, 10) : 60,
    searchMarginBottom: domSettings.searchMarginBottom ? parseInt(domSettings.searchMarginBottom.value, 10) : 48,
    showSearch: domSettings.toggleShowSearch ? domSettings.toggleShowSearch.checked : true,
    groupPosition: domSettings.groupPosition ? domSettings.groupPosition.value : 'left',
    groupOffset: domSettings.groupOffset ? parseInt(domSettings.groupOffset.value, 10) : 16,
    theme:         domSettings.theme.value,
    weatherType:   domSettings.weatherType.value,
    weatherCity:   domSettings.weatherCity.value.trim(),
    weatherApiUrl: domSettings.weatherApi.value.trim(),
    weatherApiKey: domSettings.weatherKey.value.trim(),
    weatherRefreshMin: domSettings.weatherRefresh ? parseInt(domSettings.weatherRefresh.value, 10) : 15,
    wallpaperMode: domSettings.wallpaperMode.value,
    wallpaperUrl:  domSettings.wallpaperUrl.value.trim(),
    bingRegion:    domSettings.bingRegion ? domSettings.bingRegion.value : 'zh-CN',
    bingUHD:       domSettings.bingUHD ? domSettings.bingUHD.checked : false,
    bingAutoRefresh: domSettings.bingAutoRefresh ? domSettings.bingAutoRefresh.checked : true,
    bingRefreshMin: domSettings.bingRefresh ? parseInt(domSettings.bingRefresh.value, 10) * 60 : 360,
    cardOpenMode:  domSettings.cardOpenMode ? domSettings.cardOpenMode.value : 'current',
    // 外观数据由 appearance.js 的 collectAppearanceForm 收集并合并
    ...collectAppearanceForm(domSettings)
  };
}

/* ---------- 面板开关 ---------- */
function openSettingsPanel() {
  domSettings.panel.classList.remove('hidden');
  domSettings.overlay.classList.remove('hidden');
  // 重置面板位置
  domSettings.panel.style.left = '';
  domSettings.panel.style.top = '';
  domSettings.panel.style.transform = '';
  updateWeatherCacheStatus();
  if (typeof updateImageDBInfo === 'function') updateImageDBInfo();
  updateSortModeSelect();
}

function closeSettingsPanel() {
  domSettings.panel.classList.add('hidden');
  domSettings.overlay.classList.add('hidden');
}

/* ---------- 事件绑定 ---------- */
function bindSettingsEvents() {
  domSettings.btnOpen.addEventListener('click', openSettingsPanel);
  domSettings.btnClose.addEventListener('click', closeSettingsPanel);
  domSettings.overlay.addEventListener('click', closeSettingsPanel);

  // 面板拖拽
  var header = domSettings.panel.querySelector('.settings-panel-header');
  if (header) {
    header.style.cursor = 'move';
    header.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) return;
      var panel = domSettings.panel;
      var rect = panel.getBoundingClientRect();
      var startX = e.clientX, startY = e.clientY;
      var origLeft = rect.left, origTop = rect.top;

      function onMove(ev) {
        panel.style.left = (origLeft + ev.clientX - startX) + 'px';
        panel.style.top = (origTop + ev.clientY - startY) + 'px';
        panel.style.transform = 'none';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  // 设置面板标签切换
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var tab = this.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
      this.classList.add('active');
      var content = document.getElementById('tab-' + tab);
      if (content) content.classList.add('active');
      // 切换标签时刷新相关状态
      if (tab === 'data') { if (typeof updateImageDBInfo === 'function') updateImageDBInfo(); }
      if (tab === 'weather') { if (typeof updateWeatherCacheStatus === 'function') updateWeatherCacheStatus(); }
    });
  });

  // 右上角主题切换按钮
  var btnTheme = document.getElementById('btn-theme');
  if (btnTheme) {
    btnTheme.addEventListener('click', function () {
      var current = currentSettings.theme;
      var next;
      if (current === 'light') { next = 'dark'; }
      else if (current === 'dark') { next = 'auto'; }
      else { next = 'light'; }
      currentSettings.theme = next;
      applyTheme(currentSettings.theme);
      saveSettings(currentSettings);
      domSettings.theme.value = currentSettings.theme;
      updateThemeIcon(next);
      showToast('主题：' + (next === 'light' ? '浅色' : next === 'dark' ? '深色' : '跟随系统'), 'info');
    });
  }

  // 初始化主题图标
  if (currentSettings) updateThemeIcon(currentSettings.theme);

  function updateThemeIcon(theme) {
    var sun = document.getElementById('ico-sun');
    var moon = document.getElementById('ico-moon');
    var auto = document.getElementById('ico-auto');
    if (sun) sun.style.display = theme === 'light' ? '' : 'none';
    if (moon) moon.style.display = theme === 'dark' ? '' : 'none';
    if (auto) auto.style.display = theme === 'auto' ? '' : 'none';
    var btn = document.getElementById('btn-theme');
    if (btn) btn.title = '主题：' + (theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统') + '（点击切换）';
  }

  // 天气类型切换 → 显示/隐藏自定义 API 输入框
  domSettings.weatherType.addEventListener('change', () => {
    toggleCustomWeatherGroup(domSettings.weatherType.value);
    onSettingChanged();
  });

  // 刷新间隔滑块
  if (domSettings.weatherRefresh && domSettings.weatherRefreshVal) {
    domSettings.weatherRefresh.addEventListener('input', function () {
      domSettings.weatherRefreshVal.textContent = this.value + '分钟';
    });
    domSettings.weatherRefresh.addEventListener('change', onSettingChanged);
  }

  // 壁纸模式切换 → 显示/隐藏对应控件
  domSettings.wallpaperMode.addEventListener('change', () => {
    toggleCustomWallpaperGroup(domSettings.wallpaperMode.value);
    toggleBingWallpaperGroup(domSettings.wallpaperMode.value);
    onSettingChanged();
  });

  // Bing 刷新间隔滑块
  if (domSettings.bingRefresh && domSettings.bingRefreshVal) {
    domSettings.bingRefresh.addEventListener('input', function () {
      domSettings.bingRefreshVal.textContent = this.value + '小时';
    });
    domSettings.bingRefresh.addEventListener('change', onSettingChanged);
  }

  // Bing 立即刷新按钮
  var btnBingRefresh = document.getElementById('btn-bing-refresh-now');
  if (btnBingRefresh) {
    btnBingRefresh.addEventListener('click', function () {
      if (typeof refreshBingWallpaper === 'function') {
        refreshBingWallpaper();
        showToast('Bing 壁纸已刷新', 'success');
      }
    });
  }

  // 搜索位置滑块
  if (domSettings.searchMarginTop && domSettings.searchTopVal) {
    domSettings.searchMarginTop.addEventListener('input', function () {
      domSettings.searchTopVal.textContent = this.value + 'px';
      document.documentElement.style.setProperty('--search-top', this.value + 'px');
    });
    domSettings.searchMarginTop.addEventListener('change', onSettingChanged);
  }
  if (domSettings.searchMarginBottom && domSettings.searchGapVal) {
    domSettings.searchMarginBottom.addEventListener('input', function () {
      domSettings.searchGapVal.textContent = this.value + 'px';
      document.documentElement.style.setProperty('--search-gap', this.value + 'px');
    });
    domSettings.searchMarginBottom.addEventListener('change', onSettingChanged);
  }

  // 分组指示器边距滑块
  if (domSettings.groupOffset && domSettings.groupOffsetVal) {
    domSettings.groupOffset.addEventListener('input', function () {
      domSettings.groupOffsetVal.textContent = this.value + 'px';
      document.documentElement.style.setProperty('--group-offset', this.value + 'px');
    });
    domSettings.groupOffset.addEventListener('change', onSettingChanged);
  }

  // 看板位置滑块（实时预览）
  if (domSettings.dashLeft && domSettings.dashLeftVal) {
    domSettings.dashLeft.addEventListener('input', function () {
      var v = parseInt(this.value, 10);
      domSettings.dashLeftVal.textContent = v === 0 ? '居中' : (v > 0 ? '右' : '左') + Math.abs(v) + 'px';
      document.documentElement.style.setProperty('--dash-h-offset', v + 'px');
    });
    domSettings.dashLeft.addEventListener('change', onSettingChanged);
  }
  if (domSettings.dashBottom && domSettings.dashBottomVal) {
    domSettings.dashBottom.addEventListener('input', function () {
      var v = parseInt(this.value, 10);
      domSettings.dashBottomVal.textContent = v === 0 ? '底部' : v + 'px';
      document.documentElement.style.setProperty('--dash-bottom', v + 'px');
    });
    domSettings.dashBottom.addEventListener('change', onSettingChanged);
  }

  // 重置看板位置
  var btnResetDash = document.getElementById('btn-reset-dash-pos');
  if (btnResetDash) {
    btnResetDash.addEventListener('click', function () {
      if (domSettings.dashLeft) domSettings.dashLeft.value = 0;
      if (domSettings.dashLeftVal) domSettings.dashLeftVal.textContent = '居中';
      if (domSettings.dashBottom) domSettings.dashBottom.value = 0;
      if (domSettings.dashBottomVal) domSettings.dashBottomVal.textContent = '底部';
      document.documentElement.style.setProperty('--dash-h-offset', '0px');
      document.documentElement.style.setProperty('--dash-bottom', '0px');
      onSettingChanged();
    });
  }

  // 重置看板大小
  var btnResetSize = document.getElementById('btn-reset-dash-size');
  if (btnResetSize) {
    btnResetSize.addEventListener('click', function () {
      if (domSettings.dashItemW) domSettings.dashItemW.value = 140;
      if (domSettings.dashItemWVal) domSettings.dashItemWVal.textContent = '140px';
      if (domSettings.dashItemH) domSettings.dashItemH.value = 0;
      if (domSettings.dashItemHVal) domSettings.dashItemHVal.textContent = '自适应';
      if (domSettings.dashGap) domSettings.dashGap.value = 16;
      if (domSettings.dashGapVal) domSettings.dashGapVal.textContent = '16px';
      document.documentElement.style.setProperty('--dash-gap', '16px');
      document.querySelectorAll('.dashboard-item').forEach(function (item) { item.style.width = '140px'; item.style.height = ''; });
      onSettingChanged();
    });
  }

  // 组件间距滑块
  if (domSettings.dashGap && domSettings.dashGapVal) {
    domSettings.dashGap.addEventListener('input', function () {
      var v = this.value + 'px';
      domSettings.dashGapVal.textContent = v;
      document.documentElement.style.setProperty('--dash-gap', v);
    });
    domSettings.dashGap.addEventListener('change', onSettingChanged);
  }

  // 组件尺寸滑块（实时预览）
  if (domSettings.dashItemW && domSettings.dashItemWVal) {
    domSettings.dashItemW.addEventListener('input', function () {
      var v = this.value + 'px';
      domSettings.dashItemWVal.textContent = v;
      document.querySelectorAll('.dashboard-item').forEach(function (item) { item.style.width = v; });
    });
    domSettings.dashItemW.addEventListener('change', onSettingChanged);
  }
  if (domSettings.dashItemH && domSettings.dashItemHVal) {
    domSettings.dashItemH.addEventListener('input', function () {
      var v = parseInt(this.value, 10);
      domSettings.dashItemHVal.textContent = v === 0 ? '自适应' : v + 'px';
      document.querySelectorAll('.dashboard-item').forEach(function (item) { item.style.height = v === 0 ? '' : v + 'px'; });
    });
    domSettings.dashItemH.addEventListener('change', onSettingChanged);
  }

  // 表单变更时自动保存并应用
  const formElements = [
    domSettings.searchEngine,
    domSettings.theme,
    domSettings.weatherCity,
    domSettings.weatherApi,
    domSettings.weatherKey,
    domSettings.wallpaperUrl,
    domSettings.bingRegion,
    domSettings.bingRegion,
    domSettings.groupPosition,
    domSettings.groupNameMode
  ];

  formElements.forEach((el) => {
    el.addEventListener('change', onSettingChanged);
  });

  [domSettings.toggleClock, domSettings.toggleLunar, domSettings.toggleWeather, domSettings.toggleAddBtn, domSettings.toggleCardTitle, domSettings.toggleShowVisitCount, domSettings.toggleConfirmDelete, domSettings.toggleShowGroupIndicator, domSettings.bingUHD, domSettings.bingAutoRefresh, domSettings.toggleShowSearch, domSettings.toggleClockSeconds].forEach((el) => {
    if (!el) return;
    el.addEventListener('change', onSettingChanged);
  });

  // v1.0.9: 排序下拉 — 保存到当前分组
  var sortSel = document.getElementById('setting-sort-mode');
  if (sortSel) {
    sortSel.addEventListener('change', onSortModeChanged);
  }

  // 搜索引擎管理按钮
  var btnEngMgr = document.getElementById('btn-search-engine-mgr');
  if (btnEngMgr) {
    btnEngMgr.addEventListener('click', function () {
      if (typeof openSearchEngineManager === 'function') openSearchEngineManager();
    });
  }

  // 分组管理器按钮
  var btnGroupMgr = document.getElementById('btn-open-group-manager');
  if (btnGroupMgr) {
    btnGroupMgr.addEventListener('click', function () {
      if (typeof openGroupManager === 'function') openGroupManager();
    });
  }

  // 锁定开关：同步到 main.js 的 isLocked 状态
  if (domSettings.toggleLock) {
    domSettings.toggleLock.addEventListener('change', function () {
      if (typeof setLocked === 'function') {
        setLocked(this.checked);
      }
      onSettingChanged();
    });
  }

  // 卡片打开方式
  if (domSettings.cardOpenMode) {
    domSettings.cardOpenMode.addEventListener('change', onSettingChanged);
  }

  // 跟随系统主题的实时响应
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentSettings.theme === 'auto') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    }
  });

  // ESC 关闭面板
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !domSettings.panel.classList.contains('hidden')) {
      closeSettingsPanel();
    }
  });
}

/** 设置变更处理 */
async function onSettingChanged() {
  currentSettings = collectSettingsFromForm();
  await saveSettings(currentSettings);
  applyAllSettings(currentSettings);

  // 如果列数变了，重新渲染卡片网格
  if (typeof renderSpeeddials === 'function') {
    renderSpeeddials();
  }
  // 分组显示相关设置变了
  if (typeof renderGroupDots === 'function') {
    renderGroupDots();
  }

  // 如果天气相关设置变了，刷新天气
  if (typeof refreshWeather === 'function' && currentSettings.showWeather) {
    refreshWeather();
  }

  // 更新天气缓存状态显示
  updateWeatherCacheStatus();

  // 如果农历开关变化，更新农历
  if (typeof updateLunarDisplay === 'function' && currentSettings.showLunar) {
    updateLunarDisplay();
  }

  // 如果壁纸设置变化，刷新壁纸
  if (typeof applyWallpaper === 'function') {
    applyWallpaper(currentSettings);
  }
}

/** 外观变更回调（由 appearance.js 的 change 事件触发） */
async function onAppearanceChanged() {
  currentSettings = collectSettingsFromForm();
  await saveSettings(currentSettings);
  applyAllSettings(currentSettings);

  if (typeof renderSpeeddials === 'function') {
    renderSpeeddials();
  }
}

/** 更新天气缓存状态显示 */
async function updateWeatherCacheStatus() {
  var el = document.getElementById('weather-cache-status');
  if (!el) return;
  var span = el.querySelector('.cache-status');
  if (!span) return;

  if (typeof getWeatherStatus === 'function') {
    var status = await getWeatherStatus();
    if (status.cached) {
      span.textContent = '📡 ' + status.apiName + ' · ' + status.info;
    } else {
      span.textContent = '📡 缓存状态：' + status.info;
    }
  } else {
    span.textContent = '📡 缓存状态：暂无数据';
  }
}

/** v1.0.9: 按分组更新排序下拉框 */
function updateSortModeSelect() {
  var sel = document.getElementById('setting-sort-mode');
  if (!sel) return;
  var sm = (typeof groups !== 'undefined' && groups[activeGroupIndex]) ? (groups[activeGroupIndex].sortMode || 'manual') : 'manual';
  sel.value = sm;
}

/** v1.0.9: 排序下拉变更时保存到当前分组 */
async function onSortModeChanged() {
  var sel = document.getElementById('setting-sort-mode');
  if (!sel) return;
  if (!groups[activeGroupIndex]) return;
  groups[activeGroupIndex].sortMode = sel.value || 'manual';
  await saveGroups(groups);
  if (typeof renderSpeeddials === 'function') renderSpeeddials();
}

/** 同步搜索引擎下拉框选项 */
function updateSearchEngineSelectOptions() {
  if (typeof updateSearchEngineSelect === 'function') {
    updateSearchEngineSelect();
  }
}
