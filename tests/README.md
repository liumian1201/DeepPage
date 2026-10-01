# tests — 零依赖验证脚本

不随扩展发布（打包只取 `src/`）。全部脚本**不需要 Playwright / Puppeteer**：E2E 用 Node 内置 `WebSocket` 直连 Chromium DevTools Protocol。

| 脚本 | 覆盖 | 依赖 | 运行 |
|------|------|------|------|
| `dashboard-logic.test.js` | 看板顺序逻辑：防抖写盘 / 边界不写盘 / 顺序未变不写盘 / 锁定拒绝 / ESC 暴露 | 仅 Node（`vm` + 最小 DOM 桩） | `npm test` |
| `e2e-p0.test.js` | 真实浏览器：ESC 退出编辑态 / 锁定禁用编辑 / 箭头换位 + 落盘 / 页面无报错 | Node + Chromium 构建 | `npm run test:e2e` |
| `e2e-sw-protocol.test.js` | 真实 SW 链路：`image-fetch` / `weather-fetch` / WebDAV 非法协议被拒，https 不被误伤 | Node + Chromium 构建 | `npm run test:e2e` |

## 浏览器要求（重要）

`--load-extension` 在 **Chrome 137+ 的官方 branded 构建中已被移除**（[Chrome 企业版发行说明](https://support.google.com/chrome/a/answer/10314655?hl=en#41)、[Chromium 提交](https://chromium.journaldev.googlesource.com/chromium/src/+log/refs/tags/137.0.7111.1/extensions/common)），因此 E2E **必须**用 Chromium 构建：

- 本机：`CHROME_BIN=/usr/bin/chromium npm run test:e2e`（默认值即 `/usr/bin/chromium`）
- CI：自动下载 Chrome for Testing（Chromium）到 `.cache/chromium` 后使用
- 用 branded Chrome 跑时，脚本会发现扩展页面打不开，打印原因并以退出码 `2` 跳过，不会误报失败

## 退出码约定

| 码 | 含义 | CI 行为 |
|:--:|------|---------|
| `0` | 全部断言通过 | 通过 |
| `1` | 有断言失败（真回归） | 失败 |
| `2` | 环境不满足（无浏览器 / 无法加载扩展 / 页面 init 超时） | 跳过并提示 |

## 稳定性设计

- 扩展 ID 不靠「目录路径哈希推导」（跨平台/版本不可靠），而是从 CDP target 里发现：优先取 `chrome-extension://<id>/background.js`，其余扩展 target 次之，路径推导仅兜底；逐个候选探测，能打开页面才算命中。
- 每次运行使用**随机调试端口 + 独立 profile**（`/tmp/dp-e2e-profile-<pid>`），避免与残留实例撞车。
- 浏览器以 `detached` 启动并按**进程组**回收：Chromium 会把真正的浏览器进程孤儿化（PPID 变 1），只 kill 启动壳会留下孤儿占着端口和 profile。
- 不依赖固定 sleep：轮询等待「页面 init 就绪」与「storage 落盘完成」，避免 CI 慢机器与 headless 定时器节流导致的假失败。
