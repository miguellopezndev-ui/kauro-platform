# Order 11: functional gaps found while designing

Order 11 is design only. When a design that the owner asked for, or that the evidence supports, needs behaviour the code does not have,
or the code contradicts a decision in force, it is recorded here with its exact place and how to reproduce it. Nothing here was changed
in Order 11; later orders group the fixes with the other changes to the same components.

Each entry: what the design or the decision says; what the code does, with file and line; how to reproduce it; what a fix would touch;
how sure the finding is (read in the code, or reproduced).

## F-01. CLEAN asks for a destination contract it should not need

**Decision in force.** The owner, 2026-10-20: "Clean your data" is an independent service without a destination CRM; no artificial
target-setup step. A3 §3.3 and ToS §3.2 present CLEAN the same way.

**What the code does (read, not run).**
- Creating a CLEAN project needs no target instance: `packages/domain/src/model/project.ts:73-79` requires `targetInstanceRef` only when
  `mode !== "CLEAN"`. This part matches the decision.
- Starting the free check needs a confirmed, current target contract, with no mode exception. StartAudit (CMD020) takes
  `targetContractId` in its body (`packages/contracts/registry/commands.json:593-603`; `packages/application/src/audit/handlers/start-audit.ts:47`)
  and refuses `TARGET_STALE` unless that contract is confirmed, current and of the revision's project (`start-audit.ts:65-74`). The audit
  then records `target.bodyHash` as its `targetContractHash` (`start-audit.ts:84`).
- The plan compiler gives a CLEAN_ONLY draft a canonical hash that no stored contract carries:
  `packages/application/src/adapters/cores/intelligence/plan-compiler.ts:27-28` (`CLEAN_ONLY_TARGET_HASH`).
- CreatePlan, ApprovePlan and CreateQuote each lock the current contract by the hash the audit or plan carries and refuse `TARGET_STALE` when
  none is found: `packages/application/src/audit/handlers/create-plan.ts:86-87`, `packages/application/src/commands/handlers/approve-plan.ts:98`,
  `packages/application/src/commercial/quotes/create-quote.ts:186, 213`.

**Reproduction (for the order that fixes it).**
1. Create a CLEAN project without `targetInstanceRef` (accepted).
2. Upload and seal a revision.
3. Call StartAudit without a confirmed target contract of the project: expected per decision, the check starts; per code, 422
   `TARGET_STALE` (or a request-shape refusal, because `targetContractId` is a required field).
4. Whether a CLEAN project can reach a plan, an approval and a quote at all depends on which hash its audit and plan carry
   (`start-audit.ts:84` against `plan-compiler.ts:27-28`); the API tests create CLEAN-mode target contracts to get through
   (`apps/api/test/cmd018-cmd019-target-contract.test.ts:59`, per research/kauro-baseline.md §3). Not run in Order 11: to be confirmed by a test.

**What a fix would touch.** CMD020's fields (target optional for CLEAN), StartAudit, CreatePlan, ApprovePlan, CreateQuote and their tests,
and the plan hash rule for CLEAN; no change to the cores' algorithms is implied.

**Design in Order 11.** The CLEAN journey has no target-setup step: choose "Clean your data", upload, check, decide the plan, see the price,
buy, receive the cleaned files and their evidence. Optional output preferences are offered only where they add value (see the page
analysis).

**Certainty.** Read in the code, with line references; not reproduced by running it.

## F-02. Approval and quote as one moment (proposal)

**Design.** Today an approver approves the plan (CMD025), and then an owner or the billing role asks for the quote (CreateQuote) before
paying. The owner asked for a better journey if this sequence adds friction. Proposed: approving a plan issues its quote at once, on the
approved scope, so the person who pays finds the quote waiting; the quote stays formal (14 days, policy `quoteDays`) and nothing is
charged until it is paid. **What a fix would touch.** ApprovePlan's effect (issue the quote in the same unit of work, or enqueue it),
CreateQuote's actor rule, the quote's audit trail, tests. **Status.** Proposal for the owner; not implemented.

## F-03. Self-serve free check from the public site (changes A3 §3.2)

**Decision.** The owner, 2026-10-20: "Check a file free" opens a page on the free check; from there the visitor creates an account or
signs in and continues; a short progressive eligibility step comes before real files; the contact form stays as an alternative. A3 §3.2
sends the call to action to the fit form first. **What it needs.** An amendment to A3 §3.2; the eligibility step's fields recorded where
the onboarding records the buyer type (A3 §3.7) and the agreements (CMD002); the free check's budget and capacity states shown before
upload (A3 §3.2 pause rule; open question Q-4 on 90% versus exhausted). **Status.** Design and simulation only.

**Drawn (2026-10-21).** The page the call to action would open is at /__variants/free-check in the review, beside the approved site.

## F-04. A read of the health check's findings (P-07)

**Design.** The results page shows each finding with its count, its population, examples, the consequence and the fix. **Code.** The API
has no read of the check's findings or of the plan's body (research/kauro-baseline.md §5.1). **Needs.** A findings read model and its
contract, scoped to the tenant, with examples drawn without exposing more data than the plan needs.

## F-05. A read of the estimate after the check

**Design.** After the check, an estimate from the service, the measured units and the current price policy. **Code.** The units are read
inside CreateQuote (`billableUnitsOf`) and the price by `baseCentsOf` (`packages/application/src/commercial/quotes/create-quote.ts:329-330`);
no read exposes them before a quote. **Needs.** A read that returns the measured units and the policy price for the project's service,
marked as an estimate, never a reservation.

## F-06. A read of the project's activity (D-UI13-1)

**Design.** Activity lists typed events (files sealed, check ready, plan revision proposed or approved, quote issued, transfer received,
package verified, downloaded, stage result returned, deletion stage done), each with actor, time and reference. **Code.** No activity
read exists. **Needs.** A tenant-scoped event read built from the existing audit records.

## F-07. Sign-in, sign-up and recovery as the owner decided

**Decision.** Google or email and a password of at least 12 characters checked against breached passwords; verified email; Kauro's own
TOTP always, also after Google; recovery codes; risk-differentiated recovery (an admin may start a member's recovery, never disable the
factor; owners and accounts without another admin recover through Kauro with independent checks and a person's approval; no recovery
without reliable evidence). **Code.** The identity provider is undecided (research/kauro-baseline.md Q-8: Google Identity Platform in code,
Cognito in A9); no sign-up, enrolment, recovery or session-list screens exist (UI50 is blocked). **Needs.** The provider decision, the
flows and their abuse tests (impersonation, administrative abuse, loss of the owner, fraudulent recovery).

## F-08. The registration needs a page the site does not have

**Rule in force.** Data Processing Policy §8.1 and the internal data manual §5.3 (A-01): account registration and the contact form show
an unticked authorisation checkbox with links to the Policy and the Privacy notice, and keep user, document version, date and time as
proof; commercial messages are a separate, optional, unticked choice (A-14). **Gap.** The registry publishes the Service terms (UI45),
the Privacy notice (UI46) and the Data processing terms (UI47), but no page for the Data Processing Policy
(`docs/legal/DATA_PROCESSING_POLICY.md`). **Design in Order 11.** Create account (P-05) shows the required checkbox and the optional one,
linking the Policy at a proposed `/legal/data-processing-policy`. **Needs.** A registry addition for the Policy's page (legal text
published by its own procedure), and the consent record at registration (F-07). The approved contact form should be checked against the
same rule when the public site is next changed.

## F-09. Output preferences for "Clean your data" (proposal)

**Design.** The owner asked whether optional output choices add value. Proposed in Fields, for "Clean your data" only and never required:
the file type (as uploaded, or all CSV in UTF-8) and phone numbers (as in the file, or international format where the country is known).
**Code.** The plan's body has no place for such preferences. **Needs.** Fields in the plan's contract and the core's CLEAN output, decided
with the cores' owner; no change to their algorithms is implied by the design. **Status.** Proposal.

## F-10. A list of the workspace's quotes and orders (P-09)

**Design.** The menu's Billing should open an overview of every quote and order of the workspace's projects: what is waiting for a
transfer and by when, which quotes are open, what is paid with its fiscal document, and any refund; each line opens the existing quote
(UI23), payment (UI24) or order billing (UI30). **Code.** The api reads one quote (GetQuote) or one order (GetPaymentOrder) by id and lists
neither; UI30 without an order can only point to the projects. **Needs.** A read listing the workspace's quotes and payment orders with
their state, amount, key date and fiscal document number, limited to members who may see billing. **Status.** Proposal; UI30's empty
state now leads to the projects instead of ending there.

## F-11. Owner reads across sellers and customers (Sellers, Payouts, Customers, Claims)

**Design.** Round 2 owner pages (P-21 Sellers, P-22 Payouts, P-23 Customers, P-24 Claims; UI37 seller, UI35 customer;
`docs/design/ORDER11-ROUND2-OPS.md`). **Code (read).** The api writes almost everything about a seller but reads one seller's home
(`GetSellerHome`) and one statement by id (`GetCommissionStatement`); it lists no sellers, no seller record with its agreement and rates,
no customers with buyer type and channel, no statements across sellers by period and no claims across sellers (`apps/api/openapi.json`,
paths `/api/v1/ops/sales/*`). **Needs.** Owner-only reads: sellers with their state, agreement in force (rates, retainer) and the money
of F-12; one seller's record, customers, lines and statements; customers with buyer type, acquiring and serving seller, paid projects and
net revenue; statements by period across sellers; claims across sellers with their decisions. No new rule: the data is in
`commission_lines`, `seller_agreements`, assignments and the agencies' buyer type. **Status.** Design drawn from fixtures.

## F-12. Seller money in four categories, each collection counted once (owner decision, 2026-10-21)

**Decision.** Show, per seller and in total: net attributable revenue (what the attributed customers actually paid for the service:
collections, not invoices; net of refunds; without tax, never counted as Kauro's revenue), commission generated, commission pending and
commission paid, never mixed. Never attribute one collection twice (a customer claimed by two sellers counts for the seller the
attribution decided, or by the shares of a split; a repeat project counts in the month it was collected, a refund in the month of the
refund). **Code (read).** Lines carry a base and a share (`packages/persistence/migrations/0030_commission_ledger.sql`); the compensation
guard already compares retainer plus commission against "attributable net service" per period
(`packages/persistence/migrations/0031_statements_payouts.sql:283-300`), but no read exposes these figures per seller or per period.
**Needs.** A read computing the four figures per seller and period from captures (not invoices), refunds and lines, with split shares
applied once, the period of a refund defined, tax excluded. **Status.** Drawn from fixtures (P-21, UI37).

## F-13. A closed list of claim refusal reasons, with evidence (owner decision, 2026-10-21)

**Decision.** Approved list (internal reason, then what the seller reads): already a customer or in direct contact, "Not available to
claim"; another seller's live claim, "Not available to claim"; a recorded owner rule, "Not available to claim"; not enough evidence of the
seller's own work; outside the seller agreement; duplicate of the seller's own claim; Other, which needs a written note, "Not available to
claim". The owner sees the internal reason, its evidence and the history; the seller never reads anything that reveals a commercial
relationship or a third party's claim. The legal validation of the contractual claim rules is pending, and the owner's screens say so.
**Code (read).** The claim machine moves SUBMITTED to DISPUTED on a conflict and keeps a free-text decision reason
(`AttributionView.decisionReason` in `apps/web/src/api/generated.ts`); there is no closed reason list, no evidence reference per refusal and
no seller-facing message. **Needs.** A closed, versioned reason code, an evidence reference and a note (required for Other) on a
refusal, the seller-facing message derived from the code. **Status.** Drawn (P-24; UI34 "Not available" state); list to be validated
by counsel (F-18).

## F-14. A seller's request for a review, and the decision history

**Decision.** The seller can ask for a review of a refusal or of "Not available"; the owner sees every decision in order. **Code (read).**
No command lets a seller ask for a review of a claim decision, and no read returns a claim's decision history. **Needs.** A seller command
(review request, optional note), an owner decision on it (uphold or change, with a reason code), the history as an append-only read, and
an email to the seller with the outcome. **Status.** Drawn (P-24 "refused" state; UI34 "Ask for a review").

## F-15. Alerts computed from real data (owner decision, 2026-10-21)

**Decision.** Two distinct controls, plus blocked. Inactivity: a project is flagged after 14 days without relevant progress, even with no
deadline near. Deadlines: 2 days before an important date (file deletion, quote expiry, payment due, claim end), or at once when it has
passed, whatever the activity. Blocked: the next step cannot happen. Seller claims alert 14 and 3 days before their recorded end. A
pilot's review is prepared 14 days before it ends, changing no agreement. One item appears once, under its most urgent kind (blocked,
deadline passed, deadline within 2 days, inactivity), its other conditions as a second line; no redundant notifications. **Code (read).**
No alert computation exists; there is no definition of "relevant progress" and no activity read (F-06). **Needs.** A definition of
relevant progress per stage, an alert read for the owner and for a seller's claims, deduplication per item with the precedence above, and
the emails of the seller research (`research/round2/seller-portal.md` §8.4). **Status.** Drawn (UI33 Alerts; Settings, Alerts, marked
"Needs backend").

## F-16. The retainer: zero by default, accrued and paid when a signed agreement sets it (owner decision, 2026-10-21)

**Decision.** A new agreement's retainer is USD 0.00. When a signed agreement sets one, it is respected, shown wherever the rates are and
included in what is owed. **Code (read).** `seller_agreements.retainer_cents_per_month` defaults to 0 and cannot change after preparation
(`packages/persistence/migrations/0029_sales_attribution.sql:214, 705`); the period close reads it only for the compensation guard
(`packages/application/src/commercial/statements/close-period.ts`, step 6), and no statement item accrues or pays it. **Needs.** A monthly
retainer item on the statement (from the agreement's start, prorated or not as the agreement says, ending with the engagement), paid with
the statement, and the reads of F-11 exposing it. **Status.** Drawn with a synthetic agreement (Amara Okafor, USD 150.00 a month) on P-21,
UI37, UI36, P-22 and Settings.

## F-17. Offsets after a refund, shown on the statement (owner decision, 2026-10-21)

**Decision.** An offset appears when it happens, on the statement, with its basis (which refund, which project, which rule or clause), its
amount and the resulting balance; applied only under the agreement in force and the applicable legal rules, never presented as automatic
beyond that. **Code (read).** The statement already takes "adjustments not reported before, offsets and the owner's recovery items"
(`close-period.ts`, step 5) under each agreement's offset terms (`packages/domain/src/commercial/statements.ts:29-33`); the statement item
view does not expose the refund reference, the adjusted line or the clause. **Needs.** Item fields for the refund reference and amount, the
adjusted line, the rule or clause reference, and the statement's balance (earned, held, offsets, retainer, payable). **Status.** Drawn with a
synthetic refund (RF-2026-0007, Coastline Analytics) on UI36, UI37, UI35 and P-21.

## F-18. "Pending legal review" on contractual rules

**Decision.** Until counsel validates them, the claim rules (the 90-day claim, the refusal reasons, the tail after an engagement ends) are
marked "Pending legal review" on the owner's screens. **Code.** No field records the legal status of a policy rule
(`packages/contracts/registry/policy.json` holds the values only). **Needs.** A status per rule group (validated or pending, with the
date and reference of the validation), read by the owner's pages. **Status.** Drawn as a fixed marker (P-24; Settings, Commissions).
