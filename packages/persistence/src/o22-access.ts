/**
 * Order 22's adapter (migration 0120): the rows seller money is computed from, the retainer, claim refusals, reviews and their
 * history, and the claim subjects of the alerts — each read and written on the unit of work's own connection, under the caller's own
 * row policies (an owner's OPERATOR session reads every seller; a seller's reads its own rows only; nothing here filters in place of a
 * policy). Activation OFF: only apps/api/src/o22 calls it, and those routes are registered only when o22Activation holds.
 */
import { DomainFailure, o22, type UnitOfWork } from "@kauro/domain";
import { execute, type Queryable } from "./sql.js";
import { PgCommerceUnitOfWork } from "./unit-of-work.js";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const big = (v: unknown): bigint => BigInt(String(v));

export interface ClaimRow {
  readonly claimId: string;
  readonly sellerId: string;
  readonly prospectId: string;
  readonly state: o22.ClaimState;
  readonly version: number;
  readonly submittedAt: string;
  readonly acceptedAt: string | null;
  readonly expiresAt: string | null;
  readonly reviewDeadlineAt: string;
  readonly refusalId: string | null;
}

export interface RefusalRow {
  readonly refusalId: string;
  readonly claimId: string;
  readonly reasonCode: string;
  readonly listVersion: string;
  readonly evidenceRef: string;
  readonly ownerRuleRef: string | null;
  readonly note: string | null;
  readonly sellerMessage: string;
  readonly refusedAt: string;
}

export interface ReviewRow {
  readonly reviewId: string;
  readonly claimId: string;
  readonly sellerId: string;
  readonly refusalId: string;
  readonly state: o22.ReviewState;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly version: number;
}

export interface DecisionEntryRow {
  readonly claimId: string;
  readonly sequence: number;
  readonly kind: o22.DecisionEntryKind;
  readonly actorKind: "SELLER" | "KAURO_OWNER" | "SYSTEM";
  readonly sellerMessage: string | null;
  readonly at: string;
  readonly refusalId: string | null;
  readonly reviewId: string | null;
}

export interface RetainerAccrualRow {
  readonly accrualId: string;
  readonly sellerId: string;
  readonly agreementId: string;
  readonly monthStart: string;
  readonly amountCents: bigint;
}

const CLAIM_COLUMNS = "c.claim_id, c.seller_id, c.prospect_id, c.state, c.version, c.submitted_at, c.accepted_at, c.expires_at, c.review_deadline_at, c.refusal_id";
function claimOf(r: Record<string, unknown>): ClaimRow {
  return {
    claimId: String(r["claim_id"]),
    sellerId: String(r["seller_id"]),
    prospectId: String(r["prospect_id"]),
    state: String(r["state"]) as o22.ClaimState,
    version: Number(r["version"]),
    submittedAt: iso(r["submitted_at"]),
    acceptedAt: r["accepted_at"] === null ? null : iso(r["accepted_at"]),
    expiresAt: r["expires_at"] === null ? null : iso(r["expires_at"]),
    reviewDeadlineAt: iso(r["review_deadline_at"]),
    refusalId: r["refusal_id"] === null ? null : String(r["refusal_id"]),
  };
}
const REVIEW_COLUMNS = "v.review_id, v.claim_id, v.seller_id, v.refusal_id, v.state, v.requested_at, v.decided_at, v.version";
function reviewOf(r: Record<string, unknown>): ReviewRow {
  return {
    reviewId: String(r["review_id"]),
    claimId: String(r["claim_id"]),
    sellerId: String(r["seller_id"]),
    refusalId: String(r["refusal_id"]),
    state: String(r["state"]) as o22.ReviewState,
    requestedAt: iso(r["requested_at"]),
    decidedAt: r["decided_at"] === null ? null : iso(r["decided_at"]),
    version: Number(r["version"]),
  };
}
const REFUSAL_COLUMNS = "r.refusal_id, r.claim_id, r.reason_code, r.list_version, r.evidence_ref, r.owner_rule_id, r.owner_rule_version, r.note, r.seller_message, r.refused_at";
function refusalOf(r: Record<string, unknown>): RefusalRow {
  return {
    refusalId: String(r["refusal_id"]),
    claimId: String(r["claim_id"]),
    reasonCode: String(r["reason_code"]),
    listVersion: String(r["list_version"]),
    evidenceRef: String(r["evidence_ref"]),
    ownerRuleRef: r["owner_rule_id"] === null ? null : `${String(r["owner_rule_id"])}@${String(r["owner_rule_version"])}`,
    note: r["note"] === null ? null : String(r["note"]),
    sellerMessage: String(r["seller_message"]),
    refusedAt: iso(r["refused_at"]),
  };
}

export class PgO22Repository {
  readonly #db: Queryable;
  readonly #next: () => string;
  constructor(db: Queryable, next: () => string) {
    this.#db = db;
    this.#next = next;
  }

  // --- seller money ----------------------------------------------------------------------------------------------------------------------------

  /** The period's dates, or null when the caller cannot read a period of this id. */
  async period(periodId: string): Promise<o22.Period | null> {
    const r = await execute(this.#db, "SELECT starts_at, ends_at FROM kauro.commission_periods WHERE period_id = $1", [periodId]);
    const row = r.rows[0];
    return row === undefined ? null : { startsAt: iso(row["starts_at"]), endsAt: iso(row["ends_at"]) };
  }

  /** Every row seller money reads that the caller's policies admit, narrowed to one seller when given. */
  async sellerMoneyRows(sellerId: string | null): Promise<o22.SellerMoneyRows> {
    const narrow = (alias: string): string => (sellerId === null ? "" : ` WHERE ${alias}.seller_id = $1`);
    const p = sellerId === null ? [] : [sellerId];
    const lines = await execute(this.#db, `SELECT l.line_id, l.seller_id, l.pool_id, l.capture_id, l.share_bps, l.previous_posted_cents, l.cumulative_entitlement_cents, coalesce(l.paid_cents, 0) AS paid_cents, l.state, l.created_at FROM kauro.commission_lines l${narrow("l")}`, p);
    const poolIds = [...new Set(lines.rows.map((r) => String(r["pool_id"])))];
    const basis = poolIds.length === 0 ? { rows: [] } : await execute(this.#db, "SELECT h.pool_id, h.capture_id, h.source, h.previous_basis_cents, h.new_basis_cents, h.changed_at FROM kauro.commission_pool_basis_history h WHERE h.pool_id = ANY($1::uuid[])", [poolIds]);
    const adjustments = await execute(this.#db, `SELECT a.adjustment_id, a.line_id, a.direction, a.amount_cents, a.created_at FROM kauro.commission_adjustments a${narrow("a")}`, p);
    const holds = await execute(this.#db, `SELECT h.line_id, h.amount_cents, h.state FROM kauro.commission_holds h${narrow("h")}`, p);
    const offsets = await execute(this.#db, `SELECT o.offset_id, o.seller_id, o.against_line_id, o.amount_cents, o.recorded_at FROM kauro.commission_offsets o${narrow("o")}`, p);
    const releases = await execute(this.#db, `SELECT x.offset_id, x.seller_id, x.amount_cents, x.recorded_at FROM kauro.commission_offset_releases x${narrow("x")}`, p);
    const payouts = await execute(this.#db, `SELECT i.seller_id, i.amount_cents, i.state, i.settled_at FROM kauro.payout_intents i${narrow("i")}`, p);
    const captureIds = [...new Set(lines.rows.map((r) => String(r["capture_id"])))];
    // the latest funds of each capture, and each settled line's seller credit not yet itemized: what the period close reads (0057)
    const funds = captureIds.length === 0 ? { rows: [] } : await execute(this.#db, "SELECT DISTINCT ON (f.capture_id) f.capture_id, f.funds_state FROM kauro.capture_funds_observations f WHERE f.capture_id = ANY($1::uuid[]) ORDER BY f.capture_id, f.capture_version DESC", [captureIds]);
    const settled = lines.rows.filter((r) => r["state"] === "PAID" || r["state"] === "ADJUSTED").map((r) => String(r["line_id"]));
    const credit = settled.length === 0 ? { rows: [] } : await execute(this.#db, "SELECT l.line_id, (kauro.commission_line_credit_recognized(l.line_id) - kauro.commission_line_credit_itemized(l.line_id))::text AS due FROM kauro.commission_lines l WHERE l.line_id = ANY($1::uuid[])", [settled]);
    return {
      basis: basis.rows.map((r) => ({
        poolId: String(r["pool_id"]),
        captureId: String(r["capture_id"]),
        source: String(r["source"]) as "ACQUISITION" | "ASSISTANCE",
        previousBasisCents: r["previous_basis_cents"] === null ? null : big(r["previous_basis_cents"]),
        newBasisCents: big(r["new_basis_cents"]),
        changedAt: iso(r["changed_at"]),
      })),
      lines: lines.rows.map((r) => ({
        lineId: String(r["line_id"]),
        sellerId: String(r["seller_id"]),
        poolId: String(r["pool_id"]),
        captureId: String(r["capture_id"]),
        shareBps: Number(r["share_bps"]),
        previousPostedCents: big(r["previous_posted_cents"]),
        cumulativeEntitlementCents: big(r["cumulative_entitlement_cents"]),
        paidCents: big(r["paid_cents"]),
        state: String(r["state"]) as o22.MoneyLine["state"],
        createdAt: iso(r["created_at"]),
      })),
      adjustments: adjustments.rows.map((r) => ({ adjustmentId: String(r["adjustment_id"]), lineId: String(r["line_id"]), direction: String(r["direction"]) as "INCREASE" | "DECREASE", amountCents: big(r["amount_cents"]), createdAt: iso(r["created_at"]) })),
      holds: holds.rows.map((r) => ({ lineId: String(r["line_id"]), amountCents: big(r["amount_cents"]), state: String(r["state"]) as "OPEN" | "RELEASED" | "UPHELD" })),
      offsets: offsets.rows.map((r) => ({ offsetId: String(r["offset_id"]), sellerId: String(r["seller_id"]), againstLineId: String(r["against_line_id"]), amountCents: big(r["amount_cents"]), recordedAt: iso(r["recorded_at"]) })),
      releases: releases.rows.map((r) => ({ offsetId: String(r["offset_id"]), sellerId: String(r["seller_id"]), amountCents: big(r["amount_cents"]), recordedAt: iso(r["recorded_at"]) })),
      payouts: payouts.rows.map((r) => ({ sellerId: String(r["seller_id"]), amountCents: big(r["amount_cents"]), state: String(r["state"]), settledAt: r["settled_at"] === null ? null : iso(r["settled_at"]) })),
      funds: funds.rows.map((r) => ({ captureId: String(r["capture_id"]), fundsState: String(r["funds_state"]) as "HELD" | "AVAILABLE" })),
      credit: credit.rows.map((r) => ({ lineId: String(r["line_id"]), dueCents: big(r["due"]) })),
    };
  }

  /** The database's instant (computedAt). */
  async now(): Promise<string> {
    const r = await execute(this.#db, "SELECT kauro.server_now() AS now");
    return iso(r.rows[0]?.["now"]);
  }

  // --- the retainer ----------------------------------------------------------------------------------------------------------------------------

  async retainerAgreements(sellerId: string): Promise<ReadonlyArray<o22.RetainerAgreement>> {
    const r = await execute(this.#db, "SELECT agreement_id, seller_id, starts_at, ends_at, retainer_cents_per_month, signed_at FROM kauro.seller_agreements WHERE seller_id = $1", [sellerId]);
    return r.rows.map((x) => ({
      agreementId: String(x["agreement_id"]),
      sellerId: String(x["seller_id"]),
      startsAt: iso(x["starts_at"]),
      endsAt: x["ends_at"] === null ? null : iso(x["ends_at"]),
      retainerCentsPerMonth: big(x["retainer_cents_per_month"]),
      signedAt: x["signed_at"] === null ? null : iso(x["signed_at"]),
    }));
  }

  /** Records the month's accrual (the database checks it against the agreement in force); an existing month answers the stored row. */
  async accrueRetainer(due: o22.RetainerDue): Promise<RetainerAccrualRow | null> {
    if (due.amountCents === 0n || due.agreementId === null) return null;
    await execute(this.#db, "INSERT INTO kauro.retainer_accruals (accrual_id, seller_id, agreement_id, month_start, amount_cents) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (seller_id, month_start) DO NOTHING", [
      this.#next(),
      due.sellerId,
      due.agreementId,
      due.monthStart,
      due.amountCents.toString(),
    ]);
    const r = await execute(this.#db, "SELECT accrual_id, seller_id, agreement_id, month_start, amount_cents FROM kauro.retainer_accruals WHERE seller_id = $1 AND month_start = $2", [due.sellerId, due.monthStart]);
    const x = r.rows[0];
    return x === undefined ? null : { accrualId: String(x["accrual_id"]), sellerId: String(x["seller_id"]), agreementId: String(x["agreement_id"]), monthStart: iso(x["month_start"]), amountCents: big(x["amount_cents"]) };
  }

  async retainerAccruals(sellerId: string, period: o22.Period): Promise<ReadonlyArray<RetainerAccrualRow>> {
    const r = await execute(this.#db, "SELECT accrual_id, seller_id, agreement_id, month_start, amount_cents FROM kauro.retainer_accruals WHERE seller_id = $1 AND month_start >= $2 AND month_start < $3 ORDER BY month_start", [sellerId, period.startsAt, period.endsAt]);
    return r.rows.map((x) => ({ accrualId: String(x["accrual_id"]), sellerId: String(x["seller_id"]), agreementId: String(x["agreement_id"]), monthStart: iso(x["month_start"]), amountCents: big(x["amount_cents"]) }));
  }

  /** The statement's items as the balance reads them, and its seller and period; null when the caller cannot read it. */
  async statementForBalance(statementId: string): Promise<{ readonly sellerId: string; readonly period: o22.Period; readonly items: ReadonlyArray<o22.BalanceStatementItem> } | null> {
    const s = await execute(this.#db, "SELECT s.seller_id, s.period_starts_at, s.period_ends_at FROM kauro.commission_statements s WHERE s.statement_id = $1", [statementId]);
    const row = s.rows[0];
    if (row === undefined) return null;
    const items = await execute(this.#db, "SELECT i.item_kind AS kind, i.line_id, i.held_cents, i.offset_cents, i.payable_cents FROM kauro.statement_items i WHERE i.statement_id = $1 ORDER BY i.item_no", [statementId]);
    return {
      sellerId: String(row["seller_id"]),
      period: { startsAt: iso(row["period_starts_at"]), endsAt: iso(row["period_ends_at"]) },
      items: items.rows.map((x) => ({ kind: String(x["kind"]) as o22.BalanceStatementItem["kind"], lineId: String(x["line_id"]), heldCents: big(x["held_cents"]), offsetCents: big(x["offset_cents"]), payableCents: big(x["payable_cents"]) })),
    };
  }

  // --- claims -------------------------------------------------------------------------------------------------------------------------------------

  /** The caller's standing as the database decides it (the same functions the row policies call). */
  async standing(): Promise<{ readonly owner: boolean; readonly sellerId: string | null; readonly activeSellerId: string | null }> {
    const r = await execute(this.#db, "SELECT kauro.acting_corporate_owner() AS owner, kauro.current_seller_id() AS seller, kauro.acting_seller_id() AS active");
    const row = r.rows[0] ?? {};
    return { owner: row["owner"] === true, sellerId: row["seller"] == null ? null : String(row["seller"]), activeSellerId: row["active"] == null ? null : String(row["active"]) };
  }

  /** A claim the caller may read, unlocked (a seller's FOR UPDATE would also apply its submit-only update policy). */
  async claim(claimId: string): Promise<ClaimRow | null> {
    const r = await execute(this.#db, `SELECT ${CLAIM_COLUMNS} FROM kauro.attribution_claims c WHERE c.claim_id = $1`, [claimId]);
    const row = r.rows[0];
    return row === undefined ? null : claimOf(row);
  }

  /** The claim the caller may read, locked for its decision (the owner's); null when none. */
  async claimForDecision(claimId: string): Promise<ClaimRow | null> {
    const r = await execute(this.#db, `SELECT ${CLAIM_COLUMNS} FROM kauro.attribution_claims c WHERE c.claim_id = $1 FOR UPDATE`, [claimId]);
    const row = r.rows[0];
    return row === undefined ? null : claimOf(row);
  }

  async claimsOf(sellerId: string | null): Promise<ReadonlyArray<ClaimRow>> {
    const r = sellerId === null
      ? await execute(this.#db, `SELECT ${CLAIM_COLUMNS} FROM kauro.attribution_claims c ORDER BY c.submitted_at DESC, c.claim_id`)
      : await execute(this.#db, `SELECT ${CLAIM_COLUMNS} FROM kauro.attribution_claims c WHERE c.seller_id = $1 ORDER BY c.submitted_at DESC, c.claim_id`, [sellerId]);
    return r.rows.map(claimOf);
  }

  async ownerRules(): Promise<ReadonlyArray<o22.OwnerRule>> {
    const r = await execute(this.#db, "SELECT rule_id, rule_version, in_force_from, in_force_until FROM kauro.owner_rules");
    return r.rows.map((x) => ({ ruleId: String(x["rule_id"]), ruleVersion: Number(x["rule_version"]), inForceFrom: iso(x["in_force_from"]), inForceUntil: x["in_force_until"] === null ? null : iso(x["in_force_until"]) }));
  }

  async refusalByKey(userId: string, idempotencyKey: string): Promise<RefusalRow | null> {
    const r = await execute(this.#db, `SELECT ${REFUSAL_COLUMNS} FROM kauro.claim_refusals r WHERE r.refused_by_user_id = $1 AND r.idempotency_key = $2`, [userId, idempotencyKey]);
    const row = r.rows[0];
    return row === undefined ? null : refusalOf(row);
  }

  async refusal(refusalId: string): Promise<RefusalRow | null> {
    const r = await execute(this.#db, `SELECT ${REFUSAL_COLUMNS} FROM kauro.claim_refusals r WHERE r.refusal_id = $1`, [refusalId]);
    const row = r.rows[0];
    return row === undefined ? null : refusalOf(row);
  }

  async #appendEntry(claimId: string, sellerId: string, kind: o22.DecisionEntryKind, actorKind: "SELLER" | "KAURO_OWNER", ref: { readonly refusalId?: string; readonly reviewId?: string; readonly sellerMessage?: string }): Promise<void> {
    // the claim row is locked by the caller, so the next sequence is the claim's own
    await execute(
      this.#db,
      `INSERT INTO kauro.claim_decision_entries (claim_id, sequence, seller_id, kind, actor_kind, refusal_id, review_id, seller_message)
       SELECT $1, coalesce((SELECT max(e.sequence) FROM kauro.claim_decision_entries e WHERE e.claim_id = $1), 0) + 1, $2, $3, $4, $5, $6, $7`,
      [claimId, sellerId, kind, actorKind, ref.refusalId ?? null, ref.reviewId ?? null, ref.sellerMessage ?? null],
    );
  }

  /**
   * CMD071's writes in the owner's transaction: the refusal, the claim REJECTED by it at the refusal's instant (one version), and the
   * REFUSED entry with the neutral message. The claim was locked by claimForDecision.
   */
  async recordRefusal(input: { readonly claim: ClaimRow; readonly refusal: o22.ValidatedRefusal; readonly userId: string; readonly idempotencyKey: string }): Promise<RefusalRow> {
    const refusalId = this.#next();
    const { claim, refusal } = input;
    await execute(
      this.#db,
      `INSERT INTO kauro.claim_refusals (refusal_id, claim_id, seller_id, list_version, reason_code, evidence_ref, note, owner_rule_id, owner_rule_version, seller_message, idempotency_key, refused_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [refusalId, claim.claimId, claim.sellerId, refusal.listVersion, refusal.reason.code, refusal.evidenceRef, refusal.note, refusal.ownerRule?.ruleId ?? null, refusal.ownerRule?.ruleVersion ?? null, refusal.sellerMessage, input.idempotencyKey, input.userId],
    );
    const u = await execute(
      this.#db,
      `UPDATE kauro.attribution_claims c SET state = 'REJECTED', refusal_id = $2, rejected_at = r.refused_at, version = c.version + 1
         FROM kauro.claim_refusals r WHERE c.claim_id = $1 AND r.refusal_id = $2 AND c.version = $3`,
      [claim.claimId, refusalId, claim.version],
    );
    if (u.rowCount !== 1) throw new DomainFailure("STALE_VERSION", "the claim changed", { currentVersion: claim.version, currentState: claim.state });
    await this.#appendEntry(claim.claimId, claim.sellerId, "REFUSED", "KAURO_OWNER", { refusalId, sellerMessage: refusal.sellerMessage });
    return (await this.refusal(refusalId)) as RefusalRow;
  }

  async reviewByKey(sellerId: string, idempotencyKey: string): Promise<ReviewRow | null> {
    const r = await execute(this.#db, `SELECT ${REVIEW_COLUMNS} FROM kauro.claim_reviews v WHERE v.seller_id = $1 AND v.idempotency_key = $2`, [sellerId, idempotencyKey]);
    const row = r.rows[0];
    return row === undefined ? null : reviewOf(row);
  }

  async reviewsOf(claimId: string): Promise<ReadonlyArray<ReviewRow>> {
    const r = await execute(this.#db, `SELECT ${REVIEW_COLUMNS} FROM kauro.claim_reviews v WHERE v.claim_id = $1 ORDER BY v.requested_at`, [claimId]);
    return r.rows.map(reviewOf);
  }

  /** A review the caller may read, unlocked (FOR UPDATE would also apply the owner's decision policy, which admits REQUESTED reviews only). */
  async review(reviewId: string): Promise<ReviewRow | null> {
    const r = await execute(this.#db, `SELECT ${REVIEW_COLUMNS} FROM kauro.claim_reviews v WHERE v.review_id = $1`, [reviewId]);
    const row = r.rows[0];
    return row === undefined ? null : reviewOf(row);
  }

  /** A REQUESTED review locked for its decision; null when none the owner may decide (a decided review is not decidable). */
  async reviewForDecision(reviewId: string): Promise<ReviewRow | null> {
    const r = await execute(this.#db, `SELECT ${REVIEW_COLUMNS} FROM kauro.claim_reviews v WHERE v.review_id = $1 FOR UPDATE`, [reviewId]);
    const row = r.rows[0];
    return row === undefined ? null : reviewOf(row);
  }

  /** CMD068's writes in the seller's transaction: one REQUESTED review of the claim's live refusal and its entry. */
  async requestReview(input: { readonly claim: ClaimRow; readonly refusalId: string; readonly note: string | null; readonly idempotencyKey: string }): Promise<ReviewRow> {
    const reviewId = this.#next();
    await execute(this.#db, "INSERT INTO kauro.claim_reviews (review_id, claim_id, seller_id, refusal_id, seller_note, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6)", [
      reviewId,
      input.claim.claimId,
      input.claim.sellerId,
      input.refusalId,
      input.note,
      input.idempotencyKey,
    ]);
    await this.#appendEntry(input.claim.claimId, input.claim.sellerId, "REVIEW_REQUESTED", "SELLER", { reviewId });
    const r = await execute(this.#db, `SELECT ${REVIEW_COLUMNS} FROM kauro.claim_reviews v WHERE v.review_id = $1`, [reviewId]);
    return reviewOf(r.rows[0] as Record<string, unknown>);
  }

  /**
   * CMD072's writes in the owner's transaction: the decision, the review UPHELD or CHANGED, and for CHANGED the claim returned to
   * its refusal withdrawn while the claim stays REJECTED (gap G-O22-01: no edge out of REJECTED is listed); one entry with the neutral outcome.
   */
  async decideReview(input: { readonly review: ReviewRow; readonly claim: ClaimRow; readonly decision: o22.ReviewDecision; readonly next: ReturnType<typeof o22.decideReview>; readonly note: string | null; readonly userId: string; readonly idempotencyKey: string; readonly sellerMessage: string | null }): Promise<ReviewRow> {
    const { review, claim } = input;
    await execute(this.#db, "INSERT INTO kauro.claim_review_decisions (review_id, decision, reason_code, note, idempotency_key, decided_by_user_id) VALUES ($1, $2, $3, $4, $5, $6)", [
      review.reviewId,
      input.decision.decision,
      input.decision.reasonCode,
      input.note,
      input.idempotencyKey,
      input.userId,
    ]);
    const u = await execute(this.#db, "UPDATE kauro.claim_reviews v SET state = $2, decided_at = d.decided_at, version = v.version + 1 FROM kauro.claim_review_decisions d WHERE v.review_id = $1 AND d.review_id = v.review_id AND v.version = $3", [
      review.reviewId,
      input.next.review,
      review.version,
    ]);
    if (u.rowCount !== 1) throw new DomainFailure("STALE_VERSION", "the review changed", { currentVersion: review.version, currentState: review.state });
    await this.#appendEntry(claim.claimId, claim.sellerId, input.next.entry, "KAURO_OWNER", { reviewId: review.reviewId, ...(input.sellerMessage === null ? {} : { sellerMessage: input.sellerMessage }) });
    return (await this.review(review.reviewId)) as ReviewRow;
  }

  async decisionByKey(userId: string, idempotencyKey: string): Promise<string | null> {
    const r = await execute(this.#db, "SELECT review_id FROM kauro.claim_review_decisions WHERE decided_by_user_id = $1 AND idempotency_key = $2", [userId, idempotencyKey]);
    const row = r.rows[0];
    return row === undefined ? null : String(row["review_id"]);
  }

  /** The claim's history as the caller's policies admit it; the owner's view joins the reasons, evidence and notes it alone reads. */
  async history(claimId: string, owner: boolean): Promise<ReadonlyArray<o22.ClaimDecisionEntry>> {
    const r = owner
      ? await execute(
          this.#db,
          `SELECT e.claim_id, e.sequence, e.kind, e.actor_kind, e.seller_message, e.at,
                  coalesce(r.reason_code, d.reason_code) AS reason_code, r.evidence_ref, coalesce(r.note, d.note, v.seller_note) AS note
             FROM kauro.claim_decision_entries e
             LEFT JOIN kauro.claim_refusals r ON r.refusal_id = e.refusal_id
             LEFT JOIN kauro.claim_reviews v ON v.review_id = e.review_id
             LEFT JOIN kauro.claim_review_decisions d ON d.review_id = e.review_id AND e.kind <> 'REVIEW_REQUESTED'
            WHERE e.claim_id = $1 ORDER BY e.sequence DESC`,
          [claimId],
        )
      : await execute(this.#db, "SELECT e.claim_id, e.sequence, e.kind, e.actor_kind, e.seller_message, e.at FROM kauro.claim_decision_entries e WHERE e.claim_id = $1 ORDER BY e.sequence DESC", [claimId]);
    return r.rows.map((x) => {
      const base: o22.ClaimDecisionEntry = { claimId: String(x["claim_id"]), sequence: Number(x["sequence"]), kind: String(x["kind"]) as o22.DecisionEntryKind, at: iso(x["at"]), actorKind: String(x["actor_kind"]) as o22.ClaimDecisionEntry["actorKind"] };
      return {
        ...base,
        ...(x["seller_message"] == null ? {} : { sellerMessage: String(x["seller_message"]) }),
        ...(owner && x["reason_code"] != null ? { reasonCode: String(x["reason_code"]) } : {}),
        ...(owner && x["evidence_ref"] != null ? { evidenceRef: String(x["evidence_ref"]) } : {}),
        ...(owner && x["note"] != null ? { note: String(x["note"]) } : {}),
      };
    });
  }

  /** The seller message of each refusal of the caller's claims (the seller reads it from its entries, never from the refusal row). */
  async latestSellerMessages(claimIds: ReadonlyArray<string>): Promise<ReadonlyMap<string, string>> {
    if (claimIds.length === 0) return new Map();
    const r = await execute(this.#db, "SELECT DISTINCT ON (e.claim_id) e.claim_id, e.seller_message FROM kauro.claim_decision_entries e WHERE e.claim_id = ANY($1::uuid[]) AND e.seller_message IS NOT NULL ORDER BY e.claim_id, e.sequence DESC", [claimIds]);
    return new Map(r.rows.map((x) => [String(x["claim_id"]), String(x["seller_message"])] as const));
  }

  /** The organization label of each prospect the caller may read (a seller: the prospects it registered or owns). */
  async prospectLabels(prospectIds: ReadonlyArray<string>): Promise<ReadonlyMap<string, string>> {
    if (prospectIds.length === 0) return new Map();
    const r = await execute(this.#db, "SELECT prospect_id, organization_label FROM kauro.prospects WHERE prospect_id = ANY($1::uuid[])", [prospectIds]);
    return new Map(r.rows.map((x) => [String(x["prospect_id"]), String(x["organization_label"])] as const));
  }

  async reviewsOfClaims(claimIds: ReadonlyArray<string>): Promise<ReadonlyArray<ReviewRow>> {
    if (claimIds.length === 0) return [];
    const r = await execute(this.#db, `SELECT ${REVIEW_COLUMNS} FROM kauro.claim_reviews v WHERE v.claim_id = ANY($1::uuid[])`, [claimIds]);
    return r.rows.map(reviewOf);
  }
}

const bound = new WeakMap<PgCommerceUnitOfWork, PgO22Repository>();

/** Order 22's adapter of a commerce (or commercial) unit of work of this package, created once on its connection. */
export function o22Of(uow: UnitOfWork): PgO22Repository {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "Order 22's rows are read in a commerce unit of work of @kauro/persistence");
  let repo = bound.get(uow);
  if (repo === undefined) {
    const db = (uow as unknown as { readonly client: Queryable }).client;
    repo = new PgO22Repository(db, () => uow.ids.next());
    bound.set(uow, repo);
  }
  return repo;
}
