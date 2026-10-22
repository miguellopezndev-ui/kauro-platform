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

This file is the plan I follow without needing the owner between gates. It is written so that a fresh session can resume it from the
progress ledger (§13).

---

## 0. What "perfect" means here (the bar every screen must pass)

A screen is done only when all of these hold:

1. **It answers its questions.** Every question in its brief (§6) has an answer on the screen, at the place a reader looks for it.
   "Which questions does this screen answer in the first viewport?" has a written answer. A fresh-context judge confirms it from a
   screenshot alone.
2. **It won its auditions.** Its composition, every section and every non-trivial component beat at least two real alternatives:
   - first through the metric gates (§9.3);
   - then in blind pairwise judging (§9.4);
   - then in my own review against the rubric.

   The runners-up are kept.
3. **It is Kauro.**
   - Its colour shares sit within the tolerance of the Home DNA (§4), or the record says why this kind of screen differs.
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
8. **It has a record:**
   - the questions and their answers;
   - the research with links and numbers;
   - the alternatives with screenshots;
   - the scores;
   - why it won.

**Honesty clause.** The morning report states exactly which screens reached this bar and which did not. Nothing below the bar is
called finished.

---

## 1. Hard limits (never crossed, whatever a design suggests)

These carry over from the owner's standing instructions and the authority:

**Code and data**
- Frontend and design only. Migration Core, Intelligence Core, money, ledger, reconciliation, quotes, taxes and backend authorisation
  are not modified.
- Versioned legal texts are not changed outside their procedure.
- The contracts registry (`packages/contracts/registry/screens.json`) is never edited. A change to a screen's primary copy, route or
  function is an amendment (R2-x) in ORDER11-ROUND2-PUBLIC.md, or a proposal (P-xx) in the review.
- No new backend reads are invented. A screen that needs data no contract gives is drawn as a proposal and recorded as a functional gap.

**Security and services**
- No AWS, no external service is run, no deployment, no secrets, no cards, no credentials.
- A configuration screen never shows the value of a secret.
- Third-party sign-ins are the owner's and read-only. I never sign in to anything.

**Review environment**
- The review routes (`__review`, `__variants`, `__as`) never enter the product bundle. A test already guards this and stays green.

**Git**
- Commits are local, one per finished step.
- PR #118 is pushed once, only when the owner says everything is perfect. It is never merged without the owner's approval, and there
  is no auto-merge.

**Theme, language and people**
- The theme is dark only.
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

---

## 3. Tooling built first (so everything can be measured, not judged by eye alone)

These are scripts in the session scratchpad, plus pages in the review environment only:

1. **Capture harness.** Every screen × every scenario state × 8 widths (320, 375, 414, 768, 1024, 1280, 1440, 1920), full page and
   first viewport, plus 200% zoom at 1280.
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
   reasons, and runs round-robin tournaments.
9. **Visual diff,** before and after, for every screen.

---

## 4. The Home DNA (the reference, measured, and itself audited)

Home is measured and codified in `docs/design/HOME-DNA.md`. Every value has a number and a tolerance:

- **Colour.**
  - The share of each colour family on the whole page and in the first viewport, at 1280 and 375.
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
- **Galleries for visual quality:** Mobbin, Page Flows and SaaS UI galleries. I use only the public pages, I never sign in, and screen
  galleries behind an account are skipped.

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

### 8.1 Down

- **L1, the system (all four sites together).**
  - Research the shared shell question: one product with four faces, or four products.
  - Decide what is shared (tokens, objects, shell skeleton, type scale) and what differs per site: density, how much wine and
    texture a tool page can carry, the landing type, the nav model.
  - Produce a one-page sketch per site (its feel, its nav model, its landing, its colour shares) as 3 competing system concepts, and
    choose one.
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
  four are reviewed together (§10.5).

### 8.3 Alternatives and "auditions"
- Every decision at L1–L4 has at least 3 real alternatives, built and screenshotted at 1280 and 375. Most will have more, which adds up
  to hundreds of auditions across the job.
- Alternatives must differ in idea, not only in detail.
- Permutations: section winners × composition winners, as above.
- All alternatives live only in the review environment (`__variants` and `__review/auditions`), never in the product bundle.

---

## 9. How a winner is chosen (as objectively as possible)

### 9.1 The brief first
No alternative is judged before its brief (§6) is written.

### 9.2 The rubric (100 points)

| Criterion | Points | How it is measured |
|---|---|---|
| Task clarity | 20 | A fresh judge answers the brief's top questions from the screenshot; time-to-answer proxy (elements before the answer) |
| Hierarchy and scan path | 15 | Importance order versus visual weight order (size, contrast, position); squint test (blurred screenshot) |
| Home fidelity | 15 | Colour-share delta from the DNA; type and spacing on scale; vocabulary used correctly |
| Beauty and composition | 15 | Alignment to grid, balance, rhythm, purposeful white space, equal objects equal; judged pairwise by fresh judges with these named criteria |
| Accessibility | 10 | axe, contrast, targets, names, outline, keyboard, zoom, reduced motion |
| Responsiveness | 10 | All 8 widths free of defects, meaningful order on a phone |
| Consistency | 5 | Same pattern, same meaning, across the page and the site |
| Performance and calm | 5 | Element count, motion count, no layout shift |
| Truthfulness and limits | gate | Pass or fail: no invented capability or figure, no contract contradicted, no hard limit crossed |

### 9.3 Gates (eliminating)
An alternative is eliminated if any of these holds:
- any hard limit is crossed;
- any automated defect is found (§3);
- it fails the truthfulness gate;
- its colour shares are off the DNA by more than the tolerance without a written reason.

### 9.4 Blind pairwise judging
- Three fresh-context judges get each pair: anonymous screenshots at 1280 and 375, the brief and the rubric. Each picks one and says
  why.
- A round-robin gives the ranking.
- Where the judges disagree, I decide and record my reason.
- The judges' prompts are fixed and stored, so the judging can be repeated.
- Every pair is judged twice with the sides swapped, to cancel position bias. A judge that contradicts itself on a swap is
  discarded for that pair.

### 9.5 My review
I review the top two:
- in the browser at every width;
- with the states;
- inside the whole page.

I choose and record the decision. The runners-up stay on the audition board.

---

## 10. The order of work, mother site by mother site

### 10.0 Foundations (once, first)
Decisions register (§2), tooling (§3), capture of the "before" of every screen, Home DNA (§4), L1 system concepts and the choice (§8.1).

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

   Its design changes only through auditions it clearly wins.
2. Then every public page, applying the Home DNA:
   - restore wine where How it works and Supported services lost it, in the measured proportion;
   - Supported services: Limits of a project, and the closing band (to match How it works');
   - fix the head merging into the first section on Pricing, Sample delivery and Data handling;
   - the legal pages: layout only, never the versioned texts;
   - Help, Status, Contact, Communication preferences and Not found.

### 10.5 All four together
- Contact sheets of all ~70 screens.
- Transitions walked: public → sign in → each workspace and back; switching workspace; role changes.
- Colour shares compared across the four sites.
- Pattern meanings checked across sites.
- A final round of fixes. Every changed screen goes back through §0.

---

## 11. Outside second opinion (at most once per page)

- **Codex is not installed on this PC** (checked 21 October 2026). Installing it means downloading and running software, which needs
  the owner's explicit permission. It also needs a sign-in or an API key, which I may not enter.
- **If the owner installs and signs in to Codex themselves:** Codex reviews each finished page once (screenshots, the brief and the
  rubric). Its critique is recorded and acted on when it holds up.
- **Otherwise (the default):** a fresh-context Claude agent plays the same role, once per page, with the same inputs. It is a different
  reader from the judges in §9.4: it critiques the chosen page and does not choose between alternatives.

---

## 12. Records

For every page, `Kauro.archive/Deliveries/Visual/order11/research/round3-<site>-<page>/` holds:
- `BRIEF.md`: the questions and their answers, with evidence;
- `RESEARCH.md`: scorecards, patterns, links and numbers;
- the alternatives' screenshots;
- `AUDITIONS.md`: the metrics, the judges' verdicts and the final reasoning;
- `NOTES.md`: the decision, what changed and the checks.

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

Nothing is pushed until the owner says everything is perfect. The work does not stop between mother sites to wait for approval: each
report is written and the next mother site starts at once. The owner can interrupt, redirect or reject at any point, and a rejection
sends that piece back through the cycle.

---

## 15. Scale and time, said plainly

The job is about 70 screens. Each has a brief, research, 3 or more alternatives per decision, judging and a whole-page review. Done to
this bar, that is far more than one night of work. The plan therefore runs in this order and reports at each mother site:

1. Foundations.
2. Owner console (the first night's target: foundations plus the owner console, complete).
3. Agency workspace.
4. Seller portal.
5. Public site.
6. All four together.

The depth never drops to save time. If time runs short, fewer screens are finished, never worse ones. Each report says exactly which
ones are done.

---

## 16. Out of scope

- The PDF deliverables (the report and package documents, which keep Inter) and email templates. They are not screens of the four
  sites. A change to them is proposed, not made.
- Copy in languages other than English.

## 17. What I will not do without the owner

- Push, merge, deploy.
- Install software (Codex included).
- Sign in anywhere.
- Change the cores, the backend, the money logic or the versioned legal texts.
- Edit the registry.
- Remove a recorded owner decision.

A design that seems to need one of these is drawn as a proposal and put to the owner in the report.
