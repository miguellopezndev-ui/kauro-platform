# Order 16: functional governance, policies, registries and normative contracts

Branch `order16/functional-governance`, worktree `Kauro.archive/Worktrees/order16-functional-governance`. Started from `main` at
`cc935da4ae6dd6757dc089feae6b245626f25eb2` (merge of PR #121), checked on GitHub on 2026-10-22: it was still the latest `main`, CI
`verify` green on it (run 39813091737). Open at the start: PR #120 (Order 14, reports reader); it merged during this order (`58dda63f`) and this branch was updated with
it. Order 15 (authorization, RLS) had no PR yet and works in its own worktree. The final SHA is the head of this order's PR.

This order decides nothing the owner has not decided. It classifies every recorded functional change, proves the contradictions,
prepares the one ChangeProposal and the legal requests, applies only what already had authority, and hands Order 17 an exact contract.

## 1. What was read

Authority: D-33, D-34, Payments V1, A2, A3 (with D-33's supersessions), A4, A5, A6, A8, A9, A10; the vendored registry
(`policy.json`, `commands.json`, `screens.json`, `contracts.json`, PROVENANCE). Records: `FUNCTIONAL-CHANGE-INVENTORY.md` (FCI),
`ORDER11-FUNCTIONAL-GAPS.md` (FG, F-01 to F-34), the round-2 and round-3 decision files, `ROUND3-DECISIONS-REGISTER.md`,
`ORDER11-DESIGN-DECISIONS.md`, `ORDER11-OVERNIGHT-DECISIONS.md`, `LEGAL-CORRECTION-REQUESTS.md`. Legal: Terms, DPA, Data Processing
Policy, Privacy Notice, CHECKLIST, LAWYER_LATER, the published templates (`apps/web/src/legal/templates.ts`) and the public retention
words (`apps/web/src/public/retention.ts`). Code: every code claim of FG was re-read at `cc935da4` (handlers, migrations, openapi);
corrections in section 11.

## 2. Classes and rules

| Class | Meaning |
|---|---|
| **IMPL** | Approved and correctly implemented. |
| **APPR** | Approved (owner, authority or law), not yet in the contract that should carry it. |
| **CONTRA** | Contradicted by another authority or by the code. |
| **PROP** | Proposed, without approval: Order 16 gives a recommendation, not a decision. |
| **EXT** | Waiting for a professional (counsel, accountant) or a provider (Wise, AWS, Salesforce/HubSpot facts). |
| **OUT** | Outside what is authorised now, or outside this order. |

Rules used (CP-01 §2): an owner decision is not asked again; a rule already in the authority needs only to be reflected; a read of
data the platform holds, for roles that may already see it, is a design decision under the owner's standing delegation (A5); a rule
on money, retention, legal text, authorization or a customer promise needs the owner; authorization, roles and RLS are Order 15's.

## 3. Inventory: every F and G entry

| Id | Subject | Class | Decision or authority | What is missing | Next |
|---|---|---|---|---|---|
| F-01 | CLEAN needs no target contract | APPR, CONTRA | Owner 2026-10-20; A3 §3.3 | CMD020 text and handlers require a target | CP-01.01; O17-01; C4 |
| F-02 | Approval issues the quote | PROP | — | Recommendation: **do not** (founding slot, billing profile, roles) | CP-01 §4; owner |
| F-03 | Self-serve free check | APPR, CONTRA | Owner 2026-10-20 (direction) | A3 §3.2 binds the CTA to the fit form; amendment text and a registry route | Owner signs an A3 §3.2 amendment (section 9, B-03); then C9 |
| F-04 | Findings read | APPR | Owner journey (PM-06) | Read model | O17-02 |
| F-05 | Estimate read | APPR | Owner (PM-06) | Read, marked estimate | O17-02 |
| F-06 | Activity read | APPR | Owner IA (WS-01); delegated design | Read | O17-02 |
| F-07 | Sign-in, sign-up, recovery | APPR, EXT, CONTRA | Owner flows (PM-50–PM-56) | Provider: code uses Google Identity Platform, A9 names Cognito and removed GCP | Owner/provider; C8 (identity order, with Order 15) |
| F-08 | Data Processing Policy page, consent record | APPR, EXT | Law (CHECKLIST C-03, C-05); POL §8.1 | Screen UI56; consent fields; operator facts; review | CP-01.10; LR-05; O17-12 |
| F-09 | Output preferences for CLEAN | PROP | — | Recommendation: **not for V1** | CP-01 §4; owner |
| F-10 | Quotes and orders list | APPR | Delegated design (read of existing data) | Read | O17-02 |
| F-11 | Owner reads (sellers, customers, statements, claims) | APPR | Owner (OWN-01) | Reads; owner-only cross-workspace scope | O17-04; Order 15 |
| F-12 | Seller money, four figures | APPR | Owner 2026-10-21 | Period definitions in policy; read | CP-01.05; O17-04 |
| F-13 | Claim refusal reasons | APPR, EXT | Owner 2026-10-21; counsel pending | Policy list; refusal command | CP-01.04; O17-05; L-19 |
| F-14 | Seller review request, decision history | APPR | Owner 2026-10-21 | Commands and history read; seller role | O17-05; Order 15 |
| F-15 | Alerts | APPR, PROP | Owner 2026-10-21 (thresholds) | Thresholds in policy; "relevant progress" undefined (proposed) | CP-01.06, CP-01.07; O17-07 |
| F-16 | Retainer | APPR | Owner 2026-10-21 | Default in policy; statement item kind `RETAINER` | CP-01.05; O17-06 |
| F-17 | Offsets on the statement | APPR | Owner 2026-10-21 | Item fields (refund, line, clause), balance | O17-06 |
| F-18 | "Pending legal review" per rule group | APPR | Owner 2026-10-21 | `legalStatus` in policy; read | CP-01.04; O17-08 |
| F-19 | Extension also for the free check | APPR | Owner 2026-10-21; registry and ToS §13.2 already allow it | Implementation only: UNPAID soft deadline never written; paid-only restriction in SQL and row policies | C4/C6; Order 15 (row policies); LR-01 for public words |
| F-20 | 17-day exceptional ceiling | APPR, CONTRA | Owner 2026-10-21 | Policy key, CMD060, UI29, ToS §13, DPA Annex IV say 14 | CP-01.02; LR-01; C6 |
| F-21 | Pending-payment hold | APPR, EXT | Owner 2026-10-21 (principle) | Values, PV1 evidence, proof command | CP-01.11; LR-02; C5 |
| F-22 | Abuse limits of the hold | APPR, PROP, EXT | Owner 2026-10-21 (limits) | Ceiling 24 and threshold (recommended 2 in 90 days); DB uniqueness | CP-01.11; C10 |
| F-23 | No preparation on a hold | IMPL | Owner 2026-10-21 | Tests once the hold exists | C11 |
| F-24 | Five dates kept apart | APPR | Owner 2026-10-21 | Project dates read; same names in the Terms | O17-03; LR-02 |
| F-25 | Batch unification | APPR, PROP | Owner 2026-10-21 (principle) | Definition, accents, cap (recommended) | CP-01.12; O17-09; C7 |
| F-26 | A change after approval is a new revision | APPR | Owner 2026-10-21 | RevisePlan wired; revision event; quote withdrawn | O17-09; C4, C7 |
| F-27 | Adversarial identity tests | APPR | Owner 2026-10-21 | Synthetic fixture set | C7, C11 |
| F-28 | Salesforce route per object | APPR, EXT | Owner 2026-10-21 | Tool facts to verify (Upsert related-object step) | C7; LR-04 |
| F-29 | Staged reconciliation | APPR, EXT | Owner 2026-10-21 | Tool facts to verify; engine; retention already covered (no new key) | C4, C7 |
| F-30 | HubSpot association errors | APPR, EXT | Owner 2026-10-21 (answer drawn) | Whether HubSpot exports carry the company record ID | C7 |
| F-31 | Reader refuses packages with rejected rows | IMPL | Order 14 | Fixed by PR #120 (merged 2026-10-22) | — |
| F-32 | Reader memory | IMPL | Order 14 | Fixed by PR #120 (merged 2026-10-22) | — |
| F-33 | Refund decision message: sender and send state | PROP, EXT | — (open OQ-R1 to OQ-R4) | Recommendation: Kauro sends within 2 business days; send state recorded | LR-06; O17-10 (conditional) |
| F-34 | Serving a customer directly | PROP | — | Recommendation in section 9 (B-06) | Owner; O17 (conditional) |
| G-01 | Person's name in the shell | OUT | Owner approved not doing it now (R2P Q-R2-2) | Identity data | C8 |
| G-02 | UI07 copy into the registry | APPR | Owner 2026-10-21 (R2-1); R2-2, R2-3 too | Registry version | CP-01.08, CP-01.09 |
| G-03 | Project read for the shell | APPR | Delegated design | Read | O17-02 |
| G-04 | Board and client summaries | APPR | Delegated design | Read | O17-02 |
| G-05 | Billing profile, paid-project count | APPR | Delegated design | Read | O17-02 |
| G-06 | Package read, rejected rows, mapping files | APPR, OUT | Delegated design; mapping files are F-28 | Read; rejected rows after Order 14 | O17-02; Order 14; C7 |
| G-07 | Workspace support case list | APPR | Delegated design | Read (CMD044 stays project-bound) | O17-02 |
| G-08 | Profile, sessions, security events, responsible person, theme | APPR, EXT, OUT | Identity decisions; "Match system" theme superseded (dark only, X-02) | Provider; drop the theme value | C8; Order 15 |
| G-09 | Notification choices | APPR | POL §8.3, A-14 (marketing consent separate) | Preferences contract: essential vs optional | O17-13 |
| G-10 | Deletion records and activity log reads | APPR | Delegated design | Reads | O17-02 |
| G-11 | Seller home additions | APPR | Owner console decisions | Read fields | O17-04 |
| G-12 | Statement PDF and CSV; ask for an outreach authorisation | APPR | Delegated design (no rule changes) | Document; seller command | O17-11 |
| G-13 | Owner reads across workspaces | APPR | Owner (OWN-01) | Reads; owner-only scope | O17-04; Order 15 |
| G-14 | Refunds list | APPR | Delegated design | Read | O17-02 |

## 4. Other open points reviewed

| Point | Class | Finding | Next |
|---|---|---|---|
| X-34 / Q-4: free-check pause, 90% vs exhausted | CONTRA → resolved | A3 §3.2 (owner-adopted, citing 14 §Cost controls) says 90%; the draft ToS §3.3 said "exhausted" while citing A3. Aligned (CHECKLIST §11); value to policy | CP-01.03 |
| X-35: paid enrichment | not a conflict | Kauro does none (ToS §3.5); A3 §3.5(2) is about HubSpot's setting in the import | LR-08 |
| X-36 / LC-1: activity records in the published DPA template | CONTRA | ToS §3.4 and the public scope exclude activities; DPA Annex I.4 does not list them; only the template does. Recommendation: remove "and activity" at the next re-issue | LC-1 (counsel) |
| X-37: Help and Data handling narrower than ToS §5.2 | CONTRA (copy) | Public copy, not legal text: add sensitive and children's data to the public lists | C9 |
| X-38 / F-08: contact form consent | APPR | Same as F-08 | LR-05; C9 |
| D-33 in the published templates ("in-house team") | CONTRA | Draft texts were reworded on 2026-10-13, templates were not | LC-2 (new) |
| PM-12: billing details at the first quote | PROP | CMD002 requires a billing profile at activation; CMD027 needs one at quote anyway. Recommendation: **move it to the first quote** (less friction, no loss of control) | Owner; CP-02 (CMD002 field) |
| Round 3: bank details in a downloadable file | PROP | ToS §8.4 already limits where bank details are given. Recommendation: no bank details in files | LR-09 |
| Round 3: USD-only contracts vs COP in ToS §7.4 | EXT | Not a conflict in operation (D-33 §2.1 needs an enabled payment means); wording waits for accountant and counsel | LR-07 |
| Round 3: statement contract has no retainer field | APPR | F-16 | O17-06 |
| Round 3: exception rows forwarded to an agency's client | PROP | Recommendation: forwarded summaries carry counts only | LR-10 |
| D-33 cites `amendments/A3_COMMERCIAL.md` | editorial | Not in this repository; A3 lives at `docs/COMMERCIAL_AMENDMENT_A3.md`. The owner record is not edited; noted here | — |
| `policy.json` calendar (target 2026-10-23, deadline 2026-10-28) | OUT | Historical R2 schedule, superseded in practice (A3 §7.2, A4); no product reads it | Re-issue may refresh it |
| A7 (acceptance mechanics, unsigned, D-06) | EXT (owner) | The re-issue that would carry A4–A10 and CP-01 is the same act | Owner |

## 5. Contradictions and defects proved

1. **CMD020 vs "Clean your data" (F-01).** Registry precondition, openapi `required`, `start-audit.ts:47,66-74,84` (no mode branch);
   masked by tests that always pass a target (`audit-support.ts:96`, `cmd018-cmd019-target-contract.test.ts:59`).
2. **The 14-day hard cap vs the owner's 17 days (F-20).** `policy.json` `extendHardCap: false`; CMD060 precondition and failure;
   UI29 exceptions; ToS §13.1/§13.2; DPA Annex IV; SQL pins of 1,209,600 s (migrations 0011, 0012, 0014, 0021, 0082) and of 259,200 s
   (0069).
3. **The extension is paid-only in code, not in the authority (F-19).** `persistence/src/source/retention.ts:227`; migration
   `0069:56,69,78`; UNPAID records carry no soft deadline (`0012:251`), so the unpaid "7 days after ready" window is not applied yet
   (B07-case-map CMD017-OK names it as the audit package's remainder).
4. **Two retention labels in one column (new).** `R2-RETENTION-1` (`domain/model/source/policy.ts:49`, UNPAID) and `R2-INITIAL`
   (`persistence/src/execution/store.ts:117`, PAID_ORDINARY) in `retention_records.policy_version`; the registry carries no label.
   CP-01.02 makes `retention.policyVersion` the single source.
5. **ToS §3.3 vs A3 §3.2 (X-34).** Corrected in the draft.
6. **ToS §2, §3.2, §6.1 vs "Clean your data".** The Terms required a target for every project although their own CLEAN bullet and
   Target Contract definition do not. Corrected in the draft.
7. **Published templates vs D-33 (LC-2)** and **vs ToS §3.4 (LC-1).** Recorded; the templates change only by their re-issue.
8. **No reason on a claim refusal (F-13).** Rejections carry no reason, evidence or seller message (`commercial/machines.ts:94-95`).
9. **Approval does not notify (F-33).** `refund.approved.v1` goes only to the payment service (`commerce/events.ts:336`).
10. **FCI overstated three needs.** F-19 needs no policy or legal change (only the ceiling of F-20 does); F-29 needs no retention key
    (`importReceiptDaysFromTerminal`); F-28's processing of record IDs is already in DPA Annex I.4. FCI is corrected.

## 6. Normative changes made in this order

| Change | Where | Version effect |
|---|---|---|
| CP-01 prepared: 12 items (7 approved awaiting the re-issue, 3 conditional, 2 proposed), with the machine delta and its test | `docs/authority/proposals/` | None until adoption; proposed `retention.policyVersion` R2-RETENTION-2, `CLAIM-REFUSAL-1` |
| ToS draft aligned in four places (§2, §3.2, §3.3, §6.1) | `docs/legal/TERMS_OF_SERVICE.md`; CHECKLIST §11 | Draft 1.0, not in force; pending competent review (D-31), as the D-33 edits |
| Legal requests LR-01 to LR-10, entry into force blocked | `docs/legal/CHANGE-REQUESTS-CP-01.md` | None |
| Counsel questions L-19, L-20 | `docs/legal/LAWYER_LATER.md` | None |
| LC-2 for the published templates | `docs/design/LEGAL-CORRECTION-REQUESTS.md` | None (next versioned re-issue) |
| FCI reconciled (state after Order 16) | `docs/design/FUNCTIONAL-CHANGE-INVENTORY.md` | — |
| Registry, policy values, published legal templates, handlers, migrations | **not changed** | — |

## 7. Handoff to Order 17 (api contract: openapi, commands, events, read models)

Order 17 prepares CP-02 (the C3 part of the registry: new commands, reads, events and contract fields) so that CP-01 and CP-02 are
adopted in one re-issue. "Accepted" means its substance is decided and Order 17 may specify it now; "conditional" means it may be
drafted but not adopted until its condition holds.

### Accepted

| Id | Contract change | From |
|---|---|---|
| O17-01 | StartAudit: `targetContractId` required unless the project's mode is CLEAN; CLEAN with a target `422 TARGET_NOT_APPLICABLE`; the audit, plan, approval and quote of a CLEAN project bind `CLEAN_ONLY_TARGET_HASH` and lock no target row. Tests: CP-01 §3.1 | F-01, CP-01.01 |
| O17-02 | Tenant-scoped reads, existing authorization only: findings (count, population, examples within the plan's privacy class), estimate (units, policy price, `scheduleVersion`, `estimate: true`, reserves nothing), activity (typed events with actor, time, reference), project (name, client, service, stage), board and client summaries, billing profile and paid-project count, quotes and payment orders list (state, amount, key date, fiscal document number; billing readers), package read, workspace support cases, deletion records, refunds list | F-04, F-05, F-06, F-10, G-03–G-07, G-10, G-14 |
| O17-03 | Project dates read: one entry per date kind `QUOTE_PRICE_VALIDITY`, `FREE_CHECK_RETENTION`, `EXTENSION`, `PENDING_PAYMENT_HOLD` (absent until CP-01.11), `PAID_RETENTION`; each with date, rule, state and who may act; never a sum; Quote and order views link to it. The existing `SourceRevisionView.retention[]` stays | F-24 |
| O17-04 | Owner reads: sellers with the four figures (`MONTH_OF_CAPTURE`, `MONTH_OF_REFUND`, tax excluded, split shares once), one seller's record, customers with buyer type and channel, statements by period, claims across sellers; seller home: claims with end dates, next eligible and next payment dates; a won customer's first-payment and completion dates. Owner-only scope across workspaces is Order 15's | F-11, F-12, G-11, G-13 |
| O17-05 | Claims: `RefuseAttribution` (owner; `reasonCode` from `commission.claimRefusalReasons`, `evidenceRef`, `note` required for `OTHER`); the seller-facing view shows only `sellerMessage`; `RequestClaimReview` (seller, optional note); `DecideClaimReview` (owner, `UPHOLD` or `CHANGE` with a reason code); an append-only decision history read; events for each | F-13, F-14, CP-01.04 |
| O17-06 | Statements: item kind `RETAINER`; offset items with `refundId`, `adjustedLineId`, `clauseRef`; a balance (earned, held, offsets, retainer, payable) | F-16, F-17 |
| O17-07 | Alerts read for the owner and for a seller's claims: kinds and precedence from `alerts`; one item once with its other conditions as a second line. The inactivity kind depends on CP-01.07 (conditional) | F-15 |
| O17-08 | `legalStatus` in the owner's settings read | F-18 |
| O17-11 | Statement PDF and CSV; a seller command asking the owner to authorise a draft | G-12 |
| O17-12 | Registration consent record: Policy version, Privacy Notice version, user, time; marketing consent separate per channel (POL §8.3, A-14) | F-08 |
| O17-13 | Notification preferences: essential notices not optional; optional ones per channel | G-09 |
| O17-14 | CMD060 response states the class and its ceiling; its refusal of an UNPAID record (`NO_EXTENDABLE_RECORD`) is withdrawn once the backend writes the UNPAID soft deadline | F-19, F-20 |

### Conditional

| Id | Contract change | Condition |
|---|---|---|
| O17-09 | Plan read (evidence class, paging, preview hash); `ApplyDemonstratedBatch`, `DecideMany` (≤ 100 groups), `ChangeDecision`, `UndoBatch`; `PlanRevised` naming its changes; the open quote withdrawn with its reason | CP-01.12 decided; RevisePlan needs the cores (C7) |
| O17-10 | Refund: notification responsibility, due time and send state in the review packet and the refund view; approval never implies a message | Owner decision on F-33 (LR-06) |
| O17-15 | `RecordTransferProof` (owner or billing, step-up recommended), refusals `PROOF_REQUIRED`, `HOLD_ALREADY_USED`, `CEILING_REACHED`, `AMOUNT_OR_REFERENCE_MISMATCH`; events; the hold in order and retention views | CP-01.11 (PV1, values) |
| O17-16 | Direct service by Kauro (`AssignDirectService` or a `KAURO_DIRECT` value in CMD048), acquisition rights kept | Owner decision on F-34 |
| O17-17 | Import stage read (parent links, generated flag, blocked rows with reason and action, held-back counts); CMD041 releasing generated stages; choosing the ID to keep for a key imported twice | F-28 to F-30 tool checks |
| O17-18 | Eligibility step before real files; public "Check a file free" route | A3 §3.2 amendment signed (F-03) |
| O17-19 | CMD002 without the billing profile; billing profile required at the first quote | Owner decision on PM-12 |

Not for Order 17: handlers, migrations, the cores, the web screens, and every authorizer, role or RLS policy.

## 8. Dependencies for the orders after 17

The repository records no definition of Orders 18 to 27 under the current numbering (the 2026-10-20 handoff's numbering is
superseded). Dependencies are therefore given by the FCI component each later order opens; whichever order opens it inherits the line.

| Component | Needs first | Carries |
|---|---|---|
| C4 backend domain and application | CP-01 and CP-02 adopted | F-01 handlers; F-12 to F-17 seller money; F-25, F-26 plan; F-29 reconciliation engine; F-33, F-34 if decided; the retention label (section 5.4) |
| C6 deletion, retention, restoration | CP-01.02 adopted; Order 15 for row policies | UNPAID soft deadline written by the audit producer; extension for UNPAID; ceiling 17; SQL pins updated with drift tests; one retention label; restored backups never revive data |
| C5 payments and the hold | PV1 qualification; CP-01.11 values | Proof intake; matching against the route's evidence; hold never authorises execution (F-23 tests) |
| C10 abuse controls | C5; Order 15 | Hold uniqueness in the database; unpaid-hold counter and owner review; bulk-decision caps, rate limits, audit |
| C7 cores | CP-01.12; tool checks | Evidence classification; CRM IDs and shared addresses; Salesforce route; generated files from proved IDs; adversarial fixtures |
| C8 identity | Provider decision (A9 vs code); Order 15 | F-07, G-01, G-08; consent record of O17-12 |
| C9 web | C3 and the above | Every proposed screen onto real reads; public words of LR-01, LR-02 with the legal re-issue; X-37 lists; F-08 contact checkbox |
| C11 tests | with each step | The named suites of FCI §2 C11, plus section 3 of CP-01 per item |
| Legal re-issue (counsel) | Implementation of what the text promises | LR-01 to LR-06, LC-1, LC-2, L-18 to L-20 |

## 9. Still blocked: legal, business, external

| # | Question | Who | Order 16's recommendation |
|---|---|---|---|
| B-01 | Sign or reject each CP-01 item | Owner | Adopt the seven approved items with CP-02 in one re-issue |
| B-02 | CP-01.07 relevant progress; CP-01.09 UI03 wording | Owner | As proposed |
| B-03 | A3 §3.2 amendment for the self-serve free check (F-03) | Owner | Amend: "Check a file free" opens the free-check page; account creation before upload; the fit form stays as "Ask a question first"; pause at 90% kept |
| B-04 | Hold values, review threshold, step-up (F-21, F-22) | Owner, after PV1 | 5 business days; 24 days; 2 in 90 days; step-up yes |
| B-05 | Demonstrated identity, accents, cap (F-25) | Owner | Email and name; accents not folded; 100 groups |
| B-06 | Serving a customer directly (F-34) | Owner | Allow it as an owner-only assignment to Kauro that ends the seller's service compensation and keeps acquisition, commission and residual rights |
| B-07 | Refund decision message (F-33) | Owner, counsel | Kauro, within 2 business days, send state recorded |
| B-08 | F-02, F-09 | Owner | Reject both for V1 |
| B-09 | PM-12 billing details at the first quote | Owner | Move |
| B-10 | Claim rules, legal validation (L-19) | Counsel | — |
| B-11 | Wording of CHECKLIST §11 and LR-01 to LR-06 (L-20); LC-1, LC-2 | Counsel | — |
| B-12 | COP for Colombian customers (LR-07) | Accountant, counsel | No wording before their answer |
| B-13 | Identity provider (F-07, A9) | Owner, AWS account | — |
| B-14 | Data Loader result files echo the source key; Upsert related-object step; HubSpot exports carry company IDs | Verification on the tools | — |
| B-15 | Wise route qualification (PV1 §2) and company facts (NIT, address, phone, effective date) | Owner, providers | Never invented |
| B-16 | A7 and the re-issue mechanics (D-06) | Owner | Carry A4–A10, CP-01 and CP-02 together |

## 10. No interference with Orders 14 and 15

- Order 14 (PR #120) owns `packages/reports`, its tests and `docs/design/ORDER11-FUNCTIONAL-GAPS.md` while it integrates. This order
  touches none of them; FG's corrections wait (section 11).
- Order 15 owns authorizers, roles, permissions, RLS policies and their tests (its worktree changes files under `apps/api`,
  `apps/web/test` and `packages/application`). This order changes no code under `apps/` or `packages/`; where a rule needs them it
  names the dependency (F-11, F-14, F-19, F-25, G-08, G-13).
- Not touched: Intelligence Core, `vendor/`, payments, infrastructure, external services.

Changed files: `docs/authority/proposals/*` (new), `docs/legal/CHANGE-REQUESTS-CP-01.md` (new), `docs/legal/TERMS_OF_SERVICE.md`,
`docs/legal/CHECKLIST.md`, `docs/legal/LAWYER_LATER.md`, `docs/design/LEGAL-CORRECTION-REQUESTS.md`,
`docs/design/FUNCTIONAL-CHANGE-INVENTORY.md`, this file, and `tools/test/change-proposals.test.mjs` (new).

## 11. Corrections for ORDER11-FUNCTIONAL-GAPS.md (after PR #120 merges)

| Entry | Correction |
|---|---|
| F-13 | `decisionReason` is a token from four acceptance reasons (`accept-attribution.ts:36`), not free text; the free text is the allocation's `rulingReason`; rejections carry no reason. |
| F-19 | The extension formula is in SQL (`persistence/src/source/retention.ts:261-262`; CHECK `0069:31-35`), not in `records.ts`; unpaid refusal at three layers (`retention.ts:227`, `0069:56,69`, trigger `0069:78`). |
| F-21 | The bank-transfer states are live in a separate `PaymentOrderBank` machine (`0045_bank_transfer_kit.sql:35,88-92`; `0046_bank_routes.sql:191`), not in the PaymentOrder machine. |
| F-24 | A customer can read a revision's retention records (`GET /revisions/{id}`, `SourceRevisionView.retention[]`); missing are the extension, the hold and a project dates read. |
| F-29 | CMD040 validates a closed-shape receipt (`import-stage.ts:107-112`); it does not read Data Loader files or generate dependent files. |

## 12. Tests and verification

- `tools/test/change-proposals.test.mjs` (new): base hashes equal PROVENANCE and the files on disk; every replaced value is proved by a
  `test` op first; nothing removed or overwritten; no path changed by two items; closed statuses, traceable approvals (record files
  exist), no adoption claimed; the registry the proposal would produce is accepted by the contracts generator. Red proof recorded in
  the PR: each rule fails on a deliberately broken copy of the delta.
- Existing verifiers run on this branch: `@kauro/contracts` (registry provenance), the web policy-snapshot drift test, the tools tests,
  `pnpm run arch`. Results in the PR.
