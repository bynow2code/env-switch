// 预加载脚本：在 contextIsolation 隔离环境下，把主进程的更新能力通过 contextBridge
// 安全暴露给渲染进程（窗口里通过 window.electronAPI 调用）。
// 所有接口都走 ipcRenderer，不直接暴露 Node / Electron 内部对象。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // 检查更新：对应主进程 app:check-updates
  checkForUpdates: () => ipcRenderer.invoke('app:check-updates'),

  // 下载更新：对应主进程 app:download-update
  downloadUpdate: () => ipcRenderer.invoke('app:download-update'),

  // 退出并安装更新：对应主进程 app:start-update
  startUpdate: () => ipcRenderer.invoke('app:start-update'),

  // 获取应用信息（版本号等）：对应主进程 app:get-info
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),

  // 用系统默认浏览器打开外部链接：对应主进程 app:open-external
  // 渲染端不要把 <a> 直接交给 Electron 打开（会在新窗口开），而是通过这里走 shell.openExternal
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  // 订阅更新事件（checking/available/not-available/downloading/downloaded/error）
  // 返回一个取消订阅函数，供 React 在卸载时清理
  onUpdateEvent: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('update-event', listener)
    return () => ipcRenderer.removeListener('update-event', listener)
  },

  // 调起系统文件夹选择器（添加项目时用）：对应主进程 app:select-folder
  // 返回选中的目录绝对路径字符串；用户取消则返回 null。
  // 渲染端不要直接 require('electron').dialog —— contextIsolation 下拿不到，必须走桥。
  selectFolder: () => ipcRenderer.invoke('app:select-folder')
})
