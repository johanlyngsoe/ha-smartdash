(function () {
  let IDS = {};
  let VEHICLE_LABEL = "Elbil";
  let containerEl = null;

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
      energyAdded: config.energyAdded,
      tpmsFl: config.tpmsFl,
      tpmsFr: config.tpmsFr,
      tpmsRl: config.tpmsRl,
      tpmsRr: config.tpmsRr
    };
  }

  function callService(domain, service, entityId, data = {}) {
    if (!entityId) return Promise.resolve();
    return BeastAuth.haFetch(`/api/services/${domain}/${service}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity_id: entityId, ...data })
    }).catch((error) => BeastCore.log(`Bil: kommando fejlede (${error.message}).`));
  }

  function stateOf(id) { return id ? BeastHaSocket.getState(id) : null; }
  function isOn(id) { return stateOf(id)?.state === "on"; }
  function numeric(id, decimals = 0) {
    const value = Number(stateOf(id)?.state);
    return Number.isFinite(value) ? value.toFixed(decimals) : "–";
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
  }

  function locationLabel() {
    const tracker = stateOf(IDS.locationTracker);
    if (!tracker) return "Ukendt";
    if (tracker.state === "home") return "Hjemme";
    if (["not_home", "away"].includes(tracker.state)) return "Ude";
    return tracker.state || "Ukendt";
  }

  function driveState() {
    return String(stateOf(IDS.shiftState)?.state || "").trim().toUpperCase();
  }

  function primaryStatus() {
    const shift = driveState();
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
    if (!Number.isNaN(Date.parse(raw))) {
      const time = new Date(raw).toLocaleTimeString(window.HASmartdashI18n?.locale || "da-DK", { hour: "2-digit", minute: "2-digit" });
      return `Færdig kl. ${time}`;
    }
    return String(raw);
  }

  function pressureBar(id) {
    const psi = Number(stateOf(id)?.state);
    return Number.isFinite(psi) ? psi * 0.0689476 : null;
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
    const lowThreshold = 2.5 * 0.0689476;
    const tire = (key, label) => {
      const value = wheels[key];
      const low = highest !== null && Number.isFinite(value) && highest - value >= lowThreshold;
      return `<div class="beast-car-v3-tire beast-car-v3-tire-${key}${low ? " is-low" : "}"><small>${label}</small><strong>${Number.isFinite(value) ? value.toFixed(1) : "–"}</strong><span>bar</span></div>`;
    };

    return `<div class="beast-car-v3-visual-wrap">
      <span class="beast-car-v3-section-label">Dæktryk</span>
      <div class="beast-car-v3-visual">
        ${tire("fl", "FV")}
        ${tire("fr", "FH")}
        ${tire("rl", "BV")}
        ${tire("rr", "BH")}
        <svg class="beast-car-v3-car" viewBox="0 0 260 520" role="img" aria-label="Sort bil set ovenfra">
          <defs>
            <linearGradient id="beastCarBody" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#333840"/>
              <stop offset="0.28" stop-color="#11151a"/>
              <stop offset="0.7" stop-color="#050608"/>
              <stop offset="1" stop-color="#20252c"/>
            </linearGradient>
            <linearGradient id="beastCarGlass" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#344657" stop-opacity=".86"/>
              <stop offset="1" stop-color="#101820" stop-opacity=".95"/>
            </linearGradient>
            <filter id="beastCarShadow" x="-40%" y="-20%" width="180%" height="160%">
              <feGaussianBlur in="SourceAlpha" stdDeviation="10"/>
              <feOffset dy="12"/>
              <feComponentTransfer><feFuncA type="linear" slope=".38"/></feComponentTransfer>
              <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
          </defs>
          <ellipse cx="130" cy="483" rx="91" ry="19" fill="#000" opacity=".28"/>
          <g filter="url(#beastCarShadow)">
            <path d="M130 22 C91 22 66 45 53 88 L35 174 C27 214 27 310 36 351 L52 431 C59 469 83 493 130 498 C177 493 201 469 208 431 L224 351 C233 310 233 214 225 174 L207 88 C194 45 169 22 130 22Z" fill="url(#beastCarBody)" stroke="#4a5059" stroke-width="2"/>
            <path d="M77 102 C91 67 106 55 130 55 C154 55 169 67 183 102 L195 174 L65 174Z" fill="url(#beastCarGlass)" stroke="#53606b" stroke-width="1.5"/>
            <path d="M64 190 L196 190 L187 333 L73 333Z" fill="url(#beastCarGlass)" stroke="#45515c" stroke-width="1.5"/>
            <path d="M74 350 L186 350 L175 420 C169 451 153 467 130 470 C107 467 91 451 85 420Z" fill="#0c1015" stroke="#3a4149" stroke-width="1.5"/>
            <path d="M65 183 H195" stroke="#7d8995" stroke-opacity=".45"/>
            <path d="M72 340 H188" stroke="#7d8995" stroke-opacity=".35"/>
            <path d="M130 191 V332" stroke="#607080" stroke-opacity=".22"/>
            <path d="M48 143 C33 150 29 163 31 182 L37 230" fill="none" stroke="#252b31" stroke-width="13" stroke-linecap="round"/>
            <path d="M212 143 C227 150 231 163 229 182 L223 230" fill="none" stroke="#252b31" stroke-width="13" stroke-linecap="round"/>
            <rect x="28" y="128" width="12" height="72" rx="6" fill="#090a0c"/>
            <rect x="220" y="128" width="12" height="72" rx="6" fill="#090a0c"/>
            <rect x="28" y="335" width="12" height="72" rx="6" fill="#090a0c"/>
            <rect x="220" y="335" width="12" height="72" rx="6" fill="#090a0c"/>
            <path d="M94 36 C108 30 119 28 130 28 C141 28 152 30 166 36" fill="none" stroke="#d8e4ee" stroke-opacity=".42" stroke-width="3" stroke-linecap="round"/>
            <path d="M91 473 C106 480 118 484 130 484 C142 484 154 480 169 473" fill="none" stroke="#d14c4c" stroke-opacity=".48" stroke-width="4" stroke-linecap="round"/>
          </g>
        </svg>
      </div>
    </div>`;
  }

  function injectStyles() {
    if (document.getElementById("beastCarV3Styles")) return;
    const style = document.createElement("style");
    style.id = "beastCarV3Styles";
    style.textContent = `
      .beast-car-panel.beast-car-v2{display:block!important;overflow-y:auto!important}
      .beast-car-v3-shell{display:grid;grid-template-columns:1fr;gap:14px;width:min(100%,820px);margin:0 auto;padding:4px 0 18px}
      .beast-car-v3-card{border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface-2)}
      .beast-car-v3-hero{padding:22px 24px 20px;background:radial-gradient(circle at 18% 15%,rgba(83,190,255,.13),transparent 38%),var(--surface-2)}
      .beast-car-v3-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
      .beast-car-v3-name{font-size:clamp(1.25rem,2.5vw,1.65rem);font-weight:900;letter-spacing:.08em;text-transform:uppercase}
      .beast-car-v3-subtitle{display:block;margin-top:4px;color:var(--ink-muted);font-size:var(--text-xs);font-weight:700;letter-spacing:.08em;text-transform:uppercase}
      .beast-car-v3-status{display:inline-flex;align-items:center;gap:7px;padding:8px 12px;border-radius:999px;color:var(--accent);background:var(--accent-soft);font-size:var(--text-xs);font-weight:850;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
      .beast-car-v3-status:before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 10px currentColor}
      .beast-car-v3-status.is-charging{color:var(--success);background:var(--success-soft)}.beast-car-v3-status.is-driving{color:var(--warning);background:rgba(255,200,87,.12)}
      .beast-car-v3-energy{display:flex;align-items:flex-end;gap:18px;margin-top:18px}.beast-car-v3-energy strong{font-size:clamp(3.5rem,9vw,5.5rem);line-height:.85;letter-spacing:-.065em}.beast-car-v3-range{padding-bottom:4px;color:var(--ink-muted);font-size:clamp(1.25rem,3vw,1.8rem);font-weight:800}.beast-car-v3-range small{font-size:.55em;font-weight:700}
      .beast-car-v3-bar{height:10px;margin-top:18px;border:1px solid var(--border);border-radius:999px;background:var(--surface-solid);overflow:hidden}.beast-car-v3-bar i{display:block;width:var(--battery-level);height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--accent),var(--success));transition:width .7s ease}
      .beast-car-v3-charge{display:flex;justify-content:space-between;gap:12px;margin-top:10px;color:var(--ink-muted);font-size:var(--text-xs)}.beast-car-v3-charge strong{color:var(--ink)}
      .beast-car-v3-visual-wrap{position:relative;padding:18px 20px 14px;border:1px solid var(--border);border-radius:var(--radius-md);background:radial-gradient(circle at 50% 46%,rgba(80,115,145,.12),transparent 42%),var(--surface-2)}
      .beast-car-v3-section-label{display:block;color:var(--ink-muted);font-size:var(--text-xs);font-weight:800;text-transform:uppercase;letter-spacing:.1em}
      .beast-car-v3-visual{position:relative;width:min(100%,470px);height:520px;margin:2px auto 0}
      .beast-car-v3-car{position:absolute;left:50%;top:6px;width:238px;height:476px;transform:translateX(-50%);overflow:visible}
      .beast-car-v3-tire{position:absolute;z-index:2;display:grid;grid-template-columns:auto auto;column-gap:6px;align-items:baseline;min-width:78px;padding:8px 10px;border:1px solid var(--border);border-radius:12px;background:rgba(11,14,18,.88);backdrop-filter:blur(5px)}
      .beast-car-v3-tire small{grid-column:1/-1;color:var(--ink-muted);font-size:.65rem;font-weight:800}.beast-car-v3-tire strong{font-size:1.25rem}.beast-car-v3-tire span{color:var(--ink-muted);font-size:.68rem}.beast-car-v3-tire.is-low{border-color:rgba(255,200,87,.45)}.beast-car-v3-tire.is-low strong{color:var(--warning)}
      .beast-car-v3-tire-fl{left:5px;top:92px}.beast-car-v3-tire-fr{right:5px;top:92px}.beast-car-v3-tire-rl{left:5px;bottom:76px}.beast-car-v3-tire-rr{right:5px;bottom:76px}
      .beast-car-v3-info{display:grid;grid-template-columns:1.15fr .85fr;gap:14px}.beast-car-v3-status-card,.beast-car-v3-climate-card{padding:18px 20px}
      .beast-car-v3-state-list{display:grid;gap:3px;margin-top:12px}.beast-car-v3-state-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:42px;padding:7px 0;border-bottom:1px solid var(--border)}.beast-car-v3-state-row:last-child{border-bottom:0}.beast-car-v3-state-row span{color:var(--ink-muted);font-size:var(--text-sm)}.beast-car-v3-state-row strong{font-size:var(--text-sm)}
      .beast-car-v3-lock-btn{width:100%;min-height:52px;margin-top:14px}
      .beast-car-v3-climate{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}.beast-car-v3-temp{padding:14px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-solid)}.beast-car-v3-temp small{display:block;color:var(--ink-muted);font-size:var(--text-xs)}.beast-car-v3-temp strong{display:block;margin-top:4px;font-size:clamp(1.7rem,4vw,2.35rem)}
      @media(max-width:700px){.beast-car-v3-shell{width:100%}.beast-car-v3-info{grid-template-columns:1fr}.beast-car-v3-visual{height:490px}.beast-car-v3-car{width:220px;height:440px}.beast-car-v3-tire-fl,.beast-car-v3-tire-fr{top:86px}.beast-car-v3-tire-rl,.beast-car-v3-tire-rr{bottom:70px}}
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
    containerEl.classList.add("beast-car-panel", "beast-car-v2");
    containerEl.innerHTML = `<p class="beast-music-empty">Henter…</p>`;
    BeastHaSocket.onStatusChange((status) => { if (status === "connected") render(); });
    const debouncedRender = BeastCore.stableUpdater(containerEl, render, 300);
    Object.values(IDS).filter(Boolean).forEach((id) => BeastHaSocket.subscribeEntity(id, debouncedRender));
  }

  BeastCore.registerPanel("car", "beastCarZone", init);
})();