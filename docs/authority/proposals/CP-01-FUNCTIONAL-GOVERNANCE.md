# CP-01: functional governance (policy, registry)

Prepared by Order 16 on 2026-10-22 against registry edition `KAVO-2026.09-R2` (provenance hashes in `CP-01.registry-delta.json`).
It is step 2 of `docs/design/FUNCTIONAL-CHANGE-INVENTORY.md` §3: the policy and registry part of components C1 and C2 as one
ChangeProposal. The legal-text part is `docs/legal/CHANGE-REQUESTS-CP-01.md`; the full classification is
`docs/design/ORDER16-FUNCTIONAL-GOVERNANCE.md`.

**Revision 2 (2026-10-22): owner resolution recorded.** The owner decided every item on 2026-10-22
(`docs/authority/decisions/2026-10-22-CP-01-OWNER-RESOLUTION.md`; signature block in section 6). Revision 2 records those decisions,
corrects CP-01.07 and CP-01.12 as the owner required, and fixes the parameters and the calendar sources of CP-01.11. Revision 1 is
the text delivered at `16ee3d4b`.

**State: not adopted.** The registry is unchanged and the authority is not re-issued. Adoption is one coordinated re-issue with CP-02
(Order 17) and its tests (`README.md`, adoption); an item whose behaviour or legal documentation is not ready (its `activation` list in
the delta) does not enter into force early. A business authorization here is not a deployment.

| Item | Owner decision (2026-10-22) | Status in the delta |
|---|---|---|
| CP-01.01 | Approved | `APPROVED_AWAITING_REISSUE` |
| CP-01.02 | Approved; activation needs deletion, restoration, SQL policies, dates and legal text | `APPROVED_AWAITING_REISSUE` |
| CP-01.03 | Approved (internal threshold); Terms only by their procedure | `APPROVED_AWAITING_REISSUE` |
| CP-01.04 | Content approved; legal effect conditional (`PENDING_COUNSEL`) | `APPROVED_AWAITING_REISSUE` |
| CP-01.05 | Approved | `APPROVED_AWAITING_REISSUE` |
| CP-01.06 | Approved | `APPROVED_AWAITING_REISSUE` |
| CP-01.07 | Approved with modification (corrected here) | `APPROVED_AWAITING_REISSUE` |
| CP-01.08 | Approved | `APPROVED_AWAITING_REISSUE` |
| CP-01.09 | **Deferred** to the final visual review; current text stays | `PROPOSED` |
| CP-01.10 | Design approved; publication conditional | `CONDITIONAL` |
| CP-01.11 | Parameters approved; activation blocked by PV1 | `CONDITIONAL` |
| CP-01.12 | Approved with a security modification (corrected here) | `APPROVED_AWAITING_REISSUE` |
| CP-01.13 | Approved | `APPROVED_AWAITING_REISSUE` |
| CP-01.14 | Approved | `APPROVED_AWAITING_REISSUE` |

## 1. Change record

| Field | Content |
|---|---|
| Observed reason | Owner decisions of 2026-10-20 and 2026-10-21 (Orders 11 and 12, design only) and two older authority rules are not in the registry the platform is built from, and in five places the registry or the code says the opposite (section 3). |
| Evidence and its limits | Each item cites its decision record and the current registry text it replaces (the `test` operations of the delta). Code facts were read at `cc935da4`, not run, except where a test is named. No legal opinion is given: the legal consequences are listed for competent review. |
| Alternatives considered | Per item (section 3). The general alternative, editing the vendored registry directly, is rejected: it breaks the provenance contract (`packages/contracts/src/registry.ts`) and D-34 §1.3. |
| Chosen behavior | Section 3 and the delta. |
| Rejected | F-02 (approval issuing the quote) and F-09 (output preferences): section 4. |
| Deferred | Every new command, read and contract field (component C3) goes to CP-02, prepared by Order 17 (section 5). CP-01.09 (UI03 action wording) deferred by the owner to the final visual review. |
| Impacted policy IDs | New: `retention.policyVersion`, `retention.extendHardCapExceptions`, `retention.pendingPaymentHold` (conditional), `intelligence.freeAuditPauseBps`, `commission.claimRefusalListVersion`, `commission.claimRefusalReasons`, `commission.claimRefusalRules`, `commission.collectionPeriod`, `commission.refundPeriod`, `commission.refundRewritesEarlierPeriods`, `commission.captureCountedOnce`, `commission.amountStates`, `commission.retainerDefaultCentsPerMonth`, `legalStatus`, `alerts`, `alerts.relevantProgress`, `identityResolution`. No existing key changes value or is removed. |
| Contracts, commands, cases, gates | Text of CMD020 and CMD060 (precondition, failure) and of their copies in cases CMD020-OK, CMD020-DENY, CMD060-OK, CMD060-DENY and requirements REQ-CMD020-DENY, REQ-CMD060-DENY; contract Audit (`targetContractId` no longer required); contract RetentionRecord (`hardDeadline` description; a class, conditional); screens UI03, UI07, UI29 and a new UI56. No case or gate is removed; new acceptance cases are listed per item and written by the implementing order, tests first. |
| Data migrations | None at adoption. The implementing orders add append-only migrations (the extended UNPAID ceiling, the hold class) and keep every applied migration. |
| Producers and consumers | Producers: the authority re-issue. Consumers: `@kauro/contracts` and its generated types, the domain policy copies, SQL checks that pin 1,209,600 s and 259,200 s, the web's policy snapshot and public words, the legal texts. |
| Security and privacy effects | The 17-day ceiling keeps a free check's data up to 3 days longer, only on an authorised request; the hold keeps data during a confirmation window under hard limits. Neither lowers a deletion, isolation or audit rule. Retention never becomes open-ended. |
| Price and commission consequences | None to prices. Commission: definitions only (periods, default retainer 0, refusal reasons); no rate changes. |
| Invalidated evidence | The four restated cases (CMD020-OK, CMD020-DENY, CMD060-OK, CMD060-DENY) need new evidence for their new text; their current tests stay valid for HUBSPOT, SALESFORCE and the paid classes. The CMD060-DENY test that refuses an UNPAID-only project changes with F-19 (section 3.2). |
| Migration and transition | Prospective. Records, quotes, approvals and statements keep the version they were created under (retention labels in section 3.2). |
| Rollback limits | Text and values can be reversed prospectively. Data already deleted is not restored; an extension already granted under R2-RETENTION-2 keeps its date. |
| Implementation mandate | Order 17 (api contract, CP-02); the backend, retention and payment orders after it (`docs/design/ORDER16-FUNCTIONAL-GOVERNANCE.md` §8). |
| Funding source | None beyond planned orders. Competent legal review is an external cost the owner decides (D-08b, LAWYER_LATER). |
| Owner action | Done for every item on 2026-10-22 (section 6). Still open: CP-01.09 at the final visual review; the external conditions of CP-01.10 and CP-01.11. |
| Review trigger | The first adoption; any later decision that touches the same keys. |
| Affected sections | 09 (retention), 14 (cost controls), 16 and 17 (commission), 11 (screens UI03, UI07, UI29, new UI56), 06 (CMD020), A3 §3.2. |

## 2. Rules used to classify (so the next order does not repeat them)

- A decision the owner recorded is not asked again. Its record is cited; only its missing values are asked.
- A rule already in the authority (R2 manuals through A3, a registry text) needs no owner decision: it needs only to be reflected.
- A read that exposes data the platform already holds, to roles that may already see it, is a technical design decision under the
  owner's standing delegation (A5 status line: "standing delegation of design decisions (2026-09-25, confirmed 2026-09-28)"). A rule
  that changes money, retention, legal text, authorization or what a customer is promised is not, and needs the owner.
- Authorization, roles and RLS are Order 15's; a change here that needs them names the dependency and does not touch them.

## 3. Items

### 3.1 CP-01.01: "Clean your data" needs no target contract (F-01) — `APPROVED_AWAITING_REISSUE`

- **Owner, 2026-10-22: approved.** "Clean your data" is an independent service; no target contract is required. StartAudit,
  CreatePlan, ApprovePlan and CreateQuote use the canonical CLEAN binding; no artificial CRM is introduced.
- **Decision.** Owner, 2026-10-20 (ORDER11-DESIGN-DECISIONS §4.7, register PM-01); A3 §3.3; ToS §3.2 (CLEAN bullet).
- **Contradiction proved.** CMD020's precondition requires an eligible target for every mode; `start-audit.ts:47,66-74,84` locks a
  target contract and refuses `TARGET_STALE` with no mode branch; openapi `StartAuditRequest` requires `targetContractId`. The plan
  compiler already has a canonical CLEAN hash (`plan-compiler.ts:27-28,78`) that no audit can carry. Tests mask it: every CMD020 test
  passes a target, and the helper inserts CLEAN-mode target artifacts (`cmd018-cmd019-target-contract.test.ts:59`).
- **Change.** CMD020 precondition and failure, their copies in cases and requirements, and the Audit contract's `targetContractId`
  (now `required: false`, absent for CLEAN) (delta). The openapi makes the field required unless the project's mode is CLEAN.
- **Rule for Order 17.** CLEAN: no `targetContractId`; one given is refused `422 TARGET_NOT_APPLICABLE` (one canonical hash, no
  ambiguity). The audit records `CLEAN_ONLY_TARGET_HASH`; CreatePlan, ApprovePlan and CreateQuote bind that hash and lock no target
  row for CLEAN. HUBSPOT and SALESFORCE unchanged.
- **Tests (first).** A CLEAN project reaches audit, plan, approval and quote with no target contract; a target supplied for CLEAN is
  refused with nothing written; HUBSPOT without a target still `TARGET_STALE`; a CLEAN quote binds the canonical CLEAN hash internally
  and shows no target fingerprint (ToS §6.1).

### 3.2 CP-01.02: retention R2-RETENTION-2 (F-19, F-20) — `APPROVED_AWAITING_REISSUE`

- **Owner, 2026-10-22: approved.** The free check may pass 14 days from sealing only when the extension is expressly requested and
  authorised, never past 17; one extension per project; without it the earlier limits stay. **Activation** needs deletion,
  restoration, SQL policies, dates and compatible legal documentation (LR-01) implemented and tested.
- **Decision.** Owner, 2026-10-21 (ORDER11-ROUND2-WORKSPACE "Design decisions" §1): the one extension (up to 72 hours) is also
  offered for the free check; only with it the free check's data may stay past 14 days from sealing, to at most 17.
- **What already allows F-19.** The registry and the terms do not limit the extension to paid projects: CMD060's precondition names
  no class, `retention.softExtensionsPerProject` is per project, ToS §13.2 speaks of "a soft period". The restriction is the
  implementation's: `persistence/src/source/retention.ts:227` selects paid classes, migration `0069:56,69,78` admits only paid ACTIVE
  records, and UNPAID records are created without a soft deadline (`0012:251`; B07-case-map CMD017-OK names the audit's soft deadline
  as an open remainder). So F-19 needs no policy value; it needs the UNPAID soft deadline to be written and the paid-only restriction
  lifted (with Order 15 for the row policies).
- **What F-20 changes (contradiction proved).** `retention.extendHardCap` is false, CMD060 refuses a "hard-cap change", UI29's
  exception says no extension crosses a hard cap, ToS §13.1/§13.2 and DPA Annex IV say the extension never exceeds the maximums; the
  domain and SQL pin 14 days (`policy.ts:43`, `retention.ts:184`, migrations `0011`, `0012`, `0014`, `0021`, `0082`).
- **Change.** `retention.extendHardCap` keeps its value (false) as the general rule; a new `retention.extendHardCapExceptions` names
  the only exception (`UNPAID`, ceiling 17 days from sealing, only through the project's one extension); `retention.policyVersion =
  "R2-RETENTION-2"`; CMD060, its case and requirement copies, UI29 and RetentionRecord's `hardDeadline` description (delta).
- **Rule.** For an UNPAID record only, the extension sets soft = min(previous soft + requested, seal + 17 days) and moves the hard
  deadline to that value; without an extension nothing changes (14 days). One extension per project across classes: an extension
  used on the free check leaves none for the paid project. A restored backup never revives data whose period ended.
- **Retention label defect (found here).** Two labels are written today to `retention_records.policy_version`: `R2-RETENTION-1` for
  UNPAID (`domain/model/source/policy.ts:49`) and `R2-INITIAL` for PAID_ORDINARY (`persistence/src/execution/store.ts:117`). The
  registry carries none. Adoption makes `retention.policyVersion` the one source; the implementing order writes `R2-RETENTION-2` on
  new records and leaves existing rows as they are (the column is immutable), reading both old labels as the first edition.
- **Tests.** 14 days without an extension; at most 17 with it, never more; a second extension refused in any class; a request after
  the soft deadline refused; an extension on a deleted or deleting record refused; the sweeper deletes at the extended date; a backup
  restored after it never brings the data back; the label is the registry's.

### 3.3 CP-01.03: the free-check pause threshold (X-34, Q-4) — `APPROVED_AWAITING_REISSUE`

- **Owner, 2026-10-22: approved.** The internal threshold is 90% of the budget actually funded. The public Terms are not changed
  automatically: their text goes through its amendment procedure (LR-11), so no contradictory promise is made. No additional spending
  is authorised.
- **Decision.** A3 §3.2 (adopted 2026-09-25, citing 14 §Cost controls): new free checks pause at 90% of the funded envelope.
- **Contradiction proved.** ToS §3.3 says "when the available budget is exhausted" while citing A3; the registry has no threshold.
  The value becomes `intelligence.freeAuditPauseBps = 9000`. The Terms are **not** changed here: the new wording would let Kauro pause
  earlier than the draft tells the Customer, so it is LR-11 (owner and counsel; register X-34 stays open for the text).
- **Not decided here.** The meaning of "funded envelope" stays manual 14's (`money.monthlyOwnerFundingCents`,
  `money.actualAvailableFunding`); the implementing order reads it from there.

### 3.4 CP-01.04: claim refusal reasons (F-13) and CP-01.14: legal status of the claim rules (F-18) — both `APPROVED_AWAITING_REISSUE`

- **Owner, 2026-10-22.** CP-01.04: **content approved; legal effect conditional.** The seven codes and the neutral messages are
  accepted. The owner sees the cause and its evidence; the seller sees only the permitted explanation and may ask for a review.
  `OTHER` needs a note and evidence. `OWNER_RULE` must name a rule actually in force and versioned; it authorises no arbitrary or
  retroactive decision. Contracts and tests may be prepared (O17-05). CP-01.14: **approved**; the state is `PENDING_COUNSEL` and does
  not change to legally approved without the evidence of the competent review.
- **Earlier decision.** Owner, 2026-10-21 (ORDER11-ROUND2-OPS decision 2; the list's content in FG F-13): a closed list, the seller
  reads a neutral message, "Other" needs a note; the claim rules are marked "Pending legal review" until counsel validates them.
- **Code today.** Acceptance carries one of four tokens (`accept-attribution.ts:36`). A claim is refused only through a competing
  allocation (`commercial/machines.ts:94-95`), which carries a label `ruling_reason` and a `ruling_evidence_hash`
  (`0029_sales_attribution.sql:403-404`). Missing: a closed refusal code and a seller-facing message.
- **Change (revision 2).** CP-01.04: `commission.claimRefusalListVersion = CLAIM-REFUSAL-1`; seven codes, each with its seller
  message, `noteRequired` (only `OTHER`), `evidenceRequired` (every refusal: the owner sees its evidence, as the existing
  `ruling_evidence_hash` already records) and `ruleReferenceRequired` (only `OWNER_RULE`); `commission.claimRefusalRules`: the owner
  sees code, note and evidence, the seller sees the message only and may ask for a review, an owner rule must be in force and
  versioned and is never retroactive. CP-01.14: `legalStatus["commission.claimRules"] = PENDING_COUNSEL` since 2026-10-21, covering
  the 90-day claim, the tail and the refusal reasons; `validation` stays null until the review's evidence exists.
- **Counsel.** The validation of the 90-day claim, the tail and the reasons is a seller-agreement question (LAWYER_LATER L-12, L-19).
  Until then the rules have no legal effect beyond what the signed seller agreements already say.

### 3.5 CP-01.05: the default retainer (F-16) and CP-01.13: the periods (F-12) — both `APPROVED_AWAITING_REISSUE`

- **Owner, 2026-10-22.** CP-01.05: **approved.** Default monthly retainer USD 0.00; a signed agreement with another amount prevails
  under its dates and terms; an obligation already accrued is never removed. CP-01.13: **approved.** A collection belongs to the period
  in which the money was captured and confirmed; a refund to the period in which it actually happened, without rewriting earlier
  collections; refunds and adjustments are reflected in the right period, linked to the original operations; a capture counts once;
  taxes are not in the commission base; commissions earned, held, payable and paid are kept apart; signed agreements are respected.
- **Earlier decision.** Owner, 2026-10-21 (ORDER11-ROUND2-OPS decisions 1 and 4): four figures, collections not invoices, net of
  refunds, each collection once; the retainer is USD 0.00 by default and a signed one is owed.
- **Already consistent.** `commission.base` (net of refund, excluding tax), `commission.windowAnchor`
  (`FIRST_DURABLE_CAPTURE_CONFIRMATION`) and `seller_agreements.retainer_cents_per_month DEFAULT 0`.
- **Change (revision 2).** CP-01.05: `retainerDefaultCentsPerMonth = 0`. CP-01.13: `collectionPeriod = MONTH_OF_CONFIRMED_CAPTURE`,
  `refundPeriod = MONTH_IN_WHICH_THE_REFUND_HAPPENED`, `refundRewritesEarlierPeriods = false`, `captureCountedOnce = true`,
  `amountStates = [EARNED, HELD, PAYABLE, PAID]`. The statement item for the retainer, the offset fields and their links to the
  original lines are contract changes for CP-02 (no `RETAINER` item kind exists: `0031:178`).

### 3.6 CP-01.06: alert thresholds (F-15) — `APPROVED_AWAITING_REISSUE`

Owner, 2026-10-22: **approved**, as decided on 2026-10-21 (decision 3): inactivity 14 days without relevant progress; deadlines 2 days
before and at once when passed; claims 14 and 3 days before their end; a pilot's review prepared 14 days before it ends; one alert per
fact under its most urgent kind (blocked > deadline passed > deadline within 2 days > inactivity), showing the other circumstances on
the same alert without duplicating it. Change: the `alerts` object, with `otherConditionsShownOnTheSameAlert`.

### 3.7 CP-01.07: what counts as relevant progress (F-15) — `APPROVED_AWAITING_REISSUE` (approved with modification)

- **Owner, 2026-10-22: approved with modification.** Revision 1 proposed that any command committed on the project counts. The owner
  rejected that: a persisted command does not by itself reset inactivity.
- **Rule.** Relevant progress is only a material, verifiable change of the state of the project or of its deliverables: a new sealed
  revision, a concluded check, an effective decision on a plan, an approval, an issued quote, a payment actually reconciled, a
  preparation, a delivery, an import, or an equivalent act that legitimately changes the course of the project. Never: reads,
  downloads, sign-ins, reminders, ordinary support messages, commands without material effect, failed retries, repeated actions that
  change no state.
- **Scope.** Progress affects the inactivity alert only. **It never extends retention, a legal deadline or a quote's validity** (ToS
  §13.2 already says opening a report, contacting support or receiving reminders does not extend retention; progress does not either).
- **Change (revision 2).** `alerts.relevantProgress`: `rule`, the nine `counts`, `equivalentActCountsOnlyIf`, the eight `neverCounts`,
  `affects = [INACTIVITY_ALERT]`, `neverExtends = [RETENTION, LEGAL_DEADLINES, QUOTE_VALIDITY]`.
- **Tests.** `tools/test/change-proposals.test.mjs` refuses a delta in which a generic or non-material act counts, an excluded act is
  missing, progress extends anything but the alert, or CP-01.07 touches a key outside `alerts`. The alert read's own tests are CP-02's
  (O17-07): each excluded act leaves the inactivity clock unchanged; each counted act resets it; no retention, legal or quote date
  moves.

### 3.8 CP-01.08 and CP-01.09: the approved public headings enter the registry (G-02)

- CP-01.08 `APPROVED_AWAITING_REISSUE`. Owner, 2026-10-22: **approved.** UI07 and UI03 primary copy, as amendments R2-1 and R2-2
  approved (owner, 2026-10-21), adopted at the re-issue. On adoption `AMENDED_PRIMARY_COPY` in `apps/web/test/support/registry.ts`
  loses those two rows.
- CP-01.09 `PROPOSED`. Owner, 2026-10-22: **deferred.** The new wording of UI03's action is not approved; the current registry text
  ("Inspect the exact profile; ask a safe scope question.") stays. The proposal is kept for the final visual review before the second
  audit. It is not presented as approved and is not removed.

### 3.9 CP-01.10: a page for the Personal Data Processing Policy (F-08) — `CONDITIONAL`

- **Owner, 2026-10-22: design approved; publication conditional.** Screen UI56 and the versioned publication mechanism of the Policy may
  be prepared.
- **Pending.** Real company data (CHECKLIST A-08); competent review (D-31); verification that the content reflects the processing
  actually carried out. No incomplete, false or unreviewed policy is published (LR-05).
- **Basis.** The law requires the policy to be accessible and the authorization to be provable (Decreto 1074 arts. 2.2.2.25.2.4,
  2.2.2.25.3.1; CHECKLIST C-03, C-05; POL §8.1); the registry publishes three legal pages and not this one.
- **Change (revision 2).** Screen UI56; its exceptions now say that no version is published before its company data are real, it is
  reviewed and it reflects the actual processing, and that essential obligations stay apart from optional commercial authorizations.
  The consent record at registration (and its essential/optional split) is a CP-02 field (O17-12, O17-13).

### 3.10 CP-01.11: the pending-payment hold (F-21, F-22, F-23) — `CONDITIONAL` (parameters approved, activation blocked by PV1)

- **Owner, 2026-10-22: parameters approved** as a business decision for the future ACH route:
  - five US banking days from the valid acceptance of the proof;
  - the banking calendar of FedACH and US holidays, documented from official sources (below);
  - an absolute limit of 24 days from sealing; the effective end is the **earlier** of the five banking days and the 24-day limit, and
    the customer sees the real date, never the full period when it would pass the limit;
  - one hold per quote and per sealed set; never renewable; never added to another extension: the later date applies, within the
    absolute maximum;
  - owner review from the **third** hold ended unpaid in a rolling 90-day window per organisation;
  - step-up authentication to present the proof; the proof refers to a transfer already sent, with exact amount and reference.
- **Never.** A declared transfer or a proof is not confirmed payment, starts no preparation and creates no commercial authorisation.
  Unreconciled at the end: the deletion process applies; a late credit goes through review and refund without reviving the data.
- **Activation blocked.** Not adopted into the operating registry nor activated before Wise Business is enabled, real verifiable
  evidence exists, and implementation, abuse controls and legal review (LR-02) are done (PV1; Payments V1 §2 (a)–(f)).
- **Calendar sources (retrieved 2026-10-22, in the delta's `evidence.calendar`).** Banking days are Monday to Friday except Federal
  Reserve holidays; a holiday on Saturday leaves the Reserve Banks open the preceding Friday; a holiday on Sunday closes them the
  following Monday.
  - Board of Governors, Federal Reserve holidays: <https://www.federalreserve.gov/aboutthefed/k8.htm>
  - Federal Reserve Financial Services, Holiday Schedules (FedACH processing ends and resumes):
    <https://www.frbservices.org/about/holiday-schedules>
  - FedACH Processing Schedule:
    <https://www.frbservices.org/resources/resource-centers/same-day-ach/fedach-processing-schedule.html>
  - 2026 holiday schedule for FedACH Services: <https://www.frbservices.org/news/fed360/issues/121625/ach-2026-holiday-schedule>
  - 5 U.S.C. 6103, the legal public holidays (the list only: the Reserve Banks' Saturday rule differs from the federal-employee rule).
  - As read on 2026-10-22: 2026 closures Jan 1, Jan 19, Feb 16, May 25, Jun 19, Sep 7, Oct 12, Nov 11, Nov 26, Dec 25 (Jul 4 is a
    Saturday: banks open Jul 3); 2027 closures Jan 1, Jan 18, Feb 15, May 31, Jul 5 (Jul 4 Sunday), Sep 6, Oct 11, Nov 11, Nov 25
    (Jun 19 and Dec 25 are Saturdays: banks open the Friday before). The implementing order reads each year from the sources, never
    from this list.
  - **Scope.** The calendar is the ACH route's. No other mechanism (a wire, an international transfer, a domestic Colombian route) is
    presumed to use it; each gets its own calendar when qualified. The time zone and cut-off of the count are fixed by the implementing
    order against these sources, with tests.
- **Change when unblocked (revision 2).** `retention.pendingPaymentHold` with the values above and the class `PENDING_PAYMENT_HOLD` in
  RetentionRecord. Revision 1's support calendar (America/Bogota) and "2 holds in 90 days per workspace" are replaced.

### 3.11 CP-01.12: proven identity and bulk decisions (F-25, F-27) — `APPROVED_AWAITING_REISSUE` (approved with a security modification)

- **Owner, 2026-10-22: approved with a security modification.** Revision 1 proposed that the same normalised email and the same
  normalised full name "demonstrate" an identity. The owner rejected that: it is a strong signal of a possible duplicate, not proof.
- **Proven identity (deterministic merge without human confirmation).** Only the proven-identity rules the core authorises. Migration
  Core already combines records only on exact equality of a proving key (`cores/kauro-migration-core/src/domain/identity.ts`,
  `PROVING_KEY_KINDS = SOURCE_RECORD_ID | EXTERNAL_ID`; `identity/resolve-identity.ts`: "Records are combined only when they share a
  key the configuration declares authoritative … a shared email address, a shared phone number, the same name — produces a duplicate
  candidate for review and changes nothing"): a source record identifier within one identity space, or an external identifier declared
  authoritative and verified. Policy: `identityResolution.deterministicMerge.onlyProvenIdentityKeys` names exactly those two.
- **Candidates.** Name-and-email matches without that proof stay candidates (`candidatesProveIdentity = false`). They may be selected
  and decided in batches of at most 100 groups (`api.batchItems`), with an exact preview and explicit human approval.
- **Blocking conflicts kept.** Distinct CRM identifiers that cannot be unified safely; generic or shared addresses; consent conflicts;
  chains of matches that do not prove identity; any material contradiction about the identity or the record that will remain.
- **No manufactured proof.** Accents, plus-addressing and other characters are never folded to make a proven identity
  (`foldingToManufactureProof = false`; email `NO_PLUS_STRIPPING`, name `ACCENTS_KEPT`).
- **Record.** Decision, evidence, responsible person, version and effect.
- **Not here.** The core is not changed by this proposal; the corrected policy goes to the contracts (O17-09) and to the later core
  intervention (component C7). Who may decide (owner, admin, operator) is an authorization rule: Order 15.

## 4. Rejected or kept unchanged, with reasons

- **F-02, approval issues the quote at once: not recommended.** A quote reserves a founding slot when issued (ToS §7.3(b);
  `pricing.foundingReservationDays`, `pendingFoundingReservationsPerAgency` 1), needs a billing profile the approver may lack (CMD027),
  and approval and purchase are separate roles (CMD025 approver, CMD027 billing). Issuing on approval would spend slots on plans nobody
  buys. Instead the approval page leads the owner or billing member straight to "Request the quote"; no contract change.
- **F-09, output preferences for "Clean your data": not for V1.** Converting phone numbers needs a country the file may not give, which
  risks a silent mutation; any change to the core's output changes Migration Core's run identity and needs a release the Intelligence
  Core accepts (HL-11, PD-06). Revisit with the next core release.
- **F-29, result-file retention: no new key.** `retention.importReceiptDaysFromTerminal` (7 days after verification ends, within the
  staged limit while needed) and ToS §13.1 already state it.
- **F-23: already enforced.** Execution needs an ACTIVE commercial authorization, created only after capture; the tests come with the
  hold.

## 5. Left to CP-02 (Order 17), because they are api contract

New commands, reads, events and contract fields of component C3: see `docs/design/ORDER16-FUNCTIONAL-GOVERNANCE.md` §7. They are
adopted with CP-02 in the same re-issue, so the registry changes once; the re-issue checks both proposals together. The handoff after
the owner's resolution (what is approved, corrected, unblocked, still conditional, the tests CP-02 needs, and which source and
revision to integrate) is `docs/design/ORDER16-FUNCTIONAL-GOVERNANCE.md` §13.

## 6. Owner's decision

Recorded on 2026-10-22 from the owner's communicated resolution of Order 16 (`docs/authority/decisions/2026-10-22-CP-01-OWNER-RESOLUTION.md`).
The owner delegated the choice expressly ("la decisión que tomes es la que yo tomaré"). This is the owner's decision as communicated:
no handwritten, cryptographic or professional signature is claimed. A formal external signature, if a procedure requires one, stays
pending without holding back this documentary record.

| Item | Decision | Date | Owner's words (resolution) |
|---|---|---|---|
| CP-01.01 | Adopt at the re-issue | 2026-10-22 | "APROBADO. CLEAN es un servicio independiente. Ningún contrato de destino es obligatorio." |
| CP-01.02 | Adopt at the re-issue; activation conditioned | 2026-10-22 | "APROBADO … sin exceder jamás los 17 días. La extensión es única por proyecto." |
| CP-01.03 | Adopt at the re-issue; Terms by their procedure | 2026-10-22 | "APROBADO … 90 % del presupuesto realmente financiado. No cambies automáticamente los Términos públicos." |
| CP-01.04 | Adopt the content; legal effect conditional | 2026-10-22 | "CONTENIDO APROBADO; EFICACIA JURÍDICA CONDICIONADA." |
| CP-01.05 | Adopt at the re-issue | 2026-10-22 | "APROBADO. Retainer mensual predeterminado: USD 0.00." |
| CP-01.06 | Adopt at the re-issue | 2026-10-22 | "APROBADO. Se mantienen los límites ya decididos." |
| CP-01.07 | Change, then adopt (revision 2) | 2026-10-22 | "APROBADO CON MODIFICACIÓN. No acepto que cualquier comando persistido reinicie la medición de inactividad." |
| CP-01.08 | Adopt at the re-issue | 2026-10-22 | "APROBADO. Adopta … los encabezados de UI03 y UI07 ya autorizados por R2-1 y R2-2." |
| CP-01.09 | Deferred | 2026-10-22 | "DIFERIDO. No apruebo todavía la nueva redacción de la acción UI03." |
| CP-01.10 | Design approved; publication conditional | 2026-10-22 | "DISEÑO APROBADO; PUBLICACIÓN CONDICIONADA." |
| CP-01.11 | Parameters approved (revision 2); activation blocked by PV1 | 2026-10-22 | "PARÁMETROS APROBADOS; ACTIVACIÓN BLOQUEADA POR PV1." |
| CP-01.12 | Change, then adopt (revision 2) | 2026-10-22 | "APROBADO CON MODIFICACIÓN DE SEGURIDAD." |
| CP-01.13 | Adopt at the re-issue | 2026-10-22 | "APROBADO. La colección corresponde al periodo en que el dinero se capturó y quedó confirmado." |
| CP-01.14 | Adopt at the re-issue | 2026-10-22 | "APROBADO. … `PENDING_COUNSEL`." |
