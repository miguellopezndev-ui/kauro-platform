// The data the public pages state that is not price or availability: the input limits (from the policy snapshot), the synthetic sample
// (UI05), the versioned help guides (UI48), the route table and the sign-in address. Each is small, pure and held here by the property that
// makes it safe to publish:
//   - a limit is written from the policy's number and nowhere else;
//   - the synthetic sample adds up (a sample that does not reconcile would teach the wrong thing about the manifest) and says it is invented;
//   - a guide that changes without a new version fails, so "versioned" is enforced, not promised;
//   - the route table equals the registry's screens, and the sign-in link leaves the public origin only when the deployment names an app origin.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PUBLIC_COPY, placeholdersOf } from "../src/copy/public.ts";
import { GUIDES_CHANGED, GUIDES_VERSION, guideText, guides } from "../src/public/guides.ts";
import { INPUT_LIMITS, formatBytes } from "../src/public/limits.ts";
import { MANIFEST_FILES, REPORT_ROWS, SAMPLE, sharePercent } from "../src/public/sample-data.ts";
import { FOOTER_NAV, MAIN_NAV, ROUTE, SITE_PAGES, pageMetadata } from "../src/public/site.ts";
import { signInUrl } from "../src/server/public-origins.ts";
import { registryScreens } from "./support/registry.ts";

test("a limit is written from the policy's number: bytes in decimal units, counts with separators", () => {
  assert.equal(formatBytes(2_000_000_000), "2 GB");
  assert.equal(formatBytes(5_000_000_000), "5 GB");
  assert.equal(formatBytes(250_000_000), "250 MB");
  assert.equal(formatBytes(1_500_000_000), "1.5 GB");
  assert.throws(() => formatBytes(-1));
  assert.throws(() => formatBytes(1.5));
  assert.deepEqual(INPUT_LIMITS, { files: "50", fileSize: "2 GB", setSize: "5 GB", columns: "800", units: "500,000" });
});

test("the synthetic sample reconciles: the report's shares are its counts over its populations, and the manifest's rows add up", () => {
  assert.equal(sharePercent(428, 12_480), "3.4%");
  assert.equal(sharePercent(191, 12_480), "1.5%");
  assert.equal(sharePercent(1_137, 12_480), "9.1%");
  assert.equal(sharePercent(0, 10), "0.0%");
  assert.equal(sharePercent(10, 10), "100.0%");
  assert.throws(() => sharePercent(1, 0));
  assert.throws(() => sharePercent(11, 10));
  for (const row of REPORT_ROWS) if (row.population !== null) assert.ok(row.count <= row.population, `${row.label}: a count never exceeds its population`);
  assert.equal(REPORT_ROWS[0]?.count, SAMPLE.contacts, "the first row is the file itself");
  for (const file of MANIFEST_FILES) assert.equal(file.source - file.unified, file.rows, `${file.name}: source rows less unified rows are the output rows`);
  const contacts = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
  assert.deepEqual([contacts?.source, contacts?.unified, contacts?.rows], [SAMPLE.contacts, 214, 12_266]);
  assert.equal(new Set(MANIFEST_FILES.map((file) => file.name)).size, MANIFEST_FILES.length);
  for (const file of MANIFEST_FILES) assert.match(file.name, /^[a-z]+-clean\.csv$/);
});

// The recorded digest of the guides' rendered text. A change to any guide, or to a number a guide states from the policy, changes the digest:
// this test then fails until the version and the date are raised and the digest below is recorded, which is what "versioned" means.
const RECORDED_GUIDES = { version: "1.0", changed: "2026-09-29", sha256: "d610f5acc13ef1111a436349329541f018e0b86f76f259b909f2f159521ef589" } as const;

test("the guides are versioned: their text has a recorded digest under a version and a date, and it is kept in step", () => {
  assert.equal(GUIDES_VERSION, RECORDED_GUIDES.version);
  assert.equal(GUIDES_CHANGED, RECORDED_GUIDES.changed);
  assert.match(GUIDES_CHANGED, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(createHash("sha256").update(guideText(), "utf8").digest("hex"), RECORDED_GUIDES.sha256);
});

test("each guide has a heading, a summary and paragraphs with every figure filled from the policy, and their slugs are distinct anchors", () => {
  const all = guides();
  assert.deepEqual(all.map((guide) => guide.slug), ["files", "target", "approval", "payment", "stages", "retention", "support"]);
  assert.equal(new Set(all.map((guide) => guide.slug)).size, all.length);
  for (const guide of all) {
    assert.match(guide.slug, /^[a-z]+$/);
    assert.ok(guide.paragraphs.length >= 2, guide.slug);
    for (const paragraph of guide.paragraphs) {
      assert.deepEqual(placeholdersOf(paragraph.text), [], `${paragraph.id} has no placeholder left`);
      assert.ok(paragraph.text.length > 0);
    }
  }
  const text = guideText();
  for (const figure of ["up to 50 files", "up to 2 GB for each file", "up to 800 columns", "180 days", "30 days", "valid for 14 days"]) assert.ok(text.includes(figure), figure);
  assert.doesNotMatch(text, /\{|\}/);
});

test("the route table is the registry's: every public screen this package owns is mapped to its route, and only those", () => {
  const registry = registryScreens();
  const owned = ["UI01", "UI02", "UI03", "UI04", "UI05", "UI06", "UI07", "UI08", "UI48", "UI49"];
  assert.deepEqual(SITE_PAGES.map((page) => page.screen), owned);
  for (const page of SITE_PAGES) {
    const screen = registry.get(page.screen);
    assert.ok(screen !== undefined, page.screen);
    assert.equal(screen?.origin, "PUBLIC");
    assert.equal(page.route, screen?.route, page.screen);
    assert.equal(PUBLIC_COPY[`${page.key}.title` as keyof typeof PUBLIC_COPY], screen?.primaryCopy, `${page.screen}: the page's h1 is the registry's primary copy`);
  }
  assert.equal(registry.get("UI45")?.route, ROUTE.terms);
  assert.equal(registry.get("UI46")?.route, ROUTE.privacy);
  assert.equal(registry.get("UI47")?.route, ROUTE.processing);
});

test("the navigation names only routes of the public site, each once, in the order a buyer reads them, with a label in the catalogue", () => {
  const routes = new Set<string>(Object.values(ROUTE));
  const items = [...MAIN_NAV, ...FOOTER_NAV];
  assert.equal(new Set(items.map((item) => item.href)).size, items.length, "no route is listed twice");
  for (const item of items) {
    assert.ok(routes.has(item.href), item.href);
    assert.ok(item.label in PUBLIC_COPY, item.label);
    assert.match(item.label, /^nav\.[a-z]+\.label$/);
  }
  assert.deepEqual(MAIN_NAV.map((item) => item.href), ["/", "/how-it-works", "/supported-services", "/pricing", "/sample-delivery", "/security", "/help", "/contact"]);
  assert.deepEqual(FOOTER_NAV.map((item) => item.href), ["/status", "/legal/terms", "/legal/privacy", "/legal/data-processing"]);
});

test("each page's metadata is its own title and description, from the catalogue", () => {
  for (const page of SITE_PAGES) {
    const meta = pageMetadata(page.key);
    assert.equal(meta.title, PUBLIC_COPY[`${page.key}.meta.title` as keyof typeof PUBLIC_COPY], page.key);
    assert.equal(meta.description, PUBLIC_COPY[`${page.key}.meta.description` as keyof typeof PUBLIC_COPY], page.key);
    assert.ok(meta.description.length >= 60 && meta.description.length <= 200, `${page.key}: a description that a result page can show`);
  }
  assert.equal(new Set(SITE_PAGES.map((page) => pageMetadata(page.key).title)).size, SITE_PAGES.length, "titles are distinct");
});

test("the sign-in link leaves the public origin only when the deployment names a different app origin, and is otherwise the local path", () => {
  const split = { KAURO_ENV: "PRODUCTION", KAURO_PUBLIC_ORIGIN: "https://kauro.example", KAURO_APP_ORIGIN: "https://app.kauro.example" };
  assert.equal(signInUrl(split), "https://app.kauro.example/login");
  assert.equal(signInUrl({ ...split, KAURO_APP_ORIGIN: "https://app.kauro.example:8443" }), "https://app.kauro.example:8443/login");
  assert.equal(signInUrl({ KAURO_ENV: "LOCAL", KAURO_PUBLIC_ORIGIN: undefined, KAURO_APP_ORIGIN: undefined }), "/login");
  assert.equal(signInUrl({ KAURO_ENV: "LOCAL", KAURO_PUBLIC_ORIGIN: "http://localhost:3000", KAURO_APP_ORIGIN: "http://localhost:3001" }), "http://localhost:3001/login");
  const local = [
    { ...split, KAURO_APP_ORIGIN: undefined },
    { ...split, KAURO_APP_ORIGIN: "" },
    { ...split, KAURO_APP_ORIGIN: split.KAURO_PUBLIC_ORIGIN },
    { ...split, KAURO_APP_ORIGIN: "http://app.kauro.example" },
    { ...split, KAURO_APP_ORIGIN: "https://app.kauro.example/" },
    { ...split, KAURO_APP_ORIGIN: "https://app.kauro.example/login" },
    { ...split, KAURO_APP_ORIGIN: "https://user:secret@app.kauro.example" },
    { ...split, KAURO_APP_ORIGIN: "javascript:alert(1)" },
    { ...split, KAURO_APP_ORIGIN: "app.kauro.example" },
  ];
  for (const environment of local) assert.equal(signInUrl(environment), "/login", JSON.stringify(environment));
});
