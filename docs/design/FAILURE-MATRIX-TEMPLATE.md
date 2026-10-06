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

When two Codex findings (in any package) belong to the same column family, the family stops being a finding and becomes a rule here: its column gets a default expected behaviour and a default test title in this template, and every new matrix must fill the cell from it. Rules so far are the eight columns above and the family rules below; add new ones with the package and finding ids that justified them.

## Family rules learned

Codex's design-time review of the B10 matrix (r1, 17 findings) found the same few mistakes repeatedly. Each recurring family is now a rule that every matrix must satisfy before it is sent to review.

1. **Sequential calls never prove a race.** A RACE cell is C only if the test holds one actor at a named lock or await point and runs the other, in both orders (or concurrent recovery of the same key). A test that finishes the first call before it starts the second is a DENY or OK guard; the cell is a GAP (B10-M7).
2. **A crash cell names the exact COMMIT it straddles.** CRASH-BEFORE is C only when the injection point is after the step's last write and before its own COMMIT; an injection before the step starts, or before another transaction's COMMIT, proves another cell. CRASH-AFTER names the COMMIT after which the response or the settle is lost (B10-M8, M9).
3. **Every external effect with more than one durable write is split into one row per write.** A payment-service re-binding, a funds effect, a conversion, a compensation, a delivery claim: one row per transaction and per write that can fail alone, each with its own PARTIAL and CRASH cells (B10-M1, M2, M6, M11, M12).
4. **A guard, a CHECK or a database invariant is not a partial-failure test.** PARTIAL is C only when a failure is injected at a second or later write and the test asserts the complete footprint, including the journal, rolled back. A single-statement step is N/A with the invariant cited as a DENY (B10-M10).
5. **A retry or success test proves neither CRASH-AFTER nor RETRY of an event.** Redelivery of the identical event needs its own test; an observed success path is an OK test (B10-M11).
6. **Every call-out and read in the inventory is a row.** A port call (inspector, verifier, reader), a trigger, a state transition performed by another command, and the ordinary write path of a command all get a row, even when another row already covers the same transaction (B10-M3, M4, M5).
7. **The expected behaviour is read from the design section that governs it, with the decision id.** Pre-settlement and post-settlement behaviour are different cells; an expiry cell names the deadline that governs (for a claim, its tail end when listed); the race cell names every actor on the calculation, not only a copy of the same command (B10-M9, M13, M14, M16).
8. **Authority revocation covers every prerequisite of the step, not only the grant.** A mandatory fact the step reads (identity, MFA, destination, agreement) is revocable mid-way and needs its own REVOCATION cell (B10-M17).
9. **Money and authority GAPs are tier 1, whatever the column.** A crash, partial or retry GAP of an effect that decides payable rights, forfeits a right or admits an expired actor is tier 1; tier 3 is a retriable error with no wrong outcome (B10-M15).
10. **Name the state a compensation leaves, not the state it started from; and assert the amount, not the object.** A refusal or rollback preserves what another actor already committed (an entitlement CONSUMED or REVOKED stays so), and a partial hold withholds its cents while the rest of the line is paid (B10-M9, M14 r2).
11. **A derived value is bound whole, and no immediate decision reads a value checked only at commit.** Every column of a derived row (counts, sequences, instants, scope, attribution) is bound to its facts or normalised by the database; a decision taken before COMMIT (a last-owner refusal, a still-owed amount) reads the facts under the lock that orders it, never a cache whose correctness is only re-checked at COMMIT. The matrix carries an "inflate, decide, restore" DENY for each cache (SEC-DEPTH SDP-20, SDP-28).
12. **A source-to-derived relation is checked both ways, and the evidence is frozen once used.** Each source transition has its derived record (structurally, by an AFTER trigger of the source, or by a deferred check), each derived record has its source and is consumed, the complete final relation is re-selected at COMMIT, and the source facts an accounting record cites can no longer change or be deleted. The matrix carries source-only, orphan-record and post-consumption-mutation DENY cells (SEC-DEPTH SDP-21, SDP-26).
13. **Every new DENY predicate has a named OK sibling for each unchanged production writer.** Each writer attachment, resource kind, scope, timing (BEFORE/AFTER row visibility, multi-row, separate statement) and first-use state (no checkpoint yet, no prior row) commits through the production writer; a guard that reads a source row states the trigger phase in which that row is visible (SEC-DEPTH SDP-22, SDP-24, SDP-25).

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
