'use strict';
// Two linear scans, no full-file array of lines or scan per GM class.
function prepareBlocks(text, existingOrigin, progress = () => {}) {
  const lines = function* () {
    let start = 0;
    while (start < text.length) {
      let end = text.indexOf('\n', start); if (end < 0) end = text.length;
      const line = text.slice(start, end).trim(); start = end + 1;
      if (line) yield line;
    }
  };
  const columns = line => line.includes('"') ? line.match(/(?:"(?:[^"]|"")*"|[^,]*)(?:,|$)/g).filter(v => v).map(v => v.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')) : line.split(',');
  const header = columns(lines().next().value || '').map(v => v.replace(/^\uFEFF/, '').trim().toUpperCase());
  const hasHeader = header.includes('X') && header.includes('Y') && header.includes('Z');
  const indexes = ['X','Y','Z','DX','DY','DZ','GM'].map((name, i) => hasHeader && header.includes(name) ? header.indexOf(name) : i + 1);
  const rows = function* () {
    let first = true;
    for (const line of lines()) {
      if (first) { first = false; if (hasHeader) continue; }
      const p = columns(line); if (p.length < 8) continue;
      const values = indexes.slice(0, 6).map(index => Number(p[index]));
      const gm = (p[indexes[6]] || '').trim();
      if (!gm || values.some(v => !Number.isFinite(v))) continue;
      yield { values, gm };
    }
  };
  const counts = new Map(); let minX = Infinity, minY = Infinity, minZ = Infinity, total = 0;
  for (const {values:[x,y,z],gm} of rows()) {
    counts.set(gm, (counts.get(gm) || 0) + 1); total++;
    minX = Math.min(minX,x); minY = Math.min(minY,y); minZ = Math.min(minZ,z);
    if (total % 50000 === 0) progress({percent:15,message:'Counting blocks:  '+total.toLocaleString()});
  }
  if (!total) throw new Error('No valid blocks were found, Check X, Y, Z, dX, dY, dZ and category column');
  const origin = existingOrigin || {x:Math.floor(minX/100)*100,y:Math.floor(minY/100)*100,z:Math.floor(minZ/100)*100};
  const groups = Array.from(counts, ([name,count]) => ({name,count,matrices:new Float32Array(count*16),bounds:[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity],chunkBounds:new Float64Array(Math.ceil(count/128)*6),used:0}));
  const byName = new Map(groups.map(g => [g.name,g]));
  for (const g of groups) for(let i=0;i<g.chunkBounds.length;i+=6)g.chunkBounds.set([Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity],i);
  let done=0;
  for (const {values:[x,y,z,dx,dy,dz],gm} of rows()) {
    const g=byName.get(gm),i=g.used++,offset=i*16,m=g.matrices;
    const px=x-origin.x,py=z-origin.z,pz=-y+origin.y,sx=dx||10,sy=dz||10,sz=dy||10;
    m[offset]=sx;m[offset+5]=sy;m[offset+10]=sz;m[offset+15]=1;
    m[offset+12]=px;m[offset+13]=py;m[offset+14]=pz;
    // Bounds use the actual Float32 instance positions/scales (also for picking).
    const lo=[m[offset+12]-Math.abs(m[offset])/2,m[offset+13]-Math.abs(m[offset+5])/2,m[offset+14]-Math.abs(m[offset+10])/2];
    const hi=[m[offset+12]+Math.abs(m[offset])/2,m[offset+13]+Math.abs(m[offset+5])/2,m[offset+14]+Math.abs(m[offset+10])/2];
    const chunk=Math.floor(i/128)*6;
    for(let a=0;a<3;a++){g.bounds[a]=Math.min(g.bounds[a],lo[a]);g.bounds[a+3]=Math.max(g.bounds[a+3],hi[a]);g.chunkBounds[chunk+a]=Math.min(g.chunkBounds[chunk+a],lo[a]);g.chunkBounds[chunk+a+3]=Math.max(g.chunkBounds[chunk+a+3],hi[a]);}
    if (++done%50000===0)progress({percent:20+Math.round(done/total*65),message:'Building blocks:  '+done.toLocaleString()+'/'+total.toLocaleString()});
  }
  return {origin,total,groups};
}
if(typeof module!=='undefined')module.exports={prepareBlocks};
if(typeof self!=='undefined'&&typeof document==='undefined')self.onmessage=event=>{
  try {
    const result=prepareBlocks(event.data.text,event.data.origin,p=>self.postMessage({type:'progress',...p}));
    self.postMessage({type:'result',result},result.groups.flatMap(g=>[g.matrices.buffer,g.chunkBounds.buffer]));
  }catch(error){self.postMessage({type:'error',error:error.message});}
};
