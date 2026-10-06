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
   * The `why` text of each UNION ALL branch, in order. A branch is ONE atomic predicate of the invariant (a conjunction of the facts that
   * select its rows, never a disjunction: no OR, no `<> 1` over a count, which is "none" or "several", no IS DISTINCT FROM over a nullable
   * side, which is "absent" or "different"; no COALESCE, IFNULL, NULLIF or CASE WHEN ... IS NULL anywhere in it, which hide an "absent"
   * case inside a comparison: the absent case is its own branch, NOT EXISTS or a NULL test, with its own why and control) and the
   * self-test forges a state for EACH that fires that predicate alone among the invariant's
   * branches, unless it declares the others the same state must also fire. Absent: the invariant is a single atomic predicate without a
   * `why` column.
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
    whys: ["debits and credits differ", "debits with no credit", "credits with no debit"],
    decision: "double entry: every posting set balances in its currency (B09; mig 0017 ledger_entries_balanced)",
    sql: `SELECT e.event_id, e.currency, sum(e.amount_cents) FILTER (WHERE e.direction = 'DEBIT') AS debit, sum(e.amount_cents) FILTER (WHERE e.direction = 'CREDIT') AS credit, 'debits and credits differ' AS why
            FROM kauro.ledger_entries e
           GROUP BY e.event_id, e.currency
          HAVING sum(e.amount_cents) FILTER (WHERE e.direction = 'DEBIT') <> sum(e.amount_cents) FILTER (WHERE e.direction = 'CREDIT')
          UNION ALL
          SELECT e.event_id, e.currency, sum(e.amount_cents), NULL, 'debits with no credit'
            FROM kauro.ledger_entries e
           GROUP BY e.event_id, e.currency
          HAVING count(*) FILTER (WHERE e.direction = 'CREDIT') = 0 AND sum(e.amount_cents) <> 0
          UNION ALL
          SELECT e.event_id, e.currency, NULL, sum(e.amount_cents), 'credits with no debit'
            FROM kauro.ledger_entries e
           GROUP BY e.event_id, e.currency
          HAVING count(*) FILTER (WHERE e.direction = 'DEBIT') = 0 AND sum(e.amount_cents) <> 0`,
  },
  {
    id: "INV-L-02",
    whys: ["reversal of no entry", "reversal on another account", "reversal in another currency", "reversal of another amount", "reversal in the same direction", "entry reversed more than once"],
    decision: "a reversal mirrors its entry (same account, currency, amount, the opposite direction) and an entry is reversed once (mig 0017)",
    sql: `SELECT r.entry_id, r.reverses_entry_id, 'reversal of no entry' AS why
            FROM kauro.ledger_entries r
           WHERE r.reverses_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM kauro.ledger_entries o WHERE o.entry_id = r.reverses_entry_id)
          UNION ALL
          SELECT r.entry_id, r.reverses_entry_id, 'reversal on another account'
            FROM kauro.ledger_entries r JOIN kauro.ledger_entries o ON o.entry_id = r.reverses_entry_id WHERE o.account_code <> r.account_code
          UNION ALL
          SELECT r.entry_id, r.reverses_entry_id, 'reversal in another currency'
            FROM kauro.ledger_entries r JOIN kauro.ledger_entries o ON o.entry_id = r.reverses_entry_id WHERE o.currency <> r.currency
          UNION ALL
          SELECT r.entry_id, r.reverses_entry_id, 'reversal of another amount'
            FROM kauro.ledger_entries r JOIN kauro.ledger_entries o ON o.entry_id = r.reverses_entry_id WHERE o.amount_cents <> r.amount_cents
          UNION ALL
          SELECT r.entry_id, r.reverses_entry_id, 'reversal in the same direction'
            FROM kauro.ledger_entries r JOIN kauro.ledger_entries o ON o.entry_id = r.reverses_entry_id WHERE o.direction = r.direction
          UNION ALL
          SELECT min(r.entry_id::text)::uuid, r.reverses_entry_id, 'entry reversed more than once'
            FROM kauro.ledger_entries r WHERE r.reverses_entry_id IS NOT NULL GROUP BY r.reverses_entry_id HAVING count(*) > 1`,
  },
  {
    id: "INV-S-01",
    whys: [
      "payable not derived (its line has HOLD items)",
      "payable not derived (its line has no HOLD item)",
      "derived payable negative (its line has HOLD items)",
      "derived payable negative (its line has no HOLD item)",
      "PAYABLE line item without a cumulative",
      "PAYABLE line item without its previously paid",
      "HOLD item of a line the statement does not itemize",
      "HOLD item with no hold row",
    ],
    decision: "an item's payable is derived: cumulative - previously paid - held - same-statement HOLD items of its line - offset, never negative; a PAYABLE line item carries its cumulative and previously paid (D10-STMT-2, R2-102)",
    sql: `WITH w AS (
            SELECT hi.statement_id, h.line_id, sum(hi.held_cents) AS cents
              FROM kauro.statement_items hi JOIN kauro.commission_holds h ON h.hold_id = hi.hold_id
             WHERE hi.item_kind = 'HOLD' GROUP BY hi.statement_id, h.line_id
          ), d AS (
            SELECT i.statement_id, i.item_id, i.line_id, i.payable_cents, i.cumulative_cents - i.previously_paid_cents - i.held_cents - i.offset_cents AS base
              FROM kauro.statement_items i
             WHERE i.item_kind = 'LINE' AND i.disposition = 'PAYABLE'
          )
          SELECT d.statement_id, d.item_id, d.line_id, d.payable_cents, d.base - w.cents AS derived, 'payable not derived (its line has HOLD items)' AS why
            FROM d JOIN w ON w.statement_id = d.statement_id AND w.line_id = d.line_id
           WHERE d.payable_cents <> d.base - w.cents
          UNION ALL
          SELECT d.statement_id, d.item_id, d.line_id, d.payable_cents, d.base, 'payable not derived (its line has no HOLD item)'
            FROM d
           WHERE NOT EXISTS (SELECT 1 FROM w WHERE w.statement_id = d.statement_id AND w.line_id = d.line_id) AND d.payable_cents <> d.base
          UNION ALL
          SELECT d.statement_id, d.item_id, d.line_id, d.payable_cents, d.base - w.cents, 'derived payable negative (its line has HOLD items)'
            FROM d JOIN w ON w.statement_id = d.statement_id AND w.line_id = d.line_id
           WHERE d.base - w.cents < 0
          UNION ALL
          SELECT d.statement_id, d.item_id, d.line_id, d.payable_cents, d.base, 'derived payable negative (its line has no HOLD item)'
            FROM d
           WHERE NOT EXISTS (SELECT 1 FROM w WHERE w.statement_id = d.statement_id AND w.line_id = d.line_id) AND d.base < 0
          UNION ALL
          SELECT i.statement_id, i.item_id, i.line_id, i.payable_cents, NULL, 'PAYABLE line item without a cumulative'
            FROM kauro.statement_items i
           WHERE i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND i.cumulative_cents IS NULL
          UNION ALL
          SELECT i.statement_id, i.item_id, i.line_id, i.payable_cents, NULL, 'PAYABLE line item without its previously paid'
            FROM kauro.statement_items i
           WHERE i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND i.previously_paid_cents IS NULL
          UNION ALL
          SELECT hi.statement_id, hi.item_id, h.line_id, hi.held_cents, NULL, 'HOLD item of a line the statement does not itemize'
            FROM kauro.statement_items hi JOIN kauro.commission_holds h ON h.hold_id = hi.hold_id
           WHERE hi.item_kind = 'HOLD'
             AND NOT EXISTS (SELECT 1 FROM kauro.statement_items li WHERE li.statement_id = hi.statement_id AND li.item_kind = 'LINE' AND li.line_id = h.line_id)
          UNION ALL
          SELECT hi.statement_id, hi.item_id, NULL, hi.held_cents, NULL, 'HOLD item with no hold row'
            FROM kauro.statement_items hi
           WHERE hi.item_kind = 'HOLD' AND NOT EXISTS (SELECT 1 FROM kauro.commission_holds h WHERE h.hold_id = hi.hold_id)`,
  },
  {
    id: "INV-S-02",
    whys: ["payable total not its items' sum", "payable total of a statement with no item", "held total not its items' sum", "held total of a statement with no item"],
    decision: "a statement's payable and held totals are the sums of its items' (zero when it has none) (D10-STMT-2)",
    sql: `SELECT s.statement_id, s.state, s.payable_cents AS cents, sum(i.payable_cents) AS items, 'payable total not its items'' sum' AS why
            FROM kauro.commission_statements s JOIN kauro.statement_items i ON i.statement_id = s.statement_id
           GROUP BY s.statement_id
          HAVING s.payable_cents <> sum(i.payable_cents)
          UNION ALL
          SELECT s.statement_id, s.state, s.payable_cents, NULL, 'payable total of a statement with no item'
            FROM kauro.commission_statements s
           WHERE NOT EXISTS (SELECT 1 FROM kauro.statement_items i WHERE i.statement_id = s.statement_id) AND s.payable_cents <> 0
          UNION ALL
          SELECT s.statement_id, s.state, s.held_cents, sum(i.held_cents), 'held total not its items'' sum'
            FROM kauro.commission_statements s JOIN kauro.statement_items i ON i.statement_id = s.statement_id
           GROUP BY s.statement_id
          HAVING s.held_cents <> sum(i.held_cents)
          UNION ALL
          SELECT s.statement_id, s.state, s.held_cents, NULL, 'held total of a statement with no item'
            FROM kauro.commission_statements s
           WHERE NOT EXISTS (SELECT 1 FROM kauro.statement_items i WHERE i.statement_id = s.statement_id) AND s.held_cents <> 0`,
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
    whys: [
      "SETTLED intent of a statement not PAID",
      "PAID statement without a SETTLED intent",
      "PAID statement with several SETTLED intents",
      "line paid cents not its paid items",
      "line paid with no paid item",
      "line never paid with paid items",
    ],
    decision: "paid conservation: a settled intent's statement is PAID, a PAID statement has exactly one settled intent, a line's paid cents are its paid statements' payable items (none: never paid or zero) (SETTLE_PAR)",
    sql: `WITH x AS (
            SELECT i.line_id, sum(i.payable_cents) AS cents
              FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id
             WHERE i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND s.state = 'PAID' GROUP BY i.line_id
          )
          SELECT p.statement_id, p.intent_id AS ref, s.state AS detail, 'SETTLED intent of a statement not PAID' AS why
            FROM kauro.payout_intents p JOIN kauro.commission_statements s ON s.statement_id = p.statement_id
           WHERE p.state = 'SETTLED' AND s.state <> 'PAID'
          UNION ALL
          SELECT s.statement_id, NULL, '0', 'PAID statement without a SETTLED intent'
            FROM kauro.commission_statements s
           WHERE s.state = 'PAID' AND NOT EXISTS (SELECT 1 FROM kauro.payout_intents p WHERE p.statement_id = s.statement_id AND p.state = 'SETTLED')
          UNION ALL
          SELECT s.statement_id, NULL, (SELECT count(*) FROM kauro.payout_intents p WHERE p.statement_id = s.statement_id AND p.state = 'SETTLED')::text, 'PAID statement with several SETTLED intents'
            FROM kauro.commission_statements s
           WHERE s.state = 'PAID' AND (SELECT count(*) FROM kauro.payout_intents p WHERE p.statement_id = s.statement_id AND p.state = 'SETTLED') > 1
          UNION ALL
          SELECT NULL, l.line_id, l.paid_cents || ' paid, ' || x.cents || ' in paid statements', 'line paid cents not its paid items'
            FROM kauro.commission_lines l JOIN x ON x.line_id = l.line_id
           WHERE l.paid_cents <> x.cents
          UNION ALL
          SELECT NULL, l.line_id, l.paid_cents || ' paid, no paid item', 'line paid with no paid item'
            FROM kauro.commission_lines l
           WHERE l.paid_cents <> 0 AND NOT EXISTS (SELECT 1 FROM x WHERE x.line_id = l.line_id)
          UNION ALL
          SELECT NULL, l.line_id, 'never paid, ' || x.cents || ' in paid statements', 'line never paid with paid items'
            FROM kauro.commission_lines l JOIN x ON x.line_id = l.line_id
           WHERE l.paid_cents IS NULL AND x.cents <> 0`,
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
    whys: [
      "OFFSET item not its offset",
      "offset under another agreement than its negative line's",
      "offset agreement absent for its seller",
      "offset agreement terms not SIGNED_FUTURE_OFFSET",
      "offset agreement never signed",
      "payable item offsets beyond the durable offsets against its line",
      "payable item offsets a line no offset is against",
    ],
    decision: "offsets: an OFFSET item reports its durable offset, an offset names the negative line's agreement with signed SIGNED_FUTURE_OFFSET terms, a payable item offsets at most the durable offsets against its line (D10-NEG-1, KC017)",
    sql: `SELECT i.item_id AS ref, i.offset_id AS other, i.offset_cents || ' reported, ' || o.amount_cents || ' durable' AS detail, 'OFFSET item not its offset' AS why
            FROM kauro.statement_items i JOIN kauro.commission_offsets o ON o.offset_id = i.offset_id
           WHERE i.item_kind = 'OFFSET' AND i.offset_cents <> o.amount_cents
          UNION ALL
          SELECT o.offset_id, o.agreement_id, 'entitlement under ' || e.agreement_id, 'offset under another agreement than its negative line''s'
            FROM kauro.commission_offsets o
            JOIN kauro.commission_lines l ON l.line_id = o.negative_line_id
            JOIN kauro.commission_entitlements e ON e.entitlement_id = l.entitlement_id
           WHERE o.agreement_id <> e.agreement_id
          UNION ALL
          SELECT o.offset_id, o.agreement_id, '(no agreement)', 'offset agreement absent for its seller'
            FROM kauro.commission_offsets o
           WHERE NOT EXISTS (SELECT 1 FROM kauro.seller_agreements g WHERE g.seller_id = o.seller_id AND g.agreement_id = o.agreement_id)
          UNION ALL
          SELECT o.offset_id, o.agreement_id, g.offset_terms, 'offset agreement terms not SIGNED_FUTURE_OFFSET'
            FROM kauro.commission_offsets o JOIN kauro.seller_agreements g ON g.seller_id = o.seller_id AND g.agreement_id = o.agreement_id
           WHERE g.offset_terms <> 'SIGNED_FUTURE_OFFSET'
          UNION ALL
          SELECT o.offset_id, o.agreement_id, 'never signed', 'offset agreement never signed'
            FROM kauro.commission_offsets o JOIN kauro.seller_agreements g ON g.seller_id = o.seller_id AND g.agreement_id = o.agreement_id
           WHERE g.signed_at IS NULL
          UNION ALL
          SELECT i.item_id, i.line_id, i.offset_cents || ' offset, ' || x.cents || ' durable', 'payable item offsets beyond the durable offsets against its line'
            FROM kauro.statement_items i
            JOIN (SELECT against_line_id, sum(amount_cents) AS cents FROM kauro.commission_offsets GROUP BY against_line_id) x ON x.against_line_id = i.line_id
           WHERE i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND i.offset_cents > x.cents
          UNION ALL
          SELECT i.item_id, i.line_id, i.offset_cents || ' offset, no durable offset', 'payable item offsets a line no offset is against'
            FROM kauro.statement_items i
           WHERE i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND i.offset_cents > 0
             AND NOT EXISTS (SELECT 1 FROM kauro.commission_offsets o WHERE o.against_line_id = i.line_id)`,
  },
  {
    id: "INV-S-08",
    whys: ["pool not rounded once", "line not its share of the pool (no agreed correction)", "line not its share of the pool less its agreed corrections"],
    decision: "pool arithmetic: pool = basis x rate rounded once; each line = its largest-remainder share of the pool less its agreed corrections (D10-POOL-1, D10-ADJ-1)",
    sql: `WITH ${split(`SELECT p.pool_id AS k, p.pool_id, p.pool_cents AS total FROM kauro.commission_pools p`)}
          SELECT p.pool_id AS ref, p.basis_cents || ' x ' || p.rate_bps || ' bps' AS detail, p.pool_cents AS cents, ${rounded("p.basis_cents", "p.rate_bps")} AS expected, 'pool not rounded once' AS why
            FROM kauro.commission_pools p WHERE p.pool_cents <> ${rounded("p.basis_cents", "p.rate_bps")}
          UNION ALL
          SELECT l.line_id, 'pool ' || l.pool_id, l.cumulative_entitlement_cents, sp.share, 'line not its share of the pool (no agreed correction)'
            FROM kauro.commission_lines l JOIN split sp ON sp.line_id = l.line_id
           WHERE NOT EXISTS (SELECT 1 FROM (${CORRECTIONS}) c WHERE c.line_id = l.line_id) AND l.cumulative_entitlement_cents <> sp.share
          UNION ALL
          SELECT l.line_id, 'pool ' || l.pool_id, l.cumulative_entitlement_cents, sp.share - c.cents, 'line not its share of the pool less its agreed corrections'
            FROM kauro.commission_lines l JOIN split sp ON sp.line_id = l.line_id JOIN (${CORRECTIONS}) c ON c.line_id = l.line_id
           WHERE l.cumulative_entitlement_cents <> sp.share - c.cents`,
  },
  {
    id: "INV-S-09",
    whys: [
      "agreed correction that increases",
      "agreed corrections on a line with no upheld hold",
      "agreed corrections beyond the upheld holds",
      "refund or reversal not the split at its new basis (no earlier agreed correction)",
      "refund or reversal not the split at its new basis less the earlier agreed corrections",
      "SPLIT_CORRECTION has no B10 writer",
    ],
    decision: "corrections evidenced: an agreed correction only decreases and never beyond the line's UPHELD holds; a refund or reversal lands on the split at its new basis; no SPLIT_CORRECTION (D10-ADJ-1, R2-102)",
    sql: `WITH ${split(`SELECT a.adjustment_id AS k, l.pool_id, ${rounded("a.new_basis_cents", "p.rate_bps")} AS total
                        FROM kauro.commission_adjustments a JOIN kauro.commission_lines l ON l.line_id = a.line_id JOIN kauro.commission_pools p ON p.pool_id = l.pool_id
                       WHERE a.reason IN ('REFUND', 'REVERSAL')`)}
          SELECT a.adjustment_id AS ref, a.line_id AS line, a.reason || ' ' || a.direction AS detail, 'agreed correction that increases' AS why
            FROM kauro.commission_adjustments a WHERE a.reason = 'AGREED_ERROR_CORRECTION' AND a.direction = 'INCREASE'
          UNION ALL
          SELECT NULL, c.line_id, c.cents || ' corrected, no upheld hold', 'agreed corrections on a line with no upheld hold'
            FROM (${CORRECTIONS}) c
           WHERE c.cents > 0 AND NOT EXISTS (SELECT 1 FROM kauro.commission_holds h WHERE h.line_id = c.line_id AND h.state = 'UPHELD')
          UNION ALL
          SELECT NULL, c.line_id, c.cents || ' corrected, ' || u.cents || ' upheld', 'agreed corrections beyond the upheld holds'
            FROM (${CORRECTIONS}) c
            JOIN (SELECT h.line_id, sum(h.amount_cents) AS cents FROM kauro.commission_holds h WHERE h.state = 'UPHELD' GROUP BY h.line_id) u ON u.line_id = c.line_id
           WHERE c.cents > u.cents
          UNION ALL
          SELECT a.adjustment_id, a.line_id, a.new_cumulative_entitlement_cents || ' posted, ' || sp.share || ' split at basis ' || a.new_basis_cents,
                 'refund or reversal not the split at its new basis (no earlier agreed correction)'
            FROM kauro.commission_adjustments a JOIN split sp ON sp.k = a.adjustment_id AND sp.line_id = a.line_id
           WHERE NOT EXISTS (SELECT 1 FROM kauro.commission_adjustments c WHERE c.line_id = a.line_id AND c.reason = 'AGREED_ERROR_CORRECTION' AND c.direction = 'DECREASE' AND c.adjustment_seq < a.adjustment_seq)
             AND a.new_cumulative_entitlement_cents <> sp.share
          UNION ALL
          SELECT a.adjustment_id, a.line_id, a.new_cumulative_entitlement_cents || ' posted, ' || (sp.share - e.cents) || ' split at basis ' || a.new_basis_cents || ' less ' || e.cents || ' corrected before',
                 'refund or reversal not the split at its new basis less the earlier agreed corrections'
            FROM kauro.commission_adjustments a JOIN split sp ON sp.k = a.adjustment_id AND sp.line_id = a.line_id
            JOIN LATERAL (SELECT c.line_id, sum(c.amount_cents) AS cents FROM kauro.commission_adjustments c
                           WHERE c.line_id = a.line_id AND c.reason = 'AGREED_ERROR_CORRECTION' AND c.direction = 'DECREASE' AND c.adjustment_seq < a.adjustment_seq
                           GROUP BY c.line_id) e ON true
           WHERE a.new_cumulative_entitlement_cents <> sp.share - e.cents
          UNION ALL
          SELECT a.adjustment_id, a.line_id, a.reason, 'SPLIT_CORRECTION has no B10 writer' FROM kauro.commission_adjustments a WHERE a.reason = 'SPLIT_CORRECTION'`,
  },
  {
    id: "INV-S-10",
    whys: ["first adjustment not from the initial split","adjustment chain not starting at seq 1","adjustment not from the prior one's new cumulative","new cumulative not previous moved by the amount","last adjustment not the line's cumulative"],
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
          SELECT ch.adjustment_id, ch.line_id, ch.adjustment_seq, 'seq ' || ch.adjustment_seq || ' with no prior', 'adjustment chain not starting at seq 1'
            FROM chain ch WHERE ch.prior_seq IS NULL AND ch.adjustment_seq > 1
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
    whys: ["frozen allocation shares not 10000 bps", "frozen allocation with no share"],
    decision: "a frozen allocation's shares sum to exactly 10000 bps, whatever its claims' states (R2-05; mig 0029)",
    sql: `SELECT a.allocation_id, s.bps, 'frozen allocation shares not 10000 bps' AS why
            FROM kauro.attribution_allocations a
            JOIN (SELECT allocation_id, sum(share_bps) AS bps FROM kauro.allocation_shares GROUP BY allocation_id) s ON s.allocation_id = a.allocation_id
           WHERE a.frozen_at IS NOT NULL AND s.bps <> 10000
          UNION ALL
          SELECT a.allocation_id, NULL, 'frozen allocation with no share'
            FROM kauro.attribution_allocations a
           WHERE a.frozen_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM kauro.allocation_shares s WHERE s.allocation_id = a.allocation_id)`,
  },
  {
    id: "INV-S-12",
    whys: ["live reservations above the slots", "live reservation on no slot of its agency", "live reservation on several slots of its agency", "slot names a reservation that is not live in its agency"],
    decision: "founding capacity: live reservations within the policy's slots, each the live reservation of exactly one slot of its agency, and the reverse (R1 R12)",
    sql: `WITH live AS (SELECT * FROM kauro.founding_slot_reservations WHERE state IN ('RESERVED', 'RECONCILIATION_HOLD', 'CONSUMED'))
          SELECT v.policy_version AS ref, count(*)::text || ' live, ' || (SELECT count(*) FROM kauro.founding_slots f WHERE f.policy_version = v.policy_version) || ' slots' AS detail, 'live reservations above the slots' AS why
            FROM live v GROUP BY v.policy_version
          HAVING count(*) > (SELECT count(*) FROM kauro.founding_slots f WHERE f.policy_version = v.policy_version)
          UNION ALL
          SELECT v.reservation_id::text, '0 slots', 'live reservation on no slot of its agency'
            FROM live v
           WHERE NOT EXISTS (SELECT 1 FROM kauro.founding_slots f WHERE f.live_reservation_id = v.reservation_id AND f.live_agency_id = v.agency_id AND f.policy_version = v.policy_version)
          UNION ALL
          SELECT v.reservation_id::text, (SELECT count(*) FROM kauro.founding_slots f WHERE f.live_reservation_id = v.reservation_id AND f.live_agency_id = v.agency_id AND f.policy_version = v.policy_version)::text || ' slots', 'live reservation on several slots of its agency'
            FROM live v
           WHERE (SELECT count(*) FROM kauro.founding_slots f WHERE f.live_reservation_id = v.reservation_id AND f.live_agency_id = v.agency_id AND f.policy_version = v.policy_version) > 1
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
    whys: ["pool with no line","claim entitlement whose claim does not exist","claim entitlement whose claim is not CONVERTED","CONVERTED claim without an entitlement","first qualifying purchase without the first designation naming its capture","agencies mirror without a first designation","agencies mirror not the first designation","paid purchase with two non-REVOKED authorizations","CORRECTED statement with an intent not FAILED or RETURNED","predecessor with two successors"],
    decision: "completeness of the pairs written in one unit: pool and lines, claim and entitlement, first designation, the agencies mirror, one live authorization per purchase, corrections (CONS_PAR, CONV_PAR, D10-FIRST-1, REPL_*, D10-GAP-7)",
    sql: `SELECT p.pool_id::text AS ref, NULL AS other, 'pool with no line' AS why
            FROM kauro.commission_pools p WHERE NOT EXISTS (SELECT 1 FROM kauro.commission_lines l WHERE l.pool_id = p.pool_id)
          UNION ALL
          SELECT e.entitlement_id::text, e.claim_id::text, 'claim entitlement whose claim does not exist'
            FROM kauro.commission_entitlements e
           WHERE e.claim_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM kauro.attribution_claims c WHERE c.claim_id = e.claim_id)
          UNION ALL
          SELECT e.entitlement_id::text, e.claim_id::text || ' ' || c.state, 'claim entitlement whose claim is not CONVERTED'
            FROM kauro.commission_entitlements e JOIN kauro.attribution_claims c ON c.claim_id = e.claim_id
           WHERE c.state <> 'CONVERTED'
          UNION ALL
          SELECT c.claim_id::text, NULL, 'CONVERTED claim without an entitlement'
            FROM kauro.attribution_claims c WHERE c.state = 'CONVERTED' AND NOT EXISTS (SELECT 1 FROM kauro.commission_entitlements e WHERE e.claim_id = c.claim_id)
          UNION ALL
          SELECT q.authorization_id::text, q.capture_id::text, 'first qualifying purchase without the first designation naming its capture'
            FROM kauro.qualifying_purchases q
           WHERE q.confirmation_seq = 1 AND NOT EXISTS (SELECT 1 FROM kauro.agency_recurrence r WHERE r.agency_id = q.agency_id AND r.first_capture_id = q.capture_id)
          UNION ALL
          SELECT a.agency_id::text, a.first_qualifying_capture_id::text || ' mirror, no designation', 'agencies mirror without a first designation'
            FROM kauro.agencies a
           WHERE a.first_qualifying_capture_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM kauro.agency_recurrence r WHERE r.agency_id = a.agency_id)
          UNION ALL
          SELECT a.agency_id::text, a.first_qualifying_capture_id::text || ' mirror, ' || r.first_capture_id::text || ' designated', 'agencies mirror not the first designation'
            FROM kauro.agencies a JOIN kauro.agency_recurrence r ON r.agency_id = a.agency_id
           WHERE a.first_qualifying_capture_id <> r.first_capture_id
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
