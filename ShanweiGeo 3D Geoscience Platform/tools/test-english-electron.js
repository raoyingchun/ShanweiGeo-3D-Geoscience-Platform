const {app}=require('electron'),fs=require('fs'),path=require('path'),os=require('os'),Module=require('module'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'shanwei-english-test-')),output=path.join(root,'build/english-validation');fs.mkdirSync(output,{recursive:true});
const errors=[];let done=false;const timeout=setTimeout(()=>finish(Error('English validation timeout')),90000);
function finish(error){if(done)return;done=true;clearTimeout(timeout);if(error)console.error(error.stack);app.exit(error?1:0);}
app.on('browser-window-created',(_event,win)=>{win.webContents.on('console-message',(_e,level,msg)=>{if(level===3)errors.push(msg);});win.webContents.once('did-finish-load',async()=>{
 try{
 const run=code=>win.webContents.executeJavaScript('(async()=>{'+code+'})()');await new Promise(r=>setTimeout(r,1200));win.setSize(1600,1000);
 const initial=await run(`const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),chinese=[];let n;while(n=walker.nextNode()){if(!n.parentElement.closest('style,script')&&/[\\u3400-\\u9fff]/.test(n.data))chinese.push({text:n.data.trim(),parent:n.parentElement.id||n.parentElement.className});}return {lang:document.documentElement.lang,title:document.title,chinese,defaults:researchRegions.list().map(n=>n.name)};`);
 assert.equal(initial.lang,'en');assert.deepEqual(initial.chinese,[]);assert.ok(initial.defaults.includes('Default Deposit'));
 const railStyle=await run(`return getComputedStyle(document.querySelector('.rail-action-label')).textOrientation;`);assert.equal(railStyle,'mixed','English rail layout must be loaded');
 const tables=await run(`
 const collar=parseCollarTable({data:[['孔号','东坐标','北坐标','高程','总深'],['中文孔001',1000,2000,300,150]]});
 const survey=parseSurveyTable({data:[['孔号','深度','倾角','方位角'],['中文孔001',20,-65,110]]});
 const lithology=parseLithologyTable({data:[['孔号','起始','终止','岩性'],['中文孔001',0,20,'砂岩']]});
 if(collar[0]?.holeid!=='中文孔001'||collar[0]?.x!==1000||collar[0]?.depth!==150)throw Error('Chinese collar alias regression');
 if(survey[0]?.dip!==-65||survey[0]?.azimuth!==110)throw Error('Chinese survey alias regression');
 if(lithology[0]?.vein!=='砂岩'||lithology[0]?.to!==20)throw Error('Chinese lithology alias regression');
 const english=parseCollarTable({data:[['holeid','x','y','elevation','depth'],['EN001',12,34,56,78]]});if(english[0]?.depth!==78)throw Error('English table regression');
 return {collar,survey,lithology,english};`);
 const result=await run(`
 const deposit=researchRegions.add('deposit','English Demo',null),area=researchRegions.add('area','Area A',deposit),section=researchRegions.add('section','Section A',area);
 const category=addNewBlockModelNode('Demo Block Model');let csv='Id,X,Y,Z,dX,dY,dZ,GM\\n',id=1;for(let z=0;z<8;z++)for(let y=0;y<8;y++)for(let x=0;x<12;x++)csv+=[id++,1000+x*10,2000+y*10,z*10,10,10,10,z>5?'Cover':'Ore Zone'].join(',')+'\\n';
 await buildBlockModelFromCsv(csv,'demo-blocks.csv',category);hideImportLoading();fitViewToAll();updateLegend();buildAxisLabels();
 const count=state.models.filter(m=>m.isBlockModel).reduce((n,m)=>n+m.mesh.count,0);if(count!==768)throw Error('Wrong block count: '+count);
 const snapshot=serializeProject();const current=researchRegions.currentId;if(!snapshot.researchAreas)throw Error('Region serialization missing');
 return {count,section,current,snapshotKeys:Object.keys(snapshot),category:state.models.find(m=>m.isBlockModel).category};`);
 const restored=await run(`const saved=serializeProject();clearProject();const missing=await restoreProject(saved);const blocks=getProjectModels().filter(m=>m.isBlockModel).reduce((n,m)=>n+m.mesh.count,0);if(blocks!==768)throw Error('Block project restoration failed: '+blocks);const legacy={viewers:[{models:[{metadata:{category:'矿体',fileName:'中文矿体.ts',displayName:'原始名称'}}]}],tree:{models3d:[{name:'用户模型',children:[{name:'矿体'}]}]},projectName:'中文项目'};const migrated=normalizeLegacyProjectCategories(legacy);if(migrated.viewers[0].models[0].metadata.category!=='Orebody'||migrated.viewers[0].models[0].metadata.fileName!=='中文矿体.ts'||legacy.viewers[0].models[0].metadata.category!=='矿体')throw Error('Legacy category migration changed user data');fitViewToAll();updateLegend();hideImportLoading();return {blocks,missing,legacyCategory:migrated.viewers[0].models[0].metadata.category};`);
 win.showInactive();await new Promise(r=>setTimeout(r,300));fs.writeFileSync(path.join(output,'01-English-Workspace.png'),(await win.webContents.capturePage()).toPNG());
 await run(`document.getElementById('utility-coordinates').click();await new Promise(r=>setTimeout(r,150));`);
 fs.writeFileSync(path.join(output,'02-English-Coordinates.png'),(await win.webContents.capturePage()).toPNG());
 const coord=await run(`const el=document.querySelector('.coord-shell');return {text:el?.textContent||'',chinese:/[\\u3400-\\u9fff]/.test(el?.textContent||'')};`);assert.ok(coord.text.includes('Coordinate'));assert.equal(coord.chinese,false);
 await run(`document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.querySelectorAll('.modal-overlay.show').forEach(el=>el.classList.remove('show'));window.__modalRecount();`);
 fs.writeFileSync(path.join(output,'validation.json'),JSON.stringify({date:'2026-10-21',initial,tables,result,restored,coordinateEnglish:!coord.chinese,consoleErrors:errors},null,2));
 console.log('PASS English UI, Chinese and English table aliases, user data preservation, regions, block model and serialization: '+JSON.stringify(result));finish();
 }catch(error){finish(error);}
});});
let source=fs.readFileSync(path.join(root,'main.js'),'utf8');source=source.replace("const USER_DATA_DIR = path.join(__dirname, 'userData');",'const USER_DATA_DIR = '+JSON.stringify(path.join(temp,'userData'))+';').replace("const CACHE_DIR = path.join(__dirname, 'cache');",'const CACHE_DIR = '+JSON.stringify(path.join(temp,'cache'))+';').replace("app.setAppLogsPath(path.join(__dirname, 'logs'));",'app.setAppLogsPath('+JSON.stringify(path.join(temp,'logs'))+');').replace('    width: 1600,','    show: false,\n    width: 1600,').replace('setupFileWatcher();','');
const mod=new Module(path.join(root,'main.js'),module);mod.filename=path.join(root,'main.js');mod.paths=Module._nodeModulePaths(root);mod._compile(source,mod.filename);
