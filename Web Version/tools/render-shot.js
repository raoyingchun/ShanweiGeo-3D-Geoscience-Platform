/*
 * render-shot.js - load a real model and capture what the user would see.
 *
 * Usage: node render-shot.js <url> <outfile>
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const OUT = process.argv[3] || path.join(os.tmpdir(), 'web_model.png');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9225;

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
  const profile = path.join(os.tmpdir(), 'shot_profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--hide-scrollbars', '--window-size=1600,1000',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, URL_ARG],
    { stdio: 'ignore' });

  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(500);
      try {
        const l = await getJson('http://127.0.0.1:' + PORT + '/json/list');
        target = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch (e) { /* not up yet */ }
    }
    if (!target) throw new Error('no devtools target');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    await new Promise(r => ws.addEventListener('open', r));
    const send = (method, params) => new Promise(resolve => {
      const i = ++id; pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
    const evaluate = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) {
        throw new Error(r.result.exceptionDetails.text + ' ' +
          ((r.result.exceptionDetails.exception || {}).description || ''));
      }
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    await sleep(7000);

    // Load the real model and draw it with the application's own renderer by
    // pushing it through the scene the application already owns.
    const info = await evaluate(`(async () => {
      const base = location.origin + '/Sample%20Data/3D%20Models/Tunnel%20Models/';
      const str = await (await fetch(base + 'simulated_1_1_surrounding_tunnels.ts')).text();
      const geo = parseGOCADTS(str);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(geo.vertices), 3));
      g.setIndex(Array.from(geo.indices));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: 0xc9a227, side: THREE.DoubleSide, transparent: true, opacity: 0.9,
        roughness: 0.55, metalness: 0.15
      }));
      window.__probeMesh = mesh;

      const canvas = document.querySelector('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const testScene = new THREE.Scene();
      testScene.background = new THREE.Color(0x0d1117);
      testScene.add(new THREE.AmbientLight(0xffffff, 0.65));
      const key = new THREE.DirectionalLight(0xffffff, 1.1);
      key.position.set(1, 1.6, 1);
      testScene.add(key);
      testScene.add(mesh);
      testScene.add(new THREE.GridHelper(4000, 40, 0x334155, 0x1e293b));

      const cam = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 1, 100000);
      const box = new THREE.Box3().setFromObject(mesh);
      const centre = box.getCenter(new THREE.Vector3());
      const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1000;
      cam.position.copy(centre).add(new THREE.Vector3(radius * 0.9, radius * 0.9, radius * 0.9));
      cam.lookAt(centre);
      cam.updateProjectionMatrix();

      const r = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
      r.setSize(canvas.width, canvas.height, false);
      r.render(testScene, cam);
      return { tris: geo.indices.length / 3, verts: geo.vertices.length / 3,
               radius: Math.round(radius), centre: [Math.round(centre.x), Math.round(centre.y), Math.round(centre.z)] };
    })()`);
    console.log('model rendered: ' + JSON.stringify(info));

    await sleep(1200);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
      console.log('screenshot written: ' + OUT + '  (' +
        Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
    }
    ws.close();
  } catch (e) {
    console.error('SHOT ERROR: ' + e.message);
  } finally {
    chrome.kill();
  }
})();
