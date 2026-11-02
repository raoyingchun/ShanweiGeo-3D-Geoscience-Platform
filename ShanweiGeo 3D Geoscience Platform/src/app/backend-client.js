(function () {
  'use strict';
  const pending = new Map();
  const earlyEvents = new Map();
  let starting = false;
  function handle(event) {
    const task = pending.get(event.taskId);
    if (!task) {
      if (starting) {
        const list = earlyEvents.get(event.taskId) || [];
        list.push(event); earlyEvents.set(event.taskId, list);
      }
      return;
    }
    if (event.type === 'progress') {
      try { if (task.onProgress) task.onProgress(event); } catch (error) { console.error(error); }
      return;
    }
    pending.delete(event.taskId);
    if (event.type === 'result') task.resolve(event.data);
    else {
      const error = new Error(event.error && event.error.message || 'Local computation failed');
      error.code = event.error && event.error.code; task.reject(error);
    }
  }
  const api = window.electronAPI;
  const unsubscribe = api && api.onPythonTaskEvent ? api.onPythonTaskEvent(handle) : null;
  window.backendClient = {
    available: !!unsubscribe,
    async run(method, params = {}, options = {}) {
      if (!unsubscribe) throw new Error('Local Python This operation is only available in the desktop application');
      if (starting || pending.size) throw new Error('Another computation is already running');
      starting = true;
      try {
        const response = await api.runPythonTask({ method, params });
        if (!response.ok) throw new Error(response.error);
        const promise = new Promise((resolve, reject) => pending.set(response.taskId, { resolve, reject, onProgress: options.onProgress }));
        for (const event of earlyEvents.get(response.taskId) || []) handle(event);
        earlyEvents.clear(); starting = false;
        try { if (options.onStarted) options.onStarted(response.taskId); } catch (error) { console.error(error); }
        return await promise;
      } finally { starting = false; earlyEvents.clear(); }
    },
    cancel: taskId => api.cancelPythonTask(taskId),
    healthCheck() { return this.run('health.check'); }
  };
  window.prepareLocalBlocks = async function(filePath,origin) {
    const result = await window.backendClient.run('block.parse',{filePath,origin}, {
      onProgress(event) { if(typeof showImportProgress==='function')showImportProgress(event.percent,event.message); }
    });
    const buffers=await api.readBlockData(result.key);
    if(!buffers.ok)throw new Error(buffers.error);
    const m=buffers.matrices,c=buffers.chunks;
    const matrices=new Float32Array(m.buffer.slice(m.byteOffset,m.byteOffset+m.byteLength));
    const chunks=new Float64Array(c.buffer.slice(c.byteOffset,c.byteOffset+c.byteLength));
    const groups=result.metadata.groups.map(group=>{
      if(group.matrixOffset+group.count*16>matrices.length||group.chunkOffset+group.chunkLength>chunks.length)throw new Error('The block model binary cache is incomplete');
      return {...group,matrices:matrices.subarray(group.matrixOffset,group.matrixOffset+group.count*16),chunkBounds:chunks.subarray(group.chunkOffset,group.chunkOffset+group.chunkLength)};
    });
    console.log('[Local block model parsing]',result.cacheHit?'Cache hit':'Initial parsing',result.elapsedMs+'ms');
    return {...result.metadata,groups};
  };
  window.parseLocalModel = async function(filePath, strFilePath, fallback) {
    if (!filePath || !window.backendClient.available || !api.readModelGeometry) return fallback();
    const result = await window.backendClient.run(/\.asc$/i.test(filePath)?'terrain.parse':'model.parse', { filePath, strFilePath: strFilePath || null }, {
      onProgress(event) { if (typeof showImportProgress === 'function') showImportProgress(event.percent,event.message); }
    });
    const buffers = await api.readModelGeometry(result.key);
    if (!buffers.ok) throw new Error(buffers.error);
    const vertexBytes = buffers.vertices, indexBytes = buffers.indices;
    const VertexArray=result.metadata.vertexType==='float64'?Float64Array:Float32Array;
    const vertices = new VertexArray(vertexBytes.buffer.slice(vertexBytes.byteOffset,vertexBytes.byteOffset+vertexBytes.byteLength));
    const indices = new Uint32Array(indexBytes.buffer.slice(indexBytes.byteOffset,indexBytes.byteOffset+indexBytes.byteLength));
    if (vertices.length !== result.metadata.vertexCount*3 || indices.length !== result.metadata.triangleCount*3) throw new Error('The model binary cache is incomplete');
    console.log('[Local model parsing]',filePath,result.cacheHit?'Cache hit':'Initial parsing',result.elapsedMs+'ms');
    const geo=Object.assign({},result.metadata,{id:'local_'+result.key.slice(0,16),vertices,indices});
    if(buffers.edges){const e=buffers.edges;geo.boundaryZeroVertices=Array.from(new Uint32Array(e.buffer.slice(e.byteOffset,e.byteOffset+e.byteLength)));if(geo.boundaryZeroVertices.length!==result.metadata.boundaryZeroCount)throw new Error('The elevation boundary cache is incomplete');}
    return geo;
  };
  window.addEventListener('unload', () => {
    if (unsubscribe) unsubscribe();
    for (const task of pending.values()) task.reject(new Error('Page closed'));
    pending.clear();
  });
})();
