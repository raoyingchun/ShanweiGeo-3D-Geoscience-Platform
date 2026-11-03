/*
 * verify-remote.js - run the published build straight from GitHub.
 *
 * This is the path a reviewer takes: clone or download the repository, open
 * the Web Version folder, start the server and use the application. The test
 * points at the raw.githubusercontent.com files, so it proves the published
 * copy works, not the local one.
 *
 * Usage: node verify-remote.js <rawBase>
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const RAW = process.argv[2] || 'https://raw.githubusercontent.com/raoyingchun/ShanweiGeo-3D-Geoscience-Platform/main/Web%20Version';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9232;
const WEB = path.join(os.tmpdir(), 'shanwei_remote_check');

function getJson(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The published tree, fetched from the GitHub API.
const API = 'https://api.github.com/repos/raoyingchun/ShanweiGeo-3D-Geoscience-Platform/git/trees/main?recursive=1';

(async () => {
  let failures = 0;
  const check = (n, ok, d) => {
    if (!ok) failures++;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (d ? '   ' + d : ''));
  };

  // ---- collect the published Web Version paths ---------------------------
  const tree = await (await fetch(API, { headers: { 'User-Agent': 'check' } })).json();
  const paths = tree.tree.filter(e => e.type === 'blob' && e.path.startsWith('Web Version/'))
    .map(e => e.path.slice('Web Version/'.length));
  console.log('published Web Version files: ' + paths.length + '\n');
  check('the web build is published', paths.length > 200, paths.length + ' files');

  // ---- the files a reviewer needs ---------------------------------------
  const must = ['index8.html', 'three.min.js', 'xlsx.full.min.js', 'README.md',
    'Start-WebApp.bat', 'start-web-app.sh', 'app/web-bridge.js', 'app/web-only.js',
    'app/app_3.js', 'assets/textures/rock-library.json',
    'lib/pdfjs/pdf.min.js',
    'Sample Data/3D Models/Tunnel Models/tunnel_test.str'];
  const set = new Set(paths);
  for (const m of must) check('published: ' + m, set.has(m));

  // ---- the download itself is done by download-remote.py -----------------
  // Node's fetch cannot reach raw.githubusercontent.com on this machine, so the
  // files are fetched by that script first and this script tests the result.
  const resultPath = path.join(WEB, '_download_result.json');
  if (!fs.existsSync(resultPath)) {
    check('the published files were downloaded', false,
          'run download-remote.py first');
  } else {
    const res = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    check('every published file downloads', res.ok === res.expected,
          res.ok + '/' + res.expected);
  }

  // ---- serve the downloaded copy and test it -----------------------------
  const server = spawn('python', ['-m', 'http.server', '8770', '--bind', '127.0.0.1'],
    { cwd: WEB, stdio: 'ignore' });
  await sleep(2500);

  const profile = path.join(os.tmpdir(), 'remote_check_profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--window-size=1600,1000', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, 'http://127.0.0.1:8770/index8.html'],
    { stdio: 'ignore' });

  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) {
      await sleep(500);
      try { const l = await getJson('http://127.0.0.1:' + PORT + '/json/list'); t = l.find(x => x.type === 'page' && x.webSocketDebuggerUrl); } catch (e) {}
    }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let id = 0; const pending = new Map(); const errs = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errs.push((d.exception && d.exception.description) || d.text);
      }
    });
    await new Promise(r => ws.addEventListener('open', r));
    const send = (m, p) => new Promise(resolve => {
      const i = ++id; pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
    const evaluate = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails)
        throw new Error(r.result.exceptionDetails.text + ' ' + ((r.result.exceptionDetails.exception || {}).description || ''));
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await send('Runtime.enable');
    await send('Page.reload', { ignoreCache: true });
    await sleep(8000);

    const state = await evaluate(`(() => ({
      bridge: !!window.electronAPI,
      web: !!window.__shanweiGeoIsWeb,
      title: document.title,
      canvas: !!document.querySelector('canvas'),
      tree: document.querySelectorAll('.lp-sub-item, .lp-group-header').length,
      layers: !!document.querySelector('.lm-title'),
      coord: typeof window.electronAPI.openCoordTool,
      parse: typeof parseGOCADTS
    }))()`);
    check('the downloaded copy runs', !!(state && state.bridge && state.web), JSON.stringify(state));
    check('the 3D canvas is live', !!(state && state.canvas));
    check('the project tree is populated', !!(state && state.tree > 5), state && state.tree + ' items');
    check('COORD is unavailable as expected', state && state.coord === 'undefined');

    // import the published sample model
    const imp = await evaluate(`(async () => {
      const base = location.origin + '/Sample%20Data/3D%20Models/Tunnel%20Models/';
      const text = await (await fetch(base + 'tunnel_test.str')).text();
      const dtm = await (await fetch(base + 'tunnel_test.dtm')).text();
      const geo = parseTunnelModel(text, dtm, 'tunnel_test');
      return { verts: geo.vertices.length / 3, tris: geo.indices.length / 3 };
    })()`);
    check('the published sample model parses', !!(imp && imp.tris > 0),
          imp ? imp.verts + ' verts, ' + imp.tris + ' tris' : '');

    const real = errs.filter(e => !/favicon|ERR_/i.test(e));
    check('no uncaught errors', real.length === 0, real.slice(0, 2).join(' | '));

    ws.close();
  } catch (e) {
    console.error('ERROR: ' + e.message);
    failures++;
  } finally {
    chrome.kill();
    server.kill();
  }

  console.log('\n=== ' + (failures === 0 ? 'the published build works' : failures + ' failed') + ' ===\n');
  process.exit(failures ? 1 : 0);
})();
