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

  console.log('\n[10] P1-10 权限收窄 + 运行时授权');
  const mf = JSON.parse(await evalJs('JSON.stringify(chrome.runtime.getManifest())'));
  check('host_permissions 已收窄为 https', JSON.stringify(mf.host_permissions) === JSON.stringify(['https://*/*']), mf.host_permissions);
  check('http 改为可选权限', JSON.stringify(mf.optional_host_permissions) === JSON.stringify(['http://*/*']), mf.optional_host_permissions);
  check('hasHttpHostPermission 返回布尔且不抛错', (await evalJs('(async () => typeof (await hasHttpHostPermission()))()')) === 'boolean');
  check('https 地址无需申请权限', (await evalJs('(async () => await ensurePermissionForUrl("https://example.com/x"))()')) === true);
  check('无协议地址直接放行', (await evalJs('(async () => await ensurePermissionForUrl(""))()')) === true);
  const httpResult = await evalJs('(async () => typeof (await ensurePermissionForUrl("http://192.168.1.1/dav")))()');
  check('http 地址返回布尔（未授权时不抛错、走降级）', httpResult === 'boolean', httpResult);
  check('WebDAV 按钮已接入权限守卫', (await evalJs('typeof ensurePermissionForUrl === "function" && typeof requestHttpHostPermission === "function"')));
  check('批量截图已接入 http 权限降级', (await evalJs('startBatchCapture.toString().includes("httpTargets")')));

  console.log('\n[11] P2 看板 12 列栅格 / 跨列 / 拖拽 / 数据迁移');
  check('组件注册表含 4 个组件（P3-4 新增待办）', (await evalJs('DASHBOARD_WIDGETS.length')) === 4, await evalJs('DASHBOARD_WIDGETS.map(w=>w.id).join(",")'));
  check('组件默认跨列合计仍为 12', (await evalJs('DASHBOARD_WIDGETS.reduce((n,w)=>n+w.defaultSpan,0)')) === 12, await evalJs('DASHBOARD_WIDGETS.reduce((n,w)=>n+w.defaultSpan,0)'));
  check('栅格为 12 列', (await evalJs('getComputedStyle(document.getElementById("dashboard-grid")).gridTemplateColumns.split(" ").length')) === 12);
  const spans = JSON.parse(await evalJs('JSON.stringify([...document.querySelectorAll("#dashboard-grid .dashboard-item")].map(e=>[e.dataset.widget, e.style.gridColumn]))'));
  check('每个组件都写入了 grid-column', spans.every(x => /^span \d+$/.test(x[1])), spans);
  check('布局模型覆盖全部注册组件', (await evalJs('(() => { const l = getDashboardLayout(); return Object.keys(l).length === DASHBOARD_WIDGETS.length && DASHBOARD_WIDGETS.every(w => typeof l[w.id].order === "number" && typeof l[w.id].span === "number"); })()')) === true);

  // 跨列调节：−/＋ 按钮 + 上下限钳制
  await evalJs('toggleDashEdit()');
  const spanBefore = await evalJs('getDashboardLayout().clock.span');
  await evalJs('document.querySelector(\'[data-widget="clock"] .dash-span-grow\').click()');
  await sleep(500);
  check('＋ 增大跨列', (await evalJs('getDashboardLayout().clock.span')) === spanBefore + 1, { spanBefore, after: await evalJs('getDashboardLayout().clock.span') });
  check('跨列写入 DOM', (await evalJs('document.querySelector(\'[data-widget="clock"]\').style.gridColumn')) === 'span ' + (spanBefore + 1));
  // 钳制到 12
  for (let i = 0; i < 15; i++) await evalJs('document.querySelector(\'[data-widget="clock"] .dash-span-grow\').click()');
  await sleep(600);
  check('跨列上限钳制为 12', (await evalJs('getDashboardLayout().clock.span')) === 12);
  for (let i = 0; i < 15; i++) await evalJs('document.querySelector(\'[data-widget="clock"] .dash-span-shrink\').click()');
  await sleep(600);
  check('跨列下限钳制为 minSpan', (await evalJs('getDashboardLayout().clock.span')) === (await evalJs('DASHBOARD_WIDGETS.find(w=>w.id==="clock").minSpan')));

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

  // 数据迁移：只留旧版 dashboardOrder 数组 → 重新加载后应还原顺序
  await evalJs(`(async () => {
    await flushSyncWrites();
    const s = Object.assign({}, currentSettings);
    delete s.dashboardLayout;
    s.dashboardOrder = ['lunar', 'clock', 'weather'];
    await new Promise(r => chrome.storage.sync.set({ settings: s }, r));
    return 'ok';
  })()`);
  await send('Page.navigate', { url: `chrome-extension://${EXT_ID}/index.html` }, sid);
  await sleep(1500);
  const ready = await waitForReady();
  check('迁移测试：页面重新加载就绪', ready === true);
  const migrated = JSON.parse(await evalJs('JSON.stringify(Object.fromEntries(Object.entries(getDashboardLayout()).map(([k,v])=>[k,v.order])))'));
  check('旧 dashboardOrder 迁移为 order（lunar=0, clock=1, weather=2）', migrated.lunar === 0 && migrated.clock === 1 && migrated.weather === 2, migrated);
  check('迁移后跨列取默认值', (await evalJs('getDashboardLayout().clock.span')) === (await evalJs('DASHBOARD_WIDGETS.find(w=>w.id==="clock").defaultSpan')), await evalJs('getDashboardLayout().clock.span'));

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
  await evalJs('closeGroupManager()');
  await sleep(300);

  console.log('\n[13] P3-1 卡片多选批量操作');
  await evalJs('clearCardSelection()');
  const cardCount = await evalJs('document.querySelectorAll("#speeddial-grid .card-wrapper[data-id]").length');
  check('当前分组卡片数足够测试', cardCount >= 3, cardCount);

  // Ctrl+点击选中两张（不应打开卡片）
  await evalJs(`(() => {
    const cards = [...document.querySelectorAll('#speeddial-grid .card-wrapper[data-id]')];
    cards[0].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    cards[2].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    return 'ok';
  })()`);
  await sleep(250);
  check('Ctrl+点击选中 2 张', (await evalJs('getSelectedCardIds().length')) === 2, await evalJs('JSON.stringify(getSelectedCardIds())'));
  check('选中卡片带 .selected 样式', (await evalJs('document.querySelectorAll("#speeddial-grid .card-wrapper.selected").length')) === 2);
  check('工具栏出现且计数正确', (await evalJs('document.getElementById("batch-count").textContent')) === '已选 2 张');
  check('Ctrl+点击不会打开卡片', (await evalJs('location.href')).includes('index.html'));

  // Shift 区间选中
  await evalJs(`(() => { const c=[...document.querySelectorAll('#speeddial-grid .card-wrapper[data-id]')]; c[1].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})); return 'ok'; })()`);
  await evalJs(`(() => { const c=[...document.querySelectorAll('#speeddial-grid .card-wrapper[data-id]')]; c[0].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true})); return 'ok'; })()`);
  await sleep(250);
  check('Shift 区间选中生效', (await evalJs('getSelectedCardIds().length')) >= 2, await evalJs('getSelectedCardIds().length'));

  // 批量移动
  await evalJs('(async () => { await _applyGroupImport({ type: "deeppage-group", version: 1, group: { name: "批量目标组", cards: [] } }); return "ok"; })()');
  await evalJs(`(() => { const c=[...document.querySelectorAll('#speeddial-grid .card-wrapper[data-id]')]; clearCardSelection(); c[0].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})); c[1].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})); return 'ok'; })()`);
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
  await evalJs(`(() => { const c=[...document.querySelectorAll('#speeddial-grid .card-wrapper[data-id]')]; c[0].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})); return 'ok'; })()`);
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
  await evalJs(`(() => { const c=[...document.querySelectorAll('#speeddial-grid .card-wrapper[data-id]')]; c[0].querySelector('.speeddial-card').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})); return 'ok'; })()`);
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
  check('Ctrl+A 全选当前分组', (await evalJs('getSelectedCardIds().length')) === (await evalJs('document.querySelectorAll("#speeddial-grid .card-wrapper[data-id]").length')));
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

  console.log('\n[16] 页面无 JS 报错');
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
