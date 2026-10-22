# Functional change inventory (before the functional orders)

Decision D-34 (`docs/authority/decisions/2026-10-21-CONTINUOUS-IMPROVEMENT.md`): during Orders 11 and 12 Kauro is designed, not changed.
Every functional change a design needs is recorded; before the functional orders, this inventory groups them by the component they open,
so that each component is opened, changed and tested once, in dependency order, with the full review and no regressions.

State: 2026-10-21, end of Order 11 round 2. Sources:
- `docs/design/ORDER11-FUNCTIONAL-GAPS.md` (F-01 to F-30, each with code references and what it opens);
- gaps listed only in the round's decision files, given an inventory id here (G-01 to G-14):
  `ORDER11-ROUND2-PUBLIC.md`, `ORDER11-ROUND2-OPS.md` and `ORDER11-ROUND2-WORKSPACE.md`.

Nothing in this file is decided by it: an item marked **owner** still needs the owner's decision, and **counsel** the legal check.

**State after Order 16 (2026-10-22).** Every F and G item is classified in `docs/design/ORDER16-FUNCTIONAL-GOVERNANCE.md` §3. Step 2 of
section 3 is prepared, not adopted: the policy and registry part of C1 and C2 is ChangeProposal CP-01
(`docs/authority/proposals/CP-01-FUNCTIONAL-GOVERNANCE.md`, items CP-01.01 to CP-01.14), and the legal part is
`docs/legal/CHANGE-REQUESTS-CP-01.md` (LR-01 to LR-11). Corrections to this inventory, proved in Order 16 §5:
- F-19 needs no policy or legal change: the registry and ToS §13.2 already allow the one extension for any soft period. It needs the
  UNPAID soft deadline to be written and the paid-only restriction lifted (C4, C6, with Order 15 for the row policies). Only F-20's
  17-day ceiling changes policy and legal text.
- F-29 needs no new retention key: `retention.importReceiptDaysFromTerminal` and ToS §13.1 already keep result files 7 days after
  their verification and while a staged project needs them.
- F-28's processing of CRM record IDs is already described (DPA Annex I.4); LR-04 only clarifies error messages.
- F-02 and F-09 are recommended for rejection; F-23 is already enforced (tests come with the hold).
- F-31 and F-32 were fixed by Order 14 (PR #120); F-33 and F-34 wait for the owner (Order 16 §9, B-06, B-07).

## 1. Gaps recorded only in the round's files

| Id | Gap | Source |
|---|---|---|
| G-01 | The person's name for the account button: no read returns it (session, team list) | ROUND2-PUBLIC, G-SHELL-1 |
| G-02 | Registry ChangeProposal for UI07's primary copy ("Request a free data health check."), now an amended rendered copy (R2-1) | ROUND2-PUBLIC, R2-1 |
| G-03 | A project read for the shell: name, client, service and current stage, for the header and the menu, also by an order's project | ROUND2-WORKSPACE |
| G-04 | Project board read (stage, the date that matters, next step, who acts) and client summaries | ROUND2-WORKSPACE |
| G-05 | Billing profile, and the count of paid projects for the repeat discount | ROUND2-WORKSPACE |
| G-06 | Package read; rejected-rows download; Data Loader mapping files as outputs | ROUND2-WORKSPACE |
| G-07 | A workspace-wide support case list (today per project) | ROUND2-WORKSPACE |
| G-08 | Identity-provider profile, sessions and security events; the responsible person; a "Match system" theme value | ROUND2-WORKSPACE |
| G-09 | Notification choices, for customers and for sellers | ROUND2-WORKSPACE, ROUND2-OPS |
| G-10 | Deletion records and the workspace activity log as reads | ROUND2-WORKSPACE |
| G-11 | Seller home: claims with end dates, next eligible and next payment dates; a won customer's first-payment and completion dates | ROUND2-OPS |
| G-12 | Statement PDF and CSV for sellers; a seller action to ask for an outreach authorisation | ROUND2-OPS |
| G-13 | Owner reads: projects by stage and waiting party across workspaces; new customers by channel; places used of the first-customers discount | ROUND2-OPS |
| G-14 | A refunds list for the owner (a refunds page was not built for want of it) | ROUND2-OPS |

## 2. The changes by component

Each row lists the items that open the component. One component is one coordinated intervention (section 3).

### C1. Policy and registry (policy.json, registry, policy versions)

| Item | Change |
|---|---|
| F-01 | CMD020 StartAudit: target contract optional for "Clean your data"; the plan hash rule for CLEAN |
| F-13, F-18 | A closed, versioned list of claim refusal reasons; a legal-status flag per rule group (**counsel**) |
| F-15 | Definition of "relevant progress" per stage; alert thresholds (14 days inactivity, 2 days before a deadline, 14 and 3 days before a claim's end, 14 days before a pilot ends) |
| F-19, F-20 | The extension covers the unpaid class; a new key for the exceptional 17-day ceiling, the hard cap movable for the unpaid class only (new retention policy version) |
| F-21, F-22 | A pending-payment hold class: 5 business days (**proposed**, to check against the payment route), one per quote and per sealed set, never renewed, never added to the extension, ceiling 24 days from sealing (**proposed**), owner review threshold (**owner**) |
| F-25 | Demonstrated identity; blocking-conflict rules; kept-record and field rules; batch cap (**owner**) |
| F-29 | Result files kept 7 days after their check and while a dependent stage is open |
| G-02 | UI07 primary copy through a ChangeProposal and a new registry version |
| F-08 | A registry page for the Data Processing Policy |
| F-03 | A3 §3.2 amendment for a self-serve free check (**owner**, decided 2026-10-20) |

### C2. Legal texts (terms, privacy notice, DPA and its annexes, the public Data handling and Help words)

Changed by their own procedure, once, together: F-19 and F-20 (ToS §13.1, the retention annex, the free check's 7 days "or up to 3 more
on request", the 17-day ceiling); F-21 and F-22 (ToS §8 and §13: the hold, that it is not payment, a late transfer reviewed and returned;
the DPA retention annex); F-24 (the five dates named alike in ToS §6.2, §8, §13); F-25 ("demonstrated" is a technical class, not a
guarantee; nothing is written to any CRM); F-28 and F-29 (Salesforce record IDs and error messages as processed customer data); F-08 (the
Data Processing Policy page and the consent record at registration); F-13 and F-18 (the claim rules and refusal reasons, **counsel**). The
public pages take the words from `apps/web/src/public/retention.ts` and the copy catalogue, so they change in the same step (C9).

### C3. Api contract and read models (openapi, commands, events, views)

Reads:
- projects: G-03 project read; G-04 board and clients; F-24 the project's five dates; F-06 activity; G-10 deletion records and activity log;
- plan: the plan body (F-25 dependency), F-04 findings, F-05 estimate;
- money: F-10 quotes and orders; G-05 billing profile; G-14 refunds;
- delivery: G-06 package; the import stage read with parent links, generated stages and blocked rows (F-29);
- support: G-07 workspace cases;
- owner: F-11 sellers, seller record, customers, statements by period, claims; F-12 the four money figures; G-13; F-15 alerts;
- seller: G-11 home additions;
- identity: G-01 the person's name (with C8).
- refunds: F-33 exposes notification responsibility, due time and send state in the owner review packet; approval is not notification.

Commands and fields:
- CMD020 (F-01); CMD060 on an unpaid revision (F-19);
- RecordTransferProof, its refusal codes and events (F-21, F-22);
- batch apply, decide-many, change-one and undo-batch, with a preview hash (F-25); the revision event naming its changes (F-26);
- the choice of the ID to keep for a key imported twice; CMD041 releasing generated stages (F-29);
- the claim refusal reason code, evidence reference and note (F-13); a seller's review request and the owner's decision (F-14);
- statement items for the retainer, offsets and the balance (F-16, F-17); statement PDF and CSV, the ask-for-authorisation command (G-12);
- notification preferences (G-09).
- direct customer service assignment (F-34), if the owner wants it; current seller-only reassignment cannot represent the owner.

### C4. Backend domain and application

- F-01 the CLEAN path through StartAudit, CreatePlan, ApprovePlan and CreateQuote.
- F-02 approval issues its quote at once (**owner**, proposal).
- F-12 to F-17 the seller money: four figures from captures, never invoices, each collection once; the retainer accrued and paid; offsets
  with their basis.
- F-21 to F-23 the hold and its limits; preparation never on a hold.
- F-25, F-26 the plan read, batch decisions with a preview hash, RevisePlan wired; a new revision withdraws the open quote.
- F-29 the reconciliation engine: one success row per source key, the object's ID prefix, generated dependent and top-up files.
- F-33 the agreed refund notification workflow and its recorded send state; F-34 direct service assignment, preserving acquisition rights.

### C5. Payments (the enabled route and its evidence, PV1)

F-21 the proof intake (bank confirmation document or trace number, amount and reference), checked against the route's evidence; F-22 a
proof that does not match ends the hold early, decided by the owner; F-23 a hold, a partial or a pending credit never yields a commercial
authorisation. **Depends on** the PV1 qualification of the route and its evidence store.

### C6. Deletion, retention jobs and restoration

F-19 the sweeper reads the extended soft deadline for the unpaid class; F-20 the hard deadline of an extended unpaid record; F-21 a
pending-payment retention record whose end deletes the files unless an exact credit was captured; F-29 the result-file retention; for each,
a restored backup never revives files whose period ended.

### C7. Cores (Migration Core, Intelligence Core)

F-01 the CLEAN plan hash; F-09 output preferences for "Clean your data" (**owner**, proposal); F-04 the findings the read model exposes;
F-25 evidence classification, detection of existing CRM record IDs and shared addresses, a deterministic kept-record rule; F-27 a synthetic
adversarial fixture set; F-28 the Salesforce route per object (External ID upsert, related-object lookups, the source-key column, `.sdl`
mappings); F-29 files built only from proved IDs; F-30 HubSpot's error file for association errors. **To verify first** (F-28 to F-30):
that Data Loader's result files repeat the unmapped source-key column; Data Loader's upsert-with-related-object step; whether a HubSpot export
includes the associated company's record ID.

### C8. Identity and sessions

F-07 the provider decision, sign-up, enrolment and recovery (**owner**: provider); G-01 the person's display name; G-08 profile, sessions,
security events, the responsible person; G-09 notification choices.

### C9. Web (wiring the designed screens to the new reads)

Every screen drawn in Order 11 from fixtures moves to the reads of C3 once they exist; the review's fixtures become the contract tests'
examples. The public Data handling and Help words change with C2. The shell takes G-03 and G-01.

### C10. Abuse controls

F-22 uniqueness of a hold per quote and per sealed set enforced in the database; a workspace counter of holds ended unpaid with owner review;
an owner queue of proofs never matched. F-25 only owner, admin and operator decide duplicates; batch caps; rate limits; every decision in
the audit log. F-29 size and row limits on returned files; a cap on resubmissions.

### C11. Tests (with every intervention)

Acceptance tests first, then the full verify, the independent review and regression tests for every behaviour touched. Named suites: one
extension per project across classes, 14 days without it and at most 17 with it (F-19, F-20); the hold's adversarial cases (F-22); a hold
never authorises preparation (F-23); the five dates never merge (F-24); adversarial identity (F-27); a quote never survives its revision
(F-26); reconciliation edge cases and evidence fingerprints (F-29); seller money never counting a collection twice and never counting tax
(F-12); alert precedence and no duplicates (F-15).

## 3. Proposed order of the coordinated interventions

The order follows the dependencies; within one intervention every item opening the same component is done together.

| Step | Intervention | Items | Needs first |
|---|---|---|---|
| 1 | Owner decisions still open, counsel's checks, and the three tool checks | F-02, F-09, F-22 threshold, F-25 batch cap, F-07 provider; F-13, F-18 (**counsel**); F-28 to F-30 (**to verify**) | — |
| 2 | Policy, registry and legal texts, as one ChangeProposal and one legal procedure (prepared in Order 16: CP-01, LR-01 to LR-11; adoption waits for the owner's signature and the re-issue) | C1, C2 | step 1 |
| 3 | The api contract version: every read and command of C3 in one contract change | C3 | step 2 |
| 4 | Cores, each repository opened once | C7 | steps 2, 3 |
| 5 | Backend domain and application, with deletion, retention and restoration in the same change | C4, C6 | steps 3, 4 |
| 6 | Payments route and the hold, with its abuse controls | C5, C10 (hold) | step 5 and PV1 qualification |
| 7 | Identity | C8 | step 3 and the provider decision |
| 8 | Web wiring, the public words, and the browser suites | C9 | steps 3 to 7 |

Tests (C11) go with each step, written first.

## 4. How to keep this inventory current

Each new design that needs a functional change adds an F-entry to `ORDER11-FUNCTIONAL-GAPS.md` (or the order's equivalent) and a line
under its component here. When an owner decision or a counsel check closes an open point, the item loses its marker here and its F-entry
records the decision and its date.
