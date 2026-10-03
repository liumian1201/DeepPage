/* E2E console.error 过滤器（BUG-073 / AUD-036）
 *
 * 背景：v1.5.0 为了让 CI（runner 常访问不到外网）不因天气/壁纸的网络失败变红，
 * 加了一条关键词黑名单；但它把「通用网络错误」（net::ERR / Failed to fetch /
 * NetworkError）与「业务词」（天气 / Bing 壁纸）和外部服务名混在一条正则里，
 * 导致任何 fetch 型代码回归产生的 console.error 都被整条丢弃 ——
 * 套件唯一的全局报错门（consoleErrors.length === 0）形同虚设。
 *
 * 现在的规则（两条必须同时成立才忽略，任一不成立一律计入失败）：
 *   ① 来源精确：日志前缀必须来自本项目已知的「外部服务」代码路径
 *      （src/ 里只有 weather.js:110 `Open-Meteo error:` 与 weather.js:138 `Weather error:`）；
 *   ② 失败类型必须是网络/传输层失败（fetch failed / net::ERR_* / 超时 …）。
 * 于是「weather 模块里的代码 bug」（如 TypeError）不再被吞掉，
 * 而 `local_bak save failed` 这类内部错误（storage.js:332）永远计入失败。
 */
'use strict';

/** ① 已知外部服务代码路径的日志前缀（新增外部依赖时必须同步登记，否则失败可见而不是被吞） */
const EXTERNAL_SOURCE = /(?:Open-Meteo error|Weather error)/;

/** ② 网络/传输层失败特征（代码回归不是网络失败，因此不会被这条匹配到） */
const NETWORK_FAILURE = /(?:net::ERR_|Failed to fetch|NetworkError|fetch failed|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_|ERR_TIMED_OUT|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket hang up|timed? ?out|超时)/i;

/**
 * 判定一条 console.error 文本的归属。
 * @param {string} text
 * @returns {'external-network'|'code'} external-network = 可忽略的外部服务网络失败；code = 代码回归，必须失败
 */
function classifyConsoleError(text) {
  const s = String(text == null ? '' : text);
  if (EXTERNAL_SOURCE.test(s) && NETWORK_FAILURE.test(s)) return 'external-network';
  return 'code';
}

/**
 * 收集器：把 console.error / 未捕获异常分流成「失败」与「被忽略（外部网络）」两堆。
 * 被忽略的条目单独计数并打印，便于判断是环境问题还是回归被误吞。
 */
function createConsoleErrorCollector() {
  const failures = [];
  const ignored = [];
  return {
    add(text) {
      const s = String(text == null ? '' : text);
      if (classifyConsoleError(s) === 'external-network') ignored.push(s);
      else failures.push(s);
    },
    addException(text) {
      failures.push('EXCEPTION: ' + String(text == null ? '' : text));
    },
    get failures() { return failures; },
    get ignored() { return ignored; },
    /** 收尾打印：被忽略项一律可见，不静默 */
    report() {
      if (ignored.length) {
        console.log(`ℹ️ 已忽略 ${ignored.length} 条外部服务网络失败（不计入失败门）：`);
        for (const t of ignored.slice(0, 5)) console.log('    · ' + t.slice(0, 160));
        if (ignored.length > 5) console.log(`    … 另有 ${ignored.length - 5} 条`);
      }
    },
  };
}

module.exports = { classifyConsoleError, createConsoleErrorCollector, EXTERNAL_SOURCE, NETWORK_FAILURE };
