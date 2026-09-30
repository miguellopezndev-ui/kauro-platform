/**
 * CMD036 ExecuteProject — POST /api/v1/projects/{projectId}/execute — AGENCY_OPERATOR (design B08 §4 item 1, §12; D8-JOB-1,
 * D8-JOB-2, D8-AUTH-1, D8-CAP-2, D8-LOCK-1, D8-STALE-1, D8-RET-1; catalogue "Verify entitlement, capability, source, target,
 * plan, approval and capacity; queue the job").
 *
 * Order: authorize → reserve → the project row (NOT_FOUND; a foreign and a nonexistent project answer alike) and its shared
 * transition lock → the authorization after its shared transition lock (D-TX-2: a revocation issued meanwhile waits, one committed
 * first is what is read; NOT_FOUND when it is not this project's) → the job it already has, in whatever state (D8-JOB-1: the
 * same job is answered, before any prerequisite is checked, even one that was cancelled — the authorization is not spent, not revived
 * and not duplicated) → the approval and the receipt it names (the execution subject, D8-JOB-2) → the shared transition locks of
 * the facts in the order of D8-LOCK-1 (approval, source, target, capability, agency) → the agency ACTIVE (AGENCY_NOT_ACTIVE), the
 * project OPEN (PROJECT_NOT_OPEN), the authorization ACTIVE (AUTHORIZATION_REVOKED), its approval live on an APPROVED plan
 * (PLAN_NOT_APPROVED), the source SEALED and available (SOURCE_EXPIRED), the target current (TARGET_STALE), the mode offered
 * (MODE_NOT_OFFERED) and the agency below its live-job bound (EXECUTION_QUEUE_FULL, D8-CAP-2) → one QUEUED job bound to the
 * authorization's subject, its delivery deadline stamped by the database (capture completion + 172,800 s, D8-RET-1) → the store's
 * processing_job.queued.v1 to JOB_EXECUTION → journal 202 ACCEPTED (operationId = the job, statusPath = its read).
 *
 * The command binds and does not consume: the authorization stays ACTIVE until admission (D8-AUTH-1), so a refusal here, or a
 * crash before COMMIT, never spends an entitlement. The handler publishes nothing itself: the store writes the event and its outbox
 * record in the statement that inserts the job.
 */
import type { CommercialAuthorizationId, MembershipId, ProcessingJobId, ProcessingJobRecord, ProjectId } from "@kauro/domain";
import { DomainFailure, EXECUTION_POLICY, jobInputBindingHashOf } from "@kauro/domain";
import type { AcceptedOutcome } from "../../commands/runtime.js";
import { requireMembership } from "../../commands/handlers/shared.js";
import { EXECUTE_POLL_AFTER_SECONDS, EXECUTE_PROJECT, type ExecuteProjectBody, type ExecuteProjectHandler } from "../contracts.js";
import { reachedOnServer, runExecutionCommand, type ExecutionRuntime } from "./shared.js";

/** The ACCEPTED answer for a job: the operation is the job, its status path the job read (design §12). */
function acceptedFor(job: ProcessingJobRecord): AcceptedOutcome {
  return {
    status: 202,
    accepted: { operationId: job.jobId, state: job.state, statusPath: `/api/v1/jobs/${job.jobId}`, pollAfterSeconds: EXECUTE_POLL_AFTER_SECONDS },
    resourceKind: "processing_job",
    resourceId: job.jobId,
  };
}

export function executeProjectHandler(runtime: ExecutionRuntime): ExecuteProjectHandler {
  return {
    spec: EXECUTE_PROJECT,
    execute: (envelope) =>
      runExecutionCommand<ExecuteProjectBody, never>(
        EXECUTE_PROJECT,
        runtime,
        envelope,
        async (uow, ctx) => {
          const membership = requireMembership(ctx);
          const x = uow.execution;
          const projectId = envelope.path["projectId"] as ProjectId;
          const authorizationId = envelope.body.commercialAuthorizationId as CommercialAuthorizationId;

          // the project row, then its shared transition lock; a project of another agency is the answer of one that never existed
          const found = await uow.projects.get(projectId);
          if (!found || found.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "project not visible");
          const project = await uow.projects.lock(projectId);
          if (!project) throw new DomainFailure("NOT_FOUND", "project not visible");
          await x.awaitTransition({ kind: "PROJECT", key: projectId });

          // the authorization after its shared transition lock: a revocation in flight is waited for and its outcome is what is read
          await x.awaitTransition({ kind: "AUTHORIZATION", key: authorizationId });
          const authorization = await uow.commerce.authorizations.get(authorizationId);
          if (!authorization || authorization.agencyId !== membership.agencyId || authorization.projectId !== projectId) {
            throw new DomainFailure("NOT_FOUND", "project not visible");
          }

          // an authorization that already has a job answers that job, whatever its state (D8-JOB-1)
          const existing = await x.findJobByAuthorization(authorizationId);
          if (existing !== null) return acceptedFor(existing);

          // the execution subject: the authorization's own bindings, the approval's validation receipt and the core package it names (D8-JOB-2)
          const approval = await uow.approvals.get(authorization.approvalId);
          if (!approval) throw new DomainFailure("INTEGRITY_FAILURE", "an authorization's approval is not visible");
          const receipt = await uow.receipts.findByHash(membership.agencyId, approval.validationReceiptHash);
          if (!receipt) throw new DomainFailure("INTEGRITY_FAILURE", "an approval's validation receipt is not visible");
          const subject = {
            agencyId: membership.agencyId,
            projectId,
            authorizationId,
            captureId: authorization.captureId,
            planId: authorization.planId,
            planHash: authorization.planHash,
            approvalId: authorization.approvalId,
            approvalHash: authorization.approvalHash,
            revisionHash: authorization.revisionHash,
            targetContractHash: authorization.targetContractHash,
            capabilityId: authorization.capabilityId,
            capabilityVersion: authorization.capabilityVersion,
            mode: authorization.mode,
            validationReceiptHash: approval.validationReceiptHash,
            corePackageHash: receipt.corePackageHash,
          };

          // the shared transition locks of the facts, in the order of D8-LOCK-1 (plan → source → target; then capability and agency); the source and
          // the target are named by their hashes, so their ids are learned first and every fact is then read again under the locks
          const named = await x.readAuthority(subject);
          await x.awaitTransition({ kind: "APPROVAL", key: authorization.approvalId });
          if (named.revisionId !== null) await x.awaitTransition({ kind: "REVISION", key: named.revisionId });
          if (named.targetContractId !== null) await x.awaitTransition({ kind: "TARGET_CONTRACT", key: named.targetContractId });
          await x.awaitTransition({ kind: "CAPABILITY", key: authorization.mode });
          await x.awaitTransition({ kind: "AGENCY", key: membership.agencyId });
          const facts = await x.readAuthority(subject);

          // the prerequisites in the order of design §4 item 1; each refusal writes nothing and leaves the authorization ACTIVE
          const agency = await uow.agencies.get(membership.agencyId);
          if (!agency) throw new DomainFailure("INTEGRITY_FAILURE", "a member's agency is not visible");
          if (agency.state !== "ACTIVE") {
            throw new DomainFailure("PRECONDITION_FAILED", "customer data is processed only in an ACTIVE agency", { reason: "AGENCY_NOT_ACTIVE", currentVersion: agency.version, currentState: agency.state });
          }
          if (project.state !== "OPEN") {
            throw new DomainFailure("PRECONDITION_FAILED", "the project is not open", { reason: "PROJECT_NOT_OPEN", currentVersion: project.version, currentState: project.state });
          }
          if (authorization.state !== "ACTIVE") {
            throw new DomainFailure("PRECONDITION_FAILED", "the commercial authorization is no longer active", { reason: "AUTHORIZATION_REVOKED", currentVersion: authorization.version, currentState: authorization.state });
          }
          if (!facts.approvalLive || facts.planState !== "APPROVED") {
            const plan = await uow.plans.get(authorization.planId);
            if (!plan) throw new DomainFailure("INTEGRITY_FAILURE", "an authorization's plan is not visible");
            throw new DomainFailure("PRECONDITION_FAILED", "the authorization's approval is no longer live on an approved plan", { reason: "PLAN_NOT_APPROVED", currentVersion: plan.version, currentState: plan.state });
          }
          // the source stays executable while it is SEALED and its retention has not ended, judged on the database's clock (D8-STALE-1, D8-CLOCK-1)
          const sourceEnded = facts.retentionEffectiveDeadline !== null && reachedOnServer(facts.retentionEffectiveDeadline, await uow.serverInstant());
          // B08-R1: an INCLUDED sealed file whose admission was revoked (the revision itself stays SEALED) ends the source as well
          if (facts.revisionState !== "SEALED" || sourceEnded || !facts.sourceFilesAdmitted) throw new DomainFailure("SOURCE_EXPIRED", "the authorization's source revision is no longer available");
          if (!facts.targetCurrent) throw new DomainFailure("TARGET_STALE", "the authorization's target contract is no longer confirmed and current");
          if (!facts.capabilityOffered) throw new DomainFailure("CAPABILITY_UNAVAILABLE", "the authorization's mode is no longer offered", { reason: "MODE_NOT_OFFERED" });

          // the agency's bound (D8-CAP-2): the ledger's own CHECK is the arbiter under concurrency; this read answers the common case with its reason
          const capacity = await x.capacity(membership.agencyId);
          if (capacity.agencyLiveJobs >= EXECUTION_POLICY.agencyLiveJobs) {
            throw new DomainFailure("CAPACITY_UNAVAILABLE", "the agency already holds its live jobs", { reason: "EXECUTION_QUEUE_FULL" });
          }

          const job = await x.queueJob({
            ...subject,
            jobId: uow.ids.next() as ProcessingJobId,
            inputBindingHash: jobInputBindingHashOf(subject),
            createdByMembershipId: membership.membershipId as MembershipId,
          });
          return acceptedFor(job);
        },
        // a 202 has no aggregate version: it is answered from the journaled ACCEPTED members, never through a COMPLETED view
        () => {
          throw new DomainFailure("INTEGRITY_FAILURE", "an ACCEPTED answer carries no aggregate version");
        },
      ),
  };
}
