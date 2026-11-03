/*
 * trace-import.js - capture the console output and any exception raised while
 * the real import path runs, so the failure point is visible.
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9227;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = path.join(os.tmpdir(), 'trace_profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--window-size=1600,1000', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, URL_ARG], { stdio: 'ignore' });

  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(500);
      try {
        const l = await getJson('http://127.0.0.1:' + PORT + '/json/list');
        target = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch (e) { /* wait */ }
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const logs = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = m.params.args.map(a => a.value !== undefined ? a.value : (a.description || '')).join(' ');
        logs.push('[' + m.params.type + '] ' + text);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        logs.push('[EXCEPTION] ' + (d.exception && d.exception.description || d.text));
      }
      if (m.method === 'Page.javascriptDialogOpening') {
        logs.push('[DIALOG] ' + m.params.message);
      }
    });
    await new Promise(r => ws.addEventListener('open', r));
    const send = (method, params) => new Promise(resolve => {
      const i = ++id; pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
    const evaluate = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    await sleep(7000);

    console.log('logs after load: ' + logs.length);

    // right-click the model category
    await evaluate(`(() => {
      const node = document.querySelector('.lp-sub-item.has-children[data-category]');
      if (!node) return false;
      const r = node.getBoundingClientRect();
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
        clientX: r.left + 10, clientY: r.top + 10 }));
      return true;
    })()`);
    await sleep(1000);
    await evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('.ctx-menu-item, .ctx-item, [data-ctx-action]'));
      const t = items.map(i => (i.textContent||'').trim());
      const i = t.findIndex(x => /import.*ts/i.test(x));
      if (i >= 0) items[i].click();
      return i;
    })()`);
    await sleep(1200);
    console.log('logs after menu: ' + logs.length);

    // feed the file
    await evaluate(`(async () => {
      const input = document.getElementById('file-input');
      const res = await fetch(location.origin + '/Sample%20Data/3D%20Models/Tunnel%20Models/simulated_1_1_surrounding_tunnels.ts');
      const buffer = await res.arrayBuffer();
      const file = new File([buffer], 'simulated_1_1_surrounding_tunnels.ts', { type: 'text/plain' });
      const dt = new DataTransfer(); dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(10000);

    console.log('\n=== console log during import ===');
    logs.slice(-45).forEach(l => console.log('  ' + l.slice(0, 200)));

    const state = await evaluate(`(() => ({
      layerRows: document.querySelectorAll('.lm-row, .lm-item, .lm-layer-item, .lm-drill-item, .lm-model-item').length,
      bodyText: document.body.innerText.slice(0, 300),
      pendingCategory: (typeof pendingCategoryItem !== 'undefined') ? String(pendingCategoryItem) : 'n/a'
    }))()`);
    console.log('\n=== state after import ===');
    console.log('  layerRows: ' + state.layerRows);
    ws.close();
  } catch (e) {
    console.error('ERR: ' + e.message);
  } finally {
    chrome.kill();
  }
})();
