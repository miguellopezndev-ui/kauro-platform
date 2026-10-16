# kauro-intelligence-core

Kauro Intelligence Core. Intelligence interprets and proposes; Migration Core
executes and proves; the agency decides what is ambiguous or destructive.

**State.** `INTELLIGENCE_CORE_ARCHITECTURE_CLOSED` is computed by
`tools/architecture-gate.mjs` from eighteen executed or measured facts bound
to the subject commit (sha, tree, clean) and is never written by hand; the CI
run on `main` publishes the verdict as the `architecture-gate` artifact, the
sabotage qualification report as `sabotage-report`, and a receipt composed by
`tools/compose-receipt.mjs` as `ic1-receipt`.
`INTELLIGENCE_CORE_RELEASE_CANDIDATE` and `INTELLIGENCE_CORE_V1_FROZEN` are
FALSE by construction until IC-2 (real provider, benchmark corpus, budget
qualification) and IC-3 (independent freeze). IC-1 spends zero paid inference.

The verdicts of 2026-09-11 on `b6fcbaf` (14:52Z) and `9a9db22` (20:22Z) were
audited independently and found to admit false positives; the finding
families and their two correction rounds are in `docs/work/IC1_CORRECTION.md`.
Those verdicts are history, not authority. This core still pins Migration
Core 2.0.1, whose own reopening (MC-01..07) is upstream work; acceptance of
this core waits for the repaired dependency.

This repository consumes the frozen Migration Core release `v2.0.1`
(`miguellopezndev-ui/kauro-migration-core@a2a549031de85d95be8645dd9c5156dfff2050a0`,
package sha256 `787f0b80…f000`; its npm name and file are in `vendor/MANIFEST.json`) as a pinned peer
dependency installed from vendored bytes. The kernel never reads source data
from disk, never runs the engine itself, and never opens a network connection;
the host supplies contracts as DTOs, an `auditAttemptId` per logical attempt,
a compare-and-append ledger store and a full-dataset validation port whose
receipt is validated as a closed schema.

## Verify

```
npm ci --ignore-scripts
npm run gate          # build, typecheck, CONTRACTS-01, tests, INTELLIGENCE-CONSUMER-01, INTELLIGENCE-ARCHITECTURE-01 (executes sabotage)
node tools/sabotage.mjs                       # QUALIFICATION: the whole inventory, report bound to the subject
node tools/sabotage.mjs --only <id>           # DIAGNOSTIC: never qualifies; unknown or empty selection → exit 2
node tools/sabotage-selftest.mjs              # the runner refuses partial/empty/edited evidence
node tools/architecture-selftest.mjs          # the gate refuses stale/foreign/dirty evidence
node tools/chain-rehearsal.mjs --out <dir outside the tree>   # the whole chain to a receipt, REHEARSAL-labelled
node tools/architecture-gate.mjs --out <path outside the tree>
```

## Map

| where | what |
| --- | --- |
| `src/contracts/` | versions and compatibility, canonical JSON, closed schema validator, IntelligenceEnvelopeV1, IntelligenceProposalV1, run/budget/memory contracts |
| `src/adapter/` | Migration Core DTOs → refs and views (no vendor truth in CLEAN_ONLY) |
| `src/resolver/` | deterministic resolution: exact matches, object per file, identity proof, preservation |
| `src/planner/` | semantic tasks by complexity, cap 32, visible truncation |
| `src/classifier/`, `src/envelope/` | one classifier for values and every metadata channel; L0–L2; whole-column classification before selection; masked metadata; HMAC egress that re-reads the envelope |
| `src/gateway/` | ModelGateway, pinned policy and prompt bundle, self-contained provider request (`<request>` + `<data>`, `output_config`), byte-only offline transports, typed transport failures |
| `src/compiler/` | proposal → compiled decisions through the fixed gate sequence |
| `src/kernel/` | append-only run ledger, attempt identity, compare-and-append store contract, per-invocation reservations, usage validity, resume from the ledger |
| `src/memory/` | scoped memory: precedence, staleness, conflict, no model write path |
| `src/api/` | host boundary, validation receipt soundness, run orchestration |
| `src/benchmark/` | fixture format 1.1.0 (decisions, evidence, gate markers), scorer with recorded checks, three-run qualification |
| `docs/` | requirements map, threat model, compatibility matrix, IC-2 readiness, ADRs, authorities, correction record |
| `tools/` | test runner, CONTRACTS-01, sabotage (inventory under `sabotage-inventory/`), self-tests, behavioural probes, consumer check, architecture gate, receipt composer, chain rehearsal, evidence manifest |

Authorities and their digests: `docs/authorities/REGISTRY.md`. Ownership:
Kauro, private, `UNLICENSED`. No secret, credential or customer datum belongs in
this tree.
