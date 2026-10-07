# B15 — provider adapters behind the existing ports

Lane: the real adapters behind the ports B06–B14 already define, built before B15's live work so that B15 is only the live binding.
Authority: R2 (`packages/contracts/registry/*.json`, `docs/design/*`) and amendments A2..A9 (A8 payments: PayPal is the secondary route,
Wise/ACH the preferred one in PENDING_VERIFICATION; A9 cloud: AWS). One PR per provider, branch `b15/adapters-<provider>`, order
PayPal → Alegra → Resend → S3 → SQS → Cognito → Wise.

Evidence classes (21 "Evidence classes"): every test in these packages is **EXECUTED_LOCAL** — the real adapter code runs against a
recorded wire built from the provider's official documentation (fixtures carry URL, version, SHA-256 of the source and retrieval date;
a fixture changed from an official example is `DERIVED_FROM_OFFICIAL_EXAMPLE` and lists every edit). The contract fakes are
**SIMULATED**. Nothing here is **EXECUTED_PROVIDER**: that needs the live sandbox run (`KAURO_LIVE_SANDBOX=1`, B only) and closes no
case by itself (the B15 cases need the integrated candidate, R2 program B15 "ownerAction").

## 1. Port → adapter → fixtures → what stays for B15 live

| Port | Adapter (package) | Recorded wire (fixtures) | Left for B15 live |
|---|---|---|---|
| `PaymentProviderAdapter` (`@kauro/application` commerce/ports.ts) | `createPayPalOrdersAdapter` (`@kauro/adapters-paypal`) | `packages/adapters-paypal/test/fixtures/wire`: 16 official examples of PayPal OpenAPI orders v2.32 / payments v2.12 / webhooks v1 (github.com/paypal/paypal-rest-api-specifications, retrieved 2026-10-07) + 7 declared derivations | L-PP-1..L-PP-6 below; binding in composition (I-PP-6); sandbox credentials in Secrets Manager; webhook registration |
| `WebhookVerifier` (same file) | `createPayPalWebhookVerifier` (`@kauro/adapters-paypal`) | same directory (`webhooks.*`, `derived.webhook.*`) | L-PP-4, L-PP-5 |
| `FiscalDocumentBridge` | Alegra — next PR (`b15/adapters-alegra`) | — | — |
| notification sender (B11/B13 port) | Resend — pending | — | — |
| `ObjectStoragePort` | S3 — pending (AWS-DELTA §2.4, D-19, D-HOLD-5) | — | — |
| outbox dispatch | SQS — pending (AWS-DELTA §2.5) | — | — |
| identity verification | Cognito — pending (AWS-DELTA §2.7; TOTP+MFA proof or 503) | — | — |
| ACH receipt port (B defines it) | Wise — waits for B's port (proposal in its PR); KYC verification when it ends | — | — |

## 2. PayPal (`packages/adapters-paypal`, branch `b15/adapters-paypal`)

### 2.1 Design

- **Wire.** Orders v2 `POST /v2/checkout/orders`, `POST /v2/checkout/orders/{id}/capture`, `GET /v2/checkout/orders/{id}`; Payments v2
  `POST /v2/payments/captures/{id}/refund`, `GET /v2/payments/captures/{id}`, `GET /v2/payments/refunds/{id}`; OAuth
  `POST /v1/oauth2/token`; `POST /v1/notifications/verify-webhook-signature`. No SDK, no runtime dependency: an injected
  `HttpTransport` (`fetchTransport()` over the global fetch, `redirect: "error"`).
- **Requests.** `prepare*` produce the same bodies as the contract fake (create: intent CAPTURE, one purchase unit with the order as
  `reference_id`/`custom_id`, the amount as a two-decimal string, the payee merchant, `application_context` with the return/cancel URLs
  on the configured https origin, `PAY_NOW`, `NO_SHIPPING`; capture: empty body; refund: amount and the platform refund id as
  `invoice_id`). `application_context` is kept over `payment_source.paypal.experience_context` because the latter makes PayPal answer
  `PAYER_ACTION_REQUIRED` with a `payer-action` link, a state the port's `orderStatus` does not name.
- **Idempotency (rule 4).** Every effect is sent under `PayPal-Request-Id` = the attempt's `kauro-<attemptId>` (domain
  `providerRequestIdOf`), identical on every replay and on the one retry after a token renewal. PayPal stores the key 6 h (72 h on
  request; spec text of the header). A replay answered 200 is the first request's result.
- **What a dispatch proves.** 200/201 documented resource → ORDER_CREATED / CAPTURE_OBSERVED / REFUND_OBSERVED; 400/404/422 →
  PROVED_NO_EFFECT with the provider issue as outcome code; 5xx → AMBIGUOUS PROVIDER_5XX; timeout/reset/unreadable → AMBIGUOUS with that
  reason; nothing is sent past the deadline (AMBIGUOUS TIMEOUT) and an in-flight call is aborted at it; 401 twice, 403, 409, 429 → thrown
  `PayPalAdapterError` (no proof either way; the attempt stays on B09's ambiguous path); anything else → UNRECOGNIZED.
- **Capture status mapping.** COMPLETED → COMPLETED (completed at `update_time`); PENDING → PENDING; DECLINED, FAILED → DENIED;
  PARTIALLY_REFUNDED, REFUNDED → COMPLETED with unknown completion instant; REVERSED → REVERSED; other → UNRECOGNIZED. Funds:
  `disbursement_mode` INSTANT → AVAILABLE, DELAYED → HELD (R2-085), absent → UNKNOWN (the schema default is never assumed).
- **Fee (A8).** `seller_receivable_breakdown.paypal_fee` of each capture, in the capture currency; another currency → null. No tariff
  constant exists in the adapter.
- **Payee.** The capture's `payee`, else the purchase unit's; when neither is present (PayPal's own capture examples omit both) the
  capture resource is read (`GET /v2/payments/captures/{id}`) and the evidence hash covers both answers. If that read fails after a
  completed capture → AMBIGUOUS OBSERVATION_LOST (the reconciler binds it from an order observation).
- **Clock skew (rule 5, D-15).** `PAYPAL_CLOCK_SKEW_POLICY` = `{ id: "paypal.clock-skew", version: 1, toleranceSeconds: 10 }`. Webhook
  freshness: stale when older than 300 s + 10 s or more than 10 s in the future. The OAuth token lifetime is measured on the platform's
  clock only (renewal 60 s early), never against a provider instant.
- **Webhook verification.** PayPal's verdict over the exact raw bytes (the event is spliced verbatim into the postback body). Local
  checks first, in the contract fake's order: body bound, headers, `SHA256withRSA`, cert URL host (the other environment's host →
  ENVIRONMENT_MISMATCH, any other host → SIGNATURE_INVALID, PayPal not called), then the verdict, then freshness. A verdict that is
  neither SUCCESS nor FAILURE → thrown VERIFICATION_UNAVAILABLE (the route answers 503 and PayPal redelivers).
- **Errors (rule 6).** `PayPalAdapterError.code` ∈ CREDENTIAL_REJECTED, TOKEN_UNAVAILABLE, PERMISSION_DENIED, REQUEST_IN_PROGRESS,
  RATE_LIMITED, OBSERVATION_FAILED, UNRECOGNIZED_PROVIDER_STATE, VERIFICATION_UNAVAILABLE, INVALID_REQUEST. Nothing is logged; no
  credential reaches a request other than the token call, an error message or a request hash (hash carries `credentialRef` only).

### 2.2 Failure matrix (template: docs/design/FAILURE-MATRIX-TEMPLATE.md)

The adapter writes nothing durable: every COMMIT around a call (the attempt's PREPARED → DISPATCHING claim, the settle, the inbox row)
belongs to B09's protocol and is covered by B09's matrix (`docs/design/B09-payments-fiscal.md`, `B09-case-map.md`). CRASH and PARTIAL
cells of the adapter are therefore N/A with that reason unless the call itself has two parts. Test files: `C:` =
`packages/adapters-paypal/test/contract.test.ts`, `F:` = `packages/adapters-paypal/test/failure-matrix.test.ts`.

| Row (call-out) | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| P1 dispatch CREATE `POST /v2/checkout/orders` | N/A: two senders of one attempt send the same request id; PayPal answers 409 to the second while the first runs (row P3 C) or replays the first result | C: past deadline nothing sent — `C: "TIMEOUT a dispatch past its deadline sends nothing and is AMBIGUOUS TIMEOUT" [PROVIDER]`; reset/unreadable — `F: "RACE (timeout): a connection reset is AMBIGUOUS CONNECTION_RESET"`, `F: "RACE (timeout): an unreadable 2xx body is AMBIGUOUS UNREADABLE_RESPONSE"` | N/A: the deadline is the TIMEOUT cell; the order's own expiry is observed (P4) | N/A: no durable write in the adapter (B09 claim COMMIT) | N/A: idem; the lost answer is the TIMEOUT cell, its recovery F-PP-1 | C: `C: "RETRY create order: the same PayPal-Request-Id answers the first order and makes no second one" [PROVIDER]`, `F: "OK the idempotent 200 creation answer with a payer-action link is ORDER_CREATED on the allowlisted host"` | C: `F: "RETRY (revocation): an expired or revoked token is renewed once and the identical request is repeated under the same request id"`, `F: "DENY (revocation): a token refused again after renewal is a thrown CREDENTIAL_REJECTED, never a result"` | N/A: one call |
| P2 dispatch CAPTURE `POST …/capture` | C: concurrent same-id capture → 409 thrown `F: "DENY HTTP 409 on a dispatch is a thrown REQUEST_IN_PROGRESS: no proof either way"` (refund route; same handler) | C: `C: "RACE (timeout): a capture whose answer never arrives is AMBIGUOUS TIMEOUT; the order read by id then shows the capture" [PROVIDER]`, `C: "RACE (timeout): a provider 5xx is AMBIGUOUS PROVIDER_5XX, never no effect" [PROVIDER]` | N/A: deadline is TIMEOUT | N/A: no durable write | N/A: idem | C: `F: "RETRY every effect carries the attempt's PayPal-Request-Id, identical on a replay, never random"` | C: as P1 | C (two parts: capture answer + capture read): `F: "PARTIAL a captured order whose capture names no payee and whose capture read fails is AMBIGUOUS OBSERVATION_LOST, never a capture"`, `F: "OK a capture answer whose capture names no payee is completed from the capture resource, and the evidence covers both answers"` |
| P3 dispatch REFUND `POST …/refund` | C: `F: "DENY HTTP 409 on a dispatch is a thrown REQUEST_IN_PROGRESS: no proof either way"` | C: as P1 (same dispatch path) | N/A | N/A: no durable write | N/A | C: `F: "RETRY a refund replay answered 200 by PayPal is the same REFUND_OBSERVED under the same request id"` | C: as P1 | N/A: one call |
| P4 observeOrder by id `GET /v2/checkout/orders/{id}` (+ capture reads) | N/A: read-only | C: `F: "DENY an order read that fails is a thrown OBSERVATION_FAILED, never NOT_FOUND"` | C: an expired order is 404 → NOT_FOUND proof `C: "OK observe an unknown order id: NOT_FOUND and absence is proof" [PROVIDER]` | N/A: read-only | N/A: read-only | N/A: read-only, repeatable | C: as P1 (shared client) | C: one capture read failing fails the whole observation (OBSERVATION_FAILED), never a partial list — same code path as P2 PARTIAL |
| P5 observeOrder / observeRefund by request id | N/A: no call | N/A: no call | N/A | N/A | N/A | N/A | N/A | N/A — behaviour pinned by `C: "F-PP-1 observe a creation by its request identity: the fake proves absence, PayPal documents no such lookup" [PROVIDER]` |
| P6 observeRefund by id `GET /v2/payments/refunds/{id}` | N/A: read-only | C: same `read()` as P4 | N/A | N/A | N/A | N/A | C: as P1 | N/A: one call; CANCELLED `F: "DENY a refund the provider reports CANCELLED is a thrown UNRECOGNIZED_PROVIDER_STATE (the port's result cannot express it)"` |
| P7 webhook verify `POST /v1/notifications/verify-webhook-signature` | N/A: stateless | C: `F: "DENY a verification postback that answers neither SUCCESS nor FAILURE ({"fail":"TIMEOUT"}) is a thrown VERIFICATION_UNAVAILABLE"` | C: D-15 N-1/N/N+1 `F: "EXPIRY past bound: a transmission N-1 s old is fresh, N s fresh, N+1 s stale (N = window + tolerance)"`, `F: "EXPIRY future bound: a transmission 9 s ahead is fresh, 10 s fresh, 11 s stale; no comparison without the margin"` | N/A: no durable write (inbox COMMIT is CMD030's) | N/A | C (duplicate delivery; dedupe is the inbox's by external id): `F: "RETRY a duplicate delivery of the same event is verified again with the same external event id and body hash (dedupe is the inbox's)"`; out-of-order delivery: each event is classified alone with its provider chronology (`providerEventAt`) — reordering is R2-061, reconciled by P4 | C: forged / other environment `C: "DENY a forged signature is PROVIDER_SIGNATURE_INVALID" [PROVIDER]`, `C: "DENY an event signed for the other environment is PROVIDER_ENVIRONMENT_MISMATCH" [PROVIDER]` | N/A: one call |
| P8 OAuth token `POST /v1/oauth2/token` | N/A: two concurrent renewals each obtain a valid token; the cache keeps the last (no wrong outcome) | C: `F: "DENY a token endpoint that issues nothing is a thrown TOKEN_UNAVAILABLE and the target is never called"` | C: renewal before `expires_in` on the platform clock; revoked token mid-flow → P1 REVOCATION | N/A: in-memory cache only | N/A | C: P1 REVOCATION (one renewal, then thrown) | C: P1 REVOCATION | N/A: one call |

Secrets: `F: "DENY the client secret appears only in the token request's Basic header, never in an API request or an error message"`.

### 2.3 Findings (contract table: fake vs real wire)

Every divergence is asserted per binding in `contract.test.ts` (row titles start with the finding id), so it cannot drift silently.

- **F-PP-1 (port/fake vs provider; tier 1 money, needs B).** PayPal documents no read-only lookup of an order or a refund by
  `PayPal-Request-Id`. The fake answers NOT_FOUND with `absenceIsProof: true`; the real adapter must answer `absenceIsProof: false` and
  calls nothing. Consequences in B09: (a) a CREATE_ORDER whose answer was lost can never be proven absent — safe, since an orphan order
  without its approval URL is never approved nor captured, so B may decide a NEW_ATTEMPT after the dispatch deadline without proof
  (D-PROTO-B3), or after PayPal's 6 h key retention; (b) a REFUND whose answer was lost: the refund resource names the platform refund
  id as `invoice_id` and the order view lists every refund, so the adapter can prove presence/absence if the port gives it the platform
  refund id. Requested: I-PP-3 (port) and I-PP-4 (fake).
- **F-PP-2 (fake vs D-15; tier 3).** The fake accepts a transmission up to 300 s in the future and has no skew margin; D-15 says 10 s
  symmetric. The real verifier follows D-15. Requested: I-PP-4.
- **F-PP-3 (port cannot express a provider state).** A CANCELLED refund on `observeRefund` (refund_status enum CANCELLED) has no port
  result; the adapter throws UNRECOGNIZED_PROVIDER_STATE. Requested: I-PP-3 adds `{ kind: "UNRECOGNIZED"; evidenceHash }` to the
  `observeRefund` result.
- **F-PP-4 (fake vs provider; no wrong outcome).** A signed but non-JSON body: the fake verifies it as UNRECOGNIZED; PayPal's postback
  cannot carry it, so the real verifier rejects it (SIGNATURE_INVALID). PayPal only sends JSON; recorded, no change requested.
- **Official examples are incomplete.** The documented GET order example has no `status`, the create example (minimal) has none, and no
  capture example names its payee; the adapter handles each (UNRECOGNIZED, accepted, capture read). The derivations that fill them are
  listed in each derived fixture's `provenance.edits`.

### 2.4 Live checklist (B15, `KAURO_LIVE_SANDBOX=1`, B)

- L-PP-1 create + read back by id (`test/live-sandbox.test.ts`).
- L-PP-2 sandbox buyer approves; capture; observed fee equals PayPal's reported fee; `disbursement_mode` seen.
- L-PP-3 refund partial and full; `invoice_id` echoed on the refund and on the order view's `payments.refunds`.
- L-PP-4 webhook registration per environment (webhook id into config); a real delivery verified by the postback; a replayed delivery.
- L-PP-5 whether `PAYMENT.CAPTURE.REVERSED` carries a capture or a refund-shaped resource (the classifier follows the fake: capture).
- L-PP-6 whether the full representation of a capture answer names `purchase_units[].payee` (if yes, the capture read is skipped).

### 2.5 Integración que pido a B (exact diffs; nothing here is done by this lane)

- **I-PP-1 `architecture.rules.json`** — register the package as an adapter and server-only:
  ```diff
       "@kauro/data-plane": "adapter",
  +    "@kauro/adapters-paypal": "adapter",
  ```
  ```diff
  -  "serverOnlyPackages": ["pg", "fastify", "@kauro/persistence", "@kauro/data-plane", "@kauro/application", "@kauro/domain", "@kauro/authorization"],
  +  "serverOnlyPackages": ["pg", "fastify", "@kauro/persistence", "@kauro/data-plane", "@kauro/application", "@kauro/domain", "@kauro/authorization", "@kauro/adapters-paypal"],
  ```
- **I-PP-2 `pnpm-lock.yaml`** — regenerate with `pnpm install` (adds importer `packages/adapters-paypal` with `@kauro/application`,
  `@kauro/contracts`, `@kauro/domain` as `link:` and `@types/node` 24.3.1, `typescript` 5.9.2; no external package).
- **I-PP-3 port `packages/application/src/commerce/ports.ts`** (F-PP-1, F-PP-3):
  ```diff
  -  observeRefund(ref: { readonly providerRefundId: string } | { readonly providerCaptureId: string; readonly providerRequestId: string }): Promise<ObservedRefund | { readonly kind: "NOT_FOUND"; readonly absenceIsProof: boolean; readonly evidenceHash: Sha256Hex }>;
  +  observeRefund(ref: { readonly providerRefundId: string } | { readonly providerCaptureId: string; readonly providerRequestId: string; readonly platformRefundRef: string }): Promise<ObservedRefund | { readonly kind: "NOT_FOUND"; readonly absenceIsProof: boolean; readonly evidenceHash: Sha256Hex } | { readonly kind: "UNRECOGNIZED"; readonly evidenceHash: Sha256Hex }>;
  ```
  and in `core/provider-effects.ts` the REFUND observe passes `platformRefundRef: attempt.refundId` (the refund id the request carried
  as `invoice_id`). With it the PayPal adapter reads the capture's order and looks the refund up by `invoice_id` (absence is then proof).
  Until B decides, the adapter keeps `absenceIsProof: false`.
- **I-PP-4 fake `packages/application/src/commerce/testing/{paypal-fake,webhook-verifier-fake}.ts`** (F-PP-1, F-PP-2): in
  `observeOrder`/`observeRefund` by request id answer `absenceIsProof: false` (the provider documents no such lookup); in `verify`
  replace `Math.abs(Date.parse(raw.receivedAt) - sent) > freshnessSeconds * 1000` by the D-15 check (`age > (freshness + 10) * 1000 ||
  -age > 10 * 1000`). B decides whether B09 tests that rely on the proven absence move to the I-PP-3 lookup first.
- **I-PP-5 D-15 constant** — the owner places it in the commission policy; when B adds it there, `PAYPAL_CLOCK_SKEW_POLICY` re-exports it
  (one source).
- **I-PP-6 composition (production binding, when B wires the PayPal route)** — `createPayPalOrdersAdapter({ environment, merchantId,
  returnOrigin, transport: fetchTransport(), credentials, clock })` and `createPayPalWebhookVerifier({ environment, webhookId,
  transport, credentials, clock })`, with `credentials.read(ref)` reading the Secrets Manager file the deployment writes (AWS-DELTA §2.6)
  and `merchantId`/`webhookId` from configuration.

- **I-PP-7 `tools/evidence.mjs`** — the evidence run must list every workspace package with a test script
  (`tools/test/evidence.test.mjs` "the suites the tool runs are the packages' own test scripts, …" fails without it):
  ```diff
     { name: "data-plane", cwd: "packages/data-plane", script: 'node --test --test-reporter=spec "dist/test/**/*.test.js"', args: ["dist/test/**/*.test.js"] },
  +  // package B15: the PayPal provider adapters on the recorded wire
  +  { name: "adapters-paypal", cwd: "packages/adapters-paypal", script: 'node --test --test-reporter=spec "dist/test/**/*.test.js"', args: ["dist/test/**/*.test.js"] },
  ```

### 2.6 Reversal proofs (rule 4)

Each guard reverted alone, the suite rebuilt and run; the failing titles and assertion text are pasted in the PR brief.
