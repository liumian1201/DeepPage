# DeepPage

**一句话：Chrome MV3 新标签页扩展（FVD Speed Dial 风格），纯 Vanilla JS，`src/` 即产物、可直接加载；不是 Node 应用，也没有构建步骤。** 细节见 README.md。

## 命令

```bash
npm ci            # 装 ESLint（唯一开发依赖）
npm run verify    # lint + 逻辑测试，提交前必跑
npm run test:e2e  # 真浏览器 E2E；CHROME_BIN 必须指向 Chromium
```

加载：`chrome://extensions` → 开开发者模式 → 加载已解压的扩展程序 → 选 `src/`。

## 禁忌

- 别用官方 Chrome 137+ 跑 E2E，因为 `--load-extension` 已被移除，只能用 Chromium（环境不满足时退出码 3）。
- 别给 `src/js/` 写 `import/export`，因为全是 classic script，共享全局作用域，没有 bundler。
- 别手改版本号，因为 `manifest.json` 是唯一来源，CI 会校验 tag 一致，用 `npm run bump X.Y.Z`。
- 别把 devDependencies/tests/tools 算进发布内容，因为打包只取 `src/`。
- 别往 `chrome.storage.sync` 塞图片或大对象，因为单 key 配额 100KB（BUG-089），图片走 IndexedDB。

## 验收

`npm run verify` 全绿，扩展页点「重新加载」后新标签页控制台无报错、改动流程手工走通。
