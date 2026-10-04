/**
 * CMD052 ApproveCommissionPayout — POST /api/v1/sales/statements/{statementId}/approve-payout — KAURO_OWNER with a fresh step-up — scope
 * CORPORATE — no provider effect (design §7, §10, §12; decisions D10-PAY-1, D10-STMT-4; registry "create a reviewable authorized payout
 * intent for eligible value"; 15 "Commission integration"; policy minimumPayoutCents 0, feeBearer KAURO; example 22).
 *
 * One unit of work of the owner's OPERATOR context, in B06's pipeline order: access (the caller's own ACTIVE KAURO_OWNER grant) → journal
 * reserve (or the replay) → the body, the first failure answering: the owner's step-up fresh (ASSURANCE_REQUIRED; its ALLOW fact commits
 * with the intent) → the statement FOR UPDATE (NOT_FOUND) → expectedVersion (STALE_VERSION: two approvals of one statement serialize on its
 * row, the second finding the first's version) → ISSUED (UNLISTED_TRANSITION) → payeeRef the seller's current destination version and
 * VERIFIED (PAYEE_UNVERIFIED: a change pending verification, a superseded or another seller's destination; the database repeats it, KC009)
 * → a payable above zero, the only floor (NOTHING_PAYABLE) → bank-available cash of the latest settlement with bank evidence covering the
 * payable and every unsettled authorized intent (FUNDS_UNAVAILABLE). Writes one AUTHORIZED payout intent of exactly the payable — fee
 * bearer KAURO, nothing deducted —, bound to the destination's version and digest, under the stable reference kauro-payout-<intentId>, and
 * the statement APPROVED. No transfer: the payout adapter is B15's. The view carries no destination and no digest (D10-API-1).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AssuranceProofId, CausationId, CommissionStatementId, PayoutDestinationId, PayoutIntentId, PayoutIntentRecord, SellerId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import { applied, checkExpectedVersion } from "../agency/shared.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { APPROVE_COMMISSION_PAYOUT, type ApproveCommissionPayoutBody } from "../contracts.js";
import type { PayoutIntentView } from "../views.js";
import type { StatementRequestCollaborators } from "./runtime.js";

/** The payout intent's view: the statement's own amount under one reference; never the destination or its digest (D10-PAY-1). */
export function payoutIntentView(intent: PayoutIntentRecord, statementState: PayoutIntentView["statementState"]): PayoutIntentView {
  return {
    intentId: intent.intentId,
    statementId: intent.statementId,
    state: intent.state,
    amountCents: intent.amountCents.toString() as PayoutIntentView["amountCents"],
    currency: "USD",
    feeBearer: "KAURO",
    reference: intent.reference,
    destinationVersion: intent.destinationVersion,
    authorizedAt: intent.authorizedAt,
    version: intent.version,
    statementState,
  };
}

export function approveCommissionPayoutHandler(runtime: CommerceRequestRuntime, co: StatementRequestCollaborators): CommercialCommandHandler<ApproveCommissionPayoutBody, PayoutIntentView> {
  const spec = APPROVE_COMMISSION_PAYOUT;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<ApproveCommissionPayoutBody>): Promise<CommandResult<PayoutIntentView>> {
      const context = operatorContextOf(envelope);
      const statementId = envelope.path["statementId"] as CommissionStatementId;
      return runCommerceCommand<ApproveCommissionPayoutBody, PayoutIntentView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD052", decision);
        },
        async body(uow, _causationId: CausationId, now: UtcInstant) {
          const body = envelope.body;
          const assured = await co.assurance.verifyStepUp(uow, envelope.userId, body.authorizationRef as AssuranceProofId, now);
          if (assured.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `approving a payout needs a fresh step-up: ${assured.reason}`, { reason: assured.reason });
          const statements = co.statements(uow);
          const statement = await statements.lockStatement(statementId);
          if (statement === null) throw new NotFoundFailure("commission_statement");
          checkExpectedVersion(statement, body.expectedVersion);
          if (statement.state !== "ISSUED") {
            throw new DomainFailure("PRECONDITION_FAILED", "the statement is not ISSUED: it is approved, paid, disputed or corrected", { reason: "UNLISTED_TRANSITION", currentVersion: statement.version, currentState: statement.state });
          }
          // the payee: the seller's current destination version, VERIFIED (a change pending verification binds no payout; example 22)
          const sales = co.sales(uow);
          const named = await sales.getDestination(body.payeeRef as PayoutDestinationId);
          const current = await sales.currentDestination(statement.sellerId as SellerId);
          if (named === null || current === null || named.sellerId !== statement.sellerId || named.destinationId !== current.destinationId || current.state !== "VERIFIED") {
            throw new DomainFailure("PRECONDITION_FAILED", "payeeRef is not the seller's current VERIFIED payout destination", { reason: "PAYEE_UNVERIFIED" });
          }
          // the only floor is zero (minimumPayoutCents 0): a one-cent payable is paid in full, no fee deducted
          if (statement.payableCents <= 0n) throw new DomainFailure("PRECONDITION_FAILED", "the statement has nothing payable", { reason: "NOTHING_PAYABLE" });
          const cash = await statements.payoutCash();
          if (cash.bankAvailableCents < cash.unsettledAuthorizedCents + statement.payableCents) {
            throw new DomainFailure("PRECONDITION_FAILED", "bank-available cash with bank evidence does not cover the payable and the unsettled intents", { reason: "FUNDS_UNAVAILABLE" });
          }
          // the lines behind the payable (B10G-R2, migration 0036): each payable line PAYABLE with no OPEN hold the statement does not
          // withhold, read after its shared half (a hold or a line change in flight is waited for); held cents are never authorized
          if ((await statements.unpayableLine(statementId)) !== null) {
            throw new DomainFailure("STALE_VERSION", "a payable line of the statement is held or no longer payable: the held cents are not authorized", { reason: "LEDGER_CHANGED", currentVersion: statement.version, currentState: statement.state });
          }
          const intentId = uow.ids.next() as PayoutIntentId;
          const authorized = await statements.authorizeIntent({
            intent: {
              intentId,
              statementId,
              sellerId: statement.sellerId,
              amountCents: statement.payableCents,
              currency: "USD",
              feeBearer: "KAURO",
              destinationId: current.destinationId,
              destinationVersion: current.destinationVersion,
              destinationDigest: current.destinationDigest,
              reference: `kauro-payout-${intentId}`,
              authorizedBy: envelope.userId,
              authorizationProofId: assured.proofId,
              authorizedAt: now,
            },
          });
          if (!authorized.authorized) throw new DomainFailure("INTEGRITY_FAILURE", "a live intent of an ISSUED statement exists under the statement's lock");
          const approved = applied(await statements.transitionStatement(statementId, statement.version, { state: "APPROVED" }, now));
          return {
            status: 200,
            view: payoutIntentView(authorized.record, approved.state),
            version: authorized.record.version,
            resourceKind: "payout_intent",
            resourceId: authorized.record.intentId,
            allowFact: { reasonCode: ALLOW_REASONS.STEP_UP_FRESH, assuranceClass: "STEP_UP", policyVersion: AUTHORIZATION_POLICY_VERSION },
          };
        },
      });
    },
  };
}
