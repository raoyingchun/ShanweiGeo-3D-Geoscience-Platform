/* Inspect the model entry so the camera can be framed on it. */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9239;
function getJson(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = path.join(os.tmpdir(), 'modelprobe');
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
    await sleep(16000);

    const probe = await evaluate(`(() => {
      const out = {};
      out.stateVisible = (typeof state !== 'undefined');
      if (typeof state !== 'undefined') {
        out.modelCount = state.models.length;
        out.models = state.models.map(m => ({
          id: m.id, fileName: m.fileName, name: m.name,
          category: m.category, hasMesh: !!m.mesh,
          meshType: m.mesh ? m.mesh.type : null,
          visible: m.mesh ? m.mesh.visible : null
        }));
        out.selectedModelId = state.selectedModelId;
        out.origin = state.origin;
      }
      out.focusModelType = typeof focusModel;
      out.camPos = (typeof camera !== 'undefined') ? [Math.round(camera.position.x), Math.round(camera.position.y), Math.round(camera.position.z)] : null;
      out.target = (typeof controls !== 'undefined' && controls.target) ? [Math.round(controls.target.x), Math.round(controls.target.y), Math.round(controls.target.z)] : null;
      return out;
    })()`);
    console.log(JSON.stringify(probe, null, 2));

    // try focusing directly
    const focus = await evaluate(`(() => {
      try {
        if (typeof state === 'undefined' || !state.models.length) return 'no models';
        const m = state.models[0];
        if (!m.mesh) return 'model has no mesh';
        focusModel(m);
        return 'focusModel called on ' + m.id;
      } catch (e) { return 'ERROR ' + e.message; }
    })()`);
    console.log('\nfocus: ' + focus);
    await sleep(2000);
    const after = await evaluate(`(() => ({
      camPos: (typeof camera !== 'undefined') ? [Math.round(camera.position.x), Math.round(camera.position.y), Math.round(camera.position.z)] : null,
      target: (typeof controls !== 'undefined' && controls.target) ? [Math.round(controls.target.x), Math.round(controls.target.y), Math.round(controls.target.z)] : null
    }))()`);
    console.log('after: ' + JSON.stringify(after));

    ws.close();
  } catch (e) { console.error('ERR: ' + e.message); }
  finally { chrome.kill(); }
})();
