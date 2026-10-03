/* BUG-041 / AUD-001 反向对照：E2E 退出码语义（不需要浏览器）
   运行: node tests/e2e-exit-code.test.js （随 npm test）

   背景：退出码 2 曾被同时用于「环境不满足（跳过）」与「全局 catch 兜底」，
   而 ci.yml 把 2 一律映射为 exit 0 —— 页面/SW 真坏掉、测试崩溃、浏览器没装上全都静默变绿。
   本文件把新的语义钉死：
     · 环境不满足（浏览器不存在）→ 3，且日志明确说「跳过」
     · 未捕获异常 → 1，且日志不得出现「跳过」（防止崩溃再次伪装成环境问题）
   依赖 E2E 脚本里的自检钩子 DP_E2E_SELFTEST=crash（在建连前抛错）。
*/
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPTS = ['e2e-p0.test.js', 'e2e-sw-protocol.test.js', 'e2e-webdav.test.js'];
const NO_BROWSER = path.join(__dirname, '__no_such_browser_for_selftest__');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function run(file, env) {
  const r = spawnSync(process.execPath, [file], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60000,
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

for (const name of SCRIPTS) {
  const file = path.join(__dirname, name);
  const src = fs.readFileSync(file, 'utf8');
  console.log(`\n[${name}] 静态约定`);
  check('不再使用退出码 2（历史假绿通道）', !/process\.exit\(2\)/.test(src));
  check('声明环境跳过码 EXIT_ENV_SKIP = 3', /const EXIT_ENV_SKIP = 3;/.test(src));
  check('全局 catch 以退出码 1 结束', /\.catch\(async \(e\) => \{[\s\S]{0,400}?process\.exit\(1\);/.test(src));
  check('崩溃分支打印「测试崩溃」', /测试崩溃/.test(src));
  check('接入来源精确的 console 过滤器', /require\('\.\/lib\/console-error-filter'\)/.test(src));

  console.log(`\n[${name}] 环境不满足 → 3`);
  const skip = run(file, { CHROME_BIN: NO_BROWSER, DP_E2E_SELFTEST: '' });
  check('浏览器缺失时退出码为 3（不是 0/1/2）', skip.status === 3, { status: skip.status, tail: skip.out.slice(-160) });
  check('跳过日志明确说明是环境不满足', /跳过/.test(skip.out) && /未找到 Chromium/.test(skip.out), skip.out.slice(-160));

  console.log(`\n[${name}] 测试崩溃 → 1`);
  const crash = run(file, { CHROME_BIN: process.execPath, DP_E2E_SELFTEST: 'crash' });
  check('未捕获异常时退出码为 1（CI 必须红）', crash.status === 1, { status: crash.status, tail: crash.out.slice(-200) });
  check('崩溃日志打印崩溃原因', /测试崩溃/.test(crash.out), crash.out.slice(-200));
  check('崩溃路径绝不打印「跳过」', !/跳过/.test(crash.out), crash.out.slice(-200));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
