(function () {
  const IDS = {
    mower: "lawn_mower.robogub",
    tracker: "device_tracker.robogub_luba_vp9qgz3b",
    latitude: "sensor.robogub_breddegrad",
    longitude: "sensor.robogub_laengdegrad",
    battery: "sensor.robogub_batteri",
    activity: "sensor.robogub_aktivitetstilstand",
    location: "sensor.robogub_nuvaerende_placering",
    progress: "sensor.robogub_fremdrift",
    remaining: "sensor.robogub_tid_tilbage",
    area: "sensor.robogub_omrade",
    connection: "sensor.robogub_forbindelse",
    rtk: "sensor.robogub_rtk_position",
    satellites: "sensor.robogub_satellitter_robot",
    wifi: "sensor.robogub_wifi_rssi",
    lastError: "sensor.robogub_seneste_fejl",
    lastErrorCode: "sensor.robogub_seneste_fejl_kode",
    lastErrorAt: "sensor.robogub_tidspunkt_for_seneste_fejl",
    cancelTask: "button.robogub_annuller_nuvaerende_opgave",
    taskGarden4: "button.robogub_have_nr_4",
    taskSlope4: "button.robogub_skraaning_nr_4",
    task1: "button.robogub_opgave_1",
    task2: "button.robogub_opgave_2",
    task3: "button.robogub_opgave_3",
    syncSchedule: "button.robogub_synkroniser_tidsplaner"
  };

  const POSITION_CACHE_KEY = "beast_robogub_last_position_v1";
  let renderQueued = false;

  function haState(id) { return window.BeastHaSocket?.getState(id) || null; }
  function stateValue(id, fallback = "–") {
    const value = haState(id)?.state;
    return !value || ["unknown", "unavailable"].includes(value) ? fallback : value;
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
  }
  function numberValue(id) {
    const value = Number(haState(id)?.state);
    return Number.isFinite(value) ? value : null;
  }

  function currentPosition() {
    const tracker = haState(IDS.tracker);
    let latitude = Number(tracker?.attributes?.latitude);
    let longitude = Number(tracker?.attributes?.longitude);
    let direction = Number(tracker?.attributes?.direction);
    let updatedAt = tracker?.last_updated || tracker?.last_changed || null;
    let source = "live";

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      latitude = numberValue(IDS.latitude);
      longitude = numberValue(IDS.longitude);
      updatedAt = haState(IDS.latitude)?.last_updated || haState(IDS.longitude)?.last_updated || updatedAt;
    }

    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      try { localStorage.setItem(POSITION_CACHE_KEY, JSON.stringify({ latitude, longitude, direction, updatedAt })); } catch (_) {}
      return { latitude, longitude, direction, updatedAt, source };
    }

    try {
      const cached = JSON.parse(localStorage.getItem(POSITION_CACHE_KEY) || "null");
      if (Number.isFinite(Number(cached?.latitude)) && Number.isFinite(Number(cached?.longitude))) {
        return { ...cached, latitude: Number(cached.latitude), longitude: Number(cached.longitude), source: "cached" };
      }
    } catch (_) {}
    return null;
  }

  function mapUrl(position) {
    if (!position) return "";
    const lat = Number(position.latitude);
    const lon = Number(position.longitude);
    const latSpan = 0.0011;
    const lonSpan = 0.0022;
    const bbox = [lon - lonSpan, lat - latSpan, lon + lonSpan, lat + latSpan].join(",");
    return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(`${lat},${lon}`)}`;
  }

  function formatAge(timestamp) {
    if (!timestamp) return "ukendt";
    const time = new Date(timestamp).getTime();
    if (!Number.isFinite(time)) return "ukendt";
    const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
    if (minutes < 2) return "lige nu";
    if (minutes < 60) return `${minutes} min siden`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} t siden`;
    return `${Math.round(hours / 24)} d siden`;
  }

  function formatDuration(value) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes)) return value || "–";
    if (minutes < 60) return `${Math.round(minutes)} min`;
    const hours = Math.floor(minutes / 60);
    const rest = Math.round(minutes % 60);
    return rest ? `${hours} t ${rest} min` : `${hours} t`;
  }

  function friendlyActivity(value) {
    const labels = {
      MODE_READY: "Klar",
      MODE_WORKING: "Arbejder",
      MODE_RETURNING: "På vej hjem",
      MODE_CHARGING: "Oplader",
      MODE_PAUSED: "Pause",
      MODE_ERROR: "Fejl"
    };
    return labels[value] || value || stateValue(IDS.mower, "Ukendt");
  }

  function service(domain, serviceName, entityId, data = {}) {
    return window.BeastAuth.haFetch(`/api/services/${domain}/${serviceName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity_id: entityId, ...data })
    });
  }

  function entityAvailable(id) {
    const entity = haState(id);
    return !!entity && entity.state !== "unavailable";
  }

  function actionButton(label, action, icon, extraClass = "") {
    return `<button type="button" class="beast-robogub-action ${extraClass}" data-robogub-action="${action}">${window.BeastCore.icon(icon, { size: 19 })}<span>${escapeHtml(label)}</span></button>`;
  }

  function taskButton(id, fallbackLabel) {
    if (!entityAvailable(id)) return "";
    const label = haState(id)?.attributes?.friendly_name?.replace(/^RoboGub\s+/i, "") || fallbackLabel;
    return `<button type="button" class="beast-robogub-task" data-robogub-button="${escapeHtml(id)}">${window.BeastCore.icon("check", { size: 17 })}<span>${escapeHtml(label)}</span></button>`;
  }

  function buildMarkup() {
    const position = currentPosition();
    const activity = friendlyActivity(stateValue(IDS.activity, ""));
    const progress = stateValue(IDS.progress, "0");
    const remaining = formatDuration(stateValue(IDS.remaining, "0"));
    const battery = stateValue(IDS.battery, haState(IDS.mower)?.attributes?.battery_level ?? "–");
    const location = stateValue(IDS.location, stateValue(IDS.area, "Ukendt"));
    const connection = stateValue(IDS.connection, "–");
    const rtk = stateValue(IDS.rtk, "–");
    const satellites = stateValue(IDS.satellites, "–");
    const wifi = stateValue(IDS.wifi, "–");
    const errorCode = stateValue(IDS.lastErrorCode, "–");
    const errorText = stateValue(IDS.lastError, "Ingen fejl");
    const errorAt = haState(IDS.lastErrorAt)?.state;
    const hasUsefulError = errorCode !== "–" && errorCode !== "0";
    const map = mapUrl(position);

    return `
      <div class="beast-robogub-console">
        <div class="beast-robogub-hero">
          <div class="beast-robogub-map-wrap">
            ${map ? `<iframe class="beast-robogub-map" src="${escapeHtml(map)}" loading="lazy" referrerpolicy="no-referrer" title="RoboGubs seneste position"></iframe>` : `<div class="beast-robogub-map-empty">${window.BeastCore.icon("map", { size: 36 })}<strong>Ingen position endnu</strong><span>GPS-position vises, når Home Assistant leverer koordinater.</span></div>`}
            <div class="beast-robogub-map-caption">
              <span>${window.BeastCore.icon("map-pin", { size: 15 })} ${position?.source === "cached" ? "Senest kendte position" : "Aktuel position"}</span>
              <span>${position ? formatAge(position.updatedAt) : "–"}${Number.isFinite(Number(position?.direction)) ? ` · ${Math.round(position.direction)}°` : ""}</span>
            </div>
          </div>
          <div class="beast-robogub-status">
            <div class="beast-robogub-status-main"><small>Status</small><strong>${escapeHtml(activity)}</strong><span>${escapeHtml(location)}</span></div>
            <div class="beast-robogub-metrics">
              <div><small>Batteri</small><strong>${escapeHtml(battery)}%</strong></div>
              <div><small>Fremdrift</small><strong>${escapeHtml(progress)}%</strong></div>
              <div><small>Tid tilbage</small><strong>${escapeHtml(remaining)}</strong></div>
              <div><small>RTK</small><strong>${escapeHtml(rtk)}</strong></div>
            </div>
            <div class="beast-robogub-signal-row"><span>${escapeHtml(connection)}</span><span>${escapeHtml(satellites)} satellitter</span><span>WiFi ${escapeHtml(wifi)} dBm</span></div>
            ${hasUsefulError ? `<div class="beast-robogub-error"><strong>Seneste fejl ${escapeHtml(errorCode)}</strong><span>${escapeHtml(errorText)}${errorAt && errorAt !== "unknown" ? ` · ${formatAge(errorAt)}` : ""}</span></div>` : ""}
          </div>
        </div>

        <div class="beast-robogub-primary-actions">
          ${actionButton("Stop opgave", "cancel", "close", "is-danger")}
          ${actionButton("Hjem til dock", "dock", "home")}
          ${actionButton("Have nr. 4", "garden4", "check", "is-primary")}
          ${actionButton("Skråning nr. 4", "slope4", "check", "is-primary")}
        </div>

        <div class="beast-robogub-lower">
          <section class="beast-robogub-section">
            <div class="beast-robogub-section-head"><div><small>Opgaver</small><strong>Start en gemt opgave</strong></div></div>
            <div class="beast-robogub-task-grid">
              ${taskButton(IDS.taskGarden4, "Have nr. 4")}
              ${taskButton(IDS.taskSlope4, "Skråning nr. 4")}
              ${taskButton(IDS.task1, "Opgave-1")}
              ${taskButton(IDS.task2, "Opgave-2")}
              ${taskButton(IDS.task3, "Opgave-3")}
            </div>
          </section>
          <section class="beast-robogub-section beast-robogub-schedule">
            <div class="beast-robogub-section-head"><div><small>Tidsplan</small><strong>Mammotion-plan</strong></div>${entityAvailable(IDS.syncSchedule) ? `<button type="button" data-robogub-button="${IDS.syncSchedule}">Synkroniser</button>` : ""}</div>
            <p>Den aktuelle integration eksponerer endnu ikke planens køretider som kalenderdata. Opgaverne ovenfor kan startes herfra, mens tidsplanen fortsat vedligeholdes i Mammotion.</p>
          </section>
        </div>
      </div>`;
  }

  function findCard() {
    const cards = Array.from(document.querySelectorAll("#beastRobotsGrid [data-builder-card]"));
    return cards.find((card) => /robogub/i.test(card.textContent || "")) || null;
  }

  function hideOriginalSections(card) {
    card.querySelectorAll(".beast-robot-media, .beast-robot-facts, .beast-robot-actions, .beast-robot-settings, .beast-robot-quick-actions").forEach((el) => el.classList.add("beast-robogub-original-hidden"));
  }

  function enhance() {
    renderQueued = false;
    const card = findCard();
    if (!card || card.querySelector(".beast-robogub-console")) return;
    const article = card.querySelector(".beast-robot-card");
    if (!article) return;
    hideOriginalSections(card);
    const holder = document.createElement("div");
    holder.innerHTML = buildMarkup();
    article.appendChild(holder.firstElementChild);
    wire(card);
  }

  function queueEnhance() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(enhance);
  }

  function wire(card) {
    card.querySelectorAll("[data-robogub-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const action = button.dataset.robogubAction;
          if (action === "cancel") await service("button", "press", IDS.cancelTask);
          if (action === "dock") await service("lawn_mower", "dock", IDS.mower);
          if (action === "garden4") await service("button", "press", IDS.taskGarden4);
          if (action === "slope4") await service("button", "press", IDS.taskSlope4);
        } catch (error) {
          window.BeastCore.log(`RoboGub: handling fejlede (${error.message}).`);
        } finally {
          window.setTimeout(() => { button.disabled = false; }, 800);
        }
      });
    });
    card.querySelectorAll("[data-robogub-button]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try { await service("button", "press", button.dataset.robogubButton); }
        catch (error) { window.BeastCore.log(`RoboGub: opgave fejlede (${error.message}).`); }
        finally { window.setTimeout(() => { button.disabled = false; }, 800); }
      });
    });
  }

  function addStyles() {
    if (document.getElementById("beastRobogubStyles")) return;
    const style = document.createElement("style");
    style.id = "beastRobogubStyles";
    style.textContent = `
      .beast-robogub-original-hidden{display:none!important}
      .beast-robogub-console{display:grid;gap:14px;margin-top:12px}
      .beast-robogub-hero{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(260px,.8fr);gap:14px}
      .beast-robogub-map-wrap,.beast-robogub-status,.beast-robogub-section{border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface-2);overflow:hidden}
      .beast-robogub-map{display:block;width:100%;height:310px;border:0;background:var(--surface-solid)}
      .beast-robogub-map-empty{height:310px;display:grid;place-items:center;align-content:center;gap:7px;color:var(--ink-muted);text-align:center;padding:20px}.beast-robogub-map-empty strong{color:var(--ink)}
      .beast-robogub-map-caption{display:flex;justify-content:space-between;gap:10px;padding:9px 12px;color:var(--ink-muted);font-size:var(--text-xs)}.beast-robogub-map-caption span{display:inline-flex;align-items:center;gap:6px}
      .beast-robogub-status{padding:16px;display:grid;align-content:start;gap:14px}.beast-robogub-status-main small,.beast-robogub-metrics small,.beast-robogub-section-head small{display:block;color:var(--ink-muted);font-size:var(--text-xs);text-transform:uppercase;letter-spacing:.06em}.beast-robogub-status-main strong{display:block;font-size:clamp(1.45rem,2vw,2rem);margin-top:2px}.beast-robogub-status-main span{color:var(--ink-muted)}
      .beast-robogub-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.beast-robogub-metrics>div{padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-solid)}.beast-robogub-metrics strong{display:block;margin-top:3px;font-size:var(--text-lg)}
      .beast-robogub-signal-row{display:flex;flex-wrap:wrap;gap:7px}.beast-robogub-signal-row span{padding:5px 8px;border-radius:999px;background:var(--accent-soft);color:var(--ink-muted);font-size:var(--text-xs)}
      .beast-robogub-error{padding:10px 11px;border:1px solid color-mix(in srgb,var(--danger) 35%,transparent);border-radius:var(--radius-sm);background:color-mix(in srgb,var(--danger) 8%,transparent)}.beast-robogub-error strong,.beast-robogub-error span{display:block}.beast-robogub-error span{margin-top:2px;color:var(--ink-muted);font-size:var(--text-xs)}
      .beast-robogub-primary-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.beast-robogub-action,.beast-robogub-task,.beast-robogub-section-head button{appearance:none;min-height:54px;border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--ink);font:inherit;font-weight:750;display:flex;align-items:center;justify-content:center;gap:7px;touch-action:manipulation}.beast-robogub-action.is-primary{border-color:var(--accent-border);background:var(--accent-soft);color:var(--accent)}.beast-robogub-action.is-danger{border-color:color-mix(in srgb,var(--danger) 38%,transparent);color:var(--danger)}.beast-robogub-action:disabled,.beast-robogub-task:disabled,.beast-robogub-section-head button:disabled{opacity:.45}
      .beast-robogub-lower{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(260px,.75fr);gap:14px}.beast-robogub-section{padding:14px}.beast-robogub-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.beast-robogub-section-head strong{display:block;margin-top:2px}.beast-robogub-section-head button{min-height:40px;padding:7px 11px}.beast-robogub-task-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px}.beast-robogub-task{justify-content:flex-start;padding:8px 10px}.beast-robogub-schedule p{margin:12px 0 0;color:var(--ink-muted);font-size:var(--text-sm);line-height:1.45}
      @media(max-width:900px){.beast-robogub-hero,.beast-robogub-lower{grid-template-columns:1fr}.beast-robogub-primary-actions{grid-template-columns:repeat(2,minmax(0,1fr))}.beast-robogub-map{height:280px}}
      @media(max-width:560px){.beast-robogub-task-grid{grid-template-columns:1fr 1fr}.beast-robogub-map-caption{flex-direction:column}}
    `;
    document.head.appendChild(style);
  }

  function subscribe() {
    Object.values(IDS).filter((id) => /^(sensor|device_tracker|lawn_mower)\./.test(id)).forEach((id) => window.BeastHaSocket.subscribeEntity(id, queueEnhance));
  }

  function init() {
    addStyles();
    const root = document.getElementById("beastRoot") || document.body;
    new MutationObserver(queueEnhance).observe(root, { childList: true, subtree: true });
    subscribe();
    queueEnhance();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
