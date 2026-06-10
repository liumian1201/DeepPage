# DeepPage 更新日志

## v1.3.0 (2026-06-10) — 看板编辑态

### 🧩 看板组件换位
- 设置→看板→「✋ 编辑组件顺序」进入编辑态，每个组件显示 ◀▶ 箭头
- 点击箭头左右换位，顺序保存到 `settings.dashboardOrder`，刷新恢复
- 新增 `src/js/dashboard.js`（~60行，零依赖）

### 📌 说明
- 自研 CSS Grid 坐标拖拽和 GridStack.js 均经过验证但不适合当前场景（3组件+fixed定位），已移除
- 看板整体布局后续版本重做

### 🐛 修复
- **修复窄屏卡片模块整体不居中**：`updateGridColumns` 改为按父容器实际宽度 `floor((parentWidth+gap)/(cardWidth+gap))` 计算可容纳列数，设置精确 `width`（上限滑块列数）。宽屏按滑块列数、窄屏按实际列数，`margin:auto` 在所有分辨率下都能居中。同时添加窗口 `resize` 监听（150ms 防抖）自动重算。
- **修复本地图片刷新时破图一闪**：IndexedDB 图片 `<img>` 初始无 `src`，等待 `loadLocalCardImages` 异步读取期间浏览器短暂显示破图占位符。加 CSS `.card-thumb-img[data-local="1"]:not([src]) { visibility: hidden }`，`src` 赋值后选择器失效自动显示，无布局抖动。

---

## v1.2.9 (2026-06-09)

### 🕐 新增
- **最近访问排序**：卡片增加 `lastOpened` 时间戳，打开卡片时自动记录；分组指示器旁 🕐 按钮临时按最近打开降序排列，切换分组自动恢复原排序
- **重复卡片检查**：数据标签页「🔍 检查重复卡片」按钮，按 URL 分组展示所有重复项，支持逐张删除或一键清理
- **批量自动截图**：右键空白处「📸 批量截图未封面卡片」，自动为当前分组所有无封面卡片截图（1280×720），进度弹窗实时显示

### 🔒 锁定体验优化
- **指示器轻量化**：去掉看板区域「🔒 界面已锁定」横幅，改为分组指示器旁 🔒/🔓 小图标 + 悬浮 tooltip；锁定状态下拖拽时图标抖动提示

### 🎨 外观标签页精简
- **视觉合并**：信息栏配色 + 卡片设置合并为「🎨 视觉」组
- **高级选项折叠**：圆角/透明度/卡片距顶/搜索框位置默认隐藏，点「⚙️ 高级选项」展开/收起

### 🐛 修复
- 修复设置面板标签页切换排版错乱（外观标签重构时残留孤儿 DOM）
- 修复沉浸模式双击后界面无变化（替换 CSS 时误删沉浸模式规则）
- 修复解锁状态下点锁图标无法进入锁定（click 事件仅在 `setLocked` 内绑定，解锁启动时未触发）
- 修复锁定拖拽时锁图标抖动出现红色方形背景（动画残留旧 `background` 属性）
- 修复全图片分组切组时卡片尺寸异常（`display:contents` 导致 CSS 变量继承中断；Grid 显式设 `width` + 运行时 `_syncCardHeights` 双保障）
- 修复卡片高度滑块拖动无实时预览（`input` 事件同步刷新所有卡片 inline height）
- 修复控制台 wheel 事件 passive 警告
- 手动截图分辨率 1400×900 → 1280×720
- **修复 WebDAV 测试连接报错**：`webdavTestConnection` 函数在 v1.2.6 被误删，补回 `webdav.js`
- **修复增量恢复丢图**：`webdavGetImage` 硬编码 blob MIME 为 `image/png`，导致 SVG 等非 PNG 图片恢复后破图（`naturalWidth: 0`）。改为备份时 `imageRefs` 存储 `{ md5, type }` 对象，恢复时按原始 MIME 重建 blob，`background.js` IMG_GET 响应附带 `_mime`。兼容旧 `imageRefs` 字符串格式。
- **更新扩展图标**：新版彩色九宫格 speed dial 风格 logo
- **FVD 转换器增强**：`clicks` → `visitCount` 保留历史点击次数；按 FVD `position` 排序；补 `lastOpened` 字段

---

## v1.2.8 (2026-06-09)

### ☁️ WebDAV 增量备份
- **Manifest 增量**：云端维护 `manifest.json` 全局索引 + `config/` 配置快照 + `img/` 共享图片池
- **MD5 去重**：Web Crypto SHA-256 计算每张图片哈希，仅上传新增/变更图片
- **进度弹窗**：5 阶段可视化进度（哈希→对比→上传→配置→清理），点空白不关闭
- **按需恢复**：选择版本后仅下载该版本引用的图片，批量并行下载（每次 4 并发）
- **版本删除**：备份版本列表每行右侧 🗑️ 按钮 + 确认弹窗，支持删除旧 ZIP 和增量配置
- **孤儿 GC**：自动清理无引用的云端图片和过期配置快照，保留最近 5 个版本
- **首次迁移**：检测旧 ZIP → 专用弹窗提示切换增量模式 → 可选导出本地备份或跳过
- **静默备份**：自动备份同样走增量路径，fire-and-forget

### 🎨 弹窗增强
- `showImportConfirm` 支持自定义标题、按钮文字、宽度（`wider` 选项），关闭后自动恢复默认
- 迁移/备份完成弹窗使用专属标题和按钮，不再复用「确认导入」文案

### 🐛 修复
- 修复网页右键菜单「添加到 DeepPage」选择分组后卡片未写入（`sync.set` Promise reject 未被 catch，导致 `local` 回退路径跳过）
- 修复重复卡片检测仅匹配域名，同域不同路径误判为重复（改为 `hostname+pathname+search` 完整 URL 匹配，覆盖 `cards.js` + `background.js` 两处）

---

## v1.2.7 (2026-06-07)

### 🐛 修复
- 修复卡片打开方式在特定路径下被忽略的问题（`mode` 变量作用域）
- 修复天气键控 API 分支冗余 storage 读取（使用 `setWeatherCache` 返回值）
- 修复 `>` 本地搜索多关键词高亮失效（改为逐词正则匹配）
- 修复拖拽排序回退分支可能缓存隐藏分组卡片坐标
- 修复 `_savingGroups` 未定义时保存锁误复位
- 修复看板垂直位置默认值不一致（24→0）
- 修复右键菜单首次弹出时可能超出屏幕底部（先显示再读尺寸）
- 修复 WebDAV 静默备份在标签页关闭时文件名写入丢失（移至 SW 侧）
- 修复 WebDAV silent-put 空 body 导致 TypeError
- 修复农历 `setInterval` 长期运行漂移（改为递归 `setTimeout` 每日校准）
- 修复重度用户（1600+ 卡片）浏览器右键菜单「添加到 DeepPage」消失（sync 超限后未回退 local）

---

## v1.2.6 (2026-06-07)

### 🎨 新增
- **卡片透明度**：设置面板滑块（0%-100%），`--card-opacity` CSS 变量实时预览，重置卡片大小一并恢复

### ☁️ WebDAV 增强
- **版本化备份**：文件名带时间戳（`DeepPage_YYYYMMDD_HHmmss.zip`），不再覆盖旧备份
- **自动清理**：云端保留最近 5 个备份，旧版本自动删除
- **手动选版恢复**：恢复前列出版本列表（radio 选择 + 快捷恢复最新），PROPFIND 兼容多命名空间
- **并行读取**：备份时 Promise.all 同步读 sync + IndexedDB，缩短构建时间

### 🖥️ 自适应网格
- **auto-fill 自动换行**：窗口缩小时卡片自然掉列，不再溢出；`max-width` 限制最大列数为滑块设定值
- **列数上限**：12 → 8 列
- **碰撞检测**：卡片触底时看板自动退为流式排列（`data-dash-collision`），绝不重叠；拉宽窗口自动恢复 fixed

### 🐛 修复
- 修复 WebDAV 密码框显示/隐藏按钮排版错位
- 修复账号/密码框宽度未对齐
- 修复 `.local-search-list` 空 CSS 规则警告
- 修复 WebDAV 恢复 GET 404（href 完整路径改为取 basename）
- 修复竖屏卡片高度被设置面板锁定导致竖长条
- 修复卡片透明度松手后壁纸遮罩异常叠加（`onAppearanceChanged` 误调 `applyAllSettings`）
- 修复壁纸右侧 10px 露底色（`scrollbar-gutter: stable` 预留槽位）

### 📱 界面优化
- 窄屏设置面板自动全宽撑满
- 看板碰撞自动规避，无需手动调整

---

## v1.2.5 (2026-06-06)

### 🎨 新增
- **截图主题色提取**：Canvas 采样截图主色调，卡片 hover 散发氛围灯光影；外观开关控制（默认开）；新截图/上传自动提取；编辑弹窗「🎨 采样主题色」按钮手动重采样

### 🔍 增强
- **`>` 拼音首字母搜索**：2500+ 常用汉字映射表，输入拼音首字母匹配中文卡片名称，盲打直达（+3 分权重）
- 所有设置滑块步进统一为 1

### 🐛 修复
- 修复 Manifest V3 Service Worker 休眠唤醒后 Chrome 右键菜单「添加到 DeepPage」丢失
- 修复 `disableWheelSwitch` 设置开关初始化遗漏，导致更新扩展后设置丢失
- 修复 `cardThemeColor` 设置开关未绑定 `collectSettingsFromForm` 导致无法保存
- 修复编辑弹窗第二行按钮文字换行

---

## v1.2.4 (2026-06-06)

### ⚡ 性能优化

- **DOM 分组缓存池**：每组独立容器（`display: contents`），热切换仅改 `display` 不重建 DOM，切组零闪烁零延迟；LRU 限制 3 组兜底内存
- **Blob URL 缓存层**：`_cardBlobCache` + `_getCardImgUrl`，切回已访问组直接复用

### 🐛 修复

- **`incrementVisitCount` 全局扫描**：遍历所有分组查找卡片 ID，`>` 跨组搜索结果累加计数
- `switchGroup` 双重渲染 → `_savingGroups` 锁 + debounce 清理
- 快速切组竞态 → `_renderId` 防护
- `dragdrop.js` 改用 `data-id` 匹配，DOM 回收后索引不脱钩
- ESC 10层链式关闭 + settings.js 数组守卫
- `scrollbar-gutter: stable` + 分组指示器防沉浸 + `user-select: none`

---

## v1.2.3 (2026-06-06)

### ⌨️ 交互打磨

- **ESC 统一关闭弹窗**：链式按优先级逐层关闭 10 层弹窗（确认删除→分组命名→分组管理器→搜索引擎→备份引导→导入确认→重置确认→重复卡片→卡片编辑→设置面板），一次 ESC 只关一层
- **Alt+↑/↓ 切换分组**：全局快捷键，无惧焦点在输入框，到顶/到底自动循环
- **右键 per-card 打开方式**：右键菜单「打开」拆为「🔗 前台打开」「🔗 后台打开」两条，不依赖全局设置
- **`>` 本地卡片搜索**：搜索框输入 `>` 触发全部分组卡片检索，名称+URL 模糊匹配，毛玻璃下拉面板 + 分组 Badge + 键鼠导航，打开复用全局 `cardOpenMode`；智能排序（名称开头>中间>URL>访问次数）+ 空格 AND 多关键词 + 结果过多时提示缩小范围

### 🐛 修复

- 全局弹窗不再点空白处关闭（编辑卡片/导入确认/重置确认/分组管理/搜索引擎/设置面板/删除确认）
- `switchGroup` 切换分组先渲染再异步保存，大容量数据用户不再卡 UI

---

## v1.2.2 (2026-06-05)

### ✂️ 样式三流（抽脂不伤身）

- `css/base.css`：变量、主题（Dark Mode）、响应式基础
- `css/main.css`：主页导航、搜索、看板、右键菜单
- `css/settings.css`：设置面板专用表单与滑块样式
- 主入口仅增加 2 行 `<link>` 标签，HTML 核心逻辑零变动

### 🧠 逻辑降温

- `js/settings-webdav.js`：从 `settings.js`（998行）精准剥离 WebDAV 表单联动与冲突控制，主文件回落 856 行安全区

### 📥 首次备份引导

- 本地定时提醒模式首次开启时弹出专用引导对话框（不可点空白关闭，防误触）
- "立即导出备份"完成后显示 "✅ 首次备份完成，计时已开始"
- "稍后再说"跳过但开始计时，数据标签页显示 "⚠️ 上次备份已跳过"
- `remind_last_backup` 独立时间戳（不与 WebDAV 共用），`remind_backup_skipped` 标记正确区分跳过/真备份
- 数据标签页新增备份状态行（上次备份时间 / 下次提醒时间），三种模式各有对应显示，切换模式实时刷新
- WebDAV 配置区仅保留操作反馈（测试/保存/备份），不重复显示备份时间

### 🔧 修复

- 沉浸模式不再误触发（点击 Toast 后闪入沉浸模式 + `now is not defined` 报错）
- 后台打开卡片不再闪烁重渲染（左键/中键/右键→打开三种路径均已修复）

---

## v1.2.1 (2026-06-05)

### 🛡️ 数据主权防线

- **自动备份模式**：设置→数据→新增"自动备份模式"下拉（关闭/本地定时提醒/WebDAV 自动同步），统一替换原有分散开关
- **提醒周期**：本地定时提醒模式支持 7/14/30 天可选，超时弹出可点击 Toast 一键导出
- **WebDAV 区按模式显隐**：仅 WebDAV 模式下显示云备份配置区，关闭和提醒模式下隐藏保持界面干净
- **本地快照后悔药**：每次保存数据前自动将上一版完好配置存入 `chrome.storage.local`（`local_bak`），新增「↩️ 恢复上一次改动」按钮；GC 同步保护 `local_bak` 中图片引用，删组时保留 IndexedDB 图片确保恢复后不破图
- 自动/手动备份统一使用 `DeepPage_Backup.zip` 单一文件

---

## v1.2.0 (2026-06-05)

### ☁️ WebDAV 云备份

- 设置面板 → 数据 → 新增 WebDAV 配置区（地址/账号/密码+👁显隐切换）
- 支持标准 WebDAV 协议（坚果云/NextCloud/ownCloud/NAS），Basic Auth 认证
- 所有网络请求由 `background.js` Service Worker 代理，彻底免疫 CORS
- 密码 `btoa` 混淆后存 `chrome.storage.local`，不与 Google 账号同步
- **手动备份**：一键导出 zip（`ArrayBuffer`→数组传输防丢失）→MKCOL 建目录→PUT 上传
- **手动恢复**：PROPFIND 读取云端时间→自定义确认弹窗显示时间→下载→走现有导入流程
- **自动备份**：`beforeunload` 静默上传（`ArrayBuffer` 转移至 SW，不阻塞关闭）
- **冲突检测**：正则提取 `getlastmodified`（SW 无 `DOMParser`），对比本地时间
- **测试连接**：一键验证 WebDAV 地址和凭据（先静默保存再测试）
- 恢复后自动更新本地备份时间戳

### 🛡️ 安全

- 凭据独占 `chrome.storage.local`，不参与 sync 跨设备同步
- 密码 `btoa` Base64 混淆防明文泄露
- 静默备份失败静默忽略，不打扰用户

---

## v1.1.9 (2026-06-05)

### 🐛 修复截图窗口关闭后死锁

- 截图窗口被用户手动关闭（点 X）时，Promise 不再挂起 120 秒才超时
- 新增 `chrome.windows.onRemoved` 监听：窗口关闭立即 reject + 清理所有监听器
- 修复连续开截图窗口导致的 `onMessage` 监听器累积泄漏

### 🔧 sync/local 多端冲突标记

- 导入数据超限回退 local 时，在 sync settings 写入 `storageFallback: 'local'` 标记
- 启动时检测到此标记，Toast 提示「数据量较大，使用本地存储。多设备同步请用 zip 备份」
- 每设备仅弹一次（`chrome.storage.local` 持久化标记，跨标签页生效）
- 其他设备首次打开时同样会收到提示

---

## v1.1.8 (2026-06-05)

### 🐛 崩溃修复

- 修复删除分组时 index 越界导致 `Cannot read properties of undefined (reading 'name')` 崩溃
- 修复重置数据时 IndexedDB `onversionchange` 对 null 调 `.close()` 崩溃
- 修复滚动时 `e.target.closest is not a function` 崩溃（scroll target 可能为 document）
- 修复 `saveToStorage` 未消费 `lastError` 导致控制台 `Unchecked runtime.lastError`

### 🐛 关键修复：FVD 导入跨组重复 ID

- 修复 FVD 转换器生成的卡片 ID 跨组重复，导致截图刷新、访问计数更新到错误分组
- `refreshCardCapture`、`incrementVisitCount` 仅更新当前活动分组的卡片，不再跨组查找
- `importAll` 新增 `dedupCardIds` 去重：导入时检测重复 ID 并生成全局唯一 ID
- 同步重映射 IndexedDB blob key 和 manifest 图片列表
- FVD 转换器：卡片 ID 格式加入分组索引 `fvd_<ts>_g<分组>_<序号>` 确保全局唯一

> ⚠️ **已有数据的用户修复方法**：设置 → 数据 → 全部导出（下载 .zip）→ 重置全部 → 全部导入（选择刚下载的 .zip）。导入过程会自动检测重复 ID 并修复，修复数量会在成功提示中显示。

### 🐛 其他修复

- 修复导入预览点击取消后 loading 遮罩卡死、无法关闭

### 🐛 修复「移动到分组」子菜单溢出与滚轮消失

- 子菜单新增 `max-height: 320px` + `overflow-y: auto`，分组过多时出现滚动条，不会溢出屏幕
- `showMoveSubmenu()` 增加纵向边界检测：子菜单超出屏幕底部时自动向上对齐
- 子菜单内绑定 `wheel` 事件 `stopPropagation()`，阻止滚轮冒泡到 `window` 导致菜单消失

### 🔧 新增「关闭滚轮切换分组」开关

- 设置面板 → 功能 → 新增「关闭滚轮切换分组」复选框（默认关闭）
- 开启后鼠标滚轮不再触发分组切换，仅通过左侧指示器点击切换分组
- 设置实时生效，无需刷新页面

---

## v1.1.7 (2026-06-04)

### 🎚️ 壁纸遮罩透明度

- 壁纸标签新增「壁纸遮罩」滑块（0-80%），控制壁纸上方的黑色遮罩强度
- 浅色/深色主题共享同一值，CSS `calc(var(--wallpaper-opacity)/100)` 实时预览
- `setBackgroundImage` 添加 `has-wallpaper` 后立即从 `currentSettings` 同步遮罩值，避免切换壁纸出现默认 30% 残留

### 🐛 深色模式修复

- `applyAppearance`：颜色类 CSS 变量仅在用户自定义时覆盖，否则交由 `[data-theme="dark"]` 选择器控制
- `bindAppearancePreview`：实时预览同理，只在有值时覆盖
- 重置按钮：`setProperty` → `removeProperty`，清掉 inline style 后主题恢复正常
- `collectAppearanceForm`：值等于默认返回 `''`，防止未自定义颜色被收集为具体值覆盖主题

### 🐛 备份恢复修复

- **修复备份恢复后面板设置丢失**：`getSettings()` 增加 `storage.local` 回退（与 `getGroups()`/`getActiveGroup()` 行为一致）
- **修复导出丢失本地存储数据**：`exportAll()` 检测 sync 分区为空时自动从 `local` 补充读取
- **修复导入超限回退静默失败**：两种回退路径均检测 `lastError`，settings 失败再写入 `local`

---

## v1.1.6 (2026-06-04)

### 🐛 关键修复

- 修复 IndexedDB GC 只查 sync 导致 local 存储用户的截图全部误删
- 修复截图窗口内页面跳转后截图按钮消失
- 修复点击卡片跳转时自定义图片瞬间破图（`current` 模式跳过 DOM 重建）
- 分组删除改为自定义确认弹窗（与卡片删除一致），不再弹出浏览器 `confirm()`
- `doResetAll()` 增加 `chrome.storage.local.clear()`，防止大容量回退数据残留

---

## v1.1.5 (2026-06-04)

### 📸 网页截图（手动模式）

- 编辑对话框「网页截图」/ 右键「刷新截图」→ 弹出目标页面窗口
- 用户可自由调整窗口大小、滚动位置，右下角蓝色「📸 截图」按钮确认
- 点击截图 → 自动去滚动条 + 隐藏按钮 → 截取 → 窗口关闭 → 存为卡片图标
- 1400×900 默认窗口，注入按钮归用户控制

### 🐛 修复

- 壁纸模式切换为自定义 URL 时隐藏 Bing 版权/翻页按钮
- 对话框「Favicon」提示文字改为「默认图标」
- 截图回调重读最新分组数据，防止覆盖期间发生的删除
- 卡片悬停鼠标改为手指（`pointer`），拖拽时全局握拳（`grabbing`）

---

## v1.1.4 (2026-06-04)

### 🎨 纯色背景

- 壁纸模式「纯色背景」新增颜色选择器，实时预览

### 📏 分组指示器尺寸

- 新增「指示器大小」滑块，根据分组位置自动切换：左右模式调圆点直径(6-24px)、上下模式调标签字号(10-22px)

### 🖱️ 滚轮防误切

- 滚轮浏览卡片到底后需再滚一次才切换分组，防止快速滚动误触
- 2 秒超时自动重置，同方向连续触发
- 修复：`body { height:100% }` 导致边界检测恒真，改用 `documentElement.scrollTop/scrollHeight`

---

## v1.1.3 (2026-06-04)

### 💾 大容量存储回退

- `chrome.storage.sync` 超 100KB 时自动回退 `chrome.storage.local`（~10MB 上限）
- `getGroups()`/`getActiveGroup()` sync 为空时自动查 local
- `saveGroups()` 写入后验证，超限自动写 local 副本
- 导入成功 Toast 区分「支持跨设备同步」/「使用本地存储」

### 🔀 FVD 迁移工具修复

- 卡片/分组数据结构与当前版本全量同步
- 设置键名全量更新，预览摘要显示预计 JSON 大小并超限警告

---

## v1.1.2 (2026-06-04)

### ⌨️ 快捷键重映射

- `Ctrl+,` → `Alt+,`：Chrome 保留 `Ctrl+,` 为内置设置页，改为 Alt 组合键
- `Ctrl+N` → `Alt+N`：Chrome 保留 `Ctrl+N` 为新窗口，改为 Alt 组合键
- `Alt+,`/`Alt+N` 改为全局快捷键，搜索框聚焦时也能触发
- 移除无效的 `Ctrl+Shift+F` 备选
- 点击页面空白处自动聚焦搜索框（新标签页地址栏抢占焦点无法避免）

### 文档同步

- README 快捷键表更新 + FVD 迁移说明修正（favicon → 首字符色块）

---

## v1.1.1 (2026-06-03)

### 🛡️ 安全加固

- 移除 `host_permissions` 中 `http://*/*` 明文 HTTP 权限
- 自定义搜索引擎 URL 输入时强制校验 `https://` + `{q}` 占位符

### 🐛 缺陷修复

- **修复**（cards.js + style.css）：`+` 添加按钮缺少 `.card-wrapper` 包裹，未适配 v1.1.0 的 28px 信息栏高度，导致 Grid 中偏上不对齐
- **UX**（settings.js）：搜索栏关闭时自动禁用「搜索边距」「搜索卡距」滑块并灰化
- **新增**（外观）：卡片距顶滑块（4–600px），控制卡片网格与页面顶部的距离
- **修复**（groups.js）：分组圆点右键菜单始终不显示——`contextmenu` 事件缺少 `stopPropagation`，被 `document` 空白右键覆盖
- **修复**（style.css）：极简卡片信息栏开启时色块顶部改为直角（`:has(.card-top-bar)`），消除信息栏圆角与色块圆角视觉冲突
- **功能**（lunar.js）：农历「显示样式」设置此前从未生效——`updateLunarDisplay` 已支持双行/单行切换
- **内存**（backup.js）：导入 Zip 时逐张释放解压数据，避免全量驻留内存导致 OOM
- **内存**（backup.js）：导入完成后自动清理 IndexedDB 孤儿图片
- **内存**（main.js）：修复 hidden 状态下重复注册 visibilitychange 监听器
- **内存**（dragdrop.js）：Alt+Tab 时强制清理拖拽状态，防止滚轮永久失效
- **内存**（dragdrop.js）：预缓存卡片中心坐标，消除 mousemove 每帧 `getBoundingClientRect` 强制重排
- **性能**（appearance.js）：`updateGridColumns` 增加 rAF 节流，避免 input 事件每帧 Grid 重布局
- **性能**（cards.js）：`loadLocalCardImages` 改为 `for...of` 串行加载，消除 IndexedDB 并发风暴
- **性能**（settings.js + appearance.js）：修复双重 `change` 事件绑定导致每次设置变更执行两遍 save+render
- **性能**（weather.js）：`setWeatherCache` 直接返回 meta，消除冗余 IndexedDB 读取
- **渲染**（main.js）：`setLocked` silent 模式不再触发 `renderSpeeddials`，消除 onChanged 双次渲染
- **渲染**（settings.js）：面板拖拽增加 visibilitychange 安全网，防止 mouseup 丢失后持续 DOM 写入
- **功能**（background.js）：右键添加卡片补全 `visitCount`/`createdAt` 字段，ID 统一为 36 进制+随机后缀
- **功能**（weather.js）：修复 OpenWeatherMap 图标永远显示 `?` 的问题（新增 OWM→WMO 映射表）
- **功能**（groups.js）：修复分组管理器中点击名称输入框编辑时意外切换分组
- **功能**（groups.js）：修复新建分组对话框关闭后管理器提前重开的竞态
- **功能**（groups.js）：`switchGroup` 增加 `await` 确保存储写入完成
- **代码质量**（wallpaper.js）：`collectGarbage` → `collectCardImageGarbage`，名实相符
- **代码质量**（wallpaper.js）：`openImgDB` 增加连接单例缓存
- **代码质量**（background.js）：`stringToColor` 添加同步警告注释
- **代码质量**（contextmenu.js）：moveToGroup 悬停绑定移至 `initContextMenu`，消除匿名函数重建

---

## v1.1.0 (2026-06-03)

### 🧹 精简

- 完全移除「卡片上方显示图标」功能（Toggle + favicon 图标）
- 卡片缩略图不再加载 favicon，无自定义图时直接显示首字符+哈希色块
- 自定义图片上传/缓存不受影响

### 🎨 外观面板重映射

- 「背景颜色」→「信息栏背景颜色」：控制顶部信息栏底色
- 「卡片文字颜色」→「信息栏文字颜色」：控制标题和计数颜色
- 「卡片字号」→「信息栏字号」：控制标题字号
- 「卡片背景色」：正确影响卡片本体缩略图区域

### ✨ 沉浸模式

- 双击页面空白 → 隐藏卡片/搜索/看板/指示器
- 仅保留背景壁纸 + 壁纸导航 + 设置按钮
- 再双击恢复，Toast 提示状态切换

### 🎨 界面一致性调整

- 设置面板下拉选择器（主题模式/排序/打开方式等）统一改为标签+控件同行
- 滑块控件统一改为标签+数值徽章+滑条同行，滑条等宽、徽章等宽(56px)
- 外观颜色选择器改为正方形色块(34px)，标签色块同行
- 新增分区标题：🔤 信息栏设置；📐 卡片尺寸与布局 → 📐 卡片布局
- 新增重置按钮：信息栏/卡片大小/搜索位置
- 看板选项卡滑块统一化（水平/垂直位置、组件宽度/高度/间距）
- 「分组」→「分组指示器位置」，「组名显示」→「分组名显示」
- 「删除卡片时弹出确认」移至极简卡片下方
- 搜索框相关标签缩写为「搜索边距」「搜索卡距」

### 🧹 IndexedDB 垃圾回收 (GC)

- 启动时自动清理无主图片（已删除卡片/分组的残留缓存）
- 删除分组时同步清理该组所有卡片的缓存图片
- 防止长期使用后备份包膨胀

### 📂 导入预览

- Zip 导入前展示摘要：分组数、卡片数、缓存图片数、导出时间
- 用户确认后才执行实际写入，防止误覆盖

### 🎯 信息栏布局

- 标题文字绝对居中（不受计数宽度影响）
- 访问计数固定最右侧

### 🐛 修复

- 深色模式数据标签按钮字体不可读
- `cardBgColor` 不再影响按钮背景
- `card-thumb` 背景跟随卡片背景色
- 导入文件选择框不再撑出滚动条
- `deleteCardIcon` 仅更换图片时才删除

---

## v1.0.9 (2026-06-03)

### 📊 访问计数

- 卡片新增「👁 访问计数」显示，记录每次打开次数
- 左键点击、中键点击、右键「打开」均会 +1
- 设置面板「功能」标签 Toggle 控制显隐

### 🔀 卡片排序（按分组独立）

- 5 种排序模式：手动拖拽 / 添加时间正倒序 / 访问数正倒序
- 每个分组独立设置排序方式，互不影响
- 排序模式下自动禁用拖拽，切回手动恢复

### 🎨 顶部信息栏重构

- 图标、标题、访问计数移至卡片上方独立信息栏（28px）
- 卡片缩略图区域不再被挤压，100% 呈现自定义图片
- 信息栏与卡片共用背景+圆角+阴影，视觉融为一体

### 🔧 细节优化

- 36 个表单控件补齐 `<label for>` 无障碍关联
- 切换分组去掉淡入淡出动画，消除白色闪烁
- 编辑图片时仅更换才删旧缓存，修复保存后破图
- 导入时先写图片再写配置，修复时序导致的图片丢失
- Google S2 → iowen → cccyun → faviconkit 多级 favicon 降级

### 🐛 修复

- 重置数据后导入备份，自定义图片引用失效自动清除
- 旧卡片缺 `visitCount`/`createdAt` 字段自动补全
- 深色模式顶部信息栏颜色适配

### ⚠️ 已知问题（v1.1.0 修复）

- 设置面板「卡片背景色」在暗色模式下调节后不生效

---

## v1.0.8 (2026-06-03)

### 🔍 重复卡片检测

- 手动添加卡片时，自动检查 URL 域名是否已存在，弹出确认对话框
- 右键菜单添加时，在当前网页直接弹出 `confirm` 确认框（`scripting` 权限）
- 发现重复显示：分组名 + 已有卡片名，可选「取消」或「确定」继续添加

### 🐛 修复

- `backup.js`：导入时去掉 `clear()+set()` 嵌套改为直接 `set()`，修复大备份文件面板参数丢失

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

- `cards.js`：移除 inline `onerror` 属性，改用 JS 监听器，消除 CSP 警告
- `backup.js`：导入时去掉 `clear()+set()` 嵌套改为直接 `set()`，修复大备份文件面板参数丢失

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
- 