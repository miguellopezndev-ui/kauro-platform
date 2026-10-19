# Design ledger: what was designed with the owner, and what was not

This file separates the surfaces of Kauro the owner has designed and reviewed together with Claude from those that were only restyled,
or not touched. Anything that is **not** in the first list was not designed together. That includes a screen, file or message added
later by anyone (Claude included): treat it as unreviewed until it is added here after a review.

The visual authority is [KAURO_VISUAL_IDENTITY.md](KAURO_VISUAL_IDENTITY.md) (decision record: A10, `docs/authority/amendments/A10_VISUAL_IDENTITY.md`, §1–§9; per-screen coverage: [KAURO_SCREEN_COVERAGE.md](KAURO_SCREEN_COVERAGE.md)). The short version:

- Palette carbon `#242426`, porcelain `#F8F6F3`, wine `#653A46`, clay `#C4A693`. Wine leads where a page has one point.
- One physical object per idea (a window, card, sheet or ticket), drawn from the product, sized to its content, slightly off square,
  with depth.
- A stamp only where a verdict belongs.
- No type bigger than its meaning, no panel with an empty half, nothing that follows the reader down the screen, no gradients or fake
  dashboards.
- Everything readable without the script, AA contrast in both themes, no horizontal scroll at 320 px.

Last updated: 2026-10-18, integration of identity v1.0 (branch `design/visual-identity-integration`).

## 1. Designed together (reviewed by the owner)

Status key: **approved** means the owner said it is right; **revised** means it was rebuilt after the owner's feedback and is waiting
for the next review.

| Surface | Piece | Status |
| --- | --- | --- |
| Whole site | Palette, light and dark themes, theme switch, typography and weight contrast | approved |
| Whole site | The agreed faces on the web, every document including the legal pages and the implemented application screens: Inter, Inter Italic for notes, JetBrains Mono (Order 10); tables of four columns stacked on phones; narrow-screen fixes of the hero window, the document pile and the journey sheet's heads | implemented 2026-10-19, owner visual review pending (Order 10 gallery) |
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
| Sample delivery | Clay head with the report cover on rock, the report, the manifest, the guide | designed in passes 3–4; not yet reviewed in detail. The report sheet and its cover follow report template 2 (2026-10-18). |
| Package report (PDF) | Template 2: the agency's brand leads, verdict label, summary panel, counts as outcomes over their total, banded tables, running footer; Inter and JetBrains Mono embedded (`packages/reports/src/html.ts`, `docs/design/REPORT-REDESIGN-PROPOSAL.md`) | approved by the owner as a visual proposal (2026-10-18); implemented in phase B |
| Data handling | Carbon head with the index, the "Not found" answer, the redacted file, the retention table | designed in pass 4; not yet reviewed in detail |
| Contact | Wine "what happens next" aside, form fields in pairs | revised |
| Status | One panel with a lamp beside each state | revised |
| Help | Head, index of guides, guides | designed in pass 3; not yet reviewed in detail |
| Unsubscribe | Compact head and the opt-out form | designed in pass 3; not yet reviewed in detail |
| Legal pages | Not-published card (the 404 card, stamped "Not published") | revised |
| Legal pages | A published document's reading layout | restyled only (no document is published yet to review) |

## 2. Implemented by Claude — owner review pending

The owner could not open these screens: there is no sign-in yet, for the owner or for sellers, and some features are still locked for
external reasons. Claude implemented the approved identity on them. They use its tokens, typography and components, the restyled app
shell (`apps/web/src/shell`) and the application register of KAURO_VISUAL_IDENTITY.md §10.

Claude checked every state their unit tests render, in the real stylesheets: both themes, 320/375/768/1280 px, and axe. Claude fixed
what those checks showed (commit `01d6c820`). They stay **pending the owner's review** until the owner can sign in and look at them.

| Screen | Route |
| --- | --- |
| UI14 Sources | `/agencies/{agencyId}/projects/{id}/sources` |
| UI15 Table selection | `/agencies/{agencyId}/projects/{id}/sources/selection` |
| UI16 Seal | `/agencies/{agencyId}/projects/{id}/sources/seal` |
| UI18 Free data health check | `/agencies/{agencyId}/projects/{id}/audit` |
| UI23 Quote and purchase | `/agencies/{agencyId}/projects/{id}/purchase` |
| UI24 Payment | `/agencies/{agencyId}/payments/{orderId}` |
| UI25 Processing | `/agencies/{agencyId}/projects/{id}/processing` |
| UI30 Billing | `/agencies/{agencyId}/billing` |
| UI32 Settings | `/agencies/{agencyId}/settings` |
| UI52 Support | `/agencies/{agencyId}/support` |
| UI39 Company finance (operations) | `/ops/finance` |

The sign-in flow (UI50) and the other 30 registered screens are not built yet. When they are, they follow the identity and enter this
list as "implemented, owner review pending".

## 3. Not designed yet (planned next)

- **The package files** written by the Migration Core 3.0.0 (CSV, Markdown, JSON): audited for structure only, with no change
  (`docs/design/DELIVERABLES-STRUCTURE-AUDIT.md`). Any change is a future core release, decided by the owner.
- **Deliverables specified but not implemented** (`docs/design/DELIVERABLES-INVENTORY.md` §2): not to be built under the 2026-10-18
  scope decision. If built later, they follow KAURO_VISUAL_IDENTITY.md §13.
- **Outgoing messages**: emails and notifications (`apps/api/src/outreach`, `apps/control/src/consumers`).

## 4. Done for future work

- **Guidance for Claude Code:** `CLAUDE.md` at the repository root makes KAURO_VISUAL_IDENTITY.md mandatory for new screens, requires
  every new screen in the coverage document and in this ledger, and reserves identity changes for the owner.
