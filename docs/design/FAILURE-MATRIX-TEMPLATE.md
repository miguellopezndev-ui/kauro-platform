# Failure-mode matrix: template

Owner rule: before code, every stateful command, transition, consumer or sweep has a matrix. Codex's blocking findings in B06 to B08 were one family found one per round (race with another actor, timeout, expiry during a step, crash around the commit, retry or duplicate, revocation mid-way, partial failure). The matrix finds them before the review does.

## Shape

One table per command, transition, consumer or sweep. **Rows** are the steps that write or call out (one COMMIT, one port call, one lease claim). **Columns**, in this order:

| Column | Definition |
|---|---|
| RACE | Another actor (command, consumer, sweep, second instance) touches the same row or lock between this step's read and its COMMIT; both orders. |
| TIMEOUT | A lock wait, statement or port call exceeds its limit; the caller cannot tell whether the effect happened. |
| EXPIRY | A deadline (price, claim window, step-up, lease, retention) passes during the step; the database clock decides. |
| CRASH-BEFORE | The process dies after the step's last write and before COMMIT; nothing may remain. |
| CRASH-AFTER | The process dies after COMMIT and before the answer or the outbox settle; the retry must return the committed result. |
| RETRY | The same key (replay) or the same event (duplicate delivery) arrives again, or the same key with a different body (conflict). |
| REVOCATION | The acting authority (grant, membership, step-up, verified destination, lease fence) is withdrawn mid-way. |
| PARTIAL | One write of a multi-write step succeeds and a later one fails; no half-state may commit. |

## Cells

Each cell is exactly one of: **C** expected behaviour plus the proving test as `file :: "exact title"`; **GAP** the behaviour the design implies, plus a gap code (the test is then written first); **N/A** with the reason it cannot occur (a read-only step, a single statement). An empty cell is not allowed. A retry test does not prove CRASH-AFTER: the replay is proven, the injected loss is not.

## Naming tests

`RACE ...` for an interleaving or crash (the title lists the cases: retry, conflicting key, crash at the commit boundary); `DENY ...` for a refusal (foreign scope, wrong role, then one missing prerequisite at a time); `OK ...` for the success path; a suffix in parentheses names the family, e.g. `RACE (timeout): ...`, `RACE (crash after COMMIT): ...`, `RACE (replacement): ...`. A title names its example or rule id when it has one ("R2-137 (examples 9 and 10)"). One title, one file, unique inside the file; the case map and the matrix cite `file :: "exact title"`.

## Rule: a family seen twice becomes a matrix rule

When two Codex findings (in any package) belong to the same column family, the family stops being a finding and becomes a rule here: its column gets a default expected behaviour and a default test title in this template, and every new matrix must fill the cell from it. Rules so far are the eight columns above; add new ones below with the package and finding ids that justified them.

## Mapping to the fault harness (`docs/design/FAULT-HARNESS.md`)

| Column | Harness facility |
|---|---|
| RACE | two-actor interleaving, both orders, held at a named lock or await point |
| TIMEOUT | injected delay or failure at a port or statement, with the controlled clock past the limit |
| EXPIRY | controlled clock set to the instant before, at and after the deadline |
| CRASH-BEFORE / CRASH-AFTER | crash injection at the commit point (before and after) and at each await point between writes |
| RETRY | replay of the same key and event, and the same key with another body |
| REVOCATION | an interleaved revocation committed at the held point, before and after the guard |
| PARTIAL | crash or failure injected at the second and later write of a step |

A GAP cell is closed by a test that uses the matching facility, named in the cell's proposed title (`RACE ...`, `DENY ...`), and the cell is then rewritten from GAP to C in the same commit.
