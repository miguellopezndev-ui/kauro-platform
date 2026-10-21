# Order 11: design decisions for the whole Kauro experience

**Status:** working decisions of Order 11 (2026-10-20), applied to every page of the review. Each rule names its source: the owner's
decisions, the authority documents (via `research/kauro-baseline.md`), or the research files in
`C:\Users\migue\Kauro-visual-delivery\order11\research\` (cited by file and section). Where a rule needs behaviour the code does not
have, it points to `ORDER11-FUNCTIONAL-GAPS.md`. The approved public site (Order 10) is not changed on this branch: public changes are
reviewable variants beside it.

Kinds of statement: **[O]** the owner decided it; **[A]** an authority document or the code says it; **[R]** the research supports it;
**[D]** a design decision taken under the owner's mandate, open to the owner's review.

## 1. Words

1. **Service names [O].** "Clean your data", "Prepare for HubSpot", "Prepare for Salesforce" on every buyer-facing screen, public and
   private. CLEAN, HUBSPOT and SALESFORCE stay internal identifiers. Each service carries one line of what it produces, who does what, and
   its limits. "Clean your data" never suggests external enrichment, irreversible deletion of records, or compatibility with any CRM.
2. **Plain, exact language [A][R].** Numbers are the project's own; every share says out of what; a candidate is never called a
   confirmed duplicate; nothing is called imported because it was downloaded. Errors follow GOV.UK's form: the field's own words, an
   instruction for an empty field, a description for a broken rule; never "invalid", "oops", "sorry" or "please" (research:
   auth standards notes; GOV.UK error message component).
3. **Stages and quotes [A][O].** Three distinct moments are never blurred: an **estimate** after the check (informative, reserves
   nothing), a **quote** after the plan is approved (formal, valid 14 days, policy `quoteDays`), and the **payment** (bank transfer).
4. **True promises only [A].** "No card" only for the free check; never "ACH" on public pages until the route is proven; deletion
   periods only as the policy states them (free check: 7 days after the results, at most 14 days after sealing; purchased: 7 days after
   the first package, at most 14 days after payment; staged: 21 days after the first stage, at most 30 days after payment).
5. **One date format in the application [A].** Every private screen writes dates as the design system does (`packages/ui` `formatDeadline`):
   "Oct 20, 2026" for a day, "Oct 20, 2026, 1:00 PM UTC" for a moment, always with the time zone. The prototypes used "20 Oct 2026,
   13:00 UTC" and the real screens the design system's form, so the same quote read differently from one page to the next; the
   prototypes now follow the product. The approved public site keeps its own ISO form ("2026-10-20 12:02 UTC"), which is not changed
   without approval; aligning it is listed among the public proposals.

## 2. Page structure

1. **One page head [D].** Every private page opens with its h1 and a one-sentence lead. No eyebrow inside the application: the side menu
   already names the workspace or the console, and repeating it above every title is noise (owner's rule: prefer removing to adding).
2. **One next step [R].** Where the person has something to do, the page says it once, near the top, with who can do it and by when
   (research: app-operations-ux.md §1.3 proposal 1.2). Where they have nothing to do, the page says that, and what Kauro is doing.
3. **A control a role cannot use is not shown disabled [R].** It is replaced by one line naming who can (app-operations-ux.md §6.3
   proposal 6.4).
4. **Proposals are marked once per page [D].** A capability the backend does not have is drawn and labelled "Proposed" with its gap
   number, in one note per page rather than a badge on every block.
5. **Phones [D][R].** No horizontal scroll anywhere, also inside tables: tables become cards with each value under its column's name
   (design brief; app-operations-ux.md §8 question 14 resolved by the brief's rule).

## 3. Navigation

1. **Application side menu [D].** The workspace (name, state, switch) at the top; Projects, Clients (agencies only), Team, Billing,
   Settings; Support and the person's controls at the foot. A direct company has no Clients and no switch when it has one workspace
   (app-operations-ux.md §6.3 proposal 6.5).
2. **Inside a project [O][D].** The project's areas nest under Projects in the side menu, in task order, with only the areas the service
   has: Overview; Files (and Destination, for HubSpot and Salesforce); Health check; Plan; Purchase; Delivery; Import (HubSpot and
   Salesforce only); then, apart, Activity and Data and deletion. The areas are places, not a forced path: a person may go back to any area
   their role and the project's state allow. On a phone the same list is in the menu. No horizontal tabs.
3. **Progress lives in the project header [O][D].** A project page opens with the project's header: client, project name, service, and a
   contextual progress line of the real stages of that service ("Prepare for HubSpot": Files, Health check, Plan, Purchase, Delivery,
   Import; "Clean your data": Files, Health check, Plan, Purchase, Delivery), the current one named. The side menu says where you are; the
   header says where the project is. Nothing is drawn twice.
4. **Operations [R].** The owner and sellers have their own consoles on the operations origin, each named in the side menu. The account
   menu lists, in order: name and role, switches (only if more than one console), Your account, Theme, Help, Sign out
   (app-operations-ux.md §6.3 proposals 6.1–6.2).

## 4. The journey

1. **First contact to account [O].** The public "Check a file free" opens a page on the free check: what it measures, what you receive,
   its limits, how files are protected and how long they stay. Its main action is "Create an account"; "Ask a question first" leads to the
   contact form for complex or unsupported cases. The check stays subject to its real budget and capacity. This changes A3 §3.2 (recorded
   as F-03).
2. **Account [O].** Google or email with a password of at least 12 characters (checked against breached passwords, no composition rules),
   a verified email, and Kauro's own two-step code, also after Google. No business email, no company setup to explore.
3. **Exploring [O].** A new account explores an example workspace with synthetic data, kept apart from real data (research: workspace and
   example-data findings; Airtable's mixing of sample and real data is the case to avoid).
4. **Before real files [O].** A short, progressive eligibility step: agency or direct company, what Kauro admits (files and records),
   the authority over the data, the agreements including the DPA, and two-step verification done. Billing details are asked at the first
   quote (D-UI09-2).
5. **The check and its results [O].** The check measures the whole sealed set. Its results come first; then an estimate computed from the
   service, the units actually measured and the current price policy, labelled as an estimate that reserves nothing.
6. **Plan, approval, quote, payment [A][O].** Only an owner or an approver approves; only an owner or the billing role buys. Approval
   names a numbered revision and asks for the two-step code with its reason stated (app-operations-ux.md §2.3). A proposed simplification
   of approval-then-quote is recorded as F-02.
7. **"Clean your data" [O].** No destination step and no forced format choice; optional output preferences only where they add value.
   The backend's contrary requirement is F-01.
8. **Delivery, import and recurrence [A].** The package is verified and downloadable with links that last 15 minutes; migrations import in
   stages whose results the team returns; the repeat discount appears only after a first project, as reachable progress.

## 5. Identity and recovery [O]

1. Recovery codes (single use) are issued at enrolment, after the code is confirmed, and the person confirms they saved them.
2. Lost authenticator and codes:
   - **A member of an organisation:** an authorised admin may start the recovery, never turn two-step verification off or grant access.
     The member's identity is checked independently, the admin confirms with a fresh code, everyone concerned is notified, sessions are
     ended, the event is logged, and a waiting period proportional to the risk applies.
   - **An owner, a privileged admin, or an account with no other admin:** a reinforced recovery through Kauro, with independent checks and
     a person's approval.
   - **No reliable evidence:** access is not restored on an email, a password or a support request alone; the screen says that safe
     recovery is not possible and names the legitimate alternatives.
   - Never security questions or SMS; never a self-reset from a session that is still open.

## 6. The public site (variants)

1. The approved site stays as it is. Proposals are drawn as variants at /__variants/... in the review, in the public frame, so both can be
   walked (overnight decision N-29). Drawn so far: Supported services with three cards and the new names, the header and footer, the
   "Check a file free" page and the "For agencies" page.
2. Proposals under study: menu items shown on wide screens and "Home" removed; "Check a file free" and its page; a "For agencies" page
   on the same prices and terms (facts limited as the owner set); a footer that lists every page; Pricing with what is included and not
   included, a unit explanation and an FAQ from existing rules; Supported services' "Availability now" redesigned; the new service names.

## 7. Visual identity

The identity of A10 holds (carbon, porcelain, wine, clay; one physical object per idea; a stamp only for a verdict; no gradients or fake
dashboards). The approved public site is the floor of quality for the private pages, with the difference that an operating tool is
denser and quieter than a commercial page.
