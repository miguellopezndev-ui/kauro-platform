# Intelligence Core and Bedrock — preparation without payment (Order 26A)

**Result: prepared and verified offline; Bedrock stays off.** No paid call, no model request, no model access requested, no AWS
account used (A9 §4–§5). What Order 26's live campaign needs is built and checked against fakes and Order 25's offline evaluator;
what only the account can show is a named probe (`deploy/aws/bedrock/README.md`, P1–P5), `PENDING_PROVIDER`.

Base: `main` 50f67c1e (Order 25 merged). Intelligence Core 0.6.0 stays on Migration Core 3.0.0, as on main: by the dispatcher's
decision of 21:55 nothing here depends on the 3.1.0 release (Order 18B, held until Order 18A's open campaigns are accepted).

## What Order 26A added

| Piece | Where |
|---|---|
| The Bedrock invocation contract (Region, `us` geography and destinations, model per capability, retention, quotas, backoff, grants, budget), `enabled: false` | `deploy/aws/bedrock/bedrock-contract.json` |
| The campaign runner's invoke policy and the Workloads OU guard SCP | `deploy/aws/bedrock/policies/` |
| The Terraform module (creates nothing unless enabled with an owner activation reference) | `deploy/aws/bedrock/terraform/main.tf` |
| The offline checks: contract, Terraform text, 16 authority rows over Order 25's evaluator | `deploy/aws/bedrock/checks/bedrock-guards.mjs` |
| `bedrockDeploymentProblems`: the contract against what the core does on the wire; the transport's waits now read from the same constant | `cores/kauro-intelligence-core/src/provider/bedrock-deployment.ts`, `src/api/intelligence-core.ts` |
| `bedrockActivation`: the OFF flag — on only when enabled, with the owner's reference, and problem-free | same file |
| `quotaLimitedTransport`: concurrency, requests and worst-case tokens per minute, refused at BEFORE_SEND (`QUOTA_WINDOW`) so the reservation is released and nothing is queued or sent | same file |
| Tests: 26 contract cases (one valid document, 22 refusals, enabled with a reference, non-records) and 10 activation and quota cases, one of them over the Bedrock transport and a SIMULATED recording; the platform test of the offline checks | `cores/kauro-intelligence-core/test/o26a-bedrock-deployment.test.ts`, `test/o26a-bedrock-quota.test.ts`, `packages/intelligence-core/test/bedrock-deployment.test.ts` |

## Criteria and evidence

| Criterion (O26A) | Evidence |
|---|---|
| Fakes, no paid call | Every provider path in the suite runs on the scripted transports (`src/gateway/fake-gateway.ts`, the chaos and campaign fakes); the validity record is `SIMULATED` (660 fixtures, no network); nothing in Order 26A opens a socket |
| Bounded backoff | `test/b04-retry.test.ts` (S8: 2 s then 8 s plus jitter, Retry-After up to 60 s, never past the deadline; only 429/503/529; six released 429s stop the run) and `test/kernel-budget.test.ts` (never beyond two retries); the deployment contract must state exactly those waits and statuses (`bedrockDeploymentProblems`) |
| Isolation | Egress masking keyed by agency, client, project revision and profile (`test/privacy-egress-acceptance.test.ts`, `privacy-envelope.test.ts`); the run ledger binds the tenant and fences every write (`test/kernel-identity.test.ts`, `ledger.test.ts`); in the account, only the campaign runner's role may invoke, the control plane may not (authority row) |
| Corpus reproducibility | The sealed 660-fixture corpus and the validity record are re-derived from bytes (`test/b04-corpus*.test.ts`, `tools/campaign/scorer-validity.mjs --check`, `consumer:check` in a clean install); resealed on Migration Core 3.1.0 by Order 18B |
| Hard budget block | `src/provider/campaign-grant.ts` (a request is sent only if its worst case fits what is left; an unknown usage holds its whole reservation; a stopped campaign admits nothing) — `test/b04-campaign.test.ts`, `test/kernel-budget.test.ts`; grants pinned B04-A USD 40 / B04-B USD 120, Sonnet only, Opus refused (contract check and the SCP); the AWS budget ≤ USD 160 is visibility, never the cap |
| Adversarial injection | The `ADVERSARIAL` and `SAFETY` families of the sealed corpus (110 fixtures each, all correct in the validity record), canaries checked at egress (`test/b04-chaos.test.ts`, `test/b04-scorer-semantics.test.ts`) |
| Tests in CI | `packages/intelligence-core/test/bedrock-deployment.test.ts` (the offline checks and the OFF state) runs in `pnpm run verify` on ubuntu and windows; the core's cases run in its own suite (`npm test`), outside the platform's verify until the core is re-vendored |
| Logging off / no retention | Contract `retention.invocationLogging: OFF`; the guard SCP denies `PutModelInvocationLoggingConfiguration` to everyone (authority row); the module declares no logging configuration (static check); the provider's own behaviour is probe P3 |
| Models per capability, quotas | Contract `models` (Sonnet granted for `IC_ANALYSIS`, Opus `BLOCKED_OWNER`) and `quotas` (one in flight, ≤ 60 requests/min), enforced before a send by `quotaLimitedTransport` (`test/o26a-bedrock-quota.test.ts`); the account's quotas are probe P4 |

## Results

Run on Windows 11, Node 24.20.0, 2026-10-22, on this branch:

| Command | Result |
|---|---|
| `node deploy/aws/bedrock/checks/bedrock-guards.mjs` | PASS: 16 of 16 authority rows as expected, contract and Terraform problems: none |
| `node --test tools/test/aws-infrastructure.test.mjs` (Order 25, with the Bedrock files present) | 28 of 28 |
| `pnpm --filter @kauro/intelligence-core run test` | 6 of 6 (the 4 existing and the 2 Bedrock tests) |
| `node --test dist/test/o26a-bedrock-deployment.test.js dist/test/o26a-bedrock-quota.test.js` (core) | 38 of 38 |
| `node tools/contracts-check.mjs`, `npm run design:check` (core) | CONTRACTS-01 PASS, 11 of 11 |
| `node tools/campaign/scorer-validity.mjs` then `--check` (core) | record regenerated for the core's new package content, Migration Core 3.0.0 unchanged; valid |
| `npm run gate` (core: build, typecheck, contracts, design, the whole suite, consumer check, architecture) | see `dispatch/sprint/O26A-READY.json` |

## Not established here

- Anything the real account decides: the profile's destination Regions and model id (P1), the source Region (P2), that invocation
  logging is absent (P3), quotas (P4), current prices (P5). A simulation of IAM is not AWS's evaluation.
- Order 25's baseline SCP allows one Region; a `us.` profile needs `bedrock:InvokeModel` exempted from that statement (proposed in
  `dispatch/sprint/REQUESTS.md`; the checker proves both sides offline). Owner-reviewed, before the first live call.
- Model access, grants and every paid call remain the owner's acts (A9 §4).
- **PARTIAL, unlocked by Order 18B:** the vendored Intelligence Core (`vendor/kauro-intelligence-core-0.6.0.tgz`) predates these
  exports, so the platform's verify cannot yet run `bedrockDeploymentProblems` against `deploy/aws/bedrock/bedrock-contract.json`.
  Re-packing and re-vendoring the core is Order 18B's step, together with the core's recalibration on Migration Core 3.1.0 (corpus
  reseal and validity record on the 3.1.0 tarball, `SUPPORTED_MIGRATION_CORE`), which waits for Order 18A's capacity and sabotage
  acceptance. Nothing in Order 26A needs 3.1.0.
