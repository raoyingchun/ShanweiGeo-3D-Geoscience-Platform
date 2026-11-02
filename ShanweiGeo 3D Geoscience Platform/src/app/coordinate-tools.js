(function () {
  'use strict';
  const entry = document.getElementById('utility-coordinates');
  if (!entry) return;
  const KEY = 'shanwei.coordinate.presets.v1';
  let mode = 'convert', taskId = null, busy = false, output = null, dialog = null;
  const ellipsoids = '<option value="WGS84">WGS84</option><option value="CGCS2000">CGCS2000</option><option value="BJ54">Beijing 54</option><option value="XA80">Xian 80 (National 80) </option>';
  const types = '<option value="blh">Longitude/latitude B,L,h</option><option value="xyh">Gauss-Kruger plane X North,Y East,h</option><option value="xyz">Geocentric Cartesian X,Y,Z</option>';
  function configCard(prefix, title) {
    return `<section class="coord-card"><h3>${title}</h3><div class="coord-fields">
      <label>Reference ellipsoid<select id="ct-${prefix}-ellipsoid">${ellipsoids}</select></label>
      <label>Coordinate type<select id="ct-${prefix}-type">${types}</select></label>
      <label>Central meridian (Degrees) <input id="ct-${prefix}-lon0" type="number" value="111" step="any"></label>
      <label>Latitude of origin (Degrees) <input id="ct-${prefix}-lat0" type="number" value="0" step="any"></label>
      <label>Scale factor k₀<input id="ct-${prefix}-k0" type="number" value="1" step="any"></label>
      <label>X False northing (m) <input id="ct-${prefix}-x0" type="number" value="0" step="any"></label>
      <label>Y False easting (m) <input id="ct-${prefix}-y0" type="number" value="500000" step="any"></label>
    </div></section>`;
  }
  function parameterFields(prefix, keys) {
    return keys.map(([key, label]) => `<label>${label}<input id="ct-${prefix}-${key}" type="number" step="any" value="0"></label>`).join('');
  }
  const $ = id => dialog.querySelector('#ct-' + id);
  function config(prefix) {
    return Object.fromEntries(['ellipsoid','type','lon0','lat0','k0','x0','y0'].map(key => [key, $(prefix + '-' + key).value]));
  }
  function parameters(prefix, keys) {
    return Object.fromEntries(keys.map(key => {
      const input = $(prefix + '-' + key);
      if (input.value.trim() === '') throw new Error('Parameters cannot be empty');
      const value = Number(input.value);
      if (!Number.isFinite(value)) throw new Error('Parameters must be valid numbers');
      return [key, value];
    }));
  }
  function settings() {
    return { version:1, source:config('source'), target:config('target'),
      helmert: {...parameters('seven', ['dx','dy','dz','rx','ry','rz','ppm']), convention:$('convention').value},
      plane:parameters('four', ['dx','dy','rotation','ppm']), useHelmert:$('use-seven').checked };
  }
  function loadSettings(data) {
    if (!data || data.version !== 1 || !data.source || !data.target) throw new Error('This coordinate parameter file is not supported');
    const fields = [];
    for (const prefix of ['source','target']) for (const key of ['ellipsoid','type','lon0','lat0','k0','x0','y0']) {
      const value = data[prefix][key];
      if (value === undefined) throw new Error('Parameter file is missing ' + key);
      if (key === 'ellipsoid' && !['WGS84','CGCS2000','BJ54','XA80'].includes(value)) throw new Error('Unsupported ellipsoid');
      if (key === 'type' && !['blh','xyh','xyz'].includes(value)) throw new Error('Unsupported coordinate type');
      if (!['ellipsoid','type'].includes(key) && !Number.isFinite(Number(value))) throw new Error('Invalid parameter value');
      fields.push([$(prefix + '-' + key), value]);
    }
    for (const [prefix, dataKey, keys] of [['seven','helmert',['dx','dy','dz','rx','ry','rz','ppm']], ['four','plane',['dx','dy','rotation','ppm']]]) {
      for (const key of keys) {
        const value = (data[dataKey] || {})[key] ?? 0;
        if (!Number.isFinite(Number(value))) throw new Error('Invalid transformation parameters');
        fields.push([$(prefix + '-' + key), value]);
      }
    }
    const convention = data.helmert && data.helmert.convention || 'position_vector';
    if (!['position_vector','coordinate_frame'].includes(convention)) throw new Error('Invalid rotation convention');
    fields.forEach(([input, value]) => { input.value = value; });
    $('convention').value = convention; $('use-seven').checked = !!data.useHelmert;
    invalidate(); updateMode();
  }
  function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
  function invalidate() { output = null; $('export').disabled = true; $('results').replaceChildren(); $('summary').textContent = ''; }
  function presets() {
    try { const data = JSON.parse(localStorage.getItem(KEY) || '{}'); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; }
    catch (_) { return {}; }
  }
  function refreshPresets() {
    $('preset-list').replaceChildren(new Option('Select a saved parameter preset', ''));
    Object.keys(presets()).forEach(name => $('preset-list').add(new Option(name, name)));
  }
  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], {type}));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function updateMode() {
    const fit = mode === 'fit', plane = mode === 'plane', fitMode = $('fit-mode').value;
    $('configs').hidden = plane || fit && fitMode === 'four';
    $('seven-card').hidden = mode !== 'convert';
    $('seven-fields').hidden = !$('use-seven').checked;
    $('four-card').hidden = !plane;
    $('fit-card').hidden = !fit;
    $('reverse-label').hidden = fit;
    const labels = {
      convert: 'Each row: Point ID (Optional) , B Latitude L Longitude h, or X North Y East h, or spatial X Y Z. Use decimal degrees for longitude and latitude, or Degrees:Minutes:Seconds. Remove zone prefixes from projected coordinates first, The zone is determined by the central meridian. h is ellipsoidal height, No automatic conversion to normal height. ',
      plane: 'Each row: Point ID (Optional) , Source X Source Y Elevation. Rotation follows the mathematical positive direction (Enter first, counterclockwise in the plane of the second axis) , Unit: arcseconds; Scale: ppm. Height is unchanged. ',
      fit: fitMode === 'four' ? 'Each row: Point ID (Optional) , Source X Source Y Target X Target Y. At least two distinct common points are required. ' : 'Each row: Point ID (Optional) , Source coordinates 1 Source coordinates 2 Source coordinates 3 Target coordinates 1 Target coordinates 2 Target coordinates 3. Coordinate types follow the settings above; Three parameters require at least 1 Point, Seven parameters require at least 3 non-collinear common points. '
    };
    $('input-note').textContent = labels[mode];
    dialog.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
  }
  function render(result) {
    output = result; $('export').disabled = false;
    const table = document.createElement('table'), head = document.createElement('thead'), tr = document.createElement('tr');
    result.headers.forEach(value => { const th = document.createElement('th'); th.textContent = value; tr.append(th); });
    head.append(tr); table.append(head);
    const body = document.createElement('tbody');
    result.rows.forEach(row => {
      const line = document.createElement('tr');
      row.forEach(value => { const td = document.createElement('td'); td.textContent = typeof value === 'number' ? value.toFixed(9) : value; line.append(td); });
      body.append(line);
    });
    table.append(body); $('results').replaceChildren(table);
    if (result.parameters) {
      const values = result.parameters;
      const targetPrefix = $('fit-mode').value === 'four' ? 'four' : 'seven';
      Object.entries(values).forEach(([key, value]) => { const input = $(targetPrefix + '-' + key); if (input) input.value = value; });
      if (targetPrefix === 'seven') { $('use-seven').checked = true; $('convention').value = values.convention; }
      $('summary').textContent = 'Estimate parameters: \n' + JSON.stringify(values, null, 2) + '\n Per point RMS: ' + result.rms.toFixed(6) + ' m\n' + result.note + '\n Parameters have been applied to the corresponding conversion panel, Switch to use. ';
    }
    status('Complete, Total ' + result.count + ' points. ');
  }
  function setBusy(value) {
    busy = value;
    dialog.querySelectorAll('.coord-body input,.coord-body select,.coord-body textarea,.coord-body button').forEach(el => { el.disabled = value; });
    $('cancel').disabled = !value;
    if (!value) $('export').disabled = !output;
  }
  async function calculate() {
    if (busy) return;
    try {
      const text = $('skip-header').checked ? $('input').value.split(/\r?\n/).slice(1).join('\n') : $('input').value;
      const common = {text, source:config('source'), target:config('target'), reverse:$('reverse').checked};
      let method, params;
      if (mode === 'convert') {
        method = 'coord.convert'; params = {...common};
        if ($('use-seven').checked) params.helmert = settings().helmert;
      } else if (mode === 'plane') { method = 'coord.plane'; params = {...common, parameters:settings().plane}; }
      else { method = 'coord.fit'; params = {...common, mode:$('fit-mode').value}; }
      invalidate(); setBusy(true); status('Starting local computation…');
      const result = await backendClient.run(method, params, {
        onStarted: id => { taskId = id; },
        onProgress: event => status(event.message + ' ' + event.percent + '%')
      });
      render(result);
    } catch (error) { status(error.message, true); }
    finally { taskId = null; setBusy(false); }
  }
  async function openLegacy() {
    try {
      if (!window.electronAPI || !electronAPI.openCoordTool) throw new Error('The original tool can only be launched from the desktop application, Restart the application after changes to the main process');
      const result = await electronAPI.openCoordTool();
      if (!result.ok) throw new Error(result.error);
      status('Original application opened COORD Application. ');
    } catch (error) { status(error.message, true); }
  }
  function build() {
    dialog = document.createElement('dialog'); dialog.className = 'coord-dialog'; dialog.id = 'coordinate-tools-dialog';
    dialog.setAttribute('aria-labelledby', 'ct-title');
    dialog.innerHTML = `<div class="coord-head"><h2 id="ct-title">Coordinate Conversion</h2><button id="ct-close" aria-label="Close">×</button></div>
      <div class="coord-body"><div class="coord-nav">
      <button data-mode="convert">Coordinate and projection conversion</button><button data-mode="plane">2D four-parameter transformation</button><button data-mode="fit">Estimate from common points</button><button id="ct-legacy">Open original COORD</button></div>
      <div class="coord-presets"><input id="ct-preset-name" placeholder="Parameter preset name" maxlength="80"><button id="ct-save-preset">Save parameters</button><select id="ct-preset-list"></select><button id="ct-load-preset">Load</button><button id="ct-export-config">Export parameters</button><button id="ct-import-config">Import parameters</button></div>
      <div class="coord-grid" id="ct-configs">${configCard('source','Source coordinates')}${configCard('target','Target coordinates')}</div>
      <section class="coord-card" id="ct-seven-card"><label><input type="checkbox" id="ct-use-seven"> Apply local three-/Seven parameters (Transformation between datums requires parameters) </label>
      <div id="ct-seven-fields"><div class="coord-fields">${parameterFields('seven', [['dx','ΔX (m) '],['dy','ΔY (m) '],['dz','ΔZ (m) '],['rx','Rx (arcsec) '],['ry','Ry (arcsec) '],['rz','Rz (arcsec) '],['ppm','Scale change (ppm) ']])}
      <label>Rotation convention<select id="ct-convention"><option value="position_vector">Position vector (EPSG 1033) </option><option value="coordinate_frame">Coordinate frame (EPSG 1032) </option></select></label></div>
      <p class="coord-note">Use small-angle Helmert Model; For a three-parameter transformation, set rotation and scale to 0. The inverse uses matrix inversion. Use parameters derived from local control points or independently verified results. </p></div></section>
      <section class="coord-card" id="ct-four-card"><h3>Four parameters</h3><div class="coord-fields">${parameterFields('four',[['dx','ΔX (m) '],['dy','ΔY (m) '],['rotation','Rotate (arcsec) '],['ppm','Scale change (ppm) ']])}</div></section>
      <section class="coord-card" id="ct-fit-card"><label>Fitting method<select id="ct-fit-mode"><option value="four">2D four-parameter</option><option value="three">3D three-parameter</option><option value="seven">3D seven-parameter</option></select></label></section>
      <p class="coord-note" id="ct-input-note"></p><textarea id="ct-input" aria-label="Coordinates to transform" spellcheck="false">P1,30,111,100</textarea>
      <div class="coord-actions"><button id="ct-import-data">Import CSV / TXT</button><label><input id="ct-skip-header" type="checkbox"> First row is a header</label><label id="ct-reverse-label"><input id="ct-reverse" type="checkbox"> Inverse transformation (Enter target coordinates, Include source coordinates) </label><button id="ct-example">Load example</button><button class="primary" id="ct-run">Calculate</button><button id="ct-cancel" disabled>Cancel</button><button id="ct-export" disabled>Export results CSV</button></div>
      <div id="ct-status" class="coord-status" role="status" aria-live="polite"></div><div class="coord-summary" id="ct-summary"></div><div class="coord-results" id="ct-results"></div>
      <p class="coord-note">Built-in tools: Coordinate notation conversion, Forward/inverse Gauss-Kruger projection, Three/Four/Seven-parameter estimation and transformation, Batch CSV/TXT, Save parameter preset. The original application's grid fitting, EGM96/Geoid99, ITRF and one-step method are not built in yet, Use“Open original COORD”Use. The original application runs from your configured folder. </p>
      <input id="ct-data-file" type="file" accept=".csv,.txt,.dat" hidden><input id="ct-config-file" type="file" accept=".json" hidden></div>`;
    document.body.append(dialog);
    $('target-type').value = 'xyh';
    dialog.querySelectorAll('[data-mode]').forEach(button => button.onclick = () => { mode = button.dataset.mode; invalidate(); updateMode(); });
    $('close').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { if (taskId) backendClient.cancel(taskId); });
    $('run').onclick = calculate; $('legacy').onclick = openLegacy;
    $('cancel').onclick = () => { if (taskId) backendClient.cancel(taskId); };
    $('fit-mode').onchange = () => { invalidate(); updateMode(); };
    $('use-seven').onchange = () => { invalidate(); updateMode(); };
    dialog.addEventListener('input', event => { if (!event.target.id.startsWith('ct-preset')) invalidate(); });
    dialog.addEventListener('change', event => { if (!event.target.id.startsWith('ct-preset')) invalidate(); });
    $('example').onclick = () => {
      $('skip-header').checked = false; $('reverse').checked = false;
      if (mode === 'convert') {
        for (const prefix of ['source','target']) { $(prefix+'-ellipsoid').value='WGS84'; $(prefix+'-lon0').value=111; }
        $('source-type').value='blh'; $('target-type').value='xyh'; $('use-seven').checked=false;
        $('input').value='P1,30,111,100\nP2,30:30:00,112:00:00,80';
      } else if (mode === 'plane') $('input').value='P1,1000,2000,50\nP2,1100,2200,60';
      else if ($('fit-mode').value === 'four') $('input').value='P1,0,0,100,200\nP2,100,0,200,200\nP3,0,100,100,300';
      else {
        $('source-type').value='xyz'; $('target-type').value='xyz';
        $('input').value='P1,6378137,0,0,6378147,20,30\nP2,0,6378137,0,10,6378157,30\nP3,0,0,6356752,10,20,6356782';
      }
      invalidate(); updateMode();
    };
    $('save-preset').onclick = () => {
      try {
        const name = $('preset-name').value.trim(); if (!name) throw new Error('Enter a parameter preset name');
        const data = presets(); Object.defineProperty(data, name, {value:settings(),enumerable:true,configurable:true,writable:true});
        localStorage.setItem(KEY, JSON.stringify(data)); refreshPresets(); status('Parameter preset saved. ');
      } catch (error) { status(error.message, true); }
    };
    $('load-preset').onclick = () => { try { loadSettings(presets()[$('preset-list').value]); status('Parameter preset loaded. '); } catch(error) {status(error.message,true);} };
    $('export-config').onclick = () => { try { download('Coordinate transformation parameters.json',JSON.stringify(settings(),null,2),'application/json'); } catch(error) {status(error.message,true);} };
    $('import-config').onclick = () => $('config-file').click();
    $('config-file').onchange = async () => {
      try { const file=$('config-file').files[0]; if(file) {loadSettings(JSON.parse(await file.text()));status('Parameter file loaded. ');} }
      catch(error) {status(error.message,true);} finally {$('config-file').value='';}
    };
    $('import-data').onclick = () => $('data-file').click();
    $('data-file').onchange = async () => {
      try {
        const file=$('data-file').files[0]; if(!file) return;
        if(file.size>1024*1024) throw new Error('File exceeds 1MB, Import in smaller batches');
        const bytes=await file.arrayBuffer(); let text;
        try {text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch(_) {text=new TextDecoder('gb18030').decode(bytes);}
        $('input').value=text; invalidate(); status('Imported '+file.name+' , Check the column order and header settings. ');
      } catch(error) {status(error.message,true);} finally {$('data-file').value='';}
    };
    $('export').onclick = () => {
      if(!output) return;
      const cell = value => '"'+String(typeof value==='number'?value.toFixed(10):value).replace(/"/g,'""')+'"';
      download('Coordinate transformation results.csv','\ufeff'+[output.headers,...output.rows].map(row=>row.map(cell).join(',')).join('\r\n'),'text/csv;charset=utf-8');
    };
    refreshPresets(); updateMode();
  }
  function open() { if(!dialog) build(); if(!dialog.open) dialog.showModal(); }
  entry.onclick = open;
  entry.onkeydown = event => { if(event.key==='Enter'||event.key===' ') {event.preventDefault();open();} };
})();
