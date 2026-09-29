/**
 * CMD044 CreateSupportCase — POST /api/v1/projects/{projectId}/support-cases — AGENCY_MEMBER (design section 5, W4 row; owner
 * manual 18 "Support metadata must not become an unrestricted raw-data channel"; catalogue precondition "The person has access to
 * the project and submitted evidence is safely scoped/minimized"; failure "Raw secrets/CRM files do not enter email or generic
 * telemetry; route secure upload when needed").
 *
 * Order, in one unit of work: authorize (any live membership; AGENCY_MEMBER, D-AUTHZ-1) → journal reserve → the project, locked
 * FOR UPDATE (of another agency, or none, is NOT_FOUND; the lock serializes a case against a concurrent transition of the
 * project, which this edition has none of, and is the pattern of every project-scoped command) → the summary detector
 * (CONTENT_REFUSED: SECRET_LIKE_CONTENT / RECORD_LIKE_CONTENT, next action SECURE_UPLOAD) → severity by category → the covered-hours
 * next review from the policy window and the sourced calendar (CAPACITY_UNAVAILABLE / SUPPORT_CALENDAR_UNAVAILABLE beyond it) →
 * INSERT the case OPEN at version 1 → support_case.opened.v1 (the payload never holds the summary) → journal 201 SupportCaseView.
 *
 * The detector runs after access and after the project relationship, so it answers a person who may act on this project and
 * nobody else, and a refusal is a domain rejection: the unit of work rolls back (the journal reservation included), nothing is
 * stored or published, and the refusal message and problem never carry the refused text (a test sweeps every table and the log
 * sink for it). A case is never edited in this edition, so the only version of a case is 1.
 */
import { policy } from "@kauro/contracts";
import type { ProjectId, SupportCaseId } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { supportCaseView } from "../../api/projections.js";
import type { SupportCaseView } from "../../api/views.js";
import { detectRefusedContent } from "../../support/content-detector.js";
import { nextReviewAt, supportWindowOf, type SupportWindow } from "../../support/covered-hours.js";
import { COLOMBIA_HOLIDAYS, type HolidayCalendar } from "../../support/holidays.js";
import { severityOf } from "../../support/severity.js";
import { CREATE_SUPPORT_CASE, type CreateSupportCaseBody, type CreateSupportCaseHandler } from "../contracts.js";
import { runCommand, type CommandRuntime } from "../runtime.js";
import { requireMembership } from "./shared.js";

/** What the covered-hours calculation reads: the policy window (validated once, when the handler is built) and the holiday calendar. */
export interface SupportOptions {
  readonly window?: SupportWindow;
  readonly calendar?: HolidayCalendar;
}

export function createSupportCaseHandler(runtime: CommandRuntime, options: SupportOptions = {}): CreateSupportCaseHandler {
  // a policy the calculator cannot honor stops the process here, not at the first customer's request
  const window = options.window ?? supportWindowOf(policy()["support"]);
  const calendar = options.calendar ?? COLOMBIA_HOLIDAYS;
  return {
    spec: CREATE_SUPPORT_CASE,
    execute: (envelope) =>
      runCommand<CreateSupportCaseBody, SupportCaseView>(CREATE_SUPPORT_CASE, runtime, envelope, async (uow, ctx) => {
        const membership = requireMembership(ctx);
        const projectId = envelope.path["projectId"] as ProjectId;
        const project = await uow.projects.lock(projectId);
        if (!project || project.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "project not visible");
        const finding = detectRefusedContent(envelope.body.summary);
        if (finding !== null) {
          throw new DomainFailure("CONTENT_REFUSED", "the summary looks like a secret or customer records and was not accepted", { reason: finding });
        }
        const severity = severityOf(envelope.body.category);
        const reviewAt = nextReviewAt(severity, ctx.now, window, calendar);
        const caseId = uow.ids.next() as SupportCaseId;
        const record = await uow.supportCases.insert({
          caseId,
          agencyId: membership.agencyId,
          projectId,
          category: envelope.body.category,
          severity,
          summary: envelope.body.summary,
          evidenceRefs: envelope.body.evidenceRefs ?? [],
          createdByUserId: envelope.userId,
          createdByMembershipId: membership.membershipId,
          nextReviewAt: reviewAt,
          createdAt: ctx.now,
        });
        await uow.events.publish({
          aggregateKind: "support_case",
          aggregateId: caseId,
          aggregateVersion: record.version,
          agencyId: membership.agencyId,
          eventType: "support_case.opened.v1",
          actor: { kind: "USER", userId: envelope.userId },
          causationId: ctx.causationId,
          correlationId: envelope.correlationId,
          payload: { caseId, projectId, category: record.category, severity: record.severity, nextReviewAt: record.nextReviewAt },
        });
        return { status: 201, view: supportCaseView(record), version: record.version, resourceKind: "support_case", resourceId: caseId };
      }),
  };
}
