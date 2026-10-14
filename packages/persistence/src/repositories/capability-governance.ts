/**
 * The capability governance records of package B18 over `pg` (migration 0051; registry commands CMD058 and CMD059): the capability row
 * read FOR UPDATE with its revision, the PROSPECTIVE versions CMD058 appends and the restrictions CMD059 appends with the SUSPENDED edge.
 * Every instant is the database's (the stamp triggers of 0051); a write is a compare-and-swap on the revision the caller read under the
 * row lock, so a miss means a concurrent writer won. Only the corporate owner's request session passes the policies of 0051.
 */
import type { Capability, Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  isUtcInstant,
  type CapabilityGovernanceRecord,
  type CapabilityGovernanceRepository,
  type CapabilityId,
  type CapabilityRestrictionRecord,
  type CapabilityVersionRecord,
  type OperationsActor,
  type UserId,
  type VendorQualificationRecord,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, type Queryable } from "../sql.js";

const CANONICAL_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

function instantOf(v: unknown): UtcInstant {
  if (typeof v !== "string" || !isUtcInstant(v)) throw new TypeError("expected a canonical instant column value");
  return v;
}

interface CapabilityRow {
  capability_id: string;
  revision: number;
  state: Capability["state"];
  profile_hash: string;
  kind: CapabilityGovernanceRecord["kind"];
  mode: CapabilityGovernanceRecord["mode"];
}
interface QualificationRow {
  evidence_hash: string;
  capability_id: string;
  profile_hash: string;
  export_back_evidence_hash: string | null;
  result: "PASS" | "FAIL";
}
interface VersionRow {
  capability_id: string;
  version_no: number;
  profile_hash: string;
  qualification_evidence_hashes: string[];
  created_at: string;
}
interface RestrictionRow {
  restriction_id: string;
  capability_id: string;
  incident_ref: string;
  prior_state: Capability["state"];
  revision_after: number;
  created_at: string;
}

export class PgCapabilityGovernanceRepository implements CapabilityGovernanceRepository {
  constructor(private readonly db: Queryable) {}

  async lockCapability(capabilityId: CapabilityId): Promise<CapabilityGovernanceRecord | null> {
    const r = await execute<CapabilityRow>(this.db, "SELECT capability_id, revision, state, profile_hash, kind, mode FROM kauro.capabilities WHERE capability_id = $1 FOR NO KEY UPDATE", [capabilityId]);
    const row = r.rows[0];
    return row ? { capabilityId: row.capability_id as CapabilityId, revision: Number(row.revision), state: row.state, profileHash: row.profile_hash as Sha256Hex, kind: row.kind, mode: row.mode } : null;
  }

  /** The vendor_qualifications rows (insert-only, immutable: no lock) carrying these evidence hashes; the owner session reads them (0073 policy). */
  async qualificationsOf(evidenceHashes: ReadonlyArray<Sha256Hex>): Promise<ReadonlyArray<VendorQualificationRecord>> {
    if (evidenceHashes.length === 0) return [];
    const r = await execute<QualificationRow>(
      this.db,
      "SELECT evidence_hash, capability_id, profile_hash, export_back_evidence_hash, result FROM kauro.vendor_qualifications WHERE evidence_hash = ANY($1::text[])",
      [evidenceHashes],
    );
    return r.rows.map((row) => ({
      evidenceHash: row.evidence_hash as Sha256Hex,
      capabilityId: row.capability_id as CapabilityId,
      profileHash: row.profile_hash as Sha256Hex,
      exportBackEvidenceHash: row.export_back_evidence_hash as Sha256Hex | null,
      result: row.result,
    }));
  }

  /** A compare-and-swap miss under the row lock: what the capability is now. */
  private async stale(capabilityId: CapabilityId): Promise<{ readonly kind: "STALE"; readonly currentVersion: number; readonly currentState: string }> {
    const now = await this.lockCapability(capabilityId);
    return { kind: "STALE", currentVersion: now?.revision ?? 0, currentState: now?.state ?? "UNKNOWN" };
  }

  async holdsProfile(capabilityId: CapabilityId, profileHash: Sha256Hex): Promise<boolean> {
    const r = await execute<{ held: boolean }>(
      this.db,
      `SELECT (EXISTS (SELECT 1 FROM kauro.capabilities WHERE capability_id = $1 AND profile_hash = $2)
            OR EXISTS (SELECT 1 FROM kauro.capability_versions WHERE capability_id = $1 AND profile_hash = $2)) AS held`,
      [capabilityId, profileHash],
    );
    return r.rows[0]?.held === true;
  }

  async recordVersion(input: {
    readonly capabilityId: CapabilityId;
    readonly expectedRevision: number;
    readonly profileHash: Sha256Hex;
    readonly evidenceHashes: ReadonlyArray<Sha256Hex>;
    readonly by: UserId;
  }): Promise<VersionedWrite<CapabilityVersionRecord>> {
    const moved = await execute<{ revision: number }>(
      this.db,
      "UPDATE kauro.capabilities SET revision = revision + 1 WHERE capability_id = $1 AND revision = $2 RETURNING revision",
      [input.capabilityId, input.expectedRevision],
    );
    const next = moved.rows[0];
    if (!next) return this.stale(input.capabilityId);
    const r = await execute<VersionRow>(
      this.db,
      `INSERT INTO kauro.capability_versions (capability_id, version_no, status, profile_hash, qualification_evidence_hashes, recorded_by_user_id)
       VALUES ($1, $2, 'PROSPECTIVE', $3, $4::jsonb, $5)
       RETURNING capability_id, version_no, profile_hash, qualification_evidence_hashes, to_char(created_at AT TIME ZONE 'UTC', ${CANONICAL_FORMAT}) AS created_at`,
      [input.capabilityId, Number(next.revision), input.profileHash, JSON.stringify(input.evidenceHashes), input.by],
    );
    const row = r.rows[0]!;
    return { kind: "APPLIED", record: {
      capabilityId: row.capability_id as CapabilityId,
      versionNo: Number(row.version_no),
      status: "PROSPECTIVE",
      profileHash: row.profile_hash as Sha256Hex,
      qualificationEvidenceHashes: row.qualification_evidence_hashes as Sha256Hex[],
      createdAt: instantOf(row.created_at),
    } };
  }

  async restrict(input: {
    readonly restrictionId: string;
    readonly capabilityId: CapabilityId;
    readonly expectedRevision: number;
    readonly incidentRef: string;
    readonly priorState: Capability["state"];
    readonly by: OperationsActor;
  }): Promise<VersionedWrite<CapabilityRestrictionRecord>> {
    const moved = await execute<{ revision: number }>(
      this.db,
      "UPDATE kauro.capabilities SET state = 'SUSPENDED', revision = revision + 1 WHERE capability_id = $1 AND revision = $2 RETURNING revision",
      [input.capabilityId, input.expectedRevision],
    );
    const next = moved.rows[0];
    if (!next) return this.stale(input.capabilityId);
    const r = await execute<RestrictionRow>(
      this.db,
      `INSERT INTO kauro.capability_restrictions (restriction_id, capability_id, incident_ref, prior_state, revision_after, ${input.by.kind === "USER" ? "recorded_by_user_id" : "recorded_by_service"})
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING restriction_id, capability_id, incident_ref, prior_state, revision_after, to_char(created_at AT TIME ZONE 'UTC', ${CANONICAL_FORMAT}) AS created_at`,
      [input.restrictionId, input.capabilityId, input.incidentRef, input.priorState, Number(next.revision), input.by.kind === "USER" ? input.by.userId : input.by.serviceId],
    );
    const row = r.rows[0]!;
    return { kind: "APPLIED", record: {
      restrictionId: row.restriction_id,
      capabilityId: row.capability_id as CapabilityId,
      incidentRef: row.incident_ref,
      priorState: row.prior_state,
      revisionAfter: Number(row.revision_after),
      createdAt: instantOf(row.created_at),
    } };
  }
}
