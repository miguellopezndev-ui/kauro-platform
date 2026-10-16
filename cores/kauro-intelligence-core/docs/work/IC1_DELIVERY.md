# IC-1 delivery

> Corrected on 2026-09-11 after the independent audit of `b6fcbaf` (seven finding
> families, all reproduced and repaired): see `docs/work/IC1_CORRECTION.md`. The
> figures below are those of the corrected tree.

Scope of IC-1 (roadmap, Intelligence canon §103): the architecture of the
Intelligence Core closed by evidence, on the frozen Migration Core `v2.0.1`,
with zero paid inference. Not in scope and FALSE by construction: release
candidate (IC-2) and V1 freeze (IC-3).

## What is delivered

| layer | delivered | proof |
| --- | --- | --- |
| contracts | versions and compatibility matrix; canonical JSON; closed schema validator; IntelligenceEnvelopeV1 1.0.0; IntelligenceProposalV1 1.0.0; run, budget, memory contracts | `schemas.test`, CONTRACTS-01 |
| adapter | Migration Core profile, candidate set and TargetContract → stable refs and views; CLEAN_ONLY without vendor truth; mode/contract mismatch refused | `compiler.test` |
| resolver | exact and object-aware resolution per file, identity proof from the profile, preservation of the unmapped, open questions typed by task | `integration.test`, `compiler.test` |
| planner | tasks by semantic complexity, stable ids, cap 32 with visible truncation | `security.test` |
| classifier + minimizer + egress | L0–L2 by shape and header, UNKNOWN fails closed, contaminated field emits nothing, HMAC egress bound to the envelope hash | `security.test` |
| gateway | `ModelGateway`; `MODEL_POLICY_V1` and `PROMPT_BUNDLE_V1` pinned with hashes; transport request/response shape with no tools; scripted, replay and oracle gateways for offline runs | `security.test` |
| compiler | schema → refs → contract → primitives → support envelope → authority → consistency; explicit outcomes; no destructive primitive by the model; identity never proven by the model | `compiler.test` |
| kernel | append-only ledger, transition table, atomic reservations, AMBIGUOUS_BILLED, cancellation, idempotency with stored result redelivery | `ledger.test`, `integration.test` |
| memory | scopes and precedence, states, staleness by revision, conflict → decision, deletion, no model write path | `memory.test` |
| host API | `createIntelligenceCore` over DTOs; `FullDatasetValidationPort` with soundness decided by the kernel; SYSTEM_DRAFT only from a sound validation | `integration.test` (three modes E2E), INTELLIGENCE-CONSUMER-01 |
| benchmark | fixture format, sealed expected truth, scorer with hard gates and its own failure | `benchmark.test` |
| gates | CONTRACTS-01, INTELLIGENCE-SABOTAGE-01 (70 mutations, qualification bound to the subject), INTELLIGENCE-CONSUMER-01, INTELLIGENCE-ARCHITECTURE-01 (18 facts), self-tests, chain rehearsal, receipt composer | `tools/` and `.github/workflows/ci.yml` |
| documents | requirements map, threat model, compatibility matrix, IC-2 readiness, 20 ADRs, authorities registry, correction record | `docs/` |

## Numbers at delivery

- 175 tests in 13 files, all passing on Node 24 (75 original, none removed or weakened).
- 70 sabotage mutations (25 core, 11 privacy, 11 transport, 11 kernel, 12 benchmark), all killed in a QUALIFICATION run bound to the subject; diagnostic runs never qualify.
- Consumer check: packed tarball + vendored Migration Core installed from bytes
  in a TypeScript strict project outside the tree; CLEAN_ONLY run ends
  `PROPOSAL_READY` / `SYSTEM_DRAFT`, 3 fields, 2 rows validated by the frozen
  engine, 1 model call.
- 25 source files under `src/`, no TODO, stub, provider SDK, network,
  filesystem or shell.
- Zero runtime dependencies; Migration Core is a peer pinned to 2.0.1. Package version 0.2.0.

## How the flag is decided

`tools/architecture-gate.mjs` executes build, CONTRACTS-01, the suite,
sabotage and the packed consumer, and measures the public entry of the built
module, the production path, the eight budget bounds and the model policy on
the built objects, five behavioural probes, the binding of the sabotage report
and the consumer evidence to the subject commit, and the documents.
`INTELLIGENCE_CORE_ARCHITECTURE_CLOSED` is TRUE only when all eighteen facts are; the CI `architecture closure` job publishes the verdict as an
artifact and the `gate receipt` job on `main` binds it to the commit and run
id. The verdict for the delivered commit lives with the owner's recovery
record outside this tree, together with the run ids.

## Exceptions and decisions carried

- Migration Core `v2.0.1` instead of `v2.0.0`, by the owner's express
  exception to the canon and the Migration Core roadmap (contract versions
  whose content did not change were preserved: package format 2.0.0, config
  schema 2.0.0).
- No secret of any kind was created for IC-1; no provider was called; the only
  network use was GitHub for the repository itself.
- The oracle gateway resolves candidates by canonical field tail: it exercises
  the whole pipeline offline and is marked as control-flow-only; it is not a
  stand-in for a model's judgement.

## Open for IC-2

See `docs/IC2_READINESS.md`: provider adapter and its evidence, the 600-fixture
corpus and OPUS-Q1, AI-BUDGET-01, sabotage extension to the adapter, measured
classifier recall.
