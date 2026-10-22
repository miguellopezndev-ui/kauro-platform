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
| Foundations 2: Day-0 feasibility and dry runs | In progress (agent) | ROUND3-FEASIBILITY.md |
| Foundations 3: canonical fixtures | Pending | — |
| Foundations 4: voice and terms | Done: 8 principles, glossary, formats, message patterns, 38 inconsistencies (I-01 to I-38), 5 owner questions | ROUND3-VOICE-AND-TERMS.md |
| Foundations 5: tooling | colour-share, anatomy, capture-all, capture-urls, degrade (blind), score-calibration built | Kauro.archive/…/tools/round3 |
| Foundations 6: "before" captures | Done: 71 screens × 1280 and 375, 0 failures | Kauro.archive/…/research/round3-before |
| Foundations 7: Home DNA | Drafted (colour, type, space, vocabulary, audit) | HOME-DNA.md |
| Foundations 8: L1 concepts and the vertical slice | Research running (owner consoles; multi-role systems and density) | research/round3-owner-research, round3-system-research |
| Judges' calibration | **Passed, prompt version 1 frozen:** 95% of 80 judgements (bar 85%); 2 guards added (wine preference, line length) | Kauro.archive/…/round3-foundations/calibration/CALIBRATION.md |
| Foundations 9: the kit, frozen | Pending | ROUND3-KIT.md |
| Owner console | Pending | — |
| Agency/company workspace | Pending | — |
| Seller portal | Pending | — |
| Public site | Pending | — |
| Deliverables track | Pending (parallel) | — |
| All four together | Pending | — |
| Push and merge | Pending (end only) | — |

## Open items for the owner (non-blocking)

- **Voice and terms, Q-1 to Q-5** (ROUND3-VOICE-AND-TERMS.md §7): the time zone of the owner console and seller portal, the final
  state of a Clean your data project ("Delivered" proposed), the report's title per service, Home's six step names, and whether the
  registry primaries that conflict with the glossary are amended together. Until answered, screens use the proposals and mark them.

- **Codex** is not installed and needs a sign-in. A fresh-context agent plays the outside critic unless the owner sets Codex up.
- **The engine's documents** (audit summary, importer guides, exception and trace files, manifest, README) are delivered as finished
  specimens and an archived patch, not merged. The reason: the Intelligence Core accepts only Migration Core 3.0.0 and may not be
  modified (deliverables plan §1.1).
