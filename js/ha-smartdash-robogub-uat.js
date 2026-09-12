(function(){
  const IDS={
    activity:"sensor.robogub_aktivitetstilstand",
    location:"sensor.robogub_nuvaerende_placering",
    progress:"sensor.robogub_fremdrift",
    remaining:"sensor.robogub_tid_tilbage",
    mower:"lawn_mower.robogub",
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
  function ensurePauseButton(actions){
    if(!actions)return null;
    let button=actions.querySelector('[data-robogub-compat-action="pause-resume"]');
    if(!button){
      button=document.createElement("button");
      button.type="button";
      button.className="beast-robogub-action";
      button.dataset.robogubCompatAction="pause-resume";
      actions.prepend(button);
    }
    return button;
  }
  function setActionLabel(button,label,icon){
    if(!button)return;
    button.innerHTML=`${window.BeastCore.icon(icon,{size:19})}<span>${esc(label)}</span>`;
  }
  function update(){
    const consoleEl=document.querySelector(".beast-robogub-console");if(!consoleEl)return;
    const working=isWorking(),paused=isPaused(),returning=isReturning(),docked=isDocked();
    const activity=friendlyActivity(),rawLocation=state(IDS.location)||"",progress=Math.max(0,Math.min(100,Number(state(IDS.progress))||0)),remaining=duration(state(IDS.remaining));
    const activeLocation=(working||paused)?(rawLocation||"Aktiv opgave"):"Ingen aktiv opgave";
    const lower=consoleEl.querySelector(".beast-robogub-lower");
    if(lower){let current=lower.querySelector(".beast-robogub-current");if(!current){current=document.createElement("section");current.className="beast-robogub-current";lower.prepend(current)}current.innerHTML=`<div><small>Aktuel opgave</small><strong>${esc(activeLocation)}</strong></div><div class="beast-robogub-current-state"><span>${esc(activity)}</span><span>${progress}% · ${esc(remaining)}</span></div><div class="beast-robogub-progressbar" style="--robogub-progress:${progress}%"><span></span></div>`}
    const actions=consoleEl.querySelector(".beast-robogub-primary-actions");
    const pause=ensurePauseButton(actions),stop=consoleEl.querySelector('[data-robogub-action="cancel"]'),dock=consoleEl.querySelector('[data-robogub-action="dock"]'),garden=consoleEl.querySelector('[data-robogub-action="garden4"]'),slope=consoleEl.querySelector('[data-robogub-action="slope4"]');
    if(pause){
      pause.hidden=!(working||paused);
      if(paused)setActionLabel(pause,"Fortsæt","play");else setActionLabel(pause,"Pause","pause");
      pause.disabled=!(working||paused);
    }
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
    const pause=event.target.closest?.('[data-robogub-compat-action="pause-resume"]');
    const stop=event.target.closest?.('[data-robogub-action="cancel"]');
    const dock=event.target.closest?.('[data-robogub-action="dock"]');
    const slope=event.target.closest?.('[data-robogub-action="slope4"]');
    const compat=event.target.closest?.("[data-robogub-compat-button]");
    if(!pause&&!stop&&!dock&&!slope&&!compat)return;
    event.preventDefault();event.stopImmediatePropagation();
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
