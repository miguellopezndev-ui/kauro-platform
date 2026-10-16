# B04 — implementation mandates

Twelve mandates, each one Sonnet agent for about two hours. Rules (as B03, A4):

- Branch `ic/b04-<key in lower case without the B04- prefix>` from the branch named in **from**; merge into the stage branch in the
  order given. Stage branches: `ic/b04-stage-1` (from `ic/b04-design`), `ic/b04-stage-2`, `ic/b04-stage-3`.
- Tests first: the first commit holds the test file with every title the mandate owns in `B04-case-map.md`, failing; then the code.
- Focused tests while building (`node --test dist/test/<file>.test.js` after `npm run build`); the full `npm run gate` once at stage
  merge. No paid call, no network call to Google in any test: offline transports are labelled SIMULATED.
- No new runtime dependency in the IC package. `google-auth-library` (pinned exact) may enter only as a devDependency used by
  `tools/campaign`.
- Every commit message ends with the session's attribution lines. Records short: case, test, commit.
- Concurrency: at most the lanes the operator allows (quota rule: two agents until 2026-10-06).

## Stage 1 (parallel)

### B04-POLICY — candidate profiles, eligibility before cost
- from: `ic/b04-design` · tests: `test/b04-policy.test.ts` (S091, R2-041)
- Replace the hard-coded `claude-opus-5` policy with `CandidateProfile` (`src/gateway/candidates.ts`): `SONNET_5_5_US`,
  `OPUS_5_5_US` (model id, location `us`, effort `high`, tariff micro-USD/token from `B04-campaign-envelope.md` §4, retention class
  `NO_PROVIDER_MINIMUM`, eligibility record shape), a refused `GEMINI_UNVERIFIED` negative control, and `admitCandidate()` that
  refuses a profile without a read-back record or with a provider-minimum retention class before any cost comparison.
- One version bump of model policy and prompt bundle (the `pins` sentence); re-anchor only the literal version assertions.
- Done when: both titles pass; `npm run gate` green; no test still names `claude-opus-5` as the pinned model.

### B04-WIRE — Vertex body, URL and preflight
- from: `ic/b04-design` · tests: `test/b04-bedrock-wire.test.ts` (IC-13, S037, URL supporting test; A9), `test/b04-vertex-wire.test.ts` (the retired Vertex wire)
- `src/provider/vertex-wire.ts`: `toVertexBody(ProviderRequest)` (drop `model`, add `anthropic_version: "vertex-2023-10-16"`),
  `vertexUrl(project, model)` with the literal US multi-region host and `locations/us`, `preflightVertexBody()` over a closed member
  set and value domains; refusal is a `TransportError` with stage `BEFORE_SEND`. Serialization is canonical and done once.
- Done when: the three titles pass; a body built from every B03 fixture request passes preflight.

### B04-CORPUS — corpus framework, sealing, distinctness, canaries
- from: `ic/b04-design` · tests: `test/b04-corpus.test.ts` (S042, R2-040)
- `corpus/` generator framework (`tools/corpus/generate.mjs` + `src/benchmark/corpus.ts` types): a fixture template plants facts and
  writes truth from what it planted (never runs IC); `fingerprintOf()` over normalized structure; manifest with fixture, truth and
  fingerprint digests; truth canaries; `scanForContamination(receiptBytes, manifest)`. Seal writes `corpus/MANIFEST.json` and its
  digest. Ships with 12 seed fixtures (one per family) to prove the pipeline.
- Done when: both titles pass on the seed set and on a synthetic 600-renaming set.

## Stage 2 (parallel after stage 1 merges)

### B04-TRANSPORT — fetch transport, raw chunks, error shapes
- from: `ic/b04-stage-1` · depends: B04-WIRE · tests: `test/b04-bedrock-transport.test.ts` (S040, R2-028; A9), `test/b04-vertex-transport.test.ts` (the retired Vertex transport)
- `src/provider/vertex-transport.ts`: `vertexTransport({ project, profile, tokenProvider, fetchImpl })` returning a B03 `Transport`;
  sends the preflighted buffer; hands `response.body` chunks as `bodyChunks`; classifies 400/403/404/429/5xx (retry-after),
  BEFORE_SEND vs AFTER_SEND vs UNKNOWN; never retries. Tests use an injected `fetchImpl` that replays recorded responses
  (`test/support/vertex-recordings/*.json`, hand-written from the documented Messages response shape and labelled SIMULATED).
- Done when: both titles pass; a test proves a thrown fetch after the body stream started is AFTER_SEND.

### B04-RECEIPTS — request/response receipts, served model, usage, identity
- from: `ic/b04-stage-1` (merge B04-TRANSPORT first if done) · depends: B04-TRANSPORT · tests: `test/b04-receipts.test.ts` (S038,
  R2-032, two supporting tests)
- `RequestReceipt` / `ResponseReceipt` emitted through an injected `ReceiptSink` (protected bytes) and projected publicly as digests;
  redacted authorization; served-model and cache-token checks; `USAGE_UNKNOWN`; provider message id into the journal's response
  record; reconciliation lookup by idempotency ref.
- Done when: four titles pass; the B03 leak scanner over receipts finds no sentinel in the public projection.

### B04-FIXTURES-SUPPORTED — 200 + 20 pilot SUPPORTED fixtures
- from: `ic/b04-stage-1` · depends: B04-CORPUS · tests: adds `test/b04-corpus-families.test.ts` :: `SUPPORTED: 220 distinct sealed fixtures cover the twelve families and three modes`
- Templates for the twelve families × three modes with planted truth and explicit alternatives.

### B04-FIXTURES-BOUNDARY — AMBIGUOUS_ABSTENTION 110 + SAFETY 110
- from: `ic/b04-stage-1` · depends: B04-CORPUS · tests: adds to `test/b04-corpus-families.test.ts` :: `AMBIGUOUS_ABSTENTION and SAFETY: 220 distinct sealed fixtures, each with a hard-gate marker or expected abstention`

### B04-FIXTURES-HARD — ADVERSARIAL 110 + UGLY_MULTILINGUAL_STALE 110
- from: `ic/b04-stage-1` · depends: B04-CORPUS · tests: adds to `test/b04-corpus-families.test.ts` :: `ADVERSARIAL and UGLY_MULTILINGUAL_STALE: 220 distinct sealed fixtures covering every egress surface, memory scope and cross-partition case`
- After the three fixture mandates merge: one commit seals the 660-fixture manifest (stage-2 merge step, done by the operator).

### B04-SCORER — scorer validity before spending
- from: `ic/b04-stage-1` · depends: B04-CORPUS (runs on the seed set; re-run on 660 at stage merge) · tests:
  `test/b04-scorer-validity.test.ts` (IC-10, S043, R2-042, positive-controls supporting test)
- Stale-receipt check, per-family and per-capability rates, truth-following synthetic answers generated from sealed truth (a
  scripted gateway, labelled SIMULATED), sabotage set per family; `tools/campaign/scorer-validity.mjs` writes the validity record
  bound to scorer and corpus digests.

## Stage 3 (after stage 2 merges and the corpus is sealed)

### B04-QUALIFY — subject, independence, campaign grant
- from: `ic/b04-stage-2` · depends: B04-POLICY, B04-RECEIPTS, B04-SCORER · tests: `test/b04-qualification.test.ts` (IC-11 ×2, S044,
  R2-039)
- `QualificationSubject` in every report; receipt-set disjointness in `qualifyThreeRuns`; `REPLAY` label; `CampaignGrant` admission
  above `DispatchAdmission` with the stop rule of `B04-campaign-envelope.md` §6; `tools/campaign/envelope.mjs` computes the exact
  reservation from the sealed corpus bytes.

### B04-CAMPAIGN — runner, clean consumption, live suite
- from: `ic/b04-stage-2` · depends: B04-QUALIFY, B04-TRANSPORT · tests: `test/b04-campaign.test.ts` (IC-10 live, IC-05, S036,
  R2-027 live suites; rehearsal supporting test)
- `tools/campaign/run.mjs` and `npm run campaign`: stages smoke/pilot/qualify/rehearse; packs and installs the tarball in a clean
  directory; ADC token provider with impersonation; refuses without grant, validity record or read-back of request-response logging
  (`GET …/publishers/anthropic/models/{m}` logging config via the Vertex API); live tests run only under `B04_LIVE=1`, otherwise
  print `SKIPPED_NEEDS_LIVE`. Rehearsal over the 660 corpus with recorded transport must pass before stage close.

### B04-RELEASE-PREP — case-map check, docs, rc
- from: `ic/b04-stage-2` (after B04-CAMPAIGN) · tests: `tools/test/b04-case-map.test.mjs` (`npm run design:check` runs B03 and B04)
- Case-map checker for B04 (same rules as B03's), `docs/IC2_READINESS.md` and `COMPATIBILITY_MATRIX.md` updates, version
  `0.6.0-rc.1` with UNQUALIFIED policy, full gate on Windows, Linux and CI. Then the operator asks Codex for the offline review.
- Closed offline on `ic/b04-release`: the checker (shared title reader `tools/lib/test-titles.mjs`), `test/b04-release.test.ts`, the docs and the rc version; the two
  corrections to B04-CAMPAIGN (pilot compares admitted candidates and selects; clean consumption through `./benchmark`) are in `test/b04-campaign-compare.test.ts`.

## Order

```
stage 1:  B04-POLICY ∥ B04-WIRE ∥ B04-CORPUS                       → ic/b04-stage-1 (merge in that order)
stage 2:  B04-TRANSPORT → B04-RECEIPTS
          ∥ B04-FIXTURES-SUPPORTED ∥ B04-FIXTURES-BOUNDARY ∥ B04-FIXTURES-HARD ∥ B04-SCORER
          then seal the 660 manifest                                → ic/b04-stage-2
stage 3:  B04-QUALIFY → B04-CAMPAIGN → B04-RELEASE-PREP             → ic/b04-stage-3 → Codex offline review
live (after owner grants, from 2026-10-08): smoke → pilot → selection → grant B → runs 1-3 → release 0.6.0 → Codex package-close review
```

About 12 agent-sessions offline; with two lanes, roughly five working days, inside the 2026-10-07 sheet date only if stage 1 starts
by 2026-10-02.
