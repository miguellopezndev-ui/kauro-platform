/**
 * The owner tools of package B12 (lane L-OWNER; plan companion §P): the 15 producers of the seller's onboarding, agreement, payout
 * destination, assignment and termination inputs, the seller's claim evidence and the owner's prepared allocation, on B06's pipeline over
 * the commerce unit of work (runCommerceCommand, journal scope OPERATOR_IDENTITY). Each handler answers in the pipeline's order: access →
 * journal reserve (or the replay) → the step-up of a new execution (the two destination tools) → the locks → the judgments, the first
 * failure answering → the writes, whose instants are the database's.
 *
 * Locks (companion §P, D10-TX-1): an owner tool on a seller takes the seller row FOR NO KEY UPDATE and the writer's half of kauro.sellers
 * (CMD049's and CMD050's order); the seller's own destination change takes the writer's half only (any seller state: a TERMINATED seller
 * keeps its payment route, 17 "Termination and tail"); the verification takes the seller row, the writer's half, then the destination row,
 * so a change and a verification of one seller serialize in either order and the verification judges the latest version under the lock.
 * The manifest and the allocation lock the claims of each prospect (ascending), never the seller.
 *
 * The step-up of a destination tool is judged fresh before the write, again by the pipeline before COMMIT (assureStepUpAtCommit), and by
 * the database's deferred trigger at COMMIT (0087, the 0040 shape): a proof that expires while the unit waits on the seller's lock commits
 * nothing (STEP_UP_STALE).
 *
 * D-33: nothing here reads a segment or a buyer type, and nothing ranks. No CRM is written.
 */
import type { UtcInstant } from "@kauro/contracts";
import { DomainFailure, NotFoundFailure, type AssuranceProofId, type CommerceUnitOfWork, type FailureReason, type UserId } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../../api/envelope.js";
import { ALLOW_REASONS } from "../../../commands/runtime.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceOutcome, type CommerceRequestRuntime } from "../../../commerce/request/runtime.js";
import { assureStepUpAtCommit } from "../../../ports/assurance-and-admission.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../../ports/authorizer.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../../agency/runtime.js";
import type { CommercialCommandSpec } from "../../contracts.js";
import {
  CHANGE_PAYOUT_DESTINATION,
  PREPARE_ATTRIBUTION_ALLOCATION,
  PREPARE_SELLER_AGREEMENT,
  PREPARE_SERVICE_ASSIGNMENT,
  PREPARE_TERMINATION_MANIFEST,
  PREPARE_TERMINATION_TERMS,
  RECORD_AGREEMENT_SIGNATURE,
  RECORD_ASSISTANCE_AGREEMENT,
  RECORD_CLAIM_EVIDENCE,
  RECORD_CONFIDENTIALITY_ACCEPTANCE,
  RECORD_SELLER_ASSESSMENT,
  RECORD_SELLER_LEGAL_REVIEW,
  RECORD_SELLER_TAX_DOCUMENT,
  REGISTER_SELLER_CANDIDATE,
  VERIFY_PAYOUT_DESTINATION,
  type ChangePayoutDestinationBody,
  type PrepareAttributionAllocationBody,
  type PrepareSellerAgreementBody,
  type PrepareServiceAssignmentBody,
  type PrepareTerminationManifestBody,
  type PrepareTerminationTermsBody,
  type RecordAgreementSignatureBody,
  type RecordAssistanceAgreementBody,
  type RecordClaimEvidenceBody,
  type RecordConfidentialityAcceptanceBody,
  type RecordSellerAssessmentBody,
  type RecordSellerLegalReviewBody,
  type RecordSellerTaxDocumentBody,
  type RegisterSellerCandidateBody,
  type VerifyPayoutDestinationBody,
} from "./contracts.js";
import type { OwnerToolAgreement, OwnerToolCollaborators, OwnerToolDestination, OwnerToolRecord, OwnerToolSeller, OwnerToolStore } from "./ports.js";
import type { AttributionAllocationRecordView, PayoutDestinationStatusView, SellerAgreementRecordView, SellerCandidateView, SellerRecordKind, SellerRecordView } from "./views.js";

/** The cooling period between a destination change and its verification (Q10-5), as the database judges it (0029 edge). */
export const PAYOUT_DESTINATION_COOLING_SECONDS = 172_800;

const precondition = (reason: FailureReason, message: string, current?: { readonly version: number; readonly state: string }): DomainFailure =>
  new DomainFailure("PRECONDITION_FAILED", message, current === undefined ? { reason } : { reason, currentVersion: current.version, currentState: current.state });
const stale = (message: string, current: { readonly version: number; readonly state: string }): DomainFailure =>
  new DomainFailure("STALE_VERSION", message, { currentVersion: current.version, currentState: current.state });

interface Run<Body, View> {
  readonly spec: CommercialCommandSpec<Body>;
  readonly who: "OWNER" | "SELLER_SELF" | "ACTIVE_SELLER";
  /** The access decision's seller (SELLER_SELF, ACTIVE_SELLER) is handed to the body. */
  body(uow: CommerceUnitOfWork, envelope: CommandEnvelope<Body>, tools: OwnerToolStore, actingSellerId: string | null, now: UtcInstant): Promise<CommerceOutcome<View>>;
}

function handler<Body, View>(runtime: CommerceRequestRuntime, co: OwnerToolCollaborators, run: Run<Body, View>): CommercialCommandHandler<Body, View> {
  const spec = run.spec;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<Body>): Promise<CommandResult<View>> {
      let actingSellerId: string | null = null;
      return runCommerceCommand<Body, View>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY", ...(spec.stepUp ? { digestOmits: ["assuranceProofRef"] } : {}) },
        envelope,
        context: operatorContextOf(envelope),
        async access(uow) {
          const identity = { identity: envelope.subject.identity };
          if (run.who === "OWNER") {
            const decision = await co.authorizer.authorizeCorporateOwner(uow, identity);
            if (decision.kind === "DENY") throw CommerceAccessDenied.of(spec.id, decision);
            return;
          }
          if (run.who === "SELLER_SELF") {
            // the writer's half of the caller's own seller BEFORE the authorizer's shared half: a shared half held to COMMIT and then upgraded
            // would deadlock two changes of one seller (each holding S, each waiting for X); taken first, the second change waits, then reads
            // the first one's committed version (STALE_VERSION). A caller with no seller row takes nothing and is refused by the authorizer.
            const tools = co.tools(uow);
            const own = await tools.sellerOfIdentity(envelope.userId);
            if (own !== null) await tools.holdOwnSeller(own);
          }
          const decision = run.who === "SELLER_SELF" ? await co.authorizer.authorizeSellerSelf(uow, identity) : await co.authorizer.authorizeSeller(uow, identity);
          if (decision.kind === "DENY") throw CommerceAccessDenied.of(spec.id, decision);
          actingSellerId = decision.sellerId;
        },
        async body(uow, _causationId, now) {
          return run.body(uow, envelope, co.tools(uow), actingSellerId, now);
        },
      });
    },
  };
}

/** The caller's own fresh step-up (a new execution only), re-judged before COMMIT by the pipeline and at COMMIT by 0087. */
async function freshStepUp(runtime: CommerceRequestRuntime, co: OwnerToolCollaborators, uow: CommerceUnitOfWork, userId: UserId, proofRef: string, what: string): Promise<AssuranceProofId> {
  const assured = await assureStepUpAtCommit(uow, co.assurance, userId, proofRef as AssuranceProofId, runtime.clock);
  if (assured.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `${what} needs a fresh step-up: ${assured.reason}`, { reason: assured.reason });
  return assured.proofId;
}

const STEP_UP_ALLOW = Object.freeze({ reasonCode: ALLOW_REASONS.STEP_UP_FRESH, assuranceClass: "STEP_UP" as const, policyVersion: AUTHORIZATION_POLICY_VERSION });

/** The seller an owner tool names, locked (row FOR NO KEY UPDATE, then the writer's half), and not TERMINATED unless the tool allows it. */
async function ownerSeller(tools: OwnerToolStore, sellerId: string, terminated: "REFUSE" | "UNLISTED"): Promise<OwnerToolSeller> {
  const seller = await tools.lockSeller(sellerId);
  if (seller === null) throw new NotFoundFailure("seller");
  if (seller.state === "TERMINATED") {
    throw terminated === "REFUSE"
      ? precondition("SELLER_NOT_ACTIVE", "the seller is TERMINATED: no new onboarding, agreement or assignment record is written for it", seller)
      : precondition("UNLISTED_TRANSITION", "the seller is already TERMINATED", seller);
  }
  return seller;
}

function recordOutcome(kind: SellerRecordKind, r: OwnerToolRecord, resourceKind: string): CommerceOutcome<SellerRecordView> {
  return { status: 201, view: { recordId: r.recordId, kind, sellerId: r.sellerId, version: 1, recordedAt: r.recordedAt }, version: 1, resourceKind, resourceId: r.recordId };
}

function agreementView(a: OwnerToolAgreement): SellerAgreementRecordView {
  return {
    agreementId: a.agreementId,
    sellerId: a.sellerId,
    agreementVersion: a.agreementVersion,
    version: a.version,
    signed: a.signedAt !== undefined,
    ...(a.signedAt !== undefined ? { signedAt: a.signedAt } : {}),
    createdAt: a.createdAt,
  };
}

function destinationView(d: OwnerToolDestination): PayoutDestinationStatusView {
  return {
    destinationId: d.destinationId,
    sellerId: d.sellerId,
    destinationVersion: d.destinationVersion,
    version: d.version,
    state: d.state,
    maskedLabel: d.maskedLabel,
    currency: d.currency,
    changedAt: d.changedAt,
    verifiableFrom: d.verifiableFrom,
    ...(d.verifiedAt !== undefined ? { verifiedAt: d.verifiedAt } : {}),
    ...(d.rejectedAt !== undefined ? { rejectedAt: d.rejectedAt } : {}),
  };
}

const pathId = (envelope: CommandEnvelope<unknown>, name: string): string => {
  const v = envelope.path[name];
  if (typeof v !== "string") throw new DomainFailure("INTEGRITY_FAILURE", `the route carries no ${name}`);
  return v;
};

/** An owner tool that appends one record to a seller (locked, not TERMINATED). */
function sellerRecordTool<Body>(
  runtime: CommerceRequestRuntime,
  co: OwnerToolCollaborators,
  spec: CommercialCommandSpec<Body>,
  kind: SellerRecordKind,
  resourceKind: string,
  write: (tools: OwnerToolStore, seller: OwnerToolSeller, body: Body) => Promise<OwnerToolRecord>,
): CommercialCommandHandler<Body, SellerRecordView> {
  return handler<Body, SellerRecordView>(runtime, co, {
    spec,
    who: "OWNER",
    async body(_uow, envelope, tools) {
      const seller = await ownerSeller(tools, pathId(envelope, "sellerId"), "REFUSE");
      return recordOutcome(kind, await write(tools, seller, envelope.body), resourceKind);
    },
  });
}

export interface OwnerToolHandlers {
  readonly RegisterSellerCandidate: CommercialCommandHandler<RegisterSellerCandidateBody, SellerCandidateView>;
  readonly RecordSellerLegalReview: CommercialCommandHandler<RecordSellerLegalReviewBody, SellerRecordView>;
  readonly PrepareSellerAgreement: CommercialCommandHandler<PrepareSellerAgreementBody, SellerAgreementRecordView>;
  readonly RecordAgreementSignature: CommercialCommandHandler<RecordAgreementSignatureBody, SellerAgreementRecordView>;
  readonly RecordSellerAssessment: CommercialCommandHandler<RecordSellerAssessmentBody, SellerRecordView>;
  readonly RecordConfidentialityAcceptance: CommercialCommandHandler<RecordConfidentialityAcceptanceBody, SellerRecordView>;
  readonly RecordSellerTaxDocument: CommercialCommandHandler<RecordSellerTaxDocumentBody, SellerRecordView>;
  readonly ChangePayoutDestination: CommercialCommandHandler<ChangePayoutDestinationBody, PayoutDestinationStatusView>;
  readonly VerifyPayoutDestination: CommercialCommandHandler<VerifyPayoutDestinationBody, PayoutDestinationStatusView>;
  readonly PrepareServiceAssignment: CommercialCommandHandler<PrepareServiceAssignmentBody, SellerRecordView>;
  readonly RecordAssistanceAgreement: CommercialCommandHandler<RecordAssistanceAgreementBody, SellerRecordView>;
  readonly PrepareTerminationTerms: CommercialCommandHandler<PrepareTerminationTermsBody, SellerRecordView>;
  readonly PrepareTerminationManifest: CommercialCommandHandler<PrepareTerminationManifestBody, SellerRecordView>;
  readonly RecordClaimEvidence: CommercialCommandHandler<RecordClaimEvidenceBody, SellerRecordView>;
  readonly PrepareAttributionAllocation: CommercialCommandHandler<PrepareAttributionAllocationBody, AttributionAllocationRecordView>;
}

export function createOwnerToolHandlers(runtime: CommerceRequestRuntime, co: OwnerToolCollaborators): OwnerToolHandlers {
  return Object.freeze({
    // --- sellers: born CANDIDATE once per corporate identity --------------------------------------------------------------------------
    RegisterSellerCandidate: handler<RegisterSellerCandidateBody, SellerCandidateView>(runtime, co, {
      spec: REGISTER_SELLER_CANDIDATE,
      who: "OWNER",
      async body(_uow, envelope, tools) {
        const b = envelope.body;
        if (!(await tools.identityExists(b.userId))) throw new NotFoundFailure("identity");
        const existing = await tools.sellerOfIdentity(b.userId);
        if (existing !== null) throw precondition("UNLISTED_TRANSITION", "the identity already has a seller row: a seller is born once per corporate identity");
        const s = await tools.registerSeller(b.userId, b.displayLabel);
        return { status: 201, view: { sellerId: s.sellerId, version: s.version, state: "CANDIDATE", displayLabel: b.displayLabel, createdAt: s.createdAt }, version: s.version, resourceKind: "seller", resourceId: s.sellerId };
      },
    }),

    RecordSellerLegalReview: sellerRecordTool(runtime, co, RECORD_SELLER_LEGAL_REVIEW, "LEGAL_REVIEW", "seller_legal_review", (tools, seller, b) => tools.recordLegalReview(seller.sellerId, b)),

    // --- the agreement: prepared with its exact operative text, signed once -----------------------------------------------------------
    PrepareSellerAgreement: handler<PrepareSellerAgreementBody, SellerAgreementRecordView>(runtime, co, {
      spec: PREPARE_SELLER_AGREEMENT,
      who: "OWNER",
      async body(_uow, envelope, tools) {
        const b = envelope.body;
        const seller = await ownerSeller(tools, pathId(envelope, "sellerId"), "REFUSE");
        const review = await tools.legalReview(seller.sellerId, b.legalReviewId);
        if (review === null) throw precondition("UNKNOWN_REFERENCE", "legalReviewId is not a legal review of this seller");
        if (await tools.agreementVersionTaken(seller.sellerId, b.agreementVersion)) throw precondition("AGREEMENT_VERSION_MISMATCH", "the seller already has an agreement of this version");
        if (b.endsAt !== undefined && Date.parse(b.endsAt) <= Date.parse(b.startsAt)) throw precondition("COMMISSION_POOL_MISMATCH", "the term ends before it starts");
        const a = await tools.prepareAgreement(seller.sellerId, {
          agreementVersion: b.agreementVersion,
          legalReviewId: b.legalReviewId,
          classification: review.classification,
          startsAt: b.startsAt as UtcInstant,
          endsAt: (b.endsAt ?? null) as UtcInstant | null,
          firstBps: b.firstBps,
          repeatBps: b.repeatBps,
          offsetTerms: b.offsetTerms,
          retainerCentsPerMonth: b.retainerCentsPerMonth,
          compensationPolicyVersion: b.compensationPolicyVersion,
          signedTermsHash: b.signedTermsHash,
        });
        return { status: 201, view: agreementView(a), version: a.version, resourceKind: "seller_agreement", resourceId: a.agreementId };
      },
    }),

    RecordAgreementSignature: handler<RecordAgreementSignatureBody, SellerAgreementRecordView>(runtime, co, {
      spec: RECORD_AGREEMENT_SIGNATURE,
      who: "OWNER",
      async body(_uow, envelope, tools) {
        const b = envelope.body;
        const agreementId = pathId(envelope, "agreementId");
        const named = await tools.agreement(agreementId, false);
        if (named === null) throw new NotFoundFailure("seller agreement");
        const seller = await tools.lockSeller(named.sellerId);
        if (seller === null) throw new NotFoundFailure("seller agreement");
        const a = await tools.agreement(agreementId, true);
        if (a === null) throw new NotFoundFailure("seller agreement");
        const current = { version: a.version, state: a.signedAt !== undefined ? "SIGNED" : "PREPARED" };
        if (a.version !== b.expectedVersion) throw stale("the agreement moved since it was read", current);
        if (a.signedAt !== undefined) throw precondition("UNLISTED_TRANSITION", "the agreement is already signed: it is signed once", current);
        if (a.signedTermsHash !== b.signedTermsHash) throw precondition("HASH_MISMATCH", "signedTermsHash is not the operative text the agreement was prepared with");
        if (seller.state === "TERMINATED") throw precondition("SELLER_NOT_ACTIVE", "the seller is TERMINATED: its agreement is not signed", seller);
        const signed = await tools.signAgreement(agreementId, b.expectedVersion, b.signatureEvidenceHash);
        if (signed === null) throw stale("the agreement moved since it was read", current);
        return { status: 200, view: agreementView(signed), version: signed.version, resourceKind: "seller_agreement", resourceId: agreementId };
      },
    }),

    RecordSellerAssessment: sellerRecordTool(runtime, co, RECORD_SELLER_ASSESSMENT, "ASSESSMENT", "seller_assessment", (tools, seller, b) => tools.recordAssessment(seller.sellerId, b)),
    RecordConfidentialityAcceptance: sellerRecordTool(runtime, co, RECORD_CONFIDENTIALITY_ACCEPTANCE, "CONFIDENTIALITY_ACCEPTANCE", "seller_confidentiality_acceptance", (tools, seller, b) =>
      tools.recordConfidentialityAcceptance(seller.sellerId, b),
    ),
    RecordSellerTaxDocument: sellerRecordTool(runtime, co, RECORD_SELLER_TAX_DOCUMENT, "TAX_DOCUMENT", "seller_tax_document", (tools, seller, b) => tools.recordTaxDocument(seller.sellerId, b)),

    // --- the payout destination (TIER 1 money) --------------------------------------------------------------------------------------
    ChangePayoutDestination: handler<ChangePayoutDestinationBody, PayoutDestinationStatusView>(runtime, co, {
      spec: CHANGE_PAYOUT_DESTINATION,
      who: "SELLER_SELF",
      async body(uow, envelope, tools, actingSellerId) {
        if (actingSellerId === null) throw new DomainFailure("INTEGRITY_FAILURE", "the destination change runs for the caller's own seller");
        const b = envelope.body;
        const proofId = await freshStepUp(runtime, co, uow, envelope.userId, b.assuranceProofRef, "changing a payout destination");
        const seller = await tools.holdOwnSeller(actingSellerId);
        if (seller === null || seller.userId !== envelope.userId) throw new DomainFailure("INTEGRITY_FAILURE", "the caller's seller row is not visible after its lock");
        const latest = await tools.latestDestination(seller.sellerId);
        const currentVersion = latest?.destinationVersion ?? 0;
        if (currentVersion !== b.expectedDestinationVersion) throw stale("the seller's destination changed since it was read", { version: currentVersion, state: latest?.state ?? "NONE" });
        const d = await tools.changeDestination(seller.sellerId, currentVersion + 1, { maskedLabel: b.maskedLabel, destinationDigest: b.destinationDigest, currency: b.currency, proofId });
        return { status: 201, view: destinationView(d), version: d.version, resourceKind: "payout_destination", resourceId: d.destinationId, allowFact: STEP_UP_ALLOW };
      },
    }),

    VerifyPayoutDestination: handler<VerifyPayoutDestinationBody, PayoutDestinationStatusView>(runtime, co, {
      spec: VERIFY_PAYOUT_DESTINATION,
      who: "OWNER",
      async body(uow, envelope, tools) {
        const b = envelope.body;
        const destinationId = pathId(envelope, "destinationId");
        const proofId = await freshStepUp(runtime, co, uow, envelope.userId, b.assuranceProofRef, "verifying a payout destination");
        const sellerId = await tools.sellerOfDestination(destinationId);
        if (sellerId === null) throw new NotFoundFailure("payout destination");
        if ((await tools.lockSeller(sellerId)) === null) throw new NotFoundFailure("payout destination");
        const d = await tools.lockDestination(destinationId);
        if (d === null || d.sellerId !== sellerId) throw new NotFoundFailure("payout destination");
        const current = { version: d.version, state: d.state };
        if (d.version !== b.expectedVersion) throw stale("the destination moved since it was read", current);
        if (d.state !== "PENDING_VERIFICATION" || d.superseded) throw precondition("UNLISTED_TRANSITION", "the destination is not PENDING_VERIFICATION, or a later version of the seller's destination exists", current);
        let next: OwnerToolDestination | null;
        if (b.decision === "REJECTED") {
          next = await tools.rejectDestination(destinationId, b.expectedVersion);
        } else {
          if (!d.changeProofCarried || !d.coolingPassed) throw precondition("PAYEE_UNVERIFIED", "the change carried no seller step-up, or its 172800 s cooling period has not passed on the database clock");
          if (d.changedByUserId === envelope.userId) throw precondition("SELF_TARGET", "the verifier is the person who changed the destination");
          next = await tools.verifyDestination(d, b.expectedVersion, proofId);
        }
        if (next === null) throw stale("the destination moved since it was read", current);
        return { status: 200, view: destinationView(next), version: next.version, resourceKind: "payout_destination", resourceId: destinationId, allowFact: STEP_UP_ALLOW };
      },
    }),

    // --- assignments and assistance ---------------------------------------------------------------------------------------------------
    PrepareServiceAssignment: handler<PrepareServiceAssignmentBody, SellerRecordView>(runtime, co, {
      spec: PREPARE_SERVICE_ASSIGNMENT,
      who: "OWNER",
      async body(_uow, envelope, tools) {
        const b = envelope.body;
        const seller = await ownerSeller(tools, pathId(envelope, "sellerId"), "REFUSE");
        if (!(await tools.agencyExists(b.agencyId))) throw new NotFoundFailure("agency");
        const assistance = b.assistanceAgreementId ?? null;
        const named = assistance !== null && (await tools.assistanceAgreementExists(b.agencyId, assistance, seller.sellerId));
        if ((b.compensation === "NONE") !== (assistance === null) || (assistance !== null && !named)) {
          throw precondition("UNKNOWN_REFERENCE", "assistanceAgreementId is not an assistance agreement of this seller and agency, or is given with compensation NONE");
        }
        const r = await tools.prepareServiceAssignment(seller.sellerId, { agencyId: b.agencyId, compensation: b.compensation, assistanceAgreementId: assistance, termsHash: b.termsHash });
        return recordOutcome("SERVICE_ASSIGNMENT", r, "service_assignment");
      },
    }),

    RecordAssistanceAgreement: handler<RecordAssistanceAgreementBody, SellerRecordView>(runtime, co, {
      spec: RECORD_ASSISTANCE_AGREEMENT,
      who: "OWNER",
      async body(_uow, envelope, tools) {
        const b = envelope.body;
        const seller = await ownerSeller(tools, pathId(envelope, "sellerId"), "REFUSE");
        if (!(await tools.agencyExists(b.agencyId))) throw new NotFoundFailure("agency");
        const agreement = await tools.agreement(b.agreementId, false);
        if (agreement === null || agreement.sellerId !== seller.sellerId || agreement.signedAt === undefined) throw precondition("AGREEMENT_VERSION_MISMATCH", "agreementId is not a signed agreement of this seller");
        const projectId = b.projectId ?? null;
        if ((b.scope === "PROJECT") !== (projectId !== null) || (projectId !== null && !(await tools.projectOfAgency(b.agencyId, projectId)))) {
          throw precondition("CROSS_AGENCY", "projectId is not a project of the agency, or is given for NEXT_PURCHASE");
        }
        const r = await tools.recordAssistanceAgreement(seller.sellerId, { agencyId: b.agencyId, agreement, scope: b.scope, projectId, rateBps: b.rateBps, termsHash: b.termsHash });
        return recordOutcome("ASSISTANCE_AGREEMENT", r, "assistance_agreement");
      },
    }),

    // --- termination inputs (CMD050's terminationTermsRef and activeOpportunityManifestRef) -------------------------------------------
    PrepareTerminationTerms: handler<PrepareTerminationTermsBody, SellerRecordView>(runtime, co, {
      spec: PREPARE_TERMINATION_TERMS,
      who: "OWNER",
      async body(_uow, envelope, tools) {
        const seller = await ownerSeller(tools, pathId(envelope, "sellerId"), "UNLISTED");
        if (await tools.effectiveTermination(seller.sellerId)) throw precondition("UNLISTED_TRANSITION", "the seller already has an effective termination", seller);
        return recordOutcome("TERMINATION_TERMS", await tools.prepareTerminationTerms(seller.sellerId, envelope.body.termsHash), "seller_termination");
      },
    }),

    PrepareTerminationManifest: handler<PrepareTerminationManifestBody, SellerRecordView>(runtime, co, {
      spec: PREPARE_TERMINATION_MANIFEST,
      who: "OWNER",
      async body(_uow, envelope, tools) {
        const sellerId = pathId(envelope, "sellerId");
        const claimIds = envelope.body.claimIds;
        const named = await tools.sellerFacts(sellerId);
        if (named === null) throw new NotFoundFailure("seller");
        // the claims of each prospect the seller's accepted claims and the named claims are on, ascending; never the seller (CMD050 locks it first)
        await tools.lockProspectClaims(await tools.prospectsOfClaims(sellerId, claimIds));
        const seller = await tools.sellerFacts(sellerId);
        if (seller === null) throw new NotFoundFailure("seller");
        if (seller.state === "TERMINATED") throw precondition("UNLISTED_TRANSITION", "the seller is already TERMINATED", seller);
        const live = await tools.acceptedLiveClaims(sellerId);
        const body = [...new Set(claimIds)].sort();
        if (body.length !== claimIds.length || body.length !== live.length || body.some((id, i) => id !== live[i])) {
          throw precondition("TAIL_NOT_ENUMERATED", "claimIds is not exactly the seller's ACCEPTED, unexpired claims at preparation, read under each prospect's claims lock");
        }
        return recordOutcome("TERMINATION_MANIFEST", await tools.prepareTerminationManifest(sellerId, body), "termination_manifest");
      },
    }),

    // --- attribution inputs -----------------------------------------------------------------------------------------------------------
    RecordClaimEvidence: handler<RecordClaimEvidenceBody, SellerRecordView>(runtime, co, {
      spec: RECORD_CLAIM_EVIDENCE,
      who: "ACTIVE_SELLER",
      async body(_uow, envelope, tools, actingSellerId) {
        if (actingSellerId === null) throw new DomainFailure("INTEGRITY_FAILURE", "claim evidence is recorded for the caller's own ACTIVE seller");
        const prospectId = pathId(envelope, "prospectId");
        if (!(await tools.prospectExists(prospectId))) throw new NotFoundFailure("prospect");
        const r = await tools.recordClaimEvidence(actingSellerId, prospectId, envelope.body);
        if (r === null) throw precondition("CLAIM_EVIDENCE_INSUFFICIENT", "the first meaningful contact is after the database instant of the record, or the evidence is already recorded on another prospect");
        return recordOutcome("CLAIM_EVIDENCE", r, "claim_evidence");
      },
    }),

    PrepareAttributionAllocation: handler<PrepareAttributionAllocationBody, AttributionAllocationRecordView>(runtime, co, {
      spec: PREPARE_ATTRIBUTION_ALLOCATION,
      who: "OWNER",
      async body(_uow, envelope, tools) {
        const b = envelope.body;
        const prospectId = pathId(envelope, "prospectId");
        await tools.lockProspectClaims([prospectId]);
        if (!(await tools.prospectExists(prospectId)) || !(await tools.agencyExists(b.agencyId))) throw new NotFoundFailure("prospect or agency");
        const claimIds = b.shares.map((s) => s.claimId);
        const claims = await tools.shareClaims(prospectId, claimIds);
        const byId = new Map(claims.map((c) => [c.claimId, c]));
        const sellers = new Set(claims.map((c) => c.sellerId));
        if (new Set(claimIds).size !== claimIds.length || claims.length !== claimIds.length || sellers.size !== claims.length || claims.some((c) => c.state !== "SUBMITTED" && c.state !== "DISPUTED")) {
          throw precondition("CLAIM_NOT_REVIEWABLE", "a share names a claim that is not a SUBMITTED or DISPUTED claim on this prospect, or two shares name one seller");
        }
        if (b.shares.reduce((sum, s) => sum + s.shareBps, 0) !== 10_000) throw precondition("SHARES_NOT_WHOLE", "the shares do not sum to exactly 10000 basis points");
        if (claims.some((c) => !c.agreementInForce || c.firstBps !== b.firstBps || c.repeatBps !== b.repeatBps)) throw precondition("COMMISSION_POOL_MISMATCH", "the pool terms are not every beneficiary's signed agreement terms");
        if (await tools.frozenAllocationOfAgency(b.agencyId)) throw precondition("ATTRIBUTION_EXISTS", "the agency already has a frozen allocation");
        const shares = b.shares.map((s) => ({ claim: byId.get(s.claimId) as NonNullable<ReturnType<typeof byId.get>>, shareBps: s.shareBps }));
        const a = await tools.prepareAllocation({
          prospectId,
          agencyId: b.agencyId,
          identityEvidenceHash: b.identityEvidenceHash,
          rulingReason: b.rulingReason,
          rulingEvidenceHash: b.rulingEvidenceHash,
          firstBps: b.firstBps,
          repeatBps: b.repeatBps,
          shares,
        });
        return {
          status: 201,
          view: { allocationId: a.allocationId, prospectId, agencyId: b.agencyId, version: a.version, shareCount: shares.length, frozen: false, preparedAt: a.preparedAt },
          version: a.version,
          resourceKind: "attribution_allocation",
          resourceId: a.allocationId,
        };
      },
    }),
  });
}
