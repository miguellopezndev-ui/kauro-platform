/**
 * PrepareOutreachReview — POST /api/v1/ops/outreach/reviews — KAURO_OWNER with a fresh step-up — scope CORPORATE — no provider effect
 * (plan docs/design/B12-outreach-plan.md §0 A16, §2 "PrepareOutreachReview", GAP-API-B12-6; GAP-RV-1..3).
 *
 * One unit of work of the owner's OPERATOR context. Trace (§L): L1 owner S (access) -> L2 (journal) -> L10 S of the drafts ascending ->
 * the facts -> INSERT review and one line per draft (the database stamps issued_at = effect_now and the 15 minutes; the review is bound to
 * the step-up proof it is issued under). A draft closed since (CMD063 held it at L10 X first) is DRAFT_CLOSED; the review is a server-issued
 * fact, never a client-computed one: its digest names the review id the server chose.
 */
import { rawDigest, type Sha256Hex, type UtcInstant } from "@kauro/contracts";
import type { AssuranceProofId, CausationId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { assureStepUpAtCommit } from "../../ports/assurance-and-admission.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { PREPARE_OUTREACH_REVIEW, type PrepareOutreachReviewBody } from "../contracts.js";
import type { OutreachReviewView } from "../views.js";
import type { AuthReviewItem, AuthReviewRecord, OutreachAuthCollaborators } from "./auth-store.js";

export const OUTREACH_REVIEW_DOMAIN = "KAURO_OUTREACH_REVIEW_V1";

/** The digest of a review: the server-chosen review id, the owner, the proof, the sender and every line (sorted by draft id). */
export function outreachReviewDigest(r: { readonly reviewId: string; readonly ownerUserId: string; readonly proofId: string; readonly senderId: string; readonly items: ReadonlyArray<AuthReviewItem> }): Sha256Hex {
  const lines = [...r.items].sort((a, b) => (a.draftId < b.draftId ? -1 : a.draftId > b.draftId ? 1 : 0)).map((i) => [i.draftId, String(i.draftVersion), i.contentHash, i.contactLabel].join("|"));
  return rawDigest(new TextEncoder().encode([OUTREACH_REVIEW_DOMAIN, r.reviewId, r.ownerUserId, r.proofId, r.senderId, ...lines].join("\n"))) as Sha256Hex;
}

export function reviewView(r: AuthReviewRecord): OutreachReviewView {
  return {
    reviewId: r.reviewId,
    senderIdentityRef: r.senderId,
    digest: r.digest as Sha256Hex,
    issuedAt: r.issuedAt,
    expiresAt: r.expiresAt,
    items: r.items.map((i) => ({ draftId: i.draftId, draftVersion: i.draftVersion, contentHash: i.contentHash as Sha256Hex, contactLabel: i.contactLabel })),
  };
}

export function prepareReviewHandler(runtime: CommerceRequestRuntime, co: OutreachAuthCollaborators): CommercialCommandHandler<PrepareOutreachReviewBody, OutreachReviewView> {
  const spec = PREPARE_OUTREACH_REVIEW;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<PrepareOutreachReviewBody>): Promise<CommandResult<OutreachReviewView>> {
      const context = operatorContextOf(envelope);
      return runCommerceCommand<PrepareOutreachReviewBody, OutreachReviewView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        replayVersion: () => 1,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("PrepareOutreachReview", decision);
        },
        async body(uow, _causationId: CausationId, _now: UtcInstant) {
          const body = envelope.body;
          const assured = await assureStepUpAtCommit(uow, co.assurance, envelope.userId, body.assuranceProofRef as AssuranceProofId, runtime.clock);
          if (assured.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `preparing an outreach review needs a fresh step-up: ${assured.reason}`, { reason: assured.reason });
          const store = co.store(uow);
          const sender = await store.senderOf(body.senderIdentityRef);
          if (sender === null) throw new NotFoundFailure("sender_identity");
          const draftIds = [...new Set(body.draftIds)].sort();
          // L10 S of every draft, ascending: a CMD063 holding a draft at L10 X (judging it) is waited for, and one arriving later waits for this unit
          await store.lockDraftsShared(draftIds);
          const drafts = await store.draftsOf(draftIds);
          if (drafts.length !== draftIds.length) throw new NotFoundFailure("outreach_draft");
          if (sender.state === "REVOKED") throw new DomainFailure("PRECONDITION_FAILED", "the sender identity was revoked", { reason: "SENDER_REVOKED" });
          if (sender.state !== "VERIFIED") throw new DomainFailure("PRECONDITION_FAILED", "the sender identity is not VERIFIED", { reason: "SENDER_NOT_VERIFIED" });
          const items: AuthReviewItem[] = [];
          for (const d of drafts) {
            // a draft of another sender is not a draft of this review: it answers like an unknown one
            if (d.senderId !== sender.senderId || d.contactLabel === null) throw new NotFoundFailure("outreach_draft");
            if (d.state !== "DRAFT") throw new DomainFailure("PRECONDITION_FAILED", "a draft of the review is closed", { reason: "DRAFT_CLOSED", currentVersion: d.version, currentState: d.state });
            items.push({ draftId: d.draftId, draftVersion: d.version, contentHash: d.contentHash, contactLabel: d.contactLabel });
          }
          const reviewId = uow.ids.next() as string;
          const digest = outreachReviewDigest({ reviewId, ownerUserId: envelope.userId, proofId: body.assuranceProofRef, senderId: sender.senderId, items });
          const issued = await store.issueReview({ reviewId, ownerUserId: envelope.userId, proofId: body.assuranceProofRef, senderId: sender.senderId, digest, items });
          const view = reviewView({ reviewId, ownerUserId: envelope.userId, proofId: body.assuranceProofRef, senderId: sender.senderId, digest, issuedAt: issued.issuedAt, expiresAt: issued.expiresAt, items });
          return {
            status: 201,
            view,
            version: 1,
            resourceKind: "outreach_review",
            resourceId: reviewId,
            allowFact: { reasonCode: ALLOW_REASONS.STEP_UP_FRESH, assuranceClass: "STEP_UP", policyVersion: AUTHORIZATION_POLICY_VERSION },
          };
        },
      });
    },
  };
}
