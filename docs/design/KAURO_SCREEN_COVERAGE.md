# Kauro screen coverage of the visual identity

Generated from `packages/contracts/registry/screens.json`, `apps/web/src/screens.ts` and `apps/web/src/screens/implemented/` on the integration
branch `design/visual-identity-integration` (cut from `main` ac6340965c098f3d0a1ed24d45ff4cbd49593b1e; `main` 66423d92 with Order 8 incorporated once). Every new screen is added here when it is built
(see `CLAUDE.md`).

- Registered screens: **55**. Implemented: **24**. Pending (registered, not built): **31**.
- Implemented screens on the approved design: **24 of 24**.
- A pending screen is not a page: it has no route file, and it is not counted as covered. When it is built it follows
  [KAURO_VISUAL_IDENTITY.md](KAURO_VISUAL_IDENTITY.md).

## Review status

- **Owner-supervised:** the owner saw and reviewed these pages during the design rounds (2026-10-17/18). These are the public site, the
  not-found page and the not-published legal card.
- **Implemented by Claude, owner review pending:** the signed-in app (agency) and internal operations screens. The owner could not open
  them, because there is no sign-in yet for the owner or for sellers. They carry the approved tokens, typography, components and shell.
  Claude checked every state their tests render, in the real stylesheets (light and dark; 320/375/768/1280 px; axe), and fixed what that
  showed. The owner still has to look at them when sign-in exists.

## Matrix

| ID | Screen | Route | Origin | State | Rendered by | Design | Shared components | States checked | Review |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| UI01 | Home | `/` | PUBLIC | Implemented | app/(public)/page.tsx → public/pages/home.tsx, journey.tsx, audience.tsx, package-folder.tsx | New design | PageHead, Section, LinkButton, artifacts, journey, pile, board | public pages: light + dark, menu open, 320/375/768/1280, axe 0, overflow 0; every journey step with approvals on/off; every pile document | Owner-supervised (seen and reviewed by the owner) |
| UI02 | How it works | `/how-it-works` | PUBLIC | Implemented | app/(public)/how-it-works/page.tsx → public/pages/how-it-works.tsx | New design | PageHead (wine), Section, artifacts (Pane, Counts, Approval, Reconcile, ImportOrder) | public pages: light + dark, menu open, 320/375/768/1280, axe 0, overflow 0 | Owner-supervised (seen and reviewed by the owner) |
| UI03 | Supported services | `/supported-services` | PUBLIC | Implemented | app/(public)/supported-services/page.tsx → public/pages/supported-services.tsx | New design | PageHead, Section, ServiceState, artifacts | public pages: light + dark, menu open, 320/375/768/1280, axe 0, overflow 0; publication read / unavailable (unit tests) | Owner-supervised (seen and reviewed by the owner) |
| UI04 | Pricing | `/pricing` | PUBLIC | Implemented | app/(public)/pricing/page.tsx → public/pages/pricing.tsx, band-estimator.tsx | New design | PageHead, Section, DataTable, PriceFigure, estimator form | public pages: light + dark, menu open, 320/375/768/1280, axe 0, overflow 0; estimator states (unit tests) | Owner-supervised (seen and reviewed by the owner) |
| UI05 | Sample delivery | `/sample-delivery` | PUBLIC | Implemented | app/(public)/sample-delivery/page.tsx → public/pages/sample-delivery.tsx | New design | PageHead (clay), DataTable, Stamp, MarginNote | public pages: light + dark, menu open, 320/375/768/1280, axe 0, overflow 0 | Owner-supervised (seen and reviewed by the owner) |
| UI06 | Data handling | `/security` | PUBLIC | Implemented | app/(public)/security/page.tsx → public/pages/security.tsx | New design | PageHead (inverse), Section, DataTable, answer stamp, redacted file | public pages: light + dark, menu open, 320/375/768/1280, axe 0, overflow 0 | Owner-supervised (seen and reviewed by the owner) |
| UI07 | Contact | `/contact` | PUBLIC | Implemented | app/(public)/contact/page.tsx → public/pages/contact.tsx, inquiry-form.tsx | New design | PageHead, wine aside, form fields, Panel | public pages: light + dark, menu open, 320/375/768/1280, axe 0, overflow 0; form errors/outcomes (unit tests) | Owner-supervised (seen and reviewed by the owner) |
| UI08 | Service status | `/status` | PUBLIC | Implemented | app/(public)/status/page.tsx → public/pages/status.tsx | New design | PageHead, status panel (paper) | public pages: light + dark, menu open, 320/375/768/1280, axe 0, overflow 0; unavailable publication (unit tests) | Owner-supervised (seen and reviewed by the owner) |
| UI09 | Agency setup | `/onboarding` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI10 | Agency switcher | `/agencies` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI11 | Projects | `/agencies/{agencyId}/projects` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI12 | Clients | `/agencies/{agencyId}/clients` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI13 | Overview | `/agencies/{agencyId}/projects/{id}` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI14 | Source intake | `/agencies/{agencyId}/projects/{id}/sources` | APP | Implemented | (app)/…/projects/[id]/sources/page.tsx → screens/sources/containers.tsx, view.tsx (SourcesView, UploadFacts) | New design | shell, StatusBadge, Table, Button, StatePanel | gallery: 29 sources renders (PENDING, RESTRICTED, INTEGRITY_FAILURE, uploads, blockers); light + dark; 320/375/768/1280; axe 0; overflow 0 | Implemented by Claude — owner review pending (not reachable without sign-in) |
| UI15 | Selection | `/agencies/{agencyId}/projects/{id}/sources/selection` | APP | Implemented | (app)/…/sources/selection/page.tsx → screens/sources/view.tsx (SelectionView) | New design | shell, StatusBadge, fields, Button | as UI14 (selection renders); heading order fixed (h3/h4) | Implemented by Claude — owner review pending (not reachable without sign-in) |
| UI16 | Seal review | `/agencies/{agencyId}/projects/{id}/sources/seal` | APP | Implemented | (app)/…/sources/seal/page.tsx → screens/sources/view.tsx (SealView) | New design | shell, Measures, Table, Button | as UI14 (seal renders) | Implemented by Claude — owner review pending (not reachable without sign-in) |
| UI17 | Target setup | `/agencies/{agencyId}/projects/{id}/target` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI18 | Audit | `/agencies/{agencyId}/projects/{id}/audit` | APP | Implemented | (app)/…/projects/[id]/audit/page.tsx → screens/health-check/container.tsx | New design | shell, Banner, StatusBadge, Measures, StatePanel | gallery: 19 renders (LOADING, PENDING, STALE, EXPIRED, INTEGRITY_FAILURE); light + dark; 4 widths; axe 0; overflow 0 | Implemented by Claude — owner review pending (not reachable without sign-in) |
| UI19 | Mapping | `/agencies/{agencyId}/projects/{id}/plan/mapping` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI20 | Identity | `/agencies/{agencyId}/projects/{id}/plan/duplicates` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI21 | Relationships | `/agencies/{agencyId}/projects/{id}/plan/relationships` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI22 | Approval | `/agencies/{agencyId}/projects/{id}/plan/approval` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI23 | Quote | `/agencies/{agencyId}/projects/{id}/purchase` | APP | Implemented | (app)/…/projects/[id]/purchase/page.tsx → screens/payments/containers.tsx (quote-view) | New design | shell, Money, Table, Button, StepUp | gallery: payment renders (quote states); light + dark; 4 widths; axe 0; overflow 0 | Implemented by Claude — owner review pending (not reachable without sign-in) |
| UI24 | Payment | `/agencies/{agencyId}/payments/{orderId}` | APP | Implemented | (app)/…/payments/[orderId]/page.tsx → screens/payments/containers.tsx (payment-view) | New design | shell, StatusBadge, dl facts, actions list | gallery: payment renders (waiting for transfer, confirmed, refused); action list bullet fixed; axe 0; overflow 0 | Implemented by Claude — owner review pending (not reachable without sign-in) |
| UI25 | Processing | `/agencies/{agencyId}/projects/{id}/processing` | APP | Implemented | (app)/…/projects/[id]/processing/page.tsx → screens/processing/container.tsx | New design | shell, PhaseList, StatusBadge, dl facts, Dialog | gallery: processing renders (LOADING, PENDING, STALE, DENIED, INTEGRITY_FAILURE); axe 0; overflow 0 | Implemented by Claude — owner review pending (not reachable without sign-in) |
| UI26 | Delivery | `/agencies/{agencyId}/projects/{id}/delivery` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI27 | Import steps | `/agencies/{agencyId}/projects/{id}/import` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI28 | Import results | `/agencies/{agencyId}/projects/{id}/import/receipt` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI29 | Data lifecycle | `/agencies/{agencyId}/projects/{id}/retention` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI30 | Billing | `/agencies/{agencyId}/billing` | APP | Implemented | (app)/…/billing/page.tsx → screens/billing/container.tsx | New design | shell, Table, Money, form fields, StepUp | gallery: billing renders (LOADING, STEP_UP, refund form); axe 0; overflow 0 | Implemented by Claude — owner review pending (not reachable without sign-in) |
| UI31 | Team | `/agencies/{agencyId}/team` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI32 | Settings | `/agencies/{agencyId}/settings` | APP | Implemented | (app)/…/settings/page.tsx → screens/settings/container.tsx | New design | shell, dl facts, StatusBadge, Button, StepUp | gallery: settings renders (closing, closure, STEP_UP); axe 0; overflow 0 | Implemented by Claude — owner review pending (not reachable without sign-in) |
| UI33 | Private home | `/ops` | OPS | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI34 | Prospects | `/ops/sales/prospects` | OPS | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI35 | Agency relationship | `/ops/sales/agencies/{id}` | OPS | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI36 | Commissions | `/ops/sales/statements` | OPS | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI37 | Seller lifecycle | `/ops/sales/sellers/{id}` | OPS | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI38 | Owner actions | `/ops/owner/actions` | OPS | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI39 | Company finance | `/ops/finance` | OPS | Implemented | (ops)/ops/finance/page.tsx → screens/finance/containers.tsx, view.tsx | New design | shell, dl facts, Table, Button | gallery: finance renders (route, credit queue, DENIED); evidence hash wraps; empty table header named; axe 0; overflow 0 | Implemented by Claude — owner review pending (not reachable without sign-in) |
| UI40 | Jobs | `/ops/operations/jobs` | OPS | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI41 | Deletion | `/ops/operations/deletion` | OPS | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI42 | Incidents | `/ops/operations/incidents` | OPS | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI43 | Releases | `/ops/releases` | OPS | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI44 | Operating review | `/ops/reviews` | OPS | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI45 | Service terms | `/legal/terms` | PUBLIC | Implemented | app/(public)/legal/terms/route.ts → legal/handler.ts, legal/response.ts | New design | not-published card (LEGAL_CSS) | not-published state: light + dark, 320, axe 0; content untouched | Owner-supervised (not-published card); published layout not yet reviewable |
| UI46 | Privacy notice | `/legal/privacy` | PUBLIC | Implemented | app/(public)/legal/privacy/route.ts → legal/handler.ts, legal/response.ts | New design | not-published card (LEGAL_CSS) | as UI45 | Owner-supervised (not-published card); published layout not yet reviewable |
| UI47 | Data processing terms | `/legal/data-processing` | PUBLIC | Implemented | app/(public)/legal/data-processing/route.ts → legal/handler.ts, legal/response.ts | New design | not-published card (LEGAL_CSS) | as UI45 | Owner-supervised (not-published card); published layout not yet reviewable |
| UI48 | Help centre | `/help` | PUBLIC | Implemented | app/(public)/help/page.tsx → public/pages/help.tsx | New design | PageHead, docs layout with sticky index | public pages: light + dark, menu open, 320/375/768/1280, axe 0, overflow 0 | Owner-supervised (seen and reviewed by the owner) |
| UI49 | Communication preferences | `/unsubscribe/{token}` | PUBLIC | Implemented | app/(public)/unsubscribe/[token]/page.tsx → public/pages/unsubscribe.tsx, opt-out-form.tsx | New design | PageHead (compact), opt-out form | light + dark, axe 0, overflow 0; submit states (unit tests) | Owner-supervised (seen and reviewed by the owner) |
| UI50 | Sign in | `/login` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI51 | Accept invitation | `/invitations/{id}` | APP | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI52 | Support cases | `/agencies/{agencyId}/support` | APP | Implemented | (app)/…/support/page.tsx → screens/support/container.tsx | New design | shell, form fields, Table, StatePanel | gallery: support renders (in the processing/support group); axe 0; overflow 0 | Implemented by Claude — owner review pending (not reachable without sign-in) |
| UI53 | Seller resources | `/ops/sales/resources` | OPS | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI54 | Reviewed correspondence | `/ops/sales/outreach` | OPS | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |
| UI55 | Support operations | `/ops/support` | OPS | Pending (not built) | — | — | — | — | Future: follow KAURO_VISUAL_IDENTITY.md |

## How the app and ops screens were checked without a sign-in

The real API (with its database and identity provider) is needed to open a signed-in page, and the end-to-end harness forwards session
routes to it. So the app and ops screens were checked through their unit tests instead. The tests render every screen state with
contract-valid fixtures. Each markup they render was recorded, wrapped in the application's real `tokens.css` and `shell.css` and its
shell frame, and checked with Playwright:

- axe in both themes;
- horizontal overflow at 320, 375, 768 and 1280 px;
- screenshots of the fullest render of each area, at 1280 and 375 px in both themes.

The screenshots are kept with the delivery (`C:/Users/migue/Kauro-visual-delivery/evidence/app-screens/`). Some flags were artifacts of
rendering a piece in isolation, so they are not defects:

- shell-only renders without the page's h1 (transient "Checking your session" and "Signing you out" states, and a test placeholder);
- a test form without a label.
