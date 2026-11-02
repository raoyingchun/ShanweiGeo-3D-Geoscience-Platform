(function(){
  'use strict';
  const defaults={enabled:false,matte:true,brightness:1,environment:true,environmentStrength:.35,tone:'filmic',exposure:1};
  let options={...defaults};
  try{const saved=JSON.parse(localStorage.getItem('shanwei-presentation-v1'));if(saved){options.matte=saved.matte!==false;options.brightness=Math.max(.4,Math.min(2,Number(saved.brightness)||1));}}catch(_){}
  try{const saved=JSON.parse(localStorage.getItem('shanwei-presentation-v1'));if(saved){options.environment=saved.environment!==false;options.environmentStrength=Number.isFinite(saved.environmentStrength)?Math.max(0,Math.min(1,saved.environmentStrength)):.35;options.tone=saved.tone==='standard'?'standard':'filmic';options.exposure=Number.isFinite(saved.exposure)?Math.max(.5,Math.min(1.8,saved.exposure)):1;}}catch(_){}
  const records=new WeakMap(),materialOriginals=new WeakMap(),rendererRecords=new WeakMap();
  function environmentFor(targetRenderer){
    let record=rendererRecords.get(targetRenderer);
    if(!record){record={tone:targetRenderer.toneMapping,exposure:targetRenderer.toneMappingExposure,target:null};rendererRecords.set(targetRenderer,record);}
    if(options.enabled&&options.environment&&!record.target&&!record.failed){
      // Small local studio panorama: generated once per WebGL context, no network assets.
      const canvas=document.createElement('canvas');canvas.width=512;canvas.height=256;const ctx=canvas.getContext('2d');
      const gradient=ctx.createLinearGradient(0,0,0,256);gradient.addColorStop(0,'#dadfe8');gradient.addColorStop(.5,'#858a94');gradient.addColorStop(1,'#373b43');ctx.fillStyle=gradient;ctx.fillRect(0,0,512,256);
      for(const [x,y,r] of [[125,70,75],[385,90,55]]){const glow=ctx.createRadialGradient(x,y,0,x,y,r);glow.addColorStop(0,'rgba(255,250,237,1)');glow.addColorStop(1,'rgba(255,250,237,0)');ctx.fillStyle=glow;ctx.fillRect(x-r,y-r,r*2,r*2);}
      const texture=new THREE.CanvasTexture(canvas);texture.mapping=THREE.EquirectangularReflectionMapping;texture.encoding=THREE.sRGBEncoding;
      const generator=new THREE.PMREMGenerator(targetRenderer);
      try{record.target=generator.fromEquirectangular(texture);}catch(error){record.failed=true;console.warn('Environment lighting is unavailable, Continue using soft lighting',error);}finally{texture.dispose();generator.dispose();}
      const dispose=targetRenderer.dispose;
      targetRenderer.dispose=function(){record.target?.dispose();rendererRecords.delete(targetRenderer);return dispose.call(this);};
    }
    targetRenderer.toneMapping=options.enabled&&options.tone==='filmic'?THREE.ACESFilmicToneMapping:options.enabled?THREE.NoToneMapping:record.tone;
    targetRenderer.toneMappingExposure=options.enabled?options.exposure:record.exposure;
    return record.target?.texture||null;
  }
  function apply(targetScene,targetState,targetRenderer){
    if(!targetScene||!targetState)return;
    let record=records.get(targetScene);
    if(!record){
      const lights=[];targetScene.traverse(object=>{if(object.isLight)lights.push([object,object.intensity]);});
      const group=new THREE.Group();group.name='presentation-lights';
      group.add(new THREE.HemisphereLight(0xf5f8ff,0x67615a,1));
      const key=new THREE.DirectionalLight(0xfff3e2,1.4);key.position.set(120,250,160);group.add(key);
      const fill=new THREE.DirectionalLight(0xdceaff,.55);fill.position.set(-180,100,-100);group.add(fill);
      targetScene.add(group);record={lights,group,meshes:new WeakMap(),environment:targetScene.environment};records.set(targetScene,record);
    }
    if(targetRenderer){const environment=environmentFor(targetRenderer);targetScene.environment=options.enabled&&options.environment&&environment?environment:record.environment;}
    record.group.visible=options.enabled;
    for(const [light,intensity] of record.lights)light.intensity=options.enabled?0:intensity;
    for(const light of record.group.children)light.intensity=options.brightness*(light===record.group.children[0]?1:light===record.group.children[1]?1.4:.55);
    for(const model of targetState.models||[]){
      if(!model.mesh)continue;
      let cached=record.meshes.get(model.mesh);
      if(!cached||cached.material!==model.material||cached.materials!==model.materials){
        const materials=new Set();model.mesh.traverse(object=>{for(const material of Array.isArray(object.material)?object.material:[object.material])if(material?.isMeshStandardMaterial&&!material.map)materials.add(material);});
        cached={material:model.material,materials:model.materials,list:[...materials]};record.meshes.set(model.mesh,cached);
      }
      for(const material of cached.list){
        window.rockTexture?.apply(material,options.enabled,model);
        if(!materialOriginals.has(material))materialOriginals.set(material,{roughness:material.roughness,metalness:material.metalness,envMapIntensity:material.envMapIntensity});
        const original=materialOriginals.get(material);
        // Only surface response changes; depth, alpha, clipping and colors stay untouched.
        material.roughness=options.enabled&&options.matte ? .92 : original.roughness;
        material.metalness=options.enabled&&options.matte?0:original.metalness;
        material.envMapIntensity=options.enabled&&options.environment?options.environmentStrength:original.envMapIntensity;
      }
    }
    targetScene.background.set(appPreferences.background);
  }
  function save(){try{localStorage.setItem('shanwei-presentation-v1',JSON.stringify(options));}catch(error){console.warn('Unable to save presentation settings',error);}}
  const button=document.createElement('button');button.type='button';button.id='btn-presentation';button.className='rail-action';button.title='Presentation Mode';button.setAttribute('aria-label','Presentation Mode');button.setAttribute('aria-expanded','false');
  button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16v12H4zM12 16v5M8 21h8M8 8l3 3 5-4"/></svg><span class="rail-action-label">Presentation Mode</span>';
  document.getElementById('btn-utilities').before(button);
  const panel=document.createElement('section');panel.id='presentation-panel';panel.hidden=true;panel.setAttribute('aria-label','Presentation settings');
  panel.innerHTML='<header><strong>Presentation Mode</strong><button type="button" data-close aria-label="Close presentation settings">×</button></header><label>Enable presentation mode<input type="checkbox" data-enabled></label><label>Soft lighting brightness<output data-value></output></label><input aria-label="Lighting brightness" data-brightness type="range" min="0.4" max="2" step="0.05"><label>Matte materials<input type="checkbox" data-matte></label><label>Canvas background<input type="color" data-background aria-label="Canvas background color"></label><div class="presentation-presets"><button type="button" data-color="#ececec">Light gray</button><button type="button" data-color="#faf8f3">Warm white</button><button type="button" data-color="#202735">Dark</button></div><button type="button" data-reset>Restore defaults</button>';
  document.body.append(panel);
  panel.querySelector('[data-reset]').insertAdjacentHTML('beforebegin','<label>Ambient lighting<input type="checkbox" data-environment></label><label>Ambient light intensity<output data-env-value></output></label><input aria-label="Ambient light intensity" data-env-strength type="range" min="0" max="1" step="0.05"><label>Tone mapping<select data-tone aria-label="Tone mapping"><option value="filmic">Soft cinematic</option><option value="standard">Standard</option></select></label><label>Exposure<output data-exposure-value></output></label><input aria-label="Exposure" data-exposure type="range" min="0.5" max="1.8" step="0.05"><label>Antialiasing quality<select data-quality aria-label="Antialiasing quality"><option value="smooth">Fast</option><option value="standard">Balanced</option><option value="high">High quality</option></select></label><p style="font-size:12px;color:var(--text-muted)">Edge antialiasing enabled, High quality increases GPU workload. </p>');
  function refreshAdvanced(){panel.querySelector('[data-environment]').checked=options.environment;panel.querySelector('[data-env-strength]').value=options.environmentStrength;panel.querySelector('[data-env-value]').textContent=options.environmentStrength.toFixed(2);panel.querySelector('[data-tone]').value=options.tone;panel.querySelector('[data-exposure]').value=options.exposure;panel.querySelector('[data-exposure-value]').textContent=options.exposure.toFixed(2);panel.querySelector('[data-quality]').value=appPreferences.quality;}
  panel.querySelector('[data-environment]').onchange=e=>{options.environment=e.target.checked;save();};
  for(const [selector,key] of [['[data-env-strength]','environmentStrength'],['[data-exposure]','exposure']])panel.querySelector(selector).oninput=e=>{options[key]=Number(e.target.value);save();refreshAdvanced();};
  panel.querySelector('[data-tone]').onchange=e=>{options.tone=e.target.value;save();};
  panel.querySelector('[data-quality]').onchange=e=>{appPreferences.quality=e.target.value;background(appPreferences.background);};
  function refresh(){panel.querySelector('[data-enabled]').checked=options.enabled;panel.querySelector('[data-matte]').checked=options.matte;panel.querySelector('[data-brightness]').value=options.brightness;panel.querySelector('[data-value]').textContent=options.brightness.toFixed(2);panel.querySelector('[data-background]').value=appPreferences.background;button.classList.toggle('active',options.enabled);}
  function close(){panel.hidden=true;button.setAttribute('aria-expanded','false');}
  function background(color){appPreferences.background=color;try{localStorage.setItem('shanwei-display-preferences-v1',JSON.stringify(appPreferences));}catch(error){console.warn('Unable to save background settings',error);}refreshAllScenePreferences();refresh();}
  function setEnabled(enabled){options.enabled=!!enabled;save();refresh();document.body.classList.toggle('presentation-enabled',options.enabled);button.setAttribute('aria-pressed',String(options.enabled));if(!options.enabled){close();document.getElementById('rock-library-dialog')?.close();}for(const viewer of tabViewers.values())if(viewer.type==='3d'&&viewer.scene&&viewer.state)apply(viewer.scene,viewer.state);environmentFor(renderer);for(const pane of window.regionCompare?.panes||[])if(pane.renderer)environmentFor(pane.renderer);window.dispatchEvent(new CustomEvent('presentation-mode-change',{detail:{enabled:options.enabled}}));}
  button.onclick=()=>{panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));refresh();if(!panel.hidden){refreshAdvanced();const rect=button.getBoundingClientRect();panel.style.top=Math.max(8,Math.min(rect.top,innerHeight-panel.offsetHeight-8))+'px';}};
  panel.querySelector('[data-close]').onclick=close;
  const enabledInput=panel.querySelector('[data-enabled]');
  enabledInput.onclick=e=>{
    e.preventDefault();e.stopPropagation();
    setEnabled(!options.enabled);
    // A cancelled native checkbox click restores its previous checked value.
    // Synchronize after that rollback so the control follows the actual mode.
    queueMicrotask(()=>{enabledInput.checked=options.enabled;});
  };
  enabledInput.onchange=e=>{e.stopPropagation();setEnabled(e.target.checked);};
  panel.querySelector('[data-matte]').onchange=e=>{options.matte=e.target.checked;save();};
  panel.querySelector('[data-brightness]').oninput=e=>{options.brightness=Number(e.target.value);save();refresh();};
  panel.querySelector('[data-background]').oninput=e=>background(e.target.value);
  panel.querySelectorAll('[data-color]').forEach(element=>element.onclick=()=>background(element.dataset.color));
  panel.querySelector('[data-reset]').onclick=()=>{options={...defaults};setEnabled(false);background(APP_PREFERENCE_DEFAULTS.background);};
  document.addEventListener('pointerdown',e=>{if(!panel.hidden&&!panel.contains(e.target)&&!button.contains(e.target))close();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden){close();button.focus();}});
  window.addEventListener('resize',close);
  button.addEventListener('click',refreshAdvanced);
  panel.querySelector('[data-reset]').addEventListener('click',()=>{appPreferences.quality=APP_PREFERENCE_DEFAULTS.quality;background(appPreferences.background);refreshAdvanced();});
  window.presentationMode={apply,setEnabled,get enabled(){return options.enabled;}};refresh();refreshAdvanced();document.body.classList.toggle('presentation-enabled',options.enabled);button.setAttribute('aria-pressed',String(options.enabled));
})();
