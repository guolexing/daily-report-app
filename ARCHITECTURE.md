# 架构备忘：自动更新（v1.1.0 起）

> 用途：本文件是 Memmy 记忆的本地镜像（Memmy 服务暂不可用时用）。内容：日报工具自动更新架构。

## 自动更新链路
electron-updater 6.8.9 + GitHub Releases

```
electron-builder 打包 → dist/latest.yml（url: jzd-daily-app-setup-<ver>.exe + sha512 + size）
  + ASCII 名安装包 jzd-daily-app-setup-<ver>.exe
    → gh release create vX.Y.Z（必须同时上传 latest.yml 和 exe 到同一 Release）
    → 用户端 autoUpdater 读 latest.yml 对比版本
```

## main.js 要点
- setupAutoUpdater() 只在 app.isPackaged 启用（开发模式跳过）
- autoDownload=true + autoInstallOnAppQuit=true
- 事件：checking / update-available / update-not-available / download-progress / update-downloaded / error
- 状态通过 mainWin.webContents.send('update:status') 推前端
- update-downloaded 弹 dialog：「立即重启」→ app.relaunch() + app.exit(0)
- ipcMain.handle('update:check') 供前端触发
- 启动 5 秒后 setTimeout 静默 checkForUpdates()

## preload.js
- contextBridge 暴露 window.appUpdate = { check: invoke('update:check'), onStatus: 订阅 }
- webPreferences 需加 preload: path.join(__dirname, 'preload.js')

## 前端（index.html 数据管理 → 关于与更新）
- app_version：桌面版显示「桌面版 v1.1.0」，Web 模式显示「Web 版」并提示手动下载
- 🔄 检查更新按钮 → appCheckUpdate()
- 🌐 GitHub 仓库按钮 → appOpenRepo()

## 打包注意
- electron-updater 及传递依赖（builder-util-runtime / fs-extra / js-yaml / lazy-val / lodash.escaperegexp / lodash.isequal / semver / tiny-typed-emitter / jsonfile / graceful-fs / universalify）必须全部列进 build.files（进 app.asar），否则主进程 require 失败
- mysql2 走 runtime/ 目录（ELECTRON_RUN_AS_NODE 子进程 require 不了 asar）

## 发布新版本 3 步
```bash
cd D:\file\极造数字\日报工具
# 1. 改 package.json version（如 1.1.1）
# 2. 打包（生成 latest.yml + 新 exe）
npx electron-builder --win nsis
# 3. 发布
git add -A && git commit -m "v1.1.1" && git push
git tag v1.1.1 && git push origin v1.1.1
gh release create v1.1.1 "dist/jzd-daily-app-setup-1.1.1.exe" "dist/latest.yml" --title "v1.1.1" --notes "说明"
```
- ⚠️ exe 必须复制为 ASCII 名（latest.yml 引用的文件名），中文名「工作日报 Setup」不行

## 网络
- GitHub 访问走代理 127.0.0.1:7897（clash 新加坡02 节点）
- gh 已认证 guolexing（repo + workflow 权限）
- 仓库：https://github.com/guolexing/daily-report-app（公开）
