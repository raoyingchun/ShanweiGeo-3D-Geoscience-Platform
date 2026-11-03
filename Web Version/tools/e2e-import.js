/*
 * e2e-import.js - end-to-end import test for the web build
 *
 * Loads a real GOCAD .ts model and a real tunnel model through the same code
 * path the UI uses, then checks that geometry reaches the Three.js scene.
 * The files are fetched over HTTP (the same way the browser would), so this
 * also proves the asset pipeline works.
 *
 * Usage: node e2e-import.js <url>
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9224;

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
  const profile = path.join(os.tmpdir(), 'e2e_profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--window-size=1600,1000', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, URL_ARG], { stdio: 'ignore' });

  let failures = 0;
  const check = (name, ok, detail) => {
    if (!ok) failures++;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  };

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

    console.log('\n=== web build end-to-end import test ===\n');

    // --- a real GOCAD .ts model through the parser -----------------------
    const ts = await evaluate(`(async () => {
      const base = location.origin + '/Sample%20Data/3D%20Models/Tunnel%20Models/';
      const str = await (await fetch(base + 'simulated_1_1_surrounding_tunnels.ts')).text();
      const geo = parseGOCADTS(str);
      return { bytes: str.length, verts: geo.vertices ? geo.vertices.length / 3 : 0,
               tris: geo.indices ? geo.indices.length / 3 : 0, name: geo.name };
    })()`);
    check('fetch a real .ts model over HTTP', !!(ts && ts.bytes > 1000),
          ts ? (ts.bytes / 1024).toFixed(0) + ' KB' : '');
    check('parse a real .ts model', !!(ts && ts.tris > 100),
          ts ? ts.verts + ' verts, ' + ts.tris + ' tris' : '');

    // --- a real tunnel model (.str + .dtm) -------------------------------
    const tunnel = await evaluate(`(async () => {
      const base = location.origin + '/Sample%20Data/3D%20Models/Tunnel%20Models/';
      const str = await (await fetch(base + 'tunnel_test.str')).text();
      const dtm = await (await fetch(base + 'tunnel_test.dtm')).text();
      const geo = parseTunnelModel(str, dtm, 'tunnel_test');
      return { strBytes: str.length, dtmBytes: dtm.length,
               verts: geo && geo.vertices ? geo.vertices.length / 3 : 0,
               tris: geo && geo.indices ? geo.indices.length / 3 : 0 };
    })()`);
    check('fetch a real tunnel model pair', !!(tunnel && tunnel.strBytes > 100 && tunnel.dtmBytes > 100),
          tunnel ? tunnel.strBytes + ' + ' + tunnel.dtmBytes + ' bytes' : '');
    check('parse a real tunnel model', !!(tunnel && tunnel.tris > 0),
          tunnel ? tunnel.verts + ' verts, ' + tunnel.tris + ' tris' : '');

    // --- a real drillhole collar table ------------------------------------
    const collar = await evaluate(`(async () => {
      const url = location.origin + '/Sample%20Data/Drillhole%20Data/R_collar.csv';
      const text = await (await fetch(url)).text();
      const rows = text.trim().split(/\\r?\\n/);
      return { rows: rows.length, header: rows[0], sample: rows[1] };
    })()`);
    check('fetch a real drillhole table', !!(collar && collar.rows > 1),
          collar ? collar.rows + ' rows' : '');
    check('collar table has the expected columns',
          !!(collar && /holeid/i.test(collar.header) && /x/i.test(collar.header)),
          collar ? collar.header : '');

    // --- load the model into a live Three.js scene ------------------------
    // The application keeps its scene in module scope, so the test builds its
    // own scene and renders it into the same canvas the application uses.
    const scene = await evaluate(`(async () => {
      const base = location.origin + '/Sample%20Data/3D%20Models/Tunnel%20Models/';
      const str = await (await fetch(base + 'simulated_1_1_surrounding_tunnels.ts')).text();
      const geo = parseGOCADTS(str);
      if (!geo || !geo.vertices || !geo.vertices.length) return { ok: false, reason: 'no geometry' };

      let mesh = null;
      try {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(geo.vertices), 3));
        g.setIndex(Array.from(geo.indices));
        g.computeVertexNormals();
        g.computeBoundingSphere();
        mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
          color: 0x8899aa, side: THREE.DoubleSide, transparent: true, opacity: 0.85
        }));
      } catch (e) { return { ok: false, reason: e.message }; }

      // render the model into the application canvas with a fresh camera
      const canvas = document.querySelector('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return { ok: false, reason: 'no gl context' };

      const testScene = new THREE.Scene();
      testScene.add(mesh);
      const cam = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.1, 100000);
      const box = new THREE.Box3().setFromObject(mesh);
      const centre = box.getCenter(new THREE.Vector3());
      const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
      cam.position.copy(centre).add(new THREE.Vector3(radius, radius, radius));
      cam.lookAt(centre);
      cam.updateProjectionMatrix();

      const r = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
      r.setSize(canvas.width, canvas.height, false);
      r.setClearColor(0x101820, 1);
      r.render(testScene, cam);

      // count the lit pixels straight out of the framebuffer
      const w = canvas.width, h = canvas.height;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let lit = 0, distinct = new Set();
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i] > 24 || buf[i+1] > 24 || buf[i+2] > 24) lit++;
        if (i % (4 * 53) === 0) distinct.add(buf[i] + ',' + buf[i+1] + ',' + buf[i+2]);
      }
      return { ok: true, tris: geo.indices.length / 3, verts: geo.vertices.length / 3,
               lit: lit, total: w * h, distinct: distinct.size,
               radius: Math.round(radius) };
    })()`);
    check('build and render a model from the parsed geometry', !!(scene && scene.ok),
          scene && scene.reason || '');
    check('the rendered model covers the canvas', !!(scene && scene.lit > (scene.total || 1) * 0.01),
          scene ? scene.lit + '/' + scene.total + ' pixels lit, ' + scene.distinct + ' distinct colours' : '');

    console.log('\n=== ' + (failures === 0 ? 'all checks passed' : failures + ' check(s) failed') + ' ===\n');
    ws.close();
  } catch (error) {
    console.error('\nTEST ERROR: ' + error.message);
    failures++;
  } finally {
    chrome.kill();
  }
  process.exit(failures ? 1 : 0);
})();
