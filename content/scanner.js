/*
 * GlyphSentry - pure Unicode scanner.
 *
 * No DOM access at all: this file is shared by the message display script and
 * by the options page (which uses SCRIPT_DEFS to render the script list).
 *
 * The scanner does not decide *how* something is displayed. It returns runs of
 * characters together with flags:
 *   { start, end, script, invisible, mono }
 *
 *   script    - key of the non-Latin script that must be highlighted
 *   invisible - label of an invisible / bidi control character (U+XXXX)
 *   mono      - the run is part of an email address, URL or domain name
 */
(function (root) {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Scripts
   * ------------------------------------------------------------------ */

  // [key, label, sample]. The key capitalised is the Unicode Script value.
  const RAW_SCRIPTS = [
    ["greek", "Greek", "Ελληνικά"],
    ["cyrillic", "Cyrillic", "Кириллица"],
    ["arabic", "Arabic", "العربية"],
    ["hebrew", "Hebrew", "עברית"],
    ["armenian", "Armenian", "Հայերեն"],
    ["georgian", "Georgian", "ქართული"],
    ["devanagari", "Devanagari", "देवनागरी"],
    ["thai", "Thai", "ไทย"],
    ["han", "Han (Chinese / Japanese)", "漢字"],
    ["hiragana", "Hiragana", "ひらがな"],
    ["katakana", "Katakana", "カタカナ"],
    ["hangul", "Hangul (Korean)", "한국어"]
  ];

  const SCRIPT_DEFS = RAW_SCRIPTS.map(function (row) {
    const key = row[0];
    const prop = "\\p{Script=" + key.charAt(0).toUpperCase() + key.slice(1) + "}";
    return {
      key: key,
      label: row[1],
      sample: row[2],
      prop: prop,
      re: new RegExp("^" + prop + "$", "u")
    };
  });

  const DEFAULT_SCRIPTS = {};
  SCRIPT_DEFS.forEach(function (def) {
    DEFAULT_SCRIPTS[def.key] = true;
  });

  const MODES = ["nonlatin", "mixed", "security"];

  const DEFAULT_CONFIG = {
    enabled: true,
    mode: "nonlatin",
    scripts: DEFAULT_SCRIPTS,
    color: "#b3261e",
    background: "#ffe1e1",
    monoEmails: true,
    monoDomains: true,
    warnForeignEmails: true,
    warnNonLatinAddress: true,
    warnSender: true,
    maxNodes: 15000
  };

  /* ------------------------------------------------------------------ *
   * Invisible / control characters
   * ------------------------------------------------------------------ */

  const INVISIBLE = (function () {
    const map = new Map();
    function add(code, kind) {
      map.set(code, kind);
    }
    add(0x061c, "bidi"); // ALM
    add(0x200e, "bidi"); // LRM
    add(0x200f, "bidi"); // RLM
    [0x202a, 0x202b, 0x202c, 0x202d, 0x202e].forEach(function (code) {
      add(code, "bidi");
    });
    [0x2066, 0x2067, 0x2068, 0x2069].forEach(function (code) {
      add(code, "bidi");
    });
    add(0x00ad, "invisible"); // soft hyphen
    add(0x034f, "invisible"); // combining grapheme joiner
    add(0x180e, "invisible"); // mongolian vowel separator
    [0x200b, 0x200c, 0x200d].forEach(function (code) {
      add(code, "invisible");
    });
    [0x2060, 0x2061, 0x2062, 0x2063, 0x2064].forEach(function (code) {
      add(code, "invisible");
    });
    add(0xfeff, "invisible"); // zero width no-break space / BOM
    return map;
  })();

  function hexLabel(code) {
    let hex = code.toString(16).toUpperCase();
    while (hex.length < 4) {
      hex = "0" + hex;
    }
    return "U+" + hex;
  }

  function invisibleAt(text, index) {
    const code = text.codePointAt(index);
    if (code === undefined) {
      return null;
    }
    const kind = INVISIBLE.get(code);
    if (kind) {
      return { kind: kind, label: hexLabel(code), length: code > 0xffff ? 2 : 1 };
    }
    // Unicode tag characters: invisible by design, used to smuggle text.
    if (code >= 0xe0000 && code <= 0xe007f) {
      return { kind: "tag", label: hexLabel(code), length: 2 };
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Address / domain detection (the monospace part)
   * ------------------------------------------------------------------ */

  // Unicode-aware on purpose: an address such as `раypal@example.com` must be
  // captured whole, otherwise the Latin tail looks like an innocent address.
  // Bounded quantifiers + lookbehind keep the scan linear on long text.
  const EMAIL_RE =
    /(?<![\p{L}\p{M}\p{N}._%+'-])[\p{L}\p{M}\p{N}._%+'-]{1,64}@(?:[\p{L}\p{M}\p{N}-]{1,63}\.){1,8}[\p{L}]{2,24}/gu;
  const URL_RE = /\b(?:https?|ftp):\/\/[^\s<>"'`]+/gi;
  // Bounded quantifiers on purpose: no catastrophic backtracking on long text.
  const DOMAIN_RE = /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}\b/g;

  // Anything that is not Latin/Common/Inherited inside an address is suspicious:
  // a Cyrillic `а` or a Greek `ο` can make `раypal.com` look like `paypal.com`.
  const NON_LATIN_RE = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

  const TRAILING_PUNCTUATION = ".,;:!?)]}'\">";
  const MIN_MONO_LENGTH = 4;

  function trimTrailing(text, start, end) {
    let stop = end;
    while (stop > start && TRAILING_PUNCTUATION.indexOf(text.charAt(stop - 1)) !== -1) {
      stop--;
    }
    return stop;
  }

  function addMonoRanges(text, re, marks, kind, opts) {
    if (text.length > 100000) {
      // Extremely long single text node: skip address detection, keep it cheap.
      return;
    }
    const checkNonLatin = !opts || opts.warnNonLatinAddress !== false;
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const start = match.index;
      const end = trimTrailing(text, start, start + match[0].length);
      if (end - start >= MIN_MONO_LENGTH) {
        const flags = { mono: true, kind: kind };
        if (checkNonLatin && containsNonLatin(text.slice(start, end))) {
          flags.nonLatin = true;
        }
        markRange(marks, start, end, flags);
      }
    }
  }

  // True when the text contains at least one letter outside the Latin script.
  function containsNonLatin(text) {
    return typeof text === "string" && NON_LATIN_RE.test(text);
  }

  // Domain of an email address ("sales@example.com" -> "example.com").
  function domainOfEmail(text) {
    if (typeof text !== "string") {
      return null;
    }
    const at = text.lastIndexOf("@");
    if (at < 1 || at === text.length - 1) {
      return null;
    }
    return text.slice(at + 1).toLowerCase().replace(/\.+$/, "");
  }

  // True when the domain is neither a known domain nor one of its sub-domains.
  function isExternalDomain(domain, knownDomains) {
    if (!domain || !knownDomains || knownDomains.length === 0) {
      return false;
    }
    const target = String(domain).toLowerCase();
    for (let i = 0; i < knownDomains.length; i++) {
      const known = String(knownDomains[i] || "").toLowerCase();
      if (!known) {
        continue;
      }
      if (target === known || target.slice(-(known.length + 1)) === "." + known) {
        return false;
      }
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  function isTokenBreak(code) {
    if (code <= 0x20) {
      return true;
    }
    if (code >= 0x2000 && code <= 0x200a) {
      return true;
    }
    switch (code) {
      case 0x00a0:
      case 0x002c: // ,
      case 0x003b: // ;
      case 0x003a: // :
      case 0x0022: // "
      case 0x0027: // '
      case 0x0028:
      case 0x0029:
      case 0x005b:
      case 0x005d:
      case 0x007b:
      case 0x007d:
      case 0x003c:
      case 0x003e:
        return true;
      default:
        return false;
    }
  }

  // Returns a function telling whether the token around an index also contains
  // ASCII Latin letters - i.e. "раypal.com" is a mixed-script token.
  function makeTokenTester(text) {
    const cache = new Map();
    return function (index) {
      let start = index;
      while (start > 0 && !isTokenBreak(text.charCodeAt(start - 1))) {
        start--;
      }
      const cached = cache.get(start);
      if (cached !== undefined) {
        return cached;
      }
      let end = start;
      while (end < text.length && !isTokenBreak(text.charCodeAt(end))) {
        end++;
      }
      const mixed = /[A-Za-z]/.test(text.slice(start, end));
      cache.set(start, mixed);
      return mixed;
    };
  }

  function markRange(marks, start, end, flags) {
    for (let i = start; i < end; i++) {
      let current = marks.get(i);
      if (!current) {
        current = {};
        marks.set(i, current);
      }
      if (flags.script) {
        current.script = flags.script;
      }
      if (flags.invisible) {
        current.invisible = flags.invisible;
      }
      if (flags.mono) {
        current.mono = true;
      }
      if (flags.kind && !current.kind) {
        current.kind = flags.kind;
      }
      if (flags.nonLatin) {
        current.nonLatin = true;
      }
    }
  }

  const combinedCache = new Map();

  function combinedRegexFor(defs) {
    const signature = defs.map(function (def) {
      return def.key;
    }).join(",");
    let re = combinedCache.get(signature);
    if (!re) {
      re = new RegExp("[" + defs.map(function (def) {
        return def.prop;
      }).join("") + "]", "gu");
      combinedCache.set(signature, re);
    }
    return re;
  }

  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */

  function normalizeConfig(raw) {
    const out = {
      enabled: DEFAULT_CONFIG.enabled,
      mode: DEFAULT_CONFIG.mode,
      scripts: Object.assign({}, DEFAULT_SCRIPTS),
      color: DEFAULT_CONFIG.color,
      background: DEFAULT_CONFIG.background,
      monoEmails: DEFAULT_CONFIG.monoEmails,
      monoDomains: DEFAULT_CONFIG.monoDomains,
      warnForeignEmails: DEFAULT_CONFIG.warnForeignEmails,
      warnNonLatinAddress: DEFAULT_CONFIG.warnNonLatinAddress,
      warnSender: DEFAULT_CONFIG.warnSender,
      maxNodes: DEFAULT_CONFIG.maxNodes
    };

    if (!raw || typeof raw !== "object") {
      return out;
    }

    if (typeof raw.enabled === "boolean") {
      out.enabled = raw.enabled;
    }
    if (MODES.indexOf(raw.mode) !== -1) {
      out.mode = raw.mode;
    }
    if (raw.scripts && typeof raw.scripts === "object") {
      SCRIPT_DEFS.forEach(function (def) {
        if (typeof raw.scripts[def.key] === "boolean") {
          out.scripts[def.key] = raw.scripts[def.key];
        }
      });
    }
    out.color = validColor(raw.color, DEFAULT_CONFIG.color);
    out.background = validColor(raw.background, DEFAULT_CONFIG.background);
    if (typeof raw.monoEmails === "boolean") {
      out.monoEmails = raw.monoEmails;
    }
    if (typeof raw.monoDomains === "boolean") {
      out.monoDomains = raw.monoDomains;
    }
    if (typeof raw.warnForeignEmails === "boolean") {
      out.warnForeignEmails = raw.warnForeignEmails;
    }
    if (typeof raw.warnNonLatinAddress === "boolean") {
      out.warnNonLatinAddress = raw.warnNonLatinAddress;
    }
    if (typeof raw.warnSender === "boolean") {
      out.warnSender = raw.warnSender;
    }
    if (typeof raw.maxNodes === "number" && isFinite(raw.maxNodes)) {
      out.maxNodes = Math.max(1000, Math.min(200000, Math.round(raw.maxNodes)));
    }
    return out;
  }

  function validColor(value, fallback) {
    if (typeof value !== "string") {
      return fallback;
    }
    const trimmed = value.trim();
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed) ? trimmed : fallback;
  }

  function mightMatch(text, allowMono) {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 0x7e) {
        return true;
      }
      if (allowMono && (code === 0x40 || code === 0x2e || code === 0x2f)) {
        return true;
      }
    }
    return false;
  }

  function buildRuns(text, config) {
    if (!text) {
      return [];
    }
    const cfg = config || DEFAULT_CONFIG;
    const marks = new Map();

    if (cfg.monoEmails) {
      addMonoRanges(text, EMAIL_RE, marks, "email", cfg);
    }
    if (cfg.monoDomains) {
      addMonoRanges(text, URL_RE, marks, "url", cfg);
      addMonoRanges(text, DOMAIN_RE, marks, "domain", cfg);
    }

    const scripts = cfg.scripts || DEFAULT_SCRIPTS;
    const active = SCRIPT_DEFS.filter(function (def) {
      return scripts[def.key] !== false;
    });

    if (active.length > 0) {
      const combined = combinedRegexFor(active);
      const tokenTester = cfg.mode === "mixed" ? makeTokenTester(text) : null;
      combined.lastIndex = 0;
      let match;
      while ((match = combined.exec(text)) !== null) {
        const char = match[0];
        const start = match.index;
        let def = null;
        for (let i = 0; i < active.length; i++) {
          if (active[i].re.test(char)) {
            def = active[i];
            break;
          }
        }
        if (!def) {
          continue;
        }
        if (tokenTester && !tokenTester(start)) {
          continue;
        }
        markRange(marks, start, start + char.length, { script: def.key });
      }
    }

    if (cfg.mode === "security") {
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) < 0x061c) {
          continue;
        }
        const info = invisibleAt(text, i);
        if (info) {
          markRange(marks, i, i + info.length, { invisible: info.label });
          i += info.length - 1;
        }
      }
    }

    return marksToRuns(marks);
  }

  function marksToRuns(marks) {
    if (marks.size === 0) {
      return [];
    }
    const indices = Array.from(marks.keys()).sort(function (a, b) {
      return a - b;
    });
    const runs = [];
    let current = null;
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      const mark = marks.get(index);
      const key =
        (mark.script || "") +
        "|" +
        (mark.invisible || "") +
        "|" +
        (mark.mono ? "1" : "0") +
        "|" +
        (mark.kind || "") +
        "|" +
        (mark.nonLatin ? "1" : "0");
      if (current && current.end === index && current.key === key) {
        current.end = index + 1;
        continue;
      }
      current = {
        start: index,
        end: index + 1,
        key: key,
        script: mark.script || null,
        invisible: mark.invisible || null,
        mono: mark.mono === true,
        kind: mark.kind || null,
        nonLatin: mark.nonLatin === true
      };
      runs.push(current);
    }
    return runs;
  }

  root.UHScanner = {
    SCRIPT_DEFS: SCRIPT_DEFS,
    MODES: MODES,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    normalizeConfig: normalizeConfig,
    mightMatch: mightMatch,
    buildRuns: buildRuns,
    domainOfEmail: domainOfEmail,
    isExternalDomain: isExternalDomain,
    containsNonLatin: containsNonLatin
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
