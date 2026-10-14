/**
 * WithdrawOutreachChannelPolicy — POST /api/v1/ops/outreach/policy-withdrawals — KAURO_OWNER with a fresh step-up — scope CORPORATE (plan
 * docs/design/B12-outreach-plan.md §2, GAP-API-B12-13, ADV-27; GAP-WP-1..3, M10, M11).
 *
 * Trace (§L): L1 owner S (access) -> L2 (journal) -> the step-up -> L6p X of 'jurisdiction:purpose' -> the newest policy row (NOT_FOUND) ->
 * expectedVersion (STALE_VERSION with the current version and state) -> IN_FORCE (a withdrawn policy: UNLISTED_TRANSITION, 409) -> UPDATE
 * IN_FORCE -> WITHDRAWN. Drafting and queueing hold L6p S, the dispatcher's claim holds it too: a claim in flight is waited for (it submits,
 * then the withdrawal lands), one arriving later is NOT_SENT(POLICY_WITHDRAWN). A withdrawn policy has no reverse edge: a re-review is a new
 * seeded version.
 */
import type { AssuranceProofId, CausationId } from "@kauro/domain";
import type { UtcInstant } from "@kauro/contracts";
import { DomainFailure, NotFoundFailure } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { assureStepUpAtCommit } from "../../ports/assurance-and-admission.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import { checkExpectedVersion } from "../agency/shared.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { WITHDRAW_OUTREACH_CHANNEL_POLICY, type WithdrawOutreachChannelPolicyBody } from "../contracts.js";
import type { OutreachChannelPolicyView } from "../views.js";
import type { OutreachAuthCollaborators } from "./auth-store.js";

export function withdrawPolicyHandler(runtime: CommerceRequestRuntime, co: OutreachAuthCollaborators): CommercialCommandHandler<WithdrawOutreachChannelPolicyBody, OutreachChannelPolicyView> {
  const spec = WITHDRAW_OUTREACH_CHANNEL_POLICY;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<WithdrawOutreachChannelPolicyBody>): Promise<CommandResult<OutreachChannelPolicyView>> {
      const context = operatorContextOf(envelope);
      return runCommerceCommand<WithdrawOutreachChannelPolicyBody, OutreachChannelPolicyView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("WithdrawOutreachChannelPolicy", decision);
        },
        async body(uow, _causationId: CausationId, _now: UtcInstant) {
          const body = envelope.body;
          const assured = await assureStepUpAtCommit(uow, co.assurance, envelope.userId, body.assuranceProofRef as AssuranceProofId, runtime.clock);
          if (assured.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `withdrawing a channel policy needs a fresh step-up: ${assured.reason}`, { reason: assured.reason });
          const store = co.store(uow);
          await store.lockPolicy(body.jurisdiction, body.purpose);
          const policy = await store.latestPolicy(body.jurisdiction, body.purpose);
          if (policy === null) throw new NotFoundFailure("outreach_channel_policy");
          checkExpectedVersion(policy, body.expectedVersion);
          if (policy.state !== "IN_FORCE") {
            throw new DomainFailure("PRECONDITION_FAILED", "the channel policy is already withdrawn", { reason: "UNLISTED_TRANSITION", currentVersion: policy.version, currentState: policy.state });
          }
          await store.withdrawPolicy({ jurisdiction: policy.jurisdiction, purpose: policy.purpose, version: policy.version, byUserId: envelope.userId });
          return {
            status: 200,
            view: { jurisdiction: policy.jurisdiction, purpose: policy.purpose, version: policy.version, state: "WITHDRAWN" },
            version: policy.version,
            resourceKind: "outreach_channel_policy",
            resourceId: uow.ids.next() as string,
            allowFact: { reasonCode: ALLOW_REASONS.STEP_UP_FRESH, assuranceClass: "STEP_UP", policyVersion: AUTHORIZATION_POLICY_VERSION },
          };
        },
      });
    },
  };
}
