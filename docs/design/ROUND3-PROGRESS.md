# Round 3: progress ledger

Read first, every time a session starts or after any compaction:
1. [ORDER11-ROUND3-MASTER-PLAN.md](ORDER11-ROUND3-MASTER-PLAN.md) (version 7);
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
| Owner console | **L2 decided** (54 blind judgements): nav V1 and inventory I-A (18 pages). **L3 Today decided** (36 judgements): t3 "three answers first, reference folded" clearly beats the corrected incumbent t0f (6–0, lead 5.0); gates clean at 8 widths. L4 Today: section variants being built (the three answers and the phone fold, Health, Money) | research/round3-owner (NAV-DECISION.md, today/AUDITIONS.md) |
| Agency/company workspace | Pending | — |
| Seller portal | Pending | — |
| Public site | Pending | — |
| Deliverables track | Research done (195 references); 24 briefs and the index written; Migration Core run on the canonical world (3 projects verified; public sample exact); report-reader defects recorded (F-31, F-32); canon aligned with the engine; Tier A alternatives being built (the PDF report r0–r3; the package entry e0–e3 and the importer guides g0–g3) | research/round3-docs-*, round3-docs-INDEX.md, round3-docs-canon/CANON-PACKAGES.md |
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

- **Codex** is not installed and needs a sign-in. A fresh-context agent plays the outside critic unless the owner sets Codex up.
- **The engine's documents** (audit summary, importer guides, exception and trace files, manifest, README) are delivered as finished
  specimens and an archived patch, not merged. The reason: the Intelligence Core accepts only Migration Core 3.0.0 and may not be
  modified (deliverables plan §1.1).
