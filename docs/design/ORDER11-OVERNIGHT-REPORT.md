# Order 11: overnight report (2026-10-20 21:14 to 2026-10-21 05:45)

The owner asked for the work to continue unattended until 05:45, with no questions: decide, choose the best option, record each decision,
and at the end push everything, stop the review server and report. Frontend only. This is that report. Nothing was merged.

## 1. What was done

All commits are on `order11/private-review` (draft PR #118), pushed:

| Commit | What |
| --- | --- |
| 13433fae | Group B: service-aware project screens; one date format; the review quote's terms hash; CLEAN delivery text; duplicates as cards on a phone. |
| b71f2347 | Groups C and D: Quote, Payment and Billing reworked (real screens); P-09 billing overview proposed (gap F-10); the seller screens corrected and connected. |
| 47dd861b | Group E: the owner's console corrected; Finance fit for phones and refused to anyone but the owner. |
| 2e742d03 | The ten questions answered for every page; project areas apart; support hours and UTC; email code wording. |
| ee6e82df | Public-site variants beside the approved site (/__variants): Supported services with three cards, header, footer, Check a file free, For agencies. |
| b82f2274 | Pricing and Contact variants; the proposed site links its own variants. |

Every private page was inspected by eye at desktop and phone widths, in both themes, and fixed where needed; then audited automatically.

### Group C (quote, payment, billing; real screens)
- The quote now says what it covers and what it does not, names its issue date and price list, gives the tax line its treatment, shows
  every discount the server sends (one used to read "No discount"), explains how payment works in three steps, and gives one reason
  under a disabled button.
- The payment page has copy buttons on every bank detail, states the booking-time and matching rules before anything is sent, gives the
  ACH timing, links to its project, moves the 36-character order id to the foot, and says the next step once the payment is confirmed.
- Billing opens the refund form only on request, after the refund terms and the defect route; uses the design system's fields; links
  the project; and, without an order, leads to the projects instead of ending. The overview a workspace needs is drawn as P-09.

### Group D (sales and sellers)
- The agency relationship and the seller's page had no way in; now they are linked where their names appear.
- The owner's Prospects shows each seller and decides claims (the owner no longer sees "Claim this prospect").
- A commission line is asked about from its own row; the payout schedule is stated; the figures follow the price list.
- Outreach: the blocked draft is its own message; editing an approved one sends it back to review.

### Group E (owner and operations)
- Today, Owner actions, Operating review, Jobs and Owner settings now agree with the pages they point to; an invented tax obligation
  and an unsourced tax claim were removed.
- Finance (a real screen) no longer squeezes its table letter by letter on a phone, and anyone but the owner gets one clear refusal.

### Across the application
- One date format everywhere (the design system's), and support in UTC with its hours stated in both zones.
- Activity and Data and deletion no longer pass for steps of the project.
- The automated audit now also catches text squeezed letter by letter, the defect that had escaped it.

### Public site: proposals only, beside the approved site
Open the review index, section "Public-site proposals". Each variant has a ribbon and a link to the approved page; the approved Order 10
pages and the application's bundle are untouched.
- Supported services, "Availability now" as three cards with the new service names.
- A header with the pages in one line and one "Check a file free" button; a footer listing every page.
- The "Check a file free" page (your answer 7; it changes A3 §3.2, F-03).
- The "For agencies" page (only the statements and limits of your answer 8; branded reports shown as not available yet).
- Pricing with what the price includes and ten questions answered from existing rules.
- The contact form with the required authorisation of the Data Processing Policy §8.1 and "Email address".

## 2. Decisions taken overnight

Thirty-nine, each with its reason and how to reverse it, in `docs/design/ORDER11-OVERNIGHT-DECISIONS.md` (N-01 to N-39). The ones that
matter most for you:

1. **Dates:** one format in the application, the design system's ("Oct 20, 2026, 1:00 PM UTC"). The public site keeps its own until you
   decide.
2. **A founding discount is never named:** a non-repeat discount reads "Discount (N%)" (D-COPY-1 keeps the founding line hidden until B10).
3. **Payment page rules:** the matching and booking-time rules (ToS §8.2, §8.3) and Wise's ACH timing are stated before sending.
4. **Support in UTC**, with the hours in both zones; it was the only page in Bogotá time.
5. **Finance is refused to anyone but the owner** in the review, as the server would; a seller could read it before.
6. **No invented obligations:** the "quarterly sales tax return" example became "the next tax return", dated by the accountant.
7. **Public variants live at /__variants**, review only, in the public frame.
8. **"Availability now" as three cards**: the earlier A10 versions were not better (all spread the services apart); three equal cards let
   a buyer compare by reading across.

## 3. What remains

| Item | Estimate |
| --- | --- |
| Your walk through the four experiences and the variants, and your corrections | your time |
| Corrections from your walk | depends on them |
| Final delivery document (the ten points of the mandate) | 1 to 2 h |
| Independent review and CI with the Windows label | 1 to 2 h |

The page analysis, groups A to E, the public proposals you listed and the audits are done.

## 4. Decisions for you

- F-03: should "Check a file free" become the main call to action and open a self-serve start (changes A3 §3.2)?
- Which public variants to adopt into the approved site.
- F-08: the Data Processing Policy needs a public page; the registration and contact forms link it.
- F-10: a read listing the workspace's quotes and orders, for the billing overview (P-09).
- The legal entity and year for the footer's bottom line.
- The open questions recorded earlier (free-check pause rule, founding display, identity provider).

## 5. For the folder reorganisation

- `C:\Users\migue\Kauro` holds the one repository (`.git`). Every `Kauro-orderN`, `Kauro-review`, `Kauro-design`, `Kauro-eperm*`,
  `Kauro-winflakes*` and the `*-review` folders are git worktrees of it: move them with `git worktree move` (or remove them with
  `git worktree remove`), never by dragging the folder, or the repository loses track of them.
- `Kauro-order11` is in use (PR #118, branch `order11/private-review`). Everything in it is pushed.
- `Kauro-visual-delivery\order11` is a plain folder, not in git: the research, the screenshots and the audit tools of Order 11. Keep it;
  the tools refer to `C:\Users\migue\Kauro-order11` by absolute path and need their paths updated after a move.
- The review server was stopped at the end of the night.
