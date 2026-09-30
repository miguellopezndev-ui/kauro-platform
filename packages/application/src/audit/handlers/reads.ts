/**
 * The read of the audit package (design B08 §12, D8-API-1; 10 "Long work returns 202 with operationId, current state, status URL and
 * allowed polling guidance"): GetAudit, the status path StartAudit's 202 names. It runs B06's read pipeline (runReadIn: the subject, the
 * identity status, the ACTIVE live membership after its transition lock — every role reads, AGENCY_READER — then the projection; every
 * denial a durable fact) in an audit unit of work. An audit of another agency and a nonexistent audit answer alike (NOT_FOUND); the view
 * is the audit's safe progress (projections.auditView): never a revision or target hash, a requesting membership, the profile evidence,
 * a step, a model task, a provider identity, a prompt, the pool the grant was carved from or a customer value.
 */
import type { AuditId, AuditUnitOfWork, AuditUnitOfWorkFactory, ResolvedMembership } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import type { ReadContext, ReadHandler, ReadRequest, ReadResult } from "../../queries/reads.js";
import { runReadIn } from "../../queries/reads.js";
import { AUDIT_READ_ROUTES } from "../read-specs.js";
import type { AuditView } from "../views.js";
import { auditView } from "./projections.js";
import type { AuditReadRuntime } from "./intake.js";

export interface AuditReadHandlers {
  readonly GetAudit: ReadHandler<AuditView>;
}

function member(ctx: ReadContext): ResolvedMembership {
  if (ctx.membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "an agency read was authorized without a membership");
  return ctx.membership;
}

export function createAuditReadHandlers(runtime: AuditReadRuntime): AuditReadHandlers {
  const run = <T>(context: Parameters<AuditUnitOfWorkFactory["run"]>[0], work: (uow: AuditUnitOfWork) => Promise<T>): Promise<T> => runtime.unitOfWork.run(context, work);
  const read = <View>(operationId: keyof typeof AUDIT_READ_ROUTES, request: ReadRequest, body: (uow: AuditUnitOfWork, ctx: ReadContext) => Promise<View>): Promise<ReadResult<View>> =>
    runReadIn<View, AuditUnitOfWork>(AUDIT_READ_ROUTES[operationId], runtime, request, run, body);

  const getAudit: ReadHandler<AuditView> = {
    spec: AUDIT_READ_ROUTES.GetAudit,
    execute: (request) =>
      read("GetAudit", request, async (uow, ctx) => {
        const membership = member(ctx);
        const audit = await uow.audits.getAudit(request.path["auditId"] as AuditId);
        if (!audit || audit.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "audit not visible");
        const grant = await uow.audits.getGrant(audit.grantId);
        if (!grant) throw new DomainFailure("INTEGRITY_FAILURE", "an audit's grant is not visible");
        return auditView(audit, grant, membership.role);
      }),
  };

  return Object.freeze({ GetAudit: getAudit });
}
