/*
   P0-1/P0-2/P0-3 真实浏览器端到端验证：ESC 退出编辑态 / 锁定禁用编辑 / 防抖写盘 / 边界不写盘
   headless Chromium + CDP（Node 内置 WebSocket），无第三方依赖
   运行: node tests/e2e-p0.test.js
   前置: 需要 /usr/bin/chromium
*/
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../src');
const PROFILE = '/tmp/dp-e2e-profile';
const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';

if (!fs.existsSync(CHROME)) {
  console.error(`⚠️ 未找到 Chromium（${CHROME}）—— 设置 CHROME_BIN 环境变量后重试，跳过本次 E2E`);
  process.exit(2);
}
const PORT = 9333;

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
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
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

  // 真实扩展 ID 从浏览器里发现：MV3 的 background service worker target URL 形如
  // chrome-extension://<id>/background.js —— 不依赖「按路径哈希推导」这一脆弱假设
  async function resolveExtensionId() {
    for (let i = 0; i < 40; i++) {
      try {
        const { targetInfos } = await send('Target.getTargets');
        for (const t of targetInfos) {
          const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(t.url || '');
          if (m) return m[1];
        }
      } catch (e) { /* 忽略，继续轮询 */ }
      await sleep(300);
    }
    return null;
  }

  const discovered = await resolveExtensionId();
  if (discovered && discovered !== EXT_ID) {
    console.log(`扩展 ID 以浏览器为准: ${discovered}（路径推导得到 ${EXT_ID}，已改用前者）`);
    EXT_ID = discovered;
  } else if (!discovered) {
    console.warn('⚠️ 未能从浏览器发现扩展 ID，回退到路径推导值');
  }

  const target = await send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/index.html` });
  const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sid = attached.sessionId;
  await send('Runtime.enable', {}, sid);
  await send('Page.enable', {}, sid);
  await sleep(2500); // 等 init 跑完

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
  check('已落盘到 storage', (await evalJs('new Promise(r=>chrome.storage.sync.get("settings",d=>r(JSON.stringify((d.settings||{}).dashboardOrder||[]))))')) === afterDom);

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

  console.log('\n[5] 页面无 JS 报错');
  check('无 console error / 未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 3));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  ws.close();
  chrome.kill('SIGKILL');
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('❌ 测试异常:', e.message);
  chrome.kill('SIGKILL');
  process.exit(2);
});
