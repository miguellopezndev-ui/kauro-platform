/**
 * CMD035 IssueTaxDocument, its reconciler and the credit notes an issued invoice validates (package B15 lane L6; docs/design/
 * B15-B17-B18-local-plan.md sections 2-5, M6; R2-083, R2-084, CMD035-OK/DENY/RACE). Coded against the repository ports of @kauro/domain
 * and the issuance route port below; no provider call runs inside a transaction.
 *
 *  intent (one SERVICE unit of work, the stored operation's scope adopted): journal reserve -> the global fiscal order (r21) — the
 *    agency profile's shared half -> the issuer's shared half (0074 widened it to every judged column) -> the profile row -> the
 *    document row FOR NO KEY UPDATE -> the document's exclusive half — then effectNowOf (kauro.effect_now(), after every lock) and the
 *    judgments, and the intent UPDATE VALIDATED -> SUBMITTING with no await between (r15, r25): the route gate of R2-083 (a PROVIDER_API
 *    issuer QUALIFIED with entitlement evidence, or a MANUAL_BRIDGE issuer), the validity of section 2 (issuer valid_from known and
 *    reached, valid_until not reached; profile in force and not superseded), no unreconciled prior submission. The 0074 backstop
 *    re-judges the route and the issuer's validity at kauro.effect_now() (r24c).
 *  submit: outside any transaction, under the deadline the database stamped (submit_deadline_at = effect_now() + window).
 *  conclude (one unit of work, the same order): ISSUED only with a legal number, a provider id, a fiscal acceptance (ACCEPTED or
 *    ACCEPTED_WITH_OBSERVATIONS) and a verification reference (R2 15:139; X2: a pending acceptance is UNCERTAIN, a correction-required
 *    rejection is REJECTED with CORRECTION_REQUIRED, which stays correctable); a timeout is UNCERTAIN, never REJECTED; a manual bridge
 *    records its prepared action and stays SUBMITTING (never ISSUED by assumption).
 *  reconcile: observedFrom = effectNowOf read BEFORE the first page; every page read in product code, the exact identity (the request
 *    digest) filtered here, never by the provider (R2 15:141, R2-084); absence is proof only for a complete page set of a route whose
 *    absence proves (never a manual bridge) and only when the deadline is at or before observedFrom, judged by the concluding UPDATE.
 *
 * Refusals answer a closed local reason (FiscalIssuanceReason); their catalogue entries and the route belong to L6-W (section 8).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  AgencyId,
  CommerceUnitOfWork,
  CommerceUnitOfWorkFactory,
  CorrelationId,
  Environment,
  FailureCode,
  FiscalIssuerRecord,
  FiscalIssuerRef,
  FiscalProfileId,
  FiscalProfileRecord,
  IdempotencyIdentity,
  JournalEntryId,
  TaxDocumentId,
  TaxDocumentRecord,
  TaxDocumentRepository,
} from "@kauro/domain";
import { DomainFailure, commandRequestDigest, effectNowOf } from "@kauro/domain";
import type { FiscalIssuancePacket } from "../ports.js";

type IssuanceDocument = NonNullable<Awaited<ReturnType<TaxDocumentRepository["getForIssuance"]>>>;
type Conclusion = Parameters<TaxDocumentRepository["conclude"]>[2];

// --- the issuance route port (provider API or manual bridge) -----------------------------------------------------------------------

/** What the provider reports of one document it holds (R2 15:137 states mapped explicitly, X2). */
export type FiscalAcceptance = "ACCEPTED" | "ACCEPTED_WITH_OBSERVATIONS" | "PENDING" | "REJECTED" | "CORRECTION_REQUIRED";

export interface ProviderFiscalDocument {
  readonly providerDocumentId: string;
  /** The exact identity the issuance carried (tax_documents.issue_request_hash). */
  readonly issueRequestHash: Sha256Hex;
  readonly acceptance: FiscalAcceptance;
  readonly evidenceHash: Sha256Hex;
  readonly legalNumber?: string;
  readonly issuedAt?: UtcInstant;
  readonly verificationRef?: string;
  readonly rejectionCode?: string;
}

/** One raw page of the provider's list: unfiltered, in the provider's order, with its continuation cursor (null on the last page). */
export interface FiscalDocumentPage {
  readonly documents: ReadonlyArray<ProviderFiscalDocument>;
  readonly nextCursor: string | null;
}

export interface FiscalDocumentQuery {
  readonly issuerRef: FiscalIssuerRef;
  readonly kind: TaxDocumentRecord["kind"];
}

/** The provider's supported list query; a page that times out throws (it proves nothing). */
export interface FiscalDocumentPages {
  page(query: FiscalDocumentQuery, cursor: string | null): Promise<FiscalDocumentPage>;
}

export type FiscalSubmitAnswer =
  | { readonly kind: "RECEIVED"; readonly document: ProviderFiscalDocument }
  | { readonly kind: "AMBIGUOUS"; readonly reason: string }
  /** The manual-assisted bridge: an owner or accountant action was prepared; the legal number arrives by observation. */
  | { readonly kind: "ACTION_PREPARED"; readonly actionRef: string };

/** The issuance route bound to one issuer (15 "Accounting integration decision"; R2-083). */
export interface FiscalIssuanceRoute {
  readonly issuerRef: FiscalIssuerRef;
  readonly routeKind: FiscalIssuerRecord["routeKind"];
  readonly integrationClass: FiscalIssuerRecord["integrationClass"];
  /** Whether a complete page set read after the deadline proves the provider holds no such document (never for a manual bridge). */
  readonly absenceIsProof: boolean;
  /** Pure: the exact issuance request of the document (its digest is issue_request_hash). */
  prepare(document: TaxDocumentRecord, context: { readonly profile: FiscalProfileRecord; readonly issuer: FiscalIssuerRecord; readonly original?: TaxDocumentRecord }): FiscalIssuancePacket;
  submit(packet: FiscalIssuancePacket, deadline: UtcInstant): Promise<FiscalSubmitAnswer>;
  readonly pages: FiscalDocumentPages;
}

/** The points a test may pause or crash the protocol at (never between a clock read and its effect). */
export type FiscalIssuancePoint =
  | "INTENT_AFTER_PROFILE_HALF"
  | "INTENT_AFTER_ISSUER_HALF"
  | "INTENT_AFTER_ROW"
  | "INTENT_BEFORE_COMMIT"
  | "INTENT_COMMITTED"
  | "SUBMIT_ANSWERED"
  | "OBSERVED_FROM_READ"
  | "PAGES_READ"
  | "CONCLUDE_AFTER_ROW"
  | "CONCLUDE_BEFORE_COMMIT";

export interface FiscalIssuanceRuntime {
  readonly unitOfWork: CommerceUnitOfWorkFactory;
  /** The FISCAL_SERVICE caller's service identity (the role check is the route's, L6-W). */
  readonly serviceId: string;
  readonly environment: Environment;
  /** The route bound to an issuer, or null when this deployment binds none. */
  route(issuerRef: FiscalIssuerRef): FiscalIssuanceRoute | null;
  /** The submit window: submit_deadline_at = kauro.effect_now() + submitWindowMs. */
  readonly submitWindowMs: number;
  readonly hold?: (point: FiscalIssuancePoint, documentId: TaxDocumentId) => Promise<void>;
}

/** The stored operation whose scope the units of work adopt (D-SCOPE-B1): the document's payment order (the route resolves it, L6-W). */
export interface FiscalScope {
  readonly kind: "PAYMENT_ORDER";
  readonly key: string;
}

export interface IssueTaxDocumentRequest {
  readonly idempotencyKey: string;
  readonly correlationId: CorrelationId;
  readonly documentId: TaxDocumentId;
  readonly expectedVersion: number;
  readonly fiscalProfileId: FiscalProfileId;
  readonly scope: FiscalScope;
}

export interface TaxDocumentIssueView {
  readonly documentId: string;
  readonly kind: string;
  readonly state: string;
  readonly version: number;
  readonly issueRequestHash?: string;
  readonly providerDocumentId?: string;
  readonly legalNumber?: string;
  readonly fiscalStatus?: string;
  readonly verificationRef?: string;
  readonly bridgeActionRef?: string;
  readonly rejectionCode?: string;
}

/** The closed refusal reasons of CMD035 (their catalogue entries are L6-W's). */
export type FiscalIssuanceReason =
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "REQUEST_DIGEST_DIFFERS"
  | "OPERATION_PENDING"
  | "SUBMISSION_UNRECONCILED"
  | "DOCUMENT_NOT_VALIDATED"
  | "FISCAL_TREATMENT_UNREVIEWED"
  | "FISCAL_PROFILE_MISMATCH"
  | "FISCAL_ISSUER_MISMATCH"
  | "ISSUER_FACTS_UNCONFIRMED"
  | "FISCAL_PROVIDER_ENTITLEMENT_UNVERIFIED"
  | "FISCAL_ISSUER_NOT_IN_FORCE"
  | "FISCAL_PROFILE_NOT_IN_FORCE"
  | "PROVIDER_SERVICES_UNAVAILABLE";

export type IssueTaxDocumentOutcome =
  /** 200 for a terminal document (ISSUED, REJECTED); 202 while the submission is UNCERTAIN or a bridge action is prepared. */
  | { readonly kind: "ANSWERED"; readonly status: 200 | 202; readonly view: TaxDocumentIssueView; readonly replayed: boolean }
  | { readonly kind: "REFUSED"; readonly code: FailureCode; readonly reason: string; readonly retryable: boolean };

export type ReconcileTaxDocumentOutcome =
  | { readonly kind: "SETTLED"; readonly view: TaxDocumentIssueView }
  /** Still unknown (UNCERTAIN, or a bridge action awaiting its legal number): observe again later. */
  | { readonly kind: "OBSERVING"; readonly view: TaxDocumentIssueView }
  /** An absence observed before the submit deadline proves nothing; observe again from the deadline. */
  | { readonly kind: "NOT_DUE"; readonly deadline: UtcInstant; readonly view: TaxDocumentIssueView };

/** A refusal raised inside a unit of work (rolled back with everything, the reservation included: D-IDEM-2). */
export class FiscalIssuanceRefusal extends DomainFailure {
  readonly refusal: FiscalIssuanceReason;
  constructor(code: FailureCode, refusal: FiscalIssuanceReason, message: string, retryable?: boolean) {
    super(code, message, {}, retryable);
    this.refusal = refusal;
  }
}

function refuse(code: FailureCode, refusal: FiscalIssuanceReason, message: string, retryable?: boolean): never {
  throw new FiscalIssuanceRefusal(code, refusal, message, retryable);
}

function refusalOf(e: unknown): IssueTaxDocumentOutcome {
  if (e instanceof FiscalIssuanceRefusal) return { kind: "REFUSED", code: e.code, reason: e.refusal, retryable: e.retryable };
  if (e instanceof DomainFailure) return { kind: "REFUSED", code: e.code, reason: e.details.reason ?? e.code, retryable: e.retryable };
  throw e;
}

const TERMINAL = new Set(["ISSUED", "REJECTED", "CORRECTED"]);
const PAGE_LIMIT = 1000;

export function issueViewOf(d: IssuanceDocument): TaxDocumentIssueView {
  const view: Record<string, unknown> = { documentId: d.documentId, kind: d.kind, state: d.state, version: d.version };
  const optional: ReadonlyArray<readonly [string, unknown]> = [
    ["issueRequestHash", d.issueRequestHash],
    ["providerDocumentId", d.providerDocumentId],
    ["legalNumber", d.legalNumber],
    ["fiscalStatus", d.fiscalStatus],
    ["verificationRef", d.verificationRef],
    ["bridgeActionRef", d.bridgeActionRef],
    ["rejectionCode", d.rejectionCode],
  ];
  for (const [k, v] of optional) if (v !== undefined) view[k] = v;
  return view as unknown as TaxDocumentIssueView;
}

function contextOf(rt: FiscalIssuanceRuntime, correlationId: CorrelationId) {
  return { kind: "SERVICE" as const, serviceId: rt.serviceId, correlationId };
}

async function adopt(uow: CommerceUnitOfWork, scope: FiscalScope): Promise<AgencyId> {
  const agencyId = uow.commerceScope ?? (await uow.adoptScope(scope.kind, scope.key));
  if (agencyId === null) refuse("NOT_FOUND", "NOT_FOUND", "the document's stored operation is not in this scope");
  return agencyId;
}

function identityOf(rt: FiscalIssuanceRuntime, agencyId: AgencyId, key: string): IdempotencyIdentity {
  return { environment: rt.environment, actor: { kind: "SERVICE", serviceId: rt.serviceId }, agencyId, operation: "CMD035", key };
}

/** The issuer's validity at t (section 2): valid_from known and reached, valid_until not reached. */
function issuerInForce(issuer: FiscalIssuerRecord, t: number): boolean {
  if (issuer.validFrom === undefined || Date.parse(issuer.validFrom) > t) return false;
  return issuer.validUntil === undefined || t < Date.parse(issuer.validUntil);
}

/** The profile's validity at t: valid_from reached, valid_until not reached, not superseded. */
function profileInForce(profile: FiscalProfileRecord, t: number): boolean {
  if (t < Date.parse(profile.validFrom)) return false;
  if (profile.validUntil !== undefined && t >= Date.parse(profile.validUntil)) return false;
  return profile.supersededAt === undefined;
}

interface Intent {
  readonly kind: "SUBMIT";
  readonly entryId: JournalEntryId;
  readonly document: IssuanceDocument;
  readonly packet: FiscalIssuancePacket;
  readonly route: FiscalIssuanceRoute;
}

/**
 * The intent (section 4, row "CMD035 intent"): every lock of the global order, then the effect instant and the judgments, then the
 * intent UPDATE, with no await between the clock read and the UPDATE.
 */
async function submissionIntent(rt: FiscalIssuanceRuntime, uow: CommerceUnitOfWork, request: IssueTaxDocumentRequest, entryId: JournalEntryId): Promise<Intent> {
  const docs = uow.commerce.taxDocuments;
  const fiscal = uow.commerce.fiscal;
  const seen = await docs.getForIssuance(request.documentId);
  if (seen === null) refuse("NOT_FOUND", "NOT_FOUND", "no such tax document in this scope");
  // profile S (agency) -> issuer S -> the profile row -> the document row NKU -> the document X half (r21)
  await fiscal.currentProfile(seen.agencyId);
  await rt.hold?.("INTENT_AFTER_PROFILE_HALF", request.documentId);
  const issuer = await fiscal.getIssuer(seen.issuerRef);
  await rt.hold?.("INTENT_AFTER_ISSUER_HALF", request.documentId);
  const profile = await fiscal.getProfile(seen.fiscalProfileId);
  const original = seen.kind === "CREDIT_NOTE" && seen.correctsDocumentId !== undefined ? await docs.get(seen.correctsDocumentId) : null;
  const document = await docs.lockForIssuance(request.documentId);
  if (document === null) refuse("NOT_FOUND", "NOT_FOUND", "no such tax document in this scope");
  await rt.hold?.("INTENT_AFTER_ROW", request.documentId);
  await docs.holdTransition(request.documentId);
  const now = await effectNowOf(uow);
  const t = Date.parse(now);
  // an unreconciled prior submission first: a second submission is never made blind (CMD035 precondition)
  if (document.state === "SUBMITTING") refuse("PAYMENT_PENDING", "OPERATION_PENDING", "a submission of the document is in flight", true);
  if (document.state === "UNCERTAIN") refuse("PAYMENT_UNCERTAIN", "SUBMISSION_UNRECONCILED", "a prior submission of the document may have issued it; reconcile it first");
  if (document.state === "DRAFT") refuse("PRECONDITION_FAILED", document.blockedReason === "FISCAL_TREATMENT_UNREVIEWED" ? "FISCAL_TREATMENT_UNREVIEWED" : "DOCUMENT_NOT_VALIDATED", "only a VALIDATED document is issued");
  if (document.state !== "VALIDATED") refuse("PRECONDITION_FAILED", "DOCUMENT_NOT_VALIDATED", "only a VALIDATED document is issued");
  if (document.version !== request.expectedVersion) refuse("STALE_VERSION", "STALE_VERSION", "the tax document changed");
  if (request.fiscalProfileId !== document.fiscalProfileId) refuse("PRECONDITION_FAILED", "FISCAL_PROFILE_MISMATCH", "the named fiscal profile is not the document's");
  if (profile === null || profile.agencyId !== document.agencyId) refuse("PRECONDITION_FAILED", "FISCAL_PROFILE_MISMATCH", "the document's fiscal profile is not visible");
  if (profile.taxTreatment === "REVIEW_REQUIRED" || document.taxTreatment === "REVIEW_REQUIRED") refuse("PRECONDITION_FAILED", "FISCAL_TREATMENT_UNREVIEWED", "the treatment is not reviewed");
  const route = rt.route(document.issuerRef);
  if (issuer === null || profile.operatorLegalRef !== document.issuerRef || (route !== null && route.issuerRef !== document.issuerRef)) refuse("PRECONDITION_FAILED", "FISCAL_ISSUER_MISMATCH", "the issuer is not the profile's operator or the bound route's");
  if ((issuer.legalFactStatus !== "OBSERVED" && issuer.legalFactStatus !== "PROFESSIONALLY_CONFIRMED") || issuer.numberingAuthorizationRef === undefined) refuse("PRECONDITION_FAILED", "ISSUER_FACTS_UNCONFIRMED", "the issuer's legal facts or numbering authorization are not confirmed");
  // R2-083: entitlement is verified, never assumed; a manual bridge is the approved lawful alternative
  const entitled = issuer.routeKind === "MANUAL_BRIDGE" || (issuer.routeState === "QUALIFIED" && issuer.entitlementEvidenceHash !== undefined);
  if (!entitled) refuse("PRECONDITION_FAILED", "FISCAL_PROVIDER_ENTITLEMENT_UNVERIFIED", "the issuer has no qualified, entitled route");
  if (route === null) refuse("INTEGRITY_FAILURE", "PROVIDER_SERVICES_UNAVAILABLE", "no issuance route is bound for the issuer");
  if (route.routeKind !== issuer.routeKind) refuse("PRECONDITION_FAILED", "FISCAL_PROVIDER_ENTITLEMENT_UNVERIFIED", "the bound route is not the issuer's route kind");
  if (!issuerInForce(issuer, t)) refuse("PRECONDITION_FAILED", "FISCAL_ISSUER_NOT_IN_FORCE", "the issuer is not in force");
  if (!profileInForce(profile, t)) refuse("PRECONDITION_FAILED", "FISCAL_PROFILE_NOT_IN_FORCE", "the fiscal profile is not in force");
  if (document.kind === "CREDIT_NOTE" && (original === null || original.state !== "ISSUED" || original.legalNumber === undefined)) refuse("PRECONDITION_FAILED", "DOCUMENT_NOT_VALIDATED", "a credit note corrects an issued invoice");
  const packet = route.prepare(document, { profile, issuer, ...(original !== null ? { original } : {}) });
  const written = await docs.markSubmitting(document.documentId, document.version, packet.issueRequestHash, rt.submitWindowMs);
  if (written.kind === "STALE") refuse("STALE_VERSION", "STALE_VERSION", "the tax document changed");
  return { kind: "SUBMIT", entryId, document: written.record, packet, route };
}

/**
 * CMD035 IssueTaxDocument: journal reserve and intent in one unit of work, the submit outside it, the conclusion in another; a replay
 * of the same key answers the stored result, a pending one reconciles (observes) and never submits again; a conflicting key is refused.
 */
export async function issueTaxDocument(rt: FiscalIssuanceRuntime, request: IssueTaxDocumentRequest): Promise<IssueTaxDocumentOutcome> {
  const digest = commandRequestDigest({ operation: "CMD035", aggregate: { documentId: request.documentId }, body: { expectedVersion: request.expectedVersion, fiscalProfileId: request.fiscalProfileId } });
  let intent: Intent | { readonly kind: "REPLAY"; readonly status: number; readonly view: TaxDocumentIssueView } | { readonly kind: "PENDING"; readonly entryId: JournalEntryId };
  try {
    intent = await rt.unitOfWork.run(contextOf(rt, request.correlationId), async (uow) => {
      const agencyId = await adopt(uow, request.scope);
      const reserved = await uow.journal.reserve(identityOf(rt, agencyId, request.idempotencyKey), digest, request.correlationId);
      if (reserved.kind === "CONFLICT") refuse("IDEMPOTENCY_CONFLICT", "REQUEST_DIGEST_DIFFERS", "the idempotency key was used for another request");
      if (reserved.kind === "REPLAY") return { kind: "REPLAY" as const, status: reserved.entry.responseStatus ?? 200, view: reserved.entry.responseBody as TaxDocumentIssueView };
      if (reserved.kind === "PENDING") return { kind: "PENDING" as const, entryId: reserved.entry.entryId };
      const submission = await submissionIntent(rt, uow, request, reserved.entryId);
      await rt.hold?.("INTENT_BEFORE_COMMIT", request.documentId);
      return submission;
    });
  } catch (e) {
    return refusalOf(e);
  }
  if (intent.kind === "REPLAY") return { kind: "ANSWERED", status: intent.status === 202 ? 202 : 200, view: intent.view, replayed: true };
  if (intent.kind === "PENDING") {
    // the first execution's submission may have reached the provider: only its observation concludes it (never a second submit)
    const settled = await reconcileOrRefuse(rt, request.documentId, request.scope, request.correlationId, intent.entryId);
    return "kind" in settled && settled.kind === "REFUSED" ? settled : answerOf(settled as ReconcileTaxDocumentOutcome, true);
  }
  await rt.hold?.("INTENT_COMMITTED", request.documentId);
  const deadline = intent.document.submitDeadlineAt;
  if (deadline === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a SUBMITTING document carries its submit deadline");
  let answer: FiscalSubmitAnswer;
  try {
    answer = await intent.route.submit(intent.packet, deadline);
  } catch (e) {
    // a lost or failed response proves nothing about the effect: UNCERTAIN, never REJECTED
    answer = { kind: "AMBIGUOUS", reason: e instanceof Error ? e.message.slice(0, 120) : "submit failed" };
  }
  await rt.hold?.("SUBMIT_ANSWERED", request.documentId);
  try {
    const observation: Observation = answer.kind === "RECEIVED" ? { kind: "FOUND", document: answer.document } : answer.kind === "AMBIGUOUS" ? { kind: "UNKNOWN" } : { kind: "ACTION_PREPARED", actionRef: answer.actionRef };
    return answerOf(await conclude(rt, request.documentId, request.scope, request.correlationId, intent.entryId, observation, intent.route), false);
  } catch (e) {
    return refusalOf(e);
  }
}

function answerOf(outcome: ReconcileTaxDocumentOutcome, replayed: boolean): IssueTaxDocumentOutcome {
  return { kind: "ANSWERED", status: outcome.kind === "SETTLED" ? 200 : 202, view: outcome.view, replayed };
}

async function reconcileOrRefuse(rt: FiscalIssuanceRuntime, documentId: TaxDocumentId, scope: FiscalScope, correlationId: CorrelationId, entryId: JournalEntryId): Promise<ReconcileTaxDocumentOutcome | IssueTaxDocumentOutcome> {
  try {
    return await reconcileTaxDocument(rt, { documentId, scope, correlationId, entryId });
  } catch (e) {
    return refusalOf(e);
  }
}

type Observation =
  | { readonly kind: "FOUND"; readonly document: ProviderFiscalDocument }
  /** A timeout or a failed page: nothing is proved. */
  | { readonly kind: "UNKNOWN" }
  | { readonly kind: "ACTION_PREPARED"; readonly actionRef: string }
  /** Every page was read and no document carries the exact identity; the observation began at observedFrom. */
  | { readonly kind: "ABSENT"; readonly observedFrom: UtcInstant };

/** X2: what a provider-held document concludes (ISSUED only with its acceptance, legal number and verification reference). */
function conclusionOf(found: ProviderFiscalDocument): Conclusion | null {
  switch (found.acceptance) {
    case "ACCEPTED":
    case "ACCEPTED_WITH_OBSERVATIONS":
      if (found.legalNumber === undefined || found.issuedAt === undefined || found.verificationRef === undefined) return null;
      return { state: "ISSUED", providerDocumentId: found.providerDocumentId, legalNumber: found.legalNumber, evidenceHash: found.evidenceHash, issuedAt: found.issuedAt, fiscalStatus: found.acceptance, verificationRef: found.verificationRef };
    case "PENDING":
      return null;
    case "REJECTED":
      return { state: "REJECTED", providerDocumentId: found.providerDocumentId, rejectionCode: found.rejectionCode ?? "PROVIDER_REJECTED", evidenceHash: found.evidenceHash };
    case "CORRECTION_REQUIRED":
      // not terminal: the rejected document is corrected by a successor (REJECTED -> CORRECTED)
      return { state: "REJECTED", providerDocumentId: found.providerDocumentId, rejectionCode: "CORRECTION_REQUIRED", evidenceHash: found.evidenceHash };
  }
}

/** The conclusion (section 4, row "CMD035 conclude / reconciler"): under the global order, one terminal state and one event. */
async function conclude(rt: FiscalIssuanceRuntime, documentId: TaxDocumentId, scope: FiscalScope, correlationId: CorrelationId, entryId: JournalEntryId | null, observation: Observation, route: FiscalIssuanceRoute): Promise<ReconcileTaxDocumentOutcome> {
  return rt.unitOfWork.run(contextOf(rt, correlationId), async (uow) => {
    await adopt(uow, scope);
    const docs = uow.commerce.taxDocuments;
    const seen = await docs.getForIssuance(documentId);
    if (seen === null) refuse("NOT_FOUND", "NOT_FOUND", "no such tax document in this scope");
    await uow.commerce.fiscal.currentProfile(seen.agencyId);
    await uow.commerce.fiscal.getIssuer(seen.issuerRef);
    const document = await docs.lockForIssuance(documentId);
    if (document === null) refuse("NOT_FOUND", "NOT_FOUND", "no such tax document in this scope");
    await rt.hold?.("CONCLUDE_AFTER_ROW", documentId);
    await docs.holdTransition(documentId);
    let outcome: ReconcileTaxDocumentOutcome;
    if (TERMINAL.has(document.state)) outcome = { kind: "SETTLED", view: issueViewOf(document) };
    else if (document.state !== "SUBMITTING" && document.state !== "UNCERTAIN") throw new DomainFailure("INTEGRITY_FAILURE", "only a submitted document is concluded");
    else outcome = await applyObservation(uow, document, observation, route);
    if (entryId !== null) {
      if (outcome.kind === "SETTLED") await uow.journal.commit(entryId, { responseStatus: 200, responseBody: outcome.view, resourceKind: "tax_document", resourceId: documentId });
      else if (outcome.view.state === "UNCERTAIN") await uow.journal.markUncertain(entryId);
    }
    await rt.hold?.("CONCLUDE_BEFORE_COMMIT", documentId);
    return outcome;
  });
}

async function applyObservation(uow: CommerceUnitOfWork, document: IssuanceDocument, observation: Observation, route: FiscalIssuanceRoute): Promise<ReconcileTaxDocumentOutcome> {
  const docs = uow.commerce.taxDocuments;
  const written = async (conclusion: Conclusion): Promise<IssuanceDocument> => {
    const w = await docs.conclude(document.documentId, document.version, conclusion);
    if (w.kind === "STALE") throw new DomainFailure("STALE_VERSION", "the tax document changed while it was concluded", { currentVersion: w.currentVersion, currentState: w.currentState }, true);
    return w.record;
  };
  const uncertain = async (): Promise<ReconcileTaxDocumentOutcome> => ({ kind: "OBSERVING", view: issueViewOf(document.state === "SUBMITTING" ? await written({ state: "UNCERTAIN" }) : document) });
  switch (observation.kind) {
    case "FOUND": {
      if (observation.document.issueRequestHash !== document.issueRequestHash) throw new DomainFailure("INTEGRITY_FAILURE", "an observed document is never another request's");
      const conclusion = conclusionOf(observation.document);
      if (conclusion === null) return uncertain();
      return { kind: "SETTLED", view: issueViewOf(await written(conclusion)) };
    }
    case "UNKNOWN":
      // a manual bridge's prepared action stays SUBMITTING until its legal number is observed
      if (document.bridgeActionRef !== undefined) return { kind: "OBSERVING", view: issueViewOf(document) };
      return uncertain();
    case "ACTION_PREPARED": {
      if (document.bridgeActionRef !== undefined || document.state !== "SUBMITTING") return { kind: "OBSERVING", view: issueViewOf(document) };
      const w = await docs.recordBridgeAction(document.documentId, document.version, observation.actionRef);
      if (w.kind === "STALE") throw new DomainFailure("STALE_VERSION", "the tax document changed while its bridge action was recorded", { currentVersion: w.currentVersion, currentState: w.currentState }, true);
      return { kind: "OBSERVING", view: issueViewOf(w.record) };
    }
    case "ABSENT": {
      if (!route.absenceIsProof || route.routeKind === "MANUAL_BRIDGE" || document.bridgeActionRef !== undefined) {
        if (document.bridgeActionRef !== undefined) return { kind: "OBSERVING", view: issueViewOf(document) };
        return uncertain();
      }
      const w = await docs.conclude(document.documentId, document.version, { state: "REJECTED", rejectionCode: "NOT_ISSUED_BY_DEADLINE", absenceObservedFrom: observation.observedFrom });
      if (w.kind === "APPLIED") return { kind: "SETTLED", view: issueViewOf(w.record) };
      if (w.currentVersion !== document.version) throw new DomainFailure("STALE_VERSION", "the tax document changed while it was concluded", { currentVersion: w.currentVersion, currentState: w.currentState }, true);
      // observed before the deadline: the absence proves nothing yet
      const view = (await uncertain()).view;
      if (document.submitDeadlineAt === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a submitted document carries its submit deadline");
      return { kind: "NOT_DUE", deadline: document.submitDeadlineAt, view };
    }
  }
}

/** Every page of the provider's list, the exact identity filtered here (R2-084: the first page is not proof of absence). */
async function observe(route: FiscalIssuanceRoute, document: IssuanceDocument, observedFrom: UtcInstant): Promise<Observation> {
  let cursor: string | null = null;
  for (let n = 0; n < PAGE_LIMIT; n++) {
    let page: FiscalDocumentPage;
    try {
      page = await route.pages.page({ issuerRef: document.issuerRef, kind: document.kind }, cursor);
    } catch {
      return { kind: "UNKNOWN" };
    }
    const found = page.documents.find((d) => d.issueRequestHash === document.issueRequestHash);
    if (found !== undefined) return { kind: "FOUND", document: found };
    if (page.nextCursor === null) return { kind: "ABSENT", observedFrom };
    cursor = page.nextCursor;
  }
  return { kind: "UNKNOWN" };
}

/**
 * Reconciles a submitted document (the FISCAL reconciler on tax_document.submitting.v1 / uncertain.v1, and a pending replay of CMD035):
 * observedFrom read first, then every page, then the conclusion under the locks; with a journal entry, the conclusion completes it.
 */
export async function reconcileTaxDocument(rt: FiscalIssuanceRuntime, input: { readonly documentId: TaxDocumentId; readonly scope: FiscalScope; readonly correlationId: CorrelationId; readonly entryId?: JournalEntryId }): Promise<ReconcileTaxDocumentOutcome> {
  const read = await rt.unitOfWork.run(contextOf(rt, input.correlationId), async (uow) => {
    await adopt(uow, input.scope);
    const document = await uow.commerce.taxDocuments.getForIssuance(input.documentId);
    if (document === null) refuse("NOT_FOUND", "NOT_FOUND", "no such tax document in this scope");
    // the instant the observation begins at, read before the first page (section 4)
    const observedFrom = await effectNowOf(uow);
    return { document, observedFrom };
  });
  const { document } = read;
  const route = rt.route(document.issuerRef);
  if (route === null) refuse("INTEGRITY_FAILURE", "PROVIDER_SERVICES_UNAVAILABLE", "no issuance route is bound for the issuer");
  if (document.state !== "SUBMITTING" && document.state !== "UNCERTAIN") {
    if (TERMINAL.has(document.state)) return conclude(rt, input.documentId, input.scope, input.correlationId, input.entryId ?? null, { kind: "UNKNOWN" }, route);
    throw new DomainFailure("PRECONDITION_FAILED", "only a submitted document is reconciled", { reason: "OPERATION_PENDING" });
  }
  await rt.hold?.("OBSERVED_FROM_READ", input.documentId);
  const observation = await observe(route, document, read.observedFrom);
  await rt.hold?.("PAGES_READ", input.documentId);
  return conclude(rt, input.documentId, input.scope, input.correlationId, input.entryId ?? null, observation, route);
}

/**
 * The FISCAL consumer on tax_document.issued.v1 (M6 new row; M19, M20): the invoice's waiting credit notes validated once it is ISSUED —
 * profile S -> issuer S -> the invoice's shared half -> the notes' rows ascending FOR NO KEY UPDATE -> VALIDATED (the database
 * re-checks each, KP011). A re-delivery finds no waiting note and validates nothing twice.
 */
export async function validateWaitingCreditNotes(uow: CommerceUnitOfWork, invoiceId: TaxDocumentId, now: UtcInstant): Promise<number> {
  const docs = uow.commerce.taxDocuments;
  const seen = await docs.get(invoiceId);
  if (seen === null || seen.kind !== "INVOICE") return 0;
  await uow.commerce.fiscal.currentProfile(seen.agencyId);
  await uow.commerce.fiscal.getIssuer(seen.issuerRef);
  await docs.awaitTransition(invoiceId);
  const invoice = await docs.get(invoiceId);
  if (invoice === null || invoice.state !== "ISSUED") return 0;
  let validated = 0;
  for (const note of await docs.lockWaitingCreditNotes(invoiceId)) {
    const w = await docs.transition(note.documentId, note.version, { state: "VALIDATED" }, now);
    if (w.kind === "STALE") throw new DomainFailure("STALE_VERSION", "a waiting credit note changed while it was validated", { currentVersion: w.currentVersion, currentState: w.currentState }, true);
    validated += 1;
  }
  return validated;
}
