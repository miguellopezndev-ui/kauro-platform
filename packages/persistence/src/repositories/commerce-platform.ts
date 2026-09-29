/**
 * Platform configuration, fiscal profiles, corporate grants, standing refund policies, known price policies and the scope index
 * over `pg` (package B09; migrations 0013, 0014; design §3.2, §3.3, §4.1, §4.2, D-SCOPE-B1, D-CORP-B1, D-FISC-B1, D-FISC-B6).
 *
 * The facts a command relies on without changing them are read after the shared half of their transition lock (B06 D-TX-2,
 * design §6.2): a merchant route by provider and environment, a fiscal issuer by its reference, an agency's fiscal profile by
 * the agency, a corporate grant by its person. The configuration rows themselves are the control plane's writes (no port of B09
 * writes them).
 */
import type { UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  saleProfileAt,
  type AgencyId,
  type AssuranceProofId,
  type CaptureId,
  type CorporateGrantId,
  type CorporateGrantRecord,
  type CorporateGrantRepository,
  type CorporateRole,
  type FiscalIssuerRecord,
  type FiscalIssuerRef,
  type FiscalProfileId,
  type FiscalProfileRecord,
  type FiscalRepository,
  type MerchantRef,
  type NewFiscalProfile,
  type PaymentEnvironment,
  type PaymentOrderId,
  type PaymentRouteId,
  type PaymentRouteRecord,
  type PaymentRouteRepository,
  type PricePolicyRecord,
  type PricePolicyRepository,
  type RefundId,
  type RefundPolicyId,
  type RefundPolicyRecord,
  type RefundPolicyRepository,
  type ScopeEntry,
  type ScopeIndex,
  type ScopeKind,
  type UserId,
} from "@kauro/domain";
import { execute, instant, int, optionalInstant, optionalText, type Queryable } from "../sql.js";
import { awaitCommerceTransition, defined, hashList, optionalCents } from "./commerce-shared.js";

// --- payment routes --------------------------------------------------------------------------------------------------------------

interface RouteRow {
  route_id: string;
  provider: string;
  environment: PaymentEnvironment;
  merchant_ref: string;
  payee_digest: string;
  currency: "USD";
  integration_class: PaymentRouteRecord["integrationClass"];
  state: PaymentRouteRecord["state"];
  qualification_evidence_hashes: unknown;
  valid_from: Date | null;
}

const ROUTE_COLUMNS = "route_id, provider, environment, merchant_ref, payee_digest, currency, integration_class, state, qualification_evidence_hashes, valid_from";

function routeRecord(r: RouteRow): PaymentRouteRecord {
  return defined<PaymentRouteRecord>(
    {
      routeId: r.route_id as PaymentRouteId,
      provider: r.provider,
      environment: r.environment,
      merchantRef: r.merchant_ref as MerchantRef,
      payeeDigest: r.payee_digest,
      currency: r.currency,
      integrationClass: r.integration_class,
      state: r.state,
      qualificationEvidenceHashes: hashList(r.qualification_evidence_hashes),
    },
    { validFrom: optionalInstant(r.valid_from) },
  );
}

export class PgPaymentRouteRepository implements PaymentRouteRepository {
  constructor(private readonly db: Queryable) {}

  async get(routeId: PaymentRouteId): Promise<PaymentRouteRecord | null> {
    const r = await execute<RouteRow>(this.db, `SELECT ${ROUTE_COLUMNS} FROM kauro.payment_routes WHERE route_id = $1`, [routeId]);
    return r.rows[0] ? routeRecord(r.rows[0]) : null;
  }

  /** The QUALIFIED route of a provider and environment, after the route's transition lock (keyed provider:environment, 0013). */
  async findQualified(provider: string, environment: PaymentEnvironment): Promise<PaymentRouteRecord | null> {
    await awaitCommerceTransition(this.db, "kauro.payment_routes", `${provider}:${environment}`);
    const r = await execute<RouteRow>(this.db, `SELECT ${ROUTE_COLUMNS} FROM kauro.payment_routes WHERE provider = $1 AND environment = $2 AND state = 'QUALIFIED'`, [provider, environment]);
    return r.rows[0] ? routeRecord(r.rows[0]) : null;
  }
}

// --- fiscal profiles and issuers ---------------------------------------------------------------------------------------------------

interface ProfileRow {
  profile_id: string;
  agency_id: string;
  operator_legal_ref: string;
  customer_legal_ref: string;
  service_classification: string;
  territory: string;
  tax_treatment: FiscalProfileRecord["taxTreatment"];
  tax_rule: FiscalProfileRecord["taxRule"];
  tax_rate_bps: number;
  evidence_hash: string;
  export_evidence_hash: string | null;
  reviewed_by_user_id: string | null;
  valid_from: Date;
  valid_until: Date | null;
  supersedes_profile_id: string | null;
  superseded_at: Date | null;
  created_at: Date;
}

const PROFILE_COLUMNS =
  "profile_id, agency_id, operator_legal_ref, customer_legal_ref, service_classification, territory, tax_treatment, tax_rule, tax_rate_bps, evidence_hash, export_evidence_hash, reviewed_by_user_id, valid_from, valid_until, supersedes_profile_id, superseded_at, created_at";

function profileRecord(r: ProfileRow): FiscalProfileRecord {
  return defined<FiscalProfileRecord>(
    {
      profileId: r.profile_id as FiscalProfileId,
      agencyId: r.agency_id as AgencyId,
      operatorLegalRef: r.operator_legal_ref as FiscalIssuerRef,
      customerLegalRef: r.customer_legal_ref,
      serviceClassification: r.service_classification,
      territory: r.territory,
      taxTreatment: r.tax_treatment,
      taxRule: r.tax_rule,
      taxRateBps: int(r.tax_rate_bps),
      evidenceHash: r.evidence_hash,
      validFrom: instant(r.valid_from),
      recordedAt: instant(r.created_at),
    },
    {
      exportEvidenceHash: optionalText(r.export_evidence_hash),
      reviewedByUserId: optionalText(r.reviewed_by_user_id),
      validUntil: optionalInstant(r.valid_until),
      supersedesProfileId: optionalText(r.supersedes_profile_id),
      supersededAt: optionalInstant(r.superseded_at),
    },
  );
}

interface IssuerRow {
  issuer_ref: string;
  jurisdiction: string;
  legal_identity_hash: string;
  legal_fact_status: FiscalIssuerRecord["legalFactStatus"];
  route_kind: FiscalIssuerRecord["routeKind"];
  integration_class: FiscalIssuerRecord["integrationClass"];
  route_state: FiscalIssuerRecord["routeState"];
  numbering_authorization_ref: string | null;
  entitlement_evidence_hash: string | null;
  valid_from: Date | null;
  valid_until: Date | null;
}

const ISSUER_COLUMNS = "issuer_ref, jurisdiction, legal_identity_hash, legal_fact_status, route_kind, integration_class, route_state, numbering_authorization_ref, entitlement_evidence_hash, valid_from, valid_until";

function issuerRecord(r: IssuerRow): FiscalIssuerRecord {
  return defined<FiscalIssuerRecord>(
    {
      issuerRef: r.issuer_ref as FiscalIssuerRef,
      jurisdiction: r.jurisdiction,
      legalIdentityHash: r.legal_identity_hash,
      legalFactStatus: r.legal_fact_status,
      routeKind: r.route_kind,
      integrationClass: r.integration_class,
      routeState: r.route_state,
    },
    {
      numberingAuthorizationRef: optionalText(r.numbering_authorization_ref),
      entitlementEvidenceHash: optionalText(r.entitlement_evidence_hash),
      validFrom: optionalInstant(r.valid_from),
      validUntil: optionalInstant(r.valid_until),
    },
  );
}

export class PgFiscalRepository implements FiscalRepository {
  constructor(private readonly db: Queryable) {}

  /** The current (unsuperseded) version, after the profile's transition lock keyed by the agency (0014). */
  async currentProfile(agencyId: AgencyId): Promise<FiscalProfileRecord | null> {
    await awaitCommerceTransition(this.db, "kauro.fiscal_profiles", agencyId);
    const r = await execute<ProfileRow>(this.db, `SELECT ${PROFILE_COLUMNS} FROM kauro.fiscal_profiles WHERE agency_id = $1 AND superseded_at IS NULL`, [agencyId]);
    return r.rows[0] ? profileRecord(r.rows[0]) : null;
  }

  /**
   * The version every document of a sale takes (D-FISC-B4, D-FISC-B6; B09-N5): the domain's saleProfileAt over every version of the
   * agency, read after kauro.await_transition('kauro.fiscal_profiles', agency) so a re-review in flight is ordered before or after.
   */
  async saleProfileAt(agencyId: AgencyId, taxPoint: UtcInstant): Promise<FiscalProfileRecord | null> {
    await awaitCommerceTransition(this.db, "kauro.fiscal_profiles", agencyId);
    const r = await execute<ProfileRow>(this.db, `SELECT ${PROFILE_COLUMNS} FROM kauro.fiscal_profiles WHERE agency_id = $1 ORDER BY created_at, profile_id`, [agencyId]);
    return saleProfileAt(r.rows.map(profileRecord), taxPoint);
  }

  async getProfile(profileId: FiscalProfileId): Promise<FiscalProfileRecord | null> {
    const r = await execute<ProfileRow>(this.db, `SELECT ${PROFILE_COLUMNS} FROM kauro.fiscal_profiles WHERE profile_id = $1`, [profileId]);
    return r.rows[0] ? profileRecord(r.rows[0]) : null;
  }

  async getIssuer(issuerRef: FiscalIssuerRef): Promise<FiscalIssuerRecord | null> {
    await awaitCommerceTransition(this.db, "kauro.fiscal_issuers", issuerRef);
    const r = await execute<IssuerRow>(this.db, `SELECT ${ISSUER_COLUMNS} FROM kauro.fiscal_issuers WHERE issuer_ref = $1`, [issuerRef]);
    return r.rows[0] ? issuerRecord(r.rows[0]) : null;
  }

  /**
   * Records a reviewed version in the finance scope: the predecessor's superseded_at and the successor's created_at are ONE
   * instant (profile.recordedAt), written in this unit of work — the predecessor first (fiscal_profiles_one_current), then the
   * successor. The database checks the rest at COMMIT (fiscal_profiles_successor_fk, fiscal_profiles_supersession_lineage), the
   * grant (the finance policy) and a second supersession (KA004).
   */
  async recordProfile(profile: NewFiscalProfile): Promise<FiscalProfileRecord> {
    if (profile.supersedesProfileId !== undefined) {
      const superseded = await execute(this.db, "UPDATE kauro.fiscal_profiles SET superseded_at = $3 WHERE agency_id = $1 AND profile_id = $2", [profile.agencyId, profile.supersedesProfileId, profile.recordedAt]);
      if (superseded.rowCount !== 1) throw new DomainFailure("NOT_FOUND", "the fiscal profile version to supersede is not visible in this finance scope");
    }
    const r = await execute<ProfileRow>(
      this.db,
      `INSERT INTO kauro.fiscal_profiles (profile_id, agency_id, operator_legal_ref, customer_legal_ref, service_classification, territory, tax_treatment, tax_rule, tax_rate_bps, evidence_hash, export_evidence_hash, reviewed_by_user_id, valid_from, valid_until, supersedes_profile_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING ${PROFILE_COLUMNS}`,
      [
        profile.profileId,
        profile.agencyId,
        profile.operatorLegalRef,
        profile.customerLegalRef,
        profile.serviceClassification,
        profile.territory,
        profile.taxTreatment,
        profile.taxRule,
        profile.taxRateBps,
        profile.evidenceHash,
        profile.exportEvidenceHash ?? null,
        profile.reviewedByUserId ?? null,
        profile.validFrom,
        profile.validUntil ?? null,
        profile.supersedesProfileId ?? null,
        profile.recordedAt,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "fiscal profile insert returned no row");
    return profileRecord(row);
  }
}

// --- corporate grants, refund policies, price policies --------------------------------------------------------------------------------

interface GrantRow {
  grant_id: string;
  user_id: string;
  role: CorporateRole;
  state: CorporateGrantRecord["state"];
  evidence_hash: string;
  granted_at: Date;
  revoked_at: Date | null;
}

export class PgCorporateGrantRepository implements CorporateGrantRepository {
  constructor(private readonly db: Queryable) {}

  /** The caller's own ACTIVE grant (self policy), after the grant's transition lock keyed by its person (0013). */
  async activeGrant(userId: UserId, role: CorporateRole): Promise<CorporateGrantRecord | null> {
    await awaitCommerceTransition(this.db, "kauro.corporate_roles", userId);
    const r = await execute<GrantRow>(
      this.db,
      "SELECT grant_id, user_id, role, state, evidence_hash, granted_at, revoked_at FROM kauro.corporate_roles WHERE user_id = $1 AND role = $2 AND state = 'ACTIVE'",
      [userId, role],
    );
    const g = r.rows[0];
    if (!g) return null;
    return defined<CorporateGrantRecord>(
      { grantId: g.grant_id as CorporateGrantId, userId: g.user_id as UserId, role: g.role, state: g.state, evidenceHash: g.evidence_hash, grantedAt: instant(g.granted_at) },
      { revokedAt: optionalInstant(g.revoked_at) },
    );
  }
}

interface PolicyRow {
  policy_id: string;
  policy_kind: RefundPolicyRecord["policyKind"];
  policy_version: string;
  refund_scope: RefundPolicyRecord["refundScope"];
  max_refund_cents: string | null;
  applies_to_phase: RefundPolicyRecord["appliesToPhase"];
  applies_to_origin: RefundPolicyRecord["appliesToOrigin"];
  conditions_hash: string;
  authorized_by_user_id: string;
  authorization_proof_ref: string;
  state: RefundPolicyRecord["state"];
  valid_from: Date;
  valid_until: Date | null;
}

export class PgRefundPolicyRepository implements RefundPolicyRepository {
  constructor(private readonly db: Queryable) {}

  async get(policyId: RefundPolicyId): Promise<RefundPolicyRecord | null> {
    const r = await execute<PolicyRow>(
      this.db,
      `SELECT policy_id, policy_kind, policy_version, refund_scope, max_refund_cents, applies_to_phase, applies_to_origin, conditions_hash, authorized_by_user_id, authorization_proof_ref, state, valid_from, valid_until
         FROM kauro.refund_policies WHERE policy_id = $1`,
      [policyId],
    );
    const p = r.rows[0];
    if (!p) return null;
    return defined<RefundPolicyRecord>(
      {
        policyId: p.policy_id as RefundPolicyId,
        policyKind: p.policy_kind,
        policyVersion: p.policy_version,
        refundScope: p.refund_scope,
        appliesToPhase: p.applies_to_phase,
        appliesToOrigin: p.applies_to_origin,
        conditionsHash: p.conditions_hash,
        authorizedByUserId: p.authorized_by_user_id as UserId,
        authorizationProofRef: p.authorization_proof_ref as AssuranceProofId,
        state: p.state,
        validFrom: instant(p.valid_from),
      },
      { maxRefundCents: optionalCents(p.max_refund_cents), validUntil: optionalInstant(p.valid_until) },
    );
  }
}

export class PgPricePolicyRepository implements PricePolicyRepository {
  constructor(private readonly db: Queryable) {}

  async get(policyVersion: string): Promise<PricePolicyRecord | null> {
    const r = await execute<{ policy_version: string; quote_seconds: number; repeat_lookback_seconds: number; founding_discount_bps: number; pre_execution_replacements_included: number; unpaid_source_hard_seconds: number }>(
      this.db,
      "SELECT policy_version, quote_seconds, repeat_lookback_seconds, founding_discount_bps, pre_execution_replacements_included, unpaid_source_hard_seconds FROM kauro.price_policies WHERE policy_version = $1",
      [policyVersion],
    );
    const p = r.rows[0];
    if (!p) return null;
    return {
      policyVersion: p.policy_version,
      quoteSeconds: int(p.quote_seconds),
      repeatLookbackSeconds: int(p.repeat_lookback_seconds),
      foundingDiscountBps: int(p.founding_discount_bps),
      preExecutionReplacementsIncluded: int(p.pre_execution_replacements_included),
      unpaidSourceHardSeconds: int(p.unpaid_source_hard_seconds),
    };
  }
}

// --- scope index (D-SCOPE-B1, D-SCOPE-B2) ----------------------------------------------------------------------------------------------

interface ScopeRow {
  scope_kind: ScopeKind;
  scope_key: string;
  agency_id: string;
  order_id: string;
  capture_id: string | null;
  refund_id: string | null;
}

export function scopeEntry(r: ScopeRow): ScopeEntry {
  return defined<ScopeEntry>(
    { kind: r.scope_kind, key: r.scope_key, agencyId: r.agency_id as AgencyId, orderId: r.order_id as PaymentOrderId },
    { captureId: optionalText(r.capture_id) as CaptureId | undefined, refundId: optionalText(r.refund_id) as RefundId | undefined },
  );
}

export class PgScopeIndex implements ScopeIndex {
  constructor(private readonly db: Queryable) {}

  /**
   * Appends one row, written by the operation's own writer in its own scope (the policies: the request handlers PAYMENT_ORDER and
   * REFUND rows of their agency, the payment service REFUND and provider rows of the agency it adopted); the key binding and the
   * composite keys refuse an identity the object did not learn or an object of another agency (B09-F11).
   */
  async record(entry: ScopeEntry, now: UtcInstant): Promise<void> {
    await execute(
      this.db,
      "INSERT INTO kauro.commerce_scopes (scope_kind, scope_key, agency_id, order_id, capture_id, refund_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [entry.kind, entry.key, entry.agencyId, entry.orderId, entry.captureId ?? null, entry.refundId ?? null, now],
    );
  }

  async resolve(kind: ScopeKind, key: string): Promise<ScopeEntry | null> {
    const r = await execute<ScopeRow>(this.db, "SELECT scope_kind, scope_key, agency_id, order_id, capture_id, refund_id FROM kauro.commerce_scopes WHERE scope_kind = $1 AND scope_key = $2", [kind, key]);
    return r.rows[0] ? scopeEntry(r.rows[0]) : null;
  }
}
