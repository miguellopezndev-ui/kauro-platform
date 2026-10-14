// Lane PV1-SETTLE (ADV-2): the settlement money oracle. Zero-row queries over committed rows that must hold after EVERY DB cell of
// settlement-cells.test.ts and ach-dispatch-cells.test.ts, whatever fault the cell injected: the B10 kit oracle (invariantsAfterEach)
// plus the settlement invariants below. Each query returns the violating rows; branches are atomic (one predicate each).
import assert from "node:assert/strict";
import { after, afterEach } from "node:test";
import { invariantRows, invariantsAfterEach, type Invariant } from "@kauro/persistence/testing";
import { L } from "./inbound-lane-support.js";

const NET = "CASE e.direction WHEN 'DEBIT' THEN e.amount_cents ELSE -e.amount_cents END";
const SUM_OF = (account: string, direction: "CREDIT" | "DEBIT"): string =>
  `(SELECT coalesce(sum(e.amount_cents), 0) FROM kauro.ledger_entries e WHERE e.settlement_id = s.settlement_id AND e.account_code = '${account}' AND e.direction = '${direction}')`;
const REFUSAL_CASE = "c.kind = 'SETTLEMENT_REFUSED' AND c.source_kind = 'SETTLEMENT_REQUEST'";

export const SETTLEMENT_INVARIANTS: ReadonlyArray<Invariant> = Object.freeze([
  {
    id: "INV-SET-1",
    decision: "every settlement's posting set balances by itself (D-SET-6, D-LEDGER-B5)",
    sql: `SELECT e.settlement_id::text AS ref, sum(${NET})::text AS net FROM kauro.ledger_entries e JOIN kauro.settlements s ON s.settlement_id = e.settlement_id GROUP BY e.settlement_id HAVING sum(${NET}) <> 0`,
  },
  {
    id: "INV-SET-2",
    decision: "PSP_AVAILABLE of a payment route never goes below zero: no settlement of imaginary liquidity (D-SET-5, R2-085)",
    sql: `SELECT r.route_id::text AS ref, kauro.route_provider_available_cents(r.route_id, 'USD')::text AS available FROM (SELECT DISTINCT route_id FROM kauro.settlements) r WHERE kauro.route_provider_available_cents(r.route_id, 'USD') < 0`,
  },
  {
    id: "INV-SET-3",
    decision: "BANK_IN_TRANSIT of a payment route never goes below zero: a receipt clears at most what the withdrawal put in transit (D-SET-6)",
    sql: `SELECT s.route_id::text AS ref, sum(${NET})::text AS in_transit FROM kauro.ledger_entries e JOIN kauro.settlements s ON s.settlement_id = e.settlement_id WHERE e.account_code = 'BANK_IN_TRANSIT' GROUP BY s.route_id HAVING sum(${NET}) < 0`,
  },
  {
    id: "INV-SET-4",
    whys: ["an APPLIED intent without a settlement", "an APPLIED intent with several settlements", "a settlement of an intent that is not APPLIED", "an APPLIED intent naming another settlement than the one citing it"],
    decision: "an intent is APPLIED if and only if exactly one settlement cites it, and the intent names that settlement (D-SET-10 A8)",
    sql: `SELECT r.request_id::text AS ref, NULL AS other, 'an APPLIED intent without a settlement' AS why
            FROM kauro.settlement_requests r WHERE r.outcome = 'APPLIED' AND NOT EXISTS (SELECT 1 FROM kauro.settlements s WHERE s.request_id = r.request_id)
          UNION ALL
          SELECT r.request_id::text, count(*)::text, 'an APPLIED intent with several settlements'
            FROM kauro.settlement_requests r JOIN kauro.settlements s ON s.request_id = r.request_id WHERE r.outcome = 'APPLIED' GROUP BY r.request_id HAVING count(*) > 1
          UNION ALL
          SELECT s.settlement_id::text, s.request_id::text, 'a settlement of an intent that is not APPLIED'
            FROM kauro.settlements s WHERE s.request_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM kauro.settlement_requests r WHERE r.request_id = s.request_id AND r.outcome = 'APPLIED')
          UNION ALL
          SELECT r.request_id::text, s.settlement_id::text, 'an APPLIED intent naming another settlement than the one citing it'
            FROM kauro.settlement_requests r JOIN kauro.settlements s ON s.request_id = r.request_id WHERE r.outcome = 'APPLIED' AND r.settlement_id <> s.settlement_id`,
  },
  {
    id: "INV-SET-5",
    whys: ["a REFUSED intent without its case", "a REFUSED intent with several cases", "a SETTLEMENT_REFUSED case whose intent is not REFUSED"],
    decision: "an intent is REFUSED if and only if one SETTLEMENT_REFUSED case cites it (R2 15:153, 15:57)",
    sql: `SELECT r.request_id::text AS ref, NULL AS other, 'a REFUSED intent without its case' AS why
            FROM kauro.settlement_requests r WHERE r.outcome = 'REFUSED' AND NOT EXISTS (SELECT 1 FROM kauro.bank_review_cases c WHERE ${REFUSAL_CASE} AND c.source_id = r.request_id)
          UNION ALL
          SELECT r.request_id::text, count(*)::text, 'a REFUSED intent with several cases'
            FROM kauro.settlement_requests r JOIN kauro.bank_review_cases c ON ${REFUSAL_CASE} AND c.source_id = r.request_id WHERE r.outcome = 'REFUSED' GROUP BY r.request_id HAVING count(*) > 1
          UNION ALL
          SELECT c.case_id::text, c.source_id::text, 'a SETTLEMENT_REFUSED case whose intent is not REFUSED'
            FROM kauro.bank_review_cases c WHERE ${REFUSAL_CASE} AND NOT EXISTS (SELECT 1 FROM kauro.settlement_requests r WHERE r.request_id = c.source_id AND r.outcome = 'REFUSED')`,
  },
  {
    id: "INV-SET-6",
    whys: ["a settlement that received more than it withdrew", "an intent that received more than it withdrew"],
    decision: "received <= withdrawn on every settlement and every intent (R2-085; the CHECKs of 0071)",
    sql: `SELECT s.settlement_id::text AS ref, NULL AS other, 'a settlement that received more than it withdrew' AS why FROM kauro.settlements s WHERE s.received_cents > s.withdrawn_cents
          UNION ALL
          SELECT r.request_id::text, NULL, 'an intent that received more than it withdrew' FROM kauro.settlement_requests r WHERE r.received_cents > r.withdrawn_cents`,
  },
  {
    id: "INV-SET-7",
    whys: ["PSP_AVAILABLE credited other than withdrawn + fee", "BANK_CASH debited other than the received figure"],
    decision: "the lines of a bank settlement equal its figures: the release and the fee leave PSP_AVAILABLE, only the receipt makes BANK_CASH (D-SET-6)",
    sql: `SELECT s.settlement_id::text AS ref, ${SUM_OF("PSP_AVAILABLE", "CREDIT")}::text AS posted, 'PSP_AVAILABLE credited other than withdrawn + fee' AS why
            FROM kauro.settlements s WHERE s.withdrawal_id IS NOT NULL AND ${SUM_OF("PSP_AVAILABLE", "CREDIT")} <> s.withdrawn_cents + s.fee_cents
          UNION ALL
          SELECT s.settlement_id::text, ${SUM_OF("BANK_CASH", "DEBIT")}::text, 'BANK_CASH debited other than the received figure'
            FROM kauro.settlements s WHERE s.withdrawal_id IS NOT NULL AND ${SUM_OF("BANK_CASH", "DEBIT")} <> coalesce(s.received_cents, 0)`,
  },
]);

type Oracle = Parameters<typeof invariantRows>[0] & { query: (sql: string) => Promise<unknown> };

/** The lane oracle on the superuser session: READ COMMITTED, read-only; fails with every violating row. */
export async function assertSettlementInvariants(oracle: Oracle, label: string): Promise<void> {
  const fired: string[] = [];
  await oracle.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
  try {
    for (const inv of SETTLEMENT_INVARIANTS) {
      const rows = await invariantRows(oracle, inv);
      if (rows.length > 0) fired.push(`${inv.id} (${inv.decision}):\n${rows.map((row) => "  " + JSON.stringify(row)).join("\n")}`);
    }
  } finally {
    await oracle.query("ROLLBACK");
  }
  assert.deepEqual(fired, [], `settlement money invariants violated after ${label}:\n${fired.join("\n")}`);
}

/**
 * One top-level line per DB test file of the lane. After every cell (and once more when the file ends) the B10 kit oracle and the
 * settlement oracle run on the superuser session. Call it BEFORE the file registers the after hook that stops its world.
 */
export function settlementOracleAfterEach(): void {
  invariantsAfterEach(() => L().iw.h.oracle);
  afterEach(async (t) => {
    await assertSettlementInvariants(L().iw.h.oracle, t.name);
  });
  after(async () => {
    await assertSettlementInvariants(L().iw.h.oracle, "the end of the file (effects that settled after its last test)");
  });
}
