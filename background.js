/*
 * GlyphSentry - background (Manifest V3 event page).
 *
 * Responsibilities:
 *  - register the message display script / stylesheet
 *  - answer the "what should I highlight here?" question from the message pane
 *  - toggle highlighting for the message that is currently displayed
 *
 * The background never reads message content. The scanner runs inside the
 * message pane and only reports the result of its own work.
 */
"use strict";

const api = globalThis.messenger || globalThis.browser;

const SCRIPT_ID = "glyphsentry";
const SCRIPT_DEF = {
  id: SCRIPT_ID,
  js: ["/content/scanner.js", "/content/highlighter.js"],
  css: ["/content/styles.css"],
  runAt: "document_idle"
};

const STORAGE_CONFIG = "config";
const STORAGE_DISABLED = "disabledMessages";
const DISABLED_LIMIT = 200;

/* ------------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------------ */

// Succeeds only once per background lifetime; a wake-up later on reports
// "already registered", which is exactly what we want.
let registrationDone = false;

async function ensureScripts() {
  if (registrationDone) {
    return;
  }
  registrationDone = true;
  try {
    await api.scripting.messageDisplay.unregisterScripts({ ids: [SCRIPT_ID] });
  } catch (e) {
    /* nothing registered yet */
  }
  try {
    await api.scripting.messageDisplay.registerScripts([SCRIPT_DEF]);
  } catch (e) {
    console.error("[GlyphSentry] unable to register message display scripts", e);
  }
}

ensureScripts();

/* ------------------------------------------------------------------------ *
 * Storage helpers
 * ------------------------------------------------------------------------ */

async function getStoredConfig() {
  try {
    const stored = await api.storage.local.get(STORAGE_CONFIG);
    return stored && stored[STORAGE_CONFIG] ? stored[STORAGE_CONFIG] : null;
  } catch (e) {
    return null;
  }
}

async function getDisabledIds() {
  try {
    const stored = await api.storage.local.get(STORAGE_DISABLED);
    const value = stored && stored[STORAGE_DISABLED];
    return Array.isArray(value) ? value : [];
  } catch (e) {
    return [];
  }
}

function messageKey(message) {
  if (!message) {
    return null;
  }
  if (message.headerMessageId) {
    return String(message.headerMessageId);
  }
  return message.id === undefined || message.id === null ? null : "id:" + message.id;
}

/* ------------------------------------------------------------------------ *
 * Sender and receiving account
 * ------------------------------------------------------------------------ */

const ADDRESS_RE = /[^\s<>()",;:]+@[^\s<>()",;:]+/;

function domainPart(email) {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) {
    return null;
  }
  return email.slice(at + 1).toLowerCase().replace(/\.+$/, "");
}

// MessageHeader.author looks like `Name <user@example.com>` or `user@example.com`.
function parseSender(message) {
  const raw = message && message.author;
  if (!raw) {
    return null;
  }
  const text = String(raw);
  const match = text.match(ADDRESS_RE);
  if (!match) {
    return null;
  }
  const email = match[0].replace(/^mailto:/i, "");
  const domain = domainPart(email);
  if (!domain) {
    return null;
  }
  const name = text.replace(/<[^>]*>/g, "").replace(/"/g, "").trim();
  const scan = globalThis.UHScanner;
  const nonLatin = scan ? scan.containsNonLatin(email) : false;
  return { email: email, domain: domain, name: name, nonLatin: nonLatin };
}

// Domains of every identity of the account the message was delivered to.
async function accountDomainsForMessage(message) {
  const domains = [];
  const folder = message && message.folder;
  if (!folder || !folder.accountId) {
    return domains;
  }
  try {
    const account = await api.accounts.get(folder.accountId);
    const identities = (account && account.identities) || [];
    identities.forEach(function (identity) {
      const email = identity && identity.email;
      const domain = email ? domainPart(String(email)) : null;
      if (domain && domains.indexOf(domain) === -1) {
        domains.push(domain);
      }
    });
  } catch (e) {
    /* no access to the account (e.g. local folders) */
  }
  return domains;
}

/* ------------------------------------------------------------------------ *
 * Context for a tab
 * ------------------------------------------------------------------------ */

async function contextForTab(tabId) {
  const context = {
    config: await getStoredConfig(),
    perMessageEnabled: true,
    hasMessage: false,
    messageKey: null,
    sender: null,
    accountDomains: []
  };

  if (tabId === undefined || tabId === null) {
    return context;
  }

  try {
    const list = await api.messageDisplay.getDisplayedMessages(tabId);
    const message = list && list.messages ? list.messages[0] : null;
    if (message) {
      context.hasMessage = true;
      context.messageKey = messageKey(message);
      context.sender = parseSender(message);
      context.accountDomains = await accountDomainsForMessage(message);
      if (context.messageKey) {
        const disabled = await getDisabledIds();
        context.perMessageEnabled = disabled.indexOf(context.messageKey) === -1;
      }
    }
  } catch (e) {
    /* no message displayed, or the tab is not a mail tab */
  }

  return context;
}

/* ------------------------------------------------------------------------ *
 * Badge
 * ------------------------------------------------------------------------ */

async function updateBadge(tabId) {
  if (tabId === undefined || tabId === null) {
    return;
  }
  try {
    const context = await contextForTab(tabId);
    if (!context.hasMessage) {
      await api.action.setBadgeText({ tabId, text: "" });
      return;
    }
    await api.action.setBadgeText({ tabId, text: context.perMessageEnabled ? "" : "OFF" });
    await api.action.setBadgeBackgroundColor({ tabId, color: "#7a7a7a" });
  } catch (e) {
    /* tab already gone */
  }
}

/* ------------------------------------------------------------------------ *
 * Live re-injection (best effort)
 * ------------------------------------------------------------------------ */

async function reinject(tabId) {
  if (tabId === undefined || tabId === null) {
    return;
  }
  try {
    await api.scripting.executeScript({ target: { tabId }, files: SCRIPT_DEF.js });
  } catch (e) {
    // Keep silent: the message display script also listens to storage changes
    // and re-applies itself without any injection.
  }
}

/* ------------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------------ */

api.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "uh:get-context") {
    const tabId = sender && sender.tab ? sender.tab.id : undefined;
    return contextForTab(tabId);
  }

  if (message.type === "uh:truncated") {
    console.info(
      "[GlyphSentry] scan limit reached, part of this message was not scanned:",
      message.count
    );
    return Promise.resolve({ ok: true });
  }

  return false;
});

api.action.onClicked.addListener(async (tab) => {
  try {
    const context = await contextForTab(tab.id);
    if (!context.hasMessage || !context.messageKey) {
      return;
    }

    const disabled = await getDisabledIds();
    const index = disabled.indexOf(context.messageKey);
    let next;
    if (index === -1) {
      next = disabled.concat(context.messageKey).slice(-DISABLED_LIMIT);
    } else {
      next = disabled.slice(0, index).concat(disabled.slice(index + 1));
    }

    await api.storage.local.set({ [STORAGE_DISABLED]: next });
    await updateBadge(tab.id);
    await reinject(tab.id);
  } catch (e) {
    console.error("[GlyphSentry] toggle failed", e);
  }
});

api.messageDisplay.onMessagesDisplayed.addListener((tab) => {
  updateBadge(tab.id);
});
