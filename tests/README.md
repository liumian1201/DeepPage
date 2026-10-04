# tests — 零依赖验证脚本

不随扩展发布（打包只取 `src/`）。全部脚本**不需要 Playwright / Puppeteer**：E2E 用 Node 内置 `WebSocket` 直连 Chromium DevTools Protocol。

## 脚本一览

| 脚本 | 覆盖 | 依赖 | 运行 |
|------|------|------|------|
| `dashboard-logic.test.js` | 看板顺序逻辑：防抖写盘 / 边界不写盘 / 顺序未变不写盘 / 锁定拒绝 / ESC 暴露（29 项） | 仅 Node（`vm` + 最小 DOM 桩） | `npm test` |
| `console-error-filter.test.js` | **BUG-073 反向对照**：console.error 过滤规则双向断言（外部网络失败可忽略 / 代码回归必须可见）（22 项） | 仅 Node | `npm test` |
| `e2e-exit-code.test.js` | **BUG-041 反向对照**：退出码语义（环境不满足 → 3 / 测试崩溃 → 1 且不得打印「跳过」）（30 项） | 仅 Node（`spawnSync`） | `npm test` |
| `e2e-p0.test.js` | 真实浏览器主页全链路（399 项）：加载与渲染 / ESC 链 / 锁定 / 看板栅格与编辑态 / 多选批量 / 分组 / 壁纸 · 待办 · 建议 · favicon / 备份导入导出 / 同步写合并与配额回退 / ARIA / 跨标签页 / **DEBT-01 主链路** / **DEBT-02 页面侧降级路径** | Node + Chromium 构建 | `npm run test:e2e` |
| `e2e-sw-protocol.test.js` | 真实 SW 链路（23 项）：`image-fetch` / `weather-fetch` / WebDAV 非法协议被拒、http 截图权限闸门与不开窗、**DEBT-01 死链路下线**、**DEBT-02 SW 侧降级路径**（CDP 直连 SW 上下文） | Node + Chromium 构建 | `npm run test:e2e` |
| `e2e-webdav.test.js` | **真实 WebDAV 服务器**联调（55 项）：目录穿越 / 恶意 manifest 注入 / 导入白名单 / 分组导出图片 / 上传失败与孤儿 GC / 中文密码 / 增量备份与按需恢复 | Node + Chromium 构建 | `npm run test:e2e` |
| `lib/console-error-filter.js` | 三个 E2E 共用的 console.error 来源精确过滤器（被逻辑测试直接断言） | 仅 Node | — |
| `lib/webdav-test-server.js` | 零依赖最小 WebDAV 服务器（请求日志 + PUT 故障注入），供 `e2e-webdav.test.js` 使用 | 仅 Node | — |

> 当前基线（v1.6.0）：E2E **477 项**（p0 399 + SW 23 + WebDAV 55）｜ 逻辑桩测 **81 项**（29 + 22 + 30）。

## 断言约定（踩过的坑，新增用例请遵守）

- **行为断言优先，禁止「函数存在 / 源码字符串匹配」式空断言**（BUG-058 的教训：把按钮 handler 整段删掉，`typeof` 断言依然通过）。
  允许的写法是「真实点击 / 真实调用 / 真实鼠标事件 → 断言返回值、落盘结果、UI 文案、诊断文本」。
- **每条主链路改动都要有降级路径断言**：DEBT-02 那批的写法是「降级行为仍然正确」+「诊断真的被打印」，
  有意静默的用例还要**反向断言不产生诊断**（防止以后被人顺手改成噪音）。
- **单条用例要错误隔离**：p0 的 `debt02Case()` 与 SW 套件的 `swCase()` 把「打桩 → 跑用例 → 还原」包起来，
  用例抛错只记一次失败（返回 `{ __error }`），不会把 stub 泄漏给后续断言、也不会掀翻整个套件。
  旧代码对照时这一点尤其重要 —— 缺函数是常态。
- **降级诊断只用 `console.warn`**：三个套件都断言 `consoleErrors.length === 0`，把降级诊断写成 `console.error`
  会让 CI 立刻变红（而它不是代码缺陷）。统一出口：页面侧 `_warnDegraded()`、SW 侧 `_swWarnDegraded()`。
- **新增用户可见 Toast / 文案时补一次视觉核对**（v1.4.0 教训：面板挤压与遮挡逻辑测试发现不了）。

## SW 侧断言：用 CDP 直连 Service Worker 上下文

`background.js` 里的事务（关窗失败、URL 解析失败、MKCOL 建目录失败）在页面上下文里**看不到**，
只发消息也走不到那些降级分支。`e2e-sw-protocol.test.js` 的做法是 `Target.attachToTarget`
挂到 `background.js` 这个 SW target 上，再用 `Runtime.evaluate` 直接求值。

两条硬约束（v1.5.16 的 CI 首跑全红就是踩了第一条）：

1. **「找到 target」≠「拿到活着的上下文」**。MV3 的 SW 会被浏览器空闲回收再重启，
   `Target.getTargets` 可能**同时列出**已停用实例与新实例，两者 url 都是 `background.js`。
   只取第一个 + 单次求值会挂到空上下文（表现为 `xxx is not defined`、连 `chrome` 都没有，
   但消息协议照常工作 —— 因为消息走的是真正活着的那个实例）。
   → 必须**遍历所有候选、逐个挂上、轮询等待就绪**，并在断言过程中支持断线重挂。
2. **就绪判据不能依赖「本次新增的符号」**，否则旧代码上永远「不就绪」、整段被跳过，
   修复前 / 后对照会静默退化成 1 条失败。用两个版本都存在的符号（如 `stringToColor` + `chrome.runtime`）。
3. 刻意**不调用** `Runtime.enable`(SW)：那会把 SW 的 console 事件并进本套件的「无 console error」门，
   等于顺手改了门的语义（技术债批次不该做这件事）。

> 顺带：这类依赖「时序 / 回收 / 竞态」的测试**本地全绿不代表 CI 全绿** —— 本地机器快、SW 不易被回收，
> 上面的问题只在 CI 复现。**CI 才是唯一判据。**

## 探针：让同一套断言跑在旧代码上（修复前 / 后对比）

**三个** E2E 套件都支持用环境变量指定另一份扩展源码（`DP_EXT_DIR`），用来证明「缺陷真的存在、修复真的生效」：

```bash
# 1) 取一份修复前的扩展源码
mkdir -p /tmp/dp-old-ext && git archive HEAD src | tar -x -C /tmp/dp-old-ext
# 2) 同一套断言跑在旧代码上 → 应当在对应断言上失败（具体条数取决于对照的版本，见 CHANGELOG）
CHROME_BIN=/usr/bin/chromium DP_EXT_DIR=/tmp/dp-old-ext/src node tests/e2e-p0.test.js
CHROME_BIN=/usr/bin/chromium DP_EXT_DIR=/tmp/dp-old-ext/src node tests/e2e-sw-protocol.test.js
CHROME_BIN=/usr/bin/chromium DP_EXT_DIR=/tmp/dp-old-ext/src node tests/e2e-webdav.test.js
# 3) 跑在当前代码上 → 全绿
CHROME_BIN=/usr/bin/chromium npm run test:e2e
```

E2E 内部按「段」包裹：某一段异常中断只记一次失败，不会吞掉后面几段的结论（旧代码常常缺函数/缺字段，
逐段隔离才能一次跑出完整对照表）。

> ⚠️ 对照跑出「全绿」时先怀疑对照本身：v1.5.13 就出现过 `e2e-sw-protocol.test.js`
> **根本没实现 `DP_EXT_DIR`**、于是「修复前对照」实际跑的还是新代码（假对照）。

## 浏览器要求（重要）

`--load-extension` 在 **Chrome 137+ 的官方 branded 构建中已被移除**（[Chrome 企业版发行说明](https://support.google.com/chrome/a/answer/10314655?hl=en#41)、[Chromium 提交](https://chromium.journaldev.googlesource.com/chromium/src/+log/refs/tags/137.0.7111.1/extensions/common)），因此 E2E **必须**用 Chromium 构建：

- 本机：`CHROME_BIN=/usr/bin/chromium npm run test:e2e`（默认值即 `/usr/bin/chromium`）
- CI：下载 Chrome for Testing（Chromium）到 `.cache/chromium` 后使用；缓存键带 `CHROMIUM_CACHE_REV`，
  **需要换一个 Chromium 版本时把这个变量递增**（否则会一直复用首次缓存的版本）
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

三个 E2E 都把**页面**里的 `console.error` / `Runtime.exceptionThrown` 收进同一个门：**唯一允许忽略的是「已知外部服务的网络失败」**，
判定必须同时满足「日志前缀来自已登记的外部服务代码路径」+「失败类型是网络/传输层失败」（实现见 `lib/console-error-filter.js`）。
被忽略的条目会单独计数打印，不静默。天气模块里的**代码 bug**（如 `TypeError`）不再被来源关键词连带吞掉；
`storage.js` 的 `local_bak save failed` 这类内部错误永远计入失败。
SW 套件额外用 CDP 直连 SW 上下文求值，但**刻意不把 SW 的 console 并进这个门**（见上文）。

## 稳定性设计

- 扩展 ID 不靠「目录路径哈希推导」（跨平台/版本不可靠），而是从 CDP target 里发现：优先取 `chrome-extension://<id>/background.js`，其余扩展 target 次之，路径推导仅兜底；逐个候选探测，能打开页面才算命中。
- 每次运行使用**随机调试端口 + 独立 profile**（`/tmp/dp-e2e-profile-<pid>`），避免与残留实例撞车。
- 浏览器以 `detached` 启动并按**进程组**回收：Chromium 会把真正的浏览器进程孤儿化（PPID 变 1），只 kill 启动壳会留下孤儿占着端口和 profile。
- 不依赖固定 sleep：轮询等待「页面 init 就绪」与「storage 落盘完成」，避免 CI 慢机器与 headless 定时器节流导致的假失败。
- 真实鼠标拖拽断言（DEBT-01 主链路）：落点要**越过目标卡片中线**（`dragdrop.js` 用中线决定插前/插后，
  正好落在中线上会因浮点误差被判成「插回原位」），且拖拽前要先落盘 + 等 300ms 防抖重渲染稳定。
