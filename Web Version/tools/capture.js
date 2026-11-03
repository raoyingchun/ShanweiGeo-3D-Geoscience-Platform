/*
 * capture.js - import a real model through the application and screenshot it.
 *
 * Usage: node capture.js <url> <outfile>
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const OUT = process.argv[3] || path.join(os.tmpdir(), 'capture.png');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9231;
function getJson(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = path.join(os.tmpdir(), 'cap_profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--hide-scrollbars', '--window-size=1600,1000',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, URL_ARG],
    { stdio: 'ignore' });
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
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    await sleep(8000);

    // right-click the orebody category so pendingCategoryItem is set
    await evaluate(`(() => {
      const root = document.getElementById('subitems-3d-model');
      const node = root && root.querySelector('.lp-sub-item.has-children[data-category]');
      if (!node) return false;
      const r = node.getBoundingClientRect();
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
        clientX: r.left + 10, clientY: r.top + 10 }));
      return true;
    })()`);
    await sleep(900);

    const info = await evaluate(`(async () => {
      const base = location.origin + '/Sample%20Data/3D%20Models/Tunnel%20Models/';
      const text = await (await fetch(base + 'simulated_1_1_surrounding_tunnels.ts')).text();
      const geo = parseGOCADTS(text);
      geo.source = { fileName: 'simulated_1_1_surrounding_tunnels.ts' };
      const m = loadModelToScene(geo, '3D Tunnel Models', 'simulated_1_1_surrounding_tunnels.ts', {});
      return { id: m ? m.id : null, tris: geo.indices.length / 3 };
    })()`);
    console.log('imported: ' + JSON.stringify(info));

    // let the render loop settle
    await sleep(6000);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
      console.log('screenshot: ' + OUT + '  (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
    } else {
      console.log('no screenshot data');
    }
    ws.close();
  } catch (e) { console.error('ERR: ' + e.message); }
  finally { chrome.kill(); }
})();
