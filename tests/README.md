# tests — 零依赖验证脚本

不随扩展发布（打包只取 `src/`）。全部脚本**不需要 Playwright / Puppeteer**：E2E 用 Node 内置 `WebSocket` 直连 Chromium DevTools Protocol。

| 脚本 | 覆盖 | 依赖 | 运行 |
|------|------|------|------|
| `dashboard-logic.test.js` | 看板顺序逻辑：防抖写盘 / 边界不写盘 / 顺序未变不写盘 / 锁定拒绝 / ESC 暴露 | 仅 Node（`vm` + 最小 DOM 桩） | `npm test` |
| `console-error-filter.test.js` | **BUG-073 反向对照**：console.error 过滤规则双向断言（外部网络失败可忽略 / 代码回归必须可见） | 仅 Node | `npm test` |
| `e2e-exit-code.test.js` | **BUG-041 反向对照**：退出码语义（环境不满足 → 3 / 测试崩溃 → 1 且不得打印「跳过」） | 仅 Node（`spawnSync`） | `npm test` |
| `e2e-p0.test.js` | 真实浏览器：ESC 退出编辑态 / 锁定禁用编辑 / 箭头换位 + 落盘 / 页面无报错 | Node + Chromium 构建 | `npm run test:e2e` |
| `e2e-sw-protocol.test.js` | 真实 SW 链路：`image-fetch` / `weather-fetch` / WebDAV 非法协议被拒，https 不被误伤 | Node + Chromium 构建 | `npm run test:e2e` |
| `e2e-webdav.test.js` | **真实 WebDAV 服务器**联调：目录穿越 / 恶意 manifest 注入 / 导入白名单 / 分组导出图片 / 上传失败与孤儿 GC / 中文密码 | Node + Chromium 构建 | `npm run test:e2e` |
| `lib/console-error-filter.js` | 两个 E2E 共用的 console.error 来源精确过滤器（被上面两个测试直接断言） | 仅 Node | — |
| `lib/webdav-test-server.js` | 零依赖最小 WebDAV 服务器（请求日志 + PUT 故障注入），供 `e2e-webdav.test.js` 使用 | 仅 Node | — |

## 探针：让同一套断言跑在旧代码上（修复前 / 后对比）

`e2e-webdav.test.js` 支持用环境变量指定另一份扩展源码，用来证明「缺陷真的存在、修复真的生效」：

```bash
# 1) 取一份修复前的扩展源码
mkdir -p /tmp/dp-old-ext && git archive HEAD src | tar -x -C /tmp/dp-old-ext
# 2) 同一套断言跑在旧代码上 → 应当在对应断言上失败（v1.5.10 实测：22 项失败）
CHROME_BIN=/usr/bin/chromium DP_EXT_DIR=/tmp/dp-old-ext/src node tests/e2e-webdav.test.js
# 3) 跑在当前代码上 → 全绿
CHROME_BIN=/usr/bin/chromium node tests/e2e-webdav.test.js
```

E2E 内部按「段」包裹：某一段异常中断只记一次失败，不会吞掉后面几段的结论（旧代码常常缺函数/缺字段，
逐段隔离才能一次跑出完整对照表）。

## 浏览器要求（重要）

`--load-extension` 在 **Chrome 137+ 的官方 branded 构建中已被移除**（[Chrome 企业版发行说明](https://support.google.com/chrome/a/answer/10314655?hl=en#41)、[Chromium 提交](https://chromium.journaldev.googlesource.com/chromium/src/+log/refs/tags/137.0.7111.1/extensions/common)），因此 E2E **必须**用 Chromium 构建：

- 本机：`CHROME_BIN=/usr/bin/chromium npm run test:e2e`（默认值即 `/usr/bin/chromium`）
- CI：自动下载 Chrome for Testing（Chromium）到 `.cache/chromium` 后使用
- 用 branded Chrome 跑时，脚本会发现扩展页面打不开，打印原因并以退出码 `3` 跳过，不会误报失败

## 退出码约定

| 码 | 含义 | CI 行为 |
|:--:|------|---------|
| `0` | 全部断言通过 | 通过 |
| `1` | 有断言失败 **或测试自身崩溃**（真回归） | 失败 |
| `3` | 环境不满足（无浏览器 / 无法加载扩展 / 页面 init 超时） | 跳过并打 `::warning::` |

> ⚠️ **历史坑（BUG-041 / AUD-001）**：退出码 `2` 曾被同时用于「环境跳过」与「全局 catch 兜底」，
> 而 `ci.yml` 把 `2` 一律映射为 `exit 0` —— 页面/SW 真坏掉、测试抛错、浏览器没装上全都静默变绿。
> 现在**崩溃一律 `1`**、**跳过只用 `3`**，并且只有 `3` 会被 CI 放行；Chromium 没准备好时 CI 直接失败。
> `e2e-exit-code.test.js` 把这两条语义钉死（含「崩溃路径不得打印跳过」）。
> E2E 脚本里的 `DP_E2E_SELFTEST=crash` 是给该测试用的自检钩子（建连前抛错），正常跑不会触发。

## console.error 门（BUG-073）

两个 E2E 都把页面里的 `console.error` / `Runtime.exceptionThrown` 收进同一个门：**唯一允许忽略的是「已知外部服务的网络失败」**，
判定必须同时满足「日志前缀来自已登记的外部服务代码路径」+「失败类型是网络/传输层失败」（实现见 `lib/console-error-filter.js`）。
被忽略的条目会单独计数打印，不静默。天气模块里的**代码 bug**（如 `TypeError`）不再被来源关键词连带吞掉；
`storage.js` 的 `local_bak save failed` 这类内部错误永远计入失败。

## 稳定性设计

- 扩展 ID 不靠「目录路径哈希推导」（跨平台/版本不可靠），而是从 CDP target 里发现：优先取 `chrome-extension://<id>/background.js`，其余扩展 target 次之，路径推导仅兜底；逐个候选探测，能打开页面才算命中。
- 每次运行使用**随机调试端口 + 独立 profile**（`/tmp/dp-e2e-profile-<pid>`），避免与残留实例撞车。
- 浏览器以 `detached` 启动并按**进程组**回收：Chromium 会把真正的浏览器进程孤儿化（PPID 变 1），只 kill 启动壳会留下孤儿占着端口和 profile。
- 不依赖固定 sleep：轮询等待「页面 init 就绪」与「storage 落盘完成」，避免 CI 慢机器与 headless 定时器节流导致的假失败。
