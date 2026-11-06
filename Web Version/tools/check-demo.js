/* Verify the demo scene seeds automatically, with no user action. */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const OUT = process.argv[3] || path.join(os.tmpdir(), 'demo_scene.png');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9235;
function getJson(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let failures = 0;
  const check = (n, ok, d) => { if (!ok) failures++; console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (d ? '   ' + d : '')); };

  const profile = path.join(os.tmpdir(), 'demo_profile');
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
    let id = 0; const pending = new Map(); const logs = []; const errs = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ');
        if (/demo scene/i.test(text)) logs.push('[' + m.params.type + '] ' + text);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errs.push((d.exception && d.exception.description) || d.text);
      }
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

    console.log('\n=== demo scene check ===\n');
    console.log('  waiting for the demo scene to seed ...');
    await sleep(16000);

    const state = await evaluate(`(() => ({
      seeded: !!window.__shanweiGeoDemoSeeded,
      layerRows: document.querySelectorAll('.lm-item, .lm-drill-item, .lm-model-item, .lm-row').length,
      layerText: document.querySelector('.lm-title') ? document.querySelector('.lm-title').textContent : '',
      emptyState: document.body.innerText.includes('No layers, please import a model'),
      legend: (document.body.innerText.match(/LEGEND[\\s\\S]{0,160}/) || [''])[0].replace(/\\s+/g, ' ')
    }))()`);
    console.log('  ' + JSON.stringify(state, null, 2).replace(/\\n/g, '\n  ') + '\n');

    check('the demo scene ran', !!(state && state.seeded));
    check('models appear in the layer manager', !!(state && state.layerRows > 0),
          state ? state.layerRows + ' rows' : '');
    check('the empty-layer state is gone', !!(state && state.emptyState === false));
    check('the legend lists the sample models',
          !!(state && state.legend && /simulated|tunnel/i.test(state.legend)),
          state && state.legend ? state.legend.slice(0, 90) : '');

    console.log('  demo log lines:');
    logs.forEach(l => console.log('    ' + l.slice(0, 130)));

    await sleep(2500);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
      const size = fs.statSync(OUT).size;
      check('the canvas renders the demo scene', size > 95000, size + ' bytes of PNG');
      console.log('  screenshot: ' + OUT);
    }

    const real = errs.filter(e => !/favicon|ERR_|ResizeObserver/i.test(e));
    check('no uncaught errors', real.length === 0, real.slice(0, 2).join(' | '));

    console.log('\n=== ' + (failures === 0 ? 'the demo scene works' : failures + ' failed') + ' ===\n');
    ws.close();
  } catch (e) { console.error('ERROR: ' + e.message); failures++; }
  finally { chrome.kill(); }
  process.exit(failures ? 1 : 0);
})();
