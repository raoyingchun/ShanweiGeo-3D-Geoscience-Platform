'use strict';
const imageAppearanceUniforms=new WeakMap();
const terrainCropUniforms=new WeakMap();
function normalizeImageAppearance(value){const result={brightness:1.08,shadows:.08,saturation:1.1};for(const [key,min,max] of [['brightness',.5,2],['shadows',0,.4],['saturation',0,2]])if(Number.isFinite(value?.[key]))result[key]=Math.max(min,Math.min(max,value[key]));return result;}
function installImageAppearance(model,material,terrain){
  model.imageAppearance=normalizeImageAppearance(model.imageAppearance);
  const values=imageAppearanceUniforms.get(material)||{value:new THREE.Vector3()};values.value.set(model.imageAppearance.brightness,model.imageAppearance.shadows,model.imageAppearance.saturation);const previous=material.onBeforeCompile;
  imageAppearanceUniforms.set(material,values);material.toneMapped=false;
  material.onBeforeCompile=(shader,targetRenderer)=>{
    previous(shader,targetRenderer);shader.uniforms.imageAppearance=values;shader.uniforms.imageOutputEncoded={value:targetRenderer.outputEncoding===THREE.LinearEncoding?1:0};
    shader.fragmentShader='uniform vec3 imageAppearance; uniform float imageOutputEncoded;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <output_fragment>',`#ifdef USE_MAP
      vec3 imageLinear=${terrain?'terrainTexel.rgb':'diffuseColor.rgb'};
      vec3 imageDisplay=LinearTosRGB(vec4(imageLinear,1.0)).rgb;
      float imageLuma=dot(imageDisplay,vec3(0.2126,0.7152,0.0722));
      imageDisplay+=(1.0-imageDisplay)*imageAppearance.y*pow(1.0-imageLuma,2.0);
      imageDisplay=clamp(mix(vec3(dot(imageDisplay,vec3(0.2126,0.7152,0.0722))),imageDisplay,imageAppearance.z)*imageAppearance.x,0.0,1.0);
      vec3 imageOutput=mix(sRGBToLinear(vec4(imageDisplay,1.0)).rgb,imageDisplay,imageOutputEncoded);
      outgoingLight=mix(outgoingLight,imageOutput,${terrain?'terrainCoverage':'1.0'});
      #endif
      #include <output_fragment>`);
  };
}
function renderTerrainImageAppearance(model,host){
  if(!model.terrainImage)return;const settings=normalizeImageAppearance(model.imageAppearance),panel=document.createElement('div');panel.className='rp-section';panel.innerHTML='<div class="rp-section-title">Imagery display</div>';
  for(const [key,label,min,max,step] of [['brightness','Brightness',.5,2,.05],['shadows','Lift shadows',0,.4,.01],['saturation','Saturation',0,2,.05]]){const row=document.createElement('label');row.style.cssText='display:flex;align-items:center;gap:8px;margin:8px 0;font-size:12px';row.textContent=label;const input=document.createElement('input');input.type='range';input.min=min;input.max=max;input.step=step;input.value=settings[key];input.style.cssText='width:100px;min-width:50px';input.dataset.imageAppearance=key;const output=document.createElement('output');output.textContent=settings[key].toFixed(2);input.oninput=()=>{model.imageAppearance=Object.assign(normalizeImageAppearance(model.imageAppearance),{[key]:Number(input.value)});const next=model.imageAppearance;imageAppearanceUniforms.get(model.material)?.value.set(next.brightness,next.shadows,next.saturation);output.textContent=Number(input.value).toFixed(2);};row.append(input,output);panel.append(row);}
  for(const [label,values] of [['Original colors',{brightness:1,shadows:0,saturation:1}],['Natural enhancement',normalizeImageAppearance(null)]]){const button=document.createElement('button');button.textContent=label;button.style.marginRight='8px';button.onclick=()=>{model.imageAppearance={...values};imageAppearanceUniforms.get(model.material)?.value.set(values.brightness,values.shadows,values.saturation);panel.querySelectorAll('input').forEach(input=>{input.value=values[input.dataset.imageAppearance];input.nextElementSibling.textContent=Number(input.value).toFixed(2);});};panel.append(button);}host.append(panel);
}
function parseWorldFile(text){
  const values=text.replace(/^\uFEFF/,'').trim().split(/\s+/).map(Number);
  if(values.length!==6||values.some(v=>!Number.isFinite(v))||Math.abs(values[0]*values[3]-values[1]*values[2])<1e-20)throw new Error('The world file requires 6 valid coordinate parameters. ');return values;
}
function manualRegistrationCoordinates(registration){
  const transform=registration.transform,x=transform?.x,y=transform?.y;
  if(!x||!y||[x.a,x.b,x.c,y.a,y.b,y.c].some(value=>!Number.isFinite(value)))throw new Error('Invalid manual registration transform, Register again. ');
  const determinant=x.a*y.b-x.b*y.a,scale=Math.max(Math.abs(x.a*y.b),Math.abs(x.b*y.a),1e-20);
  if(Math.abs(determinant)<=scale*1e-12)throw new Error('Manual registration cannot resolve horizontal positions, control-point model X/Y must not be collinear. ');
  const width=registration.imageWidth,height=registration.imageHeight;
  if(!(width>0&&height>0))throw new Error('The old registration record has no image pixel dimensions, Verify the registration again before draping. ');
  return {world:[x.a,y.a,x.b,y.b,x.c+(x.a+x.b)/2,y.c+(y.a+y.b)/2],width,height};
}
function terrainImageUV(geo,world,width,height){
  const [a,d,b,e,c,f]=world,det=a*e-b*d,uv=new Float32Array(geo.vertices.length/3*2);let inside=0;
  for(let i=0;i<geo.vertices.length;i+=3){const x=geo.vertices[i]-c,y=-geo.vertices[i+2]-f,col=(e*x-b*y)/det,row=(-d*x+a*y)/det,u=(col+.5)/width,v=1-(row+.5)/height;uv[i/3*2]=u;uv[i/3*2+1]=v;if(u>=0&&u<=1&&v>=0&&v<=1)inside++;}
  if(!inside)throw new Error('The imagery and elevation extents do not overlap. Make sure both use the model\'s X North, Y Zone 37 Zone-prefixed easting. ');return {uv,inside,total:uv.length/2};
}
function geoImagePlaneGeometry(metadata){
  const [a,d,b,e,c,f]=metadata.world,w=metadata.width,h=metadata.height,z=metadata.elevation||0;
  const vertices=[],xs=[],ys=[];
  for(const [col,row] of [[-.5,-.5],[w-.5,-.5],[w-.5,h-.5],[-.5,h-.5]]){const x=a*col+b*row+c,y=d*col+e*row+f;xs.push(x);ys.push(y);vertices.push(x,z,-y);}
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  return {name:metadata.fileName,vertices:new Float64Array(vertices),indices:new Uint32Array([0,1,2,0,2,3]),boundingBox:[minX,minY,z,maxX,maxY,z],vertexCount:4,triangleCount:2,fileOrigin:{x:(minX+maxX)/2,y:(minY+maxY)/2,z},source:{fileName:metadata.fileName}};
}
function applyGeoImagePlaneTexture(model,texture){
  model.mesh.geometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,1,1,1,1,0,0,0],2));
  const previous=model.material;model.material=new THREE.MeshBasicMaterial({map:texture,color:0xffffff,transparent:true,opacity:model.opacity,side:THREE.DoubleSide,depthTest:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2});
  if(previous?.clippingPlanes)model.material.clippingPlanes=previous.clippingPlanes;
  installImageAppearance(model,model.material,false);model.material.customProgramCacheKey=()=> 'geo-image-display-v2';
  model.mesh.material=model.material;previous?.dispose();model.geoImageTexture=texture;
}
async function displayGeoImagePlane(drawing,bytes){
  if(window.researchRegionViews)await researchRegionViews.ensure(drawing.regionId);
  const existing=state.models.find(model=>model.isGeoImagePlane&&model.geoImagePlaneSource?.filePath===drawing.filePath&&model.geoImagePlaneSource?.fileName===drawing.fileName);
  if(existing){if(!existing.inScene)addModelToView(existing);existing.visible=true;existing.mesh.visible=true;focusModel(existing);return existing;}
  const decoded=await decodeTerrainImage(bytes,drawing.fileName,2048,drawing.filePath);
  let world=drawing.terrainImageSource?.world||decoded.world;
  if(!world&&drawing.filePath){for(const ext of ['tfw','pgw','jgw','wld']){const result=await electronAPI.readProjectFile(drawing.filePath.replace(/\.[^.]+$/,'.'+ext));if(result?.ok){world=parseWorldFile(new TextDecoder().decode(base64ToBytes(result.data)));break;}}}
  if(!world){decoded.texture.dispose();return null;}
  const metadata={fileName:drawing.fileName,filePath:drawing.filePath||null,world,width:decoded.width,height:decoded.height,elevation:0,textureMaxSize:2048};
  if(!metadata.filePath){let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));metadata.base64=btoa(binary);}
  const geo=geoImagePlaneGeometry(metadata),model=loadModelToScene(geo,'Remote Sensing Imagery',drawing.fileName+'  (Remote Sensing Imagery) ',{regionId:drawing.regionId,filePath:drawing.filePath||null,skipTreeNode:true,color:0xffffff,opacity:1});
  if(!model){decoded.texture.dispose();return null;}
  model.isGeoImagePlane=true;model.isRegisterPlane=true;model.geoImagePlaneSource=metadata;model.drawingKey=drawing.id;applyGeoImagePlaneTexture(model,decoded.texture);
  drawing.terrainImageSource=Object.assign({},drawing.terrainImageSource,{world,width:decoded.width,height:decoded.height,hasCoordinates:true});
  const image=decoded.texture.image,scaleX=decoded.width/image.width,scaleY=decoded.height/image.height;
  drawingRegisters[drawing.id]={key:drawing.id,done:true,autoCoordinates:true,fileName:drawing.fileName,fileUrl:image.toDataURL('image/png'),planeModelId:model.id,planeTabId:activeTabId,transform:{x:{a:world[0]*scaleX,b:world[2]*scaleY,c:world[4]-(world[0]+world[2])/2},y:{a:world[1]*scaleX,b:world[3]*scaleY,c:world[5]-(world[1]+world[3])/2},z:{a:0,b:0,c:0}}};
  rebuildLayerManagement();refreshDrawingRegButtons();focusModel(model);return model;
}
async function restoreGeoImagePlane(model,read){
  const meta=model.geoImagePlaneSource,bytes=meta.filePath&&window.electronAPI?.preprocessImage?new Uint8Array():meta.filePath?await read(meta.filePath,meta.fileName):meta.base64?base64ToBytes(meta.base64):null;if(!bytes)throw new Error('Remote Sensing Imagery Plane Source files Cannot be read:  '+meta.fileName);
  const decoded=await decodeTerrainImage(bytes,meta.fileName,meta.textureMaxSize||2048,meta.filePath);applyGeoImagePlaneTexture(model,decoded.texture);
}
function readTiffCoordinates(bytes){
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),le=v.getUint16(0,false)===0x4949;
  if(v.getUint16(2,le)!==42)throw new Error('This TIFF Also select the associated.tfw Coordinate file. ');
  const start=v.getUint32(4,le),count=v.getUint16(start,le),tags={};
  for(let i=0;i<count;i++){const p=start+2+i*12,tag=v.getUint16(p,le),type=v.getUint16(p+2,le),n=v.getUint32(p+4,le),size=({3:2,4:4,12:8})[type];if(![256,257,33550,33922,34264,34735].includes(tag)||!size)continue;if(n>4096)throw new Error('TIFF Coordinate labels are too large. ');const offset=n*size<=4?p+8:v.getUint32(p+8,le);tags[tag]=Array.from({length:n},(_,j)=>type===12?v.getFloat64(offset+j*size,le):type===3?v.getUint16(offset+j*size,le):v.getUint32(offset+j*size,le));}
  let world=null;if(tags[34264]?.length===16){const m=tags[34264];world=[m[0],m[4],m[1],m[5],m[3]+(m[0]+m[1])/2,m[7]+(m[4]+m[5])/2];}
  else if(tags[33550]&&tags[33922]){const [a,e]=tags[33550],t=tags[33922];world=[a,0,0,-e,t[3]-t[0]*a+a/2,t[4]+t[1]*e-e/2];}
  const keys=tags[34735];if(world&&keys)for(let i=4;i+3<keys.length;i+=4)if(keys[i]===1025&&keys[i+3]===2){world[4]-=(world[0]+world[2])/2;world[5]-=(world[1]+world[3])/2;}
  return {world,width:tags[256]?.[0],height:tags[257]?.[0]};
}
function terrainTextureSize(width,height,quality=2048,gpuLimit=4096){
  if(![2048,4096,8192].includes(quality))quality=2048;
  const limit=Math.min(quality,gpuLimit),scale=Math.min(1,limit/width,limit/height);
  return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};
}
async function decodeTerrainImage(bytes,fileName,quality=2048,filePath=null){
  let data=bytes,meta={},mime=/\.jpe?g$/i.test(fileName)?'image/jpeg':/\.webp$/i.test(fileName)?'image/webp':'image/png';
  if(filePath&&window.electronAPI?.preprocessImage){const result=await electronAPI.preprocessImage({filePath,quality,gpuLimit:renderer.capabilities.maxTextureSize||4096});if(!result.ok)throw new Error(result.error);meta=result;data=result.data;mime='image/png';}
  else if(/\.tiff?$/i.test(fileName)){try{meta=readTiffCoordinates(bytes);}catch(error){meta.error=error.message;}if(!window.electronAPI?.decodeTiffPreview)throw new Error('Restart the desktop application to enable TIFF Decode. ');const result=await electronAPI.decodeTiffPreview(bytes);if(!result.ok)throw new Error(result.error);data=result.data;mime='image/png';}
  const url=URL.createObjectURL(new Blob([data],{type:mime}));
  try{const image=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('Image decoding failed. '));img.src=url;});
    if(/\.tiff?$/i.test(fileName)&&(!meta.width||!meta.height))throw new Error('Unable to read TIFF Original grid dimensions, Save the image as a standard GeoTIFF or PNG with a world file. ');
    const size=terrainTextureSize(image.width,image.height,quality,renderer.capabilities.maxTextureSize||4096),canvas=document.createElement('canvas');canvas.width=size.width;canvas.height=size.height;canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    const texture=new THREE.CanvasTexture(canvas);texture.encoding=THREE.sRGBEncoding;texture.anisotropy=Math.min(2,renderer.capabilities.getMaxAnisotropy());return {texture,width:meta.width||image.width,height:meta.height||image.height,world:meta.world,error:meta.error};
  }finally{URL.revokeObjectURL(url);}
}
async function attachTerrainImage(model,bytes,metadata){
  const decoded=await decodeTerrainImage(bytes,metadata.fileName,metadata.textureMaxSize||2048,metadata.filePath);
  try{const manual=metadata.manualRegistration?manualRegistrationCoordinates(metadata.manualRegistration):null;
    const world=manual?.world||metadata.world||decoded.world;if(!world)throw new Error(decoded.error||'Image has no georeferencing, Register the image manually or select its matching world file first. ');const width=manual?.width||metadata.width||decoded.width,height=manual?.height||metadata.height||decoded.height,mapping=terrainImageUV(model.geoMesh,world,width,height),previous=model.terrainTexture;
    model.terrainTexture=decoded.texture;model.terrainImage=Object.assign({},metadata,{world,width,height,insideVertices:mapping.inside,totalVertices:mapping.total});model.mesh.geometry.setAttribute('uv',new THREE.Float32BufferAttribute(mapping.uv,2));applyTerrainDisplay(model,Object.assign({},model.terrainSettings,{colorMode:'image'}));if(previous)previous.dispose();
  }catch(error){decoded.texture.dispose();throw error;}
}
function terrainImageCropBounds(target){
  if(Array.isArray(target)){
    const bounds=target.map(model=>{try{const b=terrainImageCropBounds(model);return [b.minX,b.minY,0,b.maxX,b.maxY,0];}catch{return null;}}).filter(Boolean);
    if(!bounds.length)throw new Error('Import a 3D model with a valid horizontal extent first. ');
    return {minX:Math.min(...bounds.map(b=>b[0])),minY:Math.min(...bounds.map(b=>b[1])),maxX:Math.max(...bounds.map(b=>b[3])),maxY:Math.max(...bounds.map(b=>b[4])),targetName:'All 3D models',modelCount:bounds.length};
  }
  // Source vertices use Three axes (X, elevation, -Y). Importers do not
  // share a boundingBox layout, so derive horizontal limits from vertices.
  const vertices=target?.geoMesh?.vertices;
  if(vertices?.length>=3){
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(let i=0;i<vertices.length;i+=3){const x=vertices[i],y=-vertices[i+2];if(!Number.isFinite(x)||!Number.isFinite(y))continue;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
    if(maxX>minX&&maxY>minY)return {minX,minY,maxX,maxY,targetName:target.displayName||target.fileName||'3D Models'};
    throw new Error('The model has no valid XY Horizontal extent. ');
  }
  const b=target?.geoMesh?.boundingBox;
  if(!b||b.length!==6||![b[0],b[1],b[3],b[4]].every(Number.isFinite)||b[3]<=b[0]||b[4]<=b[1])throw new Error('The selected model has no valid horizontal extent. ');
  return {minX:b[0],minY:b[1],maxX:b[3],maxY:b[4],targetName:target.displayName||target.fileName||'3D Models'};
}
function mountTerrainImageCrop(model,item){
  if(!model.terrainImage||item.querySelector('.lm-image-crop'))return;
  const button=document.createElement('button');button.type='button';button.className='lm-image-crop';
  button.style.cssText='font:inherit;font-size:12px;padding:3px 7px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:5px;cursor:pointer;flex-shrink:0';
  function sync(){button.textContent=model.terrainImage.crop?'Restore':'Crop';button.title=model.terrainImage.crop?'Restore full imagery extent':'Clip to the horizontal extent of all models in the current view';}
  sync();button.addEventListener('pointerdown',event=>event.stopPropagation());
  button.addEventListener('mousedown',event=>event.stopPropagation());button.onclick=event=>{
    event.stopPropagation();const viewer=Array.from(tabViewers.values()).find(v=>v.state?.models.includes(model));
    const targets=(viewer?.state.models||[]).filter(m=>m!==model&&!m.geoMesh?.terrainInfo&&!m.isRegisterPlane&&!m.isGeoImagePlane&&m.geoMesh?.triangleCount>0);
    try{
      if(model.terrainImage.crop)delete model.terrainImage.crop;
      else{const bounds=terrainImageCropBounds(targets),terrain=terrainImageCropBounds(model);if(bounds.maxX<=terrain.minX||bounds.minX>=terrain.maxX||bounds.maxY<=terrain.minY||bounds.minY>=terrain.maxY)throw new Error('of the area containing the 3D model and imagery XY Horizontal extents do not overlap, Check the horizontal coordinates. ');model.terrainImage.crop=bounds;}
      configureTerrainImageMaterial(model);sync();
    }catch(error){alert(error.message);}
  };item.insertBefore(button,item.querySelector('.lm-color'));
}
function configureTerrainImageMaterial(model){
  const material=model.material,active=model.terrainSettings?.colorMode==='image'&&!!model.terrainTexture;material.map=active?model.terrainTexture:null;
  const cropValues=terrainCropUniforms.get(material)||{enabled:{value:0},bounds:{value:new THREE.Vector4()}};
  const currentCrop=model.terrainImage?.crop;cropValues.enabled.value=currentCrop?1:0;cropValues.bounds.value.set(currentCrop?.minX||0,currentCrop?.minY||0,currentCrop?.maxX||0,currentCrop?.maxY||0);terrainCropUniforms.set(material,cropValues);
  // only the terrain surfaces that carry imagery are adjusted, while the ordinary geological models keep their existing depth and ordering settings.
  material.polygonOffset=active;
  material.polygonOffsetFactor=active?-4:0;
  material.polygonOffsetUnits=active?-4:0;
  if(active){material.vertexColors=true;material.color.set(0xffffff);material.onBeforeCompile=shader=>{
    // Render-only clearance for a draped image. Keep source vertices, elevation,
    // picking geometry and geological model materials unchanged.
    const cellSize=Number(model.geoMesh?.terrainInfo?.cellsize)||10;
    shader.uniforms.terrainImageSurfaceLift={value:Math.min(2,Math.max(.25,cellSize*.05))};
    shader.vertexShader='uniform float terrainImageSurfaceLift;\n'+(shader.vertexShader||'');
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed.y += terrainImageSurfaceLift;');
    const crop=model.terrainImage?.crop,world=model.terrainImage?.world||[1,0,0,1,0,0];
    shader.uniforms.terrainCropEnabled=cropValues.enabled;shader.uniforms.terrainCropBounds=cropValues.bounds;
    shader.uniforms.terrainImageAffine={value:new THREE.Vector4(world[0],world[1],world[2],world[3])};shader.uniforms.terrainImageOrigin={value:new THREE.Vector2(world[4],world[5])};shader.uniforms.terrainImageSize={value:new THREE.Vector2(model.terrainImage?.width||1,model.terrainImage?.height||1)};
    shader.fragmentShader='uniform float terrainCropEnabled; uniform vec4 terrainCropBounds; uniform vec4 terrainImageAffine; uniform vec2 terrainImageOrigin; uniform vec2 terrainImageSize;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#ifdef USE_MAP
      vec4 terrainTexel=mapTexelToLinear(texture2D(map,vUv));
      float terrainCoverage=step(0.0,vUv.x)*step(vUv.x,1.0)*step(0.0,vUv.y)*step(vUv.y,1.0)*terrainTexel.a;
      vec2 terrainPixel=vec2(vUv.x,1.0-vUv.y)*terrainImageSize-0.5;
      vec2 terrainXY=terrainImageOrigin+terrainImageAffine.xy*terrainPixel.x+terrainImageAffine.zw*terrainPixel.y;
      float terrainCropMask=step(terrainCropBounds.x,terrainXY.x)*step(terrainXY.x,terrainCropBounds.z)*step(terrainCropBounds.y,terrainXY.y)*step(terrainXY.y,terrainCropBounds.w);
      if(terrainCropEnabled>0.5&&terrainCropMask<0.5)discard;
      terrainCoverage*=mix(1.0,terrainCropMask,terrainCropEnabled);
      vec3 terrainBase=diffuseColor.rgb;
      #ifdef USE_COLOR
      terrainBase*=vColor;
      #endif
      diffuseColor.rgb=mix(terrainBase,terrainTexel.rgb,terrainCoverage);
      #endif`).replace('#include <color_fragment>','');};}
  else material.onBeforeCompile=()=>{};
  if(active)installImageAppearance(model,material,true);else{material.toneMapped=true;imageAppearanceUniforms.delete(material);}
  // A cached program retains its old uniforms unless it is rebuilt. Include
  // the crop snapshot so a click cannot silently reuse the uncropped program.
  const cropKey=JSON.stringify(model.terrainImage?.crop||null);
  material.customProgramCacheKey=()=>active?'terrain-image-display-v6-surface-clearance:'+cropKey:'terrain-colors-v1';material.needsUpdate=true;
}
async function restoreTerrainImage(model,read){
  if(!model.terrainImage)return;const meta=model.terrainImage,settings=Object.assign({},model.terrainSettings),bytes=meta.filePath&&window.electronAPI?.preprocessImage?new Uint8Array():meta.filePath?await read(meta.filePath,meta.fileName):meta.base64?base64ToBytes(meta.base64):null;if(!bytes)throw new Error('The source imagery texture cannot be read:  '+meta.fileName);await attachTerrainImage(model,bytes,meta);applyTerrainDisplay(model,settings);
}
if(typeof module!=='undefined'&&module.exports)module.exports={parseWorldFile,terrainImageUV,readTiffCoordinates,terrainTextureSize,geoImagePlaneGeometry,manualRegistrationCoordinates};
if(typeof document!=='undefined'){
  (function(){
    const root=document.getElementById('subitems-surface');if(!root)return;
    const input=document.createElement('input');input.type='file';input.multiple=true;input.accept='.tif,.tiff,.png,.jpg,.jpeg,.webp,.tfw,.pgw,.jgw,.wld';input.hidden=true;input.id='terrain-image-input';document.body.append(input);
    const dialog=document.createElement('dialog');dialog.id='terrain-image-dialog';dialog.style.cssText='padding:20px;border:1px solid #aaa;border-radius:8px;max-width:480px';
    dialog.innerHTML='<h3>Drape imagery over terrain</h3><p id="terrain-image-name"></p><label>Target terrain <select id="terrain-image-target"></select></label><label style="display:block;margin-top:10px">Texture resolution <select id="terrain-image-quality"><option value="2048">Fast (2048, Default) </option><option value="4096">High resolution (4096) </option><option value="8192">Ultra (8192, High GPU memory usage) </option></select></label><p>Drape over terrain using the image georeferencing, No zone prefix or axis swap is applied automatically. </p><button id="terrain-image-apply">Drape over selected terrain</button> <button id="terrain-image-close">Close</button><p id="terrain-image-status" role="status"></p>';document.body.append(dialog);let working=false,selectedDrawing=null;
    function open(drawingId){
      selectedDrawing=state.drawings[drawingId];if(!selectedDrawing)return;
      const select=dialog.querySelector('#terrain-image-target');select.replaceChildren();
      state.models.filter(m=>m.inScene!==false&&m.geoMesh?.terrainInfo).forEach(model=>{const option=document.createElement('option');option.value=model.id;option.textContent=model.displayName||model.fileName;select.append(option);});
      if(!select.options.length){alert('Image imported. Import first ASC Elevation, then choose Drape. ');return;}
      if(state.selectedModelId&&Array.from(select.options).some(o=>o.value===state.selectedModelId))select.value=state.selectedModelId;
      dialog.querySelector('#terrain-image-name').textContent=selectedDrawing.fileName;
      const reg=drawingRegisters[selectedDrawing.id];
      dialog.querySelector('#terrain-image-status').textContent=selectedDrawing.manualRegistration||(reg?.done&&!reg.autoCoordinates)?'Use the manual registration\'s X/Y Transform; Terrain heights are defined by ASC Provide. ':'Read embedded georeferencing or the associated world file. ';if(!dialog.open)dialog.showModal();
    }
    function bindFitButtons(){
      for(const node of root.querySelectorAll('[data-drawing-id]')){
        const category=node.parentElement?.previousElementSibling;
        if(!isSurfaceImageryCategory(category)||node.querySelector('.lp-terrain-fit-btn'))continue;
        const button=document.createElement('button');button.className='lp-terrain-fit-btn';button.textContent='Drape';button.title='Choose whether to drape the image over elevation terrain';button.style.cssText='margin-left:auto;flex:none;font-size:11px;padding:2px 5px;cursor:pointer';
        button.onclick=event=>{event.stopPropagation();open(node.dataset.drawingId);};node.append(button);
        const drawing=state.drawings[node.dataset.drawingId];
        if(drawing?.terrainImageSource?.hasCoordinates){const regButton=node.querySelector('.lp-reg-btn');if(regButton){regButton.classList.add('registered');regButton.title='Image is georeferenced; Control-point registration can be performed again';}}
      }
    }
    root.addEventListener('dblclick',async event=>{
      const node=event.target.closest('[data-drawing-id]');
      if(!node||!isSurfaceImageryCategory(node.parentElement?.previousElementSibling)||event.target.closest('button,.lp-reg-btn'))return;
      event.preventDefault();event.stopPropagation();
      if(node._imageDisplayPending)return;node._imageDisplayPending=true;
      try{
        const drawing=state.drawings[node.dataset.drawingId];if(!drawing)return;
        const current=tabViewers.get(activeTabId);
        const target=current?.type==='3d'&&current.regionId===drawing.regionId?[activeTabId,current]:Array.from(tabViewers.entries()).find(([,viewer])=>viewer.type==='3d'&&!viewer.isVector2D&&viewer.regionId===drawing.regionId);
        // Displaying an image must not create an otherwise empty regional 3D tab.
        if(!target){await openDrawingInNewTab(node);return;}
        await window.switchTab(target[0]);if(activeTabId!==target[0])return;
        const registered=state.models.find(model=>model.isRegisterPlane&&model.fileName===drawing.fileName+'  (Texture) ');
        if(registered){if(!registered.inScene)addModelToView(registered);registered.visible=true;registered.mesh.visible=true;focusModel(registered);return;}
        let bytes;if(drawing.filePath&&window.electronAPI?.preprocessImage)bytes=new Uint8Array();else if(drawing.blob)bytes=new Uint8Array(await drawing.blob.arrayBuffer());else{const result=await electronAPI.readProjectFile(drawing.filePath);if(!result?.ok)throw new Error(result?.error||'Image cannot be read');bytes=base64ToBytes(result.data);}
        const plane=await displayGeoImagePlane(drawing,bytes);if(!plane)await openDrawingInNewTab(node);
      }catch(error){alert(error.message);}finally{node._imageDisplayPending=false;}
    },true);
    new MutationObserver(bindFitButtons).observe(root,{childList:true,subtree:true});bindFitButtons();
    const menu=document.createElement('div');menu.id='terrain-image-menu';menu.style.cssText='display:none;position:fixed;z-index:10000;padding:5px;background:var(--bg,#fff);border:1px solid #aaa;border-radius:5px';const importButton=document.createElement('button');importButton.textContent='Import remote sensing imagery…';menu.append(importButton);document.body.append(menu);
    root.addEventListener('contextmenu',event=>{
      const leaf=event.target.closest('[data-drawing-id]');
      if(leaf&&isSurfaceImageryCategory(leaf.parentElement?.previousElementSibling)){
        surfaceMenu(menu,event,[{key:'fit',label:'Drape over terrain…',run:()=>open(leaf.dataset.drawingId)},{key:'rename',label:'Rename',run:()=>renameDrawingFileNode(leaf)},{key:'export',label:'Export',run:()=>exportSurfaceImagery(leaf)},{key:'delete',label:'Delete',danger:true,run:()=>deleteSurfaceImagery(leaf)}]);return;
      }
      const node=event.target.closest('[data-role="drawing-category"]');if(!isSurfaceImageryCategory(node))return;
      node.dataset.surfaceKind='imagery';
      surfaceMenu(menu,event,[{key:'import',label:'Import remote sensing imagery…',run:()=>input.click()},{key:'rename',label:'Rename',run:()=>renameSurfaceCategory(node)},{key:'export',label:'Export',run:()=>exportSurfaceImagery(node)},{key:'delete',label:'Delete',danger:true,run:()=>deleteSurfaceImagery(node)}]);
    },true);
    document.addEventListener('mousedown',event=>{if(!menu.contains(event.target))menu.style.display='none';});importButton.onclick=()=>{menu.style.display='none';input.click();};
    dialog.querySelector('#terrain-image-close').onclick=()=>{if(!working)dialog.close();};dialog.addEventListener('cancel',event=>{if(working)event.preventDefault();});
    input.onchange=async()=>{
      const errors=[];try{
        const files=Array.from(input.files),images=files.filter(file=>/\.(tiff?|png|jpe?g|webp)$/i.test(file.name));
        const category=Array.from(root.querySelectorAll('[data-role="drawing-category"]')).find(isSurfaceImageryCategory);if(!category)return;
        for(const image of images){try{
          if(image.size>512*1024*1024)throw new Error('Image exceeds 512MB Limit. ');
          if(Array.from(category.nextElementSibling.children).some(node=>node.querySelector('span')?.textContent===image.name))throw new Error('An image with this name already exists. ');
          const leaf=image.name.replace(/\.[^.]+$/,'').toLowerCase(),sidecar=files.find(file=>/\.(tfw|pgw|jgw|wld)$/i.test(file.name)&&file.name.replace(/\.[^.]+$/,'').toLowerCase()===leaf);
          let world=null,coordinateWarning=null;if(sidecar){try{world=parseWorldFile(await sidecar.text());}catch(error){coordinateWarning=error.message;}}
          const id='terrain_image_'+Date.now()+'_'+Math.random().toString(36).slice(2,6),blobUrl=URL.createObjectURL(image);
          state.drawings[id]={id,fileName:image.name,filePath:image.path||null,ext:image.name.split('.').pop().toLowerCase(),blob:image,blobUrl,terrainImageSource:{world,coordinateWarning}};
          const node=document.createElement('div');node.className='lp-sub-item';node.dataset.drawingId=id;const name=document.createElement('span');name.textContent=image.name;node.append(name);category.nextElementSibling.append(node);bindDrawingContextMenus(root);
          try{
            const plane=await displayGeoImagePlane(state.drawings[id],image.path&&window.electronAPI?.preprocessImage?new Uint8Array():new Uint8Array(await image.arrayBuffer()));
            node.title=plane?'Georeferenced, Applied by Original Coordinates Show in 3D View; Default plane elevation: 0, You can choose a terrain to drape over. ':'Image is not georeferenced, Set control points using Register before displaying the image. ';
          }catch(error){node.title='Image imported, 3D display failed:  '+error.message;errors.push(image.name+'：'+error.message);}
        }catch(error){errors.push(image.name+'：'+error.message);}}
        bindFitButtons();if(errors.length)alert(errors.join('\n'));
      }finally{input.value='';}
    };
    dialog.querySelector('#terrain-image-apply').onclick=async()=>{
      if(working)return;const status=dialog.querySelector('#terrain-image-status'),button=dialog.querySelector('#terrain-image-apply');
      try{
        const drawing=selectedDrawing;if(!drawing)throw new Error('Image record does not exist. ');
        const model=state.models.find(m=>m.id===dialog.querySelector('select').value);if(!model)throw new Error('The target terrain has been removed. ');
        working=true;button.disabled=true;dialog.querySelector('select').disabled=true;status.textContent='Reading coordinates and generating terrain textures…';
        let bytes;if(drawing.filePath&&window.electronAPI?.preprocessImage)bytes=new Uint8Array();else if(drawing.blob)bytes=new Uint8Array(await drawing.blob.arrayBuffer());else{const result=await electronAPI.readProjectFile(drawing.filePath);if(!result?.ok)throw new Error(result?.error||'Unable to read image');bytes=base64ToBytes(result.data);}
        let world=drawing.terrainImageSource?.world||null;
        const registration=drawingRegisters[drawing.id],manualRegistration=registration?.done&&!registration.autoCoordinates?{transform:registration.transform,points:registration.points,imageWidth:registration.imageWidth,imageHeight:registration.imageHeight}:drawing.manualRegistration||null;
        if(!manualRegistration&&!world&&drawing.filePath&&window.electronAPI?.readProjectFile){for(const ext of ['tfw','pgw','jgw','wld']){const result=await electronAPI.readProjectFile(drawing.filePath.replace(/\.[^.]+$/,'.'+ext));if(result?.ok){world=parseWorldFile(new TextDecoder().decode(base64ToBytes(result.data)));break;}}}
        const metadata={fileName:drawing.fileName,filePath:drawing.filePath||null,world,textureMaxSize:Number(dialog.querySelector('#terrain-image-quality').value)};
        if(manualRegistration){manualRegistrationCoordinates(manualRegistration);metadata.manualRegistration=manualRegistration;metadata.coordinateSource='manual';}else metadata.coordinateSource='file';
        if(!metadata.filePath){let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));metadata.base64=btoa(binary);}
        await attachTerrainImage(model,bytes,metadata);rebuildLayerManagement();selectLayer(model.id);
        status.textContent='Draping complete:  '+model.terrainImage.insideVertices+'/'+model.terrainImage.totalVertices+' terrain vertices lie within the image extent; Keep elevation colors outside the image extent. ';
      }catch(error){status.textContent=error.message;}finally{working=false;button.disabled=false;dialog.querySelector('select').disabled=false;}
    };
  })();
}
