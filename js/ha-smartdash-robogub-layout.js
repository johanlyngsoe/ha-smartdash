(function () {
  const TRACKER = "device_tracker.robogub_luba_vp9qgz3b";
  const ACTIVITY = "sensor.robogub_aktivitetstilstand";
  const LOCATION = "sensor.robogub_nuvaerende_placering";
  const PROGRESS = "sensor.robogub_fremdrift";
  const REMAINING = "sensor.robogub_tid_tilbage";
  const MOWER = "lawn_mower.robogub";
  let applyQueued = false;

  function state(id) { return BeastHaSocket.getState(id)?.state || ""; }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
  }
  function formatDuration(value) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes <= 0) return "–";
    if (minutes < 60) return `${Math.round(minutes)} min`;
    const hours = Math.floor(minutes / 60);
    const rest = Math.round(minutes % 60);
    return rest ? `${hours} t ${rest} min` : `${hours} t`;
  }
  function isWorking(value) {
    return /working|mowing|moving|returning|pause|paused|MODE_WORKING|MODE_RETURNING|MODE_PAUSED/i.test(value || "");
  }
  function isDocked() {
    const mower = state(MOWER);
    const activity = state(ACTIVITY);
    return /dock|charging/i.test(`${mower} ${activity}`);
  }

  function mapUrl(latitude, longitude) {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
    const latSpan = 0.00035;
    const lonSpan = 0.00070;
    const bbox = [lon - lonSpan, lat - latSpan, lon + lonSpan, lat + latSpan].join(",");
    return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(`${lat},${lon}`)}`;
  }

  function updateCurrentTask(consoleEl) {
    const lower = consoleEl.querySelector(".beast-robogub-lower");
    if (!lower) return;
    let current = lower.querySelector(".beast-robogub-current");
    if (!current) {
      current = document.createElement("section");
      current.className = "beast-robogub-current";
      lower.prepend(current);
    }
    const activity = state(ACTIVITY) || state(MOWER) || "Ukendt";
    const location = state(LOCATION) || "Ingen aktiv opgave";
    const progress = Math.max(0, Math.min(100, Number(state(PROGRESS)) || 0));
    const markup = `<div><small>Aktuel opgave</small><strong>${escapeHtml(location)}</strong></div><div class="beast-robogub-current-state"><span>${escapeHtml(activity)}</span><span>${progress}% · ${escapeHtml(formatDuration(state(REMAINING)))}</span></div><div class="beast-robogub-progressbar" style="--robogub-progress:${progress}%"><span></span></div>`;
    if (current.dataset.renderMarkup === markup) return;
    current.dataset.renderMarkup = markup;
    current.innerHTML = markup;
  }

  function updateActions(consoleEl) {
    const working = isWorking(state(ACTIVITY));
    const stop = consoleEl.querySelector('[data-robogub-action="cancel"]');
    const dock = consoleEl.querySelector('[data-robogub-action="dock"]');
    if (stop) { stop.disabled = !working; stop.dataset.smartDisabled = String(!working); }
    if (dock) { const disabled = isDocked(); dock.disabled = disabled; dock.dataset.smartDisabled = String(disabled); }
  }

  function apply() {
    applyQueued = false;
    const consoleEl = document.querySelector("#beastRobotsGrid .beast-robogub-console");
    if (!consoleEl) return;
    const card = consoleEl.closest("[data-builder-card]");
    if (card) {
      card.style.setProperty("--desktop-w", "12");
      card.style.gridColumn = "1 / -1";
      card.style.gridRow = "auto";
      card.style.height = "auto";
      card.classList.add("beast-robogub-wide-card");
    }
    const iframe = consoleEl.querySelector(".beast-robogub-map");
    const tracker = BeastHaSocket.getState(TRACKER);
    const nextMap = mapUrl(tracker?.attributes?.latitude, tracker?.attributes?.longitude);
    if (iframe && nextMap && iframe.dataset.tightMap !== nextMap) {
      iframe.dataset.tightMap = nextMap;
      iframe.src = nextMap;
    }
    updateCurrentTask(consoleEl);
    updateActions(consoleEl);
  }

  function queueApply() {
    if (applyQueued) return;
    applyQueued = true;
    requestAnimationFrame(apply);
  }

  function mutationAddsRoboGub(mutations) {
    return mutations.some((mutation) => Array.from(mutation.addedNodes || []).some((node) => {
      if (!(node instanceof Element)) return false;
      return node.matches?.(".beast-robogub-console, #beastRobotsGrid") || !!node.querySelector?.(".beast-robogub-console, #beastRobotsGrid");
    }));
  }

  function addStyles() {
    if (document.getElementById("beastRobogubLayoutStyles")) return;
    const style = document.createElement("style");
    style.id = "beastRobogubLayoutStyles";
    style.textContent = `
      #beastRobotsGrid .beast-robogub-wide-card{grid-column:1 / -1!important;grid-row:auto!important;width:100%!important;max-width:none!important;height:auto!important;min-height:0!important;align-self:start!important;overflow:visible!important}
      .beast-robogub-wide-card .beast-robot-card{height:auto!important;min-height:0!important;overflow:visible!important}
      .beast-robogub-wide-card .beast-robogub-console{gap:16px}
      .beast-robogub-wide-card .beast-robogub-hero{grid-template-columns:minmax(0,1.65fr) minmax(340px,.75fr);gap:16px}
      .beast-robogub-wide-card .beast-robogub-map,.beast-robogub-wide-card .beast-robogub-map-empty{height:410px}
      .beast-robogub-wide-card .beast-robogub-status{padding:18px;gap:16px}
      .beast-robogub-wide-card .beast-robogub-primary-actions{gap:11px}
      .beast-robogub-wide-card .beast-robogub-lower{grid-template-columns:minmax(260px,.75fr) minmax(0,1.25fr) minmax(300px,.75fr);gap:16px}
      .beast-robogub-current{padding:14px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface-2);display:grid;align-content:start;gap:11px}
      .beast-robogub-current small{display:block;color:var(--ink-muted);font-size:var(--text-xs);text-transform:uppercase;letter-spacing:.06em}
      .beast-robogub-current strong{display:block;margin-top:2px;font-size:var(--text-lg)}
      .beast-robogub-current-state{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--ink-muted);font-size:var(--text-sm)}
      .beast-robogub-progressbar{height:9px;overflow:hidden;border-radius:999px;background:var(--surface-solid);border:1px solid var(--border)}
      .beast-robogub-progressbar>span{display:block;height:100%;width:var(--robogub-progress,0%);background:var(--accent);border-radius:inherit}
      .beast-robogub-action[data-smart-disabled="true"]{opacity:.38;cursor:default}
      @media(max-width:1100px){
        .beast-robogub-wide-card .beast-robogub-lower{grid-template-columns:1fr 1fr}
        .beast-robogub-current{grid-column:1 / -1}
        .beast-robogub-wide-card .beast-robogub-map,.beast-robogub-wide-card .beast-robogub-map-empty{height:340px}
      }
      @media(max-width:900px){
        .beast-robogub-wide-card .beast-robogub-hero,.beast-robogub-wide-card .beast-robogub-lower{grid-template-columns:1fr}
        .beast-robogub-current{grid-column:auto}
        .beast-robogub-wide-card .beast-robogub-primary-actions{grid-template-columns:repeat(2,minmax(0,1fr))}
        .beast-robogub-wide-card .beast-robogub-map,.beast-robogub-wide-card .beast-robogub-map-empty{height:300px}
      }
      @media(orientation:portrait){
        #beastRobotsGrid{display:block!important;height:auto!important;min-height:0!important;overflow:visible!important}
        #beastRobotsGrid .beast-robogub-wide-card{display:block!important;width:100%!important;max-width:none!important;height:auto!important;min-height:0!important;margin:0!important;overflow:visible!important}
        .beast-robogub-wide-card .beast-robot-card{width:100%!important;height:auto!important;min-height:0!important;overflow:visible!important}
        .beast-robogub-wide-card .beast-robogub-console{width:100%;gap:18px}
        .beast-robogub-wide-card .beast-robogub-hero{grid-template-columns:1fr!important;gap:18px}
        .beast-robogub-wide-card .beast-robogub-map,.beast-robogub-wide-card .beast-robogub-map-empty{height:440px!important}
        .beast-robogub-wide-card .beast-robogub-status{padding:20px;gap:16px}
        .beast-robogub-wide-card .beast-robogub-primary-actions{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:12px}
        .beast-robogub-wide-card .beast-robogub-lower{grid-template-columns:1fr!important;gap:16px}
        .beast-robogub-current{grid-column:auto!important}
        .beast-robogub-wide-card .beast-robogub-task-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}
        .beast-robogub-wide-card .beast-robogub-section{padding:18px}
      }
      @media(orientation:portrait) and (min-width:900px){
        .beast-robogub-wide-card .beast-robogub-map,.beast-robogub-wide-card .beast-robogub-map-empty{height:520px!important}
        .beast-robogub-wide-card .beast-robogub-status{display:grid;grid-template-columns:minmax(220px,.8fr) minmax(0,1.2fr);align-items:start}
        .beast-robogub-wide-card .beast-robogub-status-main{grid-row:1 / span 2}
        .beast-robogub-wide-card .beast-robogub-error{grid-column:1 / -1}
      }
    `;
    document.head.appendChild(style);
  }

  function init() {
    addStyles();
    queueApply();
    const root = document.getElementById("beastRoot") || document.body;
    new MutationObserver((mutations) => {
      if (mutationAddsRoboGub(mutations)) queueApply();
    }).observe(root, { childList: true, subtree: true });
    [TRACKER, ACTIVITY, LOCATION, PROGRESS, REMAINING, MOWER].forEach((id) => BeastHaSocket.subscribeEntity(id, queueApply));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
