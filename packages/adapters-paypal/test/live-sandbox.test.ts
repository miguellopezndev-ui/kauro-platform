/**
 * Live PayPal sandbox run (EXECUTED_PROVIDER evidence): skipped unless KAURO_LIVE_SANDBOX=1, which only B sets (B15 rule 3). It reads the
 * sandbox client credentials from the file KAURO_PAYPAL_SANDBOX_CREDENTIALS_FILE ({"clientId","clientSecret"}, mode 0600) and the
 * sandbox merchant id from KAURO_PAYPAL_SANDBOX_MERCHANT_ID. It creates one order and reads it back by id; the buyer approval and the
 * capture need the sandbox buyer's browser step and are B15's live checklist (docs/design/B15-adapters.md L-PP-*).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createPayPalOrdersAdapter, fetchTransport } from "../src/index.js";

const LIVE = process.env["KAURO_LIVE_SANDBOX"] === "1";

describe("PayPal live sandbox (KAURO_LIVE_SANDBOX=1 only)", { skip: !LIVE }, () => {
  it("L-PP-1 create an order and read it back by id: CREATED with an approval page on www.sandbox.paypal.com", async () => {
    const file = process.env["KAURO_PAYPAL_SANDBOX_CREDENTIALS_FILE"];
    const merchantId = process.env["KAURO_PAYPAL_SANDBOX_MERCHANT_ID"];
    assert.ok(file !== undefined && merchantId !== undefined, "set KAURO_PAYPAL_SANDBOX_CREDENTIALS_FILE and KAURO_PAYPAL_SANDBOX_MERCHANT_ID");
    const credentials = JSON.parse(readFileSync(file, "utf8")) as { clientId: string; clientSecret: string };
    const clock = { now: () => new Date().toISOString(), nowMs: () => Date.now() };
    const adapter = createPayPalOrdersAdapter({ environment: "SANDBOX", merchantId, returnOrigin: "https://app.kauro.test", transport: fetchTransport(), credentials: { read: async () => credentials }, clock });
    const attempt = `kauro-live-${Date.now()}`;
    const created = await adapter.dispatch(adapter.prepareCreateOrder({ orderId: attempt, attemptId: attempt, providerRequestId: attempt, amountCents: 100n, currency: "USD", description: "KAURO_PROJECT_PREPARATION", returnPath: "/checkout/return", cancelPath: "/checkout/cancel" }), new Date(Date.now() + 30_000).toISOString());
    assert.equal(created.kind, "ORDER_CREATED");
    const id = (created as { providerOrderId: string }).providerOrderId;
    const seen = await adapter.observeOrder({ providerOrderId: id });
    assert.deepEqual([seen.orderStatus, seen.providerOrderId, new URL(seen.approvalUrl ?? "https://x").host], ["CREATED", id, "www.sandbox.paypal.com"]);
  });
});
