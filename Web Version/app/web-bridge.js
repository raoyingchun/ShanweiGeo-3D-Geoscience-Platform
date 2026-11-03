/*
 * web-bridge.js - browser implementation of the Electron bridge
 *
 * The desktop build talks to the main process through window.electronAPI.
 * This file provides the same surface for the browser build, backed by the
 * File API, the File System Access API where available, and IndexedDB.
 *
 * Contract (mirrors preload.js):
 *   showSaveDialog(options)          -> { canceled, filePath }
 *   showOpenDialog(options)          -> { canceled, filePaths[] }
 *   readProjectFile(path)            -> { ok, data(base64) } | { ok:false, error }
 *   writeProjectFile(path, text)     -> { ok } | { ok:false, error }
 *   statProjectFile(path)            -> { ok, size, mtime } | null
 *   saveSession(text)                -> { ok }
 *   readSession()                    -> { ok, data } | { ok:false }
 *   clearSession()                   -> { ok }
 *   listCustomMaterials()            -> { ok, data[] }
 *   importCustomMaterial(payload)    -> { ok, id }
 *   readCustomMaterial(id)           -> { ok, data(base64) }
 *   deleteCustomMaterial(id)         -> { ok }
 *   onCloseRequest(cb) / allowClose() -> the beforeunload handshake
 *
 * Methods that a browser cannot provide (launching the external COORD
 * program) are deliberately absent, so the guarded call sites in the
 * application hide that entry point instead of failing.
 */
(function () {
  'use strict';

  if (window.electronAPI) return;   // the desktop build already provides it

  const SESSION_KEY = 'shanweigeo.session.v1';
  const MATERIAL_DB = 'shanweigeo-materials';
  const MATERIAL_STORE = 'materials';

  // ---- small helpers -------------------------------------------------------

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(text) {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function extensionOf(name) {
    const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function acceptsFilters(file, filters) {
    if (!filters || !filters.length) return true;
    const ext = extensionOf(file.name);
    return filters.some(group =>
      !group.extensions || group.extensions.some(e => String(e).toLowerCase() === ext));
  }

  /* Opens the browser file picker and resolves with the chosen files.
     The caller's filters and accept attribute are honoured. */
  function pickFiles(filters, multiple, acceptHint) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = !!multiple;
      input.style.display = 'none';
      if (acceptHint) input.accept = acceptHint;

      // The picker can only be driven by a user gesture, so the promise
      // resolves on the change event.
      input.addEventListener('change', () => {
        const files = Array.from(input.files || []);
        input.remove();
        resolve(files);
      });
      // A cancelled picker fires no event in most browsers, so a focus
      // check after a short delay resolves with an empty list.
      window.addEventListener('focus', () => {
        setTimeout(() => {
          if (document.body.contains(input) && !(input.files && input.files.length)) {
            input.remove();
            resolve([]);
          }
        }, 500);
      }, { once: true });

      document.body.appendChild(input);
      input.click();
    });
  }

  /* Triggers a download of the given text. The file name is suggested but
     the browser decides where it lands. */
  function downloadText(fileName, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ---- IndexedDB for the custom material library ---------------------------

  function openMaterialDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB is not available')); return; }
      const request = indexedDB.open(MATERIAL_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(MATERIAL_STORE)) {
          db.createObjectStore(MATERIAL_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB could not be opened'));
    });
  }

  function withMaterialStore(mode, action) {
    return openMaterialDb().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(MATERIAL_STORE, mode);
      const store = tx.objectStore(MATERIAL_STORE);
      let result;
      try { result = action(store); } catch (error) { reject(error); return; }
      tx.oncomplete = () => { db.close(); resolve(result && result.result !== undefined ? result.result : result); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error('IndexedDB transaction failed')); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error('IndexedDB transaction aborted')); };
    }));
  }

  // ---- the bridge ----------------------------------------------------------

  const api = {
    isElectron: false,
    platform: 'browser',
    getVersion: () => '1.0.0-web',

    // --- project files ------------------------------------------------------

    async showSaveDialog(options) {
      const opts = options || {};
      // A browser cannot choose a destination folder, so the name is derived
      // from the default path and the content is offered as a download.
      const suggested = (opts.defaultPath || 'project.json').split(/[\\/]/).pop();
      return { canceled: false, filePath: suggested };
    },

    async showOpenDialog(options) {
      const opts = options || {};
      const files = await pickFiles(opts.filters, false);
      if (!files.length) return { canceled: true, filePaths: [] };
      const file = files[0];
      if (!acceptsFilters(file, opts.filters)) {
        return { canceled: true, filePaths: [] };
      }
      // The application treats the path as an opaque key. The file name is a
      // stable enough key for the browser build.
      window.__shanweiGeoFileHandles = window.__shanweiGeoFileHandles || new Map();
      window.__shanweiGeoFileHandles.set(file.name, file);
      return { canceled: false, filePaths: [file.name] };
    },

    async readProjectFile(path) {
      try {
        const handles = window.__shanweiGeoFileHandles || new Map();
        let file = handles.get(path);
        if (!file) {
          const picked = await pickFiles([{ name: 'Project file', extensions: ['json'] }], false);
          if (!picked.length) return { ok: false, error: 'No file was selected' };
          file = picked[0];
          handles.set(path, file);
          window.__shanweiGeoFileHandles = handles;
        }
        const buffer = await file.arrayBuffer();
        return { ok: true, data: bytesToBase64(new Uint8Array(buffer)) };
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    },

    async writeProjectFile(path, text) {
      try {
        downloadText(path.split(/[\\/]/).pop() || 'project.json', text, 'application/json');
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    },

    async statProjectFile(path) {
      try {
        const handles = window.__shanweiGeoFileHandles || new Map();
        const file = handles.get(path);
        if (!file) return null;
        return { ok: true, size: file.size, mtime: file.lastModified, path: path };
      } catch (error) {
        return null;
      }
    },

    // --- session draft ------------------------------------------------------

    async saveSession(text) {
      try {
        localStorage.setItem(SESSION_KEY, text);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    },

    async readSession() {
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (raw === null) return { ok: false };
        return { ok: true, data: raw };
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    },

    async clearSession() {
      try {
        localStorage.removeItem(SESSION_KEY);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    },

    // --- custom material library -------------------------------------------

    async listCustomMaterials() {
      try {
        const all = await withMaterialStore('readonly', store => store.getAll());
        const list = Array.isArray(all) ? all : [];
        return { ok: true, data: list.map(item => ({
          id: item.id,
          name: item.name,
          size: item.size,
          mime: item.mime
        })) };
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    },

    async importCustomMaterial(payload) {
      try {
        const id = 'mat_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
        const record = {
          id: id,
          name: (payload && payload.name) || 'material',
          mime: (payload && payload.mime) || 'image/png',
          size: (payload && payload.size) || 0,
          data: (payload && payload.data) || ''
        };
        await withMaterialStore('readwrite', store => store.put(record));
        return { ok: true, id: id };
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    },

    async readCustomMaterial(id) {
      try {
        const record = await withMaterialStore('readonly', store => store.get(id));
        if (!record) return { ok: false, error: 'The material was not found' };
        return { ok: true, data: record.data };
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    },

    async deleteCustomMaterial(id) {
      try {
        await withMaterialStore('readwrite', store => store.delete(id));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    },

    // --- window lifecycle ---------------------------------------------------

    onCloseRequest(callback) {
      const handler = event => {
        // The application asks the user what to do; the browser cannot hold
        // the page open, so the draft is flushed and the default action is
        // allowed unless the callback reports that it took over.
        let keepOpen = false;
        try { keepOpen = callback() === false; } catch (error) { console.error(error); }
        if (keepOpen) {
          event.preventDefault();
          event.returnValue = '';
        }
      };
      window.addEventListener('beforeunload', handler);
      return () => window.removeEventListener('beforeunload', handler);
    },

    allowClose() { /* the browser closes the tab on its own */ },

    // --- misc ---------------------------------------------------------------

    openExternal(url) {
      window.open(url, '_blank', 'noopener');
    },

    readFile(relativePath) {
      return fetch(relativePath).then(response => {
        if (!response.ok) return { ok: false, error: response.statusText };
        return response.arrayBuffer().then(buffer => ({
          ok: true, data: bytesToBase64(new Uint8Array(buffer))
        }));
      }).catch(error => ({ ok: false, error: error.message }));
    }
  };

  window.electronAPI = api;
  window.__shanweiGeoIsWeb = true;
  console.info('[web-bridge] browser bridge active');
})();
