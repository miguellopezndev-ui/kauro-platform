// Migration 0088 (package B12 lane K1; docs/design/B12-outreach-plan.md §0 A1..A17, §L, §W; companion B12-outreach-plan-cells.md §K):
// every rule-12 forged control of §K is refused by its own guard and only by it (rule 24c). Each control is checked three times:
//   1. as written, the forged write is refused with its SQLSTATE (and constraint);
//   2. with its own guard dropped (withoutGuards: the RAISE turned NOTICE, the constraint or index dropped, the policy clause set to true)
//      the same forged write commits — the guard is what refuses it ("red alone with its own guard dropped");
//   3. with every OTHER guard of the table below dropped at once, it is still refused with its SQLSTATE — no other guard is needed
//      ("green with any other one dropped").
// Every forged write runs in a transaction that is rolled back (attempt), so a control never changes what the next one sees; the
// fixtures are written through the production writers' roles and lock subjects (b12-outreach-support.ts). The OK siblings commit.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Client } from "pg";
import {
  DAY,
  accept,
  answerLocks,
  at,
  attempt,
  businessDaysAfter,
  claim,
  claimIn,
  closeB12,
  describeError,
  draft,
  draftRow,
  content,
  freshDomain,
  grant,
  guardKey,
  ids,
  insertGrant,
  lock,
  matches,
  nextSlot,
  openB12,
  ownerOf,
  personActivity,
  personCtx,
  personOf,
  plus,
  prospectIn,
  queue,
  queueIn,
  queuedFirst,
  review,
  sender,
  sha,
  stepUpProof,
  suppressionIn,
  uncertain,
  withoutGuards,
  ZeroRows,
  type B12World,
  type Draft,
  type Expect,
  type Forge,
  type Guard,
  type Intent,
  type Sender,
  type GrantOptions,
} from "./b12-outreach-support.js";
import { activeSeller, type Seller } from "./b10-commission-support.js";

let w: B12World;
let sndS: Sender; // seller one's mailbox
let sndS2: Sender; // seller two's mailbox
let sndOwner: Sender; // the owner's mailbox

before(async () => {
  w = await openB12("b12k1");
  sndS = await sender(w, w.s.userId);
  sndS2 = await sender(w, w.s2.userId);
  sndOwner = await sender(w, w.kora);
});
after(async () => {
  await closeB12(w);
});

// --- guards --------------------------------------------------------------------------------------------------------------------------
const R = (fn: string, head: string): Guard => ({ raise: [fn, head] });
const G = {
  intentBinding: R("kauro.outreach_send_intents_binding()", "OUTREACH_BINDING: intent % is not bound"),
  hashBinding: R("kauro.outreach_authorization_hashes_binding()", "OUTREACH_BINDING: the sealed hash"),
  draftSeller: R("kauro.outreach_drafts_binding()", "OUTREACH_BINDING: the seller sender of draft"),
  draftHash: R("kauro.outreach_drafts_binding()", "OUTREACH_BINDING: the content hash of draft"),
  reviewProof: R("kauro.outreach_reviews_binding()", "OUTREACH_BINDING: review % cites"),
  addressKey: R("kauro.prospect_contact_addresses_binding()", "OUTREACH_BINDING: the address of contact"),
  senderImmutable: R("kauro.sender_identities_binding()", "OUTREACH_BINDING: the address, person and route"),
  intentEdge: R("kauro.outreach_send_intents_edge()", "SEND_FENCE: intent edge"),
  acceptedRef: R("kauro.outreach_send_intents_edge()", "SEND_FENCE: % -> PROVIDER_ACCEPTED names"),
  answerFence: R("kauro.outreach_send_intents_edge()", "SEND_FENCE: an answer of fence"),
  claimColumns: R("kauro.outreach_send_intents_columns()", "SEND_FENCE: the claim columns"),
  draftEdge: R("kauro.outreach_drafts_edge()", "SEND_FENCE: draft edge"),
  lockHeld: R("kauro.outreach_require_lock(text,text,text,text)", "LOCK_NOT_HELD: % requires"),
  acceptedOnce: { index: "sales_activities_one_accepted_per_intent" } as Guard,
  observedOnce: { index: "sales_activities_one_observation_per_intent" } as Guard,
  replyOnce: { index: "sales_activities_one_reply_per_inbound" } as Guard,
  suppressedOnce: { index: "sales_activities_one_suppression_per_reason" } as Guard,
  warningOnce: { constraint: ["kauro.outreach_provider_warnings", "outreach_provider_warnings_one_per_intent"] } as Guard,
  evidenceOnce: { constraint: ["kauro.outreach_send_evidence", "outreach_send_evidence_one_per_fence"] } as Guard,
  activityRef: R("kauro.sales_activities_facts()", "ACTIVITY_EVIDENCE: % names its provider message"),
  activityService: R("kauro.sales_activities_facts()", "ACTIVITY_EVIDENCE: % is recorded by the outreach service"),
  activityFuture: R("kauro.sales_activities_facts()", "ACTIVITY_EVIDENCE: an activity cannot occur"),
  activityInbound: R("kauro.sales_activities_facts()", "ACTIVITY_EVIDENCE: a reply names an inbound"),
  ka098W: R("kauro.prospects_suppression_columns()", "OUTREACH_SUPPRESSION_SCOPE: a non-owner"),
  ka098R: R("kauro.prospects_suppression_reached()", "OUTREACH_SUPPRESSION_SCOPE: prospect % is suppressed only"),
  suppressCheck: { policy: ["kauro.prospects", "prospects_seller_suppress", "WITH CHECK"] } as Guard,
  suppressUsing: { policy: ["kauro.prospects", "prospects_seller_suppress", "USING"] } as Guard,
  resendRoute: R("kauro.outreach_send_intents_counts()", "OUTREACH_ROUTE_FORBIDDEN: no outreach intent"),
  noPolicy: R("kauro.outreach_send_intents_counts()", "OUTREACH_ROUTE_FORBIDDEN: no channel policy"),
  unverified: R("kauro.outreach_send_intents_counts()", "SENDER_NOT_VERIFIED:"),
  noGrant: R("kauro.outreach_send_intents_counts()", "OUTREACH_GRANT_INVALID: no grant row"),
  intentGrantFk: { constraint: ["kauro.outreach_send_intents", "outreach_send_intents_authorization_id_fkey"] } as Guard,
  revoked: R("kauro.outreach_send_intents_counts()", "OUTREACH_GRANT_INVALID: grant % is revoked"),
  notYetValid: R("kauro.outreach_send_intents_counts()", "OUTREACH_GRANT_INVALID: grant % is not yet valid"),
  expired: R("kauro.outreach_send_intents_counts()", "OUTREACH_GRANT_INVALID: grant % expired"),
  unsealed: R("kauro.outreach_send_intents_counts()", "OUTREACH_GRANT_INVALID: the draft''s hash is not sealed"),
  reserved: R("kauro.outreach_send_intents_counts()", "OUTREACH_GRANT_INVALID: grant % has reserved"),
  superseded: R("kauro.outreach_send_intents_counts()", "RESOURCE_NOT_CURRENT: draft % cites"),
  notOffered: R("kauro.outreach_send_intents_counts()", "RESOURCE_NOT_CURRENT: draft % claims"),
  paused: R("kauro.outreach_send_intents_counts()", "OUTREACH_PAUSED:"),
  draftNotDraft: R("kauro.outreach_send_intents_counts()", "OUTREACH_ALREADY_SENT: draft % is %"),
  openUncertain: R("kauro.outreach_send_intents_counts()", "SEND_UNCERTAIN_UNRESOLVED:"),
  acceptedEarlier: R("kauro.outreach_send_intents_counts()", "OUTREACH_ALREADY_SENT: an earlier intent"),
  stopFact: R("kauro.outreach_send_intents_counts()", "OUTREACH_CAP_REACHED: CADENCE_CLOSED, a stop fact"),
  noCalendar: R("kauro.outreach_send_intents_counts()", "OUTREACH_CALENDAR_UNAVAILABLE: no calendar row"),
  outsideDay: R("kauro.outreach_send_intents_counts()", "OUTREACH_CAP_REACHED: OUTSIDE_BUSINESS_DAY"),
  personCap: R("kauro.outreach_send_intents_counts()", "OUTREACH_CAP_REACHED: CAP_REACHED"),
  activeSequence: R("kauro.outreach_send_intents_counts()", "OUTREACH_CAP_REACHED: CADENCE_CLOSED, prospect % has an active"),
  ninetyDays: R("kauro.outreach_send_intents_counts()", "OUTREACH_CAP_REACHED: CADENCE_CLOSED, a new sequence"),
  firstNotSent: R("kauro.outreach_send_intents_counts()", "OUTREACH_CAP_REACHED: FIRST_NOT_SENT"),
  oneFollowUp: R("kauro.outreach_send_intents_counts()", "OUTREACH_CAP_REACHED: CADENCE_CLOSED, the sequence has"),
  followUpEarly: R("kauro.outreach_send_intents_counts()", "OUTREACH_CAP_REACHED: CADENCE_CLOSED, the follow-up opens"),
  followUpClosed: R("kauro.outreach_send_intents_counts()", "OUTREACH_CAP_REACHED: CADENCE_CLOSED, the follow-up window closed"),
  reviewOnce: { constraint: ["kauro.outreach_authorizations", "outreach_authorizations_one_per_review"] } as Guard,
  reviewExpired: R("kauro.outreach_authorizations_birth()", "OUTREACH_REVIEW_INVALID: review % expired"),
  reviewProofOther: R("kauro.outreach_authorizations_birth()", "OUTREACH_REVIEW_INVALID: review % was issued"),
  reviewMoved: R("kauro.outreach_authorizations_birth()", "OUTREACH_REVIEW_INVALID: a draft of review"),
  noReview: R("kauro.outreach_authorizations_birth()", "OUTREACH_REVIEW_INVALID: no review row"),
  grantReviewFk: { constraint: ["kauro.outreach_authorizations", "outreach_authorizations_review_id_fkey"] } as Guard,
  notReviewed: R("kauro.outreach_authorization_hashes_binding()", "OUTREACH_REVIEW_INVALID: draft % was not reviewed"),
  observedAccepted: R("kauro.outreach_send_intents_observed()", "OUTREACH_ALREADY_SENT: intent % was accepted"),
  recorderXor: { constraint: ["kauro.prospect_suppressions", "prospect_suppressions_one_recorder"] } as Guard,
};

interface Control {
  readonly id: string;
  readonly title: string;
  readonly expect: Expect;
  readonly guards: ReadonlyArray<Guard>;
  forge(): Promise<Forge>;
}
const controls: Control[] = [];
const control = (id: string, title: string, expect: Expect, guards: Guard | ReadonlyArray<Guard>, forge: () => Promise<Forge>): void => {
  controls.push({ id, title, expect, guards: Array.isArray(guards) ? guards : [guards as Guard], forge });
};
const as = (userId: string) => personCtx(w, userId);
const zero = async (r: Promise<{ rowCount: number | null }>): Promise<void> => {
  if ((await r).rowCount === 0) throw new ZeroRows("the UPDATE matched no row");
};

/** A fresh first-contact draft of seller one, sealed by a grant at `instant`. */
async function sealedDraft(instant: string, options: { readonly snd?: Sender; readonly seller?: Seller; readonly purpose?: Draft["purpose"]; readonly jurisdiction?: string; readonly grant?: GrantOptions } = {}): Promise<{ d: Draft; g: string }> {
  const seller = options.seller ?? w.s;
  const p = await prospectIn(w, seller, freshDomain("sealed"), options.jurisdiction);
  const d = await draft(w, options.snd ?? sndS, p, options.purpose);
  const g = await grant(w, options.snd ?? sndS, [d], instant, options.grant);
  return { d, g: g.authorizationId };
}
const queueForge = (d: Draft, g: string, instant: string, options: Parameters<typeof queueIn>[3] = {}): Forge => ({ as: "app", ctx: as(d.personUserId), at: instant, run: (c) => queueIn(c, d, g, options) });

/** An intent walked to `state` by the production writers (each its own prospect, at its own slot). */
async function intentIn(state: "QUEUED" | "SUBMITTING" | "PROVIDER_ACCEPTED" | "SEND_UNCERTAIN" | "NOT_SENT" | "OBSERVED_NOT_SENT" | "OBSERVED_SENT", seller: Seller = w.s, snd: Sender = sndS): Promise<{ i: Intent; slot: string }> {
  const slot = await nextSlot(w);
  const i = await queuedFirst(w, seller, snd, slot);
  if (state === "QUEUED") return { i, slot };
  if (state === "NOT_SENT") {
    await at(w.outreach, {}, plus(slot, 10), async (c) => {
      await answerLocks(c, i);
      await c.query("UPDATE kauro.outreach_send_intents SET state = 'NOT_SENT', outcome_reason = 'SUPPRESSED' WHERE intent_id = $1", [i.intentId]);
      await c.query("UPDATE kauro.outreach_drafts SET state = 'CANCELLED' WHERE draft_id = $1", [i.draft.draftId]);
    });
    return { i, slot };
  }
  await claim(w, i, plus(slot, 10));
  if (state === "SUBMITTING") return { i, slot };
  if (state === "PROVIDER_ACCEPTED") {
    await accept(w, i, plus(slot, 15));
    return { i, slot };
  }
  await uncertain(w, i, plus(slot, 60));
  if (state === "SEND_UNCERTAIN") return { i, slot };
  await at(w.app, as(i.draft.personUserId), plus(slot, 120), async (c) => {
    await lock(c, "L3", i.draft.prospectId, "S");
    if (state === "OBSERVED_NOT_SENT") {
      await lock(c, "L4", i.draft.personUserId, "S");
      await lock(c, "L4g", i.authorizationId, "S");
    }
    await lock(c, "L10", i.draft.draftId);
    await c.query("UPDATE kauro.outreach_send_intents SET state = $2 WHERE intent_id = $1", [i.intentId, state]);
    await personActivity(c, i.draft.personUserId, i, i.draft.prospectId, "HUMAN_SEND_OBSERVED", plus(slot, 120), { observation: state === "OBSERVED_SENT" ? "SENT" : "NOT_SENT" });
    if (state === "OBSERVED_NOT_SENT") await c.query("UPDATE kauro.outreach_drafts SET state = 'DRAFT' WHERE draft_id = $1", [i.draft.draftId]);
    else await c.query("UPDATE kauro.outreach_drafts SET state = 'PROVIDER_ACCEPTED' WHERE draft_id = $1", [i.draft.draftId]);
  });
  return { i, slot };
}
const intentUpdate = (i: Intent, instant: string, sql: string, params: ReadonlyArray<unknown> = []): Forge => ({
  as: "outreach",
  at: instant,
  run: async (c) => {
    for (const [name, subject] of [["L3", i.draft.prospectId], ["L4", i.draft.personUserId], ["L4g", i.authorizationId], ["L10", i.draft.draftId]] as const) await lock(c, name, subject);
    await c.query(sql, [i.intentId, ...params]);
  },
});

// --- KA095 OUTREACH_BINDING -----------------------------------------------------------------------------------------------------------
control("KA095 (a)", "an intent whose sender is not its draft's sender", { code: "KA095" }, G.intentBinding, async () => {
  const slot = await nextSlot(w);
  const { d, g } = await sealedDraft(slot);
  return queueForge(d, g, plus(slot, 5), { senderId: sndS2.senderId });
});
control("KA095 (b)", "a sealed hash of a draft of another sender than the grant's", { code: "KA095" }, G.hashBinding, async () => {
  const slot = await nextSlot(w);
  const p1 = await prospectIn(w, w.s, freshDomain("ka095b"));
  const p2 = await prospectIn(w, w.s2, freshDomain("ka095b"));
  const mine = await draft(w, sndS, p1);
  const theirs = await draft(w, sndS2, p2);
  const rv = await review(w, sndS, [mine, theirs], slot);
  return { as: "app", ctx: ownerOf(w), at: plus(slot, 1), run: (c) => insertGrant(c, w, sndS, rv, [mine, theirs], plus(slot, 1), { maximumSends: 1 }) };
});
control("KA095 (c)", "a seller sender's draft on a prospect not assigned to that seller", { code: "KA095" }, G.draftSeller, async () => {
  const p = await prospectIn(w, w.s2, freshDomain("ka095c"));
  const cref = await content(w, w.s.userId, `ka095c-${p.prospectId}`);
  const row = draftRow(w, sndS, p, "INDIVIDUAL_PROSPECT_CONTACT", cref);
  return { as: "app", ctx: personOf(w.s.userId), at: w.base, run: (c) => c.query(row.sql, row.params) };
});
control("KA095 (d)", "a draft whose content hash is not its recipient/sender/purpose/body binding", { code: "KA095" }, G.draftHash, async () => {
  const p = await prospectIn(w, w.s, freshDomain("ka095d"));
  const cref = await content(w, w.s.userId, `ka095d-${p.prospectId}`);
  const row = draftRow(w, sndS, p, "INDIVIDUAL_PROSPECT_CONTACT", cref);
  const params = [...row.params];
  params[7] = sha(`not-the-binding-${row.draftId}`);
  return { as: "app", ctx: personOf(w.s.userId), at: w.base, run: (c) => c.query(row.sql, params) };
});
control("KA095 (e)", "a review citing the step-up proof of another person", { code: "KA095" }, G.reviewProof, async () => {
  const proofOfSeller = await stepUpProof(w.assurance, { userId: w.s.userId });
  const reviewId = ids.next();
  return {
    as: "app",
    ctx: ownerOf(w),
    at: w.base,
    run: (c) => c.query("INSERT INTO kauro.outreach_reviews (review_id, owner_user_id, proof_id, sender_id, digest, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, now(), now() + interval '15 minutes')", [reviewId, w.kora, proofOfSeller, sndS.senderId, sha(reviewId)]),
  };
});
control("KA095 (f)", "a contact address whose digest is not the contact's key", { code: "KA095" }, G.addressKey, async () => {
  const p = await prospectIn(w, w.s, freshDomain("ka095f"));
  return { as: "app", ctx: personOf(w.s.userId), at: w.base, run: (c) => c.query("INSERT INTO kauro.prospect_contact_addresses (contact_id, recorded_by_user_id, address) VALUES ($1, $2, 'someone.else@company.example')", [p.contactId, w.s.userId]) };
});
control("KA095 (g)", "a sender's address changed (the table's own refusal: no role holds the column grant)", { code: "KA095" }, G.senderImmutable, async () => {
  const snd = await sender(w, w.s.userId);
  return {
    as: "oracle",
    at: w.base,
    run: async (c) => {
      await lock(c, "L7", snd.senderId);
      await c.query("UPDATE kauro.sender_identities SET address = 'moved@mail.example' WHERE sender_id = $1", [snd.senderId]);
    },
  };
});

// --- KA096 SEND_FENCE: intent edges and claim columns -------------------------------------------------------------------------------
control("KA096 (a)", "SEND_UNCERTAIN -> SUBMITTING", { code: "KA096" }, G.intentEdge, async () => {
  const { i, slot } = await intentIn("SEND_UNCERTAIN");
  return intentUpdate(i, plus(slot, 200), "UPDATE kauro.outreach_send_intents SET state = 'SUBMITTING' WHERE intent_id = $1");
});
control("KA096 (b)", "SUBMITTING -> QUEUED", { code: "KA096" }, G.intentEdge, async () => {
  const { i, slot } = await intentIn("SUBMITTING");
  return intentUpdate(i, plus(slot, 20), "UPDATE kauro.outreach_send_intents SET state = 'QUEUED' WHERE intent_id = $1");
});
control("KA096 (c)", "SUBMITTING -> SUBMITTING with a second claim (a re-claim moves the claim columns without the edge)", { code: "KA096" }, G.claimColumns, async () => {
  const { i, slot } = await intentIn("SUBMITTING");
  return intentUpdate(i, plus(slot, 20), "UPDATE kauro.outreach_send_intents SET state = 'SUBMITTING', submitted_at = submitted_at + interval '1 second' WHERE intent_id = $1");
});
control("KA096 (d)", "NOT_SENT -> QUEUED", { code: "KA096" }, G.intentEdge, async () => {
  const { i, slot } = await intentIn("NOT_SENT");
  return intentUpdate(i, plus(slot, 20), "UPDATE kauro.outreach_send_intents SET state = 'QUEUED' WHERE intent_id = $1");
});
control("KA096 (e)", "OBSERVED_NOT_SENT -> SEND_UNCERTAIN (terminal)", { code: "KA096" }, G.intentEdge, async () => {
  const { i, slot } = await intentIn("OBSERVED_NOT_SENT");
  return intentUpdate(i, plus(slot, 200), "UPDATE kauro.outreach_send_intents SET state = 'SEND_UNCERTAIN' WHERE intent_id = $1");
});
control("KA096 (f)", "counted_at changed outside the claim edge", { code: "KA096" }, G.claimColumns, async () => {
  const { i, slot } = await intentIn("SUBMITTING");
  return intentUpdate(i, plus(slot, 20), "UPDATE kauro.outreach_send_intents SET counted_at = counted_at - interval '1 day' WHERE intent_id = $1");
});
control("KA096 (g)", "claim_fence changed without the claim edge", { code: "KA096" }, G.claimColumns, async () => {
  const { i, slot } = await intentIn("SUBMITTING");
  return intentUpdate(i, plus(slot, 20), "UPDATE kauro.outreach_send_intents SET claim_fence = claim_fence + 1 WHERE intent_id = $1");
});
control("KA096 (h)", "SEND_UNCERTAIN -> PROVIDER_ACCEPTED without a provider reference", { code: "KA096" }, G.acceptedRef, async () => {
  const { i, slot } = await intentIn("SEND_UNCERTAIN");
  return intentUpdate(i, plus(slot, 200), "UPDATE kauro.outreach_send_intents SET state = 'PROVIDER_ACCEPTED', answered_fence = claim_fence WHERE intent_id = $1");
});
control("KA096 (i)", "SUBMITTING -> PROVIDER_ACCEPTED answered by another fence with no ACCEPTED evidence row of it", { code: "KA096" }, G.answerFence, async () => {
  const { i, slot } = await intentIn("SUBMITTING");
  return intentUpdate(i, plus(slot, 20), "UPDATE kauro.outreach_send_intents SET state = 'PROVIDER_ACCEPTED', provider_message_ref = 'gmail-late', answered_fence = claim_fence + 1 WHERE intent_id = $1");
});

// --- KA096 SEND_FENCE: draft edges (plan A2b) ----------------------------------------------------------------------------------------
const draftEdge = (id: string, from: Parameters<typeof intentIn>[0] | "DRAFT" | "AUTHORIZED_ALONE", to: string): void =>
  control(id, `draft ${from === "AUTHORIZED_ALONE" ? "AUTHORIZED" : from} -> ${to} is not listed`, { code: "KA096" }, G.draftEdge, async () => {
    let d: Draft;
    let instant: string;
    if (from === "DRAFT" || from === "AUTHORIZED_ALONE") {
      instant = await nextSlot(w);
      d = await draft(w, sndS, await prospectIn(w, w.s, freshDomain("edge")));
      if (from === "AUTHORIZED_ALONE")
        await at(w.app, ownerOf(w), instant, async (c) => {
          await lock(c, "L10", d.draftId);
          await c.query("UPDATE kauro.outreach_drafts SET state = 'AUTHORIZED' WHERE draft_id = $1", [d.draftId]);
        });
    } else {
      const r = await intentIn(from);
      d = r.i.draft;
      instant = plus(r.slot, 300);
    }
    return {
      as: "app",
      ctx: ownerOf(w),
      at: instant,
      run: async (c) => {
        await lock(c, "L10", d.draftId);
        await c.query("UPDATE kauro.outreach_drafts SET state = $2 WHERE draft_id = $1", [d.draftId, to]);
      },
    };
  });
draftEdge("KA096 draft (a)", "DRAFT", "SUBMITTING");
draftEdge("KA096 draft (b)", "DRAFT", "CANCELLED");
draftEdge("KA096 draft (c)", "AUTHORIZED_ALONE", "BOUNCED");
draftEdge("KA096 draft (d)", "SUBMITTING", "REPLIED");
draftEdge("KA096 draft (e)", "PROVIDER_ACCEPTED", "DRAFT");
draftEdge("KA096 draft (f)", "SEND_UNCERTAIN", "DRAFT");
draftEdge("KA096 draft (g)", "NOT_SENT", "DRAFT");
draftEdge("KA096 draft (h)", "PROVIDER_ACCEPTED", "CANCELLED");

// --- KA096 LOCK_NOT_HELD (plan §L T2 table; every other subject held) --------------------------------------------------------------
control("KA096 (j)", "an intent INSERT with L4 not held", { code: "KA096" }, G.lockHeld, async () => {
  const slot = await nextSlot(w);
  const { d, g } = await sealedDraft(slot);
  return queueForge(d, g, plus(slot, 5), { skip: "L4" });
});
control("KA096 (k)", "QUEUED -> SUBMITTING with L4g not held", { code: "KA096" }, G.lockHeld, async () => {
  const { i, slot } = await intentIn("QUEUED");
  return { as: "outreach", at: plus(slot, 10), run: (c) => claimIn(c, i, { skip: "L4g" }) };
});
control("KA096 (l)", "a channel policy WITHDRAWN with L6p not held", { code: "KA096" }, G.lockHeld, async () => ({
  as: "app",
  ctx: ownerOf(w),
  at: w.base,
  run: (c) => c.query("UPDATE kauro.outreach_channel_policies SET state = 'WITHDRAWN', withdrawn_by_user_id = $1 WHERE jurisdiction = 'US' AND purpose = 'FOLLOW_UP' AND version = 1", [w.kora]),
}));
control("KA096 (m)", "a COMPLAINT activity INSERT without L4 X", { code: "KA096" }, G.lockHeld, async () => {
  const { i, slot } = await intentIn("PROVIDER_ACCEPTED");
  return {
    as: "app",
    ctx: personOf(w.s.userId),
    at: plus(slot, 300),
    run: async (c) => {
      await lock(c, "L8", `CONTACT:${i.draft.contactKey}`);
      await lock(c, "L10", i.draft.draftId);
      await personActivity(c, w.s.userId, i, i.draft.prospectId, "SUPPRESSED", plus(slot, 300), { keyKind: "CONTACT", key: i.draft.contactKey, reason: "COMPLAINT" });
    },
  };
});
control("KA096 (o)", "a draft edge without L10 X", { code: "KA096" }, G.lockHeld, async () => {
  const d = await draft(w, sndS, await prospectIn(w, w.s, freshDomain("ka096o")));
  return { as: "app", ctx: ownerOf(w), at: w.base, run: (c) => c.query("UPDATE kauro.outreach_drafts SET state = 'AUTHORIZED' WHERE draft_id = $1", [d.draftId]) };
});
control("KA096 (p)", "a suppression INSERT without L8 X", { code: "KA096" }, G.lockHeld, async () => {
  const p = await prospectIn(w, w.s, freshDomain("ka096p"));
  return { as: "app", ctx: personOf(w.s.userId), at: w.base, run: (c) => suppressionIn(c, w.s.userId, "CONTACT", p.contactKey, "REFUSAL", { skipLock: true }) };
});
control("KA096 (q)", "a sender state UPDATE without L7 X", { code: "KA096" }, G.lockHeld, async () => {
  const snd = await sender(w, w.s.userId, { pending: true });
  return { as: "app", ctx: ownerOf(w), at: w.base, run: (c) => c.query("UPDATE kauro.sender_identities SET state = 'VERIFIED', verification_evidence_hash = $2 WHERE sender_id = $1", [snd.senderId, sha("v")]) };
});
control("KA096 (r)", "a resource SUPERSEDED without L6 X", { code: "KA096" }, G.lockHeld, async () => {
  const family = ids.next();
  const r1 = await publishResource(family, 1);
  const cref = await content(w, w.kora, `resource-${family}-2`);
  return {
    as: "app",
    ctx: ownerOf(w),
    at: w.base,
    run: async (c) => {
      await c.query("INSERT INTO kauro.sales_resources (resource_id, family_id, version, content_id, published_by_user_id) VALUES ($1, $2, 2, $3, $4)", [ids.next(), family, cref, w.kora]);
      await c.query("UPDATE kauro.sales_resources SET state = 'SUPERSEDED' WHERE resource_id = $1", [r1]);
    },
  };
});

async function publishResource(family: string, version: number, capabilityIds: ReadonlyArray<string> = []): Promise<string> {
  const resourceId = ids.next();
  const cref = await content(w, w.kora, `resource-${family}-${version}`);
  await at(w.app, ownerOf(w), w.base, async (c) => {
    await lock(c, "L6", family);
    await c.query("INSERT INTO kauro.sales_resources (resource_id, family_id, version, content_id, published_by_user_id) VALUES ($1, $2, $3, $4, $5)", [resourceId, family, version, cref, w.kora]);
    for (const cap of capabilityIds) await c.query("INSERT INTO kauro.sales_resource_capabilities (resource_id, capability_id) VALUES ($1, $2)", [resourceId, cap]);
    if (version > 1) await c.query("UPDATE kauro.sales_resources SET state = 'SUPERSEDED' WHERE family_id = $1 AND version = $2", [family, version - 1]);
  });
  return resourceId;
}

// --- KA097 ACTIVITY_EVIDENCE --------------------------------------------------------------------------------------------------------
control("KA097 (a)", "a second PROVIDER_ACCEPTED of an intent", { code: "23505", constraint: "sales_activities_one_accepted_per_intent" }, G.acceptedOnce, async () => {
  const { i, slot } = await intentIn("PROVIDER_ACCEPTED");
  return {
    as: "outreach",
    at: plus(slot, 300),
    run: async (c) => {
      await lock(c, "L10", i.draft.draftId);
      await c.query(
        "INSERT INTO kauro.sales_activities (activity_id, prospect_id, intent_id, draft_id, authorization_id, kind, provider_message_ref, evidence_hash, occurred_at, recorded_by_service) VALUES ($1, $2, $3, $4, $5, 'PROVIDER_ACCEPTED', 'gmail-again', $6, $7, 'outreach-service')",
        [ids.next(), i.draft.prospectId, i.intentId, i.draft.draftId, i.authorizationId, sha("again"), plus(slot, 300)],
      );
    },
  };
});
control("KA097 (b)", "a second HUMAN_SEND_OBSERVED of an intent", { code: "23505", constraint: "sales_activities_one_observation_per_intent" }, G.observedOnce, async () => {
  const { i, slot } = await intentIn("OBSERVED_SENT");
  return {
    as: "app",
    ctx: personOf(w.s.userId),
    at: plus(slot, 300),
    run: async (c) => {
      await lock(c, "L10", i.draft.draftId);
      await personActivity(c, w.s.userId, i, i.draft.prospectId, "HUMAN_SEND_OBSERVED", plus(slot, 300), { observation: "SENT" });
    },
  };
});
async function replied(i: Intent, instant: string, ref: string): Promise<string> {
  return at(w.app, personOf(i.draft.personUserId), instant, async (c) => {
    await lock(c, "L3", i.draft.prospectId);
    await lock(c, "L10", i.draft.draftId);
    const id = await personActivity(c, i.draft.personUserId, i, i.draft.prospectId, "REPLIED", instant, { ref });
    const state = await c.query<{ state: string }>("SELECT state FROM kauro.outreach_drafts WHERE draft_id = $1", [i.draft.draftId]);
    if (state.rows[0]?.state === "PROVIDER_ACCEPTED") await c.query("UPDATE kauro.outreach_drafts SET state = 'REPLIED' WHERE draft_id = $1", [i.draft.draftId]);
    return id;
  });
}
const replyForge = (i: Intent, instant: string, ref: string, kind: "REPLIED" | "BOUNCED" = "REPLIED"): Forge => ({
  as: "app",
  ctx: personOf(i.draft.personUserId),
  at: instant,
  run: async (c) => {
    await lock(c, "L3", i.draft.prospectId);
    if (kind === "BOUNCED") await lock(c, "L4", i.draft.personUserId);
    await lock(c, "L10", i.draft.draftId);
    await personActivity(c, i.draft.personUserId, i, i.draft.prospectId, kind, instant, { ref });
  },
});
control("KA097 (c)", "a second REPLIED of one inbound reference", { code: "23505", constraint: "sales_activities_one_reply_per_inbound" }, G.replyOnce, async () => {
  const { i, slot } = await intentIn("PROVIDER_ACCEPTED");
  const ref = `inbound-${i.intentId}`;
  await replied(i, plus(slot, 300), ref);
  return replyForge(i, plus(slot, 400), ref);
});
control("KA097 (d)", "a REPLIED with the reference NONE", { code: "KA097" }, G.activityRef, async () => {
  const { i, slot } = await intentIn("PROVIDER_ACCEPTED");
  return replyForge(i, plus(slot, 300), "NONE");
});
control("KA097 (e)", "a BOUNCED with the reference NONE", { code: "KA097" }, G.activityRef, async () => {
  const { i, slot } = await intentIn("PROVIDER_ACCEPTED");
  return replyForge(i, plus(slot, 300), "NONE", "BOUNCED");
});
control("KA097 (f)", "a second SUPPRESSED of one (prospect, key kind, key, reason)", { code: "23505", constraint: "sales_activities_one_suppression_per_reason" }, G.suppressedOnce, async () => {
  const p = await prospectIn(w, w.s, freshDomain("ka097f"));
  const write = async (c: Client) => {
    await lock(c, "L8", `CONTACT:${p.contactKey}`);
    await personActivity(c, w.s.userId, null, p.prospectId, "SUPPRESSED", w.base, { keyKind: "CONTACT", key: p.contactKey, reason: "REFUSAL" });
  };
  await at(w.app, personOf(w.s.userId), w.base, write);
  return { as: "app", ctx: personOf(w.s.userId), at: plus(w.base, 5), run: write };
});
control("KA097 (g)", "a PROVIDER_ACCEPTED recorded by a person (the table's own refusal, past the policy)", { code: "KA097" }, G.activityService, async () => {
  const { i, slot } = await intentIn("SUBMITTING");
  return {
    as: "oracle",
    at: plus(slot, 30),
    run: async (c) => {
      await lock(c, "L10", i.draft.draftId);
      await personActivity(c, w.s.userId, i, i.draft.prospectId, "PROVIDER_ACCEPTED", plus(slot, 30), { ref: "gmail-person" });
    },
  };
});
control("KA097 (h)", "an activity whose occurredAt is after the database's instant", { code: "KA097" }, G.activityFuture, async () => {
  const { i, slot } = await intentIn("PROVIDER_ACCEPTED");
  const f = replyForge(i, plus(slot, 300), `inbound-future-${i.intentId}`);
  return {
    ...f,
    run: async (c) => {
      await lock(c, "L3", i.draft.prospectId);
      await lock(c, "L10", i.draft.draftId);
      await personActivity(c, w.s.userId, i, i.draft.prospectId, "REPLIED", plus(slot, 300 + DAY), { ref: `inbound-future-${i.intentId}` });
    },
  };
});
control("KA097 (i)", "a REPLIED whose reference is an outbound message's", { code: "KA097" }, G.activityInbound, async () => {
  const { i, slot } = await intentIn("PROVIDER_ACCEPTED");
  return replyForge(i, plus(slot, 300), `gmail-${i.intentId}`);
});
control("KA097 (j)", "a second provider warning of an intent", { code: "23505", constraint: "outreach_provider_warnings_one_per_intent" }, G.warningOnce, async () => {
  const health = await activeSeller(w, `ka097j-${ids.next().slice(-6)}`);
  const snd = await sender(w, health.userId);
  const { i, slot } = await intentIn("SUBMITTING", health, snd);
  const write = async (c: Client) => {
    await lock(c, "L4", i.draft.personUserId);
    await lock(c, "L10", i.draft.draftId);
    await c.query("INSERT INTO kauro.outreach_provider_warnings (warning_id, intent_id, person_user_id, status, recorded_by_service, recorded_at) VALUES ($1, $2, $3, 429, 'outreach-service', now())", [ids.next(), i.intentId, i.draft.personUserId]);
  };
  await at(w.outreach, {}, plus(slot, 20), write);
  return { as: "outreach", at: plus(slot, 30), run: write };
});
control("KA097 (k)", "a second evidence row of one (intent, fence)", { code: "23505", constraint: "outreach_send_evidence_one_per_fence" }, G.evidenceOnce, async () => {
  const { i, slot } = await intentIn("SUBMITTING");
  const write = async (c: Client) => {
    await lock(c, "L10", i.draft.draftId);
    await c.query("INSERT INTO kauro.outreach_send_evidence (evidence_id, intent_id, fence, status, provider_ref, recorded_by_service, received_at) VALUES ($1, $2, 1, 'UNKNOWN', 'NONE', 'outreach-service', now())", [ids.next(), i.intentId]);
  };
  await at(w.outreach, {}, plus(slot, 20), write);
  return { as: "outreach", at: plus(slot, 30), run: write };
});

// --- KA098 OUTREACH_SUPPRESSION_SCOPE (rev 4, ADV-40: one guard each) ---------------------------------------------------------------
const sellerUpdate = (seller: Seller, instant: string, sql: string, params: ReadonlyArray<unknown>, zeroRows = false): Forge => ({
  as: "app",
  ctx: personOf(seller.userId),
  at: instant,
  run: async (c) => {
    const r = c.query(sql, [...params]);
    if (zeroRows) await zero(r);
    else await r;
  },
});
async function contactSuppressed(by: Seller, contactKey: string): Promise<void> {
  await at(w.app, personOf(by.userId), w.base, (c) => suppressionIn(c, by.userId, "CONTACT", contactKey, "REFUSAL"));
}
control("KA098 (a)", "own prospect to SUPPRESSED that also reassigns owner_seller_id (a reaching suppression exists)", { code: "KA098" }, G.ka098W, async () => {
  const p = await prospectIn(w, w.s, freshDomain("ka098a"));
  await contactSuppressed(w.s, p.contactKey);
  return sellerUpdate(w.s, w.base, "UPDATE kauro.prospects SET state = 'SUPPRESSED', suppressed = true, version = version + 1, owner_seller_id = $2 WHERE prospect_id = $1", [p.prospectId, w.s2.sellerId]);
});
control("KA098 (b)", "own prospect to QUALIFIED (not the suppression state)", { code: "42501" }, G.suppressCheck, async () => {
  const p = await prospectIn(w, w.s, freshDomain("ka098b"));
  return sellerUpdate(w.s, w.base, "UPDATE kauro.prospects SET state = 'QUALIFIED', version = version + 1 WHERE prospect_id = $1", [p.prospectId]);
});
control("KA098 (c)", "own prospect to SUPPRESSED with no suppression reaching it", { code: "KA098" }, G.ka098R, async () => {
  const p = await prospectIn(w, w.s, freshDomain("ka098c"));
  return sellerUpdate(w.s, w.base, "UPDATE kauro.prospects SET state = 'SUPPRESSED', suppressed = true, version = version + 1 WHERE prospect_id = $1", [p.prospectId]);
});
control("KA098 (d)", "a prospect the seller registered but another seller owns, to SUPPRESSED (a reaching suppression exists): no row", { code: "ZERO_ROWS" }, G.suppressUsing, async () => {
  const p = await prospectIn(w, w.s, freshDomain("ka098d"));
  await contactSuppressed(w.s, p.contactKey);
  await within(w, ownerOf(w), (c) => c.query("UPDATE kauro.prospects SET owner_seller_id = $2, version = version + 1 WHERE prospect_id = $1", [p.prospectId, w.s2.sellerId]));
  return sellerUpdate(w.s, w.base, "UPDATE kauro.prospects SET state = 'SUPPRESSED', suppressed = true, version = version + 1 WHERE prospect_id = $1", [p.prospectId], true);
});
async function within<T>(world: B12World, ctx: ReturnType<typeof ownerOf>, fn: (c: Client) => Promise<T>): Promise<T> {
  return at(world.app, ctx, world.base, fn);
}

// --- KC028..KC037 ------------------------------------------------------------------------------------------------------------------------
control("KC028", "an intent on the RESEND_TRANSACTIONAL route", { code: "KC028" }, G.resendRoute, async () => {
  const slot = await nextSlot(w);
  const resend = await sender(w, w.s.userId, { route: "RESEND_TRANSACTIONAL" });
  const { d, g } = await sealedDraft(slot, { snd: resend });
  return queueForge(d, g, plus(slot, 5));
});
control("KC028 no policy row", "an intent for a jurisdiction with no channel policy", { code: "KC028" }, G.noPolicy, async () => {
  const slot = await nextSlot(w);
  const { d, g } = await sealedDraft(slot, { jurisdiction: "Colombia" });
  return queueForge(d, g, plus(slot, 5));
});
control("KC029", "a requested reply while an uncertain send of the prospect is not reconciled", { code: "KC029" }, G.openUncertain, async () => {
  const { i, slot } = await intentIn("PROVIDER_ACCEPTED");
  const r1 = await replied(i, plus(slot, 300), `inbound-1-${i.intentId}`);
  const r2 = await replied(i, plus(slot, 400), `inbound-2-${i.intentId}`);
  const p = { prospectId: i.draft.prospectId, contactKey: i.draft.contactKey };
  const rr1 = await draft(w, sndS, p, "REQUESTED_REPLY");
  const rr2 = await draft(w, sndS, p, "REQUESTED_REPLY");
  const g = await grant(w, sndS, [rr1, rr2], plus(slot, 500));
  const first = await queue(w, rr1, g.authorizationId, plus(slot, 510), { replyActivityId: r1 });
  await claim(w, first, plus(slot, 520));
  await uncertain(w, first, plus(slot, 600));
  return queueForge(rr2, g.authorizationId, plus(slot, 700), { replyActivityId: r2 });
});
control("KC030 (a)", "a grant whose maximum is already reserved", { code: "KC030" }, G.reserved, async () => {
  const slot = await nextSlot(w);
  const d1 = await draft(w, sndS, await prospectIn(w, w.s, freshDomain("kc030a")));
  const d2 = await draft(w, sndS, await prospectIn(w, w.s, freshDomain("kc030a")));
  const g = await grant(w, sndS, [d1, d2], slot, { maximumSends: 1 });
  await queue(w, d1, g.authorizationId, plus(slot, 5));
  return queueForge(d2, g.authorizationId, plus(slot, 10));
});
control("KC030 (b)", "a revoked grant", { code: "KC030" }, G.revoked, async () => {
  const slot = await nextSlot(w);
  const { d, g } = await sealedDraft(slot);
  await at(w.app, ownerOf(w), plus(slot, 3), async (c) => {
    await lock(c, "L4g", g);
    await c.query("UPDATE kauro.outreach_authorizations SET revoked = true, revoked_by_user_id = $2 WHERE authorization_id = $1", [g, w.kora]);
  });
  return queueForge(d, g, plus(slot, 5));
});
control("KC030 (c)", "before the grant's validFrom", { code: "KC030" }, G.notYetValid, async () => {
  const slot = await nextSlot(w);
  const { d, g } = await sealedDraft(slot, { grant: { validFrom: plus(slot, 3600), expiresAt: plus(slot, 7 * DAY) } });
  return queueForge(d, g, plus(slot, 5));
});
control("KC030 (d)", "at the grant's expiresAt", { code: "KC030" }, G.expired, async () => {
  const slot = await nextSlot(w);
  const { d, g } = await sealedDraft(slot, { grant: { expiresAt: plus(slot, 600) } });
  return queueForge(d, g, plus(slot, 601));
});
control("KC030 (e)", "a draft whose hash the grant did not seal", { code: "KC030" }, G.unsealed, async () => {
  const slot = await nextSlot(w);
  const { g } = await sealedDraft(slot);
  const other = await draft(w, sndS, await prospectIn(w, w.s, freshDomain("kc030e")));
  return queueForge(other, g, plus(slot, 5));
});
control("KC030 no grant row", "an intent naming no grant row (the FK is its immediate twin)", { code: "KC030" }, [G.noGrant, G.intentGrantFk], async () => {
  const slot = await nextSlot(w);
  const { d } = await sealedDraft(slot);
  return queueForge(d, ids.next(), plus(slot, 5));
});
control("KC031", "an intent of a sender not yet verified", { code: "KC031" }, G.unverified, async () => {
  const slot = await nextSlot(w);
  const pending = await sender(w, w.s.userId, { pending: true });
  const { d, g } = await sealedDraft(slot, { snd: pending });
  return queueForge(d, g, plus(slot, 5));
});

// KC032 cap and cadence (A10, A11)
control("KC032 (a)", "the 11th first contact of a person in 24 hours", { code: "KC032" }, G.personCap, async () => {
  const capped = await activeSeller(w, `kc032a-${ids.next().slice(-6)}`);
  const snd = await sender(w, capped.userId);
  const slot = await nextSlot(w);
  const drafts: Draft[] = [];
  for (let k = 0; k < 11; k++) drafts.push(await draft(w, snd, await prospectIn(w, capped, freshDomain("kc032a"))));
  const g = await grant(w, snd, drafts, slot);
  for (let k = 0; k < 10; k++) await queue(w, drafts[k]!, g.authorizationId, plus(slot, 10 + k));
  return queueForge(drafts[10]!, g.authorizationId, plus(slot, 60));
});
async function sentFirst(seller: Seller = w.s, snd: Sender = sndS): Promise<{ i: Intent; slot: string }> {
  return intentIn("PROVIDER_ACCEPTED", seller, snd);
}
control("KC032 (b)", "a second first contact of a prospect within its active sequence", { code: "KC032" }, G.activeSequence, async () => {
  const { i, slot } = await sentFirst();
  const instant = await businessDaysAfter(w, slot, 3);
  const d = await draft(w, sndS, { prospectId: i.draft.prospectId, contactKey: i.draft.contactKey });
  const g = await grant(w, sndS, [d], instant);
  return queueForge(d, g.authorizationId, plus(instant, 5));
});
async function followUp(first: Intent, instant: string): Promise<{ d: Draft; g: string }> {
  const d = await draft(w, sndS, { prospectId: first.draft.prospectId, contactKey: first.draft.contactKey }, "FOLLOW_UP");
  const g = await grant(w, sndS, [d], instant);
  return { d, g: g.authorizationId };
}
control("KC032 (c)", "a third message of a sequence", { code: "KC032" }, G.oneFollowUp, async () => {
  const { i, slot } = await sentFirst();
  const instant = await businessDaysAfter(w, slot, 6);
  const f1 = await followUp(i, instant);
  await queue(w, f1.d, f1.g, plus(instant, 5), { sequenceFirstIntentId: i.intentId });
  const f2 = await followUp(i, plus(instant, 60));
  return queueForge(f2.d, f2.g, plus(instant, 120), { sequenceFirstIntentId: i.intentId });
});
control("KC032 (d)", "a follow-up before 5 business days", { code: "KC032" }, G.followUpEarly, async () => {
  const { i, slot } = await sentFirst();
  const instant = await businessDaysAfter(w, slot, 3);
  const f = await followUp(i, instant);
  return queueForge(f.d, f.g, plus(instant, 5), { sequenceFirstIntentId: i.intentId });
});
control("KC032 (e)", "a follow-up at the first message + 14 days", { code: "KC032" }, G.followUpClosed, async () => {
  const { i, slot } = await sentFirst();
  const counted = await w.h.oracle.query<{ at: Date }>("SELECT counted_at AS at FROM kauro.outreach_send_intents WHERE intent_id = $1", [i.intentId]);
  const instant = plus(counted.rows[0]!.at.toISOString(), 14 * DAY);
  const f = await followUp(i, plus(instant, -120));
  return queueForge(f.d, f.g, instant, { sequenceFirstIntentId: i.intentId });
});
control("KC032 (f)", "a new sequence of a prospect before its last message + 90 days", { code: "KC032" }, G.ninetyDays, async () => {
  const { i, slot } = await sentFirst();
  const instant = await businessDaysAfter(w, slot, 20);
  const d = await draft(w, sndS, { prospectId: i.draft.prospectId, contactKey: i.draft.contactKey });
  const g = await grant(w, sndS, [d], instant);
  return queueForge(d, g.authorizationId, plus(instant, 5));
});
control("KC032 (g)", "a first contact after a stop fact of the prospect", { code: "KC032" }, G.stopFact, async () => {
  const slot = await nextSlot(w);
  const p = await prospectIn(w, w.s, freshDomain("kc032g"));
  await at(w.app, personOf(w.s.userId), slot, async (c) => {
    await lock(c, "L8", `CONTACT:${p.contactKey}`);
    await personActivity(c, w.s.userId, null, p.prospectId, "SUPPRESSED", slot, { keyKind: "CONTACT", key: p.contactKey, reason: "REFUSAL" });
  });
  const d = await draft(w, sndS, p);
  const g = await grant(w, sndS, [d], plus(slot, 10));
  return queueForge(d, g.authorizationId, plus(slot, 20));
});
control("KC032 (h)", "a follow-up whose first message was not sent (FIRST_NOT_SENT)", { code: "KC032" }, G.firstNotSent, async () => {
  const { i, slot } = await intentIn("QUEUED");
  const instant = await businessDaysAfter(w, slot, 6);
  const f = await followUp(i, instant);
  return queueForge(f.d, f.g, plus(instant, 5), { sequenceFirstIntentId: i.intentId });
});
/** A person of its own: the calendar controls judge instants before the shared seller's slots, whose counted first contacts its cap would read. */
async function calendarPerson(): Promise<{ seller: Seller; snd: Sender }> {
  const seller = await activeSeller(w, `calendar-${ids.next().slice(-6)}`);
  return { seller, snd: await sender(w, seller.userId) };
}
for (const [k, day] of [["i1", "2027-01-11"], ["i2", "2027-01-18"], ["i3", "2027-06-18"]] as const) {
  control(`KC032 (${k})`, `a first contact on ${day} (OUTSIDE_BUSINESS_DAY)`, { code: "KC032" }, G.outsideDay, async () => {
    const instant = `${day}T15:00:00.000Z`;
    const { d, g } = await sealedDraft(plus(instant, -600), await calendarPerson());
    return queueForge(d, g, instant);
  });
}
control("KC037", "a first contact on a date outside the seeded calendar (no calendar row)", { code: "KC037" }, G.noCalendar, async () => {
  const instant = "2029-03-06T15:00:00.000Z";
  const { d, g } = await sealedDraft(plus(instant, -600), await calendarPerson());
  return queueForge(d, g, instant);
});

// KC033 resources
control("KC033 (a)", "a draft citing a superseded resource", { code: "KC033" }, G.superseded, async () => {
  const slot = await nextSlot(w);
  const family = ids.next();
  const r1 = await publishResource(family, 1);
  const d = await draft(w, sndS, await prospectIn(w, w.s, freshDomain("kc033a")), "INDIVIDUAL_PROSPECT_CONTACT", { resources: [r1] });
  const g = await grant(w, sndS, [d], slot);
  await publishResource(family, 2);
  return queueForge(d, g.authorizationId, plus(slot, 5));
});
control("KC033 (b)", "a draft citing a resource that claims a capability not offered", { code: "KC033" }, G.notOffered, async () => {
  const slot = await nextSlot(w);
  const cap = await w.h.offeredCapability("SALESFORCE", "QUALIFIED_INTERNAL", { version: `kc033b-${ids.next().slice(-6)}` });
  const r = await publishResource(ids.next(), 1, [cap]);
  const d = await draft(w, sndS, await prospectIn(w, w.s, freshDomain("kc033b")), "INDIVIDUAL_PROSPECT_CONTACT", { resources: [r] });
  const g = await grant(w, sndS, [d], slot);
  return queueForge(d, g.authorizationId, plus(slot, 5));
});

// KC034 health (each its own person: a pause is the person's)
async function healthPerson(label: string): Promise<{ seller: Seller; snd: Sender; i: Intent; slot: string }> {
  const seller = await activeSeller(w, `${label}-${ids.next().slice(-6)}`);
  const snd = await sender(w, seller.userId);
  const { i, slot } = await sentFirst(seller, snd);
  return { seller, snd, i, slot };
}
async function nextFirstOf(hp: { seller: Seller; snd: Sender }, instant: string): Promise<Forge> {
  const { d, g } = await sealedDraft(instant, { seller: hp.seller, snd: hp.snd });
  return queueForge(d, g, plus(instant, 5));
}
control("KC034 (a)", "a person with one bounce in its latest 50 counted sends", { code: "KC034" }, G.paused, async () => {
  const hp = await healthPerson("kc034a");
  await at(w.app, personOf(hp.seller.userId), plus(hp.slot, 300), async (c) => {
    await lock(c, "L3", hp.i.draft.prospectId);
    await lock(c, "L4", hp.i.draft.personUserId);
    await lock(c, "L10", hp.i.draft.draftId);
    await personActivity(c, hp.seller.userId, hp.i, hp.i.draft.prospectId, "BOUNCED", plus(hp.slot, 300), { ref: `bounce-${hp.i.intentId}` });
    await c.query("UPDATE kauro.outreach_drafts SET state = 'BOUNCED' WHERE draft_id = $1", [hp.i.draft.draftId]);
  });
  return nextFirstOf(hp, await businessDaysAfter(w, hp.slot, 2));
});
control("KC034 (b)", "a person with one complaint", { code: "KC034" }, G.paused, async () => {
  const hp = await healthPerson("kc034b");
  await at(w.app, personOf(hp.seller.userId), plus(hp.slot, 300), async (c) => {
    await lock(c, "L4", hp.i.draft.personUserId);
    await lock(c, "L8", `CONTACT:${hp.i.draft.contactKey}`);
    await lock(c, "L10", hp.i.draft.draftId);
    await personActivity(c, hp.seller.userId, hp.i, hp.i.draft.prospectId, "SUPPRESSED", plus(hp.slot, 300), { keyKind: "CONTACT", key: hp.i.draft.contactKey, reason: "COMPLAINT" });
  });
  return nextFirstOf(hp, await businessDaysAfter(w, hp.slot, 2));
});
control("KC034 (d)", "a person with one provider warning", { code: "KC034" }, G.paused, async () => {
  const hp = await healthPerson("kc034d");
  await at(w.outreach, {}, plus(hp.slot, 300), async (c) => {
    await lock(c, "L4", hp.i.draft.personUserId);
    await lock(c, "L10", hp.i.draft.draftId);
    await c.query("INSERT INTO kauro.outreach_provider_warnings (warning_id, intent_id, person_user_id, status, recorded_by_service, recorded_at) VALUES ($1, $2, $3, 403, 'outreach-service', now())", [ids.next(), hp.i.intentId, hp.seller.userId]);
  });
  return nextFirstOf(hp, await businessDaysAfter(w, hp.slot, 2));
});

// KC035 reviews
control("KC035 (a)", "a second grant of one review (consumed; U1)", { code: "23505", constraint: "outreach_authorizations_one_per_review" }, G.reviewOnce, async () => {
  const slot = await nextSlot(w);
  const d = await draft(w, sndS, await prospectIn(w, w.s, freshDomain("kc035a")));
  const rv = await review(w, sndS, [d], slot);
  await at(w.app, ownerOf(w), plus(slot, 1), (c) => insertGrant(c, w, sndS, rv, [d], plus(slot, 1)));
  return { as: "app", ctx: ownerOf(w), at: plus(slot, 2), run: (c) => insertGrant(c, w, sndS, rv, [d], plus(slot, 2)) };
});
control("KC035 (b)", "a grant of an expired review", { code: "KC035" }, G.reviewExpired, async () => {
  const slot = await nextSlot(w);
  const d = await draft(w, sndS, await prospectIn(w, w.s, freshDomain("kc035b")));
  const rv = await review(w, sndS, [d], slot);
  return { as: "app", ctx: ownerOf(w), at: plus(slot, 16 * 60), run: (c) => insertGrant(c, w, sndS, rv, [d], plus(slot, 16 * 60)) };
});
control("KC035 (c)", "a grant under another proof than its review's", { code: "KC035" }, G.reviewProofOther, async () => {
  const slot = await nextSlot(w);
  const d = await draft(w, sndS, await prospectIn(w, w.s, freshDomain("kc035c")));
  const rv = await review(w, sndS, [d], slot);
  const other = await stepUpProof(w.assurance, { userId: w.kora });
  return { as: "app", ctx: ownerOf(w), at: plus(slot, 1), run: (c) => insertGrant(c, w, sndS, rv, [d], plus(slot, 1), { proofId: other }) };
});
control("KC035 (d)", "a grant of a review whose draft moved since it was reviewed", { code: "KC035" }, G.reviewMoved, async () => {
  const slot = await nextSlot(w);
  const moved = await draft(w, sndS, await prospectIn(w, w.s, freshDomain("kc035d")));
  const still = await draft(w, sndS, await prospectIn(w, w.s, freshDomain("kc035d")));
  const rv = await review(w, sndS, [moved, still], slot);
  const g0 = await grant(w, sndS, [moved], plus(slot, 2));
  await queue(w, moved, g0.authorizationId, plus(slot, 5));
  return { as: "app", ctx: ownerOf(w), at: plus(slot, 10), run: (c) => insertGrant(c, w, sndS, rv, [still], plus(slot, 10)) };
});
control("KC035 no review row", "a grant naming no review row (the FK is its immediate twin)", { code: "KC035" }, [G.noReview, G.grantReviewFk, G.notReviewed], async () => {
  const slot = await nextSlot(w);
  const d = await draft(w, sndS, await prospectIn(w, w.s, freshDomain("kc035n")));
  const proofId = await stepUpProof(w.assurance, { userId: w.kora });
  return { as: "app", ctx: ownerOf(w), at: slot, run: (c) => insertGrant(c, w, sndS, { reviewId: ids.next(), proofId }, [d], slot) };
});

// KC036 already sent
control("KC036 (a)", "an intent of a draft that is AUTHORIZED", { code: "KC036" }, G.draftNotDraft, async () => {
  const slot = await nextSlot(w);
  const { d, g } = await sealedDraft(slot);
  await at(w.app, ownerOf(w), plus(slot, 2), async (c) => {
    await lock(c, "L10", d.draftId);
    await c.query("UPDATE kauro.outreach_drafts SET state = 'AUTHORIZED' WHERE draft_id = $1", [d.draftId]);
  });
  return queueForge(d, g, plus(slot, 5), { moveDraft: false });
});
async function evidenceAccepted(i: Intent, instant: string): Promise<void> {
  await at(w.outreach, {}, instant, async (c) => {
    await lock(c, "L10", i.draft.draftId);
    await c.query("INSERT INTO kauro.outreach_send_evidence (evidence_id, intent_id, fence, status, provider_ref, recorded_by_service, received_at) VALUES ($1, $2, 1, 'ACCEPTED', $3, 'outreach-service', now())", [ids.next(), i.intentId, `gmail-${i.intentId}`]);
  });
}
control("KC036 (b)", "a human NOT SENT of an intent with an ACCEPTED evidence row", { code: "KC036" }, G.observedAccepted, async () => {
  const { i, slot } = await intentIn("SEND_UNCERTAIN");
  await evidenceAccepted(i, plus(slot, 100));
  return {
    as: "app",
    ctx: personOf(w.s.userId),
    at: plus(slot, 200),
    run: async (c) => {
      await answerLocks(c, i);
      await c.query("UPDATE kauro.outreach_send_intents SET state = 'OBSERVED_NOT_SENT' WHERE intent_id = $1", [i.intentId]);
    },
  };
});
control("KC036 (c)", "an intent of a DRAFT draft whose earlier intent has an ACCEPTED evidence row (ADV-43)", { code: "KC036" }, G.acceptedEarlier, async () => {
  const { i, slot } = await intentIn("SUBMITTING");
  await evidenceAccepted(i, plus(slot, 20));
  await at(w.outreach, {}, plus(slot, 30), async (c) => {
    await answerLocks(c, i);
    await c.query("UPDATE kauro.outreach_send_intents SET state = 'NOT_SENT', outcome_reason = 'AUTH_REVOKED' WHERE intent_id = $1", [i.intentId]);
    await c.query("UPDATE kauro.outreach_drafts SET state = 'DRAFT' WHERE draft_id = $1", [i.draft.draftId]);
  });
  const later = await businessDaysAfter(w, slot, 70);
  const g = await grant(w, sndS, [i.draft], later);
  return queueForge(i.draft, g.authorizationId, plus(later, 5));
});

// the recorder XOR of prospect_suppressions (the table's own refusal: the policies admit neither form)
control("XOR both null", "a suppression with no recorder", { code: "23514", constraint: "prospect_suppressions_one_recorder" }, G.recorderXor, async () => ({
  as: "oracle",
  at: w.base,
  run: (c) => suppressionIn(c, null, "CONTACT", sha(`xor-null-${ids.next()}`)),
}));
control("XOR both set", "a suppression with a person and the service as recorders", { code: "23514", constraint: "prospect_suppressions_one_recorder" }, G.recorderXor, async () => ({
  as: "oracle",
  at: w.base,
  run: (c) => suppressionIn(c, w.s.userId, "CONTACT", sha(`xor-both-${ids.next()}`), "OPT_OUT", { service: true }),
}));

// --- the three checks per control --------------------------------------------------------------------------------------------------------
const allGuards = (): Guard[] => {
  const seen = new Map<string, Guard>();
  for (const c of controls) for (const g of c.guards) seen.set(guardKey(g), g);
  return [...seen.values()];
};

describe("B12 §K forged controls (migration 0088)", () => {
  for (const c of controls) {
    test(`${c.id}: forged ${c.title} is refused ${c.expect.code}${c.expect.constraint ? ` ${c.expect.constraint}` : ""}; red alone with its own guard dropped, still refused with every other guard dropped (rule 24c)`, async () => {
      const f = await c.forge();
      const refused = await attempt(w, f);
      assert.ok(matches(refused, c.expect), `${c.id} as written: ${describeError(refused)}`);
      const without = await withoutGuards(w, c.guards, () => attempt(w, f));
      assert.equal(describeError(without), "committed", `${c.id} with its own guard dropped commits`);
      const own = new Set(c.guards.map(guardKey));
      const others = allGuards().filter((g) => !own.has(guardKey(g)));
      const alone = await withoutGuards(w, others, () => attempt(w, f));
      assert.ok(matches(alone, c.expect), `${c.id} with every other guard dropped: ${describeError(alone)}`);
    });
  }
});

// --- OK siblings (the production writers commit) ------------------------------------------------------------------------------------
describe("B12 §K OK siblings", () => {
  test("KA095 (c) OK: the owner's draft on a seller's assigned prospect", async () => {
    const p = await prospectIn(w, w.s, freshDomain("ka095c-ok"));
    const d = await draft(w, sndOwner, p);
    const r = await w.h.oracle.query("SELECT state, version FROM kauro.outreach_drafts WHERE draft_id = $1", [d.draftId]);
    assert.deepEqual(r.rows, [{ state: "DRAFT", version: "1" }]);
  });

  test("KA096 (n) OK: HUMAN SENT with L3 S and L10 X only commits, counts unchanged", async () => {
    const { i } = await intentIn("OBSERVED_SENT");
    const r = await w.h.oracle.query("SELECT state FROM kauro.outreach_send_intents WHERE intent_id = $1", [i.intentId]);
    assert.deepEqual(r.rows, [{ state: "OBSERVED_SENT" }]);
  });

  test("the claim stamps counted_at, submitted_at and uncertain_after = submitted_at + 37 s at the database's instant (§W)", async () => {
    const { i, slot } = await intentIn("SUBMITTING");
    const r = await w.h.oracle.query<{ late: string; gap: string; fence: string }>(
      "SELECT extract(epoch FROM (submitted_at - $2::timestamptz))::int::text AS late, extract(epoch FROM (uncertain_after - submitted_at))::int::text AS gap, claim_fence::text AS fence FROM kauro.outreach_send_intents WHERE intent_id = $1",
      [i.intentId, plus(slot, 10)],
    );
    assert.deepEqual(r.rows, [{ late: "0", gap: "37", fence: "1" }]);
  });

  test("KA097 (f) OK: a COMPLAINT after an OPT_OUT of one key is a second activity and one registry row", async () => {
    const p = await prospectIn(w, w.s, freshDomain("ka097f-ok"));
    for (const reason of ["OPT_OUT", "COMPLAINT"]) {
      await at(w.app, personOf(w.s.userId), w.base, async (c) => {
        await lock(c, "L8", `CONTACT:${p.contactKey}`);
        await personActivity(c, w.s.userId, null, p.prospectId, "SUPPRESSED", w.base, { keyKind: "CONTACT", key: p.contactKey, reason });
        await suppressionIn(c, w.s.userId, "CONTACT", p.contactKey, reason, { skipLock: true });
      });
    }
    const acts = await w.h.oracle.query("SELECT suppression_reason FROM kauro.sales_activities WHERE prospect_id = $1 ORDER BY suppression_reason", [p.prospectId]);
    assert.deepEqual(acts.rows, [{ suppression_reason: "COMPLAINT" }, { suppression_reason: "OPT_OUT" }]);
    const rows = await w.h.oracle.query("SELECT reason FROM kauro.prospect_suppressions WHERE key_kind = 'CONTACT' AND suppression_key = $1", [p.contactKey]);
    assert.deepEqual(rows.rows, [{ reason: "OPT_OUT" }]);
  });

  test("KA098 OK: CMD064 SUPPRESSED of the seller's own prospect, the opt-out by the outreach service, and the owner's CMD050 unassign", async () => {
    const p = await prospectIn(w, w.s, freshDomain("ka098-ok"));
    await contactSuppressed(w.s, p.contactKey);
    await at(w.app, personOf(w.s.userId), w.base, (c) => c.query("UPDATE kauro.prospects SET state = 'SUPPRESSED', suppressed = true, version = version + 1 WHERE prospect_id = $1 AND state <> 'SUPPRESSED'", [p.prospectId]));
    const q = await prospectIn(w, w.s, freshDomain("ka098-optout"));
    await at(w.outreach, {}, w.base, (c) => suppressionIn(c, null, "CONTACT", q.contactKey, "OPT_OUT", { service: true }));
    const optOut = await w.h.oracle.query("SELECT reason, recorded_by_user_id, recorded_by_service FROM kauro.prospect_suppressions WHERE key_kind = 'CONTACT' AND suppression_key = $1", [q.contactKey]);
    assert.deepEqual(optOut.rows, [{ reason: "OPT_OUT", recorded_by_user_id: null, recorded_by_service: "outreach-service" }]);
    const moves = await w.h.oracle.query("SELECT has_table_privilege('kauro_outreach', 'kauro.prospects', 'UPDATE') OR has_any_column_privilege('kauro_outreach', 'kauro.prospects', 'UPDATE') AS can");
    assert.deepEqual(moves.rows, [{ can: false }], "the service never moves a prospect (its history is an agency_id table, A17)");
    const o = await prospectIn(w, w.s, freshDomain("ka098-unassign"));
    await at(w.app, ownerOf(w), w.base, (c) => c.query("UPDATE kauro.prospects SET owner_seller_id = NULL, version = version + 1 WHERE prospect_id = $1", [o.prospectId]));
    const r = await w.h.oracle.query("SELECT prospect_id, state, owner_seller_id FROM kauro.prospects WHERE prospect_id = ANY($1) ORDER BY prospect_id", [[p.prospectId, q.prospectId, o.prospectId]]);
    assert.deepEqual(
      r.rows.map((x) => [x.state, x.owner_seller_id]),
      [p, q, o]
        .map((x) => x.prospectId)
        .sort()
        .map((id) => (id === o.prospectId ? ["RESEARCHED", null] : id === q.prospectId ? ["RESEARCHED", w.s.sellerId] : ["SUPPRESSED", w.s.sellerId])),
    );
  });

  test("KA098 DENY (self-reassign): a seller setting owner_seller_id to itself on another seller's prospect and on an unassigned prospect changes no row", async () => {
    const theirs = await prospectIn(w, w.s2, freshDomain("self-theirs"));
    const mine = await prospectIn(w, w.s, freshDomain("self-unassigned"));
    await at(w.app, ownerOf(w), w.base, (c) => c.query("UPDATE kauro.prospects SET owner_seller_id = NULL, version = version + 1 WHERE prospect_id = $1", [mine.prospectId]));
    for (const p of [theirs, mine]) {
      const e = await attempt(w, sellerUpdate(w.s, w.base, "UPDATE kauro.prospects SET owner_seller_id = $2, version = version + 1 WHERE prospect_id = $1", [p.prospectId, w.s.sellerId], true));
      assert.ok(matches(e, { code: "ZERO_ROWS" }) || matches(e, { code: "42501" }), describeError(e));
    }
  });

  test("KC034 (c) OK: after the owner's diagnosis the person's next first contact is queued", async () => {
    const hp = await healthPerson("kc034c");
    await at(w.app, personOf(hp.seller.userId), plus(hp.slot, 300), async (c) => {
      await lock(c, "L3", hp.i.draft.prospectId);
      await lock(c, "L4", hp.i.draft.personUserId);
      await lock(c, "L10", hp.i.draft.draftId);
      await personActivity(c, hp.seller.userId, hp.i, hp.i.draft.prospectId, "BOUNCED", plus(hp.slot, 300), { ref: `bounce-${hp.i.intentId}` });
    });
    const proofId = await stepUpProof(w.assurance, { userId: w.kora });
    await at(w.app, ownerOf(w), plus(hp.slot, 400), async (c) => {
      await lock(c, "L4", hp.seller.userId);
      await c.query("INSERT INTO kauro.outreach_diagnoses (diagnosis_id, person_user_id, owner_user_id, proof_id, evidence_hash, recorded_at) VALUES ($1, $2, $3, $4, $5, now())", [ids.next(), hp.seller.userId, w.kora, proofId, sha("diagnosis")]);
    });
    const f = await nextFirstOf(hp, await businessDaysAfter(w, hp.slot, 2));
    assert.equal(describeError(await attempt(w, f)), "committed");
  });

  test("KC036 OK: CMD063 of a DRAFT draft whose earlier intent is OBSERVED_NOT_SENT without evidence", async () => {
    const { i, slot } = await intentIn("OBSERVED_NOT_SENT");
    const instant = await businessDaysAfter(w, slot, 1);
    const g = await grant(w, sndS, [i.draft], instant);
    assert.equal(describeError(await attempt(w, queueForge(i.draft, g.authorizationId, plus(instant, 5)))), "committed");
  });
});

// --- censuses ------------------------------------------------------------------------------------------------------------------------------
const B12_TABLES = [
  "outreach_calendar_days",
  "sender_identities",
  "outreach_contents",
  "sales_resources",
  "sales_resource_capabilities",
  "outreach_channel_policies",
  "prospect_contact_addresses",
  "outreach_drafts",
  "outreach_draft_resources",
  "outreach_reviews",
  "outreach_review_items",
  "outreach_authorizations",
  "outreach_authorization_hashes",
  "outreach_send_intents",
  "sales_activities",
  "outreach_provider_warnings",
  "outreach_send_evidence",
  "outreach_diagnoses",
];

describe("B12 censuses (migration 0088)", () => {
  test("B12 TRUNCATE: kauro_app, kauro_outreach, kauro_control hold no TRUNCATE on any B12 table; no runtime role holds DELETE on one", async () => {
    const r = await w.h.oracle.query<{ t: string; role: string; p: string }>(
      `SELECT t, role, p FROM unnest($1::text[]) t, unnest(ARRAY['kauro_app', 'kauro_outreach', 'kauro_control', 'kauro_commission', 'kauro_payment']) role, unnest(ARRAY['TRUNCATE', 'DELETE']) p
        WHERE has_table_privilege(role, 'kauro.' || t, p)`,
      [B12_TABLES],
    );
    assert.deepEqual(r.rows, []);
  });

  test("B12 RLS: every B12 table is ENABLE and FORCE ROW LEVEL SECURITY", async () => {
    const r = await w.h.oracle.query<{ relname: string }>("SELECT relname FROM pg_class WHERE relnamespace = 'kauro'::regnamespace AND relname = ANY($1) AND NOT (relrowsecurity AND relforcerowsecurity) ORDER BY 1", [B12_TABLES]);
    assert.deepEqual(r.rows, []);
  });

  test("B12 unique-index census: prospect_suppressions and sales_activities carry exactly their identity uniques (U2, U3)", async () => {
    const r = await w.h.oracle.query<{ t: string; i: string }>(
      "SELECT c.relname AS t, ic.relname AS i FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid WHERE x.indisunique AND c.relnamespace = 'kauro'::regnamespace AND c.relname IN ('prospect_suppressions', 'sales_activities') ORDER BY 1, 2",
    );
    assert.deepEqual(
      r.rows.map((x) => `${x.t}.${x.i}`),
      [
        "prospect_suppressions.prospect_suppressions_one_per_key",
        "prospect_suppressions.prospect_suppressions_pkey",
        "sales_activities.sales_activities_one_accepted_per_intent",
        "sales_activities.sales_activities_one_bounce_per_intent",
        "sales_activities.sales_activities_one_observation_per_intent",
        "sales_activities.sales_activities_one_reply_per_inbound",
        "sales_activities.sales_activities_one_suppression_per_reason",
        "sales_activities.sales_activities_one_uncertain_per_intent",
        "sales_activities.sales_activities_pkey",
      ],
    );
  });

  test("B12 kauro_outreach holds no grant on any table with an agency_id (A17)", async () => {
    const r = await w.h.oracle.query<{ t: string }>(
      `SELECT DISTINCT c.relname AS t FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'agency_id' AND NOT a.attisdropped
        WHERE c.relnamespace = 'kauro'::regnamespace AND c.relkind IN ('r', 'p', 'v')
          AND (has_table_privilege('kauro_outreach', c.oid, 'SELECT') OR has_table_privilege('kauro_outreach', c.oid, 'INSERT') OR has_table_privilege('kauro_outreach', c.oid, 'UPDATE')
               OR has_any_column_privilege('kauro_outreach', c.oid, 'SELECT') OR has_any_column_privilege('kauro_outreach', c.oid, 'UPDATE'))
        ORDER BY 1`,
    );
    assert.deepEqual(r.rows, []);
  });

  test("B12 channel policies: seeded US x three purposes v1 IN_FORCE, no runtime INSERT grant", async () => {
    const r = await w.h.oracle.query("SELECT jurisdiction, purpose, version, state FROM kauro.outreach_channel_policies ORDER BY purpose");
    assert.deepEqual(r.rows, ["FOLLOW_UP", "INDIVIDUAL_PROSPECT_CONTACT", "REQUESTED_REPLY"].map((purpose) => ({ jurisdiction: "US", purpose, version: 1, state: "IN_FORCE" })));
    const g = await w.h.oracle.query("SELECT 1 FROM unnest(ARRAY['kauro_app', 'kauro_outreach', 'kauro_control']) role WHERE has_table_privilege(role, 'kauro.outreach_channel_policies', 'INSERT')");
    assert.equal(g.rowCount, 0);
  });

  test("B12 lock subjects: the trigger assertion reads exactly this backend's advisory lock of the subject (S held satisfies S only, X satisfies both)", async () => {
    const c = w.outreach;
    await c.query("BEGIN");
    try {
      await lock(c, "L3", "subject-one", "S");
      await lock(c, "L4", "subject-two", "X");
      const r = await c.query("SELECT kauro.outreach_lock_held('kauro.outreach_prospects', 'subject-one', 'S') AS s1, kauro.outreach_lock_held('kauro.outreach_prospects', 'subject-one', 'X') AS x1, kauro.outreach_lock_held('kauro.outreach_person_caps', 'subject-two', 'S') AS s2, kauro.outreach_lock_held('kauro.outreach_person_caps', 'subject-other', 'S') AS other");
      assert.deepEqual(r.rows, [{ s1: true, x1: false, s2: true, other: false }]);
    } finally {
      await c.query("ROLLBACK");
    }
    const other = await w.h.oracle.query("SELECT kauro.outreach_lock_held('kauro.outreach_prospects', 'subject-one', 'S') AS held");
    assert.deepEqual(other.rows, [{ held: false }], "another backend's lock is never this backend's");
  });
});
