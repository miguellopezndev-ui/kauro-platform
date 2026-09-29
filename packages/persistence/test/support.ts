// Shared fixtures for the persistence tests. Every fixture write goes through the runtime role that owns it — the request
// handlers (kauro_app_test) under a real tenant context, the control plane (kauro_control_test), the step-up verifier
// (kauro_assurance_test) or the validator (kauro_validator_test) — so the fixtures themselves prove the policies admit
// legitimate writes (21 "Positive and negative symmetry"). Aggregates are born in their machine's initial state and walk the
// listed edges, one version and one event per edge. Oracle reads use the superuser, which bypasses RLS and therefore sees
// every row of every tenant.
import { randomBytes, createHash } from "node:crypto";
import type { Client } from "pg";
import { createIdGenerator, identityUserId, toUtcInstant, type IdGenerator } from "@kauro/domain";
import { CAPABILITY_PUBLICATION_PATH, type CapabilityPublicationState } from "../src/testing/harness.js";
import { sealSourceRevision, type SourceFixtureSessions } from "../src/testing/source-lifecycle.js";

export const clock = { now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() };
export const ids: IdGenerator = createIdGenerator(clock, (n) => new Uint8Array(randomBytes(n)));

export function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface Context {
  readonly agencyId?: string;
  readonly userId?: string;
}

/** Binds the context with SET LOCAL semantics (set_config(..., true)) inside the transaction the caller opened. */
export async function bind(client: Client, ctx: Context): Promise<void> {
  await client.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [ctx.agencyId ?? "", ctx.userId ?? ""]);
}

/** One transaction with the context bound; commits when fn returns, rolls back and rethrows otherwise. */
export async function tx<T>(client: Client, ctx: Context, fn: (c: Client) => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await bind(client, ctx);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

export interface EventInput {
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly agencyId: string | null;
  readonly eventType: string;
  readonly actorUserId: string | null;
  readonly correlationId?: string;
  readonly payload?: Record<string, unknown>;
}

/** Appends a domain event row (what the EventPublisher adapter will do). */
export async function event(client: Client, e: EventInput): Promise<string> {
  const eventId = ids.next();
  const payload = e.payload ?? {};
  await client.query(
    `INSERT INTO kauro.domain_events (event_id, aggregate_kind, aggregate_id, aggregate_version, agency_id, event_type, actor_kind, actor_id, causation_id, correlation_id, payload, payload_hash, schema_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '1', now())`,
    [eventId, e.aggregateKind, e.aggregateId, e.aggregateVersion, e.agencyId, e.eventType, e.actorUserId ? "USER" : "SYSTEM", e.actorUserId, ids.next(), e.correlationId ?? ids.next(), JSON.stringify(payload), sha(JSON.stringify(payload))],
  );
  return eventId;
}

export interface Person {
  readonly userId: string;
}

/**
 * Syncs an identity row (verified email + MFA) under the identity's own context. The request-handler role never writes the
 * security status (re-check finding N1): the row is born ACTIVE by default.
 */
export async function person(app: Client, subject: string, verified = true): Promise<Person> {
  const userId = identityUserId("identity-platform", subject);
  await tx(app, { userId }, async (c) => {
    await c.query(
      `INSERT INTO kauro.identities (user_id, provider, subject_hash, email_verified_at, mfa_enrolled_at, created_at, updated_at)
       VALUES ($1, 'identity-platform', $2, $3, $3, now(), now()) ON CONFLICT (user_id) DO NOTHING`,
      [userId, sha(subject), verified ? new Date() : null],
    );
  });
  return { userId };
}

export interface AgencyFixture {
  readonly agencyId: string;
  readonly ownerMembershipId: string;
  readonly ownerUserId: string;
}

/** CreateAgency as the handler will do it: IDENTITY context adopts the minted agency id, inserts agency + owner + events. */
export async function agency(app: Client, owner: Person, displayName = "Acme Agency"): Promise<AgencyFixture> {
  const agencyId = ids.next();
  const membershipId = ids.next();
  await app.query("BEGIN");
  try {
    await bind(app, { userId: owner.userId });
    await bind(app, { userId: owner.userId, agencyId }); // adoptTenant
    await app.query(
      `INSERT INTO kauro.agencies (agency_id, display_name, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, now(), now())`,
      [agencyId, displayName, owner.userId],
    );
    await app.query(
      `INSERT INTO kauro.memberships (membership_id, agency_id, user_id, role, state, assurance_policy, accepted_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', 'MFA_REQUIRED', now(), now(), now())`,
      [membershipId, agencyId, owner.userId],
    );
    await event(app, { aggregateKind: "agency", aggregateId: agencyId, aggregateVersion: 1, agencyId, eventType: "agency.created.v1", actorUserId: owner.userId, payload: { agencyId, createdByUserId: owner.userId, state: "DRAFT" } });
    await event(app, { aggregateKind: "membership", aggregateId: membershipId, aggregateVersion: 1, agencyId, eventType: "membership.created.v1", actorUserId: owner.userId, payload: { membershipId, agencyId, userId: owner.userId, role: "OWNER", state: "ACTIVE" } });
    await app.query("COMMIT");
  } catch (e) {
    await app.query("ROLLBACK");
    throw e;
  }
  return { agencyId, ownerMembershipId: membershipId, ownerUserId: owner.userId };
}

/**
 * Adds an ACTIVE member with the given role along the registry Membership machine, as InviteMember + AcceptInvitation will:
 * the owner invites (INVITED v1, membership.invited.v1) and issues the hashed single-use invitation, the intended identity
 * consumes it and accepts under its own context (ACTIVE v2, membership.accepted.v1). The membership ends at version 2.
 */
export async function member(app: Client, ag: AgencyFixture, who: Person, role: string): Promise<string> {
  const { membershipId, invitationId } = await invite(app, ag, who, role);
  await tx(app, { agencyId: ag.agencyId, userId: who.userId }, async (c) => {
    const consumed = await c.query("UPDATE kauro.membership_invitations SET consumed_at = now() WHERE invitation_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL", [invitationId]);
    if (consumed.rowCount !== 1) throw new Error(`invitation ${invitationId} was not consumed`);
    const r = await c.query("UPDATE kauro.memberships SET state = 'ACTIVE', accepted_at = now(), version = 2 WHERE membership_id = $1 AND state = 'INVITED' AND version = 1", [membershipId]);
    if (r.rowCount !== 1) throw new Error(`membership ${membershipId} did not accept its invitation`);
    await event(c, { aggregateKind: "membership", aggregateId: membershipId, aggregateVersion: 2, agencyId: ag.agencyId, eventType: "membership.accepted.v1", actorUserId: who.userId, payload: { membershipId, agencyId: ag.agencyId, userId: who.userId, role } });
  });
  return membershipId;
}

/**
 * The owner's invitation (CMD003 as the handler will write it): the INVITED membership and its open invitation with a hashed
 * single-use token of the same role, expiring in seven days. Returns the ids and the digest of the token.
 */
export async function invite(app: Client, ag: AgencyFixture, who: Person, role: string): Promise<{ membershipId: string; invitationId: string; tokenHash: string }> {
  const membershipId = ids.next();
  const invitationId = ids.next();
  const tokenHash = sha(`token-${invitationId}`);
  await tx(app, { agencyId: ag.agencyId, userId: ag.ownerUserId }, async (c) => {
    await c.query(
      `INSERT INTO kauro.memberships (membership_id, agency_id, user_id, role, state, assurance_policy, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'INVITED', 'MFA_REQUIRED', now(), now())`,
      [membershipId, ag.agencyId, who.userId, role],
    );
    await event(c, { aggregateKind: "membership", aggregateId: membershipId, aggregateVersion: 1, agencyId: ag.agencyId, eventType: "membership.invited.v1", actorUserId: ag.ownerUserId, payload: { membershipId, agencyId: ag.agencyId, role, invitedByMembershipId: ag.ownerMembershipId } });
    await c.query(
      `INSERT INTO kauro.membership_invitations (invitation_id, agency_id, membership_id, token_hash, role, invited_by_membership_id, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '7 days', now())`,
      [invitationId, ag.agencyId, membershipId, tokenHash, role, ag.ownerMembershipId],
    );
  });
  return { membershipId, invitationId, tokenHash };
}

export async function processingAuthority(app: Client, ag: AgencyFixture): Promise<string> {
  const id = ids.next();
  await tx(app, { agencyId: ag.agencyId, userId: ag.ownerUserId }, async (c) => {
    await c.query(
      `INSERT INTO kauro.processing_authorities (processing_authority_id, agency_id, recorded_by_membership_id, recorded_at)
       VALUES ($1, $2, $3, now())`,
      [id, ag.agencyId, ag.ownerMembershipId],
    );
  });
  return id;
}

export async function endClient(app: Client, ag: AgencyFixture, authorityId: string, displayName = "Client One"): Promise<string> {
  const clientId = ids.next();
  await tx(app, { agencyId: ag.agencyId, userId: ag.ownerUserId }, async (c) => {
    await c.query(
      `INSERT INTO kauro.end_clients (client_id, agency_id, display_name, processing_authority_ref, created_by_membership_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())`,
      [clientId, ag.agencyId, displayName, authorityId, ag.ownerMembershipId],
    );
    await event(c, { aggregateKind: "end_client", aggregateId: clientId, aggregateVersion: 1, agencyId: ag.agencyId, eventType: "end_client.created.v1", actorUserId: ag.ownerUserId, payload: { clientId, agencyId: ag.agencyId, processingAuthorityRef: authorityId } });
  });
  return clientId;
}

/**
 * A mode capability as the control plane publishes it (CMD058 territory; here a fixture, D-CAP-2): the row is born DESIGN and
 * moves along the listed Capability edges to `state`, each edge after IMPLEMENTED_UNACCEPTED citing its gate's evidence.
 */
export async function offeredCapability(control: Client, mode: string, state: CapabilityPublicationState = "AVAILABLE_LIMITED"): Promise<string> {
  const id = ids.next();
  await control.query(
    `INSERT INTO kauro.capabilities (capability_id, version, kind, mode, state, profile_hash, qualification_evidence_hashes, review_trigger, created_at, updated_at)
     VALUES ($1, 'R2-INITIAL', 'MODE', $2, 'DESIGN', $3, '[]'::jsonb, 'VENDOR_OR_ENVELOPE_CHANGE', now(), now())`,
    [id, mode, sha("profile-" + mode)],
  );
  const target = CAPABILITY_PUBLICATION_PATH.indexOf(state);
  for (let step = 1; step <= target; step++) {
    const next = CAPABILITY_PUBLICATION_PATH[step] as CapabilityPublicationState;
    const evidence = next === "IMPLEMENTED_UNACCEPTED" ? [] : [sha(`evidence-${mode}-${next}`)];
    await control.query("UPDATE kauro.capabilities SET state = $2, qualification_evidence_hashes = qualification_evidence_hashes || $3::jsonb WHERE capability_id = $1", [id, next, JSON.stringify(evidence)]);
  }
  return id;
}

export async function project(app: Client, ag: AgencyFixture, clientId: string, capabilityId: string, mode = "CLEAN"): Promise<{ projectId: string; revisionId: string }> {
  const projectId = ids.next();
  const revisionId = ids.next();
  await tx(app, { agencyId: ag.agencyId, userId: ag.ownerUserId }, async (c) => {
    await c.query(
      `INSERT INTO kauro.projects (project_id, agency_id, client_id, mode, purpose, target_instance_ref, capability_id, capability_version, current_revision_id, created_by_membership_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Quarterly cleanup', $5, $6, 'R2-INITIAL', $7, $8, now(), now())`,
      [projectId, ag.agencyId, clientId, mode, mode === "CLEAN" ? null : ids.next(), capabilityId, revisionId, ag.ownerMembershipId],
    );
    await c.query(
      `INSERT INTO kauro.dataset_revisions (revision_id, agency_id, project_id, created_at, updated_at) VALUES ($1, $2, $3, now(), now())`,
      [revisionId, ag.agencyId, projectId],
    );
    await event(c, { aggregateKind: "project", aggregateId: projectId, aggregateVersion: 1, agencyId: ag.agencyId, eventType: "project.created.v1", actorUserId: ag.ownerUserId, payload: { projectId, agencyId: ag.agencyId, clientId, mode, initialRevisionId: revisionId } });
    await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: 1, agencyId: ag.agencyId, eventType: "dataset_revision.created.v1", actorUserId: ag.ownerUserId, payload: { revisionId, agencyId: ag.agencyId, projectId, state: "DRAFT" } });
  });
  return { projectId, revisionId };
}

/** One OPEN support case of `projectId`, opened by the agency owner under kauro_app with its opened event (B11 CMD044's writes, one event per version). */
export async function supportCase(app: Client, ag: AgencyFixture, projectId: string, extra: { readonly severity?: string; readonly category?: string; readonly summary?: string } = {}): Promise<{ caseId: string }> {
  const caseId = ids.next();
  const severity = extra.severity ?? "S3";
  const category = extra.category ?? "PRODUCT_DEFECT";
  await tx(app, { agencyId: ag.agencyId, userId: ag.ownerUserId }, async (c) => {
    await c.query(
      `INSERT INTO kauro.support_cases (case_id, agency_id, project_id, category, severity, summary, created_by_user_id, created_by_membership_id, next_review_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '1 day', now(), now())`,
      [caseId, ag.agencyId, projectId, category, severity, extra.summary ?? "The import preview shows the wrong column for the second sheet.", ag.ownerUserId, ag.ownerMembershipId],
    );
    await event(c, { aggregateKind: "support_case", aggregateId: caseId, aggregateVersion: 1, agencyId: ag.agencyId, eventType: "support_case.opened.v1", actorUserId: ag.ownerUserId, payload: { caseId, projectId, category, severity } });
  });
  return { caseId };
}

export interface PlanFixture {
  readonly planId: string;
  readonly bodyHash: string;
  readonly revisionHash: string;
  readonly targetContractHash: string;
}

/** Records a validation receipt as the validator (kauro_validator_test) under the plan's tenant context. */
export async function validationReceipt(
  validator: Client,
  ag: AgencyFixture,
  p: PlanFixture,
  receiptHash: string,
  result: "VALID" | "INVALID" | "CANCELLED" | "ERROR" = "VALID",
): Promise<void> {
  await tx(validator, { agencyId: ag.agencyId }, async (c) => {
    await c.query(
      `INSERT INTO kauro.validation_receipts (receipt_id, agency_id, plan_id, receipt_hash, revision_hash, target_contract_hash, plan_hash, core_package_hash, profile_evidence_hash, disposition_evidence_hash, artifact_evidence_hash, started_at, completed_at, result, counts, blocking_issue_codes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() - interval '1 minute', now(), $12, '{"physicalSourceRows": 10}', $13::jsonb, now())`,
      [ids.next(), ag.agencyId, p.planId, receiptHash, p.revisionHash, p.targetContractHash, p.bodyHash, sha("core"), sha("profile"), sha("disposition"), sha("artifact"), result, result === "VALID" ? "[]" : '["UNRESOLVED_REQUIRED_DECISION"]'],
    );
  });
}

/** The two runtime connections a sealed source needs: the request handlers and the control plane (B07 design D-CTRL-1). */
export interface SourceClients {
  readonly app: Client;
  readonly control: Client;
}

/** The fixture sessions of an agency's owner (request handlers) and of the control plane bound to that agency. */
export function sourceSessions(clients: SourceClients, ag: AgencyFixture): SourceFixtureSessions {
  return {
    app: (fn) => tx(clients.app, { agencyId: ag.agencyId, userId: ag.ownerUserId }, fn),
    control: (fn) => tx(clients.control, { agencyId: ag.agencyId }, fn),
  };
}

/**
 * A revision of the project sealed as the B07 source lifecycle leaves it (@kauro/persistence/testing sealSourceRevision: the
 * reservation, completion, inspection and admission, selection, evaluation and seal, each written by the runtime role that owns
 * it); its manifest hash is the source hash a plan names (plans_source_fk). Sealed fifteen days ago, so a test may expire it —
 * unless `base` names when the intake began (a commercial fixture that quotes the source seals it recently: a quote promises no
 * more than the retention the seal left, B09 quotes_source_binding).
 */
export async function sealedSource(clients: SourceClients, ag: AgencyFixture, projectId: string, seed: string, state: "SEALED" | "EXPIRED" = "SEALED", base?: Date): Promise<{ revisionId: string; manifestHash: string }> {
  const sealed = await sealSourceRevision(sourceSessions(clients, ag), { agencyId: ag.agencyId, projectId, ownerUserId: ag.ownerUserId, ownerMembershipId: ag.ownerMembershipId }, { seed, state, ...(base !== undefined ? { base } : {}) });
  return { revisionId: sealed.revisionId, manifestHash: sealed.manifestHash };
}

/** A confirmed, current target contract of the project, as observation and confirmation leave it (plans_target_fk). */
export async function targetContract(app: Client, ag: AgencyFixture, projectId: string, seed: string): Promise<{ contractId: string; bodyHash: string }> {
  const contractId = ids.next();
  const bodyHash = sha(`${seed}-target-${contractId}`);
  await tx(app, { agencyId: ag.agencyId, userId: ag.ownerUserId }, async (c) => {
    await c.query(
      `INSERT INTO kauro.target_contracts (contract_id, agency_id, project_id, mode, instance_id, importer_profile_id, importer_version, objects, schema_bundle_digest, body_hash, observed_at, confirmed_at, authority_evidence_hash, capability_version, created_at)
       VALUES ($1, $2, $3, 'CLEAN', $4, $5, 'R2-INITIAL', '[]'::jsonb, $6, $7, now(), now(), $8, 'R2-INITIAL', now())`,
      [contractId, ag.agencyId, projectId, ids.next(), ids.next(), sha("bundle"), bodyHash, sha(`authority-${contractId}`)],
    );
  });
  return { contractId, bodyHash };
}

/** A closed plan body naming its subjects (the columns must equal these members: plans_body_names_subjects). */
export function planBody(revisionHash: string, targetContractHash: string, policyHash: string): Record<string, unknown> {
  return { revisionHash, targetContractHash, policyHash, mappings: [], identities: [], transforms: [], relationships: [] };
}

/**
 * A plan revision at the given state, walked along the listed Plan edges with one event per version, whose source and target
 * are a sealed revision and a confirmed contract of its own project (created here unless given). The request handlers
 * apply DRAFT -> VALIDATION_REQUIRED -> VALIDATING; for VALIDATED the validator (a kauro_validator_test connection) records the
 * VALID receipt and the handlers then apply valid_receipt (VALIDATING -> VALIDATED binding it).
 */
export async function plan(
  clients: SourceClients,
  ag: AgencyFixture,
  projectId: string,
  state: "DRAFT" | "VALIDATION_REQUIRED" | "VALIDATING" | "VALIDATED",
  seed = "plan",
  validator?: Client,
  subjects?: { readonly revisionHash: string; readonly targetContractHash: string },
): Promise<PlanFixture & { version: number; receiptHash?: string }> {
  const app = clients.app;
  const planId = ids.next();
  const bodyHash = sha(seed + "-body-" + planId);
  const revisionHash = subjects?.revisionHash ?? (await sealedSource(clients, ag, projectId, seed)).manifestHash;
  const targetContractHash = subjects?.targetContractHash ?? (await targetContract(app, ag, projectId, seed)).bodyHash;
  const fixture: PlanFixture = { planId, bodyHash, revisionHash, targetContractHash };
  let version = 1;
  await tx(app, { agencyId: ag.agencyId, userId: ag.ownerUserId }, async (c) => {
    await c.query(
      `INSERT INTO kauro.plans (plan_id, agency_id, project_id, revision_hash, target_contract_hash, policy_hash, body, body_hash, created_by_membership_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, now(), now())`,
      [planId, ag.agencyId, projectId, revisionHash, targetContractHash, sha("policy"), JSON.stringify(planBody(revisionHash, targetContractHash, sha("policy"))), bodyHash, ag.ownerMembershipId],
    );
    await event(c, { aggregateKind: "plan", aggregateId: planId, aggregateVersion: 1, agencyId: ag.agencyId, eventType: "plan.created.v1", actorUserId: ag.ownerUserId, payload: { planId, agencyId: ag.agencyId, projectId, bodyHash } });
    if (state !== "DRAFT") {
      version = 2;
      await c.query(`UPDATE kauro.plans SET state = 'VALIDATION_REQUIRED', version = 2 WHERE plan_id = $1`, [planId]);
      await event(c, { aggregateKind: "plan", aggregateId: planId, aggregateVersion: 2, agencyId: ag.agencyId, eventType: "plan.validation_required.v1", actorUserId: ag.ownerUserId, payload: { planId, agencyId: ag.agencyId, bodyHash } });
    }
    if (state === "VALIDATING" || state === "VALIDATED") {
      version = 3;
      await c.query(`UPDATE kauro.plans SET state = 'VALIDATING', version = 3 WHERE plan_id = $1`, [planId]);
      await event(c, { aggregateKind: "plan", aggregateId: planId, aggregateVersion: 3, agencyId: ag.agencyId, eventType: "plan.validating.v1", actorUserId: ag.ownerUserId, payload: { planId, agencyId: ag.agencyId, bodyHash } });
    }
  });
  if (state !== "VALIDATED") return { ...fixture, version };
  if (!validator) throw new Error("a VALIDATED plan needs the validator connection that records its receipt");
  const receiptHash = sha(seed + "-receipt-" + planId);
  await validationReceipt(validator, ag, fixture, receiptHash);
  await tx(app, { agencyId: ag.agencyId, userId: ag.ownerUserId }, async (c) => {
    await c.query(`UPDATE kauro.plans SET state = 'VALIDATED', version = 4, validation_receipt_hash = $2 WHERE plan_id = $1`, [planId, receiptHash]);
    await event(c, { aggregateKind: "plan", aggregateId: planId, aggregateVersion: 4, agencyId: ag.agencyId, eventType: "plan.validated.v1", actorUserId: ag.ownerUserId, payload: { planId, agencyId: ag.agencyId, bodyHash, validationReceiptHash: receiptHash } });
  });
  return { ...fixture, version: 4, receiptHash };
}

/** Records a step-up proof as the step-up verifier (kauro_assurance_test) for the identity it verified. */
export async function stepUpProof(assurance: Client, who: Person): Promise<string> {
  const proofId = ids.next();
  await tx(assurance, { userId: who.userId }, async (c) => {
    await c.query(
      `INSERT INTO kauro.assurance_proofs (proof_id, user_id, kind, method, issued_at, expires_at, correlation_id, created_at)
       VALUES ($1, $2, 'STEP_UP', 'TOTP', now(), now() + interval '15 minutes', $3, now())`,
      [proofId, who.userId, ids.next()],
    );
  });
  return proofId;
}

/** Extracts the SQLSTATE of a pg error (or the message when it is not a database error). */
export function sqlState(e: unknown): string {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : `no sqlstate: ${String(e)}`;
}

export function constraintOf(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "constraint" in e ? String((e as { constraint: unknown }).constraint) : undefined;
}
