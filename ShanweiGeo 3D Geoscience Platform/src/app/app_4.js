
// ============================================================
// 项目系统：保存 / 打开 / 新建项目 + 关闭前询问
// 项目文件为 JSON：源文件引用、各视图状态、点线数据及无源文件模型快照。
// v1 文件继续沿用原恢复流程；v2 增加独立三维视图存档。
// ============================================================

// —— 工具：获取 File 的本地路径（Electron 30 File.path 仍可用；浏览器环境返回 null） ——
function getFilePath(file) {
  try {
    if (file && typeof file.path === 'string' && file.path) return file.path;
  } catch (e) {}
  return null;
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// —— 项目状态 ——
let currentProjectPath = null;      // 当前项目文件路径（null = 尚未保存过）
let currentProjectName = 'Project name'; // 按钮下方副标题显示

// —— 初始树结构快照（新建/打开项目清空时恢复为初始状态） ——
let initialTreeHTML = null;
function captureInitialTree() {
  initialTreeHTML = {
    drillhole: subitemsDrillhole.innerHTML,
    models3d: subitems3DModel.innerHTML,
    geochem: subitemsGeochemModel.innerHTML,
    tunnel: subitemsTunnelModel.innerHTML,
    block: subitemsBlockModel ? subitemsBlockModel.innerHTML : '',
    drawing: subitemsDrawingMgmt.innerHTML,
    // ★ 第 102 节：「地表」一级大类（遥感影像 / 地形图）也纳入初始树快照
    surface: subitemsSurface ? subitemsSurface.innerHTML : '',
    testdata: subitemsTestData.innerHTML,
    report: subitemsReport.innerHTML,
    point: subitemsPoint.innerHTML,
    line: subitemsLine ? subitemsLine.innerHTML : ''
  };
}
captureInitialTree();

// 更新副标题（当前项目名）
function updateProjectSubtitle() {
  const el = document.getElementById('project-subtitle');
  if (el) el.textContent = currentProjectName;
}

// —— 下拉菜单交互 ——
(function () {
  const wrap = document.getElementById('project-menu-wrap');
  const dd = document.getElementById('project-dropdown');
  if (!wrap || !dd) return;
  function toggleDd(show) {
    dd.classList.toggle('show', show);
    wrap.classList.toggle('open', show);
  }
  wrap.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDd(!dd.classList.contains('show'));
  });
  document.addEventListener('click', () => toggleDd(false));
  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', (e) => { e.stopPropagation(); toggleDd(false); fn(); });
  };
  bind('project-save-btn', () => doSaveProject());
  bind('project-open-btn', () => doOpenProject());
  bind('project-new-btn', () => doNewProject());
})();

// ============================================================
// 序列化（保存项目）
// ============================================================
var projectRestoreInProgress = false;

function getProjectModels() {
  const models = new Set(state.models || []);
  tabViewers.forEach(v => {
    if (v && v.state) (v.state.models || []).forEach(m => models.add(m));
  });
  return Array.from(models);
}

// v2：文件模型仍引用源文件；无源文件的生成模型保存 Three.js 快照。
// 避免把 DOM、材质引用或循环引用写入项目文件。
function serializeViewerModel(model) {
  if(model._deferredEntry)return {...model._deferredEntry,metadata:{...model._deferredEntry.metadata,regionId:model.regionId,displayName:model.displayName}};
  if (model.mesh) model.mesh.traverse(obj => { if (obj.matrixAutoUpdate) obj.updateMatrix(); });
  const source = !!(model.filePath && model.geoMesh && model.geoMesh.vertices);
  const metadata = {};
  Object.keys(model).forEach(key => {
    if (['mesh', 'material', 'materials', 'treeFileNode'].includes(key) || (source && key === 'geoMesh')) return;
    const value = model[key];
    if (value === undefined || typeof value === 'function' || (value && (value.nodeType || value.isObject3D || value.isMaterial || value.isTexture))) return;
    metadata[key] = value;
  });
  const clean = JSON.parse(JSON.stringify(metadata, (key, value) => ArrayBuffer.isView(value) ? Array.from(value) : value));
  return {
    source, metadata: clean,
    mesh: !source && model.mesh ? model.mesh.toJSON() : null,
    materialIds: !source ? (model.materials || (model.material ? [model.material] : []))
      .flat().map(m => m.uuid) : []
  };
}

function serializeProjectViewers() {
  const out = [];
  tabViewers.forEach((v, id) => {
    if (!v || !v.state || !v.scene) return;
    const st = v.state;
    const tab = document.querySelector('.center-tab[data-tab-id="' + id + '"]');
    const label = tab && tab.querySelector('.center-tab-label');
    // 图片/文档标签仍复用上一个三维视图的相机；以相机身份而非 activeTabId 判断。
    const target = camera === v.camera ? controls.target : v.target;
    v.camera.updateMatrix();
    out.push({
      id, label: label ? label.textContent : '3D View', labelUserNamed:tab?.dataset.userNamed==='true', locked: !!v.locked,
      regionId: v.regionId || null,
      isVector2D: !!v.isVector2D,
      origin: st.origin ? Object.assign({}, st.origin) : null,
      camera: v.camera.toJSON(), target: target.toArray(),
      clipConfig: JSON.parse(JSON.stringify(st.clipConfig)), clipMode: !!st.clipMode,
      legendVisible: st.legendVisible, compassVisible: st.compassVisible,
      layersVisible: st.layersVisible, axisLabelsVisible: st.axisLabelsVisible,
      models: v._loadingDeferred ? v._deferredModels.saved.models : st.models.map(serializeViewerModel)
    });
  });
  return out;
}

async function readProjectModelGeometry(model, read) {
  if(model.isGeoImagePlane&&model.geoImagePlaneSource)return geoImagePlaneGeometry(model.geoImagePlaneSource);
  const filePath = model.filePath || model.fileName;
  const tunnel = !!model.strFilePath || /\.dtm$/i.test(filePath || '');
  let geo = tunnel
    ? await geoCacheTunnelGet(model.strFilePath, filePath)
    : await geoCacheTsGet(filePath);
  if (geo && geo.vertices && geo.vertices.length && geo.indices && geo.indices.length) return geo;
  if (window.backendClient?.available && model.filePath && /\.(ts|obj|dtm|asc)$/i.test(filePath)) {
    geo = await parseLocalModel(filePath, model.strFilePath, () => null);
    if (tunnel) geoCacheTunnelPut(model.strFilePath,filePath,geo); else geoCacheTsPut(filePath,geo);
    return geo;
  }
  const bytes = await read(filePath, model.fileName);
  if (!bytes) return null;
  const text = new TextDecoder('utf-8').decode(bytes);
  if (tunnel) {
    const strBytes = model.strFilePath ? await read(model.strFilePath, model.fileName + '.str') : null;
    if (model.strFilePath && !strBytes) return null;
    geo = parseTunnelModel(strBytes ? new TextDecoder('utf-8').decode(strBytes) : '', text, model.fileName);
    if (model.strFilePath) geoCacheTunnelPut(model.strFilePath, filePath, geo);
  } else {
    geo = /\.asc$/i.test(filePath || model.fileName || '') ? parseASCTerrain(text, model.fileName) : /\.obj$/i.test(filePath || model.fileName || '') ? parseOBJText(text, model.fileName) : parseGOCADTS(text);
    if (!geo.vertices.length || !geo.indices.length) throw new Error('The model contains no valid vertices or triangles:  ' + model.fileName);
    geoCacheTsPut(filePath, geo);
  }
  return geo;
}

function applySavedViewerSettings(viewer, saved) {
  const st = viewer.state;
  ['clipMode', 'legendVisible', 'compassVisible', 'layersVisible', 'axisLabelsVisible'].forEach(key => {
    if (saved[key] !== undefined) st[key] = saved[key];
  });
  st.origin = saved.origin ? Object.assign({}, saved.origin) : null;
  st.axisLabelsVisible = appPreferences.axesVisible;
  if (saved.clipConfig) st.clipConfig = JSON.parse(JSON.stringify(saved.clipConfig));
  if (saved.camera) viewer.camera = new THREE.ObjectLoader().parse(saved.camera);
  viewer.target = new THREE.Vector3().fromArray(saved.target || [0, 0, 0]);
  viewer.locked = !!saved.locked;
}

async function restoreProjectViewers(savedViewers, read, missing, options = {}) {
  const ids = new Map();
  for (const saved of savedViewers) {
    const id = options.existingId || (saved.id === 'view' ? 'view' : await window.createNewTab(saved.isVector2D ? 'vector2d' : '3d', { label: saved.label, regionId:saved.regionId || null }));
    if (!id) continue;   // 点绘制守卫取消 → 跳过该标签恢复
    ids.set(saved.id, id);
    const viewer = tabViewers.get(id);
    viewer.regionId=saved.regionId||null;
    await window.switchTab(id,{skipDeferred:!!options.existingId});
    applySavedViewerSettings(viewer, saved);
    camera = viewer.camera;
    controls.swapCamera(camera, viewer.target);
    const deferred=options.lazy&&saved.id!==options.activeId&&(saved.models||[]).length>0;
    if(deferred){viewer._deferredModels={saved,read};viewer.state.models=(saved.models||[]).map(entry=>({...entry.metadata,mesh:new THREE.Group(),_deferredEntry:entry}));}
    for (const entry of (deferred?[]:(saved.models || []))) {
      const meta = entry.metadata || {};
      try {
        let model;
        if (entry.source) {
          const geo = await readProjectModelGeometry(meta, read);
          if (!geo) continue;
          model = loadModelToScene(geo, meta.category, meta.fileName, Object.assign({}, meta, { skipTreeNode: true, deferSceneRefresh: true }));
          if (!model) throw new Error('Duplicate model names exist in this view');
          Object.assign(model, meta);
        } else {
          if (!entry.mesh) throw new Error('Model snapshot is missing');
          const mesh = await new THREE.ObjectLoader().parseAsync(entry.mesh);
          const materials = new Map();
          mesh.traverse(obj => {
            (Array.isArray(obj.material) ? obj.material : [obj.material]).filter(Boolean).forEach(m => materials.set(m.uuid, m));
            const p = obj.userData && obj.userData.basePos;
            if (p) obj.userData.basePos = new THREE.Vector3(p.x, p.y, p.z);
          });
          const selected = (entry.materialIds || []).map(id => materials.get(id)).filter(Boolean);
          model = Object.assign({}, meta, { mesh, materials: selected, material: selected[0] || mesh.material || null, treeFileNode: null });
          if (model.geoMesh && model.geoMesh.vertices) {
            model.geoMesh.vertices = model.geoMesh.terrainInfo ? new Float64Array(model.geoMesh.vertices) : new Float32Array(model.geoMesh.vertices);
            model.geoMesh.indices = new Uint32Array(model.geoMesh.indices);
          }
          state.models.push(model);
          scene.add(mesh);
        }
        model.mesh.userData.modelId = model.id;
        if(model.isBlockModel&&model.mesh.isInstancedMesh)await restoreBlockPicking(model.mesh);
        if(model.isGeoImagePlane&&model.geoImagePlaneSource){
          try{await restoreGeoImagePlane(model,read);}catch(error){missing.push(error.message);model.mesh.visible=false;model.visible=false;}
        }
        if (model.geoMesh && model.geoMesh.terrainInfo) applyTerrainDisplay(model, model.terrainSettings);
        if (model.terrainImage && typeof restoreTerrainImage === 'function') {
          try { await restoreTerrainImage(model, read); }
          catch (error) { missing.push(error.message); applyTerrainDisplay(model, Object.assign({}, model.terrainSettings, { colorMode: 'elevation' })); }
        }
        model.mesh.visible = model.inScene !== false && model.visible !== false;
        if (model.geoMesh && model.geoMesh.vertices) {
          const cacheEntry={geoMesh:model.geoMesh,category:model.category,options:{filePath:model.filePath,strFilePath:model.strFilePath,regionId:model.regionId}};
          geoMeshCache.set(model.fileName,cacheEntry);geoMeshCache.set(model.id,cacheEntry);
        }
      } catch (err) {
        missing.push((meta.fileName || 'Model') + '：' + err.message);
      }
    }
    if (state.models.length && state.placeholderMesh) {
      scene.remove(state.placeholderMesh);
      state.placeholderMesh = null;
    }
    const planes = state.clipMode ? getActiveClipPlanes() : [];
    state.models.forEach(m => m.mesh.traverse(obj => {
      (Array.isArray(obj.material) ? obj.material : [obj.material]).filter(Boolean).forEach(mat => {
        mat.clippingPlanes = planes.length ? planes : null;
        mat.needsUpdate = true;
      });
    }));
    const tab = document.querySelector('.center-tab[data-tab-id="' + id + '"]');
    if (tab) {
      tab.classList.toggle('locked', viewer.locked);
      const label = tab.querySelector('.center-tab-label');
      if (label && saved.label) { label.textContent = saved.label; tab.title = saved.label; tab.dataset.autoName = 'false';tab.dataset.userNamed=String(!!saved.labelUserNamed); }
    }
  }
  if(!options.existingId)await window.switchTab('view');
  // Restored source meshes initially receive temporary IDs before metadata is
  // applied. Rebuild rows using the final IDs even when 'view' was active.
  rebuildLayerManagement();
  return ids;
}

function loadDeferredViewer(id){
  const viewer=tabViewers.get(id);if(!viewer?._deferredModels)return Promise.resolve();if(viewer._deferredPromise)return viewer._deferredPromise;
  const task=(window.__deferredViewerBusy||Promise.resolve()).then(()=>hydrateDeferredViewer(id)),busy=task.catch(()=>{});viewer._deferredPromise=task;window.__deferredViewerBusy=busy;
  return task.finally(()=>{delete viewer._deferredPromise;if(window.__deferredViewerBusy===busy)window.__deferredViewerBusy=null;});
}
async function hydrateDeferredViewer(id){
  const viewer=tabViewers.get(id);if(!viewer?._deferredModels||viewer._loadingDeferred)return;
  const pending=viewer._deferredModels,proxies=viewer.state.models.slice(),missing=[];viewer._loadingDeferred=true;
  pending.saved={...pending.saved,models:proxies.map(serializeViewerModel)};
  showImportLoading('Loading models for this view…');
  try{
    viewer.state.models=[];
    await restoreProjectViewers([pending.saved],pending.read,missing,{existingId:id});
    viewer.state.models=viewer.state.models.map(model=>{const proxy=proxies.find(item=>item.id===model.id);if(!proxy)return model;const treeFileNode=proxy.treeFileNode;delete proxy._deferredEntry;Object.assign(proxy,model);if(treeFileNode)proxy.treeFileNode=treeFileNode;return proxy;});
    if(missing.length){viewer.state.models.push(...proxies.filter(proxy=>!viewer.state.models.some(model=>model.id===proxy.id)));console.warn('[Deferred restoration]',missing.join('；'));window.showTabModal({title:'Some models have not loaded',label:escapeHtml(missing.join('；'))});}
    else delete viewer._deferredModels;
    rebuildLayerManagement();
  }catch(error){viewer.state.models=proxies;throw error;}
  finally{viewer._loadingDeferred=false;hideImportLoading();}
}

function serializeTree() {
  const projectModels = getProjectModels();
  const out = { drillhole: [], models3d: [], geochem: [], tunnel: [], drawing: [], testdata: [], report: [] };
  function serContainer(container) {
    const arr = [];
    const children = Array.from(container.children);
    for (let i = 0; i < children.length; i++) {
      const el = children[i];
      if (!el.classList || !el.classList.contains('lp-sub-item')) {
        // 新建矿区/模型外面有一层无 class 的包装 div，不能把整个分支跳过。
        if (el.children && !(el.classList && el.classList.contains('lp-nested-items'))) arr.push(...serContainer(el));
        continue;
      }
      const span = el.querySelector(':scope > span');
      const nested = (children[i + 1] && children[i + 1].classList.contains('lp-nested-items')) ? children[i + 1] : null;
      const item = { role: el.getAttribute('data-role') || '', name: span ? span.textContent : '' };
      if (el.dataset.regionId) item.regionId = el.dataset.regionId;
      if(el.dataset.surfaceKind)item.surfaceKind=el.dataset.surfaceKind;
      // 叶子数据引用（文件名 + 路径）——state 优先；空时从 DOM 兜底（演示数据占位等场景）
      const tbl = el.getAttribute('data-table-id');
      const drw = el.getAttribute('data-drawing-id');
      const pdf = el.getAttribute('data-pdf-id');
      const word = el.getAttribute('data-word-id');
      const td = el.getAttribute('data-testdata-id');
      const modelId = el.getAttribute('data-model-id');
      const model = projectModels.find(m => m.id === modelId);
      if (model) {
        item.modelId = model.id;
        item.fileName = model.fileName;
        item.filePath = model.filePath || null;
        item.strFilePath = model.strFilePath || null;
      }
      const domSpan = span ? span.textContent : '';
      const domPath = el.getAttribute('data-table-path') || el.getAttribute('data-drawing-path') || el.getAttribute('data-pdf-path') || el.getAttribute('data-word-path') || el.getAttribute('data-testdata-path') || null;
      if (tbl && state.tables[tbl]) {
        item.fileName = state.tables[tbl].fileName;
        item.filePath = state.tables[tbl].filePath || null;
        item.ext = state.tables[tbl].ext || null;
      } else if (tbl) {
        item.fileName = domSpan; item.filePath = domPath; item.ext = null;
      } else if (drw && state.drawings[drw]) {
        item.terrainImageSource = state.drawings[drw].terrainImageSource || null;
        item.manualRegistration = state.drawings[drw].manualRegistration || null;
        item.fileName = state.drawings[drw].fileName;
        item.filePath = state.drawings[drw].filePath || null;
        item.ext = state.drawings[drw].ext || null;
      } else if (drw) {
        item.fileName = domSpan; item.filePath = domPath; item.ext = null;
      } else if (pdf && state.pdfs[pdf]) {
        item.fileName = state.pdfs[pdf].fileName;
        item.filePath = state.pdfs[pdf].filePath || null;
      } else if (pdf) {
        item.fileName = domSpan; item.filePath = domPath;
      } else if (word && state.words[word]) {
        item.fileName = state.words[word].fileName;
        item.filePath = state.words[word].filePath || null;
      } else if (word) {
        item.fileName = domSpan; item.filePath = domPath;
      } else if (td && state.testData[td]) {
        const t = state.testData[td];
        item.fileName = t.fileName;
        item.filePath = t.filePath || null;
        item.sheetNames = t.sheetNames || [];
        item.isExcel = !!t.isExcel;
      } else if (td) {
        item.fileName = domSpan; item.filePath = domPath; item.sheetNames = []; item.isExcel = false;
      }
      if (nested) item.children = serContainer(nested);
      arr.push(item);
      if (nested) i++;
    }
    return arr;
  }
  out.drillhole = serContainer(subitemsDrillhole);
  out.models3d = serContainer(subitems3DModel);
  out.geochem = serContainer(subitemsGeochemModel);
  out.tunnel = serContainer(subitemsTunnelModel);
  out.block = subitemsBlockModel ? serContainer(subitemsBlockModel) : [];
  out.drawing = serContainer(subitemsDrawingMgmt);
  // ★ 第 102 节：「地表」大类（遥感影像 / 地形图）随项目一起存档
  out.surface = subitemsSurface ? serContainer(subitemsSurface) : [];
  out.testdata = serContainer(subitemsTestData);
  out.report = serContainer(subitemsReport);
  return out;
}

function serializeTabs() {
  const tabs = [];
  tabViewers.forEach((v, tid) => {
    if (tid === 'view' || !v) return;
    const before=tabs.length;
    if (v.type === 'pdf') tabs.push({ type: 'pdf', fileName: v.pdfName, regionId: Object.values(state.pdfs).find(file=>file.url===v.pdfUrl)?.regionId });
    else if (v.type === 'word') tabs.push({ type: 'word', fileName: v.wordName, regionId: Object.values(state.words).find(file=>file.url===v.wordUrl)?.regionId });
    else if (v.type === 'image') tabs.push({ type: 'image', fileName: v.imageName, regionId: Object.values(state.drawings).find(file=>file.blobUrl===v.imageUrl||file.previewUrl===v.imageUrl)?.regionId });
    else if (v.type === 'table') {
      if (v.testDataId) {
        const t = state.testData[v.testDataId];
        if (t) tabs.push({ type: 'table', isTestData: true, fileName: t.fileName, regionId: t.regionId, sheetName: v.testDataSheet || null });
      } else if (v.tableName) {
        tabs.push({ type: 'table', isTestData: false, fileName: v.tableName, regionId: Object.values(state.tables).find(file=>'table:'+file.id===v.sourceKey)?.regionId });
      }
    }
    if(tabs.length>before)tabs[tabs.length-1].active=tid===activeTabId;
  });
  return tabs;
}

function serializeProject() {
  const researchAreas = window.researchRegions ? researchRegions.serialize() : null;
  ensureProjectLevelStateFields();
  let cam = null;
  try {
    if (camera && controls) cam = { pos: camera.position.toArray(), target: controls.target.toArray() };
  } catch (e) {}
  return {
    format: 'szproject',
    version: 2,
    researchAreas,
    viewers: serializeProjectViewers(),
    activeViewer: activeTabId,
    projectName: currentProjectName,
    savedAt: new Date().toISOString(),
    tree: researchAreas?.trees && window.researchScopeTrees ? researchScopeTrees.combined(researchAreas.trees) : serializeTree(),
    scene: {
      models: state.models.map(m => ({
        fileName: m.fileName,
        category: m.category,
        color: m.color,
        opacity: m.opacity,
        rockSettings: m.rockSettings || null,
        visible: m.inScene !== false,
        filePath: m.filePath || null,
        strFilePath: m.strFilePath || null
      })),
      clipConfig: JSON.parse(JSON.stringify(state.clipConfig || {})),
      lithologyColors: JSON.parse(JSON.stringify(state.lithologyColors || {})),
      geochemColormap: JSON.parse(JSON.stringify(state.geochemColormap || {})),
      origin: state.origin ? { x: state.origin.x, y: state.origin.y, z: state.origin.z } : null,
      camera: cam
    },
    tabs: serializeTabs(),
    // 点图层（孔口表格式导入）：解析后的数据内联存储，重开项目免原文件
    points: Object.values(state.pointLayers || {}).map(l => ({
      id: l.id, name: l.name, fileName: l.fileName, filePath: l.filePath || null, regionId: l.regionId,
      data: (l.rows && l.rows.length) ? [l.headers].concat(l.rows.map(r => r.slice())) : (l.data || []),
      headers: l.headers, collars: l.collars, attrs: l.attrs,
      origin: l.origin ? { x: l.origin.x, y: l.origin.y, z: l.origin.z } : null,
      color: l.color, colorAttr: l.colorAttr || null, colorScheme: l.colorScheme || null,
      autoCols: (l.autoCols || []).slice(), colsLocked: !!l.colsLocked, isEmptyCategory: !!l.isEmptyCategory
    })),
    pointOrder: (state.pointOrder || []).slice(),
    // 线图层（内联 entities，直接恢复）
    lines: (typeof serializeLineLayers === 'function') ? serializeLineLayers() : [],
    lineOrder: (state.lineOrder || []).slice(),
    // 文档书签 / 笔记（大纲源自文档本身，不持久化）
    docAnnots: (typeof serializeDocAnnots === 'function') ? serializeDocAnnots() : {}
  };
}

// ============================================================
// ★ 离开「点绘制」的守卫（切换标签 / 新建 / 打开项目前调用）
// 三选项：保存并离开 / 不保存离开 / 取消（留在原地继续绘制）。
// 返回 Promise<boolean>：true=可以继续离开，false=用户取消。
// 用自建 modal 而非 confirm()，因为需要三选项（原生 confirm 只有两选项）。
// ============================================================
function _pdResolveDialog(el, val) {
  el.classList.remove('show');
  const r = el._resolve;
  el._resolve = null;
  if (r) r(val);
}

function ensureDrawLeaveDialog() {
  let el = document.getElementById('draw-leave-modal');
  if (el) return el;
  el = document.createElement('div');
  el.className = 'modal-overlay';
  el.id = 'draw-leave-modal';
  el.innerHTML =
    '<div class="modal-dialog" style="width:400px">' +
      '<div class="modal-header">Point drawing is active</div>' +
      '<div class="modal-body">' +
        '<div id="dl-msg" style="font-size:13px;line-height:1.7;color:#333;"></div>' +
        '<div style="font-size:12px;color:#888;margin-top:8px;">Select“Save and leave”The project will be saved first; Select“Don\'t save”discards the unsaved changes. </div>' +
      '</div>' +
      '<div style="padding:10px 14px;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;">' +
        '<button type="button" id="dl-cancel" style="padding:6px 14px;cursor:pointer;">Cancel</button>' +
        '<button type="button" id="dl-discard" style="padding:6px 14px;cursor:pointer;">Don\'t save</button>' +
        '<button type="button" id="dl-save" style="padding:6px 14px;cursor:pointer;background:#2f6df6;color:#fff;border:none;">Save and leave</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(el);
  el.querySelector('#dl-cancel').addEventListener('click', () => _pdResolveDialog(el, 'cancel'));
  el.querySelector('#dl-discard').addEventListener('click', () => _pdResolveDialog(el, 'discard'));
  el.querySelector('#dl-save').addEventListener('click', () => _pdResolveDialog(el, 'save'));
  return el;
}

async function guardLeavePointDraw(reason) {
  if (!pointAddMode) return true;
  const layer = getActivePointCategory();
  const n = layer ? ((layer.rows || []).length) : 0;
  const el = ensureDrawLeaveDialog();
  const msg = document.getElementById('dl-msg');
  if (msg) {
    msg.innerHTML = 'Currently drawing points in category“<b>' + escapeHtml(layer ? layer.name : '—') + '</b>」，' +
      'Placed <b>' + n + '</b> points. <br>' + (reason ? escapeHtml(reason) + '，' : '') +
      ' Save first??';
  }
  const choice = await new Promise((resolve) => { el._resolve = resolve; el.classList.add('show'); });
  if (choice === 'cancel') return false;
  if (choice === 'save') {
    let ok = false;
    try { ok = await doSaveProject(true); } catch (err) { ok = false; }
    if (!ok) {
      alert('Save failed, Switching canceled, Try again or save manually. ');
      return false;
    }
  }
  // 无论保存与否，都退出绘制状态
  setPointAddMode(false);
  flashPointHint('Point drawing mode exited');
  return true;
}

// ★ 导入新文件的统一守卫：必须在「打开系统文件对话框之前」调用。
// 因为对话框一弹出，用户的注意力/上下文就已切换，事后再提醒为时已晚。
// 用法：先 await guardImportPointDraw('即将导入模型文件')，返回 false 则直接 return。
async function guardImportPointDraw(reason) {
  return await guardLeavePointDraw(reason || 'Importing a new file');
}

// —— 保存项目（返回 true=已保存成功；false=取消或失败） ——
async function doSaveProject(silent) {
  let data;
  try { data = serializeProject(); }
  catch (err) { alert('Unable to serialize the project:  ' + err.message); return false; }
  let targetPath = currentProjectPath;
  if (!targetPath) {
    if (!window.electronAPI || !window.electronAPI.showSaveDialog) { alert('This operation requires the desktop application, Unable to save the project file'); return false; }
    const res = await window.electronAPI.showSaveDialog({
      title: 'Save project',
      defaultPath: (currentProjectName && currentProjectName !== 'Project name' ? currentProjectName : 'Untitled project') + '.json',
      filters: [{ name: 'ShanweiGeo project file', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return false;
    targetPath = res.filePath;
  }
  showImportLoading('Saving project...');
  await new Promise(r => setTimeout(r, 30));
  try {
    const json = JSON.stringify(data, null, 2);
    const r = await window.electronAPI.writeProjectFile(targetPath, json);
    if (!r || !r.ok) throw new Error(r ? r.error : 'Write failed');
    currentProjectPath = targetPath;
    const base = targetPath.split(/[\\/]/).pop().replace(/\.json$/i, '');
    currentProjectName = base;
    updateProjectSubtitle();
    hideImportLoading();
    recordRecentProject(targetPath,currentProjectName);
    if (!silent) alert('Project saved: \n' + targetPath);
    return true;
  } catch (err) {
    hideImportLoading();
    alert('Unable to save project:  ' + err.message);
    return false;
  }
}

// ============================================================
// 清空当前工作环境（新建 / 打开项目前调用）
// ============================================================
function clearProject() {
  window.regionCompare?.exit();
  if(tabViewers.get('view'))tabViewers.get('view').regionId=null;
  if (window.researchRegions) researchRegions.reset();
  if (_sessionSaveTimer) { clearTimeout(_sessionSaveTimer); _sessionSaveTimer = null; }
  // 1. 关闭所有非「视图」标签
  Array.from(tabViewers.keys()).forEach(tid => {
    if (tid !== 'view') {
      const viewer = tabViewers.get(tid);
      if (viewer) viewer.locked = false;
      window.closeTab(tid);
    }
  });
  window.switchTab('view');
  ensureProjectLevelStateFields();
  // 2. 清空 3D 场景（先取快照，再重置 state）
  const modelsSnapshot = state.models.slice();
  modelsSnapshot.forEach(m => {
    if (m.geoImageTexture) m.geoImageTexture.dispose();
    if (m.terrainTexture) m.terrainTexture.dispose();
    if (m.mesh && m.mesh.parent) m.mesh.parent.remove(m.mesh);
    if (m.mesh) {
      try { m.mesh.geometry.dispose(); } catch (e) {}
      try { m.mesh.material.dispose(); } catch (e) {}
    }
  });
  (state.clipHelpers || []).forEach(h => {
    if (h && h.parent) h.parent.remove(h);
  });
  state.clipHelpers = [];
  state.rulerItems = [];
  state.rulerLines = [];
  state.rulerPoints = [];
  while (lmList.firstChild) lmList.removeChild(lmList.firstChild);
  lmEmpty.style.display = '';
  // 3. 恢复初始树结构
  if (initialTreeHTML) {
    subitemsDrillhole.innerHTML = initialTreeHTML.drillhole;
    subitems3DModel.innerHTML = initialTreeHTML.models3d;
    subitemsGeochemModel.innerHTML = initialTreeHTML.geochem;
    subitemsTunnelModel.innerHTML = initialTreeHTML.tunnel;
    if (subitemsBlockModel) subitemsBlockModel.innerHTML = initialTreeHTML.block || '';
    subitemsDrawingMgmt.innerHTML = initialTreeHTML.drawing;
    // ★ 第 102 节：「地表」恢复为初始两个空分类模板
    if (subitemsSurface) subitemsSurface.innerHTML = initialTreeHTML.surface || '';
    subitemsTestData.innerHTML = initialTreeHTML.testdata;
    subitemsReport.innerHTML = initialTreeHTML.report;
    subitemsPoint.innerHTML = initialTreeHTML.point;
    if (subitemsLine) subitemsLine.innerHTML = initialTreeHTML.line || '';
  }
  // 4. 重置内存数据
  state.models = [];
  state.tables = {};
  state.drawings = {};
  state.pdfs = {};
  state.words = {};
  state.testData = {};
  state.pointLayers = {};
  state.pointOrder = [];
  state.lineLayers = {};
  state.lineOrder = [];
  activeLineLayerId = null;
  state.lithologyColors = {};
  state.geochemColormap = {};
  state.origin = null;
  state.selectedModelId = null;
  state.clipConfig = {
    h: { enabled: false, dir: 'above', value: 0 },
    x: { enabled: false, dir: 'pos', value: 0 },
    y: { enabled: false, dir: 'pos', value: 0 }
  };
  if (typeof geoMeshCache !== 'undefined') geoMeshCache.clear();
  // 5. 重新绑定右键/双击（初始 HTML 内节点需要交互）
  try { bindDrillholeAreaContextMenus(subitemsDrillhole); bindTableContextMenus(subitemsDrillhole); } catch (e) {}
  try { bindCategoryContextMenus(subitems3DModel); } catch (e) {}
  try { bindGeochemContextMenus(subitemsGeochemModel); } catch (e) {}
  try { bindTunnelContextMenus(subitemsTunnelModel); } catch (e) {}
  try { bindDrawingContextMenus(subitemsDrawingMgmt); } catch (e) {}
  try { if (subitemsSurface) bindDrawingContextMenus(subitemsSurface); } catch (e) {}
  try { bindTestDataContextMenus(subitemsTestData); } catch (e) {}
  try { bindReportContextMenus(subitemsReport); } catch (e) {}
  // 6. 刷新图例 / 渲染顺序 / 空状态
  try { updateLegend(); } catch (e) {}
  try { updateRenderOrder(); } catch (e) {}
  try { updateViewInfo(); } catch (e) {}
  try { buildAxisLabels(); } catch (e) {}
  // 新项目不能继承上个项目的同名文档书签与笔记。
  Object.keys(docStore).forEach(key => delete docStore[key]);
  if (noteSaveTimer) { clearTimeout(noteSaveTimer); noteSaveTimer = null; }
  noteBindKey = '';
  docCtx = { type: '', url: '', key: '', name: '' };
  refreshDocPanels();
}

// 当前是否有工作内容
function hasProjectContent() {
  if (window.researchRegions && researchRegions.hasChanges()) return true;
  ensureProjectLevelStateFields();
  return getProjectModels().length > 0 ||
    ['tables', 'drawings', 'pdfs', 'words', 'testData', 'pointLayers', 'lineLayers']
      .some(key => Object.keys(state[key]).length > 0);
}

// ============================================================
// 恢复（打开项目）
// ============================================================
async function restoreProject(data, options = {}) {
  data = window.normalizeLegacyProjectCategories(data);
  if (window.researchRegions) researchRegions.restore(data.researchAreas);
  ensureProjectLevelStateFields();
  projectRestoreInProgress = true;
  window.__lazyProjectRestore=!!options.lazyViewers;
  try {
  const missing = [];
  const read = async (fp, label) => {
    if (!fp) { missing.push(label + '  (No path recorded) '); return null; }
    const r = await window.electronAPI.readProjectFile(fp);
    if (!r || !r.ok) { missing.push(label + '：' + (r ? r.error : 'Read failed')); return null; }
    return base64ToBytes(r.data);
  };
  const tree = data.tree || {};
  const scene = data.scene || {};
  // clearProject 会恢复演示树模板；读取存档时以存档树为准，避免每次打开重复追加。
  [['drillhole', subitemsDrillhole], ['models3d', subitems3DModel], ['geochem', subitemsGeochemModel],
    ['tunnel', subitemsTunnelModel], ['block', subitemsBlockModel], ['drawing', subitemsDrawingMgmt],
    ['surface', subitemsSurface],
    ['testdata', subitemsTestData], ['report', subitemsReport]].forEach(([key, container]) => {
      if (Array.isArray(tree[key]) && container) container.innerHTML = '';
    });
  const hasViewers = Array.isArray(data.viewers) && data.viewers.length > 0;
  // 先恢复模型和各自原点，项目树随后按稳定 modelId 绑定，不重复加载模型。
  const viewerIds = hasViewers ? await restoreProjectViewers(data.viewers, read, missing,{lazy:!!options.lazyViewers,activeId:data.activeViewer||'view'}) : null;
  if (!hasViewers && scene.origin) state.origin = Object.assign({}, scene.origin);
  if (scene.lithologyColors) state.lithologyColors = scene.lithologyColors;
  if (scene.geochemColormap) state.geochemColormap = scene.geochemColormap;
  restoreDocAnnots(data.docAnnots || {});

  // —— 点图层（内联数据，直接恢复，无需原文件） ——
  if (data.points && data.points.length) restorePointLayers(data.points, data.pointOrder, { skipScene: hasViewers });

  // —— 线图层（内联 entities，直接恢复） ——
  if (data.lines && data.lines.length) {
    try { await restoreLineLayers(data.lines, { skipScene: hasViewers }); }
    catch (e) { console.warn('[Line restoration] Failed: ', e); }
  }

  // —— 钻孔区域 + 表格 ——
  if (window.researchRegions) {
    for (const [items, attribute] of [[data.points || [], 'data-point-id'], [data.lines || [], 'data-line-id']]) {
      for (const item of items) document.querySelectorAll('[' + attribute + ']').forEach(node => {
        if (node.getAttribute(attribute) === item.id) researchRegions.restoreFile(node,item);
      });
    }
  }
  if (window.researchScopeTrees && data.researchAreas?.trees) {
    await researchScopeTrees.restoreTrees(data.researchAreas.trees, scopedTree => restoreScopeProjectTree(scopedTree,read,missing,scene,hasViewers));
  } else {
    await restoreScopeProjectTree(tree,read,missing,scene,hasViewers);
  }

  // —— 场景模型应用保存时的颜色/透明度/可见性 ——
  if (!hasViewers) {
  (scene.models || []).forEach(sm => {
    const m = state.models.find(x => x.fileName === sm.fileName);
    if (!m || !m.material) return;
    try {
      m.material.color.set(sm.color);
      m.material.opacity = sm.opacity !== undefined ? sm.opacity : m.material.opacity;
      m.material.needsUpdate = true;
      m.color = sm.color;
      m.opacity = m.material.opacity;
      if(sm.rockSettings)m.rockSettings=sm.rockSettings;
      if (sm.visible === false) {
        removeModelFromView(m);
      }
    } catch (e) {}
  });

  // —— 场景设置恢复 ——
  if (scene.clipConfig) Object.assign(state.clipConfig, JSON.parse(JSON.stringify(scene.clipConfig)));
  if (scene.lithologyColors) state.lithologyColors = scene.lithologyColors;
  if (scene.geochemColormap) state.geochemColormap = scene.geochemColormap;
  if (scene.origin) state.origin = { x: scene.origin.x, y: scene.origin.y, z: scene.origin.z };
  if (scene.camera) {
    try { camera.position.fromArray(scene.camera.pos); controls.target.fromArray(scene.camera.target); controls.update(); } catch (e) {}
  }
  // 应用剖切配置
  try {
    const planes = (typeof getActiveClipPlanes === 'function') ? getActiveClipPlanes() : [];
    state.models.forEach(m => {
      if (!m.material) return;
      if (planes.length > 0) { m.material.clippingPlanes = planes; m.material.clipShadows = true; }
      else { m.material.clippingPlanes = null; m.material.clipShadows = false; }
      m.material.needsUpdate = true;
    });
  } catch (e) {}
  try { updateLegend(); } catch (e) {}
  }

  // —— 标签页恢复 ——
  let restoredDocumentTab=null;const hasActiveDocument=(data.tabs||[]).some(tab=>tab.active);
  for (const t of (data.tabs || [])) {
    const previousTabs=new Set(tabViewers.keys());
    try {
      if (t.type === 'pdf') {
        const p = Object.values(state.pdfs).find(x => x.fileName === t.fileName && (!t.regionId || x.regionId===t.regionId));
        if (p) window.createNewTab('pdf', { pdfUrl: p.url, pdfName: p.fileName, pdfSize: p.size });
      } else if (t.type === 'word') {
        const w = Object.values(state.words).find(x => x.fileName === t.fileName && (!t.regionId || x.regionId===t.regionId));
        if (w) window.createNewTab('word', { wordUrl: w.url, wordName: w.fileName, wordSize: w.size });
      } else if (t.type === 'image') {
        const d = Object.values(state.drawings).find(x => x.fileName === t.fileName && (!t.regionId || x.regionId===t.regionId));
        if (d) window.createNewTab('image', { imageName: d.fileName, imageUrl: d.blobUrl });
      } else if (t.type === 'table' && t.isTestData) {
        const td = Object.values(state.testData).find(x => x.fileName === t.fileName && (!t.regionId || x.regionId===t.regionId));
        if (td) openTestDataTable(td, t.sheetName);
      } else if (t.type === 'table') {
        const tb = Object.values(state.tables).find(x => x.fileName === t.fileName && (!t.regionId || x.regionId===t.regionId));
        if (tb) {
          const res = await renderTableData(tb);
          if (typeof res === 'string') {
            window.createNewTab('table', { tableName: tb.fileName, tableHtml: res, tableRows: tb.rows, tableCols: tb.cols });
          } else {
          // 大表：首屏 + 分块懒加载
          window.createNewTab('table', {
            tableName: tb.fileName, tableHtml: res.firstHtml,
            tableRows: tb.rows, tableCols: tb.cols, lazyTable: res.lazy
          });
          }
        }
      }
      const added=Array.from(tabViewers.keys()).find(id=>!previousTabs.has(id));if(added&&(t.active||(!hasActiveDocument&&!viewerIds?.has(data.activeViewer))))restoredDocumentTab=added;
    } catch (e) { console.warn('[Project restoration] Unable to restore tab', t, e); }
  }

  if (viewerIds) {
    const targetId = viewerIds.get(data.activeViewer)||restoredDocumentTab;
    if (targetId) await window.switchTab(targetId);
    else if (!(data.tabs || []).length) window.switchTab('view');
  }
  return missing;
  } finally {
    projectRestoreInProgress = false;
    window.__lazyProjectRestore=false;
    if (window.researchRegions) researchRegions.finishRestore();
  }
}

async function restoreScopeProjectTree(tree,read,missing,scene,hasViewers) {
  for (const area of (tree.drillhole || [])) {
    addNewDrillholeAreaNode(area.name);
    const wrapper = subitemsDrillhole.firstChild;
    const catNodes = wrapper ? wrapper.querySelectorAll('[data-role="table-category"]') : [];
    const cats = area.children || [];
    for (let ci = 0; ci < cats.length; ci++) {
      const catNode = catNodes[ci];
      if (!catNode) continue;
      for (const f of (cats[ci].children || [])) {
        await restoreTableNode(catNode, f, read, missing);
      }
    }
  }

  // —— 三维地质模型 ——
  for (const mn of (tree.models3d || [])) {
    addNewModelNode(mn.name);
    const wrapper = subitems3DModel.firstChild;
    const nested = wrapper ? wrapper.querySelector(':scope > .lp-nested-items') : null;
    for (const cat of (mn.children || [])) {
      let catItem = wrapper ? wrapper.querySelector('[data-category="' + cat.name + '"]') : null;
      if (!catItem && nested) {
        const tmp = document.createElement('div');
        tmp.innerHTML = buildCategoryItem(cat.name);
        while (tmp.firstChild) nested.appendChild(tmp.firstChild);
        catItem = nested.querySelector('[data-category="' + cat.name + '"]');
        bindCategoryContextMenus(wrapper);
      }
      for (const f of (cat.children || [])) {
        await restoreModelNode(catItem, f, '3d', read, missing, scene, hasViewers);
      }
    }
  }

  // —— 地球化学模型 ——
  for (const mn of (tree.geochem || [])) {
    addNewGeochemModelNode(mn.name);
    const wrapper = subitemsGeochemModel.firstChild;
    const modelEl = wrapper ? wrapper.querySelector('[data-role="geochem-model-node"]') : null;
    for (const f of (mn.children || [])) {
      await restoreModelNode(modelEl, f, 'geochem', read, missing, scene, hasViewers);
    }
  }

  // —— 三维坑道模型 ——
  for (const mn of (tree.tunnel || [])) {
    addNewTunnelModelNode(mn.name);
    const wrapper = subitemsTunnelModel.firstChild;
    const modelEl = wrapper ? wrapper.querySelector('[data-role="tunnel-model-node"]') : null;
    for (const f of (mn.children || [])) {
      await restoreModelNode(modelEl, f, 'tunnel', read, missing, scene, hasViewers);
    }
  }

  // —— 块体模型 ——
  for (const group of (tree.block || [])) {
    const category=addNewBlockModelNode(group.name);
    for (const file of (group.children || [])) {
      const model=getProjectModels().find(model=>model.id===file.modelId);
      if(model){addBlockTreeNode(model,category);if(window.researchRegions)researchRegions.restoreFile(model.treeFileNode,file);}
    }
  }

  // —— 图件管理 ——
  for (const grp of (tree.drawing || [])) {
    addDrawingGroup(grp.name);
    const groups = subitemsDrawingMgmt.querySelectorAll('[data-role="drawing-group"]');
    const groupNode = groups[groups.length - 1];
    const gNested = groupNode ? groupNode.nextElementSibling : null;
    for (const cat of (grp.children || [])) {
      let catNode = null;
      if (gNested) {
        catNode = Array.from(gNested.querySelectorAll('[data-role="drawing-category"]'))
          .find(n => ((n.querySelector('span') || {}).textContent || '') === cat.name);
      }
      if (!catNode) {
        addDrawingSubCategory(groupNode, cat.name);
        catNode = gNested ? Array.from(gNested.querySelectorAll('[data-role="drawing-category"]')).pop() : null;
      }
      for (const f of (cat.children || [])) {
        await restoreDrawingNode(catNode, f, read, missing);
      }
    }
  }

  // —— 地表（第 102 节：遥感影像 / 地形图） ——
  //   ① 先按存档恢复「地表」下的图件；
  //   ② 再把旧存档遗留在「图件管理」下的同名分类（连同其中图件）整体搬到「地表」。
  await restoreSurfaceTree(tree.surface, read, missing, scene, hasViewers);
  migrateDrawingCatsToSurface();

  // —— 测试数据管理（任意嵌套） ——
  async function restoreTdChildren(items, folderNode) {
    for (const it of (items || [])) {
      if (it.children) {
        addTestDataFolderNode(it.name, folderNode);
        const folders = subitemsTestData.querySelectorAll('[data-role="testdata-folder"]');
        const nf = folders[folders.length - 1];
        await restoreTdChildren(it.children, nf);
      } else {
        await restoreTestDataFile(folderNode, it, read, missing);
      }
    }
  }
  await restoreTdChildren(tree.testdata, null);

  // —— 报告管理（任意嵌套） ——
  async function restoreReportChildren(items, folderNode) {
    for (const it of (items || [])) {
      if (it.children) {
        addReportFolderNode(it.name);
        const folders = subitemsReport.querySelectorAll('[data-role="report-folder"]');
        const nf = folders[folders.length - 1];
        await restoreReportChildren(it.children, nf);
      } else {
        // Word(.docx) 与 PDF 按扩展名分流恢复
        if (/\.docx$/i.test(it.fileName || '')) {
          await restoreWordFile(folderNode, it, read, missing);
        } else {
          await restorePdfFile(folderNode, it, read, missing);
        }
      }
    }
  }
  await restoreReportChildren(tree.report, null);
}

// —— 恢复表格文件节点（钻孔分类下） ——
async function restoreTableNode(categoryNode, f, read, missing) {
  // 静默跳过演示占位 / 无源文件条目（HTML 硬编码的占位图件等），不把噪音塞进 missing 弹窗
  if (!f.filePath && !f.fileName) return;
  const bytes = await read(f.filePath || f.fileName, f.fileName);
  if (!bytes) return;
  try {
    const ext = (f.ext || (f.fileName.split('.').pop() || '')).toLowerCase();
    let data = null;
    if (EXCEL_EXTS.indexOf(ext) !== -1) {
  await ensureDocumentLibrary('excel');
      const wb = await XLSX.read(bytes, { type: 'array', cellDates: true });
      if (!wb.SheetNames || wb.SheetNames.length === 0) throw new Error('No worksheets were found in the file');
      data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
    } else {
      const text = new TextDecoder('utf-8').decode(bytes);
      data = parseCsvText(text);
    }
    if (!data || data.length === 0) throw new Error('Table is empty');
    let truncated = false;
    let originalRows = data.length;
    let originalCols = data[0] ? data[0].length : 0;
    if (data.length > MAX_TABLE_ROWS) { data = data.slice(0, MAX_TABLE_ROWS); truncated = true; }
    if (data[0] && data[0].length > MAX_TABLE_COLS) { data = data.map(r => r.slice(0, MAX_TABLE_COLS)); truncated = true; }
    const id = 'table_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    state.tables[id] = {
      id: id, fileName: f.fileName, filePath: f.filePath || null, ext: ext,
      data: data, rows: data.length, cols: data[0] ? data[0].length : 0,
      truncated: truncated, originalRows: originalRows, originalCols: originalCols
    };
    const nested = categoryNode.nextElementSibling;
    if (nested && nested.classList.contains('lp-nested-items')) {
      const fileNode = document.createElement('div');
      fileNode.className = 'lp-sub-item';
      fileNode.setAttribute('data-table-id', id);
      fileNode.innerHTML = '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg><span>' + escapeHtml(f.fileName) + '</span>';
      nested.appendChild(fileNode);
      try { bindTableContextMenus(subitemsDrillhole); } catch (e) {}
    }
  } catch (err) {
    missing.push(f.fileName + '：' + err.message);
  }
}

// —— 恢复 3D 模型（3d 地质 / geochem 地球化学 / tunnel 坑道） ——
async function restoreModelNode(categoryItem, f, kind, read, missing, scene, useViewers) {
  const fileName = f.fileName || f.name;
  if (useViewers) {
    const model = getProjectModels().find(m => m.id === f.modelId);
    if (model && categoryItem) addFileNodeToCategory(categoryItem, fileName, model);
    return;
  }
  const sm = (scene.models || []).find(m => m.fileName === fileName);
  const color = sm ? sm.color : undefined;
  const opacity = sm ? sm.opacity : undefined;
  try {
    if (kind === 'tunnel') {
      const strPath = f.strFilePath || null;
      const dtmPath = f.filePath || null;
      // ★ 几何缓存优先：两个源文件路径齐备且命中时跳过「读盘 + 重新解析」
      let geoMesh = (strPath && dtmPath) ? await geoCacheTunnelGet(strPath, dtmPath) : null;
      if (!geoMesh && strPath && dtmPath && window.backendClient?.available) geoMesh = await parseLocalModel(dtmPath,strPath,()=>null);
      if (!geoMesh) {
        const strBytes = strPath ? await read(strPath, fileName + '.str') : null;
        const dtmBytes = await read(f.filePath || f.fileName, fileName + '.dtm');
        if (!dtmBytes) return;
        const strText = strBytes ? new TextDecoder('utf-8').decode(strBytes) : '';
        const dtmText = new TextDecoder('utf-8').decode(dtmBytes);
        pendingCategoryItem = categoryItem;
        geoMesh = parseTunnelModel(strText, dtmText, fileName);
        // 解析成功 → 异步写缓存（不等待本次恢复，供下次打开命中）
        if (strPath && dtmPath) geoCacheTunnelPut(strPath, dtmPath, geoMesh);
      } else {
        console.log('[Geometry cache] Tunnel model cache hit: ' + fileName);
      }
      pendingCategoryItem = categoryItem;
      geoMesh.source = { fileName: fileName };
      loadModelToScene(geoMesh, '3D Tunnel Models', fileName, { filePath: f.filePath || null, strFilePath: f.strFilePath || null });
    } else {
      const filePath = f.filePath || null;
      // ★ 几何缓存优先：有真实路径且命中时跳过「读盘 + 重新解析」
      let geoMesh = filePath ? await geoCacheTsGet(filePath) : null;
      if (!geoMesh && filePath && /\.(ts|obj|asc)$/i.test(filePath) && window.backendClient?.available) geoMesh = await parseLocalModel(filePath,null,()=>null);
      if (!geoMesh || !geoMesh.vertices || !geoMesh.vertices.length || !geoMesh.indices || !geoMesh.indices.length) {
        const bytes = await read(f.filePath || f.fileName, fileName);
        if (!bytes) return;
        const text = new TextDecoder('utf-8').decode(bytes);
        pendingCategoryItem = categoryItem;
        geoMesh = /\.asc$/i.test(filePath || fileName) ? parseASCTerrain(text, fileName) : /\.obj$/i.test(filePath || fileName) ? parseOBJText(text, fileName) : parseGOCADTS(text);
        if (!geoMesh.vertices.length || !geoMesh.indices.length) throw new Error('The model contains no valid vertices or triangles:  ' + fileName);
        if (filePath) geoCacheTsPut(filePath, geoMesh);
      } else {
        console.log('[Geometry cache] Hit .ts Model cache: ' + fileName);
      }
      pendingCategoryItem = categoryItem;
      geoMesh.source = { fileName: fileName };
      if (kind === 'geochem') {
        loadModelToScene(geoMesh, 'Geochemistry', fileName, { color: color, opacity: opacity, filePath: f.filePath || null });
      } else {
        const category = categoryItem ? (categoryItem.getAttribute('data-category') || 'Orebody') : 'Orebody';
        loadModelToScene(geoMesh, category, fileName, { color: color, opacity: opacity, filePath: f.filePath || null });
      }
    }
    if (sm && sm.visible === false) {
      const m = state.models.find(x => x.fileName === fileName);
      if (m) removeModelFromView(m);
    }
  } catch (err) {
    missing.push(fileName + '：' + err.message);
    console.warn('[Project restoration] Unable to restore model', fileName, err);
  }
}

// —— 恢复图件文件节点 ——
async function restoreDrawingNode(catNode, f, read, missing) {
  // 静默跳过演示占位 / 无源文件条目（HTML 硬编码的占位图件等），不把噪音塞进 missing 弹窗
  if (!f.filePath && !f.fileName) return;
  const bytes = await read(f.filePath || f.fileName, f.fileName);
  if (!bytes) return;
  const id = 'drawing_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const ext = f.ext || (f.fileName.split('.').pop() || '').toLowerCase();
  const mime = ext === 'svg' ? 'image/svg+xml' : (ext === 'tif' || ext === 'tiff') ? 'image/tiff' : ('image/' + ext);
  const blob = new Blob([bytes], { type: mime });
  const blobUrl = URL.createObjectURL(blob);
  state.drawings[id] = { id: id, fileName: f.fileName, filePath: f.filePath || null, ext: ext, blob: blob, blobUrl: blobUrl, terrainImageSource: f.terrainImageSource || null };
  if(f.manualRegistration){
    state.drawings[id].manualRegistration=f.manualRegistration;
    drawingRegisters[id]={key:id,drawingId:id,filePath:f.filePath||null,fileUrl:blobUrl,fileName:f.fileName,done:true,transform:f.manualRegistration.transform,points:f.manualRegistration.points,imageWidth:f.manualRegistration.imageWidth,imageHeight:f.manualRegistration.imageHeight};
  }
  const nested = catNode ? catNode.nextElementSibling : null;
  if (nested && nested.classList.contains('lp-nested-items')) {
    const fileNode = document.createElement('div');
    fileNode.className = 'lp-sub-item';
    fileNode.setAttribute('data-drawing-id', id);
    fileNode.innerHTML = '<svg class="sub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg><span>' + escapeHtml(f.fileName) + '</span>';
    nested.appendChild(fileNode);
    // ★ 第 102 节：按「该分类实际所在的容器」重绑（图件管理 / 地表皆可）
    try { bindDrawingContextMenus((catNode && catNode.parentElement) || subitemsDrawingMgmt); } catch (e) {}
  }
}

// —— 恢复「地表」大类（第 102 节：遥感影像 / 地形图） ——
async function restoreSurfaceTree(items, read, missing, savedScene, useViewers) {
  if (!subitemsSurface || !Array.isArray(items) || items.length === 0) return;
  for (const cat of items) {
    if (cat.name === 'Topographic map') cat.name = 'Geological Maps';
    if (cat.role === 'terrain-category') {
      const terrainCategory = window.ensureTerrainCategory();
      terrainCategory.querySelector('span').textContent = cat.name || 'Elevation';
      for (const file of (cat.children || [])) {
        await restoreModelNode(terrainCategory, file, '3d', read, missing, savedScene || {}, !!useViewers);
      }
      continue;
    }
    // 「地表」下的分类是内置固定节点，按名字定位；万一被改名/删除则补建
    let catNode = Array.from(subitemsSurface.querySelectorAll('[data-role="drawing-category"]'))
      .find(n => (cat.surfaceKind && n.dataset.surfaceKind === cat.surfaceKind) || ((n.querySelector('span') || {}).textContent || '').trim() === cat.name);
    if (!catNode) {
      if (!headerSurface) continue;
      // The surface root is lp-sub-items, unlike nested drawing folders.
      // Restore directly without triggering interactive creation or autosave.
      const template = document.createElement('div');
      template.innerHTML = buildDrawingCategoryNode(cat.name);
      while (template.firstChild) subitemsSurface.appendChild(template.firstChild);
      bindDrawingContextMenus(subitemsSurface);
      catNode = Array.from(subitemsSurface.querySelectorAll('[data-role="drawing-category"]')).pop();
      if (!catNode) continue;
    }
    if(cat.surfaceKind)catNode.dataset.surfaceKind=cat.surfaceKind;
    for (const f of (cat.children || [])) {
      await restoreDrawingNode(catNode, f, read, missing);
    }
  }
}

// ★ 第 102 节：旧存档兼容 —— 把「图件管理」下遗留的『遥感影像』『地形图』分类
//   （连同其中已导入的图件）整体搬到「地表」下的同名分类，然后移除旧节点，
//   避免同一分类在项目树上出现两处。返回被搬迁的图件节点数（>0 = 发生了迁移）。
function migrateDrawingCatsToSurface() {
  if (!subitemsSurface || !subitemsDrawingMgmt) return 0;
  const MOVED_NAMES = ['Remote Sensing Imagery', 'Topographic map', 'Geological map'];
  const nameOf = n => ((n.querySelector('span') || {}).textContent || '').trim();
  let moved = 0;
  MOVED_NAMES.forEach(nm => {
    const olds = Array.from(subitemsDrawingMgmt.querySelectorAll('[data-role="drawing-category"]'))
      .filter(n => nameOf(n) === nm);
    if (olds.length === 0) return;
    const targetName = nm === 'Topographic map' || nm === 'Geological map' ? 'Geological Maps' : nm;
    let target = Array.from(subitemsSurface.querySelectorAll('[data-role="drawing-category"]'))
      .find(n => nameOf(n) === targetName);
    if (!target) {
      const template = document.createElement('div');template.innerHTML = buildDrawingCategoryNode(targetName);
      while(template.firstChild)subitemsSurface.appendChild(template.firstChild);
      target = Array.from(subitemsSurface.querySelectorAll('[data-role="drawing-category"]')).pop();
    }
    const targetNested = target.nextElementSibling;
    if (!targetNested || !targetNested.classList || !targetNested.classList.contains('lp-nested-items')) return;
    olds.forEach(oldCat => {
      const oldNested = oldCat.nextElementSibling;
      if (oldNested && oldNested.classList && oldNested.classList.contains('lp-nested-items')) {
        while (oldNested.firstChild) { targetNested.appendChild(oldNested.firstChild); moved++; }
        oldNested.remove();
      }
      oldCat.remove();
    });
    // 迁移后让该分类处于展开可见状态
    target.classList.remove('collapsed');
    targetNested.classList.add('expanded');
  });
  if (moved > 0) {
    try { bindDrawingContextMenus(subitemsSurface); } catch (e) {}
    try { refreshDrawingRegButtons(); } catch (e) {}
  }
  return moved;
}

// —— 恢复 PDF 文件节点 ——
async function restorePdfFile(folderNode, f, read, missing) {
  // 静默跳过演示占位 / 无源文件条目（HTML 硬编码的占位图件等），不把噪音塞进 missing 弹窗
  if (!f.filePath && !f.fileName) return;
  const bytes = await read(f.filePath || f.fileName, f.fileName);
  if (!bytes) return;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const fileLike = { name: f.fileName, size: bytes.length, path: f.filePath || null };
  addPdfFileNode(fileLike, url, folderNode);
}

// —— 恢复测试数据文件节点 ——
async function restoreWordFile(folderNode, f, read, missing) {
  if (!f.filePath && !f.fileName) return;
  const bytes = await read(f.filePath || f.fileName, f.fileName);
  if (!bytes) return;
  const url = URL.createObjectURL(new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }));
  addWordFileNode({ name: f.fileName, size: bytes.length, path: f.filePath || null }, url, folderNode);
}

async function restoreTestDataFile(folderNode, f, read, missing) {
  // 静默跳过演示占位 / 无源文件条目（HTML 硬编码的占位图件等），不把噪音塞进 missing 弹窗
  if (!f.filePath && !f.fileName) return;
  const bytes = await read(f.filePath || f.fileName, f.fileName);
  if (!bytes) return;
  try {
    const ext = (f.fileName.split('.').pop() || '').toLowerCase();
    let wb = null;
    if (['xlsx', 'xlsm', 'xlsb', 'xls'].indexOf(ext) !== -1) {
  await ensureDocumentLibrary('excel');
      wb = await XLSX.read(bytes, { type: 'array', cellDates: true });
    } else if (['csv', 'txt', 'tsv'].indexOf(ext) !== -1) {
      const text = new TextDecoder('utf-8').decode(bytes);
      wb = { SheetNames: [], __plainRows: parseCsvText(text) };
    }
    if (!wb) throw new Error('Unsupported file format: . ' + ext);
    const restoredFile = new File([bytes], f.fileName);
    Object.defineProperty(restoredFile, 'path', { value: f.filePath || '' });
    addTestDataFileNode(restoredFile, wb, folderNode);
  } catch (err) {
    missing.push(f.fileName + '：' + err.message);
  }
}

// ============================================================
// 打开项目
// ============================================================
async function doOpenProject(requestedPath) {
  if (pointAddMode) {
    const ok = await guardLeavePointDraw('Opening another project');
    if (!ok) return;
  }
  if (!window.electronAPI || !window.electronAPI.showOpenDialog) { alert('This operation requires the desktop application, Unable to open the project file'); return; }
  const res = typeof requestedPath === 'string' ? { canceled:false,filePaths:[requestedPath] } : await window.electronAPI.showOpenDialog({
    title: 'Open project',
    filters: [{ name: 'ShanweiGeo project file', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return;
  const filePath = res.filePaths[0];
  const rr = await window.electronAPI.readProjectFile(filePath);
  if (!rr || !rr.ok) { alert('Unable to read the project file:  ' + (rr ? rr.error : 'Unknown error')); return; }
  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8').decode(base64ToBytes(rr.data)));
  } catch (e) {
    alert('Unable to parse the project file: The file may be corrupt'); return;
  }
  if (!data || data.format !== 'szproject') { alert('This is not a valid ShanweiGeo project file'); return; }
  if (hasProjectContent()) {
    if (!confirm('Opening a project replaces the current workspace, Continue??\n (Save first to keep the current workspace) ')) return;
  }
  currentProjectPath = filePath;
  currentProjectName = data.projectName || 'Untitled project';
  updateProjectSubtitle();
  showImportLoading('Opening project...');
  await new Promise(r => setTimeout(r, 30));
  try {
    clearProject();
    const missing = await restoreProject(data,{lazyViewers:true});
    recordRecentProject(filePath,currentProjectName);
    hideImportLoading();
    if (missing && missing.length > 0) {
      alert('Project opened, but ' + missing.length + ' files not found: \n' + missing.slice(0, 15).join('\n') + (missing.length > 15 ? '\n…' : ''));
    } else {
      alert('Project opened');
    }
  } catch (err) {
    hideImportLoading();
    alert('Unable to open project:  ' + err.message);
  }
}

// ============================================================
// 新建项目
// ============================================================
async function doNewProject() {
  if (pointAddMode) {
    const ok = await guardLeavePointDraw('Creating another project');
    if (!ok) return;
  }
  if (hasProjectContent()) {
    if (!confirm('Creating a project clears the current workspace, Continue??\n (Save first to keep the current workspace) ')) return;
  }
  modalPurpose = 'project-new-name';
  modalTitle.textContent = 'New project';
  modalLabel.textContent = 'Enter a new project name';
  modalInput.value = 'New project';
  modalCoordsysRow.style.display = 'none';
  modalSameCoordsys.checked = false;
  modalOverlay.classList.add('show');
  setTimeout(() => modalInput.focus(), 50);
}

function applyNewProject(name) {
  clearProject();
  currentProjectPath = null;
  currentProjectName = name || 'New project';
  updateProjectSubtitle();
  // 新建项目后清空上次会话草稿，避免下次启动误恢复旧现场
  try { if (window.electronAPI && window.electronAPI.clearSession) window.electronAPI.clearSession(); } catch (e) {}
  try { fitViewToAll(); } catch (e) {}
}

// ============================================================
// 几何缓存（第二层持久化 · IndexedDB）
// 把「解析结果 geoMesh」以 真实文件路径+修改时间+大小 为钥匙缓存到本地库，
// 打开项目 / 恢复会话时命中缓存 → 跳过读源文件+重新解析，直接建模型（秒开）。
// 只覆盖 .ts 地质模型 与 .str+.dtm 坑道模型（解析最耗时、收益最大的两类）。
// 门控：仅桌面环境（window.electronAPI.statProjectFile 存在）生效；
//       浏览器直接打开时自动跳过；演示数据无真实路径 → 不写缓存。
// 容错：任何一步出错都静默返回「未命中」，流程与现在完全一致，永不更差。
// 控制台工具：geoCacheStats() 查看占用 / geoCacheClearAll() 清空
// ============================================================

// IndexedDB 连接（懒加载 + 复用，失败静默禁用返回 null）
let _geoCacheDB = null;
function geoCacheOpenDB() {
  if (_geoCacheDB) return Promise.resolve(_geoCacheDB);
  try {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open('shanwei-geocache', 1); }
      catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains('meshes')) {
            db.createObjectStore('meshes', { keyPath: 'key' });
          }
        } catch (e) {}
      };
      req.onsuccess = () => { _geoCacheDB = req.result || null; resolve(_geoCacheDB); };
      req.onerror = () => { resolve(null); };
    });
  } catch (e) { return Promise.resolve(null); }
}

// 读取一条缓存记录（无/出错 → null）
async function geoCacheGet(key) {
  try {
    const db = await geoCacheOpenDB();
    if (!db) return null;
    return await new Promise((resolve) => {
      let tx, req;
      try {
        tx = db.transaction('meshes', 'readonly');
        req = tx.objectStore('meshes').get(key);
        req.onsuccess = () => { try { resolve(req.result || null); } catch (e) { resolve(null); } };
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  } catch (e) { return null; }
}

// 写入/覆盖一条缓存记录（失败静默）
async function geoCachePut(key, record) {
  try {
    const db = await geoCacheOpenDB();
    if (!db) return false;
    return await new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction('meshes', 'readwrite');
        tx.objectStore('meshes').put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  } catch (e) { return false; }
}

// 取磁盘文件 stat（仅桌面；无 electronAPI / 失败 → null）
async function geoStatFile(path) {
  try {
    if (!path || !window.electronAPI || !window.electronAPI.statProjectFile) return null;
    const r = await window.electronAPI.statProjectFile(path);
    return (r && r.ok) ? r : null;
  } catch (e) { return null; }
}

// —— .ts 地质 / 地球化学模型：钥匙 = 'ts:' + 真实路径 ——
function geoCacheTsKey(filePath) { return 'ts:' + filePath; }

async function geoCacheTsGet(filePath) {
  try {
    const st = await geoStatFile(filePath);
    if (!st) return null;
    const rec = await geoCacheGet(geoCacheTsKey(filePath));
    if (!rec || !rec.geo) return null;
    if (rec.size !== st.size || rec.mtimeMs !== st.mtimeMs) return null;  // 源文件被改 → 失效
    return rec.geo;
  } catch (e) { return null; }
}

async function geoCacheTsPut(filePath, geoMesh) {
  try {
    const st = await geoStatFile(filePath);
    if (!st || !geoMesh) return false;
    return await geoCachePut(geoCacheTsKey(filePath), {
      key: geoCacheTsKey(filePath),
      kind: 'ts',
      size: st.size,
      mtimeMs: st.mtimeMs,
      storedAt: Date.now(),
      geo: geoMesh            // 整个 geoMesh 结构化克隆（TypedArray 原样保留）
    });
  } catch (e) { return false; }
}

// —— 坑道模型：钥匙 = 'tunnel:' + str路径 + '|' + dtm路径，两个文件各自校验 ——
function geoCacheTunnelKey(strPath, dtmPath) { return 'tunnel:' + strPath + '|' + dtmPath; }

async function geoCacheTunnelGet(strPath, dtmPath) {
  try {
    const stStr = await geoStatFile(strPath);
    const stDtm = await geoStatFile(dtmPath);
    if (!stStr || !stDtm) return null;
    const rec = await geoCacheGet(geoCacheTunnelKey(strPath, dtmPath));
    if (!rec || !rec.geo) return null;
    if (rec.size !== stStr.size || rec.mtimeMs !== stStr.mtimeMs) return null;
    if (rec.size2 !== stDtm.size || rec.mtimeMs2 !== stDtm.mtimeMs) return null;
    return rec.geo;
  } catch (e) { return null; }
}

async function geoCacheTunnelPut(strPath, dtmPath, geoMesh) {
  try {
    const stStr = await geoStatFile(strPath);
    const stDtm = await geoStatFile(dtmPath);
    if (!stStr || !stDtm || !geoMesh) return false;
    return await geoCachePut(geoCacheTunnelKey(strPath, dtmPath), {
      key: geoCacheTunnelKey(strPath, dtmPath),
      kind: 'tunnel',
      size: stStr.size, mtimeMs: stStr.mtimeMs,
      size2: stDtm.size, mtimeMs2: stDtm.mtimeMs,
      storedAt: Date.now(),
      geo: geoMesh
    });
  } catch (e) { return false; }
}

// 统计缓存占用（控制台工具）
async function geoCacheStats() {
  try {
    const db = await geoCacheOpenDB();
    if (!db) return { ok: false, reason: 'IndexedDB Unavailable' };
    return await new Promise((resolve) => {
      let tx, req;
      try {
        tx = db.transaction('meshes', 'readonly');
        req = tx.objectStore('meshes').getAll();
        req.onsuccess = () => {
          try {
            const list = req.result || [];
            resolve({ ok: true, count: list.length, items: list.map(r => ({ key: r.key, kind: r.kind, storedAt: r.storedAt })) });
          } catch (e) { resolve({ ok: false, reason: e.message }); }
        };
        req.onerror = () => resolve({ ok: false, reason: 'Read failed' });
      } catch (e) { resolve({ ok: false, reason: e.message }); }
    });
  } catch (e) { return { ok: false, reason: e.message }; }
}

// 清空全部几何缓存（控制台工具）
async function geoCacheClearAll() {
  try {
    const db = await geoCacheOpenDB();
    if (!db) return { ok: false, reason: 'IndexedDB Unavailable' };
    return await new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction('meshes', 'readwrite');
        tx.objectStore('meshes').clear();
        tx.oncomplete = () => resolve({ ok: true });
        tx.onerror = () => resolve({ ok: false, reason: 'Unable to clear' });
        tx.onabort = () => resolve({ ok: false, reason: 'Clear interrupted' });
      } catch (e) { resolve({ ok: false, reason: e.message }); }
    });
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ============================================================
// 会话自动记忆（第一层持久化）
// 桌面环境：现场草稿固定保存到 userData/shanwei-session.json
//   · 关闭窗口  → 静默自动保存后退出（写盘失败才兜底弹「保存项目」框）
//   · 平时操作  → 图层列表变化防抖 2 秒自动保存（防崩溃/断电丢失）
//   · 启动程序  → 检测到草稿则恢复上次现场（同份草稿自动静默恢复，新草稿询问一次）
// 浏览器环境（无 electronAPI）：本区代码全部自动失效，行为与原来一致
// ============================================================

// 是否包含「真实导入」的工作内容（排除纯演示数据，演示模型无磁盘路径）
function hasRealProjectContent() {
  if (window.researchRegions && researchRegions.hasChanges()) return true;
  ensureProjectLevelStateFields();
  if (getProjectModels().some(m => m.filePath || m.strFilePath || m.isPointLayer || m.isLineLayer || m.isDrillhole)) return true;
  if (['tables', 'drawings', 'pdfs', 'words', 'testData', 'pointLayers', 'lineLayers']
      .some(key => Object.keys(state[key]).length > 0)) return true;
  // ★ 第 74 节补充：用户自建的「空分类 / 空子分类」也算真实工作内容。
  //   原实现只看 state 里有没有数据对象 —— 但「新建子分类」只改 DOM 树、不产生 state 条目，
  //   于是刚建好、还没导入图片的空子分类会被判定为「无内容」→ 草稿不落盘 → 重开项目消失。
  //   这正是需求 1 想解决的隐患：不弹保存窗口的前提，是草稿通道真的能存住。
  //   判据：树里存在用户自建节点。特征 —— data-role 为分类类角色且【不】带任何数据引用属性
  //   （data-table-id / data-drawing-id / data-pdf-id / data-word-id / data-testdata-id /
  //     data-model-id 都没有 → 说明这是个尚未挂载内容的容器节点，而非内置的固定骨架节点）。
  try {
    const roots = [subitemsDrawingMgmt, subitemsSurface, subitemsDrillhole, subitems3DModel,
                   subitemsGeochemModel, subitemsTunnelModel, subitemsTestData,
                   subitemsReport, subitemsPoint, subitemsLine];
    for (const root of roots) {
      if (!root) continue;
      const nodes = root.querySelectorAll('.lp-sub-item[data-role]');
      for (const n of nodes) {
        const role = n.getAttribute('data-role') || '';
        // 只认「分类/分组」类角色，避免把文件叶子节点误判
        if (!/categor|group|folder|area/.test(role)) continue;
        const hasDataRef = n.hasAttribute('data-table-id') || n.hasAttribute('data-drawing-id') ||
          n.hasAttribute('data-pdf-id') || n.hasAttribute('data-word-id') ||
          n.hasAttribute('data-testdata-id') || n.hasAttribute('data-model-id');
        if (hasDataRef) continue;
        // 内置固定骨架（如「图件管理」下的默认分类、「地表」下的遥感影像/地形图）不算用户工作内容：
        // 判据 = 该分类名不在任一内置清单里，或它有子节点（用户往里加过东西）
        const nm = ((n.querySelector('span') || {}).textContent || '').trim();
        const isDefaultCat = DEFAULT_DRAWING_SUBCATEGORIES.indexOf(nm) >= 0 ||
          SURFACE_BUILTIN_CATEGORIES.indexOf(nm) >= 0;
        const nested = n.nextElementSibling;
        const hasChild = !!(nested && nested.classList && nested.classList.contains('lp-nested-items')
                            && nested.children.length > 0);
        if (!isDefaultCat || hasChild) return true;
      }
    }
  } catch (e) {}
  return false;
}

// 立即保存会话草稿 → true=已落盘；false=无需保存（空/纯演示）或保存失败
async function saveSessionNow() {
  if (projectRestoreInProgress) return false;
  if (!window.electronAPI || !window.electronAPI.saveSession) return false;
  if (!hasRealProjectContent()) return false;
  try {
    const data = serializeProject();
    const r = await window.electronAPI.saveSession(JSON.stringify(data));
    return !!(r && r.ok);
  } catch (e) {
    return false;
  }
}

// 防抖 2 秒自动保存（图层列表变化时由观察器调用，防崩溃丢失）
let _sessionSaveTimer = null;
function scheduleSessionSave() {
  if (projectRestoreInProgress) return;
  if (!window.electronAPI || !window.electronAPI.saveSession) return;
  if (_sessionSaveTimer) clearTimeout(_sessionSaveTimer);
  _sessionSaveTimer = setTimeout(async () => {
    _sessionSaveTimer = null;
    try { await saveSessionNow(); } catch (e) {}
  }, 2000);
}

// 监听图层管理列表变化：导入/删除任何内容后自动落盘草稿
(function () {
  if (!window.electronAPI || !window.electronAPI.saveSession) return;
  try {
    const obs = new MutationObserver(() => {
      if (hasProjectContent()) scheduleSessionSave();
    });
    obs.observe(lmList, { childList: true, subtree: true });
  } catch (e) {}
})();

// 用草稿数据执行恢复动作（loading → 清场 → 重建），返回 true=恢复流程完成
async function restoreFromSession(data) {
  showImportLoading('Restoring the previous session...');
  await new Promise(r => setTimeout(r, 30));
  try {
    clearProject();
    currentProjectPath = null;
    currentProjectName = data.projectName || 'Project name';
    updateProjectSubtitle();
    const missing = await restoreProject(data,{lazyViewers:true});
    hideImportLoading();
    if (missing && missing.length > 0) {
      alert('Session restored, but ' + missing.length + ' source files missing: \n' + missing.slice(0, 15).join('\n') + (missing.length > 15 ? '\n…' : ''));
    }
    return true;
  } catch (err) {
    hideImportLoading();
    alert('Unable to restore session:  ' + err.message);
    return false;
  }
}

// 启动时探测上次现场 → true=已处理（无需再导入演示数据）；false=无草稿/取消/失败
async function maybeRestoreSession() {
  if (!window.electronAPI || !window.electronAPI.readSession || !window.electronAPI.clearSession) return true;
  let raw = null;
  try {
    const r = await window.electronAPI.readSession();
    if (r && r.ok && r.data) raw = r.data;
  } catch (e) {}
  if (!raw) return false; // 无草稿 → 交回调用方导入演示数据
  let data = null;
  try { data = JSON.parse(raw); } catch (e) {}
  if (!data || !data.scene) {
    try { await window.electronAPI.clearSession(); } catch (e) {}
    return false;
  }

  const savedAt = data.savedAt || '';
  const key = 'szs_session_decided';
  const decided = sessionStorage.getItem(key);
  // 本份草稿已确认过（如开发期文件监听 reload）→ 不再询问，按上次选择静默执行
  if (decided === savedAt) {
    const restored = await restoreFromSession(data);
    if (restored) return true;
    // 静默恢复失败：清草稿与记忆，交回演示数据兜底
    try { await window.electronAPI.clearSession(); } catch (e) {}
    sessionStorage.removeItem(key);
    return false;
  }
  if (decided === 'skip') return false; // 上次明确丢弃过同现场（草稿残留时兜底）

  // —— 首次遇到这份新草稿：询问一次 ——
  const name = data.projectName || 'Untitled project';
  const modelN = (data.scene.models || []).length;
  const tabN = (data.tabs || []).length;
  let timeTxt = '';
  try {
    const t = new Date(data.savedAt);
    if (!isNaN(t.getTime())) timeTxt = ', Saved to ' + t.toLocaleString('zh-CN', { hour12: false });
  } catch (e) {}
  const ask = 'A previous session was detected: \n Project“ ' + name + '」（' + modelN + ' models' + (tabN > 0 ? '，' + tabN + ' tabs' : '') + '）' + timeTxt + ' . \n\n Restore the previous session??\n· OK → Reload source files and restore the session automatically\n· Cancel → Discard draft and load demo data';
  if (!confirm(ask)) {
    try { await window.electronAPI.clearSession(); } catch (e) {}
    sessionStorage.setItem(key, 'skip');
    return false;
  }
  sessionStorage.setItem(key, savedAt);
  const restored2 = await restoreFromSession(data);
  if (restored2) return true;
  // 恢复失败：清草稿与记忆，避免下次启动反复卡在同一现场
  try { await window.electronAPI.clearSession(); } catch (e) {}
  sessionStorage.removeItem(key);
  return false;
}

// ============================================================
// 关闭前询问：主进程拦截 close → 弹窗询问是否保存
// ============================================================
(function () {
  if (!window.electronAPI || !window.electronAPI.onCloseRequest) return;
  const overlay = document.getElementById('project-close-overlay');
  if (!overlay) return;
  window.electronAPI.onCloseRequest(async () => {
    // ⓪ 若正在点绘制：先把绘制态收尾（结束绘制会保存到类别），再走原流程
    if (typeof pointAddMode !== 'undefined' && pointAddMode) {
      try { setPointAddMode(false); } catch (e) {}
    }
    // ① 自动记忆：静默保存现场草稿，成功则直接放行关闭（不再打断用户）
    try {
      const saved = await saveSessionNow();
      if (saved) { window.electronAPI.allowClose(); return; }
    } catch (e) {}
    // ② 有真实工作内容但保存失败 → 兜底弹「保存项目文件」框，防止数据丢失
    if (hasRealProjectContent()) {
      const nm = document.getElementById('project-close-name');
      if (nm) nm.textContent = currentProjectName;
      overlay.style.display = 'flex';
      return;
    }
    // ③ 空场景 / 纯演示数据 → 直接放行
    window.electronAPI.allowClose();
  });
  document.getElementById('project-close-cancel').addEventListener('click', () => {
    overlay.style.display = 'none';
  });
  document.getElementById('project-close-nosave').addEventListener('click', () => {
    overlay.style.display = 'none';
    window.electronAPI.allowClose();
  });
  document.getElementById('project-close-save').addEventListener('click', async () => {
    overlay.style.display = 'none';
    const saved = await doSaveProject();
    if (saved) window.electronAPI.allowClose();
  });
})();

/* ============================================================
 * AI 智勘助手悬浮球：按住拖动换位 + 位置记忆（localStorage）
 * 要点：
 *  1. pointerdown 记录起点，位移 >4px 才算"拖动"（否则视为点击，
 *     为以后接入 AI 对话面板保留语义）；
 *  2. 拖动中加 .dragging 禁过渡动画，位置限制在窗口可视区内；
 *  3. 松手把 {left,top} 记忆到 localStorage('szs_aiFabPos')，
 *     下次启动自动恢复；位置被挤出屏幕（改窗口大小）时自动夹回。
 * ============================================================ */
(function () {
  const fab = document.querySelector('.ai-fab');
  if (!fab) return;
  const POS_KEY = 'szs_aiFabPos';
  const MOVE_THRESHOLD = 4;   // px，位移超过此值才判定为拖动
  let dragging = false, moved = false;
  let startX = 0, startY = 0, baseLeft = 0, baseTop = 0;
  let curLeft = 0, curTop = 0;

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function savePos() {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ left: Math.round(curLeft), top: Math.round(curTop) }));
    } catch (err) { /* 存储异常静默忽略 */ }
  }

  function restorePos() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (typeof p.left !== 'number' || typeof p.top !== 'number') return;
      const L = clamp(p.left, 0, Math.max(0, window.innerWidth - fab.offsetWidth));
      const T = clamp(p.top, 0, Math.max(0, window.innerHeight - fab.offsetHeight));
      fab.style.left = L + 'px';
      fab.style.top = T + 'px';
      fab.style.bottom = 'auto';
    } catch (e) { /* 损坏数据静默回退左下角默认位 */ }
  }

  fab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const r = fab.getBoundingClientRect();
    baseLeft = r.left; baseTop = r.top;
    curLeft = r.left; curTop = r.top;
    startX = e.clientX; startY = e.clientY;
    dragging = true; moved = false;
    try { fab.setPointerCapture(e.pointerId); } catch (err) {}
  });

  fab.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
    if (!moved) {
      moved = true;
      fab.classList.add('dragging');
    }
    const L = clamp(baseLeft + dx, 0, Math.max(0, window.innerWidth - fab.offsetWidth));
    const T = clamp(baseTop + dy, 0, Math.max(0, window.innerHeight - fab.offsetHeight));
    curLeft = L; curTop = T;
    fab.style.left = L + 'px';
    fab.style.top = T + 'px';
    fab.style.bottom = 'auto';
    e.preventDefault();
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    if (moved) {
      fab.classList.remove('dragging');
      savePos();
    }
  }
  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('pointercancel', endDrag);

  // 窗口尺寸变化：若当前位置被挤出可视区则自动夹回并更新记忆
  window.addEventListener('resize', () => {
    const r = fab.getBoundingClientRect();
    const L = clamp(r.left, 0, Math.max(0, window.innerWidth - fab.offsetWidth));
    const T = clamp(r.top, 0, Math.max(0, window.innerHeight - fab.offsetHeight));
    if (L !== r.left || T !== r.top) {
      fab.style.left = L + 'px';
      fab.style.top = T + 'px';
      fab.style.bottom = 'auto';
      curLeft = L; curTop = T;
      savePos();
    }
  });

  // 初始化：恢复记忆位置（DOM 就绪后执行）
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', restorePos);
  } else {
    restorePos();
  }
})();

