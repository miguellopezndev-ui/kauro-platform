/**
 * The B10 state oracle (docs/design/B10-KIT-SUITES.md section 2): invariants of the commission ledger that hold at ANY committed state and
 * are computed from base facts alone — immutable rows, or current rows together with the immutable rows that determine them. Every
 * predicate is independent SQL on the base tables: no product view, no product function (payoutCash, composeStatement, the eligibility
 * findings, the offset or balance triggers), no domain helper; the pool rounding and the largest-remainder split are re-implemented here
 * in integer SQL. An invariant holds when its query returns zero rows; each row it returns names the violating facts.
 *
 * History- and approval-time properties (cash coverage, funds or destination at approval, tail and residual legality, the eligibility
 * deadline, offset amount bounds, hold/line transition obligations beyond S-13) are NOT here: committed rows cannot reconstruct the instant
 * of a write or the commit order of uncommitted peers; the dedicated cells of section 2.3 prove them. There is no witness, no trigger and
 * no exemption API: a test whose committed state fires an invariant fails.
 *
 * The oracle reads as the superuser, READ COMMITTED, in a read-only transaction: one statement per invariant, each over its own snapshot
 * of committed rows (an invariant of any committed state holds in every snapshot).
 */
import assert from "node:assert/strict";
import { after, afterEach } from "node:test";
import type { Client } from "pg";

export interface Invariant {
  readonly id: `INV-${string}`;
  readonly decision: string;
  /**
   * The `why` text of each UNION ALL branch, in order (a branch is one condition of the invariant: the self-test forges a state for EACH and
   * requires its own text among the rows returned). Absent: the invariant is a single condition without a `why` column.
   */
  readonly whys?: ReadonlyArray<string>;
  readonly sql: string;
}

/** The pool cents of a basis at a rate: rounded half up once (floor((basis x bps + 5000) / 10000)), re-implemented here. */
const rounded = (basis: string, rate: string): string => `((${basis})::bigint * (${rate})::bigint + 5000) / 10000`;

/**
 * The beneficiaries' largest-remainder split of a total over a pool's lines (policy commission.splitRemainder
 * LARGEST_FRACTION_THEN_BENEFICIARY_ID_ASC): floor of total x share / sum of shares, then one cent each, in descending remainder and
 * ascending beneficiary id (code-point order), until the total is reached. `bases` selects (k, pool_id, total): one split per k.
 * Defines the CTEs split_in, split_fl and split (k, line_id, seller_id, share).
 */
const split = (bases: string): string => `
  split_in AS (
    SELECT b.k, l.line_id, l.seller_id, b.total::bigint AS total, l.share_bps::bigint AS w, (sum(l.share_bps) OVER (PARTITION BY b.k))::bigint AS ws
      FROM (${bases}) b JOIN kauro.commission_lines l ON l.pool_id = b.pool_id
  ),
  split_fl AS (
    SELECT k, line_id, seller_id, total, (total * w) / ws AS fl, (total * w) % ws AS rem FROM split_in
  ),
  split AS (
    SELECT k, line_id, seller_id,
           fl + CASE WHEN row_number() OVER (PARTITION BY k ORDER BY rem DESC, seller_id::text COLLATE "C") <= total - sum(fl) OVER (PARTITION BY k) THEN 1 ELSE 0 END AS share
      FROM split_fl
  )`;

/** Each line's AGREED_ERROR_CORRECTION decreases (only an UPHELD hold's reviewed decision posts one; there is no B10 writer). */
const CORRECTIONS = `SELECT line_id, sum(amount_cents) AS cents FROM kauro.commission_adjustments WHERE reason = 'AGREED_ERROR_CORRECTION' AND direction = 'DECREASE' GROUP BY line_id`;

export const B10_INVARIANTS: ReadonlyArray<Invariant> = Object.freeze([
  {
    id: "INV-L-01",
    decision: "double entry: every posting set balances in its currency (B09; mig 0017 ledger_entries_balanced)",
    sql: `SELECT e.event_id, e.currency, sum(e.amount_cents) FILTER (WHERE e.direction = 'DEBIT') AS debit, sum(e.amount_cents) FILTER (WHERE e.direction = 'CREDIT') AS credit
            FROM kauro.ledger_entries e
           GROUP BY e.event_id, e.currency
          HAVING coalesce(sum(e.amount_cents) FILTER (WHERE e.direction = 'DEBIT'), 0) <> coalesce(sum(e.amount_cents) FILTER (WHERE e.direction = 'CREDIT'), 0)`,
  },
  {
    id: "INV-L-02",
    whys: ["not a mirror","entry reversed more than once"],
    decision: "a reversal mirrors its entry (same account, currency, amount, the opposite direction) and an entry is reversed once (mig 0017)",
    sql: `SELECT r.entry_id, r.reverses_entry_id, 'not a mirror' AS why
            FROM kauro.ledger_entries r LEFT JOIN kauro.ledger_entries o ON o.entry_id = r.reverses_entry_id
           WHERE r.reverses_entry_id IS NOT NULL
             AND (o.entry_id IS NULL OR o.account_code <> r.account_code OR o.currency <> r.currency OR o.amount_cents <> r.amount_cents OR o.direction = r.direction)
          UNION ALL
          SELECT min(r.entry_id::text)::uuid, r.reverses_entry_id, 'entry reversed more than once'
            FROM kauro.ledger_entries r WHERE r.reverses_entry_id IS NOT NULL GROUP BY r.reverses_entry_id HAVING count(*) > 1`,
  },
  {
    id: "INV-S-01",
    whys: ["payable not derived","HOLD item of a line the statement does not itemize"],
    decision: "an item's payable is derived: cumulative - previously paid - held - same-statement HOLD items of its line - offset, never negative (D10-STMT-2, R2-102)",
    sql: `WITH w AS (
            SELECT hi.statement_id, h.line_id, sum(hi.held_cents) AS cents
              FROM kauro.statement_items hi JOIN kauro.commission_holds h ON h.hold_id = hi.hold_id
             WHERE hi.item_kind = 'HOLD' GROUP BY hi.statement_id, h.line_id
          ), d AS (
            SELECT i.statement_id, i.item_id, i.line_id, i.payable_cents,
                   coalesce(i.cumulative_cents, 0) - coalesce(i.previously_paid_cents, 0) - i.held_cents - coalesce(w.cents, 0) - i.offset_cents AS derived
              FROM kauro.statement_items i LEFT JOIN w ON w.statement_id = i.statement_id AND w.line_id = i.line_id
             WHERE i.item_kind = 'LINE' AND i.disposition = 'PAYABLE'
          )
          SELECT statement_id, item_id, line_id, payable_cents, derived, 'payable not derived' AS why FROM d WHERE payable_cents <> derived OR derived < 0
          UNION ALL
          SELECT hi.statement_id, hi.item_id, h.line_id, hi.held_cents, NULL, 'HOLD item of a line the statement does not itemize'
            FROM kauro.statement_items hi LEFT JOIN kauro.commission_holds h ON h.hold_id = hi.hold_id
           WHERE hi.item_kind = 'HOLD'
             AND NOT EXISTS (SELECT 1 FROM kauro.statement_items li WHERE li.statement_id = hi.statement_id AND li.item_kind = 'LINE' AND li.line_id = h.line_id)`,
  },
  {
    id: "INV-S-02",
    decision: "a statement's payable and held totals are the sums of its items' (D10-STMT-2)",
    sql: `SELECT s.statement_id, s.state, s.payable_cents, coalesce(sum(i.payable_cents), 0) AS items_payable, s.held_cents, coalesce(sum(i.held_cents), 0) AS items_held
            FROM kauro.commission_statements s LEFT JOIN kauro.statement_items i ON i.statement_id = s.statement_id
           GROUP BY s.statement_id
          HAVING s.payable_cents <> coalesce(sum(i.payable_cents), 0) OR s.held_cents <> coalesce(sum(i.held_cents), 0)`,
  },
  {
    id: "INV-S-03",
    decision: "an intent pays exactly its statement's payable (D10-PAY-1)",
    sql: `SELECT p.intent_id, p.statement_id, p.amount_cents, s.payable_cents
            FROM kauro.payout_intents p JOIN kauro.commission_statements s ON s.statement_id = p.statement_id
           WHERE p.amount_cents <> s.payable_cents`,
  },
  {
    id: "INV-S-04",
    decision: "one live intent per statement: AUTHORIZED, SUBMITTED, UNCERTAIN or SETTLED (D10-PAY-2)",
    sql: `SELECT p.statement_id, count(*) AS live, array_agg(p.intent_id ORDER BY p.intent_id) AS intents
            FROM kauro.payout_intents p WHERE p.state IN ('AUTHORIZED', 'SUBMITTED', 'UNCERTAIN', 'SETTLED')
           GROUP BY p.statement_id HAVING count(*) > 1`,
  },
  {
    id: "INV-S-05",
    whys: ["SETTLED intent of a statement not PAID","PAID statement without exactly one SETTLED intent","line paid cents not its paid items"],
    decision: "paid conservation: a settled intent's statement is PAID, a PAID statement has exactly one settled intent, a line's paid cents are its paid statements' payable items (SETTLE_PAR)",
    sql: `SELECT p.statement_id, p.intent_id AS ref, s.state AS detail, 'SETTLED intent of a statement not PAID' AS why
            FROM kauro.payout_intents p JOIN kauro.commission_statements s ON s.statement_id = p.statement_id
           WHERE p.state = 'SETTLED' AND s.state <> 'PAID'
          UNION ALL
          SELECT s.statement_id, NULL, (SELECT count(*) FROM kauro.payout_intents p WHERE p.statement_id = s.statement_id AND p.state = 'SETTLED')::text, 'PAID statement without exactly one SETTLED intent'
            FROM kauro.commission_statements s
           WHERE s.state = 'PAID' AND (SELECT count(*) FROM kauro.payout_intents p WHERE p.statement_id = s.statement_id AND p.state = 'SETTLED') <> 1
          UNION ALL
          SELECT NULL, l.line_id, coalesce(l.paid_cents, 0) || ' paid, ' || coalesce(x.cents, 0) || ' in paid statements', 'line paid cents not its paid items'
            FROM kauro.commission_lines l
            LEFT JOIN (SELECT i.line_id, sum(i.payable_cents) AS cents
                         FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id
                        WHERE i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND s.state = 'PAID' GROUP BY i.line_id) x ON x.line_id = l.line_id
           WHERE coalesce(l.paid_cents, 0) <> coalesce(x.cents, 0)`,
  },
  {
    id: "INV-S-06",
    decision: "a line is itemized PAYABLE in at most one statement not CORRECTED: never paid twice (KC019, mig 0039)",
    sql: `SELECT i.line_id, count(*) AS statements, array_agg(i.statement_id ORDER BY i.statement_id) AS statement_ids
            FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id
           WHERE i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND s.state <> 'CORRECTED'
           GROUP BY i.line_id HAVING count(*) > 1`,
  },
  {
    id: "INV-S-07",
    whys: ["OFFSET item not its offset","offset not under the negative line's signed future-offset terms","payable item offsets beyond the durable offsets against its line"],
    decision: "offsets: an OFFSET item reports its durable offset, an offset names the negative line's agreement with signed SIGNED_FUTURE_OFFSET terms, a payable item offsets at most the durable offsets against its line (D10-NEG-1, KC017)",
    sql: `SELECT i.item_id AS ref, i.offset_id AS other, i.offset_cents || ' reported, ' || o.amount_cents || ' durable' AS detail, 'OFFSET item not its offset' AS why
            FROM kauro.statement_items i JOIN kauro.commission_offsets o ON o.offset_id = i.offset_id
           WHERE i.item_kind = 'OFFSET' AND i.offset_cents <> o.amount_cents
          UNION ALL
          SELECT o.offset_id, o.agreement_id, coalesce(g.offset_terms, '(no agreement)') || ' signed ' || coalesce(g.signed_at::text, 'never'), 'offset not under the negative line''s signed future-offset terms'
            FROM kauro.commission_offsets o
            JOIN kauro.commission_lines l ON l.line_id = o.negative_line_id
            JOIN kauro.commission_entitlements e ON e.entitlement_id = l.entitlement_id
            LEFT JOIN kauro.seller_agreements g ON g.seller_id = o.seller_id AND g.agreement_id = o.agreement_id
           WHERE o.agreement_id <> e.agreement_id OR g.agreement_id IS NULL OR g.offset_terms <> 'SIGNED_FUTURE_OFFSET' OR g.signed_at IS NULL
          UNION ALL
          SELECT i.item_id, i.line_id, i.offset_cents || ' offset, ' || coalesce(x.cents, 0) || ' durable', 'payable item offsets beyond the durable offsets against its line'
            FROM kauro.statement_items i
            LEFT JOIN (SELECT against_line_id, sum(amount_cents) AS cents FROM kauro.commission_offsets GROUP BY against_line_id) x ON x.against_line_id = i.line_id
           WHERE i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND i.offset_cents > coalesce(x.cents, 0)`,
  },
  {
    id: "INV-S-08",
    whys: ["pool not rounded once","line not its share of the pool"],
    decision: "pool arithmetic: pool = basis x rate rounded once; each line = its largest-remainder share of the pool less its agreed corrections (D10-POOL-1, D10-ADJ-1)",
    sql: `WITH ${split(`SELECT p.pool_id AS k, p.pool_id, p.pool_cents AS total FROM kauro.commission_pools p`)}
          SELECT p.pool_id AS ref, p.basis_cents || ' x ' || p.rate_bps || ' bps' AS detail, p.pool_cents AS cents, ${rounded("p.basis_cents", "p.rate_bps")} AS expected, 'pool not rounded once' AS why
            FROM kauro.commission_pools p WHERE p.pool_cents <> ${rounded("p.basis_cents", "p.rate_bps")}
          UNION ALL
          SELECT l.line_id, 'pool ' || l.pool_id, l.cumulative_entitlement_cents, sp.share - coalesce(c.cents, 0), 'line not its share of the pool'
            FROM kauro.commission_lines l JOIN split sp ON sp.line_id = l.line_id LEFT JOIN (${CORRECTIONS}) c ON c.line_id = l.line_id
           WHERE l.cumulative_entitlement_cents <> sp.share - coalesce(c.cents, 0)`,
  },
  {
    id: "INV-S-09",
    whys: ["agreed correction that increases","agreed corrections beyond the upheld holds","refund or reversal not the split at its new basis","SPLIT_CORRECTION has no B10 writer"],
    decision: "corrections evidenced: an agreed correction only decreases and never beyond the line's UPHELD holds; a refund or reversal lands on the split at its new basis; no SPLIT_CORRECTION (D10-ADJ-1, R2-102)",
    sql: `WITH ${split(`SELECT a.adjustment_id AS k, l.pool_id, ${rounded("a.new_basis_cents", "p.rate_bps")} AS total
                        FROM kauro.commission_adjustments a JOIN kauro.commission_lines l ON l.line_id = a.line_id JOIN kauro.commission_pools p ON p.pool_id = l.pool_id
                       WHERE a.reason IN ('REFUND', 'REVERSAL')`)}
          SELECT a.adjustment_id AS ref, a.line_id AS line, a.reason || ' ' || a.direction AS detail, 'agreed correction that increases' AS why
            FROM kauro.commission_adjustments a WHERE a.reason = 'AGREED_ERROR_CORRECTION' AND a.direction = 'INCREASE'
          UNION ALL
          SELECT NULL, c.line_id, c.cents || ' corrected, ' || coalesce((SELECT sum(h.amount_cents) FROM kauro.commission_holds h WHERE h.line_id = c.line_id AND h.state = 'UPHELD'), 0) || ' upheld', 'agreed corrections beyond the upheld holds'
            FROM (${CORRECTIONS}) c
           WHERE c.cents > coalesce((SELECT sum(h.amount_cents) FROM kauro.commission_holds h WHERE h.line_id = c.line_id AND h.state = 'UPHELD'), 0)
          UNION ALL
          SELECT a.adjustment_id, a.line_id,
                 a.new_cumulative_entitlement_cents || ' posted, ' || (sp.share - coalesce((SELECT sum(c.amount_cents) FROM kauro.commission_adjustments c WHERE c.line_id = a.line_id AND c.reason = 'AGREED_ERROR_CORRECTION' AND c.direction = 'DECREASE' AND c.adjustment_seq < a.adjustment_seq), 0)) || ' split at basis ' || a.new_basis_cents,
                 'refund or reversal not the split at its new basis'
            FROM kauro.commission_adjustments a JOIN split sp ON sp.k = a.adjustment_id AND sp.line_id = a.line_id
           WHERE a.new_cumulative_entitlement_cents <> sp.share - coalesce((SELECT sum(c.amount_cents) FROM kauro.commission_adjustments c WHERE c.line_id = a.line_id AND c.reason = 'AGREED_ERROR_CORRECTION' AND c.direction = 'DECREASE' AND c.adjustment_seq < a.adjustment_seq), 0)
          UNION ALL
          SELECT a.adjustment_id, a.line_id, a.reason, 'SPLIT_CORRECTION has no B10 writer' FROM kauro.commission_adjustments a WHERE a.reason = 'SPLIT_CORRECTION'`,
  },
  {
    id: "INV-S-10",
    whys: ["first adjustment not from the initial split","adjustment not from the prior one's new cumulative","new cumulative not previous moved by the amount","last adjustment not the line's cumulative"],
    decision: "adjustment chain: seq 1 starts at the split of the pool's initial basis, each starts where the last ended, moves by its amount in its direction, and the last is the line's cumulative (mig 0030)",
    sql: `WITH ${split(`SELECT p.pool_id AS k, p.pool_id, ${rounded("p.initial_basis_cents", "p.rate_bps")} AS total FROM kauro.commission_pools p`)},
          chain AS (
            SELECT a.*, lag(a.new_cumulative_entitlement_cents) OVER (PARTITION BY a.line_id ORDER BY a.adjustment_seq) AS prior_new,
                   lag(a.adjustment_seq) OVER (PARTITION BY a.line_id ORDER BY a.adjustment_seq) AS prior_seq,
                   max(a.adjustment_seq) OVER (PARTITION BY a.line_id) AS last_seq
              FROM kauro.commission_adjustments a
          )
          SELECT ch.adjustment_id AS ref, ch.line_id AS line, ch.adjustment_seq AS seq, ch.previous_cumulative_cents || ' previous, ' || sp.share || ' initial split' AS detail, 'first adjustment not from the initial split' AS why
            FROM chain ch JOIN split sp ON sp.line_id = ch.line_id
           WHERE ch.adjustment_seq = 1 AND ch.previous_cumulative_cents <> sp.share
          UNION ALL
          SELECT ch.adjustment_id, ch.line_id, ch.adjustment_seq, ch.previous_cumulative_cents || ' previous, ' || ch.prior_new || ' prior new', 'adjustment not from the prior one''s new cumulative'
            FROM chain ch WHERE ch.prior_seq IS NOT NULL AND ch.previous_cumulative_cents <> ch.prior_new
          UNION ALL
          SELECT ch.adjustment_id, ch.line_id, ch.adjustment_seq, ch.previous_cumulative_cents || ' ' || ch.direction || ' ' || ch.amount_cents || ' -> ' || ch.new_cumulative_entitlement_cents, 'new cumulative not previous moved by the amount'
            FROM chain ch
           WHERE ch.new_cumulative_entitlement_cents <> ch.previous_cumulative_cents + CASE ch.direction WHEN 'INCREASE' THEN ch.amount_cents ELSE -ch.amount_cents END
          UNION ALL
          SELECT ch.adjustment_id, ch.line_id, ch.adjustment_seq, ch.new_cumulative_entitlement_cents || ' last new, ' || l.cumulative_entitlement_cents || ' line', 'last adjustment not the line''s cumulative'
            FROM chain ch JOIN kauro.commission_lines l ON l.line_id = ch.line_id
           WHERE ch.adjustment_seq = ch.last_seq AND ch.new_cumulative_entitlement_cents <> l.cumulative_entitlement_cents`,
  },
  {
    id: "INV-S-11",
    decision: "a frozen allocation's shares sum to exactly 10000 bps, whatever its claims' states (R2-05; mig 0029)",
    sql: `SELECT a.allocation_id, coalesce((SELECT sum(s.share_bps) FROM kauro.allocation_shares s WHERE s.allocation_id = a.allocation_id), 0) AS bps
            FROM kauro.attribution_allocations a
           WHERE a.frozen_at IS NOT NULL AND coalesce((SELECT sum(s.share_bps) FROM kauro.allocation_shares s WHERE s.allocation_id = a.allocation_id), 0) <> 10000`,
  },
  {
    id: "INV-S-12",
    whys: ["live reservations above the slots","live reservation not on exactly one slot of its agency","slot names a reservation that is not live in its agency"],
    decision: "founding capacity: live reservations within the policy's slots, each the live reservation of exactly one slot of its agency, and the reverse (R1 R12)",
    sql: `WITH live AS (SELECT * FROM kauro.founding_slot_reservations WHERE state IN ('RESERVED', 'RECONCILIATION_HOLD', 'CONSUMED'))
          SELECT v.policy_version AS ref, count(*)::text || ' live, ' || (SELECT count(*) FROM kauro.founding_slots f WHERE f.policy_version = v.policy_version) || ' slots' AS detail, 'live reservations above the slots' AS why
            FROM live v GROUP BY v.policy_version
          HAVING count(*) > (SELECT count(*) FROM kauro.founding_slots f WHERE f.policy_version = v.policy_version)
          UNION ALL
          SELECT v.reservation_id::text, (SELECT count(*) FROM kauro.founding_slots f WHERE f.live_reservation_id = v.reservation_id AND f.live_agency_id = v.agency_id AND f.policy_version = v.policy_version)::text || ' slots', 'live reservation not on exactly one slot of its agency'
            FROM live v
           WHERE (SELECT count(*) FROM kauro.founding_slots f WHERE f.live_reservation_id = v.reservation_id AND f.live_agency_id = v.agency_id AND f.policy_version = v.policy_version) <> 1
          UNION ALL
          SELECT f.policy_version || '#' || f.slot_no, f.live_reservation_id::text, 'slot names a reservation that is not live in its agency'
            FROM kauro.founding_slots f
           WHERE f.live_reservation_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM live v WHERE v.reservation_id = f.live_reservation_id AND v.agency_id = f.live_agency_id AND v.policy_version = f.policy_version)`,
  },
  {
    id: "INV-S-13",
    decision: "a HELD line has a hold row of some state (a RELEASED hold beside a still-HELD line is the legal interval before the ELIGIBLE unit; R3-02)",
    sql: `SELECT l.line_id, l.version FROM kauro.commission_lines l WHERE l.state = 'HELD' AND NOT EXISTS (SELECT 1 FROM kauro.commission_holds h WHERE h.line_id = l.line_id)`,
  },
  {
    id: "INV-S-14",
    whys: ["pool with no line","claim entitlement whose claim is not CONVERTED","CONVERTED claim without an entitlement","first qualifying purchase without the first designation naming its capture","agencies mirror neither NULL nor the first designation","paid purchase with two non-REVOKED authorizations","CORRECTED statement with an intent not FAILED or RETURNED","predecessor with two successors"],
    decision: "completeness of the pairs written in one unit: pool and lines, claim and entitlement, first designation, the agencies mirror, one live authorization per purchase, corrections (CONS_PAR, CONV_PAR, D10-FIRST-1, REPL_*, D10-GAP-7)",
    sql: `SELECT p.pool_id::text AS ref, NULL AS other, 'pool with no line' AS why
            FROM kauro.commission_pools p WHERE NOT EXISTS (SELECT 1 FROM kauro.commission_lines l WHERE l.pool_id = p.pool_id)
          UNION ALL
          SELECT e.entitlement_id::text, e.claim_id::text || ' ' || coalesce(c.state, '(none)'), 'claim entitlement whose claim is not CONVERTED'
            FROM kauro.commission_entitlements e LEFT JOIN kauro.attribution_claims c ON c.claim_id = e.claim_id
           WHERE e.claim_id IS NOT NULL AND c.state IS DISTINCT FROM 'CONVERTED'
          UNION ALL
          SELECT c.claim_id::text, NULL, 'CONVERTED claim without an entitlement'
            FROM kauro.attribution_claims c WHERE c.state = 'CONVERTED' AND NOT EXISTS (SELECT 1 FROM kauro.commission_entitlements e WHERE e.claim_id = c.claim_id)
          UNION ALL
          SELECT q.authorization_id::text, q.capture_id::text, 'first qualifying purchase without the first designation naming its capture'
            FROM kauro.qualifying_purchases q
           WHERE q.confirmation_seq = 1 AND NOT EXISTS (SELECT 1 FROM kauro.agency_recurrence r WHERE r.agency_id = q.agency_id AND r.first_capture_id = q.capture_id)
          UNION ALL
          SELECT a.agency_id::text, a.first_qualifying_capture_id::text || ' mirror, ' || coalesce(r.first_capture_id::text, '(no designation)'), 'agencies mirror neither NULL nor the first designation'
            FROM kauro.agencies a LEFT JOIN kauro.agency_recurrence r ON r.agency_id = a.agency_id
           WHERE a.first_qualifying_capture_id IS NOT NULL AND a.first_qualifying_capture_id IS DISTINCT FROM r.first_capture_id
          UNION ALL
          SELECT ca.capture_id::text, count(*)::text || ' live authorizations', 'paid purchase with two non-REVOKED authorizations'
            FROM kauro.commercial_authorizations ca WHERE ca.state <> 'REVOKED' GROUP BY ca.agency_id, ca.capture_id HAVING count(*) > 1
          UNION ALL
          SELECT s.statement_id::text, p.intent_id::text || ' ' || p.state, 'CORRECTED statement with an intent not FAILED or RETURNED'
            FROM kauro.commission_statements s JOIN kauro.payout_intents p ON p.statement_id = s.statement_id
           WHERE s.state = 'CORRECTED' AND p.state NOT IN ('FAILED', 'RETURNED')
          UNION ALL
          SELECT s.corrects_statement_id::text, count(*)::text || ' successors', 'predecessor with two successors'
            FROM kauro.commission_statements s WHERE s.corrects_statement_id IS NOT NULL GROUP BY s.corrects_statement_id HAVING count(*) > 1`,
  },
]);

/** The rows of one invariant on a session (LIMIT 5): zero rows when it holds. The self-test reads a forged state inside its own transaction. */
export async function invariantRows(session: Pick<Client, "query">, invariant: Invariant): Promise<ReadonlyArray<Record<string, unknown>>> {
  const r = await session.query(`SELECT * FROM (${invariant.sql}) violation LIMIT 5`);
  return r.rows as ReadonlyArray<Record<string, unknown>>;
}

/**
 * Every invariant on the superuser oracle, READ COMMITTED and read-only, each over its own snapshot of committed rows; fails with every
 * violating id, its decision and up to five rows. `label` names the test or cell it follows.
 */
export async function assertInvariants(oracle: Client, opts: { readonly label?: string } = {}): Promise<void> {
  const fired: string[] = [];
  await oracle.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
  try {
    for (const inv of B10_INVARIANTS) {
      const rows = await invariantRows(oracle, inv);
      if (rows.length > 0) fired.push(`${inv.id} (${inv.decision}):\n${rows.map((row) => "  " + JSON.stringify(row)).join("\n")}`);
    }
  } finally {
    await oracle.query("ROLLBACK");
  }
  assert.deepEqual(fired, [], `B10 state invariants violated${opts.label !== undefined ? ` after ${opts.label}` : ""}:\n${fired.join("\n")}`);
}

/** Where invariantsAfterEach registers its two hooks (node:test's, unless the self-test substitutes a recorder). */
export interface InvariantHooks {
  afterEach(hook: (t: { readonly name: string }) => Promise<void>): void;
  after(hook: () => Promise<void>): void;
}
const nodeHooks: InvariantHooks = { afterEach: (hook) => afterEach(hook as never), after: (hook) => after(hook) };

/**
 * One top-level line per B10 DB test file: the oracle after every test of the file (the client is read when the hook runs), and once more in
 * the file's after hook. A background effect (a sink, a consumer, a sweep item) that settles after the last test's afterEach ran would
 * otherwise never be judged. Call it BEFORE the file registers the after hook that closes its world: after hooks run in registration order,
 * so this one still has its oracle.
 */
export function invariantsAfterEach(oracle: () => Client, hooks: InvariantHooks = nodeHooks): void {
  hooks.afterEach(async (t) => {
    await assertInvariants(oracle(), { label: t.name });
  });
  hooks.after(async () => {
    await assertInvariants(oracle(), { label: "the end of the file (effects that settled after its last test)" });
  });
}
