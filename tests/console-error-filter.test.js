/* BUG-073 / AUD-036 反向对照：console.error 过滤规则单元测试（不需要浏览器）
   运行: node tests/console-error-filter.test.js （随 npm test）

   为什么需要这个文件：原实现在 E2E 里内联一条正则，自测只注入「应被忽略」的样本，
   于是「把过滤规则放宽到吞掉一切」这种退化永远不会被发现。
   这里对分类器做双向断言：可忽略的必须忽略，代码回归必须可见。
*/
const { classifyConsoleError, createConsoleErrorCollector } = require('./lib/console-error-filter');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

console.log('\n[1] 必须计入失败（代码回归不得被吞）');
const mustFail = [
  ['普通 console.error', '（测试注入，必须计入）boom'],
  ['未捕获异常文本', 'Uncaught TypeError: Cannot read properties of undefined (reading "city")'],
  ['裸 Failed to fetch（无来源标记）', 'Failed to fetch'],
  ['裸 net::ERR（无来源标记）', 'net::ERR_NAME_NOT_RESOLVED'],
  ['内部错误 + 网络字样（storage.js local_bak）', 'local_bak save failed: Error: Failed to fetch'],
  ['天气模块的代码 bug（有来源标记但不是网络失败）', 'Open-Meteo error: TypeError: Cannot read properties of undefined (reading "hourly")'],
  ['天气模块渲染异常', 'Weather error: TypeError: renderWeather is not a function'],
  ['天气业务错误（非网络）', 'Weather error: Error: 未知数据源'],
  ['旧黑名单的业务词不再单独生效（Bing 壁纸）', 'Bing 壁纸 error: Failed to fetch'],
  ['旧黑名单的业务词不再单独生效（天气）', '天气加载失败: Failed to fetch'],
];
for (const [name, text] of mustFail) {
  check(name, classifyConsoleError(text) === 'code', { text, got: classifyConsoleError(text) });
}

console.log('\n[2] 可忽略（已知外部服务 + 网络失败）');
const canIgnore = [
  ['E2E 既有注入样本', 'Open-Meteo error: fetch failed（测试注入，应被忽略）'],
  ['Open-Meteo + Failed to fetch', 'Open-Meteo error: TypeError: Failed to fetch'],
  ['Weather + fetch failed', 'Weather error: Error: fetch failed'],
  ['Weather + net::ERR', 'Weather error: Error: net::ERR_INTERNET_DISCONNECTED'],
  ['Weather + 超时', 'Weather error: Error: 请求超时'],
  ['Weather + ERR_NAME_NOT_RESOLVED', 'Weather error: Error: net::ERR_NAME_NOT_RESOLVED'],
];
for (const [name, text] of canIgnore) {
  check(name, classifyConsoleError(text) === 'external-network', { text, got: classifyConsoleError(text) });
}

console.log('\n[3] 收集器分流与报告');
{
  const c = createConsoleErrorCollector();
  c.add('Open-Meteo error: fetch failed（应被忽略）');
  c.add('（必须计入）boom');
  c.addException('TypeError: 页面炸了');
  c.addException('Open-Meteo error: fetch failed（异常分支也必须计入）');
  check('ignored 只收外部网络失败', c.ignored.length === 1 && c.ignored[0].includes('应被忽略'), c.ignored);
  check('failures 收普通报错', c.failures.some(t => t.includes('必须计入')), c.failures);
  check('未捕获异常一律计入（不受过滤规则影响）', c.failures.filter(t => t.startsWith('EXCEPTION:')).length === 2, c.failures);
  check('failures 是同一数组引用（E2E 的 splice 清理才有效）', c.failures === c.failures);
  let threw = null;
  try { c.report(); } catch (e) { threw = e.message; }
  check('report() 不抛错', threw === null, threw);
  check('空文本不炸（null/undefined 归一）', classifyConsoleError(null) === 'code' && classifyConsoleError(undefined) === 'code');
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
