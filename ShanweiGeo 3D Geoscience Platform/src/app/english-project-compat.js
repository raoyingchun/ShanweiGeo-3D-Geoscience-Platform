(function(){
 'use strict';
 // Translate only built-in category metadata when loading an older Chinese project.
 // Filenames, paths, research names, tables, notes and model geometry are untouched.
 const categories={
  '矿体':'Orebody','地层':'Formation','构造':'Structure','蚀变':'Alteration',
  '地球化学':'Geochemistry','三维坑道模型':'3D Tunnel Models','三维块体模型':'3D Block Models',
  '钻孔孔口':'Drillhole Collars','钻孔岩性':'Drillhole Lithology','钻孔轨迹':'Drillholes Trajectory',
  '遥感影像':'Remote Sensing Imagery','地形图':'Topographic map','高程':'Elevation',
  '剖面图':'Cross Sections','中段图':'Level Plans','矿权图':'Mining Rights Maps','地质图':'Geological Maps'
 };
 window.normalizeLegacyProjectCategories=function(value){
  if(!value||typeof value!=='object')return value;
  const data=structuredClone(value);
  function model(m){if(!m||typeof m!=='object')return;const metadata=m.metadata||m;if(categories[metadata.category])metadata.category=categories[metadata.category];}
  for(const v of data.viewers||[])for(const m of v.models||[])model(m);
  for(const m of data.scene?.models||[])model(m);
  function tree(t){if(!t)return;
   for(const group of t.models3d||[])for(const c of group.children||[])if(categories[c.name])c.name=categories[c.name];
   for(const group of t.drawing||[])for(const c of group.children||[])if(categories[c.name])c.name=categories[c.name];
   for(const c of t.surface||[])if(categories[c.name])c.name=categories[c.name];
  }
  tree(data.tree);
  const trees=data.researchAreas?.trees;
  if(trees&&typeof trees==='object')for(const t of Object.values(trees))tree(t);
  return data;
 };
})();
