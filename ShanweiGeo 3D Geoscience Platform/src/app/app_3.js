
// ============================================================
// CameraController（左键旋转、中键/滚轮缩放、右键禁用）
// ============================================================
// 第 77 节：平移边界回退用常量（避免在 _pan 热路径里 new 对象）
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
    // 2D 平面模式（矢量平面标签：正交相机，仅平移/缩放）
    this.is2D = false;
    this._2dZoom = 1;
    this.minZoom = 0.001;
    this.maxZoom = 5000;

    // 平移边界（球形约束，运行时由 fitViewToAll / focusModel 设置）
    this._panLimitRadius = 300;
    // ★ 第 77 节：约束的【参考中心】。原实现用 target.length()（到世界原点距离），
    //   而模型归零后中心仍可能离世界原点上百米 → |target| 恒大于半径 → 每帧平移都被拉回 = 抖动。
    //   改为以内容包围球中心为参考，语义才是「相机目标不得远离内容中心」。
    this._panLimitCenter = new THREE.Vector3(0, 0, 0);

    this._spherical = new THREE.Spherical();
    this._sphericalDelta = new THREE.Spherical();
    this._panOffset = new THREE.Vector3();
    this._scale = 1;

    // 从相机位置初始化球坐标
    const offset = new THREE.Vector3().subVectors(camera.position, this.target);
    this._spherical.setFromVector3(offset);

    // 保存初始状态用于重置
    this._initialPos = camera.position.clone();
    this._initialTarget = this.target.clone();
    this._isResetting = false;

    this._isPanning = false;
    this._isRotating = false;
    this._panStart = { x: 0, y: 0 };
    this._rotStart = { x: 0, y: 0 };

    // 测距模式下禁用旋转
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

  // 切换相机和目标（多标签页共享同一个 controls 实例）
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
    // ★ 第 77 节：平移边界参考中心同步重置到本标签页的焦点，
    //   避免上一标签页的边界（以旧内容中心为球心）泄漏过来 → 新标签页每帧被拉回 = 抖动
    this._panLimitCenter.copy(this.target);
  }

  _bindEvents() {
    this.dom.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!this.enabled) return;
      if (e.button === 0) {
        if (this.is2D) {
          // 2D 平面模式：左键 = 平移
          this._isPanning = true;
          this._panStart = { x: e.clientX, y: e.clientY };
        } else {
          // 左键 = 旋转
          this._isRotating = true;
          this._rotStart = { x: e.clientX, y: e.clientY };
        }
      } else if (e.button === 1) {
        // 中键 = 平移
        this._isPanning = true;
        this._panStart = { x: e.clientX, y: e.clientY };
      }
      // 右键(button === 2) 不做任何操作
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

    // 禁用右键菜单
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());

    this.dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.is2D) {
        // 2D 平面模式：缩放 = 调整正交相机 zoom
        this._2dZoom *= (e.deltaY < 0 ? 1.1 : 0.9);
        this._2dZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this._2dZoom));
      } else {
        if (e.deltaY < 0) this._scale *= 0.92;
        else this._scale *= 1.08;
      }
    }, { passive: false });
  }

  _pan(deltaX, deltaY) {
    // 2D 平面模式（正交相机）：按视野高度计算平移量
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
    // 纯屏幕空间平移：相机与目标一起移动，保持视角方向不变
    // ★ 第 75 节：必须先刷新相机世界矩阵。
    //   camera.matrix 只有在 updateMatrixWorld() 之后才反映最新的 position/quaternion；
    //   而 mousemove 在两次 render 之间可能触发多次，若沿用「上一帧的矩阵」推算平移方向，
    //   方向会滞后一帧 → 拖动时画面抖动 / 漂移。2D 分支上方已有同样处理，此处补齐。
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
    // 平滑重置动画
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

    // ===== 平移：相机与目标一起移动，球形边界约束 =====
    if (this._panOffset.lengthSq() > 0.0001) {
      const pan = this._panOffset.clone();
      this.camera.position.add(pan);
      this.target.add(pan);

      // 球形约束：将目标限制在【以内容中心为球心】的半径范围内
      // ★ 第 77 节修正：原为 this.target.length()（以世界原点为球心）→ 模型远离原点时每帧被拉回 = 抖动
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

    // ===== 2D 平面模式：仅平移 + 缩放(zoom)，不做球形旋转 =====
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

    // ===== 旋转 & 缩放 =====
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
// 项目树折叠逻辑
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
    // 避免与右键菜单冲突
    header.classList.toggle('collapsed');
  });
});

// ============================================================
// Resize Handles 逻辑
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

  // 右侧二维联动面板是否可见（由右上角按钮控制）
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
      // 隐藏右侧面板：中间区域占据 center+right 的份额
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

  // ========== 右侧二维联动面板显隐切换 ==========
  const toggleRightBtn = document.getElementById('btn-toggle-right-panel');
  if (toggleRightBtn) {
    toggleRightBtn.addEventListener('click', () => {
      rightPanelVisible = !rightPanelVisible;
      toggleRightBtn.classList.toggle('active', rightPanelVisible);
      applyMainWidths();
      applyLayerHeight();
      // 通知三维画布重新计算尺寸
      window.dispatchEvent(new Event('resize'));
    });
  }

  // 暴露全局方法：钻孔联动时打开右侧面板
  window.setRightPanelVisible = function(v) {
    rightPanelVisible = !!v;
    if (toggleRightBtn) toggleRightBtn.classList.toggle('active', rightPanelVisible);
    applyMainWidths();
    applyLayerHeight();
    window.dispatchEvent(new Event('resize'));
  };
})();

// ============================================================
// 右侧面板 tab 切换
// 两套页签组互斥：drill = 钻孔场景（二维联动），doc = 文档场景（大纲/书签/笔记）
// 同一面板容器、宽度样式完全一致，仅页签栏与内容区整组替换；两组内容互不破坏
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

  // 激活组内某个页签（只动本组，另一组的 DOM 与选中状态原样保留）
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
      try { window.onRightPanelTabShown(g, name); } catch (e) { /* 钩子异常不影响面板切换 */ }
    }
  }

  rpTabsOf('drill').concat(rpTabsOf('doc')).forEach(function (tab) {
    tab.addEventListener('click', function () {
      const holder = tab.closest ? tab.closest('.rp-tab-group') : null;
      if (!holder) return;
      rpActivateTab(holder.dataset.group, tab.dataset.tab || tab.textContent.trim());
    });
  });

  // ===== 对外接口：按场景切换整组页签 =====
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
    // 隐藏另一组的面板（否则两组同时出现 display:block 会叠在一起）
    document.querySelectorAll('.rp-tab-panel').forEach(function (p) {
      if (p.dataset.group !== g) p.classList.remove('active');
    });
    const head = document.getElementById('rp-header-text');
    if (head) head.textContent = (g === 'doc') ? 'Documents' : 'Linked 2D View';
    rpActivateTab(g, rpActiveTab[g] || (g === 'doc' ? 'Outline' : 'Drillhole Log'));
    return rpGroup;
  };

  // 初始：两组 tab 各自记住默认项，面板只显示钻孔组（doc 组面板初始不带 active）
  rpTabsOf('doc').forEach(function (t) {
    t.classList.toggle('active', (t.dataset.tab || '') === rpActiveTab.doc);
  });
})();

// ============================================================
// 中央标签栏：新建 / 切换 / 关闭
// 「视图」标签固定不可删除；新建标签拥有独立 3D 场景
// ============================================================
(function() {
  const tabBar       = document.getElementById('center-tab-bar');
  const tabNewBtn    = document.getElementById('center-tab-new');
  const centerArea   = document.getElementById('center-area');

  if (!tabBar || !tabNewBtn || !centerArea) return;

  let tabCounter = 0;          // 新标签序号（仅用于唯一 tabId）

  // ---- 切换标签 ----
  // ★ 若正在点绘制：先询问是否保存，并退出绘制状态（用户要求）
  async function switchTab(tabId, options = {}) {
    if(!options.skipDeferred&&window.__deferredViewerBusy)await window.__deferredViewerBusy;
    if(!options.skipDeferred&&!window.projectRestoreInProgress&&tabViewers.get(tabId)?._deferredModels){await loadDeferredViewer(tabId);}
    if (tabId === activeTabId) { window.researchRegionViews?.onViewActivated(tabId);window.regionCompare?.onTabActivated(tabId); return; }
    if (pointAddMode) {
      const ok = await guardLeavePointDraw('Switching to another tab');
      if (!ok) return;
    }
    // 1) 更新标签按钮 active 状态
    tabBar.querySelectorAll('.center-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tabId === tabId);
    });
    // 2) 切换 viewer 实例（重赋 state/scene/camera + 重建 UI）
    switchActiveViewer(tabId);
    window.researchRegionViews?.onViewActivated(tabId);
    window.regionCompare?.onTabActivated(tabId);
    // 3) 通知画布重新计算尺寸
    window.dispatchEvent(new Event('resize'));
  }

  // ---- 新建标签 ----
  // type: '3d'（默认，含四组件+3D场景） | 'image'（图片标签，仅图片查看器） | 'table'（表格标签，仅表格查看器）
  // opts: { imageName, imageUrl }（图片标签） | { tableName, tableHtml, tableRows, tableCols }（表格标签）
  //       { label }（自定义标签页名称，优先级最高）
  // ★ async：末尾会自动 switchTab 到新标签，若正处在「点绘制」需先询问保存/离开。
  async function createNewTab(type, opts) {
    type = type || '3d';
    opts = opts || {};
    // ★ 点绘制守卫：新建标签必然伴随切换，先询问（取消则整支不建）
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
    // 标签名称优先级：opts.label > 图片/表格文件名 > 「标签 N+1」
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

    // 创建标签按钮（插在「+」按钮之前）
    const tabEl = document.createElement('div');
    tabEl.className = 'center-tab';
    tabEl.dataset.tabId = tabId;
    tabEl.dataset.tabType = type;   // 标签类型：3d / image / table / pdf
    tabEl.dataset.autoName = (!opts.label && type === '3d') ? 'true' : 'false';
    tabEl.dataset.emptyName = label;
    tabEl.dataset.kindLabel = ({'3d':'3D',vector2d:'Plane',image:'Imagery',table:'Tables',pdf:'PDF',word:'Documents'})[type] || '3D';
    tabEl.title = label;
    // 图标：图片标签用图片图标，表格标签用表格图标，PDF 标签用文档图标，3D 标签用显示器图标
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

    // 创建标签数据：3D 标签创建独立 viewer，图片/表格标签存储各自信息
    if (type === 'image') {
      // 图片标签：不创建 3D 场景，存储图片 URL 和独立的缩放/位移状态
      tabViewers.set(tabId, {
        type: 'image',
        imageUrl: opts.imageUrl,
        imageName: opts.imageName,
        locked: false,
        // 图片查看器状态（每个图片标签独立）
        imgScale: 1,
        imgTx: 0,
        imgTy: 0
      });
    } else if (type === 'table') {
      // 表格标签：不创建 3D 场景，存储表格 HTML 和元信息
      // lazyTable: 大表分块懒加载数据（{ firstHtml, chunks[], finished }，同引用共享），无则 null
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
      // PDF 阅读标签：不创建 3D 场景，存储 blob URL 和文件名
      tabViewers.set(tabId, {
        type: 'pdf',
        pdfUrl: opts.pdfUrl,
        pdfName: opts.pdfName,
        pdfSize: opts.pdfSize,
        locked: false
      });
    } else if (type === 'word') {
      // Word 只读阅读标签：不创建 3D 场景，存储 blob URL 和文件名
      tabViewers.set(tabId, {
        type: 'word',
        wordUrl: opts.wordUrl,
        wordName: opts.wordName,
        wordSize: opts.wordSize,
        locked: false
      });
    } else {
      // 3D 标签：创建独立 viewer 实例（type='vector2d' → 矢量平面标签：正交相机俯视）
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

    // 绑定标签点击 → 切换（排除关闭按钮、锁定按钮、可编辑标签）
    tabEl.addEventListener('click', (e) => {
      if (e.target.closest('.center-tab-close')) return;
      if (e.target.closest('.center-tab-lock-btn')) return;
      if (e.target.closest('.center-tab-label[contenteditable="true"]')) return;
      switchTab(tabId);
    });

    // 绑定关闭按钮
    tabEl.querySelector('.center-tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tabId);
    });

    // 绑定锁定按钮 → 切换锁定状态
    tabEl.querySelector('.center-tab-lock-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTabLock(tabId);
    });

    // 双击标签文字 → 重命名（contenteditable 内联编辑）
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
    // 自动切换到新标签
    if(!window.__lazyProjectRestore)await switchTab(tabId);
    return tabId;
  }

  // ---- 关闭标签 ----
  function closeTab(tabId) {
    const tabEl = tabBar.querySelector('.center-tab[data-tab-id="' + tabId + '"]');
    if (!tabEl) return;

    // 检查锁定状态：锁定时弹出提示对话框，阻止删除
    const viewer0 = tabViewers.get(tabId);
    if (viewer0 && viewer0.locked) {
      showTabLockAlert(tabEl);
      return;
    }

    // ★ 若关闭的正是当前激活标签，会触发 switchTab('view') → 需先过点绘制守卫
    if (activeTabId === tabId && pointAddMode) {
      guardLeavePointDraw('Closing the current tab').then((ok) => { if (ok) _doCloseTabNow(tabId); });
      return;
    }

    _doCloseTabNow(tabId);
  }

  // 真正执行关闭（守卫通过后调用）
  function _doCloseTabNow(tabId) {
    const tabEl = tabBar.querySelector('.center-tab[data-tab-id="' + tabId + '"]');
    if (!tabEl) return;
    const viewer = tabViewers.get(tabId);

    tabEl.remove();

    // 清理 viewer 资源（3D 标签需释放几何体/材质；图片标签无 scene 资源）
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

    // 如果关闭的是当前激活标签，切换回「视图」
    if (activeTabId === tabId) {
      switchTab('view');
    }
  }

  // ---- 锁定/解锁标签（点击锁图标切换） ----
  function toggleTabLock(tabId) {
    const tabEl = tabBar.querySelector('.center-tab[data-tab-id="' + tabId + '"]');
    const viewer = tabViewers.get(tabId);
    if (!tabEl || !viewer) return;
    viewer.locked = !viewer.locked;
    tabEl.classList.toggle('locked', viewer.locked);
    const lockBtn = tabEl.querySelector('.center-tab-lock-btn');
    if (lockBtn) lockBtn.title = viewer.locked ? 'Click to unlock' : 'Click to lock';
  }

  // ---- 锁定标签删除提示 Modal ----
  const tabModalOverlay = document.getElementById('tab-modal-overlay');
  const tabModalTitle = document.getElementById('tab-modal-title');
  const tabModalLabel = document.getElementById('tab-modal-label');
  const tabModalConfirm = document.getElementById('tab-modal-confirm');
  const tabModalCancel = document.getElementById('tab-modal-cancel');

  // tab-modal 确认回调（支持自定义回调，如坐标系不一致时新建标签页）
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

  // 通用 tab-modal 显示函数（支持自定义标题、内容、按钮文字、回调）
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

  // ---- 事件绑定 ----
  tabNewBtn.addEventListener('click', () => createNewTab('3d'));

  // 「视图」标签点击切换
  const viewTab = tabBar.querySelector('.center-tab[data-tab-id="view"]');
  if (viewTab) {
    viewTab.addEventListener('click', () => switchTab('view'));
  }

  // 将 createNewTab / switchTab / closeTab 暴露到全局，供图件/表格/PDF 双击打开标签、删除 PDF 时关闭标签使用
  window.createNewTab = createNewTab;
  window.switchTab = switchTab;
  window.closeTab = closeTab;
})();

// ============================================================
// GOCAD .ts 解析器（内联，去除 TS 类型注解）
// 修复：1) 全局原点偏移避免Float32精度丢失 2) Z-up→Y-up 轴转换
// ============================================================

// 全局基准原点（UTM坐标偏移量，从第一个模型的bbox向下取整确定）
function parseGOCADTS(text, options) {
  options = options || {};
  const mergeTFaces = options.mergeTFaces !== false;

  // 去除 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // ---------- 元数据 ----------
  let name = 'unnamed';
  let coordinateSystem;
  const propertyNames = [];
  const propertyClasses = [];
  const units = [];

  // ---------- 几何缓冲 ----------
  const vertexIdMap = new Map();
  const vCoords = [];
  const vPropsRaw = [];
  let triangleIdx = [];

  let currentPropNames = propertyNames;

  const lines = text.split(/\r?\n/);
  let inHeader = false;
  let inCoordSystem = false;
  let coordSystemLines = [];

  // 扫描本文件的 GOCAD 原始坐标范围（用于计算 fileOrigin 建议值）
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
  // 向下取整到百米级（保留细节，同时让坐标值变小）
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

    // HEADER 块
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

    // 坐标系块
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

    // 属性元信息
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

    // TFACE 段开始
    if (line === 'TFACE' || line.startsWith('TFACE')) {
      continue;
    }

    // 顶点
    if (line.startsWith('PVRTX') || line.startsWith('VRTX')) {
      const tag = line.startsWith('PVRTX') ? 'PVRTX' : 'VRTX';
      const parts = line.split(/\s+/);
      const id = parseInt(parts[1], 10);
      const x = parseFloat(parts[2]);
      const y = parseFloat(parts[3]);
      const z = parseFloat(parts[4]);
      // 健壮性：坐标缺失/非法时跳过该顶点（引用它的三角形会被下方 TRGL 的 undefined 保护跳过）
      if (isNaN(x) || isNaN(y) || isNaN(z)) {
        console.warn('[GOCAD] Skip invalid vertex row: ' + line.slice(0, 80));
        continue;
      }
      if (vertexIdMap.has(id)) continue;
      const localIdx = vCoords.length / 3;
      vertexIdMap.set(id, localIdx);

      // ★ 存储 GOCAD 原始坐标（仅做轴交换，不做 origin 偏移）
      //   偏移在 loadModelToScene 时按当前标签页的 state.origin 应用
      //   GOCAD: X=东, Y=北, Z=高程(上)
      //   Three.js: X=东, Y=上, Z=南(深度)
      //   映射: rawX=x, rawY=z, rawZ=-(y)  保持右手系
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

    // ATOM 顶点引用
    if (line.startsWith('ATOM')) {
      const parts = line.split(/\s+/);
      const id = parseInt(parts[1], 10);
      const refId = parseInt(parts[2], 10);
      const refLocal = vertexIdMap.get(refId);
      if (refLocal === undefined) continue;
      vertexIdMap.set(id, refLocal);
      continue;
    }

    // 三角面
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

  // ---------- 包围盒（基于轴交换后的原始坐标，未减 origin）----------
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
    vertices: new Float32Array(vCoords),  // 原始轴交换坐标（未减 origin），加载时按标签 origin 偏移
    indices: new Uint32Array(triangleIdx),
    vertexCount: vertexCount,
    triangleCount: triangleIdx.length / 3,
    coordinateSystem: coordinateSystem,
    boundingBox: boundingBox,
    fileOrigin: fileOrigin,              // 本文件建议的原点（向下取整到百米级）
    origin: null                         // 实际使用的 origin（loadModelToScene 时按标签设置）
  };
}

// ============================================================
// OBJ 解析器（Leapfrog Geo / Surpac / Datamine / Micromine 导出）
// 输入：OBJ 文本（真实矿区投影坐标 X=东 Y=北 Z=高程）
// 输出：与 parseGOCADTS 同构的 geoMesh —— vertices 按 GOCAD 轴约定
//       预转（东, 高程, -北），渲染时由 loadModelToScene 统一做 origin 偏移，
//       从而与 .ts/.str 模型在同一坐标系统内正确对齐。
// ============================================================
function parseOBJText(text, fallbackName) {
  // 去除 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const vTmp = [];      // OBJ 原始顶点坐标（东,北,高 或任意右手系）
  const faceVerts = []; // 归一化后的 0-based 顶点索引（仅取位置索引）
  let objectName = null; // o/g 对象名（多个对象时取第一个；Leapfrog 每文件通常单对象）

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v' && parts.length >= 4) {
      vTmp.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
    } else if (tag === 'vn' || tag === 'vt' || tag === 'vp') {
      // 法线/纹理/参数顶点表：本解析器不消费，仅占索引语义，无需处理
    } else if (tag === 'o' || tag === 'g') {
      if (!objectName && parts[1]) objectName = parts[1];
    } else if (tag === 'f' && parts.length >= 4) {
      // f v1/vt1/vn1 v2/vt2/vn2 ... 多边形扇形三角化
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
    // mtllib / usemtl / s / l / p / mg / maplib 等行忽略
  }

  const vertexCount = vTmp.length / 3;
  if (vertexCount === 0) throw new Error('OBJ not found in v Vertex row');
  if (faceVerts.length === 0) throw new Error('OBJ not found in f Triangle row');

  // 顶点合法性检查（防止越界面索引把 WebGL 渲染搞崩）
  const maxIdx = faceVerts.reduce((a, b) => (b > a ? b : a), 0);
  if (maxIdx >= vertexCount) {
    throw new Error('OBJ Triangle index out of bounds (Maximum vertex index ' + (maxIdx + 1) + ' > Vertices ' + vertexCount + ' ) , The file may be corrupt');
  }

  // ---- 轴约定转换：OBJ(X=东,Y=北,Z=高) → GOCAD 原始坐标(X=东, Y=高程, Z=-北) ----
  const vRaw = new Float32Array(vTmp.length);
  for (let i = 0; i < vTmp.length; i += 3) {
    vRaw[i]     = vTmp[i];     // 东
    vRaw[i + 1] = vTmp[i + 2]; // 高程
    vRaw[i + 2] = -vTmp[i + 1];// 北取反
  }

  // ---- 包围盒（基于轴交换后的原始坐标，未减 origin，与 parseGOCADTS 一致）----
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vRaw.length; i += 3) {
    const x = vRaw[i], y = vRaw[i + 1], z = vRaw[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const boundingBox = [minX, minY, minZ, maxX, maxY, maxZ];

  // ---- 文件原点建议（与 parseGOCADTS 一致：取最小坐标向下取整到百米级）----
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
// 全局状态
// ============================================================
let state = {
  models: [],            // { id, name, category, mesh, material, visible, opacity, color, fileName, geoMesh, treeFileNode }
  rulerPoints: [],       // 测距点小球
  rulerLines: [],        // 测距线 + 数值 sprite
  rulerItems: [],        // 测距条目 {id, line, sprite, startSphere, endSphere, distance}
  measureMode: false,
  clipMode: false,
  // 剖切配置：三轴独立，各自有 enabled/direction/position
  clipConfig: {
    h: { enabled: false, dir: 'above', value: 0 },   // 水平剖切（Three.Y / GOCAD Z 高程）
    x: { enabled: false, dir: 'pos',  value: 0 },     // 垂直剖切 X（Three.X / GOCAD X 东）
    y: { enabled: false, dir: 'pos',  value: 0 },     // 垂直剖切 Y（Three.Z / GOCAD Y 北）
  },
  clipHelpers: [], // 剖切可视化平面 mesh 列表
  legendVisible: true,
  compassVisible: true, // 坐标开关：指北针+倾角方位角
  layersVisible: true,
  axisLabelsVisible: appPreferences.axesVisible, // 本机显示偏好
  selectedModelId: null,
  placeholderMesh: null,
  selectionOutline: null,  // 当前选中模型的描边线框
  lithologyColors: {},     // 岩性名称 → hex 颜色（如 'Q': '#a3e635'），跨模型持久化，可自由修改
  // 地球化学色阶设置：经典 diverging 色阶（按属性名持久化）
  geochemColormap: {},     // attrClean → { lowColor:'#313695', highColor:'#A50026', scheme:'rdbu' }
  // ★ 当前标签页的坐标原点（GOCAD 真实坐标，由首个导入模型设置，本标签内所有模型共用）
  //   不同标签页可有不同 origin，从而支持不同坐标系统的模型分标签显示
  origin: null             // { x, y, z } GOCAD 坐标，null 表示尚未初始化
};

// 分类颜色映射
const CATEGORY_COLORS = {
  'Orebody': 0x8338ec,
  'Formation': 0x5C4033,
  'Structure': 0xcf222e,
  'Alteration': 0xf0883e,
  'Geochemistry': 0xa371f7,  // 图例用默认色，实际颜色由 computeGeochemColor 按文件名数值计算
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
// 文件名 → 颜色映射（需求文档「八、模型颜色映射」约定）
// 导入时优先按文件名匹配约定色，保证同一文件在不同会话/标签页颜色一致；
// 未匹配的文件回退到分类默认色（CATEGORY_COLORS）。
// 注意：规则按"具体优先"排序，如 Ptfz2 必须排在 Ptfz 之前。
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
// 按文件名返回约定颜色；未匹配返回 null（由分类默认色兜底）
function matchFileColor(fileName) {
  if (!fileName) return null;
  for (let i = 0; i < FILE_COLOR_RULES.length; i++) {
    if (FILE_COLOR_RULES[i].re.test(fileName)) return FILE_COLOR_RULES[i].color;
  }
  return null;
}

// ============================================================
// 导入模型时保证每个模型颜色互不相同（不论是否同一分类）
//   - 优先采用 FILE_COLOR_RULES 约定色 / 分类默认色（若该色未被占用）
//   - 被占用或都没有时，从高区分度调色板取一个尚未使用的颜色
//   - 调色板用尽则按黄金角生成新色，始终确保不重复
// ============================================================
const MODEL_PALETTE = [
  0xE63946, 0x2A9D8F, 0xE9C46A, 0x457B9D, 0x8E44AD,
  0xF4A261, 0x1ABC9C, 0xC0392B, 0x2980B9, 0x27AE60,
  0x9B59B6, 0xE67E22, 0x16A085, 0x2C3E50, 0xE91E63,
  0x009688, 0xFF5722, 0x3F51B5, 0x795548, 0x607D8B,
  0x00BCD4, 0x4CAF50, 0xFF9800, 0x9C27B0, 0xFF4081
];

// HSL -> 0xRRGGBB 整数（s/l 取 0~1 小数；与下方字符串版 hslToHex 区分，避免同名覆盖）
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

// 选一个与当前场景内所有模型都不重复的颜色
//   preferred: 优先色（约定色/分类色），仅当它尚未被占用时才采用
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
  // 调色板用尽：黄金角生成新色（仍不与已有重复）
  const h = (used.size * 137.508) % 360;
  return hslToHexInt(h, 0.65, 0.5);
}

// 从文件名提取第一个数字（如 "GM - 1-1.ts"→1, "Au_500.ts"→500, "元素3.ts"→3）
function extractFirstNumber(fileName) {
  const match = fileName.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

// ============================================================
// 地球化学钻孔：经典 diverging 色阶（蓝→青→绿→黄→红）
// ColorBrewer RdBu reversed（11 段），用于按数值大小映射颜色
// ============================================================
const GEOCHEM_DIVERGING_STOPS = [
  '#313695', '#4575B4', '#74ADD1', '#ABD0E6', '#E0F3F8',
  '#FFFFBF', '#FEE090', '#FDAE61', '#F46D43', '#D73027', '#A50026'
];
// 将 #RRGGBB → {r,g,b}
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
// 数值归一化 t∈[0,1] → 色阶颜色（返回 {r,g,b}）
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
// 便捷：t → 整数颜色
function geochemColorInt(t, stops) {
  const c = divergingColorAt(t, stops);
  return rgbToInt(c.r, c.g, c.b);
}
// 获取属性的自定义色阶（若未设置则用默认 diverging）
function getAttrColormapStops(attrClean) {
  const cfg = state.geochemColormap && state.geochemColormap[attrClean];
  if (!cfg) return GEOCHEM_DIVERGING_STOPS.slice();
  if (cfg.scheme === 'custom' && cfg.lowColor && cfg.highColor) {
    return [cfg.lowColor, cfg.highColor];
  }
  return GEOCHEM_DIVERGING_STOPS.slice();
}
// 保存属性的色阶配置
function setAttrColormap(attrClean, cfg) {
  if (!state.geochemColormap) state.geochemColormap = {};
  state.geochemColormap[attrClean] = Object.assign({}, state.geochemColormap[attrClean] || {}, cfg);
}

// 旧的地球化学模型色阶函数（保留兼容旧 TS 模型导入逻辑）
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
// Three.js 场景初始化
// ============================================================
const canvas = document.getElementById('three-canvas');
const container = document.getElementById('canvas-wrap');

// ============================================================
// 视口高度缓存（第 75 节：消除渲染循环里的强制 reflow）
// ============================================================
// updateScaleBar() 每帧都要用视口高度来换算比例尺，而 container.clientHeight 是
// 【强制同步布局】操作 —— 在 animate() 里每帧读一次，会与 WebGL 渲染争抢主线程，
// 直接表现为「拖动 / 旋转视图时画面抖动」。
// 改为：由 ResizeObserver 在容器尺寸真正变化时刷新缓存，渲染循环只读缓存值。
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

// 光照
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(120, 250, 80);
scene.add(dirLight);
scene.add(new THREE.HemisphereLight(0xddeeff, 0x444444, 0.4));

// 相机控制器
const controls = new CameraController(camera, canvas);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// ============================================================
// 空场景占位（第 72 节：占位立方体已按要求删除）
// ============================================================
// 原实现在空场景中央放一个 60×60×60 的半透明灰盒 + 灰色线框（BoxGeometry +
// EdgesGeometry + LineSegments），并挂到 state.placeholderMesh。
//
// 用户要求删除「视图正中央那个不能旋转移动的灰色立方体」→ 此处不再创建任何几何体。
//
// 为什么保留函数壳与 state.placeholderMesh 字段（而不是整体删掉调用）：
//   全文件有 12+ 处 `if (state.placeholderMesh) { scene.remove(...); dispose(); }` 的
//   清理逻辑（导入模型、清空项目、切换标签页等路径都要走）。保留字段并恒为 null，
//   这些判空分支会自动跳过，既少改 12 处调用点、也避免漏改某处导致引用未定义。
//
// 如需恢复占位立方体：把下面注释掉的构造代码放回来即可（备份见
// 桌面程序/backups/index8_20260923_145000_before_del_placeholder.html）。
function createPlaceholder() {
  state.placeholderMesh = null;
}
createPlaceholder();

// ============================================================
// 多标签页 Viewer 实例管理（共享 DOM + 独立 scene/state/camera）
// ============================================================
const tabViewers = new Map();   // tabId → { state, scene, camera, target }
let activeTabId = 'view';
const geoMeshCache = new Map(); // fileName → { geoMesh, category, options } 跨标签共享模型数据

// 创建新的独立 viewer 实例
// 项目数据通过同一容器共享；属性访问器也同步整个字典/数组的重新赋值。
// 相机、模型、原点和剖切仍归每个 viewer 独立所有。
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
    // ★ 每个标签页独立维护坐标原点（不同标签页可显示不同坐标系统的模型）
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

  // 占位立方体（第 72 节：已按用户要求删除，新标签页同样不再放置占位几何体）
  //   注意此处与新标签页实例创建走的是不同代码路径，与 createPlaceholder() 是两套，
  //   删占位时必须【两处都改】，否则新建标签页仍会看到中央灰色立方体。
  newState.placeholderMesh = null;

  return { state: newState, scene: newScene, camera: newCamera, target: new THREE.Vector3(0, 0, 0), locked: false };
}

// 重建图层管理 UI（切换标签时调用）
function rebuildLayerManagement(forceCompareBuild = false) {
  if(!forceCompareBuild){
    const target=window.regionCompare?.active?window.regionCompare.layerTarget?.(activeTabId):null;
    lmList=target?.list||document.getElementById('lm-list');
    lmEmpty=target?.empty||normalLayerEmpty;
    if(lmEmpty.parentElement!==lmList)lmList.prepend(lmEmpty);
    if(target?.ready)return; // 保留现有条目，侧栏交互切换时不销毁鼠标正在操作的节点。
  }
  lmList.querySelectorAll('.lm-item, .lm-measure-item, .lm-clip-item').forEach(el => el.remove());
  // ★ 第 74 节：传 allowAutoTop=false —— 这是【重建】而非【新导入】，
  //   顺序应严格按 state.models 数组还原（保持用户已拖拽过的顺序），不得把图片强行置顶。
  state.models.filter(m => m.inScene).forEach(m => addLayerItem(m, false));
  state.rulerItems.forEach(r => addMeasureLayerItem(r));
  const hasItems = state.models.some(m => m.inScene) || state.rulerItems.length > 0;
  lmEmpty.style.display = hasItems ? 'none' : '';
}

// 复用原图层管理的构建与事件；仅构建期间切换数据和目标容器。
function renderLayerManagementFor(viewer,list,empty){
  const previous={state,lmList,lmEmpty};
  try{state=viewer.state;lmList=list;lmEmpty=empty;rebuildLayerManagement(true);}
  finally{state=previous.state;lmList=previous.lmList;lmEmpty=previous.lmEmpty;}
}

// 切换活动 viewer（重赋全局变量 + 重建 UI）
function switchActiveViewer(tabId) {
  // 保存当前 viewer 的相机状态（仅 3D 标签）
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

  // ===== 图片标签分支 =====
  if (viewer.type === 'image') {
    // 右侧面板回到钻孔组（二维联动）
    if (window.setRightPanelGroup) window.setRightPanelGroup('drill');
    // 隐藏四组件 + 表格/PDF 查看器，显示图片查看器
    centerArea.classList.add('no-view');
    if (imageViewWrap) imageViewWrap.classList.add('show');
    if (tableViewWrap) tableViewWrap.classList.remove('show');
    if (pdfViewWrap) pdfViewWrap.classList.remove('show');
    if (wordViewWrap) wordViewWrap.classList.remove('show');

    // 加载图片到共享 img 元素
    const imgEl = document.getElementById('image-viewer-img');
    if (imgEl && viewer.imageUrl) {
      imgEl.src = viewer.imageUrl;
    }
    // 恢复该图片标签的缩放/位移状态
    applyImageTransform(viewer.imgScale, viewer.imgTx, viewer.imgTy);

    // 恢复/隐藏控制点配准 UI
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

  // ===== 表格标签分支 =====
  if (viewer.type === 'table') {
    // 右侧面板回到钻孔组（二维联动）
    if (window.setRightPanelGroup) window.setRightPanelGroup('drill');
    // 隐藏四组件 + 图片/PDF 查看器，显示表格查看器
    centerArea.classList.add('no-view');
    if (tableViewWrap) tableViewWrap.classList.add('show');
    if (imageViewWrap) imageViewWrap.classList.remove('show');
    if (pdfViewWrap) pdfViewWrap.classList.remove('show');
    if (wordViewWrap) wordViewWrap.classList.remove('show');

    hideRegisterOverlay();

    // 加载表格 HTML 到共享容器
    const tvTitle = document.getElementById('tv-title');
    const tvInfo = document.getElementById('tv-info');
    const tvContent = document.getElementById('table-viewer-content');
    if (tvTitle) tvTitle.textContent = viewer.tableName || 'Table preview';
    if (tvInfo) tvInfo.textContent = (viewer.tableRows || 0) + ' Rows × ' + (viewer.tableCols || 0) + ' Columns';
    if (tvContent) {
      tvContent.innerHTML = viewer.tableHtml || '';
      syncTableIgnoreCheckboxes(tvContent);
      // 公式开关：仅含公式的表格显示按钮；恢复跨标签记忆的公式视图状态
      const tvF = document.getElementById('tv-formula-btn');
      if (tvF) {
        const hasF = !!viewer.tableHasFormula;
        tvF.style.display = hasF ? '' : 'none';
        tvF.classList.toggle('on', hasF && tvShowFormula);
        tvF.textContent = tvShowFormula ? 'Show values' : 'Show formulas';
      }
      if (tvShowFormula) applyFormulaView(true);
      // 大表懒加载：记录当前表格 viewer，恢复已滚动加载过的分块并显示进度条
      activeLazyTableViewer = viewer;
      renderTableLazyPart(viewer, tvContent);
    }
    return;
  }

  // ===== PDF 阅读标签分支 =====
  if (viewer.type === 'pdf') {
    // 右侧面板切到文档组（大纲 / 书签 / 笔记）
    if (window.setRightPanelGroup) window.setRightPanelGroup('doc');
    // 绑定文档上下文（必须在加载之前，大纲/书签/笔记都依赖它定位当前文档）
    if (typeof bindDocContext === 'function') bindDocContext('pdf', viewer.pdfUrl, viewer.pdfName);
    // 隐藏四组件 + 图片/表格查看器，显示 PDF 查看器
    centerArea.classList.add('no-view');
    if (imageViewWrap) imageViewWrap.classList.remove('show');
    if (tableViewWrap) tableViewWrap.classList.remove('show');
    if (pdfViewWrap) pdfViewWrap.classList.add('show');
    if (wordViewWrap) wordViewWrap.classList.remove('show');

    hideRegisterOverlay();

    // 标题与文件大小
    const pvTitle = document.getElementById('pv-title');
    const pvInfo = document.getElementById('pv-info');
    if (pvTitle) pvTitle.textContent = viewer.pdfName || 'PDF Read';
    if (pvInfo) {
      const sz = viewer.pdfSize;
      pvInfo.textContent = sz ? (sz / 1024).toFixed(1) + ' KB' : '';
    }
    // 惰性加载：同一文件不重复解析（pdf.js 渲染到 canvas）
    if (currentPdfUrl !== viewer.pdfUrl) {
      loadPdfIntoViewer(viewer.pdfUrl);
    }
    return;
  }

  // ===== Word 只读阅读标签分支 =====
  if (viewer.type === 'word') {
    // 右侧面板切到文档组（大纲 / 书签 / 笔记）
    if (window.setRightPanelGroup) window.setRightPanelGroup('doc');
    // 绑定文档上下文（必须在排版之前）
    if (typeof bindDocContext === 'function') bindDocContext('word', viewer.wordUrl, viewer.wordName);
    // 隐藏四组件 + 图片/表格/PDF 查看器，显示 Word 查看器
    centerArea.classList.add('no-view');
    if (imageViewWrap) imageViewWrap.classList.remove('show');
    if (tableViewWrap) tableViewWrap.classList.remove('show');
    if (pdfViewWrap) pdfViewWrap.classList.remove('show');
    if (wordViewWrap) wordViewWrap.classList.add('show');

    hideRegisterOverlay();

    // 标题与文件大小
    const wvTitle = document.getElementById('wv-title');
    const wvInfo = document.getElementById('wv-info');
    if (wvTitle) wvTitle.textContent = viewer.wordName || 'Word Read';
    if (wvInfo) {
      const sz = viewer.wordSize;
      wvInfo.textContent = sz ? (sz / 1024).toFixed(1) + ' KB' : '';
    }
    // 惰性渲染：同一文件不重复排版（docx-preview 渲染到 word-viewer-content）
    if (currentWordUrl !== viewer.wordUrl) {
      loadWordIntoViewer(viewer.wordUrl);
    } else if (window.scheduleWordReconcile) {
      // 已渲染过的同文件：切回时按当前视口校准标注画布（隐藏期间可能被懒回收）
      scheduleWordReconcile();
    }
    return;
  }

  // ===== 3D 标签分支（原有逻辑） =====
  // 隐藏图片/表格查看器，恢复四组件显示
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

  // 重赋全局变量
  ensureProjectLevelStateFields(viewer.state, state);
  state = viewer.state;
  scene = viewer.scene;
  camera = viewer.camera;

  // 切换 controls 的相机和目标；矢量平面标签 → 2D 模式（仅平移缩放）
  controls.is2D = !!(viewer.isVector2D);
  controls.swapCamera(camera, viewer.target);

  // 重建图层管理
  rebuildLayerManagement();

  // 重置属性面板和选中状态
  if (state.selectedModelId) {
    state.selectedModelId = null;
    state.selectionOutline = null;
  }
  document.querySelectorAll('.lm-item').forEach(i => i.classList.remove('selected'));
  showEmptyProperties();

  // 刷新坐标轴标签
  buildAxisLabels();

  // 刷新图例
  updateLegend();

  // 显示/隐藏空状态占位（第 72 节：占位浮层已删除，此处逻辑一并移除）

  // 重置剖切/测距按钮状态
  const clipPanel = document.getElementById('clip-panel');
  if (clipPanel) clipPanel.classList.remove('visible');
  const btnClipEl = document.getElementById('btn-clip');
  if (btnClipEl) btnClipEl.classList.toggle('active', state.clipMode);
  const btnMeasureEl = document.getElementById('btn-measure');
  if (btnMeasureEl) btnMeasureEl.classList.toggle('active', state.measureMode);
  canvas.classList.toggle('measuring', state.measureMode);

  // 同步「坐标 / 刻度 / 图例」按钮 active 类与对应控件显隐（与 viewer.state 一致）
  if (typeof syncToolbarToggleButtons === 'function') syncToolbarToggleButtons();

  // 触发 resize
  onResize();
}

// ============================================================
// 图片查看器交互（缩放/拖拽/双击还原/工具栏按钮）
// 共享 DOM，状态存储在各图片标签的 tabViewers 条目中
// ============================================================
const ivStage = document.getElementById('image-viewer-stage');
const ivImg = document.getElementById('image-viewer-img');
const ivZoomLabel = document.getElementById('iv-zoom-label');

// 图片加载失败处理（超大图片超过浏览器限制时触发）
ivImg.addEventListener('error', () => {
  const activeTab = document.querySelector('.center-tab.active');
  const tabLabel = activeTab ? (activeTab.querySelector('.center-tab-label') || {}).textContent : '';
  window.showTabModal({
    title: 'Unable to display image',
    label: 'Image“ ' + (tabLabel || '') + ' ”Unable to decode. The format may not be supported, The file is corrupt or exceeds the size limit; TIFF Open this image in the desktop application. '
  });
});

// 应用缩放和位移变换到 img 元素
function applyImageTransform(scale, tx, ty) {
  if (!ivImg) return;
  ivImg.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')';
  if (ivZoomLabel) ivZoomLabel.textContent = Math.round(scale * 100) + '%';

  // 配准标记点跟随图片对应点同步移动
  updateRegisterMarkers();
}

// 获取当前图片标签的状态对象
function getActiveImageState() {
  const v = tabViewers.get(activeTabId);
  return (v && v.type === 'image') ? v : null;
}

// 更新当前图片标签的状态并应用变换
function setImageTransform(scale, tx, ty) {
  const st = getActiveImageState();
  if (!st) return;
  st.imgScale = scale;
  st.imgTx = tx;
  st.imgTy = ty;
  applyImageTransform(scale, tx, ty);
}

// 以鼠标位置为中心缩放
function zoomAtCenter(newScale) {
  const st = getActiveImageState();
  if (!st) return;
  const s = Math.max(0.1, Math.min(10, newScale));
  setImageTransform(s, st.imgTx, st.imgTy);
}

// 工具栏按钮：放大
document.getElementById('iv-zoom-in').addEventListener('click', () => {
  const st = getActiveImageState();
  if (st) zoomAtCenter(st.imgScale * 1.25);
});
// 工具栏按钮：缩小
document.getElementById('iv-zoom-out').addEventListener('click', () => {
  const st = getActiveImageState();
  if (st) zoomAtCenter(st.imgScale / 1.25);
});
// 工具栏按钮：适应窗口（重置）
document.getElementById('iv-fit').addEventListener('click', () => {
  setImageTransform(1, 0, 0);
});
// 工具栏按钮：实际大小 (100%)
document.getElementById('iv-actual').addEventListener('click', () => {
  setImageTransform(1, 0, 0);
});
// 工具栏按钮：重置
document.getElementById('iv-reset').addEventListener('click', () => {
  setImageTransform(1, 0, 0);
});

// 滚轮缩放（以鼠标位置为中心）
ivStage.addEventListener('wheel', (e) => {
  const st = getActiveImageState();
  if (!st) return;
  e.preventDefault();
  const rect = ivStage.getBoundingClientRect();
  // 鼠标相对舞台中心的坐标
  const mx = e.clientX - rect.left - rect.width / 2;
  const my = e.clientY - rect.top - rect.height / 2;
  const delta = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newScale = Math.max(0.1, Math.min(10, st.imgScale * delta));
  // 以鼠标为中心缩放：调整 translate 使鼠标点保持不动
  // 公式：newTx = mx - (mx - tx) * (newScale / oldScale)
  const ratio = newScale / st.imgScale;
  const newTx = mx - (mx - st.imgTx) * ratio;
  const newTy = my - (my - st.imgTy) * ratio;
  setImageTransform(newScale, newTx, newTy);
}, { passive: false });

// 双击舞台 → 重置（回到适应窗口）
ivStage.addEventListener('dblclick', (e) => {
  e.preventDefault();
  setImageTransform(1, 0, 0);
});

// 拖拽移动图片
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
  // 保存最终位移到状态
  const st = getActiveImageState();
  if (st) {
    const t = ivImg.style.transform;
    // 从 transform 解析 translate 值
    const m = t.match(/translate\(([^,]+)px,\s*([^)]+)px\)/);
    if (m) {
      st.imgTx = parseFloat(m[1]);
      st.imgTy = parseFloat(m[2]);
    }
  }
});

// ============================================================
// 三维视图 ↔ 图层管理 联动辅助函数
// ============================================================

// 清除当前选中模型的高亮描边
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

// 右侧属性面板 + 底部属性窗口：显示空状态（无选中模型时）
function showEmptyProperties() {
  // 同步两组属性面板：右侧 rp-* 和底部 bp-*
  const pairs = [['bp-empty', 'bp-model-props']];
  pairs.forEach(([emptyId, propsId]) => {
    const e = document.getElementById(emptyId);
    const p = document.getElementById(propsId);
    if (e) e.style.display = 'block';
    if (p) p.style.display = 'none';
  });
}

// 清空图层选中状态（三维描边 + 左侧选中项 + 右侧属性面板）
// 不影响测距/剖切模式
function clearSelectionState() {
  if (!state.selectedModelId && !state.selectionOutline) return;
  clearSelectionOutline();
  state.selectedModelId = null;
  document.querySelectorAll('.lm-item').forEach(i => i.classList.remove('selected'));
  showEmptyProperties();
}

// 为指定模型显示黄色高亮描边（EdgesGeometry + LineSegments，add为mesh子节点）
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

// 相机聚焦到单个模型
function focusModel(model) {
  if (!model || !model.mesh) return;
  const box = new THREE.Box3();
  // InstancedMesh（块体模型）需用构建时记录的真实盒子，r132 的 setFromObject 不统计实例矩阵
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

// 刷新当前选中模型的属性面板（透明度/可见性变更后同步）
function refreshCurrentProperties() {
  if (state.selectedModelId) {
    const m = state.models.find(x => x.id === state.selectedModelId);
    if (m) showModelProperties(m);
  }
}

// ============================================================
// 工具函数：fitViewToAll
//   - 若有选中的可见模型 → 聚焦该单个模型
//   - 否则 → 正等测观察所有可见模型
// ============================================================
// InstancedMesh（如块体模型）在 three r132 下 expandByObject/setFromObject 不会统计
// 实例矩阵，只取共享单位立方体（±0.5）→ 包围盒退化到原点 1m → 相机拉飞 / 坐标轴刻度挤堆。
// 构建时已把真实盒子存进 mesh.userData.blockBox，这里统一取用。
function expandModelBox3(box, m) {
  if (!m || !m.mesh || !m.mesh.visible) return;
  if (m.mesh.isInstancedMesh && m.mesh.userData && m.mesh.userData.blockBox) {
    box.union(m.mesh.userData.blockBox);
  } else {
    box.expandByObject(m.mesh);
  }
}

function fitViewToAll() {
  // 优先聚焦选中的可见模型
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
  // 矢量平面标签（正交相机）：俯视适配视野（像看图一样平铺显示）
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
// 坐标轴标签：沿全局包围盒底面角点引出的三条边标注坐标
//   - 计算 XYZ 范围 → 合理间隔 → Sprite 标签
//   - 标签显示原始坐标值（还原全局原点偏移+轴交换）
// ============================================================
state.axisLabelGroup = null; // THREE.Group

function buildAxisLabels() {
  applyScenePreferences(scene,state);
  // 清除旧标签
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
  // 坐标映射关系（来自解析器 parseGOCADTS，不可变更）：
  //   Three.X = GOCAD_X - ox     → 东坐标（7位数）
  //   Three.Y = GOCAD_Z - oz     → 高程（GOCAD Z轴向上）
  //   Three.Z = -(GOCAD_Y - oy)  → 北坐标取反（8位数，右手系保持）
  // 还原公式：
  //   GOCAD_X = ThreeX + ox
  //   GOCAD_Y = -ThreeZ + oy
  //   GOCAD_Z = ThreeY + oz
  // ==========================================================

  // ★ 从当前标签页的 state.origin 获取原点（不同标签页可有不同 origin）
  //   若 state.origin 为 null，尝试从模型元数据或包围盒推断
  let effectiveOrigin = state.origin;
  if (!effectiveOrigin) {
    // 优先从第一个可用模型的 fileOrigin 推断
    const firstWithFileOrigin = state.models.find(m => m.geoMesh && m.geoMesh.fileOrigin);
    if (firstWithFileOrigin) {
      effectiveOrigin = { x: firstWithFileOrigin.geoMesh.fileOrigin.x, y: firstWithFileOrigin.geoMesh.fileOrigin.y, z: firstWithFileOrigin.geoMesh.fileOrigin.z };
      console.warn('[Coordinate labels] state.origin is empty, From model fileOrigin Infer:', effectiveOrigin);
    } else {
      // 兜底：从包围盒最小值推断（百米级向下取整）
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
      // 写入 state.origin 供后续使用
      state.origin = effectiveOrigin;
    }
  }
  const ox = effectiveOrigin.x, oy = effectiveOrigin.y, oz = effectiveOrigin.z;
  console.log('[Coordinate labels] Current tab origin: ox= ' + ox + ' oy=' + oy + ' oz=' + oz);

  // 计算全局包围盒（基于 Three.js 坐标）
  const box = new THREE.Box3();
  state.models.forEach(m => { expandModelBox3(box, m); });
  if (box.isEmpty()) { console.warn('[Coordinate labels] Bounding box is empty'); return; }
  const min = box.min, max = box.max;
  const corner = { x: min.x, y: min.y, z: min.z }; // 坐标轴起点：底面左下角
  const rangeX = max.x - min.x;
  const rangeY = max.y - min.y;
  const rangeZ = max.z - min.z;

  // 合理间隔：找接近 range/6 的 1/2/5 的整数倍
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
  // renderOrder 不再强制设为 99999，保持默认 0
  // 让刻度标签与轴线段参与正常的透明物体深度排序，模型可自然遮挡刻度

  const maxRange = Math.max(rangeX, rangeY, rangeZ);
  const off = maxRange * 0.08 + 5;       // 标签外侧偏移量（远离长方体）
  const labelScale = (maxRange * 0.025 + 2) * appPreferences.axisTextScale;
  const endLabelScale = labelScale * 1.2; // 末端轴名字标签稍大

  // ==========================================================
  // axisSpec：Three.js 物理轴与 GOCAD 真实坐标、标签、颜色的完整映射
  //   key = Three.js 物理轴 ('x'/'y'/'z')
  //   endLabel   — 轴末端显示的文字（用户要求：X→X轴，Y→Z轴，Z→Y轴）
  //   color      — 此轴的刻度文字+轴线段+末端标签统一颜色
  //   gocadCoord — 对应 GOCAD 的哪个真实坐标（用于注释&还原）
  //   toGocad    — Three该轴数值 → GOCAD 真实坐标（刻度文字显示）
  //   range/step — 此轴的包围盒范围 & 合理步长
  //   minV/maxV  — 此轴的包围盒最小/最大值（Three 坐标）
  //   tickPos(v) — 刻度 Sprite 在 Three 空间的位置（沿轴变化，另两轴固定角点，整体偏移到外侧）
  //   axisStart  — 轴线段起点（角点）
  //   axisEnd    — 轴线段终点（沿轴到 max）
  //   endLabelPos— 末端"X轴/Y轴/Z轴"文字 Sprite 位置（轴终点再外移 off）
  //   tickTickDirection — 刻度短线的方向（用来画小刻度线）
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
      // 用户要求：Three.Y 物理轴末端标签 = "Z轴"（因为它显示 GOCAD Z，即高程，用户说"z轴代表高程"）
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
      // 用户要求：Three.Z 物理轴末端标签 = "Y轴"（因为它显示 GOCAD Y，北坐标，用户说"y是八位数"）
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
  // 按 axisSpec 统一渲染：刻度 → 刻度短线 → 轴线段 → 末端轴名
  // ==========================================================
  for (const threeAxis of ['x', 'y', 'z']) {
    const spec = axisSpec[threeAxis];
    spec.color = appPreferences[threeAxis==='x'?'axisX':threeAxis==='y'?'axisZ':'axisY'];
    spec.lineColor = parseInt(spec.color.slice(1),16);
    const startV = Math.ceil(spec.minV / spec.step) * spec.step;
    const endV = Math.floor(spec.maxV / spec.step) * spec.step;

    // 1) 刻度标签（沿该轴递增，外侧偏移显示）
    for (let v = startV; v <= endV + 0.001; v += spec.step) {
      const text = String(spec.toGocad(v));
      const sp = makeLabelSprite(text, labelScale, spec.color);
      sp.position.copy(spec.tickPos(v));
      sp.userData.axisLabelPriority = (v === startV || Math.abs(v-endV)<0.001) ? 1 : 2;
      // renderOrder 保持默认，让模型几何体可正常遮挡刻度
      group.add(sp);
    }

    // 2) 刻度短线
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

    // 3) 轴线段（整条边）
    const axisGeo = new THREE.BufferGeometry().setFromPoints([spec.axisStart, spec.axisEnd]);
    const axisMat = new THREE.LineBasicMaterial({ color: spec.lineColor });
    const line = new THREE.Line(axisGeo, axisMat);
    // renderOrder 保持默认，让模型可遮挡轴线段
    group.add(line);

    // 4) 末端轴名标签（X轴 / Y轴 / Z轴）
    const nameSp = makeLabelSprite(spec.endLabel, endLabelScale, spec.color);
    nameSp.position.copy(spec.endLabelPos);
    nameSp.userData.axisLabelPriority = 0;
    // renderOrder 保持默认，让模型可遮挡末端轴名
    group.add(nameSp);
  }

  group.visible = state.axisLabelsVisible;
  scene.add(group);
  state.axisLabelGroup = group;
}

// 按屏幕上的实际距离避让刻度；旋转、缩放时只更新可见性，不重建纹理。
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
  // 同步恢复项目或外部重命名后的完整标题。
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

// 生成文字 Sprite
// 参数：text 文字, scale 尺寸, color 文字颜色（默认深灰）
// 背景：透明色；无边框
// 宽度自动按文字长度计算（每字约占 fontSize，最小 128px，支持 7-8 位数字不被截断）
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
  // 背景透明
  ctx.fillStyle = 'rgba(255,255,255,0)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // 无边框
  ctx.strokeStyle = 'rgba(0,0,0,0)';
  ctx.lineWidth = 0;
  // 文字颜色（可自定义，用于区分 XYZ 轴）
  ctx.fillStyle = color || '#222';
  ctx.font = 'bold ' + fontSize + 'px "Microsoft YaHei", "PingFang SC", "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  // 透明像素不能写入深度，否则整块文字矩形会遮蔽透明地质模型。
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false, alphaTest: 0.05 });
  const sprite = new THREE.Sprite(mat);
  const s = scale || 8;
  const aspect = canvasW / canvasH;
  sprite.scale.set(s * aspect, s, 1);
  // renderOrder 保持默认(0)：让模型 mesh（默认 renderOrder=0）在透明物体排序中按距离正确遮挡
  // 不再强制 99999，避免刻度标签浮在模型之上
  return sprite;
}

// ============================================================
// Resize 处理
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
// 右键「三维地质模型」→ 新建模型对话框
// ============================================================
const header3DModel = document.getElementById('header-3d-model');
const subitems3DModel = document.getElementById('subitems-3d-model');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalLabel = document.getElementById('modal-label');
const modalInput = document.getElementById('modal-input');
const modalConfirm = document.getElementById('modal-confirm');
const modalCancel = document.getElementById('modal-cancel');

// 右键事件
header3DModel.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  // 阻止 toggleNode 触发
  openNewModelDialog();
});

// 对话框用途：'3d-new'（三维地质模型新建） | 'geochem-new'（地球化学模型新建） | 'drillhole-new'（矿区钻孔新建）
let modalPurpose = '3d-new';

// 获取复选框相关 DOM
const modalCoordsysRow = document.getElementById('modal-coordsys-row');
const modalSameCoordsys = document.getElementById('modal-same-coordsys');

function openNewModelDialog() {
  modalPurpose = '3d-new';
  modalTitle.textContent = 'Add model group';
  modalLabel.textContent = 'Enter a new model name';
  modalInput.value = 'New area';
  // 显示「同一坐标系」复选框，默认不勾选（默认视为不同坐标系，自动新建标签页）
  modalCoordsysRow.style.display = '';
  modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => modalInput.focus(), 50);
}

modalConfirm.addEventListener('click', () => {
  // ★ 重入闸门（2026-09-17）：Enter 键走的是 modalConfirm.click()，
  //   若用户"按回车 + 顺手点一下确定"或双击鼠标，处理器会连跑两次，
  //   建出两个类别（实测 +2）。这里用"对话框是否还开着"做闸门：
  //   modalOverlay 已在上一轮移除 show 后再进来就直接忽略。
  if (!modalOverlay.classList.contains('show')) return;
  const name = modalInput.value.trim() || 'New model';
  modalOverlay.classList.remove('show');
  // 三维地质模型/地球化学模型/三维坑道模型/三维块体模型（★ 第 101 节起）都采用同样的坐标系逻辑；
  // 矿区钻孔/图件分组/报告管理/测试数据管理/点线类别/重命名不涉及坐标系，也不新建 3D 标签
  if (modalPurpose !== 'drillhole-new' && modalPurpose !== 'drawing-group-new' &&
      modalPurpose !== 'drawing-subcategory-new' &&
      modalPurpose !== 'report-folder-new' && modalPurpose !== 'report-folder-rename' && modalPurpose !== 'pdf-file-rename' &&
      modalPurpose !== 'testdata-folder-new' && modalPurpose !== 'testdata-folder-rename' && modalPurpose !== 'testdata-file-rename' &&
      modalPurpose !== 'point-category-new' && modalPurpose !== 'point-category-rename' &&
      modalPurpose !== 'line-category-new' && modalPurpose !== 'line-category-rename' &&
      // ★ 第 101 节：'blockmodel-new' 已从排除名单移出 → 与地球化学/三维坑道同规则
      //   （勾选「同一坐标系」= 留在当前视图；不勾选 = 自动新建 3D 标签页并切换）
      // ★ 第 68 节：以下重命名用途同样不涉及坐标系，不应触发「新建 3D 标签页」
      modalPurpose !== 'drawing-category-rename' && modalPurpose !== 'drawing-file-rename' &&
      modalPurpose !== 'table-category-rename' && modalPurpose !== 'table-file-rename' &&
      modalPurpose !== 'drillhole-area-rename' &&
      modalPurpose !== 'project-new-name' && modalPurpose !== 'model-file-rename' && modalPurpose !== 'model-group-rename') {
    const sameCoordsys = modalSameCoordsys.checked;
    // 检查当前激活标签是否为 3D 标签（图片/表格标签无法加载 3D 模型）
    const activeViewer = tabViewers.get(activeTabId);
    const isActive3D = activeViewer && activeViewer.type === '3d';
    if (!sameCoordsys || !isActive3D) {
      // 不同坐标系（或当前非 3D 标签）→ 自动新建 3D 标签页，名称=模型名称，自动切换
      window.createNewTab('3d', { label: name });
    }
  }
  // 添加项目树节点（无论是否新建标签页都添加）
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
    // ★ 第 67 节：图件分类下新建子分类（如「岩芯资料」下建「ZK1203」）
    //   原实现用 window.prompt，Electron/Chromium 已弃用同步 prompt（可能返回 null）
    //   → 用户输入名字后静默 return，观感「点了没反应」。改用工程内统一 modal。
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

// 在项目树追加新模型节点
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
  // 插入到 subitems-3d-model 的最前面（保留原有 xx矿区-A矿段）
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
// 右键「地球化学模型」→ 新建模型对话框（单层分类，无二级文件夹）
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
  // 地球化学模型对话框也显示「同一坐标系」复选框（与三维地质模型一致）
  modalCoordsysRow.style.display = '';
  modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => modalInput.focus(), 50);
}

// ============================================================
// 右键「钻孔」分组头 → 新增矿区钻孔
// （自动初始化：孔口表格 / 钻孔测斜 / 地质信息 / 地球化学信息 / 蚀变信息）
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
  // 矿区钻孔不涉及坐标系 → 隐藏「同一坐标系」复选框
  modalCoordsysRow.style.display = 'none';
  modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => modalInput.focus(), 50);
}

// 在地球化学模型项目树下追加新模型节点（单层：模型节点 + 空的 nested-items 容器）
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
// 右键分类文件夹 → 导入.ts模型
// ============================================================
const ctxMenu = document.getElementById('ctx-menu');
const ctxImportTs = document.getElementById('ctx-import-ts');
const ctxImportObj = document.getElementById('ctx-import-obj');
const fileInput = document.getElementById('file-input');

let pendingCategoryItem = null;
// 右键菜单当前选择的模型导入类型：'ts'（.ts/.str/.dtm）| 'obj'（.obj）
let pendingModelImportKind = 'ts';
// 右键菜单当前上下文：type ∈ {'category'|'model'|'file'}，target 为对应的 DOM 节点
let ctxContext = { type: null, target: null };

// 根据类型过滤菜单项的显示
// type 取值：point-sphere（三维画布上的单点）/ point-category（项目树点类别）/ ……
function filterCtxMenu(type) {
  ctxMenu.querySelectorAll('[data-menu-type]').forEach(el => {
    const types = (el.getAttribute('data-menu-type') || '').split(',');
    el.style.display = types.includes(type) ? '' : 'none';
  });
  // 坑道模型实为 .str/.dtm 配对导入：右键坑道时把「导入 TS 模型」改名「导入 dtm 模型」，其余场景（地质/地球化学）保持原名
  const tsLabel = document.getElementById('ctx-import-ts-label');
  if (tsLabel) tsLabel.textContent = type === 'tunnel' ? 'Import dtm Model' : 'Import TS Model';
  // 点类别：菜单项文案随当前绘制状态切换（点绘制 / 结束点绘制），并带上类别名作提示
  if (type === 'point-category') {
    const ap = document.getElementById('ctx-add-point');
    const sp = ap && ap.querySelector('span');
    const nm = (ctxContext && ctxContext.pointId && state.pointLayers[ctxContext.pointId])
      ? state.pointLayers[ctxContext.pointId].name : '';
    if (sp) sp.textContent = ((typeof pointAddMode !== 'undefined' && pointAddMode) ? 'Finish point drawing' : 'Draw points') + (nm ? '（' + nm + '）' : '');
  }
}

// 通用：给项目树节点设置拖拽
// payload 基础字段 {type: 'file'|'category'|'model', ...}
// dragstart 时当场收集该节点下所有子文件 modelIds，写入 payload.modelIds
// 这样 drop 时可直接读取 modelIds，无需知道源节点位置
function setupNodeDraggable(node, payload) {
  node.setAttribute('draggable', 'true');
  node.addEventListener('dragstart', (e) => {
    // 当场收集子文件 modelIds + fileNames（兼容 file/category/model 三种节点）
    const data = Object.assign({}, payload);
    if (data.type === 'file' || data.type === 'blockmodel') {
      data.modelIds = [data.modelId];
      // 显式传入的 fileNames 优先（避免依赖节点内 span 的先后顺序）
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
  // 1. 分类文件夹（矿体/地层/构造/蚀变）
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

  // 2. 模型节点（矿区模型，没有 data-category，但有 has-children 且父级是 subitems-3d-model 或同级 wrapper 内）
  //  其特征：下一个兄弟元素是 .lp-nested-items，里面有 [data-category] 项
  const modelItems = root.querySelectorAll('.lp-sub-item.has-children:not([data-category])');
  modelItems.forEach(item => {
    if (item._ctxBound) return;
    const sib = item.nextElementSibling;
    if (!sib || !sib.classList.contains('lp-nested-items')) return;
    const hasCategories = sib.querySelector('[data-category]');
    if (!hasCategories) return;
    item._ctxBound = true;
    // 给模型节点打标，便于后续识别
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

  // 3. 文件名节点（.lp-sub-item 且有 data-model-id，但没有 data-category / has-children）
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

// 初始绑定（xx矿区-A矿段下的分类 + 模型节点本身 + 已有的文件节点）
bindCategoryContextMenus(document.getElementById('subitems-3d-model'));

// ============================================================
// 地球化学模型右键菜单绑定（单层分类：模型节点 + 文件节点）
// ============================================================
function bindGeochemContextMenus(root) {
  // 1. 地球化学模型节点（data-role="geochem-model-node"）
  //    单层分类：模型节点直接承担「导入.ts模型」+「重命名/输出/删除」
  const modelItems = root.querySelectorAll('[data-role="geochem-model-node"]');
  modelItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    setupNodeDraggable(item, { type: 'model', modelRole: 'geochem-model' });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pendingCategoryItem = item; // 复用导入逻辑：addFileNodeToCategory 通过 nextElementSibling 找到 nested-items
      ctxContext = { type: 'geochem', target: item };
      filterCtxMenu('geochem');
      showCtxMenu(e.clientX, e.clientY);
    });
  });

  // 2. 文件名节点（复用三维地质模型的文件节点右键逻辑）
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
// 块体模型（Leapfrog CSV 导出）导入
// 列：Id, X, Y, Z, dX, dY, dZ, GM
//   - X=东, Y=北, Z=高程（Leapfrog 标准约定）
//   - 经 gocadToThree 映射到 Three.js：three=(X-ox, Z-oz, oy-Y)
//   - 按 GM 类别分组，每类一个 InstancedMesh（单 draw call），天然实现"按 GM 类别显隐"
//   - 默认半透明（opacity 0.7）+ depthWrite:true（保证块间相互遮挡、外观稳定）
//   - 复用三维地质模型的 GM 7 类约定色（BLOCK_GM_COLORS）
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
  // 允许同一项目中地质模型与块体在不同三维页面打开。
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
  // 未匹配类别按名称生成稳定颜色，避免所有未知类别共用橙色。
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
  const used = new Set(state.models.map(model => model.color));
  for (let i=0;i<360;i++) {
    const color = new THREE.Color().setHSL(((hash%360+i*137.508)%360)/360,0.65,0.52).getHex();
    if (!used.has(color)) return color;
  }
  return 0xE67E22;
}

// 右键「块体模型」分组头 → 仅显示"新建块体模型"（子文件夹）
// 第 98 节：块体模型改为「分组 → 子文件夹 → GM 类节点」两层结构，与地球化学模型一致
const headerBlockModel = document.getElementById('header-block-model');
const subitemsBlockModel = document.getElementById('subitems-block-model');

// 当前导入目标子文件夹（右键子文件夹 / 点击"导入块体模型 CSV"时记录）
let pendingBlockCategoryItem = null;

headerBlockModel.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  ctxContext = { type: 'blockmodel', target: headerBlockModel };
  filterCtxMenu('blockmodel');
  showCtxMenu(e.clientX, e.clientY);
});

// 新建子文件夹对话框（与地球化学一致：单层分类 = 子文件夹 + GM 类节点）
function openNewBlockModelDialog() {
  modalPurpose = 'blockmodel-new';
  modalTitle.textContent = 'New 3D block model';
  modalLabel.textContent = 'Enter a new model name';
  modalInput.value = 'New block model';
  // ★ 第 101 节：与三维地质/地球化学/三维坑道一致 → 显示「同一坐标系」复选框，默认不勾选。
  //   勾选 = 沿用当前视图（与已有钻孔/地质模型同一坐标系、不新建标签）；
  //   不勾选 = 确认时自动新建 3D 标签页并切换，块体模型落在新视图（新标签无 origin，导入时按块体范围取整）。
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

// 在「块体模型」分组下追加子文件夹节点（子文件夹 + 空的 nested-items 容器）
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
  // 返回子文件夹节点本身（其 nextElementSibling 即 nested-items，供 addBlockTreeNode 追加 GM 类节点）
  return wrapper.querySelector('[data-role="block-model-node"]');
}

// 块体模型项目树右键绑定（第 99 节：与地球化学子文件夹完全对齐）
//   1. 子文件夹节点（data-role="block-model-node"）
//      → 菜单：导入块体模型 CSV / 重命名 / 输出块体 CSV / 删除
//      → 拖拽：整组拖回画布（收集其下全部 GM 类的 modelIds，与地球化学子文件夹同一机制）
//   2. GM 类文件节点（.lp-sub-item[data-model-id]）
//      → 菜单：重命名 / 导入属性表 / 输出块体 CSV / 删除（与地球化学文件节点逐项对齐）
//      → 拖拽：单类拖回画布（type='blockmodel'，drop 分发有专用分支）
//   注：『输出』对 InstancedMesh 无 OBJ 意义（共享单位立方体）→ 故 blockmodel 系列挂的是
//      专用『输出块体 CSV』（从实例矩阵反算原始块），而不用通用 ctx-export
function bindBlockContextMenus(root) {
  if (!root) return;
  // 1. 子文件夹节点
  root.querySelectorAll('[data-role="block-model-node"]').forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    // 整组拖回画布：type='model' → setupNodeDraggable 的 else 分支收集 nested-items 内全部 modelIds
    setupNodeDraggable(item, { type: 'model', modelRole: 'block-model' });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 导入目标 = 该子文件夹（addBlockTreeNode 通过 nextElementSibling 找到 nested-items）
      pendingBlockCategoryItem = item;
      ctxContext = { type: 'blockmodel-node', target: item };
      filterCtxMenu('blockmodel-node');
      showCtxMenu(e.clientX, e.clientY);
    });
  });

  // 2. GM 类文件节点（复用地球化学文件节点的交互：单类拖回画布 + 右键菜单）
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

// 第 99 节：输出块体 CSV
//   通用「输出」走 meshToOBJ，对 InstancedMesh 只能拿到共享单位立方体（≈1m）→ 块体模型用专用出口：
//   从实例矩阵反算回原始 Leapfrog 块（Id,X,Y,Z,dX,dY,dZ,GM），逐 GM 类各导一个 CSV。
//   三种坐标轴序：three X=东(p.x)、Y=高程(p.y)、Z=北(p.z) → Leapfrog X=东、Y=北、Z=高程
//     X = p.x + ox ；Y = oy − p.z ；Z = p.y + oz
//     缩放同理：dX = s.x ；dY = s.z ；dZ = s.y
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

// 「输出块体 CSV」：子文件夹 → 导其下全部 GM 类；GM 类节点 → 只导该类
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
  // 子文件夹：收集其下全部 GM 类
  const nested = target.nextElementSibling;
  const ids = (nested && nested.classList.contains('lp-nested-items'))
    ? Array.from(nested.querySelectorAll('.lp-sub-item[data-model-id]')).map(fn => fn.getAttribute('data-model-id'))
    : [];
  const models = ids.map(id => state.models.find(m => m.id === id)).filter(Boolean);
  if (!models.length) { flashBlockHint('This block model has no files to export'); return; }
  const baseName = (target.querySelector('span') || {}).textContent || 'Block Model';
  exportBlockCsvForModels(models, baseName);
});

// 点击"导入块体模型 CSV" → 触发文件选择（导入目标 = 右键时选中的子文件夹）
document.getElementById('ctx-import-block').addEventListener('click', (e) => {
  e.stopPropagation();
  hideCtxMenu();
  pendingBlockCategoryItem = (ctxContext && ctxContext.target) || pendingBlockCategoryItem;
  const input = document.getElementById('block-csv-input');
  input.value = '';
  input.click();
});

// 选择文件 → 解析并渲染
const blockCsvInput = document.getElementById('block-csv-input');
blockCsvInput.addEventListener('change', async () => {
  const files = Array.from(blockCsvInput.files || []);
  if (!files.length) return;
  await importBlockModelFiles(files);
  blockCsvInput.value = '';
});

async function importBlockModelFiles(files) {
  // 导入目标子文件夹：右键子文件夹时记录；若缺失（或已被删除）则按首个 CSV 名自动建一个
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
  // 共享单位立方体几何，逐实例用矩阵缩放为实际块尺寸
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
    // 共享单位几何的包围球（原点 r≈0.87）会让整类实例被视锥误剔除 → 关闭剔除
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

    // 显示名：图层管理 / 项目树 / 图例 统一用它（避免 7 个 GM 类都显示同一个 CSV 文件名）
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
      // 第 99 节：输出块体 CSV 时从实例矩阵反算原始 Leapfrog 坐标所需的原点（烘焙进实例坐标，必须留存）
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

// 第 98 节：GM 类节点挂到「子文件夹」的 nested-items 下（两层结构：分组 → 子文件夹 → GM 类）
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
  // 第 97 节：挂载拖拽 → 可从左侧树拖回画布（drop 分发里有 type='blockmodel' 专用分支）
  setupNodeDraggable(node, { type: 'blockmodel', modelId: modelObj.id });
  nested.appendChild(node);
  // 第 99 节：GM 类节点是「导入时」动态创建的 → 必须在这里补绑右键（子文件夹创建时的 bind 覆盖不到它）
  bindBlockContextMenus(nested);
  modelObj.treeFileNode = node;
  modelObj.treeCategoryItem = categoryItem || null;
}

// ============================================================
// 三维坑道模型：右键「三维坑道模型」分组头 → 新建模型对话框
// 单层分类（与地球化学模型一致）：模型节点 + 文件节点
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
  // 与三维地质/地球化学模型一致：显示「同一坐标系」复选框
  modalCoordsysRow.style.display = '';
  modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => modalInput.focus(), 50);
}

// 在三维坑道模型项目树下追加新模型节点（单层：模型节点 + 空的 nested-items 容器）
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

// 三维坑道模型右键菜单绑定（单层分类：模型节点 + 文件节点）
function bindTunnelContextMenus(root) {
  // 1. 坑道模型节点（data-role="tunnel-model-node"）
  const modelItems = root.querySelectorAll('[data-role="tunnel-model-node"]');
  modelItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    setupNodeDraggable(item, { type: 'model', modelRole: 'tunnel-model' });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pendingCategoryItem = item; // 复用导入逻辑：addFileNodeToCategory 通过 nextElementSibling 找到 nested-items
      ctxContext = { type: 'tunnel', target: item };
      filterCtxMenu('tunnel');
      showCtxMenu(e.clientX, e.clientY);
    });
  });

  // 2. 文件名节点（复用三维地质模型的文件节点右键逻辑）
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
// 图件管理：右键菜单绑定 + 导入/重命名/删除/输出逻辑
// 支持图片（png/jpg/jpeg/bmp/gif/tif/tiff/webp/svg）+ dwg + dxf
// ============================================================
const drawingFileInput = document.getElementById('drawing-file-input');
const subitemsDrawingMgmt = document.getElementById('subitems-drawing-mgmt');
// ★ 第 102 节：左树一级大类「地表」的容器 + 分组头（承载 遥感影像 / 地形图 两个分类）
const subitemsSurface = document.getElementById('subitems-surface');
const headerSurface = document.getElementById('header-surface');
// 图件内存存储：{id: {id, fileName, categoryNode, blobUrl, blob, ext}}
state.drawings = state.drawings || {};
state.pointLayers = state.pointLayers || {};
let pendingDrawingCategory = null; // 右键时记下要导入到哪个分类节点

// 全局点击/右键事件中识别 drawing-category 和 drawing-file 节点
// （已在 document contextmenu 监听器中处理；下方补充绑定）

// ============================================================
// 图件分组（父节点）：右键「图件管理」分组头 -> 新建「xx矿区图件」，
// 分组下含子分类（矿区地质图 / 遥感影像地形图 / 地形图等）
// ============================================================
const headerDrawingMgmt = document.getElementById('header-drawing-mgmt');

headerDrawingMgmt.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  openNewDrawingGroupDialog();
});

// ★ 第 102 节：「地表」大类分组头右键 → 在「地表」下新建分类
//   （复用与图件管理完全相同的「新建子分类」对话框/落盘通道；
//     headerSurface.nextElementSibling 即 #subitems-surface，addDrawingSubCategory 依赖这个相邻关系）
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

// ★ 第 67 节：待挂载子分类的父节点（图件分类节点，如「岩芯资料」）
let pendingDrawingSubParent = null;

// ★ 第 67 节：新建图件子分类对话框（替代不可靠的 window.prompt）
function openNewDrawingSubCategoryDialog(parentNode) {
  if (!parentNode) return;
  const catName = ((parentNode.querySelector('span') || {}).textContent || '').trim();
  pendingDrawingSubParent = parentNode;
  modalPurpose = 'drawing-subcategory-new';
  modalTitle.textContent = 'New subcategory';
  modalLabel.textContent = 'in“ ' + catName + ' ”Create a subcategory under (Enter a name, e.g. drillhole ID ZK1203) ';
  // 岩芯资料下建子分类时，默认值直接给「孔号_深度」的提示格式，减少手误
  modalInput.value = (catName === 'Core Data') ? 'ZK' : 'New subcategory';
  modalCoordsysRow.style.display = 'none';
  modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => { modalInput.focus(); modalInput.select(); }, 50);
}

// 生成一个图件子分类节点（分类节点 + 空 nested-items）
function buildDrawingCategoryNode(name) {
  return '' +
    '<div class="lp-sub-item has-children" data-role="drawing-category" onclick="toggleNode(this)">' +
      '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
      '<span>' + escapeHtml(name) + '</span>' +
    '</div>' +
    '<div class="lp-nested-items expanded"></div>';
}

// 默认子分类清单（新建父节点时初始化全部子节点）
// ★ 第 102 节：『遥感影像』『地形图』已迁出为左树一级大类「地表」，故从此清单移除，
//   否则右键「图件管理」→ 新建图件分组时会再次生成这两个分类（表现为「删了又复活」）。
const DEFAULT_DRAWING_SUBCATEGORIES = [ 'Cross Sections', 'Level Plans', 'Mining Rights Maps', 'Drillhole Log', 'Core Data'];

// ★ 第 102 节：「地表」大类下的内置分类（固定骨架，不算用户自建内容）。
//   用于 hasRealProjectContent() 的「骨架节点」判定 —— 空分类不应被判成用户工作内容。
const SURFACE_BUILTIN_CATEGORIES = ['Remote Sensing Imagery', 'Geological Maps'];

// 把页面上已写死的平铺分类节点（含内置图件）包裹进默认父节点「xx矿区图件」（幂等）
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

// 新建图件分组：父节点 + 默认子分类
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

// 父分组/分类下新建子分类
// ★ 第 67 节改动：
//   ① 原先容器不匹配时【静默 return】，用户完全无感知 → 改为提示 + 返回 false；
//   ② 原先只改 DOM、不写 state、不落盘 → 新建后立即 doSaveProject(true)，
//      否则空子分类一旦遇到重渲染/重开项目就会消失（观感「没新建成功」）。
function addDrawingSubCategory(groupNode, name) {
  if (!groupNode) return false;
  const nested = groupNode.nextElementSibling;
  if (!nested || !nested.classList.contains('lp-nested-items')) {
    flashDrawingHint('A subcategory cannot be created under this node: Right-click“Maps and Figures”categories under (e.g.“Core Data”) then create');
    return false;
  }
  // 同名去重，避免连点产生重复子分类
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
  // 让嵌套容器处于展开态，新建的节点用户能立刻看到
  nested.classList.add('expanded');
  const prev = groupNode.previousElementSibling;
  if (prev && prev.classList && prev.classList.contains('lp-sub-item')) prev.classList.remove('collapsed');
  // ★ 第 102 节：容器可能是「图件管理」也可能是「地表」，两边都要重绑，
  //   否则在「地表」下新建的分类拿不到右键菜单（表现＝「点了没反应」）。
  try { bindDrawingContextMenus(subitemsDrawingMgmt); } catch (e) {}
  if (subitemsSurface) { try { bindDrawingContextMenus(subitemsSurface); } catch (e) {} }
  flashDrawingHint('Subcategory created“ ' + wanted + '」');
  // ★ 持久化（第 74 节修正）：
  //   原实现调 doSaveProject(true)，但 doSaveProject 在【项目尚未命名】时
  //   （currentProjectPath 为空）即使 silent=true 也会弹出「保存项目」系统对话框，
  //   要求用户先选一个磁盘路径 —— 与用户预期「不要弹保存窗口，保存在项目中」不符。
  //
  //   正确通道：桌面环境走 saveSessionNow() → 写入 userData/shanwei-session.json，
  //   即工程内的「项目草稿」，全程静默、不弹任何窗口，且重启程序会自动恢复现场。
  //   仅在草稿通道不可用（浏览器环境 / 保存失败）时，才回退到 doSaveProject(true)，
  //   以保证「新建的内容不会丢」这一底线不被破坏。
  persistProjectSilently();
  return true;
}

// ============================================================
// 静默持久化（第 74 节新增）
// ============================================================
// 目标：凡「用户做了个轻量操作就该保存」的场景，一律不弹系统保存对话框。
//
// 为什么不能直接用 doSaveProject(true)：
//   doSaveProject 内部逻辑是「currentProjectPath 为空 → 无论如何都弹 showSaveDialog」。
//   而项目刚打开/新建时路径往往为空（用户还没点过「保存项目」），于是
//   一个「新建子分类」的小操作会突然弹出要求选择磁盘路径的窗口，打断非常明显。
//
// 分层策略（先静默、再兜底）：
//   ① 桌面环境（有 electronAPI.saveSession）→ saveSessionNow() 写 userData 草稿，静默；
//   ② 已有项目路径（currentProjectPath 非空）→ doSaveProject(true) 直接覆盖原文件，静默；
//   ③ 以上都不可用（浏览器环境且未保存过）→ 保持原行为（浏览器本就无法静默落盘）。
//
// 返回：true = 已通过 ① 或 ② 静默落盘；false = 未落盘（调用方可按需兜底）
function persistProjectSilently() {
  // ① 草稿通道（推荐：无路径也能存）
  if (window.electronAPI && window.electronAPI.saveSession) {
    try {
      // saveSessionNow 是 async，但不阻塞调用方；失败会返回 false，此处不 await
      Promise.resolve(saveSessionNow()).catch(() => {});
      return true;
    } catch (e) {}
  }
  // ② 已有项目路径 → 静默覆盖
  if (currentProjectPath) {
    try {
      Promise.resolve(doSaveProject(true)).catch(() => {});
      return true;
    } catch (e) {}
  }
  // ③ 兜底：不弹窗（原 doSaveProject(true) 在无路径时会弹框，此处刻意不调）
  return false;
}

// 删除父分组（连同其下子分类与图件）
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
  // 1. 分类节点（矿区地质图、遥感影像、地形图、剖面图、中段图、矿权图、岩芯资料）
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
      // ★ 第 67 节：ctx-new-drawing-category 的 data-menu-type 已改为 "drawing-group,drawing"，
      //   filterCtxMenu('drawing') 现在会正确显示它，原先依赖的 L6380 硬编码补丁已移除。
      //   但「新建子分类」只对「岩芯资料」有意义（其它分类是固定语义的专题分类），
      //   故仍在此处做业务性收窄 —— 这是产品规则，不是显隐机制的补丁。
      filterCtxMenu('drawing');
      const newSubItem = document.getElementById('ctx-new-drawing-category');
      if (newSubItem) newSubItem.style.display = (catName === 'Core Data') ? '' : 'none';
      showCtxMenu(e.clientX, e.clientY);
    });
  });

  // 1.5 父分组节点（xx矿区图件）
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

  // 2. 图件文件子项（带 data-drawing-id）
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
    // 双击图件文件 → 在新标签页中打开图片
    item.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openDrawingInNewTab(item);
    });

    // 控制点配准：追加「配准」按钮 + 拖拽到三维画布
    initDrawingFileItem(item);
  });
}


// 控制点配准（图片 → GOCAD 真实坐标）
// 配准状态按图件维度全局保存（不随 3D 标签页切换）
// ============================================================
const drawingRegisters = {};
let ivDragMoved = false, ivDragMovedAt = 0;

// 图件唯一标识：硬编码节点用 data-drawing-path，动态导入用 data-drawing-id
function getDrawingKey(fileNode) {
  return fileNode.getAttribute('data-drawing-path') || fileNode.getAttribute('data-drawing-id') || ('drawing_' + Math.random().toString(36).slice(2, 6));
}

// 初始化图件文件子项：追加「配准」按钮 + 缓存 blobUrl + 拖拽到三维画布
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
    // 需求入口：右键「配准」按钮进入配准（阻止浏览器菜单与文件项右键菜单）
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startRegisterDrawing(item);
    });
    item.appendChild(btn);
  }
  // 缓存 blobUrl（state.drawings 可能随 3D 标签切换，这里固化到节点属性）
  if (!item.getAttribute('data-drawing-blob')) {
    const id = item.getAttribute('data-drawing-id');
    const d = state.drawings && state.drawings[id];
    if (d && d.blobUrl) item.setAttribute('data-drawing-blob', d.blobUrl);
  }
  // 拖拽到三维画布生成贴图平面
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

// 图件文件子项 → 三维画布拖拽
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

// 进入配准模式：打开/切换到该图片标签页
async function startRegisterDrawing(fileNode) {
  const key = getDrawingKey(fileNode);
  const id = fileNode.getAttribute('data-drawing-id');
  if (await openDrawingInNewTab(fileNode) === false) return;
  // 立即激活配准模式（不依赖图片 load 事件：图片加载失败/较慢时配准模式也必须可用，
  // 否则用户右键图片会被静默忽略，表现为「不显示定位点」）
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
  st.regEditing = -1; // 当前正在编辑（弹窗输入坐标）的点索引，-1 表示无
  const reg = drawingRegisters[key];
  if (reg && reg.done && reg.points && reg.points.length === 3) {
    // 重新配准：恢复上次三个点的位置与坐标（未锁定，可重新确认）
    st.regPoints = reg.points.map((p, i) => ({
      u: p.u, v: p.v, x: p.x, y: p.y, z: p.z, saved: false
    }));
  } else {
    // 首次配准：无预生成点，右键点击图片逐点选取
    st.regPoints = [];
  }
  // 渲染配准 UI（标记点渲染依赖图片 naturalWidth，未加载完成时等 load/error 后渲染）
  const renderWhenReady = () => {
    const s2 = getActiveImageState();
    if (s2 && s2.regMode) renderRegisterUI();
  };
  if (ivImg.complete && ivImg.naturalWidth) renderRegisterUI();
  else {
    ivImg.addEventListener('load', renderWhenReady, { once: true });
    ivImg.addEventListener('error', renderWhenReady, { once: true });
    // 兜底：图片加载异常（404/解码失败/卡住）超过 2.5 秒仍渲染面板，并在面板中提示
    setTimeout(() => {
      const s2 = getActiveImageState();
      if (s2 && s2.regMode && !s2._regUIRendered) renderRegisterUI();
    }, 2500);
  }
}

// 渲染配准面板（图片标签页顶部）+ 标记点
function renderRegisterUI() {
  const st = getActiveImageState();
  if (!st || !st.regMode) return;
  const wrap = document.getElementById('image-viewer-wrap');
  const panel = document.getElementById('register-panel-top');
  const layer = document.getElementById('register-marker-layer');
  if (!panel || !layer) return;
  wrap.classList.add('reg-active');
  // 首次构建面板结构
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
  // 图片未加载成功（naturalWidth 为 0）时无法定位标记点，面板给出明确提示
  if (!ivImg.naturalWidth) {
    const hintEl = panel.querySelector('#rp-hint');
    if (hintEl) hintEl.innerHTML = '<span style="color:#e74c3c">The image failed to load or is still loading, A control point cannot be selected at the moment. </span>';
    const statusEl = panel.querySelector('#rp-status');
    if (statusEl) statusEl.innerHTML = 'Check the image file path, then, Reopen the image tab and try again. ';
  } else {
    refreshRegisterPanel(st);
    // 渲染标记点 + 浮层小窗
    renderRegisterMarkers(st, layer);
  }
  // 同步上下窗口布局：面板占上方，图片显示区与标记层下移到面板下方
  syncRegisterPanelLayout();
}

// 刷新顶部面板的提示文案与按钮状态（依赖当前已确认的点数）
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

// 渲染标记点与浮层小窗
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
    // 阻止标记点上的按下操作触发图片拖拽
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
  // 若有点正在编辑，在其右侧渲染浮层小窗
  if (st.regEditing >= 0 && st.regPoints[st.regEditing]) {
    renderRegisterPop(st, st.regEditing, layer);
  }
}

// 右键点击图片：新增一个待填坐标的点并弹出浮层小窗
function addRegisterPointFromClick(e) {
  const st = getActiveImageState();
  if (!st || !st.regMode) return;
  const layer = document.getElementById('register-marker-layer');
  if (!layer) return;
  // 若已有小窗在编辑，先关闭
  closeRegisterPop();
  const pts = st.regPoints || [];
  if (pts.length >= 3) {
    window.showTabModal({ title: 'Maximum control points reached', label: 'Selected 3 control points, Enter coordinates for each point and click“Register”. To select again, first“Reset control points”. ' });
    return;
  }
  const pt = imagePointFromEvent(e);
  if (!pt) return; // 未落在图片范围内
  // 避免右键落在已存在的标记点上导致重复新增（标记点自身 contextmenu 会打开编辑）
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

// 打开某点的浮层小窗（右键标记点）
function openRegisterPop(st, i, layer) {
  closeRegisterPop();
  const p = st.regPoints[i];
  if (!p) return;
  if (p.saved) {
    // 已保存锁定：提示不可修改，需重置重选
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

// 渲染浮层小窗（吸附在标记点右侧）
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
  // 重新配准时可预填上次已确认的坐标
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
  // 若超出图片显示区右/下边界，翻转吸附方向
  const r = ivStage.getBoundingClientRect();
  const popW = 178, popH = pop.offsetHeight || 130;
  if (pos.x + 18 + popW > r.width) pop.style.left = (pos.x - 18 - popW) + 'px';
  if (pos.y - 40 + popH > r.height) pop.style.top = (pos.y - popH + 34) + 'px';
  if (pos.y - 40 < 0) pop.style.top = '6px';
  pop.querySelector('#reg-pop-ok').addEventListener('click', () => saveRegisterPoint(st, i));
  pop.querySelector('#reg-pop-cancel').addEventListener('click', closeRegisterPop);
  // 回车确认
  pop.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); saveRegisterPoint(st, i); }
    });
  });
  const first = pop.querySelector('input[data-axis="x"]');
  if (first) first.focus();
}

// 保存浮层小窗中填写的坐标（锁定该点）
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

// 关闭浮层小窗
function closeRegisterPop() {
  const pop = document.getElementById('reg-pop');
  if (pop) pop.remove();
}

// 测量配准面板高度，下移图片显示区与标记层（面板高度自适应内容）
function syncRegisterPanelLayout() {
  const wrap = document.getElementById('image-viewer-wrap');
  const panel = document.getElementById('register-panel-top');
  if (!wrap || !panel) return;
  const h = (panel.offsetHeight || 190) + 8; // 面板距顶 8px 边距
  wrap.style.setProperty('--reg-panel-h', h + 'px');
  updateRegisterMarkers();
}

// 窗口尺寸变化时保持上下窗口布局
window.addEventListener('resize', () => {
  const st = getActiveImageState();
  if (st && st.regMode) syncRegisterPanelLayout();
});

// 轻量刷新标记点位置（图片缩放/移动后调用，保持标记点跟随图片对应点）
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
  // 浮层小窗吸附在正在编辑的标记点右侧，需同步跟随
  const pop = document.getElementById('reg-pop');
  if (pop && st.regEditing >= 0 && st.regPoints[st.regEditing]) {
    const pos = markerStagePos(st.regPoints[st.regEditing].u, st.regPoints[st.regEditing].v);
    pop.style.left = (pos.x + 18) + 'px';
    pop.style.top = (pos.y - 40) + 'px';
  }
}

// 隐藏配准面板与标记点（不改变 viewer 的配准状态）
function hideRegisterOverlay() {
  closeRegisterPop();
  const wrap = document.getElementById('image-viewer-wrap');
  const panel = document.getElementById('register-panel-top');
  const layer = document.getElementById('register-marker-layer');
  if (wrap) wrap.classList.remove('reg-active');
  if (panel) panel.classList.add('hidden');
  if (layer) layer.innerHTML = '';
}

// 退出配准模式（自动隐藏标记点与输入面板）
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

// 鼠标事件 → 图片像素坐标（兼容缩放/拖拽/居中布局）
// clampToEdge=true 时允许在图片外拖拽，并钳制到图片边界内
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

// 配准模式：右键点击图片选取特征点（生成点 + 弹出坐标小窗）
ivStage.addEventListener('contextmenu', (e) => {
  const st = getActiveImageState();
  if (!st || !st.regMode) {
    // 普通查看模式下右键图片：引导用户先进入配准模式
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
  // 浮层小窗内部的右键（输入框粘贴菜单等）不拦截、不选点
  if (e.target.closest('.reg-pop')) return;
  // A deliberate right click remains valid immediately after left-button panning.
  ivDragMoved = false;
  addRegisterPointFromClick(e);
});

// 图片像素坐标 → 相对 stage 的屏幕位置（标记点定位）
function markerStagePos(u, v) {
  const w = ivImg.naturalWidth, h = ivImg.naturalHeight;
  const imageRect = ivImg.getBoundingClientRect();
  const stageRect = ivStage.getBoundingClientRect();
  return {
    x: imageRect.left - stageRect.left + (w ? u * imageRect.width / w : 0),
    y: imageRect.top - stageRect.top + (h ? v * imageRect.height / h : 0)
  };
}

// 2D→3D 仿射变换：3 个像素点 (u,v) → GOCAD (x,y,z)
// 求解 X = a·u + b·v + c（对 X/Y/Z 三个分量独立解 3×3 线性系统，克莱姆法则）
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

// 应用仿射变换：图片像素 (u,v) → GOCAD 坐标
function applyAffineTransform(tr, u, v) {
  return {
    x: tr.x.a * u + tr.x.b * v + tr.x.c,
    y: tr.y.a * u + tr.y.b * v + tr.y.c,
    z: tr.z.a * u + tr.z.b * v + tr.z.c
  };
}

// 确认配准：计算并保存仿射变换
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
  // 重新配准：在旧平面所在标签页用新变换重建；首次配准：自动生成半透明贴图平面
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
// 贴图平面（在三维标签场景中显示已配准的图片）
// ============================================================
// 在当前 3D 标签页生成贴图平面（半透明），注册到图层管理
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
  // 预检图片是否可加载（加载失败给出明确提示，避免静默无贴图）
  const imgProbe = new Image();
  imgProbe.onerror = () => {
    window.showTabModal({ title: 'Image loading failed', label: 'Unable to load the texture image:  ' + (reg.fileUrl || '') + '\n Check that the image file exists, and the page is served by a local server (http://localhost) Open. ' });
  };
  imgProbe.src = reg.fileUrl;
  const texture = new THREE.TextureLoader().load(reg.fileUrl, (tex) => {
    const cur = drawingRegisters[reg.key];
    if (!cur || cur.transform !== reg.transform) return; // 配准已变更，放弃本次结果
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
    // ★ UV 的 V 方向必须与「图片像素行号」相反：
    //   图片像素坐标原点在【左上角】（v=0 是第 0 行 = 图片顶部），
    //   而 three.js 纹理坐标原点在【左下角】（uv.v=0 取图片最后一行 = 底部）。
    //   若不翻转，图片会上下颠倒 —— 表现为剖面图高程（Z）上下相反、
    //   俯视图南北颠倒（从上方俯视看起来像左右镜像）。
    //   故 p0(图片左上) → uv.v=1，p3(图片左下) → uv.v=0。
    const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    // ★ 正常遮挡（第 70 节）：depthTest 必须为 true，否则贴图会永远盖在所有模型最前面，
    //   即使它实际位于模型背后也照样显示，容易被误判为「位置不对」。
    //   depthWrite 保持 false：本材质是半透明（opacity 0.8），若开启深度写入，
    //   它背后的模型会被裁掉，贴图边缘出现「黑洞」。半透明物体不写深度的做法与
    //   工程内其它半透明图层（如 SHP 面填充、坑道半透明体）保持一致。
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.8,
      side: THREE.DoubleSide, depthWrite: false, depthTest: true
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = reg.fileName + '  (Texture) ';
    // 模型属性面板需要 geoMesh.boundingBox 数据
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
    // 当前激活标签才需要刷新图层管理/图例
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

// 从指定 3D 标签页移除贴图平面 model
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

// 移除某图件在所有 3D 标签页中的贴图平面
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

// 拖拽图件到三维画布：生成贴图平面（替换同图件旧平面）
async function buildRegisterPlaneInScene(reg) {
  if (!reg || !reg.done) {
    window.showTabModal({ title: 'Image is not registered', label: 'Register this image using control points first (Under Maps and Figures, click“Register”button) , Then drag into the 3D view to create an image plane. ' });
    return;
  }
  const owner=state.drawings?.[reg.key]?.regionId;
  if(owner&&window.researchRegionViews)await researchRegionViews.ensure(owner);
  removeRegisterPlaneModel(reg.key);
  // 优先使用当前激活的三维标签；否则取首个已设置坐标原点（导入过模型）的三维标签；再取任意三维标签
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
    // 配准完成后自动生成贴图平面：若当前不在该三维标签，先自动切换过去（立即可见效果）
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

// 重新配准后：在旧平面所在标签页用新变换重建（替换旧平面）
function rebuildPlaneAfterReRegister(reg) {
  const viewer = reg.planeTabId ? tabViewers.get(reg.planeTabId) : null;
  if (!viewer || viewer.type !== '3d' || !viewer.scene) return;
  removePlaneFromViewer(viewer, reg.planeModelId);
  reg.planeModelId = null;
  reg.planeTabId = null;
  buildPlaneInto(viewer, reg);
}

// 双击图件文件 → 新建图片标签页显示该图片
async function openDrawingInNewTab(fileNode) {
  const id = fileNode.getAttribute('data-drawing-id');
  const d = state.drawings[id];

  // 手动导入的图片：state.drawings 中已有 blobUrl，直接使用
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

  // 硬编码（自动导入）的图片节点：从 DOM 提取文件名，直接使用服务器 URL（避免大图 blob URL 加载失败）
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
  // 优先使用节点上的 data-drawing-path（硬编码节点的真实相对路径），否则回退到「图件管理/{fileName}」
  const filePath = fileNode.getAttribute('data-drawing-path') || ('Maps and Figures/ ' + fileName);
  // 使用原始相对路径作为 src（浏览器会自动百分号编码，file:// 与 http 下均可正确解码中文文件名）
  return createNewTab('image', { imageName: fileName, imageUrl: filePath });
}

// 初始绑定（先把平铺分类包进默认父节点，再绑定右键）
wrapExistingDrawingCategories();
if (subitemsDrawingMgmt) bindDrawingContextMenus(subitemsDrawingMgmt);
// ★ 第 102 节：「地表」下的两个分类与图件管理下分类走同一套右键/双击/配准/拖拽逻辑
if (subitemsSurface) bindDrawingContextMenus(subitemsSurface);

// —— 菜单：导入图件 ——
document.getElementById('ctx-import-drawing').addEventListener('click', async (e) => {
  e.stopPropagation();
  hideCtxMenu();
  if (pendingDrawingCategory) {
    if (!await guardImportPointDraw('Importing map or figure')) return;
    drawingFileInput.value = '';
    drawingFileInput.click();
  }
});

// —— 右键「导入 DXF」：选 .dxf 文件 ——
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

// —— 右键「导入 GeoJSON」：选 .geojson / .json 文件 ——
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

// —— 矢量文件导入（通用）：解析 + 三维渲染 + 项目树节点 ——
// 矢量存储：全局存储（不用 state.vectors —— state 随标签切换独立，可能导致 undefined 报错）
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
        // 3D 矢量：新建独立三维标签并切换（不与其它文件共用标签）
        console.log('[Vector import] ' + file.name + ' Detected Z Coordinates → Display in a new 3D tab');
        window.createNewTab('3d', { label: file.name });
      } else {
        // 2D 矢量：自动新建「矢量平面」标签页并切换，在平面标签中显示（不进主三维视图）
        console.log('[Vector import] ' + file.name + ' None Z Coordinates → Automatically open a 2D vector tab');
        window.createNewTab('vector2d', { label: file.name + '  (Plane) ' });
      }
      await yieldToUI();
      // 渲染三维（带进度）
      const model = await loadVectorToScene(entities, file.name, layerColors);
      // 项目树节点
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

// 矢量文件节点绑定：右键菜单（重命名/输出/删除）+ 双击打开标签展示
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
  // 双击 → 打开标签展示（2D 开矢量平面标签，3D 进三维视图）
  node.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openVectorInTab(node);
  });
}

// 双击矢量文件节点：定位已有标签 / 按 2D/3D 新建标签并加载
function openVectorInTab(fileNode) {
  const vid = fileNode.getAttribute('data-vector-id');
  const v = window.vectorStore[vid];
  if (!v) { alert('Vector data does not exist, Import again'); return; }
  // 双击总是新建独立标签：2D → 矢量平面标签，3D → 三维标签（不复用已有标签）
  const hasZ = entitiesHaveZ(v.entities || []);
  if (hasZ) {
    window.createNewTab('3d', { label: v.fileName });
  } else {
    window.createNewTab('vector2d', { label: v.fileName + '  (Plane) ' });
  }
  loadVectorToScene(v.entities, v.fileName, v.layerColors);
}

// —— 文件选择：多文件导入 ——
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
      filePath: getFilePath(file),   // 原始文件路径（项目保存用）
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

// —— 重命名 ——
// ★ 第 68 节：原实现用同步 window.prompt，Electron 中不可用（Chromium 已弃用），
//   会静默 return → 用户「点了没反应」。统一改用全局 modal（复用 openRenameInputDialog）。
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
  // 分类名可能影响「岩芯资料 → 岩芯图片」的查找，改名后刷新右侧面板
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
  // 岩芯图片名可能带深度（如 ZK1203_1到50m.jpg），改名后右侧面板排序会变 → 刷新
  try { if (typeof refreshHolePanelIfOpen === 'function') refreshHolePanelIfOpen(); } catch (e) {}
}

// —— 删除 ——
function deleteDrawingCategory(catNode) {
  const nested = catNode.nextElementSibling;
  const fileNodes = nested
    ? nested.querySelectorAll('.lp-sub-item[data-drawing-id]')
    : [];
  const name = (catNode.querySelector('span') || {}).textContent || 'This category';
  if (fileNodes.length > 0 && !confirm('Confirm deletion“ ' + name + ' ”and its ' + fileNodes.length + ' maps or figures??')) return;
  if (fileNodes.length === 0 && !confirm('Confirm deletion“ ' + name + ' ”??')) return;
  // 释放 blob URL 并从 state.drawings 移除
  fileNodes.forEach(fn => {
    const id = fn.getAttribute('data-drawing-id');
    const d = state.drawings[id];
    if (d && d.blobUrl) URL.revokeObjectURL(d.blobUrl);
    delete state.drawings[id];

    // 清理配准状态与贴图平面
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

  // 清理配准状态与贴图平面
  const key = getDrawingKey(fileNode);
  if (drawingRegisters[key]) {
    removeRegisterPlaneModel(key);
    delete drawingRegisters[key];
  }
  fileNode.remove();
}

// —— 输出（下载） ——
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
// 地质图矢量导入：DXF / GeoJSON 解析 + 三维渲染
// 阶段①：线→折线、点→小球、文字→标签；面先按边界环渲染
// 坐标：阶段一直接以图纸坐标平铺显示（three = [x, y, 0]），
//       阶段二将复用三点配准把矢量落到 GOCAD 坐标系
// ============================================================

// ---- 智能读取文本文件：UTF-8 出现乱码时自动按 GBK 重解（中文版 CAD 导出的 DXF 多为 GBK 编码） ----
async function readTextFileSmart(file) {
  const buf = await file.arrayBuffer();
  let utf8 = '';
  try { utf8 = new TextDecoder('utf-8').decode(buf); } catch (e) { utf8 = ''; }
  // 无替换字符 U+FFFD → 是合法 UTF-8，直接返回
  if (utf8.indexOf('\uFFFD') === -1) return utf8;
  // 存在乱码 → 尝试 GBK 解码（浏览器原生支持）
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    console.log('[Vector import] Detected non- UTF-8 Encoding, Applied by GBK Decode again');
    return gbk;
  } catch (e2) {
    return utf8;
  }
}

// ---- DXF 文本解析（组码解析；支持 LINE/LWPOLYLINE/POLYLINE/CIRCLE/ARC/POINT/TEXT/MTEXT） ----
// ---- MTEXT/TEXT 控制码清理（\A1; \P \S上下标 字体 等） ----
function cleanMtext(raw) {
  if (!raw) return '';
  let s = String(raw);
  // 1) 上下标 \S...^...; / \S.../...; → 取主内容
  s = s.replace(/\\S([^;]*?)(?:\^|\/)([^;]*?);/g, '$1');
  // 2) 删除成对花括号 {}
  s = s.replace(/[{}]/g, '');
  // 3) 换行 \P → 空格
  s = s.replace(/\\P/gi, ' ');
  // 4) 非断空格 \~ → 空格
  s = s.replace(/\\~/g, ' ');
  // 5) 对齐码 \A1; \An; → 删除
  s = s.replace(/\\A\d*;/g, '');
  // 6) 其余控制码 \X...;（字体/颜色/高度/倾斜等）→ 删除
  s = s.replace(/\\[A-Za-z][^;]*;/g, '');
  // 7) 转义 \\ → \
  s = s.replace(/\\\\/g, '\\');
  // 8) 清理控制字符
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return s.trim();
}

// ---- 从 dxf-parser 结果提取图层色表：{图层名: {colorIndex, color(RGB)}} ----
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

// ---- 原始配色解析：实体色 > 图层色 > 默认白（还原 CAD 配色，不做自动配色） ----
function resolveEntityColor(ent, layerColors) {
  if (typeof ent.color === 'number') return ent.color;   // 实体自带色（dxf-parser 已转 RGB）
  const lc = layerColors ? layerColors[ent.layer] : undefined;
  if (lc && lc.colorIndex > 0 && lc.colorIndex !== 7) return lc.color;  // 图层有具体色（7=白按 CAD 黑线处理）
  return 0x000000;                                       // ByBlock / 白(7) / 未知 → 默认黑色
}

// ---- ACI 索引 → RGB（CAD 标准 256 色，简化近似） ----
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

// ---- 自研提取 HATCH 填充实体（dxf-parser 1.1.2 不支持 HATCH） ----
//   仅支持多段线(polyline)边界路径（SOLID 填充最常用）；每条路径独立成环；
//   HATCH 组码（实测 1线.dxf）：91=路径数，92=路径类型标志(bit1=2 表示 polyline)，
//   93=polyline 顶点数，之后是 10/20 顶点对×N；实体级 10/20 是图案原点（跳过）；
//   真彩色 420 高 8 位是标志位（取低 24 位）；421 是图案背景色（暂不用）
function parseHatchEntities(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = String(text || '').split(/\r?\n/);
  const hatches = [];
  // pendingSection：刚读到 0/SECTION，下一个 2 组码是段名（ENTITIES 段名是 2 组码的值）
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
    // 段名：SECTION 后的 2 组码（HATCH 内部的 2 组码是图案名，仅在 pendingSection 时消费）
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

// ---- dxf-parser 输出 → 内部统一实体结构 ----
function dxfToEntities(dxf) {
  const entities = [];
  const ents = (dxf && dxf.entities) || [];
  ents.forEach(e => {
    const layer = e.layer || '0';
    // dxf-parser 已把实体 62 色号转换为 RGB（如 16711680=红）；无颜色为 undefined
    const entColor = (typeof e.color === 'number' && e.color !== 0xFFFFFF) ? e.color : undefined;
    const push = (obj) => { if (entColor !== undefined) obj.color = entColor; entities.push(obj); };
    switch (e.type) {
      case 'LINE': {
        // 兼容两种 dxf-parser 输出形态：
        //  ① 部分版本给 { start:{x,y,z}, end:{x,y,z} }；
        //  ② 本工程内联的精简 UMD 只给 { vertices:[{x,y,z},{x,y,z}] }（无 start/end）。
        //     旧代码直接读 e.start.x，遇到形态 ② 会抛 TypeError，导致整个
        //     parseDXFText 走 catch 回退到自研解析器（LINE 实体实际靠回退路径兜住）。
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
        // 插入点：MTEXT→position；TEXT→startPoint；有对齐点(endPoint+halign/valign)时用对齐点
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
        // 块引用：暂以点位显示（完整块展开后续支持）
        if (e.position) push({ type: 'POINT', layer: layer, x: e.position.x, y: e.position.y, z: e.position.z || 0, blockName: e.name });
        break;
      }
      // 3DFACE / SOLID / HATCH / DIMENSION 等暂不支持，跳过（HATCH 由 parseHatchEntities 自研提取补充）
      default: break;
    }
  });
  return entities;
}

// ---- DXF 文本解析（dxf-parser 主用，失败回退自研）；返回 {entities, layerColors} ----
function parseDXFText(text) {
  if (typeof DxfParser === 'undefined') {
    const entities = parseDXFTextLegacy(text);
    for (const h of parseHatchEntities(text)) entities.push(h);   // dxf-parser 不支持 HATCH，自研提取补充
    return { entities: entities, layerColors: null };
  }
  try {
    const parser = new DxfParser();
    const dxf = parser.parseSync(text);
    const entities = dxfToEntities(dxf);
    // dxf-parser 1.1.2 不支持 HATCH：自研提取填充实体并合并
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
      // 提交上一个 VERTEX 顶点到所属 POLYLINE
      if (cur && cur.type === 'VERTEX' && lastPoly) {
        lastPoly.pts.push([cur.x || 0, cur.y || 0, cur.z || 0]);
      }
      // 收尾上一个实体（VERTEX 顶点已在上面提交给所属 POLYLINE，不单独保留）
      if (cur && cur.type !== 'VERTEX') entities.push(cur);
      if (type === 'SECTION' || type === 'ENTITIES') { cur = null; continue; }
      if (type === 'ENDSEC' || type === 'SEQEND') { cur = null; lastPoly = null; continue; }
      cur = { type: type, layer: '0', color: 7, pts: [] };
      if (type === 'POLYLINE' || type === 'POLYLINE3D' || type === 'LWPOLYLINE') lastPoly = cur;
      else if (type !== 'VERTEX') lastPoly = null;   // VERTEX 时保留 lastPoly，其坐标后续并入 POLYLINE
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
    // LWPOLYLINE 顶点：每对 10/20 记一个点
    if (cur.type === 'LWPOLYLINE' && code === 20 && cur._px !== undefined) {
      cur.pts.push([cur._px, cur._py, cur.z || 0]);
      cur._px = undefined;
    }
  }
  // 循环结束：收尾最后一个实体
  if (cur && cur.type !== 'VERTEX') entities.push(cur);
  // 过滤无几何内容的实体
  return entities.filter(e => {
    if (e.type === 'LINE') return e.x2 !== undefined;
    if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE' || e.type === 'POLYLINE3D') return (e.pts && e.pts.length >= 2);
    if (e.type === 'CIRCLE' || e.type === 'ARC') return e.r !== undefined;
    if (e.type === 'POINT') return true;
    if (e.type === 'TEXT' || e.type === 'MTEXT') return e.text !== undefined;
    return false;
  });
}

// ---- 统计 DXF 文件中出现的所有实体类型（用于解析失败诊断） ----
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

// ---- 检测实体是否含 z 轴坐标（决定二维平面 / 三维显示） ----
function entitiesHaveZ(entities) {
  return (entities || []).some(e => {
    if (e.pts) return e.pts.some(p => Math.abs(p[2] || 0) > 1e-9);
    if (e.type === 'LINE') return Math.abs(e.z || 0) > 1e-9 || Math.abs(e.z2 || 0) > 1e-9;
    return Math.abs(e.z || 0) > 1e-9;
  });
}

// ---- GeoJSON 文本解析（Point/LineString/Polygon/Multi*；统一转成与 DXF 相同的实体结构） ----
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

// ---- 构建矢量三维 Group（线/点/文字标签） ----
// ---- 分片构建矢量 Group（每批处理若干实体并让出主线程，刷新进度条） ----
async function buildVectorGroupAsync(entities, onProgress, layerColors) {
  const group = new THREE.Group();
  const colorLines = new Map();   // color → 线段顶点数组
  const colorPoints = new Map();  // color → 点顶点数组
  const labels = [];              // 文字标签
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  // 图纸坐标 → three 坐标：[x, z(高程), -y(北取反)]；无 z 时 y=0 → 二维平面显示
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
        // 填充色：真彩色(420) > ACI(62) > 图层色/黑（ent.color 是 ACI 索引，不能直接当 RGB）
        let fillColor;
        if (typeof ent.trueColor === 'number') fillColor = ent.trueColor;
        else if (typeof ent.color === 'number') fillColor = aciToHex(ent.color);
        else fillColor = resolveEntityColor(ent, layerColors);
        const paths = (ent.paths && ent.paths.length) ? ent.paths
                    : (ent.points && ent.points.length ? [{ points: ent.points, closed: true }] : []);
        paths.forEach(pth => {
          const pts = pth.points || [];
          if (pts.length < 3) return;
          // 关键：Shape 用 CAD 原始平面坐标 (x, y)，旋转 -π/2 后 → three (x, 0, -y)，
          // 与边界线 toThree(x, y, 0) = (x, 0, -y) 完全重合（旧版误用 (x,-y) 再旋转 → z=+y 南北镜像错位）
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
          // 边界线（闭合轮廓，与面片同一坐标变换）
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
  // 按颜色创建线
  colorLines.forEach((arr, hex) => {
    if (arr.length >= 6) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const mat = new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 1 });
      group.add(new THREE.LineSegments(geo, mat));
    }
  });
  // 按颜色创建点
  colorPoints.forEach((arr, hex) => {
    if (arr.length >= 3) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const mat = new THREE.PointsMaterial({ color: hex, size: 1.5 });
      group.add(new THREE.Points(geo, mat));
    }
  });
  // 文字标签
  labels.forEach(lb => {
    const sp = makeVectorTextSprite(lb.text, lb.x, lb.y, lb.height, lb.z, lb.hex, lb.anchor);
    if (sp) group.add(sp);
  });
  if (group.children.length === 0) return null;
  group.userData.vectorBounds = { minx: minx, miny: miny, minz: minz, maxx: maxx, maxy: maxy, maxz: maxz };
  return group;
}

// ---- 矢量文字标签（CanvasTexture Sprite） ----
function makeVectorTextSprite(text, x, y, height, z, color, anchor) {
  const str = String(text || '').trim();
  if (!str) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 44px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillStyle = color ? '#' + color.toString(16).padStart(6, '0') : '#24292f';
  // 文字画在左上角（便于按 CAD 锚点对齐）
  ctx.fillText(str.slice(0, 24), 8, 10);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const scale = Math.max(0.1, height || 3) * 6;
  const boxW = scale * 3, boxH = scale * 0.75;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat);
  // 锚点偏移：默认左上角对齐（MTEXT 插入点=文字框左上角）
  let ox = 0, oy = 0;
  if (anchor === 'center') {
    ox = 0; oy = 0;
  } else if (anchor === 'baseline') {
    // TEXT：插入点为基线起点 → sprite 中心略低于左上角对齐（文字高约占框高 34%）
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

// ---- 矢量模型载入场景（复用图层管理 / 显隐 / 改色 / 透明度） ----
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
  // 移除占位立方体
  if (state.placeholderMesh) {
    scene.remove(state.placeholderMesh);
    if (state.placeholderMesh.geometry) state.placeholderMesh.geometry.dispose();
    if (state.placeholderMesh.material) state.placeholderMesh.material.dispose();
    state.placeholderMesh = null;
    const emptyPh = document.getElementById('empty-placeholder');
    if (emptyPh) emptyPh.classList.add('hidden');
  }
  // 收集材质（供图层管理统一改色/透明度）
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
// 「线」导入：CSV/TXT 点串解析 + 线几何构建 + 场景加载
// 支持三种来源统一转为 entities 数组（与 DXF/GeoJSON 同构）：
//   DXF      → parseDXFText()
//   GeoJSON  → parseGeoJSONText()
//   CSV/TXT  → parseLineCsvText()   ← 本模块新增
// 坐标约定与 buildVectorGroupAsync 保持一致：toThree(x,y,z) = (x, z, -y)
// ============================================================

// 识别列名 → 标准字段。返回 { x, y, z, group } 的列索引（找不到为 -1）
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

// CSV/TXT 点串 → entities（每行一个点，带分组列 → 同组连成一条 POLYLINE3D）
// 无表头时按「x,y,z[,group]」或「group,x,y,z」的位置推断
function parseLineCsvText(text) {
  const rows = parseCsvText(text, null);
  if (!rows || rows.length === 0) return entitiesEmptyLines();
  // 判断首行是否为表头：含非数字字符或无法整体解析为数字
  const isNum = (v) => v !== '' && v != null && !isNaN(Number(v));
  const first = rows[0];
  const headerish = first.some(v => !isNum(v));

  let cols = null, dataRows = rows;
  if (headerish) {
    cols = detectLineColumns(first);
    dataRows = rows.slice(1);
  }
  // 表头没识别出 x/y → 回退到位置推断
  let xi, yi, zi, gi;
  if (cols && cols.x >= 0 && cols.y >= 0) {
    xi = cols.x; yi = cols.y; zi = cols.z; gi = cols.group;
  } else {
    // 位置推断：看列数
    const width = Math.max.apply(null, dataRows.map(r => r.length).concat([0]));
    if (width >= 4) { xi = 1; yi = 2; zi = 3; gi = 0; }      // group,x,y,z
    else if (width === 3) { xi = 0; yi = 1; zi = 2; gi = -1; } // x,y,z
    else if (width === 2) { xi = 0; yi = 1; zi = -1; gi = -1; } // x,y（平面线）
    else return entitiesEmptyLines();
  }

  // 按分组列归集点，组内保持出现顺序
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

// 统计 entities 中的线要素数量
function countLineEntities(entities) {
  let n = 0;
  (entities || []).forEach(e => {
    if (!e) return;
    if (e.type === 'LINE' || e.type === 'POLYLINE' || e.type === 'LWPOLYLINE' || e.type === 'POLYLINE3D'
        || e.type === 'CIRCLE' || e.type === 'ARC') n++;
  });
  return n;
}

// 从 entities 构建「线」专用 Group：
// 采用「智能粗细 + 发光描边」双层方案——底层深色描边 + 上层亮色主线，
// 在无 Line2 addon（three r132 UMD 不含真线宽）的前提下提升线感与投影可读性。
// 线宽档位 1~3：1=单层，2/3=双层叠加（视觉加粗）
let lineWidthLevel = 2;   // 全局线宽档（1/2/3）

function buildLineGroup(entities, baseColor, layerColors, widthLevel) {
  const group = new THREE.Group();
  const colorLines = new Map();  // color → 线段顶点数组
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
    // 「线」类别统一底色：DXF 图层色可能过杂，同类别下用统一基色更清晰；
    // 但若实体自带明确颜色（trueColor）则尊重原色
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

  // ① 底层：深色描边（视觉加粗 + 抗锯齿对比）
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
  // ② 上层：亮色主线
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

// 把线 Group 加载进场景，并注册为一个可管理的图层模型
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

// 主入口：导入线文件（kind: 'dxf' | 'geojson' | 'csv'）
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
      // 自动展开该类别，让用户看到导入结果
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

// 注意：lineDxfInput / lineGeojsonInput / lineCsvInput / headerLine 这几个 DOM 引用
// 的 const 声明位于下方「线管理（类别化）」段落中。为避免 const 的 TDZ 报错
// （顶层立即执行时读到未初始化的 const 会抛 ReferenceError 并中断整个脚本块 → 画布黑屏），
// 此处只保留函数声明，所有事件的绑定统一放到 const 声明之后执行。

// 把整棵线类别树清空（供 clearProject 调用）
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

// 序列化 / 恢复
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
// 钻孔表格管理（导入 / 右键 / 双击打开表格标签页）
// 架构同图件管理：state.tables 内存存储 + DOM 节点 data-table-id
// ============================================================
const tableFileInput = document.getElementById('table-file-input');
const subitemsDrillhole = document.getElementById('subitems-drillhole');
state.tables = state.tables || {};
let pendingTableCategory = null;

// ============================================================
// 矿区钻孔节点（钻孔 → xx矿区钻孔 → 5 个表格分类）
// ============================================================
// 矿区钻孔节点右键绑定：重命名 / 删除（复用通用右键菜单，类型 drillhole-area）
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

// 生成单个表格分类节点（含空的文件容器）
function buildDrillholeCategoryItem(category) {
  return '' +
    '<div class="lp-sub-item has-children" data-role="table-category" onclick="toggleNode(this)">' +
      '<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
      '<span>' + category + '</span>' +
    '</div>' +
    '<div class="lp-nested-items expanded"></div>';
}

// 新增矿区钻孔节点：自动初始化孔口表格/钻孔测斜/地质信息/地球化学信息/蚀变信息
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
  // 插入到钻孔分组的最前面
  subitemsDrillhole.insertBefore(wrapper, subitemsDrillhole.firstChild);
  // 绑定矿区钻孔节点右键 + 5 个表格分类的右键/拖拽
  bindDrillholeAreaContextMenus(wrapper);
  bindTableContextMenus(wrapper);
}

// 删除矿区钻孔节点（连同其下所有表格）
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
  // 若 wrapper 是临时 div 且空了，也移除（排除钻孔根容器）
  if (wrapper && wrapper !== subitemsDrillhole && wrapper.children.length === 0) wrapper.remove();
}

// 重命名矿区钻孔节点
// ★ 第 68 节：同上，改用全局 modal（Electron 中 prompt() 不可用）
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

// 初始绑定默认矿区钻孔节点
bindDrillholeAreaContextMenus(subitemsDrillhole);

function bindTableContextMenus(root) {
  const catItems = root.querySelectorAll('[data-role="table-category"]');
  catItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    // 拖拽分类节点到三维画布（孔口表格 → 显示孔口位置点 + holeid）
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
    // 双击表格文件 → 在新标签页中打开表格
    item.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTableInNewTab(item);
    });
  });
}

// 双击表格文件 → 新建表格标签页显示该表格
function openTableInNewTab(fileNode) {
  const id = fileNode.getAttribute('data-table-id');
  const t = state.tables[id];
  if (!t) return;

  // 如果已有同文件名的表格标签打开，直接切换过去
  const existing = Array.from(tabViewers.entries()).find(([tid, v]) =>
    v.type === 'table' && v.sourceKey === 'table:' + id
  );
  if (existing) {
    window.switchTab(existing[0]);
    return;
  }

  // 解析表格数据为 HTML（中小表同步返回字符串；大表返回首屏+分块懒加载对象）
  renderTableData(t).then(res => {
    if (typeof res === 'string') {
      // 中小表：一次渲染完整表格
      window.createNewTab('table', {
        sourceKey: 'table:' + id,
      tableName: t.fileName,
        tableHtml: res,
        tableRows: t.rows,
        tableCols: t.cols
      });
      return;
    }
    // 大表：首屏先行，其余块滚动到底逐步插入
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

// 大表阈值：数据行数（不含表头）超过该值则启用「分块懒加载」——
// 首屏只渲染 TABLE_LAZY_CHUNK 行，其余行后台分片生成、滚动到底逐步插入，
// 避免一次性渲染数万行 DOM 导致界面卡死。
const TABLE_LAZY_THRESHOLD = 2000;
const TABLE_LAZY_CHUNK = 1500;
// 表格渲染结果缓存（id → 结果）。用独立 Map：不随项目保存序列化；删除表格节点时同步清理。
const tableHtmlCache = new Map();

// 生成 data[startIdx, endIdx) 各数据行的 <tr> HTML（含可选的钻孔「忽略」复选框列）
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

// 将表格数据渲染为 HTML：
//  - 中小表（数据行 ≤ TABLE_LAZY_THRESHOLD）：同步生成完整 HTML 字符串（Promise resolve 字符串）
//  - 大表：resolve { firstHtml, lazy } —— firstHtml 含表头+第一块；
//    lazy 为共享生成器对象 { chunks:[], finished }，后台逐块填充 chunks，
//    viewer 滚动到底部时从 chunks 取块插入 DOM（见 renderTableLazyPart / loadMoreTableRows）。
function renderTableData(t) {
  // P0-2 渲染结果缓存：同一表格重复打开直接复用（关闭标签后再开无需重新拼接）
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
    // 截断提示
    if (t.truncated) {
      head += '<div style="padding:8px 16px;background:#fff3cd;border:1px solid #ffeaa7;border-radius:6px;margin-bottom:12px;font-size:13px;color:#856404;">' +
        ' ⚠ The dataset is too large, Showing the first ' + t.rows + ' Rows' + (t.cols < t.originalCols ? ' × ' + t.cols + ' Columns' : '') +
        '  (Original: ' + t.originalRows + ' Rows' + (t.originalCols ? ' × ' + t.originalCols + ' Columns' : '') + '）' +
        '</div>';
    }
    // 识别 holeid 列（用于逐行"忽略"复选框）
    const holeidIdx = findHoleidColumnIndex(data[0]);
    head += '<table><thead><tr>';
    // 忽略复选框列（仅当表格含 holeid 列）
    if (holeidIdx >= 0) {
      head += '<th style="text-align:center;width:52px;" title="Select to hide this drillhole in the 3D view">Ignore</th>';
    }
    // 第一行作为表头
    data[0].forEach(cell => {
      head += '<th>' + escapeHtml(String(cell)) + '</th>';
    });
    head += '</tr></thead><tbody>';

    const bodyCount = data.length - 1;

    // —— 中小表：一次性完整渲染（保持原行为，返回字符串） ——
    if (bodyCount <= TABLE_LAZY_THRESHOLD) {
      const html = head + buildTableRowsHtml(data, holeidIdx, 1, data.length) + '</tbody></table>';
      if (t.id) tableHtmlCache.set(t.id, { isLazy: false, html: html });
      resolve(html);
      return;
    }

    // —— 大表：首屏第一块 + 后台分片生成（每块间 setTimeout 让出主线程） ——
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
        tryAutoLoadTableAtBottom(cache); // 若用户正停在底部且此时才生成完，主动补一次加载
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
// —— 大表「分块懒加载」渲染辅助（配合 renderTableData 使用）——
// 首屏已含第一块；滚动到底部时逐块插入剩余块；切走再切回保留已加载进度。
// ============================================================
// 当前表格标签的 viewer（滚动委托 / 后台生成回调共用）。var 声明避免提升期 TDZ。
var activeLazyTableViewer = null;

// 把一块 <tr> HTML 追加到 tbody（先按当前忽略集合同步复选框状态，再一次性插入）
function appendChunkRows(tbody, chunkHtml) {
  const tpl = document.createElement('template');
  tpl.innerHTML = chunkHtml;
  tpl.content.querySelectorAll('input[data-ignore-holeid]').forEach(cb => {
    cb.checked = !!drillholeIgnoreMap[cb.dataset.ignoreHoleid];
  });
  tbody.appendChild(tpl.content);
}

// 底部加载提示条：显示已加载进度；全部加载完则移除
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

// 从当前已加载位置继续插入下一块（一次最多补 5 块，直到超出视口或块耗尽）
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
    // 若加载一块后仍未触底（首屏不足一屏），继续补，否则等用户滚动
    if (tvContent.scrollTop + tvContent.clientHeight < tvContent.scrollHeight - 160) break;
  }
  viewer.tableLazyShown = shown;
  updateTableLazyStatus(viewer, tvContent);
}

// 后台分块生成期间：若用户正停在底部且对应块已生成，主动跟进加载（无需再滚动）
function tryAutoLoadTableAtBottom(cache) {
  const v = activeLazyTableViewer;
  if (!v || !v.lazyTable || v.lazyTable !== cache) return;
  const tvContent = document.getElementById('table-viewer-content');
  if (!tvContent) return;
  if (tvContent.scrollTop + tvContent.clientHeight >= tvContent.scrollHeight - 160) {
    loadMoreTableRows(v, tvContent);
  }
}

// 表格标签切到前台时调用：恢复已加载过的分块并显示状态条
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

// 表格容器滚动事件（一次性委托，见 initTableLazyScroll）
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
// —— 钻孔"忽略"复选框（表格窗口逐行控制三维显示）——
// drillholeIgnoreMap: holeid → true 表示该钻孔在三维视图中被忽略（不显示），跨标签页全局生效
// ============================================================
const drillholeIgnoreMap = {};

// 识别表头中的 holeid 列索引（支持中英文列名），找不到返回 -1
function findHoleidColumnIndex(headers) {
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i]).replace(/[\s_\-()（）·:：]/g, '').toLowerCase();
    if (h === 'holeid' || h === 'hole' || h === '孔号' || h === '钻孔号' || h === '钻孔编号' || h === '钻孔孔号') return i;
  }
  return -1;
}

// 勾选/取消勾选"忽略"复选框：更新忽略集合并刷新所有 3D 标签页的钻孔可见性
function toggleIgnoreDrillhole(hid, checked) {
  const key = (hid === undefined || hid === null) ? '' : String(hid).trim();
  if (key === '') return;
  if (checked) drillholeIgnoreMap[key] = true;
  else delete drillholeIgnoreMap[key];
  applyIgnoredDrillholes();
}

// 根据忽略集合，遍历所有 3D 标签页场景，隐藏/显示带 holeid 标记的钻孔对象
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

// 切换表格标签时，把复选框状态同步为忽略集合的最新值
function syncTableIgnoreCheckboxes(container) {
  if (!container) return;
  container.querySelectorAll('input[data-ignore-holeid]').forEach(cb => {
    cb.checked = !!drillholeIgnoreMap[cb.dataset.ignoreHoleid];
  });
}

// 解析 CSV/TXT 文本为二维数组（支持引号包裹）
function parseCsvText(text, delimiter) {
  if (!delimiter) {
    // 自动检测：制表符优先，其次分号，最后逗号
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
  // 最后一个字段
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// 初始绑定
if (subitemsDrillhole) bindTableContextMenus(subitemsDrillhole);

// 表格窗口"忽略"复选框：事件委托（容器 innerHTML 会随标签切换刷新，委托一次永久有效）
(function initTableIgnoreCheckboxes() {
  const tvContentEl = document.getElementById('table-viewer-content');
  if (!tvContentEl) return;
  tvContentEl.addEventListener('change', (e) => {
    const cb = (e.target && e.target.closest) ? e.target.closest('input[data-ignore-holeid]') : null;
    if (!cb) return;
    toggleIgnoreDrillhole(cb.dataset.ignoreHoleid, cb.checked);
  });
})();

// 表格容器滚动 → 大表分块懒加载（一次性委托，避免每个表格都绑新监听）
function initTableLazyScroll() {
  const tvContentEl = document.getElementById('table-viewer-content');
  if (!tvContentEl || tvContentEl._lazyScrollBound) return;
  tvContentEl._lazyScrollBound = true;
  tvContentEl.addEventListener('scroll', onTableLazyScroll, { passive: true });
}
initTableLazyScroll();

// —— 菜单：导入表格 ——
document.getElementById('ctx-import-table').addEventListener('click', async (e) => {
  e.stopPropagation();
  hideCtxMenu();
  if (pendingTableCategory) {
    if (!await guardImportPointDraw('Importing table')) return;
    tableFileInput.value = '';
    tableFileInput.click();
  }
});

// —— 文件选择：多文件导入表格 ——
const MAX_TABLE_FILE_SIZE = 100 * 1024 * 1024;  // 100MB 文件大小上限
const MAX_TABLE_ROWS = 50000;                     // 5万行渲染上限（超出截断并提示）
const MAX_TABLE_COLS = 200;                       // 200列渲染上限

// Excel 相关扩展名（需要 SheetJS 解析）
const EXCEL_EXTS = ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'dbf'];
// 文本类扩展名（原生 CSV 解析）
const TEXT_EXTS = ['csv', 'txt', 'tsv'];

// 显示/隐藏加载提示（支持进度条）
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
// 更新导入进度（百分比 + 文字）
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
// 让出主线程，刷新 UI（用于分片解析/构建时刷新进度条）
function yieldToUI() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// 检查 SheetJS 是否可用（加载失败时动态重试，不阻塞页面解析）
function checkXlsxAvailable() {
  if (typeof XLSX !== 'undefined' && !window.__xlsxFailed) return true;
  if (window.__xlsxLoading) return false; // 已发起加载，等待结果
  if (window.__xlsxFailed) return false;  // 已确认加载失败
  // 首次被使用时才动态加载（避免内网环境下外部 CDN 长时间阻塞页面解析）
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

    // 更新加载提示
    showImportLoading('Parsing“ ' + file.name + '」(' + (fi + 1) + '/' + files.length + ')...');

    // 让 UI 有机会刷新
    await new Promise(r => setTimeout(r, 20));

    // 1. 检查扩展名是否支持
    if (EXCEL_EXTS.indexOf(ext) === -1 && TEXT_EXTS.indexOf(ext) === -1) {
      hideImportLoading();
      showTableError('File“ ' + file.name + ' ”format (.' + ext + ' ) is not supported. \n Supported formats: CSV / TXT / TSV / XLSX / XLS / XLSM / XLSB / ODS / DBF');
      failCount++;
      continue;
    }

    // 2. 检查文件大小
    if (file.size > MAX_TABLE_FILE_SIZE) {
      hideImportLoading();
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      showTableError('File“ ' + file.name + ' ”size: ' + sizeMB + ' MB, exceeds 100 MB limit. \n Reduce the file size and try again. ');
      failCount++;
      continue;
    }

    // 3. 检查空文件
    if (file.size === 0) {
      hideImportLoading();
      showTableError('File“ ' + file.name + ' ”is an empty file. ');
      failCount++;
      continue;
    }

    let data = null;
    try {
      if (EXCEL_EXTS.indexOf(ext) !== -1) {
        // Excel 类文件：需要 SheetJS
        await ensureDocumentLibrary('excel');
        if (!checkXlsxAvailable()) {
          hideImportLoading();
          showTableError('File“ ' + file.name + ' ”is Excel Format, but the spreadsheet parser (SheetJS) Loading failed. \n A network problem may have occurred, Refresh the page and try again, or save the file as CSV format before importing. ');
          failCount++;
          // 恢复加载提示（用户关闭弹窗后继续处理剩余文件）
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
        // CSV / TXT / TSV：原生解析，使用 TextDecoder 支持多种编码
        const buf = await file.arrayBuffer();
        // 尝试 UTF-8，若含 BOM 则自动跳过
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
            // 默认 UTF-8
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

    // 4. 检查解析结果
    if (!data || data.length === 0) {
      hideImportLoading();
      showTableError('File“ ' + file.name + ' ”The content is empty or incorrectly formatted. ');
      failCount++;
      showImportLoading('Importing...');
      continue;
    }

    // 5. 截断超大数据（防止渲染卡死）
    let truncated = false;
    let originalRows = data.length;
    let originalCols = data[0] ? data[0].length : 0;
    if (data.length > MAX_TABLE_ROWS) {
      data = data.slice(0, MAX_TABLE_ROWS);
      truncated = true;
    }
    // 截断列数
    if (data[0] && data[0].length > MAX_TABLE_COLS) {
      data = data.map(row => row.slice(0, MAX_TABLE_COLS));
      truncated = true;
    }

    const id = 'table_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    state.tables[id] = {
      id: id,
      fileName: file.name,
      filePath: getFilePath(file),   // 原始文件路径（项目保存用）
      ext: ext,
      data: data,
      rows: data.length,
      cols: data[0] ? data[0].length : 0,
      truncated: truncated,
      originalRows: originalRows,
      originalCols: originalCols
    };

    // 判定当前分类名
    const curCatName = ((pendingTableCategory && pendingTableCategory.querySelector('span'))
      ? pendingTableCategory.querySelector('span').textContent
      : '') || '';

    // —— 地球化学信息：自动识别数值属性列并拆分为 Au/Ag/S 等子类别 ——
    if (curCatName.search(/地球化学|Geochem/i) >= 0) {
      const headers = data[0] || [];
      const fixedCols = ['holeid', 'from', 'to'];
      // 识别每个属性列（排除 holeid/from/to），且整列至少有一个数值
      for (let c = 0; c < headers.length; c++) {
        const hname = String(headers[c] || '').trim();
        const hlower = hname.toLowerCase();
        if (fixedCols.indexOf(hlower) >= 0) continue;
        // 扫列检查是否为数值列
        let hasNum = false;
        for (let r = 1; r < data.length; r++) {
          const v = data[r][c];
          if (v === '' || v === null || v === undefined) continue;
          const num = Number(String(v).replace(/[,，]/g, ''));
          if (!isNaN(num) && isFinite(num)) { hasNum = true; break; }
        }
        if (!hasNum) continue;

        // 生成仅包含 holeid/from/to + 当前属性列的子表数据
        const subData = [];
        // 找 holeid/from/to 列索引
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

        // 属性子类别 id（属性名纯字母/数字）
        const attrClean = hname.replace(/[^\w\u4e00-\u9fa5]/g, '') || 'attr_' + c;
        // 注册到 state.tables
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
          geochemAttrName: hname,          // 原始属性名（如 "Au(×10^-6)"）
          geochemAttrClean: attrClean,      // 清洗后的属性名（如 "Au"）
          geochemSourceTableId: id
        };

        // 在「地球化学信息」分类下创建"属性子类别节点"
        // 若同属性子类别已存在，复用该嵌套容器
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
          // 绑定该属性子类别节点的拖拽（type='geochem-attr' + attrName）
          setupNodeDraggable(subCat, { type: 'geochem-attr', attrName: attrClean, attrRawName: hname });
        } else {
          attrNested = subCatContainer.nextElementSibling;
        }

        // 在属性子类别下挂文件节点
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
      // 普通分类：直接挂文件节点
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

    // 让 UI 有机会刷新
    await new Promise(r => setTimeout(r, 10));
  }

  bindTableContextMenus(subitemsDrillhole);
  pendingTableCategory = null;
  hideImportLoading();

  // 汇总提示
  if (successCount > 0 && failCount > 0) {
    showTableError('Import complete: Success ' + successCount + ' items, Failed ' + failCount + ' items. ');
  } else if (failCount > 0 && successCount === 0) {
    // 错误弹窗已在上方显示，此处不重复
  }
});

// 表格错误提示弹窗（复用 tab-modal）
function showTableError(msg) {
  window.showTabModal({
    title: 'Import information',
    label: msg
  });
}

// ============================================================
// 报告管理（PDF 报告导入 / 右键 / 双击打开 PDF 阅读标签页）
// 架构同表格管理：state.pdfs 内存存储 + DOM 节点 data-pdf-id
// ============================================================
const pdfFileInput = document.getElementById('pdf-file-input');
const subitemsReport = document.getElementById('subitems-report');
state.pdfs = state.pdfs || {};
let pdfCounter = 0;
let reportFolderCounter = 0;      // 文件夹 id 计数器
let pendingReportFolder = null;   // 右键记下要导入到哪个文件夹（null=导入到报告管理根目录）

// 报告管理分组头右键 → 菜单「导入 PDF」
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

// —— 菜单：导入 PDF ——
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

// —— 菜单：新建文件夹（报告管理分组头右键；Electron 中 prompt() 不可用，改用自定义输入框） ——
let pendingRenameFolder = null;   // modal 重命名文件夹的目标 {node, cur}
let pendingRenamePdf = null;      // modal 重命名 PDF 的目标 {node, cur}

// 打开自定义输入框（复用全局 modal），报告管理用途专用
function openReportFolderDialog(purpose, title, label, defVal) {
  modalPurpose = purpose;
  modalTitle.textContent = title;
  modalLabel.textContent = label;
  modalInput.value = defVal;
  modalCoordsysRow.style.display = 'none';   // 报告管理不涉及坐标系，隐藏复选框
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

// 生成报告管理文件夹节点（文件夹 + 空的文件容器）
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

// 在报告管理下新建文件夹（插入到分组末尾）
function addReportFolderNode(name) {
  if (!subitemsReport) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = buildReportFolderNode(name);
  while (tmp.firstChild) subitemsReport.appendChild(tmp.firstChild);
  bindReportContextMenus(subitemsReport);
}

// 重命名报告管理文件夹
function renameReportFolderNode(folderNode) {
  const span = folderNode.querySelector('span');
  if (!span) return;
  pendingRenameFolder = { node: folderNode, cur: span.textContent };
  openReportFolderDialog('report-folder-rename', 'Rename folder', 'Rename folder: ', span.textContent);
}

// modal 确认后执行文件夹重命名
function applyFolderRename(obj, newName) {
  if (!obj || !obj.node) return;
  const span = obj.node.querySelector('span');
  if (span) span.textContent = newName;
}

// 删除报告管理文件夹（连同其下所有 PDF / Word，并关闭已打开的阅读标签）
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
        // 关闭该 PDF 已打开的阅读标签
        Array.from(tabViewers.entries()).forEach(([tid, v]) => {
          if (v.type === 'pdf' && v.pdfUrl === p.url) closeTab(tid);
        });
        if (p.url) { try { URL.revokeObjectURL(p.url); } catch (err) {} }
      }
      delete state.pdfs[pid];
    } else if (wid) {
      const w = state.words[wid];
      if (w && w.fileName) {
        // 关闭该 Word 已打开的阅读标签
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

// 绑定报告管理内的文件夹 / PDF 节点右键
function bindReportContextMenus(root) {
  if (!root) return;
  // 文件夹节点
  const folderItems = root.querySelectorAll('[data-role="report-folder"]');
  folderItems.forEach(item => {
    if (item._ctxBound) return;
    item._ctxBound = true;
    // 点击展开/收起（不用内联 onclick，避免依赖全局作用域）
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
  // PDF 文件节点
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
  // Word 文件节点
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

// —— 菜单：打开 PDF ——
const ctxOpenPdf = document.getElementById('ctx-open-pdf');
if (ctxOpenPdf) {
  ctxOpenPdf.addEventListener('click', (e) => {
    e.stopPropagation();
    const { type, target } = ctxContext;
    hideCtxMenu();
    if (type === 'pdf-file' && target) openPdfInNewTab(target);
  });
}

// 双击 PDF 文件节点 → 打开 PDF 阅读标签页（已有同名标签则切换过去）
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

// 创建 PDF 文件节点（挂到指定文件夹下；folderNode 为 null 时挂到报告管理根目录）
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
  // 挂载位置：文件夹的 nested 容器（无则根目录）
  let target = subitemsReport;
  if (folderNode) {
    const nested = folderNode.nextElementSibling;
    if (nested && nested.classList.contains('lp-nested-items')) target = nested;
  }
  target.appendChild(node);
  bindReportContextMenus(subitemsReport);
  return node;
}

// —— PDF 重命名（弹输入框；Electron 中 prompt() 不可用，改用自定义输入框） ——
function renamePdfFileNode(fileNode) {
  const id = fileNode.getAttribute('data-pdf-id');
  const p = state.pdfs[id];
  if (!p) return;
  const span = fileNode.querySelector('span');
  const cur = span ? span.textContent : p.fileName;
  pendingRenamePdf = { node: fileNode, cur: cur };
  openReportFolderDialog('pdf-file-rename', 'Rename PDF', 'Rename PDF (The original file content is unchanged) : ', cur);
}

// modal 确认后执行 PDF 重命名（更新树节点文字 + state 记录 + 已打开的阅读标签标题）
function applyPdfRename(obj, newName) {
  if (!obj || !obj.node) return;
  const fileNode = obj.node;
  const id = fileNode.getAttribute('data-pdf-id');
  const p = state.pdfs[id];
  if (!p) return;
  const span = fileNode.querySelector('span');
  if (span) span.textContent = newName;
  p.fileName = newName;
  // 同步已打开的 PDF 阅读标签标题
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

// —— PDF 输出（下载原始文件） ——
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

// —— PDF 删除（确认后删除节点 + 记录 + 关闭已打开的阅读标签） ——
function deletePdfFileNode(fileNode) {
  const id = fileNode.getAttribute('data-pdf-id');
  const p = state.pdfs[id];
  const name = p ? p.fileName : 'This PDF';
  if (!confirm('Confirm deletion PDF“ ' + name + ' ”??')) return;
  // 关闭该 PDF 已打开的阅读标签
  Array.from(tabViewers.entries()).forEach(([tid, v]) => {
    if (v.type === 'pdf' && v.pdfName === name) closeTab(tid);
  });
  if (p && p.url) { try { URL.revokeObjectURL(p.url); } catch (e) {} }
  delete state.pdfs[id];
  fileNode.remove();
}

// —— 文件选择：导入 PDF（自动打开阅读标签页；右键文件夹时导入到该文件夹下）——
if (pdfFileInput) {
  pdfFileInput.addEventListener('change', async () => {
    const files = Array.from(pdfFileInput.files || []);
    pdfFileInput.value = '';
    if (files.length === 0) return;
    const folderNode = pendingReportFolder;  // 右键文件夹时导入到该文件夹，否则根目录
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
// 报告管理 · Word 文档只读阅读（架构同 PDF：state.words 内存存储 + DOM 节点 data-word-id；
//   docx-preview 渲染 .docx 为分页 HTML，仅查看/打印，无编辑入口）
// ============================================================
const wordFileInput = document.getElementById('word-file-input');
state.words = state.words || {};
let wordCounter = 0;
let pendingRenameWord = null;   // modal 重命名 Word 的目标 {node, cur}
let wordLoadGeneration = 0;
let currentWordUrl = '';        // 当前已加载的 Word URL（避免重复解析）

// —— 菜单：导入 Word 文档 ——
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

// —— 菜单：打开 Word ——
const ctxOpenWord = document.getElementById('ctx-open-word');
if (ctxOpenWord) {
  ctxOpenWord.addEventListener('click', (e) => {
    e.stopPropagation();
    const { type, target } = ctxContext;
    hideCtxMenu();
    if (type === 'word-file' && target) openWordInNewTab(target);
  });
}

// 双击 Word 文件节点 → 打开 Word 只读阅读标签页（已有同名标签则切换过去）
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

// 创建 Word 文件节点（挂到指定文件夹下；folderNode 为 null 时挂到报告管理根目录）
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

// —— Word 重命名（modal） ——
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
  // 同步已打开的 Word 阅读标签标题
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

// —— Word 输出（下载原始文件） ——
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

// —— Word 删除（确认后删除节点 + 记录 + 关闭已打开的阅读标签） ——
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

// —— 文件选择：导入 Word 文档（右键文件夹时导入到该文件夹下） ——
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
// 文档阅读增强：大纲 / 书签 / 笔记（右侧面板 doc 页签组）
// 数据按「文档 URL」键隔离；书签与笔记随标签会话持久化，大纲每次打开重新提取
// ============================================================

// ---------- 性能埋点：用于定位「打开慢」（控制台看，或 window.dumpDocPerf() 汇总） ----------
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
// 让出一帧：保证「正在加载」提示能真正绘制出来再进入重型计算
function yieldFrame() {
  return new Promise(function (r) {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { setTimeout(r, 0); });
    else setTimeout(r, 0);
  });
}
// 文档加载进度条（出现在阅读区顶部，避免「点了没反应」的假死感）
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

// ---------- 文档上下文与数据存储 ----------
const docStore = {};                                   // key -> { outline, outlineStatus, outlineOpen, bookmarks, note }
let docCtx = { type: '', url: '', key: '', name: '' }; // 当前激活的文档上下文

// ⚠ 键必须「跨会话稳定」：URL 多为 blob: 临时地址，程序重开后会变，
//    用它会让书签/笔记丢失。故优先取文件名作为身份，URL 仅用于会话内定位。
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

// 绑定当前文档上下文（由 switchActiveViewer 的 pdf / word 分支调用）
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
  // 切换标签时上下文可能已变化：若大纲尚未提取过，顺手触发一次
  const rec = docRecord(docCtx.key);
  if (rec && rec.outlineStatus === 'idle') scheduleEnsureOutline();
  return docCtx;
}

function refreshDocPanels() {
  renderDocOutlinePanel();
  renderDocBookmarkPanel();
  renderDocNotePanel();
}

// 右面板切到 doc 组某页签时刷新内容
window.onRightPanelTabShown = function (g, name) {
  if (g !== 'doc') return;
  if (name === 'Outline') { renderDocOutlinePanel(); scheduleEnsureOutline(); }
  else if (name === 'Bookmarks') renderDocBookmarkPanel();
  else if (name === 'Notes') renderDocNotePanel();
};

// ============================================================
// 大纲提取
// ============================================================
const PDF_OUTLINE_MAX_AUTO_PAGE = 400;   // 自动生成大纲最多扫描页数，防超大文档长时间占用主线程
let wordDocBuffer = null;                // 最近一次加载的 .docx 二进制（大纲提取复用，避免重复读文件）
let wordDocBufferUrl = '';
let outlineTimer = null;

function scheduleEnsureOutline() {
  if (outlineTimer) clearTimeout(outlineTimer);
  outlineTimer = setTimeout(function () { outlineTimer = null; ensureDocOutline(); }, 60);
}

async function ensureDocOutline() {
  const context = { ...docCtx };
  const document = context.type === 'pdf' && currentPdfUrl === context.url ? pdfDoc : null;
  if (context.type === 'pdf' && !document) return; // 文档加载完成后会重新调度，不能使用上一个PDF。
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
      // 三级回退：①解析标题样式（最准） ②DOM h1~h6 ③字号突显启发式
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

// ---------- PDF 大纲：原生书签 ----------
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
    return null;   // 老 PDF 的 dest 格式可能异常，兜底为不可跳转但仍显示
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

// ---------- PDF 大纲：按页首行自动生成（无内置书签时的回退） ----------
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
    } catch (e) { /* 单页失败跳过 */ }
    if (i % 8 === 0) await yieldFrame();   // 每 8 页让出主线程，界面不假死
  }
  perfEnd(p, 'Scan ' + limit + '/' + total + ' Page → ' + items.length + ' entries');
  if (!items.length) return null;
  return { mode: 'auto', items: items, truncated: total > limit, totalPage: total };
}

// ---------- Word 大纲：标题样式（解析 document.xml） ----------
function headingLevelOfStyle(style) {
  const s = String(style || '');
  let m = /^heading\s*(\d{1,2})$/i.exec(s);
  if (m) return Math.min(6, Math.max(1, parseInt(m[1], 10)));
  m = /^(?:标题|標題)\s*(\d{1,2})$/.exec(s);
  if (m) return Math.min(6, Math.max(1, parseInt(m[1], 10)));
  if (/^(?:title|subtitle|标题|標題|副标题|副標題)$/i.test(s)) return 1;
  // 中文 Word 的标题样式内部名常是纯数字（"1"、"2"…）
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

// ---------- Word 大纲：渲染后 DOM 的 h1~h6（兜底） ----------
function collectWordDomHeadings() {
  const content = document.getElementById('word-viewer-content');
  if (!content) return [];
  return Array.prototype.slice.call(content.querySelectorAll('h1,h2,h3,h4,h5,h6'));
}
// ⚠ 实测：docx-preview 压缩后全文不含 "heading" / "h1"，即它**不会**把 Word 标题渲染成
//    <h1>~<h6>，而是 <p> + 样式。所以仅靠 h1~h6 抓不到标题，必须有下面的启发式兜底。
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

// 第三级兜底：按「字号突显 + 短句」启发式识别标题
// （适用于正文没套用 Word「标题」样式、只是手动放大加粗的文档）
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
  // 正文基准字号 = 出现次数最多的字号
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
// 把 XML 路线提取的标题与渲染后的 DOM 节点对应起来，供点击定位
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
  // 顺序匹配全部失败但数量一致时，按下标直接对应（多数文档两者一一对应）
  if (bound === 0 && nodes.length === items.length) {
    items.forEach(function (it, i) { it.el = nodes[i]; });
  }
}

// ============================================================
// 右侧「大纲」面板渲染
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
// 收集 Word 正文里可作为标题定位锚点的段落级元素
function collectWordParagraphs() {
  const content = document.getElementById('word-viewer-content');
  if (!content) return [];
  let nodes = Array.prototype.slice.call(content.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,td'));
  if (!nodes.length) nodes = Array.prototype.slice.call(content.querySelectorAll('[class*="docx-p"],[class*="pStyle"]'));
  return nodes;
}
// 按标题文本在正文段落中找回 DOM 节点（多级匹配，处理 docx-preview 不产 h1 的现状）
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
    // 原生书签页码未解析成功 → 用 dest 再反解一次
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
    // 跨节点文本兜底
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
  } catch (e) { /* 忽略动画异常 */ }
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
// 书签：在阅读页选中文字 → 右键 → 添加标签
// ============================================================
function docCurrentLocation() {
  if (docCtx.type === 'pdf') return (typeof pdfPageNum !== 'undefined') ? pdfPageNum : null;
  return null;   // Word 用原文片段定位，不记页码
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

// Word 书签定位：按原文片段在渲染 DOM 中找回 Range 并滚动到视图
function normDocText(s) {
  return String(s == null ? '' : s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}
function stripEllipsis(s) {
  return String(s == null ? '' : s).replace(/[.…。]{2,}\s*$/, '').replace(/\s+$/, '').trim();
}
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// 在正文文本节点里按「标题片段」定位 Range；用正则匹配原始文本，
// 避免先折叠空白再取 index 造成的偏移错位（原实现把折叠后的下标当原始下标用）。
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
  } catch (e) { /* 选中着色失败不影响定位 */ }
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
  // 编辑中被外部触发重绘时，先提交当前改名，避免刚输入的内容被冲掉
  if (typeof window.__bmFinishRename === 'function') {
    const fin = window.__bmFinishRename;
    window.__bmFinishRename = null;
    try { fin(true); } catch (e) { /* 提交失败不影响后续渲染 */ }
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
// 双击名称 或 点「重命名」→ 就地改名（不依赖 prompt，Electron 下不可用）
function selectNodeContents(el) {
  try {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = window.getSelection();
    if (s) { s.removeAllRanges(); s.addRange(r); }
  } catch (err) { /* 忽略 */ }
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
  if (nameEl && nameEl.isContentEditable) return;   // 正在改名，不触发跳转
  if (nameEl) {                                     // 名称区单击延后跳转，为双击改名让路
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
// 笔记：按文档独立保存，输入自动暂存
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
  // 阻止笔记里的按键冒泡到全局快捷键
  ed.addEventListener('keydown', function (e) { e.stopPropagation(); });
})();

// ============================================================
// 持久化：书签与笔记随项目文件一起保存 / 恢复
// 大纲不持久化（源自文档本身，重开重新提取）
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
// Word 只读渲染核心（docx-preview v0.3.7）
// 说明：breakPages 按 Word 内嵌分页符切页；ignoreLastRenderedPageBreak=false
//       使 Word 保存时算好的自动分页位置生效（否则长文档挤成一页被裁剪）。
//       渲染完成后收集页面 <section>，交给懒挂载标注层（仅视口内页建 canvas）。
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
  await yieldFrame();       // 真正让出两帧，保证提示绘制出来再进入阻塞式渲染
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
    // 收集页面并初始化懒挂载标注层
    setupWordAnnotLayers();
    if(docCtx.type==='word'&&docCtx.url===url)applyStoredDocumentInk({...docCtx});
    setDocProgress(false, 100);
    // 渲染完成 → 提取大纲（当前上下文仍是本文档才生效）
    if (docCtx.type === 'word' && docCtx.url === url) { bindWordHeadingTargets(docRecord(docCtx.key)); scheduleEnsureOutline(); }
  } catch (e) {
    perfEnd(pfRender, 'Failed:  ' + ((e && e.message) || e));
    setDocProgress(false, 100);
    content.innerHTML = '<div class="pdf-hint">Word Document parsing failed (The file may be corrupt, encrypted or containing unsupported complex layouts) : ' + escapeHtml(e.message) + '</div>';
  }
}

// ============================================================
// Word 标注（画笔/高亮/橡皮/色点/清除，与 PDF 一致；连续滚动多页）
// 数据：wordAnnots = {页索引: [{type,color,width,points}]}，坐标=页面 CSS 像素（未缩放）
// 画布：懒挂载——仅当前视口内的页面 <section class="docx"> 挂标注 canvas，
//       滚动离开视口即移除画布（数据保留），回来时按需重建并重绘，省内存。
// ============================================================
let wordAnnots = {};         // {页索引: [笔画]}
let wordTool = null;         // 'pen' | 'highlight' | 'eraser' | null
let wordPenColor = '#e24b4a';// 画笔颜色
let wordDrawing = null;      // 绘制中的笔画 {page,type,color,width,points}
let wordPages = [];          // 渲染出的页面 section 元素
let wordPageCanvas = {};     // 页索引 -> canvas（仅视口内存在）
let wordPageSize = {};       // 页索引 -> {w,h} 已量得的页面内容盒（防回读自己的画布高度）
let wordReconcilePending = false;
let wordRedrawPending = false;
let wordAnnotReady = false;  // 当前文档已渲染出页面结构
let wordRedrawTimer = null;  // 重绘节流计时器（时间节流，非仅 rAF 丢帧）
const WORD_REDRAW_MIN_MS = 24;   // 最小重绘间隔（≈40fps，兼顾流畅与 CPU）
const WORD_MIN_POINT_DIST = 2;   // 相邻采样点最小距离（px），防点数爆炸
const WORD_MAX_POINTS_PER_STROKE = 2000; // 单笔最大点数上限
let wordPathCache = {};      // 页索引 -> {脏标记} 单笔 Path2D 复用缓存

function wordPixelRatio() { return window.devicePixelRatio || 1; }

// —— 缩放（Ctrl+滚轮 / 工具栏 +/- 按钮）——
// 说明：docx-preview 用 transform:scale 缩放，页面布局尺寸不变（只是视觉放大），
//       因此各页天然宽度天然一致，不会像 PDF 那样随缩放抖动。
//       标注坐标存在页面 CSS 像素里，缩放后重绘时同步放大，视觉上跟着页面走。
let wordScale = 1;
const WORD_SCALE_MIN = 0.4;
const WORD_SCALE_MAX = 4;
const WORD_SCALE_STEP = 0.1;
const WORD_AUTOFIT_MAX = 2;   // 首屏自动适配的上限，避免小窗口把内容放得过大

// 自动适配宽度：让 Word 页面宽度贴合阅读区可视宽度（首次打开时用）
function wordAutoFitScale() {
  const content = document.getElementById('word-viewer-content');
  if (!content || !wordPages.length) return;
  const avail = content.clientWidth;
  if (!avail) return;
  // 页面未被缩放时的自然宽度 = 当前视觉宽度 / 当前缩放
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
  // 缩放改变页面视觉高度 → 立即校准画布尺寸
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
  wordScale = 1;               // 新文档：缩放复位（渲染后按窗口自动适配宽度）
  applyWordZoom();
  syncWordAnnotState();
}

function setupWordAnnotLayers() {
  const content = document.getElementById('word-viewer-content');
  if (!content) return;
  // 页面容器选择器多级回退（docx-preview 版本差异：section.docx / .docx / wrapper 下子元素）
  let secs = content.querySelectorAll('section.docx');
  if (!secs.length) secs = content.querySelectorAll('.docx-wrapper > section');
  if (!secs.length) secs = content.querySelectorAll('.docx');
  if (!secs.length) secs = content.querySelectorAll('.docx-wrapper > div');
  if (!secs.length) return;   // 无页面结构（内容可能异常），跳过
  wordPages = Array.from(secs);
  wordPageCanvas = {};
  wordPageCanvas._scale = null;
  wordPageSize = {};
  wordPathCache = {};
  wordAnnotReady = true;
  // 先归位到 100% 再自动适配：保证测量页宽时口径一致（避免读到被 scale 影响的值）
  wordScale = 1;
  const content0 = document.getElementById('word-viewer-content');
  if (content0) content0.style.setProperty('--wv-scale', '1');
  // 首屏自动适配页面宽度，让文字以 100% 附近的可读大小呈现
  wordAutoFitScale();
  // 懒挂载：滚动/窗口变化时按视口增删页面画布（节流，防滚动期间高频重排）
  content.removeEventListener('scroll', scheduleWordReconcile);
  content.addEventListener('scroll', scheduleWordReconcile, { passive: true });
  window.removeEventListener('resize', onWordResize);
  window.addEventListener('resize', onWordResize);
  scheduleWordReconcile();
  // docx 内嵌图片为异步解码，高度可能后知后觉：延迟数次校准画布尺寸
  [300, 1200, 3000].forEach(function (ms) {
    setTimeout(scheduleWordReconcile, ms);
  });
}

// resize：防抖后再校准（避免拖拽窗口尺寸时连续重排）
let wordResizeTimer = null;
function onWordResize() {
  if (wordResizeTimer) clearTimeout(wordResizeTimer);
  wordResizeTimer = setTimeout(scheduleWordReconcile, 180);
}

// 校准节流：最小 80ms 一次，避免滚动过程中每帧触发全页重排
let wordReconcileTimer = null;
let wordLastReconcile = 0;
let wordReconcileRaf = null;
function scheduleWordReconcile() {
  if (!wordAnnotReady) return;
  // rAF 兜底：scroll 事件已节流，但缩放/滚动后页面位置会变，下一帧再校准一次更稳
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
  const pad = 150;   // 上下余量，避免翻页瞬间闪烁
  return r.bottom >= cr.top - pad && r.top <= cr.bottom + pad;
}

function getWordPageIndex(sec) { return wordPages.indexOf(sec); }

// 量取页面的「布局尺寸」（未含 transform:scale 的尺寸）。
// 用 getBoundingClientRect 会带上 scale，故统一除以 wordScale 还原，确保始终以
// 未缩放的 CSS 像素为基准 —— 标注坐标系因此与缩放无关，不会漂移。
// ⚠ 关键修复（2026-09-10）：绝不能再用 sec.clientHeight 量页面高度。
// 原因：section.docx 是「列方向 flex 容器」，插入的 canvas 会被 align-items:stretch
//      撑到与页面等高；若再用 sec.clientHeight 回读，等于把自己的高度算进下一轮 →
//      每轮 reconcile 页面长高 canvas 一个身位（含 margin-bottom 30px），
//      页面变高又触发 scroll → reconcile，形成正反馈死循环，直接卡死主线程。
// 做法：用一个 position:absolute + 0 尺寸的探针 div 量「不包含画布」的天然高度。
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
    // 除以 wordScale 还原掉祖先 transform:scale，得到「布局尺寸」
    const s = wordScale || 1;
    w = Math.max(1, Math.round((pr.width / s) + pl + prr));
    h = Math.max(1, Math.round((pr.height / s) + pt + pb));
  } catch (e) {
    w = 0;
    h = 0;
  } finally {
    if (probe.parentNode) probe.parentNode.removeChild(probe);
  }
  // 兜底：探针异常（高度为 0）时，仅在「尚无画布」的情况下取一次 clientHeight
  if (h <= 1) {
    const hasCanvas = sec.querySelector(':scope > .wv-annot-canvas');
    const s = wordScale || 1;
    if (!hasCanvas) h = Math.max(1, Math.round(sec.clientHeight / s));
    else {
      // 已有画布：无法安全回读，退回上一次记录的高度或最小 1px
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
  // CSS 尺寸 = 布局尺寸（页面自身的未缩放尺寸）。
  // 祖先 .docx-wrapper 的 transform:scale 会自动把画布一起放大——
  // 这正是我们要的：标注「贴在纸上」跟着页面缩放，而不是浮在屏幕固定大小。
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  // 位图分辨率按 布局尺寸 × dpr × 缩放 取，保证放大后线条依旧锐利
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
  // 已在册的缩放版本若与当前不符，先全部作废重建，保证位图分辨率随缩放刷新
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

// -- 绘制核心（布局 CSS 坐标存储：与缩放无关，缩放时按同一比例重绘，不漂移） --
// 注意：祖先有 transform:scale(F) 时，canvas 的位图坐标 → 页面布局坐标需再除以 F，
//       因为位图已按 (dpr × scale) 放大。
function squashPoint(p, s) { return { x: p.x / s, y: p.y / s }; }

function wordPointFromEvent(e, sec) {
  const r = sec.getBoundingClientRect();
  const s = wordScale || 1;
  // getBoundingClientRect 带缩放，除以 s 还原为布局 CSS 坐标
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
  // 位图缩放因子：dpr × 当前页面缩放（画布位图按此放大，故绘制时要乘回）
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
    // 已完成的历史笔画走 Path2D 缓存（避免每帧重建几万个 lineTo）
    let p = s._path;
    if (!p) {
      p = new Path2D();
      p.moveTo(pts[0].x * k, pts[0].y * k);
      for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x * k, pts[i].y * k);
      if (!s._drawing) s._path = p;   // 绘制中的笔画点数在变，不缓存
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

// 重绘节流：时间节流（最小 24ms）+ rAF 对齐，避免 pointermove 高频下每秒 60 次全量重绘
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

// -- 工具状态同步（按钮高亮 / 光标 / 防文本选中 / 提示） --
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

// -- 指针事件：按下定位所在页，move 累积，松开落库 --
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
    ensureWordCanvas(sec);   // 确保该页有画布（视口内必然已有，双保险）
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
    // 采样限制：单笔点数封顶 + 相邻点最小距离，防止长笔画点数爆炸导致重绘卡死
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

// -- 工具按钮 --
const wordPenBtn = document.getElementById('word-pen-btn');
if (wordPenBtn) wordPenBtn.addEventListener('click', function () { setWordTool('pen'); });
const wordHlBtn = document.getElementById('word-hl-btn');
if (wordHlBtn) wordHlBtn.addEventListener('click', function () { setWordTool('highlight'); });
const wordEraserBtn = document.getElementById('word-eraser-btn');
if (wordEraserBtn) wordEraserBtn.addEventListener('click', function () { setWordTool('eraser'); });

// -- 缩放按钮 --
const wordZoomInBtn = document.getElementById('word-zoom-in-btn');
if (wordZoomInBtn) wordZoomInBtn.addEventListener('click', wordZoomIn);
const wordZoomOutBtn = document.getElementById('word-zoom-out-btn');
if (wordZoomOutBtn) wordZoomOutBtn.addEventListener('click', wordZoomOut);

// -- Ctrl+滚轮缩放 / 普通滚轮沿用原生上下滚动 --
(function bindWordWheelZoom() {
  const el = document.getElementById('word-viewer-content');
  if (!el) return;
  el.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;          // 仅 Ctrl+滚轮，普通滚轮保持原生滚动阅读
    e.preventDefault();
    if (e.deltaY < 0) wordZoomIn(); else wordZoomOut();
  }, { passive: false });
})();

// -- Ctrl +/-/0 键盘缩放（与 PDF 阅读器一致的习惯） --
window.addEventListener('keydown', function (e) {
  if (!e.ctrlKey) return;
  const wrap = document.getElementById('word-viewer-wrap');
  if (!wrap || !wrap.classList.contains('show')) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); wordZoomIn(); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); wordZoomOut(); }
  else if (e.key === '0') { e.preventDefault(); wordZoomReset(); }
});

// -- 画笔颜色（限定 Word 查看器内） --
document.querySelectorAll('#word-viewer-wrap .pv-cdot').forEach(function (el) {
  el.addEventListener('click', function () {
    wordPenColor = el.dataset.c || wordPenColor;
    document.querySelectorAll('#word-viewer-wrap .pv-cdot').forEach(function (x) {
      x.classList.toggle('active', x === el);
    });
  });
});

// -- Esc 退出绘制模式 --
window.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && wordTool) setWordTool(null);
});

// -- 清除全部标注 --
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

// —— 打印当前 Word（隐藏 iframe 承载 docx 渲染结果 → 系统打印对话框；打印内容剔除标注画布） ——
function printWordDoc() {
  const content = document.getElementById('word-viewer-content');
  if (!content || !content.innerHTML || !content.innerHTML.trim()) {
    showTableError('Nothing available to print Word Content, Open a document first. ');
    return;
  }
  // 克隆后移除标注层，避免把标注/透明画布打印出来
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

// —— 打印按钮绑定 ——
const wordPrintBtn = document.getElementById('word-print-btn');
if (wordPrintBtn) wordPrintBtn.addEventListener('click', printWordDoc);

// ============================================================
// 测试数据管理（导入 Excel / 多层嵌套文件夹 / 多工作表展开）
// 结构：分组头右键「新建文件夹/导入 Excel」；文件夹右键「新建子文件夹/导入 Excel/重命名/删除」；
//       Excel 文件右键「打开/重命名/输出/删除」；多工作表文件展开列出各 sheet，双击打开对应 sheet
// ============================================================
const excelFileInput = document.getElementById('excel-file-input');
const subitemsTestData = document.getElementById('subitems-testdata');
const headerTestData = document.getElementById('header-testdata');
state.testData = state.testData || {};
let tdFileCounter = 0;
let tdFolderCounter = 0;
let pendingTestDataFolder = null;   // 右键记下要导入到哪个文件夹（null=根目录）
let pendingTdFolderNew = null;      // 右键记下在哪个文件夹下新建子文件夹（null=根目录）
let pendingRenameTdFolder = null;   // modal 重命名文件夹的目标 {node, cur}
let pendingRenameTdFile = null;     // modal 重命名文件的目标 {node, cur}
let tvShowFormula = false;          // 表格「显示公式」开关（跨标签记忆）

// 测试数据管理分组头右键
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

// —— 菜单：导入 Excel（分组头/文件夹右键） ——
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

// —— 菜单：新建文件夹（分组头右键 → 根目录；文件夹右键 → 该文件夹下新建子文件夹） ——
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

// —— 菜单：打开 Excel（文件右键，打开第一个工作表） ——
const ctxOpenExcel = document.getElementById('ctx-open-excel');
if (ctxOpenExcel) {
  ctxOpenExcel.addEventListener('click', (e) => {
    e.stopPropagation();
    const { type, target } = ctxContext;
    hideCtxMenu();
    if (type === 'testdata-file' && target) openExcelSheetByNode(target, null);
  });
}

// 生成测试数据文件夹节点（文件夹 + 空的文件容器）
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

// 新建测试数据文件夹（parentNode 为 null → 根目录；为文件夹节点 → 挂到该文件夹的 nested 容器）
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

// 重命名测试数据文件夹（modal 输入）
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

// 删除测试数据文件夹（级联清理子文件夹 + 文件，关闭已打开标签，释放 blob）
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

// 关闭某测试数据文件的所有已打开表格标签 + 清理 state + 释放 blob URL
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

// 创建测试数据文件节点（Excel 多工作表 → 带展开箭头 + sheet 子项；CSV/TXT → 普通节点）
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
    filePath: getFilePath(file),   // 原始文件路径（项目保存用）
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
  // 挂载位置：文件夹的 nested 容器（无则根目录）
  let target = subitemsTestData;
  if (folderNode) {
    const nested = folderNode.nextElementSibling;
    if (nested && nested.classList.contains('lp-nested-items')) target = nested;
  }
  target.appendChild(node);

  // 多工作表：展开列出每个 sheet 子项（双击打开对应工作表）
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

// 绑定测试数据管理内的文件夹 / 文件节点右键
function bindTestDataContextMenus(root) {
  if (!root) return;
  // 文件夹节点
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
  // 文件节点（多工作表文件带展开箭头）
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

// —— 文件选择：导入 Excel / CSV / TXT（右键文件夹时导入到该文件夹下） ——
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
          // Excel 类：完整解析（公式/合并/列宽/多工作表）
          const buf = await file.arrayBuffer();
  await ensureDocumentLibrary('excel');
          wb = await XLSX.read(buf, { type: 'array', cellDates: true });
        } else if (['csv', 'txt', 'tsv'].indexOf(ext) !== -1) {
          // 文本类：UTF-8 解析为二维数组
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

// 打开 Excel 文件（sheetName 为 null → 第一个工作表；CSV/TXT 直接打开）
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
  // 双击打开时确保工作表列表保持展开（双击过程 click 会切换两次展开状态）
  const nxt = fileNode.nextElementSibling;
  if (nxt && nxt.classList.contains('lp-nested-items') && !nxt.classList.contains('expanded')) {
    nxt.classList.add('expanded');
    fileNode.classList.remove('collapsed');
  }
  openTestDataTable(t, target);
}

// 打开测试数据表格标签页（标题：文件名-工作表名；同名标签已开则切换）
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

// —— 单元格显示整理（仅用于视觉展示）：超长小数/科学计数按合理精度显示 ——
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

// —— 官方 SheetJS 单元格日期 → 显示文本 ——
function fmtExcelDate(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  const y = d.getFullYear(), mo = d.getMonth() + 1, da = d.getDate();
  const h = d.getHours(), mi = d.getMinutes(), se = d.getSeconds();
  if (h === 0 && mi === 0 && se === 0) return y + '/' + mo + '/' + da;
  return y + '/' + mo + '/' + da + ' ' + p(h) + ':' + p(mi) + ':' + p(se);
}

// —— 官方 SheetJS 工作表 → 内部 v1.1.3 兼容结构 ——
// 官方 !merges / 单元格地址均为 0-based；内部渲染约定为：
//   rows[i]   == Excel 第 i+1 行（全空行保留为 []，含 !ref 之前的前导空行）
//   merges    行号 s.r/e.r 为 1-based、列 s.c/e.c 为 0-based
//   formulas  [Excel行号(1-based)] = { 列(0-based): 公式原文 }
//   cols      列宽数组（!cols，仅含显式设宽列）
// 结果缓存到 ws.__compatFull，供 buildTestDataTableHtml / getTestDataTableDims 复用。
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

// 判断某行「以数值为主」的比例（用于表头行自动定位）
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

// 生成测试数据表格 HTML（合并单元格 rowspan/colspan + 列宽 + 公式双信息）
// 数据来自 sheetToFullCompat（官方 SheetJS 兼容层）：rows[i] 恒等于 Excel 第 i+1 行（含空行），
// merges/formulas 亦用 1-based Excel 行号 → 二者严格对齐，表首空行不会引起错位。
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
  // 合并区回填：把左上角值复制到区域内所有空位（数据行内被合并覆盖的格取数一致）
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
  // 跳过表首连续空行（OOXML 省略全空 <row>，现补全为全空数组，显示时从首个有内容行开始）
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
  // 表头行自动定位（Excel 1-based 行）：
  // 1) 优先按「较高纵向合并带(≥3 行)」的首行定位数据区起点 → 其上方均为标题/表头；
  // 2) 无纵向合并带时，取第一条「数值占比 ≥ 50%」的行为数据区起点；
  // 3) 仍找不到则默认仅首条内容行为表头（兼容单行表头表）。
  const bandStarts = [];
  merges.forEach(m => { if (m.e.r > m.s.r && (m.e.r - m.s.r + 1) >= 3) bandStarts.push(m.s.r); });
  let dataStartRow = bandStarts.length ? Math.min.apply(null, bandStarts) : 0;
  if (!dataStartRow) {
    for (let i = firstIdx; i < data.length; i++) {
      if (excelRowNumericRatio(data[i]) >= 0.5) { dataStartRow = i + 1; break; }
    }
  }
  if (!dataStartRow) dataStartRow = firstIdx + 2;   // 首条内容行为表头
  // 合并单元格跳过集合（除左上角外均不输出 td，由左上角以 rowspan/colspan 覆盖）
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
  // 列宽：wch（字符宽度）→ 像素近似
  const px = (wch) => Math.max(40, Math.round((wch || 8) * 7.2));
  const maxC = data.reduce((m, row) => Math.max(m, row ? row.length : 0), 0);
  const lastExcelRow = data.length;   // rows 保留全部行号 → data.length == __maxRow
  let html = '<table>';
  for (let excelRow = firstIdx + 1; excelRow <= lastExcelRow; excelRow++) {
    const row = data[excelRow - 1] || [];
    // 本行若被上方 rowspan 覆盖且无自有可见内容 → 不输出 <tr>，保持纵向合并紧凑
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

// 表格尺寸 / 是否含公式（用于标签页信息与公式开关显示）
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

// —— 测试数据文件重命名（modal 输入；同步已打开标签标题） ——
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
  // 同步已打开的表格标签标题（多 sheet：新文件名-工作表名；单 sheet：新文件名）
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

// —— 测试数据文件输出（下载原始文件） ——
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

// —— 测试数据文件删除（确认后删除节点 + 记录 + 关闭已打开标签） ——
function deleteTestDataFileNode(fileNode) {
  const id = fileNode.getAttribute('data-testdata-id');
  const t = state.testData[id];
  const name = t ? t.fileName : 'This file';
  if (!confirm('Delete this file?“ ' + name + ' ”??')) return;
  closeTestDataFileTags(fileNode);
  fileNode.remove();
}

// —— 表格「显示公式」开关（计算结果 ↔ 公式原文，含公式的表格才显示按钮） ——
const tvFormulaBtn = document.getElementById('tv-formula-btn');
if (tvFormulaBtn) {
  tvFormulaBtn.addEventListener('click', () => {
    tvShowFormula = !tvShowFormula;
    tvFormulaBtn.classList.toggle('on', tvShowFormula);
    tvFormulaBtn.textContent = tvShowFormula ? 'Show values' : 'Show formulas';
    applyFormulaView(tvShowFormula);
  });
}

// 按开关状态切换表格内容中所有公式单元格的显示
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
// PDF 阅读渲染核心（pdf.js v3.11.174）
// 说明：pdf.min.js / pdf.worker.min.js 为本地离线文件，需放置于 lib/pdfjs/ 目录；
//       缺失时 PDF 标签显示提示，不影响其余功能。
// ============================================================
let pdfDoc = null;          // 当前 PDF 文档对象
let pdfPageNum = 1;         // 当前页码
let pdfScale = 1.5;         // 缩放比例（提升默认清晰度）
let pdfRenderTask = null;   // 渲染任务（用于取消）
let pdfLoadGeneration = 0;
let currentPdfUrl = '';     // 当前已加载的 PDF URL（避免重复解析）
let pdfAutoScrollBottom = false; // 翻到上一页后待渲染完成滚动到页面底部（滚轮连续阅读）
let pdfWheelLock = 0;       // 滚轮翻页节流时间戳（毫秒）
const PDF_WHEEL_THROTTLE = 300; // 相邻翻页最小间隔（防滚轮连滚一次翻多页）
let pdfAnnots = {};         // 标注数据：{页码: [{type,color,width,points}]}，坐标为页面单位（未缩放）
let pdfTool = null;         // 当前标注工具：'pen' | 'highlight' | 'eraser' | null
let pdfPenColor = '#e24b4a';// 画笔颜色
let pdfDrawing = null;      // 绘制中的笔画
let pdfRedrawPending = false; // rAF 节流标记

function pdfReady() {
  return !!(window.pdfjsLib && pdfDoc);
}

// ============================================================
// 阅读页右键：选中文字 → 添加标签（PDF 靠文字层，Word 天然可选中）
// ============================================================
let docCtxMenuEl = null;
let lastSelText = '';      // contextmenu 时刻缓存的选中文本（点击菜单项时选区可能已被清掉）

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
      navigator.clipboard.writeText(q).catch(function () { /* 无剪贴板权限时忽略 */ });
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
// PDF 文字层（pdf.js 3.11 的 renderTextLayer）
// 作用：canvas 本身没有文字信息，加上这层透明文字后即可「选中 / 复制 / 右键打标签」
// 层叠：画布 < 文字层(z-index:1) < 标注层(z-index:20)
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
    try { if (pdfTextLayerTask.cancel) pdfTextLayerTask.cancel(); } catch (e) { /* 忽略 */ }
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
  // ★ 与画布严格对齐：文字层左上角锚定到画布左上角，尺寸用 CSS 尺寸（不乘 dpr）
  alignPdfTextLayerToCanvas();
  if (typeof pdfjsLib === 'undefined' || !pdfjsLib || typeof pdfjsLib.renderTextLayer !== 'function') return;
  const p = perfBegin('PDF Text layer rendering');
  try {
    // 优先用流式接口（v3 推荐），旧版回退到一次性 getTextContent
    const src = (typeof page.streamTextContent === 'function') ? page.streamTextContent() : (await page.getTextContent());
    pdfTextLayerTask = pdfjsLib.renderTextLayer({
      textContentSource: src,
      container: layer,
      viewport: viewport,
      textDivs: []
    });
    await pdfTextLayerTask.promise;
    pdfTextLayerTask = null;
    // 渲染完成后再对齐一次：pdf.js 会写入 width/height，尺寸就绪后重新锚定
    alignPdfTextLayerToCanvas();
  } catch (e) {
    if (!e || e.name !== 'RenderingCancelledException') console.warn('[PDF Text layer]', e);
  }
  perfEnd(p, layer.childNodes.length + ' text nodes');
  syncPdfTextLayerPointer();
}

// 让文字层与 PDF 画布像素级重合（画布由 flex 居中，文字层用相同 left/top/size 锚定）
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
  // 首页渲染完成 → 提取大纲（上下文仍是本文档才生效）
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
    // 高 DPI 屏增强：CSS 尺寸 = 原 viewport 尺寸，物理像素 = CSS × dpr
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
    // 文字层：尺寸与画布 CSS 尺寸一致，保证选区与画面严格对齐
    await renderPdfTextLayer(page, cssViewport);
  } catch (e) {
    if (e && e.name !== 'RenderingCancelledException') {
      console.warn('[PDF Render]', e);
    }
  }
  // 渲染完成后：标注等比重绘 + 滚动定位（翻上一页的连续阅读滚到底，其余回页首）
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

// 文字层状态可见反馈：避免「选不中文字」时用户只能判定「点了没反应」
function updatePdfTextLayerHint() {
  const hint = document.getElementById('pdf-tool-hint');
  const layer = document.getElementById('pdf-text-layer');
  if (!hint || !layer) return;
  // 绘制工具激活时，提示让位给工具说明（由 syncPdfAnnotState 接管）
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

// 工具栏按钮绑定
const pdfPrevBtn = document.getElementById('pdf-prev-btn');
if (pdfPrevBtn) pdfPrevBtn.addEventListener('click', pdfPrevPage);
const pdfNextBtn = document.getElementById('pdf-next-btn');
if (pdfNextBtn) pdfNextBtn.addEventListener('click', pdfNextPage);
const pdfZoomInBtn = document.getElementById('pdf-zoom-in-btn');
if (pdfZoomInBtn) pdfZoomInBtn.addEventListener('click', pdfZoomIn);
const pdfZoomOutBtn = document.getElementById('pdf-zoom-out-btn');
if (pdfZoomOutBtn) pdfZoomOutBtn.addEventListener('click', pdfZoomOut);

// ============================================================
// PDF 滚轮翻页 / Ctrl+滚轮缩放 / 涂鸦·高亮·橡皮标注
// 说明：标注按页存储于 pdfAnnots（页面单位坐标），缩放时等比重绘不漂移；
//       橡皮擦用 destination-out 真正抠除，不影响底层 PDF 内容。
// ============================================================

// -- 工具状态同步（按钮高亮 / 光标 / 指针拦截 / 提示文字） --
function syncPdfAnnotState() {
  const ac = document.getElementById('pdf-annot-canvas');
  if (!ac) return;
  ac.style.pointerEvents = pdfTool ? 'auto' : 'none';
  ac.style.cursor = pdfTool === 'eraser' ? 'cell' : 'crosshair';
  // 文字层随工具状态让位：画笔激活时不可选文字，否则可选中复制
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

// -- 标注绘制核心 --
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
  ac.width = pc.width;   // 物理像素（已含 dpr）
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

// -- 标注画布事件 --
const pdfAnnotCanvas = document.getElementById('pdf-annot-canvas');
if (pdfAnnotCanvas) {
  pdfAnnotCanvas.addEventListener('pointerdown', onPdfAnnotDown);
  pdfAnnotCanvas.addEventListener('pointermove', onPdfAnnotMove);
  window.addEventListener('pointerup', onPdfAnnotUp);
}

// -- 滚轮：Ctrl+滚轮 = 缩放；页面未超高 = 直接翻页；
//    页面超高（放大后）= 原生滚动看局部，滚到底/顶后继续滚自动切下一页/上一页（边界续页，连续阅读不断档）--
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
      // 页面未超高：滚轮直接翻页（加节流，防滚轮连滚一次翻多页）
      e.preventDefault();
      if (now - pdfWheelLock < PDF_WHEEL_THROTTLE) return;
      pdfWheelLock = now;
      if (e.deltaY < 0) pdfPrevPage(); else pdfNextPage();
      return;
    }
    // 页面超高：优先原生滚动看局部；仅在到达边界且继续滚时翻页
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
      pdfAutoScrollBottom = true; // 上一页渲染完成后滚到底，模拟向上连续阅读
      pdfPrevPage();
    }
    // 其它位置：不拦截，交给原生滚动
  }, { passive: false });
}

// -- Esc 退出绘制模式 --
window.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && pdfTool) setPdfTool(null);
});

// -- 工具按钮 --
const pdfPenBtn = document.getElementById('pdf-pen-btn');
if (pdfPenBtn) pdfPenBtn.addEventListener('click', function () { setPdfTool('pen'); });
const pdfHlBtn = document.getElementById('pdf-hl-btn');
if (pdfHlBtn) pdfHlBtn.addEventListener('click', function () { setPdfTool('highlight'); });
const pdfEraserBtn = document.getElementById('pdf-eraser-btn');
if (pdfEraserBtn) pdfEraserBtn.addEventListener('click', function () { setPdfTool('eraser'); });

// -- 画笔颜色（限定在 PDF 查看器内，避免误绑 Word 查看器色点） --
document.querySelectorAll('#pdf-viewer-wrap .pv-cdot').forEach(function (el) {
  el.addEventListener('click', function () {
    pdfPenColor = el.dataset.c || pdfPenColor;
    document.querySelectorAll('#pdf-viewer-wrap .pv-cdot').forEach(function (x) {
      x.classList.toggle('active', x === el);
    });
  });
});

// -- 清除全部标注 --
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
// 钻孔数据三维可视化
// 数据来源：项目树"钻孔"分组下导入的 孔口表格 / 钻孔测斜 / 地质信息(岩性)
// 触发方式：拖拽"钻孔"分组标题到三维画布
// 坐标转换：与 .ts 模型一致（GOCAD 真实坐标 → Three.js）
//   Three.X = GOCAD_X - ox  (东)
//   Three.Y = GOCAD_Z - oz  (高程)
//   Three.Z = oy - GOCAD_Y  (北，取反)
// 轨迹计算：直线法（每孔 1 条测斜记录）
//   dip: 0°=水平, 90°=垂直向下；azimuth: 从北顺时针
//   方向向量(GOCAD): dx=sin(az)·cos(dip), dy=cos(az)·cos(dip), dz=-sin(dip)
// ============================================================

// ============================================================
// 岩性颜色：黄金角分布 HSL（137.5° 步进），保证每种岩性颜色差异最大化且鲜艳可辨
// 颜色纯自由定义，存储于 state.lithologyColors（跨模型持久化），不绑定模型
// ============================================================

// HSL → hex 字符串
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
}

// 黄金角随机色：index → hex（S=70%, L=55% 保证鲜艳可辨）
function goldenAngleColor(index) {
  const h = (index * 137.5) % 360;
  return hslToHex(h, 70, 55);
}

// hex 字符串 → 数字（如 '#a3e635' → 0xa3e635）
function hexToInt(hex) {
  return parseInt(hex.replace('#', ''), 16);
}

// 获取岩性颜色：若 state.lithologyColors 未设置则按黄金角分配并缓存
function ensureLithologyColor(name) {
  if (!state.lithologyColors) state.lithologyColors = {};
  if (state.lithologyColors[name]) return state.lithologyColors[name];
  const idx = Object.keys(state.lithologyColors).length;
  const hex = goldenAngleColor(idx);
  state.lithologyColors[name] = hex;
  return hex;
}

const DEFAULT_LITHOLOGY_COLOR = 0x3498DB;    // 未识别岩性兜底色（一般不使用）

// 从项目树收集钻孔分类下已导入的表格文件（按分类名匹配）
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
    // 地球化学属性子类别：按 attrClean 收集
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

// 表头字段查找（支持中英文/别名，大小写不敏感）
function findColumnIndex(headers, candidates) {
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i]).trim().toLowerCase();
    for (const c of candidates) {
      if (h === c.toLowerCase() || h.indexOf(c.toLowerCase()) >= 0) return i;
    }
  }
  return -1;
}

// 解析孔口表 → [{holeid, x, y, z, depth}]
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

// 解析测斜表 → [{holeid, depth, dip, azimuth}]
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

// 解析岩性表 → [{holeid, from, to, vein}]
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

// 解析地球化学属性表 → [{holeid, from, to, value}]
//   子表列顺序为 holeid/from/to/属性值；属性值列可通过 geochemAttrName 或最后一列定位
function parseGeochemAttrTable(table) {
  if (!table || !table.data || table.data.length < 2) return [];
  const headers = table.data[0] || [];
  const iHole = findColumnIndex(headers, ['holeid', 'hole_id', '孔号']);
  const iFrom = findColumnIndex(headers, ['from', '起', '起始']);
  const iTo = findColumnIndex(headers, ['to', '止', '终止']);
  // 优先用 geochemAttrName 查找数值列；找不到则用最后一列（子表结构固定）
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

// GOCAD → Three.js 坐标转换
function gocadToThree(gx, gy, gz, ox, oy, oz) {
  return new THREE.Vector3(gx - ox, gz - oz, oy - gy);
}

// 钻孔方向向量（Three.js 坐标系，单位向量）
// dip: 0°=水平, 90°=垂直向下；azimuth: 从北顺时针
function drillholeDirection(dip, azimuth) {
  const dipRad = THREE.MathUtils.degToRad(dip);
  const azRad = THREE.MathUtils.degToRad(azimuth);
  // GOCAD 方向：东=+X, 北=+Y, 上=+Z
  const gx = Math.sin(azRad) * Math.cos(dipRad);
  const gy = Math.cos(azRad) * Math.cos(dipRad);
  const gz = -Math.sin(dipRad); // 向下为负
  // 转 Three.js：dThree.X=gx, dThree.Y=gz, dThree.Z=-gy
  return new THREE.Vector3(gx, gz, -gy).normalize();
}

// 创建圆柱体段（从 start 到 end）
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
  // 默认沿 Y 轴，旋转到 dir 方向
  const up = new THREE.Vector3(0, 1, 0);
  mesh.quaternion.setFromUnitVectors(up, dir.clone().normalize());
  // 起点对齐：圆柱默认中心在原点，先平移到起点，再沿局部 Y(=dir) 上移 len/2
  mesh.position.copy(start);
  mesh.translateY(len / 2);
  // 存储原始几何参数，用于后续改粗细时重建几何体
  mesh.userData.segStart = start.clone();
  mesh.userData.segEnd = end.clone();
  mesh.userData.segLen = len;
  return mesh;
}

// 构建钻孔轨迹 Group
// options.useLithology: true=按岩性 from→to 分段着色（黄金角随机色）；false=整孔单色蓝色（不按岩性分段）
// options.useGeochem: true=按地球化学属性数值大小映射 diverging 色阶；此时需传 geochemAttrs + colormapStops
function buildDrillholeGroup(collars, surveys, lithologies, origin, radius, options) {
  const useLithology = !!(options && options.useLithology);
  const useGeochem = !!(options && options.useGeochem);
  const singleColor = (options && options.singleColor !== undefined) ? options.singleColor : 0x1E88E5; // 默认蓝色
  const colormapStops = (options && options.colormapStops) || GEOCHEM_DIVERGING_STOPS;
  const group = new THREE.Group();
  group.name = useGeochem ? 'drillhole-geochem-group' : (useLithology ? 'drillhole-litho-group' : 'drillhole-survey-group');
  const materials = [];
  const lithoTypes = {}; // vein → color（用于图例 + 颜色面板）
  const ox = origin.x, oy = origin.y, oz = origin.z;

  // 测斜 / 岩性 / geochem 按 holeid 索引
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
      // 单色蓝色：整孔一段圆柱
      const p2 = start.clone().add(dir.clone().multiplyScalar(totalDepth));
      const m = createSegmentCylinder(start, p2, radius, singleColor, 0.95);
      if (m) { m.userData.isDrillhole = true; m.userData.holeid = collar.holeid; m.userData.vein = null; group.add(m); materials.push(m.material); segCount++; }
      return;
    }

    // —— Geochem 模式：按属性数值大小映射颜色 ——
    if (useGeochem) {
      const segs = geochemMap[collar.holeid] || [];
      if (segs.length === 0) {
        // 本表无记录：整孔按最小值颜色（兜底）
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

    // 按岩性分段
    const segs = lithoMap[collar.holeid] || [];
    if (segs.length === 0) {
      // 有岩性表但本孔无记录：整孔兜底色
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
// 钻孔轨迹三维可视化（内部共享构建器）
//   mode='survey'    : 仅孔口+测斜，单色蓝色轨迹（不按岩性分段）
//   mode='lithology' : 孔口+测斜+岩性，按岩性分段着色（黄金角随机色），支持颜色面板
//   mode='geochem'   : 孔口+测斜+地球化学属性，按数值大小映射 diverging 色阶
//   lithoSource='lithology'(默认,地质信息) | 'alteration'(蚀变信息) — 显示逻辑一致，仅数据源不同
//   geochemAttrName  : mode='geochem' 时传属性清洗名（如 'Au'）
// 触发：拖拽项目树对应分类节点到三维画布
// ============================================================
function buildDrillholeModel(mode, lithoSource, geochemAttrName) {
  const useLithology = (mode === 'lithology');
  const useGeochem = (mode === 'geochem');
  const isAlteration = (lithoSource === 'alteration');
  // 1. 收集表格
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

  // 2. 解析
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

  // 3. 原点：优先复用当前标签页的 state.origin，否则用孔口坐标自动计算并写入 state.origin
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

  // 4. 计算圆柱半径（参考场景包围盒或孔口范围，保证可见且协调）
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

  // 5. 移除同类别已有模型（防重复，并释放几何/材质内存）
  //   survey    → '钻孔测斜'
  //   lithology → '钻孔蚀变' / '钻孔岩性'
  //   geochem   → '钻孔地球化学_属性名'（每个属性独立图层）
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

  // 6. 构建轨迹网格
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

  // 7. 添加到场景（移除占位）
  scene.add(group);
  applyIgnoredDrillholes(); // 应用"忽略"复选框状态（隐藏被忽略的钻孔）
  if (state.placeholderMesh) {
    scene.remove(state.placeholderMesh);
    state.placeholderMesh.geometry.dispose();
    state.placeholderMesh.material.dispose();
    state.placeholderMesh = null;
    const _ep = document.getElementById('empty-placeholder');
    if (_ep) _ep.classList.add('hidden');
  }

  // 8. 注册为模型（复用图层管理 / 透明度 / 剖切 / 坐标轴）
  const lithoList = Object.keys(lithoTypes).map(name => ({ name: name, color: lithoTypes[name] }));
  let displayName;
  let modelColor;
  if (useGeochem) {
    displayName = 'Drillhole Geochemistry· ' + geochemAttrRawName;
    modelColor = geochemColorInt(0.5, colormapStops); // 图例中间色
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
    geochemAttrName: geochemAttrName,    // geochem 属性清洗名（如 'Au'）
    geochemAttrRawName: geochemAttrRawName, // geochem 原始属性名（如 'Au(×10^-6)'）
    geochemMin: buildResult.geochemMin,  // geochem 数值范围（图例）
    geochemMax: buildResult.geochemMax,
    lithologyTypes: lithoList,
    drillholeCount: holeCount
  };
  state.models.push(modelObj);

  // 若剖切模式开启，对钻孔段材质应用当前剖切平面
  if (state.clipMode) {
    const planes = getActiveClipPlanes();
    materials.forEach(mt => {
      mt.clippingPlanes = planes;
      mt.clipShadows = planes.length > 0;
      mt.needsUpdate = true;
    });
  }

  // 9. 图层 + 图例 + 坐标轴 + 相机
  addLayerItem(modelObj);
  updateLegend();
  updateRenderOrder();
  buildAxisLabels();
  fitViewToAll();

  console.log('[' + displayName + ' ] Visualization complete: ' + holeCount + ' drillholes, ' + segCount + ' intervals, Radius=' + radius.toFixed(2));
}

// —— 互斥检查：显示某类钻孔模型时与其他类型互斥 ——
// 规则：
//   1. 地球化学与「地质/蚀变」互斥（不同的分段着色体系）
//   2. 不同地球化学属性（Au vs Ag vs S）之间互斥（一次只能显示一个属性的渐变）
// 返回: true=可继续显示；false=用户取消操作
function checkDrillholeMutex(type, attrName) {
  // 构造"将被排除"的模型列表
  const toRemove = [];
  state.models.forEach(m => {
    if (!m.inScene) return;
    if (type === 'geochem') {
      // 新显示地球化学：移除所有钻孔岩性/蚀变 + 其他 geochem 属性
      if (m.isLithologyDrillhole) toRemove.push(m);
      if (m.isGeochemDrillhole && m.geochemAttrName !== attrName) toRemove.push(m);
    } else if (type === 'lithology' || type === 'alteration') {
      // 新显示地质/蚀变：移除所有 geochem 钻孔
      if (m.isGeochemDrillhole) toRemove.push(m);
    }
  });
  if (toRemove.length === 0) return true;

  // 构造弹窗提示
  const removedNames = toRemove.map(m => '· ' + m.fileName).join('\n');
  let warnMsg;
  if (type === 'geochem') {
    warnMsg = 'Geochemical Attributes ( ' + (attrName || '') + ' ) uses a continuous numeric color scale, must not overlap“Drillhole Lithology / Drillhole Alteration / Other geochemical attributes”Show together. \n\n Remove the following items from the 3D view: \n' + removedNames + '\n\n Continue??';
  } else {
    warnMsg = '「' + (type === 'alteration' ? 'Drillhole Alteration' : 'Drillhole Lithology') + ' ”uses discrete category colors, must not overlap“Drillholes colored by geochemical attributes”Show together. \n\n Remove the following items from the 3D view: \n' + removedNames + '\n\n Continue??';
  }
  const ok = confirm(warnMsg);
  if (!ok) return false;
  // 用户确认 → 移除被互斥的模型
  toRemove.forEach(m => removeModelFromView(m));
  return true;
}

// 拖拽"钻孔测斜"分类 → 单色蓝色轨迹（不按岩性分段）
function visualizeSurveyOnly() { buildDrillholeModel('survey'); }

// 拖拽"地质信息"分类 → 轨迹 + 按岩性分段着色（黄金角随机色）+ 颜色面板
function visualizeLithologyDrillholes() {
  if (!checkDrillholeMutex('lithology')) return;
  buildDrillholeModel('lithology');
}

// 拖拽"蚀变信息"分类 → 显示逻辑与地质信息一致（按 vein 分段着色 + 🎨 + ⚙️），仅数据源不同
function visualizeAlterationDrillholes() {
  if (!checkDrillholeMutex('alteration')) return;
  buildDrillholeModel('lithology', 'alteration');
}

// 拖拽地球化学属性子类别 → 按属性数值大小映射 diverging 色阶 + 渐变图例 + 色阶设置
function visualizeGeochemDrillholes(attrClean, attrRawName) {
  if (!checkDrillholeMutex('geochem', attrClean)) return;
  buildDrillholeModel('geochem', null, attrClean);
}

// ============================================================
// 钻孔孔口位置可视化（仅显示孔口点 + holeid 名称标签）
// 触发方式：拖拽项目树"孔口表格"分类节点到三维画布
// ============================================================
function visualizeCollarPoints() {
  // 1. 收集孔口表
  const tables = collectDrillholeTables();
  if (!tables.collar) {
    showTableError('Collar table not found. \n First, in"Drillholes"Right-click under the group"Collar Table"Import collar data (Includes holeid/x/y/z Field) . ');
    return;
  }

  // 2. 解析
  const collars = parseCollarTable(tables.collar);
  if (collars.length === 0) {
    showTableError('The collar table could not be parsed or is empty. \n Check the column headers (must include holeid/x/y/z) . ');
    return;
  }

  // 3. 原点：优先复用当前标签页的 state.origin，否则用孔口坐标自动计算并写入 state.origin
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

  // 4. 计算孔口点半径 / 标签尺寸（参考场景包围盒或孔口范围）
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

  // 5. 移除已有孔口点（防重复，并释放几何/材质内存）
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

  // 6. 构建孔口点 Group（小球 + holeid 标签）
  const group = new THREE.Group();
  group.name = 'collar-points-group';
  const materials = [];
  const pointColor = 0xE53935; // 红色孔口点

  collars.forEach(c => {
    const p = gocadToThree(c.x, c.y, c.z, origin.x, origin.y, origin.z);
    // 孔口小球
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
    // holeid 名称标签（始终面向相机，不被遮挡）
    const label = makeLabelSprite(c.holeid, labelScale, '#1565C0');
    label.position.copy(p).add(new THREE.Vector3(0, pointRadius * 2.4, 0));
    label.material.depthTest = false;
    label.renderOrder = 999;
    // 存储标签元数据，用于改字体颜色时重建 texture
    label.userData.isCollarLabel = true;
    label.userData.holeid = c.holeid;
    label.userData.labelScale = labelScale;
    label.userData.basePos = p.clone();
    label.userData.offsetY = pointRadius * 2.4;
    group.add(label);
  });

  // 7. 添加到场景（移除占位）
  scene.add(group);
  applyIgnoredDrillholes(); // 应用"忽略"复选框状态（隐藏被忽略的孔口点）
  if (state.placeholderMesh) {
    scene.remove(state.placeholderMesh);
    state.placeholderMesh.geometry.dispose();
    state.placeholderMesh.material.dispose();
    state.placeholderMesh = null;
    const _ep = document.getElementById('empty-placeholder');
    if (_ep) _ep.classList.add('hidden');
  }

  // 8. 注册为模型（复用图层管理 / 透明度 / 剖切 / 坐标轴）
  const modelObj = {
    id: 'collar_' + Date.now(),
    name: 'Drillhole Collars',
    category: 'Drillhole Collars',
    mesh: group,
    material: materials[0],
    materials: materials,           // 全部小球材质（透明度/颜色/剖切）
    visible: true,
    opacity: 0.95,
    color: pointColor,
    labelColor: '#1565C0',          // holeid 标签字体颜色（可自定义）
    pointRadius: pointRadius,       // 孔口小球半径（用于偏移计算）
    labelScale: labelScale,         // 标签缩放
    fileName: 'Drillhole Collars',
    geoMesh: { origin: origin },
    treeFileNode: null,
    inScene: true,
    isCollarPoints: true,
    drillholeCount: collars.length
  };
  state.models.push(modelObj);

  // 若剖切模式开启，对孔口小球材质应用当前剖切平面
  if (state.clipMode) {
    const planes = getActiveClipPlanes();
    materials.forEach(mt => {
      mt.clippingPlanes = planes;
      mt.clipShadows = planes.length > 0;
      mt.needsUpdate = true;
    });
  }

  // 9. 图层 + 图例 + 坐标轴 + 相机
  addLayerItem(modelObj);
  updateLegend();
  updateRenderOrder();
  buildAxisLabels();
  fitViewToAll();

  console.log('[Drillhole Collars] Visualization complete:  ' + collars.length + ' collar points, Radius=' + pointRadius.toFixed(2));
}

// ============================================================
// 点图层：左侧「点」分类 → 右键导入点文件（孔口表格式）
// 渲染为独立图层（孔口小球 + 孔号标签），支持按属性（高程/品位）着色，可持久化
// 复用孔口点渲染与图层管理，但每个点文件是「独立图层」，与钻孔孔口互不干扰
// ============================================================
const POINT_PALETTE = [0xE85D75, 0x2ECC71, 0xF39C12, 0x9B59B6, 0x1ABC9C, 0xE74C3C, 0x3498DB];
let pointPaletteIdx = 0;

const headerPoint = document.getElementById('header-point');
const subitemsPoint = document.getElementById('subitems-point');
const pointFileInput = document.getElementById('point-file-input');
let pendingPointCategory = null;
state.pointLayers = state.pointLayers || {};
// 当前「点绘制」的目标类别 id（右键某个点类别 → 点绘制时写入）
let activePointLayerId = null;
// 类别顺序（保证空类别也有稳定次序，并持久化）
state.pointOrder = state.pointOrder || [];

// —— 点类别：属性列默认空白，由第一个点定型（列名可自定义） ——
// 固定几何列（不参与自定义）：孔号 / X / Y / Z
// ★ 第 62 节：depth（孔深）已整体移除 —— 点类别不再有孔深字段。
//   旧项目里第 5 列的 depth 会自动归入自定义属性列（可编辑、可删），不再特殊对待。
const POINT_BASE_HEADERS = ['holeid', 'x', 'y', 'z'];
const POINT_BASE_LABELS = { holeid: 'Hole ID', x: 'Easting X', y: 'Northing Y', z: 'Elevation Z' };

// ★ 第 64 节：固定几何列的判定统一走「列名」而非「列位置」。
//   历史问题：表格编辑器按位置判断（c < 4 视为几何列），而数据层
//   （parseCollarTable / derivePointCollarAttrs）按列名匹配。两者口径不一致 →
//   导入文件的列序只要不是 holeid,x,y,z 打头，就会出现：
//     · 改名/删除✕ 挂到错误的列（几何列被当属性列，反之亦然）
//     · 用户删列后 rows 与 headers 列序语义错位
//     · 保存时 autoCols = headers.slice(4) 切错位置
//     · 重启后按列名找不到几何列 → collars 为空、坐标归零
//   下面这组函数是唯一判定入口，表格/属性面板/列操作都必须调用它们。
//   接受「列名」或「列名+列表」两种入参，兼容既有调用写法。
function _pointGeoNameList(headers) {
  return Array.isArray(headers) ? headers : POINT_BASE_HEADERS;
}
// 判断某一列名是否属于固定几何列（按列名，大小写不敏感，兼容中文别名）
function isPointGeoHeader(name) {
  const n = String(name == null ? '' : name).trim().toLowerCase();
  if (!n) return false;
  return ['holeid', 'hole_id', '孔号', '钻孔号', 'x', 'east', '东坐标', '东',
          'y', 'north', '北坐标', '北', 'z', 'elevation', '高程', '标高'].indexOf(n) >= 0;
}
// 判断第 c 列是否为固定几何列（按该列的表头名判定）
function isPointGeoCol(headers, c) {
  const hd = _pointGeoNameList(headers);
  return isPointGeoHeader(hd[c]);
}
// 统计固定几何列有多少列（按列名）
function countPointGeoCols(headers) {
  const hd = _pointGeoNameList(headers);
  let n = 0;
  for (let i = 0; i < hd.length; i++) { if (isPointGeoHeader(hd[i])) n++; }
  return n;
}
// 列出所有自定义属性列的列下标（非几何列）
function pointCustomColIndexes(headers) {
  const hd = _pointGeoNameList(headers);
  const out = [];
  for (let i = 0; i < hd.length; i++) { if (!isPointGeoHeader(hd[i])) out.push(i); }
  return out;
}
// 列出所有自定义属性列的表头名
function pointCustomColNames(headers) {
  const hd = _pointGeoNameList(headers);
  return pointCustomColIndexes(hd).map(i => String(hd[i] == null ? '' : hd[i]).trim()).filter(Boolean);
}
// ★ 第 64 节：把几何列重排到最前、属性列保持原相对顺序。
//   返回全新的 { headers, rows }（不改动入参）。
//   作用：① 让 autoCols 的取值不再依赖「前 4 列」这一脆弱假设；
//         ② 让下游渲染/导出的「前 N 列是几何列」位置约定重新成立；
//         ③ 消除导入文件列序不标准时表格与数据层的口径分歧。
function normalizePointColumnOrder(headers, rows) {
  const hd = (headers || []).slice();
  const rs = (rows || []).map(r => r.slice());
  const geoNames = ['holeid', 'x', 'y', 'z'];
  const geoIdx = [], taken = new Set(), outHeaders = [], map = [];
  // ① 几何列：按 holeid → x → y → z 的固定次序（便于下游按位置读取）
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
  // ② 其余列按原相对顺序追加
  for (let i = 0; i < hd.length; i++) {
    if (taken.has(i)) continue;
    taken.add(i); map.push(i); outHeaders.push(hd[i]);
  }
  // ③ 行按同一映射重排，并按新表头宽度补齐/截断
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

// ★ 生成不重复的默认点类别名（与线类别同因同治，见 makeUniqueLineCategoryName 的说明）
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

// 新建一个空白点类别（不含数据、不含属性列）
function createPointCategory(name, opts) {
  opts = opts || {};
  const id = opts.id || makePointCategoryId();
  const origin = state.origin || { x: 0, y: 0, z: 0 };
  // ★ 最后一道防线：名字去重（工程恢复时 opts.id 已给定，此时沿用原名，避免把快照里的名字改掉）
  const wanted = (name && name.trim()) ? name.trim() : 'New point category';
  const finalName = opts.id ? wanted : makeUniquePointCategoryName(wanted);
  const layer = {
    id: id, name: finalName, regionId: window.researchRegions?.currentId, fileName: '', filePath: null,
    headers: POINT_BASE_HEADERS.slice(),   // 初始只有固定几何列，属性列空
    rows: [], data: [],
    collars: [], attrs: {},
    origin: { x: origin.x, y: origin.y, z: origin.z },
    color: POINT_PALETTE[pointPaletteIdx++ % POINT_PALETTE.length],
    colorAttr: null, colorScheme: 'blue-red',
    isEmptyCategory: true,   // 标记：尚未落任何点
    autoCols: [],            // 第一个点定型出的自定义属性列名（严格沿用）
    colsLocked: false        // 是否已锁定列结构
  };
  state.pointLayers[id] = layer;
  if (state.pointOrder.indexOf(id) < 0) state.pointOrder.push(id);
  addPointNode(layer);
  // 新建即设为当前绘制目标，避免用户"建了类别却无处绘制"
  activePointLayerId = id;
  return layer;
}

// 删除点类别（含其场景对象与顺序表）
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

// 取当前绘制目标类别：优先右键选中的，其次唯一类别，否则返回 null
function getActivePointCategory() {
  if (activePointLayerId && state.pointLayers[activePointLayerId]) return state.pointLayers[activePointLayerId];
  return null;
}

// —— 颜色梯度工具 ——
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

// —— 读取单个工作表 → 二维数组（表头+数据行） ——
function sheetToRows(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
}

// —— ★ 多工作表选择（第 61 节）——
// 约定：Excel 有 **1 个**工作表 → 完全不打扰用户，直接返回，行为与改动前一致。
//       有 **≥2 个** → 弹下拉框让用户挑一个；用户选「跳过此文件」则返回 null。
// 返回：Promise<{ rows, sheetName } | null>
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
      // 兜底：DOM 缺失时退回旧行为（第一个工作表），不阻断导入
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

// —— 读取点文件 → 二维数组（表头+数据行） ——
// Excel 多表时返回 { rows, sheetName }；单表 / CSV 时 sheetName 为空串。
async function readPointFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (EXCEL_EXTS.indexOf(ext) !== -1) {
    await ensureDocumentLibrary('excel');if (typeof checkXlsxAvailable !== 'function' || !checkXlsxAvailable()) throw new Error('Excel Parsing library (SheetJS) Not loaded, Save the file as CSV then import');
    const buf = await file.arrayBuffer();
  await ensureDocumentLibrary('excel');
    const wb = await XLSX.read(buf, { type: 'array', cellDates: true });
    if (!wb.SheetNames || !wb.SheetNames.length) throw new Error('Worksheet not found');
    // ★ 多表 → 下拉选择；单表 → 零打扰
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
  // 容错：扩展名 .csv 但实际是 Excel/ZIP 二进制（PK 头）→ 走 XLSX 解析
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

// —— 解析点文件并创建独立点图层 ——
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
  // ★ 第 64 节修复：必须同时给出 rows / autoCols / colsLocked，
  //   否则 layer 处于「有 data 但没有 rows」的非法中间态 —— 一旦有任何入口
  //   调用 rebuildHandLayer()，layer.data 会被
  //   [layer.headers].concat((layer.rows || [])) 重写成「只剩表头」，
  //   表格里所有点瞬间消失，且会被 doSaveProject 写进项目文件（不可逆）。
  //   此处与 restorePointLayers 的恢复口径保持完全一致。
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

// —— 项目树「点」节点 ——
// 节点显示：名称 +（点数）；空类别显示「空」，便于区分"已建类别但还没点"
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
  // ★ 拖拽到三维画布显示（第 63 节修复）：
  //   原来只设了 draggable="true" 而没有 dragstart 监听，
  //   浏览器默认行为不会往 dataTransfer 写本应用的 JSON → drop 时 getData('text/plain') 为空 → 静默无反应。
  //   这里改走 setupNodeDraggable，payload 用 point-category + pointId，并在 dragstart 里带上当前点数。
  setupNodeDraggable(node, { type: 'point-category', pointId: layer.id });
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    // 记录右键的类别，供「点绘制 / 导出点CSV / 编辑属性列」使用
    ctxContext = { type: 'point-category', target: node, pointId: layer.id };
    filterCtxMenu('point-category');
    showCtxMenu(e.clientX, e.clientY);
  });
  // 左键点击：设为当前绘制目标（方便直接点绘制时知道往哪儿存）
  node.addEventListener('click', () => { activePointLayerId = layer.id; });
}

// —— 渲染点图层为独立 THREE.Group ——
// ★ 第 63 节修复：空类别不再「静默 return」。
//   原来 `if (!collars.length) return;` 会导致拖入空类别时界面完全无变化，
//   用户无法区分「没反应」与「空数据」。现在：先清掉旧显示 → 再给出可见提示 → 才返回。
function renderPointLayer(layer) {
  // ① 先把该类别已有的三维显示清干净（无论后面是否有点）
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

// —— 按属性重新着色 ——
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

// —— 着色弹窗 ——
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

// —— 删除点图层（图层❌按钮 + 树右键删除共用） ——
// 「点」类别整体从三维视图移除（类别级操作）。
// ⚠️ 当前无调用点：图层管理面板的 ❌ 已改为按「单个模型」处理（见 bindLayerItemEvents）。
//    保留此函数供「删除整个类别」等类别级场景复用。
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

// —— 重命名点类别（树右键）——
// 注意：Electron 中 prompt() 不可用，统一改用全局输入框 modal
let pendingRenamePoint = null;
function renamePointNode(node) {
  const id = node.getAttribute('data-point-id');
  const layer = state.pointLayers[id];
  if (!layer) return;
  pendingRenamePoint = { node: node, id: id };
  openPointCategoryDialog('point-category-rename', 'Rename point category', 'Point category name: ', layer.name);
}
// 实际应用重命名（由全局 modal 确认回调调用）
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

// —— 打开项目时恢复点类别（数据内联存储，无需原文件） ——
// ★ 旧项目迁移（第 62 节）：固定几何列由 5 列（含 depth）缩为 4 列。
// 旧项目的 headers/rows 第 5 列是 depth，这里把它**降级为普通自定义属性列**：
//   - 表头 'depth' 改名为「孔深(旧)」，避免与用户自建的「孔深」列同名冲突；
//   - 值原样保留，列可编辑、可删，不再有任何特殊待遇；
//   - 只处理"第 5 列恰好是 depth"这一种历史形态，其余情况不动。
function migrateLegacyPointDepth(layer) {
  if (!layer) return;
  const hd = layer.headers || [];
  if (hd.length <= POINT_BASE_HEADERS.length) return;
  const c4 = String(hd[POINT_BASE_HEADERS.length] || '').trim().toLowerCase();
  if (c4 !== 'depth') return;                       // 不是旧形态，别乱动
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
      // 类别化新增字段（老项目无此字段时按"已有点的类别"回退）
      autoCols: Array.isArray(saved.autoCols) ? saved.autoCols.slice() : null,
      colsLocked: (typeof saved.colsLocked === 'boolean') ? saved.colsLocked : null,
      isEmptyCategory: !!saved.isEmptyCategory
    };
    if (!layer.collars.length && layer.data.length) layer.collars = parseCollarTable({ data: layer.data });
    layer.rows = (layer.data && layer.data.length > 1) ? layer.data.slice(1) : [];
    // ★ 第 62 节：旧项目（固定列曾含 depth）迁移 —— 让第 5 列回归普通属性列，
    //   值不丢、可编辑、可删；表头若还是 'depth' 则改名为「孔深(旧)」以免与自定义列重名。
    migrateLegacyPointDepth(layer);
    // 兼容老数据：从 headers 里推出自定义属性列（★ 第 64 节：按列名判定，不再假设前 4 列是几何列）
    if (!layer.autoCols) {
      layer.autoCols = pointCustomColNames(layer.headers);
    }
    if (layer.colsLocked == null) layer.colsLocked = (layer.rows && layer.rows.length) ? true : !!layer.autoCols.length;
    if (!layer.isEmptyCategory) layer.isEmptyCategory = !((layer.rows && layer.rows.length));
    state.pointLayers[layer.id] = layer;
    addPointNode(layer);
    if (!(options && options.skipScene)) renderPointLayer(layer);
  });
  // 恢复类别顺序（先按存档顺序重排节点，未列入的追加到末尾）
  state.pointOrder = Array.isArray(order) ? order.filter(id => state.pointLayers[id]) : [];
  Object.keys(state.pointLayers).forEach(id => { if (state.pointOrder.indexOf(id) < 0) state.pointOrder.push(id); });
  state.pointOrder.forEach(id => {
    const node = subitemsPoint.querySelector('[data-point-id="' + id + '"]');
    if (node) subitemsPoint.appendChild(node);
  });
  if (!(options && options.skipScene)) { try { fitViewToAll(); } catch (e) {} }
}

// —— 三维点击打点（贴合几何：射线只打已有模型/钻孔/点）——
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

// 世界坐标 → GOCAD（与 gocadToThree 反推：gx=vx+ox, gz=vy+oz, gy=oy-vz）
// 坐标原点取「当前绘制目标类别」的原点，保证落点写进该类别自己的坐标系
function worldToGocad(p) {
  const layer = getActivePointCategory();
  const origin = (layer && layer.origin) || state.origin || { x: 0, y: 0, z: 0 };
  return { gx: p.x + origin.x, gy: origin.y - p.z, gz: p.y + origin.z };
}

// 由表头+行数据反推 collars 与可着色属性（与导入口径一致）
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

// 兼容旧调用：取当前绘制目标类别；无目标时回退到旧的「手绘点」类别（若存在）
function ensureHandPointLayer() {
  const act = getActivePointCategory();
  if (act) return act;
  if (state.pointLayers[HAND_LAYER_ID]) return state.pointLayers[HAND_LAYER_ID];
  return createPointCategory('Manual points', { id: HAND_LAYER_ID });
}

function rebuildHandLayer(layer) {
  // ★ 第 64 节防御性兜底：rows 缺失时回退到 data（去掉表头行），而不是当成空数组。
  //   原写法 (layer.rows || []) 在 rows === undefined 时会把整张表写成「只剩表头」，
  //   再经 doSaveProject 落盘就成了永久性数据丢失。这里改成「找不到 rows 就用 data」，
  //   保证任何调用入口都不会静默抹掉已有数据。
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
// ★ 点绘制撤销栈（前一步 / 后一步）
// 只覆盖"本次绘制会话内落下的点"，退出绘制时清空。
// 快照存整行数组，避免与 rows 引用共享。
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

// 手动保存当前绘制类别（面板「保存」按钮）
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

// —— 左侧绘制图标栏：悬停文字解释 ——
// 浮层挂在 body 上（fixed），不放在 .draw-bar 内：后者 overflow 会裁掉气泡。
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

// 把浮层摆到某个图标旁边；默认右侧，右边放不下则翻到左侧
function positionDrawBarTip(anchor) {
  const el = ensureDrawBarTip();
  const r = anchor.getBoundingClientRect();
  // 先显示以便量出真实尺寸
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

// 内容/可用性变化后若浮层还开着，就地刷新
function syncDrawBarTip() {
  if (_drawBarTipAnchor && _drawBarTipAnchor.isConnected) showDrawBarTip(_drawBarTipAnchor);
}

(function initDrawBarTips() {
  const bar = document.getElementById('draw-bar');
  if (!bar) return;
  bar.querySelectorAll('[data-tip-title]').forEach((item) => {
    item.addEventListener('mouseenter', () => showDrawBarTip(item));
    item.addEventListener('mouseleave', hideDrawBarTip);
    // 键盘可达性：Tab 聚焦也出解释
    item.addEventListener('focus', () => showDrawBarTip(item));
    item.addEventListener('blur', hideDrawBarTip);
    // 点击后指针仍停在图标上，主动收起避免遮挡
    item.addEventListener('click', hideDrawBarTip);
  });
  window.addEventListener('resize', hideDrawBarTip);
  window.addEventListener('scroll', hideDrawBarTip, true);
})();

// 刷新左侧绘制指示器（图标栏：类别名/计数写进悬停解释，按钮可用性）
function refreshDrawBar() {
  const bar = document.getElementById('draw-bar');
  if (!bar) return;
  if (!pointAddMode) { bar.classList.remove('visible'); hideDrawBarTip(); return; }
  bar.classList.add('visible');

  const layer = getActivePointCategory();
  const catName = layer ? layer.name : ' (No category specified) ';
  const n = layer ? ((layer.rows || []).length) : 0;

  // 状态图标：类别名与计数写进 tooltip；数字用角标显示
  const st = document.getElementById('draw-bar-cat');
  if (st) {
    st.setAttribute('data-tip-title', 'Drawing points · ' + catName);
    st.setAttribute('data-tip-desc',
      'Points placed ' + n + ' items' + (n ? '' : '; Left-click the model surface to place a point'));
  }
  const cnt = document.getElementById('draw-bar-count');
  if (cnt) cnt.textContent = n > 99 ? '99+' : String(n);

  // 撤销/重做：可用性 + 写明原因，避免「点了没反应」
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

  // 保存 / 结束绘制：保存按钮提示带上当前条数
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
    // ★ 进入绘制：为本次会话建立撤销基线，并显示左侧指示器
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
    // 结束点绘制：保存到所属类别（随项目持久化，静默）。★ 不再自动导出 CSV（用户要求）
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

// ★ 第 67 节：通用顶部轻提示（原 flashPointHint 抽出来，供点/图件共用）
//   工程内没有 toast 组件，此处创建一次后复用，自动 1.8s 消失。
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

// 图件操作提示（新建子分类等）
function flashDrawingHint(msg) {
  flashTopHint(msg, 'drawing-hint');
}

// 点操作提示（保持原有独立元素与调用口径不变）
function flashPointHint(msg) {
  flashTopHint(msg, 'point-hint');
}

// 块体模型操作提示（第 97 节）
function flashBlockHint(msg) {
  flashTopHint(msg, 'block-hint');
}

// 渲染弹窗「属性列」区：列名 + 值 动态行
// locked=true（已有第一个点定型）→ 只填值，列名灰显不可改、不显示 ➕
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

// 读取弹窗里的属性列（列名去空、去重）
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

// 正式写入在 commitHandPoint 里完成。
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
  // 标题带上类别名，明确"存到哪个子文件夹"
  const ttl = document.querySelector('#point-add-modal .modal-header');
  if (ttl) ttl.textContent = 'Add points manually → ' + layer.name;
  // 属性列：第一个点之前自由编辑（默认空，需点 ➕）；定型后严格沿用
  const locked = !!layer.colsLocked;
  renderPointAttrRows(locked ? (layer.autoCols || []) : (layer.autoCols || []), [], locked);
  const addBtn = document.getElementById('pa-add-col');
  if (addBtn) addBtn.style.display = locked ? 'none' : '';
  const lockTip = document.getElementById('pa-lock-tip');
  if (lockTip) lockTip.style.display = locked ? '' : 'none';
  document.getElementById('point-add-modal').classList.add('show');
  const fx = document.getElementById('pa-x'); fx.focus(); fx.select();
}

// 结束点绘制后再次进入时，让锁定的列带上上一行值做参考（值仍留空）
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
  // 第一个点：用填写的属性列定型（严格模式的基础）
  if (!layer.colsLocked) {
    const names = [];
    attrs.forEach(a => { if (names.indexOf(a.name) < 0) names.push(a.name); });
    layer.autoCols = names;
    layer.headers = POINT_BASE_HEADERS.concat(names);
    // 列名重复/为空直接给出可见反馈
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
  pushDrawHistory(layer);   // ★ 记入撤销栈（供面板「前一步 / 后一步」）
  document.getElementById('point-add-modal').classList.remove('show');
  flashPointHint('Point added ' + hid + ' → ' + layer.name + '  (Total ' + layer.rows.length + ' items) ');
}

// —— ★ 绘制指示器面板按钮绑定 ——
document.getElementById('draw-bar-undo').addEventListener('click', (e) => { e.stopPropagation(); drawUndo(); });
document.getElementById('draw-bar-redo').addEventListener('click', (e) => { e.stopPropagation(); drawRedo(); });
document.getElementById('draw-bar-save').addEventListener('click', (e) => { e.stopPropagation(); saveCurrentDrawCategory(); });
document.getElementById('draw-bar-stop').addEventListener('click', (e) => { e.stopPropagation(); setPointAddMode(false); });

// —— 事件绑定 ——
document.getElementById('ctx-import-point').addEventListener('click', async (e) => {
  e.stopPropagation();
  hideCtxMenu();
  if (!await guardImportPointDraw('Importing point data')) return;
  pendingPointCategory = subitemsPoint;
  pointFileInput.value = '';
  pointFileInput.click();
});

// 右键「点」大类 → 新建类别
document.getElementById('ctx-new-point-category').addEventListener('click', (e) => {
  e.stopPropagation();
  hideCtxMenu();
  openPointCategoryDialog('point-category-new', 'New point category', 'Point category name: ', makeUniquePointCategoryName('New point category'));
});
// 右键某个点类别 → 点绘制 / 结束点绘制（绑定到该类别）
document.getElementById('ctx-add-point').addEventListener('click', (e) => {
  e.stopPropagation();
  // 注意：必须先取 id 再 hideCtxMenu()——后者会清空 ctxContext
  let id = (ctxContext && ctxContext.pointId) || activePointLayerId;
  hideCtxMenu();
  if (!pointAddMode) {
    // 兜底：没有明确目标时，若工程里只有一个点类别，直接用它（避免"建了类别却画不了点"）
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

// 右键某个点类别 → 编辑点数据（表格视图：改坐标 / 增删点 / 改属性值 / 增删属性列）
document.getElementById('ctx-edit-point-data').addEventListener('click', (e) => {
  e.stopPropagation();
  const id = resolvePointTargetId();
  hideCtxMenu();
  if (id) openPointDataEditor(id);
  else flashPointHint('First right-click a point category, then select“Edit point data”');
});

// 右键某个点类别 → 导出点CSV（只导出该类别）
document.getElementById('ctx-export-point').addEventListener('click', (e) => {
  e.stopPropagation();
  const id = resolvePointTargetId();
  hideCtxMenu();
  exportPointsToCSV(id);
});

// 「线」类别整体从三维视图移除（类别级操作，会删掉该类别下所有文件）。
// ⚠️ 当前无调用点：图层管理面板的 ❌ 已改为按「单个模型」处理
//    （见 bindLayerItemEvents —— 同一类别下可含多个彼此独立的文件，
//      按类别删会误伤；且用户要求左树文件节点必须保留）。
//    保留此函数供「删除整个类别」等类别级场景复用。
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
    // 摘除对应的左树文件节点与文件记录
    const rec = layer.files.find(f => f.modelId === m.id);
    if (rec) {
      const node = layer._nested ? layer._nested.querySelector('[data-line-file-id="' + rec.id + '"]') : null;
      if (node) node.remove();
      const fi = layer.files.indexOf(rec);
      if (fi >= 0) layer.files.splice(fi, 1);
    }
  });
  // 该类别下已无线文件 → 移除类别节点
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

// 解析当前操作目标点类别：右键的 > 已选中的 > 唯一类别
function resolvePointTargetId() {
  let id = (ctxContext && ctxContext.pointId) || activePointLayerId;
  if (id && state.pointLayers[id]) return id;
  const ids = Object.keys(state.pointLayers || {});
  return ids.length === 1 ? ids[0] : null;
}

// ============================================================
// 线管理（类别化）
// 与「点」对称的架构：state.lineLayers 为类别字典，每类下挂若干线文件。
// 本轮范围（用户确认）：仅「导入 + 显示/隐藏 + 透明度 + 聚焦」，
// 暂不做三维绘制、按属性着色、导出 CSV。
// ============================================================
const LINE_PALETTE = [0x3EE1A3, 0x58A6FF, 0xF39C12, 0xE85D75, 0x9B59B6, 0x1ABC9C, 0xE74C3C];
let linePaletteIdx = 0;

const headerLine = document.getElementById('header-line');
const subitemsLine = document.getElementById('subitems-line');
const lineDxfInput = document.getElementById('line-dxf-input');
const lineGeojsonInput = document.getElementById('line-geojson-input');
const lineCsvInput = document.getElementById('line-csv-input');

// —— 事件绑定（必须在上述 const 声明之后，否则触发 const TDZ → 整脚本中断 → 画布黑屏）——
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
let pendingRenameLine = null;   // 线类别/线文件重命名的待处理目标（配合全局 modal）

function makeLineCategoryId() {
  return 'line_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

// ============================================================
// ★ 生成不重复的默认类别名（2026-09-17）
//
// 背景（用户报障「右键可以新建多个新的线段类别，我刚建第二个的时候没有反应！」）：
//   对话框的默认名原来是写死的常量「新线类别」。用户连点两次「新建线类别」→
//   两次都直接回车/点确定（不输入名字）→ 左树出现**两个完全同名同色的「新线类别」**
//   → 用户看着像"还是原来那个"，判定「建第二个没反应」。
//   实测确认（tools/e2e_line_same_name.js）：连续默认提交 3 次，
//   得到 ["新线类别","新线类别","新线类别"] —— 三个一模一样的节点。
//
// 修复思路：前缀 + 递增序号，且**跳过已被占用的名字**。
//   · 已存在「新线类别」   → 给「新线类别2」
//   · 已存在 1 和 2        → 给「新线类别3」
//   · 用户手改过名、前缀不在 → 从 2 起找第一个空位
// ============================================================
function makeUniqueLineCategoryName(base) {
  const b = base || 'New line category';
  const taken = new Set();
  (state.lineOrder || []).forEach(id => {
    const L = state.lineLayers[id];
    if (L && L.name) taken.add(L.name);
  });
  // 也把 DOM 里现存的标签收进来（防止 state 与 DOM 短暂不同步）
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

// 新建线类别：左树建节点 + 切为当前活动类别
function createLineCategory(name) {
  const id = makeLineCategoryId();
  const color = LINE_PALETTE[linePaletteIdx % LINE_PALETTE.length];
  linePaletteIdx++;
  // ★ 最后一道防线：即使调用方传了重名（例如对话框重复提交、工程恢复时名字撞车），
  //   这里也补一个序号，保证左树里永远不会有"看起来一模一样"的两个类别。
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
  // ★ 幂等：避免重复 push（state.lineOrder 里出现同一个 id 两次会让遍历逻辑错乱）
  if (state.lineOrder.indexOf(id) < 0) state.lineOrder.push(id);
  addLineNode(layer);
  activeLineLayerId = id;   // 新建即选中，避免"建了类别却导入不了"（点模块踩过的坑）
  return layer;
}

// 在左树「线」下建类别节点（可折叠 + 子容器，与图件分类同构）
function addLineNode(layer) {
  if (!subitemsLine) return;
  const old = subitemsLine.querySelector('[data-role="line-category"][data-line-id="' + layer.id + '"]');
  if (old) {
    // 连同其后的 nested 容器一起移除，避免留下孤儿容器
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
    // 点箭头/计数 → 折叠展开；点其余区域 → 设为活动类别
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

  // 已有文件节点补挂（工程恢复场景）
  layer.files.forEach(f => attachLineFileNode(layer, f));
  refreshLineCategoryLabel(layer);
}

// 展开某线类别的子容器（统一走 expanded 类，与其余节点同机制）
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

// 把一份线文件的节点挂到类别下
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
  // ★ 反向绑定到对应 model：图层管理面板 ❌ 移除该文件时需要把左树节点变灰（保留节点本身）
  if (fileRec.modelId) {
    const mo = (state.models || []).find(m => m.id === fileRec.modelId);
    if (mo) mo.treeFileNode = node;
  }
  // ★ 支持拖拽回画布恢复显示（与普通模型文件节点同机制）。
  //   注意：线文件的显示名在 .lp-file-name（是节点内第一个 span），
  //   而 setupNodeDraggable 的 file 分支正是取 querySelector('span')，能正确取到。
  //   但该节点的第一个 span 若将来变化，会取错名字 → 这里显式传 fileName，避免依赖 DOM 顺序。
  setupNodeDraggable(node, {
    type: 'file',
    modelId: fileRec.modelId || null,
    fileNames: [fileRec.fileName]
  });
}

// 解析目标线类别：右键的 > 活动类别 > 唯一类别
function resolveLineTargetId() {
  let id = (ctxContext && ctxContext.lineId) || activeLineLayerId;
  if (id && state.lineLayers[id]) return id;
  const ids = Object.keys(state.lineLayers || {});
  return ids.length === 1 ? ids[0] : null;
}

// —— 右键事件绑定 ——
// 右键「线」大类 → 新建线类别
document.getElementById('ctx-new-line-category').addEventListener('click', (e) => {
  e.stopPropagation();
  hideCtxMenu();
  // ★ 预填一个不重复的默认名（避免连建多个时出现同名节点，用户误判"没反应"）
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

// 删除线类别（连同其下所有线文件）
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

// 重命名线类别 / 线文件
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

// 应用线重命名（由全局 modal 回调调用）
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
  if (moved > 5) return; // 视为拖拽旋转，不落点
  const p = getPickablePointOnGeometry(e);
  if (!p) { flashPointHint('No model was hit / Drillholes / Point, Aim the crosshair at the geological body before clicking'); return; }
  const g = worldToGocad(p);
  openPointAddModal(g.gx, g.gy, g.gz);
});
document.getElementById('point-add-ok').addEventListener('click', commitHandPoint);
document.getElementById('point-add-cancel') && document.getElementById('point-add-cancel').addEventListener('click', () => { document.getElementById('point-add-modal').classList.remove('show'); });
document.getElementById('point-add-skip').addEventListener('click', () => { document.getElementById('point-add-modal').classList.remove('show'); });
// 弹窗内「＋ 添加属性列」：第一个点之前可自由增列
const paAddColBtn = document.getElementById('pa-add-col');
if (paAddColBtn) paAddColBtn.addEventListener('click', () => addPointAttrRow('', ''));

// —— 点数据编辑器按钮 ——
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

// —— 单点属性编辑按钮 ——
const pattrOk = document.getElementById('point-attr-ok');
if (pattrOk) pattrOk.addEventListener('click', commitPointAttrEditor);
const pattrCancel = document.getElementById('point-attr-cancel');
if (pattrCancel) pattrCancel.addEventListener('click', () => {
  document.getElementById('point-attr-modal').classList.remove('show');
  _pattrCtx = null;
});

// 导出点类别为 CSV；传 id 时只导出该类别，不传则导出全部
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
    const csv = '﻿' + lines.join('\r\n'); // ﻿ = UTF-8 BOM，便于 Excel 正确识别中文
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const fname = (layer.name || layer.id || 'points') + ' _Point data_' + ts + '.csv';
    downloadTextFile(csv, fname, 'text/csv');
    exported++;
  });
  flashPointHint('Exported ' + exported + ' point categories: CSV File (Available in the Downloads folder) ');
}

// —— 点类别命名输入框（Electron 中 prompt() 不可用，复用全局 modal） ——
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
// ★ 点数据编辑器（表格视图）
// 解决三个缺口：
//   ① 已落点的坐标可回改   ② 可删除单个点   ③ 属性值可在程序内查看/编辑
// 同时承载「增删属性列」（原「编辑属性列」弹窗已合并至此，2026-09-21）
// 数据统一落在 layer.rows（按列位置），保存时经 rebuildHandLayer 反推 collars/attrs
// ============================================================
let _pdLayerId = null;          // 当前编辑的点类别 id
let _pdDraft = null;            // 编辑副本：{ headers:[], rows:[[]], deleted:[] }
let _pdSelected = new Set();    // 选中的行下标（相对 _pdDraft.rows）
let _pdFilter = '';

// 把类别当前数据抽成编辑副本；空类别也要能开（用固定列兜底）
// ★ 第 64 节：headers 与 rows 的取值口径需与 rebuildHandLayer 一致，
//   否则「有 data 没 rows」的层会在表格与三维之间来回抖动。
function snapshotPointDraft(layer) {
  const headers = (layer.headers && layer.headers.length)
    ? layer.headers.slice()
    : POINT_BASE_HEADERS.concat(layer.autoCols || []);
  const rows = (layer.rows && layer.rows.length)
    ? layer.rows.map(r => r.slice())
    : (layer.data && layer.data.length > 1)
      ? layer.data.slice(1).map(r => r.slice())
      : [];
  // 顺手把 rows 补回 layer：消除「有 data 没 rows」的非法中间态（★ 第 64 节）
  if (!layer.rows || !layer.rows.length) {
    layer.rows = rows.map(r => r.slice());
  }
  // 补齐：行短于表头的补空，长于表头的截断，保证按列位置对齐
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

// 表头：固定几何列 + 自定义属性列；首列是「选择」复选框
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

  // —— 表头 ——
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
      // 固定几何列：只读
      hh += '<th style="' + cs + '">' + escapeHtml(label) + '</th>';
    } else {
      // ★ 自定义属性列：点击列名改名，✕ 删除该列
      hh += '<th style="' + cs + 'white-space:nowrap;">' +
            '<span class="pd-col-name" data-pd-col="' + c + ' " title="Click to rename this column" ' +
            'style="cursor:pointer;border-bottom:1px dashed #aaa;">' + escapeHtml(label) + '</span>' +
            '<span class="pd-col-del" data-pd-col="' + c + ' " title="Delete this attribute column" ' +
            'style="cursor:pointer;margin-left:6px;color:#c62828;font-weight:400;">✕</span>' +
            '</th>';
    }
  });
  // ★ 末尾「＋ 列」：在表头上直接加列
  hh += '<th style="padding:4px 8px;border:1px solid #e3e3e3;background:#fafafa;position:sticky;top:0;z-index:2;">' +
        '<span id="pd-add-col-th" title="Add attribute column" style="cursor:pointer;color:#2f6df6;font-weight:500;">＋ Columns</span></th>';
  hh += '</tr>';
  thead.innerHTML = hh;

  // —— 表体 ——
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

  // —— 顶部提示 ——
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

  // —— 绑定 ——
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
  // 单元格改动 → 直接写进草稿（不重绘，避免光标丢失）
  tbody.querySelectorAll('.pd-cell').forEach(ipt => {
    ipt.addEventListener('input', () => {
      const i = parseInt(ipt.getAttribute('data-pd-idx'), 10);
      const c = parseInt(ipt.getAttribute('data-pd-col'), 10);
      if (!_pdDraft || !_pdDraft.rows[i]) return;
      _pdDraft.rows[i][c] = ipt.value;
    });
  });

  // ★ 列操作：点击列名改名（内联 input），✕ 删列，末尾 ＋ 加列
  thead.querySelectorAll('.pd-col-name').forEach(sp => {
    sp.addEventListener('click', () => {
      const c = parseInt(sp.getAttribute('data-pd-col'), 10);
      if (!_pdDraft || isPointGeoCol(_pdDraft.headers, c)) return;
      // ★ 第 64 节：改名时同步禁止改成「与固定几何列同名」的列名（否则该列会被
      //   isPointGeoCol 判定为几何列，语义漂移）。见 finish() 里的额外校验。
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
          // ★ 第 64 节：几何列名是保留字，属性列不得占用（否则该列会被当成几何列）
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
      // 至少保留 1 个自定义列（若已有点）；空类别允许删光
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

// 保存草稿 → 写回类别并刷新三维
function commitPointDataEditor() {
  const layer = state.pointLayers[_pdLayerId];
  document.getElementById('point-data-modal').classList.remove('show');
  if (!layer || !_pdDraft) { _pdDraft = null; return; }
  // ★ 第 64 节：保存时把几何列归位到最前，再存。
  //   历史写法 layer.autoCols = headers.slice(4) 假定「前 4 列就是几何列」，
  //   列序不标准的文件会切错位置（把几何列当属性列、把属性列当固定列）。
  //   这里改为：按列名挑出几何列排在前、其余列按原相对顺序排在后，
  //   headers 与 rows 同步重排 —— 既修正 autoCols，又消除列表错位，
  //   并让「几何列就是前 N 列」这一位置约定重新成立（下游渲染依赖它）。
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

// ★ 新增一个自定义属性列（列名自动避重，所有已有点补空值）
function addPointDataColumn() {
  if (!_pdDraft) return;
  const base = 'Attributes';
  // ★ 第 64 节：编号按「现有属性列个数」推，不再假设前 4 列都是几何列
  let n = pointCustomColIndexes(_pdDraft.headers).length + 1;
  let nm = base + n;
  while (_pdDraft.headers.indexOf(nm) >= 0 || isPointGeoHeader(nm)) { n++; nm = base + n; }
  _pdDraft.headers.push(nm);
  _pdDraft.rows.forEach(r => r.push(''));
  renderPointDataTable();
  flashPointHint('Attribute column added“ ' + nm + ' ” (Click a column header to rename it) , Point“Save and refresh”to apply');
  // 滚动到最右侧，让新列可见
  const wrap = document.getElementById('pd-table-wrap');
  if (wrap) wrap.scrollLeft = wrap.scrollWidth;
}

// 新增一个空点：坐标默认取已有点的均值，避免落在 (0,0,0)
function addPointDataRow() {
  if (!_pdDraft) return;
  const H = _pdDraft.headers;
  const iHole = findColumnIndex(H, ['holeid', 'hole_id', '孔号', '钻孔号']);
  const iX = findColumnIndex(H, ['x', 'east', '东坐标', '东']);
  const iY = findColumnIndex(H, ['y', 'north', '北坐标', '北']);
  const iZ = findColumnIndex(H, ['z', 'elevation', '高程', '标高']);
  const row = [];
  for (let c = 0; c < H.length; c++) row.push('');
  // 孔号：PT + 递增序号（避开已有）
  const used = new Set(_pdDraft.rows.map(r => iHole >= 0 ? String(r[iHole]) : ''));
  let k = _pdDraft.rows.length + 1, hid = 'PT' + String(k).padStart(3, '0');
  while (used.has(hid)) { k++; hid = 'PT' + String(k).padStart(3, '0'); }
  if (iHole >= 0) row[iHole] = hid;
  // 坐标：优先沿用上一行的值（连续录入更省事），无历史则留空
  const last = _pdDraft.rows[_pdDraft.rows.length - 1];
  if (last) {
    if (iX >= 0) row[iX] = last[iX];
    if (iY >= 0) row[iY] = last[iY];
    if (iZ >= 0) row[iZ] = last[iZ];
  }
  _pdDraft.rows.push(row);
  renderPointDataTable();
  // 滚动到底部并聚焦新行的孔号
  const wrap = document.getElementById('pd-table-wrap');
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

function deleteSelectedPointRows() {
  if (!_pdDraft) return;
  if (!_pdSelected.size) { flashPointHint('Select the points to delete first (or use Select all above) '); return; }
  const n = _pdSelected.size;
  // 从大到小删除，避免下标位移
  const list = Array.from(_pdSelected).sort((a, b) => b - a);
  list.forEach(i => removePointDraftRowAt(i));
  _pdSelected = new Set();
  renderPointDataTable();
  flashPointHint('Marked for deletion ' + n + ' points, Point“Save and refresh”to apply');
}

// 从当前草稿移除一行（只改草稿，随「保存并刷新」生效）
// 供批量删除与单点右键删除共用，避免两套下标逻辑
function removePointDraftRowAt(i) {
  if (!_pdDraft) return false;
  const r = _pdDraft.rows[i];
  if (r == null) return false;
  // ★ 第 64 节：孔号列按列名定位，不再硬取 r[0]（列序可能不标准）
  const iHole = findColumnIndex(_pdDraft.headers, ['holeid', 'hole_id', '孔号', '钻孔号']);
  const hid = (iHole >= 0 && r[iHole] != null && String(r[iHole]) !== '') ? String(r[iHole]) : ('#' + (i + 1));
  _pdDraft.deleted.push(hid);
  _pdDraft.rows.splice(i, 1);
  return true;
}

// ============================================================
// ★ 单点属性编辑（画布上双击小球）
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
    ipt.classList.add('pattr-field');   // ★ 同步进 classList：个别环境 className 与 classList 不同步，会导致按类名取不到字段
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
// ★ 单点右键操作（右键三维画布上的点小球）
// 统一从 ctxContext.pointLayerId / pointRowIndex 取目标，
// 保证与右键菜单的解绑（菜单只负责派发到这里）。
// 单点删除语义与「编辑点数据」不同：这里**立即生效**（无草稿），
// 因为用户右键点「删除此点」时的预期是"立刻没了"，而不是"待保存"。
// ============================================================

function _ctxPointTarget() {
  const layerId = ctxContext && ctxContext.pointLayerId;
  const ri = ctxContext && ctxContext.pointRowIndex;
  const layer = layerId ? state.pointLayers[layerId] : null;
  if (!layer) return null;
  if (ri == null || ri < 0 || !(layer.rows || [])[ri]) return null;
  return { layer: layer, rowIndex: ri, row: layer.rows[ri] };
}

// 「编辑此点」：复用双击弹窗
function ctxPointEdit() {
  const t = _ctxPointTarget();
  if (!t) { flashPointHint('This point no longer exists, Refresh the view'); return; }
  const model = state.models.find(m => m.isPointLayer && m.pointLayerId === t.layer.id);
  if (!model) { flashPointHint('The point\'s layer was not found'); return; }
  const sphere = { userData: { rowIndex: t.rowIndex } };
  openPointAttrEditor(model, sphere);
}

// 「复制此点」：在该点后插入一行，坐标与属性整行复制，孔号自动避重
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

// 生成类别内不重复的孔号：原名 +2 / +3 …；原名缺失则用 PT{n}
function makeUniqueHoleId(layer, base) {
  const H = layer.headers || POINT_BASE_HEADERS;
  const iH = H.indexOf('holeid');
  const col = iH >= 0 ? iH : 0;
  const used = new Set((layer.rows || []).map(r => String(r[col] == null ? '' : r[col]).trim()));
  let stem = String(base == null ? '' : base).trim();
  if (!stem) stem = 'PT' + ((layer.rows || []).length + 1);
  // 已是 "xxx2" 形式则从该数字继续递增，否则从 2 起
  const m = stem.match(/^(.*?)(\d+)$/);
  const prefix = m ? m[1] : stem;
  let n = m ? (parseInt(m[2], 10) + 1) : 2;
  let cand = prefix + n;
  let guard = 0;
  while (used.has(cand) && guard++ < 10000) { n++; cand = prefix + n; }
  return cand;
}

// 「删除此点」：立即生效（无草稿），走标准四步连锁
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

// 「该点居中显示」：相机对准该点（保留当前观察方向与距离，只平移焦点）
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

// 「查看该点属性」：只读列出该行全部字段（不改数据）
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

// —— 表格重命名 ——
// ★ 第 68 节：同上，改用全局 modal（Electron 中 prompt() 不可用）
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

// —— 表格删除 ——
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

// —— 表格输出（下载原始文件） ——
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
  // 将二维数组转为 CSV 文本下载
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
  // 防止超出视窗
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
  // ★ 三维画布上的右键由 canvas 自己的 contextmenu 处理（含单点菜单），
  // document 冒泡阶段若继续执行会把刚弹出的菜单 hideCtxMenu() 掉，故直接放行。
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

// —— 分类菜单：导入 .ts / .str / .dtm 模型 ——
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

// —— 分类菜单：导入 .obj 模型 ——
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

// —— 单点右键菜单（右键三维画布上的点小球） ——
// 注意：hideCtxMenu() 会重置 ctxContext，所以必须在收起菜单前先快照目标，
// 收起后再还原，供下面的 ctxPointXxx() 取用。
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

// —— 通用：删除 ——
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

// —— 通用：重命名 ——
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

// —— 通用：输出 ——
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

// —— 菜单：导入属性表（模型文件右键，按「文件名」列关联模型级属性） ——
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

// 属性表 → 统一 records：[{字段:值}, ...]
// 支持：CSV/TXT/TSV（parseCsvText）、JSON（数组 / {文件名:{...}} / {records:[...]}）、
//       Excel（含被 Excel/WPS 误存成 .csv 的 PK-zip 工作簿，按文件头嗅探）
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
  // 项目树节点文字
  if (model.treeFileNode) {
    const sp = model.treeFileNode.querySelector('span');
    if (sp) sp.textContent = name;
  }
  // 图层管理条目名称
  if (typeof lmList !== 'undefined' && lmList) {
    const lmName = lmList.querySelector('.lm-item[data-model-id="' + model.id + '"] .lm-name');
    if (lmName) lmName.textContent = name;
  }
}
// 把属性表一行应用到匹配的模型（类型→显示名；颜色→材质；整行→model.attrs 供属性面板展示）
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

// —— 菜单：控制点配准 ——
document.getElementById('ctx-register-drawing').addEventListener('click', (e) => {
  e.stopPropagation();
  hideCtxMenu();
  if (ctxContext && ctxContext.type === 'drawing-file' && ctxContext.target) {
    startRegisterDrawing(ctxContext.target);
  }
});

// —— 菜单：新建子分类（图件分类 / 图件分组下） ——
document.getElementById('ctx-new-drawing-category').addEventListener('click', (e) => {
  e.stopPropagation();
  const { type, target } = ctxContext;
  hideCtxMenu();
  if ((type === 'drawing-group' || type === 'drawing') && target) {
    // ★ 第 67 节：改用工程内 modal，取代 window.prompt
    //   原因：Electron 30 / Chromium 已弃用同步 prompt，可能直接返回 null，
    //   原逻辑 `if (input == null) return;` 会静默退出 → 用户观感「点了没反应」。
    openNewDrawingSubCategoryDialog(target);
  }
});

// --------- 删除逻辑 ---------
function deleteFileNode(fileNode) {
  const modelId = fileNode.getAttribute('data-model-id');
  const model = getProjectModels().find(m => m.id === modelId);
  if (!model) { fileNode.remove(); return; }
  const displayName = model.displayName || model.fileName || model.name || 'This model';
  if (!confirm('Remove from both the 3D view and the project tree?“ ' + displayName + ' ”??')) return;

  // 1. 从场景移除
  if (model.mesh && model.mesh.parent) model.mesh.parent.remove(model.mesh);
  // 2. 若当前选中是它，清空描边和选中
  if (state.selectedModelId === modelId) {
    clearSelectionOutline();
    state.selectedModelId = null;
    showEmptyProperties();
  }
  // 3. 从 state.models 删除
  if (model.terrainTexture) model.terrainTexture.dispose();
  state.models = state.models.filter(m => m.id !== modelId);
  tabViewers.forEach(viewer=>{if(viewer.state){viewer.state.models.filter(item=>item.id===modelId).forEach(item=>item.mesh?.parent?.remove(item.mesh));viewer.state.models=viewer.state.models.filter(item=>item.id!==modelId);}});
  // 4. 从图层管理删除
  const lmItem = lmList.querySelector('.lm-item[data-model-id="' + modelId + '"]');
  if (lmItem) lmItem.remove();
  // 5. 从项目树删除
  fileNode.remove();
  // 6. 更新图例/相机
  updateLegend();
  updateRenderOrder();
  fitViewToAll();
  // 7. 空状态
  if (state.models.length === 0) lmEmpty.style.display = '';
  // 8. 刷新坐标轴标签
  buildAxisLabels();
}

function deleteModelNode(modelNode) {
  // 获取所有子分类下的文件节点
  const wrapper = modelNode.parentElement;
  const nested = modelNode.nextElementSibling; // .lp-nested-items
  const fileNodes = nested
    ? nested.querySelectorAll('.lp-sub-item[data-model-id]')
    : [];
  const modelCount = fileNodes.length;
  const modelName = (modelNode.querySelector('span') || {}).textContent || 'This model';
  if (modelCount > 0 && !confirm('Confirm deletion“ ' + modelName + ' ”and its ' + modelCount + ' 3D model files??')) return;
  if (modelCount === 0 && !confirm('Confirm deletion“ ' + modelName + ' ”??')) return;

  // 依次删除每个文件
  fileNodes.forEach(fn => deleteFileNode(fn));

  // 删除节点结构（模型项 + lp-nested-items）
  modelNode.remove();
  if (nested) nested.remove();
  // 若 wrapper 是临时 div 且空了，也移除（同时排除三维地质模型和地球化学模型的根容器）
  if (wrapper && wrapper !== subitems3DModel && wrapper !== subitemsGeochemModel && wrapper !== subitemsBlockModel && wrapper.children.length === 0) wrapper.remove();
}

// --------- 重命名逻辑（Electron 中 prompt() 不可用，统一改用全局 modal 输入框） ---------
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
  // 项目树
  if (span) span.textContent = newName;
  // 图层管理
  const lmName = lmList.querySelector('.lm-item[data-model-id="' + modelId + '"] .lm-name');
  if (lmName) lmName.textContent = newName;
  // 状态
  model.displayName = newName;
  // 属性面板
  if (state.selectedModelId === modelId) refreshCurrentProperties();
  // 图例
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

// --------- 输出逻辑 ---------
function exportFileNode(fileNode) {
  const modelId = fileNode.getAttribute('data-model-id');
  const model = state.models.find(m => m.id === modelId);
  if (!model) return;
  // 输出为 .obj（标准三角网格格式）
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
  // 逐个输出，并打个 ZIP 清单说明（浏览器环境不打包 zip，所以直接依次下载）
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

// OBJ 序列化工具
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
// 解析坑道模型：.str（顶点）+ .dtm（三角形）配对 → geoMesh
//   .str 每行: [段标志], X, Y, Z, ...（跳过首行 header、占位行、END 行）
//   .dtm 每行: [tri_id], v1, v2, v3, ...（索引 1-based，跳过 POINTS/TRIANGLES 头）
//   坐标系与 GOCAD 一致：X 东 / Y 北 / Z 高 → three = [X, Z, -Y]
// ============================================================
function parseTunnelModel(strText, dtmText, fileName) {
  const vertices = [];
  // ---- 先从 .dtm 读取 POINTS 声明（顶点数上限，防止占位/多余行被误当作顶点） ----
  let declaredPoints = 0;
  const dtmHeadLines = String(dtmText || '').split(/\r?\n/);
  for (const raw of dtmHeadLines) {
    const m = raw.trim().match(/^POINTS\s+(\d+)/i);
    if (m) { declaredPoints = parseInt(m[1], 10); break; }
  }
  // ---- .str: 顶点 ----
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
    // 跳过占位行：第一列为 0 且坐标全为 0（如 tunnel_test 的 (0,0,0) 行），
    // 否则会被误当作 0 号顶点，导致 .dtm 1-based 索引整体错位、模型破碎
    if (vals[0] === '0' && x === 0 && y === 0 && z === 0) continue;
    // 顶点数达到 .dtm 声明值后截断（END 标记前的多余行不再计入）
    if (declaredPoints > 0 && vertices.length / 3 >= declaredPoints) break;
    // 与 GOCAD 相同的轴交换：three = [X, Z(高程), -Y(北取反)]
    vertices.push(x, z, -y);
  }
  if (vertices.length < 9) throw new Error('.str No valid vertices were found (Requires at least 3 points) ');

  // ---- .dtm: 三角形索引（1-based → 0-based） ----
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

  // 检查三角形索引是否越界
  const vcount = vertices.length / 3;
  for (const idx of indices) {
    if (idx >= vcount) throw new Error('.dtm Triangle index ' + (idx + 1) + ' exceeds the vertex count ' + vcount);
  }

  // ---- fileOrigin（与 parseGOCADTS 一致：取最小坐标向下取整到百米级） ----
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const rx = vertices[i];        // 原始 X
    const ry = -vertices[i + 2];   // 原始 Y（还原北向）
    const rz = vertices[i + 1];    // 原始 Z（高程）
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
  // ★ 按右键入口选择的类型过滤（TS 入口 / OBJ 入口分离后，各自只收对应格式）
  if (pendingModelImportKind === 'obj') {
    fileArr = fileArr.filter(f => /\.obj$/i.test(f.name));
  } else {
    // TS 入口：地球化学/坑道/普通地质模型均不允许 .obj 混入
    fileArr = fileArr.filter(f => !/\.obj$/i.test(f.name));
  }
  if (fileArr.length === 0) {
    alert(pendingModelImportKind === 'obj'
      ? 'Select .obj model files (Applied by“Import OBJ Model”Filter) '
      : 'This action only imports .ts/.str/.dtm Model file, Filtered out .obj File, Select again');
    fileInput.value = '';
    return;
  }
  // 批量导入：记录最后成功加载的模型，循环结束后统一刷新一次视图
  let lastModelId = null;
  try {
  if (isGeochem) {
    // 地球化学模型：先批量提取文件名数值，计算本次导入的 min/max 和排名
    const numericValues = fileArr.map(f => extractFirstNumber(f.name));
    const validValues = numericValues.filter(v => v !== null);
    const minVal = validValues.length > 0 ? Math.min.apply(null, validValues) : 0;
    const maxVal = validValues.length > 0 ? Math.max.apply(null, validValues) : 0;
    const total = fileArr.length;

    // 按数值升序计算排名（null 视为最小）
    // 排序索引：数值小的 rank 小，对应透明度低
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
        // ★ 解析成功 → 异步写几何缓存（真实磁盘路径 + 修改时间 + 大小 为钥匙）
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
    // 三维坑道模型：.str（顶点）+ .dtm（三角形）按基名配对导入
    showImportLoading('Parsing tunnel model...');
    await yieldToUI();
    const strFiles = fileArr.filter(f => /\.str$/i.test(f.name));
    const dtmFiles = fileArr.filter(f => /\.dtm$/i.test(f.name));
    if (strFiles.length === 0 && dtmFiles.length === 0) {
      hideImportLoading();
      alert('A tunnel model requires .str (Vertex) + .dtm (Triangle) Import the two files as a pair\n Select, for example, tunnel_test.str and tunnel_test.dtm file pair with a matching base name. ');
    } else {
      // 按基名配对（tunnel_test.str ↔ tunnel_test.dtm）
      const dtmByName = {};
      dtmFiles.forEach(f => { dtmByName[f.name.replace(/\.dtm$/i, '')] = f; });
      const paired = [];
      strFiles.forEach(sf => {
        const base = sf.name.replace(/\.str$/i, '');
        if (dtmByName[base]) { paired.push([sf, dtmByName[base]]); delete dtmByName[base]; }
      });
      // 只有 .dtm 没有 .str 时，也尝试单文件导入（顶点为空则报错）
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
          // ★ 解析成功 → 异步写几何缓存（str + dtm 双路径打包为钥匙）
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
    // 三维地质模型：按分类导入（多文件都进同一分类文件夹）
    const category = pendingCategoryItem.getAttribute('data-category');
    for (const file of fileArr) {
      try {
        const isObj = /\.obj$/i.test(file.name);
        const geoMesh = await parseLocalModel(getFilePath(file), null, async () => {
          const text = await file.text();
          return isObj ? parseOBJText(text, file.name) : parseGOCADTS(text);
        });
        geoMesh.source = { fileName: file.name };
        // ★ 解析成功 → 异步写几何缓存（真实磁盘路径 + 修改时间 + 大小 为钥匙）
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
  // 批量导入收尾：整批文件加载完后统一刷新一次视图/图例/相机（P0-3）
  if (lastModelId) {
    updateLegend();
    updateRenderOrder();
    fitViewToAll();
    selectLayer(lastModelId);
    buildAxisLabels();
  }

  // 重置 input 以便重复选择同一文件
  } finally {
    hideImportLoading();
    fileInput.value = '';
  }
});

// ============================================================
// 加载模型到场景
// ============================================================
function loadModelToScene(geoMesh, category, fileName, options) {
  options = options || {};
  // 防重复：同名文件若已存在则跳过
  const regionId = options.regionId || (window.researchRegions ? researchRegions.ownerOf(pendingCategoryItem) : undefined);
  const existing = state.models.find(m => m.fileName === fileName && (!regionId || m.regionId === regionId));
  if (existing) {
    console.warn('[loadModelToScene] A model with this name already exists, Skip: ' + fileName);
    return;
  }

  // ★ 按当前标签页的 state.origin 应用偏移
  //   - 若 state.origin 尚未初始化，用 geoMesh.fileOrigin 作为本标签的 origin
  //   - 不同标签页可有不同 origin，从而支持不同坐标系统的模型分标签显示
  //   - geoMesh.vertices 存储的是原始轴交换坐标（未减 origin），缓存中保持纯净
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

  // 应用 origin 偏移：生成新的顶点数组（不修改缓存中的原始 geoMesh.vertices）
  //   坐标映射（来自 parseGOCADTS，仅做轴交换）：
  //     rawThreeX = GOCAD_X          →  threeX = rawThreeX - ox
  //     rawThreeY = GOCAD_Z（高程）   →  threeY = rawThreeY - oz
  //     rawThreeZ = -GOCAD_Y（北取反）→  threeZ = rawThreeZ + oy
  const rawVerts = geoMesh.vertices;
  const offsetVerts = new Float32Array(rawVerts.length);
  for (let i = 0; i < rawVerts.length; i += 3) {
    offsetVerts[i]     = rawVerts[i]     - ox;
    offsetVerts[i + 1] = rawVerts[i + 1] - oz;
    offsetVerts[i + 2] = rawVerts[i + 2] + oy;
  }

  // 转 BufferGeometry
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(offsetVerts, 3));
  geo.setIndex(new THREE.Uint32BufferAttribute(geoMesh.indices, 1));
  geo.computeVertexNormals();

  // ★ 已在解析阶段做全局原点偏移+轴转换，此处不再独立居中
  // （独立居中会破坏多个模型间的相对空间关系）

  // 颜色/透明度解析优先级：
  //   ① options.color     —— 调用方明确指定（如地球化学模型按数值计算的颜色）
  //   ② FILE_COLOR_RULES  —— 按文件名匹配需求文档约定的颜色（保证不同文件颜色一致）
  //   ③ CATEGORY_COLORS   —— 分类默认色兜底（未知名文件）
  let color;
  if (options.color !== undefined) {
    color = options.color;
  } else {
    // 保证每个导入模型颜色互不相同（不论是否同一分类）：
    //   优先采用 FILE_COLOR_RULES 约定色 / 分类默认色，若该色已被场景内其它模型占用则从高区分度调色板取新色
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
    // 嵌套品位壳体需要透出内层；只针对地球化学 TS，保持地质模型原有深度行为。
    depthWrite: category !== 'Geochemistry'
  });

  // 如果剖切模式开启，附加当前启用的剖切平面
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
  // 在 mesh 上记录 modelId，作为 Raycaster 拾取的兜底匹配
  mesh.userData.modelId = modelId;
  scene.add(mesh);

  // 移除占位立方体
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
    filePath: options.filePath || null,        // 原始文件路径（项目保存用）
    strFilePath: options.strFilePath || null,  // 坑道模型 .str 路径（项目保存用）
    geoMesh: geoMesh,
    treeFileNode: null,
    inScene: true  // 是否在三维场景中显示（false=已从视图移除，可拖拽恢复）
  };
  state.models.push(modelObj);

  // 缓存模型数据（跨标签共享：其他标签可从缓存加载同名模型）
  if (geoMesh.terrainInfo && typeof applyTerrainDisplay === 'function') applyTerrainDisplay(modelObj, options.terrainSettings);
  const cacheEntry = { geoMesh, category, options: Object.assign({}, options, { regionId }) };
  geoMeshCache.set(fileName, cacheEntry);
  geoMeshCache.set(modelId, cacheEntry);

  // 在项目树对应分类文件夹下添加文件名节点
  if (!options || !options.skipTreeNode) {
    addFileNodeToCategory(pendingCategoryItem, fileName, modelObj);
  }

  // 图层管理添加图层项
  addLayerItem(modelObj);

  // 批量导入时（options.deferSceneRefresh=true）跳过收尾刷新，由调用方在整批
  // 文件加载完成后统一执行一次（见 fileInput change 处理器末尾），
  // 避免一次导入 N 个文件就重复 N 次 updateLegend/fitViewToAll 等全量刷新。
  if (!options.deferSceneRefresh) {
    // 更新图例
    updateLegend();

    // 设置 renderOrder
    updateRenderOrder();

    // 调整相机
    fitViewToAll();

    // 选中该图层
    selectLayer(modelId);

    // 刷新坐标轴标签
    buildAxisLabels();
  }
  return modelObj;
}

// 在分类下添加文件名节点
function addFileNodeToCategory(categoryItem, fileName, modelObj) {
  const nested = categoryItem.nextElementSibling;
  if (!nested || !nested.classList.contains('lp-nested-items')) return;
  // 防重复：同名文件节点已存在则跳过
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
  // 拖拽：记录 JSON {type:'file', modelId}，drop 到画布时恢复显示
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
// 图层管理
// ============================================================
let lmList = document.getElementById('lm-list');
let lmEmpty = document.getElementById('lm-empty');
const normalLayerEmpty = lmEmpty;

// ============================================================
// 模型从三维视图移除 / 恢复（保留 modelObj 和项目树节点，可拖拽恢复）
// ============================================================

// 从三维视图移除单个模型（图层条目删除 + mesh 从场景移除 + 项目树变灰）
function removeModelFromView(model) {
  if (!model) return;
  // 1. mesh 从场景移除
  if (model.mesh && model.mesh.parent) model.mesh.parent.remove(model.mesh);
  model.inScene = false;
  // ★ 第 71 节：这里【不再】把 model.visible 置 false，而是记录"移除前的可见性"。
  //   原因：❌ 的语义是"从三维视图移除"，与"被眼睛隐藏"是两件独立的事。
  //   若在此把 visible 一并置 false，则「眼睛隐藏 → ❌ → 从项目树拖回」会丢失
  //   用户原先的隐藏意图（拖回来又变成可见的），且 addLayerItem 无法区分二者。
  //   故用 _visibleBeforeRemove 暂存原值，由 addModelToView 还原。
  model._visibleBeforeRemove = (model.visible !== false);
  model.visible = false;
  // 2. 删除图层管理条目
  const lmItem = lmList.querySelector('.lm-item[data-model-id="' + model.id + '"]');
  if (lmItem) lmItem.remove();
  // 3. 项目树文件名变灰
  if (model.treeFileNode) model.treeFileNode.classList.add('dim');
  // 4. 若当前选中是该模型，清除选中
  if (state.selectedModelId === model.id) {
    clearSelectionState();
  }
  // 5. 刷新图例/坐标轴/空状态
  updateLegend();
  buildAxisLabels();
  const visibleModels = state.models.filter(m => m.inScene);
  if (visibleModels.length === 0) lmEmpty.style.display = '';
}

// 恢复模型到三维视图（mesh 加回场景 + 添加图层条目 + 项目树恢复）
function addModelToView(model) {
  if (!model) return;
  if (model.inScene) return; // 已在场景中，无需重复添加
  // 1. mesh 加回场景
  scene.add(model.mesh);
  model.inScene = true;
  // ★ 第 71 节：还原"被移除前的可见性"，而不是一律置为可见。
  //   _visibleBeforeRemove 由 removeModelFromView 记录（见那里的说明）。
  //   未记录过（首次加载 / 非取回路径）时默认可见，与既有行为保持一致。
  const restoreVisible = (model._visibleBeforeRemove !== false);
  model.visible = restoreVisible;
  model.mesh.visible = restoreVisible;
  delete model._visibleBeforeRemove;
  // 2. 添加图层管理条目
  addLayerItem(model);
  // 3. 项目树文件名恢复
  if (model.treeFileNode) model.treeFileNode.classList.remove('dim');
  // 4. 移除占位立方体
  if (state.placeholderMesh) {
    scene.remove(state.placeholderMesh);
    state.placeholderMesh.geometry.dispose();
    state.placeholderMesh.material.dispose();
    state.placeholderMesh = null;
    const _ep = document.getElementById('empty-placeholder');
    if (_ep) _ep.classList.add('hidden');
  }
  // 5. 刷新图例/坐标轴
  updateLegend();
  updateRenderOrder();
  buildAxisLabels();
}

function addLayerItem(model, allowAutoTop) {
  // 防重复：同 model-id 的条目已存在则跳过
  const existing = lmList.querySelector('.lm-item[data-model-id="' + model.id + '"]');
  if (existing) return;
  // 隐藏空状态
  lmEmpty.style.display = 'none';

  const item = document.createElement('div');
  const isDrillLike = !!(model.isCollarPoints || model.isDrillhole || model.isLithologyDrillhole || model.isGeochemDrillhole);
  item.className = 'lm-item'
    + (model.isRegisterPlane ? ' is-register-plane' : '')
    + (isDrillLike ? ' lm-drill-item' : ' lm-model-item');
  item.setAttribute('data-model-id', model.id);
  item.draggable = true;

  const pct = Math.round(model.opacity * 100);
  // 第 98 节：图层条目名称与项目树保持一致 —— 优先 displayName（重命名/属性/块体模型 GM 类都会写它），
  //   无 displayName 时回退 fileName（对既有模型完全向后兼容）。
  const lmDisplayName = model.displayName || model.fileName;

  // ===== 第 71 节：可见性「眼睛」按钮（钻孔类 / 非钻孔类两套模板共用）=====
  //   语义：只切换「是否在三维视图中显示」，图层条目始终保留在图层管理列表中。
  //   状态直接复用既有字段 model.visible —— 不新建状态（loadModelToScene 初始为 true，
  //   属性面板 L17587 已按 model.visible 显示"可见/隐藏"，此处与之一致）。
  //   图标用两个 span 叠加、由 CSS 按 .off 类切换显隐（见 .lm-eye 样式），
  //   避免在 JS 里反复重建 innerHTML 导致事件监听丢失。
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
    // ===== 钻孔类条目布局（同一水平线）：
    //   钻孔文件名(最左) | 🎨(统一颜色/设置入口) | 粗细滑条 | 透明度滑条 | ❌(最右)
    //   不再显示红色颜色方块，也不再显示 ⚙️ 按钮
    let colorTitle = 'Drillhole settings';
    if (model.isGeochemDrillhole) colorTitle = 'Set color scale';
    else if (model.isLithologyDrillhole) colorTitle = 'Set lithology colors';
    const colorBtnHtml = '<span class="lm-litho-btn" title="' + colorTitle + '">🎨</span>';

    // 粗细滑条（普通/岩性/化探钻孔有圆柱半径；孔口点纯点无粗细）
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

    // 透明度滑条（带"透明度"标签提示）
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

  // ===== 非钻孔模型（地质模型 / 坑道 / 贴图平面等）：单行 [名称 | 色块 | 透明度 | 👁 | ❌] =====
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
// 第 74 节：图片（贴图平面）类图层新导入时自动置顶
// ============================================================
// 需求：「图层的默认顺序是图片在最上层」——且用户明确「仅新导入时置顶，之后可拖拽」。
//
// 背景：updateRenderOrder 的规则是「列表顶部 = renderOrder 最大 = 最后绘制」，
//   而 addLayerItem 原先一律 appendChild（追加到列表末尾）→ 新导入的图片反而排在最底部，
//   表现为「图片被其它图层压住」。此处把「图片类」条目的插入位置改为列表最前面，
//   由随后的 updateRenderOrder 赋予它最大 renderOrder → 渲染时最后绘制 → 显示在最上层。
//
// 为什么做成独立函数而不是直接在 addLayerItem 里 prepend：
//   ① 保持「先 append 再搬移」的顺序，bindLayerItemEvents 的绑定不受影响；
//   ② 用户之后仍可自由拖拽调整（dragend 会重跑 updateRenderOrder，以最终 DOM 顺序为准）；
//   ③ 只在【新导入】这一条路径生效 —— 从项目恢复（restoreProject → addLayerItem）时，
//      若也强行置顶会打乱用户已保存的自定义顺序，故用 allowAutoTop 显式区分。
//
// 判定「图片类」：model.isRegisterPlane === true（三点配准贴图平面，唯一标识字段）。
function reorderImageLayerToTop(item, model, allowAutoTop) {
  if (!item || !model) return;
  if (!model.isRegisterPlane) return;
  // allowAutoTop === false 时跳过（用于「恢复项目」路径，尊重用户已保存的顺序）
  if (allowAutoTop === false) return;
  if (item.parentNode !== lmList) return;
  if (lmList.firstElementChild === item) return;   // 已在最前
  lmList.insertBefore(item, lmList.firstElementChild);
}

// ============================================================
// 全局唯一的滑条拖拽委托：所有透明度/粗细滑条共用一对 document 监听器，
// 避免「每添加一个图层项 / 每次打开设置面板」都重复绑定并永久累积
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
  // 透明度滑条（钻孔类条目内含粗细 + 透明度两根滑条，须精确定位透明度那根）
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

  // ❌ 从三维视图移除（图层条目删除 + mesh 移除 + 项目树变灰，可拖拽恢复）
  // ★ 重要：这里必须按「单个模型」处理，不能按「类别」处理。
  //   线/点类别下可含多个独立文件（如 DXF + GeoJSON + CSV 各一个），它们共用同一个
  //   lineLayerId / pointLayerId。若按类别 ID 去 state.models 过滤，会把同类别下
  //   所有文件一起删掉——而它们本质是彼此独立的文件（用户明确要求：删一个只影响一个，
  //   且左树对应文件节点必须保留）。
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeModelFromView(model);
  });

  // 👁 第 71 节：切换「是否在三维视图中显示」——条目保留，与上面的 ❌ 彻底移除严格区分。
  //   实现要点：
  //   1) 只翻 model.visible，并同步 model.mesh.visible（mesh 始终留在场景里，inScene 不变）；
  //   2) 用 mesh.visible 而非把 mesh 从 scene 摘除 —— 摘除会丢失它在场景树中的位置，
  //      且与 inScene 语义混淆（inScene=false 意味着"已从视图移除，条目应消失"）；
  //   3) 不要在这里调用 updateRenderOrder / updateLegend 的昂贵重建（每次点击都重跑没必要），
  //      但图例与属性面板需要同步，否则用户看到「图层隐藏了、图例还亮着」会以为没生效。
  const eyeBtn = item.querySelector('.lm-eye');
  if (eyeBtn) {
    eyeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowVisible = (model.visible === false);   // 当前隐藏 → 本次要显示
      model.visible = nowVisible;
      if (model.mesh) model.mesh.visible = nowVisible;
      // 选中描边跟随主体一起显隐（描边是 mesh 的子节点，父节点隐藏时它自然不渲染，
      // 但描边自身带 visible 标记，这里同步一次以防后续单独操作描边）
      if (state.selectionOutline && model.mesh && state.selectionOutline.parent === model.mesh) {
        state.selectionOutline.visible = nowVisible;
      }
      // 更新按钮与条目自身的视觉状态（图标由 CSS 按 .off 类切换）
      eyeBtn.classList.toggle('off', !nowVisible);
      eyeBtn.title = nowVisible ? 'Show in 3D view (Click to hide) ' : 'Hide in 3D view (Click to show) ';
      item.classList.toggle('lm-hidden', !nowVisible);
      // 联动：图例、坐标轴标签、属性面板
      updateLegend();
      buildAxisLabels();
      if (state.selectedModelId === model.id) refreshCurrentProperties();
    });
  }

  // 🎨 统一颜色/设置入口：按钻孔类型打开对应面板
  //   岩性钻孔 → 岩性分色面板；化探钻孔 → 色阶面板；单色钻孔/孔口点 → 钻孔设置面板
  if (lithoBtn) {
    lithoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (model.isGeochemDrillhole) openGeochemColorPanel(model);
      else if (model.isLithologyDrillhole) openLithologyColorPanel(model);
      else if (model.isPointLayer) openPointColorPanel(model);
      else openDrillSettingPanel(model);
    });
  }
  // ⚙️ 旧入口兼容（当前钻孔类已不渲染此按钮）
  if (settingBtn) {
    settingBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDrillSettingPanel(model);
    });
  }

  // 颜色方块（钻孔类条目已不再渲染）：岩性/化探 → 对应颜色面板；普通模型 → 单色选择器
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
      // 普通模型 / 单色钻孔 / 孔口点：颜色方块 → 单色选择器，统一改色
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

  // 透明度滑条（联动：实时刷新属性面板）
  function updateOpacity(clientX) {
    const rect = slider.getBoundingClientRect();
    let p = (clientX - rect.left) / rect.width;
    p = Math.max(0, Math.min(1, p));
    const percent = Math.round(p * 100);
    sfill.style.width = percent + '%';
    sthumb.style.left = percent + '%';
    opVal.textContent = percent + '%';
    // 多材质模型（钻孔轨迹）：统一调透明度；普通模型：单材质
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
      // 联动：滑条拖动时同步刷新属性面板（节流不严格要求）
      if (state.selectedModelId === model.id) refreshCurrentProperties();
    };
    updateOpacity(e.clientX);
  });

  // 钻孔粗细滑条（外置于图层条目，与 🎨 面板共享 model.radius 与 model._lmRadiusMax）
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

  // 双击图层项 → 相机聚焦到该模型
  item.addEventListener('dblclick', (e) => {
    if (e.target.closest('.lm-delete') || e.target.closest('.lm-eye') || e.target.closest('.lm-ctl-wrap') || e.target.closest('.lm-color') || e.target.closest('.lm-litho-btn') || e.target.closest('.lm-setting-btn')) return;
    focusModel(model);
  });

  // 拖拽排序（联动：排序后同步 renderOrder + 属性面板）
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

// 更新 renderOrder（列表顶部 = renderOrder 最大）
function updateRenderOrder() {
  const items = Array.from(lmList.querySelectorAll('.lm-item'));
  // ★ 第 70 节：贴图平面不再特殊置顶（原为 renderOrder = 1000+）。
  //   背景：贴图材质已由 depthTest:false 改为 true，走正常遮挡。
  //   若仍给 1000+ 的渲染序号，会在深度值相近处（贴图与模型面几乎共面时）
  //   让贴图抢先绘制，残留「总是浮在最上面」的观感，与本次修复目标冲突。
  //   现状：贴图平面与其它模型一致，统一按图层列表顺序参与排序；
  //   新导入的图层由 addLayerItem 追加到列表末尾，故贴图也在列表末尾。
  //   若希望贴图始终显示在最上层，请在图层列表中把它拖到最上方（renderOrder 已达最大）。
  items.forEach((item, idx) => {
    const model = state.models.find(m => m.id === item.getAttribute('data-model-id'));
    if (model && model.mesh) model.mesh.renderOrder = items.length - idx;
  });
}

// ============================================================
// 岩性颜色设置面板：列出每种岩性类别 + 色块 + hex，点击色块改色并实时同步
// ============================================================
const lithoPanel = document.getElementById('litho-panel');
const lithoPanelBody = document.getElementById('litho-panel-body');
const lithoPanelFooter = document.getElementById('litho-panel-footer');
const lithoPanelTitle = lithoPanel.querySelector('.litho-panel-header span');
let lithoPanelModelId = null; // 当前面板绑定的岩性钻孔模型 id

// ===== §81 草稿机制：面板内的一切改色先记草稿（只做内存预览），确认才落地 =====
//   lithoDraft    : Map<岩性名, '#rrggbb'>  本次面板会话里被改过的岩性（只有这些会在确认时落盘）
//   lithoSnapshot : { 岩性名: colorInt }    打开面板时的原始色，取消/关窗时据此还原
//   lithoSelVein  : 当前选中的岩性行（点下方地层色块时的套用目标；null = 走同名自动匹配）
//   注意：草稿期间**不写** state.lithologyColors、不调 updateLegend()、不落盘 ——
//         避免"还没确认就把项目数据改了"。取消时把材质与 lithologyTypes 还原即可。
let lithoDraft = null;
let lithoSnapshot = null;
let lithoSelVein = null;

// 关闭面板（不做任何询问/还原，调用方负责）
function closeLithoPanel() {
  lithoPanel.classList.remove('visible');
  lithoPanelFooter.style.display = 'none';
  lithoPanelModelId = null;
  lithoDraft = null;
  lithoSnapshot = null;
  lithoSelVein = null;
}

// 还原草稿：把材质与 lithologyTypes 恢复成打开面板时的样子
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

// 关闭请求（× 与「取消」共用）：有未确认改动时先问一句，避免手滑丢掉改动
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

// 确认：把草稿一次性落地（写全局字典 + 刷图例 / 图层色块 + 静默持久化）
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

// 打开岩性颜色面板（绑定到指定岩性钻孔模型）
function openLithologyColorPanel(model) {
  if (!model || !model.isLithologyDrillhole) return;
  lithoPanelModelId = model.id;
  lithoPanelTitle.textContent = 'Drillhole lithology colors';   // 化探面板会改写标题，此处必须复位
  lithoPanelFooter.style.display = 'flex';
  lithoDraft = new Map();
  lithoSnapshot = {};
  lithoSelVein = null;
  (model.lithologyTypes || []).forEach(lt => { lithoSnapshot[lt.name] = lt.color; });
  renderLithoPanelBody(model);
  lithoPanel.classList.add('visible');
}

// 草稿改色：只改内存预览（材质 + lithologyTypes），不写 state.lithologyColors、不刷图例、不落盘
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

// 「同名一键套用」：把所有能与地层对上名字的岩性一次性改成地层色（同样只写草稿）
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

// 渲染面板内容：
//   上半 = 每种岩性一行（色块 + 名称 + hex），点色块取色、点行选中；
//   下半 = §81 新增的「三维地质模型」地层色块区。
function renderLithoPanelBody(model) {
  const keepTop = lithoPanelBody.scrollTop;   // 重绘后恢复滚动位置，避免连点时跳顶
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
    // 点行 = 选中/取消选中（作为下方地层色块的套用目标）
    row.addEventListener('click', (e) => {
      if (e.target.closest('.litho-swatch')) return;
      lithoSelVein = (lithoSelVein === lt.name) ? null : lt.name;
      renderLithoPanelBody(model);
    });
    const swatch = row.querySelector('.litho-swatch');
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      // 弹出原生颜色选择器（改动只写草稿，点确认后才落地）
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = hex;
      picker.style.position = 'fixed';
      picker.style.left = '-9999px';
      document.body.appendChild(picker);
      picker.click();
      picker.addEventListener('input', () => {
        // 局部更新（不整块重绘），否则连续拖动取色会闪
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

// 下半部：三维地质模型地层色块区
//   点色块 → 有选中行则套给该行；没选行则按【同名】自动找目标；都对不上则给提示。
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
      // 目标：优先「选中的岩性行」；没选行则按同名自动找
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

// 更新色块区下方提示（重绘后按 id 重新定位，避免持有失效引用）
function setGeoHint(text) {
  const el = lithoPanelBody.querySelector('#litho-geo-hint');
  if (el) el.textContent = text;
}

// 应用岩性颜色变更（内核）：写字典 + 刷材质 + 同步其他钻孔模型 —— 不做任何界面刷新
//   §80：从 applyLithologyColor 拆出，供「按三维地层配色」批量调用。
//   批量场景若逐个调 applyLithologyColor，会触发 N 次 updateLegend()（遍历全模型 + 重建图例 DOM），
//   岩性种类多时肉眼可见卡顿 —— 故拆出内核：循环只改数据，末尾统一刷新一次。
function applyLithologyColorCore(model, veinName, hexStr) {
  const newColor = parseInt(hexStr.replace('#', ''), 16);
  // 1. 写入全局持久化映射（跨模型共享）
  state.lithologyColors[veinName] = hexStr;
  // 2. 更新该模型内匹配岩性的所有段材质
  if (model.mesh) {
    model.mesh.traverse(obj => {
      if (obj.userData && obj.userData.isDrillhole && obj.userData.vein === veinName && obj.material) {
        obj.material.color.setHex(newColor);
      }
    });
  }
  // 3. 更新模型的 lithologyTypes（图例 + 面板下次渲染）
  const lt = model.lithologyTypes.find(t => t.name === veinName);
  if (lt) lt.color = newColor;
  // 4. 同步其他在场景中的岩性钻孔模型（同岩性统一改色）
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

// 应用岩性颜色变更：内核 + 图例 + 图层色块（单次改色入口，如岩性颜色面板取色器）
function applyLithologyColor(model, veinName, hexStr) {
  applyLithologyColorCore(model, veinName, hexStr);
  // 5. 同步图例
  updateLegend();
  // 6. 同步图层条目色块（取第一个岩性色作为代表色）
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
// §80／§81：钻孔岩性与三维地层的配色对照
//   · §80 原为「图层管理条目右键 → 按三维地层配色」的一次性批量匹配；
//   · §81 改为【面板内手工配对】：入口取消，配色改在「钻孔岩性颜色设置」面板
//     下半部的地层色块区里点选，并统一走「草稿 → 确认」提交。
//   · 匹配仍只做【精确同名】（忽略大小写 / 空白 / 扩展名 / 全角括号），不做包含匹配 ——
//     包含匹配会让「Q」撞上一切含 Q 的名字，属误配。命名写法不同的场合手工点色块即可。
// ============================================================

// 名称归一化：大小写、首尾与内部空白、扩展名、全角括号、长横线
function normalizeGeoLayerName(s) {
  if (s == null) return '';
  let t = String(s).trim().toLowerCase();
  t = t.replace(/\.[a-z0-9]{1,6}$/, '');                  // 去扩展名（.ts / .obj / .dtm …）
  t = t.replace(/[\s\u3000]+/g, '');                      // 去所有空白（含全角空格）
  t = t.replace(/\uff08/g, '(').replace(/\uff09/g, ')');  // 全角括号 → 半角
  t = t.replace(/[\u2013\u2014\uff0d]/g, '-');            // 长横线 / 全角减号 → 半角连字符
  return t;
}

// 收集「场景中的三维地质模型」：每个模型一条记录（带它的全部别名键）
//   排除：钻孔自身、点/线图层、图片配准平面、无几何的表格类，
//         以及已从三维视图移除（inScene=false）的模型。
//   返回 [{ name, color, keys, model }]；name 为展示名（去掉扩展名），keys 为归一化别名。
//   ★ 面板要「一个模型一行」，故必须按模型聚合 —— 否则同名别名会让左栏重复出现多行。
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

// 归一化名称 → 模型当前颜色（int）；同名多个取先遇到的（"同名一键套用"用）
function collectGeoLayerColorMap() {
  const map = new Map();
  collectGeoLayerEntries().forEach(e => {
    e.keys.forEach(k => { if (!map.has(k)) map.set(k, e.color); });
  });
  return map;
}

// ============================================================
// 地球化学色阶设置面板
//   · 经典 diverging 配色方案（RdBu）
//   · 自定义两端颜色（低值色 / 高值色）
//   · 实时预览渐变条 + 数值范围标签
// ============================================================
const geochemHeader = lithoPanel.querySelector('.litho-panel-header span');

// 打开 geochem 色阶设置面板（复用 lithoPanel DOM，通过标题区分内容）
function openGeochemColorPanel(model) {
  if (!model || !model.isGeochemDrillhole) return;
  lithoPanelModelId = model.id;
  // ★ §81：本面板复用同一个 .litho-panel DOM —— 必须收起岩性面板的「取消/确认」栏并清掉草稿，
  //        否则化探面板底部会冒出一对不该有的按钮。
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
  // 预览渐变条
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

  // 配色方案行
  const schemeRow = document.createElement('div');
  schemeRow.className = 'geochem-row';
  schemeRow.innerHTML =
    '<span class="drill-setting-label">Color scheme</span>' +
    '<select class="geochem-select" id="geochem-scheme-select">' +
      '<option value="rdbu"' + (cfg.scheme !== 'custom' ? ' selected' : '') + '>Classic RdBu (Blue→Cyan→Green→Yellow→Red) </option>' +
      '<option value="custom"' + (cfg.scheme === 'custom' ? ' selected' : '') + '>Custom endpoint colors</option>' +
    '</select>';
  lithoPanelBody.appendChild(schemeRow);

  // 低值色行
  const lowRow = document.createElement('div');
  lowRow.className = 'drill-setting-row';
  lowRow.innerHTML =
    '<span class="drill-setting-label">Low-value color</span>' +
    '<div class="drill-setting-swatch" id="geochem-low-swatch" style="background:' + cfg.lowColor + '"></div>' +
    '<span class="drill-setting-hex" id="geochem-low-hex">' + cfg.lowColor.toUpperCase() + '</span>';
  lithoPanelBody.appendChild(lowRow);

  // 高值色行
  const highRow = document.createElement('div');
  highRow.className = 'drill-setting-row';
  highRow.innerHTML =
    '<span class="drill-setting-label">High-value color</span>' +
    '<div class="drill-setting-swatch" id="geochem-high-swatch" style="background:' + cfg.highColor + '"></div>' +
    '<span class="drill-setting-hex" id="geochem-high-hex">' + cfg.highColor.toUpperCase() + '</span>';
  lithoPanelBody.appendChild(highRow);

  // 恢复默认按钮
  const resetRow = document.createElement('div');
  resetRow.style.cssText = 'display:flex;justify-content:flex-end;padding-top:6px;';
  resetRow.innerHTML =
    '<button class="geochem-reset-btn" id="geochem-reset-btn" style="font-size:11px;padding:4px 10px;background:#f6f8fa;border:1px solid #d0d7de;border-radius:4px;cursor:pointer;color:#24292f;">Restore classic color scale</button>';
  lithoPanelBody.appendChild(resetRow);

  // 事件绑定
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

// 应用色阶变更到模型所有段材质 + 同步图例 + 图层色块
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
// 钻孔设置面板：根据模型类型动态渲染设置项
//   孔口点    → 图标颜色 + 字体颜色
//   单色钻孔  → 轨迹颜色 + 圆柱粗细
//   岩性钻孔  → 圆柱粗细（颜色由 🎨 面板管理）
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

// 构建颜色行（色块 + hex 值）
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

// 构建粗细滑条行（滑条 + 数值）
function buildRadiusRow(model, currentRadius, onChange) {
  // 滑条范围：0.1 ~ 当前半径的 5 倍（至少 10）
  // 与图层条目上的粗细滑条共享 model._lmRadiusMax，保证两处滑条量程一致
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

// —— 应用孔口图标颜色（小球） ——
function applyCollarIconColor(model, hexStr) {
  const newColor = parseInt(hexStr.replace('#', ''), 16);
  model.color = newColor;
  if (model.materials) model.materials.forEach(mt => mt.color.setHex(newColor));
  // 同步图层色块
  syncLayerColorBox(model, hexStr);
  updateLegend();
}

// —— 应用孔口标签字体颜色（重建 canvas texture） ——
function applyCollarLabelColor(model, hexStr) {
  model.labelColor = hexStr;
  if (!model.mesh) return;
  // 先收集所有标签（避免遍历中修改树结构）
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
    // 释放旧 texture + material
    if (obj.material && obj.material.map) obj.material.map.dispose();
    if (obj.material) obj.material.dispose();
    model.mesh.remove(obj);
    model.mesh.add(newLabel);
  });
}

// —— 应用单色钻孔轨迹颜色 ——
function applySurveyColor(model, hexStr) {
  const newColor = parseInt(hexStr.replace('#', ''), 16);
  model.color = newColor;
  if (model.materials) model.materials.forEach(mt => mt.color.setHex(newColor));
  syncLayerColorBox(model, hexStr);
  updateLegend();
}

// —— 应用钻孔圆柱粗细（重建所有段几何体） ——
function applyDrillholeRadius(model, newRadius) {
  model.radius = newRadius;
  // 同步图层条目上的粗细滑条显示（图层条目 / 🎨 面板两处联动）
  syncLayerRadius(model, newRadius);
  if (!model.mesh) return;
  model.mesh.traverse(obj => {
    if (obj.userData && obj.userData.isDrillhole && obj.userData.segStart && obj.userData.segEnd) {
      // 重建几何体（保持位置/朝向不变，仅改 radius）
      if (obj.geometry) obj.geometry.dispose();
      obj.geometry = new THREE.CylinderGeometry(newRadius, newRadius, obj.userData.segLen, 12);
    }
  });
}

// —— 同步图层条目粗细滑条（面板内调整粗细时回写图层条目） ——
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

// —— 同步图层条目颜色方块 ——
function syncLayerColorBox(model, hexStr) {
  const lmItem = lmList.querySelector('.lm-item[data-model-id="' + model.id + '"]');
  if (lmItem) {
    const colorBox = lmItem.querySelector('.lm-color');
    if (colorBox) colorBox.style.background = hexStr;
  }
}

// 选中图层（联动：三维模型黄色高亮描边）
function selectLayer(modelId) {
  state.selectedModelId = modelId;
  document.querySelectorAll('.lm-item').forEach(i => {
    i.classList.toggle('selected', i.getAttribute('data-model-id') === modelId);
  });
  const model = state.models.find(m => m.id === modelId);
  // 联动：切换选中 → 更新三维画布中的高亮描边
  showSelectionOutline(model);
  // 联动：右侧属性面板显示该模型属性
  if (model) showModelProperties(model);
}

// 激活右侧面板指定标签页（按 data-tab 匹配），用于模型选中联动
// 限定在「当前生效的页签组」内操作，避免误切到另一组（面板已分 drill / doc 两套）
function activateRightTab(name) {
  // 该入口只由三维钻孔 / 模型选中链路调用，此时必然处于钻孔场景
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

// 显示模型属性（同步更新右侧面板 + 底部属性窗口）
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

  // —— 属性表信息（阶段2：导入属性表后，在此展示关联的业务字段） ——
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

  // 仅更新底部属性窗口 (bp-*)
  const bpEmpty = document.getElementById('bp-empty');
  const bpProps = document.getElementById('bp-model-props');
  if (bpEmpty) bpEmpty.style.display = 'none';
  if (bpProps) { bpProps.style.display = 'block'; bpProps.innerHTML = html; }
  if (typeof renderTerrainInfo === 'function') renderTerrainInfo(model, bpProps);
}

// 双击钻孔对象：在「模型属性」界面显示该钻孔的相关属性
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
// 图例更新
// ============================================================
function updateLegend() {
  const legend = document.getElementById('scene-legend');
  const titleEl = legend.querySelector('.scene-legend-title');
  const emptyEl = document.getElementById('legend-empty');
  legend.querySelectorAll('.legend-item').forEach(el => el.remove());
  legend.querySelectorAll('.legend-geobar').forEach(el => el.remove());

  // ★ 第 71 节：图例只统计「在场景中 且 未被眼睛隐藏」的模型。
  //   原先只看 m.inScene —— 眼睛按钮只切 visible 不摘 mesh，若图例仍按 inScene 过滤，
  //   点眼睛隐藏后图例条目不会消失，用户会误判"按钮没生效"。
  const visibleModels = state.models.filter(m => m.inScene && m.visible !== false);
  if (visibleModels.length === 0) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  visibleModels.forEach(m => {
    // —— 地球化学钻孔：显示渐变条 + min/max 数值范围 + 属性名 ——
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
    // 钻孔模型：按岩性类型显示多色图例
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
// 工具栏按钮功能
// ============================================================

// 1. 清空：清空三维视图所有模型 + 删除图层条目 + 测距/剖切/高亮 + 退出测距模式
document.getElementById('btn-clear-all').addEventListener('click', () => {
  // 清空三维视图所有模型（mesh 从场景移除 + 图层条目删除 + 项目树变灰，modelObj 保留可拖拽恢复）
  state.models.forEach(m => {
    if (m.inScene) removeModelFromView(m);
  });

  // 清除测距线段和拾取点
  state.rulerPoints.forEach(p => scene.remove(p));
  state.rulerLines.forEach(l => scene.remove(l));
  state.rulerPoints = [];
  state.rulerLines = [];
  // 清除所有测距图层条目
  lmList.querySelectorAll('.lm-measure-item').forEach(el => el.remove());
  state.rulerItems = [];
  cleanupMeasureDrag();

  // 关闭剖切
  if (state.clipMode) {
    state.clipMode = false;
    btnClip.classList.remove('active');
    disableClipping();
  }

  // 取消图层选中高亮（三维描边 + 左侧选中 + 属性面板）
  clearSelectionState();

  // 退出测距模式
  if (state.measureMode) {
    state.measureMode = false;
    btnMeasure.classList.remove('active');
    canvas.classList.remove('measuring');
    controls.enabled = true;
  }

  // 显示空状态占位
  const visibleModels = state.models.filter(m => m.inScene);
  if (visibleModels.length === 0) {
    lmEmpty.style.display = '';
  }
});

// 2. 复位：重置视角（优先聚焦选中模型，否则观察全部）
document.getElementById('btn-reset-view').addEventListener('click', () => {
  if (state.models.length > 0) {
    fitViewToAll();
  } else {
    controls.reset();
  }
});

// 3. 测距
const btnMeasure = document.getElementById('btn-measure');
btnMeasure.addEventListener('click', () => {
  state.measureMode = !state.measureMode;
  btnMeasure.classList.toggle('active', state.measureMode);
  canvas.classList.toggle('measuring', state.measureMode);
  if (state.measureMode) {
    // 进入测距模式时禁用相机旋转
    controls.enabled = false;
    controls._isRotating = false;
  } else {
    controls.enabled = true;
    // 退出时清理未完成的拖拽
    cleanupMeasureDrag();
  }
});

// 测距拾取
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// 测距拖拽状态
let measureDragging = false;
let measureStartPoint = null;
let measurePreviewLine = null;
let measurePreviewSprite = null;
let measureStartSphere = null;

// 射线拾取三维点（优先模型，其次地面平面）
function pickPoint3D(e) {
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  // 优先与模型相交（仅拾取当前在场景中显示的模型）
  const inSceneModels = state.models.filter(m => m.inScene);
  const modelMeshes = inSceneModels.map(m => m.mesh).filter(m => m && m.visible);
  if (modelMeshes.length > 0) {
    const hits = raycaster.intersectObjects(modelMeshes, false);
    if (hits.length > 0) return hits[0].point.clone();
  }
  // 与地面平面相交
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(plane, hitPoint)) return hitPoint.clone();
  return null;
}

// ★ 测距：mousedown 设端点 → mousemove 实时线段 → mouseup 结束
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // 仅左键
  if (!state.measureMode) return;
  const point = pickPoint3D(e);
  if (!point) return;

  measureDragging = true;
  measureStartPoint = point;

  // 动态比例尺
  const spriteScale = getMeasureSpriteScale();
  const yOffset = spriteScale * 0.8;
  const sphereR = spriteScale * 0.15;

  // 起点小球（荧光绿）
  const sphereGeo = new THREE.SphereGeometry(sphereR, 12, 12);
  const sphereMat = new THREE.MeshBasicMaterial({ color: 0x39FF14 });
  measureStartSphere = new THREE.Mesh(sphereGeo, sphereMat);
  measureStartSphere.position.copy(point);
  scene.add(measureStartSphere);

  // 预览线段（初始为零长度）
  const lineGeo = new THREE.BufferGeometry().setFromPoints([point, point.clone()]);
  const lineMat = new THREE.LineBasicMaterial({ color: 0x39FF14, linewidth: 3 });
  measurePreviewLine = new THREE.Line(lineGeo, lineMat);
  scene.add(measurePreviewLine);

  // 预览长度标签
  measurePreviewSprite = makeDistanceSprite('0.00 m', spriteScale);
  measurePreviewSprite.position.set(point.x, point.y + yOffset, point.z);
  scene.add(measurePreviewSprite);

  e.preventDefault();
});

canvas.addEventListener('mousemove', (e) => {
  if (!measureDragging || !state.measureMode) return;
  const point = pickPoint3D(e);
  if (!point) return;

  // 更新预览线段终点
  const positions = measurePreviewLine.geometry.attributes.position;
  positions.setXYZ(1, point.x, point.y, point.z);
  positions.needsUpdate = true;

  // 更新长度标签
  const distance = measureStartPoint.distanceTo(point);
  const midPoint = new THREE.Vector3().addVectors(measureStartPoint, point).multiplyScalar(0.5);
  const spriteScale = getMeasureSpriteScale();
  const yOffset = spriteScale * 0.8;

  // 更新 sprite 文字（移除旧的，创建新的）
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

  // 移除预览线段和预览 sprite
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
    // 没有拾取到终点，只保留起点球
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

  // 终点小球
  const endSphereGeo = new THREE.SphereGeometry(sphereR, 12, 12);
  const endSphereMat = new THREE.MeshBasicMaterial({ color: 0x39FF14 });
  const endSphere = new THREE.Mesh(endSphereGeo, endSphereMat);
  endSphere.position.copy(point);
  scene.add(endSphere);

  // 捕获起点球引用（必须在置 null 之前），供 rulerItem 引用与删除时清理
  const startSphere = measureStartSphere;
  measureStartSphere = null;

  // 最终线段
  const lineGeo = new THREE.BufferGeometry().setFromPoints([measureStartPoint, point]);
  const lineMat = new THREE.LineBasicMaterial({ color: 0x39FF14, linewidth: 3 });
  const line = new THREE.Line(lineGeo, lineMat);
  scene.add(line);

  // 最终长度标签（线段上方）
  const distance = measureStartPoint.distanceTo(point);
  const midPoint = new THREE.Vector3().addVectors(measureStartPoint, point).multiplyScalar(0.5);
  const sprite = makeDistanceSprite(distance.toFixed(2) + ' m', spriteScale);
  sprite.position.set(midPoint.x, midPoint.y + yOffset, midPoint.z);
  scene.add(sprite);

  // 保存到 rulerItems 和 rulerLines/rulerPoints（兼容清空）
  const rulerItem = { id: 'ruler-' + Date.now(), line, sprite, startSphere, endSphere, distance };
  state.rulerItems.push(rulerItem);
  state.rulerLines.push(line, sprite);
  state.rulerPoints.push(endSphere);
  if (startSphere) state.rulerPoints.push(startSphere);

  // 在图层管理中新增测距线条目
  addMeasureLayerItem(rulerItem);

  measureStartPoint = null;
});

// 退出测距模式时清理未完成的拖拽
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
  // 先计算射线（空白点取消需要）
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  // 测距模式下 click 不做任何事（拖拽已在 mousedown/mousemove/mouseup 处理）
  if (state.measureMode) return;

  // -------- 非测距模式 → 点击空白取消模型高亮选中 --------
  // 没有选中项时无需处理
  if (!state.selectedModelId && !state.selectionOutline) return;

  // 检测是否命中了任何在场景中可见的三维模型
  const inSceneModels = state.models.filter(m => m.inScene);
  const visibleModelMeshes = inSceneModels.map(m => m.mesh).filter(m => m && m.visible);
  let hasHitModel = false;
  if (visibleModelMeshes.length > 0) {
    const hits = raycaster.intersectObjects(visibleModelMeshes, false);
    if (hits.length > 0) hasHitModel = true;
  }
  // 未命中模型 → 清空选中高亮
  if (!hasHitModel) clearSelectionState();
});

// ★ 双击画布上的点小球 → 打开「编辑点」弹窗（改坐标 / 改属性值）
canvas.addEventListener('dblclick', (e) => {
  if (state.measureMode || pointAddMode) return;   // 测距/绘制模式下不干扰
  // 复用与右键菜单同一套拾取逻辑，避免两处各写一份射线/反查
  const hit = pickPointSphereAt(e.clientX, e.clientY);
  if (!hit) return;
  openPointAttrEditor(hit.model, hit.sphere);
});

function makeDistanceSprite(text, scale) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  c.width = 256; c.height = 64;
  // 荧光绿背景 + 圆角
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
  // 深色文字（荧光绿底配深色/黑色文字更清晰）
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

// 获取测距 sprite 适用的比例尺（基于场景包围盒）
function getMeasureSpriteScale() {
  const box = getSceneBoundingBox();
  if (box.isEmpty()) return 30;
  const size = box.getSize(new THREE.Vector3());
  const maxRange = Math.max(size.x, size.y, size.z);
  return maxRange * 0.04 + 5;
}

// ★ 画布双击 → 拾取模型 → 选中图层 + 三维高亮（不缩放视图）
canvas.addEventListener('dblclick', (e) => {
  // 测距模式下不做拾取（避免干扰测距点标记）
  if (state.measureMode) return;
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  // ★ 修复映射关系：只从 inScene 的模型中取 mesh
  // （scene.remove 过的 mesh 虽然 visible=true 但不在三维视图显示，不能参与拾取）
  const inSceneModels = state.models.filter(m => m.inScene);
  const modelMeshes = inSceneModels.map(m => m.mesh).filter(m => m && m.visible);
  if (modelMeshes.length === 0) return;
  const hits = raycaster.intersectObjects(modelMeshes, true);
  if (hits.length === 0) return;

  const hitMesh = hits[0].object;
  // 钻孔对象：双击显示该钻孔属性到「模型属性」界面
  if (hitMesh.userData && hitMesh.userData.holeid) {
    showHoleProps(String(hitMesh.userData.holeid));
    return;
  }
  // ★ 双重匹配，优先 userData.modelId（防止 mesh 对象引用错位），其次引用对比
  const meshModelId = hitMesh.userData.modelId;
  const hitModel = meshModelId
    ? state.models.find(m => m.id === meshModelId)
    : state.models.find(m => m.mesh === hitMesh);
  if (hitModel) {
    // 联动：选中图层 + 三维高亮（不触发相机聚焦缩放）
    selectLayer(hitModel.id);
  }
});

// ★ 画布拖拽接收：从项目树拖拽节点到画布，恢复显示
//   file     → 显示单个文件模型
//   category → 显示分类文件夹下所有文件（如矿体、地层）
//   model    → 显示模型文件夹下所有文件（如 xx矿区-A矿段、新地球化学模型）
// dragstart 时已当场收集子文件 modelIds 写入 payload.modelIds，drop 时直接读取
canvas.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

// ============================================================
// 二维联动：右键三维钻孔孔口 -> 右侧面板显示柱状图 / 岩芯 / 化验数据
// ============================================================

// 按 holeid 汇总钻孔数据（孔口 / 测斜 / 地球化学）
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
  // ★ 第 74 节：额外产出「宽表」形式（一行一个深度区间，多元素并列为列），
  //   供 buildAssayTableHtml 渲染成单张合并表。
  //   背景：源数据本身就是宽表（holeid,from,to,Au,Ag,S），但 collectDrillholeTables 会把它
  //   按元素拆成多个「属性子表」（geochemAttrs.Au / .Ag / .S），各自只带一个数值列。
  //   若仍按拆表渲染，用户看到的是「Au 一张表、Ag 一张表、S 一张表」，
  //   无法横向对比同一深度区间的多元素含量 —— 这正是本次要改的展示方式。
  const wide = buildAssayWideRows(tables, holeid);
  return { holeid: holeid, collar: collar, surveyList: surveyList, geochem: geochem, assayWide: wide };
}

// 把按元素拆分的化验子表，按「起始深度-终止深度」重新并回一张宽表
// 返回：{ headers: [{key,label}], rows: [ {from,to,values:{key:num}} ] }
//
// 合并键用 `from|to` 精确匹配（同一钻孔不同元素的采样区间通常完全一致）；
// 若某元素在该区间缺失，该格留空（'-'），不臆造数值。
function buildAssayWideRows(tables, holeid) {
  const attrs = Object.keys(tables.geochemAttrs || {});
  if (attrs.length === 0) return { headers: [], rows: [] };

  // 1) 收集各元素的「区间 → 数值」映射
  const perAttr = {};      // attr → Map("from|to" → row)
  const rangeOrder = [];   // 首次出现的区间顺序（保持源数据行序）
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

  // 2) 表头：起始深度 / 终止深度 + 各元素（附单位）
  const headers = [
    { key: '__from', label: 'From depth(m)' },
    { key: '__to',   label: 'End depth(m)' }
  ];
  attrs.forEach(a => headers.push({ key: a, label: a.toUpperCase() + '(' + assayUnitOf(a) + ')' }));

  // 3) 行：按首次出现的区间顺序
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

// 元素单位表（第 74 节）
//   金、银为贵金属，化验惯例用 g/t（克/吨）；
//   硫为常量组分，用 %（质量百分数）。
//   未登记的元素默认无单位，避免显示错误单位误导用户。
const ASSAY_UNITS = { AU: 'g/t', AG: 'g/t', S: '%' };
function assayUnitOf(attr) {
  const k = String(attr || '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(ASSAY_UNITS, k) ? ASSAY_UNITS[k] : '';
}

// 在图件管理指定分类下，找「文件名去扩展名 == holeid」的图片，返回图片 URL（无则 null）
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

// 从文件名提取深度数字（用于岩芯图片按深度排序）
// ★ 第 67 节重写，支持以下命名（按优先级）：
//   ① 区间式：`ZK1203_1到50m` / `ZK1203_1-50m` / `ZK1203_1~50m` → 取【下界 1】
//                （原实现用 /(\d+)\s*m/ 贪婪匹配，只能拿到上界 50，区间起点丢失）
//   ② 单值式：`ZK1203_50m` / `ZK1203_50.5m`                    → 取 50 / 50.5
//   ③ 无单位：`ZK1203_50`（取最后一段数字，且排除孔号本身的数字）
//   ④ 无法识别 → Infinity（排到最后）
function extractDepth(fileName) {
  const s = String(fileName || '');
  // 去掉扩展名，避免 "jpg" 干扰
  const base = s.replace(/\.[^.]+$/, '');

  // ① 区间式：数字 + (到|至|-|~|—|–) + 数字，可带 m
  //   例：ZK1203_1到50m / ZK1203_1-50m / ZK1203_1至50 / ZK1203_1~50m
  const range = base.match(/(\d+(?:\.\d+)?)\s*(?:到|至|-|~|—|–|--)\s*(\d+(?:\.\d+)?)\s*[mM]?/);
  if (range) return parseFloat(range[1]);   // ★ 取区间【下界】

  // ② 单值式：数字 + m（例 ZK1203_50m）
  const single = base.match(/(\d+(?:\.\d+)?)\s*[mM]\b/);
  if (single) return parseFloat(single[1]);

  // ③ 无单位：取「非孔号部分」的最后一个数字
  //   先剥离开头的孔号（字母+数字，如 ZK1203），避免把 1203 当成深度
  const stripped = base.replace(/^[A-Za-z]*\d+/, '');
  if (stripped !== base) {
    // 确实剥离掉了孔号 → 深度只能来自剩余部分；剩余部分没有数字就说明「无深度」
    // （不能回退到全文扫描，否则会把孔号里的 1203 误当深度）
    const nums = stripped.match(/\d+(?:\.\d+)?/g);
    return (nums && nums.length) ? parseFloat(nums[nums.length - 1]) : Infinity;
  }

  // ④ 文件名整体不含「字母+数字」形式的孔号前缀（如纯数字名 50、或中文名）
  //   此时最后一个数字就是深度
  const all = base.match(/\d+(?:\.\d+)?/g);
  if (all && all.length) return parseFloat(all[all.length - 1]);
  return Infinity;
}

// 岩芯资料：查找某钻孔的全部岩芯图片，**按深度排序**返回 [{name,url,depth}]
//
// ★ 第 67 节重写。原实现有两个问题：
//   ① 匹配过严：只认「子分类名 == 孔号」或「文件名(去扩展名) == 孔号」。
//      用户的 `ZK1203_1到50m.jpg` 去扩展名后是 `ZK1203_1到50m`，与 `ZK1203` 不等 →
//      两条路径全落空 → 面板显示「未找到」。
//   ② 兜底路径只 return 第一张，不排序、不继续收集 → 多张图只会显示一张。
//
// 新匹配规则（宽容递进），统一按深度升序排序后返回：
//   A. 「岩芯资料」下、子分类名 == 孔号（推荐用法，最精确）         → 收该子分类下全部图片
//   B. 「岩芯资料」下、文件名以「孔号 + 分隔符」开头                  → 收全部命中的图片
//      分隔符含 _ - . 空格 及中划线等（如 ZK1203_1到50m、ZK1203-50）
//   C. 「岩芯资料」下、文件名(去扩展名) == 孔号（单张整孔图的老用法）  → 收该张
//   D. 以上都为空时，再遍历「岩芯资料」的**下一级子分类**做同样的 B/C 匹配
//      （兼容用户把图放进别的子分类名下的情况）
// 优先级：A 命中即用 A；否则合并 B+C；再否则 D；最后再回退 A（A 为空容器时）
function findCoreImages(holeid) {
  const root = document.getElementById('subitems-drawing-mgmt');
  if (!root) return [];
  const target = String(holeid).trim().toLowerCase();
  if (!target) return [];

  // 收集某个 nested-items 容器里的图片（支持子分类名过滤，null = 全部）
  const collectFiles = (nested, filter) => {
    if (!nested || !nested.classList.contains('lp-nested-items')) return [];
    // 只取「直接子级」的图件节点，避免把更深层子分类里的图混进来
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

  // 文件名是否「属于」该孔号：前缀匹配（孔号后跟分隔符或直接结束）或完全相等
  const belongsTo = (fileName) => {
    const baseName = fileName.replace(/\.[^.]+$/, '').trim().toLowerCase();
    if (baseName === target) return true;                       // C：整孔一张
    if (!baseName.startsWith(target)) return false;             // B：必须以孔号开头
    const rest = baseName.slice(target.length);
    // 孔号后必须是分隔符（下划线/连字符/点/空格/中文间隔等），避免 ZK120 命中 ZK1203
    return /^[\s_\-·.、,，]+/.test(rest);
  };

  const sortByDepth = (arr) => arr.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.name.localeCompare(b.name, 'zh');   // 深度相同按名称稳定排序
  });

  const allCats = root.querySelectorAll('[data-role="drawing-category"]');

  // 定位所有「岩芯资料」分类节点（理论上只有一个，容错取多个）
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

    // 规则 A：子分类名 == 孔号
    for (const sub of subCats) {
      const subName = ((sub.querySelector('span') || {}).textContent || '').trim();
      if (subName.toLowerCase() === target) {
        exactSubHits.push(...collectFiles(sub.nextElementSibling, null));
      }
    }

    // 规则 B + C：岩芯资料直属的图件（不限子分类）
    prefixHits.push(...collectFiles(nested, belongsTo));

    // 规则 D：下一级子分类内部的图件（子分类名 != 孔号，但图片命名带孔号）
    for (const sub of subCats) {
      const subName = ((sub.querySelector('span') || {}).textContent || '').trim();
      if (subName.toLowerCase() === target) continue;   // A 已覆盖
      deepHits.push(...collectFiles(sub.nextElementSibling, belongsTo));
    }
  }

  // 优先级：A > (B+C) > D
  if (exactSubHits.length > 0) return sortByDepth(exactSubHits);
  if (prefixHits.length > 0) return sortByDepth(prefixHits);
  if (deepHits.length > 0) return sortByDepth(deepHits);
  return [];
}

// 生成化验数据（地球化学）表格 HTML
// ★ 第 74 节重写：由「每个元素一张窄表」改为「一张合并宽表」
//   表头形如：起始深度(m) | 终止深度(m) | AU(g/t) | AG(g/t) | S(%)
//   单位来自 assayUnitOf()；数值保留源数据原样（parseGeochemAttrTable 已转成 Number）。
//   某元素在某区间缺测 → 显示 '-'（而非 0），避免与"真实测值为 0"混淆。
function buildAssayTableHtml(info) {
  const wide = info.assayWide;
  // 优先走宽表；宽表为空时回退到旧的分表渲染（兼容只有部分元素子表的项目）
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

  // —— 回退路径（保持原行为）——
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

// 化验数值格式化：整数不显示小数点，小数最多保留 2 位（避免 0.10000000000000001 这类浮点噪声）
function fmtAssayNum(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v == null ? '' : v);
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

// 右键命中钻孔后：填充三个 tab + 打开面板 + 激活「柱状图」
function showHoleDetail(holeid) {
  window._lastHoleDetailId = holeid;   // ★ 第 68 节：记录当前展示的孔号，供重命名后刷新
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
      // ★ 第 67 节：提示里列出「岩芯资料」下已有的子分类名，方便对照自查拼写
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

// ★ 第 68 节：若右侧「钻孔」面板正开着，重跑一次以刷新岩芯图片列表。
//   用于图件/分类重命名后 —— 文件名里可能带深度（如 ZK1203_1到50m.jpg），
//   分类名也可能就是孔号，改名会影响 findCoreImages 的匹配与排序结果。
//   判据：只有「钻取过钻孔」(_lastHoleDetailId 有值) 且右侧面板处于展开态时才刷新。
//   面板可见性由 IIFE 内的私有变量 rightPanelVisible 控制，
//   对外可观察的信号是切换按钮上的 .active 类。
function refreshHolePanelIfOpen() {
  const holeid = window._lastHoleDetailId;
  if (!holeid) return;
  const btn = document.getElementById('btn-toggle-right-panel');
  if (btn && btn.classList && !btn.classList.contains('active')) return;
  // 仍在「视图」标签页时不打扰用户（钻孔联动会自动切到「柱状图」页签）
  showHoleDetail(holeid);
}

// 右键三维画布：拾取钻孔孔口 -> 显示该钻孔详情
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (state.measureMode) return;
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  // ★ 优先拾取「点小球」→ 单点操作菜单（点模式 / 点绘制中）
  // 必须放在钻孔拾取之前：点图层的 modelObj 也带 isCollarPoints=true（见 renderPointLayer），
  // 否则右键点小球会被钻孔分支抢走，弹出无关的钻孔详情。
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

// ★ 在屏幕上给定位置拾取「点小球」；未命中返回 null
// 仅拾取 可见 + inScene 的点图层，避免打到隐藏点或被其它模型遮挡
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

// 沿 parent 链反查小球归属的点图层 modelObj
function findPointModelOwner(sphere, pointModels) {
  for (let k = 0; k < pointModels.length; k++) {
    let p = sphere;
    while (p) { if (p === pointModels[k].mesh) return pointModels[k]; p = p.parent; }
  }
  return null;
}

// ============================================================
// 拖拽坐标系检查
// 阈值：origin 各分量差值 < 5000米视为同一坐标系
// 空标签页（state.origin 为 null）→ 直接显示，首个模型定义坐标系
// 不同坐标系 → 弹窗通知 → 自动新建标签页 → 在新标签页加载
// ============================================================
const COORDSYS_THRESHOLD = 5000;

// 计算拖拽数据的坐标系原点
// .ts 模型 → geoMesh.fileOrigin；钻孔数据 → 从孔口坐标计算
function computeDragModelOrigin(payload) {
  // 钻孔数据（孔口/测斜/地质/蚀变/地球化学属性）：从孔口表计算原点
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
  // ★ 点类别（第 63 节）：用类别自身的 origin（每个标签页坐标系），没有则按点位推算
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
  // .ts 模型文件：从 geoMeshCache 获取 fileOrigin（取第一个可用）
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
  // 回退：从 state.models 中已有模型的 geoMesh.fileOrigin 获取
  const ids = payload.modelIds || [];
  for (let i = 0; i < ids.length; i++) {
    const m = state.models.find(x => x.id === ids[i]);
    if (m && m.geoMesh && m.geoMesh.fileOrigin) {
      return m.geoMesh.fileOrigin;
    }
  }
  return null;
}

// 检查拖拽是否需要坐标系检查（仅当有模型需要从缓存加载时才检查）
function needsCoordsysCheck(payload) {
  // 钻孔数据：始终检查（每次拖拽都是新可视化）
  if (payload.type === 'table-category' || payload.type === 'geochem-attr') return true;
  // ★ 点类别（第 63 节）：未在当前视图显示过 → 需要检查坐标系
  if (payload.type === 'point-category') {
    const layer = payload.pointId ? state.pointLayers[payload.pointId] : null;
    if (!layer) return false;
    const m = state.models.find(x => x.isPointLayer && x.pointLayerId === layer.id);
    return !(m && m.inScene);
  }
  // .ts 模型文件：仅当有文件不在当前标签 state.models 中时才检查
  const ids = payload.modelIds || [];
  for (let i = 0; i < ids.length; i++) {
    if (!state.models.find(x => x.id === ids[i])) return true;
  }
  return false;
}

// 执行拖拽加载（提取为独立函数，供坐标系检查回调调用）
async function processDropPayload(payload) {
  if(window.researchRegionViews){
    const models=getProjectModels(),first=models.find(model=>(payload.modelIds||[]).includes(model.id));
    const cached=(payload.modelIds||[]).map(id=>geoMeshCache.get(id)).find(Boolean);
    const owner=first?.regionId||cached?.options?.regionId||state.drawings?.[payload.drawingKey]?.regionId;
    if(owner)await researchRegionViews.ensure(owner);
  }

  // 已配准图件拖拽 → 在三维视图生成半透明贴图平面
  if (payload.type === 'drawing-file') {
    const reg = drawingRegisters[payload.drawingKey];
    if (!reg || !reg.done) {
      window.showTabModal({ title: 'Image is not registered', label: 'Register this image using control points first (Under Maps and Figures, click“Register”button) , Then drag into the 3D view to create an image plane. ' });
      return;
    }
    buildRegisterPlaneInScene(reg);
    return;
  }
  // 钻孔分类拖拽 → 按分类名路由到对应可视化
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
  // 地球化学属性子类别拖拽 → 按数值大小映射 diverging 色阶
  if (payload.type === 'geochem-attr') {
    visualizeGeochemDrillholes(payload.attrName, payload.attrRawName);
    return;
  }
  // ★ 点类别拖拽 → 在三维视图显示该点类别（第 63 节修复）
  if (payload.type === 'point-category') {
    const pid = payload.pointId;
    const layer = pid ? state.pointLayers[pid] : null;
    if (!layer) {
      flashPointHint('Point category not found, It may have been deleted');
      return;
    }
    const n = ((layer.collars && layer.collars.length) || (layer.rows && layer.rows.length) || 0);
    if (!n) {
      // ★ 空类别必须留可见反馈：否则用户只看到"拖进来没反应"
      flashPointHint('「' + layer.name + ' ”is an empty category, No points yet. Right-click this category →“Draw points”Place points on the model surface');
      return;
    }
    // 已显示 → 提示并高亮；未显示 → 显示
    const model = state.models.find(m => m.isPointLayer && m.pointLayerId === layer.id);
    if (model && model.inScene) {
      flashPointHint('「' + layer.name + ' ”Already visible in this view (' + n + ' points) ');
    } else {
      rebuildHandLayer(layer);      // 确保 collars/attrs 与 rows 同步
      renderPointLayer(layer);
      // ★ 第 65 节：「拖到三维视图」只是「让它显示出来」的**视图操作**，不是数据改动
      //   —— 数据本身早已存在于 pointLayers 里，onScene 标记也会随别处的保存一起落盘。
      //   这里调用 doSaveProject 会让用户「随手拖一下」就产生一次写盘，既无必要也不符合预期。
      //   故不再自动保存；与其它拖拽类型（.ts 模型 / 地球化学 / 图件 / 线）行为保持一致。
      flashPointHint('Point category displayed“ ' + layer.name + '」（' + n + ' points) ');
    }
    return;
  }
  // ★ 块体模型（按 GM 类）拖拽 → 从左侧树拖回画布显示（第 97 节）
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
  // .ts 模型文件拖拽
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

  // 解析 payload：新版是 JSON（含 modelIds + fileNames 数组），旧版是纯 modelId 字符串（兼容）
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_err) {
    payload = { type: 'file', modelIds: [raw], fileNames: [] };
  }

  // ★ 坐标系检查：仅当需要从缓存加载新模型时才检查
  if(window.researchRegionViews){
    const first=getProjectModels().find(model=>(payload.modelIds||[]).includes(model.id));
    const cached=(payload.modelIds||[]).map(id=>geoMeshCache.get(id)).find(Boolean);
    const owner=first?.regionId||cached?.options?.regionId||state.drawings?.[payload.drawingKey]?.regionId;
    if(owner){try{await researchRegionViews.ensure(owner);}catch(error){alert(error.message);return;}}
  }
  if (needsCoordsysCheck(payload)) {
    const modelOrigin = computeDragModelOrigin(payload);
    // 空标签页（state.origin 为 null）→ 首个模型定义坐标系，直接显示
    // 无法计算模型原点 → 直接显示（兜底）
    if (modelOrigin && state.origin) {
      const dx = Math.abs(modelOrigin.x - state.origin.x);
      const dy = Math.abs(modelOrigin.y - state.origin.y);
      const dz = Math.abs(modelOrigin.z - state.origin.z);
      if (dx >= COORDSYS_THRESHOLD || dy >= COORDSYS_THRESHOLD || dz >= COORDSYS_THRESHOLD) {
        // 坐标系不一致 → 弹窗通知 → 新建标签页 → 在新标签页加载
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

  // 坐标系一致（或空标签页/无法判断/模型已在当前标签）→ 直接执行
  processDropPayload(payload);
});

// 4. 剖切
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

// 关闭面板按钮：仅隐藏面板，保留剖切效果，在图层管理新增剖切条目
document.getElementById('clip-panel-close').addEventListener('click', () => {
  clipPanel.classList.remove('visible');
  addClipLayerItem();
});

// 获取当前启用的剖切平面数组
function getActiveClipPlanes() {
  const planes = [];
  const cfg = state.clipConfig;
  // 水平（Three.Y）：above 保留上方 normal=(0,1,0)，below 保留下方 normal=(0,-1,0)
  if (cfg.h.enabled) {
    const n = cfg.h.dir === 'above' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, -1, 0);
    const c = cfg.h.dir === 'above' ? -cfg.h.value : cfg.h.value;
    planes.push(new THREE.Plane(n, c));
  }
  // 垂直 X（Three.X）：pos 保留正侧 normal=(1,0,0)，neg 保留负侧 normal=(-1,0,0)
  if (cfg.x.enabled) {
    const n = cfg.x.dir === 'pos' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(-1, 0, 0);
    const c = cfg.x.dir === 'pos' ? -cfg.x.value : cfg.x.value;
    planes.push(new THREE.Plane(n, c));
  }
  // 垂直 Y（Three.Z）：pos 保留正侧 normal=(0,0,1)，neg 保留负侧 normal=(0,0,-1)
  if (cfg.y.enabled) {
    const n = cfg.y.dir === 'pos' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 0, -1);
    const c = cfg.y.dir === 'pos' ? -cfg.y.value : cfg.y.value;
    planes.push(new THREE.Plane(n, c));
  }
  return planes;
}

// 获取全局包围盒（Three.js 坐标）
function getSceneBoundingBox() {
  const box = new THREE.Box3();
  state.models.forEach(m => { expandModelBox3(box, m); });
  return box;
}

// 获取当前标签页的全局原点偏移（带兜底推断）
function getGlobalOrigin() {
  if (state.origin) return state.origin;
  // 兜底：从模型 fileOrigin 推断
  const firstWithFileOrigin = state.models.find(m => m.geoMesh && m.geoMesh.fileOrigin);
  if (firstWithFileOrigin) {
    state.origin = { x: firstWithFileOrigin.geoMesh.fileOrigin.x, y: firstWithFileOrigin.geoMesh.fileOrigin.y, z: firstWithFileOrigin.geoMesh.fileOrigin.z };
    return state.origin;
  }
  return { x: 0, y: 0, z: 0 };
}

// 初始化滑块范围（基于模型包围盒）
function initClipSliderRanges() {
  const box = getSceneBoundingBox();
  if (box.isEmpty()) return;
  const ox = getGlobalOrigin();
  // 水平（Three.Y → GOCAD Z 高程）
  const hSlider = document.getElementById('clip-h-slider');
  hSlider.min = box.min.y;
  hSlider.max = box.max.y;
  hSlider.value = (box.min.y + box.max.y) / 2;
  state.clipConfig.h.value = parseFloat(hSlider.value);
  // 垂直 X（Three.X → GOCAD X 东）
  const xSlider = document.getElementById('clip-x-slider');
  xSlider.min = box.min.x;
  xSlider.max = box.max.x;
  xSlider.value = (box.min.x + box.max.x) / 2;
  state.clipConfig.x.value = parseFloat(xSlider.value);
  // 垂直 Y（Three.Z → GOCAD Y 北）
  const ySlider = document.getElementById('clip-y-slider');
  ySlider.min = box.min.z;
  ySlider.max = box.max.z;
  ySlider.value = (box.min.z + box.max.z) / 2;
  state.clipConfig.y.value = parseFloat(ySlider.value);
  updateClipValueLabels();
}

// 更新数值标签（显示 GOCAD 真实坐标）
function updateClipValueLabels() {
  const ox = getGlobalOrigin();
  const cfg = state.clipConfig;
  // 水平：GOCAD Z = ThreeY + oz
  document.getElementById('clip-h-value').textContent = 'Elevation: ' + Math.round(cfg.h.value + ox.z);
  // 垂直 X：GOCAD X = ThreeX + ox
  document.getElementById('clip-x-value').textContent = 'X: ' + Math.round(cfg.x.value + ox.x);
  // 垂直 Y：GOCAD Y = -ThreeZ + oy
  document.getElementById('clip-y-value').textContent = 'Y: ' + Math.round(-cfg.y.value + ox.y);
}

// 创建/更新剖切可视化平面
function updateClipHelpers() {
  // 清除旧 helper
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
    // 让平面法线对齐 normal
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

// 应用剖切平面到所有模型材质
function applyClipPlanes() {
  const planes = getActiveClipPlanes();
  state.models.forEach(m => {
    // 多材质模型（钻孔轨迹）：统一应用剖切
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
  // 初始化滑块范围
  initClipSliderRanges();
  // 显示控制面板
  clipPanel.classList.add('visible');
  // 如果图层管理中已有剖切条目，移除它（面板重新打开）
  const existingItem = document.getElementById('lm-clip-item');
  if (existingItem) existingItem.remove();
  // 应用剖切
  applyClipPlanes();
}

function disableClipping() {
  // 清除所有材质上的剖切平面
  state.models.forEach(m => {
    const mats = m.materials || [m.material];
    mats.forEach(mt => {
      mt.clippingPlanes = [];
      mt.needsUpdate = true;
    });
  });
  // 隐藏面板
  clipPanel.classList.remove('visible');
  // 清除图层管理中的剖切条目
  const clipItem = document.getElementById('lm-clip-item');
  if (clipItem) clipItem.remove();
  // 清除可视化
  state.clipHelpers.forEach(h => {
    scene.remove(h);
    if (h.geometry) h.geometry.dispose();
    if (h.material) h.material.dispose();
  });
  state.clipHelpers = [];
  // 重置启用状态
  state.clipConfig.h.enabled = false;
  state.clipConfig.x.enabled = false;
  state.clipConfig.y.enabled = false;
  // 同步 checkbox
  document.getElementById('clip-h-enabled').checked = false;
  document.getElementById('clip-x-enabled').checked = false;
  document.getElementById('clip-y-enabled').checked = false;
}

// ========== 剖切滑块 & 开关事件 ==========
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

  // 方向按钮
  dirBtnIds.forEach(btnId => {
    const btn = document.getElementById(btnId);
    btn.addEventListener('click', () => {
      // 取消同组其他按钮 active
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

// ========== 剖切图层条目（图层管理中的剖切条目） ==========
function addClipLayerItem() {
  // 如果已存在则不重复添加
  if (document.getElementById('lm-clip-item')) return;
  const lmList = document.getElementById('lm-list');
  const item = document.createElement('div');
  item.className = 'lm-item lm-clip-item';
  item.id = 'lm-clip-item';
  item.draggable = false;
  // 构建描述文字
  const desc = buildClipDesc();
  item.innerHTML =
    '<span class="lm-delete" title="Clear clipping">❌</span>' +
    '<div class="lm-color" style="background:#0969da"></div>' +
    '<span class="lm-name">' + desc + '</span>';
  lmList.appendChild(item);

  // ❌ 删除 → 清除剖切
  item.querySelector('.lm-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    item.remove();
    // 清除剖切
    state.clipMode = false;
    btnClip.classList.remove('active');
    disableClipping();
  });

  // 双击 → 重新打开剖切控制面板
  item.addEventListener('dblclick', (e) => {
    if (e.target.closest('.lm-delete') || e.target.closest('.lm-color')) return;
    clipPanel.classList.add('visible');
    item.remove();
  });
}

// 构建剖切描述文字
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

// ========== 测距线图层条目 ==========
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

  // ❌ 删除 → 移除该测距线
  item.querySelector('.lm-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    removeRulerItem(rulerItem);
    item.remove();
  });

  // 双击 → 聚焦到该测距线
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

// 移除单条测距线（从场景和 state 中清除）
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

// 5. 截图
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
// 工具栏「坐标 / 刻度 / 图例」三按钮统一状态同步
// 唯一真相来源：state.compassVisible / state.legendVisible / state.axisLabelsVisible
// 每次状态变化 → 统一应用到 DOM hidden + 按钮 active 类
// ============================================================
const compassParamsEl = document.getElementById('compass-params-box');
const sceneLegendEl   = document.getElementById('scene-legend');
const btnCompass      = document.getElementById('btn-toggle-compass');
const btnLegend       = document.getElementById('btn-toggle-legend');
const btnAxisLabels   = document.getElementById('btn-toggle-axis-labels');

function syncToolbarToggleButtons() {
  // 1. 坐标（指北针+倾角方位角）
  if (compassParamsEl) {
    compassParamsEl.classList.toggle('hidden', !state.compassVisible);
  }
  if (btnCompass) btnCompass.classList.toggle('active', !!state.compassVisible);

  // 2. 图例
  if (sceneLegendEl) {
    sceneLegendEl.classList.toggle('hidden', !state.legendVisible);
  }
  if (btnLegend) btnLegend.classList.toggle('active', !!state.legendVisible);

  // 3. 刻度（坐标轴刻度标签 + XYZ 轴线段）
  if (state.axisLabelGroup) {
    state.axisLabelGroup.visible = !!state.axisLabelsVisible;
  }
  if (btnAxisLabels) btnAxisLabels.classList.toggle('active', !!state.axisLabelsVisible);
}

// 6. 坐标开关：切换指北针+倾角方位角显隐
btnCompass.addEventListener('click', function () {
  state.compassVisible = !state.compassVisible;
  syncToolbarToggleButtons();
});

// 7. 图例开关：切换图例显隐
btnLegend.addEventListener('click', function () {
  state.legendVisible = !state.legendVisible;
  syncToolbarToggleButtons();
});

// 8. 刻度开关：切换坐标轴刻度标签 + XYZ轴线段显隐
btnAxisLabels.addEventListener('click', function () {
  state.axisLabelsVisible = !state.axisLabelsVisible;
  syncToolbarToggleButtons();
});

// 首次加载：立即同步一遍按钮 active 类和 DOM 显隐（保证默认状态即显示、按钮高亮）
syncToolbarToggleButtons();

// ============================================================
// 指北针 / 比例尺 / 视角参数更新
// ============================================================
let lastAzimuth = null, lastPlunge = null;

// ============================================================
// 视图参数 / 指北针 / 比例尺 刷新（第 75 节：重写为「零每帧 DOM 操作」）
// ============================================================
// 原实现每帧都做这些事（animate() 每帧调 updateViewInfo）：
//   ① document.querySelectorAll('.view-params .vp-row')   —— 每帧 DOM 查询
//   ② vpRows[0].innerHTML = '倾角 <span class="val…">' + …  —— 每帧销毁重建 span
//   ③ vpRows[1].innerHTML = …                              —— 每帧销毁重建 span
//   ④ requestAnimationFrame(...) 摘 changed 类             —— 每帧排队回调
//   ⑤ document.getElementById('compass-needle')            —— 每帧 DOM 查询
//   ⑥ container.clientHeight（在 updateScaleBar 内）        —— 每帧强制 reflow
//   → 主线程被这些 DOM 操作占满，与 renderer.render() 争抢，帧率不稳
//     = 拖动 / 旋转时画面抖动；且 innerHTML 重建会打断 .val 的 transition，数字闪烁。
//
// 现在：DOM 引用只查一次并缓存（元素是静态 HTML，不会重建）+ 值不变则不写 +
//       高亮用一次性 setTimeout 而非嵌套 rAF。
let _tmpViewDir = null;          // 复用向量，避免每帧 new（减少 GC 压力）
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
  // 方位角基准 = Three.+X（与三维模型 X 轴方向一致，GOCAD 东）
  // 相机看 +X 时 azimuth=0；看 +Z 时 90°；看 -X 时 180°；看 -Z 时 270°
  let azimuth = Math.atan2(dir.z, dir.x) * (180 / Math.PI);
  azimuth = Math.round((azimuth + 360) % 360);

  const els = _getViewParamEls();
  if (els) {
    const pChanged = lastPlunge !== plunge;
    const aChanged = lastAzimuth !== azimuth;
    // ★ 只在值变化时写 textContent（不重建 innerHTML）
    if (pChanged) {
      els[0].textContent = (plunge >= 0 ? '+' : '') + plunge;
      els[0].classList.add('changed');
    }
    if (aChanged) {
      els[1].textContent = String(azimuth).padStart(3, '0');
      els[1].classList.add('changed');
    }
    if (pChanged || aChanged) {
      // 高亮摘除用「一次性定时器」：拖动时只保留一个待执行回调，不再每帧排队
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

  // 指北针旋转：仅在角度变化时写 style
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

// 比例尺：DOM 引用与文本一起缓存，值不变则不写；视口高度读 _cachedViewportH（不触发 reflow）
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
  // ★ 用缓存值，避免每帧读 clientHeight 触发强制同步布局。
  //   缓存为 0 只可能出现在「容器尚未测量 / 被隐藏」时：此处自愈式刷新一次，
  //   不做每帧 DOM 读取（容器隐藏时也不会有可见渲染）。
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
// 动画循环
// ============================================================
// 全局模态弹窗打开计数：用于在弹窗打开期间暂停 3D 渲染（解决弹窗内输入卡顿）
window.__modalOpenCount = 0;
(function initModalOpenWatcher() {
  const recount = () => {
    window.__modalOpenCount = document.querySelectorAll('.modal-overlay.show').length;
  };
  const mo = new MutationObserver(recount);
  mo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] });
  // 首次与 DOM 就绪后各算一次
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
  // 图片/表格标签激活时跳过 3D 渲染（节省 GPU 资源）
  const curViewer = tabViewers.get(activeTabId);
  if (document.hidden || (curViewer && !['3d','vector2d'].includes(curViewer.type))) return;
  // 模态弹窗打开时跳过 3D 渲染：避免「全屏遮罩 + 大范围 box-shadow」与 WebGL 每帧抢资源，
  // 这是弹窗内输入文字卡顿的主因（输入每个字符都要与 3D 重绘争抢）
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

// 存储「视图」标签的初始 viewer 实例
tabViewers.set('view', { type: '3d', state, scene, camera, target: controls.target.clone(), locked: false });
applyScenePreferences(scene,state);

// 初始触发一次尺寸计算
setTimeout(onResize, 0);

// ============================================================
// 初始化不预载演示文件；仅保留用户会话的恢复入口。
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

