/**
 * CMD064 RecordSalesActivity — POST /api/v1/ops/sales/activities — an ACTIVE seller (own prospects) or the corporate owner — scope CORPORATE
 * (plan docs/design/B12-outreach-plan.md §2 "CMD064"; registry SalesActivity: "deduplicated, evidence-backed", "Submission, receipt and customer
 * response are different facts").
 *
 * One COMMIT in B06's pipeline order: access (the caller's ACTIVE seller row, else its ACTIVE KAURO_OWNER grant, L1 S) → journal (L2) → the
 * kind-shape check of the closed body → the store: the serializer set of the kind in the global order (REPLIED L3 X, L10 X; BOUNCED L3 X, L4 X,
 * L10 X; SUPPRESSED [L4 X for COMPLAINT], L8 X, [L10 X], L14; HUMAN SENT L3 S, L10 X; HUMAN NOT_SENT L3 S, L4 S, L4g S, L10 X), the judgment at
 * kauro.effect_now() (occurredAt <= it), then activity + its intent/draft edge + (SUPPRESSED) suppression row + own prospect SUPPRESSED.
 * Actors and kinds (plan §2): PROVIDER_ACCEPTED / SEND_UNCERTAIN are the service's, never a person's (the closed schema has no such kind);
 * BOUNCED and REPLIED a person's; SUPPRESSED a seller's (CONTACT) or the owner's (CONTACT | ORGANIZATION); HUMAN_SEND_OBSERVED a person's.
 * The dispatcher is not swept: a queued intent of a suppressed contact is refused at its claim (D-B12O-16).
 */
import type { UtcInstant } from "@kauro/contracts";
import { DomainFailure, type SellerId, type UserId } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { RECORD_SALES_ACTIVITY, type RecordSalesActivityBody, type SalesActivityInput } from "../contracts.js";
import type { SalesActivityView } from "../views.js";
import type { ActivityCollaborators, RecordActivityRequest } from "./activity-ports.js";

const schemaViolation = (field: string): DomainFailure =>
  new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields: [{ field, code: "FORMAT" }] });

/**
 * The kind-shape rules the closed schema cannot state (plan §2 CMD064): which optional members each kind needs and which it refuses.
 * `NONE` as the provider reference is admitted only for SUPPRESSED and HUMAN_SEND_OBSERVED. The first violation answers SCHEMA_VIOLATION.
 */
export function checkActivityShape(a: SalesActivityInput, owner: boolean): void {
  const suppression = a.suppressionKeyKind !== undefined || a.suppressionReason !== undefined;
  switch (a.kind) {
    case "REPLIED":
    case "BOUNCED":
      if (a.draftId === undefined) throw schemaViolation("activity.draftId");
      if (a.providerMessageRef === "NONE") throw schemaViolation("activity.providerMessageRef");
      if (a.observation !== undefined) throw schemaViolation("activity.observation");
      if (suppression) throw schemaViolation("activity.suppressionKeyKind");
      return;
    case "HUMAN_SEND_OBSERVED":
      if (a.draftId === undefined) throw schemaViolation("activity.draftId");
      if (a.observation === undefined) throw schemaViolation("activity.observation");
      if (suppression) throw schemaViolation("activity.suppressionKeyKind");
      return;
    case "SUPPRESSED":
      if (a.suppressionKeyKind === undefined) throw schemaViolation("activity.suppressionKeyKind");
      if (a.suppressionReason === undefined) throw schemaViolation("activity.suppressionReason");
      if (a.observation !== undefined) throw schemaViolation("activity.observation");
      if (a.providerMessageRef !== "NONE") throw schemaViolation("activity.providerMessageRef");
      // the organization key is the owner's (plan §2: seller CONTACT, owner CONTACT | ORGANIZATION)
      if (a.suppressionKeyKind === "ORGANIZATION" && !owner) throw schemaViolation("activity.suppressionKeyKind");
      // a complaint names the complained intent (its draft) and pauses that intent's person
      if (a.suppressionReason === "COMPLAINT" && a.draftId === undefined) throw schemaViolation("activity.draftId");
      return;
  }
}

export function recordActivityHandler(runtime: CommerceRequestRuntime, co: ActivityCollaborators): CommercialCommandHandler<RecordSalesActivityBody, SalesActivityView> {
  const spec = RECORD_SALES_ACTIVITY;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<RecordSalesActivityBody>): Promise<CommandResult<SalesActivityView>> {
      const context = operatorContextOf(envelope);
      let sellerId: SellerId | null = null;
      return runCommerceCommand<RecordSalesActivityBody, SalesActivityView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        replayVersion: () => 1,
        async access(uow) {
          const asSeller = await co.authorizer.authorizeSeller(uow, { identity: envelope.subject.identity });
          if (asSeller.kind === "ALLOW") {
            sellerId = asSeller.sellerId as SellerId;
            return;
          }
          if (asSeller.reason !== "CORPORATE_ROLE_MISSING") throw CommerceAccessDenied.of("CMD064", asSeller);
          const asOwner = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (asOwner.kind === "DENY") throw CommerceAccessDenied.of("CMD064", asOwner);
        },
        async body(uow, _causationId, _now: UtcInstant) {
          const a = envelope.body.activity;
          checkActivityShape(a, sellerId === null);
          const request: RecordActivityRequest = {
            activityId: uow.ids.next(),
            suppressionId: uow.ids.next(),
            callerUserId: envelope.userId as UserId,
            callerSellerId: sellerId,
            prospectId: a.prospectId,
            draftId: a.draftId ?? null,
            kind: a.kind,
            occurredAt: a.occurredAt,
            evidenceHash: a.evidenceHash,
            providerMessageRef: a.providerMessageRef,
            observation: a.observation ?? null,
            suppressionKeyKind: a.suppressionKeyKind ?? null,
            suppressionReason: a.suppressionReason ?? null,
          };
          const view = await co.activity(uow).record(request);
          return { status: 201, view, version: 1, resourceKind: "sales_activity", resourceId: view.activityId };
        },
      });
    },
  };
}
