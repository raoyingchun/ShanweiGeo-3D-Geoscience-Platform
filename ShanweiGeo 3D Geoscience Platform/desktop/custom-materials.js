'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),sharp=require('sharp');
const rootFor=base=>path.join(base,'custom-materials');
function directory(base,id){if(!/^custom_[a-f0-9]{32}$/.test(id))throw Error('Invalid custom material ID');return path.join(rootFor(base),id);}
function info(base,id){const dir=directory(base,id),item=JSON.parse(fs.readFileSync(path.join(dir,'material.json'),'utf8'));return {id,name:String(item.name||'Custom image').slice(0,60),custom:true,colorOnly:true,preview:'data:image/jpeg;base64,'+fs.readFileSync(path.join(dir,'preview.jpg')).toString('base64')};}
function list(base){const root=rootFor(base);if(!fs.existsSync(root))return [];return fs.readdirSync(root).filter(id=>/^custom_[a-f0-9]{32}$/.test(id)).slice(0,1000).flatMap(id=>{try{return [info(base,id)];}catch(error){console.warn('Unable to read the custom material:  '+id,error.message);return [];}});}
async function importImage(base,payload){
  const file=payload?.filePath,name=String(payload?.name||'').trim();
  if(typeof file!=='string'||!path.isAbsolute(file)||! /\.(png|jpe?g|webp)$/i.test(file))throw Error('Select JPG, PNG or WebP Image');
  if(!name||name.length>60)throw Error('Material name must be 1 to 60 characters');
  const stat=fs.statSync(file);if(!stat.isFile()||stat.size>100*1024*1024)throw Error('The image is not a regular file or exceeds 100MB');
  const metadata=await sharp(file,{limitInputPixels:64*1024*1024}).metadata();if(!['jpeg','png','webp'].includes(metadata.format))throw Error('The file content is not a supported image format');
  const image=await sharp(file,{limitInputPixels:64*1024*1024}).rotate().resize(2048,2048,{fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:92}).toBuffer();
  const id='custom_'+crypto.createHash('sha256').update(image).digest('hex').slice(0,32),dir=directory(base,id);
  if(fs.existsSync(path.join(dir,'material.json')))return info(base,id);
  fs.mkdirSync(dir,{recursive:true});
  await sharp(image).resize(256,256,{fit:'cover'}).jpeg({quality:85}).toFile(path.join(dir,'preview.jpg'));
  fs.writeFileSync(path.join(dir,'color.jpg'),image);
  fs.writeFileSync(path.join(dir,'material.json'),JSON.stringify({id,name,colorOnly:true,sourceName:path.basename(file),createdAt:new Date().toISOString()},null,2),'utf8');
  return info(base,id);
}
function read(base,id){const dir=directory(base,id);return 'data:image/jpeg;base64,'+fs.readFileSync(path.join(dir,'color.jpg')).toString('base64');}
function remove(base,id){const dir=directory(base,id),root=path.resolve(rootFor(base));if(!fs.existsSync(dir))return;if(fs.lstatSync(root).isSymbolicLink()||fs.lstatSync(dir).isSymbolicLink())throw Error('Linked directories cannot be deleted');const actualRoot=fs.realpathSync(root),actualDir=fs.realpathSync(dir);if(path.dirname(actualDir).toLowerCase()!==actualRoot.toLowerCase())throw Error('Material path is outside the allowed directory');fs.rmSync(actualDir,{recursive:true});}
module.exports={list,importImage,read,remove};
