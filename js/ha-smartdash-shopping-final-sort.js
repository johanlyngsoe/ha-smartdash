(() => {
  let scheduled = false;
  let sorting = false;

  function parseNumber(value) {
    const normalized = String(value || "")
      .replace(/\s/g, "")
      .replace(/\./g, "")
      .replace(",", ".");
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  }

  function parsePrice(value) {
    const match = String(value || "").match(/[\d.,]+/);
    return match ? parseNumber(match[0]) : null;
  }

  function formatNumber(value) {
    return Number(value).toLocaleString("da-DK", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function displayedUnitPrice(card) {
    if (!card) return null;

    const unitLine = [...card.querySelectorAll("em")]
      .map((element) => element.textContent || "")
      .find((text) => /kr\.\s*\/(?:kg|liter)\b/i.test(text));

    if (!unitLine) return null;

    const match = unitLine.match(/([\d.,]+)(?:\s*[–-]\s*([\d.,]+))?\s*kr\.\s*\/(kg|liter)\b/i);
    if (!match) return null;

    const first = parseNumber(match[1]);
    const second = match[2] ? parseNumber(match[2]) : null;
    const conservative = Number.isFinite(second) ? Math.max(first, second) : first;
    if (!Number.isFinite(conservative)) return null;

    return {
      value: conservative,
      unit: match[3].toLocaleLowerCase("da-DK")
    };
  }

  function rangeUnitPrice(card) {
    if (!card || displayedUnitPrice(card)) return null;

    const description = card.querySelector(".beast-shopping-offer-main span")?.textContent || "";
    const price = parsePrice(card.querySelector(".beast-shopping-offer-price")?.textContent || "");
    if (!Number.isFinite(price) || price <= 0) return null;

    const match = description.match(/([\d.,]+)\s*[–-]\s*([\d.,]+)\s*(kg|g|hg|l|dl|cl|ml)\b/i);
    if (!match) return null;

    const from = parseNumber(match[1]);
    const to = parseNumber(match[2]);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return null;

    const factors = {
      g: ["kg", 0.001],
      kg: ["kg", 1],
      hg: ["kg", 0.1],
      ml: ["liter", 0.001],
      cl: ["liter", 0.01],
      dl: ["liter", 0.1],
      l: ["liter", 1]
    };
    const factor = factors[match[3].toLocaleLowerCase("da-DK")];
    if (!factor) return null;

    const lowQuantity = Math.min(from, to) * factor[1];
    const highQuantity = Math.max(from, to) * factor[1];
    if (lowQuantity <= 0 || highQuantity <= 0) return null;

    const bestCase = price / highQuantity;
    const conservative = price / lowQuantity;
    if (!Number.isFinite(bestCase) || !Number.isFinite(conservative)) return null;

    return {
      min: bestCase,
      max: conservative,
      value: conservative,
      unit: factor[0]
    };
  }

  function enhanceRangePrice(card) {
    if (!card || card.querySelector(".beast-shopping-derived-unit-range")) return;
    const range = rangeUnitPrice(card);
    if (!range) return;

    const main = card.querySelector(".beast-shopping-offer-main");
    if (!main) return;

    const line = document.createElement("em");
    line.className = "beast-shopping-derived-unit-range";
    line.textContent = `${formatNumber(range.min)}–${formatNumber(range.max)} kr./${range.unit}`;
    main.appendChild(line);
  }

  function sortContainer(container) {
    if (!container || sorting) return;

    const cards = [...container.querySelectorAll(":scope > .beast-shopping-offer")];
    if (cards.length < 1) return;

    cards.forEach(enhanceRangePrice);

    const ranked = cards.map((card, index) => ({
      card,
      index,
      unit: displayedUnitPrice(card)
    }));

    const sorted = [...ranked].sort((a, b) => {
      const aComparable = Number.isFinite(a.unit?.value);
      const bComparable = Number.isFinite(b.unit?.value);

      if (aComparable && bComparable) {
        if (a.unit.unit === b.unit.unit) {
          return (a.unit.value - b.unit.value) || (a.index - b.index);
        }
        return a.index - b.index;
      }

      if (aComparable) return -1;
      if (bComparable) return 1;
      return a.index - b.index;
    });

    const changed = sorted.some((entry, index) => entry.card !== cards[index]);
    if (!changed) return;

    sorting = true;
    sorted.forEach((entry) => container.appendChild(entry.card));
    sorting = false;
  }

  function sortVisibleOffers() {
    document.querySelectorAll(".beast-shopping-offers").forEach(sortContainer);
  }

  function scheduleSort() {
    if (scheduled || sorting) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      sortVisibleOffers();
    });
  }

  const observer = new MutationObserver((mutations) => {
    if (sorting) return;
    if (mutations.some((mutation) =>
      mutation.target?.closest?.(".beast-shopping-results") ||
      [...mutation.addedNodes].some((node) =>
        node.nodeType === Node.ELEMENT_NODE &&
        (node.matches?.(".beast-shopping-offers, .beast-shopping-offer") ||
         node.querySelector?.(".beast-shopping-offers, .beast-shopping-offer"))
      )
    )) {
      scheduleSort();
    }
  });

  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleSort();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
