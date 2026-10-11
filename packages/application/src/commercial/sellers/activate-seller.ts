/**
 * CMD049 ActivateSeller — POST /api/v1/sales/sellers/{sellerId}/activate — KAURO_OWNER with a fresh step-up — scope CORPORATE — no provider
 * effect (design §5, §10, §12; decisions D10-SELL-1, D10-SELL-3; registry "activate least-privilege seller capabilities and the agreed
 * compensation version"; 17 "Activation prerequisites").
 *
 * One unit of work of the owner's OPERATOR context, in B06's pipeline order: access (CommercialAuthorizer: the caller's own ACTIVE
 * KAURO_OWNER grant) → journal reserve (or the replay of the journaled 200 — a replay needs no new proof) → the body, the first failure
 * answering: the owner's step-up fresh (ASSURANCE_REQUIRED: STEP_UP_MISSING, STEP_UP_NOT_OWNED, STEP_UP_STALE; its ALLOW fact commits with
 * the activation) → the seller FOR UPDATE with the exclusive half of kauro.sellers (NOT_FOUND) → CANDIDATE (SELLER_NOT_ACTIVATABLE with the
 * current version and state) → the agreement the seller's own (AGREEMENT_VERSION_MISMATCH) → every activation fact, read after the seller's
 * lock: the agreement signed and in force, a legal review that CONFIRMS its classification, the assessment CMD049 names PASSED, the
 * confidentiality acceptance, tax documentation, a VERIFIED payout destination and an ACTIVE identity with a verified e-mail and MFA
 * (SELLER_NOT_ACTIVATABLE). Writes: the seller ACTIVE at version + 1 on that agreement (its compensation version), the assessment and the
 * owner's own step-up proof; the database records the activating person and instant itself and repeats every fact (KC005). A corporate
 * aggregate publishes no event (D10-EVT-1). From the activation the seller acts under its own session, which reads only its own rows.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AssuranceProofId, CausationId, SellerAgreementId, SellerAssessmentId, SellerId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { assureStepUpAtCommit } from "../../ports/assurance-and-admission.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import { applied } from "../agency/shared.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { ACTIVATE_SELLER, type ActivateSellerBody } from "../contracts.js";
import type { SellerView } from "../views.js";
import type { SellerCommandCollaborators } from "./runtime.js";

export function activateSellerHandler(runtime: CommerceRequestRuntime, co: SellerCommandCollaborators): CommercialCommandHandler<ActivateSellerBody, SellerView> {
  const spec = ACTIVATE_SELLER;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<ActivateSellerBody>): Promise<CommandResult<SellerView>> {
      const context = operatorContextOf(envelope);
      const sellerId = envelope.path["sellerId"] as SellerId;
      return runCommerceCommand<ActivateSellerBody, SellerView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD049", decision);
        },
        async body(uow, _causationId: CausationId, now: UtcInstant) {
          const body = envelope.body;
          // the owner's own fresh step-up (a new execution only; the proof is the owner's and recorded by the step-up verifier)
          const assured = await assureStepUpAtCommit(uow, co.assurance, envelope.userId, body.assuranceProofRef as AssuranceProofId, runtime.clock);
          if (assured.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `activating a seller needs a fresh step-up: ${assured.reason}`, { reason: assured.reason });
          const sales = co.sales(uow);
          const seller = await sales.lockSeller(sellerId);
          if (seller === null) throw new NotFoundFailure("seller");
          if (seller.state !== "CANDIDATE") {
            throw new DomainFailure("PRECONDITION_FAILED", "the seller is not a CANDIDATE: it was already activated, suspended or terminated", { reason: "SELLER_NOT_ACTIVATABLE", currentVersion: seller.version, currentState: seller.state });
          }
          const agreementId = body.agreementId as SellerAgreementId;
          const named = await sales.getAgreement(agreementId);
          if (named === null || named.sellerId !== sellerId) {
            throw new DomainFailure("PRECONDITION_FAILED", "agreementId is not an agreement of this seller", { reason: "AGREEMENT_VERSION_MISMATCH" });
          }
          const facts = await sales.activationFacts(sellerId, agreementId, body.assessmentEvidenceRef as SellerAssessmentId);
          const agreement = facts.agreement;
          const signed = agreement !== null && agreement.signedAt !== undefined && (agreement.endsAt === undefined || agreement.endsAt > now);
          const confirmed = agreement !== null && facts.legalReview !== null && facts.legalReview.outcome === "CONFIRMED" && facts.legalReview.classification === agreement.classification;
          if (
            agreement === null ||
            !signed ||
            !confirmed ||
            facts.assessment === null ||
            facts.assessment.outcome !== "PASSED" ||
            facts.confidentialityAcceptance === null ||
            facts.taxDocumentation === null ||
            facts.verifiedDestination === null ||
            !facts.identityVerifiedWithMfa
          ) {
            throw new DomainFailure("PRECONDITION_FAILED", "an activation prerequisite is missing: a signed agreement, a confirming legal review, a passed assessment, confidentiality, tax documentation, a verified destination or a verified identity with MFA", {
              reason: "SELLER_NOT_ACTIVATABLE",
              currentVersion: seller.version,
              currentState: seller.state,
            });
          }
          const next = applied(
            await sales.transitionSeller(sellerId, seller.version, { state: "ACTIVE", activeAgreementId: agreementId, activationAssessmentId: facts.assessment.assessmentId, activationProofId: assured.proofId }, now),
          );
          return {
            status: 200,
            view: {
              sellerId,
              version: next.version,
              state: next.state,
              agreementId,
              classification: agreement.classification,
              ...(next.activatedAt !== undefined ? { activatedAt: next.activatedAt } : {}),
              payoutDestinationVerified: true,
            },
            version: next.version,
            resourceKind: "seller",
            resourceId: sellerId,
            allowFact: { reasonCode: ALLOW_REASONS.STEP_UP_FRESH, assuranceClass: "STEP_UP", policyVersion: AUTHORIZATION_POLICY_VERSION },
          };
        },
      });
    },
  };
}
