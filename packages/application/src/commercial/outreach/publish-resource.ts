/**
 * PublishSalesResource — POST /api/v1/ops/sales/resources — KAURO_OWNER with a fresh step-up — no provider effect (package B12, lane
 * L-DRAFT; plan docs/design/B12-outreach-plan.md §0 A8, §L Publish trace, §M M40, R2-135; companion B12-outreach-plan-cells.md §R Publish row).
 *
 * Version n+1 of a family of sales resources (or version 1 of a new family), one COMMIT: access (the caller's own ACTIVE KAURO_OWNER
 * grant: L1) → journal reserve (L2) or the replay → the owner's step-up fresh (ASSURANCE_REQUIRED) → the store takes L5 S of every claimed
 * capability and L6 X of the family, reads the family's latest version AFTER the subject was taken (a stale expectedVersion is 409
 * STALE_VERSION, an unknown family NOT_FOUND), supersedes n (the edge trigger lets CURRENT -> SUPERSEDED only under L6 X), inserts n+1
 * CURRENT (T7: one CURRENT per family, judged at COMMIT) and its capability claims → the step-up judged again at COMMIT, the ALLOW fact.
 * A draft or grant that cites a superseded version is refused later (RESOURCE_NOT_CURRENT); historical rows are kept.
 *
 * GAP (until K2-lite records R2's rule for this command): the step-up proof is the owner's LATEST STEP_UP proof, since the request carries no
 * authorizationRef; the body gains one if the registration names it, and `latestStepUpProof` goes.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CausationId } from "@kauro/domain";
import { DomainFailure, isUuid } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { assureStepUpAtCommit } from "../../ports/assurance-and-admission.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import type { DraftCommandHandler, OutreachDraftCollaborators, PublishedResourceView } from "./draft-store.js";

export interface PublishSalesResourceBody {
  /** Absent: a new family (version 1). */
  readonly familyId?: string;
  /** The CURRENT version the publisher read; required with `familyId`. */
  readonly expectedVersion?: number;
  readonly contentRef: string;
  readonly capabilityIds: ReadonlyArray<string>;
}

export const PUBLISH_SALES_RESOURCE_OPERATION = "PublishSalesResource";

function refuseShape(field: string, code: "FORMAT" | "REQUIRED" | "UNKNOWN_FIELD"): never {
  throw new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields: [{ field, code }] });
}

export function publishResourceHandler(runtime: CommerceRequestRuntime, co: OutreachDraftCollaborators): DraftCommandHandler<PublishSalesResourceBody, PublishedResourceView> {
  return {
    operation: PUBLISH_SALES_RESOURCE_OPERATION,
    async execute(envelope: CommandEnvelope<PublishSalesResourceBody>): Promise<CommandResult<PublishedResourceView>> {
      const context = operatorContextOf(envelope);
      return runCommerceCommand<PublishSalesResourceBody, PublishedResourceView>(runtime, {
        command: { id: PUBLISH_SALES_RESOURCE_OPERATION, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of(PUBLISH_SALES_RESOURCE_OPERATION, decision);
        },
        async body(uow, _causationId: CausationId, _now: UtcInstant) {
          const body = envelope.body;
          if (body.familyId !== undefined && !isUuid(body.familyId)) refuseShape("familyId", "FORMAT");
          if (body.familyId !== undefined && body.expectedVersion === undefined) refuseShape("expectedVersion", "REQUIRED");
          if (body.familyId === undefined && body.expectedVersion !== undefined) refuseShape("expectedVersion", "UNKNOWN_FIELD");
          if (!body.capabilityIds.every((id) => isUuid(id))) refuseShape("capabilityIds", "FORMAT");
          const drafts = co.drafts(uow);
          const proof = await drafts.latestStepUpProof(envelope.userId);
          const assured = await assureStepUpAtCommit(uow, co.assurance, envelope.userId, proof, runtime.clock);
          if (assured.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `publishing a sales resource needs a fresh step-up: ${assured.reason}`, { reason: assured.reason });
          const published = await drafts.publishResource({
            resourceId: uow.ids.next(),
            familyId: body.familyId ?? null,
            expectedVersion: body.expectedVersion ?? null,
            contentRef: body.contentRef,
            capabilityIds: body.capabilityIds,
            publishedByUserId: envelope.userId,
          });
          return {
            status: 201,
            view: published,
            version: published.version,
            resourceKind: "sales_resource",
            resourceId: published.resourceId,
            allowFact: { reasonCode: ALLOW_REASONS.STEP_UP_FRESH, assuranceClass: "STEP_UP", policyVersion: AUTHORIZATION_POLICY_VERSION },
          };
        },
      });
    },
  };
}
