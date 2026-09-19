// HTTP test fixture: the real Fastify server over the real authorizer, the real handlers and the closed validator, with the
// in-memory ports of @kauro/application behind the unit of work (pure orchestration; the same routes against real PostgreSQL
// are the integration tests of docs/design/B06-case-map.md).
import type { FastifyInstance, InjectOptions } from "fastify";
import type { AuthenticatedSubject, B06Handlers, InMemoryStore, Problem } from "@kauro/application";
import { createB06Handlers, createInMemoryPorts, emptyStore, fixedClock, sequentialIds } from "@kauro/application";
import { createAdmissionLimiter, createAssuranceVerifier, createAuthorizer } from "@kauro/authorization";
import type { AgencyId, CapabilityId, ClientId, MembershipId, MembershipRole, ProcessingAuthorityId, UserId } from "@kauro/domain";
import { createApiServer, createBearerTokenAuthenticator, loadContractSchemas, subjectOf } from "../src/index.js";

export const clock = fixedClock();
export const ids = sequentialIds(clock);
export const validator = loadContractSchemas();

export interface Person {
  readonly token: string;
  readonly subject: AuthenticatedSubject;
}

export function person(name: string, opts: { verified?: boolean } = {}): Person {
  const verified = opts.verified ?? true;
  return {
    token: `token-${name}-${"x".repeat(16)}`,
    subject: subjectOf({ provider: "identity-platform", subject: name, emailVerifiedAt: verified ? clock.now() : null, mfaEnrolledAt: verified ? clock.now() : null, state: "ACTIVE" }),
  };
}

export interface Api {
  readonly app: FastifyInstance;
  readonly store: () => InMemoryStore;
  readonly internalErrors: Array<{ correlationId: string; error: unknown }>;
  readonly agencyId: AgencyId;
  readonly clientId: ClientId;
  readonly authorityId: ProcessingAuthorityId;
  readonly owner: Person;
  readonly viewer: Person;
  readonly stranger: Person;
  readonly unverified: Person;
}

export interface ApiOptions {
  /** Replaces handlers before the server is built (e.g. one whose execute throws, to observe INTERNAL_ERROR). */
  readonly wrapHandlers?: (handlers: B06Handlers) => B06Handlers;
}

export function api(options: ApiOptions = {}): Api {
  const store = emptyStore();
  const now = clock.now();
  const owner = person("owner");
  const viewer = person("viewer");
  const stranger = person("stranger");
  const unverified = person("unverified", { verified: false });
  const people = [owner, viewer, stranger, unverified];
  for (const p of people) store.identities.set(p.subject.identity.userId, { ...p.subject.identity, provider: p.subject.provider, subjectHash: p.subject.subjectHash });
  const agencyId = ids.next() as AgencyId;
  store.agencies.set(agencyId, { agencyId, version: 1, displayName: "Acme", state: "DRAFT", createdAt: now, createdByUserId: owner.subject.identity.userId, updatedAt: now });
  const member = (userId: UserId, role: MembershipRole): MembershipId => {
    const membershipId = ids.next() as MembershipId;
    store.memberships.set(membershipId, { membershipId, agencyId, userId, role, state: "ACTIVE", version: 1, assurancePolicy: "MFA_REQUIRED", acceptedAt: now, createdAt: now, updatedAt: now });
    return membershipId;
  };
  const ownerMembershipId = member(owner.subject.identity.userId, "OWNER");
  member(viewer.subject.identity.userId, "VIEWER");
  const authorityId = ids.next() as ProcessingAuthorityId;
  store.processingAuthorities.set(authorityId, { processingAuthorityId: authorityId, agencyId, kind: "CLIENT_AUTHORIZATION", evidenceHash: "e".repeat(64), recordedByMembershipId: ownerMembershipId, recordedAt: now });
  const clientId = ids.next() as ClientId;
  store.endClients.set(clientId, { clientId, agencyId, version: 1, displayName: "Client", state: "ACTIVE", processingAuthorityRef: authorityId, createdByMembershipId: ownerMembershipId, createdAt: now, updatedAt: now });
  const capabilityId = ids.next() as CapabilityId;
  store.capabilities.set(capabilityId, { capabilityId, version: "R2-INITIAL", kind: "MODE", mode: "CLEAN", state: "AVAILABLE", profileHash: "f".repeat(64), qualificationEvidenceHashes: ["a".repeat(64)], reviewTrigger: "VENDOR_OR_ENVELOPE_CHANGE" });

  const ports = createInMemoryPorts(clock, ids, store);
  const runtime = { unitOfWork: ports.unitOfWork, authorizer: createAuthorizer({ clock, assurance: createAssuranceVerifier() }), clock, ids };
  const handlers = createB06Handlers(runtime, {
    abuseLimiter: createAdmissionLimiter(),
    activeWork: { inspectClient: async (uow, id) => ({ openProjects: await uow.endClients.countOpenProjects(id), activeJobs: 0, liveCommercialAuthorizations: 0 }) },
    artifacts: { resolveDecisionPatch: async () => null },
    patchCompiler: { apply: async () => ({ kind: "REJECTED", reason: "MALFORMED_PATCH" }) },
    disclosures: {
      compose: async () => {
        throw new Error("no validated plan exists in the HTTP fixture");
      },
    },
    externalActions: { completedForPlan: async () => [] },
  });
  const internalErrors: Array<{ correlationId: string; error: unknown }> = [];
  const app = createApiServer({
    environment: "LOCAL",
    handlers: options.wrapHandlers ? options.wrapHandlers(handlers) : handlers,
    authenticator: createBearerTokenAuthenticator(new Map(people.map((p) => [p.token, p.subject]))),
    validator,
    clock,
    ids,
    onInternalError: (correlationId, error) => internalErrors.push({ correlationId, error }),
  });
  return { app, store: () => ports.store, internalErrors, agencyId, clientId, authorityId, owner, viewer, stranger, unverified };
}

export interface Call {
  readonly method?: "POST" | "GET";
  readonly url: string;
  readonly token?: string | null;
  readonly key?: string | null;
  readonly agency?: string | null;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly contentType?: string | null;
  readonly headers?: Record<string, string>;
}

export async function call(a: Api, c: Call) {
  const headers: Record<string, string> = { ...(c.headers ?? {}) };
  if (c.contentType !== null) headers["content-type"] = c.contentType ?? "application/json";
  if (c.token !== null) headers["authorization"] = `Bearer ${c.token ?? a.owner.token}`;
  if (c.key !== null) headers["idempotency-key"] = c.key ?? "0123456789abcdef-key";
  if (c.agency !== null) headers["x-kauro-agency"] = c.agency ?? a.agencyId;
  const payload = c.rawBody ?? (c.body === undefined ? undefined : JSON.stringify(c.body));
  const options: InjectOptions = { method: c.method ?? "POST", url: c.url, headers, ...(payload !== undefined ? { payload } : {}) };
  const res = await a.app.inject(options);
  return { status: res.statusCode, headers: res.headers, contentType: res.headers["content-type"], json: () => res.json<unknown>() };
}

export function asProblem(v: unknown): Problem {
  const r = validator.validate<Problem>("Problem", v);
  if (r.kind === "INVALID") throw new Error(`not a Problem: ${JSON.stringify(r.fields)} in ${JSON.stringify(v)}`);
  return r.value;
}
