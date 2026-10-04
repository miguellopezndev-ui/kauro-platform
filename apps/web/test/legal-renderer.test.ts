// D-LEGAL-1 (docs/design/B11-agency-app.md): the legal documents render from the operator facts and versioned templates, and a document with a
// missing or unreviewed fact is refused, not drafted. These are acceptance tests written before the renderer:
//   - the shipped operator-facts.json is all null (BLOCKED_OWNER, 2026-10-08), so the three routes answer HTTP 503 "This document is not
//     published yet" and carry no version label anywhere (body, header, title);
//   - a complete fact set publishes, and the version label is `<document>-<effective date>-<first 12 hex of sha256 of the rendered text>`,
//     computed here by the test itself (an independent oracle over the renderer's text), stable across renders, new when the text is new;
//   - one null fact, one REQUIRES_REVIEW fact, one malformed fact, or an empty subprocessor list refuses every document, each by itself.
// The facts below are test fixtures: none is a real entity, address or contact.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FACT_NAMES, gapsOf, parseOperatorFacts, REQUIRES_REVIEW, type OperatorFacts } from "../src/legal/facts.ts";
import { legalHandler, OPERATOR_FACTS } from "../src/legal/handler.ts";
import { LEGAL_DOCUMENTS, LEGAL_KEYS, renderLegal, versionLabel, type LegalKey } from "../src/legal/render.ts";
import { legalResponse } from "../src/legal/response.ts";

const NONCE = "AAAAAAAAAAAAAAAAAAAAAA==";
const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const fact = (value: string): { readonly value: string; readonly source: string } => ({ value, source: "test fixture" });

/** A complete, fictional fact set. */
function complete(overrides: Record<string, unknown> = {}): OperatorFacts {
  return parseOperatorFacts({
    legalName: fact("Fixture Operator LLC"),
    entityType: fact("Fixture company form"),
    taxId: fact("TEST-0000"),
    registeredAddress: fact("1 Fixture Street, Fixture City"),
    postalContact: fact("Fixture Operator LLC, 1 Fixture Street, Fixture City"),
    legalEmail: fact("legal@fixture.invalid"),
    governingLaw: fact("Fixture law"),
    forum: fact("Fixture courts"),
    liability: fact("Fixture liability clause"),
    effectiveDate: fact("2026-11-01"),
    subprocessors: [
      { name: fact("Fixture Cloud"), purpose: fact("Hosting"), location: fact("Fixture region"), transferBasis: fact("Fixture basis") },
      { name: fact("Fixture Mail"), purpose: fact("Message delivery"), location: fact("Fixture region"), transferBasis: fact("Fixture basis") },
    ],
    ...overrides,
  });
}

async function respond(key: LegalKey, facts: OperatorFacts, nonce: string | null = NONCE): Promise<{ readonly response: Response; readonly body: string }> {
  const handler = legalHandler(key, facts);
  const request = new Request(`https://www.kauro.test/legal/${key}`, { headers: nonce === null ? {} : { "x-nonce": nonce } });
  const response = handler(request);
  return { response, body: await response.text() };
}

const VERSION_LABEL = /\b(terms|privacy|data-processing)-\d{4}-\d{2}-\d{2}-[0-9a-f]{12}\b/;

test("D-LEGAL-1: the shipped operator-facts.json is all null, every fact is a gap, and the three documents refuse to publish", () => {
  const raw = JSON.parse(readFileSync(join(webRoot, "src", "legal", "operator-facts.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(raw).sort(), [...FACT_NAMES].sort(), "the file names every fact and nothing else");
  for (const [name, value] of Object.entries(raw)) assert.equal(value, null, `${name} is null until the owner provides it`);
  assert.deepEqual(gapsOf(OPERATOR_FACTS).map((gap) => gap.fact).sort(), [...FACT_NAMES].sort());
  for (const gap of gapsOf(OPERATOR_FACTS)) assert.equal(gap.reason, "MISSING");
  for (const key of LEGAL_KEYS) {
    const rendered = renderLegal(key, OPERATOR_FACTS);
    assert.equal(rendered.published, false, key);
    assert.equal("version" in rendered, false, `${key} has no version while unpublished`);
  }
});

test("D-LEGAL-1: with every fact null each legal route answers HTTP 503 'This document is not published yet' with no version label anywhere", async () => {
  for (const key of LEGAL_KEYS) {
    const { response, body } = await respond(key, OPERATOR_FACTS);
    assert.equal(response.status, 503, key);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-kauro-document-version"), null, "no version header");
    assert.match(body, /<h1>This document is not published yet<\/h1>/);
    assert.doesNotMatch(body, VERSION_LABEL, `${key} shows no version label`);
    assert.doesNotMatch(body, /version/i, `${key} names no version at all`);
    assert.doesNotMatch(body, /effective/i, `${key} names no effective date`);
    assert.match(body, /<html lang="en">/);
    assert.equal(body.match(/<h1[ >]/g)?.length, 1, "one h1");
    assert.equal(body.match(/<main[ >]/g)?.length, 1, "one main landmark");
    assert.match(body, /<a href="\/">/, "a way back to the site");
    assert.match(body, /<title>[^<]+<\/title>/);
  }
  // the three documents are told apart by title, never by a fact
  const titles = new Set<string>();
  for (const key of LEGAL_KEYS) titles.add(/<title>([^<]+)<\/title>/.exec((await respond(key, OPERATOR_FACTS)).body)?.[1] ?? "");
  assert.equal(titles.size, 3);
});

test("D-LEGAL-1: the 503 page carries only the site's own style block (with the request nonce), no script, no style attribute, no foreign URL", async () => {
  for (const key of LEGAL_KEYS) {
    for (const facts of [OPERATOR_FACTS, complete()]) {
      const { body } = await respond(key, facts);
      assert.match(body, new RegExp(`<style nonce="${NONCE}">`));
      assert.equal(body.match(/<style[ >]/g)?.length, 1);
      assert.doesNotMatch(body, /<script/i);
      assert.doesNotMatch(body, /\sstyle=/i);
      assert.doesNotMatch(body, /https?:\/\//i, "no absolute URL");
      assert.doesNotMatch(body, /<link|<img|<iframe|<form/i);
    }
  }
});

test("D-LEGAL-1: a document is refused without the request nonce the proxy mints (a document without its policy is never served)", () => {
  const handler = legalHandler("terms", complete());
  assert.throws(() => handler(new Request("https://www.kauro.test/legal/terms")), /CSP_NONCE_MISSING/);
  assert.throws(() => handler(new Request("https://www.kauro.test/legal/terms", { headers: { "x-nonce": "not a nonce" } })), /CSP_NONCE_MISSING/);
});

test("D-LEGAL-1: a complete fact set publishes each document with HTTP 200 and a version label computed from the rendered text", async () => {
  const facts = complete();
  assert.deepEqual(gapsOf(facts), []);
  const labels = new Set<string>();
  for (const key of LEGAL_KEYS) {
    const rendered = renderLegal(key, facts);
    assert.equal(rendered.published, true, key);
    if (!rendered.published) return;
    // the independent oracle: sha256 over the rendered text, first 12 hex
    const hash = createHash("sha256").update(rendered.text, "utf8").digest("hex").slice(0, 12);
    assert.equal(rendered.version, `${key}-2026-11-01-${hash}`);
    assert.equal(rendered.version, versionLabel(key, "2026-11-01", rendered.text));
    assert.match(rendered.version, VERSION_LABEL);
    assert.equal(rendered.text.includes(rendered.version), false, "the label is not part of the text it is computed from");
    labels.add(rendered.version);

    const { response, body } = await respond(key, facts);
    assert.equal(response.status, 200, key);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-kauro-document-version"), rendered.version);
    assert.match(body, new RegExp(rendered.version));
    assert.doesNotMatch(body, /not published yet/i);
    assert.equal(body.match(/<h1[ >]/g)?.length, 1);
    assert.equal(body.match(/<main[ >]/g)?.length, 1);
    assert.doesNotMatch(body, /<script/i);
    assert.doesNotMatch(body, /\sstyle=/i);
    // the facts are on the page: the operator, and what the page says applies to it
    assert.match(body, /Fixture Operator LLC/);
    assert.match(body, /2026-11-01/);
  }
  assert.equal(labels.size, 3, "three documents, three labels");
});

test("D-LEGAL-1: the version label is stable for the same text and new for new text; a source citation is not text", () => {
  const key: LegalKey = "terms";
  const first = renderLegal(key, complete());
  const again = renderLegal(key, complete());
  assert.ok(first.published && again.published);
  if (!first.published || !again.published) return;
  assert.equal(again.version, first.version);
  assert.equal(again.text, first.text);

  const cited = renderLegal(key, complete({ governingLaw: { value: "Fixture law", source: "another citation" } }));
  assert.ok(cited.published);
  if (cited.published) assert.equal(cited.version, first.version, "the same words carry the same version, whatever the citation");

  const changed = renderLegal(key, complete({ forum: fact("Other fixture courts") }));
  assert.ok(changed.published);
  if (changed.published) {
    assert.notEqual(changed.version, first.version, "a new word is a new version");
    assert.ok(changed.version.startsWith("terms-2026-11-01-"), "the effective date is the one recorded");
  }

  const later = renderLegal(key, complete({ effectiveDate: fact("2026-12-01") }));
  assert.ok(later.published);
  if (later.published) {
    assert.ok(later.version.startsWith("terms-2026-12-01-"));
    assert.notEqual(later.version, first.version);
    assert.notEqual(later.version.slice(-12), first.version.slice(-12), "the date is part of the text too");
  }

  // the label depends on the words alone: the same text under another document key differs only by its key
  assert.equal(versionLabel("privacy", "2026-11-01", "x"), versionLabel("privacy", "2026-11-01", "x"));
  assert.notEqual(versionLabel("privacy", "2026-11-01", "x"), versionLabel("privacy", "2026-11-01", "y"));
  assert.match(versionLabel("data-processing", "2026-11-01", ""), /^data-processing-2026-11-01-e3b0c44298fc$/, "the digest of the empty text");
});

test("D-LEGAL-1: any one null fact refuses every document with 503 and no version label, whichever fact it is", async () => {
  for (const name of FACT_NAMES) {
    const facts = complete({ [name]: null });
    const gaps = gapsOf(facts);
    assert.deepEqual(gaps, [{ fact: name, reason: "MISSING" }], name);
    for (const key of LEGAL_KEYS) {
      assert.equal(renderLegal(key, facts).published, false, `${key} without ${name}`);
      const { response, body } = await respond(key, facts);
      assert.equal(response.status, 503, `${key} without ${name}`);
      assert.doesNotMatch(body, VERSION_LABEL);
      assert.equal(response.headers.get("x-kauro-document-version"), null);
    }
  }
});

test("D-LEGAL-1: a fact marked REQUIRES_REVIEW (liability, law, forum) refuses every document, and so does a REQUIRES_REVIEW subprocessor field", async () => {
  const review = { value: REQUIRES_REVIEW, source: "the operator's legal reviewer has not confirmed this yet" };
  for (const name of ["liability", "governingLaw", "forum", "legalName", "effectiveDate"] as const) {
    const facts = complete({ [name]: review });
    assert.deepEqual(gapsOf(facts), [{ fact: name, reason: "REQUIRES_REVIEW" }], name);
    for (const key of LEGAL_KEYS) {
      const { response, body } = await respond(key, facts);
      assert.equal(response.status, 503, `${key} with ${name} under review`);
      assert.doesNotMatch(body, VERSION_LABEL);
      assert.doesNotMatch(body, /REQUIRES_REVIEW/, "the marker never reaches a page");
    }
  }
  const oneField = complete({
    subprocessors: [{ name: fact("Fixture Cloud"), purpose: fact("Hosting"), location: review, transferBasis: fact("Fixture basis") }],
  });
  assert.deepEqual(gapsOf(oneField), [{ fact: "subprocessors", reason: "REQUIRES_REVIEW" }]);
  for (const key of LEGAL_KEYS) assert.equal((await respond(key, oneField)).response.status, 503);
});

test("D-LEGAL-1: an empty subprocessor list and a malformed effective date are gaps, not documents", () => {
  assert.deepEqual(gapsOf(complete({ subprocessors: [] })), [{ fact: "subprocessors", reason: "MISSING" }]);
  for (const bad of ["2026-13-01", "2026-02-30", "01/11/2026", "2026-11-1", "tomorrow", ""]) {
    const gaps = gapsOf(complete({ effectiveDate: { value: bad, source: "test" } }));
    assert.deepEqual(gaps.map((gap) => gap.fact), bad === "" ? ["effectiveDate"] : ["effectiveDate"], bad);
    assert.ok(gaps[0]?.reason === "INVALID" || gaps[0]?.reason === "MISSING", bad);
  }
  assert.equal(renderLegal("terms", complete({ effectiveDate: { value: "2026-02-30", source: "test" } })).published, false);
});

test("D-LEGAL-1: the facts file is parsed strictly: unknown members, wrong types and blank text are refused, never guessed", () => {
  const shape = (raw: unknown): void => void parseOperatorFacts(raw);
  assert.throws(() => shape(null), TypeError);
  assert.throws(() => shape([]), TypeError);
  assert.throws(() => shape({ ...JSON.parse(JSON.stringify(complete())), extra: null }), /extra/);
  const allNull = Object.fromEntries(FACT_NAMES.map((name) => [name, null]));
  assert.doesNotThrow(() => shape(allNull));
  const without = { ...allNull } as Record<string, unknown>;
  delete without["forum"];
  assert.throws(() => shape(without), /forum/, "a fact left out of the file is not the same as a fact recorded as null");
  assert.throws(() => shape({ ...allNull, legalName: "Fixture Operator LLC" }), /legalName/, "a bare string has no source");
  assert.throws(() => shape({ ...allNull, legalName: { value: "Fixture Operator LLC" } }), /legalName/, "a fact without a source");
  assert.throws(() => shape({ ...allNull, legalName: { value: "Fixture Operator LLC", source: "" } }), /legalName/);
  assert.throws(() => shape({ ...allNull, legalName: { value: "Fixture Operator LLC", source: "test", extra: 1 } }), /legalName/);
  assert.throws(() => shape({ ...allNull, legalName: { value: 5, source: "test" } }), /legalName/);
  assert.throws(() => shape({ ...allNull, subprocessors: "Fixture Cloud" }), /subprocessors/);
  assert.throws(() => shape({ ...allNull, subprocessors: [{ name: fact("Fixture Cloud") }] }), /subprocessors/);
  // blank text is a gap in a well-formed file (the owner left the field empty), never a published blank
  assert.deepEqual(gapsOf(complete({ legalName: { value: "   ", source: "test" } })), [{ fact: "legalName", reason: "MISSING" }]);
});

test("D-LEGAL-1: a fact value is text: markup and entities in it are escaped, in the page and never in the hashed text", async () => {
  const hostile = `<script>alert("x")</script> & "quoted" 'single' <img src=x onerror=1>`;
  const facts = complete({ legalName: fact(hostile) });
  const { body, response } = await respond("privacy", facts);
  assert.equal(response.status, 200);
  assert.doesNotMatch(body, /<script/i);
  assert.doesNotMatch(body, /<img/i);
  assert.match(body, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &quot;quoted&quot; &#39;single&#39; &lt;img src=x onerror=1&gt;/);
  const rendered = renderLegal("privacy", facts);
  assert.ok(rendered.published);
  if (rendered.published) assert.ok(rendered.text.includes(hostile), "the hashed text is the words, not their HTML form");
  // a control character cannot split a line of the text or a header
  const rendered2 = renderLegal("terms", complete({ legalName: fact("Fixture\nOperator\r\nLLC\u0000") }));
  assert.equal(rendered2.published, false, "a control character in a fact is invalid, not sanitised");
});

test("D-LEGAL-1: every document names the facts of the operator and the boundaries the authority requires, and none invents one", () => {
  const facts = complete();
  const texts = new Map<LegalKey, string>();
  for (const key of LEGAL_KEYS) {
    const rendered = renderLegal(key, facts);
    assert.ok(rendered.published, key);
    if (rendered.published) texts.set(key, rendered.text);
  }
  const terms = texts.get("terms") ?? "";
  // 19 "Service terms: required operative content": provider identity, file-based preparation, the agency's import, retention, governing law and forum
  for (const needle of ["Fixture Operator LLC", "Fixture law", "Fixture courts", "Fixture liability clause"]) assert.ok(terms.includes(needle), `terms name ${needle}`);
  assert.match(terms, /files?/i);
  assert.match(terms, /import/i);
  assert.match(terms, /retention|retained|deleted/i);
  assert.match(terms, /refund/i);
  assert.doesNotMatch(terms, /live CRM writes? are/i);
  const privacy = texts.get("privacy") ?? "";
  for (const needle of ["Fixture Operator LLC", "legal@fixture.invalid", "Fixture Cloud", "Fixture Mail", "Hosting", "Fixture region", "Fixture basis"]) assert.ok(privacy.includes(needle), `privacy names ${needle}`);
  const dpa = texts.get("data-processing") ?? "";
  for (const needle of ["Fixture Operator LLC", "Fixture Cloud", "Fixture Mail", "Fixture law"]) assert.ok(dpa.includes(needle), `the data processing terms name ${needle}`);
  // A3 3.7: the two-party chain of an in-house team's own data is covered as well as the agency chains
  assert.match(dpa, /in-house/i);
  assert.match(dpa, /controller/i);
  assert.match(dpa, /processor/i);
  // no absolute claim the actual providers cannot back (UI46 exceptions)
  for (const [key, text] of texts) {
    assert.doesNotMatch(text, /\b(fully|always) compliant\b|\bGDPR[- ]compliant\b|\bguarantee[sd]? (deletion|anonymity)\b|\bzero retention\b/i, key);
  }
});

test("D-LEGAL-1: a legal route file serves its own document and no other, and every route is a handler with no cache", () => {
  const legalDir = join(webRoot, "src", "app", "(public)", "legal");
  const folders = readdirSync(legalDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(folders, [...LEGAL_KEYS].sort(), "one route per document, at the path of the registry");
  for (const key of LEGAL_KEYS) {
    const source = readFileSync(join(legalDir, key, "route.ts"), "utf8");
    assert.match(source, /export const dynamic = "force-dynamic";/);
    assert.match(source, new RegExp(`export const GET = legalHandler\\("${key}"\\);`));
    assert.equal(readdirSync(join(legalDir, key)).join(","), "route.ts", "a route handler and nothing else at that path");
  }
  assert.deepEqual(
    LEGAL_DOCUMENTS.map((document) => [document.key, document.route]),
    [["terms", "/legal/terms"], ["privacy", "/legal/privacy"], ["data-processing", "/legal/data-processing"]],
  );
});

test("D-LEGAL-1: legalResponse states its own status: 200 only for a published document, 503 for everything else", () => {
  const css = "body{margin:0}";
  const published = renderLegal("terms", complete());
  const refused = renderLegal("terms", OPERATOR_FACTS);
  assert.equal(legalResponse(published, { nonce: NONCE, css }).status, 200);
  assert.equal(legalResponse(refused, { nonce: NONCE, css }).status, 503);
  assert.throws(() => legalResponse(published, { nonce: "", css }), /nonce/);
});

test("D-LEGAL-1: the shipped facts file and templates are the only place a legal fact or clause lives (no page under (public) names an entity)", () => {
  const publicDir = join(webRoot, "src", "app", "(public)");
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(publicDir);
  assert.ok(files.length > 0);
  for (const file of files) {
    if (file.includes(`${join("legal", "")}`)) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /\b(NIT|registered office|governing law)\b/i, file);
  }
});
