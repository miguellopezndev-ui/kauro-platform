/**
 * B11 W5b acceptance tests (docs/design/B11-agency-app.md section 5 W5b and section 13, D-PUB-1..D-PUB-8): the two public
 * routes, exercised through the real Fastify server composed by the real composition root over a real PostgreSQL 17 that the
 * test starts itself (07 "Acceptance obligations"; 21 "Independent oracles": the superuser oracle reads every row, the runtime
 * role sees only its grants). Nothing fakes the database or the schema validator.
 *
 *   GET  /api/v1/public/capability-publication   no authentication, `no-store`, only the publishable states of a mode capability
 *   POST /api/v1/public/inquiries                no authentication, exact public or app Origin, closed schema, content-idempotent
 *                                                for 24 hours, limited per client-address hash and per e-mail hash, description
 *                                                through the secret and record detector, `inquiry.received.v1` with ids only
 *
 * The clock is a mutable test clock the api runs on: every window (24 hours of idempotency, one hour and one day of limiter) is
 * crossed by moving that clock, never by waiting. The two races are fixed with a table lock held by the oracle and observed in
 * pg_stat_activity (one request blocked on the advisory lock, the other blocked on its own insert); no sleep synchronizes
 * anything. Every test uses its own client addresses and e-mail addresses, and the clock only moves forward.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { REQUEST_LIMITS, type Problem } from "@kauro/application";
import { INQUIRY_BUYER_TYPES, INQUIRY_DESTINATIONS, INQUIRY_RECORD_BANDS, INQUIRY_TIMINGS, createIdGenerator, toUtcInstant, type Clock } from "@kauro/domain";
import { PgCapabilityPublication, PgInquiryStore } from "@kauro/persistence";
import { ROLES, raceStatementTimeoutMs, startHarness, waitForLockWait, type Harness, testDatabaseEnvironment } from "@kauro/persistence/testing";
import { API_APPLICATION_NAME, assembleApi, createBearerTokenAuthenticator, loadContractSchemas, openDatabase, type DatabaseHandle } from "../src/index.js";

const PUBLIC_ORIGIN = "https://www.kauro.test";
const APP_ORIGIN = "https://app.kauro.test";
const PUBLICATION = "/api/v1/public/capability-publication";
const INQUIRIES = "/api/v1/public/inquiries";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Reply = Awaited<ReturnType<FastifyInstance["inject"]>>;

// --- the world -----------------------------------------------------------------------------------------------------------

let nowMs = Date.parse("2026-10-01T12:00:00.000Z");
const clock: Clock = { now: () => toUtcInstant(nowMs), nowMs: () => nowMs };
const ids = createIdGenerator(clock, (n) => new Uint8Array(randomBytes(n)));

function advanceTo(ms: number): void {
  assert.ok(ms >= nowMs, "the test clock only moves forward");
  nowMs = ms;
}

let h: Harness;
let db: DatabaseHandle;
let app: FastifyInstance;
let bare: FastifyInstance;
const logLines: string[] = [];
const internalErrors: Array<{ correlationId: string; error: unknown }> = [];
/** Every e-mail address and every refused text the tests submit: none may reach a log line or an internal error. */
const personalData: string[] = [];

let cleanId = "";
let hubspotId = "";
let salesforceId = "";
let draftCleanId = "";
let objectId = "";

before(async () => {
  h = await startHarness();
  db = await openDatabase({
    database: { host: "127.0.0.1", port: h.pg.port, database: ROLES.database, user: ROLES.appLogin, poolMax: 6, statementTimeoutMs: raceStatementTimeoutMs() },
    databaseEnvironment: testDatabaseEnvironment("LOCAL"),
    migrateOnStart: null,
  });
  const base = {
    environment: "LOCAL" as const,
    unitOfWork: db.unitOfWork,
    database: db,
    authenticator: createBearerTokenAuthenticator(new Map()),
    validator: loadContractSchemas(),
    clock,
    ids,
    onInternalError: (correlationId: string, error: unknown) => internalErrors.push({ correlationId, error }),
  };
  app = assembleApi({
    ...base,
    logger: { level: "info", stream: { write: (line: string) => void logLines.push(line) } },
    publicApi: {
      origins: { public: PUBLIC_ORIGIN, app: APP_ORIGIN },
      inquiries: new PgInquiryStore(db.pool, raceStatementTimeoutMs()),
      capabilities: new PgCapabilityPublication(db.pool),
      hashKey: new Uint8Array(randomBytes(32)),
    },
  });
  await app.ready();
  // the same composition without the public member: the routes do not exist there
  bare = assembleApi(base);
  await bare.ready();

  // capabilities: only a MODE capability that is AVAILABLE_LIMITED or AVAILABLE is ever published
  cleanId = await h.offeredCapability("CLEAN"); // AVAILABLE_LIMITED
  hubspotId = await h.offeredCapability("HUBSPOT", "QUALIFIED_INTERNAL");
  salesforceId = await h.offeredCapability("SALESFORCE", "DESIGN");
  draftCleanId = await h.offeredCapability("CLEAN", "DESIGN", { version: "R3-DRAFT" });
  objectId = ids.next();
  await h.oracle.query(
    `INSERT INTO kauro.capabilities (capability_id, version, kind, mode, state, profile_hash, qualification_evidence_hashes, review_trigger, created_at, updated_at)
     VALUES ($1, 'R2-INITIAL', 'OBJECT', NULL, 'DESIGN', $2, '[]'::jsonb, 'VENDOR_OR_ENVELOPE_CHANGE', now(), now())`,
    [objectId, "a".repeat(64)],
  );
  await h.publishCapability(objectId, "AVAILABLE_LIMITED"); // an internal (non-mode) capability that reached an offered state
});

after(async () => {
  await bare.close();
  await app.close();
  await db.close();
  await h.stop();
});

// --- helpers -------------------------------------------------------------------------------------------------------------

let addressCounter = 0;
/** A fresh client address per call (IPv4, so its limiter bucket is its own). */
function nextAddress(): string {
  addressCounter += 1;
  return `10.20.${addressCounter >> 8}.${addressCounter & 255}`;
}

let emailCounter = 0;
function nextEmail(): string {
  emailCounter += 1;
  const email = `buyer${emailCounter}@example.test`;
  personalData.push(email);
  return email;
}

function validBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    buyerType: "agency",
    contactName: "Ana Prieto",
    contactEmail: nextEmail(),
    companyName: "Prieto Digital",
    destination: "listed-crm",
    recordBand: "up-to-50000",
    timing: "within-2-weeks",
    ...extra,
  };
}

interface Submission {
  readonly body?: Record<string, unknown>;
  readonly raw?: string | Buffer;
  /** `undefined`: the public origin; `null`: no Origin header. */
  readonly origin?: string | null;
  readonly address?: string;
  readonly contentType?: string;
}

async function submit(s: Submission): Promise<Reply> {
  const origin = s.origin === undefined ? PUBLIC_ORIGIN : s.origin;
  return app.inject({
    method: "POST",
    url: INQUIRIES,
    headers: { "content-type": s.contentType ?? "application/json", ...(origin !== null ? { origin } : {}) },
    payload: s.raw ?? JSON.stringify(s.body ?? validBody()),
    remoteAddress: s.address ?? nextAddress(),
  });
}

interface Received {
  readonly inquiryId: string;
  readonly receivedAt: string;
}

function received(res: Reply): Received {
  assert.equal(res.statusCode, 201, res.body);
  assert.match(String(res.headers["content-type"]), /^application\/json/);
  const body = res.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["inquiryId", "receivedAt"], "the reply carries the inquiry id and the received instant only");
  assert.match(String(body["inquiryId"]), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return body as unknown as Received;
}

function problem(res: Reply, status: number, code: string, reason?: string): Problem {
  assert.equal(res.statusCode, status, res.body);
  assert.match(String(res.headers["content-type"]), /^application\/problem\+json/);
  const p = res.json() as Problem;
  assert.equal(p.status, status);
  assert.equal(p.code, code);
  if (reason !== undefined) assert.equal(p.reason, reason);
  return p;
}

async function count(table: string, where = "true", params: ReadonlyArray<unknown> = []): Promise<number> {
  const r = await h.oracle.query<{ n: string }>(`SELECT count(*)::text AS n FROM kauro.${table} WHERE ${where}`, [...params]);
  return Number(r.rows[0]?.n);
}

/** Row counts of the three tables of an inquiry, to prove a refusal wrote nothing. */
async function counts(): Promise<{ inquiries: number; admissions: number; events: number }> {
  return { inquiries: await count("inquiries"), admissions: await count("inquiry_admissions"), events: await count("inquiry_events") };
}

function assertNoCrossOriginHeaders(res: Reply): void {
  for (const name of Object.keys(res.headers)) assert.equal(name.startsWith("access-control-"), false, `${name} must never be sent (D-SEC-1)`);
  assert.equal(res.headers["set-cookie"], undefined);
}

// --- GET /api/v1/public/capability-publication -----------------------------------------------------------------------------

interface Published {
  readonly capabilityId: string;
  readonly mode: string;
  readonly version: string;
  readonly state: string;
  readonly validFrom?: string;
}

async function publication(headers: Record<string, string> = {}): Promise<{ observedAt: string; capabilities: Published[] }> {
  const res = await app.inject({ method: "GET", url: PUBLICATION, headers });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers["cache-control"]), /no-store/);
  assert.match(String(res.headers["content-type"]), /^application\/json/);
  assert.ok(res.headers["x-correlation-id"]);
  assertNoCrossOriginHeaders(res);
  const body = res.json() as { observedAt: string; capabilities: Published[] };
  assert.deepEqual(Object.keys(body).sort(), ["capabilities", "observedAt"]);
  assert.equal(body.observedAt, clock.now());
  for (const c of body.capabilities) {
    assert.deepEqual(Object.keys(c).sort(), ["capabilityId", "mode", "state", "validFrom", "version"], "a published capability carries public fields only");
    assert.ok(c.state === "AVAILABLE_LIMITED" || c.state === "AVAILABLE", `${c.state} is not a publishable state`);
  }
  return body;
}

test("the capability publication needs no authentication, is never cached, and lists only the modes that admit real customers", async () => {
  // fixture: CLEAN offered (AVAILABLE_LIMITED); HUBSPOT QUALIFIED_INTERNAL; SALESFORCE DESIGN; a second CLEAN version at DESIGN;
  // an OBJECT capability at AVAILABLE_LIMITED (an internal capability that is not a mode)
  const first = await publication();
  assert.deepEqual(first.capabilities.map((c) => [c.capabilityId, c.mode, c.version, c.state]), [[cleanId, "CLEAN", "R2-INITIAL", "AVAILABLE_LIMITED"]]);
  const listed = new Set(first.capabilities.map((c) => c.capabilityId));
  for (const hidden of [hubspotId, salesforceId, draftCleanId, objectId]) assert.equal(listed.has(hidden), false, `${hidden} must not be published`);
  assert.ok(first.capabilities[0]?.validFrom !== undefined, "an offered capability carries the instant it became valid");

  // a credential is neither required nor read: a malformed one does not change the answer
  const withCredential = await publication({ authorization: "Bearer not-a-token-of-this-service" });
  assert.deepEqual(withCredential.capabilities, first.capabilities);
});

test("the capability publication follows the capability state machine: qualified stays hidden, offered appears, suspended disappears", async () => {
  await h.publishCapability(hubspotId, "AVAILABLE_LIMITED");
  const both = await publication();
  assert.deepEqual(both.capabilities.map((c) => [c.mode, c.state]), [["CLEAN", "AVAILABLE_LIMITED"], ["HUBSPOT", "AVAILABLE_LIMITED"]], "ordered by mode");

  await h.publishCapability(cleanId, "AVAILABLE");
  const matured = await publication();
  assert.deepEqual(matured.capabilities.map((c) => [c.mode, c.state]), [["CLEAN", "AVAILABLE"], ["HUBSPOT", "AVAILABLE_LIMITED"]]);

  await h.oracle.query("UPDATE kauro.capabilities SET state = 'SUSPENDED' WHERE capability_id = $1", [hubspotId]);
  const suspended = await publication();
  assert.deepEqual(suspended.capabilities.map((c) => [c.mode, c.state]), [["CLEAN", "AVAILABLE"]], "SUSPENDED is not a publication");

  // the still-unqualified SALESFORCE and the DESIGN revision of CLEAN never appeared in any of these answers
  for (const body of [both, matured, suspended]) {
    const seen = new Set(body.capabilities.map((c) => c.capabilityId));
    assert.equal(seen.has(salesforceId), false);
    assert.equal(seen.has(draftCleanId), false);
    assert.equal(seen.has(objectId), false);
  }
});

test("the routes are declared where the public member is composed and nowhere else", async () => {
  const noPublication = await bare.inject({ method: "GET", url: PUBLICATION });
  problem(noPublication, 404, "NOT_FOUND");
  const noInquiries = await bare.inject({ method: "POST", url: INQUIRIES, headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN }, payload: JSON.stringify(validBody()) });
  problem(noInquiries, 404, "NOT_FOUND");
});

// --- POST /api/v1/public/inquiries: what an accepted inquiry leaves -------------------------------------------------------

test("an accepted inquiry is stored once with its three admission keys and one event that carries ids only", async () => {
  const address = nextAddress();
  const email = nextEmail();
  const description = "We keep our contacts in two spreadsheets and want them cleaned before we move to a new CRM next quarter.";
  const before = await counts();
  const res = await submit({ address, body: validBody({ contactEmail: email, description, buyerType: "in-house", timing: "flexible", destination: "not-chosen", recordBand: "not-sure" }) });
  const ok = received(res);
  assert.equal(ok.receivedAt, clock.now());
  assert.match(String(res.headers["cache-control"]), /no-store/);
  assert.ok(res.headers["x-correlation-id"]);
  assertNoCrossOriginHeaders(res);

  const row = (await h.oracle.query("SELECT * FROM kauro.inquiries WHERE inquiry_id = $1", [ok.inquiryId])).rows[0] as Record<string, unknown>;
  assert.equal(row["buyer_type"], "in-house");
  assert.equal(row["contact_name"], "Ana Prieto");
  assert.equal(row["contact_email"], email);
  assert.equal(row["company_name"], "Prieto Digital");
  assert.equal(row["destination"], "not-chosen");
  assert.equal(row["record_band"], "not-sure");
  assert.equal(row["timing"], "flexible");
  assert.equal(row["description"], description);
  assert.equal((row["received_at"] as Date).getTime(), nowMs);

  const events = (await h.oracle.query("SELECT event_type, payload, created_at FROM kauro.inquiry_events WHERE inquiry_id = $1", [ok.inquiryId])).rows as Array<{ event_type: string; payload: unknown; created_at: Date }>;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event_type, "inquiry.received.v1");
  assert.deepEqual(events[0]?.payload, { inquiryId: ok.inquiryId }, "ids only: no name, e-mail, company or text");
  assert.equal(events[0]?.created_at.getTime(), nowMs);

  const admissions = (await h.oracle.query("SELECT kind, key_hash, admitted_at FROM kauro.inquiry_admissions WHERE inquiry_id = $1 ORDER BY kind", [ok.inquiryId])).rows as Array<{ kind: string; key_hash: string; admitted_at: Date }>;
  assert.deepEqual(admissions.map((a) => a.kind), ["ADDRESS", "CONTENT", "EMAIL"]);
  for (const a of admissions) {
    assert.match(a.key_hash, /^[0-9a-f]{64}$/);
    assert.equal(a.admitted_at.getTime(), nowMs);
  }
  assert.equal(new Set(admissions.map((a) => a.key_hash)).size, 3, "three different keys");
  // the admission table is hash-only: neither the address nor the e-mail address nor any text is in it
  const dump = JSON.stringify((await h.oracle.query("SELECT * FROM kauro.inquiry_admissions")).rows);
  assert.equal(dump.includes(address), false);
  assert.equal(dump.includes(email), false);
  assert.equal(dump.includes("spreadsheets"), false);

  assert.deepEqual(await counts(), { inquiries: before.inquiries + 1, admissions: before.admissions + 3, events: before.events + 1 });
});

test("an optional description that is absent is stored as no description, and a description of exactly 2000 characters is accepted", async () => {
  const noText = received(await submit({ body: validBody() }));
  const stored = (await h.oracle.query("SELECT description FROM kauro.inquiries WHERE inquiry_id = $1", [noText.inquiryId])).rows[0] as { description: string | null };
  assert.equal(stored.description, null);
  // 2000 characters of ordinary words (no run long enough to look like a key), with line breaks
  const words = "We need our contact data cleaned and prepared for import.\n";
  const text = words.repeat(Math.ceil(2000 / words.length)).slice(0, 2000);
  assert.equal(text.length, 2000);
  received(await submit({ body: validBody({ description: text }) }));
});

test("all four destination values, all bands and all timings are accepted, and no destination names a third-party CRM", async () => {
  assert.deepEqual([...INQUIRY_BUYER_TYPES], ["agency", "in-house"]);
  for (const value of INQUIRY_DESTINATIONS) assert.doesNotMatch(value, /hubspot|salesforce|pipedrive|zoho|dynamics|sugar|freshsales|copper|insightly/i, `${value} names a CRM`);
  for (const buyerType of INQUIRY_BUYER_TYPES) received(await submit({ body: validBody({ buyerType }) }));
  for (const destination of INQUIRY_DESTINATIONS) received(await submit({ body: validBody({ destination }) }));
  for (const recordBand of INQUIRY_RECORD_BANDS) received(await submit({ body: validBody({ recordBand }) }));
  for (const timing of INQUIRY_TIMINGS) received(await submit({ body: validBody({ timing }) }));
  // the bands are the vendored pricing bands, then "over the last band" and "not sure"
  assert.deepEqual([...INQUIRY_RECORD_BANDS], ["up-to-50000", "up-to-150000", "up-to-500000", "up-to-1000000", "over-1000000", "not-sure"]);
});

// --- POST /api/v1/public/inquiries: origin ---------------------------------------------------------------------------------

test("only the exact public origin or the exact app origin may submit; every other origin, and none, is refused before the body is read", async () => {
  const before = await counts();
  received(await submit({ origin: PUBLIC_ORIGIN }));
  received(await submit({ origin: APP_ORIGIN }));
  const refusedOrigins: Array<string | null> = [null, "", "null", "https://evil.example", `${PUBLIC_ORIGIN}/`, PUBLIC_ORIGIN.toUpperCase(), "http://www.kauro.test", "https://www.kauro.test:8443", `${PUBLIC_ORIGIN}.evil.example`, `${PUBLIC_ORIGIN}, ${APP_ORIGIN}`, "https://kauro.test"];
  for (const origin of refusedOrigins) {
    const res = await submit({ origin, body: validBody() });
    const p = problem(res, 403, "NOT_AUTHORIZED", "ORIGIN_REJECTED");
    assert.equal(p.errors, undefined);
    assertNoCrossOriginHeaders(res);
  }
  // the origin is decided before the body: a request that would also fail admission still answers the origin refusal
  problem(await submit({ origin: "https://evil.example", raw: "{not json" }), 403, "NOT_AUTHORIZED", "ORIGIN_REJECTED");
  problem(await submit({ origin: null, raw: "{not json", contentType: "text/plain" }), 403, "NOT_AUTHORIZED", "ORIGIN_REJECTED");
  assert.deepEqual(await counts(), { inquiries: before.inquiries + 2, admissions: before.admissions + 6, events: before.events + 2 }, "the refusals wrote nothing");
});

test("no cross-origin header is ever sent: a preflight is not served and an allowed origin gets no allow header", async () => {
  const preflight = await app.inject({ method: "OPTIONS", url: INQUIRIES, headers: { origin: PUBLIC_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.ok(preflight.statusCode >= 400, `preflight answered ${preflight.statusCode}`);
  assertNoCrossOriginHeaders(preflight);
  const get = await app.inject({ method: "GET", url: PUBLICATION, headers: { origin: PUBLIC_ORIGIN } });
  assert.equal(get.statusCode, 200);
  assertNoCrossOriginHeaders(get);
});

// --- POST /api/v1/public/inquiries: admission ------------------------------------------------------------------------------

test("the body is a closed schema: unknown, missing, mistyped and out-of-vocabulary members are refused by name and write nothing", async () => {
  const before = await counts();
  const refuse = async (extra: Record<string, unknown>, omit: string[], field: string, code: string): Promise<void> => {
    const body = { ...validBody(), ...extra };
    for (const key of omit) delete body[key];
    const p = problem(await submit({ body }), 400, "INVALID_REQUEST", "SCHEMA_VIOLATION");
    assert.ok(p.errors?.some((e) => e.field === field && e.code === code), `${field} ${code} in ${JSON.stringify(p.errors)}`);
  };
  await refuse({ crm: "hubspot" }, [], "crm", "UNKNOWN_FIELD");
  await refuse({ agencyId: ids.next() }, [], "agencyId", "UNKNOWN_FIELD");
  await refuse({}, ["contactEmail"], "contactEmail", "REQUIRED");
  await refuse({}, ["buyerType"], "buyerType", "REQUIRED");
  await refuse({}, ["destination"], "destination", "REQUIRED");
  await refuse({}, ["recordBand"], "recordBand", "REQUIRED");
  await refuse({}, ["timing"], "timing", "REQUIRED");
  await refuse({ companyName: 5 }, [], "companyName", "TYPE");
  await refuse({ description: null }, [], "description", "TYPE");
  await refuse({ buyerType: "reseller" }, [], "buyerType", "ENUM");
  await refuse({ buyerType: "Agency" }, [], "buyerType", "ENUM");
  await refuse({ destination: "hubspot" }, [], "destination", "ENUM");
  await refuse({ recordBand: "many" }, [], "recordBand", "ENUM");
  await refuse({ timing: "yesterday" }, [], "timing", "ENUM");
  await refuse({ contactEmail: "not-an-email" }, [], "contactEmail", "FORMAT");
  await refuse({ contactEmail: "two@@example.test" }, [], "contactEmail", "FORMAT");
  await refuse({ contactName: "" }, [], "contactName", "RANGE");
  await refuse({ contactName: "x".repeat(201) }, [], "contactName", "RANGE");
  await refuse({ description: "" }, [], "description", "RANGE");
  await refuse({ description: "a".repeat(2001) }, [], "description", "RANGE");
  await refuse({ description: "   \n  " }, [], "description", "FORMAT");
  await refuse({ contactName: "Ana\u0007Prieto" }, [], "contactName", "FORMAT");
  await refuse({ description: "line\u0000break" }, [], "description", "FORMAT");
  assert.deepEqual(await counts(), before);
});

test("the request envelope is admitted as everywhere else: content type, syntax, duplicate keys, encoding and size, and no idempotency key is needed", async () => {
  const before = await counts();
  problem(await submit({ contentType: "text/plain" }), 400, "INVALID_REQUEST", "CONTENT_TYPE_UNSUPPORTED");
  problem(await submit({ contentType: "application/json; charset=latin1" }), 400, "INVALID_REQUEST", "CONTENT_TYPE_UNSUPPORTED");
  problem(await submit({ raw: "{\"buyerType\": " }), 400, "INVALID_REQUEST", "JSON_SYNTAX");
  problem(await submit({ raw: "" }), 400, "INVALID_REQUEST", "JSON_SYNTAX");
  problem(await submit({ raw: JSON.stringify(validBody()).replace("\"agency\"", "\"agency\",\"buyerType\":\"in-house\"") }), 400, "INVALID_REQUEST", "JSON_DUPLICATE_KEY");
  problem(await submit({ raw: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]) }), 400, "INVALID_REQUEST", "JSON_SYNTAX");
  problem(await submit({ raw: "[]" }), 400, "INVALID_REQUEST", "SCHEMA_VIOLATION");
  problem(await submit({ raw: JSON.stringify(validBody({ description: "x".repeat(REQUEST_LIMITS.jsonBytes) })) }), 400, "INVALID_REQUEST", "BODY_TOO_LARGE");
  // a request with no Idempotency-Key succeeds: the inquiry is content-idempotent, not key-idempotent
  received(await submit({ body: validBody() }));
  assert.equal((await counts()).inquiries, before.inquiries + 1);
});

// --- POST /api/v1/public/inquiries: content idempotence for 24 hours -----------------------------------------------------

test("the same content within 24 hours is the same inquiry: same id, same instant, no new row, no new event, no budget spent", async () => {
  const email = nextEmail();
  const body = validBody({ contactEmail: email, description: "About 30,000 contacts; we are choosing a destination this month." });
  const address = nextAddress();
  const t0 = nowMs;
  const first = received(await submit({ body, address }));
  const before = await counts();

  // the same fields written in another order and layout, from another address, an hour later: still the same content
  advanceTo(t0 + HOUR);
  const reordered = `{ "description": ${JSON.stringify(body["description"])},\n "timing": "within-2-weeks", "recordBand": "up-to-50000", "destination": "listed-crm",\n "companyName": "Prieto Digital", "contactEmail": ${JSON.stringify(email)}, "contactName": "Ana Prieto", "buyerType": "agency" }`;
  const again = received(await submit({ raw: reordered, address: nextAddress() }));
  assert.deepEqual(again, first, "a replay answers what the first acceptance answered");
  const shouted = received(await submit({ body: { ...body, contactEmail: email.toUpperCase() }, address: nextAddress() }));
  assert.deepEqual(shouted, first, "an e-mail address is compared without regard to case");
  assert.deepEqual(await counts(), before, "a replay writes nothing");
  assert.equal(await count("inquiries", "contact_email = $1", [email]), 1);

  // any different field is a different inquiry
  const other = received(await submit({ body: { ...body, description: "About 30,000 contacts; we are choosing a destination next month." }, address: nextAddress() }));
  assert.notEqual(other.inquiryId, first.inquiryId);
  const otherBuyer = received(await submit({ body: { ...body, buyerType: "in-house" }, address: nextAddress() }));
  assert.notEqual(otherBuyer.inquiryId, first.inquiryId);
  assert.notEqual(otherBuyer.inquiryId, other.inquiryId);

  // the window is 24 hours from the first acceptance: one millisecond short it is a replay, at 24 hours it is new
  advanceTo(t0 + DAY - 1);
  assert.deepEqual(received(await submit({ body, address: nextAddress() })), first);
  advanceTo(t0 + DAY);
  const renewed = received(await submit({ body, address: nextAddress() }));
  assert.notEqual(renewed.inquiryId, first.inquiryId);
  assert.equal(renewed.receivedAt, clock.now());
  assert.equal(await count("inquiries", "contact_email = $1", [email]), 4);
});

test("a replay is answered even when the limiters are exhausted, and it spends no budget", async () => {
  const address = nextAddress();
  const bodies = Array.from({ length: 5 }, () => validBody());
  const accepted: Received[] = [];
  for (const body of bodies) accepted.push(received(await submit({ body, address })));
  problem(await submit({ body: validBody(), address }), 429, "ADMISSION_LIMITED", "INQUIRY_RATE_LIMITED");
  // the fifth acceptance is replayed from the exhausted address and from a fresh one alike
  assert.deepEqual(received(await submit({ body: bodies[4] as Record<string, unknown>, address })), accepted[4]);
  assert.deepEqual(received(await submit({ body: bodies[0] as Record<string, unknown>, address })), accepted[0]);
  problem(await submit({ body: validBody(), address }), 429, "ADMISSION_LIMITED", "INQUIRY_RATE_LIMITED");
  assert.equal(await count("inquiry_admissions", "kind = 'ADDRESS' AND inquiry_id = ANY($1::uuid[])", [accepted.map((a) => a.inquiryId)]), 5);
});

// --- POST /api/v1/public/inquiries: limiter ---------------------------------------------------------------------------------

test("a client address hash may have 5 inquiries in a trailing hour: the sixth is limited with the seconds to wait, the address before it is not", async () => {
  const address = nextAddress();
  const base = nowMs;
  for (let i = 0; i < 5; i++) {
    advanceTo(base + i * 60_000);
    received(await submit({ address }));
  }
  const before = await counts();
  advanceTo(base + 5 * 60_000);
  const limited = problem(await submit({ address }), 429, "ADMISSION_LIMITED", "INQUIRY_RATE_LIMITED");
  assert.equal(limited.retryAfterSeconds, 3300, "the first inquiry leaves the window one hour after it was accepted");
  assert.deepEqual(limited.nextActions, [{ action: "RETRY_LATER" }]);
  assert.equal(limited.retryable, false);
  assert.deepEqual(await counts(), before, "a limited request writes nothing");

  // another client address has its own budget
  received(await submit({ address: nextAddress() }));

  advanceTo(base + HOUR - 1);
  assert.equal(problem(await submit({ address }), 429, "ADMISSION_LIMITED", "INQUIRY_RATE_LIMITED").retryAfterSeconds, 1);
  advanceTo(base + HOUR);
  received(await submit({ address }));
  // the second inquiry leaves the window a minute later, and only then is there room for one more after this one
  advanceTo(base + HOUR + 30_000);
  assert.equal(problem(await submit({ address }), 429, "ADMISSION_LIMITED", "INQUIRY_RATE_LIMITED").retryAfterSeconds, 30);
});

test("the client address is the network, not the host: two hosts of one IPv6 /64 share a budget, another /64 does not", async () => {
  const network = "2001:db8:5:9";
  for (let i = 0; i < 5; i++) received(await submit({ address: `${network}::${i + 1}` }));
  problem(await submit({ address: `${network}:ffff:1:2:3` }), 429, "ADMISSION_LIMITED", "INQUIRY_RATE_LIMITED");
  received(await submit({ address: "2001:db8:5:a::1" }));
});

test("an e-mail address hash may have 3 inquiries in a trailing day, whatever the case, the address or the buyer type; the fourth waits for the first to leave", async () => {
  const email = nextEmail();
  const base = nowMs;
  const variants = [email, email.toUpperCase(), email.replace("buyer", "Buyer")];
  for (let i = 0; i < 3; i++) {
    advanceTo(base + i * HOUR);
    received(await submit({ address: nextAddress(), body: validBody({ contactEmail: variants[i], buyerType: i % 2 === 0 ? "agency" : "in-house", description: `Inquiry number ${i + 1} about a CRM data clean-up.` }) }));
  }
  advanceTo(base + 3 * HOUR);
  const before = await counts();
  const limited = problem(await submit({ address: nextAddress(), body: validBody({ contactEmail: email, description: "Inquiry number 4 about a CRM data clean-up." }) }), 429, "ADMISSION_LIMITED", "INQUIRY_RATE_LIMITED");
  assert.equal(limited.retryAfterSeconds, 21 * 3600);
  assert.deepEqual(await counts(), before);

  // another e-mail address is unaffected
  received(await submit({ address: nextAddress() }));

  advanceTo(base + DAY - 1);
  assert.equal(problem(await submit({ address: nextAddress(), body: validBody({ contactEmail: email, description: "Inquiry number 5." }) }), 429, "ADMISSION_LIMITED", "INQUIRY_RATE_LIMITED").retryAfterSeconds, 1);
  advanceTo(base + DAY);
  received(await submit({ address: nextAddress(), body: validBody({ contactEmail: email, description: "Inquiry number 6." }) }));
});

// --- POST /api/v1/public/inquiries: races ------------------------------------------------------------------------------------

/**
 * Holds a table lock on the admission rows with the oracle, starts two requests, and returns their replies once the lock is
 * gone. It waits until one request is blocked on its own insert (its transaction holds the advisory locks) and the other is
 * blocked on an advisory lock (pg_stat_activity): the interleaving is observed, not timed.
 */
async function raceOnAdmissions(a: Submission, b: Submission): Promise<[Reply, Reply]> {
  await h.oracle.query("BEGIN");
  await h.oracle.query("LOCK TABLE kauro.inquiry_admissions IN SHARE ROW EXCLUSIVE MODE");
  const first = submit(a);
  const second = submit(b);
  try {
    await waitForLockWait(h.oracle, API_APPLICATION_NAME, "INSERT INTO kauro.inquiry_admissions");
    await waitForLockWait(h.oracle, API_APPLICATION_NAME, "pg_advisory_xact_lock");
  } finally {
    await h.oracle.query("ROLLBACK");
  }
  return [await first, await second];
}

test("RACE: two different inquiries from an address with one place left are serialized: exactly one is accepted and the other is limited", async () => {
  const address = nextAddress();
  for (let i = 0; i < 4; i++) received(await submit({ address }));
  const before = await counts();
  const replies = await raceOnAdmissions({ address }, { address });
  const statuses = replies.map((r) => r.statusCode).sort();
  assert.deepEqual(statuses, [201, 429]);
  const limited = replies.find((r) => r.statusCode === 429) as Reply;
  problem(limited, 429, "ADMISSION_LIMITED", "INQUIRY_RATE_LIMITED");
  assert.deepEqual(await counts(), { inquiries: before.inquiries + 1, admissions: before.admissions + 3, events: before.events + 1 });
});

test("RACE: the same inquiry sent twice at once is accepted once and replayed once, from two client addresses", async () => {
  const body = validBody({ description: "The same message sent twice by a browser that retried." });
  const before = await counts();
  const [a, b] = await raceOnAdmissions({ body, address: nextAddress() }, { body, address: nextAddress() });
  const ra = received(a);
  const rb = received(b);
  assert.deepEqual(ra, rb);
  assert.deepEqual(await counts(), { inquiries: before.inquiries + 1, admissions: before.admissions + 3, events: before.events + 1 });
  assert.equal(await count("inquiries", "inquiry_id = $1", [ra.inquiryId]), 1);
});

// --- POST /api/v1/public/inquiries: the detector ------------------------------------------------------------------------------

const PRIVATE_KEY_TEXT = `${["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ")}\nMIIEowIBAAKCAQEAxample\n${["-----END", "RSA PRIVATE KEY-----"].join(" ")}`;
const SECRET_TEXTS: ReadonlyArray<string> = [
  "The export needs this login: password=Tr0ub4dor&3x, please use it.",
  `My access key is ${["AKIA", "IOSFODNN7EXAMPLE"].join("")} and it works.`,
  `Use this token ${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"].join(".")} to log in.`,
  PRIVATE_KEY_TEXT,
  `Here is the key ${["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_")} for the billing account.`,
];
const RECORD_TEXTS: ReadonlyArray<string> = [
  "Contacts: ana@records.example, luis@records.example, mia@records.example",
  "Ana,Prieto,3001\nLuis,Gomez,3002\nMia,Ruiz,3003",
  "Ana;Prieto;Bogota\nLuis;Gomez;Cali\nMia;Ruiz;Lima\nEva;Sanz;Quito",
];

test("a description that looks like a secret or like customer records is refused as CONTENT_REFUSED with the secure upload as the next action, and nothing is stored, counted or logged", async () => {
  const address = nextAddress();
  const before = await counts();
  const budget = await count("inquiry_admissions", "kind = 'ADDRESS'");
  personalData.push(...SECRET_TEXTS, ...RECORD_TEXTS);
  for (const [texts, reason] of [[SECRET_TEXTS, "SECRET_LIKE_CONTENT"], [RECORD_TEXTS, "RECORD_LIKE_CONTENT"]] as const) {
    for (const description of texts) {
      const res = await submit({ address, body: validBody({ description }) });
      const p = problem(res, 422, "CONTENT_REFUSED", reason);
      assert.deepEqual(p.nextActions, [{ action: "SECURE_UPLOAD" }]);
      assert.equal(p.errors, undefined, "the refusal names a class, never a field position or a value");
      assert.equal(p.retryable, false);
      assert.equal(res.body.includes(description.slice(0, 12)), false, "the refusal never echoes what it refused");
    }
  }
  assert.deepEqual(await counts(), before);
  assert.equal(await count("inquiry_admissions", "kind = 'ADDRESS'"), budget);
  // the refused attempts spent none of the address budget: five inquiries from that address are still accepted
  for (let i = 0; i < 5; i++) received(await submit({ address }));
});

test("ordinary descriptions are not refused: numbers, one e-mail address, a short list and long words pass", async () => {
  const fine = [
    "We keep about 40,000 contacts in a spreadsheet and need them cleaned before the move.",
    "Contacts 12000, companies 3400, deals 900; most of them duplicated across three exports.",
    "Please write to our operations lead at ops@corp.example, she has the file layout.",
    "Name, e-mail, phone and company are the columns we care about.\nWe also have a notes column.",
    "Internationalization, telecommunications and organizational restructuring are all part of this project.",
  ];
  for (const description of fine) received(await submit({ body: validBody({ description }) }));
});

// --- the database boundary --------------------------------------------------------------------------------------------------

test("the runtime role can only insert an inquiry: no read, update, delete or truncate of inquiries, and no more than its grants on the other two tables", async () => {
  const privileges = async (role: string, table: string): Promise<string[]> => {
    const out: string[] = [];
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      const r = await h.oracle.query<{ ok: boolean }>("SELECT has_table_privilege($1, $2, $3) AS ok", [role, `kauro.${table}`, p]);
      if (r.rows[0]?.ok === true) out.push(p);
    }
    return out;
  };
  assert.deepEqual(await privileges("kauro_app", "inquiries"), ["INSERT"]);
  assert.deepEqual(await privileges("kauro_app", "inquiry_events"), ["INSERT"]);
  assert.deepEqual(await privileges("kauro_app", "inquiry_admissions"), ["SELECT", "INSERT"]);
  for (const table of ["inquiries", "inquiry_events", "inquiry_admissions"]) {
    // no reader role exists yet: the package that reads inquiries (the owner queue) grants itself its own read with its own migration
    for (const role of ["kauro_control", "kauro_assurance", "kauro_validator", "kauro_ingress"]) assert.deepEqual(await privileges(role, table), [], `${role} on ${table}`);
  }
  for (const table of ["inquiries", "inquiry_events"]) {
    const anyRead = await h.oracle.query<{ ok: boolean }>("SELECT has_any_column_privilege('kauro_app', $1, 'SELECT') AS ok", [`kauro.${table}`]);
    assert.equal(anyRead.rows[0]?.ok, false, `no column of ${table} is readable by the runtime role`);
  }

  const forced = await h.oracle.query<{ relname: string; force: boolean; enabled: boolean }>(
    "SELECT c.relname, c.relforcerowsecurity AS force, c.relrowsecurity AS enabled FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'kauro' AND c.relname IN ('inquiries', 'inquiry_events', 'inquiry_admissions') ORDER BY c.relname",
  );
  assert.deepEqual(forced.rows, [
    { relname: "inquiries", force: true, enabled: true },
    { relname: "inquiry_admissions", force: true, enabled: true },
    { relname: "inquiry_events", force: true, enabled: true },
  ]);

  // through a real runtime connection: the privilege errors are the database's
  const { client } = await h.appPool.acquire();
  try {
    for (const sql of ["SELECT count(*) FROM kauro.inquiries", "UPDATE kauro.inquiries SET timing = 'flexible'", "DELETE FROM kauro.inquiries", "SELECT count(*) FROM kauro.inquiry_events", "DELETE FROM kauro.inquiry_admissions", "UPDATE kauro.inquiry_admissions SET kind = 'EMAIL'"]) {
      await assert.rejects(client.query(sql), (e: { code?: string }) => e.code === "42501", sql);
    }
  } finally {
    client.release();
  }
});

test("the event and admission rows are append-only even for the table owner's statements: an event cannot be edited and states only its own inquiry", async () => {
  const ok = received(await submit({}));
  await assert.rejects(h.oracle.query("UPDATE kauro.inquiry_events SET event_type = 'inquiry.received.v1' WHERE inquiry_id = $1", [ok.inquiryId]), (e: { code?: string }) => e.code === "KA004");
  await assert.rejects(h.oracle.query("DELETE FROM kauro.inquiry_events WHERE inquiry_id = $1", [ok.inquiryId]), (e: { code?: string }) => e.code === "KA004");
  await assert.rejects(h.oracle.query("INSERT INTO kauro.inquiry_events (event_id, event_type, inquiry_id, payload, created_at) VALUES ($1, 'inquiry.received.v1', $2, $3::jsonb, now())", [ids.next(), ok.inquiryId, JSON.stringify({ inquiryId: ok.inquiryId, contactEmail: "leak@example.test" })]));
  await assert.rejects(h.oracle.query("INSERT INTO kauro.inquiry_events (event_id, event_type, inquiry_id, payload, created_at) VALUES ($1, 'inquiry.received.v1', $2, $3::jsonb, now())", [ids.next(), ok.inquiryId, JSON.stringify({ inquiryId: ids.next() })]));
  await assert.rejects(h.oracle.query("INSERT INTO kauro.inquiry_events (event_id, event_type, inquiry_id, payload, created_at) VALUES ($1, 'inquiry.something.v1', $2, $3::jsonb, now())", [ids.next(), ok.inquiryId, JSON.stringify({ inquiryId: ok.inquiryId })]));
});

// --- what the run left behind --------------------------------------------------------------------------------------------------

test("no log line and no internal error carries a submitted e-mail address or refused text, and no unexpected error was raised", async () => {
  assert.deepEqual(internalErrors.map((e) => e.correlationId), [], "no request raised an unexpected error");
  const logs = logLines.join("\n");
  assert.ok(logs.length > 0, "the api logged its requests");
  for (const value of personalData) assert.equal(logs.includes(value), false, `a log line carries ${value.slice(0, 24)}`);
});
