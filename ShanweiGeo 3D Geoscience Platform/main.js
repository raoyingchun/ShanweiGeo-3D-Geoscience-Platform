// ============================================================
// Electron 主进程
// 核心策略：注册 app:// 自定义协议，让渲染进程的 fetch / <img src> / <script src>
// 等相对路径自动映射到 src/ 目录下的本地文件，实现 index8.html 零改动迁移。
// ============================================================

const { app, BrowserWindow, protocol, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
if(app.isPackaged||process.env.SHANWEI_DESKTOP_LOGS==='1')require('./desktop/file-logs').install(app.isPackaged?path.join(app.getPath('appData'),'ShanweiGeo-English','logs'):path.join(__dirname,'logs'));
const { guardDiagnosticStream } = require('./desktop/stdio-guard');
guardDiagnosticStream(process.stdout);
guardDiagnosticStream(process.stderr);
const { PythonManager } = require('./desktop/python-manager');
const pythonManager = new PythonManager({ root: app.isPackaged ? process.resourcesPath : __dirname, packaged: app.isPackaged });

// 放宽 Chromium 限制（大图 / GPU 表面 / 内存）
app.commandLine.appendSwitch('disable-gpu-surface-limit');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// 允许加载本地文件时绕过 CORS（file:// 场景备用）
app.commandLine.appendSwitch('disable-web-security');
// 禁用 Chromium 沙箱（桌面应用不需要，且某些环境下沙箱会导致启动失败）
app.commandLine.appendSwitch('no-sandbox');
// ------------------------------------------------------------
// 硬件加速策略（2026-09-28 §78 修正）
// 原为无条件 app.disableHardwareAcceleration()，动机是「命令行无头测试时 GPU 进程
// 反复崩溃」。但代价是日常使用全程走软件渲染：三维场景帧率极低 → 主线程被渲染占满
// → 输入法预编辑无法提交（表现为「重命名时只能删除、打不进字」）并整体卡顿。
// 现改为：默认启用硬件加速；仅显式传 --sw（或设 SHANWEI_SW_RENDER=1）时关闭，
// 供自动化测试 / 显卡兼容模式使用。
// ------------------------------------------------------------
const SOFTWARE_RENDER = process.argv.includes('--sw') || process.env.SHANWEI_SW_RENDER === '1';
if (SOFTWARE_RENDER) {
  app.disableHardwareAcceleration();
  console.log('[Electron] Rendering mode: Software rendering (--sw / SHANWEI_SW_RENDER=1) ');
} else {
  console.log('[Electron] Rendering mode: Hardware acceleration (GPU) ');
}

// 将用户数据目录重定向到项目内（避免 AppData\Roaming 权限问题）
const USER_DATA_DIR = path.join(__dirname, 'userData');
const CACHE_DIR = path.join(__dirname, 'cache');
const writableUserData = app.isPackaged ? path.join(app.getPath('appData'), 'ShanweiGeo-English', 'userData') : USER_DATA_DIR;
const writableCache = app.isPackaged ? path.join(app.getPath('appData'), 'ShanweiGeo-English', 'cache') : CACHE_DIR;
fs.mkdirSync(writableUserData, { recursive: true });
fs.mkdirSync(writableCache, { recursive: true });
app.setPath('userData', writableUserData);
app.setPath('cache', writableCache);
// Python 侧的 COORD 目录与主进程保持一致：userData/tools/COORD
pythonManager.coordDir = path.join(writableUserData, 'tools', 'COORD');
if(app.isPackaged)app.setAppLogsPath(path.join(app.getPath('appData'),'ShanweiGeo-English','logs'));
else app.setAppLogsPath(path.join(__dirname, 'logs'));

// 定位原版 COORD 可执行文件。
// 优先级：SHANWEI_COORD_DIR 环境变量 → userData/tools/COORD（打包版与开发版一致）
// → 开发环境下的本机安装目录。不在源码中硬编码绝对路径，避免发布后失效。
function resolveCoordExecutable(){
  const candidates=[];
  const fromEnv=process.env.SHANWEI_COORD_DIR;
  if(fromEnv){
    candidates.push(path.join(fromEnv,'COORD.exe'));
    candidates.push(fromEnv);
  }
  candidates.push(path.join(app.getPath('userData'),'tools','COORD','COORD.exe'));
  candidates.push(path.join(__dirname,'tools','COORD','COORD.exe'));
  for(const candidate of candidates){
    try{ if(candidate&&fs.existsSync(candidate)&&fs.statSync(candidate).isFile())return candidate; }catch(error){ /* 忽略无效候选 */ }
  }
  return null;
}

// 必须在 app.ready 之前注册 scheme，否则 fetch API 不可用
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    bypassCSP: true,
    codeCache: true,
    corsEnabled: true
  }
}]);

// 应用源码目录（index8.html 和所有资源都在这里）
const SRC_DIR = path.join(__dirname, 'src');

// MIME 类型映射
function getMimeType(ext) {
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.jpe': 'image/jpeg',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ts': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.dwg': 'application/octet-stream',
    '.dxf': 'application/octet-stream',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf'
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

let mainWindow = null;
// 窗口关闭许可标记：渲染层确认「保存/不保存」后置 true，放行真正关闭
// （拦截 close → 询问渲染层 → 渲染层决策后再 close，避免未保存丢失）
let allowClose = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    title: 'ShanweiGeo 3D Geoscience Platform',
    backgroundColor: '#ECECEC',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true
    }
  });

  // 通过 app:// 协议加载主页面，相对路径会自动解析为 app://local/xxx
  // 2026-09-08 新建 index8 分支：桌面版主页面由 index7 升级为 index8（OBJ 导入新主线，index7 保留回退）
  mainWindow.loadURL('app://local/index8.html');
  const ownerId = mainWindow.webContents.id;
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) pythonManager.cancelOwner(ownerId);
  });
  mainWindow.webContents.on('destroyed', () => pythonManager.cancelOwner(ownerId));

  // 页面加载日志（用于验证迁移是否成功）
  mainWindow.webContents.on('did-start-loading', () => {
    console.log('[Electron] Page loading started...');
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Electron] Page loaded ✓');
    // 仅开发模式（--dev 参数）下延迟 5 秒自动运行功能诊断（含图件大图解码测试），生产环境不执行
    if (process.argv.includes('--dev')) {
      setTimeout(() => runDiagnostics(mainWindow), 5000);
    }
  });
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[Electron] Page loading failed:', errorCode, errorDescription, validatedURL);
  });
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levelStr = ['LOG', 'WARN', 'ERROR'][level] || 'LOG';
    console.log(`[Page ${levelStr}] ${message}`);
  });

  // 开发模式打开 DevTools
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // 拦截外部链接，用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ★ 关闭前询问是否保存项目（拦截 close → 通知渲染层弹窗询问）
  mainWindow.on('close', (e) => {
    if (!allowClose) {
      e.preventDefault();
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-close-request');
      }
    }
  });
}

// 注册 app:// 协议处理器
function registerAppProtocol() {
  // 图片缩放缓存（避免重复处理）
  const imageResizeCache = new Map();
  // Chromium 图片像素上限（约 1.28 亿像素，留余量用 1 亿）
  const MAX_IMAGE_PIXELS = 100000000;

  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      let relativePath = url.pathname;
      // Windows 路径修正：去掉开头的 /
      if (process.platform === 'win32' && relativePath.startsWith('/')) {
        relativePath = relativePath.slice(1);
      }
      // 解码 URL 编码（中文文件名）
      relativePath = decodeURIComponent(relativePath);

      // 防止路径穿越攻击
      const fullPath = path.resolve(SRC_DIR, relativePath);
      const rel = path.relative(SRC_DIR, fullPath);
      if (rel.startsWith('..')) {
        return new Response('Forbidden', { status: 403 });
      }

      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        return new Response('Directory access forbidden', { status: 403 });
      }

      const ext = path.extname(fullPath);
      const imgExts = ['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tif', '.tiff'];

      // 如果是图片文件，检查是否需要缩小
      if (imgExts.indexOf(ext.toLowerCase()) !== -1) {
        // 检查缓存
        if (imageResizeCache.has(fullPath)) {
          const cached = imageResizeCache.get(fullPath);
          return new Response(new Uint8Array(cached.buffer), {
            status: 200,
            headers: {
              'Content-Type': 'image/jpeg',
              'Content-Length': String(cached.buffer.length),
              'Access-Control-Allow-Origin': '*',
              'X-Image-Resized': 'true',
              'X-Original-Size': cached.originalSize,
              'X-Resized-To': cached.resizedTo
            }
          });
        }

        try {
          const sharp = require('sharp');
          const metadata = await sharp(fullPath, { limitInputPixels: false }).metadata();
          const pixelCount = metadata.width * metadata.height;

          if (pixelCount > MAX_IMAGE_PIXELS) {
            // 超过限制，需要缩小
            const scale = Math.sqrt(MAX_IMAGE_PIXELS / pixelCount);
            const newWidth = Math.floor(metadata.width * scale);
            const newHeight = Math.floor(metadata.height * scale);

            console.log(`[Image scaling] ${relativePath}: ${metadata.width}x${metadata.height} (${Math.round(pixelCount/1000000)}M px) → ${newWidth}x${newHeight}`);

            const resizedBuffer = await sharp(fullPath, { limitInputPixels: false })
              .resize(newWidth, newHeight, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 85 })
              .toBuffer();

            // 缓存缩小后的图片
            imageResizeCache.set(fullPath, {
              buffer: resizedBuffer,
              originalSize: metadata.width + 'x' + metadata.height,
              resizedTo: newWidth + 'x' + newHeight
            });

            return new Response(new Uint8Array(resizedBuffer), {
              status: 200,
              headers: {
                'Content-Type': 'image/jpeg',
                'Content-Length': String(resizedBuffer.length),
                'Access-Control-Allow-Origin': '*',
                'X-Image-Resized': 'true',
                'X-Original-Size': metadata.width + 'x' + metadata.height,
                'X-Resized-To': newWidth + 'x' + newHeight
              }
            });
          }
        } catch (sharpErr) {
          console.warn('[Image processing] sharp Processing failed, Use original image:', sharpErr.message);
          // sharp 处理失败，继续返回原图
        }
      }

      // 读取文件并返回
      const buffer = fs.readFileSync(fullPath);
      const headers = {
        'Content-Type': getMimeType(ext),
        'Content-Length': String(buffer.length),
        'Access-Control-Allow-Origin': '*',
        // 2026-09-09 修复：禁用 HTTP 缓存，避免覆盖升级后（如 xlsx.full.min.js 换成官方 SheetJS）
        // 仍被 userData/Cache 中的旧响应命中，导致运行时加载旧版解析器
        'Cache-Control': 'no-store'
      };

      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers
      });
    } catch (err) {
      console.error('[app://] Loading failed:', request.url, err.message);
      return new Response('File not found: ' + request.url, { status: 404 });
    }
  });
}

app.whenReady().then(() => {
  registerAppProtocol();
  registerIpcHandlers();
  if(!app.isPackaged)setupFileWatcher();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// ============================================================
// 开发文件监听：检测到文件改动后自动刷新页面
// 渲染层（src/index8.html、preload.js）改动 → 自动 reload
// 主进程 main.js 改动 → 打印提示（需重启应用）
// Windows 适配：fs.watch(事件驱动) + fs.watchFile(stat 轮询) 双保险
// ============================================================
function setupFileWatcher() {
  const watchList = [
    { file: path.join(__dirname, 'src', 'index8.html'), reload: true,  desc: 'Main page index8.html' },
    { file: path.join(__dirname, 'main.js'),                       reload: false, desc: 'Main process main.js (Restart required) ' },
    { file: path.join(__dirname, 'preload.js'),                    reload: true,  desc: 'preload.js' }
  ];

  // 防抖计时器（避免编辑器保存时的多次触发）
  const debounceTimers = new Map();
  // 记录最后一次 mtime+size，避免重复触发
  const lastSignatures = new Map();

  function getFileSignature(file) {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}_${st.size}`;
    } catch (_) { return null; }
  }

  function handleChange(file, reload, desc, source) {
    // 签名校验：只有真的变化了才触发
    const sig = getFileSignature(file);
    const last = lastSignatures.get(file);
    if (sig && sig === last) return;
    if (sig) lastSignatures.set(file, sig);

    if (debounceTimers.has(file)) clearTimeout(debounceTimers.get(file));
    debounceTimers.set(file, setTimeout(() => {
      debounceTimers.delete(file);
      console.log(`\n[File watcher] Changes detected: ${desc} (Source:${source})`);
      if (reload) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          console.log('[File watcher] Refresh page automatically...');
          mainWindow.reload();
        } else {
          console.log('[File watcher] Window does not exist, Refresh skipped');
        }
      } else {
        console.log('[File watcher] ⚠️  The main process file has changed, Restart the desktop application to apply the changes. ');
      }
    }, 400));
  }

  watchList.forEach(({ file, reload, desc }) => {
    if (!fs.existsSync(file)) {
      console.warn(`[File watcher] Skip missing files: ${file}`);
      return;
    }
    // 初始化签名
    lastSignatures.set(file, getFileSignature(file));

    try {
      // 方法 1：fs.watch 事件驱动（persistent: true 保证持续监听）
      fs.watch(file, { persistent: true }, (eventType, filename) => {
        handleChange(file, reload, desc, `fs.watch:${eventType}:${filename || '-'}`);
      });
      // 方法 2：同时监听父目录（应对编辑器"写临时文件→替换"策略）
      const parentDir = path.dirname(file);
      const baseName = path.basename(file);
      fs.watch(parentDir, { persistent: true }, (eventType, filename) => {
        if (filename && filename === baseName) {
          handleChange(file, reload, desc, `dir.watch:${eventType}:${filename}`);
        }
      });
      // 方法 3：fs.watchFile stat 轮询兜底（800ms 间隔，Windows 下更稳）
      fs.watchFile(file, { persistent: true, interval: 800 }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
          handleChange(file, reload, desc, `watchFile:mtime`);
        }
      });
      console.log(`[File watcher] Started: ${desc}`);
    } catch (err) {
      console.error(`[File watcher] Startup failed ${desc}:`, err.message);
    }
  });
}


// IPC 处理器：响应 preload.js 暴露的接口
function registerIpcHandlers() {
  function assertPythonSender(event) {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== 'app://local/index8.html') throw new Error('This computation request origin is not allowed');
  }
  for(const [channel,handler] of Object.entries({
    'materials:list':()=>require('./desktop/custom-materials').list(app.getPath('userData')),
    'materials:import':payload=>require('./desktop/custom-materials').importImage(app.getPath('userData'),payload),
    'materials:read':id=>require('./desktop/custom-materials').read(app.getPath('userData'),id),
    'materials:delete':id=>require('./desktop/custom-materials').remove(app.getPath('userData'),id)
  }))ipcMain.handle(channel,async(event,payload)=>{try{assertPythonSender(event);return {ok:true,data:await handler(payload)};}catch(error){return {ok:false,error:error.message};}});
  ipcMain.handle('images:tiff-preview', async (event, bytes) => {
    try {
      assertPythonSender(event);
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 512 * 1024 * 1024) throw new Error('TIFF The file is empty or exceeds 512MB Preview limit');
      const data = await require('sharp')(Buffer.from(bytes), { limitInputPixels: false })
        .resize(8192, 8192, { fit: 'inside', withoutEnlargement: true })
        .png().toBuffer();
      return { ok: true, data: new Uint8Array(data) };
    } catch (error) { return { ok: false, error: 'TIFF Preview decoding failed:  ' + error.message }; }
  });
  ipcMain.handle('images:preprocess', async (event, options) => {
    try {
      assertPythonSender(event);
      return await require('./desktop/image-preprocessor').preprocess(options.filePath,options.quality,options.gpuLimit,path.join(app.getPath('userData'),'image-preview-cache'));
    } catch(error) { return {ok:false,error:'Image preprocessing failed:  '+error.message}; }
  });
  ipcMain.handle('notes:read', (event, identity) => {
    try { assertPythonSender(event); return require('./desktop/document-notes').read(app.getPath('userData'),identity); }
    catch(error) { return {ok:false,error:error.message}; }
  });
  function saveDocumentNotes(event,payload) {
    try { assertPythonSender(event); return require('./desktop/document-notes').write(app.getPath('userData'),payload); }
    catch(error) { return {ok:false,error:error.message}; }
  }
  ipcMain.handle('notes:save',saveDocumentNotes);
  ipcMain.on('notes:flush',(event,payload)=>{event.returnValue=saveDocumentNotes(event,payload);});
  ipcMain.handle('python:run', (event, request) => {
    try {
      assertPythonSender(event);
      if (['model.parse','block.parse','terrain.parse'].includes(request?.method)) request = { ...request, params: { ...request.params, outputDir: path.join(app.getPath('userData'), 'geometry-cache') } };
      const sender = event.sender;
      const result = pythonManager.start(request, sender.id, message => {
        if (!sender.isDestroyed()) sender.send('python:event', message);
      });
      return { ok: true, ...result };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('models:read-geometry', async (event, key) => {
    try {
      assertPythonSender(event);
      if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid model cache ID');
      const directory = path.join(app.getPath('userData'), 'geometry-cache');
      const [vertices, indices] = await Promise.all(['vertices','indices'].map(kind => fs.promises.readFile(path.join(directory,key+'.'+kind+'.bin'))));
      const edgeFile=path.join(directory,key+'.edges.bin');
      const edges=fs.existsSync(edgeFile)?new Uint8Array(await fs.promises.readFile(edgeFile)):null;
      return { ok:true, vertices:new Uint8Array(vertices), indices:new Uint8Array(indices),edges };
    } catch (error) { return { ok:false, error:error.message }; }
  });
  ipcMain.handle('blocks:read-data', async (event, key) => {
    try {
      assertPythonSender(event);
      if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid block cache ID');
      const directory = path.join(app.getPath('userData'), 'geometry-cache');
      const [matrices,chunks] = await Promise.all(['matrices','chunks'].map(kind=>fs.promises.readFile(path.join(directory,key+'.'+kind+'.bin'))));
      return {ok:true,matrices:new Uint8Array(matrices),chunks:new Uint8Array(chunks)};
    } catch(error) { return {ok:false,error:error.message}; }
  });
  ipcMain.handle('python:cancel', (event, taskId) => {
    try {
      assertPythonSender(event);
      return { ok: true, cancelled: pythonManager.cancel(taskId, event.sender.id) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  // Fixed local legacy tool entry; the renderer cannot choose an executable.
  ipcMain.handle('utilities:open-coord', async event => {
    try {
      assertPythonSender(event);
      const executable = resolveCoordExecutable();
      if (!executable || !fs.existsSync(executable)) throw new Error('Original COORD The application is not in the specified folder');
      await new Promise((resolve, reject) => {
        const child = require('child_process').spawn(executable, [], {
          cwd: path.dirname(executable), shell: false, detached: true, stdio: 'ignore', windowsHide: false
        });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      });
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  // 读取本地文件（备用方案）
  ipcMain.handle('read-file', (event, relativePath) => {
    try {
      const fullPath = path.resolve(SRC_DIR, relativePath);
      const rel = path.relative(SRC_DIR, fullPath);
      if (rel.startsWith('..')) return { error: 'Forbidden' };
      const buffer = fs.readFileSync(fullPath);
      return { data: new Uint8Array(buffer) };
    } catch (err) {
      return { error: err.message };
    }
  });

  // 保存文件对话框
  ipcMain.handle('show-save-dialog', async (event, options) => {
    const result = await dialog.showSaveDialog(mainWindow, options);
    return result;
  });

  // 打开文件对话框（项目文件打开）
  ipcMain.handle('show-open-dialog', async (event, options) => {
    const result = await dialog.showOpenDialog(mainWindow, options);
    return result;
  });

  // 读取任意路径文件（打开项目时按路径加载原始数据文件）
  // 返回 base64 字符串（JSON 安全传输二进制）
  ipcMain.handle('read-project-file', async (event, filePath) => {
    try {
      if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'Path is empty' };
      const buffer = fs.readFileSync(filePath);
      return { ok: true, data: buffer.toString('base64') };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 获取任意路径文件的 stat 信息（几何缓存命中判定用：校验源文件是否被改过）
  ipcMain.handle('stat-project-file', async (event, filePath) => {
    try {
      if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'Path is empty' };
      const st = fs.statSync(filePath);
      return { ok: true, size: st.size, mtimeMs: st.mtimeMs };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 写入任意路径文件（保存项目文件，UTF-8 文本）
  ipcMain.handle('write-project-file', async (event, filePath, content) => {
    try {
      if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'Path is empty' };
      if (typeof content !== 'string') return { ok: false, error: 'Content is empty' };
      fs.writeFileSync(filePath, content, 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 现场草稿固定写到 userData 下的固定文件，无需用户选择路径
  const SESSION_FILE = path.join(USER_DATA_DIR, 'shanwei-session.json');

  // 写入会话草稿（内容是渲染层 serializeProject() 的 JSON 字符串）
  ipcMain.handle('session-save', (event, content) => {
    try {
      if (typeof content !== 'string' || !content) return { ok: false, error: 'Content is empty' };
      fs.writeFileSync(SESSION_FILE, content, 'utf8');
      return { ok: true, path: SESSION_FILE };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 读取会话草稿（不存在时返回 { ok:true, data:null }）
  ipcMain.handle('session-read', () => {
    try {
      if (!fs.existsSync(SESSION_FILE)) return { ok: true, data: null };
      const content = fs.readFileSync(SESSION_FILE, 'utf8');
      return { ok: true, data: content || null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 删除会话草稿（用户取消恢复 / 新建项目后调用，避免下次启动误恢复）
  ipcMain.handle('session-clear', () => {
    try {
      if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 允许窗口关闭（渲染进程完成「保存/不保存」决策后调用）
  ipcMain.on('allow-close', () => {
    allowClose = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });

  // 打开外部链接
  ipcMain.on('open-external', (event, url) => {
    shell.openExternal(url);
  });

  // ===== 开发基础设施 =====

  // 热刷新：重新加载当前页面（修改代码后自动调用此接口刷新验证）
  ipcMain.on('refresh-app', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log('[Live reload] Reload page...');
      // 清空 sharp 图片缓存（重新加载时重新读取，便于测试图片处理改动）
      if (protocol) {
        // 协议层缓存无法直接清空，这里强制重新加载即可
      }
      mainWindow.reload();
    }
  });

  // 获取当前应用状态（诊断用）
  ipcMain.handle('get-app-state', () => {
    return {
      userDataDir: app.getPath('userData'),
      cacheDir: app.getPath('cache'),
      srcDir: SRC_DIR,
      platform: process.platform,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node
    };
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 全局错误处理
let pythonShutdownComplete = false;
let pythonShutdownPending = false;
app.on('before-quit', event => {
  if (pythonShutdownComplete || pythonManager.tasks.size === 0) return;
  event.preventDefault();
  if (pythonShutdownPending) return;
  pythonShutdownPending = true;
  pythonManager.shutdown().finally(() => { pythonShutdownComplete = true; app.quit(); });
});

process.on('uncaughtException', (err) => {
  console.error('Unhandled exception:', err);
  dialog.showErrorBox('Application error', err.message);
});

// ============================================================
// 自动诊断：检查页面各功能模块是否正常
// ============================================================
async function runDiagnostics(win) {
  console.log('\n========== Starting diagnostics ==========');
  const script = `
    (function() {
      const results = {};

      // 1. Check state Object
      try {
        results.stateExists = typeof state !== 'undefined';
        results.modelsCount = (state && state.models) ? state.models.length : 0;
        results.modelsInScene = (state && state.models) ? state.models.filter(m => m.inScene).length : 0;
        results.modelNames = (state && state.models) ? state.models.map(m => m.name).join(', ') : '';
      } catch(e) { results.stateError = e.message; }

      // 2. Check Three.js Scene
      try {
        results.sceneExists = typeof scene !== 'undefined' && scene !== null;
        results.sceneChildren = (scene) ? scene.children.length : 0;
        results.rendererExists = typeof renderer !== 'undefined' && renderer !== null;
        results.cameraExists = typeof camera !== 'undefined' && camera !== null;
      } catch(e) { results.sceneError = e.message; }

      // 3. Check DOM Element
      results.domElements = {
        'Project tree': !!document.getElementById('project-tree') || !!document.querySelector('.project-tree'),
        'Toolbar': !!document.querySelector('.toolbar') || !!document.getElementById('toolbar'),
        'Tab bar': !!document.querySelector('.tab-bar') || !!document.getElementById('tab-bar'),
        '3D canvas': !!document.getElementById('three-canvas') || !!document.querySelector('canvas'),
        'Layers': !!document.querySelector('.layer-management') || !!document.getElementById('layer-mgmt'),
        'Properties': !!document.querySelector('.property-panel') || !!document.getElementById('prop-panel'),
        'Link button': !!document.querySelector('.linkage-btn') || !!document.getElementById('linkage-btn')
      };

      // 4. Check map nodes
      try {
        const drawingNodes = document.querySelectorAll('[data-drawing-id]');
        results.drawingNodesCount = drawingNodes.length;
        results.drawingNodeNames = Array.from(drawingNodes).map(n => {
          const span = n.querySelector('span');
          return span ? span.textContent.trim() : n.textContent.trim().substring(0, 20);
        }).join(' | ');
      } catch(e) { results.drawingError = e.message; }

      // 5. Check Toolbar button
      try {
        const toolButtons = document.querySelectorAll('.tool-btn');
        results.toolButtonCount = toolButtons.length;
        results.toolButtonTexts = Array.from(toolButtons).map(b => b.textContent.trim()).join(' ');
      } catch(e) { results.toolError = e.message; }

      // 6. Check Electron Environment
      results.isElectron = !!(window.electronAPI && window.electronAPI.isElectron);
      results.electronVersion = results.isElectron ? window.electronAPI.getVersion() : 'N/A';

      // 7. Check canvas Dimensions
      const canvas = document.querySelector('canvas');
      if (canvas) {
        results.canvasWidth = canvas.width;
        results.canvasHeight = canvas.height;
      }

      // 8. Check Coordinates Axis Bookmark (index7 with state.axisLabelsVisible, index4 with state.axisLabelGroup) 
      try {
        results.axisLabelGroupExists = typeof state !== 'undefined' && (state.axisLabelGroup !== undefined || state.axisLabelsVisible !== undefined);
        results.axisLabelsVisible = (state && state.axisLabelsVisible !== undefined) ? state.axisLabelsVisible : ((state && state.axisLabelGroup) ? state.axisLabelGroup.visible : 'N/A');
      } catch(e) { results.axisError = e.message; }

      return JSON.stringify(results, null, 2);
    })()
  `;

  try {
    const result = await win.webContents.executeJavaScript(script);
    console.log('[Diagnostic results]');
    console.log(result);
    console.log('========== Diagnostics complete ==========\n');

    // 测试图片加载（通过 app:// 协议 fetch 本地图片）
    await testImageLoading(win);
  } catch (err) {
    console.error('[Diagnostics failed]', err.message);
  }
}

// 测试图片加载
async function testImageLoading(win) {
  console.log('========== Starting image loading test ==========');
  const imgScript = `
    (async function() {
      const results = {};
      // 测试 fetch 加载图片文件
      const testFiles = [
        '图件/2千地形地质图.JPG',
        '图件/资源估算图/Ⅱ-1、Ⅲ-1、Ⅵ-1水平投影资源量估算图.JPG'
      ];
      for (const filePath of testFiles) {
        try {
          const response = await fetch(encodeURI(filePath));
          results[filePath] = {
            status: response.status,
            ok: response.ok,
            size: response.headers.get('Content-Length') || 'unknown'
          };
          if (response.ok) {
            const blob = await response.blob();
            results[filePath].blobSize = blob.size;
            results[filePath].blobType = blob.type;
          }
        } catch (err) {
          results[filePath] = { error: err.message };
        }
      }

      // 测试 openDrawingInNewTab 函数是否存在
      results.openDrawingInNewTabExists = typeof openDrawingInNewTab === 'function';

      // 测试 state.drawings 状态
      results.stateDrawingsKeys = (state && state.drawings) ? Object.keys(state.drawings) : [];

      // 测试图件节点
      const drawingNodes = document.querySelectorAll('[data-drawing-id]');
      results.drawingNodeDetails = Array.from(drawingNodes).map(n => ({
        id: n.getAttribute('data-drawing-id'),
        path: n.getAttribute('data-drawing-path'),
        name: n.querySelector('span') ? n.querySelector('span').textContent.trim() : ''
      }));

      // 尝试调用 openDrawingInNewTab 加载第一张图片
      if (drawingNodes.length > 0 && typeof openDrawingInNewTab === 'function') {
        try {
          results.openDrawingCall = '正在调用 openDrawingInNewTab...';
          openDrawingInNewTab(drawingNodes[0]);
          // 等待 3 秒让标签页创建和图片加载
          await new Promise(r => setTimeout(r, 3000));
          results.openDrawingResult = '调用成功';
          results.stateDrawingsKeysAfter = (state && state.drawings) ? Object.keys(state.drawings) : [];
          // 检查是否创建了新标签页（class 名是 .center-tab）
          const tabs = document.querySelectorAll('.center-tab');
          results.tabCountAfter = tabs.length;
          results.tabNames = Array.from(tabs).map(t => {
            const label = t.querySelector('.center-tab-label');
            return label ? label.textContent.trim() : '';
          }).join(' | ');
          // 检查 tabViewers Map
          results.tabViewersSize = (typeof tabViewers !== 'undefined') ? tabViewers.size : 'undefined';
          // 检查图片查看器是否存在
          const imgViewer = document.querySelector('.image-viewer-wrap');
          results.imageViewerExists = !!imgViewer;
          // 检查图片标签中的 img 元素
          const imgEl = imgViewer ? imgViewer.querySelector('img') : null;
          results.imgElementExists = !!imgEl;
          if (imgEl) {
            results.imgSrc = imgEl.src;
            results.imgNaturalWidth = imgEl.naturalWidth;
            results.imgNaturalHeight = imgEl.naturalHeight;
            results.imgComplete = imgEl.complete;
          }
        } catch (err) {
          results.openDrawingError = err.message;
        }
      }

      return JSON.stringify(results, null, 2);
    })()
  `;

  try {
    const result = await win.webContents.executeJavaScript(imgScript);
    console.log('[Image loading test results]');
    console.log(result);
    console.log('========== Image loading test complete ==========\n');

    // 测试超大图片（资源估算图）显示
    await testLargeImageDisplay(win);
  } catch (err) {
    console.error('[Image loading test failed]', err.message);
  }
}

// 测试超大图片显示
async function testLargeImageDisplay(win) {
  console.log('========== Starting large image test ==========');
  const largeImgScript = `
    (async function() {
      const results = {};
      // Test all 5 images tested for display support
      const drawingNodes = document.querySelectorAll('[data-drawing-id]');
      for (let i = 0; i < drawingNodes.length; i++) {
        const node = drawingNodes[i];
        const name = node.querySelector('span') ? node.querySelector('span').textContent.trim() : 'unknown';
        const path = node.getAttribute('data-drawing-path') || '';
        try {
          // Create a temporary img Check whether the image element can decode the image
          const img = new Image();
          img.src = encodeURI(path);
          await new Promise((resolve, reject) => {
            img.onload = () => resolve(img);
            img.onerror = (e) => reject(new Error('Image decoding failed'));
            setTimeout(() => reject(new Error('Image loading timed out(10s)')), 10000);
          });
          results[name] = {
            path: path,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            pixelCount: img.naturalWidth * img.naturalHeight,
            megapixels: Math.round(img.naturalWidth * img.naturalHeight / 1000000) + 'M',
            canDisplay: true
          };
        } catch (err) {
          results[name] = {
            path: path,
            error: err.message,
            canDisplay: false
          };
        }
      }
      return JSON.stringify(results, null, 2);
    })()
  `;

  try {
    const result = await win.webContents.executeJavaScript(largeImgScript);
    console.log('[Large image test results]');
    console.log(result);
    console.log('========== Large image test complete ==========\n');
  } catch (err) {
    console.error('[Large image test failed]', err.message);
  }
}
