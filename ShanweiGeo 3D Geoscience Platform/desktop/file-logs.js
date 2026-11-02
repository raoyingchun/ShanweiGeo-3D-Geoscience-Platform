'use strict';
const fs=require('fs'),path=require('path');
function install(directory){
  try{
    fs.mkdirSync(directory,{recursive:true});
    const stamp=new Date().toISOString().replace(/[:.]/g,'-')+'-'+process.pid;
    for(const [name,target] of [['stdout',process.stdout],['stderr',process.stderr]]){
      const file=fs.createWriteStream(path.join(directory,stamp+'.'+name+'.log'),{flags:'a'});let failed=false;
      file.on('error',()=>failed=true);
      target.write=function(chunk,encoding,callback){if(typeof encoding==='function'){callback=encoding;encoding=undefined;}if(failed){if(callback)process.nextTick(callback);return true;}return file.write(chunk,encoding,callback);};
      process.once('exit',()=>{file.end();});
    }
  }catch(_){/* Logging must not block application startup. */}
}
module.exports={install};
