<p align="center">
  <img src="src/assets/icons/icon-128.png" width="96" alt="DeepPage Logo">
</p>

<h1 align="center">DeepPage</h1>

<p align="center">
  <strong>基于 FVD Speed Dial 风格的模块化、可定制的极简高效起始页</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Manifest-V3-blue?logo=googlechrome" alt="Manifest V3">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/Version-1.0.5-brightgreen" alt="Version">
  <img src="https://img.shields.io/badge/PRs-Welcome-orange" alt="PRs Welcome">
</p>

---

## ✨ 功能特性

### 🔍 多引擎搜索
- 置顶居中搜索框，点击图标切换搜索引擎
- 默认支持 **Google / 百度 / Bing / 搜狗 / Yandex** + 自定义引擎
- 快捷键 `/` 聚焦搜索、回车跳转

### 🧩 FVD 风格快捷导航
- 大方块卡片网格布局（CSS Grid）
- 自动抓取网站 Favicon，失败时生成纯色文字兜底卡片
- 拖拽排序（纯鼠标事件）、右键菜单、中键新标签页打开
- 列数/宽高/圆角滑块实时预览，自由调整布局

### 📊 多功能信息看板
- **数字时钟**：12/24 小时制 + 秒数开关
- **农历信息**：纯 JS 实现，1900-2100 范围 + 生肖 Emoji
- **天气预报**：支持 4 种 API（Open-Meteo / 和风 / OpenWeatherMap / 自定义）

### 🎨 视觉与外观
- 浅色 / 深色 / 跟随系统 三种主题模式
- Bing 每日壁纸（8 张缓存 + UHD 4K + 多区域 + 自动切换）
- 自定义壁纸 URL / 本地上传
- 外观配色 ColorPicker + 实时 CSS 变量预览

### 📂 分组管理
- 左侧/四周指示器，滚轮/点击切换分组
- 分组增删改、拖拽排序、移动到分组功能
- 组名显示 3 种状态：不显示 / 仅当前 / 全部显示

### 💾 数据管理
- 轻量配置 → `chrome.storage.sync`（跨设备自动同步）
- 图片资源 → IndexedDB（本地存储，无大小限制）
- 配置 JSON + 图片库 JSON 分体导出/导入 + 一键重置
- 卡片图标本地缓存（SW 代理下载，断网可用）

### �️ 浏览器右键菜单
- 在**任意网页**右键 → 「➕ 添加到 DeepPage」→ 选择分组
- 自动提取页面 URL 和标题生成卡片
- 右键菜单分组列表动态更新（含卡片数量统计）

### 🔒 更多细节
- 界面锁定（防误操作）+ 红白闪烁警告动画
- 设置面板可拖拽移动
- Toast 通知系统 + 键盘快捷键
- 右键上下文菜单（卡片/空白/分组）+ 移动到分组子菜单

---

## 📸 预览

| 浅色模式 | 深色模式 |
|:---:|:---:|
| ![](screenshots/01.%E6%B5%85%E8%89%B2%E4%B8%BB%E9%A2%98.png) | ![](screenshots/02.%E6%B7%B1%E8%89%B2%E4%B8%BB%E9%A2%98.png) |

---

## 📦 安装

### 方式一：Chrome Web Store（推荐）

> 即将上架

### 方式二：手动加载

1. 下载最新 [Release](https://github.com/liumian1201/DeepPage/releases) 中的 `DeepPage_Release_VX.X.X.zip` 并解压
2. 打开 Chrome，进入 `chrome://extensions/`
3. 开启右上角 **开发者模式**
4. 点击 **加载已解压的扩展程序**
5. 选择解压后的 `src/` 目录
6. 打开新标签页即可看到 DeepPage

### 方式三：源码构建

```bash
git clone https://github.com/liumian1201/DeepPage.git
cd DeepPage
# 直接将 src/ 目录加载到 Chrome 即可，无需构建
```

---

## 🗂️ 项目结构

```
DeepPage/
├── src/                    ← 开发源码目录
│   ├── manifest.json       # Manifest V3 配置
│   ├── background.js       # Service Worker（天气+图片代理+右键菜单）
│   ├── index.html          # 新标签页 + 设置面板 + 对话框
│   ├── css/
│   │   └── style.css       # 全局样式 + CSS 变量体系 + 双主题
│   ├── js/
│   │   ├── main.js         # 主入口：初始化/事件/快捷键/锁定/Toast
│   │   ├── cards.js        # 卡片渲染/CRUD/对话框/图标缓存
│   │   ├── groups.js       # 分组管理：指示器/切换/管理器
│   │   ├── dragdrop.js     # 拖拽排序（纯鼠标事件）
│   │   ├── search-engines.js  # 搜索引擎管理/下拉/搜索
│   │   ├── contextmenu.js  # 右键菜单 + 移动到分组子菜单
│   │   ├── storage.js      # chrome.storage 封装 + 默认值
│   │   ├── settings.js     # 设置面板交互 + CSS 变量预览
│   │   ├── appearance.js   # 外观配色 + 卡片尺寸预览
│   │   ├── wallpaper.js    # 壁纸系统 + IndexedDB
│   │   ├── backup.js       # 分体导出/导入 + 重置
│   │   ├── weather.js      # 天气（4 API + SW 代理 + 缓存）
│   │   ├── clock.js        # 时钟（12/24h + 秒数）
│   │   └── lunar.js        # 农历转换（1900-2100）
│   └── assets/
│       └── icons/          # icon-16/48/128.png
├── CHANGELOG.md            ← 更新日志
├── LICENSE                 ← MIT 许可证
├── PRIVACY_POLICY.md       ← 隐私政策
└── README.md               ← 本文件
```

---

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `/` | 聚焦搜索框 |
| `Ctrl + ,` | 打开/关闭设置面板 |
| `Ctrl + N` | 新建卡片 |
| `ESC` | 关闭弹窗/面板 |

---

## 🔧 技术栈

- **前端**：HTML5 + CSS3（Grid/Flexbox/CSS Variables）+ Vanilla JS
- **框架**：Chrome Extension API（Manifest V3）
- **存储**：`chrome.storage.sync` + `chrome.storage.local` + IndexedDB
- **无依赖**：纯原生实现，零外部库

---

## 📋 更新日志

详见 [CHANGELOG.md](./CHANGELOG.md)

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

## 📄 许可证

[MIT License](./LICENSE)
