/*
 * probe-scene-layout.js - report where the demo model actually sits on screen.
 *
 * A crop of the canvas can be misleading when the crop is only part of the
 * drawing surface, so this reports the canvas rectangle and projects the
 * model bounding box into screen space.
 */
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const URL_ = process.argv[2];
const OUT = process.argv[3] || '';
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = process.env.TEMP + '\\chromeprof_layout';
const port = 9333;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  fs.rmSync(profile, { recursive: true, force: true });
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1600,1000', '--user-data-dir=' + profile,
    '--remote-debugging-port=' + port, 'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:' + port + '/json/list', r => {
          let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
        }).on('error', rej);
      });
      target = list.find(t => t.type === 'page');
    } catch (e) { /* not up yet */ }
  }
  if (!target) { console.log('chrome did not start'); child.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params) => new Promise(res => {
    const m = ++id; pending.set(m, res);
    ws.send(JSON.stringify({ id: m, method, params: params || {} }));
  });
  await new Promise(r => ws.addEventListener('open', r));

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL_ });
  await sleep(14000);

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { error: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : null;
  };

  const info = await evaluate(`(() => {
    const canvas = document.querySelector('canvas');
    const r = canvas ? canvas.getBoundingClientRect() : null;
    const out = {
      canvas: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      window: { w: innerWidth, h: innerHeight }
    };
    // the demo model
    let model = null;
    try {
      if (typeof state !== 'undefined' && state.models) {
        model = state.models.find(m => m.mesh) || null;
      }
    } catch (e) { out.stateError = e.message; }
    if (!model) { out.model = null; return out; }

    const box = new THREE.Box3().setFromObject(model.mesh);
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());

    out.model = {
      fileName: model.fileName || model.name || '?',
      visible: model.mesh.visible,
      centre: [Math.round(centre.x), Math.round(centre.y), Math.round(centre.z)],
      size: [Math.round(size.x), Math.round(size.y), Math.round(size.z)],
      radius: Math.round(sphere.radius)
    };

    if (typeof camera !== 'undefined') {
      out.camera = {
        pos: [Math.round(camera.position.x), Math.round(camera.position.y), Math.round(camera.position.z)],
        far: camera.far, near: camera.near, fov: camera.fov
      };
      const p = centre.clone().project(camera);
      out.model.screen = {
        ndcX: Math.round(p.x * 100) / 100,
        ndcY: Math.round(p.y * 100) / 100,
        pxX: r ? Math.round(r.x + (p.x * 0.5 + 0.5) * r.width) : null,
        pxY: r ? Math.round(r.y + (-p.y * 0.5 + 0.5) * r.height) : null
      };
      out.model.distToCamera = Math.round(camera.position.distanceTo(centre));
    }
    if (typeof controls !== 'undefined') {
      out.controls = { target: [Math.round(controls.target.x), Math.round(controls.target.y), Math.round(controls.target.z)] };
    }
    return out;
  })()`);
  console.log(JSON.stringify(info, null, 2));

  if (OUT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
      console.log('full screenshot: ' + OUT);
    }
  }
  ws.close();
  child.kill();
  process.exit(0);
})();
