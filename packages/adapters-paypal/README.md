# @kauro/adapters-paypal

PROVIDER bindings of two B09 ports (package B15):

| Port (`@kauro/application`) | Binding | Wire |
|---|---|---|
| `PaymentProviderAdapter` | `createPayPalOrdersAdapter` | Orders v2 create / capture / get, Payments v2 refund / get capture / get refund |
| `WebhookVerifier` | `createPayPalWebhookVerifier` | `POST /v1/notifications/verify-webhook-signature` (PayPal's verdict over the exact raw body) |

- No runtime dependency: HTTP goes through an injected `HttpTransport` (`fetchTransport()` in production).
- Tests never reach the network: `test/fixtures/wire` holds PayPal's official API examples (URL, spec version, SHA-256 of the
  spec file, retrieval date) and declared derivations of them; `test/contract.test.ts` runs one table against the contract fake and
  this adapter. Evidence class of these tests: EXECUTED_LOCAL. The live sandbox (`test/live-sandbox.test.ts`) runs only with
  `KAURO_LIVE_SANDBOX=1` (B).
- Idempotency: every effect is sent under the attempt's `PayPal-Request-Id` (`kauro-<attemptId>`), identical on every replay.
- Clock skew: `PAYPAL_CLOCK_SKEW_POLICY` (D-15, 10 s symmetric, versioned).
- Errors are thrown as `PayPalAdapterError` with a catalogued code or returned as the port's typed result; nothing is logged.

Design, failure matrix, findings and the B15 live checklist: `docs/design/B15-adapters.md`.
