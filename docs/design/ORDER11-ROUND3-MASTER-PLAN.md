# Order 11, round 3: the master plan

Owner's mandate, 21 October 2026: design every screen of Kauro to the best possible standard. That means the four "mother sites" (the
public site, the agency/company workspace, the seller portal and the owner console), every page in them, every section and every detail.

The method:
- go from general to specific and back from specific to general;
- let questions decide what to research;
- research widely;
- build many alternatives for each decision and let them compete;
- review every result alone and in its whole.

Nothing is assumed finished, Home included. Home is the reference until something proves better.

**Version 2** (21 October 2026, about 21:45, after the owner's answers):
- Home is a blurred sketch, not a template.
- Every step is done as an audit.
- Bolder visual product decisions are allowed, if documented.
- Deliverables have their own plan: [ORDER11-ROUND3-DELIVERABLES-PLAN.md](ORDER11-ROUND3-DELIVERABLES-PLAN.md).
- At the end: push and merge, pre-authorised.
- The review server comes on at 05:00 and stays on.

**Version 7** (22 October 2026, about 00:10). Five independent, context-free reviews shaped versions 3 to 7:
- version 7 drops the engine release: the Intelligence Core accepts only Migration Core 3.0.0, and the Intelligence Core may not be
  modified, so the documents the engine writes are delivered as finished specimens and a ready patch (deliverables plan §1.1);
- version 6 fixes the engine release's version proof and aligns the tiers;
- version 5 closes the third review's points: the engine release's proof, the judging's dead ends, and the contradictions;
- version 4 resolved the second review's blocking points: judging, the release's proof, the documents' data, push mechanics, a
  reachable end;
- version 3 added the first review's changes:
- a frozen system kit with change control (§8.0);
- a vertical slice before the system is chosen (§8.1);
- calibrated judges, the incumbent always competing, and a defined margin to win (§9);
- fidelity that rises with the level (§9.0);
- tiers, budgets and a written end condition (§15);
- one canonical fixture set (§2.1);
- voice and terms written before compositions (§2.2);
- a Day-0 feasibility check (§3.0);
- simulated usability, deeper accessibility, internationalisation readiness, performance budgets, cross-browser checks, regression
  snapshots and a handoff (§10.5).

This file is the plan I follow without needing the owner between gates. It is written so that a fresh session can resume it from the
progress ledger (§13).

---

## 0. What "perfect" means here (the bar every screen must pass)

A screen is done only when all of these hold:

1. **It answers its questions.** Every question in its brief (§6) has an answer on the screen, at the place a reader looks for it.
   "Which questions does this screen answer in the first viewport?" has a written answer. A fresh-context judge confirms it from a
   screenshot alone.
2. **It won its auditions.** Its composition, every section and every non-trivial component beat at least three real alternatives
   and the incumbent (except Tier C, which composes from kit winners, §15):
   - first in calibrated blind judging of mid-fidelity versions (§9.0, §9.4), or kept as the incumbent under §9.4's fallback;
   - then the gates on the top two (§9.3);
   - then my review (§9.5).

   The runners-up are kept.
3. **It is Kauro.**
   - It reads as the same family as Home seen out of focus (§4).
   - Its colour shares are its own, decided by its brief and its auditions, and recorded with the reason. A screen may carry far less
     wine than Home, or be half or all wine, if that wins.
   - Every font size is on the type scale and every spacing value is on the spacing scale.
   - Its objects, textures, stamps and motion come from the vocabulary.
4. **It has no defects.** The automated checks report zero:
   - overflow and clipping at 8 widths;
   - axe violations;
   - contrast failures;
   - off-scale sizes or spacings;
   - misaligned left edges on the grid;
   - layout shift when states change.
5. **It works everywhere and for everyone.** Keyboard, screen-reader names, 200% zoom, reduced motion and touch targets ≥ 24 px all pass.
   Every state the scenario offers is drawn and correct: loading, empty, error, denied, long text, very large numbers, many rows.
6. **It is true.** No invented capability. No figure without a source (synthetic data is labelled as synthetic). No contradiction of a
   recorded owner decision or of a contract. Every functional gap is recorded in ORDER11-FUNCTIONAL-GAPS, not hidden.
7. **It fits upward.** It is consistent with its page, its page with its mother site, and its mother site with the other three (§8.2).
8. **Anything added earns its place and is beautiful.** No content, object, chart or texture is added, removed or changed for its own
   sake or because a search showed it, only because it is the best option. Whatever is added is as finished as the rest.
9. **It has a record:**
   - the questions and their answers;
   - the research with links and numbers;
   - the alternatives with screenshots;
   - the scores;
   - why it won.

**Every step is an audit.** Each level is done the way an auditor works:
- a checklist (§0 and §6);
- evidence for every claim;
- findings written down;
- nothing passed on trust, including Home and including my own earlier work.

**Honesty clause.** The morning report states exactly which screens reached this bar and which did not. Nothing below the bar is
called finished.

---

## 1. Hard limits (never crossed, whatever a design suggests)

These carry over from the owner's standing instructions and the authority:

**Code and data**
- Frontend and design only. Migration Core, Intelligence Core, money, ledger, reconciliation, quotes, taxes and backend authorisation
  are not modified. The documents the Migration Core writes are redesigned as finished specimens, a written specification and a
  ready patch kept in the archive, to be released later together with the Intelligence Core's support for it (deliverables plan
  §1.1).
- Versioned legal texts are not changed outside their procedure.
- The contracts registry (`packages/contracts/registry/screens.json`) is never edited. A change to a screen's primary copy, route or
  function is an amendment (R2-x) in ORDER11-ROUND2-PUBLIC.md, or a proposal (P-xx) in the review.
- No new backend reads are invented in code. A screen that needs data no contract gives is drawn with synthetic data and recorded as
  a functional gap.
- **Bolder product decisions, visually (owner, 2026-10-21).** Because nothing is wired, a design may propose product changes. This
  covers how the engine's work is shown, how the services are cut and named, what values are presented, new screens and new documents.
  Every such decision goes in `docs/design/ROUND3-PRODUCT-DECISIONS.md` with:
  - what changes;
  - why it is the best option (evidence);
  - what it would take to build (which contract, core or service it touches).

  Nothing in the cores, the backend or the money logic is changed in code to make it work.
- **Deliverables** (documents Kauro produces) are redesigned under their own plan. Where their templates live inside the engine,
  only presentation and wording change, never the logic that produces the data. See the deliverables plan.

**Security and services**
- No AWS, no external service is run, no deployment, no secrets, no cards, no credentials.
- A configuration screen never shows the value of a secret.
- Third-party sign-ins are the owner's and read-only. I never sign in to anything.

**Review environment**
- The review routes (`__review`, `__variants`, `__as`) never enter the product bundle. A test already guards this and stays green.

**Git**
- Commits are local, one per finished step.
- PR #118 is pushed once, at the very end. The owner pre-authorised it on 2026-10-21 ("cuando termines… lo subes a GitHub, lo
  mergeas"). The conditions:
  - all four sites and all deliverables are finished to the bar;
  - the full test suite is green locally;
  - before the push, the branch is brought up to date with `main` locally and every conflict is resolved, so the PR merges cleanly;
  - push once, wait for CI;
  - **if CI is red**, the cause is fixed in new commits on the same PR, which counts as the same delivery. After three failed
    attempts the work stops and the owner gets a report with the failing checks and their causes. Nothing is forced, and no check is
    skipped or weakened to pass. One re-run of a documented known flake (the Windows EPERM recorded in the gate-flakes memory) does
    not count as an attempt;
  - if `main` moves before the merge, the branch is synced again and CI must pass again;
  - merge when CI is green, with the repository's usual merge method (as for the earlier Order PRs);
  - no auto-merge setting, and never for a partial state.

**Theme, language and people**
- The web's theme is dark only. Documents and emails use a light, print-first theme (deliverables plan §1.2).
- Files are named and written in English.
- People are referred to with neutral wording, never he or she.

**Motion**
- The owner's Order 10 rule stands by default: pages move in answer to the reader (pointer, choice, state change), never on their own
  and never driven by the scroll.
- The owner has now said not to close myself to video, motion graphics, transitions or animation. Such pieces may compete in
  auditions. One that breaks the Order 10 rule may only win if the record shows why it serves the reader better, and it is flagged to
  the owner.
- `prefers-reduced-motion` is always honoured.

---

## 2. Inputs loaded before any design (the decisions register)

Before the first question, I compile `docs/design/ROUND3-DECISIONS-REGISTER.md`. It lists every recorded decision with its source, so
nothing designed contradicts one:

- **Authority:** the A3 and A10 amendments, D-34 (earlier decisions are evidence, not vetoes), and the registry rows for every screen
  (information, actions, exceptions).
- **Owner decisions in memory:**
  - seller money (both figures; never invoicing as collection);
  - claim refusals;
  - alert rules (inactivity 14 days, deadlines 2 days before, claims 14 and 3 days, pilot review 14 days before the end);
  - retainer and offsets;
  - the three product designs (extensions and holds, batch unification, Salesforce staged reconciliation);
  - identity (Google plus email/password, TOTP always, open self sign-up);
  - task-based project navigation and the service names;
  - the earlier navigation answers;
  - dark only;
  - Home as the reference;
  - section-review feedback (equal cards, no repeated buttons, actions under text beside an object, equal head spacing, no
    publication version on cards).
- **Round-2 records:** ORDER11-ROUND2-PUBLIC/OPS/WORKSPACE, ORDER11-FUNCTIONAL-GAPS, FUNCTIONAL-CHANGE-INVENTORY, and the research
  files in Kauro.archive.
- **Current state:** screenshots of all ~70 screens (the 55 registry screens and ~15 proposals) at 1280 and 375 px, kept as the
  "before".
- **The push and merge instructions, reconciled.** 2026-10-21 about 17:30: "push only once, when the owner says everything is
  perfect". 2026-10-21 about 21:45, later and specific: "como me lo entregues así quedará, cuando termines… lo subes a GitHub, lo
  mergeas". The later instruction governs: push once and merge at the end, under §1's conditions. Both are quoted in the ledger with
  their times.

### 2.1 One canonical set of synthetic data (built in Foundations)
- **One world** that every screen and every document renders from: agencies, companies, sellers, projects at every stage, files and
  counts, quotes, payments, holds, commissions, claims, payouts, incidents, deletions and releases.
- **Stress variants:** an empty new account; very long names; Unicode and right-to-left names; 9-digit counts; 200-row lists; failed
  and partial runs.
- **It extends what the review already has** (`tools/review/private/lib/world*.ts`, the public `sample-data.ts` and the reports'
  fixtures) rather than inventing a fourth source.
- **A reconciliation check runs at every build** across every surface (for documents, under the deliverables plan §1.3 and its
  fallback): the same project shows the same counts, money and dates on
  the owner console, the workspace, the seller portal, the public sample and the PDF.

### 2.2 Voice and terms (written in Foundations, before any composition)
`docs/design/ROUND3-VOICE-AND-TERMS.md`, shared by screens, documents and emails:
- voice principles;
- a glossary with one term per concept (for example "billable source unit", "duplicate candidate", "prepared for import", "free data
  health check", the service names);
- patterns for numbers, dates and currency;
- patterns for empty, error, blocked, pending and confirmation messages;
- headline patterns.

Real copy is written in each page's brief before any composition is built, so layouts are chosen around true text, never around
placeholders. Headlines get their own auditions. The copy lint runs on every build.

## 3. Tooling (built in Foundations, after the feasibility check; so everything is measured, not judged by eye alone)

### 3.0 Day-0 feasibility check (before the run)
`docs/design/ROUND3-FEASIBILITY.md` lists every check this plan promises, with the tool that runs it, whether that tool is present on
this machine, and its fallback. For example:
- Firefox and WebKit, through Playwright's installed browsers;
- PDF structure, through pdf.js;
- a screen reader (Windows Narrator, built in);
- colour-vision simulation (a CSS or SVG filter);
- Lighthouse (local);
- APCA contrast (a small local function);
- PDF/UA validation (veraPDF needs Java and a download; fallback: pdf.js reads the structure tree and the reading order);
- scripting the screen reader (Narrator cannot be scripted reliably, and an autonomous run cannot do a manual pass; fallback: a walk of
  the accessibility tree from Playwright, in reading order, with names, roles and states);
- the volume of agent calls the judging needs (§9.4), against its ceilings.

A check whose tool is missing and needs a download goes to the owner before the run starts, in the opening report. It is never
installed mid-run. Until the owner answers, the check uses its fallback.

**Day 0 also dry-runs** the risky paths before any design:
- the whole platform suite (unit, browser, review, ui), so any existing failure is known before the run;
- Migration Core's acceptance generation in a scratch copy, for the specimens (never in place);
- the PDF render command;
- Migration Core on the canonical world (deliverables plan §1.3).

**A check that cannot run never blocks the end.** Every check without its tool gets a written fallback in the feasibility record, and
the fallback counts as the bar for that check. This keeps the end condition (§15) reachable.

### 3.1 The tools

These are scripts in the session scratchpad, plus pages in the review environment only:

1. **Capture harness.** Every screen × every scenario state, full page and first viewport. Finalists and winners are captured at
   8 widths (320, 375, 414, 768, 1024, 1280, 1440, 1920), plus 1366×768, phone landscape and 200% zoom. Alternatives and "before"
   captures use 1280 and 375 only (§9.0).
2. **Colour-share meter.** It classifies every pixel of a screenshot into the brand's families (carbon/black, greys, brown, sand/clay,
   wine/red, status colours) and reports the share of each:
   - per page;
   - per band;
   - per first viewport.
3. **Type and spacing auditor.** It reads every rendered element's font size, weight, line height, margins, paddings and gaps, and
   flags any value that is not on the scales defined in §4.
4. **Grid and alignment checker.** It collects left edges per band and flags edges a few pixels off the grid.
5. **Defect checker.** It flags horizontal overflow, clipped text, overlapping boxes, targets under 24 px, contrast below AA, and
   layout shift when a state changes.
6. **axe** on every screen and state, plus a colour-vision simulation (protanopia, deuteranopia, tritanopia, greyscale): no meaning
   may be lost in any of them.
7. **Audition board.** A review-only page (`/__review/auditions/<id>`) that shows the alternatives of one decision side by side, at 1280
   and 375, with their metrics. This is how the owner can see the runners-up.
8. **Judge harness.** It sends pairs of anonymous screenshots and the rubric to fresh-context agents, collects their verdicts and
   reasons, and runs Swiss brackets (§9.4).
9. **Visual diff,** before and after, for every screen. **Regression snapshots** of every finished screen at 1280 and 375 are kept
   in Kauro.archive with a local comparison script. They are not a CI gate: fonts differ between operating systems, and this
   repository has a history of Windows-only flakes. The design cannot drift unnoticed after the merge.
10. **Persona walks.** Fresh-context agents act as the operator, the approver, the owner and the seller. They drive the running review
    build with scripted tasks, for example "find the unpaid commission" or "approve the plan". Their steps, errors and hesitations are
    recorded and compared between alternatives.
11. **Performance:** Lighthouse locally per page (LCP, CLS, JS and CSS weight, texture and font weight), against budgets set per
    site in Foundations.

---

## 4. The Home DNA (a blurred sketch, measured, and itself audited)

**What the owner means by "like Home":** take a photograph of Home and blur it. The overall feel should carry over to every page: dark
carbon and brown bands, sand and clay actions, wine as the accent that leads, paper objects on rock, and generous calm space. The exact
amounts do not carry over. Every page and every section needs its own, specific, measured amount of each colour and element, decided
by its questions, research and auditions. The DNA below is the starting prior and the vocabulary, not a quota.

Home is measured and codified in `docs/design/HOME-DNA.md`. Every value has a number and a tolerance:

- **Colour (prior, not quota).**
  - The share of each colour family on the whole page and in the first viewport, at 1280 and 375. This is a prior for comparison, not a
    target: a page's own shares are decided in its brief and auditions.
  - Where each colour appears and in what role:
    - wine: two-weight headline accents, stamps, the wine band, the primary in some contexts;
    - clay/sand: actions, rock, numbers;
    - carbon and brown: bands;
    - greys: text levels.
  - The order of the bands down the page and how often wine appears per screen height.
- **Type.** The scale actually used (every size and weight, with its role), the headline treatment (two weights, light accent words),
  line lengths, eyebrows.
- **Space.** Section paddings, gaps between heading and content, card paddings, the grid (columns, gutters, max width), and vertical
  rhythm.
- **Objects and textures.** Paper objects on rock, tickets, stamps, folders and piles, tilt angles (1–3°), shadows, rock and grain
  usage. The rule "texture only under an object".
- **Motion.** The inventory of every animation on Home (pointer reactions, settle, thunk, pile fan), with durations and easing.
- **Density.** Words per section, elements per first viewport.

**Home is not exempt.** It goes through the same audit (§0, items 3–5). A defect found on Home is recorded and fixed. A change to
Home's design happens only if an alternative wins its audition clearly, because the owner considers Home's design right.

**Blur test.** Every finished page is compared, heavily blurred (a Gaussian blur at about 3% of the page width), with its own site's
DNA board: Home for the public site, the site's derived DNA for each private site. It passes when at least 2 of 3 fresh judges answer
"same family".

**Private sites.** Each one derives its own DNA from Home's: what carries over unchanged, and what changes because a workspace is a
tool and not a pitch (density, colour share, motion). Research and auditions decide this, not an assumption (§8.1).

---

## 5. The four mother sites and their screens (the inventory, to be confirmed in L2)

| Mother site | Registry screens | Proposed screens (review) |
|---|---|---|
| Public | 13: Home, How it works, Supported services, Pricing, Sample delivery, Data handling, Contact, Status, Help, Communication preferences, Service terms, Privacy notice, Data processing terms; plus Not found | Free check landing and For agencies (variants) |
| Agency/company workspace | 27: setup, workspaces, projects, clients, the project path UI13–UI29, billing, team, settings, sign in, invitation, support | Create account, Reset password, Personal settings, Activity, Billing overview, Health-check results, Organisation settings, the quote's five dates, the payment hold |
| Seller portal | Part of the 15 OPS screens: private home, Prospects, Agency relationship, Commissions, Seller resources, Reviewed correspondence (confirmed in L2) | Seller settings, Customers |
| Owner console | The rest of the OPS screens: private home, Owner actions, Company finance, Jobs, Deletion, Incidents, Releases, Operating review, Support operations, Seller lifecycle (confirmed in L2) | Claims, Payouts, Sellers, Settings |

In L2, which screens belong to which site, whether pages merge, split, appear or disappear, is decided with evidence and recorded.

---

## 6. The question bank (the base of everything)

Questions are asked at every level, and they decide what to research. The answers decide the designs. The bank is reused at each
level, with the level's own wording. Every answer cites evidence: research, a recorded decision, a measurement or a contract.

### 6.1 Purpose and people
1. Who arrives here, from where, with what in mind, on what device, how often?
2. What job are they doing, and what is the one thing they must leave knowing or having done?
3. What happens if they misunderstand this screen (cost of error)? What must be impossible to misread?
4. Which decisions are theirs here, and which are not theirs (and so not offered)?
5. What do they already know when they arrive? What must not be repeated?
6. What would make them trust this screen? What would make them doubt it?
7. Is this screen for daily use, occasional use, or a single visit? (This drives density and learnability.)

### 6.2 Information
8. What information exists for this screen (contract fields, policy values, synthetic fixtures)? What does not exist?
9. Which three facts matter most? Which ten matter at all? What is noise?
10. What is a summary, what is detail, and what is one click away?
11. What changes over time? What must show its freshness (as of when)?
12. What has states (empty, pending, blocked, failed, done) and how is each state said in words?
13. Which numbers need units, totals, comparisons or a reference? Which need none?
14. What must never be shown (secrets, other tenants' data, guesses presented as facts)?

### 6.3 Actions
15. What is the primary action? Is there one at all? What are the secondary ones?
16. Which actions are dangerous, irreversible or about money? What confirmation do they need, and what do they show before confirming?
17. Which actions are blocked, and does the screen say why and what unblocks them?
18. What is the next step after each action, and where does the person land?

### 6.4 Navigation and structure
19. How many destinations does this level need? Which are primary, secondary or tertiary?
20. Grouped by object, by task, by frequency or by role? Which grouping do the research and the people's mental model support?
21. Where does the person know where they are (title, highlight, breadcrumb)? How do they go back?
22. Visible or collapsible navigation? Fixed or scrolling? What happens on a phone?
23. What is the landing page, and why that one?
24. How are the mother sites told apart (owner versus agency versus seller) at a glance, without relying on colour alone?
25. Where do the account, the role, the workspace and sign-out live? Is the role shown, and why?

### 6.5 Hierarchy and composition
26. What is seen first, second and third? Does the eye path match the importance order?
27. How many sections, in what order, and why that order? What comes before what, and why?
28. Which section leads? Which can be dropped with no loss (if any, drop it)?
29. One column, split or grid? How many columns at each width?
30. Where is white space working, and where is it a hole?
31. Are like things alike, and different things visibly different?

### 6.6 Colour
32. What share of each colour family does this screen get, compared with the Home DNA, and why?
33. Where does wine appear: the one accent, a stamp, a band? How many times per screen height?
34. Which band follows which (base, sunken, accent, wine), and does each boundary separate two meanings?
35. Is any meaning carried by colour alone? (It must not be.)
36. Do status colours (danger, warning, success, info) keep their meaning everywhere and never decorate?

### 6.7 Typography
37. Which sizes from the scale, for which roles? Is there more than one size per role? (There must not be.)
38. Where is the two-weight headline used, and where not (tools versus pitch)?
39. What is the line length of every text block (target 45–75 characters)?
40. Do numbers use tabular figures where they are compared?

### 6.8 Space and rhythm
41. Is every spacing value on the scale? Are paddings equal where the owner asked (above and below a head)?
42. Is the vertical rhythm regular between sections, and within cards?
43. Do equal objects have equal sizes (equal cards, fixed actions at the foot)?

### 6.9 Objects, imagery, texture, illustration
44. Does this section need an object (a paper, ticket, stamp, pile, slip) to make its point? Which one says it best?
45. Is a texture under an object (never alone)? Which rock, and why?
46. Would a diagram, a chart, a table, an illustration, an animation or a short motion piece explain this better than words? Each is
    prototyped when the answer might be yes.
47. Is every image or illustration true to the product (no invented capability)?

### 6.10 Motion
48. Does anything move? In answer to what? Would the screen be worse without it?
49. Duration, easing, distance: are they the Home values? What is the reduced-motion version?
50. Does motion ever hide information or delay a task? (It must not.)

### 6.11 States and edge cases
51. Loading, empty (a brand-new account), error, denied, partial, stale, offline: is each drawn?
52. The longest name, a 9-digit number, a 0, a negative, 200 rows, one row: does the layout hold?
53. What does a person with only view rights see? An approver? A billing-only member?

### 6.12 Responsiveness and access
54. What changes at each of the 8 widths? Does the order stay meaningful on a phone?
55. Is everything reachable by keyboard in a sensible order, with visible focus?
56. Does every control and region have a name? Do headings form an outline without skips?
57. Does the screen work at 200% zoom and with reduced motion?

### 6.13 Words
58. Is every heading front-loaded and specific? Does any heading repeat another on the same screen?
59. Is the copy the owner's language (plain, no internal jargon such as "publication" or "envelope")?
60. Does it obey the copy lint (D-COPY-1 and A3: no "imported", no compatibility claims, no savings promises…)?

### 6.14 Consistency and fit
61. Does this pattern mean the same thing everywhere it appears?
62. Does the page still read as one thing when all its sections are seen together?
63. Does this mother site look like part of the same company as the other three?

### 6.15 Level-specific questions (added when a level is entered)

- **L1 (system):** What is shared across the four sites (shell, tokens, objects), and what is distinct (density, accent, landing)?
  How does a person move between them (sign in, switch workspace, role change)? Sign in, create account, reset password and accept
  invitation are the shared doorway of the three private sites: designed once, at L1, for all of them.
- **L2 (mother site):** Which pages exist and why? Which merge, split, appear, disappear? What is the nav? What is the landing? What
  does a brand-new account see?
- **L3 (page):** What are this page's 3 questions? Which sections answer them, in what order? Where are the primary actions?
- **L4 (section):** Which layout? Which components? What data, in which states?
- **L5 (detail):** Exact copy, number formats, icons, micro-interactions, pixel spacing.

Each screen gets a **brief**: the questions that apply, each with an answer and its evidence. The brief is written before any
alternative is built.

---

## 7. Research protocol

### 7.1 What to look for
Research is driven by the open questions of the current level. For each question family I write what I need to learn first, for
example "how many items do owner consoles put in their primary nav, and how do they group them?". Then I look for that, measure it and
record it.

### 7.2 Where to look (starting lists, widened as needed)

- **Owner console:**
  - payments and billing admins: Stripe Dashboard (docs and public screenshots), Paddle, Chargebee, Lemon Squeezy, Recurly;
  - revenue analytics: Baremetrics, ChartMogul, ProfitWell;
  - commerce admin: Shopify admin;
  - ops consoles: Vercel, Render, Railway, Heroku, Fly.io;
  - incidents and status: Sentry, PagerDuty, incident.io, Statuspage admin;
  - support: Intercom, Zendesk admin, Help Scout;
  - back-office and finance tools: Retool templates, Ramp, Mercury, Brex;
  - payroll and HR: Gusto, Deel;
  - analytics: PostHog;
  - marketplace or partner owner views.
- **Agency/company workspace:**
  - project tools: Linear, Asana, Monday, Height, Notion projects;
  - data pipeline UIs: Fivetran, Airbyte Cloud, Census, Hightouch, Flatfile spaces, OneSchema;
  - CRM admin: HubSpot and Salesforce setup and imports;
  - approval and review UIs: GitHub PRs, Figma reviews, DocuSign;
  - billing pages and team/settings patterns in the design systems below.
- **Seller portal:** partner and affiliate portals (HubSpot Partner Portal, Shopify Partners, Stripe Partners, PartnerStack, Impact,
  Reditus, Crossbeam, Rewardful, FirstPromoter, Tolt), commission statements, sales-enablement libraries (Highspot, Seismic).
- **Public site:** the round-2 and round-3 samples, widened per page type.
- **Design systems** (for anatomy, density and states): Shopify Polaris, GitHub Primer, IBM Carbon, Atlassian, Material 3, Microsoft
  Fluent, AWS Cloudscape, Salesforce Lightning, GOV.UK, Ant Design.
- **Evidence on behaviour:** NN/g (navigation, dashboards, data tables, forms, progressive disclosure, F and layer-cake scanning,
  cards), Baymard where relevant, WCAG 2.2.
- **Galleries:** only public ones that need no account. Mobbin and Page Flows require a sign-in, so they are not used.
- **Research is done per pattern and per page type, not per page.** A page links to the pattern research it uses (for example
  "dense tables", "money statements", "activity feeds", "approval flows") and adds only what is particular to it.

### 7.3 How each reference is recorded
A scorecard per reference:
- URL and date;
- what it is;
- structure and counts (nav items, sections, columns, elements per viewport);
- measured sizes and colours;
- density;
- the pattern it shows;
- what Kauro should take or avoid, and why;
- the evidence grade (A: study, B: established practice or design system, C: one product's choice).

Minimum samples:
- 15 or more references per mother site;
- 8 or more per page type;
- 5 or more per section pattern.

A finding counts as a pattern only when at least 3 independent references show it.

### 7.4 When references run out
When nothing comparable can be found:
1. **Blind concept agents.** Fresh-context agents with no Kauro history get a prompt I write: the problem, the constraints, the
   brand's colours and type, and "design three concepts". They return HTML/CSS concepts that compete like any other alternative.
2. **Images.** No image-generation tool is available in this session today. If one appears, it is used for mood and composition
   references only, never shipped.
3. **First principles.** I derive the design from the question bank and the Home DNA, and say so in the record.

---

## 8. The design cycle: down from general to specific, then back up

### 8.0 The system kit (L1.5) and its change control
Between the system (L1) and the mother sites (L2) sits the **kit**:
- **Inventory.** Every component the ~70 screens use: tables, status pills, money figures, forms, filters, empty states, toasts,
  dialogs, steppers, cards, charts, page heads and bands.
- **Tokens as one coded source:**
  - colour roles;
  - a designed type scale with two tiers (a **pitch** tier for the public site, a **tool** tier, denser, for the private sites);
  - spacing;
  - elevation;
  - motion.
- **Auditions.** One audition per component family, in the context of the vertical slice (§8.1).
- **One chart grammar**, shared by the web and the PDF: axes, labels, units, source lines, colour use and text alternatives. It has
  a dark variant (web) and a light variant (documents).
- **Light print tokens** for the documents and emails (deliverables plan §1.2), under the same change control.
- **One icon set**, chosen once.

The kit is then **frozen and versioned** (`docs/design/ROUND3-KIT.md` and the code in `packages/ui` and `apps/web`). Pages use
only kit parts.

**Change control.** A page that needs a new part, or a change to one, files a **system change request** in the kit record. When the
kit changes:
1. every finished screen is recaptured;
2. each recapture is visually diffed against the committed snapshot;
3. any screen with an unexpected difference is reopened.

This is how about 70 screens stay one system.

### 8.1 Down

- **L1, the system (all four sites together), chosen through a vertical slice.** Before the system concept is frozen, it is
  taken down to L4 on five representative screens, one per site plus one document page:
  - the owner console's landing;
  - a dense workspace project screen with a table;
  - the seller's Commissions;
  - one public page;
  - one page of the PDF report (a page with a chart), so the shared chart grammar and the light tokens are tested too.

  The current system (the incumbent) is always one of the candidate concepts. The system concept is chosen only after all five exist in
  each candidate concept. This way the least typical site cannot set the
  precedent alone.
  - Research the shared shell question: one product with four faces, or four products.
  - Decide what is shared (tokens, objects, shell skeleton, type scale) and what differs per site: density, how much wine and
    texture a tool page can carry, the landing type, the nav model.
  - Produce a one-page sketch per site (its feel, its nav model, its landing, its colour shares) as 3 competing system concepts, plus
    the incumbent system as a fourth, and choose one through the slice.
- **L2, one mother site.**
  - Page inventory (from §5, confirmed or changed with evidence), the function of each page, the nav (items, groups, order,
    visibility, account and role area), the landing, cross-links, and a brand-new account's first experience.
  - 3–4 nav versions and 2–3 inventory options compete.
- **L3, one page.**
  - The brief, then 3–4 complete compositions: the sections, their order, what comes before what and why, the primary action, density.
  - They compete as whole pages.
- **L4, one section.**
  - 4–6 variants per non-trivial section (layout, component, data presentation: table, list, chart, cards, timeline…), with an
    object or illustration where §6.9 says one might help.
- **L5, details.** Copy, numbers, icons, micro-interactions, motion pieces and pixel spacing, with alternatives where a choice is not
  obvious.

### 8.2 Up (making it all fit)

- **L5 → L4.** Every detail obeys its section's rhythm and the scales.
- **L4 → L3.** The winning sections are combined into page candidates. The top 2 of each section are permuted, within a budget of 8
  page combinations, and judged as whole pages. Whole-page checks:
  - colour shares against the DNA;
  - band order and contrast between neighbours;
  - no repeated headings or actions;
  - one primary action;
  - rhythm and white space;
  - the first viewport answers the brief's top questions.
- **L3 → L2.** All pages of the site seen together as a contact sheet:
  - the same pattern means the same thing everywhere;
  - nav states are right on every page;
  - the colour shares are consistent;
  - transitions between pages are logical.

  Then the whole site is walked as each persona from the review contexts.
- **L2 → L1.** After each mother site, it is re-checked against the system concept and the sites already done. After all four, the
  four are reviewed together (§10.6).

### 8.3 Alternatives and "auditions"
- Every decision at L1–L4 has at least 3 real alternatives, built and screenshotted at 1280 and 375. Most will have more, which adds up
  to hundreds of auditions across the job.
- Alternatives must differ in idea, not only in detail.
- Permutations: section winners × composition winners, as above.
- All alternatives live only in the review environment (`__variants` and `__review/auditions`), never in the product bundle.

---

### 8.4 Working smart (fast without losing depth)

- **Automate everything that is measured.** The tooling in §3 runs on every build. Briefs and research scorecards follow fixed
  templates, so they are quick to fill and easy to compare.
- **Parallel work in isolated git worktrees** under `Kauro.archive/Worktrees`:
  - research per mother site;
  - variant building per section;
  - the deliverables track.

  One integrator (this session) merges the results, so two writers never touch the same files.
- **Third-party opinions.** Fresh-context agents are used:
  - as blind judges (§9.4);
  - as concept generators when references run out (§7.4);
  - as outside critics: one per Tier A or Tier B page, one per site walk for Tier C (§11).
- **Depth where it pays.** More questions and alternatives go into the nav, landing pages, key sections and the first viewport. Fewer
  go into rare states and repeated patterns, which reuse a winner already chosen. The bar (§0) is the same for all.

## 9. How a winner is chosen (as objectively as possible)

### 9.0 Fidelity rises with the level
- **L1–L3 alternatives** are mid-fidelity, built at 1280 and 375, and judged on structure, hierarchy and answers.
- **The top two** then get the defect, accessibility and 8-width gates.
- **The winner** must reach the full bar (§0).

Rough ideas are not polished just to be eliminated.

### 9.1 The brief first
No alternative is judged before its brief (§6) is written.

### 9.2 The rubric (100 points)

| Criterion | Points | How it is measured |
|---|---|---|
| Task clarity | 20 | A fresh judge answers the brief's top questions from the screenshot; time-to-answer proxy (elements before the answer) |
| Hierarchy and scan path | 15 | Importance order versus visual weight order (size, contrast, position); squint test (blurred screenshot) |
| Kauro identity | 15 | Blur test against the site's DNA (same family); type and spacing on scale; vocabulary used correctly; colour shares justified by the brief (not by distance from Home) |
| Beauty and composition | 15 | Alignment to grid, balance, rhythm, purposeful white space, equal objects equal; judged pairwise by fresh judges with these named criteria |
| Accessibility | 10 | axe, contrast, targets, names, outline, keyboard, zoom, reduced motion |
| Responsiveness | 10 | All 8 widths free of defects, meaningful order on a phone |
| Consistency | 10 | Same pattern, same meaning, across the page, the site and the kit |
| Performance and calm | 5 | Element count, motion count, no layout shift, the site's performance budget |
| Truthfulness and limits | gate | Pass or fail: no invented capability or figure, no contract contradicted, no hard limit crossed |

Accessibility, Responsiveness and Performance (25 points) are scored by the tools (§3.1), not by judges looking at screenshots. At
mid-fidelity, before those tools run, the winning margin is computed on the other 75 points only.

### 9.3 Gates (eliminating; applied to the top two, §9.0)
A finalist is eliminated if any of these holds:
- any hard limit is crossed;
- any automated defect is found (§3);
- it fails the truthfulness gate;
- it fails the blur test against its site's DNA (§4);
- it adds content that is not finished to the same standard as the rest.

If every finalist fails the gates, the incumbent is kept and fixed up to the bar.

### 9.4 Blind pairwise judging, calibrated

**Calibration (before any judging).**
- A held-out set of at least 30 pairs with a known answer. None of them comes from the owner's taste file:
  - Home against degraded copies of Home (broken spacing, lost hierarchy, crowded sections, wrong contrast);
  - round-2 screens the owner rejected against the versions the owner then approved, where those exact pairs are not quoted in the
    taste file;
  - reference pages against deliberately degraded copies;
  - **subtle pairs**, where both sides are good and differ in taste or in hierarchy only, judged in advance by the round-2 records or
    by the owner's recorded words. Degraded copies alone only test obvious defects.
- A judge prompt is used only if it picks the known answer in at least 85% of the pairs. The owner's taste file then goes into every
  judge's prompt as guidance.
- **If no prompt reaches 85% after three revisions:**
  - the best prompt is used if it reaches at least 70%;
  - a win then needs 3 of 3 judges in both side orders;
  - the report says so.

  Below 70%, the incumbent stays everywhere, and my review (§9.5) decides only on the gates.

**The bracket.**
- A Swiss bracket only: about 3 rounds, each alternative meeting another with a similar record.
- Three fresh-context judges get each pair: anonymous screenshots at 1280 and 375, the brief and the rubric.
- Each pair is judged twice with the sides swapped. A judge that contradicts itself on a swap is discarded for that pair.
- **Each judge also scores the rubric on its own** (§9.2) for both alternatives.
- **Every bracket ends with a final match:** the bracket's winner meets the incumbent under the winning rule below.

**The incumbent.**
- The current design always competes, so "no change" can win.
- It is rendered at the same fidelity as the challengers (§9.0), so polish does not decide.
- For a screen that does not exist yet, the incumbent is its round-2 proposal if there is one, or else a baseline built only from kit
  parts.

**Winning.** An alternative replaces the incumbent only if it wins clearly:
- at least 2 of the 3 judges pick it in both side orders;
- its mean rubric score (over the judges' independent scores) leads by 5 points or more.

Any split, any smaller margin, any doubt: the incumbent stays. I do not overrule a split in favour of a challenger. This is also the
"clear win" that a change to Home needs.

**Ceilings on judge calls** (one call = one judge, one side order, one pair):
- 60 per decision (6 alternatives over 3 Swiss rounds, plus the final match);
- 700 per Tier A page (about 6 section decisions, the composition and up to 8 permutations);
- 250 per Tier B page;
- 20 per Tier C page.

Six calls of every page ceiling are held back for the final match. When a ceiling is reached mid-bracket, the current leader goes
straight to the final match against the incumbent.

The prompts are fixed and stored, so any judging can be repeated.

### 9.5 My review
I review the top two:
- in the browser at every width;
- with the states;
- inside the whole page.

I record the decision. I may set aside a bracket's winner only for a gate failure (§9.3) or a contradiction of its brief, both
written down; the next finalist then takes its place. The runners-up stay on the audition board.

---

## 10. The order of work, mother site by mother site

The owner left the order open ("owner, public, seller or agency, whatever"). The order below is chosen because:
- the owner console is judged best by its own user;
- the agency workspace has the most users and screens;
- the seller portal depends on decisions made in the owner console (sellers, payouts);
- the public site is done last, because its Sample delivery page shows the redesigned deliverables.

The deliverables track runs in parallel from the start. Its documents must be final before the workspace's delivery screens
(UI26–UI28) and the public Sample delivery page are finished.

### 10.0 Foundations (once, first)
1. Decisions register and the reconciled push instruction (§2).
2. The Day-0 feasibility check (§3.0).
3. The canonical fixtures (§2.1).
4. Voice and terms (§2.2).
5. Tooling (§3).
6. The "before" of every screen.
7. The Home DNA (§4).
8. L1 system concepts, each taken through the vertical slice (§8.1), and the choice.
9. The kit (§8.0), frozen.

**An early, non-blocking report** goes to the owner right after the vertical slice and the kit. Work does not stop. The owner can veto
the highest-leverage choice while it is still cheap to change.

### 10.1 Owner console (first, as the owner asked)
1. L2: page inventory and function, then the **nav** with 3–4 versions. This covers:
   - the title or identity;
   - the items and their groups;
   - visibility (fixed, collapsible or hidden);
   - the account area;
   - showing the role or not;
   - how the owner console is told apart from the other sites;
   - the phone version.
2. L3–L5 on the **landing page** (Today, overview, or whatever the research shows the owner needs first). Its questions include:
   - What must the owner know the moment they arrive?
   - What needs their decision?
   - What is at risk (money, deadlines, claims, incidents, deletions)?
   - What changed since the last visit?

   The recorded alert rules apply here (inactivity, deadlines, claims, pilot reviews).
3. Then every owner page in the nav's order (actions, finance, claims, payouts, sellers, jobs, deletion, incidents, releases, operating
   review, support operations, settings…). Each goes section by section, then as a whole page.
4. L3 → L2 review of the whole owner console (§8.2).

### 10.2 Agency/company workspace
The same steps, for every persona the review knows: the agency owner, the company buying direct, someone new arriving from
"Create account", and members with fewer rights (approver, billing, viewer). The same page may need different emphasis per persona. Its nav (task-based project navigation, already decided) is re-examined with evidence, not assumed. The project path
UI13–UI29 is treated as one journey: its stages are reviewed together, as How it works was.

### 10.3 Seller portal
The same steps. The money decisions are binding: both figures shown; invoicing is never collection; tax is never revenue; a collection
is never counted twice; retainer and offsets are shown with basis, amount and balance.

### 10.4 Public site, starting from Home
1. Home is audited first. Its pending items:
   - in "Services open for new projects", remove "Lowest starting price" and "Available", and fix the type sizes ("Clean your data"
     is too large);
   - the text, which the owner says may not be right;
   - any defect the checks find.

   The owner's corrections are applied as givens to the incumbent; they do not compete in auditions. Any other change to Home's design
   happens only through auditions it clearly wins.
2. Then every public page, applying the Home DNA:
   - restore wine where How it works and Supported services lost it, in the measured proportion;
   - Supported services: Limits of a project, and the closing band (to match How it works');
   - fix the head merging into the first section on Pricing, Sample delivery and Data handling;
   - the legal pages: layout only, never the versioned texts;
   - Help, Status, Contact, Communication preferences and Not found.

### 10.5 Quality beyond the visual (Tier A in full, others as the kit allows)
- **Interaction evidence.** Clickable flow prototypes for the journeys: the sign-in doorway, the project path UI13–UI29, payouts.
  Motion is auditioned from short screen recordings, not stills.
- **Simulated usability.** Persona walks (§3, item 10) on every Tier A page.
- **Accessibility beyond axe:**
  - touch targets of 44 px at phone widths (24 px is only the minimum);
  - forced-colours (Windows high contrast) mode;
  - text spacing (WCAG 1.4.12);
  - focus appearance (WCAG 2.4.11 and 2.4.13);
  - APCA contrast as information next to WCAG;
  - an accessibility-tree walk in reading order on each Tier A page (the screen-reader fallback, §3.0).
- **Internationalisation readiness:**
  - a pseudo-localisation pass with about 40% longer text;
  - number, date and currency formats by locale;
  - Unicode and right-to-left names from the fixtures;
  - font fallback for non-Latin scripts.

  The product stays in English.
- **Browsers and viewports:** Chromium, plus Firefox and WebKit if present (§3.0); 1366×768; phone landscape.
- **Handoff.** For every screen, a map from each element to the contract field that feeds it, or to its recorded gap, so the design
  can be built. The Home DNA grows into a full design-system specification.
- **A guided walk-through script** for the owner's final review: the route order, what changed and why.

### 10.6 All four together
- Contact sheets of all ~70 screens.
- Transitions walked: public → sign in → each workspace and back; switching workspace; role changes.
- Colour shares compared across the four sites.
- Pattern meanings checked across sites.
- A final round of fixes. Every changed screen goes back through §0.

---

## 11. Outside second opinion

One outside critic per Tier A and Tier B page, and one per site walk for Tier C, is played by a fresh-context agent. Codex is not
installed and needs a sign-in I may not do. If the owner sets it up, it takes this role.

## 12. Records

For every page, `Kauro.archive/Deliveries/Visual/order11/research/round3-<site>-<page>/` holds:
- `BRIEF.md`: the questions and their answers, with evidence;
- `RESEARCH.md`: scorecards, patterns, links and numbers;
- the alternatives' screenshots;
- `AUDITIONS.md`: the metrics, the judges' verdicts and the final reasoning;
- `NOTES.md`: the decision, what changed and the checks.

Tier C screens keep a single NOTES.md (decision, checks, the kit parts used).

Repository docs are updated as decisions land:
- amendments go in ORDER11-ROUND2-PUBLIC.md;
- new gaps go in ORDER11-FUNCTIONAL-GAPS.md;
- `HOME-DNA.md` and `ROUND3-DECISIONS-REGISTER.md` are kept current.

Each finished step is one local commit. Tests stay green at every commit (web unit, public browser suite, review tsc and inventory,
ui).

---

## 13. Progress ledger (so the work survives a lost context)

`docs/design/ROUND3-PROGRESS.md` is updated after every step:
- what is done to the bar;
- what is in progress and at which level;
- the next step;
- open questions;
- links to the records.

A new session reads it with this plan and continues exactly where the last one stopped.

**After any context compaction, the first action is to re-read this plan and the deliverables plan from the first line to the last**,
then the ledger, before any other step (owner, 2026-10-21).

**The review server** (127.0.0.1:4400) is started at 05:00 on 22 October 2026 and kept running until the work is finished. A rebuild
restarts it for about 10 seconds, so rebuilds are grouped to keep this rare.

---

## 14. Delivery

When a mother site, or the whole job, is finished:
- The review environment runs on 127.0.0.1:4400 with every screen.
- A gallery page (`/__review/round3`) shows, for every screen:
  - before and after at 1280 and 375;
  - its scores;
  - the runners-up;
  - links to its records.
- A short report says, honestly:
  - which screens reached the bar;
  - what changed in each mother site and why;
  - what needs the owner (decisions, amendments, the Codex permission, motion that breaks the Order 10 rule);
  - what is still open.

At the very end (everything finished): push once, CI green, merge PR #118, as pre-authorised (§1). The work does not stop between mother sites to wait for approval: each
report is written and the next mother site starts at once. The owner can interrupt, redirect or reject at any point, and a rejection
sends that piece back through the cycle.

---

## 15. Tiers, budgets and the end condition

- **Tier A, full depth:**
  - the navs of every site;
  - the landings;
  - the project journey UI13–UI29;
  - Home, Pricing, How it works, Supported services;
  - the owner's money and decision pages (finance, payouts, claims, owner actions);
  - the seller's Commissions;
  - the PDF report, the package's entry point and the importer guides (as in the deliverables plan §1.5).
- **Tier B:** 3 or more alternatives at the page level, with section auditions only for sections that are new. This covers the
  remaining pages that have their own content.
- **Tier C:** composed from the kit, with every gate and one critique per site walk. This covers the legal pages' layout, settings
  pages, Not found, communication preferences and rare states.

The bar (§0) is the same in every tier. Only the depth of the process differs.

**Budgets** (guides, not limits on quality):
- Foundations: about one working night.
- Each mother site: one to two working days.
- The deliverables track: in parallel.

**Over budget:** when a mother site passes twice its budget, I write a report (what is done, what is left, why) and re-plan the
remaining depth inside the tiers. The bar is not lowered, and the work continues.

**End condition:** every screen in the inventory and every deliverable has reached the bar, with the feasibility fallbacks where a
tool is missing (§3.0), and has a record, and the four sites have
been reviewed together. Only then the push and the merge (§1). If that takes more than one night, the work continues session after
session from the ledger. There is no partial push.

### 15.1 Scale and time, said plainly

The job is about 70 screens. Each has a brief, research, 3 or more alternatives per decision, judging and a whole-page review. Done to
this bar, that is far more than one night of work. The plan therefore runs in this order and reports at each mother site:

1. Foundations.
2. Owner console. The first night's target is Foundations, which include the vertical slice and the kit, and then as much of the
   owner console as reaches the bar. The budgets above are the guide.
3. Agency workspace.
4. Seller portal.
5. Public site.
6. All four together.

The depth never drops to save time. If time runs short, fewer screens are finished, never worse ones. Each report says exactly which
ones are done.

---

## 16. Out of scope

- Copy in languages other than English.
- (The deliverables are now in scope, under their own plan.)

## 17. What I will not do without the owner

- Push or merge before everything is finished (the final push and merge are pre-authorised, §1). Deploy.
- Install software (Codex included).
- Sign in anywhere.
- Change the cores, the backend, the money logic or the versioned legal texts.
- Edit the registry.
- Remove a recorded owner decision.

A design that seems to need one of these is drawn as a proposal and put to the owner in the report.
