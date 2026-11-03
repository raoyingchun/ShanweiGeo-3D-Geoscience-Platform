/* Inspect the context menu state right after a right-click. */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8766/index8.html';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9230;
function getJson(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = path.join(os.tmpdir(), 'menu_profile');
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
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    await send('Runtime.enable');
    await send('Page.reload', { ignoreCache: true });
    await sleep(8000);

    const r = await evaluate(`(() => {
      const node = document.querySelector('.lp-sub-item.has-children[data-category]');
      const out = { found: !!node };
      if (!node) return out;
      const rect = node.getBoundingClientRect();
      out.rect = { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
      out.category = node.getAttribute('data-category');
      out.text = node.textContent.trim().slice(0, 40);
      // is it inside the visible project tree?
      let p = node, chain = [];
      while (p && chain.length < 6) { chain.push((p.id || p.className || p.tagName).toString().slice(0, 40)); p = p.parentElement; }
      out.chain = chain;
      return out;
    })()`);
    console.log('=== target node ===');
    console.log(JSON.stringify(r, null, 2));

    // dispatch and inspect immediately
    const after = await evaluate(`(() => {
      const node = document.querySelector('.lp-sub-item.has-children[data-category]');
      const rect = node.getBoundingClientRect();
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
        clientX: rect.left + 10, clientY: rect.top + 10 });
      node.dispatchEvent(ev);
      const menu = document.getElementById('ctx-menu');
      const ts = document.getElementById('ctx-import-ts');
      return {
        menuClass: menu ? menu.className : null,
        menuDisplay: menu ? getComputedStyle(menu).display : null,
        menuVisibility: menu ? getComputedStyle(menu).visibility : null,
        tsInline: ts ? ts.style.display : null,
        tsComputed: ts ? getComputedStyle(ts).display : null,
        tsMenuType: ts ? ts.getAttribute('data-menu-type') : null,
        tsText: ts ? ts.textContent.trim() : null,
        visibleMenuItems: Array.from(document.querySelectorAll('[data-menu-type]'))
          .filter(e => getComputedStyle(e).display !== 'none')
          .map(e => (e.textContent || '').trim().slice(0, 24))
      };
    })()`);
    console.log('\n=== right after contextmenu ===');
    console.log(JSON.stringify(after, null, 2));

    await sleep(800);
    const later = await evaluate(`(() => {
      const menu = document.getElementById('ctx-menu');
      const ts = document.getElementById('ctx-import-ts');
      return { menuClass: menu.className, menuDisplay: getComputedStyle(menu).display,
               tsComputed: getComputedStyle(ts).display };
    })()`);
    console.log('\n=== 800ms later ===');
    console.log(JSON.stringify(later, null, 2));
    ws.close();
  } catch (e) { console.error('ERR: ' + e.message); }
  finally { chrome.kill(); }
})();
