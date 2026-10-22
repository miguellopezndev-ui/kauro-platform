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

## F-19. The one extension also for the free data health check (owner decision, 2026-10-21)

**Decision.** A voluntary extension of up to 72 hours may also be requested for the files and results of a free check nothing was bought
after. **Code (read).** The extension exists (CMD060, `kauro.retention_extensions`, at most one per project): `softDeadline =
least(previousSoftDeadline + requestedSeconds, hardDeadline)`, and the hard deadline never moves (`packages/domain/src/model/source/records.ts`,
`RetentionExtensionRow`; policy `retention.softExtensionsPerProject` 1, `softExtensionMaximumSeconds` 259200). The screens built so far
never offer it before a purchase. **Opens.** policy (the one extension covers the unpaid class); api/backend (CMD060 accepted on an unpaid,
sealed revision, owner or admin); DPA/legal text (ToS §13.1 and the public Data handling words: the free check's 7 days "or up to 3 days
more on request"); deletion/retention jobs (the sweeper reads the extended soft deadline for the unpaid class); tests (one extension per
project across the unpaid and paid classes; a request after the soft deadline is refused). **Depends on** F-20. **Status.** Drawn: P-30
"extended", UI13 "extended", UI29 "check" and "check-extended".

## F-20. An exceptional ceiling of 17 days from sealing, reached only through the extension (owner decision, 2026-10-21)

**Decision.** The ordinary absolute limit of a free check's files stays 14 days from sealing; only when the extension is requested may they
stay longer, to an exceptional maximum of 17 days from sealing. **Code (read).** `SOURCE_RETENTION.unpaidDaysHardFromSeal` 14 and
`extendHardCap: false` (`packages/domain/src/model/source/policy.ts:39-46`; registry `retention.extendHardCap`); the extension is capped at
the hard deadline, so today it can never pass 14 days. **Opens.** policy (a new key, for example `unpaidDaysExtendedCeilingFromSeal` 17,
with the hard cap movable for the unpaid class only, as a new retention policy version, `RETENTION_POLICY_VERSION`); contracts/registry
(policy.json and its drift test, `SNAPSHOT_PATHS`); DPA/legal text (ToS §13.1, the retention annex, and the public Data handling page through
`apps/web/src/public/retention.ts`, the lead's); deletion/retention jobs (the hard deadline of an extended unpaid record becomes
min(extended soft deadline, sealing + 17 days)); restoration (a backup restored after that deadline never brings the files back); tests (14
days without the extension, at most 17 with it, never more). **Status.** Drawn with the "Proposed" marker on every date table (P-30, P-31,
UI29).

## F-21. A separate, limited hold while a sent bank transfer is confirmed (owner decision, 2026-10-21; value proposed)

**Decision.** A transitional retention, separate from the free check's and from the paid project's, for an order whose bank transfer was
legitimately initiated and waits for confirmation. Proposed initial value: five business days from the proof, to be checked against the
enabled payment method (ACH and domestic wire through the Wise route, PV1) and the evidence that method really gives. **Code (read).** The
bank-transfer extension of the payment order (`AWAITING_TRANSFER`, `PARTIALLY_RECEIVED`, `RECEIVED_REVIEW`) exists but is deliberately not
wired (`packages/domain/src/commerce/machines.ts:206-226`); retention has no class for a pending payment; no command records the proof of an
initiated transfer. **Opens.** policy (a hold class: business days of the published coverage calendar, anchored on the accepted proof, with
its ceiling and uniqueness, F-22); payments (the proof intake: the bank's confirmation document and/or trace number, amount and reference;
how it is checked against the route's evidence; the order states it moves); contracts/registry (a command such as RecordTransferProof,
AGENCY_BILLING, step-up to be decided; its events; the order and retention views carry the hold); api/backend; deletion/retention jobs (a
pending-payment retention record whose end deletes the files unless an exact credit was captured); restoration (a restored backup never
revives files whose hold ended); DPA/legal text (ToS §8 and §13: the hold, that it is not payment, that a late transfer is reviewed and
returned; the DPA retention annex: a new period and its purpose); tests. **Depends on** the PV1 qualification of the route and its evidence
store, F-22, F-23. **Status.** Drawn: P-31 (all states), P-30 "held", UI13 "held", UI29 "held".

## F-22. Abuse limits of the hold: a fictitious or repeated order never keeps files indefinitely (owner decision, 2026-10-21)

**Decision.** A fictitious or repeated order must not prolong the files. Designed limits, all visible on the screens: the hold starts only
with the proof of a transfer already sent, for the exact amount, with the order's reference; one hold per quote and per sealed set (another
order on the same quote, a new quote for the same files or a second proof starts none); never renewed; never added to the extension (the
files go on the later of the two dates, never their sum); never past 24 days from sealing whatever happens (proposed ceiling); a hold that
ends without the money deletes the files, and a late credit is reviewed and returned. **Code.** None of this exists (no hold, F-21).
**Opens.** abuse controls (uniqueness per quote and per sealed set enforced in the database, not only on the screen; a workspace counter of
holds that ended unpaid, with owner review above a threshold the owner sets; an owner queue of proofs that never matched a credit); policy
(the ceiling and the threshold); contracts/registry (refusal codes such as HOLD_ALREADY_USED, PROOF_REQUIRED, CEILING_REACHED); payments (a
proof that does not match the route's evidence ends the hold early, decided by the owner); tests (adversarial: two orders on one quote, a new
quote for the same sealed set, a proof after the files' date, a proof for another amount or reference, a hold asked for a deleted revision,
concurrent requests). **Depends on** F-21. **Status.** Drawn as "What a hold can and cannot do" and the "second" state (P-31).

## F-23. Preparation never starts on a hold

**Decision.** Execution must not start until the payment is truly confirmed. **Code (read).** CMD036 ExecuteProject needs an ACTIVE commercial
authorization, which exists only after capture (`apps/web/src/screens/processing/model.ts`, `executeOffer`; the paid entitlement in
`packages/domain/src/commerce/machines.ts`). **Opens.** tests only, once F-21 exists: a hold, a partial or a pending credit never yields a
commercial authorization; the preparation page and the Overview say that preparation starts only after Kauro confirms the payment (drawn).
**Depends on** F-21. **Status.** Drawn (P-30 "held", P-31 "held", UI13 "held").

## F-24. The five dates kept apart in every read and every screen

**Decision.** Quote expiry, free-check retention, extension, pending-payment hold and paid-project retention are distinguished everywhere
they appear. **Code (read).** The quote view carries `expiresAt` and `sourceAvailableUntil` only (`QuoteView`); no read gives the customer's
screens a project's retention record, its extension or a hold (UI29 is drawn from fixtures). **Opens.** contracts/registry and api/backend
(a project dates read: each of the five with its date, rule, state and who may act; the quote and order views link to it); web copy (one
label per date on Quote, Payment, Overview, Projects, Data and deletion, Billing and Help); public Help and Data handling words (lead);
DPA/legal text (the same five names in ToS §6.2, §8 and §13); tests (the five labels never merge; no screen shows a hold and an extension as
added). **Depends on** F-19 to F-22. **Status.** Drawn as one shared table (`tools/review/private/prototypes/retention-dates.tsx`) on P-30,
P-31 and UI29.

## F-25. Batch unification: demonstrated identities applied together, probable duplicates decided in bulk by a person (owner decision, 2026-10-21)

**Decision.** Decisions may be applied together where identity is demonstrated and no blocking conflict exists. Probable duplicates may be
reviewed, selected and decided many groups at once, never treated automatically as demonstrated. A precise preview of effects, exclusions
and conflicts always comes first; decisions can change before execution. **Code (read).** The plan has no read (`apps/web/src/screens/
approval/model.ts:8-9`), and CreatePlan/RevisePlan are inert (`CORE_SERVICES_UNAVAILABLE`, kauro-baseline §5.1); there is no evidence class,
no batch command and no preview. **Opens.** policy (the definition of a demonstrated identity, for example the same normalised email and the
same normalised name; the blocking-conflict rules: existing separate CRM record IDs, shared or role addresses, consent conflicts; the kept
record and field rules; a batch cap); contracts/registry (commands to apply a demonstrated batch, decide many probable groups, change one
decision and undo a batch; the plan read with evidence class, paging and the preview; decision events); api/backend (a preview hash the apply
must match; idempotent apply; undo before approval); cores (evidence classification; detection of existing CRM record IDs and shared
addresses in the export; a deterministic kept-record rule); DPA/legal text ("demonstrated" is a technical class, not a guarantee; nothing is
written to any CRM); abuse controls (only owner, admin and operator decide; batch caps; rate limits; every decision in the audit log). **Depends
on** F-04 (findings read) and the plan read. **Status.** Drawn: UI20 "demonstrated", "normal", "blocked", "changed", "decided".

## F-26. A change after approval is a new plan revision, validated and approved again (owner decision, 2026-10-21)

**Decision.** Where applicable, a change after an approval needs a new plan version, its validation and its authorisation; the approved
revision stays in the record, and its quote no longer applies to the new revision. Kauro never promises to revert anything already done in a
CRM, because it never writes to one. **Code (read).** Approvals are bound to a revision and never reused (PUB:236; CMD025, CMD026), and
CreateQuote refuses `PLAN_SUPERSEDED` / `APPROVAL_NOT_CURRENT` (`create-quote.ts:186-216`); RevisePlan is inert. **Opens.** contracts/registry
(the revision event names what changed, with the decision trace); api/backend (RevisePlan wired; a new revision withdraws the open quote
for the old one, with the reason shown); tests (a quote never survives its revision; an approval is never carried to a new revision).
**Depends on** F-25. **Status.** Drawn: UI22 "revised"; "Who decided the duplicates" on every approval state.

## F-27. Adversarial identity tests (owner decision, 2026-10-21)

**Decision.** Keep traceability and adversarial identity tests. **Opens.** tests (shared and role addresses such as info@ and sales@;
plus-addressing; look-alike characters and accents; chains of three or more records; existing CRM record IDs on both rows; consent
conflicts; a batch prepared on stale data or applied twice concurrently; very large batches; undo then re-apply, with the trace kept);
cores (a fixture set of synthetic adversarial files, never real data). **Depends on** F-25.

## F-28. Salesforce dependent records without typing an ID: the route per object (owner decision, 2026-10-21)

**Decision.** The customer never fills in AccountIds by hand. An External ID field already appropriate for the org is used when the
confirmed org metadata shows one holding the source key (upsert; dependants name their parent by that key); no new field is ever a
universal condition, and Kauro never has CRM access. **Code (read).** The target contract stores uploaded metadata (CMD018, CMD019;
`packages/domain/src/model/target-contract.ts`); no rule reads External ID fields from it, and the Data Loader profile
(`SALESFORCE_DATA_LOADER`) has no upsert or related-object path. **Opens.** cores (read External ID fields from the confirmed metadata;
choose the route per object; an Upsert path with related-object lookups; a source-key column in every Salesforce file, left unmapped; the
`.sdl` mapping files per stage); contracts/registry (the route per object in the plan and the import stage read); DPA/legal text (Salesforce
record IDs become customer data Kauro processes); tests. **To verify:** the Upsert related-object step as Data Loader names it.
**Status.** Drawn: UI27 "sf-external-id", "sf-chain".

## F-29. Staged reconciliation of Salesforce results and the generated dependent package (owner decision, 2026-10-21)

**Decision.** Where Salesforce-generated IDs are needed, the team imports the parent records and returns Data Loader's success and error
files; Kauro reconciles them and generates the dependent package with IDs proved by that evidence. Ambiguous, rejected or unmatched rows are
blocked, each with its action; this extends to Opportunities → Accounts and OpportunityContactRole → Contact and Opportunity. **Code (read).**
Import stages exist (CMD040 receipt, CMD041 continue; states PREPARED … VERIFIED_SUCCESS / VERIFIED_PARTIAL / NEEDS_CORRECTION,
kauro-baseline §5.3), but no reconciliation reads a success file, proves an ID or generates a file. **Opens.** contracts/registry (the import
stage read: parent links, a generated flag, blocked rows with reason and action, held-back counts; CMD041 releases generated stages; a
command to choose which ID to keep when a source key was imported twice); api/backend (a reconciliation engine: one success row per source
key, the ID prefix of the object, 001 / 003 / 006; generating dependent and top-up files); cores (the generated files are built from proved
IDs only, never a guessed link); retention (result files kept 7 days after their check, and while a dependent stage is still open: a new
policy key); DPA/legal text (Salesforce IDs and error messages processed); abuse controls (size and row limits on returned files; a cap on
resubmissions); tests (reconciliation edge cases: duplicate-rule and validation rejections, missing rows, a key imported twice, ambiguous
matches; fingerprints of the evidence files). **To verify:** that Data Loader's success and error files repeat the unmapped source-key
column. **Depends on** F-28. **Status.** Drawn: UI27 and UI28 "sf-reconciled".

## F-30. HubSpot associations: no generated IDs, the returned error file still checked

**Decision asked.** Say whether HubSpot associations benefit from the same evidence-based reconciliation. **Answer drawn.** HubSpot's
importer links records across files by a shared unique value (email for contacts, company domain for companies), so Kauro generates no ID
file; it still checks the error file of the linking stage and lists each link not made with its action. **Opens.** cores and api/backend
(read HubSpot's error file for association errors); tests. **To verify:** whether a HubSpot export includes the associated company's record
ID (it would let Kauro prove links, not only failures). **Status.** Drawn: UI27 "hs-links" and a permanent note on HubSpot import pages.

## F-31. The report reader refuses a package that holds an unreadable row (defect found in round 3, 2026-10-22)

**Found.** Migration Core 3.0.0 was run on the canonical world in a scratch copy (`Kauro.archive/…/research/round3-docs-canon/
CANON-PACKAGES.md`). Every package verified. The platform's report reader still refused the two that held a row the core could not
read:
- `packages/reports/src/package.ts:376` compares the manifest's `dataRowCount`, which leaves rejected rows out, with a total that
  counts them;
- `:411` does not accept the `contribution_kind` `NONE` that the core writes for such rows.

No acceptance package holds such a row, so no test catches it. **Effect:** a customer whose file has one malformed line gets a
verified package but no PDF report. **Opens.** platform (`packages/reports` package reading; logic, outside the design run); tests (an
acceptance case with rejected rows). **Status.** Recorded, not changed: round 3 changes presentation only.

## F-32. The report reader needs about 3.4 GB of memory for a 71,380-row package (found in round 3, 2026-10-22)

**Found.** The same run: the reader ran out of memory at Node's default heap (about 2 GB) on the canonical Salesforce project. It
rendered with `--max-old-space-size=8192`, peaking at about 3.4 GB. **Effect:** large real projects may fail in the worker. **Opens.**
platform (the reader reads whole files into memory; stream or bound it); data-plane worker limits; tests at scale. **Status.**
Recorded, not changed.
