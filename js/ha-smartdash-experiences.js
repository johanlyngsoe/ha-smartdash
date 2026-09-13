window.BeastExperiences = (() => {
  let items = [];
  let sortMode = "best";
  let sectionEl = null;
  let gridEl = null;
  let metaEl = null;

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  const asNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

  function score(item) {
    return asNumber(item?.family_fit?.score ?? item?.score) ?? 0;
  }

  function valueScore(item) {
    return asNumber(item?.value?.score) ?? -1;
  }

  function travelMinutes(item) {
    return asNumber(item?.travel_minutes ?? item?.family_fit?.travel_minutes ?? item?.distance?.travel_minutes) ?? 9999;
  }

  function formatDate(value) {
    if (!value) return "Dato ikke angivet";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString("da-DK", { weekday: "short", day: "numeric", month: "short" });
  }

  function formatPrice(item) {
    const effective = asNumber(item?.value?.effective_family_price);
    const normal = asNumber(item?.value?.normal_family_price ?? item?.price_family);
    if (effective !== null && normal !== null && effective < normal) {
      return `${Math.round(effective)} kr. · før ${Math.round(normal)} kr.`;
    }
    if (effective !== null) return `${Math.round(effective)} kr. familie`;
    if (normal !== null) return `${Math.round(normal)} kr. familie`;
    return item?.price_note || "Pris ukendt";
  }

  function benefits(item) {
    return Array.isArray(item?.benefits) ? item.benefits : [];
  }

  function badgeHtml(item) {
    return benefits(item).map((benefit) => {
      const isLogbuy = benefit?.program === "Visma LogBuy";
      const label = isLogbuy
        ? "🎟 LogBuy-fordel"
        : benefit?.discount_pct != null
          ? `${escapeHtml(benefit.program || benefit.venue || "Fordel")} · ${escapeHtml(benefit.discount_pct)}%`
          : escapeHtml(benefit.program || benefit.venue || "Fordel");
      return `<span class="beast-experience-badge" data-program="${isLogbuy ? "logbuy" : "benefit"}">${label}</span>`;
    }).join("");
  }

  function sortedItems() {
    const copy = [...items];
    if (sortMode === "value") {
      copy.sort((a, b) => valueScore(b) - valueScore(a) || score(b) - score(a));
    } else if (sortMode === "near") {
      copy.sort((a, b) => travelMinutes(a) - travelMinutes(b) || score(b) - score(a));
    } else {
      copy.sort((a, b) => score(b) - score(a) || valueScore(b) - valueScore(a));
    }
    return copy;
  }

  function cardHtml(item, index) {
    const travel = travelMinutes(item);
    const place = [item.venue, item.city].filter(Boolean).join(" · ") || "Sted ikke angivet";
    const clusterCount = Array.isArray(item.cluster_items) ? item.cluster_items.length : asNumber(item.cluster_count);
    return `
      <button type="button" class="beast-experience-card" data-experience-index="${index}">
        <div class="beast-experience-card-top">
          <h2>${escapeHtml(item.title)}</h2>
          <div class="beast-experience-score">${Math.round(score(item))}<small>/100</small></div>
        </div>
        <div class="beast-experience-place">${escapeHtml(place)}</div>
        <div class="beast-experience-facts">
          <span class="beast-experience-fact">${escapeHtml(formatDate(item.start))}</span>
          ${travel < 9999 ? `<span class="beast-experience-fact">🚗 ${Math.round(travel)} min.</span>` : ""}
          <span class="beast-experience-fact">${escapeHtml(formatPrice(item))}</span>
          ${clusterCount > 1 ? `<span class="beast-experience-fact">${clusterCount} aktiviteter</span>` : ""}
        </div>
        <div class="beast-experience-benefits">${badgeHtml(item)}</div>
      </button>`;
  }

  function render() {
    if (!gridEl) return;
    const ordered = sortedItems();
    metaEl.textContent = `${ordered.length} forslag · Experience Score er uafhængig af rabatter`;
    if (!ordered.length) {
      gridEl.innerHTML = '<div class="beast-experiences-empty">Ingen oplevelser i den seneste samling endnu.</div>';
      return;
    }
    gridEl.innerHTML = ordered.map(cardHtml).join("");
    gridEl.querySelectorAll("[data-experience-index]").forEach((card, index) => {
      card.addEventListener("click", () => openModal(ordered[index]));
    });
  }

  function openModal(item) {
    document.getElementById("beastExperienceModal")?.remove();
    const logbuy = benefits(item).find((benefit) => benefit?.program === "Visma LogBuy");
    const reason = item?.family_fit?.explanation || item?.family_fit?.reason || item?.rationale || item?.description || "";
    const place = [item.venue, item.city].filter(Boolean).join(" · ");
    const modal = document.createElement("div");
    modal.id = "beastExperienceModal";
    modal.className = "beast-experience-modal";
    modal.innerHTML = `
      <article class="beast-experience-modal-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(item.title)}">
        <div class="beast-experience-modal-head">
          <div><h2>${escapeHtml(item.title)}</h2><div class="beast-experience-place">${escapeHtml(place)}</div></div>
          <button type="button" class="beast-experience-close" aria-label="Luk">×</button>
        </div>
        <div class="beast-experience-modal-body">
          <div class="beast-experience-facts">
            <span class="beast-experience-fact">⭐ ${Math.round(score(item))}/100</span>
            <span class="beast-experience-fact">${escapeHtml(formatDate(item.start))}</span>
            ${travelMinutes(item) < 9999 ? `<span class="beast-experience-fact">🚗 ${Math.round(travelMinutes(item))} min.</span>` : ""}
            <span class="beast-experience-fact">${escapeHtml(formatPrice(item))}</span>
          </div>
          <div class="beast-experience-benefits">${badgeHtml(item)}</div>
          ${reason ? `<div class="beast-experience-reason">${escapeHtml(reason)}</div>` : ""}
          ${logbuy ? '<div class="beast-experience-reason"><strong>LogBuy:</strong> Aktiv aftale fundet. Rabatens størrelse og vilkår er endnu ikke hentet automatisk, så tjek LogBuy før booking.</div>' : ""}
          <div class="beast-experience-actions">
            ${item.source_url ? `<a class="beast-experience-action primary" href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">Åbn officiel side</a>` : ""}
            ${logbuy?.detailurl ? `<a class="beast-experience-action" href="${escapeHtml(logbuy.detailurl)}" target="_blank" rel="noopener noreferrer">Se LogBuy-fordel</a>` : ""}
          </div>
        </div>
      </article>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector(".beast-experience-close")?.addEventListener("click", close);
    modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
  }

  async function load() {
    try {
      const response = await fetch("./api/experiences.php", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`);
      items = Array.isArray(payload.results) ? payload.results : [];
      render();
    } catch (error) {
      if (metaEl) metaEl.textContent = "Oplevelsesdata kunne ikke indlæses";
      if (gridEl) gridEl.innerHTML = `<div class="beast-experiences-empty">${escapeHtml(error.message)}</div>`;
      window.BeastCore?.log?.(`Oplevelser: ${error.message}`);
    }
  }

  function activateExperiences(button) {
    document.querySelectorAll("#beastRail [data-section]").forEach((candidate) => {
      candidate.classList.toggle("is-active", candidate === button);
    });
    document.querySelectorAll("#beastContent .beast-section[data-section]").forEach((candidate) => {
      candidate.classList.toggle("is-active", candidate === sectionEl);
    });
    document.dispatchEvent(new CustomEvent("beast:sectionchange", { detail: { section: "experiences" } }));
  }

  function mount() {
    if (document.querySelector('.beast-section[data-section="experiences"]')) return;
    const railPages = document.querySelector("#beastRail .beast-rail-pages");
    const content = document.getElementById("beastContent");
    if (!railPages || !content) {
      window.setTimeout(mount, 120);
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "beast-rail-btn";
    button.dataset.section = "experiences";
    button.innerHTML = `${window.BeastCore?.icon?.("star", { size: 24 }) || "★"}<span>Oplevelser</span>`;
    const shopping = railPages.querySelector('[data-section="shopping"]');
    railPages.insertBefore(button, shopping || null);

    sectionEl = document.createElement("div");
    sectionEl.className = "beast-section";
    sectionEl.dataset.section = "experiences";
    sectionEl.innerHTML = `
      <div class="beast-experiences">
        <div class="beast-experiences-head">
          <div><h1>Oplevelser</h1><p>De bedste familieoplevelser først – rabatter kommer bagefter.</p></div>
          <div class="beast-experiences-tabs" role="tablist">
            <button type="button" class="beast-experiences-tab is-active" data-sort="best">⭐ Bedste</button>
            <button type="button" class="beast-experiences-tab" data-sort="value">🎟 Bedste værdi</button>
            <button type="button" class="beast-experiences-tab" data-sort="near">📍 Tæt på</button>
          </div>
        </div>
        <div class="beast-experiences-meta"></div>
        <div class="beast-experiences-grid"></div>
      </div>`;
    content.appendChild(sectionEl);
    gridEl = sectionEl.querySelector(".beast-experiences-grid");
    metaEl = sectionEl.querySelector(".beast-experiences-meta");

    button.addEventListener("click", () => activateExperiences(button));
    document.addEventListener("beast:sectionchange", (event) => {
      const isActive = event.detail?.section === "experiences";
      button.classList.toggle("is-active", isActive);
      sectionEl?.classList.toggle("is-active", isActive);
    });

    sectionEl.querySelectorAll("[data-sort]").forEach((tab) => tab.addEventListener("click", () => {
      sortMode = tab.dataset.sort;
      sectionEl.querySelectorAll("[data-sort]").forEach((candidate) => candidate.classList.toggle("is-active", candidate === tab));
      render();
    }));

    load();
  }

  document.addEventListener("DOMContentLoaded", mount, { once: true });
  return { mount, reload: load };
})();
