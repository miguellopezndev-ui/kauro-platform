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
| N-40 | Incidents with none open: the closed incident links its affected jobs ("See the jobs"). | The page offered no action, and the keyboard check found nothing to reach in its main area; the jobs are where the delayed checks can be seen. | Remove the link. |
| N-41 | Fields (UI19) are cards until the four columns fit beside the menu (under 72rem); the table from 1152 px. | At 768 px the change column was squeezed; at 1024 px a column was pushed out of sight inside the table's frame. The cards already served phones; a table that hides a column is worse than cards. | Restore the 48rem breakpoint. |
| N-42 | The audits now also flag a sentence poured into a narrow strip, text with links included, and content hidden in an inner sideways scroll. | Each escaped the earlier checks and was found by eye (the contact authorisation, Fields at 1024 px); the checks keep them from returning. | — |

## Across groups

| # | Decision | Why | To reverse |
| --- | --- | --- | --- |
| N-26 | A page apart from the stages (Activity, Data and deletion) names itself in the project header and says where the project stands ("Data and deletion · the project is at step 6 of 6, Import"). | It read "Step 6 of 6 · Import", passing for a step, against the owner's decision that these areas are reachable and never steps. | Drop the area line. |
| N-27 | Support shows its times in UTC, like every deadline of the application, and states the hours in both zones (09:00 to 17:00 Bogotá, 14:00 to 22:00 UTC). | It was the only page in Bogotá time, and it never said what "covered support hours" were; the review's case was due at 6:00 Bogotá, outside them. | Restore America/Bogota in the view and its test. |
| N-28 | The email code is "a code", not "a six-digit code"; the authenticator code stays six digits. | Six digits is the authenticator standard (RFC 6238); an email code's form belongs to the identity provider, not chosen yet. | — |

## Public-site proposals (variants beside the approved site)

| # | Decision | Why | To reverse |
| --- | --- | --- | --- |
| N-29 | Public proposals live at /__variants/..., served by the review app in the public site's own frame and stylesheet, under a ribbon that links the approved page; the edge forwards /__variants to the review, and the guard test lists it. | The owner keeps the Order 10 site as the reference and wants proposals reviewable beside it, never in main; the application's bundle may not carry review routes. | Delete tools/review/private/app/%5F_variants and variants/; remove the prefix. |
| N-30 | Supported services, "Availability now": three upright cards of equal width, read in one order (name and state, one line, the piece of the product, who it is for, what you receive, the limit, the publication), restored from 3b317427. | Its purpose is to answer "which service can I buy now, and is it mine" at once. The approved page and the earlier A10 versions spread the three services over wide sections, so they cannot be compared; side by side they can. The A10 spreads were not better. | Keep the approved page. |
| N-31 | The variant uses the owner's names (Clean your data, Prepare for HubSpot, Prepare for Salesforce), each with one line; Clean's line says nothing is added from outside sources. | Owner's answer 3: names everywhere, a short explanation each, never implying enrichment, irreversible deletion or CRM compatibility. | — |
| N-32 | A footer that lists every public page in five columns (Kauro, Trust, Help, Account, Legal), no year or legal entity until confirmed. | NN/g: contact and support belong in the footer; a site of about 25 pages can list them all; Kauro has 12. Research public-site-ia.md §14.3, kept to pages that exist. | Keep the four links. |
| N-33 | A header with the pages in one line from 62rem, no "Home", Help as a utility and one filled button, "Check a file free"; the menu stays below 62rem. | Research: 4 to 7 visible items in the sample, Pricing at the top level, one page for agencies; the approved header hides every page in a menu at every width. | Keep the approved menu. |
| N-34 | A "Check a file free" page: what it takes (four steps), who it is for, what happens to the files (deleted 7 days after the check, at most 14 after sealing; no payment details; capacity may make checks wait), then Create an account, Sign in, or Ask a question. | Owner's answer 7, every statement from the approved site or the policy. It changes A3 §3.2 (F-03), so it waits for the owner's decision. | — |
| N-35 | A "For agencies" page with only the statements and limits of the owner's answer 8; branded reports are shown as "not available yet". | Agencies are the main channel (A3) and had no page; the owner set what may be said and asked that branding be verified before it is published as working. | — |
| N-36 | The variant pages have their own audit (same checks, 30 cases); the header was tightened under 360 px after it overflowed at 320. | Automated checks cover what a person cannot repeat at every width; the eye covered the layout. | — |
| N-37 | Pricing variant: the approved page word for word, plus "What the price includes" (ToS §7.6, without branding while it is unavailable) and "Not included" (ToS §3.5), and ten questions answered only from existing rules. | The research found no FAQ on the page and buyers' top questions answered elsewhere or not at all; every answer is sourced (ToS §6.2, §7.1, §7.3, §7.5, §8.1, §10, §11; Annex A). "Do duplicates count?" says yes and gives no reason, because the reason is not a written rule. | Keep the approved page. |
| N-38 | Contact variant: the required, unticked authorisation (Data Processing Policy §8.1, manual A-01) and "Email address" instead of "Work email". | A legal rule in force that the approved form misses (F-08); sign-up is open to any address. The Policy's page does not exist yet, so its link fails until it is published. | — |
| N-39 | Inside the proposed site, links go to a page's variant where one exists (Supported services, Pricing, Contact) and to the approved page elsewhere. | So the proposed site can be walked as one site, beside the approved one. | — |

## Independent review (02:10)

A separate reviewer read the night's changes to the real screens (apps/web) and reported nine defects; each was checked against the code
and the terms, and all nine were fixed.

| # | Decision | Why | To reverse |
| --- | --- | --- | --- |
| N-43 | "Go to the preparation" carries the paid order (?order=), and the payment page links its own billing ("This order's billing"). | Without the order the preparation page said nothing was being processed; nothing linked an order's billing, so Billing's empty state promised a route that did not exist. | — |
| N-44 | Under a disabled pay button: "Accept the terms to continue." only when that is what is missing; otherwise "Payment is not available for this quote right now." | "Resolve what is listed" invited a second payment when the blocker was a payment already made or in progress (ToS §8.2.7), and a closed gate with no listed blocker asked for a box that was disabled. | — |
| N-45 | "Send by" says what counts is the credit in Kauro's account, not the sending (ToS §8.2.3). | The first wording ("when your bank books the transfer") could be read as the debit, which the terms say does not count. | — |
| N-46 | Refund form: an invalid field takes focus; the opened form's heading takes focus; the toggle drops an aria-expanded it could never update; another order closes the form. | The design system's field errors are not live regions, and the button that opened the form disappeared under the keyboard. | — |
| N-47 | Finance's refusal follows the read both ways and starts again with another route; a second copy press is announced and keeps its message. | Both states stuck after their first value. The copy counter numbers presses, since the project keeps the browser clock in one place (K0). | — |
| N-48 | Support hours say "except holidays" (ToS §12.1); the project header maps a step a service does not have (import, for "Clean your data") to its last step. | The hours omitted the holiday exclusion; the header could claim "step 1 of 5" for a delivered CLEAN project. | — |

## Fact-check of the prototypes and variants (02:40)

A second reviewer checked every rule, period, price, limit and promise in the prototypes and the variants against the terms, the policy
and the code; fifteen were unsupported or contradicted, and all fifteen were corrected.

| # | Decision | Why | To reverse |
| --- | --- | --- | --- |
| N-49 | No time is promised for setup or enrolment ("About a minute", "This takes a minute" removed). | No source; A3 §3.6 forbids promising fixed short times. | — |
| N-50 | Payment lets the team start the preparation; it does not start it. | CMD036 is started by the team on a paid order. | — |
| N-51 | Every member sees Billing; only owners and billing members act on it. | The reads need only a reader role (response-schemas.ts); P-09 said otherwise. | — |
| N-52 | Removed: a 15-day seller notice period, "Kauro never contacts your prospect", "checks run every minute", "anyone can stop a recovery", a one-approval code, "4 vCPU, 2 hours", an "introductory discount" in the history. | None has a source; some contradict one (D-33 §1.1 and §4.2; CMD056; the 900-second step-up; policy capacity 8 GiB and 8 hours; ToS §7.3). Each now says what the sources support. | — |
| N-53 | Billing details are asked "before your first quote is issued"; commission is on "a customer's" first project; support cases are due inside support hours; Owner settings says its values come from the registry and the security settings. | The quote requires a billing profile (CMD027); companies earn commission too (D-33 §3.1); ToS §12.1; the session and confirmation times are not in the registry. | — |
