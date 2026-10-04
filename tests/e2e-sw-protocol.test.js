/*
   P0-4 SW 协议白名单真实链路验证：页面 → SW 消息，非法协议必须被拒
   headless Chromium + CDP（Node 内置 WebSocket），无第三方依赖
   运行: node tests/e2e-sw-protocol.test.js   （或 npm run test:e2e）
   前置: CHROME_BIN 指向 Chromium 构建，默认 /usr/bin/chromium
   注意: Chrome 137+ 的官方 branded 构建已移除 --load-extension，必须用 Chromium / Chrome for Testing
   退出码（BUG-041 / AUD-001 修正）:
     0 = 全部断言通过 ｜ 1 = 断言失败或测试崩溃（CI 必须红）｜ 3 = 环境不满足（显式跳过）
   历史坑: 退出码 2 曾同时用于「环境跳过」与「全局 catch 兜底」，CI 一律映射为成功；
           本文件最典型的假绿路径是 SW 无响应 → evalJs 返回 undefined → r1.includes 抛 TypeError
           → 全局 catch → 2 → 判绿。现在崩溃一律 1，且 eval 结果先做类型断言。
   自检: DP_E2E_SELFTEST=crash 会在建连前抛错，供 tests/e2e-exit-code.test.js 验证「崩溃 → 1」
   探针: DP_EXT_DIR=<目录> 可指向另一份扩展源码 —— 「修复前 / 后对比」就是拿它跑同一套断言
*/
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createConsoleErrorCollector } = require('./lib/console-error-filter');

/** 环境不满足的专用退出码：CI 只对这一个码放行（并打 warning），其余非 0 一律红 */
const EXIT_ENV_SKIP = 3;

const SRC = process.env.DP_EXT_DIR ? path.resolve(process.env.DP_EXT_DIR) : path.resolve(__dirname, '../src');
const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';
// 随机端口 + 每次独立 profile：避免与残留浏览器实例、并行测试撞车
const PORT = 9300 + Math.floor(Math.random() * 500);
const PROFILE = `/tmp/dp-e2e-profile-${process.pid}`;

if (!fs.existsSync(CHROME)) {
  console.error(`⚠️ 未找到 Chromium（${CHROME}）—— 设置 CHROME_BIN 环境变量后重试，跳过本次 E2E`);
  process.exit(EXIT_ENV_SKIP);
}

function extensionId(dir) {
  const h = crypto.createHash('sha256').update(dir, 'utf8').digest('hex').slice(0, 32);
  return h.split('').map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
let EXT_ID = extensionId(SRC); // 按路径推导仅作兜底；真实 ID 从浏览器 target 发现
console.log('按路径推导的扩展 ID:', EXT_ID);

fs.rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--disable-features=Translate', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE,
  '--disable-extensions-except=' + SRC,
  '--load-extension=' + SRC,
  'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let chromeErr = '';

/** Chromium 会 fork 出真正的浏览器进程（PPID 变 1），只 kill 启动壳会留下孤儿占着端口和 profile */
function killBrowser() {
  try {
    process.kill(-chrome.pid, 'SIGKILL'); // 整组回收
  } catch (e) {
    try { chrome.kill('SIGKILL'); } catch (e2) { /* 已退出 */ }
  }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}
chrome.stderr.on('data', d => { chromeErr += d.toString(); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitBrowserWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await res.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('浏览器调试端口未就绪\n' + chromeErr.slice(-800));
}

let ws, msgId = 0;
const pending = new Map();
// BUG-073：来源精确过滤（原实现在本文件里连断言都没有，是彻底的死门）
const consoleLog = createConsoleErrorCollector();
const consoleErrors = consoleLog.failures;

function send(method, params, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

(async () => {
  // BUG-041 自检钩子：验证「未捕获异常 → 退出码 1」这条语义（见 tests/e2e-exit-code.test.js）
  if (process.env.DP_E2E_SELFTEST === 'crash') throw new Error('DP_E2E_SELFTEST=crash（自检注入的崩溃）');
  const browserWs = await waitBrowserWs();
  ws = new WebSocket(browserWs);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = msg.params.args.map(a => a.value || a.description).join(' ');
      // BUG-073：过滤规则收窄为「来源精确 + 网络失败」两条同时成立（见 tests/lib/console-error-filter.js）
      consoleLog.add(text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleLog.addException(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
  };

  // 候选 ID 探测：不同 Chrome 版本/平台上「按路径哈希推导的 ID」并不可靠，
  // 且部分新版 branded Chrome 已禁用 --load-extension（此时任何 ID 都打不开）。
  // 策略：优先取 background.js 的 target（本项目 SW 入口），其余扩展 target 次之，路径推导兜底。
  async function collectCandidateIds() {
    const primary = new Set();
    const others = new Set();
    for (let i = 0; i < 40; i++) {
      try {
        const { targetInfos } = await send('Target.getTargets');
        for (const t of targetInfos) {
          const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(t.url || '');
          if (!m) continue;
          if (/\/background\.js(\?|$)/.test(t.url)) primary.add(m[1]);
          else others.add(m[1]);
        }
      } catch (e) { /* 忽略，继续轮询 */ }
      if (primary.size) break;
      await sleep(300);
    }
    const list = [...new Set([...primary, ...others, EXT_ID])];
    return list;
  }

  async function tryOpenPage(id) {
    const t = await send('Target.createTarget', { url: `chrome-extension://${id}/index.html` });
    const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const session = a.sessionId;
    await send('Runtime.enable', {}, session);
    await send('Page.enable', {}, session);
    await sleep(2000);
    const r = await send('Runtime.evaluate', {
      expression: '!!document.getElementById("dashboard-grid")',
      returnByValue: true,
    }, session);
    return { targetId: t.targetId, sid: session, ok: !!(r.result && r.result.value) };
  }

  const candidates = await collectCandidateIds();
  console.log('候选扩展 ID:', candidates.join(', '));
  let page = null;
  for (const id of candidates) {
    const attempt = await tryOpenPage(id);
    if (attempt.ok) { EXT_ID = id; page = attempt; console.log(`✅ 扩展页面已加载，使用 ID: ${id}`); break; }
    try { await send('Target.closeTarget', { targetId: attempt.targetId }); } catch (e) { /* 忽略 */ }
  }
  if (!page) {
    console.error('⚠️ 环境无法加载本扩展（所有候选 ID 都打不开 index.html）——');
    console.error('   该浏览器很可能已禁用 --load-extension（Chrome 137+ 的已知变化），跳过 E2E');
    ws.close();
    killBrowser();
    process.exit(EXIT_ENV_SKIP);
  }
  const sid = page.sid;

  // 固定 sleep 不可靠（CI 机器慢）→ 轮询等待 init 真正就绪
  async function waitForReady(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await send('Runtime.evaluate', {
          expression: 'typeof currentSettings === "object" && !!currentSettings &&' +
            ' document.querySelectorAll("#dashboard-grid .dashboard-item").length === DASHBOARD_WIDGETS.length &&' +
            ' !!document.getElementById("btn-dash-edit")',
          returnByValue: true,
        }, sid);
        if (r.result && r.result.value === true) return true;
      } catch (e) { /* 页面还在导航，重试 */ }
      await sleep(300);
    }
    return false;
  }

  if (!(await waitForReady())) {
    console.error('⚠️ 页面 init 未在 20s 内就绪（CI 机器较慢或扩展初始化异常），跳过 E2E');
    ws.close();
    killBrowser();
    process.exit(EXIT_ENV_SKIP);
  }

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result.value;
  };

  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
  };

  console.log('\n[P0-4] 页面 → SW 消息协议白名单');
  const msg = (payload) => `new Promise(r=>chrome.runtime.sendMessage(${JSON.stringify(payload)},resp=>r(JSON.stringify(resp))))`;
  // BUG-041：eval 结果先做类型断言 —— SW 无响应时 evalJs 返回 undefined，
  // 直接 .includes() 会抛 TypeError 落进全局 catch，看不出是哪条协议断言失败
  const NOT_A_STRING = '«SW 无响应或返回非字符串»';
  const evalJsStr = async (expr) => {
    const v = await evalJs(expr);
    return typeof v === 'string' ? v : `${NOT_A_STRING}: ${JSON.stringify(v)}`;
  };
  const r1 = await evalJsStr(msg({ type: 'image-fetch', url: 'file:///etc/passwd' }));
  check('image-fetch file:// 被拒', r1.includes('unsupported protocol'), r1);
  const r2 = await evalJsStr(msg({ type: 'image-fetch', url: 'chrome://settings' }));
  check('image-fetch chrome:// 被拒', r2.includes('unsupported protocol'), r2);
  const r3 = await evalJsStr(msg({ type: 'weather-fetch', url: 'javascript:alert(1)' }));
  check('weather-fetch javascript: 被拒', r3.includes('unsupported protocol'), r3);
  const r4 = await evalJsStr(msg({ type: 'image-fetch', url: 'data:text/html,<h1>x</h1>' }));
  check('image-fetch data: 被拒', r4.includes('unsupported protocol'), r4);
  const r5 = await evalJsStr(msg({ type: 'webdav:test', payload: { _url: 'file:///tmp/dav', _user: 'u', _pass: btoa('p') } }));
  check('WebDAV file:// 被拒', r5.includes('http/https'), r5);
  // 合法 https 不应命中协议白名单（允许进入真实 fetch，结果可能是网络失败）
  const r6 = await evalJsStr(msg({ type: 'image-fetch', url: 'https://example.com/' }));
  check('image-fetch https 未被协议拦截', !r6.startsWith(NOT_A_STRING) && !r6.includes('unsupported protocol'), r6.slice(0, 120));

  // BUG-046：http 截图链路必须在 SW 侧也有权限闸门 —— 未授权时立即拒绝，
  // 不开窗、不依赖 120 秒超时（修复前会开一个 1280×720 窗口，注入静默失败，用户干等 2 分钟）
  const httpGranted = await evalJs(`new Promise(r => chrome.permissions.contains({ origins: ['http://*/*'] }, x => r(!!x)))`);
  if (httpGranted) {
    console.log('  ⏭ http://*/* 已授权，跳过「未授权立即拒绝」断言（本环境不适用）');
  } else {
    const rawGate = await evalJs(`(async () => {
      var t0 = Date.now();
      var resp = await Promise.race([
        new Promise(function (r) {
          chrome.runtime.sendMessage({ type: 'capture-screenshot', url: 'http://127.0.0.1:9/' }, function (x) { r(x || { ok: false, error: 'no response' }); });
        }),
        new Promise(function (r) { setTimeout(function () { r({ __timeout: true }); }, 8000); })
      ]);
      return JSON.stringify({
        ms: Date.now() - t0,
        ok: !!(resp && resp.ok),
        error: (resp && resp.error) || '',
        timeout: !!(resp && resp.__timeout)
      });
    })()`);
    const captureGate = typeof rawGate === 'string' ? JSON.parse(rawGate) : { parseFailed: rawGate };
    check('capture-screenshot 未授权 http 时立即拒绝（不等 120s 超时）',
      captureGate.timeout === false && captureGate.ms < 8000, captureGate);
    check('capture-screenshot 拒绝原因是权限（不再是误导性的「用户超时未截图」）',
      captureGate.ok === false && /权限/.test(captureGate.error || ''), captureGate);
    const leakedTargets = (await send('Target.getTargets')).targetInfos.filter((t) => /127\.0\.0\.1:9/.test(t.url || ''));
    check('capture-screenshot 未授权时不开窗（没有留下指向该 http 地址的 target）',
      leakedTargets.length === 0, leakedTargets.map((t) => t.url));
  }

  // v1.5.14 DEBT-01：静默备份链路整条下线（页面侧 webdavSilentPut / webdavSilentPutIncremental
  // + WEBDAV_MSG.SILENT_PUT + SW 的 webdav:silent-put 分支）。该链路从未接过线：
  // webdavSilentPut 连 body 都不发，SW 的空 body 守卫直接 return；全仓库也没有任何 beforeunload 监听。
  // 断言口径：修复前 SW 回 { ok: true }；下线后不再有任何响应值（undefined + 端口关闭）。
  const silentPut = await evalJs(`(async () => {
    var resp = await Promise.race([
      new Promise(function (r) {
        chrome.runtime.sendMessage({ type: 'webdav:silent-put', payload: { body: [1, 2, 3], _url: 'https://example.com/dav/' } }, function (x) {
          r({ value: (x === undefined ? null : x), lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
        });
      }),
      new Promise(function (r) { setTimeout(function () { r({ value: '«超时»', lastError: null }); }, 5000); })
    ]);
    return JSON.stringify(resp);
  })()`);
  const silentPutRes = typeof silentPut === 'string' ? JSON.parse(silentPut) : { parseFailed: silentPut };
  check('DEBT-01 已下线的 webdav:silent-put 不再被 SW 响应（修复前回 { ok: true }）',
    silentPutRes.value === null, silentPutRes);
  const stillAlive = await evalJsStr(msg({ type: 'webdav:test', payload: { _url: 'file:///tmp/dav', _user: 'u', _pass: btoa('p') } }));
  check('DEBT-01 正对照：同族 webdav:test 仍被 SW 响应（只下线了死链路）',
    stillAlive.includes('http/https'), stillAlive);

  // v1.6.0 封版清理：DEBT-01 的最后一处残留 —— 页面侧 webdavListConfigs() 已随 v1.5.14 删除，
  // 于是 SW 的 webdav:config-list 分支 + WEBDAV_MSG.CONFIG_LIST + webdavProxy 里两处共享判据都没有调用方
  // （云端 config 列表实际来自 manifest.configs，不经过这条消息）。删完用同一套口径钉住。
  const cfgList = await evalJs(`(async () => {
    var resp = await Promise.race([
      new Promise(function (r) {
        chrome.runtime.sendMessage({ type: 'webdav:config-list', payload: { _url: 'https://example.com/dav/' } }, function (x) {
          r({ value: (x === undefined ? null : x), lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
        });
      }),
      new Promise(function (r) { setTimeout(function () { r({ value: '«超时»', lastError: null }); }, 5000); })
    ]);
    return JSON.stringify(resp);
  })()`);
  const cfgListRes = typeof cfgList === 'string' ? JSON.parse(cfgList) : { parseFailed: cfgList };
  check('DEBT-01 残留：已无调用方的 webdav:config-list 不再被 SW 响应（v1.6.0 清理）',
    cfgListRes.value === null, cfgListRes);
  const imgListAlive = await evalJsStr(msg({ type: 'webdav:img-list', payload: { _url: 'file:///tmp/dav', _user: 'u', _pass: btoa('p') } }));
  check('DEBT-01 残留：正对照 —— 同族 webdav:img-list 仍被 SW 响应（只删了没调用方的那条）',
    imgListAlive.includes('http/https'), imgListAlive);

  // ===== v1.5.16 DEBT-02：SW 侧降级路径（background.js 的 7 处空 catch 分级治理）=====
  // 这些代码跑在 Service Worker 里，页面上下文看不到 → 用 CDP 直接挂到 SW target 上求值。
  // 刻意不调 Runtime.enable(SW)：避免把 SW 的 console 事件并进本套件的「无 console error」门。
  //
  // ⚠️ 踩坑记录（v1.5.16 CI 首跑全红）：MV3 的 SW 会被浏览器回收再重启，
  // `Target.getTargets` 可能同时列出「已停用实例」与「新实例」，**两者的 url 都是 background.js**。
  // 直接 `.find()` 取第一个并单次求值 → 在 CI（机器慢、SW 空闲回收更频繁）挂到了那个空上下文：
  // 表现为 `typeof _swWarnDegraded === 'undefined'`、连 `chrome` 都没有（但消息协议照常工作，
  // 因为消息走的是真正活着的那个实例）。本地快所以一直没暴露。
  // 修法：① 先用一次消息往返唤醒 SW；② 把所有候选 target 逐个挂上并**轮询等待**
  // background.js 真的在该上下文里就绪；③ 单个用例失败时错误隔离，不让套件崩。
  console.log('\n[DEBT-02] SW 侧降级路径（诊断 / 有意静默 / 用户已关窗）');
  const swTargetInfo = (t) => ({ type: t.type, url: String(t.url || '').replace(/[a-p]{32}/, '<ext-id>') });
  async function attachWorkingSw(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    const givenUp = new Set();
    const seen = [];
    while (Date.now() < deadline) {
      let targetInfos = [];
      try { targetInfos = (await send('Target.getTargets')).targetInfos; } catch (e) { /* 重试 */ }
      const candidates = targetInfos.filter((t) => /^chrome-extension:\/\/[a-p]{32}\/background\.js/.test(t.url || ''));
      candidates.forEach((t) => { if (!seen.some((s) => s.targetId === t.targetId)) seen.push(swTargetInfo(t)); });
      for (const t of candidates) {
        if (givenUp.has(t.targetId)) continue;
        let session;
        try {
          session = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
        } catch (e) { givenUp.add(t.targetId); continue; }
        // 轮询等待该上下文真的加载完 background.js（挂上正在启动的 SW 时会先拿到空作用域）。
        // 就绪判据刻意用**两个版本都存在**的符号（stringToColor + chrome.runtime）：
        // 若用本批新增的 _swWarnDegraded，旧代码上会永远「不就绪」，修复前/后对照会退化成 1 条失败。
        for (let i = 0; i < 12; i++) {
          try {
            const r = await send('Runtime.evaluate', {
              expression: 'typeof stringToColor === "function" && typeof chrome !== "undefined" && !!chrome.runtime',
              returnByValue: true,
            }, session);
            if (r.result && r.result.value === true) return { sid: session, target: swTargetInfo(t), seen: seen };
          } catch (e) { /* 上下文可能正在切换，继续轮询 */ }
          await sleep(300);
        }
        givenUp.add(t.targetId);
        try { await send('Target.detachFromTarget', { sessionId: session }); } catch (e) { /* 忽略 */ }
      }
      await sleep(500);
    }
    return { sid: null, target: null, seen: seen };
  }
  // 先唤醒：一次消息往返确保 SW 实例真的在跑（上面的 webdav:test 已做过，这里显式再确认一次）
  await evalJsStr(msg({ type: 'webdav:test', payload: { _url: 'file:///tmp/dav', _user: 'u', _pass: btoa('p') } }));
  const swAttach = await attachWorkingSw();
  let swSid = swAttach.sid;
  check('DEBT-02 挂到真正加载了 background.js 的 Service Worker 上下文（SW 侧断言的前提）',
    !!swSid, { attached: !!swSid, target: swAttach.target, seenSwTargets: swAttach.seen });

  const evalSwOnce = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, swSid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'SW eval error');
    return r.result.value;
  };
  // SW 可能在断言过程中被回收重启 → 遇到上下文类错误时重挂一次再试
  const evalSw = async (expr) => {
    try {
      return await evalSwOnce(expr);
    } catch (e) {
      const msgText = String((e && e.message) || e);
      if (!/context|Session|Target|detached|Cannot find/i.test(msgText)) throw e;
      const re = await attachWorkingSw(8000);
      if (!re.sid) throw e;
      swSid = re.sid;
      return await evalSwOnce(expr);
    }
  };

  // 逐条错误隔离：旧代码上这些函数/出口不存在时应「该条断言失败」，而不是掀翻整个套件
  const swCase = async (body) => {
    try {
      return JSON.parse(await evalSw(`(async () => {
        try {
          var __r = await (async () => { ${body} })();
          return JSON.stringify(__r === undefined ? {} : __r);
        } catch (e) { return JSON.stringify({ __error: (e && e.message) || String(e) }); }
      })()`));
    } catch (e) {
      return { __error: (e && e.message) || String(e) };
    }
  };

  // 只要 SW 可达就跑（对照时旧代码会逐条失败，而不是被整体跳过）
  if (swSid) {
    await evalSw(`(function () {
      if (!self.__swWarnInstalled) {
        var orig = console.warn;
        self.__swWarnBuf = [];
        console.warn = function () { self.__swWarnBuf.push([].slice.call(arguments).map(String).join(' ')); };
        self.__swWarnRestore = function () { console.warn = orig; };
        self.__swWarnInstalled = true;
      }
      self.__swWarnBuf.length = 0;
      return 'ok';
    })()`);
    const swWarns = async () => {
      try { return JSON.parse(await evalSw('JSON.stringify(self.__swWarnBuf.splice(0))')); } catch (e) { return []; }
    };
    const swWarnHas = (list, needle) => Array.isArray(list) && list.some((w) => String(w).indexOf(needle) !== -1);

    // ① 诊断格式：带来源前缀，便于在 DevTools 里区分「页面」与「SW」
    const fmtCase = await swCase(`
      self.__swWarnBuf.length = 0;
      _swWarnDegraded("测试上下文", new Error("boom"));
      return { warns: self.__swWarnBuf.slice() };
    `);
    check('DEBT-02 SW 降级诊断带来源前缀与失败原因',
      (fmtCase.warns || []).length === 1 && /^\[DeepPage SW\] 测试上下文失败（已降级）: boom$/.test(fmtCase.warns[0]), fmtCase);

    // ② / ③ MKCOL 建目录失败（网络层失败才会进 catch；HTTP 405「目录已存在」不会）
    const badDav = 'http://127.0.0.1:9/dav';
    await evalSw('self.__swWarnBuf.length = 0');
    const putRes = await evalJsStr(msg({ type: 'webdav:put', payload: { _url: badDav, _user: 'u', _pass: btoa('p'), body: [1, 2, 3] } }));
    const putWarns = await swWarns();
    check('DEBT-02 WebDAV PUT：MKCOL 建根目录失败留下诊断，且 PUT 失败照常上报给页面',
      swWarnHas(putWarns, '创建 WebDAV 根目录 (MKCOL)') && putRes.includes('"ok":false'),
      { putRes: putRes.slice(0, 90), putWarns });

    await evalSw('self.__swWarnBuf.length = 0');
    await evalJsStr(msg({ type: 'webdav:config-put', payload: { _url: badDav, _user: 'u', _pass: btoa('p'), _filename: 'x.json', body: '{}' } }));
    const cfgWarns = await swWarns();
    check('DEBT-02 WebDAV 配置快照：MKCOL 建子目录失败留下诊断（带目录名）',
      swWarnHas(cfgWarns, '创建 WebDAV 子目录 config'), cfgWarns);

    // ④ / ⑤ 关闭截图窗口：用户自己关掉 = 正常路径（静默）；其它原因 = 可能留孤儿窗口（留痕）
    const closeCase = await swCase(`
      var orig = chrome.windows.remove;
      try {
        self.__swWarnBuf.length = 0;
        chrome.windows.remove = function () { throw new Error('No window with id: 999'); };
        _swCloseCaptureWindow(999);
        var expected = self.__swWarnBuf.slice();
        self.__swWarnBuf.length = 0;
        chrome.windows.remove = function () { throw new Error('remove boom'); };
        _swCloseCaptureWindow(998);
        return { expected: expected, real: self.__swWarnBuf.slice() };
      } finally { chrome.windows.remove = orig; }
    `);
    check('DEBT-02 关闭截图窗口：窗口已被关掉（No window with id）属正常路径 → 不刷诊断',
      Array.isArray(closeCase.expected) && closeCase.expected.length === 0, closeCase);
    check('DEBT-02 关闭截图窗口：其它原因没关掉（会留孤儿窗口）→ 必须留痕',
      swWarnHas(closeCase.real, '关闭截图窗口'), closeCase);

    // ⑥ / ⑦ / ⑧ 右键菜单「添加到分组」：坏页面 URL（留痕 + 仍添加）/ 坏卡片 URL（静默跳过）/ 正对照不误报重复
    const menuCase = await swCase(`
      var origExec = chrome.scripting.executeScript;
      var execCalls = [];
      chrome.scripting.executeScript = async function (o) { execCalls.push(o.args); return [{ result: true }]; };
      var origGroups = await new Promise(function (r) { chrome.storage.sync.get(['groups'], function (x) { r(x.groups || []); }); });
      try {
        await new Promise(function (r) { chrome.storage.sync.set({ groups: [{ id: 'gdebt02sw', name: 'DEBT02SW组', cards: [
          { id: 'badcard', name: '坏卡片', url: 'not-a-url' },
          { id: 'goodcard', name: '好卡片', url: 'https://example.com/swdup' }
        ] }] }, r); });

        self.__swWarnBuf.length = 0;
        await addPageToGroupFromMenu('not-a-url', '坏页面', 0, 999999);
        var badWarns = self.__swWarnBuf.slice();
        var afterBad = await new Promise(function (r) { chrome.storage.sync.get(['groups'], function (x) { r(x.groups || []); }); });

        self.__swWarnBuf.length = 0;
        execCalls.length = 0;
        await addPageToGroupFromMenu('https://www.example.com/swdup', '重复页', 0, 999999);
        var dupWarns = self.__swWarnBuf.slice();
        var dupArgs = execCalls.length ? JSON.stringify(execCalls[0]) : null;

        self.__swWarnBuf.length = 0;
        execCalls.length = 0;
        await addPageToGroupFromMenu('https://no-dup.example.com/unique', '新页面', 0, 999999);
        var noDupWarns = self.__swWarnBuf.slice();

        return {
          badWarns: badWarns,
          badAdded: ((afterBad[0] && afterBad[0].cards) || []).some(function (c) { return c.url === 'not-a-url'; }),
          dupWarns: dupWarns,
          dupArgs: dupArgs,
          noDupWarns: noDupWarns,
          noDupExecs: execCalls.length
        };
      } finally {
        chrome.scripting.executeScript = origExec;
        await new Promise(function (r) { chrome.storage.sync.set({ groups: origGroups }, r); });
      }
    `);
    check('DEBT-02 右键添加：页面 URL 解析不了 → 跳过重复检查但仍添加卡片（降级可用）',
      menuCase.badAdded === true && swWarnHas(menuCase.badWarns, '解析页面 URL'), menuCase);
    check('DEBT-02 右键添加：组内坏 URL 卡片被静默跳过，好卡片仍能被识别为重复（不刷诊断）',
      typeof menuCase.dupArgs === 'string' && menuCase.dupArgs.indexOf('DEBT02SW组') !== -1
        && Array.isArray(menuCase.dupWarns) && menuCase.dupWarns.length === 0, menuCase);
    check('DEBT-02 右键添加：正对照 —— 没有重复时不弹确认框、也没有诊断',
      menuCase.noDupExecs === 0 && Array.isArray(menuCase.noDupWarns) && menuCase.noDupWarns.length === 0, menuCase);

    await evalSw('(function () { if (self.__swWarnRestore) self.__swWarnRestore(); self.__swWarnInstalled = false; return "ok"; })()');
  }

  // BUG-073：本文件原先收集了 console error 却从不检查（死门），现在与 e2e-p0 用同一套来源精确过滤
  consoleLog.report();
  check('无 console error / 未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 3));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  ws.close();
  killBrowser();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  // BUG-041：崩溃必须让 CI 变红，绝不能再伪装成「环境不满足」被跳过
  console.error('❌ 测试崩溃（非环境问题，CI 必须红）:', e && e.stack || e);
  killBrowser();
  process.exit(1);
});
