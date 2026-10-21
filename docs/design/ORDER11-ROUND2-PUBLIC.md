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
- **Contact.** The label above the heading names the free check the call to action promised, and the lead starts with it; the form is one
  column; "All fields are required except the last one" removed (the optional field says so); the size question says why it is asked.
- **Service status.** Reference heading; services as rows of one table (Service, New projects); incidents and help as text; no bars or
  percentages (no history exists).

## Application shell

- Account foot rebuilt as above. The person's name and role are not in the session reply (`getCurrentSession` has no display name), so
  the button says "Your account" until the API offers them. **Gap G-SHELL-1:** a read of the signed-in person's name and their role in the
  current workspace.
- The workspace block is one control (mark, name, up-down sign) leading to the workspaces page; its state shows only when it is not
  simply Active (Restricted, Closing), in the warning colour with its word.
- App h1 fixed at 28 px (24 px on phones), h2 20 px, replacing a 30–44 px clamp.
- "Support" renamed "Help and support".

## Not done here, and why

- **Contact heading.** The research suggested "Request a free data health check" as the h1. The h1 is the registry's primary copy in
  `@kauro/contracts`, which this order may not change. Owner question Q-R2-1 below.
- **New public pages** (For agencies, Check a file free). They need registry routes (contracts) and, for the free check, an amendment to
  A3 §3.2; they stay as proposals at /__variants with Contact's consent variant (F-08).

## Questions for the owner (only what cannot be decided here)

- **Q-R2-1.** May the Contact page's registry heading change to "Request a free data health check" (a contracts change)?
- **Q-R2-2.** Should the account button show the person's name and role? It needs a small read in the API (G-SHELL-1).
