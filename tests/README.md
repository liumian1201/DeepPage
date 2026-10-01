# tests — 零依赖验证脚本

不随扩展发布（打包只取 `src/`）。全部脚本**不需要 Playwright / Puppeteer**：E2E 用 Node 内置 `WebSocket` 直连 Chromium DevTools Protocol。

| 脚本 | 覆盖 | 依赖 | 运行 |
|------|------|------|------|
| `dashboard-logic.test.js` | 看板顺序逻辑：防抖写盘 / 边界不写盘 / 顺序未变不写盘 / 锁定拒绝 / ESC 暴露 | 仅 Node（`vm` + 最小 DOM 桩） | `npm test` |
| `e2e-p0.test.js` | 真实浏览器：ESC 退出编辑态 / 锁定禁用编辑 / 箭头换位 + 落盘 / 页面无报错 | Node + Chrome/Chromium | `npm run test:e2e` |
| `e2e-sw-protocol.test.js` | 真实 SW 链路：`image-fetch` / `weather-fetch` / WebDAV 非法协议被拒，https 不被误伤 | Node + Chrome/Chromium | `npm run test:e2e` |

## 说明

- 浏览器路径优先读环境变量 `CHROME_BIN`，默认 `/usr/bin/chromium`；找不到浏览器时 E2E 脚本以退出码 `2` 优雅跳过（CI 里据此判断是否执行）。
- 扩展 ID 由扩展目录绝对路径的 SHA-256 前 32 位十六进制映射 a~p 自动推导，使用独立临时 profile（`/tmp/dp-e2e-profile`），不触碰真实浏览器数据。
- 退出码：`0` 全通过 ｜ `1` 有断言失败 ｜ `2` 环境不满足（无浏览器等）。
