/*
 * GlyphSentry - options page.
 *
 * The shared scanner module provides the script list and the config defaults,
 * so the message pane and this page can never drift apart.
 */
(function () {
  "use strict";

  const api = globalThis.messenger || globalThis.browser;
  const scanner = globalThis.UHScanner;

  const SAVE_DELAY_MS = 150;

  let config = scanner.normalizeConfig(null);
  let saveTimer = null;

  const $ = function (id) {
    return document.getElementById(id);
  };

  function setStatus(text) {
    $("status").textContent = text;
  }

  /* ------------------------------------------------------------------ *
   * Render
   * ------------------------------------------------------------------ */

  function buildScriptList() {
    const container = $("scripts");
    if (container.childElementCount > 0) {
      return;
    }
    scanner.SCRIPT_DEFS.forEach(function (def) {
      const label = document.createElement("label");
      label.className = "row choice compact";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.script = def.key;

      const text = document.createElement("span");
      text.appendChild(document.createTextNode(def.label + " "));

      const sample = document.createElement("small");
      sample.textContent = def.sample;
      text.appendChild(sample);

      label.append(input, text);
      container.appendChild(label);
    });
  }

  function render(next) {
    config = next;

    $("enabled").checked = config.enabled;

    const modes = document.querySelectorAll('input[name="mode"]');
    for (let i = 0; i < modes.length; i++) {
      modes[i].checked = modes[i].value === config.mode;
    }

    $("color").value = config.color;
    $("background").value = config.background;
    $("monoEmails").checked = config.monoEmails;
    $("monoDomains").checked = config.monoDomains;
    $("warnNonLatinAddress").checked = config.warnNonLatinAddress;
    $("warnForeignEmails").checked = config.warnForeignEmails;
    $("warnSender").checked = config.warnSender;

    buildScriptList();
    const boxes = document.querySelectorAll("#scripts input[data-script]");
    for (let i = 0; i < boxes.length; i++) {
      boxes[i].checked = config.scripts[boxes[i].dataset.script] !== false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Read + save
   * ------------------------------------------------------------------ */

  function readForm() {
    const scripts = {};
    const boxes = document.querySelectorAll("#scripts input[data-script]");
    for (let i = 0; i < boxes.length; i++) {
      scripts[boxes[i].dataset.script] = boxes[i].checked;
    }

    const checkedMode = document.querySelector('input[name="mode"]:checked');

    return scanner.normalizeConfig({
      enabled: $("enabled").checked,
      mode: checkedMode ? checkedMode.value : config.mode,
      scripts: scripts,
      color: $("color").value,
      background: $("background").value,
      monoEmails: $("monoEmails").checked,
      monoDomains: $("monoDomains").checked,
      warnNonLatinAddress: $("warnNonLatinAddress").checked,
      warnForeignEmails: $("warnForeignEmails").checked,
      warnSender: $("warnSender").checked,
      maxNodes: config.maxNodes
    });
  }

  async function saveNow() {
    config = readForm();
    try {
      await api.storage.local.set({ config: config });
      setStatus("Saved");
      setTimeout(function () {
        setStatus("");
      }, 1200);
    } catch (e) {
      console.error("[GlyphSentry] cannot save settings", e);
      setStatus("Could not save");
    }
  }

  function saveSoon() {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(function () {
      saveTimer = null;
      saveNow();
    }, SAVE_DELAY_MS);
  }

  async function load() {
    let stored = null;
    try {
      const result = await api.storage.local.get("config");
      stored = result ? result.config : null;
    } catch (e) {
      console.error("[GlyphSentry] cannot read settings", e);
    }
    render(scanner.normalizeConfig(stored));
  }

  /* ------------------------------------------------------------------ *
   * Wire up
   * ------------------------------------------------------------------ */

  document.addEventListener("change", function (event) {
    if (event.target.closest("main")) {
      saveSoon();
    }
  });

  document.addEventListener("input", function (event) {
    if (event.target.type === "color") {
      saveSoon();
    }
  });

  $("allScripts").addEventListener("click", function () {
    document.querySelectorAll("#scripts input[data-script]").forEach(function (box) {
      box.checked = true;
    });
    saveSoon();
  });

  $("noScripts").addEventListener("click", function () {
    document.querySelectorAll("#scripts input[data-script]").forEach(function (box) {
      box.checked = false;
    });
    saveSoon();
  });

  $("resetColors").addEventListener("click", function () {
    const defaults = scanner.normalizeConfig(null);
    $("color").value = defaults.color;
    $("background").value = defaults.background;
    saveSoon();
  });

  $("resetAll").addEventListener("click", async function () {
    const defaults = scanner.normalizeConfig(null);
    render(defaults);
    try {
      await api.storage.local.set({ config: defaults });
      setStatus("Defaults restored");
      setTimeout(function () {
        setStatus("");
      }, 1200);
    } catch (e) {
      setStatus("Could not save");
    }
  });

  load();
})();
