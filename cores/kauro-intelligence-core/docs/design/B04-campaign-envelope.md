# B04 — campaign envelope, cost and owner sheet

Figures for the owner's 2026-10-07 "ready to connect" sheet. Measured 2026-10-01 on `ic/b03-integration` `7188a0c`; §3, §5 and §6 recomputed 2026-10-01 on `ic/b04-stage-3` for a pilot of BOTH admitted candidates over the sealed 660 corpus.

## 1. Method

1. Built the tree and ran nine B03 suites (b03-closure, b03-cap-structure, b03-cap-values, b03-cap-identity, b03-cap-review,
   b03-accounting, integration, privacy-gate-cases, compiler-correction3) with a measurement hook in the compiled
   `transportGateway` (scratch only, not committed). For every request it serialized the actual Vertex body — the B03
   `ProviderRequest` without `model`, plus `anthropic_version` — and recorded its UTF-8 byte length, task type, repair flag and run.
   365 requests, 64 runs, all twelve families, three modes.
2. Tokens. No tokenizer for Claude 5.5 runs offline and no paid or credentialed call was made. Two figures:
   - **upper bound** = body bytes + 500 tokens per request. Every token of a byte-level tokenizer covers at least one byte, so bytes
     bound the visible text; the 500 is an allowance for the provider's hidden structured-output and framing text (not documented as
     a number — open point 2 of the design). This bounds admission (D3-GRANT-1).
   - **planning estimate** = bytes / 3.0 + 500 per request. JSON with hex digests and opaque refs tokenizes densely; 3 bytes/token is
     an assumption, replaced by the smoke's measured `usage.input_tokens` / bytes before any pilot spend.
3. Output. Visible answers of the oracle average 1,230 bytes (max 3,557) ≈ 400 tokens. Adaptive thinking is on and billed as output;
   planning assumes **1,500 output tokens per request** (≈ 400 visible + 1,100 thinking at effort high), unmeasured; the ceiling is
   `max_tokens` 8,192.

## 2. Measured envelopes (Vertex body bytes per request)

| task type | n | median | p95 | max |
| --- | --- | --- | --- | --- |
| OBJECT_MAPPING | 9 | 10,155 | 13,644 | 13,644 |
| FIELD_MAPPING | 183 | 12,080 | 15,557 | 19,085 |
| SEMANTIC_TYPE | 8 | 8,885 | 9,804 | 9,805 |
| TRANSFORMATION_SELECTION | 8 | 9,015 | 9,923 | 9,936 |
| VALUE_MAP | 5 | 14,324 | 14,324 | 14,324 |
| IDENTITY_STRATEGY | 8 | 14,491 | 16,443 | 16,443 |
| DUPLICATE_SIGNAL_STRATEGY | 15 | 10,436 | 10,801 | 10,801 |
| ASSOCIATION_MAPPING | 10 | 9,210 | 10,377 | 10,378 |
| UNMAPPED_HANDLING | 54 | 9,426 | 10,600 | 11,137 |
| TARGET_REQUIREMENT | 4 | 13,738 | 13,740 | 13,743 |
| CONSISTENCY_REVIEW | 9 | 10,861 | 11,324 | 11,324 |
| SEMANTIC_REPAIR | 52 | 16,015 | 17,094 | 19,450 |

Fixed part of every request: output schema 3,342 bytes, system text 1,493–1,716 bytes. Mean request 12,095 bytes. Repairs are 14.2 %
of requests. Per run: median 3 requests / 27,742 bytes, p75 3 / 36,486, p90 6 / 70,890; the full twelve-family audit is 33 requests /
391,140 bytes.

## 3. Envelope per fixture family (one fixture = one public `run()`)

| family | fixtures | requests/fixture | bytes/fixture | basis |
| --- | --- | --- | --- | --- |
| SUPPORTED | 200 | 6 | 70,890 | p90 run (supported fixtures exercise the chain) |
| AMBIGUOUS_ABSTENTION | 100 | 3 | 36,486 | p75 run |
| SAFETY | 100 | 3 | 36,486 | p75 run |
| ADVERSARIAL | 100 | 3 | 36,486 | p75 run |
| UGLY_MULTILINGUAL_STALE | 100 | 6 | 70,890 | p90 run (wide, multilingual) |
| repairs | +14.2 % of requests | | 16,015 each | measured share and median |

Superseded by the exact reservation. The corpus is now sealed (660 fixtures, digest `7f3ca077…0346a0618`) and `tools/campaign/envelope.mjs`
sums the first-attempt bytes of every fixture exactly (simulated truth-following transport, no network): **940 requests (134 of them
repairs, at the 14.2 % planning share), 10.68 MB of request bytes, 1.42 requests per fixture**, against 3,083 requests / 38.35 MB for
600 fixtures in the table above, which assumed 3-6 requests per fixture and is kept only as the conservative upper reading. Estimated
still: repairs, output tokens (1,500 per request), tokens per byte (3.0) and the 500 hidden input tokens. Planning cost per fixture:
Sonnet 5.5 USD 0.0429, Opus 5.5 USD 0.0858. Upper bound (byte bound + 8,192 output on every request) for one 660 run: Sonnet USD 126.18,
Opus USD 252.35; never spent, the admission stops first.

## 4. Prices (Vertex AI, US multi-region endpoint, ≤ 200K input tokens)

| model | input / 1M | output / 1M | global (for reference) |
| --- | --- | --- | --- |
| Claude Sonnet 5.5 `claude-sonnet-5-5` | USD 2.20 | USD 11.00 | 2.00 / 10.00 |
| Claude Opus 5.5 `claude-opus-5-5` | USD 4.40 | USD 22.00 | 4.00 / 20.00 |

Verified 2026-10-01 on https://cloud.google.com/vertex-ai/generative-ai/pricing (Claude tables, tab "US Multi-Region (US)"; the page
shows no last-updated date). Consistent with Anthropic's note that multi-region and regional endpoints carry a 10 % premium over
global (platform.claude.com, Claude on Google Cloud). No cache or batch class is used, so no other billable class applies. No request
in the plan exceeds 200K input tokens.

## 5. Cost (planning estimate, exact corpus bytes)

Prices of §4; tokens as in §1 (input = bytes / 3.0 + 500 per request, output 1,500 per request, repairs 14.2 %). Shapes as the runner runs them:
smoke = at most 40 requests per candidate; pilot = 60 fixtures spread over the sorted corpus (every 11th, `stage-child.mjs`) × 2 passes ×
every admitted candidate (89 requests per pass, 1.02 MB, 13 of them repairs); qualification = 3 runs × 660 fixtures of the selected candidate.

| stage | content | Sonnet 5.5 | Opus 5.5 | stage total |
| --- | --- | --- | --- | --- |
| smoke | ≤ 40 requests per candidate at USD 0.0301 / 0.0602 per request (mean of the corpus) | 1.20 | 2.41 | USD 3.61 |
| pilot | 60 fixtures × 2 passes × 2 candidates (89 requests per pass) | 5.39 | 10.78 | USD 16.16 |
| **grant A planning** | smoke + two-candidate pilot | 6.59 | 13.19 | **USD 19.77** (× 1.15 = 22.74) |
| qualification | 3 runs × 660 fixtures of the selected candidate | 84.92 | 169.84 | — |
| **total, Sonnet 5.5 selected** | A + qualification, each × 1.15 | | | **USD 122.4** |
| total, Opus 5.5 selected | | | | USD 218.0 |

Per fixture: Sonnet USD 0.0429, Opus USD 0.0858 (the pilot's 60 fixtures: 0.0449 / 0.0898). The earlier envelope (grant A USD 55, one candidate;
Sonnet 3 × 600 runs USD 247) assumed 308 requests per pilot pass and 3,083 requests per run; the exact corpus needs 89 and 940.

## 6. Hard cap and stop rule

Grants (each an owner approval; amounts include 15 % reserve for repairs and re-runs of invalidated fixtures, rounded up):

- **Grant A — smoke + two-candidate pilot (Sonnet 5.5 and Opus 5.5, two passes each): USD 25** (planning 19.77 × 1.15 = 22.74, plus margin for
  smoke fixtures wider than the corpus mean). Spent on any outcome; it buys the measurements that fix grant B.
- **Grant B — three runs of the selected candidate**, recomputed from pilot actuals before approval:
  - Sonnet 5.5 selected: **USD 98** (3 × 660 × 0.04289 × 1.15 = 97.66).
  - Opus 5.5 selected: **USD 196** (3 × 660 × 0.08578 × 1.15 = 195.3); needs a new approval and the release that bumps the pinned policy.
- **Campaign hard cap: USD 123 (A 25 + B 98) on the Sonnet path; USD 221 (A 25 + B 196) on the Opus path.** Gap against A4's API budget
  of USD 20/month: USD 103 (Sonnet path) or USD 201 (Opus path); grant A alone (USD 25) is above the USD 20 month but under the USD 40
  pilot aspiration. Manual 06 forbids truncating the corpus to fit; the owner chooses: fund it, or keep grant A only now.

Stop rule (enforced by the runner's admission, D4-CAMP-4):

1. Per request: its maximum charge (body bytes + 500) × input tariff + 8,192 × output tariff must fit the remaining grant after
   in-flight holds, or it is not sent.
2. Per run: a qualification run starts only if pilot-measured cost per fixture × 660 × 1.15 fits the remaining grant B (the code's `projectedRunMicros` = per-fixture cost × fixtures × 1.15, over all 660). A partial run
   never qualifies, so none is started that cannot finish.
3. Every 50 fixtures: if committed + held exceeds the run projection by 25 %, stop and report.
4. A hard-gate violation, a canary hit (R2-040), a served-model change (S044) or a liability above a reservation stops the campaign;
   diagnosis precedes any further funded request.
5. Unknown usage holds its full reservation until the daily billing reconciliation.

Remedy if the gap is not funded: grant A alone (USD 25) yields the live smoke (closes the live clauses of IC-13, S037, S040, IC-05,
S036, R2-027, R2-028) and the pilot's measured cost for both candidates; output is about 60 % of the planning cost, so if measured output
is near the visible 400 tokens instead of 1,500, a Sonnet run costs about USD 17 instead of USD 32 and grant B shrinks accordingly.

## 7. What the owner must provide (2026-10-08)

1. A Google Cloud project for nonproduction (suggested id `kauro-nonprod`) linked to a Cloud Billing account with a valid payment
   method or credits. Conflict to decide: the owner's "no bank/card" fact; free-trial credit eligibility for partner models is not
   verified.
2. Accept the Anthropic terms and enable **Claude Sonnet 5.5** and **Claude Opus 5.5** in Model Garden for that project (OA08).
3. Enable the Vertex AI API (`aiplatform.googleapis.com`) — Claude can do it once it has project access.
4. A service account `ic-qualification@<project>.iam.gserviceaccount.com` with `roles/aiplatform.user` only, no JSON key; grant the
   owner's account `roles/iam.serviceAccountTokenCreator` on it, then on this machine:
   `gcloud auth application-default login --impersonate-service-account=ic-qualification@<project>.iam.gserviceaccount.com`.
5. Quota in `us` for both models: at least 60 requests/min and 1 M input tokens/min (a new project may start at zero; the request is
   made in the console Quotas page).
6. Approve grant A (USD 25) and, after the pilot report, grant B; a Cloud Billing budget alert at the same amounts (a notification,
   not a cap).

## 8. Operator runbook (mandate B04-CAMPAIGN)

The runner is `tools/campaign/run.mjs` (`npm run campaign -- ...`). Run `npm run build` first. Every funded stage is refused, with
nothing installed, written or sent, unless all of these hold (codes printed as `REFUSED <code>`, exit 2):

| refusal | what the operator must supply |
| --- | --- |
| `NO_GRANT`, `GRANT_INVALID`, `GRANT_EXPIRED`, `GRANT_DOES_NOT_FUND_STAGE` | `--grant <file>`: the owner's grant `{ grantId, stages, capMicros, expiresAt, approvalRef }`; grant A stages `["SMOKE","PILOT"]`, grant B `["QUALIFICATION"]` |
| `NO_VALIDITY_RECORD`, `VALIDITY_RECORD_REFUSED` | `corpus/scorer-validity.json` for the CURRENT scorer and corpus digests (committed; `node tools/campaign/scorer-validity.mjs --check corpus/scorer-validity.json`) |
| `LOGGING_NOT_READ_BACK`, `LOGGING_NOT_OFF` | the runner reads back request-response logging of the model with `GET https://aiplatform.us.rep.googleapis.com/v1/projects/<project>/locations/us/publishers/anthropic/models/<model>:fetchPublisherModelConfig`; it must answer 200 and not report `loggingConfig.enabled: true`. The exact path and the shape of a partner model's answer are unverified offline: if the first smoke returns `LOGGING_NOT_READ_BACK` with a 404, fix the path in `tools/campaign/preflight.mjs` against the live API before anything else |
| `NO_CREDENTIAL` | ADC with impersonation (below) |
| `CANDIDATE_NOT_THE_PINNED_POLICY` | qualification only: it runs the candidate the pinned policy names (`SONNET_5_5_US`); the smoke and the pilot run every admitted candidate (D4-CAMP-1). If the pilot selects Opus 5.5, the release that follows the selection bumps the pinned policy first |
| `CANDIDATE_NOT_SELECTED` | qualification only: `--pilot-summary` must be the summary of an EXECUTED_PROVIDER pilot whose selection record names this candidate |
| `NO_PILOT_MEASUREMENT`, `RUN_NOT_1_2_3` | qualification only |

Credentials (no JSON key; a `service_account` file is refused):

```
gcloud auth application-default login --impersonate-service-account=ic-qualification@<project>.iam.gserviceaccount.com
```

Stage commands (`<grant-A>` and `<grant-B>` are grant files kept outside the repository; `--out` defaults to `campaign/out`, ignored by git):

```
# 1. smoke: one fixture per privacy channel, at most 40 requests per candidate; measures acceptance, served model, usage, headers, the live privacy suite
#    (no --candidate: every admitted candidate, Sonnet 5.5 and Opus 5.5, under the one grant and stop rule; with --candidate, that one)
npm run campaign -- --stage smoke   --project <id> --location us --grant <grant-A> --out <protected dir>
# 2. pilot: 60 fixtures spread over the corpus, two passes, for every admitted candidate under the same grant and stop rule; summary.json holds each
#    candidate's measured cost and the selection record (selection.json): eligibility, zero critical, thresholds, cost per accepted plan, latency
npm run campaign -- --stage pilot   --project <id> --location us --grant <grant-A> --out <protected dir>
# 3. qualify: one of three runs per call, each with its own campaign run id and receipts; grant B recomputed from the pilot before approval
npm run campaign -- --stage qualify --project <id> --location us --grant <grant-B> --candidate SONNET_5_5_US --run 1 --pilot-summary <pilot summary.json> --out <protected dir>
npm run campaign -- --stage qualify --project <id> --location us --grant <grant-B> --candidate SONNET_5_5_US --run 2 --pilot-summary <pilot summary.json> --out <protected dir>
npm run campaign -- --stage qualify --project <id> --location us --grant <grant-B> --candidate SONNET_5_5_US --run 3 --pilot-summary <pilot summary.json> --out <protected dir>
# 4. rehearse: offline, recorded SIMULATED transport, three runs of the 660 over the packed tarball, no grant, never qualification evidence
npm run campaign -- --stage rehearse --out <scratch dir>
```

What a stage does: packs the core (`npm pack`) and installs the tarball and the vendored Migration Core in a clean temporary directory;
the stage runs from there (`stage-child.mjs`), importing the package by name only: its public index and its declared entry `kauro-intelligence-core/benchmark` (package.json `exports`; no path into `dist` is importable, and the clean directory holds no link to it, D4-CAMP-5); the Vertex gateway
sits under `CampaignAdmission` (the stop rule of §6: per request, per run, every 50 fixtures, hard gate, canary, served-model change,
liability). Each stage writes `campaign/out/<stage>/<campaignRunId>/` (the pilot, and any stage that runs more than one candidate, writes a directory per candidate with these files, `pass-1` and `pass-2` inside it for the pilot, and `selection.json` and `summary.json` at the top): `receipts.jsonl` (protected, full bytes), `scores.json`,
`selection.json`, `run.json`, and, for a complete run, `report.json` and `run-record.json` (the bound run, subject and receipts digest) and
`summary.json`. A stopped or partial run writes no report and never qualifies. The three qualification run records go to `qualifyThreeRuns`
with the receipts read back from disk.

After the smoke and the qualification runs, the live suites read the stage output (they are skipped, printing `SKIPPED_NEEDS_LIVE`, otherwise):

```
set B04_LIVE=1
set B04_LIVE_OUT=<campaign/out/smoke/<campaignRunId>>      # IC-05, S036, R2-027 read a smoke or a qualification output
node --test --test-concurrency=1 dist/test/b04-campaign.test.js
# IC-10 live: B04_LIVE_OUT=<campaign/out/qualify/<campaignRunId>> of each of the three runs
```

Stop and diagnose before any further funded request when a run reports `stopped` (`HARD_GATE_VIOLATION`, `CANARY_HIT`,
`SERVED_MODEL_CHANGE`, `LIABILITY_ABOVE_RESERVATION`, `RUN_PROJECTION_EXCEEDED_BY_25_PERCENT`); a new grant approval is needed to continue.
