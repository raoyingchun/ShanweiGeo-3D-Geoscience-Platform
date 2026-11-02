'use strict';
const APP_PREFERENCE_DEFAULTS={background:'#ececec',axisX:'#ff0000',axisY:'#0000ff',axisZ:'#00ff00',axisTextScale:1,axesVisible:true,gridVisible:false,gridColor:'#a5acb5',quality:'standard'};
function normalizeAppPreferences(value){
  const result=Object.assign({},APP_PREFERENCE_DEFAULTS);value=value||{};
  for(const key of ['background','axisX','axisY','axisZ','gridColor'])if(/^#[0-9a-f]{6}$/i.test(value[key]||''))result[key]=value[key];
  if(Number.isFinite(Number(value.axisTextScale))&&Number(value.axisTextScale)>=.5&&Number(value.axisTextScale)<=2)result.axisTextScale=Number(value.axisTextScale);
  for(const key of ['axesVisible','gridVisible'])if(typeof value[key]==='boolean')result[key]=value[key];
  if(['smooth','standard','high'].includes(value.quality))result.quality=value.quality;return result;
}
function normalizeRecentProjects(value){
  const result=[],seen=new Set();
  if(!Array.isArray(value))return result;
  for(const item of value){if(!item||typeof item.path!=='string'||!item.path.trim())continue;const key=item.path.replace(/\\/g,'/').toLowerCase();if(seen.has(key))continue;seen.add(key);result.push({path:item.path,name:typeof item.name==='string'&&item.name?item.name:item.path.split(/[\\/]/).pop(),time:Number(item.time)||0});if(result.length===10)break;}
  return result;
}
var appPreferences=normalizeAppPreferences(null),recentProjects=[];
if(typeof localStorage!=='undefined'){
  try{appPreferences=normalizeAppPreferences(JSON.parse(localStorage.getItem('shanwei-display-preferences-v1')));}catch(_){}
  try{recentProjects=normalizeRecentProjects(JSON.parse(localStorage.getItem('shanwei-recent-projects-v1')));}catch(_){}
}
function desiredCanvasPixelRatio(moving=false){
  const ratio=typeof window!=='undefined'?window.devicePixelRatio||1:1;
  if(appPreferences.quality==='smooth')return 1;
  return moving?1:Math.min(ratio,appPreferences.quality==='high'?2:1.5);
}
const preferenceGrids=new WeakMap();
function applyScenePreferences(targetScene,targetState){
  targetScene.background=new THREE.Color(appPreferences.background);
  const previous=preferenceGrids.get(targetScene);if(previous){targetScene.remove(previous);previous.geometry.dispose();previous.material.dispose();preferenceGrids.delete(targetScene);}
  if(!appPreferences.gridVisible)return;
  const bounds=new THREE.Box3();(targetState.models||[]).filter(model=>model.inScene!==false&&model.visible!==false).forEach(model=>bounds.expandByObject(model.mesh));
  const empty=bounds.isEmpty(),size=empty?1000:Math.max(bounds.max.x-bounds.min.x,bounds.max.z-bounds.min.z,10)*1.2;
  const grid=new THREE.GridHelper(size,20,appPreferences.gridColor,appPreferences.gridColor);
  if(!empty)grid.position.set((bounds.min.x+bounds.max.x)/2,bounds.min.y-.1,(bounds.min.z+bounds.max.z)/2);
  grid.material.transparent=true;grid.material.opacity=.35;grid.material.depthWrite=false;targetScene.add(grid);preferenceGrids.set(targetScene,grid);
}
function refreshAllScenePreferences(){
  const originalState=state,originalScene=scene;
  try{tabViewers.forEach(viewer=>{if(viewer.type!=='3d'||!viewer.state||!viewer.scene)return;state=viewer.state;scene=viewer.scene;state.axisLabelsVisible=appPreferences.axesVisible;buildAxisLabels();});}
  finally{state=originalState;scene=originalScene;}
  renderer.setPixelRatio(desiredCanvasPixelRatio(false));
}
function recordRecentProject(filePath,name){
  if(!filePath)return;
  if(!name||['Project name','Untitled project'].includes(name))name=filePath.split(/[\\/]/).pop().replace(/\.json$/i,'');
  recentProjects=normalizeRecentProjects([{path:filePath,name:name||filePath.split(/[\\/]/).pop(),time:Date.now()},...recentProjects]);
  try{localStorage.setItem('shanwei-recent-projects-v1',JSON.stringify(recentProjects));}catch(error){console.warn('Unable to save the recent project history',error);}
  if(typeof renderRecentProjects==='function')renderRecentProjects();
}
function renderRecentProjects(){
  const container=document.getElementById('recent-project-list');if(!container)return;container.replaceChildren();
  if(!recentProjects.length){const empty=document.createElement('div');empty.textContent='No recent projects';empty.style.cssText='padding:8px 12px;color:var(--text-muted);font-size:12px';container.append(empty);return;}
  recentProjects.forEach(entry=>{
    const row=document.createElement('div');row.className='project-menu-item';row.style.cssText='padding:6px 8px;gap:4px';
    const open=document.createElement('button');open.type='button';open.textContent=entry.name;open.title=entry.path;open.style.cssText='flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer';
    open.onclick=async event=>{event.stopPropagation();document.getElementById('project-dropdown').classList.remove('show');document.getElementById('project-menu-wrap').classList.remove('open');await doOpenProject(entry.path);};
    const remove=document.createElement('button');remove.textContent='×';remove.title='Remove from recent projects, The project file is not deleted';remove.style.cssText='border:0;background:transparent;color:var(--text-muted);cursor:pointer';remove.onclick=event=>{event.stopPropagation();recentProjects=recentProjects.filter(item=>item.path!==entry.path);localStorage.setItem('shanwei-recent-projects-v1',JSON.stringify(recentProjects));renderRecentProjects();};row.append(open,remove);container.append(row);
  });
}
if(typeof module!=='undefined'&&module.exports)module.exports={normalizeAppPreferences,normalizeRecentProjects};
if(typeof document!=='undefined'){
  const menu=document.getElementById('project-dropdown');
  if(menu){
    const recent=document.createElement('details');recent.id='recent-projects';recent.style.cssText='border-top:1px solid var(--border);margin-top:5px;padding-top:4px';recent.innerHTML='<summary class="project-menu-item">Recent projects</summary><div id="recent-project-list" style="max-height:240px;overflow:auto"></div><button id="clear-recent-projects" style="margin:5px 10px;font-size:12px">Clear history</button>';recent.addEventListener('click',event=>event.stopPropagation());menu.append(recent);
    document.getElementById('clear-recent-projects').onclick=()=>{recentProjects=[];localStorage.setItem('shanwei-recent-projects-v1','[]');renderRecentProjects();};renderRecentProjects();
    const settings=document.createElement('div');settings.className='project-menu-item';settings.id='project-settings-btn';settings.textContent='⚙ Settings';settings.onclick=event=>{event.stopPropagation();menu.classList.remove('show');document.getElementById('project-menu-wrap').classList.remove('open');openProjectSettings();};menu.append(settings);
  }
  const style=document.createElement('style');style.textContent='#app-settings-dialog{position:fixed;left:50%;top:50%;margin:0;transform:translate(-50%,-50%);width:420px;max-width:90vw;max-height:85vh;overflow:auto;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);padding:20px}#app-settings-dialog::backdrop{background:#0005}#app-settings-dialog .setting-row{display:flex;align-items:center;justify-content:space-between;margin:12px 0;gap:15px}#app-settings-dialog h3{margin-top:0}#app-settings-dialog h4{margin-bottom:8px}#app-settings-dialog input[type=color]{width:55px;height:28px}#app-settings-dialog button{padding:5px 12px}';document.head.append(style);
}
function openProjectSettings(){
  let dialog=document.getElementById('app-settings-dialog');if(dialog?.open)return;
  if(!dialog){dialog=document.createElement('dialog');dialog.id='app-settings-dialog';dialog.innerHTML='<form method="dialog"><h3>Settings</h3><h4>Canvas appearance</h4><label class="setting-row">Background color<input name="background" type="color"></label><label class="setting-row">X Axis color<input name="axisX" type="color"></label><label class="setting-row">Y Axis color<input name="axisY" type="color"></label><label class="setting-row">Z Axis color<input name="axisZ" type="color"></label><label class="setting-row">Axis label size<select name="axisTextScale"><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select></label><label class="setting-row">Show XYZ Axes and ticks<input name="axesVisible" type="checkbox"></label><label class="setting-row">Show reference grid<input name="gridVisible" type="checkbox"></label><label class="setting-row">Grid color<input name="gridColor" type="color"></label><h4>Display performance</h4><label class="setting-row">Rendering quality<select name="quality"><option value="smooth">Fast</option><option value="standard">Standard</option><option value="high">High resolution</option></select></label><p style="font-size:12px;color:var(--text-muted)">Settings are stored locally and applied to all 3D views, Model coordinates are unchanged. </p><div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" id="reset-app-settings">Restore defaults</button><button value="cancel">Cancel</button><button value="apply">Apply</button></div></form>';document.body.append(dialog);
    const form=dialog.querySelector('form');
    dialog.querySelector('#reset-app-settings').onclick=()=>populate(APP_PREFERENCE_DEFAULTS);
    form.addEventListener('submit',event=>{if(event.submitter?.value!=='apply')return;const draft={};for(const key of Object.keys(APP_PREFERENCE_DEFAULTS)){const control=form.elements.namedItem(key);draft[key]=control.type==='checkbox'?control.checked:control.value;}
      const next=normalizeAppPreferences(draft);try{localStorage.setItem('shanwei-display-preferences-v1',JSON.stringify(next));}catch(error){event.preventDefault();alert('Unable to save settings:  '+error.message);return;}appPreferences=next;refreshAllScenePreferences();});
  }
  function populate(value){for(const key of Object.keys(APP_PREFERENCE_DEFAULTS)){const control=dialog.querySelector('form').elements.namedItem(key);if(control.type==='checkbox')control.checked=value[key];else control.value=String(value[key]);}}
  populate(appPreferences);dialog.showModal();
}
