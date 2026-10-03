/*
   备份 / WebDAV 批次端到端验证（v1.5.5 审计剩余：BUG-040 / 042 / 043 / 044 / 050 / 054 / 061）
   运行: node tests/e2e-webdav.test.js   （或 npm run test:e2e）
   前置: CHROME_BIN 指向 Chromium 构建，默认 /usr/bin/chromium

   与其它 E2E 的区别：本文件在**测试进程内起一个真实的 WebDAV 服务器**（tests/lib/webdav-test-server.js，
   零依赖），因此不只断言「扩展发了什么请求」，还能断言「服务端最终留下了什么」——
   这正是 v1.5.5 审计里「未做真实 WebDAV 服务器联调」那条边界。

   退出码: 0 = 通过 ｜ 1 = 断言失败或测试崩溃（CI 必须红）｜ 3 = 环境不满足（显式跳过）
   自检: DP_E2E_SELFTEST=crash 会在建连前抛错（供 tests/e2e-exit-code.test.js 验证「崩溃 → 1」）
   探针: DP_EXT_DIR=<目录> 可指向另一份扩展源码 —— 「修复前 / 后对比」就是拿它跑同一套断言，
         例如 DP_EXT_DIR=/tmp/old/src node tests/e2e-webdav.test.js（旧代码应当在对应断言上失败）
*/
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWebdavServer } = require('./lib/webdav-test-server');
const { createConsoleErrorCollector } = require('./lib/console-error-filter');

const SRC = process.env.DP_EXT_DIR ? path.resolve(process.env.DP_EXT_DIR) : path.resolve(__dirname, '../src');
const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';
// 随机端口 + 每次独立 profile：避免与残留浏览器实例、并行测试撞车
const PORT = 9300 + Math.floor(Math.random() * 500);
const PROFILE = `/tmp/dp-e2e-profile-${process.pid}`;
/** 环境不满足的专用退出码：CI 只对这一个码放行（并打 warning），其余非 0 一律红 */
const EXIT_ENV_SKIP = 3;

if (!fs.existsSync(CHROME)) {
  console.error(`⚠️ 未找到 Chromium（${CHROME}）—— 设置 CHROME_BIN 环境变量后重试，跳过本次 E2E`);
  process.exit(EXIT_ENV_SKIP);
}

// ---- 真实 WebDAV 服务器：根目录下 dav/DeepPage 是备份目录，根目录另有哨兵文件 ----
const DAV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-dav-'));
const DAV_DIR = path.join(DAV_ROOT, 'dav', 'DeepPage');
const DAV_CONFIG_DIR = path.join(DAV_DIR, 'config');
const DAV_IMG_DIR = path.join(DAV_DIR, 'img');
const SENTINEL = path.join(DAV_ROOT, 'pwned.txt');
fs.mkdirSync(DAV_CONFIG_DIR, { recursive: true });
fs.mkdirSync(DAV_IMG_DIR, { recursive: true });
fs.writeFileSync(SENTINEL, 'sentinel-outside-backup-dir');
const dav = createWebdavServer(DAV_ROOT);
const davManifest = () => JSON.parse(fs.readFileSync(path.join(DAV_DIR, 'manifest.json'), 'utf8'));
const davConfig = (name) => JSON.parse(fs.readFileSync(path.join(DAV_CONFIG_DIR, name), 'utf8'));

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

function killBrowser() {
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {
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
  if (process.env.DP_E2E_SELFTEST === 'crash') throw new Error('DP_E2E_SELFTEST=crash（自检注入的崩溃）');
  const davPort = await dav.listen(0);
  const DAV_URL = `http://127.0.0.1:${davPort}/dav/DeepPage`;
  console.log('WebDAV 测试服务器:', DAV_URL, '→ 根目录', DAV_ROOT);

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
      consoleLog.add(msg.params.args.map(a => a.value || a.description).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleLog.addException(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
  };

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
    return [...new Set([...primary, ...others, EXT_ID])];
  }

  async function tryOpenPage(id) {
    const t = await send('Target.createTarget', { url: `chrome-extension://${id}/index.html` });
    const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const session = a.sessionId;
    await send('Runtime.enable', {}, session);
    await send('Page.enable', {}, session);
    await sleep(2000);
    const r = await send('Runtime.evaluate', {
      expression: '!!document.getElementById("dashboard-grid")', returnByValue: true,
    }, session);
    return { targetId: t.targetId, sid: session, ok: !!(r.result && r.result.value) };
  }

  const candidates = await collectCandidateIds();
  let page = null;
  for (const id of candidates) {
    const attempt = await tryOpenPage(id);
    if (attempt.ok) { EXT_ID = id; page = attempt; console.log(`✅ 扩展页面已加载，使用 ID: ${id}`); break; }
    try { await send('Target.closeTarget', { targetId: attempt.targetId }); } catch (e) { /* 忽略 */ }
  }
  if (!page) {
    console.error('⚠️ 环境无法加载本扩展（所有候选 ID 都打不开 index.html）—— 跳过 E2E');
    ws.close(); killBrowser(); dav.close();
    process.exit(EXIT_ENV_SKIP);
  }
  const sid = page.sid;

  async function waitForReady(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await send('Runtime.evaluate', {
          expression: 'typeof currentSettings === "object" && !!currentSettings &&' +
            ' document.querySelectorAll("#dashboard-grid .dashboard-item").length === DASHBOARD_WIDGETS.length',
          returnByValue: true,
        }, sid);
        if (r.result && r.result.value === true) return true;
      } catch (e) { /* 页面还在导航，重试 */ }
      await sleep(300);
    }
    return false;
  }
  if (!(await waitForReady())) {
    console.error('⚠️ 页面 init 未在 20s 内就绪，跳过 E2E');
    ws.close(); killBrowser(); dav.close();
    process.exit(EXIT_ENV_SKIP);
  }

  const evalJs = async (expr, userGesture) => {
    const r = await send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true, userGesture: !!userGesture }, sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result.value;
  };
  const evalJson = async (expr, userGesture) => JSON.parse(await evalJs(expr, userGesture));
  /** 直接给 SW 发消息（模拟页面 API 层，但不经 _wdSend 的封装，便于构造恶意 payload） */
  const rawMsg = (type, payload) => `new Promise(r=>chrome.runtime.sendMessage({type:${JSON.stringify(type)},payload:${JSON.stringify(payload)}},resp=>r(JSON.stringify(resp))))`;

  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
  };

  /** 段落包裹：某一段异常不应吞掉后面七段的结论（探针模式下尤其重要 ——
   *  旧代码常常缺函数/缺字段，逐段 try/catch 才能一次跑出完整的「修复前 vs 修复后」对照） */
  const section = async (title, fn) => {
    console.log('\n' + title);
    try { await fn(); }
    catch (e) { fail++; console.log('  ❌ 本段异常中断 → ' + (e && e.message)); }
  };

  console.log('\n[0] 环境准备：http 可选权限 + WebDAV 凭据');
  // v1.3.3 起 http 地址走可选权限（optional_host_permissions）。headless 下 chrome.permissions.request
  // 不会回调（没有人能点那个权限气泡），因此这里**带超时的尽力而为**：
  // 拿到权限就走「有 host 权限」的路径，拿不到也不影响 —— 测试服务器带完整 CORS 响应头，
  // SW 的 fetch 会退化成普通 CORS 请求（这本身也覆盖了 http 地址未授权时的实际行为）。
  const granted = await evalJs(`new Promise(r => {
    var done = false;
    var t = setTimeout(function () { if (!done) { done = true; r('timeout'); } }, 3000);
    try {
      chrome.permissions.request({ origins: ['http://*/*'] }, function (g) {
        if (done) return; done = true; clearTimeout(t); r(!!g);
      });
    } catch (e) { if (!done) { done = true; clearTimeout(t); r('error:' + e.message); } }
  })`, true);
  console.log('    http://*/* 可选权限:', granted);
  await evalJs(`new Promise(r => chrome.storage.local.set({
    webdav_url: ${JSON.stringify(DAV_URL)},
    webdav_user: 'u',
    webdav_pass: ${JSON.stringify(Buffer.from('密码123', 'utf8').toString('base64'))}
  }, r))`);
  check('WebDAV 测试服务器已启动', davPort > 0);
  check('凭据写入 storage.local（UTF-8 编码的密码）', (await evalJs(`new Promise(r=>chrome.storage.local.get(['webdav_url','webdav_pass'],x=>r(x.webdav_url===${JSON.stringify(DAV_URL)} && !!x.webdav_pass)))`)) === true);
  // 先探一次连通性，失败时给出明确原因（而不是后面 20 条断言集体失败）
  const ping = await evalJson(`webdavPutManifest({version:1,images:{},configs:[]}).then(()=>JSON.stringify({ok:true})).catch(e=>JSON.stringify({ok:false,error:e.message}))`);
  check('扩展能连通测试服务器（真实 HTTP 往返）', ping.ok === true, ping);

  await section('[1] BUG-054 含中文的密码能正确编码 / 解码成 Basic 凭据', async () => {
    dav.resetLog();
    await evalJs(`webdavPutManifest({version:1,images:{},configs:[]})`);
    const putAuth = (dav.state.log.find(l => l.method === 'PUT') || {}).auth || '';
    const decoded = putAuth.startsWith('Basic ') ? Buffer.from(putAuth.slice(6), 'base64').toString('utf8') : '';
    check('服务端收到的 Basic 凭据解码为 u:密码123（UTF-8 全链路）', decoded === 'u:密码123', { got: decoded, raw: putAuth.slice(0, 40) });
    check('manifest 已真实落盘', fs.existsSync(path.join(DAV_DIR, 'manifest.json')));

    // 真正的用户路径：在设置面板里填中文密码 → 点「💾 保存配置」
    // 修复前 btoa(中文) 抛 InvalidCharacterError 且无 try/catch：不落库、无任何提示
    await evalJs(`openSettingsPanel()`);
    await sleep(600);
    await evalJs(`(() => {
      document.getElementById('webdav-url').value = ${JSON.stringify(DAV_URL)};
      document.getElementById('webdav-user').value = 'u';
      document.getElementById('webdav-pass').value = '密码123';
      document.getElementById('btn-webdav-save').click();
      return 'ok';
    })()`);
    await sleep(500);
    const savedPass = await evalJs(`new Promise(r=>chrome.storage.local.get(['webdav_pass'],x=>r(x.webdav_pass||'')))`);
    const statusText = await evalJs(`document.getElementById('webdav-config-status').textContent`);
    check('中文密码能保存成功（修复前抛异常 → 静默不保存）', savedPass === Buffer.from('密码123', 'utf8').toString('base64'), { savedPass, statusText });
    check('界面给出保存成功提示', /已保存/.test(statusText), statusText);
    // 反向：重新打开面板时密码框应回填出原文（atob 路径也要是 UTF-8 安全的）
    const refilled = await evalJs(`(async () => {
      document.getElementById('webdav-pass').value = '';
      await new Promise(r => chrome.storage.local.get(['webdav_pass'], r));
      initWebdavSection();
      await new Promise(r => setTimeout(r, 300));
      return document.getElementById('webdav-pass').value;
    })()`);
    check('重新初始化后面板回填出中文密码原文', refilled === '密码123', refilled);
    await evalJs(`closeSettingsPanel()`);
    await sleep(200);
  });
  await section('[2] BUG-042 目录穿越：远端可控文件名不得越出备份目录', async () => {
    dav.resetLog();
    const evilNames = [
      '../../../../pwned.txt',
      '..%2F..%2F..%2F..%2Fpwned.txt',
      '/etc/passwd',
      'a/b.json',
      '..',
      '.hidden',
      'x'.repeat(129),
      'name with space.json'
    ];
    const evilResults = [];
    for (const nm of evilNames) {
      const r = await evalJson(rawMsg('webdav:config-delete', { _filename: nm }));
      evilResults.push({ nm, ok: r.ok, error: r.error });
    }
    const evilImg = await evalJson(rawMsg('webdav:img-delete', { _filename: '../../pwned.txt' }));
    check('全部非法文件名被 SW 拒绝', evilResults.every(r => r.ok === false), evilResults.filter(r => r.ok));
    check('IMG_DELETE 同样被拒', evilImg.ok === false, evilImg);
    check('服务器没有收到任何 DELETE 请求（越界删除未发生）', dav.pathsFor('DELETE').length === 0, dav.pathsFor('DELETE'));
    check('备份目录之外的哨兵文件仍然存在', fs.existsSync(SENTINEL));

    // 探针友好：修复前的代码会真的删掉备份目录/哨兵文件（这正是缺陷本身），
    // 这里把目录恢复回来，好让同一套断言继续跑完，得到完整的「修复前 vs 修复后」对照。
    fs.mkdirSync(DAV_CONFIG_DIR, { recursive: true });
    fs.mkdirSync(DAV_IMG_DIR, { recursive: true });
    if (!fs.existsSync(SENTINEL)) fs.writeFileSync(SENTINEL, 'sentinel-outside-backup-dir');

    // 合法名不受影响：真建一个 config 文件再删
    fs.writeFileSync(path.join(DAV_CONFIG_DIR, '20260101_000000.json'), JSON.stringify({ groups: [] }));
    const delOk = await evalJson(rawMsg('webdav:config-delete', { _filename: '20260101_000000.json' }));
    check('合法文件名仍可正常删除', delOk.ok === true && !fs.existsSync(path.join(DAV_CONFIG_DIR, '20260101_000000.json')), delOk);
    const manifestRound = await evalJson(`webdavGetManifest().then(m => JSON.stringify(m))`);
    check('合法路径的 manifest 读写正常（净化没有误伤）', manifestRound && manifestRound.version === 1, manifestRound);

  });
  await section('[3] BUG-050 云端 manifest 的恶意字段不得注入设置页（转义 + 白名单）', async () => {
    fs.writeFileSync(path.join(DAV_DIR, 'manifest.json'), JSON.stringify({
      version: 1,
      images: {},
      configs: [
        { name: '"><img src=x onerror="window.__pwned=1">', time: Date.now(), cardCount: '<b>9</b>' },
        { name: '20260101_010101.json', time: Date.now() - 60000, cardCount: 3 }
      ]
    }));
    await evalJs(`webdavIncrementalRestore()`);
    await sleep(500);
    const injected = await evalJs(`document.querySelectorAll('#webdav-version-list img, #webdav-version-list b').length`);
    const pwned = await evalJs(`typeof window.__pwned`);
    const rows = await evalJs(`document.querySelectorAll('#webdav-version-list .webdav-version-item').length`);
    const disabled = await evalJs(`document.querySelectorAll('#webdav-version-list input[type=radio]:disabled').length`);
    const enabled = await evalJs(`document.querySelectorAll('#webdav-version-list input[type=radio]:not(:disabled)').length`);
    check('版本列表已渲染出两行', rows === 2, { rows });
    check('恶意 name/cardCount 没有被解析成元素（无 img/b 注入）', injected === 0, { injected });
    check('onerror 未执行（window.__pwned 未定义）', pwned === 'undefined', pwned);
    check('非法名那一行被禁用（不可选、不可删）', disabled === 1, { disabled });
    check('合法名那一行仍可选', enabled === 1, { enabled });
    const delSpans = await evalJs(`document.querySelectorAll('#webdav-version-list .version-delete').length`);
    check('非法行没有删除按钮（不成为删除目标）', delSpans === 1, { delSpans });

  });
  await section('[4] BUG-043 导入设置白名单（两条导入路径共用）', async () => {
    const malicious = await evalJson(`JSON.stringify(normalizeImportedSettings({
      wallpaperMode: 'custom',
      wallpaperUrl: 'http://evil.tld/px.png',
      weatherApiUrl: 'http://evil.tld/w?key={key}',
      weatherApiKey: 'SECRET',
      cardWidth: -999,
      cardOpacity: 1e12,
      theme: 'evil-theme',
      columns: 'abc',
      searchEngines: [
        { id: 'evil', name: 'E', url: 'http://evil.tld/s?q={q}', enabled: true },
        { id: 'evil2', name: 'E2', url: 'https://evil.tld/s?q=', enabled: true },
        { id: 'ok', name: 'OK', url: 'https://good.tld/s?q={q}', enabled: true }
      ],
      unknownKey: { evil: true },
      __proto__: { polluted: true }
    }))`);
    check('http 的 wallpaperUrl 被丢弃', malicious.wallpaperUrl === undefined, malicious.wallpaperUrl);
    check('http 的 weatherApiUrl 被丢弃', malicious.weatherApiUrl === undefined, malicious.weatherApiUrl);
    check('未知键被丢弃', malicious.unknownKey === undefined);
    check('越界数值被丢弃（cardWidth 用默认值）', malicious.cardWidth === undefined && malicious.cardOpacity === undefined, { w: malicious.cardWidth, o: malicious.cardOpacity });
    check('非法枚举值被丢弃', malicious.theme === undefined, malicious.theme);
    check('类型不符被丢弃', malicious.columns === undefined, malicious.columns);
    check('searchEngines 只保留合法项（http 与缺 {q} 都被剔除）', Array.isArray(malicious.searchEngines) && malicious.searchEngines.length === 1 && malicious.searchEngines[0].id === 'ok', malicious.searchEngines);
    check('原型未被污染', (await evalJs(`({}).polluted === undefined`)) === true);
    const legit = await evalJson(`JSON.stringify(normalizeImportedSettings(Object.assign({}, DEFAULT_SETTINGS, {
      theme: 'dark', columns: 4, cardWidth: 300,
      dashboardWidgetLayout: { clock: { order: 1, span: 5 }, weather: { order: 0, span: 3 } },
      todoItems: [{ id: 't1', text: '买牛奶', done: false }],
      localWallpapers: [{ key: 'wp__1_ab12', name: '我的壁纸', opacity: 55 }]
    })))`);
    check('合法设置逐键保留（合法备份不被误伤）', legit.theme === 'dark' && legit.columns === 4 && legit.cardWidth === 300, { theme: legit.theme, columns: legit.columns, cardWidth: legit.cardWidth });
    check('看板组件布局保留（表单管不到的字段不能被白名单吃掉）', !!legit.dashboardWidgetLayout && legit.dashboardWidgetLayout.clock.span === 5, legit.dashboardWidgetLayout);
    check('待办与本地壁纸保留', (legit.todoItems || []).length === 1 && (legit.localWallpapers || []).length === 1, { t: legit.todoItems, w: legit.localWallpapers });
    check('拒掉的键计数正确', (await evalJs(`countRejectedSettings({a:1,cardWidth:-999,theme:'evil'}, normalizeImportedSettings({a:1,cardWidth:-999,theme:'evil'}))`)) === 3);

    // 真实 ZIP 导入路径：_importConfig 必须走同一套白名单（审计原话是「导入路径完全绕过校验」）
    const beforeSettings = await evalJs(`JSON.stringify(currentSettings)`);
    const imported = await evalJson(`(async () => {
      const config = { settings: { theme: 'dark', wallpaperUrl: 'http://evil.tld/px.png', weatherApiUrl: 'http://evil.tld/w?key={key}' }, groups: [], activeGroup: 0 };
      const unzipped = {
        'config.json': fflate.strToU8(JSON.stringify(config)),
        'manifest.json': fflate.strToU8(JSON.stringify({ images: [] }))
      };
      await _importConfig(unzipped, { images: [] });
      const s = await new Promise(r => chrome.storage.sync.get(['settings'], x => r(x.settings || {})));
      return JSON.stringify({ wallpaperUrl: s.wallpaperUrl, weatherApiUrl: s.weatherApiUrl, theme: s.theme });
    })()`);
    check('ZIP 导入路径同样过滤：http 外链不落库、合法项保留', imported.wallpaperUrl === undefined && imported.weatherApiUrl === undefined && imported.theme === 'dark', imported);
    // 还原设置，避免影响后续段落
    await evalJs(`new Promise(r => chrome.storage.sync.set({ settings: ${beforeSettings} }, r))`);
    await sleep(400);
  });
  await section('[5] BUG-044 单分组导出/导入必须带出本地图片', async () => {
    const groupRound = await evalJson(`(async () => {
      const bytes = new Uint8Array([137,80,78,71,13,10,26,10,1,2,3,4,5,6,7,8]);
      await saveImage('cardimg_e2e44', new Blob([bytes], { type: 'image/png' }));
      groups = [{ id: 'g_e2e44', name: '导出测试组', sortMode: 'manual',
        cards: [{ id: 'c_e2e44', name: '卡片', url: 'https://example.com/', image: 'idx:cardimg_e2e44' }] }];
      activeGroupIndex = 0; speeddials = groups[0].cards;
      await saveGroups(groups);
      const data = await _buildGroupExport('g_e2e44');
      const out = { imageKeys: Object.keys(data.images || {}), dataUrlHead: (data.images['idx:cardimg_e2e44'] || '').slice(0, 22) };
      const g2 = await _applyGroupImport(data);
      out.importedImage = g2.cards[0].image;
      const key2 = String(g2.cards[0].image).replace('idx:', '');
      const blob2 = await loadImage(key2);
      out.importedBytes = blob2 ? blob2.size : -1;
      out.importedName = g2.name;
      return JSON.stringify(out);
    })()`);
    check('导出的分组文件里含 1 张内联图片', groupRound.imageKeys.length === 1 && groupRound.imageKeys[0] === 'idx:cardimg_e2e44', groupRound.imageKeys);
    check('内联的是 dataURL', groupRound.dataUrlHead.startsWith('data:image/'), groupRound.dataUrlHead);
    check('导入后图片键被重映射且能读回（字节数一致）', String(groupRound.importedImage).indexOf('idx:cardimg_') === 0 && groupRound.importedBytes === 16, groupRound);

  });
  // ---- BUG-040 / BUG-061 共用：构造一次真实增量备份（图片字节固定 → Node 侧能算出同一个 sha256）----
  const IMG_BYTES = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
  const imgSha = crypto.createHash('sha256').update(Buffer.from(IMG_BYTES)).digest('hex');
  const runBackup = (key) => evalJs(`(async () => {
    currentSettings.backupIncludeImages = true;
    const data = {
      config: { settings: currentSettings, groups: groups, activeGroup: 0 },
      images: [{ key: ${JSON.stringify(key)}, blob: new Blob([new Uint8Array(${JSON.stringify(IMG_BYTES)})], { type: 'image/png' }) }]
    };
    return await _incrementalBackup(data, true);
  })()`);

  await section('[6] BUG-040 图片上传失败不得记入 manifest，且下次必须重试', async () => {
    dav.state.failPut = imgSha;   // 让这张图的上传必定失败（507）
    const ok1 = await runBackup('cardimg_fail40');
    check('上传失败时备份返回 false（不再假装成功）', ok1 === false, ok1);
    check('服务端确实收到了失败注入的 PUT', dav.state.failPutCount >= 1, dav.state.failPutCount);
    const man1 = davManifest();
    check('失败图片没有写进云端 manifest（修复前会写进去）', !man1.images['cardimg_fail40'], Object.keys(man1.images));
    const cfgName1 = man1.configs[0].name;
    const cfg1 = davConfig(cfgName1);
    check('失败图片没有写进配置快照的 imageRefs', !cfg1.imageRefs['cardimg_fail40'], Object.keys(cfg1.imageRefs));
    check('云端确实没有这张图片文件', !fs.existsSync(path.join(DAV_IMG_DIR, imgSha + '.bin')));

    dav.state.failPut = null;
    await sleep(1100);   // _genConfigName 精确到秒，避免两次备份撞同名
    const ok2 = await runBackup('cardimg_fail40');
    check('恢复后重跑备份成功', ok2 === true, ok2);
    const man2 = davManifest();
    check('重跑后图片被补传并记入 manifest（未被永久跳过）', !!man2.images['cardimg_fail40'] && man2.images['cardimg_fail40'].md5 === imgSha, man2.images['cardimg_fail40']);
    // 注意：IMG_PUT 的目标是 img/<md5>（webdav.js 传的 _filename 就是 md5，没有扩展名）
    check('图片文件已真实落盘', fs.existsSync(path.join(DAV_IMG_DIR, imgSha)), fs.readdirSync(DAV_IMG_DIR));

  });
  await section('[7] BUG-061 孤儿 GC 的结果必须落回云端 manifest', async () => {
    await sleep(1100);
    const staleMd5 = 'deadbeef'.repeat(8);
    fs.writeFileSync(path.join(DAV_IMG_DIR, staleMd5 + '.bin'), Buffer.from([1, 2, 3]));
    const man3 = davManifest();
    man3.images['cardimg_stale61'] = { md5: staleMd5, size: 3, type: 'image/png', refs: ['20200101_000000.json'] };
    // 同时塞一条「refs 里既有已淘汰 config 又有现存 config」的条目，验证 refs 会被收缩
    man3.images['cardimg_fail40'].refs = ['20200101_000000.json'].concat(man3.images['cardimg_fail40'].refs || []);
    fs.writeFileSync(path.join(DAV_DIR, 'manifest.json'), JSON.stringify(man3));
    check('播种成功：云端 manifest 含无引用的陈旧条目', !!davManifest().images['cardimg_stale61']);

    const ok3 = await runBackup('cardimg_keep61');
    const man4 = davManifest();
    check('备份成功', ok3 === true, ok3);
    check('陈旧条目已从云端 manifest 消失（修复前只改内存、永不落盘）', !man4.images['cardimg_stale61'], Object.keys(man4.images));
    check('陈旧图片文件已被 GC 删除（旧格式 <md5>.bin 共 68 字符必须通过文件名白名单）', !fs.existsSync(path.join(DAV_IMG_DIR, staleMd5 + '.bin')), fs.readdirSync(DAV_IMG_DIR));
    check('现存条目的 refs 已收缩（剔除已淘汰的 config 名）', (man4.images['cardimg_fail40'].refs || []).indexOf('20200101_000000.json') === -1, man4.images['cardimg_fail40'].refs);
    check('本轮新图片仍被保留', !!man4.images['cardimg_keep61']);

  });
  await section('[8] BUG-064 凭据回退区分「未提供」与「空值」（空密码 NAS / 部分凭据不再误用旧配置）', async () => {
    // storage.local 里存的是 DAV_URL + u/密码123；下面显式传另一台服务器 + 空密码
    const ALT_URL = `http://127.0.0.1:${davPort}/dav/OtherNas`;
    const basicUser = (l) => (l && l.auth && l.auth.startsWith('Basic ')) ? Buffer.from(l.auth.slice(6), 'base64').toString('utf8') : '';

    dav.resetLog();
    const explicitEmptyPass = await evalJson(`webdavTestConnection(${JSON.stringify({ url: ALT_URL, user: 'bob', pass: '' })}).then(function(){return JSON.stringify({ok:true})}).catch(function(e){return JSON.stringify({ok:false,error:e.message})})`);
    const optLog = dav.state.log.filter((l) => l.method === 'OPTIONS');
    const lastOpt = optLog[optLog.length - 1] || {};
    check('显式提供的凭据（含空密码）真的打向新服务器，而不是 storage 里的旧服务器',
      explicitEmptyPass.ok === true && lastOpt.path === '/dav/OtherNas',
      { res: explicitEmptyPass, paths: optLog.map((l) => l.path) });
    check('空密码按「空」发送（Basic bob:），不再被误判为「未配置」',
      basicUser(lastOpt) === 'bob:', { decoded: basicUser(lastOpt), raw: String(lastOpt.auth || '').slice(0, 30) });

    // 正对照：完全不带凭据时才回退 storage.local（旧行为必须保留）
    dav.resetLog();
    const fallback = await evalJson(`webdavTestConnection().then(function(){return JSON.stringify({ok:true})}).catch(function(e){return JSON.stringify({ok:false,error:e.message})})`);
    const opt2 = dav.state.log.filter((l) => l.method === 'OPTIONS');
    const last2 = opt2[opt2.length - 1] || {};
    check('未提供凭据时仍回退 storage.local（正对照：行为不变）',
      fallback.ok === true && last2.path === '/dav/DeepPage' && basicUser(last2) === 'u:密码123',
      { res: fallback, path: last2.path, decoded: basicUser(last2) });

    // 显式空值不得回退 storage：直接报「缺少服务器地址」（区分「未提供」与「空值」）
    dav.resetLog();
    const explicitEmptyUrl = await evalJson(`webdavTestConnection(${JSON.stringify({ url: '', user: 'bob', pass: '' })}).then(function(){return JSON.stringify({ok:true})}).catch(function(e){return JSON.stringify({ok:false,error:e.message})})`);
    check('显式空值不回退 storage（修复前会静默打到旧服务器并报「连接成功」）',
      explicitEmptyUrl.ok === false && /缺少服务器地址/.test(explicitEmptyUrl.error) &&
      dav.state.log.filter((l) => l.method === 'OPTIONS').length === 0,
      { res: explicitEmptyUrl, sent: dav.state.log.length });
  });
  await section('[9] 页面无 JS 报错', async () => {
    consoleLog.report();
    check('无 console error / 未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 3));

  });
  if (fail > 0) {
    console.log('\n--- 诊断：测试服务器收到的请求 ---');
    for (const l of dav.state.log) console.log('   ', l.method, l.path);
    console.log('--- img/ 目录 ---', fs.readdirSync(DAV_IMG_DIR));
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  ws.close();
  killBrowser();
  await dav.close();
  try { fs.rmSync(DAV_ROOT, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('❌ 测试崩溃（非环境问题，CI 必须红）:', e && e.stack || e);
  killBrowser();
  try { await dav.close(); } catch (e2) { /* 忽略 */ }
  process.exit(1);
});
