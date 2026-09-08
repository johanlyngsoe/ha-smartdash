window.BeastShopping = (() => {
  const TODO_ENTITY = "todo.google_keep_indkobsliste";
  const API_PATH = "./api/etilbudsavis/search";
  const PRICE_MONITOR_API = "./api/price-monitor.php";
  const CACHE_MS = 30 * 60 * 1000;
  const MAX_RESULTS = 20;

  let containerEl = null;
  let items = [];
  let offers = new Map();
  let searchErrors = new Map();
  let searchLimits = new Map();
  let refreshWarning = "";
  let selectedUid = null;
  let loading = false;
  let error = "";
  let lastRefresh = 0;
  let requestId = 0;
  const cache = new Map();
  let locationPromise = null;
  let monitoredProducts = [];
  let monitorBusy = false;
  let monitorError = "";

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  const english = () => String(document.documentElement.lang || "").toLowerCase().startsWith("en");
  const t = (da, en) => english() ? en : da;

  function normalizeTerm(value) {
    return String(value || "")
      .replace(/\btilbud\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function money(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? number.toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " kr."
      : "–";
  }

  function dateLabel(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("da-DK", { day: "numeric", month: "short" });
  }

  async function getMonitoredProducts() {
    const response = await fetch(PRICE_MONITOR_API, { cache: "no-store" });
    if (!response.ok) throw new Error(`Prisovervågning: HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.products)) {
      throw new Error("Uventet svar fra prisovervågning");
    }
    return payload.products;
  }

  function monitoredProductFor(item) {
    if (!item) return null;
    const name = normalizeTerm(item.summary).toLocaleLowerCase("da-DK");
    return monitoredProducts.find(
      (product) => normalizeTerm(product.name).toLocaleLowerCase("da-DK") === name
    ) || null;
  }

  async function addPriceMonitor(item) {
    if (!item || monitorBusy) return;

    monitorBusy = true;
    monitorError = "";
    render();

    try {
      const name = normalizeTerm(item.summary);
      const response = await fetch(PRICE_MONITOR_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          search_term: name
        })
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      }

      monitoredProducts = await getMonitoredProducts();
    } catch (err) {
      monitorError = err.message || String(err);
    } finally {
      monitorBusy = false;
      render();
    }
  }

  async function removePriceMonitor(product) {
    if (!product || monitorBusy) return;

    monitorBusy = true;
    monitorError = "";
    render();

    try {
      const response = await fetch(PRICE_MONITOR_API, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: product.id })
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      }

      monitoredProducts = await getMonitoredProducts();
    } catch (err) {
      monitorError = err.message || String(err);
    } finally {
      monitorBusy = false;
      render();
    }
  }

  async function getItems() {
    const response = await BeastAuth.haFetch("/api/services/todo/get_items?return_response=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity_id: TODO_ENTITY, status: ["needs_action"] })
    });
    const payload = response?.service_response || response;
    const result = payload?.[TODO_ENTITY]?.items;
    if (!Array.isArray(result)) throw new Error("Indkøbslisten kunne ikke læses");
    return result;
  }

  function validDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function isCurrentOffer(offer, now = Date.now()) {
    const from = validDate(offer.run_from);
    const till = validDate(offer.run_till);
    if (from && from.getTime() > now) return false;
    if (till && till.getTime() < now) return false;
    return true;
  }

  function unitPrice(offer) {
    const q = offer.quantity || {};
    const size = Number(q.size?.from);
    const pieces = Number(q.pieces?.from ?? 1);
    const unit = String(q.unit?.symbol || "").toLowerCase();
    const price = Number(offer.pricing?.price);

    // A range or mixed promotion cannot safely be represented by one unit price.
    if (q.size?.to != null && Number(q.size.to) !== size) return null;
    if (q.pieces?.to != null && Number(q.pieces.to) !== pieces) return null;
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(pieces) || pieces <= 0) return null;
    if (!Number.isFinite(price) || price <= 0) return null;

    const factors = {
      g: ["kg", 0.001], kg: ["kg", 1], hg: ["kg", 0.1],
      ml: ["liter", 0.001], cl: ["liter", 0.01], dl: ["liter", 0.1], l: ["liter", 1]
    };
    const factor = factors[unit];
    if (!factor) return null;
    const total = size * pieces * factor[1];
    if (!Number.isFinite(total) || total <= 0) return null;
    return { value: price / total, unit: factor[0] };
  }

  async function getLocation() {
    if (!locationPromise) {
      locationPromise = BeastAuth.haFetch("/api/config").then((config) => {
        const latitude = Number(config.latitude);
        const longitude = Number(config.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          throw new Error("HA har ingen gyldig lokation");
        }
        return { latitude, longitude };
      }).catch((error) => {
        locationPromise = null;
        throw error;
      });
    }
    return locationPromise;
  }

  async function searchOffers(term, force = false) {
    const key = term.toLocaleLowerCase("da-DK");
    const cached = cache.get(key);
    if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.data;

    const config = await getLocation();
    const params = new URLSearchParams({
      r_lat: String(config.latitude),
      r_lng: String(config.longitude),
      r_radius: "25000",
      r_locale: "da_DK",
      api_av: "0.3.0",
      query: term,
      offset: "0",
      limit: String(MAX_RESULTS)
    });

    const response = await fetch(`${API_PATH}?${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Tilbuds-API: HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("Uventet svar fra tilbuds-API");
    const current = data.filter((offer) => isCurrentOffer(offer));
    const result = { data: current, limited: data.length >= MAX_RESULTS };
    cache.set(key, { at: Date.now(), data: result });
    return result;
  }

  const SEARCH_PROFILES = {
    pasta: {
      positive: ["pasta", "spaghetti", "fusilli", "penne", "farfalle", "fettuccine", "lasagneplader", "tagliatelle"],
      negative: ["færdigret", "dinner kit", "gryderet", "fisk", "rejer", "laks", "kalvekød", "pastasalat"]
    },
    hvedemel: {
      positive: ["hvedemel", "mel"],
      negative: ["rugmel", "majsmel", "mandelmel", "havremel", "melblanding", "bageblanding"]
    },
    honning: {
      positive: ["honning"],
      negative: ["honningmelon", "honningkage", "honningristet"]
    },
    olie: {
      positive: ["olie", "olivenolie", "rapsolie", "solsikkeolie", "madolie"],
      negative: ["motorolie", "kropsolie", "hårolie", "massageolie"]
    },
    "groft salt": {
      positive: ["salt", "groft salt", "havsalt"],
      negative: ["saltkaramel", "saltede", "saltstænger"]
    },
    ribsgele: {
      positive: ["ribsgele", "ribs gelé", "ribsgelé"],
      negative: []
    },
    laurbærblade: {
      positive: ["laurbær", "laurbærblade"],
      negative: []
    },
    cornflakes: {
      positive: ["cornflakes", "corn flakes"],
      negative: ["bar", "morgenmadsbar"]
    },
    skraldeposer: {
      positive: ["skraldeposer", "affaldsposer", "affaldssække", "skraldesække"],
      negative: ["hundeposer", "madposer", "fryseposer"]
    },
    bagepapir: {
      positive: ["bagepapir"],
      negative: ["bageforme", "muffinsforme", "madpapir"]
    }
  };

  function normalizedText(value) {
    return String(value || "")
      .toLocaleLowerCase("da-DK")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function searchProfile(term) {
    return SEARCH_PROFILES[normalizedText(term)] || null;
  }

  function broadSearchReason(term) {
    const value = normalizedText(term);
    if (value === "madpakkemad") {
      return t(
        "“Madpakkemad” er for bredt til automatisk tilbudssøgning.",
        "“Lunchbox food” is too broad for automatic offer search."
      );
    }
    return "";
  }

  function relevanceScore(term, offer) {
    const profile = searchProfile(term);
    if (!profile) return 1;

    const heading = normalizedText(offer.heading);
    const description = normalizedText(offer.description);
    const all = `${heading} ${description}`;

    if (profile.negative.some((word) => all.includes(normalizedText(word)))) return -10;

    let score = 0;
    profile.positive.forEach((word) => {
      const token = normalizedText(word);
      if (heading.includes(token)) score += 5;
      else if (description.includes(token)) score += 2;
    });

    return score;
  }

  function relevantOffers(item, list) {
    if (!item || !Array.isArray(list)) return [];
    const term = normalizeTerm(item.summary);
    if (broadSearchReason(term)) return [];

    return list
      .map((offer) => ({
        offer,
        score: relevanceScore(term, offer),
        unit: unitPrice(offer)
      }))
      // Negative score = known wrong product.
      // Score 0 = uncertain, but the eTilbudsavis search itself matched it,
      // so keep it as a possible match instead of throwing it away.
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;

        const au = a.unit?.value;
        const bu = b.unit?.value;
        if (Number.isFinite(au) && Number.isFinite(bu)) return au - bu;
        if (Number.isFinite(au)) return -1;
        if (Number.isFinite(bu)) return 1;

        return Number(a.offer.pricing?.price || Infinity) -
               Number(b.offer.pricing?.price || Infinity);
      })
      .map((entry) => entry.offer);
  }

  function offerMarkup(offer) {
    const pricing = offer.pricing || {};
    const store = offer.branding?.name || t("Ukendt butik", "Unknown store");
    const from = dateLabel(offer.run_from);
    const till = dateLabel(offer.run_till);
    const period = from && till ? `${from} – ${till}` : "";
    const unit = unitPrice(offer);
    const unitText = unit ? `${money(unit.value)}/${unit.unit}` : "";
    return `
      <article class="beast-shopping-offer">
        <div class="beast-shopping-offer-main">
          <small>${escapeHtml(store)}</small>
          <strong>${escapeHtml(offer.heading || "")}</strong>
          <span>${escapeHtml(offer.description || "")}</span>
          ${period ? `<em>${escapeHtml(period)}</em>` : ""}
          ${unitText ? `<em>${escapeHtml(unitText)}</em>` : ""}
        </div>
        <div class="beast-shopping-offer-price">${money(pricing.price)}</div>
      </article>
    `;
  }

  function render() {
    if (!containerEl) return;
    const selected = items.find((item) => item.uid === selectedUid);
    const rawResult = selected ? offers.get(selected.uid) : null;
    const result = selected && rawResult ? relevantOffers(selected, rawResult) : rawResult;
    const broadReason = selected ? broadSearchReason(normalizeTerm(selected.summary)) : "";
    const monitoredProduct = monitoredProductFor(selected);

    containerEl.innerHTML = `
      <div class="beast-shopping-page">
        <header class="beast-shopping-header">
          <div>
            <small>Google Keep · eTilbudsavis</small>
            <h1>${t("Indkøb", "Shopping")}</h1>
            <p>${t("Din indkøbsliste med aktuelle tilbud fra butikker i nærheden.", "Your shopping list with nearby store offers.")}</p>
          </div>
          <button type="button" class="beast-btn" data-shopping-refresh ${loading ? "disabled" : ""}>
            ${BeastCore.icon("refresh", { size: 18 })}
            ${loading ? t("Henter…", "Loading…") : t("Opdater", "Refresh")}
          </button>
        </header>
        ${error ? `<div class="beast-shopping-error">${escapeHtml(error)}</div>` : ""}
        ${refreshWarning ? `<div class="beast-shopping-warning">${escapeHtml(refreshWarning)}</div>` : ""}
        <div class="beast-shopping-layout">
          <section class="beast-shopping-list">
            <div class="beast-shopping-section-head">
              <h2>${t("Indkøbsliste", "Shopping list")}</h2>
              <span>${items.length}</span>
            </div>
            ${items.length ? items.map((item) => `
              <button type="button" class="beast-shopping-item ${item.uid === selectedUid ? "is-selected" : ""}" data-shopping-uid="${escapeHtml(item.uid)}">
                <span class="beast-shopping-item-icon">${BeastCore.icon("cart", { size: 18 })}</span>
                <span class="beast-shopping-item-name">${escapeHtml(item.summary)}</span>
                <span class="beast-shopping-item-count">${
                  searchErrors.has(item.uid)
                    ? "!"
                    : offers.has(item.uid)
                      ? relevantOffers(item, offers.get(item.uid)).length
                      : "–"
                }</span>
              </button>
            `).join("") : `<p class="beast-shopping-empty">${loading ? t("Henter indkøbslisten…", "Loading shopping list…") : t("Indkøbslisten er tom.", "The shopping list is empty.")}</p>`}
          </section>
          <section class="beast-shopping-results">
            <div class="beast-shopping-section-head">
              <div>
                <small>${t("Tilbud", "Offers")}</small>
                <h2>${selected ? escapeHtml(selected.summary) : t("Vælg en vare", "Select an item")}</h2>
              </div>
              ${selected ? `
                <button
                  type="button"
                  class="beast-btn"
                  data-shopping-monitor
                  ${monitorBusy ? "disabled" : ""}
                >
                  ${monitoredProduct
                    ? t("✓ Pris overvåges", "✓ Price monitored")
                    : t("Overvåg pris", "Monitor price")}
                </button>
              ` : result ? `<span>${result.length} ${t("relevante", "relevant")}${rawResult ? ` · ${rawResult.length} ${t("hentet", "fetched")}` : ""}${searchLimits.get(selectedUid) ? " · " + t("maks. 20", "max. 20") : ""}</span>` : ""}
            </div>
            ${monitorError ? `<div class="beast-shopping-error">${escapeHtml(monitorError)}</div>` : ""}
            ${selected && searchErrors.has(selectedUid) ? `<div class="beast-shopping-error">${escapeHtml(searchErrors.get(selectedUid))}</div>` : ""}
            ${broadReason ? `<div class="beast-shopping-warning">${escapeHtml(broadReason)}</div>` : ""}
            ${selected
              ? broadReason
                ? `<p class="beast-shopping-empty">${t("Brug et mere konkret varenavn i Keep, hvis du vil søge efter tilbud på denne vare.", "Use a more specific item name in Keep to search for offers.")}</p>`
                : result
                ? result.length
                  ? `<div class="beast-shopping-offers">${result.map(offerMarkup).join("")}</div>`
                  : `<p class="beast-shopping-empty">${t("Ingen aktuelle tilbud fundet i de hentede resultater.", "No current offers found in the fetched results.")}</p>`
                : `<p class="beast-shopping-empty">${loading ? t("Søger efter tilbud…", "Searching for offers…") : t("Ingen resultater endnu.", "No results yet.")}</p>`
              : `<p class="beast-shopping-empty">${t("Vælg en vare fra indkøbslisten.", "Select an item from the shopping list.")}</p>`}
          </section>
        </div>
        <footer class="beast-shopping-footer">
          ${t("Tilbud er rå søgeresultater og er endnu ikke relevansfiltreret. Indkøbslisten ændres ikke.", "Offers are raw search results and are not yet relevance-filtered. The shopping list is not modified.")}
        </footer>
      </div>
    `;

    containerEl.querySelector("[data-shopping-refresh]")?.addEventListener("click", () => refresh(true));

    containerEl.querySelector("[data-shopping-monitor]")?.addEventListener("click", () => {
      const item = items.find((entry) => entry.uid === selectedUid);
      const product = monitoredProductFor(item);
      if (product) removePriceMonitor(product);
      else addPriceMonitor(item);
    });

    containerEl.querySelectorAll("[data-shopping-uid]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedUid = button.dataset.shoppingUid;
        render();
      });
    });
  }

  async function refresh(force = false) {
    if (loading) return;
    if (!force && Date.now() - lastRefresh < 60 * 1000) return;
    const currentRequest = ++requestId;
    loading = true;
    error = "";
    refreshWarning = "";
    render();

    try {
      const [nextItems, nextMonitoredProducts] = await Promise.all([
        getItems(),
        getMonitoredProducts()
      ]);
      if (currentRequest !== requestId) return;
      items = nextItems;
      monitoredProducts = nextMonitoredProducts;
      if (!items.some((item) => item.uid === selectedUid)) selectedUid = items[0]?.uid || null;
      const activeUids = new Set(items.map((item) => item.uid));
      offers = new Map([...offers].filter(([uid]) => activeUids.has(uid)));
      searchErrors = new Map();
      searchLimits = new Map();
      render();

      const terms = [...new Set(items.map((item) => normalizeTerm(item.summary)).filter(Boolean))];
      const results = new Map();
      for (let index = 0; index < terms.length; index += 3) {
        const batch = terms.slice(index, index + 3);
        const settled = await Promise.allSettled(batch.map(async (term) => [term, await searchOffers(term, force)]));
        settled.forEach((entry, offset) => {
          const term = batch[offset];
          if (entry.status === "fulfilled") {
            results.set(term, entry.value[1]);
          } else {
            const message = entry.reason?.message || String(entry.reason);
            items.filter((item) => normalizeTerm(item.summary) === term).forEach((item) => {
              searchErrors.set(item.uid, `${t("Søgning fejlede", "Search failed")}: ${message}`);
            });
          }
        });
        if (currentRequest !== requestId) return;
        items.forEach((item) => {
          const term = normalizeTerm(item.summary);
          if (results.has(term)) {
            const result = results.get(term);
            offers.set(item.uid, result.data);
            searchLimits.set(item.uid, result.limited);
            searchErrors.delete(item.uid);
          }
        });
        render();
      }
      lastRefresh = Date.now();
      if (searchErrors.size) refreshWarning = `${searchErrors.size} ${t("varer kunne ikke opdateres. Tidligere resultater er bevaret.", "items could not be updated. Previous results have been preserved.")}`;
    } catch (err) {
      error = err.message || String(err);
      refreshWarning = t("Tidligere resultater er bevaret, hvis de findes.", "Previous results are preserved where available.");
    } finally {
      if (currentRequest === requestId) {
        loading = false;
        render();
      }
    }
  }

  function init(root) {
    containerEl = root;
    containerEl.classList.add("beast-shopping-panel");
    render();
    BeastHaSocket.onStatusChange((status) => {
      if (status === "connected") refresh();
    });
    refresh();
  }

  BeastCore.registerPanel("shopping", "beastShoppingZone", init);
  return { render, refresh };
})();
