// Reproduce a database clock behind Node on Linux, without timing sleeps or changing a production guard.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { toUtcInstant, type UserId } from "@kauro/domain";
import { serverNow } from "@kauro/persistence/testing";
import {
  acceptAttribution, approvedPlan, captureOf, checkoutOf, claimsOn, commissionWorld,
  deliveryOf, eventOf, fixtureQuote, linesOf, purchase, sellingAgency,
  type Attribution, type CommissionWorld, type Selling,
} from "./commission-support.js";
import { ids, sha } from "./support.js";

let cw: CommissionWorld;
let selling: Selling;
let attribution: Attribution;

before(async () => {
  const previous = process.env["KAURO_TEST_CLOCK_OFFSET_MS"];
  process.env["KAURO_TEST_CLOCK_OFFSET_MS"] = "-5";
  try { cw = await commissionWorld(); }
  finally {
    if (previous === undefined) delete process.env["KAURO_TEST_CLOCK_OFFSET_MS"];
    else process.env["KAURO_TEST_CLOCK_OFFSET_MS"] = previous;
  }
  selling = await sellingAgency(cw, "clock-skew");
  // Explicit setup proofs keep the negative control focused on the defaults exercised by the two tests below.
  const record = cw.h.recordStepUp.bind(cw.h);
  cw.h.recordStepUp = async (user, options = {}) => record(user, {
    ...options, issuedAt: options.issuedAt ?? toUtcInstant(Date.parse(await serverNow(cw.h.assurancePool.raw)) - 1000),
  });
  try { attribution = await claimsOn(cw, "clock-skew"); }
  finally { cw.h.recordStepUp = record; }
  await acceptAttribution(cw, selling.agency.agencyId, attribution, [10_000]);
  const first = await purchase(cw, selling, "clock-skew-first", {
    providerCompletedAt: toUtcInstant(Date.parse(await serverNow(cw.h.paymentPool.raw)) - 1000),
  });
  assert.equal(await cw.service.consumer.handle(await deliveryOf(cw, await eventOf(cw, first.captureId, "capture.completed.v1"))), "APPLIED");
});
after(async () => { if (cw !== undefined) await cw.stop(); });

test("captureOf defaults accrue a repeat purchase under a database clock 5 ms behind Node", async () => {
  const setting = await cw.h.oracle.query<{ offset: string }>("SELECT current_setting('kauro_test.clock_offset_seconds') AS offset");
  assert.equal(setting.rows[0]!.offset, "-0.005");
  const plan = await approvedPlan(cw, selling, "clock-skew-repeat");
  const checkout = await checkoutOf(cw, selling, await fixtureQuote(cw, selling, plan));
  // Pin confirmation to the skewed server instant observed just before the provider reports completion.
  // This removes scheduler latency from the negative control: Date.now() is necessarily later than confirmation.
  const confirmedAt = await serverNow(cw.h.paymentPool.raw);
  const repeated = await captureOf(cw, selling, checkout, { confirmedAt });
  assert.equal(await cw.service.consumer.handle(await deliveryOf(cw, await eventOf(cw, repeated.captureId, "capture.completed.v1"))), "APPLIED");
  const lines = await linesOf(cw, repeated.authorizationId);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.state, "ACCRUED_PENDING", "the repeat capture must accrue without a PROVIDER_TIME_UNVERIFIED hold");
});

test("recordStepUp defaults permit a destination change under a database clock 5 ms behind Node", async () => {
  const seller = attribution.sellers[0]!;
  const client = await cw.h.pg.connect("kauro_app_test");
  try {
    // A transaction's clock remains at its start while assurance records the proof on its own connection.
    // This models the coarse-clock ordering deterministically, even when the runner pauses between statements.
    await client.query("BEGIN");
    await client.query("SELECT set_config('kauro.user_id', $1, true)", [seller.userId]);
    const proof = await cw.h.recordStepUp(seller.userId as UserId);
    await assert.doesNotReject(async () => {
      await client.query(
        `INSERT INTO kauro.seller_payout_destinations
         (destination_id, seller_id, destination_version, masked_label, destination_digest, currency,
          changed_by_user_id, change_proof_ref, changed_at, created_at, updated_at)
         VALUES ($1, $2, 2, 'Bank ****0002', $3, 'USD', $4, $5, kauro.server_now(), now(), now())`,
        [ids.next(), seller.sellerId, sha("clock-skew-destination-2"), seller.userId, proof],
      );
    }, "the seller's fresh default step-up must permit the destination change");
    await client.query("COMMIT");
    const destinations = await cw.h.oracle.query<{ n: number }>("SELECT count(*)::int AS n FROM kauro.seller_payout_destinations WHERE seller_id = $1 AND destination_version = 2", [seller.sellerId]);
    assert.equal(destinations.rows[0]!.n, 1);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
