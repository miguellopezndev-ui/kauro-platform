// CLOCK-SWEEP-B07 lane L1 (docs/design/B07-clock-sweep-plan.md sec. 3, 5, 6; FAILURE-MATRIX-TEMPLATE rules 15, 24a-c, 25). The EXPIRY
// cells of the six deadline judgments of the source lifecycle: CompleteUpload (S1), ReserveUpload's issuance unit (S2) and its resume
// (S3), SealRevision of reused bytes (S4), SelectInputTables of reused bytes (S5) and the revision view's INTAKE_DEADLINE_PASSED (S6).
// Each judges a deadline (R2 09 "Upload reservation" / "Resumable session security": nothing accepted at or after the twenty-four-hour
// deadline; R2 09 "Retention schedule": no later than fourteen days from the first seal) at the effect instant of its unit,
// kauro.effect_now() (0038), read after the unit's last await — never at the transaction's start (kauro.server_now()).
//
// The crossing is deterministic (owner 2026-10-14: an intermittent test is a defect; no cell relies on real time crossing a margin).
// The unit is paused where its last await before the judgment returns (a proxy of that one store method of the unit, over the api's
// own unit-of-work factory), and while it is paused its transaction's TEST CLOCK offset (transaction-local, the labelled TEST CLOCK of
// @kauro/persistence/testing) is set so that kauro.server_now() reads ONE MILLISECOND BEFORE the deadline, after the transaction has
// already run at least 5 ms (pg_sleep on the same connection). kauro.effect_now() = server_now() + (clock_timestamp() -
// transaction_timestamp()) is then at least 4 ms PAST the deadline at every later statement, by construction, and the server clock
// stays before it for the rest of the transaction: the old line (uow.serverInstant()) accepts, the new line refuses, whatever the
// load. Both facts are asserted on the unit's own connection before it continues. The OK siblings place server_now() sixty seconds
// before the deadline. A P leg adds the production meeting point first (rule 24): the request is observed waiting on the revision
// row held by a control-plane writer (UPLOAD_INSPECTION's decision unit, the retention sweeper), the holder commits or rolls back,
// and the unit is then paused at its last await. Not built (deterministic only with a wall-clock margin, so kept out): a crossing
// that happens DURING the lock wait itself; the effect clock of a waiting backend can only move with real time.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import type { CreateRevisionView, ProtectedSessionView, ReserveUploadView, SelectInputTablesView } from "@kauro/application";
import { completionRefOf } from "@kauro/application/testing";
import { PENDING_RESUME_GRACE_SECONDS, acceptedObjectName, type AgencyId, type ProjectId, type SourceFileId, type UploadSessionRecord } from "@kauro/domain";
import { sealSourceRevision, type SqlSession } from "@kauro/persistence/testing";
import { SimulatedCrash, asProblem, completed, freshKey, outcome, waitForApiLockWait, world, type Reply, type World } from "./support.js";
import {
  LOCKS,
  activate,
  complete,
  controlStepOn,
  createRevision,
  csvContent,
  fixtureSessions,
  heldAdmission,
  inventoryHashOfRoute,
  issuedUploadAt,
  manifestOf,
  projectPointer,
  reserve,
  reserved,
  reuseReadyAt,
  reusableFileOf,
  revisionOf,
  seal,
  select,
  sessionUrlOf,
  setSessionLimit,
  storedManifest,
  uploadAndAdmit,
  uploadThrough,
  type Finalized,
} from "./source-support.js";
import { boundControlWriter, type HeldTransaction } from "./writers.js";

// --- the pause: one store method of a unit, its TEST CLOCK placed around the deadline while it is paused -----------------------------

const DAY_MS = 86_400_000;
const FOURTEEN_DAYS_S = 1_209_600;

type Side = "PAST" | "BEFORE";

interface Placement {
  readonly deadline: string;
  readonly serverNow: string;
  readonly effectNow: string;
}

interface Pause {
  readonly store: string;
  readonly method: string;
  readonly side: Side;
  readonly matches: (args: ReadonlyArray<unknown>, result: unknown) => boolean;
  /** The deadline the unit judges next: a database instant plus seconds (the fourteen days of reused bytes). */
  readonly deadline: (args: ReadonlyArray<unknown>, result: unknown) => { readonly at: string; readonly plusSeconds: number };
  state: "ARMED" | "PLACING" | "PLACED" | "FAILED";
  placement?: Placement;
  failure?: Error;
}

let pause: Pause | null = null;

function arm(store: string, method: string, side: Side, matches: Pause["matches"], deadline: Pause["deadline"]): Pause {
  assert.equal(pause, null, "one pause at a time");
  pause = { store, method, side, matches, deadline, state: "ARMED" };
  return pause;
}

function placed(p: Pause, what: string): Placement {
  if (p.state === "FAILED") throw p.failure ?? new Error(`${what}: the placement failed`);
  assert.equal(p.state, "PLACED", `${what}: the unit was paused at ${p.store}.${p.method} and its clock placed (the fault happened)`);
  return p.placement as Placement;
}

const EXACT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/**
 * Places the TEST CLOCK of the transaction open on `client` (the paused unit's own connection): server_now() one millisecond (PAST) or
 * sixty seconds (BEFORE) before the deadline. PAST first lets the transaction run 5 ms (pg_sleep on this connection), so effect_now()
 * is past the deadline from here on by construction. Both sides are asserted on the same connection.
 */
async function placeClock(client: SqlSession, side: Side, at: string, plusSeconds: number): Promise<Placement> {
  if (side === "PAST") await client.query("SELECT pg_sleep(0.005)");
  const lead = side === "PAST" ? "1 millisecond" : "60 seconds";
  await client.query(
    `SELECT set_config('kauro_test.clock_offset_seconds', extract(epoch FROM ($1::timestamptz + make_interval(secs => $2::double precision) - interval '${lead}' - transaction_timestamp()))::text, true)`,
    [at, plusSeconds],
  );
  const r = await client.query<{ server_before: boolean; effect_past: boolean; deadline: string; server_now: string; effect_now: string }>(
    `SELECT kauro.server_now() < d AS server_before, kauro.effect_now() >= d AS effect_past,
            to_char(d AT TIME ZONE 'UTC', ${EXACT}) AS deadline, to_char(kauro.server_now() AT TIME ZONE 'UTC', ${EXACT}) AS server_now,
            to_char(kauro.effect_now() AT TIME ZONE 'UTC', ${EXACT}) AS effect_now
       FROM (SELECT $1::timestamptz + make_interval(secs => $2::double precision) AS d) x`,
    [at, plusSeconds],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error("the paused unit's clock answered nothing");
  if (!row.server_before) throw new Error(`the paused unit's server clock ${row.server_now} is not before the deadline ${row.deadline}`);
  if (side === "PAST" && !row.effect_past) throw new Error(`the paused unit's effect clock ${row.effect_now} is not past the deadline ${row.deadline}`);
  if (side === "BEFORE" && row.effect_past) throw new Error(`the paused unit's effect clock ${row.effect_now} is already past the deadline ${row.deadline}`);
  return { deadline: row.deadline, serverNow: row.server_now, effectNow: row.effect_now };
}

function pausingStore(name: string, store: object, client: SqlSession | undefined): object {
  return new Proxy(store, {
    get(target, method) {
      const fn: unknown = Reflect.get(target, method, target);
      if (typeof fn !== "function") return fn;
      return async (...args: unknown[]) => {
        const result: unknown = await (fn as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        const p = pause;
        if (p !== null && p.state === "ARMED" && p.store === name && p.method === method && p.matches(args, result)) {
          p.state = "PLACING";
          try {
            if (client === undefined) throw new Error("the paused unit has no connection to place its clock on");
            const d = p.deadline(args, result);
            p.placement = await placeClock(client, p.side, d.at, d.plusSeconds);
            p.state = "PLACED";
          } catch (e) {
            p.state = "FAILED";
            p.failure = e instanceof Error ? e : new Error(String(e));
            throw p.failure;
          }
        }
        return result;
      };
    },
  });
}

function pausingUnit(uow: object): object {
  const client = (uow as { readonly client?: SqlSession }).client;
  let sources: object | undefined;
  return new Proxy(uow, {
    get(target, property) {
      if (property === "sources" && "sources" in target) {
        if (sources === undefined) {
          const inner = Reflect.get(target, "sources", target) as object;
          const stores = new Map<string, object>();
          sources = new Proxy(inner, {
            get(s, name) {
              const store: unknown = Reflect.get(s, name, s);
              if (typeof name !== "string" || store === null || typeof store !== "object") return store;
              let wrapped = stores.get(name);
              if (wrapped === undefined) {
                wrapped = pausingStore(name, store, client);
                stores.set(name, wrapped);
              }
              return wrapped;
            },
          });
        }
        return sources;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The api's request unit-of-work factory with every unit routed through pausingUnit (WorldOptions.wrapUnitOfWork, support.ts). */
function pausing<F extends object>(inner: F): F {
  return new Proxy(inner, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if ((prop === "run" || prop === "runSource") && typeof value === "function") {
        return (context: unknown, work: (uow: unknown) => Promise<unknown>, options?: unknown) =>
          (value as (...a: unknown[]) => Promise<unknown>).call(target, context, (uow: object) => work(pausingUnit(uow)), options);
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

let w: World;
before(async () => {
  w = await world({ wrapUnitOfWork: pausing });
  await activate(w);
  await setSessionLimit(w, w.A, 32);
});
after(async () => {
  await w.stop();
});
afterEach(() => {
  pause = null;
});

// --- facts (superuser oracle) ------------------------------------------------------------------------------------------------------

async function uploadFacts(uploadId: string): Promise<{ readonly state: string; readonly version: number; readonly attempt: number; readonly claim: string | null }> {
  const row = await w.row<{ state: string; version: string; session_attempt: string; completion_claim_digest: string | null }>("upload_sessions", "upload_id = $1", [uploadId]);
  assert.ok(row, "the upload exists");
  return { state: row.state, version: Number(row.version), attempt: Number(row.session_attempt), claim: row.completion_claim_digest };
}

async function revisionFacts(revisionId: string): Promise<{ readonly state: string; readonly version: number }> {
  const row = await w.row<{ state: string; version: string }>("dataset_revisions", "revision_id = $1", [revisionId]);
  assert.ok(row, "the revision exists");
  return { state: row.state, version: Number(row.version) };
}

async function eventTypes(kind: string, id: string): Promise<ReadonlyArray<string>> {
  return (await w.events(kind, id)).map((e) => e.type);
}

/** A sibling upload of `revisionId` reported complete (VERIFYING), ready for UPLOAD_INSPECTION's decision unit. */
async function siblingInVerification(revisionId: string): Promise<{ readonly uploadId: string; readonly finalized: Finalized }> {
  const content = csvContent(3, `cs-sibling-${freshKey("s").slice(-6)}`);
  const r = await reserved(w, revisionId, (await revisionFacts(revisionId)).version, { bytes: content.byteLength });
  const finalized = uploadThrough(w, sessionUrlOf(r), content);
  assert.equal((await complete(w, r.data.upload.uploadId, finalized.completionRef)).status, 202);
  return { uploadId: r.data.upload.uploadId, finalized };
}

/**
 * UPLOAD_INSPECTION's decision unit for the sibling, held open (revision row, then the sibling upload, D-LOCK-2): the production writer
 * a request on another upload of the revision meets on the dataset_revisions row (NO KEY UPDATE x NO KEY UPDATE).
 */
async function inspectionHolding(revisionId: string, ready?: { readonly uploadId: string; readonly finalized: Finalized }): Promise<HeldTransaction> {
  const sibling = ready ?? (await siblingInVerification(revisionId));
  return (await heldAdmission(w, w.A, sibling.uploadId, sibling.finalized)).writer;
}

/** The retention sweeper's lock of the revision row (control plane bound to the agency, as retention.ts takes it), held open. */
async function sweeperHolding(revisionId: string): Promise<HeldTransaction> {
  const writer = await boundControlWriter(w, w.A);
  try {
    const { step } = controlStepOn(writer, w.A.agencyId);
    assert.ok(await step.sources.revisions.lock(revisionId as never), "the sweeper holds the revision row");
    return writer;
  } catch (e) {
    await writer.close();
    throw e;
  }
}

/** An UPLOADING upload of a new project's revision, issued `minutesLeft` minutes before its twenty-four-hour deadline on the server clock. */
async function uploadingWithDeadlineIn(minutesLeft: number): Promise<{ readonly projectId: string; readonly revisionId: string; readonly uploadId: string; readonly deadline: string }> {
  const { projectId, revisionId } = await w.project(w.A, w.clientA);
  const issued = await issuedUploadAt(w, revisionId, new Date(Date.now() - DAY_MS + minutesLeft * 60_000), w.operator, w.memberships.operator);
  return { projectId, revisionId, uploadId: issued.uploadId, deadline: issued.deadline };
}

const recordDeadline = (_args: ReadonlyArray<unknown>, result: unknown) => ({ at: (result as UploadSessionRecord).applicationExpiresAt as string, plusSeconds: 0 });

// --- S1 CMD014 CompleteUpload --------------------------------------------------------------------------------------------------------

async function completionRefused(target: { readonly uploadId: string }, before: Awaited<ReturnType<typeof uploadFacts>>, reply: Reply, p: Pause): Promise<void> {
  const at = placed(p, "CompleteUpload");
  assert.equal(reply.status, 409, `refused (${reply.text})`);
  assert.equal(outcome(w, reply), "409 PRECONDITION_FAILED RESERVATION_EXPIRED", `judged at the effect instant ${at.effectNow}, past the deadline ${at.deadline} (server clock ${at.serverNow})`);
  assert.deepEqual(asProblem(w, reply).current, { version: before.version, state: "UPLOADING" });
  assert.deepEqual(await uploadFacts(target.uploadId), before, "the upload stays UPLOADING at its version, no claim recorded");
  assert.equal((await eventTypes("upload_session", target.uploadId)).includes("upload_session.completion_reported.v1"), false, "no completion_reported event");
}

test("CS-1L EXPIRY: CompleteUpload paused at its last await (the upload row lock) while its deadline passes on the effect clock -> 409 RESERVATION_EXPIRED, upload UPLOADING at its version, no completion_reported event", async () => {
  const target = await uploadingWithDeadlineIn(5);
  const before = await uploadFacts(target.uploadId);
  assert.equal(before.state, "UPLOADING");
  const p = arm("uploads", "lock", "PAST", (args) => args[0] === target.uploadId, recordDeadline);
  const reply = await complete(w, target.uploadId, completionRefOf({ generation: "1700000000000101", bytes: 1_000_000 }));
  await completionRefused(target, before, reply, p);
});

test("CS-1L-OK EXPIRY: CompleteUpload paused at its last await with its effect clock sixty seconds before the deadline -> 202 ACCEPTED, VERIFYING", async () => {
  const target = await uploadingWithDeadlineIn(5);
  const p = arm("uploads", "lock", "BEFORE", (args) => args[0] === target.uploadId, recordDeadline);
  const reply = await complete(w, target.uploadId, completionRefOf({ generation: "1700000000000102", bytes: 1_000_000 }));
  placed(p, "CompleteUpload");
  assert.equal(reply.status, 202, reply.text);
  assert.equal((await uploadFacts(target.uploadId)).state, "VERIFYING");
});

test("CS-1P EXPIRY: CompleteUpload waiting on the revision row held by UPLOAD_INSPECTION of a sibling upload, its deadline passing on the effect clock before its judgment -> 409 RESERVATION_EXPIRED, upload UPLOADING at its version, no completion_reported event", async () => {
  const target = await uploadingWithDeadlineIn(5);
  const holder = await inspectionHolding(target.revisionId);
  let replying: Promise<Reply> | undefined;
  const before = await uploadFacts(target.uploadId);
  const p = arm("uploads", "lock", "PAST", (args) => args[0] === target.uploadId, recordDeadline);
  try {
    replying = complete(w, target.uploadId, completionRefOf({ generation: "1700000000000103", bytes: 1_000_000 }));
    await waitForApiLockWait(w, LOCKS.revision);
    assert.equal(p.state, "ARMED", "the request waits on the revision row before its last await");
    await holder.commit();
  } finally {
    await holder.close();
  }
  await completionRefused(target, before, await (replying as Promise<Reply>), p);
});

// --- S2 CMD013 ReserveUpload, the issuance unit (unit of work 2) ------------------------------------------------------------------------

async function issuanceAbandoned(revisionId: string, key: string, reply: Reply, p: Pause, sessionsBefore: number, cancelsBefore: number): Promise<void> {
  const at = placed(p, "ReserveUpload unit 2");
  const body = completed<ReserveUploadView>(reply, 201);
  const uploadId = body.data.upload.uploadId;
  assert.equal(body.data.upload.state, "RESERVED", `the attempt is abandoned at the effect instant ${at.effectNow}, past the deadline ${at.deadline} (server clock ${at.serverNow})`);
  assert.deepEqual([(body.data.session as ProtectedSessionView).delivery, (body.data.session as ProtectedSessionView).unavailableReason], ["UNAVAILABLE", "SESSION_PENDING"]);
  assert.equal((await uploadFacts(uploadId)).state, "RESERVED");
  assert.equal(await w.count("upload_session_secrets", "upload_id = $1", [uploadId]), 0, "no session secret");
  assert.equal((await eventTypes("upload_session", uploadId)).includes("upload_session.session_issued.v1"), false, "no session_issued event");
  assert.equal(w.storage.calls("createResumableSession").length, sessionsBefore + 1, "one provider session created");
  assert.equal(w.storage.calls("cancelResumableSession").length, cancelsBefore + 1, "and cancelled (the compensation)");
  const journal = await w.journal(key);
  assert.deepEqual(journal && [journal.state, journal.status, journal.resourceId], ["COMMITTED", 201, uploadId]);
  assert.ok((await revisionFacts(revisionId)).state === "UPLOADING");
}

const reservedOf = (revisionId: string) => (_args: ReadonlyArray<unknown>, result: unknown) =>
  result !== null && (result as UploadSessionRecord).revisionId === revisionId && (result as UploadSessionRecord).state === "RESERVED";

test("CS-2L EXPIRY: ReserveUpload's issuance unit paused at its last await (the upload row lock) while the reservation deadline passes on the effect clock -> the attempt is abandoned: upload RESERVED, no session secret, no session_issued event, the provider session cancelled, journal committed, 201 with delivery UNAVAILABLE SESSION_PENDING", async () => {
  const { revisionId } = await w.project(w.A, w.clientA);
  const key = freshKey("cs-2l");
  const sessionsBefore = w.storage.calls("createResumableSession").length;
  const cancelsBefore = w.storage.calls("cancelResumableSession").length;
  const p = arm("uploads", "lock", "PAST", reservedOf(revisionId), recordDeadline);
  const reply = await reserve(w, revisionId, 1, { key });
  await issuanceAbandoned(revisionId, key, reply, p, sessionsBefore, cancelsBefore);
});

test("CS-2P EXPIRY: ReserveUpload's issuance unit waiting on the revision row held by UPLOAD_INSPECTION of a sibling upload, the reservation deadline passing on the effect clock before its judgment -> the attempt is abandoned: upload RESERVED, no session secret, no session_issued event, the provider session cancelled, journal committed, 201 UNAVAILABLE SESSION_PENDING", async () => {
  const { revisionId } = await w.project(w.A, w.clientA);
  const sibling = await siblingInVerification(revisionId);
  const key = freshKey("cs-2p");
  const version = (await revisionFacts(revisionId)).version;
  const sessionsBefore = w.storage.calls("createResumableSession").length;
  // the request is held between its units (at the provider call), so the holder takes the row before the issuance unit runs
  const providerHold = w.storage.holdNext("createResumableSession");
  const replying = reserve(w, revisionId, version, { key });
  await providerHold.reached;
  const cancelsBefore = w.storage.calls("cancelResumableSession").length;
  const holder = await inspectionHolding(revisionId, sibling);
  const p = arm("uploads", "lock", "PAST", reservedOf(revisionId), recordDeadline);
  try {
    providerHold.release();
    await waitForApiLockWait(w, LOCKS.revision);
    assert.equal(p.state, "ARMED", "the issuance unit waits on the revision row before its last await");
    await holder.commit();
  } finally {
    await holder.close();
  }
  await issuanceAbandoned(revisionId, key, await replying, p, sessionsBefore, cancelsBefore);
});

// --- S3 CMD013 ReserveUpload, the resume of a pending intent ----------------------------------------------------------------------------

test("CS-3P EXPIRY: a resumed ReserveUpload (pending past the grace) waiting on the revision row held by UPLOAD_INSPECTION of a sibling, the reservation deadline passing on the effect clock before its judgment -> no new session attempt, no provider session created, journal committed with the RESERVED view", async () => {
  const { revisionId } = await w.project(w.A, w.clientA);
  const sibling = await siblingInVerification(revisionId);
  const key = freshKey("cs-3p");
  const crash = w.holds.arm("after.commit", { fail: new SimulatedCrash("after the intent") });
  const crashed = await reserve(w, revisionId, (await revisionFacts(revisionId)).version, { key });
  await crash.reached;
  assert.equal(crashed.status, 500);
  const intentUpload = (await w.journal(key))?.resourceId as string;
  assert.deepEqual([(await uploadFacts(intentUpload)).state, (await uploadFacts(intentUpload)).attempt], ["RESERVED", 1]);
  w.processClock.advance((PENDING_RESUME_GRACE_SECONDS + 1) * 1000);
  const holder = await inspectionHolding(revisionId, sibling);
  const sessionsBefore = w.storage.calls("createResumableSession").length;
  const p = arm("uploads", "lock", "PAST", (args) => args[0] === intentUpload, recordDeadline);
  let replying: Promise<Reply> | undefined;
  try {
    replying = reserve(w, revisionId, (await revisionFacts(revisionId)).version, { key });
    await waitForApiLockWait(w, LOCKS.revision);
    assert.equal(p.state, "ARMED", "the resume waits on the revision row before its last await");
    await holder.commit();
  } finally {
    await holder.close();
  }
  const reply = await (replying as Promise<Reply>);
  const at = placed(p, "ReserveUpload resume");
  const body = completed<ReserveUploadView>(reply, 201);
  assert.equal(body.data.upload.state, "RESERVED", `the resume is refused at the effect instant ${at.effectNow}, past ${at.deadline} (server clock ${at.serverNow})`);
  assert.deepEqual([(await uploadFacts(intentUpload)).state, (await uploadFacts(intentUpload)).attempt], ["RESERVED", 1], "no new session attempt");
  assert.equal(w.storage.calls("createResumableSession").length, sessionsBefore, "no provider session created");
  const journal = await w.journal(key);
  assert.deepEqual(journal && [journal.state, journal.status], ["COMMITTED", 201]);
});

// --- S4 CMD017 SealRevision of reused bytes ---------------------------------------------------------------------------------------------

function scopeOf(projectId: string) {
  return { agencyId: w.A.agencyId, projectId, ownerUserId: w.A.ownerUserId, ownerMembershipId: w.A.ownerMembershipId };
}

/** The labelled storage fake holds the generation the source-lifecycle fixture recorded for a file it admitted (cmd017's helper). */
async function providerHoldsFixtureFile(projectId: string, fileId: string): Promise<void> {
  const file = await w.row<{ provider_generation: string; bytes: string }>("source_files", "file_id = $1", [fileId]);
  assert.ok(file);
  const objectName = acceptedObjectName(w.A.agencyId as AgencyId, projectId as ProjectId, fileId as SourceFileId);
  w.storage.plantGeneration(w.storage.location("ACCEPTED"), objectName, new Uint8Array(Number(file.bytes)), file.provider_generation);
}

/** Bytes first sealed fourteen days less five minutes ago (the source-lifecycle fixture on the TEST CLOCK): their window is still open. */
async function bytesSealedAlmostFourteenDaysAgo(seed: string): Promise<{ readonly projectId: string; readonly revisionId: string; readonly fileId: string; readonly sealedAt: string }> {
  const old = await w.project(w.A, w.clientA);
  const sealed = await sealSourceRevision(fixtureSessions(w, w.A), scopeOf(old.projectId), { seed, base: new Date(Date.now() - 14 * DAY_MS + 5 * 60_000) });
  assert.ok(Date.parse(sealed.sealedAt) + FOURTEEN_DAYS_S * 1000 > Date.now() + 60_000, "the bytes' window is still open");
  return { projectId: old.projectId, revisionId: sealed.revisionId, fileId: sealed.fileId, sealedAt: sealed.sealedAt };
}

const firstSealOf = (fileId: string) => (args: ReadonlyArray<unknown>) => Array.isArray(args[0]) && (args[0] as ReadonlyArray<string>).includes(fileId);
const fourteenDaysAfterFirstSeal = (_args: ReadonlyArray<unknown>, result: unknown) => {
  const first = (result as ReadonlyArray<{ readonly sealedAt: string }>)[0];
  assert.ok(first !== undefined, "the bytes have a first seal");
  return { at: first.sealedAt, plusSeconds: FOURTEEN_DAYS_S };
};

async function sealRefused(revisionId: string, version: number, reply: Reply, p: Pause): Promise<void> {
  const at = placed(p, "SealRevision");
  assert.equal(reply.status, 409, `refused (${reply.text})`);
  assert.equal(outcome(w, reply), "409 PRECONDITION_FAILED REUSE_NOT_AVAILABLE", `judged at the effect instant ${at.effectNow}, past the bytes' cap ${at.deadline} (server clock ${at.serverNow})`);
  assert.deepEqual(await revisionFacts(revisionId), { state: "READY_TO_SEAL", version });
  assert.equal(await w.count("sealed_manifests", "revision_id = $1", [revisionId]), 0, "no sealed manifest");
  assert.equal((await eventTypes("dataset_revision", revisionId)).includes("dataset_revision.sealed.v1"), false, "no sealed event");
}

test("CS-4L EXPIRY: SealRevision of reused bytes paused at its last await (the bytes' first seals) while the first seal's fourteen days pass on the effect clock -> 409 REUSE_NOT_AVAILABLE, no sealed manifest, revision READY_TO_SEAL", async () => {
  const bytes = await bytesSealedAlmostFourteenDaysAgo("cs-4l");
  await providerHoldsFixtureFile(bytes.projectId, bytes.fileId);
  const reuse = await reuseReadyAt(w, bytes.projectId, { revisionId: bytes.revisionId, fileId: bytes.fileId }, new Date(Date.parse(bytes.sealedAt) + 60_000));
  const p = arm("seals", "firstSeals", "PAST", firstSealOf(bytes.fileId), fourteenDaysAfterFirstSeal);
  const reply = await seal(w, reuse.revisionId, reuse.version, reuse.selectionHash);
  await sealRefused(reuse.revisionId, reuse.version, reply, p);
});

test("CS-4P EXPIRY: SealRevision of reused bytes waiting on the revision row held by the retention sweeper, the first seal's fourteen days passing on the effect clock before its judgment -> 409 REUSE_NOT_AVAILABLE, no sealed manifest, revision READY_TO_SEAL", async () => {
  const bytes = await bytesSealedAlmostFourteenDaysAgo("cs-4p");
  await providerHoldsFixtureFile(bytes.projectId, bytes.fileId);
  const reuse = await reuseReadyAt(w, bytes.projectId, { revisionId: bytes.revisionId, fileId: bytes.fileId }, new Date(Date.parse(bytes.sealedAt) + 60_000));
  const holder = await sweeperHolding(reuse.revisionId);
  const p = arm("seals", "firstSeals", "PAST", firstSealOf(bytes.fileId), fourteenDaysAfterFirstSeal);
  let replying: Promise<Reply> | undefined;
  try {
    replying = seal(w, reuse.revisionId, reuse.version, reuse.selectionHash);
    await waitForApiLockWait(w, LOCKS.revision);
    assert.equal(p.state, "ARMED", "the seal waits on the revision row before its last await");
    await holder.commit();
  } finally {
    await holder.close();
  }
  await sealRefused(reuse.revisionId, reuse.version, await (replying as Promise<Reply>), p);
});

// --- S5 CMD016 SelectInputTables of reused bytes ----------------------------------------------------------------------------------------

async function selectionRefused(revisionId: string, before: Awaited<ReturnType<typeof revisionFacts>>, reply: Reply, p: Pause): Promise<void> {
  const at = placed(p, "SelectInputTables");
  assert.equal(reply.status, 409, `refused (${reply.text})`);
  assert.equal(outcome(w, reply), "409 PRECONDITION_FAILED REUSE_NOT_AVAILABLE", `judged at the effect instant ${at.effectNow}, past ${at.deadline} (server clock ${at.serverNow})`);
  assert.deepEqual(await revisionFacts(revisionId), before, "the revision is unchanged");
  assert.equal((await eventTypes("dataset_revision", revisionId)).includes("dataset_revision.selection_changed.v1"), false, "no selection_changed event");
}

async function successorReusing(projectId: string, predecessorId: string, fileId: string): Promise<{ readonly revisionId: string; readonly selectionManifestId: string }> {
  const pointer = await projectPointer(w, projectId);
  const successor = completed<CreateRevisionView>(await createRevision(w, projectId, pointer.version, predecessorId), 201).data.revision.revisionId;
  const file = await reusableFileOf(w, fileId);
  const document = manifestOf(successor, await inventoryHashOfRoute(w, successor), [{ file, origin: "REUSED" }]);
  return { revisionId: successor, selectionManifestId: (await storedManifest(w, successor, document)).selectionManifestId };
}

test("CS-5a EXPIRY: SelectInputTables including a reused file, paused after the bytes' first seals are read while the first seal's fourteen days pass on the effect clock -> 409 REUSE_NOT_AVAILABLE, revision unchanged, no selection_changed event", async () => {
  const bytes = await bytesSealedAlmostFourteenDaysAgo("cs-5a");
  const successor = await successorReusing(bytes.projectId, bytes.revisionId, bytes.fileId);
  const before = await revisionFacts(successor.revisionId);
  const p = arm("seals", "firstSeals", "PAST", firstSealOf(bytes.fileId), fourteenDaysAfterFirstSeal);
  const reply = await select(w, successor.revisionId, before.version, successor.selectionManifestId);
  await selectionRefused(successor.revisionId, before, reply, p);
});

test("CS-5b EXPIRY: SelectInputTables including never-sealed reused bytes, paused after their origin upload is read while its intake deadline passes on the effect clock -> 409 REUSE_NOT_AVAILABLE, revision unchanged", async () => {
  const { projectId, revisionId } = await w.project(w.A, w.clientA);
  const file = await uploadAndAdmit(w, revisionId, 1);
  const successor = await successorReusing(projectId, revisionId, file.fileId);
  const before = await revisionFacts(successor.revisionId);
  const p = arm("uploads", "get", "PAST", (args) => args[0] === file.uploadId, recordDeadline);
  const reply = await select(w, successor.revisionId, before.version, successor.selectionManifestId);
  await selectionRefused(successor.revisionId, before, reply, p);
});

test("CS-5a-OK EXPIRY: SelectInputTables including a reused file, its effect clock placed sixty seconds before the first seal's fourteen days -> 200, the file bound as reused", async () => {
  const bytes = await bytesSealedAlmostFourteenDaysAgo("cs-5a-ok");
  const successor = await successorReusing(bytes.projectId, bytes.revisionId, bytes.fileId);
  const before = await revisionFacts(successor.revisionId);
  const p = arm("seals", "firstSeals", "BEFORE", firstSealOf(bytes.fileId), fourteenDaysAfterFirstSeal);
  const body = completed<SelectInputTablesView>(await select(w, successor.revisionId, before.version, successor.selectionManifestId), 200);
  placed(p, "SelectInputTables");
  assert.deepEqual(body.data.selection.reusedFileIds, [bytes.fileId]);
});

// --- S6 the revision view's INTAKE_DEADLINE_PASSED (display; D-CS-2) --------------------------------------------------------------------

test("CS-6 EXPIRY: GetRevision of an UPLOADING revision whose every upload is UPLOADING, paused after the inventory read while the deadline passes on the effect clock -> blockers include INTAKE_DEADLINE_PASSED", async () => {
  const target = await uploadingWithDeadlineIn(5);
  const p = arm("revisions", "inventory", "PAST", (args) => args[0] === target.revisionId, () => ({ at: target.deadline, plusSeconds: 0 }));
  const view = await revisionOf(w, target.revisionId);
  const at = placed(p, "GetRevision");
  assert.equal(view.state, "UPLOADING");
  assert.ok(view.blockers.includes("INTAKE_DEADLINE_PASSED"), `read at the effect instant ${at.effectNow}, past ${at.deadline} (server clock ${at.serverNow}): ${JSON.stringify(view.blockers)}`);
});

test("CS-6-OK EXPIRY: GetRevision of the same shape read sixty seconds before the deadline on the effect clock -> no INTAKE_DEADLINE_PASSED", async () => {
  const target = await uploadingWithDeadlineIn(5);
  const p = arm("revisions", "inventory", "BEFORE", (args) => args[0] === target.revisionId, () => ({ at: target.deadline, plusSeconds: 0 }));
  const view = await revisionOf(w, target.revisionId);
  placed(p, "GetRevision");
  assert.equal(view.state, "UPLOADING");
  assert.equal(view.blockers.includes("INTAKE_DEADLINE_PASSED"), false, JSON.stringify(view.blockers));
});
