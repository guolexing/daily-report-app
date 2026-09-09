// 极造数字 · 日报工具 桌面版主进程
// 启动内嵌 server.js（本地 HTTP 服务），创建桌面窗口加载，关闭时清理子进程
const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

// 单实例：重复启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

let serverProc = null;
let mainWin = null;

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
    backgroundColor: '#f4f6fb',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  mainWin.loadURL('http://127.0.0.1:' + port);
  mainWin.on('closed', () => { mainWin = null; });
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
  });
});

// 退出时结束子进程
app.on('before-quit', () => {
  if (serverProc) { try { serverProc.kill(); } catch (e) {} serverProc = null; }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
