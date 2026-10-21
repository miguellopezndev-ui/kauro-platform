# Order 11: the ten questions, page by page

The owner's mandate asks, for every page: (1) who arrives and why; (2) what they must decide or do; (3) what information helps; (4) how
it is presented; (5) the next action; (6) exceptions and errors; (7) connections, from where and to where; (8) how it is better than the
conventional page; (9) what is extra and what is missing; (10) whether it reaches the quality of the approved public site.

Each answer describes the page as it stands in the review after its rework, from human inspection at 1280 and 375 px in both themes and
from the automated audit. Facts come from the code and the authority documents; research references are to
`Kauro-visual-delivery/order11/research`. Pages are grouped as in the review log; closely linked pages of one task (the plan's parts,
the import's steps and results) share an entry. Every private page and proposal of the review is covered.

## Group A. Access, identity, organisation and settings

### UI50 Sign in (prototype) `/login`

1. **Who and why.** Anyone with a Kauro account, to reach their workspaces.
2. **Decide or do.** Continue with Google, or enter email and password; then Kauro's code from an authenticator app.
3. **Information.** The two ways in; that a code follows either; the step (1 of 2); links to reset a password and to create an account.
4. **Presentation.** One card with a dark bar naming the page and the step; the footer with privacy, terms, help, status.
5. **Next action.** Sign in, then the code.
6. **Exceptions.** Wrong details (GOV.UK error summary, the field's own words); a lost authenticator (recovery code; Kauro-led recovery
   with checks and a waiting period; recovery impossible, with the alternatives); never SMS, never security questions.
7. **Connections.** From the public site; to the workspaces (UI10), reset (P-06), create an account (P-05).
8. **Better than conventional.** Kauro's own code is always asked, even after Google; recovery is differentiated by risk (owner's answer 5).
9. **Extra / missing.** Needs the identity provider (F-07, W-IDP-LIVE).
10. **Public-site quality.** Yes.

### UI51 Invitation `/invitations/{id}`

1. **Who and why.** A person invited to a workspace, to accept with the right account.
2. **Decide or do.** Accept, or say it is not for them.
3. **Information.** Who invited them, to which workspace, with which role and what it allows; the expiry (7 days).
4. **Presentation.** One card; the role's scope in words.
5. **Next action.** Accept and continue to the workspace.
6. **Exceptions.** Expired, revoked, already used, or signed in as another address: each says what to do.
7. **Connections.** From the email; to sign-in or the workspace.
8. **Better than conventional.** An email address never adds anyone on its own; the role is explained before accepting.
9. **Extra / missing.** Nothing missing.
10. **Public-site quality.** Yes.

### UI09 Set up your agency or company `/onboarding`

1. **Who and why.** A new account with a verified email and two-step verification, before any real file.
2. **Decide or do.** Say who buys (agency or company), name it, confirm the files' nature, accept the terms with authority.
3. **Information.** Same prices either way; business use only; what files Kauro takes and what they must not hold; the data processing
   authority for agencies; both documents with their versions.
4. **Presentation.** Four numbered parts, unticked boxes, one button; billing details explicitly later.
5. **Next action.** Create the workspace.
6. **Exceptions.** Out of scope (sensitive data, consumers): the page says Kauro is not for it; a workspace already in setup is resumed.
7. **Connections.** From sign-up; to the workspace's projects.
8. **Better than conventional.** About a minute; no billing form before money is involved (decision D-UI09-2, proposed).
9. **Extra / missing.** Moving billing details to the first quote needs a contract change (D-UI09-2).
10. **Public-site quality.** Yes.

### UI10 Your workspaces `/agencies`

1. **Who and why.** A person in more than one workspace, to choose where to work.
2. **Decide or do.** Open a workspace, or finish one in setup.
3. **Information.** Each workspace's name, the person's role and what it allows, its state; where they are now.
4. **Presentation.** One row a workspace, the current one framed.
5. **Next action.** Open.
6. **Exceptions.** Suspended access: who can restore it; restricted workspace; one in setup at a time.
7. **Connections.** From sign-in and the shell's "Switch workspace".
8. **Better than conventional.** The role is said in plain words beside each workspace.
9. **Extra / missing.** Nothing missing.
10. **Public-site quality.** Yes.

### UI31 Team `/agencies/{id}/team`

1. **Who and why.** An owner or admin, to see who has access and with what role; any member, to see their own access.
2. **Decide or do.** Invite, change a role, revoke, start a member's recovery.
3. **Information.** Each person's role, scope, two-step state and last activity; invitations pending with their expiry.
4. **Presentation.** A table; on a phone, cards; the person's own row says "Your access".
5. **Next action.** Invite a person.
6. **Exceptions.** An admin may only start a recovery, never disable two-step verification or grant access; the last owner cannot be removed.
7. **Connections.** From the menu; to invitations (UI51).
8. **Better than conventional.** Recovery is started here but decided by checks, notices and a waiting period (owner's answer 5).
9. **Extra / missing.** Recovery commands need contracts (F-07).
10. **Public-site quality.** Yes.

### UI32 Settings `/agencies/{id}/settings`

1. **Who and why.** An owner, to see the workspace's identity, agreements and closure.
2. **Decide or do.** Rename; read accepted terms; close the workspace.
3. **Information.** Name, kind, state; the terms and data processing versions accepted, with their dates; closure and what it deletes.
4. **Presentation.** Sections, labels left and facts right.
5. **Next action.** Usually none.
6. **Exceptions.** Closure asks for confirmation and states what remains (financial records).
7. **Connections.** From the menu; the organisation proposal P-02 beside it.
8. **Better than conventional.** Versions are shown as people read them ("Version 2026-10"), not as codes.
9. **Extra / missing.** Branding and notices (P-02) need contracts.
10. **Public-site quality.** Yes.

### P-01 Personal settings (proposed) `/account`

1. **Who and why.** Every person, for their own account in every workspace.
2. **Decide or do.** Theme; password; authenticator; recovery codes; sign out other sessions; notices.
3. **Information.** Name and address as the identity provider holds them; two-step state; sessions with their places; session limits.
4. **Presentation.** Sections, one proposal note for what needs contracts.
5. **Next action.** Usually none.
6. **Exceptions.** Every sensitive change asks for the code again; no secret is ever shown.
7. **Connections.** From the account menu.
8. **Better than conventional.** "Sign out all other sessions" in one place.
9. **Extra / missing.** Needs identity provider reads and commands (D-P01-4).
10. **Public-site quality.** Yes.

### P-02 Organisation (proposed) `/agencies/{id}/settings`

1. **Who and why.** An agency owner, to set what clients see (name and logo on reports) and workspace-wide rules.
2. **Decide or do.** Upload a logo; choose notices.
3. **Information.** The branding available for future reports, never altering evidence or hiding Kauro's legal identity.
4. **Presentation.** Sections beside UI32's.
5. **Next action.** Save.
6. **Exceptions.** Branding applies only to future reports (owner's answer 8c).
7. **Connections.** From Settings.
8. **Better than conventional.** States what branding can never change.
9. **Extra / missing.** Needs a branding contract.
10. **Public-site quality.** Yes.

### P-05 Create an account (proposed) `/signup`

1. **Who and why.** A newcomer, from "Check a file free" or the site's sign-up, with any email, including personal Gmail.
2. **Decide or do.** Google, or name, email and a password of at least 12 characters; consent to the data processing policy (required,
   unticked) and to news (optional); verify the email; set up the authenticator; keep recovery codes.
3. **Information.** Each step's purpose; the password rule (12 characters, checked against breached passwords, no composition rules).
4. **Presentation.** The same card as sign-in, the step in its bar.
5. **Next action.** Set up the workspace (UI09).
6. **Exceptions.** A breached password; an address that already has an account (the email says to sign in, the page does not tell).
7. **Connections.** From the public site and sign-in.
8. **Better than conventional.** It never reveals whether an address has an account.
9. **Extra / missing.** Needs the identity provider (F-07); the data processing policy needs a public page (F-08).
10. **Public-site quality.** Yes.

### P-06 Reset password (proposed) `/login/reset`

1. **Who and why.** A person who forgot their password.
2. **Decide or do.** Enter the email; enter the code sent to it; enter Kauro's code; choose a new password.
3. **Information.** That a reset never changes two-step verification; that Google accounts sign in with Google.
4. **Presentation.** The sign-in card, one field at a time.
5. **Next action.** Back to sign in.
6. **Exceptions.** Pauses after repeated requests; never says whether an address has an account.
7. **Connections.** From sign-in.
8. **Better than conventional.** The reset asks for Kauro's code too, so an email alone never takes over an account.
9. **Extra / missing.** Needs the identity provider.
10. **Public-site quality.** Yes.

## Group B. Clients, projects and the service

### UI11 Projects `/agencies/{id}/projects`

1. **Who and why.** Every member, to see the workspace's projects and who each waits on.
2. **Decide or do.** Open a project; start a new one.
3. **Information.** Each project's name, client, service, stage and who it waits for (by name and role); counts per stage.
4. **Presentation.** A board by stage; a filter; the services named "Clean your data", "Prepare for HubSpot", "Prepare for Salesforce".
5. **Next action.** Open the project that waits on the person.
6. **Exceptions.** First run: "Start your first project"; a company has no clients column.
7. **Connections.** To each project's Overview (UI13); to New project.
8. **Better than conventional.** "Waiting for Samuel Osei (approver)" instead of a status colour.
9. **Extra / missing.** The repeat-discount progress line needs a read (D-UI11-1).
10. **Public-site quality.** Yes.

### UI12 Clients `/agencies/{id}/clients` (agencies only)

1. **Who and why.** An agency owner or admin, to keep each end client's work separate.
2. **Decide or do.** Add a client; open its projects; archive it.
3. **Information.** Each client's open and delivered projects, since when, and its processing authority reference.
4. **Presentation.** One card a client; archived clients folded.
5. **Next action.** Add a client.
6. **Exceptions.** An archived client takes no new project.
7. **Connections.** To the client's projects.
8. **Better than conventional.** The processing authority is on the client, where an auditor looks for it.
9. **Extra / missing.** Nothing missing.
10. **Public-site quality.** Yes.

### UI13 Overview (prototype) `/projects/{id}`

1. **Who and why.** Every member, on opening a project: where it stands and what comes next.
2. **Decide or do.** Do the next step, or see who it waits on.
3. **Information.** The next step with who and when; blockers; the project's facts; recent activity.
4. **Presentation.** The project header, one framed next step, blockers, facts, five recent events with a link to all activity.
5. **Next action.** The framed step.
6. **Exceptions.** Each stage has its own next step; a blocker says who removes it.
7. **Connections.** To every area of the project; to Activity (P-08).
8. **Better than conventional.** It answers "what now, and who" before anything else.
9. **Extra / missing.** Recent activity needs a read (F-06).
10. **Public-site quality.** Yes.

### UI14 Files `/projects/{id}/sources`

1. **Who and why.** An operator, to upload the exported files.
2. **Decide or do.** Upload CSV or XLSX files; remove one before sealing.
3. **Information.** Accepted formats and limits (50 files a set, 2 GB a file, 5 GB a set); for each file, what this browser sent, what
   the storage received byte for byte, its security scan and its structure check.
4. **Presentation.** A drop zone, then one row a file.
5. **Next action.** Continue to the selection.
6. **Exceptions.** A file too large or of the wrong kind says so with its limit; an upload can be cancelled.
7. **Connections.** To Selection (UI15).
8. **Better than conventional.** It proves receipt (bytes sent against bytes stored) and scans every part before the file is used.
9. **Extra / missing.** Nothing missing.
10. **Public-site quality.** Yes.

### UI15 Selection `/projects/{id}/sources/selection`

1. **Who and why.** An operator, to confirm which tables of the files the project includes.
2. **Decide or do.** Include or exclude each table, with a reason for an exclusion.
3. **Information.** Each file's tables with columns, approximate rows, hidden rows and columns, merged cells, formulas.
4. **Presentation.** One card a table, its columns as chips; flags for hidden sheets and formulas.
5. **Next action.** Confirm this selection.
6. **Exceptions.** A hidden sheet or missing formula values are flagged; an excluded table needs a visible reason.
7. **Connections.** From Files; to Seal (UI16).
8. **Better than conventional.** It surfaces hidden sheets and duplicate column names before anything is counted.
9. **Extra / missing.** Nothing missing.
10. **Public-site quality.** Yes.

### UI16 Seal `/projects/{id}/sources/seal`

1. **Who and why.** An operator, to fix the exact set the project works on.
2. **Decide or do.** Seal the set.
3. **Information.** Physical rows, billable source units and association edges; the tables included and left out with their reasons;
   until when the files stay; that sealing fixes the set and starts nothing to pay for.
4. **Presentation.** A summary and one button.
5. **Next action.** Seal, then the free health check.
6. **Exceptions.** A changed file after sealing needs a new set.
7. **Connections.** From Selection; to the health check (UI18).
8. **Better than conventional.** The units that set the price are counted before any price is shown.
9. **Extra / missing.** Nothing missing.
10. **Public-site quality.** Yes.

### UI17 Destination (prototype; CRM services only) `/projects/{id}/target`

1. **Who and why.** An operator, to describe the HubSpot account or Salesforce org the files will go into.
2. **Decide or do.** Upload the settings export; confirm them.
3. **Information.** The account or org id, when the settings were read, what Kauro needs (and never: no password, no key).
4. **Presentation.** Facts and one confirmation.
5. **Next action.** Confirm the settings.
6. **Exceptions.** Settings older than the plan's checks: read again; "Clean your data" has no destination and says so.
7. **Connections.** From Files; to Fields (UI19).
8. **Better than conventional.** No CRM access at any point.
9. **Extra / missing.** F-01: the backend asks CLEAN for a destination contract it should not need.
10. **Public-site quality.** Yes.

### UI18 Health check `/projects/{id}/audit`

1. **Who and why.** Every member, to follow the free check of the sealed set.
2. **Decide or do.** Wait; then read the results.
3. **Information.** Progress by phase, rows read, the time by which it is ready at the latest.
4. **Presentation.** Phases with their states; no percentage.
5. **Next action.** See the results (P-07).
6. **Exceptions.** A failed check is retried or explained; the free check never asks for payment.
7. **Connections.** From Seal; to the results.
8. **Better than conventional.** No fake progress bar.
9. **Extra / missing.** The findings read (F-04) for P-07.
10. **Public-site quality.** Yes.

### P-07 Health check results (proposed)

1. **Who and why.** Every member, when the check is ready: what was found, and what fixing it involves.
2. **Decide or do.** Review the plan, or leave without buying.
3. **Information.** One sentence; four findings with count, population, examples, consequence and fix; an estimate with what sets it and
   what may change; estimate, quote and payment kept apart.
4. **Presentation.** Verdict, findings, then the offer.
5. **Next action.** Review the plan.
6. **Exceptions.** Kept without buying: the date the results go.
7. **Connections.** From UI18; to Fields, Duplicates, Links, Destination.
8. **Better than conventional.** The price comes after the findings; a candidate group is never called a duplicate.
9. **Extra / missing.** Needs F-04 and F-05.
10. **Public-site quality.** Yes.

### UI19 Fields, UI20 Duplicates, UI21 Links between records (prototypes) `/projects/{id}/plan/...`

1. **Who and why.** An operator, to prepare the plan part by part; an approver, to review it.
2. **Decide or do.** Map each column (or, for "Clean your data", choose what it becomes); decide each duplicate group; decide links.
3. **Information.** Columns with samples, targets and what changes; groups with why they were grouped, field by field, and the unified
   record; link counts and contacts without a company.
4. **Presentation.** Four-part task list at the top; a table for fields; one group at a time for duplicates (cards on a phone).
5. **Next action.** Validate, then continue to the next part.
6. **Exceptions.** Values the destination refuses; consent conflicts keep the most restrictive choice; nothing is merged without a decision.
7. **Connections.** Between the parts; to Approval.
8. **Better than conventional.** Every choice is typed; nothing is invented in the customer's CRM.
9. **Extra / missing.** CLEAN output preferences need F-09.
10. **Public-site quality.** Yes.

### UI22 Approval (prototype) `/projects/{id}/plan/approval`

1. **Who and why.** An approver or owner, to approve this exact revision.
2. **Decide or do.** Approve revision 6 with Kauro's code, or request changes with a reason.
3. **Information.** Every part with its way back to change it; what is not included; the validation result.
4. **Presentation.** A check-your-answers page; the approval outside any form.
5. **Next action.** See the quote.
6. **Exceptions.** A newer revision blocks approval; a viewer sees who approves.
7. **Connections.** From the plan; to the quote.
8. **Better than conventional.** The approval names its revision and asks for the code with its reason said.
9. **Extra / missing.** F-02 (quote at approval) is proposed.
10. **Public-site quality.** Yes.

### UI25 Processing `/projects/{id}/processing`

1. **Who and why.** Every member, after payment, while the approved plan runs.
2. **Decide or do.** Wait; check again; open support.
3. **Information.** Phases (queue, startup, execution, verification, publication), queued at, elapsed, last updated, the delivery deadline.
4. **Presentation.** One status, the phases, four facts.
5. **Next action.** None until the package is released.
6. **Exceptions.** No percentage and no estimate: the deadline is the commitment.
7. **Connections.** From Payment's next step; to Delivery.
8. **Better than conventional.** Honest about not knowing the minute it ends.
9. **Extra / missing.** Nothing missing.
10. **Public-site quality.** Yes.

### UI26 Delivery (prototype) `/projects/{id}/delivery`

1. **Who and why.** A member who downloads the verified package before its deadline.
2. **Decide or do.** Choose files; download with Kauro's code.
3. **Information.** The package version and its verification; each file with rows, size and fingerprint; availability and hard limit.
4. **Presentation.** The verified package, the files, the download, then what comes next per service.
5. **Next action.** Import in stages (CRM) or use the files anywhere (CLEAN).
6. **Exceptions.** Links last 15 minutes and cannot be withdrawn; an expired package has no links; a corrected version says what changed.
7. **Connections.** To Import (UI27) or nowhere further for CLEAN; to Data and deletion.
8. **Better than conventional.** "Prepared for import", never "imported" because a file was downloaded.
9. **Extra / missing.** Nothing missing.
10. **Public-site quality.** Yes.

### UI27 Import steps and UI28 Import results (prototypes; CRM services only)

1. **Who and why.** The team that imports, stage by stage, in its own CRM.
2. **Decide or do.** Import a stage; return what the CRM holds; continue or correct after a shortfall.
3. **Information.** Each stage's file and order; for results, what was prepared, found, refused and not accounted for, in the CRM's words.
4. **Presentation.** Ordered stages; counts as four figures; the choices after a shortfall.
5. **Next action.** Continue to the next stage.
6. **Exceptions.** Results that disagree open a reconciliation; a success message alone is not proof.
7. **Connections.** From Delivery.
8. **Better than conventional.** Matching by identifying values, never by row position.
9. **Extra / missing.** Nothing missing.
10. **Public-site quality.** Yes.

### UI29 Data and deletion `/projects/{id}/retention` (an area apart)

1. **Who and why.** Every member, to see what Kauro keeps, until when, and to ask for more time or deletion now.
2. **Decide or do.** Extend once by up to 3 days; request deletion.
3. **Information.** Each kind of record with its date and rule; what deletion never reaches.
4. **Presentation.** The project header naming the area and where the project stands; a table; two choices side by side.
5. **Next action.** Usually none.
6. **Exceptions.** One extension a project, before the date and within the hard limit.
7. **Connections.** From every project page's menu.
8. **Better than conventional.** It names what deletion cannot reach (copies downloaded, the CRM).
9. **Extra / missing.** Nothing missing.
10. **Public-site quality.** Yes.

### P-08 Activity (proposed; an area apart)

1. **Who and why.** Every member, to see what happened, who did it and when.
2. **Decide or do.** Filter by area or person.
3. **Information.** Typed events with who, when (with the zone) and the reference.
4. **Presentation.** The project header naming the area; filters; a timeline.
5. **Next action.** Open the referenced page.
6. **Exceptions.** A new project says what will appear.
7. **Connections.** From the menu and the Overview.
8. **Better than conventional.** It doubles as the project's record.
9. **Extra / missing.** Needs F-06.
10. **Public-site quality.** Yes.

### UI52 Support `/agencies/{id}/support`

1. **Who and why.** Any member, to ask Kauro in writing.
2. **Decide or do.** Open a case for the project, with its topic; follow its answer.
3. **Information.** The project's cases with topic, severity, status and next response time (in UTC); the hours (in writing, Monday to
   Friday, 09:00 to 17:00 Bogotá, 14:00 to 22:00 UTC); what never to send (passwords, keys, records).
4. **Presentation.** A form and the list of cases.
5. **Next action.** Send the case.
6. **Exceptions.** Data access is asked, scoped and time-limited.
7. **Connections.** From every page's menu; billing cases from UI30.
8. **Better than conventional.** A text that looks like a secret or customer records is refused and not stored.
9. **Extra / missing.** Cases belong to a project; a workspace-wide list of cases would need a read.
10. **Public-site quality.** Yes.

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

## Group E. Owner, administration and operations

### UI33 Today `/ops`

1. **Who and why.** The owner, at the start of a session, to see what waits for them; a seller, to see their next sale step.
2. **Decide or do.** Pick the one thing to do first.
3. **Information.** Owner: what waits for them (count and the first item, prepared); money (credits to attribute, seller payouts); work
   (jobs, deletion, incidents, support); product and sales (releases, operating review, claims). Seller: the next step, prospects worked,
   this month and last paid, and what their access excludes.
4. **Presentation.** One framed next step, then figures grouped by area, each with an Open link.
5. **Next action.** The framed step.
6. **Exceptions.** A quiet day says nothing waits; a figure in attention (a deletion retry) is marked.
7. **Connections.** To every ops page; the sales claim to Prospects.
8. **Better than conventional.** It leads with one prepared action instead of a dashboard of equal tiles.
9. **Extra / missing.** Nothing missing for the review.
10. **Public-site quality.** Yes.

### UI38 Owner actions `/ops/owner/actions`

1. **Who and why.** The owner, to do the personal actions only they can do (a domain renewal), prepared beforehand.
2. **Decide or do.** Open the provider's page, check the values, pay, record the result; or say the page looked different.
3. **Information.** Why it matters, the checked address, the cost and card, the owner's part, the proof to keep, the values to check.
4. **Presentation.** One prepared card a task; a not-ready task greyed; a dated list of what is done.
5. **Next action.** Open the registrar's page; then record the result.
6. **Exceptions.** The page looks different: the action stops and is prepared again; a task whose steps are unknown asks nothing.
7. **Connections.** From Today.
8. **Better than conventional.** It never guesses a government's or provider's screens; it prepares or waits.
9. **Extra / missing.** Nothing extra.
10. **Public-site quality.** Yes.

### UI39 Company finance (real) `/ops/finance`

1. **Who and why.** The owner, to keep collections, cash and obligations apart: the bank route and the incoming credits to attribute.
2. **Decide or do.** Verify, enable, disable or replace the route; attribute a credit to an order.
3. **Information.** Route state, account reference, environment, rollout, details version and evidence hash; each credit with its bank
   transaction, amount, fee, rail and reference.
4. **Presentation.** The route as one card; the credits as a table on wide screens and labelled cards on a phone.
5. **Next action.** Attribute to an order.
6. **Exceptions.** Not the owner: one refusal for the page; a credit without a reference opens for review; an unknown fee is never zero.
7. **Connections.** From Today; to the order a credit is attributed to.
8. **Better than conventional.** Credits are matched by hand with their evidence, never inferred.
9. **Extra / missing.** The forms for verify, enable and replace are not drawn yet (their commands exist).
10. **Public-site quality.** Yes after the phone rework.

### UI40 Jobs `/ops/operations/jobs`

1. **Who and why.** The owner, to inspect safe execution and recover a job that stopped.
2. **Decide or do.** Prepare a second attempt or a cancellation.
3. **Information.** Workspace and project, attempt, plan version, state, delivery due; for the opened job its phase, resources, lease and
   incident.
4. **Presentation.** A table, one job opened below.
5. **Next action.** Prepare a second attempt.
6. **Exceptions.** Lease expired: output not published, nothing charged twice; no state can be set by hand.
7. **Connections.** From Today; to Incidents.
8. **Better than conventional.** Recovery acts under the customer's one authorisation.
9. **Extra / missing.** Nothing missing.
10. **Public-site quality.** Yes.

### UI41 Deletion `/ops/operations/deletion`

1. **Who and why.** The owner, to verify what was actually removed, class by class, in the database and at the provider.
2. **Decide or do.** Retry a removal the provider refused; inspect its answer.
3. **Information.** Why and when the deletion was due, what it covers and never covers, each class's state in both places.
4. **Presentation.** The deletion's facts, a table of classes, the held object explained, the restore journal.
5. **Next action.** Retry the removal now.
6. **Exceptions.** Until the provider confirms, the deletion is not verified, whatever the database says.
7. **Connections.** From Today.
8. **Better than conventional.** A restore removes deleted files again before anything is served.
9. **Extra / missing.** Nothing missing.
10. **Public-site quality.** Yes.

### UI42 Incidents `/ops/operations/incidents`

1. **Who and why.** The owner, to contain an incident's scope and prove recovery.
2. **Decide or do.** Review the prepared notice; prepare emergency access if needed.
3. **Information.** Severity, start, known scope, next review; containment, recovery with its proof, communication.
4. **Presentation.** The incident's facts, then three steps with their states.
5. **Next action.** Review the notice.
6. **Exceptions.** None open: says when the last one closed. Emergency access is limited to 30 minutes and recorded.
7. **Connections.** From Today and Jobs.
8. **Better than conventional.** Recovery needs proof, not a status change.
9. **Extra / missing.** Nothing missing.
10. **Public-site quality.** Yes.

### UI43 Releases `/ops/releases`

1. **Who and why.** The owner, to promote only the accepted exact candidate.
2. **Decide or do.** Promote, or restrict a capability first.
3. **Information.** Commit, tree, lock and image; each gate's result for that image; business readiness (legal texts, prices, help).
4. **Presentation.** The candidate's identity, a table of gates, a short readiness list, one promote button.
5. **Next action.** Promote 2026.10.3.
6. **Exceptions.** A rebuilt image is a new candidate and its gates run again.
7. **Connections.** From Today.
8. **Better than conventional.** It promotes an image by digest, not a branch.
9. **Extra / missing.** Nothing missing.
10. **Public-site quality.** Yes.

### UI44 Operating review `/ops/reviews`

1. **Who and why.** The owner, monthly, to choose the next action from evidence.
2. **Decide or do.** Approve and start one experiment, or edit it.
3. **Information.** The month's funnel from account to verified import; money collected and direct costs; support per paid project;
   concentration; what is owed (commissions, refunds); one experiment with its reason, budget and stop rule.
4. **Presentation.** Bars for the funnel, four figures, a list, then the experiment as a table.
5. **Next action.** Approve and start.
6. **Exceptions.** The arithmetic of a hoped-for gain is labelled arithmetic, not demand.
7. **Connections.** From Today.
8. **Better than conventional.** One experiment at a time, with a stop rule set before it starts.
9. **Extra / missing.** Nothing extra; taxes are left to the accountant, with no estimate.
10. **Public-site quality.** Yes.

### UI55 Support cases `/ops/support`

1. **Who and why.** The owner, to resolve a customer's issue with scoped evidence.
2. **Decide or do.** Reply; mark as waiting for the customer; ask for data access when needed.
3. **Information.** Each case's workspace, subject, question, severity, state and next answer due; the evidence attached.
4. **Presentation.** A table, one case opened with its question quoted and the reply box.
5. **Next action.** Send the reply.
6. **Exceptions.** Data access is requested, time-limited and recorded, never assumed.
7. **Connections.** From Today; the customer's side is UI52.
8. **Better than conventional.** Evidence is attached by reference to the project, not pasted.
9. **Extra / missing.** Nothing missing.
10. **Public-site quality.** Yes.

### P-04 Owner settings (proposed) `/ops/settings`

1. **Who and why.** The owner, to see how Kauro is connected, protected and recovered.
2. **Decide or do.** Open a provider's page; read the operating parameters; follow security controls.
3. **Information.** The owner's security; each provider's state and dates, never a secret; the policy's parameters; break-glass grants
   and restricted capabilities; recovery contacts and succession (proposed).
4. **Presentation.** Sections with anchors at the top, labels left and facts right.
5. **Next action.** Usually none.
6. **Exceptions.** A provider needing attention says what to do (details expired, identity revoked).
7. **Connections.** To Finance, Outreach, Owner actions, Incidents, Operating review, Releases, Deletion.
8. **Better than conventional.** It states what is not connected yet, instead of hiding it.
9. **Extra / missing.** Recovery contacts and succession need a contract (D-P04-1).
10. **Public-site quality.** Yes.
