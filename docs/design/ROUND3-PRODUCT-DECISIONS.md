# Round 3: product decisions

Bolder visual product decisions are allowed when documented (owner, 2026-10-21; master plan §1). Each entry records:
- what changes;
- why it is the best option, with evidence;
- what it would take to build: the contract, core or service it touches.

Nothing in the cores, the backend or the money logic is changed in code to make any of these work. "Proposal" means the change waits
for the owner or for a later release.

| # | Decision | Status | Evidence | What building it takes |
|---|---|---|---|---|
| PD-01 | **Documents and emails use a light, print-first theme.** The web stays dark only. | Decided (deliverables plan §1.2) | Documents are printed, forwarded and opened in light mail clients (deliverables plan §1.2; docs research §6) | `packages/reports` styles; email templates |
| PD-02 | **White-label documents are neutral and premium.** They do not look like Kauro: the agency's brand leads, and Kauro appears only in the issuer line, which white label cannot remove. This supersedes the older identity note that framed white-label documents in Kauro's palette. | Decided | Deliverables plan §0.6. Docs research §7: premium comes from white space, one theme and summary first (3 studies). D-34: earlier records are evidence, not vetoes | `packages/reports` (HTML and CSS only) |
| PD-03 | **Compared numbers use tabular figures,** right-aligned, in every table on the web and in documents. Proportional figures stay only in running text. This resolves the identity file's conflicting rules. | Decided | Master plan §6.7 Q40. Owner research §5 (10 of 10 admin UIs right-align amounts). Document calibration: judges penalised left-aligned counts in 100% of pairs | Kit tokens; report CSS |
| PD-04 | **The package report is titled by its service:** "Preparation report", with the service name as the subtitle. Nothing says "import" for Clean your data. | Proposal (owner Q-3, voice file §7) | I-27 in the voice file. Today "Import package report" is printed for every service, which is untrue for Clean your data | `packages/reports/src/copy.ts` (`doc.title`) |
| PD-05 | **The system concept follows the vertical slice.** All 180 judgements chose a new concept over today's system: 90 of 90 against the incumbent, 14 of 15 pairs clear. Which concept, or a synthesis, is recorded when the slice ends. | In progress | `Kauro.archive/…/research/round3-slice/AUDITIONS.md` | `packages/ui`, `apps/web` shell and screens, `tools/review/private` |
| PD-06 | **The engine's documents are delivered as specimens, a specification and an archived patch,** not merged, until a Migration Core release that the Intelligence Core also accepts. | Decided (deliverables plan §1.1) | The Intelligence Core accepts only MC 3.0.0, may not be modified, and a release changes the run ID and every import key | A later MC release, plus widening `SUPPORTED_MIGRATION_CORE` and every file that pins 3.0.0 |
| PD-07 | **Not built now: the `INTERNAL_EVIDENCE` report and the payment-reversal complaint receipt.** The agency summary and the one-page client summary are one document (the `AGENCY_SUMMARY` class). | Decided (deliverable briefs) | `round3-docs-INDEX.md`: no reader or flow needs the first; the second applies only to card payments, which V1 does not offer | — |

Open conflicts found by the deliverable briefs, needing counsel or the owner. They are drawn as proposals until answered:
- Whether bank details may appear in a downloadable file (payment instructions).
- Contracts allow USD only, while the Terms say Colombian customers pay in COP.
- The commission statement contract has no retainer field.
- Forwarding exception rows that contain personal data to an agency's client.
