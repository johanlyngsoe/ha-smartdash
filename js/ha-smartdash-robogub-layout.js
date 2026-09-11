(function () {
  const TRACKER = "device_tracker.robogub_luba_vp9qgz3b";

  function mapUrl(latitude, longitude) {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
    // Roughly an 80 x 90 metre viewport around the mower: tight enough to
    // recognise the garden, while still leaving useful context if RoboGub
    // stops near the edge of the property.
    const latSpan = 0.00035;
    const lonSpan = 0.00070;
    const bbox = [lon - lonSpan, lat - latSpan, lon + lonSpan, lat + latSpan].join(",");
    return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(`${lat},${lon}`)}`;
  }

  function apply() {
    const consoleEl = document.querySelector("#beastRobotsGrid .beast-robogub-console");
    if (!consoleEl) return;

    const card = consoleEl.closest("[data-builder-card]");
    if (card) {
      // RoboGub is an operational dashboard rather than a compact status
      // tile. Give it more horizontal room on desktop, but leave tablet and
      // portrait sizing under the existing page builder's control.
      card.style.setProperty("--desktop-w", "8");
      card.classList.add("beast-robogub-wide-card");
    }

    const iframe = consoleEl.querySelector(".beast-robogub-map");
    const tracker = BeastHaSocket.getState(TRACKER);
    const nextMap = mapUrl(tracker?.attributes?.latitude, tracker?.attributes?.longitude);
    if (iframe && nextMap && iframe.dataset.tightMap !== nextMap) {
      iframe.dataset.tightMap = nextMap;
      iframe.src = nextMap;
    }
  }

  function addStyles() {
    if (document.getElementById("beastRobogubLayoutStyles")) return;
    const style = document.createElement("style");
    style.id = "beastRobogubLayoutStyles";
    style.textContent = `
      .beast-robogub-wide-card .beast-robogub-console{gap:16px}
      .beast-robogub-wide-card .beast-robogub-hero{grid-template-columns:minmax(0,1.55fr) minmax(300px,.85fr);gap:16px}
      .beast-robogub-wide-card .beast-robogub-map{height:365px}
      .beast-robogub-wide-card .beast-robogub-map-empty{height:365px}
      .beast-robogub-wide-card .beast-robogub-status{padding:18px;gap:16px}
      .beast-robogub-wide-card .beast-robogub-primary-actions{gap:11px}
      .beast-robogub-wide-card .beast-robogub-lower{grid-template-columns:minmax(0,1.35fr) minmax(320px,.65fr);gap:16px}
      .beast-robogub-wide-card .beast-robogub-section{padding:16px}
      .beast-robogub-wide-card .beast-robogub-task-grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
      @media(max-width:900px){
        .beast-robogub-wide-card .beast-robogub-hero,.beast-robogub-wide-card .beast-robogub-lower{grid-template-columns:1fr}
        .beast-robogub-wide-card .beast-robogub-map,.beast-robogub-wide-card .beast-robogub-map-empty{height:300px}
        .beast-robogub-wide-card .beast-robogub-task-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      }
    `;
    document.head.appendChild(style);
  }

  function init() {
    addStyles();
    apply();
    const root = document.getElementById("beastRoot") || document.body;
    new MutationObserver(() => requestAnimationFrame(apply)).observe(root, { childList: true, subtree: true });
    BeastHaSocket.subscribeEntity(TRACKER, apply);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
