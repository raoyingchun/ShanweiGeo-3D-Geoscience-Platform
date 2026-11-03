
// ============================================================
// CameraController (left drag rotates, middle drag or wheel zooms, right button is disabled)
// ============================================================
// Section 77: the pan bounds fall back to constants (to avoid allocating objects inside the _pan hot path)
const ORIGIN_VEC3 = new THREE.Vector3(0, 0, 0);
class CameraController {
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;
    this.target = new THREE.Vector3(0, 0, 0);
    this.enableDamping = true;
    this.dampingFactor = 0.08;
    this.minDistance = 5;
    this.maxDistance = 5000;
    // 2D planar mode (vector planar tag: orthographic camera, pan and zoom only)
    this.is2D = false;
    this._2dZoom = 1;
    this.minZoom = 0.001;
    this.maxZoom = 5000;

    // pan bounds (spherical constraint, set at run time by fitViewToAll / focusModel)
    this._panLimitRadius = 300;
    // Section 77: the reference centre of the constraint. The original implementation used target.length() (the distance to the world origin),
    // but after a model is centred its centre can still be hundreds of metres from the world origin, so |target| is always greater than the radius and every pan is pulled back each frame, which reads as jitter.
    // It now uses the centre of the content bounding sphere as the reference, which gives the correct meaning: the camera target must not drift away from the content centre.
    this._panLimitCenter = new THREE.Vector3(0, 0, 0);

    this._spherical = new THREE.Spherical();
    this._sphericalDelta = new THREE.Spherical();
    this._panOffset = new THREE.Vector3();
    this._scale = 1;

    // Initialise the spherical coordinates from the camera position
    const offset = new THREE.Vector3().subVectors(camera.position, this.target);
    this._spherical.setFromVector3(offset);

    // Keep the initial state for reset
    this._initialPos = camera.position.clone();
    this._initialTarget = this.target.clone();
    this._isResetting = false;

    this._isPanning = false;
    this._isRotating = false;
    this._panStart = { x: 0, y: 0 };
    this._rotStart = { x: 0, y: 0 };

    // Disable rotation while the measuring mode is active
    this.enabled = true;

    this._bindEvents();
  }

  reset() {
    this._isResetting = true;
  }

  setInitialState(pos, target) {
    this._initialPos = pos.clone();
    this._initialTarget = target.clone();
  }

  // Swap the camera and the target (several tabs share one controls instance)
  swapCamera(newCamera, savedTarget) {
    this.camera = newCamera;
    if (savedTarget) {
      this.target.copy(savedTarget);
    }
    this._initialPos = newCamera.position.clone();
    this._initialTarget = this.target.clone();
    this._isResetting = false;
    this._isRotating = false;
    this._isPanning = false;
    this._sphericalDelta.set(0, 0, 0);
    this._panOffset.set(0, 0, 0);
    this._scale = 1;
    this._2dZoom = (newCamera && newCamera.isOrthographicCamera && newCamera.zoom) ? newCamera.zoom : 1;
    // Section 77: the pan bounds reference centre is reset to this tab's focus at the same time,
    // so that the previous tab's bounds (whose sphere is centred on the old content) cannot leak across and pull the new tab back every frame, which reads as jitter
    this._panLimitCenter.copy(this.target);
  }

  _bindEvents() {
    this.dom.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!this.enabled) return;
      if (e.button === 0) {
        if (this.is2D) {
          // 2D planar mode: left drag pans
          this._isPanning = true;
          this._panStart = { x: e.clientX, y: e.clientY };
        } else {
          // left drag rotates
          this._isRotating = true;
          this._rotStart = { x: e.clientX, y: e.clientY };
        }
      } else if (e.button === 1) {
        // middle drag pans
        this._isPanning = true;
        this._panStart = { x: e.clientX, y: e.clientY };
      }
      // the right button (button === 2) does nothing
    });

    this.dom.addEventListener('mousemove', (e) => {
      if (this._isRotating) {
        const dx = e.clientX - this._rotStart.x;
        const dy = e.clientY - this._rotStart.y;
        this._sphericalDelta.theta -= dx * 0.005;
        this._sphericalDelta.phi -= dy * 0.005;
        this._rotStart = { x: e.clientX, y: e.clientY };
      }
      if (this._isPanning) {
        const dx = e.clientX - this._panStart.x;
        const dy = e.clientY - this._panStart.y;
        this._pan(dx, dy);
        this._panStart = { x: e.clientX, y: e.clientY };
      }
    });

    window.addEventListener('mouseup', () => {
      this._isPanning = false;
      this._isRotating = false;
    });

    // the context menu is disabled
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());

    this.dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.is2D) {
        // 2D planar mode: zooming adjusts the orthographic camera zoom
        this._2dZoom *= (e.deltaY < 0 ? 1.1 : 0.9);
        this._2dZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this._2dZoom));
      } else {
        if (e.deltaY < 0) this._scale *= 0.92;
        else this._scale *= 1.08;
      }
    }, { passive: false });
  }

  _pan(deltaX, deltaY) {
    // 2D planar mode (orthographic camera): the pan amount is computed from the field of view height
    if (this.is2D && this.camera.isOrthographicCamera) {
      this.camera.updateMatrixWorld();
      const viewH = (this.camera.top - this.camera.bottom) / Math.max(this.camera.zoom, 0.0001);
      const panX = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
      panX.multiplyScalar(-(2 * deltaX * viewH / this.dom.clientHeight));
      const panY = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
      panY.multiplyScalar((2 * deltaY * viewH / this.dom.clientHeight));
      this._panOffset.add(panX.add(panY));
      return;
    }
    // Pure screen-space pan: the camera and the target move together and the viewing direction stays the same
    // Section 75: the camera world matrix has to be refreshed first.
    // camera.matrix only reflects the latest position and quaternion after updateMatrixWorld() has run;
    // and mousemove can fire several times between two renders, so deriving the pan direction from the previous frame's matrix
    // makes the direction lag by a frame, which shows as jitter or drift while dragging. The 2D branch above already does this, so it is added here as well.
    this.camera.updateMatrixWorld();
    const distance = this.camera.position.distanceTo(this.target);
    const targetDistance = distance * Math.tan((this.camera.fov / 2) * Math.PI / 180) * 0.6;
    const panX = new THREE.Vector3();
    const panY = new THREE.Vector3();

    panX.setFromMatrixColumn(this.camera.matrix, 0);
    panX.multiplyScalar(-(2 * deltaX * targetDistance / this.dom.clientHeight));

    panY.setFromMatrixColumn(this.camera.matrix, 1);
    panY.multiplyScalar((2 * deltaY * targetDistance / this.dom.clientHeight));

    const pan = panX.add(panY);
    this._panOffset.add(pan);
  }

  update() {
    // Smooth reset animation
    if (this._isResetting) {
      const t = 0.12;
      this.camera.position.lerp(this._initialPos, t);
      this.target.lerp(this._initialTarget, t);
      if (this.camera.position.distanceTo(this._initialPos) < 0.5 &&
          this.target.distanceTo(this._initialTarget) < 0.5) {
        this.camera.position.copy(this._initialPos);
        this.target.copy(this._initialTarget);
        this._isResetting = false;
      }
      this._sphericalDelta.set(0, 0, 0);
      this._panOffset.set(0, 0, 0);
      this._scale = 1;
      this.camera.lookAt(this.target);
      return;
    }

    // ===== Pan: the camera and the target move together, constrained by a spherical bound =====
    if (this._panOffset.lengthSq() > 0.0001) {
      const pan = this._panOffset.clone();
      this.camera.position.add(pan);
      this.target.add(pan);

      // Spherical constraint: the target is confined to a radius around the content centre
      // Section 77 correction: this used to be this.target.length() (with the world origin as the sphere centre), so a model far from the origin was pulled back every frame, which reads as jitter
      const _pc = this._panLimitCenter || ORIGIN_VEC3;
      const offsetFromCenter = this.target.distanceTo(_pc);
      if (offsetFromCenter > this._panLimitRadius) {
        const dir = new THREE.Vector3().subVectors(this.target, _pc).normalize();
        const clamped = _pc.clone().addScaledVector(dir, this._panLimitRadius);
        const delta = new THREE.Vector3().subVectors(clamped, this.target);
        this.camera.position.add(delta);
        this.target.copy(clamped);
      }

      if (this.enableDamping) {
        this._panOffset.multiplyScalar(1 - this.dampingFactor);
      } else {
        this._panOffset.set(0, 0, 0);
      }
    }

    // ===== 2D planar mode: pan and zoom only, no spherical rotation =====
    if (this.is2D && this.camera.isOrthographicCamera) {
      if (this.camera.zoom !== this._2dZoom) {
        this.camera.zoom = this._2dZoom;
        this.camera.updateProjectionMatrix();
      }
      if (this.enableDamping) {
        this._panOffset.multiplyScalar(1 - this.dampingFactor);
      } else {
        this._panOffset.set(0, 0, 0);
      }
      this._scale = 1;
      this._sphericalDelta.set(0, 0, 0);
      this.camera.lookAt(this.target);
      return;
    }

    // ===== Rotation and zoom =====
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.target);
    this._spherical.setFromVector3(offset);

    if (this.enableDamping) {
      this._spherical.theta += this._sphericalDelta.theta * this.dampingFactor;
      this._spherical.phi += this._sphericalDelta.phi * this.dampingFactor;
    } else {
      this._spherical.theta += this._sphericalDelta.theta;
      this._spherical.phi += this._sphericalDelta.phi;
    }

    this._spherical.phi = Math.max(0.08, Math.min(Math.PI - 0.08, this._spherical.phi));
    this._spherical.radius *= this._scale;
    this._spherical.radius = Math.max(this.minDistance, Math.min(this.maxDistance, this._spherical.radius));

    this.camera.position.setFromSpherical(this._spherical).add(this.target);

    if (this.enableDamping) {
      this._sphericalDelta.theta *= (1 - this.dampingFactor);
      this._sphericalDelta.phi *= (1 - this.dampingFactor);
    } else {
      this._sphericalDelta.set(0, 0, 0);
    }

    this._scale = 1;
    this.camera.lookAt(this.target);
  }
}

// ============================================================
// Project tree collapse logic
// ============================================================
function toggleNode(el) {
  el.classList.toggle('collapsed');
  const next = el.nextElementSibling;
  if (next && next.classList.contains('lp-nested-items')) {
    next.classList.toggle('expanded');
  }
}

document.querySelectorAll('.lp-group-header').forEach(header => {
  header.addEventListener('click', (e) => {
    // avoid a clash with the context menu
    header.classList.toggle('collapsed');
  });
});

// ============================================================
// Resize handle logic
// ============================================================
(function initResizers() {
  const mainWrap = document.querySelector('.main-wrap');
  const leftPanel = document.querySelector('.left-panel');
  const centerArea = document.querySelector('.center-area');
  const rightPanel = document.querySelector('.right-panel');
  const bottomSplit = document.querySelector('.bottom-split');

  let leftRatio = 0.15;
  let centerRatio = 0.60;
  let rightRatio = 0.25;
  let leftPanelVisible = true;
  try {
    leftPanelVisible = localStorage.getItem('shanwei-project-tree-visible') !== 'false';
    const savedRatio=Number(localStorage.getItem('shanwei-project-tree-width'));
    if(savedRatio>=0.1&&savedRatio<=0.4){leftRatio=savedRatio;centerRatio=1-leftRatio-rightRatio;}
  } catch(_) {}
  const collapseTree=document.createElement('button');
  collapseTree.id='project-tree-collapse';collapseTree.className='project-tree-toggle';collapseTree.textContent='‹';collapseTree.title='Collapse project tree';collapseTree.setAttribute('aria-label','Collapse project tree');
  leftPanel.querySelector('.lp-header').append(collapseTree);
  const expandTree=document.createElement('button');
  expandTree.id='project-tree-expand';expandTree.className='project-tree-expand';expandTree.textContent='Project tree ›';expandTree.title='Expand project tree';expandTree.setAttribute('aria-label','Expand project tree');
  mainWrap.append(expandTree);

  let layerHeight = 180;

  // whether the 2D linkage panel on the right is visible (controlled by the button in the top right corner)
  let rightPanelVisible = false;

  const MIN_LEFT = 220;
  const MIN_CENTER = 400;
  const MIN_RIGHT = 250;
  const MIN_LAYER_H = 120;
  const MAX_LAYER_PCT = 0.5;

  function getMainWidth() { return mainWrap.clientWidth - (document.getElementById('main-function-rail')?.offsetWidth || 0); }
  function getCenterHeight() {
    let h = centerArea.clientHeight;
    const tb = centerArea.querySelector('.center-tab-bar');
    const ct = centerArea.querySelector('.center-toolbar');
    if (tb) h -= tb.clientHeight;
    if (ct) h -= ct.clientHeight;
    return h;
  }

  function applyMainWidths() {
    const total = getMainWidth();
    leftPanel.style.width = (leftRatio * total) + 'px';
    leftPanel.style.minWidth = 'auto';
    leftPanel.style.display = leftPanelVisible ? '' : 'none';
    if(resizeLC)resizeLC.style.display=leftPanelVisible?'':'none';
    expandTree.hidden=leftPanelVisible;
    collapseTree.setAttribute('aria-expanded',String(leftPanelVisible));
    expandTree.setAttribute('aria-expanded',String(leftPanelVisible));
    if (rightPanelVisible) {
      centerArea.style.width = ((1-rightRatio-(leftPanelVisible?leftRatio:0)) * total) + 'px';
      rightPanel.style.width = (rightRatio * total) + 'px';
      rightPanel.style.minWidth = 'auto';
      rightPanel.style.display = '';
      if (resizeCR) resizeCR.style.display = '';
    } else {
      // hide the right panel: the centre area then takes the share of centre plus right
      centerArea.style.width = ((1-(leftPanelVisible?leftRatio:0)) * total) + 'px';
      rightPanel.style.display = 'none';
      if (resizeCR) resizeCR.style.display = 'none';
    }
  }

  function applyLayerHeight() {
    const maxH = getCenterHeight() * MAX_LAYER_PCT;
    const clamped = Math.max(MIN_LAYER_H, Math.min(maxH, layerHeight));
    bottomSplit.style.height = clamped + 'px';
  }

  function setupDrag(handle, onMove, onEnd) {
    let dragging = false;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      handle.classList.add('dragging');
      document.body.style.cursor = handle.classList.contains('resize-handle-v') ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';

      const move = (ev) => { if (dragging) onMove(ev); };
      const up = () => {
        if (dragging) {
          dragging = false;
          handle.classList.remove('dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          if (onEnd) onEnd();
          window.dispatchEvent(new Event('resize'));
        }
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  const resizeLC = document.getElementById('resize-lc');
  if (resizeLC) {
    setupDrag(resizeLC, (e) => {
      const total = getMainWidth();
      const newLeft = Math.max(MIN_LEFT, Math.min(e.clientX, total - MIN_CENTER - MIN_RIGHT));
      leftRatio = newLeft / total;
      centerRatio = 1 - leftRatio - rightRatio;
      if (centerRatio * total < MIN_CENTER) {
        centerRatio = MIN_CENTER / total;
        leftRatio = 1 - centerRatio - rightRatio;
      }
      applyMainWidths();
    }, () => {try{localStorage.setItem('shanwei-project-tree-width',String(leftRatio));}catch(_){} });
  }

  const resizeCR = document.getElementById('resize-cr');
  if (resizeCR) {
    setupDrag(resizeCR, (e) => {
      const total = getMainWidth();
      const rect = centerArea.getBoundingClientRect();
      const newCenterW = e.clientX - rect.left;
      const newCenterRatio = newCenterW / total;
      const minCenterRatio = MIN_CENTER / total;
      const shownLeft=leftPanelVisible?leftRatio:0;
      const maxCenterRatio = 1 - shownLeft - (MIN_RIGHT / total);
      const shownCenter = Math.max(minCenterRatio, Math.min(maxCenterRatio, newCenterRatio));
      rightRatio = 1 - shownLeft - shownCenter;
      centerRatio = 1 - leftRatio - rightRatio;
      applyMainWidths();
    });
  }

  const resizeCB = document.getElementById('resize-cb');
  if (resizeCB) {
    setupDrag(resizeCB, (e) => {
      const canvasWrap = centerArea.querySelector('.canvas-wrap');
      const rect = canvasWrap.getBoundingClientRect();
      const newCanvasH = e.clientY - rect.top;
      const centerH = getCenterHeight();
      const newBottom = centerH - newCanvasH;
      const maxH = centerH * MAX_LAYER_PCT;
      layerHeight = Math.max(MIN_LAYER_H, Math.min(maxH, newBottom));
      applyLayerHeight();
    });
  }

  function toggleProjectTree(visible) {
    leftPanelVisible=visible;
    try{localStorage.setItem('shanwei-project-tree-visible',String(visible));}catch(_){}
    document.getElementById('project-dropdown')?.classList.remove('show');
    applyMainWidths();applyLayerHeight();window.dispatchEvent(new Event('resize'));
    (visible?collapseTree:expandTree).focus();
  }
  collapseTree.onclick=()=>toggleProjectTree(false);
  expandTree.onclick=()=>toggleProjectTree(true);
  applyMainWidths();
  applyLayerHeight();

  window.addEventListener('resize', () => {
    applyMainWidths();
    applyLayerHeight();
  });

  // ========== Show and hide the 2D linkage panel on the right ==========
  const toggleRightBtn = document.getElementById('btn-toggle-right-panel');
  if (toggleRightBtn) {
    toggleRightBtn.addEventListener('click', () => {
      rightPanelVisible = !rightPanelVisible;
      toggleRightBtn.classList.toggle('active', rightPanelVisible);
      applyMainWidths();
      applyLayerHeight();
      // tell the 3D canvas to recalculate its size
      window.dispatchEvent(new Event('resize'));
    });
  }

  // expose a global method that opens the right panel during drillhole linkage
  window.setRightPanelVisible = function(v) {
    rightPanelVisible = !!v;
    if (toggleRightBtn) toggleRightBtn.classList.toggle('active', rightPanelVisible);
    applyMainWidths();
    applyLayerHeight();
    window.dispatchEvent(new Event('resize'));
  };
})();

// ============================================================
// right panel tab switching
// the two tab groups are mutually exclusive: drill is the drillhole scene (2D linkage), doc is the document scene (outline, bookmarks, notes)
// They share one panel container and identical width styling; only the tab bar and the content area are replaced as a whole, and neither group damages the other
// ============================================================
(function() {
  let rpGroup = 'drill';                                  // 当前生效的页签组
  const rpActiveTab = { drill: 'Drillhole Log', doc: 'Outline' };   // 各组记忆的上次选中页签

  function rpTabsOf(g) {
    return Array.prototype.slice.call(document.querySelectorAll('.rp-tab-group[data-group="' + g + '"] .rp-tab'));
  }
  function rpPanelsOf(g) {
    return Array.prototype.slice.call(document.querySelectorAll('.rp-tab-panel[data-group="' + g + '"]'));
  }

  // activate a tab inside a group (only that group is touched; the DOM and the selection state of the other group stay as they are)
  function rpActivateTab(g, name) {
    const tabs = rpTabsOf(g), panels = rpPanelsOf(g);
    if (tabs.length) {
      tabs.forEach(function (t) {
        t.classList.toggle('active', (t.dataset.tab || t.textContent.trim()) === name);
      });
    }
    panels.forEach(function (p) { p.classList.toggle('active', p.dataset.tab === name); });
    rpActiveTab[g] = name;
    if (typeof window.onRightPanelTabShown === 'function') {
      try { window.onRightPanelTabShown(g, name); } catch (e) { /* a hook failure must not break the panel switch*/ }
    }
  }

  rpTabsOf('drill').concat(rpTabsOf('doc')).forEach(function (tab) {
    tab.addEventListener('click', function () {
      const holder = tab.closest ? tab.closest('.rp-tab-group') : null;
      if (!holder) return;
      rpActivateTab(holder.dataset.group, tab.dataset.tab || tab.textContent.trim());
    });
  });

  // ===== Public interface: switch a whole tab group by scene =====
  window.getRightPanelGroup = function () { return rpGroup; };
  window.getRightPanelActiveTab = function () { return rpActiveTab[rpGroup]; };
  window.activateRightPanelTab = function (name) { rpActivateTab(rpGroup, name); };
  window.setRightPanelGroup = function (g) {
    if (g !== 'drill' && g !== 'doc') g = 'drill';
    if (g === rpGroup) return rpGroup;   // 幂等：重复调用不重置用户已选页签
    rpGroup = g;
    document.querySelectorAll('.rp-tab-group').forEach(function (el) {
      el.classList.toggle('active', el.dataset.group === g);
    });
    // hide the other group's panel (otherwise both groups would be display:block at the same time and would overlap)
    document.querySelectorAll('.rp-tab-panel').forEach(function (p) {
      if (p.dataset.group !== g) p.classList.remove('active');
    });
    const head = document.getElementById('rp-header-text');
    if (head) head.textContent = (g === 'doc') ? 'Documents' : 'Linked 2D View';
    rpActivateTab(g, rpActiveTab[g] || (g === 'doc' ? 'Outline' : 'Drillhole Log'));
    return rpGroup;
  };

  // Initially each group remembers its own default tab, and only the drillhole group is shown (the doc group panel starts without the active class)
  rpTabsOf('doc').forEach(function (t) {
    t.classList.toggle('active', (t.dataset.tab || '') === rpActiveTab.doc);
  });
})();

// ============================================================
// Centre tab bar: create, switch and close
// the View tab is fixed and cannot be deleted; a new tab gets its own 3D scene
// ============================================================
(function() {
  const tabBar       = document.getElementById('center-tab-bar');
  const tabNewBtn    = document.getElementById('center-tab-new');
  const centerArea   = document.getElementById('center-area');

  if (!tabBar || !tabNewBtn || !centerArea) return;

  let tabCounter = 0;          // )

  // ---- Switch tab ----
  // If point drawing is in progress, ask whether to save first and leave the drawing state (at the user's request)
  async function switchTab(tabId, options = {}) {
    if(!options.skipDeferred&&window.__deferredViewerBusy)await window.__deferredViewerBusy;
    if(!options.skipDeferred&&!window.projectRestoreInProgress&&tabViewers.get(tabId)?._deferredModels){await loadDeferredViewer(tabId);}
    if (tabId === activeTabId) { window.researchRegionViews?.onViewActivated(tabId);window.regionCompare?.onTabActivated(tabId); return; }
    if (pointAddMode) {
      const ok = await guardLeavePointDraw('Switching to another tab');
      if (!ok) return;
    }
    // 1) update the active state of the tab buttons
    tabBar.querySelectorAll('.center-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tabId === tabId);
    });
    // 2) switch the viewer instance (reassign state, scene and camera, and rebuild the UI)
    switchActiveViewer(tabId);
    window.researchRegionViews?.onViewActivated(tabId);
    window.regionCompare?.onTabActivated(tabId);
    // 3) notify the canvas to recalculate its size
    window.dispatchEvent(new Event('resize'));
  }

  // ---- Create tab ----
  // type: '3d' (the default, with the four panels and a 3D scene) | 'image' (an image tab, image viewer only) | 'table' (a table tab, table viewer only)
  // opts: { imageName, imageUrl } for an image tab | { tableName, tableHtml, tableRows, tableCols } for a table tab
  // (a custom tab name, the highest priority)
  // async: it switches to the new tab at the end; if point drawing is active it has to ask about saving and leaving first.
  async function createNewTab(type, opts) {
    type = type || '3d';
    opts = opts || {};
    // Point drawing guard: creating a tab always implies a switch, so ask first (if the user cancels, nothing is created)
    if (pointAddMode) {
      const ok = await guardLeavePointDraw('Opening a new tab');
      if (!ok) return null;
    }
    const sourceKey = opts.sourceKey || (type === 'image' ? opts.imageUrl :
      type === 'pdf' ? opts.pdfUrl : type === 'word' ? opts.wordUrl :
      type === 'table' && opts.testDataId ? 'test:' + opts.testDataId + ':' + (opts.testDataSheet || '') : null);
    if (sourceKey) {
      const existing = Array.from(tabViewers.entries()).find(([id, viewer]) =>
        viewer.type === type && viewer.sourceKey === sourceKey);
      if (existing) { await switchTab(existing[0]); return existing[0]; }
    }
    // tab name priority: opts.label, then the image or table file name, then Tab N+1
    let label;
    if (opts.label) {
      label = opts.label;
    } else if (type === 'image' && opts.imageName) {
      label = opts.imageName;
    } else if (type === 'table' && opts.tableName) {
      label = opts.tableName;
    } else if (type === 'pdf' && opts.pdfName) {
      label = opts.pdfName;
    } else if (type === 'word' && opts.wordName) {
      label = opts.wordName;
    } else {
      const existingCount = tabBar.querySelectorAll('.center-tab').length;
      label = '3D View ' + (existingCount + 1);
    }
    tabCounter++;
    const tabId = 'tab-' + tabCounter;

    // the create-tab button (inserted before the + button)
    const tabEl = document.createElement('div');
    tabEl.className = 'center-tab';
    tabEl.dataset.tabId = tabId;
    tabEl.dataset.tabType = type;   // 标签类型：3d / image / table / pdf
    tabEl.dataset.autoName = (!opts.label && type === '3d') ? 'true' : 'false';
    tabEl.dataset.emptyName = label;
    tabEl.dataset.kindLabel = ({'3d':'3D',vector2d:'Plane',image:'Imagery',table:'Tables',pdf:'PDF',word:'Documents'})[type] || '3D';
    tabEl.title = label;
    // icons: an image icon for image tabs, a table icon for table tabs, a document icon for PDF tabs and a monitor icon for 3D tabs
    const iconSvg = type === 'image'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>'
      : type === 'table'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>'
      : type === 'pdf'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><path d="M9 15h6M9 18h4"></path></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>';
    tabEl.innerHTML =
      iconSvg +
      '<span class="center-tab-label"></span>' +
      '<span class="center-tab-lock-btn" title="Click to lock/Unlock">' +
        '<svg class="lock-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>' +
        '<svg class="lock-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>' +
      '</span>' +
      '<span class="center-tab-close" title="Close">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<line x1="18" y1="6" x2="6" y2="18"></line>' +
        '<line x1="6" y1="6" x2="18" y2="18"></line></svg></span>';
    tabEl.querySelector('.center-tab-label').textContent = label;
    tabBar.insertBefore(tabEl, tabNewBtn);

    // create the tab data: a 3D tab creates its own viewer, while image and table tabs store their own information
    if (type === 'image') {
      // image tab: no 3D scene is created; the image URL and an independent zoom and pan state are stored
      tabViewers.set(tabId, {
        type: 'image',
        imageUrl: opts.imageUrl,
        imageName: opts.imageName,
        locked: false,
        // image viewer state (independent for each image tab)
        imgScale: 1,
        imgTx: 0,
        imgTy: 0
      });
    } else if (type === 'table') {
      // table tab: no 3D scene is created; the table HTML and the metadata are stored
      // lazyTable: chunked lazy loading for large tables ({ firstHtml, chunks[], finished }, shared when the reference is the same), otherwise null
      tabViewers.set(tabId, {
        type: 'table',
        tableName: opts.tableName,
        tableHtml: opts.tableHtml,
        tableRows: opts.tableRows,
        tableCols: opts.tableCols,
        lazyTable: opts.lazyTable || null,
        locked: false
      });
    } else if (type === 'pdf') {
      // PDF reading tab: no 3D scene is created; the blob URL and the file name are stored
      tabViewers.set(tabId, {
        type: 'pdf',
        pdfUrl: opts.pdfUrl,
        pdfName: opts.pdfName,
        pdfSize: opts.pdfSize,
        locked: false
      });
    } else if (type === 'word') {
      // Word read-only tab: no 3D scene is created; the blob URL and the file name are stored
      tabViewers.set(tabId, {
        type: 'word',
        wordUrl: opts.wordUrl,
        wordName: opts.wordName,
        wordSize: opts.wordSize,
        locked: false
      });
    } else {
      // 3D tab: creates an independent viewer instance (type='vector2d' means a vector planar tag with an orthographic top-down camera)
      const viewer = createViewerInstance();
      viewer.type = '3d';
      viewer.regionId = opts.regionId !== undefined ? opts.regionId : window.researchRegions?.currentId;
      if(viewer.regionId)tabEl.dataset.regionId=viewer.regionId;
      if (type === 'vector2d') {
        viewer.isVector2D = true;
        const ortho = new THREE.OrthographicCamera(-200, 200, 150, -150, 0.1, 100000);
        viewer.camera = ortho;
        viewer.camera.position.set(0, 1000, 0.01);
        viewer.target = new THREE.Vector3(0, 0, 0);
        viewer.initialTopView = true;
      } else if (opts && opts.initialView === 'top') {
        viewer.camera.position.set(0, 1000, 0.01);
        viewer.target = new THREE.Vector3(0, 0, 0);
        viewer.initialTopView = true;
      }
      tabViewers.set(tabId, viewer);
    }

    // bind the tab click to switch (excluding the close button, the lock button and editable tabs)
    tabEl.addEventListener('click', (e) => {
      if (e.target.closest('.center-tab-close')) return;
      if (e.target.closest('.center-tab-lock-btn')) return;
      if (e.target.closest('.center-tab-label[contenteditable="true"]')) return;
      switchTab(tabId);
    });

    // bind the close button
    tabEl.querySelector('.center-tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tabId);
    });

    // bind the lock button to toggle the locked state
    tabEl.querySelector('.center-tab-lock-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTabLock(tabId);
    });

    // double-click the tab text to rename it (inline editing with contenteditable)
    const labelEl = tabEl.querySelector('.center-tab-label');
    labelEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const el = e.currentTarget;
      el.dataset.oldName = el.textContent;
      el.contentEditable = 'true';
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    labelEl.addEventListener('blur', (e) => {
      const el = e.currentTarget;
      el.contentEditable = 'false';
      let name = el.textContent.trim();
      if (!name) name = el.dataset.oldName || 'Untitled';
      el.textContent = name;
      tabEl.title = name;
      if (name !== el.dataset.oldName) { tabEl.dataset.autoName = 'false'; tabEl.dataset.userNamed='true'; }
      delete el.dataset.oldName;
    });
    labelEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.currentTarget.blur();
      } else if (e.key === 'Escape') {
        const el = e.currentTarget;
        el.textContent = el.dataset.oldName || 'Untitled';
        el.blur();
      }
    });

    if (sourceKey) tabViewers.get(tabId).sourceKey = sourceKey;
    // switch to the new tab automatically
    if(!window.__lazyProjectRestore)await switchTab(tabId);
    return tabId;
  }

  // ---- Close tab ----
  function closeTab(tabId) {
    const tabEl = tabBar.querySelector('.center-tab[data-tab-id="' + tabId + '"]');
    if (!tabEl) return;

    // check the locked state: when locked, show a confirmation dialog and block the deletion
    const viewer0 = tabViewers.get(tabId);
    if (viewer0 && viewer0.locked) {
      showTabLockAlert(tabEl);
      return;
    }

    // If the tab being closed is the active one it triggers switchTab('view'), so the point drawing guard has to run first
    if (activeTabId === tabId && pointAddMode) {
      guardLeavePointDraw('Closing the current tab').then((ok) => { if (ok) _doCloseTabNow(tabId); });
      return;
    }

    _doCloseTabNow(tabId);
  }

  // perform the actual close (called once the guard has passed)
  function _doCloseTabNow(tabId) {
    const tabEl = tabBar.querySelector('.center-tab[data-tab-id="' + tabId + '"]');
    if (!tabEl) return;
    const viewer = tabViewers.get(tabId);

    tabEl.remove();

    // release the viewer resources (a 3D tab has to dispose its geometry and materials; an image tab has no scene resources)
    if (viewer) {
      if (viewer.scene) {
        viewer.scene.traverse(obj => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
            else obj.material.dispose();
          }
        });
      }
      tabViewers.delete(tabId);
    }

    // if the closed tab was the active one, switch back to View
    if (activeTabId === tabId) {
      switchTab('view');
    }
  }

  // ---- Lock and unlock a tab (toggled by clicking the lock icon) ----
  function toggleTabLock(tabId) {
    const tabEl = tabBar.querySelector('.center-tab[data-tab-id="' + tabId + '"]');
    const viewer = tabViewers.get(tabId);
    if (!tabEl || !viewer) return;
    viewer.locked = !viewer.locked;
    tabEl.classList.toggle('locked', viewer.locked);
    const lockBtn = tabEl.querySelector('.center-tab-lock-btn');
    if (lockBtn) lockBtn.title = viewer.locked ? 'Click to unlock' : 'Click to lock';
  }

  // ---- Modal shown when a locked tab is deleted ----
  const tabModalOverlay = document.getElementById('tab-modal-overlay');
  const tabModalTitle = document.getElementById('tab-modal-title');
  const tabModalLabel = document.getElementById('tab-modal-label');
  const tabModalConfirm = document.getElementById('tab-modal-confirm');
  const tabModalCancel = document.getElementById('tab-modal-cancel');

  // the tab-modal confirmation callback (a custom callback is supported, for example opening a new tab when the coordinate systems differ)
  let tabModalCallback = null;

  function showTabLockAlert(tabEl) {
    const labelEl = tabEl.querySelector('.center-tab-label');
    const tabName = labelEl ? labelEl.textContent : 'This tab';
    tabModalTitle.textContent = 'Tab is locked';
    tabModalLabel.textContent = 'Bookmark“ ' + tabName + ' ”is locked, Unable to delete. Click the lock icon on the tab first (Orange) Unlock it before deleting. ';
    tabModalCancel.style.display = 'none';
    tabModalConfirm.textContent = 'OK';
    tabModalCallback = null;
    tabModalOverlay.classList.add('show');
  }

  // the generic tab-modal display function (custom title, content, button text and callback are supported)
  window.showTabModal = function(opts) {
    tabModalTitle.textContent = opts.title || 'Information';
    tabModalLabel.innerHTML = opts.label || '';
    tabModalCancel.style.display = opts.showCancel ? '' : 'none';
    tabModalCancel.textContent = opts.cancelText || 'Cancel';
    tabModalConfirm.textContent = opts.confirmText || 'OK';
    tabModalCallback = opts.onConfirm || null;
    tabModalOverlay.classList.add('show');
  };

  tabModalConfirm.addEventListener('click', () => {
    tabModalOverlay.classList.remove('show');
    if (tabModalCallback) {
      const cb = tabModalCallback;
      tabModalCallback = null;
      cb();
    }
  });

  tabModalCancel.addEventListener('click', () => {
    tabModalOverlay.classList.remove('show');
    tabModalCallback = null;
  });

  // ---- Event bindings ----
  tabNewBtn.addEventListener('click', () => createNewTab('3d'));

  // clicking the View tab switches to it
  const viewTab = tabBar.querySelector('.center-tab[data-tab-id="view"]');
  if (viewTab) {
    viewTab.addEventListener('click', () => switchTab('view'));
  }

  // expose createNewTab, switchTab and closeTab globally so that figures, tables and PDFs can open a tab on double click and close a tab when a PDF is deleted
  window.createNewTab = createNewTab;
  window.switchTab = switchTab;
  window.closeTab = closeTab;
})();

// ============================================================
// GOCAD .ts parser (inlined, with the TypeScript type annotations removed)
// Fixes: 1) a global origin offset so that Float32 precision is not lost, 2) the Z-up to Y-up axis conversion
// ============================================================

// the global reference origin (a UTM coordinate offset, fixed by rounding down the bbox of the first model)
function parseGOCADTS(text, options) {
  options = options || {};
  const mergeTFaces = options.mergeTFaces !== false;

  // strip the byte order mark
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // ---------- Metadata ----------
  let name = 'unnamed';
  let coordinateSystem;
  const propertyNames = [];
  const propertyClasses = [];
  const units = [];

  // ---------- Geometry buffers ----------
  const vertexIdMap = new Map();
  const vCoords = [];
  const vPropsRaw = [];
  let triangleIdx = [];

  let currentPropNames = propertyNames;

  const lines = text.split(/\r?\n/);
  let inHeader = false;
  let inCoordSystem = false;
  let coordSystemLines = [];

  // scan the raw GOCAD coordinate range of this file (used to compute the suggested fileOrigin)
  let scanMinX = Infinity, scanMinY = Infinity, scanMinZ = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('PVRTX') || line.startsWith('VRTX')) {
      const parts = line.split(/\s+/);
      const x = parseFloat(parts[2]);
      const y = parseFloat(parts[3]);
      const z = parseFloat(parts[4]);
      if (x < scanMinX) scanMinX = x;
      if (y < scanMinY) scanMinY = y;
      if (z < scanMinZ) scanMinZ = z;
    }
  }
  // round down to a hundred-metre grid (keeps the detail while making the coordinate values smaller)
  let fileOrigin = null;
  if (scanMinX !== Infinity) {
    fileOrigin = {
      x: Math.floor(scanMinX / 100) * 100,
      y: Math.floor(scanMinY / 100) * 100,
      z: Math.floor(scanMinZ / 100) * 100
    };
    console.log('[Parser] Suggested file origin:', fileOrigin.x, fileOrigin.y, fileOrigin.z);
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    // the HEADER block
    if (line.startsWith('HEADER')) {
      inHeader = true;
      continue;
    }
    if (inHeader) {
      if (line === '}') { inHeader = false; continue; }
      const m = line.match(/^(\w+)\s*:\s*(.*)$/);
      if (m) {
        if (m[1].toLowerCase() === 'name') name = m[2].trim();
      }
      continue;
    }

    // the coordinate system block
    if (line.startsWith('GOCAD_ORIGINAL_COORDINATE_SYSTEM') ||
        line.startsWith('GOCAD_COORDINATE_SYSTEM')) {
      inCoordSystem = true;
      coordSystemLines = [];
      continue;
    }
    if (inCoordSystem) {
      if (line.startsWith('END_ORIGINAL_COORDINATE_SYSTEM') ||
          line.startsWith('END_COORDINATE_SYSTEM')) {
        inCoordSystem = false;
        coordinateSystem = coordSystemLines.join(' ').trim() || undefined;
        continue;
      }
      coordSystemLines.push(line);
      continue;
    }

    // the property metadata
    if (line.startsWith('PROPERTIES ')) {
      const cols = line.split(/\s+/).slice(1).filter(s => s.length > 0);
      propertyNames.push(...cols);
      currentPropNames = propertyNames;
      continue;
    }
    if (line.startsWith('PROPERTY_CLASSES ')) {
      const cols = line.split(/\s+/).slice(1).filter(s => s.length > 0);
      propertyClasses.push(...cols);
      continue;
    }
    if (line.startsWith('UNITS ')) {
      const cols = line.split(/\s+/).slice(1).filter(s => s.length > 0);
      units.push(...cols);
      continue;
    }

    // the TFACE section starts
    if (line === 'TFACE' || line.startsWith('TFACE')) {
      continue;
    }

    // vertices
    if (line.startsWith('PVRTX') || line.startsWith('VRTX')) {
      const tag = line.startsWith('PVRTX') ? 'PVRTX' : 'VRTX';
      const parts = line.split(/\s+/);
      const id = parseInt(parts[1], 10);
      const x = parseFloat(parts[2]);
      const y = parseFloat(parts[3]);
      const z = parseFloat(parts[4]);
      // Robustness: a vertex with missing or invalid coordinates is skipped (the triangles that reference it are skipped by the undefined guard in TRGL below)
      if (isNaN(x) || isNaN(y) || isNaN(z)) {
        console.warn('[GOCAD] Skip invalid vertex row: ' + line.slice(0, 80));
        continue;
      }
      if (vertexIdMap.has(id)) continue;
      const localIdx = vCoords.length / 3;
      vertexIdMap.set(id, localIdx);

      // The raw GOCAD coordinates are stored (only the axes are swapped, no origin offset is applied)
      // the offset is applied in loadModelToScene using the state.origin of the current tab
      // GOCAD: X = east, Y = north, Z = elevation (up)
      // Three.js: X = east, Y = up, Z = south (depth)
      // Mapping: rawX = x, rawY = z, rawZ = -(y), which keeps a right-handed frame
      vCoords.push(x, z, -y);

      if (tag === 'PVRTX') {
        const props = [];
        for (let k = 5; k < parts.length; k++) {
          const v = parseFloat(parts[k]);
          props.push(isNaN(v) ? NaN : v);
        }
        vPropsRaw.push(props);
      } else {
        vPropsRaw.push([]);
      }
      continue;
    }

    // vertices
    if (line.startsWith('ATOM')) {
      const parts = line.split(/\s+/);
      const id = parseInt(parts[1], 10);
      const refId = parseInt(parts[2], 10);
      const refLocal = vertexIdMap.get(refId);
      if (refLocal === undefined) continue;
      vertexIdMap.set(id, refLocal);
      continue;
    }

    // triangles
    if (line.startsWith('TRI') || line.startsWith('TRGL')) {
      const parts = line.split(/\s+/);
      const v1 = parseInt(parts[1], 10);
      const v2 = parseInt(parts[2], 10);
      const v3 = parseInt(parts[3], 10);
      const l1 = vertexIdMap.get(v1);
      const l2 = vertexIdMap.get(v2);
      const l3 = vertexIdMap.get(v3);
      if (l1 === undefined || l2 === undefined || l3 === undefined) continue;
      triangleIdx.push(l1, l2, l3);
      continue;
    }

    if (line === 'END') continue;
  }

  const vertexCount = vCoords.length / 3;

  // ---------- Bounding box (from the raw coordinates after the axis swap, before the origin is subtracted) ----------
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vCoords.length; i += 3) {
    const x = vCoords[i], y = vCoords[i + 1], z = vCoords[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const boundingBox = [minX, minY, minZ, maxX, maxY, maxZ];

  return {
    id: 'ts_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name: name,
    vertices: new Float32Array(vCoords),  // ,
    indices: new Uint32Array(triangleIdx),
    vertexCount: vertexCount,
    triangleCount: triangleIdx.length / 3,
    coordinateSystem: coordinateSystem,
    boundingBox: boundingBox,
    fileOrigin: fileOrigin,              // )
    origin: null                         // )
  };
}

// ============================================================
// OBJ parser (exports from Leapfrog Geo, Surpac, Datamine and Micromine)
// Input: OBJ text (real mining-area projected coordinates, X = east, Y = north, Z = elevation)
// Output: a geoMesh with the same shape as parseGOCADTS, where the vertices follow the GOCAD axis convention
// pre-transformed to (east, elevation, -north); loadModelToScene applies the origin offset uniformly at render time,
// so that they align correctly with the .ts and .str models in the same coordinate system.
// ============================================================
function parseOBJText(text, fallbackName) {
  // strip the byte order mark
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const vTmp = [];      // vertices
  const faceVerts = []; // vertices
  let objectName = null; // )

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v' && parts.length >= 4) {
      vTmp.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
    } else if (tag === 'vn' || tag === 'vt' || tag === 'vp') {
      // vertices
    } else if (tag === 'o' || tag === 'g') {
      if (!objectName && parts[1]) objectName = parts[1];
    } else if (tag === 'f' && parts.length >= 4) {
      // f v1/vt1/vn1 v2/vt2/vn2 ... fan triangulation of the polygon
      const idxs = [];
      for (let k = 1; k < parts.length; k++) {
        const token = parts[k];
        if (!token) continue;
        let vStr = token;
        const slash = token.indexOf('/');
        if (slash >= 0) vStr = token.substring(0, slash);
        let idx = parseInt(vStr, 10);
        if (isNaN(idx)) continue;
        if (idx < 0) idx = vTmp.length / 3 + idx; // 负索引 = 相对当前
        else idx -= 1;                            // OBJ 从 1 开始
        idxs.push(idx);
      }
      if (idxs.length < 3) continue;
      const v0 = idxs[0];
      for (let k = 1; k < idxs.length - 1; k++) {
        faceVerts.push(v0, idxs[k], idxs[k + 1]);
      }
    }
    // lines such as mtllib, usemtl, s, l, p, mg and maplib are ignored
  }

  const vertexCount = vTmp.length / 3;
  if (vertexCount === 0) throw new Error('OBJ not found in v Vertex row');
  if (faceVerts.length === 0) throw new Error('OBJ not found in f Triangle row');

  // vertices
  const maxIdx = faceVerts.reduce((a, b) => (b > a ? b : a), 0);
  if (maxIdx >= vertexCount) {
    throw new Error('OBJ Triangle index out of bounds (Maximum vertex index ' + (maxIdx + 1) + ' > Vertices ' + vertexCount + ' ) , The file may be corrupt');
  }

  // ---- Axis conversion: OBJ (X = east, Y = north, Z = elevation) to the raw GOCAD coordinates (X = east, Y = elevation, Z = -north) ----
  const vRaw = new Float32Array(vTmp.length);
  for (let i = 0; i < vTmp.length; i += 3) {
    vRaw[i]     = vTmp[i];     // 东
    vRaw[i + 1] = vTmp[i + 2]; // 高程
    vRaw[i + 2] = -vTmp[i + 1];// 北取反
  }

  // ---- Bounding box (from the raw coordinates after the axis swap, before the origin is subtracted, consistent with parseGOCADTS) ----
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vRaw.length; i += 3) {
    const x = vRaw[i], y = vRaw[i + 1], z = vRaw[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const boundingBox = [minX, minY, minZ, maxX, maxY, maxZ];

  // ---- Suggested file origin (consistent with parseGOCADTS: take the smallest coordinate and round it down to a hundred-metre grid) ----
  let fileOrigin = null;
  if (minX !== Infinity) {
    fileOrigin = {
      x: Math.floor(minX / 100) * 100,
      y: Math.floor(minY / 100) * 100,
      z: Math.floor(minZ / 100) * 100
    };
  }

  const baseName = (fallbackName || 'model').replace(/\.obj$/i, '').replace(/\.[^.]+$/, '');
  const name = objectName || baseName;

  return {
    id: 'obj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name: name,
    vertices: vRaw,
    indices: new Uint32Array(faceVerts),
    vertexCount: vertexCount,
    triangleCount: faceVerts.length / 3,
    coordinateSystem: undefined,
    boundingBox: boundingBox,
    fileOrigin: fileOrigin,
    origin: null
  };
}

// ============================================================
// global state
// ============================================================
let state = {
  models: [],            // { id, name, category, mesh, material, visible, opacity, color, fileName, geoMesh, treeFileNode }
  rulerPoints: [],       // 测距点小球
  rulerLines: [],        // 测距线 + 数值 sprite
  rulerItems: [],        // 测距条目 {id, line, sprite, startSphere, endSphere, distance}
  measureMode: false,
  clipMode: false,
  // clipping configuration: the three axes are independent, each with its own enabled, direction and position
  clipConfig: {
    h: { enabled: false, dir: 'above', value: 0 },   // )
    x: { enabled: false, dir: 'pos',  value: 0 },     // )
    y: { enabled: false, dir: 'pos',  value: 0 },     // )
  },
  clipHelpers: [], // 剖切可视化平面 mesh 列表
  legendVisible: true,
  compassVisible: true, // 坐标开关：指北针+倾角方位角
  layersVisible: true,
  axisLabelsVisible: appPreferences.axesVisible, // 本机显示偏好
  selectedModelId: null,
  placeholderMesh: null,
  selectionOutline: null,  // 当前选中模型的描边线框
  lithologyColors: {},     // ,
  // geochemical colour scale settings: the classic diverging scale (persisted per attribute name)
  geochemColormap: {},     // attrClean → { lowColor:'#313695', highColor:'#A50026', scheme:'rdbu' }
  // ,
  // Different tabs may have different origins, which lets models in different coordinate systems be shown in separate tabs
  origin: null             // ,
};

// category colour mapping
const CATEGORY_COLORS = {
  'Orebody': 0x8338ec,
  'Formation': 0x5C4033,
  'Structure': 0xcf222e,
  'Alteration': 0xf0883e,
  'Geochemistry': 0xa371f7,  // the legend
  '3D Tunnel Models': 0x3b82f6   // 坑道模型：蓝色
};
const CATEGORY_HEX = {
  'Orebody': '#8338ec',
  'Formation': '#5C4033',
  'Structure': '#cf222e',
  'Alteration': '#f0883e',
  'Geochemistry': '#a371f7',
  '3D Tunnel Models': '#3b82f6'
};

// ============================================================
// file name to colour mapping (as agreed in section eight, model colour mapping, of the requirements document)
// On import the agreed colour is matched by file name first, so that the same file keeps its colour across sessions and tabs;
// files that do not match fall back to the category default colour (CATEGORY_COLORS).
// Note: the rules are ordered so that the more specific one wins, so Ptfz2 has to come before Ptfz.
// ============================================================
const FILE_COLOR_RULES = [
  { re: /Ptfz2/i,          color: 0x2E86C1 },  // GM - Ptfz2.ts     粉子山群2   蓝色
  { re: /Ptfz\b/i,         color: 0x2874A6 },  // GM - Ptfz.ts      粉子山群    深蓝
  { re: /1-1/i,            color: 0xE67E22 },  // GM - 1-1.ts       矿体1       橙色
  { re: /1-2/i,            color: 0xD35400 },  // GM - 1-2.ts       矿体2       深橙
  { re: /Alteration/i,     color: 0x9B59B6 },  // GM - Mineralized Alteration Zone.ts 蚀变带 紫色
  { re: /GM\s*-\s*Q/i,     color: 0xF4D03F },  // GM - Q.ts         第四系      黄色
  { re: /GM\s*-\s*F/i,     color: 0xE74C3C }   // GM - F.ts         断层        红色
];
// return the agreed colour for a file name, or null when there is no match (the category default then applies)
function matchFileColor(fileName) {
  if (!fileName) return null;
  for (let i = 0; i < FILE_COLOR_RULES.length; i++) {
    if (FILE_COLOR_RULES[i].re.test(fileName)) return FILE_COLOR_RULES[i].color;
  }
  return null;
}

// ============================================================
// on import, make sure every model gets a different colour (whether or not they share a category)
// prefer the agreed colour from FILE_COLOR_RULES or the category default, if that colour is not already taken
// when it is taken or there is none, take an unused colour from the highly distinguishable palette
// when the palette is exhausted, generate a new colour using the golden angle so that it never repeats
// ============================================================
const MODEL_PALETTE = [
  0xE63946, 0x2A9D8F, 0xE9C46A, 0x457B9D, 0x8E44AD,
  0xF4A261, 0x1ABC9C, 0xC0392B, 0x2980B9, 0x27AE60,
  0x9B59B6, 0xE67E22, 0x16A085, 0x2C3E50, 0xE91E63,
  0x009688, 0xFF5722, 0x3F51B5, 0x795548, 0x607D8B,
  0x00BCD4, 0x4CAF50, 0xFF9800, 0x9C27B0, 0xFF4081
];

// HSL to a 0xRRGGBB integer (s and l are decimals from 0 to 1; this is distinct from the string version hslToHex below, to avoid the name
function hslToHexInt(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = v => Math.round((v + m) * 255) & 0xff;
  return (to(r) << 16) | (to(g) << 8) | to(b);
}

// pick a colour that does not repeat any model already in the scene
// preferred: the preferred colour (the agreed or category colour), adopted only when it is not already taken
function pickUniqueModelColor(preferred) {
  const used = new Set();
  for (let i = 0; i < state.models.length; i++) {
    used.add(state.models[i].color >>> 0);
  }
  if (preferred !== undefined && preferred !== null && !used.has(preferred >>> 0)) {
    return preferred >>> 0;
  }
  for (let i = 0; i < MODEL_PALETTE.length; i++) {
    if (!used.has(MODEL_PALETTE[i])) return MODEL_PALETTE[i];
  }
  // palette exhausted: generate a new colour with the golden angle, still distinct from the existing ones
  const h = (used.size * 137.508) % 360;
  return hslToHexInt(h, 0.65, 0.5);
}

// extract the first number from a file name (for example "GM - 1-1.ts" gives 1, "Au_500.ts" gives 500 and "元素3.ts" gives 3)
function extractFirstNumber(fileName) {
  const match = fileName.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

// ============================================================
// geochemical drillholes: the classic diverging scale (blue, cyan, green, yellow, red)
// ColorBrewer RdBu reversed (11 steps), used to map a value to a colour
// ============================================================
const GEOCHEM_DIVERGING_STOPS = [
  '#313695', '#4575B4', '#74ADD1', '#ABD0E6', '#E0F3F8',
  '#FFFFBF', '#FEE090', '#FDAE61', '#F46D43', '#D73027', '#A50026'
];
// convert #RRGGBB to {r, g, b}
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16)
  };
}
function rgbToInt(r, g, b) {
  return ((r & 0xFF) << 16) | ((g & 0xFF) << 8) | (b & 0xFF);
}
// normalise the value to t in [0, 1] and take the colour from the scale (returns {r, g, b})
function divergingColorAt(t, stops) {
  stops = stops || GEOCHEM_DIVERGING_STOPS;
  if (t <= 0) return hexToRgb(stops[0]);
  if (t >= 1) return hexToRgb(stops[stops.length - 1]);
  const scaled = t * (stops.length - 1);
  const i0 = Math.floor(scaled);
  const i1 = Math.min(i0 + 1, stops.length - 1);
  const f = scaled - i0;
  const c0 = hexToRgb(stops[i0]);
  const c1 = hexToRgb(stops[i1]);
  return {
    r: Math.round(c0.r + (c1.r - c0.r) * f),
    g: Math.round(c0.g + (c1.g - c0.g) * f),
    b: Math.round(c0.b + (c1.b - c0.b) * f)
  };
}
// convenience: t to an integer colour
function geochemColorInt(t, stops) {
  const c = divergingColorAt(t, stops);
  return rgbToInt(c.r, c.g, c.b);
}
// get the custom colour scale of an attribute (the default diverging scale is used when none is set)
function getAttrColormapStops(attrClean) {
  const cfg = state.geochemColormap && state.geochemColormap[attrClean];
  if (!cfg) return GEOCHEM_DIVERGING_STOPS.slice();
  if (cfg.scheme === 'custom' && cfg.lowColor && cfg.highColor) {
    return [cfg.lowColor, cfg.highColor];
  }
  return GEOCHEM_DIVERGING_STOPS.slice();
}
// save the colour scale configuration of an attribute
function setAttrColormap(attrClean, cfg) {
  if (!state.geochemColormap) state.geochemColormap = {};
  state.geochemColormap[attrClean] = Object.assign({}, state.geochemColormap[attrClean] || {}, cfg);
}

// the older geochemical model colour scale function (kept for compatibility with the legacy TS import logic)
function computeGeochemColor(num, minVal, maxVal, rank, total) {
  const lightColor = { r: 224, g: 212, b: 245 };  // #E0D4F5 浅紫
  const darkColor  = { r: 76,  g: 29,  b: 149 };  // #4C1D95 深紫
  let t;
  if (num === null || minVal === maxVal) {
    t = 0.5;
  } else {
    t = (num - minVal) / (maxVal - minVal);
  }
  const r = Math.round(lightColor.r + (darkColor.r - lightColor.r) * t);
  const g = Math.round(lightColor.g + (darkColor.g - lightColor.g) * t);
  const b = Math.round(lightColor.b + (darkColor.b - lightColor.b) * t);
  const color = (r << 16) | (g << 8) | b;
  let opacity;
  if (total <= 1) {
    opacity = 1.0;
  } else {
    opacity = (rank + 1) / total;
  }
  return { color, opacity };
}

// ============================================================
// Three.js scene initialisation
// ============================================================
const canvas = document.getElementById('three-canvas');
const container = document.getElementById('canvas-wrap');

// ============================================================
// viewport height cache (section 75: removes the forced reflow from the render loop)
// ============================================================
// updateScaleBar() needs the viewport height every frame to work out the scale bar, and reading container.clientHeight is
// a forced synchronous layout, so reading it every frame in animate() competes with the WebGL rendering for the main thread
// which shows up directly as jitter while dragging or rotating the view.
// It is now: a ResizeObserver refreshes the cache when the container really changes size, and the render loop only reads the cached value.
let _cachedViewportH = 0;
function syncViewportHeight() {
  if (container) _cachedViewportH = container.clientHeight || 0;
}
syncViewportHeight();
if (typeof ResizeObserver !== 'undefined') {
  try { new ResizeObserver(syncViewportHeight).observe(container); } catch (e) {}
}

let scene = new THREE.Scene();
scene.background = new THREE.Color(appPreferences.background);

let camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
camera.position.set(220, 180, 260);

const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setPixelRatio(desiredCanvasPixelRatio(false));
renderer.localClippingEnabled = true;

// lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(120, 250, 80);
scene.add(dirLight);
scene.add(new THREE.HemisphereLight(0xddeeff, 0x444444, 0.4));

// camera controller
const controls = new CameraController(camera, canvas);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// ============================================================
// empty scene placeholder (section 72: the placeholder cube was removed as requested)
// ============================================================
// The original implementation placed a translucent grey 60x60x60 box with grey edges (BoxGeometry plus
// EdgesGeometry and LineSegments) in the centre of an empty scene and attached it to state.placeholderMesh.
//
// The user asked for the grey cube in the middle of the view, which cannot be rotated or moved, to be removed, so no geometry is created here any more.
//
// Why the function shell and the state.placeholderMesh field are kept instead of removing the call outright:
// There are more than 12 places in the file with `if (state.placeholderMesh) { scene.remove(...); dispose();
// for cleanup (the import, clear project and tab switch paths all need it). Keeping the field permanently null means
// those null checks skip themselves, so twelve call sites do not have to be changed and no site can be missed and end up referencing an undefined value.
//
// To restore the placeholder cube, put the commented-out construction code back (a backup is in
// desktop-program/backups/index8_20260923_145000_before_del_placeholder.html).
function createPlaceholder() {
  state.placeholderMesh = null;
}
createPlaceholder();

// ============================================================
// multi-tab viewer instance management (shared DOM, independent scene, state and camera)
// ============================================================
const tabViewers = new Map();   // tabId → { state, scene, camera, target }
let activeTabId = 'view';
const geoMeshCache = new Map(); // fileName → { geoMesh, category, options } 跨标签共享模型数据

// create a new independent viewer instance
// The project data is shared through the same container, and the property accessors also follow a whole dictionary or array reassignment.
// The camera, the models, the origin and the clipping still belong to each viewer independently.
function ensureProjectLevelStateFields(target, source) {
  target = target || state;
  source = source || state;
  var dict = ['tables', 'drawings', 'pdfs', 'words', 'testData', 'pointLayers',
    'lineLayers', 'lithologyColors', 'geochemColormap'];
  var arrays = ['pointOrder', 'lineOrder'];
  var shared = source.__projectData || target.__projectData || {};
  dict.concat(arrays).forEach(function (key) {
    var isArray = arrays.indexOf(key) !== -1;
    if (!(key in shared)) {
      var value = source[key];
      shared[key] = isArray ? (Array.isArray(value) ? value : [])
        : (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
    }
    Object.defineProperty(target, key, {
      enumerable: true, configurable: true,
      get: function () { return shared[key]; },
      set: function (value) { shared[key] = value; }
    });
  });
  Object.defineProperty(target, '__projectData', { value: shared, configurable: true });
  return target;
}

function createViewerInstance() {
  ensureProjectLevelStateFields();
  const newState = {
    models: [], rulerPoints: [], rulerLines: [], rulerItems: [],
    measureMode: false, clipMode: false,
    clipConfig: {
      h: { enabled: false, dir: 'above', value: 0 },
      x: { enabled: false, dir: 'pos', value: 0 },
      y: { enabled: false, dir: 'pos', value: 0 },
    },
    clipHelpers: [], legendVisible: true, compassVisible: true, layersVisible: true,
    axisLabelsVisible: appPreferences.axesVisible, axisLabelGroup: null,
    selectedModelId: null,
    placeholderMesh: null, selectionOutline: null,
    // Each tab maintains its own coordinate origin, so different tabs can show models in different coordinate systems
    origin: null
  };
  ensureProjectLevelStateFields(newState, state);
  const newScene = new THREE.Scene();
  newScene.background = new THREE.Color(appPreferences.background);
  applyScenePreferences(newScene,newState);
  newScene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dl = new THREE.DirectionalLight(0xffffff, 0.8);
  dl.position.set(120, 250, 80);
  newScene.add(dl);
  newScene.add(new THREE.HemisphereLight(0xddeeff, 0x444444, 0.4));
  const newCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
  newCamera.position.set(220, 180, 260);

  // placeholder cube (section 72: removed at the user's request, so a new tab no longer places placeholder geometry either)
  // note that this is a different code path from the one that creates the instance for a new tab, so it is separate from createPlaceholder()
  // when removing the placeholder both places have to be changed, otherwise a new tab still shows the grey cube in the middle.
  newState.placeholderMesh = null;

  return { state: newState, scene: newScene, camera: newCamera, target: new THREE.Vector3(0, 0, 0), locked: false };
}

// rebuild the layer management UI (called when switching tabs)
function rebuildLayerManagement(forceCompareBuild = false) {
  if(!forceCompareBuild){
    const target=window.regionCompare?.active?window.regionCompare.layerTarget?.(activeTabId):null;
    lmList=target?.list||document.getElementById('lm-list');
    lmEmpty=target?.empty||normalLayerEmpty;
    if(lmEmpty.parentElement!==lmList)lmList.prepend(lmEmpty);
    if(target?.ready)return; // ,
  }
  lmList.querySelectorAll('.lm-item, .lm-measure-item, .lm-clip-item').forEach(el => el.remove());
  // Section 74: allowAutoTop is false because this is a rebuild and not a new import,
  // so the order must be restored strictly from the state.models array, keeping the order the user has dragged things into, and an image must not be forced
  state.models.filter(m => m.inScene).forEach(m => addLayerItem(m, false));
  state.rulerItems.forEach(r => addMeasureLayerItem(r));
  const hasItems = state.models.some(m => m.inScene) || state.rulerItems.length > 0;
  lmEmpty.style.display = hasItems ? 'none' : '';
}

// the original layer management build and events are reused; only the data and the target container are switched during the build.
function renderLayerManagementFor(viewer,list,empty){
  const previous={state,lmList,lmEmpty};
  try{state=viewer.state;lmList=list;lmEmpty=empty;rebuildLayerManagement(true);}
  finally{state=previous.state;lmList=previous.lmList;lmEmpty=previous.lmEmpty;}
}

// switch the active viewer (reassign the global variables and rebuild the UI)
function switchActiveViewer(tabId) {
  // save the camera state of the current viewer (3D tabs only)
  if (tabViewers.has(activeTabId)) {
    const cur = tabViewers.get(activeTabId);
    if (cur && cur.type === '3d' && cur.scene) {
      cur.camera = camera;
      cur.target = controls.target.clone();
    }
  }
  activeTabId = tabId;
  const viewer = tabViewers.get(tabId);
  if (!viewer) return;

  const centerArea = document.getElementById('center-area');
  const imageViewWrap = document.getElementById('image-viewer-wrap');
  const tableViewWrap = document.getElementById('table-viewer-wrap');
  const pdfViewWrap = document.getElementById('pdf-viewer-wrap');
  const wordViewWrap = document.getElementById('word-viewer-wrap');

  // ===== Image tab branch =====
  if (viewer.type === 'image') {
    // the right panel goes back to the drillhole group (2D linkage)
    if (window.setRightPanelGroup) window.setRightPanelGroup('drill');
    // hide the four panels and the table and PDF viewers, and show the image viewer
    centerArea.classList.add('no-view');
    if (imageViewWrap) imageViewWrap.classList.add('show');
    if (tableViewWrap) tableViewWrap.classList.remove('show');
    if (pdfViewWrap) pdfViewWrap.classList.remove('show');
    if (wordViewWrap) wordViewWrap.classList.remove('show');

    // load the image into the shared img element
    const imgEl = document.getElementById('image-viewer-img');
    if (imgEl && viewer.imageUrl) {
      imgEl.src = viewer.imageUrl;
    }
    // restore the zoom and pan state of that image tab
    applyImageTransform(viewer.imgScale, viewer.imgTx, viewer.imgTy);

    // restore or hide the control point registration UI
    const regPanel = document.getElementById('register-panel-top');
    const regLayer = document.getElementById('register-marker-layer');
    if (viewer.regMode) {
      if (regPanel) regPanel.classList.remove('hidden');
      imageViewWrap.classList.add('reg-active');
      if (regLayer) {
        regLayer.innerHTML = '';
        if (ivImg.complete && ivImg.naturalWidth) {
          renderRegisterUI();
        } else {
          imgEl.addEventListener('load', () => renderRegisterUI(), { once: true });
        }
      }
    } else {
      if (regPanel) regPanel.classList.add('hidden');
      if (regLayer) regLayer.innerHTML = '';
      imageViewWrap.classList.remove('reg-active');
    }
    return;
  }

  // ===== Table tab branch =====
  if (viewer.type === 'table') {
    // the right panel goes back to the drillhole group (2D linkage)
    if (window.setRightPanelGroup) window.setRightPanelGroup('drill');
    // hide the four panels and the image and PDF viewers, and show the table viewer
    centerArea.classList.add('no-view');
    if (tableViewWrap) tableViewWrap.classList.add('show');
    if (imageViewWrap) imageViewWrap.classList.remove('show');
    if (pdfViewWrap) pdfViewWrap.classList.remove('show');
    if (wordViewWrap) wordViewWrap.classList.remove('show');

    hideRegisterOverlay();

    // load the table HTML into the shared container
    const tvTitle = document.getElementById('tv-title');
    const tvInfo = document.getElementById('tv-info');
    const tvContent = document.getElementById('table-viewer-content');
    if (tvTitle) tvTitle.textContent = viewer.tableName || 'Table preview';
    if (tvInfo) tvInfo.textContent = (viewer.tableRows || 0) + ' Rows × ' + (viewer.tableCols || 0) + ' Columns';
    if (tvContent) {
      tvContent.innerHTML = viewer.tableHtml || '';
      syncTableIgnoreCheckboxes(tvContent);
      // the formula switch: the button only appears for tables that contain formulas, and the formula view state remembered across tabs is restored
      const tvF = document.getElementById('tv-formula-btn');
      if (tvF) {
        const hasF = !!viewer.tableHasFormula;
        tvF.style.display = hasF ? '' : 'none';
        tvF.classList.toggle('on', hasF && tvShowFormula);
        tvF.textContent = tvShowFormula ? 'Show values' : 'Show formulas';
      }
      if (tvShowFormula) applyFormulaView(true);
      // large table lazy loading: record the current table viewer, restore the chunks that have already been scrolled in, and show the progress bar
      activeLazyTableViewer = viewer;
      renderTableLazyPart(viewer, tvContent);
    }
    return;
  }

  // ===== PDF reading tab branch =====
  if (viewer.type === 'pdf') {
    // the right panel switches to the document group (outline, bookmarks, notes)
    if (window.setRightPanelGroup) window.setRightPanelGroup('doc');
    // bind the document context (this has to happen before loading, because the outline, bookmarks and notes all use it to locate the current document)
    if (typeof bindDocContext === 'function') bindDocContext('pdf', viewer.pdfUrl, viewer.pdfName);
    // hide the four panels and the image and table viewers, and show the PDF viewer
    centerArea.classList.add('no-view');
    if (imageViewWrap) imageViewWrap.classList.remove('show');
    if (tableViewWrap) tableViewWrap.classList.remove('show');
    if (pdfViewWrap) pdfViewWrap.classList.add('show');
    if (wordViewWrap) wordViewWrap.classList.remove('show');

    hideRegisterOverlay();

    // title and file size
    const pvTitle = document.getElementById('pv-title');
    const pvInfo = document.getElementById('pv-info');
    if (pvTitle) pvTitle.textContent = viewer.pdfName || 'PDF Read';
    if (pvInfo) {
      const sz = viewer.pdfSize;
      pvInfo.textContent = sz ? (sz / 1024).toFixed(1) + ' KB' : '';
    }
    // lazy loading: the same file is not parsed twice (pdf.js renders it to a canvas)
    if (currentPdfUrl !== viewer.pdfUrl) {
      loadPdfIntoViewer(viewer.pdfUrl);
    }
    return;
  }

  // ===== Word read-only tab branch =====
  if (viewer.type === 'word') {
    // the right panel switches to the document group (outline, bookmarks, notes)
    if (window.setRightPanelGroup) window.setRightPanelGroup('doc');
    // bind the document context (this has to happen before the layout)
    if (typeof bindDocContext === 'function') bindDocContext('word', viewer.wordUrl, viewer.wordName);
    // hide the four panels and the image, table and PDF viewers, and show the Word viewer
    centerArea.classList.add('no-view');
    if (imageViewWrap) imageViewWrap.classList.remove('show');
    if (tableViewWrap) tableViewWrap.classList.remove('show');
    if (pdfViewWrap) pdfViewWrap.classList.remove('show');
    if (wordViewWrap) wordViewWrap.classList.add('show');

    hideRegisterOverlay();

    // title and file size
    const wvTitle = document.getElementById('wv-title');
    const wvInfo = document.getElementById('wv-info');
    if (wvTitle) wvTitle.textContent = viewer.wordName || 'Word Read';
    if (wvInfo) {
      const sz = viewer.wordSize;
      wvInfo.textContent = sz ? (sz / 1024).toFixed(1) + ' KB' : '';
    }
    // lazy rendering: the same file is not laid out twice (docx-preview renders it into word-viewer-content)
    if (currentWordUrl !== viewer.wordUrl) {
      loadWordIntoViewer(viewer.wordUrl);
    } else if (window.scheduleWordReconcile) {
      // for a file that has already been rendered, calibrate the annotation canvas against the current viewport when switching back (it may have been reclaimed while hidden)
      scheduleWordReconcile();
    }
    return;
  }

  // ===== 3D tab branch (the original logic) =====
  // hide the image and table viewers and restore the four panels
  if (window.setRightPanelGroup) window.setRightPanelGroup('drill');
  if (imageViewWrap) {
    imageViewWrap.classList.remove('show');
    imageViewWrap.classList.remove('reg-active');
  }
  if (tableViewWrap) tableViewWrap.classList.remove('show');
  if (pdfViewWrap) pdfViewWrap.classList.remove('show');
  if (wordViewWrap) wordViewWrap.classList.remove('show');
  hideRegisterOverlay();
  centerArea.classList.remove('no-view');

  // reassign the global variables
  ensureProjectLevelStateFields(viewer.state, state);
  state = viewer.state;
  scene = viewer.scene;
  camera = viewer.camera;

  // switch the camera and the target of the controls; a vector planar tab switches to 2D mode (pan and zoom only)
  controls.is2D = !!(viewer.isVector2D);
  controls.swapCamera(camera, viewer.target);

  // rebuild the layer management
  rebuildLayerManagement();

  // reset the property panel and the selection state
  if (state.selectedModelId) {
    state.selectedModelId = null;
    state.selectionOutline = null;
  }
  document.querySelectorAll('.lm-item').forEach(i => i.classList.remove('selected'));
  showEmptyProperties();

  // refresh the coordinate axis labels
  buildAxisLabels();

  // refresh the legend
  updateLegend();

  // show or hide the empty state placeholder (section 72: the placeholder overlay was removed, so this logic goes with it)

  // reset the clipping and measuring button states
  const clipPanel = document.getElementById('clip-panel');
  if (clipPanel) clipPanel.classList.remove('visible');
  const btnClipEl = document.getElementById('btn-clip');
  if (btnClipEl) btnClipEl.classList.toggle('active', state.clipMode);
  const btnMeasureEl = document.getElementById('btn-measure');
  if (btnMeasureEl) btnMeasureEl.classList.toggle('active', state.measureMode);
  canvas.classList.toggle('measuring', state.measureMode);

  // synchronise the active class of the coordinate, scale and legend buttons with the visibility of the matching controls (consistent with viewer.state
  if (typeof syncToolbarToggleButtons === 'function') syncToolbarToggleButtons();

  // trigger the resize
  onResize();
}

// ============================================================
// )
// the state
// ============================================================
const ivStage = document.getElementById('image-viewer-stage');
const ivImg = document.getElementById('image-viewer-img');
const ivZoomLabel = document.getElementById('iv-zoom-label');

// )
ivImg.addEventListener('error', () => {
  const activeTab = document.querySelector('.center-tab.active');
  const tabLabel = activeTab ? (activeTab.querySelector('.center-tab-label') || {}).textContent : '';
  window.showTabModal({
    title: 'Unable to display image',
    label: 'Image“ ' + (tabLabel || '') + ' ”Unable to decode. The format may not be supported, The file is corrupt or exceeds the size limit; TIFF Open this image in the desktop application. '
  });
});

// apply the zoom and pan transform to the img element
function applyImageTransform(scale, tx, ty) {
  if (!ivImg) return;
  ivImg.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')';
  if (ivZoomLabel) ivZoomLabel.textContent = Math.round(scale * 100) + '%';

  // the registration markers move together with the corresponding points on the image
  updateRegisterMarkers();
}

// get the state object of the current image tab
function getActiveImageState() {
  const v = tabViewers.get(activeTabId);
  return (v && v.type === 'image') ? v : null;
}

// update the state of the current image tab and apply the transform
function setImageTransform(scale, tx, ty) {
  const st = getActiveImageState();
  if (!st) return;
  st.imgScale = scale;
  st.imgTx = tx;
  st.imgTy = ty;
  applyImageTransform(scale, tx, ty);
}

// zoom centred on the mouse position
function zoomAtCenter(newScale) {
  const st = getActiveImageState();
  if (!st) return;
  const s = Math.max(0.1, Math.min(10, newScale));
  setImageTransform(s, st.imgTx, st.imgTy);
}

// toolbar button: zoom in
document.getElementById('iv-zoom-in').addEventListener('click', () => {
  const st = getActiveImageState();
  if (st) zoomAtCenter(st.imgScale * 1.25);
});
// toolbar button: zoom out
document.getElementById('iv-zoom-out').addEventListener('click', () => {
  const st = getActiveImageState();
  if (st) zoomAtCenter(st.imgScale / 1.25);
});
// )
document.getElementById('iv-fit').addEventListener('click', () => {
  setImageTransform(1, 0, 0);
});
// toolbar button: actual size (100%)
document.getElementById('iv-actual').addEventListener('click', () => {
  setImageTransform(1, 0, 0);
});
// toolbar button: reset
document.getElementById('iv-reset').addEventListener('click', () => {
  setImageTransform(1, 0, 0);
});

// )
ivStage.addEventListener('wheel', (e) => {
  const st = getActiveImageState();
  if (!st) return;
  e.preventDefault();
  const rect = ivStage.getBoundingClientRect();
  // the mouse position relative to the centre of the stage
  const mx = e.clientX - rect.left - rect.width / 2;
  const my = e.clientY - rect.top - rect.height / 2;
  const delta = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newScale = Math.max(0.1, Math.min(10, st.imgScale * delta));
  // zoom centred on the mouse: adjust the translate so that the point under the mouse stays put
  // the formula: newTx = mx - (mx - tx) * (newScale / oldScale)
  const ratio = newScale / st.imgScale;
  const newTx = mx - (mx - st.imgTx) * ratio;
  const newTy = my - (my - st.imgTy) * ratio;
  setImageTransform(newScale, newTx, newTy);
}, { passive: false });

// )
ivStage.addEventListener('dblclick', (e) => {
  e.preventDefault();
  setImageTransform(1, 0, 0);
});

// drag to move the image
let ivDragging = false;
let ivDragStartX = 0, ivDragStartY = 0;
let ivDragOriginTx = 0, ivDragOriginTy = 0;

ivStage.addEventListener('mousedown', (e) => {
  const st = getActiveImageState();
  if (!st) return;
  if (e.button !== 0) return;   // 仅左键
  ivDragging = true;
  ivDragStartX = e.clientX;
  ivDragStartY = e.clientY;
  ivDragOriginTx = st.imgTx;
  ivDragOriginTy = st.imgTy;
  ivStage.classList.add('dragging');
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!ivDragging) return;
  const dx = e.clientX - ivDragStartX;
  const dy = e.clientY - ivDragStartY;
  const st = getActiveImageState();
  if (!st) return;
  applyImageTransform(st.imgScale, ivDragOriginTx + dx, ivDragOriginTy + dy);
});

window.addEventListener('mouseup', () => {
  if (!ivDragging) return;
  ivDragging = false;
  ivStage.classList.remove('dragging');
  // save the final offset into the state
  const st = getActiveImageState();
  if (st) {
    const t = ivImg.style.transform;
    // parse the translate value out of the transform
    const m = t.match(/translate\(([^,]+)px,\s*([^)]+)px\)/);
    if (m) {
      st.imgTx = parseFloat(m[1]);
      st.imgTy = parseFloat(m[2]);
    }
  }
});

// ============================================================
// helper functions linking the 3D view and the layer management
// ============================================================

// clear the highlight outline of the currently selected model
function clearSelectionOutline() {
  if (state.selectionOutline) {
    try {
      if (state.selectionOutline.parent) state.selectionOutline.parent.remove(state.selectionOutline);
      if (state.selectionOutline.geometry) state.selectionOutline.geometry.dispose();
      if (state.selectionOutline.material) state.selectionOutline.material.dispose();
    } catch (e) {}
    state.selectionOutline = null;
  }
}

// the property panel
function showEmptyProperties() {
  // synchronise the two property panels: rp-* on the right and bp-* at the bottom
  const pairs = [['bp-empty', 'bp-model-props']];
  pairs.forEach(([emptyId, propsId]) => {
    const e = document.getElementById(emptyId);
    const p = document.getElementById(propsId);
    if (e) e.style.display = 'block';
    if (p) p.style.display = 'none';
  });
}

// the property panel
// the measuring and clipping modes are not affected
function clearSelectionState() {
  if (!state.selectedModelId && !state.selectionOutline) return;
  clearSelectionOutline();
  state.selectedModelId = null;
  document.querySelectorAll('.lm-item').forEach(i => i.classList.remove('selected'));
  showEmptyProperties();
}

// ,
function showSelectionOutline(model) {
  clearSelectionOutline();
  if (!model || !model.mesh) return;
  try {
    let edges;
    if(model.geoMesh && model.geoMesh.terrainInfo){
      const bounds=model.mesh.geometry.boundingBox;
      if(!bounds)model.mesh.geometry.computeBoundingBox();
      const box=model.mesh.geometry.boundingBox,size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
      const outlineBox=new THREE.BoxGeometry(size.x,size.y,size.z);outlineBox.translate(center.x,center.y,center.z);
      edges=new THREE.EdgesGeometry(outlineBox);outlineBox.dispose();
    }else edges = new THREE.EdgesGeometry(model.mesh.geometry, 15);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xfacc15, linewidth: 2, transparent: true, opacity: 0.95, depthTest: false
    });
    const outline = new THREE.LineSegments(edges, lineMat);
    outline.renderOrder = 9999;
    outline.visible = model.mesh.visible;
    model.mesh.add(outline);
    state.selectionOutline = outline;
  } catch (err) {
    console.warn('Unable to create a highlight outline:', err);
  }
}

// focus the camera on a single model
function focusModel(model) {
  if (!model || !model.mesh) return;
  const box = new THREE.Box3();
  // ,
  if (model.mesh.isInstancedMesh && model.mesh.userData && model.mesh.userData.blockBox) {
    box.union(model.mesh.userData.blockBox);
  } else {
    box.setFromObject(model.mesh);
  }
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const center = sphere.center;
  const radius = Math.max(sphere.radius, 10);

  controls._panLimitRadius = Math.max(controls._panLimitRadius || 0, radius * 1.2);
  controls._panLimitCenter.copy(center);

  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = radius / Math.sin(fov / 2) * 1.3;

  camera.position.set(center.x + dist * 0.6, center.y + dist * 0.6, center.z + dist * 0.8);
  controls.target.copy(center);
  controls.update();
}

// the property panel
function refreshCurrentProperties() {
  if (state.selectedModelId) {
    const m = state.models.find(x => x.id === state.selectedModelId);
    if (m) showModelProperties(m);
  }
}

// ============================================================
// utility: fitViewToAll
// if a visible model is selected, focus on that single model
// otherwise, look at all visible models in an isometric view
// ============================================================
// )
// ,
// ,
function expandModelBox3(box, m) {
  if (!m || !m.mesh || !m.mesh.visible) return;
  if (m.mesh.isInstancedMesh && m.mesh.userData && m.mesh.userData.blockBox) {
    box.union(m.mesh.userData.blockBox);
  } else {
    box.expandByObject(m.mesh);
  }
}

function fitViewToAll() {
  // focus on the selected visible model first
  if (state.selectedModelId) {
    const selModel = state.models.find(m => m.id === state.selectedModelId);
    if (selModel && selModel.mesh && selModel.mesh.visible) {
      focusModel(selModel);
      return;
    }
  }
  const box = new THREE.Box3();
  state.models.forEach(m => { expandModelBox3(box, m); });
  if (box.isEmpty()) {
    controls.reset();
    return;
  }
  // )
  if (camera.isOrthographicCamera) {
    const bbSize = box.getSize(new THREE.Vector3());
    const bbCenter = box.getCenter(new THREE.Vector3());
    const viewW = Math.max(bbSize.x, bbSize.z, 10) * 1.15;
    const aspect = Math.max(canvas.clientHeight, 1) / Math.max(canvas.clientWidth, 1);
    const viewH = viewW * aspect;
    camera.left = -viewW / 2; camera.right = viewW / 2;
    camera.top = viewH / 2; camera.bottom = -viewH / 2;
    camera.position.set(bbCenter.x, 10000, bbCenter.z);
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    controls.target.copy(bbCenter);
    controls._panLimitRadius = viewW * 2;
    controls._panLimitCenter.copy(bbCenter);
    controls._2dZoom = 1;
    controls.setInitialState(camera.position.clone(), controls.target.clone());
    controls.update();
    return;
  }
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const center = sphere.center;
  const radius = Math.max(sphere.radius, 10);

  controls._panLimitRadius = radius * 1.2;
  controls._panLimitCenter.copy(center);

  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = radius / Math.sin(fov / 2) * 1.2;

  camera.position.set(center.x + dist * 0.6, center.y + dist * 0.6, center.z + dist * 0.8);
  controls.target.copy(center);

  controls.setInitialState(camera.position.clone(), controls.target.clone());
  controls.update();
}

// ============================================================
// coordinate axis labels: the coordinates are marked along the three edges drawn from a corner of the global bounding box
// compute the XYZ ranges, choose a sensible interval, and place the sprite labels
// )
// ============================================================
state.axisLabelGroup = null; // THREE.Group

function buildAxisLabels() {
  applyScenePreferences(scene,state);
  // remove the old labels
  if (state.axisLabelGroup) {
    scene.remove(state.axisLabelGroup);
    state.axisLabelGroup.traverse(obj => {
      if (obj.material) { if (obj.material.map) obj.material.map.dispose(); obj.material.dispose(); }
      if (obj.geometry) obj.geometry.dispose();
    });
    state.axisLabelGroup = null;
  }
  if (state.models.length === 0) return;

  // ==========================================================
  // ,
  // )
  // )
  // ,
  // the inverse mapping:
  //   GOCAD_X = ThreeX + ox
  //   GOCAD_Y = -ThreeZ + oy
  //   GOCAD_Z = ThreeY + oz
  // ==========================================================

  // )
  // ,
  let effectiveOrigin = state.origin;
  if (!effectiveOrigin) {
    // infer it from the fileOrigin of the first usable model where possible
    const firstWithFileOrigin = state.models.find(m => m.geoMesh && m.geoMesh.fileOrigin);
    if (firstWithFileOrigin) {
      effectiveOrigin = { x: firstWithFileOrigin.geoMesh.fileOrigin.x, y: firstWithFileOrigin.geoMesh.fileOrigin.y, z: firstWithFileOrigin.geoMesh.fileOrigin.z };
      console.warn('[Coordinate labels] state.origin is empty, From model fileOrigin Infer:', effectiveOrigin);
    } else {
      // )
      const box = new THREE.Box3();
      state.models.forEach(m => { expandModelBox3(box, m); });
      if (!box.isEmpty()) {
        effectiveOrigin = {
          x: Math.floor(box.min.x / 100) * 100,
          y: Math.floor(box.min.z / 100) * 100,  // Three.Z → GOCAD_Y 推断
          z: Math.floor(box.min.y / 100) * 100   // Three.Y → GOCAD_Z 推断
        };
        console.warn('[Coordinate labels] state.origin is empty, Infer from bounding box:', effectiveOrigin);
      } else {
        effectiveOrigin = { x: 0, y: 0, z: 0 };
      }
      // write it into state.origin for later use
      state.origin = effectiveOrigin;
    }
  }
  const ox = effectiveOrigin.x, oy = effectiveOrigin.y, oz = effectiveOrigin.z;
  console.log('[Coordinate labels] Current tab origin: ox= ' + ox + ' oy=' + oy + ' oz=' + oz);

  // )
  const box = new THREE.Box3();
  state.models.forEach(m => { expandModelBox3(box, m); });
  if (box.isEmpty()) { console.warn('[Coordinate labels] Bounding box is empty'); return; }
  const min = box.min, max = box.max;
  const corner = { x: min.x, y: min.y, z: min.z }; // 坐标轴起点：底面左下角
  const rangeX = max.x - min.x;
  const rangeY = max.y - min.y;
  const rangeZ = max.z - min.z;

  // sensible interval: find a multiple of 1, 2 or 5 close to range/6
  function niceStep(range) {
    if (range <= 0) return 1;
    const raw = range / 6;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    let step;
    if (norm < 1.5) step = 1;
    else if (norm < 3) step = 2;
    else if (norm < 7) step = 5;
    else step = 10;
    return step * mag;
  }
  const stepX = niceStep(rangeX);
  const stepY = niceStep(rangeY);
  const stepZ = niceStep(rangeZ);
  console.log('[Coordinate labels] Bounding box min( ' + min.x.toFixed(1) + ',' + min.y.toFixed(1) + ',' + min.z.toFixed(1) +
    ') max(' + max.x.toFixed(1) + ',' + max.y.toFixed(1) + ',' + max.z.toFixed(1) +
    ') step(' + stepX + ',' + stepY + ',' + stepZ + ')');

  const group = new THREE.Group();
  group.name = 'axis-labels';
  // ,
  // ,

  const maxRange = Math.max(rangeX, rangeY, rangeZ);
  const off = maxRange * 0.08 + 5;       // )
  const labelScale = (maxRange * 0.025 + 2) * appPreferences.axisTextScale;
  const endLabelScale = labelScale * 1.2; // 末端轴名字标签稍大

  // ==========================================================
  // axisSpec: the complete mapping between the physical Three.js axes and the real GOCAD coordinates, labels and colours
  // key = the physical Three.js axis ('x', 'y' or 'z')
  // ,
  // colour: one colour shared by the tick text, the axis line and the end label of this axis
  // )
  // )
  // range and step: the bounding box range and the sensible step of this axis
  // )
  // ,
  // )
  // )
  // )
  // )
  // ==========================================================
  const axisSpec = {
    x: {
      endLabel: 'X Axis',
      color: '#ff0000',
      lineColor: 0xff0000,
      gocadCoord: 'GOCAD X (East, 7 digits) ',
      toGocad: threeVal => Math.round(threeVal + ox),
      range: rangeX, step: stepX, minV: min.x, maxV: max.x,
      tickPos: v => new THREE.Vector3(v, corner.y, corner.z - off),
      axisStart: new THREE.Vector3(corner.x, corner.y, corner.z),
      axisEnd:   new THREE.Vector3(max.x, corner.y, corner.z),
      endLabelPos: new THREE.Vector3(max.x + off, corner.y, corner.z),
      tickTickStart: v => new THREE.Vector3(v, corner.y, corner.z - off * 0.3),
      tickTickEnd:   v => new THREE.Vector3(v, corner.y, corner.z),
    },
    y: {
      // ,
      endLabel: 'Z Axis',
      color: '#00ff00',
      lineColor: 0x00ff00,
      gocadCoord: 'GOCAD Z (Elevation) ',
      toGocad: threeVal => Math.round(threeVal + oz),
      range: rangeY, step: stepY, minV: min.y, maxV: max.y,
      tickPos: v => new THREE.Vector3(corner.x - off, v, corner.z),
      axisStart: new THREE.Vector3(corner.x, corner.y, corner.z),
      axisEnd:   new THREE.Vector3(corner.x, max.y, corner.z),
      endLabelPos: new THREE.Vector3(corner.x, max.y + off, corner.z),
      tickTickStart: v => new THREE.Vector3(corner.x - off * 0.3, v, corner.z),
      tickTickEnd:   v => new THREE.Vector3(corner.x, v, corner.z),
    },
    z: {
      // ,
      endLabel: 'Y Axis',
      color: '#0000ff',
      lineColor: 0x0000ff,
      gocadCoord: 'GOCAD Y (North, 8 digits) ',
      toGocad: threeVal => Math.round(-threeVal + oy),
      range: rangeZ, step: stepZ, minV: min.z, maxV: max.z,
      tickPos: v => new THREE.Vector3(corner.x - off, corner.y, v),
      axisStart: new THREE.Vector3(corner.x, corner.y, corner.z),
      axisEnd:   new THREE.Vector3(corner.x, corner.y, max.z),
      endLabelPos: new THREE.Vector3(corner.x, corner.y, max.z + off),
      tickTickStart: v => new THREE.Vector3(corner.x - off * 0.3, corner.y, v),
      tickTickEnd:   v => new THREE.Vector3(corner.x, corner.y, v),
    },
  };

  // ==========================================================
  // render uniformly according to axisSpec: ticks, tick marks, axis line, end axis name
  // ==========================================================
  for (const threeAxis of ['x', 'y', 'z']) {
    const spec = axisSpec[threeAxis];
    spec.color = appPreferences[threeAxis==='x'?'axisX':threeAxis==='y'?'axisZ':'axisY'];
    spec.lineColor = parseInt(spec.color.slice(1),16);
    const startV = Math.ceil(spec.minV / spec.step) * spec.step;
    const endV = Math.floor(spec.maxV / spec.step) * spec.step;

    // ,
    for (let v = startV; v <= endV + 0.001; v += spec.step) {
      const text = String(spec.toGocad(v));
      const sp = makeLabelSprite(text, labelScale, spec.color);
      sp.position.copy(spec.tickPos(v));
      sp.userData.axisLabelPriority = (v === startV || Math.abs(v-endV)<0.001) ? 1 : 2;
      // ,
      group.add(sp);
    }

    // 2) the tick marks
    const tickPoints = [];
    for (let v = startV; v <= endV + 0.001; v += spec.step) {
      tickPoints.push(spec.tickTickStart(v));
      tickPoints.push(spec.tickTickEnd(v));
    }
    if (tickPoints.length > 0) {
      const tickGeo = new THREE.BufferGeometry().setFromPoints(tickPoints);
      const tickMat = new THREE.LineBasicMaterial({ color: spec.lineColor, transparent: true, opacity: 0.55 });
      group.add(new THREE.LineSegments(tickGeo, tickMat));
    }

    // )
    const axisGeo = new THREE.BufferGeometry().setFromPoints([spec.axisStart, spec.axisEnd]);
    const axisMat = new THREE.LineBasicMaterial({ color: spec.lineColor });
    const line = new THREE.Line(axisGeo, axisMat);
    // ,
    group.add(line);

    // )
    const nameSp = makeLabelSprite(spec.endLabel, endLabelScale, spec.color);
    nameSp.position.copy(spec.endLabelPos);
    nameSp.userData.axisLabelPriority = 0;
    // ,
    group.add(nameSp);
  }

  group.visible = state.axisLabelsVisible;
  scene.add(group);
  state.axisLabelGroup = group;
}

// ,
function updateActiveTabName() {
  if(window.researchRegionViews?.refreshNamesIfNeeded){window.researchRegionViews.refreshNamesIfNeeded();return;}
  const tab = document.querySelector('.center-tab[data-tab-id="'+activeTabId+'"]');
  if (!tab) return;
  const label = tab.querySelector('.center-tab-label');
  if (!label || label.isContentEditable) return;
  if (tab.dataset.autoName === 'true') {
    const models = state.models.filter(model => model.inScene !== false);
    if (models.length) {
      const first = models[0];
      const name = String(first.displayName || first.fileName || first.name || '3D Models').replace(/\.(ts|obj|dtm|str|asc|tiff?|png|jpe?g)$/i,'');
      const title = name + (models.length>1?'（+'+(models.length-1)+' Layer) ':'');
      if (label.textContent !== title) label.textContent = title;
    } else {
      const title = tab.dataset.emptyName || '3D View';
      if (label.textContent !== title) label.textContent = title;
    }
  }
  // restore the full title in sync after a project restore or an external rename.
  if (tab.title !== label.textContent) tab.title = label.textContent;
}

function updateAxisLabelLayout() {
  const group = state.axisLabelGroup;
  if (!group || !group.visible) return;
  const width = renderer.domElement.clientWidth, height = renderer.domElement.clientHeight;
  if (!width || !height) return;
  camera.updateMatrixWorld();
  group.updateMatrixWorld(true);
  const labels = group.children.filter(child => child.isSprite);
  labels.sort((a,b) => a.userData.axisLabelPriority-b.userData.axisLabelPriority);
  const occupied = [], point = new THREE.Vector3(), view = new THREE.Vector3();
  for (const label of labels) {
    label.getWorldPosition(point);
    view.copy(point).applyMatrix4(camera.matrixWorldInverse);
    point.project(camera);
    if (point.z < -1 || point.z > 1 || (!camera.isOrthographicCamera && view.z >= 0)) {
      label.visible = false;
      continue;
    }
    const divisor = camera.isOrthographicCamera ? 1 : -view.z;
    const halfW = Math.abs(label.scale.x*camera.projectionMatrix.elements[0]/divisor)*width/4;
    const halfH = Math.abs(label.scale.y*camera.projectionMatrix.elements[5]/divisor)*height/4;
    const x = (point.x+1)*width/2, y = (1-point.y)*height/2;
    const rect = {left:x-halfW-3,right:x+halfW+3,top:y-halfH-3,bottom:y+halfH+3};
    label.visible = rect.right>=0 && rect.left<=width && rect.bottom>=0 && rect.top<=height &&
      !occupied.some(other => rect.left<other.right && rect.right>other.left && rect.top<other.bottom && rect.bottom>other.top);
    if (label.visible) occupied.push(rect);
  }
}

// generate a text sprite
// )
// background: transparent, with no border
// ,
function makeLabelSprite(text, scale, color) {
  const canvas = document.createElement('canvas');
  const fontSize = 48;
  const paddingX = fontSize * 0.5;
  const charWidth = fontSize * 0.62;
  const textLen = String(text).length;
  const canvasW = Math.max(128, Math.ceil(textLen * charWidth + paddingX * 2));
  const canvasH = Math.ceil(fontSize * 1.6);
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');
  // transparent background
  ctx.fillStyle = 'rgba(255,255,255,0)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // no border
  ctx.strokeStyle = 'rgba(0,0,0,0)';
  ctx.lineWidth = 0;
  // ,
  ctx.fillStyle = color || '#222';
  ctx.font = 'bold ' + fontSize + 'px "Microsoft YaHei", "PingFang SC", "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  // ,
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false, alphaTest: 0.05 });
  const sprite = new THREE.Sprite(mat);
  const s = scale || 8;
  const aspect = canvasW / canvasH;
  sprite.scale.set(s * aspect, s, 1);
  // )
  // ,
  return sprite;
}

// ============================================================
// resize handling
// ============================================================
function onResize() {
  if (!canvas || !renderer || !camera) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  syncViewportHeight();   // 第 75 节：同步比例尺所用的视口高度缓存
}
window.addEventListener('resize', onResize);
onResize();

// ============================================================
// right-click on 3D geological models to open the new model dialog
// ============================================================
const header3DModel = document.getElementById('header-3d-model');
const subitems3DModel = document.getElementById('subitems-3d-model');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalLabel = document.getElementById('modal-label');
const modalInput = document.getElementById('modal-input');
const modalConfirm = document.getElementById('modal-confirm');
const modalCancel = document.getElementById('modal-cancel');

// the context menu event
header3DModel.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  // stop toggleNode from being triggered
  openNewModelDialog();
});

// )
let modalPurpose = '3d-new';

// get the DOM of the related checkboxes
const modalCoordsysRow = document.getElementById('modal-coordsys-row');
const modalSameCoordsys = document.getElementById('modal-same-coordsys');

function openNewModelDialog() {
  modalPurpose = '3d-new';
  modalTitle.textContent = 'Add model group';
  modalLabel.textContent = 'Enter a new model name';
  modalInput.value = 'New area';
  // ,
  modalCoordsysRow.style.display = '';
  modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => modalInput.focus(), 50);
}

modalConfirm.addEventListener('click', () => {
  // ,
  // ,
  // )
  // if modalOverlay was already removed by show in the previous round, re-entering is ignored outright.
  if (!modalOverlay.classList.contains('show')) return;
  const name = modalInput.value.trim() || 'New model';
  modalOverlay.classList.remove('show');
  // logic
  // ,
  if (modalPurpose !== 'drillhole-new' && modalPurpose !== 'drawing-group-new' &&
      modalPurpose !== 'drawing-subcategory-new' &&
      modalPurpose !== 'report-folder-new' && modalPurpose !== 'report-folder-rename' && modalPurpose !== 'pdf-file-rename' &&
      modalPurpose !== 'testdata-folder-new' && modalPurpose !== 'testdata-folder-rename' && modalPurpose !== 'testdata-file-rename' &&
      modalPurpose !== 'point-category-new' && modalPurpose !== 'point-category-rename' &&
      modalPurpose !== 'line-category-new' && modalPurpose !== 'line-category-rename' &&
      // Section 101: 'blockmodel-new' has been taken off the exclusion list, so it follows the same rule as the geochemical and tunnel models
      // )
      // ,
      modalPurpose !== 'drawing-category-rename' && modalPurpose !== 'drawing-file-rename' &&
      modalPurpose !== 'table-category-rename' && modalPurpose !== 'table-file-rename' &&
      modalPurpose !== 'drillhole-area-rename' &&
      modalPurpose !== 'project-new-name' && modalPurpose !== 'model-file-rename' && modalPurpose !== 'model-group-rename') {
    const sameCoordsys = modalSameCoordsys.checked;
    // )
    const activeViewer = tabViewers.get(activeTabId);
    const isActive3D = activeViewer && activeViewer.type === '3d';
    if (!sameCoordsys || !isActive3D) {
      // ,
      window.createNewTab('3d', { label: name });
    }
  }
  // project tree node
  if (modalPurpose === 'geochem-new') {
    addNewGeochemModelNode(name);
  } else if (modalPurpose === 'blockmodel-new') {
    addNewBlockModelNode(name);
  } else if (modalPurpose === 'tunnel-new') {
    addNewTunnelModelNode(name);
  } else if (modalPurpose === 'drillhole-new') {
    addNewDrillholeAreaNode(name);
  } else if (modalPurpose === 'drawing-group-new') {
    addDrawingGroup(name);
  } else if (modalPurpose === 'drawing-subcategory-new') {
    // )
    // ,
    // ,
    if (pendingDrawingSubParent) addDrawingSubCategory(pendingDrawingSubParent, name);
    pendingDrawingSubParent = null;
  } else if (modalPurpose === 'report-folder-new') {
    addReportFolderNode(modalInput.value.trim() || 'New folder');
  } else if (modalPurpose === 'report-folder-rename') {
    const cur = pendingRenameFolder ? pendingRenameFolder.cur : 'New folder';
    applyFolderRename(pendingRenameFolder, modalInput.value.trim() || cur);
    pendingRenameFolder = null;
  } else if (modalPurpose === 'pdf-file-rename') {
    const cur = pendingRenamePdf ? pendingRenamePdf.cur : '';
    applyPdfRename(pendingRenamePdf, modalInput.value.trim() || cur);
    pendingRenamePdf = null;
  } else if (modalPurpose === 'word-file-rename') {
    const cur = pendingRenameWord ? pendingRenameWord.cur : '';
    applyWordRename(pendingRenameWord, modalInput.value.trim() || cur);
    pendingRenameWord = null;
  } else if (modalPurpose === 'testdata-folder-new') {
    addTestDataFolderNode(modalInput.value.trim() || 'New folder', pendingTdFolderNew);
    pendingTdFolderNew = null;
  } else if (modalPurpose === 'testdata-folder-rename') {
    const cur = pendingRenameTdFolder ? pendingRenameTdFolder.cur : 'New folder';
    applyTdFolderRename(pendingRenameTdFolder, modalInput.value.trim() || cur);
    pendingRenameTdFolder = null;
  } else if (modalPurpose === 'testdata-file-rename') {
    const cur = pendingRenameTdFile ? pendingRenameTdFile.cur : '';
    applyTdFileRename(pendingRenameTdFile, modalInput.value.trim() || cur);
    pendingRenameTdFile = null;
  } else if (modalPurpose === 'point-category-new') {
    createPointCategory(modalInput.value.trim() || 'New point category');
  } else if (modalPurpose === 'line-category-new') {
    createLineCategory(modalInput.value.trim() || 'New line category');
  } else if (modalPurpose === 'line-category-rename') {
    applyLineRename(modalInput.value.trim() || '');
  } else if (modalPurpose === 'point-category-rename') {
    if (pendingRenamePoint) {
      const cur = state.pointLayers[pendingRenamePoint.id] ? state.pointLayers[pendingRenamePoint.id].name : '';
      applyPointRename(pendingRenamePoint.node, pendingRenamePoint.id, modalInput.value.trim() || cur);
      pendingRenamePoint = null;
    }
  } else if (modalPurpose === 'model-file-rename') {
    const cur = pendingRenameModelFile ? pendingRenameModelFile.cur : '';
    applyFileRename(pendingRenameModelFile, modalInput.value.trim() || cur);
    pendingRenameModelFile = null;
  } else if (modalPurpose === 'model-group-rename') {
    const cur = pendingRenameModelGroup ? pendingRenameModelGroup.cur : '';
    applyModelGroupRename(pendingRenameModelGroup, modalInput.value.trim() || cur);
    pendingRenameModelGroup = null;
  } else if (modalPurpose === 'project-new-name') {
    applyNewProject(name);
  } else if (modalPurpose === 'drawing-category-rename') {
    const cur = pendingRenameDrawingCat ? pendingRenameDrawingCat.cur : '';
    applyDrawingCategoryRename(pendingRenameDrawingCat, modalInput.value.trim() || cur);
    pendingRenameDrawingCat = null;
  } else if (modalPurpose === 'drawing-file-rename') {
    const cur = pendingRenameDrawingFile ? pendingRenameDrawingFile.cur : '';
    applyDrawingFileRename(pendingRenameDrawingFile, modalInput.value.trim() || cur);
    pendingRenameDrawingFile = null;
  } else if (modalPurpose === 'table-category-rename') {
    const cur = pendingRenameTableCat ? pendingRenameTableCat.cur : '';
    applyTableCategoryRename(pendingRenameTableCat, modalInput.value.trim() || cur);
    pendingRenameTableCat = null;
  } else if (modalPurpose === 'table-file-rename') {
    const cur = pendingRenameTableFile ? pendingRenameTableFile.cur : '';
    applyTableFileRename(pendingRenameTableFile, modalInput.value.trim() || cur);
    pendingRenameTableFile = null;
  } else if (modalPurpose === 'drillhole-area-rename') {
    const cur = pendingRenameDrillholeArea ? pendingRenameDrillholeArea.cur : '';
    applyDrillholeAreaRename(pendingRenameDrillholeArea, modalInput.value.trim() || cur);
    pendingRenameDrillholeArea = null;
  } else {
    addNewModelNode(name);
  }
});

modalCancel.addEventListener('click', () => {
  modalOverlay.classList.remove('show');
});

modalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') modalConfirm.click();
  else if (e.key === 'Escape') modalCancel.click();
});

// append the new model node to the project tree
function addNewModelNode(modelName) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML =
    '<div class="lp-sub-item has-children" onclick="toggleNode(this)">' +
      '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
      '<span>' + escapeHtml(modelName) + '</span>' +
    '</div>' +
    '<div class="lp-nested-items expanded">' +
      buildCategoryItem('Orebody') +
      buildCategoryItem('Formation') +
      buildCategoryItem('Structure') +
      buildCategoryItem('Alteration') +
    '</div>';
  // )
  subitems3DModel.insertBefore(wrapper, subitems3DModel.firstChild);
  bindCategoryContextMenus(wrapper);
}

function buildCategoryItem(category) {
  return '' +
    '<div class="lp-sub-item has-children" data-category="' + category + '" onclick="toggleNode(this)">' +
      '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
      '<span>' + category + '</span>' +
    '</div>' +
    '<div class="lp-nested-items expanded"></div>';
}

// ============================================================
// ,
// ============================================================
const headerGeochemModel = document.getElementById('header-geochem-model');
const subitemsGeochemModel = document.getElementById('subitems-geochem-model');

headerGeochemModel.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  openNewGeochemModelDialog();
});

function openNewGeochemModelDialog() {
  modalPurpose = 'geochem-new';
  modalTitle.textContent = 'New geochemical model';
  modalLabel.textContent = 'Enter a new model name';
  modalInput.value = 'New geochemical model';
  // )
  modalCoordsysRow.style.display = '';
  modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => modalInput.focus(), 50);
}

// ============================================================
// right-click the Drillholes group header to add a mining-area drillhole
// )
// ============================================================
const headerDrillhole = document.getElementById('header-drillhole');

headerDrillhole.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  openNewDrillholeAreaDialog();
});

function openNewDrillholeAreaDialog() {
  modalPurpose = 'drillhole-new';
  modalTitle.textContent = 'Add drillhole group';
  modalLabel.textContent = 'Enter a drillhole group name';
  modalInput.value = 'xx Drillholes';
  // a mining-area drillhole involves no coordinate system, so the same coordinate system checkbox is hidden
  modalCoordsysRow.style.display = 'none';
  modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => modalInput.focus(), 50);
}

// the project tree
function addNewGeochemModelNode(modelName) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML =
    '<div class="lp-sub-item has-children" data-role="geochem-model-node" onclick="toggleNode(this)">' +
      '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
      '<span>' + escapeHtml(modelName) + '</span>' +
    '</div>' +
    '<div class="lp-nested-items expanded"></div>';
  subitemsGeochemModel.insertBefore(wrapper, subitemsGeochemModel.firstChild);
  bindGeochemContextMenus(wrapper);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ============================================================
// right-click a category folder to import a .ts model
// ============================================================
const ctxMenu = document.getElementById('ctx-menu');
const ctxImportTs = document.getElementById('ctx-import-ts');
const ctxImportObj = document.getElementById('ctx-import-obj');
const fileInput = document.getElementById('file-input');

let pendingCategoryItem = null;
// )
let pendingModelImportKind = 'ts';
// ,
let ctxContext = { type: null, target: null };

// filter the menu items by type
// the project tree
function filterCtxMenu(type) {
  ctxMenu.querySelectorAll('[data-menu-type]').forEach(el => {
    const types = (el.getAttribute('data-menu-type') || '').split(',');
    el.style.display = types.includes(type) ? '' : 'none';
  });
  // ,
  const tsLabel = document.getElementById('ctx-import-ts-label');
  if (tsLabel) tsLabel.textContent = type === 'tunnel' ? 'Import dtm Model' : 'Import TS Model';
  // the state
  if (type === 'point-category') {
    const ap = document.getElementById('ctx-add-point');
    const sp = ap && ap.querySelector('span');
    const nm = (ctxContext && ctxContext.pointId && state.pointLayers[ctxContext.pointId])
      ? state.pointLayers[ctxContext.pointId].name : '';
    if (sp) sp.textContent = ((typeof pointAddMode !== 'undefined' && pointAddMode) ? 'Finish point drawing' : 'Draw points') + (nm ? '（' + nm + '）' : '');
  }
}

// general: make a project tree node draggable
// the base payload fields are {type: 'file', 'category' or 'model', ...}
// ,
// ,
function setupNodeDraggable(node, payload) {
  node.setAttribute('draggable', 'true');
  node.addEventListener('dragstart', (e) => {
    // )
    const data = Object.assign({}, payload);
    if (data.type === 'file' || data.type === 'blockmodel') {
      data.modelIds = [data.modelId];
      // )
      if (!data.fileNames || !data.fileNames.length) {
        data.fileNames = [node.querySelector('span') ? node.querySelector('span').textContent : ''];
      }
    } else {
      const nested = node.nextElementSibling;
      if (nested && nested.classList.contains('lp-nested-items')) {
        const fileNodes = nested.querySelectorAll('.lp-sub-item[data-model-id]');
        data.modelIds = Array.from(fileNodes).map(fn => fn.getAttribute('data-model-id'));
        data.fileNames = Array.from(fileNodes).map(fn => {
          const sp = fn.querySelector('span');
          return sp ? sp.textContent : '';
        });
      } else {
        data.modelIds = [];
        data.fileNames = [];
      }
    }
    e.dataTransfer.setData('text/plain', JSON.stringify(data));
    e.dataTransfer.effectAllowed = 'copy';
    canvas.classList.add('drag-target');
  });
  node.addEventListener('dragend', () => {
    canvas.classList.remove('drag-target');
  });
}

function bindCategoryContextMenus(root) {
  // )
  const catItems = root.querySelectorAll('.lp-sub-item.has-children[data-category]');
  catItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    const category = item.getAttribute('data-category');
    setupNodeDraggable(item, { type: 'category', category: category });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pendingCategoryItem = item;
      ctxContext = { type: 'category', target: item };
      filterCtxMenu('category');
      showCtxMenu(e.clientX, e.clientY);
    });
  });

  // ,
  // ,
  const modelItems = root.querySelectorAll('.lp-sub-item.has-children:not([data-category])');
  modelItems.forEach(item => {
    if (item._ctxBound) return;
    const sib = item.nextElementSibling;
    if (!sib || !sib.classList.contains('lp-nested-items')) return;
    const hasCategories = sib.querySelector('[data-category]');
    if (!hasCategories) return;
    item._ctxBound = true;
    // ,
    item.setAttribute('data-role', 'model-node');
    setupNodeDraggable(item, { type: 'model', modelRole: '3d-model' });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxContext = { type: 'model', target: item };
      filterCtxMenu('model');
      showCtxMenu(e.clientX, e.clientY);
    });
  });

  // ,
  const fileItems = root.querySelectorAll('.lp-sub-item[data-model-id]');
  fileItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxContext = { type: 'file', target: item };
      filterCtxMenu('file');
      showCtxMenu(e.clientX, e.clientY);
    });
  });
}

// initial binding
bindCategoryContextMenus(document.getElementById('subitems-3d-model'));

// ============================================================
// )
// ============================================================
function bindGeochemContextMenus(root) {
  // )
  // for a single-level category, the model node itself carries import .ts model, rename, export and delete
  const modelItems = root.querySelectorAll('[data-role="geochem-model-node"]');
  modelItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    setupNodeDraggable(item, { type: 'model', modelRole: 'geochem-model' });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pendingCategoryItem = item; // logic
      ctxContext = { type: 'geochem', target: item };
      filterCtxMenu('geochem');
      showCtxMenu(e.clientX, e.clientY);
    });
  });

  // logic
  const fileItems = root.querySelectorAll('.lp-sub-item[data-model-id]');
  fileItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxContext = { type: 'file', target: item };
      filterCtxMenu('file');
      showCtxMenu(e.clientX, e.clientY);
    });
  });
}
bindGeochemContextMenus(document.getElementById('subitems-geochem-model'));

// ============================================================
// )
// columns: Id, X, Y, Z, dX, dY, dZ, GM
// )
// mapped to Three.js by gocadToThree: three = (X - ox, Z - oz, oy - Y)
// ,
// )
// )
// ============================================================
const BLOCK_GM_COLORS = {
  'Ptfz2':                        0x2E86C1,
  'Ptfz':                         0x2874A6,
  '1-1':                         0xE67E22,
  '1-2':                         0xD35400,
  'Mineralized Alteration Zone':  0x9B59B6,
  'Q':                           0xF4D03F,
  'F':                           0xE74C3C
};
function normalizeGeologyClassName(name) {
  return String(name || '').normalize('NFKC').trim().replace(/\.(ts|obj)$/i, '')
    .replace(/^.*?\s+-\s+/, '').replace(/^GM\s*[-_:：]\s*/i, '').trim().replace(/\s+/g, ' ').toLowerCase();
}
function matchingGeologyModel(gm) {
  const key = normalizeGeologyClassName(gm);
  if (!key) return null;
  const models = state.models.slice();
  // Geological models and block models of the same project may be opened on different 3D pages.
  for (const viewer of tabViewers.values()) if (viewer.type === '3d' && viewer.state && viewer.state !== state) models.push(...viewer.state.models);
  return models.find(model => model.geoMesh && !model.geoMesh.terrainInfo && !model.isRegisterPlane && !model.isBlockModel &&
    !model.isDrillhole && !model.isPointLayer && !model.isLineLayer && !['Geochemistry','3D Tunnel Models','Remote Sensing Imagery','Elevation'].includes(model.category) &&
    [model.displayName,model.fileName,model.geoMesh.name].some(name => name && normalizeGeologyClassName(name) === key)) || null;
}
function blockGmColor(gm) {
  const matched = matchingGeologyModel(gm);
  if (matched) return matched.material?.color?.getHex() ?? matched.color;
  const key = normalizeGeologyClassName(gm);
  const existing = state.models.find(model => model.isBlockModel && normalizeGeologyClassName(model.blockClass) === key);
  if (existing) return existing.color;
  if (BLOCK_GM_COLORS.hasOwnProperty(gm)) return BLOCK_GM_COLORS[gm];
  const fc = matchFileColor(gm);
  if (fc !== null) return fc;
  // ,
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
  const used = new Set(state.models.map(model => model.color));
  for (let i=0;i<360;i++) {
    const color = new THREE.Color().setHSL(((hash%360+i*137.508)%360)/360,0.65,0.52).getHex();
    if (!used.has(color)) return color;
  }
  return 0xE67E22;
}

// )
// ,
const headerBlockModel = document.getElementById('header-block-model');
const subitemsBlockModel = document.getElementById('subitems-block-model');

// )
let pendingBlockCategoryItem = null;

headerBlockModel.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  ctxContext = { type: 'blockmodel', target: headerBlockModel };
  filterCtxMenu('blockmodel');
  showCtxMenu(e.clientX, e.clientY);
});

// )
function openNewBlockModelDialog() {
  modalPurpose = 'blockmodel-new';
  modalTitle.textContent = 'New 3D block model';
  modalLabel.textContent = 'Enter a new model name';
  modalInput.value = 'New block model';
  // ,
  // )
  // ,
  modalCoordsysRow.style.display = '';
  modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => modalInput.focus(), 50);
}

document.getElementById('ctx-new-block-model').addEventListener('click', (e) => {
  e.stopPropagation();
  hideCtxMenu();
  openNewBlockModelDialog();
});

// folder node
function addNewBlockModelNode(modelName) {
  if (!subitemsBlockModel) return null;
  const wrapper = document.createElement('div');
  wrapper.innerHTML =
    '<div class="lp-sub-item has-children" data-role="block-model-node" onclick="toggleNode(this)">' +
      '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
      '<span>' + escapeHtml(modelName) + '</span>' +
    '</div>' +
    '<div class="lp-nested-items expanded"></div>';
  subitemsBlockModel.insertBefore(wrapper, subitemsBlockModel.firstChild);
  bindBlockContextMenus(wrapper);
  // folder node
  return wrapper.querySelector('[data-role="block-model-node"]');
}

// the project tree
// 1. the subfolder node
// the menu offers import block model CSV, rename, export block model CSV and delete
// ,
// )
// )
// ,
// )
// ,
function bindBlockContextMenus(root) {
  if (!root) return;
  // 1. the subfolder node
  root.querySelectorAll('[data-role="block-model-node"]').forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    // dragging the whole group back to the canvas: type='model' takes the else branch of setupNodeDraggable, which collects the model ids inside nested-items
    setupNodeDraggable(item, { type: 'model', modelRole: 'block-model' });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // )
      pendingBlockCategoryItem = item;
      ctxContext = { type: 'blockmodel-node', target: item };
      filterCtxMenu('blockmodel-node');
      showCtxMenu(e.clientX, e.clientY);
    });
  });

  // )
  root.querySelectorAll('.lp-sub-item[data-model-id]').forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxContext = { type: 'blockmodel-file', target: item };
      filterCtxMenu('blockmodel-file');
      showCtxMenu(e.clientX, e.clientY);
    });
  });
}
bindBlockContextMenus(subitemsBlockModel);

// section 99: export the block model CSV
// ,
// ,
// the three axis orders: three X = east (p.x), Y = elevation (p.y), Z = north (p.z) becomes Leapfrog X = east, Y = north, Z = elevation
//     X = p.x + ox ；Y = oy − p.z ；Z = p.y + oz
// the scaling follows the same pattern: dX = s.x, dY = s.z, dZ = s.y
function blockRowsToCsvLines(model) {
  const inst = model && model.mesh;
  if (!inst || !inst.isInstancedMesh) return null;
  const origin = model.blockOrigin || state.origin || { x: 0, y: 0, z: 0 };
  const gm = model.blockClass || model.blockGm || '';
  const m4 = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const out = ['Id,X,Y,Z,dX,dY,dZ,GM'];
  const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
  for (let i = 0; i < inst.count; i++) {
    inst.getMatrixAt(i, m4);
    m4.decompose(p, q, s);
    out.push((i + 1) + ',' + f2(p.x + origin.x) + ',' + f2(origin.y - p.z) + ',' + f2(p.y + origin.z) +
      ',' + f2(s.x) + ',' + f2(s.z) + ',' + f2(s.y) + ',' + gm);
  }
  return out;
}

function exportBlockCsvForModels(models, baseName) {
  const safe = (v) => String(v == null ? '' : v).replace(/[\\/:*?"<>|]/g, '_');
  let idx = 0;
  models.forEach(model => {
    const lines = blockRowsToCsvLines(model);
    if (!lines || lines.length <= 1) return;
    const gm = safe(model.blockClass || model.blockGm || ('class' + idx));
    const fname = (baseName ? safe(baseName) + '_' : '') + gm + '.csv';
    const text = lines.join('\n');
    setTimeout(() => downloadTextFile(text, fname, 'text/csv'), idx * 300);
    idx++;
  });
  if (!idx) flashBlockHint('This block model has no blocks to export');
  else flashBlockHint('Exported ' + idx + ' blocks CSV File');
}

// Export block model CSV: on a subfolder it exports every GM class beneath it, on a GM class node it exports that class only
document.getElementById('ctx-export-block').addEventListener('click', (e) => {
  e.stopPropagation();
  const ctx = ctxContext || {};
  const type = ctx.type, target = ctx.target;
  hideCtxMenu();
  if (!target) return;
  if (type === 'blockmodel-file') {
    const model = state.models.find(m => m.id === target.getAttribute('data-model-id'));
    if (!model) { flashBlockHint('Block model category not found, It may have been deleted'); return; }
    exportBlockCsvForModels([model], '');
    return;
  }
  // subfolder: collect every GM class beneath it
  const nested = target.nextElementSibling;
  const ids = (nested && nested.classList.contains('lp-nested-items'))
    ? Array.from(nested.querySelectorAll('.lp-sub-item[data-model-id]')).map(fn => fn.getAttribute('data-model-id'))
    : [];
  const models = ids.map(id => state.models.find(m => m.id === id)).filter(Boolean);
  if (!models.length) { flashBlockHint('This block model has no files to export'); return; }
  const baseName = (target.querySelector('span') || {}).textContent || 'Block Model';
  exportBlockCsvForModels(models, baseName);
});

// )
document.getElementById('ctx-import-block').addEventListener('click', (e) => {
  e.stopPropagation();
  hideCtxMenu();
  pendingBlockCategoryItem = (ctxContext && ctxContext.target) || pendingBlockCategoryItem;
  const input = document.getElementById('block-csv-input');
  input.value = '';
  input.click();
});

// choose the file, then parse and render it
const blockCsvInput = document.getElementById('block-csv-input');
blockCsvInput.addEventListener('change', async () => {
  const files = Array.from(blockCsvInput.files || []);
  if (!files.length) return;
  await importBlockModelFiles(files);
  blockCsvInput.value = '';
});

async function importBlockModelFiles(files) {
  // )
  let categoryItem = pendingBlockCategoryItem;
  if (!categoryItem || !document.contains(categoryItem)) {
    const autoName = (files[0] && files[0].name)
      ? files[0].name.replace(/\.[^.]+$/, '')
      : '3D Block Models';
    categoryItem = addNewBlockModelNode(autoName);
  }
  pendingBlockCategoryItem = null;
  const importRegion=window.researchRegions?.ownerOf(categoryItem);
  showImportLoading('Parsing block model...');
  await yieldToUI();
  let lastModelId = null;
  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    try {
      showImportProgress(5, 'Read ' + file.name + ' ...');
      await yieldToUI();
      const localPath=getFilePath(file);
      const useBackend=!!(localPath&&window.backendClient?.available&&window.electronAPI?.readBlockData);
      const text = useBackend ? '' : await file.text();
      const content = useBackend ? '' : text || (await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsText(file);
      }));
      if(window.researchRegionViews)await researchRegionViews.ensure(importRegion);
      const id = await buildBlockModelFromCsv(content, file.name, categoryItem, useBackend ? localPath : null);
      if (id) lastModelId = id;
    } catch (err) {
      hideImportLoading();
      alert('Unable to parse block model [ ' + file.name + ']：' + (err && err.message ? err.message : err));
    }
  }
  hideImportLoading();
  updateLegend();
  updateRenderOrder();
  buildAxisLabels();
  if (lastModelId) { fitViewToAll(); selectLayer(lastModelId); }
}

async function buildBlockModelFromCsv(text, fileName, categoryItem, localPath) {
  const targetState=state,targetScene=scene;
  const prepared=localPath ? await prepareLocalBlocks(localPath,state.origin) : await prepareBlockModelAsync(text,state.origin);
  if(state!==targetState||scene!==targetScene)throw new Error('The active 3D tab changed during import, Return to the target tab and import again');
  if(!state.origin)state.origin=prepared.origin;
  const {x:ox,y:oy,z:oz}=prepared.origin;
  const cats=prepared.groups.map(group=>group.name);
  // ,
  const geo = new THREE.BoxGeometry(1, 1, 1);
  let lastModelId = null;
  const totalCats = cats.length;

  for (let ci = 0; ci < totalCats; ci++) {
    const gm = cats[ci];
    const group=prepared.groups[ci];
    const count = group.count;
    const gmColor = blockGmColor(gm);
    const mat = new THREE.MeshStandardMaterial({
      color: gmColor, transparent: true, opacity: 0.7,
      roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide, depthWrite: true
    });
    const inst = new THREE.InstancedMesh(geo, mat, 0);
    inst.count = count;
    // Adopt transferred data directly; avoid a second per-block main-thread loop.
    inst.instanceMatrix=new THREE.InstancedBufferAttribute(group.matrices,16);
    const [bMinX,bMinY,bMinZ,bMaxX,bMaxY,bMaxZ]=group.bounds;
    accelerateBlockPicking(inst,group.chunkBounds);
    inst.instanceMatrix.needsUpdate = true;
    inst.userData.isModel = true;
    // )
    inst.frustumCulled = false;
    if (isFinite(bMinX)) {
      inst.userData.blockBox = new THREE.Box3(
        new THREE.Vector3(bMinX, bMinY, bMinZ),
        new THREE.Vector3(bMaxX, bMaxY, bMaxZ)
      );
    }
    const modelId = 'block_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    inst.userData.modelId = modelId;
    scene.add(inst);

    // the layer management
    const displayName = gm + '（' + count.toLocaleString() + ' blocks) ';
    const modelObj = {
      id: modelId,
      name: displayName,
      displayName: displayName,
      category: 'Block Model',
      regionId: window.researchRegions ? researchRegions.ownerOf(categoryItem) : undefined,
      mesh: inst,
      material: mat,
      visible: true,
      opacity: 0.7,
      color: gmColor,
      fileName: fileName,
      filePath: null,
      inScene: true,
      isBlockModel: true,
      blockClass: gm,
      // section 99: export the block model CSV
      blockOrigin: { x: ox, y: oy, z: oz }
    };
    state.models.push(modelObj);
    addLayerItem(modelObj);
    addBlockTreeNode(modelObj, categoryItem);
    lastModelId = modelId;

    showImportProgress(85 + Math.round((ci + 1) / totalCats * 15), 'Show ' + gm + ' ...');
    await yieldToUI();
  }
  return lastModelId;
}

// )
function addBlockTreeNode(modelObj, categoryItem) {
  const nested = (categoryItem && categoryItem.nextElementSibling
      && categoryItem.nextElementSibling.classList.contains('lp-nested-items'))
    ? categoryItem.nextElementSibling
    : document.getElementById('subitems-block-model');
  if (!nested) return;
  const node = document.createElement('div');
  node.className = 'lp-sub-item';
  node.setAttribute('data-model-id', modelObj.id);
  if(modelObj.regionId)node.dataset.regionId=modelObj.regionId;
  const hex = '#' + modelObj.color.toString(16).padStart(6, '0');
  node.innerHTML =
    '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="none"></path><polyline points="14 2 14 8 20 8" fill="none"></polyline></svg>' +
    '<span>' + escapeHtml(modelObj.displayName || modelObj.name) + '</span>' +
    '<span class="lm-color" style="background:' + hex + ';margin-left:6px;"></span>';
  node.addEventListener('click', () => selectLayer(modelObj.id));
  // )
  setupNodeDraggable(node, { type: 'blockmodel', modelId: modelObj.id });
  nested.appendChild(node);
  // )
  bindBlockContextMenus(nested);
  modelObj.treeFileNode = node;
  modelObj.treeCategoryItem = categoryItem || null;
}

// ============================================================
// 3D tunnel models: right-click the 3D tunnel models group header to open the new model dialog
// )
// ============================================================
const headerTunnelModel = document.getElementById('header-tunnel-model');
const subitemsTunnelModel = document.getElementById('subitems-tunnel-model');

headerTunnelModel.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  openNewTunnelModelDialog();
});

function openNewTunnelModelDialog() {
  modalPurpose = 'tunnel-new';
  modalTitle.textContent = 'New 3D tunnel model';
  modalLabel.textContent = 'Enter a new model name';
  modalInput.value = 'New tunnel model';
  // consistent with the 3D geological and geochemical models: the same coordinate system checkbox is shown
  modalCoordsysRow.style.display = '';
  modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => modalInput.focus(), 50);
}

// the project tree
function addNewTunnelModelNode(modelName) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML =
    '<div class="lp-sub-item has-children" data-role="tunnel-model-node" onclick="toggleNode(this)">' +
      '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
      '<span>' + escapeHtml(modelName) + '</span>' +
    '</div>' +
    '<div class="lp-nested-items expanded"></div>';
  subitemsTunnelModel.insertBefore(wrapper, subitemsTunnelModel.firstChild);
  bindTunnelContextMenus(wrapper);
}

// )
function bindTunnelContextMenus(root) {
  // )
  const modelItems = root.querySelectorAll('[data-role="tunnel-model-node"]');
  modelItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    setupNodeDraggable(item, { type: 'model', modelRole: 'tunnel-model' });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pendingCategoryItem = item; // logic
      ctxContext = { type: 'tunnel', target: item };
      filterCtxMenu('tunnel');
      showCtxMenu(e.clientX, e.clientY);
    });
  });

  // logic
  const fileItems = root.querySelectorAll('.lp-sub-item[data-model-id]');
  fileItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxContext = { type: 'file', target: item };
      filterCtxMenu('file');
      showCtxMenu(e.clientX, e.clientY);
    });
  });
}
bindTunnelContextMenus(document.getElementById('subitems-tunnel-model'));

// ============================================================
// figure management: the context menu bindings plus the import, rename, delete and export logic
// )
// ============================================================
const drawingFileInput = document.getElementById('drawing-file-input');
const subitemsDrawingMgmt = document.getElementById('subitems-drawing-mgmt');
// )
const subitemsSurface = document.getElementById('subitems-surface');
const headerSurface = document.getElementById('header-surface');
// in-memory storage for the figures: {id: {id, fileName, categoryNode, blobUrl, blob, ext}}
state.drawings = state.drawings || {};
state.pointLayers = state.pointLayers || {};
let pendingDrawingCategory = null; // 右键时记下要导入到哪个分类节点

// recognise the drawing-category and drawing-file nodes in the global click and context menu events
// )

// ============================================================
// ,
// )
// ============================================================
const headerDrawingMgmt = document.getElementById('header-drawing-mgmt');

headerDrawingMgmt.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  openNewDrawingGroupDialog();
});

// Section 102: right-click the Surface group header to create a category beneath Surface
// (it reuses exactly the same new subcategory dialog and write-to-disk path as figure management;
// ,
if (headerSurface) {
  headerSurface.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openNewDrawingSubCategoryDialog(headerSurface);
  });
}

function openNewDrawingGroupDialog() {
  modalPurpose = 'drawing-group-new';
  modalTitle.textContent = 'New map group';
  modalLabel.textContent = 'Enter a map group name';
  modalInput.value = 'xx Maps and Figures';
  modalCoordsysRow.style.display = 'none';
  modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => modalInput.focus(), 50);
}

// ,
let pendingDrawingSubParent = null;

// )
function openNewDrawingSubCategoryDialog(parentNode) {
  if (!parentNode) return;
  const catName = ((parentNode.querySelector('span') || {}).textContent || '').trim();
  pendingDrawingSubParent = parentNode;
  modalPurpose = 'drawing-subcategory-new';
  modalTitle.textContent = 'New subcategory';
  modalLabel.textContent = 'in“ ' + catName + ' ”Create a subcategory under (Enter a name, e.g. drillhole ID ZK1203) ';
  // ,
  modalInput.value = (catName === 'Core Data') ? 'ZK' : 'New subcategory';
  modalCoordsysRow.style.display = 'none';
  modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => { modalInput.focus(); modalInput.select(); }, 50);
}

// )
function buildDrawingCategoryNode(name) {
  return '' +
    '<div class="lp-sub-item has-children" data-role="drawing-category" onclick="toggleNode(this)">' +
      '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
      '<span>' + escapeHtml(name) + '</span>' +
    '</div>' +
    '<div class="lp-nested-items expanded"></div>';
}

// )
// ,
// )
const DEFAULT_DRAWING_SUBCATEGORIES = [ 'Cross Sections', 'Level Plans', 'Mining Rights Maps', 'Drillhole Log', 'Core Data'];

// ,
// this is used by the skeleton node check in hasRealProjectContent(), so that an empty category is not counted as user work
const SURFACE_BUILTIN_CATEGORIES = ['Remote Sensing Imagery', 'Geological Maps'];

// )
function wrapExistingDrawingCategories() {
  if (!subitemsDrawingMgmt) return;
  if (subitemsDrawingMgmt.querySelector('[data-role="drawing-group"]')) return;
  const cats = Array.from(subitemsDrawingMgmt.children)
    .filter(el => el.getAttribute('data-role') === 'drawing-category');
  if (cats.length === 0) return;
  const groupNode = document.createElement('div');
  groupNode.className = 'lp-sub-item has-children';
  groupNode.setAttribute('data-role', 'drawing-group');
  groupNode.setAttribute('onclick', 'toggleNode(this)');
  groupNode.innerHTML =
    '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
    '<span>xx Maps and Figures</span>';
  const groupNested = document.createElement('div');
  groupNested.className = 'lp-nested-items expanded';
  cats.forEach(cat => {
    const nested = cat.nextElementSibling;
    groupNested.appendChild(cat);
    if (nested && nested.classList.contains('lp-nested-items')) groupNested.appendChild(nested);
  });
  subitemsDrawingMgmt.appendChild(groupNode);
  subitemsDrawingMgmt.appendChild(groupNested);
}

// new figure group: the parent node plus a default subcategory
function addDrawingGroup(groupName) {
  const wrapper = document.createElement('div');
  const childrenHtml = DEFAULT_DRAWING_SUBCATEGORIES.map(c => buildDrawingCategoryNode(c)).join('');
  wrapper.innerHTML =
    '<div class="lp-sub-item has-children" data-role="drawing-group" onclick="toggleNode(this)">' +
      '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
      '<span>' + escapeHtml(groupName) + '</span>' +
    '</div>' +
    '<div class="lp-nested-items expanded">' + childrenHtml + '</div>';
  subitemsDrawingMgmt.appendChild(wrapper);
  bindDrawingContextMenus(subitemsDrawingMgmt);
}

// create a new subcategory beneath a parent group or category
// the section 67 change:
// ,
// ,
// )
function addDrawingSubCategory(groupNode, name) {
  if (!groupNode) return false;
  const nested = groupNode.nextElementSibling;
  if (!nested || !nested.classList.contains('lp-nested-items')) {
    flashDrawingHint('A subcategory cannot be created under this node: Right-click“Maps and Figures”categories under (e.g.“Core Data”) then create');
    return false;
  }
  // ,
  const wanted = String(name || '').trim();
  const exists = Array.from(nested.children).some(el =>
    el.getAttribute && el.getAttribute('data-role') === 'drawing-category' &&
    ((el.querySelector('span') || {}).textContent || '').trim().toLowerCase() === wanted.toLowerCase());
  if (exists) {
    flashDrawingHint('Subcategory“ ' + wanted + ' ”already exists, Existing tab reused');
    return false;
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = buildDrawingCategoryNode(name);
  while (tmp.firstChild) nested.appendChild(tmp.firstChild);
  // ,
  nested.classList.add('expanded');
  const prev = groupNode.previousElementSibling;
  if (prev && prev.classList && prev.classList.contains('lp-sub-item')) prev.classList.remove('collapsed');
  // ,
  // )
  try { bindDrawingContextMenus(subitemsDrawingMgmt); } catch (e) {}
  if (subitemsSurface) { try { bindDrawingContextMenus(subitemsSurface); } catch (e) {} }
  flashDrawingHint('Subcategory created“ ' + wanted + '」');
  // )
  // ,
  // ,
  // 
  //
  // ,
  // ,
  // ,
  // so that the baseline that newly created content is never lost is not broken.
  persistProjectSilently();
  return true;
}

// ============================================================
// )
// ============================================================
// ,
//
// why doSaveProject(true) cannot be used directly:
// the logic inside doSaveProject is that when currentProjectPath is empty it always shows showSaveDialog.
// ,
// ,
//
// )
// ,
// ,
// )
//
// )
function persistProjectSilently() {
  // )
  if (window.electronAPI && window.electronAPI.saveSession) {
    try {
      // ,
      Promise.resolve(saveSessionNow()).catch(() => {});
      return true;
    } catch (e) {}
  }
  // 2) the project already has a path, so it is overwritten silently
  if (currentProjectPath) {
    try {
      Promise.resolve(doSaveProject(true)).catch(() => {});
      return true;
    } catch (e) {}
  }
  // ,
  return false;
}

// )
function deleteDrawingGroup(groupNode) {
  const nested = groupNode.nextElementSibling;
  const name = (groupNode.querySelector('span') || {}).textContent || 'This group';
  let count = 0;
  if (nested) count = nested.querySelectorAll('.lp-sub-item[data-drawing-id]').length;
  if (!confirm('Confirm deletion“ ' + name + '」' + (count > 0 ? 'and its ' + count + ' maps or figures' : '') + ' ??')) return;
  if (nested) {
    nested.querySelectorAll('.lp-sub-item[data-drawing-id]').forEach(fn => {
      const id = fn.getAttribute('data-drawing-id');
      const d = state.drawings[id];
      if (d && d.blobUrl) URL.revokeObjectURL(d.blobUrl);
      delete state.drawings[id];
      const key = getDrawingKey(fn);
      if (drawingRegisters[key]) {
        removeRegisterPlaneModel(key);
        delete drawingRegisters[key];
      }
    });
  }
  groupNode.remove();
  if (nested) nested.remove();
}

function bindDrawingContextMenus(root) {
  // )
  const catItems = root.querySelectorAll('[data-role="drawing-category"]');
  catItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pendingDrawingCategory = item;

      const catName = ((item.querySelector('span') || {}).textContent || '').trim();
      ctxContext = { type: 'drawing', target: item, drawingCatName: catName, drawingCatNode: item };
      // ,
      // ,
      // ,
      // 
      filterCtxMenu('drawing');
      const newSubItem = document.getElementById('ctx-new-drawing-category');
      if (newSubItem) newSubItem.style.display = (catName === 'Core Data') ? '' : 'none';
      showCtxMenu(e.clientX, e.clientY);
    });
  });

  // )
  const groupItems = root.querySelectorAll('[data-role="drawing-group"]');
  groupItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxContext = { type: 'drawing-group', target: item };
      filterCtxMenu('drawing-group');
      showCtxMenu(e.clientX, e.clientY);
    });
  });

  // )
  const fileItems = root.querySelectorAll('.lp-sub-item[data-drawing-id]');
  fileItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxContext = { type: 'drawing-file', target: item };
      filterCtxMenu('drawing-file');
      showCtxMenu(e.clientX, e.clientY);
    });
    // double-click a figure file to open the image in a new tab
    item.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openDrawingInNewTab(item);
    });

    // control point registration: add a Register button and allow dragging onto the 3D canvas
    initDrawingFileItem(item);
  });
}


// )
// the state
// ============================================================
const drawingRegisters = {};
let ivDragMoved = false, ivDragMovedAt = 0;

// ,
function getDrawingKey(fileNode) {
  return fileNode.getAttribute('data-drawing-path') || fileNode.getAttribute('data-drawing-id') || ('drawing_' + Math.random().toString(36).slice(2, 6));
}

// initialise a figure file child: add the Register button, cache the blobUrl and allow dragging onto the 3D canvas
function initDrawingFileItem(item) {
  if (item._regInit) return;
  item._regInit = true;
  if (!item.querySelector('.lp-reg-btn')) {
    const btn = document.createElement('span');
    btn.className = 'lp-reg-btn';
    btn.title = 'Control-point registration';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7"></circle><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"></circle><line x1="12" y1="1" x2="12" y2="5"></line><line x1="12" y1="19" x2="12" y2="23"></line><line x1="1" y1="12" x2="5" y2="12"></line><line x1="19" y1="12" x2="23" y2="12"></line></svg>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      startRegisterDrawing(item);
    });
    // )
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startRegisterDrawing(item);
    });
    item.appendChild(btn);
  }
  // ,
  if (!item.getAttribute('data-drawing-blob')) {
    const id = item.getAttribute('data-drawing-id');
    const d = state.drawings && state.drawings[id];
    if (d && d.blobUrl) item.setAttribute('data-drawing-blob', d.blobUrl);
  }
  // drag onto the 3D canvas to create a textured plane
  setupDrawingDraggable(item, getDrawingKey(item));
  refreshDrawingRegBtn(item);
}

function refreshDrawingRegBtn(item) {
  const btn = item.querySelector('.lp-reg-btn');
  if (!btn) return;
  const reg = drawingRegisters[getDrawingKey(item)];
  const done = !!(reg && reg.done);
  btn.classList.toggle('registered', done);
  btn.title = done ? 'Registered, Click to register again' : 'Control-point registration';
}

function refreshDrawingRegButtons() {
  document.querySelectorAll('.lp-sub-item[data-drawing-id]').forEach(i => refreshDrawingRegBtn(i));
}

// figure file child dragged onto the 3D canvas
function setupDrawingDraggable(node, key) {
  if (node._regDragBound) return;
  node._regDragBound = true;
  node.setAttribute('draggable', 'true');
  node.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'drawing-file', drawingKey: key }));
    e.dataTransfer.effectAllowed = 'copy';
    canvas.classList.add('drag-target');
  });
  node.addEventListener('dragend', () => {
    canvas.classList.remove('drag-target');
  });
}

// enter registration mode: open or switch to that image tab
async function startRegisterDrawing(fileNode) {
  const key = getDrawingKey(fileNode);
  const id = fileNode.getAttribute('data-drawing-id');
  if (await openDrawingInNewTab(fileNode) === false) return;
  // ,
  // ignore
  const st = getActiveImageState();
  if (!st || st.type !== 'image') {
    window.showTabModal({
      title: 'Unable to enter registration mode',
      label: 'The corresponding image tab was not found, Double-click the image under Maps and Figures, then try again. '
    });
    return;
  }
  st.regKey = key;
  st.regDrawingId = id;
  st.regFilePath = fileNode.getAttribute('data-drawing-path') || null;
  st.regFileUrl = fileNode.getAttribute('data-drawing-blob') || st.regFilePath || null;
  st.regFileName = st.imageName || '';
  st.regMode = true;
  st.regEditing = -1; // ,
  const reg = drawingRegisters[key];
  if (reg && reg.done && reg.points && reg.points.length === 3) {
    // ,
    st.regPoints = reg.points.map((p, i) => ({
      u: p.u, v: p.v, x: p.x, y: p.y, z: p.z, saved: false
    }));
  } else {
    // ,
    st.regPoints = [];
  }
  // ,
  const renderWhenReady = () => {
    const s2 = getActiveImageState();
    if (s2 && s2.regMode) renderRegisterUI();
  };
  if (ivImg.complete && ivImg.naturalWidth) renderRegisterUI();
  else {
    ivImg.addEventListener('load', renderWhenReady, { once: true });
    ivImg.addEventListener('error', renderWhenReady, { once: true });
    // ,
    setTimeout(() => {
      const s2 = getActiveImageState();
      if (s2 && s2.regMode && !s2._regUIRendered) renderRegisterUI();
    }, 2500);
  }
}

// )
function renderRegisterUI() {
  const st = getActiveImageState();
  if (!st || !st.regMode) return;
  const wrap = document.getElementById('image-viewer-wrap');
  const panel = document.getElementById('register-panel-top');
  const layer = document.getElementById('register-marker-layer');
  if (!panel || !layer) return;
  wrap.classList.add('reg-active');
  // build the panel structure for the first time
  if (!panel._bound) {
    panel._bound = true;
    panel.innerHTML =
      '<div class="rp-title">Control-point registration <span class="rp-file"></span></div>' +
      '<div class="rp-hint" id="rp-hint"></div>' +
      '<div class="rp-status" id="rp-status"></div>' +
      '<div class="rp-btns">' +
      '<button class="rp-btn rp-btn-primary" id="rp-confirm">Register</button>' +
      '<button class="rp-btn rp-btn-ghost" id="rp-cancel">Cancel</button>' +
      '<button class="rp-btn rp-btn-link" id="rp-clear">Reset control points</button>' +
      '</div>';
    panel.querySelector('#rp-confirm').addEventListener('click', confirmRegister);
    panel.querySelector('#rp-cancel').addEventListener('click', () => {
      const s = getActiveImageState();
      if (s && s.regMode) exitRegisterMode(s);
    });
    panel.querySelector('#rp-clear').addEventListener('click', () => {
      const s = getActiveImageState();
      if (!s || !s.regMode) return;
      s.regPoints = [];
      s.regEditing = -1;
      closeRegisterPop();
      renderRegisterUI();
    });
  }
  panel.classList.remove('hidden');
  panel.querySelector('.rp-file').textContent = st.regFileName || '';
  st._regUIRendered = true;
  // ,
  if (!ivImg.naturalWidth) {
    const hintEl = panel.querySelector('#rp-hint');
    if (hintEl) hintEl.innerHTML = '<span style="color:#e74c3c">The image failed to load or is still loading, A control point cannot be selected at the moment. </span>';
    const statusEl = panel.querySelector('#rp-status');
    if (statusEl) statusEl.innerHTML = 'Check the image file path, then, Reopen the image tab and try again. ';
  } else {
    refreshRegisterPanel(st);
    // render the markers and the floating popup
    renderRegisterMarkers(st, layer);
  }
  // ,
  syncRegisterPanelLayout();
}

// the state
function refreshRegisterPanel(st) {
  const panel = document.getElementById('register-panel-top');
  if (!panel) return;
  const saved = (st.regPoints || []).filter(p => p.saved).length;
  const hint = document.getElementById('rp-hint');
  const status = document.getElementById('rp-status');
  const confirmBtn = panel.querySelector('#rp-confirm');
  if (saved === 0) {
    hint.innerHTML = 'Right-click a feature with known coordinates on the image (e.g. drillhole collars, Coordinate grid intersection) , Locate in sequence <b>3</b> points. ';
    status.innerHTML = '';
  } else if (saved < 3) {
    hint.innerHTML = 'Right-click the image to select control point <b>' + (saved + 1) + '</b> features. ';
    status.innerHTML = 'Confirmed <b>' + saved + '</b>/3 points';
  } else {
    hint.innerHTML = '3 points have all been confirmed, Click below“<b>Register</b>”button to finish registration. ';
    status.innerHTML = '';
  }
  confirmBtn.disabled = saved < 3;
}

// render the markers and the floating popup
function renderRegisterMarkers(st, layer) {
  layer.innerHTML = '';
  if (!ivImg.naturalWidth) return;
  st.regPoints.forEach((p, i) => {
    const pos = markerStagePos(p.u, p.v);
    const mk = document.createElement('div');
    mk.className = 'reg-marker c' + i + (p.saved ? ' saved' : '') + (i === st.regEditing ? ' editing' : '');
    mk.dataset.regIndex = i;
    mk.style.left = pos.x + 'px';
    mk.style.top = pos.y + 'px';
    mk.textContent = (i + 1);
    mk.title = p.saved ? 'Point ' + (i + 1) + '  (Locked) ' : 'Point ' + (i + 1) + '  (Right-click here to enter coordinates) ';
    // stop a press on a marker from starting an image drag
    mk.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
    });
    mk.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openRegisterPop(st, i, layer);
    });
    layer.appendChild(mk);
  });
  // ,
  if (st.regEditing >= 0 && st.regPoints[st.regEditing]) {
    renderRegisterPop(st, st.regEditing, layer);
  }
}

// right-click the image to add a point awaiting coordinates and open the floating popup
function addRegisterPointFromClick(e) {
  const st = getActiveImageState();
  if (!st || !st.regMode) return;
  const layer = document.getElementById('register-marker-layer');
  if (!layer) return;
  // ,
  closeRegisterPop();
  const pts = st.regPoints || [];
  if (pts.length >= 3) {
    window.showTabModal({ title: 'Maximum control points reached', label: 'Selected 3 control points, Enter coordinates for each point and click“Register”. To select again, first“Reset control points”. ' });
    return;
  }
  const pt = imagePointFromEvent(e);
  if (!pt) return; // 未落在图片范围内
  // )
  const near = pts.findIndex(p => Math.abs(p.u - pt.u) < 4 && Math.abs(p.v - pt.v) < 4);
  if (near >= 0) {
    openRegisterPop(st, near, layer);
    return;
  }
  pts.push({ u: pt.u, v: pt.v, saved: false });
  st.regEditing = pts.length - 1;
  refreshRegisterPanel(st);
  renderRegisterMarkers(st, layer);
  syncRegisterPanelLayout();
}

// )
function openRegisterPop(st, i, layer) {
  closeRegisterPop();
  const p = st.regPoints[i];
  if (!p) return;
  if (p.saved) {
    // ,
    st.regEditing = i;
    renderRegisterMarkers(st, layer);
    window.showTabModal({ title: 'Point ' + (i + 1) + ' Locked', label: 'This control point has been confirmed and saved (X/Y/Z Coordinates entered) , Read-only. To adjust, click“Reset control points”then select again. ' });
    st.regEditing = -1;
    renderRegisterMarkers(st, layer);
    return;
  }
  st.regEditing = i;
  renderRegisterMarkers(st, layer);
}

// )
function renderRegisterPop(st, i, layer) {
  const pos = markerStagePos(st.regPoints[i].u, st.regPoints[i].v);
  const pop = document.createElement('div');
  pop.className = 'reg-pop';
  pop.id = 'reg-pop';
  pop.style.left = (pos.x + 18) + 'px';
  pop.style.top = (pos.y - 40) + 'px';
  pop.innerHTML =
    '<div class="reg-pop-tip">Point <b>' + (i + 1) + '</b> Coordinates (GOCAD World coordinates) </div>' +
    '<div class="reg-pop-row"><span class="rp-axis">X</span><input data-axis="x" placeholder="East"></div>' +
    '<div class="reg-pop-row"><span class="rp-axis">Y</span><input data-axis="y" placeholder="North"></div>' +
    '<div class="reg-pop-row"><span class="rp-axis">Z</span><input data-axis="z" placeholder="Elevation"></div>' +
    '<div class="reg-pop-btns">' +
    '<button class="reg-pop-ok" id="reg-pop-ok">Confirm</button>' +
    '<button class="reg-pop-cancel" id="reg-pop-cancel">Cancel</button>' +
    '</div>';
  // when registering again, the previously confirmed coordinates can be prefilled
  const pv = st.regPoints[i];
  if (pv && pv.x !== undefined) {
    const xInp = pop.querySelector('input[data-axis="x"]');
    const yInp = pop.querySelector('input[data-axis="y"]');
    const zInp = pop.querySelector('input[data-axis="z"]');
    if (xInp) xInp.value = pv.x;
    if (yInp) yInp.value = pv.y;
    if (zInp) zInp.value = pv.z;
  }
  layer.appendChild(pop);
  // ,
  const r = ivStage.getBoundingClientRect();
  const popW = 178, popH = pop.offsetHeight || 130;
  if (pos.x + 18 + popW > r.width) pop.style.left = (pos.x - 18 - popW) + 'px';
  if (pos.y - 40 + popH > r.height) pop.style.top = (pos.y - popH + 34) + 'px';
  if (pos.y - 40 < 0) pop.style.top = '6px';
  pop.querySelector('#reg-pop-ok').addEventListener('click', () => saveRegisterPoint(st, i));
  pop.querySelector('#reg-pop-cancel').addEventListener('click', closeRegisterPop);
  // press Enter to confirm
  pop.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); saveRegisterPoint(st, i); }
    });
  });
  const first = pop.querySelector('input[data-axis="x"]');
  if (first) first.focus();
}

// )
function saveRegisterPoint(st, i) {
  const pop = document.getElementById('reg-pop');
  if (!pop) return;
  const get = (axis) => {
    const inp = pop.querySelector('input[data-axis="' + axis + '"]');
    const v = inp ? parseFloat(inp.value) : NaN;
    return (inp && inp.value !== '' && !isNaN(v)) ? v : undefined;
  };
  const x = get('x'), y = get('y'), z = get('z');
  if (x === undefined || y === undefined || z === undefined) {
    window.showTabModal({ title: 'Coordinates are incomplete', label: 'For point ' + (i + 1) + ' Enter complete X / Y / Z Coordinates (GOCAD World coordinates) . ' });
    return;
  }
  const p = st.regPoints[i];
  if (p) {
    p.x = x; p.y = y; p.z = z; p.saved = true;
  }
  st.regEditing = -1;
  closeRegisterPop();
  refreshRegisterPanel(st);
  renderRegisterMarkers(st, document.getElementById('register-marker-layer'));
  syncRegisterPanelLayout();
}

// close the floating popup
function closeRegisterPop() {
  const pop = document.getElementById('reg-pop');
  if (pop) pop.remove();
}

// ,
function syncRegisterPanelLayout() {
  const wrap = document.getElementById('image-viewer-wrap');
  const panel = document.getElementById('register-panel-top');
  if (!wrap || !panel) return;
  const h = (panel.offsetHeight || 190) + 8; // 面板距顶 8px 边距
  wrap.style.setProperty('--reg-panel-h', h + 'px');
  updateRegisterMarkers();
}

// keep the upper and lower window layout when the window size changes
window.addEventListener('resize', () => {
  const st = getActiveImageState();
  if (st && st.regMode) syncRegisterPanelLayout();
});

// ,
function updateRegisterMarkers() {
  const st = getActiveImageState();
  const layer = document.getElementById('register-marker-layer');
  if (!st || !st.regMode || !layer) return;
  st.regPoints.forEach((p, i) => {
    const mk = layer.querySelector('.reg-marker[data-reg-index="' + i + '"]');
    if (!mk) return;
    const pos = markerStagePos(p.u, p.v);
    mk.style.left = pos.x + 'px';
    mk.style.top = pos.y + 'px';
  });
  // ,
  const pop = document.getElementById('reg-pop');
  if (pop && st.regEditing >= 0 && st.regPoints[st.regEditing]) {
    const pos = markerStagePos(st.regPoints[st.regEditing].u, st.regPoints[st.regEditing].v);
    pop.style.left = (pos.x + 18) + 'px';
    pop.style.top = (pos.y - 40) + 'px';
  }
}

// the state
function hideRegisterOverlay() {
  closeRegisterPop();
  const wrap = document.getElementById('image-viewer-wrap');
  const panel = document.getElementById('register-panel-top');
  const layer = document.getElementById('register-marker-layer');
  if (wrap) wrap.classList.remove('reg-active');
  if (panel) panel.classList.add('hidden');
  if (layer) layer.innerHTML = '';
}

// )
function exitRegisterMode(st) {
  if (st) {
    st.regMode = false;
    st.regPoints = [];
    st.regXYZ = [];
    st.regKey = null;
    st.regEditing = -1;
  }
  closeRegisterPop();
  const wrap = document.getElementById('image-viewer-wrap');
  const panel = document.getElementById('register-panel-top');
  const layer = document.getElementById('register-marker-layer');
  if (wrap) wrap.classList.remove('reg-active');
  if (panel) panel.classList.add('hidden');
  if (layer) layer.innerHTML = '';
}

// )
// ,
function imagePointFromEvent(e, clampToEdge) {
  const w = ivImg.naturalWidth, h = ivImg.naturalHeight;
  const rect = ivImg.getBoundingClientRect();
  if (!w || !h || rect.width <= 0 || rect.height <= 0) return null;
  // Real image bounds include CSS sizing, zoom and translation; small images
  // are not upscaled by max-width/max-height. Edge tolerance is in screen pixels.
  if (!clampToEdge && (e.clientX < rect.left - 4 || e.clientX > rect.right + 4 ||
      e.clientY < rect.top - 4 || e.clientY > rect.bottom + 4)) return null;
  return {
    u: Math.max(0, Math.min(w, (e.clientX - rect.left) * w / rect.width)),
    v: Math.max(0, Math.min(h, (e.clientY - rect.top) * h / rect.height))
  };
}

// )
ivStage.addEventListener('contextmenu', (e) => {
  const st = getActiveImageState();
  if (!st || !st.regMode) {
    // right-clicking the image in the normal viewing mode guides the user into registration mode first
    if (st && st.type === 'image' && !st.regMode && !e.target.closest('.reg-pop')) {
      e.preventDefault();
      window.showTabModal({
        title: 'Registration mode is not active',
        label: 'First, under Maps and Figures on the left,, Right-click the image\'s“Register”button to enter registration mode, Then right-click a feature on the image. '
      });
    }
    return;
  }
  e.preventDefault(); // 阻止浏览器默认右键菜单
  // )
  if (e.target.closest('.reg-pop')) return;
  // A deliberate right click remains valid immediately after left-button panning.
  ivDragMoved = false;
  addRegisterPointFromClick(e);
});

// )
function markerStagePos(u, v) {
  const w = ivImg.naturalWidth, h = ivImg.naturalHeight;
  const imageRect = ivImg.getBoundingClientRect();
  const stageRect = ivStage.getBoundingClientRect();
  return {
    x: imageRect.left - stageRect.left + (w ? u * imageRect.width / w : 0),
    y: imageRect.top - stageRect.top + (h ? v * imageRect.height / h : 0)
  };
}

// the 2D to 3D affine transform: three pixel points (u, v) to the GOCAD (x, y, z)
// ,
function solveAffine2DTo3D(points) {
  if (!points || points.length < 3) return null;
  const u = points.map(p => p.u), v = points.map(p => p.v);
  const det = u[0] * (v[1] - v[2]) - v[0] * (u[1] - u[2]) + (u[1] * v[2] - v[1] * u[2]);
  if (Math.abs(det) < 1e-9) return null; // 像素三点共线
  const solveComponent = (rhs) => {
    const a = (rhs[0] * (v[1] - v[2]) - v[0] * (rhs[1] - rhs[2]) + (rhs[1] * v[2] - v[1] * rhs[2])) / det;
    const b = (u[0] * (rhs[1] - rhs[2]) - rhs[0] * (u[1] - u[2]) + (u[1] * rhs[2] - rhs[1] * u[2])) / det;
    const c = (u[0] * (v[1] * rhs[2] - v[2] * rhs[1]) - v[0] * (u[1] * rhs[2] - u[2] * rhs[1]) + rhs[0] * (u[1] * v[2] - u[2] * v[1])) / det;
    return { a, b, c };
  };
  return {
    x: solveComponent(points.map(p => p.x)),
    y: solveComponent(points.map(p => p.y)),
    z: solveComponent(points.map(p => p.z))
  };
}

// apply the affine transform: an image pixel (u, v) to the GOCAD coordinates
function applyAffineTransform(tr, u, v) {
  return {
    x: tr.x.a * u + tr.x.b * v + tr.x.c,
    y: tr.y.a * u + tr.y.b * v + tr.y.c,
    z: tr.z.a * u + tr.z.b * v + tr.z.c
  };
}

// confirm the registration: compute and store the affine transform
function confirmRegister() {
  const st = getActiveImageState();
  if (!st || !st.regMode) return;
  const pts = st.regPoints || [];
  if (pts.length < 3) {
    window.showTabModal({ title: 'Insufficient control points', label: 'Click the image to select 3 control points and confirm their coordinates before clicking“Register”. ' });
    return;
  }
  const points = [];
  for (let i = 0; i < 3; i++) {
    const p = pts[i];
    if (!p || !p.saved || p.x === undefined || p.y === undefined || p.z === undefined ||
        isNaN(p.x) || isNaN(p.y) || isNaN(p.z)) {
      window.showTabModal({ title: 'Coordinates are incomplete', label: 'For number ' + (i + 1) + ' control points with complete X / Y / Z Coordinates (GOCAD World coordinates) . ' });
      return;
    }
    points.push({ u: p.u, v: p.v, x: p.x, y: p.y, z: p.z });
  }
  const tr = solveAffine2DTo3D(points);
  if (!tr) {
    window.showTabModal({ title: 'Invalid control point', label: 'The three control points must not be collinear on the image, Select non-collinear points again 3 features. ' });
    return;
  }
  const key = st.regKey;
  const prev = drawingRegisters[key];
  drawingRegisters[key] = {
    key: key,
    drawingId: st.regDrawingId,
    filePath: st.regFilePath,
    fileUrl: st.regFileUrl,
    fileName: st.regFileName,
    done: true,
    points: points,
    transform: tr,
    imageWidth: ivImg.naturalWidth,
    imageHeight: ivImg.naturalHeight,
    planeModelId: prev ? prev.planeModelId : null,
    planeTabId: prev ? prev.planeTabId : null
  };
  const reg = drawingRegisters[key];
  // re-register: rebuild the plane on the tab where the old plane was, using the new transform; on the first registration a translucent textured plane is created automatically
  if(st.regDrawingId&&state.drawings[st.regDrawingId]){
    state.drawings[st.regDrawingId].manualRegistration={transform:tr,points:points,imageWidth:ivImg.naturalWidth,imageHeight:ivImg.naturalHeight};
  }
  if (reg.planeModelId) rebuildPlaneAfterReRegister(reg);
  else buildRegisterPlaneInScene(reg);
  exitRegisterMode(st);
  refreshDrawingRegButtons();
  window.showTabModal({ title: 'Registration complete', label: '「' + (reg.fileName || '') + ' ”Registered to GOCAD Coordinate system, A translucent image plane has also been created in the 3D view (Click its entry in Layers to highlight it / Adjust opacity / Delete) . ' });
}

// ============================================================
// )
// ============================================================
// the layer management
function buildPlaneInto(viewer, reg) {
  const st = viewer.state, sc = viewer.scene;
  if (!st || !sc) return;
  if (!st.origin) {
    window.showTabModal({ title: 'Unable to generate the image plane', label: 'The 3D view has no coordinate origin yet (First import a 3D model in the same coordinate system as the image) . Import a model first, Then drag the registered image to create an image plane. ' });
    return;
  }
  if (!reg.fileUrl) {
    window.showTabModal({ title: 'Unable to generate the image plane', label: 'This map has no image data available to load (No file path or in-memory data was found) . \n Import the map again before registration. ' });
    return;
  }
  // ,
  const imgProbe = new Image();
  imgProbe.onerror = () => {
    window.showTabModal({ title: 'Image loading failed', label: 'Unable to load the texture image:  ' + (reg.fileUrl || '') + '\n Check that the image file exists, and the page is served by a local server (http://localhost) Open. ' });
  };
  imgProbe.src = reg.fileUrl;
  const texture = new THREE.TextureLoader().load(reg.fileUrl, (tex) => {
    const cur = drawingRegisters[reg.key];
    if (!cur || cur.transform !== reg.transform) return; // ,
    const w = tex.image.width, h = tex.image.height;
    if (!w || !h) return;
    const toThree = (u, v) => {
      const g = applyAffineTransform(reg.transform, u, v);
      return gocadToThree(g.x, g.y, g.z, st.origin.x, st.origin.y, st.origin.z);
    };
    const p0 = toThree(0, 0), p1 = toThree(w, 0), p2 = toThree(w, h), p3 = toThree(0, h);
    const positions = new Float32Array([
      p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z,
      p0.x, p0.y, p0.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z
    ]);
    // the V direction of the UVs must be the opposite of the image pixel row order:
    // ,
    // )
    // 
    // )
    // ,
    const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    // ,
    // ,
    // ,
    // ,
    // )
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.8,
      side: THREE.DoubleSide, depthWrite: false, depthTest: true
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = reg.fileName + '  (Texture) ';
    // the model property panel needs the geoMesh.boundingBox data
    const xs = positions.filter((_, i) => i % 3 === 0);
    const ys = positions.filter((_, i) => i % 3 === 1);
    const zs = positions.filter((_, i) => i % 3 === 2);
    const modelId = 'regplane_' + reg.key.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_') + '_' + Math.random().toString(36).slice(2, 6);
    const model = {
      id: modelId,
      type: 'registerPlane',
      drawingKey: reg.key, regionId: state.drawings?.[reg.key]?.regionId || viewer.regionId,
      category: 'Image plane',
      fileName: reg.fileName + '  (Texture) ',
      name: reg.fileName,
      color: 0x1A73E8,
      opacity: 0.8,
      inScene: true,
      visible: true,
      isRegisterPlane: true,
      mesh: mesh,
      material: mat,
      geoMesh: {
        boundingBox: [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), Math.min(...zs), Math.max(...zs)],
        vertexCount: 6,
        triangleCount: 2,
        fileName: reg.fileName + '  (Texture) '
      }
    };
    st.models.push(model);
    sc.add(mesh);
    reg.planeModelId = modelId;
    reg.planeTabId = null;
    tabViewers.forEach((v, tid) => { if (v === viewer) reg.planeTabId = tid; });
    // only the active tab needs the layer management and the legend refreshed
    if (tabViewers.get(activeTabId) === viewer) {
      addLayerItem(model);
      updateLegend();
      updateRenderOrder();
      buildAxisLabels();
      const emptyPh = document.getElementById('empty-placeholder');
      if (emptyPh) emptyPh.classList.add('hidden');
      if (st.placeholderMesh) {
        sc.remove(st.placeholderMesh);
        if (st.placeholderMesh.geometry) st.placeholderMesh.geometry.dispose();
        if (st.placeholderMesh.material) st.placeholderMesh.material.dispose();
        st.placeholderMesh = null;
      }
      selectLayer(modelId);
    }
  });
  texture.anisotropy = 4;
}

// remove the textured plane model from a given 3D tab
function removePlaneFromViewer(viewer, modelId) {
  const st = viewer.state;
  if (!st) return;
  const idx = st.models.findIndex(m => m.id === modelId);
  if (idx < 0) return;
  const m = st.models[idx];
  if (m.mesh && m.mesh.parent) m.mesh.parent.remove(m.mesh);
  if (m.mesh) {
    if (m.mesh.geometry) m.mesh.geometry.dispose();
    if (m.mesh.material) {
      if (Array.isArray(m.mesh.material)) m.mesh.material.forEach(x => x.dispose());
      else m.mesh.material.dispose();
    }
  }
  st.models.splice(idx, 1);
  if (st.selectedModelId === modelId) {
    st.selectedModelId = null;
    st.selectionOutline = null;
  }
  if (tabViewers.get(activeTabId) === viewer) {
    const lmItem = lmList.querySelector('.lm-item[data-model-id="' + modelId + '"]');
    if (lmItem) lmItem.remove();
    updateLegend();
    updateRenderOrder();
    buildAxisLabels();
    const visibleModels = st.models.filter(mm => mm.inScene);
    const lmEmptyEl = document.getElementById('lm-empty');
    if (visibleModels.length === 0 && lmEmptyEl) lmEmptyEl.style.display = '';
  }
}

// remove the textured planes of a figure from every 3D tab
function removeRegisterPlaneModel(key) {
  const reg = drawingRegisters[key];
  if (!reg || !reg.planeModelId) return;
  const modelId = reg.planeModelId;
  tabViewers.forEach((v) => {
    if (v && v.type === '3d' && v.state) removePlaneFromViewer(v, modelId);
  });
  reg.planeModelId = null;
  reg.planeTabId = null;
}

// )
async function buildRegisterPlaneInScene(reg) {
  if (!reg || !reg.done) {
    window.showTabModal({ title: 'Image is not registered', label: 'Register this image using control points first (Under Maps and Figures, click“Register”button) , Then drag into the 3D view to create an image plane. ' });
    return;
  }
  const owner=state.drawings?.[reg.key]?.regionId;
  if(owner&&window.researchRegionViews)await researchRegionViews.ensure(owner);
  removeRegisterPlaneModel(reg.key);
  // )
  let viewer = tabViewers.get(activeTabId);
  if (!viewer || viewer.type !== '3d') {
    viewer = null;
    for (const v of tabViewers.values()) {
      if (v.type === '3d' && v.state && v.state.origin) { viewer = v; break; }
    }
  }
  if (!viewer || viewer.type !== '3d') {
    for (const v of tabViewers.values()) {
      if (v.type === '3d') { viewer = v; break; }
    }
  }
  if (viewer && viewer.type === '3d') {
    // ,
    let tid = null;
    tabViewers.forEach((v, id) => { if (v === viewer) tid = id; });
    if (tid && tid !== activeTabId && window.switchTab) {
      window.switchTab(tid);
    }
    buildPlaneInto(viewer, reg);
  } else {
    window.showTabModal({ title: 'Open a 3D view first', label: '「' + (reg.fileName || '') + ' ”Registration saved. Open a 3D view and import a model in the same coordinate system as the image, then, Then drag the image from Maps and Figures to create a textured plane. ' });
  }
}

// )
function rebuildPlaneAfterReRegister(reg) {
  const viewer = reg.planeTabId ? tabViewers.get(reg.planeTabId) : null;
  if (!viewer || viewer.type !== '3d' || !viewer.scene) return;
  removePlaneFromViewer(viewer, reg.planeModelId);
  reg.planeModelId = null;
  reg.planeTabId = null;
  buildPlaneInto(viewer, reg);
}

// double-click a figure file to open the image in a new image tab
async function openDrawingInNewTab(fileNode) {
  const id = fileNode.getAttribute('data-drawing-id');
  const d = state.drawings[id];

  // ,
  if (d && d.blobUrl) {
    const imgExts = ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'tif', 'tiff', 'webp', 'svg'];
    if (imgExts.indexOf(d.ext) === -1) {
      window.showTabModal({
        title: 'Preview unavailable',
        label: 'File“ ' + d.fileName + ' ”Not an image format (' + d.ext + ' ) , Preview in a new tab is not supported yet. '
      });
      return;
    }
    if (['tif', 'tiff'].includes(d.ext.toLowerCase()) && !d.previewUrl) {
      try {
        if (!window.electronAPI?.decodeTiffPreview) throw new Error('Restart the desktop application, Enable TIFF Preview');
        if (!d.previewPending) d.previewPending = (async () => {
          const original = d.blob || await (await fetch(d.blobUrl)).blob();
          const result = await electronAPI.decodeTiffPreview(new Uint8Array(await original.arrayBuffer()));
          if (!result.ok) throw new Error(result.error);
          d.previewUrl = URL.createObjectURL(new Blob([result.data], { type: 'image/png' }));
          fileNode.setAttribute('data-drawing-blob', d.previewUrl);
        })();
        await d.previewPending;
      } catch (error) {
        window.showTabModal({ title: 'TIFF Preview unavailable', label: error.message });
        return false;
      } finally { d.previewPending = null; }
    }
    return createNewTab('image', { imageName: d.fileName, imageUrl: d.previewUrl || d.blobUrl });
  }

  // ,
  const spanEl = fileNode.querySelector('span');
  const fileName = spanEl ? spanEl.textContent.trim() : '';
  if (!fileName) return;
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const imgExts = ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'tif', 'tiff', 'webp', 'svg'];
  if (imgExts.indexOf(ext) === -1) {
    window.showTabModal({
      title: 'Preview unavailable',
      label: 'File“ ' + fileName + ' ”Not an image format (' + ext + ' ) , Preview in a new tab is not supported yet. '
    });
    return;
  }
  // ,
  const filePath = fileNode.getAttribute('data-drawing-path') || ('Maps and Figures/ ' + fileName);
  // ,
  return createNewTab('image', { imageName: fileName, imageUrl: filePath });
}

// initial binding
wrapExistingDrawingCategories();
if (subitemsDrawingMgmt) bindDrawingContextMenus(subitemsDrawingMgmt);
// Section 102: the two categories beneath Surface use the same context menu, double click, registration and drag logic as the categories under figure management
if (subitemsSurface) bindDrawingContextMenus(subitemsSurface);

// -- menu: import figure --
document.getElementById('ctx-import-drawing').addEventListener('click', async (e) => {
  e.stopPropagation();
  hideCtxMenu();
  if (pendingDrawingCategory) {
    if (!await guardImportPointDraw('Importing map or figure')) return;
    drawingFileInput.value = '';
    drawingFileInput.click();
  }
});

// -- right-click Import DXF: choose a .dxf file --
const dxfFileInput = document.getElementById('dxf-file-input');
document.getElementById('ctx-import-dxf').addEventListener('click', async (e) => {
  e.stopPropagation();
  hideCtxMenu();
  if (pendingDrawingCategory) {
    if (!await guardImportPointDraw('Importing DXF Maps')) return;
    dxfFileInput.value = '';
    dxfFileInput.click();
  }
});

// -- right-click Import GeoJSON: choose a .geojson or .json file --
const geojsonFileInput = document.getElementById('geojson-file-input');
document.getElementById('ctx-import-geojson').addEventListener('click', async (e) => {
  e.stopPropagation();
  hideCtxMenu();
  if (pendingDrawingCategory) {
    if (!await guardImportPointDraw('Importing GeoJSON Maps')) return;
    geojsonFileInput.value = '';
    geojsonFileInput.click();
  }
});

// project tree node
// 
window.vectorStore = window.vectorStore || {};

async function importVectorFiles(files, kind) {
  // kind: 'dxf' | 'geojson'
  if (!pendingDrawingCategory) {
    console.warn('[Vector import] pendingDrawingCategory is empty: First, in Maps Subcategory right-click Select“Import ' + (kind === 'dxf' ? 'DXF' : 'GeoJSON') + '」');
    return;
  }
  const fileArr = Array.from(files || []);
  if (fileArr.length === 0) return;
  const nested = pendingDrawingCategory.nextElementSibling;
  if (!nested || !nested.classList.contains('lp-nested-items')) {
    alert('The category\'s child container was not found, Unable to add the vector node. \n Right-click a map subcategory (e.g.“Geological Maps”“Cross Sections”) then import. ');
    return;
  }

  for (const file of fileArr) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    try {
      showImportLoading('Reading and parsing:  ' + file.name, 5);
      await yieldToUI();
      const text = await readTextFileSmart(file);
      let entities;
      let layerColors = null;
      if (kind === 'dxf') {
        const r = parseDXFText(text);
        entities = r.entities;
        layerColors = r.layerColors;
      } else {
        entities = parseGeoJSONText(text);
      }
      if (!entities || entities.length === 0) {
        hideImportLoading();
        let statStr = '';
        if (kind === 'dxf') {
          const stats = countDXFEntityTypes(text);
          const entries = Object.entries(stats);
          if (entries.length > 0) {
            statStr = '\n File entity statistics:  ' + entries.map(([k, v]) => k + '×' + v).join('、');
          }
        }
        alert('No displayable vector features were found:  ' + file.name + '\n File size: ' + (file.size / 1024).toFixed(1) + ' KB' + statStr +
          '\n\n Currently supported entity types: LINE / LWPOLYLINE / POLYLINE / CIRCLE / ARC / POINT / TEXT / MTEXT' +
          '\n (SPLINE, HATCH, INSERT blocks, 3DFACE, ELLIPSE are not supported yet, will be skipped) ');
        continue;
      }
      showImportProgress(30, 'Parsing complete, Total ' + entities.length + ' features');
      const hasZ = entitiesHaveZ(entities);
      if (hasZ) {
        // )
        console.log('[Vector import] ' + file.name + ' Detected Z Coordinates → Display in a new 3D tab');
        window.createNewTab('3d', { label: file.name });
      } else {
        // ,
        console.log('[Vector import] ' + file.name + ' None Z Coordinates → Automatically open a 2D vector tab');
        window.createNewTab('vector2d', { label: file.name + '  (Plane) ' });
      }
      await yieldToUI();
      // )
      const model = await loadVectorToScene(entities, file.name, layerColors);
      // project tree node
      const id = 'vector_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const blobUrl = URL.createObjectURL(file);
      window.vectorStore[id] = {
        id: id, fileName: file.name, ext: ext, blob: file, blobUrl: blobUrl,
        displayName: file.name, entities: entities,
        layerColors: layerColors || null,
        modelId: model ? model.id : null
      };
      const fileNode = document.createElement('div');
      fileNode.className = 'lp-sub-item';
      fileNode.setAttribute('data-vector-id', id);
      fileNode.innerHTML =
        '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2"><path d="M4 7v10M4 7a3 3 0 0 1 6 0M4 7a3 3 0 0 0 6 0M10 7v10M10 7a3 3 0 0 1 6 0M10 7a3 3 0 0 0 6 0M16 7v10M16 7a3 3 0 0 1 6 0M16 7a3 3 0 0 0 6 0"></path><path d="M1 17h22"></path></svg>' +
        '<span>' + escapeHtml(file.name) + '</span>';
      nested.appendChild(fileNode);
      bindVectorFileContextMenu(fileNode);
      console.log('[Vector import] Success:  ' + file.name + '（' + (entities ? entities.length : 0) + ' features) Added to the 3D view');
    } catch (err) {
      hideImportLoading();
      alert('Parse ' + (kind === 'dxf' ? 'DXF' : 'GeoJSON') + ' file failed [' + file.name + ']：' + err.message + '\n File size: ' + (file.size / 1024).toFixed(1) + ' KB');
    }
  }
  pendingDrawingCategory = null;
}

dxfFileInput.addEventListener('change', async () => { await importVectorFiles(dxfFileInput.files, 'dxf'); });
geojsonFileInput.addEventListener('change', async () => { await importVectorFiles(geojsonFileInput.files, 'geojson'); });

// )
function bindVectorFileContextMenu(node) {
  if (node._ctxBound) return;
  node._ctxBound = true;
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ctxContext = { type: 'drawing-file', target: node };
    filterCtxMenu('drawing-file');
    showCtxMenu(e.clientX, e.clientY);
  });
  // ,
  node.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openVectorInTab(node);
  });
}

// double-click a vector file node: locate an existing tab, or create a new 2D or 3D tab and load it
function openVectorInTab(fileNode) {
  const vid = fileNode.getAttribute('data-vector-id');
  const v = window.vectorStore[vid];
  if (!v) { alert('Vector data does not exist, Import again'); return; }
  // ,
  const hasZ = entitiesHaveZ(v.entities || []);
  if (hasZ) {
    window.createNewTab('3d', { label: v.fileName });
  } else {
    window.createNewTab('vector2d', { label: v.fileName + '  (Plane) ' });
  }
  loadVectorToScene(v.entities, v.fileName, v.layerColors);
}

// -- file selection: import several files --
drawingFileInput.addEventListener('change', async () => {
  if (!pendingDrawingCategory) {
    console.warn('[Map import] pendingDrawingCategory is empty: First, in Maps Subcategory right-click Select“Import map or figure”');
    return;
  }
  const files = Array.from(drawingFileInput.files || []);
  if (files.length === 0) return;
  const nested = pendingDrawingCategory.nextElementSibling;
  if (!nested || !nested.classList.contains('lp-nested-items')) {
    alert('The category\'s child container was not found, Unable to add the map node. \n Right-click a map subcategory (e.g.“Geological Maps”“Cross Sections”) then import. ');
    return;
  }

  for (const file of files) {
    const id = 'drawing_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const blobUrl = URL.createObjectURL(file);
    state.drawings[id] = {
      id: id,
      fileName: file.name,
      filePath: getFilePath(file),   // )
      ext: ext,
      blob: file,
      blobUrl: blobUrl
    };
    const fileNode = document.createElement('div');
    fileNode.className = 'lp-sub-item';
    fileNode.setAttribute('data-drawing-id', id);
    fileNode.innerHTML =
      '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>' +
        '<polyline points="14 2 14 8 20 8"></polyline>' +
      '</svg><span>' + escapeHtml(file.name) + '</span>';
    nested.appendChild(fileNode);
  }
  // Imported drawings can belong to either surface or drawing management.
  // Bind the actual destination so both use identical preview/register/drag actions.
  bindDrawingContextMenus(nested);
  pendingDrawingCategory = null;
});

// -- rename --
// ,
// )
let pendingRenameDrawingCat = null;    // {node, cur} 图件分类
let pendingRenameDrawingFile = null;   // {node, cur, kind:'vector'|'drawing', vid}

function renameDrawingCategory(catNode) {
  const span = catNode.querySelector('span');
  const cur = span ? span.textContent : '';
  pendingRenameDrawingCat = { node: catNode, cur: cur };
  openRenameInputDialog('drawing-category-rename', 'Rename category', 'Rename category: ', cur);
}

function applyDrawingCategoryRename(obj, newName) {
  if (!obj || !obj.node) return;
  const span = obj.node.querySelector('span');
  if (span) span.textContent = newName;
  // ,
  try { if (typeof refreshHolePanelIfOpen === 'function') refreshHolePanelIfOpen(); } catch (e) {}
}

function renameDrawingFileNode(fileNode) {
  const vid = fileNode.getAttribute('data-vector-id');
  const span = fileNode.querySelector('span');
  if (vid) {
    const v = window.vectorStore[vid];
    if (!v) return;
    const cur = span ? span.textContent : v.fileName;
    pendingRenameDrawingFile = { node: fileNode, cur: cur, kind: 'vector', vid: vid };
    openRenameInputDialog('drawing-file-rename', 'Rename map or figure', 'Rename (The original file content is unchanged) : ', cur);
    return;
  }
  const id = fileNode.getAttribute('data-drawing-id');
  const d = state.drawings[id];
  if (!d) return;
  const cur = span ? span.textContent : d.fileName;
  pendingRenameDrawingFile = { node: fileNode, cur: cur, kind: 'drawing', vid: null };
  openRenameInputDialog('drawing-file-rename', 'Rename map or figure', 'Rename (The original file content is unchanged) : ', cur);
}

function applyDrawingFileRename(obj, newName) {
  if (!obj || !obj.node) return;
  const span = obj.node.querySelector('span');
  if (obj.kind === 'vector') {
    const v = window.vectorStore[obj.vid];
    if (!v) return;
    if (span) span.textContent = newName;
    v.displayName = newName;
    if (v.modelId) {
      const lmName = lmList.querySelector('.lm-item[data-model-id="' + v.modelId + '"] .lm-name');
      if (lmName) lmName.textContent = newName;
    }
    return;
  }
  const id = obj.node.getAttribute('data-drawing-id');
  const d = state.drawings[id];
  if (!d) return;
  if (span) span.textContent = newName;
  d.displayName = newName;
  // ,
  try { if (typeof refreshHolePanelIfOpen === 'function') refreshHolePanelIfOpen(); } catch (e) {}
}

// -- delete --
function deleteDrawingCategory(catNode) {
  const nested = catNode.nextElementSibling;
  const fileNodes = nested
    ? nested.querySelectorAll('.lp-sub-item[data-drawing-id]')
    : [];
  const name = (catNode.querySelector('span') || {}).textContent || 'This category';
  if (fileNodes.length > 0 && !confirm('Confirm deletion“ ' + name + ' ”and its ' + fileNodes.length + ' maps or figures??')) return;
  if (fileNodes.length === 0 && !confirm('Confirm deletion“ ' + name + ' ”??')) return;
  // release the blob URL and remove it from state.drawings
  fileNodes.forEach(fn => {
    const id = fn.getAttribute('data-drawing-id');
    const d = state.drawings[id];
    if (d && d.blobUrl) URL.revokeObjectURL(d.blobUrl);
    delete state.drawings[id];

    // clear the registration state and the textured planes
    const key = getDrawingKey(fn);
    if (drawingRegisters[key]) {
      removeRegisterPlaneModel(key);
      delete drawingRegisters[key];
    }
  });
  catNode.remove();
  if (nested) nested.remove();
}

function deleteDrawingFileNode(fileNode) {
  const vid = fileNode.getAttribute('data-vector-id');
  if (vid) {
    const v = window.vectorStore[vid];
    const name = v ? (v.displayName || v.fileName) : 'This vector';
    if (!confirm('Delete this vector?“ ' + name + ' ”??')) return;
    if (v) {
      if (v.blobUrl) URL.revokeObjectURL(v.blobUrl);
      if (v.modelId) {
        const m = state.models.find(x => x.id === v.modelId);
        if (m) removeModelFromView(m);
      }
      delete window.vectorStore[vid];
    }
    fileNode.remove();
    return;
  }
  const id = fileNode.getAttribute('data-drawing-id');
  const d = state.drawings[id];
  const name = d ? (d.displayName || d.fileName) : 'This map or figure';
  if (!confirm('Delete this map or figure?“ ' + name + ' ”??')) return;
  if (d && d.blobUrl) URL.revokeObjectURL(d.blobUrl);
  delete state.drawings[id];

  // clear the registration state and the textured planes
  const key = getDrawingKey(fileNode);
  if (drawingRegisters[key]) {
    removeRegisterPlaneModel(key);
    delete drawingRegisters[key];
  }
  fileNode.remove();
}

// 
function exportDrawingCategory(catNode) {
  const nested = catNode.nextElementSibling;
  const fileNodes = nested
    ? nested.querySelectorAll('.lp-sub-item[data-drawing-id]')
    : [];
  if (fileNodes.length === 0) {
    alert('This category contains no maps or figures to export');
    return;
  }
  fileNodes.forEach(fn => {
    const id = fn.getAttribute('data-drawing-id');
    const d = state.drawings[id];
    if (!d) return;
    downloadDrawing(d);
  });
}

function exportDrawingFileNode(fileNode) {
  const vid = fileNode.getAttribute('data-vector-id');
  if (vid) {
    const v = window.vectorStore[vid];
    if (v) downloadDrawing(v);
    return;
  }
  const id = fileNode.getAttribute('data-drawing-id');
  const d = state.drawings[id];
  if (!d) return;
  downloadDrawing(d);
}

function downloadDrawing(d) {
  const a = document.createElement('a');
  a.href = d.blobUrl;
  a.download = d.displayName || d.fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ============================================================
// geological map vector import: DXF and GeoJSON parsing plus 3D rendering
// stage 1: lines become polylines, points become small spheres and text becomes labels; areas are first rendered as boundary loops
// ,
// stage 2 will reuse the three point registration to place the vectors in the GOCAD coordinate system
// ============================================================

// )
async function readTextFileSmart(file) {
  const buf = await file.arrayBuffer();
  let utf8 = '';
  try { utf8 = new TextDecoder('utf-8').decode(buf); } catch (e) { utf8 = ''; }
  // ,
  if (utf8.indexOf('\uFFFD') === -1) return utf8;
  // )
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    console.log('[Vector import] Detected non- UTF-8 Encoding, Applied by GBK Decode again');
    return gbk;
  } catch (e2) {
    return utf8;
  }
}

// )
// )
function cleanMtext(raw) {
  if (!raw) return '';
  let s = String(raw);
  // 1) sub and superscripts \S...^...; and \S.../...; take the main content
  s = s.replace(/\\S([^;]*?)(?:\^|\/)([^;]*?);/g, '$1');
  // 2) remove the paired braces {}
  s = s.replace(/[{}]/g, '');
  // 3) line break \P becomes a space
  s = s.replace(/\\P/gi, ' ');
  // 4) non-breaking space \~ becomes a space
  s = s.replace(/\\~/g, ' ');
  // 5) alignment codes \A1; and \An; are removed
  s = s.replace(/\\A\d*;/g, '');
  // )
  s = s.replace(/\\[A-Za-z][^;]*;/g, '');
  // 7) the escape \\ becomes \
  s = s.replace(/\\\\/g, '\\');
  // 8) strip the control characters
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return s.trim();
}

// ---- Extract the layer colour table from the dxf-parser result: {layer name: {colorIndex, color(RGB)}} ----
function extractLayerColors(dxf) {
  const layers = {};
  const lt = dxf && dxf.tables && dxf.tables.layer && dxf.tables.layer.layers;
  if (lt && typeof lt === 'object') {
    Object.keys(lt).forEach(name => {
      const l = lt[name];
      if (l && typeof l.colorIndex === 'number' && typeof l.color === 'number') {
        layers[name] = { colorIndex: l.colorIndex, color: l.color };
      }
    });
  }
  return layers;
}

// ,
function resolveEntityColor(ent, layerColors) {
  if (typeof ent.color === 'number') return ent.color;   // )
  const lc = layerColors ? layerColors[ent.layer] : undefined;
  if (lc && lc.colorIndex > 0 && lc.colorIndex !== 7) return lc.color;  // )
  return 0x000000;                                       // ByBlock / 白(7) / 未知 → 默认黑色
}

// ,
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
}

function aciToHex(aci) {
  const n = Number(aci);
  if (isNaN(n) || n <= 0 || n > 255) return 0x000000;
  if (n >= 1 && n <= 9) {
    return [0xFF0000, 0xFFFF00, 0x00FF00, 0x00FFFF, 0x0000FF, 0xFF00FF, 0xFFFFFF, 0x808080, 0xC0C0C0][n - 1];
  }
  if (n === 10) return 0xFF0000;
  if (n >= 250 && n <= 255) {
    const g = Math.round(255 * (1 - (n - 250) * 0.08));
    return (g << 16) | (g << 8) | g;
  }
  const group = Math.floor((n - 10) / 10) % 6;
  const sub = (n - 10) % 10;
  const hue = [0, 60, 120, 180, 240, 300][group];
  const lightness = Math.max(0.12, 0.85 - sub * 0.065);
  return hslToRgb(hue, 1, lightness);
}

// )
// )
// ,
// vertices
// )
function parseHatchEntities(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = String(text || '').split(/\r?\n/);
  const hatches = [];
  // ,
  let cur = null, path = null, vertex = null, inEnt = false, pendingSection = false;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    const val = lines[i + 1];
    if (code === 0) {
      const t = (val || '').trim();
      if (t === 'SECTION') { pendingSection = true; continue; }
      if (t === 'ENDSEC') { inEnt = false; pendingSection = false; continue; }
      if (inEnt) {
        if (t === 'HATCH') {
          if (cur && cur.paths.length > 0) hatches.push(cur);
          cur = { type: 'HATCH', layer: '0', color: null, trueColor: null, pattern: '', paths: [] };
        } else {
          if (cur && cur.paths.length > 0) hatches.push(cur);
          cur = null;
        }
        path = null; vertex = null;
      }
      continue;
    }
    // ,
    if (code === 2 && pendingSection) {
      pendingSection = false;
      if ((val || '').trim() === 'ENTITIES') inEnt = true;
      continue;
    }
    if (!cur) continue;
    switch (code) {
      case 8: cur.layer = val.trim(); break;
      case 62: cur.color = parseInt(val, 10); break;
      case 420: cur.trueColor = (parseInt(val, 10) & 0xFFFFFF); break;
      case 2: cur.pattern = val.trim(); break;
      case 92: path = { polyline: ((parseInt(val, 10) & 2) === 2), vertexCount: 0, points: [] }; cur.paths.push(path); vertex = null; break;
      case 93: if (path) path.vertexCount = parseInt(val, 10) || 0; break;
      case 10:
        if (path && path.polyline && path.points.length < path.vertexCount) vertex = { x: parseFloat(val) };
        break;
      case 20:
        if (path && path.polyline && vertex) {
          vertex.y = parseFloat(val);
          path.points.push([vertex.x, vertex.y]);
          vertex = null;
        }
        break;
      default: break;
    }
  }
  if (cur && cur.paths.length > 0) hatches.push(cur);
  return hatches
    .map(h => ({ type: 'HATCH', layer: h.layer, color: h.color, trueColor: h.trueColor, pattern: h.pattern,
                 paths: h.paths.filter(p => p.points.length >= 3) }))
    .filter(h => h.paths.length > 0);
}

// ---- dxf-parser output to the internal unified entity structure ----
function dxfToEntities(dxf) {
  const entities = [];
  const ents = (dxf && dxf.entities) || [];
  ents.forEach(e => {
    const layer = e.layer || '0';
    // )
    const entColor = (typeof e.color === 'number' && e.color !== 0xFFFFFF) ? e.color : undefined;
    const push = (obj) => { if (entColor !== undefined) obj.color = entColor; entities.push(obj); };
    switch (e.type) {
      case 'LINE': {
        // two dxf-parser output shapes are supported:
        // 1) some versions give { start: {x, y, z}, end: {x, y, z} };
        // )
        // ,
        // )
        const a = e.start || (e.vertices && e.vertices[0]) || e.vertices;
        const b = e.end || (e.vertices && e.vertices[1]) || (e.vertices && e.vertices[0]);
        if (a && b) {
          push({ type: 'LINE', layer: layer,
                 x: a.x || 0, y: a.y || 0, z: a.z || 0,
                 x2: b.x || 0, y2: b.y || 0, z2: b.z || 0 });
        }
        break;
      }
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const pts = (e.vertices || []).map(v => [v.x, v.y, v.z || 0]);
        if (pts.length >= 2) push({ type: 'POLYLINE', layer: layer, pts: pts, closed: !!e.shape });
        break;
      }
      case 'CIRCLE':
        if (e.center) push({ type: 'CIRCLE', layer: layer, x: e.center.x, y: e.center.y, z: e.center.z || 0, r: e.radius });
        break;
      case 'ARC':
        if (e.center) push({ type: 'ARC', layer: layer, x: e.center.x, y: e.center.y, z: e.center.z || 0, r: e.radius, startAngle: e.startAngle, endAngle: e.endAngle });
        break;
      case 'POINT':
        if (e.position) push({ type: 'POINT', layer: layer, x: e.position.x, y: e.position.y, z: e.position.z || 0 });
        break;
      case 'TEXT':
      case 'MTEXT': {
        // the insertion point: MTEXT uses position and TEXT uses startPoint; when an alignment point is present (endPoint with halign or valign) it is used
        const pos = e.position || e.startPoint || { x: 0, y: 0, z: 0 };
        const useEnd = e.endPoint && ((e.halign || 0) > 0 || (e.valign || 0) > 0);
        const p = useEnd ? e.endPoint : pos;
        push({
          type: e.type, layer: layer,
          x: p.x, y: p.y, z: p.z || 0,
          text: cleanMtext(e.text),
          height: e.textHeight || e.height || 3,
          anchor: e.type === 'MTEXT' ? 'top-left' : 'baseline'
        });
        break;
      }
      case 'SPLINE': {
        const cps = (e.controlPoints || []).map(p => [p.x, p.y, p.z || 0]);
        if (cps.length >= 2) push({ type: 'POLYLINE', layer: layer, pts: cps, closed: false });
        break;
      }
      case 'ELLIPSE': {
        if (!e.center) break;
        const cx = e.center.x, cy = e.center.y, cz = e.center.z || 0;
        const rx = e.majorAxisEndPoint ? Math.sqrt(e.majorAxisEndPoint.x * e.majorAxisEndPoint.x + e.majorAxisEndPoint.y * e.majorAxisEndPoint.y) : 1;
        const ry = e.axisRatio ? rx * e.axisRatio : rx;
        const rot = e.majorAxisEndPoint ? Math.atan2(e.majorAxisEndPoint.y, e.majorAxisEndPoint.x) : 0;
        const pts = [];
        const n = 64;
        for (let i = 0; i <= n; i++) {
          const a = i / n * Math.PI * 2;
          pts.push([cx + Math.cos(rot) * rx * Math.cos(a) - Math.sin(rot) * ry * Math.sin(a),
                    cy + Math.sin(rot) * rx * Math.cos(a) + Math.cos(rot) * ry * Math.sin(a), cz]);
        }
        push({ type: 'POLYLINE', layer: layer, pts: pts, closed: true });
        break;
      }
      case 'INSERT': {
        // references
        if (e.position) push({ type: 'POINT', layer: layer, x: e.position.x, y: e.position.y, z: e.position.z || 0, blockName: e.name });
        break;
      }
      // ,
      default: break;
    }
  });
  return entities;
}

// ,
function parseDXFText(text) {
  if (typeof DxfParser === 'undefined') {
    const entities = parseDXFTextLegacy(text);
    for (const h of parseHatchEntities(text)) entities.push(h);   // ,
    return { entities: entities, layerColors: null };
  }
  try {
    const parser = new DxfParser();
    const dxf = parser.parseSync(text);
    const entities = dxfToEntities(dxf);
    // dxf-parser 1.1.2 does not support HATCH, so the filled entities are extracted and merged with a custom implementation
    for (const h of parseHatchEntities(text)) entities.push(h);
    if (entities && entities.length > 0) {
      return { entities: entities, layerColors: extractLayerColors(dxf) };
    }
    const fallback = parseDXFTextLegacy(text);
    for (const h of parseHatchEntities(text)) fallback.push(h);
    return { entities: fallback, layerColors: null };
  } catch (err) {
    console.warn('[DXF] dxf-parser Parsing failed, Falling back to the built-in parser:', err.message);
    const entities = parseDXFTextLegacy(text);
    for (const h of parseHatchEntities(text)) entities.push(h);
    return { entities: entities, layerColors: null };
  }
}

function parseDXFTextLegacy(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (isNaN(code)) continue;
    pairs.push([code, lines[i + 1]]);
  }
  const entities = [];
  let cur = null;
  let lastPoly = null;
  for (const [code, val] of pairs) {
    if (code === 0) {
      const type = (val || '').trim();
      // vertices
      if (cur && cur.type === 'VERTEX' && lastPoly) {
        lastPoly.pts.push([cur.x || 0, cur.y || 0, cur.z || 0]);
      }
      // vertices
      if (cur && cur.type !== 'VERTEX') entities.push(cur);
      if (type === 'SECTION' || type === 'ENTITIES') { cur = null; continue; }
      if (type === 'ENDSEC' || type === 'SEQEND') { cur = null; lastPoly = null; continue; }
      cur = { type: type, layer: '0', color: 7, pts: [] };
      if (type === 'POLYLINE' || type === 'POLYLINE3D' || type === 'LWPOLYLINE') lastPoly = cur;
      else if (type !== 'VERTEX') lastPoly = null;   // ,
      continue;
    }
    if (!cur) continue;
    switch (code) {
      case 8: cur.layer = val.trim(); break;
      case 62: cur.color = parseInt(val, 10) || 7; break;
      case 10: cur.x = parseFloat(val); cur._px = parseFloat(val); break;
      case 20: cur.y = parseFloat(val); cur._py = parseFloat(val); break;
      case 30: cur.z = parseFloat(val); break;
      case 11: cur.x2 = parseFloat(val); break;
      case 21: cur.y2 = parseFloat(val); break;
      case 31: cur.z2 = parseFloat(val); break;
      case 40:
        if (cur.type === 'TEXT' || cur.type === 'MTEXT') cur.height = parseFloat(val);
        else cur.r = parseFloat(val);
        break;
      case 50: cur.startAngle = parseFloat(val); break;
      case 51: cur.endAngle = parseFloat(val); break;
      case 1: cur.text = val; break;
      case 3: if (cur.type === 'MTEXT') cur.text = (cur.text || '') + val; break;
      case 70: if (cur.type === 'LWPOLYLINE') cur.closed = (parseInt(val, 10) & 1) === 1; break;
    }
    // vertices
    if (cur.type === 'LWPOLYLINE' && code === 20 && cur._px !== undefined) {
      cur.pts.push([cur._px, cur._py, cur.z || 0]);
      cur._px = undefined;
    }
  }
  // end of the loop: finish the last entity
  if (cur && cur.type !== 'VERTEX') entities.push(cur);
  // filter out the entities that have no geometry
  return entities.filter(e => {
    if (e.type === 'LINE') return e.x2 !== undefined;
    if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE' || e.type === 'POLYLINE3D') return (e.pts && e.pts.length >= 2);
    if (e.type === 'CIRCLE' || e.type === 'ARC') return e.r !== undefined;
    if (e.type === 'POINT') return true;
    if (e.type === 'TEXT' || e.type === 'MTEXT') return e.text !== undefined;
    return false;
  });
}

// )
function countDXFEntityTypes(text) {
  const types = {};
  const lines = String(text || '').split(/\r?\n/);
  let inEnt = false;
  for (let i = 0; i < lines.length - 1; i += 2) {
    if (lines[i].trim() === '0') {
      const t = (lines[i + 1] || '').trim();
      if (t === 'ENTITIES') inEnt = true;
      else if (t === 'ENDSEC') inEnt = false;
      else if (inEnt) types[t] = (types[t] || 0) + 1;
    }
  }
  return types;
}

// )
function entitiesHaveZ(entities) {
  return (entities || []).some(e => {
    if (e.pts) return e.pts.some(p => Math.abs(p[2] || 0) > 1e-9);
    if (e.type === 'LINE') return Math.abs(e.z || 0) > 1e-9 || Math.abs(e.z2 || 0) > 1e-9;
    return Math.abs(e.z || 0) > 1e-9;
  });
}

// )
function parseGeoJSONText(text) {
  let gj;
  try { gj = JSON.parse(text); } catch (e) { throw new Error('GeoJSON Parsing failed:  ' + e.message); }
  const features = gj.type === 'FeatureCollection' ? (gj.features || [])
    : (gj.type === 'Feature' ? [gj] : []);
  const entities = [];
  const pushLineString = (coords, layer) => {
    if (!coords || coords.length < 2) return;
    entities.push({ type: 'POLYLINE', pts: coords.map(c => [c[0], c[1], c[2] || 0]), layer: layer || 'GeoJSON', closed: false });
  };
  const pushPolygon = (coords, layer) => {
    (coords || []).forEach(ring => {
      if (!ring || ring.length < 3) return;
      entities.push({ type: 'POLYLINE', pts: ring.map(c => [c[0], c[1], c[2] || 0]), layer: layer || 'GeoJSON', closed: true });
    });
  };
  features.forEach(f => {
    const geom = f.geometry;
    if (!geom) return;
    const props = f.properties || {};
    const layer = String(props.layer || props.name || (f.id !== undefined ? f.id : 'GeoJSON'));
    switch (geom.type) {
      case 'Point':
        entities.push({ type: 'POINT', x: geom.coordinates[0], y: geom.coordinates[1], z: geom.coordinates[2] || 0, layer: layer });
        break;
      case 'MultiPoint':
        (geom.coordinates || []).forEach(c => entities.push({ type: 'POINT', x: c[0], y: c[1], z: c[2] || 0, layer: layer }));
        break;
      case 'LineString': pushLineString(geom.coordinates, layer); break;
      case 'MultiLineString': (geom.coordinates || []).forEach(c => pushLineString(c, layer)); break;
      case 'Polygon': pushPolygon(geom.coordinates, layer); break;
      case 'MultiPolygon': (geom.coordinates || []).forEach(p => pushPolygon(p, layer)); break;
    }
  });
  return entities;
}

// text labels
// ,
async function buildVectorGroupAsync(entities, onProgress, layerColors) {
  const group = new THREE.Group();
  const colorLines = new Map();   // vertices
  const colorPoints = new Map();  // vertices
  const labels = [];              // text labels
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  // drawing coordinates to three coordinates: [x, z (elevation), -y (north negated)]; when there is no z, y = 0 and the drawing is shown as a 2D plane
  const toThree = (px, py, pz) => ({ x: px, y: (pz || 0), z: -py });
  const track = (x, y, z) => {
    if (x < minx) minx = x; if (y < miny) miny = y; if (z < minz) minz = z;
    if (x > maxx) maxx = x; if (y > maxy) maxy = y; if (z > maxz) maxz = z;
  };
  const getLineArr = (hex) => { let a = colorLines.get(hex); if (!a) { a = []; colorLines.set(hex, a); } return a; };
  const getPointArr = (hex) => { let a = colorPoints.get(hex); if (!a) { a = []; colorPoints.set(hex, a); } return a; };
  const pushLine = (hex, x1, y1, z1, x2, y2, z2) => {
    const a = getLineArr(hex);
    a.push(x1, y1, z1, x2, y2, z2);
    track(x1, y1, z1); track(x2, y2, z2);
  };
  const CHUNK = 200;
  for (let i = 0; i < entities.length; i += CHUNK) {
    const slice = entities.slice(i, i + CHUNK);
    slice.forEach(ent => {
      const hex = resolveEntityColor(ent, layerColors);
      const t = ent.type;
      if (t === 'LINE') {
        const a = toThree(ent.x || 0, ent.y || 0, ent.z || 0);
        const b = toThree(ent.x2 || 0, ent.y2 || 0, ent.z2 || 0);
        pushLine(hex, a.x, a.y, a.z, b.x, b.y, b.z);
      } else if (t === 'LWPOLYLINE' || t === 'POLYLINE' || t === 'POLYLINE3D') {
        const pts = ent.pts || [];
        for (let j = 0; j < pts.length - 1; j++) {
          const a = toThree(pts[j][0], pts[j][1], pts[j][2]);
          const b = toThree(pts[j + 1][0], pts[j + 1][1], pts[j + 1][2]);
          pushLine(hex, a.x, a.y, a.z, b.x, b.y, b.z);
        }
        if (ent.closed && pts.length >= 3) {
          const a = toThree(pts[pts.length - 1][0], pts[pts.length - 1][1], pts[pts.length - 1][2]);
          const b = toThree(pts[0][0], pts[0][1], pts[0][2]);
          pushLine(hex, a.x, a.y, a.z, b.x, b.y, b.z);
        }
      } else if (t === 'CIRCLE' || t === 'ARC') {
        const cx = ent.x || 0, cy = ent.y || 0, r = ent.r || 1, cz = ent.z || 0;
        if (t === 'CIRCLE') {
          for (let j = 0; j < 36; j++) {
            const a1 = j / 36 * Math.PI * 2, a2 = (j + 1) / 36 * Math.PI * 2;
            const a = toThree(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, cz);
            const b = toThree(cx + Math.cos(a2) * r, cy + Math.sin(a2) * r, cz);
            pushLine(hex, a.x, a.y, a.z, b.x, b.y, b.z);
          }
        } else {
          let s = (ent.startAngle || 0) * Math.PI / 180, e = (ent.endAngle !== undefined ? ent.endAngle : 360) * Math.PI / 180;
          if (e <= s) e += Math.PI * 2;
          const n = Math.max(8, Math.ceil(Math.abs(e - s) / (Math.PI / 18)));
          for (let j = 0; j < n; j++) {
            const a1 = s + (e - s) * j / n, a2 = s + (e - s) * (j + 1) / n;
            const a = toThree(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, cz);
            const b = toThree(cx + Math.cos(a2) * r, cy + Math.sin(a2) * r, cz);
            pushLine(hex, a.x, a.y, a.z, b.x, b.y, b.z);
          }
        }
      } else if (t === 'POINT') {
        const p = toThree(ent.x || 0, ent.y || 0, ent.z || 0);
        getPointArr(hex).push(p.x, p.y, p.z);
        track(p.x, p.y, p.z);
      } else if (t === 'TEXT' || t === 'MTEXT') {
        const p = toThree(ent.x || 0, ent.y || 0, (ent.z || 0) + 0.5);
        track(p.x, p.y, p.z);
        labels.push({ text: ent.text || '', x: p.x, y: p.y, z: p.z, height: ent.height || 3, hex: hex, anchor: ent.anchor || 'top-left' });
      } else if (t === 'HATCH') {
        // ,
        let fillColor;
        if (typeof ent.trueColor === 'number') fillColor = ent.trueColor;
        else if (typeof ent.color === 'number') fillColor = aciToHex(ent.color);
        else fillColor = resolveEntityColor(ent, layerColors);
        const paths = (ent.paths && ent.paths.length) ? ent.paths
                    : (ent.points && ent.points.length ? [{ points: ent.points, closed: true }] : []);
        paths.forEach(pth => {
          const pts = pth.points || [];
          if (pts.length < 3) return;
          // ,
          // )
          const shape = new THREE.Shape();
          pts.forEach((pt, idx) => {
            if (idx === 0) shape.moveTo(pt[0], pt[1]);
            else shape.lineTo(pt[0], pt[1]);
          });
          shape.closePath();
          const fgeo = new THREE.ShapeGeometry(shape);
          const fmat = new THREE.MeshBasicMaterial({ color: fillColor, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
          const fmesh = new THREE.Mesh(fgeo, fmat);
          fmesh.rotation.x = -Math.PI / 2;
          group.add(fmesh);
          // ,
          for (let j = 0; j < pts.length; j++) {
            const a = toThree(pts[j][0], pts[j][1], 0);
            const b = toThree(pts[(j + 1) % pts.length][0], pts[(j + 1) % pts.length][1], 0);
            pushLine(fillColor, a.x, a.y, a.z, b.x, b.y, b.z);
          }
        });
      }
    });
    if (onProgress) onProgress(i / entities.length);
    await yieldToUI();
  }
  // create the lines by colour
  colorLines.forEach((arr, hex) => {
    if (arr.length >= 6) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const mat = new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 1 });
      group.add(new THREE.LineSegments(geo, mat));
    }
  });
  // create the points by colour
  colorPoints.forEach((arr, hex) => {
    if (arr.length >= 3) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const mat = new THREE.PointsMaterial({ color: hex, size: 1.5 });
      group.add(new THREE.Points(geo, mat));
    }
  });
  // text labels
  labels.forEach(lb => {
    const sp = makeVectorTextSprite(lb.text, lb.x, lb.y, lb.height, lb.z, lb.hex, lb.anchor);
    if (sp) group.add(sp);
  });
  if (group.children.length === 0) return null;
  group.userData.vectorBounds = { minx: minx, miny: miny, minz: minz, maxx: maxx, maxy: maxy, maxz: maxz };
  return group;
}

// text labels
function makeVectorTextSprite(text, x, y, height, z, color, anchor) {
  const str = String(text || '').trim();
  if (!str) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 44px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillStyle = color ? '#' + color.toString(16).padStart(6, '0') : '#24292f';
  // )
  ctx.fillText(str.slice(0, 24), 8, 10);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const scale = Math.max(0.1, height || 3) * 6;
  const boxW = scale * 3, boxH = scale * 0.75;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat);
  // )
  let ox = 0, oy = 0;
  if (anchor === 'center') {
    ox = 0; oy = 0;
  } else if (anchor === 'baseline') {
    // )
    ox = boxW / 2;
    oy = -boxH * 0.33;
  } else {
    ox = boxW / 2;
    oy = -boxH / 2;
  }
  sp.position.set(x + ox, y + oy, (z !== undefined ? z : 0.5));
  sp.scale.set(boxW, boxH, 1);
  return sp;
}

// the layer management
async function loadVectorToScene(entities, fileName, layerColors) {
  showImportLoading('Building 3D model:  ' + fileName, 0);
  const group = await buildVectorGroupAsync(entities, (p) => {
    showImportProgress(p * 100, 'Building 3D model:  ' + fileName);
  }, layerColors);
  if (!group) { alert('No displayable vector features were found'); return null; }
  const modelId = 'vec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  group.name = fileName;
  group.userData.isModel = true;
  group.userData.modelId = modelId;
  scene.add(group);
  // remove the placeholder cube
  if (state.placeholderMesh) {
    scene.remove(state.placeholderMesh);
    if (state.placeholderMesh.geometry) state.placeholderMesh.geometry.dispose();
    if (state.placeholderMesh.material) state.placeholderMesh.material.dispose();
    state.placeholderMesh = null;
    const emptyPh = document.getElementById('empty-placeholder');
    if (emptyPh) emptyPh.classList.add('hidden');
  }
  // the layer management
  const materials = [];
  group.traverse(obj => { if (obj.material) materials.push(obj.material); });
  const b = group.userData.vectorBounds || {};
  const modelObj = {
    id: modelId,
    type: 'vector',
    category: 'Vector Maps',
    fileName: fileName,
    mesh: group,
    materials: materials,
    material: materials[0] || null,
    color: 0x1a56db,
    opacity: 1,
    visible: true,
    inScene: true,
    isVector: true,
    entities: entities,
    geoMesh: {
      boundingBox: [b.minx !== undefined ? b.minx : 0, b.maxx !== undefined ? b.maxx : 0,
                    b.miny !== undefined ? b.miny : 0, b.maxy !== undefined ? b.maxy : 0,
                    b.minz !== undefined ? b.minz : 0, b.maxz !== undefined ? b.maxz : 0],
      vertexCount: 0, triangleCount: 0,
      fileName: fileName
    }
  };
  state.models.push(modelObj);
  addLayerItem(modelObj);
  updateLegend();
  updateRenderOrder();
  fitViewToAll();
  buildAxisLabels();
  hideImportLoading();
  console.log('[Vector import] ' + fileName + '：' + entities.length + ' features, Added to the 3D view');
  return modelObj;
}

// ============================================================
// line import: parse a CSV or TXT point string, build the line geometry and load it into the scene
// )
//   DXF      → parseDXFText()
//   GeoJSON  → parseGeoJSONText()
// CSV or TXT goes to parseLineCsvText(), which this module adds
// the coordinate convention matches buildVectorGroupAsync: toThree(x, y, z) = (x, z, -y)
// ============================================================

// )
function detectLineColumns(header) {
  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase()
    .replace(/[\s_\-（）()\[\]]/g, '');
  const h = header.map(norm);
  const find = (cands) => {
    for (let i = 0; i < h.length; i++) {
      for (const c of cands) { if (h[i] === c) return i; }
    }
    for (let i = 0; i < h.length; i++) {
      for (const c of cands) { if (h[i] && h[i].indexOf(c) >= 0) return i; }
    }
    return -1;
  };
  return {
    x: find(['东坐标', '东距', 'x坐标', 'easting', 'x', 'east']),
    y: find(['北坐标', '北距', 'y坐标', 'northing', 'y', 'north']),
    z: find(['高程', '标高', '海拔', 'z坐标', 'elevation', 'z', 'elev', 'height']),
    group: find(['线号', '线id', '线编号', '线名', '线标识', '分组', '组号', '类别', '名称',
                 'lineid', 'line', 'group', 'groupid', 'name', 'id'])
  };
}

// ,
// without a header, the layout is inferred from the position of x, y, z and the optional group
function parseLineCsvText(text) {
  const rows = parseCsvText(text, null);
  if (!rows || rows.length === 0) return entitiesEmptyLines();
  // decide whether the first row is a header: it is one if it contains non-numeric characters or cannot be parsed as numbers
  const isNum = (v) => v !== '' && v != null && !isNaN(Number(v));
  const first = rows[0];
  const headerish = first.some(v => !isNum(v));

  let cols = null, dataRows = rows;
  if (headerish) {
    cols = detectLineColumns(first);
    dataRows = rows.slice(1);
  }
  // if the header does not yield x or y, fall back to the positional inference
  let xi, yi, zi, gi;
  if (cols && cols.x >= 0 && cols.y >= 0) {
    xi = cols.x; yi = cols.y; zi = cols.z; gi = cols.group;
  } else {
    // positional inference: look at the number of columns
    const width = Math.max.apply(null, dataRows.map(r => r.length).concat([0]));
    if (width >= 4) { xi = 1; yi = 2; zi = 3; gi = 0; }      // group,x,y,z
    else if (width === 3) { xi = 0; yi = 1; zi = 2; gi = -1; } // x,y,z
    else if (width === 2) { xi = 0; yi = 1; zi = -1; gi = -1; } // )
    else return entitiesEmptyLines();
  }

  // ,
  const groups = new Map();
  const order = [];
  dataRows.forEach(r => {
    if (!r || r.length === 0) return;
    const xv = parseFloat(r[xi]);
    const yv = parseFloat(r[yi]);
    if (isNaN(xv) || isNaN(yv)) return;
    const zv = (zi >= 0 && r[zi] !== undefined && r[zi] !== '') ? (parseFloat(r[zi]) || 0) : 0;
    let key = (gi >= 0 && r[gi] !== undefined && r[gi] !== '') ? String(r[gi]).trim() : '__one__';
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push([xv, yv, zv]);
  });

  const entities = [];
  order.forEach(key => {
    const pts = groups.get(key);
    if (!pts || pts.length === 0) return;
    if (pts.length === 1) {
      entities.push({ type: 'POINT', x: pts[0][0], y: pts[0][1], z: pts[0][2], layer: key });
    } else {
      entities.push({ type: 'POLYLINE3D', pts: pts, layer: key, closed: false });
    }
  });
  return entities;
}

function entitiesEmptyLines() { return []; }

// count the line features in the entities
function countLineEntities(entities) {
  let n = 0;
  (entities || []).forEach(e => {
    if (!e) return;
    if (e.type === 'LINE' || e.type === 'POLYLINE' || e.type === 'LWPOLYLINE' || e.type === 'POLYLINE3D'
        || e.type === 'CIRCLE' || e.type === 'ARC') n++;
  });
  return n;
}

// build the dedicated Group for the lines from the entities:
// 
// )
// ,
let lineWidthLevel = 2;   // )

function buildLineGroup(entities, baseColor, layerColors, widthLevel) {
  const group = new THREE.Group();
  const colorLines = new Map();  // vertices
  const colorPoints = new Map();
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  const toThree = (px, py, pz) => ({ x: px, y: (pz || 0), z: -py });
  const track = (x, y, z) => {
    if (x < minx) minx = x; if (y < miny) miny = y; if (z < minz) minz = z;
    if (x > maxx) maxx = x; if (y > maxy) maxy = y; if (z > maxz) maxz = z;
  };
  const getLineArr = (hex) => { let a = colorLines.get(hex); if (!a) { a = []; colorLines.set(hex, a); } return a; };
  const pushLine = (hex, x1, y1, z1, x2, y2, z2) => {
    const a = getLineArr(hex);
    a.push(x1, y1, z1, x2, y2, z2);
    track(x1, y1, z1); track(x2, y2, z2);
  };
  const lvl = Math.max(1, Math.min(3, widthLevel || lineWidthLevel || 1));

  (entities || []).forEach(ent => {
    if (!ent) return;
    let hex = resolveEntityColor(ent, layerColors);
    // ,
    // )
    if (hex === undefined || hex === null) hex = baseColor;
    const t = ent.type;
    if (t === 'LINE') {
      const a = toThree(ent.x || 0, ent.y || 0, ent.z || 0);
      const b = toThree(ent.x2 || 0, ent.y2 || 0, ent.z2 || 0);
      pushLine(hex, a.x, a.y, a.z, b.x, b.y, b.z);
    } else if (t === 'LWPOLYLINE' || t === 'POLYLINE' || t === 'POLYLINE3D') {
      const pts = ent.pts || [];
      for (let j = 0; j < pts.length - 1; j++) {
        const a = toThree(pts[j][0], pts[j][1], pts[j][2]);
        const b = toThree(pts[j + 1][0], pts[j + 1][1], pts[j + 1][2]);
        pushLine(hex, a.x, a.y, a.z, b.x, b.y, b.z);
      }
      if (ent.closed && pts.length >= 3) {
        const a = toThree(pts[pts.length - 1][0], pts[pts.length - 1][1], pts[pts.length - 1][2]);
        const b = toThree(pts[0][0], pts[0][1], pts[0][2]);
        pushLine(hex, a.x, a.y, a.z, b.x, b.y, b.z);
      }
    } else if (t === 'CIRCLE' || t === 'ARC') {
      const cx = ent.x || 0, cy = ent.y || 0, r = ent.r || 1, cz = ent.z || 0;
      if (t === 'CIRCLE') {
        for (let j = 0; j < 48; j++) {
          const a1 = j / 48 * Math.PI * 2, a2 = (j + 1) / 48 * Math.PI * 2;
          const a = toThree(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, cz);
          const b = toThree(cx + Math.cos(a2) * r, cy + Math.sin(a2) * r, cz);
          pushLine(hex, a.x, a.y, a.z, b.x, b.y, b.z);
        }
      } else {
        let s = (ent.startAngle || 0) * Math.PI / 180, e2 = (ent.endAngle !== undefined ? ent.endAngle : 360) * Math.PI / 180;
        if (e2 <= s) e2 += Math.PI * 2;
        const n = Math.max(8, Math.ceil(Math.abs(e2 - s) / (Math.PI / 24)));
        for (let j = 0; j < n; j++) {
          const a1 = s + (e2 - s) * j / n, a2 = s + (e2 - s) * (j + 1) / n;
          const a = toThree(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, cz);
          const b = toThree(cx + Math.cos(a2) * r, cy + Math.sin(a2) * r, cz);
          pushLine(hex, a.x, a.y, a.z, b.x, b.y, b.z);
        }
      }
    } else if (t === 'POINT') {
      const p = toThree(ent.x || 0, ent.y || 0, ent.z || 0);
      if (!colorPoints.has(hex)) colorPoints.set(hex, []);
      colorPoints.get(hex).push(p.x, p.y, p.z);
      track(p.x, p.y, p.z);
    }
  });

  // )
  if (lvl >= 2) {
    colorLines.forEach((arr) => {
      if (arr.length < 6) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0x0b1a14, transparent: true, opacity: lvl >= 3 ? 0.9 : 0.65, depthWrite: false
      });
      group.add(new THREE.LineSegments(geo, mat));
    });
  }
  // 2) the upper layer: the bright main line
  colorLines.forEach((arr, hex) => {
    if (arr.length < 6) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    const mat = new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 1 });
    group.add(new THREE.LineSegments(geo, mat));
  });
  colorPoints.forEach((arr, hex) => {
    if (arr.length < 3) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    const mat = new THREE.PointsMaterial({ color: hex, size: 1.5 });
    group.add(new THREE.Points(geo, mat));
  });
  if (group.children.length === 0) return null;
  group.userData.lineBounds = { minx: minx, miny: miny, minz: minz, maxx: maxx, maxy: maxy, maxz: maxz };
  return group;
}

// ,
function loadLineGroupToScene(lineGroup, fileName, layerId) {
  const layer = state.lineLayers[layerId];
  const modelId = 'line_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  lineGroup.name = fileName;
  lineGroup.userData.isModel = true;
  lineGroup.userData.modelId = modelId;
  scene.add(lineGroup);
  if (state.placeholderMesh) {
    scene.remove(state.placeholderMesh);
    if (state.placeholderMesh.geometry) state.placeholderMesh.geometry.dispose();
    if (state.placeholderMesh.material) state.placeholderMesh.material.dispose();
    state.placeholderMesh = null;
    const emptyPh = document.getElementById('empty-placeholder');
    if (emptyPh) emptyPh.classList.add('hidden');
  }
  const materials = [];
  lineGroup.traverse(obj => { if (obj.material) materials.push(obj.material); });
  const b = lineGroup.userData.lineBounds || {};
  const baseColor = layer ? layer.color : 0x3EE1A3;
  const modelObj = {
    id: modelId,
    type: 'line',
    category: 'Line',
    fileName: fileName,
    mesh: lineGroup,
    materials: materials,
    material: materials[0] || null,
    color: baseColor,
    opacity: 1,
    visible: true,
    inScene: true,
    isLineLayer: true,
    lineLayerId: layerId,
    geoMesh: {
      boundingBox: [b.minx !== undefined ? b.minx : 0, b.maxx !== undefined ? b.maxx : 0,
                    b.miny !== undefined ? b.miny : 0, b.maxy !== undefined ? b.maxy : 0,
                    b.minz !== undefined ? b.minz : 0, b.maxz !== undefined ? b.maxz : 0],
      vertexCount: 0, triangleCount: 0,
      fileName: fileName
    }
  };
  state.models.push(modelObj);
  addLayerItem(modelObj);
  updateLegend();
  updateRenderOrder();
  return modelObj;
}

// )
async function importLineFiles(files, kind) {
  const layer = getActiveLineCategory();
  if (!layer) {
    alert('First right-click on the left“Line”→“New line category”, Then right-click the category to import files. ');
    return;
  }
  const fileArr = Array.from(files || []);
  if (fileArr.length === 0) return;
  let fitOnce = false;

  for (const file of fileArr) {
    try {
      showImportLoading('Reading and parsing:  ' + file.name, 5);
      await yieldToUI();
      const text = await readTextFileSmart(file);
      let entities = null, layerColors = null;
      if (kind === 'dxf') {
        const r = parseDXFText(text);
        entities = r.entities; layerColors = r.layerColors;
      } else if (kind === 'geojson') {
        entities = parseGeoJSONText(text);
      } else {
        entities = parseLineCsvText(text);
      }
      if (!entities || entities.length === 0) {
        hideImportLoading();
        alert('No line features were found in the file:  ' + file.name +
          '\n\nCSV/TXT Supported formats (One point per row) : ' +
          '\n  Line ID,X,Y,Z    (Recommended: With a group column, Connect points with the same line ID) ' +
          '\n  Line ID,X,Y      (2D lines, Automatically place in 0 Elevation) ' +
          '\n  X,Y,Z         (No group column, Connect all points into a single line) ' +
          '\n A header row is optional: Easting/Northing/Elevation or x/y/z + Line ID/Group column');
        continue;
      }
      const lineCnt = countLineEntities(entities);
      showImportProgress(45, 'Parsing complete, Total ' + entities.length + ' features (' + lineCnt + ' lines) ');
      await yieldToUI();

      const importRegion=layer.regionId||window.researchRegions?.ownerOf(layer._node);
      if(window.researchRegionViews)await researchRegionViews.ensure(importRegion);
      layer.regionId=importRegion;
      const group = buildLineGroup(entities, layer.color, layerColors, lineWidthLevel);
      if (!group) { hideImportLoading(); alert('Unable to construct displayable line geometry:  ' + file.name); continue; }
      const modelObj = loadLineGroupToScene(group, file.name, layer.id);
      if(modelObj&&window.researchRegions)modelObj.regionId=layer.regionId||researchRegions.ownerOf(layer._node);

      const fileRec = {
        id: 'lnf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        fileName: file.name,
        entities: entities,
        layerColors: layerColors || null,
        modelId: modelObj ? modelObj.id : null,
        lineCount: lineCnt,
        color: layer.color
      };
      layer.files.push(fileRec);
      attachLineFileNode(layer, fileRec);
      refreshLineCategoryLabel(layer);
      // ,
      expandLineCategory(layer);
      hideImportLoading();
      console.log('[Line import] ' + file.name + '：' + entities.length + ' features / ' + lineCnt + ' lines → Category“' + layer.name + '」');
      fitOnce = true;
    } catch (err) {
      hideImportLoading();
      alert('Unable to parse the line file [ ' + file.name + ']：' + err.message);
    }
  }
  if (fitOnce) { fitViewToAll(); buildAxisLabels(); }
}

// note that the lineDxfInput, lineGeojsonInput, lineCsvInput and headerLine DOM
// )
// ,
// ,

// )
function resetLineLayers() {
  Object.keys(state.lineLayers || {}).forEach(id => {
    const layer = state.lineLayers[id];
    if (layer._node) layer._node.remove();
    if (layer._nested) layer._nested.remove();
  });
  state.lineLayers = {};
  state.lineOrder = [];
  activeLineLayerId = null;
  if (subitemsLine) subitemsLine.innerHTML = '';
}

// serialise and restore
function serializeLineLayers() {
  return (state.lineOrder || []).map(id => {
    const l = state.lineLayers[id];
    if (!l) return null;
    return {
      id: l.id, name: l.name, color: l.color, regionId: l.regionId,
      files: (l.files || []).map(f => ({
        id: f.id, modelId: f.modelId, fileName: f.fileName, color: f.color,
        lineCount: f.lineCount, entities: f.entities, layerColors: f.layerColors
      }))
    };
  }).filter(Boolean);
}

async function restoreLineLayers(list, options) {
  if (!list || !list.length) return;
  for (const rec of list) {
    const id = rec.id || makeLineCategoryId();
    const layer = {
      id: id, name: rec.name || 'Line category', color: rec.color || LINE_PALETTE[0],
      files: [], _node: null, _nested: null
    };
    state.lineLayers[id] = layer;
    state.lineOrder.push(id);
    addLineNode(layer);
    for (const f of (rec.files || [])) {
      let modelId = options && options.skipScene ? f.modelId || null : null;
      if (!(options && options.skipScene) && f.entities && f.entities.length) {
        const g = buildLineGroup(f.entities, layer.color, f.layerColors || null, lineWidthLevel);
        if (g) {
          const mo = loadLineGroupToScene(g, f.fileName, id);
          modelId = mo ? mo.id : null;
        }
      }
      const fileRec = {
        id: f.id || ('lnf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
        fileName: f.fileName, entities: f.entities, layerColors: f.layerColors || null,
        modelId: modelId, lineCount: f.lineCount || 0, color: f.color || layer.color
      };
      layer.files.push(fileRec);
      attachLineFileNode(layer, fileRec);
    }
    refreshLineCategoryLabel(layer);
    await yieldToUI();
  }
}

// ============================================================
// )
// the architecture follows figure management: in-memory storage in state.tables and data-table-id on the DOM nodes
// ============================================================
const tableFileInput = document.getElementById('table-file-input');
const subitemsDrillhole = document.getElementById('subitems-drillhole');
state.tables = state.tables || {};
let pendingTableCategory = null;

// ============================================================
// )
// ============================================================
// ,
function bindDrillholeAreaContextMenus(root) {
  const items = root.querySelectorAll('[data-role="drillhole-area-node"]');
  items.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxContext = { type: 'drillhole-area', target: item };
      filterCtxMenu('drillhole-area');
      showCtxMenu(e.clientX, e.clientY);
    });
  });
}

// )
function buildDrillholeCategoryItem(category) {
  return '' +
    '<div class="lp-sub-item has-children" data-role="table-category" onclick="toggleNode(this)">' +
      '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
      '<span>' + category + '</span>' +
    '</div>' +
    '<div class="lp-nested-items expanded"></div>';
}

// add a mining-area drillhole node and initialise the collar table, the survey, the geological information, the geochemistry and the alteration automatically
function addNewDrillholeAreaNode(areaName) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML =
    '<div class="lp-sub-item has-children" data-role="drillhole-area-node" onclick="toggleNode(this)">' +
      '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
      '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="#8b949e" stroke-width="2"><path d="M12 2v20M5 6l7-4 7 4M5 18l7 4 7-4M5 6v12M19 6v12"></path></svg>' +
      '<span>' + escapeHtml(areaName) + '</span>' +
    '</div>' +
    '<div class="lp-nested-items expanded">' +
      buildDrillholeCategoryItem('Collar Table') +
      buildDrillholeCategoryItem('Downhole Survey') +
      buildDrillholeCategoryItem('Geological Data') +
      buildDrillholeCategoryItem('Geochemical Data') +
      buildDrillholeCategoryItem('Alteration Data') +
    '</div>';
  // insert it at the front of the drillhole group
  subitemsDrillhole.insertBefore(wrapper, subitemsDrillhole.firstChild);
  // bind the context menu of the mining-area drillhole node and the context menu and drag of the five table categories
  bindDrillholeAreaContextMenus(wrapper);
  bindTableContextMenus(wrapper);
}

// )
function deleteDrillholeAreaNode(areaNode) {
  const wrapper = areaNode.parentElement;
  const nested = areaNode.nextElementSibling;
  const fileNodes = nested
    ? nested.querySelectorAll('.lp-sub-item[data-table-id]')
    : [];
  const name = (areaNode.querySelector('span') || {}).textContent || 'This drillhole group';
  if (fileNodes.length > 0 && !confirm('Confirm deletion“ ' + name + ' ”and its ' + fileNodes.length + ' table files??')) return;
  if (fileNodes.length === 0 && !confirm('Confirm deletion“ ' + name + ' ”??')) return;
  fileNodes.forEach(fn => {
    const id = fn.getAttribute('data-table-id');
    delete state.tables[id];
  });
  areaNode.remove();
  if (nested) nested.remove();
  // ,
  if (wrapper && wrapper !== subitemsDrillhole && wrapper.children.length === 0) wrapper.remove();
}

// rename the mining-area drillhole node
// ,
let pendingRenameDrillholeArea = null;   // {node, cur}

function renameDrillholeAreaNode(areaNode) {
  const span = areaNode.querySelector('span');
  if (!span) return;
  const curName = span.textContent;
  pendingRenameDrillholeArea = { node: areaNode, cur: curName };
  openRenameInputDialog('drillhole-area-rename', 'Rename drillhole group', 'Rename drillhole group: ', curName);
}

function applyDrillholeAreaRename(obj, newName) {
  if (!obj || !obj.node) return;
  const span = obj.node.querySelector('span');
  if (span) span.textContent = newName;
}

// bind the default mining-area drillhole node initially
bindDrillholeAreaContextMenus(subitemsDrillhole);

function bindTableContextMenus(root) {
  const catItems = root.querySelectorAll('[data-role="table-category"]');
  catItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    // )
    const catName = (item.querySelector('span') || {}).textContent || '';
    setupNodeDraggable(item, { type: 'table-category', categoryName: catName });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pendingTableCategory = item;
      ctxContext = { type: 'table', target: item };
      filterCtxMenu('table');
      showCtxMenu(e.clientX, e.clientY);
    });
  });

  const fileItems = root.querySelectorAll('.lp-sub-item[data-table-id]');
  fileItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxContext = { type: 'table-file', target: item };
      filterCtxMenu('table-file');
      showCtxMenu(e.clientX, e.clientY);
    });
    // double-click a table file to open the table in a new tab
    item.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTableInNewTab(item);
    });
  });
}

// double-click a table file to open the table in a new table tab
function openTableInNewTab(fileNode) {
  const id = fileNode.getAttribute('data-table-id');
  const t = state.tables[id];
  if (!t) return;

  // ,
  const existing = Array.from(tabViewers.entries()).find(([tid, v]) =>
    v.type === 'table' && v.sourceKey === 'table:' + id
  );
  if (existing) {
    window.switchTab(existing[0]);
    return;
  }

  // )
  renderTableData(t).then(res => {
    if (typeof res === 'string') {
      // medium and small tables: render the whole table in one go
      window.createNewTab('table', {
        sourceKey: 'table:' + id,
      tableName: t.fileName,
        tableHtml: res,
        tableRows: t.rows,
        tableCols: t.cols
      });
      return;
    }
    // ,
    window.createNewTab('table', {
      sourceKey: 'table:' + id,
      tableName: t.fileName,
      tableHtml: res.firstHtml,
      tableRows: t.rows,
      tableCols: t.cols,
      lazyTable: res.lazy
    });
  });
}

// 
// ,
// avoid rendering tens of thousands of DOM rows at once, which would freeze the interface.
const TABLE_LAZY_THRESHOLD = 2000;
const TABLE_LAZY_CHUNK = 1500;
// )
const tableHtmlCache = new Map();

// ignore
function buildTableRowsHtml(data, holeidIdx, startIdx, endIdx) {
  let html = '';
  for (let i = startIdx; i < endIdx; i++) {
    const row = data[i];
    if (!row) continue;
    html += '<tr>';
    if (holeidIdx >= 0) {
      const hid = row[holeidIdx];
      const hidStr = (hid === undefined || hid === null) ? '' : String(hid).trim();
      const checked = (hidStr !== '' && drillholeIgnoreMap[hidStr]) ? ' checked' : '';
      html += '<td style="text-align:center;">' +
        '<input type="checkbox" class="drillhole-ignore-cb" data-ignore-holeid="' + escapeHtml(hidStr) + '"' + checked +
        (hidStr ? ' title="Hide drillhole ' + escapeHtml(hidStr) + '  (Hidden in 3D view) "' : '') +
        '></td>';
    }
    row.forEach(cell => { html += '<td>' + escapeHtml(String(cell)) + '</td>'; });
    html += '</tr>';
  }
  return html;
}

// render the table data as HTML:
// )
// large tables: resolve { firstHtml, lazy }, where firstHtml holds the header and the first chunk;
// ,
// )
function renderTableData(t) {
  // )
  if (t && t.id && tableHtmlCache.has(t.id)) {
    const c = tableHtmlCache.get(t.id);
    return Promise.resolve(c.isLazy ? { firstHtml: c.firstHtml, lazy: c } : c.html);
  }
  return new Promise((resolve) => {
    const data = t.data; // 二维数组
    if (!data || data.length === 0) {
      resolve('<p style="color:#656d76;text-align:center;padding:40px;">Table is empty</p>');
      return;
    }
    let head = '';
    // truncation notice
    if (t.truncated) {
      head += '<div style="padding:8px 16px;background:#fff3cd;border:1px solid #ffeaa7;border-radius:6px;margin-bottom:12px;font-size:13px;color:#856404;">' +
        ' ⚠ The dataset is too large, Showing the first ' + t.rows + ' Rows' + (t.cols < t.originalCols ? ' × ' + t.cols + ' Columns' : '') +
        '  (Original: ' + t.originalRows + ' Rows' + (t.originalCols ? ' × ' + t.originalCols + ' Columns' : '') + '）' +
        '</div>';
    }
    // ignore
    const holeidIdx = findHoleidColumnIndex(data[0]);
    head += '<table><thead><tr>';
    // ignore
    if (holeidIdx >= 0) {
      head += '<th style="text-align:center;width:52px;" title="Select to hide this drillhole in the 3D view">Ignore</th>';
    }
    // the first row is used as the header
    data[0].forEach(cell => {
      head += '<th>' + escapeHtml(String(cell)) + '</th>';
    });
    head += '</tr></thead><tbody>';

    const bodyCount = data.length - 1;

    // 
    if (bodyCount <= TABLE_LAZY_THRESHOLD) {
      const html = head + buildTableRowsHtml(data, holeidIdx, 1, data.length) + '</tbody></table>';
      if (t.id) tableHtmlCache.set(t.id, { isLazy: false, html: html });
      resolve(html);
      return;
    }

    // 
    const cache = {
      isLazy: true,
      firstHtml: head + buildTableRowsHtml(data, holeidIdx, 1, 1 + TABLE_LAZY_CHUNK) + '</tbody></table>',
      chunks: [],        // 首屏之后的各块 <tr> HTML
      finished: false    // 后台是否已生成完所有块
    };
    if (t.id) tableHtmlCache.set(t.id, cache);
    let nextIdx = 1 + TABLE_LAZY_CHUNK;
    (function genChunks() {
      if (nextIdx >= data.length) {
        cache.finished = true;
        tryAutoLoadTableAtBottom(cache); // ,
        return;
      }
      const endIdx = Math.min(data.length, nextIdx + TABLE_LAZY_CHUNK);
      cache.chunks.push(buildTableRowsHtml(data, holeidIdx, nextIdx, endIdx));
      nextIdx = endIdx;
      setTimeout(genChunks, 0);
    })();
    resolve({ firstHtml: cache.firstHtml, lazy: cache });
  });
}

// ============================================================
// 
// the first screen already contains the first chunk; the remaining chunks are inserted one by one as the user scrolls to the bottom, and switching away and back keeps the loaded progress.
// ============================================================
// )
var activeLazyTableViewer = null;

// ignore
function appendChunkRows(tbody, chunkHtml) {
  const tpl = document.createElement('template');
  tpl.innerHTML = chunkHtml;
  tpl.content.querySelectorAll('input[data-ignore-holeid]').forEach(cb => {
    cb.checked = !!drillholeIgnoreMap[cb.dataset.ignoreHoleid];
  });
  tbody.appendChild(tpl.content);
}

// the loading bar at the bottom shows the progress and is removed once everything has loaded
function updateTableLazyStatus(viewer, tvContent) {
  const lt = viewer.lazyTable;
  if (!lt || !tvContent) return;
  const shown = viewer.tableLazyShown || 0;
  let bar = tvContent.querySelector('.table-lazy-bar');
  if (lt.finished && shown >= lt.chunks.length) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'table-lazy-bar';
    tvContent.appendChild(bar);
  }
  const shownRows = Math.min(viewer.tableRows || 0, 1 + TABLE_LAZY_CHUNK + shown * TABLE_LAZY_CHUNK);
  bar.textContent = (shown < lt.chunks.length)
    ? 'Loaded approximately ' + shownRows + ' Rows, Scroll to the bottom to load more…'
    : 'Parsing remaining data…';
}

// ,
function loadMoreTableRows(viewer, tvContent) {
  const lt = viewer.lazyTable;
  if (!lt || !tvContent) return;
  const tbody = tvContent.querySelector('table tbody');
  if (!tbody) return;
  let shown = viewer.tableLazyShown || 0;
  let guard = 0;
  while (guard++ < 5 && shown < lt.chunks.length) {
    appendChunkRows(tbody, lt.chunks[shown]);
    shown++;
    // ,
    if (tvContent.scrollTop + tvContent.clientHeight < tvContent.scrollHeight - 160) break;
  }
  viewer.tableLazyShown = shown;
  updateTableLazyStatus(viewer, tvContent);
}

// ,
function tryAutoLoadTableAtBottom(cache) {
  const v = activeLazyTableViewer;
  if (!v || !v.lazyTable || v.lazyTable !== cache) return;
  const tvContent = document.getElementById('table-viewer-content');
  if (!tvContent) return;
  if (tvContent.scrollTop + tvContent.clientHeight >= tvContent.scrollHeight - 160) {
    loadMoreTableRows(v, tvContent);
  }
}

// called when a table tab comes to the foreground: restore the chunks that were loaded and show the status bar
function renderTableLazyPart(viewer, tvContent) {
  const lt = viewer.lazyTable;
  if (!lt || !tvContent) return;
  const tbody = tvContent.querySelector('table tbody');
  const shown = viewer.tableLazyShown || 0;
  if (tbody) {
    const n = Math.min(shown, lt.chunks.length);
    for (let k = 0; k < n; k++) appendChunkRows(tbody, lt.chunks[k]);
  }
  updateTableLazyStatus(viewer, tvContent);
}

// ,
function onTableLazyScroll() {
  const v = activeLazyTableViewer;
  if (!v || v.type !== 'table' || !v.lazyTable) return;
  const tvContent = document.getElementById('table-viewer-content');
  if (!tvContent) return;
  if (tvContent.scrollTop + tvContent.clientHeight >= tvContent.scrollHeight - 160) {
    loadMoreTableRows(v, tvContent);
  }
}

// ============================================================
// ignore
// ignore
// ============================================================
const drillholeIgnoreMap = {};

// ,
function findHoleidColumnIndex(headers) {
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i]).replace(/[\s_\-()（）·:：]/g, '').toLowerCase();
    if (h === 'holeid' || h === 'hole' || h === '孔号' || h === '钻孔号' || h === '钻孔编号' || h === '钻孔孔号') return i;
  }
  return -1;
}

// ticking or unticking the ignore checkbox updates the ignore set and refreshes the drillhole visibility on every 3D tab
function toggleIgnoreDrillhole(hid, checked) {
  const key = (hid === undefined || hid === null) ? '' : String(hid).trim();
  if (key === '') return;
  if (checked) drillholeIgnoreMap[key] = true;
  else delete drillholeIgnoreMap[key];
  applyIgnoredDrillholes();
}

// ignore
function applyIgnoredDrillholes() {
  tabViewers.forEach(viewer => {
    if (!viewer.scene) return;
    viewer.scene.traverse(obj => {
      if (obj.userData && obj.userData.holeid !== undefined && obj.userData.holeid !== null) {
        obj.visible = !drillholeIgnoreMap[String(obj.userData.holeid)];
      }
    });
  });
}

// ignore
function syncTableIgnoreCheckboxes(container) {
  if (!container) return;
  container.querySelectorAll('input[data-ignore-holeid]').forEach(cb => {
    cb.checked = !!drillholeIgnoreMap[cb.dataset.ignoreHoleid];
  });
}

// )
function parseCsvText(text, delimiter) {
  if (!delimiter) {
    // ,
    const firstLine = text.split(/\r?\n/)[0] || '';
    if (firstLine.indexOf('\t') >= 0) delimiter = '\t';
    else if (firstLine.indexOf(';') >= 0) delimiter = ';';
    else delimiter = ',';
  }
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delimiter) { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else field += ch;
    }
  }
  // the last field
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// initial binding
if (subitemsDrillhole) bindTableContextMenus(subitemsDrillhole);

// ignore
(function initTableIgnoreCheckboxes() {
  const tvContentEl = document.getElementById('table-viewer-content');
  if (!tvContentEl) return;
  tvContentEl.addEventListener('change', (e) => {
    const cb = (e.target && e.target.closest) ? e.target.closest('input[data-ignore-holeid]') : null;
    if (!cb) return;
    toggleIgnoreDrillhole(cb.dataset.ignoreHoleid, cb.checked);
  });
})();

// ,
function initTableLazyScroll() {
  const tvContentEl = document.getElementById('table-viewer-content');
  if (!tvContentEl || tvContentEl._lazyScrollBound) return;
  tvContentEl._lazyScrollBound = true;
  tvContentEl.addEventListener('scroll', onTableLazyScroll, { passive: true });
}
initTableLazyScroll();

// -- menu: import table --
document.getElementById('ctx-import-table').addEventListener('click', async (e) => {
  e.stopPropagation();
  hideCtxMenu();
  if (pendingTableCategory) {
    if (!await guardImportPointDraw('Importing table')) return;
    tableFileInput.value = '';
    tableFileInput.click();
  }
});

// -- file selection: import several tables --
const MAX_TABLE_FILE_SIZE = 100 * 1024 * 1024;  // 100MB 文件大小上限
const MAX_TABLE_ROWS = 50000;                     // )
const MAX_TABLE_COLS = 200;                       // 200列渲染上限

// )
const EXCEL_EXTS = ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'dbf'];
// )
const TEXT_EXTS = ['csv', 'txt', 'tsv'];

// )
function showImportLoading(text, pct) {
  const overlay = document.getElementById('import-loading-overlay');
  const textEl = document.getElementById('import-loading-text');
  if (textEl) textEl.textContent = text || 'Importing, Please wait...';
  const track = document.getElementById('import-progress-track');
  const fill = document.getElementById('import-progress-fill');
  if (pct !== undefined && pct !== null) {
    if (track) track.style.display = '';
    if (fill) fill.style.width = Math.max(0, Math.min(100, Math.round(pct))) + '%';
  }
  if (overlay) overlay.classList.add('show');
}
// )
function showImportProgress(pct, text) {
  showImportLoading(text, pct);
}
function hideImportLoading() {
  const overlay = document.getElementById('import-loading-overlay');
  if (overlay) overlay.classList.remove('show');
  const track = document.getElementById('import-progress-track');
  if (track) track.style.display = 'none';
  const fill = document.getElementById('import-progress-fill');
  if (fill) fill.style.width = '0%';
}
// ,
function yieldToUI() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ,
function checkXlsxAvailable() {
  if (typeof XLSX !== 'undefined' && !window.__xlsxFailed) return true;
  if (window.__xlsxLoading) return false; // ,
  if (window.__xlsxFailed) return false;  // 已确认加载失败
  // )
  window.__xlsxLoading = true;
  const s = document.createElement('script');
  s.src = 'xlsx.full.min.js?v=20260909';
  s.async = true;
  s.onload = () => { window.__xlsxLoading = false; window.__xlsxFailed = false; };
  s.onerror = () => { window.__xlsxLoading = false; window.__xlsxFailed = true; };
  document.head.appendChild(s);
  return false;
}

tableFileInput.addEventListener('change', async () => {
  if (!pendingTableCategory) return;
  const files = Array.from(tableFileInput.files || []);
  if (files.length === 0) return;
  const nested = pendingTableCategory.nextElementSibling;
  if (!nested || !nested.classList.contains('lp-nested-items')) return;

  showImportLoading('Importing ' + files.length + ' files...');

  let successCount = 0;
  let failCount = 0;

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    const ext = (file.name.split('.').pop() || '').toLowerCase();

    // update the loading notice
    showImportLoading('Parsing“ ' + file.name + '」(' + (fi + 1) + '/' + files.length + ')...');

    // give the UI a chance to refresh
    await new Promise(r => setTimeout(r, 20));

    // 1. check whether the extension is supported
    if (EXCEL_EXTS.indexOf(ext) === -1 && TEXT_EXTS.indexOf(ext) === -1) {
      hideImportLoading();
      showTableError('File“ ' + file.name + ' ”format (.' + ext + ' ) is not supported. \n Supported formats: CSV / TXT / TSV / XLSX / XLS / XLSM / XLSB / ODS / DBF');
      failCount++;
      continue;
    }

    // 2. check the file size
    if (file.size > MAX_TABLE_FILE_SIZE) {
      hideImportLoading();
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      showTableError('File“ ' + file.name + ' ”size: ' + sizeMB + ' MB, exceeds 100 MB limit. \n Reduce the file size and try again. ');
      failCount++;
      continue;
    }

    // 3. check for an empty file
    if (file.size === 0) {
      hideImportLoading();
      showTableError('File“ ' + file.name + ' ”is an empty file. ');
      failCount++;
      continue;
    }

    let data = null;
    try {
      if (EXCEL_EXTS.indexOf(ext) !== -1) {
        // Excel files need SheetJS
        await ensureDocumentLibrary('excel');
        if (!checkXlsxAvailable()) {
          hideImportLoading();
          showTableError('File“ ' + file.name + ' ”is Excel Format, but the spreadsheet parser (SheetJS) Loading failed. \n A network problem may have occurred, Refresh the page and try again, or save the file as CSV format before importing. ');
          failCount++;
          // )
          showImportLoading('Importing...');
          continue;
        }
        const buf = await file.arrayBuffer();
  await ensureDocumentLibrary('excel');
        const wb = await XLSX.read(buf, { type: 'array', cellDates: true });
        if (!wb.SheetNames || wb.SheetNames.length === 0) {
          throw new Error('No worksheets were found in the file');
        }
        const ws = wb.Sheets[wb.SheetNames[0]];
        if (!ws) throw new Error('The first worksheet is empty');
        data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
      } else {
        // ,
        const buf = await file.arrayBuffer();
        // ,
        let text;
        if (buf.byteLength >= 3) {
          const bom = new Uint8Array(buf, 0, 3);
          if (bom[0] === 0xEF && bom[1] === 0xBB && bom[2] === 0xBF) {
            // UTF-8 BOM
            text = new TextDecoder('utf-8').decode(new Uint8Array(buf, 3));
          } else if (bom[0] === 0xFF && bom[1] === 0xFE) {
            // UTF-16 LE BOM
            text = new TextDecoder('utf-16le').decode(new Uint8Array(buf, 2));
          } else if (bom[0] === 0xFE && bom[1] === 0xFF) {
            // UTF-16 BE BOM
            text = new TextDecoder('utf-16be').decode(new Uint8Array(buf, 2));
          } else {
            // UTF-8 by default
            text = new TextDecoder('utf-8').decode(buf);
          }
        } else {
          text = new TextDecoder('utf-8').decode(buf);
        }
        data = parseCsvText(text);
      }
    } catch (err) {
      hideImportLoading();
      showTableError('File“ ' + file.name + ' ”Parsing failed: \n' + (err.message || err) + '\n\n Check that the file is intact and uses the expected format. ');
      failCount++;
      showImportLoading('Importing...');
      continue;
    }

    // 4. check the parse result
    if (!data || data.length === 0) {
      hideImportLoading();
      showTableError('File“ ' + file.name + ' ”The content is empty or incorrectly formatted. ');
      failCount++;
      showImportLoading('Importing...');
      continue;
    }

    // )
    let truncated = false;
    let originalRows = data.length;
    let originalCols = data[0] ? data[0].length : 0;
    if (data.length > MAX_TABLE_ROWS) {
      data = data.slice(0, MAX_TABLE_ROWS);
      truncated = true;
    }
    // truncate the column count
    if (data[0] && data[0].length > MAX_TABLE_COLS) {
      data = data.map(row => row.slice(0, MAX_TABLE_COLS));
      truncated = true;
    }

    const id = 'table_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    state.tables[id] = {
      id: id,
      fileName: file.name,
      filePath: getFilePath(file),   // )
      ext: ext,
      data: data,
      rows: data.length,
      cols: data[0] ? data[0].length : 0,
      truncated: truncated,
      originalRows: originalRows,
      originalCols: originalCols
    };

    // determine the current category name
    const curCatName = ((pendingTableCategory && pendingTableCategory.querySelector('span'))
      ? pendingTableCategory.querySelector('span').textContent
      : '') || '';

    // -- geochemical information: recognise the numeric attribute columns automatically and split them into subcategories such as Au, Ag and S --
    if (curCatName.search(/地球化学|Geochem/i) >= 0) {
      const headers = data[0] || [];
      const fixedCols = ['holeid', 'from', 'to'];
      // ,
      for (let c = 0; c < headers.length; c++) {
        const hname = String(headers[c] || '').trim();
        const hlower = hname.toLowerCase();
        if (fixedCols.indexOf(hlower) >= 0) continue;
        // scan the columns to see whether they are numeric
        let hasNum = false;
        for (let r = 1; r < data.length; r++) {
          const v = data[r][c];
          if (v === '' || v === null || v === undefined) continue;
          const num = Number(String(v).replace(/[,，]/g, ''));
          if (!isNaN(num) && isFinite(num)) { hasNum = true; break; }
        }
        if (!hasNum) continue;

        // build the subtable data with only holeid, from, to and the current attribute column
        const subData = [];
        // find the column indices of holeid, from and to
        let hi = -1, fi = -1, ti = -1;
        for (let cc = 0; cc < headers.length; cc++) {
          const hh = String(headers[cc] || '').trim().toLowerCase();
          if (hh === 'holeid' || hh === 'hole_id' || hh === '钻孔号') hi = cc;
          else if (hh === 'from' || hh === '起始深度' || hh === '自' || hh === '起') fi = cc;
          else if (hh === 'to' || hh === '结束深度' || hh === '止' || hh === '至') ti = cc;
        }
        const subHeaders = [];
        if (hi >= 0) subHeaders.push(headers[hi]);
        if (fi >= 0) subHeaders.push(headers[fi]);
        if (ti >= 0) subHeaders.push(headers[ti]);
        subHeaders.push(hname);
        subData.push(subHeaders);
        for (let r = 1; r < data.length; r++) {
          const row = [];
          if (hi >= 0) row.push(data[r][hi]);
          if (fi >= 0) row.push(data[r][fi]);
          if (ti >= 0) row.push(data[r][ti]);
          row.push(data[r][c]);
          subData.push(row);
        }

        // )
        const attrClean = hname.replace(/[^\w\u4e00-\u9fa5]/g, '') || 'attr_' + c;
        // register it in state.tables
        const subId = 'geochem_' + attrClean + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 4);
        state.tables[subId] = {
          id: subId,
          fileName: hname + '（' + file.name + '）',
          ext: ext,
          data: subData,
          rows: subData.length,
          cols: subData[0] ? subData[0].length : 0,
          truncated: truncated,
          originalRows: subData.length,
          originalCols: subData[0] ? subData[0].length : 0,
          isGeochemAttr: true,
          geochemAttrName: hname,          // )
          geochemAttrClean: attrClean,      // )
          geochemSourceTableId: id
        };

        // create the attribute subcategory node beneath the geochemical information category
        // ,
        const subCatKey = 'geochem-attr-' + attrClean;
        let subCatContainer = nested.querySelector('[data-geochem-subcat="' + subCatKey + '"]');
        let attrNested;
        if (!subCatContainer) {
          const subCat = document.createElement('div');
          subCat.className = 'lp-sub-item has-children';
          subCat.setAttribute('data-role', 'geochem-attr-category');
          subCat.setAttribute('data-geochem-subcat', subCatKey);
          subCat.setAttribute('onclick', 'toggleNode(this)');
          subCat.innerHTML =
            '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
            '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="#8b949e" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>' +
            '<span>' + escapeHtml(hname) + '</span>';
          nested.appendChild(subCat);
          attrNested = document.createElement('div');
          attrNested.className = 'lp-nested-items expanded';
          nested.appendChild(attrNested);
          // )
          setupNodeDraggable(subCat, { type: 'geochem-attr', attrName: attrClean, attrRawName: hname });
        } else {
          attrNested = subCatContainer.nextElementSibling;
        }

        // attach the file node beneath the attribute subcategory
        const subFileNode = document.createElement('div');
        subFileNode.className = 'lp-sub-item';
        subFileNode.setAttribute('data-table-id', subId);
        subFileNode.innerHTML =
          '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<rect x="3" y="3" width="18" height="18" rx="2"></rect>' +
            '<line x1="3" y1="9" x2="21" y2="9"></line>' +
            '<line x1="9" y1="21" x2="9" y2="9"></line>' +
          '</svg><span>' + escapeHtml(hname + '（' + file.name + '）') + '</span>';
        if (attrNested) attrNested.appendChild(subFileNode);
      }
      successCount++;
    } else {
      // ordinary category: attach the file node directly
      const fileNode = document.createElement('div');
      fileNode.className = 'lp-sub-item';
      fileNode.setAttribute('data-table-id', id);
      if (window.researchScopeTrees) fileNode.dataset.regionId = researchScopeTrees.fileScope(file) || researchRegions.ownerOf(nested);
      fileNode.innerHTML =
        '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
          '<rect x="3" y="3" width="18" height="18" rx="2"></rect>' +
          '<line x1="3" y1="9" x2="21" y2="9"></line>' +
          '<line x1="9" y1="21" x2="9" y2="9"></line>' +
        '</svg><span>' + escapeHtml(file.name) + '</span>';
      nested.appendChild(fileNode);
      successCount++;
    }

    // give the UI a chance to refresh
    await new Promise(r => setTimeout(r, 10));
  }

  bindTableContextMenus(subitemsDrillhole);
  pendingTableCategory = null;
  hideImportLoading();

  // summary notice
  if (successCount > 0 && failCount > 0) {
    showTableError('Import complete: Success ' + successCount + ' items, Failed ' + failCount + ' items. ');
  } else if (failCount > 0 && successCount === 0) {
    // ,
  }
});

// )
function showTableError(msg) {
  window.showTabModal({
    title: 'Import information',
    label: msg
  });
}

// ============================================================
// )
// the architecture follows table management: in-memory storage in state.pdfs and data-pdf-id on the DOM nodes
// ============================================================
const pdfFileInput = document.getElementById('pdf-file-input');
const subitemsReport = document.getElementById('subitems-report');
state.pdfs = state.pdfs || {};
let pdfCounter = 0;
let reportFolderCounter = 0;      // 文件夹 id 计数器
let pendingReportFolder = null;   // )

// right-click the report management group header for the Import PDF menu
const headerReport = document.getElementById('header-report');
if (headerReport) {
  headerReport.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    pendingReportFolder = null;   // 分组头右键 → 导入到根目录
    ctxContext = { type: 'report', target: headerReport };
    filterCtxMenu('report');
    showCtxMenu(e.clientX, e.clientY);
  });
}

// -- menu: import PDF --
const ctxImportPdf = document.getElementById('ctx-import-pdf');
if (ctxImportPdf) {
  ctxImportPdf.addEventListener('click', async (e) => {
    e.stopPropagation();
    hideCtxMenu();
    if (pdfFileInput) {
      if (!await guardImportPointDraw('Importing PDF')) return;
      pdfFileInput.value = '';
      pdfFileInput.click();
    }
  });
}

// 
let pendingRenameFolder = null;   // modal 重命名文件夹的目标 {node, cur}
let pendingRenamePdf = null;      // modal 重命名 PDF 的目标 {node, cur}

// ,
function openReportFolderDialog(purpose, title, label, defVal) {
  modalPurpose = purpose;
  modalTitle.textContent = title;
  modalLabel.textContent = label;
  modalInput.value = defVal;
  modalCoordsysRow.style.display = 'none';   // ,
  modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => modalInput.focus(), 50);
}

const ctxNewReportFolder = document.getElementById('ctx-new-report-folder');
if (ctxNewReportFolder) {
  ctxNewReportFolder.addEventListener('click', (e) => {
    e.stopPropagation();
    hideCtxMenu();
    openReportFolderDialog('report-folder-new', 'New folder', 'New folder name: ', 'New folder');
  });
}

// folder node
function buildReportFolderNode(name) {
  reportFolderCounter++;
  const folderId = 'rfolder-' + reportFolderCounter;
  return '' +
    '<div class="lp-sub-item has-children" data-role="report-folder" data-folder-id="' + folderId + '">' +
      '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
      '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="#e85d75" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>' +
      '<span>' + escapeHtml(name) + '</span>' +
    '</div>' +
    '<div class="lp-nested-items expanded"></div>';
}

// )
function addReportFolderNode(name) {
  if (!subitemsReport) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = buildReportFolderNode(name);
  while (tmp.firstChild) subitemsReport.appendChild(tmp.firstChild);
  bindReportContextMenus(subitemsReport);
}

// rename a report management folder
function renameReportFolderNode(folderNode) {
  const span = folderNode.querySelector('span');
  if (!span) return;
  pendingRenameFolder = { node: folderNode, cur: span.textContent };
  openReportFolderDialog('report-folder-rename', 'Rename folder', 'Rename folder: ', span.textContent);
}

// rename the folder once the modal is confirmed
function applyFolderRename(obj, newName) {
  if (!obj || !obj.node) return;
  const span = obj.node.querySelector('span');
  if (span) span.textContent = newName;
}

// ,
function deleteReportFolderNode(folderNode) {
  const nested = folderNode.nextElementSibling;
  const fileNodes = nested
    ? nested.querySelectorAll('.lp-sub-item[data-pdf-id], .lp-sub-item[data-word-id]')
    : [];
  const name = (folderNode.querySelector('span') || {}).textContent || 'This folder';
  if (fileNodes.length > 0 && !confirm('Delete this folder?“ ' + name + ' ”and its ' + fileNodes.length + ' items PDF/Word ??')) return;
  if (fileNodes.length === 0 && !confirm('Delete this folder?“ ' + name + ' ”??')) return;
  fileNodes.forEach(fn => {
    const pid = fn.getAttribute('data-pdf-id');
    const wid = fn.getAttribute('data-word-id');
    if (pid) {
      const p = state.pdfs[pid];
      if (p && p.fileName) {
        // close the reading tab that has this PDF open
        Array.from(tabViewers.entries()).forEach(([tid, v]) => {
          if (v.type === 'pdf' && v.pdfUrl === p.url) closeTab(tid);
        });
        if (p.url) { try { URL.revokeObjectURL(p.url); } catch (err) {} }
      }
      delete state.pdfs[pid];
    } else if (wid) {
      const w = state.words[wid];
      if (w && w.fileName) {
        // close the reading tab that has this Word document open
        Array.from(tabViewers.entries()).forEach(([tid, v]) => {
          if (v.type === 'word' && v.wordUrl === w.url) closeTab(tid);
        });
        if (w.url) { try { URL.revokeObjectURL(w.url); } catch (err) {} }
      }
      delete state.words[wid];
    }
  });
  folderNode.remove();
  if (nested) nested.remove();
}

// bind the context menu of the folders and PDF nodes inside report management
function bindReportContextMenus(root) {
  if (!root) return;
  // folder node
  const folderItems = root.querySelectorAll('[data-role="report-folder"]');
  folderItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    // ,
    item.addEventListener('click', (e) => {
      if (e.defaultPrevented) return;
      toggleNode(item);
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pendingReportFolder = item;
      ctxContext = { type: 'report-folder', target: item };
      filterCtxMenu('report-folder');
      showCtxMenu(e.clientX, e.clientY);
    });
  });
  // PDF file node
  const pdfItems = root.querySelectorAll('.lp-sub-item[data-pdf-id]');
  pdfItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    item.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPdfInNewTab(item);
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxContext = { type: 'pdf-file', target: item };
      filterCtxMenu('pdf-file');
      showCtxMenu(e.clientX, e.clientY);
    });
  });
  // Word file node
  const wordItems = root.querySelectorAll('.lp-sub-item[data-word-id]');
  wordItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    item.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openWordInNewTab(item);
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxContext = { type: 'word-file', target: item };
      filterCtxMenu('word-file');
      showCtxMenu(e.clientX, e.clientY);
    });
  });
}
bindReportContextMenus(subitemsReport);

// -- menu: open PDF --
const ctxOpenPdf = document.getElementById('ctx-open-pdf');
if (ctxOpenPdf) {
  ctxOpenPdf.addEventListener('click', (e) => {
    e.stopPropagation();
    const { type, target } = ctxContext;
    hideCtxMenu();
    if (type === 'pdf-file' && target) openPdfInNewTab(target);
  });
}

// PDF file node
function openPdfInNewTab(fileNode) {
  const id = fileNode.getAttribute('data-pdf-id');
  const p = state.pdfs[id];
  if (!p) return;
  const existing = Array.from(tabViewers.entries()).find(([tid, v]) =>
    v.type === 'pdf' && v.pdfUrl === p.url
  );
  if (existing) {
    window.switchTab(existing[0]);
    return;
  }
  window.createNewTab('pdf', {
    pdfUrl: p.url,
    pdfName: p.fileName,
    pdfSize: p.size
  });
}

// PDF file node
function addPdfFileNode(file, url, folderNode) {
  if (!subitemsReport) return null;
  const id = 'pdf-' + (++pdfCounter);
  const folderId = folderNode ? folderNode.getAttribute('data-folder-id') : null;
  state.pdfs[id] = { fileName: file.name, url: url, size: file.size, folder: folderId, filePath: getFilePath(file) };
  const node = document.createElement('div');
  node.className = 'lp-sub-item';
  node.setAttribute('data-pdf-id', id);
  node.innerHTML =
    '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>' +
      '<polyline points="14 2 14 8 20 8"></polyline>' +
      '<path d="M9 15h6M9 18h4"></path>' +
    '</svg><span>' + escapeHtml(file.name) + '</span>';
  // )
  let target = subitemsReport;
  if (folderNode) {
    const nested = folderNode.nextElementSibling;
    if (nested && nested.classList.contains('lp-nested-items')) target = nested;
  }
  target.appendChild(node);
  bindReportContextMenus(subitemsReport);
  return node;
}

// 
function renamePdfFileNode(fileNode) {
  const id = fileNode.getAttribute('data-pdf-id');
  const p = state.pdfs[id];
  if (!p) return;
  const span = fileNode.querySelector('span');
  const cur = span ? span.textContent : p.fileName;
  pendingRenamePdf = { node: fileNode, cur: cur };
  openReportFolderDialog('pdf-file-rename', 'Rename PDF', 'Rename PDF (The original file content is unchanged) : ', cur);
}

// )
function applyPdfRename(obj, newName) {
  if (!obj || !obj.node) return;
  const fileNode = obj.node;
  const id = fileNode.getAttribute('data-pdf-id');
  const p = state.pdfs[id];
  if (!p) return;
  const span = fileNode.querySelector('span');
  if (span) span.textContent = newName;
  p.fileName = newName;
  // update the title of the reading tab that is already open
  Array.from(tabViewers.entries()).forEach(([tid, v]) => {
    if (v.type === 'pdf' && v.pdfName === obj.cur) {
      v.pdfName = newName;
      const tabEl = document.querySelector('.center-tab[data-tab-id="' + tid + '"]');
      if (tabEl) {
        const lbl = tabEl.querySelector('.center-tab-label');
        if (lbl) lbl.textContent = newName;
        tabEl.title = newName;
      }
      if (activeTabId === tid) {
        const pvTitle = document.getElementById('pv-title');
        if (pvTitle) pvTitle.textContent = newName;
      }
    }
  });
}

// 
function exportPdfFileNode(fileNode) {
  const id = fileNode.getAttribute('data-pdf-id');
  const p = state.pdfs[id];
  if (!p || !p.url) return;
  const a = document.createElement('a');
  a.href = p.url;
  a.download = p.fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// 
function deletePdfFileNode(fileNode) {
  const id = fileNode.getAttribute('data-pdf-id');
  const p = state.pdfs[id];
  const name = p ? p.fileName : 'This PDF';
  if (!confirm('Confirm deletion PDF“ ' + name + ' ”??')) return;
  // close the reading tab that has this PDF open
  Array.from(tabViewers.entries()).forEach(([tid, v]) => {
    if (v.type === 'pdf' && v.pdfName === name) closeTab(tid);
  });
  if (p && p.url) { try { URL.revokeObjectURL(p.url); } catch (e) {} }
  delete state.pdfs[id];
  fileNode.remove();
}

// 
if (pdfFileInput) {
  pdfFileInput.addEventListener('change', async () => {
    const files = Array.from(pdfFileInput.files || []);
    pdfFileInput.value = '';
    if (files.length === 0) return;
    const folderNode = pendingReportFolder;  // ,
    pendingReportFolder = null;
    let ok = 0;
    let bad = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!/\.pdf$/i.test(file.name)) {
        bad++;
        continue;
      }
      showImportLoading('Importing“ ' + file.name + '」(' + (i + 1) + '/' + files.length + ')...');
      await new Promise(r => setTimeout(r, 20));
      const url = URL.createObjectURL(file);
      addPdfFileNode(file, url, folderNode);
      ok++;
    }
    hideImportLoading();
    if (ok > 0 && bad > 0) {
      showTableError('Import complete: Success ' + ok + ' items, ' + bad + ' non- PDF File skipped. ');
    }
  });
}

// ============================================================
// report management, Word document read-only reading (the architecture follows the PDF: in-memory storage in state.words and data-word-id on the DOM nodes;
// ,
// ============================================================
const wordFileInput = document.getElementById('word-file-input');
state.words = state.words || {};
let wordCounter = 0;
let pendingRenameWord = null;   // modal 重命名 Word 的目标 {node, cur}
let wordLoadGeneration = 0;
let currentWordUrl = '';        // )

// -- menu: import Word document --
const ctxImportWord = document.getElementById('ctx-import-word');
if (ctxImportWord) {
  ctxImportWord.addEventListener('click', async (e) => {
    e.stopPropagation();
    hideCtxMenu();
    if (wordFileInput) {
      if (!await guardImportPointDraw('Importing Word Documents')) return;
      wordFileInput.value = '';
      wordFileInput.click();
    }
  });
}

// -- menu: open Word --
const ctxOpenWord = document.getElementById('ctx-open-word');
if (ctxOpenWord) {
  ctxOpenWord.addEventListener('click', (e) => {
    e.stopPropagation();
    const { type, target } = ctxContext;
    hideCtxMenu();
    if (type === 'word-file' && target) openWordInNewTab(target);
  });
}

// Word file node
function openWordInNewTab(fileNode) {
  const id = fileNode.getAttribute('data-word-id');
  const w = state.words[id];
  if (!w) return;
  const existing = Array.from(tabViewers.entries()).find(([tid, v]) =>
    v.type === 'word' && v.wordUrl === w.url
  );
  if (existing) {
    window.switchTab(existing[0]);
    return;
  }
  window.createNewTab('word', {
    wordUrl: w.url,
    wordName: w.fileName,
    wordSize: w.size
  });
}

// Word file node
function addWordFileNode(file, url, folderNode) {
  if (!subitemsReport) return null;
  const id = 'word-' + (++wordCounter);
  const folderId = folderNode ? folderNode.getAttribute('data-folder-id') : null;
  state.words[id] = { fileName: file.name, url: url, size: file.size, folder: folderId, filePath: getFilePath(file) };
  const node = document.createElement('div');
  node.className = 'lp-sub-item';
  node.setAttribute('data-word-id', id);
  node.innerHTML =
    '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="#2b579a" stroke-width="2">' +
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>' +
      '<polyline points="14 2 14 8 20 8"></polyline>' +
      '<path d="M16 13H8M16 17H8M10 9H8"></path>' +
    '</svg><span>' + escapeHtml(file.name) + '</span>';
  let target = subitemsReport;
  if (folderNode) {
    const nested = folderNode.nextElementSibling;
    if (nested && nested.classList.contains('lp-nested-items')) target = nested;
  }
  target.appendChild(node);
  bindReportContextMenus(subitemsReport);
  return node;
}

// 
function renameWordFileNode(fileNode) {
  const id = fileNode.getAttribute('data-word-id');
  const w = state.words[id];
  if (!w) return;
  const span = fileNode.querySelector('span');
  const cur = span ? span.textContent : w.fileName;
  pendingRenameWord = { node: fileNode, cur: cur };
  openReportFolderDialog('word-file-rename', 'Rename Word', 'Rename Word (The original file content is unchanged) : ', cur);
}

function applyWordRename(obj, newName) {
  if (!obj || !obj.node) return;
  const fileNode = obj.node;
  const id = fileNode.getAttribute('data-word-id');
  const w = state.words[id];
  if (!w) return;
  const span = fileNode.querySelector('span');
  if (span) span.textContent = newName;
  w.fileName = newName;
  // update the title of the reading tab that is already open
  Array.from(tabViewers.entries()).forEach(([tid, v]) => {
    if (v.type === 'word' && v.wordName === obj.cur) {
      v.wordName = newName;
      const tabEl = document.querySelector('.center-tab[data-tab-id="' + tid + '"]');
      if (tabEl) {
        const lbl = tabEl.querySelector('.center-tab-label');
        if (lbl) lbl.textContent = newName;
        tabEl.title = newName;
      }
      if (activeTabId === tid) {
        const wvTitle = document.getElementById('wv-title');
        if (wvTitle) wvTitle.textContent = newName;
      }
    }
  });
}

// 
function exportWordFileNode(fileNode) {
  const id = fileNode.getAttribute('data-word-id');
  const w = state.words[id];
  if (!w || !w.url) return;
  const a = document.createElement('a');
  a.href = w.url;
  a.download = w.fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// 
function deleteWordFileNode(fileNode) {
  const id = fileNode.getAttribute('data-word-id');
  const w = state.words[id];
  const name = w ? w.fileName : 'This Word';
  if (!confirm('Confirm deletion Word“ ' + name + ' ”??')) return;
  Array.from(tabViewers.entries()).forEach(([tid, v]) => {
    if (v.type === 'word' && v.wordName === name) closeTab(tid);
  });
  if (w && w.url) { try { URL.revokeObjectURL(w.url); } catch (e) {} }
  delete state.words[id];
  fileNode.remove();
}

// 
if (wordFileInput) {
  wordFileInput.addEventListener('change', async () => {
    const files = Array.from(wordFileInput.files || []);
    wordFileInput.value = '';
    if (files.length === 0) return;
    const folderNode = pendingReportFolder;
    pendingReportFolder = null;
    let ok = 0;
    let bad = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!/\.docx$/i.test(file.name)) {
        bad++;
        continue;
      }
      showImportLoading('Importing“ ' + file.name + '」(' + (i + 1) + '/' + files.length + ')...');
      await new Promise(r => setTimeout(r, 20));
      const url = URL.createObjectURL(file);
      addWordFileNode(file, url, folderNode);
      ok++;
    }
    hideImportLoading();
    if (ok > 0 && bad > 0) {
      showTableError('Import complete: Success ' + ok + ' items, ' + bad + ' non- Word(.docx) File skipped. ');
    }
  });
}

// ============================================================
// )
// ,
// ============================================================

// ,
const DOC_PERF = [];
const PERF_STACK = [];
function perfBegin(label) {
  const rec = { label: label, t0: (performance && performance.now) ? performance.now() : Date.now(), ms: -1, note: '', depth: PERF_STACK.length };
  if (DOC_PERF.length > 800) DOC_PERF.splice(0, 300);
  DOC_PERF.push(rec);
  PERF_STACK.push(rec);
  return rec;
}
function perfEnd(rec, note) {
  if (!rec) return -1;
  const now = (performance && performance.now) ? performance.now() : Date.now();
  rec.ms = now - rec.t0;
  if (note) rec.note = note;
  const i = PERF_STACK.indexOf(rec);
  if (i >= 0) PERF_STACK.splice(i, 1);
  if (typeof console !== 'undefined' && console.log) {
    console.log('[PERF] ' + new Array(rec.depth + 1).join('  ') + rec.label + ' = ' + rec.ms.toFixed(1) + ' ms' + (rec.note ? '  (' + rec.note + ')' : ''));
  }
  return rec.ms;
}
// yield one frame so that the loading notice is really painted before the heavy computation starts
function yieldFrame() {
  return new Promise(function (r) {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { setTimeout(r, 0); });
    else setTimeout(r, 0);
  });
}
// ,
function setDocProgress(show, pct) {
  let host = null;
  if (docCtx.type === 'word') host = document.getElementById('word-viewer-content');
  else if (docCtx.type === 'pdf') host = document.getElementById('pdf-viewer-content');
  if (!host) return;
  let bar = document.getElementById('doc-progress');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'doc-progress';
    bar.className = 'doc-progress';
    bar.innerHTML = '<div class="doc-progress-bar"></div>';
    host.appendChild(bar);
  } else if (bar.parentNode !== host) {
    host.appendChild(bar);
  }
  bar.classList.toggle('show', !!show);
  const inner = bar.firstElementChild;
  if (inner) inner.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
}

window.dumpDocPerf = function () {
  const rows = DOC_PERF.map(function (r) {
    return { step: new Array(r.depth + 1).join('    ') + r.label, ms: +r.ms.toFixed(1), note: r.note || '' };
  });
  if (typeof console !== 'undefined' && console.log) {
    console.log('[PERF] ===== Document processing stage timings =====');
    rows.forEach(function (r) { console.log('[PERF] ' + r.step + '   ' + r.ms + ' ms' + (r.note ? '   ' + r.note : '')); });
  }
  return rows;
};

// ---------- Document context and data storage ----------
const docStore = {};                                   // key -> { outline, outlineStatus, outlineOpen, bookmarks, note }
let docCtx = { type: '', url: '', key: '', name: '' }; // 当前激活的文档上下文

// ,
// ,
function docKeyOf(type, identity) { return (type || '?') + '::' + (identity || ''); }
function docRecord(key, create) {
  if (!key) return null;
  if (!docStore[key]) {
    if (!create) return null;
    docStore[key] = { outline: null, outlineStatus: 'idle', outlineOpen: {}, bookmarks: [], note: '' };
  }
  return docStore[key];
}
function escapeBrief(s) { return (typeof escapeHtml === 'function') ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s); }

// )
function bindDocContext(type, url, name) {
  if (docCtx.type === 'pdf' || docCtx.type === 'word') persistDocumentInk(docCtx.type);
  savePendingDocumentNotes();
  const records = type === 'pdf' ? state.pdfs : state.words;
  const source = Object.values(records || {}).find(record => (record.url || record.blobUrl) === url);
  const identity = source?.filePath || name || url;
  docCtx = { type: type || '', url: url || '', key: docKeyOf(type, identity), name: name || '' };
  if (docCtx.key) {
    const rec=docRecord(docCtx.key,true);
    const legacy=docRecord(docKeyOf(type,name));
    if(legacy&&legacy!==rec&&!rec.note&&!rec.bookmarks.length){rec.note=legacy.note;rec.bookmarks=legacy.bookmarks.slice();if(legacy.ink)rec.ink=cleanDocumentInk(legacy.ink);}
    rec.noteIdentity={type,source:identity,name};
    loadDocumentNotes({...docCtx});
  }
  refreshDocPanels();
  // ,
  const rec = docRecord(docCtx.key);
  if (rec && rec.outlineStatus === 'idle') scheduleEnsureOutline();
  return docCtx;
}

function refreshDocPanels() {
  renderDocOutlinePanel();
  renderDocBookmarkPanel();
  renderDocNotePanel();
}

// refresh the content when the right panel switches to a tab in the doc group
window.onRightPanelTabShown = function (g, name) {
  if (g !== 'doc') return;
  if (name === 'Outline') { renderDocOutlinePanel(); scheduleEnsureOutline(); }
  else if (name === 'Bookmarks') renderDocBookmarkPanel();
  else if (name === 'Notes') renderDocNotePanel();
};

// ============================================================
// outline extraction
// ============================================================
const PDF_OUTLINE_MAX_AUTO_PAGE = 400;   // ,
let wordDocBuffer = null;                // outline extraction
let wordDocBufferUrl = '';
let outlineTimer = null;

function scheduleEnsureOutline() {
  if (outlineTimer) clearTimeout(outlineTimer);
  outlineTimer = setTimeout(function () { outlineTimer = null; ensureDocOutline(); }, 60);
}

async function ensureDocOutline() {
  const context = { ...docCtx };
  const document = context.type === 'pdf' && currentPdfUrl === context.url ? pdfDoc : null;
  if (context.type === 'pdf' && !document) return; // ,
  const rec = docRecord(context.key, true);
  if (!rec) return;
  if (rec.outlineStatus === 'loading') { renderDocOutlinePanel(); return; }
  if (rec.outlineStatus === 'done') { renderDocOutlinePanel(); return; }
  rec.outlineStatus = 'loading';
  rec.outline = null;
  renderDocOutlinePanel();
  try {
    if (context.type === 'pdf') {
      rec.outline = await pdfOutlineNative(document);
      if (!rec.outline || !rec.outline.items.length) rec.outline = await pdfOutlineAuto(document);
    } else if (context.type === 'word') {
      // )
      let ol = wordDocBuffer ? await wordOutlineFromXml(wordDocBuffer) : null;
      if (!ol || !ol.items.length) ol = wordOutlineFromDom();
      if (!ol || !ol.items.length) ol = wordOutlineHeuristic();
      rec.outline = ol;
      if (ol && ol.mode === 'wordstyle') bindWordHeadingTargets(rec);
    } else {
      rec.outline = null;
    }
    rec.outlineStatus = 'done';
  } catch (e) {
    rec.outlineStatus = 'error';
    rec.outlineErr = (e && e.message) ? e.message : String(e);
    console.warn('[Outline extraction failed]', e);
  }
  renderDocOutlinePanel();
}

// ---------- PDF outline: the native bookmarks ----------
async function pdfDestPageNum(dest, document = pdfDoc) {
  if (!dest || !document) return null;
  try {
    let d = dest;
    if (typeof d === 'string') d = await document.getDestination(d);
    if (!d || !d.length) return null;
    const ref = d[0];
    if (!ref && ref !== 0) return null;
    if (typeof ref === 'number') return ref + 1;
    return (await document.getPageIndex(ref)) + 1;
  } catch (e) {
    return null;   // ,
  }
}

async function pdfOutlineNative(document = pdfDoc) {
  if (!document) return null;
  const p = perfBegin('PDF Embedded bookmarks getOutline');
  let ol = null;
  try { ol = await document.getOutline(); } catch (e) { ol = null; }
  perfEnd(p, ol ? (ol.length + ' top-level nodes') : 'No embedded bookmarks');
  if (!ol || !ol.length) return null;
  const items = [];
  async function walk(nodes, level) {
    for (let i = 0; i < nodes.length; i++) {
      if (items.length >= 1500) return;
      const n = nodes[i];
      const page = await pdfDestPageNum(n.dest, document);
      items.push({ title: String(n.title || '').trim() || '(Untitled)', level: level, page: page, dest: n.dest });
      if (n.items && n.items.length && level < 4) await walk(n.items, level + 1);
    }
  }
  await walk(ol, 1);
  return items.length ? { mode: 'native', items: items } : null;
}

// )
function textLooksLikeHeading(s) {
  if (!s || s.length < 2) return false;
  if (/^[\d\s.,;:、。，；：\-—_()（）\[\]【】]+$/.test(s)) return false;      // 纯页码 / 纯符号
  if (/^第?\s*\d+\s*[页頁]\s*$/.test(s)) return false;                        // 「第 N 页」
  return true;
}
function pickFirstLine(tcItems) {
  let buf = '';
  for (let i = 0; i < tcItems.length; i++) {
    const it = tcItems[i];
    if (!it || typeof it.str !== 'string') continue;
    const s = it.str.trim();
    if (!s) continue;
    buf = buf ? buf + s : s;
    if (buf.length >= 6) break;
  }
  if (buf.length > 80) buf = buf.slice(0, 80) + '…';
  return textLooksLikeHeading(buf) ? buf : '';
}
async function pdfOutlineAuto(document = pdfDoc) {
  if (!document) return null;
  const total = document.numPages || 0;
  const limit = Math.min(total, PDF_OUTLINE_MAX_AUTO_PAGE);
  const p = perfBegin('PDF Generate outline automatically (Extract first lines page by page) ');
  const items = [];
  for (let i = 1; i <= limit; i++) {
    try {
      const page = await document.getPage(i);
      const tc = await page.getTextContent();
      const line = pickFirstLine(tc.items || []);
      if (line) items.push({ title: line, level: 1, page: i });
    } catch (e) { /* skip a page that fails*/ }
    if (i % 8 === 0) await yieldFrame();   // ,
  }
  perfEnd(p, 'Scan ' + limit + '/' + total + ' Page → ' + items.length + ' entries');
  if (!items.length) return null;
  return { mode: 'auto', items: items, truncated: total > limit, totalPage: total };
}

// )
function headingLevelOfStyle(style) {
  const s = String(style || '');
  let m = /^heading\s*(\d{1,2})$/i.exec(s);
  if (m) return Math.min(6, Math.max(1, parseInt(m[1], 10)));
  m = /^(?:标题|標題)\s*(\d{1,2})$/.exec(s);
  if (m) return Math.min(6, Math.max(1, parseInt(m[1], 10)));
  if (/^(?:title|subtitle|标题|標題|副标题|副標題)$/i.test(s)) return 1;
  // )
  if (/^\d{1,2}$/.test(s)) return Math.min(6, Math.max(1, parseInt(s, 10)));
  return 0;
}
function xmlDecode(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&amp;/g, '&');
}
function xmlParaText(block) {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(block)) !== null) out += (m[1] !== undefined ? m[1] : ' ');
  out = xmlDecode(out).replace(/\s+/g, ' ').trim();
  if (out.length > 80) out = out.slice(0, 80) + '…';
  return out;
}
async function wordOutlineFromXml(buf) {
  if (!window.JSZip || !buf) return null;
  const p = perfBegin('Word Outline (Parse document.xml Heading styles) ');
  try {
    const zip = await window.JSZip.loadAsync(buf);
    const entry = zip.file('word/document.xml');
    if (!entry) { perfEnd(p, 'Not found in the archive: word/document.xml'); return null; }
    const xml = await entry.async('string');
    const items = [];
    const pRe = /<w:p\b[\s\S]*?<\/w:p>/g;
    let m;
    while ((m = pRe.exec(xml)) !== null) {
      const blk = m[0];
      const st = /<w:pStyle\s+w:val="([^"]+)"/.exec(blk);
      const lv = headingLevelOfStyle(st ? st[1] : '');
      if (!lv) continue;
      const txt = xmlParaText(blk);
      if (!txt) continue;
      items.push({ title: txt, level: lv, page: null });
      if (items.length > 2000) break;
    }
    perfEnd(p, items.length + ' headings');
    return items.length ? { mode: 'wordstyle', items: items } : null;
  } catch (e) {
    perfEnd(p, 'Failed:  ' + ((e && e.message) ? e.message : e));
    return null;
  }
}

// )
function collectWordDomHeadings() {
  const content = document.getElementById('word-viewer-content');
  if (!content) return [];
  return Array.prototype.slice.call(content.querySelectorAll('h1,h2,h3,h4,h5,h6'));
}
// ,
// ,
function wordOutlineFromDom() {
  const nodes = collectWordDomHeadings();
  if (!nodes.length) return null;
  const items = [];
  nodes.forEach(function (el) {
    const lv = parseInt(el.tagName.slice(1), 10) || 1;
    let t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (t.length > 80) t = t.slice(0, 80) + '…';
    items.push({ title: t, level: lv, page: null, el: el });
  });
  return items.length ? { mode: 'worddom', items: items } : null;
}

// the third fallback: recognise headings with a heuristic of prominent font size plus a short sentence
// )
function wordOutlineHeuristic() {
  const content = document.getElementById('word-viewer-content');
  if (!content) return null;
  let nodeList = content.querySelectorAll('p');
  if (!nodeList.length) nodeList = content.querySelectorAll('[class*="docx-p"], [class*="pStyle"]');
  if (!nodeList.length) return null;
  const sizeCount = {};
  const info = [];
  Array.prototype.forEach.call(nodeList, function (el) {
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!txt || txt.length > 60) return;
    let cs = null;
    try { cs = window.getComputedStyle(el); } catch (e) { return; }
    if (!cs) return;
    const fs = parseFloat(cs.fontSize) || 0;
    if (!fs) return;
    const k = fs.toFixed(1);
    sizeCount[k] = (sizeCount[k] || 0) + 1;
    info.push({ el: el, txt: txt, fs: fs });
  });
  if (info.length < 3) return null;
  // the body text font size is the size that occurs most often
  let baseKey = null, baseN = 0;
  Object.keys(sizeCount).forEach(function (k) { if (sizeCount[k] > baseN) { baseN = sizeCount[k]; baseKey = k; } });
  const base = parseFloat(baseKey);
  if (!base) return null;
  const items = [];
  info.forEach(function (x) {
    if (x.fs < base * 1.14) return;
    if (!textLooksLikeHeading(x.txt)) return;
    let lv = 3;
    if (x.fs >= base * 1.6) lv = 1;
    else if (x.fs >= base * 1.3) lv = 2;
    items.push({ title: x.txt, level: lv, page: null, el: x.el });
  });
  return items.length ? { mode: 'wordheur', items: items } : null;
}
// ,
function bindWordHeadingTargets(rec) {
  if (!rec || !rec.outline || !rec.outline.items) return;
  const nodes = collectWordDomHeadings();
  const items = rec.outline.items;
  if (!nodes.length) return;
  const norm = function (s) { return String(s || '').replace(/…$/, '').replace(/\s+/g, ' ').trim(); };
  let ni = 0, bound = 0;
  for (let i = 0; i < items.length && ni < nodes.length; i++) {
    const want = norm(items[i].title);
    const got = norm(nodes[ni].textContent);
    if (want && got && (got === want || got.indexOf(want) === 0 || want.indexOf(got) === 0)) {
      items[i].el = nodes[ni]; ni++; bound++;
    }
  }
  // ,
  if (bound === 0 && nodes.length === items.length) {
    items.forEach(function (it, i) { it.el = nodes[i]; });
  }
}

// ============================================================
// render the outline panel on the right
// ============================================================
function renderDocOutlinePanel() {
  const emptyEl = document.getElementById('rp-doc-outline');
  const treeEl = document.getElementById('rp-doc-outline-tree');
  if (!treeEl) return;
  const rec = docRecord(docCtx.key);
  if (!docCtx.key || !rec) {
    treeEl.innerHTML = '';
    if (emptyEl) { emptyEl.style.display = ''; emptyEl.textContent = 'Open PDF / Word documents to extract the outline automatically'; }
    return;
  }
  if (rec.outlineStatus === 'loading' || (docCtx.type === 'pdf' && rec.outlineStatus === 'idle' && currentPdfUrl !== docCtx.url)) {
    treeEl.innerHTML = '';
    if (emptyEl) { emptyEl.style.display = ''; emptyEl.textContent = 'Extracting outline…'; }
    return;
  }
  const ol = rec.outline;
  if (!ol || !ol.items || !ol.items.length) {
    treeEl.innerHTML = '';
    if (emptyEl) {
      emptyEl.style.display = '';
      emptyEl.textContent = (rec.outlineStatus === 'error')
        ? ('Outline extraction failed:  ' + (rec.outlineErr || 'This document format is not supported'))
        : 'No outline is available for this document (Word Use“Heading”styled content, PDF Embedded bookmarks are required) ';
    }
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  const open = rec.outlineOpen || (rec.outlineOpen = {});
  const items = ol.items;
  let html = '';
  let hideLv = 99;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.level > hideLv) continue;
    const hasChild = (i + 1 < items.length) && items[i + 1].level > it.level;
    const isOpen = !!open['k' + i];
    let caret = '<span class="rp-ol-caret"></span>';
    if (hasChild) {
      caret = '<span class="rp-ol-caret" data-act="toggle" data-idx="' + i + '">' + (isOpen ? '▾' : '▸') + '</span>';
      hideLv = isOpen ? 99 : it.level;
    } else {
      hideLv = 99;
    }
    const pad = Math.max(0, (it.level - 1) * 12);
    const pageTxt = it.page ? ('P' + it.page) : (docCtx.type === 'pdf' ? 'No page number' : '');
    html += '<div class="rp-outline-item" data-idx="' + i + '" style="padding-left:' + pad + 'px" title="' + escapeBrief(it.title) + '">' +
      caret + '<span class="rp-outline-title">' + escapeBrief(it.title) + '</span>' +
      '<span class="rp-outline-page">' + pageTxt + '</span></div>';
  }
  treeEl.innerHTML = html;
  if (ol.truncated) {
    treeEl.insertAdjacentHTML('beforeend', '<div class="rp-ol-note">Scanned first ' + PDF_OUTLINE_MAX_AUTO_PAGE + ' Page (Full text ' + (ol.totalPage || '?') + ' Page) </div>');
  }
}

function markOutlineCurrent(idx) {
  const treeEl = document.getElementById('rp-doc-outline-tree');
  if (!treeEl) return;
  Array.prototype.forEach.call(treeEl.querySelectorAll('.rp-outline-item'), function (x) {
    x.classList.toggle('current', x.dataset.idx === String(idx));
  });
}

function docHintTemp(type, msg) {
  const el = document.getElementById((type === 'pdf') ? 'pdf-tool-hint' : 'word-tool-hint');
  if (!el) return;
  const prev = el.textContent;
  el.textContent = msg;
  clearTimeout(docHintTemp._t);
  docHintTemp._t = setTimeout(function () { el.textContent = prev; }, 2600);
}
// collect the paragraph-level elements in the Word body that can anchor a heading lookup
function collectWordParagraphs() {
  const content = document.getElementById('word-viewer-content');
  if (!content) return [];
  let nodes = Array.prototype.slice.call(content.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,td'));
  if (!nodes.length) nodes = Array.prototype.slice.call(content.querySelectorAll('[class*="docx-p"],[class*="pStyle"]'));
  return nodes;
}
// ,
function findWordHeadingEl(want) {
  const w = stripEllipsis(want);
  if (w.length < 1) return null;
  const nodes = collectWordParagraphs();
  let i, t;
  for (i = 0; i < nodes.length; i++) { t = normDocText(nodes[i].textContent); if (t === w) return nodes[i]; }
  for (i = 0; i < nodes.length; i++) { t = normDocText(nodes[i].textContent); if (t && t.indexOf(w) === 0) return nodes[i]; }
  for (i = 0; i < nodes.length; i++) { t = normDocText(nodes[i].textContent); if (t && t.length >= 4 && w.indexOf(t) === 0) return nodes[i]; }
  let best = null, bestLen = Infinity;
  for (i = 0; i < nodes.length; i++) {
    t = normDocText(nodes[i].textContent);
    if (!t || t.indexOf(w) < 0) continue;
    if (t.length < bestLen) { bestLen = t.length; best = nodes[i]; }
  }
  return best;
}

function jumpDocToOutlineItem(it) {
  if (!it) return;
  if (docCtx.type === 'pdf') {
    const doJump = function (pg) {
      if (typeof pdfPageNum === 'undefined') return;
      const maxP = (typeof pdfDoc !== 'undefined' && pdfDoc && pdfDoc.numPages) ? pdfDoc.numPages : pg;
      pdfPageNum = Math.max(1, Math.min(pg, maxP));
      pdfAutoScrollBottom = false;
      if (typeof renderPdfPage === 'function') renderPdfPage();
    };
    if (it.page) { doJump(it.page); return; }
    // the native bookmark page number could not be resolved, so it is derived once more from dest
    if (it.dest && typeof pdfDestPageNum === 'function') {
      pdfDestPageNum(it.dest).then(function (p) {
        if (p) doJump(p);
        else { console.warn('[Outline navigation] PDF Unable to resolve the bookmark page: ', it.title); docHintTemp('pdf', 'Unable to locate this bookmark (Unable to resolve page number) '); }
      });
      return;
    }
    console.warn('[Outline navigation] PDF The outline entry has no page number: ', it.title);
    docHintTemp('pdf', 'This entry has no page number, Unable to navigate');
    return;
  }
  if (docCtx.type === 'word') {
    const want = stripEllipsis(it.title);
    let el = (it.el && it.el.isConnected) ? it.el : null;
    if (!el && want) el = findWordHeadingEl(want);
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      flashWordTarget(el);
      return;
    }
    // cross-node text fallback
    if (want.length >= 2) {
      const r = locateWordTextNode(want);
      if (r) { revealWordRange(r); return; }
    }
    console.warn('[Outline navigation] Word Unable to locate the heading in the document: ', it.title);
    docHintTemp('word', 'Unable to locate“ ' + (want || it.title) + ' ”position');
  }
}
function flashWordTarget(el) {
  try {
    el.classList.remove('wv-flash');
    void el.offsetWidth;
    el.classList.add('wv-flash');
    setTimeout(function () { el.classList.remove('wv-flash'); }, 1400);
  } catch (e) { /* ignore an animation failure*/ }
}

(function bindOutlineTreeEvents() {
  const treeEl = document.getElementById('rp-doc-outline-tree');
  if (!treeEl) return;
  treeEl.addEventListener('click', function (e) {
    const rec = docRecord(docCtx.key);
    if (!rec || !rec.outline || !rec.outline.items) return;
    const caret = (e.target && e.target.closest) ? e.target.closest('[data-act="toggle"]') : null;
    if (caret) {
      const i = parseInt(caret.dataset.idx, 10);
      const open = rec.outlineOpen || (rec.outlineOpen = {});
      open['k' + i] = !open['k' + i];
      renderDocOutlinePanel();
      e.stopPropagation();
      return;
    }
    const el = (e.target && e.target.closest) ? e.target.closest('.rp-outline-item') : null;
    if (!el) return;
    const i = parseInt(el.dataset.idx, 10);
    jumpDocToOutlineItem(rec.outline.items[i]);
    markOutlineCurrent(i);
  });
})();

// ============================================================
// bookmarks: select text in the reading page, right-click, then add a label
// ============================================================
function docCurrentLocation() {
  if (docCtx.type === 'pdf') return (typeof pdfPageNum !== 'undefined') ? pdfPageNum : null;
  return null;   // ,
}
function addDocBookmark(name, quote, opts) {
  const rec = docRecord(docCtx.key, true);
  if (!rec) return null;
  const o = opts || {};
  const bm = {
    id: 'bm' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36),
    name: String(name || '').trim() || 'Untitled tab',
    quote: String(quote || '').slice(0, 300),
    anchor: String(o.anchor || '').slice(0, 300),   // Word 回滚定位用的原文片段
    loc: (o.loc != null) ? o.loc : docCurrentLocation(),
    time: Date.now()
  };
  rec.bookmarks.push(bm);
  rec.bookmarks.sort(function (a, b) {
    const ka = (a.loc == null) ? Number.MAX_SAFE_INTEGER : a.loc;
    const kb = (b.loc == null) ? Number.MAX_SAFE_INTEGER : b.loc;
    return ka - kb;
  });
  renderDocBookmarkPanel();
  return bm;
}
function findDocBookmark(id) {
  const rec = docRecord(docCtx.key);
  if (!rec) return null;
  for (let i = 0; i < rec.bookmarks.length; i++) if (rec.bookmarks[i].id === id) return rec.bookmarks[i];
  return null;
}
function removeDocBookmark(id) {
  const rec = docRecord(docCtx.key);
  if (!rec) return;
  rec.bookmarks = rec.bookmarks.filter(function (b) { return b.id !== id; });
  renderDocBookmarkPanel();
}
function renameDocBookmark(id, name) {
  const bm = findDocBookmark(id);
  if (!bm) return;
  const v = String(name || '').replace(/\s+/g, ' ').trim();
  bm.name = v || bm.name;
  renderDocBookmarkPanel();
}

// locate a Word bookmark: find the Range again in the rendered DOM from the original text fragment and scroll it into view
function normDocText(s) {
  return String(s == null ? '' : s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}
function stripEllipsis(s) {
  return String(s == null ? '' : s).replace(/[.…。]{2,}\s*$/, '').replace(/\s+$/, '').trim();
}
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// ,
// )
function locateWordTextNode(text) {
  const content = document.getElementById('word-viewer-content');
  if (!content || !text) return null;
  const want = normDocText(stripEllipsis(text));
  if (!want || want.length < 2) return null;
  const rx = new RegExp(escapeRegExp(want).replace(/\s+/g, '\\s+'), '');
  let walker = null;
  try { walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null, false); } catch (e) { return null; }
  let node;
  while ((node = walker.nextNode())) {
    const raw = node.nodeValue || '';
    const m = rx.exec(raw);
    if (!m) continue;
    try {
      const r = document.createRange();
      r.setStart(node, m.index);
      r.setEnd(node, m.index + m[0].length);
      return r;
    } catch (e) { return null; }
  }
  return null;
}
function revealWordRange(r) {
  let el = r.startContainer;
  if (el && el.nodeType !== 1) el = el.parentNode;
  if (!el || !el.scrollIntoView) return false;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  try {
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(r); }
  } catch (e) { /* a failure to colour the selection does not affect the lookup*/ }
  flashWordTarget(el);
  return true;
}
function jumpDocBookmark(id) {
  const bm = findDocBookmark(id);
  if (!bm) return;
  if (docCtx.type === 'word') {
    const r = locateWordTextNode(bm.anchor || bm.quote || bm.name);
    if (r && revealWordRange(r)) return;
  }
  jumpDocToOutlineItem({ page: bm.loc });
}

function renderDocBookmarkPanel() {
  const emptyEl = document.getElementById('rp-doc-bookmark');
  const listEl = document.getElementById('rp-doc-bookmark-list');
  if (!listEl) return;
  // ,
  if (typeof window.__bmFinishRename === 'function') {
    const fin = window.__bmFinishRename;
    window.__bmFinishRename = null;
    try { fin(true); } catch (e) { /* a failure to commit does not affect the later rendering*/ }
    return;
  }
  const rec = docRecord(docCtx.key);
  if (!docCtx.key || !rec || !rec.bookmarks.length) {
    listEl.innerHTML = '';
    if (emptyEl) { emptyEl.style.display = ''; emptyEl.textContent = 'Select text on a document page → Right-click → Add bookmark'; }
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  let html = '';
  rec.bookmarks.forEach(function (b, i) {
    const locTxt = (b.loc != null) ? ('No. ' + b.loc + ' Page') : 'in document';
    html += '<div class="rp-bm-item" data-id="' + b.id + ' " title="Click to navigate · Double-click its name or click『Rename』Rename">' +
      '<div class="rp-bm-head"><span class="rp-bm-idx">' + (i + 1) + '.</span>' +
      '<span class="rp-bm-name">' + escapeBrief(b.name) + '</span></div>' +
      (b.quote ? '<div class="rp-bm-quote">“' + escapeBrief(b.quote) + '”</div>' : '') +
      '<div class="rp-bm-meta">' + locTxt +
      ' · <span class="rp-bm-act" data-act="ren">Rename</span>' +
      ' · <span class="rp-bm-act" data-act="del">Delete</span></div>' +
      '</div>';
  });
  listEl.innerHTML = html;
}

(function bindBookmarkListEvents() {
  const listEl = document.getElementById('rp-doc-bookmark-list');
  if (!listEl) return;
  listEl.addEventListener('click', function (e) {
    const item = (e.target && e.target.closest) ? e.target.closest('.rp-bm-item') : null;
    if (!item) return;
    const id = item.dataset.id;
    const act = (e.target && e.target.closest) ? e.target.closest('[data-act]') : null;
    e.stopPropagation();
    if (act && act.dataset.act === 'del') { removeDocBookmark(id); return; }
    jumpDocBookmark(id);
  });
// ,
function selectNodeContents(el) {
  try {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = window.getSelection();
    if (s) { s.removeAllRanges(); s.addRange(r); }
  } catch (err) { /* ignore*/ }
}
let bmJumpTimer = null;
function startInlineRename(id) {
  const listEl = document.getElementById('rp-doc-bookmark-list');
  if (!listEl) return;
  const item = listEl.querySelector('.rp-bm-item[data-id="' + id + '"]');
  if (!item) return;
  const nameEl = item.querySelector('.rp-bm-name');
  if (!nameEl || nameEl.isContentEditable) return;
  const old = nameEl.textContent;
  nameEl.contentEditable = 'true';
  nameEl.spellcheck = false;
  nameEl.focus();
  selectNodeContents(nameEl);
  let done = false;
  const finish = function (commit) {
    if (done) return;
    done = true;
    window.__bmFinishRename = null;
    nameEl.contentEditable = 'false';
    renameDocBookmark(id, commit ? nameEl.textContent : old);  // 留空则沿用原名
  };
  window.__bmFinishRename = finish;   // 供列表重绘前兜底提交
  nameEl.addEventListener('blur', function () { finish(true); }, { once: true });
  nameEl.addEventListener('keydown', function (ev) {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); nameEl.blur(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
}
listEl.addEventListener('click', function (e) {
  const item = (e.target && e.target.closest) ? e.target.closest('.rp-bm-item') : null;
  if (!item) return;
  const id = item.dataset.id;
  const act = (e.target && e.target.closest) ? e.target.closest('[data-act]') : null;
  e.stopPropagation();
  if (act && act.dataset.act === 'del') { removeDocBookmark(id); return; }
  if (act && act.dataset.act === 'ren') {
    if (bmJumpTimer) { clearTimeout(bmJumpTimer); bmJumpTimer = null; }
    startInlineRename(id);
    return;
  }
  const nameEl = (e.target && e.target.closest) ? e.target.closest('.rp-bm-name') : null;
  if (nameEl && nameEl.isContentEditable) return;   // ,
  if (nameEl) {                                     // ,
    if (bmJumpTimer) clearTimeout(bmJumpTimer);
    bmJumpTimer = setTimeout(function () { bmJumpTimer = null; jumpDocBookmark(id); }, 260);
    return;
  }
  jumpDocBookmark(id);
});
listEl.addEventListener('dblclick', function (e) {
  const nameEl = (e.target && e.target.closest) ? e.target.closest('.rp-bm-name') : null;
  if (!nameEl) return;
  const item = nameEl.closest('.rp-bm-item');
  if (!item) return;
  if (bmJumpTimer) { clearTimeout(bmJumpTimer); bmJumpTimer = null; }
  e.preventDefault();
  startInlineRename(item.dataset.id);
});
})();

// ============================================================
// ,
// ============================================================
let noteSaveTimer = null;
let noteBindKey = '';
function renderDocNotePanel() {
  const emptyEl = document.getElementById('rp-doc-note-empty');
  const ed = document.getElementById('rp-doc-note-editor');
  if (!ed) return;
  const rec = docRecord(docCtx.key);
  if (!docCtx.key || !rec) {
    ed.classList.remove('show');
    ed.value = '';
    noteBindKey = '';
    if (emptyEl) { emptyEl.style.display = ''; emptyEl.textContent = 'Open PDF / Word documents to take notes here'; }
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  ed.classList.add('show');
  if (noteBindKey !== docCtx.key || document.activeElement !== ed) ed.value = rec.note || '';
  noteBindKey = docCtx.key;
}
(function bindNoteEditor() {
  const ed = document.getElementById('rp-doc-note-editor');
  if (!ed) return;
  ed.addEventListener('input', function () {
    const rec = docRecord(noteBindKey || docCtx.key);
    if (!rec) return;
    rec.note = ed.value;
    queueDocumentNotes(noteBindKey || docCtx.key);
    if (noteSaveTimer) clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(function () {
      noteSaveTimer = null;
      if (typeof window.saveTabsSession === 'function') window.saveTabsSession();
    }, 700);
  });
  ed.addEventListener('blur', function () {
    const rec = docRecord(noteBindKey || docCtx.key);
    if (rec) { rec.note = ed.value; queueDocumentNotes(noteBindKey || docCtx.key); savePendingDocumentNotes(); }
    if (typeof window.saveTabsSession === 'function') window.saveTabsSession();
  });
  // stop the keys typed in a note from bubbling up to the global shortcuts
  ed.addEventListener('keydown', function (e) { e.stopPropagation(); });
})();

// ============================================================
// persistence: the bookmarks and notes are saved and restored together with the project file
// ,
// ============================================================
function serializeDocAnnots() {
  const out = {};
  Object.keys(docStore).forEach(function (k) {
    const d = docStore[k];
    if (!d) return;
    const bms = d.bookmarks || [];
    if (!bms.length && !d.note && !d.ink) return;
    out[k] = {
      bookmarks: bms.map(function (b) {
        return { id: b.id, name: b.name, quote: b.quote, anchor: b.anchor, loc: b.loc, time: b.time };
      }),
      note: d.note || '', ink: cleanDocumentInk(d.ink)
    };
  });
  return out;
}
function restoreDocAnnots(obj) {
  if (!obj || typeof obj !== 'object') return;
  Object.keys(obj).forEach(function (k) {
    const src = obj[k];
    if (!src) return;
    const d = docRecord(k, true);
    d.bookmarks = Array.isArray(src.bookmarks) ? src.bookmarks.slice() : [];
    d.note = String(src.note || ''); if(src.ink)d.ink=cleanDocumentInk(src.ink);
  });
  refreshDocPanels();
}

// ============================================================
// )
// note: breakPages splits the pages on the embedded page breaks and ignoreLastRenderedPageBreak is false
// )
// ,
// ============================================================
async function loadWordIntoViewer(url) {
  try{await ensureDocumentLibrary('word');}catch(error){document.getElementById('word-viewer-content').textContent=error.message;return;}
  const generation=++wordLoadGeneration;
  const content = document.getElementById('word-viewer-content');
  if (!content) return;
  if (!window.docx) {
    content.innerHTML =
      '<div class="pdf-hint">Not found Word Rendering engine (lib/docx-preview/docx-preview.min.js) <br>Please docx-preview.min.js and jszip.min.js Place in lib/docx-preview/ folder and reopen. </div>';
    return;
  }
  let data = null;
  const pfRead = perfBegin('Word File reading');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.arrayBuffer();
    perfEnd(pfRead, (data ? (data.byteLength / 1024).toFixed(1) : '0') + ' KB');
  } catch (e) {
    perfEnd(pfRead, 'Failed');
    showTableError('Word Read failed:  ' + e.message);
    return;
  }
  if(generation!==wordLoadGeneration||docCtx.type!=='word'||docCtx.url!==url)return;
  content.innerHTML = '<div class="pdf-hint">Laying out document (docx-preview Render pages sequentially) ...</div>';
  setDocProgress(true, 8);
  await yieldFrame();       // ,
  await yieldFrame();
  const pfRender = perfBegin('Word Layout and rendering renderAsync');
  try {
    const staging=document.createElement('div');
    await window.docx.renderAsync(data, staging, null, {
      className: 'docx',
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      renderFootnotes: true,
      renderEndnotes: true
    });
    if(generation!==wordLoadGeneration||docCtx.type!=='word'||docCtx.url!==url)return;
    resetWordAnnotState();
    content.replaceChildren(...staging.childNodes);
    wordDocBuffer=data;wordDocBufferUrl=url;
    currentWordUrl = url;
    perfEnd(pfRender, 'Complete');
    setDocProgress(true, 70);
    // collect the pages and initialise the lazily mounted annotation layer
    setupWordAnnotLayers();
    if(docCtx.type==='word'&&docCtx.url===url)applyStoredDocumentInk({...docCtx});
    setDocProgress(false, 100);
    // )
    if (docCtx.type === 'word' && docCtx.url === url) { bindWordHeadingTargets(docRecord(docCtx.key)); scheduleEnsureOutline(); }
  } catch (e) {
    perfEnd(pfRender, 'Failed:  ' + ((e && e.message) || e));
    setDocProgress(false, 100);
    content.innerHTML = '<div class="pdf-hint">Word Document parsing failed (The file may be corrupt, encrypted or containing unsupported complex layouts) : ' + escapeHtml(e.message) + '</div>';
  }
}

// ============================================================
// ,
// ,
// 
// ,
// ============================================================
let wordAnnots = {};         // {页索引: [笔画]}
let wordTool = null;         // 'pen' | 'highlight' | 'eraser' | null
let wordPenColor = '#e24b4a';// 画笔颜色
let wordDrawing = null;      // 绘制中的笔画 {page,type,color,width,points}
let wordPages = [];          // 渲染出的页面 section 元素
let wordPageCanvas = {};     // )
let wordPageSize = {};       // )
let wordReconcilePending = false;
let wordRedrawPending = false;
let wordAnnotReady = false;  // 当前文档已渲染出页面结构
let wordRedrawTimer = null;  // ,
const WORD_REDRAW_MIN_MS = 24;   // ,
const WORD_MIN_POINT_DIST = 2;   // ,
const WORD_MAX_POINTS_PER_STROKE = 2000; // 单笔最大点数上限
let wordPathCache = {};      // 页索引 -> {脏标记} 单笔 Path2D 复用缓存

function wordPixelRatio() { return window.devicePixelRatio || 1; }

// 
// ,
// ,
// ,
let wordScale = 1;
const WORD_SCALE_MIN = 0.4;
const WORD_SCALE_MAX = 4;
const WORD_SCALE_STEP = 0.1;
const WORD_AUTOFIT_MAX = 2;   // ,

// )
function wordAutoFitScale() {
  const content = document.getElementById('word-viewer-content');
  if (!content || !wordPages.length) return;
  const avail = content.clientWidth;
  if (!avail) return;
  // the natural width of a page that is not scaled equals the current visual width divided by the current zoom
  let nat = 0;
  for (let i = 0; i < wordPages.length; i++) {
    const r = wordPages[i].getBoundingClientRect();
    if (r.width > nat) nat = r.width;
  }
  if (nat <= 0) return;
  nat = nat / wordScale;
  if (nat <= 0) return;
  let fit = avail / nat;
  if (!isFinite(fit) || fit <= 0) return;
  fit = Math.min(WORD_AUTOFIT_MAX, Math.max(WORD_SCALE_MIN, Math.round(fit * 100) / 100));
  wordScale = fit;
  applyWordZoom();
}

function applyWordZoom() {
  const content = document.getElementById('word-viewer-content');
  if (content) content.style.setProperty('--wv-scale', String(wordScale));
  const zi = document.getElementById('word-zoom-info');
  if (zi) zi.textContent = Math.round(wordScale * 100) + '%';
  syncWordZoomButtons();
  // when the zoom changes the visual height of the page, recalibrate the canvas size immediately
  scheduleWordReconcile();
}

function syncWordZoomButtons() {
  const zin = document.getElementById('word-zoom-in-btn');
  const zout = document.getElementById('word-zoom-out-btn');
  if (zin) zin.disabled = wordScale >= WORD_SCALE_MAX - 0.001;
  if (zout) zout.disabled = wordScale <= WORD_SCALE_MIN + 0.001;
}

function wordZoomIn() {
  if (wordScale >= WORD_SCALE_MAX) return;
  wordScale = Math.min(WORD_SCALE_MAX, Math.round((wordScale + WORD_SCALE_STEP) * 100) / 100);
  applyWordZoom();
}

function wordZoomOut() {
  if (wordScale <= WORD_SCALE_MIN) return;
  wordScale = Math.max(WORD_SCALE_MIN, Math.round((wordScale - WORD_SCALE_STEP) * 100) / 100);
  applyWordZoom();
}

function wordZoomReset() {
  wordScale = 1;
  applyWordZoom();
}


function resetWordAnnotState() {
  wordAnnots = {};
  wordTool = null;
  wordDrawing = null;
  wordPages = [];
  wordPageCanvas = {};
  wordPageCanvas._scale = null;   // 缩放版本标记：null 表示需按当前缩放重建
  wordPageSize = {};
  wordPathCache = {};
  if (wordRedrawTimer) { clearTimeout(wordRedrawTimer); wordRedrawTimer = null; }
  if (wordReconcileRaf) { cancelAnimationFrame(wordReconcileRaf); wordReconcileRaf = null; }
  wordRedrawPending = false;
  wordReconcilePending = false;
  wordAnnotReady = false;
  wordScale = 1;               // )
  applyWordZoom();
  syncWordAnnotState();
}

function setupWordAnnotLayers() {
  const content = document.getElementById('word-viewer-content');
  if (!content) return;
  // )
  let secs = content.querySelectorAll('section.docx');
  if (!secs.length) secs = content.querySelectorAll('.docx-wrapper > section');
  if (!secs.length) secs = content.querySelectorAll('.docx');
  if (!secs.length) secs = content.querySelectorAll('.docx-wrapper > div');
  if (!secs.length) return;   // ,
  wordPages = Array.from(secs);
  wordPageCanvas = {};
  wordPageCanvas._scale = null;
  wordPageSize = {};
  wordPathCache = {};
  wordAnnotReady = true;
  // )
  wordScale = 1;
  const content0 = document.getElementById('word-viewer-content');
  if (content0) content0.style.setProperty('--wv-scale', '1');
  // ,
  wordAutoFitScale();
  // ,
  content.removeEventListener('scroll', scheduleWordReconcile);
  content.addEventListener('scroll', scheduleWordReconcile, { passive: true });
  window.removeEventListener('resize', onWordResize);
  window.addEventListener('resize', onWordResize);
  scheduleWordReconcile();
  // ,
  [300, 1200, 3000].forEach(function (ms) {
    setTimeout(scheduleWordReconcile, ms);
  });
}

// )
let wordResizeTimer = null;
function onWordResize() {
  if (wordResizeTimer) clearTimeout(wordResizeTimer);
  wordResizeTimer = setTimeout(scheduleWordReconcile, 180);
}

// ,
let wordReconcileTimer = null;
let wordLastReconcile = 0;
let wordReconcileRaf = null;
function scheduleWordReconcile() {
  if (!wordAnnotReady) return;
  // ,
  if (!wordReconcileRaf) {
    wordReconcileRaf = requestAnimationFrame(function () {
      wordReconcileRaf = null;
      reconcileWordAnnotCanvases();
    });
  }
  const now = Date.now();
  const wait = Math.max(0, 80 - (now - wordLastReconcile));
  if (wordReconcileTimer) return;
  wordReconcileTimer = setTimeout(function () {
    wordReconcileTimer = null;
    wordLastReconcile = Date.now();
    reconcileWordAnnotCanvases();
  }, wait);
}

function wordPageVisible(sec) {
  const wrap = document.getElementById('word-viewer-wrap');
  const content = document.getElementById('word-viewer-content');
  if (!wrap || !content || !wrap.classList.contains('show')) return false;
  const r = sec.getBoundingClientRect();
  const cr = content.getBoundingClientRect();
  const pad = 150;   // ,
  return r.bottom >= cr.top - pad && r.top <= cr.bottom + pad;
}

function getWordPageIndex(sec) { return wordPages.indexOf(sec); }

// )
// ,
// 
// )
// ,
// ,
// ,
// ,
// the approach: use an absolutely positioned probe div of zero size to measure the natural height without the canvas
function measureWordPageBox(sec) {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;padding:0;margin:0;border:0;pointer-events:none;visibility:hidden;';
  sec.appendChild(probe);
  let w = 0, h = 0;
  try {
    const cs = window.getComputedStyle(probe);
    const pr = probe.getBoundingClientRect();
    const pl = parseFloat(cs.paddingLeft) || 0;
    const prr = parseFloat(cs.paddingRight) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    // ,
    const s = wordScale || 1;
    w = Math.max(1, Math.round((pr.width / s) + pl + prr));
    h = Math.max(1, Math.round((pr.height / s) + pt + pb));
  } catch (e) {
    w = 0;
    h = 0;
  } finally {
    if (probe.parentNode) probe.parentNode.removeChild(probe);
  }
  // ,
  if (h <= 1) {
    const hasCanvas = sec.querySelector(':scope > .wv-annot-canvas');
    const s = wordScale || 1;
    if (!hasCanvas) h = Math.max(1, Math.round(sec.clientHeight / s));
    else {
      // ,
      const prev = wordPageSize[getWordPageIndex(sec)];
      h = prev ? prev.h : 1;
    }
  }
  if (w <= 1) {
    const prev0 = wordPageSize[getWordPageIndex(sec)];
    w = prev0 ? prev0.w : Math.max(1, Math.round(sec.clientWidth / (wordScale || 1)));
  }
  return { w: w, h: h };
}

function ensureWordCanvas(sec) {
  const idx = getWordPageIndex(sec);
  if (idx < 0) return null;
  let cv = wordPageCanvas[idx];
  if (cv && cv.parentNode === sec) return cv;
  const box = measureWordPageBox(sec);
  const dpr = wordPixelRatio();
  const w = box.w, h = box.h;
  wordPageSize[idx] = { w: w, h: h };
  cv = document.createElement('canvas');
  cv.className = 'wv-annot-canvas';
  // )
  // the transform:scale on the ancestor .docx-wrapper enlarges the canvas along with it,
  // ,
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  // ,
  const rs = Math.min(WORD_SCALE_MAX, Math.max(1, wordScale));
  cv.width = Math.max(1, Math.floor(w * dpr * rs));
  cv.height = Math.max(1, Math.floor(h * dpr * rs));
  cv.style.flex = '0 0 auto';
  cv.style.alignSelf = 'flex-start';
  sec.appendChild(cv);
  wordPageCanvas[idx] = cv;
  drawWordPageAnnots(idx);
  return cv;
}

function removeWordCanvas(idx) {
  if (idx === '_scale') return;   // 保护缩放版本标记键
  const cv = wordPageCanvas[idx];
  if (cv && cv.parentNode) cv.parentNode.removeChild(cv);
  delete wordPageCanvas[idx];
}
function reconcileWordAnnotCanvases() {
  if (!wordAnnotReady) return;
  // ,
  const cvScale = wordPageCanvas._scale;
  if (cvScale !== wordScale) {
    Object.keys(wordPageCanvas).forEach(function (k) { removeWordCanvas(Number(k)); });
    wordPageCanvas._scale = wordScale;
  }
  wordPages.forEach(function (sec, i) {
    if (wordPageVisible(sec)) ensureWordCanvas(sec);
    else removeWordCanvas(i);
  });
}

// ,
// ,
// because the bitmap has already been enlarged by dpr times scale.
function squashPoint(p, s) { return { x: p.x / s, y: p.y / s }; }

function wordPointFromEvent(e, sec) {
  const r = sec.getBoundingClientRect();
  const s = wordScale || 1;
  // ,
  return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
}

function wordPageAtPoint(e) {
  let t = e.target;
  while (t && t !== document) {
    if (wordPages.indexOf(t) >= 0) return t;
    t = t.parentNode;
  }
  return null;
}

function drawWordStrokeOn(ctx, s, dpr) {
  const pts = s.points;
  if (!pts.length) return;
  // ,
  const k = dpr * (wordScale || 1);
  ctx.globalCompositeOperation = (s.type === 'eraser') ? 'destination-out' : 'source-over';
  ctx.strokeStyle = s.type === 'highlight' ? 'rgba(255,235,59,0.45)' : s.color;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = Math.max(1, s.width * k);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x * k, pts[0].y * k, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // )
    let p = s._path;
    if (!p) {
      p = new Path2D();
      p.moveTo(pts[0].x * k, pts[0].y * k);
      for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x * k, pts[i].y * k);
      if (!s._drawing) s._path = p;   // ,
    }
    ctx.stroke(p);
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawWordPageAnnots(idx) {
  const cv = wordPageCanvas[idx];
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const dpr = wordPixelRatio();
  ctx.clearRect(0, 0, cv.width, cv.height);
  (wordAnnots[idx] || []).forEach(function (s) { drawWordStrokeOn(ctx, s, dpr); });
  if (wordDrawing && wordDrawing.page === idx) drawWordStrokeOn(ctx, wordDrawing, dpr);
}

// ,
function scheduleWordRedraw() {
  if (wordRedrawTimer) return;
  wordRedrawTimer = setTimeout(function () {
    wordRedrawTimer = null;
    if (!wordDrawing) return;
    requestAnimationFrame(function () {
      if (wordDrawing) drawWordPageAnnots(wordDrawing.page);
    });
  }, WORD_REDRAW_MIN_MS);
}

// the state
function syncWordAnnotState() {
  const content = document.getElementById('word-viewer-content');
  if (content) {
    content.classList.toggle('wv-drawing', !!wordTool);
    content.style.cursor = wordTool ? (wordTool === 'eraser' ? 'cell' : 'crosshair') : '';
  }
  const penBtn = document.getElementById('word-pen-btn');
  const hlBtn = document.getElementById('word-hl-btn');
  const erBtn = document.getElementById('word-eraser-btn');
  if (penBtn) penBtn.classList.toggle('active', wordTool === 'pen');
  if (hlBtn) hlBtn.classList.toggle('active', wordTool === 'highlight');
  if (erBtn) erBtn.classList.toggle('active', wordTool === 'eraser');
  const hint = document.getElementById('word-tool-hint');
  if (hint) {
    hint.textContent = wordTool === 'pen' ? 'Pen: Drag on the page to draw, Esc Exit'
      : wordTool === 'highlight' ? 'Highlight: Drag across content to highlight it, Esc Exit'
      : wordTool === 'eraser' ? 'Eraser: Drag to erase ink/Highlight, Esc Exit' : '';
  }
}

function setWordTool(tool) {
  wordTool = (wordTool === tool) ? null : tool;
  syncWordAnnotState();
}

// ,
const wordContentEl = document.getElementById('word-viewer-content');
if (wordContentEl) {
  wordContentEl.addEventListener('pointerdown', function (e) {
    if (!wordAnnotReady || !wordTool) return;
    const sec = wordPageAtPoint(e);
    if (!sec) return;
    const idx = getWordPageIndex(sec);
    if (idx < 0) return;
    e.preventDefault();
    try { wordContentEl.setPointerCapture(e.pointerId); } catch (err) {}
    ensureWordCanvas(sec);   // ,
    wordDrawing = {
      page: idx,
      type: wordTool,
      color: wordPenColor,
      width: wordTool === 'highlight' ? 22 : (wordTool === 'eraser' ? 28 : 3),
      points: [wordPointFromEvent(e, sec)],
      _drawing: true
    };
    scheduleWordRedraw();
  });

  wordContentEl.addEventListener('pointermove', function (e) {
    if (!wordDrawing) return;
    const sec = wordPages[wordDrawing.page];
    if (!sec) return;
    e.preventDefault();
    // ,
    if (wordDrawing.points.length >= WORD_MAX_POINTS_PER_STROKE) return;
    const pt = wordPointFromEvent(e, sec);
    const last = wordDrawing.points[wordDrawing.points.length - 1];
    if (last) {
      const dx = pt.x - last.x, dy = pt.y - last.y;
      if (dx * dx + dy * dy < WORD_MIN_POINT_DIST * WORD_MIN_POINT_DIST) return;
    }
    wordDrawing.points.push(pt);
    scheduleWordRedraw();
  });

  window.addEventListener('pointerup', function () {
    if (!wordDrawing) return;
    const p = wordDrawing.page;
    wordDrawing._drawing = false;   // 落库后可安全缓存 Path2D
    if (!wordAnnots[p]) wordAnnots[p] = [];
    wordAnnots[p].push(wordDrawing);
    persistDocumentInk('word');
    wordDrawing = null;
    if (wordRedrawTimer) { clearTimeout(wordRedrawTimer); wordRedrawTimer = null; }
    requestAnimationFrame(function () { drawWordPageAnnots(p); });
  });
}

// -- tool buttons --
const wordPenBtn = document.getElementById('word-pen-btn');
if (wordPenBtn) wordPenBtn.addEventListener('click', function () { setWordTool('pen'); });
const wordHlBtn = document.getElementById('word-hl-btn');
if (wordHlBtn) wordHlBtn.addEventListener('click', function () { setWordTool('highlight'); });
const wordEraserBtn = document.getElementById('word-eraser-btn');
if (wordEraserBtn) wordEraserBtn.addEventListener('click', function () { setWordTool('eraser'); });

// -- zoom buttons --
const wordZoomInBtn = document.getElementById('word-zoom-in-btn');
if (wordZoomInBtn) wordZoomInBtn.addEventListener('click', wordZoomIn);
const wordZoomOutBtn = document.getElementById('word-zoom-out-btn');
if (wordZoomOutBtn) wordZoomOutBtn.addEventListener('click', wordZoomOut);

// -- Ctrl and the wheel zoom, while a plain wheel keeps the native vertical scrolling --
(function bindWordWheelZoom() {
  const el = document.getElementById('word-viewer-content');
  if (!el) return;
  el.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;          // ,
    e.preventDefault();
    if (e.deltaY < 0) wordZoomIn(); else wordZoomOut();
  }, { passive: false });
})();

// )
window.addEventListener('keydown', function (e) {
  if (!e.ctrlKey) return;
  const wrap = document.getElementById('word-viewer-wrap');
  if (!wrap || !wrap.classList.contains('show')) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); wordZoomIn(); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); wordZoomOut(); }
  else if (e.key === '0') { e.preventDefault(); wordZoomReset(); }
});

// )
document.querySelectorAll('#word-viewer-wrap .pv-cdot').forEach(function (el) {
  el.addEventListener('click', function () {
    wordPenColor = el.dataset.c || wordPenColor;
    document.querySelectorAll('#word-viewer-wrap .pv-cdot').forEach(function (x) {
      x.classList.toggle('active', x === el);
    });
  });
});

// -- Esc leaves the drawing mode --
window.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && wordTool) setWordTool(null);
});

// -- clear all annotations --
const wordClearAnnotBtn = document.getElementById('word-clear-annot-btn');
if (wordClearAnnotBtn) wordClearAnnotBtn.addEventListener('click', function () {
  if (!wordAnnotReady) return;
  if (!Object.keys(wordAnnots).length) return;
  if (confirm('Clear all annotations in the current Word ??')) {
    wordAnnots = {};
    wordPathCache = {};
    wordDrawing = null;
    if (wordRedrawTimer) { clearTimeout(wordRedrawTimer); wordRedrawTimer = null; }
    wordPages.forEach(function (sec, i) { drawWordPageAnnots(i); });
    persistDocumentInk('word');
  }
});

// 
function printWordDoc() {
  const content = document.getElementById('word-viewer-content');
  if (!content || !content.innerHTML || !content.innerHTML.trim()) {
    showTableError('Nothing available to print Word Content, Open a document first. ');
    return;
  }
  // ,
  const clone = content.cloneNode(true);
  (clone.querySelectorAll('.wv-annot-canvas') || []).forEach(function (cv) {
    if (cv.parentNode) cv.parentNode.removeChild(cv);
  });
  let f = document.getElementById('word-print-frame');
  if (!f) {
    f = document.createElement('iframe');
    f.id = 'word-print-frame';
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(f);
  }
  f.srcdoc = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Print</title></head><body style="margin:0;">' + clone.innerHTML + '</body></html>';
  f.onload = () => {
    try {
      f.contentWindow.focus();
      f.contentWindow.print();
    } catch (e) {
      showTableError('Print failed:  ' + e.message);
    }
  };
}

// -- print button binding --
const wordPrintBtn = document.getElementById('word-print-btn');
if (wordPrintBtn) wordPrintBtn.addEventListener('click', printWordDoc);

// ============================================================
// )
// the structure: right-click a group header for new folder or import Excel, right-click a folder for new subfolder, import Excel, rename or delete;
// ,
// ============================================================
const excelFileInput = document.getElementById('excel-file-input');
const subitemsTestData = document.getElementById('subitems-testdata');
const headerTestData = document.getElementById('header-testdata');
state.testData = state.testData || {};
let tdFileCounter = 0;
let tdFolderCounter = 0;
let pendingTestDataFolder = null;   // )
let pendingTdFolderNew = null;      // )
let pendingRenameTdFolder = null;   // modal 重命名文件夹的目标 {node, cur}
let pendingRenameTdFile = null;     // modal 重命名文件的目标 {node, cur}
let tvShowFormula = false;          // )

// right-click the test data management group header
if (headerTestData) {
  headerTestData.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    pendingTestDataFolder = null;   // 分组头右键 → 导入到根目录
    ctxContext = { type: 'testdata', target: headerTestData };
    filterCtxMenu('testdata');
    showCtxMenu(e.clientX, e.clientY);
  });
}

// 
const ctxImportExcel = document.getElementById('ctx-import-excel');
if (ctxImportExcel) {
  ctxImportExcel.addEventListener('click', async (e) => {
    e.stopPropagation();
    hideCtxMenu();
    if (excelFileInput) {
      if (!await guardImportPointDraw('Importing Excel')) return;
      excelFileInput.value = '';
      excelFileInput.click();
    }
  });
}

// 
const ctxNewTestDataFolder = document.getElementById('ctx-new-testdata-folder');
if (ctxNewTestDataFolder) {
  ctxNewTestDataFolder.addEventListener('click', (e) => {
    e.stopPropagation();
    const { type, target } = ctxContext;
    hideCtxMenu();
    pendingTdFolderNew = (type === 'testdata-folder' && target) ? target : null;
    openReportFolderDialog('testdata-folder-new', 'New folder', 'New folder name: ', 'New folder');
  });
}

// 
const ctxOpenExcel = document.getElementById('ctx-open-excel');
if (ctxOpenExcel) {
  ctxOpenExcel.addEventListener('click', (e) => {
    e.stopPropagation();
    const { type, target } = ctxContext;
    hideCtxMenu();
    if (type === 'testdata-file' && target) openExcelSheetByNode(target, null);
  });
}

// folder node
function buildTestDataFolderNode(name) {
  tdFolderCounter++;
  const folderId = 'tdfolder-' + tdFolderCounter;
  return '' +
    '<div class="lp-sub-item has-children" data-role="testdata-folder" data-folder-id="' + folderId + '">' +
      '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
      '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="#a371f7" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>' +
      '<span>' + escapeHtml(name) + '</span>' +
    '</div>' +
    '<div class="lp-nested-items expanded"></div>';
}

// folder node
function addTestDataFolderNode(name, parentNode) {
  let target = subitemsTestData;
  if (parentNode) {
    const nested = parentNode.nextElementSibling;
    if (nested && nested.classList.contains('lp-nested-items')) target = nested;
  }
  if (!target) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = buildTestDataFolderNode(name);
  while (tmp.firstChild) target.appendChild(tmp.firstChild);
  bindTestDataContextMenus(subitemsTestData);
}

// )
function renameTestDataFolderNode(folderNode) {
  const span = folderNode.querySelector('span');
  if (!span) return;
  pendingRenameTdFolder = { node: folderNode, cur: span.textContent };
  openReportFolderDialog('testdata-folder-rename', 'Rename folder', 'Rename folder: ', span.textContent);
}

function applyTdFolderRename(obj, newName) {
  if (!obj || !obj.node) return;
  const span = obj.node.querySelector('span');
  if (span) span.textContent = newName;
}

// ,
function deleteTestDataFolderNode(folderNode) {
  const nested = folderNode.nextElementSibling;
  const allFiles = nested ? nested.querySelectorAll('.lp-sub-item[data-testdata-id]') : [];
  const subFolders = nested ? nested.querySelectorAll('[data-role="testdata-folder"]') : [];
  const name = (folderNode.querySelector('span') || {}).textContent || 'This folder';
  if (allFiles.length > 0 && !confirm('Delete this folder?“ ' + name + ' ”and its ' + allFiles.length + ' files??')) return;
  if (allFiles.length === 0 && subFolders.length > 0 && !confirm('Delete this folder?“ ' + name + ' ”and its ' + subFolders.length + ' subfolders??')) return;
  if (allFiles.length === 0 && subFolders.length === 0 && !confirm('Delete this folder?“ ' + name + ' ”??')) return;
  allFiles.forEach(fn => closeTestDataFileTags(fn));
  folderNode.remove();
  if (nested) nested.remove();
}

// close every open table tab of a test data file, clear the state and release the blob URL
function closeTestDataFileTags(fileNode) {
  const id = fileNode.getAttribute('data-testdata-id');
  const t = state.testData[id];
  if (t) {
    Array.from(tabViewers.entries()).forEach(([tid, v]) => {
      if (v.type === 'table' && v.testDataId === id) closeTab(tid);
    });
    if (t.url) { try { URL.revokeObjectURL(t.url); } catch (err) {} }
  }
  delete state.testData[id];
}

// )
function addTestDataFileNode(file, wb, folderNode) {
  if (!subitemsTestData) return null;
  const id = 'tdfile-' + (++tdFileCounter);
  const folderId = folderNode ? folderNode.getAttribute('data-folder-id') : null;
  const sheetNames = (wb && wb.SheetNames) ? wb.SheetNames.slice() : [];
  const isExcel = sheetNames.length > 0;
  const url = URL.createObjectURL(file);
  state.testData[id] = {
    id: id,
    fileName: file.name,
    filePath: getFilePath(file),   // )
    size: file.size,
    folder: folderId,
    url: url,
    wb: wb || null,
    sheetNames: sheetNames,
    isExcel: isExcel
  };
  const node = document.createElement('div');
  node.className = 'lp-sub-item' + (isExcel && sheetNames.length > 1 ? ' has-children' : '');
  node.setAttribute('data-testdata-id', id);
  node.innerHTML =
    (isExcel && sheetNames.length > 1
      ? '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>'
      : '') +
    '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="#a371f7" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><path d="M9 15h6M9 18h4"></path></svg>' +
    '<span>' + escapeHtml(file.name) + '</span>';
  // )
  let target = subitemsTestData;
  if (folderNode) {
    const nested = folderNode.nextElementSibling;
    if (nested && nested.classList.contains('lp-nested-items')) target = nested;
  }
  target.appendChild(node);

  // )
  if (isExcel && sheetNames.length > 1) {
    const nestedDiv = document.createElement('div');
    nestedDiv.className = 'lp-nested-items expanded';
    sheetNames.forEach(sn => {
      const si = document.createElement('div');
      si.className = 'lp-sub-item';
      si.setAttribute('data-sheet-name', sn);
      si.innerHTML =
        '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="#8b949e" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>' +
        '<span>' + escapeHtml(sn) + '</span>';
      si.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openExcelSheetByNode(node, sn);
      });
      nestedDiv.appendChild(si);
    });
    target.appendChild(nestedDiv);
  }
  bindTestDataContextMenus(subitemsTestData);
  return node;
}

// bind the context menu of the folders and file nodes inside test data management
function bindTestDataContextMenus(root) {
  if (!root) return;
  // folder node
  const folderItems = root.querySelectorAll('[data-role="testdata-folder"]');
  folderItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    item.addEventListener('click', (e) => {
      if (e.defaultPrevented) return;
      toggleNode(item);
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pendingTestDataFolder = item;
      ctxContext = { type: 'testdata-folder', target: item };
      filterCtxMenu('testdata-folder');
      showCtxMenu(e.clientX, e.clientY);
    });
  });
  // )
  const fileItems = root.querySelectorAll('.lp-sub-item[data-testdata-id]');
  fileItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    const nxt = item.nextElementSibling;
    if (nxt && nxt.classList.contains('lp-nested-items')) {
      item.addEventListener('click', (e) => {
        if (e.defaultPrevented) return;
        toggleNode(item);
      });
    }
    item.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openExcelSheetByNode(item, null);
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxContext = { type: 'testdata-file', target: item };
      filterCtxMenu('testdata-file');
      showCtxMenu(e.clientX, e.clientY);
    });
  });
}
bindTestDataContextMenus(subitemsTestData);

// 
if (excelFileInput) {
  excelFileInput.addEventListener('change', async () => {
    const files = Array.from(excelFileInput.files || []);
    excelFileInput.value = '';
    if (files.length === 0) return;
    const folderNode = pendingTestDataFolder;
    pendingTestDataFolder = null;
    let ok = 0;
    let bad = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      showImportLoading('Importing“ ' + file.name + '」(' + (i + 1) + '/' + files.length + ')...');
      await new Promise(r => setTimeout(r, 20));
      try {
        let wb = null;
        if (['xlsx', 'xlsm', 'xlsb', 'xls'].indexOf(ext) !== -1) {
          // )
          const buf = await file.arrayBuffer();
  await ensureDocumentLibrary('excel');
          wb = await XLSX.read(buf, { type: 'array', cellDates: true });
        } else if (['csv', 'txt', 'tsv'].indexOf(ext) !== -1) {
          // text files: parse UTF-8 into a two-dimensional array
          const buf = await file.arrayBuffer();
          const text = new TextDecoder('utf-8').decode(buf);
          wb = { SheetNames: [], __plainRows: parseCsvText(text) };
        }
        if (!wb) throw new Error('Unsupported file format: . ' + ext);
        addTestDataFileNode(file, wb, folderNode);
        ok++;
      } catch (err) {
        bad++;
        console.warn('[Import test data]', file.name, err);
      }
    }
    hideImportLoading();
    if (bad > 0) showTableError('Import complete: Success ' + ok + ' items, ' + bad + ' files could not be parsed. ');
  });
}

// )
function openExcelSheetByNode(fileNode, sheetName) {
  const id = fileNode.getAttribute('data-testdata-id');
  const t = state.testData[id];
  if (!t) return;
  if (!t.isExcel) {
    openTestDataTable(t, null);
    return;
  }
  const target = sheetName || (t.sheetNames && t.sheetNames[0]) || null;
  if (!target) return;
  // the state
  const nxt = fileNode.nextElementSibling;
  if (nxt && nxt.classList.contains('lp-nested-items') && !nxt.classList.contains('expanded')) {
    nxt.classList.add('expanded');
    fileNode.classList.remove('collapsed');
  }
  openTestDataTable(t, target);
}

// )
function openTestDataTable(t, sheetName) {
  const base = t.fileName.replace(/\.[^.]+$/, '');
  const label = sheetName ? (base + '-' + sheetName) : t.fileName;
  const existing = Array.from(tabViewers.entries()).find(([tid, v]) =>
    v.type === 'table' && v.testDataId === t.id &&
    (v.testDataSheet || null) === (sheetName || null)
  );
  if (existing) {
    window.switchTab(existing[0]);
    return;
  }
  const html = buildTestDataTableHtml(t, sheetName);
  const dims = getTestDataTableDims(t, sheetName);
  window.createNewTab('table', {
    testDataId: t.id,
    testDataSheet: sheetName || null,
    tableName: label,
    tableHtml: html,
    tableRows: dims.rows,
    tableCols: dims.cols,
    tableHasFormula: dims.hasFormula
  });
}

// 
function fmtExcelCell(v) {
  if (v === undefined || v === null) return '';
  const s0 = String(v);
  if (s0 === '') return '';
  const t = s0.trim();
  if (!/^[-+]?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/.test(t)) return s0;  // 非数值文本原样
  if (/^[-+]?\d+$/.test(t)) return t;                                    // 整数原样
  const num = parseFloat(t);
  if (!isFinite(num)) return s0;
  const abs = Math.abs(num);
  if (abs !== 0 && (abs < 1e-6 || abs >= 1e15)) return s0;               // 极小/极大保持原文
  let s = num.toPrecision(6);
  if (/[eE]/.test(s)) s = num.toFixed(6);                                 // 消除意外指数
  s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return (s === '-0') ? '0' : s;
}

// -- official SheetJS cell dates become display text --
function fmtExcelDate(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  const y = d.getFullYear(), mo = d.getMonth() + 1, da = d.getDate();
  const h = d.getHours(), mi = d.getMinutes(), se = d.getSeconds();
  if (h === 0 && mi === 0 && se === 0) return y + '/' + mo + '/' + da;
  return y + '/' + mo + '/' + da + ' ' + p(h) + ':' + p(mi) + ':' + p(se);
}

// -- official SheetJS worksheet to the internal v1.1.3 compatible structure --
// the official !merges and the cell addresses are all 0-based, while the internal rendering convention is:
// ,
// merges: the row indices s.r and e.r are 1-based and the column indices s.c and e.c are 0-based
// formulas: [Excel row number (1-based)] = { column (0-based): the formula source }
// ,
// ,
function sheetToFullCompat(ws) {
  if (!ws) return { rows: [], formulas: {}, merges: [], cols: [], maxC: 0 };
  if (ws.__compatFull) return ws.__compatFull;
  const rows = [];
  const formulas = {};
  const merges = [];
  const cols = Array.isArray(ws['!cols']) ? ws['!cols'] : [];
  const mergesSrc = Array.isArray(ws['!merges']) ? ws['!merges'] : [];
  for (let i = 0; i < mergesSrc.length; i++) {
    const m = mergesSrc[i];
    if (!m || !m.s || !m.e) continue;
    merges.push({ s: { r: m.s.r + 1, c: m.s.c }, e: { r: m.e.r + 1, c: m.e.c } });
  }
  let maxC = 0;
  for (const key in ws) {
    if (key.length < 2 || key.charCodeAt(0) === 33) continue;   // 跳过 !ref / !merges 等系统字段
    const cell = ws[key];
    if (!cell || typeof cell !== 'object') continue;
    let addr = null;
    try { addr = XLSX.utils.decode_cell(key); } catch (e) { continue; }
    while (rows.length <= addr.r) rows.push([]);
    let v = cell.v;
    if (v instanceof Date) v = fmtExcelDate(v);
    else if (typeof v === 'boolean') v = v ? 'TRUE' : 'FALSE';
    else if (typeof v === 'number' && !isFinite(v)) v = String(v);
    rows[addr.r][addr.c] = v;
    if (addr.c + 1 > maxC) maxC = addr.c + 1;
    if (cell.f) {
      if (!formulas[addr.r + 1]) formulas[addr.r + 1] = {};
      formulas[addr.r + 1][addr.c] = cell.f;
    }
  }
  const out = { rows: rows, formulas: formulas, merges: merges, cols: cols, maxC: maxC };
  try { ws.__compatFull = out; } catch (e) {}
  return out;
}

// )
function excelRowNumericRatio(row) {
  if (!row) return 0;
  let tot = 0, num = 0;
  for (let c = 0; c < row.length; c++) {
    const v = row[c];
    if (v === '' || v === null || v === undefined) continue;
    tot++;
    if (/^[-+]?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/.test(String(v).trim())) num++;
  }
  return tot ? (num / tot) : 0;
}

// )
// ,
// ,
function buildTestDataTableHtml(t, sheetName) {
  let data = null;
  let formulas = {}, merges = [], cols = [];
  if (t.isExcel && t.wb && sheetName) {
    const ws = t.wb.Sheets[sheetName];
    if (ws) {
      const full = sheetToFullCompat(ws);
      data = full.rows;
      formulas = full.formulas || {};
      merges = full.merges || [];
      cols = full.cols || [];
    }
  } else if (!t.isExcel && t.wb && t.wb.__plainRows) {
    data = t.wb.__plainRows;
  }
  if (!data || data.length === 0) {
    return '<p style="color:#656d76;text-align:center;padding:40px;">Table is empty</p>';
  }
  // )
  merges.forEach(m => {
    const tl = (data[m.s.r - 1] && data[m.s.r - 1][m.s.c] !== undefined) ? data[m.s.r - 1][m.s.c] : '';
    if (tl === '' || tl === null || tl === undefined) return;
    for (let rr = m.s.r; rr <= m.e.r; rr++) {
      const row = data[rr - 1];
      if (!row) continue;
      for (let cc = m.s.c; cc <= m.e.c; cc++) {
        if (rr === m.s.r && cc === m.s.c) continue;                       // 左上角本就有值
        if (row[cc] === '' || row[cc] === null || row[cc] === undefined) row[cc] = tl;
      }
    }
  });
  // ,
  let firstIdx = 0;
  while (firstIdx < data.length) {
    const row = data[firstIdx];
    let has = false;
    if (row) for (let c = 0; c < row.length; c++) { if (row[c] !== '' && row[c] !== null && row[c] !== undefined) { has = true; break; } }
    if (has) break;
    firstIdx++;
  }
  if (firstIdx >= data.length) {
    return '<p style="color:#656d76;text-align:center;padding:40px;">Table is empty</p>';
  }
  // )
  // 1) locate the start of the data area by the first row of a tall vertical merge band of three rows or more, so everything above it is a title or header
  // ,
  // )
  const bandStarts = [];
  merges.forEach(m => { if (m.e.r > m.s.r && (m.e.r - m.s.r + 1) >= 3) bandStarts.push(m.s.r); });
  let dataStartRow = bandStarts.length ? Math.min.apply(null, bandStarts) : 0;
  if (!dataStartRow) {
    for (let i = firstIdx; i < data.length; i++) {
      if (excelRowNumericRatio(data[i]) >= 0.5) { dataStartRow = i + 1; break; }
    }
  }
  if (!dataStartRow) dataStartRow = firstIdx + 2;   // 首条内容行为表头
  // ,
  const skip = new Set();
  merges.forEach(m => {
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r === m.s.r && c === m.s.c) continue;
        skip.add(r + ':' + c);
      }
    }
  });
  const mergeAt = (r, c) => {
    for (let i = 0; i < merges.length; i++) {
      const m = merges[i];
      if (r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c) return m;
    }
    return null;
  };
  // )
  const px = (wch) => Math.max(40, Math.round((wch || 8) * 7.2));
  const maxC = data.reduce((m, row) => Math.max(m, row ? row.length : 0), 0);
  const lastExcelRow = data.length;   // rows 保留全部行号 → data.length == __maxRow
  let html = '<table>';
  for (let excelRow = firstIdx + 1; excelRow <= lastExcelRow; excelRow++) {
    const row = data[excelRow - 1] || [];
    // ,
    let anyVisible = false;
    for (let c = 0; c < maxC; c++) {
      if (skip.has(excelRow + ':' + c)) continue;
      const v = (row[c] !== undefined) ? row[c] : '';
      if (v !== '' && v !== null) { anyVisible = true; break; }
    }
    if (!anyVisible) continue;
    const isHeaderRow = excelRow < dataStartRow;
    html += '<tr>';
    for (let c = 0; c < maxC; c++) {
      if (skip.has(excelRow + ':' + c)) continue;
      const m = mergeAt(excelRow, c);
      const rs = m ? Math.max(1, m.e.r - m.s.r + 1) : 1;
      const cs = m ? Math.max(1, m.e.c - m.s.c + 1) : 1;
      const raw = (row[c] !== undefined) ? row[c] : '';
      const f = (formulas[excelRow] && formulas[excelRow][c] !== undefined) ? formulas[excelRow][c] : null;
      const w = cols[c] ? px(cols[c].wch) : '';
      const tag = isHeaderRow ? 'th' : 'td';
      html += '<' + tag +
        (rs > 1 ? ' rowspan="' + rs + '"' : '') +
        (cs > 1 ? ' colspan="' + cs + '"' : '') +
        (w ? ' style="min-width:' + w + 'px;"' : '') +
        (f ? ' data-f="' + escapeHtml(f) + '" data-v="' + escapeHtml(String(raw)) + '"' : '') +
        '>' + escapeHtml(String(fmtExcelCell(raw))) + '</' + tag + '>';
    }
    html += '</tr>';
  }
  html += '</table>';
  return html;
}

// )
function getTestDataTableDims(t, sheetName) {
  if (t.isExcel && t.wb && sheetName) {
    const ws = t.wb.Sheets[sheetName];
    if (ws) {
      const full = sheetToFullCompat(ws);
      const hasFormula = !!full.formulas && Object.keys(full.formulas).length > 0;
      return { rows: full.rows.length, cols: full.maxC || 0, hasFormula: hasFormula };
    }
  } else if (!t.isExcel && t.wb && t.wb.__plainRows) {
    return { rows: t.wb.__plainRows.length, cols: (t.wb.__plainRows[0] ? t.wb.__plainRows[0].length : 0), hasFormula: false };
  }
  return { rows: 0, cols: 0, hasFormula: false };
}

// 
function renameTestDataFileNode(fileNode) {
  const id = fileNode.getAttribute('data-testdata-id');
  const t = state.testData[id];
  if (!t) return;
  const span = fileNode.querySelector('span');
  const cur = span ? span.textContent : t.fileName;
  pendingRenameTdFile = { node: fileNode, cur: cur };
  openReportFolderDialog('testdata-file-rename', 'Rename file', 'Rename file (The original file content is unchanged) : ', cur);
}

function applyTdFileRename(obj, newName) {
  if (!obj || !obj.node) return;
  const fileNode = obj.node;
  const id = fileNode.getAttribute('data-testdata-id');
  const t = state.testData[id];
  if (!t) return;
  const span = fileNode.querySelector('span');
  if (span) span.textContent = newName;
  t.fileName = newName;
  // )
  const newBase = newName.replace(/\.[^.]+$/, '');
  Array.from(tabViewers.entries()).forEach(([tid, v]) => {
    if (v.type === 'table' && v.testDataId === id) {
      v.tableName = v.testDataSheet ? (newBase + '-' + v.testDataSheet) : newName;
      const tabEl = document.querySelector('.center-tab[data-tab-id="' + tid + '"]');
      if (tabEl) {
        const lbl = tabEl.querySelector('.center-tab-label');
        if (lbl) lbl.textContent = v.tableName;
        tabEl.title = v.tableName;
      }
      if (activeTabId === tid) {
        const tvTitle = document.getElementById('tv-title');
        if (tvTitle) tvTitle.textContent = v.tableName;
      }
    }
  });
}

// 
function exportTestDataFileNode(fileNode) {
  const id = fileNode.getAttribute('data-testdata-id');
  const t = state.testData[id];
  if (!t || !t.url) return;
  const a = document.createElement('a');
  a.href = t.url;
  a.download = t.fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// 
function deleteTestDataFileNode(fileNode) {
  const id = fileNode.getAttribute('data-testdata-id');
  const t = state.testData[id];
  const name = t ? t.fileName : 'This file';
  if (!confirm('Delete this file?“ ' + name + ' ”??')) return;
  closeTestDataFileTags(fileNode);
  fileNode.remove();
}

// 
const tvFormulaBtn = document.getElementById('tv-formula-btn');
if (tvFormulaBtn) {
  tvFormulaBtn.addEventListener('click', () => {
    tvShowFormula = !tvShowFormula;
    tvFormulaBtn.classList.toggle('on', tvShowFormula);
    tvFormulaBtn.textContent = tvShowFormula ? 'Show values' : 'Show formulas';
    applyFormulaView(tvShowFormula);
  });
}

// switch the display of every formula cell in the table according to the toggle state
function applyFormulaView(showFormula) {
  const content = document.getElementById('table-viewer-content');
  if (!content) return;
  content.querySelectorAll('td[data-f], th[data-f]').forEach(cell => {
    const f = cell.getAttribute('data-f');
    const v = cell.getAttribute('data-v');
    if (showFormula) {
      cell.textContent = '=' + f;
      cell.classList.add('formula-cell');
    } else {
      cell.textContent = v;
      cell.classList.remove('formula-cell');
    }
  });
}

// ============================================================
// )
// ,
// ,
// ============================================================
let pdfDoc = null;          // 当前 PDF 文档对象
let pdfPageNum = 1;         // 当前页码
let pdfScale = 1.5;         // )
let pdfRenderTask = null;   // )
let pdfLoadGeneration = 0;
let currentPdfUrl = '';     // )
let pdfAutoScrollBottom = false; // )
let pdfWheelLock = 0;       // )
const PDF_WHEEL_THROTTLE = 300; // )
let pdfAnnots = {};         // ,
let pdfTool = null;         // 当前标注工具：'pen' | 'highlight' | 'eraser' | null
let pdfPenColor = '#e24b4a';// 画笔颜色
let pdfDrawing = null;      // 绘制中的笔画
let pdfRedrawPending = false; // rAF 节流标记

function pdfReady() {
  return !!(window.pdfjsLib && pdfDoc);
}

// ============================================================
// ,
// ============================================================
let docCtxMenuEl = null;
let lastSelText = '';      // )

function ensureDocCtxMenu() {
  if (docCtxMenuEl) return docCtxMenuEl;
  docCtxMenuEl = document.createElement('div');
  docCtxMenuEl.id = 'doc-ctx-menu';
  docCtxMenuEl.className = 'doc-ctx-menu';
  document.body.appendChild(docCtxMenuEl);
  return docCtxMenuEl;
}
function hideDocCtxMenu() { if (docCtxMenuEl) docCtxMenuEl.classList.remove('show'); }

function getSelectionTextIn(host) {
  if (!window.getSelection) return '';
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
  const r = sel.getRangeAt(0);
  if (host && r.commonAncestorContainer && !host.contains(r.commonAncestorContainer)) return '';
  return String(sel.toString() || '').replace(/\s+/g, ' ').trim();
}

function showDocCtxMenu(x, y, items) {
  const el = ensureDocCtxMenu();
  let html = '';
  items.forEach(function (it) {
    html += '<div class="doc-ctx-item" data-act="' + it.act + '">' + escapeBrief(it.label) + '</div>';
  });
  el.innerHTML = html;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.classList.add('show');
  requestAnimationFrame(function () {
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) el.style.left = Math.max(8, window.innerWidth - r.width - 8) + 'px';
    if (r.bottom > window.innerHeight - 8) el.style.top = Math.max(8, window.innerHeight - r.height - 8) + 'px';
  });
}

function activateRightPanelTabSafe(name) {
  if (window.setRightPanelGroup) window.setRightPanelGroup('doc');
  if (window.activateRightPanelTab) window.activateRightPanelTab(name);
}

function handleDocCtxAction(act) {
  const q = lastSelText || '';
  if (act === 'copy') {
    if (q && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(q).catch(function () { /* ignore it when the clipboard is not permitted*/ });
    }
    return;
  }
  if (act === 'tag') {
    const nm = q.length > 20 ? q.slice(0, 20) + '…' : (q || 'Untitled tab');
    const bm = addDocBookmark(nm, q, { anchor: q });
    if (bm) activateRightPanelTabSafe('Bookmarks');
    return;
  }
  if (act === 'tagpage') {
    const loc = (docCtx.type === 'pdf') ? docCurrentLocation() : null;
    const nm = (docCtx.type === 'pdf') ? ('No. ' + loc + ' Page') : 'Current position';
    const bm = addDocBookmark(nm, '', { loc: loc });
    if (bm) activateRightPanelTabSafe('Bookmarks');
    return;
  }
}

function bindReaderContextMenu(hostId, type) {
  const host = document.getElementById(hostId);
  if (!host) return;
  host.addEventListener('contextmenu', function (e) {
    if (docCtx.type !== type) return;          // 只在对应阅读器激活时接管
    const sel = getSelectionTextIn(host);
    lastSelText = sel;
    const short = sel ? (sel.length > 14 ? sel.slice(0, 14) + '…' : sel) : '';
    const items = sel
      ? [{ act: 'tag', label: 'Add bookmark: “ ' + short + '”' }, { act: 'copy', label: 'Copy selected text' }]
      : [{ act: 'tagpage', label: (type === 'pdf') ? 'Bookmark the current page' : 'Bookmark the current position' }];
    e.preventDefault();
    e.stopPropagation();
    showDocCtxMenu(e.clientX, e.clientY, items);
  });
}

(function initReaderContextMenu() {
  bindReaderContextMenu('pdf-viewer-content', 'pdf');
  bindReaderContextMenu('word-viewer-content', 'word');
  document.addEventListener('mousedown', function (e) {
    if (!docCtxMenuEl || !docCtxMenuEl.classList.contains('show')) return;
    if (e.target && e.target.closest && e.target.closest('#doc-ctx-menu')) return;
    hideDocCtxMenu();
  }, true);
  document.addEventListener('click', function (e) {
    if (!docCtxMenuEl || !docCtxMenuEl.classList.contains('show')) return;
    const it = (e.target && e.target.closest) ? e.target.closest('.doc-ctx-item') : null;
    hideDocCtxMenu();
    if (!it) return;
    handleDocCtxAction(it.dataset.act);
  });
  window.addEventListener('blur', hideDocCtxMenu);
})();

// ============================================================
// )
// ,
// the stacking order: canvas below the text layer (z-index 1) below the annotation layer (z-index 20)
// ============================================================
let pdfTextLayerTask = null;
function syncPdfTextLayerPointer() {
  const layer = document.getElementById('pdf-text-layer');
  if (!layer) return;
  layer.style.pointerEvents = (typeof pdfTool !== 'undefined' && pdfTool) ? 'none' : 'auto';
}
function clearPdfTextLayer() {
  const layer = document.getElementById('pdf-text-layer');
  if (!layer) return;
  if (pdfTextLayerTask) {
    try { if (pdfTextLayerTask.cancel) pdfTextLayerTask.cancel(); } catch (e) { /* ignore*/ }
  }
  pdfTextLayerTask = null;
  layer.innerHTML = '';
}
async function renderPdfTextLayer(page, viewport) {
  const layer = document.getElementById('pdf-text-layer');
  if (!layer) return;
  clearPdfTextLayer();
  // PDF.js uses this CSS variable for each span's font size and position.
  // Use CSS viewport scale, never the high-DPI canvas render scale.
  layer.style.setProperty('--scale-factor', String(viewport.scale));
  // ,
  alignPdfTextLayerToCanvas();
  if (typeof pdfjsLib === 'undefined' || !pdfjsLib || typeof pdfjsLib.renderTextLayer !== 'function') return;
  const p = perfBegin('PDF Text layer rendering');
  try {
    // ,
    const src = (typeof page.streamTextContent === 'function') ? page.streamTextContent() : (await page.getTextContent());
    pdfTextLayerTask = pdfjsLib.renderTextLayer({
      textContentSource: src,
      container: layer,
      viewport: viewport,
      textDivs: []
    });
    await pdfTextLayerTask.promise;
    pdfTextLayerTask = null;
    // ,
    alignPdfTextLayerToCanvas();
  } catch (e) {
    if (!e || e.name !== 'RenderingCancelledException') console.warn('[PDF Text layer]', e);
  }
  perfEnd(p, layer.childNodes.length + ' text nodes');
  syncPdfTextLayerPointer();
}

// ,
function alignPdfTextLayerToCanvas() {
  const canvas = document.getElementById('pdf-canvas');
  const layer = document.getElementById('pdf-text-layer');
  const wrap = document.getElementById('pdf-canvas-wrap');
  if (!canvas || !layer || !wrap) return;
  const cw = canvas.offsetWidth || parseFloat(canvas.style.width) || 0;
  const ch = canvas.offsetHeight || parseFloat(canvas.style.height) || 0;
  if (!cw || !ch) return;
  const cr = canvas.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  layer.style.width = cw + 'px';
  layer.style.height = ch + 'px';
  layer.style.left = (cr.left - wr.left + wrap.scrollLeft) + 'px';
  layer.style.top = (cr.top - wr.top + wrap.scrollTop) + 'px';
}

async function loadPdfIntoViewer(url) {
  try{await ensureDocumentLibrary('pdf');}catch(error){window.showTabModal({title:'PDF Unable to load the parsing library',label:escapeHtml(error.message)});return;}
  const generation = ++pdfLoadGeneration;
  const canvas = document.getElementById('pdf-canvas');
  if (!canvas) return;
  if (!window.pdfjsLib) {
    document.getElementById('pdf-canvas-wrap').innerHTML =
      '<div class="pdf-hint">Not found pdf.js Engine (lib/pdfjs/pdf.min.js) <br>Please pdf.min.js and pdf.worker.min.js Place in lib/pdfjs/ folder and reopen. </div>';
    return;
  }
  let data = null;
  const pfRead = perfBegin('PDF File reading');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.arrayBuffer();
    perfEnd(pfRead, (data ? (data.byteLength / 1024).toFixed(1) : '0') + ' KB');
  } catch (e) {
    perfEnd(pfRead, 'Failed');
    showTableError('PDF Read failed:  ' + e.message);
    return;
  }
  if (generation !== pdfLoadGeneration || docCtx.type !== 'pdf' || docCtx.url !== url) return;
  clearPdfTextLayer();
  setDocProgress(true, 15);
  await yieldFrame();
  const pfParse = perfBegin('PDF Parse getDocument');
  try {
    const loadedDocument = await pdfjsLib.getDocument({ data: data }).promise;
    if (generation !== pdfLoadGeneration || docCtx.type !== 'pdf' || docCtx.url !== url) { loadedDocument.destroy().catch(()=>{}); return; }
    pdfDoc = loadedDocument;
    perfEnd(pfParse, (pdfDoc && pdfDoc.numPages) ? (pdfDoc.numPages + ' Page') : 'Complete');
  } catch (e) {
    perfEnd(pfParse, 'Failed');
    setDocProgress(false, 100);
    showTableError('PDF Parsing failed (The file may be corrupt or encrypted) :  ' + e.message);
    return;
  }
  pdfPageNum = 1;
  currentPdfUrl = url;
  pdfAnnots = {};      // 新 PDF 重置全部标注
  pdfTool = null;      // 退出绘制模式
  syncPdfAnnotState();
  updatePdfInfo();
  setDocProgress(true, 55);
  const pfFirst = perfBegin('PDF First page rendering (with a text layer) ');
  await renderPdfPage();
  if(docCtx.type==='pdf'&&docCtx.url===url)applyStoredDocumentInk({...docCtx});
  perfEnd(pfFirst, 'Complete');
  if (generation !== pdfLoadGeneration || docCtx.url !== url) return;
  setDocProgress(false, 100);
  // )
  if (docCtx.type === 'pdf' && docCtx.url === url) scheduleEnsureOutline();
}

async function renderPdfPage() {
  const canvas = document.getElementById('pdf-canvas');
  if (!canvas || !pdfReady()) return;
  if (pdfRenderTask) {
    try { pdfRenderTask.cancel(); } catch (e) {}
  }
  try {
    const page = await pdfDoc.getPage(pdfPageNum);
    // ,
    const dpr = window.devicePixelRatio || 1;
    const cssViewport = page.getViewport({ scale: pdfScale });
    const renderViewport = page.getViewport({ scale: pdfScale * dpr });
    canvas.style.width = cssViewport.width + 'px';
    canvas.style.height = cssViewport.height + 'px';
    canvas.width = Math.floor(cssViewport.width * dpr);
    canvas.height = Math.floor(cssViewport.height * dpr);
    const ctx = canvas.getContext('2d');
    pdfRenderTask = page.render({ canvasContext: ctx, viewport: renderViewport });
    await pdfRenderTask.promise;
    pdfRenderTask = null;
    // ,
    await renderPdfTextLayer(page, cssViewport);
  } catch (e) {
    if (e && e.name !== 'RenderingCancelledException') {
      console.warn('[PDF Render]', e);
    }
  }
  // ,
  redrawPdfAnnots();
  const pvcEl = document.getElementById('pdf-viewer-content');
  if (pvcEl) {
    if (pdfAutoScrollBottom) {
      pvcEl.scrollTop = pvcEl.scrollHeight;
      pdfAutoScrollBottom = false;
    } else {
      pvcEl.scrollTop = 0;
    }
  }
  updatePdfTextLayerHint();
  updatePdfInfo();
}

// visible feedback for the text layer state, so that when the text cannot be selected the user does not simply conclude that the click did nothing
function updatePdfTextLayerHint() {
  const hint = document.getElementById('pdf-tool-hint');
  const layer = document.getElementById('pdf-text-layer');
  if (!hint || !layer) return;
  // ,
  if (typeof pdfTool !== 'undefined' && pdfTool) return;
  const n = layer.childNodes.length;
  hint.textContent = n > 0
    ? '✓ Selectable text (Select and copy text directly) '
    : 'No selectable text on this page (This may be a scanned document, Requires OCR) ';
}

function updatePdfInfo() {
  const pi = document.getElementById('pdf-page-info');
  if (pi) pi.textContent = pdfDoc ? pdfPageNum + ' / ' + pdfDoc.numPages : '- / -';
  const zi = document.getElementById('pdf-zoom-info');
  if (zi) zi.textContent = Math.round(pdfScale * 100) + '%';
}

function pdfPrevPage() {
  if (pdfReady() && pdfPageNum > 1) { pdfPageNum--; renderPdfPage(); }
}
function pdfNextPage() {
  pdfAutoScrollBottom = false; // 翻下一页默认从页首开始看
  if (pdfReady() && pdfPageNum < pdfDoc.numPages) { pdfPageNum++; renderPdfPage(); }
}
function pdfZoomIn() {
  if (pdfScale < 4) { pdfScale = Math.min(4, Math.round((pdfScale + 0.2) * 10) / 10); renderPdfPage(); }
}
function pdfZoomOut() {
  if (pdfScale > 0.4) { pdfScale = Math.max(0.4, Math.round((pdfScale - 0.2) * 10) / 10); renderPdfPage(); }
}

// toolbar button bindings
const pdfPrevBtn = document.getElementById('pdf-prev-btn');
if (pdfPrevBtn) pdfPrevBtn.addEventListener('click', pdfPrevPage);
const pdfNextBtn = document.getElementById('pdf-next-btn');
if (pdfNextBtn) pdfNextBtn.addEventListener('click', pdfNextPage);
const pdfZoomInBtn = document.getElementById('pdf-zoom-in-btn');
if (pdfZoomInBtn) pdfZoomInBtn.addEventListener('click', pdfZoomIn);
const pdfZoomOutBtn = document.getElementById('pdf-zoom-out-btn');
if (pdfZoomOutBtn) pdfZoomOutBtn.addEventListener('click', pdfZoomOut);

// ============================================================
// the PDF wheel turns the page, Ctrl and the wheel zoom, and the tools cover scribbling, highlighting and erasing
// ,
// ,
// ============================================================

// the state
function syncPdfAnnotState() {
  const ac = document.getElementById('pdf-annot-canvas');
  if (!ac) return;
  ac.style.pointerEvents = pdfTool ? 'auto' : 'none';
  ac.style.cursor = pdfTool === 'eraser' ? 'cell' : 'crosshair';
  // the state
  syncPdfTextLayerPointer();
  const penBtn = document.getElementById('pdf-pen-btn');
  const hlBtn = document.getElementById('pdf-hl-btn');
  const erBtn = document.getElementById('pdf-eraser-btn');
  if (penBtn) penBtn.classList.toggle('active', pdfTool === 'pen');
  if (hlBtn) hlBtn.classList.toggle('active', pdfTool === 'highlight');
  if (erBtn) erBtn.classList.toggle('active', pdfTool === 'eraser');
  const hint = document.getElementById('pdf-tool-hint');
  if (hint) {
    hint.textContent = pdfTool === 'pen' ? 'Pen: Drag on the page to draw, Esc Exit'
      : pdfTool === 'highlight' ? 'Highlight: Drag across content to highlight it, Esc Exit'
      : pdfTool === 'eraser' ? 'Eraser: Drag to erase ink/Highlight, Esc Exit' : '';
  }
}

function setPdfTool(tool) {
  pdfTool = (pdfTool === tool) ? null : tool;
  syncPdfAnnotState();
}

// -- the core of the annotation drawing --
function toPdfPagePt(e, ac) {
  const rect = ac.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / pdfScale,
    y: (e.clientY - rect.top) / pdfScale
  };
}

function drawPdfStroke(ctx, s, scale) {
  const pts = s.points;
  if (!pts.length) return;
  ctx.globalCompositeOperation = (s.type === 'eraser') ? 'destination-out' : 'source-over';
  ctx.strokeStyle = s.type === 'highlight' ? 'rgba(255,235,59,0.45)' : s.color;
  ctx.fillStyle = s.type === 'highlight' ? 'rgba(255,235,59,0.45)' : s.color;
  ctx.lineWidth = Math.max(1, s.width * scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x * scale, pts[0].y * scale, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(pts[0].x * scale, pts[0].y * scale);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * scale, pts[i].y * scale);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function redrawPdfAnnots() {
  const ac = document.getElementById('pdf-annot-canvas');
  const pc = document.getElementById('pdf-canvas');
  if (!ac || !pc || !pdfReady()) return;
  ac.width = pc.width;   // )
  ac.height = pc.height;
  ac.style.width = pc.style.width;   // CSS 显示尺寸与 PDF canvas 一致
  ac.style.height = pc.style.height;
  const ctx = ac.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const strokes = pdfAnnots[pdfPageNum] || [];
  for (const s of strokes) drawPdfStroke(ctx, s, pdfScale * dpr);
  if (pdfDrawing) drawPdfStroke(ctx, pdfDrawing, pdfScale * dpr);
}

function schedulePdfRedraw() {
  if (pdfRedrawPending) return;
  pdfRedrawPending = true;
  requestAnimationFrame(function () {
    pdfRedrawPending = false;
    redrawPdfAnnots();
  });
}

function onPdfAnnotDown(e) {
  const ac = document.getElementById('pdf-annot-canvas');
  if (!ac || !pdfReady() || !pdfTool) return;
  e.preventDefault();
  try { ac.setPointerCapture(e.pointerId); } catch (err) {}
  pdfDrawing = {
    type: pdfTool,
    color: pdfPenColor,
    width: pdfTool === 'highlight' ? 22 : (pdfTool === 'eraser' ? 28 : 3),
    points: [toPdfPagePt(e, ac)]
  };
  schedulePdfRedraw();
}
function onPdfAnnotMove(e) {
  const ac = document.getElementById('pdf-annot-canvas');
  if (!pdfDrawing || !ac) return;
  e.preventDefault();
  pdfDrawing.points.push(toPdfPagePt(e, ac));
  schedulePdfRedraw();
}
function onPdfAnnotUp() {
  if (!pdfDrawing) return;
  if (!pdfAnnots[pdfPageNum]) pdfAnnots[pdfPageNum] = [];
  pdfAnnots[pdfPageNum].push(pdfDrawing);
  persistDocumentInk('pdf');
  pdfDrawing = null;
  redrawPdfAnnots();
}

// -- annotation canvas events --
const pdfAnnotCanvas = document.getElementById('pdf-annot-canvas');
if (pdfAnnotCanvas) {
  pdfAnnotCanvas.addEventListener('pointerdown', onPdfAnnotDown);
  pdfAnnotCanvas.addEventListener('pointermove', onPdfAnnotMove);
  window.addEventListener('pointerup', onPdfAnnotUp);
}

// -- the wheel: Ctrl and the wheel zooms; when the page is not taller than the view it turns the page directly;
// ,
const pdfContentEl = document.getElementById('pdf-viewer-content');
if (pdfContentEl) {
  pdfContentEl.addEventListener('wheel', function (e) {
    if (!pdfReady()) return;
    if (e.ctrlKey) {
      e.preventDefault();
      if (e.deltaY < 0) pdfZoomIn(); else pdfZoomOut();
      return;
    }
    const now = Date.now();
    const canScroll = pdfContentEl.scrollHeight > pdfContentEl.clientHeight + 1;
    if (!canScroll) {
      // ,
      e.preventDefault();
      if (now - pdfWheelLock < PDF_WHEEL_THROTTLE) return;
      pdfWheelLock = now;
      if (e.deltaY < 0) pdfPrevPage(); else pdfNextPage();
      return;
    }
    // when the page is taller than the view, the native scrolling is preferred so that a region can be read, and the page only turns when a boundary is reached and the wheel keeps turning
    const atBottom = pdfContentEl.scrollHeight - pdfContentEl.scrollTop - pdfContentEl.clientHeight < 24;
    const atTop = pdfContentEl.scrollTop <= 0;
    if (e.deltaY > 0 && atBottom) {
      if (now - pdfWheelLock < PDF_WHEEL_THROTTLE) { e.preventDefault(); return; }
      e.preventDefault();
      pdfWheelLock = now;
      pdfNextPage();
    } else if (e.deltaY < 0 && atTop) {
      if (now - pdfWheelLock < PDF_WHEEL_THROTTLE) { e.preventDefault(); return; }
      e.preventDefault();
      pdfWheelLock = now;
      pdfAutoScrollBottom = true; // ,
      pdfPrevPage();
    }
    // ,
  }, { passive: false });
}

// -- Esc leaves the drawing mode --
window.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && pdfTool) setPdfTool(null);
});

// -- tool buttons --
const pdfPenBtn = document.getElementById('pdf-pen-btn');
if (pdfPenBtn) pdfPenBtn.addEventListener('click', function () { setPdfTool('pen'); });
const pdfHlBtn = document.getElementById('pdf-hl-btn');
if (pdfHlBtn) pdfHlBtn.addEventListener('click', function () { setPdfTool('highlight'); });
const pdfEraserBtn = document.getElementById('pdf-eraser-btn');
if (pdfEraserBtn) pdfEraserBtn.addEventListener('click', function () { setPdfTool('eraser'); });

// ,
document.querySelectorAll('#pdf-viewer-wrap .pv-cdot').forEach(function (el) {
  el.addEventListener('click', function () {
    pdfPenColor = el.dataset.c || pdfPenColor;
    document.querySelectorAll('#pdf-viewer-wrap .pv-cdot').forEach(function (x) {
      x.classList.toggle('active', x === el);
    });
  });
});

// -- clear all annotations --
const pdfClearAnnotBtn = document.getElementById('pdf-clear-annot-btn');
if (pdfClearAnnotBtn) pdfClearAnnotBtn.addEventListener('click', function () {
  if (!pdfReady()) return;
  if (!Object.keys(pdfAnnots).length) return;
  if (confirm('Clear all annotations in the current PDF ??')) {
    pdfAnnots = {};
    pdfDrawing = null;
    redrawPdfAnnots();
    persistDocumentInk('pdf');
  }
});

// ============================================================
// 3D visualisation of the drillhole data
// the data comes from the collar table, the drillhole survey and the geological information (lithology) imported under the Drillholes group in the project tree
// the trigger is dragging the Drillholes group title onto the 3D canvas
// )
// Three.X = GOCAD_X - ox (east)
// Three.Y = GOCAD_Z - oz (elevation)
// ,
// )
// dip: 0 degrees is horizontal and 90 degrees is straight down; azimuth is measured clockwise from north
// the direction vector in GOCAD: dx = sin(az) * cos(dip), dy = cos(az) * cos(dip), dz = -sin(dip)
// ============================================================

// ============================================================
// ,
// ,
// ============================================================

// HSL to a hex string
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
}

// )
function goldenAngleColor(index) {
  const h = (index * 137.5) % 360;
  return hslToHex(h, 70, 55);
}

// )
function hexToInt(hex) {
  return parseInt(hex.replace('#', ''), 16);
}

// get the lithology colour: if state.lithologyColors is not set, assign colours with the golden angle and cache them
function ensureLithologyColor(name) {
  if (!state.lithologyColors) state.lithologyColors = {};
  if (state.lithologyColors[name]) return state.lithologyColors[name];
  const idx = Object.keys(state.lithologyColors).length;
  const hex = goldenAngleColor(idx);
  state.lithologyColors[name] = hex;
  return hex;
}

const DEFAULT_LITHOLOGY_COLOR = 0x3498DB;    // )

// the project tree
function collectDrillholeTables() {
  const root = document.getElementById('subitems-drillhole');
  if (!root) return { collar: null, survey: null, lithology: null, alteration: null, geochemAttrs: {} };
  const cats = root.querySelectorAll('.lp-sub-item[data-role="table-category"], .lp-sub-item[data-role="geochem-attr-category"]');
  const result = { collar: null, survey: null, lithology: null, alteration: null, geochemAttrs: {} };
  cats.forEach(cat => {
    const name = (cat.querySelector('span') || {}).textContent || '';
    const nested = cat.nextElementSibling;
    if (!nested || !nested.classList.contains('lp-nested-items')) return;
    const fileNode = nested.querySelector('.lp-sub-item[data-table-id]');
    if (!fileNode) return;
    const t = state.tables[fileNode.getAttribute('data-table-id')];
    if (!t) return;
    // the geochemical attribute subcategory is collected by attrClean
    if (t.isGeochemAttr && t.geochemAttrClean) {
      result.geochemAttrs[t.geochemAttrClean] = t;
      return;
    }
    if (name.search(/孔口|Collar/i) >= 0) result.collar = t;
    else if (name.search(/测斜|Survey/i) >= 0) result.survey = t;
    else if (name.search(/蚀变|Alteration/i) >= 0) result.alteration = t;
    else if (name.search(/地质|Geolog/i) >= 0 || name.search(/岩性|Litholog/i) >= 0) result.lithology = t;
  });
  return result;
}

// ,
function findColumnIndex(headers, candidates) {
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i]).trim().toLowerCase();
    for (const c of candidates) {
      if (h === c.toLowerCase() || h.indexOf(c.toLowerCase()) >= 0) return i;
    }
  }
  return -1;
}

// parse the collar table into [{holeid, x, y, z, depth}]
function parseCollarTable(table) {
  if (!table || !table.data || table.data.length < 2) return [];
  const headers = table.data[0];
  const iHole = findColumnIndex(headers, ['holeid', 'hole_id', '孔号', '钻孔号']);
  const iX = findColumnIndex(headers, ['x', 'east', '东']);
  const iY = findColumnIndex(headers, ['y', 'north', '北']);
  const iZ = findColumnIndex(headers, ['z', 'elevation', '高程', '标高']);
  const iDepth = findColumnIndex(headers, ['depth', 'maxdepth', '总深', '深度']);
  const out = [];
  for (let r = 1; r < table.data.length; r++) {
    const row = table.data[r];
    const hid = iHole >= 0 ? String(row[iHole]).trim() : '';
    if (!hid) continue;
    out.push({
      holeid: hid,
      x: parseFloat(iX >= 0 ? row[iX] : 0) || 0,
      y: parseFloat(iY >= 0 ? row[iY] : 0) || 0,
      z: parseFloat(iZ >= 0 ? row[iZ] : 0) || 0,
      depth: parseFloat(iDepth >= 0 ? row[iDepth] : 0) || 0
    });
  }
  return out;
}

// parse the survey table into [{holeid, depth, dip, azimuth}]
function parseSurveyTable(table) {
  if (!table || !table.data || table.data.length < 2) return [];
  const headers = table.data[0];
  const iHole = findColumnIndex(headers, ['holeid', 'hole_id', '孔号']);
  const iDip = findColumnIndex(headers, ['dip', '倾角']);
  const iAz = findColumnIndex(headers, ['azimuth', 'azi', '方位角', '方位']);
  const iDepth = findColumnIndex(headers, ['depth', '深度']);
  const out = [];
  for (let r = 1; r < table.data.length; r++) {
    const row = table.data[r];
    const hid = iHole >= 0 ? String(row[iHole]).trim() : '';
    if (!hid) continue;
    out.push({
      holeid: hid,
      depth: parseFloat(iDepth >= 0 ? row[iDepth] : 0) || 0,
      dip: parseFloat(iDip >= 0 ? row[iDip] : 0) || 0,
      azimuth: parseFloat(iAz >= 0 ? row[iAz] : 0) || 0
    });
  }
  return out;
}

// parse the lithology table into [{holeid, from, to, vein}]
function parseLithologyTable(table) {
  if (!table || !table.data || table.data.length < 2) return [];
  const headers = table.data[0];
  const iHole = findColumnIndex(headers, ['holeid', 'hole_id', '孔号']);
  const iFrom = findColumnIndex(headers, ['from', '起', '起始']);
  const iTo = findColumnIndex(headers, ['to', '止', '终止']);
  const iVein = findColumnIndex(headers, ['vein', 'lithology', '岩性', '矿脉', '类型']);
  const out = [];
  for (let r = 1; r < table.data.length; r++) {
    const row = table.data[r];
    const hid = iHole >= 0 ? String(row[iHole]).trim() : '';
    if (!hid) continue;
    out.push({
      holeid: hid,
      from: parseFloat(iFrom >= 0 ? row[iFrom] : 0) || 0,
      to: parseFloat(iTo >= 0 ? row[iTo] : 0) || 0,
      vein: iVein >= 0 ? String(row[iVein]).trim() : ''
    });
  }
  return out;
}

// parse the geochemical attribute table into [{holeid, from, to, value}]
// the subtable column order is holeid, from, to and the attribute value; the attribute column is located through geochemAttrName or as the last column
function parseGeochemAttrTable(table) {
  if (!table || !table.data || table.data.length < 2) return [];
  const headers = table.data[0] || [];
  const iHole = findColumnIndex(headers, ['holeid', 'hole_id', '孔号']);
  const iFrom = findColumnIndex(headers, ['from', '起', '起始']);
  const iTo = findColumnIndex(headers, ['to', '止', '终止']);
  // )
  let iVal = -1;
  const attrRaw = (table.geochemAttrName || '').trim().toLowerCase();
  if (attrRaw) {
    for (let i = 0; i < headers.length; i++) {
      const hh = String(headers[i] || '').trim().toLowerCase();
      if (hh === attrRaw) { iVal = i; break; }
    }
  }
  if (iVal < 0) iVal = headers.length - 1;
  const out = [];
  for (let r = 1; r < table.data.length; r++) {
    const row = table.data[r];
    if (!row) continue;
    const hid = iHole >= 0 ? String(row[iHole]).trim() : '';
    if (!hid) continue;
    const rawV = row[iVal];
    if (rawV === '' || rawV === null || rawV === undefined) continue;
    const num = Number(String(rawV).replace(/[,，]/g, ''));
    if (isNaN(num) || !isFinite(num)) continue;
    out.push({
      holeid: hid,
      from: parseFloat(iFrom >= 0 ? row[iFrom] : 0) || 0,
      to: parseFloat(iTo >= 0 ? row[iTo] : 0) || 0,
      value: num
    });
  }
  return out;
}

// GOCAD to Three.js coordinate conversion
function gocadToThree(gx, gy, gz, ox, oy, oz) {
  return new THREE.Vector3(gx - ox, gz - oz, oy - gy);
}

// ,
// dip: 0 degrees is horizontal and 90 degrees is straight down; azimuth is measured clockwise from north
function drillholeDirection(dip, azimuth) {
  const dipRad = THREE.MathUtils.degToRad(dip);
  const azRad = THREE.MathUtils.degToRad(azimuth);
  // the GOCAD directions: east is +X, north is +Y and up is +Z
  const gx = Math.sin(azRad) * Math.cos(dipRad);
  const gy = Math.cos(azRad) * Math.cos(dipRad);
  const gz = -Math.sin(dipRad); // 向下为负
  // to Three.js: dThree.X = gx, dThree.Y = gz, dThree.Z = -gy
  return new THREE.Vector3(gx, gz, -gy).normalize();
}

// )
function createSegmentCylinder(start, end, radius, color, opacity) {
  const dir = new THREE.Vector3().subVectors(end, start);
  const len = dir.length();
  if (len < 1e-6) return null;
  const geo = new THREE.CylinderGeometry(radius, radius, len, 12);
  const mat = new THREE.MeshStandardMaterial({
    color: color, transparent: true, opacity: opacity,
    roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(geo, mat);
  // ,
  const up = new THREE.Vector3(0, 1, 0);
  mesh.quaternion.setFromUnitVectors(up, dir.clone().normalize());
  // ,
  mesh.position.copy(start);
  mesh.translateY(len / 2);
  // ,
  mesh.userData.segStart = start.clone();
  mesh.userData.segEnd = end.clone();
  mesh.userData.segLen = len;
  return mesh;
}

// build the drillhole trajectory group
// segment by lithology
// options.useGeochem: true maps the diverging colour scale to the magnitude of the geochemical attribute, in which case it needs
function buildDrillholeGroup(collars, surveys, lithologies, origin, radius, options) {
  const useLithology = !!(options && options.useLithology);
  const useGeochem = !!(options && options.useGeochem);
  const singleColor = (options && options.singleColor !== undefined) ? options.singleColor : 0x1E88E5; // 默认蓝色
  const colormapStops = (options && options.colormapStops) || GEOCHEM_DIVERGING_STOPS;
  const group = new THREE.Group();
  group.name = useGeochem ? 'drillhole-geochem-group' : (useLithology ? 'drillhole-litho-group' : 'drillhole-survey-group');
  const materials = [];
  const lithoTypes = {}; // the legend
  const ox = origin.x, oy = origin.y, oz = origin.z;

  // the survey, lithology and geochem are indexed by holeid
  const surveyMap = {};
  surveys.forEach(s => { (surveyMap[s.holeid] = surveyMap[s.holeid] || []).push(s); });
  const lithoMap = {};
  if (useLithology) lithologies.forEach(l => { (lithoMap[l.holeid] = lithoMap[l.holeid] || []).push(l); });
  const geochemMap = {};
  let geochemMin = Infinity, geochemMax = -Infinity;
  if (useGeochem && lithologies) { // lithologies 复用为 geochem 段数组
    lithologies.forEach(l => {
      (geochemMap[l.holeid] = geochemMap[l.holeid] || []).push(l);
      if (l.value < geochemMin) geochemMin = l.value;
      if (l.value > geochemMax) geochemMax = l.value;
    });
  }
  if (geochemMin === Infinity) { geochemMin = 0; geochemMax = 1; }

  let segCount = 0, holeCount = 0;
  collars.forEach(collar => {
    const survList = surveyMap[collar.holeid];
    if (!survList || survList.length === 0) return;
    const surv = survList[survList.length - 1]; // 直线法：取末端测斜
    const dir = drillholeDirection(surv.dip, surv.azimuth);
    const start = gocadToThree(collar.x, collar.y, collar.z, ox, oy, oz);
    const totalDepth = collar.depth || surv.depth || 0;
    holeCount++;

    if (!useLithology && !useGeochem) {
      // a single blue colour: one cylinder for the whole hole
      const p2 = start.clone().add(dir.clone().multiplyScalar(totalDepth));
      const m = createSegmentCylinder(start, p2, radius, singleColor, 0.95);
      if (m) { m.userData.isDrillhole = true; m.userData.holeid = collar.holeid; m.userData.vein = null; group.add(m); materials.push(m.material); segCount++; }
      return;
    }

    // -- geochem mode: the colour is mapped to the magnitude of the attribute --
    if (useGeochem) {
      const segs = geochemMap[collar.holeid] || [];
      if (segs.length === 0) {
        // )
        const p2 = start.clone().add(dir.clone().multiplyScalar(totalDepth));
        const color = geochemColorInt(0, colormapStops);
        const m = createSegmentCylinder(start, p2, radius, color, 0.95);
        if (m) {
          m.userData.isDrillhole = true;
          m.userData.holeid = collar.holeid;
          m.userData.vein = '__geochem__';
          m.userData.geochemValue = geochemMin;
          group.add(m); materials.push(m.material); segCount++;
        }
        return;
      }
      segs.forEach(seg => {
        const from = Math.max(0, seg.from);
        const to = Math.min(totalDepth, seg.to);
        if (to <= from) return;
        const p1 = start.clone().add(dir.clone().multiplyScalar(from));
        const p2 = start.clone().add(dir.clone().multiplyScalar(to));
        const t = (geochemMax - geochemMin) < 1e-12 ? 0.5 : (seg.value - geochemMin) / (geochemMax - geochemMin);
        const color = geochemColorInt(t, colormapStops);
        const m = createSegmentCylinder(p1, p2, radius, color, 0.95);
        if (m) {
          m.userData.isDrillhole = true;
          m.userData.holeid = collar.holeid;
          m.userData.vein = '__geochem__';
          m.userData.geochemValue = seg.value;
          m.userData.geochemT = t;
          group.add(m);
          materials.push(m.material);
          segCount++;
        }
      });
      return;
    }

    // segment by lithology
    const segs = lithoMap[collar.holeid] || [];
    if (segs.length === 0) {
      // when there is a lithology table but this hole has no records, use the fallback colour for the whole hole
      const p2 = start.clone().add(dir.clone().multiplyScalar(totalDepth));
      const hex = ensureLithologyColor('Uncategorized');
      const color = hexToInt(hex);
      const m = createSegmentCylinder(start, p2, radius, color, 0.95);
      if (m) { m.userData.isDrillhole = true; m.userData.holeid = collar.holeid; m.userData.vein = 'Uncategorized'; group.add(m); materials.push(m.material); segCount++; }
      lithoTypes['Uncategorized'] = color;
      return;
    }
    segs.forEach(seg => {
      const from = Math.max(0, seg.from);
      const to = Math.min(totalDepth, seg.to);
      if (to <= from) return;
      const p1 = start.clone().add(dir.clone().multiplyScalar(from));
      const p2 = start.clone().add(dir.clone().multiplyScalar(to));
      const veinName = seg.vein || 'Uncategorized';
      const hex = ensureLithologyColor(veinName);
      const color = hexToInt(hex);
      const m = createSegmentCylinder(p1, p2, radius, color, 0.95);
      if (m) {
        m.userData.isDrillhole = true;
        m.userData.holeid = collar.holeid;
        m.userData.vein = veinName;
        group.add(m);
        materials.push(m.material);
        segCount++;
      }
      lithoTypes[veinName] = color;
    });
  });
  return { group, materials, segCount, holeCount, lithoTypes, geochemMin, geochemMax };
}

// ============================================================
// )
// segment by lithology
// segment by lithology
// ,
// logic
// )
// the trigger is dragging the matching category node in the project tree onto the 3D canvas
// ============================================================
function buildDrillholeModel(mode, lithoSource, geochemAttrName) {
  const useLithology = (mode === 'lithology');
  const useGeochem = (mode === 'geochem');
  const isAlteration = (lithoSource === 'alteration');
  // 1. collect the tables
  const tables = collectDrillholeTables();
  if (!tables.collar) {
    showTableError('Collar table not found. \n First, in"Drillholes"Right-click under the group"Collar Table"Import collar data (Includes holeid/x/y/z/depth Field) . ');
    return;
  }
  if (!tables.survey) {
    showTableError('Survey table not found. \n Import first"Downhole Survey"Table (Includes holeid/dip/azimuth Field) . ');
    return;
  }
  let geochemTable = null;
  let geochemAttrRawName = '';
  if (useLithology) {
    const lithoTable = isAlteration ? tables.alteration : tables.lithology;
    const lithoLabel = isAlteration ? 'Alteration Data' : 'Geological Data';
    if (!lithoTable) {
      showTableError('Not found ' + lithoLabel + ' Tables. \n Import first"' + lithoLabel + ' "Table (Includes holeid/from/to/vein Field) . ');
      return;
    }
  } else if (useGeochem) {
    geochemTable = geochemAttrName ? (tables.geochemAttrs || {})[geochemAttrName] : null;
    if (!geochemTable) {
      const list = Object.keys(tables.geochemAttrs || {});
      showTableError('No geochemical attributes were found: " ' + (geochemAttrName || '') + ' "Tables. \n Attributes imported: ' + (list.length ? list.join('、') : 'None') + '\n First, in"Geochemical Data"category to import an attribute table. ');
      return;
    }
    geochemAttrRawName = geochemTable.geochemAttrName || geochemAttrName;
  }

  // 2. parse it
  const collars = parseCollarTable(tables.collar);
  const surveys = parseSurveyTable(tables.survey);
  let lithologies = [];
  if (useLithology) {
    const lithoTable = isAlteration ? tables.alteration : tables.lithology;
    lithologies = parseLithologyTable(lithoTable);
  } else if (useGeochem) {
    lithologies = parseGeochemAttrTable(geochemTable); // 复用变量：元素为 {holeid,from,to,value}
  }
  if (collars.length === 0) {
    showTableError('The collar table could not be parsed or is empty. \n Check column headers (must include holeid/x/y/z/depth) . ');
    return;
  }
  if (surveys.length === 0) {
    showTableError('The survey table could not be parsed or is empty. \n Check column headers (must include holeid/dip/azimuth) . ');
    return;
  }
  if (useLithology && lithologies.length === 0) {
    const lithoLabel = isAlteration ? 'Alteration Data' : 'Geological Data';
    showTableError(lithoLabel + ' table could not be parsed or is empty. \n Check column headers (must include holeid/from/to/vein) . ');
    return;
  }
  if (useGeochem && lithologies.length === 0) {
    showTableError('Attributes ' + geochemAttrRawName + ' Parsing failed or no valid numeric intervals were found. \n Check column headers (must include holeid/from/to/Value) . ');
    return;
  }

  // ,
  let origin;
  if (state.origin) {
    origin = state.origin;
  } else {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    collars.forEach(c => { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); minZ = Math.min(minZ, c.z); });
    origin = { x: Math.floor(minX / 100) * 100, y: Math.floor(minY / 100) * 100, z: Math.floor(minZ / 100) * 100 };
    state.origin = origin;
    console.log('[Drillholes] Initialize the current tab origin =', origin);
  }

  // ,
  let refDiag = 0;
  const sceneBox = getSceneBoundingBox();
  if (!sceneBox.isEmpty()) {
    refDiag = sceneBox.getSize(new THREE.Vector3()).length();
  } else {
    let bmin = new THREE.Vector3(Infinity, Infinity, Infinity);
    let bmax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    collars.forEach(c => {
      const p = gocadToThree(c.x, c.y, c.z, origin.x, origin.y, origin.z);
      bmin.min(p); bmax.max(p);
    });
    refDiag = bmin.distanceTo(bmax) + collars.reduce((s, c) => s + c.depth, 0);
  }
  const radius = Math.max(0.8, refDiag * 0.0035);

  // ,
  // survey maps to the drillhole survey
  // lithology maps to the drillhole alteration or the drillhole lithology
  // )
  let categoryName;
  if (useGeochem) categoryName = 'Drillhole Geochemistry_ ' + geochemAttrName;
  else if (useLithology) categoryName = isAlteration ? 'Drillhole Alteration' : 'Drillhole Lithology';
  else categoryName = 'Downhole Survey';
  const existing = state.models.find(m => m.category === categoryName);
  if (existing) {
    if (existing.mesh && existing.mesh.parent) existing.mesh.parent.remove(existing.mesh);
    if (existing.mesh) {
      existing.mesh.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
    }
    if (state.selectedModelId === existing.id) clearSelectionState();
    const lmItem = lmList.querySelector('.lm-item[data-model-id="' + existing.id + '"]');
    if (lmItem) lmItem.remove();
    state.models = state.models.filter(m => m.id !== existing.id);
  }

  // 6. build the trajectory mesh
  const singleColor = 0x1E88E5;
  const colormapStops = useGeochem ? getAttrColormapStops(geochemAttrName) : null;
  const buildResult = buildDrillholeGroup(collars, surveys, lithologies, origin, radius, {
    useLithology: useLithology,
    useGeochem: useGeochem,
    singleColor: singleColor,
    colormapStops: colormapStops
  });
  const group = buildResult.group;
  const materials = buildResult.materials;
  const segCount = buildResult.segCount;
  const holeCount = buildResult.holeCount;
  const lithoTypes = buildResult.lithoTypes;
  if (segCount === 0) {
    showTableError('No drillhole intervals could be generated. \n Check the survey data from/to field or holeid Match status. ');
    return;
  }

  // )
  scene.add(group);
  applyIgnoredDrillholes(); // ignore
  if (state.placeholderMesh) {
    scene.remove(state.placeholderMesh);
    state.placeholderMesh.geometry.dispose();
    state.placeholderMesh.material.dispose();
    state.placeholderMesh = null;
    const _ep = document.getElementById('empty-placeholder');
    if (_ep) _ep.classList.add('hidden');
  }

  // the layer management
  const lithoList = Object.keys(lithoTypes).map(name => ({ name: name, color: lithoTypes[name] }));
  let displayName;
  let modelColor;
  if (useGeochem) {
    displayName = 'Drillhole Geochemistry· ' + geochemAttrRawName;
    modelColor = geochemColorInt(0.5, colormapStops); // the legend
  } else if (useLithology) {
    displayName = isAlteration ? 'Drillhole Alteration' : 'Drillhole Lithology';
    modelColor = lithoList.length > 0 ? lithoList[0].color : 0xE67E22;
  } else {
    displayName = 'Downhole Survey';
    modelColor = singleColor;
  }
  const modelObj = {
    id: (useGeochem ? ('drillhole_geochem_' + geochemAttrName + '_')
        : useLithology ? (isAlteration ? 'drillhole_alter_' : 'drillhole_litho_')
        : 'drillhole_survey_') + Date.now(),
    name: displayName,
    category: categoryName,
    mesh: group,
    material: materials[0],
    materials: materials,
    visible: true,
    opacity: 0.95,
    color: modelColor,
    radius: radius,
    fileName: displayName,
    geoMesh: { origin: origin },
    treeFileNode: null,
    inScene: true,
    isDrillhole: true,
    isLithologyDrillhole: useLithology,  // 地质/蚀变：岩性颜色面板
    isGeochemDrillhole: useGeochem,      // 地球化学：色阶设置面板
    geochemAttrName: geochemAttrName,    // )
    geochemAttrRawName: geochemAttrRawName, // )
    geochemMin: buildResult.geochemMin,  // the legend
    geochemMax: buildResult.geochemMax,
    lithologyTypes: lithoList,
    drillholeCount: holeCount
  };
  state.models.push(modelObj);

  // ,
  if (state.clipMode) {
    const planes = getActiveClipPlanes();
    materials.forEach(mt => {
      mt.clippingPlanes = planes;
      mt.clipShadows = planes.length > 0;
      mt.needsUpdate = true;
    });
  }

  // 9. the layer, the legend, the coordinate axes and the camera
  addLayerItem(modelObj);
  updateLegend();
  updateRenderOrder();
  buildAxisLabels();
  fitViewToAll();

  console.log('[' + displayName + ' ] Visualization complete: ' + holeCount + ' drillholes, ' + segCount + ' intervals, Radius=' + radius.toFixed(2));
}

// -- mutual exclusion check: showing one kind of drillhole model excludes the other kinds --
// the rule:
// )
// )
// it returns true when the display can continue and false when the user cancelled
function checkDrillholeMutex(type, attrName) {
  // build the list of models that will be excluded
  const toRemove = [];
  state.models.forEach(m => {
    if (!m.inScene) return;
    if (type === 'geochem') {
      // when a new geochemical display is shown, remove all the drillhole lithology, alteration and other geochemical attributes
      if (m.isLithologyDrillhole) toRemove.push(m);
      if (m.isGeochemDrillhole && m.geochemAttrName !== attrName) toRemove.push(m);
    } else if (type === 'lithology' || type === 'alteration') {
      // when a new geological or alteration display is shown, remove all the geochemical drillholes
      if (m.isGeochemDrillhole) toRemove.push(m);
    }
  });
  if (toRemove.length === 0) return true;

  // build the confirmation dialog
  const removedNames = toRemove.map(m => '· ' + m.fileName).join('\n');
  let warnMsg;
  if (type === 'geochem') {
    warnMsg = 'Geochemical Attributes ( ' + (attrName || '') + ' ) uses a continuous numeric color scale, must not overlap“Drillhole Lithology / Drillhole Alteration / Other geochemical attributes”Show together. \n\n Remove the following items from the 3D view: \n' + removedNames + '\n\n Continue??';
  } else {
    warnMsg = '「' + (type === 'alteration' ? 'Drillhole Alteration' : 'Drillhole Lithology') + ' ”uses discrete category colors, must not overlap“Drillholes colored by geochemical attributes”Show together. \n\n Remove the following items from the 3D view: \n' + removedNames + '\n\n Continue??';
  }
  const ok = confirm(warnMsg);
  if (!ok) return false;
  // the user confirms and the excluded models are removed
  toRemove.forEach(m => removeModelFromView(m));
  return true;
}

// segment by lithology
function visualizeSurveyOnly() { buildDrillholeModel('survey'); }

// segment by lithology
function visualizeLithologyDrillholes() {
  if (!checkDrillholeMutex('lithology')) return;
  buildDrillholeModel('lithology');
}

// logic
function visualizeAlterationDrillholes() {
  if (!checkDrillholeMutex('alteration')) return;
  buildDrillholeModel('lithology', 'alteration');
}

// dragging a geochemical attribute subcategory maps the diverging colour scale to the magnitude of the attribute, with a gradient legend and the scale settings
function visualizeGeochemDrillholes(attrClean, attrRawName) {
  if (!checkDrillholeMutex('geochem', attrClean)) return;
  buildDrillholeModel('geochem', null, attrClean);
}

// ============================================================
// )
// the trigger is dragging the collar table category node in the project tree onto the 3D canvas
// ============================================================
function visualizeCollarPoints() {
  // 1. collect the collar table
  const tables = collectDrillholeTables();
  if (!tables.collar) {
    showTableError('Collar table not found. \n First, in"Drillholes"Right-click under the group"Collar Table"Import collar data (Includes holeid/x/y/z Field) . ');
    return;
  }

  // 2. parse it
  const collars = parseCollarTable(tables.collar);
  if (collars.length === 0) {
    showTableError('The collar table could not be parsed or is empty. \n Check the column headers (must include holeid/x/y/z) . ');
    return;
  }

  // ,
  let origin;
  if (state.origin) {
    origin = state.origin;
  } else {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    collars.forEach(c => { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); minZ = Math.min(minZ, c.z); });
    origin = { x: Math.floor(minX / 100) * 100, y: Math.floor(minY / 100) * 100, z: Math.floor(minZ / 100) * 100 };
    state.origin = origin;
    console.log('[Collar points] Initialize the current tab origin =', origin);
  }

  // )
  let refDiag = 0;
  const sceneBox = getSceneBoundingBox();
  if (!sceneBox.isEmpty()) {
    refDiag = sceneBox.getSize(new THREE.Vector3()).length();
  } else {
    let bmin = new THREE.Vector3(Infinity, Infinity, Infinity);
    let bmax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    collars.forEach(c => {
      const p = gocadToThree(c.x, c.y, c.z, origin.x, origin.y, origin.z);
      bmin.min(p); bmax.max(p);
    });
    refDiag = bmin.distanceTo(bmax);
  }
  const pointRadius = Math.max(1.5, refDiag * 0.006);
  const labelScale = Math.max(8, refDiag * 0.028);

  // ,
  const existing = state.models.find(m => m.category === 'Drillhole Collars');
  if (existing) {
    if (existing.mesh && existing.mesh.parent) existing.mesh.parent.remove(existing.mesh);
    if (existing.mesh) {
      existing.mesh.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) { if (obj.material.map) obj.material.map.dispose(); obj.material.dispose(); }
      });
    }
    if (state.selectedModelId === existing.id) clearSelectionState();
    const lmItem = lmList.querySelector('.lm-item[data-model-id="' + existing.id + '"]');
    if (lmItem) lmItem.remove();
    state.models = state.models.filter(m => m.id !== existing.id);
  }

  // )
  const group = new THREE.Group();
  group.name = 'collar-points-group';
  const materials = [];
  const pointColor = 0xE53935; // 红色孔口点

  collars.forEach(c => {
    const p = gocadToThree(c.x, c.y, c.z, origin.x, origin.y, origin.z);
    // the collar spheres
    const sphereGeo = new THREE.SphereGeometry(pointRadius, 16, 16);
    const sphereMat = new THREE.MeshStandardMaterial({
      color: pointColor, transparent: true, opacity: 0.95,
      roughness: 0.4, metalness: 0.1
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.position.copy(p);
    sphere.userData.isCollarPoint = true;
    sphere.userData.holeid = c.holeid;
    group.add(sphere);
    materials.push(sphereMat);
    // ,
    const label = makeLabelSprite(c.holeid, labelScale, '#1565C0');
    label.position.copy(p).add(new THREE.Vector3(0, pointRadius * 2.4, 0));
    label.material.depthTest = false;
    label.renderOrder = 999;
    // ,
    label.userData.isCollarLabel = true;
    label.userData.holeid = c.holeid;
    label.userData.labelScale = labelScale;
    label.userData.basePos = p.clone();
    label.userData.offsetY = pointRadius * 2.4;
    group.add(label);
  });

  // )
  scene.add(group);
  applyIgnoredDrillholes(); // ignore
  if (state.placeholderMesh) {
    scene.remove(state.placeholderMesh);
    state.placeholderMesh.geometry.dispose();
    state.placeholderMesh.material.dispose();
    state.placeholderMesh = null;
    const _ep = document.getElementById('empty-placeholder');
    if (_ep) _ep.classList.add('hidden');
  }

  // the layer management
  const modelObj = {
    id: 'collar_' + Date.now(),
    name: 'Drillhole Collars',
    category: 'Drillhole Collars',
    mesh: group,
    material: materials[0],
    materials: materials,           // )
    visible: true,
    opacity: 0.95,
    color: pointColor,
    labelColor: '#1565C0',          // )
    pointRadius: pointRadius,       // the collar spheres
    labelScale: labelScale,         // 标签缩放
    fileName: 'Drillhole Collars',
    geoMesh: { origin: origin },
    treeFileNode: null,
    inScene: true,
    isCollarPoints: true,
    drillholeCount: collars.length
  };
  state.models.push(modelObj);

  // the collar spheres
  if (state.clipMode) {
    const planes = getActiveClipPlanes();
    materials.forEach(mt => {
      mt.clippingPlanes = planes;
      mt.clipShadows = planes.length > 0;
      mt.needsUpdate = true;
    });
  }

  // 9. the layer, the legend, the coordinate axes and the camera
  addLayerItem(modelObj);
  updateLegend();
  updateRenderOrder();
  buildAxisLabels();
  fitViewToAll();

  console.log('[Drillhole Collars] Visualization complete:  ' + collars.length + ' collar points, Radius=' + pointRadius.toFixed(2));
}

// ============================================================
// )
// the collar spheres
// the layer management
// ============================================================
const POINT_PALETTE = [0xE85D75, 0x2ECC71, 0xF39C12, 0x9B59B6, 0x1ABC9C, 0xE74C3C, 0x3498DB];
let pointPaletteIdx = 0;

const headerPoint = document.getElementById('header-point');
const subitemsPoint = document.getElementById('subitems-point');
const pointFileInput = document.getElementById('point-file-input');
let pendingPointCategory = null;
state.pointLayers = state.pointLayers || {};
// )
let activePointLayerId = null;
// ,
state.pointOrder = state.pointOrder || [];

// 
// )
// 
// ,
const POINT_BASE_HEADERS = ['holeid', 'x', 'y', 'z'];
const POINT_BASE_LABELS = { holeid: 'Hole ID', x: 'Easting X', y: 'Northing Y', z: 'Elevation Z' };

// Section 64: the fixed geometry columns are identified by column name rather than by column position.
// ,
// )
// ,
// ,
// after the user deletes a column the semantic order of the rows and the headers is misaligned
// on save, autoCols = headers.slice(4) then cuts in the wrong place
// after a restart the geometry columns are not found by name, so the collars come out empty and the coordinates are zero
// the property panel
// ,
function _pointGeoNameList(headers) {
  return Array.isArray(headers) ? headers : POINT_BASE_HEADERS;
}
// ,
function isPointGeoHeader(name) {
  const n = String(name == null ? '' : name).trim().toLowerCase();
  if (!n) return false;
  return ['holeid', 'hole_id', '孔号', '钻孔号', 'x', 'east', '东坐标', '东',
          'y', 'north', '北坐标', '北', 'z', 'elevation', '高程', '标高'].indexOf(n) >= 0;
}
// )
function isPointGeoCol(headers, c) {
  const hd = _pointGeoNameList(headers);
  return isPointGeoHeader(hd[c]);
}
// )
function countPointGeoCols(headers) {
  const hd = _pointGeoNameList(headers);
  let n = 0;
  for (let i = 0; i < hd.length; i++) { if (isPointGeoHeader(hd[i])) n++; }
  return n;
}
// )
function pointCustomColIndexes(headers) {
  const hd = _pointGeoNameList(headers);
  const out = [];
  for (let i = 0; i < hd.length; i++) { if (!isPointGeoHeader(hd[i])) out.push(i); }
  return out;
}
// list the header names of all the custom attribute columns
function pointCustomColNames(headers) {
  const hd = _pointGeoNameList(headers);
  return pointCustomColIndexes(hd).map(i => String(hd[i] == null ? '' : hd[i]).trim()).filter(Boolean);
}
// Section 64: move the geometry columns to the front and keep the attribute columns in their original relative order.
// )
// the effect: first, autoCols no longer depends on the fragile assumption that the geometry columns are the first four;
// second, the downstream rendering and export convention that the first N columns are the geometry columns holds again;
// .
function normalizePointColumnOrder(headers, rows) {
  const hd = (headers || []).slice();
  const rs = (rows || []).map(r => r.slice());
  const geoNames = ['holeid', 'x', 'y', 'z'];
  const geoIdx = [], taken = new Set(), outHeaders = [], map = [];
  // )
  geoNames.forEach(gn => {
    for (let i = 0; i < hd.length; i++) {
      if (taken.has(i)) continue;
      const h = String(hd[i] == null ? '' : hd[i]).trim().toLowerCase();
      if (h === gn || (gn === 'holeid' && (h === 'hole_id' || h === '孔号' || h === '钻孔号'))
          || (gn === 'x' && (h === 'east' || h === '东坐标' || h === '东'))
          || (gn === 'y' && (h === 'north' || h === '北坐标' || h === '北'))
          || (gn === 'z' && (h === 'elevation' || h === '高程' || h === '标高'))) {
        taken.add(i); map.push(i); outHeaders.push(hd[i]); break;
      }
    }
  });
  // second, the remaining columns are appended in their original relative order
  for (let i = 0; i < hd.length; i++) {
    if (taken.has(i)) continue;
    taken.add(i); map.push(i); outHeaders.push(hd[i]);
  }
  // ,
  const outRows = rs.map(r => {
    const nr = [];
    for (let k = 0; k < map.length; k++) {
      const v = r[map[k]];
      nr.push(v === undefined || v === null ? '' : v);
    }
    return nr;
  });
  return { headers: outHeaders, rows: outRows };
}

function makePointCategoryId() { return 'point_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }

// ,
function makeUniquePointCategoryName(base) {
  const b = base || 'New point category';
  const taken = new Set();
  (state.pointOrder || []).forEach(id => {
    const L = state.pointLayers[id];
    if (L && L.name) taken.add(L.name);
  });
  if (subitemsPoint) {
    subitemsPoint.querySelectorAll('[data-role="point-category"] .lp-label').forEach(n => {
      if (n.textContent) taken.add(n.textContent);
    });
  }
  if (!taken.has(b)) return b;
  for (let i = 2; i < 10000; i++) {
    const cand = b + i;
    if (!taken.has(cand)) return cand;
  }
  return b + '_' + Date.now();
}

// )
function createPointCategory(name, opts) {
  opts = opts || {};
  const id = opts.id || makePointCategoryId();
  const origin = state.origin || { x: 0, y: 0, z: 0 };
  // ,
  const wanted = (name && name.trim()) ? name.trim() : 'New point category';
  const finalName = opts.id ? wanted : makeUniquePointCategoryName(wanted);
  const layer = {
    id: id, name: finalName, regionId: window.researchRegions?.currentId, fileName: '', filePath: null,
    headers: POINT_BASE_HEADERS.slice(),   // ,
    rows: [], data: [],
    collars: [], attrs: {},
    origin: { x: origin.x, y: origin.y, z: origin.z },
    color: POINT_PALETTE[pointPaletteIdx++ % POINT_PALETTE.length],
    colorAttr: null, colorScheme: 'blue-red',
    isEmptyCategory: true,   // 标记：尚未落任何点
    autoCols: [],            // )
    colsLocked: false        // 是否已锁定列结构
  };
  state.pointLayers[id] = layer;
  if (state.pointOrder.indexOf(id) < 0) state.pointOrder.push(id);
  addPointNode(layer);
  // ,
  activePointLayerId = id;
  return layer;
}

// )
function removePointCategory(id) {
  const layer = state.pointLayers[id];
  if (!layer) return;
  const model = state.models.find(m => m.isPointLayer && m.pointLayerId === id);
  if (model) {
    if (model.mesh) {
      model.mesh.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      scene.remove(model.mesh);
    }
    const li = lmList.querySelector('.lm-item[data-model-id="' + model.id + '"]');
    if (li) li.remove();
    state.models = state.models.filter(m => m.id !== model.id);
  }
  const node = subitemsPoint.querySelector('[data-point-id="' + id + '"]');
  if (node) node.remove();
  delete state.pointLayers[id];
  state.pointOrder = state.pointOrder.filter(x => x !== id);
  if (activePointLayerId === id) activePointLayerId = null;
  try { updateLegend(); } catch (e) {}
}

// ,
function getActivePointCategory() {
  if (activePointLayerId && state.pointLayers[activePointLayerId]) return state.pointLayers[activePointLayerId];
  return null;
}

// -- colour gradient tools --
function __pcLerp(a, b, t) { return Math.round(a + (b - a) * t); }
function __pcRgbToHex(r, g, b) { return '#' + [r, g, b].map(x => ('0' + Math.max(0, Math.min(255, Math.round(x))).toString(16)).slice(-2)).join(''); }
function pointColorGradient(scheme, t) {
  t = Math.max(0, Math.min(1, t));
  const S = {
    'blue-red': [[49, 130, 189], [165, 0, 38]],
    'red-blue': [[165, 0, 38], [49, 130, 189]],
    'green-orange': [[34, 139, 34], [255, 140, 0]],
    'viridis': [[68, 1, 84], [253, 231, 37]]
  };
  const s = S[scheme] || S['blue-red'];
  return __pcRgbToHex(__pcLerp(s[0][0], s[1][0], t), __pcLerp(s[0][1], s[1][1], t), __pcLerp(s[0][2], s[1][2], t));
}

// 
function sheetToRows(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
}

// 
// ,
// .
// returns: Promise<{ rows, sheetName } | null>
let _sheetPickResolve = null;

function pickExcelSheet(fileName, sheetNames, wb) {
  return new Promise((resolve) => {
    if (sheetNames.length <= 1) {
      resolve({ rows: sheetToRows(wb.Sheets[sheetNames[0]]), sheetName: sheetNames[0] || '' });
      return;
    }
    const modal = document.getElementById('sheet-pick-modal');
    const sel = document.getElementById('sheet-pick-select');
    const hint = document.getElementById('sheet-pick-hint');
    const prev = document.getElementById('sheet-pick-preview');
    if (!modal || !sel) {
      // ,
      resolve({ rows: sheetToRows(wb.Sheets[sheetNames[0]]), sheetName: sheetNames[0] });
      return;
    }
    if (hint) hint.textContent = '「' + fileName + ' ”Includes ' + sheetNames.length + ' worksheets, Select one to import: ';
    sel.innerHTML = sheetNames.map((n, i) =>
      '<option value="' + escapeHtml(String(i)) + '">' + escapeHtml(n) + '</option>').join('');
    const refreshPrev = () => {
      if (!prev) return;
      const i = parseInt(sel.value, 10) || 0;
      const ws = wb.Sheets[sheetNames[i]];
      let rows = [];
      try { rows = sheetToRows(ws) || []; } catch (e) { rows = []; }
      const empty = rows.length < 2;
      prev.textContent = empty
        ? '⚠ The worksheet is empty or contains insufficient data 2 Rows'
        : 'Total ' + (rows.length - 1) + ' data rows, ' + ((rows[0] || []).length) + ' Columns' +
          '　First row: ' + (rows[0] || []).slice(0, 6).join(' / ');
      prev.style.color = empty ? '#d32f2f' : '#888';
    };
    sel.onchange = refreshPrev;
    refreshPrev();
    modal.classList.add('show');

    _sheetPickResolve = (chosenIdx) => {
      modal.classList.remove('show');
      _sheetPickResolve = null;
      if (chosenIdx == null) { resolve(null); return; }        // 跳过该文件
      const ws = wb.Sheets[sheetNames[chosenIdx]];
      resolve({ rows: sheetToRows(ws), sheetName: sheetNames[chosenIdx] });
    };
    document.getElementById('sheet-pick-ok').onclick = () => {
      const i = parseInt(sel.value, 10) || 0;
      if (_sheetPickResolve) _sheetPickResolve(i);
    };
    document.getElementById('sheet-pick-cancel').onclick = () => {
      if (_sheetPickResolve) _sheetPickResolve(null);
    };
  });
}

// 
// .
async function readPointFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (EXCEL_EXTS.indexOf(ext) !== -1) {
    await ensureDocumentLibrary('excel');if (typeof checkXlsxAvailable !== 'function' || !checkXlsxAvailable()) throw new Error('Excel Parsing library (SheetJS) Not loaded, Save the file as CSV then import');
    const buf = await file.arrayBuffer();
  await ensureDocumentLibrary('excel');
    const wb = await XLSX.read(buf, { type: 'array', cellDates: true });
    if (!wb.SheetNames || !wb.SheetNames.length) throw new Error('Worksheet not found');
    // with several sheets a dropdown is used, with a single sheet there is no interruption
    const picked = await pickExcelSheet(file.name, wb.SheetNames, wb);
    if (!picked) return null;                                  // 用户跳过
    if (!picked.rows || picked.rows.length < 2) throw new Error('Worksheet“ ' + picked.sheetName + ' ”is empty or has insufficient data');
    return picked.rows;
  }
  const buf = await file.arrayBuffer();
  let text;
  if (buf.byteLength >= 3) {
    const b = new Uint8Array(buf, 0, 3);
    if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) text = new TextDecoder('utf-8').decode(new Uint8Array(buf, 3));
    else if (b[0] === 0xFF && b[1] === 0xFE) text = new TextDecoder('utf-16le').decode(new Uint8Array(buf, 2));
    else text = new TextDecoder('utf-8').decode(buf);
  } else { text = new TextDecoder('utf-8').decode(buf); }
  // )
  const _pku8 = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (_pku8[0] === 0x50 && _pku8[1] === 0x4B) {
    await ensureDocumentLibrary('excel');if (typeof checkXlsxAvailable !== 'function' || !checkXlsxAvailable()) throw new Error('\u6587\u4ef6\u5b9e\u4e3a Excel \u4e8c\u8fdb\u5236\uff08\u6269\u5c55\u540d\u5374\u662f .csv\uff09\uff0c\u4e14\u89e3\u6790\u5e93\u672a\u52a0\u8f7d\uff0c\u8bf7\u53e6\u5b58\u4e3a\u6587\u672c CSV');
  await ensureDocumentLibrary('excel');
    const _wb = await XLSX.read(buf, { type: 'array', cellDates: true });
    if (!_wb.SheetNames || !_wb.SheetNames.length) throw new Error('Unable to read worksheets from this file');
    const _picked = await pickExcelSheet(file.name, _wb.SheetNames, _wb);
    if (!_picked) return null;
    return _picked.rows;
  }
  return parseCsvText(text);
}

// -- parse the point file and create an independent point layer --
function importPointLayer(file, rawData) {
  const id = 'point_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const collars = parseCollarTable({ data: rawData });
  if (!collars.length) { showTableError('Point file“ ' + file.name + ' ”Parsing failed: must include holeid/x/y/z The field or data is empty. '); return; }
  const headers = rawData[0] || [];
  const standard = ['holeid', 'x', 'y', 'z'];
  const attrs = {};
  attrs['Elevation(Z)'] = collars.map(c => c.z);
  for (let c = 0; c < headers.length; c++) {
    const h = String(headers[c] || '').trim();
    const hl = h.toLowerCase();
    if (standard.indexOf(hl) >= 0) continue;
    let isNum = true; const vals = [];
    for (let r = 1; r < rawData.length; r++) {
      const v = rawData[r][c];
      if (v === '' || v == null || v === undefined) continue;
      const n = Number(String(v).replace(/[,，]/g, ''));
      if (isNaN(n) || !isFinite(n)) { isNum = false; break; }
      vals.push(n);
    }
    if (isNum && vals.length > 0) attrs[h] = vals;
  }
  let origin = state.origin;
  if (!origin) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    collars.forEach(c => { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); minZ = Math.min(minZ, c.z); });
    origin = { x: Math.floor(minX / 100) * 100, y: Math.floor(minY / 100) * 100, z: Math.floor(minZ / 100) * 100 };
    state.origin = origin;
    console.log('[Point] Initialize the current tab origin =', origin);
  }
  // ,
  // otherwise the layer is left in an invalid intermediate state where it has data but no rows, and as soon as any entry
  // ,
  // ,
  // ,
  // .
  const layer = {
    id: id, name: file.name, fileName: file.name, filePath: (typeof getFilePath === 'function') ? getFilePath(file) : null,
    data: rawData, headers: headers, collars: collars, attrs: attrs, origin: origin,
    color: POINT_PALETTE[pointPaletteIdx++ % POINT_PALETTE.length], colorAttr: null, colorScheme: 'blue-red',
    rows: (rawData && rawData.length > 1) ? rawData.slice(1).map(r => r.slice()) : [],
    autoCols: pointCustomColNames(headers),
    colsLocked: (rawData && rawData.length > 1) ? true : false,
    isEmptyCategory: !(rawData && rawData.length > 1)
  };
  state.pointLayers[id] = layer;
  addPointNode(layer);
  renderPointLayer(layer);
  try { fitViewToAll(); } catch (e) {}
  console.log('[Point] Import complete:  ' + collars.length + ' points, Attribute column=' + Object.keys(attrs).join('/'));
}

// -- the Points node in the project tree --
// ,
function refreshPointNodeLabel(layer) {
  const node = subitemsPoint.querySelector('[data-point-id="' + layer.id + '"]');
  if (!node) return;
  const span = node.querySelector('span');
  if (!span) return;
  const n = (layer.collars && layer.collars.length) || (layer.rows && layer.rows.length) || 0;
  span.textContent = layer.name + (n > 0 ? '（' + n + ' points) ' : ' (Empty) ');
}

function addPointNode(layer) {
  const node = document.createElement('div');
  node.className = 'lp-sub-item';
  node.setAttribute('data-point-id', layer.id);
  node.setAttribute('draggable', 'true');
  const n0 = (layer.collars && layer.collars.length) || (layer.rows && layer.rows.length) || 0;
  const tag = (n0 > 0 ? '（' + n0 + ' points) ' : ' (Empty) ');
  node.innerHTML = '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="#e85d75" stroke-width="2"><circle cx="12" cy="12" r="4"></circle></svg><span>' + escapeHtml(layer.name) + tag + '</span>';
  subitemsPoint.appendChild(node);
  // )
  // ,
  // .
  // ,
  setupNodeDraggable(node, { type: 'point-category', pointId: layer.id });
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    // ,
    ctxContext = { type: 'point-category', target: node, pointId: layer.id };
    filterCtxMenu('point-category');
    showCtxMenu(e.clientX, e.clientY);
  });
  // )
  node.addEventListener('click', () => { activePointLayerId = layer.id; });
}

// -- render the point layer as an independent THREE.Group --
// .
// ,
// .
function renderPointLayer(layer) {
  // )
  const existing0 = state.models.find(m => m.isPointLayer && m.pointLayerId === layer.id);
  const collars = layer.collars;
  if (!collars || !collars.length) {
    if (existing0) {
      if (existing0.mesh) {
        existing0.mesh.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
        scene.remove(existing0.mesh);
      }
      const li0 = lmList.querySelector('.lm-item[data-model-id="' + existing0.id + '"]');
      if (li0) li0.remove();
      state.models = state.models.filter(m => m.id !== existing0.id);
      updateLegend();
    }
    flashPointHint('「' + (layer.name || 'This point category') + ' ”No point data, Unable to display in 3D');
    return;
  }
  const existing = existing0;
  if (existing) {
    if (existing.mesh) {
      existing.mesh.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      scene.remove(existing.mesh);
    }
    const li = lmList.querySelector('.lm-item[data-model-id="' + existing.id + '"]');
    if (li) li.remove();
    state.models = state.models.filter(m => m.id !== existing.id);
  }
  const origin = layer.origin || state.origin;
  let refDiag = 0;
  const sb = getSceneBoundingBox();
  if (sb && !sb.isEmpty()) { refDiag = sb.getSize(new THREE.Vector3()).length(); }
  else {
    let bmin = new THREE.Vector3(Infinity, Infinity, Infinity), bmax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    collars.forEach(c => { const p = gocadToThree(c.x, c.y, c.z, origin.x, origin.y, origin.z); bmin.min(p); bmax.max(p); });
    refDiag = bmin.distanceTo(bmax);
  }
  const pointRadius = Math.max(1.5, refDiag * 0.006);
  const labelScale = Math.max(8, refDiag * 0.028);
  const group = new THREE.Group();
  group.name = 'point-layer-' + layer.id;
  const materials = [];
  const attr = layer.colorAttr;
  let min = Infinity, max = -Infinity;
  if (attr && layer.attrs[attr]) { layer.attrs[attr].forEach(v => { if (v != null) { min = Math.min(min, v); max = Math.max(max, v); } }); if (max <= min) { min = 0; max = 1; } }
  collars.forEach((c, i) => {
    const p = gocadToThree(c.x, c.y, c.z, origin.x, origin.y, origin.z);
    let col = layer.color;
    if (attr && layer.attrs[attr]) {
      const v = layer.attrs[attr][i];
      const t = (max > min) ? ((v - min) / (max - min)) : 0.5;
      col = pointColorGradient(layer.colorScheme || 'blue-red', t);
    }
    const sg = new THREE.SphereGeometry(pointRadius, 16, 16);
    const sm = new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.95, roughness: 0.4, metalness: 0.1 });
    const sphere = new THREE.Mesh(sg, sm);
    sphere.position.copy(p);
    sphere.userData.isPointSphere = true;
    sphere.userData.rowIndex = i;   // ★ 供双击定位到 layer.rows 的哪一行
    sphere.userData.attrValue = (attr && layer.attrs[attr]) ? layer.attrs[attr][i] : undefined;
    group.add(sphere);
    materials.push(sm);
    const label = makeLabelSprite(c.holeid, labelScale, '#1565C0');
    label.position.copy(p).add(new THREE.Vector3(0, pointRadius * 2.4, 0));
    label.material.depthTest = false;
    label.renderOrder = 999;
    label.userData.basePos = p.clone();
    label.userData.offsetY = pointRadius * 2.4;
    group.add(label);
  });
  scene.add(group);
  if (state.placeholderMesh) {
    scene.remove(state.placeholderMesh);
    state.placeholderMesh.geometry.dispose();
    state.placeholderMesh.material.dispose();
    state.placeholderMesh = null;
    const ep = document.getElementById('empty-placeholder');
    if (ep) ep.classList.add('hidden');
  }
  const modelObj = {
    id: 'point_' + layer.id, name: layer.name, category: 'Point', mesh: group,
    material: materials[0], materials: materials, visible: true, opacity: 0.95,
    color: (typeof layer.color === 'number') ? layer.color : 0xE85D75, fileName: layer.name,
    geoMesh: { origin: origin }, treeFileNode: null, inScene: true,
    isCollarPoints: true, isPointLayer: true, pointLayerId: layer.id,
    drillholeCount: collars.length, pointRadius: pointRadius, labelScale: labelScale
  };
  state.models.push(modelObj);
  if (state.clipMode) {
    const planes = getActiveClipPlanes();
    materials.forEach(mt => { mt.clippingPlanes = planes; mt.clipShadows = planes.length > 0; mt.needsUpdate = true; });
  }
  addLayerItem(modelObj);
  updateLegend();
  updateRenderOrder();
  buildAxisLabels();
}

// -- recolour by attribute --
function colorizePointLayer(layerId) {
  const layer = state.pointLayers[layerId];
  if (!layer) return;
  const model = state.models.find(m => m.isPointLayer && m.pointLayerId === layerId);
  if (!model || !model.mesh) return;
  const attr = layer.colorAttr;
  let min = Infinity, max = -Infinity;
  if (attr && layer.attrs[attr]) { layer.attrs[attr].forEach(v => { if (v != null) { min = Math.min(min, v); max = Math.max(max, v); } }); if (max <= min) { min = 0; max = 1; } }
  model.mesh.children.forEach(obj => {
    if (obj.userData && obj.userData.isPointSphere) {
      if (attr && layer.attrs[attr]) {
        const v = obj.userData.attrValue;
        const t = (max > min) ? ((v - min) / (max - min)) : 0.5;
        obj.material.color.set(pointColorGradient(layer.colorScheme || 'blue-red', t));
      } else {
        obj.material.color.setHex(layer.color);
      }
    }
  });
  updateLegend();
}

// -- the colouring dialog --
let _pointColorModel = null;
function openPointColorPanel(model) {
  _pointColorModel = model;
  const layer = state.pointLayers[model.pointLayerId];
  if (!layer) return;
  const sel = document.getElementById('point-color-attr');
  sel.innerHTML = '';
  const o0 = document.createElement('option'); o0.value = ''; o0.textContent = 'Single color (Keep colors) '; sel.appendChild(o0);
  Object.keys(layer.attrs).forEach(k => {
    const o = document.createElement('option'); o.value = k; o.textContent = k + '（' + layer.attrs[k].length + ' values) '; sel.appendChild(o);
  });
  sel.value = layer.colorAttr || '';
  document.getElementById('point-color-scheme').value = layer.colorScheme || 'blue-red';
  document.getElementById('point-color-modal').classList.add('show');
}

// 
// )
// there is currently no call site: the cross in the layer management panel now handles a single model
// .
function deletePointLayer(layerId) {
  const layer = state.pointLayers[layerId];
  if (!layer) return;
  const model = state.models.find(m => m.isPointLayer && m.pointLayerId === layerId);
  if (model) {
    if (model.mesh) {
      model.mesh.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      scene.remove(model.mesh);
    }
    const li = lmList.querySelector('.lm-item[data-model-id="' + model.id + '"]');
    if (li) li.remove();
    state.models = state.models.filter(m => m.id !== model.id);
  }
  const node = subitemsPoint.querySelector('[data-point-id="' + layerId + '"]');
  if (node) node.remove();
  delete state.pointLayers[layerId];
  updateLegend();
}

// 
// ,
let pendingRenamePoint = null;
function renamePointNode(node) {
  const id = node.getAttribute('data-point-id');
  const layer = state.pointLayers[id];
  if (!layer) return;
  pendingRenamePoint = { node: node, id: id };
  openPointCategoryDialog('point-category-rename', 'Rename point category', 'Point category name: ', layer.name);
}
// )
function applyPointRename(node, id, nm) {
  const layer = state.pointLayers[id];
  if (!layer) return;
  const span = node ? node.querySelector('span') : null;
  layer.name = nm;
  if (span) span.textContent = nm;
  refreshPointNodeLabel(layer);
  const m = state.models.find(x => x.isPointLayer && x.pointLayerId === id);
  if (m) {
    m.name = nm; m.fileName = nm;
    const li = lmList.querySelector('.lm-item[data-model-id="' + m.id + '"] .lm-name');
    if (li) li.textContent = nm;
  }
}

// 
// )
// ,
// ,
// ,
// ,
function migrateLegacyPointDepth(layer) {
  if (!layer) return;
  const hd = layer.headers || [];
  if (hd.length <= POINT_BASE_HEADERS.length) return;
  const c4 = String(hd[POINT_BASE_HEADERS.length] || '').trim().toLowerCase();
  if (c4 !== 'depth') return;                       // ,
  hd[POINT_BASE_HEADERS.length] = 'Hole depth(Old)';
  layer.headers = hd;
}

function restorePointLayers(list, order, options) {
  if (!list || !list.length) return;
  list.forEach(saved => {
    const layer = {
      id: saved.id, name: saved.name || 'Point layer', fileName: saved.fileName || '',
      filePath: saved.filePath || null, data: saved.data || [], headers: saved.headers || [],
      collars: saved.collars || [], attrs: saved.attrs || {},
      origin: (saved.origin || state.origin) ? { x: (saved.origin || state.origin).x, y: (saved.origin || state.origin).y, z: (saved.origin || state.origin).z } : null,
      color: (typeof saved.color === 'number') ? saved.color : 0xE85D75,
      colorAttr: saved.colorAttr || null, colorScheme: saved.colorScheme || 'blue-red',
      // )
      autoCols: Array.isArray(saved.autoCols) ? saved.autoCols.slice() : null,
      colsLocked: (typeof saved.colsLocked === 'boolean') ? saved.colsLocked : null,
      isEmptyCategory: !!saved.isEmptyCategory
    };
    if (!layer.collars.length && layer.data.length) layer.collars = parseCollarTable({ data: layer.data });
    layer.rows = (layer.data && layer.data.length > 1) ? layer.data.slice(1) : [];
    // 
    // .
    migrateLegacyPointDepth(layer);
    // ,
    if (!layer.autoCols) {
      layer.autoCols = pointCustomColNames(layer.headers);
    }
    if (layer.colsLocked == null) layer.colsLocked = (layer.rows && layer.rows.length) ? true : !!layer.autoCols.length;
    if (!layer.isEmptyCategory) layer.isEmptyCategory = !((layer.rows && layer.rows.length));
    state.pointLayers[layer.id] = layer;
    addPointNode(layer);
    if (!(options && options.skipScene)) renderPointLayer(layer);
  });
  // ,
  state.pointOrder = Array.isArray(order) ? order.filter(id => state.pointLayers[id]) : [];
  Object.keys(state.pointLayers).forEach(id => { if (state.pointOrder.indexOf(id) < 0) state.pointOrder.push(id); });
  state.pointOrder.forEach(id => {
    const node = subitemsPoint.querySelector('[data-point-id="' + id + '"]');
    if (node) subitemsPoint.appendChild(node);
  });
  if (!(options && options.skipScene)) { try { fitViewToAll(); } catch (e) {} }
}

// 
let pointAddMode = false;
let pointPreviewMesh = null;
let _pdDown = null;
const HAND_LAYER_ID = '__hand_points__';

function getPickablePointOnGeometry(ev) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(scene.children, true);
  for (let i = 0; i < hits.length; i++) {
    const o = hits[i].object;
    if (!o || o.userData.isPreview) continue;
    if (o.isMesh || o.type === 'Mesh') return hits[i].point.clone();
  }
  return null;
}

// )
// ,
function worldToGocad(p) {
  const layer = getActivePointCategory();
  const origin = (layer && layer.origin) || state.origin || { x: 0, y: 0, z: 0 };
  return { gx: p.x + origin.x, gy: origin.y - p.z, gz: p.y + origin.z };
}

// )
function derivePointCollarAttrs(headers, rows) {
  const collars = []; const attrs = {};
  const iH = findColumnIndex(headers, ['holeid', 'hole_id', '孔号', '钻孔号']);
  const iX = findColumnIndex(headers, ['x', 'east', '东']);
  const iY = findColumnIndex(headers, ['y', 'north', '北']);
  const iZ = findColumnIndex(headers, ['z', 'elevation', '高程', '标高']);
  const std = ['holeid', 'x', 'y', 'z'];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const hid = iH >= 0 ? String(r[iH]).trim() : ('PT' + (i + 1));
    if (!hid) continue;
    collars.push({
      holeid: hid,
      x: parseFloat(iX >= 0 ? r[iX] : 0) || 0,
      y: parseFloat(iY >= 0 ? r[iY] : 0) || 0,
      z: parseFloat(iZ >= 0 ? r[iZ] : 0) || 0
    });
  }
  attrs['Elevation(Z)'] = collars.map(c => c.z);
  for (let c = 0; c < headers.length; c++) {
    const h = String(headers[c] || '').trim(); const hl = h.toLowerCase();
    if (std.indexOf(hl) >= 0) continue;
    let isNum = true; const vals = [];
    for (let r = 0; r < rows.length; r++) {
      const v = rows[r][c];
      if (v === '' || v == null) continue;
      const n = Number(String(v).replace(/[,，]/g, ''));
      if (isNaN(n) || !isFinite(n)) { isNum = false; break; }
      vals.push(n);
    }
    if (isNum && vals.length > 0) attrs[h] = vals;
  }
  return { collars, attrs };
}

// )
function ensureHandPointLayer() {
  const act = getActivePointCategory();
  if (act) return act;
  if (state.pointLayers[HAND_LAYER_ID]) return state.pointLayers[HAND_LAYER_ID];
  return createPointCategory('Manual points', { id: HAND_LAYER_ID });
}

function rebuildHandLayer(layer) {
  // ,
  // ,
  // ,
  // .
  let rows = layer.rows;
  if (!rows || !rows.length) {
    rows = (layer.data && layer.data.length > 1) ? layer.data.slice(1) : [];
  }
  layer.rows = rows.map(r => r.slice());
  layer.data = [layer.headers].concat(layer.rows.map(r => r.slice()));
  const d = derivePointCollarAttrs(layer.headers || [], layer.rows || []);
  layer.collars = d.collars;
  layer.attrs = d.attrs;
}

function ensurePointPreview() {
  if (pointPreviewMesh) return pointPreviewMesh;
  let diag = 0; const sb = getSceneBoundingBox();
  if (sb && !sb.isEmpty()) diag = sb.getSize(new THREE.Vector3()).length();
  const r = Math.max(1.2, diag * 0.006);
  const geo = new THREE.SphereGeometry(r, 16, 16);
  const mat = new THREE.MeshBasicMaterial({ color: 0xFFD400, transparent: true, opacity: 0.85 });
  pointPreviewMesh = new THREE.Mesh(geo, mat);
  pointPreviewMesh.userData.isPreview = true;
  pointPreviewMesh.visible = false;
  scene.add(pointPreviewMesh);
  return pointPreviewMesh;
}

// ============================================================
// )
// ,
// references
// ============================================================
let _drawUndoStack = [];   // 已落点的行数组快照
let _drawRedoStack = [];
const DRAW_STACK_MAX = 200;

function resetDrawHistory(layer) {
  _drawUndoStack = [((layer && layer.rows) || []).map(r => r.slice())];
  _drawRedoStack = [];
  refreshDrawBar();
}

function pushDrawHistory(layer) {
  if (!layer) return;
  _drawUndoStack.push(((layer.rows) || []).map(r => r.slice()));
  if (_drawUndoStack.length > DRAW_STACK_MAX) _drawUndoStack.shift();
  _drawRedoStack = [];
  refreshDrawBar();
}

function drawUndo() {
  const layer = getActivePointCategory();
  if (!layer || _drawUndoStack.length <= 1) { flashPointHint('Nothing to undo'); return; }
  _drawRedoStack.push(_drawUndoStack.pop());
  const snap = _drawUndoStack[_drawUndoStack.length - 1];
  layer.rows = snap.map(r => r.slice());
  layer.isEmptyCategory = layer.rows.length === 0;
  rebuildHandLayer(layer);
  renderPointLayer(layer);
  refreshPointNodeLabel(layer);
  refreshDrawBar();
  flashPointHint('Undone, Current ' + layer.rows.length + ' points');
}

function drawRedo() {
  const layer = getActivePointCategory();
  if (!layer || !_drawRedoStack.length) { flashPointHint('Nothing to redo'); return; }
  const snap = _drawRedoStack.pop();
  _drawUndoStack.push(snap.map(r => r.slice()));
  layer.rows = snap.map(r => r.slice());
  layer.isEmptyCategory = layer.rows.length === 0;
  rebuildHandLayer(layer);
  renderPointLayer(layer);
  refreshPointNodeLabel(layer);
  refreshDrawBar();
  flashPointHint('Redone, Current ' + layer.rows.length + ' points');
}

// )
function saveCurrentDrawCategory() {
  const layer = getActivePointCategory();
  try { doSaveProject(true); } catch (err) { console.error('Save failed', err); }
  if (layer) {
    layer.isEmptyCategory = !((layer.rows || []).length);
    refreshPointNodeLabel(layer);
    refreshDrawBar();
    flashPointHint('Saved“ ' + layer.name + '」（' + ((layer.rows || []).length) + ' points) ');
  } else {
    flashPointHint('Project saved');
  }
}

// -- the drawing icon bar on the left: the hover text explains each one --
// ,
let _drawBarTipEl = null;
let _drawBarTipAnchor = null;

function ensureDrawBarTip() {
  if (_drawBarTipEl && document.body.contains(_drawBarTipEl)) return _drawBarTipEl;
  const el = document.createElement('div');
  el.id = 'draw-bar-tip';
  el.innerHTML = '<div class="dbt-title"></div><div class="dbt-desc"></div>';
  document.body.appendChild(el);
  _drawBarTipEl = el;
  return el;
}

// ,
function positionDrawBarTip(anchor) {
  const el = ensureDrawBarTip();
  const r = anchor.getBoundingClientRect();
  // show it first so that the real size can be measured
  el.style.left = '0px'; el.style.top = '0px';
  el.classList.add('show');
  const w = el.offsetWidth || 180;
  const h = el.offsetHeight || 40;
  let left = r.right + 10;
  if (left + w > window.innerWidth - 8) left = r.left - w - 10;
  if (left < 8) left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  const top = Math.min(Math.max(8, r.top + r.height / 2 - h / 2), window.innerHeight - h - 8);
  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(top) + 'px';
}

function showDrawBarTip(item) {
  const el = ensureDrawBarTip();
  const t = el.querySelector('.dbt-title');
  const d = el.querySelector('.dbt-desc');
  if (t) t.textContent = item.getAttribute('data-tip-title') || '';
  if (d) d.textContent = item.getAttribute('data-tip-desc') || '';
  _drawBarTipAnchor = item;
  positionDrawBarTip(item);
}

function hideDrawBarTip() {
  _drawBarTipAnchor = null;
  if (_drawBarTipEl) _drawBarTipEl.classList.remove('show');
}

// ,
function syncDrawBarTip() {
  if (_drawBarTipAnchor && _drawBarTipAnchor.isConnected) showDrawBarTip(_drawBarTipAnchor);
}

(function initDrawBarTips() {
  const bar = document.getElementById('draw-bar');
  if (!bar) return;
  bar.querySelectorAll('[data-tip-title]').forEach((item) => {
    item.addEventListener('mouseenter', () => showDrawBarTip(item));
    item.addEventListener('mouseleave', hideDrawBarTip);
    // keyboard accessibility: the explanation also appears when the item is focused with Tab
    item.addEventListener('focus', () => showDrawBarTip(item));
    item.addEventListener('blur', hideDrawBarTip);
    // ,
    item.addEventListener('click', hideDrawBarTip);
  });
  window.addEventListener('resize', hideDrawBarTip);
  window.addEventListener('scroll', hideDrawBarTip, true);
})();

// ,
function refreshDrawBar() {
  const bar = document.getElementById('draw-bar');
  if (!bar) return;
  if (!pointAddMode) { bar.classList.remove('visible'); hideDrawBarTip(); return; }
  bar.classList.add('visible');

  const layer = getActivePointCategory();
  const catName = layer ? layer.name : ' (No category specified) ';
  const n = layer ? ((layer.rows || []).length) : 0;

  // the status icon puts the category name and the count into the tooltip and shows the number as a badge
  const st = document.getElementById('draw-bar-cat');
  if (st) {
    st.setAttribute('data-tip-title', 'Drawing points · ' + catName);
    st.setAttribute('data-tip-desc',
      'Points placed ' + n + ' items' + (n ? '' : '; Left-click the model surface to place a point'));
  }
  const cnt = document.getElementById('draw-bar-count');
  if (cnt) cnt.textContent = n > 99 ? '99+' : String(n);

  // ,
  const u = document.getElementById('draw-bar-undo');
  const r = document.getElementById('draw-bar-redo');
  const uCan = _drawUndoStack.length > 1;
  const rCan = _drawRedoStack.length > 0;
  if (u) {
    u.disabled = !uCan;
    u.setAttribute('data-tip-desc', uCan
      ? 'Undo last point (Undo available ' + (_drawUndoStack.length - 1) + ' step) '
      : 'No point placement to undo; Left-click the model surface to place a point');
  }
  if (r) {
    r.disabled = !rCan;
    r.setAttribute('data-tip-desc', rCan
      ? 'Redo point placement (Redo available ' + _drawRedoStack.length + ' step) '
      : 'No point placement to redo, First click“Previous step”Available after undo');
  }

  // save and end drawing: the save button tooltip carries the current number of points
  const sv = document.getElementById('draw-bar-save');
  if (sv) sv.setAttribute('data-tip-desc',
    'Apply“ ' + catName + ' ”of ' + n + ' points written to the project' + (n ? '' : ' (No points have been created) '));
  const sp = document.getElementById('draw-bar-stop');
  if (sp) sp.setAttribute('data-tip-desc',
    'Exit drawing mode and save automatically“ ' + catName + ' ”; Right-click the category to export →“Export points CSV”');

  syncDrawBarTip();
}

function setPointAddMode(on) {
  pointAddMode = on;
  const el = document.getElementById('ctx-add-point');
  const sp = el && el.querySelector('span');
  if (sp) sp.textContent = on ? 'Finish point drawing' : 'Draw points';
  if (canvas) canvas.style.cursor = on ? 'crosshair' : '';
  if (on) {
    ensurePointPreview();
    // ,
    resetDrawHistory(getActivePointCategory());
    refreshDrawBar();
  } else {
    if (pointPreviewMesh) pointPreviewMesh.visible = false;
    const bar = document.getElementById('draw-bar');
    if (bar) bar.classList.remove('visible');
    hideDrawBarTip();
    _drawUndoStack = []; _drawRedoStack = [];
  }
  if (!on) {
    const m = document.getElementById('point-add-modal');
    if (m) m.classList.remove('show');
    // ,
    const layer = getActivePointCategory();
    try { doSaveProject(true); } catch (err) { console.error('Unable to save after finishing point drawing', err); }
    if (layer) {
      layer.isEmptyCategory = !((layer.rows || []).length);
      refreshPointNodeLabel(layer);
      const nRows = (layer.rows || []).length;
      flashPointHint('Point drawing finished, “ ' + layer.name + ' ”Saved (Total ' + nRows + ' points) ; Right-click the category to export →“Export points CSV”');
    } else {
      flashPointHint('Point drawing finished');
    }
    activePointLayerId = null;
  }
}

// ,
// ,
function flashTopHint(msg, key) {
  const id = key || 'top-hint';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);background:rgba(20,20,20,.85);color:#fff;padding:8px 14px;border-radius:6px;font-size:13px;z-index:99999;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 1800);
}

// )
function flashDrawingHint(msg) {
  flashTopHint(msg, 'drawing-hint');
}

// )
function flashPointHint(msg) {
  flashTopHint(msg, 'point-hint');
}

// )
function flashBlockHint(msg) {
  flashTopHint(msg, 'block-hint');
}

// the attribute columns section of the dialog renders a dynamic row of column name and value
// ,
function renderPointAttrRows(cols, values, locked) {
  const wrap = document.getElementById('pa-attrs');
  if (!wrap) return;
  wrap.innerHTML = '';
  cols = cols || [];
  if (!cols.length) {
    const tip = document.createElement('div');
    tip.style.cssText = 'font-size:12px;color:#888;padding:4px 0;';
    tip.textContent = locked ? ' (This category has no attribute columns) ' : ' (No attribute columns, Click lower right“＋ Add attribute column”Custom column names and values; The first point defines the attribute columns for this category) ';
    wrap.appendChild(tip);
    return;
  }
  cols.forEach((c, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;align-items:center;';
    const nameIpt = document.createElement('input');
    nameIpt.type = 'text';
    nameIpt.className = 'pa-col-name';
    nameIpt.placeholder = 'Column name';
    nameIpt.value = c || '';
    nameIpt.style.cssText = 'flex:0 0 45%;padding:6px;box-sizing:border-box;font-size:13px;';
    if (locked) { nameIpt.readOnly = true; nameIpt.style.background = '#f2f2f2'; nameIpt.style.color = '#888'; }
    const valIpt = document.createElement('input');
    valIpt.type = 'text';
    valIpt.className = 'pa-col-val';
    valIpt.placeholder = 'Content';
    valIpt.value = (values && values[i] != null) ? String(values[i]) : '';
    valIpt.style.cssText = 'flex:1 1 auto;padding:6px;box-sizing:border-box;font-size:13px;';
    row.appendChild(nameIpt); row.appendChild(valIpt);
    if (!locked) {
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '✕';
      del.title = 'Delete this attribute column';
      del.style.cssText = 'padding:4px 8px;cursor:pointer;font-size:12px;';
      del.addEventListener('click', () => row.remove());
      row.appendChild(del);
    }
    wrap.appendChild(row);
  });
}

function addPointAttrRow(name, value) {
  const wrap = document.getElementById('pa-attrs');
  if (!wrap) return;
  const tip = wrap.querySelector('div[style*="No attribute columns"]');
  if (tip) tip.remove();
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;align-items:center;';
  row.innerHTML = '<input type="text" class="pa-col-name" placeholder="Column name" style="flex:0 0 45%;padding:6px;box-sizing:border-box;font-size:13px;">' +
    '<input type="text" class="pa-col-val" placeholder="Content" style="flex:1 1 auto;padding:6px;box-sizing:border-box;font-size:13px;">' +
    '<button type="button" class="pa-col-del" title="Delete this attribute column" style="padding:4px 8px;cursor:pointer;font-size:12px;">✕</button>';
  row.querySelector('.pa-col-name').value = name || '';
  row.querySelector('.pa-col-val').value = (value != null) ? String(value) : '';
  row.querySelector('.pa-col-del').addEventListener('click', () => row.remove());
  wrap.appendChild(row);
}

// )
function readPointAttrRowsFromModal() {
  const wrap = document.getElementById('pa-attrs');
  const out = [];
  if (!wrap) return out;
  const names = wrap.querySelectorAll('.pa-col-name');
  const vals = wrap.querySelectorAll('.pa-col-val');
  for (let i = 0; i < names.length; i++) {
    const nm = String(names[i].value || '').trim();
    if (!nm) continue;
    out.push({ name: nm, value: String(vals[i] ? vals[i].value : '').trim() });
  }
  return out;
}

// .
function openPointAddModal(gx, gy, gz) {
  const layer = getActivePointCategory();
  if (!layer) { flashPointHint('First, on the left,“Point”right-click a category under →“Draw points”then place points'); return; }
  const idx = (layer.rows ? layer.rows.length : 0) + 1;
  const hid = 'PT' + String(idx).padStart(3, '0');
  document.getElementById('pa-holeid').value = hid;
  document.getElementById('pa-x').value = Math.round(gx * 1000) / 1000;
  document.getElementById('pa-y').value = Math.round(gy * 1000) / 1000;
  document.getElementById('pa-z').value = Math.round(gz * 1000) / 1000;
  document.getElementById('pa-echo').textContent = '';
  // ,
  const ttl = document.querySelector('#point-add-modal .modal-header');
  if (ttl) ttl.textContent = 'Add points manually → ' + layer.name;
  // ,
  const locked = !!layer.colsLocked;
  renderPointAttrRows(locked ? (layer.autoCols || []) : (layer.autoCols || []), [], locked);
  const addBtn = document.getElementById('pa-add-col');
  if (addBtn) addBtn.style.display = locked ? 'none' : '';
  const lockTip = document.getElementById('pa-lock-tip');
  if (lockTip) lockTip.style.display = locked ? '' : 'none';
  document.getElementById('point-add-modal').classList.add('show');
  const fx = document.getElementById('pa-x'); fx.focus(); fx.select();
}

// ,
function prefillLastAttrValues(layer) {
  if (!layer || !layer.colsLocked || !layer.autoCols || !layer.autoCols.length) return;
  const wrap = document.getElementById('pa-attrs');
  if (!wrap) return;
  const vals = wrap.querySelectorAll('.pa-col-val');
  vals.forEach(v => { v.value = ''; });
}

function commitHandPoint() {
  const layer = getActivePointCategory();
  if (!layer) { document.getElementById('point-add-modal').classList.remove('show'); flashPointHint('No point category specified, Canceled'); return; }
  const hid = document.getElementById('pa-holeid').value.trim() || ('PT' + ((layer.rows ? layer.rows.length : 0) + 1));
  const x = parseFloat(document.getElementById('pa-x').value) || 0;
  const y = parseFloat(document.getElementById('pa-y').value) || 0;
  const z = parseFloat(document.getElementById('pa-z').value) || 0;
  const attrs = readPointAttrRowsFromModal();
  // )
  if (!layer.colsLocked) {
    const names = [];
    attrs.forEach(a => { if (names.indexOf(a.name) < 0) names.push(a.name); });
    layer.autoCols = names;
    layer.headers = POINT_BASE_HEADERS.concat(names);
    // a duplicated or empty column name is reported with visible feedback
    if (attrs.length !== names.length) flashPointHint('Information: Duplicate attribute column names have been made unique');
    layer.colsLocked = true;
    layer.isEmptyCategory = false;
    layer.data = [layer.headers.slice()];
  }
  layer.rows = layer.rows || [];
  const row = [hid, x, y, z];
  (layer.autoCols || []).forEach(nm => {
    const hit = attrs.find(a => a.name === nm);
    row.push(hit ? hit.value : '');
  });
  layer.rows.push(row);
  rebuildHandLayer(layer);
  renderPointLayer(layer);
  refreshPointNodeLabel(layer);
  pushDrawHistory(layer);   // )
  document.getElementById('point-add-modal').classList.remove('show');
  flashPointHint('Point added ' + hid + ' → ' + layer.name + '  (Total ' + layer.rows.length + ' items) ');
}

// -- the buttons of the drawing indicator panel --
document.getElementById('draw-bar-undo').addEventListener('click', (e) => { e.stopPropagation(); drawUndo(); });
document.getElementById('draw-bar-redo').addEventListener('click', (e) => { e.stopPropagation(); drawRedo(); });
document.getElementById('draw-bar-save').addEventListener('click', (e) => { e.stopPropagation(); saveCurrentDrawCategory(); });
document.getElementById('draw-bar-stop').addEventListener('click', (e) => { e.stopPropagation(); setPointAddMode(false); });

// -- event bindings --
document.getElementById('ctx-import-point').addEventListener('click', async (e) => {
  e.stopPropagation();
  hideCtxMenu();
  if (!await guardImportPointDraw('Importing point data')) return;
  pendingPointCategory = subitemsPoint;
  pointFileInput.value = '';
  pointFileInput.click();
});

// right-click the Points group to create a category
document.getElementById('ctx-new-point-category').addEventListener('click', (e) => {
  e.stopPropagation();
  hideCtxMenu();
  openPointCategoryDialog('point-category-new', 'New point category', 'Point category name: ', makeUniquePointCategoryName('New point category'));
});
// )
document.getElementById('ctx-add-point').addEventListener('click', (e) => {
  e.stopPropagation();
  // note: the id has to be taken before hideCtxMenu(), because the latter clears ctxContext
  let id = (ctxContext && ctxContext.pointId) || activePointLayerId;
  hideCtxMenu();
  if (!pointAddMode) {
    // ,
    if (!id || !state.pointLayers[id]) {
      const ids = Object.keys(state.pointLayers || {});
      if (ids.length === 1) { id = ids[0]; }
      else if (ids.length > 1) {
        flashPointHint('Multiple point categories exist, On the left,“Point”right-click the target category and choose“Draw points”');
        return;
      }
    }
    if (!id) { flashPointHint('First, on the left,“Point”right-click →“New category”, then right-click the category and select“Draw points”'); return; }
    activePointLayerId = id;      // 开启时锁定目标类别
  }
  setPointAddMode(!pointAddMode);
});

// )
document.getElementById('ctx-edit-point-data').addEventListener('click', (e) => {
  e.stopPropagation();
  const id = resolvePointTargetId();
  hideCtxMenu();
  if (id) openPointDataEditor(id);
  else flashPointHint('First right-click a point category, then select“Edit point data”');
});

// )
document.getElementById('ctx-export-point').addEventListener('click', (e) => {
  e.stopPropagation();
  const id = resolvePointTargetId();
  hideCtxMenu();
  exportPointsToCSV(id);
});

// ,
// there is currently no call site: the cross in the layer management panel now handles a single model
// 
// )
// .
function deleteLineLayer(layerId) {
  const layer = state.lineLayers[layerId];
  if (!layer) return;
  const models = state.models.filter(m => m.isLineLayer && m.lineLayerId === layerId);
  models.forEach(m => {
    if (m.mesh) {
      scene.remove(m.mesh);
      m.mesh.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(mt => mt.dispose());
          else o.material.dispose();
        }
      });
    }
    const idx = state.models.indexOf(m);
    if (idx >= 0) state.models.splice(idx, 1);
    const item = lmList.querySelector('.lm-item[data-model-id="' + m.id + '"]');
    if (item) item.remove();
    // remove the matching file node in the left tree and the file record
    const rec = layer.files.find(f => f.modelId === m.id);
    if (rec) {
      const node = layer._nested ? layer._nested.querySelector('[data-line-file-id="' + rec.id + '"]') : null;
      if (node) node.remove();
      const fi = layer.files.indexOf(rec);
      if (fi >= 0) layer.files.splice(fi, 1);
    }
  });
  // when the category no longer holds any file, remove the category node
  if (layer.files.length === 0) {
    const hasOther = state.models.some(m => m.isLineLayer && m.lineLayerId === layerId);
    if (!hasOther) {
      if (layer._node) layer._node.remove();
      if (layer._nested) layer._nested.remove();
      delete state.lineLayers[layerId];
      state.lineOrder = state.lineOrder.filter(x => x !== layerId);
      if (activeLineLayerId === layerId) activeLineLayerId = null;
    }
  } else {
    refreshLineCategoryLabel(layer);
  }
  if (lmList.children.length === 0) lmEmpty.style.display = '';
  updateLegend();
  updateRenderOrder();
}

// resolve the point category the operation applies to: the one that was right-clicked, the one that is selected, or the only one
function resolvePointTargetId() {
  let id = (ctxContext && ctxContext.pointId) || activePointLayerId;
  if (id && state.pointLayers[id]) return id;
  const ids = Object.keys(state.pointLayers || {});
  return ids.length === 1 ? ids[0] : null;
}

// ============================================================
// )
// ,
// ,
// .
// ============================================================
const LINE_PALETTE = [0x3EE1A3, 0x58A6FF, 0xF39C12, 0xE85D75, 0x9B59B6, 0x1ABC9C, 0xE74C3C];
let linePaletteIdx = 0;

const headerLine = document.getElementById('header-line');
const subitemsLine = document.getElementById('subitems-line');
const lineDxfInput = document.getElementById('line-dxf-input');
const lineGeojsonInput = document.getElementById('line-geojson-input');
const lineCsvInput = document.getElementById('line-csv-input');

// the event bindings
lineDxfInput.addEventListener('change', async () => { await importLineFiles(lineDxfInput.files, 'dxf'); lineDxfInput.value = ''; });
lineGeojsonInput.addEventListener('change', async () => { await importLineFiles(lineGeojsonInput.files, 'geojson'); lineGeojsonInput.value = ''; });
lineCsvInput.addEventListener('change', async () => { await importLineFiles(lineCsvInput.files, 'csv'); lineCsvInput.value = ''; });
if (headerLine) {
  headerLine.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ctxContext = { type: 'line', target: headerLine };
    filterCtxMenu('line');
    showCtxMenu(e.clientX, e.clientY);
  });
}

state.lineLayers = state.lineLayers || {};
state.lineOrder = state.lineOrder || [];
let activeLineLayerId = null;
let pendingRenameLine = null;   // )

function makeLineCategoryId() {
  return 'line_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

// ============================================================
// )
//
// ,
// .
// )
// ,
// ,
// 
//
// ,
// when New line category already exists, use New line category 2
// when 1 and 2 already exist, use New line category 3
// when the user renamed it so the prefix no longer matches, start from 2 and take the first free slot
// ============================================================
function makeUniqueLineCategoryName(base) {
  const b = base || 'New line category';
  const taken = new Set();
  (state.lineOrder || []).forEach(id => {
    const L = state.lineLayers[id];
    if (L && L.name) taken.add(L.name);
  });
  // )
  if (subitemsLine) {
    subitemsLine.querySelectorAll('[data-role="line-category"] .lp-label').forEach(n => {
      if (n.textContent) taken.add(n.textContent);
    });
  }
  if (!taken.has(b)) return b;
  for (let i = 2; i < 10000; i++) {
    const cand = b + i;
    if (!taken.has(cand)) return cand;
  }
  return b + '_' + Date.now();
}

function getActiveLineCategory() {
  if (activeLineLayerId && state.lineLayers[activeLineLayerId]) return state.lineLayers[activeLineLayerId];
  return null;
}

// new line category: create the node in the left tree and make it the active category
function createLineCategory(name) {
  const id = makeLineCategoryId();
  const color = LINE_PALETTE[linePaletteIdx % LINE_PALETTE.length];
  linePaletteIdx++;
  // ,
  // ,
  const wanted = (name && name.trim()) ? name.trim() : 'New line category';
  const finalName = makeUniqueLineCategoryName(wanted);
  const layer = {
    id: id,
    name: finalName, regionId: window.researchRegions?.currentId,
    color: color,
    files: [],          // [{ id, fileName, entities, modelId, lineCount, color, opacity }]
    _node: null,
    _nested: null
  };
  state.lineLayers[id] = layer;
  // logic
  if (state.lineOrder.indexOf(id) < 0) state.lineOrder.push(id);
  addLineNode(layer);
  activeLineLayerId = id;   // ,
  return layer;
}

// ,
function addLineNode(layer) {
  if (!subitemsLine) return;
  const old = subitemsLine.querySelector('[data-role="line-category"][data-line-id="' + layer.id + '"]');
  if (old) {
    // ,
    const oldNested = old.nextElementSibling;
    old.remove();
    if (oldNested && oldNested.classList.contains('lp-nested-items')) oldNested.remove();
  }

  const cc = '#' + layer.color.toString(16).padStart(6, '0');
  const node = document.createElement('div');
  node.className = 'lp-sub-item has-children';
  node.setAttribute('data-role', 'line-category');
  node.setAttribute('data-line-id', layer.id);
  node.innerHTML =
    '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
    '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="' + cc + '" stroke-width="2"><path d="M3 16c3-8 6 8 9 0s6 8 9 0"></path></svg>' +
    '<span class="lp-label">' + escapeHtml(layer.name) + '</span>' +
    '<span class="lp-count">' + (layer.files.length ? '（' + layer.files.length + ' files) ' : ' (Empty) ') + '</span>';

  const nested = document.createElement('div');
  nested.className = 'lp-nested-items expanded';
  nested.setAttribute('data-line-nested', layer.id);

  const arrow = node.querySelector('.sub-arrow');
  const toggle = (e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    const collapsed = node.classList.toggle('collapsed');
    nested.classList.toggle('expanded', !collapsed);
    if (arrow) arrow.style.transform = collapsed ? 'rotate(-90deg)' : '';
  };
  node.addEventListener('click', (e) => {
    // clicking the arrow or the count folds it, clicking anywhere else makes it the active category
    if (e.target.closest('.lp-count') || e.target.closest('.sub-arrow')) { toggle(e); return; }
    activeLineLayerId = layer.id;
    subitemsLine.querySelectorAll('[data-role="line-category"]').forEach(n => { n.style.background = ''; });
    node.style.background = 'rgba(62,225,163,.12)';
  });

  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    activeLineLayerId = layer.id;
    ctxContext = { type: 'line-category', target: node, lineId: layer.id };
    filterCtxMenu('line-category');
    showCtxMenu(e.clientX, e.clientY);
  });

  subitemsLine.appendChild(node);
  subitemsLine.appendChild(nested);
  layer._node = node;
  layer._nested = nested;

  // )
  layer.files.forEach(f => attachLineFileNode(layer, f));
  refreshLineCategoryLabel(layer);
}

// ,
function expandLineCategory(layer) {
  if (!layer) return;
  if (layer._node) layer._node.classList.remove('collapsed');
  if (layer._nested) layer._nested.classList.add('expanded');
}

function refreshLineCategoryLabel(layer) {
  const node = layer._node;
  if (!node) return;
  const cnt = node.querySelector('.lp-count');
  if (cnt) cnt.textContent = layer.files.length ? '（' + layer.files.length + ' files) ' : ' (Empty) ';
}

// attach the node of a line file beneath the category
function attachLineFileNode(layer, fileRec) {
  if (!layer._nested) return;
  const exist = layer._nested.querySelector('[data-line-file-id="' + fileRec.id + '"]');
  if (exist) exist.remove();
  const cc = '#' + (fileRec.color || layer.color).toString(16).padStart(6, '0');
  const node = document.createElement('div');
  node.className = 'lp-sub-item lp-line-file';
  node.setAttribute('data-line-file-id', fileRec.id);
  node.innerHTML =
    '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="' + cc + '" stroke-width="2"><path d="M3 16c3-8 6 8 9 0s6 8 9 0"></path></svg>' +
    '<span class="lp-file-name" title="' + escapeHtml(fileRec.fileName) + '">' + escapeHtml(fileRec.fileName) + '</span>' +
    (fileRec.lineCount ? '<span class="lp-file-meta">' + fileRec.lineCount + ' entries</span>' : '');
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ntype = 'line-file';
    ctxContext = { type: ntype, target: node, lineId: layer.id, lineFileId: fileRec.id };
    filterCtxMenu(ntype);
    showCtxMenu(e.clientX, e.clientY);
  });
  layer._nested.appendChild(node);
  fileRec._node = node;
  // the layer management
  if (fileRec.modelId) {
    const mo = (state.models || []).find(m => m.id === fileRec.modelId);
    if (mo) mo.treeFileNode = node;
  }
  // )
  // ,
  // ,
  // ,
  setupNodeDraggable(node, {
    type: 'file',
    modelId: fileRec.modelId || null,
    fileNames: [fileRec.fileName]
  });
}

// resolve the line category the operation applies to: the one that was right-clicked, the active one, or the only one
function resolveLineTargetId() {
  let id = (ctxContext && ctxContext.lineId) || activeLineLayerId;
  if (id && state.lineLayers[id]) return id;
  const ids = Object.keys(state.lineLayers || {});
  return ids.length === 1 ? ids[0] : null;
}

// the context menu event
// right-click the Lines group to create a line category
document.getElementById('ctx-new-line-category').addEventListener('click', (e) => {
  e.stopPropagation();
  hideCtxMenu();
  // ,
  openPointCategoryDialog('line-category-new', 'New line category', 'Line category name: ', makeUniqueLineCategoryName('New line category'));
});

document.getElementById('ctx-import-line-dxf').addEventListener('click', async (e) => {
  e.stopPropagation();
  const id = resolveLineTargetId();
  hideCtxMenu();
  if (!id) { flashPointHint('First, on the left,“Line”right-click →“New line category”, Then right-click the category to import files'); return; }
  if (!await guardImportPointDraw('Importing lines DXF')) return;
  activeLineLayerId = id;
  lineDxfInput.value = '';
  lineDxfInput.click();
});

document.getElementById('ctx-import-line-geojson').addEventListener('click', async (e) => {
  e.stopPropagation();
  const id = resolveLineTargetId();
  hideCtxMenu();
  if (!id) { flashPointHint('First, on the left,“Line”right-click →“New line category”, Then right-click the category to import files'); return; }
  if (!await guardImportPointDraw('Importing lines GeoJSON')) return;
  activeLineLayerId = id;
  lineGeojsonInput.value = '';
  lineGeojsonInput.click();
});

document.getElementById('ctx-import-line-csv').addEventListener('click', async (e) => {
  e.stopPropagation();
  const id = resolveLineTargetId();
  hideCtxMenu();
  if (!id) { flashPointHint('First, on the left,“Line”right-click →“New line category”, Then right-click the category to import files'); return; }
  if (!await guardImportPointDraw('Importing lines CSV')) return;
  activeLineLayerId = id;
  lineCsvInput.value = '';
  lineCsvInput.click();
});

// )
function removeLineCategory(id) {
  const layer = state.lineLayers[id];
  if (!layer) return;
  if (!confirm('Delete this line category?“ ' + layer.name + ' ”??\n In this category, ' + layer.files.length + ' line files will be removed from the view. ')) return;
  layer.files.forEach(f => removeLineFileModel(f));
  if (layer._node) layer._node.remove();
  if (layer._nested) layer._nested.remove();
  delete state.lineLayers[id];
  state.lineOrder = state.lineOrder.filter(x => x !== id);
  if (activeLineLayerId === id) activeLineLayerId = null;
}

function removeLineFileModel(fileRec) {
  if (fileRec.modelId) {
    const m = state.models.find(mm => mm.id === fileRec.modelId);
    if (m) removeModelFromView(m);
  }
}

function deleteLineFileNode(node) {
  const fid = node.getAttribute('data-line-file-id');
  const lid = (ctxContext && ctxContext.lineId) || activeLineLayerId;
  const layer = state.lineLayers[lid];
  if (!layer) { node.remove(); return; }
  const idx = layer.files.findIndex(f => f.id === fid);
  if (idx < 0) { node.remove(); return; }
  const rec = layer.files[idx];
  if (!confirm('Delete this line file?“ ' + rec.fileName + ' ”??')) return;
  removeLineFileModel(rec);
  layer.files.splice(idx, 1);
  node.remove();
  refreshLineCategoryLabel(layer);
}

// rename a line category or a line file
function renameLineNode(node) {
  const id = (ctxContext && ctxContext.lineId) || activeLineLayerId;
  const layer = state.lineLayers[id];
  if (!layer) return;
  pendingRenameLine = { kind: 'category', id: id };
  openPointCategoryDialog('line-category-rename', 'Rename line category', 'New name: ', layer.name);
}

function renameLineFileNode(node) {
  const fid = node.getAttribute('data-line-file-id');
  const lid = (ctxContext && ctxContext.lineId) || activeLineLayerId;
  const layer = state.lineLayers[lid];
  if (!layer) return;
  const rec = layer.files.find(f => f.id === fid);
  if (!rec) return;
  pendingRenameLine = { kind: 'file', id: lid, fileId: fid };
  openPointCategoryDialog('line-category-rename', 'Rename line file', 'New name: ', rec.fileName);
}

// )
function applyLineRename(newName) {
  if (!pendingRenameLine) return;
  const p = pendingRenameLine;
  pendingRenameLine = null;
  if (p.kind === 'category') {
    const layer = state.lineLayers[p.id];
    if (!layer) return;
    layer.name = newName;
    const sp = layer._node ? layer._node.querySelector('span') : null;
    if (sp) sp.textContent = newName;
  } else {
    const layer = state.lineLayers[p.id];
    if (!layer) return;
    const rec = layer.files.find(f => f.id === p.fileId);
    if (!rec) return;
    rec.fileName = newName;
    if (rec.modelId) {
      const m = state.models.find(mm => mm.id === rec.modelId);
      if (m) { m.fileName = newName; }
      const lmItem = lmList.querySelector('.lm-item[data-model-id="' + rec.modelId + '"] .lm-name');
      if (lmItem) { lmItem.textContent = newName; lmItem.title = newName; }
    }
    const node = layer._nested ? layer._nested.querySelector('[data-line-file-id="' + p.fileId + '"]') : null;
    const sp = node ? node.querySelector('span') : null;
    if (sp) sp.textContent = newName;
  }
}

canvas.addEventListener('pointerdown', (e) => {
  if (pointAddMode) _pdDown = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointAddMode || !pointPreviewMesh) return;
  const p = getPickablePointOnGeometry(e);
  if (p) { pointPreviewMesh.position.copy(p); pointPreviewMesh.visible = true; }
  else { pointPreviewMesh.visible = false; }
});
canvas.addEventListener('click', (e) => {
  if (!pointAddMode) return;
  const moved = _pdDown ? Math.hypot(e.clientX - _pdDown.x, e.clientY - _pdDown.y) : 0;
  _pdDown = null;
  if (moved > 5) return; // ,
  const p = getPickablePointOnGeometry(e);
  if (!p) { flashPointHint('No model was hit / Drillholes / Point, Aim the crosshair at the geological body before clicking'); return; }
  const g = worldToGocad(p);
  openPointAddModal(g.gx, g.gy, g.gz);
});
document.getElementById('point-add-ok').addEventListener('click', commitHandPoint);
document.getElementById('point-add-cancel') && document.getElementById('point-add-cancel').addEventListener('click', () => { document.getElementById('point-add-modal').classList.remove('show'); });
document.getElementById('point-add-skip').addEventListener('click', () => { document.getElementById('point-add-modal').classList.remove('show'); });
// the Add attribute column button in the dialog: columns can be added freely before the first point
const paAddColBtn = document.getElementById('pa-add-col');
if (paAddColBtn) paAddColBtn.addEventListener('click', () => addPointAttrRow('', ''));

// -- the point data editor button --
const pdAddBtn = document.getElementById('pd-add-row');
if (pdAddBtn) pdAddBtn.addEventListener('click', addPointDataRow);
const pdDelBtn = document.getElementById('pd-del-selected');
if (pdDelBtn) pdDelBtn.addEventListener('click', deleteSelectedPointRows);
const pdOkBtn = document.getElementById('point-data-ok');
if (pdOkBtn) pdOkBtn.addEventListener('click', commitPointDataEditor);
const pdCancelBtn = document.getElementById('point-data-cancel');
if (pdCancelBtn) pdCancelBtn.addEventListener('click', () => {
  document.getElementById('point-data-modal').classList.remove('show');
  _pdDraft = null; _pdLayerId = null; _pdSelected = new Set();
});
const pdExportBtn = document.getElementById('pd-export');
if (pdExportBtn) pdExportBtn.addEventListener('click', () => { if (_pdLayerId) exportPointsToCSV(_pdLayerId); });
const pdSearch = document.getElementById('pd-search');
if (pdSearch) pdSearch.addEventListener('input', () => { _pdFilter = pdSearch.value || ''; renderPointDataTable(); });

// -- the single point property editing button --
const pattrOk = document.getElementById('point-attr-ok');
if (pattrOk) pattrOk.addEventListener('click', commitPointAttrEditor);
const pattrCancel = document.getElementById('point-attr-cancel');
if (pattrCancel) pattrCancel.addEventListener('click', () => {
  document.getElementById('point-attr-modal').classList.remove('show');
  _pattrCtx = null;
});

// ,
function exportPointsToCSV(onlyId) {
  let layers = Object.values(state.pointLayers || {});
  if (onlyId) layers = layers.filter(l => l.id === onlyId);
  layers = layers.filter(l => !(l.isEmptyCategory && (!l.rows || !l.rows.length)));
  if (layers.length === 0) { flashPointHint('This point category has no data to export'); return; }
  let exported = 0;
  layers.forEach(layer => {
    const data = (layer.rows && layer.rows.length)
      ? [layer.headers].concat(layer.rows.map(r => r.slice()))
      : (layer.data || []);
    if (!data || data.length < 2) return; // 至少表头 + 1 行
    const lines = data.map(row => row.map(csvCell).join(','));
    const csv = '﻿' + lines.join('\r\n'); // ,
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const fname = (layer.name || layer.id || 'points') + ' _Point data_' + ts + '.csv';
    downloadTextFile(csv, fname, 'text/csv');
    exported++;
  });
  flashPointHint('Exported ' + exported + ' point categories: CSV File (Available in the Downloads folder) ');
}

// 
function openPointCategoryDialog(purpose, title, label, defVal) {
  modalPurpose = purpose;
  modalTitle.textContent = title;
  modalLabel.textContent = label;
  modalInput.value = defVal;
  if (modalCoordsysRow) modalCoordsysRow.style.display = 'none';
  if (modalSameCoordsys) modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => modalInput.focus(), 50);
}

// ============================================================
// )
// this closes three gaps:
// first, the coordinates of an existing point can be changed, second, a single point can be deleted, third, the attribute values can be viewed and edited inside the application
// ,
// ,
// ============================================================
let _pdLayerId = null;          // 当前编辑的点类别 id
let _pdDraft = null;            // 编辑副本：{ headers:[], rows:[[]], deleted:[] }
let _pdSelected = new Set();    // )
let _pdFilter = '';

// )
// ,
// .
function snapshotPointDraft(layer) {
  const headers = (layer.headers && layer.headers.length)
    ? layer.headers.slice()
    : POINT_BASE_HEADERS.concat(layer.autoCols || []);
  const rows = (layer.rows && layer.rows.length)
    ? layer.rows.map(r => r.slice())
    : (layer.data && layer.data.length > 1)
      ? layer.data.slice(1).map(r => r.slice())
      : [];
  // )
  if (!layer.rows || !layer.rows.length) {
    layer.rows = rows.map(r => r.slice());
  }
  // ,
  rows.forEach(r => {
    while (r.length < headers.length) r.push('');
    if (r.length > headers.length) r.length = headers.length;
  });
  return { headers: headers, rows: rows, deleted: [] };
}

function openPointDataEditor(layerId) {
  const layer = state.pointLayers[layerId];
  if (!layer) return;
  _pdLayerId = layerId;
  _pdDraft = snapshotPointDraft(layer);
  _pdSelected = new Set();
  _pdFilter = '';
  const ttl = document.getElementById('point-data-title');
  if (ttl) ttl.textContent = 'Point data → ' + layer.name;
  const se = document.getElementById('pd-search');
  if (se) se.value = '';
  const lockNote = document.getElementById('pd-lock-note');
  if (lockNote) lockNote.style.display = layer.colsLocked ? '' : 'none';
  renderPointDataTable();
  document.getElementById('point-data-modal').classList.add('show');
}

// the header holds the fixed geometry columns and the custom attribute columns, and the first column is a select checkbox
function renderPointDataTable() {
  if (!_pdDraft) return;
  const thead = document.getElementById('pd-thead');
  const tbody = document.getElementById('pd-tbody');
  if (!thead || !tbody) return;
  const H = _pdDraft.headers;
  const kw = _pdFilter.trim().toLowerCase();
  const idxs = [];
  _pdDraft.rows.forEach((r, i) => {
    if (!kw) { idxs.push(i); return; }
    if (r.some(v => String(v == null ? '' : v).toLowerCase().indexOf(kw) >= 0)) idxs.push(i);
  });

  // -- the header --
  let hh = '<tr>';
  hh += '<th style="padding:4px 6px;border:1px solid #e3e3e3;background:#fafafa;position:sticky;top:0;left:0;z-index:3;">' +
        '<input type="checkbox" id="pd-check-all" title="Select all/Deselect all" ' +
        (idxs.length && idxs.every(i => _pdSelected.has(i)) ? 'checked' : '') + '></th>';
  hh += '<th style="padding:4px 8px;border:1px solid #e3e3e3;background:#fafafa;position:sticky;top:0;z-index:2;color:#888;">#</th>';
  H.forEach((name, c) => {
    const isGeo = isPointGeoCol(H, c);
    const label = POINT_BASE_LABELS[String(name || '').trim().toLowerCase()] || name;
    const bg = isGeo ? '#eef4fd' : '#fafafa';
    const col = isGeo ? '#1565C0' : '#555';
    const cs = 'padding:4px 8px;border:1px solid #e3e3e3;background:' + bg + ';position:sticky;top:0;z-index:2;color:' + col + ';font-weight:500;';
    if (isGeo) {
      // the fixed geometry columns are read only
      hh += '<th style="' + cs + '">' + escapeHtml(label) + '</th>';
    } else {
      // ,
      hh += '<th style="' + cs + 'white-space:nowrap;">' +
            '<span class="pd-col-name" data-pd-col="' + c + ' " title="Click to rename this column" ' +
            'style="cursor:pointer;border-bottom:1px dashed #aaa;">' + escapeHtml(label) + '</span>' +
            '<span class="pd-col-del" data-pd-col="' + c + ' " title="Delete this attribute column" ' +
            'style="cursor:pointer;margin-left:6px;color:#c62828;font-weight:400;">✕</span>' +
            '</th>';
    }
  });
  // the plus column button at the end adds a column directly in the header
  hh += '<th style="padding:4px 8px;border:1px solid #e3e3e3;background:#fafafa;position:sticky;top:0;z-index:2;">' +
        '<span id="pd-add-col-th" title="Add attribute column" style="cursor:pointer;color:#2f6df6;font-weight:500;">＋ Columns</span></th>';
  hh += '</tr>';
  thead.innerHTML = hh;

  // -- the body --
  if (!idxs.length) {
    tbody.innerHTML = '<tr><td colspan="' + (H.length + 3) + '" style="padding:14px;text-align:center;color:#888;border:1px solid #e3e3e3;">' +
      (kw ? 'No match“ ' + escapeHtml(_pdFilter) + ' ”points' : 'This category contains no points, Click above“＋ Add point”Add a') + '</td></tr>';
  } else {
    let bh = '';
    idxs.forEach(i => {
      const r = _pdDraft.rows[i];
      const checked = _pdSelected.has(i) ? 'checked' : '';
      bh += '<tr data-pd-row="' + i + '">';
      bh += '<td style="padding:2px 6px;border:1px solid #e3e3e3;text-align:center;background:#fafafa;position:sticky;left:0;z-index:1;">' +
            '<input type="checkbox" class="pd-row-check" data-pd-idx="' + i + '" ' + checked + '></td>';
      bh += '<td style="padding:2px 8px;border:1px solid #e3e3e3;text-align:right;color:#888;background:#fafafa;">' + (i + 1) + '</td>';
      H.forEach((name, c) => {
        const isGeo = isPointGeoCol(H, c);
        const numCols = ['x', 'y', 'z'];
        const isNum = numCols.indexOf(String(name || '').trim().toLowerCase()) >= 0;
        const val = r[c] == null ? '' : String(r[c]);
        bh += '<td style="padding:0;border:1px solid #e3e3e3;">' +
              '<input type="' + (isNum ? 'number' : 'text') + '"' + (isNum ? ' step="any"' : '') +
              ' class="pd-cell" data-pd-idx="' + i + '" data-pd-col="' + c + '"' +
              ' value="' + escapeHtml(val) + '"' +
              ' style="width:100%;min-width:' + (isGeo ? '110px' : '90px') + ';padding:4px 6px;box-sizing:border-box;border:none;background:transparent;font-size:12px;' +
              (isGeo ? 'color:#1565C0;' : '') + '">' +
              '</td>';
      });
      bh += '</tr>';
    });
    tbody.innerHTML = bh;
  }

  // -- the notice at the top --
  const tip = document.getElementById('pd-tip');
  if (tip) {
    const total = _pdDraft.rows.length;
    const shown = idxs.length;
    const sel = _pdSelected.size;
    const nGeo = countPointGeoCols(H);
    tip.textContent = 'Total ' + total + ' points' +
      (kw ? ' (Filter ' + shown + ' items) ' : '') +
      (sel ? '　Selected ' + sel + ' items' : '') +
      '　|　' + H.length + ' Columns (' + nGeo + ' Fixed + ' + (H.length - nGeo) + ' Attributes) ';
  }

  // -- the bindings --
  const checkAll = document.getElementById('pd-check-all');
  if (checkAll) {
    checkAll.addEventListener('change', () => {
      if (checkAll.checked) idxs.forEach(i => _pdSelected.add(i));
      else idxs.forEach(i => _pdSelected.delete(i));
      renderPointDataTable();
    });
  }
  tbody.querySelectorAll('.pd-row-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const i = parseInt(cb.getAttribute('data-pd-idx'), 10);
      if (cb.checked) _pdSelected.add(i); else _pdSelected.delete(i);
      const t2 = document.getElementById('pd-tip');
      if (t2 && _pdDraft) {
        const kw2 = _pdFilter.trim().toLowerCase();
        const shown2 = _pdDraft.rows.filter(r => !kw2 || r.some(v => String(v == null ? '' : v).toLowerCase().indexOf(kw2) >= 0)).length;
        t2.textContent = 'Total ' + _pdDraft.rows.length + ' points' +
          (kw2 ? ' (Filter ' + shown2 + ' items) ' : '') +
          (_pdSelected.size ? '　Selected ' + _pdSelected.size + ' items' : '');
      }
    });
  });
  // ,
  tbody.querySelectorAll('.pd-cell').forEach(ipt => {
    ipt.addEventListener('input', () => {
      const i = parseInt(ipt.getAttribute('data-pd-idx'), 10);
      const c = parseInt(ipt.getAttribute('data-pd-col'), 10);
      if (!_pdDraft || !_pdDraft.rows[i]) return;
      _pdDraft.rows[i][c] = ipt.value;
    });
  });

  // ,
  thead.querySelectorAll('.pd-col-name').forEach(sp => {
    sp.addEventListener('click', () => {
      const c = parseInt(sp.getAttribute('data-pd-col'), 10);
      if (!_pdDraft || isPointGeoCol(_pdDraft.headers, c)) return;
      // Section 64: renaming also forbids a column name that matches one of the fixed geometry columns, because such a column would be
      // ,
      const old = _pdDraft.headers[c] || '';
      const ipt = document.createElement('input');
      ipt.type = 'text';
      ipt.value = old;
      ipt.style.cssText = 'width:80px;padding:2px 4px;font-size:12px;box-sizing:border-box;';
      sp.replaceWith(ipt);
      ipt.focus(); ipt.select();
      const finish = (commit) => {
        const nv = commit ? String(ipt.value || '').trim() : old;
        if (commit && !nv) { flashPointHint('Column name cannot be empty, Original column name retained'); }
        else if (commit && isPointGeoHeader(nv)) {
          // ,
          flashPointHint('「' + nv + ' ”is reserved for a fixed geometry column, cannot be used as an attribute column name');
        }
        else if (commit) {
          if (nv !== old && _pdDraft.headers.indexOf(nv) >= 0 && _pdDraft.headers.indexOf(nv) !== c) {
            flashPointHint('An attribute column with this name already exists“ ' + nv + ' ”, The rename was not applied');
          } else {
            _pdDraft.headers[c] = nv;
            flashPointHint('Column renamed to“ ' + nv + ' ”, Point“Save and refresh”to apply');
          }
        }
        renderPointDataTable();
      };
      ipt.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      });
      ipt.addEventListener('blur', () => finish(true));
    });
  });
  thead.querySelectorAll('.pd-col-del').forEach(sp => {
    sp.addEventListener('click', () => {
      const c = parseInt(sp.getAttribute('data-pd-col'), 10);
      if (!_pdDraft || isPointGeoCol(_pdDraft.headers, c)) return;
      // )
      const customCount = pointCustomColIndexes(_pdDraft.headers).length;
      if (customCount <= 1 && _pdDraft.rows.length > 0) {
        flashPointHint('Keep at least 1 attribute columns; Delete the category\'s points first to clear it');
        return;
      }
      const nm = _pdDraft.headers[c];
      _pdDraft.headers.splice(c, 1);
      _pdDraft.rows.forEach(r => r.splice(c, 1));
      renderPointDataTable();
      flashPointHint('Column deleted“ ' + nm + ' ”, Point“Save and refresh”to apply');
    });
  });
  const addColTh = document.getElementById('pd-add-col-th');
  if (addColTh) addColTh.addEventListener('click', addPointDataColumn);
}

// saved as a draft, written back to the category and refreshed in 3D
function commitPointDataEditor() {
  const layer = state.pointLayers[_pdLayerId];
  document.getElementById('point-data-modal').classList.remove('show');
  if (!layer || !_pdDraft) { _pdDraft = null; return; }
  // ,
  // ,
  // )
  // ,
  // 
  // )
  const _norm = normalizePointColumnOrder(_pdDraft.headers, _pdDraft.rows);
  layer.headers = _norm.headers;
  layer.rows = _norm.rows;
  layer.autoCols = pointCustomColNames(layer.headers);
  layer.colsLocked = layer.autoCols.length > 0 || layer.rows.length > 0;
  layer.isEmptyCategory = layer.rows.length === 0;
  const n = _pdDraft.deleted.length;
  _pdDraft = null;
  _pdLayerId = null;
  _pdSelected = new Set();
  rebuildHandLayer(layer);
  renderPointLayer(layer);
  refreshPointNodeLabel(layer);
  try { doSaveProject(true); } catch (err) { console.error('Unable to save point data', err); }
  flashPointHint('Point data updated:  ' + layer.rows.length + ' points' + (n ? ' (Delete ' + n + ' items) ' : ''));
}

// ,
function addPointDataColumn() {
  if (!_pdDraft) return;
  const base = 'Attributes';
  // ,
  let n = pointCustomColIndexes(_pdDraft.headers).length + 1;
  let nm = base + n;
  while (_pdDraft.headers.indexOf(nm) >= 0 || isPointGeoHeader(nm)) { n++; nm = base + n; }
  _pdDraft.headers.push(nm);
  _pdDraft.rows.forEach(r => r.push(''));
  renderPointDataTable();
  flashPointHint('Attribute column added“ ' + nm + ' ” (Click a column header to rename it) , Point“Save and refresh”to apply');
  // ,
  const wrap = document.getElementById('pd-table-wrap');
  if (wrap) wrap.scrollLeft = wrap.scrollWidth;
}

// ,
function addPointDataRow() {
  if (!_pdDraft) return;
  const H = _pdDraft.headers;
  const iHole = findColumnIndex(H, ['holeid', 'hole_id', '孔号', '钻孔号']);
  const iX = findColumnIndex(H, ['x', 'east', '东坐标', '东']);
  const iY = findColumnIndex(H, ['y', 'north', '北坐标', '北']);
  const iZ = findColumnIndex(H, ['z', 'elevation', '高程', '标高']);
  const row = [];
  for (let c = 0; c < H.length; c++) row.push('');
  // )
  const used = new Set(_pdDraft.rows.map(r => iHole >= 0 ? String(r[iHole]) : ''));
  let k = _pdDraft.rows.length + 1, hid = 'PT' + String(k).padStart(3, '0');
  while (used.has(hid)) { k++; hid = 'PT' + String(k).padStart(3, '0'); }
  if (iHole >= 0) row[iHole] = hid;
  // ,
  const last = _pdDraft.rows[_pdDraft.rows.length - 1];
  if (last) {
    if (iX >= 0) row[iX] = last[iX];
    if (iY >= 0) row[iY] = last[iY];
    if (iZ >= 0) row[iZ] = last[iZ];
  }
  _pdDraft.rows.push(row);
  renderPointDataTable();
  // scroll to the bottom and focus the hole number of the new row
  const wrap = document.getElementById('pd-table-wrap');
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

function deleteSelectedPointRows() {
  if (!_pdDraft) return;
  if (!_pdSelected.size) { flashPointHint('Select the points to delete first (or use Select all above) '); return; }
  const n = _pdSelected.size;
  // ,
  const list = Array.from(_pdSelected).sort((a, b) => b - a);
  list.forEach(i => removePointDraftRowAt(i));
  _pdSelected = new Set();
  renderPointDataTable();
  flashPointHint('Marked for deletion ' + n + ' points, Point“Save and refresh”to apply');
}

// ,
// logic
function removePointDraftRowAt(i) {
  if (!_pdDraft) return false;
  const r = _pdDraft.rows[i];
  if (r == null) return false;
  // ,
  const iHole = findColumnIndex(_pdDraft.headers, ['holeid', 'hole_id', '孔号', '钻孔号']);
  const hid = (iHole >= 0 && r[iHole] != null && String(r[iHole]) !== '') ? String(r[iHole]) : ('#' + (i + 1));
  _pdDraft.deleted.push(hid);
  _pdDraft.rows.splice(i, 1);
  return true;
}

// ============================================================
// )
// ============================================================
let _pattrCtx = null;   // { layerId, rowIndex }

function openPointAttrEditor(model, sphere) {
  const layer = state.pointLayers[model.pointLayerId];
  if (!layer) return;
  const rowIndex = sphere && sphere.userData ? sphere.userData.rowIndex : -1;
  if (rowIndex == null || rowIndex < 0 || !(layer.rows || [])[rowIndex]) {
    flashPointHint('Unable to locate the data row for this point (This may be data imported by an earlier version) , Use“Edit point data”Table changes');
    return;
  }
  _pattrCtx = { layerId: layer.id, rowIndex: rowIndex };
  const row = layer.rows[rowIndex];
  const H = layer.headers || POINT_BASE_HEADERS;
  const ttl = document.getElementById('point-attr-title');
  if (ttl) {
    const iHole = findColumnIndex(H, ['holeid', 'hole_id', '孔号', '钻孔号']);
    const hid = (iHole >= 0 && row[iHole] != null && String(row[iHole]) !== '') ? String(row[iHole]) : ('#' + (rowIndex + 1));
    ttl.textContent = 'Edit point → ' + layer.name + ' · ' + hid;
  }
  const echo = document.getElementById('pattr-echo');
  if (echo) echo.textContent = '';
  const wrap = document.getElementById('pattr-fields');
  if (!wrap) return;
  wrap.innerHTML = '';
  H.forEach((name, c) => {
    const isNum = ['x', 'y', 'z'].indexOf(String(name || '').trim().toLowerCase()) >= 0;
    const isGeo = isPointGeoCol(H, c);
    const label = POINT_BASE_LABELS[String(name || '').trim().toLowerCase()] || name;
    const box = document.createElement('div');
    box.style.cssText = 'margin-bottom:6px;';
    const lb = document.createElement('label');
    lb.style.cssText = 'display:block;margin:6px 0 2px;font-size:13px;' + (isGeo ? 'color:#1565C0;' : '');
    lb.textContent = label + (isNum ? ' (Coordinates, Move immediately after editing) ' : '');
    const ipt = document.createElement('input');
    ipt.type = isNum ? 'number' : 'text';
    if (isNum) ipt.step = 'any';
    ipt.className = 'pattr-field';
    ipt.classList.add('pattr-field');   // ,
    ipt.setAttribute('data-pattr-col', String(c));
    ipt.style.cssText = 'width:100%;padding:6px;box-sizing:border-box;font-size:13px;';
    ipt.value = row[c] == null ? '' : String(row[c]);
    box.appendChild(lb); box.appendChild(ipt);
    wrap.appendChild(box);
  });
  document.getElementById('point-attr-modal').classList.add('show');
  const f = wrap.querySelector('.pattr-field');
  if (f && !f.disabled) { f.focus(); f.select(); }
}

function commitPointAttrEditor() {
  document.getElementById('point-attr-modal').classList.remove('show');
  if (!_pattrCtx) return;
  const layer = state.pointLayers[_pattrCtx.layerId];
  const i = _pattrCtx.rowIndex;
  _pattrCtx = null;
  if (!layer || !(layer.rows || [])[i]) return;
  document.querySelectorAll('#pattr-fields .pattr-field').forEach(ipt => {
    const c = parseInt(ipt.getAttribute('data-pattr-col'), 10);
    if (isNaN(c)) return;
    layer.rows[i][c] = ipt.value;
  });
  rebuildHandLayer(layer);
  renderPointLayer(layer);
  refreshPointNodeLabel(layer);
  try { doSaveProject(true); } catch (err) { console.error('Unable to save the point', err); }
  flashPointHint('Point updated');
}

// ============================================================
// )
// ,
// )
// ,
// ,
// ============================================================

function _ctxPointTarget() {
  const layerId = ctxContext && ctxContext.pointLayerId;
  const ri = ctxContext && ctxContext.pointRowIndex;
  const layer = layerId ? state.pointLayers[layerId] : null;
  if (!layer) return null;
  if (ri == null || ri < 0 || !(layer.rows || [])[ri]) return null;
  return { layer: layer, rowIndex: ri, row: layer.rows[ri] };
}

// Edit this point reuses the double click dialog
function ctxPointEdit() {
  const t = _ctxPointTarget();
  if (!t) { flashPointHint('This point no longer exists, Refresh the view'); return; }
  const model = state.models.find(m => m.isPointLayer && m.pointLayerId === t.layer.id);
  if (!model) { flashPointHint('The point\'s layer was not found'); return; }
  const sphere = { userData: { rowIndex: t.rowIndex } };
  openPointAttrEditor(model, sphere);
}

// ,
function ctxPointCopy() {
  const t = _ctxPointTarget();
  if (!t) { flashPointHint('This point no longer exists, Refresh the view'); return; }
  const layer = t.layer;
  const H = (layer.headers || POINT_BASE_HEADERS).slice();
  const row = t.row.slice();
  row[0] = makeUniqueHoleId(layer, row[0]);
  layer.rows.splice(t.rowIndex + 1, 0, row);
  rebuildHandLayer(layer);
  renderPointLayer(layer);
  refreshPointNodeLabel(layer);
  try { doSaveProject(true); } catch (err) { console.error('Unable to save copied points', err); }
  flashPointHint('Copied as“ ' + row[0] + ' ” (Total ' + layer.rows.length + ' points) ');
}

// generate a hole number that is unique within the category: the original name plus 2 or 3, or PT{n} when the original name is missing
function makeUniqueHoleId(layer, base) {
  const H = layer.headers || POINT_BASE_HEADERS;
  const iH = H.indexOf('holeid');
  const col = iH >= 0 ? iH : 0;
  const used = new Set((layer.rows || []).map(r => String(r[col] == null ? '' : r[col]).trim()));
  let stem = String(base == null ? '' : base).trim();
  if (!stem) stem = 'PT' + ((layer.rows || []).length + 1);
  // ,
  const m = stem.match(/^(.*?)(\d+)$/);
  const prefix = m ? m[1] : stem;
  let n = m ? (parseInt(m[2], 10) + 1) : 2;
  let cand = prefix + n;
  let guard = 0;
  while (used.has(cand) && guard++ < 10000) { n++; cand = prefix + n; }
  return cand;
}

// ,
function ctxPointDelete() {
  const t = _ctxPointTarget();
  if (!t) { flashPointHint('This point no longer exists, Refresh the view'); return; }
  const layer = t.layer;
  const hid = t.row[0] != null && String(t.row[0]) !== '' ? String(t.row[0]) : ('#' + (t.rowIndex + 1));
  if (!confirm('Delete this point?“ ' + hid + ' ”??\n This operation saves immediately. ')) return;
  layer.rows.splice(t.rowIndex, 1);
  rebuildHandLayer(layer);
  renderPointLayer(layer);
  refreshPointNodeLabel(layer);
  try { doSaveProject(true); } catch (err) { console.error('Unable to save deleted points', err); }
  flashPointHint('Point deleted“ ' + hid + ' ” (Remaining ' + layer.rows.length + ' items) ');
}

// ,
function ctxPointFocus() {
  const t = _ctxPointTarget();
  if (!t) { flashPointHint('This point no longer exists, Refresh the view'); return; }
  const layer = t.layer;
  const c = (layer.collars || [])[t.rowIndex];
  const origin = layer.origin || state.origin;
  if (!c || !origin) { flashPointHint('Unable to locate this point\'s coordinates'); return; }
  const p = gocadToThree(c.x, c.y, c.z, origin.x, origin.y, origin.z);
  if (!camera || !controls) return;
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
  controls.target.copy(p);
  camera.position.copy(p).add(dir);
  controls.update();
  flashPointHint('Centered on point“ ' + (c.holeid || ('#' + (t.rowIndex + 1))) + '」');
}

// )
function ctxPointDetail() {
  const t = _ctxPointTarget();
  if (!t) { flashPointHint('This point no longer exists, Refresh the view'); return; }
  const layer = t.layer;
  const H = layer.headers || POINT_BASE_HEADERS;
  const row = t.row;
  const lines = [];
  lines.push('Category:  ' + layer.name);
  lines.push('Row number: No. ' + (t.rowIndex + 1) + ' Rows');
  lines.push('---');
  H.forEach((name, c) => {
    const label = POINT_BASE_LABELS[name] || name;
    let v = row[c];
    if (v == null || v === '') v = ' (Empty) ';
    lines.push(label + '：' + v);
  });
  alert(lines.join('\n'));
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

headerPoint.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  ctxContext = { type: 'point-group', target: headerPoint };
  filterCtxMenu('point');
  showCtxMenu(e.clientX, e.clientY);
});

pointFileInput.addEventListener('change', async () => {
  const files = Array.from(pointFileInput.files || []);
  if (files.length === 0) return;
  const importRegion=window.researchScopeTrees?.fileScope(files[0])||window.researchRegions?.currentId;
  pointFileInput.value = '';
  showImportLoading('Importing point file...');
  let skipped = 0;
  try {
    for (const file of files) {
      try {
        const raw = await readPointFile(file);
        if (raw === null) { skipped++; continue; }             // ★ 用户在多表弹窗里选了「跳过此文件」
        if (!raw || raw.length < 2) { showTableError('Point file“ ' + file.name + ' ”The content is empty or incorrectly formatted. '); continue; }
        if(window.researchRegionViews)await researchRegionViews.ensure(window.researchScopeTrees?.fileScope(file)||importRegion);
        importPointLayer(file, raw);
      } catch (err) {
        showTableError('Point file“ ' + file.name + ' ”Import failed: \n' + (err && err.message ? err.message : err));
      }
    }
  } finally {
    hideImportLoading();
    if (skipped) flashPointHint('Skipped ' + skipped + ' files (No worksheet selected) ');
  }
});

document.getElementById('point-color-ok').addEventListener('click', () => {
  const layer = _pointColorModel ? state.pointLayers[_pointColorModel.pointLayerId] : null;
  if (layer) {
    layer.colorAttr = document.getElementById('point-color-attr').value || null;
    layer.colorScheme = document.getElementById('point-color-scheme').value;
    colorizePointLayer(layer.id);
  }
  document.getElementById('point-color-modal').classList.remove('show');
});
document.getElementById('point-color-cancel').addEventListener('click', () => {
  document.getElementById('point-color-modal').classList.remove('show');
});

// -- rename the table --
// ,
let pendingRenameTableCat = null;    // {node, cur}
let pendingRenameTableFile = null;   // {node, cur, id}

function renameTableCategory(catNode) {
  const span = catNode.querySelector('span');
  const cur = span ? span.textContent : '';
  pendingRenameTableCat = { node: catNode, cur: cur };
  openRenameInputDialog('table-category-rename', 'Rename category', 'Rename category: ', cur);
}

function applyTableCategoryRename(obj, newName) {
  if (!obj || !obj.node) return;
  const span = obj.node.querySelector('span');
  if (span) span.textContent = newName;
}

function renameTableFileNode(fileNode) {
  const id = fileNode.getAttribute('data-table-id');
  const t = state.tables[id];
  if (!t) return;
  const span = fileNode.querySelector('span');
  const cur = span ? span.textContent : t.fileName;
  pendingRenameTableFile = { node: fileNode, cur: cur, id: id };
  openRenameInputDialog('table-file-rename', 'Rename table', 'Rename (The original file content is unchanged) : ', cur);
}

function applyTableFileRename(obj, newName) {
  if (!obj || !obj.node) return;
  const t = state.tables[obj.id];
  if (!t) return;
  const span = obj.node.querySelector('span');
  if (span) span.textContent = newName;
  t.displayName = newName;
}

// -- delete the table --
function deleteTableCategory(catNode) {
  const nested = catNode.nextElementSibling;
  const fileNodes = nested
    ? nested.querySelectorAll('.lp-sub-item[data-table-id]')
    : [];
  const name = (catNode.querySelector('span') || {}).textContent || 'This category';
  if (fileNodes.length > 0 && !confirm('Confirm deletion“ ' + name + ' ”and its ' + fileNodes.length + ' tables??')) return;
  if (fileNodes.length === 0 && !confirm('Confirm deletion“ ' + name + ' ”??')) return;
  fileNodes.forEach(fn => {
    const id = fn.getAttribute('data-table-id');
    if (id) tableHtmlCache.delete(id);
    delete state.tables[id];
  });
  catNode.remove();
  if (nested) nested.remove();
}

function deleteTableFileNode(fileNode) {
  const id = fileNode.getAttribute('data-table-id');
  const t = state.tables[id];
  const name = t ? (t.displayName || t.fileName) : 'This table';
  if (!confirm('Delete this table?“ ' + name + ' ”??')) return;
  if (id) tableHtmlCache.delete(id);
  delete state.tables[id];
  fileNode.remove();
}

// 
function exportTableCategory(catNode) {
  const nested = catNode.nextElementSibling;
  const fileNodes = nested
    ? nested.querySelectorAll('.lp-sub-item[data-table-id]')
    : [];
  if (fileNodes.length === 0) {
    alert('This category has no tables to export');
    return;
  }
  fileNodes.forEach(fn => {
    const id = fn.getAttribute('data-table-id');
    const t = state.tables[id];
    if (!t) return;
    downloadTable(t);
  });
}

function exportTableFileNode(fileNode) {
  const id = fileNode.getAttribute('data-table-id');
  const t = state.tables[id];
  if (!t) return;
  downloadTable(t);
}

function downloadTable(t) {
  // convert the two-dimensional array to CSV text and download it
  const csv = t.data.map(row =>
    row.map(cell => {
      const s = String(cell);
      return s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    }).join(',')
  ).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (t.displayName || t.fileName).replace(/\.(xlsx|xls)$/i, '.csv');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showCtxMenu(x, y) {
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top = y + 'px';
  ctxMenu.classList.add('show');
  // prevent it from exceeding the viewport
  const rect = ctxMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) ctxMenu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) ctxMenu.style.top = (window.innerHeight - rect.height - 8) + 'px';
}

function hideCtxMenu() {
  ctxMenu.classList.remove('show');
  ctxContext = { type: null, target: null };
}

document.addEventListener('click', () => hideCtxMenu());
document.addEventListener('contextmenu', (e) => {
  // ,
  // ,
  if (e.target && e.target.closest && e.target.closest('#canvas-wrap')) return;
  const hitCategory = e.target.closest('.lp-sub-item.has-children[data-category]');
  const hitModelNode = e.target.closest('[data-role="model-node"]');
  const hitGeochemNode = e.target.closest('[data-role="geochem-model-node"]');
  const hitFileNode = e.target.closest('.lp-sub-item[data-model-id]');
  const hitDrawingCat = e.target.closest('[data-role="drawing-category"]');
  const hitDrawingFile = e.target.closest('.lp-sub-item[data-drawing-id], .lp-sub-item[data-vector-id]');
  const hitTableCat = e.target.closest('[data-role="table-category"]');
  const hitTableFile = e.target.closest('.lp-sub-item[data-table-id]');
  const hitHeader = e.target.closest('#header-3d-model');
  const hitGeochemHeader = e.target.closest('#header-geochem-model');
  const hitTunnelHeader = e.target.closest('#header-tunnel-model');
  const hitDrillholeHeader = e.target.closest('#header-drillhole');
  const hitDrillholeAreaNode = e.target.closest('[data-role="drillhole-area-node"]');
  const hitTunnelNode = e.target.closest('[data-role="tunnel-model-node"]');
  const hitLineHeader = e.target.closest('#header-line');
  const hitLineCat = e.target.closest('[data-role="line-category"]');
  const hitLineFile = e.target.closest('.lp-sub-item[data-line-file-id]');
  if (!hitCategory && !hitModelNode && !hitGeochemNode && !hitTunnelNode && !hitFileNode && !hitDrawingCat && !hitDrawingFile && !hitTableCat && !hitTableFile && !hitHeader && !hitGeochemHeader && !hitTunnelHeader && !hitDrillholeHeader && !hitDrillholeAreaNode && !hitLineHeader && !hitLineCat && !hitLineFile) {
    hideCtxMenu();
  }
});

// -- category menu: import a .ts, .str or .dtm model --
ctxImportTs.addEventListener('click', async (e) => {
  e.stopPropagation();
  hideCtxMenu();
  if (pendingCategoryItem) {
    if (!await guardImportPointDraw('Importing GOCAD Model')) return;
    pendingModelImportKind = 'ts';
    fileInput.setAttribute('accept', '.ts,.str,.dtm');
    fileInput.click();
  }
});

// -- category menu: import an .obj model --
ctxImportObj.addEventListener('click', async (e) => {
  e.stopPropagation();
  hideCtxMenu();
  if (pendingCategoryItem) {
    if (!await guardImportPointDraw('Importing OBJ Model')) return;
    pendingModelImportKind = 'obj';
    fileInput.setAttribute('accept', '.obj');
    fileInput.click();
  }
});

// 
// ,
// ,
function bindPointCtxAction(elId, fn) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const snap = Object.assign({}, ctxContext);
    hideCtxMenu();
    ctxContext = snap;
    try { fn(); } finally { ctxContext = { type: null, target: null }; }
  });
}
bindPointCtxAction('ctx-point-edit', ctxPointEdit);
bindPointCtxAction('ctx-point-copy', ctxPointCopy);
bindPointCtxAction('ctx-point-delete', ctxPointDelete);
bindPointCtxAction('ctx-point-focus', ctxPointFocus);
bindPointCtxAction('ctx-point-detail', ctxPointDetail);

// -- general: delete --
document.getElementById('ctx-delete').addEventListener('click', (e) => {
  e.stopPropagation();
  const { type, target } = ctxContext;
  hideCtxMenu();
  if (type === 'file' || type === 'blockmodel-file') deleteFileNode(target);
  else if (type === 'model' || type === 'geochem' || type === 'tunnel' || type === 'blockmodel-node') deleteModelNode(target);
  else if (type === 'drawing') deleteDrawingCategory(target);
  else if (type === 'drawing-group') deleteDrawingGroup(target);
  else if (type === 'drawing-file') deleteDrawingFileNode(target);
  else if (type === 'table') deleteTableCategory(target);
  else if (type === 'table-file') deleteTableFileNode(target);
  else if (type === 'drillhole-area') deleteDrillholeAreaNode(target);
  else if (type === 'pdf-file') deletePdfFileNode(target);
  else if (type === 'report-folder') deleteReportFolderNode(target);
  else if (type === 'testdata-folder') deleteTestDataFolderNode(target);
  else if (type === 'testdata-file') deleteTestDataFileNode(target);
  else if (type === 'point-file' || type === 'point-category') removePointCategory(ctxContext.pointId);
  else if (type === 'line-category') removeLineCategory(ctxContext.lineId);
  else if (type === 'line-file') deleteLineFileNode(target);
});

// -- general: rename --
document.getElementById('ctx-rename').addEventListener('click', (e) => {
  e.stopPropagation();
  const { type, target } = ctxContext;
  hideCtxMenu();
  if (type === 'file' || type === 'blockmodel-file') renameFileNode(target);
  else if (type === 'model' || type === 'geochem' || type === 'tunnel' || type === 'blockmodel-node') renameModelNode(target);
  else if (type === 'drawing') renameDrawingCategory(target);
  else if (type === 'drawing-group') renameDrawingCategory(target);
  else if (type === 'drawing-file') renameDrawingFileNode(target);
  else if (type === 'table') renameTableCategory(target);
  else if (type === 'table-file') renameTableFileNode(target);
  else if (type === 'drillhole-area') renameDrillholeAreaNode(target);
  else if (type === 'pdf-file') renamePdfFileNode(target);
  else if (type === 'word-file') renameWordFileNode(target);
  else if (type === 'report-folder') renameReportFolderNode(target);
  else if (type === 'testdata-folder') renameTestDataFolderNode(target);
  else if (type === 'testdata-file') renameTestDataFileNode(target);
  else if (type === 'point-file' || type === 'point-category') renamePointNode(target);
  else if (type === 'line-category') renameLineNode(target);
  else if (type === 'line-file') renameLineFileNode(target);
});

// -- general: export --
document.getElementById('ctx-export').addEventListener('click', (e) => {
  e.stopPropagation();
  const { type, target } = ctxContext;
  hideCtxMenu();
  if (type === 'file') exportFileNode(target);
  else if (type === 'model' || type === 'geochem' || type === 'tunnel') exportModelNode(target);
  else if (type === 'drawing') exportDrawingCategory(target);
  else if (type === 'drawing-file') exportDrawingFileNode(target);
  else if (type === 'table') exportTableCategory(target);
  else if (type === 'table-file') exportTableFileNode(target);
  else if (type === 'pdf-file') exportPdfFileNode(target);
  else if (type === 'word-file') exportWordFileNode(target);
  else if (type === 'testdata-file') exportTestDataFileNode(target);
});

// 
const attrsFileInput = document.getElementById('attrs-file-input');
document.getElementById('ctx-import-attrs').addEventListener('click', async (e) => {
  e.stopPropagation();
  hideCtxMenu();
  const target = (ctxContext && ctxContext.target) || null;
  if (!await guardImportPointDraw('Importing attribute table')) return;
  window._attrTargetModelId = target ? (target.getAttribute('data-model-id') || null) : null;
  attrsFileInput.value = '';
  attrsFileInput.click();
});

// attribute table to a unified records structure: [{field: value}, ...]
// )
// ,
async function readAttrRecords(file) {
  const name = file.name || '';
  const headBytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = headBytes.length >= 2 && headBytes[0] === 0x50 && headBytes[1] === 0x4b; // PK
  if (isZip || /\.(xlsx|xls|xlsm|xlsb|ods)$/i.test(name)) {
    await ensureDocumentLibrary('excel');if (typeof checkXlsxAvailable !== 'function' || !checkXlsxAvailable()) {
      throw new Error('Excel Parsing library unavailable, Save the attribute table as CSV or JSON then try again');
    }
    const buf = await file.arrayBuffer();
  await ensureDocumentLibrary('excel');
    const wb = await XLSX.read(buf, { type: 'array', cellDates: true });
    if (!wb.SheetNames || wb.SheetNames.length === 0) throw new Error('No worksheet was found in the attribute table');
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error('The first worksheet in the attribute table is empty');
    return rowsToRecords(XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }));
  }
  const buf = await file.arrayBuffer();
  let text;
  if (buf.byteLength >= 3) {
    const b = new Uint8Array(buf, 0, 3);
    if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) text = new TextDecoder('utf-8').decode(new Uint8Array(buf, 3));
    else if (b[0] === 0xFF && b[1] === 0xFE) text = new TextDecoder('utf-16le').decode(new Uint8Array(buf, 2));
    else text = new TextDecoder('utf-8').decode(buf);
  } else {
    text = new TextDecoder('utf-8').decode(buf);
  }
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed);
    let arr = null;
    if (Array.isArray(obj)) arr = obj;
    else if (obj && Array.isArray(obj.records)) arr = obj.records;
    else if (obj && Array.isArray(obj.data)) arr = obj.data;
    else if (obj && typeof obj === 'object') {
      arr = Object.keys(obj).map(k => { const v = obj[k]; if (v && typeof v === 'object') return Object.assign({ file: k }, v); return { file: k, value: v }; });
    }
    if (!arr) throw new Error('JSON The attribute table structure is not recognized (must be an array or {Filename:{...}}) ');
    return arr.map(r => { const o = {}; Object.keys(r).forEach(k => { o[k] = String(r[k] == null ? '' : r[k]); }); return o; });
  }
  return rowsToRecords(parseCsvText(text));
}
function rowsToRecords(rows) {
  if (!rows || rows.length === 0) return [];
  const headers = (rows[0] || []).map(h => String(h == null ? '' : h).trim());
  if (headers.length === 0) return [];
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const rec = {};
    headers.forEach((h, c) => { rec[h] = String(row[c] == null ? '' : row[c]).trim(); });
    records.push(rec);
  }
  return records.filter(r => Object.keys(r).some(k => r[k] !== ''));
}
function attrPick(rec, candidates) {
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(rec, c)) {
      const v = rec[c];
      if (v == null) continue;
      const s = String(v).trim();
      if (s !== '') return s;
    }
  }
  return null;
}
function modelNameEquals(a, b) {
  if (a == null || b == null) return false;
  const s1 = String(a).trim().toLowerCase();
  const s2 = String(b).trim().toLowerCase();
  if (s1 === s2) return true;
  const noext = (s) => s.replace(/\.[^.]+$/, '');
  const n1 = noext(s1), n2 = noext(s2);
  return n1 === n2 || s1 === n2 || s2 === n1;
}
function setModelDisplayName(model, name) {
  if (!model || !name) return;
  model.displayName = name;
  // project tree node
  if (model.treeFileNode) {
    const sp = model.treeFileNode.querySelector('span');
    if (sp) sp.textContent = name;
  }
  // the name of the layer management entry
  if (typeof lmList !== 'undefined' && lmList) {
    const lmName = lmList.querySelector('.lm-item[data-model-id="' + model.id + '"] .lm-name');
    if (lmName) lmName.textContent = name;
  }
}
// the property panel
function applyAttrRecord(model, rec) {
  if (!model) return false;
  if (!model.attrs) model.attrs = {};
  Object.keys(rec).forEach(k => { model.attrs[k] = rec[k]; });
  const typeVal = attrPick(rec, ['type', 'Type', 'Category', 'class', 'Lithology']);
  if (typeVal) {
    if (model._attrApplied || !model.displayName) setModelDisplayName(model, typeVal);
    model._attrApplied = true;
  }
  const colorHex = attrPick(rec, ['suggestedColor', 'Suggested color', 'color', 'Color', 'hex']);
  if (colorHex && /^#?[0-9a-fA-F]{6}$/.test(colorHex.trim())) {
    const hexStr = colorHex.trim().replace(/^#/, '');
    model.color = parseInt(hexStr, 16);
    if (model.material && model.material.color) model.material.color.setHex(model.color);
    if (model.materials) model.materials.forEach(mt => { if (mt && mt.color) mt.color.setHex(model.color); });
    if (typeof syncLayerColorBox === 'function') syncLayerColorBox(model, '#' + hexStr);
  }
  return true;
}
function applyAttrRecordsToModels(records, focusModelId) {
  if (!records || records.length === 0) { alert('The attribute table is empty, Unable to link'); return; }
  const first = records[0];
  const keyCol = ['file', 'Filename', 'File', 'name', 'Model', 'model', 'Object', 'Name']
    .find(c => Object.prototype.hasOwnProperty.call(first, c)) || Object.keys(first)[0];
  const applied = [];
  const missed = [];
  for (const rec of records) {
    const keyVal = rec[keyCol];
    if (!keyVal || String(keyVal).trim() === '') { missed.push('(Filename missing)'); continue; }
    const hit = state.models.find(m => m.geoMesh && modelNameEquals(m.fileName || m.name, keyVal));
    if (hit) { applyAttrRecord(hit, rec); if (applied.indexOf(hit.id) < 0) applied.push(hit.id); }
    else missed.push(String(keyVal));
  }
  if (applied.length > 0) {
    updateLegend();
    if (state.selectedModelId && applied.indexOf(state.selectedModelId) >= 0) refreshCurrentProperties();
    else if (focusModelId) selectLayer(focusModelId);
    const head = 'Applied to ' + applied.length + ' models updated from the attribute table ✓';
    const tail = missed.length > 0
      ? ('\n\n No matching model ' + missed.length + ' entries: \n' + missed.slice(0, 8).join('\n') + (missed.length > 8 ? '\n…' : '') + '\n\n「' + keyCol + ' ”Column values must match imported model filenames (with or without the extension) . ')
      : '';
    alert(head + tail);
  } else {
    alert('No matching models were found. \n\n Attribute table“ ' + keyCol + ' ”Column values must match the filenames of models in the scene, \n e.g.: GM - 1-1.obj\n\n Models in current scene: ' +
      state.models.filter(m => m.geoMesh).map(m => m.fileName).slice(0, 10).join('、') +
      (state.models.length > 10 ? ' …' : '(None)'));
  }
}
attrsFileInput.addEventListener('change', async () => {
  const f = attrsFileInput.files && attrsFileInput.files[0];
  if (!f) return;
  try {
    const records = await readAttrRecords(f);
    applyAttrRecordsToModels(records, window._attrTargetModelId);
  } catch (err) {
    alert('Unable to parse the attribute table [ ' + f.name + ']：' + (err.message || err) + '\n\n Supported formats: CSV / JSON / Excel (Required headers“Filename”Columns) ');
  }
  attrsFileInput.value = '';
});

// -- menu: control point registration --
document.getElementById('ctx-register-drawing').addEventListener('click', (e) => {
  e.stopPropagation();
  hideCtxMenu();
  if (ctxContext && ctxContext.type === 'drawing-file' && ctxContext.target) {
    startRegisterDrawing(ctxContext.target);
  }
});

// 
document.getElementById('ctx-new-drawing-category').addEventListener('click', (e) => {
  e.stopPropagation();
  const { type, target } = ctxContext;
  hideCtxMenu();
  if ((type === 'drawing-group' || type === 'drawing') && target) {
    // ,
    // ,
    // logic
    openNewDrawingSubCategoryDialog(target);
  }
});

// logic
function deleteFileNode(fileNode) {
  const modelId = fileNode.getAttribute('data-model-id');
  const model = getProjectModels().find(m => m.id === modelId);
  if (!model) { fileNode.remove(); return; }
  const displayName = model.displayName || model.fileName || model.name || 'This model';
  if (!confirm('Remove from both the 3D view and the project tree?“ ' + displayName + ' ”??')) return;

  // 1. remove it from the scene
  if (model.mesh && model.mesh.parent) model.mesh.parent.remove(model.mesh);
  // ,
  if (state.selectedModelId === modelId) {
    clearSelectionOutline();
    state.selectedModelId = null;
    showEmptyProperties();
  }
  // 3. delete it from state.models
  if (model.terrainTexture) model.terrainTexture.dispose();
  state.models = state.models.filter(m => m.id !== modelId);
  tabViewers.forEach(viewer=>{if(viewer.state){viewer.state.models.filter(item=>item.id===modelId).forEach(item=>item.mesh?.parent?.remove(item.mesh));viewer.state.models=viewer.state.models.filter(item=>item.id!==modelId);}});
  // 4. remove it from the layer management
  const lmItem = lmList.querySelector('.lm-item[data-model-id="' + modelId + '"]');
  if (lmItem) lmItem.remove();
  // 5. remove it from the project tree
  fileNode.remove();
  // 6. update the legend and the camera
  updateLegend();
  updateRenderOrder();
  fitViewToAll();
  // 7. the empty state
  if (state.models.length === 0) lmEmpty.style.display = '';
  // refresh the coordinate axis labels
  buildAxisLabels();
}

function deleteModelNode(modelNode) {
  // collect the file nodes under every subcategory
  const wrapper = modelNode.parentElement;
  const nested = modelNode.nextElementSibling; // .lp-nested-items
  const fileNodes = nested
    ? nested.querySelectorAll('.lp-sub-item[data-model-id]')
    : [];
  const modelCount = fileNodes.length;
  const modelName = (modelNode.querySelector('span') || {}).textContent || 'This model';
  if (modelCount > 0 && !confirm('Confirm deletion“ ' + modelName + ' ”and its ' + modelCount + ' 3D model files??')) return;
  if (modelCount === 0 && !confirm('Confirm deletion“ ' + modelName + ' ”??')) return;

  // delete each file in turn
  fileNodes.forEach(fn => deleteFileNode(fn));

  // )
  modelNode.remove();
  if (nested) nested.remove();
  // ,
  if (wrapper && wrapper !== subitems3DModel && wrapper !== subitemsGeochemModel && wrapper !== subitemsBlockModel && wrapper.children.length === 0) wrapper.remove();
}

// logic
let pendingRenameModelFile = null;   // modal 重命名三维模型文件子项 {node, cur}
let pendingRenameModelGroup = null;  // modal 重命名三维模型分组 {node, cur}

function openRenameInputDialog(purpose, title, label, defVal) {
  modalPurpose = purpose;
  modalTitle.textContent = title;
  modalLabel.textContent = label;
  modalInput.value = defVal;
  modalCoordsysRow.style.display = 'none';
  modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => { modalInput.focus(); modalInput.select(); }, 50);
}

function renameFileNode(fileNode) {
  const modelId = fileNode.getAttribute('data-model-id');
  const model = state.models.find(m => m.id === modelId);
  if (!model) return;
  const span = fileNode.querySelector('span');
  const curName = span ? span.textContent : model.fileName;
  pendingRenameModelFile = { node: fileNode, cur: curName };
  openRenameInputDialog('model-file-rename', 'Rename 3D model', 'Rename (Display name, The original file is unchanged) : ', curName);
}

function applyFileRename(obj, newName) {
  if (!obj || !obj.node) return;
  const fileNode = obj.node;
  const modelId = fileNode.getAttribute('data-model-id');
  const model = state.models.find(m => m.id === modelId);
  if (!model) return;
  const span = fileNode.querySelector('span');
  // the project tree
  if (span) span.textContent = newName;
  // the layer management
  const lmName = lmList.querySelector('.lm-item[data-model-id="' + modelId + '"] .lm-name');
  if (lmName) lmName.textContent = newName;
  // the state
  model.displayName = newName;
  // the property panel
  if (state.selectedModelId === modelId) refreshCurrentProperties();
  // the legend
  updateLegend();
}

function renameModelNode(modelNode) {
  const span = modelNode.querySelector('span');
  if (!span) return;
  const curName = span.textContent;
  pendingRenameModelGroup = { node: modelNode, cur: curName };
  openRenameInputDialog('model-group-rename', 'Rename model category', 'Rename category (Display name) : ', curName);
}

function applyModelGroupRename(obj, newName) {
  if (!obj || !obj.node) return;
  const span = obj.node.querySelector('span');
  if (span) span.textContent = newName;
}

// logic
function exportFileNode(fileNode) {
  const modelId = fileNode.getAttribute('data-model-id');
  const model = state.models.find(m => m.id === modelId);
  if (!model) return;
  // )
  const objText = meshToOBJ(model.mesh, model.fileName || model.displayName || 'model');
  const baseName = (model.displayName || model.fileName || 'model').replace(/\.[^.]+$/, '');
  downloadTextFile(objText, baseName + '.obj', 'text/plain');
}

function exportModelNode(modelNode) {
  const nested = modelNode.nextElementSibling;
  if (!nested) return;
  const fileNodes = nested.querySelectorAll('.lp-sub-item[data-model-id]');
  if (fileNodes.length === 0) { alert('This model has no 3D files to export'); return; }
  const modelName = ((modelNode.querySelector('span') || {}).textContent || 'model').replace(/[\\/:*?"<>|]/g, '_');
  // ,
  fileNodes.forEach((fn, idx) => {
    setTimeout(() => {
      const modelId = fn.getAttribute('data-model-id');
      const model = state.models.find(m => m.id === modelId);
      if (!model) return;
      const objText = meshToOBJ(model.mesh, (model.displayName || model.fileName || 'model'));
      const baseName = (model.displayName || model.fileName || 'model_' + idx).replace(/\.[^.]+$/, '');
      downloadTextFile(objText, modelName + '_' + baseName + '.obj', 'text/plain');
    }, idx * 200);
  });
}

// the OBJ serialisation utility
function meshToOBJ(mesh, name) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const idx = geo.index;
  let lines = ['o ' + (name || 'mesh')];
  for (let i = 0; i < pos.count; i++) {
    lines.push('v ' + pos.getX(i).toFixed(6) + ' ' + pos.getY(i).toFixed(6) + ' ' + pos.getZ(i).toFixed(6));
  }
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      lines.push('f ' + (idx.getX(i) + 1) + ' ' + (idx.getX(i + 1) + 1) + ' ' + (idx.getX(i + 2) + 1));
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      lines.push('f ' + (i + 1) + ' ' + (i + 2) + ' ' + (i + 3));
    }
  }
  return lines.join('\n');
}
function downloadTextFile(text, filename, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================================================
// vertices
// )
// ,
// the coordinate system matches GOCAD: X east, Y north, Z elevation, so three = [X, Z, -Y]
// ============================================================
function parseTunnelModel(strText, dtmText, fileName) {
  const vertices = [];
  // vertices
  let declaredPoints = 0;
  const dtmHeadLines = String(dtmText || '').split(/\r?\n/);
  for (const raw of dtmHeadLines) {
    const m = raw.trim().match(/^POINTS\s+(\d+)/i);
    if (m) { declaredPoints = parseInt(m[1], 10); break; }
  }
  // vertices
  const strLines = String(strText || '').split(/\r?\n/);
  for (const raw of strLines) {
    const line = raw.trim();
    if (!line) continue;
    if (/TUNNEL|WIREFRAME|HEADER/i.test(line)) continue;   // header
    if (/END/i.test(line)) continue;                        // 结束标记
    const vals = line.split(',').map(s => s.trim()).filter(s => s !== '');
    if (vals.length < 4) continue;
    const x = parseFloat(vals[1]), y = parseFloat(vals[2]), z = parseFloat(vals[3]);
    if (isNaN(x) || isNaN(y) || isNaN(z)) continue;
    // ,
    // vertices
    if (vals[0] === '0' && x === 0 && y === 0 && z === 0) continue;
    // vertices
    if (declaredPoints > 0 && vertices.length / 3 >= declaredPoints) break;
    // the same axis swap as GOCAD: three = [X, Z (elevation), -Y (north negated)]
    vertices.push(x, z, -y);
  }
  if (vertices.length < 9) throw new Error('.str No valid vertices were found (Requires at least 3 points) ');

  // )
  const indices = [];
  const dtmLines = String(dtmText || '').split(/\r?\n/);
  for (const raw of dtmLines) {
    const line = raw.trim();
    if (!line) continue;
    if (/POINTS|TRIANGLES|TUNNEL|WIREFRAME|HEADER/i.test(line)) continue;
    const vals = line.split(',').map(s => s.trim()).filter(s => s !== '');
    if (vals.length < 4) continue;
    const a = parseInt(vals[1], 10), b = parseInt(vals[2], 10), c = parseInt(vals[3], 10);
    if (isNaN(a) || isNaN(b) || isNaN(c)) continue;
    if (a < 1 || b < 1 || c < 1) continue;
    indices.push(a - 1, b - 1, c - 1);
  }
  if (indices.length < 3) throw new Error('.dtm No valid triangles were found');

  // check that the triangle indices are in range
  const vcount = vertices.length / 3;
  for (const idx of indices) {
    if (idx >= vcount) throw new Error('.dtm Triangle index ' + (idx + 1) + ' exceeds the vertex count ' + vcount);
  }

  // )
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const rx = vertices[i];        // 原始 X
    const ry = -vertices[i + 2];   // )
    const rz = vertices[i + 1];    // )
    if (rx < minX) minX = rx;
    if (ry < minY) minY = ry;
    if (rz < minZ) minZ = rz;
  }
  let fileOrigin = null;
  if (minX !== Infinity) {
    fileOrigin = {
      x: Math.floor(minX / 100) * 100,
      y: Math.floor(minY / 100) * 100,
      z: Math.floor(minZ / 100) * 100
    };
    console.log('[Tunnel parser] Suggested file origin:', fileOrigin.x, fileOrigin.y, fileOrigin.z);
  }

  return {
    name: (fileName || 'tunnel').replace(/\.(str|dtm)$/i, ''),
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    fileOrigin: fileOrigin
  };
}

fileInput.addEventListener('change', async (e) => {
  const files = e.target.files;
  if (!files || files.length === 0 || !pendingCategoryItem) return;

  const importCategory = pendingCategoryItem;
  const importRegion = window.researchRegions ? researchRegions.ownerOf(importCategory) : undefined;
  const isGeochem = pendingCategoryItem.getAttribute('data-role') === 'geochem-model-node';
  const isTunnel = pendingCategoryItem.getAttribute('data-role') === 'tunnel-model-node';
  let fileArr = Array.from(files);
  // ,
  if (pendingModelImportKind === 'obj') {
    fileArr = fileArr.filter(f => /\.obj$/i.test(f.name));
  } else {
    // the TS entry point does not allow a .obj to slip into the geochemical, tunnel or ordinary geological models
    fileArr = fileArr.filter(f => !/\.obj$/i.test(f.name));
  }
  if (fileArr.length === 0) {
    alert(pendingModelImportKind === 'obj'
      ? 'Select .obj model files (Applied by“Import OBJ Model”Filter) '
      : 'This action only imports .ts/.str/.dtm Model file, Filtered out .obj File, Select again');
    fileInput.value = '';
    return;
  }
  // ,
  let lastModelId = null;
  try {
  if (isGeochem) {
    // ,
    const numericValues = fileArr.map(f => extractFirstNumber(f.name));
    const validValues = numericValues.filter(v => v !== null);
    const minVal = validValues.length > 0 ? Math.min.apply(null, validValues) : 0;
    const maxVal = validValues.length > 0 ? Math.max.apply(null, validValues) : 0;
    const total = fileArr.length;

    // )
    // ,
    const sortedIdx = fileArr.map((_, i) => i).sort((a, b) => {
      const va = numericValues[a] === null ? -Infinity : numericValues[a];
      const vb = numericValues[b] === null ? -Infinity : numericValues[b];
      return va - vb;
    });
    const rankMap = new Map();
    sortedIdx.forEach((origIdx, rank) => rankMap.set(origIdx, rank));

    for (let i = 0; i < fileArr.length; i++) {
      const file = fileArr[i];
      const num = numericValues[i];
      const rank = rankMap.get(i);
      const { color, opacity } = computeGeochemColor(num, minVal, maxVal, rank, total);
      try {
        const geoMesh = await parseLocalModel(getFilePath(file), null, async () => parseGOCADTS(await file.text()));
        geoMesh.source = { fileName: file.name };
        // )
        const fpGC = getFilePath(file);
        if (fpGC) geoCacheTsPut(fpGC, geoMesh);
        pendingCategoryItem = importCategory;
        if(window.researchRegionViews)await researchRegionViews.ensure(importRegion);
        const m = loadModelToScene(geoMesh, 'Geochemistry', file.name, { color, opacity, regionId: importRegion, filePath: getFilePath(file), deferSceneRefresh: true });
        if (m) lastModelId = m.id;
      } catch (err) {
        hideImportLoading();
        alert('Parse.ts file failed [ ' + file.name + ']：' + err.message);
      }
    }
  } else if (isTunnel) {
    // vertices
    showImportLoading('Parsing tunnel model...');
    await yieldToUI();
    const strFiles = fileArr.filter(f => /\.str$/i.test(f.name));
    const dtmFiles = fileArr.filter(f => /\.dtm$/i.test(f.name));
    if (strFiles.length === 0 && dtmFiles.length === 0) {
      hideImportLoading();
      alert('A tunnel model requires .str (Vertex) + .dtm (Triangle) Import the two files as a pair\n Select, for example, tunnel_test.str and tunnel_test.dtm file pair with a matching base name. ');
    } else {
      // )
      const dtmByName = {};
      dtmFiles.forEach(f => { dtmByName[f.name.replace(/\.dtm$/i, '')] = f; });
      const paired = [];
      strFiles.forEach(sf => {
        const base = sf.name.replace(/\.str$/i, '');
        if (dtmByName[base]) { paired.push([sf, dtmByName[base]]); delete dtmByName[base]; }
      });
      // vertices
      Object.keys(dtmByName).forEach(base => {
        if (strFiles.length === 0) paired.push([null, dtmByName[base]]);
      });
      if (paired.length === 0) {
        hideImportLoading();
        alert('No matching .str/.dtm File pair. \n Select both files with the same base name (e.g. tunnel_test.str + tunnel_test.dtm) . ');
      }
      for (const [sf, df] of paired) {
        try {
          const geoMesh = await parseLocalModel(getFilePath(df), sf ? getFilePath(sf) : null,
            async () => parseTunnelModel(sf ? await sf.text() : '', await df.text(), df.name));
          geoMesh.source = { fileName: df.name };
          // )
          const fpStr = sf ? getFilePath(sf) : null;
          const fpDtm = getFilePath(df);
          if (fpStr && fpDtm) geoCacheTunnelPut(fpStr, fpDtm, geoMesh);
          pendingCategoryItem = importCategory;
          if(window.researchRegionViews)await researchRegionViews.ensure(importRegion);
        const m = loadModelToScene(geoMesh, '3D Tunnel Models', df.name, { regionId: importRegion, filePath: getFilePath(df), strFilePath: sf ? getFilePath(sf) : null, deferSceneRefresh: true });
          if (m) lastModelId = m.id;
        } catch (err) {
          hideImportLoading();
          alert('Unable to parse tunnel model [ ' + df.name + ']：' + err.message);
        }
      }
      hideImportLoading();
    }
  } else {
    // )
    const category = pendingCategoryItem.getAttribute('data-category');
    for (const file of fileArr) {
      try {
        const isObj = /\.obj$/i.test(file.name);
        const geoMesh = await parseLocalModel(getFilePath(file), null, async () => {
          const text = await file.text();
          return isObj ? parseOBJText(text, file.name) : parseGOCADTS(text);
        });
        geoMesh.source = { fileName: file.name };
        // )
        const fpGC = getFilePath(file);
        if (fpGC) geoCacheTsPut(fpGC, geoMesh);
        pendingCategoryItem = importCategory;
        if(window.researchRegionViews)await researchRegionViews.ensure(importRegion);
        const m = loadModelToScene(geoMesh, category, file.name, { regionId: importRegion, filePath: getFilePath(file), deferSceneRefresh: true });
        if (m) lastModelId = m.id;
      } catch (err) {
        hideImportLoading();
        alert('Unable to parse file [ ' + file.name + ']：' + err.message);
      }
    }
  }
  // the legend
  if (lastModelId) {
    updateLegend();
    updateRenderOrder();
    fitViewToAll();
    selectLayer(lastModelId);
    buildAxisLabels();
  }

  // reset the input so that the same file can be chosen again
  } finally {
    hideImportLoading();
    fileInput.value = '';
  }
});

// ============================================================
// load the model into the scene
// ============================================================
function loadModelToScene(geoMesh, category, fileName, options) {
  options = options || {};
  // guard against duplicates: a file with the same name is skipped if it already exists
  const regionId = options.regionId || (window.researchRegions ? researchRegions.ownerOf(pendingCategoryItem) : undefined);
  const existing = state.models.find(m => m.fileName === fileName && (!regionId || m.regionId === regionId));
  if (existing) {
    console.warn('[loadModelToScene] A model with this name already exists, Skip: ' + fileName);
    return;
  }

  // apply the offset according to the state.origin of the current tab
  // ,
  // Different tabs may have different origins, which lets models in different coordinate systems be shown in separate tabs
  // ,
  if (!state.origin) {
    if (geoMesh.fileOrigin) {
      state.origin = { x: geoMesh.fileOrigin.x, y: geoMesh.fileOrigin.y, z: geoMesh.fileOrigin.z };
      console.log('[loadModelToScene] Initialize the current tab origin =', state.origin);
    } else {
      state.origin = { x: 0, y: 0, z: 0 };
      console.warn('[loadModelToScene] geoMesh.fileOrigin Missing, origin Use (0,0,0)');
    }
  }
  const ox = state.origin.x, oy = state.origin.y, oz = state.origin.z;

  // vertices
  // ,
  //     rawThreeX = GOCAD_X          →  threeX = rawThreeX - ox
  // )
  // )
  const rawVerts = geoMesh.vertices;
  const offsetVerts = new Float32Array(rawVerts.length);
  for (let i = 0; i < rawVerts.length; i += 3) {
    offsetVerts[i]     = rawVerts[i]     - ox;
    offsetVerts[i + 1] = rawVerts[i + 1] - oz;
    offsetVerts[i + 2] = rawVerts[i + 2] + oy;
  }

  // convert to a BufferGeometry
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(offsetVerts, 3));
  geo.setIndex(new THREE.Uint32BufferAttribute(geoMesh.indices, 1));
  geo.computeVertexNormals();

  // ,
  // )

  // the colour and opacity resolution order is:
  // 
  // 
  // 
  let color;
  if (options.color !== undefined) {
    color = options.color;
  } else {
    // )
    // ,
    const fileColor = matchFileColor(fileName);
    const preferred = fileColor !== null ? fileColor : (CATEGORY_COLORS[category] || 0x888888);
    color = pickUniqueModelColor(preferred);
  }
  const opacity = options.opacity !== undefined ? options.opacity : 0.92;
  const material = new THREE.MeshStandardMaterial({
    color: color,
    transparent: true,
    opacity: opacity,
    roughness: 0.7,
    metalness: 0.05,
    side: THREE.DoubleSide,
    // ,
    depthWrite: category !== 'Geochemistry'
  });

  // ,
  if (state.clipMode) {
    const planes = getActiveClipPlanes();
    if (planes.length > 0) {
      material.clippingPlanes = planes;
      material.clipShadows = true;
    }
  }

  const modelId = 'model_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

  const mesh = new THREE.Mesh(geo, material);
  mesh.visible = true;
  mesh.userData.isModel = true;
  // ,
  mesh.userData.modelId = modelId;
  scene.add(mesh);

  // remove the placeholder cube
  if (state.placeholderMesh) {
    scene.remove(state.placeholderMesh);
    state.placeholderMesh.geometry.dispose();
    state.placeholderMesh.material.dispose();
    state.placeholderMesh = null;
    const _ep = document.getElementById('empty-placeholder');
    if (_ep) _ep.classList.add('hidden');
  }

  const modelObj = {
    id: modelId,
    name: geoMesh.name,
    category: category,
    mesh: mesh,
    material: material,
    visible: true,
    opacity: opacity,
    color: color,
    fileName: fileName,
    regionId: regionId,
    filePath: options.filePath || null,        // )
    strFilePath: options.strFilePath || null,  // )
    geoMesh: geoMesh,
    treeFileNode: null,
    inScene: true  // ,
  };
  state.models.push(modelObj);

  // )
  if (geoMesh.terrainInfo && typeof applyTerrainDisplay === 'function') applyTerrainDisplay(modelObj, options.terrainSettings);
  const cacheEntry = { geoMesh, category, options: Object.assign({}, options, { regionId }) };
  geoMeshCache.set(fileName, cacheEntry);
  geoMeshCache.set(modelId, cacheEntry);

  // add the file name node beneath the matching category folder in the project tree
  if (!options || !options.skipTreeNode) {
    addFileNodeToCategory(pendingCategoryItem, fileName, modelObj);
  }

  // add the layer entry to the layer management
  addLayerItem(modelObj);

  // ,
  // ,
  // .
  if (!options.deferSceneRefresh) {
    // update the legend
    updateLegend();

    // set the renderOrder
    updateRenderOrder();

    // adjust the camera
    fitViewToAll();

    // select that layer
    selectLayer(modelId);

    // refresh the coordinate axis labels
    buildAxisLabels();
  }
  return modelObj;
}

// add the file name node beneath the category
function addFileNodeToCategory(categoryItem, fileName, modelObj) {
  const nested = categoryItem.nextElementSibling;
  if (!nested || !nested.classList.contains('lp-nested-items')) return;
  // guard against duplicates: a file node with the same name is skipped if it already exists
  const existingNode = Array.from(nested.children).find(child => {
    const sp = child.querySelector('span');
    return sp && sp.textContent === fileName;
  });
  if (existingNode) return;
  const fileNode = document.createElement('div');
  fileNode.className = 'lp-sub-item';
  fileNode.setAttribute('data-model-id', modelObj.id);
  if (modelObj.regionId) fileNode.dataset.regionId = modelObj.regionId;
  fileNode.setAttribute('draggable', 'true'); // 支持拖拽到三维画布恢复显示
  fileNode.innerHTML =
    '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>' +
    '<span>' + escapeHtml(fileName) + '</span>';
  fileNode.addEventListener('click', (e) => {
    e.stopPropagation();
    selectLayer(modelObj.id);
  });
  // ,
  setupNodeDraggable(fileNode, { type: 'file', modelId: modelObj.id });
  fileNode._ctxBound = true;
  fileNode.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ctxContext = { type: 'file', target: fileNode };
    filterCtxMenu('file');
    showCtxMenu(e.clientX, e.clientY);
  });
  nested.appendChild(fileNode);
  modelObj.treeFileNode = fileNode;
}

// ============================================================
// the layer management
// ============================================================
let lmList = document.getElementById('lm-list');
let lmEmpty = document.getElementById('lm-empty');
const normalLayerEmpty = lmEmpty;

// ============================================================
// project tree node
// ============================================================

// the project tree
function removeModelFromView(model) {
  if (!model) return;
  // 1. remove the mesh from the scene
  if (model.mesh && model.mesh.parent) model.mesh.parent.remove(model.mesh);
  model.inScene = false;
  // ,
  // ,
  // the project tree
  // ,
  // ,
  model._visibleBeforeRemove = (model.visible !== false);
  model.visible = false;
  // 2. delete the layer management entry
  const lmItem = lmList.querySelector('.lm-item[data-model-id="' + model.id + '"]');
  if (lmItem) lmItem.remove();
  // 3. grey out the file name in the project tree
  if (model.treeFileNode) model.treeFileNode.classList.add('dim');
  // ,
  if (state.selectedModelId === model.id) {
    clearSelectionState();
  }
  // refresh the legend
  updateLegend();
  buildAxisLabels();
  const visibleModels = state.models.filter(m => m.inScene);
  if (visibleModels.length === 0) lmEmpty.style.display = '';
}

// the project tree
function addModelToView(model) {
  if (!model) return;
  if (model.inScene) return; // ,
  // 1. put the mesh back into the scene
  scene.add(model.mesh);
  model.inScene = true;
  // ,
  // )
  // ,
  const restoreVisible = (model._visibleBeforeRemove !== false);
  model.visible = restoreVisible;
  model.mesh.visible = restoreVisible;
  delete model._visibleBeforeRemove;
  // 2. add the layer management entry
  addLayerItem(model);
  // 3. restore the file name in the project tree
  if (model.treeFileNode) model.treeFileNode.classList.remove('dim');
  // remove the placeholder cube
  if (state.placeholderMesh) {
    scene.remove(state.placeholderMesh);
    state.placeholderMesh.geometry.dispose();
    state.placeholderMesh.material.dispose();
    state.placeholderMesh = null;
    const _ep = document.getElementById('empty-placeholder');
    if (_ep) _ep.classList.add('hidden');
  }
  // refresh the legend
  updateLegend();
  updateRenderOrder();
  buildAxisLabels();
}

function addLayerItem(model, allowAutoTop) {
  // guard against duplicates: an entry with the same model id is skipped if it already exists
  const existing = lmList.querySelector('.lm-item[data-model-id="' + model.id + '"]');
  if (existing) return;
  // hide the empty state
  lmEmpty.style.display = 'none';

  const item = document.createElement('div');
  const isDrillLike = !!(model.isCollarPoints || model.isDrillhole || model.isLithologyDrillhole || model.isGeochemDrillhole);
  item.className = 'lm-item'
    + (model.isRegisterPlane ? ' is-register-plane' : '')
    + (isDrillLike ? ' lm-drill-item' : ' lm-model-item');
  item.setAttribute('data-model-id', model.id);
  item.draggable = true;

  const pct = Math.round(model.opacity * 100);
  // the project tree
  // )
  const lmDisplayName = model.displayName || model.fileName;

  // )
  // the layer management
  // the state
  // the property panel
  // ,
  // .
  const eyeHidden = (model.visible === false);
  const eyeHtml =
    '<span class="lm-eye' + (eyeHidden ? ' off' : '') + '" title="' +
      (eyeHidden ? 'Hide in 3D view (Click to show) ' : 'Show in 3D view (Click to hide) ') +
    '">' +
      '<span class="lm-eye-on">👁</span>' +
      '<span class="lm-eye-off">👁‍🗨</span>' +
    '</span>';
  if (eyeHidden) item.classList.add('lm-hidden');

  if (isDrillLike) {
    // )
    // the drillhole file name on the far left, then the colour and settings entry, the thickness slider, the opacity slider and the cross on the far right
    // ,
    let colorTitle = 'Drillhole settings';
    if (model.isGeochemDrillhole) colorTitle = 'Set color scale';
    else if (model.isLithologyDrillhole) colorTitle = 'Set lithology colors';
    const colorBtnHtml = '<span class="lm-litho-btn" title="' + colorTitle + '">🎨</span>';

    // )
    let radiusHtml = '';
    if ((model.isDrillhole || model.isLithologyDrillhole || model.isGeochemDrillhole)
        && typeof model.radius === 'number') {
      if (model._lmRadiusMax == null) model._lmRadiusMax = Math.max(10, model.radius * 5);
      const minR = 0.1;
      const rp = Math.round(((model.radius - minR) / (model._lmRadiusMax - minR)) * 100);
      const clamp = (v) => Math.max(0, Math.min(100, v));
      radiusHtml =
        '<div class="lm-ctl-wrap lm-radius-ctl" title="Cylinder radius">' +
          '<span class="lm-ctl-label">Width</span>' +
          '<div class="lm-slider lm-radius-slider">' +
            '<div class="lm-sfill" style="width:' + clamp(rp) + '%"></div>' +
            '<div class="lm-sthumb" style="left:' + clamp(rp) + '%"></div>' +
          '</div>' +
          '<span class="lm-radius-val">' + model.radius.toFixed(2) + '</span>' +
        '</div>';
    }

    // )
    const opacityHtml =
        '<div class="lm-ctl-wrap lm-opacity-ctl" title="Layer opacity">' +
          '<span class="lm-ctl-label">Opacity</span>' +
          '<div class="lm-slider">' +
            '<div class="lm-sfill" style="width:' + pct + '%"></div>' +
            '<div class="lm-sthumb" style="left:' + pct + '%"></div>' +
          '</div>' +
          '<span class="lm-opacity-val">' + pct + '%</span>' +
        '</div>';

    item.innerHTML =
      '<span class="lm-name" title="' + escapeHtml(lmDisplayName) + '">' + escapeHtml(lmDisplayName) + '</span>' +
      colorBtnHtml +
      radiusHtml +
      opacityHtml +
      eyeHtml +
      '<span class="lm-delete" title="Remove from 3D view">❌</span>';
    lmList.appendChild(item);
    bindLayerItemEvents(item, model);
    reorderImageLayerToTop(item, model, allowAutoTop);
    return;
  }

  // )
  const hex = '#' + model.color.toString(16).padStart(6, '0');
  item.innerHTML =
    '<span class="lm-name" title="' + escapeHtml(lmDisplayName) + '">' + escapeHtml(lmDisplayName) + '</span>' +
    '<div class="lm-color" style="background:' + hex + '"></div>' +
    '<div class="lm-ctl-wrap lm-opacity-ctl" title="Layer opacity">' +
      '<span class="lm-ctl-label">Opacity</span>' +
      '<div class="lm-slider">' +
        '<div class="lm-sfill" style="width:' + pct + '%"></div>' +
        '<div class="lm-sthumb" style="left:' + pct + '%"></div>' +
      '</div>' +
      '<span class="lm-opacity-val">' + pct + '%</span>' +
    '</div>' +
    eyeHtml +
    '<span class="lm-delete" title="Remove from 3D view">❌</span>';

  lmList.appendChild(item);
  bindLayerItemEvents(item, model);
  reorderImageLayerToTop(item, model, allowAutoTop);
  if (typeof mountTerrainLayerControls === 'function') mountTerrainLayerControls(model, item);
  if (typeof mountTerrainImageCrop === 'function') mountTerrainImageCrop(model, item);
  window.rockTexture?.mount(model,item);
}

// ============================================================
// )
// ============================================================
// 
//
// ,
// ,
// ,
// .
//
// why this is a separate function instead of a prepend inside addLayerItem:
// ,
// ,
// 
// ,
//
// ,
function reorderImageLayerToTop(item, model, allowAutoTop) {
  if (!item || !model) return;
  if (!model.isRegisterPlane) return;
  // ,
  if (allowAutoTop === false) return;
  if (item.parentNode !== lmList) return;
  if (lmList.firstElementChild === item) return;   // 已在最前
  lmList.insertBefore(item, lmList.firstElementChild);
}

// ============================================================
// ,
// so that the bindings are not repeated and permanently accumulated every time a layer entry is added or the settings panel is opened
// ============================================================
const dragDelegate = { active: false, onMove: null, blockedItem:null };
function finishLayerControlDrag(){
  dragDelegate.active=false;dragDelegate.onMove=null;
  if(dragDelegate.blockedItem){dragDelegate.blockedItem.draggable=dragDelegate.previousDraggable;dragDelegate.blockedItem.classList.remove('dragging','drag-over');dragDelegate.blockedItem=null;document.body.style.userSelect=dragDelegate.previousUserSelect||'';}
}
function beginLayerControlDrag(event,item){
  event.preventDefault();event.stopPropagation();finishLayerControlDrag();
  dragDelegate.blockedItem=item;dragDelegate.previousDraggable=item.draggable;dragDelegate.previousUserSelect=document.body.style.userSelect;
  item.draggable=false;item.classList.remove('dragging','drag-over');document.body.style.userSelect='none';
}
if (!document.__dragDelegateBound) {
  document.__dragDelegateBound = true;
  document.addEventListener('mousemove', (e) => {
    if (dragDelegate.active && dragDelegate.onMove) dragDelegate.onMove(e);
  });
  document.addEventListener('mouseup', () => {
    finishLayerControlDrag();
  });
  window.addEventListener('blur',finishLayerControlDrag);
  window.addEventListener('pointercancel',finishLayerControlDrag);
}

function bindLayerItemEvents(item, model) {
  item.addEventListener('click',event=>{
    if(event.target.closest('.lm-delete,.lm-eye,.lm-ctl-wrap,.lm-slider,.lm-color,.lm-litho-btn,.lm-setting-btn,input,button,select'))return;
    selectLayer(model.id);
  });
  const delBtn = item.querySelector('.lm-delete');
  // ,
  const opCtlEl = item.querySelector('.lm-opacity-ctl');
  const slider = opCtlEl ? opCtlEl.querySelector('.lm-slider') : item.querySelector('.lm-slider');
  const sfill = slider ? slider.querySelector('.lm-sfill') : null;
  const sthumb = slider ? slider.querySelector('.lm-sthumb') : null;
  const opVal = item.querySelector('.lm-opacity-val');
  const colorBox = item.querySelector('.lm-color');
  const lithoBtn = item.querySelector('.lm-litho-btn');
  const settingBtn = item.querySelector('.lm-setting-btn');
  const radiusSlider = item.querySelector('.lm-radius-ctl .lm-slider');
  const radiusVal = item.querySelector('.lm-radius-val');

  // the project tree
  // ,
  // ,
  // ,
  // 
  // )
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeModelFromView(model);
  });

  // 
  // the implementation points:
  // ,
  // 
  // ,
  // ,
  // the property panel
  const eyeBtn = item.querySelector('.lm-eye');
  if (eyeBtn) {
    eyeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowVisible = (model.visible === false);   // 当前隐藏 → 本次要显示
      model.visible = nowVisible;
      if (model.mesh) model.mesh.visible = nowVisible;
      // ,
      // ,
      if (state.selectionOutline && model.mesh && state.selectionOutline.parent === model.mesh) {
        state.selectionOutline.visible = nowVisible;
      }
      // the state
      eyeBtn.classList.toggle('off', !nowVisible);
      eyeBtn.title = nowVisible ? 'Show in 3D view (Click to hide) ' : 'Hide in 3D view (Click to show) ';
      item.classList.toggle('lm-hidden', !nowVisible);
      // linked to: the legend, the coordinate axis labels and the property panel
      updateLegend();
      buildAxisLabels();
      if (state.selectedModelId === model.id) refreshCurrentProperties();
    });
  }

  // the colour and settings entry opens the matching panel for the drillhole type
  // a lithology drillhole opens the lithology colouring panel, a geochemical drillhole opens the colour scale panel, and a single colour drillhole or a collar point opens the drillhole settings panel
  if (lithoBtn) {
    lithoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (model.isGeochemDrillhole) openGeochemColorPanel(model);
      else if (model.isLithologyDrillhole) openLithologyColorPanel(model);
      else if (model.isPointLayer) openPointColorPanel(model);
      else openDrillSettingPanel(model);
    });
  }
  // )
  if (settingBtn) {
    settingBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDrillSettingPanel(model);
    });
  }

  // )
  if (colorBox) {
    if (model.isLithologyDrillhole || model.isGeochemDrillhole) {
      const openColorPanel = (e) => {
        e.stopPropagation();
        if (model.isGeochemDrillhole) {
          openGeochemColorPanel(model);
        } else {
          openLithologyColorPanel(model);
        }
      };
      colorBox.addEventListener('click', openColorPanel);
    } else {
      // ,
      colorBox.addEventListener('click', (e) => {
        e.stopPropagation();
        const picker = document.createElement('input');
        picker.type = 'color';
        const hex = '#' + model.color.toString(16).padStart(6, '0');
        picker.value = hex;
        picker.style.position = 'fixed';
        picker.style.left = '-9999px';
        document.body.appendChild(picker);
        picker.click();
        picker.addEventListener('input', () => {
          const newColor = parseInt(picker.value.slice(1), 16);
          model.color = newColor;
          if (model.materials) model.materials.forEach(mt => mt.color.setHex(newColor));
          else model.material.color.setHex(newColor);
          colorBox.style.background = picker.value;
          if (state.selectedModelId === model.id) refreshCurrentProperties();
          updateLegend();
        });
        picker.addEventListener('change', () => {
          document.body.removeChild(picker);
        });
      });
    }
  }

  // the property panel
  function updateOpacity(clientX) {
    const rect = slider.getBoundingClientRect();
    let p = (clientX - rect.left) / rect.width;
    p = Math.max(0, Math.min(1, p));
    const percent = Math.round(p * 100);
    sfill.style.width = percent + '%';
    sthumb.style.left = percent + '%';
    opVal.textContent = percent + '%';
    // )
    if (model.materials) model.materials.forEach(mt => mt.opacity = p);
    else model.material.opacity = p;
    model.opacity = p;
  }
  slider.addEventListener('mousedown', (e) => {
    if(e.button!==0)return;
    beginLayerControlDrag(e,item);
    dragDelegate.active = true;
    dragDelegate.onMove = (ev) => {
      updateOpacity(ev.clientX);
      // the property panel
      if (state.selectedModelId === model.id) refreshCurrentProperties();
    };
    updateOpacity(e.clientX);
  });

  // ,
  if (radiusSlider) {
    if (model._lmRadiusMax == null) {
      model._lmRadiusMax = Math.max(10, (typeof model.radius === 'number' ? model.radius : 1) * 5);
    }
    const minR = 0.1;
    const maxR = model._lmRadiusMax;
    const rsfill = radiusSlider.querySelector('.lm-sfill');
    const rsthumb = radiusSlider.querySelector('.lm-sthumb');
    function updateRadiusAt(clientX) {
      const rect = radiusSlider.getBoundingClientRect();
      let p = (clientX - rect.left) / rect.width;
      p = Math.max(0, Math.min(1, p));
      const newR = minR + p * (maxR - minR);
      const pp = p * 100;
      rsfill.style.width = pp + '%';
      rsthumb.style.left = pp + '%';
      if (radiusVal) radiusVal.textContent = newR.toFixed(2);
      applyDrillholeRadius(model, newR);
      if (state.selectedModelId === model.id) refreshCurrentProperties();
    }
    radiusSlider.addEventListener('mousedown', (e) => {
      if(e.button!==0)return;
      beginLayerControlDrag(e,item);
      dragDelegate.active = true;
      dragDelegate.onMove = (ev) => updateRadiusAt(ev.clientX);
      updateRadiusAt(e.clientX);
    });
  }

  // double-click a layer entry to focus the camera on that model
  item.addEventListener('dblclick', (e) => {
    if (e.target.closest('.lm-delete') || e.target.closest('.lm-eye') || e.target.closest('.lm-ctl-wrap') || e.target.closest('.lm-color') || e.target.closest('.lm-litho-btn') || e.target.closest('.lm-setting-btn')) return;
    focusModel(model);
  });

  // the property panel
  item.addEventListener('dragstart', (e) => {
    if(dragDelegate.active||e.target.closest('.lm-ctl-wrap,.lm-slider,.lm-color,.lm-eye,.lm-delete,input,button,select')){e.preventDefault();return;}
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', model.id);
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    document.querySelectorAll('.lm-item').forEach(i => i.classList.remove('drag-over'));
    updateRenderOrder();
    refreshCurrentProperties();
  });
  item.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.lm-item').forEach(i => i.classList.remove('drag-over'));
    item.classList.add('drag-over');
  });
  item.addEventListener('drop', (e) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('text/plain');
    if (draggedId === model.id) return;
    const draggedItem = lmList.querySelector('.lm-item[data-model-id="' + draggedId + '"]');
    if (!draggedItem) return;
    const items = Array.from(lmList.querySelectorAll('.lm-item'));
    const dragIdx = items.indexOf(draggedItem);
    const dropIdx = items.indexOf(item);
    if (dragIdx < dropIdx) {
      lmList.insertBefore(draggedItem, item.nextSibling);
    } else {
      lmList.insertBefore(draggedItem, item);
    }
  });
}

// )
function updateRenderOrder() {
  const items = Array.from(lmList.querySelectorAll('.lm-item'));
  // )
  // ,
  // ,
  // ,
  // ,
  // ,
  // ,
  items.forEach((item, idx) => {
    const model = state.models.find(m => m.id === item.getAttribute('data-model-id'));
    if (model && model.mesh) model.mesh.renderOrder = items.length - idx;
  });
}

// ============================================================
// ,
// ============================================================
const lithoPanel = document.getElementById('litho-panel');
const lithoPanelBody = document.getElementById('litho-panel-body');
const lithoPanelFooter = document.getElementById('litho-panel-footer');
const lithoPanelTitle = lithoPanel.querySelector('.litho-panel-header span');
let lithoPanelModelId = null; // 当前面板绑定的岩性钻孔模型 id

// ,
// )
// ,
// )
// note: while the draft is open, state.lithologyColors is not written, updateLegend() is not called and nothing is written to disk,
// .
let lithoDraft = null;
let lithoSnapshot = null;
let lithoSelVein = null;

// ,
function closeLithoPanel() {
  lithoPanel.classList.remove('visible');
  lithoPanelFooter.style.display = 'none';
  lithoPanelModelId = null;
  lithoDraft = null;
  lithoSnapshot = null;
  lithoSelVein = null;
}

// restore the draft: put the materials and lithologyTypes back as they were when the panel was opened
function revertLithoDraft(model) {
  if (!model || !lithoSnapshot) return;
  Object.keys(lithoSnapshot).forEach(name => {
    const c = lithoSnapshot[name];
    if (model.mesh) {
      model.mesh.traverse(obj => {
        if (obj.userData && obj.userData.isDrillhole && obj.userData.vein === name && obj.material) {
          obj.material.color.setHex(c);
        }
      });
    }
    const lt = model.lithologyTypes.find(t => t.name === name);
    if (lt) lt.color = c;
  });
}

// ,
function requestCloseLithoPanel() {
  const model = state.models.find(m => m.id === lithoPanelModelId);
  if (lithoDraft && lithoDraft.size > 0 && model) {
    if (!confirm('with ' + lithoDraft.size + ' color changes have not been confirmed, Discard the changes??')) return false;
    revertLithoDraft(model);
  }
  closeLithoPanel();
  return true;
}

document.getElementById('litho-panel-close').addEventListener('click', () => { requestCloseLithoPanel(); });

document.getElementById('litho-panel-cancel').addEventListener('click', (e) => {
  e.stopPropagation();
  requestCloseLithoPanel();
});

// the legend
document.getElementById('litho-panel-confirm').addEventListener('click', (e) => {
  e.stopPropagation();
  const model = state.models.find(m => m.id === lithoPanelModelId);
  if (!model) { closeLithoPanel(); return; }
  let n = 0;
  if (lithoDraft) lithoDraft.forEach((hex, name) => { applyLithologyColorCore(model, name, hex); n++; });
  if (n > 0) {
    updateLegend();
    const lmItem = lmList.querySelector('.lm-item[data-model-id="' + model.id + '"]');
    if (lmItem && model.lithologyTypes.length > 0) {
      const colorBox = lmItem.querySelector('.lm-color');
      if (colorBox) colorBox.style.background = '#' + model.lithologyTypes[0].color.toString(16).padStart(6, '0');
    }
    try { persistProjectSilently(); } catch (err) {}
  }
  closeLithoPanel();
});

// )
function openLithologyColorPanel(model) {
  if (!model || !model.isLithologyDrillhole) return;
  lithoPanelModelId = model.id;
  lithoPanelTitle.textContent = 'Drillhole lithology colors';   // ,
  lithoPanelFooter.style.display = 'flex';
  lithoDraft = new Map();
  lithoSnapshot = {};
  lithoSelVein = null;
  (model.lithologyTypes || []).forEach(lt => { lithoSnapshot[lt.name] = lt.color; });
  renderLithoPanelBody(model);
  lithoPanel.classList.add('visible');
}

// the legend
function setLithoDraftColor(model, veinName, hexStr) {
  lithoDraft.set(veinName, hexStr);
  const newColor = parseInt(hexStr.replace('#', ''), 16);
  if (model.mesh) {
    model.mesh.traverse(obj => {
      if (obj.userData && obj.userData.isDrillhole && obj.userData.vein === veinName && obj.material) {
        obj.material.color.setHex(newColor);
      }
    });
  }
  const lt = model.lithologyTypes.find(t => t.name === veinName);
  if (lt) lt.color = newColor;
}

// )
function applyLithoAutoMatch(model) {
  const colorMap = collectGeoLayerColorMap();
  const types = model.lithologyTypes || [];
  let hit = 0;
  types.forEach(lt => {
    const key = normalizeGeoLayerName(lt.name);
    if (!key || !colorMap.has(key)) return;
    setLithoDraftColor(model, lt.name, '#' + colorMap.get(key).toString(16).padStart(6, '0'));
    hit++;
  });
  return { hit: hit, total: types.length };
}

// render the panel content:
// ,
// .
function renderLithoPanelBody(model) {
  const keepTop = lithoPanelBody.scrollTop;   // ,
  lithoPanelBody.innerHTML = '';
  const types = model.lithologyTypes || [];
  if (types.length === 0) {
    lithoPanelBody.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:8px 0;">No lithology data</div>';
    return;
  }
  const geoEntries = collectGeoLayerEntries();

  types.forEach(lt => {
    const hex = '#' + lt.color.toString(16).padStart(6, '0');
    const isDraft = !!(lithoDraft && lithoDraft.has(lt.name));
    const row = document.createElement('div');
    row.className = 'litho-row' + (lithoSelVein === lt.name ? ' selected' : '');
    row.innerHTML =
      '<div class="litho-swatch" style="background:' + hex + '" title="Click to change color (Applied after confirmation) "></div>' +
      '<span class="litho-name" title="' + escapeHtml(lt.name) + '">' + escapeHtml(lt.name) + '</span>' +
      (isDraft ? '<span class="litho-row-draft" title="Not confirmed">Draft</span>' : '') +
      '<span class="litho-hex">' + hex.toUpperCase() + '</span>';
    // )
    row.addEventListener('click', (e) => {
      if (e.target.closest('.litho-swatch')) return;
      lithoSelVein = (lithoSelVein === lt.name) ? null : lt.name;
      renderLithoPanelBody(model);
    });
    const swatch = row.querySelector('.litho-swatch');
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      // ,
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = hex;
      picker.style.position = 'fixed';
      picker.style.left = '-9999px';
      document.body.appendChild(picker);
      picker.click();
      picker.addEventListener('input', () => {
        // ,
        setLithoDraftColor(model, lt.name, picker.value);
        swatch.style.background = picker.value;
        const hl = row.querySelector('.litho-hex');
        if (hl) hl.textContent = picker.value.toUpperCase();
        if (!row.querySelector('.litho-row-draft') && hl) {
          const tag = document.createElement('span');
          tag.className = 'litho-row-draft';
          tag.title = 'Not confirmed';
          tag.textContent = 'Draft';
          row.insertBefore(tag, hl);
        }
      });
      picker.addEventListener('change', () => {
        if (picker.parentNode) picker.parentNode.removeChild(picker);
      });
    });
    lithoPanelBody.appendChild(row);
  });

  lithoPanelBody.appendChild(buildGeoSec(model, types, geoEntries));
  lithoPanelBody.scrollTop = keepTop;
}

// the lower half: the formation colour blocks of the 3D geological model
// .
function buildGeoSec(model, types, geoEntries) {
  const sec = document.createElement('div');
  sec.className = 'litho-geo-sec';

  const head = document.createElement('div');
  head.className = 'litho-geo-head';
  head.innerHTML =
    '<span class="litho-geo-title">3D Geological Models · Click a swatch to choose a color</span>' +
    (geoEntries.length > 0
      ? '<button class="litho-mini-btn" id="litho-auto-match" title="Apply formation colors to all lithologies with matching names">Apply to matching names</button>'
      : '');
  sec.appendChild(head);

  if (geoEntries.length === 0) {
    const tip = document.createElement('div');
    tip.className = 'litho-geo-hint';
    tip.textContent = 'No 3D geological model was found in the view (.ts / .obj) . Import formation models first, or drag a removed model back into the canvas. ';
    sec.appendChild(tip);
    return sec;
  }

  const grid = document.createElement('div');
  grid.className = 'litho-geo-grid';
  geoEntries.forEach(entry => {
    const hex = '#' + entry.color.toString(16).padStart(6, '0');
    const cell = document.createElement('div');
    cell.className = 'litho-geo-cell';
    cell.title = entry.name + '  ' + hex.toUpperCase();
    cell.innerHTML =
      '<span class="litho-geo-swatch" style="background:' + hex + '"></span>' +
      '<span class="litho-geo-name">' + escapeHtml(entry.name) + '</span>';
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      // the target is the selected lithology row, or the one with the same name when no row is selected
      let target = null;
      if (lithoSelVein && types.some(t => t.name === lithoSelVein)) target = lithoSelVein;
      else {
        const hit = types.find(t => entry.keys.indexOf(normalizeGeoLayerName(t.name)) >= 0);
        if (hit) target = hit.name;
      }
      if (!target) {
        setGeoHint('「' + entry.name + ' ”No formation has a matching lithology name —— Select the target lithology row above first, then click here. ');
        return;
      }
      setLithoDraftColor(model, target, hex);
      renderLithoPanelBody(model);
    });
    grid.appendChild(cell);
  });
  sec.appendChild(grid);

  const hint = document.createElement('div');
  hint.className = 'litho-geo-hint';
  hint.id = 'litho-geo-hint';
  hint.textContent = 'Select a lithology row above → then click a color swatch below to apply; If no row is selected, apply by matching names. ';
  sec.appendChild(hint);

  const btn = head.querySelector('#litho-auto-match');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = applyLithoAutoMatch(model);
      renderLithoPanelBody(model);
      setGeoHint('Applied to matching names ' + r.hit + ' / ' + r.total + ' types, Select the remaining entries manually.  (Not confirmed) ');
    });
  }
  return sec;
}

// references
function setGeoHint(text) {
  const el = lithoPanelBody.querySelector('#litho-geo-hint');
  if (el) el.textContent = text;
}

// 
// ,
// the legend
// 
function applyLithologyColorCore(model, veinName, hexStr) {
  const newColor = parseInt(hexStr.replace('#', ''), 16);
  // )
  state.lithologyColors[veinName] = hexStr;
  // 2. update the material of every segment with a matching lithology in that model
  if (model.mesh) {
    model.mesh.traverse(obj => {
      if (obj.userData && obj.userData.isDrillhole && obj.userData.vein === veinName && obj.material) {
        obj.material.color.setHex(newColor);
      }
    });
  }
  // the legend
  const lt = model.lithologyTypes.find(t => t.name === veinName);
  if (lt) lt.color = newColor;
  // )
  state.models.forEach(m => {
    if (m.isLithologyDrillhole && m.id !== model.id && m.mesh) {
      m.mesh.traverse(obj => {
        if (obj.userData && obj.userData.isDrillhole && obj.userData.vein === veinName && obj.material) {
          obj.material.color.setHex(newColor);
        }
      });
      const lt2 = m.lithologyTypes.find(t => t.name === veinName);
      if (lt2) lt2.color = newColor;
    }
  });
  return newColor;
}

// the legend
function applyLithologyColor(model, veinName, hexStr) {
  applyLithologyColorCore(model, veinName, hexStr);
  // 5. synchronise the legend
  updateLegend();
  // )
  const lmItem = lmList.querySelector('.lm-item[data-model-id="' + model.id + '"]');
  if (lmItem) {
    const colorBox = lmItem.querySelector('.lm-color');
    if (colorBox && model.lithologyTypes.length > 0) {
      const repHex = '#' + model.lithologyTypes[0].color.toString(16).padStart(6, '0');
      colorBox.style.background = repHex;
    }
  }
}

// ============================================================
// sections 80 and 81: the colour correspondence between the drillhole lithology and the 3D formations
// section 80 used to be a one-off bulk match triggered by right-clicking a layer management entry and colouring by the 3D formation;
// ,
// ,
// ignore
// ,
// ============================================================

// the name is normalised for case, leading and trailing and internal whitespace, the extension, full-width brackets and dashes
function normalizeGeoLayerName(s) {
  if (s == null) return '';
  let t = String(s).trim().toLowerCase();
  t = t.replace(/\.[a-z0-9]{1,6}$/, '');                  // )
  t = t.replace(/[\s\u3000]+/g, '');                      // )
  t = t.replace(/\uff08/g, '(').replace(/\uff09/g, ')');  // 全角括号 → 半角
  t = t.replace(/[\u2013\u2014\uff0d]/g, '-');            // 长横线 / 全角减号 → 半角连字符
  return t;
}

// )
// ,
// )
// ,
// 
function collectGeoLayerEntries() {
  const out = [];
  state.models.forEach(m => {
    if (!m || !m.geoMesh) return;                                    // 只认真实几何模型
    if (m.isDrillhole || m.isPointLayer || m.isLineLayer) return;
    if (m.isRegisterPlane) return;
    if (!m.inScene) return;
    if (typeof m.color !== 'number') return;                         // 无有效颜色则跳过
    const cands = [];
    if (m.displayName) cands.push(m.displayName);
    if (m.fileName) cands.push(m.fileName);
    if (m.name) cands.push(m.name);
    const attrs = m.attrs || {};
    ['Lithology', 'Lithology name', 'Formation', 'Formation name', 'type', 'Type', 'Category', 'class', 'stratum', 'layer'].forEach(k => {
      if (attrs[k]) cands.push(attrs[k]);
    });
    const keys = [];
    cands.forEach(c => {
      const k = normalizeGeoLayerName(c);
      if (k && keys.indexOf(k) < 0) keys.push(k);                    // 同一模型的多个别名去重
    });
    if (keys.length === 0) return;
    let show = String(m.displayName || m.fileName || m.name || keys[0]);
    show = show.replace(/\.[A-Za-z0-9]{1,6}$/, '');                  // 展示名去掉扩展名
    out.push({ name: show, color: m.color, keys: keys, model: m });
  });
  return out;
}

// )
function collectGeoLayerColorMap() {
  const map = new Map();
  collectGeoLayerEntries().forEach(e => {
    e.keys.forEach(k => { if (!map.has(k)) map.set(k, e.color); });
  });
  return map;
}

// ============================================================
// the geochemical colour scale settings panel
// )
// )
// a live preview of the gradient bar with the value range labels
// ============================================================
const geochemHeader = lithoPanel.querySelector('.litho-panel-header span');

// ,
function openGeochemColorPanel(model) {
  if (!model || !model.isGeochemDrillhole) return;
  lithoPanelModelId = model.id;
  // 
  // .
  lithoPanelFooter.style.display = 'none';
  lithoDraft = null;
  lithoSnapshot = null;
  lithoSelVein = null;
  if (!state.geochemColormap) state.geochemColormap = {};
  const attr = model.geochemAttrName;
  if (!state.geochemColormap[attr]) {
    state.geochemColormap[attr] = { lowColor: '#313695', highColor: '#A50026', scheme: 'rdbu' };
  }
  renderGeochemPanelBody(model);
  lithoPanel.classList.add('visible');
}

function renderGeochemPanelBody(model) {
  const attr = model.geochemAttrName;
  const cfg = state.geochemColormap[attr] || { lowColor: '#313695', highColor: '#A50026', scheme: 'rdbu' };
  const attrRaw = model.geochemAttrRawName || attr;
  geochemHeader.textContent = 'Geochemical color scale · ' + attrRaw;

  const stops = getAttrColormapStops(attr);
  const gradStops = stops.map((hex, i) => {
    const t = stops.length <= 1 ? 0 : (i / (stops.length - 1));
    return hex + ' ' + (t * 100).toFixed(1) + '%';
  }).join(', ');
  const fmt = (v) => {
    if (Math.abs(v) >= 1000) return v.toFixed(0);
    if (Math.abs(v) >= 1) return v.toFixed(2);
    if (Math.abs(v) >= 0.001) return v.toFixed(5);
    return v.toExponential(2);
  };
  const minStr = fmt(model.geochemMin);
  const maxStr = fmt(model.geochemMax);

  lithoPanelBody.innerHTML = '';
  // the gradient bar preview
  const previewRow = document.createElement('div');
  previewRow.className = 'geochem-preview';
  previewRow.innerHTML =
    '<div style="font-size:11px;font-weight:600;margin-bottom:6px;color:#24292f;">Preview (' + escapeHtml(attrRaw) + '）</div>' +
    '<div class="geobar-track" style="background:linear-gradient(90deg,' + gradStops + ');height:16px;border-radius:4px;"></div>' +
    '<div class="geobar-labels" style="margin-top:3px;">' +
      '<span>' + escapeHtml(minStr) + '</span>' +
      '<span>' + escapeHtml(maxStr) + '</span>' +
    '</div>';
  lithoPanelBody.appendChild(previewRow);

  // the colour scheme row
  const schemeRow = document.createElement('div');
  schemeRow.className = 'geochem-row';
  schemeRow.innerHTML =
    '<span class="drill-setting-label">Color scheme</span>' +
    '<select class="geochem-select" id="geochem-scheme-select">' +
      '<option value="rdbu"' + (cfg.scheme !== 'custom' ? ' selected' : '') + '>Classic RdBu (Blue→Cyan→Green→Yellow→Red) </option>' +
      '<option value="custom"' + (cfg.scheme === 'custom' ? ' selected' : '') + '>Custom endpoint colors</option>' +
    '</select>';
  lithoPanelBody.appendChild(schemeRow);

  // the low value colour row
  const lowRow = document.createElement('div');
  lowRow.className = 'drill-setting-row';
  lowRow.innerHTML =
    '<span class="drill-setting-label">Low-value color</span>' +
    '<div class="drill-setting-swatch" id="geochem-low-swatch" style="background:' + cfg.lowColor + '"></div>' +
    '<span class="drill-setting-hex" id="geochem-low-hex">' + cfg.lowColor.toUpperCase() + '</span>';
  lithoPanelBody.appendChild(lowRow);

  // the high value colour row
  const highRow = document.createElement('div');
  highRow.className = 'drill-setting-row';
  highRow.innerHTML =
    '<span class="drill-setting-label">High-value color</span>' +
    '<div class="drill-setting-swatch" id="geochem-high-swatch" style="background:' + cfg.highColor + '"></div>' +
    '<span class="drill-setting-hex" id="geochem-high-hex">' + cfg.highColor.toUpperCase() + '</span>';
  lithoPanelBody.appendChild(highRow);

  // the restore defaults button
  const resetRow = document.createElement('div');
  resetRow.style.cssText = 'display:flex;justify-content:flex-end;padding-top:6px;';
  resetRow.innerHTML =
    '<button class="geochem-reset-btn" id="geochem-reset-btn" style="font-size:11px;padding:4px 10px;background:#f6f8fa;border:1px solid #d0d7de;border-radius:4px;cursor:pointer;color:#24292f;">Restore classic color scale</button>';
  lithoPanelBody.appendChild(resetRow);

  // the event bindings
  const sel = schemeRow.querySelector('#geochem-scheme-select');
  sel.addEventListener('change', () => {
    setAttrColormap(attr, { scheme: sel.value });
    applyGeochemColormap(model);
    renderGeochemPanelBody(model);
  });

  function bindColorSwatch(swatch, hexLbl, isLow) {
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      const curCfg = state.geochemColormap[attr];
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = isLow ? (curCfg.lowColor || '#313695') : (curCfg.highColor || '#A50026');
      picker.style.position = 'fixed';
      picker.style.left = '-9999px';
      document.body.appendChild(picker);
      picker.click();
      picker.addEventListener('input', () => {
        const patch = { scheme: 'custom' };
        if (isLow) patch.lowColor = picker.value; else patch.highColor = picker.value;
        setAttrColormap(attr, patch);
        sel.value = 'custom';
        applyGeochemColormap(model);
        swatch.style.background = picker.value;
        hexLbl.textContent = picker.value.toUpperCase();
        const curStops = getAttrColormapStops(attr);
        const newGrad = curStops.map((hex, i) => {
          const t = curStops.length <= 1 ? 0 : (i / (curStops.length - 1));
          return hex + ' ' + (t * 100).toFixed(1) + '%';
        }).join(', ');
        const track = previewRow.querySelector('.geobar-track');
        if (track) track.style.background = 'linear-gradient(90deg,' + newGrad + ')';
      });
      picker.addEventListener('change', () => document.body.removeChild(picker));
    });
  }
  bindColorSwatch(lowRow.querySelector('#geochem-low-swatch'), lowRow.querySelector('#geochem-low-hex'), true);
  bindColorSwatch(highRow.querySelector('#geochem-high-swatch'), highRow.querySelector('#geochem-high-hex'), false);

  resetRow.querySelector('#geochem-reset-btn').addEventListener('click', () => {
    setAttrColormap(attr, { scheme: 'rdbu', lowColor: '#313695', highColor: '#A50026' });
    applyGeochemColormap(model);
    renderGeochemPanelBody(model);
  });
}

// apply the colour scale change to the material of every segment of the model, and synchronise the legend and the layer colour block
function applyGeochemColormap(model) {
  if (!model || !model.isGeochemDrillhole) return;
  const attr = model.geochemAttrName;
  const stops = getAttrColormapStops(attr);
  const minV = model.geochemMin, maxV = model.geochemMax;
  if (model.mesh) {
    model.mesh.traverse(obj => {
      if (obj.userData && obj.userData.isDrillhole && obj.userData.vein === '__geochem__') {
        const t = obj.userData.geochemT !== undefined
          ? obj.userData.geochemT
          : ((maxV - minV) < 1e-12 ? 0.5 : ((obj.userData.geochemValue || minV) - minV) / (maxV - minV));
        const newColor = geochemColorInt(t, stops);
        if (obj.material) obj.material.color.setHex(newColor);
      }
    });
  }
  model.color = geochemColorInt(0.5, stops);
  const lmItem = lmList.querySelector('.lm-item[data-model-id="' + model.id + '"]');
  if (lmItem) {
    const colorBox = lmItem.querySelector('.lm-color');
    if (colorBox) colorBox.style.background = '#' + model.color.toString(16).padStart(6, '0');
  }
  updateLegend();
  state.models.forEach(m => {
    if (m.isGeochemDrillhole && m.id !== model.id && m.geochemAttrName === attr && m.inScene) {
      applyGeochemColormap(m);
    }
  });
}

// ============================================================
// the drillhole settings panel renders the settings according to the model type
// a collar point shows the icon colour and the font colour
// a single colour drillhole shows the trajectory colour and the cylinder thickness
// )
// ============================================================
const drillSettingPanel = document.getElementById('drill-setting-panel');
const drillSettingBody = document.getElementById('drill-setting-body');
const drillSettingTitle = document.getElementById('drill-setting-title');
let drillSettingModelId = null;

document.getElementById('drill-setting-close').addEventListener('click', () => {
  drillSettingPanel.classList.remove('visible');
  drillSettingModelId = null;
});

function openDrillSettingPanel(model) {
  if (!model) return;
  drillSettingModelId = model.id;
  renderDrillSettingBody(model);
  drillSettingPanel.classList.add('visible');
}

function renderDrillSettingBody(model) {
  drillSettingBody.innerHTML = '';
  if (model.isCollarPoints) {
    drillSettingTitle.textContent = 'Collar settings';
    buildColorRow(model, 'Icon color', model.color, (hex) => applyCollarIconColor(model, hex));
    buildColorRow(model, 'Text color', model.labelColor || '#1565C0', (hex) => applyCollarLabelColor(model, hex));
  } else if (model.isGeochemDrillhole) {
    drillSettingTitle.textContent = 'Drillhole geochemistry settings';
    buildRadiusRow(model, model.radius || 1, (r) => applyDrillholeRadius(model, r));
  } else if (model.isLithologyDrillhole) {
    drillSettingTitle.textContent = 'Lithology settings';
    buildRadiusRow(model, model.radius || 1, (r) => applyDrillholeRadius(model, r));
  } else if (model.isDrillhole) {
    drillSettingTitle.textContent = 'Drillhole trajectory settings';
    buildColorRow(model, 'Trajectory color', model.color, (hex) => applySurveyColor(model, hex));
    buildRadiusRow(model, model.radius || 1, (r) => applyDrillholeRadius(model, r));
  }
}

// )
function buildColorRow(model, label, colorVal, onPick) {
  const hex = typeof colorVal === 'number'
    ? '#' + colorVal.toString(16).padStart(6, '0')
    : colorVal;
  const row = document.createElement('div');
  row.className = 'drill-setting-row';
  row.innerHTML =
    '<span class="drill-setting-label">' + escapeHtml(label) + '</span>' +
    '<div class="drill-setting-swatch" style="background:' + hex + '" title="Click to change color"></div>' +
    '<span class="drill-setting-hex">' + hex.toUpperCase() + '</span>';
  const swatch = row.querySelector('.drill-setting-swatch');
  const hexLabel = row.querySelector('.drill-setting-hex');
  swatch.addEventListener('click', (e) => {
    e.stopPropagation();
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = hex;
    picker.style.position = 'fixed';
    picker.style.left = '-9999px';
    document.body.appendChild(picker);
    picker.click();
    picker.addEventListener('input', () => {
      const newHex = picker.value;
      onPick(newHex);
      swatch.style.background = newHex;
      hexLabel.textContent = newHex.toUpperCase();
    });
    picker.addEventListener('change', () => {
      document.body.removeChild(picker);
    });
  });
  drillSettingBody.appendChild(row);
}

// )
function buildRadiusRow(model, currentRadius, onChange) {
  // )
  // ,
  if (model && model._lmRadiusMax == null) model._lmRadiusMax = Math.max(10, currentRadius * 5);
  const maxR = (model && model._lmRadiusMax) ? model._lmRadiusMax : Math.max(10, currentRadius * 5);
  const minR = 0.1;
  const pct = Math.round(((currentRadius - minR) / (maxR - minR)) * 100);
  const row = document.createElement('div');
  row.className = 'drill-setting-row';
  row.innerHTML =
    '<span class="drill-setting-label">Cylinder radius</span>' +
    '<div class="drill-setting-slider">' +
      '<div class="drill-setting-sfill" style="width:' + pct + '%"></div>' +
      '<div class="drill-setting-sthumb" style="left:' + pct + '%"></div>' +
    '</div>' +
    '<span class="drill-setting-val">' + currentRadius.toFixed(2) + '</span>';
  const slider = row.querySelector('.drill-setting-slider');
  const sfill = row.querySelector('.drill-setting-sfill');
  const sthumb = row.querySelector('.drill-setting-sthumb');
  const valLabel = row.querySelector('.drill-setting-val');
  function updateRadius(clientX) {
    const rect = slider.getBoundingClientRect();
    let p = (clientX - rect.left) / rect.width;
    p = Math.max(0, Math.min(1, p));
    const newR = minR + p * (maxR - minR);
    sfill.style.width = (p * 100) + '%';
    sthumb.style.left = (p * 100) + '%';
    valLabel.textContent = newR.toFixed(2);
    onChange(newR);
  }
  slider.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    dragDelegate.active = true;
    dragDelegate.onMove = (ev) => updateRadius(ev.clientX);
    updateRadius(e.clientX);
  });
  drillSettingBody.appendChild(row);
}

// 
function applyCollarIconColor(model, hexStr) {
  const newColor = parseInt(hexStr.replace('#', ''), 16);
  model.color = newColor;
  if (model.materials) model.materials.forEach(mt => mt.color.setHex(newColor));
  // synchronise the layer colour block
  syncLayerColorBox(model, hexStr);
  updateLegend();
}

// 
function applyCollarLabelColor(model, hexStr) {
  model.labelColor = hexStr;
  if (!model.mesh) return;
  // )
  const labels = [];
  model.mesh.traverse(obj => {
    if (obj.userData && obj.userData.isCollarLabel) labels.push(obj);
  });
  labels.forEach(obj => {
    const newLabel = makeLabelSprite(obj.userData.holeid, obj.userData.labelScale, hexStr);
    newLabel.position.copy(obj.userData.basePos).add(new THREE.Vector3(0, obj.userData.offsetY, 0));
    newLabel.material.depthTest = false;
    newLabel.renderOrder = 999;
    newLabel.userData.isCollarLabel = true;
    newLabel.userData.holeid = obj.userData.holeid;
    newLabel.userData.labelScale = obj.userData.labelScale;
    newLabel.userData.basePos = obj.userData.basePos.clone();
    newLabel.userData.offsetY = obj.userData.offsetY;
    // release the old texture and material
    if (obj.material && obj.material.map) obj.material.map.dispose();
    if (obj.material) obj.material.dispose();
    model.mesh.remove(obj);
    model.mesh.add(newLabel);
  });
}

// -- apply the single colour drillhole trajectory colour --
function applySurveyColor(model, hexStr) {
  const newColor = parseInt(hexStr.replace('#', ''), 16);
  model.color = newColor;
  if (model.materials) model.materials.forEach(mt => mt.color.setHex(newColor));
  syncLayerColorBox(model, hexStr);
  updateLegend();
}

// 
function applyDrillholeRadius(model, newRadius) {
  model.radius = newRadius;
  // )
  syncLayerRadius(model, newRadius);
  if (!model.mesh) return;
  model.mesh.traverse(obj => {
    if (obj.userData && obj.userData.isDrillhole && obj.userData.segStart && obj.userData.segEnd) {
      // ,
      if (obj.geometry) obj.geometry.dispose();
      obj.geometry = new THREE.CylinderGeometry(newRadius, newRadius, obj.userData.segLen, 12);
    }
  });
}

// 
function syncLayerRadius(model, r) {
  if (!model || typeof r !== 'number') return;
  if (model._lmRadiusMax == null) model._lmRadiusMax = Math.max(10, r * 5);
  const lmItem = lmList.querySelector('.lm-item[data-model-id="' + model.id + '"]');
  if (!lmItem) return;
  const radiusSlider = lmItem.querySelector('.lm-radius-ctl .lm-slider');
  const radiusVal = lmItem.querySelector('.lm-radius-val');
  if (!radiusSlider) return;
  const maxR = model._lmRadiusMax;
  const minR = 0.1;
  const p = Math.max(0, Math.min(1, (r - minR) / (maxR - minR)));
  const sfill = radiusSlider.querySelector('.lm-sfill');
  const sthumb = radiusSlider.querySelector('.lm-sthumb');
  if (sfill) sfill.style.width = (p * 100) + '%';
  if (sthumb) sthumb.style.left = (p * 100) + '%';
  if (radiusVal) radiusVal.textContent = r.toFixed(2);
}

// -- synchronise the colour square of the layer entry --
function syncLayerColorBox(model, hexStr) {
  const lmItem = lmList.querySelector('.lm-item[data-model-id="' + model.id + '"]');
  if (lmItem) {
    const colorBox = lmItem.querySelector('.lm-color');
    if (colorBox) colorBox.style.background = hexStr;
  }
}

// )
function selectLayer(modelId) {
  state.selectedModelId = modelId;
  document.querySelectorAll('.lm-item').forEach(i => {
    i.classList.toggle('selected', i.getAttribute('data-model-id') === modelId);
  });
  const model = state.models.find(m => m.id === modelId);
  // linked to the selection: changing the selection updates the highlight outline in the 3D canvas
  showSelectionOutline(model);
  // linked to the property panel on the right, which shows the properties of that model
  if (model) showModelProperties(model);
}

// ,
// ,
function activateRightTab(name) {
  // ,
  if (window.setRightPanelGroup) window.setRightPanelGroup('drill');
  if (window.activateRightPanelTab) {
    window.activateRightPanelTab(name);
    return;
  }
  const tabs = document.querySelectorAll('.rp-tab');
  const panels = document.querySelectorAll('.rp-tab-panel');
  tabs.forEach(t => {
    t.classList.toggle('active', (t.dataset.tab || t.textContent.trim()) === name);
  });
  panels.forEach(p => p.classList.toggle('active', p.dataset.tab === name));
}

// )
function showModelProperties(model) {
  if((!model.geoMesh?.boundingBox||model.geoMesh.boundingBox.length!==6)&&!model.geoMesh?.vertices?.length&&model.mesh){
    const box=new THREE.Box3().setFromObject(model.mesh),origin=state.origin||{x:0,y:0,z:0};
    if(!box.isEmpty()){
      model.geoMesh=model.geoMesh||{};
      model.geoMesh.boundingBox=[box.min.x+origin.x,origin.y-box.max.z,box.min.y+origin.z,box.max.x+origin.x,origin.y-box.min.z,box.max.y+origin.z];
      let vertices=0,triangles=0;model.mesh.traverse(object=>{const position=object.geometry?.getAttribute('position');if(position){vertices+=position.count;if(object.isMesh)triangles+=(object.geometry.index?.count||position.count)/3;}});
      model.geoMesh.vertexCount=vertices;model.geoMesh.triangleCount=triangles;
    }
  }
  // Older generated meshes may lack the optional source bounds. Reconstruct
  // GOCAD/model coordinates from raw Three coordinates before displaying them.
  if (model.geoMesh && (!model.geoMesh.boundingBox || model.geoMesh.boundingBox.length !== 6)) {
    const vertices = model.geoMesh.vertices;
    if (!vertices || vertices.length < 3) return;
    const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertices.length; i += 3) {
      const coordinates = [vertices[i], -vertices[i + 2], vertices[i + 1]];
      for (let axis = 0; axis < 3; axis++) {
        bounds[axis] = Math.min(bounds[axis], coordinates[axis]);
        bounds[axis + 3] = Math.max(bounds[axis + 3], coordinates[axis]);
      }
    }
    model.geoMesh.boundingBox = bounds;
    model.geoMesh.vertexCount = vertices.length / 3;
    model.geoMesh.triangleCount = (model.geoMesh.indices || []).length / 3;
  }
  if (!model.geoMesh || !model.geoMesh.boundingBox) return;
  const bb = model.geoMesh.boundingBox;
  const hex = '#' + model.color.toString(16).padStart(6, '0');
  const sizeX = (bb[3] - bb[0]).toFixed(2);
  const sizeY = (bb[4] - bb[1]).toFixed(2);
  const sizeZ = (bb[5] - bb[2]).toFixed(2);

  const html =
    '<div class="rp-section">' +
      '<div class="rp-section-title">General information</div>' +
      '<div class="prop-row"><span class="prop-label">Name</span><span class="prop-value">' + escapeHtml(model.displayName || model.name) + '</span></div>' +
      '<div class="prop-row"><span class="prop-label">Category</span><span class="prop-value highlight">' + escapeHtml(model.category) + '</span></div>' +
      '<div class="prop-row"><span class="prop-label">Filename</span><span class="prop-value">' + escapeHtml(model.fileName) + '</span></div>' +
    '</div>' +
    '<div class="rp-section">' +
      '<div class="rp-section-title">Geometry</div>' +
      '<div class="prop-row"><span class="prop-label">Vertices</span><span class="prop-value">' + model.geoMesh.vertexCount + '</span></div>' +
      '<div class="prop-row"><span class="prop-label">Triangles</span><span class="prop-value">' + model.geoMesh.triangleCount + '</span></div>' +
      '<div class="prop-row"><span class="prop-label">X Extent</span><span class="prop-value">' + bb[0].toFixed(2) + ' ~ ' + bb[3].toFixed(2) + ' (' + sizeX + ')</span></div>' +
      '<div class="prop-row"><span class="prop-label">Y Extent</span><span class="prop-value">' + bb[1].toFixed(2) + ' ~ ' + bb[4].toFixed(2) + ' (' + sizeY + ')</span></div>' +
      '<div class="prop-row"><span class="prop-label">Z Extent</span><span class="prop-value">' + bb[2].toFixed(2) + ' ~ ' + bb[5].toFixed(2) + ' (' + sizeZ + ')</span></div>' +
    '</div>' +
    '<div class="rp-section">' +
      '<div class="rp-section-title">Display properties</div>' +
      '<div class="prop-row"><span class="prop-label">Opacity</span><span class="prop-value">' + Math.round(model.opacity * 100) + '%</span></div>' +
      '<div class="prop-row"><span class="prop-label">Color</span><span class="prop-value"><span style="display:inline-block;width:12px;height:12px;background:' + hex + ';border:1px solid #ccc;border-radius:2px;vertical-align:middle;margin-right:4px;"></span>' + hex + '</span></div>' +
      '<div class="prop-row"><span class="prop-label">Visibility</span><span class="prop-value">' + (model.visible ? 'Visible' : 'Hide') + '</span></div>' +
    '</div>';

  // 
  if (model.attrs) {
    const SKIP_KEYS = { file: 1, fileName: 1, code: 1, vertices: 1, faces: 1, zSpan: 1, suggestedColor: 1, bbox: 1, 颜色: 1 };
    const LABELS = { type: 'Type', 类型: 'Type', 类别: 'Type', class: 'Type', note: 'Notes', 备注: 'Notes', remark: 'Notes' };
    const attrRows = [];
    Object.keys(model.attrs).forEach(k => {
      if (SKIP_KEYS[k]) return;
      const v = model.attrs[k];
      if (v == null || String(v).trim() === '') return;
      attrRows.push({ label: LABELS[k] || k, value: String(v), isType: (LABELS[k] === 'Type') });
    });
    if (attrRows.length > 0) {
      html += '<div class="rp-section"><div class="rp-section-title">Attribute table information</div>';
      attrRows.forEach(r => {
        html += '<div class="prop-row"><span class="prop-label">' + escapeHtml(r.label) + '</span>' +
          '<span class="prop-value' + (r.isType ? ' highlight' : '') + '">' + escapeHtml(r.value) + '</span></div>';
      });
      html += '</div>';
    }
  }

  // only update the property window at the bottom (bp-*)
  const bpEmpty = document.getElementById('bp-empty');
  const bpProps = document.getElementById('bp-model-props');
  if (bpEmpty) bpEmpty.style.display = 'none';
  if (bpProps) { bpProps.style.display = 'block'; bpProps.innerHTML = html; }
  if (typeof renderTerrainInfo === 'function') renderTerrainInfo(model, bpProps);
}

// double-click a drillhole object to show its properties in the model properties panel
function showHoleProps(holeid) {
  const info = collectHoleInfo(holeid);
  const tables = collectDrillholeTables();
  const lithoRows = tables.lithology ? parseLithologyTable(tables.lithology).filter(r => String(r.holeid) === String(holeid)) : [];

  let html = '<div class="rp-section"><div class="rp-section-title">Drillhole information</div>';
  html += '<div class="prop-row"><span class="prop-label">Drillhole ID</span><span class="prop-value highlight">' + escapeHtml(holeid) + '</span></div>';
  if (info.collar) {
    html += '<div class="prop-row"><span class="prop-label">Collar coordinates</span><span class="prop-value">X ' + info.collar.x + '，Y ' + info.collar.y + '，Z ' + info.collar.z + '</span></div>';
    html += '<div class="prop-row"><span class="prop-label">Hole depth</span><span class="prop-value">' + info.collar.depth + ' m</span></div>';
  }
  if (info.surveyList.length > 0) {
    const s = info.surveyList[info.surveyList.length - 1];
    html += '<div class="prop-row"><span class="prop-label">Dip</span><span class="prop-value">' + s.dip + '°</span></div>';
    html += '<div class="prop-row"><span class="prop-label">Azimuth</span><span class="prop-value">' + s.azimuth + '°</span></div>';
  }
  html += '</div>';

  if (lithoRows.length > 0) {
    html += '<div class="rp-section"><div class="rp-section-title">Lithology intervals</div>';
    lithoRows.forEach(l => {
      html += '<div class="prop-row"><span class="prop-label">' + l.from + ' ~ ' + l.to + ' m</span><span class="prop-value">' + escapeHtml(l.vein || 'Uncategorized') + '</span></div>';
    });
    html += '</div>';
  }

  const attrs = Object.keys(info.geochem);
  if (attrs.length > 0) {
    html += '<div class="rp-section"><div class="rp-section-title">Assayed elements</div>';
    html += '<div class="prop-row"><span class="prop-label">Element</span><span class="prop-value">' + escapeHtml(attrs.join('、')) + '</span></div>';
    html += '</div>';
  }

  const bpEmpty = document.getElementById('bp-empty');
  const bpProps = document.getElementById('bp-model-props');
  if (bpEmpty) bpEmpty.style.display = 'none';
  if (bpProps) { bpProps.style.display = 'block'; bpProps.innerHTML = html; }
}

// ============================================================
// the legend update
// ============================================================
function updateLegend() {
  const legend = document.getElementById('scene-legend');
  const titleEl = legend.querySelector('.scene-legend-title');
  const emptyEl = document.getElementById('legend-empty');
  legend.querySelectorAll('.legend-item').forEach(el => el.remove());
  legend.querySelectorAll('.legend-geobar').forEach(el => el.remove());

  // the legend
  // the legend
  // the legend
  const visibleModels = state.models.filter(m => m.inScene && m.visible !== false);
  if (visibleModels.length === 0) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  visibleModels.forEach(m => {
    // -- a geochemical drillhole shows the gradient bar with the min and max range and the attribute name --
    if (m.isGeochemDrillhole && m.geochemMin !== undefined) {
      const stops = getAttrColormapStops(m.geochemAttrName);
      const gradStops = stops.map((hex, i) => {
        const t = stops.length <= 1 ? 0 : (i / (stops.length - 1));
        return hex + ' ' + (t * 100).toFixed(1) + '%';
      }).join(', ');
      const fmt = (v) => {
        if (Math.abs(v) >= 1000) return v.toFixed(0);
        if (Math.abs(v) >= 1) return v.toFixed(2);
        if (Math.abs(v) >= 0.001) return v.toFixed(5);
        return v.toExponential(2);
      };
      const minStr = fmt(m.geochemMin);
      const maxStr = fmt(m.geochemMax);
      const midStr = fmt((m.geochemMin + m.geochemMax) / 2);
      const item = document.createElement('div');
      item.className = 'legend-geobar';
      item.innerHTML =
        '<div style="font-size:11px;font-weight:600;margin-bottom:4px;color:#24292f;">' + escapeHtml(m.displayName || m.geochemAttrRawName || m.fileName) + '</div>' +
        '<div class="geobar-track" style="background:linear-gradient(90deg,' + gradStops + ');"></div>' +
        '<div class="geobar-labels">' +
          '<span>' + escapeHtml(minStr) + '</span>' +
          '<span>' + escapeHtml(midStr) + '</span>' +
          '<span>' + escapeHtml(maxStr) + '</span>' +
        '</div>';
      legend.appendChild(item);
      return;
    }
    // a drillhole model shows a multi-colour legend by lithology type
    if (m.isDrillhole && m.lithologyTypes && m.lithologyTypes.length > 0) {
      m.lithologyTypes.forEach(lt => {
        const hex = '#' + lt.color.toString(16).padStart(6, '0');
        const item = document.createElement('div');
        item.className = 'legend-item';
        item.innerHTML =
          '<div class="legend-swatch" style="background:' + hex + '"></div>' +
          '<span>' + escapeHtml(lt.name) + '</span>';
        legend.appendChild(item);
      });
      return;
    }
    const hex = '#' + m.color.toString(16).padStart(6, '0');
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML =
      '<div class="legend-swatch" style="background:' + hex + '"></div>' +
      '<span>' + escapeHtml(m.displayName || m.fileName) + '</span>';
    legend.appendChild(item);
  });
}

// ============================================================
// what the toolbar buttons do
// ============================================================

// 1. Clear: remove every model from the 3D view, delete the layer entries, clear the measuring, clipping and highlight state, and leave the measuring mode
document.getElementById('btn-clear-all').addEventListener('click', () => {
  // the project tree
  state.models.forEach(m => {
    if (m.inScene) removeModelFromView(m);
  });

  // remove the measuring segments and the picked points
  state.rulerPoints.forEach(p => scene.remove(p));
  state.rulerLines.forEach(l => scene.remove(l));
  state.rulerPoints = [];
  state.rulerLines = [];
  // remove all the measuring layer entries
  lmList.querySelectorAll('.lm-measure-item').forEach(el => el.remove());
  state.rulerItems = [];
  cleanupMeasureDrag();

  // turn the clipping off
  if (state.clipMode) {
    state.clipMode = false;
    btnClip.classList.remove('active');
    disableClipping();
  }

  // the property panel
  clearSelectionState();

  // leave the measuring mode
  if (state.measureMode) {
    state.measureMode = false;
    btnMeasure.classList.remove('active');
    canvas.classList.remove('measuring');
    controls.enabled = true;
  }

  // show the empty state placeholder
  const visibleModels = state.models.filter(m => m.inScene);
  if (visibleModels.length === 0) {
    lmEmpty.style.display = '';
  }
});

// ,
document.getElementById('btn-reset-view').addEventListener('click', () => {
  if (state.models.length > 0) {
    fitViewToAll();
  } else {
    controls.reset();
  }
});

// 3. Measure
const btnMeasure = document.getElementById('btn-measure');
btnMeasure.addEventListener('click', () => {
  state.measureMode = !state.measureMode;
  btnMeasure.classList.toggle('active', state.measureMode);
  canvas.classList.toggle('measuring', state.measureMode);
  if (state.measureMode) {
    // the camera rotation is disabled while the measuring mode is active
    controls.enabled = false;
    controls._isRotating = false;
  } else {
    controls.enabled = true;
    // on exit the unfinished drag is cleaned up
    cleanupMeasureDrag();
  }
});

// the measuring pick
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// the measuring drag state
let measureDragging = false;
let measureStartPoint = null;
let measurePreviewLine = null;
let measurePreviewSprite = null;
let measureStartSphere = null;

// ,
function pickPoint3D(e) {
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  // )
  const inSceneModels = state.models.filter(m => m.inScene);
  const modelMeshes = inSceneModels.map(m => m.mesh).filter(m => m && m.visible);
  if (modelMeshes.length > 0) {
    const hits = raycaster.intersectObjects(modelMeshes, false);
    if (hits.length > 0) return hits[0].point.clone();
  }
  // the intersection with the ground plane
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(plane, hitPoint)) return hitPoint.clone();
  return null;
}

// measuring: mousedown sets the endpoint, mousemove updates the segment live and mouseup ends it
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // 仅左键
  if (!state.measureMode) return;
  const point = pickPoint3D(e);
  if (!point) return;

  measureDragging = true;
  measureStartPoint = point;

  // the dynamic scale bar
  const spriteScale = getMeasureSpriteScale();
  const yOffset = spriteScale * 0.8;
  const sphereR = spriteScale * 0.15;

  // )
  const sphereGeo = new THREE.SphereGeometry(sphereR, 12, 12);
  const sphereMat = new THREE.MeshBasicMaterial({ color: 0x39FF14 });
  measureStartSphere = new THREE.Mesh(sphereGeo, sphereMat);
  measureStartSphere.position.copy(point);
  scene.add(measureStartSphere);

  // )
  const lineGeo = new THREE.BufferGeometry().setFromPoints([point, point.clone()]);
  const lineMat = new THREE.LineBasicMaterial({ color: 0x39FF14, linewidth: 3 });
  measurePreviewLine = new THREE.Line(lineGeo, lineMat);
  scene.add(measurePreviewLine);

  // the preview length label
  measurePreviewSprite = makeDistanceSprite('0.00 m', spriteScale);
  measurePreviewSprite.position.set(point.x, point.y + yOffset, point.z);
  scene.add(measurePreviewSprite);

  e.preventDefault();
});

canvas.addEventListener('mousemove', (e) => {
  if (!measureDragging || !state.measureMode) return;
  const point = pickPoint3D(e);
  if (!point) return;

  // update the endpoint of the preview segment
  const positions = measurePreviewLine.geometry.attributes.position;
  positions.setXYZ(1, point.x, point.y, point.z);
  positions.needsUpdate = true;

  // update the length label
  const distance = measureStartPoint.distanceTo(point);
  const midPoint = new THREE.Vector3().addVectors(measureStartPoint, point).multiplyScalar(0.5);
  const spriteScale = getMeasureSpriteScale();
  const yOffset = spriteScale * 0.8;

  // ,
  scene.remove(measurePreviewSprite);
  if (measurePreviewSprite.material.map) measurePreviewSprite.material.map.dispose();
  measurePreviewSprite.material.dispose();
  measurePreviewSprite = makeDistanceSprite(distance.toFixed(2) + ' m', spriteScale);
  measurePreviewSprite.position.set(midPoint.x, midPoint.y + yOffset, midPoint.z);
  scene.add(measurePreviewSprite);
});

canvas.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  if (!measureDragging) return;
  measureDragging = false;

  const point = pickPoint3D(e);

  // remove the preview segment and the preview sprite
  if (measurePreviewLine) {
    scene.remove(measurePreviewLine);
    measurePreviewLine.geometry.dispose();
    measurePreviewLine.material.dispose();
    measurePreviewLine = null;
  }
  if (measurePreviewSprite) {
    scene.remove(measurePreviewSprite);
    if (measurePreviewSprite.material.map) measurePreviewSprite.material.map.dispose();
    measurePreviewSprite.material.dispose();
    measurePreviewSprite = null;
  }

  if (!point) {
    // ,
    if (measureStartSphere) {
      state.rulerPoints.push(measureStartSphere);
      measureStartSphere = null;
    }
    measureStartPoint = null;
    return;
  }

  const spriteScale = getMeasureSpriteScale();
  const yOffset = spriteScale * 0.8;
  const sphereR = spriteScale * 0.15;

  // the endpoint sphere
  const endSphereGeo = new THREE.SphereGeometry(sphereR, 12, 12);
  const endSphereMat = new THREE.MeshBasicMaterial({ color: 0x39FF14 });
  const endSphere = new THREE.Mesh(endSphereGeo, endSphereMat);
  endSphere.position.copy(point);
  scene.add(endSphere);

  // references
  const startSphere = measureStartSphere;
  measureStartSphere = null;

  // the final segment
  const lineGeo = new THREE.BufferGeometry().setFromPoints([measureStartPoint, point]);
  const lineMat = new THREE.LineBasicMaterial({ color: 0x39FF14, linewidth: 3 });
  const line = new THREE.Line(lineGeo, lineMat);
  scene.add(line);

  // )
  const distance = measureStartPoint.distanceTo(point);
  const midPoint = new THREE.Vector3().addVectors(measureStartPoint, point).multiplyScalar(0.5);
  const sprite = makeDistanceSprite(distance.toFixed(2) + ' m', spriteScale);
  sprite.position.set(midPoint.x, midPoint.y + yOffset, midPoint.z);
  scene.add(sprite);

  // )
  const rulerItem = { id: 'ruler-' + Date.now(), line, sprite, startSphere, endSphere, distance };
  state.rulerItems.push(rulerItem);
  state.rulerLines.push(line, sprite);
  state.rulerPoints.push(endSphere);
  if (startSphere) state.rulerPoints.push(startSphere);

  // add a measuring line entry to the layer management
  addMeasureLayerItem(rulerItem);

  measureStartPoint = null;
});

// clear the unfinished drag when leaving the measuring mode
function cleanupMeasureDrag() {
  if (measurePreviewLine) {
    scene.remove(measurePreviewLine);
    measurePreviewLine.geometry.dispose();
    measurePreviewLine.material.dispose();
    measurePreviewLine = null;
  }
  if (measurePreviewSprite) {
    scene.remove(measurePreviewSprite);
    if (measurePreviewSprite.material.map) measurePreviewSprite.material.map.dispose();
    measurePreviewSprite.material.dispose();
    measurePreviewSprite = null;
  }
  if (measureStartSphere) {
    scene.remove(measureStartSphere);
    measureStartSphere.geometry.dispose();
    measureStartSphere.material.dispose();
    measureStartSphere = null;
  }
  measureStartPoint = null;
  measureDragging = false;
}

canvas.addEventListener('click', (e) => {
  // )
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  // )
  if (state.measureMode) return;

  // -------- outside the measuring mode, clicking empty space clears the highlighted selection --------
  // there is nothing to do when nothing is selected
  if (!state.selectedModelId && !state.selectionOutline) return;

  // check whether any visible 3D model in the scene was hit
  const inSceneModels = state.models.filter(m => m.inScene);
  const visibleModelMeshes = inSceneModels.map(m => m.mesh).filter(m => m && m.visible);
  let hasHitModel = false;
  if (visibleModelMeshes.length > 0) {
    const hits = raycaster.intersectObjects(visibleModelMeshes, false);
    if (hits.length > 0) hasHitModel = true;
  }
  // if no model was hit, clear the selection highlight
  if (!hasHitModel) clearSelectionState();
});

// )
canvas.addEventListener('dblclick', (e) => {
  if (state.measureMode || pointAddMode) return;   // 测距/绘制模式下不干扰
  // logic
  const hit = pickPointSphereAt(e.clientX, e.clientY);
  if (!hit) return;
  openPointAttrEditor(hit.model, hit.sphere);
});

function makeDistanceSprite(text, scale) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  c.width = 256; c.height = 64;
  // a fluorescent green background with rounded corners
  const r = 8;
  ctx.fillStyle = 'rgba(57,255,20,0.85)';
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(256, 0, 256, 64, r);
  ctx.arcTo(256, 64, 0, 64, r);
  ctx.arcTo(0, 64, 0, 0, r);
  ctx.arcTo(0, 0, 256, 0, r);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#39FF14';
  ctx.lineWidth = 2;
  ctx.stroke();
  // )
  ctx.fillStyle = '#003300';
  ctx.font = 'bold 28px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(spriteMat);
  const s = scale || 30;
  sprite.scale.set(s * 4, s, 1); // 256:64 = 4:1 宽高比
  return sprite;
}

// )
function getMeasureSpriteScale() {
  const box = getSceneBoundingBox();
  if (box.isEmpty()) return 30;
  const size = box.getSize(new THREE.Vector3());
  const maxRange = Math.max(size.x, size.y, size.z);
  return maxRange * 0.04 + 5;
}

// )
canvas.addEventListener('dblclick', (e) => {
  // )
  if (state.measureMode) return;
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  // the mapping is fixed so that the mesh is only taken from the models that are in the scene
  // ,
  const inSceneModels = state.models.filter(m => m.inScene);
  const modelMeshes = inSceneModels.map(m => m.mesh).filter(m => m && m.visible);
  if (modelMeshes.length === 0) return;
  const hits = raycaster.intersectObjects(modelMeshes, true);
  if (hits.length === 0) return;

  const hitMesh = hits[0].object;
  // a drillhole object: double-clicking shows the properties of that drillhole in the model properties panel
  if (hitMesh.userData && hitMesh.userData.holeid) {
    showHoleProps(String(hitMesh.userData.holeid));
    return;
  }
  // references
  const meshModelId = hitMesh.userData.modelId;
  const hitModel = meshModelId
    ? state.models.find(m => m.id === meshModelId)
    : state.models.find(m => m.mesh === hitMesh);
  if (hitModel) {
    // )
    selectLayer(hitModel.id);
  }
});

// the project tree
// file shows the model of a single file
// )
// )
// ,
canvas.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

// ============================================================
// 2D linkage: right-clicking a drillhole collar in 3D shows the bar chart, the core images and the assay data in the right panel
// ============================================================

// )
function collectHoleInfo(holeid) {
  const tables = collectDrillholeTables();
  const collars = tables.collar ? parseCollarTable(tables.collar) : [];
  const surveys = tables.survey ? parseSurveyTable(tables.survey) : [];
  const collar = collars.find(c => String(c.holeid) === String(holeid)) || null;
  const surveyList = surveys.filter(s => String(s.holeid) === String(holeid));
  const geochem = {};
  Object.keys(tables.geochemAttrs || {}).forEach(attr => {
    const rows = parseGeochemAttrTable(tables.geochemAttrs[attr]).filter(r => String(r.holeid) === String(holeid));
    if (rows.length > 0) geochem[attr] = rows;
  });
  // ,
  // .
  // ,
  // ,
  // ,
  // 
  const wide = buildAssayWideRows(tables, holeid);
  return { holeid: holeid, collar: collar, surveyList: surveyList, geochem: geochem, assayWide: wide };
}

// ,
// returns { headers: [{key, label}], rows: [{ from, to, values: {key: num} }] }
//
// )
// ,
function buildAssayWideRows(tables, holeid) {
  const attrs = Object.keys(tables.geochemAttrs || {});
  if (attrs.length === 0) return { headers: [], rows: [] };

  // first, collect the interval to value mapping of each element
  const perAttr = {};      // attr → Map("from|to" → row)
  const rangeOrder = [];   // )
  const rangeSeen = new Set();
  attrs.forEach(attr => {
    const list = parseGeochemAttrTable(tables.geochemAttrs[attr])
      .filter(r => String(r.holeid) === String(holeid));
    const m = new Map();
    list.forEach(r => {
      const k = r.from + '|' + r.to;
      m.set(k, r);
      if (!rangeSeen.has(k)) { rangeSeen.add(k); rangeOrder.push({ k: k, from: r.from, to: r.to }); }
    });
    perAttr[attr] = m;
  });
  if (rangeOrder.length === 0) return { headers: [], rows: [] };

  // )
  const headers = [
    { key: '__from', label: 'From depth(m)' },
    { key: '__to',   label: 'End depth(m)' }
  ];
  attrs.forEach(a => headers.push({ key: a, label: a.toUpperCase() + '(' + assayUnitOf(a) + ')' }));

  // third, the rows follow the order in which the intervals first appear
  const rows = rangeOrder.map(rg => {
    const vals = {};
    attrs.forEach(a => {
      const hit = perAttr[a].get(rg.k);
      vals[a] = hit ? hit.value : null;   // null = 该元素在此区间无数据
    });
    return { from: rg.from, to: rg.to, values: vals };
  });
  return { headers: headers, rows: rows };
}

// )
// ,
// ,
// ,
const ASSAY_UNITS = { AU: 'g/t', AG: 'g/t', S: '%' };
function assayUnitOf(attr) {
  const k = String(attr || '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(ASSAY_UNITS, k) ? ASSAY_UNITS[k] : '';
}

// ,
function findDrawingImage(categoryName, holeid) {
  const root = document.getElementById('subitems-drawing-mgmt');
  if (!root) return null;
  const target = String(holeid).trim().toLowerCase();
  const cats = root.querySelectorAll('[data-role="drawing-category"]');
  for (const cat of cats) {
    const catName = ((cat.querySelector('span') || {}).textContent || '').trim();
    if (catName !== categoryName) continue;
    const nested = cat.nextElementSibling;
    if (!nested || !nested.classList.contains('lp-nested-items')) continue;
    const fileNodes = nested.querySelectorAll('.lp-sub-item[data-drawing-id], .lp-sub-item[data-drawing-path]');
    for (const fn of fileNodes) {
      const fileName = ((fn.querySelector('span') || {}).textContent || '').trim();
      const baseName = fileName.replace(/\.[^.]+$/, '').trim().toLowerCase();
      if (baseName === target) {
        return fn.getAttribute('data-drawing-blob') || fn.getAttribute('data-drawing-path') || '';
      }
    }
  }
  return null;
}

// )
// ,
// the interval form, for example ZK1203_1到50m, ZK1203_1-50m or ZK1203_1~50m, takes the lower bound 1
// ,
// the single value form, for example ZK1203_50m or ZK1203_50.5m, takes 50 or 50.5
// ,
// )
function extractDepth(fileName) {
  const s = String(fileName || '');
  // ,
  const base = s.replace(/\.[^.]+$/, '');

  // ,
  // for example ZK1203_1到50m, ZK1203_1-50m, ZK1203_1至50 or ZK1203_1~50m
  const range = base.match(/(\d+(?:\.\d+)?)\s*(?:到|至|-|~|—|–|--)\s*(\d+(?:\.\d+)?)\s*[mM]?/);
  if (range) return parseFloat(range[1]);   // ★ 取区间【下界】

  // )
  const single = base.match(/(\d+(?:\.\d+)?)\s*[mM]\b/);
  if (single) return parseFloat(single[1]);

  // third, when there is no unit, take the last number of the part that is not the hole number
  // ,
  const stripped = base.replace(/^[A-Za-z]*\d+/, '');
  if (stripped !== base) {
    // once the hole number has been stripped off the depth can only come from the remainder, and if the remainder has no number then there is no depth
    // ,
    const nums = stripped.match(/\d+(?:\.\d+)?/g);
    return (nums && nums.length) ? parseFloat(nums[nums.length - 1]) : Infinity;
  }

  // )
  // in that case the last number is the depth
  const all = base.match(/\d+(?:\.\d+)?/g);
  if (all && all.length) return parseFloat(all[all.length - 1]);
  return Infinity;
}

// ,
//
// .
// .
// ,
// .
// ,
//
// ,
// ,
// B. under the core photographs, a file name that begins with the hole number followed by a separator collects all the matching images
// )
// )
// ,
// )
// )
function findCoreImages(holeid) {
  const root = document.getElementById('subitems-drawing-mgmt');
  if (!root) return [];
  const target = String(holeid).trim().toLowerCase();
  if (!target) return [];

  // ,
  const collectFiles = (nested, filter) => {
    if (!nested || !nested.classList.contains('lp-nested-items')) return [];
    // ,
    const fileNodes = Array.from(nested.children).filter(el =>
      el.classList && el.classList.contains('lp-sub-item') &&
      (el.getAttribute('data-drawing-id') || el.getAttribute('data-drawing-path')));
    const result = [];
    fileNodes.forEach(fn => {
      const fileName = ((fn.querySelector('span') || {}).textContent || '').trim();
      const url = fn.getAttribute('data-drawing-blob') || fn.getAttribute('data-drawing-path') || '';
      if (!url) return;
      if (filter && !filter(fileName)) return;
      result.push({ name: fileName, url: url, depth: extractDepth(fileName) });
    });
    return result;
  };

  // )
  const belongsTo = (fileName) => {
    const baseName = fileName.replace(/\.[^.]+$/, '').trim().toLowerCase();
    if (baseName === target) return true;                       // C：整孔一张
    if (!baseName.startsWith(target)) return false;             // B：必须以孔号开头
    const rest = baseName.slice(target.length);
    // ,
    return /^[\s_\-·.、,，]+/.test(rest);
  };

  const sortByDepth = (arr) => arr.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.name.localeCompare(b.name, 'zh');   // 深度相同按名称稳定排序
  });

  const allCats = root.querySelectorAll('[data-role="drawing-category"]');

  // ,
  const coreCats = Array.from(allCats).filter(cat => {
    const catName = ((cat.querySelector('span') || {}).textContent || '').trim();
    return catName === 'Core Data';
  });

  const exactSubHits = [];   // 规则 A
  const prefixHits = [];     // 规则 B + C
  const deepHits = [];       // 规则 D

  for (const cat of coreCats) {
    const nested = cat.nextElementSibling;
    if (!nested || !nested.classList.contains('lp-nested-items')) continue;

    const subCats = Array.from(nested.children).filter(el =>
      el.getAttribute && el.getAttribute('data-role') === 'drawing-category');

    // rule A: the subcategory name equals the hole number
    for (const sub of subCats) {
      const subName = ((sub.querySelector('span') || {}).textContent || '').trim();
      if (subName.toLowerCase() === target) {
        exactSubHits.push(...collectFiles(sub.nextElementSibling, null));
      }
    }

    // )
    prefixHits.push(...collectFiles(nested, belongsTo));

    // ,
    for (const sub of subCats) {
      const subName = ((sub.querySelector('span') || {}).textContent || '').trim();
      if (subName.toLowerCase() === target) continue;   // A 已覆盖
      deepHits.push(...collectFiles(sub.nextElementSibling, belongsTo));
    }
  }

  // the priority is A, then B and C, then D
  if (exactSubHits.length > 0) return sortByDepth(exactSubHits);
  if (prefixHits.length > 0) return sortByDepth(prefixHits);
  if (deepHits.length > 0) return sortByDepth(deepHits);
  return [];
}

// )
// section 74 rewrite: it changed from one narrow table per element to a single wide combined table
// the header looks like: start depth (m) | end depth (m) | AU (g/t) | AG (g/t) | S (%)
// )
// ,
function buildAssayTableHtml(info) {
  const wide = info.assayWide;
  // )
  if (wide && wide.rows && wide.rows.length > 0) {
    let html = '<div class="rp-section">';
    html += '<table class="rp-assay-table"><thead><tr>';
    wide.headers.forEach(h => { html += '<th>' + escapeHtml(h.label) + '</th>'; });
    html += '</tr></thead><tbody>';
    wide.rows.forEach(r => {
      html += '<tr><td>' + fmtAssayNum(r.from) + '</td><td>' + fmtAssayNum(r.to) + '</td>';
      wide.headers.slice(2).forEach(h => {
        const v = r.values[h.key];
        html += '<td>' + (v == null ? '-' : fmtAssayNum(v)) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  // 
  const attrs = Object.keys(info.geochem);
  if (attrs.length === 0) {
    return '<div class="rp-hole-empty">Not found“' + escapeHtml(info.holeid) + '”assay data</div>';
  }
  let html = '';
  attrs.forEach(attr => {
    const rows = info.geochem[attr];
    html += '<div class="rp-section"><div class="rp-section-title">' + escapeHtml(attr) + '</div>';
    html += '<table class="rp-assay-table"><thead><tr><th>From depth(m)</th><th>End depth(m)</th><th>'
      + escapeHtml(attr.toUpperCase() + (assayUnitOf(attr) ? '(' + assayUnitOf(attr) + ')' : ''))
      + '</th></tr></thead><tbody>';
    rows.forEach(r => {
      html += '<tr><td>' + fmtAssayNum(r.from) + '</td><td>' + fmtAssayNum(r.to) + '</td><td>' + fmtAssayNum(r.value) + '</td></tr>';
    });
    html += '</tbody></table></div>';
  });
  return html;
}

// ,
function fmtAssayNum(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v == null ? '' : v);
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

// after a right-click hits a drillhole, fill the three tabs, open the panel and activate the bar chart
function showHoleDetail(holeid) {
  window._lastHoleDetailId = holeid;   // ,
  const info = collectHoleInfo(holeid);
  const columnImg = findDrawingImage('Drillhole Log', holeid);

  const colEl = document.getElementById('rp-column-img');
  if (colEl) {
    if (columnImg) {
      colEl.innerHTML = '<div class="rp-hole-title">' + escapeHtml(holeid) + ' · Drillhole Log</div><img class="rp-hole-img" src="' + escapeHtml(columnImg) + ' " alt="Drillhole Log">';
    } else {
      colEl.innerHTML = '<div class="rp-hole-empty">Not found“' + escapeHtml(holeid) + '”log images</div>';
    }
  }

  const coreImages = findCoreImages(holeid);
  console.log('[Linked drillhole data] holeid= ' + holeid + ' Drillhole Log=' + (columnImg ? 'with' : 'None') + ' Core image=' + coreImages.length + ' images');
  const coreEl = document.getElementById('rp-core-img');
  if (coreEl) {
    if (coreImages.length > 0) {
      let html = '<div class="rp-hole-title">' + escapeHtml(holeid) + ' · Core images (' + coreImages.length + ' images) </div>';
      coreImages.forEach(img => {
        html += '<div class="rp-core-item"><div class="rp-core-depth">' + escapeHtml(img.name) + '</div><img class="rp-hole-img" src="' + escapeHtml(img.url) + '" alt="Core images"></div>';
      });
      coreEl.innerHTML = html;
    } else {
      // ,
      let subNameList = '';
      try {
        const r = document.getElementById('subitems-drawing-mgmt');
        const cat = r ? Array.from(r.querySelectorAll('[data-role="drawing-category"]'))
          .find(c => ((c.querySelector('span') || {}).textContent || '').trim() === 'Core Data') : null;
        const nx = cat ? cat.nextElementSibling : null;
        if (nx) {
          const names = Array.from(nx.children)
            .filter(el => el.getAttribute && el.getAttribute('data-role') === 'drawing-category')
            .map(el => ((el.querySelector('span') || {}).textContent || '').trim())
            .filter(Boolean);
          if (names.length) subNameList = 'Current“Core Data”already contains subcategories:  ' + names.map(escapeHtml).join('、') + '<br>';
        }
      } catch (e) {}
      coreEl.innerHTML = '<div class="rp-hole-empty">Not found“' + escapeHtml(holeid) + '”core images<br><span style="font-size:11px;">' + subNameList + ' In the project tree,“Core Data”right-click →“New subcategory”, create a category named ' + escapeHtml(holeid) + ' subcategories, then right-click it“Import map or figure”<br>The image can also be named ' + escapeHtml(holeid) + '_1 to 50m.jpg in this form“Core Data”under, Automatically sorted by depth</span></div>';
    }
  }

  const assayEl = document.getElementById('rp-assay-data');
  if (assayEl) assayEl.innerHTML = buildAssayTableHtml(info);

  if (window.setRightPanelVisible) window.setRightPanelVisible(true);
  activateRightTab('Drillhole Log');
}

// ,
// 
// ,
// .
// ,
// .
function refreshHolePanelIfOpen() {
  const holeid = window._lastHoleDetailId;
  if (!holeid) return;
  const btn = document.getElementById('btn-toggle-right-panel');
  if (btn && btn.classList && !btn.classList.contains('active')) return;
  // )
  showHoleDetail(holeid);
}

// right-click the 3D canvas: pick the drillhole collar and show the details of that drillhole
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (state.measureMode) return;
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  // )
  // ,
  // ,
  const hitPoint = pickPointSphereAt(e.clientX, e.clientY);
  if (hitPoint) {
    const H = hitPoint.layer.headers || POINT_BASE_HEADERS;
    const row = (hitPoint.layer.rows || [])[hitPoint.rowIndex] || [];
    const nm = document.getElementById('ctx-point-name');
    if (nm) {
      const hid = row[0] != null && String(row[0]) !== '' ? String(row[0]) : ('#' + (hitPoint.rowIndex + 1));
      nm.textContent = hitPoint.layer.name + ' · ' + hid;
    }
    const del = document.getElementById('ctx-point-delete');
    if (del) del.style.display = H.length ? '' : 'none';
    ctxContext = {
      type: 'point-sphere',
      target: null,
      pointLayerId: hitPoint.layer.id,
      pointRowIndex: hitPoint.rowIndex
    };
    filterCtxMenu('point-sphere');
    showCtxMenu(e.clientX, e.clientY);
    return;
  }

  const inSceneModels = state.models.filter(m => m.inScene);
  const drillMeshes = inSceneModels
    .filter(m => m.isCollarPoints || (m.category && m.category.search(/钻孔|Drillhole/i) === 0))
    .map(m => m.mesh).filter(m => m && m.visible);
  if (drillMeshes.length === 0) return;
  const hits = raycaster.intersectObjects(drillMeshes, true);
  if (hits.length === 0) return;
  const holeid = hits[0].object.userData && hits[0].object.userData.holeid;
  if (!holeid) return;
  showHoleDetail(String(holeid));
});

// pick the small point sphere at a given position on the screen; null is returned when nothing is hit
// ,
function pickPointSphereAt(clientX, clientY) {
  if (state.measureMode) return null;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const pointModels = state.models.filter(m => m.inScene && m.isPointLayer && m.mesh && m.mesh.visible);
  if (!pointModels.length) return null;
  const hits = ray.intersectObjects(pointModels.map(m => m.mesh), true);
  for (let i = 0; i < hits.length; i++) {
    const o = hits[i].object;
    if (!o || !o.userData || !o.userData.isPointSphere) continue;
    const owner = findPointModelOwner(o, pointModels);
    if (!owner) continue;
    const layer = state.pointLayers[owner.pointLayerId];
    if (!layer) continue;
    const ri = o.userData.rowIndex;
    if (ri == null || ri < 0 || !(layer.rows || [])[ri]) {
      flashPointHint('Unable to locate the data row for this point (This may be data imported by an earlier version) , Use“Edit point data”Table changes');
      return null;
    }
    return { layer: layer, model: owner, sphere: o, rowIndex: ri };
  }
  return null;
}

// walk up the parent chain to find the point layer modelObj that owns the sphere
function findPointModelOwner(sphere, pointModels) {
  for (let k = 0; k < pointModels.length; k++) {
    let p = sphere;
    while (p) { if (p === pointModels[k].mesh) return pointModels[k]; p = p.parent; }
  }
  return null;
}

// ============================================================
// the coordinate system check on drag
// the threshold: a difference of less than 5000 metres in each origin component counts as the same coordinate system
// ,
// a different coordinate system shows a dialog, creates a new tab automatically and loads it there
// ============================================================
const COORDSYS_THRESHOLD = 5000;

// compute the coordinate system origin of the dragged data
// a .ts model uses geoMesh.fileOrigin and the drillhole data is computed from the collar coordinates
function computeDragModelOrigin(payload) {
  // )
  if (payload.type === 'table-category' || payload.type === 'geochem-attr') {
    const tables = collectDrillholeTables();
    if (!tables.collar) return null;
    const collars = parseCollarTable(tables.collar);
    if (collars.length === 0) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    collars.forEach(c => {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.z < minZ) minZ = c.z;
    });
    return {
      x: Math.floor(minX / 100) * 100,
      y: Math.floor(minY / 100) * 100,
      z: Math.floor(minZ / 100) * 100
    };
  }
  // ,
  if (payload.type === 'point-category') {
    const layer = payload.pointId ? state.pointLayers[payload.pointId] : null;
    if (!layer) return null;
    if (layer.origin) return layer.origin;
    const cols = layer.collars || [];
    if (!cols.length) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    cols.forEach(c => {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.z < minZ) minZ = c.z;
    });
    return {
      x: Math.floor(minX / 100) * 100,
      y: Math.floor(minY / 100) * 100,
      z: Math.floor(minZ / 100) * 100
    };
  }
  // )
  const fileNames = payload.fileNames || [];
  for (let i = 0; i < fileNames.length; i++) {
    const fn = fileNames[i];
    const cacheKey = payload.modelIds?.[i] && geoMeshCache.has(payload.modelIds[i]) ? payload.modelIds[i] : fn;
    if (cacheKey && geoMeshCache.has(cacheKey)) {
      const cached = geoMeshCache.get(cacheKey);
      if (cached.geoMesh && cached.geoMesh.fileOrigin) {
        return cached.geoMesh.fileOrigin;
      }
    }
  }
  // the fallback takes the geoMesh.fileOrigin of a model already in state.models
  const ids = payload.modelIds || [];
  for (let i = 0; i < ids.length; i++) {
    const m = state.models.find(x => x.id === ids[i]);
    if (m && m.geoMesh && m.geoMesh.fileOrigin) {
      return m.geoMesh.fileOrigin;
    }
  }
  return null;
}

// )
function needsCoordsysCheck(payload) {
  // )
  if (payload.type === 'table-category' || payload.type === 'geochem-attr') return true;
  // )
  if (payload.type === 'point-category') {
    const layer = payload.pointId ? state.pointLayers[payload.pointId] : null;
    if (!layer) return false;
    const m = state.models.find(x => x.isPointLayer && x.pointLayerId === layer.id);
    return !(m && m.inScene);
  }
  // a .ts model file is only checked when some file is not already in the state.models of the current tab
  const ids = payload.modelIds || [];
  for (let i = 0; i < ids.length; i++) {
    if (!state.models.find(x => x.id === ids[i])) return true;
  }
  return false;
}

// ,
async function processDropPayload(payload) {
  if(window.researchRegionViews){
    const models=getProjectModels(),first=models.find(model=>(payload.modelIds||[]).includes(model.id));
    const cached=(payload.modelIds||[]).map(id=>geoMeshCache.get(id)).find(Boolean);
    const owner=first?.regionId||cached?.options?.regionId||state.drawings?.[payload.drawingKey]?.regionId;
    if(owner)await researchRegionViews.ensure(owner);
  }

  // dragging a registered figure creates a translucent textured plane in the 3D view
  if (payload.type === 'drawing-file') {
    const reg = drawingRegisters[payload.drawingKey];
    if (!reg || !reg.done) {
      window.showTabModal({ title: 'Image is not registered', label: 'Register this image using control points first (Under Maps and Figures, click“Register”button) , Then drag into the 3D view to create an image plane. ' });
      return;
    }
    buildRegisterPlaneInScene(reg);
    return;
  }
  // dragging a drillhole category routes to the matching visualisation based on the category name
  if (payload.type === 'table-category') {
    const catName = (payload.categoryName || '').trim();
    if (catName.search(/孔口|Collar/i) >= 0) {
      visualizeCollarPoints();
    } else if (catName.search(/测斜|Survey/i) >= 0) {
      visualizeSurveyOnly();
    } else if (catName.search(/蚀变|Alteration/i) >= 0) {
      visualizeAlterationDrillholes();
    } else if (catName.search(/地质|Geolog/i) >= 0 || catName.search(/岩性|Litholog/i) >= 0) {
      visualizeLithologyDrillholes();
    } else {
      showTableError('Unrecognized drillhole category: " ' + catName + ' "\n Draggable category: Collar Table / Downhole Survey / Geological Data / Alteration Data. ');
    }
    return;
  }
  // dragging a geochemical attribute subcategory maps the diverging colour scale to the magnitude of the values
  if (payload.type === 'geochem-attr') {
    visualizeGeochemDrillholes(payload.attrName, payload.attrRawName);
    return;
  }
  // )
  if (payload.type === 'point-category') {
    const pid = payload.pointId;
    const layer = pid ? state.pointLayers[pid] : null;
    if (!layer) {
      flashPointHint('Point category not found, It may have been deleted');
      return;
    }
    const n = ((layer.collars && layer.collars.length) || (layer.rows && layer.rows.length) || 0);
    if (!n) {
      // an empty category has to give visible feedback, otherwise the user only sees that dragging it did nothing
      flashPointHint('「' + layer.name + ' ”is an empty category, No points yet. Right-click this category →“Draw points”Place points on the model surface');
      return;
    }
    // when it is already shown, give a notice and highlight it, otherwise show it
    const model = state.models.find(m => m.isPointLayer && m.pointLayerId === layer.id);
    if (model && model.inScene) {
      flashPointHint('「' + layer.name + ' ”Already visible in this view (' + n + ' points) ');
    } else {
      rebuildHandLayer(layer);      // 确保 collars/attrs 与 rows 同步
      renderPointLayer(layer);
      // ,
      // 
      // ,
      // )
      flashPointHint('Point category displayed“ ' + layer.name + '」（' + n + ' points) ');
    }
    return;
  }
  // )
  if (payload.type === 'blockmodel') {
    const bm = state.models.find(x => x.id === payload.modelId);
    if (!bm) {
      flashBlockHint('Block model category not found, It may have been deleted');
      return;
    }
    const label = bm.blockClass || bm.name || 'Block Model';
    if (bm.inScene) {
      flashBlockHint('「' + label + ' ”Already visible in this view');
      return;
    }
    addModelToView(bm);
    flashBlockHint('Block model displayed“ ' + label + '」');
    return;
  }
  // dragging a .ts model file
  const ids = payload.modelIds || [];
  const fileNames = payload.fileNames || [];
  ids.forEach((id, idx) => {
    const m = state.models.find(x => x.id === id);
    if (m) {
      if (!m.inScene) addModelToView(m);
    } else {
      const fn = fileNames[idx];
      const cacheKey = geoMeshCache.has(id) ? id : fn;
      if (cacheKey && geoMeshCache.has(cacheKey)) {
        const cached = geoMeshCache.get(cacheKey);
        const existing = state.models.find(x => x.fileName === fn && x.regionId === cached.options.regionId);
        if (!existing) {
          loadModelToScene(cached.geoMesh, cached.category, fn,
            Object.assign({}, cached.options, { skipTreeNode: true }));
        } else if (!existing.inScene) {
          addModelToView(existing);
        }
      }
    }
  });
}

canvas.addEventListener('drop', async (e) => {
  e.preventDefault();
  canvas.classList.remove('drag-target');
  const raw = e.dataTransfer.getData('text/plain');
  if (!raw) return;

  // ,
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_err) {
    payload = { type: 'file', modelIds: [raw], fileNames: [] };
  }

  // the coordinate system check only runs when a new model has to be loaded from the cache
  if(window.researchRegionViews){
    const first=getProjectModels().find(model=>(payload.modelIds||[]).includes(model.id));
    const cached=(payload.modelIds||[]).map(id=>geoMeshCache.get(id)).find(Boolean);
    const owner=first?.regionId||cached?.options?.regionId||state.drawings?.[payload.drawingKey]?.regionId;
    if(owner){try{await researchRegionViews.ensure(owner);}catch(error){alert(error.message);return;}}
  }
  if (needsCoordsysCheck(payload)) {
    const modelOrigin = computeDragModelOrigin(payload);
    // ,
    // )
    if (modelOrigin && state.origin) {
      const dx = Math.abs(modelOrigin.x - state.origin.x);
      const dy = Math.abs(modelOrigin.y - state.origin.y);
      const dz = Math.abs(modelOrigin.z - state.origin.z);
      if (dx >= COORDSYS_THRESHOLD || dy >= COORDSYS_THRESHOLD || dz >= COORDSYS_THRESHOLD) {
        // a different coordinate system shows a dialog, creates a new tab and loads it there
        window.showTabModal({
          title: 'Coordinate systems differ',
          label: 'The model appears to use a different coordinate system from the current view: <br><br>' +
                 ' Current view origin: X=' + state.origin.x + '  Y=' + state.origin.y + '  Z=' + state.origin.z + '<br>' +
                 ' Model origin: X=' + modelOrigin.x + '  Y=' + modelOrigin.y + '  Z=' + modelOrigin.z + '<br><br>' +
                 ' A new view tab will be created for this model. ',
          confirmText: 'New tab',
          onConfirm: async function() {
            const id=await window.createNewTab('3d', { label: 'New coordinate system' });
            if(id)await processDropPayload(payload);
          }
        });
        return;
      }
    }
  }

  // )
  processDropPayload(payload);
});

// 4. Clipping
const btnClip = document.getElementById('btn-clip');
const clipPanel = document.getElementById('clip-panel');
btnClip.addEventListener('click', () => {
  state.clipMode = !state.clipMode;
  btnClip.classList.toggle('active', state.clipMode);
  if (state.clipMode) {
    enableClipping();
  } else {
    disableClipping();
  }
});

// the layer management
document.getElementById('clip-panel-close').addEventListener('click', () => {
  clipPanel.classList.remove('visible');
  addClipLayerItem();
});

// get the array of the clipping planes that are currently enabled
function getActiveClipPlanes() {
  const planes = [];
  const cfg = state.clipConfig;
  // ,
  if (cfg.h.enabled) {
    const n = cfg.h.dir === 'above' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, -1, 0);
    const c = cfg.h.dir === 'above' ? -cfg.h.value : cfg.h.value;
    planes.push(new THREE.Plane(n, c));
  }
  // ,
  if (cfg.x.enabled) {
    const n = cfg.x.dir === 'pos' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(-1, 0, 0);
    const c = cfg.x.dir === 'pos' ? -cfg.x.value : cfg.x.value;
    planes.push(new THREE.Plane(n, c));
  }
  // ,
  if (cfg.y.enabled) {
    const n = cfg.y.dir === 'pos' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 0, -1);
    const c = cfg.y.dir === 'pos' ? -cfg.y.value : cfg.y.value;
    planes.push(new THREE.Plane(n, c));
  }
  return planes;
}

// )
function getSceneBoundingBox() {
  const box = new THREE.Box3();
  state.models.forEach(m => { expandModelBox3(box, m); });
  return box;
}

// )
function getGlobalOrigin() {
  if (state.origin) return state.origin;
  // the fallback infers it from the model fileOrigin
  const firstWithFileOrigin = state.models.find(m => m.geoMesh && m.geoMesh.fileOrigin);
  if (firstWithFileOrigin) {
    state.origin = { x: firstWithFileOrigin.geoMesh.fileOrigin.x, y: firstWithFileOrigin.geoMesh.fileOrigin.y, z: firstWithFileOrigin.geoMesh.fileOrigin.z };
    return state.origin;
  }
  return { x: 0, y: 0, z: 0 };
}

// initialise the slider range
function initClipSliderRanges() {
  const box = getSceneBoundingBox();
  if (box.isEmpty()) return;
  const ox = getGlobalOrigin();
  // )
  const hSlider = document.getElementById('clip-h-slider');
  hSlider.min = box.min.y;
  hSlider.max = box.max.y;
  hSlider.value = (box.min.y + box.max.y) / 2;
  state.clipConfig.h.value = parseFloat(hSlider.value);
  // )
  const xSlider = document.getElementById('clip-x-slider');
  xSlider.min = box.min.x;
  xSlider.max = box.max.x;
  xSlider.value = (box.min.x + box.max.x) / 2;
  state.clipConfig.x.value = parseFloat(xSlider.value);
  // )
  const ySlider = document.getElementById('clip-y-slider');
  ySlider.min = box.min.z;
  ySlider.max = box.max.z;
  ySlider.value = (box.min.z + box.max.z) / 2;
  state.clipConfig.y.value = parseFloat(ySlider.value);
  updateClipValueLabels();
}

// )
function updateClipValueLabels() {
  const ox = getGlobalOrigin();
  const cfg = state.clipConfig;
  // horizontal: GOCAD Z = ThreeY + oz
  document.getElementById('clip-h-value').textContent = 'Elevation: ' + Math.round(cfg.h.value + ox.z);
  // vertical X: GOCAD X = ThreeX + ox
  document.getElementById('clip-x-value').textContent = 'X: ' + Math.round(cfg.x.value + ox.x);
  // vertical Y: GOCAD Y = -ThreeZ + oy
  document.getElementById('clip-y-value').textContent = 'Y: ' + Math.round(-cfg.y.value + ox.y);
}

// create or update the clipping visualisation plane
function updateClipHelpers() {
  // remove the old helper
  state.clipHelpers.forEach(h => {
    scene.remove(h);
    if (h.geometry) h.geometry.dispose();
    if (h.material) h.material.dispose();
  });
  state.clipHelpers = [];

  const box = getSceneBoundingBox();
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) * 1.5;

  const cfg = state.clipConfig;
  const helperColors = { h: 0x0969da, x: 0xff0000, y: 0x0000ff };

  function makeHelper(normal, position, color, axisKey) {
    const geo = new THREE.PlaneGeometry(maxDim, maxDim);
    const mat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position);
    // align the plane normal with the normal
    mesh.lookAt(position.clone().add(normal));
    mesh.renderOrder = 1;
    scene.add(mesh);
    state.clipHelpers.push(mesh);
  }

  if (cfg.h.enabled) {
    makeHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(center.x, cfg.h.value, center.z), helperColors.h, 'h');
  }
  if (cfg.x.enabled) {
    makeHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(cfg.x.value, center.y, center.z), helperColors.x, 'x');
  }
  if (cfg.y.enabled) {
    makeHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(center.x, center.y, cfg.y.value), helperColors.y, 'y');
  }
}

// apply the clipping plane to the material of every model
function applyClipPlanes() {
  const planes = getActiveClipPlanes();
  state.models.forEach(m => {
    // apply the clipping
    const mats = m.materials || [m.material];
    mats.forEach(mt => {
      mt.clippingPlanes = planes;
      mt.clipShadows = planes.length > 0;
      mt.needsUpdate = true;
    });
  });
  updateClipHelpers();
}

function enableClipping() {
  // initialise the slider range
  initClipSliderRanges();
  // show the control panel
  clipPanel.classList.add('visible');
  // the layer management
  const existingItem = document.getElementById('lm-clip-item');
  if (existingItem) existingItem.remove();
  // apply the clipping
  applyClipPlanes();
}

function disableClipping() {
  // remove the clipping plane from every material
  state.models.forEach(m => {
    const mats = m.materials || [m.material];
    mats.forEach(mt => {
      mt.clippingPlanes = [];
      mt.needsUpdate = true;
    });
  });
  // hide the panel
  clipPanel.classList.remove('visible');
  // remove the clipping entry from the layer management
  const clipItem = document.getElementById('lm-clip-item');
  if (clipItem) clipItem.remove();
  // clear the visualisation
  state.clipHelpers.forEach(h => {
    scene.remove(h);
    if (h.geometry) h.geometry.dispose();
    if (h.material) h.material.dispose();
  });
  state.clipHelpers = [];
  // reset the enabled state
  state.clipConfig.h.enabled = false;
  state.clipConfig.x.enabled = false;
  state.clipConfig.y.enabled = false;
  // synchronise the checkbox
  document.getElementById('clip-h-enabled').checked = false;
  document.getElementById('clip-x-enabled').checked = false;
  document.getElementById('clip-y-enabled').checked = false;
}

// ========== the clipping slider and the toggle events ==========
function bindClipControl(axisKey, sliderId, checkboxId, dirBtnIds) {
  const slider = document.getElementById(sliderId);
  const checkbox = document.getElementById(checkboxId);

  slider.addEventListener('input', () => {
    state.clipConfig[axisKey].value = parseFloat(slider.value);
    updateClipValueLabels();
    applyClipPlanes();
  });

  checkbox.addEventListener('change', () => {
    state.clipConfig[axisKey].enabled = checkbox.checked;
    applyClipPlanes();
  });

  // the direction button
  dirBtnIds.forEach(btnId => {
    const btn = document.getElementById(btnId);
    btn.addEventListener('click', () => {
      // clear the active class from the other buttons in the same group
      dirBtnIds.forEach(id => document.getElementById(id).classList.remove('active'));
      btn.classList.add('active');
      state.clipConfig[axisKey].dir = btn.getAttribute('data-dir');
      applyClipPlanes();
    });
  });
}

bindClipControl('h', 'clip-h-slider', 'clip-h-enabled', ['clip-h-dir-above', 'clip-h-dir-below']);
bindClipControl('x', 'clip-x-slider', 'clip-x-enabled', ['clip-x-dir-pos', 'clip-x-dir-neg']);
bindClipControl('y', 'clip-y-slider', 'clip-y-enabled', ['clip-y-dir-pos', 'clip-y-dir-neg']);

// the layer management
function addClipLayerItem() {
  // do not add it again when it already exists
  if (document.getElementById('lm-clip-item')) return;
  const lmList = document.getElementById('lm-list');
  const item = document.createElement('div');
  item.className = 'lm-item lm-clip-item';
  item.id = 'lm-clip-item';
  item.draggable = false;
  // build the description text
  const desc = buildClipDesc();
  item.innerHTML =
    '<span class="lm-delete" title="Clear clipping">❌</span>' +
    '<div class="lm-color" style="background:#0969da"></div>' +
    '<span class="lm-name">' + desc + '</span>';
  lmList.appendChild(item);

  // the cross deletes and clears the clipping
  item.querySelector('.lm-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    item.remove();
    // clear the clipping
    state.clipMode = false;
    btnClip.classList.remove('active');
    disableClipping();
  });

  // a double click reopens the clipping control panel
  item.addEventListener('dblclick', (e) => {
    if (e.target.closest('.lm-delete') || e.target.closest('.lm-color')) return;
    clipPanel.classList.add('visible');
    item.remove();
  });
}

// build the clipping description text
function buildClipDesc() {
  const cfg = state.clipConfig;
  const ox = getGlobalOrigin();
  const parts = [];
  if (cfg.h.enabled) {
    parts.push('Z:' + Math.round(cfg.h.value + ox.z) + (cfg.h.dir === 'above' ? '↑' : '↓'));
  }
  if (cfg.x.enabled) {
    parts.push('X:' + Math.round(cfg.x.value + ox.x) + (cfg.x.dir === 'pos' ? '→' : '←'));
  }
  if (cfg.y.enabled) {
    parts.push('Y:' + Math.round(-cfg.y.value + ox.y) + (cfg.y.dir === 'pos' ? '↑' : '↓'));
  }
  return 'Clip ' + (parts.length > 0 ? parts.join(' ') : ' (None enabled) ');
}

// ========== the measuring line layer entry ==========
function addMeasureLayerItem(rulerItem) {
  const layerList = lmList;
  const item = document.createElement('div');
  item.className = 'lm-item lm-measure-item';
  item.id = 'lm-' + rulerItem.id;
  item.draggable = false;
  item.innerHTML =
    '<span class="lm-delete" title="Delete measurement line">❌</span>' +
    '<div class="lm-color" style="background:#39FF14"></div>' +
    '<span class="lm-name">Measure ' + rulerItem.distance.toFixed(2) + ' m</span>';
  layerList.appendChild(item);

  // the cross deletes and removes that measuring line
  item.querySelector('.lm-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    removeRulerItem(rulerItem);
    item.remove();
  });

  // a double click focuses that measuring line
  item.addEventListener('dblclick', (e) => {
    if (e.target.closest('.lm-delete') || e.target.closest('.lm-color')) return;
    const center = new THREE.Vector3();
    const positions=rulerItem.line.geometry.attributes.position;
    center.fromBufferAttribute(positions,0);
    const end=new THREE.Vector3().fromBufferAttribute(positions,1);
    center.add(end).multiplyScalar(0.5);
    controls.target.copy(center);
    controls.update();
  });
}

// )
function removeRulerItem(rulerItem) {
  if (rulerItem.line) {
    scene.remove(rulerItem.line);
    rulerItem.line.geometry.dispose();
    rulerItem.line.material.dispose();
    const idx = state.rulerLines.indexOf(rulerItem.line);
    if (idx >= 0) state.rulerLines.splice(idx, 1);
  }
  if (rulerItem.sprite) {
    scene.remove(rulerItem.sprite);
    if (rulerItem.sprite.material.map) rulerItem.sprite.material.map.dispose();
    rulerItem.sprite.material.dispose();
    const idx = state.rulerLines.indexOf(rulerItem.sprite);
    if (idx >= 0) state.rulerLines.splice(idx, 1);
  }
  if (rulerItem.startSphere) {
    scene.remove(rulerItem.startSphere);
    rulerItem.startSphere.geometry.dispose();
    rulerItem.startSphere.material.dispose();
    const idx = state.rulerPoints.indexOf(rulerItem.startSphere);
    if (idx >= 0) state.rulerPoints.splice(idx, 1);
  }
  if (rulerItem.endSphere) {
    scene.remove(rulerItem.endSphere);
    rulerItem.endSphere.geometry.dispose();
    rulerItem.endSphere.material.dispose();
    const idx = state.rulerPoints.indexOf(rulerItem.endSphere);
    if (idx >= 0) state.rulerPoints.splice(idx, 1);
  }
  const idx = state.rulerItems.indexOf(rulerItem);
  if (idx >= 0) state.rulerItems.splice(idx, 1);
}

// 5. Screenshot
document.getElementById('btn-snapshot').addEventListener('click', () => {
  renderer.render(scene, camera);
  canvas.toBlob(blob => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'Screenshot_ ' + Date.now() + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
});

// ============================================================
// the three toolbar buttons for coordinates, scale and legend share a synchronised state
// the single source of truth is state.compassVisible, state.legendVisible and state.axisLabelsVisible
// on every state change the DOM hidden attributes and the active class of the buttons are updated together
// ============================================================
const compassParamsEl = document.getElementById('compass-params-box');
const sceneLegendEl   = document.getElementById('scene-legend');
const btnCompass      = document.getElementById('btn-toggle-compass');
const btnLegend       = document.getElementById('btn-toggle-legend');
const btnAxisLabels   = document.getElementById('btn-toggle-axis-labels');

function syncToolbarToggleButtons() {
  // )
  if (compassParamsEl) {
    compassParamsEl.classList.toggle('hidden', !state.compassVisible);
  }
  if (btnCompass) btnCompass.classList.toggle('active', !!state.compassVisible);

  // 2. Legend
  if (sceneLegendEl) {
    sceneLegendEl.classList.toggle('hidden', !state.legendVisible);
  }
  if (btnLegend) btnLegend.classList.toggle('active', !!state.legendVisible);

  // )
  if (state.axisLabelGroup) {
    state.axisLabelGroup.visible = !!state.axisLabelsVisible;
  }
  if (btnAxisLabels) btnAxisLabels.classList.toggle('active', !!state.axisLabelsVisible);
}

// 6. The coordinate toggle switches the compass and the inclination and azimuth readouts
btnCompass.addEventListener('click', function () {
  state.compassVisible = !state.compassVisible;
  syncToolbarToggleButtons();
});

// 7. The legend toggle switches the legend
btnLegend.addEventListener('click', function () {
  state.legendVisible = !state.legendVisible;
  syncToolbarToggleButtons();
});

// 8. The scale toggle switches the coordinate axis tick labels and the XYZ axis segments
btnAxisLabels.addEventListener('click', function () {
  state.axisLabelsVisible = !state.axisLabelsVisible;
  syncToolbarToggleButtons();
});

// the state
syncToolbarToggleButtons();

// ============================================================
// the compass, scale bar and view parameter update
// ============================================================
let lastAzimuth = null, lastPlunge = null;

// ============================================================
// )
// ============================================================
// )
// first, document.querySelectorAll on the view parameter rows, which queries the DOM every frame
// second, the innerHTML of the first row is rebuilt every frame, destroying and recreating the span
// third, the innerHTML of the second row is rebuilt every frame as well
// fourth, a requestAnimationFrame callback removes the changed class every frame
// fifth, the compass needle is fetched from the DOM every frame
// 
// ,
// ,
//
// references
// .
let _tmpViewDir = null;          // ,
let _vpValEls = null;            // 缓存 .vp-row .val 两个元素
let _compassNeedleEl = null;
let _compassNeedleDeg = null;    // 上次写入的旋转角度
let _vpChangedTimer = null;      // 高亮摘除定时器

function _getViewParamEls() {
  if (_vpValEls && _vpValEls[0] && _vpValEls[0].isConnected) return _vpValEls;
  const vals = document.querySelectorAll('.view-params .vp-row .val');
  _vpValEls = vals.length >= 2 ? [vals[0], vals[1]] : null;
  return _vpValEls;
}

function updateViewInfo() {
  if (!_tmpViewDir) _tmpViewDir = new THREE.Vector3();
  const dir = _tmpViewDir;
  camera.getWorldDirection(dir);
  const h = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
  const plunge = Math.round(Math.atan2(-dir.y, h) * (180 / Math.PI));
  // ,
  // when the camera looks towards +X the azimuth is 0, towards +Z it is 90 degrees, towards -X it is 180 and towards -Z it is 270
  let azimuth = Math.atan2(dir.z, dir.x) * (180 / Math.PI);
  azimuth = Math.round((azimuth + 360) % 360);

  const els = _getViewParamEls();
  if (els) {
    const pChanged = lastPlunge !== plunge;
    const aChanged = lastAzimuth !== azimuth;
    // )
    if (pChanged) {
      els[0].textContent = (plunge >= 0 ? '+' : '') + plunge;
      els[0].classList.add('changed');
    }
    if (aChanged) {
      els[1].textContent = String(azimuth).padStart(3, '0');
      els[1].classList.add('changed');
    }
    if (pChanged || aChanged) {
      // ,
      if (!_vpChangedTimer) {
        _vpChangedTimer = setTimeout(() => {
          _vpChangedTimer = null;
          if (els[0]) els[0].classList.remove('changed');
          if (els[1]) els[1].classList.remove('changed');
        }, 220);
      }
      lastPlunge = plunge;
      lastAzimuth = azimuth;
    }
  }

  // the compass rotation only writes the style when the angle changes
  if (!_compassNeedleEl || !_compassNeedleEl.isConnected) {
    _compassNeedleEl = document.getElementById('compass-needle');
    _compassNeedleDeg = null;
  }
  if (_compassNeedleEl && _compassNeedleDeg !== azimuth) {
    _compassNeedleEl.style.transform = 'rotate(' + (-azimuth) + 'deg)';
    _compassNeedleDeg = azimuth;
  }

  updateScaleBar();
}

// references
let _scaleLabelEls = null;
let _scaleLabelCache = ['', '', ''];

function _getScaleLabelEls() {
  if (_scaleLabelEls && _scaleLabelEls[0] && _scaleLabelEls[0].isConnected) return _scaleLabelEls;
  const labels = document.querySelectorAll('.scale-labels .sl-val');
  _scaleLabelEls = labels.length >= 3 ? [labels[0], labels[1], labels[2]] : null;
  return _scaleLabelEls;
}

function updateScaleBar() {
  const dist = camera.position.distanceTo(controls.target);
  const vFOV = THREE.MathUtils.degToRad(camera.fov);
  const visibleHeight = 2 * Math.tan(vFOV / 2) * dist;
  const scaleBarPx = 120;
  // ,
  // ,
  // )
  if (!_cachedViewportH) syncViewportHeight();
  const viewportH = _cachedViewportH || 600;

  let totalMeters = (scaleBarPx / viewportH) * visibleHeight;
  if (!isFinite(totalMeters) || totalMeters <= 0) return;
  const pow10 = Math.pow(10, Math.floor(Math.log10(totalMeters)));
  const norm = totalMeters / pow10;
  let factor;
  if (norm < 1.2) factor = 1;
  else if (norm < 2.5) factor = 2;
  else if (norm < 6) factor = 5;
  else factor = 10;
  const niceTotal = factor * pow10;
  const step = niceTotal / 2;

  const format = (v) => {
    if (v >= 1000) return (v / 1000).toFixed(1) + 'km';
    if (v >= 1) return Math.round(v) + 'm';
    return v.toFixed(2) + 'm';
  };

  const els = _getScaleLabelEls();
  if (!els) return;
  const texts = ['0', format(step), format(niceTotal)];
  for (let i = 0; i < 3; i++) {
    if (_scaleLabelCache[i] !== texts[i]) {
      els[i].textContent = texts[i];
      _scaleLabelCache[i] = texts[i];
    }
  }
}

// ============================================================
// the animation loop
// ============================================================
// )
window.__modalOpenCount = 0;
(function initModalOpenWatcher() {
  const recount = () => {
    window.__modalOpenCount = document.querySelectorAll('.modal-overlay.show').length;
  };
  const mo = new MutationObserver(recount);
  mo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] });
  // calculate it once initially and once after the DOM is ready
  recount();
  document.addEventListener('DOMContentLoaded', recount);
  window.__modalRecount = recount;
})();

const terrainMotionQuality={position:new THREE.Vector3(),quaternion:new THREE.Quaternion(),zoom:NaN,lastMove:0};
function updateTerrainMotionQuality(now){
  const active=state.models.some(model=>model.inScene!==false&&model.visible!==false&&((model.isBlockModel&&model.mesh?.count>=50000)||((model.terrainTexture||model.geoImageTexture)&&model.material?.map)));
  const moving=terrainMotionQuality.position.distanceToSquared(camera.position)>1e-10||Math.abs(terrainMotionQuality.quaternion.dot(camera.quaternion))<1-1e-10||terrainMotionQuality.zoom!==camera.zoom;
  if(moving)terrainMotionQuality.lastMove=now;
  terrainMotionQuality.position.copy(camera.position);terrainMotionQuality.quaternion.copy(camera.quaternion);terrainMotionQuality.zoom=camera.zoom;
  const desired=desiredCanvasPixelRatio(active&&now-terrainMotionQuality.lastMove<250);
  if(renderer.getPixelRatio()!==desired)renderer.setPixelRatio(desired);
}
function animate() {
  requestAnimationFrame(animate);
  if(window.regionCompare?.active)return;
  // )
  const curViewer = tabViewers.get(activeTabId);
  if (document.hidden || (curViewer && !['3d','vector2d'].includes(curViewer.type))) return;
  // ,
  // )
  if (window.__modalOpenCount > 0) return;
  controls.update();
  updateTerrainMotionQuality(performance.now());
  updateAxisLabelLayout();
  updateActiveTabName();
  updateViewInfo();
  window.presentationMode?.apply(scene,state,renderer);
  renderer.render(scene, camera);
}
animate();

// store the initial viewer instance of the View tab
tabViewers.set('view', { type: '3d', state, scene, camera, target: controls.target.clone(), locked: false });
applyScenePreferences(scene,state);

// trigger the size calculation once at the start
setTimeout(onResize, 0);

// ============================================================
// .
(function(){
  let started=false;
  async function restoreWhenReady(){
    if(started||document.readyState!=='complete'||!window.__startupLayoutReady)return;
    started=true;
    if(window.electronAPI?.readSession){try{await maybeRestoreSession();}catch(error){console.warn('[Session restoration]',error);}}
  }
  window.addEventListener('load',restoreWhenReady,{once:true});
  window.addEventListener('app-layout-ready',restoreWhenReady,{once:true});
})();

