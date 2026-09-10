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

  function displayedUnitPrice(card) {
    if (!card) return null;

    const unitLine = [...card.querySelectorAll("em")]
      .map((element) => element.textContent || "")
      .find((text) => /kr\.\s*\/(?:kg|liter)\b/i.test(text));

    if (!unitLine) return null;

    const match = unitLine.match(/([\d.,]+)\s*kr\.\s*\/(kg|liter)\b/i);
    if (!match) return null;

    const value = parseNumber(match[1]);
    if (!Number.isFinite(value)) return null;

    return {
      value,
      unit: match[2].toLocaleLowerCase("da-DK")
    };
  }

  function sortContainer(container) {
    if (!container || sorting) return;

    const cards = [...container.querySelectorAll(":scope > .beast-shopping-offer")];
    if (cards.length < 2) return;

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
