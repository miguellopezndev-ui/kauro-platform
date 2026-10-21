# Order 11: overnight report (2026-10-20 21:14 to 2026-10-21 05:45)

The owner asked for the work to continue unattended until 05:45, with no questions: decide, choose the best option, record each decision,
and at the end push everything, stop the review server and report. Frontend only. This is that report. **Nothing was merged.**

## 1. What was done

Every commit is on `order11/private-review` (draft PR #118), pushed:

| Commit | What |
| --- | --- |
| 13433fae | Group B: service-aware project screens; one date format; the review quote's terms hash; CLEAN delivery text; duplicates as cards on a phone. |
| b71f2347 | Groups C and D: Quote, Payment and Billing reworked (real screens); P-09 billing overview proposed (gap F-10); the seller screens corrected and connected. |
| 47dd861b | Group E: the owner's console corrected; Finance fit for phones and refused to anyone but the owner. |
| 2e742d03 | The ten questions answered for every page; project areas apart; support hours and UTC; email code wording. |
| ee6e82df, b82f2274 | Public-site variants beside the approved site (/__variants): Supported services, header and footer, Check a file free, For agencies, Pricing, Contact. |
| ed9b0792, d5b8bd4f | The final delivery draft (the mandate's ten points) and the audit figures. |
| 2a59bcd4, 2655deff | Incidents' quiet state, the contact authorisation's layout, Fields as cards until its table fits. |
| e537050b | Fixes from an independent review of the real screens (nine defects). |
| bc07ea94 | Fixes from an independent fact-check of the prototypes and variants (fifteen claims). |

### Group C (quote, payment, billing; real screens)
- The quote says what it covers and what it does not, names its issue date and price list, gives the tax line its treatment, shows every
  discount the server sends (one used to read "No discount"), explains how payment works, and under a disabled button asks to accept the
  terms only when that is what is missing, never inviting a second payment.
- The payment page has copy buttons on every bank detail, states before sending that the credit in Kauro's account is what counts and that
  a different amount, reference or payer is returned, gives the ACH timing, links to its project and to the order's billing, and once paid
  leads to the preparation with the order in hand.
- Billing opens the refund form on request, after the refund terms and the defect route, with focus where the person is; without an order
  it leads to the projects. The overview a workspace needs is drawn as P-09.

### Group D (sales and sellers)
- The agency relationship and the seller's page had no way in; now they are linked where their names appear.
- The owner's Prospects shows each seller and decides claims; a commission line is asked about from its own row; the payout schedule is
  stated; the figures follow the price list.

### Group E (owner and operations)
- Today, Owner actions, Operating review, Jobs and Owner settings agree with the pages they point to; invented obligations and claims were
  removed.
- Finance (a real screen) no longer breaks its table letter by letter on a phone, and anyone but the owner gets one clear refusal.

### Across the application
- One date format everywhere; support in UTC with its hours in both zones, holidays excluded.
- Activity and Data and deletion no longer pass for steps of the project.
- The automated audit now also catches text squeezed letter by letter or poured into a strip, and content hidden in an inner sideways
  scroll: each was found by eye first.

### Two independent reviews
- **The real screens** (apps/web): nine defects, all verified and fixed. The most important: the link to the preparation led to an empty
  page; the pay hint could invite a second payment; the "send by" rule was worded against ToS §8.2.3.
- **Every claim in the prototypes and variants** (rules, periods, prices, limits, promises), checked against the terms, the policy and the
  code: fifteen unsupported or contradicted, all corrected (time promises, who sees Billing, a seller notice period, a monitoring
  interval, a recovery veto, a machine size, an "introductory discount" that never existed, and more). The prices, deletion periods, quote
  validity, links, limits, commission dates, invitations, sessions and roles were confirmed.

### Public site: proposals only, beside the approved site
Open the review index, section "Public-site proposals". Each variant has a ribbon and a link to the approved page; the approved Order 10
pages and the application's bundle are untouched.
- Supported services, "Availability now" as three cards with the new service names.
- A header with the pages in one line and one "Check a file free" button; a footer listing every page.
- The "Check a file free" page (your answer 7; it changes A3 §3.2, F-03).
- The "For agencies" page (only what your answer 8 allows; branded reports shown as not available yet).
- Pricing with what the price includes and ten questions answered from existing rules.
- The contact form with the required authorisation of the Data Processing Policy §8.1 and "Email address".

## 2. Decisions taken overnight

Fifty-three, each with its reason and how to reverse it, in `docs/design/ORDER11-OVERNIGHT-DECISIONS.md` (N-01 to N-53). The ones that
matter most:

1. **Dates:** one format in the application, the design system's ("Oct 20, 2026, 1:00 PM UTC"); the public site keeps its own until you
   decide.
2. **A founding discount is never named:** a non-repeat discount reads "Discount (N%)" (D-COPY-1).
3. **Payment rules stated before sending** (ToS §8.2, §8.3), and the next step after paying.
4. **Support in UTC**, hours in both zones, holidays excluded.
5. **Finance refused to anyone but the owner** in the review, as the server would.
6. **No invented obligations or promises:** the fact-check removed every claim no source supports.
7. **Public variants at /__variants**, review only, in the public frame.
8. **"Availability now" as three cards:** the earlier versions were not better; three equal cards let a buyer compare by reading across.

## 3. Audit results (final build)

| Group | Screens and proposals | Cases | Issues |
| --- | --- | --- | --- |
| A | 10 | 1,120 | 0 (10 expected by design) |
| B | 20 | 2,180 | 0 |
| C | 4 | 450 | 0 |
| D | 7 | 370 | 0 |
| E | 10 | 450 | 0 |
| Public variants | 5 | 50 | 0 |

Every screen in every state and person, at 320, 375, 768, 1280 and 1440 px, in both themes: status, console errors, outside requests,
overflow, text cut or squeezed, content hidden sideways, one h1, axe WCAG 2.2 AA at 375 and 1280, reduced motion and keyboard. Tests: web
337, design system 60, review inventory 2; type-checks clean. CI does not run while the PR is a draft (its own rule); I left the draft as
it is.

## 4. What remains

| Item | Estimate |
| --- | --- |
| Your walk through the four experiences and the variants, and your corrections | your time |
| Corrections from your walk | depends on them |
| Final delivery document (drafted: `ORDER11-FINAL-DELIVERY.md`) | under 1 h after your walk |
| CI with the Windows label once the PR leaves draft | about 1 h |

## 5. Decisions for you

- F-03: should "Check a file free" open a self-serve start (changes A3 §3.2)?
- Which public variants to adopt into the approved site.
- F-08: the Data Processing Policy needs a public page; the registration and contact forms link it.
- F-10: a read listing the workspace's quotes and orders, for the billing overview (P-09).
- The legal entity and year for the footer's bottom line.
- The questions recorded earlier: the free-check pause rule, the founding discount's display, the identity provider.

## 6. For the folder reorganisation

- `C:\Users\migue\Kauro` holds the one repository (`.git`). Every `Kauro-orderN`, `Kauro-review`, `Kauro-design`, `Kauro-eperm*`,
  `Kauro-winflakes*` and `*-review` folder is a git worktree of it: move them with `git worktree move` (or remove them with
  `git worktree remove`), never by dragging the folder, or the repository loses track of them.
- `Kauro-order11` is in use (PR #118, branch `order11/private-review`); everything in it is committed and pushed.
- `Kauro-visual-delivery\order11` is a plain folder, not in git: Order 11's research, screenshots and audit tools. Keep it; the tools
  refer to `C:\Users\migue\Kauro-order11` by absolute path and need their paths updated after a move.
- The review server was stopped at the end of the night; it starts again with `node tools/review/serve.mjs` from `Kauro-order11`.
