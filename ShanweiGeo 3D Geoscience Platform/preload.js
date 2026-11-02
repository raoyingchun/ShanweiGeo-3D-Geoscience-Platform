// ============================================================
// preload.js - 安全桥接层
// 通过 contextBridge 向渲染进程暴露受限的 Electron API
// 渲染进程无法直接访问 Node.js，只能用这里暴露的接口
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  listCustomMaterials:()=>ipcRenderer.invoke('materials:list'),
  importCustomMaterial:payload=>ipcRenderer.invoke('materials:import',payload),
  readCustomMaterial:id=>ipcRenderer.invoke('materials:read',id),
  deleteCustomMaterial:id=>ipcRenderer.invoke('materials:delete',id),
  openCoordTool: () => ipcRenderer.invoke('utilities:open-coord'),
  decodeTiffPreview: bytes => ipcRenderer.invoke('images:tiff-preview', bytes),
  preprocessImage: options => ipcRenderer.invoke('images:preprocess', options),
  readDocumentNotes: identity => ipcRenderer.invoke('notes:read',identity),
  saveDocumentNotes: payload => ipcRenderer.invoke('notes:save',payload),
  flushDocumentNotes: payload => ipcRenderer.sendSync('notes:flush',payload),
  runPythonTask: request => ipcRenderer.invoke('python:run', request),
  readModelGeometry: key => ipcRenderer.invoke('models:read-geometry', key),
  readBlockData: key => ipcRenderer.invoke('blocks:read-data', key),
  cancelPythonTask: taskId => ipcRenderer.invoke('python:cancel', taskId),
  onPythonTaskEvent: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('python:event', listener);
    return () => ipcRenderer.removeListener('python:event', listener);
  },
  // 获取应用版本信息
  getVersion: () => process.versions.electron,

  // 判断是否在 Electron 环境中
  isElectron: true,

  // 平台信息
  platform: process.platform,

  // 通过 IPC 读取本地文件（备用方案，当 app:// 协议不够用时使用）
  readFile: (relativePath) => ipcRenderer.invoke('read-file', relativePath),

  // 保存文件对话框
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),

  // 打开文件对话框（项目文件）
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),

  // 读取任意路径文件（返回 { ok, data(base64), error }）
  readProjectFile: (filePath) => ipcRenderer.invoke('read-project-file', filePath),

  // 获取任意路径文件的 stat（返回 { ok, size, mtimeMs, error }，几何缓存命中判定用）
  statProjectFile: (filePath) => ipcRenderer.invoke('stat-project-file', filePath),

  // 写入任意路径文件（返回 { ok, error }）
  writeProjectFile: (filePath, content) => ipcRenderer.invoke('write-project-file', filePath, content),

  // 会话自动记忆：写入/读取/清除固定会话草稿（userData/shanwei-session.json）
  saveSession: (content) => ipcRenderer.invoke('session-save', content),
  readSession: () => ipcRenderer.invoke('session-read'),
  clearSession: () => ipcRenderer.invoke('session-clear'),

  // 关闭前询问：主进程拦截窗口关闭时通知渲染层（渲染层弹「是否保存」弹窗）
  onCloseRequest: (callback) => {
    ipcRenderer.on('window-close-request', () => callback());
  },

  // 允许关闭：渲染层完成保存/不保存决策后调用，真正关闭窗口
  allowClose: () => ipcRenderer.send('allow-close'),

  // 打开外部链接
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // ===== 开发基础设施 =====

  // 热刷新：重新加载当前页面（修改代码后调用，自动刷新验证）
  refreshApp: () => ipcRenderer.send('refresh-app'),

  // 获取应用状态（诊断用）
  getAppState: () => ipcRenderer.invoke('get-app-state')
});
