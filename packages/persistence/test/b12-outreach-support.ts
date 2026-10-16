// Fixtures of the outreach schema (migration 0088; docs/design/B12-outreach-plan.md §0 A1..A17, §L, §W; companion
// docs/design/B12-outreach-plan-cells.md §K) for b12-outreach-migrations.test.ts. Like b10-commission-support.ts, every write goes through
// the runtime role that owns it, under a real context, holding the lock subjects of plan §L T2 that its production writer holds:
//   - the corporate owner (kauro_app_test, OPERATOR session) records and verifies senders, prepares reviews, grants, revokes, publishes
//     resources, withdraws channel policies and records diagnoses;
//   - a seller (kauro_app_test, OPERATOR session of its own identity) records content, drafts, queues its intents (CMD063), records its
//     activities (CMD064) and its human observations;
//   - the outreach service (kauro_outreach_test, no agency) claims, answers and reconciles intents (D2..D5), records warnings and evidence.
// Every B12 transaction stands at a labelled TEST CLOCK instant (clockAt), so the judged instant kauro.effect_now() is an outreach business
// instant chosen by the test, never the wall clock. The superuser oracle only reads, except the guard switches of the rule-24c checks
// (dropGuards), which change one guard of the schema and restore it before anything else runs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Client } from "pg";
import { activeSeller, clockAt, closeWorld, ids, openWorld, ownerOf, personOf, sha, within, type CommerceContext, type Prospect, type Seller, type World } from "./b10-commission-support.js";
import { stepUpProof } from "./support.js";

export { ids, sha, ownerOf, personOf };
export type { Seller, Prospect, CommerceContext };

export const L = Object.freeze({
  L3: "kauro.outreach_prospects",
  L4: "kauro.outreach_person_caps",
  L4g: "kauro.outreach_authorizations",
  L6: "kauro.sales_resources",
  L6p: "kauro.outreach_channel_policies",
  L7: "kauro.sender_identities",
  L8: "kauro.prospect_suppressions",
  L10: "kauro.outreach_drafts",
});
export type LockName = keyof typeof L;

export interface B12World extends World {
  readonly outreach: Client;
  readonly s: Seller;
  readonly s2: Seller;
  /** the base instant slots are counted from (a Monday 15:00Z: 10:00 in Bogota and in New York) */
  readonly base: string;
  slot: number;
}

export async function openB12(label: string): Promise<B12World> {
  const w = await openWorld(label);
  const outreach = await w.h.pg.connect("kauro_outreach_test");
  const s = await activeSeller(w, `${label}-seller-one`);
  const s2 = await activeSeller(w, `${label}-seller-two`);
  return Object.assign(w, { outreach, s, s2, base: "2027-02-01T15:00:00Z", slot: 0 });
}

export async function closeB12(w: B12World): Promise<void> {
  await w.outreach.end();
  await closeWorld(w);
}

/** The next free outreach business instant: two business days after the previous one, so no two fixtures share a 24-hour cap window. */
export async function nextSlot(w: B12World): Promise<string> {
  w.slot += 2;
  return businessDaysAfter(w, w.base, w.slot);
}

export async function businessDaysAfter(w: B12World, at: string, n: number): Promise<string> {
  const r = await w.h.oracle.query<{ at: Date }>("SELECT kauro.outreach_business_days_after($1::timestamptz, $2) AS at", [at, n]);
  assert.ok(r.rows[0]?.at, `${n} business days after ${at} are covered by the calendar`);
  return r.rows[0].at.toISOString();
}

export const plus = (at: string, seconds: number): string => new Date(Date.parse(at) + seconds * 1000).toISOString();
export const DAY = 86_400;

/** Takes a lock subject of plan §L in this transaction (X = pg_advisory_xact_lock, S = its shared half). */
export async function lock(c: Client, name: LockName, subject: string, mode: "X" | "S" = "X"): Promise<void> {
  await c.query(`SELECT ${mode === "X" ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared"}(kauro.transition_key($1, $2))`, [L[name], subject]);
}

/** One transaction under the context at the TEST CLOCK instant `at`; commits when fn returns. */
export function at<T>(c: Client, ctx: CommerceContext, instant: string, fn: (c: Client) => Promise<T>): Promise<T> {
  return within(c, ctx, async (cc) => {
    await clockAt(cc, instant);
    return fn(cc);
  });
}

// --- senders, content, drafts ---------------------------------------------------------------------------------------------------------

export interface Sender {
  readonly senderId: string;
  readonly userId: string;
  readonly route: "GMAIL_API" | "RESEND_TRANSACTIONAL";
}

let addressSeq = 0;
/** The owner records a sender of a person (and, unless `pending`, verifies it under L7 X). */
export async function sender(w: B12World, userId: string, options: { readonly route?: "GMAIL_API" | "RESEND_TRANSACTIONAL"; readonly pending?: boolean } = {}): Promise<Sender> {
  const senderId = ids.next();
  const route = options.route ?? "GMAIL_API";
  await at(w.app, ownerOf(w), w.base, async (c) => {
    await c.query(
      "INSERT INTO kauro.sender_identities (sender_id, user_id, address, route, consent_evidence_ref, recorded_by_user_id) VALUES ($1, $2, $3, $4, $5, $6)",
      [senderId, userId, `sender-${++addressSeq}-${senderId.slice(-6)}@mail.example`, route, route === "GMAIL_API" ? sha(`consent-${senderId}`) : null, w.kora],
    );
    if (options.pending !== true) {
      await lock(c, "L7", senderId);
      await c.query("UPDATE kauro.sender_identities SET state = 'VERIFIED', verification_evidence_hash = $2 WHERE sender_id = $1", [senderId, sha(`verified-${senderId}`)]);
    }
  });
  return { senderId, userId, route };
}

export const contentIdOf = (subject: string, body: string): string => createHash("sha256").update(`KAURO_OUTREACH_CONTENT_V1\n${subject}\n${body}`, "utf8").digest("hex");
export const bindingOf = (prospectId: string, contactKey: string, senderId: string, purpose: string, contentRef: string): string =>
  createHash("sha256").update(["KAURO_OUTREACH_BINDING_V1", prospectId, contactKey, senderId, purpose, contentRef].join("\n"), "utf8").digest("hex");

/** A person records a content row (content-addressed). */
export async function content(w: B12World, userId: string, label: string): Promise<string> {
  const subject = `Data migration help ${label}`;
  const body = `Hello, we move CRM data safely. ${label}`;
  const id = contentIdOf(subject, body);
  const ctx = userId === w.kora ? ownerOf(w) : personOf(userId);
  await at(w.app, ctx, w.base, (c) =>
    c.query("INSERT INTO kauro.outreach_contents (content_id, subject, body, recorded_by_user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [id, subject, body, userId]),
  );
  return id;
}

export type Purpose = "REQUESTED_REPLY" | "INDIVIDUAL_PROSPECT_CONTACT" | "FOLLOW_UP";

export interface Draft {
  readonly draftId: string;
  readonly prospectId: string;
  readonly senderId: string;
  readonly personUserId: string;
  readonly purpose: Purpose;
  readonly contactKey: string;
  readonly contentHash: string;
  readonly route: "GMAIL_API" | "RESEND_TRANSACTIONAL";
}

export function draftRow(w: B12World, snd: Sender, prospect: { readonly prospectId: string; readonly contactKey: string }, purpose: Purpose, contentRef: string, author: string = snd.userId) {
  const draftId = ids.next();
  return {
    draftId,
    sql: "INSERT INTO kauro.outreach_drafts (draft_id, prospect_id, sender_id, author_user_id, purpose, content_ref, contact_key, content_hash, provenance_evidence_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    params: [draftId, prospect.prospectId, snd.senderId, author, purpose, contentRef, prospect.contactKey, bindingOf(prospect.prospectId, prospect.contactKey, snd.senderId, purpose, contentRef), sha(`provenance-${prospect.prospectId}`)],
  };
}

/** CMD061's draft row by the sender's person (or `author`). */
export async function draft(w: B12World, snd: Sender, prospect: { readonly prospectId: string; readonly contactKey: string }, purpose: Purpose = "INDIVIDUAL_PROSPECT_CONTACT", options: { readonly author?: string; readonly resources?: ReadonlyArray<string> } = {}): Promise<Draft> {
  const author = options.author ?? snd.userId;
  const contentRef = await content(w, author, `${prospect.prospectId}-${purpose}-${ids.next().slice(-6)}`);
  const row = draftRow(w, snd, prospect, purpose, contentRef, author);
  const ctx = author === w.kora ? ownerOf(w) : personOf(author);
  await at(w.app, ctx, w.base, async (c) => {
    await c.query(row.sql, row.params);
    for (const r of options.resources ?? []) await c.query("INSERT INTO kauro.outreach_draft_resources (draft_id, resource_id) VALUES ($1, $2)", [row.draftId, r]);
  });
  return { draftId: row.draftId, prospectId: prospect.prospectId, senderId: snd.senderId, personUserId: snd.userId, purpose, contactKey: prospect.contactKey, contentHash: row.params[7] as string, route: snd.route };
}

// --- reviews and grants ----------------------------------------------------------------------------------------------------------------

export interface Grant {
  readonly authorizationId: string;
  readonly reviewId: string;
  readonly proofId: string;
}

/** PrepareOutreachReview by the owner at `instant`: the review and its items. */
export async function review(w: B12World, snd: Sender, drafts: ReadonlyArray<Draft>, instant: string, options: { readonly proofId?: string } = {}): Promise<{ reviewId: string; proofId: string }> {
  const proofId = options.proofId ?? (await stepUpProof(w.assurance, { userId: w.kora }));
  const reviewId = ids.next();
  await at(w.app, ownerOf(w), instant, async (c) => {
    await c.query("INSERT INTO kauro.outreach_reviews (review_id, owner_user_id, proof_id, sender_id, digest, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, now(), now() + interval '15 minutes')", [
      reviewId,
      w.kora,
      proofId,
      snd.senderId,
      sha(`review-${reviewId}`),
    ]);
    for (const d of drafts) {
      await c.query("INSERT INTO kauro.outreach_review_items (review_id, draft_id, draft_version, content_hash, contact_label) VALUES ($1, $2, 1, $3, 'Operations lead')", [reviewId, d.draftId, d.contentHash]);
    }
  });
  return { reviewId, proofId };
}

export interface GrantOptions {
  readonly maximumSends?: number;
  readonly validFrom?: string;
  readonly expiresAt?: string;
  readonly seal?: ReadonlyArray<Draft>;
  readonly proofId?: string;
}

/** The grant statements of CMD062 (no transaction): the authorization and its sealed hashes. */
export async function insertGrant(c: Client, w: B12World, snd: Sender, rv: { reviewId: string; proofId: string }, drafts: ReadonlyArray<Draft>, instant: string, options: GrantOptions = {}): Promise<string> {
  const authorizationId = ids.next();
  const seal = options.seal ?? drafts;
  await c.query(
    "INSERT INTO kauro.outreach_authorizations (authorization_id, review_id, granting_user_id, sender_id, proof_id, valid_from, expires_at, maximum_sends, permission_evidence_hash, policy_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'outreach-v1')",
    [authorizationId, rv.reviewId, w.kora, snd.senderId, options.proofId ?? rv.proofId, options.validFrom ?? instant, options.expiresAt ?? plus(instant, 13 * DAY), options.maximumSends ?? seal.length, sha(`permission-${authorizationId}`)],
  );
  for (const d of seal) await c.query("INSERT INTO kauro.outreach_authorization_hashes (authorization_id, draft_id, content_hash) VALUES ($1, $2, $3)", [authorizationId, d.draftId, d.contentHash]);
  return authorizationId;
}

/** Review and grant at `instant` (CMD062 a moment after PrepareOutreachReview). */
export async function grant(w: B12World, snd: Sender, drafts: ReadonlyArray<Draft>, instant: string, options: GrantOptions = {}): Promise<Grant> {
  const rv = await review(w, snd, drafts, instant);
  const authorizationId = await at(w.app, ownerOf(w), plus(instant, 1), (c) => insertGrant(c, w, snd, rv, drafts, plus(instant, 1), options));
  return { authorizationId, reviewId: rv.reviewId, proofId: rv.proofId };
}

// --- intents -------------------------------------------------------------------------------------------------------------------------------

export interface Intent {
  readonly intentId: string;
  readonly draft: Draft;
  readonly authorizationId: string;
}

export interface QueueOptions {
  readonly skip?: LockName;
  readonly sequenceFirstIntentId?: string;
  readonly replyActivityId?: string;
  readonly intentId?: string;
  readonly senderId?: string;
  readonly route?: string;
  readonly moveDraft?: boolean;
  /** Queue the intent WITHOUT its outreach.send_intended.v1 event (the cells that prove the database refuses that commit). */
  readonly noEvent?: true;
}

/** CMD063's statements (no transaction): L3 X, L4 X, L4g S, L10 X, the intent, the draft DRAFT -> AUTHORIZED. */
export async function queueIn(c: Client, d: Draft, authorizationId: string, options: QueueOptions = {}): Promise<Intent> {
  const intentId = options.intentId ?? ids.next();
  if (options.skip !== "L3") await lock(c, "L3", d.prospectId);
  if (options.skip !== "L4") await lock(c, "L4", d.personUserId);
  if (options.skip !== "L4g") await lock(c, "L4g", authorizationId, "S");
  if (options.skip !== "L10") await lock(c, "L10", d.draftId);
  await c.query(
    `INSERT INTO kauro.outreach_send_intents (intent_id, draft_id, authorization_id, sender_id, person_user_id, prospect_id, purpose, route, contact_key, payload_hash, sequence_first_intent_id, reply_activity_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [intentId, d.draftId, authorizationId, options.senderId ?? d.senderId, d.personUserId, d.prospectId, d.purpose, options.route ?? d.route, d.contactKey, sha(`payload-${intentId}`), options.sequenceFirstIntentId ?? null, options.replyActivityId ?? null],
  );
  if (options.moveDraft !== false) await c.query("UPDATE kauro.outreach_drafts SET state = 'AUTHORIZED' WHERE draft_id = $1", [d.draftId]);
  const intent = { intentId, draft: d, authorizationId };
  if (options.noEvent !== true) await sendIntendedIn(c, intent, { senderId: options.senderId ?? d.senderId, route: options.route ?? d.route });
  return intent;
}

/**
 * CMD063's event and outbox record (no transaction; plan A2, 07 "one event per committed version"): outreach.send_intended.v1 of the
 * agency-less aggregate outreach_send_intent at version 1, and the record addressed to OUTREACH_SENDER. Returns the event id.
 * `override` forges one column of the event or record for the refusal cells.
 */
export async function sendIntendedIn(
  c: Client,
  i: Intent,
  override: {
    readonly agencyId?: string | null;
    readonly version?: number;
    readonly aggregateId?: string;
    readonly eventType?: string;
    readonly kind?: string;
    readonly consumer?: string;
    readonly noOutbox?: true;
    readonly senderId?: string;
    readonly route?: string;
  } = {},
): Promise<string> {
  const eventId = ids.next();
  const payload = {
    intentId: i.intentId,
    draftId: i.draft.draftId,
    authorizationId: i.authorizationId,
    senderId: override.senderId ?? i.draft.senderId,
    prospectId: i.draft.prospectId,
    purpose: i.draft.purpose,
    route: override.route ?? i.draft.route,
    payloadHash: sha(`payload-${i.intentId}`),
  };
  await c.query(
    `INSERT INTO kauro.domain_events (event_id, aggregate_kind, aggregate_id, aggregate_version, agency_id, event_type, actor_kind, actor_id, causation_id, correlation_id, payload, payload_hash, schema_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'USER', $7, $8, $9, $10, $11, '1', kauro.server_now())`,
    [eventId, override.kind ?? "outreach_send_intent", override.aggregateId ?? i.intentId, override.version ?? 1, override.agencyId ?? null, override.eventType ?? "outreach.send_intended.v1", i.draft.personUserId, ids.next(), ids.next(), JSON.stringify(payload), sha(JSON.stringify(payload))],
  );
  if (override.noOutbox !== true) {
    await c.query(
      "INSERT INTO kauro.outbox_records (outbox_id, event_id, consumer, state, attempts, next_attempt_at, created_at, updated_at) VALUES ($1, $2, $3, 'PENDING', 0, kauro.server_now(), kauro.server_now(), kauro.server_now())",
      [ids.next(), eventId, override.consumer ?? "OUTREACH_SENDER"],
    );
  }
  return eventId;
}

export const personCtx = (w: B12World, userId: string): CommerceContext => (userId === w.kora ? ownerOf(w) : personOf(userId));

export function queue(w: B12World, d: Draft, authorizationId: string, instant: string, options: QueueOptions = {}): Promise<Intent> {
  return at(w.app, personCtx(w, d.personUserId), instant, (c) => queueIn(c, d, authorizationId, options));
}

/** D2's claim (no transaction): L3 S, L4 X for a first contact (else S), L4g S, L10 X; QUEUED -> SUBMITTING, draft AUTHORIZED -> SUBMITTING. */
export async function claimIn(c: Client, i: Intent, options: { readonly skip?: LockName; readonly fence?: number } = {}): Promise<void> {
  if (options.skip !== "L3") await lock(c, "L3", i.draft.prospectId, "S");
  if (options.skip !== "L4") await lock(c, "L4", i.draft.personUserId, i.draft.purpose === "INDIVIDUAL_PROSPECT_CONTACT" ? "X" : "S");
  if (options.skip !== "L4g") await lock(c, "L4g", i.authorizationId, "S");
  if (options.skip !== "L10") await lock(c, "L10", i.draft.draftId);
  await c.query("UPDATE kauro.outreach_send_intents SET state = 'SUBMITTING', claim_fence = $2 WHERE intent_id = $1", [i.intentId, options.fence ?? 1]);
  await c.query("UPDATE kauro.outreach_drafts SET state = 'SUBMITTING' WHERE draft_id = $1", [i.draft.draftId]);
}

export const claim = (w: B12World, i: Intent, instant: string): Promise<void> => at(w.outreach, {}, instant, (c) => claimIn(c, i));

/** The subjects of an answer edge (L3 S, L4 S, L4g S, L10 X). */
export async function answerLocks(c: Client, i: Intent): Promise<void> {
  await lock(c, "L3", i.draft.prospectId, "S");
  await lock(c, "L4", i.draft.personUserId, "S");
  await lock(c, "L4g", i.authorizationId, "S");
  await lock(c, "L10", i.draft.draftId);
}

/** D4 ACCEPTED: SUBMITTING -> PROVIDER_ACCEPTED with the reference, the draft too, and the PROVIDER_ACCEPTED activity. */
export function accept(w: B12World, i: Intent, instant: string, ref = `gmail-${i.intentId}`): Promise<void> {
  return at(w.outreach, {}, instant, async (c) => {
    await answerLocks(c, i);
    await c.query("UPDATE kauro.outreach_send_intents SET state = 'PROVIDER_ACCEPTED', provider_message_ref = $2, answered_fence = claim_fence WHERE intent_id = $1", [i.intentId, ref]);
    await c.query("UPDATE kauro.outreach_drafts SET state = 'PROVIDER_ACCEPTED' WHERE draft_id = $1", [i.draft.draftId]);
    await serviceActivity(c, i, "PROVIDER_ACCEPTED", ref, instant);
  });
}

/** D5: SUBMITTING -> SEND_UNCERTAIN, the draft too, and the SEND_UNCERTAIN activity. */
export function uncertain(w: B12World, i: Intent, instant: string): Promise<void> {
  return at(w.outreach, {}, instant, async (c) => {
    await answerLocks(c, i);
    await c.query("UPDATE kauro.outreach_send_intents SET state = 'SEND_UNCERTAIN' WHERE intent_id = $1", [i.intentId]);
    await c.query("UPDATE kauro.outreach_drafts SET state = 'SEND_UNCERTAIN' WHERE draft_id = $1", [i.draft.draftId]);
    await serviceActivity(c, i, "SEND_UNCERTAIN", "NONE", instant);
  });
}

export async function serviceActivity(c: Client, i: Intent, kind: "PROVIDER_ACCEPTED" | "SEND_UNCERTAIN", ref: string, occurredAt: string): Promise<string> {
  const activityId = ids.next();
  await c.query(
    "INSERT INTO kauro.sales_activities (activity_id, prospect_id, intent_id, draft_id, authorization_id, kind, provider_message_ref, evidence_hash, occurred_at, recorded_by_service) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'outreach-service')",
    [activityId, i.draft.prospectId, i.intentId, i.draft.draftId, i.authorizationId, kind, ref, sha(`evidence-${activityId}`), occurredAt],
  );
  return activityId;
}

/** A person's activity row (CMD064; no transaction, no lock). */
export async function personActivity(
  c: Client,
  by: string,
  i: Intent | null,
  prospectId: string,
  kind: "BOUNCED" | "REPLIED" | "SUPPRESSED" | "HUMAN_SEND_OBSERVED" | "PROVIDER_ACCEPTED",
  occurredAt: string,
  extra: { readonly ref?: string; readonly observation?: "SENT" | "NOT_SENT"; readonly keyKind?: "ORGANIZATION" | "CONTACT"; readonly key?: string; readonly reason?: string } = {},
): Promise<string> {
  const activityId = ids.next();
  await c.query(
    `INSERT INTO kauro.sales_activities (activity_id, prospect_id, intent_id, draft_id, authorization_id, kind, observation, suppression_key_kind, suppression_key, suppression_reason, provider_message_ref, evidence_hash, occurred_at, recorded_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [activityId, prospectId, i?.intentId ?? null, i?.draft.draftId ?? null, i?.authorizationId ?? null, kind, extra.observation ?? null, extra.keyKind ?? null, extra.key ?? null, extra.reason ?? null, extra.ref ?? "NONE", sha(`evidence-${activityId}`), occurredAt, by],
  );
  return activityId;
}

/** A suppression row under L8 X of its key (the 0029 statement, ON CONFLICT DO NOTHING as every writer). */
export async function suppressionIn(c: Client, by: string | null, keyKind: "ORGANIZATION" | "CONTACT", key: string, reason = "OPT_OUT", options: { readonly skipLock?: boolean; readonly service?: boolean } = {}): Promise<void> {
  if (options.skipLock !== true) await lock(c, "L8", `${keyKind}:${key}`);
  await c.query(
    "INSERT INTO kauro.prospect_suppressions (suppression_id, key_kind, suppression_key, reason, recorded_by_user_id, recorded_by_service, recorded_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), now()) ON CONFLICT DO NOTHING",
    [ids.next(), keyKind, key, reason, by, options.service === true ? "outreach-service" : null],
  );
}

/** A prospect of `jurisdiction` registered by a seller (registerProspect with the jurisdiction as a parameter). */
export async function prospectIn(w: B12World, by: Seller, domain: string, jurisdiction = "United States", options: { readonly address?: boolean } = {}): Promise<Prospect> {
  const prospectId = ids.next();
  const organizationKey = sha(`organization:${domain}`);
  const contactId = ids.next();
  // the contact's address (RecordProspectContact stores it beside the contact) and its key, which the address must derive (KA095 f)
  const address = `operations@${domain}`;
  const contactKey = sha(`KAURO_PROSPECT_CONTACT_V1
${address}`);
  const evidenceHash = sha(`source-evidence-${prospectId}`);
  await within(w.app, personOf(by.userId), async (c) => {
    await c.query(
      "INSERT INTO kauro.prospect_source_evidence (evidence_id, recorded_by_user_id, seller_id, evidence_hash, source_url_digest, observed_on, lawful_basis, segment, created_at) VALUES ($1, $2, $3, $4, $5, current_date, 'LEGITIMATE_INTEREST', 'AGENCY', now())",
      [ids.next(), by.userId, by.sellerId, evidenceHash, sha(`https://${domain}/`)],
    );
    await c.query("INSERT INTO kauro.prospect_contacts (contact_id, recorded_by_user_id, contact_key, contact_label, role_label, channel, created_at) VALUES ($1, $2, $3, 'Operations lead', 'Head of operations', 'EMAIL', now())", [contactId, by.userId, contactKey]);
    // `address: false` leaves the contact without its address row, for the controls that forge one (KA095 f)
    if (options.address !== false) await c.query("INSERT INTO kauro.prospect_contact_addresses (contact_id, recorded_by_user_id, address) VALUES ($1, $2, $3)", [contactId, by.userId, address]);
    await c.query(
      `INSERT INTO kauro.prospects (prospect_id, organization_label, organization_key, business_contact_id, source_evidence_hash, jurisdiction, registered_by_user_id, registered_by_seller_id, owner_seller_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, now(), now())`,
      [prospectId, `${domain} agency`, organizationKey, contactId, evidenceHash, jurisdiction, by.userId, by.sellerId],
    );
  });
  return { prospectId, organizationKey, contactId, contactKey, evidenceHash, registeredBy: by.userId };
}

let domainSeq = 0;
export const freshDomain = (label: string): string => `${label}-${++domainSeq}-${ids.next().slice(-6)}.example`;

/** A whole first contact of a seller's sender at `instant`: prospect, draft, grant and the QUEUED intent. */
export async function queuedFirst(w: B12World, seller: Seller, snd: Sender, instant: string, options: { readonly prospect?: Prospect } = {}): Promise<Intent> {
  const p = options.prospect ?? (await prospectIn(w, seller, freshDomain("first")));
  const d = await draft(w, snd, p);
  const g = await grant(w, snd, [d], instant);
  return queue(w, d, g.authorizationId, plus(instant, 2));
}

// --- forged writes and guard switches (rules 12, 24c) -----------------------------------------------------------------------------------

export type ClientName = "app" | "outreach" | "oracle";

export interface Forge {
  readonly as: ClientName;
  readonly ctx?: CommerceContext;
  readonly at: string;
  run(c: Client): Promise<unknown>;
}

/** A refusal predicate: the SQLSTATE (and constraint) a forged write must meet. "ZERO_ROWS" is an UPDATE a USING clause hides. */
export interface Expect {
  readonly code: string;
  readonly constraint?: string;
}

export class ZeroRows extends Error {
  readonly code = "ZERO_ROWS";
}

/** Runs a forge in one transaction that is always rolled back (deferred checks fire at SET CONSTRAINTS ALL IMMEDIATE); returns its error. */
export async function attempt(w: B12World, f: Forge): Promise<unknown> {
  const c = f.as === "app" ? w.app : f.as === "outreach" ? w.outreach : w.h.oracle;
  await c.query("BEGIN");
  try {
    await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true), set_config('kauro.finance_agency_id', '', true)", [f.ctx?.agencyId ?? "", f.ctx?.userId ?? ""]);
    await clockAt(c, f.at);
    await f.run(c);
    await c.query("SET CONSTRAINTS ALL IMMEDIATE");
    return undefined;
  } catch (e) {
    return e;
  } finally {
    await c.query("ROLLBACK");
  }
}

export const matches = (e: unknown, x: Expect): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === x.code && (x.constraint === undefined || (e as { constraint?: unknown }).constraint === x.constraint);

export const describeError = (e: unknown): string =>
  e === undefined ? "committed" : `${String((e as { code?: unknown }).code)} ${String((e as { constraint?: unknown }).constraint ?? "")} ${String((e as { message?: unknown }).message ?? e)}`;

/**
 * One guard of the schema (rule 24c): a RAISE of a function named by the head of its message, a constraint, a unique index, or one clause
 * of a policy. Dropping it turns the RAISE into a NOTICE, drops the constraint or index, or sets the clause to true.
 */
export type Guard =
  | { readonly raise: readonly [fn: string, head: string] }
  | { readonly constraint: readonly [table: string, name: string] }
  | { readonly index: string }
  | { readonly policy: readonly [table: string, name: string, clause: "USING" | "WITH CHECK"] };

export const guardKey = (g: Guard): string => JSON.stringify(g);

/** Drops the guards (as the superuser), runs fn, restores every guard exactly. */
export async function withoutGuards<T>(w: B12World, guards: ReadonlyArray<Guard>, fn: () => Promise<T>): Promise<T> {
  const o = w.h.oracle;
  const restore: string[] = [];
  const functions = new Map<string, string>();
  try {
    for (const g of guards) {
      if ("raise" in g) {
        const [fn, head] = g.raise;
        if (!functions.has(fn)) {
          const def = await o.query<{ d: string }>("SELECT pg_get_functiondef($1::regprocedure) AS d", [fn]);
          functions.set(fn, def.rows[0]!.d);
          restore.push(`FN ${fn}`);
        }
        const cur = (await o.query<{ d: string }>("SELECT pg_get_functiondef($1::regprocedure) AS d", [fn])).rows[0]!.d;
        const needle = `RAISE EXCEPTION '${head}`;
        assert.equal(cur.split(needle).length, 2, `${fn} has exactly one "${needle}"`);
        await o.query(cur.replace(needle, `RAISE NOTICE '${head}`));
      } else if ("constraint" in g) {
        const [table, name] = g.constraint;
        const def = await o.query<{ d: string }>("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass", [name, table]);
        assert.equal(def.rowCount, 1, `constraint ${name} of ${table}`);
        await o.query(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`);
        restore.push(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${def.rows[0]!.d}`);
      } else if ("index" in g) {
        const def = await o.query<{ d: string }>("SELECT pg_get_indexdef($1::regclass) AS d", [`kauro.${g.index}`]);
        await o.query(`DROP INDEX kauro.${g.index}`);
        restore.push(def.rows[0]!.d);
      } else {
        const [table, name, clause] = g.policy;
        const pol = await o.query<{ qual: string | null; with_check: string | null }>("SELECT qual, with_check FROM pg_policies WHERE schemaname = 'kauro' AND tablename = $1 AND policyname = $2", [table.replace(/^kauro\./, ""), name]);
        assert.equal(pol.rowCount, 1, `policy ${name} of ${table}`);
        const original = clause === "USING" ? pol.rows[0]!.qual : pol.rows[0]!.with_check;
        assert.ok(original !== null, `policy ${name} has a ${clause} clause`);
        await o.query(`ALTER POLICY ${name} ON ${table} ${clause} (true)`);
        restore.push(`ALTER POLICY ${name} ON ${table} ${clause} (${original})`);
      }
    }
    return await fn();
  } finally {
    for (const r of restore.reverse()) {
      if (r.startsWith("FN ")) await o.query(functions.get(r.slice(3))!);
      else await o.query(r);
    }
  }
}

export { stepUpProof };
