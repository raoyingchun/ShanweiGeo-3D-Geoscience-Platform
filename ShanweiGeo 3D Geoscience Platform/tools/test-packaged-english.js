const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process'),net=require('net');
const root=path.resolve(__dirname,'..'),out=path.join(root,'dist-english-20261021');
const packageDir=process.env.SHANWEI_PACKAGE_DIR||path.join(out,'win-unpacked');
const fixture=name=>path.join(packageDir,'Sample Data',name);
(async()=>{
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const child=spawn(path.join(packageDir,'ShanweiGeo English.exe'),['--remote-debugging-port='+port],{cwd:out,windowsHide:true,stdio:'ignore',env:{...process.env,PATH:'C:\\Windows\\System32;C:\\Windows',SHANWEI_PYTHON:'Z:\\not-installed\\python.exe'}});
 let ws;
 try{
  let targets;
  for(let i=0;i<120;i++){try{targets=await(await fetch('http://127.0.0.1:'+port+'/json')).json();if(targets.some(t=>t.type==='page'&&t.url==='app://local/index8.html'))break;}catch(_){}await new Promise(r=>setTimeout(r,100));}
  const target=targets?.find(t=>t.type==='page'&&t.url==='app://local/index8.html');assert.ok(target,'packaged window failed to start');
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let next=0;const pending=new Map();ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  await send('Network.enable');await send('Network.setBlockedURLs',{urls:['http://*','https://*']});
  const result=await send('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
   scheduleSessionSave=()=>{};for(let i=0;i<100&&!window.backendClient;i++)await new Promise(r=>setTimeout(r,100));
   const health=await backendClient.healthCheck();if(document.documentElement.lang!=='en')throw Error('Packaged locale is not English');if(getComputedStyle(document.querySelector('.rail-action-label')).textOrientation!=='mixed')throw Error('English CSS missing');let backendError='';try{await backendClient.run('diagnostic.error');}catch(e){backendError=e.message;}if(backendError!=='Expected diagnostic error')throw Error('Backend error was not localized: '+backendError);
   const cat=addNewBlockModelNode('Synthetic Test');
   await buildBlockModelFromCsv('', 'demo-blocks.csv',cat,${JSON.stringify(fixture('demo-blocks.csv'))});
   const blocks=state.models.filter(m=>m.isBlockModel).reduce((n,m)=>n+m.mesh.count,0);
   const model=await parseLocalModel(${JSON.stringify(fixture('demo-model.ts'))},null,()=>{throw Error('unexpected fallback');});
   const terrain=await parseLocalModel(${JSON.stringify(fixture('demo-terrain.asc'))},null,()=>{throw Error('unexpected fallback');});
   const file=await electronAPI.readProjectFile(${JSON.stringify(fixture('demo-image.tif'))});const bytes=Uint8Array.from(atob(file.data),c=>c.charCodeAt(0));
   const preview=await electronAPI.decodeTiffPreview(bytes);if(!preview.ok)throw Error(preview.error);
   const url=URL.createObjectURL(new Blob([preview.data],{type:'image/png'}));await createNewTab('image',{imageName:'demo-image.tif',imageUrl:url});
   const image=document.getElementById('image-viewer-img');for(let i=0;i<100&&!image.naturalWidth;i++)await new Promise(r=>setTimeout(r,30));
   hideImportLoading();
   await ensureDocumentLibrary('pdf');await ensureDocumentLibrary('word');await ensureDocumentLibrary('excel');
   const pdfFile=await electronAPI.readProjectFile(${JSON.stringify(fixture('demo-document.pdf'))});if(!pdfFile.ok)throw Error(pdfFile.error);const pdfBytes=Uint8Array.from(atob(pdfFile.data),c=>c.charCodeAt(0));const doc=await pdfjsLib.getDocument({data:pdfBytes}).promise;const page=await doc.getPage(1);const text=await page.getTextContent();if(!text.items.some(i=>i.str.includes('ShanweiGeo')))throw Error('PDF content failed');await doc.destroy();
   return {health,blocks,modelVertices:model.vertices.length/3,modelTriangles:model.indices.length/3,terrainVertices:terrain.vertices.length/3,tiffWidth:image.naturalWidth,pdf:pdfjsLib.version,word:typeof docx,regionTree:typeof researchRegions!=='undefined'};
  })()`});
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
  const data=result.result.value;assert.equal(data.health.status,'ok');assert.ok(data.health.executable.includes('runtime\\python\\python.exe'));assert.equal(data.blocks,1000);assert.equal(data.modelVertices,4);assert.equal(data.modelTriangles,2);assert.equal(data.terrainVertices,9);assert.equal(data.tiffWidth,160);
  fs.writeFileSync(path.join(out,'packaged-validation.json'),JSON.stringify({date:'2026-10-21',systemPythonDisabled:true,httpBlocked:true,...data},null,2));

  send('Runtime.evaluate',{expression:'electronAPI.allowClose()'}).catch(()=>{});await new Promise(r=>setTimeout(r,200));
  console.log('PASS real packaged executable with system Python unavailable: '+JSON.stringify(data));
 }finally{if(ws)ws.close();if(child.exitCode===null)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
