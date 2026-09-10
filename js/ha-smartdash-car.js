(function () {
  let IDS = {};
  let VEHICLE_LABEL = "Elbil";
  let containerEl = null;

  function applyConfig() {
    const config = BeastConfig.get("panels.car") || {};
    const configuredDevice = config.sourceDevice ? BeastRegistry.getDevice(config.sourceDevice) : null;
    VEHICLE_LABEL = configuredDevice?.name || configuredDevice?.name_by_user || "Elbil";
    IDS = {
      battery: config.battery, range: config.range, shiftState: config.shiftState, chargerPower: config.chargerPower,
      charging: config.charging, pluggedIn: config.pluggedIn, doors: config.doorsOpen, windows: config.windowsOpen,
      locationTracker: config.locationTracker, lock: config.lock, insideTemp: config.insideTemp, outsideTemp: config.outsideTemp,
      chargingFinishAt: config.chargingFinishAt, energyAdded: config.energyAdded, tpmsFl: config.tpmsFl,
      tpmsFr: config.tpmsFr, tpmsRl: config.tpmsRl, tpmsRr: config.tpmsRr
    };
  }

  function callService(domain, service, entityId, data = {}) {
    if (!entityId) return Promise.resolve();
    return BeastAuth.haFetch(`/api/services/${domain}/${service}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity_id: entityId, ...data })
    }).catch((error) => BeastCore.log(`Bil: kommando fejlede (${error.message}).`));
  }

  function stateOf(id) { return id ? BeastHaSocket.getState(id) : null; }
  function numeric(id, decimals = 0) {
    const value = Number(stateOf(id)?.state);
    return Number.isFinite(value) ? value.toFixed(decimals) : "–";
  }
  function isOn(id) { return stateOf(id)?.state === "on"; }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
  }

  function locationLabel() {
    const tracker = stateOf(IDS.locationTracker);
    if (!tracker) return "Ukendt lokation";
    if (tracker.state === "home") return "Hjemme";
    if (["not_home", "away"].includes(tracker.state)) return "Ude";
    return tracker.state || "Ukendt lokation";
  }

  function driveState() {
    return String(stateOf(IDS.shiftState)?.state || "").trim().toUpperCase();
  }

  function primaryStatus() {
    const shift = driveState();
    if (shift === "D" || shift === "R") return { label: "Kører", tone: "is-driving" };
    if (isOn(IDS.charging)) return { label: "Lader", tone: "is-charging" };
    return { label: locationLabel(), tone: locationLabel() === "Hjemme" ? "is-home" : "" };
  }

  function chargingDetail() {
    const charging = isOn(IDS.charging);
    const plugged = isOn(IDS.pluggedIn);
    const power = numeric(IDS.chargerPower, 1);
    if (charging) return `${power} kW`;
    return plugged ? "Ladekabel tilsluttet" : "Ikke tilsluttet";
  }

  function remainingChargeLabel() {
    if (!isOn(IDS.charging)) return "";
    const raw = stateOf(IDS.chargingFinishAt)?.state;
    if (!raw || ["unknown", "unavailable"].includes(raw)) return "";
    const value = Number(raw);
    if (Number.isFinite(value)) {
      const unit = String(stateOf(IDS.chargingFinishAt)?.attributes?.unit_of_measurement || "").toLowerCase();
      const minutes = unit.includes("min") ? value : value * 60;
      if (minutes < 60) return `${Math.round(minutes)} min tilbage`;
      const hours = Math.floor(minutes / 60), mins = Math.round(minutes % 60);
      return `${hours} t${mins ? ` ${mins} min` : ""} tilbage`;
    }
    if (!Number.isNaN(Date.parse(raw))) {
      const time = new Date(raw).toLocaleTimeString(window.HASmartdashI18n?.locale || "da-DK", { hour:"2-digit", minute:"2-digit" });
      return `Færdig kl. ${time}`;
    }
    return escapeHtml(raw);
  }

  function buildTpms() {
    const wheels = [
      [IDS.tpmsFl, "FV"], [IDS.tpmsFr, "FH"], [IDS.tpmsRl, "BV"], [IDS.tpmsRr, "BH"]
    ].map(([id, label]) => ({ label, pressure: Number(stateOf(id)?.state) }));
    const valid = wheels.filter((wheel) => Number.isFinite(wheel.pressure));
    const highest = valid.length ? Math.max(...valid.map((wheel) => wheel.pressure)) : null;
    const hasLow = highest !== null && valid.some((wheel) => highest - wheel.pressure >= 2.5);
    return `<div class="beast-car-v2-tpms">
      <span class="beast-car-v2-section-label">Dæktryk</span>
      <div class="beast-car-v2-tires">${wheels.map((wheel) => {
        const low = highest !== null && Number.isFinite(wheel.pressure) && highest - wheel.pressure >= 2.5;
        return `<span class="beast-car-v2-tire${low ? " is-low" : "}"><small>${wheel.label}</small><strong>${Number.isFinite(wheel.pressure) ? wheel.pressure.toFixed(1) : "–"}</strong><em>PSI</em></span>`;
      }).join("")}</div>
      <span class="beast-car-v2-health${hasLow ? " is-warning" : "}">${hasLow ? "Kontrollér dæk" : "Dæktryk OK"}</span>
    </div>`;
  }

  function injectStyles() {
    if (document.getElementById("beastCarV2Styles")) return;
    const style = document.createElement("style");
    style.id = "beastCarV2Styles";
    style.textContent = `
      .beast-car-panel.beast-car-v2{display:block!important;overflow-y:auto!important}
      .beast-car-v2-shell{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(300px,.65fr);gap:var(--space-4);min-height:100%}
      .beast-car-v2-hero,.beast-car-v2-card,.beast-car-v2-tpms{border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface-2)}
      .beast-car-v2-hero{grid-column:1/-1;padding:clamp(22px,3vw,38px);display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:center;background:radial-gradient(circle at 15% 50%,rgba(83,190,255,.13),transparent 42%),var(--surface-2)}
      .beast-car-v2-name{display:block;color:var(--ink-muted);font-size:var(--text-sm);font-weight:800;text-transform:uppercase;letter-spacing:.12em}
      .beast-car-v2-energy{display:flex;align-items:baseline;gap:14px;margin-top:7px}.beast-car-v2-energy strong{font-size:clamp(3.2rem,6vw,6rem);line-height:.9;letter-spacing:-.06em}.beast-car-v2-energy span{font-size:clamp(1.25rem,2vw,2rem);font-weight:800;color:var(--ink-muted)}
      .beast-car-v2-bar{height:12px;max-width:620px;margin-top:20px;overflow:hidden;border-radius:999px;background:var(--surface-solid);border:1px solid var(--border)}.beast-car-v2-bar i{display:block;height:100%;width:var(--battery-level);border-radius:inherit;background:linear-gradient(90deg,var(--accent),var(--success));transition:width .8s ease}
      .beast-car-v2-charge{margin-top:12px;color:var(--ink-muted);font-size:var(--text-sm)}.beast-car-v2-charge strong{color:var(--ink);margin-right:8px}.beast-car-v2-charge small{margin-left:8px;color:var(--ink-faint)}
      .beast-car-v2-status{text-align:right;align-self:start}.beast-car-v2-status-pill{display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:999px;background:var(--accent-soft);color:var(--accent);font-weight:850}.beast-car-v2-status-pill.is-charging{color:var(--success);background:var(--success-soft)}.beast-car-v2-status-pill.is-driving{color:var(--warning);background:rgba(255,200,87,.12)}
      .beast-car-v2-location{display:block;margin-top:10px;color:var(--ink-muted);font-size:var(--text-sm)}
      .beast-car-v2-card{padding:var(--space-5)}.beast-car-v2-section-label{display:block;margin-bottom:18px;color:var(--ink-muted);font-size:var(--text-xs);font-weight:800;text-transform:uppercase;letter-spacing:.1em}
      .beast-car-v2-state-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.beast-car-v2-state{min-width:0;padding:14px;border-radius:var(--radius-sm);background:var(--surface-solid);border:1px solid var(--border)}.beast-car-v2-state svg{color:var(--accent);margin-bottom:10px}.beast-car-v2-state small,.beast-car-v2-state strong{display:block}.beast-car-v2-state small{color:var(--ink-muted);font-size:var(--text-xs)}.beast-car-v2-state strong{margin-top:3px;font-size:var(--text-md)}
      .beast-car-v2-actions{margin-top:16px}.beast-car-v2-actions button{min-height:48px;padding:8px 18px}
      .beast-car-v2-climate{display:grid;grid-template-columns:1fr 1fr;gap:12px}.beast-car-v2-temp{padding:18px;border-radius:var(--radius-sm);background:var(--surface-solid);border:1px solid var(--border)}.beast-car-v2-temp small{display:block;color:var(--ink-muted)}.beast-car-v2-temp strong{display:block;margin-top:5px;font-size:clamp(1.8rem,3vw,2.8rem)}
      .beast-car-v2-tpms{grid-column:1/-1;padding:18px 22px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:22px}.beast-car-v2-tpms .beast-car-v2-section-label{margin:0}.beast-car-v2-tires{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.beast-car-v2-tire{display:flex;align-items:baseline;justify-content:center;gap:5px;padding:9px;border-radius:var(--radius-sm);background:var(--surface-solid)}.beast-car-v2-tire small,.beast-car-v2-tire em{color:var(--ink-muted);font-size:var(--text-xs);font-style:normal}.beast-car-v2-tire.is-low strong{color:var(--warning)}.beast-car-v2-health{color:var(--success);font-size:var(--text-xs);font-weight:800;white-space:nowrap}.beast-car-v2-health.is-warning{color:var(--warning)}
      @media(max-width:900px){.beast-car-v2-shell{grid-template-columns:1fr}.beast-car-v2-hero,.beast-car-v2-tpms{grid-column:1}.beast-car-v2-tpms{grid-template-columns:1fr}.beast-car-v2-health{text-align:left}.beast-car-v2-hero{grid-template-columns:1fr}.beast-car-v2-status{text-align:left}.beast-car-v2-state-grid{grid-template-columns:repeat(3,1fr)}}
      @media(max-width:600px){.beast-car-v2-state-grid,.beast-car-v2-climate{grid-template-columns:1fr}.beast-car-v2-tires{grid-template-columns:1fr 1fr}.beast-car-v2-energy strong{font-size:3.5rem}}
    `;
    document.head.appendChild(style);
  }

  function render() {
    if (!containerEl) return;
    const batteryValue = Number(stateOf(IDS.battery)?.state);
    const batteryLevel = Number.isFinite(batteryValue) ? Math.max(0, Math.min(100, Math.round(batteryValue))) : 0;
    const batteryPct = Number.isFinite(batteryValue) ? String(batteryLevel) : "–";
    const rangeKm = numeric(IDS.range, 0);
    const locked = stateOf(IDS.lock)?.state === "locked";
    const doorsOpen = isOn(IDS.doors), windowsOpen = isOn(IDS.windows);
    const status = primaryStatus(), chargeRemaining = remainingChargeLabel();

    containerEl.innerHTML = `
      <button type="button" class="beast-page-edit-trigger" id="beastCarLayoutEdit" aria-label="Rediger billayout">⋮</button>
      <div class="beast-car-v2-shell">
        <section class="beast-car-v2-hero">
          <div>
            <span class="beast-car-v2-name">${escapeHtml(VEHICLE_LABEL)}</span>
            <div class="beast-car-v2-energy"><strong>${batteryPct}%</strong><span>${rangeKm} km</span></div>
            <div class="beast-car-v2-bar" style="--battery-level:${batteryLevel}%"><i></i></div>
            <div class="beast-car-v2-charge"><strong>${escapeHtml(chargingDetail())}</strong>${chargeRemaining ? `<small>${chargeRemaining}</small>` : ""}</div>
          </div>
          <div class="beast-car-v2-status"><span class="beast-car-v2-status-pill ${status.tone}">${BeastCore.icon(isOn(IDS.charging) ? "bolt" : "car", {size:18})}${escapeHtml(status.label)}</span><span class="beast-car-v2-location">${escapeHtml(locationLabel())}</span></div>
        </section>
        <section class="beast-car-v2-card">
          <span class="beast-car-v2-section-label">Bilstatus</span>
          <div class="beast-car-v2-state-grid">
            <div class="beast-car-v2-state">${BeastCore.icon(locked ? "lock" : "unlock", {size:20})}<small>Lås</small><strong>${locked ? "Låst" : "Ulåst"}</strong></div>
            <div class="beast-car-v2-state">${BeastCore.icon("car", {size:20})}<small>Døre</small><strong>${doorsOpen ? "Åbne" : "Lukkede"}</strong></div>
            <div class="beast-car-v2-state">${BeastCore.icon("chevron-right", {size:20})}<small>Ruder</small><strong>${windowsOpen ? "Åbne" : "Lukkede"}</strong></div>
          </div>
          <div class="beast-car-v2-actions"><button type="button" class="beast-security-action-btn" id="beastCarLockBtn">${locked ? "Lås op" : "Lås"}</button></div>
        </section>
        <section class="beast-car-v2-card">
          <span class="beast-car-v2-section-label">Klima</span>
          <div class="beast-car-v2-climate"><div class="beast-car-v2-temp"><small>Inde</small><strong>${numeric(IDS.insideTemp,1)}°</strong></div><div class="beast-car-v2-temp"><small>Ude</small><strong>${numeric(IDS.outsideTemp,1)}°</strong></div></div>
        </section>
        ${buildTpms()}
      </div>`;
    wireCarLayout();
    document.getElementById("beastCarLockBtn")?.addEventListener("click", () => callService("lock", locked ? "unlock" : "lock", IDS.lock).then(() => window.setTimeout(render, 400)));
  }

  function wireCarLayout() {
    const layout = BeastConfig.get("pageLayouts.car.carLayout") || {};
    const hidden = new Set(Array.isArray(layout.hidden) ? layout.hidden : []);
    const shell = containerEl.querySelector(".beast-car-v2-shell");
    shell?.classList.toggle("is-layout-hidden", hidden.has("details"));
    BeastNativePageEditor.mount({ section:"car", label:"Bil", root:()=>containerEl, host:()=>containerEl, trigger:"#beastCarLayoutEdit", cards:()=>[
      { id:"details", label:"Biloversigt", selector:".beast-car-v2-shell", enabled:!hidden.has("details"), desktop:{x:1,y:1,w:12,h:12} }
    ] });
  }

  function init(root) {
    applyConfig(); injectStyles();
    containerEl = root;
    containerEl.classList.add("beast-car-panel", "beast-car-v2");
    containerEl.innerHTML = `<p class="beast-music-empty">Henter…</p>`;
    BeastHaSocket.onStatusChange((status) => { if (status === "connected") render(); });
    const debouncedRender = BeastCore.stableUpdater(containerEl, render, 300);
    Object.values(IDS).filter(Boolean).forEach((id) => BeastHaSocket.subscribeEntity(id, debouncedRender));
  }

  BeastCore.registerPanel("car", "beastCarZone", init);
})();
