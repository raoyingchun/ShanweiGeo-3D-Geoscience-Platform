/*
 * smoke-test.js - drive the web build through the Chrome DevTools Protocol
 *
 * The build has no test harness, so this script attaches to a headless
 * Chrome instance and checks the parts that matter for the browser port:
 *   1. the bridge is installed and the expected methods exist
 *   2. the page initialises without an uncaught error
 *   3. the WebGL canvas is live
 *   4. the session draft round-trips through the bridge
 *   5. importing a GOCAD .ts model renders geometry
 *
 * Usage: node smoke-test.js <url>
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9222;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitFor(fn, timeout, label) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('timeout waiting for ' + label);
}

(async () => {
  const profile = path.join(os.tmpdir(), 'smoketest_profile');
  fs.rmSync(profile, { recursive: true, force: true });

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--window-size=1600,1000',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    URL_ARG
  ], { stdio: 'ignore' });

  let failures = 0;
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    if (!ok) failures++;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  };

  try {
    const targets = await waitFor(
      () => getJson('http://127.0.0.1:' + PORT + '/json/list').then(l =>
        l.find(t => t.type === 'page' && t.webSocketDebuggerUrl) ? l : null),
      30000, 'chrome devtools');

    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    let msgId = 0;
    const pending = new Map();
    const consoleErrors = [];
    const pageErrors = [];

    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push(m.params.args.map(a => a.value || a.description || '').join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        pageErrors.push((d.exception && d.exception.description) || d.text);
      }
    });

    await new Promise(r => ws.addEventListener('open', r));

    const send = (method, params) => new Promise(resolve => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });

    const evaluate = async expr => {
      const r = await send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true
      });
      if (r.result && r.result.exceptionDetails) {
        throw new Error(r.result.exceptionDetails.text + ' ' +
          (r.result.exceptionDetails.exception || {}).description);
      }
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    await new Promise(r => setTimeout(r, 6000));

    console.log('\n=== web build smoke test ===\n');

    // 1. the bridge is installed
    const bridge = await evaluate(`(() => {
      const a = window.electronAPI;
      if (!a) return { ok: false, reason: 'window.electronAPI is missing' };
      const need = ['showSaveDialog','showOpenDialog','readProjectFile','writeProjectFile',
                    'statProjectFile','saveSession','readSession','clearSession',
                    'listCustomMaterials','onCloseRequest','allowClose'];
      const missing = need.filter(k => typeof a[k] !== 'function');
      return { ok: missing.length === 0, missing, isElectron: a.isElectron,
               web: !!window.__shanweiGeoIsWeb };
    })()`);
    check('bridge installed', bridge && bridge.ok,
          bridge && bridge.missing && bridge.missing.length
            ? 'missing: ' + bridge.missing.join(', ') : '');
    check('bridge flagged as browser', bridge && bridge.web === true && bridge.isElectron === false);

    // 2. the application initialised
    const app = await evaluate(`(() => ({
      title: document.title,
      hasCanvas: !!document.querySelector('canvas'),
      treeItems: document.querySelectorAll('.lp-sub-item, .lp-group-header').length,
      tabButtons: document.querySelectorAll('.center-tab').length,
      layerTitle: !!document.querySelector('.lm-title'),
      coordButton: !!document.querySelector('[data-menu-type]'),
      bodyClass: document.body.className
    }))()`);
    check('page title set', !!(app && app.title), app && app.title);
    check('WebGL canvas present', !!(app && app.hasCanvas));
    check('project tree populated', !!(app && app.treeItems > 5),
          app ? app.treeItems + ' items' : '');
    check('layer manager present', !!(app && app.layerTitle));

    // 3. the canvas is actually rendering (not a blank element)
    const canvasLive = await evaluate(`(() => {
      const c = document.querySelector('canvas');
      if (!c) return { ok: false, reason: 'no canvas' };
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      return { ok: !!gl, w: c.width, h: c.height, hasGL: !!gl,
               renderer: gl ? (gl.getParameter(gl.VERSION) || '') : '' };
    })()`);
    check('canvas has a live WebGL context', !!(canvasLive && canvasLive.ok),
          canvasLive && canvasLive.renderer ? canvasLive.renderer : '');

    // 4. the session draft round-trips
    const session = await evaluate(`(async () => {
      const payload = JSON.stringify({ scene: { probe: 1 }, format: 'szproject' });
      const s = await window.electronAPI.saveSession(payload);
      const r = await window.electronAPI.readSession();
      const c = await window.electronAPI.clearSession();
      const r2 = await window.electronAPI.readSession();
      return { saved: !!(s && s.ok), read: !!(r && r.ok), same: !!(r && r.data === payload),
               cleared: !!(c && c.ok), goneAfterClear: !(r2 && r2.ok) };
    })()`);
    check('session save', !!(session && session.saved));
    check('session read back', !!(session && session.read));
    check('session payload intact', !!(session && session.same));
    check('session clear', !!(session && session.cleared && session.goneAfterClear));

    // 5. the material library round-trips
    const material = await evaluate(`(async () => {
      const list0 = await window.electronAPI.listCustomMaterials();
      const put = await window.electronAPI.importCustomMaterial({
        name: 'probe.png', mime: 'image/png', size: 3, data: 'AAAA'
      });
      const read = await window.electronAPI.readCustomMaterial(put.id);
      const list1 = await window.electronAPI.listCustomMaterials();
      const del = await window.electronAPI.deleteCustomMaterial(put.id);
      return { listed: !!(list0 && list0.ok), added: !!(put && put.ok),
               readBack: !!(read && read.ok && read.data === 'AAAA'),
               grew: list1.data.length === list0.data.length + 1,
               removed: !!(del && del.ok) };
    })()`);
    check('material list', !!(material && material.listed));
    check('material add', !!(material && material.added));
    check('material read back', !!(material && material.readBack));
    check('material delete', !!(material && material.removed));

    // 6. the COORD entry point is hidden (no openCoordTool in the bridge)
    const coord = await evaluate(`typeof window.electronAPI.openCoordTool`);
    check('COORD entry unavailable in the browser', coord === 'undefined', 'type=' + coord);

    // 7. importing a GOCAD .ts model produces geometry
    const model = await evaluate(`(async () => {
      if (typeof parseGOCADTS !== 'function') return { ok: false, reason: 'parseGOCADTS missing' };
      // The GOCAD vertex row carries its own id: VRTX <id> <x> <y> <z>
      const ts = [
        'GOCAD TSurf 1',
        'HEADER {',
        'name:probe',
        '}',
        'TFACE',
        'VRTX 1 0 0 0',
        'VRTX 2 100 0 0',
        'VRTX 3 0 100 0',
        'VRTX 4 0 0 100',
        'TRGL 1 2 3',
        'TRGL 1 2 4',
        'TRGL 1 3 4',
        'TRGL 2 3 4',
        'END'
      ].join('\\n');
      const geo = parseGOCADTS(ts);
      return { ok: true, verts: geo.vertices ? geo.vertices.length / 3 : 0,
               tris: geo.indices ? geo.indices.length / 3 : 0,
               name: geo.name };
    })()`);
    check('GOCAD parser available', !!(model && model.ok), model && model.reason || '');
    check('GOCAD parse yields geometry', !!(model && model.tris === 4),
          model ? model.verts + ' verts, ' + model.tris + ' tris' : '');

    // 8. no uncaught errors during startup
    const realErrors = pageErrors.filter(e => !/favicon|ERR_/i.test(e));
    check('no uncaught page errors', realErrors.length === 0,
          realErrors.slice(0, 2).join(' | '));

    console.log('\n=== ' + (results.length - failures) + '/' + results.length + ' checks passed ===\n');
    ws.close();
  } catch (error) {
    console.error('\nTEST ERROR: ' + error.message);
    failures++;
  } finally {
    chrome.kill();
  }
  process.exit(failures ? 1 : 0);
})();
