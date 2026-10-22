# Round 3: progress ledger

Read first, every time a session starts or after any compaction:
1. [ORDER11-ROUND3-MASTER-PLAN.md](ORDER11-ROUND3-MASTER-PLAN.md) (version 8);
2. [ORDER11-ROUND3-DELIVERABLES-PLAN.md](ORDER11-ROUND3-DELIVERABLES-PLAN.md);

both from the first line to the last. Then this ledger.

## The owner's instructions that govern the run (quoted, with times, Bogotá)

- **2026-10-21, about 17:30.** "me interesa que antes de que subas nada, me permitas aprobar o rechazar … una sola [subida] cuando diga
  que todo está perfecto".
- **2026-10-21, about 21:45 (later, governs).** "como me lo entregues así quedará, cuando termines ya sabes qué hacer, lo subes a
  github lo mergeas y toda esa vaina".
  - Push and merge PR #118 once, at the very end, under the master plan §1 conditions.
- **2026-10-21, about 21:40.** "a las 5 de la mañana mañana enciende el servidor y no lo apagues hasta que termines." A one-shot
  reminder is scheduled for 04:59–05:00, 2026-10-22.
- **2026-10-21, about 23:00.** "el plan sea tan bueno hasta que estés de acuerdo o un agente sin contexto y entonces empiezas
  directamente."
  - Six context-free reviews; the plans reached version 7.
  - Claude agreed on 2026-10-22, about 00:15.

## State

### Continuation authorised on Oct 22, 2026

The owner supplied `ROUND3-HANDOFF.md` as the resume instruction: continue version 8 to its full end condition, implement, then deliver.
The historical stopped state below remains evidence of the interruption; it is no longer an instruction to pause.

- **HD-1 / HD-2:** reproduced seller Commissions changing to the owner when a `review-as=seller` preview followed a plain link.
  Review links now retain their persona, existing object queries and fragments. Both the route and shell refuse owner-only previews
  to sellers. No product authorisation or backend code changed. The owner knows of no other specific failed link and asked for the
  audit to identify the rest. Edge audit: **302 checks, zero failures**, across all 11 personas, project navigation for all seven
  workspace roles and all three services, shell/account destinations, two real Commissions clicks and 12 owner-route denials.
  Evidence: `Kauro.archive/Deliveries/Visual/order11/research/round3-link-audit/audit.json`; repeatable harness in
  `tools/round3/audit-review-links.mjs` in that archive. Review server running on `127.0.0.1:4400`.
  Validation: review typecheck and inventory/link unit checks passed; web and UI unit suites passed; **47 public browser tests passed
  in installed Edge**, including the public navigation walk. The TLS harness used the already installed Git OpenSSL on the test
  process PATH; no installation or system setting changed.
- **Interrupted fixes resumed:** Refunds, Claims and Customers continue from their existing builders and decisions. Their new
  evidence is reviewed before each step is called done. Sellers final is next, followed by Support cases and Owner actions.


| Step | Status | Record |
|---|---|---|
| Plans (web v7, deliverables) | Done, committed | the two plan files |
| Foundations 1: decisions register | Done: ~255 entries, 45 conflicts in its §7 (to resolve where they arise) | ROUND3-DECISIONS-REGISTER.md |
| Foundations 2: Day-0 feasibility and dry runs | Done: every promised check has a tool or a written fallback; suites green (one load-sensitive api file); PDF render, core acceptance (145/145 bytes) and core on new input all work | ROUND3-FEASIBILITY.md |
| Foundations 3: canonical fixtures | Done: one world (20 projects, money, sellers, operations), 7 stress worlds, reconciliation checks, 14 tests | ROUND3-CANONICAL-WORLD.md, tools/review/private/lib/canon |
| Foundations 4: voice and terms | Done: 8 principles, glossary, formats, message patterns, 38 inconsistencies (I-01 to I-38), 5 owner questions | ROUND3-VOICE-AND-TERMS.md |
| Foundations 5: tooling | colour-share, anatomy, capture-all, capture-urls, degrade (blind), score-calibration built | Kauro.archive/…/tools/round3 |
| Foundations 6: "before" captures | Done: 71 screens × 1280 and 375, 0 failures | Kauro.archive/…/research/round3-before |
| Foundations 7: Home DNA | Drafted (colour, type, space, vocabulary, audit) | HOME-DNA.md |
| Foundations 8: L1 concepts and the vertical slice | **Done.** System chosen: c4 "one ledger with four mastheads" (300 blind judgements; 60 of 60 in its final round; gates pass) | research/round3-slice/AUDITIONS.md; PD-05 |
| Judges' calibration | **Passed, prompt version 1 frozen:** public pages 95% of 80 judgements, tool screens 88% of 60, documents (own prompt) 100% of 60 (bar 85%); guards added (wine preference, line length, widows) | Kauro.archive/…/round3-foundations/calibration/CALIBRATION.md |
| Foundations 9: the kit, frozen | Inventory done (42 families). Auditions decided for groups A (144 judgements), C (150) and D (180): 13 families. Group B (panels, facts, interactive table, filters) being judged. Kit record drafted (version 0.9); frozen as version 1 after group B | research/round3-kit/DECISIONS.md; ROUND3-KIT.md |
| Owner console | **L2 decided** (nav V1, inventory I-A). **Today:** L3, L4, L5, critic and copy fix pass 2 done. **Finance:** L3 f1, L4 incumbents kept; final built; critic done, fix pass running (OWN-10 flagged). **Payouts:** L3 p1, L4 incumbents kept; final, critic and fix pass done (an invented approval cut-off rejected; G-P8 open). **Claims (A):** L3 c2 (36 judgements, every pair clear); L4 (120): queue keeps s0 plus 4 fixes, ending section s4 (the dated list) wins every pair; final being built. **Refunds (A):** L3 u1 (36); L4 (120): both incumbents kept, plus a phone link to the decision; final being built. **Customers (B):** L3 k2 (36, every pair clear); final built (phone filter folded, Finance money word); outside critic running. **Sellers (B):** L3 s1 (every pair clear); final being built. **Support cases (B):** L3 v1 (tie with v2 broken on consistency). **Owner actions (A):** L3 built, judging. **Prospects, Outreach, Resources, Jobs, Incidents, Deletion, Operating review, Releases, Settings:** L3 started with round3-owner/L3-TASK.md, then **paused on 2026-10-22 to save the week's quota (owner's request)**; partial work is in each folder, and each builder can be resumed. **Kit group B:** auditions built, 24 judging batches ready, not launched (paused). Every judge prompt now forbids installing anything (a judge installed Pillow; undone) | research/round3-owner (each page folder: BRIEF, CONTENT, COMPOSITIONS, AUDITIONS, final) |
| Agency/company workspace | Pending | — |
| Seller portal | Pending | — |
| Public site | Pending | — |
| Deliverables track | Research, 24 briefs, canon packages done. **Package entry (Tier A): e2 decided** (36 judgements), finished, critic, fix pass done. **Importer guide (Tier A): g1 decided** (36 judgements), finished, critic, fix pass done; the HubSpot association steps need a qualification import before the engine patch ships (open). **PDF report (Tier A): r2 decided** (36 judgements); final being built; PD-08 (tabular font) proposed | research/round3-docs-package-entry, round3-docs-import-instructions, round3-docs-report (AUDITIONS.md, final/) |
| All four together | Pending | — |
| Push and merge | Pending (end only) | — |

## Open items for the owner (non-blocking)

- **Owner console, OQ-2 to OQ-6** (round3-owner/L2-BRIEF.md §6): whether anyone else uses the console; whether you may open unpaid
  workspaces' projects (stage and dates only); whether you are ever also a seller; whether you decide on a phone; who publishes seller
  resources. Until answered: owner only; projects not opened (alerts link to the customer); no seller switch; decisions possible on a
  phone with the authenticator; resources managed outside the console (a recorded gap). OQ-1 ("numbers in the menu") is resolved
  from A10 lines 69–71 and 128: ordinal numbering, not counts.

- **Downloads for checks** (ROUND3-FEASIBILITY.md §4): WebKit, Playwright Firefox, Java and veraPDF, Lighthouse, two Markdown renderers.
  Until answered, each check uses its written fallback, which counts as the bar.

- **Voice and terms, Q-1 to Q-5** (ROUND3-VOICE-AND-TERMS.md §7): the time zone of the owner console and seller portal, the final
  state of a Clean your data project ("Delivered" proposed), the report's title per service, Home's six step names, and whether the
  registry primaries that conflict with the glossary are amended together. Until answered, screens use the proposals and mark them.

- **Owner console, OQ-C1** (round3-owner/claims/BRIEF.md): should accepting a claim ask for the identity check? The contract says never (step-up: NEVER), but acceptance fixes who earns commission for 90 days. Until answered, the design follows the contract and says so on the slip.
- **Owner console, OQ-R1 to OQ-R4** (round3-owner/refunds/BRIEF.md §8): may a refund request be decided before counsel answers; who writes what the customer reads after a refusal, and is there a closed list of reasons; does refusing need the identity check; after a refund, is a seller's held commission offset or voided. Until answered, the design shows counsel's state, drafts neutral refusal text as a proposal, asks for the identity check only on approval (money), and leaves the held line as held.
- **Owner console, G-P8** (round3-owner/payouts/final/NOTES.md §7): should there be an approval cut-off before the pay-by date? No contract sets one, so no page shows one; the suggestion is the last Bogotá business day before the pay-by date.
- **Owner console, Customers** (round3-owner/customers/BRIEF.md): can a workspace be suspended as well as restricted; is each workspace one customer or are workspaces of one owner grouped (Northwind Data and Northwind Labs); who restricts a workspace and who lifts it. Until answered: restricted only, in words; one customer per workspace; no restrict or lift action drawn.
- **Qualification import (HubSpot association step)** and the **issuer details** shown in documents: both open; the specimens say so.
- **Codex** is not installed and needs a sign-in. A fresh-context agent plays the outside critic unless the owner sets Codex up.
- **The engine's documents** (audit summary, importer guides, exception and trace files, manifest, README) are delivered as finished
  specimens and an archived patch, not merged. The reason: the Intelligence Core accepts only Migration Core 3.0.0 and may not be
  modified (deliverables plan §1.1).

## Stopped by the owner, 2026-10-22

The owner asked to stop everything ("quedó como quedó"). Every agent is stopped, nothing is pushed, and PR #118 is untouched. Some
work was cut off mid-pass and may be partly edited:
- **Refunds final fix pass:** the state before the pass is in `refunds/final/pre-fix/`.
- **Sellers final:** started, not finished.
- **The report fix pass:** in progress when stopped.
- **The Claims accept-reason fix:** in progress when stopped.

Decided but not finished, recorded in each page's AUDITIONS.md:
- **Owner actions:** a3.
- **Support cases:** v1.
- **Sellers:** s1.
- **Customers:** critique "ready with fixes"; the fix pass was not run.

Nine owner pages and kit group B were paused earlier.
