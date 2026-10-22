# Order 11, round 2: the owner console and the seller console

Branch `order11/r2-ops`, 2026-10-21. Review prototypes only (frontend, synthetic data). Research: `Kauro.archive/Deliveries/Visual/order11/
research/round2/` (`owner-console.md`, `seller-portal.md`, `principles-craft.md`, `signed-in-notes.md`, `app-shell-settings.md` §9).
Screenshots: `Kauro.archive/Deliveries/Visual/order11/shots/round2-ops/` (every page at 1280 and 375, light and dark).

## What applies to every page

- **One world.** `tools/review/private/prototypes/sales.ts` now holds four sellers (Daniel Kim, Amara Okafor active; Lucía Ferrer
  onboarding; Tomás Vidal ended), seven customers (five agencies, two companies; one direct), every commission line and statement, the
  claims, prospects and outreach drafts. Every figure on Today, Sellers, a seller, Payouts, Customers, a customer, Claims and the seller's
  pages comes from it, so a number reads the same everywhere (USD 199.00 payable by Nov 17, USD 129.50 held; October collected USD
  4,005.75). The review's "now" is Wednesday, Oct 21, 2026, 09:12 Bogotá. All people and companies are synthetic.
- **Type and space** (`prototypes/ops.css`, scoped to `.kauro-ops`): h1 28 px (24 px on phones), section h2 20 px, body 16 px, meta 13–14
  px; tables 16 px, figures right-aligned and tabular, the currency in the column header; sets of figures one size (24 px) and one weight
  (`Figures`); sections separated by space, not rules; tables become labelled cards when their box is narrow (container queries).
- **Actions.** At most one filled button per view; secondary actions outlined; rare or ending acts as text links at the foot. The queue
  (`Queue`) fills only its first button, and only when that item is due today.
- **Leads are plain sentences** that state the page's point (often with today's count), not the registry's specification sentence
  (research Q-6; the registry sentence stays as the screen's description). Earlier decision changed: BRIEF §5.1 "registry sentence as lead".
- **Times.** Bogotá on business pages (Today, money, support); UTC kept on technical pages (Jobs, Deletion, Incidents, Releases).
- **Menu** (`apps/web/src/screens.ts`, copy ids in `apps/web/src/copy/en.ts`). Owner: Today · Money (Finance, Payouts) · Customers (a group
  of one, so no heading that repeats it) · Sellers (Sellers, Claims) · Sales work (Prospects, Outreach, Resources) · Operations (Support
  cases, Jobs, Incidents, Deletion) · Company (Operating review, Releases, Owner actions, Settings). Seller: Today, Prospects, Outreach,
  Commissions, Resources, without headings (a narrowed menu of seven or fewer entries drops them). Proposed pages carry a `proposedPath`
  and appear only where their page exists (the review), so the product's menu is unchanged until they are built. Owner actions left the top
  of the menu (Today's queue lists what is due). Settings stays reachable from the account menu (`accountHref` → `/ops/settings`).
- **New proposals** (`lib/proposals.ts`, `app/[[...path]]/page.tsx`, `lib/screens.tsx`): P-21 Sellers `/ops/sales/sellers`, P-22 Payouts
  `/ops/money/payouts`, P-23 Customers `/ops/customers`, P-24 Claims `/ops/sales/claims`. P-03 and P-04 rewritten.

## Owner console

### Today (UI33, owner)
- **For:** what needs the owner now, then the day's facts.
- **Changed:** one queue of seven items by due time (match a transfer, a support answer due, an assessment, the domain, a claim, a message
  to authorise, a release to promote), each with why, when and one action; three equal money figures (received and matched, to match,
  owed to sellers), each a link to its page; projects by stage with only "waiting on Kauro" and "over 14 days" emphasised (a one-line list
  per stage on phones); one line on new customers and claims; health only where something is not normal. Removed: nine tiles, three group
  headings, "Open" on every tile, zero tiles ("None open", "1 running"). Empty queue: one sentence with the time checked.
- **Earlier decision changed:** round 1's Today of nine tiles in three department groups (Money, Work, Product and sales).
- **Gaps:** needs a read of projects by stage and waiting party across workspaces; of new customers by channel.

### Sellers (P-21, new)
- **For:** who sells, what each brought in, what is owed, their rates.
- **Shows:** one row per seller: name, status word, since; owed now (with "pays Nov 17" and held); customers by kind and count; collected
  and commission for a chosen period (this month, last month, since start; the headers say which); claims; a total row. Status filter
  with counts (zero counts not drawn), default All (four sellers fit one screen; "Needs you" is a filter). One primary: Register a seller.
  Rates are one sentence under the table because every agreement in force has the default rates; a differing agreement would show its
  rates beside the name (retainer shown only when above zero; none is).
- **Gaps:** needs a read: list sellers with aggregates (owed, held, collected, commission, customers by kind, claims). CSV export proposed.

### Seller (UI37, rebuilt; the seller the address names)
- **For:** one seller's money and work.
- **Shows:** "Needs you" only when non-empty; four money figures (collected, commission, owed now, paid); money by state (earned and
  waiting for projects, held with reason and review date, payable by date, paid with reference); statements; customers acquired (kind,
  first paid, repeat window end, projects, collected, commission); claims and work; agreement and onboarding facts with "Prepare an
  amendment"; history; "Pause or end" as text actions at the foot. A candidate (Lucía) sees the setup checklist first ("3 of 9 steps done")
  and no money sections; an ended seller (Tomás) sees what Kauro still owes.
- **Earlier decision changed:** UI37 opened on six onboarding steps for everyone, with a danger button beside routine ones.
- **Gaps:** needs a read: seller record with agreement and rates, customers, lines and statements across months.

### Payouts (P-22, new) and a seller's statements (UI36, owner)
- **For:** what the owner owes sellers, when, and what holds it; the monthly pay journey.
- **Shows:** the cycle as one dated sentence; groups only when non-empty (to approve; sent, not yet confirmed); every statement with held,
  payable, pay date and paid reference, a total; "Coming" as facts only (no forecast). A statement page (UI36 for one seller) holds
  "Approve the payout" (CMD052) once issued. Confirming paid needs the bank's proof (CMD053, inert): said in words, no disabled button.
- **Gaps:** needs a read: statements by period across sellers. Record a transfer as sent has no command of its own (only CMD053).

### Customers (P-23, new) and a customer (UI35, rebuilt)
- **Shows:** every agency and company with kind, how it came (direct or a seller), who serves it, projects paid, collected, last payment,
  a total; filter by kind. The customer page: two equal cards (who serves them; who acquired them, with the claim and rates), the paid
  projects with service and commission, and the reassignment. Removed: the permanent "Two facts, kept apart" banner.
- **Gaps:** needs a read: customers with buyer type, channel, acquiring and serving seller, paid projects and money.

### Claims (P-24, new)
- **For:** the owner decides claims; sellers work prospects. Claims to decide first; one opens with evidence, the check against Kauro's
  records and what accepting means in dates; Accept (CMD047) or Refuse with a reason from a fixed list the seller reads.
- **Earlier decision changed:** claims were decided inside Prospects (round 1).
- **Gaps:** needs a read: claims across sellers. The refusal reasons are a proposed fixed list.

### Settings (P-04, rebuilt)
- **Shows:** fourteen sections in five groups (You; Selling; Money; Platform; Company), each saying in words what it is backed by: Live
  (an existing command), Read-only (policy value with its version: prices R2-INITIAL, discounts, quote validity, commission defaults,
  limits, retention) or Needs backend (business details, team, notifications, recovery). Rates by seller. No secret values anywhere.
- **Earlier decision changed:** round 1's "Security controls" (links only), mixed "Operating parameters", the secrets paragraph.
- **Note:** the 25% discount for the first three customers is described without the word the copy lint forbids; places used needs a read.

### Reworked operational pages
- **Owner actions (UI38):** one prepared action in a framed block, "Not ready" and "Done" as lists; no longer a top menu item.
- **Jobs (UI40), Deletion (UI41), Incidents (UI42), Releases (UI43), Support cases (UI55):** plain leads with the count that matters;
  framed detail blocks; Incidents with nothing open is one sentence (no success banner) and the duties are a states list; Support times in
  Bogotá; case 115 is now Fjordline Media's defect report, which holds Amara Okafor's line (one story across pages).
- **Operating review (UI44):** four mixed plates replaced by three money figures of one kind plus a facts list; "What is owed" moved to
  Payouts (a link); the funnel uses native progress bars (no inline style).
- **Finance (UI39, real screen):** not changed. The research's top band and obligations table belong there; adding them changes a real,
  tested screen and is left for a step with the owner's go-ahead.

## Seller console

- **Today (UI33, seller):** one framed next step by fixed rules (here: send the authorised message to Ostra by Oct 23), three equal money
  figures (next payment, earned not yet payable, paid in 2026), live claims by end date, "Waiting on Kauro" as lines, the access note. A
  candidate sees the real setup checklist; prospects, outreach and commissions open once active. Removed: "Prospects you work" count and
  "This month so far" (it mixed draft and held money).
- **Prospects (UI34):** four views (to work, claimed, won, closed); columns stage, claim as a date, next step, last activity; the opened
  prospect shows next step, claim sentence, source, fit, contact rule and history; "Add a prospect" answers at once (available / not
  available, never why / do not contact). The owner sees every seller's prospects by seller; claim decisions moved to Claims.
- **Outreach (UI54):** the contract's states only (DRAFT, AUTHORIZED, PROVIDER_ACCEPTED, SEND_UNCERTAIN, SUPPRESSED…); round 1's "In
  review / Changes requested / Rejected" removed (they do not exist). "Editing an authorised message removes its authorisation" above the
  letter. Owner: "Authorise this text"; "Send back with a note" removed (no contract).
- **Commissions (UI36):** "Next payment" sentence as the lead; the rules collapsed once; lines earned and not on a statement yet; each
  statement with its lines (basis, rate, earned, held, this statement), a line's calculation and milestone dates one click away, PDF and
  CSV (proposed), the payout sentence in the contract's words; "Ask about this line".
- **Resources (UI53):** "What you may say" first; resources by purpose (explain, answer, limits) with version and date; replaced versions
  at the foot, unusable.
- **Seller settings (P-03):** status, sign-in and security, payout destination (step-up, 48-hour check), tax documents, sending identity,
  notifications (always-sent versus optional).
- **Gaps:** `SellerHomeView` lacks claims with end dates, next eligible and next payment dates; no read of a won customer's first-payment
  and completion dates for the seller; no statement PDF/CSV; no notification preferences; no seller action to ask for authorisation (the
  owner reviews drafts in their own queue); outreach send is inert in this build.

## Questions the owner answered on 2026-10-21 (decisions below)

1. **Customers' revenue on the Sellers list** (research Q-2): "Collected" per seller is the commission base and names what customers paid.
   Keep it, or show commission only?
2. **"Not available to claim" never says why** (merges an existing customer, another seller's claim and an owner rule). Confirm with
   counsel, together with the fixed list of refusal reasons.
3. **Thresholds:** stalled project 14 days; seller reminders 3 and 14 days; "Needs you" window for pilot reviews 7 days. Keep?
4. **Retainer and offset** exist in the agreement contract. If never planned, the fields stay hidden everywhere (they are today).

## The owner's decisions of 2026-10-21, and what changed (branch `order11/r2-ops-decisions`)

The owner answered the four questions above on 2026-10-21 and approved the following. They are applied to the review prototypes,
fixtures and copy only; every functional change they need is recorded as F-11 to F-18 in `docs/design/ORDER11-FUNCTIONAL-GAPS.md`.

1. **Sellers: both figures, four categories, nothing counted twice.** Show what was actually collected from each seller's attributed
   customers and, beside it, the commissions: net attributable revenue (collections, not invoices; net of refunds; without tax, never
   Kauro's revenue), commission generated, commission pending, commission paid. One collection is never attributed twice.
   - *Sellers (P-21):* columns are now Net revenue, Commission generated (with any offset), Commission pending (now; with what is payable
     by Nov 17, held and waiting) and Commission paid; customers, claims and the retainer moved under the seller's name; definitions under
     the table. The period switch changes revenue, generated and paid; pending is always as of now.
   - *Seller (UI37):* the four figures carry the same names; money by state lists the offset and the retainer.
   - *Customers (P-23), customer (UI35), Operating review (UI44):* "Collected" became "Net revenue"; the refund is named on its project.
   - Supersedes question 1.
2. **"Not available to claim": approved, with a closed list.** The seller reads a neutral message and can ask for a review; the owner sees
   the internal reason, its evidence and the history. "Other" is the one documented exception and needs a written note. The legal
   validation of the contractual claim rules is pending.
   - *Claims (P-24):* the refusal form uses the closed list, shows what the seller will read before it is sent, and requires a note for
     Other; a refused claim shows its internal reason, evidence, the neutral message and the decisions (a review asked for and upheld);
     a table lists every reason with its seller message; "Pending legal review" beside the claim rules.
   - *Prospects (UI34), seller:* "Not available" says no reason and offers "Ask for a review".
   - *Settings (P-04):* "Pending legal review" beside the claim length and the tail.
   - Supersedes question 2.
3. **Deadlines and alerts: two controls, never one for the other.** Inactivity: 14 days without relevant progress. Deadlines: 2 days
   before, or at once when passed. Seller claims: 14 and 3 days before their end. Pilot: its review prepared 14 days before it ends (was
   7), changing no agreement. Three labelled kinds (blocked, deadline, inactive); each item once, under its most urgent kind (blocked >
   deadline passed > deadline within 2 days > inactivity), the rest as its second line.
   - *Today (UI33):* a new Alerts section (a blocked project with its inactivity as the second line; a file deletion in 2 days; an inactive
     upload); the stage table's column is "Inactive 14 days"; claim alert dates named. Seller Today names the 14 and 3 day alerts.
   - *Seller (UI37):* pilot reviews prepared from Dec 17 and Feb 2, 2027.
   - *Settings (P-04):* a new Alerts section, marked "Needs backend".
   - Supersedes question 3 (the 3-day claim reminder is kept beside the 14-day one; the 7-day pilot window became 14).
4. **Retainer and offset.** The retainer is USD 0.00 by default for new agreements; a signed agreement that sets one is respected, shown
   wherever the rates are and included in what is owed. Offsets after a refund are shown when they happen, on the statement, with their
   basis (refund, project, rule), amount and resulting balance, applied only under the agreement in force and the applicable rules.
   - *Fixtures:* Amara Okafor's signed agreement 2026-08 sets USD 150.00 a month from Sep 1, 2026 (September paid; October on the draft
     statement). Coastline Analytics received a USD 300.00 refund (RF-2026-0007, Oct 13) on "Accounts and contacts"; Daniel Kim's October
     statement carries a −30.00 offset under the agreement's net-of-refunds rule, its balance written out (129.50 − 30.00 = 99.50).
   - *Statements (UI36):* offset and retainer rows with their own detail; a balance line. *Payouts (P-22), Today, Sellers:* what is owed now
     includes the retainer (USD 319.00 by Nov 17) and says so. *Settings:* a Retainer column in "Rates by seller", and rows for the
     retainer default and offsets.
   - Supersedes question 4.

Earlier decisions changed by these: round 2's "Collected" as the seller money figure (now four named categories); round 2's "retainer
hidden while zero" (still hidden at zero, now shown and owed where an agreement sets it); round 1's 7-day pilot window.
