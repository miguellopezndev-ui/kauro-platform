// The L-SEND world (B12 plan docs/design/B12-outreach-plan.md §9 L-SEND; consumed by b12-send-support.ts through `sendWorldOf`). Built on the
// statements world (one api over a real PostgreSQL, B09/B10 routes, the owner), plus the OUTREACH dispatcher over the outreach pool
// (kauro_outreach_test) and the control pool, the labelled contract fakes of the Gmail and Resend ports, the deployment's compliance
// configuration, and fixtures for the rows other lanes will produce through their routes (content, drafts, reviews, grants, resources).
//
// STATE (compile-only sprint, 2026-10-14): not run. Members whose routes belong to lanes not merged yet throw `NotBuilt` naming the lane;
// the fixtures that stand in for CMD061/PrepareOutreachReview/CMD062 write the same rows by SQL under the owner's or the seller's own
// context (replace by `call(...)` when L-DRAFT/L-AUTH merge). Nothing here weakens a guard: `withoutSerializers` is todo (it needs a
// statement-rewrite seam in FaultRouting; see its message).
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { ContractFakeGmailSend, ContractFakeResend } from "@kauro/application/testing";
import type { OutreachPorts, OutreachSendPort, OutreachSubmission, OutreachSubmitAnswer } from "@kauro/application";
import { toUtcInstant, type CommerceUnitOfWorkFactory, type CorrelationId, type ExecutionContext, type UserId } from "@kauro/domain";
import { PgCommercialUnitOfWorkFactory, PgSalesRepository, type PgCommercialUnitOfWork } from "@kauro/persistence";
import { ROLES, TEST_EFFECT_FROZEN_SETTING, raceStatementTimeoutMs, recordActiveSeller, openConnection, TEST_CLOCK_OFFSET_SETTING, type RecordedSeller, type HarnessConnection, type FaultContext, type StepClock } from "@kauro/persistence/testing";
import { createOutreachDispatcher, outreachLeaseResource, type OutreachDispatcher, type OutreachLeaseRef } from "../src/outreach/dispatcher.js";
import { outreachSealerOf } from "../src/outreach/routes.js";
import type { OptOutKey, OutreachCompliance } from "../src/outreach/mime.js";
import type { SqlStep, StepClockOf } from "./fault-support.js";
import { prepareManifest, prepareTerminationTerms } from "./sellers-support.js";
import { statementsWorld } from "./statements-support.js";
import { call as callApi, clock, completed, freshKey, ids, outcome as outcomeOf, type Reply } from "./support.js";
import {
  CELL_CONTROLS,
  SUBJECT,
  T0,
  plusMs,
  type ClassifiedAnswer,
  type ComplianceConfig,
  type Control,
  type DispatchReport,
  type Dispatcher,
  type DraftP,
  type GmailAnswer,
  type GmailFake,
  type GmailSubmission,
  type GrantP,
  type HeldCall,
  type Person,
  type ProspectP,
  type Purpose,
  type ResendFake,
  type ResourceP,
  type SellerP,
  type SendWorld,
  type SenderP,
  type SenderRoute,
} from "./b12-send-support.js";

/** A member whose route belongs to a lane that is not merged (or whose seam is not built): it fails loudly, never answers a guess. */
export class NotBuilt extends Error {
  constructor(what: string, why: string) {
    super(`TODO(${what}): ${why}`);
    this.name = "NotBuilt";
  }
}
const notBuilt = (what: string, why: string): never => {
  throw new NotBuilt(what, why);
};

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const DEFAULT_COMPLIANCE: ComplianceConfig = { postalAddress: "100 Test Street, Suite 1, Wilmington, DE 19801, United States", optOutOrigin: "https://app.kauro.test", commercialIdentification: "Kauro commercial message" };
const OPT_OUT_KEY: OptOutKey = { version: "k1", secret: new Uint8Array(32).fill(5) };
/** Fixtures stand an hour before T0 on the labelled TEST CLOCK, so every row they write precedes the instants the cells judge at. */
const FIXTURE_AT = plusMs(T0, -3_600_000);

// --- the gmail fake as the cells see it ------------------------------------------------------------------------------------------------

function scriptOf(a: GmailAnswer, n: number): Parameters<ContractFakeGmailSend["script"]>[1] {
  switch (a.kind) {
    case "ACCEPTED":
      return { kind: "ACCEPTED", providerMessageRef: a.ref ?? `gmail-world-${n}` };
    case "ACCEPTED_ANSWER_LOST":
      return { kind: "LATE", providerMessageRef: `gmail-late-${n}` };
    case "AUTH_REVOKED":
      return { kind: "REJECTED", status: 401, reason: "AUTH_REVOKED" };
    case "REJECTED_DEFINITIVE":
    case "HTTP_5XX":
      return { kind: "REJECTED", status: a.status, reason: a.kind };
    case "TIMEOUT":
      return { kind: "UNKNOWN", reason: "TIMEOUT" };
    case "RESET":
    case "UNKNOWN":
      return { kind: "UNKNOWN", reason: "PROVIDER_ERROR" };
    case "NOT_ATTEMPTED":
      return notBuilt("gmail.script NOT_ATTEMPTED", "the port never answers NOT_ATTEMPTED: that answer is the closed start gate; script the gate through the clock instead");
  }
}

function answeredOf(a: OutreachSubmitAnswer): GmailSubmission["answered"] {
  if (a.kind === "ACCEPTED") return "ACCEPTED";
  if (a.kind === "REJECTED") return a.status === 401 ? "AUTH_REVOKED" : "REJECTED_DEFINITIVE";
  if (a.kind === "WARNING") return "REJECTED_DEFINITIVE";
  if (a.reason === "ABORTED") return "ABORTED";
  if (a.reason === "TIMEOUT") return "TIMEOUT";
  if (a.reason === "LOST_ANSWER") return "ACCEPTED_ANSWER_LOST";
  return "UNKNOWN";
}

/**
 * The Gmail port the dispatcher calls: records every submission, can hold the next call open until the test answers it (or the dispatcher's
 * AbortSignal fires: the abort then goes to the contract fake, which records it before answering UNKNOWN(ABORTED)), and delegates the
 * answer to the contract fake (which keeps the exact MIME for tokenFromSentMime).
 */
class WorldGmail implements OutreachSendPort, GmailFake {
  readonly route = "GMAIL_API" as const;
  readonly contract = new ContractFakeGmailSend();
  readonly submissions: GmailSubmission[] = [];
  #held: { reached: (s: GmailSubmission) => void; answer: Promise<GmailAnswer>; aborted: () => void } | null = null;
  #n = 0;

  script(...answers: GmailAnswer[]): void {
    for (const a of answers) this.contract.script(null, scriptOf(a, ++this.#n));
  }

  holdNext(): HeldCall {
    if (this.#held !== null) throw new Error("a hold is already armed");
    let resolveReached: (s: GmailSubmission) => void = () => undefined;
    const reached = new Promise<GmailSubmission>((resolve) => {
      resolveReached = resolve;
    });
    let giveAnswer: (a: GmailAnswer) => void = () => undefined;
    const answer = new Promise<GmailAnswer>((resolve) => {
      giveAnswer = resolve;
    });
    let abortedResolve: () => void = () => undefined;
    const aborted = new Promise<void>((resolve) => {
      abortedResolve = resolve;
    });
    this.#held = { reached: resolveReached, answer, aborted: abortedResolve };
    return { reached, answer: giveAnswer, aborted };
  }

  async submit(submission: OutreachSubmission, signal: AbortSignal): Promise<OutreachSubmitAnswer> {
    const entry: { -readonly [K in keyof GmailSubmission]: GmailSubmission[K] } = {
      intentId: submission.intentId,
      senderId: submission.senderId,
      mime: submission.mime,
      payloadHash: sha(submission.mime),
      answered: "HELD",
    };
    this.submissions.push(entry);
    const held = this.#held;
    this.#held = null;
    if (held !== null) {
      held.reached(entry);
      const aborted = new Promise<"aborted">((resolve) => {
        if (signal.aborted) resolve("aborted");
        else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      const first = await Promise.race([held.answer.then((a) => ({ a })), aborted.then(() => null)]);
      if (first === null) held.aborted();
      else this.contract.script(submission.intentId, scriptOf(first.a, ++this.#n));
    }
    const answer = await this.contract.submit(submission, signal);
    entry.answered = answeredOf(answer);
    return answer;
  }
}

class WorldResend implements OutreachSendPort, ResendFake {
  readonly route = "RESEND_TRANSACTIONAL" as const;
  readonly contract = new ContractFakeResend();
  get calls(): ReadonlyArray<{ readonly to: string; readonly payloadHash: string }> {
    return this.contract.calls.map((c) => ({ to: /^To:\s*(.+)$/im.exec(c.mime)?.[1]?.trim() ?? "", payloadHash: sha(c.mime) }));
  }
  submit(submission: OutreachSubmission, signal: AbortSignal): Promise<OutreachSubmitAnswer> {
    return this.contract.submit(submission, signal);
  }
}

// --- the outreach units of work ---------------------------------------------------------------------------------------------------------

/** kauro_outreach / kauro_control (and kauro_app) units whose SERVICE transactions stand on the labelled TEST CLOCK while the world stands at an instant. */
class OutreachUnits extends PgCommercialUnitOfWorkFactory {
  readonly #position: () => string | null;
  constructor(pools: ConstructorParameters<typeof PgCommercialUnitOfWorkFactory>[0], position: () => string | null) {
    super(pools, { clock, random: (n) => new Uint8Array(randomBytes(n)), defaultStatementTimeoutMs: raceStatementTimeoutMs() });
    this.#position = position;
  }
  override run<T>(context: ExecutionContext, work: (uow: PgCommercialUnitOfWork) => Promise<T>, options?: Parameters<PgCommercialUnitOfWorkFactory["run"]>[2]): Promise<T> {
    return super.run(
      context,
      async (uow) => {
        const at = this.#position();
        if (context.kind === "SERVICE" && at !== null) {
          await (uow as unknown as { client: Client }).client.query(`SELECT set_config('${TEST_CLOCK_OFFSET_SETTING}', greatest(0, extract(epoch FROM ($1::timestamptz - transaction_timestamp())))::text, true), set_config('${TEST_EFFECT_FROZEN_SETTING}', 'on', true)`, [at]);
        }
        return work(uow);
      },
      options,
    );
  }
}

// --- the world --------------------------------------------------------------------------------------------------------------------------

export async function sendWorldOf(_label: string): Promise<SendWorld> {
  // the public opt-out runs its SERVICE units on the same (routed) outreach units as the dispatcher; they exist once the world's pools do
  let optOutUnits: CommerceUnitOfWorkFactory | null = null;
  const sw = await statementsWorld({
    optOut: {
      keys: [OPT_OUT_KEY],
      units: {
        run: (context: ExecutionContext, work: never, options?: never) => {
          if (optOutUnits === null) throw new Error("the opt-out units are used before the world was built");
          return (optOutUnits as { run(...a: unknown[]): Promise<never> }).run(context, work, options);
        },
      } as unknown as CommerceUnitOfWorkFactory,
    },
    commercial: {
      outreachSealer: {
        seal: (facts) => outreachSealerOf({ compliance: state.compliance, optOutKey: OPT_OUT_KEY }).seal(facts),
      },
    },
  });
  const { w, h } = sw;
  // the cells judge the user commands (CMD063, the owner's and seller's routes) at stated instants: every unit's transaction stands on the clock
  sw.faults.positionEveryUnit = true;
  const state: { compliance: OutreachCompliance | null; standing: string | null } = { compliance: { ...DEFAULT_COMPLIANCE }, standing: null };
  /** Fixtures stand an hour before the instant the world stands at (so their rows precede the instants the cells judge at), else before T0. */
  const fixtureAt = (): string => (state.standing === null ? FIXTURE_AT : plusMs(state.standing, -3_600_000));
  let standClock: StepClockOf | null = null;
  let boundClock: StepClock | null = null;
  /** The clock the units are positioned on, with the effect clock frozen on it: kauro.effect_now() reads the controlled instant exactly (the test cluster's TEST_EFFECT_FUNCTION). */
  const frozenOf = (c: StepClock): StepClockOf => ({
    async onServer(session) {
      const placed = await c.onServer(session);
      await session.query(`SELECT set_config('${TEST_EFFECT_FROZEN_SETTING}', 'on', true)`);
      return placed;
    },
  });
  /** The clock a unit stands on while the world stands at `at`: the instant to the microsecond (the cells judge boundaries 1 us apart), the effect clock frozen on it. */
  const stoodAt = (at: string): StepClockOf => ({
    async onServer(session) {
      await session.query(`SELECT set_config('${TEST_CLOCK_OFFSET_SETTING}', extract(epoch FROM ($1::timestamptz - transaction_timestamp()))::text, true), set_config('${TEST_EFFECT_FROZEN_SETTING}', 'on', true)`, [at]);
    },
  });
  /** A fresh step-up of the person at the instant the world stands at (a proof minted at the real clock is stale for a unit standing days ahead). */
  const stepUp = (person: Parameters<typeof w.stepUp>[0]): Promise<string> =>
    state.standing === null ? w.stepUp(person) : h.recordStepUp(person.userId as UserId, { issuedAt: toUtcInstant(Date.parse(state.standing) - 1000) });
  const gmail = new WorldGmail();
  const resend = new WorldResend();
  const ports: OutreachPorts = { gmail, resend };
  const units = sw.faults.wrap(new OutreachUnits({ app: h.appPool, outreach: h.outreachPool, control: h.controlPool }, () => state.standing));
  optOutUnits = units as unknown as CommerceUnitOfWorkFactory;
  const background: Array<{ correlationId: string; error: unknown }> = [];
  const runtime = {
    units,
    clock: sw.clock,
    ids,
    ports,
    get compliance(): OutreachCompliance | null {
      return state.compliance;
    },
    optOutKey: OPT_OUT_KEY,
    hold: null,
    onBackgroundFailure: (correlationId: string, error: unknown) => void background.push({ correlationId, error }),
  };
  let statementTimeout: number | null = null;
  const dispatchers = new Map<string, Dispatcher>();
  let leaseHolder: string | null = null;
  const renewers = new Map<string, () => Promise<number>>();

  /** One transaction of a runtime role under a person's OPERATOR context on the TEST CLOCK at `at` (a fixture standing in for a lane's route). */
  const within = async <T>(userId: string, at: string, fn: (c: Client) => Promise<T>): Promise<T> => {
    const c = await h.pg.connect("kauro_app_test");
    try {
      await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        await c.query("SELECT set_config('kauro.agency_id', '', true), set_config('kauro.user_id', $1, true), set_config('kauro.finance_agency_id', '', true)", [userId]);
        await c.query(`SELECT set_config('${TEST_CLOCK_OFFSET_SETTING}', extract(epoch FROM ($1::timestamptz - transaction_timestamp()))::text, true)`, [at]);
        const out = await fn(c);
        await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    } finally {
      await c.end();
    }
  };
  const lock = (c: Client, kind: string, subject: string, mode: "X" | "S" = "X"): Promise<unknown> =>
    c.query(`SELECT ${mode === "X" ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared"}(kauro.transition_key($1, $2))`, [kind, subject]);

  const owner = sw.owner; // the corporate KAURO_OWNER (statements world), not the agency owner of w
  const recorded = new Map<string, RecordedSeller>();
  let seq = 0;

  const content = async (userId: string, label: string): Promise<{ id: string; subject: string; body: string }> => {
    const subject = `Data migration help ${label}`;
    const body = `Hello, we move CRM data safely. ${label}`;
    const id = createHash("sha256").update(`KAURO_OUTREACH_CONTENT_V1\n${subject}\n${body}`, "utf8").digest("hex");
    await within(userId, fixtureAt(), (c) => c.query("INSERT INTO kauro.outreach_contents (content_id, subject, body, recorded_by_user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [id, subject, body, userId]));
    return { id, subject, body };
  };

  const publish = async (family: string, capabilityId: string, label: string): Promise<ResourceP> => {
    const resourceId = ids.next();
    const cref = await content(owner.userId, `resource-${label}`);
    await within(owner.userId, fixtureAt(), async (c) => {
      await lock(c, "kauro.sales_resources", family);
      await c.query("INSERT INTO kauro.sales_resources (resource_id, family_id, version, content_id, published_by_user_id) VALUES ($1, $2, 1, $3, $4)", [resourceId, family, cref.id, owner.userId]);
      await c.query("INSERT INTO kauro.sales_resource_capabilities (resource_id, capability_id) VALUES ($1, $2)", [resourceId, capabilityId]);
    });
    return { resourceId, familyId: family, capabilityId };
  };
  const defaultResource = await publish(ids.next(), w.cleanCapabilityId, "default");

  const api = (c: { readonly method?: "POST" | "GET"; readonly url: string; readonly token: string | null; readonly key?: string | null; readonly body?: unknown }): Promise<Reply> =>
    callApi(w, { ...(c.method !== undefined ? { method: c.method } : {}), url: c.url, agency: null, token: c.token, key: c.key === undefined ? (c.method === "GET" ? null : freshKey("b12")) : c.key, ...(c.body !== undefined ? { body: c.body } : {}) });

  /**
   * The wire activity of CMD064 for the cells' compact one: `{ kind, intentId, evidenceRef | inboundRef, observation?, reason? }` names the intent and what the
   * evidence is; the prospect and the draft are the intent's, the instant the one the world stands at, the evidence digest that of the reference. An activity
   * that already names its prospect (a forged one) goes on as given, with the members it omits filled.
   */
  const wireActivity = async (a: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const at = toUtcInstant(state.standing !== null ? Date.parse(state.standing) : Date.now());
    if (typeof a["prospectId"] === "string") return { occurredAt: at, evidenceHash: sha(`evidence-${String(a["providerMessageRef"] ?? "")}`), ...a };
    const intentId = String(a["intentId"]);
    const row = (await h.oracle.query<{ prospect_id: string; draft_id: string }>("SELECT prospect_id, draft_id FROM kauro.outreach_send_intents WHERE intent_id = $1", [intentId])).rows[0];
    if (row === undefined) throw new Error(`no intent ${intentId} for the activity`);
    const kind = String(a["kind"]);
    const evidenceRef = String(a["evidenceRef"] ?? a["inboundRef"] ?? `${kind}-${intentId}`);
    const out: Record<string, unknown> = { prospectId: row.prospect_id, draftId: row.draft_id, kind, occurredAt: at, evidenceHash: sha(evidenceRef), providerMessageRef: kind === "REPLIED" || kind === "BOUNCED" ? evidenceRef : "NONE" };
    if (kind === "HUMAN_SEND_OBSERVED") out["observation"] = a["observation"];
    if (kind === "SUPPRESSED") {
      out["suppressionKeyKind"] = a["keyKind"] ?? "CONTACT";
      out["suppressionReason"] = a["reason"];
    }
    return out;
  };

  const registerSender: SendWorld["routes"]["registerSender"] = async (body, options = {}) =>
    api({ url: "/api/v1/ops/outreach/senders", token: options.token ?? owner.token, ...(options.key !== undefined ? { key: options.key } : {}), body: { ...body, assuranceProofRef: await stepUp(owner) } });
  const verifySender: SendWorld["routes"]["verifySender"] = (senderId, key) =>
    api({ url: `/api/v1/ops/outreach/senders/${senderId}/verify`, token: owner.token, ...(key !== undefined ? { key } : {}), body: { verificationEvidenceHash: sha(`verified-${senderId}`) } });
  const revokeSender: SendWorld["routes"]["revokeSender"] = (senderId, key) =>
    api({ url: `/api/v1/ops/outreach/senders/${senderId}/revoke`, token: owner.token, ...(key !== undefined ? { key } : {}), body: {} });

  const sender: SendWorld["sender"] = async (person, options = {}) => {
    const route: SenderRoute = options.route ?? "GMAIL_API";
    const address = `sender-${++seq}-${ids.next().slice(-6)}@mail.example`;
    const reply = await registerSender({ userId: person.userId, address, route, ...(route === "GMAIL_API" ? { consentEvidenceRef: sha(`consent-${address}`) } : {}) });
    const senderId = completed<{ senderId: string }>(reply, 201).data.senderId;
    if (options.pending !== true) completed(await verifySender(senderId), 200);
    return { senderId, userId: person.userId, route, address };
  };

  const world: SendWorld = {
    oracle: h.oracle,
    owner,
    gmail,
    resend,
    gmailContract: gmail.contract,
    async renewLease() {
      // the lease of the dispatcher that holds it, claimed again at the instant the bound clock stands on (a dispatcher heartbeats; a cell that moves the
      // effect clock days ahead of the lease would otherwise judge it expired before the interleaving it stages)
      const renew = leaseHolder === null ? undefined : renewers.get(leaseHolder);
      if (renew === undefined || boundClock === null) return;
      sw.clock.standAt?.(boundClock.now());
      try {
        await renew();
      } finally {
        sw.clock.standAt?.(null);
      }
    },
    async beginCell() {
      dispatchers.clear();
      leaseHolder = null;
      await h.oracle.query("DELETE FROM kauro.leases WHERE resource_kind = 'OUTBOX_DISPATCH' AND resource_id = $1", [outreachLeaseResource()]);
    },
    get internalErrors() {
      return sw.w.internalErrors;
    },
    get compliance(): ComplianceConfig {
      return state.compliance ?? DEFAULT_COMPLIANCE;
    },
    async stop() {
      await sw.stop();
    },
    standAt(at) {
      state.standing = at;
      sw.standAt(at);
      sw.clock.standAt?.(at);
      // "every unit's effect clock stands at the instant": the commission and outreach services' units stand through `standing`; the api's own
      // units (CMD063 and the owner and seller routes) are positioned on a clock held still at the instant, unless a cell's step clock is bound
      standClock = at === null ? null : stoodAt(at);
      sw.faults.clock = boundClock !== null ? frozenOf(boundClock) : standClock;
    },
    bindClock(c: StepClock | null) {
      boundClock = c;
      sw.faults.clock = boundClock !== null ? frozenOf(boundClock) : standClock;
    },
    setCompliance(config) {
      const before = state.compliance;
      state.compliance = config === null ? null : { ...config };
      return () => {
        state.compliance = before;
      };
    },
    async seller(label) {
      const person = await w.person(`seller-${label}`);
      const seller = await recordActiveSeller(h, { ownerUserId: owner.userId as UserId, subject: label });
      if (seller.userId !== person.userId) throw new Error("the seller is the person the token names");
      recorded.set(seller.sellerId, seller);
      return { userId: person.userId, token: person.token, sellerId: seller.sellerId, sender: await sender(person) } satisfies SellerP;
    },
    async agencyMember(label) {
      const person = await w.person(`member-${label}`);
      await h.addMember(w.A, person.userId, "BILLING");
      return person;
    },
    async prospect(seller, options = {}) {
      if (options.jurisdiction !== undefined && options.jurisdiction !== "United States") return notBuilt("world.prospect jurisdiction", "only the US prospect is seeded; a non-US jurisdiction row needs the L-SOURCE route (regen at batch)");
      const domain = options.organization ?? `org-${++seq}-${ids.next().slice(-6)}.example`;
      const prospectId = ids.next();
      const contactId = ids.next();
      const address = options.contact ?? `lead-${seq}-${prospectId.slice(-6)}@${domain}`;
      const contactKey = sha(`KAURO_PROSPECT_CONTACT_V1\n${address}`);
      const organizationKey = sha(`organization:${domain}`);
      const evidenceHash = sha(`source-evidence-${prospectId}`);
      await within(seller.userId, fixtureAt(), async (c) => {
        await c.query(
          "INSERT INTO kauro.prospect_source_evidence (evidence_id, recorded_by_user_id, seller_id, evidence_hash, source_url_digest, observed_on, lawful_basis, segment, created_at) VALUES ($1, $2, $3, $4, $5, current_date, 'LEGITIMATE_INTEREST', 'AGENCY', now())",
          [ids.next(), seller.userId, seller.sellerId, evidenceHash, sha(`https://${domain}/`)],
        );
        await c.query("INSERT INTO kauro.prospect_contacts (contact_id, recorded_by_user_id, contact_key, contact_label, role_label, channel, created_at) VALUES ($1, $2, $3, 'Operations lead', 'Head of operations', 'EMAIL', now())", [contactId, seller.userId, contactKey]);
        await c.query("INSERT INTO kauro.prospect_contact_addresses (contact_id, recorded_by_user_id, address) VALUES ($1, $2, $3)", [contactId, seller.userId, address]);
        await c.query(
          `INSERT INTO kauro.prospects (prospect_id, organization_label, organization_key, business_contact_id, source_evidence_hash, jurisdiction, registered_by_user_id, registered_by_seller_id, owner_seller_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'United States', $6, $7, $7, now(), now())`,
          [prospectId, `${domain} agency`, organizationKey, contactId, evidenceHash, seller.userId, seller.sellerId],
        );
      });
      return { prospectId, contactKey, organizationKey, sellerId: seller.sellerId } satisfies ProspectP;
    },
    sender,
    resource: defaultResource,
    async draft(author, prospect, snd, options = {}) {
      const purpose: Purpose = options.purpose ?? "INDIVIDUAL_PROSPECT_CONTACT";
      const cref = options.contentRef ?? (await content(author.userId, `${prospect.prospectId}-${purpose}-${options.label ?? ids.next().slice(-6)}`)).id;
      const draftId = ids.next();
      const contentHash = createHash("sha256").update(["KAURO_OUTREACH_BINDING_V1", prospect.prospectId, prospect.contactKey, snd.senderId, purpose, cref].join("\n"), "utf8").digest("hex");
      const resource = options.resource ?? defaultResource;
      await within(author.userId, fixtureAt(), async (c) => {
        await c.query(
          "INSERT INTO kauro.outreach_drafts (draft_id, prospect_id, sender_id, author_user_id, purpose, content_ref, contact_key, content_hash, provenance_evidence_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [draftId, prospect.prospectId, snd.senderId, author.userId, purpose, cref, prospect.contactKey, contentHash, sha(`provenance-${prospect.prospectId}`)],
        );
        await c.query("INSERT INTO kauro.outreach_draft_resources (draft_id, resource_id) VALUES ($1, $2)", [draftId, resource.resourceId]);
      });
      return { draftId, version: 1, contentHash, contentRef: cref, prospect, sender: snd, purpose } satisfies DraftP;
    },
    async freshResource(label) {
      const capabilityId = ids.next();
      await h.oracle.query(
        `INSERT INTO kauro.capabilities (capability_id, version, kind, mode, state, profile_hash, qualification_evidence_hashes, review_trigger, created_at, updated_at)
         VALUES ($1, $2, 'OPERATION', NULL, 'DESIGN', $3, '[]'::jsonb, 'VENDOR_OR_ENVELOPE_CHANGE', now(), now())`,
        [capabilityId, `b12-${capabilityId.slice(-8)}`, sha(`capability-${capabilityId}`)],
      );
      // a capability is born DESIGN and reaches AVAILABLE along the listed edges, as the control plane walks it
      await h.publishCapability(capabilityId as never, "AVAILABLE");
      return publish(ids.next(), capabilityId, label);
    },
    async metrics(actor, personUserId) {
      // GetOutreachMetrics answers the caller's own policies: the person asks for itself; the pause rule is a bounce among its counted sends
      const r = await api({ method: "GET", url: "/api/v1/ops/outreach/metrics", token: actor.token, key: null });
      if (r.status !== 200) throw new Error(`GetOutreachMetrics answered ${r.status}: ${r.text}`);
      const v = r.json<{ data: Record<string, number> }>();
      const m = v.data;
      // the pause rule (0088 KC034): a bounce among the latest counted sends, or a provider warning after the person's latest diagnosis
      const warned = (await h.oracle.query<{ warned: boolean }>("SELECT EXISTS (SELECT 1 FROM kauro.outreach_provider_warnings w WHERE w.person_user_id = $1 AND w.recorded_at > coalesce((SELECT max(recorded_at) FROM kauro.outreach_diagnoses WHERE person_user_id = $1), '-infinity'::timestamptz)) AS warned", [personUserId])).rows[0]!.warned;
      return { accepted: m["accepted"]!, uncertain: m["uncertain"]!, bounced: m["bounced"]!, pauseNumerator: m["pauseNumerator"]!, pauseDenominator: m["pauseDenominator"]!, paused: m["pauseNumerator"]! > 0 || warned };
    },
    async grant(drafts, options = {}) {
      const first = drafts[0];
      if (first === undefined) throw new Error("a grant needs at least one draft");
      const reviewId = ids.next();
      const proofId = await stepUp(owner);
      const authorizationId = ids.next();
      const expiresAt = options.expiresAt ?? plusMs(fixtureAt(), 13 * 86_400_000);
      // a grant lives at most 14 days from its start (KC030): a window that ends later than that from the fixture instant starts 14 days before its end
      const validFrom = options.validFrom ?? (Date.parse(expiresAt) - Date.parse(fixtureAt()) > 14 * 86_400_000 ? plusMs(expiresAt, -14 * 86_400_000) : fixtureAt());
      // PrepareOutreachReview and CMD062 are L-AUTH routes: the same rows by SQL under the owner's own context until they merge
      await within(owner.userId, fixtureAt(), async (c) => {
        await c.query("INSERT INTO kauro.outreach_reviews (review_id, owner_user_id, proof_id, sender_id, digest, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, now(), now() + interval '15 minutes')", [reviewId, owner.userId, proofId, first.sender.senderId, sha(`review-${reviewId}`)]);
        for (const d of drafts) await c.query("INSERT INTO kauro.outreach_review_items (review_id, draft_id, draft_version, content_hash, contact_label) VALUES ($1, $2, 1, $3, 'Operations lead')", [reviewId, d.draftId, d.contentHash]);
      });
      const maximumSends = options.maximumSends ?? drafts.length;
      await within(owner.userId, plusMs(fixtureAt(), 1000), async (c) => {
        await c.query(
          "INSERT INTO kauro.outreach_authorizations (authorization_id, review_id, granting_user_id, sender_id, proof_id, valid_from, expires_at, maximum_sends, permission_evidence_hash, policy_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'outreach-v1')",
          [authorizationId, reviewId, owner.userId, first.sender.senderId, proofId, validFrom, expiresAt, maximumSends, sha(`permission-${authorizationId}`)],
        );
        for (const d of drafts) await c.query("INSERT INTO kauro.outreach_authorization_hashes (authorization_id, draft_id, content_hash) VALUES ($1, $2, $3)", [authorizationId, d.draftId, d.contentHash]);
      });
      return { authorizationId, senderId: first.sender.senderId, maximumSends, validFrom, expiresAt } satisfies GrantP;
    },
    call: api,
    // KC032 is one family on the wire: the cap itself (OUTREACH_CAP_REACHED) and the reasons it names beside it (CADENCE_CLOSED, OUTSIDE_BUSINESS_DAY,
    // FIRST_NOT_SENT); the cells state the family by its code and the member by `subReason`
    outcome: (reply) => outcomeOf(w, reply).replace(/^(409 PRECONDITION_FAILED) (CADENCE_CLOSED|OUTSIDE_BUSINESS_DAY|FIRST_NOT_SENT)$/, "$1 OUTREACH_CAP_REACHED"),
    subReason(reply) {
      const reason = reply.json<{ reason?: string }>().reason;
      if (reason === "OUTREACH_CAP_REACHED") return "CAP_REACHED";
      return reason === "CADENCE_CLOSED" || reason === "OUTSIDE_BUSINESS_DAY" || reason === "FIRST_NOT_SENT" ? reason : null;
    },
    dispatcher(name = "dispatcher") {
      // one dispatcher (one lease owner) per name: a second owner would find the lease HELD until it expires
      const known = dispatchers.get(name);
      if (known !== undefined) return known;
      const d: OutreachDispatcher = createOutreachDispatcher(runtime);
      let fence: number | null = null;
      const admitted = new Map<string, Parameters<OutreachDispatcher["submit"]>[0]>();
      let leasedAt: string | null = null;
      let explicit = false;
      // the lease is claimed again only once it ran out on the clock the world stands at (a lease still valid keeps its fence: the old owner of a
      // takeover cell must not renew the lease the new owner is about to claim)
      const leaseExpiredAt = (standing: string | null, since: string | null): boolean => standing !== null && since !== null && Date.parse(standing) >= Date.parse(since) + 120_000;
      const takeOver = async (): Promise<number> => {
        const r = await d.takeOver();
        if (r.kind === "HELD") throw new Error(`${name}: another dispatcher holds the OUTBOX_DISPATCH lease`);
        fence = r.fence;
        leasedAt = state.standing;
        leaseHolder = name;
        return r.fence;
      };
      const lease = async (): Promise<OutreachLeaseRef> => {
        // a lease lives 120 s on the clock the world stands at: standing somewhere else, the dispatcher's own lease is claimed again
        // an owner another dispatcher took the lease from keeps its stale fence (its late answers are fenced, never re-leased)
        // a dispatcher the cell took over explicitly keeps its fence until the lease ran out; one that leases implicitly claims again wherever the world stands
        const again = explicit ? leaseExpiredAt(state.standing, leasedAt) : state.standing !== leasedAt;
        if (fence === null || (boundClock === null && (leaseHolder === null || leaseHolder === name) && again)) await takeOver();
        return { resourceId: d.resourceId, ownerId: d.ownerId, fence: fence as number };
      };
      const adapter: Dispatcher = {
        name,
        async pass() {
          // "every due record": the dispatcher claims 25 per pass, so a world holding more due records than that (the QUEUED intents earlier cells of a
          // file leave) is passed again until a pass fills less than its batch
          const reports: DispatchReport[] = [];
          for (let round = 0; round < 40; round++) {
            const r = await d.pass();
            if (r.fence !== null) fence = r.fence;
            reports.push(...r.deliveries.map((x): DispatchReport => ({ intentId: x.intentId, outcome: x.intentState ?? x.outcome })));
            if (r.deliveries.length < 25) break;
          }
          return reports;
        },
        async dispatch(intentId) {
          const r = await d.dispatch(intentId, await lease());
          return { intentId, outcome: r.intentState ?? r.outcome };
        },
        async claim(intentId) {
          const v = await d.claim(intentId, await lease());
          if (v.kind === "ADMITTED") {
            admitted.set(intentId, { ...v.submission, fence: v.fence });
            return "ADMITTED";
          }
          if (v.kind === "DEFERRED") return "DEFERRED";
          if (v.kind === "REFUSED") return `${v.state}(${v.reason})`;
          return `${v.state}(GONE)`;
        },
        async submit(intentId): Promise<ClassifiedAnswer> {
          const claimed = admitted.get(intentId);
          if (claimed === undefined) throw new Error(`${name}: intent ${intentId} was not admitted by this dispatcher's claim`);
          // D3 follows its own D2 under the lease reference that claim used (dispatch passes one reference through claim and submit)
          return d.call(claimed, { resourceId: d.resourceId, ownerId: d.ownerId, fence: claimed.fence });
        },
        async record(intentId, answer) {
          return d.record(intentId, await lease(), answer);
        },
        async recover() {
          return d.recover(await lease());
        },
        get fence() {
          return fence;
        },
        takeOver: async () => {
          explicit = true;
          return takeOver();
        },
      };
      dispatchers.set(name, adapter);
      renewers.set(name, takeOver);
      return adapter;
    },
    async open(login) {
      return openConnection(h.pg.clientConfig(login === "superuser" ? "postgres" : login));
    },
    on<T>(conn: HarnessConnection, role: "kauro_app" | "kauro_outreach" | "kauro_control", ctx: FaultContext, steps: ReadonlyArray<SqlStep>, fn: () => Promise<T>, routing?: { readonly target?: number }): Promise<T> {
      // a command crosses roles (the dispatcher takes its lease as kauro_control, then claims as kauro_outreach; an api route may read as
      // kauro_app): every other role of the world gets its own connection, as in production, and only `role` is the cell's
      return (async () => {
        const extras: Partial<Record<"kauro_app" | "kauro_outreach" | "kauro_control", HarnessConnection>> = {};
        const opened: HarnessConnection[] = [];
        try {
          for (const other of ["kauro_app", "kauro_outreach", "kauro_control"] as const) {
            if (other === role) continue;
            const c = await world.open(`${other}_test`);
            opened.push(c);
            extras[other] = c;
          }
          return await sw.faults.onRoles({ [role]: conn, ...extras }, ctx.points, steps, fn, routing ?? {});
        } finally {
          for (const c of opened) await c.end().catch(() => undefined);
        }
      })();
    },
    setStatementTimeout(ms) {
      statementTimeout = ms;
      sw.faults.statementTimeoutMs = ms;
    },
    leaseResourceId: outreachLeaseResource(),
    async contentOf(d) {
      const r = await h.oracle.query<{ subject: string; body: string }>("SELECT subject, body FROM kauro.outreach_contents WHERE content_id = $1", [d.contentRef]);
      const row = r.rows[0];
      if (row === undefined) throw new Error(`no content ${d.contentRef}`);
      return { subject: row.subject, body: row.body };
    },
    async withoutSerializers<T>(control: Control, fn: () => Promise<T>): Promise<T> {
      void CELL_CONTROLS;
      void statementTimeout;
      // built for the controls whose set is advisory subjects of §L only and that drop no co-guard (M21, M22, M23...: L8); a control naming a row lock,
      // a lease or a co-guard is not removed here and says so instead of running half-removed
      const kinds = control.locks.map((l) => SUBJECT[l]);
      if (control.coGuards.length > 0 || kinds.some((k) => k === undefined)) {
        return notBuilt("world.withoutSerializers", `a control with co-guards or non-advisory locks (${control.locks.join(", ")}; ${control.coGuards.join(", ") || "no co-guard"})`);
      }
      const dropped = kinds as string[];
      // the database's half: kauro.outreach_require_lock (T2) asserts the dropped kinds no more while the control runs; restored verbatim after
      const original = (await h.oracle.query<{ def: string }>("SELECT pg_get_functiondef('kauro.outreach_require_lock(text,text,text,text)'::regprocedure) AS def")).rows[0]!.def;
      await h.oracle.query(
        `CREATE OR REPLACE FUNCTION kauro.outreach_require_lock(kind text, subject text, mode text, what text) RETURNS void
           LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS
         $control$
         BEGIN
           IF kind = ANY (ARRAY[${dropped.map((k) => `'${k.replace(/'/g, "''")}'`).join(", ")}]::text[]) THEN RETURN; END IF;
           IF subject IS NULL OR NOT kauro.outreach_lock_held(kind, subject, mode) THEN
             RAISE EXCEPTION 'LOCK_NOT_HELD: % requires % % of %', what, kind, mode, coalesce(subject, '(none)') USING ERRCODE = 'KA096';
           END IF;
         END
         $control$`,
      );
      try {
        // the units' half: every routed acquisition of the dropped kinds takes nothing
        return await sw.faults.droppingLocks(dropped, fn);
      } finally {
        await h.oracle.query(original);
      }
    },
    async prospectAs(person, prospectId) {
      // the product's own reader (PgSalesRepository.getProspect) in the person's own session: what the seller or the owner is shown, under its RLS
      return within(person.userId, state.standing ?? FIXTURE_AT, async (c) => {
        const p = await new PgSalesRepository(c, ids).getProspect(prospectId as never);
        return p === null ? null : { state: p.state, suppressed: p.suppressed, version: p.version, ownerSellerId: p.ownerSellerId ?? null };
      });
    },
    routes: {
      revokeGrant: (g, key) => api({ url: `/api/v1/ops/outreach/authorizations/${g.authorizationId}/revoke`, token: owner.token, ...(key !== undefined ? { key } : {}), body: {} }),
      async terminate(seller, key) {
        // CMD050 TerminateSeller by the corporate owner (the shape of integration-support terminationBody with nothing handed over)
        const row = await h.oracle.query<{ version: string }>("SELECT version::text FROM kauro.sellers WHERE seller_id = $1", [seller.sellerId]);
        if (row.rows[0] === undefined) throw new Error(`no seller ${seller.sellerId}`);
        return api({
          url: `/api/v1/sales/sellers/${seller.sellerId}/terminate`,
          token: owner.token,
          ...(key !== undefined ? { key } : {}),
          body: {
            expectedVersion: Number(row.rows[0].version),
            terminationTermsRef: await prepareTerminationTerms(h, owner.userId as UserId, seller.sellerId),
            activeOpportunityManifestRef: await prepareManifest(h, owner.userId as UserId, seller.sellerId, []),
          },
        });
      },
      async suspendCapability(capabilityId, key) {
        // CMD059 RestrictCapability by the corporate owner
        const row = await h.oracle.query<{ revision: number }>("SELECT revision FROM kauro.capabilities WHERE capability_id = $1", [capabilityId]);
        if (row.rows[0] === undefined) throw new Error(`no capability ${capabilityId}`);
        return api({ url: `/api/v1/operations/capabilities/${capabilityId}/restrict`, token: owner.token, ...(key !== undefined ? { key } : {}), body: { expectedVersion: row.rows[0].revision, incidentRef: ids.next() } });
      },
      async publishResource(familyId, key) {
        // the next version of the family, claiming what the current one claims, under a fresh step-up of the owner
        const cur = (await h.oracle.query<{ resource_id: string; version: number }>("SELECT resource_id, version::int AS version FROM kauro.sales_resources WHERE family_id = $1 AND state = 'CURRENT'", [familyId])).rows[0];
        if (cur === undefined) throw new Error(`no CURRENT resource in family ${familyId}`);
        const claims = (await h.oracle.query<{ capability_id: string }>("SELECT capability_id FROM kauro.sales_resource_capabilities WHERE resource_id = $1 ORDER BY capability_id", [cur.resource_id])).rows.map((r) => r.capability_id);
        const next = await content(owner.userId, `family-${familyId.slice(-6)}-v${cur.version + 1}`);
        return api({ url: "/api/v1/ops/sales/resources", token: owner.token, ...(key !== undefined ? { key } : {}), body: { familyId, expectedVersion: cur.version, contentRef: next.id, capabilityIds: claims, assuranceProofRef: await stepUp(owner) } });
      },
      async withdrawPolicy(jurisdiction, purpose, key) {
        const cur = (await h.oracle.query<{ version: number }>("SELECT max(version)::int AS version FROM kauro.outreach_channel_policies WHERE jurisdiction = $1 AND purpose = $2", [jurisdiction, purpose])).rows[0];
        if (cur?.version == null) throw new Error(`no channel policy for ${jurisdiction} ${purpose}`);
        return api({ url: "/api/v1/ops/outreach/policy-withdrawals", token: owner.token, ...(key !== undefined ? { key } : {}), body: { jurisdiction, purpose, expectedVersion: cur.version, assuranceProofRef: await stepUp(owner) } });
      },
      registerSender,
      verifySender,
      revokeSender,
      async recordActivity(actor, activity, key) {
        return api({ url: "/api/v1/ops/sales/activities", token: actor.token, ...(key !== undefined ? { key } : {}), body: { activity: await wireActivity(activity) } });
      },
      // RFC 8058: the one-click POST of the mail client, no credential, no key, no agency
      optOut: (token) => callApi(w, { url: `/api/v1/public/outreach/opt-out/${token}`, token: null, key: null, agency: null, contentType: "application/x-www-form-urlencoded", rawBody: "List-Unsubscribe=One-Click" }),
      async diagnose(personUserId, key) {
        return api({ url: "/api/v1/ops/outreach/diagnoses", token: owner.token, ...(key !== undefined ? { key } : {}), body: { personUserId, evidenceHash: sha(`diagnosis-${personUserId}-${ids.next()}`), assuranceProofRef: await stepUp(owner) } });
      },
      async review(drafts, key) {
        const first = drafts[0];
        if (first === undefined) throw new Error("a review needs at least one draft");
        return api({ url: "/api/v1/ops/outreach/reviews", token: owner.token, ...(key !== undefined ? { key } : {}), body: { senderIdentityRef: first.sender.senderId, draftIds: drafts.map((d) => d.draftId), assuranceProofRef: await stepUp(owner) } });
      },
      async suppress(target) {
        // the registry row of the 0029 writer under L8 X of its key (the L-ACT route writes the same row; ON CONFLICT DO NOTHING as every writer)
        const keyKind = "contactKey" in target ? "CONTACT" : "ORGANIZATION";
        const key = "contactKey" in target ? target.contactKey : sha(`organization:${target.domain}`);
        await within(owner.userId, state.standing ?? FIXTURE_AT, async (c) => {
          await lock(c, "kauro.prospect_suppressions", `${keyKind}:${key}`);
          await c.query(
            "INSERT INTO kauro.prospect_suppressions (suppression_id, key_kind, suppression_key, reason, recorded_by_user_id, recorded_by_service, recorded_at, created_at) VALUES ($1, $2, $3, 'OPT_OUT', $4, NULL, kauro.server_now(), now()) ON CONFLICT DO NOTHING",
            [ids.next(), keyKind, key, owner.userId],
          );
        });
      },
      // a re-review of the withdrawn policy: the owner's reviewed next version, IN_FORCE (no route names it; the policy table is append-only).
      // It throws unless the latest version reads IN_FORCE afterwards.
      async reinstatePolicy(jurisdiction, purpose) {
        await h.oracle.query(
          "INSERT INTO kauro.outreach_channel_policies (jurisdiction, purpose, version) SELECT $1, $2, coalesce(max(version), 0) + 1 FROM kauro.outreach_channel_policies WHERE jurisdiction = $1 AND purpose = $2",
          [jurisdiction, purpose],
        );
        const latest = (await h.oracle.query<{ state: string }>("SELECT state FROM kauro.outreach_channel_policies WHERE jurisdiction = $1 AND purpose = $2 ORDER BY version DESC LIMIT 1", [jurisdiction, purpose])).rows[0];
        if (latest?.state !== "IN_FORCE") throw new Error(`the ${jurisdiction} ${purpose} policy is not IN_FORCE after its re-review`);
      },
    },
  };
  void T0;
  void ROLES;
  void (null as unknown as CorrelationId);
  return world;
}
