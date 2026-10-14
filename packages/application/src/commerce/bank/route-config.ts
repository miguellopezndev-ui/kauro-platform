/**
 * Route configuration and qualification of the bank-transfer route (lane L-ROUTE; docs/design/ACH-ROUTE.md r12 §7.1 R1 and R2 `Kroute`,
 * §7.29 enable condition, D-ACH-02, DV1-01): five owner commands and the owner's read, each in ONE commerce unit of work of the corporate
 * owner's OPERATOR context, journaled under the owner's own identity (agency NULL), its event agency-less (coordinator decision #1).
 *
 *   configure  (CMD201) the account, its first details evidence and configuration → PENDING_VERIFICATION, version 1 (201); the route's
 *              CONFIGURED payment_routes row through kauro.register_bank_payment_route (decision #2).
 *   verify     (CMD202) R1: the details evidence of the current version read from the restricted store and classified BEFORE the route
 *              lock (a replacement or a disable meanwhile is seen under the lock); then Kroute: the expected version, the state, the
 *              details' validity and the owner's step-up, all judged at the effect instant read after the lock → VERIFIED.
 *   enable     (CMD203) the route lock FIRST (before the owner's access decision: a revocation of the grant issued while the enable waits
 *              is never blocked by it — lock-order note of migration 0046), the expected version and the route's version as observed
 *              before the lock (the loser of a race rechecks it under the lock), the step-up at the effect instant, the details evidence
 *              re-read and re-classified under the lock (internal store read, no external call-out: coordinator decision (c)), a verified
 *              version; GENERAL only when the enable condition of §7.29 holds → ENABLED with the allowlist of this version.
 *   disable    (CMD204) the route lock first, the version checks and the step-up → VERIFIED; no evidence is needed for a safety stop.
 *   details    (CMD205) the new details evidence read and bound to the route's account before the lock → a new version, PENDING_VERIFICATION.
 *
 * Every version check answers STALE_VERSION ROUTE_VERSION_CHANGED; a state the command cannot leave answers PRECONDITION_FAILED
 * UNLISTED_TRANSITION (verify, disable) or ROUTE_NOT_VERIFIED (enable). The command ids CMD201..CMD205 are the lane's operational ids of the
 * command journal (they are not registry commands; the vendored registry is unchanged).
 */
import type { CommandId, Sha256Hex, UtcInstant } from "@kauro/contracts";
import { rawDigest } from "@kauro/contracts";
import type { AssuranceProofId, BankRouteDetails, CausationId, BankRouteRecord, BankRouteVersionRecord, Clock, CommerceUnitOfWork, CorrelationId, Environment, OperatorContext, UserId } from "@kauro/domain";
import { COMMERCE_POLICY_VERSION, DomainFailure, NotFoundFailure, PROVIDER_CALL_TIMEOUT_MS, StaleVersionFailure, actorOf, beforeCommitOf, isUuidV7, toUtcInstant } from "@kauro/domain";
import { judgedUnderHold, type RequestAuthority } from "../../api/authority.js";
import type { AuthenticatedSubject, CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { problemOf, type Problem } from "../../api/problems.js";
import type { StoredBankEvidence } from "../ports.js";
import { CommerceAccessDenied, operatorContextOf, recordCommerceDenial, runCommerceCommand, type CommerceRequestRuntime, type RunnableCommand } from "../request/runtime.js";
import type { BankRouteCollaborators } from "./ports.js";

// --- requests and views ---------------------------------------------------------------------------------------------------------------

export interface ConfigureBankRouteBody {
  readonly provider: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly currency: "USD";
  readonly acceptedRails: ReadonlyArray<"ACH" | "DOMESTIC_WIRE">;
  readonly detailsArtifactRef: string;
  readonly detailsEvidenceHash: string;
  readonly minimumTransferWindowMs: number;
  readonly instructionLifetimeMs: number;
  readonly providerTimeToleranceMs: number;
  readonly feePolicyVersion: string;
  readonly timingSource: { readonly url: string; readonly accessedOn: string };
}
export interface VerifyBankRouteBody {
  readonly expectedVersion: number;
  readonly verificationEvidenceRef: string;
  readonly authorizationRef: string;
}
export interface EnableBankRouteBody {
  readonly expectedVersion: number;
  readonly rollout: "CONTROLLED" | "GENERAL";
  readonly participants: ReadonlyArray<string>;
  readonly authorizationRef: string;
  readonly qualificationOrderId?: string;
}
export interface DisableBankRouteBody {
  readonly expectedVersion: number;
  readonly authorizationRef: string;
}
export interface ReplaceBankRouteDetailsBody {
  readonly expectedVersion: number;
  readonly detailsArtifactRef: string;
  readonly detailsEvidenceHash: string;
  readonly authorizationRef: string;
}

export interface BankRouteView {
  readonly routeId: string;
  /** The details/configuration version (what expectedVersion names). */
  readonly routeVersion: number;
  /** The aggregate version (the envelope's version). */
  readonly version: number;
  readonly state: BankRouteRecord["state"];
  readonly rollout: BankRouteRecord["rollout"];
  readonly environment: BankRouteRecord["environment"];
  readonly accountRef: string;
  readonly detailsEvidenceHash: string;
  readonly verified: boolean;
}

export interface BankRouteCommandView {
  readonly route: BankRouteView;
}

/** What the transport admitted for one owner route command (the person authenticated, the body validated by its closed schema). */
export interface BankRouteRequest<Body> {
  readonly environment: Environment;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: string;
  readonly subject: AuthenticatedSubject;
  readonly path: Readonly<Record<string, string>>;
  readonly body: Body;
  readonly receivedAt: string;
  /** The request's credential, held at the command's COMMIT (FAILURE-MATRIX-TEMPLATE rule 16); absent for an in-process caller. */
  readonly authority?: RequestAuthority;
}

export const BANK_ROUTE_COMMAND_IDS = Object.freeze({ configure: "CMD201", verify: "CMD202", enable: "CMD203", disable: "CMD204", details: "CMD205" } as const);
type BankRouteCommandId = (typeof BANK_ROUTE_COMMAND_IDS)[keyof typeof BANK_ROUTE_COMMAND_IDS];
const commandOf = (id: BankRouteCommandId): RunnableCommand => ({ id, journalScope: "OPERATOR_IDENTITY" });

export function bankRouteView(route: BankRouteRecord, version: BankRouteVersionRecord): BankRouteView {
  return {
    routeId: route.routeId,
    routeVersion: route.currentVersion,
    version: route.version,
    state: route.state,
    rollout: route.rollout,
    environment: route.environment,
    accountRef: route.accountRef,
    detailsEvidenceHash: version.detailsEvidenceHash,
    verified: version.verifiedAt !== null,
  };
}

function envelopeOf<Body>(id: BankRouteCommandId, request: BankRouteRequest<Body>): CommandEnvelope<Body> {
  return {
    command: id as CommandId,
    environment: request.environment,
    correlationId: request.correlationId,
    idempotencyKey: request.idempotencyKey,
    userId: request.subject.identity.userId as UserId,
    subject: request.subject,
    agencyId: null,
    clientAddressHash: null,
    path: request.path,
    body: request.body,
    receivedAt: request.receivedAt,
    ...(request.authority === undefined ? {} : { authority: request.authority }),
  };
}

// --- failures -----------------------------------------------------------------------------------------------------------------------

export const routeVersionChanged = (route: Pick<BankRouteRecord, "currentVersion" | "state">): DomainFailure => new StaleVersionFailure(route.currentVersion, route.state, { reason: "ROUTE_VERSION_CHANGED" });
const unlisted = (route: BankRouteRecord): DomainFailure => new DomainFailure("PRECONDITION_FAILED", `the route cannot leave ${route.state} this way`, { reason: "UNLISTED_TRANSITION", currentVersion: route.currentVersion, currentState: route.state });
export const evidenceUnavailable = (): DomainFailure => new DomainFailure("CAPACITY_UNAVAILABLE", "the details evidence could not be read within its bound", { reason: "EVIDENCE_UNAVAILABLE" }, true);

// --- the details evidence (R1) ------------------------------------------------------------------------------------------------------

/** What an evidence read binds: the account and environment always; the route's provider and integration class once it exists. */
export interface EvidenceBinding {
  readonly accountRef: string;
  readonly environment: string;
  readonly provider?: string;
  readonly integrationClass?: BankRouteRecord["integrationClass"];
}

/** The route class an artifact stands for: a contract fake stays a contract fake; a provider integration and owner-supplied manual evidence are a real account. */
export function integrationClassOf(evidence: Pick<StoredBankEvidence, "integrationClass">): BankRouteRecord["integrationClass"] {
  return evidence.integrationClass === "CONTRACT_FAKE" ? "CONTRACT_FAKE" : "PROVIDER";
}

/**
 * Reads the details artifact from the restricted store under the provider-call bound and classifies it: the stored envelope must be the
 * expected hash, its bytes classify (fail closed), and the account and environment must be the route's; once the route exists (verify,
 * enable, replacement, I3) its provider and integration class are bound too (adversary r1 ADV-PV1R-11): a contract fake never stands for
 * provider evidence, nor one provider's artifact for another's — DETAILS_ACCOUNT_MISMATCH. Any failure is a DomainFailure; an unexpected
 * exception (a crash of the store) propagates untouched.
 */
export async function readRouteDetails(co: BankRouteCollaborators, ref: string, expectedHash: string, route: EvidenceBinding): Promise<{ readonly details: BankRouteDetails; readonly evidence: StoredBankEvidence }>;
export async function readRouteDetails(co: BankRouteCollaborators, ref: string, expectedHash: string, route: EvidenceBinding, options: { readonly classify: false }): Promise<{ readonly details: BankRouteDetails | null; readonly evidence: StoredBankEvidence }>;
export async function readRouteDetails(co: BankRouteCollaborators, ref: string, expectedHash: string, route: EvidenceBinding, options: { readonly classify: boolean } = { classify: true }): Promise<{ readonly details: BankRouteDetails | null; readonly evidence: StoredBankEvidence }> {
  const store = co.evidence();
  const classifier = co.classifier();
  if (store === null || classifier === null) throw evidenceUnavailable();
  const bound = co.timer.start(PROVIDER_CALL_TIMEOUT_MS);
  let read: { readonly evidence: StoredBankEvidence | null } | null;
  try {
    read = await Promise.race([store.get(ref).then((evidence) => ({ evidence })), bound.elapsed.then(() => null)]);
  } finally {
    bound.cancel();
  }
  if (read === null) throw evidenceUnavailable();
  const evidence = read.evidence;
  if (evidence === null) throw new DomainFailure("NOT_FOUND", "the details artifact is not in the restricted store", { reason: "EVIDENCE_NOT_FOUND" });
  if (evidence.sha256 !== expectedHash) throw new DomainFailure("INTEGRITY_FAILURE", "the details artifact is not the evidence the route cites", { reason: "HASH_MISMATCH" });
  if (evidence.accountRef !== route.accountRef || evidence.environment !== route.environment) {
    throw new DomainFailure("PRECONDITION_FAILED", "the details evidence is of another account", { reason: "DETAILS_ACCOUNT_MISMATCH" });
  }
  if (route.provider !== undefined && route.integrationClass !== undefined && (evidence.provider !== route.provider || integrationClassOf(evidence) !== route.integrationClass)) {
    throw new DomainFailure("PRECONDITION_FAILED", "the details evidence is of another integration", { reason: "DETAILS_ACCOUNT_MISMATCH" });
  }
  const classified = classifier.classifyAccountDetails(evidence);
  if (!options.classify) {
    // bound to the account only; a version whose evidence does not classify is refused by verify
    if (classified.kind === "CLASSIFIED" && classified.value.accountRef !== route.accountRef) throw new DomainFailure("PRECONDITION_FAILED", "the details evidence is of another account", { reason: "DETAILS_ACCOUNT_MISMATCH" });
    if (classified.kind === "REJECTED" && classified.code !== "MALFORMED_EVIDENCE") throw new DomainFailure("INTEGRITY_FAILURE", `the details evidence was refused: ${classified.code}`, { reason: classified.code });
    return { details: classified.kind === "CLASSIFIED" ? classified.value : null, evidence };
  }
  if (classified.kind === "REJECTED") throw new DomainFailure("INTEGRITY_FAILURE", `the details evidence was refused: ${classified.code}`, { reason: classified.code });
  if (evidence.accountRef !== route.accountRef || classified.value.accountRef !== route.accountRef || evidence.environment !== route.environment) {
    throw new DomainFailure("PRECONDITION_FAILED", "the details evidence is of another account", { reason: "DETAILS_ACCOUNT_MISMATCH" });
  }
  return { details: classified.value, evidence };
}

const detailsExpired = (): DomainFailure => new DomainFailure("PRECONDITION_FAILED", "the details evidence expired", { reason: "DETAILS_EXPIRED" });
const stepUpRefused = (reason: "STEP_UP_STALE" | "STEP_UP_MISSING" | "STEP_UP_NOT_OWNED"): DomainFailure => new DomainFailure("ASSURANCE_REQUIRED", "the owner's step-up is not fresh at the effect", { reason });

/**
 * The effect instant with the owner's step-up and (verify, enable) the details validity judged at it (TIME-AFTER-AWAIT, PV1R-03 r2):
 * the proof is read first (the verifier's own I/O), THEN the effect clock is read, and every time judgment uses that last instant with no
 * await after it. A proof or details validity that crosses its boundary while the proof read waits is refused, never judged at an earlier
 * sample. DETAILS_EXPIRED precedes the step-up refusal at one instant (the order of the commands' original checks).
 */
export async function assuredAt(co: BankRouteCollaborators, uow: CommerceUnitOfWork, userId: UserId, authorizationRef: string, detailsValidUntil: string | null): Promise<UtcInstant> {
  const outcome = await co.assurance.verifyStepUp(uow, userId, isUuidV7(authorizationRef) ? (authorizationRef as AssuranceProofId) : undefined, await co.effectNow(uow));
  const at = await co.effectNow(uow);
  // no await below this line: the judgments and the instant the caller writes are this one
  if (detailsValidUntil !== null && Date.parse(at) >= Date.parse(detailsValidUntil)) throw detailsExpired();
  if (outcome.kind !== "FRESH") throw stepUpRefused(outcome.reason);
  if (outcome.freshUntil === undefined || !(Date.parse(at) < Date.parse(outcome.freshUntil))) throw stepUpRefused("STEP_UP_STALE");
  return at;
}

/**
 * The committed instant's judgement (PV1R-03): immediately before COMMIT, after every wait of the command, the effect clock is read again
 * and the details validity (verify, enable) and the owner's step-up are judged at it. Crossing either boundary after the command's earlier
 * decision refuses the command with nothing committed (the unit rolls back: no route change, no event, no journal row).
 */
export function judgedAtCommit(co: BankRouteCollaborators, uow: CommerceUnitOfWork, userId: UserId, authorizationRef: string, detailsValidUntil: string | null, authority: RequestAuthority | undefined, clock: Clock): void {
  beforeCommitOf(uow, async () => {
    // rule 16 (PV1R-07 r4): the caller's session row locked FOR SHARE in this unit (its COMMIT is the release), THEN the proof read
    // and the effect clock with their judgments (PV1R-03 r2), THEN the session judged at the process clock read last; only COMMIT follows
    await judgedUnderHold(authority, uow, clock, async () => void (await assuredAt(co, uow, userId, authorizationRef, detailsValidUntil)));
  });
}

export const STEP_UP_ALLOW = { reasonCode: ALLOW_REASONS.STEP_UP_FRESH, assuranceClass: "STEP_UP" as const, policyVersion: COMMERCE_POLICY_VERSION };

/** The payee digest of a bank route's payment route: the account in its environment (no account number enters it). */
export function bankPayeeDigest(environment: string, accountRef: string): Sha256Hex {
  return rawDigest(new TextEncoder().encode(`kauro.bank-route.payee|${environment}|${accountRef}`)) as Sha256Hex;
}

async function publish(uow: CommerceUnitOfWork, causationId: CausationId, route: BankRouteRecord, eventType: "bank_route.configured.v1" | "bank_route.verified.v1" | "bank_route.enabled.v1" | "bank_route.disabled.v1" | "bank_route.details_replaced.v1", payload: Readonly<Record<string, string | number>>): Promise<void> {
  const context = uow.context;
  if (context.kind !== "OPERATOR") throw new DomainFailure("INTEGRITY_FAILURE", "a route event is the corporate owner's");
  await uow.events.publish({ aggregateKind: "bank_route", aggregateId: route.routeId as never, aggregateVersion: route.version, agencyId: null, eventType, actor: actorOf(context), causationId, correlationId: context.correlationId, payload: { routeId: route.routeId, ...payload } });
}

// --- the commands -------------------------------------------------------------------------------------------------------------------

export interface BankRouteHandlers {
  configure(request: BankRouteRequest<ConfigureBankRouteBody>): Promise<CommandResult<BankRouteCommandView>>;
  verify(request: BankRouteRequest<VerifyBankRouteBody>): Promise<CommandResult<BankRouteCommandView>>;
  enable(request: BankRouteRequest<EnableBankRouteBody>): Promise<CommandResult<BankRouteCommandView>>;
  disable(request: BankRouteRequest<DisableBankRouteBody>): Promise<CommandResult<BankRouteCommandView>>;
  replaceDetails(request: BankRouteRequest<ReplaceBankRouteDetailsBody>): Promise<CommandResult<BankRouteCommandView>>;
  get(request: { readonly correlationId: CorrelationId; readonly subject: AuthenticatedSubject; readonly routeId: string; readonly authority?: RequestAuthority }): Promise<{ readonly kind: "READ"; readonly view: BankRouteCommandView } | { readonly kind: "PROBLEM"; readonly problem: Problem }>;
}

export function createBankRouteHandlers(runtime: CommerceRequestRuntime, co: BankRouteCollaborators): BankRouteHandlers {
  const replayVersion = (view: BankRouteCommandView): number => view.route.version;

  async function authorizeOwner(uow: CommerceUnitOfWork, envelope: CommandEnvelope<unknown>, what: string): Promise<void> {
    const decision = await runtime.commerceAuthorizer.authorizeOperator(uow, { identity: envelope.subject.identity, role: "KAURO_OWNER" });
    if (decision.kind === "DENY") throw CommerceAccessDenied.of(what, decision);
  }

  async function currentVersionOf(uow: CommerceUnitOfWork, route: BankRouteRecord): Promise<BankRouteVersionRecord> {
    const v = await co.routes(uow).version(route.routeId, route.currentVersion);
    if (v === null) throw new DomainFailure("INTEGRITY_FAILURE", "a route has no row for its current version");
    return v;
  }

  return {
    async configure(request) {
      const id = BANK_ROUTE_COMMAND_IDS.configure;
      const envelope = envelopeOf(id, request);
      const context = operatorContextOf(envelope);
      return runCommerceCommand<ConfigureBankRouteBody, BankRouteCommandView>(runtime, {
        command: commandOf(id),
        envelope,
        context,
        replayVersion,
        access: (uow) => authorizeOwner(uow, envelope, id),
        async body(uow, causationId, now) {
          const body = envelope.body;
          const repo = co.routes(uow);
          const { details, evidence } = await readRouteDetails(co, body.detailsArtifactRef, body.detailsEvidenceHash, { accountRef: body.accountRef, environment: body.environment });
          if (evidence.provider !== body.provider) throw new DomainFailure("PRECONDITION_FAILED", "the details evidence is of another integration", { reason: "DETAILS_ACCOUNT_MISMATCH" });
          if (evidence.integrationClass === "CONTRACT_FAKE" && body.environment === "LIVE") throw new DomainFailure("PRECONDITION_FAILED", "a contract fake never carries live money", { reason: "ROUTE_NOT_VERIFIED" });
          if ((await repo.findByAccount(body.environment, body.accountRef)) !== null) throw new DomainFailure("PRECONDITION_FAILED", "the account already has a route", { reason: "UNLISTED_TRANSITION" });
          // a contract fake stays a contract fake; a provider integration and owner-supplied manual evidence are a real account
          const integrationClass = integrationClassOf(evidence);
          const routeId = uow.ids.next();
          const paymentRouteId = uow.ids.next();
          await repo.registerPaymentRoute({ paymentRouteId, provider: body.provider, environment: body.environment, merchantRef: routeId, payeeDigest: bankPayeeDigest(body.environment, body.accountRef), integrationClass });
          const route = await repo.insertRoute({ routeId, environment: body.environment, accountRef: body.accountRef, provider: body.provider, integrationClass, paymentRouteId, createdBy: envelope.userId });
          await repo.insertVersion({
            routeId,
            routeVersion: 1,
            detailsArtifactRef: body.detailsArtifactRef,
            detailsEvidenceHash: body.detailsEvidenceHash,
            payeeDigest: details.payeeDigest,
            acceptedRails: body.acceptedRails,
            minimumTransferWindowMs: body.minimumTransferWindowMs,
            instructionLifetimeMs: body.instructionLifetimeMs,
            providerTimeToleranceMs: body.providerTimeToleranceMs,
            feePolicyVersion: body.feePolicyVersion,
            timingSourceUrl: body.timingSource.url,
            timingSourceAccessedOn: body.timingSource.accessedOn,
            createdBy: envelope.userId,
          });
          await publish(uow, causationId, route, "bank_route.configured.v1", { routeVersion: 1, environment: route.environment, detailsEvidenceHash: body.detailsEvidenceHash, state: route.state });
          const view: BankRouteCommandView = { route: bankRouteView(route, await currentVersionOf(uow, route)) };
          void now;
          return { status: 201, view, version: route.version, resourceKind: "bank_route", resourceId: routeId };
        },
      });
    },

    async verify(request) {
      const id = BANK_ROUTE_COMMAND_IDS.verify;
      const envelope = envelopeOf(id, request);
      const context = operatorContextOf(envelope);
      const routeId = request.path["routeId"]!;
      return runCommerceCommand<VerifyBankRouteBody, BankRouteCommandView>(runtime, {
        command: commandOf(id),
        envelope,
        context,
        replayVersion,
        access: (uow) => authorizeOwner(uow, envelope, id),
        async body(uow, causationId) {
          const body = envelope.body;
          const repo = co.routes(uow);
          // R1: the current version's evidence, read and classified before the route lock
          const seen = await repo.read(routeId);
          if (seen === null) throw new NotFoundFailure("bank route");
          const seenVersion = await currentVersionOf(uow, seen);
          const { details } = await readRouteDetails(co, seenVersion.detailsArtifactRef, seenVersion.detailsEvidenceHash, seen);
          // Kroute: under the route lock, every fact judged at the effect instant read after the wait
          const route = await repo.lockForUpdate(routeId);
          if (route === null) throw new NotFoundFailure("bank route");
          if (route.currentVersion !== body.expectedVersion || route.currentVersion !== seen.currentVersion) throw routeVersionChanged(route);
          if (route.state !== "PENDING_VERIFICATION") throw unlisted(route);
          const effect = await assuredAt(co, uow, envelope.userId, body.authorizationRef, details.validUntil);
          judgedAtCommit(co, uow, envelope.userId, body.authorizationRef, details.validUntil, envelope.authority, runtime.clock);
          const verified = await repo.update(routeId, route.version, { state: "VERIFIED", rollout: null, currentVersion: route.currentVersion });
          await repo.markVerified(routeId, route.currentVersion, body.verificationEvidenceRef, envelope.userId, effect, toUtcInstant(Date.parse(details.validUntil)));
          await publish(uow, causationId, verified, "bank_route.verified.v1", { routeVersion: verified.currentVersion, detailsEvidenceHash: seenVersion.detailsEvidenceHash, previousState: route.state });
          return { status: 200, view: { route: bankRouteView(verified, await currentVersionOf(uow, verified)) }, version: verified.version, resourceKind: "bank_route", resourceId: routeId, allowFact: STEP_UP_ALLOW };
        },
      });
    },

    async enable(request) {
      const id = BANK_ROUTE_COMMAND_IDS.enable;
      const envelope = envelopeOf(id, request);
      const context = operatorContextOf(envelope);
      const routeId = request.path["routeId"]!;
      let seen: BankRouteRecord | null = null;
      let locked: BankRouteRecord | null = null;
      return runCommerceCommand<EnableBankRouteBody, BankRouteCommandView>(runtime, {
        command: commandOf(id),
        envelope,
        context,
        replayVersion,
        async access(uow) {
          // the route lock before the owner's access decision (lock-order note, migration 0046)
          const repo = co.routes(uow);
          seen = await repo.read(routeId);
          locked = seen === null ? null : await repo.lockForUpdate(routeId);
          await authorizeOwner(uow, envelope, id);
        },
        async body(uow, causationId) {
          const body = envelope.body;
          const repo = co.routes(uow);
          const route = locked;
          if (route === null || seen === null) throw new NotFoundFailure("bank route");
          if (route.currentVersion !== body.expectedVersion || route.version !== seen.version) throw routeVersionChanged(route);
          if (route.state !== "VERIFIED" && route.state !== "ENABLED") throw new DomainFailure("PRECONDITION_FAILED", "the route is not verified", { reason: "ROUTE_NOT_VERIFIED", currentVersion: route.currentVersion, currentState: route.state });
          const version = await currentVersionOf(uow, route);
          if (version.verifiedAt === null) throw new DomainFailure("PRECONDITION_FAILED", "the route's current details are not verified", { reason: "ROUTE_NOT_VERIFIED", currentVersion: route.currentVersion, currentState: route.state });
          await assuredAt(co, uow, envelope.userId, body.authorizationRef, null);
          // the qualifying evidence still holds under the lock (internal store read, no external call-out)
          const { details } = await readRouteDetails(co, version.detailsArtifactRef, version.detailsEvidenceHash, route);
          // PV1R-03: the details and the step-up judged at an instant read after the evidence read returned, never at the pre-read sample
          await assuredAt(co, uow, envelope.userId, body.authorizationRef, details.validUntil);
          judgedAtCommit(co, uow, envelope.userId, body.authorizationRef, details.validUntil, envelope.authority, runtime.clock);
          if (body.rollout === "GENERAL" && !(await generalConditionHolds(uow, route, body.qualificationOrderId))) {
            throw new DomainFailure("PRECONDITION_FAILED", "the general rollout's enable condition does not hold", { reason: "GENERAL_ENABLE_CONDITION_UNMET" });
          }
          if (body.rollout === "CONTROLLED" && body.participants.length === 0) throw new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields: [{ field: "participants", code: "RANGE" }] });
          const enabled = await repo.update(routeId, route.version, { state: "ENABLED", rollout: body.rollout, currentVersion: route.currentVersion, participantsVersion: route.version + 1 });
          await repo.appendParticipants(routeId, enabled.version, body.rollout === "CONTROLLED" ? body.participants : []);
          await publish(uow, causationId, enabled, "bank_route.enabled.v1", { routeVersion: enabled.currentVersion, rollout: body.rollout, participantCount: body.rollout === "CONTROLLED" ? new Set(body.participants).size : 0, previousState: route.state });
          return { status: 200, view: { route: bankRouteView(enabled, version) }, version: enabled.version, resourceKind: "bank_route", resourceId: routeId, allowFact: STEP_UP_ALLOW };
        },
      });
    },

    async disable(request) {
      const id = BANK_ROUTE_COMMAND_IDS.disable;
      const envelope = envelopeOf(id, request);
      const context = operatorContextOf(envelope);
      const routeId = request.path["routeId"]!;
      let seen: BankRouteRecord | null = null;
      let locked: BankRouteRecord | null = null;
      return runCommerceCommand<DisableBankRouteBody, BankRouteCommandView>(runtime, {
        command: commandOf(id),
        envelope,
        context,
        replayVersion,
        async access(uow) {
          const repo = co.routes(uow);
          seen = await repo.read(routeId);
          locked = seen === null ? null : await repo.lockForUpdate(routeId);
          await authorizeOwner(uow, envelope, id);
        },
        async body(uow, causationId) {
          const body = envelope.body;
          const repo = co.routes(uow);
          const route = locked;
          if (route === null || seen === null) throw new NotFoundFailure("bank route");
          if (route.currentVersion !== body.expectedVersion || route.version !== seen.version) throw routeVersionChanged(route);
          if (route.state !== "ENABLED") throw unlisted(route);
          await assuredAt(co, uow, envelope.userId, body.authorizationRef, null);
          judgedAtCommit(co, uow, envelope.userId, body.authorizationRef, null, envelope.authority, runtime.clock);
          const disabled = await repo.update(routeId, route.version, { state: "VERIFIED", rollout: null, currentVersion: route.currentVersion });
          await publish(uow, causationId, disabled, "bank_route.disabled.v1", { routeVersion: disabled.currentVersion, previousState: route.state });
          return { status: 200, view: { route: bankRouteView(disabled, await currentVersionOf(uow, disabled)) }, version: disabled.version, resourceKind: "bank_route", resourceId: routeId, allowFact: STEP_UP_ALLOW };
        },
      });
    },

    async replaceDetails(request) {
      const id = BANK_ROUTE_COMMAND_IDS.details;
      const envelope = envelopeOf(id, request);
      const context = operatorContextOf(envelope);
      const routeId = request.path["routeId"]!;
      return runCommerceCommand<ReplaceBankRouteDetailsBody, BankRouteCommandView>(runtime, {
        command: commandOf(id),
        envelope,
        context,
        replayVersion,
        access: (uow) => authorizeOwner(uow, envelope, id),
        async body(uow, causationId) {
          const body = envelope.body;
          const repo = co.routes(uow);
          const seen = await repo.read(routeId);
          if (seen === null) throw new NotFoundFailure("bank route");
          // the new evidence is bound to the route's account before the lock; it is classified at verification (R1), so incomplete details
          // become an unqualified version that verify refuses, never a partial snapshot
          const { details } = await readRouteDetails(co, body.detailsArtifactRef, body.detailsEvidenceHash, seen, { classify: false });
          const route = await repo.lockForUpdate(routeId);
          if (route === null) throw new NotFoundFailure("bank route");
          if (route.currentVersion !== body.expectedVersion) throw routeVersionChanged(route);
          await assuredAt(co, uow, envelope.userId, body.authorizationRef, null);
          judgedAtCommit(co, uow, envelope.userId, body.authorizationRef, null, envelope.authority, runtime.clock);
          const previous = await currentVersionOf(uow, route);
          const next = route.currentVersion + 1;
          await repo.insertVersion({
            routeId,
            routeVersion: next,
            detailsArtifactRef: body.detailsArtifactRef,
            detailsEvidenceHash: body.detailsEvidenceHash,
            payeeDigest: details?.payeeDigest ?? null,
            acceptedRails: previous.acceptedRails,
            minimumTransferWindowMs: previous.minimumTransferWindowMs,
            instructionLifetimeMs: previous.instructionLifetimeMs,
            providerTimeToleranceMs: previous.providerTimeToleranceMs,
            feePolicyVersion: previous.feePolicyVersion,
            timingSourceUrl: previous.timingSourceUrl,
            timingSourceAccessedOn: previous.timingSourceAccessedOn,
            createdBy: envelope.userId,
          });
          const replaced = await repo.update(routeId, route.version, { state: "PENDING_VERIFICATION", rollout: null, currentVersion: next });
          await publish(uow, causationId, replaced, "bank_route.details_replaced.v1", { routeVersion: next, detailsEvidenceHash: body.detailsEvidenceHash, previousState: route.state });
          return { status: 200, view: { route: bankRouteView(replaced, await currentVersionOf(uow, replaced)) }, version: replaced.version, resourceKind: "bank_route", resourceId: routeId, allowFact: STEP_UP_ALLOW };
        },
      });
    },

    async get(request) {
      const context: OperatorContext = { kind: "OPERATOR", userId: request.subject.identity.userId as UserId, correlationId: request.correlationId };
      let denied = false;
      try {
        const view = await runtime.unitOfWork.run(context, async (uow) => {
          const decision = await runtime.commerceAuthorizer.authorizeOperator(uow, { identity: request.subject.identity, role: "KAURO_OWNER" });
          if (decision.kind === "DENY") {
            denied = true;
            throw CommerceAccessDenied.of("READ_BANK_ROUTE", decision);
          }
          const route = await co.routes(uow).read(request.routeId);
          if (route === null) throw new NotFoundFailure("bank route");
          const view = { route: bankRouteView(route, await currentVersionOf(uow, route)) };
          // rule 16: the view is answered only under the caller's session as fenced in this unit (row locked FOR SHARE, THEN the clock, THEN the judgment)
          await judgedUnderHold(request.authority, uow, runtime.clock);
          return view;
        });
        return { kind: "READ", view };
      } catch (e) {
        if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
        if (denied || e.code === "AUTHENTICATION_REQUIRED") await recordCommerceDenial(runtime, context, "READ_BANK_ROUTE", e, null);
        return { kind: "PROBLEM", problem: problemOf(e, request.correlationId) };
      }
    },
  };

  /**
   * §7.29: GENERAL needs one payment of the route whose credit was reconciled (its bank order CAPTURED) and whose own refund was RECORDED
   * with send evidence. The refund half is lane L-REFUND's (its tables and their owner read arrive with it): until then the condition
   * fails closed — no GENERAL rollout is possible on L-ROUTE alone (ACH-M-R2-GENERAL; reported to the coordinator).
   */
  async function generalConditionHolds(uow: CommerceUnitOfWork, route: BankRouteRecord, qualificationOrderId: string | undefined): Promise<boolean> {
    if (qualificationOrderId === undefined) return false;
    const instructions = await co.routes(uow).instructionsOf(qualificationOrderId);
    if (instructions === null || instructions.routeId !== route.routeId || instructions.orderState !== "CAPTURED") return false;
    // the refund half (RECORDED with send evidence) is not observable before lane L-REFUND: fail closed
    return false;
  }
}

export type { CorrelationId };
