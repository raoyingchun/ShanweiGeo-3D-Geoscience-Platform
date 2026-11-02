'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),sharp=require('sharp');
async function tiffCoordinates(filePath){
 const file=await fs.promises.open(filePath,'r');
 try{
  const stat=await file.stat();
  async function read(offset,length){if(offset<0||length<0||offset+length>stat.size)throw new Error('TIFF Tag out of bounds');const b=Buffer.alloc(length);const {bytesRead}=await file.read(b,0,length,offset);if(bytesRead!==length)throw new Error('TIFF Incomplete tab');return b;}
  const head=await read(0,8),le=head.readUInt16BE(0)===0x4949;
  const u16=(b,o)=>le?b.readUInt16LE(o):b.readUInt16BE(o),u32=(b,o)=>le?b.readUInt32LE(o):b.readUInt32BE(o);
  if(u16(head,2)!==42)return {error:'This TIFF Unsupported coordinate header, Provide the corresponding world file. '};
  const offset=u32(head,4),count=u16(await read(offset,2),0);if(count>4096)throw new Error('TIFF Too many tags');
  const entries=await read(offset+2,count*12),tags={};
  for(let i=0;i<count;i++){
   const pos=i*12,tag=u16(entries,pos),type=u16(entries,pos+2),n=u32(entries,pos+4),size=({3:2,4:4,12:8})[type];
   if(![33550,33922,34264,34735].includes(tag)||!size)continue;if(n>4096)throw new Error('TIFF Coordinate labels are too large');
   const b=n*size<=4?entries.subarray(pos+8,pos+12):await read(u32(entries,pos+8),n*size);
   tags[tag]=Array.from({length:n},(_,j)=>type===12?(le?b.readDoubleLE(j*size):b.readDoubleBE(j*size)):type===3?u16(b,j*size):u32(b,j*size));
  }
  let world=null;
  if(tags[34264]?.length===16){const m=tags[34264];world=[m[0],m[4],m[1],m[5],m[3]+(m[0]+m[1])/2,m[7]+(m[4]+m[5])/2];}
  else if(tags[33550]&&tags[33922]){const [a,e]=tags[33550],t=tags[33922];world=[a,0,0,-e,t[3]-t[0]*a+a/2,t[4]+t[1]*e-e/2];}
  const keys=tags[34735];if(world&&keys)for(let i=4;i+3<keys.length;i+=4)if(keys[i]===1025&&keys[i+3]===2){world[4]-=(world[0]+world[2])/2;world[5]-=(world[1]+world[3])/2;}
  return {world};
 }finally{await file.close();}
}
async function preprocess(filePath,quality,gpuLimit,cacheDir){
 if(typeof filePath!=='string'||!path.isAbsolute(filePath)||! /\.(tiff?|png|jpe?g|webp)$/i.test(filePath))throw new Error('Select a supported local image file');
 const stat=await fs.promises.stat(filePath);if(stat.size>512*1024*1024)throw new Error('Image exceeds 512MB Limit');
 quality=[2048,4096,8192].includes(quality)?quality:2048;gpuLimit=Number.isFinite(gpuLimit)?Math.max(1,Math.min(8192,gpuLimit)):4096;const limit=Math.min(quality,gpuLimit);
 const key=crypto.createHash('sha256').update(JSON.stringify(['image-v1',filePath,stat.size,stat.mtimeMs,limit])).digest('hex');
 await fs.promises.mkdir(cacheDir,{recursive:true});const png=path.join(cacheDir,key+'.png'),metaFile=path.join(cacheDir,key+'.json');
 let meta,data,cacheHit=false;
 if(fs.existsSync(png)&&fs.existsSync(metaFile)){meta=JSON.parse(await fs.promises.readFile(metaFile,'utf8'));data=await fs.promises.readFile(png);cacheHit=true;}
 else{
  const image=sharp(filePath,{limitInputPixels:false});const info=await image.metadata();meta={width:info.width,height:info.height};
  data=await image.resize(limit,limit,{fit:'inside',withoutEnlargement:true}).png().toBuffer();
  await fs.promises.writeFile(png,data);await fs.promises.writeFile(metaFile,JSON.stringify(meta));
 }
 let coordinate={};if(/\.tiff?$/i.test(filePath)){try{coordinate=await tiffCoordinates(filePath);}catch(error){coordinate.error=error.message;}}
 // 世界文件只读几百字节；每次检查，配套文件修改立即生效。
 for(const ext of coordinate.world?[]:['tfw','pgw','jgw','wld']){
  try{const content=await fs.promises.readFile(filePath.replace(/\.[^.]+$/,'.'+ext),'utf8');const world=content.replace(/^\uFEFF/,'').trim().split(/\s+/).map(Number);
   if(world.length!==6||world.some(v=>!Number.isFinite(v))||Math.abs(world[0]*world[3]-world[1]*world[2])<1e-20)throw new Error('Invalid world file format');
   coordinate.world=world;break;
  }catch(error){if(error.code!=='ENOENT')coordinate.error=error.message;}
 }
 return {ok:true,...meta,...coordinate,cacheHit,data:new Uint8Array(data)};
}
module.exports={preprocess,tiffCoordinates};
