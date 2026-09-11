// preload.js — 暴露安全的 IPC API 给前端（contextIsolation 下）
const { contextBridge, ipcRenderer } = require('electron');

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
