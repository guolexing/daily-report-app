// preload.js — 暴露安全的 IPC API 给前端（contextIsolation 下）
const { contextBridge, ipcRenderer } = require('electron');

// 系统剪贴板（由主进程执行，不受窗口焦点/可见性影响）
contextBridge.exposeInMainWorld('appClipboard', {
  write: (text) => ipcRenderer.invoke('clipboard:write', text)
});

// 老板键：主进程全局快捷键触发 → 渲染进程切回日报页
contextBridge.exposeInMainWorld('appBoss', {
  on: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('boss-key', handler);
    return () => ipcRenderer.removeListener('boss-key', handler);
  }
});

// 划词翻译：取词 / 打开结果浮窗 / 设置全局快捷键 / 关闭浮窗
contextBridge.exposeInMainWorld('appTranslate', {
  capture: () => ipcRenderer.invoke('translate:capture'),
  openPopup: (text) => ipcRenderer.invoke('translate:popup', text),
  setShortcut: (accel) => ipcRenderer.invoke('translate:shortcut', accel),
  setPasteShortcut: (accel) => ipcRenderer.invoke('translate:pasteShortcut', accel),
  openChooser: () => ipcRenderer.invoke('translate:chooser'),
  paste: (text) => ipcRenderer.invoke('translate:paste', text),
  closePaste: () => ipcRenderer.invoke('translate:closePaste'),
  close: () => ipcRenderer.invoke('translate:close'),
  // 浮窗：数字键选格式（主进程临时接管数字键后推过来）
  onPick: (cb) => {
    const handler = (e, idx) => cb(idx);
    ipcRenderer.on('translate:pick', handler);
    return () => ipcRenderer.removeListener('translate:pick', handler);
  },
  armKeys: (count) => ipcRenderer.invoke('translate:armKeys', count),
  resize: (w, h) => ipcRenderer.invoke('translate:resize', { w: w, h: h }),
  state: () => ipcRenderer.invoke('translate:state')
});

contextBridge.exposeInMainWorld('appUpdate', {
  // 检查更新（返回 Promise<{ok,msg,status}>）
  check: () => ipcRenderer.invoke('update:check'),
  // 立即重启并安装已下载的更新
  install: () => ipcRenderer.invoke('update:install'),
  // 订阅更新状态事件
  onStatus: (cb) => {
    const handler = (e, data) => cb(data);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  }
});
