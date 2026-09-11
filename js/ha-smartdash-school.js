window.BeastSchool = (() => {
  const CHILDREN = {
    frederikke: {
      name: "Frederikke",
      fullName: "Frederikke Korsgaard Lyngsø",
      calendar: "calendar.skoleskema_frederikke_korsgaard_lyngso",
      profile: "sensor.dybkaerskolen_frederikke"
    },
    mikkeline: {
      name: "Mikkeline",
      fullName: "Mikkeline Korsgaard Lyngsø",
      calendar: "calendar.skoleskema_mikkeline_korsgaard_lyngso",
      profile: "sensor.dybkaerskolen_mikkeline"
    }
  };

  const ATTENTION_ENTITY = "sensor.aula_attention";
  const MANUAL_ACTIONS_ENTITY = "sensor.aula_manual_actions";
  const ACTION_REGISTRY_ENTITY = "sensor.aula_action_registry";
  const ACTION_SCRIPT = "script.aula_attention_handle";
  const RESTORE_SCRIPT = "script.aula_attention_restore";
  const SUBJECT_COLORS = [
    "#3578c7", "#a8556e", "#31856b", "#9b7131",
    "#7656ad", "#308491", "#ae5f35", "#587d46"
  ];

  let containerEl = null;
  let selectedChild = "frederikke";
  let weekOffset = [0, 6].includes(new Date().getDay()) ? 1 : 0;
  let renderRequest = 0;
  let currentAttentionItems = [];
  let currentWeekPlan = "";
  let currentWeekPlans = new Map();
  const locallyHandledActions = new Set();
  const locallyRestoredActions = new Set();

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  const english = () =>
    String(document.documentElement.lang || "").toLowerCase().startsWith("en");

  const t = (da, en) => english() ? en : da;

  function startOfWeek(offset = 0) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    const day = date.getDay();
    date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day) + offset * 7);
    return date;
  }

  function dateKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  }

  function timeLabel(value) {
    return new Date(value).toLocaleTimeString(
      english() ? "en-GB" : "da-DK",
      { hour: "2-digit", minute: "2-digit" }
    );
  }

  function subjectColor(subject) {
    const value = String(subject || "?").toLowerCase();
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
    }
    return SUBJECT_COLORS[hash % SUBJECT_COLORS.length];
  }

  function subjectLabel(subject) {
    return window.BeastScheduleSubjects?.label(subject) || subject || t("Ukendt fag", "Unknown subject");
  }

  function cleanMarkup(value) {
    const host = document.createElement("div");
    host.innerHTML = String(value || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/\\\./g, ".");
    return (host.textContent || "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function displayedWeekDays() {
    const start = startOfWeek(weekOffset);
    return Array.from({ length: 5 }, (_, index) => {
      const date = new Date(start);
      date.setDate(date.getDate() + index);
      return date;
    });
  }

  function normalizedText(value) {
    return String(value || "")
      .toLocaleLowerCase("da-DK")
      .replace(/[\\.]/g, "")
      .replace(/[^a-z0-9æøå/]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parsePlanDate(label, days) {
    const months = {
      jan: 1, feb: 2, mar: 3, apr: 4, maj: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12
    };
    const match = String(label || "").toLowerCase()
      .match(/(\d{1,2})\.\s*([a-zæøå]{3})/i);
    if (!match) return null;

    const day = Number(match[1]);
    const month = months[match[2].slice(0, 3)];
    const found = days.find((date) =>
      date.getDate() === day && date.getMonth() + 1 === month
    );
    return found ? dateKey(found) : null;
  }

  function parseWeekPlans(profile) {
    const days = displayedWeekDays();
    const result = new Map();
    const sources = [
      profile?.attributes?.ugeplan || "",
      profile?.attributes?.ugeplan_next || ""
    ].filter(Boolean);

    sources.forEach((source) => {
      const headingPattern = /<h3>(.*?)<\/h3>/gi;
      const headings = [];
      let match;

      while ((match = headingPattern.exec(source)) !== null) {
        headings.push({
          label: cleanMarkup(match[1]),
          start: match.index,
          bodyStart: headingPattern.lastIndex
        });
      }

      headings.forEach((heading, index) => {
        const bodyEnd = headings[index + 1]?.start ?? source.length;
        let body = source.slice(heading.bodyStart, bodyEnd);
        const bodyText = cleanMarkup(body);
        const key = parsePlanDate(heading.label, days);
        if (!key) return;

        if (/^-\s*$/.test(bodyText) && headings[index + 1]) {
          const nextBodyEnd = headings[index + 2]?.start ?? source.length;
          body = source.slice(headings[index + 1].bodyStart, nextBodyEnd);
        }

        const text = cleanMarkup(body)
          .replace(/^[-–]\s*/, "")
          .replace(/^Ugeplan(?:\s+\d+\.[a-z])?\s*/i, "")
          .trim();

        if (!text) return;
        const previous = result.get(key);
        result.set(key, previous && !previous.includes(text)
          ? `${previous}\n\n${text}`
          : previous || text);
      });
    });

    return result;
  }

  function subjectAliases(subject) {
    const normalized = normalizedText(subject);
    const aliases = {
      dansk: ["dansk"],
      matematik: ["matematik"],
      idræt: ["idræt"],
      musik: ["musik"],
      engelsk: ["engelsk"],
      historie: ["historie"],
      billedkunst: ["billedkunst"],
      "håndværk/design": ["håndværk/design", "håndværk design", "hds"],
      "natur/teknologi": ["natur/teknologi", "natur teknologi", "n/t"],
      kristendomskundskab: ["kristendom", "kristendomskundskab"],
      udeskole: ["udeskole"],
      uuv: ["uuv"],
      pbl: ["pbl"]
    };
    return aliases[normalized] || [normalized];
  }

  function lessonPlanText(dayText, subject) {
    if (!dayText) return "";
    const aliases = subjectAliases(subject);
    const paragraphs = String(dayText)
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

    return paragraphs
      .filter((paragraph) => {
        const normalized = normalizedText(paragraph);
        return aliases.some((alias) => normalized.includes(normalizedText(alias)));
      })
      .join("\n\n");
  }

  function reminderText(dayText) {
    if (!dayText) return "";
    const reminderPattern =
      /husk|medbring|aflever|return[eé]r|udfyld|cykel|hjelm|håndklæde|skiftetøj|biblioteksbøger|bibliotek|foto|fotograf|fotografering|skoleportræt|portræt/i;

    return String(dayText)
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => reminderPattern.test(paragraph))
      .join("\n\n");
  }

  function attentionSectionLabel(raw) {
    const value = String(raw || "").toLowerCase();
    if (value.includes("i dag")) return t("I dag", "Today");
    if (value.includes("besked")) return t("Beskeder", "Messages");
    return t("Kommende", "Upcoming");
  }

  function stripMarkdown(value) {
    return String(value || "")
      .replace(/^[-•]\s*/, "")
      .replace(/\*\*/g, "")
      .replace(/^#+\s*/, "")
      .trim();
  }

  function detectChild(value) {
    const text = String(value || "").toLowerCase();
    if (text.includes("frederikke")) return "frederikke";
    if (text.includes("mikkeline")) return "mikkeline";
    return null;
  }

  function itemBadges(value) {
    const text = String(value || "").toLowerCase();
    const badges = [];
    if (/svar mangler|meld om|godkend|underskriv|return[eé]r|udfyld/.test(text)) {
      badges.push(t("Handling", "Action"));
    }
    if (/medbring|pakkeliste|madras|hjelm|skiftetøj|håndklæde/.test(text)) {
      badges.push(t("Husk", "Remember"));
    }
    if (/betal|overfør|kr\./.test(text)) badges.push(t("Betaling", "Payment"));
    if (/tilladelse|godkendelse/.test(text)) badges.push(t("Tilladelse", "Permission"));
    return badges;
  }

  function arrayAttribute(entityId, attribute) {
    const value = BeastHaSocket.getState(entityId)?.attributes?.[attribute];
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function handledActionRecords() {
    return arrayAttribute(ACTION_REGISTRY_ENTITY, "handled")
      .filter((item) =>
        /^[0-9a-f]{24}$/.test(String(item?.fingerprint || "")) &&
        !locallyRestoredActions.has(item.fingerprint)
      )
      .sort((left, right) =>
        String(right?.handled_at || "").localeCompare(String(left?.handled_at || ""))
      );
  }

  function handledActionFingerprints() {
    return new Set([
      ...handledActionRecords().map((item) => item.fingerprint),
      ...locallyHandledActions
    ]);
  }

  function childKeys(names) {
    const normalized = Array.isArray(names) ? names : [];
    return Object.entries(CHILDREN)
      .filter(([, child]) => normalized.includes(child.fullName))
      .map(([key]) => key);
  }

  function manualAttentionItems() {
    const handled = handledActionFingerprints();
    return arrayAttribute(MANUAL_ACTIONS_ENTITY, "items").flatMap((item) => {
      const fingerprint = String(item?.fingerprint || "");
      if (!/^[0-9a-f]{24}$/.test(fingerprint) || handled.has(fingerprint)) return [];

      const children = childKeys(item.appliesToChildren);
      const actionType = String(item.actionType || "other");
      const badge = {
        payment: t("Betaling", "Payment"),
        response: t("Svar", "Response")
      }[actionType] || t("Handling", "Action");

      return [{
        section: t("Beskeder", "Messages"),
        child: children.length === 1 ? children[0] : null,
        children,
        title: String(item.title || t("Aula-besked", "Aula message")),
        detail: String(item.detail || ""),
        badges: [badge],
        manualAction: true,
        fingerprint,
        suggestedEvent: item.suggestedEvent && typeof item.suggestedEvent === "object"
          ? item.suggestedEvent
          : {}
      }];
    });
  }

  function parseAttention() {
    const content = BeastHaSocket.getState(ATTENTION_ENTITY)?.attributes?.content || "";
    const lines = String(content).split(/\r?\n/);
    const items = [];
    let section = t("Kommende", "Upcoming");
    let current = null;

    const push = () => {
      if (!current) return;
      current.detail = current.parts.join("\n").trim();
      current.badges = itemBadges(current.detail);
      delete current.parts;
      items.push(current);
      current = null;
    };

    lines.forEach((sourceLine) => {
      const line = sourceLine.trim();
      if (!line) return;

      if (/^###\s*/.test(line)) {
        push();
        section = attentionSectionLabel(stripMarkdown(line));
        return;
      }

      const startsItem =
        /^[-•]\s+/.test(line) ||
        /^\*\*(Frederikke|Mikkeline)\*\*\s*[-–:]/i.test(line);

      if (startsItem) {
        push();
        const cleaned = stripMarkdown(line);
        current = {
          section,
          child: detectChild(cleaned),
          title: cleaned,
          parts: [cleaned]
        };
        return;
      }

      if (current) current.parts.push(stripMarkdown(line));
    });

    push();
    return [...items, ...manualAttentionItems()];
  }

  async function loadWeek(calendarEntity) {
    const start = startOfWeek(weekOffset);
    const end = new Date(start);
    end.setDate(end.getDate() + 5);

    const events = await BeastAuth.haFetch(
      `/api/calendars/${calendarEntity}?start=${start.toISOString()}&end=${end.toISOString()}`
    );

    return window.BeastScheduleSubjects?.mergeEvents(events || []) || [];
  }

  function weekLabel() {
    if (weekOffset === 0) return t("Denne uge", "This week");
    if (weekOffset === 1) return t("Næste uge", "Next week");
    if (weekOffset === -1) return t("Sidste uge", "Previous week");

    const start = startOfWeek(weekOffset);
    const end = new Date(start);
    end.setDate(end.getDate() + 4);
    const locale = english() ? "en-GB" : "da-DK";

    return `${start.toLocaleDateString(locale, { day: "numeric", month: "short" })} – ${
      end.toLocaleDateString(locale, { day: "numeric", month: "short" })
    }`;
  }

  function dayOverview(events) {
    if (!events.length) {
      return {
        label: t("Ingen skoledag fundet", "No school day found"),
        events: [],
        first: null,
        last: null,
        next: null
      };
    }

    const now = new Date();
    const todayKey = dateKey(now);
    const grouped = new Map();

    events.forEach((event) => {
      const key = dateKey(event.start);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(event);
    });

    const keys = [...grouped.keys()].sort();
    const targetKey = grouped.has(todayKey)
      ? todayKey
      : keys.find((key) => key > todayKey) || keys[0];

    const dayEvents = grouped.get(targetKey) || [];
    const isToday = targetKey === todayKey;
    const first = dayEvents[0] || null;
    const last = dayEvents[dayEvents.length - 1] || null;
    const next = isToday
      ? dayEvents.find((event) => new Date(event.end) > now) || null
      : first;

    const date = first ? new Date(first.start) : null;
    const locale = english() ? "en-GB" : "da-DK";

    return {
      label: isToday
        ? t("I dag", "Today")
        : `${t("Næste skoledag", "Next school day")} · ${
            date.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "short" })
          }`,
      events: dayEvents,
      first,
      last,
      next
    };
  }

  function daySummaryMarkup(events, state) {
    const overview = dayOverview(events);
    const nextSubject = overview.next ? subjectLabel(overview.next.subject) : "–";

    return `
      <section class="beast-school-day-card">
        <div class="beast-school-day-heading">
          <span>${BeastCore.icon("school", { size: 25 })}</span>
          <div>
            <small>${escapeHtml(overview.label)}</small>
            <strong>${escapeHtml(CHILDREN[selectedChild].name)}</strong>
          </div>
        </div>
        <div class="beast-school-day-facts">
          <div>
            <small>${t("Starter", "Starts")}</small>
            <strong>${overview.first ? timeLabel(overview.first.start) : "–"}</strong>
          </div>
          <div>
            <small>${t("Slutter", "Ends")}</small>
            <strong>${overview.last ? timeLabel(overview.last.end) : "–"}</strong>
          </div>
          <div class="is-next">
            <small>${overview.events.length && dateKey(overview.events[0].start) === dateKey(new Date())
              ? t("Nu/næste", "Now/next")
              : t("Første fag", "First lesson")}</small>
            <strong>${escapeHtml(nextSubject)}</strong>
            ${overview.next ? `<span>${timeLabel(overview.next.start)}–${timeLabel(overview.next.end)}</span>` : ""}
          </div>
          <div class="is-status">
            <small>${t("Aula-status", "Aula status")}</small>
            <strong>${escapeHtml(state || t("Ingen status", "No status"))}</strong>
          </div>
        </div>
      </section>
    `;
  }

  function scheduleMarkup(events, weekPlans) {
    if (!events.length) {
      return `<div class="beast-school-empty">${BeastCore.icon("calendar", { size: 30 })}<strong>${t("Ingen timer fundet", "No lessons found")}</strong></div>`;
    }

    const start = startOfWeek(weekOffset);
    const days = Array.from({ length: 5 }, (_, index) => {
      const date = new Date(start);
      date.setDate(date.getDate() + index);
      return date;
    });

    const slots = [...new Map(events.map((event) => [
      timeLabel(event.start),
      { start: timeLabel(event.start), end: timeLabel(event.end) }
    ])).values()].sort((a, b) => a.start.localeCompare(b.start));

    const timeMinutes = (value) => {
      const date = new Date(value);
      return date.getHours() * 60 + date.getMinutes();
    };

    const slotMinutes = (value) => {
      const [hours, minutes] = value.split(/[:.]/).map(Number);
      return hours * 60 + minutes;
    };

    const eventsByDay = new Map();
    events.forEach((event) => {
      const key = dateKey(event.start);
      if (!eventsByDay.has(key)) eventsByDay.set(key, []);
      eventsByDay.get(key).push(event);
    });

    const locale = english() ? "en-GB" : "da-DK";
    const today = dateKey(new Date());

    const head = days.map((day) => `
      <div class="beast-school-grid-head${dateKey(day) === today ? " is-today" : ""}">
        <small>${escapeHtml(day.toLocaleDateString(locale, { weekday: "short" }))}</small>
        <strong>${day.getDate()}/${day.getMonth() + 1}</strong>
      </div>
    `).join("");

    const rows = slots.map((slot) => {
      const cells = days.map((day) => {
        const minute = slotMinutes(slot.start);
        const dayEvents = eventsByDay.get(dateKey(day)) || [];
        const event = dayEvents.find((candidate) => {
          const startMinute = timeMinutes(candidate.start);
          const endMinute = timeMinutes(candidate.end);
          return minute >= startMinute && minute < endMinute;
        });

        if (!event) return `<div class="beast-school-lesson is-empty"></div>`;

        const subject = subjectLabel(event.subject);
        const teachers = (event.teachers || []).join(" + ");
        const planText = lessonPlanText(weekPlans.get(dateKey(day)) || "", subject);
        return `
          <button
            type="button"
            class="beast-school-lesson${planText ? " has-plan" : ""}"
            style="--lesson-color:${subjectColor(subject)}"
            data-lesson-detail="${escapeHtml(JSON.stringify({
              subject,
              start: event.start,
              end: event.end,
              teachers: event.teachers || [],
              location: event.location || "",
              plan: planText
            }))}"
          >
            ${planText
              ? `<i class="beast-school-plan-dot" title="${t("Ugeplansinfo", "Weekly plan information")}"></i>`
              : ""}
            <strong>${escapeHtml(subject)}</strong>
            ${teachers ? `<span>${escapeHtml(teachers)}</span>` : ""}
            ${event.location ? `<small>${escapeHtml(event.location)}</small>` : ""}
          </button>
        `;
      }).join("");

      return `
        <div class="beast-school-grid-row">
          <div class="beast-school-grid-time">
            <strong>${escapeHtml(slot.start)}</strong>
            <small>${escapeHtml(slot.end)}</small>
          </div>
          ${cells}
        </div>
      `;
    }).join("");

    return `
      <div class="beast-school-grid">
        <div class="beast-school-grid-row is-header">
          <div></div>
          ${head}
        </div>
        ${rows}
      </div>
    `;
  }

  function reminderMarkup(weekPlans) {
    const locale = english() ? "en-GB" : "da-DK";
    const reminders = displayedWeekDays()
      .map((date) => ({
        date,
        text: reminderText(weekPlans.get(dateKey(date)) || "")
      }))
      .filter((item) => item.text);

    if (!reminders.length) return "";

    return `
      <div class="beast-school-reminders">
        <div class="beast-school-reminders-label">
          ${BeastCore.icon("bell", { size: 18 })}
          <strong>${t("Husk", "Remember")}</strong>
        </div>
        <div class="beast-school-reminder-list">
          ${reminders.map((item) => `
            <button
              type="button"
              data-week-reminder="${escapeHtml(JSON.stringify({
                date: item.date.toLocaleDateString(locale, {
                  weekday: "long",
                  day: "numeric",
                  month: "short"
                }),
                text: item.text
              }))}"
            >
              <small>${escapeHtml(item.date.toLocaleDateString(locale, { weekday: "short" }))}</small>
              <span>${escapeHtml(item.text)}</span>
              ${BeastCore.icon("chevron-right", { size: 16 })}
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }

  function attentionMarkup() {
    const items = currentAttentionItems
      .filter((item) => !item.child || item.child === selectedChild)
      .slice(0, 8);

    const cards = items.map((item, index) => `
      <button type="button" class="beast-school-notice" data-attention-index="${index}">
        <div>
          <small>${escapeHtml(item.section)}</small>
          <strong>${escapeHtml(item.title)}</strong>
        </div>
        ${item.badges.length ? `
          <span class="beast-school-badges">
            ${item.badges.map((badge) => `<i>${escapeHtml(badge)}</i>`).join("")}
          </span>
        ` : ""}
        ${BeastCore.icon("chevron-right", { size: 18 })}
      </button>
    `).join("");

    return cards || `
      <div class="beast-school-empty is-small">
        ${BeastCore.icon("check", { size: 24 })}
        <strong>${t("Ingen aktuelle Aula-punkter", "No current Aula items")}</strong>
      </div>
    `;
  }

  function weekPlanMarkup() {
    if (!currentWeekPlan) return "";

    return `
      <button type="button" class="beast-school-weekplan" data-open-weekplan>
        <span>${BeastCore.icon("calendar", { size: 22 })}</span>
        <div>
          <small>${t("Fra Aula", "From Aula")}</small>
          <strong>${t("Åbn næste ugeplan", "Open next weekly plan")}</strong>
        </div>
        ${BeastCore.icon("chevron-right", { size: 18 })}
      </button>
    `;
  }

  function handledActionsMarkup() {
    const childName = CHILDREN[selectedChild].fullName;
    const count = handledActionRecords()
      .filter((item) => !item.child || item.child === childName)
      .length;
    if (!count) return "";

    return `
      <button type="button" class="beast-school-handled-toggle" data-open-handled-actions>
        <span>${t("Afsluttede Aula-punkter", "Completed Aula items")}</span>
        <strong>${count}</strong>
        ${BeastCore.icon("chevron-right", { size: 17 })}
      </button>
    `;
  }

  function localDateTimeValue(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function openModal({
    eyebrow = "",
    title = "",
    body = "",
    bodyHtml = "",
    meta = "",
    actionItem = null
  }) {
    document.getElementById("beastSchoolModal")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "beastSchoolModal";
    overlay.className = "beast-modal-overlay";
    overlay.innerHTML = `
      <div class="beast-modal beast-school-modal" role="dialog" aria-modal="true">
        <div class="beast-modal-header">
          <div>
            ${eyebrow ? `<small>${escapeHtml(eyebrow)}</small>` : ""}
            <h3>${escapeHtml(title)}</h3>
            ${meta ? `<p>${escapeHtml(meta)}</p>` : ""}
          </div>
          <button type="button" class="beast-modal-close" data-close>
            ${BeastCore.icon("close", { size: 22 })}
          </button>
        </div>
        <div class="beast-modal-body">
          <div class="beast-school-modal-text">${bodyHtml || escapeHtml(body)}</div>
          ${actionItem ? `
            <form class="beast-school-action-form" data-aula-action-form>
              <label>
                <span>${t("Barn", "Child")}</span>
                <select name="child" required>
                  ${Object.entries(CHILDREN).map(([key, child]) => `
                    <option value="${key}" ${key === selectedChild ? "selected" : ""}>
                      ${escapeHtml(child.name)}
                    </option>
                  `).join("")}
                </select>
              </label>
              <label class="is-wide">
                <span>${t("Titel", "Title")}</span>
                <input name="title" maxlength="120" value="${escapeHtml(actionItem.suggestedEvent?.title || actionItem.title)}" required>
              </label>
              <label>
                <span>${t("Start", "Start")}</span>
                <input type="datetime-local" name="start" value="${escapeHtml(localDateTimeValue(actionItem.suggestedEvent?.start))}">
              </label>
              <label>
                <span>${t("Slut", "End")}</span>
                <input type="datetime-local" name="end" value="${escapeHtml(localDateTimeValue(actionItem.suggestedEvent?.end))}">
              </label>
              <label class="is-wide">
                <span>${t("Sted", "Location")}</span>
                <input name="location" maxlength="160" value="${escapeHtml(actionItem.suggestedEvent?.location || "")}">
              </label>
              <p class="beast-school-action-status" data-action-status></p>
              <div class="beast-school-action-buttons is-wide">
                <button type="button" class="is-secondary" data-mark-complete>
                  ${t("Markér som klaret", "Mark complete")}
                </button>
                <button type="submit" class="is-primary">
                  ${t("Opret i kalender", "Create calendar event")}
                </button>
              </div>
            </form>
          ` : ""}
        </div>
      </div>
    `;

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay || event.target.closest("[data-close]")) overlay.remove();
    });

    document.body.appendChild(overlay);

    if (actionItem) wireActionForm(overlay, actionItem);
    return overlay;
  }

  function setActionFormState(form, message, isError = false) {
    const status = form.querySelector("[data-action-status]");
    if (status) {
      status.textContent = message;
      status.classList.toggle("is-error", isError);
    }
    form.querySelectorAll("button, input, select").forEach((control) => {
      control.disabled = Boolean(message) && !isError;
    });
  }

  async function submitManualAction(form, item, resolution) {
    const data = new FormData(form);
    const childKey = String(data.get("child") || "");
    const child = CHILDREN[childKey];
    const title = String(data.get("title") || "").trim();
    const startValue = String(data.get("start") || "");
    const endValue = String(data.get("end") || "");

    if (resolution === "calendar") {
      const start = new Date(startValue);
      const end = new Date(endValue);
      if (!child || !title || !startValue || !endValue || Number.isNaN(start.getTime()) ||
          Number.isNaN(end.getTime()) || end <= start) {
        setActionFormState(
          form,
          t("Vælg barn, titel og et gyldigt start-/sluttidspunkt.", "Choose a child, title, and valid start/end time."),
          true
        );
        return;
      }

      const earliestStart = new Date(Date.now() - 60 * 60 * 1000);
      const latestStart = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000);
      if (start < earliestStart) {
        setActionFormState(
          form,
          t(
            "Starttidspunktet må ikke ligge mere end én time tilbage.",
            "The start time cannot be more than one hour in the past."
          ),
          true
        );
        return;
      }
      if (start > latestStart) {
        setActionFormState(
          form,
          t(
            "Starttidspunktet må højst ligge 366 dage frem.",
            "The start time cannot be more than 366 days ahead."
          ),
          true
        );
        return;
      }
    }

    setActionFormState(form, t("Gemmer…", "Saving…"));
    try {
      await BeastAuth.haFetch(`/api/services/${ACTION_SCRIPT.replace(".", "/")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fingerprint: item.fingerprint,
          resolution,
          child: child?.fullName || "",
          title,
          start: startValue ? new Date(startValue).toISOString() : "",
          end: endValue ? new Date(endValue).toISOString() : "",
          location: String(data.get("location") || "").trim(),
          description: item.detail
        })
      });
      locallyRestoredActions.delete(item.fingerprint);
      locallyHandledActions.add(item.fingerprint);
      form.closest(".beast-modal-overlay")?.remove();
      render();
    } catch (error) {
      setActionFormState(form, `${t("Kunne ikke gemme", "Could not save")}: ${error.message}`, true);
    }
  }

  function wireActionForm(overlay, item) {
    const form = overlay.querySelector("[data-aula-action-form]");
    if (!form) return;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitManualAction(form, item, "calendar");
    });
    form.querySelector("[data-mark-complete]")?.addEventListener("click", () => {
      submitManualAction(form, item, "completed");
    });
  }

  async function restoreHandledAction(overlay, record, button) {
    button.disabled = true;
    button.textContent = t("Gendanner…", "Restoring…");
    try {
      await BeastAuth.haFetch(`/api/services/${RESTORE_SCRIPT.replace(".", "/")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint: record.fingerprint })
      });
      locallyHandledActions.delete(record.fingerprint);
      locallyRestoredActions.add(record.fingerprint);
      overlay.remove();
      render();
    } catch (error) {
      button.disabled = false;
      button.textContent = t("Prøv igen", "Try again");
      BeastCore.log(`Skole: kunne ikke gendanne Aula-punkt (${error.message}).`);
    }
  }

  function openHandledActionsModal() {
    const childName = CHILDREN[selectedChild].fullName;
    const records = handledActionRecords()
      .filter((item) => !item.child || item.child === childName);
    if (!records.length) return;

    const overlay = openModal({
      eyebrow: CHILDREN[selectedChild].name,
      title: t("Afsluttede Aula-punkter", "Completed Aula items"),
      bodyHtml: `
        <div class="beast-school-handled-list">
          ${records.map((item, index) => `
            <div class="beast-school-handled-item">
              <div>
                <strong>${escapeHtml(item.title || t("Aula-punkt", "Aula item"))}</strong>
                <small>${escapeHtml(
                  item.resolution === "calendar"
                    ? t("Kalenderført", "Added to calendar")
                    : t("Markeret som klaret", "Marked complete")
                )}</small>
              </div>
              <button type="button" data-restore-action="${index}">
                ${t("Gendan", "Restore")}
              </button>
            </div>
          `).join("")}
        </div>
      `
    });

    overlay.querySelectorAll("[data-restore-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const record = records[Number(button.dataset.restoreAction)];
        if (record) restoreHandledAction(overlay, record, button);
      });
    });
  }

  function wireInteractions(events) {
    containerEl.querySelectorAll("[data-school-child]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedChild = button.dataset.schoolChild;
        render();
      });
    });

    containerEl.querySelector("[data-school-prev]")?.addEventListener("click", () => {
      weekOffset -= 1;
      render();
    });

    containerEl.querySelector("[data-school-next]")?.addEventListener("click", () => {
      weekOffset += 1;
      render();
    });

    containerEl.querySelectorAll("[data-week-reminder]").forEach((button) => {
      button.addEventListener("click", () => {
        try {
          const reminder = JSON.parse(button.dataset.weekReminder);
          openModal({
            eyebrow: `${CHILDREN[selectedChild].name} · ${t("Husk", "Remember")}`,
            title: reminder.date,
            body: reminder.text
          });
        } catch (error) {
          BeastCore.log(`Skole: kunne ikke åbne huskepunkt (${error.message}).`);
        }
      });
    });

    containerEl.querySelectorAll("[data-attention-index]").forEach((button) => {
      button.addEventListener("click", () => {
        const visible = currentAttentionItems
          .filter((item) => !item.child || item.child === selectedChild)
          .slice(0, 8);
        const item = visible[Number(button.dataset.attentionIndex)];
        if (!item) return;

        openModal({
          eyebrow: `${CHILDREN[selectedChild].name} · ${item.section}`,
          title: item.title,
          body: item.detail,
          actionItem: item.manualAction ? item : null
        });
      });
    });

    containerEl.querySelector("[data-open-handled-actions]")?.addEventListener("click", () => {
      openHandledActionsModal();
    });

    containerEl.querySelector("[data-open-weekplan]")?.addEventListener("click", () => {
      openModal({
        eyebrow: CHILDREN[selectedChild].name,
        title: t("Næste ugeplan", "Next weekly plan"),
        body: currentWeekPlan
      });
    });

    containerEl.querySelectorAll("[data-lesson-detail]").forEach((button) => {
      button.addEventListener("click", () => {
        try {
          const lesson = JSON.parse(button.dataset.lessonDetail);
          openModal({
            eyebrow: CHILDREN[selectedChild].name,
            title: lesson.subject,
            meta: `${timeLabel(lesson.start)}–${timeLabel(lesson.end)}${
              lesson.location ? ` · ${lesson.location}` : ""
            }`,
            body: [
              lesson.teachers.length
                ? `${t("Lærer", "Teacher")}: ${lesson.teachers.join(" + ")}`
                : "",
              lesson.plan
                ? `${t("Fra ugeplanen", "From the weekly plan")}\n${lesson.plan}`
                : ""
            ].filter(Boolean).join("\n\n") ||
              t("Ingen yderligere oplysninger.", "No additional information.")
          });
        } catch (error) {
          BeastCore.log(`Skole: kunne ikke åbne lektion (${error.message}).`);
        }
      });
    });
  }

  async function render() {
    if (!containerEl) return;

    const requestId = ++renderRequest;
    const child = CHILDREN[selectedChild];
    const profile = BeastHaSocket.getState(child.profile);
    const state = profile?.state || "";
    const weekPlans = parseWeekPlans(profile);
    const weekPlan = displayedWeekDays()
      .map((date) => {
        const text = weekPlans.get(dateKey(date));
        if (!text) return "";
        const locale = english() ? "en-GB" : "da-DK";
        const label = date.toLocaleDateString(locale, {
          weekday: "long",
          day: "numeric",
          month: "short"
        });
        return `${label}\n${text}`;
      })
      .filter(Boolean)
      .join("\n\n");

    containerEl.innerHTML = `
      <div class="beast-school-loading">
        ${BeastCore.icon("school", { size: 32 })}
        <strong>${t("Henter skolesiden…", "Loading school page…")}</strong>
      </div>
    `;

    let events = [];
    try {
      events = await loadWeek(child.calendar);
    } catch (error) {
      BeastCore.log(`Skole: kalender kunne ikke hentes (${error.message}).`);
    }

    if (requestId !== renderRequest) return;

    currentAttentionItems = parseAttention();
    currentWeekPlan = weekPlan;
    currentWeekPlans = weekPlans;

    containerEl.innerHTML = `
      <div class="beast-school-shell">
        <header class="beast-school-header">
          <div>
            <small>${t("Familieoverblik", "Family overview")}</small>
            <h1>${t("Skole", "School")}</h1>
          </div>
          <div class="beast-school-child-tabs">
            ${Object.entries(CHILDREN).map(([key, entry]) => {
              const childState = BeastHaSocket.getState(entry.profile);
              const childImage = childState?.attributes?.profilePicture || "";
              return `
                <button type="button" data-school-child="${key}" class="${key === selectedChild ? "is-active" : ""}">
                  ${childImage
                    ? `<img src="${escapeHtml(childImage)}" alt="">`
                    : `<span>${escapeHtml(entry.name.slice(0, 1))}</span>`}
                  <strong>${escapeHtml(entry.name)}</strong>
                </button>
              `;
            }).join("")}
          </div>
        </header>

        ${daySummaryMarkup(events, state)}

        <section class="beast-school-aula-card beast-school-aula-wide">
          <div class="beast-school-section-head">
            <div>
              <small>Aula</small>
              <h2>${t("Det skal I vide", "What you need to know")}</h2>
            </div>
            <span class="beast-school-live-dot"></span>
          </div>
          <div class="beast-school-notices">
            ${attentionMarkup()}
          </div>
          ${weekPlanMarkup()}
          ${handledActionsMarkup()}
        </section>

        <section class="beast-school-schedule-card">
          <div class="beast-school-section-head">
            <div>
              <small>${escapeHtml(child.name)}</small>
              <h2>${t("Skoleskema", "Timetable")}</h2>
            </div>
            <div class="beast-school-week-nav">
              <button type="button" data-school-prev aria-label="${t("Forrige uge", "Previous week")}">
                ${BeastCore.icon("chevron-right", { size: 18 })}
              </button>
              <strong>${escapeHtml(weekLabel())}</strong>
              <button type="button" data-school-next aria-label="${t("Næste uge", "Next week")}">
                ${BeastCore.icon("chevron-right", { size: 18 })}
              </button>
            </div>
          </div>
          ${reminderMarkup(currentWeekPlans)}
          ${scheduleMarkup(events, currentWeekPlans)}
        </section>
      </div>
    `;

    wireInteractions(events);
  }

  function init(root) {
    containerEl = root;
    containerEl.classList.add("beast-school-panel");

    containerEl.innerHTML = `
      <div class="beast-school-loading">
        ${BeastCore.icon("school", { size: 32 })}
        <strong>${t("Venter på Home Assistant…", "Waiting for Home Assistant…")}</strong>
      </div>
    `;

    const stableRender = BeastCore.stableUpdater(containerEl, render, 500);

    BeastHaSocket.onStatusChange((status) => {
      if (status === "connected") render();
    });

    BeastHaSocket.subscribeEntity(ATTENTION_ENTITY, stableRender);
    BeastHaSocket.subscribeEntity(MANUAL_ACTIONS_ENTITY, stableRender);
    BeastHaSocket.subscribeEntity(ACTION_REGISTRY_ENTITY, stableRender);
    Object.values(CHILDREN).forEach((child) => {
      BeastHaSocket.subscribeEntity(child.profile, stableRender);
      BeastHaSocket.subscribeEntity(child.calendar, stableRender);
    });
  }

  BeastCore.registerPanel("school", "beastSchoolZone", init);

  return { render };
})();
