# B10 — case map

Every case of package B10 (`node tools/package-brief.mjs B10`: 64 cases, gate G-COMMERCIAL, owners 15, 16, 17, 12 and 18) mapped
to the tests that will demonstrate its expected outcome, their evidence class, what the check observes, and the later package and
case of any clause B10 cannot demonstrate. Design: `docs/design/B10-commercial-domain.md` (decisions `D10-*`). Mandates:
`docs/design/B10-mandates.json`. Worked examples: `reference/COMMERCIAL_LEDGER_WORKED_EXAMPLES.md` routed by the registry's
`commercial_example_routes.json`; a title names its example ("example 8") and uses the example's integer cents as the oracle.

Every test is cited as `` `file` :: "exact test title" ``. `tools/test/b10-case-map.test.mjs` reads this file: a cited file that
exists must contain a test with exactly that title; a cited file that does not exist yet must be listed in the `tests` of exactly one
mandate of `B10-mandates.json` and cited on a `- PLANNED` row naming that mandate; every mandate's test file is cited here; every DENY
and RACE section states its registry scenario (D10-CASEMAP-1); every worked example routed to a B10 case is named by a title.

Row classes (21 "Evidence classes"; A4 records: case | test file :: exact title | status | commit):

- **PLANNED EXECUTED_LOCAL** — the mandate writes this test first; it runs the real domain, handlers, commission service and
  PostgreSQL 17 through the runtime login roles, the superuser only as oracle; B09's provider fakes may produce a capture, but no
  fake decides the asserted clause.
- **PLANNED SIMULATED** — the asserted clause passes through a labelled contract fake (buyer type, preparation completion, banking
  calendar, payout evidence) and is never EXECUTED_PROVIDER.
- **EXECUTED_LOCAL (existing)** — a test already on the base that demonstrates a half of the case.

When a mandate lands, its rows lose the word PLANNED and gain the commit; nothing is PASS by being listed.

## Status at `b10/base`

The planned status of each case once every mandate has landed: **EXECUTED_LOCAL** when no clause needs a later package; **PARTIAL**
when one does, named with its package and registry case (or "no registry case" with the gate). The check keeps the counts equal to
the section's rows and the status consistent with the later column.

Totals: 64 cases — 54 EXECUTED_LOCAL, 10 PARTIAL.

| case | planned status | rows | later package and case |
|---|---|---|---|
| R2-079 | EXECUTED_LOCAL | 4 EXECUTED_LOCAL, 0 SIMULATED — the pool function; B09's kernel; the ledger; example 1 end to end | none |
| R2-080 | EXECUTED_LOCAL | 4 EXECUTED_LOCAL, 0 SIMULATED — the arithmetic; B09's kernel; the cumulative adjustment; examples 2 and 6 end to end | none |
| R2-086 | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — the set rule; the set function; CreateQuote at 500 bps for another end client | none |
| R2-087 | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — the thresholds; CreateQuote at 1000 bps counting each prior project once | none |
| R2-088 | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — the thresholds; the frozen snapshot through later history | none |
| R2-089 | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — the set function after a full refund; CreateQuote at 0 bps with the designation kept | none |
| R2-090 | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — the slot guards; the slot race at the adapter; the last slot through CreateQuote | none |
| R2-091 | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — the offer reader; a fourth agency quoted and ordered | none (B08 enforces the operational limit itself, R2-046) |
| R2-092 | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — the replacement quote and re-binding; its crash and refusal paths; end to end | none |
| R2-093 | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — the refusal with the comparison; the charge only after refund and acceptance | none |
| R2-094 | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — the window computation; the database check; the endpoint accruals | none |
| R2-095 | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — rows unchanged by reassignment; the route; accruals end to end | none |
| R2-096 | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — the line VOID with history kept; example 5 end to end | none |
| R2-097 | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — the split arithmetic; the database sums; one pool end to end | none |
| R2-098 | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — the four discount and residual combinations; no line after the window; end to end | none |
| R2-099 | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — the prospective agreement; its separate pool | none |
| R2-100 | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — the tail guard; TerminateSeller's two entries; conversion inside the tail only | none |
| R2-101 | PARTIAL | 2 EXECUTED_LOCAL, 1 SIMULATED — the eligibility clock; the database guard; stage then final completion through the fake | B13 — the stages of a staged purchase through PreparationCompletionSource (CMD039-OK nearest); B08 — the DELIVERED edge of a single-stage purchase (G-JOB, no registry case) |
| R2-102 | EXECUTED_LOCAL | 4 EXECUTED_LOCAL, 0 SIMULATED — the partial hold; the statement; the payout of the undisputed part; the seller's read | none (B12 serves the seller's dispute and statement screens) |
| R2-103 | PARTIAL | 2 EXECUTED_LOCAL, 1 SIMULATED — the destination guard; the refusal and the bound intent; evidence of the new destination refused | B12 — the step-up destination change and the owner's verification in the seller and owner application (G-UX_PRIVATE, no registry case); B15 — the real transfer and its bank evidence (G-INTEGRATION, no registry case) |
| R2-104 | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — the negative position; the offset guard; examples 7 and 25 end to end | none |
| R2-105 | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — the guard arithmetic; the owner's review at the close | none |
| R2-127 | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — the reservation lifetime; supersession and no revival; expiry and uncertain capture in the sweep | none |
| R2-136 | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — the discount rounded once; the quote row | none |
| R2-137 | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — the serialized designation; the late earlier capture; both interleavings end to end | none (B15 repeats the late webhook with a live provider, R2-061) |
| R2-138 | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — the exclusive cutoff; the two endpoint captures notified later | none |
| R2-139 | PARTIAL | 2 EXECUTED_LOCAL, 2 SIMULATED — the ordinal algorithm; the stored calendar version; the labelled fixture; the close dated by it | B15 — the verified current Colombian banking calendar feed (G-INTEGRATION, no registry case) |
| R2-141 | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — rename and consolidation through the adapters; the database keys | none |
| CMD002-OK | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — activation through the route; the acceptance record | none (B19 publishes the reviewed agreement texts, R2-111) |
| CMD002-DENY | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — roles and prerequisites; the database guards | none |
| CMD002-RACE | EXECUTED_LOCAL | 1 EXECUTED_LOCAL, 0 SIMULATED — retry, conflict, two keys, crash | none |
| CMD027-OK | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — the issued quote; max not stacked with the slot; the issuance core | none |
| CMD027-DENY | PARTIAL | 2 EXECUTED_LOCAL, 1 SIMULATED — roles and prerequisites; the database guards; the unset buyer type through the fake | B11 — BuyerTypeReader bound to W6's agency_buyer_types (G-UX_AGENCY, no registry case) |
| CMD027-RACE | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — retry, conflict, supersession, crash; snapshot against designation; the replacement's crash boundaries | none |
| CMD043-OK | PARTIAL | 2 EXECUTED_LOCAL, 0 SIMULATED — the closure record; new work stopped with commission paths kept | B16 — the managed deletion and the CLOSED edge (CMD042-OK) |
| CMD043-DENY | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — roles and prerequisites; the residual guard and no delete | none |
| CMD043-RACE | EXECUTED_LOCAL | 1 EXECUTED_LOCAL, 0 SIMULATED — retry, conflict, closure against a payment order, crash | none |
| CMD045-OK | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — the minimized prospect; the closed view and authorizer | none |
| CMD045-DENY | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — roles and prerequisites; the database guards; the organization key | none |
| CMD045-RACE | EXECUTED_LOCAL | 1 EXECUTED_LOCAL, 0 SIMULATED — retry, conflict, two sellers, crash | none |
| CMD046-OK | EXECUTED_LOCAL | 1 EXECUTED_LOCAL, 0 SIMULATED — the SUBMITTED claim owning nothing | none |
| CMD046-DENY | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — roles and prerequisites; conflict review; the database guards | none |
| CMD046-RACE | EXECUTED_LOCAL | 1 EXECUTED_LOCAL, 0 SIMULATED — retry, conflict, two sellers' claims, crash | none |
| CMD047-OK | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — the frozen allocation; the split | none |
| CMD047-DENY | PARTIAL | 2 EXECUTED_LOCAL, 1 SIMULATED — roles and prerequisites; the database guards; the buyer type through the fake | B11 — BuyerTypeReader bound to W6's agency_buyer_types (G-UX_AGENCY, no registry case) |
| CMD047-RACE | EXECUTED_LOCAL | 1 EXECUTED_LOCAL, 0 SIMULATED — retry, conflict, two acceptances, crash | none |
| CMD048-OK | EXECUTED_LOCAL | 1 EXECUTED_LOCAL, 0 SIMULATED — the assignment with history unchanged | none |
| CMD048-DENY | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — roles and prerequisites; no reset at the database | none |
| CMD048-RACE | EXECUTED_LOCAL | 1 EXECUTED_LOCAL, 0 SIMULATED — retry, conflict, two assignments, crash | none |
| CMD049-OK | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — the activation; least privilege of the seller | none (engaging a real seller is B10's owner action under a reviewed arrangement, R2-110) |
| CMD049-DENY | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — roles and prerequisites; the database guard | none |
| CMD049-RACE | EXECUTED_LOCAL | 1 EXECUTED_LOCAL, 0 SIMULATED — retry, conflict, two activations, crash | none |
| CMD050-OK | EXECUTED_LOCAL | 1 EXECUTED_LOCAL, 0 SIMULATED — the termination and its tail | none |
| CMD050-DENY | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — roles and prerequisites; nothing deletable | none |
| CMD050-RACE | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — retry, conflict, two terminations, crash; termination against acceptance end to end | none |
| CMD051-OK | PARTIAL | 2 EXECUTED_LOCAL, 1 SIMULATED — the cutoff hash; the seller's read; the close dated by the calendar fixture | B15 — the statement and pay dates from the verified banking calendar (G-INTEGRATION, no registry case) |
| CMD051-DENY | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — roles and prerequisites with reasoned holds; the database guard | none |
| CMD051-RACE | EXECUTED_LOCAL | 1 EXECUTED_LOCAL, 0 SIMULATED — retry, conflict, close against an adjustment, crash | none |
| CMD052-OK | EXECUTED_LOCAL | 1 EXECUTED_LOCAL, 0 SIMULATED — one authorized intent, no transfer | none |
| CMD052-DENY | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — roles and prerequisites; the database guards | none |
| CMD052-RACE | EXECUTED_LOCAL | 1 EXECUTED_LOCAL, 0 SIMULATED — retry, conflict, two approvals, crash | none |
| CMD053-OK | PARTIAL | 1 EXECUTED_LOCAL, 1 SIMULATED — the database guard; settled, failed and returned evidence through the fake | B15 — authenticated bank or provider payout evidence (G-INTEGRATION, no registry case; R2-085 nearest) |
| CMD053-DENY | PARTIAL | 1 EXECUTED_LOCAL, 1 SIMULATED — the database guard; mismatched and submitted-only evidence through the fake | B15 — authenticated bank or provider payout evidence (G-INTEGRATION, no registry case; R2-085 nearest) |
| CMD053-RACE | PARTIAL | 1 EXECUTED_LOCAL, 1 SIMULATED — serialized settlement at the adapter; retry, conflict, crash through the fake | B15 — authenticated bank or provider payout evidence (G-INTEGRATION, no registry case; R2-085 nearest) |

## Scenarios

### R2-079 — First commission arithmetic

Expected (registry): commission 9713 cents; do not subtract the PSP fee from its basis.

- EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-money.test.ts` :: "R2-079 (example 1): a first-project pool at 1000 bps on a 97125-cent service collection is 9713 cents rounded half-up once; the 5275-cent processor fee, the collected tax and any excess change nothing in the basis" — observes: the pool of the example's integer inputs; varying the fee, tax and excess inputs leaves it 9713.
- EXECUTED_LOCAL (existing, B09; the kernel B10 reuses) `packages/domain/test/commerce-money-pricing.test.ts` :: "R2-080 arithmetic kernel: 4 % of 123025 is 4921; after a 20000 service refund 4121; the adjustment is -800" — observes: `cumulativeEntitlement(97125n, 1000)` is 9713n.
- EXECUTED_LOCAL (B10-ADAPTERS-LEDGER, 8a91985) `packages/persistence/test/b10-ledger-adapters.test.ts` :: "R2-079 at the ledger: the accrual of a founding first purchase writes, as the commission service, one ACQUISITION pool of basis 97125 and 9713 cents and one ACCRUED_PENDING line at 1000 bps, and a pool whose cents differ from round(basis x rate) is refused KC002" — observes: pool and line rows, KC002 at COMMIT.
- PLANNED EXECUTED_LOCAL (B10-INTEGRATION) `apps/api/test/b10-scenarios.test.ts` :: "R2-079 (example 1): a founding agency's first HubSpot purchase of 50000 units, quoted by CreateQuote at 129500 - 32375 = 97125 and paid through CreatePaymentOrder and CapturePayment, accrues one 9713-cent ACCRUED_PENDING line for its accepted seller — not payable at capture, the 5275-cent fee recorded apart, the founding slot CONSUMED" — observes: quote, capture, settlement fee, pool, line and slot rows after the public commands.

### R2-080 — Repeat and refund arithmetic

Expected (registry): service 123025, original commission 4921, revised commission 4121 and adjustment minus 800 cents.

- EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-money.test.ts` :: "R2-080 (examples 2 and 6): 129500 at a 500-bps repeat discount is 123025; its 400-bps pool is 4921; after a 20000-cent service refund the cumulative entitlement is 4121 and the adjustment -800; refunding the remaining 103025 posts -4121, so the adjustments sum to -4921" — observes: the ledger function's pools and signed adjustments.
- EXECUTED_LOCAL (existing, B09; the kernel B10 reuses) `packages/domain/test/commerce-money-pricing.test.ts` :: "R2-080 arithmetic kernel: 4 % of 123025 is 4921; after a 20000 service refund 4121; the adjustment is -800" — observes: the B09 primitives.
- EXECUTED_LOCAL (B10-ADAPTERS-LEDGER, 8a91985) `packages/persistence/test/b10-ledger-adapters.test.ts` :: "R2-080 at the ledger: refund.completed.v1 with serviceBasisAfterCents 103025 appends one REFUND DECREASE adjustment of 800 with new cumulative 4121 to the 4921 line, a replay of the same event adds nothing, and an adjustment that is not the cumulative difference is refused KC015" — observes: adjustment rows, the line's cumulative, UNIQUE (line, source event), KC015.
- PLANNED EXECUTED_LOCAL (B10-INTEGRATION) `apps/api/test/b10-scenarios.test.ts` :: "R2-080 (examples 2 and 6): the agency's second project, for another end client, is quoted at 123025 and accrues 4921 at 400 bps; RequestRefund, ApproveRefund and ExecuteRefund of 20000 service cents revise the line to 4121 with one -800 adjustment, and the owner's and the seller's statement projections show the same cents" — observes: quote, refund, line, adjustment and GetCommissionStatement.

### R2-086 — Second project starts repeat benefit

Expected (registry): apply 5% to its second eligible project, even for a different end client.

- EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-rules.test.ts` :: "R2-086: the eligibility set of an agency with one qualifying prior project for End Client A counts it for a quote of End Client B's project and selects 500 bps; the quoted project is never in its own set" — observes: the domain mirror of the set rule.
- EXECUTED_LOCAL (B10-SCHEMA-RECURRENCE; b85ee64) `packages/persistence/test/b10-recurrence-migrations.test.ts` :: "R2-086 at the database: kauro.qualifying_projects_at counts a qualifying purchase of another project of the agency confirmed inside [as_of - 8760 h, as_of), whatever its end client, and excludes the quoted project, other agencies' purchases and purchases confirmed at or after as_of" — observes: the function's set at boundary instants.
- PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "R2-086 (example 2): CreateQuote for the agency's second project, serving another end client than its first paid project, issues a quote at 500 bps — 123025 cents in the 50000-unit HubSpot band — whose snapshot names exactly the first project" — observes: the answer, quote and snapshot rows.

### R2-087 — Tenth prior project threshold

Expected (registry): apply 10% to the next eligible quote; count prior projects, not the current capture twice.

- EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-rules.test.ts` :: "R2-087 and R2-088 (example 4): nine prior qualifying projects select 500 bps, ten 1000, twenty-four 1000 and twenty-five 1500; the current project never counts toward its own threshold and a project counts once however many captures it has" — observes: the tier of each count.
- PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "R2-087 (example 4): an agency with ten qualifying prior projects, one of them with an excess second capture, is quoted at 1000 bps for its next project; the snapshot names exactly those ten projects once each and never the quoted project" — observes: the snapshot's set and count, the applied rate.

### R2-088 — Twenty-fifth prior project threshold

Expected (registry): apply 15% to the next eligible quote and preserve the quoted snapshot through later count changes.

- EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-rules.test.ts` :: "R2-087 and R2-088 (example 4): nine prior qualifying projects select 500 bps, ten 1000, twenty-four 1000 and twenty-five 1500; the current project never counts toward its own threshold and a project counts once however many captures it has" — observes: the tier of each count.
- PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "R2-088 (example 4): an agency with twenty-five qualifying prior projects is quoted at 1500 bps, and the issued quote keeps its snapshot, price and terms hash after a twenty-sixth purchase and after a full refund of a counted project" — observes: quote and snapshot rows before and after, byte for byte.

### R2-089 — Fully refunded previous purchase

Expected (registry): exclude it from the active repeat-discount count while preserving historical first-project commission
designation.

- EXECUTED_LOCAL (B10-SCHEMA-RECURRENCE; b85ee64) `packages/persistence/test/b10-recurrence-migrations.test.ts` :: "R2-089 at the database: a qualifying purchase whose service was fully refunded or whose capture was reversed leaves kauro.qualifying_projects_at while its confirmation sequence and first designation stay, and a partly refunded one stays counted" — observes: the set after COMPLETED refunds and a reversal, the unchanged `qualifying_purchases` row.
- PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "R2-089 (example 5): after the agency's only prior purchase is fully refunded, CreateQuote issues at 0 bps with an empty set while the first designation still names that purchase, and a quote issued before the refund keeps its 500 bps" — observes: both quotes' snapshots, `agency_recurrence`.

### R2-090 — Concurrent founding slots

Expected (registry): reserve/consume the promotion slot transactionally; no fourth discounted first agency unless a new explicit
offer is issued.

- EXECUTED_LOCAL (B10-SCHEMA-RECURRENCE; b85ee64) `packages/persistence/test/b10-recurrence-migrations.test.ts` :: "R2-090 at the database: a slot holds at most one live reservation, an agency holds at most one founding reservation per cohort, a reservation must be named by its quote's snapshot at COMMIT, and a consumed slot is never freed, not by a full refund (KC014)" — observes: the unique indexes, the deferred check, KC014.
- PLANNED EXECUTED_LOCAL (B10-ADAPTERS-RECURRENCE) `packages/persistence/test/b10-recurrence-adapters.test.ts` :: "R2-090: two agencies' reservations of the last free slot serialize on its row — the second waits, observed in pg_stat_activity, re-checks and takes no slot — in both orders, and three slots never hold four live reservations" — observes: the lock wait, the slot rows, the reservation count.
- PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "R2-090 (example 17): two eligible agencies' CreateQuote calls racing for the last founding slot, held at the slot update, yield one quote at 2500 bps with its RESERVED reservation and one at the other agency's own tier with foundingOffer NONE_AVAILABLE, whose answer states that actual price" — observes: both answers, the slot and reservation rows, the hold point.

### R2-091 — Promotion is not admission capacity

Expected (registry): continue selling qualified standard/repeat work within operational limits; do not confuse discount cohort with
a total customer cap.

- PLANNED EXECUTED_LOCAL (B10-ADAPTERS-RECURRENCE) `packages/persistence/test/b10-recurrence-adapters.test.ts` :: "R2-091: FoundingOfferReader reports no reservable slot once the three slots are consumed, and the recurrence set and quote issuance core of any agency are unaffected by the cohort" — observes: the reader's answer, the issuance core's output.
- PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "R2-091: once the three founding slots are consumed, a fourth eligible agency's CreateQuote issues a standard quote with foundingOffer NONE_AVAILABLE and CreatePaymentOrder accepts it; the cohort caps the discount, never the sale" — observes: the quote, the order, no reservation.

### R2-092 — Same-band included replacement

Expected (registry): require new source validation/approval and consume the one included allowance; no automatic new fee or old
authority reuse.

- PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "R2-092 (example 18): on a paid project whose entitlement is ACTIVE, CreateQuote for a new approved plan of a corrected revision in the same band issues a replacement quote carrying the paid terms, re-binds the purchase through PurchaseRebinder, revokes the old entitlement SOURCE_REPLACED and spends the one included allowance — no order, no fee, the new approval required" — observes: quote, re-binding, authorization and allowance rows; no payment order.
- PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "R2-092: a replacement whose re-binding the payment service refuses is withdrawn with its reason, and a second same-band replacement after the allowance is spent is REPLACEMENT_ALLOWANCE_SPENT with nothing written" — observes: the withdrawn quote, the answers, the unchanged allowance.
- PLANNED EXECUTED_LOCAL (B10-INTEGRATION) `apps/api/test/b10-scenarios.test.ts` :: "R2-092 (example 18): a paid agency replaces its source once before execution — CreateRevision, seal, a new approval and the replacement quote — and ExecuteProject's authority is the re-bound entitlement, the old one never reusable" — observes: the authorization chain after the public commands.

### R2-093 — Larger replacement scope

Expected (registry): prepare a new price/scope decision and explicit acceptance before another charge; never silently capture the
difference.

- PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "R2-093 (example 18): a replacement revision of 50001 billable units on a project paid at the 50000-unit band is 409 PRECONDITION_FAILED REPLACEMENT_SCOPE_CHANGED with the band comparison 129500 to 199500 cents, writing no quote, re-binding, order or capture" — observes: the answer's comparison, unchanged rows.
- PLANNED EXECUTED_LOCAL (B10-INTEGRATION) `apps/api/test/b10-scenarios.test.ts` :: "R2-093: the larger scope is charged only after the paid purchase is refunded and a new quote is issued and explicitly accepted by CreatePaymentOrder; no capture ever covers the difference silently" — observes: refund, new quote, order and capture rows in order.

### R2-094 — Recurring calendar leap boundary

Expected (registry): window ends exclusively at 2029-02-28T15:00:00Z under the clamp rule; a purchase at the endpoint is outside
automatic residual.

- EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-time.test.ts` :: "R2-094 (example 11): a first confirmation at 2028-02-29T15:00:00Z (10:00 America/Bogota) ends its window exclusively at 2029-02-28T15:00:00Z and one at 2026-09-12T14:00:00Z at 2027-09-12T14:00:00Z — twelve calendar months at the same wall time with the day clamped, never 365 days" — observes: the window function's instants.
- EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-sales-migrations.test.ts` :: "R2-094 at the database: an entitlement's window_ends_at must equal twelve calendar months after window_starts_at at the America/Bogota wall time with the day clamped, and its first capture, window, share and agreement cannot change" — observes: the CHECK at the leap boundary, the immutability trigger.
- PLANNED EXECUTED_LOCAL (B10-COMMISSION-SERVICE) `apps/api/test/b10-commission-service.test.ts` :: "R2-094: after a first confirmation at 2028-02-29T15:00:00Z, a subsequent capture completed at the provider at 2029-02-28T14:59:59Z accrues a 400-bps line and one completed at 2029-02-28T15:00:00Z accrues no acquisition line" — observes: pools and lines of both purchases.

### R2-095 — Assignment transfer

Expected (registry): keep A's contractual residual; B's new service compensation is separately agreed rather than duplicating or
erasing the acquisition pool.

- PLANNED EXECUTED_LOCAL (B10-ADAPTERS-SALES) `packages/persistence/test/b10-sales-adapters.test.ts` :: "R2-095 (example 12): reassigning seller A's acquired agency to seller B appends B's current assignment and service assignment while A's entitlement, allocation, window and accrued lines are unchanged row for row" — observes: row digests before and after.
- PLANNED EXECUTED_LOCAL (B10-COMMANDS-SELLERS) `apps/api/test/cmd048-assign-account.test.ts` :: "R2-095: AssignAccount to seller B with a prepared assistance agreement answers the new operational owner and B's compensation for new work, while seller A's entitlement, allocation share, window and accrued lines stay A's and B gains no row of them" — observes: the answer, both sellers' rows through their own sessions.
- PLANNED EXECUTED_LOCAL (B10-INTEGRATION) `apps/api/test/b10-scenarios.test.ts` :: "R2-095 (example 12): after AssignAccount moves A's acquired agency to seller B, the agency's next purchase inside A's window accrues A's 400-bps line and no line for B; B's assistance agreement signed before a later order accrues B's own 400-bps pool beside A's, never reducing it" — observes: pools and lines of both purchases.

### R2-096 — First purchase fully refunded

Expected (registry): first line becomes zero; the historical first designation and original window do not reset. The later
qualifying project uses the recurring rule.

- EXECUTED_LOCAL (B10-ADAPTERS-LEDGER, 8a91985) `packages/persistence/test/b10-ledger-adapters.test.ts` :: "R2-096 at the ledger: a full service refund of the first purchase moves its 1000-bps line ACCRUED_PENDING to VOID with cumulative 0, while qualifying_purchases, the entitlement's first capture and window and the consumed slot stay" — observes: line, adjustment, purchase, entitlement and slot rows.
- PLANNED EXECUTED_LOCAL (B10-INTEGRATION) `apps/api/test/b10-scenarios.test.ts` :: "R2-096 (example 5): with the agency's first purchase fully refunded, its next purchase inside the window accrues 400 bps, never 1000; the first designation, the window and the CONSUMED founding slot are unchanged and the first line is VOID at zero" — observes: the ledger and recurrence rows after the public commands.

### R2-097 — Split commission pool

Expected (registry): calculate one contractual pool, allocate it deterministically with a remainder rule, and ensure shares sum to
the exact pool.

- EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-money.test.ts` :: "R2-097 (example 8): a 9713-cent pool split 6000/4000 allocates 5828 and 3885, split 5000/5000 between seller_a and seller_b allocates 4857 and 4856, and a one-cent pool at 3333/3333/3334 gives the cent to the third; every allocation sums to the pool after each cumulative refund down to zero" — observes: the allocations over B09's largest-remainder kernel.
- EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-ledger-migrations.test.ts` :: "R2-097 at the database: a pool's cents equal round(basis x rate) and its lines' allocations sum to it at COMMIT (KC002), one pool exists per purchase and source, and an allocation's shares sum to 10000 bps (KC003)" — observes: KC002 and KC003 at COMMIT, the unique index.
- PLANNED EXECUTED_LOCAL (B10-INTEGRATION) `apps/api/test/b10-scenarios.test.ts` :: "R2-097: AcceptAttribution freezing a 6000/4000 split of two sellers' claims makes the agency's first purchase accrue one 9713-cent pool with lines of 5828 and 3885 cents, never two 10% pools" — observes: one pool, two lines.

### R2-098 — Organic purchase after twelve months

Expected (registry): no automatic acquisition residual; earned prior lines remain payable.

- EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-rules.test.ts` :: "R2-098 (example 3): the buyer's recurrence discount and the seller's residual are decided apart — a discount with a residual, a discount without one after the window, a residual without a discount and neither all occur" — observes: both decisions for the four fact sets.
- PLANNED EXECUTED_LOCAL (B10-COMMISSION-SERVICE) `apps/api/test/b10-commission-service.test.ts` :: "R2-098 (example 3): a purchase completed at the provider at or after the window end accrues no acquisition line, and no assistance line without a prior agreement, while the seller's earned lines of the window stay on their path to payment" — observes: no new pool, the earlier lines' states.
- PLANNED EXECUTED_LOCAL (B10-INTEGRATION) `apps/api/test/b10-scenarios.test.ts` :: "R2-098 (example 3): after the window the agency's next project is still quoted at its 500-bps recurrence discount, its capture accrues nothing for the seller, and the seller's earlier ELIGIBLE line is paid on the next statement" — observes: quote, ledger, statement and intent rows.

### R2-099 — New work after residual expiry

Expected (registry): create a prospective project-assistance agreement before requiring work; do not condition old rights on unpaid
future activity.

- PLANNED EXECUTED_LOCAL (B10-ADAPTERS-SALES) `packages/persistence/test/b10-sales-adapters.test.ts` :: "R2-099: an assistance agreement records its seller, agency, project or next purchase, 400 bps and signing instant before any work, and an agreement signed after a purchase's order was created applies to no pool of that purchase" — observes: the agreement row, the applicability query.
- PLANNED EXECUTED_LOCAL (B10-COMMISSION-SERVICE) `apps/api/test/b10-commission-service.test.ts` :: "R2-099 (example 3): a post-window purchase whose order follows a signed assistance agreement accrues one ASSISTANCE pool at 400 bps for that seller only, separate from any acquisition pool, and the seller's old lines never wait on the new work" — observes: pools by source, the old lines' states.

### R2-100 — Termination tail scope

Expected (registry): only qualifying enumerated opportunities receive the signed ninety-day tail; the list creates no blanket claim.

- EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-sales-migrations.test.ts` :: "R2-100 at the database: a tail entry exists only for an ACCEPTED unexpired claim of the terminated seller whose agency has no qualifying purchase (KC011), and ends 2160 hours after the termination's effective instant" — observes: KC011, the end instant CHECK.
- PLANNED EXECUTED_LOCAL (B10-COMMANDS-SELLERS) `apps/api/test/cmd050-terminate-seller.test.ts` :: "R2-100 (example 13): TerminateSeller with a manifest of two enumerated active opportunities records exactly two tail entries ending 2160 h after the effective instant, and the thousand prospects the seller registered from a scraped list gain no tail, claim or entitlement" — observes: tail entries, the prospects' rows.
- PLANNED EXECUTED_LOCAL (B10-INTEGRATION) `apps/api/test/b10-scenarios.test.ts` :: "R2-100: an enumerated opportunity's first purchase inside the tail converts its claim and creates the departed seller's entitlement; a first purchase after the tail's end or of an unlisted agency creates none" — observes: claims, entitlements and lines.

### R2-101 — Final staged completion eligibility

Expected (registry): accrual may exist, but the thirty-day payout-eligibility clock does not start from the first stage by default.

- EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-time.test.ts` :: "R2-101: eligibility is due 720 hours after a FINAL completion; a STAGE completion starts no clock, and funds not AVAILABLE or a covering hold keep a due line from ELIGIBLE" — observes: the eligibility decision for each fact set.
- EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-ledger-migrations.test.ts` :: "R2-101 at the database: a line becomes ELIGIBLE only with a FINAL completion of its purchase at least 720 hours old and its capture's funds AVAILABLE (KC007)" — observes: KC007 for a STAGE-only, a recent FINAL and a HELD-funds line.
- PLANNED SIMULATED (B10-COMMISSION-SERVICE) `apps/api/test/b10-commission-service.test.ts` :: "R2-101 (example 15): a parent-stage STAGE completion reported by the preparation-completion fake leaves the line ACCRUED_PENDING, and the FINAL completion 720 hours later with funds available makes it ELIGIBLE in the ELIGIBILITY sweep" — observes: completion rows, the line's states, the fake's call log.

### R2-102 — Partial statement dispute

Expected (registry): hold only the justified disputed amount, disclose reasons/review date and pay undisputed amounts on the agreed
cycle.

- EXECUTED_LOCAL (B10-ADAPTERS-LEDGER, 8a91985) `packages/persistence/test/b10-ledger-adapters.test.ts` :: "R2-102: a 1000-cent hold on the disputed part of one line leaves the line on its path, and the statement composition withholds exactly those cents with reason and review date while 50000 cents of unrelated eligible lines stay payable" — observes: hold rows, the composed items.
- PLANNED EXECUTED_LOCAL (B10-STATEMENTS-PAYOUTS) `apps/api/test/cmd051-close-commission-period.test.ts` :: "R2-102 (examples 21 and 25): CloseCommissionPeriod issues a statement in which the disputed 1000 cents are a held item with its reason and review date, the undisputed 50000 cents are payable, and accrued pending, eligible, held, paid and negative totals are separate" — observes: statement and item rows, the view's totals.
- PLANNED EXECUTED_LOCAL (B10-STATEMENTS-PAYOUTS) `apps/api/test/cmd052-approve-commission-payout.test.ts` :: "R2-102: ApproveCommissionPayout authorizes exactly the undisputed payable of that statement; the held cents are in no intent" — observes: the intent's amount.
- PLANNED EXECUTED_LOCAL (B10-STATEMENTS-PAYOUTS) `apps/api/test/commission-statement-reads.test.ts` :: "GetCommissionStatement answers a seller its own statement and the owner any — per line the agency and project reference, first or repeat, basis, rate, share, cumulative, previously paid, adjustment, hold reason and review date — and never another seller's rows, a destination digest, contact details or customer CRM values" — observes: the view against its closed schema, 404 for another seller.

### R2-103 — Changed payout destination

Expected (registry): require verified destination-change assurance; no transfer based solely on an unauthenticated email.

- EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-sales-migrations.test.ts` :: "R2-103 at the database: a payout destination becomes VERIFIED only with the seller's own step-up proof at the change and an owner verification at least 172800 seconds later; a change without that proof stays PENDING_VERIFICATION" — observes: the guard at 172799 and 172800 seconds.
- PLANNED EXECUTED_LOCAL (B10-STATEMENTS-PAYOUTS) `apps/api/test/cmd052-approve-commission-payout.test.ts` :: "R2-103 (example 22): a seller's bank change just before payout leaves ApproveCommissionPayout 409 PAYEE_UNVERIFIED for the new destination, and an intent authorized earlier keeps its original destination version and digest while the change is pending" — observes: the answer, the intent's binding.
- PLANNED SIMULATED (B10-STATEMENTS-PAYOUTS) `apps/api/test/cmd053-reconcile-commission-payout.test.ts` :: "R2-103 (example 22): evidence from the payout-evidence fake naming the new destination for an intent bound to the old one is PAYOUT_EVIDENCE_MISMATCH and changes nothing; only evidence for the bound destination settles it" — observes: intent, statement and line states, the fake's log.

### R2-104 — Negative balance after paid commission

Expected (registry): post a visible adjustment and apply only the signed lawful offset/recovery policy; do not debit the person's
bank without authority.

- EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-money.test.ts` :: "R2-104 (example 7): a paid 4921-cent line revised to 4121 shows accrual 4921, payout 4921, adjustment -800 and balance -800; a later eligible amount is offset only under SIGNED_FUTURE_OFFSET terms, otherwise the balance is an owner REPAYMENT_REVIEW, WRITE_OFF or DISPUTE item" — observes: the statement position function.
- EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-ledger-migrations.test.ts` :: "R2-104 at the database: an offset against a later line is refused without SIGNED_FUTURE_OFFSET terms (KC017), a PAID line moves to ADJUSTED with an appended adjustment, and its paid cents and payout rows never change" — observes: KC017, the line history, no UPDATE grant.
- PLANNED EXECUTED_LOCAL (B10-INTEGRATION) `apps/api/test/b10-scenarios.test.ts` :: "R2-104 (examples 7 and 25): a 20000-cent service refund after the seller was paid 4921 posts -800, the line PAID to ADJUSTED, and the next statement shows the original accrual, the payout, the adjustment and the -800 balance with its project and reason; no port can debit the seller" — observes: ledger rows, the statement view, the ports' surface.

### R2-105 — Retainer economics

Expected (registry): total 2500/15000 is 16.67%, exceeding a 15% planning guard; review economics without claiming the guard is
employment law.

- EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-money.test.ts` :: "R2-105 (example 23): a 100000-cent retainer plus 150000 cents of commission against 1500000 cents of attributable net service is 16.67%, EXCEEDS_PLANNING_GUARD above 1500 bps by exact integer comparison, labelled a business planning guard and never a legal ceiling" — observes: the guard result and label.
- PLANNED EXECUTED_LOCAL (B10-STATEMENTS-PAYOUTS) `apps/api/test/cmd051-close-commission-period.test.ts` :: "R2-105: the period close records the owner's compensation-guard review per seller — retainer, commission accrued, attributable net service, 16.67% EXCEEDS_PLANNING_GUARD — and still issues the statement; the guard refuses nothing" — observes: the review row, the ISSUED statement.

### R2-127 — Founding quote reservation

Expected (registry): reserve that one slot through the original fourteen-day quote expiry; previews reserve nothing, quote IDs do
not renew it, and capture uncertainty prevents unsafe release.

- PLANNED EXECUTED_LOCAL (B10-ADAPTERS-RECURRENCE) `packages/persistence/test/b10-recurrence-adapters.test.ts` :: "R2-127: a reservation ends at its quote's 336-hour expiry, a superseding or replacement quote never inherits or extends it, FoundingOfferReader's preview reserves nothing, and a quote past its price expiry with a payment in flight moves its reservation to RECONCILIATION_HOLD" — observes: reservation rows and states.
- PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "R2-127 (examples 16 and 17): a founding quote reserves one slot until its original 336-hour expiry; a superseding CreateQuote of the same project releases it and issues at the agency's own tier, and no later quote of that agency revives a founding reservation" — observes: both quotes, the reservation's end and state, NOT_ELIGIBLE.
- PLANNED EXECUTED_LOCAL (B10-COMMISSION-SERVICE) `apps/api/test/b10-commission-service.test.ts` :: "R2-127: the QUOTE_EXPIRY sweep expires a founding quote with nothing in flight and releases its slot; with an uncertain capture it holds the reservation in RECONCILIATION_HOLD until the capture consumes the slot or a proved no-capture releases it" — observes: quote, reservation and slot states in both paths.

### R2-136 — Fractional-cent discount order

Expected (registry): round the 250.5-cent discount to 251, then subtract for 751 net cents. Rounding the complementary 75 percent to
752 is wrong. This vector does not create a new advertised price band.

- EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-money.test.ts` :: "R2-136 (example 4): a synthetic 1002-cent basis at a 2500-bps discount rounds the 250.5-cent discount once to 251 and nets 751, never 752 by rounding the complementary 7500 bps, and is no price band of the schedule" — observes: the discount and net over B09's kernel; the schedule's bands.
- PLANNED EXECUTED_LOCAL (B10-ADAPTERS-RECURRENCE) `packages/persistence/test/b10-recurrence-adapters.test.ts` :: "R2-136 at the issuance core: a quote priced from a 1002-cent base at 2500 bps stores discount 251 and service 751, and the database refuses 750 or 752 as the rounded arithmetic" — observes: the quote row, B09's arithmetic CHECK.

### R2-137 — Late earlier capture keeps first designation

Expected (registry): keep P as historical first and Q subsequent; preserve actual timestamps and use the verified recurring cutoff
without granting a second 10 percent pool.

- EXECUTED_LOCAL (B10-SCHEMA-RECURRENCE; b85ee64) `packages/persistence/test/b10-recurrence-migrations.test.ts` :: "R2-137 at the database: two first captures of one agency confirmed at once serialize on its recurrence lock in both orders — one sequence 1, the other sequence 2 with its own provider completion instant — and neither sequence nor designation can be rewritten (KC001)" — observes: the lock wait, sequences, KC001.
- PLANNED EXECUTED_LOCAL (B10-COMMISSION-SERVICE) `apps/api/test/b10-commission-service.test.ts` :: "R2-137 (examples 9 and 10): P confirmed first keeps sequence 1 and its 1000-bps pool; Q, whose authenticated provider completion is earlier but observed later, is sequence 2 at 400 bps inside the window — never a second 1000-bps pool — and a provider completion after its own confirmation is held PROVIDER_TIME_UNVERIFIED" — observes: pools, lines, the hold reason.
- PLANNED EXECUTED_LOCAL (B10-INTEGRATION) `apps/api/test/b10-scenarios.test.ts` :: "R2-137 (example 9): two projects' capture reconciliations of one agency held at the designation trigger in both interleavings end with one first project, one 1000-bps and one 400-bps pool and the same final statement projection" — observes: final rows and GetCommissionStatement in both runs.

### R2-138 — Residual exclusive cutoff and delayed notice

Expected (registry): the first can qualify at 4 percent; the endpoint capture does not. Quote or notification time cannot replace
verified provider completion.

- EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-time.test.ts` :: "R2-138 (example 11): the subsequent rate is 400 bps iff the verified provider completion precedes the exclusive window end — one second before qualifies, exactly at the end does not — whatever the quote, confirmation or notification instant" — observes: the rate decision for each instant.
- PLANNED EXECUTED_LOCAL (B10-COMMISSION-SERVICE) `apps/api/test/b10-commission-service.test.ts` :: "R2-138: two subsequent captures completed at the provider one second before and exactly at the local twelve-month endpoint, both notified a day later, accrue 400 bps for the first and no acquisition line for the second" — observes: pools and lines; the notification instants recorded apart.

### R2-139 — Controlled banking calendar

Expected (registry): compute 2026-10-07 as fifth and 2026-10-15 as tenth business day. Production must bind a verified current
banking calendar; the fixture is not a live holiday authority.

- EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-time.test.ts` :: "R2-139 (example 21): with weekends and 2026-10-12 excluded, the fifth banking day after September 2026 is 2026-10-07 and the tenth 2026-10-15; the same calendar without that holiday gives 2026-10-07 and 2026-10-14" — observes: the ordinal function over explicit calendar input.
- EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-ledger-migrations.test.ts` :: "R2-139 at the database: a period's close and pay dates are stored with the calendar version they came from, and a statement closed on a TEST_FIXTURE calendar is labelled SIMULATED" — observes: the period and statement columns.
- SIMULATED (B10-PORTS-FAKES; e95b97b) `packages/application/test/commercial-fakes.test.ts` :: "the banking-calendar fake serves the controlled fixture with 2026-10-12 nonbanking, labelled TEST_FIXTURE and evidence class SIMULATED, never VERIFIED_FEED, and records each call" — observes: the fake's answers and labels.
- PLANNED SIMULATED (B10-STATEMENTS-PAYOUTS) `apps/api/test/cmd051-close-commission-period.test.ts` :: "OK: the commission service closes a due September 2026 period on the test calendar — 200 with one immutable ISSUED statement per seller itemizing each line, dated 2026-10-07 with pay date 2026-10-15 and labelled SIMULATED, its ELIGIBLE lines PAYABLE and the period CLOSED" — observes: statements, items, lines, the period.

### R2-141 — Agency rename versus legal consolidation

Expected (registry): a rename preserves history, rights and tenant identity. Consolidation requires an explicit reviewed relationship
decision and cannot merge datasets or erase attribution.

- PLANNED EXECUTED_LOCAL (B10-AGENCY-LIFECYCLE) `packages/persistence/test/b10-agency-adapters.test.ts` :: "R2-141 (example 24): a display-name and owner e-mail change leaves the agency's id, first designation, consumed slot, recurrence set, attribution and ledger rows unchanged, and a recorded consolidation decision of two agencies merges no dataset, membership, designation or attribution and changes neither's quote eligibility" — observes: row digests before and after, both agencies' sets.
- EXECUTED_LOCAL (B10-SCHEMA-RECURRENCE; b85ee64) `packages/persistence/test/b10-recurrence-migrations.test.ts` :: "R2-141 at the database: agency_relationship_decisions are append-only reviewed records, and every recurrence, founding, attribution and ledger row stays keyed by its own agency" — observes: kauro.forbid_change, the keys.

## Command triads

- **CMD002-OK** (ActivateAgency; record versioned acceptance and activate only eligible capabilities)
  - PLANNED EXECUTED_LOCAL (B10-AGENCY-LIFECYCLE) `apps/api/test/cmd002-activate-agency.test.ts` :: "OK: the agency's OWNER activates its DRAFT agency with the published terms and privacy versions and its current reviewed billing profile — 200 with the agency ACTIVE at the next version, one append-only acceptance naming both versions, their document hashes and the membership, agency.activated.v1, and no capability written" — observes: the answer, agency, acceptance, event rows; capabilities unchanged.
  - PLANNED EXECUTED_LOCAL (B10-AGENCY-LIFECYCLE) `packages/persistence/test/b10-agency-adapters.test.ts` :: "CMD002 through the adapters: the published agreement versions are read after their shared locks, the acceptance is appended once, and B06's agencies_authority admits the activation only for the agency's current OWNER" — observes: the lock order, the acceptance row, 42501 for another member.
- **CMD002-DENY** (missing agreements or a mismatched billing identity leave the agency draft; no implicit signature)
  - PLANNED EXECUTED_LOCAL (B10-AGENCY-LIFECYCLE) `apps/api/test/cmd002-activate-agency.test.ts` :: "DENY: another agency's OWNER is a foreign tenant (404) and a BILLING member a wrong role (403 ROLE_INSUFFICIENT); then one missing prerequisite at a time — an unpublished terms version AGREEMENT_VERSION_NOT_PUBLISHED, another agency's billing profile BILLING_PROFILE_MISMATCH, an unreviewed profile FISCAL_TREATMENT_UNREVIEWED, an ACTIVE agency AGENCY_NOT_DRAFT — each leaves the agency as it was with no acceptance" — observes: each answer, unchanged rows, the DENY facts.
  - EXECUTED_LOCAL (B10-SCHEMA-RECURRENCE; b85ee64) `packages/persistence/test/b10-recurrence-migrations.test.ts` :: "CMD002 at the database: an acceptance names published agreement versions and the accepting OWNER membership of its agency, and acceptances cannot be updated or deleted" — observes: 23503, the membership check, kauro.forbid_change.
- **CMD002-RACE** (one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority)
  - PLANNED EXECUTED_LOCAL (B10-AGENCY-LIFECYCLE) `apps/api/test/cmd002-activate-agency.test.ts` :: "RACE: an identical retry replays the 200 without a second acceptance, the same key with another billingProfileRef is 409 IDEMPOTENCY_CONFLICT, two keys racing on one expectedVersion yield one activation and one 409 STALE_VERSION with the wait observed, and a crash before COMMIT leaves the agency DRAFT with no acceptance" — observes: the journal, the lock wait, one acceptance.
- **CMD027-OK** (CreateQuote; compute server price, maximum eligible discount, taxes, expiry and immutable terms)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "OK: an AGENCY_BILLING member's CreateQuote on the approved plan of a sealed, available revision answers 201 with the quote ISSUED — base band, applied discount rounded once, service, reviewed tax, total, expiry at issuance + 336 h, source availability the earlier of that and B07's deadline, terms hash KAURO_QUOTE_TERMS_V1 — its snapshot at the issuance instant, quote.drafted.v1 and quote.issued.v1" — observes: the answer against CreateQuoteView, quote, snapshot, issuance and event rows.
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "OK (not stacked): a founding-eligible agency with two qualifying prior projects is quoted at max(2500, 500) = 2500 bps with its slot RESERVED, never 3000, and the eligibility view names the count, the tier, the founding offer and the lookback start" — observes: the eligibility view, the snapshot's applied rate.
  - PLANNED EXECUTED_LOCAL (B10-ADAPTERS-RECURRENCE) `packages/persistence/test/b10-recurrence-adapters.test.ts` :: "CMD027 issuance core: the snapshot's set is inserted from kauro.qualifying_projects_at under the recurrence lock's shared half in the same statement as its count and tier, the founding slot is taken in ascending slot order, and quote_issuances names the journal entry, the quote and the reservation" — observes: the rows of one transaction, the lock modes in pg_locks.
- **CMD027-DENY** (zero-unit or unqualified work cannot be charged as a minimum-price project; incomplete tax facts block issuance)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "DENY: another agency's project is a foreign tenant (404) and a VIEWER or APPROVER a wrong role (403); then one missing prerequisite at a time — zero billable units NO_BILLABLE_UNITS, a band beyond the launch envelope ENVELOPE_NOT_OFFERED, an unapproved plan, an expired source SOURCE_EXPIRED, an unreviewed fiscal treatment FISCAL_TREATMENT_UNREVIEWED, another billing profile BILLING_PROFILE_MISMATCH, a DRAFT or CLOSING agency AGENCY_NOT_ACTIVE — each writes no quote, snapshot or reservation" — observes: each answer, empty quote, snapshot and reservation tables, the DENY facts.
  - EXECUTED_LOCAL (B10-SCHEMA-RECURRENCE; b85ee64) `packages/persistence/test/b10-recurrence-migrations.test.ts` :: "CMD027 at the database: kauro_app cannot write qualifying_purchases, agency_recurrence or a slot's consumption, a reservation's quote must be an ISSUED quote of its agency, and a replacement quote needs its paid terms" — observes: 42501, 23503 and B09's quotes_replacement_terms_fk.
  - PLANNED SIMULATED (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "DENY (buyer type): with the buyer-type fake answering unset, CreateQuote is 409 PRECONDITION_FAILED BUYER_TYPE_UNSET and writes nothing; answering AGENCY or IN_HOUSE, the same request issues the same price" — observes: the answers, the fake's call log, equal quotes.
- **CMD027-RACE** (one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "RACE: an identical retry replays the 201 with the same quote, the same key with another planId is 409 IDEMPOTENCY_CONFLICT, two keys for one project serialize on its live quote with the wait observed and supersede exactly once, and a crash before COMMIT leaves no quote, snapshot or reservation" — observes: the journal, the lock wait, one live quote.
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "RACE (snapshot against designation): a CreateQuote held after its shared recurrence lock and a first-purchase designation of the same agency serialize in both orders — the quote's set includes the new purchase with its tier or excludes it wholly, never half" — observes: the hold point, the lock wait, the snapshot.
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE) `apps/api/test/cmd027-create-quote.test.ts` :: "RACE (replacement): a crash before the replacement's intent commits leaves nothing, a crash between the intent commit and the payment service's re-binding resumes from the journal entry to one re-binding, and a crash after the re-binding completes the same answer — the purchase is never re-bound twice" — observes: quote_issuances, the re-binding rows, the journal.
- **CMD043-OK** (CloseAgency; stop new work, settle/reconcile existing obligations and schedule managed-scope deletion/closure)
  - PLANNED EXECUTED_LOCAL (B10-AGENCY-LIFECYCLE) `apps/api/test/cmd043-close-agency.test.ts` :: "OK: the OWNER with a fresh step-up requests closure of an ACTIVE agency with nothing in flight — 200 with the agency CLOSING, one closure record inventorying withdrawn open quotes, live authorizations, open refunds, non-terminal tax documents, the agency's OPEN reconciliation cases with kind and amount (an UNKNOWN_REFUND among them), active work and the managed-deletion schedule, and agency.closing.v1" — observes: the answer, agency, closure and event rows.
  - PLANNED EXECUTED_LOCAL (B10-AGENCY-LIFECYCLE) `apps/api/test/cmd043-close-agency.test.ts` :: "OK (new work stops): after CloseAgency the agency's ISSUED quote is WITHDRAWN with its founding reservation RELEASED, CreatePaymentOrder and CreateProject of the agency are refused AGENCY_NOT_ACTIVE, and its sellers' commission lines are unchanged with their edges to payment intact" — observes: the refusals, the quote and reservation states, the lines' rows.
- **CMD043-DENY** (closure cannot erase payable seller rights, fiscal obligations or customer refund rights)
  - PLANNED EXECUTED_LOCAL (B10-AGENCY-LIFECYCLE) `apps/api/test/cmd043-close-agency.test.ts` :: "DENY: another agency's closure is a foreign tenant (404) and a BILLING member a wrong role (403); then one missing prerequisite at a time — no fresh step-up ASSURANCE_REQUIRED, a stale version STALE_VERSION, a payment order in flight or an uncertain refund CLOSURE_OBLIGATIONS_UNRECONCILED — each leaves the agency and its obligations unchanged" — observes: each answer, unchanged rows.
  - EXECUTED_LOCAL (B10-SCHEMA-RECURRENCE; b85ee64) `packages/persistence/test/b10-recurrence-migrations.test.ts` :: "CMD043 at the database: CLOSING to CLOSED is refused while any payment order, refund, live authorization or tax document of the agency is non-terminal or any reconciliation case of the agency is OPEN, an UNKNOWN_REFUND keyed by its provider_ref included (KC006), and no runtime role can delete a commission, fiscal or ledger row of a closing agency" — observes: KC006 for each residual, the guard open once the case is RESOLVED, 42501 on DELETE.
- **CMD043-RACE** (one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority)
  - PLANNED EXECUTED_LOCAL (B10-AGENCY-LIFECYCLE) `apps/api/test/cmd043-close-agency.test.ts` :: "RACE: an identical retry replays the 200, the same key with another assuranceProofRef is 409 IDEMPOTENCY_CONFLICT, CloseAgency racing CreatePaymentOrder of the agency's issued quote serializes on the agency in both orders — the order commits first and the closure is 409 CLOSURE_OBLIGATIONS_UNRECONCILED, or the closure commits first and the order is refused AGENCY_NOT_ACTIVE — and a crash before COMMIT leaves the agency ACTIVE" — observes: the lock wait, both outcomes, the journal.
- **CMD045-OK** (RegisterProspect; create a minimized prospect without granting customer data access or automatic attribution)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-PROSPECTS) `apps/api/test/cmd045-register-prospect.test.ts` :: "OK: an ACTIVE seller registers a prospect from its own AGENCY-segment source evidence and business contact — 201 with one RESEARCHED prospect owned by the seller, its organization key, no claim, no attribution, and a view without contact details or customer data; the owner may register one too" — observes: the answer, prospect rows, empty claims.
  - EXECUTED_LOCAL (B10-PORTS-FAKES; e95b97b) `packages/application/test/commercial-contracts.test.ts` :: "the commercial contracts: every request schema carries exactly the registry fields of its command, every view is closed and withholds contact details, destination digests and other sellers' rows, and CommercialAuthorizer admits a seller only while its row is ACTIVE and the owner only with an ACTIVE grant" — observes: the schemas against commands.json, the authorizer over a scripted principal reader.
- **CMD045-DENY** (a suppressed identity cannot be reactivated through spelling or duplicate-list import)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-PROSPECTS) `apps/api/test/cmd045-register-prospect.test.ts` :: "DENY: an agency member's tenant session is a foreign scope and a CANDIDATE or TERMINATED seller a wrong role (403); then one missing prerequisite at a time — source evidence of another seller or segment SOURCE_EVIDENCE_INVALID, an organization spelled differently but suppressed by organization or contact key PROSPECT_SUPPRESSED, a live duplicate PROSPECT_EXISTS — nothing is written" — observes: each answer, unchanged prospects.
  - EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-sales-migrations.test.ts` :: "CMD045 at the database: source evidence admits only the AGENCY segment, one live prospect exists per normalized organization key, and a prospect whose organization or contact key is suppressed is refused KC016" — observes: the CHECK, the unique index, KC016.
  - EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-rules.test.ts` :: "CMD045: the organization key KAURO_PROSPECT_ORGANIZATION_V1 normalizes case, IDNA, a leading www. and a trailing dot, so every spelling of one business domain has one key and a re-imported list maps to the same keys" — observes: the key of each spelling.
- **CMD045-RACE** (one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-PROSPECTS) `apps/api/test/cmd045-register-prospect.test.ts` :: "RACE: an identical retry replays the 201, the same key with another organizationLabel is 409 IDEMPOTENCY_CONFLICT, two sellers registering one organization at once yield one prospect and one 409 PROSPECT_EXISTS with the wait observed, and a crash before COMMIT leaves no prospect" — observes: the journal, the lock wait, one prospect.
- **CMD046-OK** (ClaimProspect; create a reviewable attribution claim; submission alone does not own the agency)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-PROSPECTS) `apps/api/test/cmd046-claim-prospect.test.ts` :: "OK: an ACTIVE seller claims a prospect it owns with substantive evidence under its active agreement version — 201 with one SUBMITTED claim whose review deadline is 2160 h later, and no allocation, entitlement or agency ownership" — observes: the answer, claim rows, empty allocations.
- **CMD046-DENY** (existing accepted claims or customer history route to conflict review)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-PROSPECTS) `apps/api/test/cmd046-claim-prospect.test.ts` :: "DENY: another seller's prospect is a foreign scope (404) and the owner or an agency member a wrong role (403); then one missing prerequisite at a time — a stale agreement version AGREEMENT_VERSION_MISMATCH, a list import or tracking link alone CLAIM_EVIDENCE_INSUFFICIENT, the seller's second live claim CLAIM_EXISTS — nothing is written" — observes: each answer, unchanged claims.
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-PROSPECTS) `apps/api/test/cmd046-claim-prospect.test.ts` :: "DENY (conflict review): a claim on a prospect with another seller's accepted or live claim, or whose agency already has an order or purchase, is written DISPUTED in the same transaction and owns nothing" — observes: the claim state, no allocation.
  - EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-sales-migrations.test.ts` :: "CMD046 at the database: a claim needs its seller ACTIVE with that agreement version, one live claim exists per seller and prospect, and a claim's evidence and deadlines cannot change" — observes: the guards, the unique index.
- **CMD046-RACE** (one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-PROSPECTS) `apps/api/test/cmd046-claim-prospect.test.ts` :: "RACE: an identical retry replays the 201, the same key with another evidenceHash is 409 IDEMPOTENCY_CONFLICT, two sellers' claims of one prospect serialize on its claims lock with the wait observed — the second is DISPUTED — and a crash before COMMIT leaves no claim" — observes: the journal, the lock wait, the states.
- **CMD047-OK** (AcceptAttribution; freeze accepted acquisition attribution and claim window; record any agreed split totaling 100%)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-PROSPECTS) `apps/api/test/cmd047-accept-attribution.test.ts` :: "OK: the owner accepts a SUBMITTED claim with a prepared allocation naming the agency, the ruling reason and one 10000-bps share — 200 with the claim ACCEPTED, expiring 2160 h after acceptance, the allocation frozen and a competing claim REJECTED" — observes: the answer, claim and allocation rows.
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-PROSPECTS) `apps/api/test/cmd047-accept-attribution.test.ts` :: "OK (split): an allocation of two sellers' claims at 6000/4000 under their signed agreements is frozen once and both claims are ACCEPTED" — observes: one allocation, two shares.
- **CMD047-DENY** (assignment edits or two full-rate sellers cannot duplicate the commission pool)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-PROSPECTS) `apps/api/test/cmd047-accept-attribution.test.ts` :: "DENY: an agency member's tenant session is a foreign scope and a seller a wrong role (403); then one missing prerequisite at a time — shares summing to 9999 SHARES_NOT_WHOLE, a claim submitted after the agency's first payment order CLAIM_AFTER_FIRST_ORDER, a second full-rate seller's allocation for the agency ATTRIBUTION_EXISTS, a stale version — nothing is written and no pool can double" — observes: each answer, one allocation per agency.
  - PLANNED SIMULATED (B10-COMMANDS-PROSPECTS) `apps/api/test/cmd047-accept-attribution.test.ts` :: "DENY (buyer type, D58): with the buyer-type fake answering unset or IN_HOUSE, AcceptAttribution is 409 PRECONDITION_FAILED BUYER_TYPE_UNSET or IN_HOUSE_NOT_ATTRIBUTABLE and writes nothing; answering AGENCY, the same request freezes the allocation" — observes: the answers, the fake's call log, the allocation rows.
  - EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-sales-migrations.test.ts` :: "CMD047 at the database: one frozen allocation exists per agency, its shares sum to 10000 bps at COMMIT (KC003) with each beneficiary's pool terms equal to its signed agreement, and no assignment row can reference or alter it" — observes: KC003, the unique index, the FK shape.
- **CMD047-RACE** (one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-PROSPECTS) `apps/api/test/cmd047-accept-attribution.test.ts` :: "RACE: an identical retry replays the 200, the same key with another shareAllocationRef is 409 IDEMPOTENCY_CONFLICT, two acceptances for one agency racing yield one allocation and one ATTRIBUTION_EXISTS with the wait observed, and a crash before COMMIT leaves the claim SUBMITTED" — observes: the journal, the lock wait, one allocation.
- **CMD048-OK** (AssignAccount; change operational responsibility while preserving historical attribution and earned rights)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-SELLERS) `apps/api/test/cmd048-assign-account.test.ts` :: "OK: the owner assigns an agency to an ACTIVE seller with a prepared service assignment — 200 with one current account assignment and the previous one ended, the agency's allocation, entitlements, window and first designation unchanged row for row" — observes: the answer, assignment rows, row digests.
- **CMD048-DENY** (no silent reset of the twelve-month window or first-project designation)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-SELLERS) `apps/api/test/cmd048-assign-account.test.ts` :: "DENY: an agency member's tenant session is a foreign scope and a seller a wrong role (403); then one missing prerequisite at a time — a CANDIDATE or TERMINATED seller SELLER_NOT_ACTIVE, no prepared service assignment SERVICE_ASSIGNMENT_UNPREPARED, a stale version — and no request shape resets the window or the first designation" — observes: each answer, unchanged rows.
  - EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-sales-migrations.test.ts` :: "CMD048 at the database: account assignments are append-only with one current per agency, and no runtime role can update an entitlement's first capture, window or share or the agency's first designation" — observes: the unique index, kauro.forbid_column_change, KC001.
- **CMD048-RACE** (one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-SELLERS) `apps/api/test/cmd048-assign-account.test.ts` :: "RACE: an identical retry replays the 200, the same key with another sellerId is 409 IDEMPOTENCY_CONFLICT, two assignments on one version yield one and one 409 STALE_VERSION with the wait observed, and a crash before COMMIT leaves the previous assignment current" — observes: the journal, the lock wait, one current assignment.
- **CMD049-OK** (ActivateSeller; activate least-privilege seller capabilities and the agreed compensation version)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-SELLERS) `apps/api/test/cmd049-activate-seller.test.ts` :: "OK: the owner with a fresh step-up activates a CANDIDATE seller whose agreement is signed and whose legal review, assessment, confidentiality acceptance, VERIFIED destination, tax documentation and MFA identity are recorded — 200 with the seller ACTIVE on that agreement's compensation version, able to register prospects and read only its own statements" — observes: the answer, the seller row, the seller's reads and refusals.
  - EXECUTED_LOCAL (B10-PORTS-FAKES; e95b97b) `packages/application/test/commercial-contracts.test.ts` :: "the commercial contracts: every request schema carries exactly the registry fields of its command, every view is closed and withholds contact details, destination digests and other sellers' rows, and CommercialAuthorizer admits a seller only while its row is ACTIVE and the owner only with an ACTIVE grant" — observes: the schemas against commands.json, the authorizer over a scripted principal reader.
- **CMD049-DENY** (a contractor label without reviewed substance or unsigned terms cannot activate)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-SELLERS) `apps/api/test/cmd049-activate-seller.test.ts` :: "DENY: an agency member's tenant session is a foreign scope and a seller a wrong role (403); then one missing prerequisite at a time — an unsigned agreement, a contractor label without a legal review of its substance, no assessment evidence, an unverified destination, no fresh step-up — each refused with the seller left CANDIDATE" — observes: each answer, the seller row.
  - EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-sales-migrations.test.ts` :: "CMD049 at the database: a seller becomes ACTIVE only with a signed agreement, a confirming legal review, assessment and confidentiality records, a VERIFIED destination and tax documentation (KC005), and a seller's session reads only its own sales rows" — observes: KC005, the row-security policies.
- **CMD049-RACE** (one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-SELLERS) `apps/api/test/cmd049-activate-seller.test.ts` :: "RACE: an identical retry replays the 200, the same key with another agreementId is 409 IDEMPOTENCY_CONFLICT, two activations racing yield one ACTIVE seller with the wait observed, and a crash before COMMIT leaves it CANDIDATE" — observes: the journal, the lock wait, one transition.
- **CMD050-OK** (TerminateSeller; end new assignment/access, preserve signed residuals and define the eligible ninety-day opportunity tail)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-SELLERS) `apps/api/test/cmd050-terminate-seller.test.ts` :: "OK: the owner terminates an ACTIVE seller with prepared terms and an enumerated manifest — 200 with the seller TERMINATED at the effective instant, its assignments ended, its prospects unassigned, its entitlements TERMINATED_WITH_RESIDUAL, its unlisted open claims EXPIRED and one tail entry per listed opportunity" — observes: the answer and every affected row.
- **CMD050-DENY** (do not erase the ledger, forfeit rights by a role change or grant a tail over an entire scraped list)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-SELLERS) `apps/api/test/cmd050-terminate-seller.test.ts` :: "DENY: an agency member's tenant session is a foreign scope and a seller a wrong role (403); then one missing prerequisite at a time — a manifest entry of an agency that already purchased or of another seller's claim TAIL_NOT_ENUMERATED, a manifest of unclaimed scraped prospects TAIL_NOT_ENUMERATED, no termination terms TERMINATION_TERMS_UNPREPARED, a stale version — nothing is written" — observes: each answer, unchanged rows.
  - EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-ledger-migrations.test.ts` :: "CMD050 at the database: no runtime role holds DELETE on any B10 table, and a terminated seller's lines, adjustments, statements and payout rows are unchanged by the termination" — observes: the privilege matrix, row digests.
- **CMD050-RACE** (one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority)
  - PLANNED EXECUTED_LOCAL (B10-COMMANDS-SELLERS) `apps/api/test/cmd050-terminate-seller.test.ts` :: "RACE: an identical retry replays the 200, the same key with another manifest is 409 IDEMPOTENCY_CONFLICT, two terminations on one expectedVersion yield one TERMINATED seller and one 409 STALE_VERSION with the wait observed, and a crash before COMMIT leaves the seller ACTIVE with its claims and entitlements unchanged" — observes: the lock wait, one termination, the journal.
  - PLANNED EXECUTED_LOCAL (B10-INTEGRATION) `apps/api/test/b10-scenarios.test.ts` :: "CMD050-RACE: TerminateSeller racing AcceptAttribution of the seller's unlisted claim, held at the seller row, serializes in both orders — acceptance first: the claim is ACCEPTED, then EXPIRED as unlisted by the termination; termination first: the claim is EXPIRED and AcceptAttribution is 409 CLAIM_NOT_REVIEWABLE — and no live claim of a terminated seller remains" — observes: the hold point, the lock wait, the claim and allocation rows in both runs.
- **CMD051-OK** (CloseCommissionPeriod; issue an immutable statement with itemized basis, rates, adjustments, holds and payout date)
  - PLANNED SIMULATED (B10-STATEMENTS-PAYOUTS) `apps/api/test/cmd051-close-commission-period.test.ts` :: "OK: the commission service closes a due September 2026 period on the test calendar — 200 with one immutable ISSUED statement per seller itemizing each line, dated 2026-10-07 with pay date 2026-10-15 and labelled SIMULATED, its ELIGIBLE lines PAYABLE and the period CLOSED" — observes: statements, items, lines, the period.
  - EXECUTED_LOCAL (B10-ADAPTERS-LEDGER, 8a91985) `packages/persistence/test/b10-ledger-adapters.test.ts` :: "CMD051 through the adapters: the cutoff hash KAURO_COMMISSION_CUTOFF_V1 over the included lines, adjustments and holds is recomputed identically from the rows and changes with any of them, and statements and their items cannot be updated or deleted" — observes: the hash, kauro.forbid_change.
  - PLANNED EXECUTED_LOCAL (B10-STATEMENTS-PAYOUTS) `apps/api/test/commission-statement-reads.test.ts` :: "GetCommissionStatement answers a seller its own statement and the owner any — per line the agency and project reference, first or repeat, basis, rate, share, cumulative, previously paid, adjustment, hold reason and review date — and never another seller's rows, a destination digest, contact details or customer CRM values" — observes: the view against its closed schema, 404 for another seller.
- **CMD051-DENY** (unknown settlement or missing final completion remains a reasoned hold, not invented eligibility)
  - PLANNED EXECUTED_LOCAL (B10-STATEMENTS-PAYOUTS) `apps/api/test/cmd051-close-commission-period.test.ts` :: "DENY: a user token or the finance service is a wrong service identity (403) and another period a foreign scope (404); then one missing prerequisite at a time — an undelivered COMMISSIONS record before the cutoff INPUTS_UNRECONCILED, a changed ledger LEDGER_CHANGED, a period not yet due PERIOD_NOT_DUE — and a line awaiting final completion or AVAILABLE funds stays a reasoned hold item, never payable" — observes: each answer, the period OPEN, the hold items of a later close.
  - EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-ledger-migrations.test.ts` :: "CMD051 at the database: a line becomes PAYABLE only through an ISSUED statement item naming it, and a line without a FINAL completion 720 hours old or AVAILABLE funds cannot be ELIGIBLE (KC007)" — observes: the transition guard, KC007.
- **CMD051-RACE** (one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority)
  - PLANNED EXECUTED_LOCAL (B10-STATEMENTS-PAYOUTS) `apps/api/test/cmd051-close-commission-period.test.ts` :: "RACE: an identical retry replays the 200 with the same statements, the same key with another ledgerCutoffHash is 409 IDEMPOTENCY_CONFLICT, a close racing a refund adjustment serializes on the period in both orders — the adjustment is in this statement or the next, never both or neither — and a crash before COMMIT leaves the period OPEN" — observes: the lock wait, the items of both statements, the journal.
- **CMD052-OK** (ApproveCommissionPayout; create a reviewable authorized payout intent for eligible value)
  - PLANNED EXECUTED_LOCAL (B10-STATEMENTS-PAYOUTS) `apps/api/test/cmd052-approve-commission-payout.test.ts` :: "OK: the owner with a fresh step-up approves an ISSUED statement's payable to the seller's VERIFIED destination with bank-available cash — 200 with one AUTHORIZED intent of exactly the payable, fee bearer KAURO, the destination's version and digest and reference kauro-payout-<intentId>, the statement APPROVED, and no transfer" — observes: the answer, intent and statement rows, no provider call.
- **CMD052-DENY** (no arbitrary minimum, silent fee deduction or unauthorized funds transfer)
  - PLANNED EXECUTED_LOCAL (B10-STATEMENTS-PAYOUTS) `apps/api/test/cmd052-approve-commission-payout.test.ts` :: "DENY: an agency member's tenant session is a foreign scope and the seller a wrong role (403); then one missing prerequisite at a time — an unverified or superseded payee PAYEE_UNVERIFIED, a zero payable NOTHING_PAYABLE, cash short of the payable and the live intents FUNDS_UNAVAILABLE, no fresh step-up — and a one-cent payable is approved in full with no fee deducted" — observes: each answer, the one-cent intent.
  - EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-ledger-migrations.test.ts` :: "CMD052 at the database: an intent's amount equals its statement's payable, its payee is a VERIFIED destination version of the statement's seller (KC009), and one live intent exists per statement" — observes: the CHECK, KC009, the unique index.
- **CMD052-RACE** (one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority)
  - PLANNED EXECUTED_LOCAL (B10-STATEMENTS-PAYOUTS) `apps/api/test/cmd052-approve-commission-payout.test.ts` :: "RACE: an identical retry replays the 200, the same key with another payeeRef is 409 IDEMPOTENCY_CONFLICT, two approvals of one statement yield one intent and one 409 STALE_VERSION with the wait observed, and a crash before COMMIT leaves the statement ISSUED with no intent" — observes: the journal, the lock wait, one intent.
- **CMD053-OK** (ReconcileCommissionPayout; mark actual paid value and preserve any failed/returned transfer for recovery)
  - PLANNED SIMULATED (B10-STATEMENTS-PAYOUTS) `apps/api/test/cmd053-reconcile-commission-payout.test.ts` :: "OK: the finance service reconciles an intent with SETTLED evidence from the payout-evidence fake matching reference, destination digest, amount and currency — 200 with the intent SETTLED, the statement PAID with the evidence hash and its lines PAID; FAILED or RETURNED evidence keeps the intent FAILED or RETURNED, the statement ISSUED and the lines HELD PAYOUT_FAILED with a review date" — observes: intent, statement and line rows, the fake's log.
  - EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-ledger-migrations.test.ts` :: "CMD053 at the database: a line becomes PAID only when its statement's intent is SETTLED with an evidence hash (KC010), and a FAILED or RETURNED intent is kept with its evidence" — observes: KC010, the retained rows.
- **CMD053-DENY** (submitting a transfer is not proof the seller received it)
  - PLANNED SIMULATED (B10-STATEMENTS-PAYOUTS) `apps/api/test/cmd053-reconcile-commission-payout.test.ts` :: "DENY: a user token or the commission service is a wrong service identity (403) and an intent of another statement a foreign scope (404); then one missing prerequisite at a time — evidence of another reference, destination or amount PAYOUT_EVIDENCE_MISMATCH, SUBMITTED-only evidence PAYOUT_NOT_SETTLED — nothing changes and the lines stay PAYABLE" — observes: each answer, unchanged rows, the fake's log.
  - EXECUTED_LOCAL (B10-SCHEMA-COMMISSION; 3decc1f) `packages/persistence/test/b10-ledger-migrations.test.ts` :: "CMD053 at the database: a line becomes PAID only when its statement's intent is SETTLED with an evidence hash (KC010), and a FAILED or RETURNED intent is kept with its evidence" — observes: KC010 for a SUBMITTED intent.
- **CMD053-RACE** (one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority)
  - PLANNED SIMULATED (B10-STATEMENTS-PAYOUTS) `apps/api/test/cmd053-reconcile-commission-payout.test.ts` :: "RACE: an identical retry replays the 200, the same key with other evidence is 409 IDEMPOTENCY_CONFLICT, two reconciliations of one intent yield one settlement with the wait observed, and a crash before COMMIT leaves the intent AUTHORIZED and the lines PAYABLE" — observes: the journal, the lock wait, one settlement.
  - EXECUTED_LOCAL (B10-ADAPTERS-LEDGER, 8a91985) `packages/persistence/test/b10-ledger-adapters.test.ts` :: "CMD053 through the adapters: settling an intent takes its statement's row lock, so two settlements serialize and the second finds it SETTLED and changes nothing" — observes: the lock wait, one transition.

## Beyond the sixty-four cases

B10 closes the commission halves B09 left to it (`docs/design/B09-case-map.md`: S060, R2-081, R2-140, CMD030-DENY, CMD033-OK) and
the worked examples whose routed cases are B09's or B15's; these rows support those cases and are not counted above.

- EXECUTED_LOCAL (B10-ADAPTERS-LEDGER, 8a91985; B09 R2-081) `packages/persistence/test/b10-ledger-adapters.test.ts` :: "R2-081 at the ledger: twenty-five one-cent service refunds of a 25-cent basis recompute each line cumulatively and leave every pool, allocation and line at exactly zero with no residue" — observes: adjustments summing to the original accrual.
- PLANNED EXECUTED_LOCAL (B10-COMMISSION-SERVICE; B09 R2-140, CMD030-DENY) `apps/api/test/b10-commission-service.test.ts` :: "R2-140 (example 20): a second full capture of one obligation and a duplicated capture.completed.v1 delivery accrue nothing more — one pool per purchase and source, its basis the allocated service capped by the obligation" — observes: pools, inbox rows.
- PLANNED EXECUTED_LOCAL (B10-COMMISSION-SERVICE; B09 CMD033-OK) `apps/api/test/b10-commission-service.test.ts` :: "COMMISSIONS on capture.completed.v1, refund.completed.v1 and capture.reversed.v1: one pool and line per beneficiary per purchase, one adjustment per changed line and event, the first designation mirrored once into agencies.first_qualifying_capture_id with agency.first_purchase_designated.v1, and a replay adds nothing" — observes: ledger, agency and event rows.
- EXECUTED_LOCAL (B10-ADAPTERS-LEDGER, 8a91985; B09 B09-R2) `packages/persistence/test/b10-ledger-adapters.test.ts` :: "B09-R2 at the ledger: a commission basis only falls — a refund.completed.v1 after the capture's reversal, and one naming a basis above the line's current basis, append no adjustment, and a replay of any event adds nothing" — observes: adjustment and line rows after each event.
- PLANNED EXECUTED_LOCAL (B10-COMMISSION-SERVICE; B09 B09-R2) `apps/api/test/b10-commission-service.test.ts` :: "B09-R2: a capture's completion, refund completion and reversal delivered to COMMISSIONS in every order end with the same cumulative entitlements, one adjustment per changed line and event, and every line at zero basis after the reversal" — observes: adjustments and lines for each delivery order.
- PLANNED EXECUTED_LOCAL (B10-COMMISSION-SERVICE; B06 D-LEASE-3) `apps/api/test/b10-commission-service.test.ts` :: "D-LEASE-3: the COMMISSIONS dispatcher's OUTBOX_DISPATCH lease is held against a second dispatcher, is resumed under the next fence by its former owner once it expired, and a dispatcher whose heartbeat is refused settles nothing more" — observes: lease rows and fences, the unsettled outbox records.
- PLANNED EXECUTED_LOCAL (B10-COMMISSION-SERVICE; B15 R2-085) `apps/api/test/b10-commission-service.test.ts` :: "example 14: capture.funds_observed.v1 HELD moves an otherwise due line HELD FUNDS_HELD with a review date and blocks no unrelated line, and AVAILABLE releases it in the ELIGIBILITY sweep" — observes: hold rows, line states.
- PLANNED EXECUTED_LOCAL (B10-COMMISSION-SERVICE; B09 R2-128) `apps/api/test/b10-commission-service.test.ts` :: "example 19: a tax-inclusive 112000-cent capture of a 100000-cent service line accrues a 10000-cent first pool on the service only, and a gross partial refund changes the basis by its service component alone" — observes: pool basis, adjustment.
- PLANNED EXECUTED_LOCAL (B10-COMMISSION-SERVICE) `apps/api/test/b10-commission-service.test.ts` :: "the CLAIM_WINDOWS, ENTITLEMENT_WINDOWS and ACCRUAL_RECONCILIATION sweeps: claims lapse at their deadline with no first purchase, entitlements expire at window end with earned lines unaffected, and an acceptance after the first purchase gains its missing lines once" — observes: claim, entitlement and line rows.
- PLANNED EXECUTED_LOCAL (B10-COMMANDS-QUOTE; B09 S060) `apps/api/test/cmd027-create-quote.test.ts` :: "S060 (example 16): a quote's source availability is never later than B07's effective deadline, and CreateQuote on a SEALED revision whose retention deadline has passed on the database clock, the sweeper not yet run, is SOURCE_EXPIRED through SourceAvailabilityReader" — observes: the quote column, the refusal, the TEST CLOCK instant.
- EXECUTED_LOCAL (B10-MODEL; 2766642) `packages/domain/test/commercial-rules.test.ts` :: "every B10 failure reason of design section 12 is registered once in FAILURE_REASONS and no reason of B06, B07 or B09 is redefined" — observes: FAILURE_REASONS.
- EXECUTED_LOCAL (B10-SCHEMA-RECURRENCE; b85ee64) `packages/domain/test/commercial-machines.test.ts` :: "the platform machines FoundingReservation, Seller, Prospect, AttributionClaim, CommissionEntitlement, CommissionStatement, PayoutIntent, PayoutDestination, CommissionHold and CommissionPeriod admit exactly the edges of design section 8.2 from their initial states, every other edge rejected, and CommissionLine is the registry's machine unchanged" — observes: each machine's edge set against the design's table.
- SIMULATED (B10-PORTS-FAKES; e95b97b) `packages/application/test/commercial-fakes.test.ts` :: "the buyer-type, preparation-completion and payout-evidence fakes answer only what their scripts hold — unset, STAGE or FINAL, SUBMITTED, SETTLED, FAILED or RETURNED — each labelled CONTRACT_FAKE and SIMULATED with a call log, reachable only from the testing subpath" — observes: the fakes' answers, labels and exports.

The `b10/stage-1` integrator (B10-MODEL 58cd732, B10-PORTS-FAKES 3971097, B10-SCHEMA-RECURRENCE 318c763 and B10-SCHEMA-COMMISSION
322150e merged from `b10/base`) holds the four stage-1 lanes to one implementation (D10-STAGE-2); these rows support every case and
are not counted above (tests first at 7624047, the seams fixed at cb3409b).

- EXECUTED_LOCAL (b10/stage-1 integrator; cb3409b) `packages/persistence/test/b10-stage-one.test.ts` :: "B10 stage 1 is one vocabulary: every enumerated column of migrations 0028..0031 admits exactly the tokens COMMERCIAL_VOCABULARY declares for it, so no record, machine or view spells a token the database refuses" — observes: the CHECK token sets of pg_constraint against the domain's lists.
- EXECUTED_LOCAL (b10/stage-1 integrator; cb3409b) `packages/persistence/test/b10-stage-one.test.ts` :: "B10 stage 1 is one calendar rule: the domain's banking-day ordinal answers what kauro.banking_day_after answers for the same stored calendar — the example 21 fixture's 2026-10-07 and 2026-10-15, and no date where the calendar does not cover the day it needs" — observes: both answers at the coverage edges.
- EXECUTED_LOCAL (b10/stage-1 integrator; cb3409b) `packages/persistence/test/b10-stage-one.test.ts` :: "B10 stage 1 is one findings list: kauro.eligibility_findings reports only the findings the domain's EligibilityFinding declares" — observes: the function's findings.
- EXECUTED_LOCAL (b10/stage-1 integrator; cb3409b) `packages/domain/test/commercial-stage-one.test.ts` :: "B10 stage 1 is one state vocabulary: each platform machine of section 8.2 and the registry's CommissionLine have exactly the states COMMERCIAL_VOCABULARY gives their record's state column" — observes: each machine's states.
- EXECUTED_LOCAL (b10/stage-1 integrator; cb3409b) `packages/application/test/commercial-stage-one.test.ts` :: "B10 stage 1 is one view vocabulary: every token list the commercial views answer is the domain's stored vocabulary, so a command lane converts nothing and no view refuses a token the database stores" — observes: COMMERCIAL_VIEW_VOCABULARY against the domain's lists.
- SIMULATED (b10/stage-1 integrator; cb3409b) `packages/application/test/commercial-stage-one.test.ts` :: "B10 stage 1 is one port contract: the banking-calendar fake serves a version banking_calendars can record — its version label, source and the dates it covers, every listed day inside them — and the preparation-completion fake reports completions purchase_completions can record, a registered source and a stage reference exactly for a STAGE" — observes: the two fakes' answers and refusals.
- EXECUTED_LOCAL (b10/stage-1 integrator; cb3409b) `tools/test/b10-stage-one.test.mjs` :: "B10 stage 1 is one error contract: the KC codes migrations 0028..0031 raise are exactly section 12's, each named by a registered commercial failure reason and translated by exactly one stage-2 mandate that names it" — observes: the migrations, section 12, FAILURE_REASONS and the stage-2 tasks.

## Gate G-COMMERCIAL

Evidence rule (21): exact subject, public consumer, independent truth, complete result, meaningful negative control and reviewer
acceptance. The public consumers are the routes of the twelve commands, GetCommissionStatement and the commission service; the
independent truth is the worked examples' hand-calculated integer cents and the superuser reading every table; every negative case
keeps a valid neighbour (the other agency's slot, the undisputed line, the verified destination, the enumerated opportunity).
G-COMMERCIAL closes only by A4: verify green on Windows, Linux and CI, Codex review of the exact commit, on main; the PARTIAL clauses
stay open with B08, B11, B12, B13, B15 and B16 as named.
