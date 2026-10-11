// UI22 Approval as data (registry: "Approve these exact preparation decisions."; R2-062, R2-064; CMD025). Approval binds three hashes the
// plan read supplies (plan, validation receipt, disclosures) and a fresh step-up proof; this module never computes a hash and never builds
// an effect: it refuses to offer approval for anything the plan read did not disclose in full.
//   - A plan that is not VALIDATED, a validation receipt that is missing, or NO disclosed effect (a hidden effect cannot be listed) blocks
//     approval: the person is sent back to review.
//   - Enter can never approve (the dialog has no form and no default action, packages/ui ConfirmDialog); every effect has its own
//     acknowledgement, so no undisclosed default can be approved.
// GAP (stage 2): the api serves no plan read (no GetPlan, no disclosures), so no route supplies `ApprovalFacts` yet; the screen is built
// and tested against the facts' shape and is routed when the B08 plan read lands.
import type { ApprovePlanView, PlanView } from "../../api/generated.ts";
import type { ApiClient } from "../../client/api-client.ts";
import type { OperationRunner, RunOutcome } from "../../client/operation-runner.ts";

export interface DisclosedEffect {
  /** Stable id (letters, digits and _ . : - only): the server's errors name it. */
  readonly id: string;
  /** What will happen, in a sentence the plan read wrote. A customer string: drawn as text. */
  readonly description: string;
  /** Rows touched, as a canonical decimal string. */
  readonly count: string;
  readonly kind: "CLEAR" | "MERGE" | "EXCLUDE" | "OTHER";
}

export interface ApprovalFacts {
  readonly planId: string;
  readonly planVersion: number;
  readonly planState: PlanView["state"];
  readonly planHash: string;
  readonly validationReceiptHash: string | null;
  readonly disclosuresHash: string;
  readonly effects: readonly DisclosedEffect[];
}

export type ApprovalGate =
  | { readonly kind: "READY" }
  | { readonly kind: "NOT_VALIDATED" }
  | { readonly kind: "ALREADY_APPROVED" }
  | { readonly kind: "HIDDEN_EFFECT" };

/** What stands between the person and the approval dialog. A hidden effect (nothing disclosed) is decided last: it blocks even a validated plan. */
export function approvalGate(facts: ApprovalFacts): ApprovalGate {
  if (facts.planState === "APPROVED") return { kind: "ALREADY_APPROVED" };
  if (facts.planState !== "VALIDATED" || facts.validationReceiptHash === null) return { kind: "NOT_VALIDATED" };
  if (facts.effects.length === 0) return { kind: "HIDDEN_EFFECT" };
  return { kind: "READY" };
}

/** CMD025 through the runner: one plan version is one key; the step-up proof is the one the person just obtained, never stored. */
export function approvePlan(client: ApiClient, runner: OperationRunner, facts: ApprovalFacts, assuranceProofRef: string): Promise<RunOutcome<ApprovePlanView>> {
  const gate = approvalGate(facts);
  if (gate.kind !== "READY" || facts.validationReceiptHash === null) return Promise.reject(new RangeError(`approval is blocked: ${gate.kind}`));
  const receipt = facts.validationReceiptHash;
  return runner.run<ApprovePlanView>({
    command: "CMD025",
    subject: { kind: "SUBJECT", subjectId: facts.planId, subjectVersion: facts.planVersion },
    send: (key) =>
      client.call("ApprovePlan", {
        path: { planId: facts.planId },
        body: { expectedVersion: facts.planVersion, planHash: facts.planHash, validationReceiptHash: receipt, disclosuresHash: facts.disclosuresHash, assuranceProofRef },
        idempotencyKey: key,
      }),
  });
}
