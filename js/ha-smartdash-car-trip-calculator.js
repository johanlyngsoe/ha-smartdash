(function(){
  const F=window.BeastCarFleet;if(!F)return;
  const ECONOMY_KWH_100=18.5;
  const SAFE_KWH_100=20.4;
  const FALLBACK_CAPACITY_KWH=73.5;
  const state={query:"",roundTrip:false,busy:false,error:"",result:null};
  let wired=false;

  function css(){
    if(document.getElementById("beastCarTripCalculatorStyles"))return;
    const s=document.createElement("style");
    s.id="beastCarTripCalculatorStyles";
    s.textContent=`
      .beast-car-trip{padding:18px 20px 20px}
      .beast-car-trip-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
      .beast-car-trip-subtitle{color:var(--ink-muted);font-size:.78rem;font-weight:700}
      .beast-car-trip-form{display:grid;grid-template-columns:1fr auto;gap:10px;margin-top:14px}
      .beast-car-trip-input{min-width:0;height:46px;padding:0 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-solid);color:var(--ink);font:inherit;outline:none}
      .beast-car-trip-input:focus{border-color:var(--accent)}
      .beast-car-trip-button{min-width:120px;height:46px}
      .beast-car-trip-modes{display:flex;gap:8px;margin-top:10px}
      .beast-car-trip-mode{flex:1;min-height:40px;border:1px solid var(--border);border-radius:999px;background:var(--surface-solid);color:var(--ink-muted);font:inherit;font-size:.82rem;font-weight:800}
      .beast-car-trip-mode.is-active{border-color:color-mix(in srgb,var(--accent) 45%,var(--border));background:var(--accent-soft);color:var(--accent)}
      .beast-car-trip-status{margin-top:13px;color:var(--ink-muted);font-size:.82rem}
      .beast-car-trip-status.is-error{color:var(--warning)}
      .beast-car-trip-result{margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}
      .beast-car-trip-destination{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .beast-car-trip-destination strong{font-size:1.05rem}.beast-car-trip-destination span{color:var(--ink-muted);font-size:.78rem;white-space:nowrap}
      .beast-car-trip-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}
      .beast-car-trip-metric{padding:11px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-solid)}
      .beast-car-trip-metric small{display:block;color:var(--ink-muted);font-size:.7rem;font-weight:700}
      .beast-car-trip-metric strong{display:block;margin-top:3px;font-size:1.22rem}.beast-car-trip-metric strong span{font-size:.62em;color:var(--ink-muted)}
      .beast-car-trip-soc{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}
      .beast-car-trip-soc>div{padding:10px 11px;border:1px solid var(--border);border-radius:var(--radius-sm)}
      .beast-car-trip-soc small{display:block;color:var(--ink-muted);font-size:.7rem}.beast-car-trip-soc strong{display:block;margin-top:2px;font-size:1rem}
      .beast-car-trip-note{margin-top:10px;color:var(--ink-muted);font-size:.74rem;line-height:1.4}
      .beast-car-trip-feasible{margin-top:10px;font-size:.8rem;font-weight:800}.beast-car-trip-feasible.is-ok{color:var(--success)}.beast-car-trip-feasible.is-warn{color:var(--warning)}
      @media(max-width:700px){.beast-car-trip-form{grid-template-columns:1fr}.beast-car-trip-button{width:100%}.beast-car-trip-metrics,.beast-car-trip-soc{grid-template-columns:1fr 1fr}.beast-car-trip-metric:last-child,.beast-car-trip-soc>div:last-child:nth-child(odd){grid-column:1/-1}}
    `;
    document.head.appendChild(s);
  }

  function n(id,fallback=0){const v=Number(F.state(id)?.state);return Number.isFinite(v)?v:fallback;}
  function tracker(){return F.state(F.ids().location);}
  function coords(){const t=tracker(),lat=Number(t?.attributes?.latitude),lon=Number(t?.attributes?.longitude);return Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon}:null;}
  function formatTime(minutes){const m=Math.max(0,Math.round(minutes));if(m<60)return `${m} min`;const h=Math.floor(m/60),r=m%60;return `${h} t${r?` ${r} min`:""}`;}
  function priceData(){
    const avg=n("input_number.yrsa_last_charge_average_price",0);
    if(avg>0)return{value:avg,label:"seneste hjemmeopladning"};
    const current=n("sensor.stromligning_current_price_vat",0);
    if(current>0)return{value:current,label:"aktuel hjemmepris"};
    return{value:null,label:"pris mangler"};
  }
  function capacity(){const v=n("input_number.yrsa_estimated_battery_capacity",0);return v>=55&&v<=100?v:FALLBACK_CAPACITY_KWH;}
  function currentSoc(){return n("sensor.yrsa_battery_level",NaN);}

  async function geocode(query){
    const url=`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=dk&accept-language=da&q=${encodeURIComponent(query)}`;
    const r=await fetch(url,{headers:{Accept:"application/json"}});if(!r.ok)throw new Error("Adressen kunne ikke findes");
    const data=await r.json();if(!Array.isArray(data)||!data.length)throw new Error("Adressen kunne ikke findes");
    const x=data[0],lat=Number(x.lat),lon=Number(x.lon);if(!Number.isFinite(lat)||!Number.isFinite(lon))throw new Error("Adressen mangler koordinater");
    return{lat,lon,label:x.display_name||query};
  }
  async function route(from,to){
    const url=`https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false&steps=false`;
    const r=await fetch(url,{headers:{Accept:"application/json"}});if(!r.ok)throw new Error("Ruten kunne ikke beregnes");
    const data=await r.json(),x=data?.routes?.[0];if(!x)throw new Error("Ruten kunne ikke beregnes");
    return{km:Number(x.distance)/1000,minutes:Number(x.duration)/60};
  }

  async function calculate(){
    const q=state.query.trim();if(!q){state.error="Skriv en destination først.";state.result=null;render();return;}
    const from=coords();if(!from){state.error="Yrsa har ingen GPS-koordinater lige nu.";state.result=null;render();return;}
    state.busy=true;state.error="";state.result=null;render();
    try{
      const dest=await geocode(q),r=await route(from,dest),cap=capacity(),soc=currentSoc(),p=priceData();
      state.result={label:dest.label,oneWayKm:r.km,oneWayMinutes:r.minutes,capacity:cap,soc,price:p.value,priceLabel:p.label};
    }catch(e){state.error=e?.message||"Turen kunne ikke beregnes.";}finally{state.busy=false;render();}
  }

  function derived(x){
    const mult=state.roundTrip?2:1;
    const totalKm=x.oneWayKm*mult,totalMinutes=x.oneWayMinutes*mult;
    const economyKwh=totalKm*ECONOMY_KWH_100/100;
    const safeOneWayKwh=x.oneWayKm*SAFE_KWH_100/100;
    const safeTotalKwh=totalKm*SAFE_KWH_100/100;
    const arrival=Number.isFinite(x.soc)?x.soc-(safeOneWayKwh/x.capacity*100):NaN;
    const returnSoc=Number.isFinite(x.soc)?x.soc-(safeTotalKwh/x.capacity*100):NaN;
    const cost=x.price===null?null:economyKwh*x.price;
    return{totalKm,totalMinutes,economyKwh,safeOneWayKwh,safeTotalKwh,arrival,returnSoc,cost};
  }

  function resultMarkup(x){
    if(!x)return"";
    const d=derived(x);
    const cost=d.cost===null?"–":d.cost.toLocaleString("da-DK",{minimumFractionDigits:2,maximumFractionDigits:2});
    const price=x.price===null?"–":x.price.toLocaleString("da-DK",{minimumFractionDigits:2,maximumFractionDigits:2});
    const arrival=Number.isFinite(d.arrival)?Math.round(d.arrival):null,ret=Number.isFinite(d.returnSoc)?Math.round(d.returnSoc):null;
    const relevant=state.roundTrip?ret:arrival,ok=relevant!==null&&relevant>=10;
    return `<div class="beast-car-trip-result">
      <div class="beast-car-trip-destination"><strong>${F.escapeHtml(x.label.split(",").slice(0,2).join(","))}</strong><span>${formatTime(d.totalMinutes)}</span></div>
      <div class="beast-car-trip-metrics">
        <div class="beast-car-trip-metric"><small>${state.roundTrip?"Tur/retur":"Afstand"}</small><strong>${d.totalKm.toFixed(0)} <span>km</span></strong></div>
        <div class="beast-car-trip-metric"><small>Forventet energi</small><strong>${d.economyKwh.toFixed(1)} <span>kWh</span></strong></div>
        <div class="beast-car-trip-metric"><small>Estimeret pris</small><strong>${cost} <span>kr</span></strong></div>
      </div>
      <div class="beast-car-trip-soc">
        <div><small>SOC ved mål · med buffer</small><strong>${arrival===null?"–":`${arrival}%`}</strong></div>
        <div><small>Forbrug til mål · med buffer</small><strong>${d.safeOneWayKwh.toFixed(1)} kWh</strong></div>
        ${state.roundTrip?`<div><small>SOC efter retur · med buffer</small><strong>${ret===null?"–":`${ret}%`}</strong></div>`:""}
      </div>
      <div class="beast-car-trip-feasible ${ok?"is-ok":"is-warn"}">${relevant===null?"SOC-estimat mangler":(ok?"Kan forventeligt køres uden ladestop":"Planlæg et ladestop")}</div>
      <div class="beast-car-trip-note">Pris: ${price} kr/kWh (${F.escapeHtml(x.priceLabel)}). Forbrug ${ECONOMY_KWH_100.toFixed(1)} kWh/100 km til pris og ${SAFE_KWH_100.toFixed(1)} kWh/100 km til SOC-buffer. Batteriestimat ${x.capacity.toFixed(1)} kWh.</div>
    </div>`;
  }

  function cardMarkup(){
    return `<section class="beast-car-v3-card beast-car-trip" data-car-trip="1">
      <div class="beast-car-trip-head"><span class="beast-car-v3-section-label">Hvad koster turen?</span><span class="beast-car-trip-subtitle">Yrsa → destination</span></div>
      <div class="beast-car-trip-form"><input class="beast-car-trip-input" data-trip-input type="text" autocomplete="off" placeholder="Fx Odense Zoo eller Ørbækvej 75, Odense" value="${F.escapeHtml(state.query)}"><button type="button" class="beast-security-action-btn beast-car-trip-button" data-trip-calc ${state.busy?"disabled":""}>${state.busy?"Beregner…":"Beregn"}</button></div>
      <div class="beast-car-trip-modes"><button type="button" class="beast-car-trip-mode ${state.roundTrip?"":"is-active"}" data-trip-mode="one">Én vej</button><button type="button" class="beast-car-trip-mode ${state.roundTrip?"is-active":""}" data-trip-mode="round">Tur/retur</button></div>
      ${state.error?`<div class="beast-car-trip-status is-error">${F.escapeHtml(state.error)}</div>`:(state.busy?`<div class="beast-car-trip-status">Finder adresse og vejafstand…</div>`:"")}
      ${resultMarkup(state.result)}
    </section>`;
  }

  function bind(card){
    const input=card.querySelector("[data-trip-input]");
    input?.addEventListener("input",()=>{state.query=input.value;});
    input?.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();state.query=input.value;calculate();}});
    card.querySelector("[data-trip-calc]")?.addEventListener("click",()=>{state.query=input?.value||state.query;calculate();});
    card.querySelectorAll("[data-trip-mode]").forEach(btn=>btn.addEventListener("click",()=>{state.roundTrip=btn.dataset.tripMode==="round";render();}));
  }

  function render(){
    const shell=document.querySelector(".beast-car-v3-shell");if(!shell)return;
    css();
    const existing=shell.querySelector("[data-car-trip='1']"),map=shell.querySelector("[data-car-map='1']");
    const host=document.createElement("div");host.innerHTML=cardMarkup();const card=host.firstElementChild;
    if(existing)existing.replaceWith(card);else if(map)map.insertAdjacentElement("afterend",card);else shell.appendChild(card);
    bind(card);
  }

  function apply(){
    if(!wired){wired=true;const i=F.ids();F.watch(apply,[i.location,"sensor.yrsa_battery_level","input_number.yrsa_estimated_battery_capacity","input_number.yrsa_last_charge_average_price","sensor.stromligning_current_price_vat"]);}
    const shell=document.querySelector(".beast-car-v3-shell");if(!shell)return;
    if(!shell.querySelector("[data-car-trip='1']"))render();
  }
  F.watch(apply,[]);
})();
