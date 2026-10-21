# Order 11: final delivery (draft, ready for the owner's walk)

The ten points the owner's mandate asks for at the end of Order 11. This is a draft written when the work was complete; it is finalised
after the owner walks the experiences and gives corrections. Status words: IMPLEMENTED (real components with review data), PROTOTYPE
(designed, not wired to the api), PROPOSED (needs a registry addition or a backend capability), BLOCKED EXTERNAL (needs a provider).

## 1. The four ways in

Start the review on the owner's machine (`node tools/review/serve.mjs`), then open `http://127.0.0.1:4400/__review/private`:

| Experience | Link | Starts at |
| --- | --- | --- |
| Public site | `/` | The approved Order 10 home page; Sign in opens the review's sign-in. Proposals: `/__variants/...` (point 6). |
| Agency or company | `/__as/agency` · `/__as/company` · `/signup?review-as=newcomer` | Lena Ortiz's workspaces (Northwind Data); Halden Outdoor, a company buying direct; someone new from Create an account. |
| Kauro owner | `/__as/owner` | Today, the operations console. |
| Seller | `/__as/seller` | Today, the sales console (Daniel Kim). |

Each page is reached through the menus and links, with the browser's back and forward; the strip at the top says who you are and lets you
change person or state. Every screen also stays reachable on its own from the index.

## 2. Pages by role

| Role | Pages (status) |
| --- | --- |
| Visitor | Home, How it works, Supported services, Pricing, Sample delivery, Data handling, Help, Contact, Service status, three legal documents (approved Order 10). Variants: Supported services, Check a file free, For agencies, Pricing, Contact, header and footer (PROPOSED). |
| Newcomer | Create an account P-05 (PROPOSED), Sign in UI50 (BLOCKED EXTERNAL), Reset password P-06 (PROPOSED), Set up UI09 (PROTOTYPE), Your workspaces UI10 (PROTOTYPE). |
| Agency or company member | Projects UI11, Clients UI12 (agencies only), Overview UI13, Destination UI17, Fields UI19, Duplicates UI20, Links UI21, Approval UI22, Delivery UI26, Import UI27, Import results UI28, Data and deletion UI29, Team UI31, Invitation UI51 (PROTOTYPE); Files UI14, Selection UI15, Seal UI16, Health check UI18, Processing UI25, Quote UI23, Payment UI24, Billing UI30, Settings UI32, Support UI52 (IMPLEMENTED); Health check results P-07, Activity P-08, Billing overview P-09, Personal settings P-01, Organisation P-02 (PROPOSED). What each role may do (owner, admin, operator, approver, billing, viewer) is said on Team and enforced by the server. |
| Kauro owner | Today UI33, Owner actions UI38, Jobs UI40, Deletion UI41, Incidents UI42, Releases UI43, Operating review UI44, Support cases UI55, Prospects UI34, Agency relationship UI35, Commissions UI36, Seller lifecycle UI37, Resources UI53, Outreach UI54 (PROTOTYPE); Company finance UI39 (IMPLEMENTED); Owner settings P-04 (PROPOSED). |
| Seller | Today UI33, Prospects UI34, Commissions UI36, Resources UI53, Outreach UI54 (PROTOTYPE); Seller settings P-03 (PROPOSED). |

The ten questions for every page are answered in `ORDER11-PAGE-ANALYSIS.md`; who arrives, why and where they go next, in
`ORDER11-PAGE-MAP.md`.

## 3. Design decisions and their reasons

`ORDER11-DESIGN-DECISIONS.md` (words, page structure, navigation, the journey, identity and recovery, the public site, visual identity),
and `ORDER11-OVERNIGHT-DECISIONS.md` (N-01 to N-39, each with its reason and how to reverse it).

## 4. New pages, sections and functions

- Pages: P-01 Personal settings, P-02 Organisation, P-03 Seller settings, P-04 Owner settings, P-05 Create an account, P-06 Reset
  password, P-07 Health check results, P-08 Activity, P-09 Billing overview; public variants for Check a file free and For agencies.
- Navigation: the project's areas under Projects in the menu, with a contextual progress line in each project page (areas apart named as
  such); the owner's ways into the agency relationship and the seller's page.
- Functions drawn: estimate after the check kept apart from the quote and the payment; request changes on a plan; recovery started by an
  admin and decided by checks; copy buttons for bank details; refund request after its terms; claim decisions for the owner; questions on
  a commission line; service-aware screens for Clean your data, Prepare for HubSpot and Prepare for Salesforce.

## 5. Removed or reworked

`ORDER11-REVIEW-LOG.md`, "Defects found and fixed" (D-05 to D-29), lists each item with the file, what was wrong and what changed:
among them invented values and placeholders removed, figures reconciled with the public report and the price list, one date format,
orphan pages connected, pre-ticked consent boxes unticked, a seller's access to company finance closed in the review, a phone table that
broke words letter by letter.

## 6. Public-site proposals, kept apart

At `/__variants/...`, each under a ribbon linking the approved page; the approved Order 10 pages are unchanged in main:
Supported services (three cards, new names), header and footer, Check a file free, For agencies, Pricing (included and excluded, questions),
Contact (the §8.1 authorisation, "Email address").

## 7. Capabilities that need the backend

`ORDER11-FUNCTIONAL-GAPS.md`: F-01 CLEAN asks for a destination contract it should not need; F-02 approval and quote as one moment; F-03
self-serve free check (changes A3 §3.2); F-04 findings read; F-05 estimate read; F-06 activity read; F-07 sign-in, sign-up and recovery as
decided; F-08 the Data Processing Policy page; F-09 output preferences for Clean your data; F-10 a list of quotes and orders. Plus the
findings in the review log (D-04, D-UI09-2, D-UI11-1, D-P01-4, D-P03-1).

## 8. Audit results

Automated, on the final build, every screen in every state and person at 320, 375, 768, 1280 and 1440 px in both themes (status, console
errors, outside requests, overflow, text cut or squeezed, one h1, axe WCAG 2.2 AA at 375 and 1280, reduced motion, keyboard):

| Group | Screens and proposals | Cases | Issues |
| --- | --- | --- | --- |
| A | 10 | 1,120 | 0 (10 expected by design) |
| B | 20 | 2,180 | 0 |
| C | 4 | 450 | 0 |
| D | 7 | 370 | 0 |
| E | 10 | 450 | 0 |
| Public variants | 5 | 50 | 0 |

Motion and keyboard checks: none failing. The checks grew during the night (text squeezed letter by letter or poured into a strip, content
hidden in an inner sideways scroll), each after a defect the eye found and the audit had missed; the figures above are with all of them.

Human inspection: every page at 1280 and 375 px, light and dark, recorded with the corrections in the review log. Tests: web 336, design
system 60, review inventory 2, review type-check clean.

## 9. Decisions for the owner

The adoption of the public variants; F-03 (self-serve start); F-08 (the Policy's page); F-10; the footer's legal entity and year; the open
questions recorded in the research (free-check pause rule, founding display, identity provider).

## 10. Nothing was merged

PR #118 is a draft; nothing was merged into main, and nothing is merged until the owner has walked the experiences, given corrections and
approved the exact commit.
