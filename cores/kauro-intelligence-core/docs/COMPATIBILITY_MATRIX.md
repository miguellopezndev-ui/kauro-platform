# Compatibility matrix

Every version is declared on its own line in `src/contracts/versions.ts` and
exported through `compatibilityMatrix()`. A combination that is not in this
table fails closed with `INCOMPATIBLE_CONTRACT_VERSION`; nothing negotiates.
`tools/contracts-check.mjs` (CONTRACTS-01) refuses a tree whose declared ranges
do not contain what the vendored Migration Core actually exports.

## Intelligence Core 0.6.0

The release candidate of package B04 (D4-REL-2): the live provider path exists and is exercised offline, the pinned policy is **UNQUALIFIED**, and `INTELLIGENCE_CORE_RELEASE_CANDIDATE` stays FALSE (`docs/IC2_READINESS.md`). Every contract below the table is unchanged from 0.5.0; only the rows here move. Nothing in this release is qualification evidence: the three funded runs have not happened, and 0.6.0 is the release that follows them.

**Amendment (Order 18B, 2026-10-22): Migration Core 3.0.0 -> 3.1.0.** 0.6.0 accepts Migration Core 3.1.0 (N1-1, D78: the person signals read a Lead as a Contact; import instructions; the `contribution_kind` vocabulary) and no longer 3.0.0. The configuration schema (3.0.0), package format (2.1.0) and every other contract row are unchanged; no source change in the adapters, compiler or effects was needed (`cores/kauro-migration-core/docs/work/N1-1_COMPATIBILITY.md`, run 3). The corpus was resealed and the validity record regenerated on the 3.1.0 tarball; both are bindings of the release, not new evidence about a model.

| contract | version | where | changes |
| --- | --- | --- | --- |
| INTELLIGENCE_CORE_VERSION | 0.6.0 | package.json, package-lock.json, versions.ts | B04 (D4-REL-1, Migration Core amended 2.0.3 -> 3.0.0): Migration Core 3.0.0 (configuration schema 3.0.0: whitespace is trimmed only where a primitive decides it, D4-MC3-1; a DATETIME zone is refused, D68); a configuration names its column by Migration Core's `headerRaw` while the facts carry the display header (D4-HDR-1); transport retries wait 2 s then 8 s plus a digest jitter, only for 429/503/529, and a 429 of the provider's documented throttling class without usage is released (S8, S11). Earlier in B04 (0.6.0-rc.1): Vertex wire, transport and receipts, candidate profiles and the pinned policy, the sealed 660-fixture corpus, the scorer and its validity record, qualification (subject, independence, campaign grant), the campaign runner. No change to the envelope, proposal, ledger, configuration or receipt contracts |
| model policy | 2.0.0 | `MODEL_POLICY_V1` (Sonnet 5.5, `SONNET_5_5_US`, Amazon Bedrock `us.` profile, owner decision A9, D4-BR-1) | 2.0.0: the pinned platform is AWS_BEDROCK_MANAGED_MODEL (was Vertex in 1.1.0); a Vertex profile is refused PROVIDER_RETIRED_A9. The pinned policy is **UNQUALIFIED** (`MODEL_POLICY_QUALIFICATION`, `compatibilityMatrix().modelPolicyQualification`) until three funded runs pass on the release subject. It changes only by the release that follows the pilot's selection. The Opus 5.5 candidate policy (`candidatePolicyOf(OPUS_5_5_US)`) is shipped for the pilot's comparison only: a core runs under it only when the host names it (`CoreDependencies.candidatePolicy`), and any other policy is refused at construction |
| package entry points | `.`, `./benchmark` | package.json `exports` | `kauro-intelligence-core/benchmark` (`src/benchmark/campaign-surface.ts`) carries what a campaign needs beyond the public index: the sealed-corpus check, the truth-following stand-ins, the scorer, report and qualification, the campaign grant and admission, the Vertex gateway and receipts, the candidate profiles and the pilot selection. No path into `dist` is importable (`ERR_PACKAGE_PATH_NOT_EXPORTED`); `tools/consumer-check.mjs` and `tools/architecture-gate.mjs` check both entry points from the packed tarball and the built tree |
| Bedrock wire | `bedrock-2023-05-31` | `src/provider/bedrock-wire.ts`, `bedrock-sigv4.ts`, `bedrock-transport.ts`, `bedrock-gateway.ts` | InvokeModel body (closed members, `tools: []`), `https://bedrock-runtime.<us-east-1\|us-west-2>.amazonaws.com/model/<us. profile>/invoke`, in-house SigV4 over temporary credentials, usage confirmed by the `x-amzn-bedrock-*-token-count` headers (D4-BR-1, D4-BR-2) |
| Vertex wire | `vertex-2023-10-16` | `src/provider/vertex-wire.ts` | retired (A9): stays in the tree, not admitted by the policy and not accepted by qualification |
| scorer-validity record | 4 | `src/benchmark/validity.ts`, `corpus/scorer-validity.json` | v4 binds the package content digest, Migration Core version and tarball sha256, prompt bundle hash and model policy hash beside the scorer and corpus digests; a funded stage reruns it in its clean install and refuses VALIDITY_STALE on any difference (B04-design D4-VAL-4) |
| benchmark format / qualification subject | 1.1.0 / 9 fields | `src/benchmark/*` | `SUBJECT_FIELDS` (served model, location, policy hash, prompt bundle hash, compiler contract, Migration Core, package digest, scorer digest, corpus digest); the sealed corpus digest and scorer digest are bound to every report |

## Intelligence Core 0.5.0 contracts (unchanged in 0.6.0 except the rows above)

The closed design of package B03 moves these contracts together, once (D3-VER-1; `docs/design/B03-closure-plan.md`). The old rows stay readable below.

| contract | version | where | changes |
| --- | --- | --- | --- |
| INTELLIGENCE_CORE_VERSION | 0.5.0 | package.json, package-lock.json, versions.ts | 0.5.0: the twelve capability families run the whole chain (resolver question, task, envelope permissions, compiler facts and refusals, assembled fragment, `toMigrationConfig`, the real Migration Core, the effect in the receipt, the draft and the accounting); every expected candidate has one disposition (D3-ACC-1, D3-ACC-2); a money admission precedes every dispatch (D3-GRANT-1); the public result is a projection (D3-PRIV-1). Migration Core stays the vendored 2.0.1 release. Record: `docs/work/RELEASE_0.5.0.md` |
| IntelligenceEnvelopeV1 | 2.0.0 | `src/contracts/envelope.ts` | object refs and facts (`objectTargets`, `objectFacts`), association options (`associationTargets`: refs and closed codes), review claims (`reviewClaims`), parameter domains (`allowedParamValues`), and the derived candidate types of the new families (transformation, value, requirement, identity, duplicate signal, association, consistency review); a value candidate carries its L1 value only as an exemplar |
| IntelligenceProposalV1 | 2.0.0 | `src/contracts/proposal.ts` | `PARSE_DATE_ISO` names a `dateFormat` from Migration Core's own list (`dayFirst` removed: it named no separator); `MAP_ENUM_VALUE` names `to` only (`from` is the host's categorical summary, never a text the model writes) |
| prompt bundle | 1.3.0 | `PROMPT_BUNDLE_V1` | 1.2.0: the twelve task definitions state what each family answers, from which candidates and with which closed parameters; the repair definition keeps the original task's permissions. 1.1.1 is the previous row |
| model policy | 1.1.0 | `MODEL_POLICY_V1` | B04: pinned model comes from a CandidateProfile (src/gateway/candidates.ts) |
| memory contract | 1.0.0 | `src/memory/memory-resolver.ts` | unchanged |
| compiler contract | 2.0.0 | `src/compiler/compiler.ts`, `consistency.ts`, `plan-compiler.ts` | claims by output scope (one destination of one record mapping), per-family facts and refusals (object, semantic type, transformation parameters, value maps, identity proof, duplicate signal, association endpoints, requirements), a candidate a proposal does not answer is `INVALID_SEMANTICS CANDIDATE_NOT_ANSWERED`, the consistency review, and the assembled fragments named by decision and hash |
| benchmark format | 1.1.0 | `src/benchmark/fixture.ts`, `report.ts`, `harness.ts` | unchanged |
| run ledger | 2.0.0 | `src/kernel/ledger.ts` | `PREPARED` before the send (the recovery of D3-JRN-1), `ADMISSION` and settlement facts (D3-GRANT-1), the tariff bound on `RUN_CREATED` (D3-ID-1), the absolute window (D3-TIME-1), and the public projection of the log: a stored answer by digest, size, usage and stop reason, a prepared request by its digests (D3-PRIV-1); a planned task a stop by the grant never started ends `BUDGET_EXHAUSTED` on the record |
| CandidateConfiguration | 2.0.0 | `src/ports/ports.ts` | records per file (object, declared record id column, authoritative external id columns, identity space), fields (destination, semantic type, required, `onInvalid`, typed options including `valueMap` and `allowedValues`), associations, preserved and excluded columns; every fragment names its decision ref and fragment hash (D3-CFG-1) |
| validation receipt | 2.0.0 | `src/ports/ports.ts`, `src/adapter/migration-effects.ts` | `coreConfigHash` required when `ok` or `packageVerified` and equal to Migration Core's loader hash of the produced document; a closed, payload-free `effects` block computed by `effectsFromMigrationRun` from Migration Core's own run truth (D3-CFG-3) |
| masking policy / data policy | 1.4.0 / 1.7.0 | `src/envelope/envelope-builder.ts`, `src/classifier/data-classifier.ts` | unchanged (privacy repair of B03); the new channels carry refs, counts and classified L1 values only |

### History: Intelligence Core 0.4.0 (superseded by 0.5.0)


| contract | version | where | changes |
| --- | --- | --- | --- |
| INTELLIGENCE_CORE_VERSION | 0.4.0 | package.json, package-lock.json, versions.ts | 0.4.0 (amendment A2): the package is `kauro-intelligence-core`; no shape or behaviour change beyond prompt bundle 1.1.1; Migration Core stays 2.0.1 until its renamed release is published (`docs/work/RELEASE_0.4.0.md`). Earlier: the privacy repair of B03 kept the package at 0.3.0: the retained candidate's 0.4.x/0.5.0 were never released; the behaviour moved with data policy 1.7.0 and masking policy 1.4.0, both bound into the run identity and the provenance. History: 0.5.0 (WO-IC-PRIVACY-20260915-01, the consolidation of 009/009b): no shape change — data policy 1.6.0 stops the LABEL and IDENTIFIER channels admitting a token by its case or by the shape of a join; 0.4.1 (revision 009b, after the independent review of 0.4.0): no shape change — data policy 1.5.1 closes the camel-hump and length bypasses of the compact rule; 0.4.0 (revision 009, R-IC-PRIVACY): `BuildEnvelopeInput.tenant` is required (opaque references are scoped), `IntelligenceResult.provenance` carries `dataPolicyVersion` and `maskingPolicyVersion`, the run identity binds both; 0.2.0: host DTOs (`HostContext.auditAttemptId`, `LedgerStore.append(…, expectedLength)`, validation receipt fields, `resourceEvidence` counters, provider request shape); 0.3.0: fenced and renewed lease (`CoreDependencies.ticker`, `LEDGER_FENCED`), `ProjectRevision.recordIdColumns`, `ConfigFragmentField.allowedValues`, `BenchmarkReport.reportDigest`, identity binds resource profile and summaries; round 4b (additive, same version): `DraftMigrationPlan.evidence[]` entries carry `origin` (`DETERMINISTIC` / `PROPOSED`, exported type `DraftEvidence`) |
| IntelligenceEnvelopeV1 | 1.0.0 | `src/contracts/envelope.ts` | unchanged shape; metadata channels may carry masked tokens |
| IntelligenceProposalV1 | 1.0.0 | `src/contracts/proposal.ts` | unchanged |
| prompt bundle | 1.1.1 | `PROMPT_BUNDLE_V1` | 1.1.1: the role sentence names Kauro Intelligence Core (amendment A2), nothing else changed. 1.1.0: the bundle carries the whole request template (system sentences, <request> block, closing instruction, output_config, max_tokens); no temperature, no metadata on the wire |
| model policy | 1.0.0 | `MODEL_POLICY_V1` | unchanged |
| memory contract | 1.0.0 | `src/memory/memory-resolver.ts` | unchanged |
| compiler contract | 1.0.0 | `src/compiler/compiler.ts` | `CompiledItem.evidenceRefs` added (additive) |
| benchmark format | 1.1.0 | `src/benchmark/fixture.ts`, `report.ts`, `harness.ts` | expected decisions, input-hash binding, observed hard gates, three-run qualification |
| run ledger | 1.2.0 | `src/kernel/ledger.ts` | attempt identity, compare-and-append store, per-invocation reservations, `usageKnown`, semantic request key (budget excluded), lease owned per invocation with `ownerId`, renewed during provider and validation calls, every write fenced (`LEDGER_FENCED`), ceiling check after every commit, identity binds resource profile and categorical summaries; round 4b (event order, no shape change): `RESULT` precedes the closing `STATE`, `RESPONSE_STORED` precedes `COMMITTED`, a `RESULT` under an open state or a `CANCELLED` without its `STATE` is closed by the next delivery |
| masking policy / data policy | 1.4.0 / 1.7.0 | `src/envelope/envelope-builder.ts`, `src/classifier/data-classifier.ts` | 1.7.0 / 1.4.0 (privacy repair of B03): no identifier piece admitted by its case, only by the vocabulary or a lower-case concatenation of vocabulary words; joined and suffixed names are personal values, not UNKNOWN; a value its target lists as a person is one; the attempt is in the reference key. 1.6.0 (WO-IC-PRIVACY-20260915-01): on LABEL and IDENTIFIER no shape admits a token on its own — not an acronym of two to six capitals (SMITH, LEE), not a snake/kebab/dotted/camel/Pascal join (OkonkwoNdebele, Okonkwo_Ndebele), not the vendor suffix (Okonkwo__c, on OPTION too), not the identifier grammar (Okonkwo); a piece is known by the closed lists, as a lower-case word on IDENTIFIER only, or as a word in capitals inside a compound constant; a title-case piece outside every vocabulary is POTENTIAL_PII, a bare word in capitals outside every list is UNKNOWN; an ordinal (2nd) is a code; opaque references (`hdr_…`) are structural on the label channels; mundane acronym, type and grammar words added to the label vocabulary. 1.5.1 (revision 009b): a hump of one letter inside a camel run is not a symbol (`nG1`, `wU99`, `yN1` are handles); the compact token has no length cap and the handle rule precedes the metadata length rule (a 97-character handle is POTENTIAL_PII on every channel, never FREE_TEXT). 1.5.0: a digit-bearing token is a code only when every letter run is known (single Latin letter, closed compact prefix, vocabulary word) and a handle otherwise — POTENTIAL_PII on OPTION, LABEL, IDENTIFIER and `classifyValue`, never UNKNOWN by omission; capitals, digit dominance, two-to-three-capital prefixes and attested option lists authorise nothing; a bare ISO code with digits after it is not a code. 1.3.0: mask tokens are keyed by the egress secret bound to agency, client, project revision (id and hash) and profile hash; equal text in equal scope shares a token, any change separates it. Earlier: metadata classified and masked with keyed tokens; whole-column classification before selection; options never widen what may travel; egress re-reads exemplar values |

## Migration Core accepted by this version

| Migration Core contract | accepted | vendored (read from the package) |
| --- | --- | --- |
| CORE_VERSION | 3.1.0 | 3.1.0 |
| PACKAGE_FORMAT_VERSION | 2.1.0 | 2.1.0 |
| CONFIG_SCHEMA_VERSION | 3.0.0 | 3.0.0 |
| SOURCE_PROFILE_VERSION | 1.0.0 | 1.0.0 |
| CANDIDATE_SET_VERSION | 1.0.0 | 1.0.0 |
| TARGET_CONTRACT_VERSION | 1.0.0 | 1.0.0 |
| IDENTITY_RULE_VERSION | 1.0.0 | 1.0.0 |

The vendored release: Migration Core 3.1.0, the internal release of the Kauro monorepo (Order 18B; no public registry),
tag `migration-core-v3.1.0`, packed from `cores/kauro-migration-core` with `tools/pack.mjs`, package file as named in
`vendor/MANIFEST.json`, sha256
`22fe91ae66f30289839188ca16f0b99a5eb850950ad94b559ad42fc28daee5ea`
(`vendor/MANIFEST.json`). It is declared as a **peer dependency** pinned to
`3.1.0`: the host supplies the same release it runs its own engine with, and
the consumer check installs both tarballs from bytes to prove the pair works
with no registry. Migration Core 3.0.0 (`3b4b0aea4f1879ffb4189a55a16f22f4520787d4`,
tag `v3.0.0`, release 404110602, sha256 `2686ee65…`) was the release accepted until this amendment. A validation receipt whose `coreVersion` is outside the
accepted set blocks the draft (`VALIDATION_CORE_VERSION_UNSUPPORTED`).

## Rules

- A new Intelligence Core version that changes the envelope or proposal shape
  bumps that contract's version and this matrix; the old row stays readable.
  The versions of a closure move once, in its integration (D3-VER-1): no
  mandate of a package edits `src/contracts/versions.ts` or this file.
- A new Migration Core release is accepted by adding its versions here, running
  CONTRACTS-01, and re-vendoring; never by widening a range to `^`.
- Runtime: the host passes the `sourceProfile`, `candidateSet` and
  `targetContract` objects the Migration Core produced; the adapter checks their
  declared versions against the accepted set before anything else reads them.
- A run's identity binds the versions above (core, envelope, proposal, prompt
  bundle and model policy with their hashes, since 0.4.0 the data policy
  and the masking policy, and since 0.5.0 the tariff, D3-ID-1): the same `auditAttemptId` redelivered against other
  versions is `IDENTITY_CONFLICT`, never a silent re-run. The result's
  `provenance` names the same two policy versions.
- Evidence invalidation (revision 009): every classification or masking
  observation recorded under data policy ≤ 1.4.0 or masking policy ≤ 1.2.0 —
  the round-4 privacy probes and the 13 September audit records among them —
  describes another contract and is history, not evidence for 0.4.0.
- Evidence invalidation (revision 009b): every classification observation
  recorded under data policy 1.5.0 — the independent review's
  `camel-transport` and `length-transport` runs on 0.4.0 among them —
  describes another contract and is history, not evidence for 0.4.1.
- Evidence invalidation (WO-IC-PRIVACY-20260915-01): every LABEL, IDENTIFIER or
  OPTION classification observation recorded under data policy ≤ 1.5.1 — the
  009/009b replays and the sealed-check stand-ins on c8a5b1c among them —
  describes another contract and is history, not evidence for 0.5.0. Value
  classification (`classifyValue`) and masking (1.3.0) did not change; their
  1.5.1 observations still describe the same rules but were re-run here.
- Evidence invalidation (privacy repair of B03): every classification or
  masking observation recorded under data policy ≤ 1.6.0 or masking policy
  ≤ 1.3.0 — the retained candidate d7b3d28 and its sealed-check replays among
  them — describes another contract and is history. Current evidence:
  `docs/work/PRIVACY_REPAIR_RECORD.md`.
- Evidence invalidation (closure of B03): every verification recorded on
  `v0.4.0` — its `verify.log`, its 175-mutation sabotage run, its consumer
  check and the review `ic-b03-d25a9074bef9` it was rejected by — describes
  another contract and is history, not evidence for 0.5.0. Current evidence:
  `docs/work/RELEASE_0.5.0.md`.
