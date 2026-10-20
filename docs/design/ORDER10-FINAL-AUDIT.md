# Order 10: final audit of the public web

**Date:** 2026-10-20.

**Build:** the candidate of PR #117 (branch `order10/web-typography`), served by the review environment (`tools/review/serve.mjs`).

**Evidence:** `C:\Users\migue\Kauro-visual-delivery\order10\`.
- Audit scripts: `tools/final-audit.mjs`, `tools/tool-audit.mjs`, `tools/axe-steps.mjs`, `tools/film-compare.mjs`.
- Raw results: `final-audit.json`.
- Comparison sheets: `crops/cmp-step*.png`.

## Verdict

The visual work is finished and technically clean:
- no page breaks, overflows, errors, fails accessibility, or depends on anything outside the site;
- every text was reviewed.

The web is **not yet releasable**, for reasons outside the visual work:
- the legal pages cannot publish until the operator's company facts exist;
- the site is set not to be indexed;
- "Sign in" leads to a page that belongs to the private screens, the next front;
- several wording changes need the owner's decision, because the authority documents (A3) or the registry fix the current wording.

None of these blocks moving on to the private screens.

## What was checked, and the result

| Check | Scope | Result |
| --- | --- | --- |
| Page status, console errors, requests to other origins, horizontal overflow, text cut by its box, one h1 | 14 pages × 5 publication states (open, limited, clean, none, broken) × 5 widths (320, 375, 768, 1280, 1920) × 2 themes: 300 combinations | **0 issues** |
| Accessibility, axe WCAG 2.2 A/AA | every page and state at 375 and 1280 px in both themes; every step of How it works on Home in both themes | **0 violations**. One contrast fault was found and fixed: the Sealed stamp in clay on the light paper is now wine. |
| Links and assets | every href and src on every page: 28 targets, same-page anchors included | All answer, except **`/login` (404 on the public origin)**. See open items. No link leaves the site. |
| Without JavaScript | 14 pages | Every page shows its heading and content. |
| Less motion asked for | Home, How it works, Data handling, Status | Nothing animates. |
| Keyboard | How it works on Home | The arrows, the six marks and "Watch the process" can be reached and used; focus is visible. |
| How it works card (Home) | 13 screen sizes, from 320×640 to 2560×1400, every step | **0 issues**: nothing cut or outside the card, the card and the controls never move, the space equals the tallest step, and the bottom margin equals the side margin. |
| Film fidelity (Home) | page against the film at the same moments of each step | Same moments, effects and durations. The only differences are the ones the owner asked for. |
| Unit, end-to-end and gate tests | web 333, UI 59, end-to-end 54, architecture gate | **all pass** |

## Fixed in this pass

**Home, How it works card:**
- It runs the film's own timeline at the film's speed, with one second after each step instead of about three; the whole process takes about 42 s.
- The state chip turns green when a stage is finished, as in the film.
- The import order is plain text.
- No highlight flashes on renamed values.

**Home, the quote step had two errors:**
- It counted only the contacts file. It now counts both sealed files: 12,480 + 3,204 = **15,684 billable source units**, the unit Pricing defines.
- It was priced as CLEAN although the project shown is an import into a CRM (associations, import order, the team's account). It is now priced as **HubSpot (USD 1,295)**, the same band.

**Pricing estimator:**
- 500,001–1,000,000 units read "This band is not offered at launch.", with no next step.
- Above 1,000,000 units the text suggested a larger project was easier to buy.
- Both now say: "At launch a project holds up to 500,000 billable source units. If yours is larger, ask in writing."

**Sample:**
- The report intro called a duplicate candidate "a pair", but the table counts groups. It now says "group".
- The manifest trace skipped source rows. Output 1,205 now comes from source 1,205 plus 1,207, unified with approval.

**Other pages:**
- **Contact:** the confirmation and the failure message gave two different rules for a resent inquiry. Both now say the same inquiry is never recorded twice.
- **Status:** the page description promised a reading time the page no longer shows. It now describes what the page shows.
- **Data handling:** "Minimized" corrected to "Minimised"; the site uses British spelling.

## Open items

### Release blockers (not visual)

1. **Legal pages.** All operator facts (`operator-facts.json`) are empty, so Terms, Privacy and Data processing answer "Not published" (503). This needs the operator company's real details.
2. **Indexing.** The root layout sets `robots: noindex, nofollow` for the whole public site. Decide when it is lifted (launch).
3. **Sign in.** The header's "Sign in" goes to `/login`, which is a private screen (the next front, as a prototype). On the public origin it answers 404 until that screen exists, or until the deployment names the app's own origin.
4. **Data processing terms.** They list "activity records" as data processed, while Supported services says activities are not included. Legal wording, versioned with a digest: decide which is true and re-issue.

### Owner decisions

The text review proposes the changes below. Each one needs a decision, because an authority document, the registry or a versioned guide fixes the current wording.

**Home:**
- **"Request a free data health check" goes to sign-in.** A3 3.2 says it leads to the fit form, then account creation. Either point it to Contact, or record that it goes to sign-in.
- **Repeated "no obligation to buy".** The closing paragraph repeats the hero note.

**Visible jargon:**
- "Capability publication", "Publication version …", "qualified destination", "Kauro qualifies imports", "safe templates", "bounded", "the server prices".
- These appear on Supported services, Status, Pricing and Help, and much of this wording comes from A3's prescribed sentences.
- Proposal: plain buyer language with the same meaning. This needs an A3 amendment.

**Status:**
- "That is not a statement that none is open" alarms visitors. Proposal: "Incidents are not listed on this page yet. If something is not working for you, contact us."
- "Contact support" opens the sales form. Proposal: "Write to us."

**Contact:**
- The h1 is a warning, and files are warned against four times on the page. Proposal: "Tell us about your project."; the h1 is fixed by the registry.
- "Fit inquiry" as the form's heading. Proposal: "Your project".
- The in-house answer ("A company working on its own data") differs from A3 3.7's wording.

**How it works page:** left untouched at the owner's request. It has three problems of its own:
- its lead "you decide at each one" contradicts its own card, where Kauro acts at steps 02 and 05;
- its quote counts 12,480 units, where the right figure is 15,684;
- its window approves "214 records", where Home approves 2.

The owner's pending decision (keep it, rebuild it as technical, or retire it) settles these.

**Help:**
- The file limits leave out the 5 GB limit for the whole set.
- A few phrases are hard to read.
- Help paragraphs are versioned, so a change means a new guide version.

**Optional polish** (about 25 small items: redundancy, tone, consistent terms such as "target" and "destination"): listed in the review notes. None is wrong; each would read better.

## Recommendation

Approve the visual state of the public web and move on to the private screens. The release blockers and decisions above do not depend on the visual work:
- **Before launch:** take the A3 and registry wording decisions in one sitting.
- **For publication:** provide the operator's facts.
