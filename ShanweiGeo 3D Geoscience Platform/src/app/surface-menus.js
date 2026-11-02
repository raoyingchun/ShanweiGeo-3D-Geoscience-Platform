'use strict';
function isSurfaceImageryCategory(node){return !!node&&node.dataset.role==='drawing-category'&&(node.dataset.surfaceKind==='imagery'||node.querySelector('span')?.textContent.trim()==='Remote Sensing Imagery');}
function surfaceMenu(menu,event,actions){
  event.preventDefault();event.stopPropagation();hideCtxMenu();
  document.querySelectorAll('.surface-context-menu').forEach(el=>{el.style.display='none';el.classList.remove('show');});
  menu.className='ctx-menu surface-context-menu';menu.removeAttribute('style');menu.replaceChildren();menu.setAttribute('role','menu');
  for(const action of actions){
    if(action.danger){const divider=document.createElement('div');divider.className='ctx-menu-divider';menu.append(divider);}
    const item=document.createElement('button');item.className='ctx-menu-item'+(action.danger?' danger':'');item.type='button';item.style.cssText='border:0;width:100%;text-align:left';item.dataset.action=action.key;item.setAttribute('role','menuitem');
    const icon=document.querySelector('#'+({import:'ctx-import-table',rename:'ctx-rename',export:'ctx-export',delete:'ctx-delete',fit:'ctx-register-drawing'})[action.key]+' svg');if(icon)item.append(icon.cloneNode(true));
    const label=document.createElement('span');label.textContent=action.label;item.append(label);
    item.onclick=async click=>{click.stopPropagation();menu.style.display='none';menu.classList.remove('show');try{await action.run();}catch(error){alert(error.message);}};menu.append(item);
  }
  menu.classList.add('show');menu.style.display='block';menu.style.left=Math.min(event.clientX,window.innerWidth-menu.offsetWidth-8)+'px';menu.style.top=Math.min(event.clientY,window.innerHeight-menu.offsetHeight-8)+'px';
}
function renameSurfaceCategory(node){
  const dialog=document.createElement('dialog');dialog.style.cssText='padding:20px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text)';
  dialog.innerHTML='<form method="dialog"><h3>Rename category</h3><input required maxlength="100" style="padding:6px;width:240px"><div style="margin-top:12px"><button value="cancel">Cancel</button> <button value="ok">OK</button></div></form>';
  const input=dialog.querySelector('input');input.value=node.querySelector('span').textContent;document.body.append(dialog);
  dialog.querySelector('form').addEventListener('submit',event=>{if(event.submitter?.value==='ok'&&input.value.trim())node.querySelector('span').textContent=input.value.trim();});
  dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();input.focus();input.select();
}
function surfaceDownload(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function exportSurfaceTerrain(node){
  const models=getProjectModels(),ids=node.dataset.modelId?[node.dataset.modelId]:Array.from(node.nextElementSibling?.querySelectorAll('[data-model-id]')||[]).map(el=>el.dataset.modelId);
  if(!ids.length)throw new Error('This category has no elevation data to export. ');
  for(const id of ids){const model=models.find(m=>m.id===id);if(!model)continue;let bytes;
    if(model.filePath){const result=await electronAPI.readProjectFile(model.filePath);if(!result?.ok)throw new Error(result?.error||'Original ASC Cannot be read');bytes=base64ToBytes(result.data);}
    else if(model.terrainSourceText)bytes=model.terrainSourceText;else throw new Error('Missing original ASC, Import again before exporting. ');
    const name=(model.displayName||model.fileName).replace(/\.asc$/i,'')+'.asc';surfaceDownload(new Blob([bytes],{type:'text/plain'}),name);
  }
}
async function exportSurfaceImagery(node){
  const nodes=node.dataset.drawingId?[node]:Array.from(node.nextElementSibling?.querySelectorAll('[data-drawing-id]')||[]);if(!nodes.length)throw new Error('This category has no imagery to export. ');
  for(const leaf of nodes){const drawing=state.drawings[leaf.dataset.drawingId];if(!drawing)continue;let blob=drawing.blob;
    if(!blob){const result=await electronAPI.readProjectFile(drawing.filePath);if(!result?.ok)throw new Error(result?.error||'The original image cannot be read');blob=new Blob([base64ToBytes(result.data)]);}
    const ext=drawing.ext||drawing.fileName.split('.').pop(),base=(drawing.displayName||drawing.fileName).replace(/\.[^.]+$/,'');surfaceDownload(blob,base+'.'+ext);
    let world=drawing.terrainImageSource?.world;
    if(!world&&drawing.filePath){for(const ext of ['tfw','pgw','jgw','wld']){const result=await electronAPI.readProjectFile(drawing.filePath.replace(/\.[^.]+$/,'.'+ext));if(result?.ok){world=parseWorldFile(new TextDecoder().decode(base64ToBytes(result.data)));break;}}}
    if(world)surfaceDownload(new Blob([world.join('\n')+'\n'],{type:'text/plain'}),base+'.wld');
  }
}
function deleteSurfaceTerrainCategory(node){
  if(!confirm('Confirm deletion“ '+node.querySelector('span').textContent+' ”and its elevation layer?The original file will not be deleted. '))return;
  const nested=node.nextElementSibling,ids=new Set(Array.from(nested?.querySelectorAll('[data-model-id]')||[]).map(el=>el.dataset.modelId));
  const models=getProjectModels().filter(model=>ids.has(model.id)||Array.from(ids).some(id=>getProjectModels().find(m=>m.id===id)?.fileName===model.fileName));
  const removed=new Set(models);
  for(const model of models){if(model.mesh?.parent)model.mesh.parent.remove(model.mesh);model.mesh?.geometry.dispose();model.material?.dispose();model.terrainTexture?.dispose();geoMeshCache.delete(model.fileName);}
  tabViewers.forEach(viewer=>{if(viewer.state)viewer.state.models=viewer.state.models.filter(model=>!removed.has(model));});state.models=state.models.filter(model=>!removed.has(model));
  if(ids.has(state.selectedModelId)){clearSelectionOutline();state.selectedModelId=null;showEmptyProperties();}
  nested?.remove();node.remove();rebuildLayerManagement();updateLegend();buildAxisLabels();
}
function deleteSurfaceImagery(node){
  const leaves=node.dataset.drawingId?[node]:Array.from(node.nextElementSibling?.querySelectorAll('[data-drawing-id]')||[]),records=leaves.map(leaf=>state.drawings[leaf.dataset.drawingId]).filter(Boolean);
  if(node.dataset.drawingId)deleteDrawingFileNode(node);else deleteDrawingCategory(node);
  if(node.isConnected)return; // The existing delete confirmation was cancelled.
  const planes=getProjectModels().filter(model=>model.isGeoImagePlane&&records.some(record=>record.filePath?record.filePath===model.geoImagePlaneSource?.filePath:record.fileName===model.geoImagePlaneSource?.fileName));
  for(const model of planes){if(model.mesh.parent)model.mesh.parent.remove(model.mesh);model.mesh.geometry.dispose();model.material.dispose();model.geoImageTexture?.dispose();geoMeshCache.delete(model.fileName);}
  const removedPlanes=new Set(planes);tabViewers.forEach(viewer=>{if(viewer.state)viewer.state.models=viewer.state.models.filter(model=>!removedPlanes.has(model));});state.models=state.models.filter(model=>!removedPlanes.has(model));
  for(const model of getProjectModels()){
    if(!model.terrainImage||!records.some(record=>record.filePath?record.filePath===model.terrainImage.filePath:record.fileName===model.terrainImage.fileName))continue;
    model.terrainTexture?.dispose();delete model.terrainTexture;delete model.terrainImage;
    model.terrainSettings=Object.assign({},model.terrainSettings,{colorMode:'elevation'});model.material.vertexColors=true;model.material.color.set(0xffffff);configureTerrainImageMaterial(model);
  }
  rebuildLayerManagement();if(state.selectedModelId){const model=state.models.find(m=>m.id===state.selectedModelId);if(model)showModelProperties(model);}
}
if(typeof document!=='undefined'){
  const style=document.createElement('style');style.textContent='.surface-context-menu button.ctx-menu-item{background:transparent}.surface-context-menu button.ctx-menu-item:hover{background:var(--brand-dim);color:var(--brand)}.surface-context-menu button.ctx-menu-item.danger:hover{background:#fde5e5;color:#cf222e}';document.head.append(style);
  for(const node of document.querySelectorAll('#subitems-surface [data-role="drawing-category"]'))if(isSurfaceImageryCategory(node))node.dataset.surfaceKind='imagery';
  document.addEventListener('mousedown',event=>{for(const menu of document.querySelectorAll('.surface-context-menu'))if(!menu.contains(event.target)){menu.style.display='none';menu.classList.remove('show');}});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')document.querySelectorAll('.surface-context-menu').forEach(menu=>{menu.style.display='none';menu.classList.remove('show');});});
}
