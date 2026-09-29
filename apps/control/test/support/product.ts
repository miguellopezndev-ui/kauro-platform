// The request side of the source lifecycle as the product runs it, for the b07/integration end-to-end tests (design §15: "the
// end-to-end cases of the case map run there"; decision D-INT-1): the six B07 handlers, the source reads and the selection manifest
// intake of @kauro/application — exactly what apps/api's composition root binds (assembleApi: createB07Handlers,
// createSourceReadHandlers, createSourceIntakeHandlers), the preview reader being the platform's own of @kauro/data-plane — on B06's
// pipeline (access decision by the real Authorizer of @kauro/authorization, journal reserve or replay, execute, journal commit) over
// the harness's request-handler factory (kauro_app_test), bound to the SAME labelled storage and vault fakes the control plane of the
// environment uses (CONTRACT FAKES, evidence class SIMULATED). Every answer is checked as the transport checks it before sending
// (checkReply against the route's declared response schema and outcome catalogue, with the contract bundle's validator), so a view
// over rows the real control plane wrote that the api could not send fails here. The HTTP admission in front of the handlers is
// apps/api's and is tested there; the architecture gate keeps one entrypoint from importing another (architecture.rules.json), so the
// composed run of the request half and the control-plane half lives in this package's tests.
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  B07_COMMANDS,
  checkReply,
  commandRouteResponses,
  createB07Handlers,
  createSchemaValidator,
  createSourceIntakeHandlers,
  createSourceReadHandlers,
  intakeRouteResponses,
  readRouteResponses,
  type AuthenticatedSubject,
  type B07CommandId,
  type B07Handlers,
  type CommandEnvelope,
  type CommandResult,
  type CommercialScopeInspector,
  type ContractSchemaBundle,
  type IntakeResult,
  type ReadResult,
  type SchemaValidator,
  type SourceIntakeHandlers,
  type SourceReadHandlers,
  type SourceRuntime,
} from "@kauro/application";
import { createAssuranceVerifier, createAuthorizer } from "@kauro/authorization";
import { IsolatedTablePreviewReader, inspectionLimits } from "@kauro/data-plane";
import { textDigest, type CorrelationId, type SourceUnitOfWorkFactory, type UserId } from "@kauro/domain";
import { commercialAuthorizationsOf, sourceStoreOf } from "@kauro/persistence";
import { clock, ids, type ControlEnv } from "./env.js";
import { asRequestHandler, type Tenant } from "./fixtures.js";

/** The application origin every resumable session is bound to (09 "Resumable session security"). */
export const ORIGIN = "https://app.kauro.test";

/**
 * CMD012's commercial-scope inspector as the api edition binds it since the B07 + B09 merge (apps/api edition.ts
 * commercialScopeInspector): the replaced revision's manifest hash read in the command's own source unit of work, then package B09's
 * CommercialAuthorizationRepository.findLiveByRevisionHash under the same tenant context — the platform's own reader, not a fake.
 */
const commercialScopeInspector: CommercialScopeInspector = {
  async authorizationsBoundTo(uow, agencyId, revisionId) {
    const revision = await sourceStoreOf(uow).revisions.get(revisionId);
    if (revision === null || revision.manifestHash === undefined) return [];
    return (await commercialAuthorizationsOf(uow).findLiveByRevisionHash(agencyId, revision.manifestHash)).map((a) => a.authorizationId);
  },
};

export interface Product {
  readonly handlers: B07Handlers;
  readonly reads: SourceReadHandlers;
  readonly intakes: SourceIntakeHandlers;
  /** The closed validator of the contract bundle, as the api loads it (apps/api schemas.ts). */
  readonly validator: SchemaValidator;
  /** The subject authentication establishes for the tenant's owner (a verified identity: email and MFA). */
  subject(t: Tenant): AuthenticatedSubject;
  /** A command of the tenant's owner through its handler, its answer checked against the route's contract. */
  command<Body, View>(t: Tenant, command: B07CommandId, path: Readonly<Record<string, string>>, body: Body, key?: string): Promise<CommandResult<View>>;
  /** A source read of the tenant's owner through its handler, its READ envelope checked against the route's contract. */
  read<View>(t: Tenant, operationId: keyof SourceReadHandlers, path: Readonly<Record<string, string>>): Promise<View>;
  /** The selection manifest intake of the tenant's owner, its STORED envelope checked against the route's contract. */
  submitManifest<View>(t: Tenant, revisionId: string, document: unknown): Promise<{ readonly created: boolean; readonly view: View }>;
}

/**
 * The product over the environment. `unitOfWork` replaces the request handlers' unit-of-work factory (default the harness's
 * kauro_app_test factory): a test decorates it to stand for a process that dies at a chosen point (B07-R1: between the seal's provider
 * hold and its commit).
 */
export function product(env: ControlEnv, options: { readonly unitOfWork?: SourceUnitOfWorkFactory } = {}): Product {
  const authorizer = createAuthorizer({ clock, assurance: createAssuranceVerifier() });
  const runtime: SourceRuntime = { unitOfWork: options.unitOfWork ?? env.h.app, authorizer, clock, ids };
  const sources = {
    providers: { storage: env.storage, vault: env.vault, origin: ORIGIN },
    preview: { reader: new IsolatedTablePreviewReader(), limits: inspectionLimits(), scratchDir: join(env.scratch, "preview") },
    commercialScope: commercialScopeInspector,
  };
  mkdirSync(sources.preview.scratchDir, { recursive: true });
  const handlers = createB07Handlers(runtime, sources);
  const readRuntime = { unitOfWork: env.h.app, authorizer, clock, cursorKey: new Uint8Array(randomBytes(32)) };
  const reads = createSourceReadHandlers(readRuntime, sources);
  const intakes = createSourceIntakeHandlers(readRuntime);
  const bundle = JSON.parse(readFileSync(new URL(import.meta.resolve("@kauro/contracts/schemas.json")), "utf8")) as ContractSchemaBundle;
  const validator = createSchemaValidator(bundle);
  const subject = (t: Tenant): AuthenticatedSubject => {
    const verifiedAt = clock.now();
    return { identity: { userId: t.ag.ownerUserId as UserId, state: "ACTIVE", emailVerifiedAt: verifiedAt, mfaEnrolledAt: verifiedAt }, provider: "identity-platform", subjectHash: textDigest(`subject:${t.ag.ownerUserId}`) };
  };
  const envelope = <Body>(t: Tenant, command: B07CommandId, path: Readonly<Record<string, string>>, body: Body, key?: string): CommandEnvelope<Body> => ({
    command,
    environment: "LOCAL",
    correlationId: ids.next() as CorrelationId,
    idempotencyKey: key ?? `e2e_${ids.next().replace(/-/g, "")}`,
    userId: t.ag.ownerUserId,
    subject: subject(t),
    agencyId: t.ag.agencyId,
    clientAddressHash: null,
    path,
    body,
    receivedAt: clock.now(),
  });
  return {
    handlers,
    reads,
    intakes,
    validator,
    subject,
    async command<Body, View>(t: Tenant, command: B07CommandId, path: Readonly<Record<string, string>>, body: Body, key?: string): Promise<CommandResult<View>> {
      const handler = handlers[command] as unknown as { execute(e: CommandEnvelope<Body>): Promise<CommandResult<View>> };
      return checkCommandReply(validator, command, await handler.execute(envelope(t, command, path, body, key)));
    },
    async read<View>(t: Tenant, operationId: keyof SourceReadHandlers, path: Readonly<Record<string, string>>): Promise<View> {
      const handler = reads[operationId] as unknown as { execute(r: Parameters<SourceReadHandlers["GetRevision"]["execute"]>[0]): Promise<ReadResult<View>> };
      const result = await handler.execute({ correlationId: ids.next() as CorrelationId, subject: subject(t), agencyId: t.ag.agencyId, path, query: { limit: 25, cursor: null } });
      return checkedRead(validator, operationId, result);
    },
    async submitManifest<View>(t: Tenant, revisionId: string, document: unknown): Promise<{ readonly created: boolean; readonly view: View }> {
      const result = (await intakes.SubmitSelectionManifest.execute({ correlationId: ids.next() as CorrelationId, subject: subject(t), agencyId: t.ag.agencyId, path: { revisionId }, body: document })) as IntakeResult<View>;
      return checkedIntake(validator, result);
    },
  };
}

/** Checks a command's answer as the transport does before sending it (the wire body against its route's declared contract). */
export function checkCommandReply<View>(validator: SchemaValidator, command: B07CommandId, result: CommandResult<View>): CommandResult<View> {
  const responses = commandRouteResponses(command, B07_COMMANDS[command].name);
  switch (result.kind) {
    case "COMPLETED":
      checkReply(validator, responses, result.status, "application/json", { kind: "COMPLETED", version: result.version, replayed: result.replayed, data: result.view });
      break;
    case "ACCEPTED":
      checkReply(validator, responses, result.status, "application/json", { kind: "ACCEPTED", operationId: result.operationId, state: result.state, statusPath: result.statusPath, pollAfterSeconds: result.pollAfterSeconds });
      break;
    default:
      checkReply(validator, responses, result.problem.status, "application/problem+json", result.problem);
  }
  return result;
}

/** Checks a read's answer as the transport does (the READ envelope) and returns its view. */
export function checkedRead<View>(validator: SchemaValidator, operationId: keyof SourceReadHandlers, result: ReadResult<View>): View {
  if (result.kind === "PROBLEM") assert.fail(`${operationId}: expected READ, got ${JSON.stringify(result.problem)}`);
  checkReply(validator, readRouteResponses(operationId), 200, "application/json", { kind: "READ", data: result.view });
  return result.view;
}

/** Checks the intake's answer as the transport does (201 or 200 with the STORED envelope). */
export function checkedIntake<View>(validator: SchemaValidator, result: IntakeResult<View>): { readonly created: boolean; readonly view: View } {
  if (result.kind === "PROBLEM") assert.fail(`SubmitSelectionManifest: expected STORED, got ${JSON.stringify(result.problem)}`);
  checkReply(validator, intakeRouteResponses("SubmitSelectionManifest"), result.created ? 201 : 200, "application/json", { kind: "STORED", data: result.view });
  return { created: result.created, view: result.view };
}

/**
 * The agency's activation as its OWNER records it (CMD002's writes: the accepted terms, privacy agreement and legal profile, version
 * + 1, agency.activated.v1). Customer data enters only an ACTIVE agency (CMD013).
 */
export async function activate(env: ControlEnv, t: Tenant): Promise<void> {
  await asRequestHandler(env, t, null, async (_s, emit, c) => {
    const r = await c.query<{ version: string }>(
      "UPDATE kauro.agencies SET state = 'ACTIVE', terms_version = 'TERMS-2026-1', privacy_agreement_version = 'DPA-2026-1', legal_profile_ref = $2, version = version + 1 WHERE agency_id = $1 AND state = 'DRAFT' RETURNING version::text",
      [t.ag.agencyId, ids.next()],
    );
    const version = r.rows[0]?.version;
    assert.ok(version !== undefined, "the agency was DRAFT");
    await emit("agency", t.ag.agencyId, Number(version), "agency.activated.v1", { agencyId: t.ag.agencyId });
  });
}

/** A COMPLETED result's view, or a failure naming the problem the handler answered instead. */
export function completedView<View>(result: CommandResult<View>, status: 200 | 201): View {
  if (result.kind !== "COMPLETED") assert.fail(`expected COMPLETED ${status}, got ${result.kind}: ${JSON.stringify("problem" in result ? result.problem : result)}`);
  assert.equal(result.status, status);
  return result.view;
}

/** The problem of a refused command: its HTTP status and reason. */
export function problemOf<View>(result: CommandResult<View>): { readonly status: number; readonly code: string; readonly reason: string | undefined } {
  if (result.kind === "COMPLETED" || result.kind === "ACCEPTED") assert.fail(`expected a refusal, got ${result.kind}`);
  return { status: result.problem.status, code: result.problem.code, reason: result.problem.reason };
}
