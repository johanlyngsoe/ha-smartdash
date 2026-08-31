const BeastVirtualKeyboard = (() => {
  const SETTING = "virtualKeyboardEnabled";

  const INPUT_SELECTOR = [
    'input[type="text"]',
    'input[type="search"]',
    'input[type="url"]',
    'input[type="email"]',
    'input[type="tel"]',
    'input[type="number"]',
    'input[type="password"]',
    'input:not([type])',
    'textarea',
    '[contenteditable="true"]'
  ].join(",");

  const rows = [
    ["1","2","3","4","5","6","7","8","9","0"],
    ["q","w","e","r","t","y","u","i","o","p","å"],
    ["a","s","d","f","g","h","j","k","l","æ","ø"],
    ["shift","z","x","c","v","b","n","m","backspace"],
    ["close","space","enter"]
  ];

  let root = null;
  let activeTarget = null;
  let shifted = false;

  function enabled() {
    return typeof BeastLocalSettings !== "undefined" &&
      Boolean(BeastLocalSettings.get(SETTING, false));
  }

  function eligible(target) {
    return target instanceof Element &&
      target.matches(INPUT_SELECTOR) &&
      !target.disabled &&
      !target.readOnly &&
      !target.closest("[data-virtual-keyboard-ignore]");
  }

  function label(key) {
    if (key === "shift") return "⇧";
    if (key === "backspace") return "⌫";
    if (key === "space") return "Mellemrum";
    if (key === "enter") return "Enter";
    if (key === "close") return "Luk";
    return shifted ? key.toLocaleUpperCase("da-DK") : key;
  }

  function renderKeys() {
    if (!root) return;

    const keys = root.querySelector("[data-vk-keys]");

    keys.innerHTML = rows.map((row) =>
      `<div class="beast-vk-row">${row.map((key) =>
        `<button type="button"
          class="beast-vk-key beast-vk-key-${key}"
          data-vk-key="${key}"
          tabindex="-1">${label(key)}</button>`
      ).join("")}</div>`
    ).join("");
  }

  function ensureRoot() {
    if (root) return root;

    root = document.createElement("div");
    root.className = "beast-vk";
    root.hidden = true;
    root.setAttribute("data-virtual-keyboard-ignore", "");

    root.innerHTML = `
      <div class="beast-vk-inner">
        <div class="beast-vk-handle"></div>
        <div class="beast-vk-keys" data-vk-keys></div>
      </div>
    `;

    document.body.appendChild(root);
    renderKeys();

    // Bevar fokus i det oprindelige input-felt.
    root.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) event.preventDefault();
    });

    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-vk-key]");
      if (!button) return;
      handleKey(button.dataset.vkKey);
    });

    return root;
  }

  function show(target) {
    if (!enabled() || !eligible(target)) return;

    activeTarget = target;
    ensureRoot().hidden = false;
    document.documentElement.classList.add("beast-vk-open");
  }

  function hide() {
    if (root) root.hidden = true;

    document.documentElement.classList.remove("beast-vk-open");
    activeTarget = null;
    shifted = false;
  }

  function emitInput(target) {
    target.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function replaceSelection(text) {
    const target = activeTarget;
    if (!target) return;

    target.focus({ preventScroll: true });

    if (target.isContentEditable) {
      document.execCommand("insertText", false, text);
      emitInput(target);
      return;
    }

    const supportsSelection =
      typeof target.selectionStart === "number" &&
      typeof target.selectionEnd === "number" &&
      typeof target.setRangeText === "function";

    if (supportsSelection) {
      target.setRangeText(
        text,
        target.selectionStart,
        target.selectionEnd,
        "end"
      );
    } else {
      target.value = `${target.value || ""}${text}`;
    }

    emitInput(target);
  }

  function backspace() {
    const target = activeTarget;
    if (!target) return;

    target.focus({ preventScroll: true });

    if (target.isContentEditable) {
      document.execCommand("delete", false);
      emitInput(target);
      return;
    }

    const supportsSelection =
      typeof target.selectionStart === "number" &&
      typeof target.selectionEnd === "number" &&
      typeof target.setRangeText === "function";

    if (supportsSelection) {
      const start = target.selectionStart;
      const end = target.selectionEnd;

      if (start === end && start > 0) {
        target.setRangeText("", start - 1, end, "end");
      } else if (start !== end) {
        target.setRangeText("", start, end, "end");
      }
    } else {
      target.value = String(target.value || "").slice(0, -1);
    }

    emitInput(target);
  }

  function pressEnter() {
    const target = activeTarget;
    if (!target) return;

    target.focus({ preventScroll: true });

    for (const type of ["keydown", "keypress", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true
      }));
    }

    if (target.tagName === "TEXTAREA" || target.isContentEditable) {
      replaceSelection("\n");
    } else if (target.form && typeof target.form.requestSubmit === "function") {
      target.form.requestSubmit();
    }
  }

  function handleKey(key) {
    if (!activeTarget || !document.contains(activeTarget)) {
      hide();
      return;
    }

    if (key === "close") {
      hide();
      return;
    }

    if (key === "shift") {
      shifted = !shifted;
      renderKeys();
      return;
    }

    if (key === "backspace") {
      backspace();
      return;
    }

    if (key === "space") {
      replaceSelection(" ");
      return;
    }

    if (key === "enter") {
      pressEnter();
      return;
    }

    replaceSelection(
      shifted ? key.toLocaleUpperCase("da-DK") : key
    );

    if (shifted) {
      shifted = false;
      renderKeys();
    }
  }

  document.addEventListener("focusin", (event) => {
    if (eligible(event.target)) show(event.target);
  });

  document.addEventListener("pointerdown", (event) => {
    if (eligible(event.target)) {
      show(event.target);
    }
  }, true);

  document.addEventListener("beast:local-settings-changed", (event) => {
    if (!event.detail || !["*", SETTING].includes(event.detail.path)) return;

    if (!enabled()) {
      hide();
      return;
    }

    if (eligible(document.activeElement)) {
      show(document.activeElement);
    }
  });

  return {
    show,
    hide,
    enabled
  };
})();
