(function () {
  const IDS = {
    bladeRuntime: "sensor.robogub_knivbrugstid",
    bladeWarning: "sensor.robogub_knivslitage_advarselstid",
    firmware: "update.robogub_firmware",
    restart: "button.robogub_genstart_plaeneklipperen",
    syncMap: "button.robogub_synkroniser_kort",
    syncRtk: "button.robogub_synkroniser_rtk_og_ladestation",
    syncSchedule: "button.robogub_synkroniser_tidsplaner"
  };

  let queued = false;

  function state(id) { return BeastHaSocket.getState(id) || null; }
  function value(id, fallback = "–") {
    const result = state(id)?.state;
    return !result || ["unknown", "unavailable"].includes(result) ? fallback : result;
  }
  function esc(input) {
    return String(input ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
  }
  function call(domain, service, entityId, data = {}) {
    return BeastAuth.haFetch(`/api/services/${domain}/${service}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity_id: entityId, ...data })
    });
  }
  function available(id) {
    const entity = state(id);
    return !!entity && entity.state !== "unavailable";
  }

  function findBladeResetButton() {
    return Array.from(BeastHaSocket.getAllStates().values()).find((entity) => {
      if (!entity?.entity_id?.startsWith("button.")) return false;
      const text = `${entity.entity_id} ${entity.attributes?.friendly_name || ""}`.toLowerCase();
      return /(robogub|luba|mammotion)/.test(text) && /(kniv|blade)/.test(text) && /(nulstil|reset|clear)/.test(text);
    }) || null;
  }

  function formatHours(raw) {
    const n = Number(raw);
    return Number.isFinite(n) ? `${n.toFixed(n >= 10 ? 1 : 2)} t` : raw || "–";
  }

  function maintenanceButton(label, action, icon, options = {}) {
    const disabled = options.disabled ? " disabled" : "";
    const cls = options.primary ? " is-primary" : options.danger ? " is-danger" : "";
    const note = options.note ? `<small>${esc(options.note)}</small>` : "";
    return `<button type="button" class="beast-robogub-maint-action${cls}" data-maint-action="${esc(action)}"${disabled}>${BeastCore.icon(icon, { size: 18 })}<span><strong>${esc(label)}</strong>${note}</span></button>`;
  }

  function build() {
    const firmware = state(IDS.firmware);
    const installed = firmware?.attributes?.installed_version || "–";
    const latest = firmware?.attributes?.latest_version || installed;
    const updateAvailable = firmware?.state === "on" && installed !== latest;
    const bladeReset = findBladeResetButton();
    const runtime = formatHours(value(IDS.bladeRuntime));
    const warning = formatHours(value(IDS.bladeWarning));

    return `
      <section class="beast-robogub-maintenance beast-robogub-section">
        <div class="beast-robogub-section-head">
          <div><small>Vedligehold</small><strong>Service og system</strong></div>
        </div>
        <div class="beast-robogub-maint-grid">
          <div class="beast-robogub-maint-card">
            <small>Knive</small>
            <strong>${esc(runtime)}</strong>
            <span>Advarsel ved ${esc(warning)}</span>
            ${maintenanceButton("Nulstil knivtimer", "blade-reset", "refresh", { disabled: !bladeReset, note: bladeReset ? "Efter knivskift" : "Ikke eksponeret af integrationen" })}
          </div>
          <div class="beast-robogub-maint-card">
            <small>Firmware</small>
            <strong>${esc(installed)}</strong>
            <span>${updateAvailable ? `Ny version ${esc(latest)}` : "Opdateret"}</span>
            ${maintenanceButton(updateAvailable ? "Opdater software" : "Ingen opdatering", "firmware", "refresh", { disabled: !updateAvailable, primary: updateAvailable, note: updateAvailable ? `Installer ${latest}` : "Seneste version installeret" })}
          </div>
          <div class="beast-robogub-maint-card">
            <small>System</small>
            <strong>RoboGub</strong>
            <span>Servicehandlinger</span>
            ${maintenanceButton("Genstart plæneklipper", "restart", "power", { disabled: !available(IDS.restart), danger: true, note: "Brug kun ved fejl" })}
          </div>
          <div class="beast-robogub-maint-card">
            <small>Synkronisering</small>
            <strong>Kort og station</strong>
            <span>Opdater data fra Mammotion</span>
            <div class="beast-robogub-maint-sync">
              ${maintenanceButton("Kort", "sync-map", "refresh", { disabled: !available(IDS.syncMap) })}
              ${maintenanceButton("RTK + dock", "sync-rtk", "refresh", { disabled: !available(IDS.syncRtk) })}
              ${maintenanceButton("Tidsplan", "sync-schedule", "refresh", { disabled: !available(IDS.syncSchedule) })}
            </div>
          </div>
        </div>
      </section>`;
  }

  function wire(section) {
    const bladeReset = findBladeResetButton();
    section.querySelectorAll("[data-maint-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const action = button.dataset.maintAction;
          if (action === "blade-reset" && bladeReset) await call("button", "press", bladeReset.entity_id);
          if (action === "firmware") await call("update", "install", IDS.firmware);
          if (action === "restart") await call("button", "press", IDS.restart);
          if (action === "sync-map") await call("button", "press", IDS.syncMap);
          if (action === "sync-rtk") await call("button", "press", IDS.syncRtk);
          if (action === "sync-schedule") await call("button", "press", IDS.syncSchedule);
        } catch (error) {
          BeastCore.log(`RoboGub vedligehold: handling fejlede (${error.message}).`);
        } finally {
          window.setTimeout(() => queue(), 700);
        }
      });
    });
  }

  function addStyles() {
    if (document.getElementById("beastRobogubMaintenanceStyles")) return;
    const style = document.createElement("style");
    style.id = "beastRobogubMaintenanceStyles";
    style.textContent = `
      .beast-robogub-maintenance{grid-column:1/-1}
      .beast-robogub-maint-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:12px}
      .beast-robogub-maint-card{display:grid;align-content:start;gap:7px;padding:14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-solid)}
      .beast-robogub-maint-card>small{color:var(--ink-muted);text-transform:uppercase;letter-spacing:.06em;font-size:var(--text-xs)}
      .beast-robogub-maint-card>strong{font-size:var(--text-lg)}
      .beast-robogub-maint-card>span{color:var(--ink-muted);font-size:var(--text-sm);min-height:1.35em}
      .beast-robogub-maint-action{appearance:none;width:100%;min-height:46px;margin-top:4px;border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--ink);font:inherit;display:flex;align-items:center;justify-content:flex-start;gap:9px;padding:8px 10px;text-align:left;touch-action:manipulation}
      .beast-robogub-maint-action>span{display:grid;gap:1px}.beast-robogub-maint-action strong{font-size:var(--text-sm)}.beast-robogub-maint-action small{color:var(--ink-muted);font-size:var(--text-xs)}
      .beast-robogub-maint-action.is-primary{border-color:var(--accent-border);background:var(--accent-soft);color:var(--accent)}
      .beast-robogub-maint-action.is-danger{border-color:color-mix(in srgb,var(--danger) 35%,transparent);color:var(--danger)}
      .beast-robogub-maint-action:disabled{opacity:.48}
      .beast-robogub-maint-sync{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.beast-robogub-maint-sync .beast-robogub-maint-action{justify-content:center;text-align:center;padding:8px 6px}.beast-robogub-maint-sync .beast-robogub-maint-action>span{display:block}
      @media(max-width:1050px){.beast-robogub-maint-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:620px){.beast-robogub-maint-grid{grid-template-columns:1fr}.beast-robogub-maint-sync{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function enhance() {
    queued = false;
    const consoleEl = document.querySelector("#beastRobotsGrid .beast-robogub-console");
    if (!consoleEl) return;
    const markup = build();
    const existing = consoleEl.querySelector(".beast-robogub-maintenance");
    if (existing && existing.dataset.renderMarkup === markup) return;
    existing?.remove();
    const holder = document.createElement("div");
    holder.innerHTML = markup;
    const section = holder.firstElementChild;
    section.dataset.renderMarkup = markup;
    consoleEl.appendChild(section);
    wire(section);
  }

  function queue() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(enhance);
  }

  function mutationAddsRoboGub(mutations) {
    return mutations.some((mutation) => Array.from(mutation.addedNodes || []).some((node) => {
      if (!(node instanceof Element)) return false;
      return node.matches?.(".beast-robogub-console, #beastRobotsGrid") || !!node.querySelector?.(".beast-robogub-console, #beastRobotsGrid");
    }));
  }

  function init() {
    addStyles();
    queue();
    const root = document.getElementById("beastRoot") || document.body;
    new MutationObserver((mutations) => {
      if (mutationAddsRoboGub(mutations)) queue();
    }).observe(root, { childList: true, subtree: true });
    [IDS.bladeRuntime, IDS.bladeWarning, IDS.firmware].forEach((id) => BeastHaSocket.subscribeEntity(id, queue));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
