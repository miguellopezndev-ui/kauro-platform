/**
 * The records a B13 report is made from, over `pg` (order 6; docs/design/B13-report-inputs.md; migration 0095; @kauro/domain
 * ports/report-sources.ts).
 *
 * - `read` is the control plane's: one SYSTEM unit of work bound to the job's agency (kauro_control, D-CTRL-1), every statement keyed by
 *   the scope's agency and the job's own binding, so a record of another agency, project, job or subject is never returned. It reads and
 *   returns; it decides nothing — a missing record is null, never an empty list or a default, and @kauro/data-plane assembleReportFacts
 *   verifies every binding (the quote's terms preimage against its hash, the legal identity against the issuer's hash, the disclosure set
 *   against the approval's hash) before a report can be made.
 * - `brandingVersions` is the request handlers' (kauro_app): the agency's ACTIVE OWNER or ADMIN records the next version as itself.
 * - `legalIdentities` is the control plane's: the operator records the owner's legal identity document, content-addressed.
 */
import type { Sha256Hex } from "@kauro/contracts";
import {
  DomainFailure,
  readLegalIdentity,
  type AgencyId,
  type BrandingVersionRecord,
  type BrandingVersionRepository,
  type LegalFactStatus,
  type NewBrandingVersion,
  type PlanBody,
  type QuoteTermsPreimage,
  type RecordedReportFacts,
  type ReportFactsReader,
  type ReportFactsScope,
} from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
import { exact } from "../source/rows.js";

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const str = (v: unknown): string => {
  if (typeof v !== "string") throw new TypeError(`expected a text column value, got ${typeof v}`);
  return v;
};
/** A non-negative integer from its text (bigint columns are read as ::text), else null. */
const count = (v: unknown): number | null => (typeof v === "string" && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null);

const QUOTE_COLUMNS = `q.quote_id, q.agency_id, q.project_id, q.plan_id, q.approval_id, q.state, q.plan_hash, q.revision_hash, q.target_contract_hash, q.mode,
  q.billable_units::text AS billable_units, q.price_policy_version, q.discount_policy_version, q.eligibility_snapshot_id,
  q.base_service_cents::text AS base_service_cents, q.discount_bps, q.discount_cents::text AS discount_cents, q.service_cents::text AS service_cents,
  q.fiscal_profile_id, q.issuer_ref, q.tax_treatment, q.tax_rule, q.tax_rate_bps, q.tax_cents::text AS tax_cents, q.total_cents::text AS total_cents, q.currency,
  ${exact("q.issued_at")}, ${exact("q.expires_at")}, ${exact("q.source_available_until")}, q.terms_version, q.terms_hash`;

/** The quote's KAURO_QUOTE_TERMS_V1 preimage exactly as CMD027 hashed it: money as decimal strings, instants exact to the microsecond. */
function preimageOf(q: Row): QuoteTermsPreimage {
  const units = count(q["billable_units"]);
  if (units === null) throw new TypeError("a quote's billable units are a non-negative integer");
  return {
    quoteId: str(q["quote_id"]),
    agencyId: str(q["agency_id"]),
    projectId: str(q["project_id"]),
    planId: str(q["plan_id"]),
    approvalId: str(q["approval_id"]),
    planHash: str(q["plan_hash"]) as Sha256Hex,
    revisionHash: str(q["revision_hash"]) as Sha256Hex,
    targetContractHash: str(q["target_contract_hash"]) as Sha256Hex,
    mode: str(q["mode"]) as QuoteTermsPreimage["mode"],
    billableUnits: units,
    pricePolicyVersion: str(q["price_policy_version"]),
    discountPolicyVersion: str(q["discount_policy_version"]),
    eligibilitySnapshotId: str(q["eligibility_snapshot_id"]),
    baseServiceCents: str(q["base_service_cents"]) as QuoteTermsPreimage["baseServiceCents"],
    discountBps: int(q["discount_bps"]),
    discountCents: str(q["discount_cents"]) as QuoteTermsPreimage["discountCents"],
    serviceCents: str(q["service_cents"]) as QuoteTermsPreimage["serviceCents"],
    fiscalProfileId: str(q["fiscal_profile_id"]),
    issuerRef: str(q["issuer_ref"]),
    taxTreatment: str(q["tax_treatment"]) as QuoteTermsPreimage["taxTreatment"],
    taxRule: str(q["tax_rule"]) as QuoteTermsPreimage["taxRule"],
    taxRateBps: int(q["tax_rate_bps"]),
    taxCents: str(q["tax_cents"]) as QuoteTermsPreimage["taxCents"],
    totalCents: str(q["total_cents"]) as QuoteTermsPreimage["totalCents"],
    currency: str(q["currency"]) as "USD",
    issuedAt: str(q["issued_at"]) as QuoteTermsPreimage["issuedAt"],
    expiresAt: str(q["expires_at"]) as QuoteTermsPreimage["expiresAt"],
    sourceAvailableUntil: str(q["source_available_until"]) as QuoteTermsPreimage["sourceAvailableUntil"],
    termsVersion: str(q["terms_version"]),
  };
}

const brandingOf = (r: Row): BrandingVersionRecord => ({
  agencyId: str(r["agency_id"]),
  version: int(r["branding_version"]),
  displayName: str(r["display_name"]),
  recordedAt: str(r["recorded_at"]),
});

/** The agency's branding versions (migration 0095): append-only, numbered by the database's guard, recorded by an OWNER or ADMIN. */
export class PgBrandingVersions implements BrandingVersionRepository {
  constructor(private readonly db: Queryable) {}

  async record(input: NewBrandingVersion): Promise<BrandingVersionRecord> {
    // the next number; a concurrent recorder of the same number loses on the primary key (agency_branding_versions_pkey), and a number
    // that is not the next is refused by the guard (agency_branding_versions_contiguous)
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.agency_branding_versions (agency_id, branding_version, display_name, recorded_by_membership_id, recorded_by_user_id)
       SELECT $1::uuid, coalesce(max(b.branding_version), 0) + 1, $2, $3::uuid, kauro.current_user_id()
         FROM kauro.agency_branding_versions b WHERE b.agency_id = $1::uuid
       RETURNING agency_id, branding_version, display_name, ${exact("recorded_at")}`,
      [input.agencyId, input.displayName, input.recordedByMembershipId],
    );
    const row = r.rows[0];
    if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the branding version was not recorded");
    return brandingOf(row);
  }

  async versionsOf(agencyId: AgencyId): Promise<readonly BrandingVersionRecord[]> {
    const r = await execute<Row>(
      this.db,
      `SELECT agency_id, branding_version, display_name, ${exact("recorded_at")} FROM kauro.agency_branding_versions WHERE agency_id = $1 ORDER BY branding_version`,
      [agencyId],
    );
    return r.rows.map(brandingOf);
  }
}

/** The legal identity documents of the fiscal issuers (migration 0095): content-addressed, append-only, the control plane's. */
export class PgLegalIdentitySnapshots {
  constructor(private readonly db: Queryable) {}

  /**
   * Records a document after reading it as a complete KAURO_LEGAL_IDENTITY_V1 identity; recording the same bytes again is the same
   * record. Answers its hash — the value a fiscal issuer's legal_identity_hash must name — and the instant it was first recorded.
   */
  async record(document: Uint8Array): Promise<{ readonly legalIdentityHash: Sha256Hex; readonly recordedAt: string }> {
    const read = readLegalIdentity(document);
    if (!read.ok) throw new DomainFailure("INVALID_REQUEST", `the document is not a complete legal identity (${read.problem})`);
    await execute(this.db, "INSERT INTO kauro.legal_identity_snapshots (legal_identity_hash, document) VALUES ($1, $2) ON CONFLICT (legal_identity_hash) DO NOTHING", [read.sha256, Buffer.from(document)]);
    const r = await execute<Row>(this.db, `SELECT ${exact("recorded_at")} FROM kauro.legal_identity_snapshots WHERE legal_identity_hash = $1`, [read.sha256]);
    const row = r.rows[0];
    if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the legal identity document was not recorded");
    return { legalIdentityHash: read.sha256, recordedAt: str(row["recorded_at"]) };
  }

  /** The document recorded under `legalIdentityHash`, or null. */
  async documentOf(legalIdentityHash: string): Promise<Uint8Array | null> {
    const r = await execute<{ document: Buffer }>(this.db, "SELECT document FROM kauro.legal_identity_snapshots WHERE legal_identity_hash = $1", [legalIdentityHash]);
    const row = r.rows[0];
    return row === undefined ? null : new Uint8Array(row.document);
  }
}

/** The control plane's read of one attempt's report sources (see the header). */
export class PgReportSources implements ReportFactsReader {
  readonly brandingVersions: PgBrandingVersions;
  readonly legalIdentities: PgLegalIdentitySnapshots;

  constructor(private readonly db: Queryable) {
    this.brandingVersions = new PgBrandingVersions(db);
    this.legalIdentities = new PgLegalIdentitySnapshots(db);
  }

  private async first(text: string, params: ReadonlyArray<unknown>): Promise<Row | null> {
    const r = await execute<Row>(this.db, text, params);
    return r.rows.length === 1 ? (r.rows[0] as Row) : null;
  }

  /** A quote of the bound agency as recorded: its state, its recorded terms hash and every member of its KAURO_QUOTE_TERMS_V1 preimage. */
  async quoteOf(agencyId: string, quoteId: string): Promise<RecordedReportFacts["quote"]> {
    const q = await this.first(`SELECT ${QUOTE_COLUMNS} FROM kauro.quotes q WHERE q.agency_id = $1 AND q.quote_id = $2`, [agencyId, quoteId]);
    return q === null ? null : { state: str(q["state"]), termsHash: str(q["terms_hash"]), preimage: preimageOf(q) };
  }

  async read(scope: ReportFactsScope): Promise<RecordedReportFacts | null> {
    const { agencyId, projectId, jobId, attemptId } = scope;
    if (![agencyId, projectId, jobId, attemptId].every((id) => UUID.test(id))) return null;
    // the attempt of the scope's job, project and agency, and the job's binding
    const j = await this.first(
      `SELECT j.plan_id, j.plan_hash, j.approval_id, j.revision_hash, j.target_contract_hash, j.validation_receipt_hash, j.authorization_id,
              ${exact("j.queued_at")}, a.state AS attempt_state, a.ordinal
         FROM kauro.processing_jobs j
         JOIN kauro.processing_attempts a ON a.agency_id = j.agency_id AND a.project_id = j.project_id AND a.job_id = j.job_id
        WHERE j.agency_id = $1 AND j.project_id = $2 AND j.job_id = $3 AND a.attempt_id = $4`,
      [agencyId, projectId, jobId, attemptId],
    );
    if (j === null) return null;
    const job = {
      planId: str(j["plan_id"]),
      planHash: str(j["plan_hash"]),
      approvalId: str(j["approval_id"]),
      revisionHash: str(j["revision_hash"]),
      targetContractHash: str(j["target_contract_hash"]),
      validationReceiptHash: str(j["validation_receipt_hash"]),
      authorizationId: str(j["authorization_id"]),
      queuedAt: str(j["queued_at"]),
    };

    // the VALID receipt of exactly the job's subject
    const v = await this.first(
      `SELECT v.receipt_hash, v.artifact_evidence_hash, v.result, v.counts ->> 'physicalSourceRows' AS physical
         FROM kauro.validation_receipts v
        WHERE v.agency_id = $1 AND v.receipt_hash = $2 AND v.plan_id = $3 AND v.plan_hash = $4 AND v.revision_hash = $5 AND v.target_contract_hash = $6`,
      [agencyId, job.validationReceiptHash, job.planId, job.planHash, job.revisionHash, job.targetContractHash],
    );
    const receipt = v === null || v["result"] !== "VALID" ? null : { receiptHash: str(v["receipt_hash"]), artifactEvidenceHash: str(v["artifact_evidence_hash"]), physicalSourceRows: count(v["physical"]) };

    // the quote the job's commercial authorization names (commercial_authorizations_quote_fk binds it to the authorization's subject)
    const named = await this.first("SELECT a.quote_id FROM kauro.commercial_authorizations a WHERE a.agency_id = $1 AND a.authorization_id = $2 AND a.project_id = $3", [agencyId, job.authorizationId, projectId]);
    const quote = named === null ? null : await this.quoteOf(agencyId, str(named["quote_id"]));

    // the agency's acceptance of that terms version, at or before the quote was issued
    const t =
      quote === null
        ? null
        : await this.first(
            `SELECT x.terms_version, x.terms_document_hash, ${exact("x.accepted_at")}
               FROM kauro.agency_agreement_acceptances x
              WHERE x.agency_id = $1 AND x.terms_kind = 'TERMS' AND x.terms_version = $2 AND x.accepted_at <= $3::timestamptz
              ORDER BY x.accepted_at DESC, x.acceptance_id DESC LIMIT 1`,
            [agencyId, quote.preimage.termsVersion, quote.preimage.issuedAt],
          );
    const termsAcceptance = t === null ? null : { version: str(t["terms_version"]), documentHash: str(t["terms_document_hash"]), acceptedAt: str(t["accepted_at"]) };

    // the issuer the quote's terms name, and the document its legal identity hash is the SHA-256 of
    const i = quote === null ? null : await this.first("SELECT issuer_ref, jurisdiction, legal_identity_hash, legal_fact_status FROM kauro.fiscal_issuers WHERE issuer_ref = $1", [quote.preimage.issuerRef]);
    const issuer =
      i === null ? null : { issuerRef: str(i["issuer_ref"]), jurisdiction: str(i["jurisdiction"]), legalIdentityHash: str(i["legal_identity_hash"]), legalFactStatus: str(i["legal_fact_status"]) as LegalFactStatus };
    const legalIdentity = issuer === null ? null : await this.legalIdentities.documentOf(issuer.legalIdentityHash);

    // the branding version in force when the job was queued (a later version is for later jobs)
    const b = await this.first(
      `SELECT agency_id, branding_version, display_name, ${exact("recorded_at")}
         FROM kauro.agency_branding_versions WHERE agency_id = $1 AND recorded_at <= $2::timestamptz
        ORDER BY branding_version DESC LIMIT 1`,
      [agencyId, job.queuedAt],
    );
    const branding = b === null ? null : brandingOf(b);

    // the one audit of the job's subject (audits_one_per_subject; a revision and a target contract hash name one row each in a project)
    const audits = await execute<Row>(
      this.db,
      "SELECT audit_id, state, finding_codes FROM kauro.audits WHERE agency_id = $1 AND project_id = $2 AND revision_hash = $3 AND target_contract_hash = $4",
      [agencyId, projectId, job.revisionHash, job.targetContractHash],
    );
    const a = audits.rows.length === 1 ? (audits.rows[0] as Row) : null;
    const findings = a === null ? null : a["finding_codes"];
    const audit =
      a === null || !Array.isArray(findings) || !findings.every((f): f is string => typeof f === "string")
        ? null
        : { auditId: str(a["audit_id"]), state: str(a["state"]), findingCodes: [...findings] };

    // the job's approval of its plan and the disclosure set it was granted over, and the plan's body
    const p = await this.first("SELECT approval_id, plan_hash, validation_receipt_hash, disclosures_hash FROM kauro.approvals WHERE agency_id = $1 AND approval_id = $2 AND plan_id = $3", [agencyId, job.approvalId, job.planId]);
    const approval = p === null ? null : { approvalId: str(p["approval_id"]), planHash: str(p["plan_hash"]), receiptHash: str(p["validation_receipt_hash"]), disclosuresHash: str(p["disclosures_hash"]) };
    const b2 = await this.first("SELECT plan_id, body_hash, body FROM kauro.plans WHERE agency_id = $1 AND plan_id = $2 AND project_id = $3", [agencyId, job.planId, projectId]);
    const plan = b2 === null ? null : { planId: str(b2["plan_id"]), bodyHash: str(b2["body_hash"]), body: b2["body"] as PlanBody };

    return {
      scope: { agencyId, projectId, jobId, attemptId },
      job,
      attempt: { state: str(j["attempt_state"]), ordinal: int(j["ordinal"]) },
      receipt,
      quote,
      termsAcceptance,
      issuer,
      legalIdentity,
      branding,
      audit,
      approval,
      plan,
    };
  }
}
