(function () {
  'use strict';
  const levels = ['deposit', 'area', 'section'];
  const names = { deposit: 'Deposit', area: 'Area', section: 'Section' };
  const defaultId = 'research-unassigned';
  const selector = '.lp-sub-item[data-model-id],.lp-sub-item[data-drawing-id],.lp-sub-item[data-table-id],.lp-sub-item[data-pdf-id],.lp-sub-item[data-word-id],.lp-sub-item[data-testdata-id],.lp-sub-item[data-vector-id],.lp-sub-item[data-point-id],.lp-sub-item[data-line-id]';
  let regions, currentId, restoring = false, host, tree, breadcrumb, editor, editorDialog, contextMenu;
  function defaults() {
    return { version: 1, currentId: defaultId, nodes: [
      { id: 'research-default-deposit', parentId: null, type: 'deposit', name: 'Default Deposit' },
      { id: 'research-default-area', parentId: 'research-default-deposit', type: 'area', name: 'Default Area' },
      { id: defaultId, parentId: 'research-default-area', type: 'section', name: 'Unassigned Section' }
    ] };
  }
  function validate(value) {
    if (!value) return defaults();
    if (value.version !== 1 || !Array.isArray(value.nodes) || !value.nodes.length) throw new Error('Invalid saved research region format');
    const ids = new Map(), siblings = new Set();
    const nodes = value.nodes.map(node => {
      if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id) || !levels.includes(node.type) || typeof node.name !== 'string' || !node.name.trim() || node.name.length > 80) throw new Error('Invalid research region node');
      const copy = { id: node.id, parentId: node.parentId || null, type: node.type, name: node.name.trim() };
      ids.set(copy.id, copy); return copy;
    });
    for (const node of nodes) {
      const level = levels.indexOf(node.type), parent = ids.get(node.parentId);
      if (level === 0 ? node.parentId !== null : !parent || parent.type !== levels[level - 1]) throw new Error('Research regions must follow the hierarchy: deposit,, Area, section order');
      const key = JSON.stringify([node.parentId, node.name]);
      if (siblings.has(key)) throw new Error('Duplicate research region names exist at the same level');
      siblings.add(key);
    }
    return { version: 1, nodes, currentId: ids.has(value.currentId) ? value.currentId : nodes[nodes.length - 1].id };
  }
  const find = id => regions.find(node => node.id === id);
  const validOwner = id => find(id) ? id : (find(defaultId) ? defaultId : currentId);
  function pathName(id) {
    const chain = []; let node = find(id);
    while (node) { chain.unshift(node.name); node = find(node.parentId); }
    return chain.join(' › ');
  }
  function changed() { if (typeof scheduleSessionSave === 'function' && !restoring) scheduleSessionSave(); }
  function select(id, options) {
    if (!find(id)) throw new Error('Research region does not exist');
    const previous=currentId;
    if (window.researchScopeTrees) researchScopeTrees.activate(id);
    currentId = id; render(); changed();
    if(!restoring&&!options?.fromView)window.researchRegionViews?.onRegionSelected(id,previous);
  }
  function add(type, name, parentId) {
    name = String(name || '').trim();
    if (!name || name.length > 80) throw new Error('Name must contain 1 to 80 characters');
    const level = levels.indexOf(type), parent = find(parentId);
    if (level < 0 || (level === 0 ? parentId != null : !parent || parent.type !== levels[level - 1])) throw new Error('Select the appropriate parent region first');
    parentId = parentId || null;
    if (regions.some(node => node.parentId === parentId && node.name === name)) throw new Error('This name already exists under the same parent');
    const id = 'research-' + crypto.randomUUID(); regions.push({ id, type, parentId, name }); select(id); return id;
  }
  function rename(id, name) {
    const node = find(id); name = String(name || '').trim();
    if (!node || !name || name.length > 80) throw new Error('Name must contain 1 to 80 characters');
    if (regions.some(other => other.id !== id && other.parentId === node.parentId && other.name === name)) throw new Error('This name already exists under the same parent');
    node.name = name; render(); changed();
  }
  function deletionInfo(id) {
    const node = find(id); if (!node) throw new Error('Research region does not exist');
    const ids = new Set([id]); let count;
    do { count = ids.size; regions.forEach(item => { if (ids.has(item.parentId)) ids.add(item.id); }); } while (count !== ids.size);
    const remaining = regions.filter(item => !ids.has(item.id));
    if (!remaining.length) throw new Error('Create another deposit first, before deleting the last deposit');
    const destination = node.parentId || remaining.find(item => item.type === 'deposit').id;
    sync(); const records = new Set();
    fileNodes().forEach(item => { if (ids.has(item.dataset.regionId)) records.add(recordFor(item) || item); });
    getProjectModels().forEach(model => { if (ids.has(model.regionId)) records.add(model); });
    return { ids, destination, count: records.size, path: pathName(id), destinationPath: pathName(destination) };
  }
  function remove(id) {
    const info = deletionInfo(id);
    if (window.researchScopeTrees) researchScopeTrees.rehomeDeleted(info.ids,info.destination);
    regions = regions.filter(node => !info.ids.has(node.id));
    fileNodes().forEach(node => { if (info.ids.has(node.dataset.regionId)) own(node,info.destination); });
    getProjectModels().forEach(model => { if (info.ids.has(model.regionId)) model.regionId = info.destination; });
    for (const key of ['drawings','tables','pdfs','words','testData','pointLayers','lineLayers']) {
      Object.values(state[key] || {}).forEach(record => { if (info.ids.has(record.regionId)) record.regionId = info.destination; });
    }
    if (info.ids.has(currentId)) currentId = info.destination;
    render(); changed(); return info;
  }
  function recordFor(node) {
    const pairs = [['drawing','drawings'],['table','tables'],['pdf','pdfs'],['word','words'],['testdata','testData'],['point','pointLayers'],['line','lineLayers']];
    for (const [attribute, store] of pairs) if (node.dataset[attribute + 'Id'] && state[store]) return state[store][node.dataset[attribute + 'Id']];
    if (node.dataset.modelId) return getProjectModels().find(model => model.id === node.dataset.modelId);
    if (node.dataset.vectorId) return window.vectorStore?.[node.dataset.vectorId];
    return null;
  }
  function fileNodes() { return window.researchScopeTrees ? researchScopeTrees.allFiles() : Array.from(document.querySelectorAll(selector)); }
  function ownerOf(node) { return window.researchScopeTrees ? researchScopeTrees.ownerOf(node) : currentId; }
  function own(node, id) {
    id = validOwner(id); node.dataset.regionId = id;
    const record = recordFor(node); if (record) record.regionId = id;
    if(node.dataset.vectorId && record?.modelId)getProjectModels().forEach(model=>{if(model.id===record.modelId)model.regionId=id;});
    if(node.dataset.pointId || node.dataset.lineId)getProjectModels().forEach(model=>{if(model.pointLayerId===node.dataset.pointId && node.dataset.pointId || model.lineLayerId===node.dataset.lineId && node.dataset.lineId)model.regionId=id;});
  }
  function sync() {
    fileNodes().forEach(node => {
      const record = recordFor(node);
      own(node, node.dataset.regionId || record?.regionId || (window.researchScopeTrees && record?.blob ? researchScopeTrees.fileScope(record.blob) : null) || (restoring ? validOwner(defaultId) : ownerOf(node.parentNode)));
    });
    if (typeof getProjectModels === 'function') getProjectModels().forEach(model => { model.regionId = validOwner(model.regionId || currentId); });
  }
  function reset() { const value = defaults(); regions = value.nodes; currentId = value.currentId; if(window.researchScopeTrees)researchScopeTrees.reset(); render(); }
  function restore(value) { const saved = validate(value); regions = saved.nodes; currentId = saved.currentId; restoring = true; render(); }
  function finishRestore() { sync(); if(window.researchScopeTrees)researchScopeTrees.finishRestore(); restoring = false; render(); }
  function serialize() { sync(); return { version: 1, currentId, nodes: regions.map(node => ({ ...node })), ...(window.researchScopeTrees?{trees:researchScopeTrees.serializeTrees()}: {}) }; }
  function hasChanges() { return JSON.stringify({ nodes: regions, currentId }) !== JSON.stringify({ nodes: defaults().nodes, currentId: defaultId }) || !!window.researchScopeTrees?.hasCustomTree(); }
  function restoreFile(node, file) { if (node) own(node, file.regionId || defaultId); return node; }
  function installRestoreHooks() {
    for (const name of ['restoreTableNode','restoreDrawingNode','restoreModelNode','restorePdfFile','restoreWordFile','restoreTestDataFile']) {
      const original = window[name]; if (typeof original !== 'function') continue;
      window[name] = async function (...args) {
        const before = new Set(document.querySelectorAll(selector));
        const result = await original.apply(this,args), file = args[1] || {};
        document.querySelectorAll(selector).forEach(node => { if (!before.has(node)) restoreFile(node,file); });
        return result;
      };
    }
  }
  function closeEditor() { if (editorDialog.open) editorDialog.close(); }
  function closeContextMenu() { if (contextMenu) contextMenu.hidden = true; }
  function showContextMenu(event, id) {
    event.preventDefault(); event.stopPropagation();
    const anchor = event.currentTarget.getBoundingClientRect();
    if (typeof hideCtxMenu === 'function') hideCtxMenu();
    if (id) select(id);
    contextMenu.replaceChildren();
    function action(label, callback, data) {
      const item = document.createElement('button'); item.type = 'button'; item.className = 'ctx-menu-item' + (data?.action === 'delete' ? ' danger' : ''); item.textContent = label; item.setAttribute('role','menuitem');
      Object.assign(item.dataset,data || {});
      const icon = document.querySelector((data?.action === 'delete' ? '#ctx-delete' : data?.action === 'rename' ? '#ctx-rename' : '#ctx-new-report-folder') + ' svg');
      if (icon) item.prepend(icon.cloneNode(true));
      item.onclick = () => { closeContextMenu(); callback(); }; contextMenu.append(item);
    }
    action('New deposit', () => form('deposit'), {add:'deposit'});
    const node = find(id);
    if (node) {
      const childType = levels[levels.indexOf(node.type) + 1];
      if (childType) action('New ' + names[childType], () => form(childType), {add:childType});
      action('Rename', () => form(null,id), {action:'rename'});
      action('Delete', () => deleteForm(id), {action:'delete'});
    }
    contextMenu.hidden = false;
    const rect = contextMenu.getBoundingClientRect();
    const x = event.clientX || anchor.left, y = event.clientY || anchor.bottom;
    contextMenu.style.left = Math.max(4,Math.min(x,window.innerWidth - rect.width - 4)) + 'px';
    contextMenu.style.top = Math.max(4,Math.min(y,window.innerHeight - rect.height - 4)) + 'px';
    contextMenu.querySelector('button').focus();
  }
  function openEditor(input) {
    if (!editorDialog.open) editorDialog.showModal();
    requestAnimationFrame(() => { if (editorDialog.open && input) { input.focus(); input.select(); } });
  }
  function deleteForm(id) {
    editor.replaceChildren(); editor.onsubmit = null;
    const heading = document.createElement('strong'); heading.textContent = 'Delete research region';
    const message = document.createElement('p'); message.className = 'rr-delete-message';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = closeEditor;
    try {
      const info = deletionInfo(id);
      message.textContent = 'Delete“ ' + info.path + ' ”and its descendants, Total ' + info.ids.size + ' regions. Affected ' + info.count + ' data items, will be assigned to“' + info.destinationPath + ' ”. Original file, Models and registration results are retained. ';
      const confirm = document.createElement('button'); confirm.type = 'submit'; confirm.textContent = 'Confirm deletion'; confirm.className = 'rr-delete-confirm';
      editor.append(heading,message,confirm,cancel);
      editor.onsubmit = event => { event.preventDefault(); remove(id); closeEditor(); };
    } catch (error) { message.textContent = error.message; editor.append(heading,message,cancel); }
    openEditor();
  }
  function form(type, id) {
    const node = find(id); editor.replaceChildren();
    const title = document.createElement('strong'); title.textContent = type ? 'Add ' + names[type] : 'Rename ' + names[node.type];
    const parentId = type === 'deposit' ? null : currentId;
    const input = document.createElement('input'); input.type = 'text'; input.maxLength = 80; input.required = true; input.value = type ? '' : node.name; input.setAttribute('aria-label','Research region name'); input.autocomplete = 'off';
    input.addEventListener('keydown', event => { event.stopPropagation(); if (event.isComposing && event.key === 'Enter') event.preventDefault(); });
    const location = document.createElement('small'); location.textContent = type === 'deposit' ? 'Project root' : pathName(type ? currentId : node.parentId);
    const error = document.createElement('p'); error.className = 'rr-error';
    const save = document.createElement('button'); save.textContent = 'Save'; save.type = 'submit';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.type = 'button'; cancel.onclick = closeEditor;
    editor.append(title, location, input, error, save, cancel); openEditor(input);
    editor.onsubmit = event => { event.preventDefault(); try { if (type) add(type,input.value,parentId); else rename(id,input.value); closeEditor(); } catch (exception) { error.textContent = exception.message; } };
  }
  function render() {
    if (!host) return;
    tree.replaceChildren();
    function branch(parentId, container) {
      regions.filter(node => node.parentId === parentId).forEach(node => {
        const row = document.createElement('div'); row.className = 'rr-row'; row.dataset.regionLevel = node.type;
        const button = document.createElement('button'); button.type = 'button'; button.textContent = names[node.type] + ' · ' + node.name; button.title = pathName(node.id) + '  (Right-click to manage) '; button.dataset.regionNodeId = node.id; button.classList.toggle('active',node.id === currentId); button.setAttribute('aria-pressed',String(node.id === currentId)); button.onclick = () => { closeContextMenu(); select(node.id); }; button.oncontextmenu = event => showContextMenu(event,node.id); row.append(button);
        const label=document.createElement('span');label.className='rr-node-label';label.textContent=button.textContent;button.replaceChildren(label);
        if(node.id===currentId){button.setAttribute('aria-current','true');const badge=document.createElement('span');badge.className='rr-active-badge';badge.textContent='Active';button.append(badge);}
        container.append(row); const children = document.createElement('div'); children.className = 'rr-children'; row.append(children); branch(node.id,children);
      });
    }
    branch(null,tree); breadcrumb.textContent = 'Current display ' + names[find(currentId)?.type] + ' Data: ' + pathName(currentId); breadcrumb.title = pathName(currentId);
    requestAnimationFrame(()=>tree.querySelector('button.active')?.scrollIntoView({block:'nearest'}));
    const scopeLabel=document.getElementById('research-current-scope');
    if(scopeLabel){const shown=find(tabViewers.get(activeTabId)?.regionId)||find(currentId);scopeLabel.textContent='Current display '+names[shown.type]+' Data: '+pathName(shown.id);scopeLabel.title=scopeLabel.textContent;}
    window.researchRegionViews?.refreshNames();
  }
  function mount() {
    const projectTree = document.querySelector('.lp-tree'); if (!projectTree) return;
    host = document.createElement('section'); host.className = 'research-regions'; host.setAttribute('aria-label','Research region management');
    const heading = document.createElement('h3'); heading.textContent = 'Research Regions'; heading.title = 'Right-click to create a deposit';
    contextMenu = document.createElement('div'); contextMenu.className = 'ctx-menu rr-context-menu'; contextMenu.setAttribute('role','menu'); contextMenu.hidden = true; document.body.append(contextMenu);
    host.oncontextmenu = event => showContextMenu(event,null);
    document.addEventListener('pointerdown',event => { if (!contextMenu.contains(event.target)) closeContextMenu(); },true);
    document.addEventListener('keydown',event => { if (event.key === 'Escape' && !contextMenu.hidden) { event.preventDefault(); closeContextMenu(); } });
    window.addEventListener('blur',closeContextMenu);
    window.addEventListener('resize',closeContextMenu);
    window.addEventListener('scroll',closeContextMenu,true);
    editorDialog = document.createElement('dialog'); editorDialog.className = 'rr-dialog'; editorDialog.setAttribute('aria-label','Edit research region');
    editor = document.createElement('form'); editor.className = 'rr-editor'; editorDialog.append(editor); document.body.append(editorDialog);
    tree = document.createElement('div'); tree.className = 'rr-tree'; breadcrumb = document.createElement('p'); breadcrumb.className = 'rr-scope';
    host.append(heading,tree); projectTree.before(host);
    const scope = document.createElement('div'); scope.id = 'research-current-scope'; scope.className = 'rr-current';
    document.getElementById('canvas-wrap')?.append(scope);
    render();
    const observer = new MutationObserver(() => { if (!restoring) sync(); }); observer.observe(projectTree,{childList:true,subtree:true});
    projectTree.addEventListener('change',event => { if (event.target.type === 'file') sync(); });
    sync();
  }
  window.researchRegions = { defaults, validate, add, rename, select, remove, deletionInfo, serialize, restore, finishRestore, reset, sync, restoreFile, pathName, hasChanges, installRestoreHooks, ownerOf, list:()=>regions.map(node=>({...node})), get currentId() { return currentId; }, get isRestoring() { return restoring; } };
  reset(); mount();
})();
