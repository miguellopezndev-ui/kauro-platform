/**
 * The decision-artifact intake — POST /api/v1/audits/{auditId}/decision-artifacts — AGENCY_OPERATOR (design B08 §8, §12; D8-PLAN-1,
 * D8-AUD-3, D8-CMA-7). Not a catalogue command: the artifact is evidence the agency hands the platform (its candidate decisions for
 * CMD022, a typed decision patch for CMD023), not an aggregate change, so it takes no command journal entry and no version; it is
 * content-idempotent instead — the same (kind, document) again answers the stored artifact with created false (200), whatever
 * reference the first request minted (B07's selection manifest intake is its template).
 *
 * Order (manual 10, as for every route): the envelope's admission (content type, size, strict JSON, the closed document schema, path ids,
 * the agency selector) → the authenticated subject → the access decision of the reads (ACTIVE live membership after its transition
 * lock) and the route's own role (AGENCY_OPERATOR: ROLE_INSUFFICIENT, a recorded denial) → the audit (NOT_FOUND; a foreign and a
 * nonexistent audit answer alike; an audit in ANY state — a plan may be revised long after its audit ended) → the document's size
 * → stored once per content at the server's instant by the caller's own membership.
 *
 * What the document means is the Intelligence core's to decide when it is compiled (CMD022, CMD023): the intake states only that it is
 * one JSON object of a bounded size.
 */
import type { ArtifactRef, AuditId, AuditUnitOfWork, AuditUnitOfWorkFactory, DecisionArtifactKind, MembershipId } from "@kauro/domain";
import { DomainFailure, roleSatisfies } from "@kauro/domain";
import type { AuditIntakeId } from "../contracts.js";
import { DECISION_ARTIFACT_SCHEMA_ID } from "../request-schemas.js";
import type { DecisionArtifactIntakeView } from "../views.js";
import { runReadIn, type ReadContext, type ReadRuntime } from "../../queries/reads.js";
import type { IntakeHandler, IntakeSpec } from "../../sources/handlers/intake.js";

/** The bound of a stored decision document: half the database's (migration 0023 documents.pg_column_size <= 262144), in serialized UTF-8 bytes. */
export const DECISION_DOCUMENT_MAX_BYTES = 131072;

/** The read runtime over an audit unit-of-work factory (the intake reads the audit and stores the artifact in one unit of work). */
export interface AuditReadRuntime extends ReadRuntime {
  readonly unitOfWork: AuditUnitOfWorkFactory;
}

export const AUDIT_INTAKE_ROUTES: Readonly<Record<AuditIntakeId, IntakeSpec>> = Object.freeze({
  SubmitDecisionArtifact: Object.freeze({
    operationId: "SubmitDecisionArtifact",
    method: "POST",
    path: "/api/v1/audits/{auditId}/decision-artifacts",
    action: "SUBMIT_DECISION_ARTIFACT",
    scope: "AGENCY_HEADER",
    schemaId: DECISION_ARTIFACT_SCHEMA_ID,
    summary: "Stores a decision artifact of an audit (content-idempotent; CMD022 and CMD023 compile it by reference)",
    authority: "B08 design §8, §12 (D8-PLAN-1, D8-API-1): the agency's decisions enter as evidence, never through a command; B07 D-SEL-2: a non-journaled, content-idempotent intake",
  }),
});

/** The role the intake needs (registry role vocabulary, B06 D-AUTHZ-1): an operating role of the agency, as CreatePlan and RevisePlan. */
export const DECISION_ARTIFACT_INTAKE_ROLE = "AGENCY_OPERATOR" as const;

export interface AuditIntakeHandlers {
  readonly SubmitDecisionArtifact: IntakeHandler<DecisionArtifactIntakeView>;
}

function member(ctx: ReadContext) {
  if (ctx.membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "an agency intake was authorized without a membership");
  return ctx.membership;
}

export function createAuditIntakeHandlers(runtime: AuditReadRuntime): AuditIntakeHandlers {
  const spec = AUDIT_INTAKE_ROUTES.SubmitDecisionArtifact;
  const submit: IntakeHandler<DecisionArtifactIntakeView> = {
    spec,
    async execute(request) {
      const run = <T>(context: Parameters<AuditUnitOfWorkFactory["run"]>[0], work: (uow: AuditUnitOfWork) => Promise<T>): Promise<T> => runtime.unitOfWork.run(context, work);
      const result = await runReadIn<DecisionArtifactIntakeView, AuditUnitOfWork>(spec, runtime, request, run, async (uow, ctx) => {
        const membership = member(ctx);
        if (!roleSatisfies(DECISION_ARTIFACT_INTAKE_ROLE, membership.role)) throw new DomainFailure("NOT_AUTHORIZED", "the intake needs an operating role", { reason: "ROLE_INSUFFICIENT" });
        const auditId = request.path["auditId"] as AuditId;
        const audit = await uow.audits.getAudit(auditId);
        if (!audit || audit.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "audit not visible");
        const envelope = request.body as { readonly kind: DecisionArtifactKind; readonly document: Readonly<Record<string, unknown>> };
        if (new TextEncoder().encode(JSON.stringify(envelope.document)).byteLength > DECISION_DOCUMENT_MAX_BYTES) {
          throw new DomainFailure("INVALID_REQUEST", "the decision document is larger than the intake takes", { reason: "BODY_TOO_LARGE" });
        }
        const stored = await uow.audits.storeDecisionArtifact({
          artifactRef: uow.ids.next() as ArtifactRef,
          agencyId: membership.agencyId,
          auditId,
          kind: envelope.kind,
          document: envelope.document,
          createdByMembershipId: membership.membershipId as MembershipId,
        });
        return { artifactRef: stored.artifact.artifactRef, auditId: stored.artifact.auditId, kind: stored.artifact.kind, contentHash: stored.artifact.contentHash, created: stored.created };
      });
      if (result.kind === "PROBLEM") return result;
      return { kind: "STORED", created: result.view.created, view: result.view };
    },
  };
  return Object.freeze({ SubmitDecisionArtifact: submit });
}
