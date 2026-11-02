(function(){
  'use strict';
  const defaults={asset:'rock_01',mode:'off',size:80,strength:1,bump:.25,tint:.35,boundaryNormals:true,parallel:false,layerSpacing:10,layerDirection:0,folded:false,foldAmplitude:10,foldWavelength:100,foldAxis:0};
  const loader=new THREE.TextureLoader(),materials=new WeakMap(),assets=new Map();let catalog=[],ready=false;
  async function refreshCustom(){if(!window.electronAPI?.listCustomMaterials)return;const result=await electronAPI.listCustomMaterials();if(!result.ok)throw Error(result.error);catalog=catalog.filter(item=>!item.custom).concat(result.data);}
  const catalogReady=fetch('assets/textures/rock-library.json').then(response=>{if(!response.ok)throw Error('Unable to read the material catalog');return response.json();}).then(async value=>{catalog=value;try{await refreshCustom();}catch(error){console.warn(error);}ready=true;return catalog;});
  catalogReady.catch(error=>console.warn('The local rock material library is unavailable',error));
  function normalize(value){const result={...defaults};if(!value)return result;if(catalog.some(item=>item.id===value.asset))result.asset=value.asset;if(['off','rock','mixed'].includes(value.mode))result.mode=value.mode==='mixed'?'rock':value.mode;for(const [key,min,max] of [['size',1,2000],['strength',0,1],['bump',0,1],['tint',0,1],['layerSpacing',.1,2000],['layerDirection',0,360],['foldAmplitude',0,2000],['foldWavelength',1,10000],['foldAxis',0,360]])if(Number.isFinite(value[key]))result[key]=Math.max(min,Math.min(max,value[key]));if(typeof value.parallel==='boolean')result.parallel=value.parallel;if(typeof value.folded==='boolean')result.folded=value.folded;if(typeof value.boundaryNormals==='boolean')result.boundaryNormals=value.boundaryNormals;if(value.asset?.startsWith('custom_')&&!catalog.some(item=>item.id===value.asset)){result.mode='off';}return result;}
  function loadAsset(id){
    if(assets.has(id))return assets.get(id);
    const item=catalog.find(item=>item.id===id);if(!item)return null;
    const record={textures:{},ready:false,error:null};assets.set(id,record);
    if(item.custom){
      record.promise=electronAPI.readCustomMaterial(id).then(result=>{if(!result.ok)throw Error(result.error);return new Promise((resolve,reject)=>loader.load(result.data,texture=>{texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=4;record.textures.color=texture;resolve();},undefined,reject));}).then(()=>{
        const normal=new THREE.DataTexture(new Uint8Array([128,128,255,255]),1,1,THREE.RGBAFormat),roughness=new THREE.DataTexture(new Uint8Array([230,230,230,255]),1,1,THREE.RGBAFormat);normal.needsUpdate=roughness.needsUpdate=true;record.textures.normal=normal;record.textures.roughness=roughness;record.ready=true;return record;
      }).catch(error=>{record.error=error;throw error;});record.promise.catch(error=>console.warn('Unable to read the custom image',error));return record;
    }
    record.promise=Promise.all(['color','normal','roughness'].map(name=>new Promise((resolve,reject)=>loader.load('assets/textures/'+item.maps[name].path,texture=>{texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=4;record.textures[name]=texture;resolve();},undefined,reject)))).then(()=>{record.ready=true;return record;}).catch(error=>{record.error=error;Object.values(record.textures).forEach(texture=>texture.dispose());throw error;});
    record.promise.catch(error=>console.warn('Unable to load the rock texture:  '+id,error));return record;
  }
  const declaration=`
    varying vec3 rockPosition;
    varying vec3 rockWorldNormal;
    uniform sampler2D rockColorMap, rockNormalMap, rockRoughMap;
    uniform float rockEnabled, rockSize, rockStrength, rockBump, rockMixed, rockTint, rockBoundaryNormals;
    uniform float rockParallel,rockLayerSpacing,rockLayerDirection,rockLayerPhase;
    uniform float rockFolded,rockFoldAmplitude,rockFoldWavelength,rockFoldAxis,rockFoldPhase;
    float rockLayerHeight(){
      float across=-rockPosition.x*sin(rockFoldAxis)-rockPosition.z*cos(rockFoldAxis)+rockFoldPhase;
      float uplift=rockFolded*rockFoldAmplitude*cos(across*6.2831853/rockFoldWavelength);
      return (rockPosition.y+rockLayerPhase-uplift)/rockLayerSpacing;
    }
    vec3 rockSurfaceNormal(){
      vec3 smoothNormal=normalize(rockWorldNormal);
      vec3 faceVector=cross(dFdx(rockPosition),dFdy(rockPosition));
      vec3 faceNormal=faceVector/max(length(faceVector),0.000001);
      if(dot(faceNormal,smoothNormal)<0.0)faceNormal=-faceNormal;
      // Fix only axis-aligned planar boundaries; retain smooth curved surfaces.
      if(rockBoundaryNormals>0.5&&max(max(abs(faceNormal.x),abs(faceNormal.y)),abs(faceNormal.z))>0.9995)return faceNormal;
      return smoothNormal;
    }
    vec3 rockWeights(){vec3 w=pow(abs(rockSurfaceNormal()),vec3(4.0));return w/max(dot(w,vec3(1.0)),0.0001);}
    float rockBlend(vec2 uv){return 0.5+0.22*sin(uv.x*0.73+0.8)*sin(uv.y*0.61-0.4);}
    vec2 rockAlternate(vec2 uv){return vec2(-uv.y,uv.x)*0.73+vec2(17.31,5.73);}
    vec4 rockTile(sampler2D tex,vec2 uv){return mix(texture2D(tex,uv),texture2D(tex,rockAlternate(uv)),rockBlend(uv));}
    vec3 rockTileNormal(vec2 uv){vec3 a=texture2D(rockNormalMap,uv).xyz*2.0-1.0;vec3 b=texture2D(rockNormalMap,rockAlternate(uv)).xyz*2.0-1.0;b.xy=vec2(b.y,-b.x)*0.73;return normalize(mix(a,b,rockBlend(uv)));}
    // Crossfade horizontally offset samples without rotating the bedding.
    // Each sample masks the other's repeat boundary; elevation stays aligned.
    vec4 rockLayerTile(sampler2D tex,vec2 uv){
      float edgeDistance=min(fract(uv.x),1.0-fract(uv.x));
      float blend=smoothstep(0.05,0.4,edgeDistance);
      return mix(texture2D(tex,uv+vec2(0.5,0.0)),texture2D(tex,uv),blend);
    }
    vec4 rockSample(sampler2D tex){vec3 p=rockPosition/rockSize;vec3 w=rockWeights();
      if(rockParallel>0.5){float c=cos(rockLayerDirection),s=sin(rockLayerDirection);vec2 horizontal=mat2(c,-s,s,c)*p.xz;float height=rockLayerHeight();return rockLayerTile(tex,vec2(horizontal.y,height))*w.x+rockLayerTile(tex,vec2(horizontal.x,height))*w.y+rockLayerTile(tex,vec2(horizontal.x,height))*w.z;}
      return rockTile(tex,p.yz)*w.x+rockTile(tex,p.xz)*w.y+rockTile(tex,p.xy)*w.z;}
  `;
  function install(material){
    let record=materials.get(material);if(record)return record;
    const uniforms={rockColorMap:{value:null},rockNormalMap:{value:null},rockRoughMap:{value:null},rockEnabled:{value:0},rockSize:{value:80},rockStrength:{value:1},rockBump:{value:.25},rockMixed:{value:0},rockTint:{value:.35},rockBoundaryNormals:{value:1},rockParallel:{value:0},rockLayerSpacing:{value:10},rockLayerDirection:{value:0},rockLayerPhase:{value:0}};
    Object.assign(uniforms,{rockFolded:{value:0},rockFoldAmplitude:{value:10},rockFoldWavelength:{value:100},rockFoldAxis:{value:0},rockFoldPhase:{value:0}});
    material.extensions=Object.assign({},material.extensions,{derivatives:true});
    const previous=material.onBeforeCompile,previousKey=material.customProgramCacheKey.bind(material);
    const key=previousKey();
    material.onBeforeCompile=function(shader,renderer){
      previous.call(this,shader,renderer);Object.assign(shader.uniforms,uniforms);
      shader.vertexShader='varying vec3 rockPosition; varying vec3 rockWorldNormal;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`#include <project_vertex>
        vec4 rockLocal=vec4(transformed,1.0);
        #ifdef USE_INSTANCING
          rockLocal=instanceMatrix*rockLocal;
        #endif
        rockPosition=(modelMatrix*rockLocal).xyz;
        rockWorldNormal=inverseTransformDirection(transformedNormal,viewMatrix);
      `);
      shader.fragmentShader=declaration+shader.fragmentShader;
      // Image-original mode displays the source sRGB pixels after lighting,
      // tone mapping and output encoding, retaining the model's alpha/depth.
      shader.fragmentShader=shader.fragmentShader.replace('#include <encodings_fragment>',`#include <encodings_fragment>
        if(rockEnabled>0.5)gl_FragColor.rgb=rockSample(rockColorMap).rgb;
      `);
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
        if(rockEnabled>0.5){
          vec3 sampled=rockSample(rockColorMap).rgb;
          sampled=mix(sampled/12.92,pow((sampled+0.055)/1.055,vec3(2.4)),step(vec3(0.04045),sampled));
          diffuseColor.rgb=sampled;
        }
      `);
      shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>',`#include <roughnessmap_fragment>
        if(rockEnabled>0.5)roughnessFactor=mix(roughnessFactor,rockSample(rockRoughMap).r,rockStrength);
      `);
      shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
        if(rockEnabled>0.5){
          vec3 base=rockSurfaceNormal(),p=rockPosition/rockSize,w=rockWeights(),sgn=sign(base);
          vec3 faceView=normalize(mat3(viewMatrix)*base);
          if(dot(faceView,normal)<0.0)faceView=-faceView;
          normal=faceView;
          vec3 nx=rockTileNormal(p.yz),ny=rockTileNormal(p.xz),nz=rockTileNormal(p.xy);
          vec3 perturb=vec3(0.0,nx.x,nx.y)*w.x*sgn.x+vec3(ny.x,0.0,ny.y)*w.y*sgn.y+vec3(nz.x,nz.y,0.0)*w.z*sgn.z;
          if(rockParallel>0.5){
            float layerHeight=rockLayerHeight();
            float ridge=sin(layerHeight*6.2831853);
            vec3 rockDx=dFdx(rockPosition),rockDy=dFdy(rockPosition);
            vec3 rockCrossX=cross(rockDy,base),rockCrossY=cross(base,rockDx);float rockDet=dot(rockDx,rockCrossX);
            vec3 gradient=sign(rockDet)*(dFdx(ridge)*rockCrossX+dFdy(ridge)*rockCrossY)/max(abs(rockDet),0.000001);
            normal=normalize(normal-mat3(viewMatrix)*gradient*rockBump*rockLayerSpacing*.08);
          }else normal=normalize(normal+mat3(viewMatrix)*perturb*rockBump);
        }
      `);
    };
    material.customProgramCacheKey=()=>key+'|rock-triplanar-v6-original-image-color';material.needsUpdate=true;
    record={uniforms};materials.set(material,record);return record;
  }
  function apply(material,enabled,model){
    const settings=normalize(model?.rockSettings),asset=ready&&settings.mode!=='off'?loadAsset(settings.asset):null;
    const active=enabled&&asset?.ready&&settings.mode!=='off';
    if(!active&&!materials.has(material))return;
    const {uniforms}=install(material);
    if(asset?.ready){uniforms.rockColorMap.value=asset.textures.color;uniforms.rockNormalMap.value=asset.textures.normal;uniforms.rockRoughMap.value=asset.textures.roughness;}
    uniforms.rockEnabled.value=active?1:0;uniforms.rockSize.value=settings.size;uniforms.rockStrength.value=settings.strength;uniforms.rockBump.value=settings.bump;uniforms.rockMixed.value=settings.mode==='mixed'?1:0;
    uniforms.rockTint.value=settings.tint;uniforms.rockBoundaryNormals.value=settings.boundaryNormals?1:0;
    uniforms.rockParallel.value=settings.parallel?1:0;uniforms.rockLayerSpacing.value=settings.layerSpacing;uniforms.rockLayerDirection.value=settings.layerDirection*Math.PI/180;uniforms.rockLayerPhase.value=(owner(model)?.state.origin?.z||0)%settings.layerSpacing;
    const axis=settings.foldAxis*Math.PI/180,origin=owner(model)?.state.origin||{x:0,y:0};
    uniforms.rockFolded.value=settings.folded?1:0;uniforms.rockFoldAmplitude.value=settings.foldAmplitude;uniforms.rockFoldWavelength.value=settings.foldWavelength;uniforms.rockFoldAxis.value=axis;uniforms.rockFoldPhase.value=(-(origin.x||0)*Math.sin(axis)+(origin.y||0)*Math.cos(axis))%settings.foldWavelength;
    if(!settings.parallel&&catalog.find(item=>item.id===settings.asset)?.colorOnly)uniforms.rockBump.value=0;
  }
  function eligible(model){if(!model?.mesh||model.isRegisterPlane||model.isGeoImagePlane||model.geoMesh?.terrainInfo||model.isBlockModel)return false;let found=false;model.mesh.traverse(object=>{if(!object.isMesh)return;for(const material of Array.isArray(object.material)?object.material:[object.material])if(material?.isMeshStandardMaterial&&!material.map)found=true;});return found;}
  function owner(model){return Array.from(tabViewers.values()).find(viewer=>viewer.state?.models.includes(model));}
  async function assign(model,value,sameCategory=false){
    const viewer=owner(model);if(!viewer||!eligible(model))throw Error('The model is closed or does not support rock materials');
    const settings=normalize(value);if(settings.mode!=='off'){const asset=loadAsset(settings.asset);if(!asset)throw Error('Material not found');await asset.promise;}
    if(!owner(model))throw Error('Model closed');
    const targets=sameCategory?viewer.state.models.filter(other=>other.category===model.category&&eligible(other)):[model];
    for(const target of targets)target.rockSettings={...settings};
    document.querySelectorAll('.lm-rock-material').forEach(button=>{const target=viewer.state.models.find(item=>item.id===button.closest('[data-model-id]')?.dataset.modelId);if(target)button.classList.toggle('configured',normalize(target.rockSettings).mode!=='off');});
    return targets.length;
  }
  const dialog=document.createElement('dialog');dialog.id='rock-library-dialog';
  dialog.innerHTML='<header><strong>Local rock material library</strong><button type="button" data-close aria-label="Close material library">×</button></header><label>Current model<select data-model aria-label="Current model"></select></label><div class="rock-library-grid" aria-label="Rock material thumbnail"></div><div class="rock-library-options"><label>Appearance<select data-mode><option value="off">Original geological colors (Texture off) </option><option value="rock">Original image colors</option></select></label><label>Texture repeat spacing (m) <input type="number" data-size min="1" max="300" step="1"></label><label>Surface detail strength<input type="range" data-strength min="0" max="1" step="0.05"><output data-strength-value></output></label><label>Bump strength<input type="range" data-bump min="0" max="1" step="0.05"><output data-bump-value></output></label></div><p data-status role="status"></p><footer><button type="button" data-current>Apply to current model</button><button type="button" data-category>Apply to models in this category</button></footer>';
  document.body.append(dialog);let current=null,draft={...defaults},busy=false;
  const importForm=document.createElement('form');importForm.className='rock-import-form';importForm.hidden=true;
  importForm.innerHTML='<label>Material name<input data-import-name maxlength="60" required aria-label="Custom material name"></label><span data-import-file></span><div><button type="submit">Save image</button><button type="button" data-import-cancel>Cancel</button></div>';
  dialog.querySelector('.rock-library-grid').before(importForm);let importPath=null;
  importForm.querySelector('[data-import-cancel]').onclick=()=>{importForm.hidden=true;importPath=null;};
  async function pickImage(){
    if(!window.electronAPI?.importCustomMaterial){dialog.querySelector('[data-status]').textContent='Import images in the desktop application. ';return;}
    const result=await electronAPI.showOpenDialog({title:'Import a custom material image',properties:['openFile'],filters:[{name:'Material image',extensions:['jpg','jpeg','png','webp']}]});if(result.canceled||!result.filePaths?.length)return;
    importPath=result.filePaths[0];const name=importPath.split(/[\\/]/).pop();importForm.querySelector('[data-import-name]').value=name.replace(/\.[^.]+$/,'').slice(0,60);importForm.querySelector('[data-import-file]').textContent=name;importForm.hidden=false;importForm.querySelector('input').focus();
  }
  importForm.onsubmit=async event=>{event.preventDefault();if(!importPath||busy)return;busy=true;const submit=importForm.querySelector('[type=submit]');submit.disabled=true;dialog.querySelector('[data-status]').textContent='Saving image…';try{const result=await electronAPI.importCustomMaterial({filePath:importPath,name:importForm.querySelector('input').value});if(!result.ok)throw Error(result.error);await refreshCustom();draft.asset=result.data.id;draft.mode='rock';draft.bump=0;renderCatalog();controls();extraControls();importForm.hidden=true;importPath=null;dialog.querySelector('[data-status]').textContent='';}catch(error){dialog.querySelector('[data-status]').textContent='Import failed:  '+error.message;}finally{busy=false;submit.disabled=false;}};
  const materialGroups=['Sedimentary rocks','Igneous rocks','Metamorphic rocks','General rocks','Ores and mineralized rocks','Surface and cover','Artificial materials','Other images'];
  function materialGroup(item){
    const name=item.name||'',id=item.id||'';
    if(/石灰岩|白云岩|砂岩|页岩|泥岩|砾岩/.test(name)||/sandstone/.test(id))return 'Sedimentary rocks';
    if(/花岗岩|玄武岩|闪长岩|辉长岩|流纹岩|安山岩/.test(name))return 'Igneous rocks';
    if(/片麻岩|大理岩|板岩|千枚岩|片岩|石英岩/.test(name)||/marble/.test(id))return 'Metamorphic rocks';
    if(/金矿|自然金|铅|锌|钨|锡|锰|铁矿|铜矿|锡石|磷块岩|矽卡岩|云英岩/.test(name))return 'Ores and mineralized rocks';
    if(/wall|asphalt|road|satin/.test(id)||/石墙|堡墙|沥青|道路|布料/.test(name))return 'Artificial materials';
    if(/ground|terrain|riverbed|leaves|lichen/.test(id)||/地表|地面|落叶|地衣|覆盖层/.test(name))return 'Surface and cover';
    if(!item.custom||/岩石|岩壁|块石/.test(name))return 'General rocks';
    return 'Other images';
  }
  function renderCatalog(){
    const grid=dialog.querySelector('.rock-library-grid');grid.replaceChildren();const add=document.createElement('button');add.type='button';add.className='rock-import-tile';add.textContent='＋ Import image';add.onclick=()=>pickImage().catch(error=>{dialog.querySelector('[data-status]').textContent=error.message;});grid.append(add);
    const sorted=catalog.slice().sort((a,b)=>materialGroups.indexOf(materialGroup(a))-materialGroups.indexOf(materialGroup(b))||a.name.localeCompare(b.name,'zh-CN'));let previousGroup='';
    for(const item of sorted){const group=materialGroup(item);if(group!==previousGroup){const heading=document.createElement('h4');heading.className='rock-material-group';heading.textContent=group;grid.append(heading);previousGroup=group;}const button=document.createElement('button');button.type='button';button.dataset.asset=item.id;button.title=item.name;const image=document.createElement('img');image.src=item.custom?item.preview:'assets/textures/'+item.preview;image.alt=item.name;image.loading='lazy';const label=document.createElement('span');label.textContent=item.name;button.append(image,label);button.onclick=()=>{draft.asset=item.id;if(draft.mode==='off')draft.mode='rock';controls();extraControls();};if(item.custom){const card=document.createElement('div');card.className='rock-material-card';const remove=document.createElement('button');remove.type='button';remove.className='rock-material-delete';remove.textContent='×';remove.title='Delete custom material, Models using it revert to their original colors';remove.setAttribute('aria-label','Delete '+item.name);remove.dataset.deleteAsset=item.id;remove.onclick=async event=>{event.stopPropagation();if(busy)return;busy=true;remove.disabled=true;try{await removeCustom(item.id);dialog.querySelector('[data-status]').textContent='';}catch(error){dialog.querySelector('[data-status]').textContent='Delete failed:  '+error.message;}finally{busy=false;remove.disabled=false;}};card.append(button,remove);grid.append(card);}else grid.append(button);}
  }
  async function removeCustom(id){
    const item=catalog.find(item=>item.id===id&&item.custom);if(!item)throw Error('Only user-imported images can be deleted');
    const result=await electronAPI.deleteCustomMaterial(id);if(!result.ok)throw Error(result.error);
    for(const viewer of tabViewers.values()){for(const model of viewer.state?.models||[])if(model.rockSettings?.asset===id)model.rockSettings={...model.rockSettings,mode:'off',asset:defaults.asset};if(viewer.scene&&viewer.state)window.presentationMode?.apply(viewer.scene,viewer.state);}
    const asset=assets.get(id);assets.delete(id);if(asset)asset.promise.then(()=>Object.values(asset.textures).forEach(texture=>texture.dispose())).catch(()=>{});
    await refreshCustom();if(draft.asset===id){draft.asset=defaults.asset;draft.mode='off';}renderCatalog();controls();extraControls();
    document.querySelectorAll('.lm-rock-material').forEach(button=>{const id=button.closest('[data-model-id]')?.dataset.modelId;const model=Array.from(tabViewers.values()).flatMap(viewer=>viewer.state?.models||[]).find(model=>model.id===id);if(model)button.classList.toggle('configured',normalize(model.rockSettings).mode!=='off');});
  }
  dialog.querySelector('[data-size]').max='2000';
  dialog.querySelector('.rock-library-options').insertAdjacentHTML('beforeend','<label>Correct shading along flat boundaries<input type="checkbox" data-boundary-normals></label><button type="button" data-recommend-size>Recommend texture size from the model</button>');
  function recommendedSize(model){const box=new THREE.Box3().setFromObject(model.mesh),size=box.getSize(new THREE.Vector3());return Math.max(1,Math.min(2000,Math.round(Math.max(size.x,size.y,size.z)/10)));}
  dialog.querySelector('.rock-library-options').insertAdjacentHTML('beforeend','<label>Parallel bedding<input type="checkbox" data-parallel></label><label>Bedding spacing (m) <input type="number" data-layer-spacing min="0.1" max="2000" step="0.1"></label><label>Horizontal texture direction (°) <input type="number" data-layer-direction min="0" max="360" step="5"></label>');
  dialog.querySelector('[data-parallel]').onchange=e=>{draft.parallel=e.target.checked;extraControls();};
  dialog.querySelector('[data-layer-spacing]').onchange=e=>{draft.layerSpacing=Math.max(.1,Math.min(2000,Number(e.target.value)||10));extraControls();};
  dialog.querySelector('[data-layer-direction]').onchange=e=>{draft.layerDirection=Math.max(0,Math.min(360,Number(e.target.value)||0));extraControls();};
  dialog.querySelector('[data-parallel]').parentElement.firstChild.textContent='Enable bedding';
  dialog.querySelector('.rock-library-options').insertAdjacentHTML('beforeend','<label>Bedding style<select data-layer-style><option value="parallel">Parallel</option><option value="folded">Folded</option></select></label><label data-fold-control>Fold amplitude (m) <input type="number" data-fold-amplitude min="0" max="2000" step="1"></label><label data-fold-control>Fold wavelength (m) <input type="number" data-fold-wavelength min="1" max="10000" step="5"></label><label data-fold-control>Fold axis direction (°) <input type="number" data-fold-axis min="0" max="360" step="5"></label>');
  dialog.querySelector('[data-layer-style]').onchange=e=>{draft.folded=e.target.value==='folded';draft.parallel=true;extraControls();};
  for(const [attribute,key,min,max] of [['fold-amplitude','foldAmplitude',0,2000],['fold-wavelength','foldWavelength',1,10000],['fold-axis','foldAxis',0,360]])dialog.querySelector('[data-'+attribute+']').onchange=e=>{draft[key]=Math.max(min,Math.min(max,Number(e.target.value)||min));extraControls();};
  const syncLayerControls=()=>{dialog.querySelector('[data-layer-style]').value=draft.folded?'folded':'parallel';dialog.querySelector('[data-layer-style]').disabled=!draft.parallel;for(const [attribute,key] of [['fold-amplitude','foldAmplitude'],['fold-wavelength','foldWavelength'],['fold-axis','foldAxis']]){const input=dialog.querySelector('[data-'+attribute+']');input.value=draft[key];input.parentElement.style.display=draft.folded?'':'none';input.disabled=!draft.parallel;}};
  function extraControls(){syncLayerControls();dialog.querySelector('[data-boundary-normals]').checked=draft.boundaryNormals;dialog.querySelector('[data-parallel]').checked=draft.parallel;dialog.querySelector('[data-layer-spacing]').value=draft.layerSpacing;dialog.querySelector('[data-layer-direction]').value=draft.layerDirection;dialog.querySelector('[data-layer-spacing]').disabled=dialog.querySelector('[data-layer-direction]').disabled=!draft.parallel;const colorOnly=!!catalog.find(item=>item.id===draft.asset)?.colorOnly&&!draft.parallel;dialog.querySelector('[data-bump]').disabled=colorOnly;if(colorOnly){dialog.querySelector('[data-bump]').value=0;dialog.querySelector('[data-bump-value]').textContent='0.00';}}
  function controls(){dialog.querySelector('[data-mode]').value=draft.mode;dialog.querySelector('[data-size]').value=draft.size;for(const key of ['strength','bump']){dialog.querySelector('[data-'+key+']').value=draft[key];dialog.querySelector('[data-'+key+'-value]').textContent=draft[key].toFixed(2);}dialog.querySelectorAll('[data-asset]').forEach(button=>{button.classList.toggle('selected',button.dataset.asset===draft.asset);button.setAttribute('aria-pressed',String(button.dataset.asset===draft.asset));});}
  function choose(model){current=model;draft=normalize(model.rockSettings);if(!model.rockSettings)draft.size=recommendedSize(model);controls();extraControls();dialog.querySelector('[data-status]').textContent='';}
  async function open(model){
    await catalogReady;await refreshCustom();importForm.hidden=true;importPath=null;const viewer=model?owner(model):tabViewers.get(activeTabId),models=viewer?.state?.models.filter(eligible)||[];
    const selector=dialog.querySelector('[data-model]');selector.replaceChildren();for(const item of models){const option=document.createElement('option');option.value=item.id;option.textContent=item.displayName||item.fileName||item.name;selector.append(option);}
    renderCatalog();
    if(models.length){selector.value=(model&&models.includes(model)?model:models[0]).id;choose(models.find(item=>item.id===selector.value));}else{current=null;dialog.querySelector('[data-status]').textContent='The current view has no supported geological, geochemical or tunnel models. ';}
    selector.onchange=()=>choose(models.find(item=>item.id===selector.value));for(const button of dialog.querySelectorAll('footer button'))button.disabled=!current;
    if(!dialog.open)dialog.showModal();
  }
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  dialog.querySelector('[data-mode]').onchange=e=>{draft.mode=e.target.value;};
  dialog.querySelector('[data-boundary-normals]').onchange=e=>{draft.boundaryNormals=e.target.checked;};
  dialog.querySelector('[data-recommend-size]').onclick=()=>{if(current){draft.size=recommendedSize(current);controls();}};
  for(const key of ['size','strength','bump'])dialog.querySelector('[data-'+key+']').oninput=e=>{draft[key]=Number(e.target.value);if(key!=='size')dialog.querySelector('[data-'+key+'-value]').textContent=draft[key].toFixed(2);};
  async function commit(same){if(!current||busy)return;busy=true;dialog.querySelectorAll('footer button').forEach(button=>button.disabled=true);dialog.querySelector('[data-status]').textContent='Loading local materials…';try{const count=await assign(current,draft,same);dialog.querySelector('[data-status]').textContent='';if(!same)dialog.close();}catch(error){dialog.querySelector('[data-status]').textContent='Apply failed:  '+error.message;}finally{busy=false;dialog.querySelectorAll('footer button').forEach(button=>button.disabled=false);}}
  dialog.querySelector('[data-current]').onclick=()=>commit(false);dialog.querySelector('[data-category]').onclick=()=>commit(true);
  function mount(model,row){if(!eligible(model)||row.querySelector('.lm-rock-material'))return;const button=document.createElement('button');button.type='button';button.className='lm-rock-material';button.textContent='Material';button.title='Choose rock material';button.classList.toggle('configured',normalize(model.rockSettings).mode!=='off');button.onpointerdown=e=>e.stopPropagation();button.onmousedown=e=>e.stopPropagation();button.onclick=e=>{e.stopPropagation();open(model).catch(error=>console.warn(error));};row.querySelector('.lm-color')?.before(button);}
  window.rockTexture={apply,mount,open,assign,normalize,eligible,loadAsset,removeCustom,get ready(){return ready;},get catalog(){return catalog.slice();}};
  // Layer rows can already exist when this script finishes loading.
  catalogReady.then(()=>{for(const viewer of tabViewers.values())for(const model of viewer.state?.models||[])document.querySelectorAll('.lm-item').forEach(row=>{if(row.dataset.modelId===model.id)mount(model,row);});});
})();
