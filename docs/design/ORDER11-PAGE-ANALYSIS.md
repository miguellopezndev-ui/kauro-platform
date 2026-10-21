# Order 11: the ten questions, page by page

The owner's mandate asks, for every page: (1) who arrives and why; (2) what they must decide or do; (3) what information helps; (4) how
it is presented; (5) the next action; (6) exceptions and errors; (7) connections, from where and to where; (8) how it is better than the
conventional page; (9) what is extra and what is missing; (10) whether it reaches the quality of the approved public site.

Each answer describes the page as it stands in the review after its rework, from human inspection at 1280 and 375 px in both themes and
from the automated audit. Facts come from the code and the authority documents; research references are to
`Kauro-visual-delivery/order11/research`. Pages are grouped as in the review log. Groups are added as each is re-inspected.

## Group C. Quote, payment and billing

### UI23 Quote (real) `/projects/{id}/purchase`

1. **Who and why.** An owner, admin or billing member of the workspace, after the plan is approved, to see the exact price before paying.
2. **Decide or do.** Accept this quote's terms and create the payment order, or stop.
3. **Information.** The service; billable units; issue date and price list; base, discount (repeat or other), service, tax with its
   treatment, total; price and source-file expiry; what the quote covers (the approved plan, linked; the sealed files; preparing,
   checking and delivering) and what it does not (the import; for "Clean your data", outside data); the blockers; how payment works.
4. **Presentation.** One sheet down to the total, the dates under it; covers and exclusions side by side; terms, three steps and one
   button in a framed block at the foot.
5. **Next action.** Create payment order, then the Payment page.
6. **Exceptions.** Expired price or replaced quote: no payment control, a new quote is offered; expired files: re-upload; each blocker in
   words; the button's hint gives the one reason it is disabled; creating says not to repeat the step.
7. **Connections.** From Approval (UI22) and the project's Purchase area; to the approval it was issued from, the terms, Payment (UI24).
8. **Better than conventional.** It says what is excluded and why the tax is zero, and keeps estimate, quote and payment apart
   (decision 1.3); most quote pages show lines and a pay button only (research app-ui-patterns.md §7).
9. **Extra / missing.** Missing: a quote number a person can quote (the api's id is a UUID) and a PDF of the quote; neither is in the
   contract. Nothing extra.
10. **Public-site quality.** Yes: one typeface scale, quiet hierarchy, the total as the only display figure.

### UI24 Payment (real) `/payments/{orderId}`

1. **Who and why.** The person who created the payment order, or any billing member, to pay by bank transfer and follow its status.
2. **Decide or do.** Send one transfer with the exact amount and reference; later, check the status.
3. **Information.** Amount; the project it pays for (linked); status in words; bank details each with a copy button; send-by date with
   the booking-time rule; the matching rule (a different amount, reference or payer is reviewed and returned, ToS §8.3); ACH timing
   (PV1 §5); the order id for support, at the foot.
4. **Presentation.** The amount large, the status once, the details as a transfer slip with the amount and reference across it.
5. **Next action.** While waiting: send, then check again. Confirmed: start the preparation from the project (linked).
6. **Exceptions.** Pending or checking: do not pay again; expired details: do not send, request a new quote; details unavailable: check
   again or contact support; failed: new quote or support. A return from the bank or a screenshot is never payment.
7. **Connections.** From the Quote; to the project, the preparation (UI25), support (UI52), a new quote.
8. **Better than conventional.** Copy buttons on every value typed elsewhere, the two rules stated before sending, and the next step
   after "paid" (research app-ui-patterns.md §7.3; most bank-transfer pages stop at the details).
9. **Extra / missing.** Missing: the project's name (the order view carries only its id) and a downloadable payment instruction.
10. **Public-site quality.** Yes.

### UI30 Billing (real) `/billing?order={id}`

1. **Who and why.** An owner or billing member, to keep the papers of one order: payments, fiscal documents, refunds.
2. **Decide or do.** Read; download what is issued; request a refund when warranted.
3. **Information.** Order amount, state, project (linked), id; payments received with their split; fiscal documents with legal numbers;
   refunds; the refund terms (full before preparation, evaluated after, ToS §10) and the defect route (30 days, ToS §11).
4. **Presentation.** A ledger: the order head, then one list a kind of record; the refund request opens on a button.
5. **Next action.** Usually none; a refund request opens a billing case first.
6. **Exceptions.** No order in the address: the page says it shows one order at a time and leads to the projects; a member without
   billing rights is told to ask an owner; no confirmed payment, no refund control; an unissued document is never called an invoice.
7. **Connections.** From Payment and the menu; to the project, support.
8. **Better than conventional.** It never calls a summary an invoice and states the refund terms before the request.
9. **Extra / missing.** Missing: the list of all orders (P-09, gap F-10) and the billing profile (who is invoiced).
10. **Public-site quality.** Yes, with the overview still to come.

### P-09 Billing overview (proposed) `/billing`

1. **Who and why.** An owner or billing member opening Billing from the menu, to see what is due, open, paid or refunded.
2. **Decide or do.** Find what needs action (a transfer to send, a quote to accept) and open it.
3. **Information.** Totals by state, each with a count; one line a quote or order: project, client, service, state, amount, the date
   that matters, the fiscal document's number.
4. **Presentation.** Four figures, then a table; on a phone each line is a card.
5. **Next action.** Open the quote, the payment or the order's billing.
6. **Exceptions.** Nothing yet: says when the first quote appears and that the free check never does.
7. **Connections.** From the menu; to UI23, UI24, UI30.
8. **Better than conventional.** Quotes and orders together, with the date that matters for each state (after Mercury's summary).
9. **Extra / missing.** Needs a list read (F-10).
10. **Public-site quality.** Yes.

## Group D. Sales and sellers

### UI34 Prospects `/ops/sales/prospects`

1. **Who and why.** A seller, to work only qualified, permitted opportunities; the owner, to see every prospect and decide claims.
2. **Decide or do.** Seller: check fit, claim, prepare a reviewed message. Owner: accept or refuse a claim.
3. **Information.** Organisation, kind and place, lawful source and date, fit, claim and its term (90 days), state, next action; for the
   owner, each prospect's seller.
4. **Presentation.** A table, one prospect opened below it with its facts and its next action.
5. **Next action.** Prepare a message (UI54) or claim; for the owner, the claim decision.
6. **Exceptions.** Suppressed: no contact on any channel, stated in a banner; researched: fit before any message; a conflicting claim is
   shown to the owner only.
7. **Connections.** From the ops menu; to Outreach (UI54).
8. **Better than conventional.** Suppression blocks action rather than flagging it, and claims are a decision with a term (research
   §5.1, PartnerStack, Apollo).
9. **Extra / missing.** Missing: a contact-basis column, which needs the owner's and counsel's values (research proposal 5.4).
10. **Public-site quality.** Yes.

### UI35 Agency relationship `/ops/sales/agencies/{id}`

1. **Who and why.** The owner, to see who serves an agency and who acquired it, and to reassign service.
2. **Decide or do.** Reassign who serves; never who acquired.
3. **Information.** Who serves; who acquired, with the claim, the first project's rate and capture, the repeat window; the history.
4. **Presentation.** Two cards side by side, then a dated history.
5. **Next action.** Prepare a reassignment.
6. **Exceptions.** A reassignment keeps the acquisition terms and tells the seller in writing.
7. **Connections.** From the owner's Commissions; to the seller (UI37).
8. **Better than conventional.** Service and acquisition are kept apart, so a reassignment never moves money.
9. **Extra / missing.** Missing: a list of agencies to reach the others (one relationship is drawn).
10. **Public-site quality.** Yes.

### UI36 Commissions `/ops/sales/statements`

1. **Who and why.** A seller, to understand what was earned, held and paid; the owner, to see a seller's statements.
2. **Decide or do.** Read; ask about a line.
3. **Information.** The rules (10% first, 4% repeats for 12 months, basis after discount and refunds without tax, payable 30 days after
   completion, issued on the 5th and paid on the 10th business day); per month the payable, held and paid figures, and the lines.
4. **Presentation.** The rules once, then one card a month with its sums and lines.
5. **Next action.** Ask about this line (per row), for an issued statement.
6. **Exceptions.** A draft changes until issued; a transfer sent is not paid until the bank confirms; a held line says when.
7. **Connections.** From the menu; for the owner, to the seller (UI37) and the agency (UI35).
8. **Better than conventional.** "Paid" only with the bank's proof; questions start from the line (Impact, HubSpot).
9. **Extra / missing.** Missing: a PDF or CSV of a statement (research proposal 5.1), not in the contract.
10. **Public-site quality.** Yes.

### UI37 Seller lifecycle `/ops/sales/sellers/{id}`

1. **Who and why.** The owner, to track a seller's engagement from assessment to pilot review.
2. **Decide or do.** Schedule the pilot review; prepare an amendment, training or a termination.
3. **Information.** Each stage with its date and evidence.
4. **Presentation.** A checklist of stages, the current one framed; the actions below.
5. **Next action.** Schedule the pilot review.
6. **Exceptions.** Termination is prepared, never immediate.
7. **Connections.** From Commissions and the relationship.
8. **Better than conventional.** Every stage carries its proof.
9. **Extra / missing.** Missing: a list of sellers.
10. **Public-site quality.** Yes.

### P-03 Seller settings (proposed) `/ops/settings`

1. **Who and why.** A seller, to see their account, security, payout destination and sending identity.
2. **Decide or do.** Change the payout destination (with step-up); choose notices.
3. **Information.** State and agreement; two-step verification; masked payout account and its verification; sending identity.
4. **Presentation.** Sections with labels on the left, facts on the right.
5. **Next action.** Usually none.
6. **Exceptions.** Payout change asks for the code again; a pending sending identity blocks outreach; a suspended seller is told why.
7. **Connections.** From the account menu; to Outreach.
8. **Better than conventional.** The full account number is never kept or shown.
9. **Extra / missing.** Needs a profile read and a notices contract (D-P03-1, D-P03-2).
10. **Public-site quality.** Yes.

### UI53 Seller resources `/ops/sales/resources`

1. **Who and why.** A seller, to use only the current approved offer.
2. **Decide or do.** Open a resource; use the worked example in a message.
3. **Information.** Each resource's purpose, version, date, language; what may be said about price; superseded versions and why.
4. **Presentation.** Cards, then the price rules, then superseded cards greyed.
5. **Next action.** Use it in a message.
6. **Exceptions.** A superseded version cannot be used in a new message.
7. **Connections.** To Outreach; from Outreach's content line.
8. **Better than conventional.** Superseded material stays visible but blocked (Showpad), so links do not silently break.
9. **Extra / missing.** Missing: an expiry date on each card (research proposal 5.6), if the owner sets one.
10. **Public-site quality.** Yes.

### UI54 Reviewed correspondence `/ops/sales/outreach`

1. **Who and why.** A seller, to prepare a message that goes out only after review; the owner, to review it.
2. **Decide or do.** Seller: submit; owner: authorise or refuse.
3. **Information.** To, from (verified), why it may be sent, suppression check with its time, the resource quoted, the message.
4. **Presentation.** The facts above the letter, the letter as it will be read.
5. **Next action.** Wait for review; then it is sent from the verified identity.
6. **Exceptions.** Suppressed: cannot be authorised or sent; send uncertain: no resend until known.
7. **Connections.** From Prospects and Resources.
8. **Better than conventional.** The lawful reason is stated on the message itself.
9. **Extra / missing.** Nothing missing for the review: an authorised message says that editing it sends it back for review (research proposal 5.5).
10. **Public-site quality.** Yes.
