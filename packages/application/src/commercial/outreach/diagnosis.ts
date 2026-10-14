/**
 * RecordOutreachDiagnosis — POST /api/v1/ops/outreach/diagnoses — the corporate owner under step-up (plan docs/design/B12-outreach-plan.md §2,
 * A12 health pause; GAP-DG-1/2). A bounce, a complaint or a provider warning pauses the person (KC034) until the owner records a diagnosis; the
 * diagnosis lifts the pause by being the newest record of the person: the pause rule counts only the person's sends after it. One COMMIT under
 * L1 owner S → L2 → L4 X of the person: against a CMD063 of the person, CMD063 waits and then sends (order 1), or is refused 409 KC034 and the
 * pause is then lifted (order 2). The step-up is judged again at the effect, after the L4 wait, and the database repeats the binding to the
 * owner's own proof (0072 outreach_diagnoses_birth).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AssuranceProofId, UserId } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { assureStepUpAtCommit } from "../../ports/assurance-and-admission.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { RECORD_OUTREACH_DIAGNOSIS, type RecordOutreachDiagnosisBody } from "../contracts.js";
import type { OutreachDiagnosisView } from "../views.js";
import type { ActivityCollaborators } from "./activity-ports.js";

export function recordOutreachDiagnosisHandler(runtime: CommerceRequestRuntime, co: ActivityCollaborators): CommercialCommandHandler<RecordOutreachDiagnosisBody, OutreachDiagnosisView> {
  const spec = RECORD_OUTREACH_DIAGNOSIS;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<RecordOutreachDiagnosisBody>): Promise<CommandResult<OutreachDiagnosisView>> {
      const context = operatorContextOf(envelope);
      return runCommerceCommand<RecordOutreachDiagnosisBody, OutreachDiagnosisView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        replayVersion: () => 1,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("RecordOutreachDiagnosis", decision);
        },
        async body(uow, _causationId, _now: UtcInstant) {
          const body = envelope.body;
          const proof = body.assuranceProofRef as AssuranceProofId;
          const first = await assureStepUpAtCommit(uow, co.assurance, envelope.userId, proof, runtime.clock);
          if (first.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `recording a diagnosis needs a fresh step-up: ${first.reason}`, { reason: first.reason });
          // the store takes L4 X of the person (waiting behind a claim or a send in flight), then the step-up is judged again at the effect
          const view = await co.activity(uow).recordDiagnosis({
            diagnosisId: uow.ids.next(),
            ownerUserId: envelope.userId as UserId,
            personUserId: body.personUserId,
            evidenceHash: body.evidenceHash,
            proofId: first.proofId,
          });
          const atEffect = await assureStepUpAtCommit(uow, co.assurance, envelope.userId, proof, runtime.clock);
          if (atEffect.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `recording a diagnosis needs a step-up still fresh at its effect: ${atEffect.reason}`, { reason: atEffect.reason });
          return {
            status: 201,
            view,
            version: 1,
            resourceKind: "outreach_diagnosis",
            resourceId: view.diagnosisId,
            allowFact: { reasonCode: ALLOW_REASONS.STEP_UP_FRESH, assuranceClass: "STEP_UP", policyVersion: AUTHORIZATION_POLICY_VERSION },
          };
        },
      });
    },
  };
}
