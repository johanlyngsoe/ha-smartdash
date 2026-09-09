(() => {
  const API = "./api/price-monitor.php";
  const MODAL_ID = "beastPriceMonitorModal";
  const EDITOR_ID = "beastPriceRuleEditor";

  let saving = false;

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  const english = () => String(document.documentElement.lang || "").toLowerCase().startsWith("en");
  const t = (da, en) => english() ? en : da;

  const pencilIcon = () => `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 20h4.2L19 9.2a2.1 2.1 0 0 0 0-3L17.8 5a2.1 2.1 0 0 0-3 0L4 15.8V20Zm2-3.4L16.2 6.4a.2.2 0 0 1 .3 0l1.2 1.2a.2.2 0 0 1 0 .3L7.4 18H6v-1.4Z" fill="currentColor"/>
    </svg>`;

  const trashIcon = () => `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-.7 10.1A2 2 0 0 1 14.3 21H9.7a2 2 0 0 1-2-1.9L7 9Zm3 2v7h2v-7h-2Zm4 0v7h2v-7h-2Z" fill="currentColor"/>
    </svg>`;

  function termsToText(value) {
    return Array.isArray(value) ? value.join("\n") : "";
  }

  function textToTerms(value) {
    const seen = new Set();
    return String(value || "")
      .split(/[\n,]+/)
      .map((entry) => entry.replace(/\s+/g, " ").trim())
      .filter((entry) => {
        if (!entry) return false;
        const key = entry.toLocaleLowerCase("da-DK");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  async function getProducts() {
    const response = await fetch(API, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.products)) throw new Error(t("Uventet API-svar", "Unexpected API response"));
    return payload.products;
  }

  function closeEditor() {
    document.getElementById(EDITOR_ID)?.remove();
  }

  async function saveRules(product, form, statusEl) {
    if (saving) return;
    saving = true;

    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    if (statusEl) {
      statusEl.textContent = t("Gemmer…", "Saving…");
      statusEl.className = "beast-price-rule-status";
    }

    const searchTerm = form.querySelector('[name="search_term"]')?.value.trim() || product.name;
    const statisticsFromDate = form.querySelector('[name="statistics_from_date"]')?.value || "";
    const includeAny = textToTerms(form.querySelector('[name="include_any"]')?.value);
    const includeAll = textToTerms(form.querySelector('[name="include_all"]')?.value);
    const excludeAny = textToTerms(form.querySelector('[name="exclude_any"]')?.value);

    try {
      const response = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: product.name,
          search_term: searchTerm,
          statistics_from_date: statisticsFromDate,
          include_any: includeAny,
          include_all: includeAll,
          exclude_any: excludeAny
        })
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      }

      if (statusEl) {
        statusEl.textContent = t("Gemt", "Saved");
        statusEl.className = "beast-price-rule-status is-success";
      }

      window.setTimeout(closeEditor, 450);
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = error.message || String(error);
        statusEl.className = "beast-price-rule-status is-error";
      }
      if (submit) submit.disabled = false;
    } finally {
      saving = false;
    }
  }

  function openEditor(product) {
    closeEditor();

    const overlay = document.createElement("div");
    overlay.id = EDITOR_ID;
    overlay.className = "beast-modal-overlay beast-price-rule-overlay";

    overlay.innerHTML = `
      <div class="beast-modal beast-price-rule-modal" role="dialog" aria-modal="true" aria-labelledby="beastPriceRuleTitle">
        <div class="beast-modal-header">
          <div>
            <small>${t("Prisovervågning · matchregler", "Price monitoring · matching rules")}</small>
            <h3 id="beastPriceRuleTitle">${escapeHtml(product.name)}</h3>
            <p>${t(
              "Reglerne bruges af den daglige prisindsamling til at afgøre, hvilke tilbud der er sikkert sammenlignelige.",
              "The daily price collector uses these rules to decide which offers are safely comparable."
            )}</p>
          </div>
          <button type="button" class="beast-modal-close" data-rule-close aria-label="${t("Luk", "Close")}">×</button>
        </div>
        <div class="beast-modal-body">
          <form class="beast-price-rule-form" data-rule-form>
            <label class="beast-price-rule-field">
              <span>${t("Søg efter", "Search for")}</span>
              <small>${t("Det brede søgeord, som sendes til eTilbudsavis.", "The broad search term sent to eTilbudsavis.")}</small>
              <input name="search_term" type="text" value="${escapeHtml(product.search_term || product.name)}" autocomplete="off">
            </label>

            <label class="beast-price-rule-field">
              <span>${t("Statistik fra", "Statistics from")}</span>
              <small>${t(
                "Observationer før denne dato gemmes stadig, men indgår ikke i statistikken. Ved ændring af søgeord sættes datoen automatisk til i dag.",
                "Observations before this date are retained but excluded from statistics. Changing the search term automatically resets this date to today."
              )}</small>
              <input name="statistics_from_date" type="date" value="${escapeHtml(product.statistics_from_date || "")}">
            </label>

            <div class="beast-price-rule-grid">
              <label class="beast-price-rule-field">
                <span>${t("Accepter mindst ét", "Accept at least one")}</span>
                <small>${t("Et af ordene er nok til et sikkert match.", "Any one term is enough for a certain match.")}</small>
                <textarea name="include_any" rows="6" placeholder="${t("Fx Danbo\nKlovborg\nRiberhus", "E.g. Danbo\nKlovborg\nRiberhus")}">${escapeHtml(termsToText(product.include_any))}</textarea>
              </label>

              <label class="beast-price-rule-field">
                <span>${t("Skal indeholde alle", "Must contain all")}</span>
                <small>${t("Alle angivne ord skal findes i tilbuddet.", "Every listed term must occur in the offer.")}</small>
                <textarea name="include_all" rows="6" placeholder="${t("Fx hakket\noksekød", "E.g. minced\nbeef")}">${escapeHtml(termsToText(product.include_all))}</textarea>
              </label>

              <label class="beast-price-rule-field">
                <span>${t("Udeluk", "Exclude")}</span>
                <small>${t("Et enkelt match her afviser tilbuddet.", "Any matching term here rejects the offer.")}</small>
                <textarea name="exclude_any" rows="6" placeholder="${t("Fx kommen\nekstra lagret", "E.g. caraway\nextra mature")}">${escapeHtml(termsToText(product.exclude_any))}</textarea>
              </label>
            </div>

            <p class="beast-price-rule-help">${t(
              "Skriv ét udtryk pr. linje eller adskil med komma. Udeluk-regler har altid første prioritet.",
              "Enter one expression per line or separate with commas. Exclusion rules always take priority."
            )}</p>

            <div class="beast-price-rule-actions">
              <span class="beast-price-rule-status" data-rule-status></span>
              <button type="button" class="beast-btn" data-rule-cancel>${t("Annuller", "Cancel")}</button>
              <button type="submit" class="beast-btn beast-btn-primary">${t("Gem regler", "Save rules")}</button>
            </div>
          </form>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector("[data-rule-close]")?.addEventListener("click", closeEditor);
    overlay.querySelector("[data-rule-cancel]")?.addEventListener("click", closeEditor);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeEditor();
    });

    const form = overlay.querySelector("[data-rule-form]");
    const statusEl = overlay.querySelector("[data-rule-status]");
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveRules(product, form, statusEl);
    });
  }

  async function editProduct(id) {
    try {
      const products = await getProducts();
      const product = products.find((entry) => Number(entry.id) === Number(id));
      if (!product) throw new Error(t("Produktet blev ikke fundet", "Product not found"));
      openEditor(product);
    } catch (error) {
      window.alert(`${t("Kunne ikke åbne matchregler", "Could not open matching rules")}: ${error.message || error}`);
    }
  }

  function enhancePriceModal(modal) {
    if (!modal || modal.dataset.priceRulesEnhanced === "1") return;
    modal.dataset.priceRulesEnhanced = "1";

    modal.querySelectorAll("[data-monitor-stop]").forEach((removeButton) => {
      const id = Number(removeButton.dataset.monitorStop);
      if (!id || removeButton.parentElement?.querySelector(`[data-monitor-edit="${id}"]`)) return;

      const actionCell = removeButton.parentElement;
      actionCell?.classList.add("beast-price-monitor-actions");

      removeButton.classList.add("beast-price-monitor-icon-action", "is-remove");
      removeButton.innerHTML = trashIcon();
      removeButton.title = t("Fjern overvågning", "Remove monitor");
      removeButton.setAttribute("aria-label", t("Fjern overvågning", "Remove monitor"));

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "beast-btn beast-price-monitor-edit beast-price-monitor-icon-action";
      editButton.dataset.monitorEdit = String(id);
      editButton.innerHTML = pencilIcon();
      editButton.title = t("Rediger matchregler", "Edit matching rules");
      editButton.setAttribute("aria-label", t("Rediger matchregler", "Edit matching rules"));
      editButton.addEventListener("click", () => editProduct(id));

      removeButton.before(editButton);
    });
  }

  function scan() {
    enhancePriceModal(document.getElementById(MODAL_ID));
  }

  const observer = new MutationObserver(scan);

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      observer.observe(document.body, { childList: true, subtree: true });
      scan();
    }, { once: true });
  }
})();
