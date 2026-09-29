/**
 * Digests of audit authority (package B08, mandate B08-PERSISTENCE-AUDIT; reference/HASHING_AND_ACCOUNTING_RULES "Hash domain
 * separation": every structured digest is SHA-256 over the canonical {domain, version, payload} wrapper). KAURO_DECISION_ARTIFACT_V1
 * is the content identity of a stored decision document (the content-idempotent intake of D8-PLAN-1), and
 * KAURO_MODEL_TASK_JOURNAL_EVENT_V1 the digest of one event of the core's journal (D8-AUD-3); both are platform domains in the wrapper
 * shape of B07's source digests and B08's execution digests.
 */
import type { Sha256Hex } from "@kauro/contracts";
import { canonicalBytes, rawDigest } from "@kauro/contracts";
import type { DecisionArtifactKind } from "./records.js";

export const AUDIT_DIGEST_DOMAINS = Object.freeze({
  DECISION_ARTIFACT: "KAURO_DECISION_ARTIFACT_V1",
  MODEL_TASK_JOURNAL_EVENT: "KAURO_MODEL_TASK_JOURNAL_EVENT_V1",
} as const);

/** The content identity of a decision document of a kind: the same document of the same kind is the same artifact. */
export function decisionArtifactHashOf(kind: DecisionArtifactKind, document: Readonly<Record<string, unknown>>): Sha256Hex {
  return rawDigest(canonicalBytes({ domain: AUDIT_DIGEST_DOMAINS.DECISION_ARTIFACT, version: 1, payload: { kind, document } }));
}

/** The digest of one journal event (opaque to the platform, canonical JSON all the same). */
export function modelTaskJournalEventHashOf(event: Readonly<Record<string, unknown>>): Sha256Hex {
  return rawDigest(canonicalBytes({ domain: AUDIT_DIGEST_DOMAINS.MODEL_TASK_JOURNAL_EVENT, version: 1, payload: event }));
}
