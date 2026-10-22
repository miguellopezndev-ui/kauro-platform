# Order 11, round 3: the delivery report

**Date:** 2026-10-22. **Branch:** `order11/private-review` (PR #118). **Status:** stopped by the owner on 2026-10-22 to keep a quota
margin for other orders. The owner then asked for the best combination so far to be merged and reported. That is this report.

**Resuming the work: read `ROUND3-HANDOFF.md` first.**

## 1. What this merge contains, and what it does not

**It contains:**
- the round 2 private-review screens already on this branch;
- the round 3 design records in `docs/design/`:
  - **`ROUND3-KIT.md` v0.9:** the system kit, with change requests CR-1 to CR-4;
  - **`ROUND3-VOICE-AND-TERMS.md`:** the voice and terms;
  - **`ROUND3-PRODUCT-DECISIONS.md`:** the product decisions, PD-01 to PD-08;
  - **`ROUND3-CANONICAL-WORLD.md`:** the canonical world;
  - **`ROUND3-DECISIONS-REGISTER.md`:** the decisions register;
  - **`ROUND3-PROGRESS.md`:** the progress ledger;
  - **this report.**

**It does not contain:**
- **Round 3's designs as product code.** They exist as built, gated and blind-judged HTML studies in the archive
  (`Kauro.archive\Deliveries\Visual\order11\research\`). Moving them into `apps/web` is the implementation phase, and it was never
  started.
- **Anything from the locked areas:** Migration Core, Intelligence Core, money, ledger, tax, authorisation and versioned legal text
  are untouched.

## 2. The best combination, page by page (what to implement)

Every choice below came out of a blind round robin with 3 calibrated judges in both side orders, under the rule: a clear win needs at
least 2 of 3 judges in both orders and a lead of at least 5 of 75 points. The corrected incumbent always competed. Ties were broken
by my review (master plan §9.5) and say so. Each page's record is its `AUDITIONS.md`; the finals are in each page's `final/` folder.

### Owner console

| Page | Chosen composition | State | Main carried fixes |
|---|---|---|---|
| Nav and shell | **V1** on inventory **I-A** | Decided (L2) | 18 destinations; counts sum to Today's 7 |
| Today | **t3**, sections A-s1, B-s2, C-s0 | **Final, critiqued, done** | Copy fix pass 2 (sums, glossary words, no "Confirm paid") |
| Finance | **f1**, L4 incumbents kept | **Final, critiqued, done** | Tables keep column heads for screen readers |
| Payouts | **p1**, L4 incumbents kept | **Final, critiqued, done** | Approval in place (K36); invented cut-off removed (G-P8); counsel date corrected |
| Refunds | **u1**, L4 incumbents kept, plus "Go to the decision" on phones | Final built; critique "not ready, fixable"; fix pass **cut off** | Amount field must drive its figures (H1); the money-movement states (H2) |
| Claims | **c2**, queue A-s0 plus four fixes, ending section **B-s4** (dated list) | Final built and gated; one fix **cut off** | The accept reason becomes free text (no invented list, OQ-C2) |
| Customers | **k2** (grouped by what each customer needs) | Final built; critique "ready with fixes"; fix pass **not run** | Phone amount and date run together; draw the reassignment form; correct the decisions count |
| Sellers | **s1** (owed first) | Decided at L3; final **cut off** | Phone rule; one footnote; a phone money cell |
| Support cases | **v1** (queue first; tie with v2 broken on consistency) | Decided at L3 | Reply under the conversation |
| Owner actions | **a3** (dated ledger with NOW) | Decided at L3 | Restore four facts in its rows |
| Prospects, Outreach, Resources, Jobs, Incidents, Deletion, Operating review, Releases, Settings | none yet | L3 started, paused; partial briefs in each folder | |

### System kit (`ROUND3-KIT.md`)

- **Decided families:** K27 v3, K21 v3/v1, K29 v1, K36 v2, K03 v3, K04 v1 (static), K32 v1, K31 v0 (fixed), K17 v2, K24 v1 (no
  toasts), K41 v1 with v3's apparatus, K18 v1, K16 v0 with "of N".
- **Group B** (K38 panels, K11 facts, K09 tables, K35 filters): auditions built and 24 judging batches ready, but not judged. K09 v2's
  sticky column was removed (BR-23).
- **The kit stays v0.9.** The v1 freeze (CR-1 to CR-4) did not happen.

### Deliverables

| Deliverable | Chosen | State |
|---|---|---|
| Package entry point | **e2**, plus the plain-file fix | Decided, final built |
| Importer guide | **g1**, plus three fixes | Decided, final built and critiqued |
| PDF report | **r2** | Final built; critic fix pass **cut off** |
| Health check report, quote summary, commission statement, client summary, audit summary, emails | none | Not started |

### Not started

- the agency workspace;
- the seller portal;
- the public site, including the owner's pending items (Home's services band, "Limits of a project", wine on How it works and
  Services, the head merging into the first section);
- the review of all four sites together.

## 3. Truth findings the product should act on

The design audits found these against the canon and the contracts. They are product facts, not taste:
- **The importer guide:** the incumbent states wrong Salesforce steps, and the field `Kauro_Key__c` is named wrongly.
- **F-31:** the report reader refuses packages with rejected rows.
- **Today and the prototypes:** many incumbent figures come from `prototypes/sales.ts`, not the canon (Customers F1, Sellers, Claims
  F1, Support F-cases). Every final reads the canon.
- **Missing contracts:**
  - promoting a release, sending an incident notice, and three more owner acts on Today (Owner actions audit);
  - replying to a support case, reading its messages, changing its state;
  - refusing a refund;
  - publishing a seller resource (G-6);
  - "send back with a note" on outreach (OWN-11).
- **Where a refund transfer is recorded:** the screen registry gives it to Owner actions, not Refunds.

## 4. Questions only the owner can answer

- **OQ-C1:** should accepting a claim ask for the identity check? The contract says never.
- **OQ-C2:** should accepting a claim offer a fixed list of reasons? The contract has free text.
- **OQ-R1 to OQ-R4 (Refunds):**
  - may a refund be decided before counsel answers;
  - who writes what the customer reads after a refusal;
  - does refusing need the identity check;
  - is a held commission offset or voided after a refund.
- **G-P8:** should there be an approval cut-off before the pay-by date?
- **Customers:**
  - may a workspace be suspended as well as restricted;
  - are workspaces of one owner grouped;
  - who restricts or lifts a workspace.
- **Support:** what sets "next answer due"; Resolved or Closed; severity; who reads a reply.
- **Owner actions:** should the page keep a full history of the owner's acts; who makes a payout transfer.

## 5. How to resume

1. Read `ROUND3-PROGRESS.md`, then each page's `AUDITIONS.md`.
2. Finish the cut-off passes first: the Refunds fixes, the Claims accept field, the Sellers final, the Customers fixes and the report
   fixes.
3. Use a cheaper method: 2 judges per pair for Tier B, one outside critic per site, at most 6 agents at a time.
4. Implement in `apps/web` only after a site's pages are final, one coordinated change per component (D-34).
