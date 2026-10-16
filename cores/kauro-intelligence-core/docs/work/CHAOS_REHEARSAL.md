# Chaos rehearsal (B04 L3b) - SIMULATED

Everything here is **SIMULATED**: a stand-in seam over hand-written Amazon Bedrock shapes
(`test/support/bedrock-recordings`), an injected sleep and clock, no provider, no network, no money. It proves how the
campaign runner (grant, ledger, admission, retries, stop rule, restart) behaves under failure. It says nothing about a
model's quality and is never qualification evidence: the stage labels every run over a seam `SIMULATED`, the summary
carries `rehearsal.label = "SIMULATED: ..."` and `countsAsQualification: false`, and the run records are never
`EXECUTED_PROVIDER`.

## Run

```
npm run build
npm run campaign -- --stage rehearse --seam tools/campaign/chaos-seam.mjs --shape pilot         [--limit N] [--out <dir>] [--kill-at-fixture K]
npm run campaign -- --stage rehearse --seam tools/campaign/chaos-seam.mjs --shape qualification [--limit N] [--out <dir>] [--run 1|2|3] [--kill-at-fixture K]
```

`--seam` is honoured only with `--stage rehearse` (any other stage ignores it and asks for its grant). The rehearsal
grant is written beside the output (`CHAOS-REHEARSAL-grant-no-money-<shape>.json`, notional cap, "not an owner grant")
and reused on a restart, because the ledger binds to the whole grant. The AWS reads of the preflight (probes P1-P6) are
not made (no account is behind a seam); the grant, ledger lock, contamination latch and scorer-validity record are
checked exactly as for a funded stage.

Without `--limit` the pilot shape is 60 fixtures x 2 passes x 2 candidates and the qualification shape is the 600 FINAL
fixtures. The tests run both with `--limit 8` (a few minutes in all); a full-size rehearsal has not been timed.

## Shapes

| shape | grant (notional) | stage | what it rehearses |
|---|---|---|---|
| pilot | 55 USD, PILOT, Sonnet + Opus, no run limit | pilot | Sonnet first, two passes each, the stop rule (served-model change on Opus stops the stage, Sonnet's measurement stays) |
| qualification | 120 USD, QUALIFICATION, Sonnet only, 4 runs | qualify, run 1-3 | run accounting (a killed run counts, its number is used up), grant arithmetic (per fixture x 600 x 1.15 against the cap), refusal when the projection does not fit |

## The script (mandate 4.4)

One fault is taken by one send (one credential call; retries count). An entry waits for its fixture, candidate and pass.

| fault | what the seam does | what the runner is asserted to do |
|---|---|---|
| 429 with Retry-After | `ThrottlingException`, `Retry-After: 7` | waits at least 7000 ms on the injected sleep; the hold is RELEASED (documented non-acceptance) |
| 429 without it | `ThrottlingException` | the core's own backoff (2 s, jittered), never zero; RELEASED |
| burst of 6 | six 429s in a row | six released 429s; more than five in one run stop that run `RATE_LIMITED`, not the stage |
| 503, 529 | service unavailable / overloaded | retried after the backoff; the failed attempt's hold is kept (no usage is no proof of non-billing) |
| 408 after the body | `ModelTimeoutException` after the body was read | never sent again; the hold stays AMBIGUOUS at the maximum charge |
| reset mid-body | `ECONNRESET` after the body was written | AFTER_SEND: never sent again; AMBIGUOUS |
| credential refresh failure | the credential provider throws | BEFORE_SEND: nothing is written, RELEASED, retried |
| refusal stop_reason | 200, `stop_reason: refusal` | billed, unusable, no hard gate |
| plausible wrong answer | 200, well-formed, maps a column to a target the truth does not name | scored not-correct, no hard gate, no stop |
| served-model change | 200 whose model is not the profile's (Opus) | `SERVED_MODEL_CHANGE` stops the stage; `subjectBroken: [WRONG_MODEL]` |
| kill -9 | the stage child kills itself once, after the fsync of the score of fixture k | the lock is left; the restart recovers it on proof of death (`PID_GONE`, `LOCK_RECOVERED`), reads the earlier `scores.jsonl` before any hold, and the grant is spent once across both invocations |

## The totals assertion

After every rehearsal the runner reads the grant's ledger with `tools/campaign/ledger-audit.mjs`, a replay that shares no
code with `CampaignAdmission`, and compares: charged (settlements up to their holds), held (HELD and AMBIGUOUS holds;
a hold whose invocation died is AMBIGUOUS) and liability (a charge above its hold) against the totals the summary reports.
A difference is the refusal `LEDGER_TOTALS_MISMATCH` and `summary.rehearsal.ledgerAudit.equal = false`.

## Finding (ruled: D4-CHAOS-1, fixed in L5)

An attempt whose billing is unknown (503, 529, 408, reset: no usage reported) keeps the reservation's maximum, 8192 output
tokens. The scorer counts that as billed, so a fixture that saw one 503 and was then answered has `output 8662` against a
ceiling of `8000` and scores `budget_ceiling_exceeded`; `stage-child.mjs` stops the stage on **any** entry in
`hardGateViolations` (`admission.stopFor('HARD_GATE_VIOLATION')`), and the stop is durable in the grant ledger ("a new
grant needs a new owner approval"). In a funded pilot, one transient 503 would end the pilot and strand the rest of grant A.
The report treats `budget_ceiling_exceeded` as an "other violation", not a registered hard gate (`HARD_GATES`), so the
stop rule and the report disagree. The test `FINDING: a transient 503 ... does not stop the stage` states the invariant the
owner needs and is a `todo` until the rule is decided: either the stop is limited to registered hard gates, or an
infrastructure retry does not count against the fixture's billed ceiling. Both touch money-safety code and the scorer digest
(the scorer-validity record must then be re-run), so they are not made in this lane.

Ruling D4-CHAOS-1 (coordinator, 2026-10-06; B04-design §2.8). The ledger and grant side is unchanged: an unknown-billing hold
keeps the reservation maximum (money safety). The scorer's `budget_ceiling` check reads the observed usage of the receipt
(billed minus ambiguous tokens, invocations minus ambiguous reservations) and names the unknown-billing requests as
`transportFailures`: such a request is a transport failure, never a ceiling violation and never the reservation maximum.
`stage-child.mjs` stops a stage durably only on a member of `HARD_GATES` (the one list, exported by
`kauro-intelligence-core/benchmark`), live and when it rebuilds a pending STOP from `scores.jsonl` (G50). Tests, failing before
the fix: `test/b04-chaos.test.ts` "D4-CHAOS-1: a transient 503 ..." (the former todo) and "a violation outside HARD_GATES
(budget_ceiling_exceeded) ... does not stop", `test/b04-campaign.test.ts` "D4-CHAOS-1 (G50) ...", `test/benchmark.test.ts`
"D4-CHAOS-1: a request whose billing is unknown ..."; the control "a registered hard gate ... still stops the stage" passes on both
sides. The scorer-validity record was regenerated through `tools/campaign/scorer-validity.mjs` (660/660, opensFundedStage=true).
