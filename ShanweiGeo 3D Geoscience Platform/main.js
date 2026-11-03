// ============================================================
// Electron main process
// Core strategy: register the app:// custom protocol so that fetch, <img src> and <script src> in the renderer resolve to local files under src/, which is what makes the index8.html dynamic migration work.
// The relative paths map automatically onto the local files in the src directory, so index8.html migrates without a single change.
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

// Relax the Chromium limits (large images, GPU surfaces, memory)
app.commandLine.appendSwitch('disable-gpu-surface-limit');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// Allow local file loads to bypass CORS (a fallback for the file:// scenario)
app.commandLine.appendSwitch('disable-web-security');
// Disable the Chromium sandbox (a desktop application does not need it, and in some environments it prevents the application from starting)
app.commandLine.appendSwitch('no-sandbox');
// ------------------------------------------------------------
// Hardware acceleration policy (corrected in section 78 on 2026-09-28)
// This used to call app.disableHardwareAcceleration() unconditionally, motivated by
// repeated GPU process crashes during headless command-line tests. The cost was that
// everyday use always ran in software rendering: the frame rate in 3D scenes dropped very
// low, the main thread was occupied by rendering, and the input method pre-edit could not
// be committed (appearing as "during rename you can only delete, not type"), with the
// whole application lagging.
// It is now: hardware acceleration is enabled by default and disabled only when --sw is
// passed explicitly (or SHANWEI_SW_RENDER=1 is set), for automated tests and for graphics
// compatibility mode.
// ------------------------------------------------------------
const SOFTWARE_RENDER = process.argv.includes('--sw') || process.env.SHANWEI_SW_RENDER === '1';
if (SOFTWARE_RENDER) {
  app.disableHardwareAcceleration();
  console.log('[Electron] Rendering mode: Software rendering (--sw / SHANWEI_SW_RENDER=1) ');
} else {
  console.log('[Electron] Rendering mode: Hardware acceleration (GPU) ');
}

// Redirect the user data directory into the project (avoids AppData\Roaming permission problems)
const USER_DATA_DIR = path.join(__dirname, 'userData');
const CACHE_DIR = path.join(__dirname, 'cache');
const writableUserData = app.isPackaged ? path.join(app.getPath('appData'), 'ShanweiGeo-English', 'userData') : USER_DATA_DIR;
const writableCache = app.isPackaged ? path.join(app.getPath('appData'), 'ShanweiGeo-English', 'cache') : CACHE_DIR;
fs.mkdirSync(writableUserData, { recursive: true });
fs.mkdirSync(writableCache, { recursive: true });
app.setPath('userData', writableUserData);
app.setPath('cache', writableCache);
// Keep the COORD directory on the Python side consistent with the main process: userData/tools/COORD
pythonManager.coordDir = path.join(writableUserData, 'tools', 'COORD');
if(app.isPackaged)app.setAppLogsPath(path.join(app.getPath('appData'),'ShanweiGeo-English','logs'));
else app.setAppLogsPath(path.join(__dirname, 'logs'));

// Locate the original COORD executable.
// Priority: the SHANWEI_COORD_DIR environment variable, then userData/tools/COORD (the
// same for the packaged and development builds), then the local installation directory in
// a development environment. No absolute path is hard-coded in the source, so the build
// does not break after release.
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
    try{ if(candidate&&fs.existsSync(candidate)&&fs.statSync(candidate).isFile())return candidate; }catch(error){ /* ignore an invalid candidate*/ }
  }
  return null;
}

// the scheme has to be registered before app.ready, otherwise the fetch API is unavailable
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

// the application source directory, where index8.html and every asset live
const SRC_DIR = path.join(__dirname, 'src');

// the MIME type mapping
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
// the flag that permits the window to close: it is set to true once the renderer has decided to save or not, which lets the close go through
// (the close is intercepted, the renderer is asked, and only then is the window closed, so that unsaved work is not lost)
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

  // load the main page through the app:// protocol, where the relative paths resolve to app://local/xxx automatically
  // 2026-09-08, the index8 branch was created: the desktop main page moved up from index7 to index8, with the OBJ import as the new main line and index7 kept as a fallback
  mainWindow.loadURL('app://local/index8.html');
  const ownerId = mainWindow.webContents.id;
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) pythonManager.cancelOwner(ownerId);
  });
  mainWindow.webContents.on('destroyed', () => pythonManager.cancelOwner(ownerId));

  // the page load log, used to verify that the migration worked
  mainWindow.webContents.on('did-start-loading', () => {
    console.log('[Electron] Page loading started...');
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Electron] Page loaded ✓');
    // only in development mode, that is with the --dev argument, a functional diagnostic including the large figure decoding test runs automatically after five seconds; it never runs in production
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

  // open the DevTools in development mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // intercept the external links and open them in the system browser
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

  // ask whether to save the project before closing (the close is intercepted and the renderer is notified so that it can show the dialog)
  mainWindow.on('close', (e) => {
    if (!allowClose) {
      e.preventDefault();
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-close-request');
      }
    }
  });
}

// register the app:// protocol handler
function registerAppProtocol() {
  // the image scaling cache, which avoids processing the same image twice
  const imageResizeCache = new Map();
  // the Chromium image pixel limit, about 128 million pixels, with a margin so 100 million is used
  const MAX_IMAGE_PIXELS = 100000000;

  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      let relativePath = url.pathname;
      // Windows path correction: remove the leading slash
      if (process.platform === 'win32' && relativePath.startsWith('/')) {
        relativePath = relativePath.slice(1);
      }
      // decode the URL encoding, which matters for Chinese file names
      relativePath = decodeURIComponent(relativePath);

      // prevent a path traversal attack
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

      // if it is an image file, check whether it has to be scaled down
      if (imgExts.indexOf(ext.toLowerCase()) !== -1) {
        // check the cache
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
            // the limit is exceeded so it has to be scaled down
            const scale = Math.sqrt(MAX_IMAGE_PIXELS / pixelCount);
            const newWidth = Math.floor(metadata.width * scale);
            const newHeight = Math.floor(metadata.height * scale);

            console.log(`[Image scaling] ${relativePath}: ${metadata.width}x${metadata.height} (${Math.round(pixelCount/1000000)}M px) → ${newWidth}x${newHeight}`);

            const resizedBuffer = await sharp(fullPath, { limitInputPixels: false })
              .resize(newWidth, newHeight, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 85 })
              .toBuffer();

            // cache the scaled down image
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
          // if sharp fails, the original image is returned anyway
        }
      }

      // read the file and return it
      const buffer = fs.readFileSync(fullPath);
      const headers = {
        'Content-Type': getMimeType(ext),
        'Content-Length': String(buffer.length),
        'Access-Control-Allow-Origin': '*',
        // 2026-09-09 fix: the HTTP cache is disabled, so that after an overwrite upgrade, for example when xlsx.full.min.js is replaced by the official
        // the old response in userData/Cache is not still matched and the runtime loads the old parser
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
// a development file watcher that refreshes the page automatically when a file changes
// a change in the renderer layer, that is src/index8.html or preload.js, triggers an automatic reload
// a change in the main process main.js prints a notice, because the application has to be restarted
// Windows support: fs.watch for the events together with fs.watchFile for the stat polling, so that one covers the other
// ============================================================
function setupFileWatcher() {
  const watchList = [
    { file: path.join(__dirname, 'src', 'index8.html'), reload: true,  desc: 'Main page index8.html' },
    { file: path.join(__dirname, 'main.js'),                       reload: false, desc: 'Main process main.js (Restart required) ' },
    { file: path.join(__dirname, 'preload.js'),                    reload: true,  desc: 'preload.js' }
  ];

  // a debounce timer, so that saving in the editor does not trigger it several times
  const debounceTimers = new Map();
  // keep the last mtime and size so that it is not triggered again
  const lastSignatures = new Map();

  function getFileSignature(file) {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}_${st.size}`;
    } catch (_) { return null; }
  }

  function handleChange(file, reload, desc, source) {
    // the signature check only triggers when something really changed
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
    // initialise the signature
    lastSignatures.set(file, getFileSignature(file));

    try {
      // method 1: fs.watch for the events, with persistent set to true so the watch keeps running
      fs.watch(file, { persistent: true }, (eventType, filename) => {
        handleChange(file, reload, desc, `fs.watch:${eventType}:${filename || '-'}`);
      });
      // method 2: watch the parent directory as well, to handle an editor that writes a temporary file and then replaces it
      const parentDir = path.dirname(file);
      const baseName = path.basename(file);
      fs.watch(parentDir, { persistent: true }, (eventType, filename) => {
        if (filename && filename === baseName) {
          handleChange(file, reload, desc, `dir.watch:${eventType}:${filename}`);
        }
      });
      // method 3: fs.watchFile polling the stat as a fallback, at an interval of 800 ms, which is more reliable on Windows
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


// the IPC handlers, which answer the interfaces that preload.js exposes
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
  // read a local file, a fallback
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

  // the save file dialog
  ipcMain.handle('show-save-dialog', async (event, options) => {
    const result = await dialog.showSaveDialog(mainWindow, options);
    return result;
  });

  // the open file dialog, for opening a project file
  ipcMain.handle('show-open-dialog', async (event, options) => {
    const result = await dialog.showOpenDialog(mainWindow, options);
    return result;
  });

  // read a file at any path, used to load the original data files by path when a project is opened
  // return a base64 string, which transports binary data safely inside JSON
  ipcMain.handle('read-project-file', async (event, filePath) => {
    try {
      if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'Path is empty' };
      const buffer = fs.readFileSync(filePath);
      return { ok: true, data: buffer.toString('base64') };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // get the stat information of a file at any path, used to decide whether the geometry cache hits by checking whether the source file has changed
  ipcMain.handle('stat-project-file', async (event, filePath) => {
    try {
      if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'Path is empty' };
      const st = fs.statSync(filePath);
      return { ok: true, size: st.size, mtimeMs: st.mtimeMs };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // write a file at any path, used to save the project file as UTF-8 text
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

  // the session draft always goes to a fixed file under userData, so the user never has to choose a path
  const SESSION_FILE = path.join(USER_DATA_DIR, 'shanwei-session.json');

  // write the session draft, whose content is the JSON string produced by serializeProject() in the renderer
  ipcMain.handle('session-save', (event, content) => {
    try {
      if (typeof content !== 'string' || !content) return { ok: false, error: 'Content is empty' };
      fs.writeFileSync(SESSION_FILE, content, 'utf8');
      return { ok: true, path: SESSION_FILE };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // read the session draft, returning { ok: true, data: null } when it does not exist
  ipcMain.handle('session-read', () => {
    try {
      if (!fs.existsSync(SESSION_FILE)) return { ok: true, data: null };
      const content = fs.readFileSync(SESSION_FILE, 'utf8');
      return { ok: true, data: content || null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // delete the session draft, called when the user cancels the restore or creates a project, so that the next start does not wrongly restore it
  ipcMain.handle('session-clear', () => {
    try {
      if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // allow the window to close, called once the renderer has decided to save or not
  ipcMain.on('allow-close', () => {
    allowClose = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });

  // open an external link
  ipcMain.on('open-external', (event, url) => {
    shell.openExternal(url);
  });

  // ===== development infrastructure =====

  // hot reload: reload the current page, called automatically after a code change to verify the refresh
  ipcMain.on('refresh-app', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log('[Live reload] Reload page...');
      // clear the sharp image cache so that a reload reads the images again, which makes it easy to test the image handling changes
      if (protocol) {
        // the cache at the protocol layer cannot be cleared directly, so a forced reload is enough here
      }
      mainWindow.reload();
    }
  });

  // get the current application state, for diagnostics
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

// the global error handling
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
// the automatic diagnostic checks whether the functional modules of the page are working
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

    // test the image loading by fetching a local image through the app:// protocol
    await testImageLoading(win);
  } catch (err) {
    console.error('[Diagnostics failed]', err.message);
  }
}

// test the image loading
async function testImageLoading(win) {
  console.log('========== Starting image loading test ==========');
  const imgScript = `
    (async function() {
      const results = {};
      // test that fetch loads an image file
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

      // test whether the openDrawingInNewTab function exists
      results.openDrawingInNewTabExists = typeof openDrawingInNewTab === 'function';

      // test the state.drawings state
      results.stateDrawingsKeys = (state && state.drawings) ? Object.keys(state.drawings) : [];

      // test the figure node
      const drawingNodes = document.querySelectorAll('[data-drawing-id]');
      results.drawingNodeDetails = Array.from(drawingNodes).map(n => ({
        id: n.getAttribute('data-drawing-id'),
        path: n.getAttribute('data-drawing-path'),
        name: n.querySelector('span') ? n.querySelector('span').textContent.trim() : ''
      }));

      // try to call openDrawingInNewTab to load the first image
      if (drawingNodes.length > 0 && typeof openDrawingInNewTab === 'function') {
        try {
          results.openDrawingCall = '正在调用 openDrawingInNewTab...';
          openDrawingInNewTab(drawingNodes[0]);
          // wait three seconds for the tab and the image to be created and loaded
          await new Promise(r => setTimeout(r, 3000));
          results.openDrawingResult = '调用成功';
          results.stateDrawingsKeysAfter = (state && state.drawings) ? Object.keys(state.drawings) : [];
          // check whether a new tab was created, whose class name is .center-tab
          const tabs = document.querySelectorAll('.center-tab');
          results.tabCountAfter = tabs.length;
          results.tabNames = Array.from(tabs).map(t => {
            const label = t.querySelector('.center-tab-label');
            return label ? label.textContent.trim() : '';
          }).join(' | ');
          // check the tabViewers map
          results.tabViewersSize = (typeof tabViewers !== 'undefined') ? tabViewers.size : 'undefined';
          // check whether the image viewer exists
          const imgViewer = document.querySelector('.image-viewer-wrap');
          results.imageViewerExists = !!imgViewer;
          // check the img element inside the image tab
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

    // test the display of a very large image, the resource estimate figure
    await testLargeImageDisplay(win);
  } catch (err) {
    console.error('[Image loading test failed]', err.message);
  }
}

// test the display of a very large image
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
