// Test harness for the adapters (07 "Acceptance obligations": real PostgreSQL for tenant constraints, transactions,
// migrations and concurrency; 21 "Independent oracles": the superuser oracle sees every tenant, the runtime pools see every
// policy). start() runs initdb + pg_ctl on a free 127.0.0.1 port, creates the owner role and the runtime login roles
// (NOSUPERUSER, NOBYPASSRLS), applies the migrations as the owner, and opens one verified pool per runtime group with a
// unit-of-work factory on each. Every fixture below is written through the adapters under a real context, so the fixtures
// themselves prove the policies admit legitimate writes (21 "Positive and negative symmetry").
import { randomBytes, createHash } from "node:crypto";
import type { Client } from "pg";
import {
  createIdGenerator,
  identityUserId,
  toUtcInstant,
  type AgencyId,
  type CausationId,
  type ClientId,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type IdentityContext,
  type MembershipId,
  type MembershipRole,
  type ProcessingAuthorityId,
  type SystemContext,
  type TenantContext,
  type UserId,
} from "@kauro/domain";
import { createPool, createUnitOfWorkFactory, startTemporaryPostgres, ROLES, type KauroPool, type PgUnitOfWorkFactory, type TemporaryPostgres } from "../src/index.js";

export const clock: Clock = { now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() };
export const ids: IdGenerator = createIdGenerator(clock, (n) => new Uint8Array(randomBytes(n)));

export function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function correlation(): CorrelationId {
  return ids.next() as CorrelationId;
}

export interface AgencyFixture {
  readonly agencyId: AgencyId;
  readonly ownerUserId: UserId;
  readonly ownerMembershipId: MembershipId;
}

export interface Harness {
  readonly pg: TemporaryPostgres;
  /** Request-handler pool (login role in kauro_app) and its unit-of-work factory. */
  readonly appPool: KauroPool;
  readonly app: PgUnitOfWorkFactory;
  /** Control-plane pool (login role in kauro_control) and its unit-of-work factory. */
  readonly controlPool: KauroPool;
  readonly control: PgUnitOfWorkFactory;
  /** Superuser connection: bypasses RLS, sees every tenant; assertions only, never a write path under test. */
  readonly oracle: Client;
  tenant(agencyId: AgencyId, userId: UserId): TenantContext;
  identity(userId: UserId): IdentityContext;
  system(serviceId?: string): SystemContext;
  /** Syncs an identity (verified email + MFA unless told otherwise) under its own context. */
  person(subject: string, verified?: boolean): Promise<UserId>;
  /** CreateAgency as the handler performs it: IDENTITY context, adoptTenant, agency + owner membership + events + journal. */
  createAgency(ownerUserId: UserId, displayName?: string): Promise<AgencyFixture>;
  /** An ACTIVE member with the given role, written by the owner inside the tenant context. */
  addMember(agency: AgencyFixture, userId: UserId, role: MembershipRole): Promise<MembershipId>;
  processingAuthority(agency: AgencyFixture): Promise<ProcessingAuthorityId>;
  endClient(agency: AgencyFixture, authority: ProcessingAuthorityId, displayName?: string): Promise<ClientId>;
  /** Publishes a MODE capability as the control plane (a CMD058 fixture; no port exists for it in B06). */
  offeredCapability(mode: "CLEAN" | "HUBSPOT" | "SALESFORCE", state?: string): Promise<string>;
  stop(): Promise<void>;
}

export async function start(): Promise<Harness> {
  const pg = await startTemporaryPostgres();
  const base = { host: "127.0.0.1", port: pg.port, database: ROLES.database, max: 4 } as const;
  const appPool = createPool({ ...base, user: ROLES.appLogin, applicationName: "kauro-test-api" });
  const controlPool = createPool({ ...base, user: ROLES.controlLogin, applicationName: "kauro-test-control" });
  const app = createUnitOfWorkFactory(appPool, { clock });
  const control = createUnitOfWorkFactory(controlPool, { clock });
  const oracle = await pg.connect("postgres");
  const controlClient = await pg.connect("kauro_control_test");

  const h: Harness = {
    pg,
    appPool,
    app,
    controlPool,
    control,
    oracle,
    tenant: (agencyId, userId) => ({ kind: "TENANT", agencyId, userId, correlationId: correlation() }),
    identity: (userId) => ({ kind: "IDENTITY", userId, correlationId: correlation() }),
    system: (serviceId = "control-plane") => ({ kind: "SYSTEM", serviceId, correlationId: correlation() }),

    async person(subject, verified = true) {
      const userId = identityUserId("identity-platform", subject);
      const verifiedAt = verified ? clock.now() : null;
      await app.run(h.identity(userId), async (uow) => {
        await uow.identities.syncOwn({ userId, state: "ACTIVE", emailVerifiedAt: verifiedAt, mfaEnrolledAt: verifiedAt }, "identity-platform", sha(subject), clock.now());
      });
      return userId;
    },

    async createAgency(ownerUserId, displayName = "Acme Agency") {
      const context = h.identity(ownerUserId);
      return app.run(context, async (uow) => {
        const reservation = await uow.journal.reserve(
          { environment: "LOCAL", actor: { kind: "USER", userId: ownerUserId }, agencyId: null, operation: "CMD001", key: `fixture_${ids.next().replace(/-/g, "")}` },
          sha(displayName),
          context.correlationId,
        );
        if (reservation.kind !== "RESERVED") throw new Error("fixture reservation was not RESERVED");
        const agencyId = uow.ids.next() as AgencyId;
        const membershipId = uow.ids.next() as MembershipId;
        await uow.adoptTenant(agencyId);
        const now = clock.now();
        const agency = await uow.agencies.insert({ agencyId, displayName, createdByUserId: ownerUserId, createdAt: now });
        const membership = await uow.memberships.insert({ membershipId, agencyId, userId: ownerUserId, role: "OWNER", state: "ACTIVE", assurancePolicy: "MFA_REQUIRED", acceptedAt: now, createdAt: now });
        const actor = { kind: "USER", userId: ownerUserId } as const;
        await uow.events.publish({ aggregateKind: "agency", aggregateId: agencyId, aggregateVersion: 1, agencyId, eventType: "agency.created.v1", actor, causationId: reservation.entryId as unknown as CausationId, correlationId: context.correlationId, payload: { agencyId, createdByUserId: ownerUserId, state: "DRAFT" } });
        await uow.events.publish({ aggregateKind: "membership", aggregateId: membershipId, aggregateVersion: 1, agencyId, eventType: "membership.created.v1", actor, causationId: reservation.entryId as unknown as CausationId, correlationId: context.correlationId, payload: { membershipId, agencyId, userId: ownerUserId, role: "OWNER", state: "ACTIVE" } });
        await uow.journal.commit(reservation.entryId, { responseStatus: 201, responseBody: { agency, membership }, resourceKind: "agency", resourceId: agencyId });
        return { agencyId, ownerUserId, ownerMembershipId: membershipId };
      });
    },

    async addMember(agency, userId, role) {
      return app.run(h.tenant(agency.agencyId, agency.ownerUserId), async (uow) => {
        const membershipId = uow.ids.next() as MembershipId;
        const now = clock.now();
        await uow.memberships.insert({ membershipId, agencyId: agency.agencyId, userId, role, state: "ACTIVE", assurancePolicy: "MFA_REQUIRED", acceptedAt: now, createdAt: now });
        await uow.events.publish({ aggregateKind: "membership", aggregateId: membershipId, aggregateVersion: 1, agencyId: agency.agencyId, eventType: "membership.created.v1", actor: { kind: "USER", userId: agency.ownerUserId }, causationId: correlation() as unknown as CausationId, correlationId: uow.context.correlationId, payload: { membershipId, agencyId: agency.agencyId, userId, role, state: "ACTIVE" } });
        return membershipId;
      });
    },

    async processingAuthority(agency) {
      return app.run(h.tenant(agency.agencyId, agency.ownerUserId), async (uow) => {
        const id = uow.ids.next() as ProcessingAuthorityId;
        await uow.processingAuthorities.insert({ processingAuthorityId: id, agencyId: agency.agencyId, kind: "CLIENT_AUTHORIZATION", evidenceHash: sha("dpa-" + id), recordedByMembershipId: agency.ownerMembershipId, recordedAt: clock.now() });
        return id;
      });
    },

    async endClient(agency, authority, displayName = "Client One") {
      return app.run(h.tenant(agency.agencyId, agency.ownerUserId), async (uow) => {
        const clientId = uow.ids.next() as ClientId;
        await uow.endClients.insert({ clientId, agencyId: agency.agencyId, displayName, processingAuthorityRef: authority, createdByMembershipId: agency.ownerMembershipId, createdAt: clock.now() });
        await uow.events.publish({ aggregateKind: "end_client", aggregateId: clientId, aggregateVersion: 1, agencyId: agency.agencyId, eventType: "end_client.created.v1", actor: { kind: "USER", userId: agency.ownerUserId }, causationId: correlation() as unknown as CausationId, correlationId: uow.context.correlationId, payload: { clientId, agencyId: agency.agencyId, processingAuthorityRef: authority, createdByMembershipId: agency.ownerMembershipId } });
        return clientId;
      });
    },

    async offeredCapability(mode, state = "AVAILABLE_LIMITED") {
      const id = ids.next();
      const evidence = state === "DESIGN" || state === "IMPLEMENTED_UNACCEPTED" ? [] : [sha("evidence-" + mode)];
      await controlClient.query(
        `INSERT INTO kauro.capabilities (capability_id, version, kind, mode, state, profile_hash, qualification_evidence_hashes, review_trigger, created_at, updated_at)
         VALUES ($1, 'R2-INITIAL', 'MODE', $2, $3, $4, $5, 'VENDOR_OR_ENVELOPE_CHANGE', now(), now())`,
        [id, mode, state, sha("profile-" + mode), JSON.stringify(evidence)],
      );
      return id;
    },

    async stop() {
      await controlClient.end();
      await oracle.end();
      await appPool.end();
      await controlPool.end();
      await pg.stop();
    },
  };
  return h;
}

/**
 * Waits until a backend of `applicationName` whose current query contains `queryFragment` is blocked on a lock
 * (pg_stat_activity), which fixes the interleaving of two units of work deterministically (21 "Concurrency and crash matrix").
 */
export async function waitForLockWait(oracle: Client, applicationName: string, queryFragment: string): Promise<number> {
  for (let i = 0; i < 400; i++) {
    const r = await oracle.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND query LIKE '%' || $2 || '%'",
      [applicationName, queryFragment],
    );
    const pid = r.rows[0]?.pid;
    if (pid !== undefined) return pid;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`no backend of ${applicationName} waited on a lock while running ${queryFragment}`);
}

/** A one-shot barrier two units of work use to fix their interleaving. */
export function barrier(): { readonly wait: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}
