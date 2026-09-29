// The implementation mandates of docs/design/B09-payments-fiscal.md §14 against the sources of this branch (re-check finding B09-N8,
// decision D-STAGE-B1): the mandates run in two stages, stage 1 from the design's head and stage 2 from the integrator's merge of
// stage 1; each names its stage, its starting branch and the fakes it owns, every contract fake has exactly one owner, no mandate
// codes against a port that exists only on an unmerged package's branch or starts from the pre-review head, every port a mandate
// names exists on this branch, and every PLANNED citation of the case map names the mandate §14 gives its test file.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const design = readFileSync(join(root, "docs", "design", "B09-payments-fiscal.md"), "utf8");
const caseMap = readFileSync(join(root, "docs", "design", "B09-case-map.md"), "utf8");

/** The text of §14 and its mandate bullets ("- **Mn — …** (stage k…"), each with its continuation lines. */
function mandates() {
  const start = design.indexOf("## 14. Implementation mandates and verification");
  const end = design.indexOf("## 15. Integration obligations");
  assert.ok(start >= 0 && end > start, "design §14");
  const section = design.slice(start, end);
  const out = new Map();
  let current = null;
  for (const line of section.split(/\r?\n/)) {
    const head = /^- \*\*(M\d) — [^*]+\*\* \(stage (\d)[;)]/.exec(line);
    if (head) {
      current = { id: head[1], stage: Number(head[2]), text: line };
      out.set(current.id, current);
    } else if (current !== null && /^  \S/.test(line)) current.text += ` ${line.trim()}`;
    else current = null;
  }
  return { section, mandates: out };
}

/** Every exported type or value name of the TypeScript sources of the workspace packages (the ports a mandate may name). */
function exportedNames() {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) {
        for (const m of readFileSync(path, "utf8").matchAll(/export (?:interface|type|class|function|const) ([A-Za-z0-9_]+)/g)) names.add(m[1]);
      }
    }
  };
  for (const pkg of ["domain", "application", "persistence", "authorization"]) walk(join(root, "packages", pkg, "src"));
  walk(join(root, "apps", "api", "src"));
  return names;
}

const FAKES = ["PaymentProviderAdapter", "WebhookVerifier", "ProviderEvidenceStore", "FiscalDocumentBridge", "ServiceAuthenticator", "SourceAvailabilityReader", "SourceLineageReader", "DeliveryCapacityPort"];

test("B09-N8: the implementation mandates are staged and self-contained — stage 1 from the design's head, stage 2 from the merge of stage 1, one owner per contract fake, no port of an unmerged package, every named port on this branch, and the case map's planned tests owned by the mandate §14 names", () => {
  const { section, mandates: all } = mandates();
  assert.deepEqual([...all.keys()], ["M1", "M2", "M3", "M4"]);
  for (const m of all.values()) assert.equal(m.stage, m.id === "M1" || m.id === "M2" ? 1 : 2, `${m.id}: its stage`);
  assert.match(section, /\*\*Stage 1\*\* — both mandates start from `b09\/design` at the commit that carries this section/);
  assert.match(section, /\*\*Stage 2\*\* — both mandates start from `b09\/impl-stage1`: the integrator's merge of M1, then M2/);
  for (const m of all.values()) assert.doesNotMatch(m.text, /8a282bc/, `${m.id} names the pre-review head`);
  assert.match(section, /supersedes the pre-review hand-off `\.claude\/b07-b09-design-review\/architect_B09\.json`/);
  assert.doesNotMatch(section, /observeFee \/ observeFee/);
  // one owner per fake: M2 names every fake, the others own none
  const owned = new Map();
  for (const m of all.values()) {
    const text = /\(stage \d(?:; owns ([^)]*))?\)/.exec(m.text)?.[1] ?? "";
    for (const fake of FAKES) if (new RegExp(`\\b${fake}\\b`).test(text)) owned.set(fake, [...(owned.get(fake) ?? []), m.id]);
  }
  for (const fake of FAKES) assert.deepEqual(owned.get(fake), ["M2"], `${fake} has exactly one owner`);
  assert.match(all.get("M1").text, /\(stage 1; owns no fake\)/);
  assert.match(section, /They run in parallel and own no fake \(they bind M2's\)/);
  // no mandate codes against a port that only an unmerged package defines; every port it names is defined on this branch
  const names = exportedNames();
  for (const m of all.values()) {
    assert.doesNotMatch(m.text, /CommercialScopeInspector/, `${m.id} codes against B07's port`);
    for (const [, port] of m.text.matchAll(/`([A-Z][A-Za-z]+(?:Repository|Reader|Port|Adapter|Verifier|Store|Bridge|Authenticator|Authorizer|Reconciler|Phases|Rebinder|Inspector|UnitOfWork|UnitOfWorkFactory|Publisher|DispatchStore))`/g)) {
      assert.ok(names.has(port), `${m.id} names ${port}, which this branch does not define`);
    }
  }
  // the case map's planned citations name the mandate §14 gives their file
  const ownerOf = (file) =>
    /cmd0(28|29|31|32)-/.test(file) ? "M4" : /cmd0(30|33|34)-|b09-(ledger|fiscal)\.test/.test(file) ? "M3" : /b09-scenarios\.test/.test(file) ? "INT-2" : null;
  let planned = 0;
  for (const line of caseMap.split(/\r?\n/)) {
    if (!/^\| (S\d{3}|R2-\d{3}|CMD\d{3}-(OK|DENY|RACE)) \|/.test(line)) continue;
    const files = [...line.matchAll(/`(apps\/api\/test\/[a-z0-9-]+\.test\.ts)`/g)].map((m) => m[1]);
    for (const file of files) {
      const owner = ownerOf(file);
      assert.ok(owner, `${file} has no owner in §14`);
      // a citation whose file is on the branch is no longer planned: its titles exist (tools/test/b09-case-map.test.mjs) and its
      // row is restated at stage 2 by the mandate or integrator that demonstrated it
      if (existsSync(join(root, file))) {
        assert.match(line, /\*\* \(stage 2, (M3|M4|INT-2): /, `${line.slice(0, 20)}: ${file} is on the branch, so its row is restated at stage 2`);
        continue;
      }
      assert.ok(line.includes(`PLANNED (${owner})`), `${line.slice(0, 20)}: ${file} is planned for ${owner}`);
      planned += 1;
    }
    assert.doesNotMatch(line, /PLANNED \(M[12]\)/, `${line.slice(0, 20)}: stage-1 mandates write no command-level test`);
  }
  // after the stage-2 integration every cited api test is on the branch: no planned citation is left (INT-2, design §14)
  assert.equal(planned, 0);
});

// The section headings of the authority manuals 15 and 19 (authority_r2, read-only outside this repository): a decision may cite
// only a section that exists.
const MANUAL_SECTIONS = {
  15: ["Initial payment decision", "Money vocabulary", "Exact representation and rounding", "PaymentOrder and intent", "Capture and authority", "Webhooks and reconciliation", "Payment state transitions", "Price and source expiry races", "Refund policy and calculation", "Disputes and chargebacks", "Settlement and withdrawal", "Fee reference and example", "Accounting integration decision", "FiscalProfile", "TaxDocument state machine", "Operational ledger", "Commission integration", "Corporate and owner money", "Acceptance", "Cross-system worked examples"],
  19: ["Operator decision and sequence", "Name, trademark and domain", "BusinessProfile and legal facts", "Setup action chain", "Customer instrument hierarchy", "Service terms: required operative content", "Data processing agreement", "Data categories and excluded use", "Subprocessor register", "Rights requests and privacy complaints", "Incident and breach obligations", "People and engagement administration", "Intellectual property and repository ownership", "Fiscal and corporate calendar", "Business readiness gate", "Specific unresolved application questions", "Acceptance"],
};

/** The cells of the one table row of the design whose first cell is `id`. */
function row(id) {
  const lines = design.split(/\r?\n/).filter((l) => l.startsWith(`| ${id} |`));
  assert.equal(lines.length, 1, `one row ${id}`);
  return lines[0].split(" | ").map((c) => c.replace(/^\| |\s\|$/g, ""));
}

test("FINAL-N2 (D-PAY-B6): the decisions register fixes the tax point of a capture observed REVERSED without its completion instant — the provider's completion instant alone, never the reversal's instant, the webhook's receipt, the observation's instant or the local clock — citing existing sections of manuals 15 and 19, and the critique row names the tests that prove it", () => {
  const [, decision, authority] = row("D-PAY-B6");
  assert.match(decision, /REVERSED/);
  assert.match(decision, /tax point/);
  for (const never of ["the reversal's instant", "the webhook's receipt", "the observation's instant", "the local clock"]) {
    assert.ok(decision.includes(never), `D-PAY-B6 names ${never} as never the tax point`);
  }
  for (const manual of [15, 19]) {
    const cited = [...authority.matchAll(new RegExp(`\\b${manual} "([^"]+)"`, "g"))].map((m) => m[1]);
    assert.ok(cited.length > 0, `D-PAY-B6 cites manual ${manual}`);
    for (const section of cited) assert.ok(MANUAL_SECTIONS[manual].includes(section), `manual ${manual} has no section "${section}"`);
  }
  // the critique row cites each test by file and title prefix, and each title exists in its file
  const evidence = row("FINAL-N2 (re-check of `3f4af4a`) a REVERSED observation without a completion instant has no rule")[3];
  const citations = [...evidence.matchAll(/`((?:apps|packages)\/[a-z0-9/-]+\.test\.ts)` "([^"…]+)…"/g)];
  assert.ok(citations.some(([, file]) => file === "apps/api/test/b09-payment-service.test.ts"), "the route test on PostgreSQL 17 is cited");
  for (const [, file, prefix] of citations) {
    const source = readFileSync(join(root, file), "utf8");
    assert.ok(source.includes(`test("${prefix}`), `${file} has a test titled "${prefix}…"`);
  }
});
