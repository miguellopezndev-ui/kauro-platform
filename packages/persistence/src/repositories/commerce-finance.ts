/**
 * Fiscal documents, the operational ledger, settlement observations and the payment service's side of the provider inbox over
 * `pg` (package B09; migrations 0005, 0009, 0013; design §4.5, D-FISC-B1..B6, D-LEDGER-B1..B5, D-SETTLE-B1, D-ING-B1).
 *
 * A fiscal document's snapshot is exactly its profile's (the rule and rate are read from the profile the document names); a draft is
 * re-pointed only while DRAFT; DRAFT -> VALIDATED is re-checked by the database (KP011). A posting set's source is its idempotency
 * identity: a replayed or concurrent post of the same source writes nothing and answers the entries already posted (the first line
 * is inserted with ON CONFLICT (event_id, line_no) DO NOTHING, so a concurrent poster waits on the index and then sees the set).
 * The payment service settles a provider's inbox record in the transaction that applies it, under the B06 guards (a record with a
 * conflicting body is never APPLIED, KA012; a settled record stays settled, KA007; APPLIED only under READ COMMITTED).
 */
import type { UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  LEDGER_ACCOUNT_VERSION,
  LEDGER_POLICY_VERSION,
  isBalanced,
  type AgencyId,
  type CaptureId,
  type EventId,
  type FiscalIssuerRef,
  type FiscalProfileId,
  type InboxId,
  type LedgerAccount,
  type LedgerEntryId,
  type LedgerEntryRecord,
  type LedgerRepository,
  type LedgerSourceKind,
  type NewTaxDocument,
  type PaymentInboxEntry,
  type PaymentInboxRepository,
  type PaymentOrderId,
  type PaymentRouteId,
  type PostingSet,
  type RefundId,
  type SettlementId,
  type SettlementRecord,
  type SettlementRepository,
  type TaxDocumentChange,
  type TaxDocumentId,
  type TaxDocumentRecord,
  type TaxDocumentRepository,
  type TaxDocumentState,
  type TaxTreatment,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, instant, int, optionalInstant, optionalText, type Queryable } from "../sql.js";
import { cents, defined, publishVersion, staleOf, type CommerceWriteContext } from "./commerce-shared.js";

type Candidate = Readonly<Record<string, string | number | bigint | boolean | null | undefined>>;

// --- fiscal documents -------------------------------------------------------------------------------------------------------------

interface DocumentRow {
  document_id: string;
  agency_id: string;
  order_id: string;
  capture_id: string;
  refund_id: string | null;
  kind: TaxDocumentRecord["kind"];
  version: string;
  state: TaxDocumentState;
  fiscal_profile_id: string;
  issuer_ref: string;
  tax_treatment: TaxTreatment;
  service_cents: string;
  tax_cents: string;
  currency: "USD";
  corrects_document_id: string | null;
  supersedes_document_id: string | null;
  blocked_reason: string | null;
  issue_request_hash: string | null;
  provider_document_id: string | null;
  legal_number: string | null;
  rejection_code: string | null;
  evidence_hash: string | null;
  issued_at: Date | null;
}

const DOCUMENT_FIELDS = [
  "document_id",
  "agency_id",
  "order_id",
  "capture_id",
  "refund_id",
  "kind",
  "version",
  "state",
  "fiscal_profile_id",
  "issuer_ref",
  "tax_treatment",
  "service_cents",
  "tax_cents",
  "currency",
  "corrects_document_id",
  "supersedes_document_id",
  "blocked_reason",
  "issue_request_hash",
  "provider_document_id",
  "legal_number",
  "rejection_code",
  "evidence_hash",
  "issued_at",
];
const DOCUMENT_COLUMNS = DOCUMENT_FIELDS.join(", ");
const T_DOCUMENT_COLUMNS = DOCUMENT_FIELDS.map((c) => `t.${c}`).join(", ");

function documentRecord(r: DocumentRow): TaxDocumentRecord {
  return defined<TaxDocumentRecord>(
    {
      documentId: r.document_id as TaxDocumentId,
      agencyId: r.agency_id as AgencyId,
      orderId: r.order_id as PaymentOrderId,
      captureId: r.capture_id as CaptureId,
      kind: r.kind,
      version: int(r.version),
      state: r.state,
      fiscalProfileId: r.fiscal_profile_id as FiscalProfileId,
      issuerRef: r.issuer_ref as FiscalIssuerRef,
      taxTreatment: r.tax_treatment,
      serviceCents: cents(r.service_cents),
      taxCents: cents(r.tax_cents),
      currency: r.currency,
    },
    {
      refundId: optionalText(r.refund_id) as RefundId | undefined,
      correctsDocumentId: optionalText(r.corrects_document_id) as TaxDocumentId | undefined,
      supersedesDocumentId: optionalText(r.supersedes_document_id) as TaxDocumentId | undefined,
      blockedReason: optionalText(r.blocked_reason),
      issueRequestHash: optionalText(r.issue_request_hash),
      providerDocumentId: optionalText(r.provider_document_id),
      legalNumber: optionalText(r.legal_number),
      rejectionCode: optionalText(r.rejection_code),
      evidenceHash: optionalText(r.evidence_hash),
      issuedAt: optionalInstant(r.issued_at),
    },
  );
}

function documentCandidate(d: TaxDocumentRecord, previousState: TaxDocumentState | null): Candidate {
  return {
    documentId: d.documentId,
    agencyId: d.agencyId,
    orderId: d.orderId,
    captureId: d.captureId,
    refundId: d.refundId,
    kind: d.kind,
    fiscalProfileId: d.fiscalProfileId,
    issuerRef: d.issuerRef,
    taxTreatment: d.taxTreatment,
    serviceCents: d.serviceCents,
    taxCents: d.taxCents,
    blockedReason: d.blockedReason,
    correctsDocumentId: d.correctsDocumentId,
    supersedesDocumentId: d.supersedesDocumentId,
    issueRequestHash: d.issueRequestHash,
    rejectionCode: d.rejectionCode,
    evidenceHash: d.evidenceHash,
    previousState,
  };
}

/** The live documents of a subject (tax_documents_one_invoice_per_capture, tax_documents_one_credit_note_per_refund). */
const LIVE_DOCUMENT = "state <> 'REJECTED' AND NOT (state = 'CORRECTED' AND issued_at IS NULL)";

export class PgTaxDocumentRepository implements TaxDocumentRepository {
  constructor(private readonly ctx: CommerceWriteContext) {}

  async get(documentId: TaxDocumentId): Promise<TaxDocumentRecord | null> {
    const r = await execute<DocumentRow>(this.ctx.db, `SELECT ${DOCUMENT_COLUMNS} FROM kauro.tax_documents WHERE document_id = $1`, [documentId]);
    return r.rows[0] ? documentRecord(r.rows[0]) : null;
  }

  async lock(documentId: TaxDocumentId): Promise<TaxDocumentRecord | null> {
    const r = await execute<DocumentRow>(this.ctx.db, `SELECT ${DOCUMENT_COLUMNS} FROM kauro.tax_documents WHERE document_id = $1 FOR UPDATE`, [documentId]);
    return r.rows[0] ? documentRecord(r.rows[0]) : null;
  }

  async findLiveInvoice(captureId: CaptureId): Promise<TaxDocumentRecord | null> {
    const r = await execute<DocumentRow>(this.ctx.db, `SELECT ${DOCUMENT_COLUMNS} FROM kauro.tax_documents WHERE capture_id = $1 AND kind = 'INVOICE' AND ${LIVE_DOCUMENT}`, [captureId]);
    return r.rows[0] ? documentRecord(r.rows[0]) : null;
  }

  async findLiveCreditNote(refundId: RefundId): Promise<TaxDocumentRecord | null> {
    const r = await execute<DocumentRow>(this.ctx.db, `SELECT ${DOCUMENT_COLUMNS} FROM kauro.tax_documents WHERE refund_id = $1 AND kind = 'CREDIT_NOTE' AND ${LIVE_DOCUMENT}`, [refundId]);
    return r.rows[0] ? documentRecord(r.rows[0]) : null;
  }

  /** Blocked drafts of the adopted agency, oldest first (index tax_documents_blocked). */
  async listBlockedDrafts(limit: number): Promise<ReadonlyArray<TaxDocumentRecord>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new DomainFailure("INVALID_REQUEST", "a blocked-draft page is 1..1000 documents");
    const r = await execute<DocumentRow>(this.ctx.db, `SELECT ${DOCUMENT_COLUMNS} FROM kauro.tax_documents WHERE state = 'DRAFT' AND blocked_reason IS NOT NULL ORDER BY created_at, document_id LIMIT $1`, [limit]);
    return r.rows.map(documentRecord);
  }

  /**
   * A DRAFT at version 1 with tax_document.drafted.v1. The fiscal snapshot is the named profile's own: the rule and the rate are
   * read from it, and tax_documents_fiscal_fk makes the treatment and issuer its own too.
   */
  async draft(d: NewTaxDocument): Promise<TaxDocumentRecord> {
    const r = await execute<DocumentRow>(
      this.ctx.db,
      `INSERT INTO kauro.tax_documents (document_id, agency_id, order_id, capture_id, refund_id, kind, fiscal_profile_id, issuer_ref, tax_treatment, tax_rule, tax_rate_bps, service_cents, tax_cents, currency,
                                        corrects_document_id, supersedes_document_id, blocked_reason, created_at, updated_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, p.tax_rule, p.tax_rate_bps, $10, $11, 'USD', $12, $13, $14, $15, $15
         FROM kauro.fiscal_profiles p WHERE p.agency_id = $2 AND p.profile_id = $7
       RETURNING ${DOCUMENT_COLUMNS}`,
      [d.documentId, d.agencyId, d.orderId, d.captureId, d.refundId ?? null, d.kind, d.fiscalProfileId, d.issuerRef, d.taxTreatment, d.serviceCents, d.taxCents, d.correctsDocumentId ?? null, d.supersedesDocumentId ?? null, d.blockedReason ?? null, d.createdAt],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("NOT_FOUND", "the fiscal profile of the document is not visible in this context");
    const record = documentRecord(row);
    await publishVersion(this.ctx, "tax_document", { id: record.documentId, agencyId: record.agencyId, version: record.version }, { previousState: null, state: record.state }, documentCandidate(record, null));
    return record;
  }

  /** DRAFT only (tax_documents_draft_only): re-points the draft at a re-reviewed profile, or records why it stays blocked. */
  async redraft(
    documentId: TaxDocumentId,
    expectedVersion: number,
    change: { readonly fiscalProfileId: FiscalProfileId; readonly issuerRef: FiscalIssuerRef; readonly taxTreatment: TaxTreatment; readonly taxCents: bigint; readonly blockedReason: string | null },
    _now: UtcInstant,
  ): Promise<VersionedWrite<TaxDocumentRecord>> {
    const r = await execute<DocumentRow & { previous_state: TaxDocumentState }>(
      this.ctx.db,
      `UPDATE kauro.tax_documents AS t SET version = t.version + 1, fiscal_profile_id = $3, issuer_ref = $4, tax_treatment = $5, tax_rule = p.tax_rule, tax_rate_bps = p.tax_rate_bps, tax_cents = $6, blocked_reason = $7
         FROM kauro.fiscal_profiles AS p, kauro.tax_documents AS o
        WHERE t.document_id = $1 AND t.version = $2 AND p.agency_id = t.agency_id AND p.profile_id = $3 AND o.document_id = t.document_id
       RETURNING ${T_DOCUMENT_COLUMNS}, o.state AS previous_state`,
      [documentId, expectedVersion, change.fiscalProfileId, change.issuerRef, change.taxTreatment, change.taxCents, change.blockedReason],
    );
    const row = r.rows[0];
    if (!row) {
      const stale = await staleOf(this.ctx.db, "tax_documents", "document_id", "state", documentId, "tax document");
      if (stale.currentVersion === expectedVersion) throw new DomainFailure("NOT_FOUND", "the fiscal profile of the redraft is not visible in this context");
      return stale;
    }
    const record = documentRecord(row);
    await publishVersion(this.ctx, "tax_document", { id: record.documentId, agencyId: record.agencyId, version: record.version }, { previousState: row.previous_state, state: record.state }, documentCandidate(record, row.previous_state));
    return { kind: "APPLIED", record };
  }

  /** A listed move at expectedVersion + 1 (validation re-checked by the database, KP011; issuance facts learned once). */
  async transition(documentId: TaxDocumentId, expectedVersion: number, change: TaxDocumentChange, _now: UtcInstant): Promise<VersionedWrite<TaxDocumentRecord>> {
    const params: unknown[] = [documentId, expectedVersion, change.state];
    const sets = ["version = t.version + 1", "state = $3"];
    const add = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (change.issueRequestHash !== undefined) add("issue_request_hash", change.issueRequestHash);
    if (change.providerDocumentId !== undefined) add("provider_document_id", change.providerDocumentId);
    if (change.legalNumber !== undefined) add("legal_number", change.legalNumber);
    if (change.rejectionCode !== undefined) add("rejection_code", change.rejectionCode);
    if (change.evidenceHash !== undefined) add("evidence_hash", change.evidenceHash);
    if (change.issuedAt !== undefined) add("issued_at", change.issuedAt);
    const r = await execute<DocumentRow & { previous_state: TaxDocumentState }>(
      this.ctx.db,
      `UPDATE kauro.tax_documents AS t SET ${sets.join(", ")} FROM kauro.tax_documents AS o
        WHERE t.document_id = $1 AND t.version = $2 AND o.document_id = t.document_id
       RETURNING ${T_DOCUMENT_COLUMNS}, o.state AS previous_state`,
      params,
    );
    const row = r.rows[0];
    if (!row) return staleOf(this.ctx.db, "tax_documents", "document_id", "state", documentId, "tax document");
    const record = documentRecord(row);
    await publishVersion(this.ctx, "tax_document", { id: record.documentId, agencyId: record.agencyId, version: record.version }, { previousState: row.previous_state, state: record.state }, documentCandidate(record, row.previous_state));
    return { kind: "APPLIED", record };
  }
}

// --- the operational ledger ---------------------------------------------------------------------------------------------------------------

interface EntryRow {
  entry_id: string;
  agency_id: string | null;
  domain_event_id: string | null;
  settlement_id: string | null;
  line_no: number;
  account_code: LedgerAccount;
  account_version: string;
  direction: "DEBIT" | "CREDIT";
  amount_cents: string;
  currency: string;
  source_kind: LedgerSourceKind;
  source_ref: string;
  reverses_entry_id: string | null;
  effective_at: Date;
  observed_at: Date;
  posted_at: Date;
  evidence_hash: string;
  policy_version: string;
}

const ENTRY_COLUMNS =
  "entry_id, agency_id, domain_event_id, settlement_id, line_no, account_code, account_version, direction, amount_cents, currency, source_kind, source_ref, reverses_entry_id, effective_at, observed_at, posted_at, evidence_hash, policy_version";

function entryRecord(r: EntryRow): LedgerEntryRecord {
  return defined<LedgerEntryRecord>(
    {
      entryId: r.entry_id as LedgerEntryId,
      agencyId: r.agency_id as AgencyId | null,
      eventId: r.domain_event_id as EventId | null,
      lineNo: int(r.line_no),
      accountCode: r.account_code,
      accountVersion: r.account_version,
      direction: r.direction,
      amountCents: cents(r.amount_cents),
      currency: r.currency,
      sourceKind: r.source_kind,
      sourceRef: r.source_ref,
      effectiveAt: instant(r.effective_at),
      observedAt: instant(r.observed_at),
      postedAt: instant(r.posted_at),
      evidenceHash: r.evidence_hash,
      policyVersion: r.policy_version,
    },
    { settlementId: optionalText(r.settlement_id) as SettlementId | undefined, reversesEntryId: optionalText(r.reverses_entry_id) as LedgerEntryId | undefined },
  );
}

export class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly ctx: CommerceWriteContext) {}

  /**
   * Appends a balanced posting set whose source is its idempotency identity (UNIQUE (event_id, line_no)): the set is checked in
   * code (non-empty, balanced; the database re-checks at COMMIT, KP001, with the source binding and the account rules), and a set
   * already posted for the source — by an earlier delivery, or by a concurrent one this post waited for — is the answer
   * ({ posted: false }) and nothing is written. `reverses` maps a line's position in `lines` (0-based) to the entry it mirrors.
   */
  async post(set: PostingSet, now: UtcInstant): Promise<{ readonly posted: boolean; readonly entries: ReadonlyArray<LedgerEntryRecord> }> {
    if (set.lines.length === 0 || set.lines.length > 64) throw new DomainFailure("INTEGRITY_FAILURE", "a posting set has 1..64 lines", { reason: "LEDGER_UNBALANCED" });
    if (!isBalanced(set.lines)) throw new DomainFailure("INTEGRITY_FAILURE", "the posting set does not balance", { reason: "LEDGER_UNBALANCED" });
    const sourceId = set.source.kind === "EVENT" ? set.source.eventId : set.source.settlementId;
    const already = await this.#entriesOf(sourceId);
    if (already.length > 0) return { posted: false, entries: already };
    const entries: LedgerEntryRecord[] = [];
    for (const [index, line] of set.lines.entries()) {
      const r = await execute<EntryRow>(
        this.ctx.db,
        `INSERT INTO kauro.ledger_entries (entry_id, agency_id, domain_event_id, settlement_id, line_no, account_code, account_version, direction, amount_cents, currency, source_kind, source_ref, reverses_entry_id,
                                           effective_at, observed_at, posted_at, evidence_hash, policy_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ${index === 0 ? "ON CONFLICT (event_id, line_no) DO NOTHING" : ""} RETURNING ${ENTRY_COLUMNS}`,
        [
          this.ctx.ids.next(),
          set.agencyId,
          set.source.kind === "EVENT" ? set.source.eventId : null,
          set.source.kind === "SETTLEMENT" ? set.source.settlementId : null,
          index + 1,
          line.account,
          LEDGER_ACCOUNT_VERSION,
          line.direction,
          line.amountCents,
          set.currency,
          set.sourceKind,
          set.sourceRef,
          set.reverses?.[index] ?? null,
          set.effectiveAt,
          set.observedAt,
          now,
          set.evidenceHash,
          LEDGER_POLICY_VERSION,
        ],
      );
      const row = r.rows[0];
      if (!row) {
        // a concurrent post of the same source committed first (this insert waited on the index): its set is the answer
        return { posted: false, entries: await this.#entriesOf(sourceId) };
      }
      entries.push(entryRecord(row));
    }
    return { posted: true, entries };
  }

  async listForSource(sourceKind: LedgerSourceKind, sourceRef: string): Promise<ReadonlyArray<LedgerEntryRecord>> {
    const r = await execute<EntryRow>(this.ctx.db, `SELECT ${ENTRY_COLUMNS} FROM kauro.ledger_entries WHERE source_kind = $1 AND source_ref = $2 ORDER BY posted_at, event_id, line_no`, [sourceKind, sourceRef]);
    return r.rows.map(entryRecord);
  }

  async #entriesOf(sourceId: string): Promise<LedgerEntryRecord[]> {
    const r = await execute<EntryRow>(this.ctx.db, `SELECT ${ENTRY_COLUMNS} FROM kauro.ledger_entries WHERE event_id = $1 ORDER BY line_no`, [sourceId]);
    return r.rows.map(entryRecord);
  }
}

// --- settlement observations ------------------------------------------------------------------------------------------------------------

interface SettlementRow {
  settlement_id: string;
  route_id: string;
  provider_balance_ref: string;
  currency: string;
  gross_cents: string;
  fee_cents: string;
  held_cents: string;
  withdrawn_cents: string;
  bank_available_cents: string;
  bank_evidence_hash: string | null;
  fx_rate: string | null;
  period_start: Date;
  period_end: Date;
  observed_at: Date;
  evidence_hash: string;
}

const SETTLEMENT_COLUMNS =
  "settlement_id, route_id, provider_balance_ref, currency, gross_cents, fee_cents, held_cents, withdrawn_cents, bank_available_cents, bank_evidence_hash, fx_rate::text AS fx_rate, period_start, period_end, observed_at, evidence_hash";

function settlementRecord(r: SettlementRow): SettlementRecord {
  return defined<SettlementRecord>(
    {
      settlementId: r.settlement_id as SettlementId,
      routeId: r.route_id as PaymentRouteId,
      providerBalanceRef: r.provider_balance_ref,
      currency: r.currency,
      grossCents: cents(r.gross_cents),
      feeCents: cents(r.fee_cents),
      heldCents: cents(r.held_cents),
      withdrawnCents: cents(r.withdrawn_cents),
      bankAvailableCents: cents(r.bank_available_cents),
      periodStart: instant(r.period_start),
      periodEnd: instant(r.period_end),
      observedAt: instant(r.observed_at),
      evidenceHash: r.evidence_hash,
    },
    { bankEvidenceHash: optionalText(r.bank_evidence_hash), fxRate: optionalText(r.fx_rate) },
  );
}

export class PgSettlementRepository implements SettlementRepository {
  constructor(private readonly ctx: CommerceWriteContext) {}

  /** Platform-level (the payment service with no agency adopted); append-only; bank-available cash needs bank evidence. */
  async record(s: SettlementRecord): Promise<SettlementRecord> {
    const r = await execute<SettlementRow>(
      this.ctx.db,
      `INSERT INTO kauro.settlements (settlement_id, route_id, provider_balance_ref, currency, gross_cents, fee_cents, held_cents, withdrawn_cents, bank_available_cents, bank_evidence_hash, fx_rate, period_start, period_end, observed_at, evidence_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12, $13, $14, $15, $16) RETURNING ${SETTLEMENT_COLUMNS}`,
      [
        s.settlementId,
        s.routeId,
        s.providerBalanceRef,
        s.currency,
        s.grossCents,
        s.feeCents,
        s.heldCents,
        s.withdrawnCents,
        s.bankAvailableCents,
        s.bankEvidenceHash ?? null,
        s.fxRate ?? null,
        s.periodStart,
        s.periodEnd,
        s.observedAt,
        s.evidenceHash,
        this.ctx.clock.now(),
      ],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "settlement insert returned no row");
    return settlementRecord(row);
  }

  async latest(routeId: PaymentRouteId): Promise<SettlementRecord | null> {
    const r = await execute<SettlementRow>(this.ctx.db, `SELECT ${SETTLEMENT_COLUMNS} FROM kauro.settlements WHERE route_id = $1 ORDER BY observed_at DESC, settlement_id DESC LIMIT 1`, [routeId]);
    return r.rows[0] ? settlementRecord(r.rows[0]) : null;
  }
}

// --- the provider inbox, the payment service's consumer side (D-ING-B1) --------------------------------------------------------------------

interface InboxRow {
  inbox_id: string;
  provider: string;
  environment: PaymentInboxEntry["environment"];
  external_event_id: string;
  body_hash: string;
  state: PaymentInboxEntry["state"];
  received_at: Date;
  applied_at: Date | null;
  result_event_id: string | null;
  conflicts: string;
}

/** The columns the payment service may read (0009 column grant) and its count of conflicting bodies. */
const INBOX_COLUMNS =
  "i.inbox_id, i.provider, i.environment, i.external_event_id, i.body_hash, i.state, i.received_at, i.applied_at, i.result_event_id, (SELECT count(*) FROM kauro.inbox_body_conflicts c WHERE c.inbox_id = i.inbox_id)::text AS conflicts";

function inboxEntry(r: InboxRow): PaymentInboxEntry {
  return defined<PaymentInboxEntry>(
    {
      inboxId: r.inbox_id as InboxId,
      provider: r.provider,
      environment: r.environment,
      externalEventId: r.external_event_id,
      bodyHash: r.body_hash,
      state: r.state,
      receivedAt: instant(r.received_at),
      conflictingBodies: int(r.conflicts),
    },
    { appliedAt: optionalInstant(r.applied_at), resultEventId: optionalText(r.result_event_id) as EventId | undefined },
  );
}

export class PgPaymentInboxRepository implements PaymentInboxRepository {
  constructor(private readonly db: Queryable) {}

  /** The record FOR UPDATE: a concurrent application of the same event waits here (null when not a payment provider's record). */
  async lockForApply(inboxId: InboxId): Promise<PaymentInboxEntry | null> {
    const r = await execute<InboxRow>(this.db, `SELECT ${INBOX_COLUMNS} FROM kauro.inbox_records i WHERE i.inbox_id = $1 FOR UPDATE OF i`, [inboxId]);
    return r.rows[0] ? inboxEntry(r.rows[0]) : null;
  }

  /** The consumer's outcome, in the transaction that applied it: KA012 for APPLIED with a conflicting body, KA007 once settled. */
  async settle(inboxId: InboxId, outcome: { readonly state: "APPLIED" | "IGNORED" | "REJECTED" | "RETRYABLE"; readonly resultEventId?: EventId }, now: UtcInstant): Promise<PaymentInboxEntry> {
    const r = await execute<InboxRow>(
      this.db,
      `UPDATE kauro.inbox_records AS i SET state = $2, applied_at = CASE WHEN $2 = 'APPLIED' THEN $3::timestamptz END, result_event_id = $4
        WHERE i.inbox_id = $1 RETURNING ${INBOX_COLUMNS}`,
      [inboxId, outcome.state, now, outcome.resultEventId ?? null],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("NOT_FOUND", "the inbox record is not a payment provider's record visible to the payment service");
    return inboxEntry(row);
  }
}
