'use strict';
function prepareBlockModelAsync(text,origin) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker('app/block-model-worker.js');
    const finish=()=>worker.terminate();
    worker.onerror=event=>{finish();reject(new Error(event.message||'Block model backend processing failed'));};
    worker.onmessage=({data})=>{
      if(data.type==='progress')showImportProgress(data.percent,data.message);
      else {finish();data.type==='result'?resolve(data.result):reject(new Error(data.error));}
    };
    worker.postMessage({text,origin});
  });
}
// Keep exact triangle picking, but reject spatial chunks before checking instances.
function accelerateBlockPicking(inst,chunkBounds) {
  const inverse=new THREE.Matrix4(),localRay=new THREE.Ray(),box=new THREE.Box3();
  const matrix=new THREE.Matrix4(),mesh=new THREE.Mesh(inst.geometry,inst.material),hits=[];
  inst.raycast=function(raycaster,intersects){
    inverse.copy(this.matrixWorld).invert();localRay.copy(raycaster.ray).applyMatrix4(inverse);
    for(let c=0;c<chunkBounds.length;c+=6){
      box.min.fromArray(chunkBounds,c);box.max.fromArray(chunkBounds,c+3);
      if(!localRay.intersectsBox(box))continue;
      const first=c/6*128,end=Math.min(first+128,this.count);
      for(let i=first;i<end;i++){
        this.getMatrixAt(i,matrix);mesh.matrixWorld.multiplyMatrices(this.matrixWorld,matrix);mesh.material=this.material;
        hits.length=0;mesh.raycast(raycaster,hits);
        for(const hit of hits){hit.instanceId=i;hit.object=this;intersects.push(hit);}
      }
    }
  };
}

async function restoreBlockPicking(inst) {
  if(!inst?.isInstancedMesh)return;
  const bounds=inst.userData.blockBox;
  if(bounds&&!bounds.isBox3)inst.userData.blockBox=new THREE.Box3(
    new THREE.Vector3(bounds.min.x,bounds.min.y,bounds.min.z),
    new THREE.Vector3(bounds.max.x,bounds.max.y,bounds.max.z));
  const chunks=new Float64Array(Math.ceil(inst.count/128)*6),a=inst.instanceMatrix.array;
  for(let i=0;i<chunks.length;i+=6)chunks.set([Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity],i);
  for(let i=0;i<inst.count;i++) {
    const p=i*16,c=Math.floor(i/128)*6;
    for(let j=0;j<3;j++){
      const center=a[p+12+j],half=Math.abs(a[p+j*5])/2;
      chunks[c+j]=Math.min(chunks[c+j],center-half);chunks[c+j+3]=Math.max(chunks[c+j+3],center+half);
    }
    if(i&&i%32768===0)await yieldToUI();
  }
  accelerateBlockPicking(inst,chunks);
}
