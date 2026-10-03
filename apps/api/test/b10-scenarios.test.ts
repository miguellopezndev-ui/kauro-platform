// The worked examples of package B10 end to end (mandate B10-INTEGRATION; docs/design/B10-case-map.md rows citing this file; design §3,
// §5, §6, §7, §10, §14, §15; decisions D10-FIRST-1, D10-RATE-1, D10-ADJ-1, D10-ADJ-2, D10-ELIG-1, D10-ASSIGN-1, D10-TERM-1, D10-STMT-1,
// D10-PAY-1, D10-PAY-2, D10-NEG-1). One cluster, one api serving every route, the payment service, the commission service with its
// COMMISSIONS dispatcher and sweeps, and one set of labelled fakes (the provider, the buyer type, the preparation completion, the
// banking calendar and the payout evidence: CONTRACT_FAKE, SIMULATED), over PostgreSQL 17 through the runtime login roles; the superuser
// only reads. The scenarios run the application's own handlers as apps/api binds them — CreateQuote, CreatePaymentOrder,
// CapturePayment, the refund commands, AcceptAttribution, AssignAccount, TerminateSeller, CloseCommissionPeriod,
// ApproveCommissionPayout, ReconcileCommissionPayout and GetCommissionStatement — each answer checked against its route contract
// (test/integration-support.ts). The worked examples' hand-calculated integer cents are written here, never read back from the code
// under test, each beside a nearby valid control. Instants are the server's: a leg that stands at another instant stands there on the
// labelled TEST CLOCK (D10-CLOCK-1). Nothing sleeps: interleavings are held at named points and every wait is observed in
// pg_stat_activity. The founding cohort's three slots serve the whole cluster, so the three titles that take them run first.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { integrationWorld, type IntegrationWorld } from "./integration-support.js";

let iw: IntegrationWorld;
before(async () => {
  iw = await integrationWorld();
});
after(async () => {
  await iw.stop();
});

test("R2-079 (example 1): a founding agency's first HubSpot purchase of 50000 units, quoted by CreateQuote at 129500 - 32375 = 97125 and paid through CreatePaymentOrder and CapturePayment, accrues one 9713-cent ACCRUED_PENDING line for its accepted seller — not payable at capture, the 5275-cent fee recorded apart, the founding slot CONSUMED", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-080 (examples 2 and 6): the agency's second project, for another end client, is quoted at 123025 and accrues 4921 at 400 bps; RequestRefund, ApproveRefund and ExecuteRefund of 20000 service cents revise the line to 4121 with one -800 adjustment, and the owner's and the seller's statement projections show the same cents", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-092 (example 18): a paid agency replaces its source once before execution — CreateRevision, seal, a new approval and the replacement quote — and ExecuteProject's authority is the re-bound entitlement, the old one never reusable", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-093: the larger scope is charged only after the paid purchase is refunded and a new quote is issued and explicitly accepted by CreatePaymentOrder; no capture ever covers the difference silently", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-095 (example 12): after AssignAccount moves A's acquired agency to seller B, the agency's next purchase inside A's window accrues A's 400-bps line and no line for B; B's assistance agreement signed before a later order accrues B's own 400-bps pool beside A's, never reducing it", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-096 (example 5): with the agency's first purchase fully refunded, its next purchase inside the window accrues 400 bps, never 1000; the first designation, the window and the CONSUMED founding slot are unchanged and the first line is VOID at zero", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-097: AcceptAttribution freezing a 6000/4000 split of two sellers' claims makes the agency's first purchase accrue one 9713-cent pool with lines of 5828 and 3885 cents, never two 10% pools", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-098 (example 3): after the window the agency's next project is still quoted at its 500-bps recurrence discount, its capture accrues nothing for the seller, and the seller's earlier ELIGIBLE line is paid on the next statement", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-100: an enumerated opportunity's first purchase inside the tail converts its claim and creates the departed seller's entitlement; a first purchase after the tail's end or of an unlisted agency creates none", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-104 (examples 7 and 25): a 20000-cent service refund after the seller was paid 4921 posts -800, the line PAID to ADJUSTED, and the next statement shows the original accrual, the payout, the adjustment and the -800 balance with its project and reason; no port can debit the seller", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-137 (example 9): two projects' capture reconciliations of one agency held at the designation trigger in both interleavings end with one first project, one 1000-bps and one 400-bps pool and the same final statement projection", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("CMD050-RACE: TerminateSeller racing AcceptAttribution of the seller's unlisted claim, held at the seller row, serializes in both orders — acceptance first: the claim is ACCEPTED, then EXPIRED as unlisted by the termination; termination first: the claim is EXPIRED and AcceptAttribution is 409 CLAIM_NOT_REVIEWABLE — and no live claim of a terminated seller remains", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

