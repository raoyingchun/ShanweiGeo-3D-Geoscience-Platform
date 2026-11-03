(function(){
  'use strict';
  const button=document.getElementById('btn-region-compare');button.disabled=false;button.title='Compare open 3D views side by side';
  const host=document.createElement('section');host.className='region-compare';host.id='region-compare';host.hidden=true;
  host.innerHTML='<div class="rc-toolbar"><strong>Region Comparison</strong><span class="rc-mode-label">Independent controls</span><button data-action="sync" aria-pressed="false" title="Synchronize rotation, Zoom and pan">Synchronize</button><button data-action="clip" aria-pressed="false">Sync clipping</button><button data-action="swap">Swap panes</button><button data-action="fit">Fit both</button><button data-action="exit">Exit comparison</button></div><div class="rc-panes"></div>';
  document.getElementById('canvas-wrap').append(host);
  const toolbar=host.querySelector('.rc-toolbar');toolbar.hidden=true;document.querySelector('#center-area .center-toolbar').before(toolbar);
  const clipControls=document.createElement('div');clipControls.className='rc-clip-controls';clipControls.hidden=true;
  clipControls.innerHTML='<strong>Clip at matching coordinates</strong><label>Direction <select class="rc-clip-axis"><option value="z">Elevation Z</option><option value="x">X Coordinates</option><option value="y">Y Coordinates</option></select></label><input class="rc-clip-range" type="range" aria-label="Synchronize clipping position"><label>Coordinates <input class="rc-clip-value" type="number" step="any" aria-label="Synchronize clipping in world coordinates"></label><select class="rc-clip-direction" aria-label="Clipping side to keep"><option value="1">Keep higher-coordinate side</option><option value="-1">Keep lower-coordinate side</option></select><span>Both sides must use the same coordinate system</span>';
  toolbar.after(clipControls);
  let syncClipEnabled=false,clipAxis='z',clipValue=0,clipDirection=1;
  const materialCache=new WeakMap(),localClips=new WeakMap();
  let synchronized=false;
  let active=false,side=0,frame=0,previousEnabled=true,signature='';
  const panes=[];
  const normalBottom=document.getElementById('bottom-split');
  const comparisonBottom=document.createElement('section');comparisonBottom.className='rc-bottom-layers';comparisonBottom.hidden=true;normalBottom.before(comparisonBottom);
  const bottomDivider=document.createElement('div');bottomDivider.className='rc-bottom-divider';
  function layerTarget(id){const p=panes.find(p=>p.id===id);return p?.list?{list:p.list,empty:p.layerEmpty,ready:p.list.dataset.viewerId===id}:null;}
  function syncBottomLayout(){comparisonBottom.style.height=normalBottom.style.height||'180px';panes.forEach(p=>{if(p.layers)p.layers.style.flex='0 0 '+p.element.getBoundingClientRect().width+'px';});}
  function available(){return Array.from(tabViewers.entries()).filter(([,v])=>v.type==='3d'&&!v.isVector2D&&v.state?.models.length);}
  function name(id){const info=window.researchRegionViews?.describe(id);if(info)return info.full;return document.querySelector('.center-tab[data-tab-id="'+id+'"] .center-tab-label')?.textContent||'3D View';}
  function commit(p){const viewer=tabViewers.get(p.id);if(!viewer||!p.camera)return;viewer.camera.copy(p.camera);viewer.target.copy(p.target);if(activeTabId===p.id){controls.target.copy(p.target);}}
  function choose(p,id){if(p.id&&p.id!==id)commit(p);p.id=id;const viewer=tabViewers.get(id);p.camera=viewer?viewer.camera.clone():null;p.target=viewer?(activeTabId===id?controls.target:viewer.target).clone():new THREE.Vector3();const region=researchRegions.list().find(node=>node.id===viewer?.regionId);p.stage.querySelector(".rc-scope").textContent=region?"Current display "+({deposit:"Deposit",area:"Area",section:"Section"}[region.type])+" Data: "+researchRegions.pathName(region.id):"";p.select.value=id||'';p.empty.hidden=!!viewer;p.drag=null;cancelPaneMeasure(p);if(p.localToolbar)refreshPaneTools(p);}
  function choices(){const list=available(),next=list.map(([id])=>id+':'+name(id)).join('|');if(next===signature)return;signature=next;panes.forEach(p=>{p.select.replaceChildren();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Select 3D view';p.select.append(placeholder);list.forEach(([id])=>{const option=document.createElement('option');option.value=id;option.textContent=name(id);option.disabled=panes.some(other=>other!==p&&other.id===id);p.select.append(option);});if(!list.some(([id])=>id===p.id))choose(p,'');p.select.value=p.id||'';});}
  async function activate(index){if(!active)return;panes.forEach(commit);const p=panes[index];if(!p.id)return;await window.switchTab(p.id);if(activeTabId!==p.id)return;side=index;panes.forEach((pane,i)=>{pane.element.classList.toggle('rc-current',i===side);pane.badge.hidden=i!==side;});}
  function alignSync(source){
    if(!synchronized||!source?.camera)return;
    const direction=source.camera.position.clone().sub(source.target).normalize();
    for(const p of panes){if(p===source||!p.camera)continue;
      const distance=p.camera.position.distanceTo(p.target);
      p.camera.up.copy(source.camera.up);p.camera.position.copy(p.target).addScaledVector(direction,Math.max(.01,distance));p.camera.lookAt(p.target);commit(p);
    }
  }
  function setSynchronized(value){
    synchronized=!!value;
    const toggle=toolbar.querySelector('[data-action="sync"]');toggle.setAttribute('aria-pressed',String(synchronized));toggle.classList.toggle('active',synchronized);
    toolbar.querySelector('.rc-mode-label').textContent=synchronized?'Synchronized controls':'Independent controls';
    if(active)alignSync(panes[side]);
  }
  function applyGesture(p,action){
    if(!p.camera)return;
    const offset=p.camera.position.clone().sub(p.target);
    if(action.type==='rotate'){
      const spherical=new THREE.Spherical().setFromVector3(offset);spherical.theta+=action.theta;spherical.phi=Math.max(.01,Math.min(Math.PI-.01,spherical.phi+action.phi));
      p.camera.position.copy(p.target).add(new THREE.Vector3().setFromSpherical(spherical));
    }else if(action.type==='pan'){
      const shift=new THREE.Vector3().fromArray(action.shift).multiplyScalar(offset.length());p.camera.position.add(shift);p.target.add(shift);
    }else if(p.camera.isOrthographicCamera){p.camera.zoom=Math.max(.001,p.camera.zoom/action.factor);p.camera.updateProjectionMatrix();}
    else if(offset.length()*action.factor>.01)p.camera.position.copy(p.target).add(offset.multiplyScalar(action.factor));
    p.camera.lookAt(p.target);commit(p);
  }
  function operate(source,action){applyGesture(source,action);if(synchronized)panes.filter(p=>p!==source).forEach(p=>applyGesture(p,action));}
  function gesture(p,canvas){
    canvas.addEventListener('contextmenu',event=>event.preventDefault());
    canvas.addEventListener('pointerdown',event=>{if(!p.camera)return;activate(p.index);if(activeTabId!==p.id)return;if(tabViewers.get(p.id)?.state.measureMode&&event.button===0){startPaneMeasure(p,event);canvas.setPointerCapture(event.pointerId);return;}p.drag={x:event.clientX,y:event.clientY,button:event.button};canvas.setPointerCapture(event.pointerId);});
    canvas.addEventListener('pointerup',event=>{if(p.measureStart)finishPaneMeasure(p,event);p.drag=null;});canvas.addEventListener('pointercancel',()=>{cancelPaneMeasure(p);p.drag=null;});
    canvas.addEventListener('pointermove',event=>{
      if(p.measureStart){movePaneMeasure(p,event);return;}
      if(!p.drag||!p.camera)return;const dx=event.clientX-p.drag.x,dy=event.clientY-p.drag.y;p.drag.x=event.clientX;p.drag.y=event.clientY;
      if(p.drag.button===0)operate(p,{type:'rotate',theta:-dx*.008,phi:dy*.008});
      else{
        const scale=1/Math.max(1,canvas.clientHeight),right=new THREE.Vector3(1,0,0).applyQuaternion(p.camera.quaternion),up=new THREE.Vector3(0,1,0).applyQuaternion(p.camera.quaternion);
        operate(p,{type:'pan',shift:right.multiplyScalar(-dx*scale).add(up.multiplyScalar(dy*scale)).toArray()});
      }
    });
    canvas.addEventListener('wheel',event=>{event.preventDefault();if(!p.camera)return;activate(p.index);operate(p,{type:'zoom',factor:Math.exp(Math.max(-100,Math.min(100,event.deltaY))*.002)});},{passive:false});
  }
  for(let index=0;index<2;index++){const element=document.createElement('div');element.className='rc-pane';element.innerHTML='<div class="rc-pane-header"><span>'+['Left','Right'][index]+'</span><select aria-label="'+['Left','Right'][index]+'3D View"></select><span class="rc-current-badge" hidden>Active pane</span></div><div class="rc-stage"><div class="rc-scope"></div><div class="rc-empty">Select an open 3D view</div></div>';const p={index,element,select:element.querySelector('select'),badge:element.querySelector('.rc-current-badge'),stage:element.querySelector('.rc-stage'),empty:element.querySelector('.rc-empty'),id:'',renderer:null,camera:null,target:new THREE.Vector3()};panes.push(p);host.querySelector('.rc-panes').append(element);if(index===0){const divider=document.createElement('div');divider.className='rc-divider';divider.setAttribute('aria-label','Adjust pane widths');let dragging=false;divider.onpointerdown=e=>{dragging=true;divider.setPointerCapture(e.pointerId);};divider.onpointerup=()=>dragging=false;divider.onpointercancel=()=>dragging=false;divider.onpointermove=e=>{if(!dragging)return;const rect=host.querySelector('.rc-panes').getBoundingClientRect(),ratio=Math.max(.2,Math.min(.8,(e.clientX-rect.left)/rect.width));panes[0].element.style.flex=ratio;panes[1].element.style.flex=1-ratio;};host.querySelector('.rc-panes').append(divider);}p.select.onchange=async()=>{const id=p.select.value;if(panes.some(other=>other!==p&&other.id===id)){p.select.value=p.id;return;}if(tabViewers.get(id)?._deferredModels)await loadDeferredViewer(id);choose(p,id);signature='';choices();await activate(index);alignSync(p);};}
  function refreshLayerPanel(p){
    if(!p.layers){
      p.layers=document.createElement('section');p.layers.className='layer-manager rc-full-layer-panel';p.layers.setAttribute('aria-label',['Left','Right'][p.index]+' Layers');
      const header=document.createElement('div');header.className='lm-header';
      const title=document.createElement('div');title.className='lm-title';title.textContent=['Left','Right'][p.index]+' Layers';
      const hint=document.createElement('div');hint.className='lm-subtitle';hint.textContent='Independent controls · Drag to reorder';header.append(title,hint);
      p.list=document.createElement('div');p.list.className='lm-list';p.layerEmpty=document.createElement('div');p.layerEmpty.className='lm-empty';p.layerEmpty.textContent='No layers, Select a 3D view';p.list.append(p.layerEmpty);
      p.layers.append(header,p.list);comparisonBottom.append(p.layers);if(p.index===0)comparisonBottom.append(bottomDivider);
      for(const type of ['pointerdown','mousedown','click','dblclick','dragstart','drop','input','change'])p.layers.addEventListener(type,event=>{
        if(activeTabId===p.id)return;
        activate(p.index);
        // switchTab switches synchronously in the ordinary case, but when it is waiting for the point drawing save confirmation it blocks the operation first.
        if(activeTabId!==p.id){event.preventDefault();event.stopImmediatePropagation();}
      },true);
      p.layers.addEventListener('dblclick',()=>{
        if(activeTabId===p.id&&p.camera){p.camera.copy(camera);p.target.copy(controls.target);commit(p);}
      });
    }
    const viewer=tabViewers.get(p.id);
    p.layers.classList.toggle('rc-current',p.index===side);
    const signature=JSON.stringify([p.id,(viewer?.state.models||[]).filter(m=>m.inScene!==false).map(m=>[m.id,m.displayName||m.fileName||m.name]),(viewer?.state.rulerItems||[]).map(r=>r.id)]);
    if(signature===p.layerSignature)return;
    if(dragDelegate.active)return;
    p.layerSignature=signature;
    if(viewer){renderLayerManagementFor(viewer,p.list,p.layerEmpty);p.list.dataset.viewerId=p.id;}
    else{p.list.replaceChildren(p.layerEmpty);p.layerEmpty.style.display='';delete p.list.dataset.viewerId;}
    if(activeTabId===p.id){lmList=p.list;lmEmpty=p.layerEmpty;}
  }
  function localClipFor(viewer){
    if(!localClips.has(viewer))localClips.set(viewer,{enabled:false,axis:'z',value:0,direction:1});return localClips.get(viewer);
  }
  function planeFromConfig(viewer,cfg){
    const origin=viewer.state.origin||{x:0,y:0,z:0};
    const n=cfg.axis==='z'?new THREE.Vector3(0,1,0):cfg.axis==='x'?new THREE.Vector3(1,0,0):new THREE.Vector3(0,0,-1);
    return new THREE.Plane(n.multiplyScalar(cfg.direction),(origin[cfg.axis]-cfg.value)*cfg.direction);
  }
  function refreshLocalClip(p,reset=false){
    const viewer=tabViewers.get(p.id);if(!viewer)return;const cfg=localClipFor(viewer),box=new THREE.Box3();viewer.state.models.filter(m=>m.inScene!==false).forEach(m=>expandModelBox3(box,m));
    const o=viewer.state.origin||{x:0,y:0,z:0};let low=0,high=1;
    if(!box.isEmpty()){low=cfg.axis==='x'?box.min.x+o.x:cfg.axis==='z'?box.min.y+o.z:o.y-box.max.z;high=cfg.axis==='x'?box.max.x+o.x:cfg.axis==='z'?box.max.y+o.z:o.y-box.min.z;}
    if(reset)cfg.value=(low+high)/2;
    const panel=p.localClip,slider=panel.querySelector('.rc-clip-range');panel.hidden=!cfg.enabled;
    panel.querySelector('.rc-clip-axis').value=cfg.axis;panel.querySelector('.rc-clip-direction').value=String(cfg.direction);
    slider.min=String(Math.min(low,cfg.value));slider.max=String(Math.max(high,low+.01,cfg.value));slider.step=String(Math.max(.001,(high-low)/1000));slider.value=String(cfg.value);
    panel.querySelector('.rc-clip-value').value=String(Number(cfg.value.toFixed(6)));
    panel.querySelectorAll('input,select').forEach(el=>el.disabled=syncClipEnabled);
    panel.classList.toggle('rc-clip-locked',syncClipEnabled);
  }
  function refreshPaneTools(p){
    const viewer=tabViewers.get(p.id);if(!viewer)return;
    const flags={measure:viewer.state.measureMode,clip:localClipFor(viewer).enabled,compass:viewer.state.compassVisible,axes:viewer.state.axisLabelsVisible,legend:viewer.state.legendVisible};
    for(const button of p.localToolbar.querySelectorAll('button')){const key=button.dataset.tool;button.disabled=key==='clip'&&syncClipEnabled;button.classList.toggle('active',!!flags[key]);if(key in flags)button.setAttribute('aria-pressed',String(!!flags[key]));}
    if(p.renderer)p.renderer.domElement.style.cursor=viewer.state.measureMode?'crosshair':'';
    p.orientation.hidden=!viewer.state.compassVisible;p.legend.hidden=!viewer.state.legendVisible;
    const direction=p.camera?.getWorldDirection(new THREE.Vector3());if(direction){const az=(Math.atan2(direction.z,direction.x)*180/Math.PI+360)%360,inc=Math.asin(Math.max(-1,Math.min(1,direction.y)))*180/Math.PI;p.orientation.textContent='Direction '+az.toFixed(0)+' ° · Dip '+inc.toFixed(0)+'°';}
    const signature=JSON.stringify(viewer.state.models.filter(m=>m.inScene!==false).map(m=>[m.id,m.displayName||m.fileName||m.name,m.color,m.visible,m.lithologyTypes,m.geochemMin,m.geochemMax]));
    if(signature!==p.legendSignature){
      p.legendSignature=signature;const savedState=state;
      try{state=viewer.state;updateLegend();const copy=document.getElementById('scene-legend').cloneNode(true);copy.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));p.legend.replaceChildren(...copy.childNodes);}
      finally{state=savedState;updateLegend();}
    }
    if(viewer.state.axisLabelGroup)viewer.state.axisLabelGroup.visible=!!viewer.state.axisLabelsVisible&&viewer.state.models.some(m=>m.inScene!==false);
  }
  function pickPanePoint(p,event){
    const viewer=tabViewers.get(p.id),rect=p.renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();
    p.camera.updateMatrixWorld();ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),p.camera);
    const hits=ray.intersectObjects(viewer.state.models.filter(m=>m.inScene!==false&&m.visible!==false&&m.mesh.visible).map(m=>m.mesh),true);
    const cfg=syncClipEnabled?{axis:clipAxis,value:clipValue,direction:clipDirection}:localClipFor(viewer),plane=cfg.enabled||syncClipEnabled?planeFromConfig(viewer,cfg):null;
    for(const hit of hits)if(!plane||plane.distanceToPoint(hit.point)>=-1e-6)return hit.point.clone();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),-p.target.y),new THREE.Vector3());
  }
  function cancelPaneMeasure(p){
    if(p.measurePreview){p.measureScene?.remove(p.measurePreview);p.measurePreview.geometry.dispose();p.measurePreview.material.dispose();}p.measurePreview=null;p.measureStart=null;
    if(p.measureHint)p.measureHint.hidden=true;
  }
  function startPaneMeasure(p,event){
    cancelPaneMeasure(p);const point=pickPanePoint(p,event);if(!point)return;p.measureStart=point;p.measureScene=tabViewers.get(p.id).scene;
    p.measurePreview=new THREE.Line(new THREE.BufferGeometry().setFromPoints([point,point]),new THREE.LineBasicMaterial({color:0x39ff14}));p.measureScene.add(p.measurePreview);p.measureHint.hidden=false;p.measureHint.textContent='Drag to select endpoint';
  }
  function movePaneMeasure(p,event){const point=pickPanePoint(p,event);if(!point)return;const positions=p.measurePreview.geometry.attributes.position;positions.setXYZ(1,point.x,point.y,point.z);positions.needsUpdate=true;p.measureHint.textContent='Measure '+p.measureStart.distanceTo(point).toFixed(2)+' m';}
  function finishPaneMeasure(p,event){
    const point=pickPanePoint(p,event),start=p.measureStart?.clone(),viewer=tabViewers.get(p.id);cancelPaneMeasure(p);if(!point||!start||!viewer)return;
    const distance=start.distanceTo(point);if(distance<1e-6)return;
    const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([start,point]),new THREE.LineBasicMaterial({color:0x39ff14}));
    const box=new THREE.Box3();viewer.state.models.filter(m=>m.inScene!==false).forEach(m=>expandModelBox3(box,m));const scale=(box.isEmpty()?100:box.getSize(new THREE.Vector3()).length())*.025+1;
    const sprite=makeDistanceSprite(distance.toFixed(2)+' m',scale);sprite.position.copy(start).add(point).multiplyScalar(.5);sprite.position.y+=scale*.8;
    const spheres=[start,point].map(pos=>{const sphere=new THREE.Mesh(new THREE.SphereGeometry(scale*.1,8,8),new THREE.MeshBasicMaterial({color:0x39ff14}));sphere.position.copy(pos);return sphere;});
    viewer.scene.add(line,sprite,...spheres);viewer.state.rulerItems.push({id:'ruler-'+Date.now()+'-'+p.index,line,sprite,startSphere:spheres[0],endSphere:spheres[1],distance});viewer.state.rulerLines.push(line,sprite);viewer.state.rulerPoints.push(...spheres);p.layerSignature='';refreshLayerPanel(p);
  }
  async function screenshotPane(p){
    const viewer=tabViewers.get(p.id);if(!viewer||!p.renderer)return;
    renderComparedScene(p,viewer);const shot=document.createElement('canvas');shot.width=p.renderer.domElement.width;shot.height=p.renderer.domElement.height;const ctx=shot.getContext('2d');ctx.drawImage(p.renderer.domElement,0,0);
    const scale=p.renderer.getPixelRatio();ctx.font=(12*scale)+'px sans-serif';ctx.fillStyle='#222';if(!p.orientation.hidden)ctx.fillText(p.orientation.textContent,10*scale,22*scale);
    if(!p.legend.hidden){const rows=viewer.state.models.filter(m=>m.inScene!==false&&m.visible!==false);rows.forEach((m,i)=>{ctx.fillStyle='#'+m.color.toString(16).padStart(6,'0');ctx.fillRect(10*scale,(42+i*18)*scale,9*scale,9*scale);ctx.fillStyle='#222';ctx.fillText(m.displayName||m.fileName||m.name,25*scale,(51+i*18)*scale);});}
    return new Promise(resolve=>shot.toBlob(blob=>{if(blob){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=['Left','Right'][p.index]+' _Screenshot_'+Date.now()+'.png';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}resolve(blob);},'image/png'));
  }
  async function paneTool(p,key){
    await activate(p.index);if(activeTabId!==p.id)return;const viewer=tabViewers.get(p.id);
    if(key==='clear'){cancelPaneMeasure(p);document.getElementById('btn-clear-all').click();localClipFor(viewer).enabled=false;controls.enabled=false;refreshLocalClip(p);p.layerSignature='';refreshLayerPanel(p);}
    else if(key==='reset')fit(p);
    else if(key==='measure'){cancelPaneMeasure(p);viewer.state.measureMode=!viewer.state.measureMode;}
    else if(key==='clip'&&!syncClipEnabled){const cfg=localClipFor(viewer);cfg.enabled=!cfg.enabled;refreshLocalClip(p,cfg.enabled);}
    else if(key==='screenshot')await screenshotPane(p);
    else{const flag={compass:'compassVisible',axes:'axisLabelsVisible',legend:'legendVisible'}[key];if(flag)viewer.state[flag]=!viewer.state[flag];}
    refreshPaneTools(p);
  }
  function setupPaneTools(p){
    p.localToolbar=document.createElement('div');p.localToolbar.className='rc-local-toolbar';p.localToolbar.setAttribute('aria-label',['Left','Right'][p.index]+' Canvas tools');
    for(const [key,id] of [['clear','btn-clear-all'],['reset','btn-reset-view'],['measure','btn-measure'],['clip','btn-clip'],['screenshot','btn-snapshot'],['compass','btn-toggle-compass'],['axes','btn-toggle-axis-labels'],['legend','btn-toggle-legend']]){
      const btn=document.getElementById(id).cloneNode(true);btn.removeAttribute('id');btn.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));btn.dataset.tool=key;btn.title=['Left','Right'][p.index]+'：'+btn.textContent.trim();btn.onclick=()=>paneTool(p,key);p.localToolbar.append(btn);
    }
    p.localClip=document.createElement('div');p.localClip.className='rc-clip-controls rc-local-clip';p.localClip.innerHTML=clipControls.innerHTML;p.localClip.querySelector('strong').textContent='Independent clipping';p.localClip.querySelector('span').textContent='Applies to this pane only';p.localClip.hidden=true;
    p.element.insertBefore(p.localToolbar,p.stage);p.element.insertBefore(p.localClip,p.stage);
    p.localClip.querySelector('.rc-clip-axis').onchange=()=>{const cfg=localClipFor(tabViewers.get(p.id));cfg.axis=p.localClip.querySelector('.rc-clip-axis').value;refreshLocalClip(p,true);};
    p.localClip.querySelector('.rc-clip-direction').onchange=()=>{localClipFor(tabViewers.get(p.id)).direction=Number(p.localClip.querySelector('.rc-clip-direction').value);};
    for(const selector of ['.rc-clip-range','.rc-clip-value'])p.localClip.querySelector(selector).oninput=event=>{if(event.target.value.trim()==='')return;const value=Number(event.target.value);if(Number.isFinite(value)){localClipFor(tabViewers.get(p.id)).value=value;refreshLocalClip(p);}};
    p.orientation=document.createElement('div');p.orientation.className='rc-orientation';p.legend=document.createElement('div');p.legend.className='rc-legend';p.measureHint=document.createElement('div');p.measureHint.className='rc-measure-hint';p.measureHint.hidden=true;p.stage.append(p.orientation,p.legend,p.measureHint);
  }
  panes.forEach(setupPaneTools);
  function clipPlaneFor(viewer){
    const origin=viewer.state.origin||{x:0,y:0,z:0};
    const normal=clipAxis==='z'?new THREE.Vector3(0,1,0):clipAxis==='x'?new THREE.Vector3(1,0,0):new THREE.Vector3(0,0,-1);
    const constant=origin[clipAxis]-clipValue;
    return new THREE.Plane(normal.multiplyScalar(clipDirection),constant*clipDirection);
  }
  function refreshClipRange(reset){
    let min=Infinity,max=-Infinity;
    for(const p of panes){
      const viewer=tabViewers.get(p.id);if(!viewer)continue;const box=new THREE.Box3();
      viewer.state.models.filter(m=>m.inScene!==false).forEach(m=>expandModelBox3(box,m));if(box.isEmpty())continue;
      const o=viewer.state.origin||{x:0,y:0,z:0};
      const low=clipAxis==='x'?box.min.x+o.x:clipAxis==='z'?box.min.y+o.z:o.y-box.max.z;
      const high=clipAxis==='x'?box.max.x+o.x:clipAxis==='z'?box.max.y+o.z:o.y-box.min.z;
      min=Math.min(min,low);max=Math.max(max,high);
    }
    if(!Number.isFinite(min)){min=0;max=1;}
    if(reset)clipValue=(min+max)/2;
    const slider=clipControls.querySelector('.rc-clip-range');slider.min=String(Math.min(min,clipValue));slider.max=String(Math.max(max,min+.01,clipValue));slider.step=String(Math.max(.001,(max-min)/1000));slider.value=String(clipValue);
    clipControls.querySelector('.rc-clip-value').value=String(Number(clipValue.toFixed(6)));
  }
  function setSyncClipping(enabled){
    syncClipEnabled=!!enabled;clipControls.hidden=!enabled||!active;
    toolbar.querySelector('[data-action="clip"]').setAttribute('aria-pressed',String(syncClipEnabled));
    if(enabled)refreshClipRange(true);
    panes.forEach(p=>{refreshLocalClip(p);refreshPaneTools(p);});
  }
  function renderComparedScene(p,viewer){
    const ratio=desiredCanvasPixelRatio(false);if(p.renderer.getPixelRatio()!==ratio)p.renderer.setPixelRatio(ratio);
    window.presentationMode?.apply(viewer.scene,viewer.state,p.renderer);
    const local=localClipFor(viewer);
    if(!syncClipEnabled&&!local.enabled){p.renderer.render(viewer.scene,p.camera);return;}
    const planes=[syncClipEnabled?clipPlaneFor(viewer):planeFromConfig(viewer,local)],originals=new Map();
    const helpers=(viewer.state.clipHelpers||[]).map(helper=>[helper,helper.visible]);
    try{
      for(const model of viewer.state.models){
        if(!model.mesh||model.inScene===false)continue;
        let cached=materialCache.get(model);
        if(!cached||cached.mesh!==model.mesh||cached.material!==model.material||cached.materials!==model.materials){
          const materials=new Set();model.mesh.traverse(object=>{for(const material of Array.isArray(object.material)?object.material:[object.material])if(material)materials.add(material);});
          cached={mesh:model.mesh,material:model.material,materials:model.materials,list:[...materials]};materialCache.set(model,cached);
        }
        for(const material of cached.list){if(!originals.has(material))originals.set(material,material.clippingPlanes);material.clippingPlanes=planes;}
      }
      for(const [helper] of helpers)helper.visible=false;
      p.renderer.render(viewer.scene,p.camera);
    }finally{
      for(const [material,original] of originals)material.clippingPlanes=original;
      for(const [helper,visible] of helpers)helper.visible=visible;
    }
  }
  function render(){if(!active)return;frame=requestAnimationFrame(render);choices();panes.forEach(refreshLayerPanel);panes.forEach(refreshPaneTools);syncBottomLayout();if(document.hidden||window.__modalOpenCount>0)return;panes.forEach(p=>{const viewer=tabViewers.get(p.id);if(!viewer||!p.camera||!p.renderer)return;const width=p.stage.clientWidth,height=p.stage.clientHeight;if(!width||!height)return;if(p.renderer.domElement.width!==Math.round(width*p.renderer.getPixelRatio())||p.renderer.domElement.height!==Math.round(height*p.renderer.getPixelRatio()))p.renderer.setSize(width,height,false);if(p.camera.isPerspectiveCamera)p.camera.aspect=width/height;p.camera.updateProjectionMatrix();p.camera.lookAt(p.target);renderComparedScene(p,viewer);commit(p);});}
  async function enter(){const list=available();if(list.length<2){window.showTabModal({title:'Region Comparison',label:'Import models into both regions first, Open two 3D views before comparing. '});return;}const left=list.find(([id])=>id===activeTabId)||list[0],right=list.find(([id,v])=>id!==left[0]&&v.regionId!==left[1].regionId)||list.find(([id])=>id!==left[0]);if(tabViewers.get(right[0])?._deferredModels)await loadDeferredViewer(right[0]);await window.switchTab(left[0]);if(activeTabId!==left[0])return;previousEnabled=controls.enabled;controls.enabled=false;active=true;host.hidden=false;toolbar.hidden=false;document.getElementById('center-area').classList.add('rc-bottom-mode');comparisonBottom.hidden=false;document.getElementById('lm-list').querySelectorAll('.lm-item, .lm-measure-item, .lm-clip-item').forEach(row=>row.remove());button.classList.add('active');button.setAttribute('aria-pressed','true');panes.forEach(p=>{p.renderer=new THREE.WebGLRenderer({antialias:true});p.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));p.renderer.localClippingEnabled=true;p.stage.append(p.renderer.domElement);gesture(p,p.renderer.domElement);});choose(panes[0],left[0]);choose(panes[1],right[0]);signature='';choices();panes.forEach(refreshLayerPanel);syncBottomLayout();await activate(0);alignSync(panes[0]);render();}
  function exit(){if(!active)return;setSyncClipping(false);panes.forEach(commit);active=false;comparisonBottom.hidden=true;document.getElementById('center-area').classList.remove('rc-bottom-mode');rebuildLayerManagement();cancelAnimationFrame(frame);host.hidden=true;toolbar.hidden=true;button.classList.remove('active');button.setAttribute('aria-pressed','false');controls.enabled=previousEnabled;panes.forEach(p=>{cancelPaneMeasure(p);p.renderer?.dispose();p.renderer?.forceContextLoss();p.renderer?.domElement.remove();p.renderer=null;p.drag=null;});const viewer=tabViewers.get(activeTabId);if(viewer?.type==='3d'){controls.swapCamera(viewer.camera,viewer.target);controls.enabled=previousEnabled&&!viewer.state.measureMode;document.getElementById('btn-measure').classList.toggle('active',!!viewer.state.measureMode);canvas.classList.toggle('measuring',!!viewer.state.measureMode);syncToolbarToggleButtons();updateLegend();}window.dispatchEvent(new Event('resize'));}
  function fit(p){const viewer=tabViewers.get(p.id);if(!viewer||!p.camera)return;const box=new THREE.Box3();viewer.state.models.filter(m=>m.inScene!==false&&m.visible!==false).forEach(m=>box.union(new THREE.Box3().setFromObject(m.mesh)));if(box.isEmpty())return;const center=box.getCenter(new THREE.Vector3()),radius=box.getSize(new THREE.Vector3()).length()/2,direction=p.camera.position.clone().sub(p.target).normalize();p.target.copy(center);p.camera.position.copy(center).add(direction.multiplyScalar(Math.max(1,radius/Math.sin(THREE.MathUtils.degToRad((p.camera.fov||40)/2))*1.15)));p.camera.near=Math.max(.01,radius/10000);p.camera.far=Math.max(1000,radius*20);p.camera.lookAt(center);commit(p);}
  function onTabActivated(id){if(tabViewers.get(id)?._loadingDeferred)return;if(!active)return;const viewer=tabViewers.get(id);if(viewer?.type!=='3d'||viewer.isVector2D){exit();return;}const found=panes.find(p=>p.id===id);if(found)side=found.index;else choose(panes[side],id);panes.forEach((p,index)=>{p.element.classList.toggle('rc-current',index===side);p.badge.hidden=index!==side;});signature='';}
  toolbar.querySelector('[data-action="clip"]').onclick=()=>setSyncClipping(!syncClipEnabled);
  clipControls.querySelector('.rc-clip-axis').onchange=event=>{clipAxis=event.target.value;refreshClipRange(true);};
  clipControls.querySelector('.rc-clip-direction').onchange=event=>{clipDirection=Number(event.target.value);};
  for(const selector of ['.rc-clip-range','.rc-clip-value'])clipControls.querySelector(selector).oninput=event=>{if(event.target.value.trim()==='')return;const value=Number(event.target.value);if(Number.isFinite(value)){clipValue=value;refreshClipRange(false);}};
  toolbar.querySelector('[data-action="sync"]').onclick=()=>setSynchronized(!synchronized);
  button.onclick=()=>active?exit():enter();toolbar.querySelector('[data-action="exit"]').onclick=exit;toolbar.querySelector('[data-action="fit"]').onclick=()=>panes.forEach(fit);toolbar.querySelector('[data-action="swap"]').onclick=async()=>{panes.forEach(commit);const left=panes[0].id,right=panes[1].id;choose(panes[0],right);choose(panes[1],left);signature='';choices();await activate(1-side);};
  window.regionCompare={enter,exit,activate,onTabActivated,layerTarget,paneTool,pickPanePoint,localClipFor,screenshotPane,setSynchronized,setSyncClipping,clipPlaneFor,get syncClipEnabled(){return syncClipEnabled;},get synchronized(){return synchronized;},get active(){return active;},get panes(){return panes;}};
})();
