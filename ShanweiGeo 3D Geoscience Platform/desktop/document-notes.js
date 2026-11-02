'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function notePaths(root,identity){
 if(!identity||!['pdf','word'].includes(identity.type)||typeof identity.source!=='string'||!identity.source)throw new Error('Invalid document identity');
 const key=identity.type+'::'+identity.source.replace(/\\/g,'/').toLowerCase(),hash=crypto.createHash('sha256').update(key).digest('hex').slice(0,16);
 const name=path.basename(identity.name||identity.source).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100)||'Documents';
 const dir=path.join(root,'document-notes'),base=path.join(dir,name+'_'+hash);return {dir,text:base+'.txt',data:base+'.annotations.json'};
}
function write(root,payload){
 if(typeof payload.note!=='string'||Buffer.byteLength(JSON.stringify(payload),'utf8')>20*1024*1024)throw new Error('Note data is invalid or exceeds 20MB');
 const files=notePaths(root,payload.identity);fs.mkdirSync(files.dir,{recursive:true});
 const data={version:1,identity:payload.identity,note:payload.note,ink:payload.ink||{},updatedAt:new Date().toISOString()};
 for(const [file,content] of [[files.text,payload.note],[files.data,JSON.stringify(data)]]){fs.writeFileSync(file+'.tmp',content,'utf8');fs.renameSync(file+'.tmp',file);}
 return {ok:true,filePath:files.text};
}
function read(root,identity){
 const files=notePaths(root,identity);let data={};
 if(fs.existsSync(files.data))data=JSON.parse(fs.readFileSync(files.data,'utf8'));
 if(fs.existsSync(files.text))data.note=fs.readFileSync(files.text,'utf8');
 return {ok:true,...data,filePath:files.text};
}
module.exports={write,read,notePaths};
