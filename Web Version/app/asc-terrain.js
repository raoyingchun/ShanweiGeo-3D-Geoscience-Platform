'use strict';
function parseASCTerrain(text, fileName) {
  const tokens=text.replace(/^\uFEFF/,'').trim().split(/\s+/),header={};let offset=0;
  const keys=new Set(['ncols','nrows','xllcorner','yllcorner','xllcenter','yllcenter','cellsize','nodata_value']);
  while(offset<tokens.length&&keys.has(tokens[offset].toLowerCase())){
    const key=tokens[offset++].toLowerCase();if(key in header)throw new Error('ASC Duplicate headers:  '+key);
    const value=Number(tokens[offset++]);if(!Number.isFinite(value))throw new Error('ASC Invalid numeric header values:  '+key);header[key]=value;
  }
  const cols=header.ncols,rows=header.nrows,step=header.cellsize;
  if(!Number.isInteger(cols)||!Number.isInteger(rows)||cols<2||rows<2||!(step>0))throw new Error('ASC Requires valid ncols, nrows and cellsize, and at least 2 Rows 2 Columns. ');
  if(cols*rows>1000000)throw new Error('Maximum supported: 100 x 10,000 elevation cells, Reduce the resolution before importing. ');
  if(('xllcorner' in header)===('xllcenter' in header)||('yllcorner' in header)===('yllcenter' in header))throw new Error('ASC Specify exactly one lower-left corner or cell-center origin. ');
  if(tokens.length-offset!==cols*rows)throw new Error('ASC The elevation count does not match the grid dimensions. ');
  const x0=header.xllcenter??header.xllcorner+step/2,y0=header.yllcenter??header.yllcorner+step/2;
  const ids=new Int32Array(cols*rows).fill(-1),values=[],vertices=[];let low=Infinity,high=-Infinity;
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
    const z=Number(tokens[offset+r*cols+c]);if(!Number.isFinite(z))throw new Error('ASC Contains invalid elevation values. ');
    if(z===header.nodata_value)continue;
    ids[r*cols+c]=values.length;values.push(z);low=Math.min(low,z);high=Math.max(high,z);
    // Retain Float64 until the shared scene origin has been subtracted.
    vertices.push(x0+c*step,z,-(y0+(rows-1-r)*step));
  }
  const indices=[];
  for(let r=0;r<rows-1;r++)for(let c=0;c<cols-1;c++){
    const a=ids[r*cols+c],b=ids[r*cols+c+1],d=ids[(r+1)*cols+c],e=ids[(r+1)*cols+c+1];
    if(a>=0&&d>=0&&b>=0)indices.push(a,d,b);
    if(b>=0&&d>=0&&e>=0)indices.push(b,d,e);
  }
  if(!indices.length)throw new Error('ASC No valid elevation grid is available to build a terrain surface. ');
  // Flood-fill zero elevations connected to the outside boundary only.
  const visited=new Uint8Array(cols*rows),queue=[];
  function seed(r,c){const cell=r*cols+c,id=ids[cell];if(!visited[cell]&&id>=0&&values[id]===0){visited[cell]=1;queue.push(cell);}}
  for(let c=0;c<cols;c++){seed(0,c);seed(rows-1,c);}
  for(let r=0;r<rows;r++){seed(r,0);seed(r,cols-1);}
  for(let i=0;i<queue.length;i++){const r=Math.floor(queue[i]/cols),c=queue[i]%cols;if(r)seed(r-1,c);if(r<rows-1)seed(r+1,c);if(c)seed(r,c-1);if(c<cols-1)seed(r,c+1);}
  return {name:fileName,vertices:new Float64Array(vertices),indices:new Uint32Array(indices),
    boundingBox:[x0,y0,low,x0+(cols-1)*step,y0+(rows-1)*step,high],
    vertexCount:values.length,triangleCount:indices.length/3,
    fileOrigin:{x:x0+(cols-1)*step/2,y:y0+(rows-1)*step/2,z:(low+high)/2},
    boundaryZeroVertices:queue.map(cell=>ids[cell]),
    terrainInfo:{cols,rows,cellsize:step,validCells:values.length,minHeight:low,maxHeight:high,boundaryZeroCount:queue.length},source:{fileName}};
}
function ensureTerrainEdgeZeros(geo){
  if(Array.isArray(geo.boundaryZeroVertices))return;
  // Geometry cached before edge filtering was added has heights but no mask.
  // Rebuild grid adjacency from source coordinates; never infer from display Z.
  const info=geo.terrainInfo,vertices=geo.vertices;
  if(!info||!vertices)throw new Error('Original terrain information is missing, Remove this layer and import it again ASC. ');
  const {cols,rows,cellsize:step}=info;
  let minX=Infinity,maxY=-Infinity;
  for(let i=0;i<vertices.length;i+=3){minX=Math.min(minX,vertices[i]);maxY=Math.max(maxY,-vertices[i+2]);}
  const cells=new Int32Array(cols*rows).fill(-1);
  for(let id=0;id<vertices.length/3;id++){
    const c=Math.round((vertices[id*3]-minX)/step),r=Math.round((maxY+vertices[id*3+2])/step);
    if(r>=0&&r<rows&&c>=0&&c<cols)cells[r*cols+c]=id;
  }
  const visited=new Uint8Array(cols*rows),queue=[];
  function seed(r,c){const cell=r*cols+c,id=cells[cell];if(!visited[cell]&&id>=0&&vertices[id*3+1]===0){visited[cell]=1;queue.push(cell);}}
  for(let c=0;c<cols;c++){seed(0,c);seed(rows-1,c);}
  for(let r=0;r<rows;r++){seed(r,0);seed(r,cols-1);}
  for(let i=0;i<queue.length;i++){const r=Math.floor(queue[i]/cols),c=queue[i]%cols;if(r)seed(r-1,c);if(r<rows-1)seed(r+1,c);if(c)seed(r,c-1);if(c<cols-1)seed(r,c+1);}
  geo.boundaryZeroVertices=queue.map(cell=>cells[cell]);info.boundaryZeroCount=queue.length;
}
function terrainDisplayData(geo,settings){
  ensureTerrainEdgeZeros(geo);
  const factor=Number(settings.exaggeration??1);if(!Number.isFinite(factor)||factor<.25||factor>5)throw new Error('Vertical scale range: 0.25～5 x. ');
  const removed=new Set(settings.hideEdgeZeros?geo.boundaryZeroVertices||[]:[]),indices=[];
  for(let i=0;i<geo.indices.length;i+=3){const a=geo.indices[i],b=geo.indices[i+1],c=geo.indices[i+2];if(!removed.has(a)&&!removed.has(b)&&!removed.has(c))indices.push(a,b,c);}
  if(!indices.length)throw new Error('The current edge treatment would hide all terrain, Keep edge zero values. ');
  let low=Infinity,high=-Infinity;
  for(const id of new Set(indices)){const z=geo.vertices[id*3+1];low=Math.min(low,z);high=Math.max(high,z);}
  return {indices:new Uint32Array(indices),low,high,factor,removedCount:removed.size};
}
function applyTerrainDisplay(model,settings){
  if(!model.geoMesh?.terrainInfo)return;
  const next=Object.assign({hideEdgeZeros:false,colorMode:'elevation',exaggeration:1},settings||model.terrainSettings);
  const data=terrainDisplayData(model.geoMesh,next),geo=model.mesh.geometry,raw=model.geoMesh.vertices;
  const originZ=state.origin?.z||0,positions=geo.getAttribute('position'),colors=new Float32Array(positions.count*3);
  const stops=['#2e7568','#84a965','#d8c17c','#ad795b','#e2ddd3'].map(value=>new THREE.Color(value));
  const color=new THREE.Color();
  for(let id=0;id<positions.count;id++){
    const height=raw[id*3+1];positions.setY(id,(height-data.low)*data.factor+data.low-originZ);
    const value=Math.max(0,Math.min(1,(height-data.low)/(data.high-data.low||1)))*4,index=Math.min(3,Math.floor(value));
    color.copy(stops[index]).lerp(stops[index+1],value-index);color.toArray(colors,id*3);
  }
  positions.needsUpdate=true;geo.setIndex(new THREE.Uint32BufferAttribute(data.indices,1));
  geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geo.computeVertexNormals();
  // Unreferenced, hidden edge vertices must not enlarge camera fitting bounds.
  const bounds=new THREE.Box3(),point=new THREE.Vector3();
  for(const id of new Set(data.indices))bounds.expandByPoint(point.fromBufferAttribute(positions,id));
  geo.boundingBox=bounds;geo.boundingSphere=bounds.getBoundingSphere(new THREE.Sphere());
  const material=model.material;material.vertexColors=next.colorMode==='elevation';material.color.set(material.vertexColors?0xffffff:model.color);
  material.roughness=1;material.metalness=0;material.flatShading=false;material.needsUpdate=true;
  model.isTerrain=true;model.terrainSettings=next;model.terrainInfo=model.geoMesh.terrainInfo;
  model.terrainDisplayInfo={minHeight:data.low,maxHeight:data.high,hiddenCells:data.removedCount,triangles:data.indices.length/3};
  if(typeof configureTerrainImageMaterial==='function')configureTerrainImageMaterial(model);
}
function renderTerrainInfo(model,host){
  if(!model.geoMesh?.terrainInfo||!host)return;
  const info=model.terrainDisplayInfo||{},source=model.geoMesh.terrainInfo;
  const panel=document.createElement('div');panel.className='rp-section';panel.id='terrain-display-info';
  const low=info.minHeight??source.minHeight,high=info.maxHeight??source.maxHeight;
  panel.innerHTML='<div class="rp-section-title">Terrain information</div><div class="prop-row">Boundary-connected zeros: '+(model.geoMesh.boundaryZeroVertices||[]).length+' items</div><div class="prop-row">Currently hidden: '+(info.hiddenCells||0)+' grid cells</div><div class="prop-row">Displayed elevation range: '+low.toFixed(2)+' ～ '+high.toFixed(2)+' m</div><div class="prop-row">Cell size: '+source.cellsize+' m</div><div class="prop-row">Vertical display scale: '+(model.terrainSettings?.exaggeration||1)+' x</div><div class="prop-row">Show triangles: '+(info.triangles??model.geoMesh.triangleCount)+'</div>';
  if(model.terrainSettings?.colorMode!=='solid'){
    const scale=document.createElement('div');scale.style.cssText='height:12px;margin-top:8px;background:linear-gradient(to right,#2e7568,#84a965,#d8c17c,#ad795b,#e2ddd3)';panel.append(scale);
    const caption=document.createElement('div');caption.style.cssText='display:flex;justify-content:space-between;font-size:11px';
    const left=document.createElement('span'),right=document.createElement('span');left.textContent=low.toFixed(2)+' m';right.textContent=high.toFixed(2)+' m';caption.append(left,right);panel.append(caption);
  }
  const note=document.createElement('p');note.style.cssText='font-size:12px;color:var(--text-muted)';note.textContent='Original elevations are unchanged. Hide edge zeros only after confirming they are not valid elevations; Overlay geological models, Used for measurement and picking 1 vertical exaggeration. ';panel.append(note);host.append(panel);
  if(model.terrainImage){const imageInfo=document.createElement('p');imageInfo.style.fontSize='12px';imageInfo.textContent='Imagery texture:  '+model.terrainImage.fileName+'；'+model.terrainImage.width+'×'+model.terrainImage.height+' px; Overwrite '+model.terrainImage.insideVertices+'/'+model.terrainImage.totalVertices+' terrain vertices. ';panel.append(imageInfo);}
  if(typeof renderTerrainImageAppearance==='function')renderTerrainImageAppearance(model,host);
}
function mountTerrainLayerControls(model,item){
  if(!model.geoMesh?.terrainInfo||item.querySelector('.terrain-inline-controls'))return;
  const settings=model.terrainSettings||{hideEdgeZeros:false,colorMode:'elevation',exaggeration:1};
  const controls=document.createElement('div');controls.className='terrain-inline-controls';controls.style.cssText='display:flex;align-items:center;gap:10px;flex:none;white-space:nowrap;font-size:11px';
  controls.innerHTML='<label title="Hide only zero elevations connected to the outer boundary, Restoration can be canceled"><input id="terrain-hide-edge" type="checkbox"> Hide boundary zeros</label><label>Elevation colors <select id="terrain-color-mode" style="font-size:11px"><option value="elevation">Gradient</option><option value="solid">Single color</option></select></label><label>Vertical scale <input id="terrain-exaggeration" aria-label="Terrain vertical scale" type="number" min="0.25" max="5" step="0.25" style="width:48px;font-size:11px"> x</label>';
  item.insertBefore(controls,item.querySelector('.lm-color'));
  if(model.terrainImage){const option=document.createElement('option');option.value='image';option.textContent='Remote Sensing Imagery';controls.querySelector('#terrain-color-mode').append(option);}
  const find=id=>controls.querySelector('#'+id);
  function sync(){find('terrain-hide-edge').checked=model.terrainSettings?.hideEdgeZeros||false;find('terrain-color-mode').value=model.terrainSettings?.colorMode||'elevation';find('terrain-exaggeration').value=model.terrainSettings?.exaggeration||1;}
  sync();
  function apply(){try{applyTerrainDisplay(model,{hideEdgeZeros:find('terrain-hide-edge').checked,colorMode:find('terrain-color-mode').value,exaggeration:Number(find('terrain-exaggeration').value)});if(state.selectedModelId===model.id)showModelProperties(model);}catch(error){alert(error.message);sync();}}
  ['terrain-hide-edge','terrain-color-mode','terrain-exaggeration'].forEach(id=>find(id).onchange=apply);
  controls.addEventListener('click',event=>event.stopPropagation());controls.addEventListener('mousedown',event=>event.stopPropagation());
  item.addEventListener('dragstart',event=>{if(controls.contains(event.target))event.preventDefault();});
}
if(typeof module!=='undefined'&&module.exports)module.exports={parseASCTerrain,terrainDisplayData,ensureTerrainEdgeZeros};
if(typeof document!=='undefined'){
  (function(){
    const root=document.getElementById('subitems-surface');if(!root)return;
    function ensureTerrainCategory(){
      let category=root.querySelector('[data-role="terrain-category"]');if(category)return category;
      category=document.createElement('div');category.className='lp-sub-item has-children';category.dataset.role='terrain-category';category.dataset.category='Elevation';
      category.innerHTML='<svg class="sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg><span>Elevation</span>';
      category.setAttribute('onclick','toggleNode(this)');
      const nested=document.createElement('div');nested.className='lp-nested-items expanded';root.append(category,nested);return category;
    }
    window.ensureTerrainCategory=ensureTerrainCategory;ensureTerrainCategory();
    const input=document.createElement('input');input.type='file';input.accept='.asc';input.multiple=true;input.hidden=true;input.id='terrain-asc-input';document.body.append(input);
    const menu=document.createElement('div');menu.id='terrain-import-menu';menu.style.cssText='position:fixed;z-index:10000;background:var(--bg,#fff);color:var(--text,#222);padding:5px;border:1px solid #aaa;border-radius:5px;display:none;box-shadow:0 3px 12px #0003';
    const button=document.createElement('button');button.textContent='Import elevation data (.asc) …';menu.append(button);document.body.append(menu);
    let pending=null;
    root.addEventListener('contextmenu',event=>{
      const leaf=event.target.closest('[data-model-id]'),category=event.target.closest('[data-role="terrain-category"]');
      if(leaf&&leaf.parentElement?.previousElementSibling?.dataset.role==='terrain-category'){
        surfaceMenu(menu,event,[{key:'rename',label:'Rename',run:()=>renameFileNode(leaf)},{key:'export',label:'Export',run:()=>exportSurfaceTerrain(leaf)},{key:'delete',label:'Delete',danger:true,run:()=>deleteFileNode(leaf)}]);return;
      }
      if(!category)return;pending=category;
      surfaceMenu(menu,event,[{key:'import',label:'Import elevation data (.asc) …',run:()=>input.click()},{key:'rename',label:'Rename',run:()=>renameSurfaceCategory(category)},{key:'export',label:'Export',run:()=>exportSurfaceTerrain(category)},{key:'delete',label:'Delete',danger:true,run:()=>deleteSurfaceTerrainCategory(category)}]);
    },true);
    document.addEventListener('mousedown',event=>{if(!menu.contains(event.target))menu.style.display='none';});
    document.addEventListener('keydown',event=>{if(event.key==='Escape')menu.style.display='none';});
    button.onclick=()=>{menu.style.display='none';input.click();};
    input.onchange=async()=>{
      menu.style.display='none';
      const category=pending||ensureTerrainCategory();
      const importRegion=window.researchRegions?researchRegions.ownerOf(category):undefined;
      const files=Array.from(input.files);
      try{for(const file of files){
        try{
          if(file.size>100*1024*1024)throw new Error('ASC File exceeds 100MB. ');
          if(state.models.some(model=>model.fileName===file.name))throw new Error('A model with this name already exists in the current view. ');
          let sourceText;
          showImportProgress(5,'Reading elevations:  '+file.name);
          await yieldToUI();
          const geo=await parseLocalModel(file.path||null,null,async()=>{sourceText=await file.text();return parseASCTerrain(sourceText,file.name);});
          showImportProgress(85,'Building terrain:  '+file.name);
          await yieldToUI();
          pendingCategoryItem=category;
          if(window.researchRegionViews)await researchRegionViews.ensure(importRegion);
          const model=loadModelToScene(geo,'Elevation',file.name,{regionId:importRegion,filePath:file.path||null,color:0x9ab47c,opacity:1});
          if(model){if(!file.path)model.terrainSourceText=sourceText;model.isTerrain=true;model.terrainInfo=geo.terrainInfo;model.treeFileNode.title='Elevation '+geo.terrainInfo.minHeight+'～'+geo.terrainInfo.maxHeight+'；'+geo.terrainInfo.cols+' Columns×'+geo.terrainInfo.rows+' Rows';}
        }catch(error){hideImportLoading();alert(file.name+'：'+error.message);}
        finally{hideImportLoading();}
      }}finally{hideImportLoading();input.value='';}
    };
  })();
}
