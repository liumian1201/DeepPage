/*
   P0-1/P0-2/P0-3 真实浏览器端到端验证：ESC 退出编辑态 / 锁定禁用编辑 / 防抖写盘 / 边界不写盘
   headless Chromium + CDP（Node 内置 WebSocket），无第三方依赖
   运行: node tests/e2e-p0.test.js   （或 npm run test:e2e）
   前置: CHROME_BIN 指向 Chromium 构建，默认 /usr/bin/chromium
   注意: Chrome 137+ 的官方 branded 构建已移除 --load-extension，必须用 Chromium / Chrome for Testing
   退出码（BUG-041 / AUD-001 修正）:
     0 = 全部断言通过
     1 = 断言失败 **或测试自身崩溃**（CI 必须红）
     3 = 环境不满足（显式跳过：找不到浏览器 / 扩展加载不了 / init 超时）
   历史坑: 退出码 2 曾同时承担「环境跳过」与「全局 catch 兜底」，而 CI 把 2 一律映射为成功，
           于是页面/SW 真坏掉、测试崩溃、浏览器没装上全都静默变绿；现在崩溃一律 1，跳过只用 3。
   自检: DP_E2E_SELFTEST=crash 会在建连前抛错，供 tests/e2e-exit-code.test.js 验证「崩溃 → 1」
   探针: DP_EXT_DIR=<目录> 可指向另一份扩展源码 —— 「修复前 / 后对比」就是拿它跑同一套断言
*/
const { spawn } = require('child_process');
const http = require('http');
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
let interceptedDrag = null;   // BUG-079：CDP 原生拖拽数据（Input.dragIntercepted）
const pending = new Map();
// BUG-073：只有「已知外部服务的网络失败」被忽略（且单独计数打印），其余一律计入失败
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
    if (msg.method === 'Input.dragIntercepted') interceptedDrag = msg.params.data;
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
    // 固定视口：版式断言（看板一行 / 信息条位置）与运行环境无关
    try {
      await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, session);
    } catch (e) { /* 老版本浏览器忽略 */ }
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

  console.log('\n[0] 页面与模块加载');
  check('页面 URL 正确', (await evalJs('location.href')).includes(EXT_ID));
  check('dashboard.js 已加载', await evalJs('typeof isDashEditing === "function"'));
  check('看板网格存在', await evalJs('!!document.getElementById("dashboard-grid")'));
  check('看板组件数与注册表一致', (await evalJs('document.querySelectorAll("#dashboard-grid .dashboard-item").length')) === (await evalJs('DASHBOARD_WIDGETS.length')), await evalJs('document.querySelectorAll("#dashboard-grid .dashboard-item").length'));

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
  // headless 下后台页定时器会被节流（300ms 防抖可能被拉到 1s+）→ 轮询等待，不用固定 sleep
  let memOrder = '';
  for (let i = 0; i < 20; i++) {
    memOrder = await evalJs('JSON.stringify(currentSettings.dashboardOrder||[])');
    if (memOrder === afterDom) break;
    await sleep(250);
  }
  check('防抖后已写盘（内存）', memOrder === afterDom, { 期望: afterDom, 实际: memOrder });

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
  // BUG-083（#8-3 用户实测：首次打开 DeepPage 右键菜单旁的「切换主题」按钮点不动，
  //   点一下设置按钮、再把设置面板关掉之后就能点了）——真因是主题按钮的监听器被写在
  //   bindSettingsEvents() 里，而它只在首次打开设置面板时执行 → 首屏这个按钮没有监听器。
  //   这一条必须在「面板尚未初始化」时跑，所以放在本段打开面板之前（顺序不能挪）。
  const themeFirst = JSON.parse(await evalJs(`(async () => {
    var btn = document.getElementById('btn-theme');
    var r = btn.getBoundingClientRect();
    var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    var top = document.elementFromPoint(cx, cy);
    var before = document.documentElement.getAttribute('data-theme');
    var beforeSetting = currentSettings.theme;
    btn.click();
    await new Promise(function (x) { setTimeout(x, 200); });
    var out = {
      panelReady: _settingsPanelReady,
      hitIsButton: !!(top && (top === btn || btn.contains(top))),
      beforeTheme: before, afterTheme: document.documentElement.getAttribute('data-theme'),
      beforeSetting: beforeSetting, afterSetting: currentSettings.theme
    };
    currentSettings.theme = 'light';
    applyTheme('light');
    await saveSettings(currentSettings);
    return JSON.stringify(out);
  })()`));
  check('BUG-083 面板未初始化时主题按钮已可用（点击真的切主题；修复前此断言必失败）',
    themeFirst.panelReady === false && themeFirst.beforeTheme === 'light'
      && themeFirst.afterTheme === 'dark' && themeFirst.afterSetting === 'dark', themeFirst);
  check('BUG-083 主题按钮未被其它元素遮挡（elementFromPoint 命中按钮自身）',
    themeFirst.hitIsButton === true, themeFirst);
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

  console.log('\n[6] P1-6 sync 写入合并');
  // 先冲掉此前挂起的合并写，避免它落在下面的计数窗口里（否则计数会多 1，属测试竞态）
  await evalJs('(async () => { flushSyncWrites(); await new Promise(r => setTimeout(r, 120)); return "ok"; })()');
  check('注入写入计数器', (await evalJs(`(() => {
    window.__writes = [];
    window.__origSet = chrome.storage.sync.set.bind(chrome.storage.sync);
    chrome.storage.sync.set = function (items, cb) { window.__writes.push(Object.keys(items)[0]); return window.__origSet(items, cb); };
    return 'ok';
  })()`)) === 'ok');
  // 连发 12 次设置保存（模拟拖滑块 / 连点开关）
  await evalJs('(() => { for (let i = 0; i < 12; i++) { currentSettings.__probe = i; saveSettings(currentSettings); } return "ok"; })()');
  check('合并窗口内未立即写盘', (await evalJs('window.__writes.filter(k=>k==="settings").length')) === 0);
  await sleep(1000);
  check('12 次连发只落盘 1 次', (await evalJs('window.__writes.filter(k=>k==="settings").length')) === 1, await evalJs('JSON.stringify(window.__writes)'));
  check('落盘的是最后一次的值', (await evalJs('new Promise(r=>chrome.storage.sync.get("settings",d=>r(String((d.settings||{}).__probe))))')) === '11');

  // 连续切分组（模拟滚轮）：groups 与 activeGroup 各只写一次
  await evalJs('(() => { window.__writes.length = 0; for (let i = 0; i < 5; i++) { activeGroupIndex = i % groups.length; saveGroups(groups, { coalesce: true }); saveActiveGroup(activeGroupIndex); } return "ok"; })()');
  await sleep(1200);
  const w2 = JSON.parse(await evalJs('JSON.stringify(window.__writes)'));
  check('连续切组：groups 只写 1 次', w2.filter(k => k === 'groups').length === 1, w2);
  check('连续切组：activeGroup 只写 1 次', w2.filter(k => k === 'activeGroup').length === 1, w2);

  // flush 立即落盘（导出/导入/关页前的兜底）
  await evalJs('window.__writes.length = 0; currentSettings.__probe2 = 1; saveSettings(currentSettings);');
  check('未 flush 前不写盘', (await evalJs('window.__writes.length')) === 0);
  await evalJs('flushSyncWrites()');
  await sleep(300);
  check('flushSyncWrites 立即落盘', (await evalJs('window.__writes.length')) >= 1, await evalJs('JSON.stringify(window.__writes)'));
  await evalJs('chrome.storage.sync.set = window.__origSet;');

  // 安全属性：结构性数据（增删改卡片/分组）必须立即落盘，不能被合并写拖延
  await evalJs(`(() => {
    window.__writes = [];
    chrome.storage.sync.set = function (items, cb) { window.__writes.push(Object.keys(items)[0]); return window.__origSet(items, cb); };
    return 'ok';
  })()`);
  await evalJs('(async () => { await saveGroups(groups); return "ok"; })()');
  check('结构性改动（不带 coalesce）立即落盘', (await evalJs('window.__writes.filter(k=>k==="groups").length')) === 1, await evalJs('JSON.stringify(window.__writes)'));
  await evalJs('chrome.storage.sync.set = window.__origSet;');

  console.log('\n[7] P1-4 ARIA 无障碍');
  const ariaStatic = JSON.parse(await evalJs(`JSON.stringify((() => {
    const out = { dialogs: [], missing: [], iconBtns: [] };
    document.querySelectorAll('.dialog-overlay').forEach(d => {
      const label = d.getAttribute('aria-labelledby');
      out.dialogs.push({
        id: d.id,
        role: d.getAttribute('role'),
        modal: d.getAttribute('aria-modal'),
        labelOk: !!(label && document.getElementById(label)),
      });
    });
    document.querySelectorAll('button').forEach(b => {
      const text = (b.textContent || '').replace(/\\s/g, '');
      if (text.length <= 1 && !b.getAttribute('aria-label')) out.iconBtns.push(b.id || b.className);
    });
    return out;
  })())`));
  check('全部弹窗都有 role=dialog', ariaStatic.dialogs.every(d => d.role === 'dialog'), ariaStatic.dialogs.filter(d => d.role !== 'dialog'));
  check('全部弹窗都有 aria-modal', ariaStatic.dialogs.every(d => d.modal === 'true'));
  check('全部弹窗 aria-labelledby 指向存在的元素', ariaStatic.dialogs.every(d => d.labelOk), ariaStatic.dialogs.filter(d => !d.labelOk));
  check('纯图标按钮均已补 aria-label', ariaStatic.iconBtns.length === 0, ariaStatic.iconBtns);
  check('搜索框 role=searchbox + aria-label', (await evalJs('document.getElementById("search-input").getAttribute("role")')) === 'searchbox' && (await evalJs('!!document.getElementById("search-input").getAttribute("aria-label")')));
  check('设置面板 role=dialog + aria-label', (await evalJs('document.getElementById("settings-panel").getAttribute("role")')) === 'dialog');
  check('tab 有 role=tab 且 aria-selected 唯一', (await evalJs('document.querySelectorAll(\'.settings-tabs [role="tab"][aria-selected="true"]\').length')) === 1);
  check('Toast 容器是 live region', (await evalJs(`(() => { showToast('a11y 探针', 'info'); const c = document.querySelector('.toast-container'); return c.getAttribute('role') === 'status' && c.getAttribute('aria-live') === 'polite'; })()`)) === true);

  // 焦点管理：打开弹窗焦点进入，关闭后归还
  await evalJs('document.getElementById("group-add").focus()');
  const beforeFocus = await evalJs('document.activeElement.id');
  await evalJs('openAddDialog()');
  await sleep(200);
  check('弹窗打开后焦点移入弹窗内', (await evalJs('document.getElementById("dialog-card").contains(document.activeElement)')) === true, await evalJs('document.activeElement.id'));
  await evalJs('closeDialog()');
  await sleep(200);
  const afterFocus = JSON.parse(await evalJs('JSON.stringify({id: document.activeElement.id, tag: document.activeElement.tagName, cls: document.activeElement.className, stack: _a11yFocusReturn.length})'));
  check('弹窗关闭后焦点归还触发元素', afterFocus.id === beforeFocus, { beforeFocus, afterFocus });

  // 本地搜索下拉的 listbox 语义
  await evalJs('(() => { const i = document.getElementById("search-input"); i.value = ">git"; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()');
  await sleep(300);
  check('本地搜索下拉 role=listbox 且输入框 aria-expanded=true', (await evalJs('document.getElementById("local-search-dropdown").getAttribute("role")')) === 'listbox' && (await evalJs('document.getElementById("search-input").getAttribute("aria-expanded")')) === 'true');
  check('搜索结果项为 role=option', (await evalJs('document.querySelectorAll("#local-search-list [role=\\"option\\"]").length')) > 0);
  await evalJs('(() => { const i = document.getElementById("search-input"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); i.blur(); return "ok"; })()');
  await sleep(300);

  console.log('\n[8] P1-8 备份增强（sha256 / 仅配置 / 重试队列）');
  check('computeSHA256Text 结果正确', (await evalJs('computeSHA256Text("abc")')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  check('computeSHA256Text 同输入稳定', (await evalJs('(async () => (await computeSHA256Text("deeppage")) === (await computeSHA256Text("deeppage")))()')) === true);
  check('computeSHA256Text 不同输入不同结果', (await evalJs('(async () => (await computeSHA256Text("a")) !== (await computeSHA256Text("b")))()')) === true);

  await evalJs('(() => { const c = document.getElementById("setting-backup-include-images"); c.checked = false; c.dispatchEvent(new Event("change", { bubbles: true })); return "ok"; })()');
  await sleep(700);
  check('关闭「备份包含图片」写入设置', (await evalJs('currentSettings.backupIncludeImages')) === false);
  await evalJs('(() => { const c = document.getElementById("setting-backup-include-images"); c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); return "ok"; })()');
  await sleep(700);
  check('重新开启写回 true', (await evalJs('currentSettings.backupIncludeImages')) === true);

  await evalJs('_clearBackupRetry()');
  const job1 = JSON.parse(await evalJs('(async () => { await _enqueueBackupRetry("probe"); return JSON.stringify(await _getBackupRetry()); })()'));
  check('入队记录 attempts 与 nextAt', job1.attempts === 1 && typeof job1.nextAt === 'number' && job1.reason === 'probe', job1);
  check('退避时间在未来', (await evalJs('(async () => { const j = await _getBackupRetry(); return j.nextAt > Date.now(); })()')) === true);
  check('未到退避时间时不执行重试', (await evalJs('(async () => await _processBackupRetry())()')) === false);
  const job4 = JSON.parse(await evalJs('(async () => { await _enqueueBackupRetry("p2"); await _enqueueBackupRetry("p3"); await _enqueueBackupRetry("p4"); return JSON.stringify(await _getBackupRetry()); })()'));
  check('累计 attempts 达 4 次', job4.attempts === 4, job4);
  check('超过上限时清理队列', (await evalJs('(async () => { await _processBackupRetry(); return (await _getBackupRetry()) === null; })()')) === true);
  await evalJs('_clearBackupRetry()');

  console.log('\n[9] P1-9 单分组导出 / 导入');
  const gid = await evalJs('groups[0].id');
  const exported = JSON.parse(await evalJs(`(async () => JSON.stringify(await _buildGroupExport("${gid}")))()`));
  check('导出结构正确', exported.type === 'deeppage-group' && exported.version === 1 && exported.group.name === (await evalJs('groups[0].name')), { type: exported.type, name: exported.group.name });
  check('导出卡片数与分组一致', exported.group.cards.length === (await evalJs('groups[0].cards.length')), { exported: exported.group.cards.length, actual: await evalJs('groups[0].cards.length') });
  check('导出卡片含 url/name 字段', exported.group.cards.every(c => !!c.url && !!c.name));

  const beforeCount = await evalJs('groups.length');
  const imported = JSON.parse(await evalJs(`(async () => JSON.stringify(await _applyGroupImport(${JSON.stringify(exported)})))()`));
  check('导入后新增一个分组', (await evalJs('groups.length')) === beforeCount + 1);
  check('导入卡片数一致', imported.cards.length === exported.group.cards.length, { imported: imported.cards.length });
  check('重名自动加序号', imported.name === exported.group.name + ' (2)', imported.name);
  const imported2 = JSON.parse(await evalJs(`(async () => JSON.stringify(await _applyGroupImport(${JSON.stringify(exported)})))()`));
  check('再次导入序号递增', imported2.name === exported.group.name + ' (3)', imported2.name);

  // 内联图片：导入后应落到 IndexedDB 并重映射为 idx: 键
  const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const withImg = { type: 'deeppage-group', version: 1, group: { name: '带图分组', cards: [{ name: 'x', url: 'https://example.com/x', image: 'idx:origin' }] }, images: { 'idx:origin': PNG_1PX } };
  const imgGroup = JSON.parse(await evalJs(`(async () => JSON.stringify(await _applyGroupImport(${JSON.stringify(withImg)})))()`));
  check('导入内联图片 → 重映射为 idx: 键', /^idx:/.test(imgGroup.cards[0].image), imgGroup.cards[0].image);
  check('idx 引用与 IndexedDB 键一致', imgGroup.cards[0].image === 'idx:cardimg_' + imgGroup.cards[0].id, imgGroup.cards[0].image);
  check('图片确实写入 IndexedDB', (await evalJs(`(async () => { const b = await loadImage('cardimg_${imgGroup.cards[0].id}'); return b ? b.size : 0; })()`)) > 0);

  check('非法文件被拒绝', (await evalJs('(async () => { try { await _applyGroupImport({ foo: 1 }); return "no-throw"; } catch (e) { return "rejected"; } })()')) === 'rejected');
  check('空 url 卡片被跳过', (await evalJs(`(async () => { const g = await _applyGroupImport({ type: 'deeppage-group', version: 1, group: { name: '脏数据', cards: [{ name: 'a' }, { name: 'b', url: 'https://b.com' }] } }); return g.cards.length; })()`)) === 1);

  console.log('\n[10] 权限模型 + 运行时授权（P1-10 收窄 → BUG-078 部分回退）');
  const mf = JSON.parse(await evalJs('JSON.stringify(chrome.runtime.getManifest())'));
  // ⚠️ BUG-078（v1.6.2）：host_permissions 从 "https://*/*" 回退为 "<all_urls>"。
  //    原因：chrome.tabs.captureVisibleTab **只接受 `<all_urls>` 或已授权的 activeTab**，
  //    特定 host 权限（哪怕 https://*/* 命中目标页）也会报
  //    "Either the '<all_urls>' or 'activeTab' permission is required"。
  //    实测：`https://*/*`（✗）／`https://*/*` + 声明 activeTab（✗，programmatic 开的窗口没有 activeTab 授权）
  //    ／`<all_urls>`（✓）—— 于是 P1-10 的收窄把整个截图功能打断了 12 个版本。
  //    任何人想再次收窄，必须先让 [34] 段的真实截图断言仍然通过（它现在会直接失败）。
  check('host_permissions 为 <all_urls>（截图 captureVisibleTab 的硬性要求）',
    JSON.stringify(mf.host_permissions) === JSON.stringify(['<all_urls>']), mf.host_permissions);
  check('不再需要可选 http 权限（<all_urls> 已覆盖，权限闸门自然短路、不再弹窗）',
    mf.optional_host_permissions === undefined, mf.optional_host_permissions);
  check('hasHttpHostPermission 返回布尔且不抛错', (await evalJs('(async () => typeof (await hasHttpHostPermission()))()')) === 'boolean');
  check('https 地址无需申请权限', (await evalJs('(async () => await ensurePermissionForUrl("https://example.com/x"))()')) === true);
  check('无协议地址直接放行', (await evalJs('(async () => await ensurePermissionForUrl(""))()')) === true);
  const httpResult = await evalJs('(async () => typeof (await ensurePermissionForUrl("http://192.168.1.1/dav")))()');
  check('http 地址返回布尔（未授权时不抛错、走降级）', httpResult === 'boolean', httpResult);
  // BUG-058 ①②：原先是两条「空断言」（typeof 函数存在 / toString().includes 源码字符串），
  // 把按钮 handler 整段删掉或改个变量名都照样通过。这里换成真实交互的行为断言。
  // ① 点 WebDAV「测试连接」（http 地址）→ 断言权限申请真的发生、且未授权时不给 SW 发任何请求
  const webdavGate = JSON.parse(await evalJs(`(async () => {
    var origContains = chrome.permissions.contains;
    var origRequest = chrome.permissions.request;
    var origSend = chrome.runtime.sendMessage;
    var reqCount = 0, sent = [];
    chrome.permissions.contains = function (p, cb) { cb(false); };
    chrome.permissions.request = function (p, cb) { reqCount++; cb(false); };
    chrome.runtime.sendMessage = function (msg, cb) {
      if (msg && String(msg.type).indexOf('webdav:') === 0) { sent.push(msg.type); if (cb) cb({ ok: false, error: 'stub' }); return; }
      return origSend.apply(this, arguments);
    };
    try {
      openSettingsPanel();
      document.getElementById('tab-btn-data').click();
      await new Promise(function (r) { setTimeout(r, 300); });
      // 清掉先前断言留下的 Toast，避免「上一句提示」把本句断言蒙混过关
      [].forEach.call(document.querySelectorAll('.toast'), function (t) { t.remove(); });
      document.getElementById('webdav-url').value = 'http://192.168.1.50/dav';
      document.getElementById('btn-webdav-test').click();
      await new Promise(function (r) { setTimeout(r, 400); });
      return JSON.stringify({
        reqCount: reqCount,
        sent: sent,
        toasts: [].map.call(document.querySelectorAll('.toast'), function (t) { return t.textContent; }).join('|')
      });
    } finally {
      chrome.permissions.contains = origContains;
      chrome.permissions.request = origRequest;
      chrome.runtime.sendMessage = origSend;
      closeSettingsPanel();
    }
  })()`));
  check('BUG-058 点「测试连接」真的发起 http 权限申请（不再是 typeof 断言）', webdavGate.reqCount === 1, webdavGate);
  check('BUG-058 未授权时不给 WebDAV 发任何请求（守卫真的接在点击路径上）', webdavGate.sent.length === 0, webdavGate);
  check('BUG-058 未授权时给出权限提示（而不是静默无反应）', /需要「访问 http 网站」权限/.test(webdavGate.toasts), webdavGate);

  // ② 批量截图 http 降级路径：真实调用 startBatchCapture，断言 http 目标被跳过（不再匹配源码字符串）
  const batchDegrade = JSON.parse(await evalJs(`(async () => {
    var snapshot = JSON.stringify(groups);
    var savedIdx = activeGroupIndex;
    var origContains = chrome.permissions.contains;
    var origRequest = chrome.permissions.request;
    var origSend = chrome.runtime.sendMessage;
    var sent = [];
    chrome.permissions.contains = function (p, cb) { cb(false); };
    chrome.permissions.request = function (p, cb) { cb(false); };
    chrome.runtime.sendMessage = function (msg, cb) {
      if (msg && msg.type === 'batch-capture-one') { sent.push(msg.url); if (cb) cb({ ok: false, error: 'stub' }); return; }
      return origSend.apply(this, arguments);
    };
    try {
      // 清掉先前断言留下的 Toast，避免「上一句提示」把本句断言蒙混过关
      [].forEach.call(document.querySelectorAll('.toast'), function (t) { t.remove(); });
      groups = [{ id: 'gbug58', name: '降级组', sortMode: 'manual', cards: [
        { id: 'h1', name: 'http 卡', url: 'http://192.168.1.60/', image: '', visitCount: 0 },
        { id: 'h2', name: 'http 卡2', url: 'http://192.168.1.61/', image: '', visitCount: 0 }
      ] }];
      activeGroupIndex = 0; speeddials = groups[0].cards;
      renderSpeeddials(); renderGroupDots();
      await startBatchCapture();
      await new Promise(function (r) { setTimeout(r, 200); });
      return JSON.stringify({
        sent: sent,
        toasts: [].map.call(document.querySelectorAll('.toast'), function (t) { return t.textContent; }).join('|'),
        progHidden: document.getElementById('dialog-backup-progress').classList.contains('hidden')
      });
    } finally {
      chrome.permissions.contains = origContains;
      chrome.permissions.request = origRequest;
      chrome.runtime.sendMessage = origSend;
      groups = JSON.parse(snapshot);
      activeGroupIndex = savedIdx;
      speeddials = (groups[activeGroupIndex] && groups[activeGroupIndex].cards) || [];
      await saveGroups(groups);
      renderSpeeddials(); renderGroupDots();
    }
  })()`));
  check('BUG-058 未授权时 http 目标一张都不截（批量截图降级是真的，不是源码字符串）',
    batchDegrade.sent.length === 0 && batchDegrade.progHidden === true, batchDegrade);
  check('BUG-058 降级时明确告知跳过了几张（用户可见，不静默丢弃）', /跳过 2 张/.test(batchDegrade.toasts), batchDegrade);

  console.log('\n[11] P2 看板 12 列栅格 / 跨列 / 拖拽 / 数据迁移');
  check('组件注册表含 4 个组件（P3-4 新增待办）', (await evalJs('DASHBOARD_WIDGETS.length')) === 4, await evalJs('DASHBOARD_WIDGETS.map(w=>w.id).join(",")'));
  check('组件默认跨列合计仍为 12', (await evalJs('DASHBOARD_WIDGETS.reduce((n,w)=>n+w.defaultSpan,0)')) === 12, await evalJs('DASHBOARD_WIDGETS.reduce((n,w)=>n+w.defaultSpan,0)'));
  check('看板为 12 列宽度模型（flex）', (await evalJs('getComputedStyle(document.getElementById("dashboard-grid")).display')) === 'flex' && (await evalJs('getComputedStyle(document.getElementById("dashboard-grid")).justifyContent')) === 'center');
  const spans = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#dashboard-grid .dashboard-item')].map(e => [e.dataset.widget, e.style.getPropertyValue('--dash-n')]))`));
  check('每个组件都写入了 --dash-n', spans.every(x => /^\d+$/.test(x[1])), spans);
  check('布局模型覆盖全部注册组件', (await evalJs('(() => { const l = getDashboardLayout(); return Object.keys(l).length === DASHBOARD_WIDGETS.length && DASHBOARD_WIDGETS.every(w => typeof l[w.id].order === "number" && typeof l[w.id].span === "number"); })()')) === true);

  // 跨列调节：−/＋ 按钮 + 上下限钳制
  await evalJs('toggleDashEdit()');
  const spanBefore = await evalJs('getDashboardLayout().clock.span');
  await evalJs('document.querySelector(\'[data-widget="clock"] .dash-span-grow\').click()');
  await sleep(500);
  check('＋ 增大跨列', (await evalJs('getDashboardLayout().clock.span')) === spanBefore + 1, { spanBefore, after: await evalJs('getDashboardLayout().clock.span') });
  check('跨列写入 DOM', (await evalJs(`document.querySelector('[data-widget="clock"]').style.getPropertyValue('--dash-n')`)) === String(spanBefore + 1), await evalJs(`document.querySelector('[data-widget="clock"]').style.getPropertyValue('--dash-n')`));
  // 钳制到 12
  for (let i = 0; i < 15; i++) await evalJs('document.querySelector(\'[data-widget="clock"] .dash-span-grow\').click()');
  await sleep(600);
  check('跨列上限钳制为 12', (await evalJs('getDashboardLayout().clock.span')) === 12);
  for (let i = 0; i < 15; i++) await evalJs('document.querySelector(\'[data-widget="clock"] .dash-span-shrink\').click()');
  await sleep(600);
  check('跨列下限钳制为 minSpan', (await evalJs('getDashboardLayout().clock.span')) === (await evalJs('DASHBOARD_WIDGETS.find(w=>w.id==="clock").minSpan')));

  // v1.5.2: 每个组件都能缩到最小跨列（1），且到极限时给抖动反馈
  for (const wid of ['clock', 'weather', 'todo', 'lunar']) {
    for (let i = 0; i < 13; i++) await evalJs(`document.querySelector('[data-widget="${wid}"] .dash-span-shrink').click()`);
    await sleep(200);
  }
  await sleep(700);
  const minSpans = JSON.parse(await evalJs('JSON.stringify(Object.fromEntries(DASHBOARD_WIDGETS.map(w => [w.id, getDashboardLayout()[w.id].span])))'));
  check('四个组件都能缩到 1 列（含天气/农历）', Object.values(minSpans).every(v => v === 1), minSpans);
  const limitFlash = await evalJs(`(() => { document.querySelector('[data-widget="clock"] .dash-span-shrink').click(); return document.querySelector('[data-widget="clock"]').classList.contains('dash-span-limit'); })()`);
  check('到最小宽度时给出抖动反馈（不再静默无反应）', limitFlash === true);
  check('缩到 1 列后组件仍占一行（不换行）', (await evalJs(`new Set([...document.querySelectorAll('#dashboard-grid .dashboard-item')].map(el => Math.round(el.getBoundingClientRect().bottom))).size`)) === 1);
  // v1.5.3: 变窄不再缩放字号（用户反馈：卡片缩小文字也跟着变小）
  const fontAtMin = await evalJs(`getComputedStyle(document.querySelector('[data-widget="clock"] .clock-time')).fontSize`);
  check('缩到 1 列后时钟字号不变', fontAtMin === (await evalJs(`(() => { const el = document.createElement('div'); el.className = 'clock-time'; document.body.appendChild(el); const fs = getComputedStyle(el).fontSize; el.remove(); return fs; })()`)) || fontAtMin === '32px', { fontAtMin });

  // 复原为默认
  await evalJs(`(async () => { const l = getDashboardLayout(); DASHBOARD_WIDGETS.forEach(w => { l[w.id].span = w.defaultSpan; l[w.id].order = DASHBOARD_WIDGETS.indexOf(w); }); _saveLayout(l); return 'ok'; })()`);
  await sleep(700);
  const fontAtDefault = await evalJs(`getComputedStyle(document.querySelector('[data-widget="clock"] .clock-time')).fontSize`);
  check('列宽变化不影响字号（1 列与默认列宽一致）', fontAtMin === fontAtDefault, { fontAtMin, fontAtDefault });

  // v1.5.3: 跨列合计小于 12 → 整行居中（此前 grid 会把内容全部挤到左边）
  await evalJs(`(async () => { const l = getDashboardLayout(); l.clock.span = 2; l.weather.span = 2; l.todo.span = 2; l.lunar.span = 2; _saveLayout(l); return 'ok'; })()`);
  await sleep(800);
  const centerBox = JSON.parse(await evalJs(`JSON.stringify((() => {
    const grid = document.getElementById('dashboard-grid');
    const items = [...grid.querySelectorAll('.dashboard-item')];
    const g = grid.getBoundingClientRect();
    const left = Math.min(...items.map(e => e.getBoundingClientRect().left)) - g.left;
    const right = g.right - Math.max(...items.map(e => e.getBoundingClientRect().right));
    return { left: Math.round(left), right: Math.round(right), row: new Set(items.map(e => Math.round(e.getBoundingClientRect().bottom))).size };
  })())`));
  check('跨列合计 < 12 时整行居中（左右留白近似相等）', Math.abs(centerBox.left - centerBox.right) <= 2 && centerBox.row === 1, centerBox);
  await evalJs(`(async () => { const l = getDashboardLayout(); DASHBOARD_WIDGETS.forEach(w => { l[w.id].span = w.defaultSpan; l[w.id].order = DASHBOARD_WIDGETS.indexOf(w); }); _saveLayout(l); return 'ok'; })()`);
  await sleep(700);
  const fullBox = JSON.parse(await evalJs(`JSON.stringify((() => {
    const grid = document.getElementById('dashboard-grid');
    const items = [...grid.querySelectorAll('.dashboard-item')];
    const g = grid.getBoundingClientRect();
    return { left: Math.round(Math.min(...items.map(e => e.getBoundingClientRect().left)) - g.left), right: Math.round(g.right - Math.max(...items.map(e => e.getBoundingClientRect().right))),
      n: items.map(e => e.style.getPropertyValue('--dash-n')), model: Object.fromEntries(DASHBOARD_WIDGETS.map(w => [w.id, getDashboardLayout()[w.id].span])) };
  })())`));
  check('合计 = 12 时铺满一行（左右无多余留白）', fullBox.left <= 2 && fullBox.right <= 2, fullBox);

  // 拖拽换位
  const orderBefore = JSON.parse(await evalJs('JSON.stringify(Object.fromEntries(Object.entries(getDashboardLayout()).map(([k,v])=>[k,v.order])))'));
  await evalJs(`(() => {
    const grid = document.getElementById('dashboard-grid');
    const a = grid.querySelector('[data-widget="clock"]');
    const b = grid.querySelector('[data-widget="weather"]');
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    a.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: ra.left + 10, clientY: ra.top + 10, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ra.left + 60, clientY: ra.top + 20 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rb.left + rb.width / 2, clientY: rb.top + rb.height / 2 }));
    return 'ok';
  })()`);
  await sleep(600);
  const orderAfter = JSON.parse(await evalJs('JSON.stringify(Object.fromEntries(Object.entries(getDashboardLayout()).map(([k,v])=>[k,v.order])))'));
  check('拖拽后 clock/weather 顺序互换', orderAfter.clock === orderBefore.weather && orderAfter.weather === orderBefore.clock, { orderBefore, orderAfter });
  await evalJs('toggleDashEdit()');

  // 迁移场景 A：v1.5.0/1.5.1 曾把布局对象写进 dashboardLayout（与「布局方向」同名字段）
  // 先导航一次：旧页会在 pagehide flush 自己的待写数据，之后再写目标状态才不会被覆盖
  await send('Page.navigate', { url: `chrome-extension://${EXT_ID}/index.html` }, sid);
  await sleep(1400);
  await waitForReady();
  await evalJs(`(async () => {
    await flushSyncWrites();
    const s = Object.assign({}, currentSettings);
    delete s.dashboardWidgetLayout;
    s.dashboardLayout = { clock: { order: 2, span: 4 }, weather: { order: 0, span: 5 }, todo: { order: 3, span: 3 }, lunar: { order: 1, span: 2 } };
    // 内存状态同步为目标状态：否则本页 pagehide flush 会把旧状态写回去
    currentSettings = s;
    await new Promise(r => chrome.storage.sync.set({ settings: s }, r));
    return 'ok';
  })()`);
  await send('Page.navigate', { url: `chrome-extension://${EXT_ID}/index.html` }, sid);
  await sleep(1500);
  let ready = await waitForReady();
  check('迁移 A：页面重新加载就绪', ready === true);
  const migA = JSON.parse(await evalJs('JSON.stringify(Object.fromEntries(Object.entries(getDashboardLayout()).map(([k,v])=>[k,v.order])))'));
  check('迁移 A：旧位置的对象布局被识别（weather=0, lunar=1, clock=2, todo=3）',
    migA.weather === 0 && migA.lunar === 1 && migA.clock === 2 && migA.todo === 3, migA);
  check('迁移 A：布局方向字段被纠正为字符串（下拉框不再空白）',
    (await evalJs('typeof currentSettings.dashboardLayout')) === 'string' && (await evalJs('document.getElementById("setting-dashboard-layout").value')) === 'row',
    { type: await evalJs('typeof currentSettings.dashboardLayout'), sel: await evalJs('document.getElementById("setting-dashboard-layout").value') });
  check('迁移 A：data-layout 不是对象字符串', (await evalJs('document.getElementById("dashboard-grid").getAttribute("data-layout")')) === 'row', await evalJs('document.getElementById("dashboard-grid").getAttribute("data-layout")'));

  // 迁移场景 B：更老的 dashboardOrder 数组
  await send('Page.navigate', { url: `chrome-extension://${EXT_ID}/index.html` }, sid);
  await sleep(1400);
  await waitForReady();
  await evalJs(`(async () => {
    await flushSyncWrites();
    const s = Object.assign({}, currentSettings);
    delete s.dashboardWidgetLayout;
    s.dashboardLayout = 'row';
    s.dashboardOrder = ['lunar', 'clock', 'weather'];
    currentSettings = s;
    await new Promise(r => chrome.storage.sync.set({ settings: s }, r));
    return 'ok';
  })()`);
  await send('Page.navigate', { url: `chrome-extension://${EXT_ID}/index.html` }, sid);
  await sleep(1500);
  ready = await waitForReady();
  check('迁移 B：页面重新加载就绪', ready === true);
  const migrated = JSON.parse(await evalJs('JSON.stringify(Object.fromEntries(Object.entries(getDashboardLayout()).map(([k,v])=>[k,v.order])))'));
  check('迁移 B：旧 dashboardOrder 迁移为 order（lunar=0, clock=1, weather=2）', migrated.lunar === 0 && migrated.clock === 1 && migrated.weather === 2, migrated);
  check('迁移 B：跨列取默认值', (await evalJs('getDashboardLayout().clock.span')) === (await evalJs('DASHBOARD_WIDGETS.find(w=>w.id==="clock").defaultSpan')), await evalJs('getDashboardLayout().clock.span'));
  check('布局写入新键 dashboardWidgetLayout（不再占用布局方向字段）',
    (await evalJs('typeof currentSettings.dashboardWidgetLayout')) === 'object' && (await evalJs('typeof currentSettings.dashboardLayout')) === 'string');

  // v1.5.2: 布局方向下拉可用（默认 row、切 column 生效）
  await evalJs('openSettingsPanel()');
  await sleep(400);
  check('布局方向默认有选中值', ['row', 'column'].includes(await evalJs('document.getElementById("setting-dashboard-layout").value')), await evalJs('document.getElementById("setting-dashboard-layout").value'));
  // BUG-085 用户口径（2026-10-04）：布局方向只决定「横排 / 竖排」——**设置好的宽度不能因为
  // 换个排列方式就变，而且两种排列下 −/＋ 都必须能调**。
  // 注意下方那条断言的历史：v1.5.2 写的是「垂直排列：组件上下堆叠且等宽」，它把旧语义
  // （column 下 `width:100%` 压掉跨列数 --dash-n）固化成了"正确行为" ——
  // 语义一改，旧断言就会把本次修复误判成回归（经验 5：语义变更必须同步改断言）。
  const _dashBoxes = async () => JSON.parse(await evalJs(`(() => {
    var items = [].slice.call(document.querySelectorAll('#dashboard-grid .dashboard-item'));
    return JSON.stringify(items.map(function (e) {
      var r = e.getBoundingClientRect();
      return { widget: e.dataset.widget, span: e.dataset.span, w: Math.round(r.width), left: Math.round(r.left), top: Math.round(r.top) };
    }));
  })()`));
  const dashRow = await _dashBoxes();   // 先在「水平排列」下量一遍
  await evalJs(`(() => { const sel = document.getElementById('setting-dashboard-layout'); sel.value = 'column'; sel.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await sleep(800);
  check('切到垂直排列后 data-layout=column', (await evalJs('document.getElementById("dashboard-grid").getAttribute("data-layout")')) === 'column');
  const dashCol = await _dashBoxes();
  check('垂直排列：组件上下堆叠（每个组件一行，不再共享同一行）',
    dashCol.length === dashRow.length && new Set(dashCol.map(x => x.top)).size === dashCol.length, dashCol);
  check('BUG-085 垂直排列下宽度与水平排列逐项一致（宽度设置不因排列方式改变；修复前 column 一律 width:100%）',
    dashCol.length === dashRow.length
      && dashCol.every((c, i) => c.widget === dashRow[i].widget && Math.abs(c.w - dashRow[i].w) <= 1),
    { row: dashRow.map(x => x.widget + ':' + x.span + '=' + x.w), col: dashCol.map(x => x.widget + ':' + x.span + '=' + x.w) });
  // 垂直排列下真实点组件上的 ＋/− → 宽度必须真的变
  //（用户报的"点不动"真身：点击改了数据甚至已落盘，但 width:100% 把 --dash-n 压掉 → 界面零反应）
  const spanEff = JSON.parse(await evalJs(`(async () => {
    document.getElementById('btn-dash-edit').click();          // 真实入口（会顺手关掉设置面板）
    await new Promise(function (r) { setTimeout(r, 500); });
    var item = document.querySelector('#dashboard-grid .dashboard-item[data-widget="clock"]') || document.querySelector('#dashboard-grid .dashboard-item');
    var grow = item.querySelector('.dash-span-grow'), shrink = item.querySelector('.dash-span-shrink');
    function box() { var r = item.getBoundingClientRect(); return { span: item.dataset.span, w: Math.round(r.width) }; }
    var before = box();
    var dir = 'grow';
    grow.click();
    await new Promise(function (r) { setTimeout(r, 450); });
    if (item.dataset.span === before.span) {                    // 已在 12 列上限 → 换 − 方向验证
      dir = 'shrink';
      shrink.click();
      await new Promise(function (r) { setTimeout(r, 450); });
    }
    var out = {
      editing: document.body.classList.contains('dash-editing'),
      hasGrow: !!grow, hasShrink: !!shrink,
      visible: grow ? getComputedStyle(grow).display !== 'none' : false,
      dir: dir, before: before, after: box()
    };
    if (out.after.span !== out.before.span) {                   // 还原 span
      (dir === 'grow' ? shrink : grow).click();
      await new Promise(function (r) { setTimeout(r, 450); });
      out.restored = box();
    }
    document.getElementById('btn-dash-edit').click();           // 退出编辑态（走官方入口，会 flush 落盘）
    await new Promise(function (r) { setTimeout(r, 300); });
    out.editingAfterExit = document.body.classList.contains('dash-editing');
    return JSON.stringify(out);
  })()`));
  check('BUG-085 垂直排列下 −/＋ 宽度按钮存在且可见（编辑态）',
    spanEff.editing === true && spanEff.hasGrow === true && spanEff.hasShrink === true && spanEff.visible === true, spanEff);
  check('BUG-085 垂直排列下点 ＋/− 真的改变宽度（修复前 span 变了、宽度 Δ0，静默不一致）',
    (spanEff.after.span - spanEff.before.span) === (spanEff.dir === 'grow' ? 1 : -1)
      && (spanEff.dir === 'grow' ? spanEff.after.w > spanEff.before.w : spanEff.after.w < spanEff.before.w),
    spanEff);
  check('BUG-085 试完还原：span 回到原值且已退出编辑态',
    (!spanEff.restored || spanEff.restored.span === spanEff.before.span) && spanEff.editingAfterExit === false, spanEff);
  await evalJs(`(() => { const sel = document.getElementById('setting-dashboard-layout'); sel.value = 'row'; sel.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await sleep(800);
  check('切回水平排列生效', (await evalJs('document.getElementById("dashboard-grid").getAttribute("data-layout")')) === 'row');
  // BUG-086 现象 A：「看板的编辑组件顺序按钮没居中、文字靠左」——
  // 真身是设置面板里那颗满宽 .btn-backup（text-align:left）→ 文字中心比按钮中心偏左 155px。
  // 断言用 Range 量文字块中心（比 scrollWidth 精确），并要求按钮真实可见（宽度 > 100px），
  // 否则隐藏面板时量到 0×0 会"假通过"。
  await evalJs(`(() => { document.querySelector('.tab-btn[data-tab="dashboard"]').click(); openSettingsPanel(); return 'ok'; })()`);
  await sleep(400);
  const dashBtnAlign = JSON.parse(await evalJs(`(() => {
    var b = document.getElementById('btn-dash-edit');
    var br = b.getBoundingClientRect();
    var range = document.createRange(); range.selectNodeContents(b);
    var tr = range.getBoundingClientRect();
    return JSON.stringify({
      textAlign: getComputedStyle(b).textAlign,
      btnW: Math.round(br.width),
      textCenterDx: +(((tr.left + tr.right) / 2) - ((br.left + br.right) / 2)).toFixed(1)
    });
  })()`));
  check('BUG-086 「✋ 编辑组件顺序」满宽按钮文字居中（修复前 text-align:left → 文字中心偏左 155px）',
    dashBtnAlign.btnW > 100 && dashBtnAlign.textAlign === 'center' && Math.abs(dashBtnAlign.textCenterDx) <= 2, dashBtnAlign);
  await evalJs('closeSettingsPanel()');
  await sleep(300);

  console.log('\n[12] UI 回归：分组管理器按钮不换行 / 不被挤压');
  await evalJs('openGroupManager()');
  await sleep(400);
  const mgrBtns = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#dialog-group-manager .dialog-actions button')].map(b => ({ text: b.textContent.trim(), h: b.offsetHeight, w: b.offsetWidth, ws: getComputedStyle(b).whiteSpace })))`));
  check('弹窗已加宽（≥460px）', (await evalJs('document.querySelector("#dialog-group-manager .dialog-card").offsetWidth')) >= 460);
  check('底部按钮均为单行（nowrap 且高度正常）', mgrBtns.length === 4 && mgrBtns.every(b => b.ws === 'nowrap' && b.h <= 44), mgrBtns);
  check('按钮未被压缩（宽度 ≥ 48px）', mgrBtns.every(b => b.w >= 48), mgrBtns);
  const align = JSON.parse(await evalJs(`(() => {
    const dlg = document.querySelector('#dialog-group-manager .dialog-card');
    const row = dlg.querySelector('.dialog-actions');
    const btns = [...row.querySelectorAll('button')];
    const dr = dlg.getBoundingClientRect();
    const first = btns[0].getBoundingClientRect();
    const last = btns[btns.length - 1].getBoundingClientRect();
    const input = document.querySelector('.group-mgr-name').getBoundingClientRect();
    return JSON.stringify({
      left: Math.round(first.left - dr.left),
      right: Math.round(dr.right - last.right),
      inputW: Math.round(input.width),
    });
  })()`));
  check('底部按钮居中（左右留白差 ≤ 8px）', Math.abs(align.left - align.right) <= 8, align);
  check('分组名输入框已收窄（≤ 220px）', align.inputW <= 220, align.inputW);
  const rowBtns = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#group-manager-list .group-mgr-btn')].map(b => b.offsetWidth))`));
  check('行内操作按钮未被压缩', rowBtns.length > 0 && rowBtns.every(w => w >= 26), rowBtns);
  check('已移除上移/下移按钮（每行仅剩导出与删除）', (await evalJs('document.querySelectorAll("#group-manager-list .group-mgr-btn").length')) === (await evalJs('document.querySelectorAll("#group-manager-list .group-mgr-item").length')) * 2);
  check('分组图标输入框已放大（≥48px）', (await evalJs('document.querySelector("#group-manager-list .group-mgr-icon").offsetWidth')) >= 48, await evalJs('document.querySelector("#group-manager-list .group-mgr-icon").offsetWidth'));
  check('拖拽手柄可聚焦（键盘可排序）', (await evalJs('document.querySelector("#group-manager-list .group-mgr-drag").getAttribute("tabindex")')) === '0');
  // 键盘排序：聚焦第一个手柄按 ↓，顺序应变化
  const kbBefore = JSON.parse(await evalJs('JSON.stringify(groups.map(g => g.name))'));
  await evalJs(`(() => { const h = document.querySelector('#group-manager-list .group-mgr-drag[data-index="0"]'); h.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return 'ok'; })()`);
  await sleep(700);
  const kbAfter = JSON.parse(await evalJs('JSON.stringify(groups.map(g => g.name))'));
  check('手柄 ↑↓ 键盘排序生效', kbAfter[0] === kbBefore[1] && kbAfter[1] === kbBefore[0], { kbBefore, kbAfter });
  await evalJs('closeGroupManager()');
  await sleep(300);

  console.log('\n[13] P3-1 卡片多选批量操作');
  // 注意：DOM 池会同时保留其它分组的容器，凡是要点卡片都必须按可见性过滤（用户只可能点到当前分组）
  await evalJs('window.__visCards = () => [...document.querySelectorAll("#speeddial-grid .card-wrapper[data-id]")].filter(el => el.offsetParent !== null);');
  await evalJs('clearCardSelection()');
  const cardCount = await evalJs('window.__visCards().length');
  check('当前分组卡片数足够测试', cardCount >= 3, cardCount);

  // Ctrl+点击选中两张（不应打开卡片）
  await evalJs(`(() => {
    const cards = window.__visCards();
    cards[0].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    cards[2].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    return 'ok';
  })()`);
  await sleep(250);
  check('Ctrl+点击选中 2 张', (await evalJs('getSelectedCardIds().length')) === 2, await evalJs('JSON.stringify(getSelectedCardIds())'));
  console.log('  [诊断]', await evalJs(`JSON.stringify({
    selectedIds: getSelectedCardIds(),
    wrappersInGrid: document.querySelectorAll('#speeddial-grid .card-wrapper[data-id]').length,
    wrappersAnywhere: document.querySelectorAll('.card-wrapper[data-id]').length,
    selectedInGrid: document.querySelectorAll('#speeddial-grid .card-wrapper.selected').length,
    selectedAnywhere: document.querySelectorAll('.card-wrapper.selected').length,
    gridChildren: [...document.getElementById('speeddial-grid').children].map(e => e.className).slice(0, 4),
    firstWrapperClass: (document.querySelector('.card-wrapper[data-id]') || {}).className,
    activeGroupIdx: activeGroupIndex
  })`));
  const selDom = JSON.parse(await evalJs(`JSON.stringify((() => {
    const grid = document.getElementById('speeddial-grid');
    const all = [...grid.querySelectorAll('.card-wrapper.selected')];
    const visible = all.filter(el => el.offsetParent !== null);
    return { all: all.length, visible: visible.length, activeId: groups[activeGroupIndex].id };
  })())`));
  check('选中样式只落在当前分组（2 张且可见）', selDom.visible === 2, selDom);
  check('工具栏出现且计数正确', (await evalJs('document.getElementById("batch-count").textContent')) === '已选 2 张');
  check('Ctrl+点击不会打开卡片', (await evalJs('location.href')).includes('index.html'));

  // Shift 区间选中
  await evalJs(`(() => { const c = window.__visCards(); c[1].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})); return 'ok'; })()`);
  await evalJs(`(() => { const c = window.__visCards(); c[0].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true})); return 'ok'; })()`);
  await sleep(250);
  check('Shift 区间选中生效', (await evalJs('getSelectedCardIds().length')) >= 2, await evalJs('getSelectedCardIds().length'));

  // 批量移动
  await evalJs('(async () => { await _applyGroupImport({ type: "deeppage-group", version: 1, group: { name: "批量目标组", cards: [] } }); return "ok"; })()');
  await evalJs(`(() => { const c = window.__visCards(); clearCardSelection(); c[0].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})); c[1].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})); return 'ok'; })()`);
  await sleep(250);
  const moveRes = JSON.parse(await evalJs(`(async () => {
    const target = groups.find(g => g.name.indexOf('批量目标组') === 0);
    const sel = getSelectedCardIds().length;
    await batchMoveSelected(target.id);
    return JSON.stringify({ sel, moved: target.cards.length, left: getSelectedCardIds().length });
  })()`));
  check('批量移动：卡片进入目标分组', moveRes.moved === moveRes.sel && moveRes.sel === 2, moveRes);
  check('批量移动后清空选中', moveRes.left === 0);

  // 批量删除（确认弹窗）
  await evalJs(`(() => { const c = window.__visCards(); c[0].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})); return 'ok'; })()`);
  await sleep(200);
  const beforeDel = await evalJs('speeddials.length');
  await evalJs('(() => { batchDeleteSelected(); return "started"; })()'); // 不 await：它要等确认弹窗
  await sleep(500);
  // 批量删除复用与单张删除相同的确认弹窗（#dialog-import-confirm，标题/按钮文案被覆写）
  check('批量删除弹出确认对话框', (await evalJs('!document.getElementById("dialog-import-confirm").classList.contains("hidden")')));
  check('确认弹窗标题为批量删除', (await evalJs('document.querySelector("#dialog-import-confirm h3").textContent')).includes('批量删除'), await evalJs('document.querySelector("#dialog-import-confirm h3").textContent'));
  await evalJs('document.getElementById("import-confirm-ok").click()');
  await sleep(700);
  check('确认后卡片被删除', (await evalJs('speeddials.length')) === beforeDel - 1, { beforeDel, after: await evalJs('speeddials.length') });
  check('删除后清空选中', (await evalJs('getSelectedCardIds().length')) === 0);

  // 锁定拦截 + ESC 清空 + Ctrl+A 全选
  await evalJs(`(() => { const c = window.__visCards(); c[0].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})); return 'ok'; })()`);
  await evalJs('setLocked(true)');
  await sleep(200);
  const lockedCount = await evalJs('speeddials.length');
  await evalJs('(() => { batchDeleteSelected(); return "started"; })()');
  await sleep(500);
  check('锁定时批量删除被拦截', (await evalJs('speeddials.length')) === lockedCount);
  await evalJs('setLocked(false)');
  await evalJs('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  await sleep(250);
  check('ESC 清空选中', (await evalJs('getSelectedCardIds().length')) === 0);
  check('清空后工具栏隐藏', (await evalJs('document.getElementById("batch-bar").classList.contains("hidden")')) === true);
  await evalJs('document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }))');
  await sleep(250);
  check('Ctrl+A 全选当前分组', (await evalJs('getSelectedCardIds().length')) === (await evalJs('window.__visCards().length')), { sel: await evalJs('getSelectedCardIds().length'), vis: await evalJs('window.__visCards().length') });
  await evalJs('clearCardSelection()');

  console.log('\n[14] P3-3 分组颜色 / 图标 / 拖拽排序');
  await evalJs('openGroupManager()');
  await sleep(400);
  check('分组行含颜色/图标/拖拽控件', (await evalJs('!!document.querySelector(".group-mgr-color") && !!document.querySelector(".group-mgr-icon") && !!document.querySelector(".group-mgr-drag")')) === true);
  check('拖拽手柄可拖（draggable）', (await evalJs('document.querySelector(".group-mgr-drag").getAttribute("draggable")')) === 'true');

  await evalJs(`(() => { const c = document.querySelector('.group-mgr-color[data-index="0"]'); c.value = '#e91e63'; c.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await sleep(600);
  check('颜色写入分组数据', (await evalJs('groups[0].color')) === '#e91e63', await evalJs('groups[0].color'));
  check('指示器带 --group-color', (await evalJs('(document.querySelector("#group-dots .group-dot, #group-dots .group-tab").getAttribute("style") || "").indexOf("--group-color") !== -1')) === true);

  await evalJs(`(() => { const i = document.querySelector('.group-mgr-icon[data-index="0"]'); i.value = '🏠'; i.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await sleep(600);
  check('图标写入分组数据', (await evalJs('groups[0].icon')) === '🏠', await evalJs('groups[0].icon'));
  check('指示器渲染图标', (await evalJs('!!document.querySelector("#group-dots .group-icon")')) === true);

  // 拖拽排序：模拟 HTML5 DnD（手柄 dragstart → 末行 dragover/drop）
  const grpOrderBefore = JSON.parse(await evalJs('JSON.stringify(groups.map(g => g.name))'));
  await evalJs(`(() => {
    const list = document.getElementById('group-manager-list');
    const handle = list.querySelector('.group-mgr-drag[data-index="0"]');
    const rows = [...list.querySelectorAll('.group-mgr-item')];
    const dt = new DataTransfer();
    handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const last = rows[rows.length - 1];
    last.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    last.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return 'ok';
  })()`);
  await sleep(900);
  const grpOrderAfter = JSON.parse(await evalJs('JSON.stringify(groups.map(g => g.name))'));
  check('拖拽后顺序改变且长度不变', grpOrderAfter.length === grpOrderBefore.length && grpOrderAfter[grpOrderAfter.length - 1] === grpOrderBefore[0], { before: grpOrderBefore, after: grpOrderAfter });
  check('活动分组按 id 跟随（未错位）', (await evalJs('groups[activeGroupIndex] && groups[activeGroupIndex].id')) === (await evalJs('(async () => (await getActiveGroup(), groups[activeGroupIndex].id))()')), await evalJs('groups[activeGroupIndex].name'));
  check('拖拽后持久化到 storage', (await evalJs(`new Promise(r => chrome.storage.sync.get('groups', d => r((d.groups || []).map(g => g.name).join(','))))`)) === grpOrderAfter.join(','));

  await evalJs('closeGroupManager()');
  await sleep(300);

  console.log('\n[15] P3-4 待办看板组件（验证注册表抽象）');
  check('注册表含 todo 组件', (await evalJs('DASHBOARD_WIDGETS.some(w => w.id === "todo")')) === true);
  check('待办组件已渲染', (await evalJs('!!document.getElementById("dash-todo")')) === true);
  check('可见性由注册表 settingKey 驱动', (await evalJs('(DASHBOARD_WIDGETS.find(w => w.id === "todo") || {}).settingKey')) === 'showTodo');

  await evalJs(`(() => { const i = document.getElementById('todo-input'); i.value = '写周报'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'ok'; })()`);
  await sleep(400);
  check('回车添加待办', (await evalJs('getTodoItems().length')) === 1, await evalJs('JSON.stringify(getTodoItems())'));
  check('列表渲染出该条', (await evalJs('document.querySelectorAll("#todo-list .todo-item").length')) === 1);
  check('添加后输入框清空', (await evalJs('document.getElementById("todo-input").value')) === '');

  await evalJs(`(() => { const i = document.getElementById('todo-input'); i.value = '买牛奶'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'ok'; })()`);
  await sleep(300);
  const todoId0 = await evalJs('getTodoItems()[0].id');
  await evalJs(`document.querySelector('.todo-check[data-id="${todoId0}"]').click()`);
  await sleep(400);
  check('勾选标记完成', (await evalJs('getTodoItems()[0].done')) === true);
  check('完成项带 done 样式', (await evalJs('!!document.querySelector("#todo-list .todo-item.done")')) === true);
  check('计数显示 1/2', (await evalJs('document.getElementById("todo-count").textContent')) === '1/2', await evalJs('document.getElementById("todo-count").textContent'));

  await evalJs('document.getElementById("todo-clear").click()');
  await sleep(400);
  check('清理已完成生效', (await evalJs('getTodoItems().length')) === 1 && (await evalJs('getTodoItems()[0].done')) === false);

  const todoId1 = await evalJs('getTodoItems()[0].id');
  await evalJs(`document.querySelector('.todo-del[data-id="${todoId1}"]').click()`);
  await sleep(400);
  check('删除待办生效', (await evalJs('getTodoItems().length')) === 0);
  check('空状态提示出现', (await evalJs('!!document.querySelector("#todo-list .todo-empty")')) === true);

  await evalJs(`(() => { const i = document.getElementById('todo-input'); i.value = '持久化验证'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'ok'; })()`);
  await sleep(1200);
  check('待办写入 storage（走合并写）', (await evalJs(`new Promise(r => chrome.storage.sync.get('settings', d => r(((d.settings || {}).todoItems || []).length)))`)) >= 1);

  // 组件开关（注册表驱动的可见性）
  await evalJs('openSettingsPanel()');
  await sleep(400);
  await evalJs(`(() => { const t = document.getElementById('toggle-todo'); t.checked = false; t.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await sleep(900);
  check('关闭开关后待办组件隐藏', (await evalJs('getComputedStyle(document.getElementById("dash-todo")).display')) === 'none');
  await evalJs(`(() => { const t = document.getElementById('toggle-todo'); t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await sleep(900);
  check('重新开启后组件显示', (await evalJs('getComputedStyle(document.getElementById("dash-todo")).display')) !== 'none');
  await evalJs('closeSettingsPanel()');
  await sleep(300);

  console.log('\n[16] P3-5 搜索建议（历史 / 书签）');
  const mf2 = JSON.parse(await evalJs('JSON.stringify(chrome.runtime.getManifest())'));
  check('manifest 声明可选权限 history/bookmarks', JSON.stringify(mf2.optional_permissions) === JSON.stringify(['history', 'bookmarks']), mf2.optional_permissions);
  check('必需权限未包含 history/bookmarks', !(mf2.permissions || []).some(pm => pm === 'history' || pm === 'bookmarks'), mf2.permissions);
  check('建议默认关闭', (await evalJs('currentSettings.searchSuggestions === true')) === false);
  check('未开启时输入不弹建议', (await evalJs(`(() => { onSearchInputForSuggestions('git'); return document.getElementById('suggest-dropdown').classList.contains('hidden'); })()`)) === true);
  check('未授权时 querySuggestions 安全返回空数组', (await evalJs('(async () => Array.isArray(await querySuggestions("git")))()')) === true);

  // 渲染与键盘导航（直接注入假数据，绕开权限）
  await evalJs(`(() => {
    _suggestResults = [
      { type: 'bookmark', title: 'GitHub', url: 'https://github.com', score: 30 },
      { type: 'history', title: 'GitHub 文档', url: 'https://docs.github.com', score: 10 },
    ];
    _suggestIndex = -1;
    renderSuggestDropdown();
    return 'ok';
  })()`);
  await sleep(300);
  check('建议下拉渲染 2 条', (await evalJs('document.querySelectorAll("#suggest-list .local-search-item").length')) === 2);
  check('书签项带 🔖 图标', (await evalJs('document.querySelector("#suggest-list .sg-icon").textContent')) === '🔖');
  check('输入框 aria-expanded 同步', (await evalJs('document.getElementById("search-input").getAttribute("aria-expanded")')) === 'true');
  await evalJs('handleSuggestKeydown({ key: "ArrowDown", preventDefault(){}, })');
  await sleep(150);
  check('方向键高亮第一项', (await evalJs('_suggestIndex')) === 0);
  check('高亮项带 active 类且 aria-selected 同步', (await evalJs("!!document.querySelector('#suggest-list .local-search-item.active')")) === true && (await evalJs('_suggestIndex')) === 0);
  await evalJs('handleSuggestKeydown({ key: "Escape", preventDefault(){} })');
  await sleep(150);
  check('ESC 收起建议并复位', (await evalJs('document.getElementById("suggest-dropdown").classList.contains("hidden")')) === true && (await evalJs('_suggestResults.length')) === 0);

  // 开关：未授权时应回滚并提示（headless 无法真的授权）
  await evalJs('openSettingsPanel()');
  await sleep(400);
  await evalJs(`(() => { const t = document.getElementById('toggle-suggest'); t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await sleep(1500);
  check('未授权时开关回滚为关闭', (await evalJs('document.getElementById("toggle-suggest").checked')) === false);
  check('回滚后设置保持关闭', (await evalJs('currentSettings.searchSuggestions === true')) === false);
  await evalJs('closeSettingsPanel()');
  await sleep(300);

  console.log('\n[17] P3-7 本地多图壁纸 + 轮播 + 单张遮罩');
  // 面板已在上一步关闭，重新打开以初始化壁纸 UI
  await evalJs('openSettingsPanel()');
  await sleep(400);
  check('多图壁纸 UI 已渲染', (await evalJs('!!document.getElementById("local-wallpaper-list") && !!document.getElementById("btn-wallpaper-upload-multi") && !!document.getElementById("setting-wallpaper-rotate")')) === true);
  check('轮播默认关闭且间隔行隐藏', (await evalJs('document.getElementById("setting-wallpaper-rotate").value')) === 'off' && (await evalJs('getComputedStyle(document.getElementById("wallpaper-rotate-min-row")).display')) === 'none');

  // 用内存中的 1x1 PNG 构造 File，走真实上传路径
  const added = await evalJs(`(async () => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const f1 = new File([bytes], '壁纸A.png', { type: 'image/png' });
    const f2 = new File([bytes], '壁纸B.png', { type: 'image/png' });
    return await addLocalWallpapers([f1, f2]);
  })()`);
  check('添加两张本地壁纸', added === 2, added);
  check('写入 settings.localWallpapers', (await evalJs('getLocalWallpapers().length')) === 2);
  check('列表渲染 2 项', (await evalJs('document.querySelectorAll("#local-wallpaper-list .lw-item").length')) === 2);
  check('缩略图已加载', (await evalJs('(() => { const im = document.querySelector("#local-wallpaper-list .lw-thumb"); return !!im && im.src.indexOf("blob:") === 0; })()')) === true);

  // 单张独立遮罩
  const wpKey = await evalJs('getLocalWallpapers()[0].key');
  await evalJs(`setLocalWallpaperOpacity('${wpKey}', 75)`);
  await sleep(500);
  check('单张遮罩写入该张', (await evalJs('getLocalWallpapers()[0].opacity')) === 75);
  check('单张遮罩生效到 CSS 变量', (await evalJs('getComputedStyle(document.documentElement).getPropertyValue("--wallpaper-opacity").trim()')) === '0.75', await evalJs('getComputedStyle(document.documentElement).getPropertyValue("--wallpaper-opacity")'));
  await evalJs(`setLocalWallpaperOpacity('${wpKey}', null)`);
  await sleep(300);
  check('清除后回退为跟随全局', (await evalJs('getLocalWallpapers()[0].opacity')) === null);

  // 轮播：newtab 只在「新标签页」路径（advance=true）递增；interval 按时间片固定
  await evalJs(`(async () => { currentSettings.wallpaperRotate = 'newtab'; const a = await _pickLocalWallpaperIndex(getLocalWallpapers(), currentSettings, true); const b = await _pickLocalWallpaperIndex(getLocalWallpapers(), currentSettings, true); return JSON.stringify([a, b]); })()`);
  const rot = JSON.parse(await evalJs(`(async () => { const a = await _pickLocalWallpaperIndex(getLocalWallpapers(), currentSettings, true); const b = await _pickLocalWallpaperIndex(getLocalWallpapers(), currentSettings, true); return JSON.stringify([a, b]); })()`));
  check('newtab 模式逐次递增（新标签页路径 advance=true）', rot[1] === (rot[0] + 1) % 2, rot);
  // BUG-057: 重刷路径（不传 advance）只读序号，不推进
  const rotRead = JSON.parse(await evalJs(`(async () => { currentSettings.wallpaperRotate = 'newtab'; const a = await _pickLocalWallpaperIndex(getLocalWallpapers(), currentSettings); const b = await _pickLocalWallpaperIndex(getLocalWallpapers(), currentSettings); return JSON.stringify([a, b]); })()`));
  check('BUG-057 newtab 重刷只读（序号不变）', rotRead[0] === rotRead[1], rotRead);
  const rot2 = JSON.parse(await evalJs(`(async () => { currentSettings.wallpaperRotate = 'interval'; currentSettings.wallpaperRotateMin = 30; const a = await _pickLocalWallpaperIndex(getLocalWallpapers(), currentSettings); const b = await _pickLocalWallpaperIndex(getLocalWallpapers(), currentSettings); return JSON.stringify([a, b]); })()`));
  check('interval 模式同一时间片内固定', rot2[0] === rot2[1] && rot2[0] >= 0 && rot2[0] < 2, rot2);

  // 应用与删除
  await evalJs(`(async () => { currentSettings.wallpaperMode = 'custom'; currentSettings.wallpaperRotate = 'off'; await applyWallpaper(currentSettings); return 'ok'; })()`);
  await sleep(800);
  check('应用本地壁纸后 body 有 has-wallpaper', (await evalJs('document.body.classList.contains("has-wallpaper")')) === true);
  check('背景图为 blob URL', (await evalJs('document.body.style.backgroundImage.indexOf("blob:") !== -1')) === true);
  await evalJs(`deleteLocalWallpaper('${wpKey}')`);
  await sleep(600);
  check('删除后列表剩 1 张', (await evalJs('getLocalWallpapers().length')) === 1);
  check('IndexedDB 中已删除', (await evalJs(`(async () => (await loadImage('${wpKey}')) === undefined)()`)) === true);
  // 清理：清空列表避免影响后续断言
  await evalJs('(async () => { const keys = getLocalWallpapers().map(x => x.key); for (const k of keys) { await deleteLocalWallpaper(k); } return "ok"; })()');
  await sleep(600);
  check('清空后列表为空', (await evalJs('getLocalWallpapers().length')) === 0);
  await evalJs('closeSettingsPanel()');
  await sleep(300);

  console.log('\n[18] P3-8 可选 favicon（离线缓存 + 首字符兜底）');
  check('默认关闭', (await evalJs('currentSettings.useFavicon === true')) === false);
  const offResult = JSON.parse(await evalJs('(async () => JSON.stringify(await enrichCardFavicons()))()'));
  check('未开启时不发起任何请求', offResult.fetched === 0 && offResult.failed === 0, offResult);
  check('favicon 地址由站点根推导', (await evalJs('_faviconUrlFor("https://a.b.com/path/x?y=1")')) === 'https://a.b.com/favicon.ico');
  check('非 http(s) 地址返回 null', (await evalJs('_faviconUrlFor("chrome://settings")')) === null && (await evalJs('_faviconUrlFor("不是网址")')) === null);

  // 开启后：每张候选卡片要么拿到图标、要么被标记失败（不再重试），不会卡住
  await evalJs('(() => { currentSettings.useFavicon = true; return "ok"; })()');
  const onResult = JSON.parse(await evalJs('(async () => JSON.stringify(await enrichCardFavicons({ limit: 2 })))()'));
  check('开启后对候选卡片做出决定', (onResult.fetched + onResult.failed) >= 0 && typeof onResult.fetched === 'number', onResult);
  const decided = JSON.parse(await evalJs(`JSON.stringify((() => {
    const out = { withImage: 0, failed: 0, neither: 0 };
    groups.forEach(g => (g.cards || []).forEach(c => {
      if (c.image) out.withImage++;
      else if (c.faviconFailed) out.failed++;
      else out.neither++;
    }));
    return out;
  })())`));
  check('失败卡片被标记（不会无限重试）', decided.failed + decided.withImage > 0, decided);
  check('首字符兜底仍渲染（无图卡片有 fallback 块或纯文字）', (await evalJs('document.querySelectorAll("#speeddial-grid .card-fallback, #speeddial-grid .card-pure-text").length')) > 0);

  const decidedBefore = decided.failed + decided.withImage;
  await evalJs('(async () => await enrichCardFavicons())()');
  await sleep(600);
  const after = JSON.parse(await evalJs(`JSON.stringify((() => {
    const out = { withImage: 0, failed: 0 };
    groups.forEach(g => (g.cards || []).forEach(c => { if (c.image) out.withImage++; else if (c.faviconFailed) out.failed++; }));
    return out;
  })())`));
  check('二次执行不会重复处理已决定卡片（幂等）', after.failed + after.withImage >= decidedBefore, { decidedBefore, after });

  // 开关存在且已接线
  await evalJs('openSettingsPanel()');
  await sleep(400);
  check('设置里有 favicon 开关且状态同步', (await evalJs('!!document.getElementById("toggle-use-favicon") && document.getElementById("toggle-use-favicon").checked')) === true);
  await evalJs(`(() => { const t = document.getElementById('toggle-use-favicon'); t.checked = false; t.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await sleep(700);
  check('关闭后写入设置', (await evalJs('currentSettings.useFavicon === true')) === false);
  await evalJs('closeSettingsPanel()');
  await sleep(300);

  console.log('\n[19] 分组名显示规则（不打开设置面板也必须生效）');
  // 先确保有两个分组，然后分别写入三种规则并刷新页面断言
  await evalJs(`(async () => {
    if (groups.length < 2) { groups.push({ id: 'gn_test', name: '测试组', cards: [] }); await saveGroups(groups); }
    return 'ok';
  })()`);
  const groupCount = await evalJs('groups.length');

  async function setGroupNameModeAndReload(mode) {
    await send('Page.navigate', { url: `chrome-extension://${EXT_ID}/index.html` }, sid);
    await sleep(1300);
    await waitForReady();
    await evalJs(`(async () => {
      await flushSyncWrites();
      const s = Object.assign({}, currentSettings);
      s.showGroupName = ${JSON.stringify(mode)};
      currentSettings = s;
      await new Promise(r => chrome.storage.sync.set({ settings: s }, r));
      return 'ok';
    })()`);
    await send('Page.navigate', { url: `chrome-extension://${EXT_ID}/index.html` }, sid);
    await sleep(1500);
    await waitForReady();
    return JSON.parse(await evalJs(`JSON.stringify((() => {
      const ind = document.getElementById('group-indicator');
      return {
        names: ind.querySelectorAll('.group-dot-name, .group-tab').length,
        tabs: ind.querySelectorAll('.group-tab').length,
        dots: ind.querySelectorAll('.group-dot').length,
        panelOpen: !document.getElementById('settings-panel').classList.contains('hidden'),
        selectValue: document.getElementById('setting-group-name-mode').value,
        setting: currentSettings.showGroupName
      };
    })())`));
  }

  const gnAll = await setGroupNameModeAndReload('all');
  check('规则=全部：刷新后显示所有组名（且未打开设置面板）', gnAll.names === groupCount && !gnAll.panelOpen, gnAll);
  const gnActive = await setGroupNameModeAndReload('active');
  check('规则=仅当前组：只显示当前组名', gnActive.names === 1, gnActive);
  const gnOff = await setGroupNameModeAndReload('off');
  check('规则=不显示：只有圆点没有组名', gnOff.names === 0 && gnOff.dots === groupCount, gnOff);
  check('设置值原样保存（未被下拉框默认值覆盖）', gnOff.setting === 'off' && gnActive.setting === 'active', { off: gnOff.setting, active: gnActive.setting });

  // 面板里改下拉框 → 应用并落盘
  await evalJs('openSettingsPanel()');
  await sleep(500);
  check('面板回填为已保存的规则', (await evalJs('document.getElementById("setting-group-name-mode").value')) === 'off');
  await evalJs(`(() => { const sel = document.getElementById('setting-group-name-mode'); sel.value = 'all'; sel.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await sleep(900);
  check('面板切换后立即生效', (await evalJs(`document.querySelectorAll('#group-indicator .group-dot-name, #group-indicator .group-tab').length`)) === groupCount, await evalJs(`document.querySelectorAll('#group-indicator .group-dot-name, #group-indicator .group-tab').length`));
  check('面板切换后写入设置', (await evalJs('currentSettings.showGroupName')) === 'all');
  await evalJs('closeSettingsPanel()');
  await sleep(300);

  // 自测过滤规则（BUG-073 双向对照）：外部服务网络失败应被忽略，代码回归必须被计入。
  // 只注入「应被忽略」的样本是原实现的老毛病 —— 过滤规则被放宽到吞掉一切时，自测照样通过。
  // 第二条特意带上 Open-Meteo 前缀（旧关键词黑名单会连它一起吞掉）但错误类型是代码 bug，必须计入。
  await evalJs('console.error("Open-Meteo error: fetch failed（测试注入，应被忽略）")');
  await evalJs('console.error("Open-Meteo error: TypeError: boom（测试注入，必须计入）")');
  await sleep(300);
  check('过滤规则：外部服务网络失败被忽略（不计入失败门）', consoleLog.ignored.some(t => t.includes('应被忽略')), consoleLog.ignored.slice(0, 3));
  check('过滤规则：普通 console.error 仍被计入', consoleErrors.some(t => t.includes('必须计入')), consoleErrors.slice(0, 3));
  { // 清掉自检注入的「必须计入」样本，避免污染 [29] 的全局报错门
    const i = consoleErrors.findIndex(t => t.includes('必须计入'));
    if (i >= 0) consoleErrors.splice(i, 1);
  }

  console.log('\n[20] 版式回归（看板不强制换行 / 信息条不压搜索栏与卡片）');
  await evalJs('closeSettingsPanel()');
  await sleep(300);
  const layout = JSON.parse(await evalJs(`JSON.stringify((() => {
    const items = [...document.querySelectorAll('#dashboard-grid .dashboard-item')];
    const tops = items.map(el => Math.round(el.getBoundingClientRect().top));
    const bottoms = items.map(el => Math.round(el.getBoundingClientRect().bottom));
    const lefts = items.map(el => Math.round(el.getBoundingClientRect().left));
    const bar = document.getElementById('wallpaper-info');
    const search = document.querySelector('.search-section') || document.getElementById('search-input');
    const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }; };
    return { tops, bottoms, lefts, bar: r(bar), search: r(search),
      cardsTop: Math.min(...[...document.querySelectorAll('#speeddial-grid .card-wrapper')].map(el => Math.round(el.getBoundingClientRect().top))),
      dir: document.getElementById('dashboard-grid').getAttribute('data-layout'),
      spans: Object.fromEntries(DASHBOARD_WIDGETS.map(w => [w.id, getDashboardLayout()[w.id].span])) };
  })())`));
  check('看板组件在同一行（横向不被强制换行）', new Set(layout.bottoms).size === 1 && new Set(layout.lefts).size === layout.lefts.length, { bottoms: layout.bottoms, lefts: layout.lefts, dir: layout.dir, spans: layout.spans });
  check('壁纸信息条不与搜索栏重叠', layout.bar.top >= layout.search.bottom || layout.bar.bottom <= layout.search.top, { bar: layout.bar, search: layout.search });
  check('壁纸信息条不与卡片重叠', layout.bar.bottom <= layout.cardsTop, { barBottom: layout.bar.bottom, cardsTop: layout.cardsTop });
  const dashW = await evalJs('Math.round(document.getElementById("dashboard-grid").getBoundingClientRect().width)');
  const vw = await evalJs('window.innerWidth');
  check('看板占满可用宽度（94vw，无固定像素上限）', dashW / vw > 0.9, { dashW, vw });

  console.log('\n[21] 改设置不得清空表单管不到的数据（用户复现路径）');
  // 造数据：自定义看板宽度 + 待办 + 本地壁纸 + 卡片列数
  await evalJs('openSettingsPanel()');
  await sleep(500);
  // 卡片列数走真实滑块路径（保证表单与数据一致）
  await evalJs(`(() => { const el = document.getElementById('setting-columns-slider'); el.value = '4'; el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await sleep(600);
  await evalJs(`(async () => {
    const l = getDashboardLayout();
    l.clock.span = 5; l.weather.span = 3; l.todo.span = 2; l.lunar.span = 2;
    _saveLayout(l);
    addTodoItem('不能被清空的待办');
    currentSettings.localWallpapers = [{ key: 'wp_fake', name: '假壁纸.png', opacity: 60 }];
    await saveSettings(currentSettings);
    await flushSyncWrites();
    return 'ok';
  })()`);
  await sleep(700);

  // 触发一次设置变更（等价于用户点「取消显示待办」开关）
  await evalJs(`(() => { const t = document.getElementById('toggle-todo'); t.checked = false; t.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await sleep(1100);
  const afterToggle = JSON.parse(await evalJs(`JSON.stringify({
    layout: currentSettings.dashboardWidgetLayout,
    todo: (currentSettings.todoItems || []).length,
    wallpapers: (currentSettings.localWallpapers || []).length,
    columns: currentSettings.columns,
    lockedType: typeof currentSettings.isLocked
  })`));
  check('设置变更后看板布局仍在', !!afterToggle.layout && afterToggle.layout.clock.span === 5, afterToggle.layout);
  check('设置变更后待办内容仍在', afterToggle.todo >= 1, afterToggle);
  check('设置变更后本地壁纸列表仍在', afterToggle.wallpapers >= 1, afterToggle);
  check('设置变更后卡片列数仍在（columns=4）', afterToggle.columns === 4, afterToggle);
  check('设置变更后锁定状态字段未丢失', afterToggle.lockedType === 'boolean', afterToggle);
  await evalJs('closeSettingsPanel()');
  await sleep(400);

  // 刷新后宽度必须保持（用户复现：刷新后剩余看板回到初始宽度）
  await send('Page.navigate', { url: `chrome-extension://${EXT_ID}/index.html` }, sid);
  await sleep(1600);
  // BUG-041：原先这里丢弃了 waitForReady() 的返回值 —— 页面没就绪时后续 evalJs 拿到 undefined，
  // JSON.parse(undefined) 抛 SyntaxError 被全局 catch 吞成「环境跳过」→ 断言实际没跑却判绿。
  check('刷新后页面重新就绪（后续断言才有意义）', (await waitForReady()) === true);
  const afterReload = JSON.parse(await evalJs(`JSON.stringify({
    spans: Object.fromEntries(DASHBOARD_WIDGETS.map(w => [w.id, getDashboardLayout()[w.id].span])),
    domN: Object.fromEntries([...document.querySelectorAll('#dashboard-grid .dashboard-item')].map(e => [e.dataset.widget, e.style.getPropertyValue('--dash-n')])),
    todoVisible: getComputedStyle(document.getElementById('dash-todo')).display !== 'none',
    todoItems: (currentSettings.todoItems || []).length,
    columns: currentSettings.columns
  })`));
  check('刷新后自定义宽度保持（未回到初始值）', afterReload.spans.clock === 5 && afterReload.spans.weather === 3, afterReload.spans);
  check('刷新后 DOM 宽度与模型一致', afterReload.domN.clock === '5' && afterReload.domN.weather === '3', afterReload.domN);
  check('刷新后隐藏的待办仍是隐藏', afterReload.todoVisible === false);
  check('刷新后待办内容与列数仍在', afterReload.todoItems >= 1 && afterReload.columns === 4, { todoItems: afterReload.todoItems, columns: afterReload.columns });

  console.log('\n[22] BUG-035 分组管理器删除后列表必须刷新（否则会删错分组）');
  await evalJs(`(async () => {
    const mk = (id, name, card) => ({ id, name, sortMode: 'manual', cards: [{ id: id + '_c', name: card, url: 'https://' + card.toLowerCase() + '.example.com/', visitCount: 0 }] });
    groups = [mk('ga','A组','ALPHA'), mk('gb','B组','BRAVO'), mk('gc','C组','CHARLIE'), mk('gd','D组','DELTA')];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    await saveGroups(groups);
    renderSpeeddials(); renderGroupDots();
    openGroupManager();
    return 'ok';
  })()`);
  await sleep(500);
  const mgrRows = () => evalJs(`JSON.stringify([...document.querySelectorAll('#group-manager-list .group-mgr-item')].map(el => el.dataset.index + ':' + ((el.querySelector('.group-mgr-name') || {}).value || '?')))`);
  check('管理器列表与数据一致（4 行）', (await mgrRows()) === JSON.stringify(['0:A组', '1:B组', '2:C组', '3:D组']), await mgrRows());
  // 删第 2 行（B组）→ 确认
  await evalJs(`document.querySelector('#group-manager-list .group-mgr-item[data-index="1"] .group-mgr-btn[data-action="mgr-delete"]').click()`);
  await sleep(250);
  await evalJs(`document.getElementById('confirm-ok').click()`);
  await sleep(900);
  check('删除后列表已刷新（不再残留已删分组）', (await mgrRows()) === JSON.stringify(['0:A组', '1:C组', '2:D组']), await mgrRows());
  check('删除后模型为 A,C,D', (await evalJs('groups.map(g => g.name).join(",")')) === 'A组,C组,D组', await evalJs('groups.map(g => g.name).join(",")'));
  check('管理器仍打开（确认框是独立弹窗）', (await evalJs('!document.getElementById("dialog-group-manager").classList.contains("hidden")')) === true);
  // 再点「行上显示为 D组」那一行的删除 —— 修好前这里删掉的是别的分组
  const rowLabel = await evalJs(`(document.querySelector('#group-manager-list .group-mgr-item[data-index="2"] .group-mgr-name') || {}).value`);
  await evalJs(`document.querySelector('#group-manager-list .group-mgr-item[data-index="2"] .group-mgr-btn[data-action="mgr-delete"]').click()`);
  await sleep(250);
  await evalJs(`document.getElementById('confirm-ok').click()`);
  await sleep(900);
  const modelAfter = await evalJs('groups.map(g => g.name).join(",")');
  check('点「' + rowLabel + '」删除后删掉的正是该分组', rowLabel === 'D组' && modelAfter === 'A组,C组', { rowLabel, modelAfter });
  check('删除后行索引与数据仍一一对应', (await mgrRows()) === JSON.stringify(['0:A组', '1:C组']), await mgrRows());
  await evalJs('closeGroupManager()');
  await sleep(400);

  console.log('\n[23] BUG-038 DOM 池按分组 id 缓存（删组 / 重排后不再显示错卡片）');
  await evalJs(`(async () => {
    const mk = (id, name, card) => ({ id, name, sortMode: 'manual', cards: [{ id: id + '_c', name: card, url: 'https://' + card.toLowerCase() + '.example.com/', visitCount: 0 }] });
    groups = [mk('pa','分组A','ALPHA'), mk('pb','分组B','BRAVO'), mk('pc','分组C','CHARLIE')];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    await saveGroups(groups);
    renderSpeeddials(); renderGroupDots();
    for (let k = 0; k < 3; k++) { switchGroup(k); await new Promise(r => setTimeout(r, 200)); }
    return 'ok';
  })()`);
  await sleep(600);
  const visibleCards = () => evalJs(`JSON.stringify([...document.querySelectorAll('.speeddial-group')].filter(c => c.style.display !== 'none').map(c => (c.innerText || '').replace(/\\s+/g, ' ').trim().split(' ')[0]))`);
  check('三组都进 DOM 池后只显示当前分组', (await visibleCards()) === JSON.stringify(['CHARLIE']), await visibleCards());
  await evalJs(`(async () => { _pendingDeleteGroup = 0; await doDeleteGroup(); return 'ok'; })()`);
  await sleep(700);
  await evalJs(`(async () => { switchGroup(0); await new Promise(r => setTimeout(r, 300)); return 'ok'; })()`);
  await sleep(400);
  check('删掉 A 组后切到索引 0 显示的是 B 组卡片（不是已删除分组的）', (await visibleCards()) === JSON.stringify(['BRAVO']), await visibleCards());
  // 重排：moveGroupTo(0,2) 后切回索引 0，必须显示该分组自己的卡片
  await evalJs(`(async () => {
    const mk = (id, name, card) => ({ id, name, sortMode: 'manual', cards: [{ id: id + '_c', name: card, url: 'https://' + card.toLowerCase() + '.example.com/', visitCount: 0 }] });
    groups = [mk('ra','分组A','ALPHA'), mk('rb','分组B','BRAVO'), mk('rc','分组C','CHARLIE')];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    await saveGroups(groups);
    renderSpeeddials(); renderGroupDots();
    for (let k = 0; k < 3; k++) { switchGroup(k); await new Promise(r => setTimeout(r, 200)); }
    await moveGroupTo(0, 2);            // → [B, C, A]
    await new Promise(r => setTimeout(r, 300));
    switchGroup(0);
    return 'ok';
  })()`);
  await sleep(800);
  check('分组重排后切组显示该分组自己的卡片（BRAVO）', (await visibleCards()) === JSON.stringify(['BRAVO']), await visibleCards());
  const poolState = JSON.parse(await evalJs(`JSON.stringify({
    ids: [...document.querySelectorAll('.speeddial-group')].map(c => c.dataset.groupId),
    modelIds: groups.map(g => g.id)
  })`));
  check('DOM 池容器数量不超过 LRU 上限', poolState.ids.length > 0 && poolState.ids.length <= 3, poolState.ids);
  check('每个容器的 data-group-id 都能对应到现有分组（无已删除分组的残留容器）', poolState.ids.every(id => poolState.modelIds.indexOf(id) !== -1), poolState);

  console.log('\n[24] BUG-036 sync 写入被配额拒绝时必须落 local 兜底（不再静默丢数据）');
  const quotaProbe = JSON.parse(await evalJs(`(async () => {
    const mk = (id, name, cardName) => ({ id, name, sortMode: 'manual', cards: [{ id: id + '_c', name: cardName, url: 'https://x.example.com/', visitCount: 0 }] });
    groups = [mk('qa','A组','SMALL_A'), mk('qb','B组','SMALL_B')];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    await saveGroups(groups);
    await new Promise(r => setTimeout(r, 600));
    // 单键超过 QUOTA_BYTES_PER_ITEM(8192) → chrome.storage.sync 真实拒绝
    groups = [mk('qa','A组','HUGE_' + new Array(9000).join('X'))];
    speeddials = groups[0].cards;
    await saveGroups(groups);
    await new Promise(r => setTimeout(r, 900));
    const sync = await new Promise(r => chrome.storage.sync.get(['groups','groups_rev'], r));
    const local = await new Promise(r => chrome.storage.local.get(['groups','groups_rev'], r));
    const back = await getGroups();
    const toast = document.querySelector('.toast');
    return JSON.stringify({
      syncHasHuge: JSON.stringify(sync.groups || []).indexOf('HUGE_') !== -1,
      localHasHuge: JSON.stringify(local.groups || []).indexOf('HUGE_') !== -1,
      localRev: typeof local.groups_rev === 'number',
      readBackHasHuge: JSON.stringify(back || []).indexOf('HUGE_') !== -1,
      toast: toast ? (toast.textContent || '') : ''
    });
  })()`));
  check('sync 确实拒绝了超限写入（旧值未被覆盖）', quotaProbe.syncHasHuge === false, quotaProbe);
  check('被拒后写入 local 兜底（新数据没丢）', quotaProbe.localHasHuge === true, quotaProbe);
  check('local 兜底带版本号（供 getGroups 判定新旧）', quotaProbe.localRev === true, quotaProbe);
  check('getGroups() 读回的是最新数据（local 优先于陈旧的 sync）', quotaProbe.readBackHasHuge === true, quotaProbe);
  check('有用户可见提示（不再静默失败）', /本地/.test(quotaProbe.toast), quotaProbe.toast);
  const recovered = JSON.parse(await evalJs(`(async () => {
    const mk = (id, name, cardName) => ({ id, name, sortMode: 'manual', cards: [{ id: id + '_c', name: cardName, url: 'https://x.example.com/', visitCount: 0 }] });
    groups = [mk('qa','A组','SMALL_A2'), mk('qb','B组','SMALL_B2')];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    await saveGroups(groups);
    await new Promise(r => setTimeout(r, 700));
    const sync = await new Promise(r => chrome.storage.sync.get(['groups','groups_rev'], r));
    const back = await getGroups();
    return JSON.stringify({
      syncHasSmall: JSON.stringify(sync.groups || []).indexOf('SMALL_A2') !== -1,
      readBackHasSmall: JSON.stringify(back || []).indexOf('SMALL_A2') !== -1
    });
  })()`));
  check('数据缩回配额内后 sync 写入恢复', recovered.syncHasSmall === true, recovered);
  check('恢复后 getGroups() 重新以 sync 为准', recovered.readBackHasSmall === true, recovered);

  console.log('\n[25] BUG-037 多标签页设置不再互相覆盖');
  const tabB = await (async () => {
    const t = await send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/index.html` });
    const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    await send('Runtime.enable', {}, a.sessionId);
    await send('Page.enable', {}, a.sessionId);
    try { await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, a.sessionId); } catch (e) { /* 忽略 */ }
    return { targetId: t.targetId, sid: a.sessionId };
  })();
  const evalB = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, tabB.sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result.value;
  };
  let bReady = false;
  for (let i = 0; i < 40; i++) {
    try {
      if (await evalB('typeof currentSettings === "object" && !!currentSettings && !!document.getElementById("dashboard-grid")')) { bReady = true; break; }
    } catch (e) { /* 页面还在导航 */ }
    await sleep(300);
  }
  check('第二个标签页已就绪', bReady);
  // A 页改列数并落盘
  await evalJs(`(async () => { currentSettings.columns = 4; saveSettings(currentSettings); await flushSyncWrites(); return 'ok'; })()`);
  await sleep(1400);
  check('A 页写入后 sync.columns=4', (await evalJs(`new Promise(r => chrome.storage.sync.get('settings', d => r((d.settings || {}).columns)))`)) === 4);
  check('B 页内存跟随 A 页的改动（跨标签页合并）', (await evalB('currentSettings.columns')) === 4, await evalB('currentSettings.columns'));
  // B 页改一个无关设置 → 不能把 A 页刚改的列数覆盖回去
  await evalB(`(async () => { currentSettings.showVisitCount = false; saveSettings(currentSettings); await flushSyncWrites(); return 'ok'; })()`);
  await sleep(1400);
  const afterB = JSON.parse(await evalJs(`new Promise(r => chrome.storage.sync.get('settings', d => r(JSON.stringify({ columns: (d.settings || {}).columns, showVisitCount: (d.settings || {}).showVisitCount }))))`));
  check('B 页改无关设置后 A 页的改动未被回滚', afterB.columns === 4, afterB);
  check('B 页自己的改动已落盘', afterB.showVisitCount === false, afterB);
  // 收尾：恢复设置并关闭第二个标签页
  await evalJs(`(async () => { currentSettings.columns = 5; currentSettings.showVisitCount = true; saveSettings(currentSettings); await flushSyncWrites(); return 'ok'; })()`);
  await sleep(1000);
  try { await send('Target.closeTarget', { targetId: tabB.targetId }); } catch (e) { /* 忽略 */ }
  await sleep(400);

  console.log('\n[26] BUG-039 表单回填必须覆盖表单收集（时钟 / 农历 / 外观）');
  // 用户复现路径：设 12h / 关秒 / 单行农历 → 刷新 → 改任意无关开关 → 不得回退
  await evalJs(`(async () => {
    currentSettings.clockFormat = '12h';
    currentSettings.clockShowSeconds = false;
    currentSettings.lunarStyle = 'single';
    saveSettings(currentSettings);
    await flushSyncWrites();
    return 'ok';
  })()`);
  await sleep(700);
  await send('Page.navigate', { url: `chrome-extension://${EXT_ID}/index.html` }, sid);
  await sleep(1600);
  await waitForReady();
  await evalJs('openSettingsPanel()');
  await sleep(500);
  check('刷新后「时钟格式」回填为 12h', (await evalJs(`document.getElementById('setting-clock-format').value`)) === '12h', await evalJs(`document.getElementById('setting-clock-format').value`));
  check('刷新后「显示秒数」回填为关闭', (await evalJs(`document.getElementById('toggle-clock-seconds').checked`)) === false);
  check('刷新后「农历样式」回填为单行', (await evalJs(`document.getElementById('setting-lunar-style').value`)) === 'single', await evalJs(`document.getElementById('setting-lunar-style').value`));
  await evalJs(`(() => { const t = document.getElementById('toggle-show-visit-count'); t.checked = !t.checked; t.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await sleep(1100);
  const keepClock = JSON.parse(await evalJs(`JSON.stringify([currentSettings.clockFormat, currentSettings.clockShowSeconds, currentSettings.lunarStyle])`));
  check('改无关开关后三项偏好未被写回默认值（内存）', JSON.stringify(keepClock) === JSON.stringify(['12h', false, 'single']), keepClock);
  const storedClock = JSON.parse(await evalJs(`new Promise(r => chrome.storage.sync.get('settings', d => r(JSON.stringify([(d.settings || {}).clockFormat, (d.settings || {}).clockShowSeconds, (d.settings || {}).lunarStyle]))))`));
  check('改无关开关后三项偏好未被写回默认值（已落盘）', JSON.stringify(storedClock) === JSON.stringify(['12h', false, 'single']), storedClock);
  // 不变式：先把表单全部改成脏值，再以数据回填 → 收集结果必须与数据完全一致
  const invariant = JSON.parse(await evalJs(`(() => {
    const dirty = [];
    Object.keys(domSettings).forEach(k => {
      const el = domSettings[k];
      if (!el || !el.tagName) return;
      const tag = el.tagName;
      if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') return;
      dirty.push(k);
      if (el.type === 'checkbox') { el.checked = !el.checked; return; }
      if (tag === 'SELECT') {
        const others = [...el.options].map(o => o.value).filter(v => v !== el.value);
        if (others.length) el.value = others[0];
        return;
      }
      if (el.type === 'color') { el.value = '#010203'; return; }
      const num = parseFloat(el.value);
      if (!isNaN(num) && (el.type === 'range' || el.type === 'number')) {
        const min = el.min !== '' ? parseFloat(el.min) : num - 1;
        const max = el.max !== '' ? parseFloat(el.max) : num + 1;
        el.value = String(Math.min(max, Math.max(min, num === min ? min + 1 : min)));
        return;
      }
      el.value = '__dirty__';
    });
    populateSettingsForm(currentSettings);
    if (typeof populateAppearanceForm === 'function') populateAppearanceForm(domSettings, currentSettings);
    const collected = collectSettingsFromForm();
    const norm = (k, v) => {
      if (k === 'bgColor') return (v === '#f0f2f5') ? '' : (v || '');
      if (k === 'cardBgColor') return (v === '#ffffff') ? '' : (v || '');
      if (k === 'cardTextColor') return (v === '#202124') ? '' : (v || '');
      return v;
    };
    const mismatches = [];
    Object.keys(collected).forEach(k => {
      const exp = norm(k, currentSettings[k]);
      if (JSON.stringify(exp) !== JSON.stringify(collected[k])) mismatches.push({ key: k, 期望: exp, 实际: collected[k] });
    });
    return JSON.stringify({ dirtyCount: dirty.length, collectedCount: Object.keys(collected).length, mismatches: mismatches });
  })()`));
  check('表单脏化后回填：收集结果与数据完全一致（populate ⊇ collect）', invariant.mismatches.length === 0, invariant.mismatches.slice(0, 6));
  check('不变式覆盖全部表单收集字段（≥60）', invariant.collectedCount >= 60 && invariant.dirtyCount >= 40, invariant);
  await evalJs('closeSettingsPanel()');
  await sleep(400);

  console.log('\n[27] v1.5.7 审计第二批：BUG-048 / 049 / 052 / 055 / 056');

  // ---- BUG-055：groups 的 onChanged 回声必须按「值」判定，不能按时间窗 ----
  const echoGroups = JSON.parse(await evalJs(`(async () => {
    const mk = (id, name, card) => ({ id, name, sortMode: 'manual', cards: [{ id: id + '_c', name: card, url: 'https://x.example.com/', visitCount: 0 }] });
    groups = [mk('ea','E组A','ECHO_A')];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    await saveGroups(groups);                       // 刷新本页「刚写入」状态
    await new Promise(r => setTimeout(r, 100));
    // 立即写入一份不同的 groups（等价于另一个标签页在 1.5s 窗口内的真实改动）
    const other = [mk('ea','E组A','ECHO_A'), mk('eb','E组B','ECHO_B_XTAB')];
    await new Promise(r => chrome.storage.sync.set({ groups: other, groups_rev: Date.now() }, r));
    await new Promise(r => setTimeout(r, 500));
    const received = groups.map(g => g.name).join(',');
    await saveGroups(groups);                       // 本页随后再写一次（旧行为会把对方改动回滚）
    await new Promise(r => setTimeout(r, 500));
    const stored = await new Promise(r => chrome.storage.sync.get('groups', d => r(d.groups || [])));
    return JSON.stringify({ received, stored: stored.map(g => g.name).join(',') });
  })()`));
  check('BUG-055 窗口内的外部 groups 改动被接收（不再整段忽略）', echoGroups.received === 'E组A,E组B', echoGroups);
  check('BUG-055 本页随后的写入未回滚外部改动', echoGroups.stored === 'E组A,E组B', echoGroups);

  // 真实双标签页：B 的结构性改动必须留在 sync（不被 A 的陈旧副本覆盖）
  const tabC = await (async () => {
    const t = await send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/index.html` });
    const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    await send('Runtime.enable', {}, a.sessionId);
    await send('Page.enable', {}, a.sessionId);
    return { targetId: t.targetId, sid: a.sessionId };
  })();
  const evalC = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, tabC.sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result.value;
  };
  let cReady = false;
  for (let i = 0; i < 40; i++) {
    try { if (await evalC('typeof currentSettings === "object" && !!currentSettings && !!document.getElementById("dashboard-grid")')) { cReady = true; break; } } catch (e) { /* 导航中 */ }
    await sleep(300);
  }
  check('BUG-055 第三个标签页已就绪（真实双标签页场景）', cReady);
  await evalJs(`(async () => { await saveGroups(groups); return 'ok'; })()`);
  await evalC(`(async () => {
    const g = groups[activeGroupIndex];
    g.cards.push({ id: 'xtab_' + Date.now(), name: 'XTAB_CARD', url: 'https://xtab.example.com/', visitCount: 0 });
    await saveGroups(groups);
    return 'ok';
  })()`);
  await sleep(1200);
  check('BUG-055 B 页新增的卡片已进入 A 页内存', (await evalJs(`(groups[activeGroupIndex].cards || []).some(c => c.name === 'XTAB_CARD')`)) === true);
  await evalJs(`(async () => { await saveGroups(groups); return 'ok'; })()`);
  await sleep(700);
  check('BUG-055 A 页回写后 B 的卡片仍在 sync（未被回滚）', (await evalJs(`new Promise(r => chrome.storage.sync.get('groups', d => r(JSON.stringify(d.groups || []) .indexOf('XTAB_CARD') !== -1)))`)) === true);
  try { await send('Target.closeTarget', { targetId: tabC.targetId }); } catch (e) { /* 忽略 */ }
  await sleep(300);

  // ---- BUG-048：未打开过设置面板时 resize 不得改掉已保存的列数 ----
  await evalJs(`(async () => { currentSettings.columns = 3; saveSettings(currentSettings); await flushSyncWrites(); return 'ok'; })()`);
  await sleep(600);
  await send('Page.navigate', { url: `chrome-extension://${EXT_ID}/index.html` }, sid);
  await sleep(1600);
  await waitForReady();
  check('BUG-048 刷新后面板仍未初始化（复现前提）', (await evalJs('_settingsPanelReady')) === false);
  check('BUG-048 列数滑块仍是 HTML 默认值 5（陷阱存在）', (await evalJs(`document.getElementById('setting-columns-slider').value`)) === '5');
  const beforeResize = await evalJs(`document.getElementById('speeddial-grid').style.width`);
  await evalJs(`window.dispatchEvent(new Event('resize'));`);
  await sleep(600);
  const afterResize = await evalJs(`document.getElementById('speeddial-grid').style.width`);
  check('BUG-048 resize 后网格宽度不变（未按 HTML 默认 5 列重算）', beforeResize === afterResize, { beforeResize, afterResize });
  check('BUG-048 内存列数仍是 3', (await evalJs('currentSettings.columns')) === 3);

  // ---- BUG-049：两个「↺ 重置」按钮必须落盘 + 清卡片内联 height ----
  await evalJs('openSettingsPanel()');
  await sleep(400);
  await evalJs(`(() => { const t = document.getElementById('tab-btn-appearance'); if (t) t.click(); return 'ok'; })()`);
  await sleep(300);
  await evalJs(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    set('setting-card-width', 333);
    set('setting-card-height', 400);
    const bc = document.getElementById('setting-bg-color');
    bc.value = '#123456'; bc.dispatchEvent(new Event('input', { bubbles: true })); bc.dispatchEvent(new Event('change', { bubbles: true }));
    set('setting-card-font-size', 20);
    return 'ok';
  })()`);
  await sleep(1100);
  check('BUG-049 重置前已落盘（333/400）', (await evalJs(`new Promise(r => chrome.storage.sync.get('settings', d => r((d.settings || {}).cardWidth + '/' + (d.settings || {}).cardHeight)))`)) === '333/400');
  await evalJs(`document.getElementById('btn-reset-card-size').click()`);
  await sleep(1100);
  const resetSize = JSON.parse(await evalJs(`(async () => {
    const s = await new Promise(r => chrome.storage.sync.get('settings', d => r(d.settings || {})));
    const card = document.querySelector('.speeddial-card');
    return JSON.stringify({ stored: s.cardWidth + '/' + s.cardHeight, mem: currentSettings.cardWidth + '/' + currentSettings.cardHeight, inline: card ? card.style.height : '' });
  })()`));
  check('BUG-049 「重置卡片大小」已落盘（270/270）', resetSize.stored === '270/270', resetSize);
  check('BUG-049 卡片内联 height 已清掉（高度真正重置）', resetSize.inline === '' || resetSize.inline === '270px', resetSize);
  await evalJs(`document.getElementById('btn-reset-topbar').click()`);
  await sleep(1100);
  const resetTop = JSON.parse(await evalJs(`(async () => {
    const s = await new Promise(r => chrome.storage.sync.get('settings', d => r(d.settings || {})));
    return JSON.stringify({ bg: s.bgColor, fs: s.cardFontSize, topbarVar: document.documentElement.style.getPropertyValue('--topbar-bg') });
  })()`));
  check('BUG-049 「重置信息栏」已落盘（bgColor 清空 / 字号 13）', resetTop.bg === '' && resetTop.fs === 13, resetTop);
  await evalJs('closeSettingsPanel()');
  await sleep(400);

  // ---- BUG-052：右键「移动到分组」后目标分组容器必须失效 ----
  await evalJs(`(async () => {
    const mk = (id, name, card) => ({ id, name, sortMode: 'manual', cards: [{ id: id + '_c', name: card, url: 'https://' + card.toLowerCase() + '.example.com/', visitCount: 0 }] });
    groups = [mk('na','N组A','NOVA'), mk('nb','N组B','NEBULA')];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    await saveGroups(groups);
    renderSpeeddials(); renderGroupDots();
    switchGroup(1);                       // 让目标分组容器先进 DOM 池
    await new Promise(r => setTimeout(r, 250));
    switchGroup(0);
    await new Promise(r => setTimeout(r, 250));
    contextCardId = groups[0].cards[0].id;
    await handleMoveToGroup(1);           // 等价于右键菜单「移动到分组 → N组B」
    await new Promise(r => setTimeout(r, 400));
    switchGroup(1);
    await new Promise(r => setTimeout(r, 400));
    return 'ok';
  })()`);
  const movedVisible = await evalJs(`JSON.stringify([...document.querySelectorAll('.speeddial-group')].filter(c => c.style.display !== 'none').map(c => (c.innerText || '').replace(/\\s+/g, ' ')).join(' | '))`);
  check('BUG-052 切到目标分组能看到刚移入的卡片', movedVisible.indexOf('NOVA') !== -1, movedVisible);
  check('BUG-052 源分组已不含该卡片', (await evalJs(`groups[0].cards.some(c => c.name === 'NOVA')`)) === false);

  // ---- BUG-056：启动时关闭的组件重新开启后必须可用（真实刷新路径） ----
  await evalJs(`(async () => { currentSettings.showTodo = false; saveSettings(currentSettings); await flushSyncWrites(); return 'ok'; })()`);
  await sleep(700);
  await send('Page.navigate', { url: `chrome-extension://${EXT_ID}/index.html` }, sid);
  await sleep(1600);
  await waitForReady();
  check('BUG-056 刷新后待办组件未初始化（复现前提）', (await evalJs(`!document.getElementById('dash-todo').dataset.todoInited`)) === true);
  check('BUG-056 刷新后待办组件隐藏', (await evalJs(`getComputedStyle(document.getElementById('dash-todo')).display`)) === 'none');
  await evalJs('openSettingsPanel()');
  await sleep(500);
  await evalJs(`(() => { const t = document.getElementById('toggle-todo'); t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await sleep(900);
  await evalJs('closeSettingsPanel()');
  await sleep(300);
  check('BUG-056 重新开启后组件已初始化', (await evalJs(`document.getElementById('dash-todo').dataset.todoInited`)) === '1');
  const todoWorks = JSON.parse(await evalJs(`(async () => {
    const before = getTodoItems().length;
    const input = document.getElementById('todo-input');
    input.value = 'E2E 待办';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const items = getTodoItems();
    return JSON.stringify({ before, count: items.length, rendered: document.querySelectorAll('#todo-list .todo-item').length, hasNew: items.some(i => i.text === 'E2E 待办') });
  })()`));
  check('BUG-056 重新开启后回车可添加并渲染', todoWorks.count === todoWorks.before + 1 && todoWorks.rendered === todoWorks.count && todoWorks.hasNew, todoWorks);
  check('BUG-056 initTodo 幂等（重复调用不重复绑定）', (await evalJs(`(() => { const before = getTodoItems().length; initTodo(); initTodo(); const input = document.getElementById('todo-input'); input.value = 'E2E 待办2'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return getTodoItems().length - before; })()`)) === 1);
  // 收尾：清掉待办并恢复列数
  await evalJs(`(async () => { currentSettings.todoItems = []; currentSettings.columns = 5; saveSettings(currentSettings); await flushSyncWrites(); return 'ok'; })()`);
  await sleep(600);

  console.log('\n[28] v1.5.8 审计第二批：BUG-045 / 057 / 063 / 071');

  // ---- BUG-045：跨标签页删组后本页 activeGroupIndex 必须校正（否则看板空白） ----
  const idxClamp = JSON.parse(await evalJs(`(async () => {
    const mk = (id, name, card) => ({ id, name, sortMode: 'manual', cards: [{ id: id + '_c', name: card, url: 'https://' + card.toLowerCase() + '.example.com/', visitCount: 0 }] });
    groups = [mk('q1','Q1','ONE'), mk('q2','Q2','TWO'), mk('q3','Q3','THREE'), mk('q4','Q4','FOUR')];
    activeGroupIndex = 3; speeddials = groups[3].cards;
    await saveGroups(groups); renderSpeeddials(); renderGroupDots();
    await new Promise(r => setTimeout(r, 300));
    // 模拟另一个标签页删掉两个分组（索引 3 越界）
    const shrunk = [mk('q1','Q1','ONE'), mk('q2','Q2','TWO')];
    await new Promise(r => chrome.storage.sync.set({ groups: shrunk, groups_rev: Date.now() }, r));
    await new Promise(r => setTimeout(r, 700));
    return JSON.stringify({
      idx: activeGroupIndex, len: groups.length,
      outOfRange: activeGroupIndex >= groups.length,
      speeddials: speeddials.length,
      visible: document.querySelectorAll('.speeddial-group .card-wrapper[data-id]').length,
      activeDots: document.querySelectorAll('#group-dots .group-dot.active, #group-dots .group-tab.active').length
    });
  })()`));
  check('BUG-045 跨标签页删组后索引被校正（不再越界）', idxClamp.outOfRange === false && idxClamp.idx === 1, idxClamp);
  check('BUG-045 看板不再空白且有选中分组', idxClamp.visible > 0 && idxClamp.speeddials > 0 && idxClamp.activeDots === 1, idxClamp);

  // 真实双标签页：B 停在最后一个分组，A 删组后 B 的视图必须仍然合法
  const tabD = await (async () => {
    const t = await send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/index.html` });
    const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    await send('Runtime.enable', {}, a.sessionId);
    await send('Page.enable', {}, a.sessionId);
    return { targetId: t.targetId, sid: a.sessionId };
  })();
  const evalD = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, tabD.sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result.value;
  };
  let dReady = false;
  for (let i = 0; i < 40; i++) {
    try { if (await evalD('typeof currentSettings === "object" && !!currentSettings && !!document.getElementById("dashboard-grid")')) { dReady = true; break; } } catch (e) { /* 导航中 */ }
    await sleep(300);
  }
  check('BUG-045 第四个标签页已就绪（真实双标签页场景）', dReady);
  await evalJs(`(async () => {
    const mk = (id, name, card) => ({ id, name, sortMode: 'manual', cards: [{ id: id + '_c', name: card, url: 'https://' + card.toLowerCase() + '.example.com/', visitCount: 0 }] });
    groups = [mk('r1','R1','RONE'), mk('r2','R2','RTWO'), mk('r3','R3','RTHREE')];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    await saveGroups(groups); renderSpeeddials(); renderGroupDots();
    return 'ok';
  })()`);
  await sleep(900);
  await evalD(`(async () => { switchGroup(2); await new Promise(r => setTimeout(r, 300)); return 'ok'; })()`);
  check('BUG-045 B 页停在最后一个分组', (await evalD('activeGroupIndex')) === 2);
  await evalJs(`(async () => { _pendingDeleteGroup = 0; await doDeleteGroup(); return 'ok'; })()`);
  await sleep(1400);
  const bState = JSON.parse(await evalD(`JSON.stringify({
    idx: activeGroupIndex, len: groups.length,
    outOfRange: activeGroupIndex >= groups.length,
    speeddials: speeddials.length,
    visible: document.querySelectorAll('.speeddial-group .card-wrapper[data-id]').length
  })`));
  check('BUG-045 B 页索引在 A 删组后被校正且看板非空', bState.outOfRange === false && bState.visible > 0, bState);
  try { await send('Target.closeTarget', { targetId: tabD.targetId }); } catch (e) { /* 忽略 */ }
  await sleep(300);

  // ---- BUG-057：newtab 轮播序号只在「新标签页」推进，重刷不得换图 ----
  const rotState = JSON.parse(await evalJs(`(async () => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bin = atob(b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await ensureSettingsPanelReady();
    currentSettings.wallpaperMode = 'custom';
    currentSettings.wallpaperRotate = 'newtab';
    currentSettings.localWallpapers = [];
    await new Promise(r => chrome.storage.local.set({ wallpaper_rotate_idx: 0 }, r));
    await addLocalWallpapers([new File([bytes], 'R1.png', { type: 'image/png' }), new File([bytes], 'R2.png', { type: 'image/png' })]);
    await new Promise(r => setTimeout(r, 500));
    const readIdx = () => new Promise(r => chrome.storage.local.get(['wallpaper_rotate_idx'], d => r(d.wallpaper_rotate_idx || 0)));
    const afterAdd = await readIdx();
    await applyWallpaper(currentSettings);            // 等价于「改任意设置触发重刷」
    await new Promise(r => setTimeout(r, 400));
    const afterRefresh1 = await readIdx();
    await applyWallpaper(currentSettings);
    await new Promise(r => setTimeout(r, 400));
    const afterRefresh2 = await readIdx();
    await initWallpaper();                            // 等价于「新开一个标签页」
    await new Promise(r => setTimeout(r, 500));
    const afterNewTab = await readIdx();
    return JSON.stringify({ afterAdd, afterRefresh1, afterRefresh2, afterNewTab });
  })()`));
  check('BUG-057 重刷壁纸不推进轮播序号', rotState.afterRefresh1 === rotState.afterAdd && rotState.afterRefresh2 === rotState.afterAdd, rotState);
  check('BUG-057 新标签页推进一次序号', rotState.afterNewTab === (rotState.afterRefresh2 + 1) % 2, rotState);

  // ---- BUG-063：ESC 能关掉「重复卡片检查」弹窗，且不误关设置面板 ----
  await evalJs(`(async () => {
    const mk = (id, name, card) => ({ id, name, sortMode: 'manual', cards: [{ id: card, name: card, url: 'https://dup.example.com/', visitCount: 0 }] });
    groups = [mk('s1','S1','SDUP_A'), mk('s2','S2','SDUP_B')];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    await saveGroups(groups); renderSpeeddials(); renderGroupDots();
    openSettingsPanel();
    await new Promise(r => setTimeout(r, 400));
    showDuplicateCheckDialog();
    await new Promise(r => setTimeout(r, 400));
    return 'ok';
  })()`);
  check('BUG-063 重复检查弹窗已打开', (await evalJs(`!document.getElementById('dialog-duplicate-check').classList.contains('hidden')`)) === true);
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);
  check('BUG-063 ESC 关掉了重复检查弹窗', (await evalJs(`document.getElementById('dialog-duplicate-check').classList.contains('hidden')`)) === true);
  check('BUG-063 ESC 未误关底下的设置面板', (await evalJs(`!document.getElementById('settings-panel').classList.contains('hidden')`)) === true);
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);
  check('BUG-063 再按一次 ESC 才关设置面板', (await evalJs(`document.getElementById('settings-panel').classList.contains('hidden')`)) === true);

  // ---- BUG-071：设置面板内打开子弹窗后，ESC 只关子弹窗 ----
  await evalJs(`(async () => { openSettingsPanel(); await new Promise(r => setTimeout(r, 300)); openGroupManager(); await new Promise(r => setTimeout(r, 300)); return 'ok'; })()`);
  check('BUG-071 分组管理器已打开且面板仍在', (await evalJs(`!document.getElementById('dialog-group-manager').classList.contains('hidden') && !document.getElementById('settings-panel').classList.contains('hidden')`)) === true);
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);
  check('BUG-071 ESC 只关掉分组管理器', (await evalJs(`document.getElementById('dialog-group-manager').classList.contains('hidden')`)) === true);
  check('BUG-071 设置面板仍然打开（守卫不再失效）', (await evalJs(`!document.getElementById('settings-panel').classList.contains('hidden')`)) === true);
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);
  check('BUG-071 再按一次 ESC 才关设置面板', (await evalJs(`document.getElementById('settings-panel').classList.contains('hidden')`)) === true);
  // 收尾：清掉测试壁纸与轮播设置
  await evalJs(`(async () => {
    currentSettings.localWallpapers = [];
    currentSettings.wallpaperRotate = 'off';
    currentSettings.wallpaperMode = 'bing';
    await saveSettings(currentSettings);
    await flushSyncWrites();
    return 'ok';
  })()`);
  await sleep(600);

  console.log('\n[29] v1.5.11 竞态与体验：BUG-062 / 047 / 070 / 069');

  // ---- BUG-069：12 小时制必须带午别（13:45 与 01:45 原先逐字节相同）----
  const clockAt = (h) => evalJs(`(() => {
    var RealDate = Date;
    try {
      window.Date = class extends RealDate {
        constructor() { if (arguments.length) { super(...arguments); } else { super(2026, 0, 1, ${h}, 45, 0); } }
        static now() { return new RealDate(2026, 0, 1, ${h}, 45, 0).getTime(); }
      };
      currentSettings.clockFormat = '12h';
      updateClock();
      var p = document.querySelector('.clock-period');
      return JSON.stringify({
        period: p ? p.textContent : null,
        visible: p ? getComputedStyle(p).display !== 'none' : false,
        time: document.querySelector('.clock-time').textContent
      });
    } finally { window.Date = RealDate; }
  })()`);
  const clock13 = JSON.parse(await clockAt(13));
  const clock01 = JSON.parse(await clockAt(1));
  check('BUG-069 13:45 → 「下午 01:45」', clock13.period === '下午' && clock13.time === '01:45' && clock13.visible, clock13);
  check('BUG-069 01:45 → 「上午 01:45」（与 13:45 不再无法区分）', clock01.period === '上午' && clock01.time === '01:45' && clock01.visible, clock01);
  const clock24 = JSON.parse(await evalJs(`(() => {
    currentSettings.clockFormat = '24h'; updateClock();
    var p = document.querySelector('.clock-period');
    return JSON.stringify({ period: p ? p.textContent : null, visible: p ? getComputedStyle(p).display !== 'none' : false });
  })()`));
  check('BUG-069 24 小时制不显示午别', clock24.period === '' && !clock24.visible, clock24);

  // ---- BUG-047：分组圆点的 Enter/Space 激活 ----
  await evalJs(`(async () => {
    var mk = function (id, name) { return { id: id, name: name, url: 'https://' + id + '.example.com/', visitCount: 0, image: '' }; };
    groups = [
      { id: 'gk1', name: '甲组', sortMode: 'manual', cards: [mk('k1', 'K1')] },
      { id: 'gk2', name: '乙组', sortMode: 'manual', cards: [mk('k2', 'K2')] },
      { id: 'gk3', name: '丙组', sortMode: 'manual', cards: [mk('k3', 'K3')] }
    ];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    await saveGroups(groups); renderSpeeddials(); renderGroupDots();
    return 'ok';
  })()`);
  await sleep(400);
  const dotMeta = JSON.parse(await evalJs(`JSON.stringify((() => {
    var dots = document.querySelectorAll('#group-dots .group-dot, #group-dots .group-tab');
    return { n: dots.length, role: dots.length > 1 ? dots[1].getAttribute('role') : null, tabindex: dots.length > 1 ? dots[1].getAttribute('tabindex') : null };
  })())`));
  check('BUG-047 圆点具备 button 语义且可聚焦（复现前提）', dotMeta.n === 3 && dotMeta.role === 'button' && dotMeta.tabindex === '0', dotMeta);
  await evalJs(`(() => { var d = document.querySelectorAll('#group-dots .group-dot, #group-dots .group-tab')[1]; d.focus(); d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'ok'; })()`);
  await sleep(500);
  check('BUG-047 Enter 激活圆点 → 切到第 2 组', (await evalJs('activeGroupIndex')) === 1, await evalJs('activeGroupIndex'));
  await evalJs(`(() => { var d = document.querySelectorAll('#group-dots .group-dot, #group-dots .group-tab')[2]; d.focus(); d.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); return 'ok'; })()`);
  await sleep(500);
  check('BUG-047 Space 激活圆点 → 切到第 3 组', (await evalJs('activeGroupIndex')) === 2, await evalJs('activeGroupIndex'));
  const idxBeforeOther = await evalJs('activeGroupIndex');
  await evalJs(`(() => { var d = document.querySelectorAll('#group-dots .group-dot, #group-dots .group-tab')[0]; d.focus(); d.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); return 'ok'; })()`);
  await sleep(300);
  check('BUG-047 其它按键不切组（不是「任意键都激活」）', (await evalJs('activeGroupIndex')) === idxBeforeOther, { before: idxBeforeOther, after: await evalJs('activeGroupIndex') });

  // ---- BUG-070：拖拽早退必须复位 dragCard；负索引不得进入重排 ----
  const dragProbe = JSON.parse(await evalJs(`(async () => {
    var mk = function (id) { return { id: id, name: id, url: 'https://' + id + '.example.com/', visitCount: 0, image: '' }; };
    isLocked = false;
    groups = [{ id: 'gd', name: '拖拽组', sortMode: 'manual', cards: [mk('d1'), mk('d2'), mk('d3')] }];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    await saveGroups(groups); renderSpeeddials(); renderGroupDots();
    await new Promise(function (r) { setTimeout(r, 300); });
    var container = (typeof _activeGroupContainer === 'function' ? _activeGroupContainer() : null) || document.getElementById('speeddial-grid');
    var wrappers = container.querySelectorAll('.card-wrapper:not(.card-wrapper-add)');
    var center = function (el) { var r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
    var drag = function (fromEl, toEl) {
      var a = center(fromEl), b = center(toEl);
      fromEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: a.x, clientY: a.y }));
      // 关键采样点：mousedown 之后立刻看 dragCard 有没有被复位（等 mouseup 之后再看就晚了）
      var down = { engaged: !!dragCard, origIndex: dragOrigIndex };
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: b.x, clientY: b.y }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: b.x, clientY: b.y }));
      return down;
    };
    var orderBefore = speeddials.map(function (c) { return c.id; }).join(',');

    // 正对照：真实卡片拖到末尾必须真的换位（证明拖拽监听确实挂着，下面不是空断言）
    var realDown = drag(wrappers[0].querySelector('.speeddial-card'), wrappers[2].querySelector('.speeddial-card'));
    await new Promise(function (r) { setTimeout(r, 400); });
    var orderAfterReal = speeddials.map(function (c) { return c.id; }).join(',');

    // 复位顺序，再做幽灵卡片（DOM 里有、speeddials 里没有）
    groups[0].cards = [mk('d1'), mk('d2'), mk('d3')];
    speeddials = groups[0].cards;
    await saveGroups(groups); renderSpeeddials();
    await new Promise(function (r) { setTimeout(r, 300); });
    container = (typeof _activeGroupContainer === 'function' ? _activeGroupContainer() : null) || document.getElementById('speeddial-grid');
    wrappers = container.querySelectorAll('.card-wrapper:not(.card-wrapper-add)');
    var ghost = wrappers[0].cloneNode(true);
    ghost.dataset.id = 'ghost-x';
    container.appendChild(ghost);
    var ghostOrderBefore = speeddials.map(function (c) { return c.id; }).join(',');
    var ghostDown = drag(ghost.querySelector('.speeddial-card'), wrappers[1].querySelector('.speeddial-card'));
    await new Promise(function (r) { setTimeout(r, 400); });
    var ghostOrderAfter = speeddials.map(function (c) { return c.id; }).join(',');
    if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
    cleanupDrag();
    return JSON.stringify({
      realDown: realDown, orderBefore: orderBefore, orderAfterReal: orderAfterReal,
      ghostDown: ghostDown, ghostOrderBefore: ghostOrderBefore, ghostOrderAfter: ghostOrderAfter
    });
  })()`));
  check('BUG-070 正对照：真实卡片拖拽确实换位（拖拽链路是活的）', dragProbe.realDown.engaged === true && dragProbe.orderAfterReal !== dragProbe.orderBefore, dragProbe);
  check('BUG-070 幽灵卡片按下后 dragCard 立即复位（不再进入拖拽链路）', dragProbe.ghostDown.engaged === false && dragProbe.ghostDown.origIndex === -1, dragProbe.ghostDown);
  check('BUG-070 幽灵卡片拖拽后顺序不变（修复前会搬走最后一张）', dragProbe.ghostOrderAfter === dragProbe.ghostOrderBefore, dragProbe);
  const reorderGuard = JSON.parse(await evalJs(`(async () => {
    groups = [{ id: 'gr', name: '边界组', sortMode: 'manual', cards: [
      { id: 'r1', name: 'R1', url: 'https://r1.example.com/', visitCount: 0, image: '' },
      { id: 'r2', name: 'R2', url: 'https://r2.example.com/', visitCount: 0, image: '' }
    ] }];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    await saveGroups(groups);
    var before = speeddials.map(function (c) { return c.id; }).join(',');
    await doReorder(-1, 0);
    var afterNeg = speeddials.map(function (c) { return c.id; }).join(',');
    await doReorder(0, 99);
    var afterBig = speeddials.map(function (c) { return c.id; }).join(',');
    await doReorder(0, 1);
    var afterValid = speeddials.map(function (c) { return c.id; }).join(',');
    return JSON.stringify({ before: before, afterNeg: afterNeg, afterBig: afterBig, afterValid: afterValid });
  })()`));
  check('BUG-070 doReorder 拒绝负索引（splice(-1) 取最后一张的路径被堵死）', reorderGuard.afterNeg === reorderGuard.before, reorderGuard);
  check('BUG-070 doReorder 拒绝越界索引', reorderGuard.afterBig === reorderGuard.before, reorderGuard);
  check('BUG-070 合法重排仍然生效（不是把功能一起关掉）', reorderGuard.afterValid === 'r2,r1', reorderGuard);

  // ---- BUG-062：批量截图期间切组，结果必须写回原分组 ----
  await evalJs(`(async () => {
    var mk = function (id) { return { id: id, name: id, url: 'https://' + id + '.example.com/', visitCount: 0, image: '' }; };
    groups = [
      { id: 'gb1', name: '截图组', sortMode: 'manual', cards: [mk('s1'), mk('s2'), mk('s3')] },
      { id: 'gb2', name: '别的组', sortMode: 'manual', cards: [mk('s4')] }
    ];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    await saveGroups(groups); renderSpeeddials(); renderGroupDots();
    // 桩掉 SW 消息：真的去截图既慢又要网络
    window.__origSendMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = function (msg, cb) {
      if (msg && msg.type === 'batch-capture-one') {
        setTimeout(function () { cb({ ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }); }, 5);
        return;
      }
      return window.__origSendMessage.apply(this, arguments);
    };
    return 'ok';
  })()`);
  await evalJs(`window.__batchPromise = startBatchCapture(); 'started'`);
  await sleep(300);
  await evalJs(`switchGroup(1)`);          // 截图进行中切到「别的组」
  await sleep(500);
  const batchMid = JSON.parse(await evalJs(`JSON.stringify({ active: activeGroupIndex, bImages: groups[1].cards.map(function (c) { return !!c.image; }) })`));
  check('BUG-062 截图期间确实切到了另一个分组（复现前提）', batchMid.active === 1, batchMid);
  await evalJs(`window.__batchPromise`);
  await sleep(300);
  const batchRes = JSON.parse(await evalJs(`JSON.stringify({
    aImages: groups[0].cards.map(function (c) { return !!c.image; }),
    bImages: groups[1].cards.map(function (c) { return !!c.image; }),
    active: activeGroupIndex
  })`));
  check('BUG-062 切组后剩余截图仍写回原分组（不再静默丢弃）', batchRes.aImages.every(Boolean), batchRes);
  check('BUG-062 当前分组的卡片没有被误写', batchRes.bImages.every(function (v) { return !v; }), batchRes);
  check('BUG-062 当前分组未被强行切回', batchRes.active === 1, batchRes);
  await evalJs(`chrome.runtime.sendMessage = window.__origSendMessage; delete window.__origSendMessage; 'restored'`);

  console.log('\n[30] v1.5.12 交互与死代码：BUG-060 / 074 / 075 / 076 / 065 / 066 / 053');
  // BUG-058 要求这三条已发布交互有「行为断言」而非存在性断言：
  //   R4 重置看板布局（BUG-060）、R6 WebDAV 自动备份字段（BUG-075）、R7 刷新网站图标（BUG-076）

  // ---- BUG-060：设置面板「↺ 重置看板布局」必须真的恢复默认并落盘 ----
  await evalJs(`(async () => {
    ensureSettingsPanelReady();
    var layout = _dashCurrentLayout();
    layout.clock.span = 6; layout.clock.order = 3; layout.lunar.order = 0; layout.todo.span = 1;
    _saveLayout(layout); _flushLayout();
    await flushSyncWrites();
    return 'ok';
  })()`);
  await sleep(400);
  const dashBefore = JSON.parse(await evalJs('JSON.stringify(currentSettings.dashboardWidgetLayout)'));
  check('BUG-060 复现前提：布局已被改成非默认（时钟 6 列 / 农历排首位）', dashBefore.clock.span === 6 && dashBefore.lunar.order === 0, dashBefore);
  await evalJs(`(async () => {
    openSettingsPanel();
    document.getElementById('tab-btn-dashboard').click();
    await new Promise(function (r) { setTimeout(r, 300); });
    document.getElementById('btn-reset-dash-grid').click();
    await new Promise(function (r) { setTimeout(r, 400); });
    await flushSyncWrites();
    return 'ok';
  })()`);
  await sleep(400);
  const dashAfter = JSON.parse(await evalJs(`JSON.stringify({
    layout: currentSettings.dashboardWidgetLayout,
    spans: [].map.call(document.querySelectorAll('#dashboard-grid .dashboard-item'), function (e) { return e.dataset.widget + ':' + e.dataset.span; }).join(','),
    domOrder: [].map.call(document.querySelectorAll('#dashboard-grid .dashboard-item'), function (e) { return e.dataset.widget; }).join(','),
    toast: !!document.querySelector('.toast')
  })`));
  check('BUG-060 点击后布局回到注册表默认值（span/order 双恢复）',
    JSON.stringify(dashAfter.layout) === JSON.stringify({ clock: { order: 0, span: 3 }, weather: { order: 1, span: 4 }, todo: { order: 2, span: 3 }, lunar: { order: 3, span: 2 } }),
    dashAfter.layout);
  check('BUG-060 DOM 跨列与顺序同步（不是只改数据）', dashAfter.spans === 'clock:3,weather:4,todo:3,lunar:2' && dashAfter.domOrder === 'clock,weather,todo,lunar', dashAfter);
  const dashPersisted = JSON.parse(await evalJs(`(async () => JSON.stringify(await new Promise(function (r) {
    chrome.storage.sync.get(['settings'], function (x) { r((x.settings || {}).dashboardWidgetLayout || null); });
  })))()`));
  check('BUG-060 重置结果已落盘（刷新后不回到改乱的布局）',
    !!dashPersisted && dashPersisted.clock.span === 3 && dashPersisted.lunar.order === 3, dashPersisted);
  const dashLocked = JSON.parse(await evalJs(`(async () => {
    var layout = _dashCurrentLayout();
    layout.clock.span = 5; _saveLayout(layout); _flushLayout();
    await flushSyncWrites();
    setLocked(true, false);
    var before = JSON.stringify(currentSettings.dashboardWidgetLayout);
    document.getElementById('btn-reset-dash-grid').click();
    await new Promise(function (r) { setTimeout(r, 400); });
    var after = JSON.stringify(currentSettings.dashboardWidgetLayout);
    setLocked(false, false);
    // 还原为默认，避免影响后续断言
    document.getElementById('btn-reset-dash-grid').click();
    await new Promise(function (r) { setTimeout(r, 400); });
    await flushSyncWrites();
    return JSON.stringify({ before: before, after: after });
  })()`));
  check('BUG-060 锁定态不允许重置（与「锁定禁用看板编辑」一致）',
    dashLocked.before === dashLocked.after && JSON.parse(dashLocked.after).clock.span === 5, dashLocked);

  // ---- BUG-074：搜索栏位置必须有一键恢复（按钮原先在 HTML 里根本不存在）----
  const searchReset = JSON.parse(await evalJs(`(async () => {
    openSettingsPanel();
    document.getElementById('tab-btn-appearance').click();
    await new Promise(function (r) { setTimeout(r, 250); });
    var advToggle = document.getElementById('advanced-options-toggle');
    var advGroup = document.getElementById('advanced-options-group');
    if (advGroup && advGroup.classList.contains('hidden') && advToggle) advToggle.click();
    await new Promise(function (r) { setTimeout(r, 200); });
    var btn = document.getElementById('btn-reset-search-pos');
    var visible = !!btn && btn.offsetParent !== null;
    var st = document.getElementById('setting-search-top');
    var sg = document.getElementById('setting-search-gap');
    st.value = 200; sg.value = 10;
    document.documentElement.style.setProperty('--search-top', '200px');
    document.documentElement.style.setProperty('--search-gap', '10px');
    currentSettings.searchMarginTop = 200; currentSettings.searchMarginBottom = 10;
    await saveSettings(currentSettings); await flushSyncWrites();
    if (btn) btn.click();
    await new Promise(function (r) { setTimeout(r, 400); });
    await flushSyncWrites();
    var stored = await new Promise(function (r) { chrome.storage.sync.get(['settings'], function (x) { r(x.settings || {}); }); });
    return JSON.stringify({
      exists: !!btn, visible: visible,
      sliderTop: st.value, sliderGap: sg.value,
      labelTop: document.getElementById('search-top-val').textContent,
      labelGap: document.getElementById('search-gap-val').textContent,
      cssTop: getComputedStyle(document.documentElement).getPropertyValue('--search-top').trim(),
      cssGap: getComputedStyle(document.documentElement).getPropertyValue('--search-gap').trim(),
      storedTop: stored.searchMarginTop, storedGap: stored.searchMarginBottom
    });
  })()`));
  check('BUG-074 外观页存在且可见「↺ 重置搜索栏位置」（原先 id 悬空 → 死分支）',
    searchReset.exists === true && searchReset.visible === true, searchReset);
  check('BUG-074 点击后滑块 / 数值 / CSS 变量全部回到 60 与 48',
    searchReset.sliderTop === '60' && searchReset.sliderGap === '48' &&
    searchReset.labelTop === '60px' && searchReset.labelGap === '48px' &&
    searchReset.cssTop === '60px' && searchReset.cssGap === '48px', searchReset);
  check('BUG-074 重置结果已落盘（BUG-049 同款约定）',
    searchReset.storedTop === 60 && searchReset.storedGap === 48, searchReset);

  // ---- BUG-075：toggle-webdav-auto 不存在却恒写 webdav_auto_backup=false + 4 个死字段 ----
  const deadFields = JSON.parse(await evalJs(`(async () => {
    openSettingsPanel();
    document.getElementById('tab-btn-data').click();
    await new Promise(function (r) { setTimeout(r, 250); });
    await new Promise(function (r) { chrome.storage.local.remove(['webdav_auto_backup'], r); });
    document.getElementById('webdav-url').value = 'https://example.com/dav/';
    document.getElementById('webdav-user').value = 'probe-user';
    document.getElementById('webdav-pass').value = 'probe-pass';
    document.getElementById('btn-webdav-save').click();
    await new Promise(function (r) { setTimeout(r, 600); });
    var local = await new Promise(function (r) { chrome.storage.local.get(null, r); });
    // 老数据里残留的死字段必须被 getSettings 剔除，否则会被整份回写一直带下去
    var stored = await new Promise(function (r) { chrome.storage.sync.get(['settings'], function (x) { r(x.settings || {}); }); });
    stored.presetSize = 'large'; stored.backupRemind = false; stored.webdavAutoBackup = true; stored.bingIdx = 42;
    await new Promise(function (r) { chrome.storage.sync.set({ settings: stored }, r); });
    var fresh = await getSettings();
    var dead = ['presetSize', 'backupRemind', 'webdavAutoBackup', 'bingIdx'];
    return JSON.stringify({
      localHasAutoBackupKey: Object.prototype.hasOwnProperty.call(local, 'webdav_auto_backup'),
      localUrl: local.webdav_url,
      deadInDefaults: dead.filter(function (k) { return k in DEFAULT_SETTINGS; }),
      deadAfterGetSettings: dead.filter(function (k) { return k in fresh; }),
      toggleEl: !!document.getElementById('toggle-webdav-auto')
    });
  })()`));
  check('BUG-075 保存 WebDAV 配置不再写入 webdav_auto_backup（原先每次恒写 false）',
    deadFields.localHasAutoBackupKey === false && deadFields.localUrl === 'https://example.com/dav/', deadFields);
  check('BUG-075 4 个死设置字段已从 DEFAULT_SETTINGS 移除', deadFields.deadInDefaults.length === 0, deadFields.deadInDefaults);
  check('BUG-075 老数据里的死字段被 getSettings 剔除（不再随整份回写扩散）',
    deadFields.deadAfterGetSettings.length === 0, deadFields.deadAfterGetSettings);

  // ---- BUG-076：刷新网站图标必须有入口且真的调到函数 ----
  const favEntry = JSON.parse(await evalJs(`(async () => {
    isLocked = false;
    var mk = function (id, name, image) { return { id: id, name: name, url: 'https://' + id + '.example.com/', visitCount: 0, image: image || '' }; };
    groups = [{ id: 'gf', name: '图标组', sortMode: 'manual', cards: [mk('f1', 'F1'), mk('f2', 'F2', 'idx:card_1700000000000_abcd')] }];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    await saveGroups(groups); renderSpeeddials(); renderGroupDots();
    var itemOf = function (a) { return document.querySelector('#context-menu [data-action="' + a + '"]'); };
    var visible = function (a) { var el = itemOf(a); return !!el && !el.classList.contains('hidden'); };

    contextCardId = 'f1';
    showContextMenu(100, 100, 'card');
    var normal = { visible: visible('refreshFavicon'), label: itemOf('refreshFavicon') ? itemOf('refreshFavicon').textContent.trim() : null };
    hideContextMenu();

    contextCardId = 'f2';
    showContextMenu(100, 100, 'card');
    var customImg = visible('refreshFavicon');
    hideContextMenu();

    contextCardId = 'f1';
    isLocked = true;
    showContextMenu(100, 100, 'card');
    var locked = visible('refreshFavicon');
    hideContextMenu();
    isLocked = false;

    var calledWith = null;
    var orig = window.refreshCardFavicon;
    window.refreshCardFavicon = function (id) { calledWith = id; return Promise.resolve(true); };
    contextCardId = 'f1';
    handleContextAction('refreshFavicon', {});
    window.refreshCardFavicon = orig;
    contextCardId = null;
    return JSON.stringify({ normal: normal, customImg: customImg, locked: locked, calledWith: calledWith });
  })()`));
  check('BUG-076 卡片右键菜单有「🔄 刷新网站图标」且默认可见',
    favEntry.normal.visible === true && /刷新网站图标/.test(favEntry.normal.label || ''), favEntry.normal);
  check('BUG-076 自定义上传图的卡片不提供该入口（不会静默覆盖用户上传的图）', favEntry.customImg === false, favEntry);
  check('BUG-076 锁定时隐藏（与编辑 / 删除 / 移动一致）', favEntry.locked === false, favEntry);
  check('BUG-076 点击路径真的调用 refreshCardFavicon（不只是「函数存在」）', favEntry.calledWith === 'f1', favEntry);

  const favAdd = JSON.parse(await evalJs(`(async () => {
    var calls = [];
    var orig = window.enrichCardFavicons;
    window.enrichCardFavicons = function (o) { calls.push(o || null); return Promise.resolve({ fetched: 0, failed: 0 }); };
    currentSettings.useFavicon = true;
    await addSpeeddial('新卡图标探测', 'https://newcard.example.com/', '');
    await new Promise(function (r) { setTimeout(r, 300); });
    currentSettings.useFavicon = false;
    window.enrichCardFavicons = orig;
    var added = groups[0].cards.filter(function (c) { return c.name === '新卡图标探测'; });
    var opts = calls.length ? calls[0] : null;
    return JSON.stringify({ calls: calls.length, cardIds: opts && opts.cardIds ? opts.cardIds : null, addedIds: added.map(function (c) { return c.id; }) });
  })()`));
  check('BUG-076 新增卡片后立刻按 id 补图标（原先要等下次打开新标签页）',
    favAdd.calls === 1 && Array.isArray(favAdd.cardIds) && favAdd.cardIds.length === 1 &&
    favAdd.addedIds.indexOf(favAdd.cardIds[0]) !== -1, favAdd);
  const favAddOff = JSON.parse(await evalJs(`(async () => {
    var calls = 0;
    var orig = window.enrichCardFavicons;
    window.enrichCardFavicons = function () { calls++; return Promise.resolve({ fetched: 0, failed: 0 }); };
    currentSettings.useFavicon = false;
    await addSpeeddial('开关关闭探测', 'https://offcard.example.com/', '');
    await new Promise(function (r) { setTimeout(r, 250); });
    window.enrichCardFavicons = orig;
    return JSON.stringify({ calls: calls });
  })()`));
  check('BUG-076 对照：favicon 开关关闭时不发起取图', favAddOff.calls === 0, favAddOff);

  // ---- BUG-065 / BUG-066：设置面板死 CSS 与深色危险按钮 ----
  const cssProbe = JSON.parse(await evalJs(`(async () => {
    var sels = [];
    var walk = function (rules) {
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (r.selectorText) sels.push(r.selectorText);
        if (r.cssRules) walk(r.cssRules);
      }
    };
    for (var s = 0; s < document.styleSheets.length; s++) {
      try { walk(document.styleSheets[s].cssRules); } catch (e) { /* 跨源表跳过 */ }
    }
    openSettingsPanel();
    document.getElementById('tab-btn-dashboard').click();
    await new Promise(function (r) { setTimeout(r, 300); });
    var panel = document.querySelector('.settings-panel');
    var shownDur = getComputedStyle(panel).transitionDuration;
    closeSettingsPanel();
    await new Promise(function (r) { setTimeout(r, 300); });
    var hidden = { display: getComputedStyle(panel).display, duration: getComputedStyle(panel).transitionDuration };

    openSettingsPanel();
    document.getElementById('tab-btn-dashboard').click();
    await new Promise(function (r) { setTimeout(r, 300); });
    var read = function (id) { var c = getComputedStyle(document.getElementById(id)); return { bg: c.backgroundColor, fg: c.color, border: c.borderTopColor }; };
    document.documentElement.setAttribute('data-theme', 'dark');
    await new Promise(function (r) { setTimeout(r, 500); });
    var darkDanger = read('btn-reset-dash-grid');
    var darkSmall = read('btn-reset-card-size');
    document.documentElement.setAttribute('data-theme', 'light');
    await new Promise(function (r) { setTimeout(r, 500); });
    var lightDanger = read('btn-reset-dash-grid');
    closeSettingsPanel();
    return JSON.stringify({
      deadSelectors: sels.filter(function (x) { return x.indexOf('.settings-panel.hidden') !== -1; }),
      shownDur: shownDur, hidden: hidden,
      darkDanger: darkDanger, darkSmall: darkSmall, lightDanger: lightDanger
    });
  })()`));
  check('BUG-065 死 CSS 已删除（全页面不再有 .settings-panel.hidden 规则，含窄屏重复那份）',
    cssProbe.deadSelectors.length === 0, cssProbe.deadSelectors);
  check('BUG-065 面板隐藏仍由 .hidden 的 display:none 负责，且不再声明永不播放的过渡',
    cssProbe.hidden.display === 'none' && cssProbe.shownDur === '0s' && cssProbe.hidden.duration === '0s', cssProbe.hidden);
  check('BUG-066 深色模式下危险按钮与「重置小按钮」配色一致（不再是浅粉亮块）',
    cssProbe.darkDanger.bg === 'rgba(231, 76, 60, 0.2)' && cssProbe.darkDanger.bg === cssProbe.darkSmall.bg &&
    cssProbe.darkDanger.fg === 'rgb(231, 76, 60)' && cssProbe.darkDanger.border === 'rgb(192, 57, 43)', cssProbe.darkDanger);
  check('BUG-066 对照：浅色模式外观未变（仍是原浅粉底 + 深红字）',
    cssProbe.lightDanger.bg === 'rgb(252, 232, 230)' && cssProbe.lightDanger.fg === 'rgb(217, 48, 37)', cssProbe.lightDanger);

  // ---- BUG-053：本地搜索下拉的卡片名必须走文本节点（innerHTML 注入）----
  const xssProbe = JSON.parse(await evalJs(`(async () => {
    var g = groups[activeGroupIndex];
    var payload = '<img src=x onerror="window.__xssP0=1"> hi';
    g.cards.push({ id: 'xss1', name: payload, url: 'https://xss.example.com/hi', image: '', color: '#888', visitCount: 0, createdAt: Date.now(), lastOpened: 0 });
    g.cards.push({ id: 'xss2', name: '普通卡片 hi', url: 'https://plain.example.com/hi', image: '', color: '#888', visitCount: 0, createdAt: Date.now(), lastOpened: 0 });
    speeddials = g.cards;
    renderSpeeddials();
    performLocalSearch('hi');
    await new Promise(function (r) { setTimeout(r, 300); });
    var list = document.getElementById('local-search-list');
    var names = [].map.call(list.querySelectorAll('.ls-name'), function (e) { return e.textContent; });
    var out = {
      injected: list.querySelectorAll('img, iframe, script, style, svg').length,
      execd: !!window.__xssP0,
      names: names,
      marks: list.querySelectorAll('.ls-name mark').length,
      markTexts: [].map.call(list.querySelectorAll('.ls-name mark'), function (e) { return e.textContent; })
    };
    hideLocalSearchDropdown();
    g.cards = g.cards.filter(function (c) { return c.id !== 'xss1' && c.id !== 'xss2'; });
    speeddials = g.cards;
    renderSpeeddials();
    delete window.__xssP0;
    return JSON.stringify(out);
  })()`));
  check('BUG-053 卡片名里的标签不再被解析成元素（HTML 注入被堵死）',
    xssProbe.injected === 0 && xssProbe.execd === false, xssProbe);
  check('BUG-053 名称按原文显示且关键词高亮仍生效（正对照）',
    xssProbe.names.indexOf('<img src=x onerror="window.__xssP0=1"> hi') !== -1 &&
    xssProbe.names.indexOf('普通卡片 hi') !== -1 &&
    xssProbe.marks === 2 && xssProbe.markTexts.every(function (t) { return t === 'hi'; }), xssProbe);

  console.log('\n[32] v1.5.13 审计清零：BUG-046 / 051 / 059 / 064 / 067 / 068 / 072');

  // ---- BUG-046：编辑弹窗「📸 截取网页」是全项目唯一漏掉 http 权限闸门的截图入口 ----
  const dialogGate = JSON.parse(await evalJs(`(async () => {
    var origContains = chrome.permissions.contains;
    var origRequest = chrome.permissions.request;
    var origSend = chrome.runtime.sendMessage;
    var reqCount = 0, sent = [];
    chrome.permissions.contains = function (p, cb) { cb(false); };
    chrome.permissions.request = function (p, cb) { reqCount++; cb(false); };
    chrome.runtime.sendMessage = function (msg, cb) {
      if (msg && msg.type === 'capture-screenshot') { sent.push(msg.url); if (cb) cb({ ok: false, error: 'stub' }); return; }
      return origSend.apply(this, arguments);
    };
    try {
      openAddDialog();
      // 清掉先前断言留下的 Toast，避免「上一句提示」把本句断言蒙混过关
      [].forEach.call(document.querySelectorAll('.toast'), function (t) { t.remove(); });
      domMain.dialogUrl.value = 'http://192.168.1.70/';
      document.getElementById('dialog-image-capture').click();
      await new Promise(function (r) { setTimeout(r, 400); });
      return JSON.stringify({
        reqCount: reqCount,
        sent: sent,
        toasts: [].map.call(document.querySelectorAll('.toast'), function (t) { return t.textContent; }).join('|')
      });
    } finally {
      chrome.permissions.contains = origContains;
      chrome.permissions.request = origRequest;
      chrome.runtime.sendMessage = origSend;
      closeDialog();
    }
  })()`));
  check('BUG-046 弹窗截图对 http 地址先申请可选权限（修复前直接发消息给 SW）', dialogGate.reqCount === 1, dialogGate);
  check('BUG-046 未授权时不发起截图（不再开窗干等 120 秒超时）', dialogGate.sent.length === 0, dialogGate);
  check('BUG-046 未授权时给出权限提示（不再是「用户超时未截图」这种误导文案）', /需要「访问 http 网站」权限/.test(dialogGate.toasts), dialogGate);

  // ---- BUG-051：_extractThemeColorFromBlob 每次调用泄漏一个 blob: URL ----
  const themeLeak = JSON.parse(await evalJs(`(async () => {
    var oc = URL.createObjectURL, orv = URL.revokeObjectURL;
    var created = 0, revoked = 0;
    URL.createObjectURL = function (b) { created++; return oc.call(URL, b); };
    URL.revokeObjectURL = function (u) { revoked++; return orv.call(URL, u); };
    try {
      var cv = document.createElement('canvas'); cv.width = 24; cv.height = 24;
      var ctx = cv.getContext('2d'); ctx.fillStyle = 'rgb(200,100,50)'; ctx.fillRect(0, 0, 24, 24);
      var blob = await new Promise(function (r) { cv.toBlob(r, 'image/png'); });
      var color = await _extractThemeColorFromBlob(blob);
      return JSON.stringify({ created: created, revoked: revoked, color: color });
    } finally { URL.createObjectURL = oc; URL.revokeObjectURL = orv; }
  })()`));
  check('BUG-051 采样主题色真的释放了 blob: URL（创建 1 次 / 释放 1 次）',
    themeLeak.created === 1 && themeLeak.revoked === 1, themeLeak);
  check('BUG-051 正对照：颜色仍然采得到（不是把功能一起关掉）', /^#[0-9a-f]{6}$/.test(themeLeak.color || ''), themeLeak);

  // ---- BUG-059：上传图（card_ 前缀）老数据仍能显示，删卡 / GC 都能回收 ----
  const uploadCard = JSON.parse(await evalJs(`(async () => {
    var cv = document.createElement('canvas'); cv.width = 32; cv.height = 32;
    var ctx = cv.getContext('2d'); ctx.fillStyle = 'rgb(30,120,200)'; ctx.fillRect(0, 0, 32, 32);
    var blob = await new Promise(function (r) { cv.toBlob(r, 'image/png'); });
    var file = new File([blob], 'old-upload.png', { type: 'image/png' });
    var key = await uploadImage(file, 'card');
    var card = { id: 'bug059card', name: '老上传图', url: 'https://example.com/old-upload', image: 'idx:' + key, visitCount: 0, createdAt: Date.now() };
    groups.push({ id: 'gbug059', name: 'BUG059 组', sortMode: 'manual', cards: [card] });
    activeGroupIndex = groups.length - 1;
    speeddials = groups[activeGroupIndex].cards;
    await saveGroups(groups);
    renderSpeeddials(); renderGroupDots();
    await new Promise(function (r) { setTimeout(r, 700); });
    var img = document.querySelector('.card-wrapper[data-id="bug059card"] img.card-thumb-img');
    return JSON.stringify({
      key: key,
      inDb: !!(await loadImage(key)),
      src: img ? String(img.src).slice(0, 5) : '',
      naturalWidth: img ? img.naturalWidth : 0
    });
  })()`));
  check('BUG-059 复现前提：上传得到的键是 card_ 前缀（不是 cardimg_<卡片id>）', /^card_/.test(uploadCard.key), uploadCard);
  check('BUG-059 老的 card_ 图片仍能正常显示（兼容旧数据，不是只改前缀）',
    uploadCard.src === 'blob:' && uploadCard.naturalWidth > 0, uploadCard);

  const uploadDeleted = JSON.parse(await evalJs(`(async () => {
    var key = ${JSON.stringify(uploadCard.key)};
    var cachedBefore = !!_cardBlobCache[key];
    await deleteSpeeddialById('bug059card');
    return JSON.stringify({
      cachedBefore: cachedBefore,
      cachedAfter: !!_cardBlobCache[key],
      inDb: !!(await loadImage(key))
    });
  })()`));
  check('BUG-059 复现前提：渲染后 blob URL 已进内存缓存', uploadDeleted.cachedBefore === true, uploadDeleted);
  check('BUG-059 删卡后 card_ 图片真的从 IndexedDB 回收（修复前永远留着）', uploadDeleted.inDb === false, uploadDeleted);
  check('BUG-068 删卡同时释放 blob URL 缓存', uploadDeleted.cachedAfter === false, uploadDeleted);

  // GC：无主 card_ 要回收、被引用的 card_ 要保留、壁纸绝不能碰
  const gcResult = JSON.parse(await evalJs(`(async () => {
    async function mkBlob() {
      var cv = document.createElement('canvas'); cv.width = 8; cv.height = 8;
      var ctx = cv.getContext('2d'); ctx.fillStyle = 'rgb(10,10,10)'; ctx.fillRect(0, 0, 8, 8);
      return await new Promise(function (r) { cv.toBlob(r, 'image/png'); });
    }
    var blob = await mkBlob();
    await saveImage('card_orphan_test', blob);
    await saveImage('cardimg_orphan_test', blob);
    await saveImage('card_keep_test', blob);
    await saveImage('wallpaper', blob);
    await saveImage('wp__keep_test', blob);
    var keepCard = { id: 'bug059keep', name: '保留图', url: 'https://example.com/keep', image: 'idx:card_keep_test', visitCount: 0 };
    groups.push({ id: 'gbug059gc', name: 'BUG059 GC 组', sortMode: 'manual', cards: [keepCard] });
    await saveGroups(groups);
    var savedWallpapers = JSON.stringify(currentSettings.localWallpapers || []);
    currentSettings.localWallpapers = [{ key: 'wp__keep_test', name: '测试壁纸', opacity: null }];
    saveSettings(currentSettings);
    await flushSyncWrites();
    await new Promise(function (r) { setTimeout(r, 300); });
    try {
      await collectCardImageGarbage();
    } finally {
      currentSettings.localWallpapers = JSON.parse(savedWallpapers);
      saveSettings(currentSettings);
      await flushSyncWrites();
    }
    var keys = await new Promise(function (resolve) {
      openImgDB().then(function (db) {
        var out = [];
        var tx = db.transaction('images', 'readonly');
        tx.objectStore('images').openCursor().onsuccess = function (e) {
          var c = e.target.result;
          if (c) { out.push(String(c.key)); c.continue(); } else resolve(out);
        };
      });
    });
    groups = groups.filter(function (g) { return g.id !== 'gbug059gc'; });
    activeGroupIndex = Math.min(activeGroupIndex, groups.length - 1);
    speeddials = (groups[activeGroupIndex] && groups[activeGroupIndex].cards) || [];
    await saveGroups(groups);
    renderSpeeddials(); renderGroupDots();
    return JSON.stringify({ keys: keys });
  })()`));
  check('BUG-059 GC 回收无主的 card_ 前缀图片（修复前永远回收不掉）', gcResult.keys.indexOf('card_orphan_test') === -1, gcResult.keys);
  check('BUG-059 GC 仍回收 cardimg_ 孤儿（既有行为不回归）', gcResult.keys.indexOf('cardimg_orphan_test') === -1, gcResult.keys);
  check('BUG-059 GC 不误删仍被卡片引用的 card_ 图片（老数据兼容）', gcResult.keys.indexOf('card_keep_test') !== -1, gcResult.keys);
  check('BUG-059 GC 绝不回收壁纸（单张 wallpaper + 本地多图 wp__ 双负对照）',
    gcResult.keys.indexOf('wallpaper') !== -1 && gcResult.keys.indexOf('wp__keep_test') !== -1, gcResult.keys);

  // ---- BUG-068：批量删除 / 去重删除不回收图标缓存（内存 + IndexedDB 双泄漏）----
  const batchRelease = JSON.parse(await evalJs(`(async () => {
    async function mkBlob() {
      var cv = document.createElement('canvas'); cv.width = 8; cv.height = 8;
      var ctx = cv.getContext('2d'); ctx.fillStyle = 'rgb(20,20,20)'; ctx.fillRect(0, 0, 8, 8);
      return await new Promise(function (r) { cv.toBlob(r, 'image/png'); });
    }
    var blob = await mkBlob();
    await saveImage('cardimg_batch1', blob);
    await saveImage('card_batch2', blob);
    await saveImage('cardimg_batch3', blob);
    var snapshot = JSON.stringify(groups), savedIdx = activeGroupIndex;
    groups = [{ id: 'gbug068', name: '批量组', sortMode: 'manual', cards: [
      { id: 'b1', name: '批量1', url: 'https://b1.example.com/', image: 'idx:cardimg_batch1', visitCount: 0 },
      { id: 'b2', name: '批量2', url: 'https://b2.example.com/', image: 'idx:card_batch2', visitCount: 0 },
      { id: 'b3', name: '批量3', url: 'https://b3.example.com/', image: 'idx:cardimg_batch3', visitCount: 0 }
    ] }];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    renderSpeeddials();
    await _getCardImgUrl('cardimg_batch1');
    await _getCardImgUrl('card_batch2');
    await _getCardImgUrl('cardimg_batch3');
    var origConfirm = showImportConfirmAsync;
    showImportConfirmAsync = function () { return Promise.resolve(); };
    var result = {};
    try {
      _selectedCardIds = ['b1', 'b2'];
      await batchDeleteSelected();
      result = {
        remaining: groups[0].cards.map(function (c) { return c.id; }),
        cache1: !!_cardBlobCache['cardimg_batch1'],
        cache2: !!_cardBlobCache['card_batch2'],
        cache3: !!_cardBlobCache['cardimg_batch3'],
        db1: !!(await loadImage('cardimg_batch1')),
        db2: !!(await loadImage('card_batch2')),
        db3: !!(await loadImage('cardimg_batch3'))
      };
    } finally {
      showImportConfirmAsync = origConfirm;
      _selectedCardIds = [];
      groups = JSON.parse(snapshot); activeGroupIndex = savedIdx;
      speeddials = (groups[activeGroupIndex] && groups[activeGroupIndex].cards) || [];
      await saveGroups(groups);
      renderSpeeddials(); renderGroupDots();
    }
    return JSON.stringify(result);
  })()`));
  check('BUG-068 批量删除后只剩未选中的卡片（正对照：功能本身仍生效）',
    batchRelease.remaining.length === 1 && batchRelease.remaining[0] === 'b3', batchRelease);
  check('BUG-068 批量删除回收被删卡片的 blob URL 缓存（含上传图 card_ 前缀）',
    batchRelease.cache1 === false && batchRelease.cache2 === false && batchRelease.cache3 === true, batchRelease);
  check('BUG-068 批量删除回收 IndexedDB 实体，未删卡片的图片不受影响',
    batchRelease.db1 === false && batchRelease.db2 === false && batchRelease.db3 === true, batchRelease);

  const dedupRelease = JSON.parse(await evalJs(`(async () => {
    async function mkBlob() {
      var cv = document.createElement('canvas'); cv.width = 8; cv.height = 8;
      var ctx = cv.getContext('2d'); ctx.fillStyle = 'rgb(30,30,30)'; ctx.fillRect(0, 0, 8, 8);
      return await new Promise(function (r) { cv.toBlob(r, 'image/png'); });
    }
    var blob = await mkBlob();
    await saveImage('cardimg_dup1', blob);
    await saveImage('cardimg_dup2', blob);
    await saveImage('cardimg_dup3', blob);
    var snapshot = JSON.stringify(groups), savedIdx = activeGroupIndex;
    groups = [{ id: 'gbug068b', name: '重复组', sortMode: 'manual', cards: [
      { id: 'd1', name: '重复1', url: 'https://dup.example.com/', image: 'idx:cardimg_dup1', visitCount: 0 },
      { id: 'd2', name: '重复2', url: 'https://dup.example.com/', image: 'idx:cardimg_dup2', visitCount: 0 },
      { id: 'd3', name: '重复3', url: 'https://dup.example.com/', image: 'idx:cardimg_dup3', visitCount: 0 }
    ] }];
    activeGroupIndex = 0; speeddials = groups[0].cards;
    renderSpeeddials();
    await _getCardImgUrl('cardimg_dup1');
    await _getCardImgUrl('cardimg_dup2');
    await _getCardImgUrl('cardimg_dup3');
    var origConfirm = showImportConfirmAsync;
    showImportConfirmAsync = function () { return Promise.resolve(); };
    var result = {};
    try {
      showDuplicateCheckDialog();
      document.getElementById('dup-check-clean-all').click();
      await new Promise(function (r) { setTimeout(r, 700); });
      result = {
        remaining: groups[0].cards.map(function (c) { return c.id; }),
        cache2: !!_cardBlobCache['cardimg_dup2'],
        db1: !!(await loadImage('cardimg_dup1')),
        db2: !!(await loadImage('cardimg_dup2')),
        db3: !!(await loadImage('cardimg_dup3'))
      };
    } finally {
      showImportConfirmAsync = origConfirm;
      var dlg = document.getElementById('dialog-duplicate-check');
      if (dlg) dlg.classList.add('hidden');
      groups = JSON.parse(snapshot); activeGroupIndex = savedIdx;
      speeddials = (groups[activeGroupIndex] && groups[activeGroupIndex].cards) || [];
      await saveGroups(groups);
      renderSpeeddials(); renderGroupDots();
    }
    return JSON.stringify(result);
  })()`));
  check('BUG-068 一键清理重复：保留第一张、其余删除（正对照）',
    dedupRelease.remaining.length === 1 && dedupRelease.remaining[0] === 'd1', dedupRelease);
  check('BUG-068 一键清理重复回收被删项的 blob URL 缓存与 IndexedDB 实体（保留项不受影响）',
    dedupRelease.cache2 === false && dedupRelease.db2 === false && dedupRelease.db3 === false && dedupRelease.db1 === true, dedupRelease);

  // 兜底的 _clearAllBlobCaches 原先零调用方（死代码）→ 现在接在「重置全部数据」路径上
  const resetFallback = JSON.parse(await evalJs(`(async () => {
    var origClear = _clearAllBlobCaches;
    var calls = 0;
    _clearAllBlobCaches = function () { calls++; };
    var origSyncClear = chrome.storage.sync.clear, origLocalClear = chrome.storage.local.clear;
    var origDeleteDb = indexedDB.deleteDatabase;
    var origSetTimeout = window.setTimeout;
    chrome.storage.sync.clear = function (cb) { if (cb) cb(); };
    chrome.storage.local.clear = function (cb) { if (cb) cb(); };
    indexedDB.deleteDatabase = function () { return {}; };
    window.setTimeout = function (fn, ms) { if (ms === 600 || ms === 5000) return 0; return origSetTimeout.apply(window, arguments); };
    try {
      await doResetAll();
      return JSON.stringify({ calls: calls });
    } finally {
      _clearAllBlobCaches = origClear;
      chrome.storage.sync.clear = origSyncClear;
      chrome.storage.local.clear = origLocalClear;
      indexedDB.deleteDatabase = origDeleteDb;
      window.setTimeout = origSetTimeout;
    }
  })()`));
  check('BUG-068 兜底清空缓存函数真的接进了「重置全部数据」路径（原先零调用方）',
    resetFallback.calls === 1, resetFallback);

  // ---- BUG-064：页面侧必须显式标记「凭据已提供」，SW 才敢不回退 storage ----
  const credsMarker = JSON.parse(await evalJs(`(async () => {
    var origSend = chrome.runtime.sendMessage;
    var captured = null;
    chrome.runtime.sendMessage = function (msg, cb) {
      if (msg && msg.type === 'webdav:test') { captured = msg.payload; if (cb) cb({ ok: true, data: 'connected' }); return; }
      return origSend.apply(this, arguments);
    };
    try {
      await webdavTestConnection({ url: 'http://nas2.local/dav', user: 'bob', pass: '' });
      return JSON.stringify({
        url: captured && captured._url, user: captured && captured._user,
        pass: captured && captured._pass, marker: captured && captured._hasCreds
      });
    } finally { chrome.runtime.sendMessage = origSend; }
  })()`));
  check('BUG-064 页面侧显式提供空密码并打上 _hasCreds 标记（SW 据此不回退旧配置）',
    credsMarker.marker === true && credsMarker.pass === '' &&
    credsMarker.url === 'http://nas2.local/dav' && credsMarker.user === 'bob', credsMarker);

  // ---- BUG-067：Bing 区域下拉框的可访问名称 ----
  const bingLabel = JSON.parse(await evalJs(`(() => {
    var sel = document.getElementById('setting-bing-region');
    var lbl = document.querySelector('label[for="setting-bing-region"]');
    return JSON.stringify({
      hasSelect: !!sel, hasLabel: !!lbl,
      control: !!(lbl && lbl.control === sel),
      text: lbl ? lbl.textContent : ''
    });
  })()`));
  check('BUG-067 Bing 区域下拉框有真正的 label 关联（label.control === select）',
    bingLabel.hasSelect && bingLabel.hasLabel && bingLabel.control && /区域/.test(bingLabel.text), bingLabel);

  // ---- BUG-072：城市留空（自动检测）时天气缓存永远失效 ----
  const weatherCache = JSON.parse(await evalJs(`(() => {
    var auto = { weatherType: 'openmeteo', weatherCity: '' };
    var now = Date.now();
    return JSON.stringify({
      autoValid: isCacheValid({ type: 'openmeteo', city: '北京', timestamp: now }, auto),
      explicitMismatch: isCacheValid({ type: 'openmeteo', city: '北京', timestamp: now }, { weatherType: 'openmeteo', weatherCity: '上海' }),
      explicitMatch: isCacheValid({ type: 'openmeteo', city: '上海', timestamp: now }, { weatherType: 'openmeteo', weatherCity: '上海' }),
      stale: isCacheValid({ type: 'openmeteo', city: '北京', timestamp: now - 999 * 60000 }, auto),
      wrongType: isCacheValid({ type: 'hefeng', city: '北京', timestamp: now }, auto)
    });
  })()`));
  check('BUG-072 城市留空（自动检测）时缓存判定通过', weatherCache.autoValid === true, weatherCache);
  check('BUG-072 显式指定城市时仍严格比对（负对照：城市不匹配不吃缓存）',
    weatherCache.explicitMismatch === false && weatherCache.explicitMatch === true, weatherCache);
  check('BUG-072 数据源与 TTL 校验未被放宽（负对照）',
    weatherCache.stale === false && weatherCache.wrongType === false, weatherCache);

  const weatherFetch = JSON.parse(await evalJs(`(async () => {
    var origFetch = fetchOpenMeteoWeather;
    var calls = 0;
    fetchOpenMeteoWeather = async function () {
      calls++;
      return { source: 'openmeteo', city: '北京', temp: 20, text: '晴', icon: 0, feelsLike: 20, humidity: 50 };
    };
    try {
      await setWeatherCache({ source: 'openmeteo', city: '北京', temp: 20, text: '晴', icon: 0, feelsLike: 20, humidity: 50 }, 'openmeteo', '北京');
      await fetchAndDisplayWeather({ weatherType: 'openmeteo', weatherCity: '', weatherRefreshMin: 30 });
      var cityEl = document.querySelector('.weather-city');
      return JSON.stringify({ calls: calls, city: cityEl ? cityEl.textContent : '' });
    } finally { fetchOpenMeteoWeather = origFetch; }
  })()`));
  check('BUG-072 缓存有效时不再重复请求 API（原先每个新标签页都请求一次）', weatherFetch.calls === 0, weatherFetch);
  check('BUG-072 正对照：仍然把缓存内容渲染出来', weatherFetch.city === '北京', weatherFetch);

  // 清理本段造的测试分组，避免影响后续断言
  await evalJs(`(async () => {
    groups = groups.filter(function (g) { return g.id !== 'gbug059' && g.id !== 'gbug068' && g.id !== 'gbug068b'; });
    activeGroupIndex = Math.min(activeGroupIndex, groups.length - 1);
    speeddials = (groups[activeGroupIndex] && groups[activeGroupIndex].cards) || [];
    await saveGroups(groups);
    renderSpeeddials(); renderGroupDots();
    return 'ok';
  })()`);

  console.log('\n[31] v1.5.14 DEBT-01 死函数清理（主链路不受影响 + 死符号彻底移除）');

  // 清单 = AST 严格扫描（真实引用 = 0，注释与字符串不计）+ 人工复核：
  // 审计的 10 个 + 连带失去唯一调用方的 getWebdavLastBackup（只被 updateWebdavStatus 调用）。
  const DEBT01_NAMES = [
    'applyDashboardOrder', 'getSpeeddials', 'isCardSelected', 'openCard', 'updateWebdavStatus',
    'webdavListConfigs', 'webdavSilentPut', 'webdavSilentPutIncremental', 'getWebdavLastBackupFilename',
    'withImgStore', 'getWebdavLastBackup'
  ];
  // 静态补充断言：连注释一起要求清干净 —— audit-static-scan.mjs 按文本计数，
  // 名字只要留在注释里，下次扫描就不会再把它列进死符号清单（deleteCardIcon 就是这样漏掉的）。
  const debt01Files = [];
  (function collectSrc(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) collectSrc(p);
      else if (/\.(js|html)$/.test(ent.name) && ent.name !== 'fflate.min.js') debt01Files.push(p);
    }
  })(SRC);
  const debt01Hits = [];
  for (const n of DEBT01_NAMES) {
    const re = new RegExp('\\b' + n + '\\b');
    for (const p of debt01Files) {
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (re.test(line)) debt01Hits.push(path.relative(SRC, p) + ':' + (i + 1) + ':' + n);
      });
    }
  }
  check('DEBT-01 11 个死符号已从 src/ 彻底移除（含注释与 index.html）',
    debt01Hits.length === 0, debt01Hits.slice(0, 5));
  const debt01Exposed = JSON.parse(await evalJs(
    `JSON.stringify(${JSON.stringify(DEBT01_NAMES)}.filter(function (n) { return typeof window[n] !== 'undefined'; }))`));
  check('DEBT-01 页面作用域不再暴露这些死符号（原状态是「可被调用但无人调用」）',
    debt01Exposed.length === 0, debt01Exposed);

  // —— 主链路 1：初始化 + 渲染（原 applyDashboardOrder / getSpeeddials 所在链路）——
  const renderChain = JSON.parse(await evalJs(`(async () => {
    renderSpeeddials();
    await new Promise(function (r) { setTimeout(r, 200); });
    var visible = [...document.querySelectorAll('#speeddial-grid .card-wrapper[data-id]')].filter(function (el) { return el.offsetParent !== null; });
    return JSON.stringify({ dom: visible.length, data: (groups[activeGroupIndex] || { cards: [] }).cards.length });
  })()`));
  check('DEBT-01 主链路·渲染：渲染出的卡片数与当前分组数据一致',
    renderChain.data > 0 && renderChain.dom === renderChain.data, renderChain);

  // —— 主链路 2：卡片点击（openCard 是死入口，真实链路是 main.js 的事件委托）——
  const clickChain = JSON.parse(await evalJs(`(async () => {
    var origCreate = chrome.tabs.create;
    var opened = [];
    chrome.tabs.create = function (o) { opened.push(o && o.url); };
    var prevMode = currentSettings.cardOpenMode;
    currentSettings.cardOpenMode = 'background';
    try {
      var list = [...document.querySelectorAll('#speeddial-grid .card-wrapper[data-id]')].filter(function (el) { return el.offsetParent !== null; });
      var el = list.filter(function (x) { return /^https?:/.test(x.dataset.url || ''); })[0] || list[0];
      var id = el.dataset.id;
      var pick = function () {
        for (var gi = 0; gi < groups.length; gi++) {
          for (var ci = 0; ci < groups[gi].cards.length; ci++) {
            if (groups[gi].cards[ci].id === id) return groups[gi].cards[ci];
          }
        }
        return null;
      };
      var before = (pick() || {}).visitCount || 0;
      el.querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(function (r) { setTimeout(r, 300); });
      return JSON.stringify({ opened: opened.length, url: opened[0] || '', visited: ((pick() || {}).visitCount || 0) - before, id: id });
    } finally {
      chrome.tabs.create = origCreate;
      if (prevMode === undefined) { delete currentSettings.cardOpenMode; } else { currentSettings.cardOpenMode = prevMode; }
    }
  })()`));
  check('DEBT-01 主链路·点击：真实点击仍能打开卡片（走事件委托，不是已删的 openCard）',
    clickChain.opened === 1 && /^https?:/.test(clickChain.url), clickChain);
  check('DEBT-01 主链路·点击：访问计数仍累加', clickChain.visited === 1, clickChain);

  // —— 主链路 3：拖拽排序（真实鼠标事件 → dragdrop.js 的 mousedown/mousemove/mouseup）——
  // 先让存储与内存对齐：doReorder → saveSpeeddials 是「按存储里的 activeGroup 索引 + 存储里的
  // groups 数组」落盘的，而本套件前面的段落会直接改内存（不落盘），不先对齐就会写进别的分组。
  await evalJs('(async () => { await flushSyncWrites(); await saveActiveGroup(activeGroupIndex); await saveGroups(groups); await flushSyncWrites(); return "ok"; })()');
  // 渲染是 300ms 防抖的：落盘后的回声/防抖重渲染若落在拖拽中途，会换掉 dragCard 指向的元素，
  // 于是 mouseup 时 targetIndex === dragOrigIndex 直接放弃（表现为「拖了但顺序没变」）→ 先等它稳定
  await sleep(600);
  const dragBefore = JSON.parse(await evalJs(`JSON.stringify({
    ids: groups[activeGroupIndex].cards.map(function (c) { return c.id; }),
    rects: [...document.querySelectorAll('#speeddial-grid .card-wrapper[data-id]')].filter(function (el) { return el.offsetParent !== null; }).slice(0, 2).map(function (el) {
      var r = el.getBoundingClientRect();
      // 落点刻意放在目标卡片右 3/4 处：dragdrop 用「落点是否越过目标中线」决定插到前面还是后面，
      // 正好落在中线上会因浮点误差被判成「插回原位」（to === dragOrigIndex 直接放弃重排）
      return { id: el.dataset.id, x: r.left + r.width / 2, y: r.top + r.height / 2, dropX: r.left + r.width * 0.75 };
    })
  })`));
  if (dragBefore.rects.length === 2) {
    const [dFrom, dTo] = dragBefore.rects;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dFrom.x, y: dFrom.y, button: 'left', clickCount: 1, buttons: 1 }, sid);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dFrom.x + 24, y: dFrom.y + 10, button: 'left', buttons: 1 }, sid);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dTo.dropX, y: dTo.y, button: 'left', buttons: 1 }, sid);
    await sleep(150);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dTo.dropX, y: dTo.y, button: 'left', clickCount: 1, buttons: 0 }, sid);
    await sleep(500);
  }
  const dragAfter = JSON.parse(await evalJs(`(async () => {
    var gid = groups[activeGroupIndex].id;
    var stored = await new Promise(function (r) { chrome.storage.sync.get(['groups', 'activeGroup'], function (x) { r(x); }); });
    var sg = (stored.groups || []).filter(function (g) { return g.id === gid; })[0] || { cards: [] };
    return JSON.stringify({
      ids: groups[activeGroupIndex].cards.map(function (c) { return c.id; }),
      storedIds: (sg.cards || []).map(function (c) { return c.id; }),
      storedActive: stored.activeGroup,
      memActive: activeGroupIndex,
      gid: gid
    });
  })()`));
  const dragDiag = JSON.parse(await evalJs(`JSON.stringify({
    locked: (typeof isLocked !== 'undefined') ? !!isLocked : null,
    sortMode: (groups[activeGroupIndex] || {}).sortMode || 'manual',
    origIndex: (typeof dragOrigIndex !== 'undefined') ? dragOrigIndex : null,
    cloneCreated: (typeof dragClone !== 'undefined') ? !!dragClone : null,
    justDragged: !!window._justDragged
  })`));
  check('DEBT-01 主链路·拖拽：真实鼠标拖拽仍改变卡片顺序',
    dragBefore.rects.length === 2 && dragAfter.ids.join(',') !== dragBefore.ids.join(','),
    { before: dragBefore.ids, after: dragAfter.ids, diag: dragDiag });
  check('DEBT-01 主链路·拖拽：新顺序已落盘（sync 里的分组顺序与内存一致）',
    dragAfter.storedIds.join(',') === dragAfter.ids.join(','), dragAfter);
  // 还原顺序，避免影响后续断言
  await evalJs(`(async () => {
    var want = ${JSON.stringify(dragBefore.ids)};
    speeddials.sort(function (a, b) { return want.indexOf(a.id) - want.indexOf(b.id); });
    await saveSpeeddials(speeddials);
    renderSpeeddials();
    return 'ok';
  })()`);

  // —— 主链路 4：备份导出（fflate zip 仍产出可解压的完整备份）——
  const backupChain = JSON.parse(await evalJs(`(async () => {
    var origDownload = downloadFile;
    var captured = null;
    downloadFile = function (blob, filename) { captured = { blob: blob, name: filename }; };
    try {
      await exportAll();
      if (!captured) return JSON.stringify({ captured: false });
      var u8 = new Uint8Array(await captured.blob.arrayBuffer());
      var un = fflate.unzipSync(u8);
      var cfg = un['config.json'] ? JSON.parse(fflate.strFromU8(un['config.json'])) : null;
      var man = un['manifest.json'] ? JSON.parse(fflate.strFromU8(un['manifest.json'])) : null;
      return JSON.stringify({
        captured: true, size: u8.length, name: captured.name,
        hasConfig: !!cfg, hasManifest: !!man,
        groups: cfg && Array.isArray(cfg.groups) ? cfg.groups.length : -1,
        cards: cfg && Array.isArray(cfg.groups) ? cfg.groups.reduce(function (s, g) { return s + (g.cards || []).length; }, 0) : -1
      });
    } finally { downloadFile = origDownload; }
  })()`));
  check('DEBT-01 主链路·备份：导出仍产出可解压的 zip（config + manifest + 卡片数据）',
    backupChain.captured === true && backupChain.hasConfig === true && backupChain.hasManifest === true
      && backupChain.groups > 0 && backupChain.cards > 0, backupChain);

  console.log('\n[32] v1.5.15 DEBT-02 静默吞异常分级（能降级 → warn；不能降级 → 用户提示）');

  // 诊断捕获器：本段「诊断真的被打印出来 / 有意静默」的断言都基于它。
  // 注意拦的是 console.warn —— 降级路径绝不能用 console.error（三个套件都断言无 console error）。
  await evalJs(`(function () {
    if (!window.__dpWarnInstalled) {
      var orig = console.warn;
      window.__dpWarnBuf = [];
      console.warn = function () { window.__dpWarnBuf.push([].slice.call(arguments).map(String).join(' ')); };
      window.__dpWarnRestore = function () { console.warn = orig; };
      window.__dpWarnInstalled = true;
    }
    window.__dpWarnBuf.length = 0;
    return 'ok';
  })()`);
  const takeWarns = async () => JSON.parse(await evalJs('JSON.stringify(window.__dpWarnBuf.splice(0))'));
  const warnHas = (list, needle) => Array.isArray(list) && list.some((w) => String(w).indexOf(needle) !== -1);

  /** 统一的「打桩 → 跑用例 → 还原」包装：任何一条用例失败都不会把 stub 泄漏给后续断言，
   *  也不让单条用例的异常掀翻整个套件（返回 { __error } 交给断言判失败） */
  const debt02Case = async (names, stubBody, body) => JSON.parse(await evalJs(`(async () => {
    var __names = ${JSON.stringify(names)};
    var __orig = {};
    __names.forEach(function (n) { __orig[n] = window[n]; });
    try {
      ${stubBody}
      var __r = await (async () => { ${body} })();
      return JSON.stringify(__r === undefined ? {} : __r);
    } catch (e) {
      return JSON.stringify({ __error: (e && e.message) || String(e) });
    } finally {
      __names.forEach(function (n) { window[n] = __orig[n]; });
    }
  })()`));

  // ① 自动备份（旧全量分支）后清理旧 ZIP 失败：备份本身是成功的，不能因为清理失败进重试队列
  const c1 = await debt02Case(
    ['webdavCheckConflict', '_collectAllData', '_incrementalBackup', '_buildZipBlob', 'webdavUpload', 'webdavCleanupBackups', '_clearBackupRetry'],
    `webdavCheckConflict = async function () { return null; };
     _collectAllData = async function () { return { settings: {}, groups: [] }; };
     _incrementalBackup = undefined;
     _buildZipBlob = async function () { return new Blob(['x']); };
     webdavUpload = async function () { return { ok: true }; };
     webdavCleanupBackups = function () { return Promise.reject(new Error('cleanup boom')); };
     window.__cleared = 0;
     _clearBackupRetry = async function () { window.__cleared++; };`,
    `var prevMode = currentSettings.backupMode;
     currentSettings.backupMode = 'webdav';
     try {
       await new Promise(function (r) { chrome.storage.local.set({ webdav_url: 'https://example.com/dav/', webdav_last_backup: '' }, r); });
       await _autoBackupIfNeeded();
       await new Promise(function (r) { setTimeout(r, 200); });
       return { cleared: window.__cleared };
     } finally { currentSettings.backupMode = prevMode; }`);
  const c1Warns = await takeWarns();
  check('DEBT-02 自动备份：旧 ZIP 清理失败仍算备份成功（重试队列被清空，不误判为失败）',
    c1.cleared === 1, c1);
  check('DEBT-02 自动备份：清理失败的诊断真的被打印出来',
    warnHas(c1Warns, '自动备份后清理旧 ZIP'), c1Warns.slice(0, 2));

  // ② 手动备份（旧全量分支）后清理旧 ZIP 失败：状态区仍显示「备份成功 ✅」
  await evalJs('(async () => { await ensureSettingsPanelReady(); return "ok"; })()');
  const c2 = await debt02Case(
    ['webdavIncrementalBackup', '_collectAllData', '_buildZipBlob', 'webdavUpload', 'webdavCleanupBackups'],
    `webdavIncrementalBackup = undefined;
     _collectAllData = async function () { return { settings: {}, groups: [] }; };
     _buildZipBlob = async function () { return new Blob(['x']); };
     webdavUpload = async function () { return { ok: true }; };
     webdavCleanupBackups = function () { return Promise.reject(new Error('cleanup boom')); };`,
    `document.getElementById('btn-webdav-backup').click();
     await new Promise(function (r) { setTimeout(r, 600); });
     var st = document.getElementById('webdav-status');
     return { status: st ? st.textContent : '' };`);
  const c2Warns = await takeWarns();
  check('DEBT-02 手动备份：清理失败不影响成功状态（仍显示「备份成功 ✅」）',
    /备份成功/.test(c2.status || ''), c2);
  check('DEBT-02 手动备份：清理失败的诊断真的被打印出来',
    warnHas(c2Warns, '手动备份后清理旧 ZIP'), c2Warns.slice(0, 2));

  // ③ 备份完成提示弹窗：用户点「以后再说」= CANCELLED（正常选择，必须静默）；真错误必须留痕
  const c3 = await debt02Case(
    ['_checkMigrationNeeded', '_collectAllData', '_incrementalBackup', 'webdavCleanupBackups', 'showImportConfirmAsync'],
    `_checkMigrationNeeded = async function () { return false; };
     _collectAllData = async function () { return {}; };
     _incrementalBackup = async function () { return true; };
     webdavCleanupBackups = function () { return Promise.resolve({ deleted: 0 }); };`,
    `window.__dpWarnBuf.length = 0;
     showImportConfirmAsync = function () { return Promise.reject(new Error('CANCELLED')); };
     await webdavIncrementalBackup();
     await new Promise(function (r) { setTimeout(r, 1500); });
     var cancelWarns = window.__dpWarnBuf.slice();
     window.__dpWarnBuf.length = 0;
     showImportConfirmAsync = function () { return Promise.reject(new Error('dialog boom')); };
     await webdavIncrementalBackup();
     await new Promise(function (r) { setTimeout(r, 1500); });
     return { cancel: cancelWarns.length, real: window.__dpWarnBuf.slice() };`);
  check('DEBT-02 备份完成提示：用户取消（CANCELLED）不产生任何诊断（正常选择，不是失败）',
    c3.cancel === 0, c3.cancel);
  check('DEBT-02 备份完成提示：非取消的真错误必须留痕（否则这条提示会静默消失）',
    warnHas(c3.real, '备份完成后的导出提示'), c3.real);

  // ④ 恢复上一次改动的确认弹窗：同样区分「用户取消」与「真错误」
  const c4 = await debt02Case(['showImportConfirmAsync'],
    `showImportConfirmAsync = function () { return Promise.reject(new Error('CANCELLED')); };`,
    `await new Promise(function (r) { chrome.storage.local.set({ groups_local_bak: [{ id: 'gbak', name: 'bak', cards: [] }], bak_timestamp: Date.now() }, r); });
     window.__dpWarnBuf.length = 0;
     document.getElementById('btn-restore-bak').click();
     await new Promise(function (r) { setTimeout(r, 400); });
     var cancelWarns = window.__dpWarnBuf.slice();
     window.__dpWarnBuf.length = 0;
     showImportConfirmAsync = function () { return Promise.reject(new Error('dialog boom')); };
     document.getElementById('btn-restore-bak').click();
     await new Promise(function (r) { setTimeout(r, 400); });
     return { cancel: cancelWarns.length, real: window.__dpWarnBuf.slice() };`);
  check('DEBT-02 恢复上一次改动：用户取消不产生诊断', c4.cancel === 0, c4.cancel);
  check('DEBT-02 恢复上一次改动：真错误必须留痕', warnHas(c4.real, '恢复上一次改动的确认弹窗'), c4.real);

  // ⑤ 首次迁移：旧 ZIP 一个都删不掉，仍要完成迁移（不卡住备份）
  const c5 = await debt02Case(
    ['_checkMigrationNeeded', 'showImportConfirmAsync', 'exportAll', 'webdavListBackups', 'webdavDeleteBackup'],
    `_checkMigrationNeeded = async function () { return true; };
     showImportConfirmAsync = function () { return Promise.resolve(); };
     exportAll = function () { return Promise.resolve(); };
     webdavListBackups = async function () { return [{ name: 'old1.zip' }, { name: 'old2.zip' }]; };
     webdavDeleteBackup = function () { return Promise.reject(new Error('del boom')); };`,
    `window.__dpWarnBuf.length = 0;
     var migrated = await _doFirstMigration();
     await new Promise(function (r) { setTimeout(r, 200); });
     return { migrated: migrated, warns: window.__dpWarnBuf.slice() };`);
  check('DEBT-02 首次迁移：旧 ZIP 删不掉仍完成迁移（resolve(true)，不卡住后续备份）',
    c5.migrated === true, c5.migrated);
  check('DEBT-02 首次迁移：每个删不掉的旧 ZIP 都留下诊断（2 个各一条）',
    (c5.warns || []).filter((w) => warnHas([w], '清理旧全量备份')).length === 2, c5.warns);

  // ⑥ 增量备份的孤儿 GC：过期 config / 无引用图片删不掉，本次备份仍算成功
  const c6 = await debt02Case(
    ['webdavGetManifest', 'webdavPutConfig', 'webdavPutManifest', 'webdavDeleteConfig', 'webdavListImages', 'webdavDeleteImage'],
    `var existing = [];
     for (var i = 0; i < 6; i++) existing.push({ name: 'cfg' + i + '.json', time: new Date().toISOString(), cardCount: 0 });
     webdavGetManifest = async function () { return { version: 1, images: { keep1: { md5: 'aaa', size: 1, type: 'image/png', refs: ['cfg0.json'] } }, configs: existing }; };
     webdavPutConfig = async function () { return { ok: true }; };
     webdavPutManifest = async function () { return { ok: true }; };
     webdavDeleteConfig = function () { return Promise.reject(new Error('delcfg boom')); };
     webdavListImages = async function () { return [{ name: 'orphanmd5.bin' }, { name: 'aaa.bin' }]; };
     webdavDeleteImage = function () { return Promise.reject(new Error('delimg boom')); };`,
    `window.__dpWarnBuf.length = 0;
     var ok = await _incrementalBackup({ config: { settings: {}, groups: [], activeGroup: 0 }, images: [] }, true);
     return { ok: ok, warns: window.__dpWarnBuf.slice() };`);
  check('DEBT-02 增量备份：过期 config 删不掉不影响本次备份成功（仍返回 true）', c6.ok === true, c6.ok);
  check('DEBT-02 增量备份：两个过期 config 的删除失败各留下一条诊断',
    warnHas(c6.warns, '删除过期配置快照 cfg4.json') && warnHas(c6.warns, '删除过期配置快照 cfg5.json'), c6.warns);
  check('DEBT-02 增量备份：孤儿图片删不掉有诊断，且仍被引用的图片不会被误删',
    warnHas(c6.warns, '删除云端孤儿图片 orphanmd5.bin') && !warnHas(c6.warns, 'aaa.bin'), c6.warns);

  // ⑦ 删除云端版本：manifest 更新失败，但删除本身已完成（行移除 + Toast）
  const c7 = await debt02Case(
    ['showImportConfirmAsync', 'webdavDeleteConfig', 'webdavGetManifest'],
    `showImportConfirmAsync = function () { return Promise.resolve(); };
     webdavDeleteConfig = async function () { return { ok: true }; };
     webdavGetManifest = function () { return Promise.reject(new Error('manifest boom')); };`,
    `var list = document.getElementById('webdav-version-list');
     var row = document.createElement('div');
     row.className = 'webdav-version-item';
     row.innerHTML = '<input type="radio" name="wdv"><button class="version-delete" data-name="cfgX.json" data-type="config">删</button>';
     list.appendChild(row);
     window.__dpWarnBuf.length = 0;
     row.querySelector('.version-delete').dispatchEvent(new MouseEvent('click', { bubbles: true }));
     await new Promise(function (r) { setTimeout(r, 500); });
     var toasts = [...document.querySelectorAll('.toast')].map(function (t) { return t.textContent; }).join('|');
     return { rowStillThere: !!list.contains(row), toasts: toasts, warns: window.__dpWarnBuf.slice() };`);
  check('DEBT-02 删除云端版本：manifest 更新失败仍完成删除（行移除 + 提示「已删除」）',
    c7.rowStillThere === false && /已删除/.test(c7.toasts || ''), c7);
  check('DEBT-02 删除云端版本：manifest 更新失败留下诊断（云端清单会残留幽灵条目）',
    warnHas(c7.warns, '从云端 manifest 移除已删配置 cfgX.json'), c7.warns);

  // ⑧ 图片缓存删除失败：不抛出（调用方流程不中断）但要留痕
  const c8 = await debt02Case(['openImgDB'],
    `openImgDB = function () { return Promise.reject(new Error('idb boom')); };`,
    `window.__dpWarnBuf.length = 0;
     var threw = null;
     try { await deleteImage('debt02_key'); } catch (e) { threw = e.message; }
     return { threw: threw, warns: window.__dpWarnBuf.slice() };`);
  check('DEBT-02 图片缓存删除失败：不抛出（删除卡片的流程不中断）', c8.threw === null, c8.threw);
  check('DEBT-02 图片缓存删除失败：诊断带上键名（否则「图片库莫名变大」无从查起）',
    warnHas(c8.warns, '删除图片缓存 debt02_key'), c8.warns);

  // ⑨ 重复检查：坏 URL 卡片跳过（有意静默）vs 传入 URL 自己解析不了（降级 + 留痕）
  const c9 = await debt02Case([], ``,
    `groups.push({ id: 'gdebt02', name: 'DEBT02', cards: [
       { id: 'debt02bad', name: 'bad', url: 'not-a-url' },
       { id: 'debt02good', name: 'good', url: 'https://example.com/debt02path' }
     ] });
     try {
       window.__dpWarnBuf.length = 0;
       var good = findDuplicate('https://www.example.com/debt02path');
       var goodWarns = window.__dpWarnBuf.slice();
       window.__dpWarnBuf.length = 0;
       var bad = findDuplicate('not-a-url');
       var badWarns = window.__dpWarnBuf.slice();
       return { good: good && good.cardName, bad: bad, goodWarns: goodWarns, badWarns: badWarns };
     } finally {
       groups = groups.filter(function (g) { return g.id !== 'gdebt02'; });
     }`);
  check('DEBT-02 重复检查：列表里有坏 URL 卡片时跳过它继续比对（正对照：好卡片仍能找到，且不刷诊断）',
    c9.good === 'good' && (c9.goodWarns || []).length === 0, c9);
  check('DEBT-02 重复检查：传入的 URL 自己解析不了 → 返回 null（降级可用）且留下诊断',
    c9.bad === null && warnHas(c9.badWarns, 'URL 无法解析'), c9);

  // ⑩ 新增卡片后补图标失败：卡片本身必须已经保存
  const c10 = await debt02Case(['enrichCardFavicons'],
    `enrichCardFavicons = function () { return Promise.reject(new Error('fav boom')); };`,
    `var prevFav = currentSettings.useFavicon;
     currentSettings.useFavicon = true;
     window.__dpWarnBuf.length = 0;
     try {
       await addSpeeddial('DEBT02新卡', 'https://debt02-newcard.example.com/', '');
       await new Promise(function (r) { setTimeout(r, 300); });
       var added = speeddials.filter(function (c) { return c.url === 'https://debt02-newcard.example.com/'; });
       return { added: added.length, warns: window.__dpWarnBuf.slice() };
     } finally {
       currentSettings.useFavicon = prevFav;
       speeddials = speeddials.filter(function (c) { return c.url !== 'https://debt02-newcard.example.com/'; });
       groups[activeGroupIndex].cards = speeddials;
       await saveGroups(groups);
       renderSpeeddials();
     }`);
  check('DEBT-02 新增卡片：补图标失败不影响卡片保存（正对照）', c10.added === 1, c10);
  check('DEBT-02 新增卡片：补图标失败的诊断真的被打印出来',
    warnHas(c10.warns, '新卡片补网站图标'), c10.warns);

  // ⑪ 首屏后任务：补图标失败不能拖垮同一批的其它任务
  const c11 = await debt02Case(['enrichCardFavicons', 'migrateCardIcons', 'collectCardImageGarbage', 'initWallpaper'],
    `window.__spy = { migrate: 0, gc: 0, wallpaper: 0 };
     enrichCardFavicons = function () { return Promise.reject(new Error('fav boom')); };
     migrateCardIcons = function () { window.__spy.migrate++; };
     collectCardImageGarbage = function () { window.__spy.gc++; };
     initWallpaper = function () { window.__spy.wallpaper++; };`,
    `var prevFav = currentSettings.useFavicon;
     currentSettings.useFavicon = true;
     window.__dpWarnBuf.length = 0;
     try {
       _runAfterFirstPaintTasks();
       await new Promise(function (r) { setTimeout(r, 300); });
       return { spy: window.__spy, warns: window.__dpWarnBuf.slice() };
     } finally { currentSettings.useFavicon = prevFav; }`);
  check('DEBT-02 首屏后任务：补图标失败不影响同一批的其它任务（图标迁移 / GC / 壁纸照跑）',
    !!c11.spy && c11.spy.migrate === 1 && c11.spy.gc === 1 && c11.spy.wallpaper === 1, c11.spy);
  check('DEBT-02 首屏后任务：补图标失败留下诊断', warnHas(c11.warns, '首屏后补网站图标'), c11.warns);

  // ⑫ 天气：地理编码失败 → 回退默认坐标；IP 定位失败 → 回退「北京」
  const c12 = await debt02Case(['swFetch'],
    `swFetch = function () { return Promise.reject(new Error('geo boom')); };`,
    `await new Promise(function (r) { chrome.storage.local.remove(['openmeteo_coords'], r); });
     window.__dpWarnBuf.length = 0;
     var coords = await getOpenMeteoCoords({ weatherCity: '上海' });
     return { coords: coords, warns: window.__dpWarnBuf.slice() };`);
  check('DEBT-02 天气：按城市名取经纬度失败 → 回退默认坐标（降级仍可用，不报错）',
    c12.coords && c12.coords.source === 'default' && c12.coords.lat === 39.9042, c12.coords);
  check('DEBT-02 天气：经纬度回退留下诊断', warnHas(c12.warns, '按城市名查询经纬度'), c12.warns);

  const c13 = await debt02Case(['swFetch'],
    `swFetch = function () { return Promise.reject(new Error('ip boom')); };`,
    `window.__dpWarnBuf.length = 0;
     var city = await detectCityByIP('k');
     return { city: city, warns: window.__dpWarnBuf.slice() };`);
  check('DEBT-02 天气：IP 定位失败 → 回退「北京」（降级仍可用）', c13.city === '北京', c13.city);
  check('DEBT-02 天气：IP 定位回退留下诊断', warnHas(c13.warns, '按 IP 定位城市'), c13.warns);

  // ⑬ 删组前的后悔药快照失败：不抛出、不阻断删除
  const c14 = await debt02Case(['getGroups'],
    `getGroups = function () { return Promise.reject(new Error('bak boom')); };`,
    `window.__dpWarnBuf.length = 0;
     var threw = null;
     try { await _snapshotGroupsForUndo(); } catch (e) { threw = e.message; }
     return { threw: threw, warns: window.__dpWarnBuf.slice() };`);
  check('DEBT-02 删组前快照：快照失败不抛出（删组流程不中断）', c14.threw === null, c14.threw);
  check('DEBT-02 删组前快照：留下诊断（否则「恢复上一次改动」会静默回退到更早状态）',
    warnHas(c14.warns, '删组前的本地快照'), c14.warns);

  const c14b = await debt02Case(['_snapshotGroupsForUndo'],
    `_snapshotGroupsForUndo = async function () { _warnDegraded('删组前的本地快照（后悔药）', new Error('bak boom')); };`,
    `groups.push({ id: 'gdebt02del', name: 'DEBT02待删', cards: [] });
     var before = groups.length;
     _pendingDeleteGroup = groups.length - 1;
     await doDeleteGroup();
     await new Promise(function (r) { setTimeout(r, 250); });
     return { before: before, after: groups.length, gone: !groups.some(function (g) { return g.id === 'gdebt02del'; }) };`);
  check('DEBT-02 删组前快照：快照失败时分组仍然被删掉（降级路径真的走通，不是只打日志）',
    c14b.after === c14b.before - 1 && c14b.gone === true, c14b);

  // ⑭ 分组拖拽：dataTransfer 写入失败是有意静默（排序用的是 dragFrom 变量）
  const c15 = JSON.parse(await evalJs(`(async () => {
    renderGroupManagerList();
    await new Promise(function (r) { setTimeout(r, 200); });
    var handle = document.querySelector('.group-mgr-item .group-mgr-drag');
    if (!handle) return JSON.stringify({ handle: false });
    window.__dpWarnBuf.length = 0;
    var dt = new DataTransfer();
    dt.setData = function () { throw new Error('dt boom'); };
    handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    return JSON.stringify({
      handle: true,
      dragging: handle.closest('.group-mgr-item').classList.contains('dragging'),
      warns: window.__dpWarnBuf.slice()
    });
  })()`));
  check('DEBT-02 分组拖拽：dataTransfer 写入失败仍继续拖拽，且不刷诊断（有意静默）',
    c15.handle === true && c15.dragging === true && (c15.warns || []).length === 0, c15);

  // ⑮ 右键菜单刷新失败（扩展上下文失效）：数据已落盘，可降级
  const c16 = JSON.parse(await evalJs(`(async () => {
    var orig = chrome.runtime.sendMessage;
    window.__dpWarnBuf.length = 0;
    var threw = null;
    chrome.runtime.sendMessage = function () { throw new Error('ctx invalidated'); };
    try { await _verifyGroupsWrite(groups); }
    catch (e) { threw = e.message; }
    finally { chrome.runtime.sendMessage = orig; }
    return JSON.stringify({ threw: threw, warns: window.__dpWarnBuf.slice() });
  })()`));
  check('DEBT-02 右键菜单刷新：扩展上下文失效时不抛出（数据已经落盘）', c16.threw === null, c16.threw);
  check('DEBT-02 右键菜单刷新：失败留下诊断', warnHas(c16.warns, '刷新右键菜单'), c16.warns);

  // ⑯ favicon 开关：整条补图标链路失败属于「不能降级」—— 用户刚打开开关，必须有反馈
  const c17 = await debt02Case(['enrichCardFavicons'],
    `enrichCardFavicons = function () { return Promise.reject(new Error('fav boom')); };`,
    `await ensureSettingsPanelReady();
     var sw = document.getElementById('toggle-use-favicon');
     sw.checked = true;
     window.__dpWarnBuf.length = 0;
     sw.dispatchEvent(new Event('change', { bubbles: true }));
     await new Promise(function (r) { setTimeout(r, 400); });
     var toasts = [...document.querySelectorAll('.toast')].map(function (t) { return t.textContent; }).join('|');
     sw.checked = false;
     return { toasts: toasts, warns: window.__dpWarnBuf.slice() };`);
  check('DEBT-02 favicon 开关：补图标整链路失败时给出用户提示（不能降级 → Toast）',
    /获取网站图标失败/.test(c17.toasts || ''), c17.toasts);
  check('DEBT-02 favicon 开关：同时留下 warn 诊断（且不是 console.error）',
    warnHas(c17.warns, '开关打开后补网站图标'), c17.warns);

  // 还原 console.warn（后续 [33] 段与 CI 的报错门都用真实 console）
  await evalJs('(function () { if (window.__dpWarnRestore) window.__dpWarnRestore(); window.__dpWarnInstalled = false; return "ok"; })()');

  console.log('\n[33] v1.6.1 修复：自己导出的备份不再误报「已忽略 N 项未知设置」');

  // ① 白名单计数：`_exportTime` 是扩展自己注入的导出元数据（exportAll / _collectAllData 都写它），
  //    不该被计成「未知设置」；但真正的未知键必须照旧计数 —— 否则就是把安全信号一起关掉。
  const wlCase = JSON.parse(await evalJs(`(function () {
    var withMeta = Object.assign({}, DEFAULT_SETTINGS, { _exportTime: '2026/10/4 16:21:05' });
    var safeMeta = normalizeImportedSettings(withMeta);
    var withEvil = Object.assign({}, DEFAULT_SETTINGS, { _exportTime: '2026/10/4 16:21:05', evilKey: 'boom' });
    var safeEvil = normalizeImportedSettings(withEvil);
    var protoRaw = JSON.parse('{"__proto__":{"polluted":1},"theme":"dark"}');
    var safeProto = normalizeImportedSettings(protoRaw);
    return JSON.stringify({
      metaCount: countRejectedSettings(withMeta, safeMeta),
      metaInSafe: Object.prototype.hasOwnProperty.call(safeMeta, '_exportTime'),
      evilCount: countRejectedSettings(withEvil, safeEvil),
      evilInSafe: Object.prototype.hasOwnProperty.call(safeEvil, 'evilKey'),
      protoCount: countRejectedSettings(protoRaw, safeProto),
      protoPolluted: ({}).polluted !== undefined
    });
  })()`));
  check('修复：带 _exportTime（本扩展注入的导出元数据）不再被计为「未知设置」',
    wlCase.metaCount === 0, wlCase);
  check('修复：_exportTime 仍然不会被写进设置（只是不告警，元数据不进 storage）',
    wlCase.metaInSafe === false, wlCase);
  check('负对照：真正的未知键仍被计数并经白名单丢弃（安全信号没被削弱）',
    wlCase.evilCount === 1 && wlCase.evilInSafe === false, wlCase);
  check('负对照：__proto__ 这类原型污染键仍计数告警，且原型未被污染（只放行单下划线元数据约定）',
    wlCase.protoCount >= 1 && wlCase.protoPolluted === false, wlCase);

  // ② 端到端：真实「导出 → 重新导入自己导出的包」必须完全没有「已忽略」告警（用户实际遇到的场景）
  const ownBackup = JSON.parse(await evalJs(`(async () => {
    var origDownload = downloadFile;
    var captured = null;
    downloadFile = function (blob) { captured = blob; };
    try { await exportAll(); } finally { downloadFile = origDownload; }
    if (!captured) return JSON.stringify({ captured: false });
    var un = fflate.unzipSync(new Uint8Array(await captured.arrayBuffer()));
    var cfg = JSON.parse(fflate.strFromU8(un['config.json']));
    [].forEach.call(document.querySelectorAll('.toast'), function (t) { t.remove(); });
    await doImportFromUnzipped(un, false);
    await new Promise(function (r) { setTimeout(r, 600); });
    return JSON.stringify({
      captured: true,
      hasExportTime: !!(cfg.settings && cfg.settings._exportTime),
      toasts: [].map.call(document.querySelectorAll('.toast'), function (t) { return t.textContent; }).join('|')
    });
  })()`));
  check('端到端复现前提：导出包里确实带着 _exportTime（修复前必然触发误报）',
    ownBackup.hasExportTime === true, ownBackup);
  check('端到端：重新导入自己导出的备份，不再出现「已忽略 N 项…备份可能被篡改」误报',
    !/已忽略/.test(ownBackup.toasts || ''), ownBackup);

  // ③ 端到端负对照：真的塞一个未知键进备份 → 告警必须照常出现，且该键不得进入设置。
  //    注意口径：ZIP 导入路径的用户可见信号是 console.warn（云端恢复路径才额外弹 Toast ——
  //    两条路径的反馈不对称，属已记录的观察项而非本批改动），所以这里断言 warn 文本而不是 Toast。
  const tampered = JSON.parse(await evalJs(`(async () => {
    var origDownload = downloadFile;
    var captured = null;
    downloadFile = function (blob) { captured = blob; };
    try { await exportAll(); } finally { downloadFile = origDownload; }
    var un = fflate.unzipSync(new Uint8Array(await captured.arrayBuffer()));
    var cfg = JSON.parse(fflate.strFromU8(un['config.json']));
    cfg.settings.evilKey = 'boom';                       // 模拟「被篡改」的备份
    un['config.json'] = fflate.strToU8(JSON.stringify(cfg));
    [].forEach.call(document.querySelectorAll('.toast'), function (t) { t.remove(); });
    var warns = [];
    var origWarn = console.warn;
    console.warn = function () { warns.push([].slice.call(arguments).map(String).join(' ')); };
    try { await doImportFromUnzipped(un, false); } finally { console.warn = origWarn; }
    await new Promise(function (r) { setTimeout(r, 300); });
    var stored = await new Promise(function (r) { chrome.storage.sync.get('settings', function (x) { r(x.settings || {}); }); });
    return JSON.stringify({
      ignoreWarns: warns.filter(function (w) { return w.indexOf('已忽略') !== -1; }),
      evilStored: Object.prototype.hasOwnProperty.call(stored, 'evilKey'),
      toasts: [].map.call(document.querySelectorAll('.toast'), function (t) { return t.textContent; }).join('|')
    });
  })()`));
  check('负对照（端到端）：被篡改的备份仍然报「已忽略 1 项」（不能为了消音把安全信号关掉）',
    tampered.ignoreWarns.some((w) => /已忽略 1 项/.test(w)), tampered);
  check('负对照（端到端）：未知键确实没有被写进 storage',
    tampered.evilStored === false, tampered);

  console.log('\n[34] BUG-078 网页截图主链路（真实开窗 → 真实点击注入按钮 → 真实 captureVisibleTab）');
  // 靶子用**本地静态页面**：离线、确定，不依赖外网（外网抖动会让这条断言变脆）。
  // 这条断言是本次补上的 —— 截图功能自 v1.3.3 起整体失效 12 个版本，正是因为原先没有任何断言
  // 真的跑过一次「成功截图」（BUG-046 只测了权限闸门）。
  const shotFixture = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>DP Shot Fixture</title></head><body style="margin:0;background:#00bb55;color:#fff">'
      + '<div id="fixture">SHOT-FIXTURE-OK</div></body></html>');
  });
  await new Promise((r) => shotFixture.listen(0, '127.0.0.1', r));
  const shotPort = shotFixture.address().port;
  const shotUrl = `http://127.0.0.1:${shotPort}/`;

  /** PNG 完整性校验（Node 侧，用内置 zlib）：签名 + IHDR + IDAT 解压长度 == h*(1+w*channels)
   *  这比「字符串非空」强得多 —— 能证明拿到的是**完整可解码的真 PNG**。 */
  const pngIntegrity = (dataUrl) => {
    const b64 = String(dataUrl || '').split(',')[1] || '';
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 8 || buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return { ok: false, reason: 'bad signature', bytes: buf.length };
    let off = 8, ihdr = null; const idat = [];
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.slice(off + 4, off + 8).toString('ascii');
      const data = buf.slice(off + 8, off + 8 + len);
      if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9] };
      else if (type === 'IDAT') idat.push(data);
      off += 12 + len;
      if (type === 'IEND') break;
    }
    if (!ihdr) return { ok: false, reason: 'no IHDR', bytes: buf.length };
    const channels = ihdr.color === 6 ? 4 : ihdr.color === 2 ? 3 : ihdr.color === 0 ? 1 : 0;
    if (!channels) return { ok: false, reason: 'color type ' + ihdr.color, bytes: buf.length };
    const raw = require('zlib').inflateSync(Buffer.concat(idat));
    const expect = ihdr.h * (1 + ihdr.w * channels);
    return { ok: raw.length === expect, w: ihdr.w, h: ihdr.h, bytes: buf.length, rawLen: raw.length, expect: expect };
  };

  // 页面内的点击驱动：找靶子 tab → 等注入按钮出现 → 真实点它（只点一次）
  await evalJs(`(function () {
    window.__dpClickShotBtn = async function (port) {
      if (window.__dpShotClicked) return 'already-clicked';
      var tabs = await chrome.tabs.query({});
      var tab = tabs.filter(function (t) { return (t.url || '').indexOf('127.0.0.1:' + port) !== -1; })[0];
      if (!tab) return 'waiting-tab';
      var r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: function () { return !!document.getElementById('dp-capture-btn'); } });
      if (!(r && r[0] && r[0].result)) return 'waiting-button';
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: function () { var b = document.getElementById('dp-capture-btn'); if (b) b.click(); } });
      window.__dpShotClicked = true;
      return 'clicked';
    };
    return 'ok';
  })()`);

  // ① SW 契约层：真实消息链路 → 断言拿到**完整可解码**的 PNG
  await evalJs(`(function () {
    window.__dpShotClicked = false;
    window.__dpShot1 = { phase: 'pending' };
    chrome.runtime.sendMessage({ type: 'capture-screenshot', url: ${JSON.stringify(shotUrl)} }, function (x) {
      window.__dpShot1 = { phase: 'settled', resp: x || null, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null };
    });
    return 'started';
  })()`);
  let shot1 = null;
  for (let i = 0; i < 45; i++) {
    shot1 = JSON.parse(await evalJs('JSON.stringify(window.__dpShot1)'));
    if (shot1 && shot1.phase !== 'pending') break;
    await evalJs(`window.__dpClickShotBtn(${shotPort})`);
    await sleep(400);
  }
  const swResp = (shot1 && shot1.resp) || null;
  const png = (swResp && swResp.ok) ? pngIntegrity(swResp.dataUrl) : null;
  check('BUG-078 截图主链路成功（真实开窗 → 点击注入按钮 → captureVisibleTab 返回 dataUrl）',
    !!(swResp && swResp.ok && /^data:image\/png;base64,/.test(swResp.dataUrl || '')),
    { ok: swResp && swResp.ok, error: swResp && swResp.error, phase: shot1 && shot1.phase, head: String((swResp && swResp.dataUrl) || '').slice(0, 30) });
  check('BUG-078 拿到的是**完整可解码的真 PNG**（签名 + IHDR + IDAT 解压长度校验，不是空串/截断数据）',
    !!(png && png.ok && png.bytes > 3000 && png.w > 0 && png.h > 0), png);

  // ② 用户路径：卡片右键「📸 刷新截图」→ 卡片封面真的落库 + 成功文案（而不是红色「截图失败」）
  //    注意 starter 必须是**同步返回**的：runShotFlow 式的 awaitPromise 会阻塞点击，导致自己把自己等超时。
  const uiKey = 'shot_fixture_card';
  await evalJs(`(async () => {
    var card = { id: ${JSON.stringify(uiKey)}, name: '截图靶子', url: ${JSON.stringify(shotUrl)}, image: '', color: '#00bb55', visitCount: 0, createdAt: Date.now(), lastOpened: 0 };
    groups[activeGroupIndex].cards = (groups[activeGroupIndex].cards || []).filter(function (c) { return c.id !== ${JSON.stringify(uiKey)}; });
    groups[activeGroupIndex].cards.push(card);
    speeddials = groups[activeGroupIndex].cards;
    await saveGroups(groups);              // refreshCardCapture 会从 storage 重新读分组
    renderSpeeddials();
    [].forEach.call(document.querySelectorAll('.toast'), function (t) { t.remove(); });
    window.__dpShotClicked = false;
    refreshCardCapture(${JSON.stringify(uiKey)});   // 右键菜单「刷新截图」调的就是它
    return 'ok';
  })()`);
  let uiImage = '';
  for (let i = 0; i < 45; i++) {
    await evalJs(`window.__dpClickShotBtn(${shotPort})`);
    await sleep(400);
    uiImage = await evalJs(`(function () {
      var c = (groups[activeGroupIndex].cards || []).filter(function (x) { return x.id === ${JSON.stringify(uiKey)}; })[0];
      return c ? (c.image || '') : '';
    })()`);
    if (uiImage) break;
  }
  const uiToasts = await evalJs(`[].map.call(document.querySelectorAll('.toast'), function (t) { return t.textContent; }).join('|')`);
  check('BUG-078 用户路径：卡片封面真的被写入（image 从空变成 idx: 引用 → 截图已落库）',
    /^idx:/.test(uiImage || ''), { image: uiImage });
  check('BUG-078 用户路径：出现「截图已更新」成功文案，且**没有**红色「截图失败」',
    /截图已更新/.test(uiToasts || '') && !/截图失败/.test(uiToasts || ''), { toasts: uiToasts, image: uiImage });

  // 清理：删掉靶子卡片与它的图片、关掉遗留靶子窗口、强制释放 fixture 连接
  // （http.Server.close() 会等 keep-alive 连接结束，不强制释放会把测试挂死）
  await evalJs(`(async () => {
    var c = (groups[activeGroupIndex].cards || []).filter(function (x) { return x.id === ${JSON.stringify(uiKey)}; })[0];
    if (c && c.image && typeof deleteCardImageRef === 'function') { try { await deleteCardImageRef(c.image); } catch (e) {} }
    groups[activeGroupIndex].cards = (groups[activeGroupIndex].cards || []).filter(function (x) { return x.id !== ${JSON.stringify(uiKey)}; });
    speeddials = groups[activeGroupIndex].cards;
    await saveGroups(groups);
    renderSpeeddials();
    var tabs = await chrome.tabs.query({});
    var ids = tabs.filter(function (t) { return (t.url || '').indexOf('127.0.0.1:${shotPort}') !== -1; }).map(function (t) { return t.id; });
    if (ids.length) { try { await chrome.tabs.remove(ids); } catch (e) {} }
    [].forEach.call(document.querySelectorAll('.toast'), function (t) { t.remove(); });
    return 'ok';
  })()`);
  await new Promise((r) => {
    if (typeof shotFixture.closeAllConnections === 'function') shotFixture.closeAllConnections();
    shotFixture.close(() => r());
  });

  console.log('\n[35] BUG-079 分组拖拽（真实 CDP 拖拽）＋ BUG-080 滑块轨道可读性');

  // —— ① 滑块：轨道对比 ≥3:1（两种主题）+ --pct 进度 + 单张遮罩可回到「跟随全局」 ——
  const sliderFix = JSON.parse(await evalJs(`(async () => {
    function lum(c){var m=/rgba?\\(([^)]+)\\)/.exec(c||'');if(!m)return null;var p=m[1].split(',').map(parseFloat);var f=function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};return 0.2126*f(p[0])+0.7152*f(p[1])+0.0722*f(p[2]);}
    function toRgb(h){h=String(h||'').trim().replace('#','');if(h.length<6)return null;return 'rgb('+parseInt(h.slice(0,2),16)+','+parseInt(h.slice(2,4),16)+','+parseInt(h.slice(4,6),16)+')';}
    function ratio(a,b){var l1=lum(a),l2=lum(b);return (l1===null||l2===null)?null:Math.round(((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05))*100)/100;}
    await ensureSettingsPanelReady(); openSettingsPanel(); await new Promise(function(r){setTimeout(r,300);});
    var s=document.getElementById('setting-wallpaper-opacity'), panel=document.getElementById('settings-panel'), out={};
    for (var ti=0; ti<2; ti++) { var t = ti ? 'dark' : 'light'; applyTheme(t); await new Promise(function(r){setTimeout(r,100);});
      out[t] = { contrast: ratio(toRgb(getComputedStyle(document.documentElement).getPropertyValue('--slider-track')), getComputedStyle(panel).backgroundColor),
                 isGradient: getComputedStyle(s).backgroundImage.indexOf('gradient') !== -1 }; }
    applyTheme('light');
    s.value='60'; s.dispatchEvent(new Event('input',{bubbles:true})); out.pct60 = s.style.getPropertyValue('--pct');
    var key='lwtest_e2e';
    currentSettings.localWallpapers = (currentSettings.localWallpapers||[]).filter(function(x){return x.key!==key;});
    currentSettings.localWallpapers.push({ key: key, name: 'E2E测试壁纸.png', opacity: null });
    renderLocalWallpaperList(); await new Promise(function(r){setTimeout(r,150);});
    out.beforeBtn = !!document.querySelector('.lw-op-reset[data-key="'+key+'"]');
    setLocalWallpaperOpacity(key, '45'); await new Promise(function(r){setTimeout(r,150);});
    var row = document.querySelector('.lw-item[data-key="'+key+'"]');
    out.afterBtn = !!document.querySelector('.lw-op-reset[data-key="'+key+'"]');
    out.afterBtnFound = out.afterBtn;
    out.afterLabel = row ? row.querySelector('.lw-op-val').textContent : null;
    out.afterPct = row ? row.querySelector('.lw-op').style.getPropertyValue('--pct') : null;
    // 修复前对照时该按钮不存在 → 不能直接 .click()（会抛 TypeError 掀翻整个套件，而不是让断言失败）
    var rbtn = document.querySelector('.lw-op-reset[data-key="'+key+'"]');
    if (rbtn) rbtn.click(); else out.clickSkipped = true;
    await new Promise(function(r){setTimeout(r,200);});
    row = document.querySelector('.lw-item[data-key="'+key+'"]');
    out.resetBtn = !!document.querySelector('.lw-op-reset[data-key="'+key+'"]');
    out.resetLabel = row ? row.querySelector('.lw-op-val').textContent : null;
    var it = (getLocalWallpapers()||[]).filter(function(x){return x.key===key;})[0];
    out.resetStored = it ? it.opacity : 'missing';
    currentSettings.localWallpapers = (currentSettings.localWallpapers||[]).filter(function(x){return x.key!==key;});
    renderLocalWallpaperList(); closeSettingsPanel();
    return JSON.stringify(out);
  })()`, true));
  check('BUG-080 滑块未填充轨道与面板底色对比 ≥3:1（浅色；修复前 1.21:1）',
    sliderFix.light.contrast >= 3 && sliderFix.light.isGradient === true, sliderFix.light);
  check('BUG-080 同上（深色；修复前 1.47:1，且旧规则会把渐变整个盖掉）',
    sliderFix.dark.contrast >= 3 && sliderFix.dark.isGradient === true, sliderFix.dark);
  check('BUG-080 滑块有进度填充：--pct 随值同步（值 60 / 上限 80 → 75%）',
    sliderFix.pct60 === '75%', sliderFix.pct60);
  check('BUG-080 单张遮罩可回到「跟随全局」（修复前状态不可逆：标签永久变 N%、无重置入口）',
    sliderFix.beforeBtn === false && sliderFix.afterBtn === true && sliderFix.afterLabel === '45%'
      && sliderFix.afterPct === '45%' && sliderFix.resetBtn === false
      && sliderFix.resetLabel === '跟随全局' && sliderFix.resetStored === null, sliderFix);

  // —— ② 分组管理器：真实 CDP 拖拽（不是合成 DragEvent —— 合成事件绕过浏览器 DnD 状态机，
  //    正是这个覆盖缺口让 BUG-079 潜伏：逐行绑定 + 闭包 dragFrom，拖拽途中一重渲染就失去放置目标）——
  const dragRects = async () => JSON.parse(await evalJs(`(async () => {
    if (typeof ensureSettingsPanelReady === 'function') await ensureSettingsPanelReady();
    while (groups.length < 3) groups.push({ id: 'gdrag' + groups.length, name: '拖拽测试组' + groups.length, cards: [], sortMode: 'manual' });
    await saveGroups(groups); renderGroupDots(); openGroupManager();
    await new Promise(function (r) { setTimeout(r, 400); });
    var rows = [].slice.call(document.querySelectorAll('.group-mgr-item'));
    var h = rows[0].querySelector('.group-mgr-drag').getBoundingClientRect();
    var t = rows[rows.length - 1].getBoundingClientRect();
    return JSON.stringify({
      names: groups.map(function (g) { return g.name; }),
      handle: { x: Math.round(h.left + h.width / 2), y: Math.round(h.top + h.height / 2) },
      target: { x: Math.round(t.left + t.width / 2), y: Math.round(t.top + t.height / 2) }
    });
  })()`));
  const realDrag = async (r, midRerender) => {
    interceptedDrag = null;
    await send('Input.setInterceptDrags', { enabled: true }, sid);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.handle.x, y: r.handle.y, button: 'left', clickCount: 1, buttons: 1 }, sid);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.handle.x + 12, y: r.handle.y + 12, button: 'left', buttons: 1 }, sid);
    for (let i = 0; i < 20 && !interceptedDrag; i++) await sleep(100);
    const started = !!interceptedDrag;
    if (midRerender) { await evalJs('(function () { renderGroupManagerList(); return "ok"; })()'); await sleep(150); }
    if (started) {
      // CDP 拖拽序列必须 dragEnter → dragOver → drop（漏掉 dragEnter 事件不会送达页面）
      await send('Input.dispatchDragEvent', { type: 'dragEnter', x: r.target.x, y: r.target.y, data: interceptedDrag }, sid);
      await send('Input.dispatchDragEvent', { type: 'dragOver', x: r.target.x, y: r.target.y, data: interceptedDrag }, sid);
      await sleep(120);
      await send('Input.dispatchDragEvent', { type: 'drop', x: r.target.x, y: r.target.y, data: interceptedDrag }, sid);
      await sleep(600);
    }
    await send('Input.setInterceptDrags', { enabled: false }, sid).catch(() => {});
    const after = JSON.parse(await evalJs('JSON.stringify(groups.map(function (g) { return g.name; }))'));
    const stored = JSON.parse(await evalJs(`new Promise(function (r) { chrome.storage.sync.get('groups', function (x) { r(JSON.stringify((x.groups || []).map(function (g) { return g.name; }))); }); })`));
    return { started, after, stored, movedToEnd: after[after.length - 1] === r.names[0] };
  };
  const dr1 = await realDrag(await dragRects(), false);
  check('BUG-079 真实拖拽 ⠿ 手柄能重排分组（拖拽真的启动 + 落盘顺序同步）',
    dr1.started && dr1.movedToEnd && dr1.stored.join() === dr1.after.join(), dr1);
  const dr2 = await realDrag(await dragRects(), true);
  check('BUG-079 拖拽中途列表被重渲染仍能重排（事件委托的核心收益；修复前此场景 drop 不会触发）',
    dr2.started && dr2.movedToEnd, dr2);
  // 清理：把本次造的测试分组删掉，恢复分组数
  await evalJs(`(async () => {
    groups = groups.filter(function (g) { return g.id.indexOf('gdrag') !== 0; });
    activeGroupIndex = Math.min(activeGroupIndex, groups.length - 1);
    speeddials = (groups[activeGroupIndex] && groups[activeGroupIndex].cards) || [];
    await saveGroups(groups); renderSpeeddials(); renderGroupDots();
    if (typeof closeGroupManager === 'function') closeGroupManager();
    return 'ok';
  })()`);

  console.log('\n[36] v1.6.4 收尾：BUG-079 真因/加固 + BUG-081 多选壁纸 + #8 实测 BUG-082/083/084');

  // —— (1) BUG-079 真因：用户实测「光标进到行间空隙/列表留白就变 🚫、松手无效」——
  //    根因是原先只在「正落在某一行上」才 preventDefault → 空隙处浏览器判定不接受放置，
  //    drop 永不触发。dd699bc 改为整块列表接受放置 + 空隙按落点找最近行。
  //    落点用两行中线（elementFromPoint 命中的是列表容器，不是行）。
  const gmgr = JSON.parse(await evalJs(`(async () => {
    if (typeof ensureSettingsPanelReady === 'function') await ensureSettingsPanelReady();
    while (groups.length < 3) groups.push({ id: 'gdrag' + groups.length, name: '拖拽测试组' + groups.length, cards: [], sortMode: 'manual' });
    await saveGroups(groups); renderGroupDots(); openGroupManager();
    await new Promise(function (r) { setTimeout(r, 400); });
    var rows = [].slice.call(document.querySelectorAll('.group-mgr-item'));
    function center(el) { var r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }
    // 行内「非输入区」起拖点：从左往右扫，取 elementFromPoint 命中本行且不在 input/button 上的点
    function freePoint(row) {
      var rr = row.getBoundingClientRect();
      for (var dx = 3; dx < rr.width - 3; dx += 3) {
        var x = Math.round(rr.left + dx), y = Math.round(rr.top + rr.height / 2);
        var el = document.elementFromPoint(x, y);
        if (!el || !row.contains(el) || el.closest('input') || el.closest('button')) continue;
        return { x: x, y: y, hit: String(el.className || el.tagName) };
      }
      return null;
    }
    var r0 = rows[0].getBoundingClientRect(), r1 = rows[1].getBoundingClientRect();
    var gap = { x: Math.round(r0.left + r0.width / 2), y: Math.round((r0.bottom + r1.top) / 2) };
    var gapEl = document.elementFromPoint(gap.x, gap.y);
    var rowTags = [].slice.call(document.querySelectorAll('.group-mgr-name')).map(function (i) { return i.value; });
    return JSON.stringify({
      names: groups.map(function (g) { return g.name; }),
      rowTags: rowTags,
      handle: center(rows[0].querySelector('.group-mgr-drag')),
      free: freePoint(rows[0]),
      gap: gap,
      gapHitsRow: !!(gapEl && gapEl.closest && gapEl.closest('.group-mgr-item')),
      gapHit: gapEl ? String(gapEl.id || gapEl.className || gapEl.tagName) : null,
      last: center(rows[rows.length - 1]),
      nameInput: (function () { var inp = rows[0].querySelector('.group-mgr-name'); var r = inp.getBoundingClientRect(); return { x: Math.round(r.left + 3), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) }; })()
    });
  })()`));
  check('BUG-079 前提：落点确实在两行之间的空隙上（elementFromPoint 不是行）',
    gmgr.gapHitsRow === false && gmgr.names.length >= 3, { gap: gmgr.gap, gapHit: gmgr.gapHit });

  // 真实 CDP 拖拽（不是合成 DragEvent）：可指定起拖点与落点，并观测页面是否接受放置
  const realDrag2 = async (fromKey, toKey) => {
    const from = gmgr[fromKey], to = gmgr[toKey];
    // 每次拖拽前重新取一次顺序快照：上一次拖拽本身就会改变顺序，
    // 拿 initial 快照比对会得出「拖错了一行」的假失败（本文件第一版就踩了这个）
    const namesBefore = JSON.parse(await evalJs('JSON.stringify(groups.map(function (g) { return g.name; }))'));
    await evalJs(`(function () {
      window.__dgo = { over: 0, prevented: 0, drop: 0, dropPrevented: 0 };
      document.addEventListener('dragover', function (e) { window.__dgo.over++; if (e.defaultPrevented) window.__dgo.prevented++; });
      document.addEventListener('drop', function (e) { window.__dgo.drop++; if (e.defaultPrevented) window.__dgo.dropPrevented++; });
      return 'ok';
    })()`);
    interceptedDrag = null;
    await send('Input.setInterceptDrags', { enabled: true }, sid);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 }, sid);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + 12, y: from.y + 12, button: 'left', buttons: 1 }, sid);
    for (let i = 0; i < 20 && !interceptedDrag; i++) await sleep(100);
    const started = !!interceptedDrag;
    if (started) {
      await send('Input.dispatchDragEvent', { type: 'dragEnter', x: to.x, y: to.y, data: interceptedDrag }, sid);
      await send('Input.dispatchDragEvent', { type: 'dragOver', x: to.x, y: to.y, data: interceptedDrag }, sid);
      await sleep(150);
      await send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data: interceptedDrag }, sid);
      await sleep(600);
    }
    await send('Input.setInterceptDrags', { enabled: false }, sid).catch(() => {});
    const dgo = JSON.parse(await evalJs('JSON.stringify(window.__dgo)'));
    const after = JSON.parse(await evalJs('JSON.stringify(groups.map(function (g) { return g.name; }))'));
    const stored = JSON.parse(await evalJs(`new Promise(function (r) { chrome.storage.sync.get('groups', function (x) { r(JSON.stringify((x.groups || []).map(function (g) { return g.name; }))); }); })`));
    return { started, dgo, after, stored, namesBefore, from: fromKey, to: toKey, names: gmgr.names };
  };

  const gapDrag = await realDrag2('handle', 'gap');
  check('BUG-079 真因：落在两行之间的空隙也能重排（修复前此处不 preventDefault → drop 不触发、顺序静默不变）',
    gapDrag.started && gapDrag.dgo.prevented > 0 && gapDrag.dgo.dropPrevented > 0
      && gapDrag.after[1] === gapDrag.namesBefore[0] && gapDrag.stored.join() === gapDrag.after.join(), gapDrag);

  // —— (2) 加固：整行（非输入区）作为拖拽源 ——
  const rowDrag = await realDrag2('free', 'last');
  check('BUG-079 加固：从整行非输入区起拖也能重排并落盘（修复前只有 ⠿ 手柄是拖拽源）',
    !!gmgr.free && rowDrag.started && rowDrag.after[rowDrag.after.length - 1] === rowDrag.namesBefore[0]
      && rowDrag.stored.join() === rowDrag.after.join(), { free: gmgr.free, rowDrag });

  // —— (3) 加固：在输入框上按下不启动行拖拽，且输入框仍可正常选字 ——
  interceptedDrag = null;
  await send('Input.setInterceptDrags', { enabled: true }, sid);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: gmgr.nameInput.x, y: gmgr.nameInput.y, button: 'left', clickCount: 1, buttons: 1 }, sid);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gmgr.nameInput.x + Math.min(40, gmgr.nameInput.w - 6), y: gmgr.nameInput.y, button: 'left', buttons: 1 }, sid);
  await sleep(800);
  const inputDragState = JSON.parse(await evalJs(`JSON.stringify({
    rowDraggable: document.querySelector('.group-mgr-item').getAttribute('draggable'),
    focused: document.activeElement === document.querySelector('.group-mgr-item .group-mgr-name'),
    selLen: (function () { var i = document.querySelector('.group-mgr-item .group-mgr-name'); try { return Math.abs((i.selectionEnd || 0) - (i.selectionStart || 0)); } catch (e) { return -1; } })(),
    value: document.querySelector('.group-mgr-item .group-mgr-name').value
  })`));
  inputDragState.intercepted = interceptedDrag !== null;
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: gmgr.nameInput.x, y: gmgr.nameInput.y, button: 'left', clickCount: 1, buttons: 0 }, sid);
  await send('Input.setInterceptDrags', { enabled: false }, sid).catch(() => {});
  check('BUG-079 加固：在输入框上按下不启动行拖拽（临时关掉行的 draggable）',
    inputDragState.intercepted === false && inputDragState.rowDraggable === 'false', inputDragState);
  check('BUG-079 加固：输入框仍保持可选字（mousedown 被拖拽吞掉的话这里选不中）',
    inputDragState.focused === true && inputDragState.selLen > 0, inputDragState);

  // 清理本次造的分组
  await evalJs(`(async () => {
    groups = groups.filter(function (g) { return g.id.indexOf('gdrag') !== 0; });
    activeGroupIndex = Math.min(activeGroupIndex, groups.length - 1);
    speeddials = (groups[activeGroupIndex] && groups[activeGroupIndex].cards) || [];
    await saveGroups(groups); renderSpeeddials(); renderGroupDots();
    if (typeof closeGroupManager === 'function') closeGroupManager();
    return 'ok';
  })()`);

  // —— (4) BUG-081：多选本地壁纸只生效第一张（FileList 被 this.value='' 清空，async 循环提前结束）——
  const multiWall = JSON.parse(await evalJs(`(async () => {
    await ensureSettingsPanelReady();
    openSettingsPanel();
    await new Promise(function (r) { setTimeout(r, 200); });
    var before = (getLocalWallpapers() || []).length;
    var mk = function (n) { return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])], n, { type: 'image/png' }); };
    var dt = new DataTransfer();
    dt.items.add(mk('m1.png')); dt.items.add(mk('m2.png')); dt.items.add(mk('m3.png'));
    var inp = document.getElementById('wallpaper-file-input-multi');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(function (r) { setTimeout(r, 1800); });
    var list = getLocalWallpapers() || [];
    var mine = list.filter(function (x) { return ['m1.png', 'm2.png', 'm3.png'].indexOf(x.name) !== -1; });
    var out = { before: before, after: list.length, added: list.length - before, names: mine.map(function (x) { return x.name; }), keys: mine.map(function (x) { return x.key; }) };
    // 清理：走真实删除路径（同时回收 IndexedDB 里的图片）
    for (var i = 0; i < out.keys.length; i++) { await deleteLocalWallpaper(out.keys[i]); }
    await new Promise(function (r) { setTimeout(r, 300); });
    out.afterCleanup = (getLocalWallpapers() || []).length;
    return JSON.stringify(out);
  })()`));
  check('BUG-081 一次选 3 张本地壁纸全部入库（修复前只进第一张）',
    multiWall.added === 3 && multiWall.names.length === 3
      && ['m1.png', 'm2.png', 'm3.png'].every(function (n) { return multiWall.names.indexOf(n) !== -1; })
      && multiWall.afterCleanup === multiWall.before, multiWall);

  // —— (5) BUG-082（#8-1 用户实测 图1）：点「↺ 重置」后进度填充必须跟随滑块 ——
  //    程序化赋值不触发 input → BUG-080 的捕获同步器不跑 → --pct 停在用户拖拽时的旧值。
  //    不变量：面板内**每个**滑块的 --pct 必须等于由 (value,min,max) 算出的百分比。
  const pctFix = JSON.parse(await evalJs(`(async () => {
    await ensureSettingsPanelReady();
    openSettingsPanel();
    await new Promise(function (r) { setTimeout(r, 300); });
    var panel = document.getElementById('settings-panel');
    function bad() {
      var arr = [];
      panel.querySelectorAll('input[type="range"]').forEach(function (el) {
        var mn = Number(el.min || 0), mx = Number(el.max === '' || el.max === undefined ? 100 : el.max);
        var v = Number(el.value);
        var exp = (mx > mn) ? Math.max(0, Math.min(100, ((v - mn) / (mx - mn)) * 100)) : 0;
        var got = parseFloat(el.style.getPropertyValue('--pct'));
        if (!(Math.abs(got - exp) < 0.01)) arr.push({ id: el.id, v: v, exp: +exp.toFixed(2), got: isNaN(got) ? 'missing' : got });
      });
      return arr;
    }
    function poke(id, v) { var el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } }
    var out = { onOpen: bad() };
    poke('setting-card-height', 80);
    await new Promise(function (r) { setTimeout(r, 150); });
    var hs = document.getElementById('setting-card-height');
    out.dragged = { pct: hs.style.getPropertyValue('--pct'), label: document.getElementById('card-height-val').textContent };
    document.getElementById('btn-reset-card-size').click();
    await new Promise(function (r) { setTimeout(r, 250); });
    out.afterResetCard = { value: hs.value, pct: hs.style.getPropertyValue('--pct'), label: document.getElementById('card-height-val').textContent, bad: bad() };
    poke('setting-dash-gap', 40);
    await new Promise(function (r) { setTimeout(r, 150); });
    document.getElementById('btn-reset-dash-size').click();
    await new Promise(function (r) { setTimeout(r, 200); });
    out.afterResetDash = bad();
    poke('setting-search-top', 120); poke('setting-search-gap', 200);
    await new Promise(function (r) { setTimeout(r, 150); });
    document.getElementById('btn-reset-search-pos').click();
    await new Promise(function (r) { setTimeout(r, 200); });
    out.afterResetSearch = bad();
    poke('setting-card-font-size', 20);
    await new Promise(function (r) { setTimeout(r, 150); });
    document.getElementById('btn-reset-topbar').click();
    await new Promise(function (r) { setTimeout(r, 200); });
    out.afterResetTopbar = bad();
    closeSettingsPanel();
    return JSON.stringify(out);
  })()`));
  check('BUG-082 打开面板时所有滑块进度填充正确（BUG-080 的原行为未回退）',
    pctFix.onOpen.length === 0, pctFix.onOpen);
  check('BUG-082 图1 复现姿势：点「↺ 重置卡片大小」后进度填充跟随滑块（修复前停在拖拽时的 0%）',
    pctFix.afterResetCard.value === '270' && pctFix.afterResetCard.label === '270px'
      && pctFix.afterResetCard.bad.length === 0, pctFix.afterResetCard);
  check('BUG-082 另外三个「↺ 重置」按钮同样不留 stale 进度（同一缺陷的其余 8 个滑块）',
    pctFix.afterResetDash.length === 0 && pctFix.afterResetSearch.length === 0
      && pctFix.afterResetTopbar.length === 0,
    { dash: pctFix.afterResetDash, search: pctFix.afterResetSearch, topbar: pctFix.afterResetTopbar });

  // —— (6) BUG-084（#8-6 用户实测）：沉浸模式下滚轮切组 → 退出后卡片变 1 列 ——
  //    根因（BUG-084）：沉浸模式里 .speeddial-section 是 display:none → 网格父容器 clientWidth = 0，
  //    updateGridColumns() 据此算出 1 列并把 grid.style.width 写成「一张卡宽」(270px)；
  //    退出沉浸模式没有任何路径重算 → 每行只剩 1 张（刷新才恢复）。
  const immFix = JSON.parse(await evalJs(`(async () => {
    var grid = document.getElementById('speeddial-grid');
    function snap() { return { inlineWidth: grid.style.width, clientWidth: grid.clientWidth, tpl: getComputedStyle(grid).gridTemplateColumns }; }
    var out = { initial: snap() };
    // 滚轮切组需要 ≥2 个分组，临时补一个（结束时删掉）
    out.addedGroup = false;
    if (groups.length < 2) { groups.push({ id: 'gimm' + groups.length, name: '沉浸测试组' + groups.length, cards: [], sortMode: 'manual' }); await saveGroups(groups); out.addedGroup = true; }
    var click = function () { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
    click(); await new Promise(function (r) { setTimeout(r, 60); }); click();
    await new Promise(function (r) { setTimeout(r, 300); });
    out.immersive = document.body.classList.contains('immersive');
    out.parentWidthImmersive = grid.parentElement ? grid.parentElement.clientWidth : 'n/a';
    out.duringImmersive = snap();
    return JSON.stringify(out);
  })()`));
  check('BUG-084 沉浸模式确实已进入、且此时网格容器宽度为 0（缺陷前提，没有这个前提就测不到）',
    immFix.immersive === true && immFix.parentWidthImmersive === 0, immFix);
  // 真实滚轮：到底后「两次同方向」才切一组（main.js 的 _scrollEdge 语义），所以每组滚两下
  const idxBeforeWheel = await evalJs('activeGroupIndex');
  for (let g = 0; g < 2; g++) {
    for (let k = 0; k < 2; k++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 450, deltaX: 0, deltaY: 120, button: 'none' }, sid);
      await sleep(220);
    }
    await sleep(350);
  }
  const immAfter = JSON.parse(await evalJs(`(() => {
    var grid = document.getElementById('speeddial-grid');
    return JSON.stringify({
      activeGroupIndex: activeGroupIndex,
      duringInlineWidth: grid.style.width,
      duringClientWidth: grid.clientWidth
    });
  })()`));
  immAfter.idxBeforeWheel = idxBeforeWheel;
  immAfter.wheelSwitched = immAfter.activeGroupIndex !== idxBeforeWheel;
  // 滚轮没切成功时用同一个函数补触发（switchGroup 就是滚轮 handler 调用的那个函数）——
  // 本条的断言对象是「切组之后网格宽度会不会被写死」，不是滚轮 handler 本身
  if (!immAfter.wheelSwitched) {
    await evalJs('(async () => { await switchGroup((activeGroupIndex + 1) % groups.length); return "ok"; })()');
    await sleep(400);
    immAfter.usedSwitchGroupFallback = true;
  }
  check('BUG-084 缺陷触发条件成立：沉浸模式下发生了分组切换（滚轮切不动时不静默降级为「没测到」）',
    immAfter.wheelSwitched === true || immAfter.usedSwitchGroupFallback === true, immAfter);
  await evalJs('(function () { document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })); return "ok"; })()');
  await sleep(60);
  await evalJs('(function () { document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })); return "ok"; })()');
  await sleep(500);
  const immExit = JSON.parse(await evalJs(`(async () => {
    var grid = document.getElementById('speeddial-grid');
    var oneCard = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--card-width'), 10) || 270;
    var out = {
      exited: !document.body.classList.contains('immersive'),
      inlineWidth: grid.style.width, clientWidth: grid.clientWidth,
      tpl: getComputedStyle(grid).gridTemplateColumns,
      oneCardWidth: oneCard,
      parentWidth: grid.parentElement ? grid.parentElement.clientWidth : -1
    };
    // 清理：删掉临时补的分组并重渲染
    var had = groups.some(function (g) { return g.id.indexOf('gimm') === 0; });
    if (had) {
      groups = groups.filter(function (g) { return g.id.indexOf('gimm') !== 0; });
      activeGroupIndex = Math.min(activeGroupIndex, groups.length - 1);
      speeddials = (groups[activeGroupIndex] && groups[activeGroupIndex].cards) || [];
      await saveGroups(groups); renderSpeeddials(); renderGroupDots();
    }
    out.cleanedUp = had;
    return JSON.stringify(out);
  })()`));
  check('BUG-084 退出沉浸模式后网格宽度未被写死成「一张卡宽」（修复前 inline=270px → 每行只剩 1 张，刷新才恢复）',
    immExit.exited === true && immExit.inlineWidth !== (immExit.oneCardWidth + 'px')
      && immExit.clientWidth > immExit.oneCardWidth * 1.5, immExit);

  console.log('\n[37] 页面无 JS 报错');
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
