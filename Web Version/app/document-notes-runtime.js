'use strict';
const documentNoteWrites=new Map();let documentNoteTimer=null;
function noteSaveStatus(message,path){
 let el=document.getElementById('doc-note-save-status');const editor=document.getElementById('rp-doc-note-editor');
 if(!el&&editor){el=document.createElement('div');el.id='doc-note-save-status';el.style.cssText='font-size:11px;color:var(--text-muted);padding:5px 0';editor.after(el);}
 if(el){el.textContent=message;el.title=path||'';}
}
function cleanDocumentInk(ink){
 const result={};for(const [page,strokes] of Object.entries(ink||{}))result[page]=(strokes||[]).map(s=>({type:s.type,color:s.color,width:s.width,page:s.page,points:(s.points||[]).map(p=>({x:p.x,y:p.y}))}));return result;
}
function persistDocumentInk(type){
 if(docCtx.type!==type)return;
 const url=type==='pdf'?currentPdfUrl:currentWordUrl;if(url!==docCtx.url)return;
 const rec=docRecord(docCtx.key,true),ink=cleanDocumentInk(type==='pdf'?pdfAnnots:wordAnnots);
 if(JSON.stringify(rec.ink||{})===JSON.stringify(ink))return;
 rec.ink=ink;rec.inkRevision=(rec.inkRevision||0)+1;queueDocumentNotes(docCtx.key);
}
function applyStoredDocumentInk(context){
 if(docCtx.key!==context.key||docCtx.url!==context.url)return;
 const rec=docRecord(context.key);if(!rec?.ink)return;
 if(context.type==='pdf'&&currentPdfUrl===context.url){pdfAnnots=cleanDocumentInk(rec.ink);redrawPdfAnnots();}
 if(context.type==='word'&&currentWordUrl===context.url){wordAnnots=cleanDocumentInk(rec.ink);wordPathCache={};wordPages.forEach((sec,i)=>drawWordPageAnnots(i));}
}
function queueDocumentNotes(key){
 const rec=docRecord(key);if(!rec)return;rec.noteRevision=(rec.noteRevision||0)+1;
 const payload={identity:rec.noteIdentity||{type:key.split('::')[0],source:key.slice(key.indexOf('::')+2),name:docCtx.name},note:rec.note||'',ink:cleanDocumentInk(rec.ink)};
 documentNoteWrites.set(key,payload);
 try{localStorage.setItem('shanwei-document-note::'+key,JSON.stringify(payload));}catch(error){console.warn('Notes Temporary Restore Copy Write failed',error);}
 noteSaveStatus('Pending autosave…');clearTimeout(documentNoteTimer);documentNoteTimer=setTimeout(savePendingDocumentNotes,700);
}
async function savePendingDocumentNotes(){
 clearTimeout(documentNoteTimer);documentNoteTimer=null;
 for(const [key,payload] of [...documentNoteWrites]){
  if(!window.electronAPI?.saveDocumentNotes){noteSaveStatus('Saved temporarily in local browser storage');continue;}
  try{
   const result=await electronAPI.saveDocumentNotes(payload);if(!result.ok)throw new Error(result.error);
   if(documentNoteWrites.get(key)===payload){documentNoteWrites.delete(key);localStorage.removeItem('shanwei-document-note::'+key);}
   if(docCtx.key===key)noteSaveStatus('Saved automatically TXT and ink',result.filePath);
  }catch(error){noteSaveStatus('Save failed, A recovery copy has been retained:  '+error.message);}
 }
}
async function loadDocumentNotes(context){
 const rec=docRecord(context.key,true),revision=rec.noteRevision||0,inkRevision=rec.inkRevision||0;
 try{
  const recovery=localStorage.getItem('shanwei-document-note::'+context.key);
  const result=recovery?{ok:true,...JSON.parse(recovery)}:window.electronAPI?.readDocumentNotes?await electronAPI.readDocumentNotes(rec.noteIdentity):{ok:true};
  if(!result.ok)throw new Error(result.error);
  if((rec.noteRevision||0)===revision&&typeof result.note==='string')rec.note=result.note;
  if(result.ink&&(rec.inkRevision||0)===inkRevision)rec.ink=cleanDocumentInk(result.ink);
  if(documentNoteWrites.has(context.key))queueDocumentNotes(context.key);
  if(recovery)queueDocumentNotes(context.key);
  if(docCtx.key===context.key){renderDocNotePanel();applyStoredDocumentInk(context);noteSaveStatus(result.filePath?'Notes are saved automatically to TXT':'Created automatically when you enter a note TXT',result.filePath);}
 }catch(error){if(docCtx.key===context.key)noteSaveStatus('Unable to read notes:  '+error.message);}
}
window.addEventListener('beforeunload',()=>{
 if(docCtx.type==='pdf'||docCtx.type==='word')persistDocumentInk(docCtx.type);
 for(const [key,payload] of documentNoteWrites){try{const result=window.electronAPI?.flushDocumentNotes?.(payload);if(result?.ok)localStorage.removeItem('shanwei-document-note::'+key);}catch(error){console.warn(error);}}
});
