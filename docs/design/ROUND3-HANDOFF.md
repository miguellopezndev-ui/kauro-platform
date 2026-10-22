# Order 11, round 3: handoff (where it stopped, what is left, how to resume)

**Written:** 2026-10-22, when the owner stopped the work. **Read first, with** `ROUND3-REPORT.md` (what was decided, page by page) and
`ROUND3-PROGRESS.md` (the ledger). This file says, in plain terms, what exists, where it lives, and the exact order to continue,
so nothing has to be redone.

## 1. What the owner sees, and why it looks the way it does

There are two separate bodies of work. They are easy to confuse.

| | Where it lives | What it is | State |
|---|---|---|---|
| **The running product and review screens** (what `127.0.0.1:4400` shows) | `apps/web` and `tools/review/` on branch `order11/private-review` (PR #118) | The real Next.js code: the public site, the agency workspace, the seller portal and the owner console. Order 10 (PR #117, merged) changed the public site, including How it works and the typography. Order 11 rounds 1–2 rebuilt the private screens. | **This is the "changed and improved" public page the owner saw.** Round 3 did not change it. |
| **Round 3 design studies** | `C:\Users\migue\Projects\Kauro.archive\Deliveries\Visual\order11\research\` (archive, not the repo) | Stand-alone HTML pages and screenshots: the corrected incumbent plus 3 alternatives per page, blind-judged, then a final per page | **Design only. None of it is in the product code yet.** |

So: **the public site is not "finished in round 3".** Round 3 has not started the public site. It worked only on:
- the owner console;
- the system kit;
- three deliverables.

## 2. Exactly where round 3 stopped

### Owner console (the first of the four sites, in nav order)

| Page | Folder (under `research\round3-owner\`) | Reached | Next step to resume |
|---|---|---|---|
| Nav and shell | `nav\`, `inventory\`, `NAV-DECISION.md` | Decided: V1 on I-A | none |
| Today | `today\final\` | **Done** (final, critique, fixes) | none |
| Finance | `finance\final\` | **Done** | none |
| Payouts | `payouts\final\` | **Done** | none |
| Refunds | `refunds\final\` | Final and critique done; the critique fix pass was **cut off mid-way** | Compare `final\` with `final\pre-fix\`, then redo the fix pass from `final\CRITIQUE.md` (H1 amount field, H2 states, M1–M6) plus "transfer recorded on Owner actions" |
| Claims | `claims\final\` | Final done; one fix **cut off** | Replace the accept slip's invented reason list with one required free-text field (OQ-C2) |
| Customers | `customers\final\` | Final done; critique says "ready with fixes"; fix pass **not run** | Apply `final\CRITIQUE.md` (two High, nine Medium) |
| Sellers | `sellers\` | L3 decided (s1); the final was **cut off** at its start | Build `sellers\final\` from s1 with the three fixes in `AUDITIONS.md` |
| Support cases | `support\` | L3 decided (v1) | Build `support\final\` from v1 (plus v2's reply-under-conversation) |
| Owner actions | `owner-actions\` | L3 decided (a3) | Build `owner-actions\final\` from a3, restoring four row facts |
| Prospects, Outreach, Resources, Jobs, Incidents, Deletion, Operating review, Releases, Settings | `prospects\`, `outreach\`, `resources\`, `jobs\`, `incidents\`, `deletion\`, `operating-review\`, `releases\`, `settings\` | L3 **started then paused**; partial briefs and builds may exist | Run each from `research\round3-owner\L3-TASK.md` (the shared task). Keep what is in the folder; continue it |
| Whole console review (L3 → L2) | none | Not started | After every page is final |

After each page's final: L5 checks, then an outside critic (Tier A, or one per site for Tier B), then the fix pass. The method is
in `ORDER11-ROUND3-MASTER-PLAN.md`, and every record is the page's `AUDITIONS.md`.

### System kit (`docs/design/ROUND3-KIT.md`, version 0.9)

- **Decided:** groups A, C and D (the family list is in `ROUND3-REPORT.md` §2).
- **Group B** (K38 panels, K11 facts, K09 tables, K35 filters):
  - its auditions are built in `research\round3-kit\auditions\`;
  - its 24 judging batches are ready in `research\round3-kit\judging-B\`, with the judge task written. **Not judged.**
- **Next:**
  1. judge group B;
  2. score it with `node tools\round3\bracket.mjs score research\round3-kit\judging-B`;
  3. record it in `research\round3-kit\DECISIONS.md`;
  4. freeze the kit at v1, applying CR-1 to CR-4.

### Deliverables

- **Decided:** e2 (package entry), g1 (importer guide) and r2 (PDF report). All three are in `research\round3-docs-*\`.
- **The PDF report's critic fix pass was cut off**, in the middle of "no empty cells in tagged tables".
- **Not started:** the health check report, quote summary, commission statement, client summary, audit summary, the emails, and the
  Tier C items.

### Not started at all

1. **The agency workspace** (master plan §10.2).
2. **The seller portal** (§10.3).
3. **The public site** (§10.4), with the owner's pending items:
   - Home: in "Services open for new projects", remove "Lowest starting price" and "Available", and fix the type sizes;
   - Services: "Limits of a project", and a closing band like How it works;
   - wine is missing on How it works and Services;
   - the head merges into the first section on Pricing, Sample delivery and Data handling.
4. **All four sites together** (§10.6).
5. **Implementation in `apps/web`**: every final becomes product code, one coordinated change per component (D-34). Then the full
   suite, CI, and the merge.

## 3. Defects the owner found, recorded and not fixed (owner: "do not stop to fix anything")

| Id | Where | What | Seen |
|---|---|---|---|
| HD-1 | Review screens, seller session | From the seller's session, **Commissions** opens the owner's session (a link crosses from the seller portal into the owner console). This is a link or route defect in the review environment (`tools/review/private`), and possibly a role-separation defect. Check the seller nav's Commissions link target, and that the review shell keeps the role. | Owner, 2026-10-22 |
| HD-2 | Review screens | "A couple of problems with the links", not yet named. Ask the owner for the rest when work resumes, then audit every nav link per role. | Owner, 2026-10-22 |

**When resuming,** audit every link in every role's shell before any new design work. A seller must never reach an owner page.

## 4. How to resume, step by step (nothing is redone)

1. **Read:** this file, `ROUND3-REPORT.md`, `ROUND3-PROGRESS.md`, then the master plan and the deliverables plan.
2. **Review server:** start it with `cd C:\Users\migue\Projects\Kauro` and `node tools/review/serve.mjs` (127.0.0.1:4400).
3. **Fix HD-1 and HD-2 first.** They are product defects.
4. **Finish what was cut off,** in this order:
   1. the Refunds fix pass;
   2. the Claims accept field;
   3. the Customers fixes;
   4. the Sellers final;
   5. the Support and Owner actions finals;
   6. the report fix pass.
5. **Judge kit group B** and freeze the kit at v1.
6. **The nine paused owner pages,** one at a time, from `L3-TASK.md`.
7. **Then:** the agency workspace, the seller portal, the public site, all four together, the remaining deliverables, and the
   implementation.
8. **Quota (owner, 2026-10-22):** run the cheaper method.
   - 2 judges per pair for Tier B;
   - one outside critic per site;
   - at most 6 agents at a time;
   - every agent prompt forbids installing anything.

## 5. Tools (all in `Kauro.archive\Deliveries\Visual\order11\tools\round3\`)

- **`bracket.mjs make|score`:** blind judging. Use `BRACKET_LAYOUT=family` for page folders, like
  `make <judgingDir> research\round3-owner <page> v1:v0,…`.
- **`gates.mjs`:** gates, run through Edge (`gates-edge.mjs` in each page's `build\`).
- **`anatomy.mjs`:** checks values against the type and spacing scales.
- **`colour-share.mjs`:** measures wine and the other colour shares.

## 6. What changed in the product code, and when (from git; the owner asked)

All of it is on `order11/private-review` and **not yet in `main`**. Main ends at PR #117 (Order 10).

| When (Bogotá) | Work | Code changed | Record |
|---|---|---|---|
| Oct 20, 12:56–23:38 | Order 11 round 1: the private-screen review environment, then groups A–E of the private screens redesigned on the owner's decisions; public-site variants at `/__variants` | `tools/review/private` (prototypes and the review shell), parts of `apps/web` (Finance, settings) | `ORDER11-PRIVATE-DESIGN.md`, `ORDER11-REVIEW-LOG.md` |
| Oct 21, 11:07–18:04 | Order 11 round 2, after the owner's walk ("results, not proposals; every page rebuilt except Home"): **the public pages except Home** on one type scale and one closing band; the public header and footer; one dark theme; the owner and seller consoles and the agency workspace rebuilt in the review prototypes | `apps/web/src/public/*`, `app/(public)/*`, `copy/*`; `tools/review/private/*` | `ORDER11-ROUND2-PUBLIC.md`, `ORDER11-ROUND2-OPS.md`, `ORDER11-ROUND2-WORKSPACE.md` |
| Oct 21, 18:08–20:55 | Section-by-section work on **How it works** and **Supported services** (the stages timeline, the closing band, the scope lists; amendment R2-2, recorded as approved by the owner) | `apps/web/src/public/pages/how-it-works.tsx`, `supported-services.tsx` and the shared parts | the commit messages; `research\round3-how-*`, `research\round3-services-*` |
| Oct 21, 21:29 – Oct 22, 06:46 | **Round 3** (this handoff): plans, foundations, kit, owner console studies, deliverables | **No product code.** Only `docs/design/*` and the canonical world (`tools/review/private/lib/canon`) | this file |

**So the public-site changes the owner noticed were made on Oct 21 in round 2 and in the section work, not in round 3.** The owner
says some of them were not authorised. Before this branch merges, the owner should confirm which public changes to keep. Any of them
can be reverted on the branch, file by file, from the commits above.
