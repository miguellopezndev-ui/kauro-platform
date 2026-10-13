/**
 * Digests of audit authority (package B08, mandate B08-PERSISTENCE-AUDIT; reference/HASHING_AND_ACCOUNTING_RULES "Hash domain
 * separation": every structured digest is SHA-256 over the canonical {domain, version, payload} wrapper). KAURO_DECISION_ARTIFACT_V1
 * is the content identity of a stored decision document (the content-idempotent intake of D8-PLAN-1), KAURO_MODEL_TASK_JOURNAL_EVENT_V1
 * the digest of one event of the core's journal (D8-AUD-3), and KAURO_MODEL_TASK_CHECKPOINT_V1 the checkpoint identity of a model
 * task's MODEL_TASK lease (D8-LAND-2); all are platform domains in the wrapper shape of B07's source digests and B08's execution
 * digests.
 */
import type { Sha256Hex } from "@kauro/contracts";
import { canonicalBytes, rawDigest } from "@kauro/contracts";
import type { DecisionArtifactKind } from "./records.js";

export const AUDIT_DIGEST_DOMAINS = Object.freeze({
  DECISION_ARTIFACT: "KAURO_DECISION_ARTIFACT_V1",
  MODEL_TASK_JOURNAL_EVENT: "KAURO_MODEL_TASK_JOURNAL_EVENT_V1",
  MODEL_TASK_CHECKPOINT: "KAURO_MODEL_TASK_CHECKPOINT_V1",
  DISPATCH_SETTLEMENT: "KAURO_DISPATCH_SETTLEMENT_V1",
} as const);

/**
 * The identity of one settlement of a core reservation (package B05 D5-11): the same (run, reservation, state, charge, usage flag) is
 * the same settlement (a replay); anything else on a final settlement is a conflict. Micros are decimal strings in the canonical form.
 */
export function dispatchSettlementHashOf(s: { readonly runId: string; readonly reservationId: string; readonly state: string; readonly chargeMicros: bigint; readonly usageKnown: boolean }): Sha256Hex {
  return rawDigest(
    canonicalBytes({
      domain: AUDIT_DIGEST_DOMAINS.DISPATCH_SETTLEMENT,
      version: 1,
      payload: { runId: s.runId, reservationId: s.reservationId, state: s.state, chargeMicros: s.chargeMicros.toString(), usageKnown: s.usageKnown },
    }),
  );
}

/** The content identity of a decision document of a kind: the same document of the same kind is the same artifact. */
export function decisionArtifactHashOf(kind: DecisionArtifactKind, document: Readonly<Record<string, unknown>>): Sha256Hex {
  return rawDigest(canonicalBytes({ domain: AUDIT_DIGEST_DOMAINS.DECISION_ARTIFACT, version: 1, payload: { kind, document } }));
}

/** The digest of one journal event (opaque to the platform, canonical JSON all the same). */
export function modelTaskJournalEventHashOf(event: Readonly<Record<string, unknown>>): Sha256Hex {
  return rawDigest(canonicalBytes({ domain: AUDIT_DIGEST_DOMAINS.MODEL_TASK_JOURNAL_EVENT, version: 1, payload: event }));
}

/** What a model task's MODEL_TASK checkpoint is taken over: the planned task, its audit, its grant and its planned request. */
export interface PlannedModelTask {
  readonly modelTaskId: string;
  readonly agencyId: string;
  readonly auditId: string;
  readonly grantId: string;
  readonly taskKey: Sha256Hex;
  readonly candidateManifestHash: Sha256Hex;
  readonly policyHash: Sha256Hex;
  readonly minimizedRequestHash: Sha256Hex;
  readonly providerProfileId: string;
  readonly maximumCostCents: bigint;
}

/**
 * The checkpoint identity of a model task's MODEL_TASK lease (B06 review finding B06-R1, decision D-LEASE-3; D8-LAND-2): the durable
 * point a dispatch owner resumes the task from — the task as its INTERPRET step planned it (its candidate set, policy, minimized
 * request, provider profile and worst-case cost, the cents as their exact decimal) under the audit's grant; a response already stored
 * for the task is compiled before any new dispatch (D8-AUD-3), and nothing of an owner's in-flight call is resumed. The first claim
 * stores it with the lease and every later claim names it again, recomputed from the task.
 */
export function modelTaskCheckpointOf(task: PlannedModelTask): Sha256Hex {
  const payload = {
    modelTaskId: task.modelTaskId,
    agencyId: task.agencyId,
    auditId: task.auditId,
    grantId: task.grantId,
    taskKey: task.taskKey,
    candidateManifestHash: task.candidateManifestHash,
    policyHash: task.policyHash,
    minimizedRequestHash: task.minimizedRequestHash,
    providerProfileId: task.providerProfileId,
    maximumCostCents: task.maximumCostCents.toString(),
    resumesFrom: "PLANNED_REQUEST",
  };
  return rawDigest(canonicalBytes({ domain: AUDIT_DIGEST_DOMAINS.MODEL_TASK_CHECKPOINT, version: 1, payload }));
}
