// The copy catalogue of the public pages (D-COPY-1, amendment A3 section 3) held to its rules as a whole: the lint over every message, the
// names A3 fixes, the one sentence about AI and the one about in-house teams, the placeholder discipline of copy(), and the sources of the
// public pages, the legal renderer and the catalogue itself read for anything the catalogue's lint cannot see (a phrase typed straight
// into a component, an unused message, a pre-rename brand). The pages' rendered text is linted in test/public-pages.test.ts; this file
// holds the catalogue and the sources.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { R2_DOMAIN_ALIASES } from "@kauro/contracts";
import { HEALTH_CHECK_CTA, HEALTH_CHECK_NAME, IN_HOUSE_SENTENCE, PERMITTED_AI_SENTENCE, lintCatalogue, lintText, withoutComments } from "../src/copy/lint.ts";
import { PUBLIC_COPY, copy, placeholdersOf, type PublicCopyId } from "../src/copy/public.ts";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const brands = [...new Set(Object.keys(R2_DOMAIN_ALIASES).map((name) => name.split("_")[0] ?? ""))].filter((name) => name.length > 0);
const entries: Readonly<Record<string, string>> = PUBLIC_COPY;
const ids = Object.keys(entries);

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
const sourcesUnder = (...parts: string[]): string[] => walk(join(webRoot, ...parts)).filter((file) => /\.(ts|tsx|css)$/.test(file));

test("the catalogue passes the A3 lint: no audit, no AI-ready, no compatibility claim, no savings promise, no founding line, and AI in one sentence only", () => {
  assert.ok(ids.length > 250, "the catalogue is the whole public site");
  assert.deepEqual(lintCatalogue(entries, { brands }), []);
});

test("the names A3 fixes are exact: the free step, its call to action, and the one sentence for in-house teams that stands on Pricing alone", () => {
  assert.equal(PUBLIC_COPY["health-check.title"], HEALTH_CHECK_NAME);
  assert.equal(PUBLIC_COPY["public.cta.request-health-check.cta"], HEALTH_CHECK_CTA);
  assert.equal(HEALTH_CHECK_CTA, "Request a free data health check");
  assert.equal(PUBLIC_COPY["pricing.in-house.body"], IN_HOUSE_SENTENCE);
  const inHouse = ids.filter((id) => (entries[id] ?? "").includes(IN_HOUSE_SENTENCE));
  assert.deepEqual(inHouse, ["pricing.in-house.body"]);
  const withAi = ids.filter((id) => /\bAI\b|artificial intelligence/i.test(entries[id] ?? ""));
  assert.deepEqual(withAi.map((id) => entries[id]), [PERMITTED_AI_SENTENCE], "AI is written in one message only, and it is the permitted sentence");
  assert.match(PUBLIC_COPY["home.title"], /^Prepare and verify CRM data from files\.$/);
});

test("the lint refuses what the catalogue must never say: a synthetic entry per rule fails, so a passing catalogue is not a lint that checks nothing", () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ["a free audit of your data", "audit"],
    ["A diagnosis of every table", "diagnosis"],
    ["Get AI-ready data", "AI-ready"],
    ["AI cleans the file", "AI cleans"],
    ["Kauro is compatible with any CRM", "compatible with"],
    ["Works with any CRM you use", "works with any CRM"],
    ["We delete the duplicates for you", "delete duplicates"],
    ["You will save USD 5,000", "savings amount"],
    ["It pays for itself", "pays for itself"],
    ["There is no charge if we find nothing", "if we find nothing"],
    ["Founding customers pay less", "founding"],
    ["Imported", "Imported"],
  ];
  for (const [text, what] of refused) assert.notDeepEqual(lintText("synthetic.body", text, { brands }), [], what);
  const surface = lintCatalogue({ ...entries, "synthetic.title": "Clean data for AI" }, { brands });
  assert.ok(surface.some((violation) => violation.id === "synthetic.title"), "AI in a title is refused");
  const twice = lintCatalogue({ ...entries, "pricing.in-house.again": IN_HOUSE_SENTENCE }, { brands });
  assert.ok(twice.length > 0, "the in-house sentence twice is refused");
  const elsewhere = lintCatalogue({ ...entries, "home.in-house": IN_HOUSE_SENTENCE }, { brands });
  assert.ok(elsewhere.some((violation) => violation.id === "home.in-house"), "the in-house sentence off Pricing is refused");
  const brand = brands[0];
  assert.ok(brand !== undefined, "the contract package names the earlier brand");
  assert.notDeepEqual(lintText("synthetic.body", `Welcome to ${brand}`, { brands }), []);
});

test("copy() fills every placeholder, refuses a message asked for with a value missing or with a value it has no place for, and leaves nothing unfilled", () => {
  assert.equal(copy("pricing.in-house.body"), IN_HOUSE_SENTENCE);
  assert.equal(copy("security.retention.links", { minutes: "15 minutes" }), "A download link works for 15 minutes.");
  assert.throws(() => copy("security.retention.links"), /COPY_PLACEHOLDER_MISSING security\.retention\.links minutes/);
  assert.throws(() => copy("security.retention.links", { minutes: "15 minutes", extra: 1 }), /COPY_VALUE_UNUSED security\.retention\.links extra/);
  assert.throws(() => copy("pricing.in-house.body", { anything: 1 }), /COPY_VALUE_UNUSED pricing\.in-house\.body anything/);
  assert.equal(copy("security.retention.links", { minutes: 3 }), "A download link works for 3.");
  for (const id of ids) {
    const names = placeholdersOf(entries[id] ?? "");
    const filled = copy(id as PublicCopyId, Object.fromEntries(names.map((name) => [name, `<${name}>`])));
    assert.equal(/\{[A-Za-z]/.test(filled), false, `${id} has no placeholder left after it is filled`);
  }
});

test("every placeholder of the catalogue is one the pages know how to fill, and a value that is a figure is never typed into a message", () => {
  const known = new Set([
    "band", "check", "columns", "contacts", "count", "date", "days", "fileSize", "files", "fresh", "hard", "high", "id", "kept", "low", "max", "mid", "minutes", "mode", "name", "output", "package", "price", "range",
    "reference", "repair", "setSize", "source", "time", "unified", "units", "version", "wait",
  ]);
  const unknown = ids.flatMap((id) => placeholdersOf(entries[id] ?? "").filter((name) => !known.has(name)).map((name) => `${id} {${name}}`));
  assert.deepEqual(unknown, []);
  for (const id of ids) {
    const text = entries[id] ?? "";
    assert.equal(/\{\}/.test(text), false, `${id} has an empty placeholder`);
    assert.equal(/\$\s?\d|USD\s?\d|\d[\d,]*\s?USD/.test(text), false, `${id} types a price into a message: prices come from the policy bands`);
  }
});

test("no message promises what A3 keeps out: no fifteen-minute promise beyond the retention row, no founding line, no third-party CRM named as a claim", () => {
  for (const id of ids) {
    const text = entries[id] ?? "";
    assert.equal(/\bfounding\b/i.test(text), false, `${id}: the founding line stays hidden until B10 reports a slot`);
    if (id !== "security.retention.links") assert.equal(/\b(fifteen|15)[- ]minutes?\b/i.test(text), false, `${id}: the download-link window is stated once, from the policy`);
    assert.equal(/\b(certified|guaranteed|100%|risk[- ]free|instant(ly)?)\b/i.test(text), false, `${id}: no certificate, guarantee or instant promise`);
  }
  const named = ids.filter((id) => /HubSpot|Salesforce/.test(entries[id] ?? ""));
  for (const id of named) {
    const text = entries[id] ?? "";
    assert.equal(/\b(integrat(es|ed|ion)|synchroni[sz]e|connects?\s+to)\b/i.test(text.replace(/does not connect to/i, "")), false, `${id}: HubSpot and Salesforce are named as destinations Kauro prepares files for, never as integrations`);
  }
});

test("the catalogue's messages are unique in their key, plain text, and each is used by a page, a route or a template: no dead message ships", () => {
  assert.equal(new Set(ids).size, ids.length);
  const sources = [...sourcesUnder("src", "public"), ...sourcesUnder("src", "app", "(public)"), ...sourcesUnder("src", "legal"), ...sourcesUnder("src", "server")]
    .map((file) => withoutComments(readFileSync(file, "utf8")))
    .join("\n");
  const dynamic: readonly RegExp[] = [
    /^[a-z]+\.meta\.(title|description)$/, // pageMetadata(key) builds these two ids from the page key
    /^contact\.(buyer|destination|timing)\./, // the option labels of the fit form, chosen by the api's vocabulary
    /^health-check\.title$/, // the name A3 fixes for the free step, held for every surface that names it and checked by the lint
  ];
  const unused = ids.filter((id) => !sources.includes(`"${id}"`) && !dynamic.some((pattern) => pattern.test(id)));
  assert.deepEqual(unused, [], "a message no source names is dead copy");
});

test("the sources of the public pages, the legal renderer and the catalogue never write the pre-rename brand and never type a phrase A3 refuses", () => {
  const groups: ReadonlyArray<readonly string[]> = [["src", "public"], ["src", "copy"], ["src", "app", "(public)"], ["src", "legal"], ["src", "server"]];
  let read = 0;
  for (const group of groups) {
    for (const file of sourcesUnder(...group)) {
      if (file.endsWith(join("copy", "lint.ts"))) continue; // the lint names the phrases it refuses
      const text = withoutComments(readFileSync(file, "utf8"));
      read += 1;
      assert.deepEqual(lintText(relative(webRoot, file), text, { brands }), [], relative(webRoot, file));
    }
  }
  assert.ok(read > 40, "the walk found the sources");
});

test("the sources say what a page shows only through the catalogue: no sentence of prose is typed into a page component", () => {
  const files = [...sourcesUnder("src", "public"), ...sourcesUnder("src", "app", "(public)")].filter((file) => /\.tsx$/.test(file));
  assert.ok(files.length >= 14);
  for (const file of files) {
    const text = withoutComments(readFileSync(file, "utf8"));
    // JSX text between tags that contains two words is prose that bypassed the catalogue.
    const prose = [...text.matchAll(/>([^<>{}\n]*[A-Za-z]{3,}\s+[A-Za-z]{3,}[^<>{}\n]*)</g)].map((match) => (match[1] ?? "").trim()).filter((value) => value.length > 0);
    assert.deepEqual(prose, [], `${relative(webRoot, file)} types prose outside the catalogue`);
  }
});
