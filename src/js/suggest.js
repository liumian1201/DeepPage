/* ============================================================
   suggest.js — 搜索框建议（浏览历史 / 书签）（v1.5.0）
   需要在设置里手动开启，并在开启时申请 history / bookmarks 可选权限。
   与 search-engines.js 的「> 本地卡片搜索」互不干扰：那个走 #local-search-dropdown，
   本模块走 #suggest-dropdown。
   ============================================================ */

var _suggestResults = [];
var _suggestIndex = -1;
var _suggestTimer = null;
var SUGGEST_MAX = 8;

function isSuggestEnabled() {
  return !!(currentSettings && currentSettings.searchSuggestions);
}

/** 建议是否需要权限（开启时必须已授权） */
function hasSuggestPermission() {
  return new Promise(function (resolve) {
    try {
      chrome.permissions.contains({ permissions: ['history', 'bookmarks'] }, function (ok) { resolve(!!ok); });
    } catch (e) { resolve(false); }
  });
}

/** 申请建议所需权限（需用户手势内调用） */
function requestSuggestPermission() {
  return new Promise(function (resolve) {
    try {
      chrome.permissions.request({ permissions: ['history', 'bookmarks'] }, function (granted) {
        if (chrome.runtime.lastError) console.warn('[建议] 权限申请失败:', chrome.runtime.lastError.message);
        resolve(!!granted);
      });
    } catch (e) { resolve(false); }
  });
}

function _suggestEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** 并发查询历史 + 书签，合并去重后取前 N 条 */
async function querySuggestions(text) {
  text = String(text || '').trim();
  if (text.length < 1) return [];
  var hist = [];
  var marks = [];

  if (chrome.history && chrome.history.search) {
    hist = await new Promise(function (resolve) {
      try {
        chrome.history.search({ text: text, maxResults: SUGGEST_MAX * 2, startTime: 0 }, function (items) {
          if (chrome.runtime.lastError) return resolve([]);
          resolve(items || []);
        });
      } catch (e) { resolve([]); }
    });
  }
  if (chrome.bookmarks && chrome.bookmarks.search) {
    marks = await new Promise(function (resolve) {
      try {
        chrome.bookmarks.search({ query: text }, function (items) {
          if (chrome.runtime.lastError) return resolve([]);
          resolve((items || []).filter(function (b) { return b.url; }));
        });
      } catch (e) { resolve([]); }
    });
  }

  var seen = {};
  var out = [];
  // 书签优先（用户主动收藏的），再补历史
  marks.concat(hist).forEach(function (it) {
    var url = it.url;
    if (!url || /^(chrome|chrome-extension|javascript|data):/i.test(url)) return;
    if (seen[url]) return;
    seen[url] = 1;
    var lower = text.toLowerCase();
    var title = it.title || url;
    var score = 0;
    if (title.toLowerCase().indexOf(lower) === 0) score += 20;
    else if (title.toLowerCase().indexOf(lower) > -1) score += 10;
    if (url.toLowerCase().indexOf(lower) > -1) score += 5;
    score += Math.min(10, Math.floor((it.visitCount || 0) / 5));
    out.push({ type: it.dateAdded !== undefined ? 'bookmark' : 'history', title: title, url: url, score: score });
  });
  out.sort(function (a, b) { return b.score - a.score; });
  return out.slice(0, SUGGEST_MAX);
}

function renderSuggestDropdown() {
  var dd = document.getElementById('suggest-dropdown');
  var list = document.getElementById('suggest-list');
  var input = document.getElementById('search-input');
  if (!dd || !list) return;

  if (!_suggestResults.length) { hideSuggestDropdown(); return; }

  list.innerHTML = _suggestResults.map(function (it, i) {
    return '<div class="local-search-item" role="option" id="sg-opt-' + i + '" aria-selected="false" data-index="' + i + '">' +
      '<span class="sg-icon">' + (it.type === 'bookmark' ? '🔖' : '🕐') + '</span>' +
      '<span class="sg-text"><span class="ls-name">' + _suggestEsc(it.title) + '</span>' +
      '<span class="sg-url">' + _suggestEsc(it.url) + '</span></span>' +
      '</div>';
  }).join('');
  dd.classList.remove('hidden');
  if (input) input.setAttribute('aria-expanded', 'true');

  list.querySelectorAll('.local-search-item').forEach(function (el) {
    el.addEventListener('click', function () {
      openSuggestion(parseInt(this.dataset.index, 10));
    });
    el.addEventListener('mouseenter', function () {
      _suggestIndex = parseInt(this.dataset.index, 10);
      _updateSuggestHighlight();
    });
  });
  _updateSuggestHighlight();
}

function _updateSuggestHighlight() {
  var list = document.getElementById('suggest-list');
  var input = document.getElementById('search-input');
  if (!list) return;
  var items = list.querySelectorAll('.local-search-item');
  items.forEach(function (el) {
    var active = parseInt(el.dataset.index, 10) === _suggestIndex;
    el.classList.toggle('active', active);
    el.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (input && _suggestIndex >= 0 && items[_suggestIndex]) {
    input.setAttribute('aria-activedescendant', 'sg-opt-' + _suggestIndex);
  }
}

function hideSuggestDropdown() {
  var dd = document.getElementById('suggest-dropdown');
  if (dd) dd.classList.add('hidden');
  var input = document.getElementById('search-input');
  if (input) {
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  _suggestResults = [];
  _suggestIndex = -1;
}

function openSuggestion(index) {
  var it = _suggestResults[index];
  if (!it || !it.url) return;
  hideSuggestDropdown();
  var mode = currentSettings ? currentSettings.cardOpenMode : 'current';
  if (mode === 'foreground') chrome.tabs.create({ url: it.url, active: true });
  else if (mode === 'background') chrome.tabs.create({ url: it.url, active: false });
  else window.location.href = it.url;
}

/** 输入变化 → 防抖查询并渲染（仅在设置开启且已授权时工作） */
function onSearchInputForSuggestions(value) {
  if (!isSuggestEnabled()) { hideSuggestDropdown(); return; }
  if (_suggestTimer) clearTimeout(_suggestTimer);
  var text = String(value || '').trim();
  if (text.length < 1 || text.charAt(0) === '>') { hideSuggestDropdown(); return; }
  _suggestTimer = setTimeout(async function () {
    try {
      if (!(await hasSuggestPermission())) { hideSuggestDropdown(); return; }
      var input = document.getElementById('search-input');
      if (!input || input.value.trim() !== text) return;   // 期间又输入了
      _suggestResults = await querySuggestions(text);
      _suggestIndex = -1;
      renderSuggestDropdown();
    } catch (e) { console.warn('[建议] 查询失败:', e.message); }
  }, 180);
}

/** 键盘导航：由 main.js 的 searchInput keydown 先于回车逻辑调用 */
function handleSuggestKeydown(e) {
  var dd = document.getElementById('suggest-dropdown');
  if (!dd || dd.classList.contains('hidden')) return false;
  if (e.key === 'ArrowDown') { e.preventDefault(); _suggestIndex = Math.min(_suggestResults.length - 1, _suggestIndex + 1); _updateSuggestHighlight(); return true; }
  if (e.key === 'ArrowUp') { e.preventDefault(); _suggestIndex = Math.max(-1, _suggestIndex - 1); _updateSuggestHighlight(); return true; }
  if (e.key === 'Enter') {
    e.preventDefault();
    openSuggestion(_suggestIndex < 0 ? 0 : _suggestIndex);
    return true;
  }
  if (e.key === 'Escape') { e.preventDefault(); hideSuggestDropdown(); return true; }
  return false;
}
