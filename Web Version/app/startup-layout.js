(function(){
  let completed=false;
  function reveal(){if(completed)return;completed=true;window.dispatchEvent(new Event('resize'));document.documentElement.classList.remove('app-initializing');window.__startupLayoutReady=true;window.dispatchEvent(new Event('app-layout-ready'));}
  function ready(){window.dispatchEvent(new Event('resize'));if(document.hidden){setTimeout(reveal,30);return;}requestAnimationFrame(()=>{window.dispatchEvent(new Event('resize'));requestAnimationFrame(reveal);});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
})();
