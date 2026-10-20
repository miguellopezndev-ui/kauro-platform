# Order 10: final audit of the public web

**Date:** 2026-10-20.

**Build:** the candidate of PR #117 (branch `order10/web-typography`), served by the review environment (`tools/review/serve.mjs`).

**Evidence:** `C:\Users\migue\Kauro-visual-delivery\order10\`.
- Audit scripts: `tools/final-audit.mjs`, `tools/tool-audit.mjs`, `tools/axe-steps.mjs`, `tools/film-compare.mjs`, `tools/how-motion.mjs`, `tools/how-guide-shots.mjs`.
- Raw results: `final-audit.json`.
- Shots of the How it works guide: `how-guide/` (desktop and phone, light and dark).

## Verdict

The public web is technically clean and visually finished apart from How it works (UI02), which waits for the owner's look; it is **not ready for production**. Known blockers remain (section 3), and
none of them is visual. PR #117 is merged only after the owner's look at the How it works guide (review log, row 25).

## 1. Public design

| State | Pages |
| --- | --- |
| Reviewed by the owner during Order 10, every change asked for made (review log, rows 1 to 24; Home's How it works: "todo está perfecto" apart from the timing fixed in row 24) | Home, with How it works as a section and its film timeline; Supported services; Pricing; Sample delivery; Data handling; Contact; Service status; Communication preferences; Help; Not found |
| Waiting for the owner's look | **How it works (UI02) as the buyer's guide** (row 25). Row 24 (one second after each step on Home, the film's exact timeline) is part of the same look. |

**How it works, as built for that look:**
- **Kept:** the route `/how-it-works`, the identifier UI02, the h1 from the registry, the wine head and the card of who acts.
- **Motion:** the card no longer settles on arrival; it only straightens under the pointer. Nothing plays on arrival or on scroll, and the
  second long animation of the process is removed.
- **The guide:** an index beside six stage sheets. Each stage has the same five fields: who acts, what it needs, what happens, what you get
  and what stops it. The six stages cover:
  - files and how the scope is determined;
  - the free data health check, what it reports and its limits;
  - the client's decisions and approval;
  - price, quote and payment confirmation;
  - preparation and verification before release;
  - delivery, import and the client's responsibilities.
- **Worked example:** two ledgers built from the synthetic sample.
- **Ending:** the responsibility band, with **Request a free data health check** (to the fit form) and **Review supported services**.
- **Different from Home**, which tells the process as a film. This page is the reference behind it, in the language of Help: an index, ruled
  sheets and ledgers.

## 2. Integrated and verified code

| Check | Scope | Result |
| --- | --- | --- |
| Unit tests (web) | copy and contracts: lint, placeholders, dead messages, registry h1, routes, links, structure. Pricing and synthetic figures: bands, estimator, sample reconciliation, the guide's three counts. Guide digest. | **334 of 334 pass** |
| UI and architecture | UI package tests; architecture gate | **59 of 59 pass**; **no violation** |
| End-to-end | every public page, both themes, axe in the browser | **54 of 54 pass** |
| Page status, console errors, requests to other origins, horizontal overflow, text cut by its box, one h1 | 14 pages × 5 publication states × 5 widths (320 to 1920) × 2 themes: 300 combinations | **0 issues** |
| WCAG 2.2 AA (axe) | every page and state at 375 and 1280 px, both themes; every step of Home's How it works, both themes | **0 violations** |
| Links and assets | every href and src on every page (28 targets, same-page anchors included, the guide's six stage anchors among them) | All answer, except **`/login` (404)**: see section 3 |
| Without JavaScript | 14 pages | Every page shows its heading and content. The guide needs no script at all. |
| Less motion asked for | Home, How it works, Data handling, Status | Nothing animates |
| Motion allowed | How it works, scrolled from top to bottom | **Nothing plays** |
| Home regression | Home's How it works card at 13 sizes, every step; keyboard | **0 issues**; the arrows, marks and play button work and show focus |
| CI | Ubuntu and Windows | Run on the pushed candidate; the result is recorded in the PR |

**Fixed in this order's last round:**
- **How it works, the three discrepancies:**
  - the lead no longer says "you decide at each one" (Kauro acts at stages 02 and 05);
  - the example counts both sealed files, **15,684 billable source units**, priced from the policy: HubSpot, the band up to 50,000, USD 1,295;
  - approved proposals, duplicate groups and unified rows are now separate. The example shows **207 duplicate candidate groups holding 428
    contacts**, **200 groups your team approved to unify (7 kept apart)**, and **214 contact rows unified** (253 company rows). A test
    reconciles the three counts with the report and the manifest. Home's five-row example (three proposals, one pair) is unchanged.
- **How it works, wording aligned with the contracts:**
  - there is no quote before the plan is approved;
  - a payment counts only once matched to the exact amount; it is no longer "confirmed by the payment provider" (Payments V1);
  - the check's result is shown in the project; no downloadable report is promised;
  - the team starts the preparation and Kauro runs and checks it;
  - for CLEAN, no CRM-specific steps; no HubSpot or Salesforce procedure is presented as universal;
  - the price figure and every other figure come from the policy snapshot, the input limits or the sample. No number is typed into a
    component.
- **Home:** both calls to action, **Request a free data health check**, now lead to the fit form (`/contact`), as A3 3.2 requires. They no
  longer go to sign-in.
- **Help:** the file limits now name the 5 GB limit for the set and the 500,000 billable source units; "Pay for a project" no longer says
  a payment is confirmed by the payment provider (Payments V1: the launch route is a reconciled bank transfer). It now says the payment is
  confirmed once Kauro has matched the money received to the exact amount, and names no route. Guide version 1.3, with its new digest
  recorded.
- **Independent review of the candidate** (one must-fix, six should-fix, nits), applied:
  - the excluded data on How it works is no longer a closed list: it adds other sensitive personal data and points to the service terms
    for every excluded category;
  - the stages name no destination (A3 3.3: only the capability publication does, on Supported services). The invented example names its
    service from the sample's mode;
  - stage 01 states the account and onboarding that come after the fit form;
  - the check is started by the team and run by Kauro (CMD020);
  - the three counts stay in the contacts file; the companies file is folded into the note under the price;
  - the index numbers are hidden from screen readers;
  - a new version of the files, not "files changed", after an approval;
  - the policy figure of one check at a time is no longer typed into the copy;
  - a ledger figure wraps below 75rem;
  - dead CSS from the removed animation is gone (seven keyframes, the fragments, a stale comment).

  The card of who acts keeps its pointer response, as every card on the table does.
- **End-to-end accessibility check, an intermittent contrast failure on Home** (1 run in 4).
  - **Cause:** axe sometimes ran while step 01 of Home's walk was still fading its rows in from opacity 0, so it measured a half-transparent
    row.
  - **Proof:** `order10/tools/flake-proof.mjs` fails 5 times out of 5 when axe runs mid-fade, and is clean 5 times out of 5 once the page
    has settled.
  - **Fix:** the check now waits, on every frame, until no finite animation on the document's clock is running. It waits for a condition,
    never for a fixed time, and nothing in the check was loosened. Scroll-driven and paused animations are not waited for.
  - **Result:** 8 consecutive runs of the suite, all 54 tests passing each time. Home itself is unchanged.
- **Removed:** `how-flow.tsx`, its CSS and three fragments only it used.
- **Kept from earlier rounds:** the pricing estimator above the launch envelope, the sample's "group" and consecutive trace, the Contact
  resend rule, the Status description, and "Minimised".

**Authorities:** no versioned contract was edited.
- The registry entry UI02 is met as written:
  - *information*: upload, the check, the agency's decisions, validation, payment, preparation and the customer's import, kept separate;
  - *actions*: review supported services and start the fit assessment;
  - *exceptions*: no diagram implies that software approves or that Kauro writes to a production CRM.
- A3 is met as written: 3.2 (the call to action and a bounded check), 3.3 (duplicate candidates and unification with approval), 3.6 (no
  fixed duration).
- No new capability, no new font, no authentication change and no private feature.

## 3. Real publication blockers

1. **Legal documents.** All operator facts (`operator-facts.json`) are empty, so Terms, Privacy and Data processing answer "Not published"
   (503). They need the operator company's real details.
2. **Data processing terms, LC-1.** The terms list "activity records" as data processed, while Supported services says activities are not
   included. This is recorded for a versioned re-issue in `docs/design/LEGAL-CORRECTION-REQUESTS.md`. No legal text was changed.
3. **Indexing.** The root layout sets `robots: noindex, nofollow` for the whole public site. It is lifted at launch.
4. **Sign in and authentication.** The header's "Sign in" goes to `/login`, a private screen of the next front. On the public origin it
   answers 404 until that screen exists, or until the deployment names the app's own origin. No bypass or hidden entrance was added.

The calls to action no longer depend on sign-in: they lead to the fit form.

## 4. Legal or functional items outside this order

Every open item from the previous audit is classified here. **Resolved** ones are listed in section 2.

| # | Item | Kind | Who decides | State |
| --- | --- | --- | --- | --- |
| O-1 | Home's call to action went to sign-in (A3 3.2) | copy and contract | — | **Resolved**: to the fit form |
| O-2 | Help's limits left out the 5 GB set | versioned guide | — | **Resolved**: guide 1.2, then 1.3 |
| O-3 | How it works: the lead, the units, approved versus unified | copy | — | **Resolved** (row 25) |
| O-4 | Data processing terms: activity records (LC-1) | legal | counsel, at the next re-issue | Recorded; blocker 2 |
| O-5 | Help, "Pay for a project": "confirmed by the payment provider" and "if a payment page closes" followed the hosted-checkout design that Payments V1 superseded for launch | versioned guide, payments | — | **Resolved**: guide 1.3 names no route. ACH stays unnamed until it is proven on the real account. |
| O-6 | Data that must not be uploaded: the lists on Help and Data handling (credentials, card data, health data) are narrower than ToS 5.2, which also excludes sensitive data and data of children and adolescents | legal and copy | counsel and owner | Open for Help and Data handling. How it works already says "such as" and points to the service terms. |
| O-7 | Paid enrichment: ToS 3.5 says Kauro does none, while Supported services says it stays off unless the customer enables a supported setting | legal | counsel | Open |
| O-8 | Where the free check pauses: A3 3.2 says at 90% of the ceiling; ToS 3.3 says when the budget is exhausted; the policy has no key for 90% | authority | owner (A3) and counsel | Open. The site states neither. |
| O-9 | The downloadable health check report is specified but not built (UI18 is a screen) | functional | private screens | Open. The site promises no download. |
| O-10 | Every delivered report is refused until the issuer's legal identity is recorded (B13) | legal and operator | operator | Open; same facts as blocker 1 |
| O-11 | `guides.ts` and `help.tsx` cite "A3 3.8", but A3 ends at 3.7 | code comment | — | Open. The right section is to be confirmed, not guessed. |
| O-12 | Visible jargon ("capability publication", "qualified destination", "bounded", "the server prices"), much of it A3's prescribed sentences | copy | owner (A3 amendment) | Open; the guide avoids these words where it is free to |
| O-13 | Status: "That is not a statement that none is open"; "Contact support" opens the sales form | copy | owner | Open |
| O-14 | Contact: the h1 is a warning (registry); "Fit inquiry"; the in-house answer differs from A3 3.7 | copy and registry | owner | Open |
| O-15 | Home: "no obligation to buy" repeated in the closing paragraph | copy | owner | Open (optional) |
| O-16 | About 25 small polish items (redundancy, tone, "target" against "destination") | copy | owner | Open (optional); listed in the review notes |

## Recommendation

1. The owner looks at the How it works guide on the review server: desktop and phone, light and dark.
2. On approval, merge PR #117 at the approved SHA and check CI on main.
3. Before launch:
   - provide the operator's facts (blockers 1 and 2, item O-10);
   - take the A3 and registry wording decisions in one sitting (O-5 to O-8, O-12 to O-16);
   - lift noindex;
   - build the sign-in front.
