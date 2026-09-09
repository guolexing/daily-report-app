# 📋 工作日报 · 周报月报生成器

一个本地优先的**工作日报管理桌面应用**：记录每日工作 → 自动汇总周报/月报 → AI 智能摘要 → Windows 原生提醒。

基于 **Electron + 原生 HTML/JS + MySQL**，完全本地运行，数据自主可控。

![version](https://img.shields.io/badge/version-1.0.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/platform-Windows-x64-blue)

---

## ✨ 功能特性

- 📝 **日报管理**：项目+任务+工时+工作内容+明日计划，快速录入与修改
- 📊 **周报/月报自动汇总**：按周/月自动聚合，支持 Excel / Markdown 导出
- 🗓️ **日历视图**：月份缺报统计、休息日/周末标注、点击日期查看/编辑当天日报
- ✅ **任务看板**：任务计划、紧急置顶、完成/取消、自动重新排期
- ⏰ **Windows 原生提醒**：任务开始时间系统 Toast 通知（无需浏览器）
- 🤖 **AI 智能汇总**：接入 OpenAI 兼容接口，一键生成周报/月报摘要
- 🧠 **AI 智能导入**：粘贴任意格式的日程文本，AI 自动识别并结构化导入
- 💾 **MySQL 持久化**：数据存本地 MySQL，打开 APP 自动读写；支持全库 SQL 导出/导入，数据可移植到任意电脑

## 🖥️ 技术栈

| 层 | 技术 |
|---|---|
| 界面 | 原生 HTML/CSS/JS（单页应用） |
| 桌面壳 | Electron |
| 本地服务 | Node.js http（内嵌） |
| 数据库 | MySQL 8（mysql2 驱动） |
| 通知 | Windows UINotifications (WinRT Toast) |
| 打包 | electron-builder (NSIS) |

## 🚀 快速开始

### 方式一：安装包（唯一使用方式）

从 [Releases](../../releases) 下载 `jzd-daily-app-setup-x.x.x.exe`，双击安装即可（自动创建桌面快捷方式，并支持应用内自动更新）。

> 📌 本应用是**桌面版**，仅通过安装包使用。安装后双击桌面「工作日报」图标启动。

### 方式二：源码开发（面向开发者）

```bash
# 1. 安装依赖
npm install

# 2. 配置 MySQL（可选，不配置则数据存本地 localStorage）
cp db_config.example.json db_config.json   # Windows: copy db_config.example.json db_config.json
# 编辑 db_config.json 填入你的 MySQL 连接信息

# 3. 启动桌面版（开发模式）
npm start
```

### 数据库

首次连接 MySQL 时自动创建 `jzd_daily` 库与 `jzd_state` 表（键值存储），无需手工建表。

数据可移植：APP 内「数据管理 → MySQL 数据存储 → ⬇ 导出 SQL 备份」生成全库 .sql 标准备份（可在任意 MySQL 恢复）；「⬆ 从 SQL 文件恢复」导入覆盖（导入前自动备份当前库到本机 `backups/` 目录）。

## 🔨 构建安装包

```bash
# 生成 NSIS 安装包（dist/工作日报 Setup x.x.x.exe）
npm run dist
```

打包流程说明：
1. `runtime/` 目录由脚本生成（内嵌 Node 运行时 + 依赖，不入库）
2. electron-builder 将应用 + 运行时打包为 NSIS 安装包
3. 安装包可分发到任意 Windows x64 机器

## 📁 项目结构

```
日报工具/
├── index.html        # 前端单页（全部 UI 与逻辑）
├── server.js         # 内置服务（静态页面 + AI 代理 + MySQL + 通知，由桌面版启动）
├── main.js           # Electron 主进程（启动服务 + 桌面窗口）
├── package.json      # 依赖与构建配置
├── db_config.example.json  # MySQL 配置模板（复制为 db_config.json 使用）
├── build/            # 图标等构建资源
└── dist/             # 打包产物（不入库，走 Releases）
```

## 🔒 安全说明

- `db_config.json`（含数据库密码）**已加入 .gitignore，不会提交**，请勿手动提交
- 数据存储于本地 MySQL / 浏览器 localStorage，不经过任何第三方服务器
- AI 功能需自行配置 API Key（仅存本地浏览器）

## 📄 License

[MIT](LICENSE)
