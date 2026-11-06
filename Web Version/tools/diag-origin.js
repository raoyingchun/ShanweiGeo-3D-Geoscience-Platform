/* Work out why the demo models are not visible: compare the model origins. */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9237;
function getJson(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = path.join(os.tmpdir(), 'origindiag');
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

    const origins = await evaluate(`(async () => {
      const out = {};
      const base = 'Sample Data/3D Models/Tunnel Models/';
      const ts = await (await fetch(base + 'simulated_1_1_surrounding_tunnels.ts')).text();
      const g1 = parseGOCADTS(ts);
      out.ts = { origin: g1.fileOrigin, verts: g1.vertices.length / 3,
                 bbox: g1.boundingBox };
      const str = await (await fetch(base + 'tunnel_test.str')).text();
      const dtm = await (await fetch(base + 'tunnel_test.dtm')).text();
      const g2 = parseTunnelModel(str, dtm, 'tunnel_test');
      out.tunnel = { origin: g2.fileOrigin, verts: g2.vertices.length / 3,
                     bbox: g2.boundingBox };
      // the current camera
      out.cam = (typeof camera !== 'undefined') ? {
        pos: [Math.round(camera.position.x), Math.round(camera.position.y), Math.round(camera.position.z)],
        target: (typeof controls !== 'undefined' && controls.target)
          ? [Math.round(controls.target.x), Math.round(controls.target.y), Math.round(controls.target.z)] : null,
        far: camera.far
      } : 'camera not global';
      // scene children count
      out.sceneChildren = (typeof scene !== 'undefined') ? scene.children.length : 'scene not global';
      return out;
    })()`);
    console.log(JSON.stringify(origins, null, 2));

    // what does fitViewToAll do, and does it work here?
    const fit = await evaluate(`(() => {
      const before = { target: null };
      try {
        if (typeof fitViewToAll === 'function') fitViewToAll();
        return { ok: true, type: typeof fitViewToAll };
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    console.log('\nfitViewToAll: ' + JSON.stringify(fit));
    await sleep(2500);

    const after = await evaluate(`(() => ({
      cam: (typeof camera !== 'undefined') ? {
        pos: [Math.round(camera.position.x), Math.round(camera.position.y), Math.round(camera.position.z)],
        far: camera.far
      } : null,
      meshes: (typeof scene !== 'undefined') ? scene.children.filter(c => c.type === 'Mesh').length : -1,
      visible: (typeof scene !== 'undefined') ? scene.children.filter(c => c.type === 'Mesh' && c.visible).length : -1
    }))()`);
    console.log('after fit: ' + JSON.stringify(after));

    ws.close();
  } catch (e) { console.error('ERR: ' + e.message); }
  finally { chrome.kill(); }
})();
