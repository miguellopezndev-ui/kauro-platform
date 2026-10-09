# Requests from B (builder) to the parallel sessions

Read this file at the start of each block (`git fetch origin docs/b-requests`). Answer in your own branch/PR; never edit this file.

## SESSION STATUS — 2026-10-09 15:45Z (B) — READ FIRST, supersedes the 10-08 notices below where they differ
Burn re-measured 15:30Z: ~0.01 %/h overnight; week 61 %, reset 2026-10-13 09:00Z; allowed <= 0.27 %/h to the 85 % cap. Build method for
every block from now on: tools/review/prompts/build/TEMPLATE.md rules (baseline-diff STOP, own regressions are fixes, gaps collected to the
end, whole-suite done criteria, mechanical assertion diff).
- **S-C: RESUME** (cap 1.5 %/day, Sonnet default, Opus only for the acceptance-touch logic, max 2 agents). Block 1: fix the PR #18 findings
  (B review ad1da0f: 7 MAJOR / 4 MINOR, posted on the PR) with a failing test first for each, one commit per finding family, push once,
  comment on #18 with the finding->test->commit table. Block 2: B16-local precoverage map.
- **S-E: RESUME** (cap 1 %/day). PR #16: B re-verified 8219403, ADV-8/ADV-9 PASS (comment on #16); Codex B13 review after the 10-10 reset.
  Next: merge 8219403 into #21 (HTML + import guide), continue it tests first, push once; B reviews within 12 h.

## QUOTA NOTICE TO ALL SESSIONS — 2026-10-08 00:40Z (owner decision 2026-10-07 evening) — READ FIRST AT THE START OF EVERY BLOCK
All sessions share ONE Claude weekly quota. Measured burn 1.9 %/h (32 % -> 54 % between 13:04Z and 00:30Z) against an allowed
0.24 %/h (31 points to the 85 % cap in 128 h, reset 2026-10-13 09:00Z). At that burn the cap is reached on 10-08 ~14:00Z and 100 %
on 10-08 ~21:00Z, then nobody can work until 10-13.
- **S-A: AMBER = PAUSED.** Your AWS work cannot be applied until the AWS account exists (D-14, needs the company NIT). Stop starting
  new work; commit/push what is in flight, write your handoff, and end the block. Resume only when B posts "S-A RESUME" here.
- **S-C: PAUSED** (burn > 0.35 %/h, owner order: S-C first). Commit/push in-flight work, handoff, end the block. Resume on "S-C RESUME".
- **S-B: PAUSED** (same rule, second in order). Same steps. Resume on "S-B RESUME".
- **S-E: continues**, hard cap **1 % of the weekly quota per day**: one agent at a time, Sonnet/Haiku only (no Opus), no fan-out,
  no full verify runs; stop for the day when you reach 1 %.
- B (builder) keeps only the critical path (Payments V1 and B04), max 2 agents, Opus only for Codex blockers and money/security design.
- B re-measures the burn every 2 h and posts any RESUME here; nobody resumes on their own judgement.

## SESSION STATUS AND NEXT BLOCK — 2026-10-08 01:40Z (B, owner rules 2026-10-08) — READ FIRST
Burn re-measured 01:40Z: 1.2 %/h vs allowed 0.24 %/h (RED). Order under RED: S-E > S-C > S-B > S-A. B reviews your PRs within 12 h.
- **S-E: RESUME** (cap 1 %/day, Sonnet/Haiku, one agent). PR #16: your fixes in `fa7ee18` are received; B re-verifies only the 7
  findings (no new scope) and comments on the PR. Next block, in order: (1) answer the re-verify if anything stays open;
  (2) B13 HTML/PDF rendering + guide (`b13/<item>` branch, tests first). **B11 stage 2 screens move to B** (Codex builds them, one
  screen per job, while RED): do not start B11 stage 2 work; files `apps/web/**` stay yours to review on request only.
- **S-C: stays PAUSED** until burn <= 0.35 %/h. PR #18 (tools/ledger + A7 draft) is under B review; B comments within 12 h.
  On "S-C RESUME": first fix the PR #18 findings, then B16-local (precoverage map, then local commands).
- **S-B: stays PAUSED** until S-C has resumed and burn allows. PR #19 (PayPal) is **closed as DEFERRED** (branch kept). On
  "S-B RESUME": B15 non-PayPal adapters (Alegra / fiscal), tests first; never PayPal.
- **S-A: blocked** until the AWS accounts exist (D-14 then D-21 A). No work.

## To S-A (B14) — 2026-10-07
- **R-A1 Lambda vs ECS Fargate for `apps/api`** (AWS-DELTA §2.1, Q-AWS-7). Compare both against the three contracts Lambda changes:
  (1) drain on shutdown (`SHUTDOWN_DEADLINE_CEILING_MS`, R35 operability: in-flight requests finish or are refused retriable;
  per-request drain on Lambda), (2) the admission limiter (R2-046 fair order, `execution_capacity`, per-process concurrency vs
  Lambda concurrency), (3) the PostgreSQL connection budget (pool per process vs one connection per Lambda instance; direct
  connection required, no transaction pooler — B10 D10-GAP-6a; PG17 `transaction_timeout` required). Include monthly cost at
  launch volume and at 10x, cold-start effect on the 202/503 contracts, and choose one with justification in
  `docs/design/B14-api-runtime.md`. Needed by 08-oct (I-1 and the B14 network decision depend on it).
- **R-A2** B (builder) is doing I-2 (DB TLS with certificate verification) and I-3 (`*_PASSWORD_FILE`) now as a separate PR;
  confirm the CA bundle path and `rds.force_ssl` (Q-AWS-8) so the config names match (`KAURO_DB_TLS_CA_FILE`).
- **R-A3** Q-AWS-3/Q-AWS-5: B designs the replacement for the D-HOLD-4 provider fence (fence in Kauro's database) and the
  Cognito second-factor proof; send any Cognito/S3 capability facts you verify (Object Lock modes, legal hold API, Cognito
  `amr`/MFA claims in ID/access tokens) to `docs/design/B14-facts-for-B.md` in your branch.

## To S-A (B14) — 2026-10-07, owner decision D-19 (customer-data buckets)
- **R-A4** Customer-data buckets: versioning ON, Object Lock ON in **GOVERNANCE mode only (never COMPLIANCE)**, no default
  retention, noncurrent-version expiration 1 day. `s3:BypassGovernanceRetention` granted ONLY to the retention/deletion identity,
  with CloudTrail data events on the bucket; no other role (deploy included). Add an IAM policy test (Terraform plan / policy
  simulator) proving no other principal holds it. In the real-account qualification, measure the actual lag between a
  noncurrent version becoming eligible and its removal (legal texts will state the documented/measured maximum, never "1 day").

## To ALL sessions — 2026-10-07 (owner decision: less round-trips at merge)
- **R-ALL-1 Registering a NEW package in your own PR (append-only).** When your block creates a new workspace package, your PR
  itself adds (a) its suite line to `SUITES` in `tools/evidence.mjs`, written exactly as the package's `test` script runs
  (same shape as the existing lines; the evidence check refuses a drifted script), and (b) its layer under `"layers"` in
  `architecture.rules.json` (an existing layer name; never edit `allowedDependencies`). Rules: only ADD lines for YOUR new
  package; never modify, reorder or delete an existing entry, never touch other keys of either file. B reviews these lines
  at merge (and resolves any conflict between two sessions' additions). Anything else in these files stays a request to B.
- **R-ALL-2 Cloud verify.** Use `docs/sessions/CLOUD-VERIFY.md` (non-root user for initdb, proxy + its CA for pnpm and
  clean-consume, PGBIN) for every verify in a cloud container, unchanged; report its `CLOUD-VERIFY exit` line and the first
  failing test title in your PR. Container problems go to "Open" in your PR; B fixes the script.

## To S-B (B15 PayPal, PR #19) — 2026-10-07
- **R-B1 F-PP-1 is priority (money).** B changes the port (I-PP-3) and the contract fake (I-PP-4) so the core recovers a
  refund whose response was lost without assuming anything: B writes the failure-matrix rows and the port design first, Codex
  reviews it, then you adapt the adapter to the new port. Until then do not build further on `observeRefund` by request id;
  keep F-PP-1's test as is (it documents the gap).
- **R-B2 F-PP-3** (refund CANCELLED): decided by B in the same design (see the I-PP-3 section when it lands on this branch);
  keep throwing UNRECOGNIZED_PROVIDER_STATE until the port expresses it.
- **R-B3 (tier 1, blocks merging PR #19 as is).** B's plan (PP-REFUND-RECOVERY) found that the adapter's order view claims
  absence proof (`orders-adapter.ts:168-169`), which nothing in PayPal's specs supports; with the core's watchdog
  (`observation.ts:833-840`) a refund PayPal received but has not listed yet could be retried under a new request id after
  60 s = a second refund. Until the new port (I-PP-3) lands, every PayPal "absence" the adapter reports must be
  `absenceIsProof: false` (orders view included), with a contract-table row asserting it per binding. Same for captures.
- **R-B4 (F-PP-6).** The official specs give the "6 h (72 h on request)" PayPal-Request-Id retention for Orders create only;
  the refund endpoint documents none. Correct B15-adapters.md §2.1 so no call relies on a retention window it does not document.
- **R-B5** Record in your fixtures (spec URL + sha256), when available: the refund `status` enum meanings (CANCELLED, FAILED),
  whether the order view echoes the refund `invoice_id`, the refund webhook payload fields, and the Transaction Search
  spec (visibility delay). B's plan treats each as "unknown = no proof" until recorded.
- **R-B6 (tier 1).** `client.ts:96-101` (b15/adapters-paypal) repeats a POST after a 401 (token renewal). For money-moving POSTs
  (refund, capture, order create) that is a possible second effect. Allowed repeats only: the token call itself, and a 401
  renew-and-repeat on READS (GET). A money POST is sent at most once; a 401 on it surfaces as an ambiguous/unauthorized result
  to the core, never repeated. Add a contract row counting wire calls per POST (B's plan test S5 counts wire calls separately
  from core dispatches). B tracks the capture/create side as PP-CAPTURE-ABSENCE / PP-CREATE-RECOVERY.
- **R-B7 (owner rule 2026-10-07, binding).** For an uncertain refund nothing ever re-sends the refund POST (not even with the
  same PayPal-Request-Id); recovery only READS (GET order view, GET /v2/payments/refunds/{id}). Provider facts come only from
  official PayPal documentation with exact URL (OpenAPI at github.com/paypal/paypal-rest-api-specifications); answers from an
  AI assistant are not evidence. Officially documented today: the refund POST's PayPal-Request-Id has NO stated retention
  (UNKNOWN); "6 h (72 h)" is for Orders create only; refund status enum CANCELLED/FAILED/PENDING/COMPLETED has no stated money
  meaning (CANCELLED/FAILED stay unrecognized-for-money). The adapter must expose no API that can re-POST a refund for an
  existing attempt; B adds the test `NEVER-RESEND` over every entry point.

## To ALL sessions — 2026-10-07 OWNER DECISION "Payments V1" (supersedes PayPal as launch rail)
Full text: `docs/authority/decisions/2026-10-07-PAYMENTS-V1.md` (branch docs/payments-v1-decision, 586714a).
- PayPal is OUT of the launch, PARKED (not deleted). Zero quota/time/CI/money on PayPal without a new owner authorisation.
- V1 target rail: USD invoice -> ACH (or wire, same details) -> Wise Business USD details of KAURO DATA S.A.S. -> reconciliation
  in Kauro. Not confirmed until registered company, Wise approved, USD details + ACH receiving enabled, and a real controlled
  collection AND refund test reconcile correctly. If Wise is late, PayPal is NOT reintroduced (B escalates to the owner).
- Generic contracts stay (rail, payment evidence, reconciliation, refund, reversal, ledger, seller commission and fiscal
  consequences, receipt/entitlement). Nothing becomes Wise-specific. Nothing wire-specific is built.
- Refunds stay mandatory; for ACH/Wise a safe manual-assisted refund is fine (authorised, idempotent in Kauro, adjusts
  revenue/cash/commission/fiscal evidence, receipt kept, never "refunded" without real execution evidence, no double refund).
  Any rail: an uncertain refund is NEVER re-sent, only queried; still uncertain -> owner resolution (D-24 A).
- Do not state publicly that Kauro accepts ACH until proven on the real account.

## To S-B (B15) — 2026-10-07, Payments V1
- **R-B8 STOP PayPal.** Close PR #19 / `b15/adapters-paypal` with ONE status commit: a `DEFERRED.md` (or a section at the top of
  `docs/design/B15-adapters.md` on that branch) stating "DEFERRED by owner decision 2026-10-07 (Payments V1); parked as
  contingency; not merged; resumes only by explicit owner decision", listing F-PP-1..7 and R-B1..R-B7 as open-if-resumed.
  Convert PR #19 to draft, remove `ready-to-merge` if present. No further work on it: R-B1..R-B7 are suspended.
- Continue B15 on the non-PayPal adapters (Alegra / fiscal, others in your block). No new code only for PayPal.

## To S-E (B11 stage 2 / B13) — 2026-10-07, Payments V1
- **R-E1 Checkout A8 (10-11) changes:** no PayPal option. The V1 customer payment is a USD invoice paid by ACH or wire to the
  same USD account details (shown only when the route is ENABLED by configuration; never hard-coded; no public "we accept ACH"
  claim until the route is VERIFIED).
- **R-E2 Payment-pending experience (ACH takes 1-3 business days):** design and test (a) work is admitted ONLY with confirmed
  funds (reconciled credit of the exact amount and currency); (b) what the agency sees while the payment is in transit
  (invoice issued, instructions, unique payment reference, "awaiting funds", expected window); (c) how the quote's validity
  relates to a payment in transit (quote expiry vs. an invoice already issued: propose the rule with its R2/B09 citation, B
  confirms before you build); (d) partial / over / wrong-reference payments shown as "under review", never as paid.
  Generic route model only (no Wise-specific screens or names in contracts).
- **R-E2 correction (owner 2026-10-07, wording of ACH/wire timing):** do not write "ACH takes 1-3 business days". Use only
  Wise's official help text (https://wise.com/help/articles/2827506/how-do-i-receive-money-with-my-usd-account-details,
  accessed 2026-10-07): "ACH: Usually within hours, and up to 4 working days." / "Wire: Usually within minutes, and up to 1
  working day." The same domestic USD account details receive both ACH and wire from US senders; receiving ACH has no fee
  ("No fees for ACH or 6.11 USD for wires"), a domestic wire has a receiving fee. Show timing as data (versioned config with
  source URL and access date, A8 rule 7), never hard-coded; design the pending state for up to 4 working days.

## To S-E (B11/B13) and ALL sessions — 2026-10-07, OWNER: English only by default
- **R-E3 (binding).** Customers are US companies. NOT ONE user-visible text in the site/app (pages, emails, errors, PDFs/HTML
  reports, legal pages) may be Spanish by default. Default locale = English (en-US) everywhere.
- **Language switcher:** add it if it fits your plan without moving 14-oct: all user-visible strings come from a message catalog
  keyed by locale (no hard-coded copy), a visible language selector, the choice remembered per user, English as default and as
  fallback for any missing key. At launch only the English catalog is required; another locale (e.g. es) is added later as a
  catalog, never by default. Tests: (a) a scan that fails if any non-English user-visible string ships in the default catalog or
  is hard-coded in components; (b) missing-key fallback to English; (c) the selector persists and switches.
- Legal texts render in English by default (B is converting docs/legal to English-primary); a Spanish legal copy, if Colombian
  law needs one, is only reachable through the language selector.
