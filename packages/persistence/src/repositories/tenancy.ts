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
  type IdentityFacts,
  type IdentityRepository,
  type InvitationClose,
  type InvitationId,
  type InvitationIssue,
  type InvitationRecord,
  type InvitationRepository,
  type MembershipId,
  type MembershipRecord,
  type MembershipRepository,
  type NewAgency,
  type NewMembership,
  type SecurityActor,
  type SecurityEvent,
  type SecurityEventRepository,
  type UserId,
  type VersionedWrite,
  type IdGenerator,
} from "@kauro/domain";
import { ConstraintViolation, execute, instant, int, optionalInstant, optionalText, text, withOptional, type Queryable } from "../sql.js";

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

/**
 * Takes the shared transition lock of a subject (decision D-TX-2, migration 0001 kauro.await_transition), held to COMMIT. The
 * caller reads the guarded row in its NEXT statement, which runs on a snapshot taken after the lock was granted: a transition
 * committed first is what it reads, one issued later waits for this unit of work, and a reader arriving after a queued
 * transition waits behind it (re-check finding N3). The kind is the guarded table's name, so a wait is visible by table in
 * pg_stat_activity.
 */
export async function awaitTransition(db: Queryable, kind: "kauro.identities" | "kauro.memberships" | "kauro.agencies" | "kauro.capabilities" | "kauro.dataset_revisions" | "kauro.target_contracts", subject: string): Promise<void> {
  await execute(db, `SELECT kauro.await_transition('${kind}', $1)`, [subject]);
}

export class PgIdentityRepository implements IdentityRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * The caller's stored identity facts, read after the identity's transition lock (D-TX-2): a disable committed first is read
   * here, and one issued while this unit of work runs waits for it (re-check finding N1).
   */
  async getOwn(userId: UserId): Promise<IdentityFacts | null> {
    await awaitTransition(this.db, "kauro.identities", userId);
    const r = await execute<IdentityRow>(this.db, "SELECT user_id, state, email_verified_at, mfa_enrolled_at FROM kauro.identities WHERE user_id = $1", [userId]);
    return r.rows[0] ? identityFacts(r.rows[0]) : null;
  }

  /**
   * Records the identity reference on first sight and keeps the token's verification facts current; never the security status
   * (re-check finding N1: the request-handler role holds no privilege on `state`, and a sync never re-enables a DISABLED row).
   * It never waits on the identity row: the command already holds the identity's shared transition lock (getOwn), and a
   * platform disable that holds the row while it waits for that lock must not wait on the command in turn. So the reference is
   * inserted only when no committed row exists (an insert waits only on another first sight, never on a disable), and the
   * verification facts are refreshed only when the row is free (SKIP LOCKED): they are copies of the token's facts, which the
   * authorizer decides by (D-ASSUR-2), and the next sync refreshes them.
   */
  async syncOwn(facts: IdentityFacts, provider: string, subjectHash: Sha256Hex, now: UtcInstant): Promise<IdentityFacts> {
    const known = await execute(this.db, "SELECT 1 FROM kauro.identities WHERE user_id = $1", [facts.userId]);
    if (known.rowCount === 0) {
      await execute(
        this.db,
        `INSERT INTO kauro.identities (user_id, provider, subject_hash, email_verified_at, mfa_enrolled_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (user_id) DO NOTHING`,
        [facts.userId, provider, subjectHash, facts.emailVerifiedAt, facts.mfaEnrolledAt, now],
      );
    }
    await execute(
      this.db,
      `UPDATE kauro.identities SET email_verified_at = $2, mfa_enrolled_at = $3
        WHERE user_id = (
          SELECT i.user_id FROM kauro.identities i
           WHERE i.user_id = $1 AND (i.email_verified_at IS DISTINCT FROM $2 OR i.mfa_enrolled_at IS DISTINCT FROM $3)
           FOR NO KEY UPDATE SKIP LOCKED
        )`,
      [facts.userId, facts.emailVerifiedAt, facts.mfaEnrolledAt],
    );
    const r = await execute<IdentityRow>(this.db, "SELECT user_id, state, email_verified_at, mfa_enrolled_at FROM kauro.identities WHERE user_id = $1", [facts.userId]);
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "identity sync left no visible row");
    return identityFacts(row);
  }

  async getOwnProof(userId: UserId, proofId: AssuranceProofId): Promise<AssuranceProof | null> {
    const r = await execute<ProofRow>(this.db, "SELECT proof_id, user_id, kind, method, issued_at, expires_at FROM kauro.assurance_proofs WHERE user_id = $1 AND proof_id = $2", [userId, proofId]);
    const p = r.rows[0];
    if (!p) return null;
    return { proofId: p.proof_id as AssuranceProofId, userId: p.user_id as UserId, kind: p.kind, method: p.method, issuedAt: instant(p.issued_at), expiresAt: instant(p.expires_at) };
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

  /**
   * The agency state a command relies on without changing the agency (CMD009, CMD011: DRAFT or ACTIVE), read after the agency's
   * transition lock (D-TX-2): a restriction or closure issued meanwhile waits for this unit of work, one committed first is read
   * here, and commands arriving after a queued transition wait behind it (re-check finding N3). No row lock is taken.
   */
  async lockShared(agencyId: AgencyId): Promise<AgencyRecord | null> {
    await awaitTransition(this.db, "kauro.agencies", agencyId);
    const r = await execute<AgencyRow>(this.db, `SELECT ${AGENCY_COLUMNS} FROM kauro.agencies WHERE agency_id = $1`, [agencyId]);
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

  /**
   * The caller's live membership, read after the transition lock of (agency, person) (D-TX-2), held until the unit of work
   * ends: a suspension, revocation or role change issued meanwhile waits for this command, one committed first is what this
   * read returns (a row that is no longer live is not returned), and a command arriving after a queued change waits behind it,
   * so a stream of overlapping commands can never starve a revocation (re-check finding N3). No row lock is taken.
   */
  async findLive(agencyId: AgencyId, userId: UserId): Promise<MembershipRecord | null> {
    await awaitTransition(this.db, "kauro.memberships", `${agencyId}:${userId}`);
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

// --- invitations ---------------------------------------------------------------------------------------------------------

interface InvitationRow {
  invitation_id: string;
  agency_id: string;
  membership_id: string;
  token_hash: string;
  role: Membership["role"];
  invited_by_membership_id: string;
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

const INVITATION_COLUMNS = "invitation_id, agency_id, membership_id, token_hash, role, invited_by_membership_id, expires_at, consumed_at, revoked_at, created_at";

function invitationRecord(r: InvitationRow): InvitationRecord {
  const base = {
    invitationId: r.invitation_id as InvitationId,
    agencyId: r.agency_id as AgencyId,
    membershipId: r.membership_id as MembershipId,
    tokenHash: r.token_hash,
    role: r.role,
    invitedByMembershipId: r.invited_by_membership_id as MembershipId,
    expiresAt: instant(r.expires_at),
    createdAt: instant(r.created_at),
  };
  const a = withOptional(base, "consumedAt", optionalInstant(r.consumed_at));
  return withOptional(a, "revokedAt", optionalInstant(r.revoked_at));
}

/**
 * Invitation tokens (08 "Invitation, recovery and ownership transfer": one-use, time-limited opaque tokens; stored token
 * material is hashed — only the digest of @kauro/domain hashInvitationToken is ever stored or compared). The database decides
 * who may issue, consume and revoke (migration 0002 kauro.enforce_invitation_rules, re-check finding N19): this adapter writes
 * under the unit of work's context and reports each outcome as a value, so a handler answers a closed invitation or a second
 * open one precisely instead of by a constraint name.
 */
export class PgInvitationRepository implements InvitationRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Issues an invitation under a savepoint: a second open invitation of the same membership (the partial unique index, which a
   * concurrent issuer waits on) is an outcome, OPEN_INVITATION_EXISTS, and the unit of work continues.
   */
  async insert(invitation: InvitationRecord): Promise<InvitationIssue> {
    await execute(this.db, "SAVEPOINT kauro_invitation_insert");
    try {
      const r = await execute<InvitationRow>(
        this.db,
        `INSERT INTO kauro.membership_invitations (invitation_id, agency_id, membership_id, token_hash, role, invited_by_membership_id, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${INVITATION_COLUMNS}`,
        [invitation.invitationId, invitation.agencyId, invitation.membershipId, invitation.tokenHash, invitation.role, invitation.invitedByMembershipId, invitation.expiresAt, invitation.createdAt],
      );
      await execute(this.db, "RELEASE SAVEPOINT kauro_invitation_insert");
      const row = r.rows[0];
      if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "invitation insert returned no row");
      return { kind: "ISSUED", invitation: invitationRecord(row) };
    } catch (e) {
      // one open invitation per membership (08: changing the role after sending invalidates or reissues the invite)
      if (e instanceof ConstraintViolation && e.constraint === "membership_invitations_one_per_membership") {
        await execute(this.db, "ROLLBACK TO SAVEPOINT kauro_invitation_insert");
        return { kind: "OPEN_INVITATION_EXISTS" };
      }
      throw e;
    }
  }

  async get(invitationId: InvitationId): Promise<InvitationRecord | null> {
    const r = await execute<InvitationRow>(this.db, `SELECT ${INVITATION_COLUMNS} FROM kauro.membership_invitations WHERE invitation_id = $1`, [invitationId]);
    return r.rows[0] ? invitationRecord(r.rows[0]) : null;
  }

  async findByTokenHash(tokenHash: Sha256Hex): Promise<InvitationRecord | null> {
    const r = await execute<InvitationRow>(this.db, `SELECT ${INVITATION_COLUMNS} FROM kauro.membership_invitations WHERE token_hash = $1`, [tokenHash]);
    return r.rows[0] ? invitationRecord(r.rows[0]) : null;
  }

  async consume(invitationId: InvitationId, now: UtcInstant): Promise<InvitationClose> {
    return this.close(invitationId, "consumed_at", now);
  }

  async revoke(invitationId: InvitationId, now: UtcInstant): Promise<InvitationClose> {
    return this.close(invitationId, "revoked_at", now);
  }

  /** Closes an open invitation once; a concurrent closer waits on the row and then finds it closed (ALREADY_CLOSED). */
  private async close(invitationId: InvitationId, column: "consumed_at" | "revoked_at", now: UtcInstant): Promise<InvitationClose> {
    const r = await execute<InvitationRow>(
      this.db,
      `UPDATE kauro.membership_invitations SET ${column} = $2 WHERE invitation_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING ${INVITATION_COLUMNS}`,
      [invitationId, now],
    );
    const row = r.rows[0];
    if (row) return { kind: "CLOSED", invitation: invitationRecord(row) };
    const current = await this.get(invitationId);
    if (!current) throw new DomainFailure("NOT_FOUND", "invitation is not visible in this context");
    return { kind: "ALREADY_CLOSED", invitation: current };
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

function securityActorColumns(actor: SecurityActor): { readonly kind: "USER" | "SERVICE" | "SYSTEM" | "ANONYMOUS"; readonly id: string | null } {
  return actor.kind === "ANONYMOUS" ? { kind: "ANONYMOUS", id: null } : actorColumns(actor);
}

/**
 * Appends a security fact. Which stream it may enter is the policy's decision (migration 0007): an agency's stream only for a
 * caller holding a live membership there, the caller's own identity stream, or the anonymous denial — anything else is refused
 * by WITH CHECK, whatever the application asked.
 */
export class PgSecurityEventRepository implements SecurityEventRepository {
  constructor(
    private readonly db: Queryable,
    private readonly ids: IdGenerator,
  ) {}

  async append(event: SecurityEvent): Promise<void> {
    const actor = securityActorColumns(event.actor);
    await execute(
      this.db,
      `INSERT INTO kauro.security_events (security_event_id, agency_id, requested_agency_id, actor_kind, actor_id, action, outcome, reason_code, policy_version, assurance_class, correlation_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [this.ids.next(), event.agencyId, event.requestedAgencyId, actor.kind, actor.id, event.action, event.outcome, event.reasonCode, event.policyVersion, event.assuranceClass, event.correlationId, event.occurredAt],
    );
  }
}
