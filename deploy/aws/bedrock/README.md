# Bedrock for Intelligence Core — prepared offline (Order 26A)

**Status: built and checked offline; switched off; nothing requested, created, called or billed.** There is no AWS account (A9 §5),
no model access was requested and no model was invoked. Order 26A prepares what Order 26's live campaign will need and proves it
without the provider; everything only the real account can establish is a probe below, `PENDING_PROVIDER`.

## What is here

| Path | What it is |
|---|---|
| [bedrock-contract.json](bedrock-contract.json) | The invocation contract: source Region, `us` geography and its destination Regions, the model per capability (Sonnet 5.5 granted; Opus 5.5 `BLOCKED_OWNER`), retention (invocation logging OFF, nothing stored), quotas, backoff, the owner's grants and the budget. `enabled: false` |
| [policies/bedrock-invoke.policy.json](policies/bedrock-invoke.policy.json) | The campaign runner's identity policy: `InvokeModel` on the granted `us.` Sonnet profile, and on that model in the US destination Regions only through the profile; Opus denied |
| [policies/scp-bedrock-guard.json](policies/scp-bedrock-guard.json) | The Workloads OU guard: nobody turns invocation logging on, nothing with a committed cost (provisioned throughput, customization), only the owner subscribes to a model, no other invocation path (streaming, Converse, batch, agents, flows), US Regions only, no Opus |
| [terraform/main.tf](terraform/main.tf) | The module: with `enabled = false` (default) or no `activation_reference` it creates nothing; on, it creates the invoke policy, the guard SCP and its attachment, and a Bedrock-only budget that notifies (≤ USD 160). It never declares an invocation logging configuration |
| [checks/bedrock-guards.mjs](checks/bedrock-guards.mjs) | The offline checks: the contract against A9 §4, the Terraform text, and 16 authority rows through Order 25's evaluator (`deploy/aws/checks/iam-eval.mjs`) in Order 25's synthetic organization |

Intelligence Core checks the same contract against what it does on the wire (`bedrockDeploymentProblems`,
`cores/kauro-intelligence-core/src/provider/bedrock-deployment.ts`): the admitted profile, the transport's waits (2 s, 8 s) and
retried statuses (429, 503, 529), the grants (B04-A USD 40, B04-B USD 120, Sonnet only); `bedrockActivation` answers OFF unless the
document is enabled, carries the owner's reference and has no problem; `quotaLimitedTransport` refuses, before a byte leaves, a send
the contract's quotas do not admit. The platform's verify runs the checks here (`packages/intelligence-core/test/bedrock-deployment.test.ts`,
ubuntu and windows); the core's own suite runs the contract against the wire, and joins the platform's verify when the core is
re-vendored (Order 18B).

```sh
node deploy/aws/bedrock/checks/bedrock-guards.mjs          # the rows and every problem, readable; exit 1 on any
pnpm --filter @kauro/intelligence-core run test            # the same, in the platform's verify
cd cores/kauro-intelligence-core && npm test               # the contract against the wire, activation, quota window
```

## Where the money stops

1. **The cap is Intelligence Core's campaign grant** (`src/provider/campaign-grant.ts`): a request is sent only if its worst-case
   charge fits what is left after the in-flight holds; an unknown usage holds its whole reservation; a stopped campaign admits nothing
   until a new owner approval. That is code, tested offline (`test/b04-campaign.test.ts`, `test/kernel-budget.test.ts`).
2. The Bedrock budget here notifies at 25/50/80/100 % of at most USD 160; Order 25's organization spend stop
   (`policies/organization/scp-spend-stop.json`) denies `bedrock:InvokeModel` when the monthly ceiling is reached. Billing data is
   hours late, so neither is the cap.

## Known dependency (Order 25's baseline SCP)

The baseline SCP allows one Region. A `us.` profile routes the call to us-east-2 or us-west-2, where `DenyOutsideTheAllowedRegion`
refuses it; the checker shows it (row "KNOWN DEPENDENCY") and shows that adding `bedrock:InvokeModel` to that statement's `NotAction`
allows the routed call while this order's guard still refuses every non-US Region. The patch is proposed in
`dispatch/sprint/REQUESTS.md`, to apply in a reviewed change before the first live call.

## Live probes (PENDING_PROVIDER, Order 26's campaign, after the owner's activation)

| Probe | What it establishes | How |
|---|---|---|
| P1 | The profile's destination Regions and the foundation model id behind `us.anthropic.claude-sonnet-5-5` | `GetInferenceProfile` |
| P2 | Whether the source Region is us-east-1 or us-west-2 (`BEDROCK_REGIONS`) | `ListInferenceProfiles` in each |
| P3 | Invocation logging is absent and cannot be set | `GetModelInvocationLoggingConfiguration` empty; `Put…` refused by the SCP |
| P4 | The account's quotas for the profile (requests and tokens per minute) | Service Quotas, before the smoke |
| P5 | Current prices against `SONNET_5_5_US`'s planning tariff, and the recomputed expected spend | AWS Price List, before any paid call (A9 §4) |

Model access (the marketplace subscription) is the owner's act in the console, after P1–P5 and on a grant's approval; nothing here
requests it.
