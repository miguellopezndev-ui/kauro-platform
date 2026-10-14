/**
 * The SQL writers of package B12's outreach (docs/design/B12-outreach-plan.md §L, §M; migration 0072, provisional 0082; lane K1).
 * Every statement that writes an outreach row lives here, and each writer REQUIRES the advisory subjects the 0072 T2 triggers assert
 * for its edge (KA096 LOCK_NOT_HELD) to be held already on the unit's OutreachLocks, in the global order: the caller (a lane's handler)
 * takes its whole serializer set, judges, and only then calls the writer, whose first statement is the write (plan §L "the first write
 * follows the judgment with no other await"). A writer whose subjects are missing is refused before any SQL (INTEGRITY_FAILURE), so a
 * handler that forgets a lock fails in every test that runs it, and the database's T2 refuses it again if this check is bypassed.
 *
 * The T2 table this mirrors (plan §L): intent INSERT L3 X, L4 X, L4g S, L10 X; QUEUED->SUBMITTING L3 S, L4 X (first contact) or S,
 * L4g S, L10 X; QUEUED->NOT_SENT/CANCELLED L3 S, L4 S|X, L4g S, L10 X; SUBMITTING->* and SEND_UNCERTAIN->PROVIDER_ACCEPTED L3 S, L4 S|X,
 * L4g S, L10 X; SEND_UNCERTAIN->OBSERVED_SENT L3 S, L10 X; SEND_UNCERTAIN->OBSERVED_NOT_SENT L3 S, L4 S, L4g S, L10 X; activity INSERT
 * PROVIDER_ACCEPTED/SEND_UNCERTAIN/HUMAN L10 X, REPLIED L3 X + L10 X, BOUNCED L3 X + L4 X + L10 X, SUPPRESSED L8 X (+ L4 X if COMPLAINT);
 * suppression INSERT L8 X; draft edges L10 X.
 *
 * A17: the outreach service never writes an agency-scoped table and never UPDATEs a prospect; D-33: nothing here reads a segment or a
 * buyer type, and nothing ranks.
 */
import { DomainFailure, type OutreachLock, type OutreachPurpose, type SenderRoute } from "@kauro/domain";
import type { OutreachLockMode, OutreachLocks } from "../outreach-access.js";
import { execute, type Queryable } from "../sql.js";

type Need = readonly [OutreachLock, string, OutreachLockMode];

/** Refuses a write whose subjects are not all held (an S need is met by S or X; an X need only by X). */
function requireHeld(locks: OutreachLocks, what: string, needs: ReadonlyArray<Need>): void {
  for (const [lock, subject, mode] of needs) {
    const held = locks.taken.some((t) => t.lock === lock && t.subject === subject && (mode === "S" || t.mode === "X"));
    if (!held) throw new DomainFailure("INTEGRITY_FAILURE", `${what} needs ${lock} ${mode} of ${subject} held before it writes (plan §L T2)`);
  }
}

/** The facts of an intent its writers key their subjects on. */
export interface OutreachIntentKeys {
  readonly intentId: string;
  readonly draftId: string;
  readonly authorizationId: string;
  readonly prospectId: string;
  readonly personUserId: string;
  readonly purpose: OutreachPurpose;
}

export interface NewOutreachIntent extends OutreachIntentKeys {
  readonly senderId: string;
  readonly route: SenderRoute;
  readonly contactKey: string;
  readonly payloadHash: string;
  readonly sequenceFirstIntentId: string | null;
  readonly replyActivityId: string | null;
}

export type IntentAnswer =
  | { readonly state: "PROVIDER_ACCEPTED"; readonly providerMessageRef: string }
  | { readonly state: "SEND_UNCERTAIN" }
  | { readonly state: "NOT_SENT"; readonly outcomeReason: string; readonly draftState: "CANCELLED" | "DRAFT" };

const capMode = (purpose: OutreachPurpose): OutreachLockMode => (purpose === "INDIVIDUAL_PROSPECT_CONTACT" ? "X" : "S");

export class PgOutreachWriters {
  constructor(private readonly db: Queryable) {}

  /** CMD063: the intent (L3 X, L4 X, L4g S, L10 X), then its draft DRAFT -> AUTHORIZED. */
  async queueIntent(locks: OutreachLocks, i: NewOutreachIntent): Promise<void> {
    requireHeld(locks, "CMD063 queue", [["L3", i.prospectId, "X"], ["L4", i.personUserId, "X"], ["L4g", i.authorizationId, "S"], ["L10", i.draftId, "X"]]);
    await execute(
      this.db,
      `INSERT INTO kauro.outreach_send_intents (intent_id, draft_id, authorization_id, sender_id, person_user_id, prospect_id, purpose, route, contact_key, payload_hash, sequence_first_intent_id, reply_activity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [i.intentId, i.draftId, i.authorizationId, i.senderId, i.personUserId, i.prospectId, i.purpose, i.route, i.contactKey, i.payloadHash, i.sequenceFirstIntentId, i.replyActivityId],
    );
    await this.moveDraft(locks, i.draftId, "AUTHORIZED");
  }

  /** D2: QUEUED -> SUBMITTING under the claim fence (L3 S, L4 X first contact else S, L4g S, L10 X), and the draft. Returns false when the row was not QUEUED. */
  async claimIntent(locks: OutreachLocks, i: OutreachIntentKeys, fence: number): Promise<boolean> {
    requireHeld(locks, "D2 claim", [["L3", i.prospectId, "S"], ["L4", i.personUserId, capMode(i.purpose)], ["L4g", i.authorizationId, "S"], ["L10", i.draftId, "X"]]);
    const r = await execute(this.db, "UPDATE kauro.outreach_send_intents SET state = 'SUBMITTING', claim_fence = $2 WHERE intent_id = $1 AND state = 'QUEUED'", [i.intentId, fence]);
    if (r.rowCount !== 1) return false;
    await this.moveDraft(locks, i.draftId, "SUBMITTING");
    return true;
  }

  /** D2 refusals: QUEUED -> NOT_SENT | CANCELLED (L3 S, L4 S|X, L4g S, L10 X), and the draft to the state its lane decides (CANCELLED, DRAFT, SUPPRESSED). */
  async refuseQueued(locks: OutreachLocks, i: OutreachIntentKeys, state: "NOT_SENT" | "CANCELLED", outcomeReason: string, draftState: "CANCELLED" | "DRAFT" | "SUPPRESSED"): Promise<boolean> {
    requireHeld(locks, "D2 refusal", [["L3", i.prospectId, "S"], ["L4", i.personUserId, "S"], ["L4g", i.authorizationId, "S"], ["L10", i.draftId, "X"]]);
    const r = await execute(this.db, "UPDATE kauro.outreach_send_intents SET state = $2, outcome_reason = $3 WHERE intent_id = $1 AND state = 'QUEUED'", [i.intentId, state, outcomeReason]);
    if (r.rowCount !== 1) return false;
    await this.moveDraft(locks, i.draftId, draftState);
    return true;
  }

  /**
   * D4 / D5: the answer of the submission of `fence` (SUBMITTING -> PROVIDER_ACCEPTED | SEND_UNCERTAIN | NOT_SENT; L3 S, L4 S|X, L4g S,
   * L10 X), only while the row is still SUBMITTING under that fence. The draft follows (NOT_SENT: to the state its lane decides).
   */
  async answerIntent(locks: OutreachLocks, i: OutreachIntentKeys, fence: number, answer: IntentAnswer): Promise<boolean> {
    requireHeld(locks, "D4/D5 answer", [["L3", i.prospectId, "S"], ["L4", i.personUserId, "S"], ["L4g", i.authorizationId, "S"], ["L10", i.draftId, "X"]]);
    const ref = answer.state === "PROVIDER_ACCEPTED" ? answer.providerMessageRef : null;
    const reason = answer.state === "NOT_SENT" ? answer.outcomeReason : null;
    const r = await execute(
      this.db,
      `UPDATE kauro.outreach_send_intents SET state = $3, provider_message_ref = COALESCE($4, provider_message_ref), outcome_reason = COALESCE($5, outcome_reason),
              answered_fence = CASE WHEN $3 = 'SEND_UNCERTAIN' THEN answered_fence ELSE claim_fence END
        WHERE intent_id = $1 AND state = 'SUBMITTING' AND claim_fence = $2`,
      [i.intentId, fence, answer.state, ref, reason],
    );
    if (r.rowCount !== 1) return false;
    await this.moveDraft(locks, i.draftId, answer.state === "NOT_SENT" ? answer.draftState : answer.state);
    return true;
  }

  /** D5 late evidence: SEND_UNCERTAIN -> PROVIDER_ACCEPTED with the provider's reference (same subjects as an answer). */
  async acceptUncertain(locks: OutreachLocks, i: OutreachIntentKeys, providerMessageRef: string): Promise<boolean> {
    requireHeld(locks, "D5 late acceptance", [["L3", i.prospectId, "S"], ["L4", i.personUserId, "S"], ["L4g", i.authorizationId, "S"], ["L10", i.draftId, "X"]]);
    const r = await execute(this.db, "UPDATE kauro.outreach_send_intents SET state = 'PROVIDER_ACCEPTED', provider_message_ref = $2, answered_fence = claim_fence WHERE intent_id = $1 AND state = 'SEND_UNCERTAIN'", [i.intentId, providerMessageRef]);
    if (r.rowCount !== 1) return false;
    await this.moveDraft(locks, i.draftId, "PROVIDER_ACCEPTED");
    return true;
  }

  /** HUMAN_SEND_OBSERVED: SEND_UNCERTAIN -> OBSERVED_SENT (L3 S, L10 X) or OBSERVED_NOT_SENT (L3 S, L4 S, L4g S, L10 X). */
  async observeUncertain(locks: OutreachLocks, i: OutreachIntentKeys, observation: "SENT" | "NOT_SENT"): Promise<boolean> {
    const needs: Need[] = [["L3", i.prospectId, "S"], ["L10", i.draftId, "X"]];
    if (observation === "NOT_SENT") needs.splice(1, 0, ["L4", i.personUserId, "S"], ["L4g", i.authorizationId, "S"]);
    requireHeld(locks, "HUMAN_SEND_OBSERVED", needs);
    const r = await execute(this.db, "UPDATE kauro.outreach_send_intents SET state = $2 WHERE intent_id = $1 AND state = 'SEND_UNCERTAIN'", [i.intentId, observation === "SENT" ? "OBSERVED_SENT" : "OBSERVED_NOT_SENT"]);
    return r.rowCount === 1;
  }

  /** A draft edge (L10 X); the 0072 T1 whitelist refuses an edge outside the machine. */
  async moveDraft(locks: OutreachLocks, draftId: string, state: string): Promise<void> {
    requireHeld(locks, "draft edge", [["L10", draftId, "X"]]);
    await execute(this.db, "UPDATE kauro.outreach_drafts SET state = $2 WHERE draft_id = $1 AND state IS DISTINCT FROM $2", [draftId, state]);
  }

  /** The service's activity of an intent (PROVIDER_ACCEPTED, SEND_UNCERTAIN; L10 X). */
  async recordServiceActivity(locks: OutreachLocks, a: { readonly activityId: string; readonly intent: OutreachIntentKeys; readonly kind: "PROVIDER_ACCEPTED" | "SEND_UNCERTAIN"; readonly providerMessageRef: string; readonly evidenceHash: string; readonly occurredAt: string }): Promise<void> {
    requireHeld(locks, `${a.kind} activity`, [["L10", a.intent.draftId, "X"]]);
    await execute(
      this.db,
      "INSERT INTO kauro.sales_activities (activity_id, prospect_id, intent_id, draft_id, authorization_id, kind, provider_message_ref, evidence_hash, occurred_at, recorded_by_service) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'outreach-service')",
      [a.activityId, a.intent.prospectId, a.intent.intentId, a.intent.draftId, a.intent.authorizationId, a.kind, a.providerMessageRef, a.evidenceHash, a.occurredAt],
    );
  }

  /** A person's activity (CMD064 kinds and HUMAN_SEND_OBSERVED) under the subjects of its kind. */
  async recordPersonActivity(
    locks: OutreachLocks,
    a: {
      readonly activityId: string;
      readonly recordedByUserId: string;
      readonly prospectId: string;
      readonly intent: OutreachIntentKeys | null;
      readonly kind: "BOUNCED" | "REPLIED" | "SUPPRESSED" | "HUMAN_SEND_OBSERVED";
      readonly observation?: "SENT" | "NOT_SENT";
      readonly suppression?: { readonly keyKind: "ORGANIZATION" | "CONTACT"; readonly key: string; readonly reason: string };
      readonly providerMessageRef?: string;
      readonly evidenceHash: string;
      readonly occurredAt: string;
    },
  ): Promise<void> {
    const needs: Need[] = [];
    if (a.kind === "REPLIED" || a.kind === "BOUNCED") needs.push(["L3", a.prospectId, "X"]);
    if (a.kind === "BOUNCED" && a.intent !== null) needs.push(["L4", a.intent.personUserId, "X"]);
    if (a.kind === "SUPPRESSED") {
      if (a.suppression === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a SUPPRESSED activity names its suppression key");
      if (a.suppression.reason === "COMPLAINT" && a.intent !== null) needs.push(["L4", a.intent.personUserId, "X"]);
      needs.push(["L8", `${a.suppression.keyKind}:${a.suppression.key}`, "X"]);
    }
    if (a.intent !== null) needs.push(["L10", a.intent.draftId, "X"]);
    requireHeld(locks, `${a.kind} activity`, needs);
    await execute(
      this.db,
      `INSERT INTO kauro.sales_activities (activity_id, prospect_id, intent_id, draft_id, authorization_id, kind, observation, suppression_key_kind, suppression_key, suppression_reason, provider_message_ref, evidence_hash, occurred_at, recorded_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        a.activityId,
        a.prospectId,
        a.intent?.intentId ?? null,
        a.intent?.draftId ?? null,
        a.intent?.authorizationId ?? null,
        a.kind,
        a.observation ?? null,
        a.suppression?.keyKind ?? null,
        a.suppression?.key ?? null,
        a.suppression?.reason ?? null,
        a.providerMessageRef ?? "NONE",
        a.evidenceHash,
        a.occurredAt,
        a.recordedByUserId,
      ],
    );
  }

  /**
   * A suppression of a key (L8 X of 'KEYKIND:key'), recorded by a person or by the outreach service (the public opt-out; the recorder
   * XOR of 0072). ON CONFLICT DO NOTHING as every writer of 0029: a second suppression of a live key is a replay, not a new fact. The
   * opt-out records the suppression only: the service never UPDATEs a prospect (A17).
   */
  async recordSuppression(locks: OutreachLocks, s: { readonly suppressionId: string; readonly keyKind: "ORGANIZATION" | "CONTACT"; readonly key: string; readonly reason: string; readonly by: { readonly userId: string } | { readonly service: "outreach-service" } }): Promise<boolean> {
    requireHeld(locks, "suppression", [["L8", `${s.keyKind}:${s.key}`, "X"]]);
    const r = await execute(
      this.db,
      "INSERT INTO kauro.prospect_suppressions (suppression_id, key_kind, suppression_key, reason, recorded_by_user_id, recorded_by_service, recorded_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), now()) ON CONFLICT DO NOTHING",
      [s.suppressionId, s.keyKind, s.key, s.reason, "userId" in s.by ? s.by.userId : null, "service" in s.by ? s.by.service : null],
    );
    return r.rowCount === 1;
  }
}
