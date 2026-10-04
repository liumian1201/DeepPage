# DeepPage 更新日志

## v1.6.2 (待发布) — 🐛 修复：截图权限（BUG-078）· 分组拖拽（BUG-079）· 滑块可读性（BUG-080）· 多选壁纸（BUG-081）· #8 人工核对 5 条（BUG-082 ~ BUG-086）· 分组行拖不动真因（BUG-087）· 分组行排序改鼠标事件（BUG-088）

> 本版把原计划的 v1.6.2 + v1.6.3 **合并为一次发版**（用户 2026-10-04 决定）。

### 🐛 BUG-078 网页截图整体失效（`captureVisibleTab` 只接受 `<all_urls>`）


> **用户实测**：卡片右键 →「📸 刷新截图」→ 弹出窗口 → 点「📸 截图」→ 红色提示
> 「截图失败: `Either the '<all_urls>' or 'activeTab' permission is required.`」

### 🐛 根因：v1.3.3 的权限收窄打断了整条截图链路（潜伏 **12 个版本**）
- 截图链路是：`chrome.windows.create` 开窗 → `chrome.scripting.executeScript` 注入「📸 截图」按钮
  → 用户点击 → `chrome.tabs.captureVisibleTab(win.id)` 取图。
- 而 **`captureVisibleTab` 只接受 `<all_urls>` 或已授权的 `activeTab`**。P1-10（v1.3.3）把
  `host_permissions` 从 `<all_urls>` 收窄成 `https://*/*` 之后，这一步**必然失败** ——
  与页面协议无关，**https 页面一样失败**。
- 为什么一直没被发现：全仓**没有任何断言真的跑过一次「成功截图」**。BUG-046（v1.5.13）补的是
  **权限闸门**（未授权时不开窗、给出提示），它只保证「失败得清楚」，不保证「成功得起来」。

### 🔬 实测证据（真实 Chromium + 真实 `captureScreenshot()` + 真实点击注入按钮）
| 权限配置 | 结果 |
|---|---|
| `https://*/*`（v1.6.1 现状） | ❌ `Either the '<all_urls>' or 'activeTab' permission is required.` |
| `https://*/*` + 声明 `activeTab` | ❌ 仍失败（programmatic 打开的窗口没有 activeTab 授权） |
| **`<all_urls>`** | ✅ 成功：本机 https 页面 **68,766 字节** PNG、本地 fixture **12,098 字节** PNG |

结论：**除 `<all_urls>` 外无可行解**（`activeTab` 这条路是实测被否掉的，不是文档推断）。

### 🔧 修复
- `manifest.json`：`host_permissions` 回退为 `["<all_urls>"]`；移除已冗余的
  `optional_host_permissions: ["http://*/*"]` —— 实测 `<all_urls>` 已覆盖 http
  （`permissions.contains({origins:['http://*/*']})` 返回 `true`），权限闸门因此自然短路，
  不再弹「访问 http 网站」授权框。
- 权限闸门代码（`ensurePermissionForUrl` / `swHasHttpHostPermission`）**保留**：属纵深防御 ——
  万一将来再次收窄，仍会给出提示而不是静默失败。
- `PRIVACY_POLICY.md` 权限表同步（含「为什么截图需要 `<all_urls>`」的理由）。
- ⚠️ **这是对 P1-10（v1.3.3「权限收窄」）的部分回退**，已记入 `ROADMAP.md`。
  代价：安装/更新时权限提示回到「读取和更改您在所有网站上的数据」。
  （当前分发是 .crx 拖拽 / 解压加载，不涉及商店自动更新时的权限重批。）

### ✅ 测试（4 项新断言 + 2 项改写 + 3 项恢复确定性）
- `tests/e2e-p0.test.js` 新增 [34] 段，靶子用**本地静态 HTTP 页面**（离线、确定、不依赖外网）：
  ① SW 契约层：真实消息 → 真实开窗 → **真实点击注入按钮** → 拿到 `data:image/png`；
  ② **PNG 完整性**：Node 侧用内置 `zlib` 校验 PNG 签名 + IHDR + `IDAT` 解压长度 == `h*(1+w*channels)`
     （比「字符串非空」强得多，能证明不是空串或截断数据）；
  ③ 用户路径：`refreshCardCapture()`（右键「刷新截图」的入口）→ 卡片封面真的写成 `idx:` 引用并落库；
  ④ 用户路径：出现「截图已更新」且**没有**红色「截图失败」。
- [10] 段两条 P1-10 断言改写为新权限模型，并把「为什么必须 `<all_urls>`」写进注释 ——
  **任何人再次收窄权限，[34] 段的真实截图断言都会直接失败**（这是本次补上的关键护栏）。
- `tests/e2e-sw-protocol.test.js`：BUG-046 的 3 条闸门断言原先按「环境是否已授权 http」分支，
  `<all_urls>` 之后该分支恒为「已授权」→ 断言会被**整段静默跳过**（覆盖悄悄消失）。
  改为**在 SW 上下文里把 `permissions.contains` 桩成未授权**，断言恢复确定性、与环境无关。

### 🐛 BUG-079 分组管理器拖不动（用户实测：拖动有禁止光标、松手顺序不变）
- **真因有三层，缺一层都修不好**：
  1. **行间空隙不接受放置（决定性）**：`dragover` 只在 `e.target` 命中某一行时才 `preventDefault()`。
     光标落到**行间空隙 / 列表留白**（行距、列表底部空白）时，浏览器判定「此处不接受放置」
     → 禁止光标 + **`drop` 永不触发** + 顺序静默不变。
     **修**：整块列表都接受放置；空隙里按落点 `clientY` 与各行中线比较找最近的行，列表留白归到末尾。
  2. **拖拽源只有 ⠿ 手柄**：行的其它区域没有 `draggable` → 按行主体拖动时浏览器走的是**文本拖拽**
     （选中行内文字），表现出来就是「跟着鼠标的是 ⠿ 字形 + 满屏禁止光标」。
     **修**：**整行作为拖拽源**；行内 `user-select:none`（输入框保留选字）+ 行主体 `cursor:grab`；
     `mousedown` 落在 `input`/`button` 上时**临时关掉行的 `draggable`**（输入框仍能选字、按钮仍能点）。
  3. **第一层原因**（本版早些时候已修）：拖拽事件逐行绑定 + `dragFrom` 在渲染闭包里，
     拖拽途中一次重渲染就丢状态。**它必要但不充分** —— 只修它，用户遇到的两种情况依然拖不动。
- **⚠️ 一条被推翻的环境结论**：曾判定为「Catsxp（猫眼）的超级拖拽/鼠标手势抢走了原生拖拽」，
  并准备写进 README 作为环境限制。用户复测**同一浏览器**下**卡片拖拽（同样是 HTML5 DnD）正常**
  → 结论**推翻**（看板编辑态拖拽用的是 `mousedown` + 鼠标移动，不是 HTML5 DnD，不能作为反证）。
  **不在 README 写「请先关闭超级拖拽」**。
- **测试**：真实 CDP 拖拽断言 —— 普通拖拽、拖拽中途重渲染、**落在两行中线空隙也能重排**、
  **整行非输入区起拖能重排**，以及「输入框上按下不启动行拖拽且仍可选字」。旧代码（v1.6.1）上后三项必败。
  原 E2E 用合成 `DragEvent`，**绕过了浏览器 DnD 状态机**，正是这个覆盖缺口让本缺陷潜伏。

### 🐛 BUG-080 滑块轨道不可读 + 单张遮罩状态不可逆
- **轨道不可读**（用户截图指出）：轨道原为 `--bg-tertiary`，与面板底色对比仅 **1.21:1（浅）/ 1.47:1（深）**，
  远低于 WCAG 非文字控件 3:1；且**没有进度填充** —— 0% 与 80% 视觉上完全一样。
  修复：新增 `--slider-track`（浅 `#80868b` / 深 `#6b7280`）+ 轨道改为「已填充(accent) + 未填充」渐变，
  `--pct` 由 `_syncRangeFill()` 统一同步。**实测对比：浅色 3.68:1、深色 3.22:1**。
  顺带删掉 `base.css` 里那条会**整个盖掉渐变**的深色平色覆盖（否则深色下等于没修）。
- **单张遮罩不可逆**：`setLocalWallpaperOpacity(key, 数字)` 一旦写入，标签永久变成「N%」，
  **没有任何入口回到「跟随全局」**。修复：该行新增 **「↺ 跟随全局」** 按钮（仅在已设独立遮罩时出现，
  点击即 `setLocalWallpaperOpacity(key, null)`）；值标签复用 `.slider-val` 徽章样式，可读性同步改善。
- **测试**：新增 4 项断言（两种主题轨道对比 ≥3:1 且确实用了渐变、`--pct` 随值同步（60/80→75%）、
  ↺ 按钮「出现 → 点击 → 消失 + 存储值回 null」全链路）。

### 🐛 BUG-081 多选本地壁纸只生效第一张
- **根因**：`change` 处理器先把 `this.files` 交给 async 的 `addLocalWallpapers()`，紧接着 `this.value = ''`
  **清空 FileList**；async 内部 `await uploadImage()` 让出后，循环下一轮读到 `files.length === 0` → 提前退出。
- **修复**：进 async 之前先 `[].slice.call(this.files)` **快照成数组**再清空 input。
- **测试**：构造 3 个 `File` → 触发 `change` → 断言 3 张全部入库（旧代码只 +1）。

### 🐛 BUG-082 点「↺ 重置」后滑块进度填充不跟随滑块（#8-1 人工核对 图1）
- **现象**：把「卡片高度」拖小再点「↺ 重置卡片大小」→ 滑块与标签都回到 270px，**进度填充还停在旧位置**。
- **根因**：BUG-080 的 `--pct` 同步器挂在 `input` 事件上，而**重置按钮是程序化赋值 → 不触发 `input`**。
- **实测（含 BUG-080、不含本修）**：4 个重置按钮**全部**留下 stale 进度 —— 卡片高度 270px vs `0%`、
  组件间距 16px vs `82.6%`、搜索栏顶距 60px vs `39.6%`、搜索栏间距 48px vs `100%`、信息栏字号 13px vs `66.7%`
  （共 **9 个滑块**）。
- **修复**：新增 `_setRangeValue()`（赋值 + 同步 `--pct`），4 个重置处理器全部改走它；
  面板每次打开、回填之后 `_syncAllRangeFills()` 再兜一次。
- **测试口径**：不变量断言 —— 面板内**每个**滑块的 `--pct` 必须等于由 `(value, min, max)` 算出的百分比。

### 🐛 BUG-083 首次打开时右上角「切换主题」按钮点不动（#8-3 人工核对）
- **现象**：新开标签页点主题按钮没反应；**点一下设置按钮、再把面板关掉**之后就能点了。
- **根因**：主题按钮的监听器与图标初始化写在 `bindSettingsEvents()` 里，而它只在**首次打开设置面板**
  （v1.3.3 的懒初始化）时执行 → 首屏这个按钮**没有任何监听器**（与 BUG-048 同族：面板懒初始化殃及面板外控件）。
- **修复**：抽成幂等的 `_initThemeToggle()`（防重复绑定），在启动路径 `initSettings()` 里调用。
- **测试**：断言跑在**面板尚未初始化时**（E2E `[5]` 段打开面板之前，顺序不可挪）—— 点击真的切主题
  （light→dark）+ `elementFromPoint` 命中按钮自身（排除「被别的元素遮住」这条岔路）。

### 🐛 BUG-084 沉浸模式下滚轮切组 → 退出后卡片变成每行 1 张（#8-6 人工核对）
- **复现**：双击空白进沉浸 → 向下滚两次切一组（重复 1~3 次）→ 双击退出 → **每行只剩 1 张**；刷新恢复。
- **根因**：沉浸模式把 `.speeddial-section` 设为 `display:none` → `#speeddial-grid` 父容器 `clientWidth = 0`
  → 期间任何一次 `updateGridColumns()`（滚轮切组 → `renderSpeeddials()` → `updateGridColumns()`）
  都在零宽容器上测量，算出 `actualCols = 1` 并把 **`grid.style.width = 270px`（一张卡宽）写进内联样式**；
  退出沉浸时**没有任何路径重算**（唯一入口是 `window.resize`）→ 270px 宽里 `auto-fill` 只能排 1 列。
- **澄清**：坏的是**内联 CSS**，不是设置 —— 各阶段 `currentSettings.columns` 与 sync 里恒为 5。
- **修复**：① `updateGridColumns()` **零宽 / 无父容器时直接返回**（不测量、不写样式；原来还会回退
  `window.innerWidth`，同族错误）；② 退出沉浸模式时显式重算一次。
- **测试**：真实滚轮切组（每切一组需同方向滚**两下**）→ 退出后断言内联宽度不是「一张卡宽」且容器宽 > 1.5 张卡。

### 🐛 BUG-085 垂直排列下看板组件的 −/＋ 宽度按钮「点了没反应」（#8-2 人工核对）
- **现象**：布局方向=垂直排列时，编辑态点 −/＋ → 宽度一动不动（切回水平排列才发现宽度早改了）。
- **根因**：`[data-layout="column"] .dashboard-item { flex: 0 0 auto; width: 100% }`（特异性 0,2,1）
  压过 `.dashboard-item { flex: 0 1 calc(… var(--dash-n) …) }`（0,1,0）→ 跨列数在垂直排列下对渲染**完全无效**；
  而点击处理器照常改 span **并落盘**（实测连点两次 ＋ 后 sync 里 span 已 3→5）→ **静默不一致**。
- **用户口径**：布局方向只决定横排 / 竖排，**设置好的宽度不能因为换排列方式就变，两种排列下都必须可调**。
- **修复**：垂直排列（含 `≤560px` 窄屏规则）不再覆盖宽度，改用与水平排列**同一条跨列数公式**，
  交叉轴 `align-items: center`（单列堆叠 + 居中）。
- **测试**：① 同一批组件在 row / column 两种排列下宽度**逐项一致**（±1px）；
  ② 垂直排列下真实点 ＋/− → span 与**宽度都变化**（修复前 span 变、宽度 Δ0）。
  旧断言「垂直排列：组件上下堆叠且等宽」把旧语义固化成了"正确行为"，本版按新口径改写。

### 🐛 BUG-086 「✋ 编辑组件顺序」按钮文字靠左（#8-2 人工核对，观感）
- **实测**：该按钮在 `.setting-group` 里被拉成满宽 **446×42px**，而 `.btn-backup { text-align: left }`
  → **文字中心比按钮中心偏左 155.32px**；同页、同宽、同 padding 的 `.btn-reset-danger`（居中）实测偏差 **0**。
  （排除项：编辑态组件上的 ◀▶ 箭头实测**是居中的**，16 个按钮偏差 ≤1px。）
- **修复**：**只改这一颗**（`#btn-dash-edit { text-align: center }`），其余同类按钮保持原样（用户口径）。
- **测试**：用 `Range` 量「文字块中心 vs 按钮中心」≤2px，并要求按钮真实可见（宽 >100px，避免隐藏时假通过）。

### 🐛 BUG-087 分组行「按住拖不动」——真因是 mousedown 里改 `draggable`（真实浏览器才复现）
- **现象**：分组管理器里按住整行拖不动；拖 ⠿ 手柄"一拖就变禁止光标"。同一浏览器里卡片拖拽（同为 HTML5 DnD）正常。
- **定位（用户浏览器取证包，三段对照）**：页面层对照 ✅ / **弹窗内对照 ✅** / **行克隆体（零处理器）✅**
  → 排除浏览器、弹窗层、行结构与 CSS；**唯一剩下的差异是我们自己的处理器**。
- **真因**：`mousedown`(capture) 里 `row.draggable = !(input||button)`。**Chrome 的拖拽启动决策在按下那一刻就定了**，
  在 `mousedown` 处理器里改 `draggable` 会让这次原生拖拽根本起不来 —— 本意只是"按在输入框上时别启动行拖拽"，
  代价却是整行都拖不动。
- **修复**：开关**前移到 `mouseover`**（指针移到行上之前必然先经过 mouseover）；`mousedown` 只记录
  "是否按在行内控件上"，`dragstart` 据此兜底 `preventDefault()`（保住输入框选字与按钮点击）。
- **⚠️ 为什么潜伏这么久**：**无头 Chromium 抓不到** —— E2E 走 CDP `Input.setInterceptDrags`（宽松），
  同样代码在无头里 `dragstart` 照常触发、一路全绿；**只有真机才暴露**。定位靠用户侧取证包（三段对照法）。
- **测试**：新增 2 项断言守机制（能否拖由 `mouseover` 决定且 `mousedown` 不再改属性 / 按在控件上时 `dragstart` 被取消）；
  旧代码上必败。

### 🐛 BUG-088 分组行排序改用**鼠标事件**（原生拖拽在该浏览器上走不完放置链路）
- **前情**：BUG-087 修好了"拖不起来"（真机日志已见 `★ dragstart 归类:row`），但**问题依旧**：
  光标全程 🚫、顺序不变。
- **决定性证据（用户真机 v4 取证日志）**：一次完整拖拽中 `dragstart` 正常、我们内部状态正确
  （`_gmgrDragFrom=0`、`.dragging=1`）、`dragenter` 也确实到达列表与各行 —— 但**一次 `drop` 都没有派发**，
  `dragend` 里 `dropEffect=none`、顺序不变。按规范 `dragover` 里 `preventDefault()` 之后必须派发 `drop`，
  这说明是该浏览器/环境对这类元素原生拖拽的处置，扩展侧无解。
- **修复**：**不再修补原生拖拽** —— 分组行排序改为**鼠标事件实现**（`mousedown` + 文档级
  `mousemove`/`mouseup`），即**看板编辑态那套机制**（用户实测在该浏览器里完全可用）。
  越过 4px 阈值进入拖拽态（源行半透明 + 目标行高亮 + grabbing 光标）→ 松手按落点 `clientY` 找最近行 →
  `moveGroupTo()`。行与 ⠿ 不再是原生 `draggable`（⠿ 保留 `tabindex` 与 ↑↓ 键盘排序）。
- **顺带解决**：① 落点不再受"必须在列表内"限制（弹窗任何位置松手都算）；② 不再有原生拖拽的 🚫 光标；
  ③ 拖拽中列表重渲染不再丢状态；④ 真拖过之后 300ms 内忽略 click（鼠标拖拽会产生 click，原生拖拽不会）
  ——否则会"松手即切分组"。
- **测试**：9 条真实鼠标事件断言（含"列表外的弹窗留白也能重排""输入框上按下不启动拖拽且仍可选字"）；
  旧代码上"行/手柄不再是 draggable + 旧 DnD 状态已移除"必败。

### ✅ 验证（合并后统一记录）
- 验证：E2E **517 项**（p0 439 + SW 23 + WebDAV 55）｜ 逻辑桩测 81 ｜ 工程反向对照 52 ｜ ESLint 0 error / 34 warning。
- 修复前 / 后对照（`DP_EXT_DIR` 指向 **v1.6.1** 源码）：**28 项失败**（p0 28 ｜ SW 0 ｜ WebDAV 0）→ 新代码 0 项失败。
  新增断言在旧代码上必须失败（否则是空转）；本版靶子 = 空隙落点 / 整行起拖 / 多选壁纸 /
  重置后 `--pct` / 首屏主题按钮 / 沉浸退出列数 / 垂直排列宽度 / **拖拽开关的摆放时机（BUG-087）**。

## v1.6.1 (2026-10-04) — 🐛 修复：自己导出的备份被误报「已忽略 1 项未知或不合法的设置（备份可能被篡改）」

> 用户在真实环境从云端恢复后看到两条并排提示：绿色的「☁️ 已从云端恢复（26 张图片），即将刷新...」
> 与橙色的「⚠️ 已忽略 1 项未知或不合法的设置（备份可能被篡改）」。**是误报**，而且触发者是扩展自己。

### 🐛 根因：安全告警被自己的导出元数据污染
- `exportAll()`（本地导出）与 `_collectAllData()`（**云端 / 手动 / 自动备份**）都会往
  `config.settings` 里写一个 `_exportTime` 时间戳，供导入预览显示「导出时间」。
- 而 BUG-043 / AUD-004 引入的白名单校验 `normalizeImportedSettings()` 只认
  `DEFAULT_SETTINGS` 的键 + 两个看板字段（`dashboardWidgetLayout` / `dashboardOrder`），
  不含 `_exportTime` → `countRejectedSettings()` 把它算成 1 项「未知设置」。
- 结果：**每一次**本地导入、**每一次**云端恢复都会弹「备份可能被篡改」。
  危害不在数据（被丢弃的确实是元数据、没有落盘），而在这个告警本身 ——
  它把安全信号变成了噪音（狼来了效应），用户会学会忽略真正的篡改提示。
- 复现（用户真实备份 + 真实校验函数复算）：`rejected = ["_exportTime"]`、`countRejectedSettings = 1`。

### 🔧 修复
- `countRejectedSettings()` 增加「本扩展注入的元数据」豁免：`storageFallback`（v1.1.9 的 sync/local
  回退标记，原本就已豁免）与 `_exportTime`（导出时间戳）。
- 豁免规则刻意收窄为**单下划线 + 小写字母**（`/^_[a-z]/`）：`__proto__` 这类原型污染键
  **仍然会被计数并告警**，不会顺手把安全门关掉。
- 只改「是否计数告警」，**不改白名单本身**：`_exportTime` 依旧不会被写进 storage（元数据不进设置）。

### ✅ 测试（8 项新断言，含两个方向的负对照）
- `tests/e2e-p0.test.js` 新增 [33] 段：
  - **修复方向**：带 `_exportTime` 的设置对象 `countRejectedSettings === 0`；且 `_exportTime` 仍不落盘；
    端到端「真实导出 → 重新导入自己导出的包」**不再出现任何「已忽略」告警**（含复现前提：导出包确实带 `_exportTime`）。
  - **负对照（关键：不能为了消音把安全信号关掉）**：插入未知键 `evilKey` 仍计数为 1、白名单仍丢弃它、
    storage 里确实没有它；`__proto__` 仍计数告警且原型未被污染；端到端塞入 `evilKey` 的「被篡改」备份
    仍打印「已忽略 1 项」。
- 验证：E2E **485 项**（p0 407 + SW 23 + WebDAV 55）｜ 逻辑桩测 81 ｜ 工程反向对照 52 ｜ ESLint 0 error / 34 warning。
- 修复前 / 后对照（`DP_EXT_DIR` 指向 v1.6.0 源码）：新增断言在旧代码上失败 **3 项**、新代码 0 项失败。
  三条分别是：① 误报本身（旧代码 `metaCount = 1`）；② 负对照「未知键计数恰好为 1」（旧代码把 `_exportTime`
  也算进去 → `evilCount = 2`，计数被污染抬高）；③ 端到端「已忽略 1 项」（旧代码打印「已忽略 **2** 项」）。
  值得注意：**安全方向没有被削弱** —— 旧代码同样丢弃未知键、同样告警，本修复只是把元数据从计数里摘出去。
- 用**用户提供的真实备份**（`20261004_162105_DeepPage_Backup.zip`，3 分组 / 25 卡片 / 26 图片）复算：
  修复后 `rejected = 0`（修复前为 1），68 个合法设置键全部保留。

### 📌 顺带记录（未改动，留给后续决策）
- 两条导入路径的**用户可见反馈不一致**：云端恢复在丢弃未知设置时会弹 Toast，
  而 ZIP 导入只 `console.warn`。两者都符合本项目 DEBT-02 的分类口径（能降级 → 留痕），
  但对同一个安全信号给出不同强度的反馈属未记录的差异；是否统一留给后续决策
  （统一会引入用户可见文案，按约定需配一次视觉核对）。

## v1.6.0 (2026-10-04) — 🧊 封版里程碑：三条工作线清零 + 收尾清理（**无新功能**）

> 本版**不新增任何功能**，是一次**封版标记 + 收尾批次**。至此三条工作线全部收口：
> - **功能线**：P0/P1/P2 已清空；P3 已完成 6 项，剩余 5 项由用户决定放弃（未开工，条目保留供将来捡回）
> - **缺陷线**：v1.5.5 全量审计 **42 条全部修完**（v1.5.6 ~ v1.5.13 八批）
> - **技术债线**：DEBT-01 死函数 ✅ v1.5.14、DEBT-02 静默吞异常 ✅ v1.5.15（`src/js/` 20 处）+ v1.5.16（`background.js` 7 处）
>
> 回归扫描 `audit-static-scan.mjs` 的**第 1 节（死符号）/ 第 2 节（DOM id 对齐）/ 第 6 节（空 catch）全部为空**。
> 本版之后进入**冻结维护期**：只做缺陷修复与文档/依赖同步，不再引入新功能。

### 🧹 收尾清理

- **DEBT-01 最后一处残留**：v1.5.14 删掉页面侧 `webdavListConfigs()` 之后，SW 的 `webdav:config-list` 分支、
  `WEBDAV_MSG.CONFIG_LIST` 常量、以及 `webdavProxy` 里两处为它服务的共享判据就都没有调用方了
  （云端 config 列表实际来自 `manifest.configs`，从不走这条消息）→ 一并删除，`IMG_LIST` 的目录列举逻辑随之简化。
- **CI Chromium 缓存加固**：缓存 key 原先是写死的 `chromium-${os}-latest`，导致缓存**永远命中** ——
  CI 被静默钉死在首次下载的那个 Chromium 上（"latest" 名不副实，也没法刷新）→ 改为
  `chromium-${os}-${CHROMIUM_CACHE_REV}`，用显式 rev 变量控制（递增即为「重新下载当时的最新版」）；
  同时把「准备 Chromium」从「按 `cache-hit` 判定」改成「按二进制是否真的存在判定」——
  缓存被清理或只恢复一半时会自愈，文件在则绝不重复下载。
- **文档对齐现实**（三处都已有内容漂移）：
  - `tests/README.md`：补齐「**三个**套件都支持 `DP_EXT_DIR`」（原先只写了两个，会误导出假对照）、
    SW 侧断言的 CDP 挂载方式与两条硬约束、「单条用例错误隔离」约定、新基线，以及「新增用户可见文案要补视觉核对」。
  - `README.md` 本地开发段：`npm test` / `npm run test:e2e` 的实际内容与项数、退出码 `3` 的语义
    （必须用 Chromium 构建）、`DP_EXT_DIR` 对照、`bump` 示例去掉会过期的版本号。
  - `_private/tools/README.md`：探针定位从「每条对应一个已确认缺陷」更新为**回归基线**（当前代码应全 `ok: true`，
    指向修复前源码应翻转），并写明 `audit-static-scan.mjs` 是**按文本计数**的候选扫描器
    （名字留在注释里就会漏掉、只识别单行空 catch），不能当结论用。

### ✅ 验证
- E2E **477 项**（p0 399 + SW 23 + WebDAV 55）｜ 逻辑桩测 81（29 + 22 + 30）｜ ESLint 0 error / 34 warning。
- 新增 SW 断言 **2 项**钉住本次清理：`webdav:config-list` **不再被 SW 响应**（旧代码回错误对象 → 对照翻转），
  正对照 `webdav:img-list` 仍被响应（只删了没调用方的那条）。
- 回归探针全部 `ok: true`；`audit-static-scan.mjs` 第 1 / 2 / 6 节为空。
- 发布包抽查：34 文件 / MV3 / 无 `_private`·`tests`·`package.json` 泄漏 / 自有代码空 catch = 0。

### 📌 冻结维护期约定（写给后人）
- 只接受**缺陷修复**：走 `CHANGELOG` + 补**行为断言** + 修复前 / 后对照；要开新功能请先改 `ROADMAP.md` 状态。
- **DEBT-03**（16 个 ≥80 行函数）**不排批**：只在改到相关函数时顺手拆；
  **DEBT-04**（「表单管不到」的字段）**零代码**：新增设置字段前先 grep 存储键是否被占用。
- 降级路径诊断**只用 `console.warn`**；「用户主动取消 / 主动关窗」不得刷诊断；**CI 是唯一判据**（本地绿 ≠ CI 绿）。

## v1.5.17 (2026-10-04) — CI 修复：Service Worker 上下文挂载健壮性（扩展运行时代码零改动）

> v1.5.16 的**扩展代码本身没问题**，但它的 CI 首跑全红 —— 原因在**测试挂载 SW 上下文的方式**，
> 且只在 CI 环境暴露。本版只改测试与文档，扩展运行时代码与 v1.5.16 **完全一致**；
> 之所以单独发一个版本，是为了让发布产物对应一次**全绿的 CI**（tag 与已发布产物不改写）。

### 🔧 现象与根因
- **现象**：CI 里 SW 套件的 DEBT-02 断言全红，失败签名与「旧代码」一模一样
  （`_swWarnDegraded is not defined`、连 `chrome` 都没有）；但**同一时刻消息协议工作正常**
  （`webdav:put` 照常返回 `{ ok:false, error:'Failed to fetch' }`）。
- **根因**：MV3 的 Service Worker 会被浏览器**空闲回收再重启**，`Target.getTargets` 可能同时列出
  「已停用实例」与「新实例」，**两者 url 都是 `background.js`**。原实现 `.find()` 取第一个 + 单次求值，
  于是挂到了那个空上下文（消息走的是真正活着的那个实例，所以协议类断言照常通过）。
  本地机器快、SW 不易被回收，所以一直没暴露 —— **只在 CI（更慢 + 空闲回收更频繁）复现**。
- **修法**：① 先做一次消息往返唤醒 SW；② 遍历**所有**候选 target，逐个挂上并**轮询等待**
  `background.js` 真的在该上下文就绪 —— 就绪判据刻意用**新旧版本都存在**的符号
  （`stringToColor` + `chrome.runtime`），否则修复前 / 后对照会退化成 1 条失败；
  ③ 断言过程中上下文被回收时自动重挂一次；④ 失败时打印「见过的 SW target 列表」，便于下次一眼定位。

### ✅ 验证
- 本地：SW 套件 21/21（与 v1.5.16 预期一致）；修复前 / 后对照仍是 **旧代码 8 项失败 → 新代码 0 项失败**。
- CI：本版 tag 的 CI 与 Release 均 success（v1.5.16 的 CI 红正是本次修复的对象，tag 不改写）。
- E2E **475 项**（p0 399 + SW 21 + WebDAV 55）｜ 逻辑桩测 29 ｜ 工程反向对照 52 ｜ ESLint 0 error / 34 warning。

## v1.5.16 (2026-10-04) — 技术债清理 ③（收官）：DEBT-02 静默吞异常（`background.js` 7 处）→ **技术债清零**

> 第三批 = DEBT-02 在 **Service Worker 侧**的剩余 7 处。至此 `audit-static-scan.mjs` 第 6 节
> （空 catch）**完全清零**，DEBT-01 / DEBT-02 两条技术债全部结清。
> 口径与 v1.5.15 完全一致：**能降级 → `console.warn`**、**有意静默 → `best-effort` 注释**、
> **「用户主动关窗」不算失败 → 静默**。SW 不加载页面脚本，所以诊断出口是独立的
> `_swWarnDegraded(what, err)`（同样**只用 `console.warn`**）。
>
> ⚠️ SW 侧的「MKCOL 建目录」值得单独说明：HTTP 405（目录已存在）**不会**进 catch ——
> `fetch` 只在网络层失败时 reject，所以这里的 warn 是真失败信号，不会变成噪音。

### 🔇 DEBT-02 分级治理（`background.js` 7 处）

| # | 位置 | 判定 | 处理 |
|:-:|------|------|------|
| 1 | `webdavProxy('PUT')`：MKCOL 建 WebDAV 根目录 | 能降级（后续 PUT 自己会报错） | warn（带上下文） |
| 2 | `webdavProxy('PUT')`：读取失败响应的文本片段 | **有意静默**（只是给错误信息补充服务端返回，失败上报不受影响） | `// best-effort` 注释 |
| 3 | `webdavProxy('*_PUT')`：MKCOL 建子目录（`config/`、`img/`） | 能降级 | warn（带目录名） |
| 4 | `captureScreenshot` 失败出口：关闭截图窗口 | 窗口可能已被用户关掉 → **正常路径** | 抽 `_swCloseCaptureWindow()`：`No window with id` 静默 / 其它原因 warn |
| 5 | `captureScreenshot` 完成出口：关闭截图窗口 | 同上（同一函数复用，消除重复实现） | 同上 |
| 6 | 右键菜单「添加到分组」：解析页面 URL | 能降级（跳过重复检查仍添加） | warn |
| 7 | 右键菜单「添加到分组」：遍历卡片时某张 URL 非法 | **有意跳过**（继续比对其它卡片） | `// best-effort` 注释 |

- **顺带的小重构（DEBT-03「改到就顺手拆」）**：右键菜单 `onClicked` 监听器里 60 行的匿名闭包抽成具名
  `addPageToGroupFromMenu(pageUrl, pageTitle, groupIndex, tabId)`，监听器只留参数解析。
  与 v1.5.15 的两次抽出一脉相承 —— **内联在监听器里的降级路径没法被点对点验证**。
- **顺带修掉一个 ESLint 警告**：原先 `var result` 在监听器里被声明两次（`no-redeclare`），
  抽出时把内层改名为 `dupResult` → 警告数 **35 → 34**（0 error 不变）。

### ✅ 测试（SW 侧代码用 CDP 直接挂到 Service Worker 上下文验证）
- `tests/e2e-sw-protocol.test.js` 新增 [DEBT-02] 段 **9 项**：通过 CDP `Target.attachToTarget`
  挂到 `background.js` 这个 SW target 上求值（页面上下文看不到 SW 内部函数），逐条断言：
  - MKCOL 根目录 / 子目录失败的诊断**真的被打印**，且 **PUT 失败照常上报给页面**（`ok:false`）；
  - 关闭截图窗口：`No window with id`（用户自己关掉）**不刷诊断**，其它错误**必须留痕**（两个方向都测）；
  - 右键添加：坏页面 URL → 留痕**且卡片仍然被添加**；组内坏卡片 URL → **静默跳过**且好卡片仍被识别为重复
    （用打桩的 `chrome.scripting.executeScript` 拿到「确实弹了确认框、参数里带重复组名」的证据）；
    正对照：没有重复时不弹确认框、也没有诊断。
  - 单条用例**错误隔离**（`swCase()`）：旧代码上缺函数时是「该条断言失败」，不是整个套件崩掉。
  - 刻意**不调** `Runtime.enable`(SW)：避免把 SW 的 console 事件并进「无 console error」门，改变既有门的语义。
- 验证：E2E **475 项**（p0 399 + SW 21 + WebDAV 55）｜ 逻辑桩测 29 ｜ 工程反向对照 52 ｜ ESLint 0 error / **34 warning**。
- 修复前 / 后对照（`DP_EXT_DIR` 指向 v1.5.15 源码）：SW 套件 **8 项失败**（缺 `_swWarnDegraded` /
  `_swCloseCaptureWindow` / `addPageToGroupFromMenu`，以及 MKCOL 无诊断）→ 新代码 0 项失败。
  （注：v1.5.16 发布时 CI 首跑红，原因是**测试挂载 SW 上下文的方式**在 CI 上不可靠，
  已在 **v1.5.17** 修复 —— 扩展运行时代码未变。）
- `audit-static-scan.mjs` **第 6 节（空 catch）已清零**，第 1、2 节保持为空。

## v1.5.15 (2026-10-04) — 技术债清理 ②：DEBT-02 静默吞异常（`src/js/` 20 处分级治理）

> 第二批技术债 = **DEBT-02「静默吞异常」**。审计口径是 28 处（空 `catch` / `.catch(function () {})`），
> 本批先做 `src/js/` 的 **20 处**，`background.js` 的 7 处留下一批（v1.5.16）。
> 治理口径**逐处判定**，不是无脑加日志 —— 四类处理：
> - **能降级 → 保留降级行为 + `console.warn`**（15 处）：失败不阻断主流程，但必须留下痕迹；
> - **能降级，但要区分「用户主动取消」**（2 处）：弹窗取消是正常选择，只有真错误才 warn；
> - **不能降级 → 补用户提示**（1 处）：favicon 开关打开后整条补图标链路失败，界面不能毫无反应；
> - **有意静默 → 加 `// best-effort` 说明**（2 处）：跳过坏 URL、`dataTransfer` 标记写入失败，静默是设计。
>
> ⚠️ **全部诊断一律走 `console.warn`，绝不改成 `console.error`** —— 三个 E2E 套件都断言
> `consoleErrors.length === 0`，把降级诊断写进 error 会让 CI 立刻变红（而它并不是代码缺陷）。
> 为此新增统一出口 `_warnDegraded(what, err)`，它也是本批断言「诊断真的被打印出来」的抓手。

### 🔇 DEBT-02 分级治理（`src/js/` 20 处）

| # | 位置 | 判定 | 处理 |
|:-:|------|------|------|
| 1 | `backup.js` 首次迁移：清理旧全量 ZIP | 能降级（旧 ZIP 残留无害） | warn |
| 2 | `backup.js` 增量备份：删除过期 config 快照 | 能降级（云端多留一个快照） | warn |
| 3 | `backup.js` 增量备份：删除云端孤儿图片 | 能降级（多占空间，不丢数据） | warn |
| 4 | `backup.js` 备份完成后的「导出本地备份」提示弹窗 | 用户取消是正常路径 | `CANCELLED` 静默 / 真错误 warn |
| 5 | `backup.js` 备份后清理旧 ZIP | 能降级 | warn |
| 6 | `backup.js` 删除云端版本后更新 manifest | 能降级（清单残留幽灵条目） | warn |
| 7 | `cards.js` 重复检查：列表里某张卡片 URL 非法 | **有意跳过**（继续比对其余卡片） | `// best-effort` 注释 |
| 8 | `cards.js` 重复检查：传入的 URL 自己解析不了 | 能降级（返回 `null` = 无重复） | warn |
| 9 | `cards.js` 新增卡片后补网站图标 | 能降级（装饰性数据，首字符兜底） | warn |
| 10 | `groups.js` 删组前的「后悔药」快照 | 能降级（删除照做，但恢复点会变旧） | warn（抽出 `_snapshotGroupsForUndo()`） |
| 11 | `groups.js` 分组拖拽的 `dataTransfer` 标记 | **有意静默**（排序用的是 `dragFrom` 变量） | `// best-effort` 注释 |
| 12 | `main.js` 首屏后补网站图标 | 能降级（装饰性数据） | warn（抽出 `_runAfterFirstPaintTasks()`） |
| 13 | `main.js` 自动备份后清理旧 ZIP | 能降级 | warn |
| 14 | `settings-webdav.js` 「恢复上一次改动」确认弹窗 | 用户取消是正常路径 | `CANCELLED` 静默 / 真错误 warn |
| 15 | `settings-webdav.js` 手动备份后清理旧 ZIP | 能降级 | warn |
| 16 | `settings.js` favicon 开关打开后补图标 | **不能降级**（用户刚打开开关，界面必须回应） | **Toast 提示** + warn |
| 17 | `storage.js` 落盘后刷新右键菜单 | 能降级（菜单晚点刷新） | warn |
| 18 | `wallpaper.js` 删除图片缓存 | 能降级（界面不受影响，但 Blob 会残留） | warn |
| 19 | `weather.js` 按城市名查经纬度 | 有兜底（缓存 / 默认坐标） | warn |
| 20 | `weather.js` 按 IP 定位城市 | 有兜底（默认「北京」） | warn |

- **顺带的小重构（DEBT-03「改到就顺手拆」）**：`init()` 里首屏后的内联回调抽成
  `_runAfterFirstPaintTasks()`，`doDeleteGroup()` 里内联的后悔药快照抽成 `_snapshotGroupsForUndo()`。
  两处都不改行为，只让「一个任务失败不影响其它任务」「快照失败不阻断删除」这两条降级路径
  **可以被单独触发**（内联写法没法在 E2E 里点对点验证）。

### ✅ 测试（DEBT-02：既证明降级仍可用，也证明诊断真的打印）
- `tests/e2e-p0.test.js` 新增 [32] 段 **35 项**，覆盖上表全部 20 处：
  - 每处都断言 **降级行为仍然正确**（例如：清理失败仍算备份成功且不进重试队列、删组快照失败仍把组删掉、
    地理编码失败仍回退默认坐标、`dataTransfer` 抛错仍继续拖拽、manifest 更新失败仍完成删除并提示「已删除」）；
  - 每处「该留痕」的都断言 **`console.warn` 真的被打印**（本段拦截 `console.warn` 收集诊断）；
  - 「有意静默」的两处反向断言 **不产生任何诊断**（避免以后被人顺手改成噪音）；
  - 用户取消弹窗的两处断言 **`CANCELLED` 静默 / 真错误 warn**（两个方向都测）。
- **视觉核对**（v1.4.0 教训：新增用户可见文案要单独核对）：本批唯一新增的用户可见 Toast
  「获取网站图标失败，继续用首字符」在真实 Chromium 里截图核对 —— 完整可见、未被裁切，
  且不遮挡 favicon 开关（`toastCoversSwitch: false`）。
- 验证：E2E **466 项**（p0 399 + SW 12 + WebDAV 55）｜ 逻辑桩测 29 ｜ 工程反向对照 52 ｜ ESLint 0 error / 35 warning。
- 修复前 / 后对照（`DP_EXT_DIR` 指向 v1.5.14 源码）：新增断言在旧代码上失败 **20 项**、新代码 0 项失败。
  失败的**全是「诊断 / 用户提示」类断言** —— 同一批里的「降级仍然可用」断言在旧代码上同样通过，
  正好证明本批只改了「失败是否可见」，没有改动降级行为本身。
- `audit-static-scan.mjs` 第 6 节（空 catch）里 `src/js/` 已清零，只剩 `background.js` 的 7 处（v1.5.16 处理）。

## v1.5.14 (2026-10-04) — 技术债清理 ①：DEBT-01 死函数（11 个「可被调用但无人调用」的函数下线）

> 本版开始清理 v1.5.5 全量审计遗留的**技术债**（不属缺陷，见审计报告 §5）。第一批 = **DEBT-01 死函数**。
> 审计报告给的是 v1.5.5 时点的 **13 个**，其中 `refreshCardFavicon` / `_clearAllBlobCaches` /
> `resetDashWorkingLayout` 已在 v1.5.12 接线，所以本批用 **AST 严格扫描**（真实引用 = 0，
> 注释与字符串不计入）重新推导清单，实际清理 **11 个**（审计的 10 个 + 连带失去唯一调用方的
> `getWebdavLastBackup`）。
> 这类改动的风险是「删掉之后才发现还有人在用」，因此断言分两层：**主链路行为断言**
> （渲染 / 卡片点击 / 拖拽 / 备份导出四条链路照常工作）+ **静态补充断言**
> （11 个名字连同注释一起从 `src/` 消失，因为静态扫描按文本计数，名字留在注释里下次就会漏掉）。

### 🧹 DEBT-01 死函数清理（11 个，全部直接删除）

这 11 个函数在「除声明处以外」的全仓库检索里零命中，但都在页面作用域内仍可被调用，
所以 ESLint 的未使用符号检查不会报警 —— 维护者会误以为这些能力还在，改动时容易在死代码上继续加逻辑。

| 函数 | 位置 | 判定 |
|------|------|------|
| `applyDashboardOrder(order)` | `dashboard.js` | v1.3.x `dashboardOrder` 数组的兼容入口，已被 `applyDashWidgetLayout` 取代（P2-3 迁移残留） |
| `getSpeeddials()` | `storage.js` | 存储层遗留（`getGroups()` + `getActiveGroup()` 早已取代） |
| `isCardSelected(id)` | `cards.js` | 多选辅助，实际代码直接用 `_selectedCardIds` 判断 |
| `openCard(index)` | `cards.js` | 卡片点击早已走事件委托（`main.js` 的 grid click 监听），旧入口残留 |
| `updateWebdavStatus()` | `backup.js` | 被 `settings-webdav.js` 的状态区取代 |
| `getWebdavLastBackup(cb)` | `webdav.js` | **连带清理**：只被 `updateWebdavStatus` 调用；备份时间在 `backup.js` / `main.js` 里直接读 storage |
| `getWebdavLastBackupFilename(cb)` | `webdav.js` | 遗留（写入侧 `setWebdavLastBackupFilename` 仍在用，保留） |
| `webdavListConfigs()` | `webdav.js` | WebDAV 版本列表旧 API |
| `webdavSilentPut(zipBlob)` | `webdav.js` | 静默备份链路（见下） |
| `webdavSilentPutIncremental(data)` | `webdav.js` | 静默备份链路（见下） |
| `withImgStore(mode, cb)` | `wallpaper.js` | IndexedDB 封装好但没有任何调用方 |

### ⚰️ 整条下线：静默备份链路（能力移除，不是接线）

审计报告要求「补 `beforeunload` 监听」或「整条删除并说明下线」二选一。核实后确认**这条链路从未工作过**，
因此选择删除而不是为一个从未生效的能力补入口：

- `webdavSilentPut` 的注释写「beforeunload 调用」，但全仓库**没有任何 `beforeunload` 监听**；
  且它发出的 payload **连 `body` 都没有**，SW 侧的空 body 守卫（BUG-032）会直接 `return { ok: true }`。
- `webdavSilentPutIncremental` 传了 `_config` / `_images`，但 SW 侧**从来没读过这两个字段**
  （只当普通 PUT 用，而它同样没有 body）→ 所谓「增量静默备份」从未实现。
- 本批删除：两个页面函数 + `WEBDAV_MSG.SILENT_PUT` 常量 + `background.js` 的 `webdav:silent-put` 分支。
  **若要恢复该能力**，正确做法是在 `visibilitychange` / `beforeunload` 里调用现成的
  `_incrementalBackup(data, true)`（自动备份与 WebDAV 手动备份都走它），而不是复活这条旧链路。
- 保留说明：SW 的 `webdav:config-list` 分支**未删**（页面封装 `webdavListConfigs` 已删，
  但 SW 侧 `CONFIG_LIST` 与 `IMG_LIST` 共用目录列举逻辑，删它会牵动 `webdavProxy` 的共享分支）。

### ✅ 测试（DEBT-01：删得掉，也要证明没删坏）
- `tests/e2e-p0.test.js` 新增 [31] 段 **8 项**：
  - **静态补充**：11 个名字连同注释从 `src/`（含 `index.html`）彻底消失；
  - **运行时**：页面作用域不再暴露这 11 个符号（原状态是「可被调用但无人调用」）；
  - **主链路行为**：① 渲染（`renderSpeeddials()` 后 DOM 卡片数 = 当前分组数据）；
    ② 卡片点击（真实点击 → 走事件委托开卡片 + 访问计数 +1，证明真实入口不是已删的 `openCard`）；
    ③ 拖拽排序（**真实 CDP 鼠标事件**走 `mousedown/mousemove/mouseup`，断言顺序改变**且已落盘**）；
    ④ 备份导出（`exportAll()` 仍产出可解压 zip，断言 `config.json` + `manifest.json` + 分组与卡片数）。
- `tests/e2e-sw-protocol.test.js` 新增 **2 项**：已下线的 `webdav:silent-put` **不再有任何响应值**
  （修复前 SW 回 `{ ok: true }`）+ 正对照「同族 `webdav:test` 仍被响应」。
- 探针 `_private/tools/audit-probes/rt05-rt06-missing-dom-ids.json`：P5 改为断言 11 个符号全部 `undefined`，
  并新增 P6 正对照（v1.5.12 接线的 `refreshCardFavicon` / `_clearAllBlobCaches` / `resetDashWorkingLayout` 必须仍在）。
- **安全网**：ESLint 的跨文件全局是**加载时扫描** `src/js/*.js` 收集的，漏改的引用会直接 `no-undef` error
  （本批实测 0 error / 35 warning，warning 数与改动前完全一致）。
- 验证：E2E **431 项**（p0 364 + SW 12 + WebDAV 55）｜ 逻辑桩测 29 ｜ 工程反向对照 52 ｜ ESLint 0 error。
- 修复前 / 后对照（`DP_EXT_DIR` 指向修复前的源码）：新增断言在旧代码上失败（3 项）、新代码全绿。
- `audit-static-scan.mjs` 第 1 节（疑似死符号）与第 2 节（ID 对齐）均为空。

## v1.5.13 (2026-10-04) — 审计清零：最后 8 条缺陷（权限闸门 / 资源回收 / 空断言 / 判定歧义）

> 本版是 v1.5.5 全量代码审计的**最后 8 条**：BUG-046 / 051 / 058 / 059 / 064 / 067 / 068 / 072。
> 至此该轮审计的 **42 条缺陷全部修完**（v1.5.6 ~ v1.5.13 八批）。
> 这批散在 8 个文件、互不相关，主题是「**测试看不见的那一半**」：一条空断言、三条资源回收、
> 两条「未授权 / 未配置」的判定歧义、两条一行修。
> 修复前 / 后对照（`DP_EXT_DIR` 指向修复前的源码）：**20 项断言失败 → 0 项失败**。

### 🐛 BUG-046 http 页面截图链路缺可选权限闸门（截图完全不可用，还要白等 2 分钟）
- **根因**：`manifest` 只把 `https://*/*` 列为必需权限，`http://*/*` 是**可选**权限。
  未授权时 `chrome.scripting.executeScript` 对 http 页面必然被拒，而编辑弹窗的
  「📸 截取网页」是**全项目唯一漏掉权限闸门**的截图入口（另一个入口与批量截图都有），
  SW 侧也没有权限判定，且 `injectButton` 的 catch 是空的 → 异常被完全吞掉：
  按钮永不出现、Promise 无任何分支能提前结束，只能等 120 秒定时器，最后报
  「用户超时未截图」——与真实原因无关。期间一个真实浏览器窗口被占用且无按钮可用。
- **修复**：三处一起补 —— ① 弹窗点击处理器最前面调用 `ensurePermissionForUrl(url)`
  （与卡片右键截图同一套闸门，未授权时给出权限提示）；② SW 侧 `captureScreenshot`
  开窗前用 `chrome.permissions.contains({origins:['http://*/*']})` 判定，未授权**直接拒绝、不开窗**；
  ③ `injectButton` 的失败回传 `rejectCapture(...)`，不再静默等 120 秒。

### 🐛 BUG-051 每次采样主题色 / 网页截图都泄漏一个 `blob:` URL
- **根因**：`_extractThemeColorFromBlob()` 用 `URL.createObjectURL(blob)` 给 `<img>` 赋值，
  但 onload / onerror 都只 `resolve`，整个函数体内没有任何 `revokeObjectURL`；
  blob URL store 会一直持有该 Blob 直到文档卸载（截图 PNG 可达数 MB）→ 长开的新标签页内存单调增长。
- **修复**：objectURL 提为局部变量并抽出 `finish(color)`，在 onload / onerror / 空采样三个出口统一释放
  （同仓 `wallpaper.js` 本就是「用完即 revoke」的写法）。

### 🐛 BUG-059 上传的自定义卡片图片永远不会被删除（图片库无限增长）
- **根因**：卡片编辑弹窗「上传图片」用的键前缀是 `card_<时间戳>_<随机>`，
  而删除逻辑按「卡片 id 拼 `cardimg_<id>`」定位、GC 又只扫描 `cardimg_` 前缀 ——
  两边都碰不到 `card_*`，于是这些 Blob 永久留在 IndexedDB（扩展声明了 `unlimitedStorage`，
  浏览器不会自动清理；用户上传的壁纸级大图会一直占空间）。
- **修复**：**不改前缀**（老数据里已有的 `card_*` 引用必须继续能用），改为
  **按卡片真实的 image 引用回收**：新增 `deleteCardImageRef(imageRef)`（受保护的壁纸键不删）
  与 `isWallpaperImageKey()` 闸门，删除路径统一走它；GC 的前缀过滤放宽为
  「**只要不被任何卡片引用、也不是壁纸键就回收**」（将来新增前缀自动覆盖）。
  同时补一道安全闸：一处分组都读不到时放弃本轮 GC —— 判定放宽后，
  若 storage 读取异常返回空数组就会把整个图片库清空。
  顺带删掉因本次修复失去最后调用方的 `deleteCardIcon()`（它只会按 id 拼 `cardimg_` 前缀）。

### 🐛 BUG-068 批量删除 / 去重清理不回收图标缓存；兜底的 `_clearAllBlobCaches()` 从无调用方
- **根因**：单张删除会清 `_cardBlobCache` 并删除 IndexedDB 图标，但批量删除、批量移动、
  重复检查弹窗的单行删除与一键清理都只 `splice/filter` 数据 → 被删卡片的 `blob:` URL
  及其整张图片 Blob 常驻内存直到页面关闭；唯一能整体兜底的 `_clearAllBlobCaches()`
  经全仓库 grep 只有定义、没有任何调用点。
- **修复**：新增 `_releaseCardImage(card)`（清 blob URL 缓存 + 按真实引用删 IndexedDB 实体），
  接入批量删除、去重单行删除、一键清理三条路径（**只回收被删项**，未删卡片的图片不受影响）；
  兜底的 `_clearAllBlobCaches()` 接进「重置全部数据」路径（整库即将删除，所有 `blob:` URL 都会失效）。

### 🐛 BUG-064 WebDAV 凭据回退分不清「未提供」与「空值」
- **根因**：SW 侧用 `!url || !user || !pass` 判断「是否传了凭据」，且把三个字段一起换成 storage 里的值。
  于是空密码（NAS 匿名/访客共享）恒被当成「未配置」——直接返回错误、一个请求都不发；
  而只提供部分字段时又会静默回退到 storage 里的**旧服务器**并返回「连接成功」（假阳性）。
- **修复**：区分「未提供」与「显式空值」—— 仅当 payload 上完全没有 `_url/_user/_pass`
  （也没有 `_hasCreds` 标记）时才回退 `storage.local`，任一字段显式提供就按提供值使用
  （**允许空密码**）；错误信息按缺失字段区分「缺少服务器地址 / 缺少用户名」；
  页面侧 `_wdSend` / `_wdSendFull` 统一打上 `_hasCreds` 标记。

### 🐛 BUG-072 城市留空（默认「自动检测」）时天气缓存永远失效
- **根因**：写入缓存时 `meta.city` 记的是 `settings.weatherCity || data.city`（探测到的城市名，如「北京」），
  校验时却拿 `settings.weatherCity`（默认空串）去比 → 恒不相等。
  于是文件头声明的「缓存机制，避免频繁请求触发 API 限制」对**最常见配置**完全失效：
  每开一个新标签页都发一次 Open-Meteo 请求并写一次 `storage.local`。
- **修复**：只在 `settings.weatherCity` 非空时才比对城市（留空 = 自动检测模式，只校验数据源与 TTL），
  写入与校验用同一语义。

### ♿ BUG-067 Bing 壁纸「区域」下拉框没有可访问名称
- **根因**：邻近文本是普通 `<div class="settings-section-title">🌍 区域</div>` 而非 `<label>`，
  下拉框也没有 `aria-label` → 屏幕阅读器只能读出「组合框 zh-CN」，用户无法判断控件用途
  （把 `id="setting-*"` 与 `for="setting-*"` 做差集，它是**全页面唯一**真正缺失关联的表单项）。
- **修复**：改成 `<label for="setting-bing-region" class="settings-section-title">🌍 区域</label>`，
  与同文件其它设置项写法一致。

### ✅ 测试（BUG-058：消灭最后两条空断言）
- `tests/e2e-p0.test.js` 里最后两条**空断言**被替换为**行为断言**：
  ① 「WebDAV 按钮已接入权限守卫」原先只判断两个全局函数的 `typeof`（把按钮 handler 整段删掉依然通过）
  → 改为**真实点击**「测试连接」：断言权限申请真的发起、未授权时不发任何 `webdav:*` 请求、且给出权限提示；
  ② 「批量截图已接入 http 权限降级」原先用 `startBatchCapture.toString().includes("httpTargets")`
  匹配源码文本 → 改为**真实调用 `startBatchCapture()`**：断言 http 目标一张都不截、进度弹窗不开、
  Toast 明说「跳过 N 张」。
- **断言非空转证明（变异测试）**：在**新代码**上人为删掉 WebDAV 按钮闸门与批量截图降级分支后，
  这 5 条断言 **5/5 失败**（旧版空断言在同样变异下依然全绿，正是 BUG-058 指出的问题）。
- **顺带修一处假对照**：`tests/e2e-sw-protocol.test.js` 原先**没有实现 `DP_EXT_DIR`**，
  用「修复前源码」跑它实际跑的还是新代码（假绿）；现已与 p0 / WebDAV 套件统一支持该开关，
  并给 `_private/tools/audit-probe.js` 也补上。
- 新增 E2E 断言 **39 项（净 +37：384 → 421）**：[10] 段 5 项（BUG-058 替换，同时删掉 2 条空断言）
  + [32] 段 27 项（BUG-046/051/059/064/067/068/072）+ SW 协议 3 项（http 截图未授权立即拒绝、不开窗）
  + WebDAV 4 项（BUG-064 真实服务器证据）。
- 修复前 / 后对照：旧代码 **20 项失败**（p0 14 + SW 3 + WebDAV 3）→ 新代码 **0 项失败**；
  探针 `rt03-uploaded-card-image-leak` 修复前 / 后翻转；`audit-static-scan.mjs` 第 2 节保持清零。
- 全量验证：E2E **421 项**（p0 356 + SW 10 + WebDAV 55）｜ 逻辑桩测 29 ｜ 工程反向对照 52 ｜ ESLint 0 error。

## v1.5.12 (2026-10-04) — 交互与死代码：6 条「界面承诺没兑现」缺陷 + 本地搜索下拉注入修复

> 本版是 v1.5.5 全量代码审计的**交互与死代码 6 条**（BUG-060 / 074 / 075 / 076 / 065 / 066）
> 加上剩余项里**唯一的安全问题** BUG-053（本地搜索下拉的 HTML 注入，修法与 v1.5.10 的 BUG-050 同源）。
> 这批的共同特征是「按钮 / 菜单 / 开关在界面上存在（或曾经存在），但背后的接线断了、
> 字段没人读、CSS 从不生效」。6 条死代码全部落在设置面板，一次视觉核对即可覆盖。
> 修复前 / 后对照（`DP_EXT_DIR` 指向修复前的源码）：**17 项断言失败 → 0 项失败**。

### 🐛 BUG-060 设置里的「↺ 重置看板布局」是个死按钮
- **根因**：按钮只有 HTML 与样式，全仓库没有任何 JS 绑定；`dashboard.js` 里现成的
  `resetDashWorkingLayout()` 也无调用方 → 用户点了没有任何反应，也没有提示，
  布局一旦改乱只能一项一项手动调回去。
- **修复**：新增 `resetDashboardWidgetLayout()`，默认值**只从 `DASHBOARD_WIDGETS` 注册表取**
  （顺序 = 注册顺序，宽度 = `defaultSpan`），因此以后新增看板组件这个按钮自动覆盖到它；
  点击后应用到 DOM、**立即落盘**（不等 300ms 防抖）、给出 Toast；锁定态拒绝重置
  （与「锁定禁用看板编辑」一致）。

### 🐛 BUG-074 搜索栏位置没有「一键恢复」，且 JS 里挂着一个永远不执行的死分支
- **根因**：`appearance.js` 给 `#btn-reset-search-pos` 绑了重置逻辑，但 `index.html` 里
  根本没有这个元素（实测 `getElementById` 返回 `null`）→ 死分支，与卡片大小 / 信息栏的体验不一致。
- **修复**：外观 → 高级选项 → 搜索栏补上「↺ 重置搜索栏位置」按钮；重置结果显式落盘
  （程序化赋值不触发 `change`，不落盘的话刷新后重置意图丢失，与 BUG-049 同款约定）；
  顺带修掉 `#setting-search-gap` 的 HTML 默认值 `24` 与数据默认值 `48` 不一致
  （面板懒初始化时读表单会拿到错值，属 BUG-048 同族隐患）。

### 🐛 BUG-075 `toggle-webdav-auto` 元素不存在，保存配置却每次写 `webdav_auto_backup=false`
- **根因**：v1.2.1 把「自动备份开关」改成 `backupMode` 下拉后元素被删，但
  `settings-webdav.js` 仍持有它的引用，并把它当作「未勾选」写盘；另有 4 个只定义、
  从不被读取的死设置字段（`presetSize` / `backupRemind` / `webdavAutoBackup` / `bingIdx`）。
- **修复**：删掉死引用与该键的写入；4 个死字段从 `DEFAULT_SETTINGS` 与导入范围规则中移除；
  新增 `DEAD_SETTINGS_KEYS`，在 `getSettings()` 里剔除老数据中的残留
  （只在内存里删，下一次整份回写自然从 storage 消失，不额外消耗 sync 写入配额）。

### ✨ BUG-076 卡片可以手动刷新网站图标；新加的卡片不再等到下次开新标签页才有图标
- **根因**：`refreshCardFavicon()` 写好了但**没有任何调用方**（注释说「右键/编辑弹窗可用」，
  两个入口都没接）；favicon 只在下一次打开新标签页的首屏 idle 回调里批量补。
- **修复**：卡片右键菜单新增「🔄 刷新网站图标」（锁定时隐藏；使用**自定义上传图**
  `idx:card_*` 的卡片不显示该入口，避免静默覆盖用户上传的图）；
  `enrichCardFavicons({ cardIds })` 支持只处理指定卡片 → `addSpeeddial()` 保存后
  立刻按 id 补一次图标并重渲染（开关关闭时不触发；不 await，不挡保存流程）。

### 🎨 BUG-065 设置面板的关闭动画是死 CSS（从未播放过）
- **根因**：`settings.css` 声明了 `opacity/transform` 过渡与 `.settings-panel.hidden` 的淡出终态，
  但 `base.css` 的 `.hidden { display: none !important }` 在 `display` 上必胜 → 元素直接离开渲染树，
  而 `display` 不可过渡；`base.css` 窄屏里那份重复规则同样死。
- **修复**：删除两处死 CSS 与那句永不生效的 `transition`；面板显示/隐藏统一由 `.hidden` 负责。

### 🎨 BUG-066 深色模式下三个危险操作按钮是刺眼的浅粉亮块
- **根因**：`.btn-reset-danger` 把浅色模式的 `#fce8e6` 底色写死在 `settings.css`，
  而 `base.css` 的深色适配只覆盖了**另一个类名** `.btn-reset-small`。
- **修复**：危险色抽成变量（`--danger-bg` / `--danger-bg-hover` / `--danger-border` / `--danger-fg`），
  深色主题给出明确取值（与 `.btn-reset-small` 的深色取值一致）；浅色取值逐字节不变。

### 🔒 BUG-053 本地卡片搜索下拉的卡片名未转义 → `innerHTML` HTML 注入
- **根因**：`renderLocalSearchDropdown()` 把卡片名（可来自导入的备份、任意网页 `<title>`）
  拼进 HTML 字符串后 `list.innerHTML = html`；同一行的 `groupName` 却走了 `escapeHtml`，
  属遗漏而非有意设计。MV3 的 CSP 挡住了内联脚本，因此是 HTML/CSS 注入（UI 伪装/钓鱼）而非脚本执行。
- **修复**：整个下拉改为 **DOM 构建** —— 名称用 `createTextNode`、高亮用真正的 `<mark>` 元素，
  标签不可能被解析；顺带删掉因此失去用处的 `escapeRegExp()`。
  关键词高亮行为不变（多关键词、大小写不敏感、重叠区间合并）。

### ✅ 测试
- 新增 E2E 段 **[30]** 共 **23 项**断言（p0 303 → **326**），并为审计条目 **BUG-058** 要求的三条
  已发布交互（R4 重置看板布局 / R6 WebDAV 自动备份字段 / R7 刷新网站图标）补上**行为断言**
  （原先只有存在性断言、0 覆盖）。
- 修复前 / 后对照：同一套断言跑在修复前源码上 → **17 项失败 → 0 项失败**。
- 视觉核对：CDP 截图设置面板「外观 / 数据 / 看板」三页（浅色 + 深色）与右键菜单，
  确认新增按钮不挤压、深色危险按钮配色正常。
- 全量验证：E2E **384 项**（p0 326 + SW 7 + WebDAV 51）｜ 逻辑桩测 29 ｜ 工程反向对照 52 ｜ ESLint 0 error。

## v1.5.11 (2026-10-04) — 竞态与体验：4 条「状态没复位 / 信息缺失」缺陷修复

> 本版是 v1.5.5 全量代码审计的**竞态与体验 4 条**：BUG-062 / 070 / 047 / 069。
> 它们的共同特征是「界面看起来没事，但状态已经错位」：异步任务读的是可变全局、
> 早退分支漏了状态复位、键盘语义只做了一半、12 小时制丢了午别。
> 修复前 / 后对照（`DP_EXT_DIR` 指向修复前的源码）：**9 项断言失败 → 0 项失败**。

### 🐛 BUG-062 批量截图期间切组：剩余截图被静默丢弃，结果还可能写进别的分组
- **根因**：截图循环每张间隔 2 秒，而它一直读**可变全局** `speeddials` 来查找目标卡片；
  `switchGroup()` 会把 `speeddials` 换成另一个分组的数组 → `find` 返回 undefined →
  截图结果被静默丢弃（既不计数也不提示）；收尾的 `groups[activeGroupIndex].cards = speeddials`
  在切组后指向的已是别的分组。切组入口（Alt+↑/↓）没有任何「批量任务进行中」的守卫。
- **实测（修复前）**：3 张卡片，截第 1 张后切组 → 只有 `[true,false,false]`，后两张**静默消失**。
- **修复**：开始时固定 `batchCards`（该分组的卡片数组）+ `startGroupIndex` 两个快照，
  结果只按 id 写回快照数组；卡片在截图期间被删除时计入 `skipCount` 并在 Toast 里说明；
  收尾不再按下标回写；用户切组时结果仍写回原分组，Toast 追加「（结果已写回原分组）」。

### 🐛 BUG-070 拖拽早退未复位 dragCard：`splice(-1)` 把分组最后一张卡片静默搬走
- **根因**：`onMouseDown` 先赋值 `dragCard`，发现 `data-id` 不在 `speeddials` 中时直接 `return`
  （对比其它分支都有清理）→ document 级 mousemove 照常建克隆、mouseup 带着 `dragOrigIndex = -1`
  一路走到 `doReorder(-1, to)` → `splice(-1, 1)` 取的是数组**最后一个**元素，再插到落点并落盘：
  被拖的卡片纹丝不动，当前分组的最后一张却被搬走。
- **实测（修复前）**：`doReorder(-1, 0)` 把 `r1,r2` 变成 `r2,r1` —— 顺序真的被改写了。
- **修复**：早退分支补 `dragCard = null; dragOrigIndex = -1;`；mouseup 入口再加一道负索引/越界兜底；
  `doReorder` 开头做边界校验（注意 `to` 允许等于 `length`，即「插到末尾」是合法取值，所以是 `>` 不是 `>=`）；
  `cleanupDrag()` 一并复位 `dragOrigIndex`。

### ♿ BUG-047 分组指示器圆点有 `role=button` / `tabindex=0`，但 Enter/Space 无法激活
- **根因**：`a11y.js` 给圆点补了按钮语义，但 `groups.js` 只绑了 `click`。`<div role="button">`
  不像真正的 `<button>` 那样把 Enter/Space 合成为 click —— 键盘用户能聚焦、能听到「按钮」，
  却按不动，属于「语义承诺了但行为没兑现」。
- **实测（修复前）**：聚焦第 2 个圆点按 Enter → `activeGroupIndex` 仍为 0。
- **修复**：`groups.js` 的圆点绑定抽出一个 `activate()`，同时挂 `click` 与 `keydown`
  （Enter / Space / Spacebar，`preventDefault()` 防止 Space 滚页）；E2E 另加一条「其它按键不切组」的对照断言。

### 🐛 BUG-069 12 小时制不显示午别：13:45 与 01:45 逐字节相同
- **根因**：12 小时分支只做 `% 12` 后输出 `hh:mm`，全仓库没有任何 AM/PM 承载元素 ——
  该选项实际只起到「隐藏 24 小时信息」的反效果，用户会读错差 12 小时的时间。
- **实测（修复前）**：13:45 与 01:45 都渲染成 `01:45`。
- **修复**：`index.html` 的时钟行新增 `<span class="clock-period">`，`clock.js` 按 12/24 小时制
  写入「上午/下午」或隐藏；`main.css` 补样式（次要信息，不抢主时间）。

### 🧪 回归覆盖（E2E 新增 18 项，`[29]` 段）
- **BUG-069**：用固定 `Date` 桩分别渲染 13:45 / 01:45 / 24 小时制，断言午别与取模结果（不依赖真实时刻）
- **BUG-047**：真实 `KeyboardEvent` 驱动 Enter / Space 切组 + 其它按键不切组的对照
- **BUG-070**：**正对照**（真实卡片拖拽确实换位，证明拖拽链路是活的）+ 幽灵卡片按下后立即复位、
  顺序不变、`doReorder` 拒绝负索引/越界索引、合法重排仍生效
- **BUG-062**：桩掉 SW 消息后启动批量截图，中途 `switchGroup(1)`，断言 3 张截图**全部**写回原分组、
  当前分组未被误写、也没被强行切回
- `e2e-p0.test.js` 也接入了 `DP_EXT_DIR` 探针开关，可与 WebDAV 套件同样做修复前/后对照

**验证**：E2E **361 项**（303 + 7 + 51）｜ 逻辑桩测 **29 项** ｜ 工程反向对照 **52 项** ｜ ESLint 0 error
**修复前 / 后对照**（同一套断言跑在修复前的源码上）：**9 项失败 → 0 项失败**

## v1.5.10 (2026-10-03) — 安全与备份：7 条「信任边界」缺陷修复（含真实 WebDAV 服务器联调）

> 本版是 v1.5.5 全量代码审计的**安全 3 条 + 备份与云端 4 条**：BUG-042 / 043 / 050 / 040 / 061 / 044 / 054。
> 它们的共同前提是「云端 manifest / 备份文件不可信」，因此本次专门补上了审计报告里被列为
> **未覆盖边界**的那一环 —— `tests/e2e-webdav.test.js` 会在测试进程内起一个**真实 WebDAV 服务器**，
> 不只断言「扩展发了什么请求」，还能断言「服务端最终留下了什么」。
> 修复前 / 后对照：同一套 51 项断言，**旧代码 22 项失败 → 新代码 0 项失败**。

### 🔒 BUG-042 WebDAV 文件名未净化：可越出备份目录对同源任意路径发 GET/DELETE（目录穿越）
- **根因**：`config/`、`img/` 子路径的文件名有两个**服务端可控**来源（manifest 的 `configs[].name`、
  PROPFIND 列表项），却直接拼进 URL：`baseUrl + '/config/' + '../../x'` 经 URL 归一化后越出备份目录，
  而 `CONFIG_DELETE` / `IMG_DELETE` 会真的发 DELETE。用户点「🗑️」删除某行时，删掉的可能是服务器上与本扩展无关的文件。
- **实测（修复前）**：测试服务器记录到 `DELETE /pwned.txt` —— 备份目录**之外**的哨兵文件被真删掉，
  且 `'..'` 这个文件名会把**备份目录本身**删掉；8 个恶意文件名全部返回「删除成功」。
- **修复**：SW 侧集中收口 `sanitizeRemoteName()`（仅 `[A-Za-z0-9._-]`、长度 ≤128、不得以 `.` 开头）
  + 纵深防御 `isWithinBase()`（净化后仍断言最终 URL 未越出 baseUrl）；页面侧 `isSafeRemoteName()` 提前拦截。
- ⚠️ 上限为什么是 128 而不是 64：图片 md5 是 64 字符，**旧格式的 `<md5>.bin` 是 68 字符** ——
  写成 64 会让孤儿 GC 静默删不掉历史图片文件（这个回归是本次 E2E 抓出来的）。

### 🔒 BUG-043 导入 / 云端恢复把 settings 原样写入 storage：一份备份即可劫持搜索与外链
- **根因**：全仓唯一的 URL 校验在搜索引擎 UI 里，导入路径完全绕过；`config.settings` 整体写盘，
  随后被直接消费（`wallpaperUrl` → 每个新标签页发一次请求、`weatherApiUrl` + `weatherApiKey` → key 被送到攻击者地址）。
- **修复**：新增 `normalizeImportedSettings()`，**ZIP 导入与 WebDAV 恢复共用**：
  ① 以 `DEFAULT_SETTINGS` 键集合做交集白名单（未知键丢弃，天然挡住 `__proto__` 原型污染）；
  ② 逐键类型/范围/枚举校验（枚举表与 `index.html` 的下拉选项一一对应）；
  ③ URL 类字段强制 https（`wallpaperUrl` / `weatherApiUrl`），`searchEngines[].url` 复用 UI 同款 `https + {q}` 规则；
  ④ 数组做元素级校验与数量上限；⑤ 导出时写入 `schemaVersion` 供将来迁移。
- ⚠️ 白名单必须包含 **`dashboardWidgetLayout` / `dashboardOrder`** 这两个「表单管不到」的键
  （它们不在 `DEFAULT_SETTINGS` 里，只按表单字段做白名单会把用户的看板布局吃掉 —— 即 v1.5.2/v1.5.5 同族事故）。
  E2E 专门有断言守住这一点。

### 🔒 BUG-050 云端 manifest 字段未转义直接拼进 innerHTML
- **根因**：版本列表的 config 分支（`backup.js`）对 `c.name` / `c.cardCount` 零转义，
  而同一函数的旧 ZIP 分支和 `settings-webdav.js` 都手工转义过 —— 属漏改。CSP 挡住内联脚本，
  但允许内联样式与外链图片：可整页覆盖做钓鱼；`c.name` 里的引号还会截断 `value=""` / `data-name=""`。
- **实测（修复前）**：恶意 manifest 渲染出 **3 个注入元素**（`<img>` + `<b>`）。
- **修复**：三处手工拼 HTML 合并为 `_renderVersionListHTML()`，用新的 `_escapeAttr()`
  （注意：`main.js` 的 `escapeHtml()` 走 `div.innerHTML`，**不转义引号**，不能用于属性值）
  + 接上 BUG-042 的文件名白名单：非法名那一行**不可选、不可删**，只留一行 `⚠️ 已忽略`。

### 🐛 BUG-040 图片上传失败被吞掉，但 manifest / 快照仍记录该 md5 → 云端永久缺图
- **根因**：上传循环 `catch` 只 `console.warn`，随后**无条件**把每张本地图片写进 `manifest.images` 与
  `configSnapshot.imageRefs`；下一轮备份按 manifest 里的 md5 判定「已在云端」而跳过重传 → 不可自愈。
- **修复**：维护 `failedMd5s`，manifest 与 `imageRefs` 都跳过失败项；存在失败项时返回 `false`
  （交给重试队列），并提示「N 张图片上传失败，下次备份会自动重试」。
- **实测**：修复前「上传失败仍返回 true 且 manifest 记录了它」→ 修复后返回 `false`、manifest 无记录，
  服务恢复后重跑**真的补传成功**（而不是永久跳过）。

### 🐛 BUG-061 孤儿 GC 的结果在上传之后才赋值 → 永不落云端，manifest 只增不减
- **根因**：`webdavPutManifest()` 在清理**之前**执行，之后算出的 `cleanedImages` 只改了内存，函数结束前没有第二次上传。
- **修复**：阶段 5 重排为「先算收缩后的 manifest（并剔除已淘汰 config 的 `refs`）→ 上传 → 再删文件」。
  顺序刻意选「先传清单再删文件」：中途失败只会留下多余文件（无害），不会出现「清单引用了已删文件」。

### 🐛 BUG-044 单分组导出把 `idx:` 前缀的键直接传给 IndexedDB → 导出的分组**从来**不含本地图片
- **根因**：全项目约定 IndexedDB 键不带前缀（写入 `saveImage(key)` 后置 `image='idx:'+key`，读取一律先剥前缀），
  只有 `_buildGroupExport` 没剥 → `store.get()` 必然 miss → `if (blob)` 静默跳过。
- **实测**：修复前导出的 `images` 是空对象 `[]`，导入方图片全丢且两侧都提示成功。
- **修复**：`loadImage(String(img).replace('idx:', ''))`，与 `cards.js` 保持一致。

### 🐛 BUG-054 含中文/emoji 的 WebDAV 密码：保存静默失败，界面毫无反馈
- **根因**：`btoa(webdavPassEl.value)` 在 `chrome.storage.local.set` 的**实参求值阶段**抛
  `InvalidCharacterError`，异常直接冒泡出 click 监听器：不落库、无 toast、无状态提示；
  读取侧 `atob` 无 try/catch 还会中断 `initWebdavSection` 的加载回调。
- **实测**：修复前 E2E 捕获到 `InvalidCharacterError: Failed to execute 'btoa'`，
  密码框回填出乱码 `å¯ç 123`，状态区为空字符串。
- **修复**：新增 UTF-8 安全的 `b64EncodeUtf8` / `b64DecodeUtf8`（页面与 SW 各一份，SW 侧用于构造 Basic 凭据）；
  保存分支补 try/catch + `chrome.runtime.lastError` 检查并显示失败原因；读取分支容错降级为空串。

### 🧪 新增真实 WebDAV 联调套件（`tests/e2e-webdav.test.js`，51 项）
- `tests/lib/webdav-test-server.js`：零依赖最小 WebDAV 服务器（OPTIONS/PROPFIND/MKCOL/PUT/GET/DELETE），
  支持请求日志与**故障注入**（指定 PUT 返回 507），根目录含「备份目录之外的哨兵文件」用于验证目录穿越。
- 断言覆盖：目录穿越（8 个恶意名 + 哨兵文件存活 + 服务端零越界 DELETE）、恶意 manifest 渲染（无注入元素 / 非法行禁用）、
  导入白名单（纯函数 + **真实 `_importConfig` 路径**）、分组导出图片往返（IndexedDB → dataURL → 重新落库）、
  上传失败不记 manifest 且能补传、GC 结果落回云端 + 陈旧文件被删 + `refs` 收缩、UTF-8 凭据端到端 + 中文密码保存/回填。
- 探针支持：`DP_EXT_DIR=<目录>` 可让整套断言跑在另一份扩展源码上，用于「修复前 / 后对比」。

**验证**：E2E **343 项**（286 + 7 + 51）｜ 逻辑桩测 **29 项** ｜ 工程反向对照 **52 项** ｜ ESLint 0 error
**修复前 / 后对照**（同一套断言，`DP_EXT_DIR` 指向 `git HEAD` 的旧源码）：**22 项失败 → 0 项失败**

## v1.5.9 (2026-10-03) — CI 可信度：E2E 门禁不再把「崩溃」当「环境缺失」

> 本版是 v1.5.5 全量代码审计里**最该先修的两条工程缺陷**：BUG-041（AUD-001）与 BUG-073（AUD-036）。
> 它们不改变任何用户可见功能，但决定「CI 变红能不能被相信」—— 在此之前，页面/SW 真坏掉、
> 测试自身抛错、浏览器没装上，三种情况都会让 E2E 门禁**静默变绿**。
> 两条都补了**反向对照**断言（修复前 / 后已实测翻转），避免规则日后被悄悄放宽。

### 🐛 BUG-041 E2E 退出码 2 被 CI 映射为成功：任何未捕获异常都让门禁静默变绿
- **根因**：退出码 `2` 承担了两种互斥语义 —— (a) 环境不满足（无浏览器 / 扩展加载不了 / init 超时）；
  (b) 两个 E2E 脚本顶层 async IIFE 的**唯一全局 `.catch`**。而 `ci.yml` 只读数字：`2 → exit 0` 并打印「跳过」。
  于是「测试自己抛错」与「页面/SW 真的坏掉导致 eval 抛错」全部等价于成功。
- **典型假绿路径**：SW 消息处理器缺失 → `chrome.runtime.sendMessage` 回调收到 `undefined` →
  `JSON.stringify(undefined)` 让 `evalJs` 返回 `undefined` → `r1.includes(...)` 抛 TypeError →
  全局 catch → `exit 2` → CI 判「环境不满足」并 `exit 0`，**SW 6/6 全绿，但一条协议断言都没真跑**。
- **修复**：
  - 退出码语义彻底分开：`0` 通过 ｜ `1` **断言失败或测试崩溃**（CI 必须红）｜ `3` 显式环境不满足（跳过）。
    三处环境跳过改用 `EXIT_ENV_SKIP = 3`，全局 `.catch` 改为 `exit 1` 并打印「测试崩溃（非环境问题）」。
  - `ci.yml`：只有 `3` 允许放行且必须打 `::warning::`；删除 Chromium 安装步骤的 `continue-on-error: true`；
    `BIN` 为空时由「打印一行跳过 + exit 0」改为 `::error::` + `exit 1` —— **没跑 E2E 就是红色**。
  - SW 协议断言先做**类型断言**（`evalJsStr`）：SW 无响应时是「6 条断言失败」，而不是一个看不出所以然的崩溃。
  - 刷新路径补上被丢弃的 `waitForReady()` 返回值（原先页面没就绪 → `JSON.parse(undefined)` → 崩溃 → 假绿）。

### 🐛 BUG-073 唯一的全局报错门被关键词黑名单掏空
- **根因**：v1.5.0 为让 CI（runner 常访问不到外网）不因天气/壁纸网络失败变红，加了一条正则黑名单，
  却把**通用浏览器网络错误**（`net::ERR` / `Failed to fetch` / `NetworkError`）与业务词（`天气` / `Bing 壁纸`）
  和外部服务名混在同一条里，作用于整个套件唯一的全局报错门（`consoleErrors.length === 0`）。
  任何 fetch 型代码回归产生的 `console.error` 都被整条丢弃；而所谓的「自测」只注入了一条
  **应被忽略**的样本并断言它被忽略 —— 没有任何反向对照，等于把过宽的过滤规则固化成了必须存在的行为。
- **修复**：过滤规则收窄为**两条必须同时成立**才忽略：
  ① 日志前缀来自已登记的外部服务代码路径（`src/` 里只有 `weather.js` 的 `Open-Meteo error:` / `Weather error:`）；
  ② 失败类型是网络/传输层失败（`fetch failed` / `net::ERR_*` / 超时 …）。
  于是「天气模块里的代码 bug」（`TypeError` 等）不再被来源关键词连带吞掉，
  `storage.js` 的 `local_bak save failed` 这类内部错误永远计入失败。
  被忽略的条目单独计数打印（`ℹ️ 已忽略 N 条…`），不静默。顺带修掉 SW 套件里「收集了 console error 却从不检查」的死门。

### 🧪 反向对照（新增 49 项断言，全部不依赖浏览器）
- **`tests/lib/console-error-filter.js`**：两个 E2E 共用的来源精确过滤器（判定逻辑从测试里抽出来，可单测）
- **`tests/console-error-filter.test.js`（22 项）**：双向断言 —— 10 条「必须计入」（含
  `Open-Meteo error: TypeError: …` 这种**带来源关键词的代码 bug**、裸 `Failed to fetch`、内部错误 + 网络字样）
  + 6 条「可忽略」+ 收集器分流与报告
- **`tests/e2e-exit-code.test.js`（20 项）**：spawn 两个 E2E 脚本做反向对照 —— 浏览器缺失 → `3`；
  注入崩溃（`DP_E2E_SELFTEST=crash`）→ `1` 且**日志不得出现「跳过」**；并静态断言「不再使用退出码 2」
- **E2E 内新增 3 项**：过滤规则双向自测（注入 1 条应忽略 + 1 条**旧黑名单会吞掉**的代码 bug，断言它被计入）
  + 刷新后页面重新就绪

**验证**：E2E **286 项** ｜ 逻辑桩测 **29 项** ｜ 工程反向对照 **42 项** ｜ SW 协议 **7 项** ｜ ESLint 0 error
**修复前 / 后实测**：SW 无响应注入 → 旧 `exit 2`（CI 映射为绿，6 条断言未真跑）→ 新 `exit 1` + 6 条失败逐条列名；
`Open-Meteo error: TypeError: boom` → 旧「吞掉」→ 新「计入」；CI 步骤桩测 `0/1/3/无浏览器` → `0/1/0+warning/1+error`

## v1.5.8 (2026-10-03) — v1.5.5 审计第二批（续）：4 条竞态与交互缺陷修复

> 本版是 v1.5.5 全量代码审计第二批的收尾 4 条：BUG-045 / 057 / 063 / 071。
> 其中 BUG-045 与 BUG-055（v1.5.7）是跨标签页同步的同一条链路，BUG-063 / 071 是 ESC 链的两处缺口。
> 照例先跑探针留「修复前」证据，修完对比，并把断言补进 E2E（新增 16 项）。

### 🐛 BUG-045 跨标签页删组后本页索引越界 → 看板空白，且后续新增卡片会写错分组
- **根因**：`activeGroup` 与 `groups` 是两个独立 sync 键，删组方只在自己页内夹紧索引并写回
  `activeGroup`；接收方 `onChanged` 只消费 `changes.groups`，既不夹紧索引也不按 id 跟随 ——
  本页长期持有「指向已不存在分组」的索引：`speeddials` 被置空（看板空白、圆点无选中），
  此后本页新增卡片时 `saveSpeeddials()` 按 storage 里的索引写盘，会把**别的分组的卡片整组覆盖**。
- **修复**：合并外部 `groups` 时先按 **id 跟随**原分组，找不到再夹紧索引；索引真的变了就
  一并 `saveActiveGroup()`，保证「本页显示的组」与「写盘用的索引」一致。
- **说明**：未采用「跨标签页同步当前分组」—— 每个标签页保留自己的视图，`activeGroup` 仍只用于新标签页初始定位。

### 🐛 BUG-057 newtab 壁纸轮播序号按「重刷次数」递增，而不是按新标签页
- **根因**：`_pickLocalWallpaperIndex()` 在 `newtab` 分支里无条件「读序号 → +1 → 写回」，
  而它的唯一调用者 `applyLocalWallpapers()` 有 4 条调用路径：新标签页、改任意设置
  （`onSettingChanged` 会无条件重刷壁纸）、拖单张遮罩滑块、增删壁纸。于是壁纸会莫名其妙跳到下一张 ——
  最糟的是拖第 3 张的遮罩滑块，松手后画面直接切到另一张，**所见与所改错位**。
- **修复**：给 `_pickLocalWallpaperIndex` / `applyLocalWallpapers` / `applyWallpaper` 加 `advance` 参数，
  只有 `initWallpaper()`（新标签页路径）传 `true`；重刷路径只读序号、不推进。顺带对越界序号取模兜底。

### 🐛 BUG-063 ESC 关不掉「重复卡片检查」弹窗，反而误关它底下的设置面板
- **根因**：ESC 链逐项枚举了各弹窗，但漏了 `#dialog-duplicate-check`（该弹窗由设置面板内的按钮打开，
  两者是兄弟节点且弹窗 z-index 更高）。按 ESC 会命中「设置面板」那一层把它关掉并 return，弹窗原地不动。
- **修复**：在链中补一层（紧随「重复卡片确认弹窗」之后）。
- **未纳入**：`#dialog-backup-progress`（批量截图 / 云端备份进度）同样不在链中，但它需要真正的
  「取消任务」语义 —— 单纯隐藏进度弹窗会让用户以为任务已停止，留待后续单独处理。

### 🐛 BUG-071 设置面板的 ESC 守卫因监听器注册顺序失效：关子弹窗会连面板一起关
- **根因**：`settings.js` 里另有一个 `document` keydown 监听器做「子弹窗打开时不关面板」的守卫，
  但它在**首次打开面板时**才注册，必然晚于 `main.js` 的 ESC 链；等它执行时子弹窗已被 `main.js`
  关掉（`hidden`），守卫全部落空 → 面板被一起关掉，守卫形同死代码。
- **修复**：删掉这个重复监听器，统一由 `main.js` 的 ESC 链按层处理（命中子弹窗即 return，天然不会误关面板）。

### 🧪 回归覆盖（E2E 新增 16 项）
- **BUG-045**：同页确定性复现（本页停在末组 → 注入「另一个标签页」删组后的 groups）断言索引校正、
  看板非空、圆点有选中；另加**真实双标签页**场景（B 停在末组，A 删组后 B 的视图仍合法）
- **BUG-057**：断言重刷路径不推进序号、`initWallpaper()` 推进一次；[17] 段原有断言同步改为
  「新标签页路径 `advance=true` 才逐次递增」并补一条「重刷只读」
- **BUG-063**：造出重复卡片 → 打开重复检查弹窗 → ESC 断言「弹窗被关 + 面板保留」→ 再按一次才关面板
- **BUG-071**：面板内打开分组管理器 → ESC 断言「只关管理器 + 面板保留」→ 再按一次才关面板
- 探针（`_private/tools/audit-probes/`）新增 4 个用例：`aud007-cross-tab-activegroup-index`、
  `aud022-wallpaper-rotate-advance`、`aud026-esc-duplicate-check`、`aud034-esc-guard-order`

**验证**：E2E **283 项** ｜ 逻辑桩测 **29 项** ｜ SW 协议 **6 项** ｜ ESLint 0 error ｜ 探针修复前 / 后对比全翻转

## v1.5.7 (2026-10-03) — v1.5.5 审计第二批：5 条同族缺陷修复

> 本版是 v1.5.5 全量代码审计的**第二批 5 条**：BUG-048 / 049 / 052 / 055 / 056（均为 medium），
> 全部落在第一批刚动过的三条链路上 ——「表单 ↔ 数据边界」「DOM 池失效」「跨标签页回声判定」。
> 同样先跑探针留「修复前」证据，修完对比，并把行为断言补进 E2E（新增 20 项）。

### 🐛 BUG-055 跨标签页：另一个标签页的 groups 改动在 1.5s 内被整段忽略，随后被本页陈旧数据回滚
- **根因**：`isSelfSyncWrite(key)` 只按「key + 1.5s 时间窗」判定 onChanged 回声，不比对值。
  本页任意一次 groups 写入（点卡片计数、切分组、favicon 批量）都会让窗口内**另一个标签页的真实改动**
  被整段丢弃；本页内存仍是旧数组，下一次写入是**整份数组覆盖**，于是把对方的改动推回 sync 回滚掉
  （B 新增的卡片消失、B 删除的卡片复活）。
- **修复**：回声判定改为**按值**（`isSelfSyncValue` + 键序无关的稳定序列化），删除只按时间戳的
  `isSelfSyncWrite`；外部改动合并后除当前分组外整体失效 DOM 池，避免切组看到改动前的陈旧卡片。
- **说明**：与 v1.5.6 修的 BUG-037（settings 键）是同一族根因，这次把 groups 键也统一到按值判定。

### 🐛 BUG-048 窗口 resize 会把已保存的卡片列数改回默认 5
- **根因**：`updateGridColumns()` 在不传参时回退去读 `#setting-columns-slider`。设置面板是
  **懒初始化**的（首次打开才回填），未打开过面板时该滑块只有 HTML 默认值 `5`；resize 处理器
  正是无参调用 → 宽屏下网格按 5 列重算，用户保存的列数（2/3/4/6/7/8）在本次会话中被静默忽略
  （实测 `columns=3` 时 resize 后网格宽度 842px → 1128px）。
- **修复**：回退源改为设置数据（`currentSettings.columns`），与卡片宽度早已改读 CSS 变量保持一致。

### 🐛 BUG-049 两个「↺ 重置」按钮只改 DOM：不落盘，且卡片高度重置无效
- **根因**：重置处理器只写 `slider.value` / 文本 / CSS 变量 —— 程序化赋值**不触发 change**，
  而外观落盘的唯一入口就是 change 事件（关闭面板也不保存）→ 刷新后重置意图全部丢失。
  另外高度滑块在 input 时给每张卡片写了**内联 height**，内联优先级高于
  `height: var(--card-height)`，重置只改 CSS 变量 → 高度看起来"重置无效"。
- **修复**：两个重置按钮显式落盘（`onChanged()`，与「↺ 重置看板大小」一致）；
  重置尺寸时清掉 `.speeddial-card` 的内联 height。
- **顺带修掉**：信息栏重置原本给 `<input type="color">` 赋 `''`，浏览器会回落成 `#000000`，
  一旦落盘就变成「自定义黑色」→ 改为赋主题默认色（`collectAppearanceForm` 会把它映射回「未自定义」）。

### 🐛 BUG-052 右键「移动到分组」后，切到目标分组看不到刚移入的卡片
- **根因**：移动后只调 `renderSpeeddials()`，而它只重建**当前**分组的容器；目标分组若已在
  DOM 池里（分组数 ≤3 或最近访问过），切过去命中的是移动前的旧 DOM —— 卡片在源分组与目标分组
  **界面上同时消失**（数据其实已落盘），用户会以为卡片丢了并可能重复添加。
- **修复**：新增 `_invalidateGroupContainer(index)`，移动成功后失效目标分组的容器。

### 🐛 BUG-056 待办组件「先关后开」后完全失效（列表空白、所有交互无反应）
- **根因**：`initTodo()` 只在启动时按 `showTodo !== false` 调用一次，渲染与全部事件监听器都在里面；
  之后重新打开组件只走 `applyComponentVisibility()` 的 `display` 切换 → 组件显示出来但列表空白、
  回车/＋/🧹/勾选/删除全部无反应，只能刷新页面恢复。同一「仅启动时 init」模式也存在于
  clock / lunar / weather（本次未动，见下）。
- **修复**：组件注册表新增 `init` 钩子，`applyComponentVisibility()` 在组件由「隐藏」变「可见」时补调；
  `initTodo()` 改为幂等（重复调用只重渲染，不重复绑定监听器）。
- **未纳入本版**：clock / lunar / weather 的 init 目前**不是幂等**的（会重复注册定时器），
  注册钩子前需先给它们各自加守卫，留待后续批次。

### 🧪 回归覆盖（E2E 新增 20 项，`tests/e2e-p0.test.js` [27] 段）
- **BUG-055**：同页确定性复现（本页写入后立刻注入「另一个标签页」的 groups 改动）断言收到且不回滚；
  另加**真实三标签页**场景，断言 B 页新增的卡片进入 A 页内存、且 A 页回写后仍留在 sync
- **BUG-048**：改列数为 3 → 刷新（断言面板仍未初始化、滑块仍是 HTML 默认值 5）→ 派发 resize →
  断言网格宽度不变、内存列数仍是 3
- **BUG-049**：真实控件事件改尺寸/配色 → 点两个重置按钮 → 断言落盘为 270/270、`bgColor` 清空、
  字号 13、卡片内联 height 已清掉
- **BUG-052**：先访问目标分组让容器进池 → 回源分组走 `handleMoveToGroup` → 切到目标分组断言能看到
  刚移入的卡片、源分组已不含它
- **BUG-056**：真实刷新路径（showTodo=false 启动 → 面板重新勾选）断言组件被初始化、回车可添加并渲染、
  且 `initTodo()` 重复调用不重复绑定（添加一条只 +1）
- 探针（`_private/tools/audit-probes/`）新增 4 个用例：`aud020-groups-echo-cross-tab`、
  `aud012-reset-appearance`、`aud015-move-to-group-container`、`aud021-todo-reenable`（复用 `aud011-resize-columns`）

**验证**：E2E **267 项** ｜ 逻辑桩测 **29 项** ｜ SW 协议 **6 项** ｜ ESLint 0 error ｜ 探针修复前 / 后对比全翻转

## v1.5.6 (2026-10-03) — v1.5.5 全量审计第一批：5 条高危缺陷修复

> 本版是 v1.5.5 全量代码审计（42 条缺陷 + 4 条技术债）的**第一批 5 条**：BUG-035 ~ BUG-039，
> 全部属于用户可感知的**静默丢数据 / 功能失效**。审计基线是绿的（ESLint 0 error ｜ 逻辑 29 ｜ E2E 217+6），
> 说明这批缺陷**既有测试抓不到** —— 因此每条都先用真实 Chromium 探针留了「修复前」证据，
> 修完再跑对比，并把行为断言补进 E2E（新增 30 项）。

### 🐛 BUG-035 分组管理器会删错分组（不可预期的数据丢失）
- **根因**：点某行的 ✕ 时先调了一次 `renderGroupManagerList()`，而真正的 `splice` 发生在用户点确认之后
  （`doDeleteGroup`）。删除完成后**没有任何一次列表重渲染** —— 管理器仍显示刚被删掉的那一行，
  其后每一行的 `data-index` 都比实际分组小 1 → 再点某行的 ✕，删掉的是**另一个分组**。
- **修复**：把 `renderGroupManagerList()` 从「点删除按钮时」移到 `doDeleteGroup()` 真正删完之后。
- **顺带修掉**：活动分组改为**按 id 跟随**（与分组拖拽排序一致）。原先删掉活动组**之前**的某个分组时，
  只做「越界夹紧」，用户会莫名其妙被切到另一个分组。

### 🐛 BUG-036 sync 写入被配额拒绝后静默丢数据
- **根因**：`_writeSyncKey` 无论 `chrome.runtime.lastError` 是否存在都 `resolve()`，调用方无法区分成败；
  唯一的兜底 `_verifyGroupsWrite` 判定条件是「sync 里**有没有**这个键」—— 配额拒绝时旧值原样留着（非空），
  于是 `local` 兜底永远不触发。结果：增删卡片/分组、拖拽排序在界面上全部「成功」但不落盘，
  刷新后回到超限前的旧版本，且**全程没有任何用户可见提示**（仅 console.warn）。
  约 68 张常规卡片即可永久触发（单键 8192 字节上限）。
- **修复**：`_writeSyncKey` 回传「本次写入是否成功」；失败时**无条件**写 `local.groups` +
  写入版本号 `groups_rev` + 弹出一次用户可见提示；`getGroups()` / 导出（`_collectAllData`）
  改为按版本号取新，而不是「sync 非空就信 sync」。
- **一致性**：导入（ZIP / 旧 JSON）、WebDAV 恢复、「恢复上一次改动」、SW 右键新增卡片等
  所有直接写 `groups` 的路径同步带上版本号，避免陈旧的 sync 副本把新的 local 兜底数据反超。
- **顺带**：`groups_rev` 是内部标记，不写进导出 / 云端备份。

### 🐛 BUG-037 多标签页互相覆盖设置（last-write-wins 丢更新）
- **根因**：`settings` 在 sync 里是**单个键**，`saveSettings()` 每次写整份内存对象；而 `onChanged`
  只把 `isLocked` 同步回内存。于是「任何一次设置变更」都会用打开页面时的陈旧副本整体覆盖云端设置：
  A 页调了列数 → B 页改任意一个无关设置 → A 页的改动消失。
- **修复**：`onChanged` 的 `settings` 分支把 `newValue` 合并进 `currentSettings` 并重渲染
  （设置面板开着时同步回填表单），本页自己的写入不重复处理。
- **实测发现（重要）**：`chrome.storage.onChanged` 会**先于** `set` 的回调触发，且读回的对象
  **键序被重排**（字母序）→ 原有的「按时间戳判回声」会把自己的写入当成外部变更。
  改为按**值**判定（`isSelfSyncValue` + 键序无关的稳定序列化）。

### 🐛 BUG-038 删组 / 拖拽重排后切组会显示**别的分组（甚至已删除分组）的卡片**
- **根因**：DOM 池（v1.2.4 引入）按**数组下标**缓存分组容器，而删组 / 重排会让所有下标整体平移，
  命中判定又只看「容器存在且有子节点」→ 切到该下标时直接显示上一个分组的 DOM。
  卡片 id 在数据模型里已不存在，编辑 / 删除 / 点击行为全部对不上。
- **修复**：容器缓存改用**分组 id** 作键 + `data-group-id` 归属校验（对不上就丢弃重建）；
  新增统一的失效接口 `_invalidateGroupDOMCache()`，删组 / 重排后整体失效；拖拽模块改用 `_activeGroupContainer()`。
- **说明**：仅在 ≥3 个分组（把缓存填满）时暴露，原 E2E 只跑单 / 双分组，所以全绿也没拦住。

### 🐛 BUG-039 时钟 / 农历设置静默回退
- **根因**：`clockFormat` / `clockShowSeconds` / `lunarStyle` 只被 `collectSettingsFromForm()` **收集**，
  `populateSettingsForm()` 从不**回填** → 控件永远停在 HTML 默认值（24h / 勾选 / double）。
  于是刷新后改动任意一项设置，就会把用户保存的偏好写回默认值并落盘，面板显示值与实际生效值还不一致。
- **修复**：补三行回填；并把外观区（卡片尺寸 / 圆角 / 透明度 / 列数 / 配色）抽成 `populateAppearanceForm()`，
  让设置面板**每次打开都以数据为准**回填 —— 否则它同样会停留在首次打开时的值，之后任意保存都会写回数据。

### 🐛 连带修复（由 E2E 既有断言抓出）
- 跨标签页设置变更会走 `applyAllSettings()` → `applyWallpaperOpacity()`，把用户给**单张壁纸**设的
  独立遮罩改回全局值。已按 v1.5.0「单张遮罩优先」规则修复（`getEffectiveWallpaperOpacity`）。

### 🧪 回归覆盖（E2E 新增 30 项，`tests/e2e-p0.test.js` [22]~[26] 段）
- **BUG-035**：4 分组场景下按真实 UI 路径连删两次，断言列表刷新、行索引与数据一一对应、删的正是行上显示的那组
- **BUG-038**：三组填满 DOM 池后删组 / 重排，断言可见卡片是**该分组自己的**；容器数量 ≤ LRU 上限，
  且没有已删除分组的残留容器
- **BUG-036**：构造**真实**超过 `QUOTA_BYTES_PER_ITEM` 的写入（非桩），断言 sync 确实拒绝、
  local 有兜底数据 + 版本号、`getGroups()` 读回最新数据、有用户可见提示；再断言数据缩回配额内后
  sync 重新成为权威
- **BUG-037**：**真实打开第二个标签页**，断言 B 页内存跟随 A 页改动、且 B 页改无关设置后 A 页改动未被回滚
- **BUG-039**：按用户复现路径（12h / 关秒 / 单行农历 → 刷新 → 改无关开关）断言内存与落盘都不回退；
  另加「表单回填 ⊇ 表单收集」不变式 —— 把全部表单控件改成脏值后回填，逐键比对收集结果与数据必须一致
- 探针（`_private/tools/audit-probes/`）新增 3 个用例：`aud005-sync-quota-fallback`、
  `rt01-settings-echo`、`rt01-wallpaper-opacity-invariant`；修复 `audit-probe-multitab.js` 的
  `require('path')` 缺失与扩展 ID 探测恒真问题

**验证**：E2E **247 项** ｜ 逻辑桩测 **29 项** ｜ SW 协议 **6 项** ｜ ESLint 0 error ｜ 探针全绿（修复前 / 后对比见 `_private/Bug.md`）

## v1.5.5 (2026-10-02) — 设置变更不再清空表单管不到的数据

### 🐛 修复（用户复现：调好看板宽度 → 取消显示待办 → 刷新后宽度回到初始值）
- **根因**：`onSettingChanged()` / `onAppearanceChanged()` 用「表单收集结果」**整体替换**了设置对象
  （`currentSettings = collectSettingsFromForm()`）。表单只覆盖它自己包含的字段，于是**凡是表单管不到的数据，
  在任何一次设置变更时都会被静默清空**——不止看板宽度：
  - `dashboardWidgetLayout`（看板组件宽度/顺序）→ 表现为「改好的宽度一刷新就回默认」
  - `todoItems`（待办内容）、`localWallpapers`（本地壁纸列表）→ 数据直接丢失
  - `columns`（卡片列数）、`isLocked`（锁定状态）、`bgColor` / `cardWidth` / `cardFontSize` 等外观自定义
  - 共 **20 个字段**（对照 `DEFAULT_SETTINGS` 逐一核对）
- **修复**：两处都改为**合并**（`Object.assign({}, currentSettings, collectSettingsFromForm())`）——
  表单只覆盖它包含的字段，其余数据原样保留
- **连带修复**：`setLocked()` 在「来自 storage.onChanged 的同步」时也会回写设置，导致每次设置变更都多一次
  「回声写盘」（实测 12 次连发改列数会落盘 2 次，拖滑块时更容易撞上 sync 写入配额）→ silent 模式不再回写

### 🧪 回归覆盖（新增 9 项）
- 按用户复现路径：调宽度 → 取消显示待办 → 断言布局/待办内容/本地壁纸/列数/锁定字段全部保留
- 再刷新页面，断言自定义宽度、DOM 宽度、隐藏状态、待办内容与列数逐项保持
- P1-6 写入合并断言改为先 flush 再计数（消除测试自身竞态）
- E2E 217 项 ｜ 逻辑桩测 29 ｜ SW 链路 6 ｜ ESLint 0 error


## v1.5.4 (2026-10-02) — 分组名显示规则读取修复

### 🐛 修复（用户反馈：分组名显示规则被限定成「仅当前组」，改了保存不了）
- 根因：`renderGroupDots()` 读的不是设置数据，而是**设置面板里的下拉框**（`#setting-group-name-mode` 的 `value`）。
  设置面板从 v1.3.3 起是懒初始化的（只有打开面板才会用设置数据回填表单），所以**每次打开新标签页时下拉框都还是 HTML 默认值，也就是第一个选项「仅当前组」** —— 于是：
  - 指示器永远只显示当前组名（看起来"被限定"了）
  - 用户在面板里改成「显示所有组名」后当场生效，但**一刷新又变回仅当前组**（看起来"保存不了"）
- 修复：显示规则改为从 `currentSettings.showGroupName` 读取（数据是唯一事实来源），并对历史脏值做白名单兜底（非 `all/active/off` 一律按 `all`）
- 顺带排查了同类隐患：全仓库仅 `settings.js` 使用表单引用集合，其余直接读表单控件的地方都是「实时预览」或「表单↔数据同步」，方向正确，无需改动

### 🧪 回归覆盖（新增 7 项）
- 三种规则（全部 / 仅当前组 / 不显示）**在不打开设置面板的情况下**刷新页面后逐一断言指示器渲染
- 断言设置值原样保存、面板回填正确、面板切换即时生效并落盘
- E2E 208 项 ｜ 逻辑桩测 29 ｜ SW 链路 6 ｜ ESLint 0 error


## v1.5.3 (2026-10-02) — 组件居中与字号策略修复

### 🐛 修复（用户反馈）
- **组件变窄时文字跟着变小**：v1.5.2 为适配窄尺寸给 1~2 列加了字号缩放（时钟 `clamp(16px,1.6vw,26px)`、日期/城市 11~12px 等），实际用起来不希望字号变化 → **撤销全部按宽度缩放字号的规则，字号恒定**。组件高度本来就是 `auto`，内容会自动换行并把卡片撑高，不会溢出到相邻组件
- **组件全部靠左**：12 列宽度模型原先用 CSS Grid 实现 —— 12 条轨道会占满整行，当跨列合计小于 12 时剩余轨道留在右侧，视觉上就是「全部靠左」；缩小组件（v1.5.2 才刚能缩）后特别明显。现改为 **flex + `justify-content: center`**，宽度公式 `(100% - 11*gap)/12*n + (n-1)*gap`（与原先 grid 跨列等价）：合计 < 12 时整行居中，= 12 时铺满一行
- **`_saveLayout` 保存即应用到 DOM**：原先只更新工作副本并等防抖落盘，调用方若忘记调用 `applyDashWidgetLayout` 就会出现「数据已改、界面没变」（这也是本次排查中发现的隐患）

### 🧪 回归覆盖
- 新增断言：缩到 1 列字号不变、列宽变化不影响字号、跨列合计 < 12 时整行居中（左右留白近似相等）、合计 = 12 时铺满、垂直排列上下堆叠且等宽
- E2E 201 项 ｜ 逻辑桩测 29 ｜ SW 链路 6 ｜ ESLint 0 error


## v1.5.2 (2026-10-02) — 布局字段冲突与宽度调节修复

### 🐛 修复（用户反馈）
- **设置 → 看板 → 布局方向下拉框空白**：根因是 **P2 引入的存储键冲突** —— 组件布局（`{clock:{order,span}}` 对象）被写进了 `settings.dashboardLayout`，而该字段原本是「布局方向」（`row`/`column` 字符串）。下拉框拿到对象自然匹配不到选项而空白；更严重的是**每次保存设置都会把布局对象覆盖成空串，用户的组件布局被静默重置**。现改用独立键 `dashboardWidgetLayout`，并在启动时自愈迁移（旧对象 → 新键 + 方向字段纠正为 `'row'`），同时兼容更老的 `dashboardOrder` 数组写法
- **天气 / 农历点「−」无法缩小**，两个原因：
  1. 最小跨列限制过紧（天气最小 3、农历默认就等于最小 2）→ 点 − 毫无反应。现在四个组件 `minSpan` 统一为 **1**，12 列栅格下由用户自己决定多窄；并补了窄跨列排版适配：1 列时自动隐藏次要信息（日期 / 秒 / 城市 / 农历年份），不再溢出卡片
  2. **待办组件的 − / ◀▶ 完全没反应**（真 bug）：组件内部为避免点击冒泡到卡片区做了 `stopPropagation`，把编辑态控件的点击一并拦掉了 —— 这也解释了为什么"只有待办缩不动"。现让编辑态控件（`.dash-arrow` / `.dash-span-btn`）继续冒泡
- 到达宽度上下限时**抖动一下**给出反馈，不再看起来像按钮失效

## v1.5.1 (2026-10-02) — 版式与多选修复

### 🐛 修复（用户反馈 + E2E 深挖）
- **分组管理器**：去掉上移/下移按钮（保留 ⠿ 拖拽排序），拖拽手柄改为可聚焦、支持 ↑↓ 键盘排序（去掉按钮后仍保留无障碍路径）；分组图标输入框 34px → 56px 并给出输入框外观（原先 emoji 被裁切、看不出可编辑）
- **看板横向排列被强制换行**：容器原为 `min(1100px, 90vw)` 有固定像素上限，且窄屏用「列数减半」（6 列）而组件跨列合计 12 → 必然折行成 2+2。改为 `94vw` 铺满可用宽度；窄屏（≤560px）直接单列堆叠，不再出现「既不是横向也不规整」的折行
- **输入框光标闪烁像给相邻卡片蒙了层遮罩**：组件聚焦时 `backdrop-filter` 会随光标反复重绘 → 加 `.dashboard-item:focus-within` 关掉毛玻璃并改用更实底色；同时给组件加独立合成层（`translateZ(0)`）避免重绘外溢
- **壁纸版权条压住搜索栏/卡片**：看板铺满后底部左右两角都被占 → 移到右上角（搜索栏之下、卡片之上），长版权文字省略号截断

### ☑️ 多选批量操作（P3-1）三处真实缺陷
> 都只在「DOM 池同时保留多个分组容器」时暴露，E2E 深挖时定位到
- 选中样式（`.selected`）会打到隐藏分组里的同名卡片上 → 只标记当前分组的容器
- `Ctrl+A` / `Shift` 区间选中会把隐藏分组的卡片一起算进来（工具栏计数虚高、批量删除对部分卡片无效）→ `_displayedCardIds` 限定当前分组
- 后台重渲染（storage.onChanged / 外部变更）会丢掉选中样式，数据里还选中但界面看不到 → 渲染完成后重新应用选中态
- 附带：切换分组时清空多选（选中是针对某个分组的，跨组保留会误导）


## v1.5.0 (2026-10-02) — 卡片多选 / 分组增强 / 待办组件 / 搜索建议 / 多图壁纸 / favicon

### 🌐 可选 favicon（离线缓存 + 首字符兜底）（P3-8）
- 设置 → 外观 → 视觉 新增「使用网站图标 favicon」开关（**默认关闭**）
- 只对**没有自定义图**的卡片生效：取站点自身的 `/favicon.ico`（**不经过第三方图标服务**），经 Service Worker 代理下载后存 IndexedDB，离线也能显示
- 取不到就标记 `faviconFailed`，**不再反复重试**（避免每次开新标签页都打一堆请求），渲染仍然走首字符色块兜底
- 并发 3 张、首屏之后执行；打开开关时立即为缺图卡片补一轮并提示结果
- 附带修一处一致性问题：设置面板此前只在首次打开时回填表单，其它入口（导入/快捷键/分组管理器）改过设置后面板会显示陈旧值 → 改为每次打开都以数据为准回填

### 🖼️ 本地多图壁纸 + 轮播 + 单张遮罩（P3-7）
- 壁纸标签页新增「本地壁纸轮播」列表：可**一次多选添加**多张本地图片（IndexedDB 存储），带缩略图、单张删除
- **轮播方式**三选一：不轮播（固定第一张）/ 每次新标签页换一张 / 按时间间隔自动切换（5–240 分钟，按时间片计算，多标签页一致且到点自动换）
- **单张独立遮罩**：每张壁纸可单独设遮罩（0–100%），未设置则「跟随全局」；全局遮罩滑块仍然有效
- 打开自定义模式时优先使用本地壁纸列表，列表为空才回退到旧的「单图 URL / 单文件」逻辑（老数据不受影响）
- 修一个自己引入的 bug：`setBackgroundImage` 在图片 `onload` 里用全局遮罩重设 CSS 变量，会把单张遮罩冲掉 → 增加 `opacityOverride` 参数，onload 用同一个值

### 🔍 搜索建议（浏览历史 / 书签）（P3-5）
- 新增 `js/suggest.js`：搜索框输入时给出建议，**书签优先**、按「标题开头匹配 > 标题包含 > URL 匹配 + 访问次数」排序、按 URL 去重、最多 8 条
- **权限按需申请**：`history` / `bookmarks` 加入 `optional_permissions`（必需权限里没有它们）；仅在用户打开设置 → 功能 → 「搜索建议」开关时弹出一次授权请求，拒绝则开关自动回滚并提示，其它功能不受影响
- 交互：↑↓ 选择、Enter 打开（复用全局卡片打开方式）、ESC 收起；与 `>` 本地卡片搜索各自独立下拉、互不干扰
- 默认关闭；查询 180ms 防抖，输入变化后会校验输入框内容是否仍是当次查询，避免旧结果覆盖新输入

### ✅ 待办清单看板组件（P3-4）
- 看板新增「待办」组件：回车快速添加、勾选完成（划线）、hover 删除、🧹 一键清理已完成、`1/4` 进度计数
- 数据存 `settings.todoItems`（`chrome.storage.sync`，走 v1.3.3 的合并写）；上限 50 条、单条 80 字
- 设置 → 看板 → 组件开关新增「待办清单」；列表变化会触发看板碰撞重算（避免变高后压住卡片）
- **同时验证了 P2 的组件注册表抽象**：新增一个看板组件只改了 ① HTML 一个卡片 ② 注册表登记一行 ③ 新增 `js/todo.js` + 一处 init 调用；`applyComponentVisibility` 也顺手改成注册表驱动（不再硬编码 clock/weather/lunar 三个 ID，这正是 v1.3.0「改了 ID 忘同步」那类 bug 的根源）
- 默认跨列调整为 3/4/3/2，4 个组件默认正好铺满 12 列；栅格改底部对齐，待办变长不会把时钟/天气拉高

### 🎨 分组颜色 / 图标 / 拖拽排序（P3-3）
- 分组管理器每行新增：**颜色选择器**（圆形色块）、**图标输入**（emoji，最多 2 字）、**拖拽手柄 ⠿**
- **拖拽排序**：拖手柄到目标行即可调整分组顺序（`moveGroupTo` 按位置移动而非交换）；活动分组按 id 跟随，不会因索引变化错位；原有的 ▲▼ 按钮保留（键盘/无障碍路径）
- 指示器同步渲染分组颜色与图标：圆点/标签使用 `--group-color`，当前项带同色描边；分组名可显示为 `🏠 常用`
- 弹窗加宽到 520px 容纳新增控件

### ☑️ 卡片多选批量操作（P3-1）
- **Ctrl/⌘ + 单击**切换选中、**Shift + 单击**区间选中、**Ctrl/⌘ + A** 全选当前分组、**ESC** 清空
- 选中卡片显示蓝色描边 + ✓ 角标；顶部出现毛玻璃工具栏：`已选 N 张` + 移动到… / 删除 / 取消选择
- **批量移动**：工具栏弹出分组菜单，一次性把选中卡片移到目标分组
- **批量删除**：复用与单张删除一致的确认弹窗（标题「🗑️ 批量删除」）
- 细节：Ctrl/Shift 点击不会打开卡片；普通点击先清空选中再按原逻辑打开；点击卡片区空白清空选中；界面锁定时批量操作被拦截；选中态只切 DOM class，不触发重渲染


## v1.4.0 (2026-10-02) — 看板重做

### 🧩 12 列栅格布局（替代自由坐标）
- 看板改为 **12 列 CSS Grid**，每个组件占 `grid-column: span N` —— 宽度由跨列数决定，天然响应式（窄屏自动降为 6 列）
- 放弃「自由 x/y 拖拽 + 磁吸」方案：v1.3.0 已两次失败（自研 Grid → GridStack.js），自由坐标与响应式/沉浸模式/碰撞检测天然冲突
- **顺序物理重排 DOM** 而非 CSS `order`：后者会让 DOM 顺序与视觉顺序不一致，屏幕阅读器与 Tab 键会按 DOM 顺序走，与所见不符（无障碍反模式）

### 📋 组件注册表
- 新增 `DASHBOARD_WIDGETS` 注册表（id / 名称 / 元素 id / 默认与最小跨列数），布局、开关、编辑态控件全部由注册表驱动
- 编辑态控件（◀ ▶ 换位、− ＋ 调宽度）改由注册表动态生成，HTML 里不再重复三份箭头标记 —— 从根上消除 v1.3.0「HTML 改了 ID 忘了同步」那类 bug
- 新增组件只需：HTML 加一个 `data-widget="<id>"` 的卡片 + 注册表登记一行

### 🖱️ 编辑态交互
- **拖拽换位**：编辑态按住组件拖动，松手按落点最近的组件互换顺序（5px 阈值防误触，丢太远视为取消）
- **−/＋ 调宽度**：跨列数 1~12 钳制，受每组件 `minSpan` 下限保护
- 编辑态视觉：虚线框 + 抓取光标；「完成」按钮移到顶部居中（原来在底部会压住卡片）；编辑态隐藏壁纸版权条（底部右侧会压住看板）；底部留出按钮空间避免压住文字

### 🔄 数据迁移与兼容
- 新布局模型 `settings.dashboardLayout = { <widget>: { order, span } }`；读取时若只有旧版 `dashboardOrder` 数组 → 下标即顺序、宽度取默认值
- 写入时**同时写一份 `dashboardOrder` 数组**，旧版本回退仍可读
- 旧「水平位置 / 垂直位置 / 组件宽度」三个滑块下线（宽度改由跨列控制，位置由网格与碰撞检测决定）；已存的老值仍会应用，不影响现有用户的观感

### 🎨 毛玻璃卡片
- 看板组件改为毛玻璃风格：`backdrop-filter: blur(12px) saturate(1.2)` + 半透明底 + 细边框 + 阴影，深浅色主题各自配色，与快捷卡片视觉统一

### 🐛 分组管理器布局修复
- 底部按钮不再被挤成两行：「➕ 新建 / 📥 导入分组 / 取消 / 完成」此前在 420px 弹窗里被压缩到文字换行（P1-9 新增「导入分组」后出现）→ 按钮加 `white-space: nowrap` + `flex-shrink: 0`，操作行允许整体换行而不是挤压文字；弹窗加宽到 480px
- 分组行的操作按钮（📤 ▲ ▼ ✕）不再贴住名称输入框：`.group-mgr-actions` 设 `flex-shrink: 0`、间距 4→6px，输入框加 `min-width: 0`
- 对齐调整：底部按钮改为**居中**（原先右对齐，左侧留白 50px、右侧 13px，视觉失衡）；分组名输入框加 `max-width: 200px` 不再撑满整行，操作按钮 `margin-left: auto` 始终贴右
- E2E 新增 6 项 UI 回归断言（弹窗宽度 / 按钮单行且未被压缩 / 底部按钮居中且左右留白差 ≤8px / 输入框 ≤220px / 行内按钮尺寸），防止后续调整时复发

### 🐛 过程中修掉的 3 个真 bug（E2E 抓出）
- **连续点击跨列按钮不累积**：`getDashboardLayout()` 读的是 `currentSettings`，而它只在 300ms 防抖落盘时才更新，防抖窗口内的连续操作都基于同一份陈旧基准互相覆盖 → 引入内存「工作副本」
- **改动永远不落盘**：`_flushLayout` 把工作副本的**同一个对象引用**赋给 `currentSettings.dashboardLayout`，「顺序未变化」的判断变成自己跟自己比、永远相等 → 改为落盘快照比对
- **`applyDashboardLayout` 命名冲突**：settings.js 已有同名函数（应用 CSS 变量），dashboard.js 的新函数会覆盖它 → 新函数改名 `applyDashWidgetLayout`


## v1.3.3 (2026-10-02) — 首屏与交互优化

### ⚡ 首屏
- **设置面板改为首次打开才初始化**：启动路径只保留「渲染卡片必需」的工作（读设置 + 应用主题/列数/可见性/外观尺寸变量），表单回填与面板事件绑定推迟到首次点开面板，首屏省下约 60 个表单元素读写与数十个监听器
- **卡片宽度改从 CSS 变量读取**：`updateGridColumns` 原先从设置面板的滑块取值，面板延迟初始化后会读到 HTML 默认值导致卡片尺寸错乱 —— 改为读 `--card-width`，消除这处隐藏耦合
- **非关键启动任务移到首屏之后**（`requestIdleCallback` + 200ms 兜底）：图标迁移、IndexedDB 图片 GC、壁纸加载
- **图标迁移移出关键路径（实测收益）**：`migrateCardIcons` 原先 `await` 在首次渲染前，会逐张发网络请求。实测 20 张指向不可达地址的遗留图片卡片：**旧行为 10 秒内完全不渲染卡片，新行为 83ms 出卡片**
- 全部 18 个脚本加 `defer`，与 HTML 解析并行下载（保持执行顺序）
- 新增 `performance.mark('dp-init-start')` / `dp-cards-rendered`，便于后续回归对比

> 实测说明：本机 headless Chromium 下首屏 JS 执行仅 4ms、静态 DOM 仅 637 个节点，脚本层可优化空间有限（首卡出现中位数 ~80ms，改动前后在噪声范围内）；本版实际收益集中在「设置面板初始化」与「遗留数据不再阻塞渲染」两处。

### 🔐 权限收窄与运行时授权
- **`host_permissions` 从 `<all_urls>` 收窄为 `https://*/*`**，http 站点改为 `optional_host_permissions` —— 默认不再申请全量明文 HTTP 访问（此前是 CWS 审核与 MITM 风险点）
- **按需申请**：仅当用到 http 地址时才弹窗请求（本地 NAS 的 WebDAV、http 页面截图）。接入点：WebDAV 测试连接 / 立即备份 / 版本列表 / 恢复、单卡截图、批量截图
- **降级而非报错**：拒绝授权时不中断流程 —— 提示原因并跳过 http 目标（批量截图会告知跳过几张），https 功能完全不受影响
- 隐私政策同步说明两类权限的用途差异

> ⚠️ 用户可见变化：使用 http WebDAV（如本地 NAS）时首次操作会弹出一次权限请求。

### 📦 单分组导出 / 导入
- 分组管理器每行新增「📤 导出此分组」，底部新增「📥 导入分组」
- 导出格式：`{ type:'deeppage-group', version:1, group:{name, cards}, images:{...} }`，本地图片以 dataURL 内联，接收方可拿到完整分组（含图片）
- 导入为**新增分组**（不动现有数据），重名自动加 ` (2)` 序号；卡片 id 与图片键重新生成，图片写回 IndexedDB
- 脏数据容错：非 DeepPage 分组文件直接拒绝；缺 url 的卡片跳过
- 修两个自己踩的坑：① 用 `fetch(dataURL)` 解码内联图片会被扩展 CSP 的 `connect-src` 拦截（异常被吞、图片静默丢失）→ 改手动 base64 解码；② `idx:` 引用必须是 `idx:cardimg_<id>`（cards.js 用 `replace('idx:','')` 取值），写成 `idx:<id>` 会导致图片永远加载不出来

### ☁️ WebDAV 备份增强
- **配置快照完整性校验**：备份时把配置快照的 sha256 记入 manifest，恢复时比对；不匹配（云端文件损坏/被截断）直接中止并提示，不再静默导入坏数据；旧备份无 sha256 时自动跳过校验
- **「仅配置」备份模式**：WebDAV 区新增「备份包含图片」开关（`backupIncludeImages`，默认开）。关闭后只上传配置快照、跳过图片上传，省流量与时间；恢复该版本时会提示不含图片
- **失败重试队列**：云端备份失败不再静默丢弃 —— 写入 `chrome.storage.local` 队列（记录 attempts/reason/nextAt），在**恢复联网**与**下次启动**时按退避重试（2min → 10min → 30min），成功即清空队列；累计 4 次仍失败则停止并提示手动备份

### ♿ 无障碍（ARIA）
- **弹窗语义**：11 个弹窗容器补 `role="dialog"` + `aria-modal="true"` + `aria-labelledby`（指向各自标题，标题缺 id 的补上）
- **搜索框**：`role="searchbox"` + `aria-label`；本地卡片搜索下拉 `role="listbox"`，结果项 `role="option"`，并同步 `aria-expanded` / `aria-activedescendant`
- **设置面板**：`role="dialog"` + `aria-label`；tab 补 `role="tablist"/"tab"/"tabpanel"` 与 `aria-selected` 同步
- **焦点管理（新增 `js/a11y.js`）**：弹窗打开时焦点移入、关闭后归还给打开前的元素。实现上监听 overlay 的 `hidden` 类变化即可，无需改动各 open/close 函数；归还目标通过 `focusin` 历史回溯 —— 各 `open*` 是「先移除 hidden 再同步 focus 输入框」，MutationObserver 是微任务，回调时读 `activeElement` 会记错目标（实测踩到过）
- **纯图标按钮**：自动用 `title` 补 `aria-label`（动态生成的卡片编辑/删除按钮在模板里显式标注）
- **Toast**：容器为 `role="status" aria-live="polite"`，屏幕阅读器可播报
- **分组指示器**：动态圆点补 `role="button"` + `aria-label` + `aria-current`

### 🔄 存储写入合并
- **新增写入合并层**：`chrome.storage.sync` 有 `MAX_WRITE_OPERATIONS_PER_MINUTE = 120` 的硬配额，超限时写入会**静默失败**（原先 `saveToStorage` 直接吞掉 `lastError`）。现在对「高频且可重建」的数据做合并写：同一 key 在 500ms 窗口内只写最后一次（理论上限 120 次/分钟，正好卡在配额内），并在写入失败时打印告警
- **接入高频路径**：滚轮连续切分组（`saveGroups(..., { coalesce: true })` + `saveActiveGroup`）、连点卡片的访问计数、设置变更（滑块/开关/引擎切换）
- **结构性数据仍立即写**：增删改卡片、分组增删等用户数据不走合并，避免关页/崩溃丢数据（E2E 有专门断言）
- **落盘兜底**：`pagehide`、切后台（`visibilitychange`）、导出/导入/重置前都会 `flushSyncWrites()`；导入与重置是「先落盘再覆盖」，避免合并写晚到把导入的数据盖回去
- **onChanged 回声判定**：合并写可能在本页写入后 ≤500ms 才落地，新增 `isSelfSyncWrite()` 判定，避免自触发一次多余渲染

---

## v1.3.2 (2026-10-02) — 开发工具链与代码清理

### 🛠️ 工程
- **ESLint 护栏**：新增 `eslint.config.mjs`（ESLint 10 flat config）。针对本项目「16 个经典脚本共享全局作用域」的架构，跨文件符号由配置加载时扫描 `src/js/*.js` 顶层声明自动收集，新增模块无需手工登记；只拦运行时问题（未定义变量、重复声明、变量遮蔽、误用 `==`、不可达代码），不争论格式
- **npm scripts**：`npm run lint` / `npm test` / `npm run test:e2e` / `npm run verify`
- **版本号单一来源**：新增 `tools/bump-version.mjs`，一条命令同步 `manifest.json` + `package.json` + README 徽章 + CHANGELOG 日期；`--check` 供 CI 校验一致性，`--check --strict` 供发版流程卡住「待发布」状态
- **CI**：新增 `.github/workflows/ci.yml`（push/PR 跑 版本一致性 + ESLint + 看板逻辑测试 + 真实浏览器 E2E）；release 流程升级为 `actions/checkout@v7` / `actions/setup-node@v7` / `softprops/action-gh-release@v3`，发布前增加 `npm ci` + lint + 测试门禁
- **测试脚本入库**：零依赖验证脚本迁到公开仓库 `tests/`（逻辑桩测 + headless Chromium E2E），支持 `CHROME_BIN` 指定浏览器，无浏览器时优雅跳过
- **E2E 稳定性与 CI 适配**：扩展 ID 改为从浏览器 CDP target 发现（不再依赖目录路径哈希推导）；随机调试端口 + 每次独立 profile；按进程组回收浏览器（Chromium 会把真正进程孤儿化，只杀启动壳会残留实例污染下一轮）；轮询等待页面 init 与 storage 落盘，去掉固定 sleep。CI 侧改用 Chrome for Testing（Chromium）—— `--load-extension` 已被 Chrome 137+ 官方 branded 构建移除；退出码约定 `0` 通过 / `1` 断言失败 / `2` 环境不满足（CI 跳过而非误报）

### 🧹 代码清理（ESLint 首轮发现）
- `search-engines.js`：本地搜索结果打开逻辑中 `var mode` 重复声明，收敛为单次声明（与 BUG-024 同类的作用域隐患）
- `weather.js`：`weatherMeta` / `coords` 同函数内重复声明，改为复用已有绑定
- `groups.js`：删除 `deleteGroup` 中已无用途的 `var cards`；分组指示器渲染的 `cls` 收敛为单次声明
- `lunar.js`：删除 `getLunarDate` 中未使用的 `year/month/day`；`initLunar` 内部 `now` 遮蔽改名 `nowTs`
- `cards.js`：`gi == activeGroupIndex`（字符串键与数字索引比较）加注释说明为有意为之，避免误改

---

## v1.3.1 (2026-10-02) — 稳定性补丁

### 🧩 看板编辑态
- **ESC 退出编辑态**：此前进入「✋ 编辑组件顺序」后按 ESC 无反应，现接入统一 ESC 链（第 11 层）直接退出
- **锁定后无法编辑看板**：「✋ 编辑组件顺序」按钮在界面锁定时置灰禁用；若锁定前正处于编辑态，锁定会强制退出
- **连点箭头不再狂写云端**：顺序保存改为 300ms 防抖 + 顺序未变化不写盘 + 已在最左/最右时点击不写盘；退出编辑态立即落盘。原实现每点一次箭头就全量写一次 `chrome.storage.sync`，连点容易触发同步写入配额限制
- **箭头改为事件委托**：绑定在 `#dashboard-grid` 上，后续版本动态增删看板组件无需重新绑定

### 🔒 安全
- **SW 代理协议白名单**：新增 `isProxyUrlAllowed()`，Service Worker 代理只放行 `http:` / `https:`，阻断 `file:` / `chrome:` / `chrome-extension:` / `data:` / `javascript:` / `blob:` 等协议；覆盖天气代理、图片代理、WebDAV 代理、网页截图窗口
- 说明：`host_permissions` 保持 `<all_urls>` 不变 —— 网页截图（`scripting`）、图片代理、本地 http WebDAV 都依赖 CORS 绕过能力，收窄权限需配合 `optional_host_permissions` + 运行时授权，留待后续版本

### 🛠️ 工程
- **CI 版本一致性校验**：打 tag 时校验 `manifest.json` 的 `version` 与 tag 是否一致、`manifest_version` 是否为 3，不一致直接失败（此前只检查文件存在，打错 tag 会静默发出错版本包）
- **CI 语法自检**：发布前对全部 JS 执行 `node --check`，语法错误不进发布包

---

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
- **修复看板组件开关无效**：v1.3.0 HTML 看板组件 ID 从 `dashboard-*` 改为 `dash-*`，`applyComponentVisibility` 仍查找旧 ID → `getElementById` 返回 null → 时钟/天气/农历开关不生效。同步 3 处 ID。
- **修复分组指示器尺寸滑块丢失**：v1.2.9 "外观标签页精简" 误删指示器边距 + 圆点大小 + 标签字号 3 个 `<input>` 元素，JS 逻辑完好但 `getElementById` 返回 null 导致功能静默失效。补回 v1.1.4 原始 HTML（`setting-group-offset` / `setting-group-dot-size` / `setting-group-tab-size`），根据位置自动切换显隐。

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