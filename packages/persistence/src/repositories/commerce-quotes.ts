/**
 * Quotes and their eligibility snapshots over `pg` (package B09; migration 0014; design §4.2, D-QUOTE-B1..B7, D-MACH-B1).
 *
 * The issuance (CMD027, package B10) births the quote DRAFT at version 1 and moves it along issue_quote to ISSUED at version 2
 * with its snapshot, in the caller's unit of work; every later move is a compare-and-swap on the version. Each version publishes
 * the event of the state it reaches (quote.drafted.v1, quote.issued.v1, ...; D-EVT-B3). The database re-checks the arithmetic,
 * the bindings, the source promise and — for a release from ACCEPTED_FOR_CHECKOUT — the purchase (quotes_release_guard, KA008).
 */
import type { UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  type AgencyId,
  type ApprovalId,
  type EligibilitySnapshotId,
  type FiscalIssuerRef,
  type FiscalProfileId,
  type MembershipId,
  type NewQuote,
  type PlanId,
  type PriceEligibilitySnapshotRecord,
  type ProjectId,
  type QuoteId,
  type QuoteRecord,
  type QuoteRepository,
  type QuoteState,
  type ServiceMode,
  type TaxRuleSnapshot,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, instant, int, optionalText, type Queryable } from "../sql.js";
import { cents, defined, publishVersion, staleOf, type CommerceWriteContext } from "./commerce-shared.js";

interface QuoteRow {
  quote_id: string;
  agency_id: string;
  project_id: string;
  plan_id: string;
  approval_id: string;
  version: string;
  state: QuoteState;
  revision_hash: string;
  plan_hash: string;
  target_contract_hash: string;
  billable_units: string;
  mode: ServiceMode;
  price_policy_version: string;
  discount_policy_version: string;
  base_service_cents: string;
  discount_bps: number;
  discount_cents: string;
  service_cents: string;
  fiscal_profile_id: string;
  issuer_ref: string;
  tax_treatment: TaxRuleSnapshot["treatment"];
  tax_rule: TaxRuleSnapshot["rule"];
  tax_rate_bps: number;
  tax_cents: string;
  total_cents: string;
  currency: "USD";
  eligibility_snapshot_id: string;
  terms_hash: string;
  terms_version: string;
  issued_at: Date;
  expires_at: Date;
  source_available_until: Date;
  superseded_by_quote_id: string | null;
  replaces_quote_id: string | null;
  created_by_membership_id: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = [
  "quote_id",
  "agency_id",
  "project_id",
  "plan_id",
  "approval_id",
  "version",
  "state",
  "revision_hash",
  "plan_hash",
  "target_contract_hash",
  "billable_units",
  "mode",
  "price_policy_version",
  "discount_policy_version",
  "base_service_cents",
  "discount_bps",
  "discount_cents",
  "service_cents",
  "fiscal_profile_id",
  "issuer_ref",
  "tax_treatment",
  "tax_rule",
  "tax_rate_bps",
  "tax_cents",
  "total_cents",
  "currency",
  "eligibility_snapshot_id",
  "terms_hash",
  "terms_version",
  "issued_at",
  "expires_at",
  "source_available_until",
  "superseded_by_quote_id",
  "replaces_quote_id",
  "created_by_membership_id",
  "created_at",
  "updated_at",
];
const QUOTE_COLUMNS = COLUMNS.join(", ");
const Q_COLUMNS = COLUMNS.map((c) => `q.${c}`).join(", ");

function quoteRecord(r: QuoteRow): QuoteRecord {
  return defined<QuoteRecord>(
    {
      quoteId: r.quote_id as QuoteId,
      agencyId: r.agency_id as AgencyId,
      projectId: r.project_id as ProjectId,
      planId: r.plan_id as PlanId,
      approvalId: r.approval_id as ApprovalId,
      version: int(r.version),
      state: r.state,
      revisionHash: r.revision_hash,
      planHash: r.plan_hash,
      targetContractHash: r.target_contract_hash,
      billableUnits: int(r.billable_units),
      mode: r.mode,
      pricePolicyVersion: r.price_policy_version,
      discountPolicyVersion: r.discount_policy_version,
      baseServiceCents: cents(r.base_service_cents),
      discountBps: int(r.discount_bps),
      discountCents: cents(r.discount_cents),
      serviceCents: cents(r.service_cents),
      fiscalProfileId: r.fiscal_profile_id as FiscalProfileId,
      issuerRef: r.issuer_ref as FiscalIssuerRef,
      tax: { treatment: r.tax_treatment, rule: r.tax_rule, rateBps: int(r.tax_rate_bps) },
      taxCents: cents(r.tax_cents),
      totalCents: cents(r.total_cents),
      currency: r.currency,
      eligibilitySnapshotId: r.eligibility_snapshot_id as EligibilitySnapshotId,
      termsHash: r.terms_hash,
      termsVersion: r.terms_version,
      issuedAt: instant(r.issued_at),
      expiresAt: instant(r.expires_at),
      sourceAvailableUntil: instant(r.source_available_until),
      createdByMembershipId: r.created_by_membership_id as MembershipId,
      createdAt: instant(r.created_at),
      updatedAt: instant(r.updated_at),
    },
    { supersededByQuoteId: optionalText(r.superseded_by_quote_id), replacesQuoteId: optionalText(r.replaces_quote_id) },
  );
}

interface SnapshotRow {
  snapshot_id: string;
  agency_id: string;
  quote_id: string;
  project_id: string;
  as_of: Date;
  lookback_starts_at: Date;
  qualifying_project_ids: string[];
  qualifying_count: number;
  repeat_discount_bps: number;
  founding_slot_ref: string | null;
  founding_discount_bps: number;
  applied_discount_bps: number;
  policy_version: string;
}

function snapshotRecord(r: SnapshotRow): PriceEligibilitySnapshotRecord {
  return defined<PriceEligibilitySnapshotRecord>(
    {
      snapshotId: r.snapshot_id as EligibilitySnapshotId,
      agencyId: r.agency_id as AgencyId,
      quoteId: r.quote_id as QuoteId,
      projectId: r.project_id as ProjectId,
      asOf: instant(r.as_of),
      lookbackStartsAt: instant(r.lookback_starts_at),
      qualifyingProjectIds: r.qualifying_project_ids as ProjectId[],
      qualifyingCount: int(r.qualifying_count),
      repeatDiscountBps: int(r.repeat_discount_bps),
      foundingDiscountBps: int(r.founding_discount_bps),
      appliedDiscountBps: int(r.applied_discount_bps),
      policyVersion: r.policy_version,
    },
    { foundingSlotRef: optionalText(r.founding_slot_ref) },
  );
}

/** What a quote event may carry, from the stored quote (the allowlist of each type picks its own members). */
function quoteCandidate(q: QuoteRecord, previousState: QuoteState | null): Readonly<Record<string, string | number | bigint | null | undefined>> {
  return {
    quoteId: q.quoteId,
    agencyId: q.agencyId,
    projectId: q.projectId,
    planId: q.planId,
    approvalId: q.approvalId,
    planHash: q.planHash,
    revisionHash: q.revisionHash,
    targetContractHash: q.targetContractHash,
    mode: q.mode,
    billableUnits: q.billableUnits,
    discountBps: q.discountBps,
    baseServiceCents: q.baseServiceCents,
    discountCents: q.discountCents,
    serviceCents: q.serviceCents,
    taxCents: q.taxCents,
    totalCents: q.totalCents,
    currency: q.currency,
    termsHash: q.termsHash,
    eligibilitySnapshotId: q.eligibilitySnapshotId,
    fiscalProfileId: q.fiscalProfileId,
    taxTreatment: q.tax.treatment,
    pricePolicyVersion: q.pricePolicyVersion,
    discountPolicyVersion: q.discountPolicyVersion,
    successorQuoteId: q.supersededByQuoteId,
    previousState,
  };
}

export class PgQuoteRepository implements QuoteRepository {
  constructor(private readonly ctx: CommerceWriteContext) {}

  async get(quoteId: QuoteId): Promise<QuoteRecord | null> {
    const r = await execute<QuoteRow>(this.ctx.db, `SELECT ${QUOTE_COLUMNS} FROM kauro.quotes WHERE quote_id = $1`, [quoteId]);
    return r.rows[0] ? quoteRecord(r.rows[0]) : null;
  }

  async lock(quoteId: QuoteId): Promise<QuoteRecord | null> {
    const r = await execute<QuoteRow>(this.ctx.db, `SELECT ${QUOTE_COLUMNS} FROM kauro.quotes WHERE quote_id = $1 FOR UPDATE`, [quoteId]);
    return r.rows[0] ? quoteRecord(r.rows[0]) : null;
  }

  async snapshot(quoteId: QuoteId): Promise<PriceEligibilitySnapshotRecord | null> {
    const r = await execute<SnapshotRow>(
      this.ctx.db,
      `SELECT snapshot_id, agency_id, quote_id, project_id, as_of, lookback_starts_at, qualifying_project_ids, qualifying_count, repeat_discount_bps, founding_slot_ref, founding_discount_bps, applied_discount_bps, policy_version
         FROM kauro.price_eligibility_snapshots WHERE quote_id = $1`,
      [quoteId],
    );
    return r.rows[0] ? snapshotRecord(r.rows[0]) : null;
  }

  /**
   * Births the quote DRAFT (version 1, quote.drafted.v1), records its eligibility snapshot and issues it (issue_quote, version 2,
   * quote.issued.v1), all in the caller's unit of work. The snapshot's quote, project, policy and instant are checked at COMMIT
   * (quotes_snapshot_fk); the arithmetic, the bindings and the source promise when the quote is inserted.
   */
  async issue(quote: NewQuote, snapshot: PriceEligibilitySnapshotRecord): Promise<QuoteRecord> {
    const inserted = await execute<QuoteRow>(
      this.ctx.db,
      `INSERT INTO kauro.quotes (quote_id, agency_id, project_id, plan_id, approval_id, revision_hash, plan_hash, target_contract_hash, billable_units, mode, price_policy_version, discount_policy_version,
                                 base_service_cents, discount_bps, discount_cents, service_cents, fiscal_profile_id, issuer_ref, tax_treatment, tax_rule, tax_rate_bps, tax_cents, total_cents, currency,
                                 eligibility_snapshot_id, terms_hash, terms_version, issued_at, expires_at, source_available_until, replaces_quote_id, created_by_membership_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, 'USD', $24, $25, $26, $27, $28, $29, $30, $31, $27, $27)
       RETURNING ${QUOTE_COLUMNS}`,
      [
        quote.quoteId,
        quote.agencyId,
        quote.projectId,
        quote.planId,
        quote.approvalId,
        quote.revisionHash,
        quote.planHash,
        quote.targetContractHash,
        quote.billableUnits,
        quote.mode,
        quote.pricePolicyVersion,
        quote.discountPolicyVersion,
        quote.baseServiceCents,
        quote.discountBps,
        quote.discountCents,
        quote.serviceCents,
        quote.fiscalProfileId,
        quote.issuerRef,
        quote.tax.treatment,
        quote.tax.rule,
        quote.tax.rateBps,
        quote.taxCents,
        quote.totalCents,
        quote.eligibilitySnapshotId,
        quote.termsHash,
        quote.termsVersion,
        quote.issuedAt,
        quote.expiresAt,
        quote.sourceAvailableUntil,
        quote.replacesQuoteId ?? null,
        quote.createdByMembershipId,
      ],
    );
    const draftRow = inserted.rows[0];
    if (!draftRow) throw new DomainFailure("INTEGRITY_FAILURE", "quote insert returned no row");
    await execute(
      this.ctx.db,
      `INSERT INTO kauro.price_eligibility_snapshots (snapshot_id, agency_id, quote_id, project_id, as_of, lookback_starts_at, qualifying_project_ids, qualifying_count, repeat_discount_bps, founding_slot_ref, founding_discount_bps, applied_discount_bps, policy_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9, $10, $11, $12, $13, $14)`,
      [
        snapshot.snapshotId,
        snapshot.agencyId,
        snapshot.quoteId,
        snapshot.projectId,
        snapshot.asOf,
        snapshot.lookbackStartsAt,
        [...snapshot.qualifyingProjectIds],
        snapshot.qualifyingCount,
        snapshot.repeatDiscountBps,
        snapshot.foundingSlotRef ?? null,
        snapshot.foundingDiscountBps,
        snapshot.appliedDiscountBps,
        snapshot.policyVersion,
        quote.issuedAt,
      ],
    );
    const draft = quoteRecord(draftRow);
    await publishVersion(this.ctx, "quote", { id: draft.quoteId, agencyId: draft.agencyId, version: draft.version }, { previousState: null, state: draft.state }, quoteCandidate(draft, null));
    const issued = await this.transition(draft.quoteId, draft.version, { state: "ISSUED" }, quote.issuedAt);
    if (issued.kind !== "APPLIED") throw new DomainFailure("INTEGRITY_FAILURE", "the quote just drafted could not be issued");
    return issued.record;
  }

  /** A listed move at expectedVersion + 1 (compare-and-swap), publishing the event of the state it reaches. */
  async transition(quoteId: QuoteId, expectedVersion: number, change: { readonly state: QuoteState; readonly supersededByQuoteId?: QuoteId }, _now: UtcInstant): Promise<VersionedWrite<QuoteRecord>> {
    const params: unknown[] = [quoteId, expectedVersion, change.state];
    const sets = ["version = q.version + 1", "state = $3"];
    if (change.supersededByQuoteId !== undefined) {
      params.push(change.supersededByQuoteId);
      sets.push(`superseded_by_quote_id = $${params.length}`);
    }
    const r = await execute<QuoteRow & { previous_state: QuoteState }>(
      this.ctx.db,
      `UPDATE kauro.quotes AS q SET ${sets.join(", ")} FROM kauro.quotes AS o
        WHERE q.quote_id = $1 AND q.version = $2 AND o.quote_id = q.quote_id
       RETURNING ${Q_COLUMNS}, o.state AS previous_state`,
      params,
    );
    const row = r.rows[0];
    if (!row) return staleOf(this.ctx.db, "quotes", "quote_id", "state", quoteId, "quote");
    const record = quoteRecord(row);
    await publishVersion(this.ctx, "quote", { id: record.quoteId, agencyId: record.agencyId, version: record.version }, { previousState: row.previous_state, state: record.state }, quoteCandidate(record, row.previous_state));
    return { kind: "APPLIED", record };
  }
}
