# Owner resolution on ChangeProposal CP-01 (2026-10-22)

Status: owner decision, 2026-10-22, communicated in the Order 16 resolution ("Orden 16 — Resolución del propietario sobre CP-01 y
autorización de fusión de PR #122"). The owner delegated the choice of these decisions expressly ("la decisión que tomes es la que yo
tomaré") and the resolution is the owner's communicated authorization to record them. It is not a new build order.

**Form.** This record is the owner's decision as communicated. No handwritten, cryptographic or professional signature is claimed or
imitated. If a procedure requires a formal external signature, that act stays pending (section 4) and does not hold back the
documentary incorporation below.

**Effect.** It decides the substance of the fourteen CP-01 items (`docs/authority/proposals/CP-01-FUNCTIONAL-GOVERNANCE.md`, delta
`CP-01.registry-delta.json`, revision 2). It adopts nothing into the vendored registry (`packages/contracts/registry/` is unchanged),
re-issues no authority and deploys nothing: a business authorization is not a deployment. Normative adoption is coordinated with CP-02
(Order 17) and its tests in one re-issue; a change whose behaviour or legal documentation is not ready does not enter into force early.

## 1. Decisions

| Item | Owner decision | In the proposal |
|---|---|---|
| CP-01.01 | **Approved.** "Clean your data" is an independent service; no target contract is required. For CLEAN, StartAudit, CreatePlan, ApprovePlan and CreateQuote use the canonical CLEAN binding. No artificial CRM is introduced. | `APPROVED_AWAITING_REISSUE` |
| CP-01.02 | **Approved.** One extension of up to 72 hours, also for the free check. Only when expressly requested and authorised may it pass the ordinary 14 days from sealing, never 17. One per project. Without it the earlier limits stay. Activation needs deletion, restoration, SQL policies, dates and compatible legal documentation implemented and tested. | `APPROVED_AWAITING_REISSUE`, activation conditions listed |
| CP-01.03 | **Approved.** The internal pause threshold for new free checks is 90% of the budget actually funded. The public Terms are not changed automatically: their text goes through its own amendment procedure (LR-11). No additional spending is authorised. | `APPROVED_AWAITING_REISSUE` |
| CP-01.04 | **Content approved; legal effect conditional.** The seven codes and the neutral messages are accepted. The owner sees the cause and its evidence; the seller sees only the permitted explanation and may ask for a review. `OTHER` needs a note and evidence. `OWNER_RULE` must name a rule actually in force and versioned; it authorises no arbitrary or retroactive decision. Contracts and tests may be prepared; the claim rules stay subject to competent legal review. | `APPROVED_AWAITING_REISSUE`, legal effect through CP-01.14 |
| CP-01.05 | **Approved.** Default monthly retainer USD 0.00. A signed agreement with another amount prevails under its dates and terms. An obligation already accrued is never removed. | `APPROVED_AWAITING_REISSUE` |
| CP-01.06 | **Approved.** Inactivity 14 days without relevant progress; deadlines two days before and at once when passed; claims 14 and 3 days before they end; pilot review prepared 14 days before; one alert per fact, showing the other circumstances without duplicating it; precedence blocked, overdue, due soon, inactive. | `APPROVED_AWAITING_REISSUE` |
| CP-01.07 | **Approved with modification.** Not every persisted command resets inactivity. Relevant progress is only a material, verifiable change of the state of the project or its deliverables: a new sealed revision, a concluded check, an effective decision on a plan, an approval, an issued quote, a payment actually reconciled, a preparation, a delivery, an import, or an equivalent act that legitimately changes the course of the project. Reads, downloads, sign-ins, reminders, ordinary support messages, commands without material effect, failed retries and repeated actions that change no state do not count. Progress affects inactivity alerts only; **it never extends retention, legal deadlines or a quote's validity.** | Delta corrected; `APPROVED_AWAITING_REISSUE` |
| CP-01.08 | **Approved.** The UI03 and UI07 headings authorised by R2-1 and R2-2 are adopted at the re-issue. | `APPROVED_AWAITING_REISSUE` |
| CP-01.09 | **Deferred.** The new wording of UI03's action is not approved. The current text stays; the proposal is kept for the final visual review before the second audit. | `PROPOSED`, deferred |
| CP-01.10 | **Design approved; publication conditional.** Screen UI56 and the versioned publication mechanism of the Personal Data Processing Policy may be prepared. Pending: real company data, competent review, and verification that the content reflects the processing actually carried out. No incomplete, false or unreviewed policy is published. Consent and its proof keep essential obligations apart from optional commercial authorisations. | `CONDITIONAL` |
| CP-01.11 | **Parameters approved; activation blocked by PV1.** Five US banking days from the valid acceptance of the proof; the FedACH and US banking-holiday calendar, documented from official sources; an absolute limit of 24 days from sealing; one hold per quote and per sealed set; never renewable nor added to another extension (the later date applies, within the absolute maximum); owner review from the third hold ended unpaid in a rolling 90-day window per organisation; step-up authentication to present the proof; the proof refers to a transfer already sent, with exact amount and reference. The effective end is the earlier of the five banking days and the 24-day limit; the customer sees the real date. A declared transfer or a proof is not confirmed payment, starts no preparation and creates no commercial authorisation. Unreconciled at the end: deletion; a late credit goes through review and refund, never reviving data. Not adopted into the operating registry nor activated before Wise Business is enabled, real verifiable evidence exists, and implementation, abuse controls and legal review are done. The calendar is not presumed for any route other than ACH. | `CONDITIONAL`, values recorded |
| CP-01.12 | **Approved with a security modification.** At most 100 groups per bulk decision. Same normalised email and same normalised full name is a strong signal of a possible duplicate, not proof of identity. A deterministic merge without human confirmation needs exclusively the proven-identity rules the core authorises (a source identifier within the same identity space, or an external identifier declared authoritative and verified). Name-and-email matches stay candidates, decided in batches of up to 100 groups with an exact preview and explicit human approval. Blocks kept: distinct CRM identifiers that cannot be unified safely, generic or shared addresses, consent conflicts, chains of matches that do not prove identity, any material contradiction about the identity or the surviving record. Accents, plus-addressing and other characters are never folded to manufacture a proven identity. Decision, evidence, person, version and effect are recorded. The core is not changed here. | Delta corrected; `APPROVED_AWAITING_REISSUE`, activation through the core |
| CP-01.13 | **Approved.** A collection belongs to the period in which the money was captured and confirmed; a refund to the period in which it actually happened, without rewriting earlier collections. Refunds and adjustments are reflected in the right period, linked to the original operations. A capture counts once; taxes are not part of the commission base. Commissions earned, held, payable and paid are kept apart. Signed agreements are respected. | `APPROVED_AWAITING_REISSUE` |
| CP-01.14 | **Approved.** The state of the claim and commission rules is `PENDING_COUNSEL`; it does not change to legally approved without evidence of the competent review. | `APPROVED_AWAITING_REISSUE` |

## 2. What this record does not do

- It does not apply any delta to the registry, edit `packages/contracts/registry/`, or re-issue the authority.
- It does not change the public Terms (CP-01.03, LR-11) or publish the Policy (CP-01.10).
- It does not activate the pending-payment hold (CP-01.11) or a deterministic merge rule (CP-01.12).
- It does not validate any claim or commission rule legally (CP-01.04, CP-01.14).
- It authorises no spending.

## 3. Merge of PR #122

The owner authorises the documentary merge of PR #122 (Order 16) on the conditions of the resolution: proposals, documentation,
tests and drafts only, with no change to the registry in force; these decisions applied on the Order 16 branch; CP-01, contract,
drift and affected tests run; full CI green on Linux and Windows for the final SHA; a short independent review of the modified
decisions and of the absence of premature adoption; merge against the latest `main`; CI checked after the merge.

## 4. Still pending

- A formal external signature, only if a procedure requires one.
- Competent legal review: claim and commission rules (L-12, L-19), LR-01 to LR-06, LR-11, the Policy (D-31).
- Real company data for the Policy (CHECKLIST A-08).
- PV1: Wise Business enabled and the evidence the ACH route really gives (Payments V1 §2).
- The core intervention for CP-01.12 (component C7) and the implementing orders for every item (C4, C5, C6, C9, C10, C11).
- CP-01.09: the final visual review before the second audit.
