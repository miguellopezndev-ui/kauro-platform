/**
 * The send records of package B12's lane L-SEND over `pg` (docs/design/B12-outreach-plan.md §L, §M, §W; migration 0072): CMD063
 * SendAuthorizedOutreach (the intent birth), the dispatcher's units D2 (claim), the D3 start gate, D4 (outcome, with its evidence path
 * "D4b") and D5 (recovery). Every unit follows the one pattern of plan §L: a DISCOVERY read (no lock; it only names the subjects), the
 * advisory subjects in the global order through OutreachLocks, ONE judgment statement (marked /* b12:judge *\/) that reads
 * kauro.effect_now() and every locked fact, synchronous decision logic, and then the first write (marked /* b12:write *\/) with no other
 * await between them. The counts (grant quota, 24 h cap, cadence, calendar, health pause) are the database's T3 (rule 17 backstop): D2
 * claims inside a SAVEPOINT, so a KC0xx refusal of T3 rolls back to it and the refusal is written in the same unit with the reason mapped
 * from the error; the instants are the database's (the application passes none).
 *
 * Traces: CMD063 L1 S (assigned seller), L3 X, L4 X, L4g S, L5 S, L6 S, L6p S, L7 S, L8 S, L10 X. D2 L1 set S, L3 S, L4 X|S, L4g S, L5 S,
 * L6 S, L6p S, L7 S, L8 S, L10 X, L13. D4 L1 set S, L3 S, L4 X|S, L4g S, L7 X (AUTH_REVOKED), L10 X, L13 attempted. D5 L1 set S, L3 S, L4 S,
 * L4g S, L10 X, L13.
 */
import { createHash } from "node:crypto";
import { DomainFailure, NotFoundFailure, type FailureReason, StaleVersionFailure, type OutreachPurpose, type SenderRoute } from "@kauro/domain";
import { OutreachLocks } from "../outreach-access.js";
import { execute, type Queryable } from "../sql.js";
import { awaitSalesTransition } from "./commercial-sales-rows.js";
import { PgOutreachWriters, requireHeld, type Need, type OutreachIntentKeys } from "./commercial-outreach.js";

/** A send refusal; KC032 names its sub-reason (CAP_REACHED, CADENCE_CLOSED, FIRST_NOT_SENT, OUTSIDE_BUSINESS_DAY) beside the reason (plan A10/A11). */
export class OutreachRefusal extends DomainFailure {
  constructor(code: "PRECONDITION_FAILED" | "CAPACITY_UNAVAILABLE", message: string, reason: FailureReason, readonly subReason: string | null) {
    super(code, message, { reason });
    this.name = "OutreachRefusal";
  }
}

export type SendActor = { readonly kind: "SELLER"; readonly userId: string; readonly sellerId: string } | { readonly kind: "OWNER"; readonly userId: string };

/** What the sealed message is built from (the application's sealer turns it into the payload hash; null = compliance unconfigured). */
export interface SealFacts {
  readonly intentId: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}
export type SealCheck = (facts: SealFacts, payloadHash: string | null) => "OK" | "UNCONFIGURED" | "CHANGED";

export interface QueueSendInput {
  readonly intentId: string;
  readonly draftId: string;
  readonly authorizationId: string;
  readonly actor: SendActor;
  readonly expectedVersion: number;
  readonly contentHash: string;
  readonly seal: (facts: SealFacts) => string | null;
}
export interface QueuedSend {
  readonly intentId: string;
  readonly state: "QUEUED";
  readonly draftId: string;
  readonly payloadHash: string;
  readonly purpose: OutreachPurpose;
  readonly route: SenderRoute;
  readonly senderId: string;
  readonly prospectId: string;
  readonly authorizationId: string;
  readonly personUserId: string;
}

/** The D2 verdict: admitted (with what D3 submits), refused (the intent's new state and reason), deferred (repeat grace) or gone. */
export type ClaimVerdict =
  | { readonly kind: "ADMITTED"; readonly fence: number; readonly submission: ClaimedSubmission }
  | { readonly kind: "REFUSED"; readonly state: "NOT_SENT" | "CANCELLED"; readonly reason: string }
  | { readonly kind: "DEFERRED"; readonly retryAt: string }
  | { readonly kind: "GONE"; readonly state: string };
export interface ClaimedSubmission {
  readonly intentId: string;
  readonly senderId: string;
  readonly senderAddress: string;
  readonly route: SenderRoute;
  readonly facts: SealFacts;
  readonly payloadHash: string;
}

/** What D3 learns from the gate statement (one statement, no lock). */
export interface StartGate {
  readonly state: string;
  readonly fenceMatches: boolean;
  readonly open: boolean;
}

export type OutcomeAnswer =
  | { readonly kind: "ACCEPTED"; readonly ref: string }
  | { readonly kind: "AUTH_REVOKED" }
  | { readonly kind: "REJECTED_DEFINITIVE"; readonly status: 400 | 403 | 413 | 429 }
  | { readonly kind: "NOT_ATTEMPTED" }
  | { readonly kind: "UNCERTAIN"; readonly cause: string };

interface Facts {
  intent_id: string;
  draft_id: string;
  authorization_id: string;
  prospect_id: string;
  person_user_id: string;
  purpose: OutreachPurpose;
  state: string;
  sender_id: string;
  route: SenderRoute;
  payload_hash: string;
  claim_fence: string | null;
  contact_key: string;
  organization_key: string;
  policy_jurisdiction: string;
  owner_seller_id: string | null;
  person_seller_id: string | null;
  sender_address: string;
  to_address: string | null;
  subject: string;
  body: string;
}

const FACTS = `i.intent_id, i.draft_id, i.authorization_id, i.prospect_id, i.person_user_id, i.purpose, i.state, i.sender_id, i.route, i.payload_hash, i.claim_fence, i.contact_key,
       p.organization_key, kauro.outreach_jurisdiction(p.jurisdiction) AS policy_jurisdiction, p.owner_seller_id,
       (SELECT s.seller_id FROM kauro.sellers s WHERE s.user_id = i.person_user_id) AS person_seller_id,
       si.address AS sender_address, a.address AS to_address, ct.subject, ct.body
  FROM kauro.outreach_send_intents i
  JOIN kauro.outreach_drafts d ON d.draft_id = i.draft_id
  JOIN kauro.prospects p ON p.prospect_id = i.prospect_id
  JOIN kauro.sender_identities si ON si.sender_id = i.sender_id
  JOIN kauro.outreach_contents ct ON ct.content_id = d.content_ref
  LEFT JOIN kauro.prospect_contact_addresses a ON a.contact_id = p.business_contact_id`;

const keysOf = (f: Facts): OutreachIntentKeys => ({ intentId: f.intent_id, draftId: f.draft_id, authorizationId: f.authorization_id, prospectId: f.prospect_id, personUserId: f.person_user_id, purpose: f.purpose });

/** The pg error behind a translated DomainFailure (sql.ts execute sets `cause`). */
function pgOf(e: unknown): { code: string; message: string } | null {
  const c = e instanceof DomainFailure ? (e.cause as { code?: unknown; message?: unknown } | undefined) : (e as { code?: unknown; message?: unknown } | undefined);
  return c !== undefined && typeof c.code === "string" ? { code: c.code, message: typeof c.message === "string" ? c.message : "" } : null;
}

/** KC032's sub-reason is the first token after "OUTREACH_CAP_REACHED: " (0072 T3). */
export function capSubReason(message: string): string | null {
  const m = /OUTREACH_CAP_REACHED: ([A-Z_]+)/.exec(message);
  return m === null ? null : (m[1] as string);
}

/** The D2 refusal a T3 error maps to (state, reason), or null for an error that is not a send refusal. */
function claimRefusalOf(code: string, message: string): { state: "NOT_SENT" | "CANCELLED"; reason: string } | null {
  switch (code) {
    case "KC028": return { state: "NOT_SENT", reason: "POLICY_WITHDRAWN" };
    case "KC029": return { state: "NOT_SENT", reason: "UNCERTAIN_OPEN" };
    case "KC030": return { state: "NOT_SENT", reason: /is revoked/.test(message) ? "GRANT_REVOKED" : /not yet valid/.test(message) ? "GRANT_NOT_YET_VALID" : /expired/.test(message) ? "GRANT_EXPIRED" : "GRANT_INVALID" };
    case "KC031": return { state: "CANCELLED", reason: "SENDER_REVOKED" };
    case "KC032": {
      const sub = capSubReason(message);
      return { state: "NOT_SENT", reason: sub === "OUTSIDE_BUSINESS_DAY" || sub === "CAP_REACHED" ? sub : "CADENCE_CLOSED" };
    }
    case "KC033": return { state: "NOT_SENT", reason: "RESOURCE_NOT_CURRENT" };
    case "KC034": return { state: "NOT_SENT", reason: "PAUSED" };
    case "KC036": return { state: "NOT_SENT", reason: "ALREADY_SENT" };
    default: return null;
  }
}

const DRAFT_AFTER: Readonly<Record<string, "CANCELLED" | "DRAFT" | "SUPPRESSED" | "PROVIDER_ACCEPTED">> = Object.freeze({ SUPPRESSED: "SUPPRESSED", ALREADY_SENT: "PROVIDER_ACCEPTED" });
const draftAfterRefusal = (state: "NOT_SENT" | "CANCELLED", reason: string): "CANCELLED" | "DRAFT" | "SUPPRESSED" | "PROVIDER_ACCEPTED" => (state === "CANCELLED" ? "CANCELLED" : (DRAFT_AFTER[reason] ?? "DRAFT"));

export class PgOutreachSend {
  readonly #writers: PgOutreachWriters;
  constructor(
    private readonly db: Queryable,
    private readonly newId: () => string,
  ) {
    this.#writers = new PgOutreachWriters(db);
  }

  // ---- CMD063 -------------------------------------------------------------------------------------------------------------------------

  /** CMD063: the intent QUEUED and its draft AUTHORIZED, judged at the database's instant under the whole serializer set (journal and event are the caller's). */
  async queueSend(i: QueueSendInput): Promise<QueuedSend> {
    // --- discovery (no lock): the facts that name the subjects; a draft the caller cannot see is as unknown as one nobody holds ---
    const d = (
      await execute<{
        prospect_id: string; sender_id: string; author_user_id: string; purpose: OutreachPurpose; contact_key: string; content_hash: string; version: string; sender_user_id: string;
        route: SenderRoute; sender_address: string; owner_seller_id: string | null; organization_key: string; policy_jurisdiction: string; subject: string; body: string; to_address: string | null;
      }>(
        this.db,
        `SELECT d.prospect_id, d.sender_id, d.author_user_id, d.purpose, d.contact_key, d.content_hash, d.version, si.user_id AS sender_user_id, si.route, si.address AS sender_address,
                p.owner_seller_id, p.organization_key, kauro.outreach_jurisdiction(p.jurisdiction) AS policy_jurisdiction, ct.subject, ct.body, a.address AS to_address
           FROM kauro.outreach_drafts d
           JOIN kauro.sender_identities si ON si.sender_id = d.sender_id
           JOIN kauro.prospects p ON p.prospect_id = d.prospect_id
           JOIN kauro.outreach_contents ct ON ct.content_id = d.content_ref
           LEFT JOIN kauro.prospect_contact_addresses a ON a.contact_id = p.business_contact_id
          WHERE d.draft_id = $1`,
        [i.draftId],
      )
    ).rows[0];
    const notAssigned = (): never => {
      throw new DomainFailure("NOT_AUTHORIZED", "the draft is not the caller's to send");
    };
    if (d === undefined || d.sender_user_id !== i.actor.userId) return notAssigned();
    if (i.actor.kind === "SELLER" && d.owner_seller_id !== i.actor.sellerId) return notAssigned();
    if ((await execute(this.db, "SELECT 1 FROM kauro.outreach_authorizations WHERE authorization_id = $1", [i.authorizationId])).rowCount !== 1) throw new NotFoundFailure("authorization");
    if (d.to_address === null) throw new NotFoundFailure("contact_address");
    const cited = await execute<{ family_id: string; subject: string | null }>(
      this.db,
      `SELECT r.family_id, coalesce(k.mode, k.capability_id::text) AS subject
         FROM kauro.outreach_draft_resources dr JOIN kauro.sales_resources r ON r.resource_id = dr.resource_id
         LEFT JOIN kauro.sales_resource_capabilities rc ON rc.resource_id = r.resource_id LEFT JOIN kauro.capabilities k ON k.capability_id = rc.capability_id
        WHERE dr.draft_id = $1`,
      [i.draftId],
    );
    const families = [...new Set(cited.rows.map((r) => r.family_id))];
    const capabilitySubjects = [...new Set(cited.rows.flatMap((r) => (r.subject === null ? [] : [r.subject])))];
    const contactSubject = `CONTACT:${d.contact_key}`;
    const organizationSubject = `ORGANIZATION:${d.organization_key}`;
    const policySubject = `${d.policy_jurisdiction}:${d.purpose}`;
    const payloadHash = i.seal({ intentId: i.intentId, from: d.sender_address, to: d.to_address, subject: d.subject, body: d.body });

    // --- the serializer set, in the global order (L1 and L2 of the caller are held) ---
    if (d.owner_seller_id !== null && !(i.actor.kind === "SELLER" && i.actor.sellerId === d.owner_seller_id)) await awaitSalesTransition(this.db, "kauro.sellers", d.owner_seller_id);
    const locks = new OutreachLocks(this.db);
    await locks.take("L3", d.prospect_id, "X");
    await locks.take("L4", d.sender_user_id, "X");
    await locks.take("L4g", i.authorizationId, "S");
    await locks.takeAll("L5", capabilitySubjects, "S");
    await locks.takeAll("L6", families, "S");
    await locks.take("L6p", policySubject, "S");
    await locks.take("L7", d.sender_id, "S");
    await locks.takeAll("L8", [contactSubject, organizationSubject], "S");
    await locks.take("L10", i.draftId, "X");

    // --- the judgment: one statement over the locked facts ---
    const v = (
      await execute<{
        draft_state: string; draft_version: string; draft_hash: string; sender_state: string; policy_state: string | null; suppressed: boolean; first_intent_id: string | null; reply_activity_id: string | null;
        offered: string; cited: string;
      }>(
        this.db,
        `/* b12:judge */ SELECT d.state AS draft_state, d.version AS draft_version, d.content_hash AS draft_hash,
                (SELECT s.state FROM kauro.sender_identities s WHERE s.sender_id = d.sender_id) AS sender_state,
                (SELECT cp.state FROM kauro.outreach_channel_policies cp WHERE cp.jurisdiction = $2 AND cp.purpose = $3 ORDER BY cp.version DESC LIMIT 1) AS policy_state,
                (EXISTS (SELECT 1 FROM kauro.prospect_suppressions x WHERE (x.key_kind = 'CONTACT' AND x.suppression_key = $4) OR (x.key_kind = 'ORGANIZATION' AND x.suppression_key = $5))
                 OR EXISTS (SELECT 1 FROM kauro.prospects p WHERE p.prospect_id = d.prospect_id AND p.state = 'SUPPRESSED')) AS suppressed,
                (SELECT f.intent_id FROM kauro.outreach_send_intents f WHERE f.prospect_id = d.prospect_id AND f.purpose = 'INDIVIDUAL_PROSPECT_CONTACT' ORDER BY f.counted_at DESC, f.intent_id DESC LIMIT 1) AS first_intent_id,
                (SELECT a.activity_id FROM kauro.sales_activities a WHERE a.prospect_id = d.prospect_id AND a.kind = 'REPLIED'
                    AND NOT EXISTS (SELECT 1 FROM kauro.outreach_send_intents r WHERE r.reply_activity_id = a.activity_id) ORDER BY a.recorded_at DESC, a.activity_id DESC LIMIT 1) AS reply_activity_id,
                (SELECT count(*) FROM kauro.outreach_draft_resources dr JOIN kauro.sales_resources r ON r.resource_id = dr.resource_id
                  WHERE dr.draft_id = d.draft_id AND r.state = 'CURRENT'
                    AND NOT EXISTS (SELECT 1 FROM kauro.sales_resource_capabilities rc JOIN kauro.capabilities k ON k.capability_id = rc.capability_id
                                     WHERE rc.resource_id = r.resource_id AND k.state NOT IN ('AVAILABLE', 'AVAILABLE_LIMITED'))) AS offered,
                (SELECT count(*) FROM kauro.outreach_draft_resources dr WHERE dr.draft_id = d.draft_id) AS cited
           FROM kauro.outreach_drafts d WHERE d.draft_id = $1 AND kauro.effect_now() IS NOT NULL`,
        [i.draftId, d.policy_jurisdiction, d.purpose, d.contact_key, d.organization_key],
      )
    ).rows[0];
    if (v === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the send judgment answered no row");
    const refuse = (code: "PRECONDITION_FAILED" | "CAPACITY_UNAVAILABLE", reason: FailureReason, subReason?: string): never => {
      throw new OutreachRefusal(code, `the send was refused: ${reason}`, reason, subReason ?? null);
    };
    if (Number(v.draft_version) !== i.expectedVersion) throw new StaleVersionFailure(Number(v.draft_version), v.draft_state);
    if (v.draft_hash !== i.contentHash) refuse("PRECONDITION_FAILED", "OUTREACH_GRANT_INVALID");
    if (d.route === "RESEND_TRANSACTIONAL") refuse("PRECONDITION_FAILED", "OUTREACH_ROUTE_FORBIDDEN");
    if (v.sender_state === "REVOKED") refuse("PRECONDITION_FAILED", "SENDER_REVOKED");
    if (v.sender_state !== "VERIFIED") refuse("PRECONDITION_FAILED", "SENDER_NOT_VERIFIED");
    if (v.suppressed || v.draft_state === "SUPPRESSED") refuse("PRECONDITION_FAILED", "PROSPECT_SUPPRESSED");
    if (v.draft_state === "CANCELLED") refuse("PRECONDITION_FAILED", "DRAFT_CLOSED");
    if (v.draft_state === "SEND_UNCERTAIN") refuse("PRECONDITION_FAILED", "SEND_UNCERTAIN_UNRESOLVED");
    if (v.draft_state !== "DRAFT") refuse("PRECONDITION_FAILED", "OUTREACH_ALREADY_SENT");
    if (v.policy_state !== "IN_FORCE") refuse("PRECONDITION_FAILED", "OUTREACH_JURISDICTION_UNREVIEWED");
    if (Number(v.offered) !== Number(v.cited)) refuse("PRECONDITION_FAILED", "RESOURCE_NOT_CURRENT");
    if (payloadHash === null) refuse("CAPACITY_UNAVAILABLE", "OUTREACH_COMPLIANCE_UNCONFIGURED");
    if (d.purpose === "FOLLOW_UP" && v.first_intent_id === null) refuse("PRECONDITION_FAILED", "OUTREACH_CAP_REACHED", "FIRST_NOT_SENT");
    if (d.purpose === "REQUESTED_REPLY" && v.reply_activity_id === null) refuse("PRECONDITION_FAILED", "OUTREACH_CAP_REACHED", "CADENCE_CLOSED");
    requireHeld(locks, "CMD063 send", [["L3", d.prospect_id, "X"], ["L4", d.sender_user_id, "X"], ["L4g", i.authorizationId, "S"], ["L6p", policySubject, "S"], ["L7", d.sender_id, "S"], ["L8", contactSubject, "S"], ["L8", organizationSubject, "S"], ["L10", i.draftId, "X"]]);

    // --- the write: the intent (T3 judges the counts at its birth), then the draft edge ---
    try {
      await this.#writers.queueIntent(locks, {
        intentId: i.intentId,
        draftId: i.draftId,
        authorizationId: i.authorizationId,
        prospectId: d.prospect_id,
        personUserId: d.sender_user_id,
        purpose: d.purpose,
        senderId: d.sender_id,
        route: d.route,
        contactKey: d.contact_key,
        payloadHash: payloadHash as string,
        sequenceFirstIntentId: d.purpose === "FOLLOW_UP" ? v.first_intent_id : null,
        replyActivityId: d.purpose === "REQUESTED_REPLY" ? v.reply_activity_id : null,
      });
    } catch (e) {
      const pg = pgOf(e);
      if (pg !== null && e instanceof DomainFailure && pg.code === "KC032") {
        const sub = capSubReason(pg.message);
        if (sub !== null) throw new OutreachRefusal("PRECONDITION_FAILED", e.message, "OUTREACH_CAP_REACHED", sub);
      }
      throw e;
    }
    return { intentId: i.intentId, state: "QUEUED", draftId: i.draftId, payloadHash: payloadHash as string, purpose: d.purpose, route: d.route, senderId: d.sender_id, prospectId: d.prospect_id, authorizationId: i.authorizationId, personUserId: d.sender_user_id };
  }

  // ---- shared: facts and the L1 set ----------------------------------------------------------------------------------------------------

  async #factsOf(intentId: string): Promise<Facts | null> {
    return (await execute<Facts>(this.db, `SELECT ${FACTS} WHERE i.intent_id = $1`, [intentId])).rows[0] ?? null;
  }

  /** L1 S on the set {sender principal, assigned seller}, ascending by kind and subject (service units; plan §L). */
  async #lockPrincipals(f: Facts): Promise<void> {
    const set: Array<readonly ["kauro.sellers" | "kauro.corporate_roles", string]> = [];
    if (f.person_seller_id !== null) set.push(["kauro.sellers", f.person_seller_id]);
    else set.push(["kauro.corporate_roles", f.person_user_id]);
    if (f.owner_seller_id !== null && f.owner_seller_id !== f.person_seller_id) set.push(["kauro.sellers", f.owner_seller_id]);
    set.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
    for (const [kind, subject] of set) await awaitSalesTransition(this.db, kind, subject);
  }

  async #lockIntent(f: Facts, locks: OutreachLocks, mode: { readonly capX: boolean; readonly senderX?: boolean }, resources: boolean): Promise<{ contact: string; organization: string }> {
    const contact = `CONTACT:${f.contact_key}`;
    const organization = `ORGANIZATION:${f.organization_key}`;
    await locks.take("L3", f.prospect_id, "S");
    await locks.take("L4", f.person_user_id, mode.capX ? "X" : "S");
    await locks.take("L4g", f.authorization_id, "S");
    if (resources) {
      const cited = await execute<{ family_id: string; subject: string | null }>(
        this.db,
        `SELECT r.family_id, coalesce(k.mode, k.capability_id::text) AS subject
           FROM kauro.outreach_draft_resources dr JOIN kauro.sales_resources r ON r.resource_id = dr.resource_id
           LEFT JOIN kauro.sales_resource_capabilities rc ON rc.resource_id = r.resource_id LEFT JOIN kauro.capabilities k ON k.capability_id = rc.capability_id
          WHERE dr.draft_id = $1`,
        [f.draft_id],
      );
      await locks.takeAll("L5", cited.rows.flatMap((r) => (r.subject === null ? [] : [r.subject])), "S");
      await locks.takeAll("L6", cited.rows.map((r) => r.family_id), "S");
      await locks.take("L6p", `${f.policy_jurisdiction}:${f.purpose}`, "S");
    }
    if (resources || mode.senderX === true) await locks.take("L7", f.sender_id, mode.senderX === true ? "X" : "S");
    if (resources) await locks.takeAll("L8", [contact, organization], "S");
    await locks.take("L10", f.draft_id, "X");
    return { contact, organization };
  }

  // ---- D2 -----------------------------------------------------------------------------------------------------------------------------

  /** D2: the claim of one QUEUED intent under the dispatcher's lease fence; every refusal is written in the same unit (zero provider calls). */
  async claim(intentId: string, lease: { readonly resourceId: string; readonly ownerId: string; readonly fence: number }, check: SealCheck): Promise<ClaimVerdict> {
    const f = await this.#factsOf(intentId);
    if (f === null) throw new NotFoundFailure("outreach_send_intent");
    if (f.state !== "QUEUED") return { kind: "GONE", state: f.state };
    await this.#lockPrincipals(f);
    const locks = new OutreachLocks(this.db);
    await this.#lockIntent(f, locks, { capX: f.purpose === "INDIVIDUAL_PROSPECT_CONTACT" }, true);
    await locks.lease(lease.resourceId, lease.ownerId, lease.fence);
    const keys = keysOf(f);
    // --- the judgment (re-reads the locked facts at the database's instant) ---
    const v = (
      await execute<{
        judged_at: Date; state: string; revoked: boolean; valid_from: Date; expires_at: Date; grant_ok: boolean; sender_state: string; policy_state: string | null; suppressed: boolean; owner_seller_id: string | null;
        seller_state: string | null; offered: string; cited: string; uncertain_open: boolean; already_sent: boolean; retry_at: Date | null; to_address: string | null; subject: string; body: string; sender_address: string; claim_ready: boolean;
      }>(
        this.db,
        `/* b12:judge */ SELECT kauro.effect_now() AS judged_at, i.state, g.revoked, g.valid_from, g.expires_at, (g.expires_at > kauro.effect_now() + interval '37 seconds') AS grant_ok,
                (SELECT s.state FROM kauro.sender_identities s WHERE s.sender_id = i.sender_id) AS sender_state,
                (SELECT cp.state FROM kauro.outreach_channel_policies cp WHERE cp.jurisdiction = $2 AND cp.purpose = i.purpose ORDER BY cp.version DESC LIMIT 1) AS policy_state,
                (EXISTS (SELECT 1 FROM kauro.prospect_suppressions x WHERE (x.key_kind = 'CONTACT' AND x.suppression_key = i.contact_key) OR (x.key_kind = 'ORGANIZATION' AND x.suppression_key = $3))
                 OR EXISTS (SELECT 1 FROM kauro.prospects p WHERE p.prospect_id = i.prospect_id AND p.state = 'SUPPRESSED')) AS suppressed,
                (SELECT p.owner_seller_id FROM kauro.prospects p WHERE p.prospect_id = i.prospect_id) AS owner_seller_id,
                (SELECT s.state FROM kauro.sellers s WHERE s.user_id = i.person_user_id) AS seller_state,
                (SELECT count(*) FROM kauro.outreach_draft_resources dr JOIN kauro.sales_resources r ON r.resource_id = dr.resource_id
                  WHERE dr.draft_id = i.draft_id AND r.state = 'CURRENT'
                    AND NOT EXISTS (SELECT 1 FROM kauro.sales_resource_capabilities rc JOIN kauro.capabilities k ON k.capability_id = rc.capability_id
                                     WHERE rc.resource_id = r.resource_id AND k.state NOT IN ('AVAILABLE', 'AVAILABLE_LIMITED'))) AS offered,
                (SELECT count(*) FROM kauro.outreach_draft_resources dr WHERE dr.draft_id = i.draft_id) AS cited,
                EXISTS (SELECT 1 FROM kauro.outreach_send_intents o WHERE o.prospect_id = i.prospect_id AND o.intent_id <> i.intent_id AND o.state IN ('SUBMITTING', 'SEND_UNCERTAIN')) AS uncertain_open,
                EXISTS (SELECT 1 FROM kauro.outreach_send_intents o JOIN kauro.outreach_send_evidence e ON e.intent_id = o.intent_id AND e.status = 'ACCEPTED' WHERE o.draft_id = i.draft_id AND o.intent_id <> i.intent_id) AS already_sent,
                (SELECT max(o.uncertain_after) + interval '60 seconds' FROM kauro.outreach_send_intents o WHERE o.draft_id = i.draft_id AND o.intent_id <> i.intent_id AND o.uncertain_after IS NOT NULL) AS retry_at,
                true AS claim_ready
           FROM kauro.outreach_send_intents i JOIN kauro.outreach_authorizations g ON g.authorization_id = i.authorization_id
          WHERE i.intent_id = $1`,
        [intentId, f.policy_jurisdiction, f.organization_key],
      )
    ).rows[0];
    if (v === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the claim judgment answered no row");
    if (v.state !== "QUEUED") return { kind: "GONE", state: v.state };
    const judged = v.judged_at.getTime();
    let refusal: { state: "NOT_SENT" | "CANCELLED"; reason: string } | null = null;
    const facts: SealFacts = { intentId, from: f.sender_address, to: f.to_address ?? "", subject: f.subject, body: f.body };
    if (v.suppressed) refusal = { state: "NOT_SENT", reason: "SUPPRESSED" };
    else if (v.revoked) refusal = { state: "NOT_SENT", reason: "GRANT_REVOKED" };
    else if (judged < v.valid_from.getTime()) refusal = { state: "NOT_SENT", reason: "GRANT_NOT_YET_VALID" };
    else if (!v.grant_ok) refusal = { state: "NOT_SENT", reason: "GRANT_EXPIRED" };
    else if (v.seller_state !== null && v.seller_state !== "ACTIVE") refusal = { state: "CANCELLED", reason: "SELLER_NOT_ACTIVE" };
    else if (f.person_seller_id !== null && v.owner_seller_id !== f.person_seller_id) refusal = { state: "CANCELLED", reason: "RECIPIENT_CHANGED" };
    else if (v.sender_state !== "VERIFIED") refusal = { state: "CANCELLED", reason: "SENDER_REVOKED" };
    else if (v.policy_state !== "IN_FORCE") refusal = { state: "NOT_SENT", reason: "POLICY_WITHDRAWN" };
    else if (Number(v.offered) !== Number(v.cited)) refusal = { state: "NOT_SENT", reason: "RESOURCE_NOT_CURRENT" };
    else if (v.already_sent) refusal = { state: "NOT_SENT", reason: "ALREADY_SENT" };
    else if (v.uncertain_open) refusal = { state: "NOT_SENT", reason: "UNCERTAIN_OPEN" };
    else {
      const sealed = check(facts, f.payload_hash);
      if (sealed === "UNCONFIGURED") refusal = { state: "NOT_SENT", reason: "COMPLIANCE_UNCONFIGURED" };
      else if (sealed === "CHANGED") refusal = { state: "NOT_SENT", reason: "PAYLOAD_CHANGED" };
    }
    if (refusal === null && v.retry_at !== null && v.retry_at.getTime() > judged) return { kind: "DEFERRED", retryAt: v.retry_at.toISOString() };
    if (refusal !== null) {
      await this.#writers.refuseQueued(locks, keys, refusal.state, refusal.reason, draftAfterRefusal(refusal.state, refusal.reason));
      return { kind: "REFUSED", ...refusal };
    }
    // --- the write: QUEUED -> SUBMITTING inside a savepoint (T3 judges the counts at the claim) ---
    await execute(this.db, "SAVEPOINT b12_claim");
    try {
      if (!(await this.#writers.claimIntent(locks, keys, lease.fence))) {
        await execute(this.db, "ROLLBACK TO SAVEPOINT b12_claim");
        return { kind: "GONE", state: "UNKNOWN" };
      }
    } catch (e) {
      const pg = pgOf(e);
      const refused = pg === null ? null : claimRefusalOf(pg.code, pg.message);
      if (pg?.code === "KC037") {
        await execute(this.db, "ROLLBACK TO SAVEPOINT b12_claim");
        return { kind: "DEFERRED", retryAt: new Date(judged + 60_000).toISOString() };
      }
      if (refused === null) throw e;
      await execute(this.db, "ROLLBACK TO SAVEPOINT b12_claim");
      await this.#writers.refuseQueued(locks, keys, refused.state, refused.reason, draftAfterRefusal(refused.state, refused.reason));
      return { kind: "REFUSED", ...refused };
    }
    await execute(this.db, "RELEASE SAVEPOINT b12_claim");
    return { kind: "ADMITTED", fence: lease.fence, submission: { intentId, senderId: f.sender_id, senderAddress: f.sender_address, route: f.route, facts, payloadHash: f.payload_hash } };
  }

  // ---- D3 gate ------------------------------------------------------------------------------------------------------------------------

  /** The D3 start gate: ONE statement, no lock; open while effect_now <= submitted_at + startGate and the intent is still this fence's SUBMITTING. */
  async gate(intentId: string, fence: number): Promise<StartGate> {
    const r = (
      await execute<{ state: string; claim_fence: string | null; open: boolean }>(
        this.db,
        "SELECT state, claim_fence, (kauro.effect_now() <= submitted_at + interval '5 seconds') AS open FROM kauro.outreach_send_intents WHERE intent_id = $1",
        [intentId],
      )
    ).rows[0];
    if (r === undefined) throw new NotFoundFailure("outreach_send_intent");
    return { state: r.state, fenceMatches: r.state === "SUBMITTING" && Number(r.claim_fence) === fence, open: r.open === true };
  }

  // ---- D4 -----------------------------------------------------------------------------------------------------------------------------

  /** D4: records the provider's classified answer under `fence`; an edge that is not admissible takes the evidence path (D4b) in the same unit. Returns what was recorded. */
  async record(intentId: string, lease: { readonly resourceId: string; readonly ownerId: string; readonly fence: number }, answer: OutcomeAnswer): Promise<string> {
    const f = await this.#factsOf(intentId);
    if (f === null) throw new NotFoundFailure("outreach_send_intent");
    const warning = answer.kind === "REJECTED_DEFINITIVE" && (answer.status === 403 || answer.status === 429);
    await this.#lockPrincipals(f);
    const locks = new OutreachLocks(this.db);
    await this.#lockIntent(f, locks, { capX: warning, senderX: answer.kind === "AUTH_REVOKED" }, false);
    let leased = true;
    try {
      await locks.lease(lease.resourceId, lease.ownerId, lease.fence);
    } catch (e) {
      if (!(e instanceof DomainFailure) || e.details.reason !== "LEASE_FENCED") throw e;
      leased = false;
    }
    const keys = keysOf(f);
    const j = (
      await execute<{ judged_at: Date; state: string; claim_fence: string | null; has_activity: boolean; has_evidence: boolean }>(
        this.db,
        `/* b12:judge */ SELECT kauro.effect_now() AS judged_at, i.state, i.claim_fence,
                EXISTS (SELECT 1 FROM kauro.sales_activities a WHERE a.intent_id = i.intent_id AND a.kind IN ('PROVIDER_ACCEPTED', 'SEND_UNCERTAIN') AND a.kind = $2) AS has_activity,
                EXISTS (SELECT 1 FROM kauro.outreach_send_evidence e WHERE e.intent_id = i.intent_id AND e.fence = $3) AS has_evidence
           FROM kauro.outreach_send_intents i WHERE i.intent_id = $1`,
        [intentId, answer.kind === "ACCEPTED" ? "PROVIDER_ACCEPTED" : answer.kind === "UNCERTAIN" ? "SEND_UNCERTAIN" : "NONE", lease.fence],
      )
    ).rows[0];
    if (j === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the outcome judgment answered no row");
    const at = j.judged_at.toISOString();
    const sameFence = Number(j.claim_fence) === lease.fence;
    if (j.has_activity) return "NOOP";
    const edge = leased && sameFence && (j.state === "SUBMITTING" || (j.state === "SEND_UNCERTAIN" && answer.kind === "ACCEPTED"));
    if (edge) {
      if (answer.kind === "ACCEPTED") {
        const ok = j.state === "SUBMITTING" ? await this.#writers.answerIntent(locks, keys, lease.fence, { state: "PROVIDER_ACCEPTED", providerMessageRef: answer.ref }) : await this.#writers.acceptUncertain(locks, keys, answer.ref);
        if (ok) await this.#writers.recordServiceActivity(locks, { activityId: this.#id(), intent: keys, kind: "PROVIDER_ACCEPTED", providerMessageRef: answer.ref, evidenceHash: this.#sha(`accepted:${intentId}:${lease.fence}`), occurredAt: at });
        return ok ? "PROVIDER_ACCEPTED" : "NOOP";
      }
      if (j.state === "SEND_UNCERTAIN") return await this.#evidence(intentId, lease.fence, answer, at, locks, f);
      if (answer.kind === "UNCERTAIN") {
        const ok = await this.#writers.answerIntent(locks, keys, lease.fence, { state: "SEND_UNCERTAIN" });
        if (ok) await this.#writers.recordServiceActivity(locks, { activityId: this.#id(), intent: keys, kind: "SEND_UNCERTAIN", providerMessageRef: "NONE", evidenceHash: this.#sha(`uncertain:${intentId}:${lease.fence}:${answer.cause}`), occurredAt: at });
        return ok ? "SEND_UNCERTAIN" : "NOOP";
      }
      if (answer.kind === "AUTH_REVOKED") {
        await this.#writers.answerIntent(locks, keys, lease.fence, { state: "NOT_SENT", outcomeReason: "AUTH_REVOKED", draftState: "CANCELLED" });
        await execute(this.db, "UPDATE kauro.sender_identities SET state = 'REVOKED' WHERE sender_id = $1 AND state <> 'REVOKED'", [f.sender_id]);
        return "NOT_SENT(AUTH_REVOKED)";
      }
      const reason = answer.kind === "NOT_ATTEMPTED" ? "LOCAL_FAILURE" : `PROVIDER_REJECTED:${answer.status}`;
      await this.#writers.answerIntent(locks, keys, lease.fence, { state: "NOT_SENT", outcomeReason: reason, draftState: "DRAFT" });
      if (warning) await this.#warning(f, (answer as { status: number }).status, at);
      return `NOT_SENT(${reason})`;
    }
    return await this.#evidence(intentId, lease.fence, answer, at, locks, f);
  }

  #id(): string {
    return this.newId();
  }

  /** The evidence digest of a service-recorded fact: sha256 of its identity string (pure, no clock). */
  #sha(seed: string): string {
    return createHash("sha256").update(`KAURO_OUTREACH_SERVICE_EVIDENCE_V1
${seed}`, "utf8").digest("hex");
  }

  async #warning(f: Facts, status: number, at: string): Promise<void> {
    await execute(
      this.db,
      "INSERT INTO kauro.outreach_provider_warnings (warning_id, intent_id, person_user_id, status, recorded_by_service, recorded_at) VALUES ($1, $2, $3, $4, 'outreach-service', $5) ON CONFLICT DO NOTHING",
      [this.#id(), f.intent_id, f.person_user_id, status, at],
    );
  }

  /** D4b: the evidence row of (intent, fence) and its consequences (plan A3 (i)-(iii)). */
  async #evidence(intentId: string, fence: number, answer: OutcomeAnswer, at: string, locks: OutreachLocks, f: Facts): Promise<string> {
    const status = answer.kind === "UNCERTAIN" ? "UNKNOWN" : answer.kind === "REJECTED_DEFINITIVE" ? "REJECTED_DEFINITIVE" : answer.kind;
    requireHeld(locks, "D4b evidence", [["L10", f.draft_id, "X"]]);
    const inserted = await execute(
      this.db,
      `/* b12:write */ INSERT INTO kauro.outreach_send_evidence (evidence_id, intent_id, fence, status, provider_ref, http_status, recorded_by_service, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'outreach-service', $7) ON CONFLICT DO NOTHING`,
      [this.#id(), intentId, fence, status, answer.kind === "ACCEPTED" ? answer.ref : "NONE", answer.kind === "REJECTED_DEFINITIVE" ? answer.status : null, at],
    );
    if (inserted.rowCount !== 1) return "NOOP";
    if (answer.kind === "REJECTED_DEFINITIVE" && (answer.status === 403 || answer.status === 429)) await this.#warning(f, answer.status, at);
    if (answer.kind !== "ACCEPTED") return `EVIDENCE(${status})`;
    const state = (await execute<{ state: string }>(this.db, "SELECT state FROM kauro.outreach_send_intents WHERE intent_id = $1", [intentId])).rows[0]?.state;
    const keys = keysOf(f);
    if (state === "SUBMITTING" || state === "SEND_UNCERTAIN") {
      const r = await execute(
        this.db,
        "UPDATE kauro.outreach_send_intents SET state = 'PROVIDER_ACCEPTED', provider_message_ref = $2, answered_fence = $3 WHERE intent_id = $1 AND state IN ('SUBMITTING', 'SEND_UNCERTAIN')",
        [intentId, answer.ref, fence],
      );
      if (r.rowCount === 1) {
        await this.#writers.moveDraft(locks, f.draft_id, "PROVIDER_ACCEPTED");
        await this.#writers.recordServiceActivity(locks, { activityId: this.#id(), intent: keys, kind: "PROVIDER_ACCEPTED", providerMessageRef: answer.ref, evidenceHash: this.#sha(`late-accepted:${intentId}:${fence}`), occurredAt: at });
        return "PROVIDER_ACCEPTED";
      }
    }
    if (state === "OBSERVED_NOT_SENT") await this.#writers.moveDraft(locks, f.draft_id, "PROVIDER_ACCEPTED");
    return "EVIDENCE(ACCEPTED)";
  }

  // ---- D5 -----------------------------------------------------------------------------------------------------------------------------

  /** The intents D5 recovers: SUBMITTING with uncertain_after passed at the database's instant (no lock; the unit re-judges). */
  async dueForRecovery(limit: number): Promise<ReadonlyArray<string>> {
    const r = await execute<{ intent_id: string }>(
      this.db,
      "SELECT intent_id FROM kauro.outreach_send_intents WHERE state = 'SUBMITTING' AND uncertain_after <= kauro.effect_now() ORDER BY uncertain_after, intent_id LIMIT $1",
      [limit],
    );
    return r.rows.map((x) => x.intent_id);
  }

  /** D5: SUBMITTING -> SEND_UNCERTAIN with its activity, no call; idempotent (a state guard). */
  async recover(intentId: string, lease: { readonly resourceId: string; readonly ownerId: string; readonly fence: number }): Promise<"SEND_UNCERTAIN" | "UNTOUCHED"> {
    const f = await this.#factsOf(intentId);
    if (f === null) throw new NotFoundFailure("outreach_send_intent");
    if (f.state !== "SUBMITTING") return "UNTOUCHED";
    await this.#lockPrincipals(f);
    const locks = new OutreachLocks(this.db);
    await this.#lockIntent(f, locks, { capX: false }, false);
    await locks.lease(lease.resourceId, lease.ownerId, lease.fence);
    const j = (
      await execute<{ judged_at: Date; due: boolean; claim_fence: string | null }>(
        this.db,
        "/* b12:judge */ SELECT kauro.effect_now() AS judged_at, (i.state = 'SUBMITTING' AND i.uncertain_after <= kauro.effect_now()) AS due, i.claim_fence FROM kauro.outreach_send_intents i WHERE i.intent_id = $1",
        [intentId],
      )
    ).rows[0];
    if (j === undefined || !j.due) return "UNTOUCHED";
    const keys = keysOf(f);
    const ok = await this.#writers.answerIntent(locks, keys, Number(j.claim_fence), { state: "SEND_UNCERTAIN" });
    if (!ok) return "UNTOUCHED";
    await this.#writers.recordServiceActivity(locks, { activityId: this.#id(), intent: keys, kind: "SEND_UNCERTAIN", providerMessageRef: "NONE", evidenceHash: this.#sha(`recovered:${intentId}:${j.claim_fence}`), occurredAt: j.judged_at.toISOString() });
    return "SEND_UNCERTAIN";
  }

  /** The outbox record of an intent's event (the dispatcher settles it); null when none. */
  async intentOfEvent(eventId: string): Promise<string | null> {
    const r = await execute<{ aggregate_id: string }>(this.db, "SELECT aggregate_id FROM kauro.domain_events WHERE event_id = $1 AND event_type = 'outreach.send_intended.v1'", [eventId]);
    return r.rows[0]?.aggregate_id ?? null;
  }

  /** The state of an intent (D6 settles the outbox record by it); null when none. */
  async stateOf(intentId: string): Promise<string | null> {
    const r = await execute<{ state: string }>(this.db, "SELECT state FROM kauro.outreach_send_intents WHERE intent_id = $1", [intentId]);
    return r.rows[0]?.state ?? null;
  }
}
