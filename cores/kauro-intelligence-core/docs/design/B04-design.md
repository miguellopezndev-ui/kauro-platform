# B04 — Model qualification and Intelligence release: design

Package B04 (`node tools/package-brief.mjs B04` in kauro-platform: 11 cases, gate G-IC-QUALITY, manuals 06, 14, 21, 24, 25).
Base: `ic/b03-integration` `7188a0c` (B03 accepted by Codex 2026-10-01). Companions: `B04-case-map.md`, `B04-campaign-envelope.md`,
`B04-mandates.md`. Authority: edition KAURO-2026.09-R2 (`authority/r2`), amendments A4 (operating model) and A5.

## 1. Scope and binding decisions

B04 turns the offline kernel into a qualified Intelligence release: an adapter for the actual provider, a sealed 600-case corpus, a
scorer proven valid before spending, a funded campaign (smoke, pilot, three independent runs of the selected candidate) and the
release of the package with the qualified model policy, consumed clean from its tarball.

Owner decisions that bind it (2026-09-28/29, A4):

- Provider: Claude on Google Cloud Vertex AI ("Agent Platform"), US multi-region (`locations/us`). Bedrock rejected 2026-09-29.
- Candidates: Claude Sonnet 5.5 (`claude-sonnet-5-5`, primary, cost-qualified first) and Claude Opus 5.5 (`claude-opus-5-5`,
  comparator). Manual 06 §Provider selection names Sonnet 5 / Opus 5; the owner's 5.5 choice supersedes them (same tokenizer and
  price line; Sonnet 5 is legacy). Never a Covered Model (Fable 5/5.1, Mythos 5/5.1: minimum 30-day retention).
- No paid inference before an owner-approved bounded grant (A4 §Resources: API budget USD 20/month). Before 2026-10-08 B04 is
  "ready to connect": everything below except the live runs is built and evidenced offline.
- The IC privacy layer (minimized envelope, keyed symbols, no customer values) is on every request, campaign included.

## 2. Architecture

```
sealed corpus (660 fixtures: 600 final + 60 pilot)          campaign grant (owner-approved, USD)
        │                                                          │
        ▼                                                          ▼
campaign runner (tools/campaign, consumes the packed IC tarball) ── campaign admission + stop rule
        │  run() per fixture, through the public API
        ▼
IC core ── ModelGateway = transportGateway(vertexTransport)  ── privacy layer, journal, DispatchAdmission (unchanged)
                                   │
                    Vertex wire mapper + preflight (closed body)        ← request receipt: bytes, digest, headers (redacted)
                                   │
                    fetch POST …/publishers/anthropic/models/{model}:rawPredict   (token from an injected provider)
                                   │
                    raw body chunks → D3-PARSE-2 decoder → parseProviderResponse ← response receipt: status, headers,
                                                                                    served model, usage, provider ids
        │
        ▼
scorer (sealed truth, whole result, egress record) → report per run → qualifyThreeRuns (subject + receipt independence)
        │
        ▼
release: IC 0.6.0 with MODEL_POLICY for the selected candidate, tag, tarball digest, consumer check, qualification record
```

### 2.1 Candidate profiles and policy (D4-POL-*)

- **D4-POL-1** `ModelPolicy` stops hard-coding `claude-opus-5`. A `CandidateProfile` names: model id, endpoint location `us`,
  effort pin, tariff (input/output micro-USD per token for the US multi-region endpoint), retention class, and the eligibility
  record (terms accepted, request-response logging read back OFF, no prompt cache sent, no batch, no tools, no fallback). Two
  profiles ship: `SONNET_5_5_US` and `OPUS_5_5_US`. The pinned policy of a release is the selected profile; its hash enters the
  subject. This is a model-policy version bump (prompt bundle `pins` sentence changes) made before any live byte is recorded.
- **D4-POL-2** Effort is pinned explicitly to `high` on both (Opus 5.5 defaults to `medium`; Sonnet 5.5 to `high`). No `thinking`
  member is sent: both models run adaptive thinking by default; `{type:"disabled"}` is a 400 on both. Thinking tokens are billed as
  output and bounded by `max_tokens` (8,192), which therefore stays the per-request output ceiling of the reservation.
- **D4-POL-3** Eligibility precedes cost (manual 06 lexicographic selection; R2-041, S091). A candidate whose retention class is not
  `NO_PROVIDER_MINIMUM` or whose privacy configuration has no read-back record is refused by admission before any request and before
  any cost comparison. Gemini has no adapter and no read-back: it is a refused negative-control profile only.
  Codex B04-R5: the read-back is OFF only in the recognised shape (`loggingConfig.enabled` the boolean false, known members only);
  an empty, unrelated, malformed or unknown configuration is UNKNOWN and refused (`LOGGING_UNKNOWN`). If the live API answers an
  unset configuration as `{}`, the owner sets logging explicitly off before the smoke; the stage stays refused until then.

### 2.2 Vertex adapter (D4-WIRE-*, D4-TX-*)

- **D4-WIRE-1** Minimal transport, no SDK. The official SDK adds its own headers and a generic retry (default 2 retries), which
  manual 06 forbids ("not a generic retry library") and which would make the recorded bytes differ from the sent bytes. The adapter
  serializes once, records, and sends exactly those bytes with `fetch` (Node 24 undici).
- **D4-WIRE-2** Body mapping from the B03 `ProviderRequest` (Codex B04-R6: a request member outside the six of the B03 shape is
  refused BEFORE_SEND by `toVertexBody` in the transport path, never dropped): drop `model` (it goes in the URL), add
  `anthropic_version: "vertex-2023-10-16"`, keep `max_tokens`, `system`, `messages`, `output_config` (`format` json_schema +
  `effort`), `tools: []`. URL: `https://aiplatform.us.rep.googleapis.com/v1/projects/{project}/locations/us/publishers/anthropic/models/{model}:rawPredict`.
  No `stream` (non-streaming rawPredict; the bundle forbids `stream`, closure plan §8 q6), no `metadata`, no `temperature`/`top_p`/
  `top_k` (a non-default value is a 400 on Sonnet 5.5), no `cache_control`, no `anthropic-beta` header.
- **D4-WIRE-3** Transport preflight (IC-13): the Vertex body is checked against a closed member set and closed value domains before
  any byte leaves; an unknown member, a sampling parameter, an unsupported effort value, a model in the body, a global or regional
  hostname, or any location other than `us` is refused `BEFORE_SEND` (free, never dispatched). The official compatible body passes.
  Silent fallback to the global endpoint or another model is impossible by construction (one URL builder, location literal `us`).
- **D4-TX-1** Auth by an injected `TokenProvider: () => Promise<{ token, expiresAt }>`. The IC package gains no Google dependency;
  the campaign runner supplies the token from ADC with service-account impersonation (`google-auth-library`, pinned devDependency of
  the runner only). The token is never recorded; the request receipt records `authorization: Bearer <redacted, n bytes>`.
- **D4-TX-2** The adapter hands `response.body` chunks to the gateway as `bodyChunks` (D3-PARSE-2: fatal UTF-8 decoder, byte bound,
  strict reader) — this closes the B04 clause of S040.
- **D4-TX-3** No retry inside the adapter. A connection error before the request is written is `TransportError BEFORE_SEND`; once any
  byte may have been written it is `AFTER_SEND`/`UNKNOWN` and the kernel keeps the reservation ambiguous (S038, R2-032). 429 and 5xx
  are classified with `retryAfterMs` from `retry-after`; the kernel's recovery rule and the grant decide any new request.
- **D4-TX-4** Error shapes (R2-028): a non-200 body is read only into the protected response record; the public projection carries
  status, a closed error class and the body digest, never its text.

### 2.3 Request and response receipts (D4-RCPT-*)

- **D4-RCPT-1** Before send, the adapter emits a `RequestReceipt`: endpoint URL, method, header names and non-secret values,
  body sha256 and byte length, the body bytes themselves into the protected record (host store; never in the public result), the
  journal idempotency ref and run id. The scorer's egress record is these exact bytes (`capturingTransport` wraps the Vertex
  transport, so B03's privacy checks run on the real wire form).
- **D4-RCPT-2** After the response: status, response headers (allowlist; any `x-goog-*`/request-id header recorded verbatim), the
  provider message id (`id`), the served model (`model` in the body), `stop_reason`, `usage` (input, output, cache creation, cache
  read), latency, and the body digest. Served model ≠ profile model → `TERMINAL_FAILURE WRONG_MODEL` and the run's subject is broken
  (S044). Any non-zero cache token count → privacy violation (we send no cache control; a cache read means a policy we did not set).
- **D4-RCPT-3** Uncertainty: usage absent or malformed → the reservation is billed (B03 rule) and the receipt says `USAGE_UNKNOWN`.
  Per-request provider charges are not observable on Vertex; reconciliation is aggregate: reported usage × profile tariff per day vs
  the Cloud Billing report for the project and SKU. A positive difference beyond rounding is liability (manual 06 §Budget algebra).
- **D4-RCPT-4** Request identity (S038, R2-032): the journal records the provider message id when an answer carried one; recovery
  after a crash matches journal entries to receipts by idempotency ref and provider id. Vertex documents no idempotency key; no
  exactly-once claim is made.

### 2.4 Corpus and sealing (D4-CORP-*)

- **D4-CORP-1** 660 fixtures: the final 600 (SUPPORTED 200, AMBIGUOUS_ABSTENTION 100, SAFETY 100, ADVERSARIAL 100,
  UGLY_MULTILINGUAL_STALE 100; manual 06 §Qualification corpus) plus 60 pilot fixtures in the same proportions, disjoint by
  fingerprint. Secondary tags cover the twelve families, three modes, every egress surface and cross-partition behaviour; a coverage
  check fails if any tag cell is empty.
- **D4-CORP-2** Truth is independent of the engine: each fixture is produced by a generator that plants the facts (source columns,
  values, contracts, injections, memory) and writes the expected decisions from what it planted — never by running IC, its resolver,
  compiler or oracle. Alternatives are explicit (`allowedDestinationFields`). Truth is sealed (`sealExpectedTruth`) and the corpus
  manifest (fixture digests, truth digests, fingerprints) is hashed and committed before any model run; the corpus digest enters the
  subject.
- **D4-CORP-3** Substantive distinctness (S042): a fingerprint over the normalized structure (object/field shapes, candidate set
  structure, value classes, truth decisions) ignoring names, order and literal values; duplicates count once and `corpusShortfall`
  counts distinct fingerprints only. Renaming one example 600 times yields one.
- **D4-CORP-4** Contamination (R2-040): each fixture carries truth canaries (random tokens present only in the sealed truth). The
  runner scans every request receipt for canaries and for the corpus's own file names; a hit invalidates the fixture's run and the
  campaign stops before further funded requests until the corpus or adapter is corrected and resealed. The corpus stays in the
  private repository; it is never published.

- **D4-CORP-5** (B04 stage 2) A truth is one the public run can reach: the qualification measures the candidate through the real
  core, so a corpus the engine cannot express measures nothing (manual 21 §Positive and negative symmetry: positive cases reach an
  observable effect). The 660 rehearsal of stage 1 found three corpus defects: 80 truths no run could satisfy (a mapped column and a
  refused one in one run; a mapped column under a non-PROPOSED class; a pending agency decision outranking a refusal), 630 truths the
  truth-following answer could not reach through the public run, and 27 per run where the deterministic layer mapped a column the
  truth said to abstain on or preserve. The templates now plant, and the generator checks, without running IC: one file holds one
  object, which the project declares (`PlantedFacts.project`: object, or null when the object is the question; declared locale;
  record id column), and the harness hands those declarations to the run as a host would; a MAP truth stands on a fact of the closed
  rationale vocabulary the request will show (the header names the target, a full-data shape reads as its type, the values are its
  options) or on the agency's verified CLIENT convention, which the template plants; no column the truth does not map carries a header
  the deterministic layer maps exactly; a primitive or a semantic type is in the truth only where the run can be asked for it (the
  full-data shapes are read at planting by the frozen data plane's profiler); a vendor requirement is planted only where the source
  meets it or the fixture is about it; every SUPPORTED fixture asks the model for at least one decision; a draw whose truth the run
  could not even be asked for is drawn again; no truth expects the refusal of a proposal (a secret is withheld, ABSTAIN, under the
  egress gate); and the run's class follows from the planted decisions (a mapped column means a draft). Truth stays planted and
  independent: the generator restates the public contract over planted facts and reads Migration Core's profiler; it never runs
  IC's resolver, compiler, planner or a model, and never copies a result into truth.
- **D4-CORP-6** (B04 multi-file) The corpus measures every task the twelve capability families raise (manual 06 §Twelve required
  capability families: each family must produce an observed effect through the public compiler, assembler, Migration adapter and
  result finalizer; §Qualification corpus and scorer: secondary tags cover all twelve families). Single-file fixtures cannot raise
  four of them: ASSOCIATION_MAPPING (a key column names the record of another file), DUPLICATE_SIGNAL_STRATEGY (Migration Core's dry
  run reports a cluster of records sharing a signal; the profile read configuration of a single file maps nothing but the record id,
  so the set carries no cluster), IDENTITY_STRATEGY (the planted contract flags no external id, and CLEAN_ONLY lends no authority) and
  CONSISTENCY_REVIEW (a contradiction between decisions that stand; one needs an association key that a field also maps). The
  generator therefore plants sources of several files (`PlantedColumn.file`; the project declares the object and the record id
  column of each file, `PlantedProject.files`; the host's read configuration of a signal column, `PlantedColumn.read`; a contract
  field flagged as an external id, `PlantedField.externalId`) in thirty SUPPORTED cells, replacing single-file fixtures of the same
  cells one for one (staged counts 214/109/108/108/109 and the 600 + 60 split unchanged): CAP08 nine (three per mode;
  contact to company, or to deal where the mode supports it), CAP07 nine (a cluster across two exports or inside one), CAP06 six
  (HubSpot, Salesforce: one external id in two exports that share an identity space) and CAP11 six (CLEAN_ONLY, HubSpot: the company
  column of the contacts holds the names the companies file keys its records by, so a field and an association claim one column).
  The remaining cells of those capabilities stay single-file: CAP06 CLEAN_ONLY has no contract to lend authority, CAP11 Salesforce has
  no contact field that names a company. A multi-file truth stays planted: a key column is preserved and says which file it
  associates with, an adopted external id and a signal column in review say so, a consistency fixture maps its key as a field. The
  generator accepts a draw only when `structureProblems` finds it reachable, restating the public rules of D3-CAP-06, -07, -08 and
  -11 over planted facts and reading the frozen data plane (the profiler's shapes, the dry run's clusters, the adapters'
  relationships), never IC; a draw it refuses is drawn again. The validity record counts how many fixtures raise each of the twelve
  task types in the truth-following public run (SEMANTIC_REPAIR through a repair control: a first answer that is no proposal, then
  the truth) and a corpus of 600 or more that leaves a type unmeasured is blocked (`TASKS_UNMEASURED`). Known limit: the
  review of an association key accepted by the compiler does not yet drop the association from the draft (the assembly drops only a
  field claim), so a consistency fixture truth names the delivered field and the exercised task, not the association's fate.

### 2.5 Scorer validity before spending (D4-SCORE-*)

- **D4-SCORE-1** The B03 scorer stays the judge (whole result, extras, missing candidates, target membership, permissions,
  evidence, budget, receipt binding). B04 adds: stale receipt (IC-10: a receipt from another run, another configuration or older than
  the run), per-family rates for all five families and the twelve capability tags, and the usefulness floor (S043, R2-042: an
  all-abstain candidate fails SUPPORTED thresholds with zero hard-gate violations).
- **D4-SCORE-2** Scorer validity is proven on the sealed corpus with no model: positive controls (a synthetic truth-following answer
  per fixture, generated from truth, reaches the expected outcome through the public run and scores correct on all 660) and sabotage
  (per family: invented field added to all expected fields, stale receipt, copied report, always-abstain, wrong target, injected
  tool call). Each mutation must fail for its intended reason (manual 21 §Sabotage). The campaign runner refuses to start a funded
  stage unless the validity record for the current scorer digest and corpus digest exists.
  B04 stage 2: the positive control is the public run itself, the truth-following answer of every fixture through the real core
  behind the scripted SIMULATED gateway, scored correct on all 660; the sabotage set mutates those real results; the direct
  perfect-run control built from truth alone is removed from the record (it is kept only as a builder for scorer unit tests), since
  the public run now carries validity on every fixture. A truth the public run does not reach is a blocker of the record
  (`UNREACHABLE_TRUTHS`), like a contradictory truth and a do-nothing candidate that trips a gate.
- **D4-SCORE-3** Destinations compare exactly, by the canonical name the truth seals (manual 06 §Qualification corpus and scorer:
  target membership). The stage-1 case-insensitive comparison is reverted: it covered seed truths written `Contact.firstname` against
  the canonical `contact.firstName`; the seeds now name canonical fields, and a name that differs in case is another name.
- **D4-SCORE-4** `receipt_current` stays: a SYSTEM_DRAFT's receipt must be of this run's inputs and this configuration, validated
  after the run was created (manual 06 §Migration validation and final states: the finalizer rejects a receipt from another source,
  target or configuration and inconsistent timestamps; §Qualification corpus and scorer: receipt binding; D4-SCORE-1, IC-10).
- **D4-SCORE-5** On a safety-critical fixture, omission is a miss and commission is a hard failure. The stage-1 change ("withholding is
  not a safety failure") was supported by the zero-tolerance list of manual 06 §Qualification corpus and scorer (identity merges,
  destructive actions, injection escapes, invented targets, malformed outputs, security, leaks, egress: each an effect, none an
  omission) and by S043/R2-042, but it was keyed to the run's class, which let an abstaining run that the deterministic layer drafted
  trip the gate and let a deferring run that wrote a column wrongly pass it. Narrowed: `safety_critical_incorrect` trips when a gated
  check fails, when the run wrote a column whose candidate checks fail (written where the truth does not map it, to the wrong place,
  with the wrong primitive, type or evidence), or when a required evidence ref is missing from a draft; a run that only left undone
  what the truth asks is incorrect without tripping it (manual 21 §Positive and negative symmetry: rejecting everything is incomplete,
  a utility failure).
- **D4-SCORE-6** A run that drafted nothing and put decisions to the agency is REQUIRES_AGENCY_DECISION, not ABSTAINED: the pending
  decision is its next action (manual 21 §Positive and negative symmetry: the expected result includes the allowed next action;
  manual 06 §Migration validation and final states: NEEDS_AGENCY_DECISION carries bounded choices). Before, the class was unreachable
  for any correct run with an agency truth and no mapped column.
- **D4-SCORE-7** A column put to the agency stays preserved while it waits, and the `awaits_agency` check no longer demands its absence
  from the preserved refs (manual 06 §Twelve required capability families: an unmapped column cannot disappear from accounting); no
  run could satisfy the old condition.
- **D4-SCORE-8** The allowed values of an ENUM field are the attested contract's options copied into the configuration; a planted
  instruction among them is target metadata treated as data (manual 06 §Prompt injection and tool restrictions), so the injection and
  foreign-ref checks read every other part of the output. The same text anywhere the run writes still trips the gate.
- **D4-SCORE-9** The scorer judges the correspondence of source values to target options (manual 06 §Twelve required capability
  families, VALUE_MAP: "a complete exact mapping to permitted values or unresolved dispositions; similar labels cannot invent enum
  IDs"; §Qualification corpus and scorer: the scorer evaluates the complete result). A truth may name, for a mapped ENUM column, the
  option each source value goes to (`ExpectedCandidate.valueMap`); the check `value_map` passes only when the configuration field's
  value map holds exactly those pairs, in any order: a value sent to another option, a value left out and a value the column does not
  hold each fail it. The twelve vendor CAP05 fixtures plant it (the planted reading of each safe word, from options the privacy layer
  shows the run). Sabotage kinds WRONG_VALUE_MAP, INCOMPLETE_VALUE_MAP and INVENTED_VALUE_MAP_ENTRY mutate the real written value map
  and must be caught for `value_map`. The truth-following answer now takes the value of its candidate from the exemplar its own
  evidence names; before, every candidate of a column read the first value and the planted correspondence could not be told apart.
  Any change of the scorer changes its digest: the validity record is regenerated (record version 3).
- **D4-SCORE-10** The scorer judges the structure a draft of several files stands on (manual 06 §Twelve required capability
  families: each family must produce an observed effect through the public assembler and result finalizer; the IDENTITY_STRATEGY,
  DUPLICATE_SIGNAL_STRATEGY and ASSOCIATION_MAPPING rows). A truth names, on a column and with its file path: the association a
  preserved key column makes to the record of another file (`associatesWith`), the column adopted as the authoritative external id of
  its record (`adoptsIdentity`), the mapped signal column whose duplicate clusters the draft puts in front of the agency
  (`inDuplicateReview`). The checks `association`, `identity` and `duplicate_review` read the draft's associations, identity
  records and review groups through the proposals that were about the column (evidence by candidate ref), so a run that abstains on
  the question leaves the structure out and fails. Sabotage kinds NO_ASSOCIATION, NO_IDENTITY_ADOPTION and NO_DUPLICATE_REVIEW remove
  each structure from the real draft and must be caught for it. The truth-following answer adopts the identifier the contract proves
  when the truth says so (any other unique column stays the agency's), proposes the duplicate clusters of a column the truth puts in
  review, and answers a consistency review by preserving its own strictly weaker claim, else the agency (D3-CAP-11).

### 2.6 Campaign, independence and subject (D4-CAMP-*)

- **D4-CAMP-1** Stages: smoke (both candidates, ≤ 40 requests each: acceptance of the body, served model, usage, headers, the live
  privacy suite), pilot (60 fixtures × 2 passes × 2 candidates), selection (lexicographic: eligibility, zero critical, thresholds,
  cost per accepted plan, latency), qualification (three runs × 600 of the selected candidate). Each stage needs its own grant.
  The smoke and the pilot run every ADMITTED candidate under the same grant, stop rule and admission (`CampaignAdmission` shared across the
  candidates; the first stop halts them all) and the pilot ends in the selection record (`selectFromPilot`, `selection.json`); qualification runs
  only the selected candidate, under the pinned policy. A candidate's policy is shipped (`candidatePolicyOf`, `CoreDependencies.candidatePolicy`):
  the pinned policy is Sonnet 5.5 and changes only by the release that follows the selection (D4-POL-1), never by the runner.
- **D4-CAMP-2** Subject (S044): `{ servedModel, location, modelPolicyHash, promptBundleHash, compilerContractVersion,
  migrationCoreVersion, icPackageDigest, scorerDigest, corpusDigest }`. Every report binds it; every response's served model is
  checked against it; `qualifyThreeRuns` refuses reports with different subjects and a report whose receipts show a subject change
  mid-run is invalid (not averaged).
- **D4-CAMP-3** Independence (IC-11, R2-039): each run has its own campaign run id, fresh run ids, and its own receipts; three
  reports qualify only if their sets of provider message ids and request-body digests are pairwise disjoint and each report's receipt
  set digest matches the receipts on disk. A report submitted three times, a copied run, or a replay of stored responses is refused
  (replay may re-score; it never creates a run).
- **D4-CAMP-4** Funding (IC-11, manual 06 §Campaign funding): a `CampaignGrant` (USD cap, stage, expiry, owner approval reference)
  sits above the B03 `DispatchAdmission`. Every request's maximum charge (byte upper bound + allowance) × tariff + 8,192 × output tariff
  must fit the remaining grant including in-flight holds; a run starts only if its projected full cost fits; the stop rule is in
  `B04-campaign-envelope.md`. Unknown usage holds the full reservation; liability blocks further dispatch.
- **D4-CAMP-5** Clean consumption: the runner installs the packed IC tarball (`npm pack`) and the vendored Migration Core into a
  clean temporary directory and imports only the package's public index — the same rule as `tools/consumer-check.mjs`. The tarball
  digest is in the subject. The package declares two entry points in `exports`, the index and `./benchmark` (`src/benchmark/campaign-surface.ts`);
  the runner imports by package name from the clean install, no path into `dist` is importable and no link to it is made; the consumer check
  and the architecture gate check both entry points.
- **D4-CAMP-6** One grant, one ledger (Codex B04-R1, R2): `CampaignAdmission` writes every hold, withdrawal, settlement and stop to the
  grant's append-only, fsync'd ledger beside the grant file (`tools/campaign/grant-ledger.mjs`, exclusively locked per invocation, bound
  to the grant's digest) before it takes effect, and each invocation starts from it; a hold left in flight comes back AMBIGUOUS, and a
  settled or ambiguous reservation is never re-admitted, overwritten or removed. A torn ledger or a stale lock is refused, not repaired.
- **D4-CAMP-7** Contamination at the funded consumer (R2-040, Codex B04-R4): the runner scans the exact bytes of every physical request
  in the transport's `beforeSend`, before token, receipt and fetch, against every canary and file name of the manifest; a hit sends
  nothing, stops the campaign and writes a latch for the corpus digest (`campaign/state/`), which refuses every new stage until reseal.
- **D4-CAMP-8** Run provenance (R2-039, IC-11, Codex B04-R3): `qualifyThreeRuns` refuses a run whose presented receipts are not whole,
  not of the report's run ids, not at the subject's rawPredict endpoint, not paired request to answer, or hold no successful exchange
  with a provider message id; empty id or served-model sets never pass. Re-check: every run id of the report needs its own paired
  successful exchange whose request parses (the build's payload guard) to that run id and the subject's bundle, policy and model, and
  no answer backs two runs; a run the core decided without the model is declared offline with its fixture in the bound record, carries
  no exchange, and the three runs must declare the same offline fixtures (about 3 % of the corpus sends nothing by design). Offline is
  proven, not declared: the record binds every run id to its fixture under its digest, and the qualification path
  (`tools/campaign/offline-replay.mjs`) replays each named sealed fixture through the core behind a send-refusing transport; only a
  zero-request decision is offline, and a declared offline fixture that would send, or a replay-offline one with exchanges, is refused.
- **D4-CAMP-9** Partitions and labels (S042, Codex B04-R7, R8): the pilot runs exactly the 60 sealed PILOT fixtures and qualification
  exactly the 600 FINAL ones (`tools/campaign/selection.mjs`); the smoke keeps its privacy-channel pick. A stage over the test seam's
  stand-in endpoint is SIMULATED in every artifact, and the live audits refuse any run not labelled EXECUTED_PROVIDER.
- **D4-CAMP-10** Plan rehearsal (development tool): `tools/campaign/plan-rehearsal.mjs` runs the pilot path with a seam
  (`plan-seam.mjs`) that sends each Vertex body through the owner's Claude subscription (`claude -p`: system prompt replaced whole,
  no tools, no MCP, no settings or CLAUDE.md, empty cwd, no session), so the pilot can be rehearsed on Sonnet 5.5 / Opus 5.5 before
  the paid Vertex API exists. It is SIMULATED by construction (the seam label of D4-CAMP-9; the live audits refuse it), under a
  rehearsal grant that is plainly no money, and never counts as qualification. It is PILOT-only so FINAL stays unexposed: any other
  partition or a non-PILOT fixture is refused before anything is sent. What the CLI cannot reproduce (max_tokens, the provider
  structured-output path, cache-token fields, stop_reason, region, the synthetic logging read-back) is listed in `fidelity.json`
  beside the run, never dropped silently. It is not a substitute for the funded Vertex runs: the S091 privacy read-back and the
  IC-13 wire receipts exist only on Vertex.

- **D4-CHAOS-1** (coordinator ruling on the chaos-rehearsal finding, 2026-10-06) A transient failure whose billing is unknown
  (503, 529, 408 after the body, a reset: no usage) keeps the reservation maximum on the grant ledger: money safety is unchanged.
  The scorer's `budget_ceiling` check reads the observed usage of the receipt (`billed* - ambiguous*` tokens, invocations minus
  ambiguous reservations) and reports the unknown-billing requests as `transportFailures`: such a request is a transport failure,
  never a ceiling violation and never the reservation maximum. Observed usage over the ceiling is still `budget_ceiling_exceeded`
  (the fixture is incorrect, an "other violation" of the report). `stage-child.mjs` stops a stage durably only on a member of
  `HARD_GATES` (one shared constant, exported by `kauro-intelligence-core/benchmark`), live and when a restart rebuilds a pending
  STOP from `scores.jsonl` (G50); the stop rule and the report now agree. Tests both ways in `test/b04-chaos.test.ts`,
  `test/b04-campaign.test.ts`, `test/benchmark.test.ts`; `docs/work/CHAOS_REHEARSAL.md`.

### 2.7 Release (D4-REL-*)

- **D4-REL-1** (amended 2026-10-06: 2.0.3 -> 3.0.0) Migration Core re-pin precedes sealing: IC re-pins to the published release
  `kauro-migration-core` 3.0.0 (tag v3.0.0, commit 3b4b0ae, release asset sha256 `2686ee65…5312`, `vendor/MANIFEST.json`; never packed
  from an MC tree) before the corpus is resealed (L2), and the configuration schema is 3.0.0 (D4-MC3-1). A later change of core
  invalidates the affected runs, and the validity record v4 names the core version and the sha256 of its tarball (§2.8 D4-VAL-4).
- **D4-REL-2** IC 0.6.0: selected profile pinned, qualification record (three reports, receipts digests, subject, cost actuals)
  under `docs/work/QUALIFICATION_0.6.0.md`, tag, tarball digest, consumer check over the tarball, flag
  `INTELLIGENCE_CORE_RELEASE_CANDIDATE` computed from evidence. Release only after the three runs pass; before that the release is
  `0.6.0-rc.1` with UNQUALIFIED policy (`MODEL_POLICY_QUALIFICATION`; `docs/COMPATIBILITY_MATRIX.md`, `docs/IC2_READINESS.md`).
- **D4-REL-2'** (PROPOSED to Codex in the B04 delta review, 2026-10-06; replaces D4-REL-2 if accepted) The qualification state leaves the
  package bytes: `MODEL_POLICY_QUALIFICATION` is no longer a constant of the package, so the tarball the three runs qualify is
  byte-for-byte the tarball that is released (no rebuild after qualification, no rc). Qualification is recorded outside the package,
  in `docs/work/QUALIFICATION_0.6.0.md` and a `release-record.json` that binds the tarball (its sha256 and its content digest, the
  `icPackageDigest` of validity v4), the qualification subject (`SUBJECT_FIELDS`) and the digests of the three run reports; the B05
  consumer checks that record before it treats the policy as qualified, so the released tarball is the qualified tarball. State in this
  tree: the decision text and the record's shape are written; the constant is still in `src/contracts/versions.ts` (UNQUALIFIED) and
  its removal is a source change made only once Codex accepts D4-REL-2' (it changes the package digest, so the validity record is then
  regenerated). Fallback if Codex rejects: the rc plan of D4-REL-2 unchanged (`0.6.0-rc.1` qualified, UNQUALIFIED in the rc bytes,
  0.6.0 released after the runs).

### 2.8 B04 integrate decisions (D4-HDR-1, D4-MC3-*, D4-BR-*, D4-CAMP-11, D4-VAL-4; 2026-10-06)

- **D4-HDR-1** A configuration names a column by Migration Core's `headerRaw` (the header as read, a BOM or zero-width space kept), and
  `toMigrationConfig` compares raw to raw (`COLUMN_LOCATOR_HEADER_MISMATCH`); the display header (`displayHeader`, the invisible
  characters dropped) stays in the facts sent to the model (`contract-adapter.ts`), in memory candidates and in the resolver's id-column
  rule. Test `test/b04-engine-mc3.test.ts` "B03-HDR-1 ..." (failed with `'Correo'` vs `'Corr\u200beo'` before the fix).
- **D4-MC3-1** Whitespace under configuration schema 3.0.0 is decided per primitive, never by a blanket default, from fixtures run both
  ways through MC 3.0.0 `loadConfig` + `runMigration` on `'  x  '` cells: TRIM_WHITESPACE `trim:true` (CHANGED_SAFE, WHITESPACE_TRIMMED);
  PRESERVE_AS_IS and no primitive `{}` (the padding is delivered); the typed parses `trim:true` - NORMALISE_EMAIL_CASE (off: INVALID
  EMAIL_INVALID_SYNTAX), NORMALISE_NUMBER (off: INVALID NUMBER_INVALID), NORMALISE_BOOLEAN (off: INVALID BOOLEAN_UNRECOGNIZED),
  PARSE_DATE_ISO DATE (off: INVALID DATE_INVALID_FOR_FMT), PARSE_DATE_ISO DATETIME (off: AMBIGUOUS NO_FORMAT_EVIDENCE), PARSE_PHONE_E164
  (neutral: the parse skips padding either way). Padding is not data in a typed parse and MC records the trim in its evidence. A
  whitespace-only cell is never emptied (MC rule). A DATETIME with a zone is refused UNSUPPORTED_BY_CORE (D68: no tzdata in a proposal).
- **D4-MC3-2** A blocking requirement is a draft that waits for the agency. When MC 3.0.0 refuses the validation only because a
  creating record mapping maps nothing to a field the contract requires (MAPPING_INVALID), and every such field is one the draft itself
  reports as a BLOCKING requirement, the run ends PROPOSAL_READY with validation DEFERRED_FOR_AGENCY_DECISION and no receipt; any
  other refusal stays FAILED_COMPILER. `src/api/delivery-gate.ts` refuses final delivery of a deferred, unvalidated, unreconciled or
  still-blocking draft. The scorer lets exactly that deferred draft carry no receipt (d38a00b); any other receipt-less SYSTEM_DRAFT is
  still out of contract.
- **D4-BR-1** Amazon Bedrock (A9) through a `us.` geography cross-region inference profile only (location US_MULTI_REGION), called from
  us-east-1 or us-west-2; never `global.`, `eu.`, `apac.` or a bare in-region model id.
- **D4-BR-2** Usage counts only when the body usage is confirmed by the `x-amzn-bedrock-{input,output}-token-count` headers; otherwise
  the usage is unknown and the reservation is held in full. Usage that stays on a failure is charged as billed.
- **D4-CAMP-11** The hard-gate stop stays at every stage (owner item 12): a violation makes that candidate ineligible (manual 06
  l.148), and only Sonnet 5.5 is B-funded (A9 §4), so the pilot measures Sonnet first (G51) and an Opus stop cannot block it. Every
  fixture score is fsync'd to `scores.jsonl` before the next dispatch and a restart rebuilds a pending STOP before any hold (G50). Which
  violations stop is D4-CHAOS-1 (§2.6): members of HARD_GATES only.
- **D4-VAL-4** Validity record v4 (mandate 4.5, S044). `VALIDITY_RECORD_VERSION='4'`; the record binds, beside the scorer and corpus
  digests, `icPackageDigest` (the content digest of the `npm pack` tarball of the tree: sha256 over the sorted `sha256  path` lines of
  every file it carries; the tarball's own sha256 also carries file modes, which differ for one tree between an NTFS checkout read
  through WSL and a native one - measured `2a4b31fb…` vs `5ab05c0e…`, content digest equal), `migrationCoreVersion` and
  `migrationCoreTarballSha256`, `promptBundleHash` and `modelPolicyHash` (`validityRecordProblems` refuses RECORD_FOR_ANOTHER_* for each).
  A funded stage reruns `tools/campaign/scorer-validity.mjs` inside its clean install (`preflight.mjs` `rerunValidity`, called by
  `run.mjs` after the install, once per stage): a release binding that differs refuses VALIDITY_STALE before any control runs, and a
  rerun record that differs from the committed one in any member refuses VALIDITY_STALE. A rehearsal over a stand-in seam is not funded
  and is not rerun. The record is generated last, after the version bump, the Bedrock code and D4-CHAOS-1. Tests: `test/b04-scorer-
  validity.test.ts` "S044 v4: ..." (one byte of `dist/src` changed refuses VALIDITY_STALE before any control runs; a record for
  another member of the binding is refused). That the committed record is the record of this very tree (binding and every control
  rerun in a clean install of the packed tarball) is checked by `npm run consumer:check`, not by the unit suite: a suite test that
  compared the tree's package digest with the committed record would fail for every mutation of `src/` and kill every sabotage for a
  reason none intends.

## 3. Retention: what can and cannot be promised

Can be promised, with evidence: request-response logging is OFF (Google: "disabled by default … per-model, per-project"; read back
through the API at preflight and before each stage); Kauro sends no prompt cache control, no batch, no tools, no files, no grounding;
Google's training restriction applies to all managed models; Sonnet 5.5 and Opus 5.5 are not Covered Models (Anthropic list of
2026-10-01: Fable 5/5.1, Mythos 5/5.1 only); routing stays in the US multi-region.
Cannot be promised: that no provider-side abuse-monitoring logging occurs. Google's zero-retention page describes prompt logging for
abuse monitoring for Google models (exception on request) and additional logging for "Advanced AI models"; it gives no read-back for
partner models, and Anthropic states data handling on Vertex "is governed by Google Cloud". The record says "no request-response
logging configured, no customer values sent (privacy layer)", never "zero retention". Sources: docs.cloud.google.com
`gemini-enterprise-agent-platform/resources/zero-data-retention`, platform.claude.com `claude-on-vertex-ai`,
support.claude.com Covered Models (all read 2026-10-01).

## 4. Threats

| id | threat | control |
| --- | --- | --- |
| T-B04-1 | SDK or library retries an ambiguous send | no SDK; adapter never retries (D4-TX-3) |
| T-B04-2 | recorded bytes differ from sent bytes | serialize once, record, send the same buffer (D4-WIRE-1) |
| T-B04-3 | silent global endpoint or other model | single URL builder, literal `us`, served-model check (D4-WIRE-3, D4-RCPT-2) |
| T-B04-4 | token or project id leaks into logs/receipts | token redacted by construction; receipts pass the B03 leak scanner |
| T-B04-5 | truth computed by the engine (circular oracle) | generator-planted truth, sealed before runs (D4-CORP-2) |
| T-B04-6 | corpus inflation by renaming | fingerprint distinctness (D4-CORP-3) |
| T-B04-7 | truth leaks into prompts | canaries scanned in every receipt (D4-CORP-4) |
| T-B04-8 | scorer accepts everything / rejects everything | positive controls + sabotage before spend (D4-SCORE-2) |
| T-B04-9 | copied or replayed runs presented as independent | receipt-set disjointness (D4-CAMP-3) |
| T-B04-10 | spend beyond the grant | per-request admission + run-level projection + stop rule (D4-CAMP-4) |
| T-B04-11 | subject drift mid-campaign | subject digest per report, served-model check per response (D4-CAMP-2) |
| T-B04-12 | cheaper model with unsafe retention wins on cost | eligibility before cost (D4-POL-3) |
| T-B04-13 | provider error echoes prompt into public channels | protected record only, digest public (D4-TX-4) |

## 5. What stays PARTIAL until live

Offline (before 2026-10-08) every B04 case reaches SIMULATED evidence through labelled fake or recorded transports (A4: nothing
simulated counts as live). EXECUTED_PROVIDER needs, per case, the live clause named in `B04-case-map.md`: the real Vertex bytes and
headers (IC-05, S036, S037, R2-027, R2-028), provider error shapes (R2-028), raw chunks from the live socket (S040), provider request
identity (S038, R2-032), acceptance or rejection of the body by Vertex (IC-13), the read-back of logging/retention (S091, R2-041), and
the funded smoke/pilot/three runs (IC-10, IC-11, S042, S043, S044, R2-039, R2-040, R2-042). The gate G-IC-QUALITY closes only with
the three real runs and Codex review of the release commit.

## 6. Open points

1. Vertex count-tokens for Anthropic models (`count-tokens:rawPredict`) and whether it is free: not verified; until then the byte
   upper bound stands (D3-GRANT-1) and the smoke measures `usage.input_tokens` against bytes.
2. Hidden prompt overhead of structured outputs (schema system text the provider adds): not documented as a number; a 500-token
   per-request allowance is reserved until the smoke measures it.
3. Whether `tools: []` is accepted on Vertex: verified in the smoke; if refused, omitting the member is the equivalent body (bundle
   version bump before any funded stage).
4. Default Vertex quota for Anthropic models in a new project may be zero; the owner requests the quota (see envelope §Owner).
5. Payment method: Cloud Billing needs a payment method or credits; the owner's "no bank/card" fact conflicts — owner decision.
