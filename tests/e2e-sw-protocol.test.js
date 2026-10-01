/*
   P0-4 SW 协议白名单真实链路验证：页面 → SW 消息，非法协议必须被拒
   headless Chromium + CDP（Node 内置 WebSocket），无第三方依赖
   运行: node tests/e2e-sw-protocol.test.js
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

  console.log('\n[P0-4] 页面 → SW 消息协议白名单');
  const msg = (payload) => `new Promise(r=>chrome.runtime.sendMessage(${JSON.stringify(payload)},resp=>r(JSON.stringify(resp))))`;
  const r1 = await evalJs(msg({ type: 'image-fetch', url: 'file:///etc/passwd' }));
  check('image-fetch file:// 被拒', r1.includes('unsupported protocol'), r1);
  const r2 = await evalJs(msg({ type: 'image-fetch', url: 'chrome://settings' }));
  check('image-fetch chrome:// 被拒', r2.includes('unsupported protocol'), r2);
  const r3 = await evalJs(msg({ type: 'weather-fetch', url: 'javascript:alert(1)' }));
  check('weather-fetch javascript: 被拒', r3.includes('unsupported protocol'), r3);
  const r4 = await evalJs(msg({ type: 'image-fetch', url: 'data:text/html,<h1>x</h1>' }));
  check('image-fetch data: 被拒', r4.includes('unsupported protocol'), r4);
  const r5 = await evalJs(msg({ type: 'webdav:test', payload: { _url: 'file:///tmp/dav', _user: 'u', _pass: btoa('p') } }));
  check('WebDAV file:// 被拒', r5.includes('http/https'), r5);
  // 合法 https 不应命中协议白名单（允许进入真实 fetch，结果可能是网络失败）
  const r6 = await evalJs(msg({ type: 'image-fetch', url: 'https://example.com/' }));
  check('image-fetch https 未被协议拦截', !r6.includes('unsupported protocol'), r6.slice(0, 120));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  ws.close();
  chrome.kill('SIGKILL');
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('❌ 测试异常:', e.message);
  chrome.kill('SIGKILL');
  process.exit(2);
});
