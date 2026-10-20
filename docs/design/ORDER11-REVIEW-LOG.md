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
