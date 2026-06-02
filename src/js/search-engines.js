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
  dlg.onclick = function (e) { if (e.target === dlg) dlg.classList.add('hidden'); };
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
      var id = 'custom_' + Date.now().toString(36);
      engines.push({ id: id, name: nameEl.value.trim(), url: urlEl.value.trim(), enabled: true });
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
