// 极造数字 · 日报工具 桌面版主进程
// 启动内嵌 server.js（本地 HTTP 服务），创建桌面窗口加载，关闭时清理子进程
const { app, BrowserWindow, dialog, ipcMain, Tray, Menu, nativeImage, clipboard, session, shell, globalShortcut, screen, Notification } = require('electron');
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
  // 摸鱼新闻等外链：一律交给系统默认浏览器，不在应用内新开窗口
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) { try { shell.openExternal(url); } catch (e) {} }
    return { action: 'deny' };
  });
}

// ================= 摸鱼老板键（全局快捷键） =================
// 老板来了：Ctrl+Alt+H 立即隐藏窗口并切回日报页；若窗口本来已隐藏，再按一次恢复显示。
function setupBossKey() {
  try {
    const ok = globalShortcut.register('Control+Alt+H', () => {
      if (!mainWin || mainWin.isDestroyed()) return;
      if (mainWin.isVisible() && !mainWin.isMinimized()) {
        try { mainWin.webContents.send('boss-key'); } catch (e) {}
        mainWin.hide();
      } else {
        showMainWindow();
      }
    });
    console.log('[boss] 老板键 Ctrl+Alt+H ' + (ok ? '已注册' : '注册失败（可能被其它程序占用）'));
  } catch (e) {
    console.error('[boss] 注册失败：' + ((e && e.message) || e));
  }
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

// ================= 剪贴板（主进程写入） =================
// 渲染进程的 navigator.clipboard 在窗口未聚焦/不可见时会被 Chromium 拒绝（NotAllowedError），
// 桌面版统一走主进程剪贴板，保证"复制"在任何情况下都真的写进去。
ipcMain.handle('clipboard:write', (e, text) => {
  try {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  } catch (err) {
    return { ok: false, msg: err && err.message ? err.message : String(err) };
  }
});

// ================= 自动更新（electron-updater + GitHub Releases） =================
// 更新状态推送给前端
function pushUpdateStatus(status) {
  try {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update:status', status);
  } catch (e) {}
}
let updateDownloaded = false;
let promptedUpdateVersion = null;   // 已弹过窗的版本，避免同一次运行内反复打扰，
                                    // 也避免"更新装不上→每次启动又弹"的死循环观感

// 统一入口：真正启动已下载的安装包（旧代码误用 app.relaunch()，只重启自己、从不安装）
function installDownloadedUpdate() {
  if (serverProc) { try { serverProc.kill(); } catch (e) {} serverProc = null; }
  app.isQuitting = true;            // 放行窗口关闭，否则会被托盘隐藏逻辑拦截导致无法退出
  try {
    autoUpdater.quitAndInstall(false, true);   // isSilent=false 显示安装界面, isForceRunAfter=true 装完自动启动
  } catch (e) {
    // 极端情况下回退：至少重启，不再静默失败
    try { app.relaunch(); } catch (e2) {}
    app.exit(0);
  }
}

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
    var ver = info && info.version ? info.version : '';
    pushUpdateStatus({ state: 'downloaded', msg: '新版本 v' + ver + ' 已下载，可立即重启安装', version: ver });
    // 同一次运行内只提示一次，不再每次检查/启动都弹
    if (promptedUpdateVersion === ver) return;
    promptedUpdateVersion = ver;
    dialog.showMessageBox(mainWin, {
      type: 'info', title: '更新就绪',
      message: '新版本 v' + ver + ' 已下载完成',
      detail: '点击「立即重启并安装」将关闭应用、运行安装程序并自动重新打开。也可稍后从「数据管理 → 关于与更新」手动安装。',
      buttons: ['立即重启并安装', '稍后'], defaultId: 0, cancelId: 1
    }).then((r) => { if (r.response === 0) installDownloadedUpdate(); }).catch(() => {});
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

  // IPC：前端触发"立即重启并安装"
  ipcMain.handle('update:install', async () => {
    try {
      if (!app.isPackaged) return { ok: false, msg: '开发模式不支持' };
      if (!updateDownloaded) return { ok: false, msg: '尚未下载完成，请先检查更新' };
      // 让渲染进程有时间显示提示再退出
      setTimeout(() => { installDownloadedUpdate(); }, 400);
      return { ok: true, msg: '正在启动安装程序…' };
    } catch (e) {
      return { ok: false, msg: String(e && e.message ? e.message : e) };
    }
  });

  // 启动 5 秒后静默检查（不打扰）
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);
}


// ================= 划词翻译（全局快捷键 + 常驻取词助手 + 结果浮窗） =================
// 取词原理：快捷键触发 → 让常驻 PowerShell 助手向前台窗口发送 Ctrl+C → 读剪贴板 → 还原剪贴板。
// 为什么常驻：PowerShell 每次冷启动 + 加载 WinForms 需要数秒，常驻后单次取词约 60ms。
const TR_DEFAULT_SHORTCUT = 'Control+Alt+Q';   // 划词翻译：取词并翻译（避开常被占用的 Ctrl+Alt+T）
const TR_DEFAULT_PASTE = 'Control+Alt+V';      // 粘贴翻译：在光标处挑内容+格式并直接粘贴
let trWin = null;
let pasteWin = null;
let trShortcut = null;
let pasteShortcut = null;
let keyProc = null;
let keyBuf = '';
let keyQueue = [];
let keyStarting = null;

function keyhookPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'runtime', 'keyhook.ps1')
    : path.join(__dirname, 'keyhook.ps1');
}

function rejectKeyQueue(err) {
  const q = keyQueue;
  keyQueue = [];
  q.forEach(function (w) { try { w.reject(err); } catch (e) {} });
}

function ensureKeyWorker() {
  if (keyProc && keyProc.exitCode === null) return Promise.resolve(keyProc);
  if (keyStarting) return keyStarting;
  keyStarting = new Promise(function (resolve, reject) {
    let proc;
    try {
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', keyhookPath()],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { reject(e); return; }
    keyProc = proc;
    keyBuf = '';
    const timer = setTimeout(function () { reject(new Error('取词助手启动超时')); }, 10000);
    proc.stdout.on('data', function (d) {
      keyBuf += d.toString();
      let i;
      while ((i = keyBuf.indexOf('\n')) >= 0) {
        const line = keyBuf.slice(0, i).trim();
        keyBuf = keyBuf.slice(i + 1);
        if (line === 'READY') { clearTimeout(timer); resolve(proc); continue; }
        const w = keyQueue.shift();
        if (w) { if (/^ERR/.test(line)) w.reject(new Error(line)); else w.resolve(line); }
      }
    });
    proc.stderr.on('data', function () {});
    proc.on('error', function (e) { clearTimeout(timer); reject(e); });
    proc.on('exit', function () {
      if (keyProc === proc) keyProc = null;
      rejectKeyQueue(new Error('取词助手已退出'));
    });
  }).finally(function () { keyStarting = null; });
  return keyStarting;
}

function sendKeyCmd(line, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const to = setTimeout(function () { reject(new Error('取词超时')); }, timeoutMs || 4000);
    keyQueue.push({
      resolve: function (v) { clearTimeout(to); resolve(v); },
      reject: function (e) { clearTimeout(to); reject(e); }
    });
    try { keyProc.stdin.write(line + '\n'); }
    catch (e) { clearTimeout(to); reject(e); }
  });
}

async function captureSelection() {
  const prev = clipboard.readText();
  try { clipboard.clear(); } catch (e) {}
  await ensureKeyWorker();
  await sendKeyCmd('COPY');
  await new Promise(function (r) { setTimeout(r, 90); });
  let sel = '';
  try { sel = clipboard.readText(); } catch (e) {}
  try { clipboard.writeText(prev || ''); } catch (e) {}   // 还原用户原剪贴板
  return sel;
}

// 浮窗贴光标显示（并保证不出屏）
function placeNearCursor(W, H) {
  try {
    const pt = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(pt).workArea;
    return {
      x: Math.min(Math.max(Math.round(pt.x + 14), wa.x + 8), wa.x + wa.width - W - 8),
      y: Math.min(Math.max(Math.round(pt.y + 14), wa.y + 8), wa.y + wa.height - H - 8)
    };
  } catch (e) { return { x: undefined, y: undefined }; }
}

// 通用浮窗：不可聚焦（focusable:false）→ 点它不会夺走目标程序焦点，光标位置不丢
function makeFloatWin(name, W, H) {
  const pos = placeNearCursor(W, H);
  const win = new BrowserWindow({
    width: W, height: H, x: pos.x, y: pos.y,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    focusable: false, title: name, backgroundColor: '#f7f9fc', show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  return win;
}

function openTranslateWindow(text) {
  if (!lastPort) return;
  const target = 'http://127.0.0.1:' + lastPort + '/translate.html?text=' + encodeURIComponent(String(text == null ? '' : text).slice(0, 20000));
  if (trWin && !trWin.isDestroyed()) {
    trWin.loadURL(target);
    trWin.showInactive();
    return;
  }
  trWin = makeFloatWin('划词翻译', 300, 262);
  trWin.loadURL(target);
  bindFloatWindow(trWin);
  trWin.once('ready-to-show', function () { if (trWin && !trWin.isDestroyed()) trWin.showInactive(); });
  trWin.on('closed', function () { trWin = null; });
}

// 粘贴选择器：在「粘贴这一刻」挑译文内容 + 复制格式，然后直接粘到光标处
function openPasteChooser() {
  if (!lastPort) return;
  const target = 'http://127.0.0.1:' + lastPort + '/translate.html?mode=paste';
  if (pasteWin && !pasteWin.isDestroyed()) {
    pasteWin.loadURL(target);
    pasteWin.showInactive();
    return;
  }
  pasteWin = makeFloatWin('粘贴翻译', 300, 262);
  pasteWin.loadURL(target);
  bindFloatWindow(pasteWin);
  pasteWin.once('ready-to-show', function () { if (pasteWin && !pasteWin.isDestroyed()) pasteWin.showInactive(); });
  pasteWin.on('closed', function () { pasteWin = null; });
}

// 写剪贴板 → 向前台程序发送 Ctrl+V（选择器不可聚焦，所以前台仍是用户的目标程序）
async function pasteToCursor(text) {
  const t = String(text == null ? '' : text);
  if (!t) return { ok: false, msg: '没有可粘贴的内容' };
  try { clipboard.writeText(t); } catch (e) {}
  try {
    await ensureKeyWorker();
    await sendKeyCmd('PASTE');
  } catch (e) {
    return { ok: false, msg: '粘贴失败：' + ((e && e.message) || e) };
  }
  // 粘贴完成后再收起选择器：避免在注入按键的瞬间改变前台窗口，导致 Ctrl 修饰键丢失
  if (pasteWin && !pasteWin.isDestroyed()) pasteWin.hide();
  return { ok: true, chars: t.length };
}

function notifyUser(title, body) {
  try { new Notification({ title: title, body: String(body).slice(0, 220) }).show(); } catch (e) {}
}

async function translateSelection() {
  let text = '';
  try { text = await captureSelection(); }
  catch (e) {
    const msg = String((e && e.message) || e);
    notifyUser('划词翻译', '取词失败：' + msg);
    return { ok: false, msg: msg };
  }
  if (!text || !text.trim()) {
    notifyUser('划词翻译', '没有取到选中文本：请先选中内容再按快捷键');
    return { ok: false, msg: '没有取到选中文本（请先选中文字）' };
  }
  openTranslateWindow(text);
  return { ok: true, chars: text.length };
}

function registerTranslateShortcut(accel) {
  const a = String(accel || TR_DEFAULT_SHORTCUT).trim() || TR_DEFAULT_SHORTCUT;
  // 已经是这个组合：直接算成功，否则重复注册会被自己占用而误报失败
  if (trShortcut === a) return { ok: true, shortcut: a, msg: '已注册：' + a };
  if (trShortcut && trShortcut !== a) { try { globalShortcut.unregister(trShortcut); } catch (e) {} }
  let ok = false;
  try { ok = globalShortcut.register(a, function () { translateSelection(); }); } catch (e) { ok = false; }
  if (ok) trShortcut = a;
  console.log('[translate] 划词快捷键 ' + a + (ok ? ' 已注册' : ' 注册失败（可能被占用）'));
  return { ok: ok, shortcut: a, msg: ok ? ('已注册：' + a) : ('注册失败：' + a + ' 可能被其它程序占用，请换一个组合') };
}

function registerPasteShortcut(accel) {
  const a = String(accel || TR_DEFAULT_PASTE).trim() || TR_DEFAULT_PASTE;
  if (pasteShortcut === a) return { ok: true, shortcut: a, msg: '已注册：' + a };
  if (pasteShortcut && pasteShortcut !== a) { try { globalShortcut.unregister(pasteShortcut); } catch (e) {} }
  let ok = false;
  try { ok = globalShortcut.register(a, function () { openPasteChooser(); }); } catch (e) { ok = false; }
  if (ok) pasteShortcut = a;
  console.log('[translate] 粘贴快捷键 ' + a + (ok ? ' 已注册' : ' 注册失败（可能被占用）'));
  return { ok: ok, shortcut: a, msg: ok ? ('已注册：' + a) : ('注册失败：' + a + ' 可能被其它程序占用，请换一个组合') };
}

// ===== 浮窗数字选格式 =====
// 浮窗刻意不可聚焦（否则会抢走目标程序光标），所以数字键改用「临时全局快捷键」接管：
// 浮窗显示期间占用 1..n 与 Esc，选中/关闭后立即释放，不影响正常打字。
let pickKeys = [];
function releasePickKeys() {
  pickKeys.forEach(function (a) { try { globalShortcut.unregister(a); } catch (e) {} });
  pickKeys = [];
}
function pickFromWindow(win, key) {
  if (!win || win.isDestroyed()) { releasePickKeys(); return; }
  if (key === 'Escape') { win.hide(); releasePickKeys(); return; }
  try { win.webContents.send('translate:pick', Number(key)); } catch (e) {}
}
function armPickKeys(win, count) {
  releasePickKeys();
  const keys = [];
  for (let i = 1; i <= Math.min(count, 9); i++) keys.push(String(i));
  keys.push('Escape');
  keys.forEach(function (k) {
    let ok = false;
    try { ok = globalShortcut.register(k, function () { pickFromWindow(win, k); }); } catch (e) { ok = false; }
    if (ok) pickKeys.push(k);
  });
  console.log('[translate] 浮窗选择键 ' + (pickKeys.join(',') || '无') + '（共 ' + count + ' 项）');
  return { ok: pickKeys.length > 0, keys: pickKeys.slice() };
}
function bindFloatWindow(win) {
  win.on('hide', function () { releasePickKeys(); });
  win.on('closed', function () { releasePickKeys(); });
}

ipcMain.handle('translate:armKeys', function (e, count) {
  const win = BrowserWindow.fromWebContents(e.sender);
  return armPickKeys(win, Number(count) || 0);
});
ipcMain.handle('translate:resize', function (e, size) {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return { ok: false };
  const w = Math.max(200, Math.min(640, Math.round(Number(size && size.w) || 320)));
  const h = Math.max(140, Math.min(620, Math.round(Number(size && size.h) || 200)));
  try {
    const b = win.getBounds();
    win.setBounds({ x: b.x, y: b.y, width: w, height: h });
    if (!win.isVisible()) win.showInactive();
    return { ok: true, w: w, h: h };
  } catch (err) { return { ok: false, msg: String((err && err.message) || err) }; }
});
ipcMain.handle('translate:state', function () {
  return {
    digits: pickKeys.slice(),
    trVisible: !!(trWin && !trWin.isDestroyed() && trWin.isVisible()),
    pasteVisible: !!(pasteWin && !pasteWin.isDestroyed() && pasteWin.isVisible())
  };
});

ipcMain.handle('translate:shortcut', function (e, accel) { return registerTranslateShortcut(accel); });
ipcMain.handle('translate:pasteShortcut', function (e, accel) { return registerPasteShortcut(accel); });
ipcMain.handle('translate:paste', async function (e, text) { return await pasteToCursor(text); });
ipcMain.handle('translate:closePaste', function () {
  releasePickKeys();
  if (pasteWin && !pasteWin.isDestroyed()) pasteWin.close();
  return { ok: true };
});
ipcMain.handle('translate:chooser', function () { openPasteChooser(); return { ok: true }; });
ipcMain.handle('translate:capture', async function () { return await translateSelection(); });
ipcMain.handle('translate:popup', function (e, text) { openTranslateWindow(String(text || '')); return { ok: true }; });
ipcMain.handle('translate:close', function () {
  releasePickKeys();
  if (trWin && !trWin.isDestroyed()) trWin.close();
  return { ok: true };
});

app.whenReady().then(() => {
  // 本地服务的页面不做缓存：清掉历史缓存，确保升级后运行的一定是已安装的版本
  try { session.defaultSession.clearCache(); } catch (e) {}
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
    setupBossKey(); // 全局老板键 Ctrl+Alt+H
    registerTranslateShortcut(TR_DEFAULT_SHORTCUT); // 划词翻译默认快捷键（前端加载后会按用户设置覆盖）
    registerPasteShortcut(TR_DEFAULT_PASTE);        // 粘贴翻译默认快捷键
    // 预热取词助手（PowerShell 冷启动约 260ms），让第一次按快捷键就快
    ensureKeyWorker().catch(function () {});
    setupAutoUpdater();
  });
});

// 退出时结束子进程
app.on('before-quit', () => {
  if (serverProc) { try { serverProc.kill(); } catch (e) {} serverProc = null; }
  if (keyProc) { try { keyProc.stdin.write('QUIT\n'); keyProc.kill(); } catch (e) {} keyProc = null; }
  if (trWin && !trWin.isDestroyed()) { try { trWin.destroy(); } catch (e) {} }
  if (pasteWin && !pasteWin.isDestroyed()) { try { pasteWin.destroy(); } catch (e) {} }
  try { globalShortcut.unregisterAll(); } catch (e) {}
});
// 窗口全部关闭（实际是隐藏到托盘）→ 保持后台运行，不退出
app.on('window-all-closed', () => {
  // 后台运行：任务提醒/通知继续生效，从托盘重新打开
});
