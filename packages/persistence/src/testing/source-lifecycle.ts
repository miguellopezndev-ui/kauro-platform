/**
 * A source revision as the B07 source lifecycle leaves it (docs/design/B07-upload-source-lifecycle.md §8), for the tests of
 * every package that needs one (the plan, approval and read cases of B06 and later packages; B07's own migration tests and the
 * command tests of its implementation).
 *
 * B06's fixtures walked a revision DRAFT → INSPECTING → READY_TO_SEAL → SEALED with bare state updates, because no lifecycle
 * existed yet (their own comment: "as B07's lifecycle leaves it"). Since B07 the database refuses a sealed subject without its
 * facts — a selection, a complete evaluation, a sealed manifest whose file set is the selection's, admitted files counted at
 * their exact generations and a retention record anchored on the seal — so the fixture takes the same path the product takes,
 * each write under the runtime role that owns it (21 "Positive and negative symmetry": the fixture itself proves the policies
 * admit the legitimate lifecycle):
 *
 *   request handlers (kauro_app, the agency's owner)  CMD013 reservation and session issue, CMD014 completion report,
 *                                                     the selection manifest intake and CMD016, CMD017 SealRevision
 *   control plane (kauro_control, bound to the agency) UPLOAD_INSPECTION observation, inspection, promotion and admission,
 *                                                     SELECTION_EVALUATION counting, and the retention sweeper's expiry
 *
 * The steps compose: `admitSourceFile` (a revision with one admitted CSV file, INSPECTING), `readySourceRevision` (its selection
 * bound by `bindSourceSelection` and counted by `countSourceSelection`, READY_TO_SEAL), `sealReadyRevision` (SEALED; `sealStatements` issues the same writes inside a transaction
 * the caller holds, for race tests), `expireSealedRevision` (the retention sweeper's retention_expires), and
 * `sealSourceRevision` runs them in order.
 *
 * The provider facts (generations, the scanner's report) are those of the labelled contract fakes (`contract-fake-storage`,
 * `contract-fake-scanner`, evidence class SIMULATED): a fixture never claims a provider effect (21 "Evidence classes").
 *
 * Shortcut, stated: the first revision a project seals is its current DRAFT revision, as in the product; a later revision of the
 * same project is inserted beside it without lineage (only CreateRevision creates lineage), so tests that need several
 * independently sealed sources of one project keep working. The database admits that shape — it guarantees one mutable
 * revision per project and one successor per predecessor; the linearity of lineage is CMD012's (design D-REV-1).
 */
import { randomBytes } from "node:crypto";
import {
  createIdGenerator,
  inspectionReceiptHashOf,
  inventoryHashOf,
  parserProfileHashOf,
  payloadDigest,
  projectionHashOf,
  retentionAnchorHashOf,
  selectionHashOf,
  sourceRevisionManifestHashOf,
  tableStructureHashOf,
  textDigest,
  toUtcInstant,
  type EventPayload,
  type IdGenerator,
  type ProjectId,
  type RevisionId,
  type SealedManifestDocument,
  type SelectionManifestDocument,
  type SourceFileId,
  type SourceTableId,
} from "@kauro/domain";

const ids: IdGenerator = createIdGenerator({ now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() }, (n) => new Uint8Array(randomBytes(n)));

/** A connection inside an open transaction (a pg Client or PoolClient). */
export interface SqlSession {
  query<R extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: ReadonlyArray<unknown>): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
}

export interface SourceFixtureScope {
  readonly agencyId: string;
  readonly projectId: string;
  readonly ownerUserId: string;
  readonly ownerMembershipId: string;
}

export interface SourceFixtureSessions {
  /** One request-handler transaction (kauro_app) bound to the scope's agency and owner; commits when fn returns. */
  app<T>(fn: (c: SqlSession) => Promise<T>): Promise<T>;
  /** One control-plane transaction (kauro_control) bound to the scope's agency (design D-CTRL-1); commits when fn returns. */
  control<T>(fn: (c: SqlSession) => Promise<T>): Promise<T>;
}

/** A revision with one admitted file (INSPECTING), as the inspection pipeline leaves it. */
export interface AdmittedSourceFixture {
  readonly revisionId: string;
  readonly clientId: string;
  readonly revisionVersion: number;
  readonly uploadId: string;
  readonly quarantineObjectId: string;
  readonly acceptedObjectId: string;
  readonly fileId: string;
  readonly tableId: string;
  readonly bytes: number;
  readonly acceptedGeneration: string;
  readonly sha256: string;
  readonly receiptHash: string;
  readonly structureHash: string;
  readonly parserProfileHash: string;
  readonly initiatedAt: Date;
}

/** The same revision with its selection bound (still INSPECTING, uncounted). */
export interface BoundSourceFixture extends AdmittedSourceFixture {
  readonly selection: SelectionManifestDocument;
  readonly selectionManifestId: string;
  readonly selectionHash: string;
  readonly inventoryHash: string;
}

/** The four populations the fixture's selection counts (03 "Count the correct population"). */
export interface SourceCounts {
  readonly physicalSourceRows: number;
  readonly logicalSourceRecords: number;
  readonly billableSourceUnits: number;
  readonly associationEdges: number;
}

/** A complete evaluation of a bound selection, recorded by SELECTION_EVALUATION. */
export interface CountedSourceSelection {
  readonly evaluationId: string;
  readonly evaluationHash: string;
  readonly counts: SourceCounts;
}

/** The same revision with its selection bound and counted (READY_TO_SEAL). */
export interface ReadySourceFixture extends BoundSourceFixture, CountedSourceSelection {}

export interface SealedSourceFixture {
  readonly revisionId: string;
  readonly manifestHash: string;
  readonly projectionHash: string;
  /** The revision's version once the fixture is done (SEALED, or EXPIRED). */
  readonly version: number;
  readonly uploadId: string;
  readonly fileId: string;
  readonly retentionId: string;
  readonly sealedAt: Date;
}

export interface SealSourceOptions {
  readonly seed: string;
  readonly state?: "SEALED" | "EXPIRED";
  /**
   * When the intake began. Default: fifteen days ago, so the UNPAID hard cap (fourteen days from the seal) has passed and a test
   * may take retention_expires at any time (the database refuses an expiry before the governing deadline, design D-RET-2).
   */
  readonly base?: Date;
}

/** The fixture's service identity on control-plane events and objects (a SERVICE actor, never a person). */
export const FIXTURE_SERVICE = "source-lifecycle-fixture";
/** The labelled contract fakes the fixture's provider facts come from (21 "Evidence classes": SIMULATED). */
export const FIXTURE_STORAGE_PROVIDER = "contract-fake-storage";
export const FIXTURE_SCANNER = "contract-fake-scanner";

const DAY_MS = 86_400_000;
const FIFTEEN_DAYS_MS = 15 * DAY_MS;

function at(base: Date, offsetMs: number): Date {
  return new Date(base.getTime() + offsetMs);
}

function iso(d: Date): string {
  return d.toISOString();
}

export interface FixtureEvent {
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly agencyId: string;
  readonly eventType: string;
  /** A user for request-handler events; null for the control plane's SERVICE events. */
  readonly actorUserId: string | null;
  readonly payload: EventPayload;
}

/** Appends a domain event row as the EventPublisher adapter does (without outbox rows: no dispatcher runs in these tests). */
export async function appendFixtureEvent(c: SqlSession, e: FixtureEvent): Promise<void> {
  await c.query(
    `INSERT INTO kauro.domain_events (event_id, aggregate_kind, aggregate_id, aggregate_version, agency_id, event_type, actor_kind, actor_id, causation_id, correlation_id, payload, payload_hash, schema_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '1', now())`,
    [
      ids.next(),
      e.aggregateKind,
      e.aggregateId,
      e.aggregateVersion,
      e.agencyId,
      e.eventType,
      e.actorUserId === null ? "SERVICE" : "USER",
      e.actorUserId ?? FIXTURE_SERVICE,
      ids.next(),
      ids.next(),
      JSON.stringify(e.payload),
      payloadDigest(e.payload),
    ],
  );
}

async function one<R extends Record<string, unknown>>(c: SqlSession, text: string, params: ReadonlyArray<unknown>): Promise<R> {
  const r = await c.query<R>(text, params);
  const row = r.rows[0];
  if (row === undefined || r.rows.length !== 1) throw new Error(`source fixture: expected one row from ${text.slice(0, 80)}`);
  return row;
}

/** The revision the fixture fills: the project's pristine current DRAFT revision, else a new DRAFT beside it (see header). */
async function revisionToFill(sessions: SourceFixtureSessions, scope: SourceFixtureScope): Promise<{ revisionId: string; clientId: string }> {
  return sessions.app(async (c) => {
    const current = await one<{ revision_id: string; client_id: string; state: string; version: string; uploads: string; selection_hash: string | null }>(
      c,
      `SELECT r.revision_id, p.client_id, r.state, r.version::text, r.selection_hash,
              (SELECT count(*) FROM kauro.upload_sessions u WHERE u.agency_id = r.agency_id AND u.revision_id = r.revision_id)::text AS uploads
         FROM kauro.projects p JOIN kauro.dataset_revisions r ON r.agency_id = p.agency_id AND r.revision_id = p.current_revision_id
        WHERE p.agency_id = $1 AND p.project_id = $2`,
      [scope.agencyId, scope.projectId],
    );
    if (current.state === "DRAFT" && current.version === "1" && current.uploads === "0" && current.selection_hash === null) {
      return { revisionId: current.revision_id, clientId: current.client_id };
    }
    const mutable = await c.query("SELECT 1 FROM kauro.dataset_revisions WHERE agency_id = $1 AND project_id = $2 AND state IN ('DRAFT', 'UPLOADING', 'INSPECTING', 'READY_TO_SEAL')", [scope.agencyId, scope.projectId]);
    if ((mutable.rowCount ?? 0) > 0) throw new Error(`source fixture: project ${scope.projectId} has a mutable revision in progress; a fixture cannot add a parallel one`);
    const revisionId = ids.next();
    await c.query(
      "INSERT INTO kauro.dataset_revisions (revision_id, agency_id, project_id, created_by_membership_id, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())",
      [revisionId, scope.agencyId, scope.projectId, scope.ownerMembershipId],
    );
    await appendFixtureEvent(c, {
      aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: 1, agencyId: scope.agencyId, eventType: "dataset_revision.created.v1", actorUserId: scope.ownerUserId,
      payload: { revisionId, agencyId: scope.agencyId, projectId: scope.projectId, state: "DRAFT", createdByMembershipId: scope.ownerMembershipId },
    });
    return { revisionId, clientId: current.client_id };
  });
}

/**
 * CMD013 (reservation and session issue), CMD014 (the completion claim) and UPLOAD_INSPECTION (observation, inspection, scan,
 * promotion, admission): the revision holds one admitted CSV file and is INSPECTING.
 */
export async function admitSourceFile(sessions: SourceFixtureSessions, scope: SourceFixtureScope, options: { readonly seed: string; readonly base?: Date }): Promise<AdmittedSourceFixture> {
  const initiatedAt = options.base ?? new Date(Date.now() - FIFTEEN_DAYS_MS);
  const { revisionId, clientId } = await revisionToFill(sessions, scope);
  const uploadId = ids.next();
  const quarantineObjectId = ids.next();
  const acceptedObjectId = ids.next();
  const fileId = ids.next();
  const tableId = ids.next();
  const reservedBytes = 4_096;
  const bytes = 1_234;
  const quarantineGeneration = String(1_700_000_000_000_000 + Math.floor(Math.random() * 1_000_000));
  const acceptedGeneration = String(Number(quarantineGeneration) + 1);
  const sha256 = textDigest(`${options.seed}-bytes-${uploadId}`);
  const claimDigest = textDigest(`${options.seed}-completion-${uploadId}`);

  // CMD013 phase 1 and phase 2 (request handler): quarantine intent, RESERVED upload, its anchor, DRAFT -> UPLOADING, session issued
  await sessions.app(async (c) => {
    await c.query(
      `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, zone, data_class, provider, location_ref, object_name, created_by_kind, created_by_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'QUARANTINE', 'RAW', $6, 'QUARANTINE_PRIMARY', $7, 'MEMBERSHIP', $8, $9, now())`,
      [quarantineObjectId, scope.agencyId, scope.projectId, revisionId, uploadId, FIXTURE_STORAGE_PROVIDER, `quarantine/${scope.agencyId}/${scope.projectId}/${revisionId}/${uploadId}`, scope.ownerMembershipId, iso(initiatedAt)],
    );
    await c.query(
      `INSERT INTO kauro.upload_sessions (upload_id, agency_id, project_id, revision_id, display_name, declared_format, reserved_bytes, quarantine_object_id, requested_by_membership_id, requested_by_user_id, application_expires_at, session_attempt, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'fixture source.csv', 'CSV', $5, $6, $7, $8, $9, 1, $10, now())`,
      [uploadId, scope.agencyId, scope.projectId, revisionId, reservedBytes, quarantineObjectId, scope.ownerMembershipId, scope.ownerUserId, iso(at(initiatedAt, DAY_MS)), iso(initiatedAt)],
    );
    await appendFixtureEvent(c, {
      aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 1, agencyId: scope.agencyId, eventType: "upload_session.reserved.v1", actorUserId: scope.ownerUserId,
      payload: { uploadId, agencyId: scope.agencyId, projectId: scope.projectId, revisionId, reservedBytes, declaredFormat: "CSV", requestedByMembershipId: scope.ownerMembershipId, state: "RESERVED" },
    });
    await c.query(
      `INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, 'UPLOAD_INITIATED', $6, $7, now())`,
      [ids.next(), scope.agencyId, scope.projectId, revisionId, uploadId, iso(initiatedAt), retentionAnchorHashOf({ kind: "UPLOAD_INITIATED", agencyId: scope.agencyId, projectId: scope.projectId, revisionId, uploadId, occurredAt: iso(initiatedAt), sourceEvidenceHash: null })],
    );
    const moved = await one<{ version: string }>(c, "UPDATE kauro.dataset_revisions SET state = 'UPLOADING', version = version + 1 WHERE agency_id = $1 AND revision_id = $2 AND state = 'DRAFT' RETURNING version::text", [scope.agencyId, revisionId]);
    await appendFixtureEvent(c, {
      aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: Number(moved.version), agencyId: scope.agencyId, eventType: "dataset_revision.uploading.v1", actorUserId: scope.ownerUserId,
      payload: { revisionId, agencyId: scope.agencyId, projectId: scope.projectId, firstUploadId: uploadId, state: "UPLOADING" },
    });
  });
  await sessions.app(async (c) => {
    await c.query(
      `UPDATE kauro.upload_sessions SET state = 'UPLOADING', version = 2, session_issued_at = $3, provider_session_digest = $4, provider_session_expires_at = $5
        WHERE agency_id = $1 AND upload_id = $2 AND version = 1 AND session_attempt = 1`,
      [scope.agencyId, uploadId, iso(at(initiatedAt, 1_000)), textDigest(`session-${uploadId}`), iso(at(initiatedAt, 7 * DAY_MS))],
    );
    await appendFixtureEvent(c, {
      aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 2, agencyId: scope.agencyId, eventType: "upload_session.session_issued.v1", actorUserId: scope.ownerUserId,
      payload: { uploadId, agencyId: scope.agencyId, revisionId, sessionAttempt: 1, providerSessionDigest: textDigest(`session-${uploadId}`) },
    });
  });

  // CMD014 (request handler): the completion claim is recorded; nothing is admitted
  await sessions.app(async (c) => {
    await c.query(
      `UPDATE kauro.upload_sessions SET state = 'VERIFYING', version = 3, completion_reported_at = $3, completion_claim_digest = $4, claimed_generation = $5, claimed_bytes = $6
        WHERE agency_id = $1 AND upload_id = $2 AND version = 2`,
      [scope.agencyId, uploadId, iso(at(initiatedAt, 60_000)), claimDigest, quarantineGeneration, bytes],
    );
    await appendFixtureEvent(c, {
      aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 3, agencyId: scope.agencyId, eventType: "upload_session.completion_reported.v1", actorUserId: scope.ownerUserId,
      payload: { uploadId, agencyId: scope.agencyId, revisionId, completionClaimDigest: claimDigest, reportedByMembershipId: scope.ownerMembershipId },
    });
  });

  // UPLOAD_INSPECTION (control plane bound to the agency): observe, inspect, scan, promote, admit; UPLOADING -> INSPECTING
  const structureHash = tableStructureHashOf({
    fileId, ordinal: 0, kind: "CSV_TABLE", nameDigest: textDigest(""), visibility: "VISIBLE", columnCount: 2,
    columnLabelDigests: [textDigest("Email"), textDigest("Name")], hasFormulas: false, formulaCache: "NOT_APPLICABLE",
    mergedCellCount: 0, hiddenRowCount: 0, hiddenColumnCount: 0, issues: [],
  });
  const parserProfileHash = parserProfileHashOf({ inspector: "data-plane-0.1.0", format: "CSV", encoding: "UTF_8", delimiter: "COMMA" });
  const scannerConfigHash = textDigest("contract-fake-scanner-config");
  const receiptHash = inspectionReceiptHashOf({ uploadId, inspectionFence: 1, observedGeneration: quarantineGeneration, observedBytes: bytes, sha256, outcome: "ADMITTED", acceptedGeneration });
  const revisionVersion = await sessions.control(async (c) => {
    await c.query("UPDATE kauro.upload_sessions SET inspection_fence = 1 WHERE agency_id = $1 AND upload_id = $2 AND state = 'VERIFYING'", [scope.agencyId, uploadId]);
    await c.query(
      "UPDATE kauro.upload_sessions SET version = 4, completion_observed_at = $3, observed_generation = $4, observed_bytes = $5 WHERE agency_id = $1 AND upload_id = $2 AND version = 3",
      [scope.agencyId, uploadId, iso(at(initiatedAt, 61_000)), quarantineGeneration, bytes],
    );
    await appendFixtureEvent(c, {
      aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 4, agencyId: scope.agencyId, eventType: "upload_session.completion_observed.v1", actorUserId: null,
      payload: { uploadId, agencyId: scope.agencyId, revisionId, observedBytes: bytes, claimConsistent: true },
    });
    const inspecting = await one<{ version: string }>(c, "UPDATE kauro.dataset_revisions SET state = 'INSPECTING', version = version + 1 WHERE agency_id = $1 AND revision_id = $2 AND state = 'UPLOADING' RETURNING version::text", [scope.agencyId, revisionId]);
    await appendFixtureEvent(c, {
      aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: Number(inspecting.version), agencyId: scope.agencyId, eventType: "dataset_revision.inspecting.v1", actorUserId: null,
      payload: { revisionId, agencyId: scope.agencyId, projectId: scope.projectId, previousState: "UPLOADING", state: "INSPECTING" },
    });
    await c.query("UPDATE kauro.stored_objects SET state = 'PRESENT', generation = $3, bytes = $4, observed_at = $5 WHERE agency_id = $1 AND object_id = $2", [scope.agencyId, quarantineObjectId, quarantineGeneration, bytes, iso(at(initiatedAt, 61_000))]);
    await c.query("UPDATE kauro.stored_objects SET state = 'VERIFIED', sha256 = $3, verified_at = $4 WHERE agency_id = $1 AND object_id = $2", [scope.agencyId, quarantineObjectId, sha256, iso(at(initiatedAt, 62_000))]);
    // promotion: the accepted generation is registered before the copy, observed, then re-read and verified
    await c.query(
      `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, file_id, zone, data_class, provider, location_ref, object_name, created_by_kind, created_by_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACCEPTED', 'RAW', $7, 'ACCEPTED_PRIMARY', $8, 'SERVICE', $9, $10, now())`,
      [acceptedObjectId, scope.agencyId, scope.projectId, revisionId, uploadId, fileId, FIXTURE_STORAGE_PROVIDER, `accepted/${scope.agencyId}/${scope.projectId}/${fileId}`, FIXTURE_SERVICE, iso(at(initiatedAt, 63_000))],
    );
    await c.query("UPDATE kauro.stored_objects SET state = 'PRESENT', generation = $3, bytes = $4, observed_at = $5 WHERE agency_id = $1 AND object_id = $2", [scope.agencyId, acceptedObjectId, acceptedGeneration, bytes, iso(at(initiatedAt, 64_000))]);
    await c.query("UPDATE kauro.stored_objects SET state = 'VERIFIED', sha256 = $3, verified_at = $4 WHERE agency_id = $1 AND object_id = $2", [scope.agencyId, acceptedObjectId, sha256, iso(at(initiatedAt, 65_000))]);
    await c.query(
      `INSERT INTO kauro.inspection_receipts (receipt_id, agency_id, upload_id, revision_id, receipt_hash, inspection_fence, quarantine_object_id, observed_generation, observed_bytes, sha256,
          completion_claim_digest, claim_consistent, declared_format, detected_format, structure_status, scan_state, scanner_engine, scanner_engine_version, signature_version,
          signatures_published_at, signature_max_age_seconds, scanner_config_hash, scanner_exit_code, scanner_verdict, scanned_at, expected_parts, expected_bytes, scanned_parts, scanned_bytes,
          coverage, problems, parser_profile_hash, inspector_version, outcome, accepted_object_id, accepted_generation, accepted_sha256, started_at, completed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, true, 'CSV', 'CSV', 'STRUCTURE_VALID', 'COVERED_CLEAN', $11, 'SIMULATED-1', 'SIG-FIXTURE',
          $12, 86400, $13, 0, 'CLEAN', $14, 1, $8, 1, $8, $15, '[]', $16, 'data-plane-0.1.0', 'ADMITTED', $17, $18, $9, $19, $20, now())`,
      [
        ids.next(), scope.agencyId, uploadId, revisionId, receiptHash, quarantineObjectId, quarantineGeneration, bytes, sha256, claimDigest, FIXTURE_SCANNER,
        iso(at(initiatedAt, -3_600_000)), scannerConfigHash, iso(at(initiatedAt, 62_500)),
        JSON.stringify([{ partDigest: textDigest(`container-${uploadId}`), partKind: "CSV_BODY", expectedBytes: bytes, scannedBytes: bytes, outcome: "CLEAN" }]),
        parserProfileHash, acceptedObjectId, acceptedGeneration, iso(at(initiatedAt, 61_500)), iso(at(initiatedAt, 66_000)),
      ],
    );
    await c.query(
      `INSERT INTO kauro.source_files (file_id, agency_id, project_id, origin_revision_id, origin_upload_id, accepted_object_id, provider_generation, sha256, bytes, format, scan_state, parser_profile_hash, inspection_receipt_hash, admitted, admitted_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CSV', 'COVERED_CLEAN', $10, $11, true, $12, now(), now())`,
      [fileId, scope.agencyId, scope.projectId, revisionId, uploadId, acceptedObjectId, acceptedGeneration, sha256, bytes, parserProfileHash, receiptHash, iso(at(initiatedAt, 66_000))],
    );
    await c.query(
      `INSERT INTO kauro.source_tables (table_id, agency_id, file_id, ordinal, kind, name_display, name_digest, visibility, column_count, row_estimate, has_formulas, formula_cache, structure_hash, created_at)
       VALUES ($1, $2, $3, 0, 'CSV_TABLE', NULL, $4, 'VISIBLE', 2, 120, false, 'NOT_APPLICABLE', $5, now())`,
      [tableId, scope.agencyId, fileId, textDigest(""), structureHash],
    );
    await c.query(
      "INSERT INTO kauro.source_table_columns (table_id, ordinal, agency_id, label_display, label_digest, label_state) VALUES ($1, 0, $2, 'Email', $3, 'PRESENT'), ($1, 1, $2, 'Name', $4, 'PRESENT')",
      [tableId, scope.agencyId, textDigest("Email"), textDigest("Name")],
    );
    await c.query(
      "UPDATE kauro.upload_sessions SET state = 'ADMITTED', version = 5, admitted_at = $3, file_id = $4, inspection_receipt_hash = $5 WHERE agency_id = $1 AND upload_id = $2 AND version = 4",
      [scope.agencyId, uploadId, iso(at(initiatedAt, 66_000)), fileId, receiptHash],
    );
    await appendFixtureEvent(c, {
      aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 5, agencyId: scope.agencyId, eventType: "upload_session.admitted.v1", actorUserId: null,
      payload: { uploadId, agencyId: scope.agencyId, revisionId, fileId, inspectionReceiptHash: receiptHash, observedBytes: bytes, scanState: "COVERED_CLEAN", detectedFormat: "CSV" },
    });
    await c.query(
      `INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, 'INPUT_ADMITTED', $6, $7, now())`,
      [ids.next(), scope.agencyId, scope.projectId, revisionId, uploadId, iso(at(initiatedAt, 66_000)), retentionAnchorHashOf({ kind: "INPUT_ADMITTED", agencyId: scope.agencyId, projectId: scope.projectId, revisionId, uploadId, occurredAt: iso(at(initiatedAt, 66_000)), sourceEvidenceHash: receiptHash })],
    );
    return Number(inspecting.version);
  });
  return { revisionId, clientId, revisionVersion, uploadId, quarantineObjectId, acceptedObjectId, fileId, tableId, bytes, acceptedGeneration, sha256, receiptHash, structureHash, parserProfileHash, initiatedAt };
}

/** The selection manifest intake and CMD016 (request handler): the revision's selection is bound; it stays INSPECTING, uncounted. */
export async function bindSourceSelection(sessions: SourceFixtureSessions, scope: SourceFixtureScope, admitted: AdmittedSourceFixture): Promise<BoundSourceFixture> {
  const { revisionId, uploadId, fileId, tableId, receiptHash, acceptedGeneration, sha256, bytes, structureHash } = admitted;
  const inventoryHash = inventoryHashOf({
    revisionId,
    uploads: [{ uploadId, state: "ADMITTED", fileId, inspectionReceiptHash: receiptHash }],
    files: [{ fileId, generation: acceptedGeneration, sha256, bytes, tables: [{ tableId, ordinal: 0, structureHash }] }],
  });
  const selection: SelectionManifestDocument = {
    schemaVersion: 1,
    revisionId: revisionId as RevisionId,
    inventoryHash,
    files: [{ fileId: fileId as SourceFileId, origin: "THIS_REVISION", disposition: "INCLUDE" }],
    tables: [
      {
        tableId: tableId as SourceTableId,
        fileId: fileId as SourceFileId,
        structureHash,
        disposition: "INCLUDE",
        parser: { kind: "CSV", encoding: "UTF_8", delimiter: "COMMA", quote: "DOUBLE_QUOTE", header: { mode: "FIRST_RECORD" }, blankLines: "SKIP" },
      },
    ],
    projections: [{ projectionKey: "CONTACT", tableId: tableId as SourceTableId, objectKind: "CONTACT", kind: "ROW", fieldOrdinals: [0, 1] }],
    associations: [],
  };
  const selectionHash = selectionHashOf(selection);
  const selectionManifestId = ids.next();
  const revisionVersion = await sessions.app(async (c) => {
    await c.query(
      "INSERT INTO kauro.selection_manifests (selection_manifest_id, agency_id, project_id, revision_id, schema_version, body, body_hash, created_by_membership_id, created_at) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, now())",
      [selectionManifestId, scope.agencyId, scope.projectId, revisionId, JSON.stringify(selection), selectionHash, scope.ownerMembershipId],
    );
    const bound = await one<{ version: string }>(
      c,
      `UPDATE kauro.dataset_revisions SET selection_manifest_id = $3, selection_hash = $4, inventory_hash = $5, selected_at = now(), version = version + 1
        WHERE agency_id = $1 AND revision_id = $2 AND state = 'INSPECTING' RETURNING version::text`,
      [scope.agencyId, revisionId, selectionManifestId, selectionHash, inventoryHash],
    );
    await appendFixtureEvent(c, {
      aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: Number(bound.version), agencyId: scope.agencyId, eventType: "dataset_revision.selection_changed.v1", actorUserId: scope.ownerUserId,
      payload: { revisionId, agencyId: scope.agencyId, projectId: scope.projectId, selectionManifestId, selectionHash, inventoryHash, previousState: "INSPECTING", state: "INSPECTING", includedFileCount: 1, includedTableCount: 1, reusedFileIds: [] },
    });
    return Number(bound.version);
  });
  return { ...admitted, revisionVersion, selection, selectionManifestId, selectionHash, inventoryHash };
}

/**
 * SELECTION_EVALUATION's counting pass as statements inside the caller's open control-plane transaction bound to the scope's
 * agency: the complete evaluation of the bound selection is recorded; the revision is not moved.
 */
export async function countSourceSelection(c: SqlSession, scope: SourceFixtureScope, bound: BoundSourceFixture): Promise<CountedSourceSelection> {
  const counts: SourceCounts = { physicalSourceRows: 120, logicalSourceRecords: 120, billableSourceUnits: 120, associationEdges: 0 };
  const evaluationId = ids.next();
  const evaluationHash = textDigest(`evaluation-${evaluationId}`);
  await c.query(
    `INSERT INTO kauro.selection_evaluations (evaluation_id, agency_id, revision_id, selection_manifest_id, selection_hash, evaluation_hash, result, physical_source_rows, logical_source_records, billable_source_units, association_edges,
        file_count, total_bytes, files, tables, projections, pricing_definition, evaluator_version, started_at, completed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETE', $7, $8, $9, $10, 1, $11, $12, $13, $14, 'R2-INITIAL', 'data-plane-0.1.0', now(), now(), now())`,
    [
      evaluationId, scope.agencyId, bound.revisionId, bound.selectionManifestId, bound.selectionHash, evaluationHash, counts.physicalSourceRows, counts.logicalSourceRecords, counts.billableSourceUnits, counts.associationEdges, bound.bytes,
      JSON.stringify([{ fileId: bound.fileId, generation: bound.acceptedGeneration, sha256: bound.sha256, bytes: bound.bytes }]),
      JSON.stringify([{ tableId: bound.tableId, physicalRows: 120, columnCount: 2, excludedHiddenRows: 0, issues: [] }]),
      JSON.stringify([{ projectionKey: "CONTACT", objectKind: "CONTACT", logicalRecords: 120, billable: true }]),
    ],
  );
  return { evaluationId, evaluationHash, counts };
}

/** The selection manifest intake and CMD016 (request handler), then SELECTION_EVALUATION (control plane): READY_TO_SEAL. */
export async function readySourceRevision(sessions: SourceFixtureSessions, scope: SourceFixtureScope, admitted: AdmittedSourceFixture): Promise<ReadySourceFixture> {
  const bound = await bindSourceSelection(sessions, scope, admitted);
  const { counted, revisionVersion } = await sessions.control(async (c) => {
    const evaluation = await countSourceSelection(c, scope, bound);
    const { counts } = evaluation;
    const ready = await one<{ version: string }>(
      c,
      `UPDATE kauro.dataset_revisions SET state = 'READY_TO_SEAL', version = version + 1, evaluation_id = $3, evaluation_hash = $4,
              physical_source_rows = $5, logical_source_records = $6, billable_source_units = $7, association_edges = $8
        WHERE agency_id = $1 AND revision_id = $2 AND state = 'INSPECTING' RETURNING version::text`,
      [scope.agencyId, bound.revisionId, evaluation.evaluationId, evaluation.evaluationHash, counts.physicalSourceRows, counts.logicalSourceRecords, counts.billableSourceUnits, counts.associationEdges],
    );
    await appendFixtureEvent(c, {
      aggregateKind: "dataset_revision", aggregateId: bound.revisionId, aggregateVersion: Number(ready.version), agencyId: scope.agencyId, eventType: "dataset_revision.ready_to_seal.v1", actorUserId: null,
      payload: { revisionId: bound.revisionId, agencyId: scope.agencyId, projectId: scope.projectId, selectionHash: bound.selectionHash, evaluationHash: evaluation.evaluationHash, ...counts },
    });
    return { counted: evaluation, revisionVersion: Number(ready.version) };
  });
  return { ...bound, ...counted, revisionVersion };
}

/** The canonical sealed manifest of a ready fixture revision (KAURO_SOURCE_REVISION_V1 preimage) and its hashes. */
export function sealedManifestOf(scope: SourceFixtureScope, ready: ReadySourceFixture, projectionId: string): { readonly manifest: SealedManifestDocument; readonly manifestHash: string; readonly projectionHash: string } {
  const projections: SealedManifestDocument["projections"] = [
    { projectionId: projectionId as never, projectionKey: "CONTACT", tableId: ready.tableId as SourceTableId, objectKind: "CONTACT", kind: "ROW", fieldOrdinals: [0, 1], logicalRecords: 120, billable: true },
  ];
  const projectionHash = projectionHashOf({ projections, associations: [], pricingDefinition: "R2-INITIAL" });
  const manifest: SealedManifestDocument = {
    canonicalVersion: 1,
    revisionId: ready.revisionId as RevisionId,
    projectId: scope.projectId as ProjectId,
    supersedesRevisionId: null,
    files: [
      {
        fileId: ready.fileId as SourceFileId,
        disposition: "INCLUDED",
        exclusionReason: null,
        providerGeneration: ready.acceptedGeneration,
        sha256: ready.sha256,
        bytes: ready.bytes,
        format: "CSV",
        parserProfileHash: ready.parserProfileHash,
        inspectionReceiptHash: ready.receiptHash,
        tables: [{ tableId: ready.tableId as SourceTableId, ordinal: 0, structureHash: ready.structureHash, visibility: "VISIBLE", disposition: "INCLUDED", exclusionReason: null, parser: ready.selection.tables[0]?.parser ?? null, selectedColumns: null, physicalRows: 120 }],
      },
    ],
    rejectedUploads: [],
    projections,
    associations: [],
    populations: ready.counts,
    selectionHash: ready.selectionHash,
    evaluationHash: ready.evaluationHash,
    projectionHash,
    pricingDefinition: "R2-INITIAL",
    inputEnvelope: { files: 50, fileBytes: 2_000_000_000, revisionBytes: 5_000_000_000 },
  };
  return { manifest, manifestHash: sourceRevisionManifestHashOf(manifest), projectionHash };
}

/**
 * CMD017 SealRevision's writes inside the caller's open request-handler transaction bound to the scope's agency and owner: the
 * sealed manifest and its file set, the seal anchor and the UNPAID retention record, READY_TO_SEAL -> SEALED. Exported so a test
 * can hold the seal open against a concurrent writer.
 */
export async function sealStatements(c: SqlSession, scope: SourceFixtureScope, ready: ReadySourceFixture, sealedAt: Date): Promise<SealedSourceFixture> {
  const { manifest, manifestHash, projectionHash } = sealedManifestOf(scope, ready, ids.next());
  const retentionId = ids.next();
  await c.query(
    `INSERT INTO kauro.sealed_manifests (revision_id, agency_id, project_id, manifest_hash, projection_hash, selection_hash, evaluation_hash, canonical_version, manifest, sealed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)`,
    [ready.revisionId, scope.agencyId, scope.projectId, manifestHash, projectionHash, ready.selectionHash, ready.evaluationHash, JSON.stringify(manifest), iso(sealedAt)],
  );
  await c.query(
    "INSERT INTO kauro.sealed_revision_files (revision_id, file_id, agency_id, project_id, ordinal, disposition, provider_generation, sha256, bytes) VALUES ($1, $2, $3, $4, 0, 'INCLUDED', $5, $6, $7)",
    [ready.revisionId, ready.fileId, scope.agencyId, scope.projectId, ready.acceptedGeneration, ready.sha256, ready.bytes],
  );
  const anchorId = ids.next();
  const anchorHash = retentionAnchorHashOf({ kind: "REVISION_SEALED", agencyId: scope.agencyId, projectId: scope.projectId, revisionId: ready.revisionId, uploadId: null, occurredAt: iso(sealedAt), sourceEvidenceHash: manifestHash });
  await c.query(
    "INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, 'REVISION_SEALED', $5, $6, now())",
    [anchorId, scope.agencyId, scope.projectId, ready.revisionId, iso(sealedAt), anchorHash],
  );
  await c.query(
    `INSERT INTO kauro.retention_records (retention_id, agency_id, client_id, project_id, revision_id, class, anchor_id, anchor_evidence_hash, hard_deadline, effective_deadline, policy_version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'UNPAID', $6, $7, $8, $8, 'R2-RETENTION-1', now(), now())`,
    [retentionId, scope.agencyId, ready.clientId, scope.projectId, ready.revisionId, anchorId, anchorHash, iso(at(sealedAt, 14 * DAY_MS))],
  );
  await appendFixtureEvent(c, {
    aggregateKind: "retention_record", aggregateId: retentionId, aggregateVersion: 1, agencyId: scope.agencyId, eventType: "retention_record.created.v1", actorUserId: scope.ownerUserId,
    payload: { retentionId, agencyId: scope.agencyId, projectId: scope.projectId, revisionId: ready.revisionId, retentionClass: "UNPAID", anchorEvidenceHash: anchorHash, policyVersion: "R2-RETENTION-1" },
  });
  const sealed = await one<{ version: string }>(
    c,
    `UPDATE kauro.dataset_revisions SET state = 'SEALED', version = version + 1, manifest_hash = $3, projection_hash = $4, sealed_at = $5, sealed_file_count = 1, sealed_bytes = $6
      WHERE agency_id = $1 AND revision_id = $2 AND state = 'READY_TO_SEAL' RETURNING version::text`,
    [scope.agencyId, ready.revisionId, manifestHash, projectionHash, iso(sealedAt), ready.bytes],
  );
  await appendFixtureEvent(c, {
    aggregateKind: "dataset_revision", aggregateId: ready.revisionId, aggregateVersion: Number(sealed.version), agencyId: scope.agencyId, eventType: "dataset_revision.sealed.v1", actorUserId: scope.ownerUserId,
    payload: { revisionId: ready.revisionId, agencyId: scope.agencyId, projectId: scope.projectId, manifestHash, projectionHash, selectionHash: ready.selectionHash, evaluationHash: ready.evaluationHash, ...ready.counts, fileCount: 1, sealedBytes: ready.bytes, retentionId },
  });
  return { revisionId: ready.revisionId, manifestHash, projectionHash, version: Number(sealed.version), uploadId: ready.uploadId, fileId: ready.fileId, retentionId, sealedAt };
}

/** CMD017 in its own request-handler transaction. */
export async function sealReadyRevision(sessions: SourceFixtureSessions, scope: SourceFixtureScope, ready: ReadySourceFixture): Promise<SealedSourceFixture> {
  return sessions.app((c) => sealStatements(c, scope, ready, at(ready.initiatedAt, 10 * 60_000)));
}

/**
 * Seals one revision of the scope's project through the B07 lifecycle (header) and, for state EXPIRED, lets the retention sweeper
 * expire it. Returns the manifest hash a plan names as its source (plans_source_fk).
 */
export async function sealSourceRevision(sessions: SourceFixtureSessions, scope: SourceFixtureScope, options: SealSourceOptions): Promise<SealedSourceFixture> {
  const admitted = await admitSourceFile(sessions, scope, { seed: options.seed, ...(options.base !== undefined ? { base: options.base } : {}) });
  const ready = await readySourceRevision(sessions, scope, admitted);
  const sealed = await sealReadyRevision(sessions, scope, ready);
  if (options.state !== "EXPIRED") return sealed;
  const version = await sessions.control((c) => expireSealedRevision(c, scope, sealed.revisionId));
  return { ...sealed, version };
}

/**
 * The retention sweeper's retention_expires edge (design §7.5), as statements inside the caller's open control-plane transaction
 * bound to the scope's agency: every ACTIVE record governing the revision whose effective deadline has passed expires, then the
 * revision SEALED -> EXPIRED (the database refuses it while a governing deadline lies ahead). Returns the revision's new version.
 * Exported so a test can hold this transaction open against a concurrent command (B06's CMD025 expiry races).
 */
export async function expireSealedRevision(c: SqlSession, scope: SourceFixtureScope, revisionId: string): Promise<number> {
  const records = await c.query<{ retention_id: string; version: string; class: string }>(
    "SELECT retention_id, version::text, class FROM kauro.retention_records WHERE agency_id = $1 AND revision_id = $2 AND state = 'ACTIVE' AND effective_deadline <= now() ORDER BY retention_id FOR UPDATE",
    [scope.agencyId, revisionId],
  );
  for (const r of records.rows) {
    await c.query("UPDATE kauro.retention_records SET state = 'EXPIRED', expired_at = now(), version = version + 1 WHERE agency_id = $1 AND retention_id = $2", [scope.agencyId, r.retention_id]);
    await appendFixtureEvent(c, {
      aggregateKind: "retention_record", aggregateId: r.retention_id, aggregateVersion: Number(r.version) + 1, agencyId: scope.agencyId, eventType: "retention_record.expired.v1", actorUserId: null,
      payload: { retentionId: r.retention_id, agencyId: scope.agencyId, projectId: scope.projectId, revisionId, retentionClass: r.class },
    });
  }
  const expired = await one<{ version: string }>(
    c,
    "UPDATE kauro.dataset_revisions SET state = 'EXPIRED', expired_at = now(), terminal_reason = 'RETENTION_DEADLINE', version = version + 1 WHERE agency_id = $1 AND revision_id = $2 AND state = 'SEALED' RETURNING version::text",
    [scope.agencyId, revisionId],
  );
  await appendFixtureEvent(c, {
    aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: Number(expired.version), agencyId: scope.agencyId, eventType: "dataset_revision.expired.v1", actorUserId: null,
    payload: { revisionId, agencyId: scope.agencyId, projectId: scope.projectId, previousState: "SEALED", reasonCode: "RETENTION_DEADLINE" },
  });
  return Number(expired.version);
}
