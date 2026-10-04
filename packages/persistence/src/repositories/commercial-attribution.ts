/**
 * Attribution over `pg` (mandate B10-ADAPTERS-SALES; migration 0029; docs/design/B10-commercial-domain.md §5, §8.2, §10;
 * decisions D10-CLAIM-1, D10-ATTR-1, D10-ATTR-2, D10-ASSIST-2, D10-TX-1, D10-CLOCK-1): claims with their evidence under the prospect's
 * claims lock and the conflicts that make a new claim DISPUTED, the owner's allocations frozen once with their shares, and the
 * entitlements the commission service creates at conversion — the AttributionRepository port of @kauro/domain.
 *
 * Every read goes through the policies of the unit of work's session (D10-CTX-3). Every instant recorded is kauro.server_now(): a
 * claim's submission and its 2160-hour review deadline, an acceptance and its 2160-hour end (equal to the freeze of the allocation that
 * rules it), a rejection, a lapse, a conversion. An entitlement's first capture and window are the agency's first designation as the
 * database holds it (agency_recurrence), written from that row so no instant loses its microseconds in transit; the caller's canonical
 * view of them is checked against it. The database repeats every rule: one live claim per seller and prospect (CLAIM_EXISTS), one frozen
 * allocation per agency (ATTRIBUTION_EXISTS), shares of exactly 10000 bps of accepted claims under signed agreements (KC003), the lapse,
 * conversion and entitlement edges.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  type AgencyId,
  type AllocationShare,
  type AssistanceAgreementId,
  type AttributionAllocationId,
  type AttributionAllocationRecord,
  type AttributionClaimId,
  type AttributionClaimRecord,
  type AttributionClaimState,
  type AttributionRepository,
  type CaptureId,
  type ClaimActivityKind,
  type ClaimChange,
  type ClaimConflicts,
  type ClaimEvidenceRecord,
  type CommissionEntitlementId,
  type CommissionEntitlementRecord,
  type CommissionEntitlementState,
  type CommissionSource,
  type NewAttributionClaim,
  type NewCommissionEntitlement,
  type ProspectId,
  type SellerAgreementId,
  type SellerId,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
import { defined } from "./commerce-shared.js";
import { canonical, holdSalesTransition, instantOf, optionalInstantOf, optionalString, staleRow } from "./commercial-sales-rows.js";

/** The live states of a claim (attribution_claims_one_live_per_seller). */
const LIVE = "('SUBMITTED', 'DISPUTED', 'ACCEPTED')";

const CLAIM = `claim_id, prospect_id, seller_id, agreement_id, agreement_version, evidence_hash, state, version, ${canonical("submitted_at")}, ${canonical("review_deadline_at")}, conflict_reason, agency_id,
  allocation_id, ${canonical("accepted_at")}, ${canonical("expires_at")}`;
interface ClaimRow {
  claim_id: string;
  prospect_id: string;
  seller_id: string;
  agreement_id: string;
  agreement_version: string;
  evidence_hash: string;
  state: AttributionClaimState;
  version: string;
  submitted_at: string;
  review_deadline_at: string;
  conflict_reason: string | null;
  agency_id: string | null;
  allocation_id: string | null;
  accepted_at: string | null;
  expires_at: string | null;
}
function claimRecord(r: ClaimRow): AttributionClaimRecord {
  return defined<AttributionClaimRecord>(
    {
      claimId: r.claim_id as AttributionClaimId,
      prospectId: r.prospect_id as ProspectId,
      sellerId: r.seller_id as SellerId,
      agreementId: r.agreement_id as SellerAgreementId,
      agreementVersion: r.agreement_version,
      evidenceHash: r.evidence_hash,
      state: r.state,
      version: int(r.version),
      submittedAt: instantOf(r.submitted_at),
      reviewDeadlineAt: instantOf(r.review_deadline_at),
      // registry AttributionClaim.expiresAt: the review deadline until the acceptance, the acceptance's end after it
      expiresAt: instantOf(r.expires_at ?? r.review_deadline_at),
    },
    {
      conflictReason: optionalString(r.conflict_reason),
      agencyId: optionalString<AgencyId>(r.agency_id),
      allocationId: optionalString<AttributionAllocationId>(r.allocation_id),
      acceptedAt: optionalInstantOf(r.accepted_at),
    },
  );
}

const ENTITLEMENT = `entitlement_id, agency_id, seller_id, kind, allocation_id, claim_id, assistance_agreement_id, first_capture_id, ${canonical("window_starts_at")}, ${canonical("window_ends_at")},
  agreement_id, agreement_version, share_bps, state, version, ${canonical("created_at")}`;
interface EntitlementRow {
  entitlement_id: string;
  agency_id: string;
  seller_id: string;
  kind: CommissionSource;
  allocation_id: string | null;
  claim_id: string | null;
  assistance_agreement_id: string | null;
  first_capture_id: string | null;
  window_starts_at: string | null;
  window_ends_at: string | null;
  agreement_id: string;
  agreement_version: string;
  share_bps: number;
  state: CommissionEntitlementState;
  version: string;
  created_at: string;
}
function entitlementRecord(r: EntitlementRow): CommissionEntitlementRecord {
  return defined<CommissionEntitlementRecord>(
    {
      entitlementId: r.entitlement_id as CommissionEntitlementId,
      agencyId: r.agency_id as AgencyId,
      sellerId: r.seller_id as SellerId,
      source: r.kind,
      agreementId: r.agreement_id as SellerAgreementId,
      agreementVersion: r.agreement_version,
      shareBps: r.share_bps,
      state: r.state,
      version: int(r.version),
      createdAt: instantOf(r.created_at),
    },
    {
      allocationId: optionalString<AttributionAllocationId>(r.allocation_id),
      claimId: optionalString<AttributionClaimId>(r.claim_id),
      assistanceAgreementId: optionalString<AssistanceAgreementId>(r.assistance_agreement_id),
      firstCaptureId: optionalString<CaptureId>(r.first_capture_id),
      windowStartsAt: optionalInstantOf(r.window_starts_at),
      windowEndsAt: optionalInstantOf(r.window_ends_at),
    },
  );
}

const ALLOCATION = `allocation_id, agency_id, prospect_id, identity_evidence_hash, ruling_reason, ruling_evidence_hash, first_bps, repeat_bps, recurring_months, version, ${canonical("prepared_at")}, ${canonical("frozen_at")}`;
interface AllocationRow {
  allocation_id: string;
  agency_id: string;
  prospect_id: string;
  identity_evidence_hash: string;
  ruling_reason: string;
  ruling_evidence_hash: string;
  first_bps: number;
  repeat_bps: number;
  recurring_months: number;
  version: string;
  prepared_at: string;
  frozen_at: string | null;
}

/** The window of D10-ATTR-2 in SQL, over the agency's first designation `r`: twelve calendar months at the same America/Bogota wall time. */
const WINDOW_END = "((r.first_confirmed_at AT TIME ZONE 'America/Bogota') + interval '12 months') AT TIME ZONE 'America/Bogota'";

export class PgAttributionRepository implements AttributionRepository {
  constructor(private readonly db: Queryable) {}

  // claims (D10-CLAIM-1) --------------------------------------------------------------------------------------------------------------

  /** The session's own claim evidence by hash (the seller's; CMD046 accepts no other). */
  async claimEvidence(evidenceHash: Sha256Hex): Promise<ClaimEvidenceRecord | null> {
    const r = await execute<{ evidence_hash: string; seller_id: string; prospect_id: string; source_channel: string; first_meaningful_contact_at: string; qualified_need_hash: string; activity_kinds: string[]; recorded_at: string }>(
      this.db,
      `SELECT evidence_hash, seller_id, prospect_id, source_channel, ${canonical("first_meaningful_contact_at")}, qualified_need_hash, activity_kinds, ${canonical("recorded_at")}
         FROM kauro.claim_evidence WHERE seller_id = kauro.current_seller_id() AND evidence_hash = $1`,
      [evidenceHash],
    );
    const e = r.rows[0];
    if (e === undefined) return null;
    return {
      evidenceHash: e.evidence_hash,
      sellerId: e.seller_id as SellerId,
      prospectId: e.prospect_id as ProspectId,
      sourceChannel: e.source_channel,
      firstMeaningfulContactAt: instantOf(e.first_meaningful_contact_at),
      qualifiedNeedHash: e.qualified_need_hash,
      activityKinds: e.activity_kinds as ClaimActivityKind[],
      recordedAt: instantOf(e.recorded_at),
    };
  }

  /**
   * What makes a new claim of `sellerId` on the prospect DISPUTED (CMD046 conflict review; D10-CLAIM-1), read after the prospect's
   * claims lock: an ACCEPTED claim on the prospect's organization key, another seller's live claim on it, or an agency the organization
   * is linked to (by an allocation or a ruled claim) with a payment order or a qualifying purchase. Every fact is read through the
   * session's own policies (D10-CTX-3): the corporate owner's and the commission service's sessions read them all, a seller's session
   * only its own claims — another seller's claims, the allocations and the agency's orders are never a seller's to read.
   */
  async claimConflicts(prospectId: ProspectId, sellerId: SellerId): Promise<ClaimConflicts> {
    const r = await execute<{ accepted: boolean; competing: boolean; history: boolean }>(
      this.db,
      `WITH target AS (SELECT organization_key FROM kauro.prospects WHERE prospect_id = $1),
            organization AS (SELECT p.prospect_id FROM kauro.prospects p JOIN target t ON t.organization_key = p.organization_key UNION SELECT $1::uuid),
            claims AS (SELECT c.seller_id, c.state, c.agency_id FROM kauro.attribution_claims c JOIN organization o ON o.prospect_id = c.prospect_id),
            linked AS (
              SELECT a.agency_id FROM kauro.attribution_allocations a JOIN organization o ON o.prospect_id = a.prospect_id
              UNION SELECT c.agency_id FROM claims c WHERE c.agency_id IS NOT NULL)
       SELECT EXISTS (SELECT 1 FROM claims WHERE state = 'ACCEPTED') AS accepted,
              EXISTS (SELECT 1 FROM claims WHERE seller_id <> $2 AND state IN ${LIVE}) AS competing,
              EXISTS (
                SELECT 1 FROM linked l
                 WHERE EXISTS (SELECT 1 FROM kauro.payment_orders po WHERE po.agency_id = l.agency_id)
                    OR EXISTS (SELECT 1 FROM kauro.qualifying_purchases q WHERE q.agency_id = l.agency_id)) AS history`,
      [prospectId, sellerId],
    );
    const row = r.rows[0];
    return { acceptedClaimOnOrganization: row?.accepted === true, otherSellersLiveClaim: row?.competing === true, customerHistory: row?.history === true };
  }

  /**
   * CMD046: the claim born SUBMITTED at the server's instant with its 2160-hour review deadline, under its seller's active agreement
   * (the database checks the seller ACTIVE on it after the seller's transition lock) — and, when the conflict review found a conflict,
   * moved DISPUTED with its reason in the same transaction (the seller's own edge, attribution_claims_seller_conflict). A second live
   * claim of the seller on the prospect is CLAIM_EXISTS. The claims of one prospect serialize on its claims lock (the insert's trigger).
   */
  async submitClaim(claim: NewAttributionClaim): Promise<AttributionClaimRecord> {
    if (claim.state === "DISPUTED" && (claim.conflictReason === undefined || claim.conflictReason.length === 0)) {
      throw new DomainFailure("INTEGRITY_FAILURE", "a claim born DISPUTED names its conflict");
    }
    const r = await execute<ClaimRow>(
      this.db,
      `INSERT INTO kauro.attribution_claims (claim_id, prospect_id, seller_id, agreement_id, agreement_version, evidence_hash, submitted_at, review_deadline_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), kauro.server_now() + interval '2160 hours', kauro.server_now(), kauro.server_now())
       RETURNING ${CLAIM}`,
      [claim.claimId, claim.prospectId, claim.sellerId, claim.agreementId, claim.agreementVersion, claim.evidenceHash],
    );
    const born = r.rows[0] as ClaimRow;
    if (claim.state === "SUBMITTED") return claimRecord(born);
    const disputed = await execute<ClaimRow>(
      this.db,
      `UPDATE kauro.attribution_claims SET state = 'DISPUTED', conflict_reason = $2, version = version + 1 WHERE claim_id = $1 AND version = 1 RETURNING ${CLAIM}`,
      [claim.claimId, claim.conflictReason],
    );
    return claimRecord(disputed.rows[0] as ClaimRow);
  }

  async getClaim(claimId: AttributionClaimId): Promise<AttributionClaimRecord | null> {
    const r = await execute<ClaimRow>(this.db, `SELECT ${CLAIM} FROM kauro.attribution_claims WHERE claim_id = $1`, [claimId]);
    return r.rows[0] ? claimRecord(r.rows[0]) : null;
  }

  async lockAgencies(agencyIds: ReadonlyArray<AgencyId>): Promise<void> {
    // ascending, one statement each: the lock order is the id order. The owner's session cannot lock an agency row (its update policy is the
    // tenant's), so the agency's commission work serializes on a transition subject of its own, held to COMMIT.
    for (const agencyId of [...new Set(agencyIds)].sort()) await execute(this.db, "SELECT pg_advisory_xact_lock(kauro.transition_key('kauro.agency_commissions', $1))", [agencyId]);
  }

  /** The claim FOR UPDATE, after the writer's half of its prospect's claims lock (CMD047, CMD050, the conversion). */
  async lockClaim(claimId: AttributionClaimId): Promise<AttributionClaimRecord | null> {
    const prospect = (await execute<{ prospect_id: string }>(this.db, "SELECT prospect_id FROM kauro.attribution_claims WHERE claim_id = $1", [claimId])).rows[0];
    if (prospect === undefined) return null;
    await holdSalesTransition(this.db, "kauro.attribution_claims", prospect.prospect_id);
    const r = await execute<ClaimRow>(this.db, `SELECT ${CLAIM} FROM kauro.attribution_claims WHERE claim_id = $1 FOR UPDATE`, [claimId]);
    return r.rows[0] ? claimRecord(r.rows[0]) : null;
  }

  /**
   * Whether the claim's agency's first designation admits its conversion, by the database's own comparison and at its own grain (the
   * microsecond; the conversion guard `attribution_claims_ending` is the same condition): the first purchase confirmed before the claim's end
   * (its termination tail's end when a termination enumerated it, else its acceptance window's) and the claim submitted before that purchase's
   * order. Never decided in JavaScript milliseconds: a confirmation inside the millisecond before the end is before it (D10-GAP-18).
   */
  async convertibleAtFirstPurchase(claimId: AttributionClaimId): Promise<boolean> {
    const r = await execute<{ ok: boolean }>(
      this.db,
      `SELECT (r.first_confirmed_at < coalesce((SELECT max(t.ends_at) FROM kauro.termination_tail_entries t WHERE t.claim_id = c.claim_id), c.expires_at)
                AND c.submitted_at < q.order_created_at) AS ok
         FROM kauro.attribution_claims c
         JOIN kauro.agency_recurrence r ON r.agency_id = c.agency_id
         JOIN kauro.qualifying_purchases q ON q.agency_id = r.agency_id AND q.authorization_id = r.first_authorization_id
        WHERE c.claim_id = $1`,
      [claimId],
    );
    return r.rows[0]?.ok === true;
  }

  async claimsOfProspect(prospectId: ProspectId): Promise<ReadonlyArray<AttributionClaimRecord>> {
    const r = await execute<ClaimRow>(this.db, `SELECT ${CLAIM} FROM kauro.attribution_claims WHERE prospect_id = $1 ORDER BY submitted_at, claim_id`, [prospectId]);
    return r.rows.map(claimRecord);
  }

  async openClaimsOf(sellerId: SellerId): Promise<ReadonlyArray<AttributionClaimRecord>> {
    const r = await execute<ClaimRow>(this.db, `SELECT ${CLAIM} FROM kauro.attribution_claims WHERE seller_id = $1 AND state IN ${LIVE} ORDER BY submitted_at, claim_id`, [sellerId]);
    return r.rows.map(claimRecord);
  }

  /**
   * A compare-and-swap of the claim along the AttributionClaim machine. claim_accepted records the agency, the ruling allocation, the
   * acceptance at the server's instant (the allocation's freeze in the same transaction) and its end 2160 hours later, and the deciding
   * owner; claim_rejected the agency, the ruling allocation, the instant and the owner; claim_lapsed and first_purchase_confirmed their
   * instant. The database checks each edge's facts (the ruling at COMMIT, KC003; the lapse; the conversion and its entitlement).
   */
  async transitionClaim(claimId: AttributionClaimId, expectedVersion: number, change: ClaimChange, _now: UtcInstant): Promise<VersionedWrite<AttributionClaimRecord>> {
    const params: unknown[] = [claimId, expectedVersion, change.state];
    const sets = ["version = c.version + 1", "state = $3"];
    if (change.state === "ACCEPTED" || change.state === "REJECTED") {
      if (change.agencyId === undefined || change.allocationId === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a ruling names its agency and its allocation");
      params.push(change.agencyId, change.allocationId);
      sets.push(`agency_id = $${params.length - 1}`, `allocation_id = $${params.length}`, "decided_by_user_id = kauro.current_user_id()");
      if (change.state === "ACCEPTED") sets.push("accepted_at = kauro.server_now()", "expires_at = kauro.server_now() + interval '2160 hours'");
      else sets.push("rejected_at = kauro.server_now()");
    } else if (change.state === "EXPIRED") {
      sets.push("lapsed_at = kauro.server_now()");
    } else if (change.state === "CONVERTED") {
      sets.push("converted_at = kauro.server_now()");
    }
    const r = await execute<ClaimRow>(this.db, `UPDATE kauro.attribution_claims AS c SET ${sets.join(", ")} WHERE c.claim_id = $1 AND c.version = $2 RETURNING ${CLAIM}`, params);
    const row = r.rows[0];
    if (row === undefined) return staleRow(this.db, "SELECT version, state FROM kauro.attribution_claims WHERE claim_id = $1", claimId, "claim");
    return { kind: "APPLIED", record: claimRecord(row) };
  }

  /**
   * The CLAIM_WINDOWS sweep's work at the server's instant: SUBMITTED or DISPUTED claims past their review deadline, ACCEPTED claims past
   * their acceptance window — or past their termination tail's end when a termination enumerated them. Oldest deadline first.
   */
  async lapsedClaims(_now: UtcInstant, limit: number): Promise<ReadonlyArray<AttributionClaimRecord>> {
    const r = await execute<ClaimRow>(
      this.db,
      `SELECT ${CLAIM} FROM (
         SELECT c.*, CASE WHEN c.state = 'ACCEPTED' THEN coalesce((SELECT max(t.ends_at) FROM kauro.termination_tail_entries t WHERE t.claim_id = c.claim_id), c.expires_at) ELSE c.review_deadline_at END AS due
           FROM kauro.attribution_claims c WHERE c.state IN ${LIVE}) x
        WHERE x.due <= kauro.server_now()
        ORDER BY x.due, x.claim_id LIMIT $1`,
      [limit],
    );
    return r.rows.map(claimRecord);
  }

  // allocations (D10-ATTR-1) -------------------------------------------------------------------------------------------------------

  async getAllocation(allocationId: AttributionAllocationId): Promise<AttributionAllocationRecord | null> {
    const r = await execute<AllocationRow>(this.db, `SELECT ${ALLOCATION} FROM kauro.attribution_allocations WHERE allocation_id = $1`, [allocationId]);
    const row = r.rows[0];
    return row === undefined ? null : this.#allocationRecord(row);
  }

  async frozenAllocationOf(agencyId: AgencyId): Promise<AttributionAllocationRecord | null> {
    const r = await execute<AllocationRow>(this.db, `SELECT ${ALLOCATION} FROM kauro.attribution_allocations WHERE agency_id = $1 AND frozen_at IS NOT NULL`, [agencyId]);
    const row = r.rows[0];
    return row === undefined ? null : this.#allocationRecord(row);
  }

  /**
   * CMD047: the prepared allocation frozen once, at the server's instant, by the session's owner (attribution_allocations_freeze). At
   * COMMIT its shares must be exactly 10000 bps of claims it ACCEPTED at that instant under signed agreements (SHARES_NOT_WHOLE, KC003);
   * a second frozen allocation of the agency is ATTRIBUTION_EXISTS, and so is this one already frozen by an earlier acceptance.
   */
  async freezeAllocation(allocationId: AttributionAllocationId, _now: UtcInstant): Promise<AttributionAllocationRecord> {
    const r = await execute<AllocationRow>(
      this.db,
      `UPDATE kauro.attribution_allocations SET frozen_at = kauro.server_now(), frozen_by_user_id = kauro.current_user_id(), version = version + 1
        WHERE allocation_id = $1 AND frozen_at IS NULL RETURNING ${ALLOCATION}`,
      [allocationId],
    );
    const row = r.rows[0];
    if (row !== undefined) return this.#allocationRecord(row);
    const existing = await this.getAllocation(allocationId);
    if (existing === null) throw new DomainFailure("NOT_FOUND", "the allocation is not visible in this context");
    throw new DomainFailure("PRECONDITION_FAILED", "the allocation was already frozen", { reason: "ATTRIBUTION_EXISTS" });
  }

  async #allocationRecord(row: AllocationRow): Promise<AttributionAllocationRecord> {
    const shares = await execute<{ seller_id: string; claim_id: string; agreement_id: string; agreement_version: string; share_bps: number }>(
      this.db,
      "SELECT seller_id, claim_id, agreement_id, agreement_version, share_bps FROM kauro.allocation_shares WHERE allocation_id = $1 ORDER BY seller_id",
      [row.allocation_id],
    );
    const ruled = await execute<{ claim_id: string }>(this.db, "SELECT claim_id FROM kauro.attribution_claims WHERE allocation_id = $1 ORDER BY claim_id", [row.allocation_id]);
    return defined<AttributionAllocationRecord>(
      {
        allocationId: row.allocation_id as AttributionAllocationId,
        agencyId: row.agency_id as AgencyId,
        prospectId: row.prospect_id as ProspectId,
        identityEvidenceHash: row.identity_evidence_hash,
        ruledClaimIds: ruled.rows.map((c) => c.claim_id as AttributionClaimId),
        rulingReason: row.ruling_reason,
        rulingEvidenceHash: row.ruling_evidence_hash,
        firstBps: row.first_bps,
        repeatBps: row.repeat_bps,
        recurringMonths: row.recurring_months,
        shares: shares.rows.map(
          (s): AllocationShare => ({ sellerId: s.seller_id as SellerId, claimId: s.claim_id as AttributionClaimId, agreementId: s.agreement_id as SellerAgreementId, agreementVersion: s.agreement_version, shareBps: s.share_bps }),
        ),
        version: int(row.version),
        preparedAt: instantOf(row.prepared_at),
      },
      { frozenAt: optionalInstantOf(row.frozen_at) },
    );
  }

  // entitlements (D10-ATTR-2, D10-ASSIST-2) --------------------------------------------------------------------------------------------

  /**
   * Creates an entitlement once per (allocation, seller) or per assistance agreement; `created` is false for the one already there.
   * ACQUISITION (the commission service at conversion, in the agency it adopted; its claim CONVERTED in the same transaction): the first
   * capture, window start and window end are written from the agency's first designation (agency_recurrence), and the caller's view of
   * them — the first capture, and the start and end to the millisecond — must be that designation's (INTEGRITY_FAILURE otherwise).
   * ASSISTANCE: the agreement's one entitlement at 10000 bps, with no first capture and no window.
   */
  async createEntitlement(entitlement: NewCommissionEntitlement): Promise<{ readonly created: boolean; readonly record: CommissionEntitlementRecord }> {
    if (entitlement.source === "ACQUISITION") {
      const { allocationId, claimId, firstCaptureId, windowStartsAt, windowEndsAt } = entitlement;
      if (allocationId === undefined || claimId === undefined || firstCaptureId === undefined || windowStartsAt === undefined || windowEndsAt === undefined || entitlement.assistanceAgreementId !== undefined) {
        throw new DomainFailure("INTEGRITY_FAILURE", "an acquisition entitlement names its allocation, claim, first capture and window, and no assistance agreement");
      }
      const r = await execute<EntitlementRow>(
        this.db,
        `INSERT INTO kauro.commission_entitlements (entitlement_id, agency_id, seller_id, kind, allocation_id, claim_id, agreement_id, agreement_version, share_bps, first_capture_id, window_starts_at, window_ends_at, created_at, updated_at)
         SELECT $1, r.agency_id, $3, 'ACQUISITION', $4, $5, $6, $7, $8, r.first_capture_id, r.first_confirmed_at, ${WINDOW_END}, kauro.server_now(), kauro.server_now()
           FROM kauro.agency_recurrence r
          WHERE r.agency_id = $2 AND r.first_capture_id = $9
            AND date_trunc('milliseconds', r.first_confirmed_at) = $10::timestamptz AND date_trunc('milliseconds', ${WINDOW_END}) = $11::timestamptz
         ON CONFLICT DO NOTHING
         RETURNING ${ENTITLEMENT}`,
        [entitlement.entitlementId, entitlement.agencyId, entitlement.sellerId, allocationId, claimId, entitlement.agreementId, entitlement.agreementVersion, entitlement.shareBps, firstCaptureId, windowStartsAt, windowEndsAt],
      );
      if (r.rows[0]) return { created: true, record: entitlementRecord(r.rows[0]) };
      const existing = await execute<EntitlementRow>(this.db, `SELECT ${ENTITLEMENT} FROM kauro.commission_entitlements WHERE allocation_id = $1 AND seller_id = $2`, [allocationId, entitlement.sellerId]);
      if (existing.rows[0]) return { created: false, record: entitlementRecord(existing.rows[0]) };
      throw new DomainFailure("INTEGRITY_FAILURE", "an acquisition entitlement's first capture and window are its agency's first designation");
    }
    const assistanceAgreementId = entitlement.assistanceAgreementId;
    if (
      assistanceAgreementId === undefined ||
      entitlement.allocationId !== undefined ||
      entitlement.claimId !== undefined ||
      entitlement.firstCaptureId !== undefined ||
      entitlement.windowStartsAt !== undefined ||
      entitlement.windowEndsAt !== undefined
    ) {
      throw new DomainFailure("INTEGRITY_FAILURE", "an assistance entitlement names its assistance agreement only, with no allocation, claim, first capture or window");
    }
    const r = await execute<EntitlementRow>(
      this.db,
      `INSERT INTO kauro.commission_entitlements (entitlement_id, agency_id, seller_id, kind, assistance_agreement_id, agreement_id, agreement_version, share_bps, created_at, updated_at)
       VALUES ($1, $2, $3, 'ASSISTANCE', $4, $5, $6, $7, kauro.server_now(), kauro.server_now())
       ON CONFLICT DO NOTHING
       RETURNING ${ENTITLEMENT}`,
      [entitlement.entitlementId, entitlement.agencyId, entitlement.sellerId, assistanceAgreementId, entitlement.agreementId, entitlement.agreementVersion, entitlement.shareBps],
    );
    if (r.rows[0]) return { created: true, record: entitlementRecord(r.rows[0]) };
    const existing = await execute<EntitlementRow>(this.db, `SELECT ${ENTITLEMENT} FROM kauro.commission_entitlements WHERE assistance_agreement_id = $1`, [assistanceAgreementId]);
    if (existing.rows[0]) return { created: false, record: entitlementRecord(existing.rows[0]) };
    throw new DomainFailure("INTEGRITY_FAILURE", "the assistance entitlement was neither created nor found");
  }

  async getEntitlement(entitlementId: CommissionEntitlementId): Promise<CommissionEntitlementRecord | null> {
    const r = await execute<EntitlementRow>(this.db, `SELECT ${ENTITLEMENT} FROM kauro.commission_entitlements WHERE entitlement_id = $1`, [entitlementId]);
    return r.rows[0] ? entitlementRecord(r.rows[0]) : null;
  }

  async entitlementsOfAgency(agencyId: AgencyId): Promise<ReadonlyArray<CommissionEntitlementRecord>> {
    const r = await execute<EntitlementRow>(this.db, `SELECT ${ENTITLEMENT} FROM kauro.commission_entitlements WHERE agency_id = $1 ORDER BY created_at, entitlement_id`, [agencyId]);
    return r.rows.map(entitlementRecord);
  }

  async entitlementsOfSeller(sellerId: SellerId): Promise<ReadonlyArray<CommissionEntitlementRecord>> {
    const r = await execute<EntitlementRow>(this.db, `SELECT ${ENTITLEMENT} FROM kauro.commission_entitlements WHERE seller_id = $1 ORDER BY created_at, entitlement_id`, [sellerId]);
    return r.rows.map(entitlementRecord);
  }

  /**
   * A compare-and-swap of the entitlement along the CommissionEntitlement machine, at the server's instant: window_ended records the
   * expiry (the commission service), seller_terminated the termination (the owner, CMD050). The first capture, window, share and
   * agreement never change (kauro.forbid_column_change).
   */
  async transitionEntitlement(entitlementId: CommissionEntitlementId, expectedVersion: number, state: CommissionEntitlementState, _now: UtcInstant): Promise<VersionedWrite<CommissionEntitlementRecord>> {
    const sets = ["version = e.version + 1", "state = $3"];
    if (state === "EXPIRED") sets.push("expired_at = kauro.server_now()");
    if (state === "TERMINATED_WITH_RESIDUAL") sets.push("terminated_at = kauro.server_now()");
    const r = await execute<EntitlementRow>(this.db, `UPDATE kauro.commission_entitlements AS e SET ${sets.join(", ")} WHERE e.entitlement_id = $1 AND e.version = $2 RETURNING ${ENTITLEMENT}`, [entitlementId, expectedVersion, state]);
    const row = r.rows[0];
    if (row === undefined) return staleRow(this.db, "SELECT version, state FROM kauro.commission_entitlements WHERE entitlement_id = $1", entitlementId, "entitlement");
    return { kind: "APPLIED", record: entitlementRecord(row) };
  }

  /** The ENTITLEMENT_WINDOWS sweep's work at the server's instant: acquisition entitlements not yet EXPIRED whose window has ended. */
  async endedEntitlements(_now: UtcInstant, limit: number): Promise<ReadonlyArray<CommissionEntitlementRecord>> {
    const r = await execute<EntitlementRow>(
      this.db,
      `SELECT ${ENTITLEMENT} FROM kauro.commission_entitlements WHERE state <> 'EXPIRED' AND window_ends_at <= kauro.server_now() ORDER BY window_ends_at, entitlement_id LIMIT $1`,
      [limit],
    );
    return r.rows.map(entitlementRecord);
  }
}
