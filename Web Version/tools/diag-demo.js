/* Diagnose why the demo scene did not attach the models. */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9236;
function getJson(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = path.join(os.tmpdir(), 'demodiag');
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
    let id = 0; const pending = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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
    await sleep(12000);

    const p = await evaluate(`(() => {
      const out = {};
      const root = document.getElementById('subitems-3d-model');
      out.rootExists = !!root;
      out.categories = root ? Array.from(root.querySelectorAll('[data-category]')).map(e => e.getAttribute('data-category')) : [];
      out.anyItems = root ? root.querySelectorAll('.lp-sub-item').length : -1;
      out.allDataCategory = Array.from(document.querySelectorAll('[data-category]')).map(e => e.getAttribute('data-category'));
      out.hasFunction = typeof loadModelToScene === 'function';
      out.parseGOCAD = typeof parseGOCADTS === 'function';
      out.parseTunnel = typeof parseTunnelModel === 'function';

      // can we fetch the sample?
      out.fetchOk = null;
      return out;
    })()`);
    console.log(JSON.stringify(p, null, 2));

    // try the import by hand, step by step
    const manual = await evaluate(`(async () => {
      const log = [];
      try {
        const res = await fetch('Sample Data/3D Models/Tunnel Models/simulated_1_1_surrounding_tunnels.ts');
        log.push('fetch status ' + res.status);
        const text = await res.text();
        log.push('text length ' + text.length);
        const geo = parseGOCADTS(text);
        log.push('parsed verts ' + (geo.vertices ? geo.vertices.length / 3 : 0) + ' tris ' + (geo.indices ? geo.indices.length / 3 : 0));
        log.push('fileOrigin ' + JSON.stringify(geo.fileOrigin));

        // find the category
        const root = document.getElementById('subitems-3d-model');
        const item = root && root.querySelector('[data-category]');
        log.push('category item found: ' + !!item + ' -> ' + (item ? item.getAttribute('data-category') : ''));
        if (item) {
          const wrapper = item.closest('.lp-sub-item.has-children');
          log.push('wrapper found: ' + !!wrapper);
          const rect = item.getBoundingClientRect();
          log.push('rect ' + JSON.stringify({x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width)}));
          item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
            clientX: rect.left + 10, clientY: rect.top + 10 }));
          await new Promise(r => setTimeout(r, 500));
          const menu = document.getElementById('ctx-menu');
          log.push('menu class: ' + (menu ? menu.className : 'none'));
          const ts = document.getElementById('ctx-import-ts');
          log.push('import-ts display: ' + (ts ? getComputedStyle(ts).display : 'missing'));
        }

        geo.source = { fileName: 'simulated_1_1_surrounding_tunnels.ts' };
        const m = loadModelToScene(geo, '3D Tunnel Models', 'simulated_1_1_surrounding_tunnels.ts', {});
        log.push('loadModelToScene -> ' + (m && m.id ? m.id : 'null'));
      } catch (e) {
        log.push('ERROR: ' + e.message);
      }
      return log;
    })()`);
    console.log('\nmanual import trace:');
    manual.forEach(l => console.log('  ' + l));

    await sleep(4000);
    const after = await evaluate(`(() => ({
      layerRows: document.querySelectorAll('.lm-item, .lm-drill-item, .lm-model-item, .lm-row').length,
      layerText: document.querySelector('.lm-list, .lm-items') ? document.querySelector('.lm-list, .lm-items').innerText.replace(/\\s+/g,' ').slice(0,150) : null,
      legend: (document.body.innerText.match(/LEGEND[\\s\\S]{0,120}/) || [''])[0].replace(/\\s+/g,' ')
    }))()`);
    console.log('\nafter manual import:');
    console.log('  ' + JSON.stringify(after, null, 2));

    ws.close();
  } catch (e) { console.error('ERR: ' + e.message); }
  finally { chrome.kill(); }
})();
