(function () {
  'use strict';
  const rr = researchRegions;
  const roots = Object.fromEntries(Object.entries({ drillhole:'subitems-drillhole', models3d:'subitems-3d-model', geochem:'subitems-geochem-model', tunnel:'subitems-tunnel-model', block:'subitems-block-model', drawing:'subitems-drawing-mgmt', surface:'subitems-surface', testdata:'subitems-testdata', report:'subitems-report', point:'subitems-point', line:'subitems-line' }).map(([key,id])=>[key,document.getElementById(id)]).filter(([,node])=>node));
  const files = '.lp-sub-item[data-model-id],.lp-sub-item[data-drawing-id],.lp-sub-item[data-table-id],.lp-sub-item[data-pdf-id],.lp-sub-item[data-word-id],.lp-sub-item[data-testdata-id],.lp-sub-item[data-vector-id],.lp-sub-item[data-point-id],.lp-sub-item[data-line-id]';
  const stores = new Map(), templates = {};
  const importOwners = new WeakMap();
  let mounted = rr.currentId, restoringTrees = false;
  for (const [key,root] of Object.entries(roots)) {
    templates[key] = (initialTreeHTML && initialTreeHTML[key]) || root.innerHTML;
    root.dataset.regionId = mounted;
  }
  function blank(key,id) {
    const holder=document.createElement('div'); holder.innerHTML=templates[key];
    holder.querySelectorAll(files).forEach(node=>{const nested=node.nextElementSibling;if(nested?.classList.contains('lp-nested-items'))nested.remove();node.remove();});
    holder.querySelectorAll('.lp-sub-item').forEach(node=>node.dataset.regionId=id);
    const fragment=document.createDocumentFragment();fragment._rrScope=id;fragment._rrKey=key;
    while(holder.firstChild)fragment.append(holder.firstChild);return fragment;
  }
  function store(id) {
    if(!stores.has(id))stores.set(id,Object.fromEntries(Object.keys(roots).map(key=>[key,blank(key,id)])));
    return stores.get(id);
  }
  function bind() {
    const bindings=[['drillhole',['bindDrillholeAreaContextMenus','bindTableContextMenus']],['models3d',['bindCategoryContextMenus']],['geochem',['bindGeochemContextMenus']],['tunnel',['bindTunnelContextMenus']],['block',['bindBlockContextMenus']],['drawing',['bindDrawingContextMenus']],['surface',['bindDrawingContextMenus']],['testdata',['bindTestDataContextMenus']],['report',['bindReportContextMenus']]];
    bindings.forEach(([key,names])=>names.forEach(name=>{if(typeof window[name]==='function')window[name](roots[key]);}));
  }
  function park() {
    const saved={};for(const [key,root] of Object.entries(roots)){const fragment=document.createDocumentFragment();fragment._rrScope=mounted;fragment._rrKey=key;while(root.firstChild)fragment.append(root.firstChild);saved[key]=fragment;}stores.set(mounted,saved);
  }
  function activate(id) {
    if(id===mounted)return;
    rr.sync();park();mounted=id;
    const saved=store(id);for(const [key,root] of Object.entries(roots)){root.dataset.regionId=id;root.append(saved[key]);}
    bind();
  }
  function allFiles() {
    const nodes=new Set();Object.values(roots).forEach(root=>root.querySelectorAll(files).forEach(node=>nodes.add(node)));
    stores.forEach(saved=>Object.values(saved).forEach(root=>root.querySelectorAll(files).forEach(node=>nodes.add(node))));return Array.from(nodes);
  }
  function allContainers() {return [...Object.values(roots),...Array.from(stores.values()).flatMap(saved=>Object.values(saved))];}
  function ownerOf(node) {
    while(node){if(node.dataset?.regionId)return node.dataset.regionId;if(node._rrScope)return node._rrScope;node=node.parentNode;}return mounted;
  }
  function stamp() {allContainers().forEach(root=>root.querySelectorAll('.lp-sub-item').forEach(node=>{if(!node.dataset.regionId)node.dataset.regionId=ownerOf(node.parentNode);}));}
  function hasCustomTree() {
    function signature(root){return JSON.stringify(Array.from(root.querySelectorAll('.lp-sub-item')).filter(node=>!node.matches(files)).map(node=>[node.dataset.role||'',node.dataset.category||'',caption(node)]));}
    for(const [key,root] of Object.entries(roots)){const holder=document.createElement('div');holder.innerHTML=templates[key];const baseline=signature(holder);if(signature(root)!==baseline)return true;for(const saved of stores.values())if(saved[key].childNodes.length&&signature(saved[key])!==baseline)return true;}return false;
  }
  function reset() {stores.clear();mounted='research-unassigned';restoringTrees=false;Object.values(roots).forEach(root=>root.dataset.regionId=mounted);}
  function serializeTrees() {
    stamp();const original=mounted,result=Object.create(null);
    try{rr.list().forEach(node=>{activate(node.id);result[node.id]=serializeTree();});}finally{activate(original);}return result;
  }
  function combined(trees) {
    const result={};
    function merge(target,items){for(const item of items){const branch=Array.isArray(item.children)&&!item.fileName&&!item.modelId;const existing=branch?target.find(node=>Array.isArray(node.children)&&!node.fileName&&node.name===item.name&&node.role===item.role&&node.surfaceKind===item.surfaceKind):null;if(existing){merge(existing.children,item.children);if(existing.regionId!==item.regionId)delete existing.regionId;}else target.push(JSON.parse(JSON.stringify(item)));}}
    const ordered=[trees[rr.currentId],...Object.entries(trees).filter(([id])=>id!==rr.currentId).map(([,tree])=>tree)].filter(Boolean);
    ordered.forEach(tree=>Object.entries(tree).forEach(([key,items])=>merge(result[key]||(result[key]=[]),items)));return result;
  }
  async function restoreTrees(trees,restoreOne) {
    restoringTrees=true;
    for(const node of rr.list()){
      activate(node.id);const tree=trees[node.id]||{};
      Object.entries(roots).forEach(([key,root])=>{if(Array.isArray(tree[key]))root.replaceChildren();});
      await restoreOne(tree);stamp();
    }
  }
  function rootKey(node) {while(node){if(node._rrKey)return node._rrKey;const pair=Object.entries(roots).find(([,root])=>root===node);if(pair)return pair[0];node=node.parentNode;}return null;}
  function caption(node) {return node.querySelector(':scope > span')?.textContent||'';}
  function matchHeader(root,source) {
    const candidates=Array.from(root.querySelectorAll(':scope > .lp-sub-item,:scope > div > .lp-sub-item')).filter(node=>!node.matches(files)&&node.dataset.role===source.dataset.role&&node.dataset.category===source.dataset.category);
    return candidates.find(node=>caption(node)===caption(source)) || candidates.find(node=>source.dataset.pageNodeId&&node.dataset.pageNodeId===source.dataset.pageNodeId) || candidates.find(node=>source.dataset.surfaceKind&&node.dataset.surfaceKind===source.dataset.surfaceKind) || (candidates.length===1?candidates[0]:null);
  }
  function moveNode(node,destination,existingTarget) {
    const key=rootKey(node);if(!key)throw new Error('Data category not found');
    if(ownerOf(node.parentNode)===destination&&(!existingTarget||existingTarget===node.parentNode)){rr.restoreFile(node,{regionId:destination});return;}
    const path=[];let parent=node.parentNode;
    while(parent&&parent!==roots[key]&&!parent._rrKey){if(parent.classList?.contains('lp-nested-items')&&parent.previousElementSibling?.classList.contains('lp-sub-item'))path.unshift(parent.previousElementSibling);parent=parent.parentNode;}
    let target=existingTarget || (destination===mounted?roots[key]:store(destination)[key]);
    if(!existingTarget)for(const source of path){let header=matchHeader(target,source);if(!header){header=source.cloneNode(true);header.removeAttribute('id');header.dataset.regionId=destination;const nested=document.createElement('div');nested.className='lp-nested-items expanded';target.append(header,nested);}target=header.nextElementSibling;}
    const nested=node.nextElementSibling?.classList.contains('lp-nested-items')?node.nextElementSibling:null;
    target.append(node);if(nested)target.append(nested);
    rr.restoreFile(node,{regionId:destination});if(nested)nested.querySelectorAll(files).forEach(child=>rr.restoreFile(child,{regionId:destination}));
    if(destination===mounted)bind();
    if(typeof scheduleSessionSave==='function')scheduleSessionSave();
  }
  function fileScope(file) { return importOwners.get(file) || null; }
  async function moveWithViews(node,destination,target){if(window.researchRegionViews)await researchRegionViews.moveModels(node,destination);moveNode(node,destination,target);window.researchRegionViews?.onViewActivated(activeTabId);}
  document.addEventListener('click',event=>{
    const input=event.target;if(input.tagName!=='INPUT'||input.type!=='file')return;
    const targets={'file-input':typeof pendingCategoryItem!=='undefined'?pendingCategoryItem:null,'drawing-file-input':typeof pendingDrawingCategory!=='undefined'?pendingDrawingCategory:null,'table-file-input':typeof pendingTableCategory!=='undefined'?pendingTableCategory:null,'pdf-file-input':typeof pendingReportFolder!=='undefined'?pendingReportFolder:null,'word-file-input':typeof pendingReportFolder!=='undefined'?pendingReportFolder:null,'excel-file-input':typeof pendingTestDataFolder!=='undefined'?pendingTestDataFolder:null};
    input._rrImportScope=ownerOf(targets[input.id]||input);
  },true);
  document.addEventListener('change',event=>{
    const input=event.target;if(input.tagName!=='INPUT'||input.type!=='file')return;
    for(const file of input.files||[])importOwners.set(file,input._rrImportScope||mounted);
    delete input._rrImportScope;
  },true);
  for(const name of ['addPdfFileNode','addWordFileNode','addTestDataFileNode']){
    const original=window[name];if(typeof original!=='function')continue;
    window[name]=function(...args){const node=original.apply(this,args);if(node){const owner=fileScope(args[0])||ownerOf(node.parentNode);rr.restoreFile(node,{regionId:owner});if(owner!==ownerOf(node.parentNode))moveNode(node,owner);}return node;};
  }
  const importPoint = window.importPointLayer;
  if(typeof importPoint==='function')window.importPointLayer=function(file,...args){const before=new Set(allFiles());const result=importPoint.call(this,file,...args);const owner=fileScope(file)||mounted;allFiles().filter(node=>!before.has(node)&&node.dataset.pointId).forEach(node=>{rr.restoreFile(node,{regionId:owner});if(owner!==ownerOf(node.parentNode))moveNode(node,owner);});return result;};
  function finishRestore() {
    // Version-one region projects stored one combined tree. Partition each file
    // by its saved owner, retaining original leaf nodes and their registrations.
    stamp();const nodes=allFiles();nodes.forEach(node=>{const id=node.dataset.regionId;if(id&&rr.list().some(region=>region.id===id)&&id!==ownerOf(node.parentNode))moveNode(node,id);});
    for(const model of getProjectModels().filter(model=>model.isBlockModel)){
      if(allFiles().some(node=>node.dataset.modelId===model.id))continue;
      const id=rr.list().some(node=>node.id===model.regionId)?model.regionId:rr.currentId;
      activate(id);const name=model.fileName||'Restored block model';let category=Array.from(roots.block?.querySelectorAll('[data-role="block-model-node"]')||[]).find(node=>caption(node)===name);
      if(!category)category=addNewBlockModelNode(name);addBlockTreeNode(model,category);rr.restoreFile(model.treeFileNode,{regionId:id});
    }
    activate(rr.currentId);stamp();restoringTrees=false;
  }
  function rehomeDeleted(ids,destination) {allFiles().filter(node=>ids.has(node.dataset.regionId)).forEach(node=>moveNode(node,destination));ids.forEach(id=>stores.delete(id));if(ids.has(mounted)){mounted=destination;Object.values(roots).forEach(root=>root.replaceChildren());const saved=store(destination);Object.entries(roots).forEach(([key,root])=>{root.dataset.regionId=destination;root.append(saved[key]);});bind();}}
  function moveDialog(node) {
    const dialog=document.createElement('dialog');dialog.className='rr-dialog';const form=document.createElement('form');form.className='rr-editor';
    const title=document.createElement('strong');title.textContent='Move data to another region';const note=document.createElement('p');note.textContent='Only the project ownership changes, File, Model coordinates and registration results are retained. ';
    const select=document.createElement('select');select.style.cssText='width:100%;margin:12px 0;padding:6px';
    rr.list().forEach(region=>{const option=document.createElement('option');option.value=region.id;option.textContent=rr.pathName(region.id);select.append(option);});select.value=ownerOf(node);
    const category=document.createElement('select');category.style.cssText=select.style.cssText;category.setAttribute('aria-label','Destination');let targets=[],targetRegion=null;
    function updateTargets(){targetRegion=select.value;const root=select.value===mounted?roots[rootKey(node)]:store(select.value)[rootKey(node)];targets=Array.from(root.querySelectorAll('.lp-sub-item')).filter(header=>!header.matches(files)&&header.nextElementSibling?.classList.contains('lp-nested-items')&&(rootKey(node)!=='surface'||header.dataset.surfaceKind===node.parentNode?.previousElementSibling?.dataset.surfaceKind)).map(header=>({header,target:header.nextElementSibling}));category.replaceChildren();targets.forEach(({header},index)=>{const option=document.createElement('option');option.value=index;option.textContent=caption(header);category.append(option);});if(!targets.length){targets=[{target:root}];const option=document.createElement('option');option.value='0';option.textContent='Current category';category.append(option);}const source=node.parentNode?.previousElementSibling;const matched=targets.findIndex(({header})=>header&&source&&(caption(header)===caption(source)||(source.dataset.pageNodeId&&header.dataset.pageNodeId===source.dataset.pageNodeId)||(source.dataset.category&&header.dataset.category===source.dataset.category)));category.value=String(Math.max(0,matched));}
    select.onchange=updateTargets;updateTargets();
    const confirm=document.createElement('button');confirm.type='submit';confirm.textContent='Move';const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';cancel.onclick=()=>dialog.close();
    form.append(title,note,select,category,confirm,cancel);dialog.append(form);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());form.onsubmit=async event=>{event.preventDefault();if(targetRegion!==select.value)updateTargets();confirm.disabled=true;try{await moveWithViews(node,select.value,targets[Number(category.value)].target);dialog.close();}catch(error){alert(error.message);}finally{confirm.disabled=false;}};dialog.showModal();select.focus();
  }
  document.addEventListener('contextmenu',event=>{
    const node=event.target.closest?.(files);if(!node||!rootKey(node))return;
    setTimeout(()=>{const menu=Array.from(document.querySelectorAll('#ctx-menu.show,.surface-context-menu.show')).find(menu=>getComputedStyle(menu).display!=='none');if(!menu)return;menu.querySelector('[data-action="move-region"]')?.remove();const button=document.createElement('button');button.type='button';button.className='ctx-menu-item';button.style.cssText='border:0;width:100%;text-align:left';button.dataset.action='move-region';button.textContent='Move to region…';button.onclick=event=>{event.stopPropagation();if(typeof hideCtxMenu==='function')hideCtxMenu();if(menu.classList.contains('surface-context-menu')){menu.classList.remove('show');menu.style.display='none';}moveDialog(node);};menu.append(button);},0);
  },true);
  window.researchScopeTrees={activate,allFiles,ownerOf,stamp,reset,serializeTrees,combined,restoreTrees,finishRestore,rehomeDeleted,moveNode,moveWithViews,fileScope,hasCustomTree};
  stamp();bind();
})();
