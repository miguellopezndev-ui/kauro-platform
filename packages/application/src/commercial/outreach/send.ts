/**
 * CMD063 SendAuthorizedOutreach — POST /api/v1/ops/outreach/{draftId}/send — an ASSIGNED_SELLER_OR_OWNER — package B12, lane L-SEND (plan
 * docs/design/B12-outreach-plan.md §0 A1..A15, §L CMD063 trace, §M M1..M14, §W).
 *
 * One unit of work of the caller's OPERATOR context, in B06's pipeline order: access (the caller's own ACTIVE seller row, else its own
 * ACTIVE KAURO_OWNER grant: L1) -> journal reserve (L2) or the replay of the journaled 200 -> the body: the store takes L3 X, L4 X, L4g S,
 * L5 S, L6 S, L6p S, L7 S, L8 S, L10 X, judges at the database's instant (version, content hash, sender, suppression, draft state, policy,
 * resources, compliance configuration) and writes the intent QUEUED (the database's T3 judges the grant, the 24 h cap, the cadence, the
 * calendar and the health pause at its birth) and its draft DRAFT -> AUTHORIZED; then ONE event outreach.send_intended.v1 of the
 * agency-less aggregate outreach_send_intent at version 1 and its outbox record for the dispatcher (consumer OUTREACH_SENDER), written by
 * the unit's publisher as kauro_app (K1b). The unit makes no provider call: the dispatcher (D2..D5) claims and submits.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { CausationId, CommerceUnitOfWork, IdentityFacts, SellerId, UserId } from "@kauro/domain";
import { DomainFailure, isUuid } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import type { CommercialAuthorizer } from "../authorizer.js";
import { SEND_AUTHORIZED_OUTREACH, type SendAuthorizedOutreachBody } from "../contracts.js";
import type { OutreachSendView } from "../views.js";
import type { OutreachSendCollaborators, SendActor } from "./send-store.js";

export const SEND_AUTHORIZED_OUTREACH_OPERATION = "CMD063";

function refuseShape(field: string, code: "FORMAT" | "TYPE"): never {
  throw new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields: [{ field, code }] });
}

/** The caller as the sender person: its own ACTIVE seller row, else its own ACTIVE KAURO_OWNER grant (the shape of CMD045). */
async function senderPerson(authorizer: CommercialAuthorizer, uow: CommerceUnitOfWork, identity: IdentityFacts): Promise<SendActor> {
  const asSeller = await authorizer.authorizeSeller(uow, { identity });
  if (asSeller.kind === "ALLOW") return { kind: "SELLER", userId: asSeller.userId as UserId, sellerId: asSeller.sellerId as SellerId };
  if (asSeller.reason !== "CORPORATE_ROLE_MISSING") throw CommerceAccessDenied.of(SEND_AUTHORIZED_OUTREACH_OPERATION, asSeller);
  const asOwner = await authorizer.authorizeCorporateOwner(uow, { identity });
  if (asOwner.kind === "DENY") throw CommerceAccessDenied.of(SEND_AUTHORIZED_OUTREACH_OPERATION, asOwner);
  return { kind: "OWNER", userId: asOwner.userId as UserId };
}

export function sendHandler(runtime: CommerceRequestRuntime, co: OutreachSendCollaborators): CommercialCommandHandler<SendAuthorizedOutreachBody, OutreachSendView> {
  const spec = SEND_AUTHORIZED_OUTREACH;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<SendAuthorizedOutreachBody>): Promise<CommandResult<OutreachSendView>> {
      const context = operatorContextOf(envelope);
      let actor: SendActor | null = null;
      return runCommerceCommand<SendAuthorizedOutreachBody, OutreachSendView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        replayVersion: () => 1,
        async access(uow) {
          actor = await senderPerson(co.authorizer, uow, envelope.subject.identity);
        },
        async body(uow, causationId: CausationId, _now: UtcInstant) {
          if (actor === null) throw new DomainFailure("INTEGRITY_FAILURE", "a send was authorized without an actor");
          const body = envelope.body;
          const draftId = envelope.path["draftId"];
          if (draftId === undefined || !isUuid(draftId)) refuseShape("draftId", "FORMAT");
          if (!isUuid(body.authorizationId)) refuseShape("authorizationId", "FORMAT");
          if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) refuseShape("expectedVersion", "TYPE");
          const queued = await co.sends(uow).queueSend({
            intentId: uow.ids.next(),
            draftId,
            authorizationId: body.authorizationId,
            actor,
            expectedVersion: body.expectedVersion,
            contentHash: body.contentHash,
            seal: (facts) => co.sealer.seal(facts),
          });
          await uow.events.publish({
            aggregateKind: "outreach_send_intent",
            aggregateId: queued.intentId,
            aggregateVersion: 1,
            agencyId: null,
            eventType: "outreach.send_intended.v1",
            actor: { kind: "USER", userId: actor.userId },
            causationId,
            correlationId: envelope.correlationId,
            payload: {
              intentId: queued.intentId,
              draftId: queued.draftId,
              authorizationId: queued.authorizationId,
              senderId: queued.senderId,
              prospectId: queued.prospectId,
              purpose: queued.purpose,
              route: queued.route,
              payloadHash: queued.payloadHash,
            },
          } as never);
          return {
            status: 200,
            view: {
              draftId: queued.draftId,
              draftState: "AUTHORIZED",
              intentId: queued.intentId,
              intentState: "QUEUED",
              authorizationId: queued.authorizationId,
              payloadHash: queued.payloadHash as Sha256Hex,
              queuedAt: queued.queuedAt as UtcInstant,
            },
            version: 1,
            resourceKind: "outreach_send_intent",
            resourceId: queued.intentId,
          };
        },
      });
    },
  };
}
