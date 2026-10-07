# Amendment A7 — acceptance mechanics under A4/A6 (DRAFT for the owner, decision D-06)

Status: **draft**, prepared on 2026-10-07 from audit `audit/authority-process.md` §3 (2026-10-05, reference copy on branch
`docs/audit-ref`), with the corrections of the verifiers recorded in `audit/INFORME_AUDITORIA.md` (§4, §5.6, §8) and the owner
decisions in force on 2026-10-07 (A8, A9, D-03, D-05, D-07, D-08). B reviews it and presents it to the owner. It binds only once
the owner signs it. Until then it describes the tools already built (`tools/ledger.mjs`, `tools/acceptance-touch.mjs`,
`tools/package-brief.mjs`) and does not change how any package is accepted.

**What A7 does not change.** No registry case, expected outcome, evidence class, policy threshold (including `policy.json`
`intelligence`, `capacity` and `input` limits), price, scope or live-evidence requirement changes. Nothing simulated counts as
live. Isolation, RLS, fencing, idempotency, retention, deletion and security are not lowered. Each section below either removes
duplicate work on the same exact commit or settles an ambiguity that already causes rework.

---

## §1 B00 under A4

B00 closes with its case map `docs/design/B00-case-map.md`, reviewed together with the next package close.

- **R2-116** is EXECUTED_LOCAL. The evidence is the edition transition record `docs/acceptance/ledger/transition.json`: R2 → A4,
  A5, A6, A8, A9, each prospective, with the `PROVENANCE.json` hashes, and the packages accepted before A8/A9 keeping their
  accepted subject. Tests: `tools/test/ledger-b00.test.mjs`.
- **R2-117** is EXECUTED_LOCAL. The evidence is the ledger rule that a claim is never acceptance: README statuses and case-map
  rows are claims, and the ledger refuses an acceptance without a review record.
- **R2-118** is EXECUTED_LOCAL once the owner's "ready to connect" sheet exists and its test passes. Each owner act in the sheet
  is prepared with its current destination, fields, cost and receipt before the act is requested. Until then it is NOT_EXECUTED.
- **R2-115** — *owner's choice.* It is NOT_APPLICABLE (manual 21, with reason) only if the owner signs this clause. The reason:
  the bare-report mandate loop it tests was retired by A4 on 2026-09-29, and its remaining consumer is the builder's
  session-start recovery procedure, which is reviewed with B00. Without the signature the case stays NOT_EXECUTED and B00 cannot
  close.

*Correction to the audit text:* the audit proposed NOT_APPLICABLE for both R2-115 and R2-116. R2-116 has executable evidence
(the transition record), so it is executed, not excused. Only R2-115 depends on the owner.

## §2 Case ownership and gate closure

The package that lists a case in `program.json caseIds` executes it. A gate is CLOSED when every case that `gates.json caseIds`
lists for it has its required final class in the ledger, whichever packages own those cases. The following are informative:

- the `gates` field of `program.json`;
- the `package` field of `gates.json`;
- the "Closure gates" line of the prompts.

Briefs derive gates and commands from case membership. `tools/package-brief.mjs` already does this, with a test over the 22
packages: B16 now carries G-TENANT with CMD003–CMD007 and CMD038, and B11 carries CMD044.

## §3 Bound acceptance and later diffs (A6 §2 clarified)

- (a) A later package's diff to files of an accepted package is reviewed in the later package's review, scoped to that diff.
  The diff does not reopen the accepted package while every test cited by that package's case map exists unchanged and passes
  in CI.
- (b) An accepted package is reopened only when one of its cited tests is changed, weakened or removed, or when one of its
  case-map rows changes. The re-review is limited to that change.
- (c) A clause that an accepted case map leaves PARTIAL to a later package is listed under "Inherited clauses" in the later
  package's case map, with `inheritedTo` on the sidecar row, and is evidenced and reviewed there. The ledger gives each case the
  strongest class demonstrated across all case maps, with the review that accepted it.
- (d) `node tools/acceptance-touch.mjs <accepted-sha>..HEAD` lists the accepted packages whose files or cases a range touches.
  It reports separately the changes that reopen a package under (b).

## §4 One verify of record; evidence form

- (a) For an exact commit, the verify of record is one full verify per operating system (Linux and Windows), from a
  GitHub-hosted runner or one the builder controls. It needs a receipt: commit, tree, runner, run id and attempt, exit status,
  JUnit digest. Reviews and re-checks use that receipt and do not run another verify of the same commit. Under D-03, Windows
  runs in CI only on the final candidate and on `main`, and `success` is required on the final SHA. A green CI Windows run on
  the exact SHA is the Windows verify of record. A local Windows verify is required only when no Windows verify of record exists
  for that commit.
- (b) For a test-based case, the eight `requiredEvidence` items are satisfied by the `tools/evidence.mjs` bundle of the exact
  commit plus the review record:

  | Item | Satisfied by |
  |---|---|
  | exact_subject_and_environment | environment.json |
  | input_manifest | inputs.json and the fixtures at that commit |
  | presealed_expected_truth | truth.json, sealed before the run, plus the test-first commit of the cited test |
  | actual_public_result | junit and cases.json |
  | external_effect_identity | "none" for EXECUTED_LOCAL or SIMULATED; provider request and response identities for EXECUTED_PROVIDER |
  | exit_status | results.json |
  | artifact_digests | MANIFEST.sha256 |
  | independent_review | the Codex review JSON |

  This bundle satisfies the manual 23 report sections, the prompts' "Deliverables" and the EVIDENCE_AND_CI_PROTOCOL narrative
  dossier, so no narrative dossier is required. Live campaigns (B04, B14–B17) keep their receipts as manual 21 defines them,
  with AWS (A9) as the provider of record.

## §5 Review types

Codex is used for:

- (a) one design-time review per package, of the design and the failure matrix, before implementation;
- (b) the package-close review;
- (c) a lane review, only for tier-1 money or authority code;
- (d) re-checks.

A full review lists, for each defect, its family and every analogous path in the package. A finding judged PARTIALLY_FIXED once
requires a family-wide root-cause fix and a new matrix family rule before the next round. A test that still passes with its
protection removed is a finding.

## §6 Shared-mechanism coverage

A failure-matrix cell whose expected behaviour is produced entirely by a shared mechanism is covered when both hold:

- (i) one parametrized test injects the real fault for every member of a code-derived enumeration of the commands, sweeps or
  consumers that use the mechanism, and asserts each member's own outcome;
- (ii) an architecture check fails when a new member bypasses the mechanism.

Shared mechanisms are: idempotency replay, lock or statement timeout, sweep resume, consumer redelivery, and the authority check
at the write. Rule 5 of `FAILURE-MATRIX-TEMPLATE.md` still applies: replay does not prove CRASH-AFTER, so the injection must be
real. Cells that depend on command-specific state keep dedicated tests, and tier-1 money and authority cells always do
(PAY_\*, CLOSE_\*, FUNDS_\*, CONV_\*). A package with a failure matrix is accepted only when every cell is C or N/A.

*Correction to the audit text:* the verifiers found that the template already allows parametrized suites, so §6 records that
reading instead of creating a new rule. The B10 level-2 and level-3 cells that touch no money, tax, payment, refund or
commission are deferred to B16 by the owner's R-GAP resolution (D-05). B16's case map lists each of them as an inherited
obligation. The ledger blocks B16's closure while any of them is unresolved: it must be covered, or N/A with a reason the owner
signs.

## §7 Standing delegation

This records the owner's delegation of design decisions (2026-09-25, confirmed 2026-09-28). Claude decides implementation and
design questions within R2 and records each one in the package design document with a decision id. It may not change cases,
expected outcomes, thresholds, prices, scope, legal commitments or paid spend. The owner may revoke any decision. Legal texts
are drafted by B (D-08b).

## §8 Operating decisions already taken (recorded here; no new decision is requested)

- (a) **B04 grants** (A9 §4, D-04). B04-A ≤ USD 40. B04-B ≤ USD 120 on the Sonnet path, for 4 runs, recomputed downward with
  the pilot. Opus needs a new approval. Models run on Amazon Bedrock, not on Vertex Model Garden. Before any paid call:
  check region, routing, data residency, retention (invocation logging off), quotas and current prices.
- (b) **Cloud** (A9). AWS is the primary cloud; Azure is used only on a demonstrated material AWS blocker; Google Cloud is not
  used. The AWS account is opened by the owner under Kauro Data S.A.S. Until it exists, no cloud resource is created and no
  money is spent. Everything that needs no account proceeds: IaC, adapters, IAM plan, synthetic tests, the cost sheet. No EKS,
  NAT gateway, interface endpoint, permanent HA or other fixed cost, unless a security or operations contract requires it, with
  a written justification. The historical costs (USD 66, 95, 134 a month) are references, not a budget.
- (c) **Fiscal route** (D-08a). If Alegra API emission is not verified in the real account by 2026-10-12, launch uses the
  DIAN-assisted bridge of manual 15.
- (d) **Collection** (A8). ACH USD received through Wise Business is the preferred route for US B2B customers. It stays
  PENDING_VERIFICATION until real KYC confirms it, and it does not block launch. PayPal Business is the secondary or fallback
  route, and nothing built for it is removed. Bancolombia is for treasury in Colombia only. Collection is per project: no
  subscriptions, no BILL or Melio integration, no COP for foreign customers. The COP route for Colombian customers is separate.
  Provider fees are versioned configuration with source and date, never constants. If Wise is not verified at launch, Kauro
  launches with PayPal and ACH is switched on later by configuration.
- (e) **Publication authority** (D-07). B may merge, tag and publish GitHub releases of the three repositories when A4 (b)–(d)
  are green, without force and with a notification for each publication. Parallel sessions never merge.
- (f) **CI** (D-03). Windows runs only on the final candidate and on `main`, with `success` required on the final SHA.
- (g) **Dates.** The internal production target is 2026-10-19. The official target of 2026-10-23 and the deadline of
  2026-10-28T05:00Z are unchanged.

*Correction to the audit text:* the audit's §8 proposed grants of A USD 25 / B USD 98 → 196, a GCP cloud grant and Claude
publishing. These are replaced by the decisions actually taken: A9 §4 and D-04 for the grants, A9 for the cloud, D-07 for
publication. A8 is added for collection.

## §9 B18 review scope

The B18 review covers:

- B18's eleven cases;
- the ledger integrity check (`node tools/ledger.mjs` with every external map pinned);
- each accepted package's diff since its acceptance commit, where no later review covered it (`tools/acceptance-touch.mjs`);
- the manual-22 B18 journeys.

It may be split by domain. It is not a re-review of accepted packages.

## §10 Supersession

The following are replaced by A4, A6, A8, A9 and this amendment, and are kept only as provenance:

- in manual 01, the CH-009 role split for mandates;
- in manual 23, everything except the owner action cards and capability honesty;
- manual 30 as a construction instruction;
- in EVIDENCE_AND_CI_PROTOCOL, the reviewer identity and the report-section table;
- in prompts B00–B21, the ExecutionBinding line and the "final report following manual 23" line;
- every text that names Google Cloud (GCP, Vertex AI / Model Garden, Cloud Run, Cloud Tasks, Cloud SQL, GCS, Secret Manager,
  Identity Platform) as the production provider (A9);
- every text that names PayPal as the primary or default collection route (A8).

Manual 29 lists A5, A6, A7, A8 and A9. The hashes of A4–A9 are added to `PROVENANCE.md` with this re-issue. The ledger's
`transition.json` records their hashes once the texts are in the repository.

## §11 Registry identity

The hashes in `packages/contracts/registry/PROVENANCE.json` identify the normative registry, and the ledger fails when the
vendored files no longer match them. Brand-only text differences produced by A2 rule 5 are listed and are not drift; currently
the list is `cases.json` R2-070 `scenario`. There is no re-vendoring.

---

## Changes from the audit's §3 text (for B's review)

| Section | Audit text | This draft | Source |
|---|---|---|---|
| §1 | R2-115 and R2-116 NOT_APPLICABLE | R2-116 EXECUTED_LOCAL (transition record); R2-115 NOT_APPLICABLE only if the owner signs | INFORME §5.6 authority-process-01; owner instruction |
| §1 | R2-118 by the sheet | the same, NOT_EXECUTED until the sheet exists and its test passes | `OWNER_ACTIONS.md` (sheet due 2026-10-07) |
| §4a | any runner; local Windows when CI Windows did not run | the same, under D-03 (Windows only on the final candidate and `main`) | D-03 |
| §6 | new shared-mechanism rule | records that the template already allows it; D-05 deferral of B10 non-money cells to B16 with the ledger blocking B16 | INFORME §4 |
| §8 | grants 25 / 98→196; GCP cloud grant; Claude publishes | A9 §4 / D-04 grants on Bedrock; AWS per A9, no spend before the account; D-07; A8 collection; D-03; D-08a | A8, A9, D-03..D-08 |
| §10 | supersession of 01, 23, 30, protocol, prompts | adds the GCP texts (A9) and PayPal-primary texts (A8) | A8, A9 |

Owner acts implied: sign A7 (D-06), including the R2-115 choice in §1. Nothing else.
