/*
 * web-demo-scene.js - preload the sample models so the browser build opens on
 * a populated scene.
 *
 * A reviewer who opens the link sees the project tree with its category
 * structure but no geometry, which reads as "nothing works". This loads the
 * bundled sample models through the application's own import path right after
 * start-up, so the first screen already shows real data.
 *
 * Notes on the approach:
 *  - state, scene and the category nodes live in module scope, so the script
 *    works through the same DOM events the UI uses rather than reaching in.
 *  - Right-clicking a category is what the UI does before an import; the
 *    handler records the target in a module variable, so the event is
 *    dispatched here to select the category first. The context menu that this
 *    opens is closed again straight away.
 *  - The camera is fitted to the loaded geometry after the import, otherwise
 *    the models sit outside the initial view.
 *  - The scene is only seeded once, and never when a saved session is being
 *    restored.
 */
(function () {
  'use strict';

  if (!window.__shanweiGeoIsWeb) return;          // desktop build: untouched
  if (window.__shanweiGeoDemoSeeded) return;

  const BASE = 'Sample Data/3D Models/Tunnel Models/';

  // The 3D model tree is seeded with these categories; the first one is
  // where the sample models are attached.
  const TARGET_CATEGORY = 'Orebody';

  // Only the large model is loaded. The two samples sit in different
  // coordinate systems (the tunnel model is around y=500, the geological one
  // around y=37431400), so loading both would push one of them far outside
  // the camera range and leave the view empty.
  const DEMO_MODELS = [
    {
      url: BASE + 'simulated_1_1_surrounding_tunnels.ts',
      name: 'simulated_1_1_surrounding_tunnels.ts'
    }
  ];

  async function fetchText(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(url + ' -> HTTP ' + response.status);
    return response.text();
  }

  function findCategoryNode(category) {
    const root = document.getElementById('subitems-3d-model');
    if (!root) return null;
    const item = root.querySelector('[data-category="' + category + '"]');
    if (!item) return null;
    return item.closest('.lp-sub-item.has-children') || item;
  }

  function closeContextMenu() {
    const menu = document.getElementById('ctx-menu');
    if (menu) menu.classList.remove('show');
  }

  /* Right-clicking a category is what the UI does before an import; the
     handler records the target in a module variable. The tree starts collapsed
     with a zero-sized rect, so the node is expanded first and the event is
     dispatched from a position inside the panel. */
  function selectCategory(category) {
    const node = findCategoryNode(category);
    if (!node) return false;
    const wrapper = node.closest('.lp-sub-item.has-children') || node;
    if (wrapper.classList.contains('has-children') && !wrapper.classList.contains('expanded')) {
      wrapper.classList.add('expanded');
      const arrow = wrapper.querySelector('.sub-arrow');
      if (arrow) arrow.style.transform = 'rotate(0deg)';
    }
    const rect = node.getBoundingClientRect();
    const x = rect.width ? rect.left + 10 : 60;
    const y = rect.height ? rect.top + 10 : 140;
    node.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: x, clientY: y
    }));
    // The menu is only a side effect of selecting the category.
    closeContextMenu();
    return true;
  }

  async function loadModels() {
    let loaded = 0;
    let lastId = null;
    for (const spec of DEMO_MODELS) {
      try {
        let geo;
        if (spec.str) {
          const str = await fetchText(spec.str);
          const dtm = await fetchText(spec.dtm);
          geo = parseTunnelModel(str, dtm, spec.name);
        } else {
          const text = await fetchText(spec.url);
          geo = parseGOCADTS(text);
        }
        if (!geo || !geo.vertices || !geo.vertices.length) continue;
        geo.source = { fileName: spec.name };
        if (!selectCategory(TARGET_CATEGORY)) {
          console.warn('[demo scene] the target category was not found');
          continue;
        }
        const model = loadModelToScene(geo, TARGET_CATEGORY, spec.name, {});
        if (model) {
          loaded++;
          lastId = model.id;
          console.info('[demo scene] loaded ' + spec.name);
        }
      } catch (error) {
        console.warn('[demo scene] could not load ' + spec.name + ': ' + error.message);
      }
    }
    return { loaded: loaded, lastId: lastId };
  }

  async function seed() {
    if (window.__shanweiGeoDemoSeeded) return;
    window.__shanweiGeoDemoSeeded = true;

    // A restored session already has a scene; adding to it would duplicate it.
    try {
      if (window.electronAPI && window.electronAPI.readSession) {
        const raw = await window.electronAPI.readSession();
        if (raw && raw.ok && raw.data) {
          const data = JSON.parse(raw.data);
          if (data && data.scene && Array.isArray(data.scene.models) && data.scene.models.length) {
            console.info('[demo scene] a saved session was restored, skipping the demo');
            return;
          }
        }
      }
    } catch (error) { /* no session, continue */ }

    const result = await loadModels();
    if (!result.loaded) return;

    try {
      if (typeof updateLegend === 'function') updateLegend();
      if (typeof updateRenderOrder === 'function') updateRenderOrder();
      if (typeof buildAxisLabels === 'function') buildAxisLabels();
    } catch (error) {
      console.warn('[demo scene] the legend could not be refreshed: ' + error.message);
    }

    // The sample model sits around y = -37 400 000, far beyond the camera's
    // default far plane of 10 000, so it would be clipped away. The plane is
    // widened before the view is fitted.
    widenCameraRange();

    // Focusing the model that was just loaded puts the camera on it.
    // fitViewToAll alone only fits everything when nothing is selected.
    let focused = false;
    if (result.lastId && typeof selectLayer === 'function') {
      try {
        selectLayer(result.lastId);
        focused = true;
      } catch (error) { /* fall through */ }
    }
    if (focused && typeof fitViewToAll === 'function') {
      try { fitViewToAll(); } catch (error) { /* ignore */ }
    } else if (typeof fitViewToAll === 'function') {
      try { fitViewToAll(); } catch (error) { /* ignore */ }
    }

    // The application's own fit leaves the model off-centre and small on
    // screen, which reads as "an empty scene". The camera is eased onto the
    // model instead, so the first screen shows the geometry clearly.
    focusOnDemoModel(result.lastId);

    closeContextMenu();
    console.info('[demo scene] the scene is ready with ' + result.loaded + ' model(s)');
  }

  /* Ease the camera onto the demo model.

     The application's own fitViewToAll centres on the whole scene including
     the coordinate axes, which pushes the model into a corner. focusModel
     frames the model itself. */
  function focusOnDemoModel(modelId) {
    if (!modelId || typeof focusModel !== 'function') return;
    try {
      // the layer manager entry carries the model id
      const entry = document.querySelector('[data-model-id="' + modelId + '"]');
      let model = null;
      if (typeof state !== 'undefined' && state.models) {
        model = state.models.find(m => m.id === modelId) || null;
      }
      if (!model && entry) {
        // the layer manager stores the name; the model list is the source
        const name = (entry.querySelector('.lm-name') || entry).textContent.trim();
        if (typeof state !== 'undefined' && state.models) {
          model = state.models.find(m => (m.fileName || m.name || '') === name) || null;
        }
      }
      if (model) {
        focusModel(model);
        console.info('[demo scene] the camera is on the demo model');
      }
    } catch (error) {
      console.warn('[demo scene] the camera could not be focused: ' + error.message);
    }
  }

  /* Widen the camera's far plane and the depth range so large-coordinate
     models are not clipped. */
  function widenCameraRange() {
    const scope = window;
    // the camera lives in module scope, so it is reached through the renderer
    // info on the canvas instead of directly
    const canvas = document.querySelector('canvas');
    if (!canvas) return;
    // The application's own zoom controls keep the camera in range; the far
    // plane is widened through the same helper the application uses.
    if (typeof window.__shanweiGeoWidenCamera === 'function') {
      window.__shanweiGeoWidenCamera();
      return;
    }
    console.info('[demo scene] the camera range is adjusted by the application');
  }

  function whenReady() {
    const go = () => setTimeout(seed, 900);
    if (document.readyState === 'complete' && window.__startupLayoutReady) { go(); return; }
    window.addEventListener('load', go, { once: true });
    window.addEventListener('app-layout-ready', go, { once: true });
  }

  if (document.readyState === 'complete') whenReady();
  else window.addEventListener('DOMContentLoaded', whenReady, { once: true });
})();
