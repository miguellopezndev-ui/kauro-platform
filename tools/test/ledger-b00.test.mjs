// Package B00 (gate G-FACTS), the two cases this repository can execute locally (docs/design/B00-case-map.md):
//   R2-116 "Active mandate survives edition change" — preserve the active work's clock and scope until a safe transition, then
//          apply the new edition prospectively: the transition record of R2 → A4/A5/A6/A8/A9 against PROVENANCE.json;
//   R2-117 "New IC main with repair claims" — record observation and claims separately; never mark repairs accepted without
//          review: the ledger's rule that a claim is never acceptance, on the README and on every case row.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { computeLedger, ledgerOfRepo, loadRegistry, loadReviews, readSidecars, readmeClaims } from "../ledger.mjs";

const root = join(import.meta.dirname, "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const sha256 = (p) => createHash("sha256").update(readFileSync(join(root, p))).digest("hex");
const transition = JSON.parse(read("docs/acceptance/ledger/transition.json"));

test("R2-116: the edition transition R2 → A4/A5/A6/A8/A9 is recorded with the PROVENANCE hashes; every amendment applies prospectively and leaves the vendored registry byte-identical; an amendment file in this repository matches its recorded hash", () => {
  const provenance = JSON.parse(read("packages/contracts/registry/PROVENANCE.json"));
  assert.equal(transition.edition.id, "KAURO-2026.09-R2");
  assert.deepEqual(transition.edition.files, provenance.files, "the transition names the registry PROVENANCE.json hashes");
  for (const [file, hash] of Object.entries(provenance.files)) assert.equal(sha256(`packages/contracts/registry/${file}`), hash, `${file} unchanged since the edition`);
  assert.deepEqual(transition.amendments.map((a) => a.id), ["A4", "A5", "A6", "A8", "A9"]);
  let last = "";
  for (const a of transition.amendments) {
    assert.equal(a.application, "PROSPECTIVE", `${a.id}: applies from its date on`);
    assert.equal(a.changesRegistry, false, `${a.id}: never edits the vendored registry`);
    if (a.effective) {
      assert.match(a.effective, /^2026-\d{2}-\d{2}$/);
      assert.ok(a.effective >= transition.edition.vendoredAt.slice(0, 10) && a.effective >= last, `${a.id}: after the edition and in order`);
      last = a.effective;
    }
    if (a.location.startsWith("docs/")) assert.equal(sha256(a.location), a.sha256, `${a.id}: ${a.location} is the recorded text`);
    else assert.equal(a.sha256, null, `${a.id}: a text outside this repository carries no hash it cannot observe`);
  }
});

test("R2-116: work accepted before the transition keeps its clock and scope — its accepted subject survives the amendments, and a forged change of the registry is refused", () => {
  const { ledger } = ledgerOfRepo(root);
  for (const { package: pkg, reviewId } of transition.acceptedBeforeTransition) {
    const p = ledger.packages.find((x) => x.package === pkg);
    assert.equal(p.acceptedSubject?.reviewId, reviewId, `${pkg} keeps its accepted subject`);
    assert.equal(p.status, "REVIEW_ACCEPTED", `${pkg}: acceptance, not restarted by A8/A9`);
  }
  const registry = loadRegistry(root);
  registry.hashes["cases.json"] = "0".repeat(64);
  const forged = computeLedger({ registry, sidecars: readSidecars(root), reviews: loadReviews(root) });
  assert.ok(forged.violations.some((v) => v.kind === "REGISTRY_HASH_MISMATCH" && v.subject === "cases.json"));
});

test("R2-117: a claim is never acceptance — the README's statuses are observations the ledger recomputes from review records; a status, row or repair claimed without an accepting review is refused or stays a claim", () => {
  const registry = loadRegistry(root);
  const sidecars = readSidecars(root);
  const reviews = loadReviews(root);
  const readme = read("docs/acceptance/README.md");
  // the observed README agrees with the computed ledger
  const honest = computeLedger({ registry, sidecars, reviews, readme });
  assert.ok(readmeClaims(readme).length >= 4);
  // no README status is claimed without its review; the hand table still names the commit merged to main (4b33e26) where the
  // accepted subject is the latest accepting round (d9bbfd0) for B06, B07 and B09 (PR18-3 (c)) until B regenerates it
  const readmeClaimed = honest.violations.filter((v) => v.kind === "README_CLAIM_WITHOUT_REVIEW");
  assert.deepEqual(readmeClaimed.filter((v) => !/^README names commit/.test(v.detail)), []);
  assert.deepEqual(readmeClaimed.map((v) => v.subject), ["B06", "B07", "B09"]);
  // a new main claiming B10 accepted (no review record) is refused
  const claimed = `${readme}\n| Package | Cases | Status | Commit on main |\n|---|---|---|---|\n| B10 Agency recurrence | 64 | REVIEW_ACCEPTED | \`f42dba6\` |\n`;
  assert.ok(computeLedger({ registry, sidecars, reviews, readme: claimed }).violations.some((v) => v.kind === "README_CLAIM_WITHOUT_REVIEW" && v.subject === "B10"));
  // B10's 54 EXECUTED_LOCAL rows are claims: claimed, never demonstrated, and the package is not accepted
  const b10 = honest.cases.filter((c) => c.package === "B10");
  assert.ok(b10.some((c) => c.claimed === "EXECUTED_LOCAL"));
  assert.ok(b10.every((c) => c.demonstrated === null && c.reviewId === null));
  assert.equal(honest.packages.find((p) => p.package === "B10").status, "IN_PROGRESS");
  // a repair claimed on an accepted package's row (a review id it does not have) is refused
  const forged = sidecars.map((s) => (s.package === "B10" ? { ...s, rows: s.rows.map((r, i) => (i === 0 ? { ...r, reviewId: "B10-round1-f42dba6" } : r)) } : s));
  assert.ok(computeLedger({ registry, sidecars: forged, reviews }).violations.some((v) => v.kind === "PASS_WITHOUT_REVIEW" && v.subject === b10[0].case));
});
