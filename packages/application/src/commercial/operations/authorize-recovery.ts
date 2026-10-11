/**
 * CMD057 AuthorizeRecovery — POST /api/v1/operations/recoveries — KAURO_OWNER with a fresh step-up — scope CORPORATE — no provider effect
 * (registry command CMD057, gate G-RECOVERY; 08 "High-impact actions require recent step-up").
 *
 * One unit of work of the owner's OPERATOR context, in B06's pipeline order: access (the caller's own ACTIVE KAURO_OWNER grant) → journal
 * reserve (or the replay) → the owner's step-up fresh (ASSURANCE_REQUIRED) → the restore candidate FOR UPDATE (NOT_FOUND) → PREPARED
 * (RECOVERY_CANDIDATE_NOT_PREPARED: a restore authorizes once, two authorizations serialize on the candidate row) → the owner's deletion
 * journal hash is the candidate's own (RECOVERY_DELETION_JOURNAL_MISMATCH: a restore must not resurrect deleted rows) → the step-up judged
 * again at the effect → the candidate AUTHORIZED with the recovery row, its ALLOW fact in the same COMMIT. The restore itself is run and
 * released by the control plane after its own checks; no data is restored here.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AssuranceProofId, CausationId, RecoveryId, RestoreCandidateId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { assureStepUpAtCommit } from "../../ports/assurance-and-admission.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import { applied } from "../agency/shared.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { AUTHORIZE_RECOVERY, type AuthorizeRecoveryBody } from "../contracts.js";
import type { RecoveryAuthorizationView } from "../views.js";
import type { OperationsRequestCollaborators } from "./runtime.js";

export function authorizeRecoveryHandler(runtime: CommerceRequestRuntime, co: OperationsRequestCollaborators): CommercialCommandHandler<AuthorizeRecoveryBody, RecoveryAuthorizationView> {
  const spec = AUTHORIZE_RECOVERY;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<AuthorizeRecoveryBody>): Promise<CommandResult<RecoveryAuthorizationView>> {
      const context = operatorContextOf(envelope);
      return runCommerceCommand<AuthorizeRecoveryBody, RecoveryAuthorizationView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD057", decision);
        },
        async body(uow, _causationId: CausationId, _now: UtcInstant) {
          const body = envelope.body;
          const assured = await assureStepUpAtCommit(uow, co.assurance, envelope.userId, body.authorizationRef as AssuranceProofId, runtime.clock);
          if (assured.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `authorizing a recovery needs a fresh step-up: ${assured.reason}`, { reason: assured.reason });
          const operations = co.operations(uow);
          const candidate = await operations.lockCandidate(body.restoreCandidateRef as RestoreCandidateId);
          if (candidate === null) throw new NotFoundFailure("restore_candidate");
          if (candidate.state !== "PREPARED") {
            throw new DomainFailure("PRECONDITION_FAILED", "the restore candidate is already authorized: a restore authorizes once", {
              reason: "RECOVERY_CANDIDATE_NOT_PREPARED",
              currentVersion: candidate.revision,
              currentState: candidate.state,
            });
          }
          if (candidate.deletionJournalHash !== body.deletionJournalHash) {
            throw new DomainFailure("PRECONDITION_FAILED", "deletionJournalHash is not the candidate's own: a restore must honour the deletion journal", { reason: "RECOVERY_DELETION_JOURNAL_MISMATCH" });
          }
          const atEffect = await assureStepUpAtCommit(uow, co.assurance, envelope.userId, body.authorizationRef as AssuranceProofId, runtime.clock);
          if (atEffect.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `authorizing a recovery needs a step-up still fresh at its effect: ${atEffect.reason}`, { reason: atEffect.reason });
          const recoveryId = uow.ids.next() as RecoveryId;
          const recovery = applied(await operations.authorizeRecovery({ recoveryId, candidate, authorizationRef: body.authorizationRef, by: envelope.userId }));
          return {
            status: 200,
            view: { recoveryId, restoreCandidateRef: recovery.candidateId, state: "AUTHORIZED", authorizedAt: recovery.authorizedAt, version: recovery.candidateRevision },
            version: recovery.candidateRevision,
            resourceKind: "recovery",
            resourceId: recoveryId,
            allowFact: { reasonCode: ALLOW_REASONS.STEP_UP_FRESH, assuranceClass: "STEP_UP", policyVersion: AUTHORIZATION_POLICY_VERSION },
          };
        },
      });
    },
  };
}
