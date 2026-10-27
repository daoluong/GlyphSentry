/*
 * Scanner unit tests - plain Node.js, no dependencies.
 *
 *   node tests/scanner.test.js
 */
"use strict";

require("../content/scanner.js");

const S = globalThis.UHScanner;
const assert = require("assert");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok   " + name);
  } catch (error) {
    failures.push({ name, error });
    console.log("  FAIL " + name);
    console.log("       " + error.message.split("\n")[0]);
  }
}

function runs(text, overrides) {
  const config = S.normalizeConfig(Object.assign({ mode: "nonlatin" }, overrides || {}));
  return S.buildRuns(text, config).map(function (run) {
    return {
      text: text.slice(run.start, run.end),
      script: run.script,
      invisible: run.invisible,
      mono: run.mono,
      kind: run.kind,
      nonLatin: run.nonLatin
    };
  });
}

function scripts(text, overrides) {
  return runs(text, overrides).filter(function (run) {
    return run.script;
  });
}

/* 1. Vietnamese ---------------------------------------------------------- */

test("Vietnamese diacritics are Latin and stay clean", function () {
  assert.deepStrictEqual(scripts("Tiếng Việt có dấu: ế ộ đ ữ ỹ"), []);
});

test("Vietnamese address is not treated as an attack", function () {
  assert.deepStrictEqual(scripts("Nguyễn Văn Đức <duc@example.vn>"), []);
});

/* 2. Plain English ------------------------------------------------------- */

test("plain English produces no marks", function () {
  assert.deepStrictEqual(runs("Hello world, nothing to see here."), []);
});

/* 3. Russian / Greek ----------------------------------------------------- */

test("Cyrillic words are marked", function () {
  const found = runs("Привет мир");
  assert.strictEqual(found.length, 2);
  assert.strictEqual(found[0].text, "Привет");
  assert.strictEqual(found[0].script, "cyrillic");
  assert.strictEqual(found[1].text, "мир");
});

test("Greek words are marked", function () {
  const found = scripts("Ελληνικά");
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].script, "greek");
  assert.strictEqual(found[0].text, "Ελληνικά");
});

/* 4. Japanese / Chinese / Korean ----------------------------------------- */

test("Han characters are marked", function () {
  const found = scripts("日本語");
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].script, "han");
});

test("non-BMP Han character stays in one run", function () {
  const found = scripts("\u{2000B}");
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].text, "\u{2000B}");
});

test("Hiragana and Katakana are marked", function () {
  assert.deepStrictEqual(
    scripts("ひらがな").map(function (r) {
      return r.script;
    }),
    ["hiragana"]
  );
  assert.deepStrictEqual(
    scripts("カタカナ").map(function (r) {
      return r.script;
    }),
    ["katakana"]
  );
});

test("Hangul is marked", function () {
  assert.strictEqual(scripts("한국어")[0].script, "hangul");
});

/* 5. Emoji and punctuation ----------------------------------------------- */

test("emoji and punctuation stay clean", function () {
  assert.deepStrictEqual(runs("Great job 😀 — thanks!"), []);
});

/* 6. Homoglyph domains --------------------------------------------------- */

test("Cyrillic inside a Latin word is highlighted in mixed mode", function () {
  const found = runs("раypal.com", { mode: "mixed" });
  assert.deepStrictEqual(found.map(function (r) {
    return r.text;
  }), ["ра", "ypal.com"]);
  assert.strictEqual(found[0].script, "cyrillic");
  assert.strictEqual(found[1].mono, true);
});

test("Greek omicron inside a Latin word is highlighted in mixed mode", function () {
  const found = scripts("microsοft.com", { mode: "mixed" });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].text, "ο");
  assert.strictEqual(found[0].script, "greek");
});

test("mixed mode ignores purely foreign words", function () {
  assert.deepStrictEqual(runs("Привет мир", { mode: "mixed" }), []);
  assert.deepStrictEqual(runs("Ελληνικά", { mode: "mixed" }), []);
});

/* 7. Invisible / bidi controls ------------------------------------------- */

test("bidi override is flagged in security mode only", function () {
  const text = "invoice\u202Efdp.exe";
  const safe = runs(text, { mode: "nonlatin" });
  assert.strictEqual(
    safe.filter(function (r) {
      return r.invisible;
    }).length,
    0
  );

  const found = runs(text, { mode: "security" }).filter(function (r) {
    return r.invisible;
  });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].text, "\u202E");
  assert.strictEqual(found[0].invisible, "U+202E");
});

test("zero width space is flagged in security mode", function () {
  const found = runs("pass\u200Bword", { mode: "security" }).filter(function (r) {
    return r.invisible;
  });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].invisible, "U+200B");
});

test("security mode still highlights non-Latin letters", function () {
  assert.strictEqual(scripts("Привет", { mode: "security" }).length, 1);
});

/* 8. Monospace targets --------------------------------------------------- */

test("email addresses become monospace", function () {
  const found = runs("Write to sales@example.com today");
  assert.deepStrictEqual(found.map(function (r) {
    return r.text;
  }), ["sales@example.com"]);
  assert.strictEqual(found[0].mono, true);
});

test("URLs and bare domains become monospace", function () {
  assert.deepStrictEqual(runs("See https://example.com/path?q=1").map(function (r) {
    return r.text;
  }), ["https://example.com/path?q=1"]);

  assert.deepStrictEqual(runs("Go to www.example.org now").map(function (r) {
    return r.text;
  }), ["www.example.org"]);
});

test("version numbers are not mistaken for domains", function () {
  assert.deepStrictEqual(runs("Version 1.2.3 released."), []);
});

test("monospace can be turned off", function () {
  assert.deepStrictEqual(runs("sales@example.com", { monoEmails: false, monoDomains: false }), []);
});

/* 9. External-domain warnings -------------------------------------------- */

test("email runs are classified as email, links and domains as such", function () {
  assert.strictEqual(runs("a@b.com")[0].kind, "email");
  assert.strictEqual(runs("https://example.com/x")[0].kind, "url");
  assert.strictEqual(runs("example.com")[0].kind, "domain");
});

test("domainOfEmail extracts the domain", function () {
  assert.strictEqual(S.domainOfEmail("sales@example.com"), "example.com");
  assert.strictEqual(S.domainOfEmail("Sales@Example.COM."), "example.com");
  assert.strictEqual(S.domainOfEmail("not-an-address"), null);
  assert.strictEqual(S.domainOfEmail("@example.com"), null);
});

test("isExternalDomain compares domains and sub-domains", function () {
  const known = ["company.com"];
  assert.strictEqual(S.isExternalDomain("company.com", known), false);
  assert.strictEqual(S.isExternalDomain("mail.company.com", known), false);
  assert.strictEqual(S.isExternalDomain("COMPANY.COM", known), false);
  assert.strictEqual(S.isExternalDomain("other.com", known), true);
  assert.strictEqual(S.isExternalDomain("notcompany.com", known), true);
});

test("isExternalDomain never warns without a reference domain", function () {
  assert.strictEqual(S.isExternalDomain("other.com", []), false);
  assert.strictEqual(S.isExternalDomain("other.com", null), false);
});

test("warning options default to on and can be turned off", function () {
  const defaults = S.normalizeConfig(null);
  assert.strictEqual(defaults.warnForeignEmails, true);
  assert.strictEqual(defaults.warnNonLatinAddress, true);
  assert.strictEqual(defaults.warnSender, true);
  const custom = S.normalizeConfig({
    warnForeignEmails: false,
    warnNonLatinAddress: false,
    warnSender: false
  });
  assert.strictEqual(custom.warnForeignEmails, false);
  assert.strictEqual(custom.warnNonLatinAddress, false);
  assert.strictEqual(custom.warnSender, false);
});

/* Non-Latin addresses ---------------------------------------------------- */

test("containsNonLatin ignores Latin, Vietnamese and ASCII punctuation", function () {
  assert.strictEqual(S.containsNonLatin("sales@example.com"), false);
  assert.strictEqual(S.containsNonLatin("nguyễn@example.com"), false);
  assert.strictEqual(S.containsNonLatin("Đức@example.vn"), false);
  assert.strictEqual(S.containsNonLatin("раypal@example.com"), true);
  assert.strictEqual(S.containsNonLatin("user@пример.com"), true);
  assert.strictEqual(S.containsNonLatin("micrοsοft@example.com"), true);
});

test("an address with Cyrillic in the local part is one flagged run", function () {
  const found = runs("pay to раypal@example.com now");
  assert.strictEqual(
    found.map(function (run) {
      return run.text;
    }).join(""),
    "раypal@example.com"
  );
  assert.ok(found.every(function (run) {
    return run.kind === "email" && run.mono && run.nonLatin;
  }));
});

test("an address with a non-Latin domain is flagged", function () {
  const found = runs("user@пример.com");
  assert.strictEqual(
    found.map(function (run) {
      return run.text;
    }).join(""),
    "user@пример.com"
  );
  assert.ok(found.every(function (run) {
    return run.kind === "email" && run.nonLatin;
  }));
});

test("plain and Vietnamese addresses are not flagged as non-Latin", function () {
  assert.strictEqual(runs("sales@example.com")[0].nonLatin, false);
  assert.strictEqual(runs("nguyễn@example.com")[0].nonLatin, false);
});

test("the non-Latin warning can be turned off", function () {
  const found = runs("раypal@example.com", { warnNonLatinAddress: false });
  assert.ok(found.every(function (run) {
    return !run.nonLatin;
  }));
});

test("an address longer than the local-part limit is not matched (no hang)", function () {
  const long = "a".repeat(200) + "@example.com";
  const started = Date.now();
  runs(long);
  assert.ok(Date.now() - started < 500, "address detection is too slow");
});

/* 10. Configuration ------------------------------------------------------ */

test("disabled scripts are not highlighted", function () {
  const found = scripts("Привет Ελληνικά", { scripts: { cyrillic: false, greek: false } });
  assert.deepStrictEqual(found, []);
});

test("normalizeConfig fills defaults and rejects bad values", function () {
  const config = S.normalizeConfig({ mode: "nonsense", color: "red; background: url(x)" });
  assert.strictEqual(config.mode, "nonlatin");
  assert.strictEqual(config.color, S.DEFAULT_CONFIG.color);
  assert.strictEqual(config.monoEmails, true);
  assert.strictEqual(config.maxNodes, S.DEFAULT_CONFIG.maxNodes);
});

/* 11. Size / performance sanity ------------------------------------------ */

test("large Latin text produces no marks quickly", function () {
  const text = ("The quick brown fox jumps over the lazy dog. ").repeat(2000);
  const started = Date.now();
  assert.deepStrictEqual(runs(text), []);
  assert.ok(Date.now() - started < 2000, "scan took too long");
});

/* Summary ---------------------------------------------------------------- */

console.log("");
if (failures.length === 0) {
  console.log("All " + passed + " tests passed.");
} else {
  console.log(passed + " passed, " + failures.length + " failed.");
  process.exitCode = 1;
}
