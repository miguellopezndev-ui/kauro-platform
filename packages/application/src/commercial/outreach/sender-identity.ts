/**
 * RegisterSenderIdentity (POST /api/v1/ops/outreach/senders, owner, step-up), VerifySenderIdentity (POST .../senders/{senderId}/verify, owner)
 * and RecordSenderRevocation (POST .../senders/{senderId}/revoke, owner) — package B12, lane L-SEND (plan docs/design/B12-outreach-plan.md
 * companion §R rows B12-9..B12-11; §L: Register L1 S of the person's seller then the INSERT, Verify and Revoke L7 X). One unit of work of the
 * owner's OPERATOR context in B06's order: access (the owner's own ACTIVE KAURO_OWNER grant) -> journal -> the body. Register spends a fresh
 * step-up of the owner (its ALLOW fact commits with the row). No event and no outbox record: the sender is a corporate record whose edges the
 * database judges (KA095 immutability, the edge machine, LOCK_NOT_HELD). The mailbox address is recorded, never answered.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AssuranceProofId, CausationId, CommerceUnitOfWork } from "@kauro/domain";
import { DomainFailure, isUuid } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { assureStepUpAtCommit } from "../../ports/assurance-and-admission.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import type { CommercialCommandSpec } from "../contracts.js";
import { REGISTER_SENDER_IDENTITY, RECORD_SENDER_REVOCATION, VERIFY_SENDER_IDENTITY, type RecordSenderRevocationBody, type RegisterSenderIdentityBody, type VerifySenderIdentityBody } from "../contracts.js";
import type { SenderIdentityView } from "../views.js";
import type { OutreachSenderCollaborators, SenderRecordView } from "./send-store.js";

function refuseShape(field: string): never {
  throw new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields: [{ field, code: "FORMAT" }] });
}

const viewOf = (r: SenderRecordView): SenderIdentityView => ({ senderId: r.senderId, userId: r.userId, route: r.route, state: r.state, createdAt: r.createdAt as UtcInstant, updatedAt: r.updatedAt as UtcInstant });

function senderHandler<Body>(
  runtime: CommerceRequestRuntime,
  co: OutreachSenderCollaborators,
  spec: CommercialCommandSpec<Body>,
  status: 200 | 201,
  stepUpRef: ((body: Body) => string) | null,
  work: (uow: CommerceUnitOfWork, envelope: CommandEnvelope<Body>) => Promise<SenderRecordView>,
): CommercialCommandHandler<Body, SenderIdentityView> {
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<Body>): Promise<CommandResult<SenderIdentityView>> {
      return runCommerceCommand<Body, SenderIdentityView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context: operatorContextOf(envelope),
        replayVersion: () => 1,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of(spec.id, decision);
        },
        async body(uow, _causationId: CausationId, _now: UtcInstant) {
          if (stepUpRef !== null) {
            const assured = await assureStepUpAtCommit(uow, co.assurance, envelope.userId, stepUpRef(envelope.body) as AssuranceProofId, runtime.clock);
            if (assured.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `${spec.id} needs a fresh step-up: ${assured.reason}`, { reason: assured.reason });
          }
          const record = await work(uow, envelope);
          return {
            status,
            view: viewOf(record),
            version: 1,
            resourceKind: "sender_identity",
            resourceId: record.senderId,
            ...(stepUpRef !== null ? { allowFact: { reasonCode: ALLOW_REASONS.STEP_UP_FRESH, assuranceClass: "STEP_UP" as const, policyVersion: AUTHORIZATION_POLICY_VERSION } } : {}),
          };
        },
      });
    },
  };
}

export function registerSenderIdentityHandler(runtime: CommerceRequestRuntime, co: OutreachSenderCollaborators): CommercialCommandHandler<RegisterSenderIdentityBody, SenderIdentityView> {
  return senderHandler<RegisterSenderIdentityBody>(runtime, co, REGISTER_SENDER_IDENTITY, 201, (b) => b.assuranceProofRef, (uow, envelope) => {
    const b = envelope.body;
    if (!isUuid(b.userId)) refuseShape("userId");
    return co.senders(uow).register({ senderId: uow.ids.next(), userId: b.userId, address: b.address, route: b.route, consentEvidenceRef: b.consentEvidenceRef ?? null, recordedByUserId: envelope.userId });
  });
}

export function verifySenderIdentityHandler(runtime: CommerceRequestRuntime, co: OutreachSenderCollaborators): CommercialCommandHandler<VerifySenderIdentityBody, SenderIdentityView> {
  return senderHandler<VerifySenderIdentityBody>(runtime, co, VERIFY_SENDER_IDENTITY, 200, null, (uow, envelope) => {
    const senderId = envelope.path["senderId"];
    if (senderId === undefined || !isUuid(senderId)) refuseShape("senderId");
    return co.senders(uow).verify(senderId, envelope.body.verificationEvidenceHash);
  });
}

export function recordSenderRevocationHandler(runtime: CommerceRequestRuntime, co: OutreachSenderCollaborators): CommercialCommandHandler<RecordSenderRevocationBody, SenderIdentityView> {
  return senderHandler<RecordSenderRevocationBody>(runtime, co, RECORD_SENDER_REVOCATION, 200, null, (uow, envelope) => {
    const senderId = envelope.path["senderId"];
    if (senderId === undefined || !isUuid(senderId)) refuseShape("senderId");
    return co.senders(uow).revoke(senderId);
  });
}
