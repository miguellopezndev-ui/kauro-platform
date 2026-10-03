/**
 * CMD053 ReconcileCommissionPayout — POST /api/v1/sales/statements/{statementId}/reconcile-payout — FINANCE_SERVICE — scope
 * STORED_OPERATION — no provider effect of its own (design §7, §10, §12; decisions D10-PAY-2, D10-STMT-4; registry "mark actual paid
 * value and preserve any failed/returned transfer for recovery"; "Submitting a transfer is not proof the seller received it"; example 22).
 *
 * After the finance service's access decision, the stored evidence is verified through PayoutEvidenceVerifier outside any transaction
 * (it reaches the bank or payout provider): none verified is PAYOUT_EVIDENCE_UNAVAILABLE. Then one SERVICE unit of work of the commission
 * group with no agency, after the journal reservation:
 *  1. the statement FOR UPDATE (NOT_FOUND) — two reconciliations of its intent serialize on it (design §10: statement, payout intent, line);
 *  2. the intent the evidence names by its reference: an intent of another statement is a foreign scope (NOT_FOUND); the evidence must
 *     match the statement's intent — reference, destination digest, amount and currency — or nothing changes (PAYOUT_EVIDENCE_MISMATCH;
 *     an evidence of the new destination for an intent bound to the old one included, R2-103);
 *  3. SUBMITTED evidence is not settlement (PAYOUT_NOT_SETTLED), nothing changes;
 *  4. SETTLED: the evidence recorded once, the intent SETTLED with it, the statement PAID with its hash and each PAYABLE item's line PAID
 *     at that item's cents (settled_payout_evidence); evidence already applied to a SETTLED intent changes nothing and answers its state;
 *     FAILED or RETURNED: the evidence recorded, the intent kept FAILED or RETURNED, the statement APPROVED → ISSUED, and each PAYABLE line
 *     HELD PAYOUT_FAILED under a hold of its unpaid cents reviewed 168 hours later (payout_blocked) — the earned amount is preserved.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CommerceUnitOfWork, CommissionLineId, CommissionStatementId, PayoutEvidenceFacts, PayoutIntentId, PayoutIntentRecord, PayoutReconciliationId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, addHours } from "@kauro/domain";
import type { CommandResult } from "../../api/envelope.js";
import { applied } from "../agency/shared.js";
import type { ReconcileCommissionPayoutBody } from "../contracts.js";
import type { PayoutReconciliationView } from "../views.js";
import { calendarDateIn } from "./close-period.js";
import type { StatementServiceRuntime } from "./runtime.js";
import { runServiceCommand, type ServiceCommandRequest } from "./service.js";

/** How long a failed or returned payout waits for its review: one week, as the commission service's own holds (D10-SVC-3). */
export const PAYOUT_FAILED_REVIEW_HOURS = 168;

const REFERENCE = /^kauro-payout-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function mismatch(): DomainFailure {
  return new DomainFailure("PRECONDITION_FAILED", "the evidence does not name this statement's payout: reference, destination, amount or currency differ", { reason: "PAYOUT_EVIDENCE_MISMATCH" });
}

function matches(intent: PayoutIntentRecord, evidence: PayoutEvidenceFacts): boolean {
  return evidence.reference === intent.reference && evidence.destinationDigest === intent.destinationDigest && evidence.amountCents === intent.amountCents && evidence.currency === intent.currency;
}

/** The intents of a statement, newest first: its live one, or its failed and returned ones. */
async function statementIntent(rt: StatementServiceRuntime, uow: CommerceUnitOfWork, statementId: CommissionStatementId, evidence: PayoutEvidenceFacts): Promise<PayoutIntentRecord> {
  const statements = rt.statements(uow);
  const ref = REFERENCE.exec(evidence.reference);
  if (ref !== null) {
    const named = await statements.getIntent(ref[1] as PayoutIntentId);
    // an intent of another statement is out of this command's scope: it answers as an id nobody holds
    if (named !== null && named.statementId !== statementId) throw new NotFoundFailure("payout_intent");
    if (named !== null) return named;
  }
  const live = await statements.liveIntentOf(statementId);
  if (live === null) throw mismatch();
  return live;
}

export function reconcileCommissionPayout(rt: StatementServiceRuntime, request: ServiceCommandRequest<ReconcileCommissionPayoutBody>): Promise<CommandResult<PayoutReconciliationView>> {
  const statementId = request.path["statementId"] as CommissionStatementId;
  let evidence: PayoutEvidenceFacts | null = null;
  return runServiceCommand<ReconcileCommissionPayoutBody, PayoutReconciliationView>(rt, {
    command: "CMD053",
    role: "FINANCE_SERVICE",
    request,
    versionOf: (view) => view.version,
    async before() {
      const answer = await rt.payoutEvidence.verify({ evidenceRef: request.body.providerPayoutEvidenceRef });
      if (answer.kind !== "VERIFIED") throw new DomainFailure("PRECONDITION_FAILED", "no authenticated payout evidence under this reference", { reason: "PAYOUT_EVIDENCE_UNAVAILABLE" });
      evidence = answer.evidence;
    },
    async body(uow, now: UtcInstant) {
      const facts = evidence;
      if (facts === null) throw new DomainFailure("INTEGRITY_FAILURE", "the evidence was not verified before the unit of work");
      const statements = rt.statements(uow);
      const ledger = rt.ledger(uow);
      const statement = await statements.lockStatement(statementId);
      if (statement === null) throw new NotFoundFailure("commission_statement");
      const intent = await statementIntent(rt, uow, statementId, facts);
      if (!matches(intent, facts)) throw mismatch();
      if (facts.status === "SUBMITTED") throw new DomainFailure("PRECONDITION_FAILED", "a submitted transfer is not proof the seller received it", { reason: "PAYOUT_NOT_SETTLED", currentVersion: intent.version, currentState: intent.state });
      const items = (await statements.itemsOf(statementId)).filter((i) => i.kind === "LINE" && i.disposition === "PAYABLE" && i.lineId !== undefined);
      const view = (written: PayoutIntentRecord, statementState: PayoutReconciliationView["statementState"], payoutEvidenceHash: string | undefined, counts: { readonly paid: number; readonly held: number }, reviewOn?: string): PayoutReconciliationView => ({
        intentId: written.intentId,
        statementId,
        intentState: written.state,
        statementState,
        ...(payoutEvidenceHash !== undefined ? { payoutEvidenceHash: payoutEvidenceHash as PayoutReconciliationView["payoutEvidenceHash"] & string } : {}),
        ...(written.state === "SETTLED" ? { settledAt: facts.observedAt } : {}),
        linesPaid: counts.paid,
        linesHeld: counts.held,
        ...(reviewOn !== undefined ? { reviewOn } : {}),
        version: written.version,
      });
      // the same settlement applied again (a concurrent reconciliation of this evidence): nothing changes, its state answers
      if (intent.state === facts.status && intent.evidenceHash === facts.evidenceHash) {
        const paid = facts.status === "SETTLED" ? items.length : 0;
        return { view: view(intent, statement.state, statement.payoutEvidenceHash, { paid, held: facts.status === "SETTLED" ? 0 : items.length }), version: intent.version, resourceKind: "payout_intent", resourceId: intent.intentId };
      }
      if (intent.state !== "AUTHORIZED" && intent.state !== "SUBMITTED" && intent.state !== "UNCERTAIN") {
        throw new DomainFailure("PRECONDITION_FAILED", `the payout intent is already ${intent.state}`, { reason: "UNLISTED_TRANSITION", currentVersion: intent.version, currentState: intent.state });
      }
      await statements.recordReconciliation({ reconciliationId: uow.ids.next() as PayoutReconciliationId, intentId: intent.intentId, evidence: facts, reconciledAt: now });
      const moved = applied(await statements.transitionIntent(intent.intentId, intent.version, facts.status, now));
      if (facts.status === "SETTLED") {
        const paid = applied(await statements.transitionStatement(statementId, statement.version, { state: "PAID", payoutEvidenceHash: facts.evidenceHash }, now));
        for (const item of items) {
          const line = await ledger.lockLine(item.lineId as CommissionLineId);
          if (line === null || line.state !== "PAYABLE") throw new DomainFailure("INTEGRITY_FAILURE", "a payable item's line is not PAYABLE under its statement's lock");
          applied(await ledger.transitionLine(line.lineId, line.version, { state: "PAID" }, now));
        }
        return { view: view(moved, paid.state, facts.evidenceHash, { paid: items.length, held: 0 }), version: moved.version, resourceKind: "payout_intent", resourceId: moved.intentId };
      }
      // FAILED or RETURNED: the intent is kept, the statement payable again, its lines held for review (payout_blocked)
      const reissued = applied(await statements.transitionStatement(statementId, statement.version, { state: "ISSUED" }, now));
      const reviewAt = addHours(now, PAYOUT_FAILED_REVIEW_HOURS);
      for (const item of items) {
        const line = await ledger.lockLine(item.lineId as CommissionLineId);
        if (line === null || line.state !== "PAYABLE") throw new DomainFailure("INTEGRITY_FAILURE", "a payable item's line is not PAYABLE under its statement's lock");
        applied(await ledger.transitionLine(line.lineId, line.version, { state: "HELD", heldReason: "PAYOUT_FAILED", reviewAt }, now));
      }
      return {
        view: view(moved, reissued.state, undefined, { paid: 0, held: items.length }, calendarDateIn(reviewAt, rt.policy.operationalTimeZone)),
        version: moved.version,
        resourceKind: "payout_intent",
        resourceId: moved.intentId,
      };
    },
  });
}
