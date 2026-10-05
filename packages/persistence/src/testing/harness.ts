/**
 * Test harness over a real PostgreSQL 17 (07 "Acceptance obligations": real PostgreSQL for tenant constraints, transactions,
 * migrations and concurrency; 21 "Independent oracles": the superuser oracle sees every tenant, the runtime pools see every
 * policy). start() runs initdb + pg_ctl on a free 127.0.0.1 port, creates the owner role and the runtime login roles
 * (NOSUPERUSER, NOBYPASSRLS), applies the migrations as the owner, and opens one verified pool per runtime group: a
 * unit-of-work factory on the request-handler and control pools, and the evidence recorders on the step-up verifier and
 * validator pools. Every fixture below is written through the adapters (or, where no adapter exists yet, raw SQL) as the
 * role that owns the write, under a real context, so the fixtures themselves prove the policies admit legitimate writes (21
 * "Positive and negative symmetry"). Aggregates are born in their machine's initial state and reach later states through the
 * listed edges, one version and one event per edge; step-up proofs and validation receipts are recorded by their producers,
 * never by the request-handler role. It is exported (like startTemporaryPostgres) so the entrypoint packages run their
 * acceptance cases against the same cluster discipline; it is never wired into a deployment.
 */
import { randomBytes, createHash } from "node:crypto";
import type { Client, PoolClient } from "pg";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  createIdGenerator,
  hashInvitationToken,
  identityUserId,
  mintInvitationToken,
  toUtcInstant,
  type AgencyId,
  type AssuranceMethod,
  type AssuranceProofId,
  type CausationId,
  type ClientId,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type IdentityContext,
  type OperatorContext,
  type ServiceContext,
  type InvitationId,
  type MembershipId,
  type MembershipRole,
  type ProcessingAuthorityId,
  type ProjectId,
  type RevisionId,
  type SystemContext,
  type TenantContext,
  type FiscalIssuerRef,
  type UserId,
  type ValidationReceiptRecord,
} from "@kauro/domain";
import { PgAssuranceProofRecorder, PgValidationReceiptRecorder } from "../evidence.js";
import { PgInboxIngress } from "../inbox-outbox.js";
import { PgEventPublisher } from "../event-publisher.js";
import { createPool, type KauroPool } from "../pool.js";
import { createAuditUnitOfWorkFactory, createCommerceUnitOfWorkFactory, createExecutionUnitOfWorkFactory, createUnitOfWorkFactory, type PgAuditUnitOfWorkFactory, type PgCommerceUnitOfWorkFactory, type PgExecutionUnitOfWorkFactory, type PgUnitOfWorkFactory } from "../unit-of-work.js";
import { grantCorporateRole, recordQualifiedFiscalIssuer, recordQualifiedPaymentRoute, revokeCorporateRole, type QualifiedRoute } from "./commerce-fixtures.js";
import { clockAt, expireSealedRevision, sealSourceRevision } from "./source-lifecycle.js";
import { ROLES, startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";
import { serverNow } from "./server-now.js";

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
  /** Step-up verifier pool (login role in kauro_assurance): the only writer of step-up proofs. */
  readonly assurancePool: KauroPool;
  /** Validator pool (login role in kauro_validator): the only writer of validation receipts. */
  readonly validatorPool: KauroPool;
  /** Provider-ingress pool (login role in kauro_ingress): the only writer of inbox records (re-check finding N2). */
  readonly ingressPool: KauroPool;
  /** The inbox ingress over the ingress pool (CMD030's recorder; package B09 binds it to the webhook route). */
  readonly inboxIngress: PgInboxIngress;
  /** Payment-service pool (login role in kauro_payment; package B09, D-CTX-B1) and its unit-of-work factory: SERVICE contexts only. */
  readonly paymentPool: KauroPool;
  readonly payment: PgUnitOfWorkFactory;
  /**
   * The commerce unit-of-work factory of package B09 (CommerceUnitOfWorkFactory): TENANT and OPERATOR contexts on the request-handler
   * pool, SERVICE contexts on the payment-service pool, each unit of work with the commerce repositories and scope adoption.
   */
  readonly commerce: PgCommerceUnitOfWorkFactory;
  /**
   * Commission-service pool (login role in kauro_commission; package B10, D10-CTX-1): the verified group of the COMMISSIONS consumer,
   * the sweeps and CMD051/CMD053, which acts on one adopted agency per transaction or on corporate records. Its unit of work is the
   * commercial unit-of-work factory of the stage-2 lanes; the schema tests use the pool's login directly.
   */
  readonly commissionPool: KauroPool;
  /**
   * The execution unit-of-work factory of package B08 (ExecutionUnitOfWorkFactory; D8-XPKG-10): the commerce factory's routing with
   * the control plane's pool too — TENANT on the request handlers', SYSTEM on the control plane's, SERVICE on the payment service's
   * — each unit of work with the execution store (execution-fixtures.ts).
   */
  readonly execution: PgExecutionUnitOfWorkFactory;
  /**
   * The audit unit-of-work factory of package B08 (AuditUnitOfWorkFactory; mandate B08-PERSISTENCE-AUDIT): the execution factory's
   * routing, each unit of work with the audit store as well (audit-fixtures.ts).
   */
  readonly audit: PgAuditUnitOfWorkFactory;
  /** Superuser connection: bypasses RLS, sees every tenant; assertions only, never a write path under test. */
  readonly oracle: Client;
  tenant(agencyId: AgencyId, userId: UserId): TenantContext;
  identity(userId: UserId): IdentityContext;
  system(serviceId?: string): SystemContext;
  /** A verified service identity of the payment boundary (package B09): runs under kauro_payment and binds no agency until it adopts one. */
  service(serviceId?: string): ServiceContext;
  /** A corporate person acting under a corporate role (package B09, D-CTX-B2): runs under kauro_app with its own user bound. */
  operator(userId: UserId): OperatorContext;
  /** Syncs an identity (verified email + MFA unless told otherwise) under its own context. */
  person(subject: string, verified?: boolean): Promise<UserId>;
  /** CreateAgency as the handler performs it: IDENTITY context, adoptTenant, agency + owner membership + events + journal. */
  createAgency(ownerUserId: UserId, displayName?: string): Promise<AgencyFixture>;
  /**
   * An ACTIVE member with the given role, walked along the registry Membership machine: the owner invites (INVITED v1,
   * membership.invited.v1) and the intended identity accepts under its own tenant context (intended_identity_accepts: ACTIVE
   * v2, membership.accepted.v1). A membership is never born ACTIVE except the founding owner (migration 0002).
   */
  addMember(agency: AgencyFixture, userId: UserId, role: MembershipRole): Promise<MembershipId>;
  /**
   * An invitation not yet accepted (CMD003 as its handler will write it): the owner inserts the INVITED membership (v1,
   * membership.invited.v1) and issues the hashed single-use invitation of the same role through the invitation port, expiring in
   * seven days. addMember is this plus the intended identity's consumption and acceptance.
   */
  inviteMember(agency: AgencyFixture, userId: UserId, role: MembershipRole): Promise<{ readonly membershipId: MembershipId; readonly invitationId: InvitationId; readonly tokenHash: Sha256Hex }>;
  /**
   * A step-up proof recorded by the step-up verifier (kauro_assurance; 08 "Authentication and assurance"), issued at `issuedAt`
   * (default one second before the database clock) and valid for fifteen minutes. The request-handler role cannot write proofs.
   */
  recordStepUp(userId: UserId, options?: { readonly issuedAt?: UtcInstant; readonly method?: AssuranceMethod }): Promise<AssuranceProofId>;
  /**
   * A validation receipt recorded by the validator (kauro_validator; registry ValidationReceipt producer "MC validator") under the
   * tenant context of the plan it validated. The plan must exist with the receipt's subjects; the request-handler role cannot
   * write receipts.
   */
  recordValidationReceipt(receipt: ValidationReceiptRecord): Promise<void>;
  /**
   * A dataset revision of `projectId` sealed through the B07 source lifecycle (source-lifecycle.ts: reservation, completion,
   * inspection and admission, selection, evaluation, seal with its manifest and retention record; each write under the runtime
   * role that owns it) — upload_reserved → all_uploads_completed → all_selected_inputs_admitted → seal_command — or on to
   * EXPIRED by the retention sweeper (retention_expires), one version and one event per edge. The project's pristine current
   * revision is sealed first; later calls seal a further revision beside it. Sealed fifteen days ago, so a test may expire it —
   * unless `options.base` names when the intake began (the commercial packages seal recently: a quote promises no more source than
   * the retention its seal left, B09 quotes_source_binding; the B07+B09 merge). The manifest hash is the revision's source hash
   * (plans_source_fk).
   */
  sealedRevision(agency: AgencyFixture, projectId: ProjectId, state?: "SEALED" | "EXPIRED", options?: { readonly base?: Date; readonly billableSourceUnits?: number }): Promise<{ readonly revisionId: RevisionId; readonly revisionHash: Sha256Hex; readonly version: number }>;
  /**
   * The retention sweeper's retention_expires of a SEALED revision (source-lifecycle.ts expireSealedRevision: its governing records
   * past their effective deadline expire, then SEALED -> EXPIRED), in one control-plane transaction bound to the agency whose labelled
   * TEST CLOCK stands at `at` (default: fifteen days ahead, past the UNPAID hard cap of any recent seal). Returns the new version.
   */
  expireRevision(agency: AgencyFixture, projectId: ProjectId, revisionId: RevisionId, at?: Date): Promise<number>;
  processingAuthority(agency: AgencyFixture): Promise<ProcessingAuthorityId>;
  endClient(agency: AgencyFixture, authority: ProcessingAuthorityId, displayName?: string): Promise<ClientId>;
  /**
   * A MODE capability as the control plane records it (a CMD058 fixture; no port exists for it in B06): the row of the given
   * revision is born DESIGN — the initial state of the registry Capability machine — and reaches `state` only through
   * publishCapability, one listed edge at a time. Nothing is inserted directly in a qualified or offered state (D-CAP-2).
   */
  offeredCapability(mode: "CLEAN" | "HUBSPOT" | "SALESFORCE", state?: CapabilityPublicationState, options?: { readonly version?: string }): Promise<string>;
  /**
   * Publishes an existing capability as the control plane: walks the listed edges of the Capability machine from the row's
   * current state to `state` in one control-plane transaction, recording each gate's evidence with its edge (D-CAP-2).
   */
  publishCapability(capabilityId: string, state: Exclude<CapabilityPublicationState, "DESIGN">): Promise<void>;
  /** A QUALIFIED merchant route of a provider and environment, as the control plane configures it (package B09; commerce-fixtures). */
  qualifiedPaymentRoute(options?: Parameters<typeof recordQualifiedPaymentRoute>[1]): Promise<QualifiedRoute>;
  /** A QUALIFIED fiscal issuer route (package B09; commerce-fixtures). */
  qualifiedFiscalIssuer(options?: Parameters<typeof recordQualifiedFiscalIssuer>[1]): Promise<FiscalIssuerRef>;
  /** An ACTIVE KAURO_OWNER grant of a corporate identity, provisioned by the control plane (package B09, D-CORP-B1). */
  grantKauroOwner(userId: UserId): Promise<string>;
  /** Revokes a corporate grant (grant_revoked). */
  revokeCorporateGrant(grantId: string): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The forward path of the registry Capability machine (02 "Capability publication contract"; registry state_transitions
 * "Capability"): DESIGN -implementation_observed-> IMPLEMENTED_UNACCEPTED -internal_qualification_accepted-> QUALIFIED_INTERNAL
 * -limited_production_gates_accepted-> AVAILABLE_LIMITED -operating_maturity_accepted-> AVAILABLE. SUSPENDED is terminal in
 * this version and is not a publication.
 */
export const CAPABILITY_PUBLICATION_PATH = ["DESIGN", "IMPLEMENTED_UNACCEPTED", "QUALIFIED_INTERNAL", "AVAILABLE_LIMITED", "AVAILABLE"] as const;
export type CapabilityPublicationState = (typeof CAPABILITY_PUBLICATION_PATH)[number];

/**
 * The evidence a listed edge's guard names, recorded with the edge: QUALIFIED_INTERNAL "Required exact-subject semantic/
 * privacy/resource evidence passes"; AVAILABLE_LIMITED "Business, payment, fiscal, delivery, support and production acceptance
 * hold"; AVAILABLE "Actual customer/recurrence/support coverage meets the defined maturity gate". IMPLEMENTED_UNACCEPTED
 * ("Exact code/contract exists") cites no acceptance evidence: it permits local review but no sale.
 */
const EDGE_EVIDENCE: Readonly<Partial<Record<CapabilityPublicationState, string>>> = Object.freeze({
  QUALIFIED_INTERNAL: "internal-qualification",
  AVAILABLE_LIMITED: "limited-production-acceptance",
  AVAILABLE: "operating-maturity",
});

export async function start(): Promise<Harness> {
  const pg = await startTemporaryPostgres();
  const base = { host: "127.0.0.1", port: pg.port, database: ROLES.database, max: 4 } as const;
  const appPool = createPool({ ...base, user: ROLES.appLogin, applicationName: "kauro-test-api" });
  const controlPool = createPool({ ...base, user: ROLES.controlLogin, applicationName: "kauro-test-control" });
  const assurancePool = createPool({ ...base, max: 2, user: ROLES.assuranceLogin, applicationName: "kauro-test-assurance" });
  const validatorPool = createPool({ ...base, max: 2, user: ROLES.validatorLogin, applicationName: "kauro-test-validator" });
  const ingressPool = createPool({ ...base, max: 2, user: ROLES.ingressLogin, applicationName: "kauro-test-ingress" });
  const paymentPool = createPool({ ...base, max: 2, user: ROLES.paymentLogin, applicationName: "kauro-test-payment" });
  const commissionPool = createPool({ ...base, max: 2, user: ROLES.commissionLogin, applicationName: "kauro-test-commission" });
  const inboxIngress = new PgInboxIngress(ingressPool, () => ids.next());
  const app = createUnitOfWorkFactory(appPool, { clock });
  const control = createUnitOfWorkFactory(controlPool, { clock });
  const payment = createUnitOfWorkFactory(paymentPool, { clock });
  const commerce = createCommerceUnitOfWorkFactory({ app: appPool, payment: paymentPool }, { clock });
  const execution = createExecutionUnitOfWorkFactory({ app: appPool, payment: paymentPool, control: controlPool }, { clock });
  const audit = createAuditUnitOfWorkFactory({ app: appPool, payment: paymentPool, control: controlPool }, { clock });
  const proofs = new PgAssuranceProofRecorder(assurancePool);
  const receipts = new PgValidationReceiptRecorder(validatorPool);
  const oracle = await pg.connect("postgres");
  const controlClient = await pg.connect("kauro_control_test");

  /** Raw statements as the request-handler role under a tenant context, for aggregates whose transitions have no adapter yet. */
  const asTenant = async <T>(agencyId: AgencyId, userId: UserId, fn: (c: PoolClient, events: PgEventPublisher) => Promise<T>): Promise<T> => {
    const c = await appPool.raw.connect();
    let destroy: Error | undefined;
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [agencyId, userId]);
      const out = await fn(c, new PgEventPublisher(c, ids, clock));
      await c.query("COMMIT");
      return out;
    } catch (e) {
      try {
        await c.query("ROLLBACK");
      } catch (rollbackError) {
        destroy = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw e;
    } finally {
      c.release(destroy);
    }
  };

  /** Raw statements as the control plane bound to one agency (design B07 D-CTRL-1), for the source-lifecycle fixture. */
  const asControlFor = async <T>(agencyId: AgencyId, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await controlPool.raw.connect();
    let destroy: Error | undefined;
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true)", [agencyId]);
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      try {
        await c.query("ROLLBACK");
      } catch (rollbackError) {
        destroy = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw e;
    } finally {
      c.release(destroy);
    }
  };

  const h: Harness = {
    pg,
    appPool,
    app,
    controlPool,
    control,
    assurancePool,
    validatorPool,
    ingressPool,
    inboxIngress,
    paymentPool,
    payment,
    commerce,
    commissionPool,
    execution,
    audit,
    oracle,
    tenant: (agencyId, userId) => ({ kind: "TENANT", agencyId, userId, correlationId: correlation() }),
    identity: (userId) => ({ kind: "IDENTITY", userId, correlationId: correlation() }),
    system: (serviceId = "control-plane") => ({ kind: "SYSTEM", serviceId, correlationId: correlation() }),
    service: (serviceId = "payment-service") => ({ kind: "SERVICE", serviceId, correlationId: correlation() }),
    operator: (userId) => ({ kind: "OPERATOR", userId, correlationId: correlation() }),

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

    async inviteMember(agency, userId, role) {
      return app.run(h.tenant(agency.agencyId, agency.ownerUserId), async (uow) => {
        const id = uow.ids.next() as MembershipId;
        const invitationId = uow.ids.next() as InvitationId;
        const tokenHash = hashInvitationToken(mintInvitationToken((n) => new Uint8Array(randomBytes(n))));
        const now = clock.now();
        const invited = await uow.memberships.insert({ membershipId: id, agencyId: agency.agencyId, userId, role, state: "INVITED", assurancePolicy: "MFA_REQUIRED", createdAt: now });
        await uow.events.publish({ aggregateKind: "membership", aggregateId: id, aggregateVersion: invited.version, agencyId: agency.agencyId, eventType: "membership.invited.v1", actor: { kind: "USER", userId: agency.ownerUserId }, causationId: correlation() as unknown as CausationId, correlationId: uow.context.correlationId, payload: { membershipId: id, agencyId: agency.agencyId, role, invitedByMembershipId: agency.ownerMembershipId } });
        const issued = await uow.invitations.insert({ invitationId, agencyId: agency.agencyId, membershipId: id, tokenHash, role, invitedByMembershipId: agency.ownerMembershipId, expiresAt: toUtcInstant(Date.parse(now) + 7 * 86_400_000), createdAt: now });
        if (issued.kind !== "ISSUED") throw new Error(`membership ${id} already had an open invitation`);
        return { membershipId: id, invitationId, tokenHash };
      });
    },

    async addMember(agency, userId, role) {
      const { membershipId, invitationId } = await h.inviteMember(agency, userId, role);
      await app.run(h.tenant(agency.agencyId, userId), async (uow) => {
        const now = clock.now();
        const consumed = await uow.invitations.consume(invitationId, now);
        if (consumed.kind !== "CLOSED") throw new Error(`invitation ${invitationId} was already closed`);
        const accepted = await uow.memberships.transition(membershipId, 1, { state: "ACTIVE", acceptedAt: now }, now);
        if (accepted.kind !== "APPLIED") throw new Error(`membership ${membershipId} did not accept its invitation: ${JSON.stringify(accepted)}`);
        await uow.events.publish({ aggregateKind: "membership", aggregateId: membershipId, aggregateVersion: accepted.record.version, agencyId: agency.agencyId, eventType: "membership.accepted.v1", actor: { kind: "USER", userId }, causationId: correlation() as unknown as CausationId, correlationId: uow.context.correlationId, payload: { membershipId, agencyId: agency.agencyId, userId, role } });
      });
      return membershipId;
    },

    async recordStepUp(userId, options = {}) {
      const proofId = ids.next() as AssuranceProofId;
      const issuedAt = options.issuedAt ?? toUtcInstant(Date.parse(await serverNow(assurancePool.raw)) - 1000);
      const expiresAt = toUtcInstant(Date.parse(issuedAt) + 15 * 60_000);
      await proofs.record({ proofId, userId, kind: "STEP_UP", method: options.method ?? "TOTP", issuedAt, expiresAt }, correlation(), clock.now());
      return proofId;
    },

    async recordValidationReceipt(receipt) {
      await receipts.record(receipt, clock.now());
    },

    async sealedRevision(agency, projectId, state = "SEALED", options = {}) {
      // the B07 source lifecycle, each write under the role that owns it (source-lifecycle.ts); sealed fifteen days ago, so a test
      // may take the retention sweeper's retention_expires at any time (the database refuses an expiry before its deadline)
      const sealed = await sealSourceRevision(
        {
          app: (fn) => asTenant(agency.agencyId, agency.ownerUserId, (c) => fn(c)),
          control: (fn) => asControlFor(agency.agencyId, fn),
        },
        { agencyId: agency.agencyId, projectId, ownerUserId: agency.ownerUserId, ownerMembershipId: agency.ownerMembershipId },
        { seed: `harness-${projectId}`, state, ...(options.base !== undefined ? { base: options.base } : {}), ...(options.billableSourceUnits !== undefined ? { billableSourceUnits: options.billableSourceUnits } : {}) },
      );
      return { revisionId: sealed.revisionId as RevisionId, revisionHash: sealed.manifestHash as Sha256Hex, version: sealed.version };
    },

    async expireRevision(agency, projectId, revisionId, at = new Date(Date.now() + 15 * 86_400_000)) {
      return asControlFor(agency.agencyId, async (c) => {
        await clockAt(c, at);
        return expireSealedRevision(c, { agencyId: agency.agencyId, projectId, ownerUserId: agency.ownerUserId, ownerMembershipId: agency.ownerMembershipId }, revisionId);
      });
    },

    async processingAuthority(agency) {
      return app.run(h.tenant(agency.agencyId, agency.ownerUserId), async (uow) => {
        const id = uow.ids.next() as ProcessingAuthorityId;
        const recorded = await uow.processingAuthorities.record({ processingAuthorityId: id, agencyId: agency.agencyId, recordedByMembershipId: agency.ownerMembershipId, recordedAt: clock.now() });
        if (recorded?.kind !== "RECORDED") throw new Error("the processing authority fixture was not recorded");
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

    async offeredCapability(mode, state = "AVAILABLE_LIMITED", options = {}) {
      const id = ids.next();
      await controlClient.query(
        `INSERT INTO kauro.capabilities (capability_id, version, kind, mode, state, profile_hash, qualification_evidence_hashes, review_trigger, created_at, updated_at)
         VALUES ($1, $2, 'MODE', $3, 'DESIGN', $4, '[]'::jsonb, 'VENDOR_OR_ENVELOPE_CHANGE', now(), now())`,
        [id, options.version ?? "R2-INITIAL", mode, sha("profile-" + mode)],
      );
      if (state !== "DESIGN") await h.publishCapability(id, state);
      return id;
    },

    async publishCapability(capabilityId, state) {
      await controlClient.query("BEGIN");
      try {
        const current = await controlClient.query<{ state: CapabilityPublicationState; mode: string; version: string }>(
          "SELECT state, mode, version FROM kauro.capabilities WHERE capability_id = $1 FOR UPDATE",
          [capabilityId],
        );
        const row = current.rows[0];
        if (!row) throw new Error(`capability ${capabilityId} does not exist`);
        const from = CAPABILITY_PUBLICATION_PATH.indexOf(row.state);
        const to = CAPABILITY_PUBLICATION_PATH.indexOf(state);
        if (from < 0 || to <= from) throw new Error(`capability ${capabilityId} is ${row.state}; ${state} is not ahead of it on the publication path`);
        for (let step = from + 1; step <= to; step++) {
          const previous = CAPABILITY_PUBLICATION_PATH[step - 1] as CapabilityPublicationState;
          const next = CAPABILITY_PUBLICATION_PATH[step] as CapabilityPublicationState;
          const evidence = EDGE_EVIDENCE[next];
          const moved = await controlClient.query(
            `UPDATE kauro.capabilities
                SET state = $3,
                    qualification_evidence_hashes = CASE WHEN $4::text IS NULL THEN qualification_evidence_hashes ELSE qualification_evidence_hashes || to_jsonb($4::text) END,
                    valid_from = CASE WHEN $3 = 'AVAILABLE_LIMITED' THEN now() ELSE valid_from END
              WHERE capability_id = $1 AND state = $2`,
            [capabilityId, previous, next, evidence === undefined ? null : sha(`${evidence}-${row.mode}-${row.version}`)],
          );
          if (moved.rowCount !== 1) throw new Error(`capability ${capabilityId} did not move ${previous} -> ${next}`);
        }
        await controlClient.query("COMMIT");
      } catch (e) {
        await controlClient.query("ROLLBACK");
        throw e;
      }
    },

    qualifiedPaymentRoute: (options) => recordQualifiedPaymentRoute(controlClient, options),
    qualifiedFiscalIssuer: (options) => recordQualifiedFiscalIssuer(controlClient, options),
    grantKauroOwner: (userId) => grantCorporateRole(controlClient, userId),
    revokeCorporateGrant: (grantId) => revokeCorporateRole(controlClient, grantId),

    async stop() {
      await controlClient.end();
      await oracle.end();
      await appPool.end();
      await controlPool.end();
      await assurancePool.end();
      await validatorPool.end();
      await ingressPool.end();
      await paymentPool.end();
      await commissionPool.end();
      await pg.stop();
    },
  };
  return h;
}

/**
 * Waits until a backend of `applicationName` whose current query contains `queryFragment` is blocked on a lock
 * (pg_stat_activity), which fixes the interleaving of two units of work deterministically (21 "Concurrency and crash matrix").
 *
 * The backend status snapshot of pg_stat_activity is cached for the rest of the transaction that first read it, while the wait
 * event is read live: a caller that polls from inside its own transaction (a race that holds a table lock through the oracle)
 * would see the wait event of a backend next to the query and state it had when the transaction first looked. Every poll
 * therefore discards the cached snapshot first.
 */
export async function waitForLockWait(oracle: Client, applicationName: string, queryFragment: string): Promise<number> {
  for (let i = 0; i < 400; i++) {
    await oracle.query("SELECT pg_stat_clear_snapshot()");
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

/** What an operation did while another transaction held what it might need (settlesOrWaits). */
export type LockObservation<T> =
  | { readonly kind: "SETTLED"; readonly outcome: PromiseSettledResult<T> }
  | { readonly kind: "WAITING"; readonly pending: Promise<PromiseSettledResult<T>> };

/**
 * Observes `operation`, running on the backend `pid`, while another transaction holds what it might need, and reports which
 * happened first: the operation SETTLED (fulfilled or rejected) without being blocked, or its backend is WAITING on a lock
 * (pg_stat_activity). While the holder stays open exactly one of the two must happen — an operation that cannot wait finishes,
 * one that must wait blocks until the holder ends — so the observation fixes the interleaving deterministically (21
 * "Concurrency and crash matrix"). It is bounded all the same: if neither is observed within `limitMs` it throws, naming
 * `what`, instead of hanging the test. A WAITING operation keeps running; the caller ends the holder and awaits `pending`,
 * which never rejects (it carries the outcome).
 */
export async function settlesOrWaits<T>(oracle: Client, pid: number, operation: Promise<T>, what: string, limitMs = 10_000): Promise<LockObservation<T>> {
  let outcome: PromiseSettledResult<T> | undefined;
  const pending = operation.then(
    (value): PromiseSettledResult<T> => (outcome = { status: "fulfilled", value }),
    (reason: unknown): PromiseSettledResult<T> => (outcome = { status: "rejected", reason }),
  );
  const deadline = Date.now() + limitMs;
  for (;;) {
    if (outcome) return { kind: "SETTLED", outcome };
    const r = await oracle.query<{ waiting: boolean }>("SELECT wait_event_type IS NOT DISTINCT FROM 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1", [pid]);
    // a backend seen blocked cannot have finished meanwhile; one that finished while the oracle looked is SETTLED
    if (outcome) return { kind: "SETTLED", outcome };
    if (r.rows[0]?.waiting === true) return { kind: "WAITING", pending };
    if (Date.now() > deadline) throw new Error(`${what} neither finished nor waited on a lock within ${limitMs} ms`);
    await new Promise((res) => setTimeout(res, 10));
  }
}

/** The backend process id of a connected client (the pid pg_stat_activity reports for it). */
export async function backendPid(client: Pick<Client, "query">): Promise<number> {
  const r = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pid = r.rows[0]?.pid;
  if (pid === undefined) throw new Error("pg_backend_pid() returned no row");
  return pid;
}

/** A one-shot barrier two units of work use to fix their interleaving. */
export function barrier(): { readonly wait: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}

/**
 * Marks a promise a test starts now and settles later as observed from its creation. A race test starts one side, drives the
 * other side and the lock holder, and only then awaits (or asserts the refusal of) the first; the first side can fail the moment
 * the holder ends, before the test attaches its handler, and node:test fails the running test on that "unhandled rejection"
 * although the refusal is exactly what the test expects. The returned promise is the same one: `await` and `assert.rejects` see
 * the outcome unchanged.
 */
export function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}
