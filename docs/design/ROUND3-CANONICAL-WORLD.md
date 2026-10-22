# Round 3: the canonical synthetic world

Master plan §2.1, deliverables plan §1.3. One world that every screen and every document reads, so the same project shows the same counts,
money and dates on the owner console, the workspace, the seller portal, the public sample and the PDF.

- **Module:** `tools/review/private/lib/canon/` (typed, deeply frozen, no clock, no randomness). Entry point `index.ts` (`CANON`,
  `STRESS_WORLDS`, `projectView`, `sellerFigures`, `kauroFigures`, `computeAlerts`); checks in `reconcile.ts`.
- **JSON export:** `world.json`, written by `node tools/review/private/lib/canon/export.mjs` (`--check` fails when stale). Node 24 runs
  the `.ts` files with its built-in type stripping, so there is no build step.
- **Test:** `node --test tools/test/canon.test.mjs`. **Typecheck:** `npx tsc --noEmit -p tools/review/private/tsconfig.json`.

## The world, as of Thursday 2026-10-22, 09:00 Bogotá (14:00 UTC)

- **Calendar.** Times are America/Bogota (UTC-5). Non-business days are weekends plus 2026-10-12, 2026-11-02 and 2026-11-16. Oct 12 is
  added to the two dates in the brief because the September statement's pay date (Oct 15) depends on it.
- **People.**
  - The Kauro owner.
  - 21 customer people: Lena Ortiz and her Northwind team, Tomas Reyes, Ana Silva (no workspace) and the other workspaces' members.
  - Every role appears: owner, admin, operator, approver, billing, viewer. Lena also belongs to four other workspaces, as in
    `lib/world.ts`.
- **Workspaces.**
  - Seven agencies: Northwind Data, Coastline Analytics, Ridge & Fennel (restricted), Juniper Digital, Northwind Labs (draft, empty),
    Fjordline Media, Quillon Partners.
  - Three companies: Halden Outdoor (Colombia, IVA 19%), Larkspur Home Goods, and Brindle & Oak Furniture (Colombia, buying direct).
  - The read-only Example workspace.
  - 14 clients.
- **Projects: 20, one per current step.** Every step of the path is some project's current step: sources, selection, seal, target,
  check, mapping, duplicates, relationships, approval, quote, payment (awaiting a transfer, and held with proof of a transfer), processing,
  delivery, import, receipt, and retention or deletion. The three services are all used. The public sample project is built from
  `apps/web/src/public/sample-data.ts` itself:
  - 12,480 contacts and 3,204 companies;
  - 428 contacts in 193 pairs and 14 triples, 7 pairs kept apart;
  - 214 and 253 rows unified; 12,266 and 2,951 rows delivered;
  - Prepare for HubSpot, USD 1,295, the band up to 50,000 units, quoted as an illustration only.

  The review's main project ("Contacts and companies", the web fixtures' PROJECT, QUOTE and ORDER ids) has the same files and counts. It
  is quoted at USD 1,230.25 after Northwind's 5% repeat discount and waits for the transfer.
- **Money.**
  - 11 quotes, with band, repeat discount, tax and 14-day validity, and 9 payment orders.
  - 1 pending-transfer hold: five business days, 24-day ceiling (both proposed values).
  - 7 confirmed payments: USD 9,057.55 received, of which USD 8,525.50 is revenue and USD 113.05 is net tax after refunds.
  - 2 refunds.
  - 2 refund requests: one with counsel (pending legal review), one refused in neutral words.
- **Sellers.**
  - Daniel Kim is busy and has a refund offset with a USD 30.00 balance.
  - Amara Okafor has a signed USD 150 monthly retainer, an applied offset, and a line held by an open defect report.
  - Lucía Ferrer is new and still onboarding, 3 of 9 steps.
  - Tomás Vidal has made no relevant progress for 17 days.
  - The sales records: 12 claims (one refused, shown to the seller as "Not available to claim"), 15 prospects, 5 commission lines, 2
    retainer lines, 2 offsets, 4 statements and 2 payouts.
  - Daniel: USD 3,920.25 net attributable revenue, USD 318.21 commission generated, USD 229.50 paid, USD 88.71 pending.
  - Amara: USD 1,890.00 revenue, USD 189.00 commission, all pending (USD 129.50 held), plus her retainer kept apart.
- **Operations.**
  - 6 jobs: queued, running, failed and succeeded.
  - 2 incidents: one open (S2), one resolved (S3).
  - 4 deletions: one pending, three done with receipts.
  - 3 releases: promoted, held, candidate.
  - 6 support cases. Case 115 is one story across pages: it holds Amara's line and backs the refund request counsel is reviewing.
- **Alerts due now (8).**
  - One blocked project (Ridge's quote cannot be ordered).
  - Two claims ending: one in 3 days, one in 14.
  - Four deadlines within two days.
  - Tomás's inactivity.

## Stress variants (`STRESS_WORLDS`, each a whole world)

- **`emptyAgency`:** Ana Silva's brand-new agency, with nothing in it.
- **`longNames`:** workspace, person, client, project and file names of 60 or more characters.
- **`unicode`:** Arabic and Hebrew (right to left), Chinese, Japanese, and Latin diacritics, in workspace, person, client, project and
  file names.
- **`nineDigitCounts`:** 412,345,678 and 108,765,432 rows. This is beyond the price ladder, so there is no quote.
- **`list200`:** 200 projects of one agency, generated from the index alone.
- **`failedRun`:** a health check that failed twice on an unreadable file.
- **`partialRun`:** a HubSpot import returned with 9,412 rows accepted and 588 refused.

## Reconciliation rules (`reconcile.ts`)

1. **Ids and references.** Every id is unique across the world, and every reference resolves. A project's client is in the project's
   workspace.
2. **Counts.**
   - Units are the rows of the sealed, selected files.
   - Unified rows are the approved pairs plus two for each approved triple.
   - Delivered rows are source rows less unified rows.
   - Linked plus unlinked rows equal the child rows after unification.
   - Import results add up: accepted plus refused rows equal the rows sent.
3. **Steps and dates.**
   - Each step has its facts, and later steps' facts are absent. For example, there is no payment before processing and no import for
     Clean your data.
   - Dates run in this order: upload, seal, check, approval, quote, order, payment, preparation, package, import, receipt, then
     deletion. No date falls after the world's "now".
   - The date that matters follows the policy: upload 24 h; free check files 7 days, at most 14 from sealing; hold; package 7/14 days;
     staged package 21/30 days; receipt 7 days.
4. **Customer money.**
   - The list price is the band's price.
   - The discount follows the repeat ladder for the workspace's paid projects in the last 365 days.
   - Service is list less discount, tax is the buyer's rate of the service, and the total is service plus tax. A quote is valid for 14
     days.
   - Order equals quote total, and payment equals order, with each payment counted once.
   - The send-by date is four days before the earlier of the quote's end and the files' end.
   - The hold is five business days from the proof, never past 24 days from sealing, and only one is allowed. It is given by an owner
     or a billing member.
   - Refunds never exceed what was paid, and refunded tax is the tax on the refunded service.
5. **Seller money.**
   - Each commissioned collection has exactly one line.
   - The rate is the agreement's FIRST or REPEAT rate on the service collected, never on tax.
   - A line is payable 30 days after completion and sits on that month's statement.
   - An offset's basis is the rate on the refunded service, and its balance is basis less applied.
   - A statement's total is commission less applied offsets plus retainer, with held lines kept apart. It is issued on the 5th business
     day and paid by the 10th.
   - Pending plus paid equals generated. Generated equals rate × net attributable revenue, line by line. Revenue includes no tax.
   - Payouts never exceed paid commission plus paid retainer.
   - A retainer appears only on a signed agreement, for each month since it started.
   - An accepted claim lasts 90 days and converts on the first payment.
   - A refused claim reads "Not available to claim" whenever the reason would reveal a relationship.
6. **Operations.**
   - A job's times and failure fit its state.
   - A processing project has a running preparation, and a running check has a running job.
   - A deletion is requested by an owner or an admin, or by the schedule at the policy's time. A finished deletion has a receipt that
     matches the project's deletion date.
   - Defect reports are made within 30 days of completion.

The test also breaks the world on purpose, in 15 different ways, and requires the reconciliation to name each break.

## How screens and documents read it

- **Read from `CANON`, never retype.**
  - Resolve a project with `projectView(world, id)`.
  - Compute figures with `sellerFigures`, `kauroFigures` and `computeAlerts`, and format them at the edge (USD minor units → words).
  - "Now" is `AS_OF`, never `Date.now()`.
- **Draw stress states from the matching world.** A state picker passes `STRESS_WORLDS.longNames` (or another variant) in place of
  `CANON` to the same component.
- **Documents read `world.json`,** or load the module under Node 24. Under deliverables plan §1.3, the PDF renders from it when the
  Migration Core path works. If it does not, the canonical names and figures are mapped onto the acceptance cases.
- **Adoption is a later step.** The existing review files (`lib/world*.ts`, `prototypes/sales.ts`, `projects-data.ts`, `timeline.ts`)
  are not changed by this work. Migrating them to read the canon is a separate step, under the master plan's change control.

## Decisions made here (where the existing review data disagreed with itself or with the brief)

- **20 projects instead of 12–16.**
  - 16 projects hold the 15 live steps (payment twice: awaiting and held).
  - 3 finished, deleted projects hold the retention step and carry the sellers' paid, held and offset lines.
  - The last one is the public sample.
- **Tomás Vidal is active but inactive (last progress Oct 5), not ended.** The brief asks for an inactive seller within 3–4 sellers. The
  ended seller of `sales.ts` is therefore not in the canon. Quillon Partners is his claimed, not yet paying, customer.
- **Dates moved so that one "now" works.** The world is one day later than the review (Oct 22, not Oct 21). Some payments moved:
  - Coastline "Q4 contacts" is paid Oct 20 (was Oct 14).
  - Larkspur is paid Oct 22 (was Oct 19).
  - Juniper has not paid yet. Its claim is accepted and its workspace opened after the claim (was June).
- **Unique ids.**
  - `sales.ts` gave Coastline the same id as Daniel Kim.
  - `world-projects.ts` reused one project id in three workspaces.
  - The canon gives each record its own id and keeps every id the review already routes by.
- **Tax.** Two Colombian buyers pay IVA 19%. Exports pay none. Tax is a separate figure on quotes, payments and refunds, and is never in
  revenue or a commission basis.

## Not modelled (and why)

- **The founding discount** (25% for the first three customers): the places used have no read yet. The canon only uses the repeat
  ladder.
- **Invoices as documents, credit notes and FX (COP payouts):** the canon names an invoice number on each payment. The money is always
  what was received.
- **Seller agreement amendments, sender verification and outreach drafts:** they stay in `prototypes/sales.ts` until those screens move
  to the canon.
- **Soft extensions of a free check, and an ended hold:** they are dated in `prototypes/retention.ts` as proposals. A world has one
  "now", so these moments stay as screen states rather than records.
- **Record-level rows (names, emails):** the public sample's `JOURNEY_ROWS` and `SAMPLE_RECORDS` stay where they are. The canon holds
  counts, never customer data.
