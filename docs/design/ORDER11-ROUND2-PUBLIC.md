# Order 11, round 2: public site and application shell (2026-10-21)

The owner walked the review on 2026-10-21 and asked for results, not proposals: every page rebuilt except Home, on researched reasons.
The research is in `Kauro.archive/Deliveries/Visual/order11/research/round2/` (public-pages.md, app-shell-settings.md, principles-craft.md,
signed-in-notes.md). This file records what changed, why, and which earlier decision it replaces. The owner and seller consoles are in
ORDER11-ROUND2-OPS.md and the customer workspace in ORDER11-ROUND2-WORKSPACE.md.

## Fixes the owner named

| Owner's words | What changed |
|---|---|
| "Aw, Snap" when clicking outside an open menu | Root cause isolated by bisection: closing a `<details>` synchronously inside a `pointerdown` handler crashes Chromium's renderer (STATUS_BREAKPOINT). The public menu now closes on `click`. The app's account menu closes on `click` outside and on Escape. |
| Replace every uppercase CLEAN | The three services read "Clean your data", "Prepare for HubSpot", "Prepare for Salesforce" on every page and in the estimator; the API value never shows. |
| "Availability now" wastes space beside the text | Three equal vertical cards in one row, the same rows in the same order (state, name, destination, what you receive, the one setting or limit, the sample); the rows line up across cards (CSS subgrid). |
| The limits block "se ve horrible" | One table grouped by what each limit applies to (each file, each set, each project), values at reading size on the right; no plates, no display numerals in sentences. |
| The sidebar foot looks bad | One account button (person mark, "Your account", up-down sign) opening a short menu upward: Account settings, Theme by name (Light / Dark), Sign out last after a rule. |
| Bring the "Invented figures" note closer | It now sits directly under the counting rule it qualifies, in one block with 4 px between them. |

## Shared system (all rebuilt public pages)

- **Type scale.** Path pages (Supported services, Pricing, How it works, Sample delivery): h1 36–52 px. Reference pages (Data handling, Help,
  Contact, Status): h1 32–40 px. Every section h2 24–30 px; card and stage titles 20–22 px; body 16 px; meta 14 px. Before: h1 52/68/84 px
  and h2 from 12 to 67 px. Reason: the identity's own rule "type no larger than its meaning"; reference sites measured 32–56 px.
- **One closing band** on every decision page: heading at the section size, one sentence, the site's one call to action as the only
  filled button, at most two text links. Before, eight pages ended in seven different actions.
- **Each figure once.** Prices appear only in the Pricing table; the repeat discount once; 12,480 once per section.
- **Service order** HubSpot, Salesforce, Clean your data on every page (A3 §3.3: the cleanup without a destination is never the headline),
  all on one surface. Earlier decision changed: the wine card that led with CLEAN (Order 10).

## Page by page

- **Supported services.** Cards as above; scope as two equal panels; limits table with three notes; closing band. Prices removed from
  the page, with one line linking Pricing.
- **Pricing.** Estimator first (every count-priced page in the sample asks for the count before showing prices); no service pre-selected
  (a default answers the question for the visitor); the result is the page's only large figure, with the call to action under it. One
  price table (cells without "USD", the currency in the caption). A sentence shows the band step from the policy (50,000 → 1,295; 50,001 →
  1,995). What the price includes and excludes (only facts already on the site or in the policy). Quotes, tax and repeat projects in one
  section; four questions. Removed: the four-card ladder, the 5–15 % band, the second discount section, the 67 px closing heading.
- **How it works.** The six stages at a glance (number, name, who acts, what it leaves you with) open the page, then the call to action.
  Each stage shows the summary, "What you get" and "What stops it" in view; "Who acts, what it needs and what happens" are folded on the
  stage itself, so nothing moved out of reach while the page shrank from 7,795 to about 5,500 px. The sticky index is gone (the owner
  rejected things that follow the scroll). The duplicate counts moved to Sample delivery.
- **Sample delivery.** The head shows a crop of the real report table instead of a picture; the package named in four parts; report
  table; duplicates (moved from How it works); manifest stated once; importer guide; closing band.
- **Data handling.** Reference heading (was 84 px and filled the first screen); five facts as label and value in the first screen, with
  both windows of each retention, never a single "at most"; the path of a file in four steps; sections at one heading size, tighter
  between related sections; one action ("Ask a security question"), the terms as text links. The scroll-driven "redaction" figure was
  removed (it animated with the scroll and rendered empty when still).
- **Help.** Reference heading; the index beside the guides; the free check's two retention windows now both stated (guide version 1.4,
  digest recorded).
- **Contact.** Headed by the call to action that opens it (amendment R2-1 below); the lead says scope and data-handling questions come
  through the same form and keeps the rule about files; the form is one column; "All fields are required except the last one" removed (the optional field says so); the size question says why it is asked.
- **Service status.** Reference heading; services as rows of one table (Service, New projects); incidents and help as text; no bars or
  percentages (no history exists).

## Application shell

- Account foot rebuilt as above. Under "Your account" the button names the person's **role** in the workspace (Owner, Admin, Operator,
  Approver, Billing, Viewer), read with the existing ListAgencies beside GetAgency: only the person's own **active** membership of exactly
  that agency names it; anything else shows no role, and the role never decides access (the api's permitted actions do). Owner's approval,
  2026-10-21. **Gap G-SHELL-1:** no read in the api returns a person's name (not the session, not the team list), so the name cannot be
  shown without a backend change to identity data; not done here.
- The workspace block is one control (mark, name, up-down sign) leading to the workspaces page; its state shows only when it is not
  simply Active (Restricted, Closing), in the warning colour with its word.
- App h1 fixed at 28 px (24 px on phones), h2 20 px, replacing a 30–44 px clamp.
- "Support" renamed "Help and support".

## Amendment R2-1: the Contact heading

| Field | Content |
|---|---|
| Change | UI07's rendered heading becomes "Request a free data health check." (was "Describe the task; keep CRM files out of this form.") |
| Reason | The site's one call to action, on every page, opens this page; a heading that repeats the promise confirms the visitor arrived where they meant to (information scent). The rule about files stays in the lead and at the description field, where it governs (in the sample, a scope warning sat in body text, never in a heading). |
| Approval | Owner, 2026-10-21: "sí a las dos siempre y cuando sea la mejor decisión". |
| How | Like amendment A3 §1.4: `packages/contracts/registry/screens.json` is not edited (it is byte-identical to the authority and pinned by PROVENANCE.json and the evidence ledger). The amended text governs the rendered copy; the web's tests read it through `AMENDED_PRIMARY_COPY` in `apps/web/test/support/registry.ts`, which names this record. A later registry version may take the text in through a ChangeProposal (28 §How a change is made). |
| Side effect | The review viewer's "Contract (registry)" panel still shows the registry's record for UI07, as it should: it is the registry. |

## Amendment R2-2: the Supported services heading

| Field | Content |
|---|---|
| Change | UI03's rendered heading becomes "Three services for your exported CRM files." (was "Check your files and target before you start.") |
| Reason | Measured in the owner's section review (2026-10-21): 7 of 8 comparable "supported platforms / connectors" pages head the page with what moves and where to; an instruction says neither. The heading names no destination, so it never presents a service as open: each card still reads its state from the capability publication (UI03's exception on planned or internal capability and stale caches is kept by the cards, not by the heading). Record: Kauro.archive/Deliveries/Visual/order11/research/round3-services-head. |
| Approval | Owner, 2026-10-21: "Aprobada la cabecera de Supported services." |
| How | As R2-1: the registry is not edited; the web's tests read the amended text through `AMENDED_PRIMARY_COPY` in `apps/web/test/support/registry.ts`, which names this record. |

## Not done here, and why
- **New public pages** (For agencies, Check a file free). They need registry routes (contracts) and, for the free check, an amendment to
  A3 §3.2; they stay as proposals at /__variants with Contact's consent variant (F-08).

## Owner answers

- Q-R2-1 (Contact heading) and Q-R2-2 (name and role in the account button): approved on 2026-10-21 "as long as it is the best decision".
  Contact: done as amendment R2-1. Role: done with an existing read. Name: not done, because no read carries it; adding one is a backend
  and identity-data change, larger than its benefit today (the workspace switch and the role already say whose workspace and what you may do).
