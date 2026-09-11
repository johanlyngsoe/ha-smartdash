(function () {
  const MODEL_Y_IMAGE_URL = "https://static-assets.tesla.com/v1/compositor/?model=my&view=STUD_3QTR&size=1440&bkba_opt=1&options=$PBSB,$WY19B,$MTY09,$INPB0&crop=1450,500,250,300";

  function injectStyles() {
    if (document.getElementById("beastCarVisualFixStyles")) return;
    const style = document.createElement("style");
    style.id = "beastCarVisualFixStyles";
    style.textContent = `
      .beast-car-v3-visual{height:360px!important;width:min(100%,620px)!important;margin-top:0!important}
      .beast-car-v3-model-y-host{top:8px!important;width:520px!important;height:320px!important;background:transparent!important;overflow:visible!important}
      .beast-car-v3-model-y-image{width:100%!important;height:100%!important;object-fit:contain!important;background:transparent!important;transform:scale(1.12);transform-origin:center center;filter:drop-shadow(0 18px 18px rgba(0,0,0,.24))!important}

      .beast-car-v3-tire{
        min-width:82px!important;
        min-height:52px!important;
        padding:7px 10px 8px!important;
        border:1px solid var(--border-strong)!important;
        border-radius:14px!important;
        background:var(--surface-2)!important;
        box-shadow:var(--shadow-card)!important;
        backdrop-filter:blur(12px)!important;
        -webkit-backdrop-filter:blur(12px)!important;
        grid-template-columns:auto auto!important;
        column-gap:5px!important;
      }
      .beast-car-v3-tire small{color:var(--ink-muted)!important;font-size:.63rem!important;font-weight:800!important;letter-spacing:.06em!important}
      .beast-car-v3-tire strong{color:var(--ink)!important;font-size:1.32rem!important;line-height:1.05!important;font-weight:850!important}
      .beast-car-v3-tire span{color:var(--ink-muted)!important;font-size:.64rem!important;font-weight:700!important}
      .beast-car-v3-tire.is-low{border-color:color-mix(in srgb,var(--warning) 45%,transparent)!important;background:var(--warning-soft)!important}
      .beast-car-v3-tire.is-low strong{color:var(--warning)!important}

      /* Perspective placement:
         FH = front-right = upper-left
         FV = front-left = lower-left
         BH = rear-right = upper-right
         BV = rear-left = lower-right */
      .beast-car-v3-tire-fl{left:48px!important;right:auto!important;top:auto!important;bottom:42px!important}
      .beast-car-v3-tire-fr{left:48px!important;right:auto!important;top:66px!important;bottom:auto!important}
      .beast-car-v3-tire-rl{left:auto!important;right:48px!important;top:auto!important;bottom:42px!important}
      .beast-car-v3-tire-rr{left:auto!important;right:48px!important;top:66px!important;bottom:auto!important}

      .beast-car-v3-map-card{padding:18px 20px 20px;overflow:hidden}
      .beast-car-v3-map-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:12px}
      .beast-car-v3-map-location{color:var(--ink-muted);font-size:var(--text-xs);font-weight:700}
      .beast-car-v3-map-frame{position:relative;width:100%;height:300px;overflow:hidden;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface-solid)}
      .beast-car-v3-map-frame iframe{width:100%;height:100%;border:0;display:block}
      .beast-car-v3-map-empty{min-height:170px;display:grid;place-items:center;padding:24px;text-align:center;color:var(--ink-muted);font-size:var(--text-sm)}

      @media(max-width:700px){
        .beast-car-v3-visual{height:345px!important}
        .beast-car-v3-model-y-host{top:4px!important;width:480px!important;height:300px!important}
        .beast-car-v3-model-y-image{transform:scale(1.08)}
        .beast-car-v3-tire-fl{left:34px!important;bottom:38px!important}
        .beast-car-v3-tire-fr{left:34px!important;top:60px!important}
        .beast-car-v3-tire-rl{right:34px!important;bottom:38px!important}
        .beast-car-v3-tire-rr{right:34px!important;top:60px!important}
        .beast-car-v3-map-frame{height:260px}
      }
    `;
    document.head.appendChild(style);
  }

  function applyImage() {
    const image = document.querySelector(".beast-car-v3-model-y-image");
    if (!image) return false;
    if (image.getAttribute("src") !== MODEL_Y_IMAGE_URL) image.setAttribute("src", MODEL_Y_IMAGE_URL);
    image.setAttribute("alt", "Sort Tesla Model Y 2021");
    return true;
  }

  function mapLabel(tracker) {
    if (!tracker) return "Ukendt";
    if (tracker.state === "home") return "Hjemme";
    if (["not_home", "away"].includes(tracker.state)) return "Ude";
    return tracker.state || "Ukendt";
  }

  function getMapState() {
    const config = BeastConfig.get("panels.car") || {};
    const tracker = config.locationTracker ? BeastHaSocket.getState(config.locationTracker) : null;
    const latitude = Number(tracker?.attributes?.latitude);
    const longitude = Number(tracker?.attributes?.longitude);
    const label = mapLabel(tracker);
    const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);
    const key = hasCoordinates
      ? `${latitude.toFixed(6)}:${longitude.toFixed(6)}:${label}`
      : `no-coordinates:${label}`;
    return { latitude, longitude, label, hasCoordinates, key };
  }

  function mapMarkup(state) {
    const { latitude, longitude, label, hasCoordinates, key } = state;
    if (!hasCoordinates) {
      return `<section class="beast-car-v3-card beast-car-v3-map-card" data-car-map="1" data-car-map-key="${key}">
        <div class="beast-car-v3-map-head">
          <span class="beast-car-v3-section-label">Placering</span>
          <span class="beast-car-v3-map-location">${label}</span>
        </div>
        <div class="beast-car-v3-map-empty">Yrsa har endnu ikke GPS-koordinater på den valgte device tracker.</div>
      </section>`;
    }

    const latSpan = 0.018;
    const lonSpan = 0.028;
    const bbox = [longitude - lonSpan, latitude - latSpan, longitude + lonSpan, latitude + latSpan]
      .map((value) => value.toFixed(6)).join("%2C");
    const marker = `${latitude.toFixed(6)}%2C${longitude.toFixed(6)}`;
    const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${marker}`;

    return `<section class="beast-car-v3-card beast-car-v3-map-card" data-car-map="1" data-car-map-key="${key}">
      <div class="beast-car-v3-map-head">
        <span class="beast-car-v3-section-label">Placering</span>
        <span class="beast-car-v3-map-location">${label}</span>
      </div>
      <div class="beast-car-v3-map-frame">
        <iframe title="Yrsa placering" loading="lazy" referrerpolicy="no-referrer" src="${src}"></iframe>
      </div>
    </section>`;
  }

  function applyMap() {
    const shell = document.querySelector(".beast-car-v3-shell");
    if (!shell) return false;
    const info = shell.querySelector(".beast-car-v3-info");
    if (!info) return false;

    const mapState = getMapState();
    const current = shell.querySelector('[data-car-map="1"]');
    if (current?.dataset?.carMapKey === mapState.key) return true;

    const markup = mapMarkup(mapState);
    if (current) current.outerHTML = markup;
    else info.insertAdjacentHTML("afterend", markup);
    return true;
  }

  function apply() {
    injectStyles();
    applyImage();
    applyMap();
  }

  let applying = false;
  const observer = new MutationObserver(() => {
    if (applying) return;
    applying = true;
    queueMicrotask(() => {
      try { apply(); } finally { applying = false; }
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
  else apply();
})();
