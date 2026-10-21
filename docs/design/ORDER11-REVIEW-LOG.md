# Order 11: the owner's review of the private screens

**Base:** `main` at `f102de23` (PR #117 merged; CI 39441072761 green on Ubuntu and Windows). **Branch:** `order11/private-review`.

**Where to review:** run `node tools/review/serve.mjs` and open http://127.0.0.1:4400/__review/private. Every screen opens in a viewer with person, state, width and theme controls, previous/next, and the registry contract beside it. Everything is synthetic; nothing is sent or saved.

**Implementation states:**
- `IMPLEMENTED — REVIEW DATA`: the application's own page and components, fed by fixtures that its api client checks against the contract.
- `VISUAL PROTOTYPE — NOT FUNCTIONAL`: the designed screen, not wired to the api.
- `BLOCKED EXTERNAL`: designed; its real behaviour needs a provider that is not connected.
- `PROPOSED`: a design the owner asked for that the registry does not hold; it needs a contract before it is built.

**Review states:** NOT_PRESENTED, PRESENTED, CHANGES_REQUESTED, REVISED_AWAITING_REVIEW, OWNER_APPROVED. Only the owner's unequivocal approval of an identified screen sets OWNER_APPROVED.

## Group A. Access, identity, organisation and settings

| ID and route | Implementation | Review state | Date and reference | Owner's comments | Corrections requested | Corrections made | Tests after | Approval |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| UI50 Sign in `/login` | BLOCKED EXTERNAL | REVISED_AWAITING_REVIEW | 2026-10-20 (presented, then revised) | "Muchas de las páginas que ya has creado están mal, tienen muchos errores de diseño"; needs to navigate each person's full experience, not page by page | Redesign group A to the public site's standard; four navigable experiences (public to sign-in, agency or company, owner, seller) | Design brief (ORDER11-PRIVATE-DESIGN.md); private screens served at their real paths; one synthetic world; page redesigned on the shared design layer | 870 cases (5 widths × 2 themes × states × people): 0 issues; 10 expected by design (UI32 loading, held by the real shell); no motion; keyboard reaches the skip link and the page | Pending |
| UI51 Accept invitation `/invitations/{id}` | VISUAL PROTOTYPE — NOT FUNCTIONAL | REVISED_AWAITING_REVIEW | 2026-10-20 (presented, then revised) | "Muchas de las páginas que ya has creado están mal, tienen muchos errores de diseño"; needs to navigate each person's full experience, not page by page | Redesign group A to the public site's standard; four navigable experiences (public to sign-in, agency or company, owner, seller) | Design brief (ORDER11-PRIVATE-DESIGN.md); private screens served at their real paths; one synthetic world; page redesigned on the shared design layer | 870 cases (5 widths × 2 themes × states × people): 0 issues; 10 expected by design (UI32 loading, held by the real shell); no motion; keyboard reaches the skip link and the page | Pending |
| UI09 Agency setup `/onboarding` | VISUAL PROTOTYPE — NOT FUNCTIONAL | REVISED_AWAITING_REVIEW | 2026-10-20 (presented, then revised) | "Muchas de las páginas que ya has creado están mal, tienen muchos errores de diseño"; needs to navigate each person's full experience, not page by page | Redesign group A to the public site's standard; four navigable experiences (public to sign-in, agency or company, owner, seller) | Design brief (ORDER11-PRIVATE-DESIGN.md); private screens served at their real paths; one synthetic world; page redesigned on the shared design layer | 870 cases (5 widths × 2 themes × states × people): 0 issues; 10 expected by design (UI32 loading, held by the real shell); no motion; keyboard reaches the skip link and the page | Pending |
| UI10 Agency switcher `/agencies` | VISUAL PROTOTYPE — NOT FUNCTIONAL | REVISED_AWAITING_REVIEW | 2026-10-20 (presented, then revised) | "Muchas de las páginas que ya has creado están mal, tienen muchos errores de diseño"; needs to navigate each person's full experience, not page by page | Redesign group A to the public site's standard; four navigable experiences (public to sign-in, agency or company, owner, seller) | Design brief (ORDER11-PRIVATE-DESIGN.md); private screens served at their real paths; one synthetic world; page redesigned on the shared design layer | 870 cases (5 widths × 2 themes × states × people): 0 issues; 10 expected by design (UI32 loading, held by the real shell); no motion; keyboard reaches the skip link and the page | Pending |
| UI31 Team `/team` | VISUAL PROTOTYPE — NOT FUNCTIONAL | REVISED_AWAITING_REVIEW | 2026-10-20 (presented, then revised) | "Muchas de las páginas que ya has creado están mal, tienen muchos errores de diseño"; needs to navigate each person's full experience, not page by page | Redesign group A to the public site's standard; four navigable experiences (public to sign-in, agency or company, owner, seller) | Design brief (ORDER11-PRIVATE-DESIGN.md); private screens served at their real paths; one synthetic world; page redesigned on the shared design layer | 870 cases (5 widths × 2 themes × states × people): 0 issues; 10 expected by design (UI32 loading, held by the real shell); no motion; keyboard reaches the skip link and the page | Pending |
| UI32 Settings `/settings` | IMPLEMENTED — REVIEW DATA | REVISED_AWAITING_REVIEW | 2026-10-20 (presented, then revised) | "Muchas de las páginas que ya has creado están mal, tienen muchos errores de diseño"; needs to navigate each person's full experience, not page by page | Redesign group A to the public site's standard; four navigable experiences (public to sign-in, agency or company, owner, seller) | Design brief (ORDER11-PRIVATE-DESIGN.md); private screens served at their real paths; one synthetic world; page redesigned on the shared design layer | 870 cases (5 widths × 2 themes × states × people): 0 issues; 10 expected by design (UI32 loading, held by the real shell); no motion; keyboard reaches the skip link and the page | Pending |
| P-01 Personal settings `/account (proposed)` | PROPOSED | REVISED_AWAITING_REVIEW | 2026-10-20 (presented, then revised) | "Muchas de las páginas que ya has creado están mal, tienen muchos errores de diseño"; needs to navigate each person's full experience, not page by page | Redesign group A to the public site's standard; four navigable experiences (public to sign-in, agency or company, owner, seller) | Design brief (ORDER11-PRIVATE-DESIGN.md); private screens served at their real paths; one synthetic world; page redesigned on the shared design layer | 870 cases (5 widths × 2 themes × states × people): 0 issues; 10 expected by design (UI32 loading, held by the real shell); no motion; keyboard reaches the skip link and the page | Pending |
| P-02 Organisation settings, complete (UI32 within its contract) `/agencies/{agencyId}/settings` | PROPOSED | REVISED_AWAITING_REVIEW | 2026-10-20 (presented, then revised) | "Muchas de las páginas que ya has creado están mal, tienen muchos errores de diseño"; needs to navigate each person's full experience, not page by page | Redesign group A to the public site's standard; four navigable experiences (public to sign-in, agency or company, owner, seller) | Design brief (ORDER11-PRIVATE-DESIGN.md); private screens served at their real paths; one synthetic world; page redesigned on the shared design layer | 870 cases (5 widths × 2 themes × states × people): 0 issues; 10 expected by design (UI32 loading, held by the real shell); no motion; keyboard reaches the skip link and the page | Pending |
| P-05 Create account `/signup (proposed)` | PROPOSED | NOT_PRESENTED | — | — | — | — | — | Pending |
| P-06 Reset password `/login/reset (proposed)` | PROPOSED | NOT_PRESENTED | — | — | — | — | — | Pending |

## Group B. Clients, projects and the service

| ID and route | Implementation | Review state | Date and reference | Owner's comments | Corrections requested | Corrections made | Tests after | Approval |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| UI11 Projects `/projects` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI12 Clients `/clients` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI13 Overview `/projects/{id}` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI14 Source intake `/projects/{id}/sources` | IMPLEMENTED — REVIEW DATA | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI15 Selection `/projects/{id}/sources/selection` | IMPLEMENTED — REVIEW DATA | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI16 Seal review `/projects/{id}/sources/seal` | IMPLEMENTED — REVIEW DATA | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI17 Target setup `/projects/{id}/target` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI18 Audit `/projects/{id}/audit` | IMPLEMENTED — REVIEW DATA | NOT_PRESENTED | — | — | — | — | — | Pending |
| P-07 Health check results, beside UI18 `/projects/{id}/audit?review-proposal=P-07` | PROPOSED | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI19 Mapping `/projects/{id}/plan/mapping` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI20 Identity `/projects/{id}/plan/duplicates` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI21 Relationships `/projects/{id}/plan/relationships` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI22 Approval `/projects/{id}/plan/approval` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI25 Processing `/projects/{id}/processing` | IMPLEMENTED — REVIEW DATA | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI26 Delivery `/projects/{id}/delivery` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI27 Import steps `/projects/{id}/import` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI28 Import results `/projects/{id}/import/receipt` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI29 Data lifecycle `/projects/{id}/retention` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI52 Support cases `/support` | IMPLEMENTED — REVIEW DATA | NOT_PRESENTED | — | — | — | — | — | Pending |

## Group C. Quote, payment and billing

| ID and route | Implementation | Review state | Date and reference | Owner's comments | Corrections requested | Corrections made | Tests after | Approval |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| UI23 Quote `/projects/{id}/purchase` | IMPLEMENTED — REVIEW DATA | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI24 Payment `/payments/{id}` | IMPLEMENTED — REVIEW DATA | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI30 Billing `/billing` | IMPLEMENTED — REVIEW DATA | NOT_PRESENTED | — | — | — | — | — | Pending |

## Group D. Sales and sellers

| ID and route | Implementation | Review state | Date and reference | Owner's comments | Corrections requested | Corrections made | Tests after | Approval |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| UI34 Prospects `/sales/prospects` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI35 Agency relationship `/sales/agencies/{id}` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI36 Commissions `/sales/statements` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI37 Seller lifecycle `/sales/sellers/{id}` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| P-03 Seller settings `/ops/sales/settings (proposed)` | PROPOSED | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI53 Seller resources `/sales/resources` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI54 Reviewed correspondence `/sales/outreach` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |

## Group E. Owner, administration and operations

| ID and route | Implementation | Review state | Date and reference | Owner's comments | Corrections requested | Corrections made | Tests after | Approval |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| UI33 Private home `/` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI38 Owner actions `/owner/actions` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| P-04 Owner settings `/ops/settings (proposed)` | PROPOSED | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI39 Company finance `/finance` | IMPLEMENTED — REVIEW DATA | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI40 Jobs `/operations/jobs` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI41 Deletion `/operations/deletion` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI42 Incidents `/operations/incidents` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI43 Releases `/releases` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI44 Operating review `/reviews` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |
| UI55 Support operations `/support` | VISUAL PROTOTYPE — NOT FUNCTIONAL | NOT_PRESENTED | — | — | — | — | — | Pending |

## Defects found and fixed while building group A

| # | Where | Defect | Fix | Test |
| --- | --- | --- | --- | --- |
| D-01 | apps/web/src/shell/shell.css | The shell's `.kauro-button` rule, declared after the design tokens with the same specificity, repainted every primary and danger button of the application as a neutral outline (UI32's "Request closure" among them). | The rule applies only to a bare `kauro-button` without a variant. | Visual (group A audit); web unit tests 334/334 |
| D-02 | apps/web/src/screens/settings/model.ts | UI32 offered "Request closure" to an admin, who holds REQUEST_DELETION, although closure (CMD043) is the owner's alone: the button always failed with ROLE_INSUFFICIENT. | Offered only where the server also lists MANAGE_AGENCY (owner only, B06 D-AUTHZ-1); an admin reads "Only an owner can request closure". The server still decides. | billing-settings-screens.test.ts: owner offered, admin not |
| D-03 | apps/web/src/shell/view.ts | Once UI10 exists, the shell would offer "Switch agency" on the operations origin, where there is no agency. | The switcher is offered on application paths only. | shell.test.ts: an ops path has no switcher |
| D-05 | apps/web/src/shell/shell.css | A heading inside an error summary or a banner took the section spacing of the page, so the box opened with an empty band. | Headings inside those boxes lose the top margin. | Visual (group B and C screens) |
| D-06 | apps/web/src/shell/view.ts | The workspace switcher linked to itself from the switcher and from the setup, where there is nothing to switch from. | No switch link on the UI10 and UI09 paths. | shell.test.ts |

## Defects found and fixed in the review data (groups B to E)

| # | Where | Defect | Fix |
| --- | --- | --- | --- |
| D-07 | tools/review/private/lib/fixtures/money-states.ts | The review's quote expired 7 days after it was issued; the pricing policy's quoteDays is 14 (packages/domain quoteExpiresAt). The overview and the projects board repeated the wrong date. | The quote, its transfer instructions and every page that names the date now expire on 3 Nov 2026, 14 days after 20 Oct. |
| D-08 | tools/review/private/prototypes/plan.tsx | The plan pages counted 37 invalid addresses and 360 contacts without a company, while the public Sample delivery reports 191 and 1,137 for the same synthetic file. | Those counts are read from the public report (REPORT_ROWS); what the plan adds is derived and reconciles: 11,045 links, 1,221 contacts without a company. |
| D-09 | tools/review/private/prototypes (30 files), kit.tsx day()/moment() | The prototypes wrote "20 Oct 2026, 13:00 UTC" while the real screens use the design system's "Oct 20, 2026, 1:00 PM UTC" (packages/ui formatDeadline): the same quote read differently from page to page. | Every private screen now uses the design system's format (decision 1.5). The approved public site keeps its ISO form until you approve a change. |
| D-10 | tools/review/private/lib/fixtures/money-states.ts | The quote showed "Terms version cccccccccccc": the shared web test fixture's placeholder hash. | The review's quote states carry a value shaped like a real SHA-256 (of a review label, not of any terms document); the shared test fixture is untouched. |
| D-11 | tools/review/private/prototypes/ui26-delivery.tsx | Delivery for "Clean your data" said the project stays prepared for import until each stage's result returns; that service has no import. | CLEAN says nothing more is needed from the team and to download before the deletion date; the CRM services keep the import line. |
| D-12 | tools/review/private/prototypes/ui20-identity.tsx, pages.css | On a phone, the comparison of a duplicate group was a 34rem table cropped inside a frame that scrolled sideways and could not be reached by keyboard (axe scrollable-region-focusable). | Below 48rem each field is a card listing both rows and the unified record, each labelled; a field in conflict marks its whole card. The old minimum width is removed, not overridden. |
| D-13 | apps/web/src/screens/payments/quote-view.tsx | A discount whose basis is not REPEAT was drawn as "No discount applies to this quote." while the total was reduced. | Every discount the server sends is shown; a non-repeat one reads "Discount (N%)", within D-COPY-1 (no founding line before B10). |
| D-14 | apps/web/src/screens/payments/quote-view.tsx | The hint under the pay button said both "accept the terms" and "a blocker applies", whichever was true. | It gives the one reason that applies. |
| D-15 | apps/web/src/screens/payments/payment-view.tsx, screens.css | The order id (36 characters) sat beside the amount, where a person looks for what to type into the bank; the page had no way back to its project and ended at "paid". | The id moves to the foot; the page links to the project; a confirmed payment names the next step. The key values share a line with their copy buttons; the amount keeps its size (a rule for hints styled it as muted text). |
| D-16 | apps/web/src/screens/billing/view.tsx, container.tsx | The refund form was always open, with bare inputs; the menu's Billing ended at "Choose an order". | The form opens on a button after the refund terms, with the design system's fields; without an order the page leads to the projects (overview proposed as P-09, gap F-10). |
| D-17 | Kauro-visual-delivery/order11/tools/audit-private.mjs | The audit's proposal map omitted P-08, so the group B run did not cover it. | P-08 is mapped to group B and audited with group C; P-09 is mapped to group C. |
| D-18 | tools/review/private/prototypes/ui35-relationship.tsx, ui37-seller.tsx | Neither page was linked from anywhere: the owner could not reach an agency's relationship or a seller's page by navigating. | Linked from the owner's Commissions (seller, agency) and from the relationship (seller). |
| D-19 | tools/review/private/prototypes/sales.ts, ui35-relationship.tsx | A first project's commission basis was USD 2,450.00, a price on no list; a repeat's basis was the price before its 5% discount, against the page's own rule. | USD 2,295.00 (Salesforce, second band) and USD 1,230.25; the relationship's history says the same. |
| D-20 | tools/review/private/prototypes/ui34-prospects.tsx | The owner saw the seller's view, with "Claim this prospect"; the suppressed prospect's Fit held its suppression. | The owner sees each prospect's seller and decides claims; the Fit says the fit. |
| D-21 | tools/review/private/prototypes/ui54-outreach.tsx | The blocked draft to Kestrel & Lowe was another agency's reply, thanking them for a note they never sent; the body wrote "16 October". | Its own first message, dated before the request; "October 16". |

## Findings for the owner (not changed here)

| # | Where | Finding |
| --- | --- | --- |
| D-04 | packages/contracts/registry/screens.json, UI14 primaryCopy | "Upload files, then review what Kavo found." — "Kavo" is not the product's name. Registry text: corrected only through its own procedure. |
| D-UI09-2 | UI09 setup; CMD002 | The design asks for billing details at the first quote, the first moment money is involved, not at setup. Today activation (CMD002) requires agreements_and_profile_accepted, so this needs the profile requirement moved from activation to the quote. Needs your approval before any contract change. |
| D-UI11-1 | UI11 projects | The repeat-discount line ("1 more paid project for 5% off") needs a read of the workspace's paid projects in the lookback; the api has none. |
| D-UI13-1 | UI13 overview | The project's activity (who did what, when) needs a read the api does not serve. |
| D-P01-4 | P-01 personal settings | Sign-in methods, sessions and recovery codes need a read and commands of the identity provider. |
| D-P03-1 | P-03 seller settings | The seller's name and address need a profile read. |
| D-P07-1 | P-07 health check results | The findings (count, population, examples, consequence, fix) need a read model; UI18 serves progress and row counts only. |
