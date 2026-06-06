/* ============================================================
   search-engines.js — 搜索引擎管理与搜索跳转
   ============================================================ */

/* ==================== 搜索跳转 ==================== */
function performSearch() {
  var query = domMain.searchInput.value.trim();
  if (!query) return;
  var engine = getActiveSearchEngine();
  var url = engine.url.replace('{q}', encodeURIComponent(query));
  if (!/^https?:\/\//i.test(url)) {
    showToast('搜索引擎 URL 无效', 'error');
    return;
  }
  window.location.href = url;
}

function getActiveSearchEngine() {
  var engines = (currentSettings && currentSettings.searchEngines) ? currentSettings.searchEngines : [];
  var activeId = (currentSettings && currentSettings.activeSearchEngine) || 'google';
  var found = null;
  engines.forEach(function (e) { if (e.id === activeId && e.enabled) found = e; });
  if (!found) engines.forEach(function (e) { if (e.enabled && !found) found = e; });
  return found || { id: 'google', name: 'Google', url: 'https://www.google.com/search?q={q}' };
}

/* ==================== 搜索引擎下拉 ==================== */
function showSearchEngineDropdown() {
  var dd = document.getElementById('search-engine-dropdown');
  if (!dd) return;
  var engines = getEnabledSearchEngines();
  var activeId = (currentSettings && currentSettings.activeSearchEngine) || 'google';
  var html = '';
  engines.forEach(function (e) {
    var cls = e.id === activeId ? 'engine-option active' : 'engine-option';
    html += '<div class="' + cls + '" data-id="' + e.id + '">' + escapeHtml(e.name) + '</div>';
  });
  dd.innerHTML = html;
  dd.querySelectorAll('.engine-option').forEach(function (opt) {
    opt.addEventListener('click', function (e) {
      e.stopPropagation();
      var id = this.dataset.id;
      currentSettings.activeSearchEngine = id;
      saveSettings(currentSettings);
      applySearchEngineIcon(id);
      dd.classList.add('hidden');
      var sel = document.getElementById('setting-search-engine');
      if (sel) sel.value = id;
    });
  });
  dd.classList.remove('hidden');
}

/* ==================== 搜索引擎管理器 ==================== */
function openSearchEngineManager() {
  var dlg = document.getElementById('dialog-search-engines');
  if (!dlg) return;
  renderSearchEngineList();
  dlg.classList.remove('hidden');
  var closeBtn = document.getElementById('search-engine-mgr-close');
  var cancelBtn = document.getElementById('search-engine-mgr-cancel');
  if (closeBtn) closeBtn.onclick = function () { dlg.classList.add('hidden'); };
  if (cancelBtn) cancelBtn.onclick = function () { dlg.classList.add('hidden'); };
  // 点击空白处不再关闭弹窗
}

function renderSearchEngineList() {
  var list = document.getElementById('search-engine-list');
  if (!list) return;
  var engines = currentSettings && currentSettings.searchEngines ? currentSettings.searchEngines : [];
  var html = '';
  engines.forEach(function (e) {
    var isBuiltin = /^(google|baidu|bing|sogou|yandex)$/.test(e.id);
    var cls = isBuiltin ? 'engine-item builtin' : 'engine-item';
    html += '<div class="' + cls + '">' +
      '<input type="checkbox" ' + (e.enabled ? 'checked' : '') + ' data-id="' + e.id + '">' +
      '<label>' + escapeHtml(e.name) + ' <span style="font-size:11px;color:var(--text-tertiary)">' + escapeHtml(e.url.substring(0, 50)) + '</span></label>' +
      '<button class="engine-delete" data-id="' + e.id + '" title="删除">✕</button>' +
      '</div>';
  });
  list.innerHTML = html;

  list.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
    cb.addEventListener('change', function () {
      var id = this.dataset.id;
      var eng = engines.find(function (x) { return x.id === id; });
      if (eng) {
        eng.enabled = this.checked;
        saveSettings(currentSettings);
        updateSearchEngineSelect();
      }
    });
  });

  list.querySelectorAll('.engine-delete').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = this.dataset.id;
      if (/^(google|baidu|bing|sogou|yandex)$/.test(id)) return;
      currentSettings.searchEngines = engines.filter(function (x) { return x.id !== id; });
      saveSettings(currentSettings);
      renderSearchEngineList();
      updateSearchEngineSelect();
    });
  });

  var addBtn = document.getElementById('btn-add-custom-engine');
  if (addBtn) {
    addBtn.onclick = function () {
      var nameEl = document.getElementById('custom-engine-name');
      var urlEl = document.getElementById('custom-engine-url');
      if (!nameEl || !urlEl || !nameEl.value.trim() || !urlEl.value.trim()) {
        showToast('请填写名称和搜索 URL', 'warning');
        return;
      }
      // BUG-020: 输入时校验 URL 格式
      var urlVal = urlEl.value.trim();
      if (!/^https:\/\/.+\{q\}/i.test(urlVal)) {
        showToast('URL 必须以 https:// 开头且包含 {q} 占位符', 'warning');
        return;
      }
      var id = 'custom_' + Date.now().toString(36);
      engines.push({ id: id, name: nameEl.value.trim(), url: urlVal, enabled: true });
      saveSettings(currentSettings);
      renderSearchEngineList();
      updateSearchEngineSelect();
      nameEl.value = '';
      urlEl.value = '';
    };
  }
}

function updateSearchEngineSelect() {
  var sel = document.getElementById('setting-search-engine');
  if (!sel) return;
  var engines = getEnabledSearchEngines();
  var activeId = (currentSettings && currentSettings.activeSearchEngine) || 'google';
  var html = '';
  engines.forEach(function (e) {
    html += '<option value="' + e.id + '"' + (e.id === activeId ? ' selected' : '') + '>' + escapeHtml(e.name) + '</option>';
  });
  sel.innerHTML = html;
  sel.value = activeId;
}

function getEnabledSearchEngines() {
  var engines = (currentSettings && currentSettings.searchEngines) ? currentSettings.searchEngines : [];
  return engines.filter(function (e) { return e.enabled; });
}

/* ==================== 本地卡片搜索（> 触发） ==================== */

var _localSearchIndex = -1;
var _localSearchResults = [];

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从所有分组打平卡片，按名称+URL 模糊匹配（大小写不敏感），智能排序截断 8 条 */
function performLocalSearch(query) {
  if (!query) { hideLocalSearchDropdown(); return; }

  // 空格拆分 → AND 多关键词匹配
  var keywords = query.toLowerCase().split(/\s+/).filter(function (k) { return k.length > 0; });

  var allCards = [];
  (groups || []).forEach(function (g) {
    (g.cards || []).forEach(function (c) {
      allCards.push({ card: c, groupName: g.name || '未命名' });
    });
  });

  // 打分排序
  var scored = [];
  allCards.forEach(function (item) {
    var name = (item.card.name || '').toLowerCase();
    var url = (item.card.url || '').toLowerCase();

    // AND 匹配：所有关键词都必须出现在名称或 URL 中
    var matchCount = 0;
    keywords.forEach(function (kw) {
      if (name.indexOf(kw) !== -1 || url.indexOf(kw) !== -1) matchCount++;
    });
    if (matchCount < keywords.length) return;

    // 计分：名称开头 > 名称中间 > URL 匹配 > 访问次数
    var score = 0;
    keywords.forEach(function (kw) {
      if (name.indexOf(kw) === 0) score += 20;
      else if (name.indexOf(kw) > 0) score += 10;
      if (url.indexOf(kw) !== -1) score += 5;
    });
    score += Math.floor((item.card.visitCount || 0) / 10);

    scored.push({ item: item, score: score });
  });

  scored.sort(function (a, b) { return b.score - a.score; });

  var total = scored.length;
  _localSearchResults = scored.slice(0, 8).map(function (s) { return s.item; });
  _localSearchIndex = -1;
  renderLocalSearchDropdown(query, total);
}

function renderLocalSearchDropdown(originalQuery, total) {
  var dd = document.getElementById('local-search-dropdown');
  var list = document.getElementById('local-search-list');
  var footer = document.getElementById('local-search-footer');
  if (!dd || !list) return;

  if (!_localSearchResults.length) {
    dd.classList.add('hidden');
    return;
  }

  var html = '';
  var escaped = escapeRegExp(originalQuery);
  var regex = new RegExp('(' + escaped + ')', 'gi');
  _localSearchResults.forEach(function (item, i) {
    var name = (item.card.name || '').replace(regex, '<mark>$1</mark>');
    html += '<div class="local-search-item" data-index="' + i + '">' +
      '<span class="ls-name">' + name + '</span>' +
      '<span class="ls-badge">📁 ' + escapeHtml(item.groupName) + '</span>' +
      '</div>';
  });
  list.innerHTML = html;

  // 底部计数 + 过多提示
  if (footer) {
    if (total > 20) {
      footer.textContent = '⚠️ 结果过多（' + total + ' 条），试试输入更多关键词缩小范围';
    } else if (total > 8) {
      footer.textContent = '找到 ' + total + ' 条匹配，显示前 8 条';
    } else {
      footer.textContent = '找到 ' + total + ' 条匹配';
    }
  }

  // 绑定鼠标事件
  list.querySelectorAll('.local-search-item').forEach(function (el) {
    el.addEventListener('click', function () {
      var idx = parseInt(this.dataset.index, 10);
      _selectLocalSearchResult(idx);
    });
    el.addEventListener('mouseenter', function () {
      _localSearchIndex = parseInt(this.dataset.index, 10);
      _updateLocalSearchHighlight();
    });
  });

  dd.classList.remove('hidden');
}

function hideLocalSearchDropdown() {
  var dd = document.getElementById('local-search-dropdown');
  if (dd) dd.classList.add('hidden');
  _localSearchResults = [];
  _localSearchIndex = -1;
}

function _selectLocalSearchResult(index) {
  if (index < 0 || index >= _localSearchResults.length) return;
  var item = _localSearchResults[index];
  if (!item || !item.card || !item.card.url) return;

  // 复用全局 cardOpenMode + 访问计数
  if (typeof incrementVisitCount === 'function') {
    // 需要先确保 card 在 speeddials 中可被找到，此处用卡片的 id 直接调
    // incrementVisitCount 仅搜当前分组，但搜索结果可能跨组 → 直接计数当前分组同名 ID
    var mode = (typeof currentSettings !== 'undefined' && currentSettings) ? currentSettings.cardOpenMode : 'current';
    incrementVisitCount(item.card.id, mode === 'foreground');
  }

  var mode = (typeof currentSettings !== 'undefined' && currentSettings) ? currentSettings.cardOpenMode : 'current';
  if (mode === 'foreground') {
    chrome.tabs.create({ url: item.card.url, active: true });
  } else if (mode === 'background') {
    chrome.tabs.create({ url: item.card.url, active: false });
  } else {
    window.location.href = item.card.url;
  }

  hideLocalSearchDropdown();
  domMain.searchInput.value = '';
}

function _updateLocalSearchHighlight() {
  var list = document.getElementById('local-search-list');
  if (!list) return;
  var items = list.querySelectorAll('.local-search-item');
  items.forEach(function (el) {
    var idx = parseInt(el.dataset.index, 10);
    el.classList.toggle('active', idx === _localSearchIndex);
  });
  if (_localSearchIndex >= 0 && items[_localSearchIndex]) {
    items[_localSearchIndex].scrollIntoView({ block: 'nearest' });
  }
}

function _navigateLocalSearch(dir) {
  if (!_localSearchResults.length) return;
  _localSearchIndex += dir;
  if (_localSearchIndex < 0) _localSearchIndex = _localSearchResults.length - 1;
  if (_localSearchIndex >= _localSearchResults.length) _localSearchIndex = 0;
  _updateLocalSearchHighlight();
}

/** 由 main.js 的 searchInput keydown 调用 */
function handleLocalSearchKeydown(e) {
  var dd = document.getElementById('local-search-dropdown');
  if (!dd || dd.classList.contains('hidden')) return false;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _navigateLocalSearch(1);
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    _navigateLocalSearch(-1);
    return true;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    // 如果有高亮项则选择，否则选第一条
    if (_localSearchIndex < 0 && _localSearchResults.length > 0) {
      _selectLocalSearchResult(0);
    } else {
      _selectLocalSearchResult(_localSearchIndex);
    }
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    hideLocalSearchDropdown();
    return true;
  }
  return false;
}
