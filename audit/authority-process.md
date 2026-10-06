# Authority, amendments and acceptance-process audit

Auditor role: authority / amendments / acceptance process. Date: 2026-10-05. Read-only audit.

Subjects audited:
- `/home/user/kauro-local/authority/r2`: manuals 00-31, `registry/`, `prompts/B00..B21`, `reference/EVIDENCE_AND_CI_PROTOCOL.md`, amendments A2-A6, `route/`.
- `/home/user/kauro-platform/packages/contracts/registry` (vendored registry, main `4f99a67`), `docs/acceptance/**`, `docs/design/*-case-map.md`, `docs/design/B10-failure-matrix.md`, `tools/package-brief.mjs`, `tools/evidence.mjs`.
- `/home/user/kauro-local/tools/review` (Codex harness), `tools/usage/incidents.md`.
- Cross-checks: MC `docs/design/B01-B02-case-map.md` and `docs/ACCEPTANCE_LEDGER.md` (main `80a12af`); IC `origin/ic/b04-close` (`cf24e30`): `docs/design/B04-case-map.md` and `B04-campaign-envelope.md`; GitHub PR #16 (MC) and PR #11 (IC).

Rule I followed: nothing here relaxes a threshold, an evidence class or a live-evidence requirement. Every proposal either removes duplicate work on the same exact commit, settles an ambiguity that already causes or will cause rework, or records a decision that keeps getting escalated.

---

## 0. Executive summary

1. **The acceptance chain can never end in ACCEPTED as written.** B00 (4 cases, G-FACTS) has no case map in any repository. Its cases (R2-115..118) describe the ChatGPT mandate loop that A4 retired. Every package depends on B00, directly or transitively (B01→B00, B14→B00). A4 says "a package is not ACCEPTED before its dependencies", so under a strict reading every package stays REVIEW_ACCEPTED forever. A written disposition is needed. Cost: 2 h. If found at B18 instead, it costs about 1-2 days.
2. **The registry gives gates to the wrong packages in 7 places.** `tools/package-brief.mjs` copies those errors into the brief that Codex reviews against. Running it shows the B16 brief has no G-TENANT gate and no CMD003-007/CMD038 command specs, although B16 owns all 18 of those cases. The B11 brief lists **zero** commands but B11 owns the CMD044 triad. The B02, B08 and B15 briefs have the same gap. Fix: change the tool to take gates from case membership. 1-2 h.
3. **The 441-case ledger that A4 calls "the only ledger" does not exist.** `docs/acceptance/README.md` is a hand-maintained table that covers 4 of 22 packages. `tools/evidence.mjs` seals only the B06 and B09 case maps. B18 needs all 433 pre-launch cases accounted for across three repositories. Building the ledger now is 6-8 h for a separate session. It saves about 1 day at B18 and prevents miscounting.
4. **One exact commit is verified up to 4+ times at package close.** CI runs it on ubuntu and windows. A6 §3 keeps a local Windows verify. `package-review.sh` runs another full Linux `pnpm run verify` before every Codex round, recheck rounds included. Under A6 one verify of record per OS is enough. About 1-1.5 days can be recovered over the 11 remaining closes.
5. **Two A6 terms are undefined: "touched" and inherited PARTIAL cases.** About 650 files changed on main after B06-B09 were accepted at `4b33e26`, including shared B06/B08 files (`apps/api/src/composition.ts`, `sessions.ts`, `apps/control/src/audit/*`). Read literally, A6 §2 reopens B06/B08/B09 again and again. Separately, about 54 PARTIAL cases in accepted packages (B06 11, B07 12, B08 8, B09 23) plus 8 B03 cases and 10 B10 cases get their last clause in B11-B17. No rule says whether closing that clause reopens the earlier package. Proposed A7 text settles both without dropping any review.
6. **B10's failure matrix has 162 GAP cells, and 54% of them are generic mechanism cells.** CMD_TMO 26, SWEEP_CRASH 16, CMD_CRA 15, SWEEP_TMO 7, CONS_TMO 6, CONS_CRA 5, CONS_CRB 5, TEN_REV 5, LEASE_TMO 2 (about 87 cells). About 6 parametrized mechanism tests can close them, each enumerating every command, sweep or consumer, plus a static check that every writer routes through the mechanism. The alternative is about 87 single-cell tests. This closes the cells rather than waiving them, and saves about 2-3 builder days.
7. **The Codex review process finds one family at a time.** Rounds: B07 7, B09 5, B06 3, B08 3. Also about 32 non-close Codex prompts (b10-gaps-*, fault-harness, ic-ci-budget, mc-300-dossier), even though A4 says "Codex only for package-close reviews". Codex is not the problem: the prompt never asks it to sweep a whole family, and a PARTIALLY_FIXED finding does not force a root-cause fix. A7 should legitimize the design-time matrix review, which is the highest-yield review: B10 r1 produced 17 findings before any code. It should also require a family sweep in every round and cap per-lane rechecks.
8. **Several owner decisions are still open, and each one will stall live work.** The B04 campaign needs **USD 123** (Sonnet path) or **USD 221** (Opus path), against A4's API budget of USD 20/month. The cloud budget for B14/B16/B17 has no grant. Nothing sets the "relevant deadline" after which the fiscal bridge (Alegra API vs DIAN-assisted) applies. It is unclear whether Claude may tag and publish the MC 3.0.0 and IC releases (MC PR #16 has been green and clean but unmerged since 2026-10-04 20:42Z, and R2-017 waits on publication). Legal review of the customer instruments (OA12) has no owner. The owner's 19-Oct goal is not recorded; A4 still says 23-Oct. One prepared decision sheet (2 h builder, 15 min owner) removes these waits.
9. **The 249 remaining pre-production cases are dominated by B10 (64) and B16 (61).** About 45 of B16's 61 cases can be run locally now (tenant/membership commands, retention/extension, deletion journal). Only about 16 need the real cloud from B14. B16 is not started, and starting its local half now in a parallel lane is the biggest calendar lever on this list. B17's 12 platform command cases (CMD018/019/040/041) are also local. The real-importer cases can reuse the existing HubSpot developer-test portal and Salesforce Developer Edition org, which the owner has already authenticated.

Rough calendar effect if all builder-executable recommendations land this week: **4-7 working days recovered**. On top of that, owner waits of about 2-4 days are avoided if the decision sheet is signed by 2026-10-07.

---

## 1. What acceptance requires, package by package (remaining work)

Sources: `packages/contracts/registry/program.json` (caseIds), `cases.json` (`gate`, `requiredEvidence`), `gates.json`, `prompts/Bnn_*.md`, A4/A6. Every case has the same 8 `requiredEvidence` items: exact_subject_and_environment, input_manifest, presealed_expected_truth, actual_public_result, external_effect_identity, exit_status, artifact_digests, independent_review. Every gate has the same `evidenceRule`: "Exact subject, public consumer, independent truth, complete result, meaningful negative control and reviewer acceptance." A4 acceptance adds four conditions: (a) a case map giving a class and a test for every case; (b) a full verify green on the exact commit in CI (A6 §3), with a local Windows verify at close; (c) Codex ACCEPT or ACCEPT_WITH_MINOR on that commit; (d) the commit on main. A case that needs a live provider stays PARTIAL/SIMULATED until EXECUTED_PROVIDER evidence exists.

Case totals: 441 = B00 4 + B01 33 + B03 50 + B06-B09 97 + **remaining 249** + B20/B21 8 (post-launch). Pre-production universe: 433.

| Pkg | Cases | Gates actually carried by its cases (program.json says) | Live evidence / owner accounts | Inherited clauses from earlier packages | Can start now? |
|---|---|---|---|---|---|
| B02 MC qualification & distribution | 7: MC-07, S034, S092, R2-017 (G-MC-RELEASE); R2-014, R2-015, R2-016 (**G-CAPACITY**; program lists only G-MC-RELEASE) | G-MC-RELEASE 4, G-CAPACITY 3 | R2-017 needs the **published** asset (`qualification/evidence/published-asset.json`), i.e. publication authority. S034 needs one Windows probe and one WSL probe of the same commit. The P14 capacity clause of R2-016 waits for the campaign. | none | Yes. Blocked only by the merge/publish decision (MC PR #16). |
| B04 Model qualification & IC release | 11, all G-IC-QUALITY: IC-10, IC-11, IC-13, S042, S043, S044, S091, R2-039..042 | G-IC-QUALITY 11 | **All 11 need EXECUTED_PROVIDER**: Vertex project + billing (OA07), Model Garden terms for Sonnet 5.5/Opus 5.5 (OA08), us-region quota, grant A USD 25 + grant B USD 98 (Sonnet) or USD 196 (Opus). Thresholds (policy.json): 600 qualification fixtures, 3 independent runs, supported ≥0.97 each run and ≥0.98 mean, ambiguity ≥0.99, critical = 0. | 8 B03 cases name B04 (IC-05, S036, S037, S038, S040, R2-027, R2-028, R2-032) | Offline side done (IC PR #11, every row "offline closed"). Waits on accounts and grants. |
| B05 Monorepo & shared contracts | 3: S045, S046, S047 | G-MONO 3 | none. Consumes **published** MC (B02) and IC (B04) bytes. | — | Yes against release candidates; formal closure after B02 and B04 publish. |
| B10 rest (agency recurrence & commissions) | 64 (all G-COMMERCIAL); case map plans 54 EXECUTED_LOCAL, 10 PARTIAL | G-COMMERCIAL 64 | none live (real seller agreement only for a real person) | 10 PARTIAL rows name B12/B13/B15 | In progress: matrix 472 cells, C 153 / GAP 161 / N/A 158 (`B10-failure-matrix.md:258`). |
| B11 stage 2 (public & agency app) | 13: S066-S070, CMD044 ×3 (**G-UX**); R2-062..065, R2-134 (G-UX_AGENCY) | G-UX 8, G-UX_AGENCY 5 | none (OA14 visual review optional) | B06 CMD003/CMD004 UI surfaces | Yes. |
| B12 seller & owner app | 20 (G-UX_PRIVATE): R2-066/067/068/129/130/131/132/135; CMD061-064 ×3 | G-UX_PRIVATE 20 | Email dispatch can be SIMULATED here; the live send is a B15 seam (Resend). OA16 only for real outreach. | B10 R2-102/103 screens | Yes, after the B10 domain. |
| B13 reports & package experience | 9 (G-REPORT): R2-069/070/071; CMD008 ×3; CMD039 ×3 | G-REPORT 9 | none | B10 R2-101 (staged completion) | Yes. |
| B14 cloud foundation | 6 (G-CLOUD): S072, S073, S074, R2-072, R2-073, R2-075 | G-CLOUD 6 | **All 6 need the real GCP project**: Terraform, ingress/run.app bypass, workload identity, SQL pool budget, budget enforcement. Needs OA06/OA07 plus a cloud cost grant (none recorded). | B08 refers to B14 8 times | Terraform and plan work offline now; execution from owner day. |
| B15 real external integration | 9: R2-061, R2-133 (G-INTEGRATION); R2-082/083/084, CMD035 ×3 (G-FISCAL); R2-085 (**G-PAYMENT**, not in program gates) | G-INTEGRATION 2, G-FISCAL 6, G-PAYMENT 1 | **All 9 live**: PayPal Business live capture/refund/withdrawal (OA09, OA10), Alegra entitlement or DIAN-assisted bridge (OA05, OA11), Resend sender domain, webhook authenticity. | **Largest inheritance**: B09 case map mentions B15 44×, B07 26×, B10 10× | Adapters built (B09); live only after accounts. |
| B16 security & restoration | 61: G-TENANT 25, G-DELETE 19, G-SECURITY 9, G-RECOVERY 8 (**program/prompt omit G-TENANT**) | 4 gates | My estimate: about 16 need real cloud (R2-049 metadata-server IAM, R2-048 GCS signed URL after role change, R2-056 GCS soft-delete, S049 deployed pool, S065/R2-057/R2-126/R2-074/R2-076/CMD057 ×3 restore of a real backup, S076 scanner feeds). About 45 run locally on PG17 now. | B06 6×, B07 7×, B08 3× ("what B16 must still prove", `B06-case-map.md:151-160`) | **Yes, the local half now.** Not started. |
| B17 capacity & target qualification | 24: S033, S077 (G-CAPACITY); S078, R2-018..026, CMD018/019/040/041 ×3 (G-VENDOR) | G-CAPACITY 2, G-VENDOR 22 | S033/S077: 1M records **per mode** on the actual Batch host (policy `launchQualificationRecords` 1,000,000; RSS ≤ 6.01 GB qualification). S078 and R2-018..026: real importer (HubSpot Imports API, Salesforce Data Loader) with export-back (OA13; the MC ledger shows portal 51872453 DEVELOPER_TEST and SF Developer org `00Dak000018tvSeEAI` already in use). CMD018/019/040/041: 12 platform cases, local. | B06 4× | Platform commands now; importer reuse through an EquivalenceReceipt. |
| B18 final candidate & release audit | 11 (G-RELEASE): S079, S080, S088, R2-113, R2-114, CMD058 ×3, CMD059 ×3 | G-RELEASE 11 | Real image digest, real CI identity, release assets. Plus A6 §4: one exact-commit verify of the whole product on Windows, Linux and CI. Plus the journeys in manual 22 B18. | all | CMD058/059 domain now. |
| B19 production activation | 11: S081-S084, S087, S096, R2-109/110/111 (G-BUSINESS); S086, R2-119 (G-PRODUCTION) | G-BUSINESS 9, G-PRODUCTION 2 | Company/RUT, merchant, fiscal, OA12 instruments (terms, DPA, privacy) and legal review, OA15 activation consent, 30 min observation, 24 h responsibility. | — | Owner finance screens (S082/S083) can be built in B12. |

Live-evidence count (cases that cannot reach their final class without real external accounts): B04 11 (+8 inherited), B14 6, B15 9 (+about 80 inherited clause references), B16 about 16, B17 12 (+2 capacity on the real host), B18 11 (real artifacts), B19 11, B02 1-2. **Roughly 80 remaining cases plus the inherited clauses can only close after the owner accounts exist.** These form the true critical path to 19-Oct. The other ~170 can be executed locally now.

---

## 2. Findings

### authority-process-01 (critical, plan): B00 cannot be accepted, so nothing can become ACCEPTED
- **What:** B00 owns R2-115 ("Bare Claude report: the assistant observes … and prepares the next concrete mandate"), R2-116 ("Active mandate survives edition change"), R2-117 ("New IC main with repair claims") and R2-118 ("Personal action with guessed UI"). No case map for B00 exists in kauro-platform, MC or IC. `grep -rl "R2-115\|B00"` over all three `docs/` trees hits only `COMMERCIAL_AMENDMENT_A3.md`. The cases describe the ChatGPT-mandate loop that A4 retired ("Supersedes … every rule that required the autonomous construction service").
- **Evidence:** `program.json` B00 `dependsOn []`, B01 `dependsOn ["B00"]`, B14 `dependsOn ["B00","B05"]`; `22_BUILD_PROGRAM.md:15-30`; A4 "a package is not ACCEPTED before its dependencies"; `docs/acceptance/README.md` "Waiting for: B05 → B02, B04" (never mentions B00 or B01).
- **Impact:** quality: none today. Calendar: under a literal reading B18/B19 can never move a package to ACCEPTED. Found at B18, this means an emergency amendment plus re-review, about 1-2 days.
- **Recommendation:** adopt A7 §1 (text below). It maps R2-118 to the existing owner "ready to connect" sheet procedure (EXECUTED_LOCAL: the sheet plus the owner-action records). It maps R2-117 to the ledger rule that claims are never acceptance (the ledger tool refuses status without a review record). It gives R2-115 and R2-116 the manual-21 NOT_APPLICABLE-with-reason status: the mandate loop is retired by A4, and the builder's session-start recovery procedure is its consumer. Then write `docs/design/B00-case-map.md` and include it in the B05 review.
- **Executor:** builder writes the case map and A7 text; owner adopts A7 (one-line consent). **Effort:** 2 h.

### authority-process-02 (high, quality): registry gate/package mismatches leak into the Codex brief
- **What:** `program.json` gates differ from the gates carried by the package's own cases:
  - B02 lacks G-CAPACITY; B06 lists G-TENANT but owns none of its cases; B08 lacks G-DOMAIN; B11 lacks G-UX; B15 lacks G-PAYMENT; B16 lacks G-TENANT; B20 lacks G-COMMERCIAL.
  - In `gates.json`, the `package` field is wrong for G-DOMAIN (B06+B08), G-PAYMENT (B09+B15), G-COMMERCIAL (B10+B20) and G-CAPACITY (B02+B17).
  - `prompts/B16_*.md` says "Closure gates: G-SECURITY, G-RECOVERY, G-DELETE" while 25 of its 61 cases are G-TENANT.
- **Evidence:** I ran `node tools/package-brief.mjs B16 --json`: gates `['G-DELETE','G-RECOVERY','G-SECURITY']`, commands `['CMD042','CMD054','CMD055','CMD056','CMD057','CMD060']`. CMD003/004/005/006/007/038 are missing, yet B16 owns their 18 cases. `B11 --json`: commands `[]` although B11 owns CMD044-OK/DENY/RACE. Cause: `package-brief.mjs` filters `gates` and `commands` by `pkg.gates`. `package-review.sh` passes `briefs.md` to Codex as "the authority excerpt per case". The B06 case map already works around it by hand (`B06-case-map.md:151-160`), and the B11 case map does too (CMD044 row).
- **Impact:** the builder and Codex miss command preconditions, idempotency and effects for 21 cases (B16 18, B11 3), plus the G-TENANT evidence rule. That makes a rejection round (0.5-1 day) or an accepted gap likely. It also creates ambiguity about which package's acceptance "closes" G-TENANT.
- **Recommendation:** (1) Change `package-brief.mjs` to take gates as the union of `cases[c].gate` for the package's caseIds, and commands as every command whose triad ids are in caseIds. Add a test asserting this for every package. Keep the registry byte-identical. (2) Adopt A7 §2: membership of `program.json caseIds` is authoritative. A gate is closed when every one of its cases has its required final class in the ledger. The `program.json gates` and `gates.json package` fields are informational.
- **Executor:** separate_session (tool fix, no collision with the B10 lanes). **Effort:** 1.5 h.

### authority-process-03 (high, process): the 441-case ledger required by A4 does not exist
- **What:** A4: "The 441-case ledger is computed by a tool in `kauro-platform` from the case maps and the review records; it is the only ledger." No such tool exists: `grep -rn "441\|ledger" tools/*.mjs` hits only domain code. `docs/acceptance/README.md` is a hand table for B06-B09 only. `tools/evidence.mjs` seals only `B06-case-map.md` and `B09-case-map.md` (`CASE_MAPS`, lines 33-36). The only bundle on disk is `docs/evidence/b06/0cce2f02f8b0-*`. MC and IC keep their own case maps and ledgers (`MC docs/ACCEPTANCE_LEDGER.md`, IC `docs/design/B03-case-map.md`, `B04-case-map.md`).
- **Impact:** B18 has to prove that every launch requirement is accounted for across three repos and 433 cases. Doing it by hand at the end costs about 1 day and is error-prone. Without the tool, the cascade of REVIEW_ACCEPTED → ACCEPTED when B04/B05 land is also manual.
- **Recommendation:** build `tools/ledger.mjs`. Inputs: every `docs/design/B*-case-map.md` in the platform, plus the MC and IC case maps (fetched at pinned commits), plus `docs/acceptance/reviews/*.json` and the equivalent review records in the cores. Output: per case, the strongest class across all case maps that cite it (to handle inherited clauses, finding 05), the accepting review id, the commit, and per-package status (ACCEPTED / REVIEW_ACCEPTED / OPEN) computed from program.json dependencies. Fail when a case is missing from every map, when a map cites a case outside its package without an "inherited clause" marker, or when a PASS claim has no review. Extend `evidence.mjs CASE_MAPS` to all case maps. Generate `docs/acceptance/README.md` from the ledger.
- **Executor:** separate_session. **Effort:** 6-8 h.

### authority-process-04 (high, speed): duplicate full verifies of the same exact commit
- **What:**
  - A6 §3 makes the CI `verify` workflow (ubuntu + windows-latest) the verify of record at close and keeps "the local Windows verify … for package close only".
  - `tools/review/package-review.sh` step (1) clones the ref and runs a full `pnpm run verify` in WSL before **every** Codex call, full reviews and re-checks alike, because `make-prompt.py` says Codex "cannot build … rely on `verify.log`".
  - So one close costs CI ubuntu + CI windows + local Windows (45-60 min) + WSL harness (15-40 min). Each recheck round costs a further WSL verify, plus CI on the fix commit.
  - The shared context counts about 35 full local verifies since 1-Oct, about 20 of them avoidable.
- **Evidence:** `package-review.sh` lines 29-39 (`PGBIN=... pnpm run verify > "$OUT/verify.log"`); A6 §3; `make-prompt.py` line 37.
- **Impact:** each redundant verify is 15-60 min of machine time and a stall point. Over 11 remaining closes with about 2 rounds each: roughly 1-1.5 days. Quality is unchanged, because the commit and the tests are identical.
- **Recommendation:** adopt A7 §4, "one verify of record per OS per exact commit, from any trusted runner, with a receipt (commit, tree, runner, run id/attempt, exit, junit digest)". Change `package-review.sh` to accept `--verify-receipt <dir>`, i.e. the CI run's junit/verify artifact or a ci-local/evidence.mjs bundle of the same SHA, and run its own verify only when no receipt exists for that SHA. A local Windows verify is needed only when the CI windows leg did not run on that SHA (minutes exhausted). Rechecks reuse the receipt of the fix commit's CI.
- **Executor:** builder (harness on the PC). **Effort:** 3 h.

### authority-process-05 (high, plan): A6 "touched" and the inherited PARTIAL clauses are undefined
- **What:** A6 §2: no new verify or review of an accepted package "unless a later diff touches its files or its registry cases". `git diff --name-only 4b33e26 4f99a67` shows 655 files changed since B06/B07/B09 acceptance, including shared files of B06/B08 (`apps/api/src/composition.ts`, `http.ts`, `sessions.ts`, `authenticator.ts`, `apps/control/src/audit/*`, `apps/control/src/execution/*`) and payment support (`apps/api/test/payment-support.ts`). Separately, accepted case maps hold PARTIAL rows whose final clause is owned by a later package: B06 11, B07 12, B08 8, B09 23, B03 8 (to B04), B10 10. When B15 brings EXECUTED_PROVIDER evidence for a B09 case, that "touches its registry case".
- **Impact:** a literal reading reopens B06/B08/B09 at almost every merge and again when B15/B16 promote their cases. That means about 5-10 extra diff reviews plus disputes over status, roughly 1-2 days. A loose reading risks unreviewed changes to accepted code, but today the later package's own Codex review covers the same diff anyway.
- **Recommendation:** adopt A7 §3 (text below). A later package that changes an accepted package's files includes that diff, and its effect on the earlier package's cited tests, in **its own** review, scoped to the diff. The earlier package stays bound to its acceptance commit while every cited test of its case map passes in CI. Inherited clauses are listed in an "Inherited clauses" section of the later package's case map, reviewed there, and the ledger (finding 03) computes the case's final class. No separate re-review of the earlier package. The earlier package is reopened only when one of its cited tests is changed, weakened or deleted, or when one of its case-map rows changes.
- **Executor:** owner adopts (consent); builder applies in case maps and the review prompt. **Effort:** 1 h.

### authority-process-06 (high, speed): B10 matrix GAPs are mostly generic mechanism cells
- **What:** `B10-failure-matrix.md` has 162 GAP cells. By code: CMD_TMO 26, SWEEP_CRASH 16, CMD_CRA 15, SWEEP_TMO 7, CONS_TMO 6, CONS_CRA 5, CONS_CRB 5, SWEEP_RACE 5, TEN_REV 5, LEASE_TMO 2, …; about 87 cells (54%) belong to shared mechanisms (idempotency journal replay after lost response, lock/statement timeout handling, sweep crash-resume, consumer redelivery, authority check at the write). The template (`FAILURE-MATRIX-TEMPLATE.md`) requires one test per cell. It has no rule for covering a shared mechanism with one parametrized test.
- **Impact:** at the observed pace (lanes 3-5 closed 10-21 cells each, about half a day per lane plus Codex rounds), 162 cells is 4-6 more lane-days while B12, B13, B14 and B16 have not started. That is risk 9 in the shared context.
- **Recommendation:** adopt A7 §6 (shared-mechanism coverage). A cell whose expected behaviour is produced entirely by a shared mechanism is **C** when (a) one parametrized harness test injects that fault for **every** command/sweep/consumer in an enumerated list derived from code (`matrix.mjs` or the route table), asserting each one's own outcome, and (b) a static or architecture check fails when a new writer bypasses the mechanism. Rule 5 of the template still applies: replay does not prove CRASH-AFTER, so the injection must be real. Tier-1 money/authority cells that depend on command-specific state (PAY_*, CLOSE_*, FUNDS_*, CONV_*) keep their dedicated tests. Expected: about 6 mechanism tests close about 87 cells; the remaining ~75 specific cells keep the current method.
- **Executor:** builder. **Effort:** 8-12 h (vs about 30-40 h cell by cell).

### authority-process-07 (high, process): the Codex loop discovers one defect family per round
- **What:** rounds B07 7, B09 5, B06 3, B08 3, MC dossier 4, B10 lanes 2-4 each. B07-R1 was "partially fixed" in r2, r3 and r4, each time for a new interleaving of the same hold/release race (`B07-round2..4` summaries). `make-prompt.py` asks for per-case review and defects, but never for a sweep of all analogous paths once a family is found. The recheck forbids new non-blocking findings, which is right, but nothing forces a root-cause fix after a PARTIALLY_FIXED verdict. `incidents.md` (2026-10-03 fault-harness row) already discovered "two rejections for one cause → root-cause fix", but only as a builder habit. A4 also says "Codex only for package-close reviews", yet `tools/review/prompts/` holds about 32 non-close prompts (b10-gaps-1..5 with rechecks, fault-harness ×3, ic-ci-budget ×3, ic-sabotage-reuse ×2, mc-300-dossier ×4, b11-sync, harness-mustwait). Some of these were high-yield: the B10 matrix design review gave 17 findings before code, and lane 4/5 rechecks found 7 product defects.
- **Impact:** each extra round is about 0.5 day (fix, verify, review), and per-lane reviews multiply rounds. Reducing rounds from about 4 to about 2 per package over B10-B17 saves about 2-4 days. Quality goes up, because families are closed whole.
- **Recommendation:** adopt A7 §5 and change the prompt:
  1. Allowed review types: (a) one **design-time review** per package of design + failure matrix before code; (b) the package-close review; (c) a lane review only for tier-1 money/authority code; (d) re-checks.
  2. The full-review prompt adds: "For each defect, name its family (race, timeout, expiry, crash-before/after, retry/duplicate, revocation/fencing, partial failure, weak test) and list **every** other code path in the package with the same pattern, each with file:line, in the same answer."
  3. A PARTIALLY_FIXED finding requires a family sweep plus a new matrix family rule before the next round (the fault-harness rule, made normative).
  4. A weak-test check is added to the review: "a test that passes with the protection removed is a finding". The builder can automate this with the existing sabotage habit: a revert-the-fix check per regression test.
- **Executor:** builder (prompt and template), owner consent for the A4 wording change. **Effort:** 2 h.

### authority-process-08 (high, plan): open owner decisions that will stall live work
- **What and evidence:**
  1. **B04 funding:** `B04-campaign-envelope.md` §6: "Campaign hard cap: USD 123 (A 25 + B 98) on the Sonnet path; USD 221 … Gap against A4's API budget of USD 20/month: USD 103 / USD 201". Also "Conflict to decide: the owner's 'no bank/card' fact" (§7.1). A4 Resources: "API budget USD 20/month. No paid spend … without an owner-approved bounded grant."
  2. **Opus vs Sonnet:** if the pilot selects Opus, "needs a new approval and the release that bumps the pinned policy" (§6). That is a second stall mid-campaign.
  3. **Cloud grant** for B14/B16/B17 (Cloud Run, Batch 1M-record runs per mode, Cloud SQL backup/restore test): no grant is recorded anywhere (A4, OA07).
  4. **Fiscal route cutoff:** `15_PAYMENTS_AND_TAX.md:119-123` allows the DIAN/manual-assisted bridge "if that verified plan does not fit or cannot be activated by the relevant deadline". No deadline is set.
  5. **Publication authority:** `RELEASE_NOTES_3.0.0.md` "Nothing in the repository publishes anything". MC case map R2-017: "The real run is EXECUTED only after the owner authorizes publication". MC PR #16 is `mergeable_state: clean`, last updated 2026-10-04T20:42:59Z, and still unmerged.
  6. **Legal review of instruments** (OA12; manual 30 "Use qualified local review where legal applicability cannot be established"): no owner or budget for a review of the US-agency DPA/terms.
  7. **Dates:** A4 "production target 2026-10-23"; the owner's goal of 19-Oct with margin is not in the authority.
- **Impact:** each item becomes a stop of hours to days on the critical path (B04 → B05/B15; B14 → B16/B17; B15 → B18). Taken together, about 2-4 days of avoidable waiting.
- **Recommendation:** the builder prepares one Spanish "decision sheet" with these 7 items, each with the recommended answer, the amount, and the stop rule already enforced in code. The owner answers once by 2026-10-07. Proposed defaults: grant A USD 25 and grant B pre-approved up to USD 98 (Sonnet) with automatic extension to USD 196 if the pilot's selection record picks Opus under the existing lexicographic rule; cloud grant capped (builder computes it from B14 plans); fiscal cutoff 2026-10-12 (if Alegra API emission is not verified in the real account by then, use the bridge for launch); Claude authorized to merge, tag and publish GitHub releases of the three repos once A4 (b)-(d) hold; legal review budget or explicit owner acceptance of the reviewed templates; internal target 19-Oct recorded as planning target with 23-Oct/28-Oct unchanged. Record the answers as A7 §7-§8.
- **Executor:** builder prepares (2 h); owner decides (15-30 min). **Effort:** 2.5 h total.

### authority-process-09 (high, plan): start B16's local half now; it is 14% of the registry
- **What:** B16 has 61 cases. Most are platform-local: membership triads CMD003-007 (15), AuthorizeDownload CMD038 (3), RequestDeletion CMD042 (3), RetentionExtension CMD060 (3), breakglass CMD054/055 (6, local half), RecordIncident CMD056 (3), retention/extension R2-053/054/055, R2-123/124/125, S050, S063, S094, R2-047 (runtime role, local PG), R2-060 (cursor), R2-050. `B06-case-map.md:151-160` already lists "what B16 must still prove". Only the real-cloud items (estimate about 16) need B14. B16 formally depends on B15, but A4 allows construction ahead of formal acceptance.
- **Impact:** if B16 starts after B15 (about 16-17 Oct by the old route), 61 cases plus restore must close in about 2 days before B18. Starting the local half now removes about 2-3 days from the critical path.
- **Recommendation:** open a B16-local lane now. Write `docs/design/B16-case-map.md` with every row classed EXECUTED_LOCAL-target or CLOUD-REQUIRED (naming B14 resources), plus its failure matrix (this is the case that benefits most from the design-time review in finding 07). Keep the cloud rows PLANNED until B14 exists.
- **Executor:** separate_session or a builder lane (separate files: membership/retention/deletion modules). **Effort:** design 4 h; implementation 2-3 days of lane work.

### authority-process-10 (medium, quality): `requiredEvidence` has no written mapping for test-based cases
- **What:** every case requires 8 evidence items, including `input_manifest`, `presealed_expected_truth` and `external_effect_identity`. Case maps record only case | test | class | commit (A4: "Written records are short: case, test, commit"). `tools/evidence.mjs` header comment does map them (truth.json, environment.json, inputs.json, junit, cases.json, MANIFEST), but only for B06 and B09. `EVIDENCE_AND_CI_PROTOCOL.md` still describes a 16-section narrative dossier per report. The prompts still ask for "complete gate dossier, fixture/truth and command manifests … final report following manual 23" (for example `prompts/B16_*.md` "Deliverables").
- **Impact:** at B18 a reviewer reading the prompts and the registry literally could demand dossiers and narrative reports for 433 cases. That means rework or a dispute, about 1 day. Meanwhile the builder spends tokens on prose the A4 model no longer needs.
- **Recommendation:** adopt A7 §4 mapping: for a test-based case the 8 items **are** the `evidence.mjs` bundle of the exact commit plus the Codex review JSON (mapping table in A7 §4). `external_effect_identity` = "none" for EXECUTED_LOCAL/SIMULATED; provider request/response identities for EXECUTED_PROVIDER. Declare prompt "Deliverables" and manual 23 report sections satisfied by that bundle; no narrative dossier. Extend `evidence.mjs` to every case map (finding 03).
- **Executor:** builder (A7 text), separate_session (tool). **Effort:** 1 h text + 2 h tool.

### authority-process-11 (medium, plan): the B18 review scope is undefined
- **What:** B18 has 11 cases plus "complete cross-domain acceptance … all launch requirements accounted for" (`program.json` B18 scope), and A6 §4 requires one whole-product exact-commit verify. Nothing says what the B18 Codex review covers. Re-reviewing 433 cases in one Codex session is infeasible and would contradict A6 §1-2.
- **Impact:** without a rule, B18 either becomes a multi-day mega-review or a reviewer rejects it for incompleteness. About 1-2 days at the worst possible time.
- **Recommendation:** A7 §9: the B18 review = B18's 11 cases + the ledger integrity check (finding 03) + the diff of every accepted package since its acceptance commit, limited to files no later package's review covered + the manual-22 B18 journeys (repeated agency with a new client, refund after payout, valid quote with expired files, staged retention, cancellation, restore). Split it into 2-3 Codex sessions by domain if needed.
- **Executor:** builder (text), owner consent. **Effort:** 1 h.

### authority-process-12 (medium, process): stale normative text is still loaded and not marked superseded
- **What:**
  - `23_CLAUDE_REPORT_AND_MANDATE_PROTOCOL.md` (ExecutionBinding, mandate body, report schema, "Construction model and effort selection" recommending GPT-6 Astra/Opus 5) and `30_PROJECT_INSTRUCTION.md` (ChatGPT issues mandates; "A bare Claude report triggers the complete process") are not marked superseded.
  - Neither is `CH-009` in `01_CHARTER.md:31` ("ChatGPT … prepares the next concrete mandate"), the prompt boilerplate "TEMPLATE_REQUIRES_LIVE_BINDING … include COMMON_EXECUTION and an actually reviewed ExecutionBinding", or `EVIDENCE_AND_CI_PROTOCOL.md:3` ("Claude must produce and ChatGPT must independently review").
  - Only the three `route/` files carry an A4 note.
  - `29_STATE_AND_TRANSITION.md` "Adopted amendments" lists A2-A4; A5 and A6 are missing. Its "Current acceptance" section is stale.
  - A5 cites "the owner's standing delegation of design decisions (2026-09-25, confirmed 2026-09-28)", but that delegation is recorded nowhere in the authority. `grep -rn delegat` finds no record.
- **Impact:** subagents and Codex read these files (A3 §1.3 notes reviewers "read the installed R2 manuals … directly"), which causes misdirected work and review disputes. The unrecorded delegation is why design questions get escalated to the owner. About 0.5-1 day across the remaining packages.
- **Recommendation:** A7 §10: a supersession table naming the sections of 01 (CH-009 roles), 23, 30, EVIDENCE_AND_CI_PROTOCOL (reviewer identity, report sections) and the prompt boilerplate replaced by A4/A6/A7. Record the standing design delegation verbatim, with its limits: no change to cases, thresholds, prices, scope or paid spend. Add A5-A7 to 29.
- **Executor:** builder. **Effort:** 1.5 h.

### authority-process-13 (medium, speed): B17 can reuse existing real-importer evidence
- **What:**
  - Authenticated real tenants already exist and have been used: HubSpot portal 51872453 (DEVELOPER_TEST) and Salesforce Developer org `00Dak000018tvSeEAI`, with 5 vendor gates bound to MC code `b25ac498201ed6d3` (`kauro-migration-core/docs/ACCEPTANCE_LEDGER.md`, third layer).
  - Manual 21 "Evidence reuse" and `EVIDENCE_AND_CI_PROTOCOL.md` "Evidence equivalence record" allow reuse through an EquivalenceReceipt when transitive inputs are unchanged.
  - R2-018..026 concern importer semantics (foreign IDs, add vs replace, null markers, partial parent success, receipts).
  - CMD018/019/040/041 (12 cases) are platform commands and can be done locally now.
- **Impact:** if B17 is planned as a full fresh vendor campaign after B15, it competes for the last 3 days. Classifying it now saves about 1-2 days.
- **Recommendation:** in the B17 case map, mark each vendor case as (a) reusable through an EquivalenceReceipt against MC `b25ac498…` → 3.0.0 (only where the MC diff does not touch that path; otherwise re-run), (b) re-run on the same tenants, or (c) platform-local. Implement CMD018/019/040/041 in a lane now. Keep the 1M-per-mode capacity runs (S033/S077) on the real Batch host; they cannot be reused from the PC (manual 21 "Resource qualification").
- **Executor:** separate_session (case map + equivalence analysis), builder (commands). **Effort:** 4 h analysis.

### authority-process-14 (low, quality): A2 rules 3 and 5 contradict each other in `cases.json`
- **What:** A2 rule 3: "The vendored registry files … remain byte-identical to the authority." A2 rule 5 rewrote the authority text to "Kauro". Result: `authority/r2/registry/cases.json` sha256 `5758b185…` ≠ vendored `b0a7960d…` (`PROVENANCE.json`); the only difference is the R2-070 `scenario` ("Kauro's" vs "Kavo's"). `program.json` and `gates.json` are identical.
- **Impact:** a G-FACTS/B18 provenance check comparing hashes fails on a cosmetic difference, and someone has to investigate. About 1 hour.
- **Recommendation:** A7 §11: the vendored hashes in `PROVENANCE.json` are the normative registry; differences that are brand-only text under A2 rule 5 are recorded as a list (currently R2-070.scenario). No re-vendoring.
- **Executor:** builder. **Effort:** 0.5 h.

### authority-process-15 (low, plan): the formal chain B05 ← B04 makes 8 packages wait on a paid campaign
- **What:** B05 depends on B02 and B04, and B06-B13 depend on B05. So B06-B09, which already have Codex ACCEPT, stay REVIEW_ACCEPTED until the funded B04 campaign passes its thresholds and IC is published.
- **Impact:** no construction delay, because A4 lets construction run ahead. The status flip is cosmetic once the ledger tool computes it. The risk is only that a B04 threshold failure (supported <0.97 in one run) means re-runs, a re-release and B05 re-consumption late in the calendar.
- **Recommendation:** no rule change. Keep the dependency, because quality needs the qualified IC bytes consumed. Make sure the ledger (finding 03) flips statuses automatically. Plan B05 integration against the IC release candidate now, so that after B04 only the version pin and clean-consumer check change.
- **Executor:** builder. **Effort:** 0 h extra.

---

## 3. Proposed amendment A7 (text ready for owner adoption)

> # Amendment A7 — acceptance mechanics under A4/A6
>
> Status: proposed 2026-10-05; binding on owner consent. Amends A4 "Package acceptance" and A6 §2-§4. It does not change the 441 cases, any expected outcome, any evidence class, any policy threshold (including policy.json `intelligence`, `capacity` and `input` limits), any price or the scope. Nothing simulated counts as live.
>
> **§1 B00 under A4.** B00 closes with its case map `docs/design/B00-case-map.md`:
> - R2-118 is EXECUTED_LOCAL by the owner "ready to connect" sheet and the owner-action records (each act prepared with destination, fields, cost and proof before it is requested).
> - R2-117 is EXECUTED_LOCAL by the ledger tool, which refuses any case status without a review record, so claims are never acceptance.
> - R2-115 and R2-116 are NOT_APPLICABLE with this reason: the mandate loop they test was retired by A4 on 2026-09-29. Their consumer is the builder's session-start recovery procedure, and it is reviewed with B00.
>
> B00 is reviewed together with the next package close.
>
> **§2 Case ownership and gate closure.** The package that lists a case in `program.json caseIds` executes it. A gate is CLOSED when every case listed in `gates.json caseIds` for it has its required final class in the ledger, whichever packages own them. The `gates` field of program.json, the `package` field of gates.json and the "Closure gates" line of the prompts are informative. Briefs derive gates and commands from case membership.
>
> **§3 Bound acceptance and later diffs (A6 §2 clarified).**
> - (a) A later package's diff to files of an accepted package is reviewed in the later package's review, scoped to that diff. It does not reopen the accepted package while every test cited by that package's case map exists unchanged and passes in CI.
> - (b) The accepted package is reopened only when one of its cited tests is changed, weakened or removed, or when one of its case-map rows changes. The re-review is then limited to that change.
> - (c) A clause that an accepted case map leaves PARTIAL to a later package is listed in the later package's case map under "Inherited clauses". It is evidenced and reviewed there. The ledger gives each case the strongest class demonstrated across all case maps and the review that accepted it.
>
> **§4 One verify of record; evidence form.**
> - (a) For an exact commit, one full verify per operating system (Linux and Windows), from any runner the builder controls or GitHub-hosted, is the verify of record. It needs a receipt: commit, tree, runner, run id and attempt, exit, JUnit digest. Reviews and re-checks use that receipt and do not run another verify of the same commit. A local Windows verify is required only when no Windows verify of record exists for that commit.
> - (b) For a test-based case, the eight `requiredEvidence` items are satisfied by the `tools/evidence.mjs` bundle of the exact commit plus the review record:
>
>   | Item | Satisfied by |
>   |---|---|
>   | exact_subject_and_environment | environment.json |
>   | input_manifest | inputs.json and the fixtures at that commit |
>   | presealed_expected_truth | truth.json, sealed before the run, plus the test-first commit of the cited test |
>   | actual_public_result | junit and cases.json |
>   | external_effect_identity | "none" for EXECUTED_LOCAL or SIMULATED; provider request and response identities for EXECUTED_PROVIDER |
>   | exit_status | results.json |
>   | artifact_digests | MANIFEST.sha256 |
>   | independent_review | the Codex review JSON |
>
>   Manual 23 report sections, prompt "Deliverables" and the EVIDENCE_AND_CI_PROTOCOL narrative dossier are satisfied by this bundle. No narrative dossier is required. Live campaigns (B04, B14-B17) keep their receipts as defined in manual 21.
>
> **§5 Review types.** Codex is used for:
> - (a) one design-time review per package, of design and failure matrix, before implementation;
> - (b) the package-close review;
> - (c) a lane review only for tier-1 money or authority code;
> - (d) re-checks.
>
> A full review lists, for each defect, its family and every analogous path in the package. A finding judged PARTIALLY_FIXED once requires a family-wide root-cause fix and a new matrix family rule before the next round. A test that passes with its protection removed is a finding.
>
> **§6 Shared-mechanism coverage.** A failure-matrix cell whose expected behaviour is produced entirely by a shared mechanism (idempotency replay, lock or statement timeout, sweep resume, consumer redelivery, authority check at the write) is covered when:
> - (i) one parametrized test injects the real fault for every member of a code-derived enumeration of the commands, sweeps or consumers using that mechanism, and asserts each one's own outcome; and
> - (ii) an architecture check fails when a new member bypasses the mechanism.
>
> Cells that depend on command-specific state keep dedicated tests. A package with a failure matrix is accepted only when every cell is C or N/A.
>
> **§7 Standing delegation.** The owner's delegation of design decisions (2026-09-25, confirmed 2026-09-28) is recorded here. Claude decides implementation and design questions within R2 and records each in the package design document with a decision id. It may not change cases, expected outcomes, thresholds, prices, scope, legal commitments or paid spend. The owner may revoke any decision.
>
> **§8 Pre-agreed operating decisions (owner answers in the 2026-10-07 sheet).**
> - (a) B04 grants: A USD 25; B up to USD 98 on the Sonnet path, extended to USD 196 if the pilot's recorded selection is Opus under the existing selection rule. The stop rules of B04-campaign-envelope §6 apply.
> - (b) Cloud grant for B14, B16 and B17 up to the amount in the sheet, with application-level caps.
> - (c) Fiscal route: if Alegra API emission is not verified in the real account by 2026-10-12, launch uses the DIAN-assisted bridge of manual 15.
> - (d) Claude may merge, tag and publish GitHub releases of the three repositories when A4 (b)-(d) hold. Each publication is reported.
> - (e) Planning target 2026-10-19; official target 2026-10-23 and deadline 2026-10-28T05:00Z unchanged.
>
> **§9 B18 review scope.** The B18 review covers:
> - B18's eleven cases;
> - the ledger integrity check;
> - each accepted package's diff since its acceptance commit, where no later review covered it;
> - the manual-22 B18 journeys.
>
> It may be split by domain. It is not a re-review of accepted packages.
>
> **§10 Supersession.** These are replaced by A4, A6 and this amendment, and are kept only as provenance:
> - in manual 01, the CH-009 role split for mandates;
> - in manual 23, everything except owner action cards and capability honesty;
> - manual 30 as a construction instruction;
> - in EVIDENCE_AND_CI_PROTOCOL, the reviewer identity and the report-section table;
> - in prompts B00-B21, the ExecutionBinding and "final report following manual 23" lines.
>
> Manual 29 lists A5, A6 and A7.
>
> **§11 Registry identity.** The hashes in `packages/contracts/registry/PROVENANCE.json` identify the normative registry. Brand-only text differences produced by A2 rule 5 are listed (currently `cases.json` R2-070 `scenario`) and are not drift.

---

## 4. Process overhead that can be cut without lowering quality (summary)

| Overhead | Where | Cut | Quality effect |
|---|---|---|---|
| Re-verify of the same SHA by the review harness and by local Windows after CI | `package-review.sh` step 1; A6 §3 | Verify-of-record receipt (A7 §4) | None (same commit, same tests) |
| Separate re-reviews of accepted packages for diffs that a later review already covers | A6 §2 literal reading | A7 §3 | None (each diff still reviewed once) |
| Single-cell tests for shared-mechanism cells (about 87 of 162) | B10 matrix | A7 §6 parametrized mechanism tests | Higher (enumeration catches future writers) |
| Rounds that each find one family | Codex prompt | Family sweep + root-cause rule (A7 §5) | Higher |
| Narrative dossiers and prose in case maps and design docs (11,771 lines in `docs/design/*.md`) | Prompts' Deliverables, EVIDENCE protocol | Evidence bundle = record (A7 §4) | None |
| Hand-maintained acceptance README; manual case cascade | `docs/acceptance/README.md` | Generated ledger | Higher (machine-checked) |
| Owner escalations for design questions and amounts | A5 cites an unrecorded delegation | A7 §7-§8 | None |

Already fixed and worth keeping: A6 stopped the re-confirmation reviews at new commits. Before A6 there were about 6-7 such reviews: B06 r3, B07 r6/r7, B08 r3, B09 r3/r4/r5, all "remain FIXED".

---

## 5. Strengths to keep

- **Honest evidence classes, consistently applied.** SIMULATED is never presented as EXECUTED_PROVIDER: B04 live rows print `SKIPPED_NEEDS_LIVE` and are "not counted", and the B07/B09 provider clauses are deferred to B15 by name. Codex confirms this in every accepted review.
- **Mechanically checked case maps.** `tools/test/b10-case-map.test.mjs` (and its B03/B11 equivalents) refuses a cited title that does not exist, and requires PLANNED rows to name the mandate that writes the test. The links between case, test and commit are machine-verified.
- **The failure-matrix template with learned family rules** (`FAILURE-MATRIX-TEMPLATE.md`, rules 1-10). It turns Codex findings into reusable rules. Lanes 4 and 5 found 7 real product defects (deadlocks, funds fence) before any reviewer did.
- **A6 acceptance binding.** It removed redundant re-reviews and full re-verifies of accepted packages.
- **The B04 campaign design:** exact corpus reservation, hard caps, per-request admission, stop rules, an owner sheet with exact steps, and SIMULATED rehearsal refused as qualification. This is the right pattern for every paid or live campaign (B14, B15, B17).
- **A5 split pattern** (core half vs platform half of one case). It is a clean precedent for cross-repository cases and should be reused for B17 (MC importer semantics vs platform commands).
- **`incidents.md` "verify before spending"** with a cheap check added for each incident.
- **Review records archived per round as JSON** (`docs/acceptance/reviews/`), with commit and verdict. These are the raw input the ledger needs.
- **Vendored registry with hash provenance**, plus `package-brief.mjs` that reads it directly instead of paraphrasing.

---

## 6. Owner-only acts implied by this report (for the 2026-10-07 sheet)

1. Consent to A7 (or to the selected sections).
2. B04 grants A and B (amounts above) and the payment method for Cloud Billing (the conflict with "no bank/card" in envelope §7.1).
3. Cloud grant for B14/B16/B17.
4. Fiscal cutoff date.
5. Publication authority for MC 3.0.0 and the IC release (or merge MC PR #16 personally if that is what branch protection requires).
6. Legal review route for OA12 instruments.
7. Record the 19-Oct planning target.
