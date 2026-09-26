/**
 * The DatasetRevision lifecycle and lineage B07 drives, the project's current-revision pointer, the authority bound to a sealed
 * source (CMD012's impact map) and the two-phase journal link over `pg` (B07; migrations 0009, 0011; decisions D-INTAKE-1,
 * D-SEL-3, D-SEL-4, D-SEAL-1, D-REV-1, D-REV-2, D-LOCK-1, D-CLOCK-1, D-RUN-2).
 *
 * `transition` writes the facts each target state requires with kauro.server_now() for every instant; which edge exists (KA008),
 * whether its facts are present (dataset_revisions_lifecycle_guard, KA072 — after the revision's transition lock) and who may take
 * it (the role policies) are the database's. The adapter adds the compare-and-swap on the version. The revision's terminal facts
 * are set once (KA004): retention_expires from REJECTED keeps the rejection's reason (re-check residual FINAL-N2, decision
 * D-PERS-3), only a revision without a terminal reason (SEALED) records the expiry's.
 */
import type { Id, Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  type AgencyId,
  type ApprovalId,
  type EvaluationId,
  type JournalEntryId,
  type MembershipId,
  type PendingOperationJournal,
  type PlanId,
  type ProjectId,
  type ProjectRecord,
  type ProjectRevisionPointer,
  type RevisionAuthorityInspector,
  type RevisionId,
  type RevisionInventory,
  type RevisionTransition,
  type SelectionManifestId,
  type SourceRevisionRecord,
  type SourceRevisionRepository,
  type VersionedWrite,
} from "@kauro/domain";
import { PgProjectRepository } from "../repositories/workspace.js";
import { staleOrMissing } from "../repositories/tenancy.js";
import { execute, int, type Queryable } from "../sql.js";
import { exact, instantText, missedWrite, notAvailable, one, opt, optionalInstantText, optionalInt, optionalString, pageLimit, str } from "./rows.js";

type Row = Record<string, unknown>;

export const REVISION_COLUMNS = [
  "revision_id",
  "agency_id",
  "project_id",
  "version::text AS version",
  "state",
  "manifest_hash",
  "projection_hash",
  exact("sealed_at"),
  "supersedes_revision_id",
  "created_by_membership_id",
  "selection_manifest_id",
  "selection_hash",
  "inventory_hash",
  exact("selected_at"),
  "evaluation_id",
  "evaluation_hash",
  "physical_source_rows::text AS physical_source_rows",
  "logical_source_records::text AS logical_source_records",
  "billable_source_units::text AS billable_source_units",
  "association_edges::text AS association_edges",
  "sealed_file_count",
  "sealed_bytes::text AS sealed_bytes",
  "superseded_by_revision_id",
  exact("superseded_at"),
  exact("cancelled_at"),
  exact("rejected_at"),
  exact("expired_at"),
  exact("deleted_at"),
  "terminal_reason",
  exact("created_at"),
  exact("updated_at"),
].join(", ");

export function revisionRecord(r: Row): SourceRevisionRecord {
  const physical = optionalInt(r["physical_source_rows"]);
  return {
    revisionId: str<RevisionId>(r["revision_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    projectId: str<ProjectId>(r["project_id"]),
    scope: { agencyId: str(r["agency_id"]), projectId: str(r["project_id"]) },
    version: int(r["version"]),
    state: str<SourceRevisionRecord["state"]>(r["state"]),
    ...opt("manifestHash", optionalString<Sha256Hex>(r["manifest_hash"])),
    ...opt("projectionHash", optionalString<Sha256Hex>(r["projection_hash"])),
    ...opt("sealedAt", optionalInstantText(r["sealed_at"])),
    ...opt("supersedesRevisionId", optionalString<RevisionId>(r["supersedes_revision_id"])),
    ...opt("createdByMembershipId", optionalString<MembershipId>(r["created_by_membership_id"])),
    ...opt("selectionManifestId", optionalString<SelectionManifestId>(r["selection_manifest_id"])),
    ...opt("selectionHash", optionalString<Sha256Hex>(r["selection_hash"])),
    ...opt("inventoryHash", optionalString<Sha256Hex>(r["inventory_hash"])),
    ...opt("selectedAt", optionalInstantText(r["selected_at"])),
    ...opt("evaluationId", optionalString<EvaluationId>(r["evaluation_id"])),
    ...opt("evaluationHash", optionalString<Sha256Hex>(r["evaluation_hash"])),
    ...opt(
      "populations",
      physical === undefined
        ? undefined
        : {
            physicalSourceRows: physical,
            logicalSourceRecords: int(r["logical_source_records"]),
            billableSourceUnits: int(r["billable_source_units"]),
            associationEdges: int(r["association_edges"]),
          },
    ),
    ...opt("sealedFileCount", optionalInt(r["sealed_file_count"])),
    ...opt("sealedBytes", optionalInt(r["sealed_bytes"])),
    ...opt("supersededByRevisionId", optionalString<RevisionId>(r["superseded_by_revision_id"])),
    ...opt("supersededAt", optionalInstantText(r["superseded_at"])),
    ...opt("cancelledAt", optionalInstantText(r["cancelled_at"])),
    ...opt("rejectedAt", optionalInstantText(r["rejected_at"])),
    ...opt("expiredAt", optionalInstantText(r["expired_at"])),
    ...opt("deletedAt", optionalInstantText(r["deleted_at"])),
    ...opt("terminalReason", optionalString(r["terminal_reason"])),
    createdAt: instantText(r["created_at"]),
    updatedAt: instantText(r["updated_at"]),
  };
}

/** A selection binding: the manifest, its hash, the inventory it was made against, at the server's instant; always uncounted. */
const BINDING = "selection_manifest_id = $3, selection_hash = $4, inventory_hash = $5, selected_at = kauro.server_now()";
const UNCOUNTED = "evaluation_id = NULL, evaluation_hash = NULL, physical_source_rows = NULL, logical_source_records = NULL, billable_source_units = NULL, association_edges = NULL";

/** The SET clause and parameters of one DatasetRevision edge (params from $3; $1 revision, $2 expected version). */
function edgeOf(change: RevisionTransition): { readonly set: string; readonly params: ReadonlyArray<unknown> } {
  switch (change.event) {
    case "upload_reserved":
      return { set: "state = 'UPLOADING'", params: [] };
    case "all_uploads_completed":
    case "previously_admitted_inputs_selected":
    case "selection_changes":
      // the agency's selection; from UPLOADING it is the explicit closing of the intake (D-INTAKE-1), from READY_TO_SEAL it
      // invalidates the counted scope (registry selection_changes)
      return { set: `state = 'INSPECTING', ${BINDING}, ${UNCOUNTED}`, params: [change.selection.selectionManifestId, change.selection.selectionHash, change.selection.inventoryHash] };
    case "selection_rebound":
      // a new selection while INSPECTING: no state change (the guard requires the binding to leave the revision INSPECTING)
      return { set: `${BINDING}, ${UNCOUNTED}`, params: [change.selection.selectionManifestId, change.selection.selectionHash, change.selection.inventoryHash] };
    case "all_selected_inputs_admitted":
      return {
        set: "state = 'READY_TO_SEAL', evaluation_id = $3, evaluation_hash = $4, physical_source_rows = $5, logical_source_records = $6, billable_source_units = $7, association_edges = $8",
        params: [
          change.evaluationId,
          change.evaluationHash,
          change.populations.physicalSourceRows,
          change.populations.logicalSourceRecords,
          change.populations.billableSourceUnits,
          change.populations.associationEdges,
        ],
      };
    case "fatal_input_rejection":
      return { set: "state = 'REJECTED', rejected_at = kauro.server_now(), terminal_reason = $3", params: [change.reason] };
    case "seal_command":
      return {
        set: "state = 'SEALED', manifest_hash = $3, projection_hash = $4, sealed_at = kauro.server_now(), sealed_file_count = $5, sealed_bytes = $6",
        params: [change.manifestHash, change.projectionHash, change.sealedFileCount, change.sealedBytes],
      };
    case "new_revision_explicitly_supersedes":
      return { set: "state = 'SUPERSEDED', superseded_by_revision_id = $3, superseded_at = kauro.server_now()", params: [change.successorRevisionId] };
    case "cancel_revision":
      // CMD012 replacing a mutable predecessor names its successor, so the lineage records how the predecessor was replaced
      return { set: "state = 'CANCELLED', cancelled_at = kauro.server_now(), terminal_reason = $3, superseded_by_revision_id = $4", params: [change.reason, change.successorRevisionId ?? null] };
    case "retention_expires":
      // terminal facts are set once: from REJECTED the rejection's reason stays (FINAL-N2, D-PERS-3)
      return { set: "state = 'EXPIRED', expired_at = kauro.server_now(), terminal_reason = coalesce(terminal_reason, $3)", params: [change.reason] };
    case "managed_cleanup_verified":
      return { set: "state = 'DELETED', deleted_at = kauro.server_now()", params: [] };
  }
}

export class PgSourceRevisionRepository implements SourceRevisionRepository {
  constructor(private readonly db: Queryable) {}

  async get(revisionId: RevisionId): Promise<SourceRevisionRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${REVISION_COLUMNS} FROM kauro.dataset_revisions WHERE revision_id = $1`, [revisionId]);
    return r.rows[0] ? revisionRecord(r.rows[0]) : null;
  }

  async lock(revisionId: RevisionId): Promise<SourceRevisionRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${REVISION_COLUMNS} FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE`, [revisionId]);
    return r.rows[0] ? revisionRecord(r.rows[0]) : null;
  }

  /** The successor DRAFT at version 1 with its explicit predecessor, created at the server's transaction time (CMD012). */
  async insertSuccessor(revision: { readonly revisionId: RevisionId; readonly agencyId: AgencyId; readonly projectId: ProjectId; readonly supersedesRevisionId: RevisionId; readonly createdByMembershipId: MembershipId; readonly createdAt: UtcInstant }): Promise<SourceRevisionRecord> {
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.dataset_revisions (revision_id, agency_id, project_id, version, state, supersedes_revision_id, created_by_membership_id, created_at, updated_at)
       VALUES ($1, $2, $3, 1, 'DRAFT', $4, $5, kauro.server_now(), kauro.server_now()) RETURNING ${REVISION_COLUMNS}`,
      [revision.revisionId, revision.agencyId, revision.projectId, revision.supersedesRevisionId, revision.createdByMembershipId],
    );
    return revisionRecord(one(r.rows, "successor revision insert"));
  }

  async transition(revisionId: RevisionId, expectedVersion: number, change: RevisionTransition): Promise<VersionedWrite<SourceRevisionRecord>> {
    const edge = edgeOf(change);
    const r = await execute<Row>(this.db, `UPDATE kauro.dataset_revisions SET ${edge.set}, version = $2 + 1 WHERE revision_id = $1 AND version = $2 RETURNING ${REVISION_COLUMNS}`, [
      revisionId,
      expectedVersion,
      ...edge.params,
    ]);
    const row = r.rows[0];
    if (row) return { kind: "APPLIED", record: revisionRecord(row) };
    return missedWrite(this.db, "dataset_revisions", "revision_id", revisionId, expectedVersion, "revision", ({ state }) => notAvailable("the revision", state));
  }

  /**
   * The inventory a selection is made against (KAURO_SOURCE_INVENTORY_V1, D-SEL-3): every upload of the revision with its outcome,
   * ordered by upload id, and the files admitted from them whose admission stands, ordered by file id, each with its tables in
   * ordinal order. Ids, states, digests and counts only.
   */
  async inventory(revisionId: RevisionId): Promise<RevisionInventory> {
    const uploads = await execute<{ upload_id: string; state: string; file_id: string | null; inspection_receipt_hash: string | null }>(
      this.db,
      "SELECT upload_id, state, file_id, inspection_receipt_hash FROM kauro.upload_sessions WHERE revision_id = $1 ORDER BY upload_id",
      [revisionId],
    );
    const files = await execute<{ file_id: string; provider_generation: string; sha256: string; bytes: string }>(
      this.db,
      "SELECT file_id, provider_generation, sha256, bytes::text AS bytes FROM kauro.source_files WHERE origin_revision_id = $1 AND state = 'ADMITTED' ORDER BY file_id",
      [revisionId],
    );
    const tables = await execute<{ file_id: string; table_id: string; ordinal: number; structure_hash: string }>(
      this.db,
      "SELECT file_id, table_id, ordinal, structure_hash FROM kauro.source_tables WHERE file_id = ANY($1::uuid[]) ORDER BY file_id, ordinal",
      [files.rows.map((f) => f.file_id)],
    );
    const byId = (a: { readonly id: string }, b: { readonly id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return {
      revisionId,
      uploads: uploads.rows
        .map((u) => ({ id: u.upload_id, value: { uploadId: u.upload_id, state: u.state, fileId: u.file_id, inspectionReceiptHash: u.inspection_receipt_hash } }))
        .sort(byId)
        .map((u) => u.value),
      files: files.rows
        .map((f) => ({
          id: f.file_id,
          value: {
            fileId: f.file_id,
            generation: f.provider_generation,
            sha256: f.sha256 as Sha256Hex,
            bytes: int(f.bytes),
            tables: tables.rows.filter((t) => t.file_id === f.file_id).map((t) => ({ tableId: t.table_id, ordinal: int(t.ordinal), structureHash: t.structure_hash as Sha256Hex })),
          },
        }))
        .sort(byId)
        .map((f) => f.value),
    };
  }

  /**
   * On the server clock (§12.5 RETENTION): SEALED revisions governed by a record none of which is ACTIVE with an effective deadline
   * ahead, and REJECTED revisions whose every intake window closed. The database re-checks both at the edge.
   */
  async findRetentionDue(limit: number): Promise<ReadonlyArray<{ readonly revisionId: RevisionId; readonly agencyId: AgencyId }>> {
    const r = await execute<{ revision_id: string; agency_id: string }>(
      this.db,
      `SELECT r.revision_id, r.agency_id FROM kauro.dataset_revisions r
        WHERE (r.state = 'SEALED'
               AND EXISTS (SELECT 1 FROM kauro.retention_records x WHERE x.agency_id = r.agency_id AND x.revision_id = r.revision_id)
               AND NOT EXISTS (SELECT 1 FROM kauro.retention_records x WHERE x.agency_id = r.agency_id AND x.revision_id = r.revision_id
                                AND x.state = 'ACTIVE' AND x.effective_deadline > kauro.server_now()))
           OR (r.state = 'REJECTED'
               AND NOT EXISTS (SELECT 1 FROM kauro.upload_sessions u WHERE u.agency_id = r.agency_id AND u.revision_id = r.revision_id AND u.application_expires_at > kauro.server_now()))
        ORDER BY r.revision_id LIMIT $1`,
      [pageLimit(limit, 1000)],
    );
    return r.rows.map((x) => ({ revisionId: x.revision_id as RevisionId, agencyId: x.agency_id as AgencyId }));
  }
}

/** CMD012's move of the project's current revision (project.current_revision_changed.v1); the revision must be the project's own. */
export class PgProjectRevisionPointer implements ProjectRevisionPointer {
  readonly #projects: PgProjectRepository;

  constructor(private readonly db: Queryable) {
    this.#projects = new PgProjectRepository(db);
  }

  async switchCurrentRevision(projectId: ProjectId, expectedVersion: number, revisionId: RevisionId, _now: UtcInstant): Promise<VersionedWrite<ProjectRecord>> {
    const r = await execute<{ project_id: string }>(this.db, "UPDATE kauro.projects SET current_revision_id = $3, version = $2 + 1 WHERE project_id = $1 AND version = $2 RETURNING project_id", [
      projectId,
      expectedVersion,
      revisionId,
    ]);
    if (r.rows[0] === undefined) return staleOrMissing(this.db, "projects", "project_id", projectId, "project");
    const project = await this.#projects.get(projectId);
    if (project === null) throw new DomainFailure("INTEGRITY_FAILURE", "the project moved its current revision and then vanished");
    return { kind: "APPLIED", record: project };
  }
}

/** The plans still bound to a sealed source and their live approvals (CMD012's impact map; never transferred). */
export class PgRevisionAuthorityInspector implements RevisionAuthorityInspector {
  constructor(private readonly db: Queryable) {}

  async boundTo(manifestHash: Sha256Hex): Promise<{ readonly planIds: ReadonlyArray<PlanId>; readonly approvalIds: ReadonlyArray<ApprovalId> }> {
    const plans = await execute<{ plan_id: string }>(
      this.db,
      "SELECT plan_id FROM kauro.plans WHERE revision_hash = $1 AND state NOT IN ('SUPERSEDED', 'WITHDRAWN') ORDER BY created_at, plan_id",
      [manifestHash],
    );
    const planIds = plans.rows.map((p) => p.plan_id);
    const approvals = await execute<{ approval_id: string }>(
      this.db,
      "SELECT approval_id FROM kauro.approvals WHERE plan_id = ANY($1::uuid[]) AND withdrawn_at IS NULL ORDER BY created_at, approval_id",
      [planIds],
    );
    return { planIds: planIds as PlanId[], approvalIds: approvals.rows.map((a) => a.approval_id as ApprovalId) };
  }
}

/** D-RUN-2: the RESERVED journal entry of a two-phase command linked to the business object its first phase created. */
export class PgPendingOperationJournal implements PendingOperationJournal {
  constructor(private readonly db: Queryable) {}

  async attach(entryId: JournalEntryId, resourceKind: string, resourceId: Id): Promise<void> {
    const r = await execute(
      this.db,
      `UPDATE kauro.command_journal SET resource_kind = $2, resource_id = $3
        WHERE entry_id = $1 AND state = 'RESERVED' AND (resource_id IS NULL OR (resource_kind = $2 AND resource_id = $3::uuid))`,
      [entryId, resourceKind, resourceId],
    );
    if ((r.rowCount ?? 0) !== 1) throw new DomainFailure("INTEGRITY_FAILURE", `journal entry ${entryId} is not a RESERVED entry of this resource`);
  }
}
