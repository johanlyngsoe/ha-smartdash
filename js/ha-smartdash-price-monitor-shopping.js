(() => {
  const MODAL_ID = "beastPriceMonitorModal";
  const LATEST_STORE_API = "./api/price-monitor-current-store.php";
  const TODO_ENTITY = "todo.google_keep_indkobsliste";

  let latestStoresPromise = null;
  let currentItemsPromise = null;

  const english = () => String(document.documentElement.lang || "").toLowerCase().startsWith("en");
  const t = (da, en) => english() ? en : da;

  const normalize = (value) => String(value || "")
    .replace(/\btilbud\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("da-DK");

  const plusIcon = () => `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z" fill="currentColor"/>
    </svg>`;

  const checkIcon = () => `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m9.4 16.2-4.2-4.2 1.4-1.4 2.8 2.8 8-8 1.4 1.4-9.4 9.4Z" fill="currentColor"/>
    </svg>`;

  async function fetchLatestStores(force = false) {
    if (force || !latestStoresPromise) {
      latestStoresPromise = fetch(LATEST_STORE_API, { cache: "no-store" })
        .then(async (response) => {
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload?.message || `HTTP ${response.status}`);
          return payload?.stores && typeof payload.stores === "object" ? payload.stores : {};
        })
        .catch((error) => {
          latestStoresPromise = null;
          throw error;
        });
    }
    return latestStoresPromise;
  }

  async function fetchCurrentItems(force = false) {
    if (force || !currentItemsPromise) {
      currentItemsPromise = BeastAuth.haFetch("/api/services/todo/get_items?return_response=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_id: TODO_ENTITY, status: ["needs_action"] })
      }).then((response) => {
        const payload = response?.service_response || response;
        const items = payload?.[TODO_ENTITY]?.items;
        return Array.isArray(items) ? items : [];
      }).catch((error) => {
        currentItemsPromise = null;
        throw error;
      });
    }
    return currentItemsPromise;
  }

  async function addToShoppingList(name, button) {
    if (!name || !button || button.disabled) return;

    button.disabled = true;
    button.classList.add("is-busy");

    try {
      const items = await fetchCurrentItems(true);
      if (items.some((item) => normalize(item.summary) === normalize(name))) {
        markAdded(button);
        return;
      }

      await BeastAuth.haFetch("/api/services/todo/add_item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: TODO_ENTITY,
          item: name
        })
      });

      currentItemsPromise = null;
      markAdded(button);
      window.BeastShopping?.refresh?.(true);
    } catch (error) {
      button.disabled = false;
      button.classList.remove("is-busy");
      button.title = `${t("Kunne ikke tilføje til indkøbslisten", "Could not add to shopping list")}: ${error.message || error}`;
      window.alert(button.title);
    }
  }

  function markAdded(button) {
    button.disabled = true;
    button.classList.remove("is-busy");
    button.classList.add("is-added");
    button.innerHTML = checkIcon();
    button.title = t("Allerede på indkøbslisten", "Already on shopping list");
    button.setAttribute("aria-label", button.title);
  }

  function addShoppingButtons(modal) {
    modal.querySelectorAll("tbody tr").forEach((row) => {
      const removeButton = row.querySelector("[data-monitor-stop]");
      const productId = Number(removeButton?.dataset.monitorStop);
      const productName = row.querySelector(".beast-price-monitor-name strong")?.textContent?.trim() || "";
      const actionCell = removeButton?.parentElement;
      if (!productId || !productName || !actionCell || actionCell.querySelector(`[data-monitor-add-shopping="${productId}"]`)) return;

      actionCell.classList.add("beast-price-monitor-actions", "beast-price-monitor-actions-with-shopping");

      const button = document.createElement("button");
      button.type = "button";
      button.className = "beast-btn beast-price-monitor-icon-action beast-price-monitor-add-shopping";
      button.dataset.monitorAddShopping = String(productId);
      button.innerHTML = plusIcon();
      button.title = t("Tilføj til indkøbslisten", "Add to shopping list");
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", () => addToShoppingList(productName, button));

      actionCell.prepend(button);

      fetchCurrentItems().then((items) => {
        if (items.some((item) => normalize(item.summary) === normalize(productName))) {
          markAdded(button);
        }
      }).catch(() => {});
    });
  }

  async function decorateLatestStores(modal) {
    const stores = await fetchLatestStores().catch(() => ({}));

    modal.querySelectorAll("tbody tr").forEach((row) => {
      const productId = String(Number(row.querySelector("[data-monitor-stop]")?.dataset.monitorStop || 0));
      const latestCell = row.querySelector("td:nth-child(3)");
      if (!productId || productId === "0" || !latestCell || latestCell.querySelector(".beast-price-monitor-latest-store")) return;

      const store = stores[productId]?.store;
      if (!store) return;

      const storeEl = document.createElement("small");
      storeEl.className = "beast-price-monitor-latest-store";
      storeEl.textContent = store;
      latestCell.appendChild(storeEl);
    });
  }

  function enhance(modal) {
    if (!modal) return;
    addShoppingButtons(modal);
    decorateLatestStores(modal);
  }

  const observer = new MutationObserver(() => enhance(document.getElementById(MODAL_ID)));

  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    enhance(document.getElementById(MODAL_ID));
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
