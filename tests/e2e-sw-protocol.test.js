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
