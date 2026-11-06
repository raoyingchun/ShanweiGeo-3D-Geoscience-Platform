/* Crop and zoom into the canvas area so the demo model can be inspected. */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const OUT = process.argv[3] || path.join(os.tmpdir(), 'demo_zoom.png');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9238;
function getJson(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = path.join(os.tmpdir(), 'zoom_profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--hide-scrollbars', '--window-size=1600,1000', '--remote-debugging-port=' + PORT,
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

    // report the geometry in scene space
    const geo = await evaluate(`(() => {
      const out = {};
      // count the triangles actually drawn
      let tris = 0, verts = 0;
      if (typeof scene !== 'undefined') {
        scene.traverse(o => {
          if (o.isMesh && o.geometry && o.geometry.index) {
            tris += o.geometry.index.count / 3;
            verts += o.geometry.attributes.position.count;
          }
        });
      }
      out.tris = tris; out.verts = verts;
      out.meshCount = (typeof scene !== 'undefined') ? scene.children.filter(c => c.isMesh).length : -1;
      // the camera
      out.cam = (typeof camera !== 'undefined') ? {
        pos: [Math.round(camera.position.x), Math.round(camera.position.y), Math.round(camera.position.z)],
        target: (typeof controls !== 'undefined' && controls.target) ? [Math.round(controls.target.x), Math.round(controls.target.y), Math.round(controls.target.z)] : null,
        far: camera.far, near: camera.near
      } : null;
      return out;
    })()`);
    console.log('scene: ' + JSON.stringify(geo, null, 2));

    // capture just the canvas
    const rect = await evaluate(`(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    })()`);
    const clip = rect
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1.5 }
      : { x: 330, y: 55, width: 640, height: 400, scale: 2 };
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: clip });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
      console.log('canvas crop: ' + OUT + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
      console.log('clip: ' + JSON.stringify(clip));
    }
    ws.close();
  } catch (e) { console.error('ERR: ' + e.message); }
  finally { chrome.kill(); }
})();
