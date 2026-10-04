/**
 * Upload sessions, their quota ledgers and the sealed provider-session secret over `pg` (B07; migration 0009; decisions D-UP-1..3,
 * D-SESSION-1, D-RUN-2, D-ROLE-3, D-PAIR-1, D-CLOCK-1).
 *
 * The database decides: a reservation beyond the byte/file envelope or the agency's session limit is refused by the ledger CHECK
 * under the ledger's row lock (R2-052; typed by sqlstate.ts as REVISION_QUOTA_EXCEEDED, REVISION_FILE_LIMIT, FILE_TOO_LARGE or
 * UPLOAD_CONCURRENCY_LIMITED), a request handler reserves only as the acting person through their own live operator membership
 * (upload_sessions_tenant_requester), a tombstone requests the provider cancellation by itself (upload_sessions_cancellation_requested
 * stamps REQUESTED — the adapter writes no provider-cancellation column for cancel_upload, D-ROLE-3), and every instant is
 * kauro.server_now() (KA072 otherwise). The adapter adds the compare-and-swap on the version and the fences the port names.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  AGENCY_UPLOAD_SESSIONS,
  DomainFailure,
  type AgencyId,
  type MembershipId,
  type NewUploadSession,
  type ProjectId,
  type ProviderCancellationState,
  type RevisionId,
  type RevisionQuota,
  type SealedSessionSecret,
  type SessionSecretRepository,
  type SourceFileId,
  type SourcePage,
  type StoredObjectId,
  type UploadCapacity,
  type UploadId,
  type UploadSessionRecord,
  type UploadSessionRepository,
  type UploadState,
  type UploadTransition,
  type UserId,
  type VersionedWrite,
  type CompletionClaim,
} from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
import { bytes, exact, instantText, missedWrite, notAvailable, one, opt, optionalInstantText, optionalInt, optionalString, pageLimit, str, type SourceAudience } from "./rows.js";

const UPLOAD_COLUMNS_CONTROL = [
  "upload_id",
  "agency_id",
  "project_id",
  "revision_id",
  "version::text AS version",
  "state",
  "declared_format",
  "reserved_bytes::text AS reserved_bytes",
  "quarantine_object_id",
  "requested_by_membership_id",
  "requested_by_user_id",
  exact("application_expires_at"),
  "session_attempt",
  exact("session_issued_at"),
  "provider_session_digest",
  exact("provider_session_expires_at"),
  "provider_cancellation_state",
  exact("provider_cancellation_at"),
  exact("completion_reported_at"),
  "completion_claim_digest",
  "claimed_generation",
  "claimed_bytes::text AS claimed_bytes",
  "claimed_crc32c",
  "claimed_md5",
  exact("completion_observed_at"),
  "observed_generation",
  "observed_bytes::text AS observed_bytes",
  exact("completion_not_observed_at"),
  "inspection_fence",
  exact("inspection_claimed_at"),
  "inspection_receipt_hash",
  "file_id",
  "terminal_reason",
  "cancelled_by_membership_id",
  exact("admitted_at"),
  exact("rejected_at"),
  exact("cancelled_at"),
  exact("expired_at"),
  exact("created_at"),
  exact("updated_at"),
].join(", ");

/** The request handlers also read the untrusted display filename (tenant reads only; never an event, a log or a path). */
const UPLOAD_COLUMNS_REQUEST = `${UPLOAD_COLUMNS_CONTROL}, display_name`;

export function uploadColumns(audience: SourceAudience): string {
  return audience === "CONTROL" ? UPLOAD_COLUMNS_CONTROL : UPLOAD_COLUMNS_REQUEST;
}

type Row = Record<string, unknown>;

function claimOf(r: Row): CompletionClaim | undefined {
  if (r["completion_claim_digest"] === null || r["completion_claim_digest"] === undefined) return undefined;
  return {
    ...opt("generation", optionalString(r["claimed_generation"])),
    ...opt("bytes", optionalInt(r["claimed_bytes"])),
    ...opt("crc32c", optionalString(r["claimed_crc32c"])),
    ...opt("md5", optionalString(r["claimed_md5"])),
  };
}

export function uploadRecord(r: Row): UploadSessionRecord {
  return {
    uploadId: str<UploadId>(r["upload_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    projectId: str<ProjectId>(r["project_id"]),
    revisionId: str<RevisionId>(r["revision_id"]),
    version: int(r["version"]),
    state: str<UploadState>(r["state"]),
    ...opt("displayName", optionalString(r["display_name"])),
    declaredFormat: str<UploadSessionRecord["declaredFormat"]>(r["declared_format"]),
    reservedBytes: int(r["reserved_bytes"]),
    quarantineObjectId: str<StoredObjectId>(r["quarantine_object_id"]),
    requestedByMembershipId: str<MembershipId>(r["requested_by_membership_id"]),
    requestedByUserId: str<UserId>(r["requested_by_user_id"]),
    applicationExpiresAt: instantText(r["application_expires_at"]),
    sessionAttempt: int(r["session_attempt"]),
    ...opt("sessionIssuedAt", optionalInstantText(r["session_issued_at"])),
    ...opt("providerSessionDigest", optionalString<Sha256Hex>(r["provider_session_digest"])),
    ...opt("providerSessionExpiresAt", optionalInstantText(r["provider_session_expires_at"])),
    providerCancellationState: str<ProviderCancellationState>(r["provider_cancellation_state"]),
    ...opt("providerCancellationAt", optionalInstantText(r["provider_cancellation_at"])),
    ...opt("completionReportedAt", optionalInstantText(r["completion_reported_at"])),
    ...opt("completionClaimDigest", optionalString<Sha256Hex>(r["completion_claim_digest"])),
    ...opt("claim", claimOf(r)),
    ...opt("completionObservedAt", optionalInstantText(r["completion_observed_at"])),
    ...opt("observedGeneration", optionalString(r["observed_generation"])),
    ...opt("observedBytes", optionalInt(r["observed_bytes"])),
    ...opt("completionNotObservedAt", optionalInstantText(r["completion_not_observed_at"])),
    inspectionFence: int(r["inspection_fence"]),
    ...opt("inspectionClaimedAt", optionalInstantText(r["inspection_claimed_at"])),
    ...opt("inspectionReceiptHash", optionalString<Sha256Hex>(r["inspection_receipt_hash"])),
    ...opt("fileId", optionalString<SourceFileId>(r["file_id"])),
    ...opt("terminalReason", optionalString(r["terminal_reason"])),
    ...opt("cancelledByMembershipId", optionalString<MembershipId>(r["cancelled_by_membership_id"])),
    ...opt("admittedAt", optionalInstantText(r["admitted_at"])),
    ...opt("rejectedAt", optionalInstantText(r["rejected_at"])),
    ...opt("cancelledAt", optionalInstantText(r["cancelled_at"])),
    ...opt("expiredAt", optionalInstantText(r["expired_at"])),
    createdAt: instantText(r["created_at"]),
    updatedAt: instantText(r["updated_at"]),
  };
}

/** The SET clause and parameters of one listed UploadSession edge (params start at $3; $1 upload, $2 expected version). */
function edgeOf(change: UploadTransition): { readonly set: string; readonly params: ReadonlyArray<unknown>; readonly where: string; readonly fence?: { readonly column: string; readonly value: number } } {
  switch (change.event) {
    case "session_issued":
      // only the attempt that holds the issuance fence issues the session (D-RUN-2); the horizon is computed from the server clock
      return {
        set: "state = 'UPLOADING', session_issued_at = kauro.server_now(), provider_session_digest = $3, provider_session_expires_at = kauro.server_now() + make_interval(secs => $4::bigint)",
        params: [change.providerSessionDigest, change.providerSessionLifetimeSeconds, change.sessionAttempt],
        where: "AND session_attempt = $5",
        fence: { column: "session_attempt", value: change.sessionAttempt },
      };
    case "completion_reported":
      return {
        set: "state = 'VERIFYING', completion_reported_at = kauro.server_now(), completion_claim_digest = $3, claimed_generation = $4, claimed_bytes = $5, claimed_crc32c = $6, claimed_md5 = $7",
        params: [change.claimDigest, change.claim.generation ?? null, change.claim.bytes ?? null, change.claim.crc32c ?? null, change.claim.md5 ?? null],
        where: "",
      };
    case "completion_not_observed":
      // the control plane's negative observation reopens the session; the claim the provider did not honour is cleared with it
      return {
        set: "state = 'UPLOADING', completion_not_observed_at = kauro.server_now(), completion_reported_at = NULL, completion_claim_digest = NULL, claimed_generation = NULL, claimed_bytes = NULL, claimed_crc32c = NULL, claimed_md5 = NULL",
        params: [],
        where: "",
      };
    case "inspection_admitted":
      return {
        set: "state = 'ADMITTED', admitted_at = kauro.server_now(), file_id = $3, inspection_receipt_hash = $4",
        params: [change.fileId, change.receiptHash, change.inspectionFence],
        where: "AND inspection_fence = $5",
        fence: { column: "inspection_fence", value: change.inspectionFence },
      };
    case "inspection_rejected":
      return {
        set: "state = 'REJECTED', rejected_at = kauro.server_now(), terminal_reason = $3, inspection_receipt_hash = $4",
        params: [change.rejectionClass, change.receiptHash, change.inspectionFence],
        where: "AND inspection_fence = $5",
        fence: { column: "inspection_fence", value: change.inspectionFence },
      };
    case "cancel_upload":
      // no provider-cancellation column: the database requests the provider cancellation in this update when a session was
      // issued (upload_sessions_cancellation_requested), and only the control plane records the answer (D-ROLE-3)
      return {
        set: "state = 'CANCELLED', cancelled_at = kauro.server_now(), cancelled_by_membership_id = $3, terminal_reason = $4",
        params: [change.byMembershipId, change.reason],
        where: "",
      };
    case "reservation_expired":
      return {
        set:
          change.providerCancellation === "REQUESTED"
            ? "state = 'EXPIRED', expired_at = kauro.server_now(), terminal_reason = $3, provider_cancellation_state = 'REQUESTED', provider_cancellation_at = kauro.server_now()"
            : "state = 'EXPIRED', expired_at = kauro.server_now(), terminal_reason = $3",
        params: [change.reason],
        where: "",
      };
    case "intake_deadline_reached":
      return { set: "state = 'EXPIRED', expired_at = kauro.server_now(), terminal_reason = $3", params: [change.reason], where: "" };
  }
}

export class PgUploadSessionRepository implements UploadSessionRepository {
  readonly #columns: string;

  constructor(
    private readonly db: Queryable,
    audience: SourceAudience,
  ) {
    this.#columns = uploadColumns(audience);
  }

  async get(uploadId: UploadId): Promise<UploadSessionRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${this.#columns} FROM kauro.upload_sessions WHERE upload_id = $1`, [uploadId]);
    return r.rows[0] ? uploadRecord(r.rows[0]) : null;
  }

  async lock(uploadId: UploadId): Promise<UploadSessionRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${this.#columns} FROM kauro.upload_sessions WHERE upload_id = $1 FOR UPDATE`, [uploadId]);
    return r.rows[0] ? uploadRecord(r.rows[0]) : null;
  }

  /**
   * RESERVED at version 1 holding the first issuance fence (D-RUN-2), created at the server's transaction time with the deadline
   * exactly 86,400 s after it (D-CLOCK-1). The quarantine intent must be registered first (its key is checked immediately); the
   * UPLOAD_INITIATED anchor follows in the same unit of work (checked at commit). The revision row is locked by the insert's own
   * trigger, and the ledgers decide the envelope on their committed totals (R2-052).
   */
  async insert(upload: NewUploadSession): Promise<UploadSessionRecord> {
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.upload_sessions (upload_id, agency_id, project_id, revision_id, version, state, display_name, declared_format, reserved_bytes, quarantine_object_id,
          requested_by_membership_id, requested_by_user_id, application_expires_at, session_attempt, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, 'RESERVED', $5, $6, $7, $8, $9, $10, kauro.server_now() + interval '86400 seconds', 1, kauro.server_now(), kauro.server_now())
       RETURNING ${this.#columns}`,
      [upload.uploadId, upload.agencyId, upload.projectId, upload.revisionId, upload.displayName, upload.declaredFormat, upload.reservedBytes, upload.quarantineObjectId, upload.requestedByMembershipId, upload.requestedByUserId],
    );
    return uploadRecord(one(r.rows, "upload insert"));
  }

  async transition(uploadId: UploadId, expectedVersion: number, change: UploadTransition): Promise<VersionedWrite<UploadSessionRecord>> {
    const edge = edgeOf(change);
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.upload_sessions SET ${edge.set}, version = $2 + 1 WHERE upload_id = $1 AND version = $2 ${edge.where} RETURNING ${this.#columns}`,
      [uploadId, expectedVersion, ...edge.params],
    );
    const row = r.rows[0];
    if (row) return { kind: "APPLIED", record: uploadRecord(row) };
    const fence = edge.fence;
    return missedWrite(
      this.db,
      "upload_sessions",
      "upload_id",
      uploadId,
      expectedVersion,
      "upload",
      ({ state, row: current }) =>
        new DomainFailure("PRECONDITION_FAILED", `upload ${change.event}: attempt ${fence?.value ?? "?"} does not hold the fence (current ${String(fence ? current[fence.column] : "?")}, ${state})`, { reason: "FENCE_DISCIPLINE", currentState: state }),
      fence ? [fence.column] : [],
    );
  }

  async claimSessionAttempt(uploadId: UploadId): Promise<number | null> {
    const r = await execute<{ session_attempt: number }>(
      this.db,
      "UPDATE kauro.upload_sessions SET session_attempt = session_attempt + 1 WHERE upload_id = $1 AND state = 'RESERVED' AND application_expires_at > kauro.server_now() RETURNING session_attempt",
      [uploadId],
    );
    const row = r.rows[0];
    return row ? int(row.session_attempt) : null;
  }

  /**
   * The fence advance of a VERIFYING upload; the database stamps the claim instant with it (upload_sessions_attempt_claimed,
   * D-INSP-4), and it is returned exactly as stored: the receipt of the attempt must start at precisely this instant.
   */
  async claimInspectionAttempt(uploadId: UploadId): Promise<{ readonly inspectionFence: number; readonly claimedAt: UtcInstant } | null> {
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.upload_sessions SET inspection_fence = inspection_fence + 1 WHERE upload_id = $1 AND state = 'VERIFYING' RETURNING inspection_fence, ${exact("inspection_claimed_at")}`,
      [uploadId],
    );
    const row = r.rows[0];
    return row ? { inspectionFence: int(row["inspection_fence"]), claimedAt: instantText(row["inspection_claimed_at"]) } : null;
  }

  async recordObservation(uploadId: UploadId, expectedVersion: number, observation: { readonly generation: string; readonly bytes: number }): Promise<VersionedWrite<UploadSessionRecord>> {
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.upload_sessions SET version = $2 + 1, completion_observed_at = kauro.server_now(), observed_generation = $3, observed_bytes = $4
        WHERE upload_id = $1 AND version = $2 AND state = 'VERIFYING' RETURNING ${this.#columns}`,
      [uploadId, expectedVersion, observation.generation, observation.bytes],
    );
    const row = r.rows[0];
    if (row) return { kind: "APPLIED", record: uploadRecord(row) };
    return missedWrite(this.db, "upload_sessions", "upload_id", uploadId, expectedVersion, "upload", ({ state }) => notAvailable("an observation of the upload", state));
  }

  async recordProviderCancellation(uploadId: UploadId, expectedVersion: number, result: Exclude<ProviderCancellationState, "NOT_REQUESTED" | "REQUESTED">): Promise<VersionedWrite<UploadSessionRecord>> {
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.upload_sessions SET version = $2 + 1, provider_cancellation_state = $3, provider_cancellation_at = kauro.server_now()
        WHERE upload_id = $1 AND version = $2 RETURNING ${this.#columns}`,
      [uploadId, expectedVersion, result],
    );
    const row = r.rows[0];
    if (row) return { kind: "APPLIED", record: uploadRecord(row) };
    return missedWrite(this.db, "upload_sessions", "upload_id", uploadId, expectedVersion, "upload", ({ state }) => notAvailable("the upload", state));
  }

  /** Keyset page in (createdAt, uploadId) order; the cursor carries the exact createdAt a previous page returned. */
  async listByRevision(revisionId: RevisionId, page: SourcePage<{ readonly createdAt: UtcInstant; readonly uploadId: UploadId }>): Promise<ReadonlyArray<UploadSessionRecord>> {
    const limit = pageLimit(page.limit);
    const params: unknown[] = [revisionId, limit];
    let where = "revision_id = $1";
    if (page.after) {
      params.push(page.after.createdAt, page.after.uploadId);
      where += " AND (created_at, upload_id) > ($3::timestamptz, $4::uuid)";
    }
    const r = await execute<Row>(this.db, `SELECT ${this.#columns} FROM kauro.upload_sessions WHERE ${where} ORDER BY created_at, upload_id LIMIT $2`, params);
    return r.rows.map(uploadRecord);
  }

  async inStates(revisionId: RevisionId, states: ReadonlyArray<UploadState>): Promise<ReadonlyArray<UploadSessionRecord>> {
    const r = await execute<Row>(
      this.db,
      `SELECT ${this.#columns} FROM kauro.upload_sessions WHERE revision_id = $1 AND state = ANY($2::text[]) ORDER BY created_at, upload_id`,
      [revisionId, [...states]],
    );
    return r.rows.map(uploadRecord);
  }

  /** The ledger as committed (or as this unit of work changed it); a revision without reservations holds nothing. */
  async quota(revisionId: RevisionId): Promise<RevisionQuota> {
    const r = await execute<{ reserved_bytes: string; file_count: number }>(this.db, "SELECT reserved_bytes::text AS reserved_bytes, file_count FROM kauro.revision_quota WHERE revision_id = $1", [revisionId]);
    const row = r.rows[0];
    return { revisionId, reservedBytes: row ? int(row.reserved_bytes) : 0, fileCount: row ? int(row.file_count) : 0 };
  }

  /** The agency's capacity ledger; an agency that never reserved holds no session under the policy's default limit. */
  async capacity(agencyId: AgencyId): Promise<UploadCapacity> {
    const r = await execute<{ active_sessions: number; session_limit: number }>(this.db, "SELECT active_sessions, session_limit FROM kauro.upload_capacity WHERE agency_id = $1", [agencyId]);
    const row = r.rows[0];
    return { agencyId, activeSessions: row ? int(row.active_sessions) : 0, sessionLimit: row ? int(row.session_limit) : AGENCY_UPLOAD_SESSIONS };
  }

  /**
   * Live uploads past their deadline, and admitted ones past it whose file no real seal included (D-RET-1; a sealed file follows
   * its seal's retention, D-SEAL-1), on the server clock. Discovery reads no customer text.
   */
  async findDeadlinePassed(limit: number): Promise<ReadonlyArray<{ readonly uploadId: UploadId; readonly agencyId: AgencyId; readonly revisionId: RevisionId; readonly state: UploadState }>> {
    const r = await execute<{ upload_id: string; agency_id: string; revision_id: string; state: UploadState }>(
      this.db,
      `SELECT u.upload_id, u.agency_id, u.revision_id, u.state FROM kauro.upload_sessions u
        WHERE u.application_expires_at <= kauro.server_now()
          AND (u.state IN ('RESERVED', 'UPLOADING', 'VERIFYING')
               OR (u.state = 'ADMITTED' AND NOT EXISTS (
                     SELECT 1 FROM kauro.sealed_revision_files s
                      WHERE s.agency_id = u.agency_id AND s.file_id = u.file_id AND s.disposition = 'INCLUDED' AND kauro.is_real_seal(s.agency_id, s.revision_id))))
        ORDER BY u.application_expires_at, u.upload_id LIMIT $1`,
      [pageLimit(limit, 1000)],
    );
    return r.rows.map((x) => ({ uploadId: x.upload_id as UploadId, agencyId: x.agency_id as AgencyId, revisionId: x.revision_id as RevisionId, state: x.state }));
  }

  /** Provider cancellations still pending (REQUESTED or UNCERTAIN, SESSION_REVOCATION_PENDING) whose provider horizon is ahead. */
  async findProviderReconciliation(limit: number): Promise<ReadonlyArray<{ readonly uploadId: UploadId; readonly agencyId: AgencyId; readonly revisionId: RevisionId }>> {
    const r = await execute<{ upload_id: string; agency_id: string; revision_id: string }>(
      this.db,
      `SELECT upload_id, agency_id, revision_id FROM kauro.upload_sessions
        WHERE provider_cancellation_state IN ('REQUESTED', 'UNCERTAIN') AND provider_session_expires_at > kauro.server_now()
        ORDER BY provider_cancellation_at, upload_id LIMIT $1`,
      [pageLimit(limit, 1000)],
    );
    return r.rows.map((x) => ({ uploadId: x.upload_id as UploadId, agencyId: x.agency_id as AgencyId, revisionId: x.revision_id as RevisionId }));
  }

  /**
   * B07-R4, unbound: the agencies with a pending provider cancellation (REQUESTED or UNCERTAIN) past its horizon on the server clock
   * (the partial index upload_sessions_provider_reconciliation). Whether a bearer record is still held is not visible unbound
   * (upload_session_secrets is readable by the control plane only in the agency it is bound to), so it is asked per agency; pages
   * in agency-id order after `after`.
   */
  async findAgenciesWithLapsedCancellations(limit: number, after?: AgencyId): Promise<ReadonlyArray<AgencyId>> {
    const r = await execute<{ agency_id: string }>(
      this.db,
      `SELECT DISTINCT agency_id FROM kauro.upload_sessions
        WHERE provider_cancellation_state IN ('REQUESTED', 'UNCERTAIN') AND provider_session_expires_at <= kauro.server_now()
          AND ($2::uuid IS NULL OR agency_id > $2::uuid)
        ORDER BY agency_id LIMIT $1`,
      [pageLimit(limit, 1000), after ?? null],
    );
    return r.rows.map((x) => x.agency_id as AgencyId);
  }

  /**
   * B07-R4, bound to one agency: its pending provider cancellations past the horizon whose sealed bearer record is still stored (the
   * secret row's policy shows the bound agency's rows only). Ids only; no ciphertext is read.
   */
  async findLapsedSessionSecrets(limit: number): Promise<ReadonlyArray<{ readonly uploadId: UploadId; readonly agencyId: AgencyId; readonly revisionId: RevisionId }>> {
    const r = await execute<{ upload_id: string; agency_id: string; revision_id: string }>(
      this.db,
      `SELECT u.upload_id, u.agency_id, u.revision_id FROM kauro.upload_sessions u
        WHERE u.agency_id = kauro.current_agency_id()
          AND u.provider_cancellation_state IN ('REQUESTED', 'UNCERTAIN') AND u.provider_session_expires_at <= kauro.server_now()
          AND EXISTS (SELECT 1 FROM kauro.upload_session_secrets s WHERE s.agency_id = u.agency_id AND s.upload_id = u.upload_id)
        ORDER BY u.provider_session_expires_at, u.upload_id LIMIT $1`,
      [pageLimit(limit, 1000)],
    );
    return r.rows.map((x) => ({ uploadId: x.upload_id as UploadId, agencyId: x.agency_id as AgencyId, revisionId: x.revision_id as RevisionId }));
  }
}

// --- the sealed provider session reference (D-SESSION-1) -------------------------------------------------------------------------

const SECRET_COLUMNS = `upload_id, agency_id, requested_by_user_id, session_attempt, key_ref, nonce, ciphertext, ${exact("created_at")}`;

function secretRecord(r: Row): SealedSessionSecret {
  return {
    uploadId: str<UploadId>(r["upload_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    requestedByUserId: str<UserId>(r["requested_by_user_id"]),
    sessionAttempt: int(r["session_attempt"]),
    keyRef: str(r["key_ref"]),
    nonce: bytes(r["nonce"]),
    ciphertext: bytes(r["ciphertext"]),
    createdAt: instantText(r["created_at"]),
  };
}

export class PgSessionSecretRepository implements SessionSecretRepository {
  constructor(private readonly db: Queryable) {}

  /** Stored by the requester at the server's transaction time (the secret's createdAt is the database's, D-CLOCK-1). */
  async store(secret: SealedSessionSecret): Promise<void> {
    await execute(
      this.db,
      `INSERT INTO kauro.upload_session_secrets (upload_id, agency_id, requested_by_user_id, session_attempt, key_ref, nonce, ciphertext, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, kauro.server_now())`,
      [secret.uploadId, secret.agencyId, secret.requestedByUserId, secret.sessionAttempt, secret.keyRef, Buffer.from(secret.nonce), Buffer.from(secret.ciphertext)],
    );
  }

  /** The row policy decides: the requester's own secret while UPLOADING and unexpired on the server clock, nothing otherwise. */
  async readOwn(uploadId: UploadId): Promise<SealedSessionSecret | null> {
    const r = await execute<Row>(this.db, `SELECT ${SECRET_COLUMNS} FROM kauro.upload_session_secrets WHERE upload_id = $1`, [uploadId]);
    return r.rows[0] ? secretRecord(r.rows[0]) : null;
  }

  async readForRevocation(uploadId: UploadId): Promise<SealedSessionSecret | null> {
    const r = await execute<Row>(this.db, `SELECT ${SECRET_COLUMNS} FROM kauro.upload_session_secrets WHERE upload_id = $1`, [uploadId]);
    return r.rows[0] ? secretRecord(r.rows[0]) : null;
  }

  async purge(uploadId: UploadId): Promise<boolean> {
    const r = await execute(this.db, "DELETE FROM kauro.upload_session_secrets WHERE upload_id = $1", [uploadId]);
    return (r.rowCount ?? 0) === 1;
  }
}
