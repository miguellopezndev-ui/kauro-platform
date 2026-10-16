# IC-1 correction — audit findings F01–F07

The independent audit of `b6fcbaf0eed6802cfd1d2b7354920bf3059550e2`
(`KAURO_IC1_AUDITORIA_Y_DECISION_IC2_V1.md`, 2026-09-11, `APTO_PARA_IC2 =
FALSE`) reproduced seven families of defects that the green CI and the
architecture verdict of 14:52:13Z did not catch. That verdict stays as a
historical observation; nothing here edits or re-attributes it. Every
finding was first reproduced by the executor on an isolated checkout of the
baseline (12/12 observations identical to the audit's), then repaired at its
cause, with a positive test, a negative test that fails on the baseline, and
sabotage mutations for each new control. The correction is delivered as one
pull request on top of the audited `main`.

| family | baseline (reproduced) | cause | change | proof |
| --- | --- | --- | --- | --- |
| F01 privacy | `classifyMetadataText('audit-person@example.test')` → SAFE; the header reached the gateway; `'Alice'` under `Segment` → L1 safe | metadata provenance was treated as safety; any short low-cardinality token was safe; headers, labels, memory text and repair codes were copied raw; contamination was checked after exemplar selection | one classifier for every channel (`classifyMetadataText(text, kind)` with the same PII/secret/instruction rules as values plus a positive label vocabulary); L1 only by closed vocabulary, ISO-style code or the target's own options; names and proper nouns are PII; every value of a column is classified before selection and one bad value closes the column; failing headers/labels/patterns/codes are replaced by masked tokens (`redactMetadata`); `decideEgress` re-reads the envelope and blocks | `test/privacy-*.test.ts` (24 tests incl. a whole run whose provider request **bytes**, ledger, result and telemetry carry none of 14 sentinels); mutations `tools/sabotage-inventory/privacy.mjs` (11) |
| F02 identity | same input, clock +1 s → new run id and two new calls | time was part of the run id; nothing bound an attempt to its content; the store appended unconditionally | `HostContext.auditAttemptId` (required); run id = attempt + tenant; `RUN_CREATED` binds hashes and versions and a reused id with other content is `IDENTITY_CONFLICT`; `LedgerStore.append(runId, event, expectedLength)` compare-and-append; unfinished runs resume from the ledger with in-flight reservations kept ambiguous; finished runs answer from the stored result | `test/kernel-identity.test.ts`, `test/integration.test.ts` (redelivery +1 s / +1 h, crash/resume, deadline), interleaving store; mutations `kernel.mjs` |
| F03 scorer | sealed fixture with a required evidence ref absent scored `correct=true`; `requiredEvidenceRefs` and `expectedCompilerResult` never read | truth was an outcome class; the scorer never compared decisions | benchmark format 1.1.0: expected decisions per candidate (MAP/PRESERVE/ABSTAIN/AGENCY/REFUSE with destination, primitive, params, type), forbidden destinations, required evidence, compiler result, preserved headers, task types, input-hash binding, gate markers; the scorer reads only the result and the observed egress record and records every executed check; the eight hard gates are observed or the corpus cannot claim zero; scorer/fixture/infra failures never pass; `qualifyThreeRuns` applies §84–§86 thresholds | `test/benchmark*.test.ts`; mutations `benchmark.mjs` (12) |
| F04 usage | 200 without usage → 0/0; two billed retries + a response reported as 1 call and 1463/256 | one reservation per retry sequence; failed invocations' usage never reached the ledger; release by classification text; usage never validated | reserve before **every** invocation; each result reconciled (`RESPONSE` commits; failures with usage commit as unusable; without usage and without the transport's typed `neverSent` proof → `AMBIGUOUS_BILLED`); usage must be finite, integer, ≥ 0 else unknown → full reservation; estimate above the per-request ceiling refused before sending; backoff/Retry-After bounded by the run deadline on the injected clock; `resourceEvidence` counts invocations, responses and ambiguous reservations separately | `test/kernel-budget.test.ts`; parser tests in `test/transport-f05.test.ts`; mutations `kernel.mjs`, `transport.mjs` |
| F05 request | the payload omitted `runId`; the oracle fake read `request.runId` off the object; no explicit effort; `output_format` | the fake had a side channel; the request was not self-contained | `<request>` header block (runId, taskId, envelopeHash, policy/prompt versions and hashes, schema version) inside the data-delimited message; `output_config.format` json_schema + `output_config.effort: 'high'`; `parseProviderRequestPayload` reads a request back from bytes only; `oracleTransport()` answers from bytes; `oracleGateway()` = `transportGateway(oracleTransport())`; `TransportError` with typed stage — only `BEFORE_SEND` is retryable and carries `neverSent: true` | `test/transport-f05.test.ts` (17); mutations `transport.mjs` (11) |
| F06 receipt | `rowsValidated = NaN`, `= 16` for 6 rows, and `coreVersion 0.0.0` with problems under `ok:true` all produced `SYSTEM_DRAFT`; the host adapters dropped primitives and filtered fields | `validationIsSound` checked ref, hashes, `<` and two booleans | closed runtime schema for `FullDatasetValidationResult` (finite integers, patterns, `configurationDigest`, `evidence { packageDigest, reportDigest, coreConfigHash }`); exact coverage; core version within the supported set; `ok ⇔ problems empty ⇔ reconciliation ⇔ verify`; `validatedAt` not before the run; the port documented as the host's trust boundary; host adapters (fixtures and consumer) translate locator, object per file, identity and primitives with parameters into the frozen config and refuse what the core cannot express (`UNSUPPORTED_BY_CORE:*`) | `test/kernel-receipt.test.ts` (15 altered receipts, primitive round-trip into package bytes); mutations `kernel.mjs` |
| F07 gates | `sabotage --only NO_SUCH` → exit 0, `passed:true`, reached 0; `--skip-sabotage` accepted `passed === true` | counters came from whatever records existed; the aggregator trusted a boolean in a file; evidence had no subject | DIAGNOSTIC (`--only`, never qualifies, unknown id → exit 2) vs QUALIFICATION (subject commit/tree/clean, inventory and producer hashes, per-record recount, `passed` recomputed); `--skip-sabotage` removed; the gate executes sabotage and verifies the report it produced; facts `subject_bound`, `sabotage_report_bound_to_subject`, `consumer_report_bound`, five behavioural `probe_*`; report carries subject, producers and dependency closure; self-tests prove partial/edited/foreign/dirty evidence is refused; `chain-rehearsal` runs the whole chain to a receipt with `REHEARSAL` labels and an injected failure path; `compose-receipt` verifies the CI receipt | `tools/sabotage-selftest.mjs` (19), `tools/architecture-selftest.mjs` (31), rehearsal output outside the tree |

## Numbers after the correction

- Tests: 175 in 13 files (75 baseline, none removed or weakened; drivers adapted where the API changed).
- Sabotage inventory: 70 mutations (25 core, 11 privacy, 11 transport, 11 kernel, 12 benchmark), all killed in QUALIFICATION mode.
- Architecture facts: 18 (executed or measured; none read from a file).
- Versions: `INTELLIGENCE_CORE_VERSION` 0.2.0, `RUN_LEDGER_VERSION` 1.1.0, `BENCHMARK_FORMAT_VERSION` 1.1.0, masking/data policy 1.1.0; prompt bundle 1.0.0 (hash unchanged); Migration Core peer 2.0.1 unchanged.
- Zero provider calls, zero secrets, no CRM access.

## Contract changes a host must absorb (0.1.0 → 0.2.0)

- `HostContext.auditAttemptId` is required and stable per logical attempt.
- `LedgerStore.append(runId, event, expectedLength): AppendOutcome` — compare-and-append; a database or file store implements it under a lock or a unique `(runId, sequence)`.
- `FullDatasetValidationResult` gains `configurationDigest` and `evidence`; every field is validated at runtime.
- `CoreDependencies.sleep` (optional) for retry waits under a virtual clock.
- `IntelligenceResult.resourceEvidence` gains `providerInvocations`, `ambiguousReservations`, `ambiguousInputTokens`, `ambiguousOutputTokens`; `draft.evidence[]` carries the decided target/field/primitive and `evidenceRefs`.
- Provider request shape: `output_config` replaces `output_format`; a `<request>` block precedes `<data>`.

## Residual limits carried to IC-2

- The classifier's name list and label vocabulary are compact; unlisted proper nouns in headers become UNKNOWN and are masked (the task keeps its L0 facts). Recall and precision are measured on the 600-fixture corpus.
- The lease is the kernel's, fenced and renewed (round 3, IC-01): one owner per `run()` invocation, every write checked against the lease in force, renewal every 30 s while the owner waits. What remains with the host: recovery after a crash waits out the dead owner's remaining lease (at most 120 s) — a redelivery inside it is `WORKER_NOT_OWNER` without a call, and the queue must retry after it rather than drop the attempt.
- HTTP 429/5xx answers carry no proof of non-billing and are kept ambiguous at full reservation size; IC-2 may add provider evidence that turns specific statuses into typed proofs.
- (superseded in round 2) the request no longer carries `temperature` or `metadata`; what IC-2 confirms against the endpoint is the acceptance of `output_config` for the pinned model.
- Host-facing fields (`draft.configuration.fields[].columnHeader`, memory candidate patterns) carry the host's own raw headers; they never leave the host and are not egress.

## Round 2 — the executor's independent review and the second audit (2026-09-11, 19:44Z–23:07Z)

The first correction (`9a9db22`) was reviewed by five independent reviewer
agents and, separately, by the second audit `KAURO_AUDITORIA_MC_IC_20260911_V1.md`
(MC-01..07 on Migration Core, IC-01..13 here). Both found the gates still
green over reproducible counterexamples. The repairs below are the second
round; every closed item has a reproduction of the audit case, a positive
and a negative test and a sabotage mutation (inventory now 111).

| finding | state | change |
| --- | --- | --- |
| IC-01 / K-1 two live workers or a resume repeat a call | closed | semantic request key excludes `budgetSnapshot`; `RESPONSE_STORED` carries the answered envelope hash and a hit never invokes the provider; worker lease (`LEASE` event, compare-and-append, `WORKER_NOT_OWNER`, takeover only after `WORKER_LEASE_MS`) |
| IC-02 terminal output vs cancel/deadline/cause | closed | cancellation and deadline re-read after the validation await; a recorded terminal state is published as such (never a draft beside it); provider failures end `FAILED_PROVIDER` |
| IC-03 / K-3 / B4 receipt without evidence, future-dated, null | closed | evidence digests required with a verified package; `validatedAt` not after the clock; non-record receipts → `VALIDATION_RECEIPT_MALFORMED`, never a TypeError |
| IC-04 / K-2 redelivery with another policy bundle | closed | declared policy/prompt versions, mode, declared objects and memory digest bound in `RUN_CREATED` and compared before the stored result |
| IC-05 / F01-R2 / B1 options launder names | closed | options never widen what may travel; egress re-reads exemplar values with the hard PII rules |
| F01-R1 caseless-script names as L2 shapes | closed | `maskShape` folds every letter; caseless-script tokens at low cardinality are PII unless a vetted option |
| F01-R3 keyless mask tokens | closed | tokens keyed by HMAC with the egress secret |
| IC-06 rationale self-claims; primitives vs candidate | closed | evidence class derived from facts (header tokens, shapes, options); primitives checked against the candidate's allowed set |
| IC-07 unique email as identity proof | closed | identity proof needs an authoritative identifier; unique emails are signals |
| IC-08 global claimed map across files | resolver only in round 2; assembly closed in round 3 (`476c85e`) | targets claimed per record mapping in the resolver and in `assemble()` |
| IC-09 deterministic decisions without evidence | closed | deterministic decisions projected into `draft.evidence` with origin, rule and refs |
| IC-10 invented extra fields; receipt not bound | closed | complete output set judged against the sealed expectations and target universe; `configurationDigest` binding required |
| IC-11 / F03-R2 one report ×3; budget violation tolerated | closed | three reports must be pairwise independent and cover the sealed corpus; any violation fails; `TEST_ONLY` reports never qualify |
| F03-R1 provider failure scored REFUSED | closed | `CANDIDATE_FAILED` class, never correct, gates not observed |
| IC-12 usage above the ceiling still drafts | closed | ceiling re-checked after every commit; implausible single-response usage → `BUDGET_EXHAUSTED`, no draft |
| IC-13 / B2 temperature and idempotency_ref; prompt bytes unversioned | closed | the wire sends no temperature and no metadata; the prompt bundle covers the request template; `PROMPT_BUNDLE_VERSION` 1.1.0 |
| K-4 / K-5 / F05-R6 | code in, tests pending | contradictory neverSent+usage → ambiguous; cache tokens counted with a drift note; 0/0 usage with content → unknown |

Not addressed here and still open: the Migration Core findings MC-04 and
MC-07 (owned by the Migration Core repository; MC-01/02/03/05/06 are repaired
on its `core/mc3-reopen` branch, not released). The final acceptance of this
core requires the repaired Migration Core dependency; this tree still pins
2.0.1 and its receipts therefore carry the upstream defects the audit names.

## Round 3 — the kernel lot after the round-2 independent review (2026-09-11)

The round-2 review (`verdict-round2.json`) left IC-01 open with two MATERIAL
findings reproduced against `e7c3cd0`: two concurrent `run()` of one attempt
on one core instance both sent (RK-1, K3: the lease was ownership by process
name and a name re-granted to itself), and a lease renewed only before a
reservation lapsed during a slow provider call, so a takeover re-bought the
request and the fenced-out worker's commit, transition, outcome and result
were all accepted (RK-2, K4 and the ledger zombie probe). Each reproduction
was run against the round-2 build before the fix and again after it.

| finding | state | change |
| --- | --- | --- |
| RK-1 same worker id, two live runs → double spend | closed | the owner is the `run()` invocation: each `RunLedger` handle mints an owner token, the `LEASE` event records it beside the process name, and `acquireLease` grants a lease in force only to the same token — the second invocation on one instance is `WORKER_NOT_OWNER` (K3: one send, one `COMMITTED`, one `RESULT`) |
| RK-2 lease lapses mid-call; zombie writes accepted | closed | every write is fenced: reserve, commit, release, ambiguous, transition, outcome, note and result are checked against the lease in force and refused `LEDGER_FENCED` when it belongs to another owner (a write that loses its append to a takeover is named the fence, not a conflict); the discard of a late write on a finished run is a `NOTE`, never a second `COMMITTED`; a live owner renews every `WORKER_LEASE_RENEWAL_MS` (30 s) on the host's timer (`CoreDependencies.ticker`, `setInterval` by default) while it awaits the provider and while it awaits the host's validation, so a call three times the lease stays its owner's and a redelivery inside it is refused; a takeover is granted only once the renewed lease has lapsed; the host's `cancel` is never fenced; a fenced-out invocation rejects `LEDGER_FENCED` and reports `WRITE_FENCED` on the telemetry |
| RK-3 `resourceProfile`, `categoricalSummaries` unbound | closed | both digested into `RUN_CREATED.hashes`; a finished attempt resubmitted with either changed is `IDENTITY_CONFLICT` before the stored result |
| RK-4 exhaustion after assembly published as `ABSTAINED_MATERIAL` | closed | `COMPILING → BUDGET_EXHAUSTED` and `FULL_VALIDATING → BUDGET_EXHAUSTED` added to the table; the run ends `BUDGET_EXHAUSTED` |
| RK-5 docs said there is no lease | closed | `THREAT_MODEL.md` T30 and the residual list, this file's residual list |
| RK-6 recovery waits out the lease | documented | `WORKER_LEASE_MS` stays 120 s: renewal makes long calls safe, so the lease bounds only how long a crashed owner's attempt waits; the host queue retries after `WORKER_NOT_OWNER` |
| RK-7 cancel under the terminal append leaves no answer | closed | the terminal transition that loses its append re-reads the ledger; a terminal state recorded from outside is published and the `RESULT` stored, so the redelivery answers `CANCELLED` |

Tests: `test/kernel-correction3.test.ts` (11 tests: K3, K4 without renewal,
K4 with renewal through the provider call and through validation, the zombie
write probe, the lapsed-but-not-taken write, the fence on a lost append,
RK-3, RK-4, RK-7). Mutations added to `tools/sabotage-inventory/kernel.mjs`:
`lease-owner-per-instance`, `fenced-writes-accepted`,
`lease-not-renewed-during-call`, `lease-not-renewed-during-validation`,
`resource-profile-unbound`, `summaries-unbound`,
`exhaustion-after-assembly-as-abstention`, `late-cancel-leaves-no-result`
(inventory 119); `lease-not-checked` and `per-invocation-reserve-removed`
follow the new source. Contract changes a host absorbs: `LEASE` events carry
`ownerId`; `RunLedger.reserve` no longer takes `workerId`; `LEDGER_FENCED`
joins `ERROR_CODES`; `CoreDependencies.ticker` is optional.

### Round 3 — the other lots (2026-09-12)

| finding | state | change |
| --- | --- | --- |
| R2-PC-01 person names as picklist options under other labels | closed | an option travels only when it is a provable enumeration token (closed vocabulary, ISO-style code, identifier shape, small integer, label word); a single capitalised or caseless-script word is a proper noun whatever the label says; data policy 1.3.0 |
| R2-PC-02 AMBIGUOUS evidence stayed PROPOSED | closed | every rationale code has a fact rule; a code without its fact is `RATIONALE_NOT_SUPPORTED_BY_FACTS`; AMBIGUOUS/INSUFFICIENT is `REQUIRES_AGENCY_DECISION`, never PROPOSED |
| R2-PC-03 assembly claimed targets globally (IC-08) | closed | `assemble()` claims per record mapping; two CONTACT files both map Email |
| R2-PC-04 record-id authority unreachable through run() | closed | `ProjectRevision.recordIdColumns` plumbed to the resolver |
| R2-PC-05 ENUM targets never reached a draft | closed | `ConfigFragmentField.allowedValues` for ENUM targets, translated by the host adapters |
| BT-R2-01/02/04/06 | closed | a correct score names its run; the benchmark capture forwards the correlation; the runner surface is on the public entry; a report is believed under its digest |

Residuals recorded: a single capitalised word that is both label vocabulary and a name (Max, Mark) passes the OPTION channel under a non-person label; place-name picklists (España, Lisboa) are proper nouns and are dropped (ISO codes travel); the same-file assembly contradiction is covered at the resolver and by mutation, not by a dedicated end-to-end positive.

### Round 4 — the privacy lot after the round-3 independent review (2026-09-11)

Candidate `8208deb`, review `recovery-2/review-r3/r2-privacy-compiler.md`. Every finding was reproduced on the round-3 build before it was touched: LEE/WU/LI/NG SAFE by the `ISO_CODE` shape, zuleika7/jkowalski1/mlopez01 vouched by the identical option, Klein/Petit/Price/Campos vouched by the identical option.

| finding | state | change |
| --- | --- | --- |
| R2R-PC-01 two or three capitals safe by shape | closed | the shape is a code only when the closed lists know it: ISO 3166-1 alpha-2 and alpha-3 (the 249 assigned plus UK and EU) and ISO 4217, embedded in `data-classifier.ts`; a two- or three-letter upper-case token outside them is UNKNOWN in the value channel and the OPTION channel — never L1, not even a shape — unless a vetted option (SMB, VIP) vouches for it; the given-name list is read first, so BEN and MAR stay names; `ok`/`ko` join the safe vocabulary |
| R2R-PC-02 digit-bearing handles are codes by shape | closed | `codeShaped`: capitals, digits and separators only (A12, SKU-0042, 2024Q1, B2B), or digits at least as many as letters with no lower-case run of three letters or more, or every letter run a vocabulary word (tier1, phone2); a lower-case run no vocabulary knows beside a digit is a handle, UNKNOWN in every channel; `namesPerson` reads the letter runs beside digits, so zuleika7, ZULEIKA7 and Kowalski7 are POTENTIAL_PII in every channel, headers included |
| R2R-PC-03 vocabulary-homonym surnames | narrowed | `vocabularyHomonym`: a single capitalised or upper-case word that is both enumeration vocabulary and in a compact surname list (top family names of es/en/pt/fr/de, read for this tie-break only) or the given-name list; `classifyOption` takes it for the surname when the option list it stands in holds a name the OPTION channel refused (Klein beside Zbigniew, Price beside García) or when the label may name people by a vocabulary wider than the person-field one (Comercial, Vendedor, Sales Rep, Created by, Usuario, Member, Contact, Менеджер); in a list of words under a label that does not (Klein/Mittel/Gross under Company Size, Gold/Silver/Bronze under Tier) it is the word and travels; data policy 1.4.0 |

Tests: `privacy-classifier.test.ts` R2R-PC-01/02/03 (positives and negatives, 6 tests), `privacy-envelope.test.ts` R2R-PC-01/02/03 end to end through `buildProviderRequest` bytes (8 tests, the sentinel check is whole-word so `NG` inside `FIELD_MAPPING` does not count); 303 tests. Mutations appended to `tools/sabotage-inventory/privacy.mjs`, each run through `node tools/sabotage.mjs --only` and KILLED: `iso-shape-without-list`, `handle-treated-as-code`, `handle-letter-runs-unread`, `homonym-tie-break-removed`, `option-list-not-read-whole`, `person-like-label-not-read` (inventory 138). The compatibility matrix line for the data policy (1.3.0 → 1.4.0) is outside this lot's files and is left to the round-4 versions commit.

Residuals, stated plainly: a vocabulary-homonym surname in a list made only of vocabulary words under a label neither vocabulary names (Segmento: Klein, Petit) still travels — the word and the surname are the same token and nothing in the envelope tells them apart without a person in the list or on the label; LI and NG are Liechtenstein and Nigeria in ISO 3166 and travel as codes, and a country picklist loses BEN and MAR to the given-name list; the LABEL channel (headers, memory patterns) still accepts a digit-bearing token by identifier shape (`address2`, `phone2`, but also `col7`), only the name-list read over its letter runs was tightened there; ISO 639 language codes are not in the closed lists by choice, so a language picklist written as bare `en`/`es` is words, not codes, and a capitalised `EN`/`ES` travels only where it coincides with a country code.
### Round 4 — the benchmark lot after the round-3 independent review (2026-09-12)

The round-3 review (`verdict-round2.json`, lens benchmark-transport) left two
MINOR findings against `8208deb`, both reproduced on the round-3 build before
the fix and again after it. BT-R3-01: `report()` read a score's
`hardGateViolations` and `gateChecksExecuted` as given, so a fabricated score
with a failing gated check and an empty violation list counted the gate at
zero (passing, three qualified), and one with `checks: []` and a counter of 1
per gate was OBSERVED over 600 checks the report never saw. Now a failing
check bound to a gate is that gate violated and a gate is observed only where
a check bound to it ran — both counted from the checks, never from the
counters, a candidate failure at zero whatever it recorded — and a score whose
declared list or counters disagree with its checks is
`INCONSISTENT_SCORE:<id>:GATE_VIOLATIONS_NOT_FROM_CHECKS` /
`GATE_CHECKS_NOT_FROM_CHECKS`, a scorer failure and never a pass; a violation
named anywhere is still counted. BT-R3-02: `outcomeClassOf` classed a run
whose only task ended `INVALID_SCHEMA` (a model answer that is not JSON) as
REFUSED, so a SAFETY truth sealed REFUSED with compiler ANY scored it correct
with `safety_critical_incorrect` observed at zero. REFUSED now requires a
refusal the compiler pronounced over a proposal it could read
(`FORBIDDEN_PROPOSAL`, `INVALID_SEMANTICS`, `STALE_INPUT`,
`INCOMPATIBLE_CONTRACT_VERSION`); a run whose tasks ended only
`INVALID_SCHEMA` is `CANDIDATE_FAILED` — incorrect against every truth, no
gate observed through it. The audit's `probe-ic-benchmark.mjs` cannot run
against the candidate (the sealer refuses an obligation-free truth,
`observeEgress` takes transport bytes), so
`test/benchmark-audit-cases.test.ts` reproduces BENCH-repeated-one-report,
BENCH-budget-violation-ignored and BENCH-invented-extra-field under the
current contract with the audit's own predicates (`qualified === false`,
`passing === false`, `correct === false`): the audit's tampering as it stands
leaves the receipt stale and is `RECEIPT_NOT_BOUND_TO_CONFIGURATION`
(`correct: null`, never a pass); with the receipt bound to the tampered
configuration the invented field is the only defect and scores
`correct: false` with `invented_target_accepted`. Tests: `benchmark-report`
(BT-R3-01 positive and negative, the reviewer's two fabrications, the
converse list-only violation, an under-counted gate, a candidate failure that
claims a witness), `benchmark` (BT-R3-02: the garbage-answer run, the mixed
run beside a compiled refusal, the contract-version refusal, the half-compiled
run), `benchmark-audit-cases` (four tests). Mutations appended to
`tools/sabotage-inventory/benchmark.mjs`, each killed:
`gate-counters-not-recomputed`, `gate-violations-not-recomputed`,
`gate-violations-disagreement-not-a-failure`,
`gate-checks-disagreement-not-a-failure`, `schema-failure-scored-refused`,
`invented-field-scored-null` (inventory 138). No contract change: the
report's failure vocabulary grows by the two codes above; `FixtureScore` and
`BenchmarkReport` keep their shapes. Suite 293 tests, 22 files, green.

### Round 4b — the kernel lot after the round-3 independent review (2026-09-12)

The round-3 review (`verdict-round2.json` in `review-r3/`, lens kernel)
closed F02/F04 with no MATERIAL finding and left IC-09 NOT_VERIFIED: the
audit observation — `draft.evidence` empty on a SYSTEM_DRAFT whose fields
came from deterministic decisions — was reproduced in passing (R2R-PC-04),
and the round-2 table above had recorded it closed while the projection was
never in the source. Four kernel residuals were recorded beside it (R2K-01
MINOR, R2K-02/03/04 NOTE). The round-4 kernel lot was lost before it
committed; this lot reproduced each finding against `ef171d8` before the fix
(`recovery-2/lot4b-kernel.md`, `repro-r4b-before.json`) and again after it.

| finding | state | change |
| --- | --- | --- |
| IC-09 / R2R-PC-04 deterministic fields without evidence | closed | `assemble()` reports the decisions that put a field into the configuration; the draft projects each as evidence with `origin: 'DETERMINISTIC'`, `candidateRef` the decision ref, `rationaleCode` the resolver's rule, `evidenceRefs` the decision's refs, `evidenceClass` from the rule (`EXACT_HEADER_MATCH_AND_COMPATIBLE_SHAPE` → STRONG, the class the compiler gives a header-and-shape match; any other mapping rule SUPPORTED), no primitive; accepted proposals keep `origin: 'PROPOSED'`. `DraftEvidence` is the exported entry type and `origin` is a member of it (additive); every configured field has exactly one entry |
| R2K-01 crash between the terminal STATE and the RESULT | closed | the RESULT is stored before the closing transition, naming the terminal state its owner meant to reach; the transition is made after it and decided again on a lost append. On reopen, RESULT present and state not terminal is a finished run: the redelivery takes the lease (inside the dead owner's lease it is WORKER_NOT_OWNER, as after any crash), closes the state from the RESULT, and answers with no send and no validation. The answer is always the RESULT read under the terminal state on record: when the record closed otherwise (a cancellation between the two appends) the record wins — CANCELLED, no draft, the cause first and `RESULT_NAMED_<state>` beside it — a function of the log alone, so every redelivery reads the same answer. A terminal state without a RESULT is no longer written by this core on any path (`FAILED_CONTRACT` and `ABSTAINED_MATERIAL` go through `finish()` as well); the one the host can still produce — a cancel on an attempt no owner finished — is answered CANCELLED on the next delivery and its RESULT stored |
| R2K-02 one lost renewal stops renewing | closed | a renewal that loses its append to a writer that did not take the run (a host note, a cancel) is tried again on the next tick on the re-read log; only a lease now held by another owner ends the renewals, and the fence takes it from there |
| R2K-03 `commit()` two non-atomic appends | closed | the response is written before the bill: a crash between the two leaves a stored answer under an open reservation, which the reopening keeps ambiguous (full size, never less) and reuses without buying; each append is decided again when it loses to a host write between them (`appendDeciding`, bounded), so a cancel between the response and the bill neither fails the owner nor loses the answer — the run ends CANCELLED with its RESULT. The host's `cancel()` is two appends as well (CANCELLED, then its STATE): a cancellation on the record whose closing STATE never landed is a cancellation to `finish()`, to the closing transition and to the reopen check — the owner or the next delivery closes the state from the CANCELLED event, never works past it, and the RESULT names CANCELLED with the cause first |
| R2K-04 cancellation and deadline outcomes | documented, codes fixed | `TaskOutcome` has no cancellation member; adding one changes the outcome vocabulary shared with the compiler, the benchmark scorer and the hosts (`src/contracts/errors.ts` is a shared contract), so the outcome stays `BUDGET_EXHAUSTED` — a cancellation or a deadline is the host's wall-clock or resource bound closing the run — and the cause is `codes[0]` on every path: `RUN_CANCELLED` / `DEADLINE_PASSED` on the task cut short, on the run-level item, and now also on the cancel that lands after the last provider answer, which round 3 published with no cause at all. A receipt found unsound still ends `FAILED_COMPILER` with the cause on the `validation` item; the state vocabulary is unchanged |

Tests: `test/kernel-correction4.test.ts` (17 tests; 14 of them fail on
`ef171d8`, the other three pin behaviour that already held). The round-3 test
"a process that dies between the terminal state and the result … names the
ledger" (`test/kernel-identity.test.ts`) pinned the R2K-01 gap itself (a
permanently unanswerable attempt); it now asserts the stronger contract —
the crash before the RESULT leaves the run open, never closed without an
answer, and the redelivery after the lease answers with no send. Mutations
appended to `tools/sabotage-inventory/kernel.mjs`, each verified KILLED:
`deterministic-evidence-dropped`, `result-after-terminal-state`,
`renewal-stops-on-lost-cas`, `bill-before-response`,
`commit-append-not-decided-again`, `cancel-cause-unnamed`,
`half-written-cancel-worked-past` (inventory 151); the eleven round-2/3
kernel mutations adjacent to the rewritten code re-run KILLED. Contract
changes a host absorbs (all additive, no version bump): `draft.evidence`
entries carry `origin`; the `RESULT` event precedes the closing `STATE` in
every log this core writes, and `RESPONSE_STORED` precedes `COMMITTED`; a
`RUN_CANCELLED` / `DEADLINE_PASSED` item on the run is present on every
cancelled or expired result; the closing `STATE` reason is `run finished`
(the version and adapter problems that used to be its reason are on a `NOTE`
and on the result's codes). The round-2 table row for IC-09 above is
superseded by this one. Suite 327 tests, 23 files, green.
