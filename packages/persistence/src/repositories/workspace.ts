/**
 * Processing authorities, end clients, projects, dataset revisions, target contracts and capabilities over `pg`
 * (07 "Aggregate ownership": ClientWorkspace owns a scoped end-client label without a global CRM identity; Project owns
 * purchased business intent and its revision lineage; 07 "Database representation": composite foreign keys prevent a project
 * in one agency from referencing another agency's client or revision — the repositories rely on those keys instead of
 * re-checking ownership in code; a foreign reference surfaces as INVALID_REQUEST / UNKNOWN_REFERENCE from SQLSTATE 23503).
 *
 * Pagination (07): a total ordering with a unique tie-breaker inside the tenant — end clients by (created_at, client_id).
 */
import type { Capability, DatasetRevision, Sha256Hex, TargetContract, UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  type AgencyId,
  type CapabilityId,
  type CapabilityRecord,
  type CapabilityRepository,
  type ClientId,
  type DatasetRevisionRecord,
  type DatasetRevisionRepository,
  type EndClientRecord,
  type EndClientRepository,
  type MembershipId,
  type NewEndClient,
  type NewProject,
  type ProcessingAuthorityId,
  type ProcessingAuthorityRecord,
  type ProcessingAuthorityRepository,
  type ProjectId,
  type ProjectRecord,
  type ProjectRepository,
  type ProjectState,
  type RevisionId,
  type ServiceMode,
  type TargetContractId,
  type TargetContractRecord,
  type TargetContractRepository,
  type TargetInstanceRef,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, instant, int, optionalInstant, optionalText, text, withOptional, type Queryable } from "../sql.js";
import { staleOrMissing } from "./tenancy.js";

// --- processing authorities -------------------------------------------------------------------------------------------

interface AuthorityRow {
  processing_authority_id: string;
  agency_id: string;
  kind: ProcessingAuthorityRecord["kind"];
  evidence_hash: string;
  recorded_by_membership_id: string;
  recorded_at: Date;
}

const AUTHORITY_COLUMNS = "processing_authority_id, agency_id, kind, evidence_hash, recorded_by_membership_id, recorded_at";

function authorityRecord(r: AuthorityRow): ProcessingAuthorityRecord {
  return {
    processingAuthorityId: r.processing_authority_id as ProcessingAuthorityId,
    agencyId: r.agency_id as AgencyId,
    kind: r.kind,
    evidenceHash: r.evidence_hash,
    recordedByMembershipId: r.recorded_by_membership_id as MembershipId,
    recordedAt: instant(r.recorded_at),
  };
}

export class PgProcessingAuthorityRepository implements ProcessingAuthorityRepository {
  constructor(private readonly db: Queryable) {}

  async get(processingAuthorityId: ProcessingAuthorityId): Promise<ProcessingAuthorityRecord | null> {
    const r = await execute<AuthorityRow>(this.db, `SELECT ${AUTHORITY_COLUMNS} FROM kauro.processing_authorities WHERE processing_authority_id = $1`, [processingAuthorityId]);
    return r.rows[0] ? authorityRecord(r.rows[0]) : null;
  }

  async insert(record: ProcessingAuthorityRecord): Promise<ProcessingAuthorityRecord> {
    const r = await execute<AuthorityRow>(
      this.db,
      `INSERT INTO kauro.processing_authorities (${AUTHORITY_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${AUTHORITY_COLUMNS}`,
      [record.processingAuthorityId, record.agencyId, record.kind, record.evidenceHash, record.recordedByMembershipId, record.recordedAt],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "processing authority insert returned no row");
    return authorityRecord(row);
  }
}

// --- end clients ------------------------------------------------------------------------------------------------------

interface ClientRow {
  client_id: string;
  agency_id: string;
  version: string;
  display_name: string;
  state: EndClientRecord["state"];
  processing_authority_ref: string;
  created_by_membership_id: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const CLIENT_COLUMNS = "client_id, agency_id, version, display_name, state, processing_authority_ref, created_by_membership_id, archived_at, created_at, updated_at";

function clientRecord(r: ClientRow): EndClientRecord {
  const base = {
    clientId: r.client_id as ClientId,
    agencyId: r.agency_id as AgencyId,
    version: int(r.version),
    displayName: r.display_name,
    state: r.state,
    processingAuthorityRef: r.processing_authority_ref as ProcessingAuthorityId,
    createdByMembershipId: r.created_by_membership_id as MembershipId,
    createdAt: instant(r.created_at),
    updatedAt: instant(r.updated_at),
  };
  return withOptional(base, "archivedAt", optionalInstant(r.archived_at));
}

export class PgEndClientRepository implements EndClientRepository {
  constructor(private readonly db: Queryable) {}

  async get(clientId: ClientId): Promise<EndClientRecord | null> {
    const r = await execute<ClientRow>(this.db, `SELECT ${CLIENT_COLUMNS} FROM kauro.end_clients WHERE client_id = $1`, [clientId]);
    return r.rows[0] ? clientRecord(r.rows[0]) : null;
  }

  async lock(clientId: ClientId): Promise<EndClientRecord | null> {
    const r = await execute<ClientRow>(this.db, `SELECT ${CLIENT_COLUMNS} FROM kauro.end_clients WHERE client_id = $1 FOR UPDATE`, [clientId]);
    return r.rows[0] ? clientRecord(r.rows[0]) : null;
  }

  async insert(client: NewEndClient): Promise<EndClientRecord> {
    const r = await execute<ClientRow>(
      this.db,
      `INSERT INTO kauro.end_clients (client_id, agency_id, version, display_name, state, processing_authority_ref, created_by_membership_id, created_at, updated_at)
       VALUES ($1, $2, 1, $3, 'ACTIVE', $4, $5, $6, $6) RETURNING ${CLIENT_COLUMNS}`,
      [client.clientId, client.agencyId, client.displayName, client.processingAuthorityRef, client.createdByMembershipId, client.createdAt],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "end client insert returned no row");
    return clientRecord(row);
  }

  async archive(clientId: ClientId, expectedVersion: number, now: UtcInstant): Promise<VersionedWrite<EndClientRecord>> {
    const r = await execute<ClientRow>(
      this.db,
      `UPDATE kauro.end_clients SET state = 'ARCHIVED', archived_at = $3, version = $2 + 1 WHERE client_id = $1 AND version = $2 RETURNING ${CLIENT_COLUMNS}`,
      [clientId, expectedVersion, now],
    );
    const row = r.rows[0];
    if (row) return { kind: "APPLIED", record: clientRecord(row) };
    return staleOrMissing(this.db, "end_clients", "client_id", clientId, "client");
  }

  async list(agencyId: AgencyId, page: { readonly after?: { readonly createdAt: UtcInstant; readonly clientId: ClientId }; readonly limit: number }): Promise<ReadonlyArray<EndClientRecord>> {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100) throw new DomainFailure("INVALID_REQUEST", "page limit must be 1..100 (R2 policy api)");
    const params: unknown[] = [agencyId, page.limit];
    let where = "agency_id = $1";
    if (page.after) {
      params.push(page.after.createdAt, page.after.clientId);
      where += " AND (created_at, client_id) > ($3, $4)";
    }
    const r = await execute<ClientRow>(this.db, `SELECT ${CLIENT_COLUMNS} FROM kauro.end_clients WHERE ${where} ORDER BY created_at, client_id LIMIT $2`, params);
    return r.rows.map(clientRecord);
  }

  async countOpenProjects(clientId: ClientId): Promise<number> {
    const r = await execute<{ n: string }>(this.db, "SELECT count(*)::text AS n FROM kauro.projects WHERE client_id = $1 AND state = 'OPEN'", [clientId]);
    return int(text(r.rows[0]?.n));
  }
}

// --- projects ---------------------------------------------------------------------------------------------------------

interface ProjectRow {
  project_id: string;
  agency_id: string;
  client_id: string;
  version: string;
  state: ProjectState;
  mode: ServiceMode;
  purpose: string;
  target_instance_ref: string | null;
  capability_id: string;
  capability_version: string;
  current_revision_id: string;
  created_by_membership_id: string;
  created_at: Date;
  updated_at: Date;
}

const PROJECT_COLUMNS = "project_id, agency_id, client_id, version, state, mode, purpose, target_instance_ref, capability_id, capability_version, current_revision_id, created_by_membership_id, created_at, updated_at";

function projectRecord(r: ProjectRow): ProjectRecord {
  const base = {
    projectId: r.project_id as ProjectId,
    agencyId: r.agency_id as AgencyId,
    clientId: r.client_id as ClientId,
    version: int(r.version),
    state: r.state,
    mode: r.mode,
    purpose: r.purpose,
    capabilityId: r.capability_id as CapabilityId,
    capabilityVersion: r.capability_version,
    currentRevisionId: r.current_revision_id as RevisionId,
    createdByMembershipId: r.created_by_membership_id as MembershipId,
    createdAt: instant(r.created_at),
    updatedAt: instant(r.updated_at),
  };
  return withOptional(base, "targetInstanceRef", optionalText(r.target_instance_ref) as TargetInstanceRef | undefined);
}

interface RevisionRow {
  revision_id: string;
  agency_id: string;
  project_id: string;
  version: string;
  state: DatasetRevision["state"];
  manifest_hash: string | null;
  projection_hash: string | null;
  sealed_at: Date | null;
  supersedes_revision_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const REVISION_COLUMNS = "revision_id, agency_id, project_id, version, state, manifest_hash, projection_hash, sealed_at, supersedes_revision_id, created_at, updated_at";

function revisionRecord(r: RevisionRow): DatasetRevisionRecord {
  const base = {
    revisionId: r.revision_id as RevisionId,
    agencyId: r.agency_id as AgencyId,
    projectId: r.project_id as ProjectId,
    scope: { agencyId: r.agency_id, projectId: r.project_id },
    version: int(r.version),
    state: r.state,
    createdAt: instant(r.created_at),
    updatedAt: instant(r.updated_at),
  };
  const a = withOptional(base, "manifestHash", optionalText(r.manifest_hash));
  const b = withOptional(a, "projectionHash", optionalText(r.projection_hash));
  const c = withOptional(b, "sealedAt", optionalInstant(r.sealed_at));
  return withOptional(c, "supersedesRevisionId", optionalText(r.supersedes_revision_id) as RevisionId | undefined);
}

export class PgProjectRepository implements ProjectRepository {
  constructor(private readonly db: Queryable) {}

  async get(projectId: ProjectId): Promise<ProjectRecord | null> {
    const r = await execute<ProjectRow>(this.db, `SELECT ${PROJECT_COLUMNS} FROM kauro.projects WHERE project_id = $1`, [projectId]);
    return r.rows[0] ? projectRecord(r.rows[0]) : null;
  }

  async lock(projectId: ProjectId): Promise<ProjectRecord | null> {
    const r = await execute<ProjectRow>(this.db, `SELECT ${PROJECT_COLUMNS} FROM kauro.projects WHERE project_id = $1 FOR UPDATE`, [projectId]);
    return r.rows[0] ? projectRecord(r.rows[0]) : null;
  }

  /** Project first, revision second: the deferred FK projects_current_revision_fk is checked at commit (CMD011 effect). */
  async insertWithDraftRevision(project: NewProject): Promise<{ readonly project: ProjectRecord; readonly revision: DatasetRevisionRecord }> {
    const p = await execute<ProjectRow>(
      this.db,
      `INSERT INTO kauro.projects (project_id, agency_id, client_id, version, state, mode, purpose, target_instance_ref, capability_id, capability_version, current_revision_id, created_by_membership_id, created_at, updated_at)
       VALUES ($1, $2, $3, 1, 'OPEN', $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING ${PROJECT_COLUMNS}`,
      [project.projectId, project.agencyId, project.clientId, project.mode, project.purpose, project.targetInstanceRef ?? null, project.capabilityId, project.capabilityVersion, project.initialRevisionId, project.createdByMembershipId, project.createdAt],
    );
    const projectRow = p.rows[0];
    if (!projectRow) throw new DomainFailure("INTEGRITY_FAILURE", "project insert returned no row");
    const rv = await execute<RevisionRow>(
      this.db,
      `INSERT INTO kauro.dataset_revisions (revision_id, agency_id, project_id, version, state, created_at, updated_at)
       VALUES ($1, $2, $3, 1, 'DRAFT', $4, $4) RETURNING ${REVISION_COLUMNS}`,
      [project.initialRevisionId, project.agencyId, project.projectId, project.createdAt],
    );
    const revisionRow = rv.rows[0];
    if (!revisionRow) throw new DomainFailure("INTEGRITY_FAILURE", "dataset revision insert returned no row");
    return { project: projectRecord(projectRow), revision: revisionRecord(revisionRow) };
  }

  async transition(projectId: ProjectId, expectedVersion: number, change: { readonly state: ProjectState }, _now: UtcInstant): Promise<VersionedWrite<ProjectRecord>> {
    const r = await execute<ProjectRow>(
      this.db,
      `UPDATE kauro.projects SET state = $3, version = $2 + 1 WHERE project_id = $1 AND version = $2 RETURNING ${PROJECT_COLUMNS}`,
      [projectId, expectedVersion, change.state],
    );
    const row = r.rows[0];
    if (row) return { kind: "APPLIED", record: projectRecord(row) };
    return staleOrMissing(this.db, "projects", "project_id", projectId, "project");
  }
}

export class PgDatasetRevisionRepository implements DatasetRevisionRepository {
  constructor(private readonly db: Queryable) {}

  async get(revisionId: RevisionId): Promise<DatasetRevisionRecord | null> {
    const r = await execute<RevisionRow>(this.db, `SELECT ${REVISION_COLUMNS} FROM kauro.dataset_revisions WHERE revision_id = $1`, [revisionId]);
    return r.rows[0] ? revisionRecord(r.rows[0]) : null;
  }

  /**
   * FOR SHARE conflicts with the row lock any UPDATE takes, so a concurrent expiry or supersession of the revision waits for
   * this transaction; if it committed first, READ COMMITTED re-evaluates `state = 'SEALED'` on the committed row version and
   * the revision is not returned (the caller answers SOURCE_EXPIRED).
   */
  async lockSealedByHash(agencyId: AgencyId, revisionHash: Sha256Hex): Promise<DatasetRevisionRecord | null> {
    const r = await execute<RevisionRow>(
      this.db,
      `SELECT ${REVISION_COLUMNS} FROM kauro.dataset_revisions WHERE agency_id = $1 AND manifest_hash = $2 AND state = 'SEALED' FOR SHARE`,
      [agencyId, revisionHash],
    );
    return r.rows[0] ? revisionRecord(r.rows[0]) : null;
  }
}

// --- target contracts ---------------------------------------------------------------------------------------------------

interface ContractRow {
  contract_id: string;
  agency_id: string;
  project_id: string;
  mode: TargetContract["mode"];
  instance_id: string;
  importer_profile_id: string;
  importer_version: string;
  body_hash: string;
  observed_at: Date;
  confirmed_at: Date | null;
  authority_evidence_hash: string;
  capability_version: string;
  superseded_at: Date | null;
}

const CONTRACT_COLUMNS = "contract_id, agency_id, project_id, mode, instance_id, importer_profile_id, importer_version, body_hash, observed_at, confirmed_at, authority_evidence_hash, capability_version, superseded_at";

function contractRecord(r: ContractRow): TargetContractRecord {
  const base = {
    contractId: r.contract_id as TargetContractId,
    agencyId: r.agency_id as AgencyId,
    projectId: r.project_id as ProjectId,
    mode: r.mode,
    instanceId: r.instance_id,
    importerProfileId: r.importer_profile_id,
    importerVersion: r.importer_version,
    bodyHash: r.body_hash,
    observedAt: instant(r.observed_at),
    authorityEvidenceHash: r.authority_evidence_hash,
    capabilityVersion: r.capability_version,
  };
  const a = withOptional(base, "confirmedAt", optionalInstant(r.confirmed_at));
  return withOptional(a, "supersededAt", optionalInstant(r.superseded_at));
}

export class PgTargetContractRepository implements TargetContractRepository {
  constructor(private readonly db: Queryable) {}

  async get(contractId: TargetContractId): Promise<TargetContractRecord | null> {
    const r = await execute<ContractRow>(this.db, `SELECT ${CONTRACT_COLUMNS} FROM kauro.target_contracts WHERE contract_id = $1`, [contractId]);
    return r.rows[0] ? contractRecord(r.rows[0]) : null;
  }

  /**
   * FOR SHARE on the contract relied on: a concurrent supersession waits for this transaction; if it committed first, the
   * predicate `superseded_at IS NULL` is re-evaluated on the committed row version and the contract is not returned (the
   * caller answers TARGET_STALE).
   */
  async lockCurrentByHash(agencyId: AgencyId, targetContractHash: Sha256Hex): Promise<TargetContractRecord | null> {
    const r = await execute<ContractRow>(
      this.db,
      `SELECT ${CONTRACT_COLUMNS} FROM kauro.target_contracts WHERE agency_id = $1 AND body_hash = $2 AND confirmed_at IS NOT NULL AND superseded_at IS NULL ORDER BY observed_at DESC LIMIT 1 FOR SHARE`,
      [agencyId, targetContractHash],
    );
    return r.rows[0] ? contractRecord(r.rows[0]) : null;
  }
}

// --- capabilities (platform-wide; read by handlers, written by the control plane) ------------------------------------------

interface CapabilityRow {
  capability_id: string;
  version: string;
  kind: CapabilityRecord["kind"];
  mode: ServiceMode | null;
  state: Capability["state"];
  profile_hash: string;
  qualification_evidence_hashes: unknown;
  valid_from: Date | null;
  review_trigger: string;
}

const CAPABILITY_COLUMNS = "capability_id, version, kind, mode, state, profile_hash, qualification_evidence_hashes, valid_from, review_trigger";

function capabilityRecord(r: CapabilityRow): CapabilityRecord {
  const hashes = r.qualification_evidence_hashes;
  if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === "string")) throw new DomainFailure("INTEGRITY_FAILURE", "capability evidence column is not a list of hashes");
  const base = {
    capabilityId: r.capability_id as CapabilityId,
    version: r.version,
    kind: r.kind,
    state: r.state,
    profileHash: r.profile_hash,
    qualificationEvidenceHashes: hashes as string[],
    reviewTrigger: r.review_trigger,
  };
  const a = withOptional(base, "mode", r.mode ?? undefined);
  return withOptional(a, "validFrom", optionalInstant(r.valid_from));
}

export class PgCapabilityRepository implements CapabilityRepository {
  constructor(private readonly db: Queryable) {}

  async get(capabilityId: CapabilityId): Promise<CapabilityRecord | null> {
    const r = await execute<CapabilityRow>(this.db, `SELECT ${CAPABILITY_COLUMNS} FROM kauro.capabilities WHERE capability_id = $1`, [capabilityId]);
    return r.rows[0] ? capabilityRecord(r.rows[0]) : null;
  }

  /**
   * The offered capability of the mode when one is published (the partial unique index guarantees at most one), otherwise
   * the newest capability of the mode so the handler can name MODE_NOT_OFFERED against a real state; null when none exists.
   */
  async findMode(mode: ServiceMode): Promise<CapabilityRecord | null> {
    return this.selectMode(mode, "");
  }

  /**
   * findMode FOR SHARE (migration 0003 grants the runtime role the lock and nothing else: UPDATE on the immutable key column
   * under a policy whose WITH CHECK refuses every written row). A control-plane transition of the returned capability waits
   * for this transaction; if it committed first, the committed row version — its new state — is what comes back.
   */
  async lockMode(mode: ServiceMode): Promise<CapabilityRecord | null> {
    return this.selectMode(mode, " FOR SHARE");
  }

  private async selectMode(mode: ServiceMode, locking: "" | " FOR SHARE"): Promise<CapabilityRecord | null> {
    const r = await execute<CapabilityRow>(
      this.db,
      `SELECT ${CAPABILITY_COLUMNS} FROM kauro.capabilities WHERE kind = 'MODE' AND mode = $1
       ORDER BY (state IN ('AVAILABLE_LIMITED', 'AVAILABLE')) DESC, created_at DESC, capability_id DESC LIMIT 1${locking}`,
      [mode],
    );
    return r.rows[0] ? capabilityRecord(r.rows[0]) : null;
  }

  async list(filter: { readonly state?: Capability["state"] } = {}): Promise<ReadonlyArray<CapabilityRecord>> {
    const params: unknown[] = [];
    let where = "TRUE";
    if (filter.state !== undefined) {
      params.push(filter.state);
      where = "state = $1";
    }
    const r = await execute<CapabilityRow>(this.db, `SELECT ${CAPABILITY_COLUMNS} FROM kauro.capabilities WHERE ${where} ORDER BY kind, mode, created_at, capability_id`, params);
    return r.rows.map(capabilityRecord);
  }
}
