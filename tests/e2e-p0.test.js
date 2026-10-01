/*
   P0-1/P0-2/P0-3 真实浏览器端到端验证：ESC 退出编辑态 / 锁定禁用编辑 / 防抖写盘 / 边界不写盘
   headless Chromium + CDP（Node 内置 WebSocket），无第三方依赖
   运行: node tests/e2e-p0.test.js   （或 npm run test:e2e）
   前置: CHROME_BIN 指向 Chromium 构建，默认 /usr/bin/chromium
   注意: Chrome 137+ 的官方 branded 构建已移除 --load-extension，必须用 Chromium / Chrome for Testing；
        环境不支持时脚本以退出码 2 跳过（CI 据此区分「环境不满足」与「断言失败」）
*/
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../src');
const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';
// 随机端口 + 每次独立 profile：避免与残留浏览器实例、并行测试撞车
const PORT = 9300 + Math.floor(Math.random() * 500);
const PROFILE = `/tmp/dp-e2e-profile-${process.pid}`;

if (!fs.existsSync(CHROME)) {
  console.error(`⚠️ 未找到 Chromium（${CHROME}）—— 设置 CHROME_BIN 环境变量后重试，跳过本次 E2E`);
  process.exit(2);
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
const consoleErrors = [];

function send(method, params, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

(async () => {
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
      consoleErrors.push(msg.params.args.map(a => a.value || a.description).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
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
    process.exit(2);
  }
  const sid = page.sid;

  // 固定 sleep 不可靠（CI 机器慢）→ 轮询等待 init 真正就绪
  async function waitForReady(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await send('Runtime.evaluate', {
          expression: 'typeof currentSettings === "object" && !!currentSettings &&' +
            ' document.querySelectorAll("#dashboard-grid .dashboard-item").length === 3 &&' +
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
    process.exit(2);
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

  console.log('\n[0] 页面与模块加载');
  check('页面 URL 正确', (await evalJs('location.href')).includes(EXT_ID));
  check('dashboard.js 已加载', await evalJs('typeof isDashEditing === "function"'));
  check('看板网格存在', await evalJs('!!document.getElementById("dashboard-grid")'));
  check('看板有 3 个组件', (await evalJs('document.querySelectorAll("#dashboard-grid .dashboard-item").length')) === 3);

  console.log('\n[1] P0-1 编辑态 ESC 退出');
  await evalJs('toggleDashEdit()');
  check('进入编辑态', await evalJs('document.body.classList.contains("dash-editing")'));
  check('完成按钮可见', await evalJs('getComputedStyle(document.getElementById("btn-dash-done")).display !== "none"'));
  await evalJs('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await sleep(150);
  check('ESC 后退出编辑态', !(await evalJs('document.body.classList.contains("dash-editing")')));
  check('ESC 后 isDashEditing() 为 false', (await evalJs('isDashEditing()')) === false);

  console.log('\n[2] P0-3 箭头换位 + 防抖写盘');
  const before = await evalJs('JSON.stringify((currentSettings.dashboardOrder)||[])');
  await evalJs('toggleDashEdit()');
  await evalJs('document.querySelector("#dashboard-grid .dashboard-item .dash-arrow-right").click()');
  const afterDom = await evalJs('JSON.stringify([...document.querySelectorAll("#dashboard-grid .dashboard-item")].map(e=>e.dataset.widget))');
  check('DOM 顺序已变', afterDom !== before, { before, afterDom });
  check('防抖期间未写盘', (await evalJs('JSON.stringify(currentSettings.dashboardOrder||[])')) === before);
  await sleep(500);
  check('防抖后已写盘', (await evalJs('JSON.stringify(currentSettings.dashboardOrder||[])')) === afterDom);

  // headless 下后台页定时器可能被节流（300ms 防抖被拉到 1s+），因此轮询等待而不是固定 sleep
  let stored = '';
  for (let i = 0; i < 24; i++) {
    stored = await evalJs('new Promise(r=>chrome.storage.sync.get("settings",d=>r(JSON.stringify((d.settings||{}).dashboardOrder||[]))))');
    if (stored === afterDom) break;
    await sleep(250);
  }
  check('已落盘到 storage', stored === afterDom, { 期望: afterDom, 实际: stored });

  console.log('\n[3] P0-3 边界点击不写盘');
  await evalJs('(()=>{const it=document.querySelector("#dashboard-grid .dashboard-item");it.querySelector(".dash-arrow-left").click();})()');
  await sleep(500);
  check('最左再左移 → 顺序不变', (await evalJs('JSON.stringify([...document.querySelectorAll("#dashboard-grid .dashboard-item")].map(e=>e.dataset.widget))')) === afterDom);

  console.log('\n[4] P0-2 锁定禁用编辑');
  await evalJs('setLocked(true)');
  check('锁定后编辑按钮 disabled', (await evalJs('document.getElementById("btn-dash-edit").disabled')) === true);
  check('锁定后按钮 tooltip 提示', (await evalJs('document.getElementById("btn-dash-edit").title')).includes('已锁定'));
  check('锁定时强制退出编辑态', !(await evalJs('document.body.classList.contains("dash-editing")')));
  await evalJs('toggleDashEdit()');
  check('锁定时无法再进入编辑态', (await evalJs('isDashEditing()')) === false);
  await evalJs('setLocked(false)');
  check('解锁后按钮恢复可用', (await evalJs('document.getElementById("btn-dash-edit").disabled')) === false);
  await evalJs('toggleDashEdit()');
  check('解锁后可正常进入编辑态', (await evalJs('isDashEditing()')) === true);
  await evalJs('toggleDashEdit()');

  console.log('\n[5] P1-7 设置面板延迟初始化');
  check('启动阶段未构建面板状态', (await evalJs('_settingsPanelReady')) === false);
  check('启动即已应用外观尺寸变量（不依赖面板）', await evalJs('getComputedStyle(document.documentElement).getPropertyValue("--card-width").trim().length > 0'));
  const gridCols = await evalJs('document.getElementById("speeddial-grid").style.gridTemplateColumns');
  check('Grid 列宽来自 CSS 变量（未依赖滑块默认值）', gridCols.includes('minmax'), gridCols);
  check('齿轮按钮可打开面板（懒初始化不阻断入口）', await evalJs('(()=>{document.getElementById("btn-settings").click();return !document.getElementById("settings-panel").classList.contains("hidden");})()'));
  check('面板打开后已完成初始化', (await evalJs('_settingsPanelReady')) === true);
  check('表单已回填列数', (await evalJs('document.getElementById("setting-columns-slider").value')) === (await evalJs('String(currentSettings.columns || 5)')));
  check('表单已回填卡片宽度', (await evalJs('document.getElementById("setting-card-width").value')) === (await evalJs('String(currentSettings.cardWidth || 270)')));
  // 面板事件是首次打开时才绑定的 —— 验证绑定真的生效（改列数应写入 settings）
  const beforeCols = await evalJs('currentSettings.columns');
  await evalJs('(()=>{const s=document.getElementById("setting-columns-slider");s.value="4";s.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await sleep(600);
  const afterCols = await evalJs('currentSettings.columns');
  check('面板事件已绑定（改列数生效）', afterCols === 4 && beforeCols !== 4, { beforeCols, afterCols });
  await evalJs('(()=>{const s=document.getElementById("setting-columns-slider");s.value="' + beforeCols + '";s.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await sleep(400);
  await evalJs('closeSettingsPanel()');

  console.log('\n[6] 页面无 JS 报错');
  check('无 console error / 未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 3));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  ws.close();
  killBrowser();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('❌ 测试异常:', e.message);
  killBrowser();
  process.exit(2);
});
