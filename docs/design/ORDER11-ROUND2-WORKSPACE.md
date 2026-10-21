# Order 11 round 2: the agency and company workspace (2026-10-21)

Results, not proposals: every agency and company page was rebuilt from the round-2 research
(`Kauro.archive/Deliveries/Visual/order11/research/round2/`: `agency-workspace.md`, `app-shell-settings.md` §9, `principles-craft.md`,
`signed-in-notes.md`). Branch `order11/r2-workspace`. Screenshots: `order11/shots/round2-workspace/` (`<page>-<state>-<width>-<theme>.png`).
Nothing here touches the backend, the shell (`apps/web/src/shell/*`), the public site or the owner and seller pages.

## What every page now shares

| Part | What it is | Why (research) |
|---|---|---|
| Page header (`screens/shared/project-header.tsx`) | Inside a project: the context line (client · service), the **project's name as the h1** (28 px; 24 px on a phone) with its state in words, the six stages (progress, not navigation), a hairline, then the page's own h2 (20 px), its lead and its one primary action. Outside a project: the page's name as the h1. Exactly one h1 either way. | agency-workspace §1.2.3, §5.3 ("Overview" was the largest and least informative word); app-shell §9.5 |
| Six stages, named once | Files · Health check · Plan · Quote and payment · Preparation · Delivery and import ("Delivery" for Clean your data). The preparation is stage 5 and the delivery stage 6 (round 1 drew both as "step 5"). | agency-workspace §1.2.2; How it works's six stages |
| One date per fact (C-1) | `tools/review/private/prototypes/timeline.ts` computes every date of the main project from the policy (quote valid 14 days; unpaid files 7 days after the check, never past 14 days from sealing; one 72-hour extension; package 7 days after it is ready, never past 14 days from payment). The quote fixtures, the payment order, the processing job and every prototype read it. When the files end before the price, the Quote and the Overview both say "Pay before Oct 27 …". | agency-workspace §1.3 C-1, §5.3 rule, §5.12 |
| One amount per fact | `prototypes/money.ts`: Northwind Data has earlier paid projects, so its quote carries the 5% repeat discount (USD 1,230.25, ToS Annex A's own worked example); the estimate shows the band's list price (USD 1,295). Quote, payment order, Billing, Clients, Projects and Overview agree. | agency-workspace §1.3 (every figure reconciles) |
| People, not role theory | `prototypes/people.ts`: who may approve, pay, delete or invite, named ("Samuel Osei (Approver) or Lena Ortiz (Owner)"). A control a role cannot use is not drawn; one line says who can. The review can now be seen as **approver, billing and viewer** too. | agency-workspace §3.8, §6; app-shell §9.11 |
| Shared parts | `kit.tsx` NextStep (the one requirement of a page: who, by when, if not, one action), Only, Scope; `r2-shared.css` tables (16 px, tabular, right-aligned figures, cards on phones), check-your-answers, focused column, equal peer cards, empty states. | principles-craft V14–V20, V29; app-shell §9.13 |
| Type floor | Every 11–12 px label in `screens.css` raised to 13 px; one h2 size (20 px) in the app. | BUILD-BRIEF craft rules |

## Decision: project navigation

The two research files disagree: agency-workspace §0.1 removes the project's areas from the menu and makes the stage strip the navigation;
app-shell §8–§9.3 keeps the areas nested under Projects and the strip as a path. **Kept the areas in the menu; the strip is progress only.**
Why: a project is a scope (its own files, plan, money) as well as a process, and two of its places (Activity, Data and deletion) are not
stages, so the strip alone cannot reach them; the owner chose this on 2026-10-20. The real harm agency-workspace found was two devices
saying the same thing "in different words, with different counts" (ten items against six steps, Purchase against Quote, the delivery as
step 5 twice). That is fixed at the root: the stage areas now carry exactly the stage names (Purchase → **Quote and payment**), the
preparation has its own area (UI25), and the delivery is no longer a duplicate step. State markers in the menu (app-shell §9.3.2) belong
to the shell and are left to the lead's rebuild; `projectAreasFor` is ready for them.

## Review support changed

- Review people: **approver, billing and viewer** added (`lib/contexts.ts`, `lib/world.ts`, the person menu), so every limited role can be
  walked; the agency team in `prototypes/people.ts` is the one Team shows.
- `agencyOfPathname` (screens.ts) resolves the proposed Activity path (`/projects/{id}/activity`, P-08) to its agency, so the page is drawn
  inside its workspace and its project header instead of alone.
- Per-area stylesheets (`r2-shared.css`, `r2-board.css`, `r2-plan.css`, `r2-delivery.css`, `r2-access.css`) instead of growing
  `pages.css`, which the owner and seller pages share.

## Real screens (apps/web)

| Page | Purpose | What changed and why | Earlier decision changed |
|---|---|---|---|
| All project pages (UI14–16, UI18, UI23, UI25) and UI24 | The anatomy above | `page.tsx` files pass stage, title and lead to the header; the registry sentence moved from the view to the header lead. | N-26 (the "area · step" line) replaced: the page's own h2 names it. |
| UI14 Upload the files | Give Kauro the files | Each file is one compact card: name, size, state; its facts behind "File details" (opened by itself when refused or not fully checked); "Sent from this browser" and "Received by the storage provider" renamed; "Kauro is reading the files" with "Nothing blocks this set" (C-8). "Cancel this upload" → "Remove from this set". | — |
| UI15, UI16 | Choose, then check and seal | New titles ("Choose what to prepare", "Check and seal the files"); header lead. | — |
| UI18 Health check | Follow the free check | Header lead; otherwise kept (its codes stay the api's own, never sentences Kauro invents). | — |
| UI23 Quote | See the price, scope and the two dates | The two dates that end something side by side at one size; when the files end first, "Pay before {date} … one 3-day extension" (C-1); price list named R2-INITIAL as the schedule is (C-5); a member the server does not let pay reads "Only an owner or a billing member … can create the payment order" instead of a closed form; what the quote covers sits beside the sheet on wide screens (no empty half). | — |
| UI24 Payment | Pay exactly, with the reference, in time | The three things a bank asks for first, in one enclosed block at one size: amount, reference in groups of four (copy gives it unspaced; screen readers read it whole), send-by date; then Kauro's bank details; a confirmed payment is the receipt with "Go to the preparation" as its one primary. | N-09 kept (order id at the foot). |
| UI25 Preparation | Know Kauro is working and that nothing is needed | Phases in the customer's words (Waiting for its turn … Building the report and releasing the package); removed the ticking elapsed time, the delivery deadline (no policy source, C-6) and the worker heartbeat; "You can close this page"; cancelling last and apart. | — |
| UI30 Billing (one order) | An order's receipts and refunds | Header lead only; the workspace overview is P-09. | — |
| UI32 Settings | General page of Workspace settings | Scope line "These settings apply to everyone in {workspace}"; "Agreements accepted"; "Close this workspace" (agency or company, I-5); width capped. | — |
| UI52 Support | Ask in writing | Title "Support" (C-9 in part: the api lists cases per project, so the list stays per project). | — |

Tests: web 337/337. Changed only where a rule changed on purpose: the registry sentence is asserted in the copy, no longer inside the
view (moved to the header) — `health-check-screen`, `payment-screens`, `processing-support-screens`, `sources-screens`,
`billing-settings-screens`; UI25's phase words and the removal of elapsed time, deadline and heartbeat; UI14's renamed fact labels; the
closure line names the workspace; `shell.test.ts`'s ProjectHeader test rewritten for the new header.

## Prototypes (review)

Detailed per-page notes are in the code comments at the top of each prototype. In short:

- **Projects (UI11)**: Needs you → Waiting on someone in your team (named) → Kauro is working → Completed, each a table; stage in words;
  the date that matters labelled with what ends; the next step as a verb; no segmented bars, no "imported" (C-7); repeat-discount line
  moved to Billing and the completed Overview; empty states per role.
- **Clients (UI12)**: a table (open projects, next step, money waiting as quote or order in words, earliest date, delivered in 12 months);
  archiving and the processing authority in the client's details; a company reads "Clients are for agencies".
- **Overview (UI13)**: one NextStep card (who by name, by when, if not) carrying the C-1 sentence; In the way only when blocking; facts;
  Recently; agencies get "Copy a status line for your client" (Proposed).
- **Destination (UI17)**: facts Kauro read, each Confirmed / Unknown / Needs your answer; who confirms named; "Clean your data" has its own
  page and the uppercase CLEAN is gone.
- **Plan (UI19–UI22)**: the four parts as a GOV.UK task list inside stage 3; Duplicates as one progress line that always adds up (C-2),
  bulk decisions by evidence class with three examples, the effect in numbers and undo, weak classes one by one; Approval a focused
  check-your-answers column with the approver named first, the code field on the page, Back left and the action right, a confirmation
  that hands over to the billing person; every count equal across the plan pages (C-3, C-4).
- **Health check results (P-07)**: verdict, findings by severity in words with one figure size and their denominators, the estimate in
  the same size with no button, price list R2-INITIAL (C-5), one primary "Review the plan".
- **Delivery (UI26)**: "Download by …" is the most visible date; one primary; fingerprints shortened with copy; expired links and a
  deleted package are two states.
- **Import (UI27 + UI28 merged)**: one stage list; HubSpot stages use HubSpot's own steps **Type, Upload, Map, Details**, Salesforce
  stages Data Loader's (Insert, Log in, Select data objects, Mapping, Directory, Finish), each naming the Kauro file it takes; returning
  the result proves the import (no "I have imported" button); reconciliation per stage; continuing is the approver's, named.
- **Data and deletion (UI29)**, **Activity (P-08)**, **Billing overview (P-09)**: one verdict line, the schedule from the timeline, two
  separate panels (More time, Delete now with a typed name); a dated record grouped by day; Billing opens with one sentence of what needs
  action, a table with tabs, the year's total in its foot, no stat plates.
- **Settings IA**: **Your account (P-01)** — Profile, Sign-in and security, Notifications, Appearance, Your workspaces — each with "These
  settings only apply to you."; **Workspace settings (P-02)** — General, Responsibility and agreements, Data and retention, Security and
  activity log — each with "These settings apply to everyone in {workspace}."; no secret ever drawn; what needs a backend change marked.
- **Team (UI31)**: who approves and who pays above the table; roles as Can / Can't; menus close on an outside click (`click`).
- **Access (UI09, UI10, UI50, UI51, P-05, P-06)**: craft fixes (13 px floor, 28 px h1, one primary, the chooser last-used first).

## Verification (2026-10-21)

- Web: type-check clean; tests 337 passed, 0 failed (337 before). Review type-check clean; review inventory test 2/2. Web standalone
  build and the private review build pass.
- Review edge on port 4600. Screenshots of every page above at 1280 and 375, light and dark, looked at and fixed over three passes:
  `order11/shots/round2-workspace/` (168 images of first states plus state shots).
- `audit-private.mjs`: group A 1,330 cases, 0 issues (10 expected by design: the shell holding UI32 while loading); group C 560 cases,
  8 issues (P-09 badge wider than 320 px) fixed and re-audited to 0; group B 2,600 cases, 18 issues (UI17 file input at 320 px, the
  UI27/UI28 reconciliation caption squeezed on phones) fixed and re-audited to 0 (UI17, UI27, UI28, P-09: 440 cases; UI11, UI12, UI29,
  P-08: 410 cases). Reports in `order11/shots/round2-workspace/audit/`.

## Backend gaps (needs a read or a contract)

- The shell has no project read: the header's project name, client and service come only in the review. Needs a read (name, client
  label, service, and the stage the project is at) for the header and the menu; the payment page also needs it by the order's project.
- Project board read (stage, the date that matters, next step, who acts); client summaries; workspace quotes and orders (F-10); billing
  profile; count of paid projects for the repeat discount.
- Plan body (parts, evidence classes, bulk decisions with undo, revision); findings and estimate (F-04, F-05); destination facts with
  their state; activity (F-06).
- Package read; import stages with reconciliation and rejected rows; a route to download rejected rows; Data Loader mapping files as
  outputs.
- Workspace-level support case list (cases are listed per project today).
- Identity-provider profile, sessions, security events; notification choices; a third theme value ("Match system"); the responsible
  person; deletion records; the workspace activity log.

## Questions for the owner (only what cannot be decided here)

1. **Pay before the files go (C-1):** may the Quote and the Overview say "Pay before {files date}" when it is earlier than the price's
   validity, and point to the one 3-day extension?
2. **Bulk duplicate decisions:** may "Unify all" ship for the strong evidence classes only, with a sample and undo until approval?
3. **Salesforce staged import:** release the stage-2 contacts file only after stage 1 is verified, with each contact's AccountId filled
   from the stage-1 success file (rather than the customer filling them)?
