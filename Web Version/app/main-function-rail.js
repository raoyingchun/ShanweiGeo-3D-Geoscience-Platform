(function(){
  const rail=document.createElement('nav');rail.id='main-function-rail';rail.className='main-function-rail';rail.setAttribute('aria-label','View tools');
  const linkage=document.getElementById('btn-toggle-right-panel');linkage.classList.add('rail-action');const icon=linkage.querySelector('svg');const text=document.createElement('span');text.className='rail-action-label';text.textContent='Linked 2D View';linkage.replaceChildren(icon,text);linkage.setAttribute('aria-label','Linked 2D View');rail.append(linkage);
  const comparison=document.createElement('button');comparison.id='btn-region-compare';comparison.type='button';comparison.className='rail-action';comparison.disabled=true;comparison.title='Region Comparison (Not connected yet) ';comparison.setAttribute('aria-label','Region Comparison');comparison.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg><span class="rail-action-label">Region Comparison</span>';rail.append(comparison);
  const utilities=document.createElement('button');utilities.id='btn-utilities';utilities.type='button';utilities.className='rail-action';utilities.title='Utilities';utilities.setAttribute('aria-label','Utilities');utilities.setAttribute('aria-haspopup','menu');utilities.setAttribute('aria-expanded','false');
  utilities.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 6a5 5 0 0 0-6 6L3 17a3 3 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-4 4-4-4z"/></svg><span class="rail-action-label">Utilities</span>';rail.append(utilities);
  const menu=document.createElement('div');menu.id='utilities-rail-menu';menu.className='ctx-menu';menu.setAttribute('role','menu');menu.hidden=true;menu.style.cssText='position:fixed;display:none;z-index:10000;min-width:160px;';
  const coordinates=document.getElementById('utility-coordinates');
  if(coordinates){coordinates.className='ctx-menu-item';coordinates.setAttribute('role','menuitem');menu.append(coordinates);}
  document.getElementById('group-utilities')?.remove();document.body.append(menu);
  function closeMenu(focus=false){menu.hidden=true;menu.style.display='none';utilities.classList.remove('active');utilities.setAttribute('aria-expanded','false');if(focus)utilities.focus();}
  utilities.onclick=()=>{if(!menu.hidden){closeMenu();return;}const rect=utilities.getBoundingClientRect();menu.hidden=false;menu.style.display='block';menu.style.right=(innerWidth-rect.left+8)+'px';menu.style.top=Math.max(8,Math.min(rect.top,innerHeight-menu.offsetHeight-8))+'px';utilities.classList.add('active');utilities.setAttribute('aria-expanded','true');coordinates?.focus();};
  menu.addEventListener('click',event=>{if(event.target.closest('#utility-coordinates'))closeMenu();});
  document.addEventListener('pointerdown',event=>{if(!menu.hidden&&!menu.contains(event.target)&&!utilities.contains(event.target))closeMenu();});
  document.addEventListener('keydown',event=>{if(!menu.hidden&&event.key==='Escape'){event.preventDefault();closeMenu(true);}});
  window.addEventListener('resize',()=>closeMenu());
  document.querySelector('.main-wrap').append(rail);window.dispatchEvent(new Event('resize'));
})();
