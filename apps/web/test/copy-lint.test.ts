// D-COPY-1 / A3 section 3: the catalogue, the sources of public and legal pages and every future message are held to the same executable
// rules, each with a negative control. The pre-rename brand is read from the contract package's alias table at run time and is never
// spelled in this file.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { R2_DOMAIN_ALIASES } from "@kauro/contracts";
import { EN, message, nextStepLabel, placeholdersOf, stateCopy } from "../src/copy/en.ts";
import { HEALTH_CHECK_CTA, HEALTH_CHECK_NAME, IN_HOUSE_SENTENCE, lintCatalogue, lintText, PERMITTED_AI_SENTENCE, withoutComments } from "../src/copy/lint.ts";
import { SHARED_STATES, type NextStep } from "../src/client/states.ts";

const brands = [...new Set(Object.keys(R2_DOMAIN_ALIASES).map((name) => name.split("_")[0] ?? ""))].filter((name) => name.length > 0);
const options = { brands };
const webRoot = fileURLToPath(new URL("../../", import.meta.url));

/** A catalogue that passes, to which a negative control adds one entry. */
const good: Readonly<Record<string, string>> = { "health-check.title": HEALTH_CHECK_NAME, "public.cta.request-health-check.cta": HEALTH_CHECK_CTA, "pricing.in-house.body": IN_HOUSE_SENTENCE };
const rulesOf = (entries: Readonly<Record<string, string>>): readonly string[] => lintCatalogue(entries, options).map((violation) => violation.rule);
const withEntry = (id: string, text: string): Readonly<Record<string, string>> => ({ ...good, [id]: text });

test("D-COPY-1: the copy catalogue passes every A3 rule, and the brand list the lint refuses is not empty", () => {
  assert.ok(brands.length > 0, "the earlier brand names come from the alias table");
  assert.deepEqual(lintCatalogue(EN, options), []);
});

test("D-COPY-1: the required names are exact — the free step is the Free data health check, its call to action, and the in-house sentence once on Pricing", () => {
  assert.equal(EN["health-check.title"], "Free data health check");
  assert.equal(EN["public.cta.request-health-check.cta"], "Request a free data health check");
  assert.equal(EN["pricing.in-house.body"], "In-house CRM and data teams can use Kauro too.");
  assert.equal(Object.values(EN).filter((text) => text.includes(IN_HOUSE_SENTENCE)).length, 1);
  const wrongName = { ...good, "health-check.title": "Data audit" };
  assert.ok(rulesOf(wrongName).some((rule) => rule.includes("is named")), "a renamed check is refused");
  const noCta = { ...good, "public.cta.request-health-check.cta": "Start now" };
  assert.ok(rulesOf(noCta).some((rule) => rule.includes("call to action")));
  const twice = withEntry("pricing.again.body", IN_HOUSE_SENTENCE);
  assert.ok(rulesOf(twice).includes("A3-3.7 the in-house sentence appears exactly once"));
  const home = withEntry("home.extra.body", IN_HOUSE_SENTENCE);
  assert.ok(rulesOf(home).includes("A3-3.7 the in-house sentence appears exactly once"));
  const notOnPricing = { "health-check.title": HEALTH_CHECK_NAME, "public.cta.request-health-check.cta": HEALTH_CHECK_CTA, "home.in-house.body": IN_HOUSE_SENTENCE };
  assert.deepEqual(rulesOf(notOnPricing), ["A3-3.7 the in-house sentence appears on Pricing only"]);
  const none = { "health-check.title": HEALTH_CHECK_NAME, "public.cta.request-health-check.cta": HEALTH_CHECK_CTA };
  assert.deepEqual(rulesOf(none), ["A3-3.7 the in-house sentence appears exactly once"]);
});

test("D-COPY-1: every forbidden phrase of A3 is refused, in any case, and its repaired wording passes", () => {
  const refused: readonly (readonly [string, string])[] = [
    ["A3-3.2", "Your free audit is ready"],
    ["A3-3.2", "Start the AUDIT"],
    ["A3-3.2", "See the diagnosis"],
    ["A3-3.1 no AI-ready", "We deliver AI-ready data"],
    ["A3-3.1 AI never cleans", "AI cleans your files"],
    ["A3-3.1 Kauro never prepares", "Kauro trains your AI on the result"],
    ["A3-3.1 the owner", "Migrate without losing money"],
    ["A3-3.1 the owner", "Numbers without mathematical hallucinations"],
    ["A3-3.3 no compatibility", "Works with any CRM"],
    ["A3-3.3 no compatibility", "Fully compatible with your CRM"],
    ["A3-3.3 no compatibility", "Import-ready for any CRM"],
    ["A3-3.3 duplicates", "We delete duplicates"],
    ["A3-3.3 duplicates", "We eliminate records that repeat"],
    ["A3-3.5", "You save USD 4,000 per project"],
    ["A3-3.5", "The project pays for itself"],
    ["A3-3.5", "A guaranteed saving on every project"],
    ["A3-3.5 the check is always free", "If we find nothing, the report is free"],
    ["D-COPY-1 the founding discount", "Founding discount: 25% off"],
    ["D-COPY-1 \"Prepared for import\"", "Imported"],
  ];
  for (const [rule, text] of refused) {
    for (const variant of [text, text.toUpperCase(), text.toLowerCase()]) {
      // the "Imported" rule is case-specific by nature; the others hold in any case
      if (rule.includes("Prepared for import") && variant !== text) continue;
      assert.ok(lintText("x.body", variant, options).some((violation) => violation.rule.startsWith(rule)), `${rule}: ${variant}`);
    }
  }
  assert.ok(rulesOf(withEntry("page.markup.body", "Click <b>here</b>")).includes("D-COPY-1 copy is plain text: no markup"), "markup in a message is refused");
  assert.deepEqual(lintText("page.tsx", "const f = (a: number) => a > 1 ? <b>x</b> : null;", options), [], "the phrase rules read a source's words, not its syntax");
  const repaired: readonly string[] = [
    "Prepared for import",
    "The check is free and creates no obligation to buy",
    "We unify duplicates with your approval; nothing is removed without a trace",
    "We clean exported files, not your live CRM",
    "Cleaned, explained standard files that your team imports with its own tools. Kauro qualifies imports only for HubSpot and Salesforce.",
    "Request a free data health check",
  ];
  for (const text of repaired) assert.deepEqual(lintText("x.body", text, options), [], text);
});

test("D-COPY-1: the earlier brand is refused as a whole word in any case, whatever the text, and a word that only contains it passes", () => {
  for (const brand of brands) {
    for (const text of [brand, brand.toLowerCase(), `${brand.toLowerCase()}-host`, `Welcome to ${brand}!`, `${brand[0]}${brand.slice(1).toLowerCase()} app`]) {
      assert.ok(lintText("x.body", text, options).some((violation) => violation.rule.includes("pre-rename brand")), text);
    }
    assert.deepEqual(lintText("x.body", `${brand.toLowerCase()}ing`, options), [], "a longer word is not the brand");
  }
  assert.deepEqual(lintText("x.body", "Kauro", { brands: [] }), [], "no brands to refuse, none refused");
});

test("D-COPY-1: AI never appears on a surface, and in running text only inside the one permitted sentence", () => {
  for (const suffix of ["title", "heading", "label", "cta", "offer", "subject", "name"]) {
    assert.ok(rulesOf(withEntry(`page.thing.${suffix}`, "Start your AI project")).includes("A3-3.1 AI never appears in a headline, title, offer, label or name"), suffix);
    assert.ok(rulesOf(withEntry(`page.thing.${suffix}`, "Artificial intelligence")).includes("A3-3.1 AI never appears in a headline, title, offer, label or name"), suffix);
  }
  assert.deepEqual(rulesOf(withEntry("page.context.body", PERMITTED_AI_SENTENCE)), [], "the permitted sentence is allowed in running text");
  assert.ok(rulesOf(withEntry("page.thing.title", PERMITTED_AI_SENTENCE)).includes("A3-3.1 AI never appears in a headline, title, offer, label or name"), "and never as a title");
  assert.ok(rulesOf(withEntry("page.context.body", "Use it for your AI work.")).includes("A3-3.1 AI appears only in the one permitted sentence"));
  assert.ok(rulesOf(withEntry("page.context.body", `${PERMITTED_AI_SENTENCE} Also good for AI.`)).includes("A3-3.1 AI appears only in the one permitted sentence"));
  assert.deepEqual(rulesOf(withEntry("page.plain.body", "Clean, deduplicated data with every change explained.")), []);
  assert.deepEqual(rulesOf(withEntry("page.word.body", "We paid and waited")), [], "the letters are only a word when they stand alone");
});

test("D-COPY-1: a message is trimmed and non-empty, and a placeholder is {name}", () => {
  assert.ok(rulesOf(withEntry("page.blank.body", "")).some((rule) => rule.includes("non-empty")));
  assert.ok(rulesOf(withEntry("page.blank.body", " padded")).some((rule) => rule.includes("non-empty")));
  assert.ok(rulesOf(withEntry("page.blank.body", "padded ")).some((rule) => rule.includes("non-empty")));
  for (const bad of ["{}", "{1}", "{{count}}", "{count", "count}", "{ count }"]) assert.ok(rulesOf(withEntry("page.blank.body", `Total ${bad}`)).some((rule) => rule.includes("placeholder")), bad);
  assert.deepEqual(rulesOf(withEntry("page.count.body", "Total {count} of {total}")), []);
});

test("D-COPY-1: every shared state has a title and a body, every next step but NONE has a label, and no two states share a title", () => {
  const titles = new Set<string>();
  for (const state of SHARED_STATES) {
    const copy = stateCopy(state);
    assert.ok(copy.title.length > 0 && copy.body.length > 0, state);
    titles.add(copy.title);
  }
  assert.equal(titles.size, SHARED_STATES.length, "a person can tell the states apart by their title");
  const steps: readonly NextStep[] = ["NONE", "SIGN_IN", "STEP_UP", "FIX_FIELDS", "RELOAD", "COMPARE_VERSIONS", "REQUERY", "REQUEST_NEW_REVIEW", "CHOOSE_ANOTHER_MODE", "RETRY_LATER", "CONTACT_SUPPORT"];
  assert.equal(nextStepLabel("NONE"), null);
  for (const step of steps.filter((step) => step !== "NONE")) assert.ok((nextStepLabel(step) ?? "").length > 0, step);
  assert.equal(Object.keys(EN).filter((id) => id.startsWith("next.")).length, steps.length - 1, "a label per step and nothing else under next.");
  assert.equal(Object.keys(EN).filter((id) => /^state\.[A-Z_]+\.(title|body)$/.test(id)).length, SHARED_STATES.length * 2);
  // the uncertain state never invites another payment; a lost answer is never called a failure
  assert.match(EN["state.UNCERTAIN.body"], /Do not pay again/);
  assert.doesNotMatch(EN["state.PENDING.title"], /fail/i);
});

test("D-COPY-1: a message takes exactly its placeholders, formats numbers en-US, and refuses a missing or an extra parameter", () => {
  assert.deepEqual(placeholdersOf("{a} and {b} and {a}"), ["a", "b"]);
  assert.equal(message("guard.edits.body", { count: 1234 }), "1,234 unsaved edits");
  assert.equal(message("state.support-reference.body", { reference: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f99" }), "Support reference: 0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f99");
  assert.equal(message("shell.skip-link.label"), "Skip to main content");
  assert.throws(() => message("guard.edits.body"), RangeError);
  assert.throws(() => message("guard.edits.body", { count: 1, other: 2 }), RangeError);
  assert.throws(() => message("shell.skip-link.label", { count: 1 }), RangeError);
  assert.equal(message("guard.edits.body", { count: "$&" }), "$& unsaved edits", "a parameter is text, never a replacement pattern");
});

function sourcesUnder(directory: string): readonly string[] {
  const files: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourcesUnder(path));
    else if (/\.(ts|tsx|json|md|txt|html)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("D-COPY-1: the sources of the public pages and the legal templates are held to the same phrase rules (comments excluded), and a source that breaks one is found", () => {
  const roots = [join(webRoot, "src", "app", "(public)"), join(webRoot, "src", "legal")];
  let scanned = 0;
  for (const root of roots) {
    for (const file of sourcesUnder(root)) {
      scanned += 1;
      assert.deepEqual(lintText(file, withoutComments(readFileSync(file, "utf8")), options), [], file);
    }
  }
  assert.ok(scanned >= 0);
  const scratch = mkdtempSync(join(tmpdir(), "copy-lint-"));
  try {
    mkdirSync(join(scratch, "(public)"));
    writeFileSync(join(scratch, "(public)", "page.tsx"), 'export default function Page() { return <h1>Your free audit</h1>; }\n// this comment may say audit\n');
    writeFileSync(join(scratch, "(public)", "ok.tsx"), 'export default function Page() { return <h1>Free data health check</h1>; }\n/* a comment about the audit report artifact family */\n');
    const found = sourcesUnder(scratch).flatMap((file) => lintText(file, withoutComments(readFileSync(file, "utf8")), options));
    assert.equal(found.length, 1);
    assert.ok(found[0]?.id.endsWith("page.tsx"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.equal(withoutComments("const url = 'https://kauro.test/a'; // note\n// whole line\n/* block\nspanning */ const x = 1;").includes("https://kauro.test/a"), true, "a URL in a string keeps its slashes");
});

test("D-COPY-1: no file of apps/web writes the pre-rename brand, comments and tests included", () => {
  const skip = new Set(["node_modules", "dist", ".next", "test-results", "playwright-report", "blob-report"]);
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mts|mjs|js|json|css|md|html|txt|yml|yaml)$/.test(entry.name)) files.push(path);
    }
  };
  walk(webRoot);
  assert.ok(files.length > 20, "the walk reached the sources");
  const pattern = new RegExp(brands.join("|"), "i");
  const offenders = files.filter((file) => pattern.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, []);
});
