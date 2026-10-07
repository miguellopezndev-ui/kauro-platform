/**
 * The recurrence history and CMD027's issuance core over `pg` (package B10; migration 0028; design §3.1, §3.2, §3.4, §10).
 *
 * The issuance core is one call in the global lock order of §10: the project's live quote FOR UPDATE and, when it is the previous
 * unpaid quote, SUPERSEDED (its transition lock) → the agency recurrence lock's shared half → the superseded quote's founding
 * reservation released with its slot → the founding slot taken in ascending order → the quote DRAFT → ISSUED over B09's quote model
 * and money kernel with its eligibility snapshot → the founding reservation recorded → `quote_issuances`. Every instant is the one the
 * caller read from the server (the quote's issuance instant) or kauro.server_now() (D10-CLOCK-1).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  baseServiceCents,
  quoteAmounts,
  quoteTermsHash,
  selectDiscount,
  termsMoney,
  type AgencyId,
  type AgencyRecurrenceRecord,
  type CaptureId,
  type EligibilityFinding,
  type EligibilityFindingKind,
  type EligibilitySnapshotId,
  type FoundingBasis,
  type FoundingOffer,
  type FoundingRepository,
  type FoundingReservationId,
  type FoundingReservationRecord,
  type JournalEntryId,
  type PaymentOrderId,
  type PricePolicy,
  type ProjectId,
  type QualifyingPurchaseId,
  type QualifyingPurchaseRecord,
  type QuoteId,
  type QuoteIssuance,
  type QuoteIssuanceRecord,
  type QuoteIssuanceRequest,
  type QuoteRecord,
  type QuoteRepository,
  type RecurrenceRepository,
  type AgencyDesignation,
  type PriceEligibilitySnapshotRecord,
} from "@kauro/domain";
import { execute, instant, int, optionalInstant, optionalText, text, type Queryable } from "../sql.js";
import { exact } from "../source/rows.js";
import { cents, defined, type CommerceWriteContext } from "./commerce-shared.js";

interface PurchaseRow {
  authorization_id: string;
  agency_id: string;
  project_id: string;
  quote_id: string;
  order_id: string;
  capture_id: string;
  confirmation_seq: number;
  confirmed_at: Date;
  provider_completed_at: Date | null;
  order_created_at: Date;
  allocated_service_cents: string;
  founding_basis: FoundingBasis;
  founding_reservation_id: string | null;
}

const PURCHASE_COLUMNS =
  "authorization_id, agency_id, project_id, quote_id, order_id, capture_id, confirmation_seq, confirmed_at, provider_completed_at, order_created_at, allocated_service_cents, founding_basis, founding_reservation_id";

function purchaseRecord(r: PurchaseRow): QualifyingPurchaseRecord {
  return defined<QualifyingPurchaseRecord>(
    {
      purchaseId: r.authorization_id as QualifyingPurchaseId,
      agencyId: r.agency_id as AgencyId,
      projectId: r.project_id as ProjectId,
      quoteId: r.quote_id as QuoteId,
      orderId: r.order_id as PaymentOrderId,
      captureId: r.capture_id as CaptureId,
      confirmationSeq: int(r.confirmation_seq),
      confirmedAt: instant(r.confirmed_at),
      orderCreatedAt: instant(r.order_created_at),
      allocatedServiceCents: cents(r.allocated_service_cents),
      foundingBasis: r.founding_basis,
    },
    { providerCompletedAt: optionalInstant(r.provider_completed_at), foundingReservationId: optionalText(r.founding_reservation_id) },
  );
}

interface RecurrenceRow {
  agency_id: string;
  confirmation_count: number;
  first_authorization_id: string;
  first_capture_id: string;
  first_project_id: string;
  first_confirmed_at: Date;
  last_confirmed_at: Date;
  updated_at: Date;
}

const RECURRENCE_COLUMNS = "agency_id, confirmation_count, first_authorization_id, first_capture_id, first_project_id, first_confirmed_at, last_confirmed_at, updated_at";

function recurrenceRecord(r: RecurrenceRow): AgencyRecurrenceRecord {
  return {
    agencyId: r.agency_id as AgencyId,
    lastConfirmationSeq: int(r.confirmation_count),
    firstPurchaseId: r.first_authorization_id as QualifyingPurchaseId,
    firstCaptureId: r.first_capture_id as CaptureId,
    firstProjectId: r.first_project_id as ProjectId,
    firstConfirmedAt: instant(r.first_confirmed_at),
    lastConfirmedAt: instant(r.last_confirmed_at),
    updatedAt: instant(r.updated_at),
  };
}

interface IssuanceRow {
  entry_id: string;
  agency_id: string;
  project_id: string;
  quote_id: string;
  eligibility_snapshot_id: string;
  reservation_id: string | null;
  superseded_quote_id: string | null;
  replaced_quote_id: string | null;
  issued_at: Date;
}

function issuanceRecord(r: IssuanceRow): QuoteIssuanceRecord {
  return defined<QuoteIssuanceRecord>(
    {
      journalEntryId: r.entry_id as JournalEntryId,
      agencyId: r.agency_id as AgencyId,
      projectId: r.project_id as ProjectId,
      quoteId: r.quote_id as QuoteId,
      snapshotId: r.eligibility_snapshot_id as EligibilitySnapshotId,
      issuedAt: instant(r.issued_at),
    },
    { reservationId: optionalText(r.reservation_id), supersededQuoteId: optionalText(r.superseded_quote_id), replacesQuoteId: optionalText(r.replaced_quote_id) },
  );
}

const LIVE_QUOTE_STATES: ReadonlySet<string> = new Set(["DRAFT", "ISSUED", "ACCEPTED_FOR_CHECKOUT"]);
/** quotes_one_live_per_project's predicate: an unpaid quote being drafted, issued or accepted, or an accepted replacement. */
const isLive = (q: { readonly state: string; readonly replacesQuoteId?: unknown }): boolean => q.state === "ACCEPTED_FOR_CHECKOUT" || (q.replacesQuoteId === undefined && LIVE_QUOTE_STATES.has(q.state));

export class PgRecurrenceRepository implements RecurrenceRepository {
  constructor(
    private readonly ctx: CommerceWriteContext,
    private readonly quotes: QuoteRepository,
    private readonly founding: FoundingRepository,
    private readonly policies: ReadonlyMap<string, PricePolicy>,
  ) {}

  private get db(): Queryable {
    return this.ctx.db;
  }

  async lockShared(agencyId: AgencyId): Promise<AgencyRecurrenceRecord | null> {
    // the shared half first (a designation committing meanwhile is wholly seen or wholly not), then the read in the next statement
    await execute(this.db, "SELECT kauro.await_transition('kauro.agency_recurrence', $1)", [agencyId]);
    return this.get(agencyId);
  }

  async get(agencyId: AgencyId): Promise<AgencyRecurrenceRecord | null> {
    const r = await execute<RecurrenceRow>(this.db, `SELECT ${RECURRENCE_COLUMNS} FROM kauro.agency_recurrence WHERE agency_id = $1`, [agencyId]);
    return r.rows[0] ? recurrenceRecord(r.rows[0]) : null;
  }

  async qualifyingProjectsAt(agencyId: AgencyId, asOf: UtcInstant, projectId: ProjectId): Promise<ReadonlyArray<ProjectId>> {
    const r = await execute<{ project_id: string }>(this.db, "SELECT project_id FROM kauro.qualifying_projects_at($1, $2, $3) ORDER BY project_id", [agencyId, asOf, projectId]);
    return r.rows.map((x) => x.project_id as ProjectId);
  }

  async getPurchase(purchaseId: QualifyingPurchaseId): Promise<QualifyingPurchaseRecord | null> {
    const r = await execute<PurchaseRow>(this.db, `SELECT ${PURCHASE_COLUMNS} FROM kauro.qualifying_purchases WHERE authorization_id = $1`, [purchaseId]);
    return r.rows[0] ? purchaseRecord(r.rows[0]) : null;
  }

  async purchaseOfCapture(captureId: CaptureId): Promise<QualifyingPurchaseRecord | null> {
    const r = await execute<PurchaseRow>(this.db, `SELECT ${PURCHASE_COLUMNS} FROM kauro.qualifying_purchases WHERE capture_id = $1`, [captureId]);
    return r.rows[0] ? purchaseRecord(r.rows[0]) : null;
  }

  async purchasesOf(agencyId: AgencyId): Promise<ReadonlyArray<QualifyingPurchaseRecord>> {
    const r = await execute<PurchaseRow>(this.db, `SELECT ${PURCHASE_COLUMNS} FROM kauro.qualifying_purchases WHERE agency_id = $1 ORDER BY confirmation_seq`, [agencyId]);
    return r.rows.map(purchaseRecord);
  }

  async issueQuote(request: QuoteIssuanceRequest): Promise<QuoteIssuance> {
    const policy = this.policies.get(request.pricePolicyVersion);
    if (policy === undefined) throw new DomainFailure("INTEGRITY_FAILURE", `price policy ${request.pricePolicyVersion} is not known to this unit of work`);
    const base = baseServiceCents(policy, request.mode, request.billableUnits);
    if (base === null) throw new DomainFailure("PRECONDITION_FAILED", "there is nothing to sell for these billable units", { reason: "NO_BILLABLE_UNITS" });

    // 1. the project's live quote, FOR UPDATE; the previous unpaid quote is SUPERSEDED by this one (its transition lock comes first)
    const superseded = await this.#supersedePrevious(request);

    // 2. the recurrence lock's shared half, then the snapshot's set at the issuance instant (one definition: kauro.qualifying_projects_at)
    const recurrence = await this.lockShared(request.agencyId);
    const qualifying = await this.qualifyingProjectsAt(request.agencyId, request.issuedAt, request.projectId);

    // 3. the superseded quote's reservation is released with its slot (reservation after slot in the order of §10)
    let released: FoundingReservationRecord | null = null;
    if (superseded !== null) {
      const previous = await this.founding.reservationOfQuote(superseded.quoteId);
      if (previous !== null && (previous.state === "RESERVED" || previous.state === "RECONCILIATION_HOLD")) {
        const write = await this.founding.release(previous.reservationId, previous.version, request.issuedAt);
        if (write.kind !== "APPLIED") throw new DomainFailure("STALE_VERSION", "the superseded quote's reservation changed", { currentVersion: write.currentVersion });
        released = write.record;
      }
    }

    // 4. founding eligibility: no qualifying purchase and no reservation of the cohort, ever (one per agency per cohort; D10-FOUND-1);
    //    the lowest free slot in ascending order when eligible
    const earlier = await this.founding.reservationOfAgency(policy.version, request.agencyId);
    const eligible = recurrence === null && earlier === null;
    const reservationId = this.ctx.ids.next() as FoundingReservationId;
    const slotNo = eligible ? await this.founding.takeSlot(policy.version, reservationId, request.agencyId) : null;
    const foundingOffer: FoundingOffer = !eligible ? "NOT_ELIGIBLE" : slotNo === null ? "NONE_AVAILABLE" : "RESERVED";

    // 5. the price over B09's quote model and money kernel
    const discount = selectDiscount(policy, { qualifyingCount: qualifying.length, foundingSlotReserved: slotNo !== null });
    const amounts = quoteAmounts({ baseServiceCents: base, discountBps: discount.appliedDiscountBps, tax: request.tax });
    // the quote's instants are exact to the microsecond (the database compares them for equality: expiry = issuance + quoteDays x 86400 s,
    // the lookback exactly 8760 hours, the reservation's end the quote's expiry), so they are computed by the database from the issuance instant
    const bounds = await execute<{ expires_at: string; lookback_starts_at: string; source_available_until: string }>(
      this.db,
      `SELECT ${exact("x.expires_at")}, ${exact("x.lookback_starts_at")}, ${exact("least(x.expires_at, $4::timestamptz)", "source_available_until")}
         FROM (SELECT $1::timestamptz + make_interval(secs => $2::double precision) AS expires_at, $1::timestamptz - make_interval(secs => $3::double precision) AS lookback_starts_at) x`,
      [request.issuedAt, policy.quoteDays * 86_400, policy.repeatLookbackDays * 86_400, request.sourceDeadline],
    );
    const expiresAt = bounds.rows[0]!.expires_at as UtcInstant;
    const lookbackStart = bounds.rows[0]!.lookback_starts_at as UtcInstant;
    const sourceAvailableUntil = bounds.rows[0]!.source_available_until as UtcInstant;
    const termsHash: Sha256Hex = quoteTermsHash({
      quoteId: request.quoteId,
      agencyId: request.agencyId,
      projectId: request.projectId,
      planId: request.planId,
      approvalId: request.approvalId,
      planHash: request.planHash,
      revisionHash: request.revisionHash,
      targetContractHash: request.targetContractHash,
      mode: request.mode,
      billableUnits: request.billableUnits,
      pricePolicyVersion: policy.version,
      discountPolicyVersion: policy.version,
      eligibilitySnapshotId: request.snapshotId,
      ...termsMoney(amounts),
      fiscalProfileId: request.fiscalProfileId,
      issuerRef: request.issuerRef,
      taxTreatment: request.tax.treatment,
      taxRule: request.tax.rule,
      taxRateBps: request.tax.rateBps,
      currency: "USD",
      issuedAt: request.issuedAt,
      expiresAt,
      sourceAvailableUntil,
      termsVersion: request.termsVersion,
    });
    const snapshot: PriceEligibilitySnapshotRecord = defined<PriceEligibilitySnapshotRecord>(
      {
        snapshotId: request.snapshotId,
        agencyId: request.agencyId,
        quoteId: request.quoteId,
        projectId: request.projectId,
        asOf: request.issuedAt,
        lookbackStartsAt: lookbackStart,
        qualifyingProjectIds: qualifying,
        qualifyingCount: qualifying.length,
        repeatDiscountBps: discount.repeatDiscountBps,
        foundingDiscountBps: discount.foundingDiscountBps,
        appliedDiscountBps: discount.appliedDiscountBps,
        policyVersion: policy.version,
      },
      { foundingSlotRef: slotNo === null ? undefined : reservationId },
    );

    // 6. the quote DRAFT -> ISSUED with its snapshot (quote.drafted.v1, quote.issued.v1), then the reservation of the slot taken
    const quote = await this.quotes.issue(
      {
        quoteId: request.quoteId,
        agencyId: request.agencyId,
        projectId: request.projectId,
        planId: request.planId,
        approvalId: request.approvalId,
        revisionHash: request.revisionHash,
        planHash: request.planHash,
        targetContractHash: request.targetContractHash,
        billableUnits: request.billableUnits,
        mode: request.mode,
        pricePolicyVersion: policy.version,
        discountPolicyVersion: policy.version,
        baseServiceCents: amounts.baseServiceCents,
        discountBps: amounts.discountBps,
        discountCents: amounts.discountCents,
        serviceCents: amounts.serviceCents,
        fiscalProfileId: request.fiscalProfileId,
        issuerRef: request.issuerRef,
        tax: request.tax,
        taxCents: amounts.taxCents,
        totalCents: amounts.totalCents,
        eligibilitySnapshotId: request.snapshotId,
        termsHash,
        termsVersion: request.termsVersion,
        issuedAt: request.issuedAt,
        expiresAt,
        sourceAvailableUntil,
        createdByMembershipId: request.createdByMembershipId,
      },
      snapshot,
    );
    const reservation =
      slotNo === null
        ? null
        : await this.founding.recordReservation({ reservationId, policyVersion: policy.version, agencyId: request.agencyId, quoteId: quote.quoteId, slotNo, endsAt: expiresAt, createdAt: request.issuedAt });

    // 7. quote_issuances: the journal entry -> the quote, the quote it superseded and the reservation it took
    const issuance = await this.recordIssuance(
      defined<QuoteIssuanceRecord>(
        { journalEntryId: request.journalEntryId, agencyId: request.agencyId, projectId: request.projectId, quoteId: quote.quoteId, snapshotId: request.snapshotId, issuedAt: request.issuedAt },
        { reservationId: reservation?.reservationId, supersededQuoteId: superseded?.quoteId },
      ),
    );
    return {
      quote,
      eligibility: { snapshot, foundingOffer, reservation },
      superseded: superseded === null ? null : { quote: superseded, releasedReservation: released },
      issuance,
    };
  }

  /** The project's live quote FOR UPDATE; an unpaid one is superseded by the quote being issued (its event: quote.superseded.v1). */
  async #supersedePrevious(request: QuoteIssuanceRequest): Promise<QuoteRecord | null> {
    // the live predicate of quotes_one_live_per_project (the same as CMD027's liveQuoteOf, D10-GAP-25), aliased so a fault step tells them apart
    const found = await execute<{ quote_id: string }>(
      this.db,
      `SELECT q.quote_id FROM kauro.quotes q
        WHERE q.agency_id = $1 AND q.project_id = $2
          AND ((q.replaces_quote_id IS NULL AND q.state IN ('DRAFT', 'ISSUED', 'ACCEPTED_FOR_CHECKOUT')) OR q.state = 'ACCEPTED_FOR_CHECKOUT')`,
      [request.agencyId, request.projectId],
    );
    const id = found.rows[0]?.quote_id as QuoteId | undefined;
    if (id === undefined) return null;
    const locked = await this.quotes.lock(id);
    // the caller holds the live quote's lock (CMD027 lockLiveQuote): a quote no longer live here is a changed project, never a missing one
    if (locked === null || !isLive(locked)) {
      throw new DomainFailure("STALE_VERSION", "the project's live quote changed under this request", locked === null ? {} : { currentVersion: locked.version, currentState: locked.state }, true);
    }
    const write = await this.quotes.transition(locked.quoteId, locked.version, { state: "SUPERSEDED", supersededByQuoteId: request.quoteId }, request.issuedAt);
    if (write.kind !== "APPLIED") throw new DomainFailure("STALE_VERSION", "the previous quote of the project changed", { currentVersion: write.currentVersion, currentState: write.currentState }, true);
    return write.record;
  }

  async issuanceOfEntry(journalEntryId: JournalEntryId): Promise<QuoteIssuanceRecord | null> {
    const r = await execute<IssuanceRow>(
      this.db,
      `SELECT i.entry_id, i.agency_id, i.project_id, i.quote_id, q.eligibility_snapshot_id, i.reservation_id, i.superseded_quote_id, i.replaced_quote_id, i.issued_at
         FROM kauro.quote_issuances i JOIN kauro.quotes q ON q.agency_id = i.agency_id AND q.quote_id = i.quote_id
        WHERE i.entry_id = $1`,
      [journalEntryId],
    );
    return r.rows[0] ? issuanceRecord(r.rows[0]) : null;
  }

  async recordIssuance(issuance: QuoteIssuanceRecord): Promise<QuoteIssuanceRecord> {
    const stored = await execute<{ issued_at: Date }>(
      this.db,
      `INSERT INTO kauro.quote_issuances (entry_id, agency_id, project_id, quote_id, superseded_quote_id, replaced_quote_id, reservation_id, issued_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING issued_at`,
      [issuance.journalEntryId, issuance.agencyId, issuance.projectId, issuance.quoteId, issuance.supersededQuoteId ?? null, issuance.replacesQuoteId ?? null, issuance.reservationId ?? null, issuance.issuedAt],
    );
    return { ...issuance, issuedAt: instant(stored.rows[0]!.issued_at) };
  }

  async mirrorFirstDesignation(agencyId: AgencyId, _now: UtcInstant): Promise<{ readonly mirrored: boolean; readonly agency: AgencyDesignation }> {
    // the agency row first (its lock), then the set-once mirror of the capture of sequence 1
    const locked = await execute<{ first_qualifying_capture_id: string | null }>(this.db, "SELECT first_qualifying_capture_id FROM kauro.agencies WHERE agency_id = $1 FOR NO KEY UPDATE", [agencyId]);
    if (locked.rows[0] === undefined) throw new DomainFailure("NOT_FOUND", "the agency is not visible in this context");
    let mirrored = false;
    if (locked.rows[0].first_qualifying_capture_id === null) {
      const updated = await execute(
        this.db,
        `UPDATE kauro.agencies a SET first_qualifying_capture_id = r.first_capture_id, version = a.version + 1, updated_at = kauro.server_now()
           FROM kauro.agency_recurrence r WHERE a.agency_id = $1 AND r.agency_id = a.agency_id AND a.first_qualifying_capture_id IS NULL`,
        [agencyId],
      );
      mirrored = updated.rowCount === 1;
    }
    const row = await execute<{ agency_id: string; version: string; state: string; first_qualifying_capture_id: string | null }>(
      this.db,
      "SELECT agency_id, version, state, first_qualifying_capture_id FROM kauro.agencies WHERE agency_id = $1",
      [agencyId],
    );
    const a = row.rows[0]!;
    const agency = defined<AgencyDesignation>(
      { agencyId: a.agency_id as AgencyId, version: int(a.version), state: text(a.state) as AgencyDesignation["state"] },
      { firstQualifyingCaptureId: optionalText(a.first_qualifying_capture_id) as CaptureId | undefined },
    );
    return { mirrored, agency };
  }

  async eligibilityFindings(): Promise<ReadonlyArray<EligibilityFinding>> {
    const r = await execute<{ agency_id: string; quote_id: string; finding: string; project_id: string | null }>(
      this.db,
      "SELECT agency_id, quote_id, finding, project_id FROM kauro.eligibility_findings() ORDER BY agency_id, quote_id, finding, project_id",
    );
    return r.rows.map((f) =>
      defined<EligibilityFinding>({ agencyId: f.agency_id as AgencyId, quoteId: f.quote_id as QuoteId, finding: f.finding as EligibilityFindingKind }, { projectId: optionalText(f.project_id) as ProjectId | undefined }),
    );
  }
}
