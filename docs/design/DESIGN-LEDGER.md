# Design ledger: what was designed with the owner, and what was not

This file separates the surfaces of Kauro the owner has designed and reviewed together with Claude from those that were only restyled,
or not touched. Anything that is **not** in the first list was not designed together. That includes a screen, file or message added
later by anyone (Claude included): treat it as unreviewed until it is added here after a review.

The design language every surface follows is A10 (`docs/authority/amendments/A10_VISUAL_IDENTITY.md`, §1–§8). The short version:

- Palette carbon `#242426`, porcelain `#F8F6F3`, wine `#653A46`, clay `#C4A693`. Wine leads where a page has one point.
- One physical object per idea (a window, card, sheet or ticket), drawn from the product, sized to its content, slightly off square,
  with depth.
- A stamp only where a verdict belongs.
- No type bigger than its meaning, no panel with an empty half, nothing that follows the reader down the screen, no gradients or fake
  dashboards.
- Everything readable without the script, AA contrast in both themes, no horizontal scroll at 320 px.

Last updated: 2026-10-18, fifth pass plus motion and tilt (A10 §9; branch `design/kauro-visual-refresh`).

## 1. Designed together (reviewed by the owner)

Status key: **approved** means the owner said it is right; **revised** means it was rebuilt after the owner's feedback and is waiting
for the next review.

| Surface | Piece | Status |
| --- | --- | --- |
| Whole site | Palette, light and dark themes, theme switch, typography and weight contrast | approved |
| Whole site | Header with the menu card (no numbers, quiet type, dimmed page) | revised |
| Whole site | Footer (small wordmark, tagline, links) | approved |
| Whole site | Motion: first impression, arrival, response; alternating card tilts | revised |
| Home | Hero: product window on rock, margin notes, stamp | approved |
| Home | Facts strip | approved |
| Home | Process: one file walked through Measure, Decide, Prepare, Import | revised |
| Home | Buyers: two cards under the "same price" stamp | revised |
| Home | Delivery: the pile of four documents and its list | revised (the document animation was approved) |
| Home | Limits: the permissions panel locked on Never | revised |
| Home | Services: the board, CLEAN on wine | revised |
| Home | Wine context band | approved |
| Home | Closing ticket on darkened rock | approved |
| Not found (404) | Tilted lookup card with its stamp | approved |
| How it works | Wine head with the "who acts" card, steps beside their panes, carbon closing band | revised |
| Supported services | Compact head, three equal cards with CLEAN on wine, scope, limits, wine band | revised |
| Pricing | Ladder, band table, units, estimator, discounts | designed in passes 3–4; not yet reviewed in detail |
| Sample delivery | Clay head with the report cover on rock, the report, the manifest, the guide | designed in passes 3–4; not yet reviewed in detail |
| Data handling | Carbon head with the index, the "Not found" answer, the redacted file, the retention table | designed in pass 4; not yet reviewed in detail |
| Contact | Wine "what happens next" aside, form fields in pairs | revised |
| Status | One panel with a lamp beside each state | revised |
| Help | Head, index of guides, guides | designed in pass 3; not yet reviewed in detail |
| Unsubscribe | Compact head and the opt-out form | designed in pass 3; not yet reviewed in detail |
| Legal pages | Not-published card (the 404 card, stamped "Not published") | revised |
| Legal pages | A published document's reading layout | restyled only (no document is published yet to review) |

## 2. Restyled only (new tokens and shell, never designed together)

These pages took the palette, the themes and the restyled app shell (`apps/web/src/shell`) automatically. Nobody has designed their
layout or content with the owner. They need a session in which we can sign in locally and see them.

- Signed-in agency app: `billing`, `payments/[orderId]`, `projects/[id]/audit`, `projects/[id]/processing`, `projects/[id]/purchase`,
  `projects/[id]/sources`, `projects/[id]/sources/seal`, `projects/[id]/sources/selection`, `settings` and `support` (under
  `apps/web/src/app/(app)/agencies/[agencyId]/`).
- Operations: `ops/finance` (`apps/web/src/app/(ops)/`).
- The sign-in flow and any identity-provider screens.

## 3. Not designed yet (planned next)

- **The deliverables**: the report as HTML and PDF (`packages/reports/src/html.ts`, `pdf.ts`; `docs/design/B13-report-pdf.md`), the
  CSV files and the package manifest (`packages/reports`), and the import steps.
- **Outgoing messages**: emails and notifications (`apps/api/src/outreach`, `apps/control/src/consumers`).
- **Guidance for future work**: a short rule in the repository's instructions telling Claude to follow A10 and to add any new surface
  to this ledger as "not designed together" until the owner reviews it.
