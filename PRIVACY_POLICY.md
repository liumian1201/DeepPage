# DeepPage 隐私政策

> 最后更新：2026年6月2日

## 概述

DeepPage 是一款 Chrome 浏览器新标签页扩展。我们高度重视您的隐私，本政策旨在透明地说明扩展如何处理您的数据。

## 数据收集与使用

### 🔒 本地存储的数据

DeepPage 在您的设备本地存储以下数据：

| 数据类型 | 存储位置 | 用途 | 是否上传 |
|----------|----------|------|----------|
| 快捷导航卡片（URL、名称、图标） | `chrome.storage.sync` | 跨设备同步您的书签配置 | 通过 Google 账号同步 |
| 设置偏好（主题、布局、外观） | `chrome.storage.sync` | 跨设备同步您的个性化设置 | 通过 Google 账号同步 |
| 天气缓存数据 | `chrome.storage.local` | 减少 API 请求频率 | ❌ 不上传 |
| 壁纸图片缓存 | `chrome.storage.local` | 快速加载壁纸 | ❌ 不上传 |
| 卡片图标图片 | IndexedDB | 断网时正常显示图标 | ❌ 不上传 |
| 用户上传的壁纸/图标 | IndexedDB | 自定义外观 | ❌ 不上传 |

### 🌐 网络请求

DeepPage 会向以下第三方服务发起请求：

| 服务 | 用途 | 传输数据 |
|------|------|----------|
| **Bing** (`www.bing.com`) | 获取每日壁纸 | 无个人信息 |
| **Open-Meteo** (`api.open-meteo.com`) | 天气数据（默认） | 城市坐标 |
| **和风天气** (`devapi.qweather.com`) | 天气数据（可选） | 城市名称/坐标 + API Key |
| **OpenWeatherMap** (`api.openweathermap.org`) | 天气数据（可选） | 城市名称/坐标 + API Key |
| **自定义天气 API** | 天气数据（可选） | 取决于您的配置 |
| **卡片网站 Favicon** | 自动获取网站图标 | 目标网站 URL |

### ❌ 我们不收集的数据

- 不收集您的浏览历史
- 不收集您的搜索关键词
- 不收集您的个人身份信息
- 不使用任何分析/统计 SDK
- 不向第三方出售或分享任何数据

## 权限说明

| 权限 | 用途 |
|------|------|
| `storage` | 保存您的卡片和设置 |
| `unlimitedStorage` | 存储壁纸和图标图片（IndexedDB） |
| `tabs` | 卡片新标签页打开方式控制 |
| `contextMenus` | 浏览器右键菜单「添加到 DeepPage」 |
| `host_permissions` | 获取天气数据、壁纸图片、网站 Favicon |

## 数据控制

- 您可以通过设置面板的「数据管理」→「重置全部」一键清除所有本地数据
- 卸载扩展时，所有本地数据将被 Chrome 自动清除
- `chrome.storage.sync` 中的数据可通过 [Google 信息中心](https://chrome.google.com/sync) 管理

## 联系我们

如有隐私相关问题，请通过 GitHub Issues 联系我们：

[https://github.com/liumian1201/DeepPage/issues](https://github.com/liumian1201/DeepPage/issues)

## 政策更新

我们可能会不时更新本隐私政策。更新后的政策将随新版本发布时同步更新。
