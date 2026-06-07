/* ============================================================
   weather.js - 天气 API 调用与渲染逻辑
   支持：和风天气 / Open-Meteo(免费免Key) / OpenWeatherMap / 自定义
   通过 Service Worker 代理请求，绕过 newtab 页面的 fetch 限制
   包含缓存机制，避免频繁请求触发 API 限制
   ============================================================ */

// ---- 工具：通过 Service Worker 代理 HTTP 请求 ----
function swFetch(url) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage({ type: 'weather-fetch', url: url }, function (resp) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (resp && resp.ok) {
        resolve({
          text: function () { return Promise.resolve(resp.data); },
          json: function () {
            try {
              return Promise.resolve(JSON.parse(resp.data));
            } catch (e) {
              var preview = (resp.data || '').substring(0, 120);
              return Promise.reject(new Error('API 返回非 JSON 数据: ' + preview));
            }
          }
        });
      } else {
        reject(new Error((resp && resp.error) || 'request failed'));
      }
    });
  });
}

// ---- API 端点配置 ----
var WEATHER_APIS = {
  hefeng: { name: '和风天气', geoApi: 'https://geoapi.qweather.com/v2/city/lookup', weatherApi: 'https://devapi.qweather.com/v7/weather/now', needsKey: true, keyLink: 'https://dev.qweather.com/', keyLabel: '前往和风天气控制台获取 Key', rateLimit: '免费版：每天 1000 次', cacheMin: 30 },
  openmeteo: { name: 'Open-Meteo（免费免 Key）', weatherApi: 'https://api.open-meteo.com/v1/forecast', needsKey: false, keyLink: 'https://open-meteo.com/', keyLabel: 'Open-Meteo 官网（无需注册）', rateLimit: '免费·每天 10000 次·无需 Key', cacheMin: 15 },
  openweathermap: { name: 'OpenWeatherMap', weatherApi: 'https://api.openweathermap.org/data/2.5/weather', geoApi: 'https://api.openweathermap.org/geo/1.0/direct', needsKey: true, keyLink: 'https://home.openweathermap.org/api_keys', keyLabel: '前往 OpenWeatherMap 获取 Key', rateLimit: '免费版：每分钟 60 次', cacheMin: 20 },
  custom: { name: '自定义 API', needsKey: true, keyLink: '', keyLabel: '', rateLimit: '取决于你的 API 提供商', cacheMin: 30 }
};

// ---- 天气图标映射 ----
var HEFENG_ICONS = { '100': '\u2600\uFE0F', '101': '\uD83C\uDF24\uFE0F', '102': '\u26C5', '103': '\uD83C\uDF25\uFE0F', '104': '\u2601\uFE0F', '300': '\uD83C\uDF26\uFE0F', '400': '\uD83C\uDF28\uFE0F', '500': '\uD83C\uDF2B\uFE0F' };
var WMO_ICONS = { 0: '\u2600\uFE0F', 1: '\uD83C\uDF24\uFE0F', 2: '\u26C5', 3: '\u2601\uFE0F', 45: '\uD83C\uDF2B\uFE0F', 48: '\uD83C\uDF2B\uFE0F', 51: '\uD83C\uDF26\uFE0F', 53: '\uD83C\uDF26\uFE0F', 55: '\uD83C\uDF26\uFE0F', 56: '\uD83C\uDF26\uFE0F', 57: '\uD83C\uDF26\uFE0F', 61: '\uD83C\uDF27\uFE0F', 63: '\uD83C\uDF27\uFE0F', 65: '\uD83C\uDF27\uFE0F', 66: '\uD83C\uDF27\uFE0F', 67: '\uD83C\uDF27\uFE0F', 71: '\uD83C\uDF28\uFE0F', 73: '\uD83C\uDF28\uFE0F', 75: '\uD83C\uDF28\uFE0F', 77: '\uD83C\uDF28\uFE0F', 80: '\uD83C\uDF27\uFE0F', 81: '\uD83C\uDF27\uFE0F', 82: '\uD83C\uDF27\uFE0F', 85: '\uD83C\uDF28\uFE0F', 86: '\uD83C\uDF28\uFE0F', 95: '\u26C8\uFE0F', 96: '\u26C8\uFE0F', 99: '\u26C8\uFE0F' };
var WMO_TEXT = { 0: '晴', 1: '大部晴', 2: '多云', 3: '阴', 45: '雾', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒', 80: '阵雨', 81: '中阵雨', 82: '大阵雨', 85: '小雪阵', 86: '大雪阵', 95: '雷暴', 96: '雷暴+冰雹', 99: '强雷暴+冰雹' };
// BUG-011: OpenWeatherMap 天气码 → WMO 标准码映射
var OWM_TO_WMO = { 200:95, 201:95, 202:95, 210:95, 211:95, 212:95, 221:95, 230:95, 231:95, 232:95, 300:51, 301:51, 302:53, 310:51, 311:53, 312:55, 313:55, 314:55, 321:55, 500:61, 501:63, 502:65, 503:65, 504:65, 511:66, 520:80, 521:81, 522:82, 531:82, 600:71, 601:73, 602:75, 611:77, 612:77, 613:77, 615:71, 616:73, 620:71, 621:73, 622:75, 701:45, 711:45, 721:45, 731:45, 741:45, 751:45, 761:45, 762:45, 771:45, 781:45, 800:0, 801:1, 802:2, 803:3, 804:3 };

// ---- 缓存系统 ----
var WEATHER_CACHE_KEY = 'weather_data_cache';
var WEATHER_CACHE_META = 'weather_cache_meta';

async function getWeatherCache() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([WEATHER_CACHE_KEY, WEATHER_CACHE_META], function (result) {
      resolve({ data: result[WEATHER_CACHE_KEY] || null, meta: result[WEATHER_CACHE_META] || null });
    });
  });
}

async function setWeatherCache(data, type, city) {
  var meta = { type: type, city: city, timestamp: Date.now(), timeStr: new Date().toLocaleTimeString('zh-CN') };
  await new Promise(function (resolve) {
    chrome.storage.local.set({ [WEATHER_CACHE_KEY]: data, [WEATHER_CACHE_META]: meta }, resolve);
  });
  // BUG-012: 返回 meta，调用方无需再读 IndexedDB
  return meta;
}

function getCacheMin(settings) {
  if (settings.weatherRefreshMin && settings.weatherRefreshMin > 0) return settings.weatherRefreshMin;
  var api = WEATHER_APIS[settings.weatherType || 'openmeteo'];
  return (api && api.cacheMin) ? api.cacheMin : 30;
}

function isCacheValid(meta, settings) {
  if (!meta || !meta.timestamp) return false;
  if (meta.type !== (settings.weatherType || 'openmeteo')) return false;
  if ((meta.city || '') !== (settings.weatherCity || '')) return false;
  return (Date.now() - meta.timestamp) / 60000 < getCacheMin(settings);
}

function getCacheInfo(meta, settings) {
  if (!meta || !meta.timestamp) return '无缓存';
  var elapsed = Math.floor((Date.now() - meta.timestamp) / 60000);
  var remaining = Math.max(0, getCacheMin(settings) - elapsed);
  return '缓存 ' + elapsed + ' 分钟前 · ' + remaining + ' 分钟后刷新';
}

// ---- 天气主入口 ----
function weatherStatus(msg, title) {
  var cityEl = document.querySelector('.weather-city');
  var detailEl = document.querySelector('.weather-detail');
  if (cityEl) { cityEl.textContent = msg; cityEl.title = title || ''; }
  if (detailEl) detailEl.textContent = '';
}

async function fetchAndDisplayWeather(settings) {
  var type = settings.weatherType || 'openmeteo';
  var api = WEATHER_APIS[type];

  if (api && !api.needsKey) {
    var cache = await getWeatherCache();
    if (isCacheValid(cache.meta, settings) && cache.data) { renderWeather(cache.data, type, cache.meta); return; }
    weatherStatus('天气加载中...');
    try {
      var data = await fetchOpenMeteoWeather(settings);
      var weatherMeta = await setWeatherCache(data, type, settings.weatherCity || data.city || '');
      renderWeather(data, type, weatherMeta);
    } catch (err) {
      console.error('Open-Meteo error:', err);
      if (cache.data) { renderWeather(cache.data, type, cache.meta); }
      else { weatherStatus('获取失败: ' + (err.message || 'unknown'), ''); }
    }
    return;
  }

  if (!settings || !settings.weatherApiKey) {
    var cacheFallback = await getWeatherCache();
    if (cacheFallback.meta && cacheFallback.data) {
      renderWeather(cacheFallback.data, type, cacheFallback.meta);
      return;
    }
    weatherStatus('请设置天气 API Key', '或切换为 Open-Meteo 免 Key'); return; }

  var cache2 = await getWeatherCache();
  if (isCacheValid(cache2.meta, settings) && cache2.data) { renderWeather(cache2.data, type, cache2.meta); return; }

  weatherStatus('天气加载中...');
  try {
    var weatherData;
    if (type === 'hefeng') { weatherData = await fetchHefengWeather(settings); }
    else if (type === 'openweathermap') { weatherData = await fetchOpenWeatherMapWeather(settings); }
    else if (type === 'custom') { weatherData = await fetchCustomWeather(settings); }
    else { throw new Error('未知数据源'); }
    var weatherMeta = await setWeatherCache(weatherData, type, settings.weatherCity || weatherData.city || '');
    renderWeather(weatherData, type, weatherMeta);
  } catch (err) {
    console.error('Weather error:', err);
    if (cache2.data) { renderWeather(cache2.data, type, cache2.meta); }
    else { weatherStatus('获取失败: ' + (err.message || 'unknown'), ''); }
  }
}

// ---- 和风天气 ----
async function fetchHefengWeather(settings) {
  var key = settings.weatherApiKey;
  var city = settings.weatherCity;
  if (!city) { city = await detectCityByIP(key); }
  var geoRes = await swFetch(WEATHER_APIS.hefeng.geoApi + '?location=' + encodeURIComponent(city) + '&key=' + key);
  var geoData = await geoRes.json();
  if (geoData.code !== '200' || !geoData.location || !geoData.location.length) { throw new Error('城市未找到: ' + (city || 'unknown')); }
  var locId = geoData.location[0].id;
  var cityName = geoData.location[0].name;
  var weatherRes = await swFetch(WEATHER_APIS.hefeng.weatherApi + '?location=' + locId + '&key=' + key);
  var wd = await weatherRes.json();
  if (wd.code !== '200') { throw new Error('和风天气 code: ' + wd.code); }
  return { city: cityName, temp: wd.now.temp, text: wd.now.text, icon: wd.now.icon, feelsLike: wd.now.feelsLike, humidity: wd.now.humidity, windDir: wd.now.windDir, windScale: wd.now.windScale };
}

// ---- Open-Meteo（免费免 Key） ----
var OM_GEO_CACHE_KEY = 'openmeteo_coords';

async function getOpenMeteoCoords(settings) {
  var cached = await new Promise(function (resolve) {
    chrome.storage.local.get([OM_GEO_CACHE_KEY], function (r) { resolve(r[OM_GEO_CACHE_KEY] || null); });
  });
  var city = settings.weatherCity;
  if (city && (!cached || cached.city !== city)) {
    try {
      var geoRes = await swFetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=zh');
      var geoData = await geoRes.json();
      if (geoData.results && geoData.results.length > 0) {
        var r = geoData.results[0];
        var coords = { lat: r.latitude, lon: r.longitude, city: r.name, source: 'geocode' };
        chrome.storage.local.set({ [OM_GEO_CACHE_KEY]: coords });
        return coords;
      }
    } catch (e) {}
  }
  if (cached && cached.lat) return cached;
  var coords = { lat: 39.9042, lon: 116.4074, city: city || '北京', source: 'default' };
  chrome.storage.local.set({ [OM_GEO_CACHE_KEY]: coords });
  return coords;
}

async function fetchOpenMeteoWeather(settings) {
  var coords = await getOpenMeteoCoords(settings);
  var url = WEATHER_APIS.openmeteo.weatherApi + '?latitude=' + coords.lat + '&longitude=' + coords.lon + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m&timezone=auto';
  var res = await swFetch(url);
  var data = await res.json();
  if (!data.current) { throw new Error('Open-Meteo 无数据'); }
  var wc = data.current.weather_code;
  return { city: coords.city || '当前位置', temp: Math.round(data.current.temperature_2m), text: WMO_TEXT[wc] || '?', icon: String(wc), feelsLike: Math.round(data.current.apparent_temperature), humidity: data.current.relative_humidity_2m, windDir: windDegToDir(data.current.wind_direction_10m), windScale: msToWindScale(data.current.wind_speed_10m), source: 'openmeteo' };
}

function windDegToDir(deg) { if (deg == null) return ''; return ['北','东北','东','东南','南','西南','西','西北'][Math.round(deg / 45) % 8]; }
function msToWindScale(ms) { if (ms == null) return ''; if (ms < 0.3) return '0'; if (ms < 1.6) return '1'; if (ms < 3.4) return '2'; if (ms < 5.5) return '3'; if (ms < 8.0) return '4'; if (ms < 10.8) return '5'; if (ms < 13.9) return '6'; if (ms < 17.2) return '7'; if (ms < 20.8) return '8'; if (ms < 24.5) return '9'; return '10+'; }

// ---- OpenWeatherMap ----
async function fetchOpenWeatherMapWeather(settings) {
  var key = settings.weatherApiKey, city = settings.weatherCity || 'Beijing';
  var geoRes = await swFetch(WEATHER_APIS.openweathermap.geoApi + '?q=' + encodeURIComponent(city) + '&limit=1&appid=' + key);
  var geoData = await geoRes.json();
  if (!geoData || !geoData.length) { throw new Error('城市未找到: ' + city); }
  var lat = geoData[0].lat, lon = geoData[0].lon;
  var cityName = (geoData[0].local_names && geoData[0].local_names.zh) ? geoData[0].local_names.zh : geoData[0].name;
  var weatherRes = await swFetch(WEATHER_APIS.openweathermap.weatherApi + '?lat=' + lat + '&lon=' + lon + '&appid=' + key + '&units=metric&lang=zh_cn');
  var data = await weatherRes.json();
  if (data.cod !== 200) { throw new Error('OpenWeatherMap: ' + (data.message || 'unknown')); }
  return { city: cityName, temp: Math.round(data.main.temp), text: data.weather && data.weather[0] ? data.weather[0].description : '', icon: data.weather && data.weather[0] ? 'owm_' + data.weather[0].id : '100', feelsLike: Math.round(data.main.feels_like), humidity: data.main.humidity, windDir: data.wind ? windDegToDir(data.wind.deg) : '', windScale: data.wind ? msToWindScale(data.wind.speed) : '', source: 'openweathermap' };
}

// ---- 自定义 API ----
async function fetchCustomWeather(settings) {
  var url = settings.weatherApiUrl;
  if (!url) { throw new Error('请填写自定义 API 地址'); }
  url = url.replace('{city}', encodeURIComponent(settings.weatherCity || '北京'));
  url = url.replace('{key}', encodeURIComponent(settings.weatherApiKey));
  var res = await swFetch(url);
  var data = await res.json();
  if (data.now) { return { city: settings.weatherCity || '自定义', temp: data.now.temp, text: data.now.text, icon: data.now.icon, feelsLike: data.now.feelsLike, humidity: data.now.humidity, windDir: data.now.windDir, windScale: data.now.windScale }; }
  if (data.main) { return { city: data.name || settings.weatherCity, temp: Math.round(data.main.temp - 273.15), text: data.weather && data.weather[0] ? data.weather[0].description : '', icon: data.weather && data.weather[0] ? 'owm_' + data.weather[0].id : '100', feelsLike: Math.round(data.main.feels_like - 273.15), humidity: data.main.humidity, windDir: '', windScale: data.wind ? data.wind.speed : '' }; }
  throw new Error('Unknown API format');
}

// ---- IP 定位（和风天气用） ----
async function detectCityByIP(key) {
  try {
    var res = await swFetch('https://geoapi.qweather.com/v2/city/lookup?location=auto_ip&key=' + key);
    var data = await res.json();
    if (data.code === '200' && data.location && data.location.length > 0) { return data.location[0].name; }
  } catch (e) {}
  return '北京';
}

// ---- 渲染到页面 ----
function renderWeather(data, type, meta) {
  var icon = '?';
  if (data.source === 'openmeteo') { icon = WMO_ICONS[parseInt(data.icon)] || '?'; }
  else if (String(data.icon).startsWith('owm_')) {
    // BUG-011: 将 OWM 天气码映射到 WMO 标准码再查图标
    var owmCode = parseInt(String(data.icon).replace('owm_', ''), 10);
    var wmoCode = OWM_TO_WMO[owmCode];
    icon = wmoCode !== undefined ? (WMO_ICONS[wmoCode] || '?') : '?';
  }
  else { icon = HEFENG_ICONS[data.icon] || '?'; }
  var temp = data.temp + '\u00B0C', text = data.text || '', city = data.city || '';

  var cityEl = document.querySelector('.weather-city');
  var detailEl = document.querySelector('.weather-detail');
  if (cityEl) cityEl.textContent = city || '未知';
  if (detailEl) detailEl.textContent = icon + ' ' + temp + '  ' + text;

  var api = WEATHER_APIS[type || 'openmeteo'];
  var lines = ['城市: ' + city, '温度: ' + temp, '体感: ' + data.feelsLike + '°C', '天气: ' + text, '湿度: ' + data.humidity + '%'];
  if (data.windDir) lines.push('风向: ' + data.windDir + ' ' + data.windScale + '级');
  lines.push('数据源: ' + (api ? api.name : type));
  if (meta) lines.push(getCacheInfo(meta, currentSettings || {}));
  var tt = (cityEl || document.querySelector('.weather-text'));
  if (tt) tt.title = lines.join('\n');
}

// ---- 初始化与定时刷新 ----
var weatherTimer = null;

async function initWeather() {
  if (!currentSettings) { currentSettings = await getSettings(); }
  if (currentSettings.showWeather) { await fetchAndDisplayWeather(currentSettings); scheduleWeatherRefresh(); }
  else { weatherStatus('', ''); }
}

function scheduleWeatherRefresh() {
  if (weatherTimer) clearInterval(weatherTimer);
  weatherTimer = setInterval(function () {
    if (currentSettings && currentSettings.showWeather) { fetchAndDisplayWeather(currentSettings); }
  }, getCacheMin(currentSettings) * 60 * 1000);
}

async function refreshWeather() {
  if (currentSettings && currentSettings.showWeather) { await fetchAndDisplayWeather(currentSettings); scheduleWeatherRefresh(); }
}

// ---- 供设置面板查询缓存状态 ----
async function getWeatherStatus() {
  var cache = await getWeatherCache();
  if (!cache.meta || !cache.meta.timestamp) { return { cached: false, info: 'no data' }; }
  var api = WEATHER_APIS[cache.meta.type || 'openmeteo'];
  return { cached: true, info: getCacheInfo(cache.meta, currentSettings || {}), type: cache.meta.type, city: cache.meta.city, timeStr: cache.meta.timeStr, apiName: api ? api.name : '未知', rateLimit: api ? api.rateLimit : '' };
}
