/*
 * e2e-scene.js - verify the model reaches the application's own scene.
 *
 * The file dialog cannot be driven in a headless browser, so the test calls
 * the same entry point the UI calls (loadModelToScene) with geometry from the
 * real parser. That proves the scene, layer manager, legend and camera all
 * respond to imported geometry.
 *
 * Usage: node e2e-scene.js <url> <outfile>
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const OUT = process.argv[3] || path.join(os.tmpdir(), 'web_scene.png');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9229;

function getJson(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = path.join(os.tmpdir(), 'scene_profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--hide-scrollbars', '--window-size=1600,1000',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, URL_ARG],
    { stdio: 'ignore' });

  let failures = 0;
  const check = (n, ok, d) => {
    if (!ok) failures++;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (d ? '   ' + d : ''));
  };

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

    console.log('\n=== web build scene test ===\n');

    // The right-click sets pendingCategoryItem; verify it before going on.
    // The listener is bound on the 3D geological model container, so the
    // target has to live under #subitems-3d-model.
    const ctx = await evaluate(`(() => {
      const root = document.getElementById('subitems-3d-model');
      const node = root && root.querySelector('.lp-sub-item.has-children[data-category]');
      if (!node) return { ok: false, reason: 'no category under subitems-3d-model' };
      const r = node.getBoundingClientRect();
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
        clientX: r.left + 10, clientY: r.top + 10 }));
      return { ok: true, label: node.textContent.trim().slice(0, 30),
               category: node.getAttribute('data-category') };
    })()`);
    check('right-click a 3D model category', !!(ctx && ctx.ok),
          ctx && ctx.reason || (ctx ? ctx.label + ' (' + ctx.category + ')' : ''));
    await sleep(1000);

    const menuVisible = await evaluate(`(() => {
      const menu = document.getElementById('ctx-menu');
      const ts = document.getElementById('ctx-import-ts');
      return { menuExists: !!menu, menuDisplay: menu ? getComputedStyle(menu).display : null,
               tsExists: !!ts, tsDisplay: ts ? getComputedStyle(ts).display : null,
               tsText: ts ? ts.textContent.trim() : null };
    })()`);
    check('the context menu is visible', !!(menuVisible && menuVisible.tsDisplay !== 'none'),
          JSON.stringify(menuVisible));

    // Import through the application's own entry point.
    const result = await evaluate(`(async () => {
      const url = location.origin + '/Sample%20Data/3D%20Models/Tunnel%20Models/simulated_1_1_surrounding_tunnels.ts';
      const text = await (await fetch(url)).text();
      const geo = parseGOCADTS(text);
      geo.source = { fileName: 'simulated_1_1_surrounding_tunnels.ts' };
      let m = null, err = null;
      try {
        m = loadModelToScene(geo, '3D Tunnel Models', 'simulated_1_1_surrounding_tunnels.ts', {});
      } catch (e) { err = e.message; }
      return { err, id: m ? m.id : null,
               verts: geo.vertices.length / 3, tris: geo.indices.length / 3 };
    })()`);
    check('loadModelToScene accepts the parsed model', !!(result && result.id),
          result && result.err || (result ? result.id + '  ' + result.verts + ' verts / ' + result.tris + ' tris' : ''));

    await sleep(4000);

    const scene = await evaluate(`(() => {
      const lm = document.querySelector('.lm-title');
      const rows = document.querySelectorAll('.lm-item, .lm-drill-item, .lm-model-item, .lm-row').length;
      const empty = document.body.innerText.includes('No layers, please import a model');
      const legendText = document.body.innerText.match(/LEGEND[\\s\\S]{0,200}/);
      return { rows, empty, layerTitle: lm ? lm.textContent : '', legend: legendText ? legendText[0].slice(0, 160) : null };
    })()`);
    check('the layer manager lists the model', !!(scene && scene.rows > 0),
          scene ? scene.rows + ' rows' : '');
    check('the empty-layer state is gone', !!(scene && scene.empty === false));
    check('the legend now has content', !!(scene && scene.legend && !/No layers/.test(scene.legend)),
          scene && scene.legend ? scene.legend.replace(/\\s+/g, ' ').slice(0, 100) : '');

    // The canvas check goes through the screenshot rather than readPixels:
    // without preserveDrawingBuffer the default framebuffer is empty once
    // the render loop has swapped, so readPixels reports nothing.
    await sleep(1500);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
      // A PNG of a mostly-white canvas compresses to a small file; a rendered
      // 3D scene pushes it well past that.
      const size = fs.statSync(OUT).size;
      check('the canvas shows the model', size > 90000, size + ' bytes of PNG');
      console.log('  screenshot: ' + OUT);
    } else {
      check('the canvas shows the model', false, 'no screenshot data');
    }

    console.log('\n=== ' + (failures === 0 ? 'all checks passed' : failures + ' failed') + ' ===\n');
    ws.close();
  } catch (e) { console.error('\nERROR: ' + e.message); failures++; }
  finally { chrome.kill(); }
  process.exit(failures ? 1 : 0);
})();
