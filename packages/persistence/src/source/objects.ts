/**
 * The object registry (deletion inventory) and the provider retention read-back over `pg` (B07; migration 0009; decisions D-OBJ-1,
 * D-OBJ-2, D-OBJ-3, D-CLOCK-1). Registry rows are not aggregates (no version, no event). Every row is born INTENDED; a generation,
 * its length and digest are set once; rows are never deleted. Every stamp — registration, observation, verification, deletion
 * request, deletion, read-back — is kauro.server_now() in SQL: the caller instants the port still carries (`createdAt`,
 * `observedAt`, `verifiedAt`, `at`) never reach a column. A deletion records the provider residual the location's latest read-back
 * implies (LOCATION_POLICY), computed in SQL from that read-back at the deletion's own instant; the database refuses any other value
 * and a deletion at a location never read back (KA072). A generation inventory found already soft-deleted records the expiry the
 * provider reported (PROVIDER_REPORTED) — a provider fact, not a platform stamp.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  type AgencyId,
  type DeletionResult,
  type MembershipId,
  type NewStoredObject,
  type ProjectId,
  type RevisionId,
  type SourceFileId,
  type StorageLocationPolicyRecord,
  type StoredObjectId,
  type StoredObjectRecord,
  type StoredObjectRepository,
  type UploadId,
} from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
import { bool, exact, instantText, notAvailable, one, opt, optionalInstantText, optionalInt, optionalString, pageLimit, str } from "./rows.js";

const OBJECT_COLUMNS = [
  "object_id",
  "agency_id",
  "project_id",
  "revision_id",
  "upload_id",
  "file_id",
  "zone",
  "data_class",
  "provider",
  "location_ref",
  "object_name",
  "generation",
  "bytes::text AS bytes",
  "sha256",
  "state",
  "late",
  "created_by_kind",
  "created_by_ref",
  exact("observed_at"),
  exact("verified_at"),
  exact("deletion_requested_at"),
  "deletion_reason",
  exact("deleted_at"),
  "deletion_result",
  "deletion_attempts",
  exact("provider_residual_until"),
  "provider_residual_basis",
  exact("created_at"),
].join(", ");

type Row = Record<string, unknown>;

/** The reason a registry row records for a generation provider inventory found already soft-deleted. */
export const PROVIDER_SOFT_DELETED_REASON = "PROVIDER_SOFT_DELETED";

export function objectRecord(r: Row): StoredObjectRecord {
  const createdBy: StoredObjectRecord["createdBy"] =
    r["created_by_kind"] === "MEMBERSHIP" ? { kind: "MEMBERSHIP", membershipId: str<MembershipId>(r["created_by_ref"]) } : { kind: "SERVICE", serviceId: str(r["created_by_ref"]) };
  const basis = optionalString<"LOCATION_POLICY" | "PROVIDER_REPORTED">(r["provider_residual_basis"]);
  return {
    objectId: str<StoredObjectId>(r["object_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    projectId: str<ProjectId>(r["project_id"]),
    ...opt("revisionId", optionalString<RevisionId>(r["revision_id"])),
    ...opt("uploadId", optionalString<UploadId>(r["upload_id"])),
    ...opt("fileId", optionalString<SourceFileId>(r["file_id"])),
    zone: str<StoredObjectRecord["zone"]>(r["zone"]),
    dataClass: str<StoredObjectRecord["dataClass"]>(r["data_class"]),
    provider: str(r["provider"]),
    locationRef: str(r["location_ref"]),
    objectName: str(r["object_name"]),
    ...opt("generation", optionalString(r["generation"])),
    ...opt("bytes", optionalInt(r["bytes"])),
    ...opt("sha256", optionalString<Sha256Hex>(r["sha256"])),
    state: str<StoredObjectRecord["state"]>(r["state"]),
    late: bool(r["late"]),
    createdBy,
    ...opt("observedAt", optionalInstantText(r["observed_at"])),
    ...opt("verifiedAt", optionalInstantText(r["verified_at"])),
    ...opt("deletionRequestedAt", optionalInstantText(r["deletion_requested_at"])),
    ...opt("deletionReason", optionalString(r["deletion_reason"])),
    ...opt("deletedAt", optionalInstantText(r["deleted_at"])),
    ...opt("deletionResult", optionalString<DeletionResult>(r["deletion_result"])),
    deletionAttempts: int(r["deletion_attempts"]),
    ...opt("providerResidual", basis === undefined ? undefined : { basis, ...opt("until", optionalInstantText(r["provider_residual_until"])) }),
    createdAt: instantText(r["created_at"]),
  };
}

const POLICY_COLUMNS = `observation_id, provider, location_ref, soft_delete_retention_seconds::text AS soft_delete_retention_seconds, object_versioning, evidence_hash, evidence_class, ${exact("observed_at")}`;

function policyRecord(r: Row): StorageLocationPolicyRecord {
  return {
    observationId: str(r["observation_id"]),
    provider: str(r["provider"]),
    locationRef: str(r["location_ref"]),
    softDeleteRetentionSeconds: int(r["soft_delete_retention_seconds"]),
    objectVersioning: bool(r["object_versioning"]),
    evidenceHash: str<Sha256Hex>(r["evidence_hash"]),
    evidenceClass: str<StorageLocationPolicyRecord["evidenceClass"]>(r["evidence_class"]),
    observedAt: instantText(r["observed_at"]),
  };
}

/**
 * The residual expiry a deletion recorded now implies: the retention of the location's latest read-back at or before the server
 * clock, counted from it (NULL when the location retains no deleted generation, or when no read-back exists — then the database
 * refuses the deletion, KA072). The same formula the guard kauro.stored_objects_residual_recorded checks.
 */
const LOCATION_RESIDUAL = `(SELECT CASE WHEN p.soft_delete_retention_seconds = 0 THEN NULL ELSE kauro.server_now() + make_interval(secs => p.soft_delete_retention_seconds) END
     FROM kauro.storage_location_policies p
    WHERE p.provider = o.provider AND p.location_ref = o.location_ref AND p.observed_at <= kauro.server_now()
    ORDER BY p.observed_at DESC LIMIT 1)`;

export class PgStoredObjectRepository implements StoredObjectRepository {
  constructor(private readonly db: Queryable) {}

  async get(objectId: StoredObjectId): Promise<StoredObjectRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${OBJECT_COLUMNS} FROM kauro.stored_objects WHERE object_id = $1`, [objectId]);
    return r.rows[0] ? objectRecord(r.rows[0]) : null;
  }

  /**
   * INTENDED, registered at the server's transaction time; an object already observed (a late or orphan residual) is observed in
   * the same call (every row is born INTENDED, B06 D-INIT-1). The request handlers may register only CMD013's quarantine intent
   * (row policy stored_objects_tenant_intent).
   */
  async register(object: NewStoredObject): Promise<StoredObjectRecord> {
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, file_id, zone, data_class, provider, location_ref, object_name, created_by_kind, created_by_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, kauro.server_now(), kauro.server_now()) RETURNING ${OBJECT_COLUMNS}`,
      [
        object.objectId,
        object.agencyId,
        object.projectId,
        object.revisionId ?? null,
        object.uploadId ?? null,
        object.fileId ?? null,
        object.zone,
        object.dataClass,
        object.provider,
        object.locationRef,
        object.objectName,
        object.createdBy.kind,
        object.createdBy.kind === "MEMBERSHIP" ? object.createdBy.membershipId : object.createdBy.serviceId,
      ],
    );
    const registered = objectRecord(one(r.rows, "stored object insert"));
    return object.observed === undefined ? registered : this.observe(object.objectId, object.observed);
  }

  /** INTENDED -> PRESENT with the observed generation and length (set once), at the server's transaction time; late means residual. */
  async observe(objectId: StoredObjectId, observed: { readonly generation: string; readonly bytes: number; readonly observedAt: UtcInstant; readonly late: boolean }): Promise<StoredObjectRecord> {
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.stored_objects SET state = 'PRESENT', generation = $2, bytes = $3, observed_at = kauro.server_now(), late = late OR $4::boolean,
              data_class = CASE WHEN $4::boolean THEN 'RESIDUAL' ELSE data_class END
        WHERE object_id = $1 AND state = 'INTENDED' RETURNING ${OBJECT_COLUMNS}`,
      [objectId, observed.generation, observed.bytes, observed.late],
    );
    return r.rows[0] ? objectRecord(r.rows[0]) : this.#refused(objectId, "an observation");
  }

  async verify(objectId: StoredObjectId, sha256: Sha256Hex, _verifiedAt: UtcInstant): Promise<StoredObjectRecord> {
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.stored_objects SET state = 'VERIFIED', sha256 = $2, verified_at = kauro.server_now() WHERE object_id = $1 AND state = 'PRESENT' RETURNING ${OBJECT_COLUMNS}`,
      [objectId, sha256],
    );
    return r.rows[0] ? objectRecord(r.rows[0]) : this.#refused(objectId, "a verification");
  }

  /**
   * -> DELETION_REQUESTED at the server's transaction time for every object not already requested or deleted (a repeated request
   * changes nothing). An accepted generation whose file's admission still stands is retained — by a seal's retention or by its
   * intake window — and is refused: its admission is revoked first (INTAKE_EXPIRED, RETENTION_EXPIRED, GENERATION_*), never
   * deleted from under it.
   */
  async requestDeletion(objectIds: ReadonlyArray<StoredObjectId>, reason: string, _at: UtcInstant): Promise<number> {
    if (objectIds.length === 0) return 0;
    const ids = [...objectIds];
    // the admission that retains a generation is found through the file's own reference to its accepted object as well as through
    // the object's file link: UPLOAD_INSPECTION registers the accepted intent before the copy, when the file does not exist yet
    // (stored_objects.file_id is set once, with a deferred key to the file), so its object carries no file link (D-CTRL-3)
    const retained = await execute<{ object_id: string }>(
      this.db,
      `SELECT o.object_id FROM kauro.stored_objects o
         JOIN kauro.source_files f ON f.agency_id = o.agency_id AND (f.file_id = o.file_id OR f.accepted_object_id = o.object_id)
        WHERE o.object_id = ANY($1::uuid[]) AND o.zone = 'ACCEPTED' AND f.state = 'ADMITTED'`,
      [ids],
    );
    if (retained.rows.length > 0) {
      throw new DomainFailure("PRECONDITION_FAILED", `accepted generation ${retained.rows[0]?.object_id ?? "?"} is retained by a standing admission; revoke it before deletion`, { reason: "UNLISTED_TRANSITION" });
    }
    const r = await execute(
      this.db,
      `UPDATE kauro.stored_objects SET state = 'DELETION_REQUESTED', deletion_requested_at = kauro.server_now(), deletion_reason = $2
        WHERE object_id = ANY($1::uuid[]) AND state IN ('INTENDED', 'PRESENT', 'VERIFIED')`,
      [ids, reason],
    );
    return r.rowCount ?? 0;
  }

  async recordDeletion(objectId: StoredObjectId, result: DeletionResult): Promise<StoredObjectRecord> {
    const deleted = result === "DELETED" || result === "ALREADY_ABSENT";
    const r = await execute<Row>(
      this.db,
      deleted
        ? `UPDATE kauro.stored_objects o SET state = 'DELETED', deleted_at = kauro.server_now(), deletion_result = $2, deletion_attempts = o.deletion_attempts + 1,
                  provider_residual_basis = 'LOCATION_POLICY', provider_residual_until = ${LOCATION_RESIDUAL}
            WHERE o.object_id = $1 AND o.state = 'DELETION_REQUESTED' RETURNING ${OBJECT_COLUMNS}`
        : `UPDATE kauro.stored_objects o SET state = 'DELETION_FAILED', deletion_result = $2, deletion_attempts = o.deletion_attempts + 1
            WHERE o.object_id = $1 AND o.state = 'DELETION_REQUESTED' RETURNING ${OBJECT_COLUMNS}`,
      [objectId, result],
    );
    return r.rows[0] ? objectRecord(r.rows[0]) : this.#refused(objectId, "a deletion result");
  }

  /**
   * A generation provider inventory found already soft-deleted: registered INTENDED, requested and DELETED (ALREADY_ABSENT) in this
   * unit of work at the server's instant, with the expiry the provider reported (PROVIDER_REPORTED). No delete call was made, so no
   * deletion attempt is counted. The location must have been read back (KA072 otherwise).
   */
  async recordProviderResidual(object: NewStoredObject & { readonly generation: string; readonly softDeletedAt: UtcInstant; readonly providerExpiresAt: UtcInstant }): Promise<StoredObjectRecord> {
    const late = object.observed?.late ?? false;
    await execute(
      this.db,
      `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, file_id, zone, data_class, provider, location_ref, object_name, generation, late, created_by_kind, created_by_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, kauro.server_now(), kauro.server_now())`,
      [
        object.objectId,
        object.agencyId,
        object.projectId,
        object.revisionId ?? null,
        object.uploadId ?? null,
        object.fileId ?? null,
        object.zone,
        late ? "RESIDUAL" : object.dataClass,
        object.provider,
        object.locationRef,
        object.objectName,
        object.generation,
        late,
        object.createdBy.kind,
        object.createdBy.kind === "MEMBERSHIP" ? object.createdBy.membershipId : object.createdBy.serviceId,
      ],
    );
    await execute(
      this.db,
      "UPDATE kauro.stored_objects SET state = 'DELETION_REQUESTED', deletion_requested_at = kauro.server_now(), deletion_reason = $2 WHERE object_id = $1 AND state = 'INTENDED'",
      [object.objectId, PROVIDER_SOFT_DELETED_REASON],
    );
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.stored_objects SET state = 'DELETED', deleted_at = kauro.server_now(), deletion_result = 'ALREADY_ABSENT',
              provider_residual_basis = 'PROVIDER_REPORTED', provider_residual_until = $2::timestamptz
        WHERE object_id = $1 AND state = 'DELETION_REQUESTED' RETURNING ${OBJECT_COLUMNS}`,
      [object.objectId, object.providerExpiresAt],
    );
    return objectRecord(one(r.rows, "provider residual record"));
  }

  /** DELETION_FAILED -> DELETION_REQUESTED: the pending deletion is attempted again (the first request's instant and reason stay). */
  async retryDeletion(objectId: StoredObjectId, _at: UtcInstant): Promise<StoredObjectRecord> {
    const r = await execute<Row>(this.db, `UPDATE kauro.stored_objects SET state = 'DELETION_REQUESTED' WHERE object_id = $1 AND state = 'DELETION_FAILED' RETURNING ${OBJECT_COLUMNS}`, [objectId]);
    return r.rows[0] ? objectRecord(r.rows[0]) : this.#refused(objectId, "a deletion retry");
  }

  /** Appended at the server's transaction time and returned exactly as stored (the latest read-back governs later deletions). */
  async recordLocationPolicy(observation: Omit<StorageLocationPolicyRecord, "observedAt">): Promise<StorageLocationPolicyRecord> {
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.storage_location_policies (observation_id, provider, location_ref, soft_delete_retention_seconds, object_versioning, evidence_hash, evidence_class, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, kauro.server_now()) RETURNING ${POLICY_COLUMNS}`,
      [observation.observationId, observation.provider, observation.locationRef, observation.softDeleteRetentionSeconds, observation.objectVersioning, observation.evidenceHash, observation.evidenceClass],
    );
    return policyRecord(one(r.rows, "location read-back insert"));
  }

  async locationPolicyAt(provider: string, locationRef: string, at: UtcInstant): Promise<StorageLocationPolicyRecord | null> {
    const r = await execute<Row>(
      this.db,
      `SELECT ${POLICY_COLUMNS} FROM kauro.storage_location_policies WHERE provider = $1 AND location_ref = $2 AND observed_at <= $3::timestamptz ORDER BY observed_at DESC LIMIT 1`,
      [provider, locationRef, at],
    );
    return r.rows[0] ? policyRecord(r.rows[0]) : null;
  }

  async inventory(scope: { readonly projectId: ProjectId; readonly revisionId?: RevisionId; readonly uploadId?: UploadId }): Promise<ReadonlyArray<StoredObjectRecord>> {
    const r = await execute<Row>(
      this.db,
      `SELECT ${OBJECT_COLUMNS} FROM kauro.stored_objects
        WHERE project_id = $1 AND ($2::uuid IS NULL OR revision_id = $2::uuid) AND ($3::uuid IS NULL OR upload_id = $3::uuid)
        ORDER BY created_at, object_id`,
      [scope.projectId, scope.revisionId ?? null, scope.uploadId ?? null],
    );
    return r.rows.map(objectRecord);
  }

  async findByName(provider: string, locationRef: string, objectName: string): Promise<ReadonlyArray<StoredObjectRecord>> {
    const r = await execute<Row>(
      this.db,
      `SELECT ${OBJECT_COLUMNS} FROM kauro.stored_objects WHERE provider = $1 AND location_ref = $2 AND object_name = $3 ORDER BY created_at, object_id`,
      [provider, locationRef, objectName],
    );
    return r.rows.map(objectRecord);
  }

  async pendingDeletion(limit: number): Promise<ReadonlyArray<{ readonly objectId: StoredObjectId; readonly agencyId: AgencyId }>> {
    const r = await execute<{ object_id: string; agency_id: string }>(
      this.db,
      "SELECT object_id, agency_id FROM kauro.stored_objects WHERE state IN ('DELETION_REQUESTED', 'DELETION_FAILED') ORDER BY deletion_requested_at, object_id LIMIT $1",
      [pageLimit(limit, 1000)],
    );
    return r.rows.map((x) => ({ objectId: x.object_id as StoredObjectId, agencyId: x.agency_id as AgencyId }));
  }

  async #refused(objectId: StoredObjectId, what: string): Promise<never> {
    const current = await execute<{ state: string }>(this.db, "SELECT state FROM kauro.stored_objects WHERE object_id = $1", [objectId]);
    const state = current.rows[0]?.state;
    if (state === undefined) throw new DomainFailure("NOT_FOUND", "stored object is not visible in this context");
    throw notAvailable(`${what} of stored object ${objectId}`, state);
  }
}
