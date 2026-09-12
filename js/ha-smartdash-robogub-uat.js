(function(){
  const IDS={
    activity:"sensor.robogub_aktivitetstilstand",
    location:"sensor.robogub_nuvaerende_placering",
    progress:"sensor.robogub_fremdrift",
    remaining:"sensor.robogub_tid_tilbage",
    mower:"lawn_mower.robogub",
    slope4:"button.robogub_skraning_nr_4",
    task3:"button.have_robogub_opgave_3"
  };
  let timer=0;
  function state(id){return window.BeastHaSocket?.getState(id)?.state||""}
  function entity(id){return window.BeastHaSocket?.getState(id)||null}
  function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
  function duration(v){const n=Number(v);if(!Number.isFinite(n)||n<=0)return "–";if(n<60)return `${Math.round(n)} min`;const h=Math.floor(n/60),m=Math.round(n%60);return m?`${h} t ${m} min`:`${h} t`}
  function isWorking(v){return /WORK|MOW|CUT|PAUS|RETURN|GOING/i.test(v)&&!/NOT_WORK|READY|IDLE|CHARG|DOCK/i.test(v)}
  function isDocked(){const mower=state(IDS.mower),activity=state(IDS.activity),location=state(IDS.location);return /dock|charg/i.test(`${mower} ${activity} ${location}`)}
  async function press(id){
    return window.BeastAuth.haFetch("/api/services/button/press",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({entity_id:id})
    });
  }
  function taskMarkup(id,label){
    return `<button type="button" class="beast-robogub-task" data-robogub-compat-button="${esc(id)}">${window.BeastCore.icon("check",{size:17})}<span>${esc(label)}</span></button>`;
  }
  function ensureTask(grid,id,label){
    if(!grid||!entity(id)||entity(id).state==="unavailable")return;
    if(grid.querySelector(`[data-robogub-compat-button="${CSS.escape(id)}"]`))return;
    grid.insertAdjacentHTML("beforeend",taskMarkup(id,label));
  }
  function update(){
    const consoleEl=document.querySelector(".beast-robogub-console");if(!consoleEl)return;
    const activity=state(IDS.activity)||state(IDS.mower)||"Ukendt",location=state(IDS.location)||"–",progress=Math.max(0,Math.min(100,Number(state(IDS.progress))||0)),remaining=duration(state(IDS.remaining));
    const lower=consoleEl.querySelector(".beast-robogub-lower");
    if(lower){let current=lower.querySelector(".beast-robogub-current");if(!current){current=document.createElement("section");current.className="beast-robogub-current";lower.prepend(current)}current.innerHTML=`<div><small>Aktuel opgave</small><strong>${esc(location)}</strong></div><div class="beast-robogub-current-state"><span>${esc(activity)}</span><span>${progress}% · ${esc(remaining)}</span></div><div class="beast-robogub-progressbar" style="--robogub-progress:${progress}%"><span></span></div>`}
    const stop=consoleEl.querySelector('[data-robogub-action="cancel"]'),dock=consoleEl.querySelector('[data-robogub-action="dock"]');
    const working=isWorking(activity);if(stop){stop.dataset.smartDisabled=String(!working);stop.disabled=!working}if(dock){const disabled=isDocked();dock.dataset.smartDisabled=String(disabled);dock.disabled=disabled}
    const grid=consoleEl.querySelector(".beast-robogub-task-grid");
    ensureTask(grid,IDS.slope4,"Skråning nr. 4");
    ensureTask(grid,IDS.task3,"Opgave-3");
  }
  function schedule(){clearTimeout(timer);timer=setTimeout(update,60)}
  document.addEventListener("click",async event=>{
    const slope=event.target.closest?.('[data-robogub-action="slope4"]');
    const compat=event.target.closest?.("[data-robogub-compat-button]");
    if(!slope&&!compat)return;
    event.preventDefault();event.stopImmediatePropagation();
    const button=slope||compat;button.disabled=true;
    try{await press(slope?IDS.slope4:button.dataset.robogubCompatButton)}
    catch(error){window.BeastCore?.log?.(`RoboGub: handling fejlede (${error.message}).`)}
    finally{setTimeout(()=>{button.disabled=false},800)}
  },true);
  const observer=new MutationObserver(schedule);observer.observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener("beast:ha-state",schedule);document.addEventListener("beast:page-rendered",schedule);window.addEventListener("load",schedule);schedule();
})();
