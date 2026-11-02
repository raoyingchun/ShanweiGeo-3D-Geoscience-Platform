(function(){
  'use strict';
  const lastTabs=new Map();let transition=0;
  function fileFor(viewer){const files=researchScopeTrees.allFiles();if(viewer.type==='3d'){const model=viewer.state?.models.find(model=>model.id===viewer.state.selectedModelId)||viewer.state?.models[0];if(!model)return null;return files.find(node=>node.dataset.modelId===model.id||model.drawingKey&&node.dataset.drawingId===model.drawingKey||model.pointLayerId&&node.dataset.pointId===model.pointLayerId||model.lineLayerId&&node.dataset.lineId===model.lineLayerId)||null;}
    return files.find(node=>{if(viewer.type==='image'){const record=state.drawings[node.dataset.drawingId];return record&&(record.blobUrl===viewer.imageUrl||record.previewUrl===viewer.imageUrl);}if(viewer.type==='pdf')return state.pdfs[node.dataset.pdfId]?.url===viewer.pdfUrl&&!!viewer.pdfUrl;if(viewer.type==='word')return state.words[node.dataset.wordId]?.url===viewer.wordUrl&&!!viewer.wordUrl;if(viewer.type==='table')return viewer.sourceKey==='table:'+node.dataset.tableId||viewer.testDataId&&viewer.testDataId===node.dataset.testdataId;return false;})||null;
  }
  function locateFile(node){document.querySelectorAll('.rr-file-current').forEach(item=>item.classList.remove('rr-file-current'));if(!node)return;let parent=node.parentElement;while(parent){if(parent.classList.contains('lp-nested-items')||parent.classList.contains('lp-sub-items')){parent.classList.add('expanded');parent.classList.remove('collapsed');const header=parent.previousElementSibling;header?.classList.remove('collapsed');header?.classList.add('expanded');}parent=parent.parentElement;}node.classList.add('rr-file-current');requestAnimationFrame(()=>{if(node.isConnected)node.scrollIntoView({block:'nearest'});});}
  function onViewActivated(id){transition++;if(researchRegions.isRestoring)return;const viewer=tabViewers.get(id);if(!viewer)return;const node=fileFor(viewer),owner=node?researchScopeTrees.ownerOf(node):viewer.regionId;if(owner&&researchRegions.list().some(item=>item.id===owner)){if(viewer.type==='3d')lastTabs.set(owner,id);if(researchRegions.currentId!==owner)researchRegions.select(owner,{fromView:true});}locateFile(node);}
  async function onRegionSelected(regionId,previous){const request=++transition;const current=tabViewers.get(activeTabId);if(current?.type==='3d'&&current.regionId===regionId)return;const last=lastTabs.get(regionId);const entry=tabViewers.get(last)?.regionId===regionId?[last,tabViewers.get(last)]:Array.from(tabViewers.entries()).reverse().find(([,viewer])=>viewer.type==='3d'&&!viewer.isVector2D&&viewer.regionId===regionId);if(!entry)return;await window.switchTab(entry[0]);if(request===transition&&activeTabId!==entry[0]&&researchRegions.currentId===regionId)researchRegions.select(previous,{fromView:true});}
  function describe(id){
    const viewer=tabViewers.get(id),tab=document.querySelector('.center-tab[data-tab-id="'+id+'"]');
    if(!viewer||viewer.type!=='3d'||viewer.isVector2D)return null;
    const views=Array.from(tabViewers.entries()).filter(([,v])=>v.type==='3d'&&!v.isVector2D),number=views.findIndex(([key])=>key===id)+1;
    const region=researchRegions.list().find(node=>node.id===viewer.regionId);
    const models=(viewer.state?.models||[]).filter(m=>m.inScene!==false);
    const categories=[];
    for(const m of models){
      const kind=m.isBlockModel?'Block':m.isTerrain||m.geoMesh?.terrainInfo?'Elevation':m.isRegisterPlane||m.isGeoImagePlane?'Imagery':m.isDrillhole?'Drillholes':m.isPointLayer?'Point':m.isLineLayer?'Line':m.category==='Geochemistry'?'Geochemistry':m.category==='3D Tunnel Models'?'Tunnel':'Geology';
      if(!categories.includes(kind))categories.push(kind);
    }
    const content=categories.length?categories.join('＋'):'Empty view';
    const manual=tab?.dataset.userNamed==='true'?tab.querySelector('.center-tab-label')?.textContent:null;
    const short=manual||'['+number+'] '+(region?.name||'No region assigned')+' · '+content;
    const full='View '+number+' | '+(region?researchRegions.pathName(region.id):'No region assigned')+' | '+content+(manual?' | '+manual:'');
    const files=models.map(m=>m.displayName||m.fileName||m.name).filter(Boolean);
    return {short,full,title:full+(files.length?'\n'+files.join('、'):''),region};
  }
  let lastNameRefresh=0;
  function refreshNames(){
    lastNameRefresh=performance.now();
    tabViewers.forEach((viewer,id)=>{
      const info=describe(id);if(!info)return;
      const tab=document.querySelector('.center-tab[data-tab-id="'+id+'"]'),text=tab.querySelector('.center-tab-label');
      if(text&&!text.isContentEditable&&text.textContent!==info.short)text.textContent=info.short;
      tab.title=info.title;tab.dataset.autoName='false';
      if(info.region)tab.dataset.regionId=info.region.id;else delete tab.dataset.regionId;
    });
  }
  function refreshNamesIfNeeded(){if(performance.now()-lastNameRefresh>300)refreshNames();}

  function bind(id,regionId){tabViewers.get(id).regionId=regionId;refreshNames();if(id===activeTabId)onViewActivated(id);return id;}
  async function moveModels(node,destination){
    const vector=window.vectorStore?.[node.dataset.vectorId];
    const matches=model=>model.id===node.dataset.modelId||vector?.modelId===model.id||node.dataset.drawingId&&model.drawingKey===node.dataset.drawingId||node.dataset.pointId&&model.pointLayerId===node.dataset.pointId||node.dataset.lineId&&model.lineLayerId===node.dataset.lineId;
    const entries=[];tabViewers.forEach(viewer=>{if(viewer.type==='3d')viewer.state.models.filter(matches).forEach(model=>entries.push({viewer,model,origin:viewer.state.origin||{x:0,y:0,z:0}}));});
    const unloaded=entries.find(entry=>entry.model._deferredEntry);if(unloaded){const source=Array.from(tabViewers.entries()).find(([,viewer])=>viewer===unloaded.viewer);if(source){await loadDeferredViewer(source[0]);if(unloaded.model._deferredEntry)throw new Error('The original model could not be loaded, Check the source file and try again');return moveModels(node,destination);}}
    if(!entries.length||entries.every(entry=>entry.viewer.regionId===destination))return;
    const ids=new Set(entries.map(entry=>entry.model.id));
    const conflict=Array.from(tabViewers.values()).some(viewer=>viewer.regionId===destination&&viewer.state?.models.some(model=>!ids.has(model.id)&&entries.some(entry=>entry.model.fileName===model.fileName)));
    if(conflict)throw new Error('The target region already contains a model with this name, Rename the model or select another region first. ');
    const id=await ensure(destination),target=tabViewers.get(id),wasEmpty=!target.state.models.length;
    const unique=new Map();entries.forEach(entry=>{if(!unique.has(entry.model.id))unique.set(entry.model.id,entry);});
    if(!target.state.origin){const first=entries[0];target.state.origin={...(first.model.geoMesh?.fileOrigin||first.origin)};}
    const origin=target.state.origin;
    for(const {viewer,model} of entries){viewer.state.models=viewer.state.models.filter(item=>item!==model);if(viewer.state.selectedModelId===model.id){viewer.state.selectedModelId=null;const outline=viewer.state.selectionOutline;outline?.parent?.remove(outline);viewer.state.selectionOutline=null;}model.mesh?.parent?.remove(model.mesh);}
    for(const {model,origin:old} of unique.values()){
      const delta=new THREE.Vector3(old.x-origin.x,old.z-origin.z,origin.y-old.y);
      // Mesh translation preserves block instances, line groups and display transforms.
      // Plain geological meshes can instead rebuild positions from original doubles.
      if(model.geoMesh?.vertices&&model.mesh?.isMesh&&model.mesh.geometry?.getAttribute('position')?.count===model.geoMesh.vertices.length/3&&!model.isTerrain&&!model.mesh.rotation.x&&!model.mesh.rotation.y&&!model.mesh.rotation.z&&model.mesh.scale.equals(new THREE.Vector3(1,1,1))){
        const raw=model.geoMesh.vertices,geometry=model.mesh.geometry.clone(),positions=geometry.getAttribute('position');for(let i=0;i<positions.count;i++)positions.setXYZ(i,raw[i*3]-origin.x,raw[i*3+1]-origin.z,raw[i*3+2]+origin.y);positions.needsUpdate=true;geometry.computeBoundingBox();geometry.computeBoundingSphere();model.mesh.geometry=geometry;
      }else if(model.mesh)model.mesh.position.add(delta);
      model.regionId=destination;target.state.models.push(model);if(model.inScene!==false)target.scene.add(model.mesh);const cached=geoMeshCache.get(model.id);if(cached?.options)cached.options.regionId=destination;
      if(model.pointLayerId&&state.pointLayers[model.pointLayerId])state.pointLayers[model.pointLayerId].origin={...origin};
      const reg=model.drawingKey&&drawingRegisters[model.drawingKey];if(reg)reg.planeTabId=id;
    }
    rebuildLayerManagement();updateLegend();buildAxisLabels();if(wasEmpty)fitViewToAll();refreshNames();
  }
  async function ensure(regionId){
    if(!regionId)return activeTabId;
    const current=tabViewers.get(activeTabId);
    if(current?.type==='3d'&&!current.isVector2D&&current.regionId===regionId)return activeTabId;
    let entry=Array.from(tabViewers.entries()).reverse().find(([,viewer])=>viewer.type==='3d'&&!viewer.isVector2D&&viewer.regionId===regionId);
    if(!entry&&current?.type==='3d'&&!current.isVector2D&&!current.regionId&&current.state.models.every(model=>model.regionId===regionId)){bind(activeTabId,regionId);return activeTabId;}
    const id=entry?entry[0]:await window.createNewTab('3d',{regionId,label:researchRegions.pathName(regionId)+' · 3D View'});
    if(!id)throw new Error('Switching the 3D view was canceled');
    await window.switchTab(id);if(activeTabId!==id)throw new Error('Switching the 3D view was canceled');return bind(id,regionId);
  }
  window.researchRegionViews={ensure,bind,refreshNames,refreshNamesIfNeeded,describe,onViewActivated,onRegionSelected,moveModels};refreshNames();
})();
