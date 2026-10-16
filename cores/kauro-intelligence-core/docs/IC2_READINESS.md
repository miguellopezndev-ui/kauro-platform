# IC-2 readiness

What IC-1 hands to IC-2, what IC-2 must produce, and what stays FALSE until it
does. IC-1 spends zero paid inference; every model interaction here is a
scripted, replayed or oracle gateway behind the same `ModelGateway` interface
the real adapter will implement. The closure of package B03 (core 0.5.0,
`docs/work/RELEASE_0.5.0.md`) changes what is handed over: the sections
"Handed over by IC-1" and "IC-2 must produce" are brought to it, and "Closure of
B03 (0.5.0)" below says what it leaves open for B04 (the live provider) and B08
(the platform host).

## Handed over by IC-1

| item | where | state |
| --- | --- | --- |
| kernel: adapter, resolver, planner, envelope builder, classifier, minimizer, egress, ledger, compiler, memory | `src/` | closed by INTELLIGENCE-ARCHITECTURE-01 |
| `ModelGateway` interface and the transport gateway shape (`buildProviderRequest`, `parseProviderResponse`) | `src/gateway/` | fixed; the provider adapter plugs in behind it |
| `MODEL_POLICY_V1` (claude-sonnet-5-5, a CandidateProfile pin, US multi-region, effort HIGH, tools NONE, logging OFF, cache OFF, batch OFF, failover OFF) | `src/gateway/model-gateway.ts` | pinned; IC-2 must produce the IAM, endpoint and data-control evidence (§72) |
| `PROMPT_BUNDLE_V1` (1.3.0) | same | versioned constant; hash exported; the twelve task definitions state what each family answers |
| benchmark format, expected-truth sealing, scorer with hard gates | `src/benchmark/harness.ts` | closed; corpus absent |
| `FullDatasetValidationPort` contract and soundness rules | `src/ports/ports.ts`, `validationIsSound` | closed; the host implements it over its Migration Core |
| host DTO boundary (`IntelligenceInput` / `IntelligenceResult`) | `src/api/intelligence-core.ts` | closed; INTELLIGENCE-CONSUMER-01 proves it from the packed tarball |
| the twelve capability families, each resolved, asked, compiled, assembled and observed in Migration Core's effects | `src/resolver/`, `src/envelope/`, `src/compiler/`, `src/adapter/` | closed offline (SIMULATED): `test/b03-closure.test.ts` runs all twelve in one scenario; their live usefulness is B04's qualification |
| candidate accounting: the expected set, one disposition per candidate, `coverage.complete`, `planCandidates` | `src/planner/candidate-accounting.ts` | closed; B08 reads `candidateAccounting` and the pending scope from the result |
| `DispatchAdmission` (money admission before every dispatch) and its labelled in-memory fake | `src/kernel/admission.ts` | closed; the shared CostGrant behind the port is B08's |
| CandidateConfiguration 2.0.0 and the receipt 2.0.0 with its closed `effects` block (`toMigrationConfig`, `effectsFromMigrationRun`) | `src/ports/ports.ts`, `src/adapter/` | closed; the host's port runs the real Migration Core, proved from the packed tarball in a vendor-mode run |
| `compileSelection`: the agency's selection to a configuration or a closed rejection | `src/compiler/plan-compiler.ts` | closed; B08's CMD022 consumes it |
| sabotage inventory (311 mutations: the 175 of v0.4.0 and the 136 of the B03 closure) | `tools/sabotage.mjs`, `tools/sabotage-inventory/` | all killed; IC-2 extends it for the provider adapter |

## IC-2 must produce

1. Provider adapter behind `ModelGateway` with the pinned policy; evidence for
   IAM, endpoint, region, logging OFF, no training, retention (§72).
2. Benchmark corpus: at least 600 distinct fixtures across the three modes with
   sealed expected truth (§82); three complete, independent OPUS-Q1 runs on the
   same sealed corpus and candidate (§84–§86). Qualification is by thresholds,
   not by equality of scores or of generated text: in every run the eight hard
   gates are zero and every gate was actually observed; ambiguous/abstention
   correctness ≥ 99% in every run; supported-recommendation correctness ≥ 97%
   in every run; the mean supported correctness of the three runs ≥ 98%. A hard
   failure invalidates its run and is never averaged away.
3. AI-BUDGET-01 measured against the real provider with the bounds of §61.
4. Extension of the sabotage inventory to the adapter (timeouts,
   AMBIGUOUS_BILLED against real ids, malformed provider payloads).
5. Threat-model rows T4, T16, T23–T26 measured, not only constructed.
6. The live usefulness of the twelve families: every decision of the closed design comes from a labelled fake offline, so the qualification corpus must exercise each family against the real model (object, field, semantic type, transformation, value map, identity, duplicate signal, association, unmapped handling, target requirement, consistency review, repair) and report it by family.
7. The token counting method of the provider: the money admission's reservation uses the UTF-8 byte length of the prepared request as the input upper bound until the provider's own counting method is bound (D3-GRANT-1).

## Flags

| flag | IC-1 | set TRUE by |
| --- | --- | --- |
| INTELLIGENCE_CORE_ARCHITECTURE_CLOSED | computed by `tools/architecture-gate.mjs` | this repository, from evidence |
| INTELLIGENCE_CORE_RELEASE_CANDIDATE | FALSE by construction | IC-2: OPUS-Q1 + AI-BUDGET-01 + provider evidence |
| INTELLIGENCE_CORE_V1_FROZEN | FALSE by construction | IC-3: independent freeze, red team, release provenance |

## Revision 009 (R-IC-PRIVACY) — what changed and what stays open

- Data policy 1.5.0 / masking policy 1.3.0 / core 0.4.0: the compact-token
  eligibility rule (`compactVerdict`) and scoped opaque references
  (`ReferenceScope`). Evidence recorded under the earlier policies is
  invalidated for classification and masking claims; the round-4 probe
  results are historical.
- Revision 009b — data policy 1.5.1 / core 0.4.1, after the independent
  review of 0.4.0 (PRIVACY-009-CASE-BYPASS, PRIVACY-009-LENGTH-BYPASS): a
  single-letter camel hump is no longer a symbol (`nG1`, `wU99`, `yN1` are
  handles), the compact token has no length cap and the handle rule is read
  before the metadata length rule (a 97-character handle is a handle, and
  the column carrying it is withheld). Classification evidence recorded
  under data policy 1.5.0 — the review's `camel-transport` and
  `length-transport` runs among them — describes another contract.
- WO-IC-PRIVACY-20260915-01 — data policy 1.6.0 / core 0.5.0, the
  consolidation of 009/009b (commit c8a5b1c, reused with its ancestry) and
  its independent qualification: the LABEL and IDENTIFIER channels no longer
  admit a token by its case (SMITH was structural, Smith a name) or by the
  shape of a join or the identifier grammar (Okonkwo, OkonkwoNdebele,
  Okonkwo__c). Work record: `docs/work/R_IC_PRIVACY_20260915_01.md` at commit
  d7b3d28 (blob 420b4dd3, sha256 49856823…8706), removed from the tree in
  0.4.0 (see `docs/work/RELEASE_0.4.0.md`).
- Privacy repair of B03 — data policy 1.7.0 / masking policy 1.4.0 / core
  0.3.0 (version unchanged, see the compatibility matrix): the retained
  candidate merged with its history, then the identifier case bypass, the
  suffixed-name availability failure, provider text in the record,
  cross-client agency memory and attempt-unscoped references repaired.
  Record `docs/work/PRIVACY_REPAIR_RECORD.md`, matrix
  `docs/work/PRIVACY_MODE_SURFACE_MATRIX.md`.
- Unresolved gates: provider qualification (IC-2), publication and
  distribution, live-provider egress evidence, full IC-05 option-label
  transport coverage (the adapter discards labels; only the classifier
  guard is tested), full architecture qualification and the
  `tools/consumer-check.mjs` installer conversion — none accepted here.

## Closure of B03 (0.5.0) — what changed and what stays open

- Versions, once (D3-VER-1): core 0.5.0, envelope 2.0.0, proposal 2.0.0,
  prompt bundle 1.2.0, compiler contract 2.0.0, run ledger 2.0.0,
  configuration 2.0.0, receipt 2.0.0; Migration Core stays the vendored 2.0.1
  release (`docs/COMPATIBILITY_MATRIX.md`). Evidence recorded on `v0.4.0` —
  its verification log, its 175-mutation sabotage run, its consumer check —
  describes another contract.
- The twelve capability families run the whole chain and are accounted: every
  expected candidate has one disposition, the coverage manifest meets each
  decision with its fragment and the effect the receipt reports, and a run the
  grant cannot fund to the end names the tasks it did not start
  (BUDGET_EXHAUSTED) and their candidates (PENDING_BUDGET). The public result
  and log are a projection; the host's store keeps the protected record.
- Open for B04: the provider adapter and its qualification of the families,
  the provider's token counting method, the bytes and headers a real request
  carries, and the re-pin of the renamed Migration Core release (2.0.3 has no
  published artifact; the design is made against the vendored 2.0.1
  configuration schema).
- Open for B08: the durable journal on PostgreSQL behind `LedgerStore`, the
  shared CostGrant behind `DispatchAdmission`, and the commands that start
  (CMD020), cancel (CMD021) and plan (CMD022) an audit; the IC cases that
  depend on them are PARTIAL in `docs/design/B03-case-map.md`.
- The configuration stays CREATE_ONLY: the effect of an identity strategy is
  source-side proof (authoritative external ids); destination matching for
  UPSERT belongs to the execution packages.

## Release candidate 0.6.0-rc.1 (B04) — what changed and what stays open

- The policy is pinned to Sonnet 5.5 and **UNQUALIFIED**: `MODEL_POLICY_QUALIFICATION` and `compatibilityMatrix().modelPolicyQualification` say so, and the
  flag `INTELLIGENCE_CORE_RELEASE_CANDIDATE` stays FALSE by construction. 0.6.0-rc.1 is a candidate for the funded campaign, not a qualified release
  (`docs/design/B04-design.md` D4-REL-2).
- Built and tested offline, SIMULATED: the Vertex wire, transport and receipts, the candidate profiles with eligibility before cost, the sealed
  660-fixture corpus, the scorer with its validity record, qualification (subject, independence, campaign grant and stop rule), and the campaign runner
  (smoke, pilot, qualify, rehearse) that packs the tarball, installs it in a clean directory and imports the package by name through `.` and
  `./benchmark`. The rehearsal over the 660 with the recorded transport passes three times and is never qualification evidence.
- The pilot compares every admitted candidate (Sonnet 5.5 primary, Opus 5.5 comparator) under one grant and one stop rule and writes the selection record
  (eligibility, zero critical, thresholds, cost per accepted plan, latency); qualification runs only the selected candidate under the pinned policy. If the
  pilot selects Opus 5.5 the pinned policy is bumped by the release that follows the selection, before grant B.
- Open, needs the owner (from 2026-10-08, `docs/design/B04-campaign-envelope.md` §7): the nonprod project with the Claude models enabled, the service account
  with impersonation, the quota, grant A (smoke and pilot) and, after the pilot, grant B. Then: smoke, pilot and selection, the three runs, release 0.6.0 with
  the qualification record, the Codex offline review of the rc and the package-close review of 0.6.0.
- Open and unverified offline: the exact path and answer shape of the request-response logging read-back for a partner model (`tools/campaign/preflight.mjs`),
  Vertex's acceptance of the compatible body, the served model and usage the real responses report, and the real token counting against the byte upper bound.

## B04 integrate (0.6.0 on Migration Core 3.0.0 and Amazon Bedrock) — the frozen tree

- Owner decision A9 (2026-10-05): the provider is Amazon Bedrock through a `us.` geography inference profile (D4-BR-1, D4-BR-2), with
  temporary AWS credentials and the free control-plane probes P1-P8 before any paid byte; the Vertex wire stays in the tree, retired.
  Migration Core is the published 3.0.0 release (D4-REL-1 amended), configuration schema 3.0.0 with whitespace decided per primitive
  (D4-MC3-1), the raw header in the configuration (D4-HDR-1), and a blocking requirement deferred to the agency (D4-MC3-2).
- Campaign safety, SIMULATED offline: retries 2 s / 8 s with digest jitter, documented 429 releases and a RATE_LIMITED stop; lock recovery
  only on proof of death; grant candidates and run count on the ledger; scores fsync'd before the next dispatch and a pending STOP rebuilt
  on restart; Sonnet measured first (D4-CAMP-11); the stage stops only on a registered hard gate, and a request whose billing is unknown
  is a transport failure in the budget ceiling while its hold stays at the maximum (D4-CHAOS-1). The chaos rehearsal
  (`docs/work/CHAOS_REHEARSAL.md`) is SIMULATED and is never qualification evidence.
- Scorer validity v4 (D4-VAL-4): the committed record binds this tree's package content digest, Migration Core 3.0.0 and its tarball,
  the prompt bundle and the model policy; a funded stage reruns it in its clean install and refuses VALIDITY_STALE on any difference.
- Release (B04-design §2.7): D4-REL-2' is PROPOSED to Codex - the qualification state leaves the package bytes and is recorded in
  `docs/work/QUALIFICATION_0.6.0.md` and a `release-record.json`, so the qualified tarball is the released tarball. Until Codex rules,
  the policy stays UNQUALIFIED in the bytes; if Codex rejects D4-REL-2', the rc plan of D4-REL-2 applies (0.6.0-rc.1 qualified, then
  0.6.0). `INTELLIGENCE_CORE_RELEASE_CANDIDATE` stays FALSE by construction.
- Open, needs the owner (AWS account after the company NIT/RUT, A9 §5): the account and the Bedrock model access, grants A and B in
  `.kauro/grants.md`, then the live probes P1-P8, smoke, pilot and selection, the three qualification runs, the qualification record and
  the package-close review. No AWS call and no paid call was made for this tree.

## Known limits carried forward

- The oracle gateway resolves by canonical field tail; it exists to exercise
  the pipeline end to end, not to stand in for a model's judgement.
- Classification is by shape; measured recall against real PII shapes is an
  IC-2 result.
- The consumer check runs a CLEAN_ONLY fixture and, since 0.5.0, a SALESFORCE
  run over the twelve families from the packed tarball (an attested contract,
  the dry-run truth in the candidate set, the real Migration Core in the
  port); a HubSpot run is covered by the integration suite with synthetic
  contracts, not by a packed consumer. The benchmark runner surface is on the same index (the package
  exports `.` and, for the campaign, `./benchmark`): `capturingTransport`, `isTransportBody`, `wireForms`,
  `observeEgress`, `scoreFixture`, `benchmarkReport`, `qualifyThreeRuns`,
  `reportDigestOf`, `REPORT_MODES`, `QUALIFICATION_CORPUS`, `corpusShortfall`
  and their types; `test/benchmark-surface.test` proves each is the harness
  object, not a copy. An IC-2 runner imports them from the tarball and
  reimplements none of the capture.

## Carried forward by the IC-1 correction (2026-09-11)

What the repair of audit findings F01–F07 leaves for IC-2 to decide or
measure against the real provider and the sealed corpus:

- **Request shape acceptance.** The request sends exactly six top-level
  members: `model` (the pinned id), `max_tokens` (the bundle ceiling, 8192,
  or the smaller ask), `system` (the bundle sentences for the task),
  `messages` (one user message: the `<request>` identity block, the `<data>`
  block and the bundle's closing instruction), `output_config` (`format`
  json_schema with the bundle schema, `effort: 'high'`) and `tools: []`.
  It sends no `temperature` (the pinned model accepts only its default
  sampling; a value would be rejected or ignored, and either is a request
  nobody recorded) and no `metadata` (the Messages metadata object defines
  only `user_id`, an opaque end-user id this core has no end user for); the
  ledger correlation reaches the transport beside the request, as
  `TransportCorrelation`, never inside the provider object. Every sentence,
  tag and parameter around the envelope is a member of `PROMPT_BUNDLE_V1`
  (1.1.0), so the bundle hash covers the bytes a model reads and the payload
  parser refuses a request whose text, schema, ceiling or member set is not
  the bundle's. What remains for the first real smoke: that the endpoint
  accepts `output_config.format` json_schema with this schema and
  `output_config.effort` for the pinned model, that the default temperature
  answers the frozen corpus deterministically enough for the benchmark, and
  the actual input/output token cost of the bundle against the eight budget
  bounds; any change to the bytes is a prompt-bundle version bump (the bundle
  hash is part of run identity).
- **Typed non-billing evidence.** HTTP 429/5xx are kept ambiguous at full
  reservation size because the transport has no proof they were not billed.
  IC-2 may add provider evidence that turns specific statuses into typed
  `neverSent`/not-billed proofs; the kernel already consumes the field.
- **Classifier recall and precision.** Names are detected by a compact list
  plus proper-noun shape; headers by a positive vocabulary. Precision costs
  (masked harmless headers) and recall gaps are measured on the corpus;
  neither is tuned by looking at candidate outputs.
- **Lease between live workers.** The kernel recovers a crashed worker and
  bounds a concurrent duplicate; it does not arbitrate two live workers on one
  attempt. The IC-2 host/queue design must deliver one attempt to one worker.
- **Egress evidence for the scorer.** `observeEgress` must be fed the bytes
  captured at the transport boundary (`buildProviderRequest` output), not the
  envelope object, for the secret-egress gate to be evidence of egress.
- **Campaign record.** Every `BenchmarkReport` carries `reportDigest`, the
  digest of its other members (the scores' digest and the mode among them);
  `qualifyThreeRuns` recomputes it and refuses a report that does not match
  before it reads a field. The IC-2 campaign record pins the three digests.
  A correct score without a run id is a report failure; the scorer emits a
  null run id only for a missing result, which is incorrect. A tampered
  configuration under a stale receipt is a scorer failure (`correct: null`,
  never a pass), not `correct: false`; and `allowedExtraDestinations` is a
  destination allowance, not a (source, destination) pair — corpus authors
  enumerate expected candidates rather than allow extras.
- **Weighting.** Thresholds use fixture counts; weighted rates are reported
  only. Confirm the weighting rule before sealing the 600-fixture corpus.
- **Store implementation.** A database or file `LedgerStore` must implement
  compare-and-append under a lock or a unique `(runId, sequence)`; the
  in-process store proves the contract, not a deployment.
