(() => {
  const PRICE_MONITOR_API = "./api/price-monitor.php";
  const OFFER_API_FRAGMENT = "/api/etilbudsavis/search";
  const originalFetch = window.fetch.bind(window);
  let productsPromise = null;

  function normalizedText(value) {
    return String(value || "")
      .toLocaleLowerCase("da-DK")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeName(value) {
    return String(value || "")
      .replace(/\btilbud\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function ruleTerms(value) {
    return Array.isArray(value)
      ? value.map(normalizedText).filter(Boolean)
      : [];
  }

  async function monitoredProducts() {
    if (!productsPromise) {
      productsPromise = originalFetch(PRICE_MONITOR_API, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Prisovervågning: HTTP ${response.status}`);
          const payload = await response.json();
          return Array.isArray(payload?.products) ? payload.products : [];
        })
        .catch((error) => {
          productsPromise = null;
          throw error;
        });
    }
    return productsPromise;
  }

  function productForQuery(products, query) {
    const key = normalizedText(normalizeName(query));
    return products.find((product) => normalizedText(normalizeName(product.name)) === key) || null;
  }

  function classify(product, offer) {
    const heading = normalizedText(offer?.heading);
    const description = normalizedText(offer?.description);
    const text = `${heading} ${description}`.trim();
    const includeAny = ruleTerms(product?.include_any);
    const includeAll = ruleTerms(product?.include_all);
    const excludeAny = ruleTerms(product?.exclude_any);

    if (excludeAny.some((term) => text.includes(term))) return "rejected";

    const hasPositiveRules = includeAny.length > 0 || includeAll.length > 0;
    if (!hasPositiveRules) return "possible";

    if (includeAll.length && !includeAll.every((term) => text.includes(term))) return "possible";
    if (includeAny.length && !includeAny.some((term) => text.includes(term))) return "possible";
    return "certain";
  }

  function comparableUnitPrice(offer) {
    const price = Number(offer?.pricing?.price);
    const sizeFrom = Number(offer?.quantity?.size?.from);
    const sizeTo = Number(offer?.quantity?.size?.to);
    const piecesFrom = Number(offer?.quantity?.pieces?.from ?? 1);
    const piecesTo = Number(offer?.quantity?.pieces?.to ?? piecesFrom);
    const symbol = String(offer?.quantity?.unit?.symbol || "").toLocaleLowerCase("da-DK");

    if (![price, sizeFrom, sizeTo, piecesFrom, piecesTo].every(Number.isFinite)) return null;
    if (price <= 0 || sizeFrom <= 0 || piecesFrom <= 0) return null;
    if (sizeFrom !== sizeTo || piecesFrom !== piecesTo) return null;

    const factors = {
      g: 0.001,
      kg: 1,
      hg: 0.1,
      ml: 0.001,
      cl: 0.01,
      dl: 0.1,
      l: 1
    };

    const factor = factors[symbol];
    if (!factor) return null;

    const normalizedQuantity = sizeFrom * piecesFrom * factor;
    if (normalizedQuantity <= 0) return null;

    return price / normalizedQuantity;
  }

  function filteredResponse(response, product) {
    return response.clone().json().then((payload) => {
      if (!Array.isArray(payload)) return response;

      const certain = payload
        .map((offer, index) => ({
          offer,
          index,
          unitPrice: comparableUnitPrice(offer)
        }))
        .filter((entry) => classify(product, entry.offer) === "certain")
        .sort((a, b) => {
          const aHasUnitPrice = Number.isFinite(a.unitPrice);
          const bHasUnitPrice = Number.isFinite(b.unitPrice);

          if (aHasUnitPrice && bHasUnitPrice) {
            return (a.unitPrice - b.unitPrice) || (a.index - b.index);
          }
          if (aHasUnitPrice) return -1;
          if (bHasUnitPrice) return 1;
          return a.index - b.index;
        })
        .map((entry) => entry.offer);

      return new Response(JSON.stringify(certain), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }).catch(() => response);
  }

  window.fetch = async (input, init) => {
    const rawUrl = typeof input === "string" ? input : input?.url;

    if (rawUrl && rawUrl.includes("/api/price-monitor.php")) {
      const method = String(init?.method || (typeof input !== "string" ? input?.method : "GET") || "GET").toUpperCase();
      const response = await originalFetch(input, init);
      if (method !== "GET" && response.ok) productsPromise = null;
      return response;
    }

    if (!rawUrl || !rawUrl.includes(OFFER_API_FRAGMENT)) {
      return originalFetch(input, init);
    }

    let url;
    try {
      url = new URL(rawUrl, window.location.href);
    } catch (_) {
      return originalFetch(input, init);
    }

    const shoppingQuery = url.searchParams.get("query") || "";
    if (!shoppingQuery) return originalFetch(input, init);

    let product;
    try {
      product = productForQuery(await monitoredProducts(), shoppingQuery);
    } catch (_) {
      return originalFetch(input, init);
    }

    if (!product) return originalFetch(input, init);

    const searchTerm = normalizeName(product.search_term) || shoppingQuery;
    url.searchParams.set("query", searchTerm);

    const requestInput = typeof input === "string"
      ? url.toString()
      : new Request(url.toString(), input);
    const response = await originalFetch(requestInput, init);
    if (!response.ok) return response;
    return filteredResponse(response, product);
  };
})();
