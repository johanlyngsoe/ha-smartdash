(function () {
  if (window.BeastCarFleet) return;
  const callbacks = new Set();
  let scheduled = false;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }
  function ids() {
    const c = BeastConfig.get("panels.car") || {};
    const n = String(c.battery || "sensor.yrsa_battery_level").split(".")[1] || "yrsa_battery_level";
    const p = n.endsWith("_battery_level") ? n.slice(0, -14) : (n.split("_")[0] || "yrsa");
    const e = (d, s) => `${d}.${p}_${s}`;
    return {
      charging:e("sensor","charging"),chargeSwitch:e("switch","charge"),plugged:c.pluggedIn||e("binary_sensor","opladerkabel"),chargerPower:c.chargerPower||e("sensor","charger_power"),chargerCurrent:e("sensor","charger_current"),energyAdded:c.energyAdded||e("sensor","charge_energy_added"),finishAt:e("sensor","time_to_full_charge"),chargeLimit:e("number","charge_limit"),chargeCurrent:e("number","charge_current"),
      climate:e("climate","klima"),defrost:e("switch","defrost"),seatLeft:e("select","seat_heater_front_left"),seatRight:e("select","seat_heater_front_right"),steering:e("select","steering_wheel_heater"),inside:c.insideTemp||e("sensor","inside_temperature"),outside:c.outsideTemp||e("sensor","outside_temperature"),
      lock:c.lock||e("lock","lock"),location:c.locationTracker||e("device_tracker","lokalitet"),shift:c.shiftState||e("sensor","shift_state"),sentry:e("switch","sentry_mode"),wake:e("button","wake"),trunk:e("cover","bagagerum"),frunk:e("cover","frunk"),chargePort:e("cover","ladeportdor"),windows:e("cover","vinduer"),
      dfl:e("binary_sensor","forreste_forerdor"),dfr:e("binary_sensor","forreste_passagerdor"),drl:e("binary_sensor","bageste_forerdor"),drr:e("binary_sensor","bageste_passagerdor"),wfl:e("binary_sensor","forreste_forervindue"),wfr:e("binary_sensor","forreste_passagervindue"),wrl:e("binary_sensor","bageste_forervindue"),wrr:e("binary_sensor","bageste_passagervindue"),
      route:e("device_tracker","rute"),distance:e("sensor","distance_to_arrival"),eta:e("sensor","time_to_arrival")
    };
  }
  const state = (id) => id ? BeastHaSocket.getState(id) : null;
  const text = (id) => String(state(id)?.state || "").toLowerCase();
  const on = (id) => text(id) === "on";
  const valid = (id) => !["","unknown","unavailable"].includes(text(id));
  function number(id, digits) { const v=Number(state(id)?.state); return Number.isFinite(v)?v.toFixed(digits||0):"–"; }
  function call(domain, service, entityId, data) {
    if (!entityId) return Promise.resolve(false);
    return BeastAuth.haFetch(`/api/services/${domain}/${service}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({entity_id:entityId,...(data||{})})}).then(()=>true).catch((err)=>{BeastCore.log(`Bil Fleet: kommando fejlede (${err.message}).`);return false;});
  }
  function coverLabel(id){const s=text(id);return ["open","opening"].includes(s)?"Åben":(["closed","closing"].includes(s)?"Lukket":"Ukendt");}
  function chargeState(i){return text(i.charging);}
  function charging(i){return ["starting","charging"].includes(chargeState(i));}
  function chargeLabel(i){return ({starting:"Starter opladning",charging:"Lader",stopped:"Opladning stoppet",complete:"Opladning færdig",disconnected:"Ikke tilsluttet",no_power:"Tilsluttet · ingen strøm"})[chargeState(i)]||(on(i.plugged)?"Ladekabel tilsluttet":"Ikke tilsluttet");}
  function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;callbacks.forEach((cb)=>{try{cb();}catch(e){console.error("[Bil Fleet]",e);}});});}
  function watch(cb, entityIds){callbacks.add(cb);(entityIds||[]).filter(Boolean).forEach((id)=>BeastHaSocket.subscribeEntity(id,schedule));schedule();}
  new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});
  window.BeastCarFleet={ids,state,text,on,valid,number,call,coverLabel,chargeState,charging,chargeLabel,escapeHtml,watch,schedule};
})();
