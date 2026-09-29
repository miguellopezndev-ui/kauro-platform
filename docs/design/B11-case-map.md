# B11 — case map

The 13 cases of B11 (registry `program.json` B11; gates G-UX and G-UX_AGENCY, owner 11) → the tests that will demonstrate them.
Design: `docs/design/B11-agency-app.md`; mandates: `docs/design/B11-mandates.json`. `tools/test/b11-case-map.test.mjs` (part of
`pnpm run verify`) checks this file: one row per B11 case with its registry expectation; a cited file that exists contains a test
with exactly that title; a cited file that does not exist yet is in the `creates_tests` of a mandate the row's status names; every
DENY/RACE row states its registry scenario; every PARTIAL target names the later package that owns what remains.

Status (21 "Evidence classes"; nothing is PASS by being listed, acceptance is the independent review):
- **MISSING — PLANNED (Wn)**: no test exists yet; mandate Wn writes the cited test under exactly that title.
- Target at B11 closure: **EXECUTED_LOCAL** (product code, real PostgreSQL 17, real browsers; an identity contract fake outside the
  case's subject does not lower it) or **PARTIAL** (a clause rests on a SIMULATED contract fake or on another package's route; the
  cell names it).

Registry verification clauses:

| cases | clause | answer |
|---|---|---|
| S066–S070, R2-062–R2-065, R2-134 | "Check every offered action against server authority; screenshot appearance does not establish successful effects." | Answered by every spec: offered actions come only from the server's `permittedActions`/`nextActions` (D-OPS-2); each oracle reads the database as superuser and the fakes' call logs, never a screenshot |
| CMD044-* | "Drafts and research are not sent activity; qualified buyer behavior is not fabricated demand." | NOT_APPLICABLE: a manual 18 sales-activity clause whose domain is B12 (CMD064); a support case records no sales activity |

| case | expected (registry) | tests | status | target at B11 closure | remaining |
|---|---|---|---|---|---|
| S066 | Recover the same operation and honest state; no duplicate capture. | `apps/web/test/operation-runner.test.ts` :: "S066: one logical intent keeps one idempotency key — a double activation, a lost response and a reload of CreatePaymentOrder and CapturePayment reuse the key derived from the quote version and the order, and never mint another"<br>`apps/web/e2e/s066-payment-recovery.spec.ts` :: "S066: a double click, a lost CapturePayment response and a reload during payment end in one payment order and one capture — the page says Checking payment until the server reconciles and never offers another payment while the result is uncertain" | **MISSING** — PLANNED (W3, W9) | PARTIAL — provider half SIMULATED (B09 PaymentProviderAdapter fake); quote issued by fixture | B15 (live PayPal); B10: CMD027-OK |
| S067 | No previous-session data reappears through browser or server caches. | `apps/api/test/b11-sessions.test.ts` :: "S067: a revoked or expired session reads nothing — every read with its cookie answers 401, the revoke answer clears the cookie and the site data, is idempotent, and no reply is cacheable"<br>`apps/web/e2e/s067-browser-privacy.spec.ts` :: "S067: after logout, back navigation, reload and a prefetched link show no value of the previous session in Chromium, Firefox and WebKit — no agency A sentinel from the back/forward cache, the HTTP cache, an RSC payload or the api" :: "S067: switching from agency A to agency B clears A's view before B loads — no A sentinel in the DOM, in B's network log or RSC payloads, or after back navigation" | **MISSING** — PLANNED (W2, W6) | EXECUTED_LOCAL | — |
| S068 | Usable labels, focus, error association and order without mouse-only steps. | `apps/web/e2e/s068-forms-keyboard.spec.ts` :: "S068: every form of the bound journeys completes by keyboard alone — each field labelled, focus visible and in order, refusals focused in an error summary and associated to their fields, no mouse-only step, axe clean" :: "S068: at 320 CSS px (400 % zoom) and 200 % text every form reflows without horizontal scrolling, clipped controls or lost focus" | **MISSING** — PLANNED (W6) | PARTIAL — forms of LATER screens; screen-reader pass is the reviewer's (D-A11Y-1) | B08, B16, B17 (their screens' forms) |
| S069 | Safe format/size/escaping; no code or SSRF in report generation. | `packages/ui/test/safe-text.test.ts` :: "S069: an untrusted label renders as inert text inside a bidi-isolated element — markup, script, formula prefixes and U+202E/U+2066 controls are neither executed nor allowed to reorder the surrounding text"<br>`apps/web/e2e/s069-hostile-names.spec.ts` :: "S069: an agency, client and project named with markup and bidirectional controls render inert on every bound screen and in the printed report view; no request leaves the origin and no policy violation fires" | **MISSING** — PLANNED (W1, W10) | PARTIAL — logo media pipeline and report renderer are B13's | B13: CMD008-DENY, R2-071 |
| S070 | Exact counts, readable breaks/legends and selectable accessible text. | `apps/web/e2e/s070-report-print.spec.ts` :: "S070: a long branded report view prints to Letter and to A4 — page boxes of 612×792 and 595.28×841.89 points, every count equal to its DTO, table headers repeated on each page, no row split, legends kept with their tables, text as text (fonts with ToUnicode maps)" | **MISSING** — PLANNED (W10) | PARTIAL — report DTO by fixture until B08; the delivered PDF is B13's | B08; B13: R2-069, R2-071 |
| R2-062 | Focus remains usable, the error is associated to the exact effect, and no approval occurs on Enter through a hidden default. | `packages/ui/test/confirm-dialog.test.ts` :: "R2-062: the confirmation dialog has no default action — no form, every button type=button, initial focus on the heading, approve disabled until each disclosed effect is acknowledged, and each effect's error referenced by that effect's control"<br>`apps/web/e2e/r2-062-keyboard-approval.spec.ts` :: "R2-062: a CLEAR confirmation answered by keyboard — Enter approves nothing, the server's refusal is announced and focused in the error summary, the error is associated to the exact CLEAR effect, and no approval row exists before the explicit activation" | **MISSING** — PLANNED (W1, W8) | PARTIAL — CLEAR effects from the plan read are SIMULATED (ContractFakeAgencyApi) until B08; CMD025 real | B08 |
| R2-063 | The UI reads durable server state and never offers execution of an unapproved newer revision. | `apps/web/e2e/r2-063-stale-quote-tab.spec.ts` :: "R2-063: two tabs on the old and the new revision — the old tab returning from payment approval reads the order, its quote and the approved plan from the server, shows the newer revision as stale and offers no execution of the unapproved revision" | **MISSING** — PLANNED (W9) | PARTIAL — execution offer is CMD036's; quote issued by fixture | B08: CMD036-OK; B10: CMD027-OK |
| R2-064 | Show saved/draft status and a recoverable warning; do not silently treat unsaved local edits as approved. | `apps/web/test/navigation-guard.test.ts` :: "R2-064: local edits, saved draft, validated and approved are four separate statuses; leaving with local edits needs Stay, Save draft or Discard, and no status is derived from local edits"<br>`apps/web/e2e/r2-064-unsaved-decisions.spec.ts` :: "R2-064: an enum-map edit left before saving raises a recoverable warning on in-app navigation, back and tab close — Stay keeps the edit, Save draft records one RevisePlan revision, and no path presents the local edit as validated or approved" | **MISSING** — PLANNED (W3, W8) | PARTIAL — the plan's enum-map DTO is SIMULATED until B08; CMD023 real | B08 |
| R2-065 | Show physical rows, billable source units and output rows separately with understandable definitions. | `packages/ui/test/count-denominators.test.ts` :: "R2-065: the count panel shows physical rows, billable source units and output rows as three labelled measures with their definitions, never one records figure"<br>`apps/web/e2e/r2-065-count-denominators.spec.ts` :: "R2-065: a flat source projected into companies, contacts and relationship files shows the sealed revision's physical rows and billable source units and each output file's rows, each with its definition" | **MISSING** — PLANNED (W1, W7) | PARTIAL — output rows per file by labelled fixture | B08, B13 |
| R2-134 | Authentication recovery does not revive the invitation or silently accept changed terms; show the current required action without leaking account existence. | `apps/api/test/b11-sessions.test.ts` :: "R2-134: a session opened after expiry carries no invitation or acceptance state, and sign-in answers the same for an unknown, a disabled and an existing identity"<br>`apps/web/e2e/r2-134-expired-login-legal.spec.ts` :: "R2-134: an invitation that expires while its invitee re-authenticates and reads a newly versioned agreement is not revived, the new version is not accepted without an explicit act on it, and the page states the next action without revealing whether an account exists" | **MISSING** — PLANNED (W2, W6) | PARTIAL — invitation read/acceptance and versioned activation SIMULATED until their packages | B16: CMD004-DENY; B10: CMD002-OK |
| CMD044-OK | Create a classified case with accountable next response and visible status. | `apps/api/test/cmd044-create-support-case.test.ts` :: "OK: a member with access to the project opens a classified case — 201 with its category, severity, OPEN state and the covered-hours next review; one case, one support_case.opened.v1 event without the summary, one journal entry"<br>`apps/web/e2e/cmd044-support-case.spec.ts` :: "CMD044: the support form warns against secrets and CRM rows, shows the server's refusal with the secure-upload route, and shows the created case with its next response time after a lost response" | **MISSING** — PLANNED (W4, W10) | EXECUTED_LOCAL | — |
| CMD044-DENY | Raw secrets/CRM files do not enter email or generic telemetry; route secure upload when needed. No unauthorized committed state or external effect. | `apps/api/test/cmd044-create-support-case.test.ts` :: "DENY: a foreign tenant, a wrong role and then one missing prerequisite — another agency's project answers 404 like a nonexistent one, a revoked membership 403, a summary with a private key or CRM rows 422 with the secure-upload next action; no case, event, outbox record or log line holds the submitted text" | **MISSING** — PLANNED (W4) | EXECUTED_LOCAL | — |
| CMD044-RACE | Create a classified case with accountable next response and visible status. Preserve one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority. | `apps/api/test/cmd044-create-support-case.test.ts` :: "RACE: an identical retry, the same key with another digest (IDEMPOTENCY_CONFLICT) and a crash at the intent/commit boundary — at most one case, the retry replays it, the conflict creates nothing, and a crash before COMMIT leaves nothing for the retry to duplicate" | **MISSING** — PLANNED (W4) | EXECUTED_LOCAL | — |

Counts at design: 13 cases — 0 EXECUTED_LOCAL, 0 SIMULATED, 0 PARTIAL, 13 MISSING (all planned). Target at B11 closure: 4
EXECUTED_LOCAL (S067, CMD044-OK, CMD044-DENY, CMD044-RACE), 9 PARTIAL (owners B08, B10, B13, B15, B16, B17).

## Stage 1 records

What the stage-1 mandates delivered, per case (the status column above is updated by INT-1).

| case | test file :: exact title | status | commit |
|---|---|---|---|
| S069 | `packages/ui/test/safe-text.test.ts` :: "S069: an untrusted label renders as inert text inside a bidi-isolated element — markup, script, formula prefixes and U+202E/U+2066 controls are neither executed nor allowed to reorder the surrounding text" | markup half EXECUTED_LOCAL (W1; Windows; `renderToStaticMarkup`, no DOM library); browser and printed-report half PLANNED (W10) | `cf6e9d1` (test first), green at `f2ffb86` |
| R2-062 | `packages/ui/test/confirm-dialog.test.ts` :: "R2-062: the confirmation dialog has no default action — no form, every button type=button, initial focus on the heading, approve disabled until each disclosed effect is acknowledged, and each effect's error referenced by that effect's control" | markup half EXECUTED_LOCAL (W1; Windows); keyboard and server-refusal half PLANNED (W8) | `cf6e9d1` (test first), green at `f2ffb86` |
| R2-065 | `packages/ui/test/count-denominators.test.ts` :: "R2-065: the count panel shows physical rows, billable source units and output rows as three labelled measures with their definitions, never one records figure" | markup half EXECUTED_LOCAL (W1; Windows); the sealed revision's counts through the browser PLANNED (W7) | `cf6e9d1` (test first), green at `f2ffb86` |
| R2-064 | `packages/ui/test/navigation-guard.test.ts` :: "D-DS-1: the guard asks the browser to confirm leaving the document and, in the capture phase, asks the person before a link inside the application is followed" :: "D-DS-1: when the caller takes over the question, a click that would leave is held and handed over with its destination, and proceed follows it once, as the original click, past the guard" | primitive only, not the case: the guard covers tab close, address change and an in-application link, and hands a held link to the page for Stay, Save draft or Discard (W1; Windows; stubbed environment). The Back button cannot be intercepted by a page (D-W1-9), so the Back clause of the case, the four-status model and the dialog stay PLANNED (W3, W8) | `6335bc7`, `da54519` |

## Gates

### G-UX (owner manual 11, package B11; 8 cases)

| field | record |
|---|---|
| applicability | APPLICABLE: S066, S067, S068, S069, S070, CMD044-OK, CMD044-DENY, CMD044-RACE |
| prerequisites | B09 routes on main (S066); B08 (S070 report DTO); B13 (S069/S070 artifact half) |
| owner | manual 11; package B11 |
| required evidence | registry `requiredEvidence` of each case: subject and environment, input manifest, presealed truth (this file), public result (browser + api), external effect identity (fake call logs), exit status, artifact digests, independent review |
| independent checks | superuser oracle on the journal, events and aggregates; fake call logs; axe; three engines for S067/S068 |
| blocking findings | any duplicate capture, any previous-session value after logout/switch, any executed markup, any axe violation |
| accepted subject | none yet |
| review trigger | a change of the pins of D-STACK-1, of D-AUTH/D-SEC/D-PRIV, or of a bound route's contract |

### G-UX_AGENCY (owner manual 11, package B11; 5 cases)

| field | record |
|---|---|
| applicability | APPLICABLE: R2-062, R2-063, R2-064, R2-065, R2-134 |
| prerequisites | B08 (plan and audit reads, CMD036), B10 (CMD002, CMD027), B16 (CMD004), B07 on main (R2-065) |
| owner | manual 11; package B11 |
| required evidence | as G-UX |
| independent checks | as G-UX, plus the reviewer's keyboard and screen-reader pass of UI22 (D-A11Y-1) |
| blocking findings | an approval without explicit activation, an execute offer for an unapproved revision, a local edit shown as saved/approved, one merged "records" count, a revived invitation or implied acceptance |
| accepted subject | none yet |
| review trigger | as G-UX |
