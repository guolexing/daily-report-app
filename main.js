// 极造数字 · 日报工具 桌面版主进程
// 启动内嵌 server.js（本地 HTTP 服务），创建桌面窗口加载，关闭时清理子进程
const { app, BrowserWindow, dialog, ipcMain, Tray, Menu, nativeImage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const { autoUpdater } = require('electron-updater');

// 单实例：重复启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

let serverProc = null;
let mainWin = null;
let tray = null;      // 系统托盘
let lastPort = null;  // 记住当前端口，窗口重建时复用
app.isQuitting = false; // 是否真正退出（托盘菜单退出）

// 查找空闲端口（备用）
function findFreePort(start, callback) {
  const tryPort = (p) => {
    if (p > start + 5000) { callback(null); return; }
    const srv = net.createServer();
    srv.once('error', () => { srv.close(); tryPort(p + 1); });
    srv.listen(p, '127.0.0.1', () => { srv.close(() => callback(p)); });
  };
  tryPort(start);
}

function startServer(cb) {
  const isDev = !app.isPackaged;
  // 子进程启动 server.js：开发模式用本机 node；打包后用随包的 runtime\node.exe（真实 Node，require 正常）
  const serverDir = isDev ? __dirname : path.join(process.resourcesPath, 'runtime');
  const nodeBin = isDev ? process.execPath : path.join(serverDir, 'node.exe');
  serverProc = spawn(nodeBin, [path.join(serverDir, 'server.js')], {
    cwd: serverDir,
    env: Object.assign({}, process.env, { PORT_AUTO: '1', JZD_DATA_DIR: app.getPath('userData') }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let buf = '';
  serverProc.stdout.on('data', (d) => {
    buf += d.toString();
    const m = buf.match(/PORT_STARTED:(\d+)/);
    if (m) { cb(parseInt(m[1], 10)); buf = ''; }
  });
  serverProc.stderr.on('data', (d) => { console.error('[server]', d.toString().trim()); });
  serverProc.on('exit', (code) => { console.log('[server] exited', code); });
  // 8 秒超时
  setTimeout(() => { if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isLoading()) {} }, 8000);
}

function createWindow(port) {
  // 窗口图标：打包后用随包 app-icon.png；开发用 build/icon.ico
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app-icon.png')
    : path.join(__dirname, 'build', 'icon.ico');
  mainWin = new BrowserWindow({
    width: 1280, height: 860,
    minWidth: 1024, minHeight: 700,
    title: '工作日报 · 周报月报生成器',
    autoHideMenuBar: true,
    icon: iconPath,
    backgroundColor: '#eef2f9',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWin.loadURL('http://127.0.0.1:' + port);
  lastPort = port;
  // 关闭窗口 → 隐藏到托盘（后台继续运行，任务提醒仍生效），不销毁
  mainWin.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  mainWin.on('closed', () => { mainWin = null; });
}

// 显示/恢复主窗口（托盘点击、二次启动、菜单项）
function showMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show();
    mainWin.focus();
    if (mainWin.isMinimized()) mainWin.restore();
  } else if (lastPort) {
    // 窗口被销毁过 → 重建（server 仍在运行，直接加载）
    createWindow(lastPort);
  }
}

// 创建系统托盘图标（点击打开主窗口，右键菜单可退出）
function createTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app-icon.png')
    : path.join(__dirname, 'build', 'icon.ico');
  try {
    // Windows 托盘用 32x32 小图标（原生图像缩放，避免大图模糊/占位）
    let img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) img = nativeImage.createEmpty();
    else if (img.getSize().width > 32) img = img.resize({ width: 32, height: 32 });
    tray = new Tray(img);
    tray.setToolTip('工作日报 · 周报月报生成器（后台运行中）');
    const menu = Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(menu);
    // 单击托盘图标 → 打开/显示主窗口
    tray.on('click', () => showMainWindow());
    console.log('[tray] 系统托盘已创建');
  } catch (e) {
    console.error('[tray] 创建失败：' + (e && e.message ? e.message : e));
  }
}

// ================= 自动更新（electron-updater + GitHub Releases） =================
// 更新状态推送给前端
function pushUpdateStatus(status) {
  try {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update:status', status);
  } catch (e) {}
}
let updateDownloaded = false;

function setupAutoUpdater() {
  if (!app.isPackaged) { console.log('[update] 开发模式跳过自动更新'); return; }
  autoUpdater.autoDownload = true;   // 自动下载
  autoUpdater.autoInstallOnAppQuit = true; // 退出时自动安装
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => pushUpdateStatus({ state: 'checking', msg: '正在检查更新…' }));
  autoUpdater.on('update-available', (info) => pushUpdateStatus({ state: 'available', msg: '发现新版本 v' + info.version + '，正在下载…', version: info.version }));
  autoUpdater.on('update-not-available', () => pushUpdateStatus({ state: 'none', msg: '当前已是最新版本' }));
  autoUpdater.on('download-progress', (p) => pushUpdateStatus({ state: 'downloading', msg: '正在下载更新… ' + Math.round(p.percent) + '%', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    pushUpdateStatus({ state: 'downloaded', msg: '新版本 v' + info.version + ' 已下载，重启后安装', version: info.version });
    dialog.showMessageBox(mainWin, {
      type: 'info', title: '更新就绪',
      message: '新版本 v' + info.version + ' 已下载完成',
      detail: '重启应用即可完成更新安装。',
      buttons: ['立即重启', '稍后'], defaultId: 0, cancelId: 1
    }).then((r) => { if (r.response === 0) { if (serverProc) { try { serverProc.kill(); } catch (e2) {} serverProc = null; } app.relaunch(); app.exit(0); } }).catch(() => {});
  });
  autoUpdater.on('error', (err) => pushUpdateStatus({ state: 'error', msg: '更新检查失败：' + (err && err.message ? err.message : err) }));

  // IPC：前端触发检查
  ipcMain.handle('update:check', async () => {
    try {
      if (!app.isPackaged) return { ok: true, msg: '开发模式无更新检查' };
      if (updateDownloaded) return { ok: true, msg: '更新已下载，重启后生效' };
      await autoUpdater.checkForUpdates();
      return { ok: true, msg: '检查中…' };
    } catch (e) {
      return { ok: false, msg: String(e && e.message ? e.message : e) };
    }
  });

  // 启动 5 秒后静默检查（不打扰）
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);
}

app.whenReady().then(() => {
  startServer((port) => {
    if (!port) {
      // 子进程未输出端口（异常）→ 找空闲端口兜底
      findFreePort(8080, (p) => {
        if (!p) { dialog.showErrorBox('启动失败', '无法启动本地服务'); app.quit(); return; }
        const srvDir = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : __dirname;
        const srv = spawn(app.isPackaged ? path.join(srvDir, 'node.exe') : process.execPath, [path.join(srvDir, 'server.js')], {
          cwd: srvDir,
          env: Object.assign({}, process.env, { PORT: String(p), PORT_AUTO: '1', JZD_DATA_DIR: app.getPath('userData') }),
          stdio: 'ignore'
        });
        serverProc = srv;
        createWindow(p);
      });
      return;
    }
    createWindow(port);
    createTray();   // 系统托盘（关闭窗口后仍可从此打开）
    setupAutoUpdater();
  });
});

// 退出时结束子进程
app.on('before-quit', () => {
  if (serverProc) { try { serverProc.kill(); } catch (e) {} serverProc = null; }
});
// 窗口全部关闭（实际是隐藏到托盘）→ 保持后台运行，不退出
app.on('window-all-closed', () => {
  // 后台运行：任务提醒/通知继续生效，从托盘重新打开
});
