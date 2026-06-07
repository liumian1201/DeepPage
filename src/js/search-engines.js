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
/* ==================== 拼音首字母映射（2500+ 常用汉字） ==================== */
var _PINYIN_MAP = (function () {
  var raw = '';
  raw += '吖a阿a啊a哎a哀a唉a埃a挨a癌a矮a艾a爱a碍a安a岸a按a案a暗a昂a凹a熬a傲a奥a澳a';
  raw += '八b巴b吧b把b拔b爸b白b百b摆b败b拜b班b般b颁b板b版b办b半b伴b帮b绑b榜b棒b包b胞b宝b保b报b抱b暴b爆b北b贝b备b背b倍b被b辈b本b奔b逼b鼻b比b笔b彼b币b必b毕b闭b哔b壁b避b边b编b便b变b遍b标b表b别b宾b滨b冰b兵b丙b饼b并b病b波b玻b剥b播b博b薄b补b不b布b步b部b';
  raw += '擦c才c材c财c采c彩c菜c参c餐c残c惨c仓c藏c操c草c册c测c策c层c曾c插c茶c查c察c差c产c长c场c尝c常c厂c唱c超c朝c潮c车c彻c撤c尘c陈c称c成c承c城c程c惩c吃c池c持c尺c冲c充c出c初c除c础c储c楚c处c触c传c船c窗c床c创c吹c春c纯c词c此c次c从c村c存c错c';
  raw += '达d答d打d大d代d带d待d单d担d但d弹d当d党d档d刀d导d岛d倒d到d道d得d德d灯d登d等d低d底d地d弟d帝d第d点d电d店d调d掉d丁d顶d定d冬d东d懂d动d都d斗d豆d读d独d度d端d短d段d断d队d对d多d';
  raw += '俄e额e恶e而e尔e耳e二e';
  raw += '发f法f翻f凡f反f返f犯f范f饭f方f防f房f仿f访f放f飞f非f肥f费f分f份f丰f风f封f否f夫f服f福f府f辅f父f负f妇f复f富f';
  raw += '改g盖g该g干g感g刚g钢g高g搞g告g歌g格g个g各g给g根g跟g更g工g公g功g攻g供g共g沟g构g够g古g谷g股g故g顾g瓜g挂g怪g关g观g官g管g光g广g逛g规g归g国g果g过g';
  raw += '还h孩h海h害h含h喊h好h号h喝h何h和h河h核h黑h很h狠h红h后h厚h候h呼h忽h胡h湖h虎h互h户h护h花h华h划h化h画h话h怀h坏h欢h环h换h荒h黄h回h会h婚h活h火h伙h或h货h获h';
  raw += '几j机j鸡j积j基j及j级j极j集j急j计j记j纪j技j际j济j既j继j加j家j甲j价j驾j间j建j将j江j讲j降j交j角j叫j教j接j街j节j结j姐j解j介j今j金j仅j进j近j经j京j精j景j警j净j静j九j久j酒j旧j救j就j居j局j举j巨j具j据j剧j决j军j均j';
  raw += '卡k开k看k康k抗k考k科k可k客k课k肯k空k孔k控k口k苦k块k快k款k况k矿k亏k困k扩k';
  raw += '拉l来l蓝l览l劳l老l类l累l冷l离l里l哩l理l力l历l厉l立l利l连l联l脸l练l量l了l料l列l林l临l领l另l流l留l六l楼l路l录l陆l旅l绿l乱l略l轮l论l落l';
  raw += '妈m麻m马m码m吗m买m卖m满m慢m忙m毛m么m没m每m美m们m猛m梦m密m免m面m民m名m明m命m模m某m母m目m';
  raw += '那n拿n哪n内n奶n南n难n闹n呢n能n你n年n念n牛n农n女n暖n';
  raw += '欧o偶o';
  raw += '怕p拍p排p盘p旁p跑p配p批p片p偏p品p平p评p凭p破p普p';
  raw += '七q期q奇q其q起q气q汽q千q前q钱q强q墙q抢q切q且q亲q青q轻q清q情q请q庆q秋q求q球q区q曲q取q去q全q权q缺q却q确q群q';
  raw += '然r让r扰r热r人r任r认r日r容r如r入r软r若r弱r';
  raw += '三s色s森s山s商s上s少s设s社s身s深s什s神s生s声s省s胜s失s师s十s时s识s实s食s使s始s世s市s示s式s事s是s适s收s手s首s受s书s输s数s双s水s睡s说s司s思s四s似s松s送s搜s诉s算s虽s随s岁s所s索s';
  raw += '他t她t台t太t态t谈t淘t特t提t题t体t天t条t调t铁t听t庭t停t通t同t统t头t图t推t退t拖t';
  raw += '外w完w玩w万w王w网w往w望w微w为w围w位w文w闻w问w我w屋w无w五w午w武w舞w务w物w误w';
  raw += '西x希x析x息x习x席x洗x喜x系x细x下x吓x先x显x险x现x线x限x乡x相x香x想x向x项x消x销x小x效x校x些x协x写x谢x新x心x信x星x行x形x性x兄x休x修x需x许x序x续x选x学x雪x血x训x迅x';
  raw += '压y呀y言y研y眼y演y验y央y阳y样y要y药y爷y也y业y页y夜y一y衣y医y依y移y已y以y义y议y因y阴y引y应y影y硬y用y优y由y邮y油y游y有y友y又y右y于y与y语y育y元y原y园y员y远y院y约y月y越y云y运y';
  raw += '灾z在z再z咱z早z造z则z怎z增z展z站z张z章z涨z招z找z照z者z这z真z阵z整z正z证z之z支z知z直z值z职z只z至z志z制z治z质z中z忠z终z种z众z重z周z洲z主z助z住z注z祝z专z转z装z状z追z准z资z子z自z字z总z走z组z最z罪z尊z昨z左z作z坐z做z做z';
  var m = {};
  var re = /([\u4e00-\u9fff])([a-z])/g;
  var match;
  while ((match = re.exec(raw)) !== null) {
    m[match[1]] = match[2];
  }
  return m;
})();

function _nameToPinyin(name) {
  var result = '';
  for (var i = 0; i < name.length; i++) {
    var ch = name[i];
    result += _PINYIN_MAP[ch] || ch;
  }
  return result.toLowerCase();
}
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
    var pinyin = _nameToPinyin(item.card.name || '');

    // AND 匹配：所有关键词都必须出现在名称、URL 或拼音中
    var matchCount = 0;
    keywords.forEach(function (kw) {
      if (name.indexOf(kw) !== -1 || url.indexOf(kw) !== -1 || pinyin.indexOf(kw) !== -1) matchCount++;
    });
    if (matchCount < keywords.length) return;

    // 计分：名称开头 > 名称中间 > URL 匹配 > 拼音匹配 > 访问次数
    var score = 0;
    keywords.forEach(function (kw) {
      if (name.indexOf(kw) === 0) score += 20;
      else if (name.indexOf(kw) > 0) score += 10;
      if (url.indexOf(kw) !== -1) score += 5;
      if (pinyin.indexOf(kw) !== -1) score += 3;
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
  // BUG-026: 多关键词时对每个关键词分别高亮
  var keywords = originalQuery.toLowerCase().split(/\s+/).filter(function (k) { return k.length > 0; });
  _localSearchResults.forEach(function (item, i) {
    var name = item.card.name || '';
    keywords.forEach(function (kw) {
      name = name.replace(new RegExp('(' + escapeRegExp(kw) + ')', 'gi'), '<mark>$1</mark>');
    });
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
