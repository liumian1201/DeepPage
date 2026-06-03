# DeepPage 更新日志

---

## v1.0.7 (2026-06-03)

### ⚡ 性能优化
- 防抖渲染 + 隐身跳过：`main.js` `onChanged` 加 300ms debounce，标签页隐藏时不渲染
- CSS 骨架屏：Ctrl+T 瞬间显示灰色占位卡片，消除白屏闪烁
- SW 休眠审计：确认 `background.js` 无 setInterval/全局变量，无标签页时可正常休眠

### 🔌 离线指示器
- 断网时搜索框图标自动灰度 + 半透明，恢复后自动还原

### 🎨 极简纯色文字卡片
- 设置面板「功能」新增「极简卡片（纯色文字，不加载图片）」开关
- 开启后跳过所有图片加载，纯哈希色块 + CSS 首字渲染，零 IndexedDB 读写

### 🐛 修复
- `cards.js`：移除 inline `onerror` 属性，改用 JS `addEventListener` 监听，消除 CSP 警告

---

## v1.0.6 (2026-06-03)

### 📝 设置面板文本优化
- 「距顶部」→「搜索框与边缘距离」
- 「到卡片间距」→「搜索框与卡片距离」
- 「指示器边距」→「指示器与边缘距离」
- 「恢复默认」→「重置默认大小(270×270)」，按钮居中 + 红色样式

### 🗜️ 数据导入导出重构（fflate Zip 合并）
- 引入 `fflate`（5KB），配置 + 图片库合并为单一 `_DeepPage_Backup.zip`
- 导出：chrome.storage.sync + IndexedDB Blob → fflate 二进制 zip（零 base64）
- 导入：解压 zip → 配置写回 sync + 图片写回 IndexedDB，带 loading 遮罩
- 向下兼容旧版 `.json` 格式（配置 JSON / base64 图片 JSON 自动识别）
- Object URL 内存泄漏修复（cards.js / wallpaper.js）

### 🐛 修复
- `weather.js`：`WMO_ICONS` 补全全部 28 种天气代码图标映射
- `background.js`：`rebuildContextMenus` 并发锁，修复扩展重载时右键菜单重复 ID 报错

---

## v1.0.5 (2026-06-03)

### 🖱️ 浏览器右键菜单「添加到 DeepPage」
- 在**任意网页**右键 → 「➕ 添加到 DeepPage」→ 选择目标分组
- 自动提取当前页面 URL 和标题，生成卡片添加到指定分组
- 分组列表动态更新（含卡片数量统计）
- 无法添加 `chrome://` 等浏览器内部页面（自动忽略）

### 🔄 跨标签页实时同步
- 右键添加卡片后，已打开的 DeepPage 新标签页**自动刷新**显示新卡片
- 分组增删改后右键菜单自动重建

### 🔒 权限
- `manifest.json` 新增 `contextMenus` 权限

---

## v1.0.4 (2026-06-03)

### 🔗 卡片打开方式
- 设置面板「⚙️ 功能」标签新增「卡片打开方式」三种模式
- **当前页面打开**（默认）：`location.href` 直接跳转
- **新标签页前台打开**：`chrome.tabs.create({ active: true })` 新建并激活标签
- **新标签页后台打开**：`chrome.tabs.create({ active: false })` 新建但不激活标签
- 卡片左键点击和右键「打开」均适配三种模式

### 🔒 权限
- `manifest.json` 新增 `tabs` 权限（用于后台/前台新标签页创建）

### 🐛 修复
- 修复卡片打开方式下拉选择刷新后丢失（`collectSettingsFromForm` 遗漏字段）

---

## v1.0.3 (2026-06-02)

### 🖼️ 卡片图标本地缓存
- 设置图片 URL 后自动通过 Service Worker 下载缓存到 IndexedDB（`cardimg_<id>`）
- 启动时自动迁移现有卡片 URL 图标到本地缓存
- 编辑/删除卡片时自动清理旧图标缓存
- 断网状态下卡片图标正常从本地加载显示

### 🔒 安全与权限
- `host_permissions` 扩展至 `https://*/*` `http://*/*`（支持任意 URL 图标）
- CSP `connect-src` 扩展至 `http: https:`

### 📦 数据导入增强
- 图片库导入完成后立即重渲染卡片，无需手动刷新
- 图片库信息保存后自动更新显示

---

## v1.0.2 (2026-06-02)

### 📊 看板布局重构
- 看板 `position: fixed` 浮动定位，不被页面元素遮挡
- 5 个滑块统一控制：水平偏移（±1200px）、垂直位置（0-1200px）、组件宽/高/间距
- ↺ 重置位置 / 重置大小按钮
- 布局方向：水平 / 垂直
- 时钟 12/24h 切换 + 秒数开关 + 农历双行/单行

### 📂 移动到分组
- 卡片右键新增「移动到分组」→ 二级子菜单列出所有分组
- 点击目标分组立即移动卡片 + Toast 提示

### 🖱️ 设置面板拖拽
- 按住标题栏可拖动设置面板，关闭后重置居中

### 🎯 组名显示优化
- 3 状态下拉：不显示 / 仅当前组 / 显示所有组名
- 上/下指示器文字标签：不显示→圆点 / 仅当前→文字+圆点混排 / 全部→纯文字

### 🔧 细节
- 设置面板宽度 400→500px，弹窗 z-index 层级重排
- 弹窗内右键恢复浏览器原生菜单
- 搜索框距顶部滑块 min=2 + 容器 padding-top=0

---

## v1.0.1 (2026-06-02)

### 🔍 搜索优化
- 搜索引擎显示开关（Toggle 控制搜索栏显隐）
- 搜索框垂直位置双滑块：距顶部（2-300px）+ 到卡片间距（12-200px），CSS 变量实时预览

### 📍 分组指示器增强
- 四向定位：左/右（圆点竖排）/ 上/下（横排标签）
- 边距滑块（2-80px），CSS 变量 `--group-offset`
- 右侧镜像显示 + +按钮间距优化
- 刷新后下拉框正确恢复状态

### 🖼️ Bing 壁纸增强
- 多图缓存（8 张）+ ◀ ▶ 导航 + 版权信息右下角浮动栏
- UHD 4K 开关 / 区域切换 / 刷新间隔滑块 / 立即刷新
- 新标签页随机展示（8 选 1）

---

## v1.0.0 (2026-06-02)

### 🏗 架构重构
- `main.js` 拆分为 6 个独立模块：`cards.js` / `groups.js` / `dragdrop.js` / `search-engines.js` / `contextmenu.js` / `main.js`
- `swapGroups()` 抽象 · `withImgStore()` IndexedDB 通用封装 · `loadFromLocal()` / `saveToLocal()` 封装
- 拆分 `clock.js`（12/24h + 秒数开关）

### ✨ 核心功能
- FVD Speed Dial 风格卡片（拖拽排序、右键菜单、中键新标签页打开）
- 多搜索引擎（Google/百度/Bing/搜狗/Yandex + 自定义）
- 数字时钟 + 农历 + 天气（Open-Meteo/和风/OpenWeatherMap/自定义）
- Bing 每日壁纸 + 自定义 URL/本地上传
- 深色/浅色/跟随系统主题
- 分组管理（左侧指示器 + 滚轮切换 + 分组增删改）
- 分体数据管理（配置 JSON + 图片库 JSON 导入导出）
- 界面锁定/解锁 + 拖拽红白闪烁警告动画
- Favicon 兜底 + 纯白底色 + scale-down 缩放

### 🐛 Bug 修复
- 生肖图标硬编码 🐲 → 动态 Emoji
- 拖拽滚轮冲突、小范围拖拽误触发打开
- 锁定状态图片拖拽穿透
- 右键菜单分隔线、天气缓存、`swFetch` JSON 异常
- CSP 加固、URL 转义、pickFile DOM 清理

### 🔒 安全
- CSP：`script-src / style-src / img-src http: https: / connect-src https:`
- 搜索引擎 URL 协议白名单验证
