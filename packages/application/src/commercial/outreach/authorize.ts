/**
 * CMD062 AuthorizeOutreach — POST /api/v1/ops/outreach/authorizations — KAURO_OWNER with a fresh step-up — scope CORPORATE — no provider effect
 * (plan docs/design/B12-outreach-plan.md §0 A16, §2 CMD062; GAP-AU-1..5, M31..M34).
 *
 * Trace (§L): L1 owner S (access) -> L2 (journal) -> the step-up proof read -> the review row by its digest (plain; consumption is U1) ->
 * L5 S (capabilities of the cited resources) -> L6 S (resource families) -> L7 S (the sender) -> L8 S (the drafts' suppression keys) -> L10 S of the drafts ascending -> ONE judging
 * statement at kauro.effect_now() (review live and unconsumed, window) -> the locked facts -> INSERT grant (review_id UNIQUE) and one sealed hash
 * per draft; the step-up is judged again at COMMIT (assureStepUpAtCommit registers it). The permission evidence is the digest of a server-issued
 * review: a client-computed digest, another proof's review, an earlier draft version or a consumed or expired review is OUTREACH_REVIEW_INVALID
 * (KC035) with nothing written. The grant seals the review's drafts exactly: the allowed hashes are the review's, no more, no fewer. A draft
 * moved since the review (CMD063 held it first), an excluded prospect (KC016: the registry reaches its organization or contact key), a sender revoked or unverified, a superseded resource or a suspended capability (R2-135),
 * an unreviewed jurisdiction or an unconfigured postal address refuses the grant. Two grants of one review: U1 gives one, the other KC035 (M34).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AssuranceProofId, CausationId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, OUTREACH_ROUTES } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { assureStepUpAtCommit } from "../../ports/assurance-and-admission.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { AUTHORIZE_OUTREACH, type AuthorizeOutreachBody } from "../contracts.js";
import type { OutreachAuthorizationView } from "../views.js";
import type { AuthGrantRecord, OutreachAuthCollaborators } from "./auth-store.js";
import { OUTREACH_POLICY_VERSION } from "./runtime.js";

const refuse = (reason: "OUTREACH_REVIEW_INVALID" | "OUTREACH_GRANT_INVALID" | "PROSPECT_SUPPRESSED" | "SENDER_REVOKED" | "SENDER_NOT_VERIFIED" | "OUTREACH_ROUTE_FORBIDDEN" | "RESOURCE_NOT_CURRENT" | "OUTREACH_JURISDICTION_UNREVIEWED" | "OUTREACH_COMPLIANCE_UNCONFIGURED", why: string): DomainFailure =>
  new DomainFailure("PRECONDITION_FAILED", why, { reason });

export function grantView(g: AuthGrantRecord): OutreachAuthorizationView {
  return {
    authorizationId: g.authorizationId,
    grantingActorId: g.grantingUserId,
    senderIdentityRef: g.senderId,
    allowedContentHashes: g.allowedContentHashes as ReadonlyArray<Sha256Hex>,
    validFrom: g.validFrom,
    expiresAt: g.expiresAt,
    maximumSends: g.maximumSends,
    permissionEvidenceHash: g.permissionEvidenceHash as Sha256Hex,
    policyVersion: g.policyVersion,
    revoked: g.revoked,
  };
}

export function authorizeHandler(runtime: CommerceRequestRuntime, co: OutreachAuthCollaborators): CommercialCommandHandler<AuthorizeOutreachBody, OutreachAuthorizationView> {
  const spec = AUTHORIZE_OUTREACH;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<AuthorizeOutreachBody>): Promise<CommandResult<OutreachAuthorizationView>> {
      const context = operatorContextOf(envelope);
      return runCommerceCommand<AuthorizeOutreachBody, OutreachAuthorizationView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        replayVersion: () => 1,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD062", decision);
        },
        async body(uow, _causationId: CausationId, _now: UtcInstant) {
          const body = envelope.body;
          const assured = await assureStepUpAtCommit(uow, co.assurance, envelope.userId, body.assuranceProofRef as AssuranceProofId, runtime.clock);
          if (assured.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `authorizing outreach needs a fresh step-up: ${assured.reason}`, { reason: assured.reason });
          const store = co.store(uow);
          if (new Set(body.allowedContentHashes).size !== body.allowedContentHashes.length) throw refuse("OUTREACH_REVIEW_INVALID", "allowedContentHashes names a hash twice");
          const named = await store.senderOf(body.senderIdentityRef);
          if (named === null) throw new NotFoundFailure("sender_identity");
          // the evidence is a server-issued review of this owner, under this proof, for this sender (a client-computed digest finds no row)
          const review = await store.reviewByDigest(body.permissionEvidenceHash);
          if (review === null || review.ownerUserId !== envelope.userId || review.proofId !== body.assuranceProofRef || review.senderId !== named.senderId) {
            throw refuse("OUTREACH_REVIEW_INVALID", "permissionEvidenceHash is not a review this owner confirmed under this step-up for this sender");
          }
          const reviewed = [...new Set(review.items.map((i) => i.contentHash))].sort();
          const asked = [...body.allowedContentHashes].sort();
          if (reviewed.length !== asked.length || reviewed.some((h, i) => h !== asked[i])) throw refuse("OUTREACH_REVIEW_INVALID", "allowedContentHashes are not exactly the hashes the review showed");
          if (body.maximumSends > reviewed.length) throw refuse("OUTREACH_GRANT_INVALID", "maximumSends is above the sealed drafts");
          const draftIds = review.items.map((i) => i.draftId).sort();
          // the serializer set in the global order, then the judgment (nothing but the first write follows it)
          await store.lockGrantSet(draftIds, named.senderId);
          const facts = await store.grantFacts({ reviewId: review.reviewId, draftIds, senderId: named.senderId, validFrom: body.validFrom, expiresAt: body.expiresAt }); /* b12:judge */
          if (!facts.reviewLive) throw refuse("OUTREACH_REVIEW_INVALID", "the review expired");
          if (facts.reviewConsumed) throw refuse("OUTREACH_REVIEW_INVALID", "the review was already consumed by a grant");
          if (facts.sender === null) throw new NotFoundFailure("sender_identity");
          if (facts.sender.state === "REVOKED") throw refuse("SENDER_REVOKED", "the sender identity was revoked");
          if (facts.sender.state !== "VERIFIED") throw refuse("SENDER_NOT_VERIFIED", "the sender identity is not VERIFIED");
          if (!OUTREACH_ROUTES.includes(facts.sender.route)) throw refuse("OUTREACH_ROUTE_FORBIDDEN", "the sender route may not carry outreach");
          const byId = new Map(facts.drafts.map((d) => [d.draftId, d]));
          for (const item of review.items) {
            const d = byId.get(item.draftId);
            if (d === undefined || d.version !== item.draftVersion || d.contentHash !== item.contentHash || d.state !== "DRAFT" || d.senderId !== named.senderId) {
              throw refuse("OUTREACH_REVIEW_INVALID", "a draft of the review moved since it was reviewed");
            }
          }
          // an excluded prospect takes no new authorization: the registry reaches its organization or contact key (the prospect's own, migration 0094), read
          // under L8 S of those keys, so an opt-out in flight is ordered before (refused here) or after (CMD063 and D2 refuse the send) — R2-130, finding F2
          if (facts.drafts.some((d) => d.suppressed)) throw refuse("PROSPECT_SUPPRESSED", "the organization or the contact of a draft is suppressed");
          if (facts.resourcesNotCurrent > 0 || facts.capabilitiesRestricted > 0) throw refuse("RESOURCE_NOT_CURRENT", "a cited resource is superseded or a claimed capability is no longer offered");
          for (const d of facts.drafts) {
            if (!d.policyInForce) throw refuse("OUTREACH_JURISDICTION_UNREVIEWED", "the jurisdiction of a draft has no channel policy in force");
            if (!d.complianceConfigured) throw refuse("OUTREACH_COMPLIANCE_UNCONFIGURED", "the postal address or the opt-out origin is not configured");
          }
          if (!facts.windowOk) throw refuse("OUTREACH_GRANT_INVALID", "the window is empty or longer than 14 days");
          const authorizationId = uow.ids.next() as string;
          const grant = await store.insertGrant({ /* b12:write */
            authorizationId,
            reviewId: review.reviewId,
            grantingUserId: envelope.userId,
            senderId: named.senderId,
            proofId: body.assuranceProofRef,
            validFrom: body.validFrom,
            expiresAt: body.expiresAt,
            maximumSends: body.maximumSends,
            permissionEvidenceHash: body.permissionEvidenceHash,
            policyVersion: OUTREACH_POLICY_VERSION,
            seals: review.items.map((i) => ({ draftId: i.draftId, contentHash: i.contentHash })),
          });
          return {
            status: 201,
            view: grantView(grant),
            version: 1,
            resourceKind: "outreach_authorization",
            resourceId: authorizationId,
            allowFact: { reasonCode: ALLOW_REASONS.STEP_UP_FRESH, assuranceClass: "STEP_UP", policyVersion: AUTHORIZATION_POLICY_VERSION },
          };
        },
      });
    },
  };
}
