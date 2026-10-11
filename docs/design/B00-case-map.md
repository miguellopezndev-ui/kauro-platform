# B00 — case map

Every case of package B00 (registry `cases.json`, gate G-FACTS, manuals 23 and 24) mapped to the tests that demonstrate its
expected outcome. The sidecar `docs/acceptance/case-maps/B00.json` is converted from this file mechanically
(`node tools/ledger.mjs sidecars --write`); `tools/test/ledger.test.mjs` checks that it is current.

Status vocabulary: the evidence classes of manual 21. **EXECUTED_LOCAL** — every named test exists under exactly that name, runs
in `pnpm run verify` (tools suite) and demonstrates the whole expected outcome. **NOT_EXECUTED** — no evidence is claimed; the
row says what it waits for. No case is PASS by being listed: acceptance is the independent review (A4 (c)), and the ledger
counts a class as demonstrated only through the review that accepts it.

Context (audit `authority-process-01`): the four cases were written for the mandate loop that amendment A4 retired on
2026-09-29. R2-116, R2-117 and R2-118 still have a consumer under A4 — the edition transition record, the ledger and the owner's
"ready to connect" sheet — and are executed against those. R2-115 waits for the owner's decision on the A7 clause that settles
it (`docs/acceptance/A7-draft.md` §1); this map does not decide it.

## Cases

| case | status | test (file :: title) | commit | remaining |
|---|---|---|---|---|
| R2-115 | NOT_EXECUTED | — | — | Waits for the owner's signature of the A7 §1 clause on R2-115 (draft `docs/acceptance/A7-draft.md`, decision D-06). Until then no class is claimed and the ledger lists the case as NOT_EXECUTED. |
| R2-116 | EXECUTED_LOCAL | `tools/test/ledger-b00.test.mjs` :: "R2-116: the edition transition R2 → A4/A5/A6/A8/A9 is recorded with the PROVENANCE hashes; every amendment applies prospectively and leaves the vendored registry byte-identical; an amendment file in this repository matches its recorded hash"; "R2-116: work accepted before the transition keeps its clock and scope — its accepted subject survives the amendments, and a forged change of the registry is refused" | `798e90f` | none. A4, A5 and A6 live on the operator host: the record names their location, carries no hash it cannot observe, and B adds the hashes with the A7 re-issue (`transition.json`). |
| R2-117 | EXECUTED_LOCAL | `tools/test/ledger-b00.test.mjs` :: "R2-117: a claim is never acceptance — the README's statuses are observations the ledger recomputes from review records; a status, row or repair claimed without an accepting review is refused or stays a claim" | `798e90f` | none |
| R2-118 | NOT_EXECUTED | — | — | Waits for the owner's "ready to connect" sheet (`docs/owner/OWNER_ACTIONS.md` on `b00/owner-actions`: due 2026-10-07; not yet in the repository on 2026-10-07). When it lands, a planned test in tools/test/ledger-b00.test.mjs, titled R2-118: every owner action of the ready-to-connect sheet names its current destination, what the agents prepared, the irreducible act left to the owner and the receipt that proves it, and no row names a stale menu or a nonexistent account, checks it, and the row becomes EXECUTED_LOCAL. |

## What each test observes

- **R2-116.** `docs/acceptance/ledger/transition.json` names the edition KAURO-2026.09-R2 with the ten registry hashes of
  `PROVENANCE.json`, and each amendment applied since then (A4 2026-09-29, A5 2026-10-01, A6, A8 2026-10-05, A9 2026-10-05) as
  PROSPECTIVE and not changing the registry. The test recomputes every registry file's SHA-256, checks the order of the
  effective dates, and checks the SHA-256 of each amendment text that lives in this repository (A8, A9). The second test checks
  that the packages accepted before A8/A9 (B06, B07, B08 and B09, reviews of 2026-09-30 and 2026-10-01) keep their accepted
  subject in the ledger. Negative control: a forged registry hash is refused (`REGISTRY_HASH_MISMATCH`).
- **R2-117.** The README table of `docs/acceptance/README.md` is read as a claim, and the ledger recomputes each status from the
  review records. Three negative controls: a new README row that claims B10 REVIEW_ACCEPTED without a review is refused
  (`README_CLAIM_WITHOUT_REVIEW`); B10's 54 EXECUTED_LOCAL rows stay *claimed*, never *demonstrated*, and B10 is not accepted; a
  row that names a review id it does not have is refused (`PASS_WITHOUT_REVIEW`).
