/* Find where the initial tree entries come from at run time. */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9234;
function getJson(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = path.join(os.tmpdir(), 'treeprobe');
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
    await sleep(9000);

    const probe = await evaluate(`(() => {
      const out = {};
      // the visible tree text
      const tree = document.getElementById('lp-tree');
      out.treeText = tree ? tree.innerText.replace(/\\s+/g, ' ').slice(0, 300) : null;

      // the research regions tree
      const rr = document.getElementById('research-regions-tree') || document.querySelector('[id*="research"]');
      out.rrText = rr ? rr.innerText.replace(/\\s+/g, ' ').slice(0, 200) : null;

      // the 3D model container
      const m = document.getElementById('subitems-3d-model');
      out.modelItems = m ? m.querySelectorAll('.lp-sub-item').length : -1;
      out.modelText = m ? m.innerText.replace(/\\s+/g, ' ').slice(0, 200) : null;

      // state
      out.stateKeys = (typeof state !== 'undefined') ? Object.keys(state).slice(0, 30) : 'state not global';
      out.modelCount = (typeof state !== 'undefined' && state.models) ? state.models.length : -1;
      out.hasRegion = !!(typeof researchRegions !== 'undefined');
      return out;
    })()`);
    console.log(JSON.stringify(probe, null, 2));

    // find which script defines the default entries
    const defined = await evaluate(`(() => {
      const hits = [];
      // look through the loaded script text for 'Default Deposit'
      for (const s of document.querySelectorAll('script[src]')) {
        const url = s.getAttribute('src');
        if (!url) continue;
        hits.push(url);
      }
      return hits;
    })()`);
    console.log('\nscripts loaded:');
    defined.forEach(s => console.log('  ' + s));

    ws.close();
  } catch (e) { console.error('ERR: ' + e.message); }
  finally { chrome.kill(); }
})();
