/*
 * e2e-ui-import.js - drive the real import path through the file input.
 *
 * This exercises the same code the user does: the file input's change
 * handler, the parser, loadModelToScene and the render loop. A DataTransfer
 * carries the fetched bytes into the input so no native dialog is needed.
 *
 * Usage: node e2e-ui-import.js <url> <outfile>
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const OUT = process.argv[3] || path.join(os.tmpdir(), 'web_ui_import.png');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9226;

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
  const profile = path.join(os.tmpdir(), 'uiimp_profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--hide-scrollbars', '--window-size=1600,1000',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, URL_ARG],
    { stdio: 'ignore' });

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

    console.log('\n=== web build UI import test ===\n');

    // Step 1: right-click the 3D geological model category, exactly as a user
    // would, so the application records which category the files belong to.
    const picked = await evaluate(`(() => {
      const node = document.querySelector('.lp-sub-item.has-children[data-category]');
      if (!node) return { ok: false, reason: 'no category node' };
      const rect = node.getBoundingClientRect();
      node.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: rect.left + 10, clientY: rect.top + 10
      }));
      return { ok: true, label: node.textContent.trim().slice(0, 40),
               category: node.getAttribute('data-category') };
    })()`);
    check('right-click a model category', !!(picked && picked.ok),
          picked && picked.reason || (picked ? picked.label + ' (' + picked.category + ')' : ''));
    await sleep(1200);

    // Step 2: pick the "import TS model" entry from the context menu.
    const menu = await evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('.ctx-menu-item, .ctx-item, [data-ctx-action]'));
      const texts = items.map(i => (i.textContent || '').trim());
      const idx = texts.findIndex(t => /import.*ts|ts.*model|\\u5bfc\\u5165.*\\.ts/i.test(t));
      if (idx >= 0) { items[idx].click(); return { ok: true, picked: texts[idx] }; }
      return { ok: false, texts: texts.slice(0, 20) };
    })()`);
    check('the context menu offers a TS import entry', !!(menu && menu.ok),
          menu && menu.ok ? menu.picked : JSON.stringify(menu && menu.texts));
    await sleep(1500);

    // Step 3: the application opens its file input; feed the real model in.
    const imported = await evaluate(`(async () => {
      const input = document.getElementById('file-input');
      if (!input) return { ok: false, reason: 'file-input not found' };

      const url = location.origin + '/Sample%20Data/3D%20Models/Tunnel%20Models/simulated_1_1_surrounding_tunnels.ts';
      const res = await fetch(url);
      if (!res.ok) return { ok: false, reason: 'fetch failed ' + res.status };
      const buffer = await res.arrayBuffer();

      const file = new File([buffer], 'simulated_1_1_surrounding_tunnels.ts',
        { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, bytes: buffer.byteLength };
    })()`);
    check('dispatch a real file into the model input', !!(imported && imported.ok),
          imported && imported.reason || (imported ? imported.bytes + ' bytes' : ''));

    // Give the import pipeline time to parse and render.
    await sleep(9000);

    const after = await evaluate(`(() => {
      const layerRows = document.querySelectorAll('.lm-row, .lm-item, .lm-layer-item').length;
      const layerText = document.querySelector('.lm-title') ? document.querySelector('.lm-title').textContent : '';
      const empty = document.body.innerText.includes('No layers, please import a model');
      const legend = document.querySelector('.legend-box, #legend-box, .lm-legend');
      return { layerRows, layerText, empty, hasLegend: !!legend };
    })()`);
    check('the layer manager no longer shows the empty state', !!(after && after.empty === false),
          after ? after.layerRows + ' layer rows' : '');
    check('the layer manager lists the imported model', !!(after && after.layerRows > 0),
          after ? after.layerRows + ' rows, title "' + after.layerText + '"' : '');

    // The canvas must show lit pixels now that the model is in the scene.
    const pixels = await evaluate(`(() => {
      const c = document.querySelector('canvas');
      if (!c) return { ok: false };
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return { ok: false, reason: 'no gl' };
      const w = c.width, h = c.height;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let lit = 0; const distinct = new Set();
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i] > 24 || buf[i+1] > 24 || buf[i+2] > 24) lit++;
        if (i % (4 * 53) === 0) distinct.add(buf[i]+','+buf[i+1]+','+buf[i+2]);
      }
      return { ok: true, lit, total: w * h, distinct: distinct.size };
    })()`);
    check('the canvas shows the imported model', !!(pixels && pixels.lit > (pixels.total || 1) * 0.005),
          pixels ? pixels.lit + '/' + pixels.total + ' pixels lit, ' + pixels.distinct + ' colours' : '');

    // Capture what the user sees.
    await sleep(1500);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
      console.log('  screenshot: ' + OUT);
    }

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
