/**
 * Identity, agency, membership and security-event repositories over `pg` (07 "Aggregate ownership": Identity owns
 * authentication references and verification; Agency owns tenant identity, state and policy acceptance; Membership owns role,
 * invitation and revocation. 08 "Database isolation": every statement runs under the context the unit of work bound, so a row
 * of another tenant or another person is simply not there — reads return null, writes fail WITH CHECK).
 *
 * Versioned writes are compare-and-swap on `version` (10 "Concurrency and preconditions"): the UPDATE names the expected
 * version; zero rows means the row moved (STALE with the current safe version and state) or is not visible (NOT_FOUND).
 */
import type { Agency, Membership, Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  type ActorRef,
  type AgencyId,
  type AgencyRecord,
  type AgencyRepository,
  type AssuranceProof,
  type AssuranceProofId,
  type CorrelationId,
  type IdentityFacts,
  type IdentityRepository,
  type MembershipId,
  type MembershipRecord,
  type MembershipRepository,
  type NewAgency,
  type NewMembership,
  type SecurityEvent,
  type SecurityEventRepository,
  type UserId,
  type VersionedWrite,
  type IdGenerator,
} from "@kauro/domain";
import { execute, instant, int, optionalInstant, optionalText, text, withOptional, type Queryable } from "../sql.js";

// --- identities ----------------------------------------------------------------------------------------------------------

interface IdentityRow {
  user_id: string;
  state: "ACTIVE" | "DISABLED";
  email_verified_at: Date | null;
  mfa_enrolled_at: Date | null;
}

function identityFacts(r: IdentityRow): IdentityFacts {
  return {
    userId: r.user_id as UserId,
    state: r.state,
    emailVerifiedAt: r.email_verified_at === null ? null : instant(r.email_verified_at),
    mfaEnrolledAt: r.mfa_enrolled_at === null ? null : instant(r.mfa_enrolled_at),
  };
}

interface ProofRow {
  proof_id: string;
  user_id: string;
  kind: "STEP_UP";
  method: "TOTP" | "WEBAUTHN" | "IDP_REAUTH";
  issued_at: Date;
  expires_at: Date;
}

export class PgIdentityRepository implements IdentityRepository {
  constructor(private readonly db: Queryable) {}

  async getOwn(userId: UserId): Promise<IdentityFacts | null> {
    const r = await execute<IdentityRow>(this.db, "SELECT user_id, state, email_verified_at, mfa_enrolled_at FROM kauro.identities WHERE user_id = $1", [userId]);
    return r.rows[0] ? identityFacts(r.rows[0]) : null;
  }

  async syncOwn(facts: IdentityFacts, provider: string, subjectHash: Sha256Hex, now: UtcInstant): Promise<IdentityFacts> {
    const r = await execute<IdentityRow>(
      this.db,
      `INSERT INTO kauro.identities (user_id, provider, subject_hash, state, email_verified_at, mfa_enrolled_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, email_verified_at = EXCLUDED.email_verified_at, mfa_enrolled_at = EXCLUDED.mfa_enrolled_at
       RETURNING user_id, state, email_verified_at, mfa_enrolled_at`,
      [facts.userId, provider, subjectHash, facts.state, facts.emailVerifiedAt, facts.mfaEnrolledAt, now],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "identity sync returned no row");
    return identityFacts(row);
  }

  async getOwnProof(userId: UserId, proofId: AssuranceProofId): Promise<AssuranceProof | null> {
    const r = await execute<ProofRow>(this.db, "SELECT proof_id, user_id, kind, method, issued_at, expires_at FROM kauro.assurance_proofs WHERE user_id = $1 AND proof_id = $2", [userId, proofId]);
    const p = r.rows[0];
    if (!p) return null;
    return { proofId: p.proof_id as AssuranceProofId, userId: p.user_id as UserId, kind: p.kind, method: p.method, issuedAt: instant(p.issued_at), expiresAt: instant(p.expires_at) };
  }

  async recordProof(proof: AssuranceProof, correlationId: CorrelationId): Promise<void> {
    await execute(
      this.db,
      `INSERT INTO kauro.assurance_proofs (proof_id, user_id, kind, method, issued_at, expires_at, correlation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $5)`,
      [proof.proofId, proof.userId, proof.kind, proof.method, proof.issuedAt, proof.expiresAt, correlationId],
    );
  }
}

// --- agencies ------------------------------------------------------------------------------------------------------------

interface AgencyRow {
  agency_id: string;
  version: string;
  display_name: string;
  state: Agency["state"];
  legal_profile_ref: string | null;
  terms_version: string | null;
  privacy_agreement_version: string | null;
  first_qualifying_capture_id: string | null;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

const AGENCY_COLUMNS = "agency_id, version, display_name, state, legal_profile_ref, terms_version, privacy_agreement_version, first_qualifying_capture_id, created_by_user_id, created_at, updated_at";

function agencyRecord(r: AgencyRow): AgencyRecord {
  const base = {
    agencyId: r.agency_id as AgencyId,
    version: int(r.version),
    displayName: r.display_name,
    state: r.state,
    createdByUserId: r.created_by_user_id as UserId,
    createdAt: instant(r.created_at),
    updatedAt: instant(r.updated_at),
  };
  const a = withOptional(base, "legalProfileRef", optionalText(r.legal_profile_ref));
  const b = withOptional(a, "termsVersion", optionalText(r.terms_version));
  const c = withOptional(b, "privacyAgreementVersion", optionalText(r.privacy_agreement_version));
  return withOptional(c, "firstQualifyingCaptureId", optionalText(r.first_qualifying_capture_id));
}

/** Reads the current safe version and state of a row that a compare-and-swap missed (10: "returns the current safe version"). */
async function currentOf(db: Queryable, table: string, idColumn: string, id: string): Promise<{ version: number; state: string } | null> {
  const r = await execute<{ version: string; state: string }>(db, `SELECT version, state FROM kauro.${table} WHERE ${idColumn} = $1`, [id]);
  const row = r.rows[0];
  return row ? { version: int(row.version), state: row.state } : null;
}

export async function staleOrMissing(db: Queryable, table: string, idColumn: string, id: string, what: string): Promise<{ readonly kind: "STALE"; readonly currentVersion: number; readonly currentState: string }> {
  const current = await currentOf(db, table, idColumn, id);
  if (!current) throw new DomainFailure("NOT_FOUND", `${what} is not visible in this context`);
  return { kind: "STALE", currentVersion: current.version, currentState: current.state };
}

export class PgAgencyRepository implements AgencyRepository {
  constructor(private readonly db: Queryable) {}

  async get(agencyId: AgencyId): Promise<AgencyRecord | null> {
    const r = await execute<AgencyRow>(this.db, `SELECT ${AGENCY_COLUMNS} FROM kauro.agencies WHERE agency_id = $1`, [agencyId]);
    return r.rows[0] ? agencyRecord(r.rows[0]) : null;
  }

  async lock(agencyId: AgencyId): Promise<AgencyRecord | null> {
    const r = await execute<AgencyRow>(this.db, `SELECT ${AGENCY_COLUMNS} FROM kauro.agencies WHERE agency_id = $1 FOR UPDATE`, [agencyId]);
    return r.rows[0] ? agencyRecord(r.rows[0]) : null;
  }

  async insert(agency: NewAgency): Promise<AgencyRecord> {
    const r = await execute<AgencyRow>(
      this.db,
      `INSERT INTO kauro.agencies (agency_id, version, display_name, state, created_by_user_id, created_at, updated_at)
       VALUES ($1, 1, $2, 'DRAFT', $3, $4, $4) RETURNING ${AGENCY_COLUMNS}`,
      [agency.agencyId, agency.displayName, agency.createdByUserId, agency.createdAt],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "agency insert returned no row");
    return agencyRecord(row);
  }

  async transition(
    agencyId: AgencyId,
    expectedVersion: number,
    change: Partial<Pick<Agency, "state" | "termsVersion" | "privacyAgreementVersion" | "legalProfileRef" | "firstQualifyingCaptureId">>,
    _now: UtcInstant,
  ): Promise<VersionedWrite<AgencyRecord>> {
    const sets: string[] = ["version = $2 + 1"];
    const params: unknown[] = [agencyId, expectedVersion];
    const add = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (change.state !== undefined) add("state", change.state);
    if (change.termsVersion !== undefined) add("terms_version", change.termsVersion);
    if (change.privacyAgreementVersion !== undefined) add("privacy_agreement_version", change.privacyAgreementVersion);
    if (change.legalProfileRef !== undefined) add("legal_profile_ref", change.legalProfileRef);
    if (change.firstQualifyingCaptureId !== undefined) add("first_qualifying_capture_id", change.firstQualifyingCaptureId);
    const r = await execute<AgencyRow>(this.db, `UPDATE kauro.agencies SET ${sets.join(", ")} WHERE agency_id = $1 AND version = $2 RETURNING ${AGENCY_COLUMNS}`, params);
    const row = r.rows[0];
    if (row) return { kind: "APPLIED", record: agencyRecord(row) };
    return staleOrMissing(this.db, "agencies", "agency_id", agencyId, "agency");
  }

  async listOwnAgencies(userId: UserId): Promise<ReadonlyArray<Pick<AgencyRecord, "agencyId" | "displayName" | "state">>> {
    const r = await execute<{ agency_id: string; display_name: string; state: Agency["state"] }>(
      this.db,
      `SELECT a.agency_id, a.display_name, a.state FROM kauro.agencies a
       WHERE EXISTS (SELECT 1 FROM kauro.memberships m WHERE m.agency_id = a.agency_id AND m.user_id = $1 AND m.state IN ('ACTIVE', 'SUSPENDED'))
       ORDER BY a.created_at, a.agency_id`,
      [userId],
    );
    return r.rows.map((x) => ({ agencyId: x.agency_id as AgencyId, displayName: x.display_name, state: x.state }));
  }
}

// --- memberships -----------------------------------------------------------------------------------------------------------

interface MembershipRow {
  membership_id: string;
  agency_id: string;
  user_id: string;
  role: Membership["role"];
  state: Membership["state"];
  version: string;
  assurance_policy: string;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const MEMBERSHIP_COLUMNS = "membership_id, agency_id, user_id, role, state, version, assurance_policy, accepted_at, revoked_at, created_at, updated_at";

function membershipRecord(r: MembershipRow): MembershipRecord {
  const base = {
    membershipId: r.membership_id as MembershipId,
    agencyId: r.agency_id as AgencyId,
    userId: r.user_id as UserId,
    role: r.role,
    state: r.state,
    version: int(r.version),
    assurancePolicy: r.assurance_policy,
    createdAt: instant(r.created_at),
    updatedAt: instant(r.updated_at),
  };
  const a = withOptional(base, "acceptedAt", optionalInstant(r.accepted_at));
  return withOptional(a, "revokedAt", optionalInstant(r.revoked_at));
}

export class PgMembershipRepository implements MembershipRepository {
  constructor(private readonly db: Queryable) {}

  async get(membershipId: MembershipId): Promise<MembershipRecord | null> {
    const r = await execute<MembershipRow>(this.db, `SELECT ${MEMBERSHIP_COLUMNS} FROM kauro.memberships WHERE membership_id = $1`, [membershipId]);
    return r.rows[0] ? membershipRecord(r.rows[0]) : null;
  }

  async lock(membershipId: MembershipId): Promise<MembershipRecord | null> {
    const r = await execute<MembershipRow>(this.db, `SELECT ${MEMBERSHIP_COLUMNS} FROM kauro.memberships WHERE membership_id = $1 FOR UPDATE`, [membershipId]);
    return r.rows[0] ? membershipRecord(r.rows[0]) : null;
  }

  async findLive(agencyId: AgencyId, userId: UserId): Promise<MembershipRecord | null> {
    const r = await execute<MembershipRow>(
      this.db,
      `SELECT ${MEMBERSHIP_COLUMNS} FROM kauro.memberships WHERE agency_id = $1 AND user_id = $2 AND state IN ('INVITED', 'ACTIVE', 'SUSPENDED')`,
      [agencyId, userId],
    );
    return r.rows[0] ? membershipRecord(r.rows[0]) : null;
  }

  async listOwn(userId: UserId): Promise<ReadonlyArray<MembershipRecord>> {
    const r = await execute<MembershipRow>(this.db, `SELECT ${MEMBERSHIP_COLUMNS} FROM kauro.memberships WHERE user_id = $1 ORDER BY created_at, membership_id`, [userId]);
    return r.rows.map(membershipRecord);
  }

  async insert(membership: NewMembership): Promise<MembershipRecord> {
    const r = await execute<MembershipRow>(
      this.db,
      `INSERT INTO kauro.memberships (membership_id, agency_id, user_id, role, state, version, assurance_policy, accepted_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $8) RETURNING ${MEMBERSHIP_COLUMNS}`,
      [membership.membershipId, membership.agencyId, membership.userId, membership.role, membership.state, membership.assurancePolicy, membership.acceptedAt ?? null, membership.createdAt],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "membership insert returned no row");
    return membershipRecord(row);
  }

  async transition(
    membershipId: MembershipId,
    expectedVersion: number,
    change: Partial<Pick<Membership, "state" | "role" | "acceptedAt">> & { readonly revokedAt?: UtcInstant },
    _now: UtcInstant,
  ): Promise<VersionedWrite<MembershipRecord>> {
    const sets: string[] = ["version = $2 + 1"];
    const params: unknown[] = [membershipId, expectedVersion];
    const add = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (change.state !== undefined) add("state", change.state);
    if (change.role !== undefined) add("role", change.role);
    if (change.acceptedAt !== undefined) add("accepted_at", change.acceptedAt);
    if (change.revokedAt !== undefined) add("revoked_at", change.revokedAt);
    const r = await execute<MembershipRow>(this.db, `UPDATE kauro.memberships SET ${sets.join(", ")} WHERE membership_id = $1 AND version = $2 RETURNING ${MEMBERSHIP_COLUMNS}`, params);
    const row = r.rows[0];
    if (row) return { kind: "APPLIED", record: membershipRecord(row) };
    return staleOrMissing(this.db, "memberships", "membership_id", membershipId, "membership");
  }

  async countActiveOwners(agencyId: AgencyId): Promise<number> {
    const r = await execute<{ n: string }>(this.db, "SELECT count(*)::text AS n FROM kauro.memberships WHERE agency_id = $1 AND role = 'OWNER' AND state = 'ACTIVE'", [agencyId]);
    return int(text(r.rows[0]?.n));
  }
}

// --- security events ---------------------------------------------------------------------------------------------------

export function actorColumns(actor: ActorRef): { readonly kind: "USER" | "SERVICE" | "SYSTEM"; readonly id: string | null } {
  switch (actor.kind) {
    case "USER":
      return { kind: "USER", id: actor.userId };
    case "SERVICE":
      return { kind: "SERVICE", id: actor.serviceId };
    case "SYSTEM":
      return { kind: "SYSTEM", id: null };
  }
}

export class PgSecurityEventRepository implements SecurityEventRepository {
  constructor(
    private readonly db: Queryable,
    private readonly ids: IdGenerator,
  ) {}

  async append(event: SecurityEvent): Promise<void> {
    const actor = actorColumns(event.actor);
    await execute(
      this.db,
      `INSERT INTO kauro.security_events (security_event_id, agency_id, actor_kind, actor_id, action, outcome, reason_code, policy_version, assurance_class, correlation_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [this.ids.next(), event.agencyId, actor.kind, actor.id, event.action, event.outcome, event.reasonCode, event.policyVersion, event.assuranceClass, event.correlationId, event.occurredAt],
    );
  }
}
