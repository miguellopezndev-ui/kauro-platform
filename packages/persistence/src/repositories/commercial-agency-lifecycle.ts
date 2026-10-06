/**
 * The agency lifecycle of package B10 over `pg` (mandate B10-AGENCY-LIFECYCLE; migration 0028; docs/design/B10-commercial-domain.md §4,
 * §8.1, §10, §12; decisions D10-AGY-1..D10-AGY-4, D10-TX-1, D10-CLOCK-1): the published agreement versions CMD002 accepts and the
 * append-only acceptance, the obligations inventory CMD043 records with the closure, the founding reservation a withdrawn quote
 * releases, and the reviewed relationship decisions of R2-141 (the AgencyLifecycleRepository port of @kauro/domain).
 *
 * Reads that a command relies on happen after the transition lock of the fact: a published version after the shared half of its
 * subject (`kauro.service_agreement_versions`, keyed `KIND:version`, taken by the control plane's retirement), and the closure's
 * inventory after the agency's own exclusive half — taken here, before the first read, so a payment order or refund that committed
 * before the closure is wholly seen and one that has not committed waits for it (the agency's shared half is B09's checkout and
 * capture reading it; B09's CreatePaymentOrder takes it, CloseAgency its row and exclusive half). Every instant the adapter records is
 * `kauro.server_now()` (the guards of 0028 compare an acceptance and a closure with the server clock); what a record carries back is the
 * domain's canonical instant (UTC, milliseconds), formatted by the database. The inventory is stored as a closed object of references,
 * counts and amounts — money as decimal strings — whose digest (the canonical profile) is `obligations_hash`.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { canonicalBytes, rawDigest } from "@kauro/contracts";
import {
  DomainFailure,
  isUtcInstant,
  type AgencyClosureId,
  type AgencyClosureRecord,
  type AgencyId,
  type AgencyLifecycleRepository,
  type AgreementAcceptanceId,
  type AgreementAcceptanceRecord,
  type AssuranceProofId,
  type ClosureCaseEntry,
  type ClosureFromState,
  type ClosureObligations,
  type CommercialAuthorizationId,
  type FoundingReservationId,
  type IdGenerator,
  type MembershipId,
  type NewAgencyClosure,
  type NewAgreementAcceptance,
  type PaymentOrderId,
  type QuoteId,
  type RelationshipDecisionId,
  type RelationshipDecisionRecord,
  type RelationshipTreatment,
  type ServiceAgreementKind,
  type ServiceAgreementState,
  type ServiceAgreementVersionRecord,
  type UserId,
} from "@kauro/domain";
import { execute, type Queryable } from "../sql.js";

const CANONICAL_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** SQL expression: a timestamptz column as the domain's canonical instant, aliased to the column's name. */
function canonical(column: string, alias: string = column.includes(".") ? (column.split(".").pop() as string) : column): string {
  return `to_char(${column} AT TIME ZONE 'UTC', ${CANONICAL_FORMAT}) AS ${alias}`;
}

function instantOf(v: unknown): UtcInstant {
  if (typeof v !== "string" || !isUtcInstant(v)) throw new TypeError("expected a canonical instant column value");
  return v;
}

// --- rows ---------------------------------------------------------------------------------------------------------------------------

interface VersionRow {
  agreement_kind: ServiceAgreementKind;
  version: string;
  document_hash: string;
  state: ServiceAgreementState;
  published_at: string;
  retired_at: string | null;
}

const VERSION = `agreement_kind, version, document_hash, state, ${canonical("published_at")}, ${canonical("retired_at")}`;

function versionRecord(r: VersionRow): ServiceAgreementVersionRecord {
  return {
    kind: r.agreement_kind,
    version: r.version,
    documentHash: r.document_hash as Sha256Hex,
    state: r.state,
    publishedAt: instantOf(r.published_at),
    ...(r.retired_at !== null ? { retiredAt: instantOf(r.retired_at) } : {}),
  };
}

interface AcceptanceRow {
  acceptance_id: string;
  agency_id: string;
  membership_id: string;
  user_id: string;
  terms_version: string;
  terms_document_hash: string;
  privacy_version: string;
  privacy_document_hash: string;
  legal_profile_ref: string | null;
  accepted_at: string;
}

/** The acceptance with the reviewed billing profile its activation named: the agency's legal_profile_ref (CMD002 writes both in one unit of work). */
const ACCEPTANCE = `a.acceptance_id, a.agency_id, a.membership_id, a.user_id, a.terms_version, a.terms_document_hash, a.privacy_version, a.privacy_document_hash, g.legal_profile_ref, ${canonical("a.accepted_at")}`;

function acceptanceRecord(r: AcceptanceRow, legalProfileRef: string | undefined): AgreementAcceptanceRecord {
  return {
    acceptanceId: r.acceptance_id as AgreementAcceptanceId,
    agencyId: r.agency_id as AgencyId,
    membershipId: r.membership_id as MembershipId,
    userId: r.user_id as UserId,
    termsVersion: r.terms_version,
    termsDocumentHash: r.terms_document_hash as Sha256Hex,
    privacyAgreementVersion: r.privacy_version,
    privacyDocumentHash: r.privacy_document_hash as Sha256Hex,
    legalProfileRef: r.legal_profile_ref ?? legalProfileRef ?? "",
    acceptedAt: instantOf(r.accepted_at),
  };
}

/** The closed object the closure stores: references, counts and amounts as decimal strings (a bigint is no JSON value). */
interface StoredObligations {
  readonly inFlight: { readonly paymentOrderIds: ReadonlyArray<string>; readonly refundIds: ReadonlyArray<string> };
  readonly openQuoteIds: ReadonlyArray<string>;
  readonly withdrawnQuoteIds: ReadonlyArray<string>;
  readonly liveAuthorizationIds: ReadonlyArray<string>;
  readonly openRefundIds: ReadonlyArray<string>;
  readonly nonTerminalTaxDocumentIds: ReadonlyArray<string>;
  readonly openCases: ReadonlyArray<{ readonly caseId: string; readonly kind: string; readonly detailCode?: string; readonly amountCents?: string; readonly openedAt: string }>;
  readonly activeWork: number;
}

function storedOf(obligations: ClosureObligations, withdrawnQuoteIds: ReadonlyArray<QuoteId>): StoredObligations {
  return {
    inFlight: { paymentOrderIds: [...obligations.inFlight.paymentOrderIds], refundIds: [...obligations.inFlight.refundIds] },
    openQuoteIds: [...obligations.openQuoteIds],
    withdrawnQuoteIds: [...withdrawnQuoteIds],
    liveAuthorizationIds: [...obligations.liveAuthorizationIds],
    openRefundIds: [...obligations.openRefundIds],
    nonTerminalTaxDocumentIds: [...obligations.nonTerminalTaxDocumentIds],
    openCases: obligations.openCases.map((c) => ({
      caseId: c.caseId,
      kind: c.kind,
      ...(c.detailCode !== undefined ? { detailCode: c.detailCode } : {}),
      ...(c.amountCents !== undefined ? { amountCents: c.amountCents.toString() } : {}),
      openedAt: c.openedAt,
    })),
    activeWork: obligations.activeWork,
  };
}

function obligationsOf(stored: StoredObligations): ClosureObligations {
  return {
    inFlight: { paymentOrderIds: stored.inFlight.paymentOrderIds as ReadonlyArray<PaymentOrderId>, refundIds: stored.inFlight.refundIds },
    openQuoteIds: stored.openQuoteIds as ReadonlyArray<QuoteId>,
    liveAuthorizationIds: stored.liveAuthorizationIds as ReadonlyArray<CommercialAuthorizationId>,
    openRefundIds: stored.openRefundIds,
    nonTerminalTaxDocumentIds: stored.nonTerminalTaxDocumentIds,
    openCases: stored.openCases.map(
      (c): ClosureCaseEntry => ({
        caseId: c.caseId,
        kind: c.kind,
        ...(c.detailCode !== undefined ? { detailCode: c.detailCode } : {}),
        ...(c.amountCents !== undefined ? { amountCents: BigInt(c.amountCents) } : {}),
        openedAt: instantOf(c.openedAt),
      }),
    ),
    activeWork: stored.activeWork,
  };
}

interface ClosureRow {
  closure_id: string;
  agency_id: string;
  requested_by_membership_id: string;
  requested_by_user_id: string;
  assurance_proof_ref: string;
  from_state: ClosureFromState;
  obligations: StoredObligations;
  obligations_hash: string;
  deletion_scheduled_for: string | null;
  requested_at: string;
}

const CLOSURE = `closure_id, agency_id, requested_by_membership_id, requested_by_user_id, assurance_proof_ref, from_state, obligations, obligations_hash, ${canonical("deletion_scheduled_for")}, ${canonical("requested_at")}`;

function closureRecord(r: ClosureRow): AgencyClosureRecord {
  return {
    closureId: r.closure_id as AgencyClosureId,
    agencyId: r.agency_id as AgencyId,
    membershipId: r.requested_by_membership_id as MembershipId,
    requestedByUserId: r.requested_by_user_id as UserId,
    assuranceProofId: r.assurance_proof_ref as AssuranceProofId,
    fromState: r.from_state,
    obligations: obligationsOf(r.obligations),
    obligationsHash: r.obligations_hash as Sha256Hex,
    withdrawnQuoteIds: r.obligations.withdrawnQuoteIds as ReadonlyArray<QuoteId>,
    deletionScheduledAt: instantOf(r.deletion_scheduled_for),
    requestedAt: instantOf(r.requested_at),
  };
}

interface DecisionRow {
  decision_id: string;
  agency_id: string;
  related_agency_id: string;
  treatment: RelationshipTreatment;
  evidence_hash: string;
  reviewed_by_user_id: string;
  effective_at: string;
  decided_at: string;
}

const DECISION = `decision_id, agency_id, related_agency_id, treatment, evidence_hash, reviewed_by_user_id, ${canonical("effective_at")}, ${canonical("decided_at")}`;

function decisionRecord(r: DecisionRow): RelationshipDecisionRecord {
  return {
    decisionId: r.decision_id as RelationshipDecisionId,
    agencyId: r.agency_id as AgencyId,
    relatedAgencyId: r.related_agency_id as AgencyId,
    treatment: r.treatment,
    evidenceHash: r.evidence_hash as Sha256Hex,
    reviewedBy: r.reviewed_by_user_id as UserId,
    effectiveAt: instantOf(r.effective_at),
    decidedAt: instantOf(r.decided_at),
  };
}

const idsOf = <T extends string = string>(rows: ReadonlyArray<{ readonly id: string }>): T[] => rows.map((r) => r.id as unknown as T);

// --- the adapter --------------------------------------------------------------------------------------------------------------------

export class PgAgencyLifecycleRepository implements AgencyLifecycleRepository {
  /** `_ids` is the unit of work's generator the stage-2 integrator binds; every id this adapter records is minted by its caller. */
  constructor(
    private readonly db: Queryable,
    _ids: IdGenerator,
  ) {}

  async publishedVersion(kind: ServiceAgreementKind, version: string): Promise<ServiceAgreementVersionRecord | null> {
    // the shared half of the version's subject first (the control plane's retirement holds the writer's half; the acceptance's own guard
    // waits for the same key), then the row: a retirement committed before the read is seen, one in flight is waited for
    await execute(this.db, "SELECT kauro.await_transition('kauro.service_agreement_versions', $1)", [`${kind}:${version}`]);
    const r = await execute<VersionRow>(this.db, `SELECT ${VERSION} FROM kauro.service_agreement_versions WHERE agreement_kind = $1 AND version = $2 AND state = 'PUBLISHED'`, [kind, version]);
    const row = r.rows[0];
    return row === undefined ? null : versionRecord(row);
  }

  async recordAcceptance(acceptance: NewAgreementAcceptance): Promise<AgreementAcceptanceRecord> {
    // the accepting person is the named membership's own: the database admits the insert only for the session's own person (policy), the
    // agency's ACTIVE OWNER (agency_agreement_acceptances_guard, KA010) and the PUBLISHED versions (23514), each naming its document
    const r = await execute<AcceptanceRow>(
      this.db,
      `WITH inserted AS (
         INSERT INTO kauro.agency_agreement_acceptances (acceptance_id, agency_id, membership_id, user_id, terms_version, terms_document_hash, privacy_version, privacy_document_hash, accepted_at, created_at)
         SELECT $1, $2, $3, m.user_id, $4, $5, $6, $7, kauro.server_now(), now()
           FROM kauro.memberships m WHERE m.agency_id = $2 AND m.membership_id = $3
         RETURNING *
       )
       SELECT ${ACCEPTANCE} FROM inserted a LEFT JOIN kauro.agencies g ON g.agency_id = a.agency_id`,
      [acceptance.acceptanceId, acceptance.agencyId, acceptance.membershipId, acceptance.terms.version, acceptance.terms.documentHash, acceptance.privacy.version, acceptance.privacy.documentHash],
    );
    const row = r.rows[0];
    if (row === undefined) throw new DomainFailure("NOT_FOUND", "the accepting membership is not visible in this context");
    return acceptanceRecord(row, acceptance.legalProfileRef);
  }

  async acceptancesOf(agencyId: AgencyId): Promise<ReadonlyArray<AgreementAcceptanceRecord>> {
    const r = await execute<AcceptanceRow>(this.db, `SELECT ${ACCEPTANCE} FROM kauro.agency_agreement_acceptances a LEFT JOIN kauro.agencies g ON g.agency_id = a.agency_id WHERE a.agency_id = $1 ORDER BY a.accepted_at, a.acceptance_id`, [agencyId]);
    return r.rows.map((row) => acceptanceRecord(row, undefined));
  }

  async lockTransition(agencyId: AgencyId): Promise<void> {
    // the exclusive half before the agency's row lock: a reader holding the shared half may wait for the row's KEY SHARE (a foreign
    // key it inserts), so a writer that held the row first and asked for this half after would wait for that reader (D10-TX-1)
    await execute(this.db, "SELECT pg_advisory_xact_lock(kauro.transition_key('kauro.agencies', $1))", [agencyId]);
  }

  async closureObligations(agencyId: AgencyId, activeWork: number): Promise<ClosureObligations> {
    // the agency's exclusive half before any read: a checkout or capture in flight holds the shared half, so the closure waits for it,
    // and reads what it committed; one arriving after waits behind the closure and reads the agency CLOSING (D10-TX-1)
    await execute(this.db, "SELECT pg_advisory_xact_lock(kauro.transition_key('kauro.agencies', $1))", [agencyId]);
    const orders = await execute<{ id: string }>(this.db, "SELECT order_id AS id FROM kauro.payment_orders WHERE agency_id = $1 AND state NOT IN ('CAPTURED', 'FAILED', 'CANCELLED', 'EXPIRED') ORDER BY order_id", [agencyId]);
    const inFlightRefunds = await execute<{ id: string }>(this.db, "SELECT refund_id AS id FROM kauro.refunds WHERE agency_id = $1 AND state IN ('SUBMITTING', 'UNCERTAIN') ORDER BY refund_id", [agencyId]);
    // an open quote: not yet accepted, or accepted for a checkout that never captured and holds no authorization (the release guard of
    // 0016 refuses the withdrawal of a quote whose purchase stands)
    const quotes = await execute<{ id: string }>(
      this.db,
      `SELECT q.quote_id AS id FROM kauro.quotes q
        WHERE q.agency_id = $1
          AND (q.state IN ('DRAFT', 'ISSUED')
               OR (q.state = 'ACCEPTED_FOR_CHECKOUT'
                   AND NOT EXISTS (SELECT 1 FROM kauro.payment_orders o WHERE o.agency_id = q.agency_id AND o.quote_id = q.quote_id AND o.state = 'CAPTURED')
                   AND NOT EXISTS (SELECT 1 FROM kauro.commercial_authorizations a WHERE a.agency_id = q.agency_id AND a.quote_id = q.quote_id AND a.state <> 'REVOKED')))
        ORDER BY q.quote_id`,
      [agencyId],
    );
    const authorizations = await execute<{ id: string }>(this.db, "SELECT authorization_id AS id FROM kauro.commercial_authorizations WHERE agency_id = $1 AND state IN ('ACTIVE', 'CONSUMED') ORDER BY authorization_id", [agencyId]);
    const openRefunds = await execute<{ id: string }>(this.db, "SELECT refund_id AS id FROM kauro.refunds WHERE agency_id = $1 AND state IN ('REQUESTED', 'APPROVED') ORDER BY refund_id", [agencyId]);
    const documents = await execute<{ id: string }>(this.db, "SELECT document_id AS id FROM kauro.tax_documents WHERE agency_id = $1 AND state IN ('DRAFT', 'VALIDATED', 'SUBMITTING', 'UNCERTAIN', 'REJECTED') ORDER BY document_id", [agencyId]);
    const cases = await execute<{ case_id: string; kind: string; detail_code: string; amount_cents: string | null; opened_at: string }>(
      this.db,
      `SELECT case_id, kind, detail_code, amount_cents::text AS amount_cents, ${canonical("opened_at")} FROM kauro.reconciliation_cases WHERE agency_id = $1 AND state = 'OPEN' ORDER BY opened_at, case_id`,
      [agencyId],
    );
    return {
      inFlight: { paymentOrderIds: idsOf<PaymentOrderId>(orders.rows), refundIds: idsOf(inFlightRefunds.rows) },
      openQuoteIds: idsOf<QuoteId>(quotes.rows),
      liveAuthorizationIds: idsOf<CommercialAuthorizationId>(authorizations.rows),
      openRefundIds: idsOf(openRefunds.rows),
      nonTerminalTaxDocumentIds: idsOf(documents.rows),
      openCases: cases.rows.map(
        (c): ClosureCaseEntry => ({ caseId: c.case_id, kind: c.kind, detailCode: c.detail_code, ...(c.amount_cents !== null ? { amountCents: BigInt(c.amount_cents) } : {}), openedAt: instantOf(c.opened_at) }),
      ),
      activeWork,
    };
  }

  async releaseFoundingReservation(quoteId: QuoteId): Promise<FoundingReservationId | null> {
    const released = await execute<{ reservation_id: string; policy_version: string; slot_no: number }>(
      this.db,
      `UPDATE kauro.founding_slot_reservations SET state = 'RELEASED', released_at = kauro.server_now(), release_reason = 'QUOTE_WITHDRAWN', version = version + 1
        WHERE quote_id = $1 AND state IN ('RESERVED', 'RECONCILIATION_HOLD')
        RETURNING reservation_id, policy_version, slot_no`,
      [quoteId],
    );
    const row = released.rows[0];
    if (row === undefined) return null;
    // the slot is freed in the same transaction (checked at COMMIT, KC014)
    await execute(this.db, "UPDATE kauro.founding_slots SET held = false, live_reservation_id = NULL, live_agency_id = NULL, updated_at = now() WHERE policy_version = $1 AND slot_no = $2 AND live_reservation_id = $3", [row.policy_version, row.slot_no, row.reservation_id]);
    return row.reservation_id as FoundingReservationId;
  }

  async recordClosure(closure: NewAgencyClosure): Promise<AgencyClosureRecord> {
    const stored = storedOf(closure.obligations, closure.withdrawnQuoteIds);
    const hash = rawDigest(canonicalBytes(stored));
    // the instants are the server's; the schedule is the interval the caller computed (exact hours) after the server's request instant
    const scheduleMs = Date.parse(closure.deletionScheduledAt) - Date.parse(closure.requestedAt);
    if (!Number.isFinite(scheduleMs) || scheduleMs < 0) throw new DomainFailure("INTEGRITY_FAILURE", "a closure schedules its managed deletion after its request");
    const r = await execute<ClosureRow>(
      this.db,
      `WITH inserted AS (
         INSERT INTO kauro.agency_closures (closure_id, agency_id, requested_by_membership_id, requested_by_user_id, assurance_proof_ref, from_state, obligations, obligations_hash, deletion_scheduled_for, requested_at, created_at)
         SELECT $1, $2, $3, m.user_id, $4, $5, $6::jsonb, $7, kauro.server_now() + make_interval(secs => $8::double precision / 1000), kauro.server_now(), now()
           FROM kauro.memberships m WHERE m.agency_id = $2 AND m.membership_id = $3
         RETURNING *
       )
       SELECT ${CLOSURE} FROM inserted`,
      [closure.closureId, closure.agencyId, closure.membershipId, closure.assuranceProofId, closure.fromState, JSON.stringify(stored), hash, scheduleMs],
    );
    const row = r.rows[0];
    if (row === undefined) throw new DomainFailure("NOT_FOUND", "the requesting membership is not visible in this context");
    return closureRecord(row);
  }

  async closureOf(agencyId: AgencyId): Promise<AgencyClosureRecord | null> {
    const r = await execute<ClosureRow>(this.db, `SELECT ${CLOSURE} FROM kauro.agency_closures WHERE agency_id = $1`, [agencyId]);
    const row = r.rows[0];
    return row === undefined ? null : closureRecord(row);
  }

  async recordRelationshipDecision(decision: RelationshipDecisionRecord): Promise<RelationshipDecisionRecord> {
    // a reviewed record of the corporate owner (policy: its own person); it merges nothing and changes no eligibility (R2-141)
    const r = await execute<DecisionRow>(
      this.db,
      `WITH inserted AS (
         INSERT INTO kauro.agency_relationship_decisions (decision_id, agency_id, related_agency_id, treatment, evidence_hash, effective_at, reviewed_by_user_id, decided_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, kauro.server_now(), now())
         RETURNING *
       )
       SELECT ${DECISION} FROM inserted`,
      [decision.decisionId, decision.agencyId, decision.relatedAgencyId, decision.treatment, decision.evidenceHash, decision.effectiveAt, decision.reviewedBy],
    );
    return decisionRecord(r.rows[0] as DecisionRow);
  }

  async relationshipDecisionsOf(agencyId: AgencyId): Promise<ReadonlyArray<RelationshipDecisionRecord>> {
    const r = await execute<DecisionRow>(this.db, `SELECT ${DECISION} FROM kauro.agency_relationship_decisions WHERE agency_id = $1 OR related_agency_id = $1 ORDER BY decided_at, decision_id`, [agencyId]);
    return r.rows.map(decisionRecord);
  }

}
