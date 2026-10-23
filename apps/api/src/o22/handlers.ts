/**
 * Order 22's operations against REISSUE-CANDIDATE-01 (build profile; CP-02.07, .09, .10, .11, .14): seller money (ListSellerMoney,
 * GetMyMoney), the statement balance (GetCommissionStatement's `balance`), claims (RefuseAttribution CMD071, RequestClaimReview CMD068,
 * DecideClaimReview CMD072, ListMyClaims, GetMyClaimHistory, GetClaimHistory) and alerts (ListOwnerAlerts, ListMyAlerts).
 *
 * Every operation runs in one OPERATOR unit of work of the caller, so the row policies of migration 0120 decide what it reads: an owner
 * reads every seller, a seller its own rows only. The caller's standing is read from the database first (kauro.acting_corporate_owner,
 * kauro.current_seller_id, kauro.acting_seller_id) and refused before any effect when it does not fit. Replies follow the candidate
 * contracts exactly: a seller never reads a reason code, evidence, note, agency or another seller's id.
 *
 * Activation OFF: these handlers are reached only through routes.ts, which registers nothing unless o22Activation holds.
 */
import { DomainFailure, o22 } from "@kauro/domain";
import type { ClaimRow, PgO22Repository, ReviewRow } from "@kauro/persistence";

/** The caller as the database sees it. */
export interface Standing {
  readonly owner: boolean;
  readonly sellerId: string | null;
  readonly activeSellerId: string | null;
}

/** What the handlers need of a store: the adapter's methods and the caller's standing (both read in the caller's unit of work). */
export type O22Store = Pick<
  PgO22Repository,
  | "period"
  | "sellerMoneyRows"
  | "now"
  | "statementForBalance"
  | "retainerAccruals"
  | "claimForDecision"
  | "claim"
  | "standing"
  | "claimsOf"
  | "ownerRules"
  | "refusalByKey"
  | "refusal"
  | "recordRefusal"
  | "reviewByKey"
  | "reviewsOf"
  | "review"
  | "reviewForDecision"
  | "requestReview"
  | "decideReview"
  | "decisionByKey"
  | "history"
  | "latestSellerMessages"
  | "reviewsOfClaims"
  | "prospectLabels"
>;

/** Runs `fn` in one unit of work of the person `userId` (an OPERATOR session: the person bound, no agency). */
export type RunAs = <T>(userId: string, correlationId: string, fn: (store: O22Store) => Promise<T>) => Promise<T>;

export type O22Result<View> = { readonly kind: "READ"; readonly data: View } | { readonly kind: "COMPLETED"; readonly status: 200 | 201; readonly version: number; readonly replayed: boolean; readonly data: View } | { readonly kind: "FAILURE"; readonly failure: DomainFailure | o22.O22Failure };

const denied = (what: string): DomainFailure => new DomainFailure("NOT_AUTHORIZED", `${what} denied`);
const notFound = (what: string): DomainFailure => new DomainFailure("NOT_FOUND", `no ${what}`);

async function guarded<View>(fn: () => Promise<O22Result<View>>): Promise<O22Result<View>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof o22.O22Failure) return { kind: "FAILURE", failure: e };
    if (e instanceof DomainFailure && e.code !== "INTERNAL_ERROR" && e.code !== "INTEGRITY_FAILURE") return { kind: "FAILURE", failure: e };
    throw e;
  }
}

// --- seller money ---------------------------------------------------------------------------------------------------------------------------------

/** ListSellerMoney (KAURO_OWNER): the total row first (no sellerId), then each seller with a line, at most 100 rows. */
export function listSellerMoney(runAs: RunAs, userId: string, correlationId: string, periodId: string): Promise<O22Result<{ readonly items: ReadonlyArray<o22.SellerMoneySummaryView> }>> {
  return guarded(() =>
    runAs(userId, correlationId, async (s) => {
      if (!(await s.standing()).owner) throw denied("ListSellerMoney");
      const period = await s.period(periodId);
      if (period === null) throw notFound("period has this id");
      const { sellers, total } = o22.sellerMoney(await s.sellerMoneyRows(null), period);
      const at = await s.now();
      return { kind: "READ" as const, data: { items: [total, ...sellers].slice(0, 100).map((f) => o22.moneySummaryView(f, at)) } };
    }),
  );
}

/** GetMyMoney (the caller's own seller, any state): the caller's own row, from the caller's own rows only. */
export function getMyMoney(runAs: RunAs, userId: string, correlationId: string, periodId: string): Promise<O22Result<o22.SellerMoneySummaryView>> {
  return guarded(() =>
    runAs(userId, correlationId, async (s) => {
      const { sellerId } = await s.standing();
      if (sellerId === null) throw denied("GetMyMoney");
      const period = await s.period(periodId);
      if (period === null) throw notFound("period has this id");
      const mine = o22.sellerMoney(await s.sellerMoneyRows(sellerId), period).sellers.find((f) => f.sellerId === sellerId);
      const zero: o22.SellerMoneyFigures = { sellerId, period, netAttributableRevenueCents: 0n, commissionGeneratedCents: 0n, commissionHeldCents: 0n, commissionPayableCents: 0n, commissionPendingCents: 0n, commissionPaidCents: 0n, refundOffsetCents: 0n };
      return { kind: "READ" as const, data: o22.moneySummaryView(mine ?? zero, await s.now()) };
    }),
  );
}

export interface StatementBalanceView {
  readonly earnedCents: string;
  readonly offsetCents: string;
  readonly retainerCents: string;
  readonly heldCents: string;
  readonly payableCents: string;
}

/** The `balance` member of a statement the caller may read (the owner any, a seller its own): computed from its own items and its period's retainer accruals. */
export function statementBalance(runAs: RunAs, userId: string, correlationId: string, statementId: string): Promise<O22Result<StatementBalanceView>> {
  return guarded(() =>
    runAs(userId, correlationId, async (s) => {
      const st = await s.statementForBalance(statementId);
      if (st === null) throw notFound("statement has this id");
      const accruals = await s.retainerAccruals(st.sellerId, st.period);
      const b = o22.statementBalance(st.items, accruals.map((a) => ({ accrualId: a.accrualId, monthStart: a.monthStart, amountCents: a.amountCents })));
      return { kind: "READ" as const, data: { earnedCents: b.earnedCents.toString(), offsetCents: b.offsetCents.toString(), retainerCents: b.retainerCents.toString(), heldCents: b.heldCents.toString(), payableCents: b.payableCents.toString() } };
    }),
  );
}

// --- claims ----------------------------------------------------------------------------------------------------------------------------------------

export interface ClaimRefusalView {
  readonly refusalId: string;
  readonly claimId: string;
  readonly reasonCode: string;
  readonly listVersion: string;
  readonly evidenceRef: string;
  readonly ownerRuleRef?: string;
  readonly note?: string;
  readonly sellerMessage: string;
  readonly refusedAt: string;
}

export interface RefuseAttributionBody {
  readonly expectedVersion: number;
  readonly reasonCode: string;
  readonly listVersion: string;
  readonly evidenceRef: string;
  readonly note?: string;
  readonly ownerRuleRef?: string;
}

const refusalView = (r: NonNullable<Awaited<ReturnType<O22Store["refusal"]>>>): ClaimRefusalView => ({
  refusalId: r.refusalId,
  claimId: r.claimId,
  reasonCode: r.reasonCode,
  listVersion: r.listVersion,
  evidenceRef: r.evidenceRef,
  ...(r.ownerRuleRef === null ? {} : { ownerRuleRef: r.ownerRuleRef }),
  ...(r.note === null ? {} : { note: r.note }),
  sellerMessage: r.sellerMessage,
  refusedAt: r.refusedAt,
});

/** CMD071 RefuseAttribution (KAURO_OWNER): a replay of the same key answers the stored refusal; the legal effect stays PENDING_COUNSEL. */
export function refuseAttribution(runAs: RunAs, userId: string, correlationId: string, claimId: string, body: RefuseAttributionBody, idempotencyKey: string): Promise<O22Result<ClaimRefusalView>> {
  return guarded(() =>
    runAs(userId, correlationId, async (s) => {
      if (!(await s.standing()).owner) throw denied("RefuseAttribution");
      const replay = await s.refusalByKey(userId, idempotencyKey);
      if (replay !== null) {
        if (replay.claimId !== claimId || replay.reasonCode !== body.reasonCode) throw new DomainFailure("IDEMPOTENCY_CONFLICT", "the key names another refusal");
        const claim = await s.claimForDecision(claimId);
        return { kind: "COMPLETED" as const, status: 200 as const, version: claim?.version ?? 1, replayed: true, data: refusalView(replay) };
      }
      const claim = await s.claimForDecision(claimId);
      if (claim === null) throw notFound("claim has this id");
      if (claim.version !== body.expectedVersion) throw new DomainFailure("STALE_VERSION", "the claim changed", { currentVersion: claim.version, currentState: claim.state });
      const refusal = o22.validateRefusal({
        claimState: claim.state,
        factsAt: claim.submittedAt,
        ownerRules: await s.ownerRules(),
        request: { reasonCode: body.reasonCode, listVersion: body.listVersion, evidenceRef: body.evidenceRef, ...(body.note === undefined ? {} : { note: body.note }), ...(body.ownerRuleRef === undefined ? {} : { ownerRuleRef: body.ownerRuleRef }) },
      });
      const stored = await s.recordRefusal({ claim, refusal, userId, idempotencyKey });
      return { kind: "COMPLETED" as const, status: 200 as const, version: claim.version + 1, replayed: false, data: refusalView(stored) };
    }),
  );
}

export interface ClaimReviewView {
  readonly reviewId: string;
  readonly claimId: string;
  readonly sellerId: string;
  readonly state: o22.ReviewState;
  readonly requestedAt: string;
  readonly decidedAt?: string;
  readonly version: number;
}

const reviewView = (r: ReviewRow): ClaimReviewView => ({ reviewId: r.reviewId, claimId: r.claimId, sellerId: r.sellerId, state: r.state, requestedAt: r.requestedAt, ...(r.decidedAt === null ? {} : { decidedAt: r.decidedAt }), version: r.version });

/** CMD068 RequestClaimReview (ACTIVE_SELLER): another seller's claim answers as not found; one review per refusal. */
export function requestClaimReview(runAs: RunAs, userId: string, correlationId: string, claimId: string, body: { readonly expectedVersion: number; readonly note?: string }, idempotencyKey: string): Promise<O22Result<ClaimReviewView>> {
  return guarded(() =>
    runAs(userId, correlationId, async (s) => {
      const { activeSellerId } = await s.standing();
      if (activeSellerId === null) throw denied("RequestClaimReview");
      const replay = await s.reviewByKey(activeSellerId, idempotencyKey);
      if (replay !== null) {
        if (replay.claimId !== claimId) throw new DomainFailure("IDEMPOTENCY_CONFLICT", "the key names another review");
        return { kind: "COMPLETED" as const, status: 201 as const, version: replay.version, replayed: true, data: reviewView(replay) };
      }
      const claim = await s.claim(claimId);
      if (claim === null || claim.sellerId !== activeSellerId) throw notFound("claim of the caller has this id");
      if (claim.version !== body.expectedVersion) throw new DomainFailure("STALE_VERSION", "the claim changed since it was read", { currentVersion: claim.version, currentState: claim.state });
      const reviewed = new Set((await s.reviewsOf(claimId)).map((r) => r.refusalId));
      const refusalId = o22.assertReviewRequestable({ claimState: claim.state, liveRefusalId: claim.refusalId, reviewedRefusalIds: reviewed });
      const review = await s.requestReview({ claim, refusalId, note: body.note ?? null, idempotencyKey });
      return { kind: "COMPLETED" as const, status: 201 as const, version: review.version, replayed: false, data: reviewView(review) };
    }),
  );
}

/** CMD072 DecideClaimReview (KAURO_OWNER): UPHOLD keeps the refusal, CHANGE withdraws it (the claim stays REJECTED, gap G-O22-01; never ACCEPTED). */
export function decideClaimReview(runAs: RunAs, userId: string, correlationId: string, reviewId: string, body: { readonly expectedVersion: number; readonly decision: "UPHOLD" | "CHANGE"; readonly reasonCode: string; readonly note?: string }, idempotencyKey: string): Promise<O22Result<ClaimReviewView>> {
  return guarded(() =>
    runAs(userId, correlationId, async (s) => {
      if (!(await s.standing()).owner) throw denied("DecideClaimReview");
      const replayed = await s.decisionByKey(userId, idempotencyKey);
      if (replayed !== null) {
        if (replayed !== reviewId) throw new DomainFailure("IDEMPOTENCY_CONFLICT", "the key names another review");
        const r = (await s.review(reviewId)) as ReviewRow;
        return { kind: "COMPLETED" as const, status: 200 as const, version: r.version, replayed: true, data: reviewView(r) };
      }
      const any = await s.review(reviewId);
      if (any === null) throw notFound("review has this id");
      const review = await s.reviewForDecision(reviewId);
      if (review === null) throw new o22.O22Failure("PRECONDITION_FAILED", "REVIEW_NOT_OPEN", "the review was decided");
      if (review.version !== body.expectedVersion) throw new DomainFailure("STALE_VERSION", "the review changed", { currentVersion: review.version, currentState: review.state });
      const decision = { decision: body.decision, reasonCode: body.reasonCode };
      const refusal = await s.refusal(review.refusalId);
      if (refusal === null) throw new DomainFailure("INTEGRITY_FAILURE", "a review names a refusal the owner cannot read");
      const next = o22.decideReview(review.state, decision, refusal.reasonCode);
      const claim = (await s.claimForDecision(review.claimId)) as ClaimRow;
      // the seller reads the neutral outcome: an upheld refusal keeps its code's message; a changed one names none
      const sellerMessage = next.review === "UPHELD" ? (o22.refusalReasonOf(body.reasonCode)?.sellerMessage ?? null) : null;
      const decided = await s.decideReview({ review, claim, decision, next, note: body.note ?? null, userId, idempotencyKey, sellerMessage });
      return { kind: "COMPLETED" as const, status: 200 as const, version: decided.version, replayed: false, data: reviewView(decided) };
    }),
  );
}

export interface SellerClaimView {
  readonly claimId: string;
  readonly prospectId: string;
  readonly organizationLabel: string;
  readonly state: o22.ClaimState;
  readonly acceptedAt?: string;
  readonly expiresAt: string;
  readonly sellerMessage?: string;
  readonly reviewState: "NONE" | o22.ReviewState;
  readonly reviewAvailable: boolean;
  readonly version: number;
}

/**
 * ListMyClaims (the caller's own seller, any state): the seller's claims with the neutral message of their latest decision and the
 * state of the latest review. `expiresAt` is the claim's end: its acceptance window when accepted, else its review deadline.
 * organizationLabel is read by the caller's prospect policy (a seller reads the prospects it registered or owns).
 */
export function listMyClaims(runAs: RunAs, userId: string, correlationId: string, labels: (store: O22Store, prospectIds: ReadonlyArray<string>) => Promise<ReadonlyMap<string, string>>): Promise<O22Result<{ readonly items: ReadonlyArray<SellerClaimView> }>> {
  return guarded(() =>
    runAs(userId, correlationId, async (s) => {
      const { sellerId } = await s.standing();
      if (sellerId === null) throw denied("ListMyClaims");
      const claims = (await s.claimsOf(sellerId)).slice(0, 100);
      const ids = claims.map((c) => c.claimId);
      const messages = await s.latestSellerMessages(ids);
      const reviews = await s.reviewsOfClaims(ids);
      const names = await labels(s, [...new Set(claims.map((c) => c.prospectId))]);
      const items = claims.map((c): SellerClaimView => {
        const mine = reviews.filter((r) => r.claimId === c.claimId).sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
        const latest = mine[0];
        // a refusal withdrawn by a CHANGED review no longer speaks for the claim
        const message = c.state === "REJECTED" && latest?.state !== "CHANGED" ? messages.get(c.claimId) : undefined;
        return {
          claimId: c.claimId,
          prospectId: c.prospectId,
          organizationLabel: names.get(c.prospectId) ?? "Prospect",
          state: c.state,
          ...(c.acceptedAt === null ? {} : { acceptedAt: c.acceptedAt }),
          expiresAt: c.expiresAt ?? c.reviewDeadlineAt,
          ...(message === undefined ? {} : { sellerMessage: message }),
          reviewState: latest === undefined ? "NONE" : latest.state,
          reviewAvailable: o22.reviewAvailable({ claimState: c.state, liveRefusalId: c.refusalId, reviewedRefusalIds: new Set(mine.map((r) => r.refusalId)) }),
          version: c.version,
        };
      });
      return { kind: "READ" as const, data: { items } };
    }),
  );
}

/** GetMyClaimHistory (own seller) and GetClaimHistory (KAURO_OWNER): the seller's projection carries no reason, evidence or note. */
export function claimHistory(runAs: RunAs, userId: string, correlationId: string, claimId: string, audience: "SELLER" | "KAURO_OWNER"): Promise<O22Result<{ readonly items: ReadonlyArray<o22.ClaimDecisionEntry | o22.SellerClaimDecisionEntry> }>> {
  return guarded(() =>
    runAs(userId, correlationId, async (s) => {
      const standing = await s.standing();
      if (audience === "KAURO_OWNER" ? !standing.owner : standing.sellerId === null) throw denied(audience === "KAURO_OWNER" ? "GetClaimHistory" : "GetMyClaimHistory");
      const claim = (await s.claimsOf(audience === "SELLER" ? standing.sellerId : null)).find((c) => c.claimId === claimId);
      if (claim === undefined) throw notFound("claim has this id");
      const entries = await s.history(claimId, audience === "KAURO_OWNER");
      return { kind: "READ" as const, data: { items: audience === "KAURO_OWNER" ? entries : entries.map(o22.sellerEntryOf) } };
    }),
  );
}

// --- alerts -----------------------------------------------------------------------------------------------------------------------------------------

/** The claim subjects of the alerts: accepted claims count to their acceptance window's end; open ones to their review deadline. */
function claimSubjects(claims: ReadonlyArray<ClaimRow>): ReadonlyArray<o22.AlertSubject> {
  return claims
    .filter((c) => c.state === "ACCEPTED" || c.state === "SUBMITTED" || c.state === "DISPUTED")
    .map((c) => ({ subjectKind: "CLAIM" as const, subjectId: c.claimId, sellerId: c.sellerId, endsAt: c.expiresAt ?? c.reviewDeadlineAt }));
}

/**
 * ListOwnerAlerts (KAURO_OWNER): one alert per subject. The project and pilot subjects come from `projectSubjects` (no source is bound
 * yet: their facts belong to other orders' reads, so the owner's list holds claim alerts until one is), never invented here.
 */
export function listOwnerAlerts(runAs: RunAs, userId: string, correlationId: string, projectSubjects: (store: O22Store) => Promise<ReadonlyArray<o22.AlertSubject>>): Promise<O22Result<{ readonly items: ReadonlyArray<o22.Alert> }>> {
  return guarded(() =>
    runAs(userId, correlationId, async (s) => {
      if (!(await s.standing()).owner) throw denied("ListOwnerAlerts");
      const alerts = o22.alertsAt([...claimSubjects(await s.claimsOf(null)), ...(await projectSubjects(s))], await s.now());
      // the owner's Alert carries no sellerId member (the candidate contract names agencyId for projects only)
      return { kind: "READ" as const, data: { items: alerts.slice(0, 100).map(({ sellerId: _seller, ...a }) => a) } };
    }),
  );
}

/** ListMyAlerts (own seller): the seller's own claim alerts only (SellerAlertView). */
export function listMyAlerts(runAs: RunAs, userId: string, correlationId: string): Promise<O22Result<{ readonly items: ReadonlyArray<o22.SellerAlertView> }>> {
  return guarded(() =>
    runAs(userId, correlationId, async (s) => {
      const { sellerId } = await s.standing();
      if (sellerId === null) throw denied("ListMyAlerts");
      const alerts = o22.alertsAt(claimSubjects(await s.claimsOf(sellerId)), await s.now());
      return { kind: "READ" as const, data: { items: o22.sellerAlertsOf(alerts, sellerId).slice(0, 100) } };
    }),
  );
}
