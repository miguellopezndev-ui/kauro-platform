// The request side of the product as package B08's end-to-end test runs it (mandate B08-INTEGRATION; docs/design/B08-audit-approval-
// jobs.md §2, §12, §15): B06's CreateProject (CMD011) and ApprovePlan (CMD025), the source lifecycle's ReserveUpload, CompleteUpload,
// SelectInputTables and SealRevision (CMD013, CMD014, CMD016, CMD017) with the selection manifest intake, the audit commands (CMD020,
// CMD021, CMD022, CMD024) with GetAudit and the decision-artifact intake, and the job commands (CMD036, CMD037) with GetJob of
// @kauro/application — exactly the handlers apps/api's composition root binds (assembleApi: createB06Handlers over the edition's plan
// services and inspectors, createB07Handlers over the source providers, createAuditHandlers over `cores`, createExecutionHandlers, the
// source and audit intakes and the audit and job reads)
// — on B06's pipeline (the real Authorizer of @kauro/authorization, journal reserve or replay, execute, journal commit) in the audit
// units of work of the request handlers' pool (kauro_app_test; the one factory apps/api opens, D8-PAU-9). The collaborators are the
// edition's own, rebuilt here from the same persistence readers because one entrypoint never imports another
// (architecture.rules.json): the decision artifacts of 0023 (decisionArtifactResolver), the patch compiler over the Intelligence
// core's plan compiler (patchCompilerOver), the real disclosure composer, the active-work, external-action, commercial-consequence and
// commercial-scope inspectors over B09's and B08's readings. The providers are the world's labelled contract fakes, the SAME ones its
// control plane is bound to (SIMULATED): B07's object storage and session vault, and the Intelligence core's plan compiler of
// B08-CORE-PORTS, the one core the request side reaches.
//
// Every command is admitted as the transport admits it (admitStructure: content type, strict JSON, the closed request schema, the
// idempotency key, the path ids and the agency selector), and every answer is checked as the transport checks it before sending
// (checkReply against the route's declared response schema and outcome catalogue, with the contract bundle's validator), so a view
// over rows the real control plane wrote that the api could not send fails here.
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AUDIT_COMMANDS,
  B06_COMMANDS,
  B07_COMMANDS,
  EXECUTION_COMMANDS,
  HEADERS,
  admitStructure,
  checkReply,
  commandRouteResponses,
  createAuditHandlers,
  createAuditIntakeHandlers,
  createAuditReadHandlers,
  createB06Handlers,
  createB07Handlers,
  createExecutionHandlers,
  createExecutionReadHandlers,
  createSchemaValidator,
  createSourceIntakeHandlers,
  disclosureComposer,
  envelopeOf,
  intakeRouteResponses,
  patchCompilerOver,
  readRouteResponses,
  type ActiveWorkInspector,
  type AuthenticatedSubject,
  type B06Collaborators,
  type B07Collaborators,
  type CommandResult,
  type CommandSpec,
  type CommercialConsequenceInspector,
  type CommercialScopeInspector,
  type ContractSchemaBundle,
  type CoreServices,
  type ExternalActionInspector,
  type IntakeResult,
  type ReadResult,
  type SchemaValidator,
} from "@kauro/application";
import { createAdmissionLimiter, createAssuranceVerifier, createAuthorizer } from "@kauro/authorization";
import { textDigest, type AgencyId, type CorrelationId, type UserId } from "@kauro/domain";
import { commercialAuthorizationsOf, commercialInspectionsOf, decisionArtifactResolver, executionReadsOf, sourceStoreOf } from "@kauro/persistence";
import { clock, ids, type ExecutionWorld } from "./execution-world.js";

/** The application origin every resumable session is bound to (09 "Resumable session security"). */
export const ORIGIN = "https://app.kauro.test";

/** A member of an agency acting through the product: the selector the request carries and the authenticated user. */
export interface Actor {
  readonly agencyId: string;
  readonly userId: string;
}

/** The commands of this run: B06's project and approval, B07's source lifecycle, the audit commands and the job commands. */
export type B08CommandId = "CMD011" | "CMD013" | "CMD014" | "CMD016" | "CMD017" | "CMD020" | "CMD021" | "CMD022" | "CMD024" | "CMD025" | "CMD036" | "CMD037";
export type B08ReadId = "GetAudit" | "GetJob";

export interface B08Product {
  /** The closed validator of the contract bundle, as the api loads it (apps/api schemas.ts). */
  readonly validator: SchemaValidator;
  /** A command of `actor` through its handler: admitted as the transport admits it, its answer checked against the route's contract. */
  command<View>(actor: Actor, command: B08CommandId, path: Readonly<Record<string, string>>, body: unknown, key?: string): Promise<CommandResult<View>>;
  /** A read of `actor` through its handler, its READ envelope checked against the route's contract. */
  read<View>(actor: Actor, operationId: B08ReadId, path: Readonly<Record<string, string>>): Promise<View>;
  /** The selection manifest intake of `actor`, its STORED envelope checked against the route's contract. */
  submitManifest<View>(actor: Actor, revisionId: string, document: unknown): Promise<{ readonly created: boolean; readonly view: View }>;
  /** The decision-artifact intake of `actor` (content-idempotent, not journaled; D8-CMA-7), its STORED envelope checked likewise. */
  submitDecisionArtifact<View>(actor: Actor, auditId: string, body: unknown): Promise<{ readonly created: boolean; readonly view: View }>;
}

/** The edition's inspectors (apps/api edition.ts), over the same persistence readings: B09's authorizations, then B08's jobs and packages. */
const activeWork: ActiveWorkInspector = {
  async inspectClient(uow, clientId) {
    return {
      openProjects: await uow.endClients.countOpenProjects(clientId),
      activeJobs: await executionReadsOf(uow).activeJobsOfClient(clientId),
      liveCommercialAuthorizations: await commercialInspectionsOf(uow).liveAuthorizationsOfClient(clientId),
    };
  },
};
const externalActions: ExternalActionInspector = {
  completedForPlan: (uow, planId) => executionReadsOf(uow).deliveredPackagesForPlan(planId),
};
const commercialConsequences: CommercialConsequenceInspector = {
  async unreconciledForPlan(uow, planId) {
    return [...(await commercialInspectionsOf(uow).unreconciledForPlan(planId)), ...(await executionReadsOf(uow).unreconciledJobsForPlan(planId))];
  },
};
const commercialScope: CommercialScopeInspector = {
  async authorizationsBoundTo(uow, agencyId, revisionId) {
    const revision = await sourceStoreOf(uow).revisions.get(revisionId);
    if (revision === null || revision.manifestHash === undefined) return [];
    return (await commercialAuthorizationsOf(uow).findLiveByRevisionHash(agencyId, revision.manifestHash)).map((a) => a.authorizationId);
  },
};

const SPECS = { ...B06_COMMANDS, ...B07_COMMANDS, ...AUDIT_COMMANDS, ...EXECUTION_COMMANDS };

export function b08Product(w: ExecutionWorld): B08Product {
  const authorizer = createAuthorizer({ clock, assurance: createAssuranceVerifier() });
  const unitOfWork = w.h.audit;
  const cores: CoreServices = { planCompiler: w.intelligence };
  const collaborators: B06Collaborators = {
    abuseLimiter: createAdmissionLimiter(),
    activeWork,
    externalActions,
    commercialConsequences,
    artifacts: decisionArtifactResolver,
    patchCompiler: patchCompilerOver(cores),
    disclosures: disclosureComposer,
  };
  const sources: B07Collaborators = { providers: { storage: w.storage, vault: w.vault, origin: ORIGIN }, preview: null, commercialScope };
  const runtime = { unitOfWork, authorizer, clock, ids };
  const handlers = { ...createB06Handlers(runtime, collaborators), ...createB07Handlers(runtime, sources), ...createAuditHandlers(runtime, cores), ...createExecutionHandlers(runtime) };
  const readRuntime = { unitOfWork, authorizer, clock, cursorKey: new Uint8Array(randomBytes(32)) };
  const reads = { ...createAuditReadHandlers(readRuntime), ...createExecutionReadHandlers(readRuntime) };
  const intakes = { ...createSourceIntakeHandlers(readRuntime), ...createAuditIntakeHandlers(readRuntime) };
  const bundle = JSON.parse(readFileSync(new URL(import.meta.resolve("@kauro/contracts/schemas.json")), "utf8")) as ContractSchemaBundle;
  const validator = createSchemaValidator(bundle);
  const subject = (userId: string): AuthenticatedSubject => {
    const verifiedAt = clock.now();
    return { identity: { userId: userId as UserId, state: "ACTIVE", emailVerifiedAt: verifiedAt, mfaEnrolledAt: verifiedAt }, provider: "identity-platform", subjectHash: textDigest(`subject:${userId}`) };
  };

  return {
    validator,

    async command<View>(actor: Actor, command: B08CommandId, path: Readonly<Record<string, string>>, body: unknown, key?: string): Promise<CommandResult<View>> {
      const spec = SPECS[command] as CommandSpec<unknown>;
      const admitted = admitStructure(
        spec,
        {
          headers: { "content-type": HEADERS.contentType, [HEADERS.idempotencyKey]: key ?? `b08_e2e_${ids.next().replace(/-/g, "")}`, [HEADERS.agency]: actor.agencyId },
          repeatedHeaders: [],
          correlationId: ids.next() as CorrelationId,
          params: path,
          body: new TextEncoder().encode(JSON.stringify(body)),
          clientAddressHash: null,
        },
        validator,
        clock,
      );
      if (admitted.kind === "PROBLEM") assert.fail(`${command}: the request is not admitted: ${JSON.stringify(admitted.problem)}`);
      const envelope = envelopeOf(command, "LOCAL", admitted.admission, subject(actor.userId));
      const handler = handlers[command] as unknown as { execute(e: typeof envelope): Promise<CommandResult<View>> };
      const result = await handler.execute(envelope);
      const responses = commandRouteResponses(command, spec.name);
      switch (result.kind) {
        case "COMPLETED":
          checkReply(validator, responses, result.status, HEADERS.contentType, { kind: "COMPLETED", version: result.version, replayed: result.replayed, data: result.view });
          break;
        case "ACCEPTED":
          checkReply(validator, responses, result.status, HEADERS.contentType, { kind: "ACCEPTED", operationId: result.operationId, state: result.state, statusPath: result.statusPath, pollAfterSeconds: result.pollAfterSeconds });
          break;
        default:
          checkReply(validator, responses, result.problem.status, HEADERS.problemContentType, result.problem);
      }
      return result;
    },

    async read<View>(actor: Actor, operationId: B08ReadId, path: Readonly<Record<string, string>>): Promise<View> {
      const handler = reads[operationId] as unknown as { execute(r: Parameters<(typeof reads)["GetJob"]["execute"]>[0]): Promise<ReadResult<View>> };
      const result = await handler.execute({ correlationId: ids.next() as CorrelationId, subject: subject(actor.userId), agencyId: actor.agencyId as AgencyId, path, query: { limit: 25, cursor: null } });
      if (result.kind === "PROBLEM") assert.fail(`${operationId}: expected READ, got ${JSON.stringify(result.problem)}`);
      checkReply(validator, readRouteResponses(operationId), 200, HEADERS.contentType, { kind: "READ", data: result.view });
      return result.view;
    },

    async submitManifest<View>(actor: Actor, revisionId: string, document: unknown): Promise<{ readonly created: boolean; readonly view: View }> {
      const result = (await intakes.SubmitSelectionManifest.execute({ correlationId: ids.next() as CorrelationId, subject: subject(actor.userId), agencyId: actor.agencyId as AgencyId, path: { revisionId }, body: document })) as IntakeResult<View>;
      if (result.kind === "PROBLEM") assert.fail(`SubmitSelectionManifest: expected STORED, got ${JSON.stringify(result.problem)}`);
      checkReply(validator, intakeRouteResponses("SubmitSelectionManifest"), result.created ? 201 : 200, HEADERS.contentType, { kind: "STORED", data: result.view });
      return { created: result.created, view: result.view };
    },

    async submitDecisionArtifact<View>(actor: Actor, auditId: string, body: unknown): Promise<{ readonly created: boolean; readonly view: View }> {
      const result = (await intakes.SubmitDecisionArtifact.execute({ correlationId: ids.next() as CorrelationId, subject: subject(actor.userId), agencyId: actor.agencyId as AgencyId, path: { auditId }, body })) as IntakeResult<View>;
      if (result.kind === "PROBLEM") assert.fail(`SubmitDecisionArtifact: expected STORED, got ${JSON.stringify(result.problem)}`);
      checkReply(validator, intakeRouteResponses("SubmitDecisionArtifact"), result.created ? 201 : 200, HEADERS.contentType, { kind: "STORED", data: result.view });
      return { created: result.created, view: result.view };
    },
  };
}

/** The ACCEPTED answer of a command (202): its operation, state and status path. */
export function acceptedOf<View>(result: CommandResult<View>): Extract<CommandResult<View>, { readonly kind: "ACCEPTED" }> {
  if (result.kind !== "ACCEPTED") assert.fail(`expected ACCEPTED 202, got ${result.kind}: ${JSON.stringify("problem" in result ? result.problem : result)}`);
  assert.equal(result.status, 202);
  return result;
}

/** A COMPLETED result's view, or a failure naming the problem the handler answered instead. */
export function completedOf<View>(result: CommandResult<View>, status: 200 | 201): View {
  if (result.kind !== "COMPLETED") assert.fail(`expected COMPLETED ${status}, got ${result.kind}: ${JSON.stringify("problem" in result ? result.problem : result)}`);
  assert.equal(result.status, status);
  return result.view;
}
