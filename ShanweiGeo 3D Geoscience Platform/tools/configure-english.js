// Post-build edition configuration, separate from source translation.
const fs=require('fs'),path=require('path');const root=path.resolve(__dirname,'..');
function edit(file,fn){const p=path.join(root,file);fs.writeFileSync(p,fn(fs.readFileSync(p,'utf8')));}
edit('main.js',s=>s.replaceAll('ShanweiGeo 3D Geoscience Platform-Test','ShanweiGeo 3D Geoscience Platform-English').replace("title: 'ShanweiGeo 3D Geoscience Platform 3D Geoscience Platform'","title: 'ShanweiGeo 3D Geoscience Platform — English Edition'"));
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));pkg.name='shanweigeo-platform';pkg.description='ShanweiGeo 3D Geoscience Platform 3D Geoscience Platform — English Edition';pkg.author='Rao Yingchun';pkg.build.appId='cn.shanwei.geology.english';pkg.build.productName='ShanweiGeo 3D Geoscience Platform';pkg.build.portable.artifactName='ShanweiGeo 3D Geoscience Platform-English.exe';pkg.scripts['build:english']='electron-builder --win zip --config build/english-release.json';fs.writeFileSync(path.join(root,'package.json'),JSON.stringify(pkg,null,2)+'\n');
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));lock.name=pkg.name;if(lock.packages?.[''])lock.packages[''].name=pkg.name;fs.writeFileSync(path.join(root,'package-lock.json'),JSON.stringify(lock,null,2)+'\n');
const config=JSON.parse(fs.readFileSync(path.join(root,'build/test-release.json'),'utf8'));config.appId='cn.shanwei.geology.english';config.productName='ShanweiGeo 3D Geoscience Platform';config.artifactName='ShanweiGeo 3D Geoscience Platform-Windows-x64.${ext}';config.directories.output='dist-english-20261021';config.extraFiles=[{from:'build/English-README.txt',to:'README.txt'},{from:'build/test-fixtures',to:'Sample Data'}];fs.writeFileSync(path.join(root,'build/english-release.json'),JSON.stringify(config,null,2));
// Keep asset IDs, paths and licensing metadata intact; localize display names only.
for(const f of ['rock-library.json','all-materials.json','all-images.json']){
 const p=path.join(root,'src/assets/textures',f);if(!fs.existsSync(p))continue;const data=JSON.parse(fs.readFileSync(p,'utf8'));
 function walk(value){if(!value||typeof value!=='object')return;for(const k of Object.keys(value)){if(['name','label','displayName','category','group','description'].includes(k)&&typeof value[k]==='string'&&/[\u3400-\u9fff]/.test(value[k])){const id=value.id||value.asset||'';value[k]=id?id.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()):value[k];}else if(typeof value[k]==='object')walk(value[k]);}}
 walk(data);fs.writeFileSync(p,JSON.stringify(data,null,2));
}
let html=fs.readFileSync(path.join(root,'src/index8.html'),'utf8');html=html.replace('</title>','</title>\n<link rel="stylesheet" href="app/english-layout.css">');fs.writeFileSync(path.join(root,'src/index8.html'),html);
fs.writeFileSync(path.join(root,'src/app/english-layout.css'),`/* English labels need more horizontal space. Data and document content retain their fonts. */
html[lang="en"] { --font-sans: "Segoe UI", Arial, sans-serif; }
html[lang="en"] .ctx-menu { min-width: 220px; }
html[lang="en"] .modal-dialog { max-width: calc(100vw - 40px); }
html[lang="en"] .modal-header { line-height: 1.4; }
html[lang="en"] .lp-sub-item > span, html[lang="en"] .lp-section-title { overflow: hidden; text-overflow: ellipsis; }
html[lang="en"] .prop-label { flex: 0 1 52%; }
html[lang="en"] .prop-value { min-width: 0; overflow-wrap: anywhere; }
html[lang="en"] .region-compare-header { flex-wrap: wrap; }
html[lang="en"] .cs-dialog { width: min(1040px, calc(100vw - 48px)); }
`);
// Category-name matching accepts both the original Chinese names and English labels.
edit('src/app/app_3.js',s=>s.replace(/\.indexOf\('(孔口|测斜|蚀变|地质|岩性|钻孔|地球化学)'\)/g,(_,k)=>'.search(/'+k+'|'+({'孔口':'Collar','测斜':'Survey','蚀变':'Alteration','地质':'Geolog','岩性':'Litholog','钻孔':'Drillhole','地球化学':'Geochem'}[k])+'/i)'));
console.log('English application identity, assets, layout and release configuration ready.');
// Final English-specific layout and backwards-compatible project loading.
edit('src/index8.html',s=>s.replace('app/app_4.js','app/app_4.js').replace('<script src="app/app_4.js"></script>','<script src="app/english-project-compat.js"></script>\n<script src="app/app_4.js"></script>'));
edit('src/app/app_4.js',s=>s.replace('async function restoreProject(data, options = {}) {','async function restoreProject(data, options = {}) {\n  data = window.normalizeLegacyProjectCategories(data);'));
edit('src/app/research-regions.js',s=>s.replace("badge.textContent='Current display'","badge.textContent='Active'"));
edit('src/index8.html',s=>s.replace('ShanweiGeo 3D Geoscience Platform Workspace','ShanweiGeo 3D Geoscience Platform'));
edit('src/app/english-layout.css',s=>s+`
html[lang="en"] .main-function-rail { overflow-x: hidden; }
html[lang="en"] .rail-action-label { text-orientation: mixed; letter-spacing: .3px; white-space: nowrap; }
html[lang="en"] .main-function-rail .rail-action { min-height: 148px; }
html[lang="en"] .coord-shell { width: min(1080px, 94vw); font-family: "Segoe UI", Arial, sans-serif; }
html[lang="en"] .cs-layout { grid-template-columns: minmax(0,1fr) 210px minmax(0,1fr); }
html[lang="en"] .coord-shell .cs-body button, html[lang="en"] .coord-shell .cs-foot button { font-family: "Segoe UI", Arial, sans-serif; }
html[lang="en"] .cs-option select { max-width: 155px; }
`);

// English edition: omit unused topic placeholders from the project tree.
edit('src/index8.html',s=>s.replace(/\s*<!-- 地球物理专题 -->[\s\S]*?(?=\s*<!-- 专题AI模型 -->)/,''));
