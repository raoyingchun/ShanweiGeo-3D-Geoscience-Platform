/* Compare the camera target with the model's own bounding box. */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9240;
function getJson(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = path.join(os.tmpdir(), 'bboxprobe');
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

    const box = await evaluate(`(() => {
      const m = state.models[0];
      const out = {};
      const b = new THREE.Box3().setFromObject(m.mesh);
      out.min = [Math.round(b.min.x), Math.round(b.min.y), Math.round(b.min.z)];
      out.max = [Math.round(b.max.x), Math.round(b.max.y), Math.round(b.max.z)];
      const s = b.getBoundingSphere(new THREE.Sphere());
      out.sphere = { c: [Math.round(s.center.x), Math.round(s.center.y), Math.round(s.center.z)], r: Math.round(s.radius) };
      out.target = [Math.round(controls.target.x), Math.round(controls.target.y), Math.round(controls.target.z)];
      out.camPos = [Math.round(camera.position.x), Math.round(camera.position.y), Math.round(camera.position.z)];
      out.dist = Math.round(camera.position.distanceTo(controls.target));
      out.fov = camera.fov;
      out.aspect = (canvas.clientWidth / canvas.clientHeight).toFixed(2);
      // what the visible height at the target distance would be
      out.visibleHeight = Math.round(2 * out.dist * Math.tan(camera.fov * Math.PI / 360));
      out.modelSize = [Math.round(b.max.x - b.min.x), Math.round(b.max.y - b.min.y), Math.round(b.max.z - b.min.z)];
      return out;
    })()`);
    console.log(JSON.stringify(box, null, 2));
    ws.close();
  } catch (e) { console.error('ERR: ' + e.message); }
  finally { chrome.kill(); }
})();
