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
import type { CorrelationId, ExecutionContext, UserId } from "@kauro/domain";
import { PgCommercialUnitOfWorkFactory, type PgCommercialUnitOfWork } from "@kauro/persistence";
import { ROLES, raceStatementTimeoutMs, recordActiveSeller, openConnection, TEST_CLOCK_OFFSET_SETTING, type RecordedSeller, type HarnessConnection, type FaultContext, type StepClock } from "@kauro/persistence/testing";
import { createOutreachDispatcher, outreachLeaseResource, type OutreachDispatcher, type OutreachLeaseRef } from "../src/outreach/dispatcher.js";
import { outreachSealerOf } from "../src/outreach/routes.js";
import type { OptOutKey, OutreachCompliance } from "../src/outreach/mime.js";
import type { SqlStep } from "./fault-support.js";
import { prepareManifest, prepareTerminationTerms } from "./sellers-support.js";
import { statementsWorld } from "./statements-support.js";
import { call as callApi, clock, completed, freshKey, ids, outcome as outcomeOf, type Reply } from "./support.js";
import {
  CELL_CONTROLS,
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
const OPT_OUT_KEY: OptOutKey = { version: 1, secret: "b12-send-world-opt-out-secret-not-a-credential" };
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
          await (uow as unknown as { client: Client }).client.query(`SELECT set_config('${TEST_CLOCK_OFFSET_SETTING}', greatest(0, extract(epoch FROM ($1::timestamptz - transaction_timestamp())))::text, true)`, [at]);
        }
        return work(uow);
      },
      options,
    );
  }
}

// --- the world --------------------------------------------------------------------------------------------------------------------------

export async function sendWorldOf(_label: string): Promise<SendWorld> {
  const sw = await statementsWorld({
    commercial: {
      outreachSealer: {
        seal: (facts) => outreachSealerOf({ compliance: state.compliance, optOutKey: OPT_OUT_KEY }).seal(facts),
      },
    },
  });
  const { w, h } = sw;
  const state: { compliance: OutreachCompliance | null; standing: string | null } = { compliance: { ...DEFAULT_COMPLIANCE }, standing: null };
  const gmail = new WorldGmail();
  const resend = new WorldResend();
  const ports: OutreachPorts = { gmail, resend };
  const units = sw.faults.wrap(new OutreachUnits({ app: h.appPool, outreach: h.outreachPool, control: h.controlPool }, () => state.standing));
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

  const owner = w.owner;
  const recorded = new Map<string, RecordedSeller>();
  let seq = 0;

  const content = async (userId: string, label: string): Promise<{ id: string; subject: string; body: string }> => {
    const subject = `Data migration help ${label}`;
    const body = `Hello, we move CRM data safely. ${label}`;
    const id = createHash("sha256").update(`KAURO_OUTREACH_CONTENT_V1\n${subject}\n${body}`, "utf8").digest("hex");
    await within(userId, FIXTURE_AT, (c) => c.query("INSERT INTO kauro.outreach_contents (content_id, subject, body, recorded_by_user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [id, subject, body, userId]));
    return { id, subject, body };
  };

  const publish = async (family: string, capabilityId: string, label: string): Promise<ResourceP> => {
    const resourceId = ids.next();
    const cref = await content(owner.userId, `resource-${label}`);
    await within(owner.userId, FIXTURE_AT, async (c) => {
      await lock(c, "kauro.sales_resources", family);
      await c.query("INSERT INTO kauro.sales_resources (resource_id, family_id, version, content_id, published_by_user_id) VALUES ($1, $2, 1, $3, $4)", [resourceId, family, cref.id, owner.userId]);
      await c.query("INSERT INTO kauro.sales_resource_capabilities (resource_id, capability_id) VALUES ($1, $2)", [resourceId, capabilityId]);
    });
    return { resourceId, familyId: family, capabilityId };
  };
  const defaultResource = await publish(ids.next(), w.cleanCapabilityId, "default");

  const api = (c: { readonly method?: "POST" | "GET"; readonly url: string; readonly token: string | null; readonly key?: string | null; readonly body?: unknown }): Promise<Reply> =>
    callApi(w, { ...(c.method !== undefined ? { method: c.method } : {}), url: c.url, agency: null, token: c.token, key: c.key === undefined ? (c.method === "GET" ? null : freshKey("b12")) : c.key, ...(c.body !== undefined ? { body: c.body } : {}) });

  const registerSender: SendWorld["routes"]["registerSender"] = async (body, options = {}) =>
    api({ url: "/api/v1/ops/outreach/senders", token: options.token ?? owner.token, ...(options.key !== undefined ? { key: options.key } : {}), body: { ...body, assuranceProofRef: await w.stepUp(owner) } });
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
    get compliance(): ComplianceConfig {
      return state.compliance ?? DEFAULT_COMPLIANCE;
    },
    async stop() {
      await sw.stop();
    },
    standAt(at) {
      state.standing = at;
      sw.standAt(at);
    },
    bindClock(c: StepClock | null) {
      sw.faults.clock = c;
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
      await within(seller.userId, FIXTURE_AT, async (c) => {
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
      await within(author.userId, FIXTURE_AT, async (c) => {
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
         VALUES ($1, $2, 'TOOL', NULL, 'AVAILABLE', $3, $4::jsonb, 'b12-send-world', now(), now())`,
        [capabilityId, `b12-${capabilityId.slice(-8)}`, sha(`capability-${capabilityId}`), JSON.stringify([sha(`qualification-${capabilityId}`)])],
      );
      return publish(ids.next(), capabilityId, label);
    },
    async metrics() {
      return notBuilt("world.metrics", "GetOutreachMetrics is an L-ACT route: not merged (use the route at batch)");
    },
    async grant(drafts, options = {}) {
      const first = drafts[0];
      if (first === undefined) throw new Error("a grant needs at least one draft");
      const reviewId = ids.next();
      const proofId = await w.stepUp(owner);
      const authorizationId = ids.next();
      const validFrom = options.validFrom ?? FIXTURE_AT;
      const expiresAt = options.expiresAt ?? plusMs(FIXTURE_AT, 13 * 86_400_000);
      // PrepareOutreachReview and CMD062 are L-AUTH routes: the same rows by SQL under the owner's own context until they merge
      await within(owner.userId, FIXTURE_AT, async (c) => {
        await c.query("INSERT INTO kauro.outreach_reviews (review_id, owner_user_id, proof_id, sender_id, digest, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, now(), now() + interval '15 minutes')", [reviewId, owner.userId, proofId, first.sender.senderId, sha(`review-${reviewId}`)]);
        for (const d of drafts) await c.query("INSERT INTO kauro.outreach_review_items (review_id, draft_id, draft_version, content_hash, contact_label) VALUES ($1, $2, 1, $3, 'Operations lead')", [reviewId, d.draftId, d.contentHash]);
      });
      const maximumSends = options.maximumSends ?? drafts.length;
      await within(owner.userId, plusMs(FIXTURE_AT, 1000), async (c) => {
        await c.query(
          "INSERT INTO kauro.outreach_authorizations (authorization_id, review_id, granting_user_id, sender_id, proof_id, valid_from, expires_at, maximum_sends, permission_evidence_hash, policy_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'outreach-v1')",
          [authorizationId, reviewId, owner.userId, first.sender.senderId, proofId, validFrom, expiresAt, maximumSends, sha(`permission-${authorizationId}`)],
        );
        for (const d of drafts) await c.query("INSERT INTO kauro.outreach_authorization_hashes (authorization_id, draft_id, content_hash) VALUES ($1, $2, $3)", [authorizationId, d.draftId, d.contentHash]);
      });
      return { authorizationId, senderId: first.sender.senderId, maximumSends, validFrom, expiresAt } satisfies GrantP;
    },
    call: api,
    outcome: (reply) => outcomeOf(w, reply),
    subReason(reply) {
      const body = reply.json<{ subReason?: string; details?: { subReason?: string } }>();
      return body.subReason ?? body.details?.subReason ?? null;
    },
    dispatcher(name = "dispatcher") {
      // one dispatcher (one lease owner) per name: a second owner would find the lease HELD until it expires
      const known = dispatchers.get(name);
      if (known !== undefined) return known;
      const d: OutreachDispatcher = createOutreachDispatcher(runtime);
      let fence: number | null = null;
      const admitted = new Map<string, Parameters<OutreachDispatcher["submit"]>[0]>();
      const takeOver = async (): Promise<number> => {
        const r = await d.takeOver();
        if (r.kind === "HELD") throw new Error(`${name}: another dispatcher holds the OUTBOX_DISPATCH lease`);
        fence = r.fence;
        return r.fence;
      };
      const lease = async (): Promise<OutreachLeaseRef> => {
        if (fence === null) await takeOver();
        return { resourceId: d.resourceId, ownerId: d.ownerId, fence: fence as number };
      };
      const adapter: Dispatcher = {
        name,
        async pass() {
          const r = await d.pass();
          if (r.fence !== null) fence = r.fence;
          return r.deliveries.map((x): DispatchReport => ({ intentId: x.intentId, outcome: x.intentState ?? x.outcome }));
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
          return d.call(claimed, await lease());
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
        takeOver,
      };
      dispatchers.set(name, adapter);
      return adapter;
    },
    async open(login) {
      return openConnection(h.pg.clientConfig(login === "superuser" ? "postgres" : login));
    },
    on<T>(conn: HarnessConnection, role: "kauro_app" | "kauro_outreach" | "kauro_control", ctx: FaultContext, steps: ReadonlyArray<SqlStep>, fn: () => Promise<T>, routing?: { readonly target?: number }): Promise<T> {
      return sw.faults.on(conn, role, ctx.points, steps, fn, routing ?? {});
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
      void control;
      void CELL_CONTROLS;
      void statementTimeout;
      return notBuilt("world.withoutSerializers", "removing a lock's acquisition needs a statement-rewrite seam in FaultRouting (the production OutreachLocks stays untouched); red-proof leg, built at batch");
    },
    routes: {
      revokeGrant: () => notBuilt("routes.revokeGrant", "RevokeOutreachAuthorization is an L-AUTH route: not merged"),
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
      publishResource: () => notBuilt("routes.publishResource", "PublishSalesResource is an L-OWNER route: not merged"),
      withdrawPolicy: () => notBuilt("routes.withdrawPolicy", "WithdrawOutreachPolicy is an L-OWNER route: not merged"),
      registerSender,
      verifySender,
      revokeSender,
      recordActivity: () => notBuilt("routes.recordActivity", "CMD064 RecordSalesActivity is an L-ACT route: not merged"),
      optOut: () => notBuilt("routes.optOut", "the public opt-out route is L-ACT's (apps/api/src/outreach/opt-out-route.ts is the kit's stub): not merged"),
      diagnose: () => notBuilt("routes.diagnose", "RecordOutreachDiagnosis is an L-ACT route: not merged"),
      review: () => notBuilt("routes.review", "PrepareOutreachReview is an L-AUTH route: not merged"),
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
      reinstatePolicy: () => notBuilt("routes.reinstatePolicy", "ReinstateOutreachPolicy is an L-OWNER route: not merged"),
    },
  };
  void T0;
  void ROLES;
  void (null as unknown as CorrelationId);
  return world;
}
