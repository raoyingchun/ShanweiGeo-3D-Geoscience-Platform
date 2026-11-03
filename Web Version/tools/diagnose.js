/*
 * diagnose.js - report the exact source of the startup error and check why the
 * GOCAD parser returned no geometry.
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9223;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = path.join(os.tmpdir(), 'diag_profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--window-size=1600,1000', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, URL_ARG], { stdio: 'ignore' });

  try {
    let targets = null;
    for (let i = 0; i < 60 && !targets; i++) {
      await sleep(500);
      try {
        const l = await getJson('http://127.0.0.1:' + PORT + '/json/list');
        targets = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch (e) { /* not up yet */ }
    }
    if (!targets) throw new Error('no devtools target');

    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push({
          text: d.text,
          url: d.url,
          line: d.lineNumber,
          column: d.columnNumber,
          desc: d.exception ? d.exception.description : ''
        });
      }
    });
    await new Promise(r => ws.addEventListener('open', r));
    const send = (method, params) => new Promise(resolve => {
      const i = ++id; pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
    const evaluate = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    await sleep(7000);

    console.log('=== uncaught exceptions ===');
    if (!errors.length) console.log('  (none)');
    errors.forEach(e => {
      console.log('  ' + e.text + '  at ' + e.url + ':' + (e.line + 1) + ':' + (e.column + 1));
      if (e.desc) console.log('    ' + e.desc.split('\n').slice(0, 3).join('\n    '));
    });

    console.log('\n=== GOCAD parser probe ===');
    const probe = await evaluate(`(() => {
      const ts = ['GOCAD TSurf 1','HEADER {','name:probe','}','TFACE',
        'VRTX 1 0 0 0','VRTX 2 100 0 0','VRTX 3 0 100 0','VRTX 4 0 0 100',
        'TRGL 1 2 3','TRGL 1 2 4','TRGL 1 3 4','TRGL 2 3 4','END'].join('\\n');
      let out = { hasFn: typeof parseGOCADTS === 'function' };
      try {
        const geo = parseGOCADTS(ts);
        out.keys = Object.keys(geo || {});
        out.vertices = geo && geo.vertices ? geo.vertices.length : null;
        out.indices = geo && geo.indices ? geo.indices.length : null;
        out.raw = JSON.stringify(geo).slice(0, 400);
      } catch (e) { out.error = e.message; }
      return out;
    })()`);
    console.log('  ' + JSON.stringify(probe, null, 2).split('\n').join('\n  '));

    console.log('\n=== which modules failed to load ===');
    const mods = await evaluate(`(() => {
      const names = ['parseGOCADTS','parseOBJText','parseTunnelModel','parseASCTerrain',
                     'prepareBlockModelAsync','DxfParser','THREE','XLSX','pdfjsLib','docx'];
      const out = {};
      names.forEach(n => { out[n] = typeof window[n]; });
      return out;
    })()`);
    Object.keys(mods).forEach(k => console.log('  ' + k.padEnd(26) + mods[k]));

    ws.close();
  } catch (e) {
    console.error('DIAG ERROR: ' + e.message);
  } finally {
    chrome.kill();
  }
})();
