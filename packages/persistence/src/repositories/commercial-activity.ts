/**
 * Lane L-ACT's SQL (package B12; docs/design/B12-outreach-plan.md §2 "CMD064", "Public opt-out", §L, §M, §W): the activity store of the request
 * side (CMD064, ListSalesActivities, GetOutreachMetrics, RecordOutreachDiagnosis; kauro_app, OPERATOR context) and the opt-out store of the
 * public route (kauro_outreach, the OUTREACH_SERVICE context). Every write goes through PgOutreachWriters, which REQUIRES the T2 subjects of its
 * edge to be held already (KA096 LOCK_NOT_HELD is the database's second line). The shape of every unit: discovery (plain reads), the whole
 * serializer set in the global order of plan §L, the judgment (one statement that reads kauro.effect_now() and the locked facts), then the writes;
 * nothing awaited between the last judgment and the first write. D-33: no segment or buyer-type read, no ranking.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { DomainFailure, NotFoundFailure, type CommerceUnitOfWorkFactory, type CorrelationId, type IdGenerator, type UnitOfWork } from "@kauro/domain";
import { OutreachLocks } from "../outreach-access.js";
import { execute, type Queryable } from "../sql.js";
import { PgCommerceUnitOfWork } from "../unit-of-work.js";
import { PgOutreachWriters, type OutreachIntentKeys } from "./commercial-outreach.js";
import { canonical, instantOf } from "./commercial-sales-rows.js";

/** Structural twins of the application's port types (application depends on persistence's accessors, never the reverse). */
export interface ActivityRequest {
  readonly activityId: string;
  readonly suppressionId: string;
  readonly callerUserId: string;
  readonly callerSellerId: string | null;
  readonly prospectId: string;
  readonly draftId: string | null;
  readonly kind: "REPLIED" | "BOUNCED" | "SUPPRESSED" | "HUMAN_SEND_OBSERVED";
  readonly occurredAt: string;
  readonly evidenceHash: string;
  readonly providerMessageRef: string;
  readonly observation: "SENT" | "NOT_SENT" | null;
  readonly suppressionKeyKind: "ORGANIZATION" | "CONTACT" | null;
  readonly suppressionReason: "OPT_OUT" | "COMPLAINT" | "DISQUALIFIED" | "REFUSAL" | null;
}

export interface ActivityRow {
  readonly activityId: string;
  readonly prospectId: string;
  readonly draftId?: string;
  readonly authorizationId?: string;
  readonly kind: "PROVIDER_ACCEPTED" | "SEND_UNCERTAIN" | "BOUNCED" | "REPLIED" | "SUPPRESSED" | "HUMAN_SEND_OBSERVED";
  readonly occurredAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  readonly providerMessageRef: string;
  readonly recordedAt: UtcInstant;
}

export interface MetricsRow {
  readonly accepted: number;
  readonly uncertain: number;
  readonly observedSent: number;
  readonly bounced: number;
  readonly replied: number;
  readonly acceptedLessKnownBounces: number;
  readonly pauseNumerator: number;
  readonly pauseDenominator: number;
}

export interface DiagnosisRequest {
  readonly diagnosisId: string;
  readonly ownerUserId: string;
  readonly personUserId: string;
  readonly evidenceHash: string;
  readonly proofId: string;
}

const closed = (message: string, reason: "DRAFT_CLOSED" | "OUTREACH_ALREADY_SENT" | "SEND_UNCERTAIN_UNRESOLVED" | "SOURCE_EVIDENCE_INVALID"): DomainFailure =>
  new DomainFailure("PRECONDITION_FAILED", message, { reason });

interface ProspectFacts {
  prospect_id: string;
  owner_seller_id: string | null;
  organization_key: string;
  business_contact_id: string | null;
  registered_by_user_id: string;
}
interface IntentFacts {
  intent_id: string;
  draft_id: string;
  authorization_id: string;
  prospect_id: string;
  person_user_id: string;
  purpose: OutreachIntentKeys["purpose"];
  state: string;
  past_uncertain: boolean | null;
}

const ACTIVITY_COLUMNS = `activity_id, prospect_id, draft_id, authorization_id, kind, evidence_hash, provider_message_ref, ${canonical("occurred_at", "occurred_at")}, ${canonical("recorded_at", "recorded_at")}`;

interface ActivityDbRow {
  activity_id: string;
  prospect_id: string;
  draft_id: string | null;
  authorization_id: string | null;
  kind: ActivityRow["kind"];
  evidence_hash: string;
  provider_message_ref: string;
  occurred_at: string;
  recorded_at: string;
}

function activityOf(r: ActivityDbRow): ActivityRow {
  return {
    activityId: r.activity_id,
    prospectId: r.prospect_id,
    ...(r.draft_id !== null ? { draftId: r.draft_id } : {}),
    ...(r.authorization_id !== null ? { authorizationId: r.authorization_id } : {}),
    kind: r.kind,
    occurredAt: instantOf(r.occurred_at),
    evidenceHash: r.evidence_hash as Sha256Hex,
    providerMessageRef: r.provider_message_ref,
    recordedAt: instantOf(r.recorded_at),
  };
}

export class PgActivityStore {
  constructor(private readonly db: Queryable) {}

  /** CMD064. */
  async record(req: ActivityRequest): Promise<ActivityRow> {
    const db = this.db;
    // --- discovery (plain reads under the caller's policies; a foreign row is as unknown as a missing one) ---------------------------
    const prospect = (
      await execute<ProspectFacts>(db, "SELECT prospect_id, owner_seller_id, organization_key, business_contact_id, registered_by_user_id FROM kauro.prospects WHERE prospect_id = $1", [req.prospectId])
    ).rows[0];
    if (prospect === undefined || (req.callerSellerId !== null && prospect.owner_seller_id !== req.callerSellerId)) throw new NotFoundFailure("prospect");
    let draftExists = false;
    if (req.draftId !== null) {
      draftExists = ((await execute(db, "SELECT 1 FROM kauro.outreach_drafts WHERE draft_id = $1 AND prospect_id = $2", [req.draftId, req.prospectId])).rowCount ?? 0) === 1;
      if (!draftExists) throw new NotFoundFailure("draft");
    }
    const intentOf = async (): Promise<IntentFacts | null> => {
      if (req.draftId === null) return null;
      const r = await execute<IntentFacts>(
        db,
        `SELECT intent_id, draft_id, authorization_id, prospect_id, person_user_id, purpose, state, (uncertain_after IS NOT NULL AND uncertain_after <= kauro.effect_now()) AS past_uncertain
           FROM kauro.outreach_send_intents WHERE draft_id = $1 ORDER BY counted_at DESC, intent_id DESC LIMIT 1`,
        [req.draftId],
      );
      return r.rows[0] ?? null;
    };
    const discovered = await intentOf();
    const needsIntent = req.kind !== "SUPPRESSED";
    if (needsIntent && discovered === null) throw closed("the draft has no send intent the activity could belong to", "DRAFT_CLOSED");
    let suppressionKey: string | null = null;
    if (req.kind === "SUPPRESSED") {
      if (req.suppressionKeyKind === "ORGANIZATION") suppressionKey = prospect.organization_key;
      else if (prospect.business_contact_id !== null) {
        const c = await execute<{ contact_key: string }>(db, "SELECT contact_key FROM kauro.prospect_contacts WHERE recorded_by_user_id = $1 AND contact_id = $2", [prospect.registered_by_user_id, prospect.business_contact_id]);
        suppressionKey = c.rows[0]?.contact_key ?? null;
      }
      if (suppressionKey === null) throw closed("the prospect has no business contact whose key could be suppressed", "SOURCE_EVIDENCE_INVALID");
    }

    // --- the serializer set, in the global order of plan §L (L3, L4, L4g, L8, L10) -----------------------------------------------------
    const locks = new OutreachLocks(db);
    const intent = discovered;
    switch (req.kind) {
      case "REPLIED":
        await locks.take("L3", req.prospectId, "X");
        break;
      case "BOUNCED":
        await locks.take("L3", req.prospectId, "X");
        await locks.take("L4", intent!.person_user_id, "X");
        break;
      case "HUMAN_SEND_OBSERVED":
        await locks.take("L3", req.prospectId, "S");
        if (req.observation === "NOT_SENT") {
          await locks.take("L4", intent!.person_user_id, "S");
          await locks.take("L4g", intent!.authorization_id, "S");
        }
        break;
      case "SUPPRESSED":
        if (req.suppressionReason === "COMPLAINT" && intent !== null) await locks.take("L4", intent.person_user_id, "X");
        await locks.take("L8", `${req.suppressionKeyKind}:${suppressionKey}`, "X");
        break;
    }
    if (req.draftId !== null && (needsIntent || intent !== null)) await locks.take("L10", req.draftId, "X");

    // --- the judgment: the database's instant and the facts as they are under the locks ----------------------------------------------
    const instant = (await execute<{ not_future: boolean }>(db, "SELECT ($1::timestamptz <= kauro.effect_now()) AS not_future", [req.occurredAt])).rows[0]!;
    if (!instant.not_future) throw closed("the activity is dated after the database's instant", "SOURCE_EVIDENCE_INVALID");
    const now = await intentOf();
    const draftState = req.draftId === null ? null : (await execute<{ state: string }>(db, "SELECT state FROM kauro.outreach_drafts WHERE draft_id = $1", [req.draftId])).rows[0]?.state ?? null;
    if (needsIntent && now === null) throw closed("the draft has no send intent", "DRAFT_CLOSED");
    const keys: OutreachIntentKeys | null =
      now === null ? null : { intentId: now.intent_id, draftId: now.draft_id, authorizationId: now.authorization_id, prospectId: now.prospect_id, personUserId: now.person_user_id, purpose: now.purpose };

    if (req.kind === "REPLIED" || req.kind === "BOUNCED") {
      if (draftState !== "PROVIDER_ACCEPTED" || now!.state !== "PROVIDER_ACCEPTED") throw closed("the draft is not a provider-accepted send: it is closed or was never accepted", "DRAFT_CLOSED");
      const outbound = await execute(db, "SELECT 1 FROM kauro.outreach_send_intents WHERE provider_message_ref = $1", [req.providerMessageRef]);
      if ((outbound.rowCount ?? 0) > 0) throw closed("a reply or bounce names an inbound message, not an outbound provider id", "SOURCE_EVIDENCE_INVALID");
      const twin =
        req.kind === "REPLIED"
          ? await execute(db, "SELECT 1 FROM kauro.sales_activities WHERE kind = 'REPLIED' AND provider_message_ref = $1", [req.providerMessageRef])
          : await execute(db, "SELECT 1 FROM kauro.sales_activities WHERE kind = 'BOUNCED' AND intent_id = $1", [now!.intent_id]);
      if ((twin.rowCount ?? 0) > 0) throw closed("an activity of this identity is already recorded", "DRAFT_CLOSED");
    }
    if (req.kind === "HUMAN_SEND_OBSERVED") {
      const accepted = await execute(
        db,
        "SELECT 1 FROM kauro.outreach_send_evidence WHERE intent_id = $1 AND status = 'ACCEPTED' UNION ALL SELECT 1 FROM kauro.sales_activities WHERE intent_id = $1 AND kind = 'PROVIDER_ACCEPTED'",
        [now!.intent_id],
      );
      if ((accepted.rowCount ?? 0) > 0 || now!.state === "PROVIDER_ACCEPTED") throw closed("the provider accepted this send: the accepted answer stands", "OUTREACH_ALREADY_SENT");
      if (now!.state !== "SEND_UNCERTAIN") throw closed("the intent is not an uncertain send", "DRAFT_CLOSED");
      if (req.observation === "NOT_SENT" && now!.past_uncertain !== true) throw closed("the send may still be answered: not before uncertain_after", "SEND_UNCERTAIN_UNRESOLVED");
    }
    if (req.kind === "SUPPRESSED") {
      const twin = await execute(
        db,
        "SELECT 1 FROM kauro.sales_activities WHERE kind = 'SUPPRESSED' AND prospect_id = $1 AND suppression_key_kind = $2 AND suppression_key = $3 AND suppression_reason = $4",
        [req.prospectId, req.suppressionKeyKind, suppressionKey, req.suppressionReason],
      );
      if ((twin.rowCount ?? 0) > 0) throw closed("a suppression of this key and reason is already recorded for the prospect", "DRAFT_CLOSED");
    }

    // --- the writes (the first one follows the judgment with no other await) -------------------------------------------------------------
    const writers = new PgOutreachWriters(db);
    const activity = {
      activityId: req.activityId,
      recordedByUserId: req.callerUserId,
      prospectId: req.prospectId,
      intent: keys,
      kind: req.kind,
      evidenceHash: req.evidenceHash,
      occurredAt: req.occurredAt,
      providerMessageRef: req.providerMessageRef,
    } as const;
    switch (req.kind) {
      case "REPLIED":
        await writers.recordPersonActivity(locks, activity);
        await writers.moveDraft(locks, req.draftId!, "REPLIED");
        break;
      case "BOUNCED":
        await writers.recordPersonActivity(locks, activity);
        await writers.moveDraft(locks, req.draftId!, "BOUNCED");
        break;
      case "HUMAN_SEND_OBSERVED": {
        const moved = await writers.observeUncertain(locks, keys!, req.observation!);
        if (!moved) throw closed("the intent is no longer an uncertain send", "DRAFT_CLOSED");
        // the plan: SENT shows the draft sent (PROVIDER_ACCEPTED, never sent again: KC036), NOT_SENT returns it to DRAFT
        await writers.moveDraft(locks, req.draftId!, req.observation === "NOT_SENT" ? "DRAFT" : "PROVIDER_ACCEPTED");
        await writers.recordPersonActivity(locks, { ...activity, observation: req.observation! });
        break;
      }
      case "SUPPRESSED": {
        const suppression = { keyKind: req.suppressionKeyKind!, key: suppressionKey!, reason: req.suppressionReason! };
        await writers.recordSuppression(locks, { suppressionId: req.suppressionId, ...suppression, by: { userId: req.callerUserId } });
        await writers.recordPersonActivity(locks, { ...activity, suppression, providerMessageRef: "NONE" });
        if (keys !== null && (draftState === "PROVIDER_ACCEPTED" || draftState === "AUTHORIZED")) await writers.moveDraft(locks, keys.draftId, "SUPPRESSED");
        // L14, the last acquisition: the prospect row(s) the key reaches, only where not yet SUPPRESSED (0029 has no SUPPRESSED -> SUPPRESSED edge)
        await execute(
          db,
          req.suppressionKeyKind === "ORGANIZATION"
            ? "UPDATE kauro.prospects SET state = 'SUPPRESSED', suppressed = true, version = version + 1, updated_at = kauro.effect_now() WHERE organization_key = $1 AND state <> 'SUPPRESSED'"
            : "UPDATE kauro.prospects SET state = 'SUPPRESSED', suppressed = true, version = version + 1, updated_at = kauro.effect_now() WHERE prospect_id = $1 AND state <> 'SUPPRESSED'",
          [req.suppressionKeyKind === "ORGANIZATION" ? prospect.organization_key : req.prospectId],
        );
        break;
      }
    }
    const row = (await execute<ActivityDbRow>(db, `SELECT ${ACTIVITY_COLUMNS} FROM kauro.sales_activities WHERE activity_id = $1`, [req.activityId])).rows[0];
    if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the recorded activity is not readable by its recorder");
    return activityOf(row);
  }

  /** ListSalesActivities: the newest 200, newest first; null when the prospect is not the caller's to see. */
  async listForProspect(prospectId: string, callerSellerId: string | null): Promise<ReadonlyArray<ActivityRow> | null> {
    const p = await execute<{ owner_seller_id: string | null }>(this.db, "SELECT owner_seller_id FROM kauro.prospects WHERE prospect_id = $1", [prospectId]);
    const prospect = p.rows[0];
    if (prospect === undefined || (callerSellerId !== null && prospect.owner_seller_id !== callerSellerId)) return null;
    const r = await execute<ActivityDbRow>(this.db, `SELECT ${ACTIVITY_COLUMNS} FROM kauro.sales_activities WHERE prospect_id = $1 ORDER BY recorded_at DESC, activity_id DESC LIMIT 200`, [prospectId]);
    return r.rows.map(activityOf);
  }

  /** GetOutreachMetrics under the caller's own policies. Delivery is never counted: nothing here is "delivered". */
  async metrics(callerUserId: string): Promise<MetricsRow> {
    const r = await execute<{ accepted: string; uncertain: string; observed_sent: string; bounced: string; replied: string }>(
      this.db,
      `SELECT count(*) FILTER (WHERE kind = 'PROVIDER_ACCEPTED') AS accepted,
              (SELECT count(*) FROM kauro.outreach_send_intents WHERE state = 'SEND_UNCERTAIN') AS uncertain,
              count(*) FILTER (WHERE kind = 'HUMAN_SEND_OBSERVED' AND observation = 'SENT') AS observed_sent,
              count(*) FILTER (WHERE kind = 'BOUNCED') AS bounced,
              count(*) FILTER (WHERE kind = 'REPLIED') AS replied
         FROM kauro.sales_activities`,
    );
    const pause = await execute<{ denominator: string; numerator: string }>(
      this.db,
      `WITH since AS (SELECT coalesce(max(recorded_at), '-infinity'::timestamptz) AS at FROM kauro.outreach_diagnoses WHERE person_user_id = $1),
            latest AS (
              SELECT i.intent_id FROM kauro.outreach_send_intents i, since
               WHERE i.person_user_id = $1 AND kauro.outreach_intent_counted(i.intent_id, i.state) AND i.counted_at > since.at
               ORDER BY i.counted_at DESC, i.intent_id DESC LIMIT 50)
       SELECT count(*) AS denominator, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM kauro.sales_activities a WHERE a.intent_id = latest.intent_id AND a.kind = 'BOUNCED')) AS numerator FROM latest`,
      [callerUserId],
    );
    const row = r.rows[0]!;
    const accepted = Number(row.accepted);
    const bounced = Number(row.bounced);
    return {
      accepted,
      uncertain: Number(row.uncertain),
      observedSent: Number(row.observed_sent),
      bounced,
      replied: Number(row.replied),
      acceptedLessKnownBounces: Math.max(0, accepted - bounced),
      pauseNumerator: Number(pause.rows[0]!.numerator),
      pauseDenominator: Number(pause.rows[0]!.denominator),
    };
  }

  /** RecordOutreachDiagnosis: L4 X of the person (waits behind a claim or a send of the person), then the row, stamped by the database. */
  async recordDiagnosis(req: DiagnosisRequest): Promise<{ readonly diagnosisId: string; readonly personUserId: string; readonly recordedAt: UtcInstant }> {
    const person = await execute(this.db, "SELECT 1 FROM kauro.outreach_send_intents WHERE person_user_id = $1 LIMIT 1", [req.personUserId]);
    if ((person.rowCount ?? 0) === 0) throw new NotFoundFailure("person");
    const locks = new OutreachLocks(this.db);
    await locks.take("L4", req.personUserId, "X");
    await execute(this.db, "INSERT INTO kauro.outreach_diagnoses (diagnosis_id, person_user_id, owner_user_id, proof_id, evidence_hash, recorded_at) VALUES ($1, $2, $3, $4, $5, kauro.effect_now())", [
      req.diagnosisId,
      req.personUserId,
      req.ownerUserId,
      req.proofId,
      req.evidenceHash,
    ]);
    const r = await execute<{ recorded_at: string }>(this.db, `SELECT ${canonical("recorded_at", "recorded_at")} FROM kauro.outreach_diagnoses WHERE diagnosis_id = $1`, [req.diagnosisId]);
    return { diagnosisId: req.diagnosisId, personUserId: req.personUserId, recordedAt: instantOf(r.rows[0]!.recorded_at) };
  }
}

function dbOf(uow: UnitOfWork): Queryable {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the outreach activity records are read in a commerce unit of work of @kauro/persistence");
  return (uow as unknown as { readonly client: Queryable }).client;
}

const stores = new WeakMap<UnitOfWork, PgActivityStore>();

/** The activity store of a unit of work, one per unit (the accessor pattern of salesOf). */
export function outreachActivityOf(uow: UnitOfWork): PgActivityStore {
  let store = stores.get(uow);
  if (store === undefined) {
    store = new PgActivityStore(dbOf(uow));
    stores.set(uow, store);
  }
  return store;
}

/** The identity the outreach service's units run under (migration 0072: kauro_outreach). */
export const OUTREACH_SERVICE_ID = "outreach-service";

/**
 * The public opt-out's store (kauro_outreach). Each call is its own unit of work: the suppression and its activity commit together or not at
 * all (GAP-OO-1), and a miss is counted in a unit of its own so a refused unit never erases it.
 */
export class PgOptOutStore {
  constructor(
    private readonly units: CommerceUnitOfWorkFactory,
    private readonly ids: IdGenerator,
  ) {}

  private context() {
    return { kind: "SERVICE", serviceId: OUTREACH_SERVICE_ID, correlationId: this.ids.next() as CorrelationId } as const;
  }

  /** L8 X of the intent's contact key, then the suppression row and the SUPPRESSED activity, both ON CONFLICT DO NOTHING (M35). */
  async suppressContactOfIntent(intentId: string): Promise<"SUPPRESSED" | "UNKNOWN_INTENT"> {
    return this.units.run(this.context(), async (uow) => {
      const db = dbOf(uow);
      const found = await execute<{ prospect_id: string; contact_key: string }>(db, "SELECT prospect_id, contact_key FROM kauro.outreach_send_intents WHERE intent_id = $1", [intentId]);
      const intent = found.rows[0];
      if (intent === undefined) return "UNKNOWN_INTENT";
      const locks = new OutreachLocks(db);
      await locks.take("L8", `CONTACT:${intent.contact_key}`, "X");
      const writers = new PgOutreachWriters(db);
      await writers.recordSuppression(locks, { suppressionId: uow.ids.next(), keyKind: "CONTACT", key: intent.contact_key, reason: "OPT_OUT", by: { service: "outreach-service" } });
      // evidence: the hash of the opt-out fact (the intent whose token was presented); the activity identity is (prospect, CONTACT, key, OPT_OUT)
      await execute(
        db,
        `INSERT INTO kauro.sales_activities (activity_id, prospect_id, kind, suppression_key_kind, suppression_key, suppression_reason, provider_message_ref, evidence_hash, occurred_at, recorded_by_service)
         VALUES ($1, $2, 'SUPPRESSED', 'CONTACT', $3, 'OPT_OUT', 'NONE', encode(sha256(convert_to($4, 'UTF8')), 'hex'), kauro.effect_now(), 'outreach-service')
         ON CONFLICT DO NOTHING`,
        [uow.ids.next(), intent.prospect_id, intent.contact_key, `opt-out:${intentId}`],
      );
      return "SUPPRESSED";
    });
  }

  /** One miss of the network, stamped by the database; answers the misses of the network within the last 60 s, this one included. */
  async recordMiss(networkDigest: string): Promise<number> {
    return this.units.run(this.context(), async (uow) => {
      const db = dbOf(uow);
      await execute(db, "INSERT INTO kauro.outreach_opt_out_misses (miss_id, network_digest, missed_at) VALUES ($1, $2, kauro.effect_now())", [uow.ids.next(), networkDigest]);
      const r = await execute<{ misses: string }>(db, "SELECT count(*) AS misses FROM kauro.outreach_opt_out_misses WHERE network_digest = $1 AND missed_at > kauro.effect_now() - interval '60 seconds'", [networkDigest]);
      return Number(r.rows[0]!.misses);
    });
  }
}
