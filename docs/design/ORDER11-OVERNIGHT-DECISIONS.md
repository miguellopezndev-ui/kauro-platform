# Order 11: decisions taken overnight (2026-10-20 21:14 to 2026-10-21 05:45)

The owner was unavailable and asked for no questions: every choice below was made here, from the research and the code, choosing the best
option rather than the most common one. Each states what was decided, why, and what it would take to reverse it. Nothing here touches the
backend, a contract, money logic or a versioned legal text; where a better design needs the backend, it is drawn as a proposal and listed
as a functional gap.

Sources: research in `Kauro-visual-delivery/order11/research` (app-ui-patterns.md §7 payments and billing; kauro-baseline.md §4.6 to §4.7,
which cites ToS §8 to §11 and PV1 §5), and the api's own views (`apps/web/src/api/generated.ts`).

## Group B

| # | Decision | Why | To reverse |
| --- | --- | --- | --- |
| N-01 | One date format in the application: the design system's ("Oct 20, 2026, 1:00 PM UTC"). | The real screens already used it through `formatDeadline`; the prototypes did not, so one quote read two ways. Aligning prototypes to the product changes no real screen. | Change `formatDeadline` and `kit.tsx` together. |
| N-02 | On a phone, the duplicates comparison becomes one labelled card a field. | A side-scrolling table hid the second record and could not be reached by keyboard (WCAG 2.1.1, axe). Cards keep every value visible; the same pattern already serves Fields. | Restore the 34rem table. |

## Group C

| # | Decision | Why | To reverse |
| --- | --- | --- | --- |
| N-03 | The quote says what it covers (approved plan, sealed files, delivery) and what it does not (the import; for "Clean your data", outside data). | The registry asks the quote to show scope; only the units were shown. Every line comes from ToS §3.5 and §9.2. | Remove the section. |
| N-04 | A discount the server sends with a basis other than REPEAT reads "Discount (N%)", never "Founding discount". | The quote said "No discount applies" while charging less: untrue. D-COPY-1 keeps the founding line hidden until B10, so the neutral word is the only true one allowed. | When B10 opens founding slots, name it. |
| N-05 | The tax line shows its treatment ("Exempt: export of services") when it is not domestic. | The quote has `taxTreatment`; a USD 0.00 tax with no reason invites the question. | Remove the note. |
| N-06 | Copy buttons on the transfer's amount, reference, beneficiary, routing and account numbers; kept in the app, not the design system. | A wrong reference delays matching, and the research recommends a copy button on every bank detail (app-ui-patterns.md §7.3). One screen uses it, so it stays local until a second one needs it. | Delete `shared/copy-value.tsx`. |
| N-07 | The payment page states the matching rule, the booking-time rule and Wise's ACH timing ("within hours, up to 4 business days"). | ToS §8.2, §8.3 and PV1 §5 say these; the person needs them before sending, not after a problem. The wire timing is left out: the quote names ACH only. | Remove the list. |
| N-08 | A confirmed payment says the next step: the team starts the preparation, with a link. | Preparation is started by the team (CMD036), not automatically; the page ended at "paid" with nowhere to go. | Remove the block. |
| N-09 | The order's id moves from beside the amount to the foot of the page, and the page links to its project. | A 36-character id beside the amount read as the reference to type into the bank; the real reference is the payment reference. | Restore the head row. |
| N-10 | Billing's refund request opens on a button, after the refund terms (ToS §10) and the defect route (ToS §11); its fields use the design system's Field. | A refund is rare and deliberate; an open form on every visit invited misuse and the bare inputs had no styling or error wiring. | Render the form open. |
| N-11 | Billing without an order says it shows one order at a time and links to the projects; the full overview is drawn as P-09 with gap F-10. | The menu link led to a dead end. A list needs a read the api lacks, so the real page gets an honest way forward and the overview is a proposal. | — |
| N-12 | P-09 shows only lines that agree with the pages they open (no discount a linked quote does not show). | Older paid or refunded rows would have implied a repeat discount the review's quotes contradict. | Add rows with matching fixtures. |

## Group D

| # | Decision | Why | To reverse |
| --- | --- | --- | --- |
| N-13 | The agency relationship (UI35) and the seller's page (UI37) get ways in: the owner's Commissions names whose statements they are and links the seller; an agency on a statement links its relationship; the relationship links the seller. | No page linked to either, so the owner could not reach them by navigating. Links from where the names already appear add no menu items; a "Sellers" list would need a registry screen. | Remove the links. |
| N-14 | Seen by the owner, Prospects shows each prospect's seller and turns a submitted claim into a decision (accept, or refuse with a reason); the owner has no "Claim this prospect". | The owner decides claims and does not make them (research app-operations-ux.md §5.1, PartnerStack); the owner's view was the seller's. | Draw one view for both. |
| N-15 | A line of a commission statement is asked about from its own row; the form names the line. | Impact's action inquiry and HubSpot's dispute by ticket both start from the line; a free text "which line" invited mistakes. | Restore one page-level button. |
| N-16 | The commission rules state when statements are issued and paid: the 5th and 10th business days of the next month, Bogotá calendar. | A verified policy fact the seller needs to plan; the dates on the page (Nov 9, Oct 15) already follow it. | Remove the sentence. |
| N-17 | Commission figures follow the price list: a first project's basis is a list price; a repeat's basis is after its 5% discount. | The page says the basis is the service collected after discount; USD 2,450.00 is on no list, and a repeat showed the undiscounted price. | — |
| N-18 | The draft blocked by suppression is its own first message, dated before the request not to be contacted; the reply to the Salesforce consultancy says what its package would be. | The blocked state reused another agency's reply; a reply about HubSpot only, sent to a Salesforce consultancy, misled. | — |

## Group E

| # | Decision | Why | To reverse |
| --- | --- | --- | --- |
| N-19 | Owner settings (P-04) keep stating what is true today for the identity provider and the cloud, and say that the review simulates sign-in; email sending reads the same sending identities as Outreach. | The page is about real readiness (W-IDP-LIVE, A9 not opened), but "not configured" email contradicted the verified identity and the accepted messages elsewhere in the review. | — |
| N-20 | A copy button only beside a value the owner types (the domain), not beside values to check ("Leave off"). | Copying "Leave off" is meaningless and dilutes the buttons that matter. | Restore one per row. |
| N-21 | The prepared-action example "quarterly sales tax return, due Jan 15" becomes "the next tax return", whose date and steps come from the company's accountant. | The obligation and its date were invented; Kauro's sellers and payouts run on the Bogotá calendar, and a US-style return is not a known fact. | When the accountant records the real obligation, name it. |
| N-22 | Operating review states no tax amount or filing date: the period's invoices and credit notes are ready for the accountant. | "Filed in January … not zero" had no source and contradicted the quotes' export exemption. | — |
| N-23 | Finance on a phone: each credit is a labelled card. | The six-column table squeezed words to one letter a line at 320 to 375 px. | — |
| N-24 | The review refuses finance reads to anyone but the owner, as the server does; the page then shows one refusal and no credit queue. | A seller saw the bank route with "Disable the route" and "Replace the bank details" because the review answered every person alike; the real page then drew the refusal twice beside an unusable filter. | — |
| N-25 | The audit now flags text squeezed letter by letter (a box under 48 px wide, more than three lines tall). | The Finance defect passed every automated check: nothing overflowed and nothing was cut. Human inspection found it; the check keeps it from coming back. | Remove the check. |
