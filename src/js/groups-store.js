/* ============================================================
   groups-store.js — 分组数据的 sync 分片存储（页面 + Service Worker 共用）

   ── 为什么需要它（BUG-089）──────────────────────────────────
   v1.6.2 及之前，全部分组卡片都存在 **单个** `chrome.storage.sync` 项 `groups` 里。
   chrome.storage.sync 的单项配额是 QUOTA_BYTES_PER_ITEM = 8192 字节，实测（Chrome 154）
   「对象型」值的**实际**上限还更低（≈7973 字节，扁平字符串对象才能到 8189），
   一旦整份数组越过这条线：
     ① 之后**每一次**写 groups 都会被拒（加卡 / 切组 / 访问计数都写整份），
        console 反复刷 `Resource::kQuotaBytesPerItem quota exceeded`；
     ② sync 里的卡片永久停在越线之前的版本（新卡只落 local），跨设备同步静默失效。
   实测用户真实数据：34 张卡 = 7949 字节，余量只剩 24 字节 → 加一张卡（+182）必炸。

   ── 现在的布局 ──────────────────────────────────────────────
   `groups_meta`  { v:1, w:<写入令牌>, g:[{ id, name, sortMode, k:[chunk 键…] }, …] }
   `gc_<安全id>_<n>`  该分组第 n 块卡片（值 = 卡片数组）

   一个分组通常只有一块（每块预算 6000 字节）；某组卡片太多时自动切块，
   所以「单项 8KB 墙」从结构上消失。`groups_rev` 语义不变（sync / local 版本号比对）。
   旧版本留下的 `groups` 键只用于**读取迁移**：读到时照常返回，下一次写入成功后删掉它。

   ── 与存储层其余部分的分工 ──────────────────────────────────
   本文件只负责「逻辑上的 groups 数组 ↔ sync 里的分片」这层编码/解码与读写，
   不做 local 兜底、不管版本号比对（那些在 storage.js 的 saveGroups/getGroups 里）。
   页面侧走 storage.js；SW 侧在 background.js 里 importScripts 本文件后直接调 GroupsStore。
   ============================================================ */

var GroupsStore = (function () {
  var META_KEY = 'groups_meta';
  var CHUNK_PREFIX = 'gc_';
  var LEGACY_KEY = 'groups';
  var REV_KEY = 'groups_rev';
  // 单块预算：实测对象型值上限 ≈7973 字节，取 6000 留足余量（Chrome 内部计量口径与
  // 表面 JSON 长度并不完全一致，实测边界会随内容浮动 —— 预算必须明显低于上限，不能贴着写）
  var ITEM_BUDGET = 6000;

  /** 上一次已知的 chunk 键集合（用于清理孤儿键）与本次写出的 meta 令牌（回声判定） */
  var _lastKeys = null;
  var _lastToken = null;

  function _utf8Length(s) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length;
    return s.length; // 极老环境兜底：近似值（仅影响预算判断）
  }

  /** 一个值在 sync 里「最坏情况」占多少字节。
   *  Chrome 的 JSON 序列化对非 ASCII 可能直接输出 UTF-8，也可能转义成 \uXXXX；
   * 两种口径取大者，保证预算判断不会低估（低估的后果就是 kQuotaBytesPerItem）。 */
  function itemBytes(value) {
    var json;
    try { json = JSON.stringify(value === undefined ? null : value); } catch (e) { return Infinity; }
    if (typeof json !== 'string') return 0;
    var bytes = _utf8Length(json);
    var extra = 0;
    for (var i = 0; i < json.length; i++) {
      var c = json.charCodeAt(i);
      if (c < 128) continue;
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < json.length) { i++; extra += 8; } // 代理对：4 → 12
      else if (c >= 0x800) extra += 3;                                            // 3 → 6
      else extra += 4;                                                            // 2 → 6
    }
    return bytes + extra;
  }

  /** 键名安全化：分组 id 来自用户数据/导入文件，不能直接拼进 storage 键 */
  function _safeBase(id, fallbackIndex) {
    var raw = String(id === undefined || id === null ? '' : id);
    var safe = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
    if (!safe) safe = 'idx' + fallbackIndex;
    return CHUNK_PREFIX + safe;
  }

  /** 逻辑 groups 数组 → sync 载荷（纯函数，供页面 / SW / 单测共用） */
  function build(groups) {
    var meta = [];
    var items = {};
    var keys = [];
    (Array.isArray(groups) ? groups : []).forEach(function (g, gi) {
      g = g || {};
      var base = _safeBase(g.id, gi);
      var cards = Array.isArray(g.cards) ? g.cards : [];
      var groupKeys = [];
      var chunk = [];

      function flush() {
        if (!chunk.length) return;
        var key = base + '_' + groupKeys.length;
        while (Object.prototype.hasOwnProperty.call(items, key)) key += 'x'; // 极端 id 撞名时避让
        items[key] = chunk;
        groupKeys.push(key);
        keys.push(key);
        chunk = [];
      }

      cards.forEach(function (card) {
        if (chunk.length && itemBytes(chunk.concat([card])) > ITEM_BUDGET) flush();
        chunk.push(card);
      });
      flush();

      meta.push({ id: g.id, name: g.name, sortMode: g.sortMode, k: groupKeys });
    });
    return { meta: meta, items: items, keys: keys };
  }

  /** sync 数据 → 逻辑 groups 数组（meta 优先；读不到则回退旧版单项 `groups`，用于迁移） */
  function decode(data) {
    data = data || {};
    var meta = data[META_KEY];
    if (meta && Array.isArray(meta.g)) {
      return meta.g.map(function (entry) {
        entry = entry || {};
        var cards = [];
        (Array.isArray(entry.k) ? entry.k : []).forEach(function (key) {
          var part = data[key];
          if (Array.isArray(part)) cards = cards.concat(part);
        });
        return {
          id: entry.id,
          name: entry.name,
          sortMode: entry.sortMode || 'manual',
          cards: cards
        };
      });
    }
    var legacy = data[LEGACY_KEY];
    if (Array.isArray(legacy) && legacy.length > 0) return legacy;
    return null;
  }

  /** 把分片结构信息视为「已知状态」（读完立刻调用，写入时据此清理孤儿键） */
  function _rememberRead(data) {
    var keys = [];
    var meta = data && data[META_KEY];
    if (meta && Array.isArray(meta.g)) {
      meta.g.forEach(function (entry) {
        (entry && Array.isArray(entry.k) ? entry.k : []).forEach(function (k) { keys.push(k); });
      });
    }
    _lastKeys = keys;
  }

  function _readAll() {
    return new Promise(function (resolve) {
      chrome.storage.sync.get(null, function (data) { resolve(data || {}); });
    });
  }

  /** 读取：返回 { groups, meta, keys, hasMeta, hasLegacy, rev }；groups 为 null 表示两边都没有 */
  function readSync() {
    return _readAll().then(function (data) {
      var groups = decode(data);
      _rememberRead(data);
      var meta = data[META_KEY];
      return {
        groups: groups,
        meta: meta || null,
        keys: _lastKeys.slice(),
        hasMeta: !!(meta && Array.isArray(meta.g)),
        hasLegacy: Array.isArray(data[LEGACY_KEY]) && data[LEGACY_KEY].length > 0,
        rev: data[REV_KEY],
        raw: data
      };
    });
  }

  /** 一次 set 写全部分片 + meta（+ extra 如 groups_rev），然后清理孤儿键与旧版单项。
   *  返回 true=写入成功；false=被拒（调用方负责 local 兜底，见 storage.js）。 */
  function writeSync(groups, extra) {
    var built = build(groups);
    var token = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    var items = {};
    built.keys.forEach(function (key) { items[key] = built.items[key]; });
    items[META_KEY] = { v: 1, w: token, g: built.meta };
    if (extra) Object.keys(extra).forEach(function (k) {
      if (k === META_KEY || built.items[k] !== undefined) return; // 不允许 extra 覆盖分片
      items[k] = extra[k];
    });
    // 回声判定：onChanged 可能先于 set 回调触发，令牌必须在 set 之前记下
    _lastToken = token;

    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.set(items, function () {
          var err = chrome.runtime.lastError;
          if (err) {
            console.warn('[storage] sync 写入失败（' + META_KEY + '）:', err.message);
            resolve(false);
            return;
          }
          _lastKeys = built.keys.slice();
          resolve(true);
        });
      } catch (e) {
        console.warn('[storage] sync 写入异常（' + META_KEY + '）:', e && e.message);
        resolve(false);
      }
    }).then(function (ok) {
      if (!ok) return false;
      return _dropStale(built.keys).then(function () { return true; });
    });
  }

  /** 清理：本次未写出的旧 chunk 键 + 旧版单项 `groups`。
   *  只在真的存在垃圾时才发 remove（少一次写操作），失败不致命（下次写入再清）。 */
  function _dropStale(newKeys) {
    var stale = [];
    if (_lastKeys) {
      _lastKeys.forEach(function (k) { if (newKeys.indexOf(k) === -1 && stale.indexOf(k) === -1) stale.push(k); });
    }
    return _readAll().then(function (data) {
      Object.keys(data).forEach(function (k) {
        // 兜底：storage 里还留着本次没写出的 chunk 键（另一标签页/上次崩溃留下的）
        if (k.indexOf(CHUNK_PREFIX) === 0 && newKeys.indexOf(k) === -1 && stale.indexOf(k) === -1) stale.push(k);
      });
      if (Array.isArray(data[LEGACY_KEY]) && data[LEGACY_KEY].length > 0) stale.push(LEGACY_KEY);
      if (!stale.length) return null;
      return new Promise(function (resolve) {
        chrome.storage.sync.remove(stale, function () {
          if (chrome.runtime.lastError) {
            console.warn('[storage] 清理旧分片失败:', chrome.runtime.lastError.message);
          }
          resolve();
        });
      });
    });
  }

  /** 清空 sync 侧分组数据（重置 / 恢复到本地兜底数据前调用） */
  function clearSync() {
    return _readAll().then(function (data) {
      var doomed = Object.keys(data).filter(function (k) {
        return k === META_KEY || k === LEGACY_KEY || k.indexOf(CHUNK_PREFIX) === 0;
      });
      _lastKeys = [];
      if (!doomed.length) return null;
      return new Promise(function (resolve) {
        chrome.storage.sync.remove(doomed, function () { resolve(); });
      });
    });
  }

  /** 本次 onChanged 携带的 meta 是否就是本页刚写出去的那份（按写入令牌判定） */
  function isSelfMetaWrite(metaValue) {
    if (!metaValue || typeof metaValue !== 'object') return false;
    return !!_lastToken && metaValue.w === _lastToken;
  }

  /** 一个 storage 变更集是否会改变分组数据（分片键 / meta / 旧版单项） */
  function affectsGroups(changes) {
    if (!changes) return false;
    if (changes[META_KEY] || changes[LEGACY_KEY]) return true;
    return Object.keys(changes).some(function (k) { return k.indexOf(CHUNK_PREFIX) === 0; });
  }

  return {
    META_KEY: META_KEY,
    CHUNK_PREFIX: CHUNK_PREFIX,
    LEGACY_KEY: LEGACY_KEY,
    REV_KEY: REV_KEY,
    ITEM_BUDGET: ITEM_BUDGET,
    itemBytes: itemBytes,
    build: build,
    decode: decode,
    readSync: readSync,
    writeSync: writeSync,
    clearSync: clearSync,
    isSelfMetaWrite: isSelfMetaWrite,
    affectsGroups: affectsGroups
  };
})();
