(function(){
  const pending=new Map();
  function script(src){if(!pending.has(src))pending.set(src,new Promise((resolve,reject)=>{const tag=document.createElement('script');tag.src=src;tag.onload=resolve;tag.onerror=()=>{pending.delete(src);tag.remove();reject(new Error('Unable to load the local parsing library:  '+src));};document.head.append(tag);}));return pending.get(src);}
  window.ensureDocumentLibrary=async function(kind){
    if(kind==='excel'){if(!window.XLSX)await script('xlsx.full.min.js?v=20260909');window.__xlsxFailed=false;}
    else if(kind==='pdf'){if(!window.pdfjsLib)await script('lib/pdfjs/pdf.min.js');pdfjsLib.GlobalWorkerOptions.workerSrc='lib/pdfjs/pdf.worker.min.js';}
    else if(kind==='word'){if(!window.JSZip)await script('lib/docx-preview/jszip.min.js');if(!window.docx)await script('lib/docx-preview/docx-preview.min.js');}
  };
})();
