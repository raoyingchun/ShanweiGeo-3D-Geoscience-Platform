(function () {
  'use strict';
  const entry = document.getElementById('utility-coordinates');
  if (!entry) return;
  let dialog, busy = false, taskId = null, cancelRequested = false, disabledState = [];
  let page='single',sourceFiles=[],resultFiles=[];
  const $ = id => dialog.querySelector('#cs-' + id);
  const formats = ['Degrees:Minutes:Seconds','Degrees:Minutes','Degrees','Seconds','Milliseconds','Degrees.Minutes/seconds','Degrees.Minutes','Degrees°Minutes′Seconds″'];
  const ellipsoids = [['WGS84','WGS84'],['CGCS2000','CGCS2000'],['BJ54','Beijing 54'],['XA80','Xian 80 (National 80) ']];
  const fileFormats=[
    ['XYH Space txt','Space-delimited: Point ID X Y Elevation','cartesian'],['XYH Comma txt','Comma-delimited: Point ID,X,Y,Elevation','cartesian'],
    ['BLH Space txt','Space-delimited: Point ID Latitude Longitude Ellipsoidal height','blh'],['BLH Comma txt','Comma-delimited: Point ID,Latitude,Longitude,Ellipsoidal height','blh'],
    ['Projected comma-delimited CSV','Comma-delimited: Point ID,X,Y,Elevation','cartesian'],['CAD','Comma-delimited: Point ID,Other,Y,X,Elevation','cartesian']
  ];
  const type = side => dialog.querySelector(`input[name="cs-${side}-type"]:checked`).value;
  function status(message, error=false) { $('status').textContent=message; $('status').classList.toggle('error',error); }
  function clearOutput() { for(let i=0;i<3;i++) $('output-'+i).value=''; }
  function settings() {
    const request={sourceType:type('source'),targetType:type('target'),sourceEllipsoid:$('source-ellipsoid').value,
      targetEllipsoid:$('target-ellipsoid').value,sourceFormat:Number($('source-format').value),targetFormat:Number($('target-format').value)};
    if(request.sourceType==='xyh'||request.targetType==='xyh')request.projection=projection();
    return request;
  }
  function updateFileFormat() {
    const family=type('source')==='blh'?'blh':'cartesian';
    Array.from($('file-format').options).forEach((option,index)=>{option.disabled=fileFormats[index][2]!==family;});
    if($('file-format').selectedOptions[0].disabled)$('file-format').value=family==='blh'?'3':'1';
    const index=Number($('file-format').value);
    $('file-format-name').textContent=fileFormats[index][0];$('file-format-description').textContent=fileFormats[index][1]+' ; The data file must not contain a header row. ';
  }
  function setPage(value) {
    if(busy)return;page=value;
    dialog.querySelectorAll('[data-single]').forEach(el=>{el.hidden=page!=='single';});
    $('file-pane').hidden=page!=='files';$('file-output-row').hidden=page!=='files';
    $('file-format-panel').hidden=page!=='files';
    $('output-folder').hidden=page!=='files';
    $('single').classList.toggle('active',page==='single');$('file').classList.toggle('active',page==='files');
    updateFileFormat();
    if(page==='files')status('Select a format and source files, then select an output folder and convert. ');
  }
  function showPreview(name,text) {
    const preview=$('preview');$('preview-title').textContent=name;$('preview-text').textContent=text||'File is empty';
    if(!preview.open)preview.showModal();
  }
  function renderFiles() {
    const render=(container,files,source)=>{
      container.replaceChildren();
      if(!files.length){const empty=document.createElement('p');empty.className='cs-file-empty';empty.textContent=source?'No source file selected':'Show output files after conversion';container.append(empty);return;}
      files.forEach((record,index)=>{
        const button=document.createElement('button');button.className='cs-file-item';button.textContent=record.name;
        button.title=source?record.path:record.outputPath;
        button.onclick=()=>{container.querySelectorAll('.cs-file-item').forEach(el=>el.classList.remove('selected'));button.classList.add('selected');};
        button.ondblclick=()=>showPreview(record.name+'  (First 8KB) ',record.preview);
        button.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();showPreview(record.name+'  (First 8KB) ',record.preview);}};
        container.append(button);
      });
    };
    render($('source-files'),sourceFiles,true);render($('result-files'),resultFiles,false);
  }
  async function browseFiles() {
    $('file-input').click();
  }
  function detectFileFormat(preview) {
    const line=preview.split(/\r?\n/).find(value=>value.trim());
    if(!line)return '';
    const comma=line.includes(','),columns=line.trim().split(comma?',':/\s+/);
    if(columns.length<4)return '';
    const angles=columns.slice(1,3);
    if(angles.every(value=>/[NS EW]/i.test(value)&&(/[°′″]/.test(value)||value.includes(':')))) {
      dialog.querySelector('input[name="cs-source-type"][value="blh"]').checked=true;
      dialog.querySelector('input[name="cs-target-type"][value="xyh"]').checked=true;
      $('source-format').value=angles.some(value=>/[°′″]/.test(value))?'7':'0';
      $('file-format').value=comma?'3':'2';
      return 'Geographic coordinates detected, Angle format:  '+formats[Number($('source-format').value)]+'。';
    }
    if(Number(columns[1])>1000000&&Number(columns[1])<10000000&&Number(columns[2])>10000000&&Number(columns[2])<61000000) {
      dialog.querySelector('input[name="cs-source-type"][value="xyh"]').checked=true;
      dialog.querySelector('input[name="cs-target-type"][value="blh"]').checked=true;
      $('file-format').value=comma?'1':'0';
      return 'Projected coordinates with a zone prefix were detected, Zone number handled by original COORD file converter. ';
    }
    return '';
  }
  async function acceptFiles() {
    try {
      const selected=Array.from($('file-input').files);
      if(sourceFiles.length+selected.length>20)throw new Error('Maximum files per selection: 20 files. ');
      const additions=[];
      for(const file of selected){
        if(!file.path)throw new Error('Select a local file in the desktop application. ');
        if(file.size>10*1024*1024)throw new Error(file.name+' exceeds 10MB. ');
        if(sourceFiles.some(record=>record.path===file.path))continue;
        const bytes=await file.slice(0,8192).arrayBuffer();let preview;
        try{preview=new TextDecoder('utf-8',{fatal:true}).decode(bytes,{stream:true});}catch(_){preview=new TextDecoder('gb18030').decode(bytes);}
        additions.push({file,path:file.path,name:file.name,preview});
      }
      const detected=!sourceFiles.length&&additions.length?detectFileFormat(additions[0].preview):'';
      sourceFiles.push(...additions);resultFiles=[];updateLabels();updateFileFormat();renderFiles();
      if(type('source')==='xyh'||type('target')==='xyh')$('projection').open=true;
      status(detected+' Selected '+sourceFiles.length+' source files. Verify source/Target ellipsoid, central meridian and output folder before converting; The file does not contain these parameters. ');
    }catch(error){status(error.message,true);}finally{$('file-input').value='';}
  }
  async function chooseOutput() {
    try {
      if(!window.electronAPI?.showOpenDialog)throw new Error('Select an output folder in the desktop application. ');
      const result=await electronAPI.showOpenDialog({title:'Choose coordinate conversion output folder',properties:['openDirectory']});
      if(!result.canceled&&result.filePaths?.[0]){
        $('file-output-dir').value=result.filePaths[0];$('output-folder').title=result.filePaths[0];
        status('Output folder: '+result.filePaths[0]);
      }
    }catch(error){status(error.message,true);}
  }
  async function calculateFiles() {
    if(busy)return;
    try {
      if(!sourceFiles.length)throw new Error('Browse and select a source file first. ');
      if(!$('file-output-dir').value)throw new Error('Select an output folder. ');
      const request={...settings(),files:sourceFiles.map(record=>record.path),fileFormat:Number($('file-format').value),
        naming:$('file-naming').value,outputDir:$('file-output-dir').value,merge:false};
      resultFiles=[];renderFiles();cancelRequested=false;setBusy(true);status('Starting the original file converter…');
      const result=await backendClient.run('coord.native.batch',request,{
        onStarted:id=>{taskId=id;if(cancelRequested||!dialog.open)backendClient.cancel(id);},onProgress:event=>status(event.message)
      });
      resultFiles=result.results;renderFiles();
      const message='File conversion complete:  '+result.completed+'/'+result.requested+' files. Results saved to '+result.outputDir;
      status(message+(result.errors.length?'\n'+result.errors.map(error=>error.name+'：'+error.error).join('\n'):''),!!result.errors.length);
    }catch(error){status(error.message+(error.code==='CANCELLED'?'; Completed files remain in the output folder. ':''),true);}
    finally{taskId=null;cancelRequested=false;setBusy(false);}
  }
  function updateLabels() {
    for(const side of ['source','target']) {
      const kind=type(side), labels=kind==='blh'?['B=','L=','H=']:kind==='xyh'?['X=','Y=','h=']:['X=','Y=','Z='];
      labels.forEach((text,index)=>{$(side+'-label-'+index).textContent=text;});
      $(side+'-format').disabled=kind!=='blh';
    }
  }
  function updateProjection() {
    const mode=$('projection-mode').value,custom=mode==='custom',utm=mode==='utm';
    $('projection-k0').disabled=!utm;
    $('projection-x0').disabled=!(custom||utm);$('projection-y0').disabled=!(custom||utm);
    $('projection-height').disabled=!custom;$('projection-meanLat').disabled=!(custom||utm);
  }
  function projection() {
    const result={mode:$('projection-mode').value,north:$('projection-north').value==='north',east:$('projection-east').value==='east'};
    for(const key of ['lon0','k0','x0','y0','height','meanLat']) {
      const text=$('projection-'+key).value.trim();
      if(!text||!Number.isFinite(Number(text)))throw new Error('Enter valid map projection parameters. ');
      result[key]=Number(text);
    }
    return result;
  }
  function setBusy(value) {
    busy=value;
    if(value) {
      disabledState=Array.from(dialog.querySelectorAll('.cs-body button,.cs-foot button,.cs-body input,.cs-body select')).map(el=>[el,el.disabled]);
      disabledState.forEach(([el])=>{el.disabled=true;});
    } else {disabledState.forEach(([el,disabled])=>{el.disabled=disabled;});disabledState=[];updateLabels();updateProjection();}
    $('cancel').disabled=!value;
    $('file-cancel').disabled=!value;
  }
  async function calculate() {
    if(busy) return;
    try {
      const values=[0,1,2].map(i=>$('input-'+i).value.trim());
      if(values.some(value=>!value)) throw new Error('Enter all three source coordinate values. ');
      const request={sourceType:type('source'),targetType:type('target'),
        sourceEllipsoid:$('source-ellipsoid').value,targetEllipsoid:$('target-ellipsoid').value,
        sourceFormat:Number($('source-format').value),targetFormat:Number($('target-format').value),values};
      if(request.sourceType==='xyh'||request.targetType==='xyh') request.projection=projection();
      cancelRequested=false;clearOutput();setBusy(true);status('Starting original COORD…');
      const result=await backendClient.run('coord.native.convert',request,{
        onStarted:id=>{taskId=id;if(cancelRequested||!dialog.open)backendClient.cancel(id);}, onProgress:event=>status(event.message)
      });
      result.values.forEach((value,index)=>{$('output-'+index).value=value;});
      status('Conversion complete · Results from original COORD');
    } catch(error) {status(error.message,true);}
    finally {taskId=null;cancelRequested=false;setBusy(false);}
  }
  async function openOriginal() {
    try {
      if(!window.electronAPI?.openCoordTool) throw new Error('Restart the desktop application before launching the original tool. ');
      const result=await electronAPI.openCoordTool();
      if(!result.ok) throw new Error(result.error);
      status('Original application opened COORD. Configure parameters and convert files in the original application. ');
    } catch(error) {status(error.message,true);}
    dialog.querySelectorAll('details').forEach(el=>{el.open=false;});
  }
  function choice(side,title,selected) {
    return `<fieldset><legend>${title}</legend><div class="cs-options">
      <label class="cs-option"><input type="radio" name="cs-${side}-type" value="xyz" ${selected==='xyz'?'checked':''}>Geocentric Cartesian coordinates</label>
      <label class="cs-option"><input type="radio" name="cs-${side}-type" value="blh" ${selected==='blh'?'checked':''}>Geographic coordinates<select id="cs-${side}-format" aria-label="${title} Angle format">${formats.map((text,index)=>`<option value="${index}">${text}</option>`).join('')}</select></label>
      <label class="cs-option"><input type="radio" name="cs-${side}-type" value="xyh">Projected coordinates</label></div></fieldset>`;
  }
  function ellipse(side) {
    return `<label class="cs-ellipsoid">Ellipsoid<select id="cs-${side}-ellipsoid">${ellipsoids.map(([value,text])=>`<option value="${value}">${text}</option>`).join('')}</select></label>`;
  }
  function coords(side,title) {
    const source=side==='source';
    return `<fieldset><legend>${title}</legend><div class="cs-coordinates">${[0,1,2].map(i=>`<label><span id="cs-${side}-label-${i}"></span><input type="text" id="cs-${source?'input':'output'}-${i}" aria-label="${title} No. ${i+1} items" ${source?'maxlength="100"':'readonly'} spellcheck="false"></label>`).join('')}</div></fieldset>`;
  }
  function reset() {
    dialog.querySelector('input[name="cs-source-type"][value="blh"]').checked=true;
    dialog.querySelector('input[name="cs-target-type"][value="xyz"]').checked=true;
    for(const side of ['source','target']) {$(side+'-ellipsoid').value='WGS84';$(side+'-format').value='0';}
    $('projection-mode').value='gauss3';
    for(const [key,value] of Object.entries({lon0:114,k0:1,x0:0,y0:500000,height:0,meanLat:0,north:'north',east:'east'}))$('projection-'+key).value=value;
    $('projection').open=false;updateProjection();
    ['30:00:00.000000N','114:00:00.000000E','100'].forEach((value,i)=>{$('input-'+i).value=value;});
    clearOutput();updateLabels();status('Example coordinates loaded, Ready to convert. ');
  }
  function build() {
    dialog=document.createElement('dialog');dialog.id='coord-shell-dialog';dialog.className='coord-shell';
    dialog.setAttribute('aria-labelledby','cs-title');
    dialog.innerHTML=`<header class="cs-head"><div><h2 id="cs-title">COORD Coordinate Conversion</h2><p>Web interface · Original application computation</p></div><button id="cs-close" aria-label="Close">×</button></header>
      <div class="cs-body"><nav class="cs-menu" aria-label="Tools menu">
      <details><summary>File(F)</summary><div class="cs-menu-pop"><button id="cs-reset">Load example</button><button data-original>Open in original application / Save file</button></div></details>
      <details><summary>Settings(P)</summary><div class="cs-menu-pop"><button id="cs-projection-open">Map projection settings</button><button data-original>Configure additional parameters in the original application</button></div></details>
      <details><summary>Help(A)</summary><div class="cs-menu-pop"><button id="cs-help">Currently supported operations</button><button data-original>Open original COORD</button></div></details></nav>
      <div class="cs-layout">${choice('source','Source coordinate type','blh')}
      <fieldset><legend>Coordinate Conversion</legend><div class="cs-options"><label class="cs-option unavailable" title="Parameter configuration is not connected yet"><input type="checkbox" disabled>Seven-parameter transformation</label><label class="cs-option unavailable" title="Parameter configuration is not connected yet"><input type="checkbox" disabled>2D transformation</label><label class="cs-option unavailable" title="Parameter configuration is not connected yet"><input type="checkbox" disabled>Height fitting</label></div></fieldset>
      ${choice('target','Target coordinate type','xyz')}${ellipse('source')}<div></div>${ellipse('target')}
      ${coords('source','Source coordinates')}<div class="cs-convert-area"><button class="primary" id="cs-convert">Convert coordinates →</button><button id="cs-cancel" disabled>Cancel</button></div>${coords('target','Target coordinates')}</div>
      <details class="cs-projection" id="cs-projection"><summary>Map projection settings <span>Source, Shared target projected coordinates</span></summary><div class="cs-projection-fields">
      <label>Projection type<select id="cs-projection-mode"><option value="gauss3">Gauss-Kruger 3-degree zone</option><option value="gauss6">Gauss-Kruger 6-degree zone</option><option value="custom">Custom Gauss-Kruger projection</option><option value="utm">UTM Projection</option></select></label>
      <label>Central meridian (Degrees) <input id="cs-projection-lon0" type="number" step="any" value="114"></label>
      <label>Scale<input id="cs-projection-k0" type="number" step="any" value="1"></label>
      <label>X Constant (m) <input id="cs-projection-x0" type="number" step="any" value="0"></label>
      <label>Y Constant (m) <input id="cs-projection-y0" type="number" step="any" value="500000"></label>
      <label>Projection-plane elevation (m) <input id="cs-projection-height" type="number" step="any" value="0"></label>
      <label>Mean latitude (Degrees) <input id="cs-projection-meanLat" type="number" step="any" value="0"></label>
      <label>X Positive direction<select id="cs-projection-north"><option value="north">North</option><option value="south">South</option></select></label>
      <label>Y Positive direction<select id="cs-projection-east"><option value="east">East</option><option value="west">West</option></select></label></div>
      <p class="cs-note">The default projected coordinate order is X North, Y East, h; Other positive directions follow the settings above, Zone prefixes are not automatically added to input or output. Three/Scale and offsets for 6-degree zones follow the original application; Custom Gauss projection supports a scale factor and projection-plane elevation; UTM Scale factor is configurable. The latitude of origin is fixed at 0. </p></details>
      <div id="cs-file-pane" class="cs-file-pane" hidden><div class="cs-file-tools"><span>Select format</span><button id="cs-format-open">Format</button><small id="cs-file-format-name"></small><span>Select source files</span><button id="cs-browse">Browse…</button><button id="cs-clear-files">Clear list</button></div><div class="cs-file-list"><h3>Source files</h3><div id="cs-source-files"></div></div><div class="cs-file-arrow"><button class="primary" id="cs-file-convert">Convert →</button><button id="cs-file-cancel" disabled>Cancel</button></div><div class="cs-file-list"><h3>Output files</h3><div id="cs-result-files"></div></div></div>
      <div id="cs-file-output-row" class="cs-file-output-row" hidden><label>Output folder<input id="cs-file-output-dir" type="text" readonly placeholder="Select output folder"></label><button id="cs-output-folder">Choose folder…</button></div>
      <details id="cs-file-format-panel" class="cs-projection" hidden><summary>File format settings</summary><div class="cs-projection-fields"><label>Original preset formats<select id="cs-file-format">${fileFormats.map((record,index)=>`<option value="${index}" ${index===3?'selected':''}>${record[0]}</option>`).join('')}</select></label><label>Output naming<select id="cs-file-naming"><option value="extension">Append to extension 1: File.txt1</option><option value="stem">Append to filename 1: File1.txt</option><option value="same">Keep filename: File.txt (Keep source files) </option></select></label><label>Merge input and output data<input type="checkbox" disabled title="Merged output and custom formats are not connected yet, Use the original application"></label></div><p class="cs-note" id="cs-file-format-description"></p><p class="cs-note">Maximum per operation 20 files, each 10MB, Total 50MB. Source files are unchanged; Existing output files are preserved by using a new name. Use the original application for custom formats and merged data. </p></details>
      <input id="cs-file-input" type="file" accept=".txt,.txt1,.csv,.dat,*/*" multiple hidden>
      <div class="cs-foot"><button class="active" id="cs-single">Single point</button><button id="cs-file">Batch files</button><span class="spacer"></span><button id="cs-original" data-original>Open original COORD</button></div>
      <p class="cs-status" id="cs-status" role="status" aria-live="polite"></p>
      </div>`;
    document.body.append(dialog);
    dialog.append(dialog.querySelector('.cs-foot'));
    dialog.querySelector('.cs-foot').insertBefore($('output-folder'),$('original'));
    $('output-folder').textContent='Output folder…';
    for(const id of ['input-0','output-0'])$(id).closest('fieldset').dataset.single='true';
    $('convert').parentElement.dataset.single='true';
    const preview=document.createElement('dialog');preview.id='cs-preview';preview.className='cs-preview';
    preview.innerHTML='<header><h3 id="cs-preview-title"></h3><button id="cs-preview-close" aria-label="Close preview">×</button></header><pre id="cs-preview-text"></pre>';
    dialog.append(preview);$('preview-close').onclick=()=>preview.close();
    $('close').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{if(busy)cancelRequested=true;if(taskId) backendClient.cancel(taskId);});
    $('convert').onclick=calculate;
    $('cancel').onclick=()=>{if(busy){cancelRequested=true;$('cancel').disabled=true;status('Canceling…');}if(taskId) backendClient.cancel(taskId);};
    $('reset').onclick=()=>{reset();dialog.querySelectorAll('details').forEach(el=>{el.open=false;});};
    $('single').onclick=()=>setPage('single');$('file').onclick=()=>setPage('files');
    $('browse').onclick=browseFiles;$('file-input').onchange=acceptFiles;$('output-folder').onclick=chooseOutput;
    $('file-convert').onclick=calculateFiles;$('file-cancel').onclick=$('cancel').onclick;
    $('clear-files').onclick=()=>{sourceFiles=[];resultFiles=[];renderFiles();status('File list cleared. ');};
    $('format-open').onclick=()=>{$('file-format-panel').open=true;$('file-format-panel').scrollIntoView({block:'nearest'});};
    $('help').onclick=()=>status('Geographic coordinate input B Latitude, L Longitude, H Ellipsoidal height; Projected coordinate input X North, Y East, h and confirm the map projection settings. All coordinate computations are performed by the original COORD Complete. ');
    $('projection-open').onclick=()=>{dialog.querySelectorAll('.cs-menu details').forEach(el=>{el.open=false;});$('projection').open=true;$('projection').scrollIntoView({block:'nearest'});};
    dialog.querySelectorAll('[data-original]').forEach(button=>{button.onclick=openOriginal;});
    dialog.addEventListener('input',event=>{if(event.target.id.startsWith('cs-input-')||event.target.id.startsWith('cs-projection-')) clearOutput();});
    dialog.addEventListener('change',event=>{
      if(event.target.name==='cs-source-type') [0,1,2].forEach(i=>{$('input-'+i).value='';});
      if(event.target.name?.endsWith('-type')&&(type('source')==='xyh'||type('target')==='xyh'))$('projection').open=true;
      if(event.target.id==='cs-projection-mode') {
        const mode=$('projection-mode').value;
        $('projection-k0').value=mode==='utm'?.9996:1;
        if(mode==='gauss3'||mode==='gauss6')for(const [key,value] of Object.entries({x0:0,y0:500000,height:0,meanLat:0}))$('projection-'+key).value=value;
        if(mode==='utm')$('projection-height').value=0;
        updateProjection();
      }
      clearOutput();updateLabels();
      updateFileFormat();resultFiles=[];renderFiles();
    });
    reset();updateFileFormat();renderFiles();setPage('single');
  }
  function open(){if(!dialog) build();if(!dialog.open) dialog.showModal();}
  entry.addEventListener('click',open);
  entry.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
})();
