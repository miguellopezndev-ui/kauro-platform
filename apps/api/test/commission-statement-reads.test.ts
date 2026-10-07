// GetCommissionStatement — GET /api/v1/sales/statements/{statementId} — the statement's seller or KAURO_OWNER — scope CORPORATE (package B10,
// mandate B10-STATEMENTS-PAYOUTS; docs/design/B10-case-map.md CMD051-OK; design §13; decision D10-API-1; owner manual 17 "Statements reveal
// each project and adjustment without exposing customer CRM data"; example 25). The real route under its closed response schema (the send
// guard refuses any other reply), the commercial authorizer and PostgreSQL 17 through the runtime login roles: the seller's own session reads
// only its own statement and items (0031), so another seller's statement answers as an id nobody holds. The superuser only reads.
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CommissionStatementView, PeriodCloseView } from "@kauro/application";
import { recordHold } from "@kauro/persistence/testing";
import type { UserId } from "@kauro/domain";
import { approvedRefund } from "./commission-support.js";
import { closeMonth, eligibleLines, readStatement, seller, statementsOfSeller, statementsWorld, type StatementsWorld } from "./statements-support.js";
import { completed, ids, outcome, type Reply } from "./support.js";

let sw: StatementsWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => sw.h.oracle);
before(async () => {
  sw = await statementsWorld();
});
after(async () => {
  await sw.stop();
});

const read = (reply: Reply): CommissionStatementView => {
  assert.equal(reply.status, 200, reply.text);
  const body = reply.json<{ readonly kind: string; readonly data: CommissionStatementView }>();
  assert.equal(body.kind, "READ");
  return body.data;
};

test("GetCommissionStatement answers a seller its own statement and the owner any — per line the agency and project reference, first or repeat, basis, rate, share, cumulative, previously paid, adjustment, hold reason and review date — and never another seller's rows, a destination digest, contact details or customer CRM values", async () => {
  const WHOLE = { firstBps: 10_000, repeatBps: 400 } as const;
  const s = await seller(sw, "reads-seller", { firstBps: 10_000, repeatBps: 400 });
  const other = await seller(sw, "reads-other", { firstBps: 10_000, repeatBps: 400 });
  // the seller's first purchase (FIRST, 100%) partially disputed, and a repeat at 400 bps
  const sold = await eligibleLines(sw, "Reads agency", s, WHOLE, [{ basisCents: 60_000n, poolCents: 60_000n }, { basisCents: 50_000n, poolCents: 2_000n }]);
  const [first, repeat] = sold.lines as [(typeof sold.lines)[number], (typeof sold.lines)[number]];
  const hold = await recordHold(sw.h, { ownerUserId: sw.owner.userId as UserId, lineId: first.lineId, amountCents: 1_500n, reason: "SELLER_DISPUTE", reviewInHours: 10 * 24 });
  await eligibleLines(sw, "Reads other agency", other, WHOLE, [{ basisCents: 9_000n, poolCents: 9_000n }]);
  // a refund requested by the agency (its CRM-facing reason never reaches a statement)
  await approvedRefund(sw, sold.selling, first.purchase, { serviceCents: 1_000n });

  const { periodId, reply } = await closeMonth(sw, "2026-09");
  completed<PeriodCloseView>(reply, 200);
  const [mine] = await statementsOfSeller(sw, s.sellerId);
  const [theirs] = await statementsOfSeller(sw, other.sellerId);
  assert.ok(mine !== undefined && theirs !== undefined);

  // the seller reads its own statement, line by line
  const view = read(await readStatement(sw, mine.statement_id, s.person.token));
  assert.deepEqual(
    [view.statementId, view.sellerId, view.periodId, view.state, view.payableCents, view.heldCents, view.payDueOn, view.simulated, view.calendarVersion],
    [mine.statement_id, s.sellerId, periodId, "ISSUED", "60500", "1500", "2026-10-15", true, "test-fixture-2026-2030"],
  );
  assert.deepEqual(view.lineIds, [first.lineId, repeat.lineId]);
  const reviewOn = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(hold.reviewAt));
  assert.deepEqual(
    view.items.map((i) => ({ ...i })),
    [
      { lineId: first.lineId, agencyId: sold.selling.agency.agencyId, projectId: first.purchase.projectId, sequence: "FIRST", netServiceBasisCents: "60000", rateBps: 10_000, shareBps: 10_000, cumulativeEntitlementCents: "60000", previouslyPaidCents: "0", adjustmentCents: "0", heldCents: "0", payableCents: "58500" },
      { lineId: first.lineId, agencyId: sold.selling.agency.agencyId, projectId: first.purchase.projectId, sequence: "FIRST", netServiceBasisCents: "60000", rateBps: 10_000, shareBps: 10_000, cumulativeEntitlementCents: "60000", previouslyPaidCents: "0", adjustmentCents: "0", heldCents: "1500", holdReason: "SELLER_DISPUTE", holdReviewOn: reviewOn, payableCents: "0" },
      { lineId: repeat.lineId, agencyId: sold.selling.agency.agencyId, projectId: repeat.purchase.projectId, sequence: "REPEAT", netServiceBasisCents: "50000", rateBps: 400, shareBps: 10_000, cumulativeEntitlementCents: "2000", previouslyPaidCents: "0", adjustmentCents: "0", heldCents: "0", payableCents: "2000" },
    ],
  );
  assert.deepEqual(view.balanceItems, []);

  // the owner reads any statement, the same projection
  const owners = read(await readStatement(sw, mine.statement_id, sw.owner.token));
  assert.deepEqual(owners, view);
  assert.equal(read(await readStatement(sw, theirs.statement_id, sw.owner.token)).sellerId, other.sellerId);

  // another seller's statement is nobody's to this seller: 404 exactly like an id nobody holds
  assert.equal(outcome(sw.w, await readStatement(sw, theirs.statement_id, s.person.token)), "404 NOT_FOUND -");
  assert.equal(outcome(sw.w, await readStatement(sw, ids.next(), s.person.token)), "404 NOT_FOUND -");
  // an agency member is neither a seller nor the owner
  assert.equal(outcome(sw.w, await readStatement(sw, mine.statement_id, sw.w.owner.token)), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");

  // never a destination digest, contact details or a customer's CRM values
  const text = JSON.stringify(view);
  for (const secret of [s.destinationDigest, other.destinationDigest, "Operations lead", "Head of operations", "The client cancelled before execution", "Bank ****"]) assert.ok(!text.includes(secret), `the view carries no ${secret}`);
  for (const member of ["destinationDigest", "destinationId", "contact", "email", "maskedLabel", "clientId", "organizationLabel"]) assert.ok(!(member in view), `no ${member} member`);
});
