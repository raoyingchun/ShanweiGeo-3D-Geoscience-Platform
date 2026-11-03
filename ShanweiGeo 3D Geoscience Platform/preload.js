// ============================================================
// preload.js, the safe bridge layer
// expose a restricted Electron API to the renderer through contextBridge
// the renderer cannot reach Node.js directly and can only use the interfaces exposed here
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
  // get the application version
  getVersion: () => process.versions.electron,

  // detect whether the code runs in Electron
  isElectron: true,

  // the platform information
  platform: process.platform,

  // read a local file over IPC, a fallback for when the app:// protocol is not enough
  readFile: (relativePath) => ipcRenderer.invoke('read-file', relativePath),

  // the save file dialog
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),

  // the open file dialog, for project files
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),

  // read a file at any path (returns { ok, data (base64), error })
  readProjectFile: (filePath) => ipcRenderer.invoke('read-project-file', filePath),

  // get the stat of a file at any path (returns { ok, size, mtimeMs, error }, used to decide whether the geometry cache hits)
  statProjectFile: (filePath) => ipcRenderer.invoke('stat-project-file', filePath),

  // write a file at any path (returns { ok, error })
  writeProjectFile: (filePath, content) => ipcRenderer.invoke('write-project-file', filePath, content),

  // automatic session memory: write, read and clear the fixed session draft (userData/shanwei-session.json)
  saveSession: (content) => ipcRenderer.invoke('session-save', content),
  readSession: () => ipcRenderer.invoke('session-read'),
  clearSession: () => ipcRenderer.invoke('session-clear'),

  // ask before closing: when the main process intercepts the window close it notifies the renderer, which shows the save prompt
  onCloseRequest: (callback) => {
    ipcRenderer.on('window-close-request', () => callback());
  },

  // allow the close: called once the renderer has decided to save or not, and it really closes the window
  allowClose: () => ipcRenderer.send('allow-close'),

  // open an external link
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // ===== development infrastructure =====

  // hot reload: reload the current page (called after a code change, to verify the automatic refresh)
  refreshApp: () => ipcRenderer.send('refresh-app'),

  // get the application state, for diagnostics
  getAppState: () => ipcRenderer.invoke('get-app-state')
});
