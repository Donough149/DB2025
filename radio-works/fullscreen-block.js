
/* =====================================================================
   FULLSCREEN TOGGLE
   iOS only honors apple-mobile-web-app-capable in standalone (Home
   Screen) launches -- a Shortcut's "Open URLs" step always opens a normal
   Safari tab with its own chrome, and no meta tag changes that. The
   Fullscreen API is the one thing that DOES work inside a plain tab, but
   it needs a real user gesture, so this is a tap control, not automatic.
   ===================================================================== */
(function(){
  if(!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)) return;

  var btn=document.createElement('button');
  btn.setAttribute('aria-label','Toggle fullscreen');
  btn.style.cssText='position:fixed;z-index:999998;right:10px;'
    +'top:calc(env(safe-area-inset-top,0px) + 10px);'
    +'width:34px;height:34px;border-radius:9px;border:1px solid rgba(255,255,255,.14);'
    +'background:rgba(255,255,255,.08);backdrop-filter:blur(6px);'
    +'display:flex;align-items:center;justify-content:center;padding:0;'
    +'-webkit-tap-highlight-color:transparent;';
  btn.innerHTML='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f4f4f8" stroke-width="2" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';

  function isFS(){ return !!(document.fullscreenElement||document.webkitFullscreenElement); }
  function sync(){ btn.style.opacity=isFS()?'0.45':'0.85'; }
  btn.onclick=function(){
    try{
      if(isFS()){
        (document.exitFullscreen||document.webkitExitFullscreen).call(document);
      }else{
        var el=document.documentElement;
        (el.requestFullscreen||el.webkitRequestFullscreen).call(el);
      }
    }catch(e){}
  };
  document.addEventListener('fullscreenchange',sync);
  document.addEventListener('webkitfullscreenchange',sync);

  function mount(){ document.body.appendChild(btn); sync(); }
  if(document.body) mount(); else document.addEventListener('DOMContentLoaded',mount);
})();
