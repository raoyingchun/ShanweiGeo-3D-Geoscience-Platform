/* Check whether the module that binds the file input listener actually ran. */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9228;
function getJson(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = path.join(os.tmpdir(), 'mod_profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--window-size=1600,1000', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, URL_ARG], { stdio: 'ignore' });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) {
      await sleep(500);
      try { const l = await getJson('http://127.0.0.1:' + PORT + '/json/list'); t = l.find(x => x.type === 'page' && x.webSocketDebuggerUrl); } catch (e) {}
    }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let id = 0; const pending = new Map(); const logs = []; const errs = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled')
        logs.push('[' + m.params.type + '] ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errs.push({ url: d.url, line: d.lineNumber, col: d.columnNumber,
                    desc: (d.exception && d.exception.description) || d.text });
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
    await sleep(8000);

    console.log('=== exceptions during load ===');
    if (!errs.length) console.log('  (none)');
    errs.forEach(e => {
      console.log('  ' + (e.desc || '').split('\n')[0]);
      console.log('    at ' + e.url + ':' + (e.line + 1) + ':' + (e.col + 1));
    });

    console.log('\n=== are the app modules fully evaluated? ===');
    const probe = await evaluate(`(() => {
      const names = ['loadModelToScene','parseGOCADTS','parseTunnelModel','updateLegend',
                     'fitViewToAll','selectLayer','buildAxisLabels','showImportProgress',
                     'hideImportLoading','updateRenderOrder','refreshScene'];
      const out = {};
      names.forEach(n => { out[n] = typeof window[n]; });
      return out;
    })()`);
    Object.keys(probe).forEach(k => console.log('  ' + k.padEnd(24) + probe[k]));

    console.log('\n=== does the file input have a listener? ===');
    const li = await evaluate(`(() => {
      const el = document.getElementById('file-input');
      return { exists: !!el, disabled: el ? el.disabled : null,
               accept: el ? el.accept : null, multiple: el ? el.multiple : null };
    })()`);
    console.log('  ' + JSON.stringify(li));

    console.log('\n=== console log tail ===');
    logs.slice(-20).forEach(l => console.log('  ' + l.slice(0, 170)));
    ws.close();
  } catch (e) { console.error('ERR: ' + e.message); }
  finally { chrome.kill(); }
})();
