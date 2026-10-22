# CP-01: functional governance (policy, registry)

Prepared by Order 16 on 2026-10-22 against registry edition `KAVO-2026.09-R2` (provenance hashes in `CP-01.registry-delta.json`).
It is step 2 of `docs/design/FUNCTIONAL-CHANGE-INVENTORY.md` §3: the policy and registry part of components C1 and C2 as one
ChangeProposal. The legal-text part is `docs/legal/CHANGE-REQUESTS-CP-01.md`; the full classification is
`docs/design/ORDER16-FUNCTIONAL-GOVERNANCE.md`.

**State: not adopted.** The registry is unchanged. Items marked `APPROVED_AWAITING_REISSUE` record decisions already taken; they enter
the registry only by the adoption in `README.md`. Items marked `CONDITIONAL` or `PROPOSED` are not decisions.

## 1. Change record

| Field | Content |
|---|---|
| Observed reason | Owner decisions of 2026-10-20 and 2026-10-21 (Orders 11 and 12, design only) and two older authority rules are not in the registry the platform is built from, and in five places the registry or the code says the opposite (section 3). |
| Evidence and its limits | Each item cites its decision record and the current registry text it replaces (the `test` operations of the delta). Code facts were read at `cc935da4`, not run, except where a test is named. No legal opinion is given: the legal consequences are listed for competent review. |
| Alternatives considered | Per item (section 3). The general alternative, editing the vendored registry directly, is rejected: it breaks the provenance contract (`packages/contracts/src/registry.ts`) and D-34 §1.3. |
| Chosen behavior | Section 3 and the delta. |
| Rejected | F-02 (approval issuing the quote) and F-09 (output preferences): section 4. |
| Deferred | Every new command, read and contract field (component C3) goes to CP-02, prepared by Order 17 (section 5). |
| Impacted policy IDs | New: `retention.policyVersion`, `retention.extendHardCapExceptions`, `retention.pendingPaymentHold` (conditional), `intelligence.freeAuditPauseBps`, `commission.claimRefusalListVersion` and `commission.claimRefusalReasons` (conditional), `commission.collectionPeriod` and `commission.refundPeriod` (conditional), `commission.retainerDefaultCentsPerMonth`, `legalStatus`, `alerts`, `alerts.relevantProgress` (proposed), `identityResolution` (conditional). No existing key changes value or is removed. |
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
| Owner action | Sign or reject each item (section 6); decide the `PROPOSED` and `CONDITIONAL` points. |
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

- **Decision.** A3 §3.2 (adopted 2026-09-25, citing 14 §Cost controls): new free checks pause at 90% of the funded envelope.
- **Contradiction proved.** ToS §3.3 says "when the available budget is exhausted" while citing A3; the registry has no threshold.
  The value becomes `intelligence.freeAuditPauseBps = 9000`. The Terms are **not** changed here: the new wording would let Kauro pause
  earlier than the draft tells the Customer, so it is LR-11 (owner and counsel; register X-34 stays open for the text).
- **Not decided here.** The meaning of "funded envelope" stays manual 14's (`money.monthlyOwnerFundingCents`,
  `money.actualAvailableFunding`); the implementing order reads it from there.

### 3.4 CP-01.04: claim refusal reasons (F-13) — `CONDITIONAL`; CP-01.14: legal status of the claim rules (F-18) — `APPROVED_AWAITING_REISSUE`

- **Decision.** Owner, 2026-10-21 (ORDER11-ROUND2-OPS decision 2; the list's content in FG F-13): a closed list, the seller reads a
  neutral message, "Other" needs a note; the claim rules are marked "Pending legal review" until counsel validates them.
- **Code today.** Acceptance carries one of four tokens (`accept-attribution.ts:36`). A claim is refused only through a competing
  allocation (`commercial/machines.ts:94-95`), which carries a label `ruling_reason` and a `ruling_evidence_hash`
  (`0029_sales_attribution.sql:403-404`). Missing: a closed refusal code and a seller-facing message.
- **Change.** CP-01.04: `commission.claimRefusalListVersion = CLAIM-REFUSAL-1` and seven codes with their seller messages. The reasons
  and the four "Not available to claim" messages are the owner's (FG F-13); the code names are Order 16's and the messages of the three
  own-claim reasons come from the review prototype (`tools/review/private/prototypes/sales.ts:361-367`), so the item waits for the
  owner's confirmation. CP-01.14: `legalStatus["commission.claimRules"] = PENDING_COUNSEL` since 2026-10-21; approving a list does not
  validate it legally, and the status says so in the data.
- **Counsel.** The validation of the 90-day claim, the tail and the reasons is a seller-agreement question (LAWYER_LATER L-12, new
  L-19); until then the state stays `PENDING_COUNSEL`.

### 3.5 CP-01.05: the default retainer (F-16) — `APPROVED_AWAITING_REISSUE`; CP-01.13: the periods (F-12) — `CONDITIONAL`

- **Decision.** Owner, 2026-10-21 (ORDER11-ROUND2-OPS decisions 1 and 4): four figures, collections not invoices, net of refunds, each
  collection once; the retainer is USD 0.00 by default and a signed one is owed.
- **Already consistent.** `commission.base` (net of refund, excluding tax) and `seller_agreements.retainer_cents_per_month DEFAULT 0`.
- **Change.** CP-01.05: `retainerDefaultCentsPerMonth = 0`. CP-01.13: `collectionPeriod = MONTH_OF_CAPTURE`, `refundPeriod =
  MONTH_OF_REFUND`. FG F-12 records these periods as part of the decision, but ROUND2-OPS does not and F-12's own needs ask for the
  refund period to be defined, so CP-01.13 waits for the owner's confirmation. The statement item for the retainer and the offset
  fields are contract changes for CP-02 (no `RETAINER` item kind exists: `0031:178`).

### 3.6 CP-01.06: alert thresholds (F-15) — `APPROVED_AWAITING_REISSUE`

Owner, 2026-10-21 (decision 3): inactivity 14 days; deadlines 2 days before or at once when passed; claims 14 and 3 days before their
end; a pilot's review 14 days before it ends; each item once under its most urgent kind (blocked > deadline passed > deadline within 2
days > inactivity). Change: the `alerts` object.

### 3.7 CP-01.07: what counts as relevant progress (F-15) — `PROPOSED`

No record defines it. Recommendation: progress is a committed state transition of the project or of anything it owns (revision, audit,
plan, approval, quote, order, package, import stage, deletion), or a command a person or Kauro commits on it; never a read, a
download, a sign-in, a reminder, a support message or the retry of a failed attempt. Reason: it mirrors ToS §13.2 ("opening a report,
contacting support or receiving reminders does not extend retention"), so the same act never counts as progress for one rule and not
for another; it is computable from the existing journals without new data. Effect: the alert read (Order 17) and its tests.

### 3.8 CP-01.08 and CP-01.09: the approved public headings enter the registry (G-02)

- CP-01.08 `APPROVED_AWAITING_REISSUE`: UI07 and UI03 primary copy, as amendments R2-1 and R2-2 approved (owner, 2026-10-21). On adoption
  `AMENDED_PRIMARY_COPY` in `apps/web/test/support/registry.ts` loses those two rows.
- CP-01.09 `PROPOSED`: UI03's action "Inspect the exact profile" after R2-3 (the version line removed). The owner approved removing the
  line, not a sentence; the wording in the delta needs confirmation.

### 3.9 CP-01.10: a page for the Personal Data Processing Policy (F-08) — `CONDITIONAL`

The law requires the policy to be accessible and the authorization to be provable (Decreto 1074 arts. 2.2.2.25.2.4, 2.2.2.25.3.1;
CHECKLIST C-03, C-05; POL §8.1); the registry publishes three legal pages and not this one. Change: screen UI56. Pending: the screen's
wording, and the publication of the Policy itself (operator facts A-08, competent review D-31). The consent record at registration is a
CP-02 field (section 5).

### 3.10 CP-01.11: the pending-payment hold (F-21, F-22, F-23) — `CONDITIONAL`

- **Decided** (owner, 2026-10-21): a separate, transitional class; only with proof of a transfer already sent, for the exact amount and
  reference; once per quote and per sealed set; never renewed; never added to the extension (the later date applies, never the sum);
  not payment; data deleted when it ends unpaid and a late credit reviewed and returned; preparation never starts on it.
- **Open, with Order 16's recommendation:**
  - 5 business days from the accepted proof: **keep**. Wise documents ACH "usually within hours, up to 4 working days" and wire "up to 1
    working day" (Payments V1 §5); 5 business days covers the slowest documented rail plus one day of reconciliation. Counted on the
    published support calendar (America/Bogota), the calendar Kauro's reconciliation runs on.
  - Ceiling 24 days from sealing: **keep**. A proof given on day 14 plus 5 business days and a holiday ends near day 23; 24 bounds it
    and stays under the staged class's 30 days.
  - Owner review threshold: **2 holds ended unpaid in 90 days** per workspace; the third needs the owner. Small enough to stop a pattern,
    large enough not to punish one bank failure.
  - Proof given with a step-up: **yes**. It keeps personal data longer and binds money; the step-up already exists (900 s).
  - Calendar: the owner left the coverage calendar's holidays open; the published support calendar is recommended and listed as
    pending.
  - Still external: the PV1 qualification (Wise not opened; Payments V1 §2 (a)–(f)) decides which evidence the proof is checked
    against. Until then nothing here is adoptable.
- **Change when unblocked.** `retention.pendingPaymentHold` and the class `PENDING_PAYMENT_HOLD` in RetentionRecord.

### 3.11 CP-01.12: demonstrated identity and bulk decisions (F-25, F-27) — `CONDITIONAL`

- **Decided** (owner, 2026-10-21): demonstrated identities without a blocking conflict may be applied together; probable duplicates are
  decided in bulk only by a person; a preview first; everything traced.
- **Open, with recommendation:** demonstrated = same normalised email **and** same normalised full name; plus-addressing is not folded;
  names that differ only by accents are **not** demonstrated (they stay probable: "José" and "Jose" can be two people, and a person
  decides them in bulk at no cost); blocking conflicts = two distinct existing CRM record IDs, a shared or role address, a consent
  conflict, a chain of three or more with a non-demonstrated link; a bulk decision takes at most 100 groups per request, the existing
  `api.batchItems`, so no new limit is invented.
- Who may decide (owner, admin, operator) is an authorization rule: Order 15.

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
adopted with CP-02 in the same re-issue, so the registry changes once.

## 6. Owner's signature

| Item | Decision (adopt / reject / change) | Date | Owner's words |
|---|---|---|---|
| CP-01.01 | | | |
| CP-01.02 | | | |
| CP-01.03 | | | |
| CP-01.04 | | | |
| CP-01.05 | | | |
| CP-01.06 | | | |
| CP-01.07 | | | |
| CP-01.08 | | | |
| CP-01.09 | | | |
| CP-01.10 | | | |
| CP-01.11 | | | |
| CP-01.12 | | | |
| CP-01.13 | | | |
| CP-01.14 | | | |
