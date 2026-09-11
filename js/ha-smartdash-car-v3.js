(function () {
  let IDS = {};
  let VEHICLE_LABEL = "Elbil";
  let containerEl = null;
  const MODEL_Y_ASSET_URL = "https://raw.githubusercontent.com/Aephir/ha-tesla-lovelace-floorplan/main/tesla_floorplan.svg";

  function applyConfig() {
    const config = BeastConfig.get("panels.car") || {};
    const configuredDevice = config.sourceDevice ? BeastRegistry.getDevice(config.sourceDevice) : null;
    VEHICLE_LABEL = configuredDevice?.name_by_user || configuredDevice?.name || "Elbil";
    if (String(VEHICLE_LABEL).toLowerCase() === "elbil" && config.battery) {
      const entityName = String(config.battery).split(".")[1] || "";
      const prefix = entityName.split("_")[0];
      if (prefix) VEHICLE_LABEL = prefix.charAt(0).toUpperCase() + prefix.slice(1);
    }
    IDS = {
      battery: config.battery,
      range: config.range,
      shiftState: config.shiftState,
      chargerPower: config.chargerPower,
      charging: config.charging,
      pluggedIn: config.pluggedIn,
      doors: config.doorsOpen,
      windows: config.windowsOpen,
      locationTracker: config.locationTracker,
      lock: config.lock,
      insideTemp: config.insideTemp,
      outsideTemp: config.outsideTemp,
      chargingFinishAt: config.chargingFinishAt,
      tpmsFl: config.tpmsFl,
      tpmsFr: config.tpmsFr,
      tpmsRl: config.tpmsRl,
      tpmsRr: config.tpmsRr
    };
  }

  function stateOf(id) { return id ? BeastHaSocket.getState(id) : null; }
  function isOn(id) { return stateOf(id)?.state === "on"; }
  function numeric(id, decimals) {
    const value = Number(stateOf(id)?.state);
    return Number.isFinite(value) ? value.toFixed(decimals || 0) : "–";
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
  }
  function callService(domain, service, entityId) {
    if (!entityId) return Promise.resolve();
    return BeastAuth.haFetch(`/api/services/${domain}/${service}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity_id: entityId })
    }).catch((error) => BeastCore.log(`Bil: kommando fejlede (${error.message}).`));
  }

  function locationLabel() {
    const tracker = stateOf(IDS.locationTracker);
    if (!tracker) return "Ukendt";
    if (tracker.state === "home") return "Hjemme";
    if (["not_home", "away"].includes(tracker.state)) return "Ude";
    return tracker.state || "Ukendt";
  }

  function primaryStatus() {
    const shift = String(stateOf(IDS.shiftState)?.state || "").trim().toUpperCase();
    if (shift === "D" || shift === "R") return { label: "Kører", className: "is-driving" };
    if (isOn(IDS.charging)) return { label: "Lader", className: "is-charging" };
    const location = locationLabel();
    return { label: location, className: location === "Hjemme" ? "is-home" : "" };
  }

  function chargingDetail() {
    if (isOn(IDS.charging)) {
      const power = numeric(IDS.chargerPower, 1);
      return power === "–" ? "Lader" : `${power} kW`;
    }
    return isOn(IDS.pluggedIn) ? "Ladekabel tilsluttet" : "Ikke tilsluttet";
  }

  function remainingChargeLabel() {
    if (!isOn(IDS.charging)) return "";
    const entity = stateOf(IDS.chargingFinishAt);
    const raw = entity?.state;
    if (!raw || ["unknown", "unavailable"].includes(raw)) return "";
    const value = Number(raw);
    if (Number.isFinite(value)) {
      const unit = String(entity?.attributes?.unit_of_measurement || "").toLowerCase();
      const minutes = unit.includes("min") ? value : value * 60;
      if (minutes < 60) return `${Math.round(minutes)} min tilbage`;
      const hours = Math.floor(minutes / 60);
      const mins = Math.round(minutes % 60);
      return `${hours} t${mins ? ` ${mins} min` : ""} tilbage`;
    }
    return "";
  }

  function pressureBar(id) {
    const psi = Number(stateOf(id)?.state);
    return Number.isFinite(psi) ? psi * 0.0689476 : null;
  }

  function tireMarkup(key, label, value, highest) {
    const lowThreshold = 2.5 * 0.0689476;
    const low = highest !== null && Number.isFinite(value) && highest - value >= lowThreshold;
    const lowClass = low ? " is-low" : "";
    const shown = Number.isFinite(value) ? value.toFixed(1) : "–";
    return `<div class="beast-car-v3-tire beast-car-v3-tire-${key}${lowClass}"><small>${label}</small><strong>${shown}</strong><span>bar</span></div>`;
  }

  function buildVehicleVisual() {
    const wheels = {
      fl: pressureBar(IDS.tpmsFl),
      fr: pressureBar(IDS.tpmsFr),
      rl: pressureBar(IDS.tpmsRl),
      rr: pressureBar(IDS.tpmsRr)
    };
    const valid = Object.values(wheels).filter(Number.isFinite);
    const highest = valid.length ? Math.max(...valid) : null;

    return `<section class="beast-car-v3-card beast-car-v3-visual-card">
      <span class="beast-car-v3-section-label">Dæktryk</span>
      <div class="beast-car-v3-visual">
        ${tireMarkup("fl", "FV", wheels.fl, highest)}
        ${tireMarkup("fr", "FH", wheels.fr, highest)}
        ${tireMarkup("rl", "BV", wheels.rl, highest)}
        ${tireMarkup("rr", "BH", wheels.rr, highest)}
        <div class="beast-car-v3-model-y-host" id="beastCarModelY" role="img" aria-label="Sort Tesla Model Y 2021 set ovenfra">
          <span class="beast-car-v3-model-y-loading">Henter Model Y…</span>
        </div>
      </div>
    </section>`;
  }

  async function renderModelYAsset() {
    const host = containerEl?.querySelector("#beastCarModelY");
    if (!host) return;
    try {
      const response = await fetch(MODEL_Y_ASSET_URL, { cache: "force-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const source = await response.text();
      const doc = new DOMParser().parseFromString(source, "image/svg+xml");
      if (doc.querySelector("parsererror")) throw new Error("Ugyldig SVG");
      const sourceSvg = doc.documentElement;
      const carLayer = doc.querySelector("#layer2");
      if (!carLayer) throw new Error("Car layer #layer2 mangler");

      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "beast-car-v3-model-y");
      svg.setAttribute("viewBox", sourceSvg.getAttribute("viewBox") || "0 0 286 278.56");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.setAttribute("aria-hidden", "true");
      svg.appendChild(document.importNode(carLayer, true));
      host.replaceChildren(svg);
    } catch (error) {
      host.innerHTML = `<span class="beast-car-v3-model-y-error">Model Y-grafik kunne ikke hentes</span>`;
      BeastCore.log(`Bil: Model Y-grafik fejlede (${error.message}).`);
    }
  }

  function injectStyles() {
    if (document.getElementById("beastCarV3Styles")) return;
    const style = document.createElement("style");
    style.id = "beastCarV3Styles";
    style.textContent = `
      .beast-car-panel.beast-car-v3{display:block!important;overflow-y:auto!important}
      .beast-car-v3-shell{display:grid;grid-template-columns:1fr;gap:14px;width:min(100%,820px);margin:0 auto;padding:4px 0 18px}
      .beast-car-v3-card{border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface-2)}
      .beast-car-v3-hero{padding:22px 24px 20px;background:radial-gradient(circle at 18% 15%,rgba(83,190,255,.13),transparent 38%),var(--surface-2)}
      .beast-car-v3-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
      .beast-car-v3-name{display:block;font-size:1.55rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase}
      .beast-car-v3-subtitle{display:block;margin-top:4px;color:var(--ink-muted);font-size:var(--text-xs);font-weight:700;letter-spacing:.08em;text-transform:uppercase}
      .beast-car-v3-status{display:inline-flex;align-items:center;gap:7px;padding:8px 12px;border-radius:999px;color:var(--accent);background:var(--accent-soft);font-size:var(--text-xs);font-weight:850;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
      .beast-car-v3-status:before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 10px currentColor}
      .beast-car-v3-status.is-charging{color:var(--success);background:var(--success-soft)}
      .beast-car-v3-status.is-driving{color:var(--warning);background:rgba(255,200,87,.12)}
      .beast-car-v3-energy{display:flex;align-items:flex-end;gap:18px;margin-top:18px}
      .beast-car-v3-energy strong{font-size:5rem;line-height:.85;letter-spacing:-.065em}
      .beast-car-v3-range{padding-bottom:4px;color:var(--ink-muted);font-size:1.7rem;font-weight:800}
      .beast-car-v3-range small{font-size:.55em;font-weight:700}
      .beast-car-v3-bar{height:10px;margin-top:18px;border:1px solid var(--border);border-radius:999px;background:var(--surface-solid);overflow:hidden}
      .beast-car-v3-bar i{display:block;width:var(--battery-level);height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--accent),var(--success))}
      .beast-car-v3-charge{display:flex;justify-content:space-between;gap:12px;margin-top:10px;color:var(--ink-muted);font-size:var(--text-xs)}
      .beast-car-v3-charge strong{color:var(--ink)}
      .beast-car-v3-visual-card{padding:18px 20px 14px;background:radial-gradient(circle at 50% 46%,rgba(80,115,145,.12),transparent 42%),var(--surface-2)}
      .beast-car-v3-section-label{display:block;color:var(--ink-muted);font-size:var(--text-xs);font-weight:800;text-transform:uppercase;letter-spacing:.1em}
      .beast-car-v3-visual{position:relative;width:min(100%,520px);height:500px;margin:2px auto 0}
      .beast-car-v3-model-y-host{position:absolute;left:50%;top:18px;width:330px;height:455px;transform:translateX(-50%);display:flex;align-items:center;justify-content:center;overflow:visible}
      .beast-car-v3-model-y{display:block;width:100%;height:100%;overflow:visible;filter:drop-shadow(0 16px 16px rgba(0,0,0,.34))}
      .beast-car-v3-model-y-loading,.beast-car-v3-model-y-error{color:var(--ink-muted);font-size:var(--text-xs);text-align:center}
      .beast-car-v3-model-y-error{max-width:180px;color:var(--warning)}
      .beast-car-v3-tire{position:absolute;z-index:2;display:grid;grid-template-columns:auto auto;column-gap:6px;align-items:baseline;min-width:78px;padding:8px 10px;border:1px solid var(--border);border-radius:12px;background:rgba(11,14,18,.88);backdrop-filter:blur(5px)}
      .beast-car-v3-tire small{grid-column:1/-1;color:var(--ink-muted);font-size:.65rem;font-weight:800}
      .beast-car-v3-tire strong{font-size:1.25rem}.beast-car-v3-tire span{color:var(--ink-muted);font-size:.68rem}
      .beast-car-v3-tire.is-low{border-color:rgba(255,200,87,.45)}.beast-car-v3-tire.is-low strong{color:var(--warning)}
      .beast-car-v3-tire-fl{left:0;top:100px}.beast-car-v3-tire-fr{right:0;top:100px}.beast-car-v3-tire-rl{left:0;bottom:88px}.beast-car-v3-tire-rr{right:0;bottom:88px}
      .beast-car-v3-info{display:grid;grid-template-columns:1.15fr .85fr;gap:14px}
      .beast-car-v3-status-card,.beast-car-v3-climate-card{padding:18px 20px}
      .beast-car-v3-state-list{display:grid;gap:3px;margin-top:12px}
      .beast-car-v3-state-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:42px;padding:7px 0;border-bottom:1px solid var(--border)}
      .beast-car-v3-state-row:last-child{border-bottom:0}.beast-car-v3-state-row span{color:var(--ink-muted);font-size:var(--text-sm)}.beast-car-v3-state-row strong{font-size:var(--text-sm)}
      .beast-car-v3-lock-btn{width:100%;min-height:52px;margin-top:14px}
      .beast-car-v3-climate{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
      .beast-car-v3-temp{padding:14px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-solid)}
      .beast-car-v3-temp small{display:block;color:var(--ink-muted);font-size:var(--text-xs)}.beast-car-v3-temp strong{display:block;margin-top:4px;font-size:2.2rem}
      @media(max-width:700px){.beast-car-v3-shell{width:100%}.beast-car-v3-info{grid-template-columns:1fr}.beast-car-v3-visual{height:470px}.beast-car-v3-model-y-host{width:300px;height:420px;top:10px}.beast-car-v3-tire-fl,.beast-car-v3-tire-fr{top:88px}.beast-car-v3-tire-rl,.beast-car-v3-tire-rr{bottom:80px}}
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
    const doorOpen = isOn(IDS.doors);
    const windowOpen = isOn(IDS.windows);
    const status = primaryStatus();
    const chargeRemaining = remainingChargeLabel();

    containerEl.innerHTML = `
      <button type="button" class="beast-page-edit-trigger" id="beastCarLayoutEdit" aria-label="Rediger billayout">⋮</button>
      <div class="beast-car-v3-shell">
        <section class="beast-car-v3-card beast-car-v3-hero">
          <div class="beast-car-v3-heading">
            <div><span class="beast-car-v3-name">${escapeHtml(VEHICLE_LABEL)}</span><span class="beast-car-v3-subtitle">Tesla Model Y</span></div>
            <span class="beast-car-v3-status ${status.className}">${escapeHtml(status.label)}</span>
          </div>
          <div class="beast-car-v3-energy"><strong>${batteryPct}%</strong><span class="beast-car-v3-range">${rangeKm} <small>km</small></span></div>
          <div class="beast-car-v3-bar" style="--battery-level:${batteryLevel}%"><i></i></div>
          <div class="beast-car-v3-charge"><strong>${escapeHtml(chargingDetail())}</strong>${chargeRemaining ? `<span>${escapeHtml(chargeRemaining)}</span>` : ""}</div>
        </section>
        ${buildVehicleVisual()}
        <div class="beast-car-v3-info">
          <section class="beast-car-v3-card beast-car-v3-status-card">
            <span class="beast-car-v3-section-label">Bilstatus</span>
            <div class="beast-car-v3-state-list">
              <div class="beast-car-v3-state-row"><span>Lås</span><strong>${locked ? "Låst" : "Ulåst"}</strong></div>
              <div class="beast-car-v3-state-row"><span>Førerdør</span><strong>${doorOpen ? "Åben" : "Lukket"}</strong></div>
              <div class="beast-car-v3-state-row"><span>Førervindue</span><strong>${windowOpen ? "Åbent" : "Lukket"}</strong></div>
            </div>
            <button type="button" class="beast-security-action-btn beast-car-v3-lock-btn" id="beastCarLockBtn">${locked ? "Lås op" : "Lås"}</button>
          </section>
          <section class="beast-car-v3-card beast-car-v3-climate-card">
            <span class="beast-car-v3-section-label">Klima</span>
            <div class="beast-car-v3-climate">
              <div class="beast-car-v3-temp"><small>Inde</small><strong>${numeric(IDS.insideTemp, 1)}°</strong></div>
              <div class="beast-car-v3-temp"><small>Ude</small><strong>${numeric(IDS.outsideTemp, 1)}°</strong></div>
            </div>
          </section>
        </div>
      </div>`;

    renderModelYAsset();
    wireCarLayout();
    document.getElementById("beastCarLockBtn")?.addEventListener("click", () => {
      callService("lock", locked ? "unlock" : "lock", IDS.lock).then(() => window.setTimeout(render, 400));
    });
  }

  function wireCarLayout() {
    const layout = BeastConfig.get("pageLayouts.car.carLayout") || {};
    const hidden = new Set(Array.isArray(layout.hidden) ? layout.hidden : []);
    const shell = containerEl.querySelector(".beast-car-v3-shell");
    shell?.classList.toggle("is-layout-hidden", hidden.has("details"));
    BeastNativePageEditor.mount({
      section: "car",
      label: "Bil",
      root: () => containerEl,
      host: () => containerEl,
      trigger: "#beastCarLayoutEdit",
      cards: () => [{ id: "details", label: "Biloversigt", selector: ".beast-car-v3-shell", enabled: !hidden.has("details"), desktop: { x: 1, y: 1, w: 12, h: 12 } }]
    });
  }

  function init(root) {
    applyConfig();
    injectStyles();
    containerEl = root;
    containerEl.classList.add("beast-car-panel", "beast-car-v3");
    containerEl.innerHTML = `<p class="beast-music-empty">Henter…</p>`;
    BeastHaSocket.onStatusChange((status) => { if (status === "connected") render(); });
    const debouncedRender = BeastCore.stableUpdater(containerEl, render, 300);
    Object.values(IDS).filter(Boolean).forEach((id) => BeastHaSocket.subscribeEntity(id, debouncedRender));
  }

  BeastCore.registerPanel("car", "beastCarZone", init);
})();
