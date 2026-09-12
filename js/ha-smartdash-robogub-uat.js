(function(){
  const IDS={
    activity:"sensor.robogub_aktivitetstilstand",
    location:"sensor.robogub_nuvaerende_placering",
    progress:"sensor.robogub_fremdrift",
    remaining:"sensor.robogub_tid_tilbage",
    mower:"lawn_mower.robogub",
    camera:"camera.robogub",
    cancel:"button.robogub_annuller_nuvaerende_opgave",
    slope4:"button.robogub_skraning_nr_4",
    task3:"button.have_robogub_opgave_3"
  };
  let timer=0;
  function state(id){return window.BeastHaSocket?.getState(id)?.state||""}
  function entity(id){return window.BeastHaSocket?.getState(id)||null}
  function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
  function duration(v){const n=Number(v);if(!Number.isFinite(n)||n<=0)return "–";if(n<60)return `${Math.round(n)} min`;const h=Math.floor(n/60),m=Math.round(n%60);return m?`${h} t ${m} min`:`${h} t`}
  function normalizedState(){return `${state(IDS.mower)} ${state(IDS.activity)}`.toLowerCase()}
  function isPaused(){return /paus/.test(normalizedState())}
  function isReturning(){return /return|going.?home|på vej hjem/.test(normalizedState())}
  function isDocked(){return /dock|charg/.test(`${normalizedState()} ${state(IDS.location).toLowerCase()}`)}
  function isWorking(){const value=normalizedState();return (/work|mow|cut/.test(value)&&!/not.?work|ready|idle|charg|dock|return/.test(value))}
  function friendlyActivity(){
    const raw=state(IDS.activity)||state(IDS.mower)||"Ukendt";
    const labels={MODE_READY:"Klar",MODE_WORKING:"Arbejder",MODE_RETURNING:"På vej hjem",MODE_CHARGING:"Oplader",MODE_PAUSED:"Pause",MODE_ERROR:"Fejl"};
    return labels[raw]||raw;
  }
  async function service(domain,name,data){
    return window.BeastAuth.haFetch(`/api/services/${domain}/${name}`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(data||{})
    });
  }
  function press(id){return service("button","press",{entity_id:id})}
  function mowerService(name){return service("lawn_mower",name,{entity_id:IDS.mower})}
  function taskMarkup(id,label){
    return `<button type="button" class="beast-robogub-task" data-robogub-compat-button="${esc(id)}">${window.BeastCore.icon("check",{size:17})}<span>${esc(label)}</span></button>`;
  }
  function ensureTask(grid,id,label){
    if(!grid||!entity(id)||entity(id).state==="unavailable")return;
    if(grid.querySelector(`[data-robogub-compat-button="${CSS.escape(id)}"]`))return;
    grid.insertAdjacentHTML("beforeend",taskMarkup(id,label));
  }
  function ensureActionButton(actions,key,label,icon){
    if(!actions)return null;
    let button=actions.querySelector(`[data-robogub-compat-action="${key}"]`);
    if(!button){
      button=document.createElement("button");
      button.type="button";
      button.className="beast-robogub-action";
      button.dataset.robogubCompatAction=key;
      button.innerHTML=`${window.BeastCore.icon(icon,{size:19})}<span>${esc(label)}</span>`;
      actions.prepend(button);
    }
    return button;
  }
  function setActionLabel(button,label,icon){
    if(!button)return;
    button.innerHTML=`${window.BeastCore.icon(icon,{size:19})}<span>${esc(label)}</span>`;
  }
  function ensureCameraStyles(){
    if(document.getElementById("beastRobogubCameraStyles"))return;
    const style=document.createElement("style");
    style.id="beastRobogubCameraStyles";
    style.textContent=`
      .beast-robogub-camera-overlay{position:fixed;inset:0;z-index:10050;background:rgba(3,6,10,.78);backdrop-filter:blur(8px);display:grid;place-items:center;padding:clamp(12px,3vw,36px)}
      .beast-robogub-camera-modal{width:min(1100px,96vw);max-height:92vh;background:var(--surface-solid,#11151a);border:1px solid var(--border);border-radius:22px;box-shadow:0 24px 80px rgba(0,0,0,.45);overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr)}
      .beast-robogub-camera-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 16px;border-bottom:1px solid var(--border)}
      .beast-robogub-camera-head small{display:block;color:var(--ink-muted);text-transform:uppercase;letter-spacing:.06em}.beast-robogub-camera-head strong{display:block;font-size:var(--text-lg);margin-top:2px}
      .beast-robogub-camera-close{width:46px;height:46px;border:1px solid var(--border-strong);border-radius:14px;background:var(--surface-2);color:var(--ink);font-size:28px;line-height:1}
      .beast-robogub-camera-stage{position:relative;min-height:320px;background:#050608;display:grid;place-items:center;overflow:hidden}
      .beast-robogub-camera-stage img{display:block;width:100%;height:100%;max-height:78vh;object-fit:contain;background:#050608}
      .beast-robogub-camera-note{padding:28px;color:var(--ink-muted);text-align:center;max-width:520px}
      .beast-robogub-camera-live{position:absolute;left:14px;top:14px;z-index:2;padding:6px 9px;border-radius:999px;background:rgba(0,0,0,.62);color:#fff;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
      @media (orientation:portrait){.beast-robogub-camera-modal{width:min(96vw,900px)}.beast-robogub-camera-stage{min-height:min(64vh,760px)}}
    `;
    document.head.appendChild(style);
  }
  function closeCameraModal(overlay){
    const img=overlay?.querySelector("img");
    if(img)img.src="";
    overlay?.remove();
  }
  function openCameraModal(){
    document.querySelector(".beast-robogub-camera-overlay")?.remove();
    ensureCameraStyles();
    const camera=entity(IDS.camera);
    const token=camera?.attributes?.access_token||"";
    const proxy=window.BeastAuth?.HA_PROXY_PATH||"/ha";
    const streamUrl=token?`${proxy}/api/camera_proxy_stream/${IDS.camera}?token=${encodeURIComponent(token)}`:"";
    const overlay=document.createElement("div");
    overlay.className="beast-robogub-camera-overlay";
    overlay.innerHTML=`<div class="beast-robogub-camera-modal" role="dialog" aria-modal="true" aria-label="RoboGub kamera"><div class="beast-robogub-camera-head"><div><small>Kamera</small><strong>RoboGub live</strong></div><button type="button" class="beast-robogub-camera-close" aria-label="Luk kamera">×</button></div><div class="beast-robogub-camera-stage">${streamUrl?`<span class="beast-robogub-camera-live">Live</span><img alt="Live kamera fra RoboGub">`:`<div class="beast-robogub-camera-note"><strong>Kamerastream er ikke tilgængelig</strong><br>Home Assistant eksponerer ikke et adgangstoken til camera.robogub.</div>`}</div></div>`;
    document.body.appendChild(overlay);
    const img=overlay.querySelector("img");
    if(img)img.src=streamUrl;
    overlay.addEventListener("click",event=>{if(event.target===overlay||event.target.closest(".beast-robogub-camera-close"))closeCameraModal(overlay)});
    const onKey=event=>{if(event.key!=="Escape")return;document.removeEventListener("keydown",onKey);closeCameraModal(overlay)};
    document.addEventListener("keydown",onKey);
  }
  function update(){
    const consoleEl=document.querySelector(".beast-robogub-console");if(!consoleEl)return;
    const working=isWorking(),paused=isPaused(),returning=isReturning(),docked=isDocked();
    const activity=friendlyActivity(),rawLocation=state(IDS.location)||"",progress=Math.max(0,Math.min(100,Number(state(IDS.progress))||0)),remaining=duration(state(IDS.remaining));
    const activeLocation=(working||paused)?(rawLocation||"Aktiv opgave"):"Ingen aktiv opgave";
    const lower=consoleEl.querySelector(".beast-robogub-lower");
    if(lower){let current=lower.querySelector(".beast-robogub-current");if(!current){current=document.createElement("section");current.className="beast-robogub-current";lower.prepend(current)}current.innerHTML=`<div><small>Aktuel opgave</small><strong>${esc(activeLocation)}</strong></div><div class="beast-robogub-current-state"><span>${esc(activity)}</span><span>${progress}% · ${esc(remaining)}</span></div><div class="beast-robogub-progressbar" style="--robogub-progress:${progress}%"><span></span></div>`}
    const actions=consoleEl.querySelector(".beast-robogub-primary-actions");
    const pause=ensureActionButton(actions,"pause-resume","Pause","pause"),camera=ensureActionButton(actions,"camera","Kamera","camera"),stop=consoleEl.querySelector('[data-robogub-action="cancel"]'),dock=consoleEl.querySelector('[data-robogub-action="dock"]'),garden=consoleEl.querySelector('[data-robogub-action="garden4"]'),slope=consoleEl.querySelector('[data-robogub-action="slope4"]');
    if(pause){
      pause.hidden=!(working||paused);
      if(paused)setActionLabel(pause,"Fortsæt","play");else setActionLabel(pause,"Pause","pause");
      pause.disabled=!(working||paused);
    }
    if(camera){const cam=entity(IDS.camera);camera.hidden=!cam||cam.state==="unavailable";camera.disabled=!cam||cam.state==="unavailable"}
    if(stop){const disabled=!(working||paused);stop.dataset.smartDisabled=String(disabled);stop.disabled=disabled}
    if(dock){const disabled=docked||returning;dock.dataset.smartDisabled=String(disabled);dock.disabled=disabled}
    const startDisabled=working||paused||returning;
    [garden,slope].forEach(button=>{if(button)button.disabled=startDisabled});
    const grid=consoleEl.querySelector(".beast-robogub-task-grid");
    ensureTask(grid,IDS.slope4,"Skråning nr. 4");
    ensureTask(grid,IDS.task3,"Opgave-3");
    grid?.querySelectorAll("button").forEach(button=>{button.disabled=startDisabled});
  }
  function schedule(){clearTimeout(timer);timer=setTimeout(update,60)}
  async function runCommand(button,command){
    button.disabled=true;
    try{await command()}
    catch(error){window.BeastCore?.log?.(`RoboGub: handling fejlede (${error.message}).`)}
    finally{setTimeout(()=>{schedule()},800)}
  }
  document.addEventListener("click",event=>{
    const camera=event.target.closest?.('[data-robogub-compat-action="camera"]');
    const pause=event.target.closest?.('[data-robogub-compat-action="pause-resume"]');
    const stop=event.target.closest?.('[data-robogub-action="cancel"]');
    const dock=event.target.closest?.('[data-robogub-action="dock"]');
    const slope=event.target.closest?.('[data-robogub-action="slope4"]');
    const compat=event.target.closest?.("[data-robogub-compat-button]");
    if(!camera&&!pause&&!stop&&!dock&&!slope&&!compat)return;
    event.preventDefault();event.stopImmediatePropagation();
    if(camera){if(!camera.disabled)openCameraModal();return}
    const button=pause||stop||dock||slope||compat;
    if(button.disabled)return;
    if(pause){runCommand(button,()=>isPaused()?mowerService("start_mowing"):mowerService("pause"));return}
    if(stop){runCommand(button,()=>press(IDS.cancel));return}
    if(dock){runCommand(button,()=>mowerService("dock"));return}
    if(slope){runCommand(button,()=>press(IDS.slope4));return}
    runCommand(button,()=>press(button.dataset.robogubCompatButton));
  },true);
  const observer=new MutationObserver(schedule);observer.observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener("beast:ha-state",schedule);document.addEventListener("beast:page-rendered",schedule);window.addEventListener("load",schedule);schedule();
})();
