# Architecture decision records — IC-1

One entry per decision that shaped the tree and is not derivable from the
canon alone. Each names the constraint it answers; a change to one of these is
a new ADR, never an edit.

## ADR-001 Migration Core as a pinned peer dependency, installed from vendored bytes

The frozen Migration Core release 2.0.1 is a `peerDependency` pinned to `2.0.1`
and a `devDependency` installed from the tarball `vendor/MANIFEST.json` names
(the release asset, under the npm name that release was published with).
Rationale: the host runs one engine; two copies of Migration Core in one
process would let profile hashes drift between what was profiled and what is
validated. A `file:` runtime dependency also does not survive `npm pack` for a
consumer, which INTELLIGENCE-CONSUMER-01 proved. The tarball is the release
asset, hashed against the dossier's delivery manifest (`vendor/MANIFEST.json`),
and CONTRACTS-01 refuses any other bytes.

## ADR-002 Closed runtime schema validator instead of a schema library

`src/contracts/schema.ts` implements the subset of JSON Schema the contracts
need (closed objects at every depth, enums, patterns, bounded arrays, `oneOf`
with depth). Rationale: zero runtime dependencies in the kernel, a validator
whose behaviour is fully in the tree, and a `proposalJsonSchema()` export that
is the same object the provider will receive as its output schema.

## ADR-003 Canonical JSON and 64-hex digests for every reference

Refs (`fld_`, `evd_`, `tgt_`, `cand_`, `task_`) and hashes are SHA-256 over
canonical JSON (sorted keys, no whitespace, numbers as JSON). Rationale: the
envelope hash, the egress token, the proposal binding and the idempotency key
all need one deterministic serialisation across hosts and operating systems.

## ADR-004 Egress is an HMAC token, not a flag

`decideEgress` returns a token = HMAC(kernelSecret, envelopeHash) only when
every field's classification allows it; the gateway path calls
`assertEgressBinds` and refuses a request whose token does not recompute.
Rationale: canon §21 requires that disabling the classifier or minimizer
blocks the send; a caller-owned boolean cannot carry that property.

## ADR-005 Object resolution per file, from declared objects or strict header majority

The resolver determines the target object of each source file from
`declaredObjects` in the project revision, or else from a strict maximum of
header matches; ties or no majority open an `OBJECT_MAPPING` task with a
derived object candidate. Rationale: without it, CLEAN_ONLY runs with two files
saw every field ambiguous across objects and the pipeline degenerated to
questions.

## ADR-006 A contaminated field emits nothing

If any exemplar of a field classifies L3/L4 or UNKNOWN, the field contributes
counts and shape only, no exemplar. Rationale: partial minimisation leaks
through the survivors; the model still gets the header class and the value
class distribution, which is what mapping needs.

## ADR-007 Planner cap 32 with visible truncation

`MAX_SEMANTIC_TASKS_PER_AUDIT = 32` is reserved per task in the ledger; when
the plan exceeds it, the remaining candidates are preserved unmapped and the
truncation is reported in the result. Rationale: canon §61 bounds; §63 visible
truncation. The number is the canon's.

## ADR-008 Ledger: append-only events with a transition table and atomic reservations

`RunLedger` records events; state is derived; `RUN_TRANSITIONS` is the only
source of legal moves; `reserve` is atomic per run and a timed-out reservation
becomes `AMBIGUOUS_BILLED`, never released. Redelivery of the same idempotency
key opens the existing run and returns its stored `RESULT` event. Rationale:
canon §64–§66 and §76–§79; idempotent hosts retry.

## ADR-009 Fake gateways live in `src/gateway/fake-gateway.ts` and are exported

Scripted, replay and oracle gateways are part of the public entry. Rationale:
the consumer check and the host's own tests need a gateway with no provider;
they are marked `CONTROL_FLOW_TEST_ONLY` in their descriptors and the
architecture gate refuses provider SDKs anywhere in `src`.

## ADR-010 Validation soundness is decided by the kernel, not by the port

`validationIsSound` checks the port's answer against the profile hash,
candidate set hash, contract hash, `rowsInProfile === profile.dataRowCount`,
`rowsValidated === rowsInProfile`, reconciliation, package verification, core
version and freshness. Rationale: canon §32; a host port is host code and the
kernel treats it as untrusted input.

## ADR-011 Sabotage inventory of 25 named mutations, each with a killing oracle

`tools/sabotage.mjs` rewrites one production line per mutation, runs the
suite, restores the tree, and reports killed/survived/didNotCompile. A mutation
that does not compile is not a kill. Rationale: the architecture gate's
`sabotage_all_killed` fact is only meaningful if each control has a test that
fails when the control is removed. The harness rewrites source in place: the
tree must be clean and untouched while it runs.

## ADR-012 Architecture flag computed by ten facts; RC and FROZEN FALSE by construction

`tools/architecture-gate.mjs` executes build, contracts, tests, sabotage and
the packed consumer, and measures exports, production-path purity, budget
bounds, model policy and documents. The flag is TRUE only when all ten are.
`RELEASE_CANDIDATE` and `V1_FROZEN` are written FALSE with the reason.
Rationale: canon §103 and the owner's rule that no gate is lowered and no
freeze declared by hand.

## ADR-013 Run identity is the host's AuditAttempt, never the clock

`HostContext.auditAttemptId` is required; the run id derives from it and the
tenant, and `RUN_CREATED` binds the input hashes and every material version.
A redelivery of the same attempt opens the same run whatever the clock says;
the same id with other content is `IDENTITY_CONFLICT`; a new attempt the
agency authorised is a new id. Rationale: audit F02 — a run id that included
the instant of creation made every redelivery a second billed run; canon
§76–§79 want redelivery to find the durable response, not buy it again.

## ADR-014 Compare-and-append is the persistence contract

`LedgerStore.append(runId, event, expectedLength)` succeeds only when the log
has exactly `expectedLength` events. Every ledger write goes through it, so
two consumers on the same stale view cannot both reserve the same billable
unit; the loser gets a typed conflict. Proven with a deterministic
interleaving store in tests; a database or file store implements the same
rule under a lock or a unique `(runId, sequence)`. Rationale: a `Map` in one
process demonstrated nothing about two workers (F02).

## ADR-015 One reservation per invocation; unknown usage is not zero

Every potentially billable invocation — initial send, transport retry, repair
— is reserved before it happens and reconciled from its own result. Usage
must be finite, integer and non-negative; otherwise it is unknown and the
reservation is billed at full size. A retryable failure is released only on
the transport's typed `neverSent` proof; HTTP 429/5xx carry no such proof
and stay ambiguous. Invocations, responses and ambiguous reservations are
counted separately. Rationale: audit F04 — three invocations reported as one
call, and a 200 without usage billed as 0/0.

## ADR-016 Metadata is classified like data, then masked

Headers, labels, api names, options, memory patterns and repair codes pass
through the same PII/secret/instruction rules as values plus a positive label
vocabulary; what fails is replaced in the envelope by a masked token and the
egress decision re-reads the envelope before signing. Low cardinality, short
length or a single word never prove absence of PII; names and proper nouns
are PII. Rationale: audit F01 — an email header travelled as "structural
metadata" and `Alice` as a safe enumeration. The residual cost is precision
on unlisted vocabulary, measured in IC-2.

## ADR-017 Expected truth is a set of decisions; the scorer reads only the result

Benchmark format 1.1.0 seals per-candidate decisions, required evidence refs,
forbidden destinations, compiler result, preserved headers, task types, data
and budget ceilings, input-hash binding and hard-gate markers. The scorer
compares them against the `IntelligenceResult` and an observed egress record,
records every executed check, and reports a gate as NOT_OBSERVED when no
check exercised it. Scorer, fixture and infrastructure failures are never a
pass. Rationale: audit F03 — sealed fields that were never consulted.

## ADR-018 The provider request is self-contained; fakes see only bytes

The message carries a `<request>` block (run, task, envelope hash, policy and
prompt versions with hashes, schema version) and the `<data>` block;
`output_config` fixes the JSON schema and the effort explicitly. Offline
gateways are transports that parse those bytes back; nothing else of the
`GatewayRequest` object is reachable. Transport failures are typed by stage;
only `BEFORE_SEND` is free. Rationale: audit F05 — an oracle that read
`request.runId` off the object proved nothing about a model.

## ADR-019 The validation receipt is a closed schema and the port is a trust boundary

`FullDatasetValidationResult` is validated at runtime: finite integer counts,
exact coverage, supported core version, `ok ⇔ no problems ⇔ reconciliation ⇔
verify`, a digest of the exact configuration, a timestamp not before the run,
and digests of the package and report Migration Core produced. A host that
forges every fact cannot be caught by shape; the digests let an auditor check
what ran. Host adapters translate the whole fragment or refuse it
(`UNSUPPORTED_BY_CORE:*`); nothing is dropped silently. Rationale: audit F06.

## ADR-020 Diagnostic and qualification are different runs; evidence is bound to its subject

`sabotage --only` is a diagnostic that never qualifies and refuses unknown or
empty selections; a qualification run records the subject (commit, tree,
clean), inventory and producer digests and per-mutation records, and `passed`
is recomputed from them by a verifier the architecture gate applies to the
report it just produced, or (`--sabotage-report`) to a supplied report that it
verifies against the same subject before using it; CI runs the inventory in
`--shard k/n` slices that `tools/sabotage-merge.mjs` merges only when all n are
present once, of this commit, and cover the inventory exactly. There is no
`--skip-sabotage`: the only reuse is of a verified report. The gate's report names its subject, producers and
dependency closure; a chain rehearsal exercises the whole path to a receipt
under `REHEARSAL` labels. Rationale: audit F07 — an empty selection printed
PASS and a boolean in a file was called verified evidence.
