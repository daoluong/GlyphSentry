/*
 * GlyphSentry - applies highlights inside the displayed message.
 *
 * Runs as a message display script (see background.js). The original message
 * is never modified: only the rendered DOM of the message pane is touched, and
 * every change is undone with removeAllHighlights().
 *
 * The script is idempotent, because Thunderbird may inject it more than once
 * (registration + explicit re-injection when the toolbar button is clicked).
 */
(function (root) {
  "use strict";

  const api = root.messenger || root.browser;
  const scanner = root.UHScanner;

  if (!api || !scanner) {
    return;
  }

  // Already active in this message pane: just refresh the existing instance.
  if (root.__uhHighlighter) {
    root.__uhHighlighter.refresh();
    return;
  }

  const SKIP_TAGS = {
    SCRIPT: true,
    STYLE: true,
    TEXTAREA: true,
    INPUT: true,
    SELECT: true,
    OPTION: true,
    NOSCRIPT: true,
    TITLE: true,
    HEAD: true,
    IFRAME: true,
    OBJECT: true,
    EMBED: true,
    CANVAS: true,
    SVG: true,
    MATH: true
  };

  const CONTEXT_TIMEOUT_MS = 2000;
  const REFRESH_DEBOUNCE_MS = 80;

  const state = {
    config: scanner.normalizeConfig(null),
    perMessageEnabled: true,
    accountDomains: [],
    sender: null,
    applying: false,
    queued: false,
    refreshTimer: null,
    truncated: false
  };

  /* ------------------------------------------------------------------ *
   * Configuration
   * ------------------------------------------------------------------ */

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        reject(new Error("timeout"));
      }, ms);
      Promise.resolve(promise).then(
        function (value) {
          clearTimeout(timer);
          resolve(value);
        },
        function (error) {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  async function readLocalConfig() {
    try {
      if (!api.storage || !api.storage.local) {
        return null;
      }
      const stored = await api.storage.local.get("config");
      return stored ? stored.config : null;
    } catch (e) {
      return null;
    }
  }

  async function readContext() {
    let config = null;
    let perMessageEnabled = true;
    let accountDomains = [];
    let sender = null;

    try {
      const response = await withTimeout(
        api.runtime.sendMessage({ type: "uh:get-context" }),
        CONTEXT_TIMEOUT_MS
      );
      if (response && typeof response === "object") {
        if (response.config) {
          config = response.config;
        }
        perMessageEnabled = response.perMessageEnabled !== false;
        if (Array.isArray(response.accountDomains)) {
          accountDomains = response.accountDomains.filter(function (domain) {
            return typeof domain === "string" && domain.length > 0;
          });
        }
        if (response.sender && typeof response.sender === "object" && response.sender.email) {
          sender = response.sender;
        }
      }
    } catch (e) {
      /* background asleep or message script without messaging support */
    }

    if (!config) {
      config = await readLocalConfig();
    }

    return {
      config: scanner.normalizeConfig(config),
      perMessageEnabled: perMessageEnabled,
      accountDomains: accountDomains,
      sender: sender
    };
  }

  /* ------------------------------------------------------------------ *
   * DOM helpers
   * ------------------------------------------------------------------ */

  function applyCssVariables(config) {
    const style = document.documentElement.style;
    style.setProperty("--uh-fg", config.color);
    style.setProperty("--uh-bg", config.background);
  }

  function removeAllHighlights() {
    const banner = document.querySelectorAll("[data-uh-banner]");
    for (let i = 0; i < banner.length; i++) {
      if (banner[i].parentNode) {
        banner[i].parentNode.removeChild(banner[i]);
      }
    }

    const spans = document.querySelectorAll("span[data-uh]");
    if (spans.length === 0) {
      document.documentElement.removeAttribute("data-uh-applied");
      return;
    }
    const parents = new Set();
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      const parent = span.parentNode;
      if (!parent) {
        continue;
      }
      parent.replaceChild(document.createTextNode(span.textContent), span);
      parents.add(parent);
    }
    parents.forEach(function (parent) {
      try {
        parent.normalize();
      } catch (e) {
        /* detached node */
      }
    });
    document.documentElement.removeAttribute("data-uh-applied");
  }

  function collectTextNodes(container, limit) {
    const nodes = [];
    if (!container) {
      return nodes;
    }

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (SKIP_TAGS[node.tagName]) {
            return NodeFilter.FILTER_REJECT;
          }
          if (node.hasAttribute("data-uh") || node.hasAttribute("data-uh-skip")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node = walker.nextNode();
    while (node) {
      if (node.nodeValue && node.nodeValue.length > 0) {
        nodes.push(node);
      }
      if (nodes.length >= limit) {
        state.truncated = true;
        break;
      }
      node = walker.nextNode();
    }
    return nodes;
  }

  function createSpan(run, text) {
    const span = document.createElement("span");
    let className = "";

    if (run.script) {
      span.setAttribute("data-uh-script", run.script);
      className += "uh-rune ";
    }
    if (run.invisible) {
      span.setAttribute("data-uh-invisible", run.invisible);
      span.setAttribute("data-uh-label", run.invisible);
      className += "uh-invisible ";
    }
    if (run.mono) {
      className += "uh-mono ";
      if (run.kind) {
        span.setAttribute("data-uh-kind", run.kind);
      }
    }
    if (run.nonLatin) {
      span.setAttribute("data-uh-nonlatin", "1");
    }

    span.className = className.trim();
    span.setAttribute("data-uh", "1");
    span.textContent = text.slice(run.start, run.end);
    return span;
  }

  function highlightTextNode(node, config) {
    const text = node.nodeValue;
    if (!text) {
      return false;
    }
    if (!scanner.mightMatch(text, config.monoEmails || config.monoDomains)) {
      return false;
    }

    const runs = scanner.buildRuns(text, config);
    if (runs.length === 0) {
      return false;
    }

    const fragment = document.createDocumentFragment();
    let position = 0;
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (run.start > position) {
        fragment.appendChild(document.createTextNode(text.slice(position, run.start)));
      }
      fragment.appendChild(createSpan(run, text));
      position = run.end;
    }
    if (position < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(position)));
    }

    if (!node.parentNode) {
      return false;
    }
    node.parentNode.replaceChild(fragment, node);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Apply
   * ------------------------------------------------------------------ */

  function scanDocument(config) {
    const body = document.body;
    if (!body) {
      return 0;
    }
    const nodes = collectTextNodes(body, config.maxNodes);
    let changed = 0;
    for (let i = 0; i < nodes.length; i++) {
      try {
        if (highlightTextNode(nodes[i], config)) {
          changed++;
        }
      } catch (e) {
        console.error("[GlyphSentry] cannot process a text node", e);
      }
    }
    if (changed > 0) {
      document.documentElement.setAttribute("data-uh-applied", String(changed));
    }
    return changed;
  }

  /* ------------------------------------------------------------------ *
   * Warnings: addresses and sender outside the receiving account's domain
   * ------------------------------------------------------------------ */

  function domainListLabel(domains) {
    const shown = domains.slice(0, 3).join(", ");
    return domains.length > 3 ? shown + " and " + (domains.length - 3) + " more" : shown;
  }

  function addClass(span, name) {
    if (!new RegExp("\\b" + name + "\\b").test(span.className)) {
      span.className = (span.className + " " + name).trim();
    }
  }

  // Groups the spans of one address (an address can be split into several spans
  // because its foreign letters are also highlighted) and puts the warning
  // markers on the last span of each group, so a single badge is shown.
  function markAddressWarnings(config, domains) {
    if (!config.warnForeignEmails && !config.warnNonLatinAddress) {
      return;
    }
    const spans = document.querySelectorAll('span[data-uh-kind="email"]');
    let group = [];

    function flush() {
      if (group.length === 0) {
        return;
      }
      const text = group.map(function (span) {
        return span.textContent;
      }).join("");
      const last = group[group.length - 1];
      const titles = [];
      let warnExternal = false;
      let warnNonLatin = false;

      if (config.warnNonLatinAddress) {
        warnNonLatin = group.some(function (span) {
          return span.hasAttribute("data-uh-nonlatin");
        });
        if (warnNonLatin) {
          titles.push("This address contains non-Latin characters");
        }
      }

      if (config.warnForeignEmails && domains.length > 0) {
        const domain = scanner.domainOfEmail(text);
        warnExternal = !!domain && scanner.isExternalDomain(domain, domains);
        if (warnExternal) {
          titles.push(
            domain + " is not one of your domains (" + domainListLabel(domains) + ")"
          );
        }
      }

      if (warnExternal) {
        group.forEach(function (span) {
          addClass(span, "uh-ext");
        });
      }
      if (warnNonLatin) {
        group.forEach(function (span) {
          addClass(span, "uh-badaddr");
        });
      }
      if (titles.length > 0) {
        // The icon is emitted by ::after on the last span only, so an address
        // split into several spans still shows a single badge.
        addClass(last, "uh-warn");
        last.setAttribute("title", titles.join(" \u00B7 "));
      }
      group = [];
    }

    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      const previous = group[group.length - 1];
      if (previous) {
        const parent = span.parentNode;
        const adjacent =
          parent &&
          parent === previous.parentNode &&
          indexOfChild(parent, span) === indexOfChild(parent, previous) + 1;
        if (!adjacent) {
          flush();
        }
      }
      group.push(span);
    }
    flush();
  }

  function indexOfChild(parent, node) {
    for (let i = 0; i < parent.childNodes.length; i++) {
      if (parent.childNodes[i] === node) {
        return i;
      }
    }
    return -1;
  }

  function senderReasons(sender, domains, config) {
    const reasons = [];
    if (config.warnNonLatinAddress && sender.nonLatin) {
      reasons.push("its address contains non-Latin characters");
    }
    if (sender.domain && scanner.isExternalDomain(sender.domain, domains)) {
      reasons.push(
        sender.domain + " is not one of your domains (" + domainListLabel(domains) + ")"
      );
    }
    return reasons;
  }

  function buildSenderBanner(sender, reasons) {
    const bar = document.createElement("div");
    bar.className = "uh-banner";
    bar.setAttribute("data-uh-banner", "1");
    bar.setAttribute("data-uh-skip", "1");
    bar.setAttribute("dir", "auto");

    const icon = document.createElement("span");
    icon.className = "uh-banner-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "\u26A0\uFE0E";

    const body = document.createElement("span");
    body.appendChild(document.createTextNode("This message comes from "));

    const address = document.createElement("span");
    address.className = sender.nonLatin ? "uh-mono uh-badaddr" : "uh-mono";
    address.textContent = sender.email;

    const tail = document.createElement("span");
    tail.textContent = reasons.join(" \u00B7 ");
    tail.className = "uh-banner-tail";

    body.append(address, document.createTextNode(" \u2014 "), tail);
    bar.append(icon, body);
    return bar;
  }

  function applyWarnings(config) {
    const domains = state.accountDomains;
    markAddressWarnings(config, domains);

    const sender = state.sender;
    if (!config.warnSender || !sender || !document.body) {
      return;
    }
    const reasons = senderReasons(sender, domains, config);
    if (reasons.length > 0) {
      document.body.insertBefore(buildSenderBanner(sender, reasons), document.body.firstChild);
    }
  }

  function apply() {
    if (state.applying) {
      state.queued = true;
      return;
    }
    state.applying = true;
    try {
      removeAllHighlights();
      state.truncated = false;

      const config = state.config;
      applyCssVariables(config);

      if (!config.enabled || !state.perMessageEnabled) {
        return;
      }
      scanDocument(config);
      applyWarnings(config);

      if (state.truncated) {
        try {
          api.runtime.sendMessage({ type: "uh:truncated", count: config.maxNodes });
        } catch (e) {
          /* ignore */
        }
      }
    } catch (e) {
      console.error("[GlyphSentry] apply failed", e);
    } finally {
      state.applying = false;
      if (state.queued) {
        state.queued = false;
        setTimeout(apply, 0);
      }
    }
  }

  async function refresh() {
    const context = await readContext();
    state.config = context.config;
    state.perMessageEnabled = context.perMessageEnabled;
    state.accountDomains = context.accountDomains;
    state.sender = context.sender;
    apply();
  }

  function scheduleRefresh() {
    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
    }
    state.refreshTimer = setTimeout(function () {
      state.refreshTimer = null;
      refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  function boot() {
    if (document.body) {
      refresh();
    } else {
      document.addEventListener(
        "DOMContentLoaded",
        function () {
          refresh();
        },
        { once: true }
      );
    }

    // Message content can still be added after document_idle (remote images,
    // plain text conversion, ...). One late pass covers that without a
    // page-wide MutationObserver.
    if (document.readyState !== "complete") {
      window.addEventListener("load", scheduleRefresh, { once: true });
    }

    try {
      if (api.storage && api.storage.onChanged) {
        api.storage.onChanged.addListener(function (changes, area) {
          if (area !== "local") {
            return;
          }
          if (!changes.config && !changes.disabledMessages) {
            return;
          }
          scheduleRefresh();
        });
      }
    } catch (e) {
      /* storage unavailable in this context */
    }
  }

  root.__uhHighlighter = {
    refresh: function () {
      return refresh();
    },
    remove: function () {
      removeAllHighlights();
    },
    state: state
  };

  boot();
})(typeof globalThis !== "undefined" ? globalThis : this);
