// CMD060 RequestRetentionExtension (package B16, lane L2; docs/design/B16-L2-failure-matrix.md; .kauro plan B16-REST-PLAN section 2
// "CMD060" and conflict C1). Written before the product (tests first): the real route over the real authorizer, journal and
// PostgreSQL 17 through the runtime login roles. The governing record is the PAID_ORDINARY record the production writers leave: a paid
// purchase executed by the control plane's steps (admit, launch, stage, verify, publish), whose first package set the soft deadline
// (+ 604,800 s) under the hard cap (capture + 1,209,600 s). Where a title needs a deadline the writers reach only with time (the soft
// deadline 24 h before the hard cap, or at it), the superuser moves it, said so where it does. The RETENTION sweeper's record step is
// run as apps/control's sweeper runs it (revision lock, record re-read, the deadline on the server clock, the version CAS, the event)
// over the control role's units of work, on the labelled TEST CLOCK. The oracle is the superuser.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import type { PoolClient } from "pg";
import { AUTHORITY_TOMBSTONES } from "@kauro/application";
import { barrier, controlOf, controlledClock, publishJob, waitForLockWait, type SqlSession } from "@kauro/persistence/testing";
import { paymentsWorld, read, readData, type PaymentsWorld } from "./commerce-support.js";
import { endLiveJobs, heldPublication, revisionIdOf, verifyingJob } from "./execution-support.js";
import { activePerson, suspendMember } from "./team-support.js";
import { SimulatedCrash, call, freshKey, ids, rawEvent, replayTextOf, rootCause, waitForApiLockWait, type Hold, type HoldName, type Person, type Reply } from "./support.js";

// --- the world: the api's units of work may stand on the TEST CLOCK (GAP-RET-3) ------------------------------------------------------

/** While set, every api unit of work opens with kauro.server_now() at this instant (transaction-local offset of the TEST CLOCK). */
let stand: string | null = null;

function standing<F extends object>(inner: F): F {
  return new Proxy(inner, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if ((prop === "run" || prop === "runSource") && typeof value === "function") {
        return (context: unknown, work: (uow: unknown) => Promise<unknown>, options?: unknown) =>
          (value as (...a: unknown[]) => Promise<unknown>).call(
            target,
            context,
            async (uow: unknown) => {
              const at = stand;
              if (at !== null) {
                await (uow as { readonly client: SqlSession }).client.query(
                  "SELECT set_config('kauro_test.clock_offset_seconds', extract(epoch FROM ($1::timestamptz - transaction_timestamp()))::text, true)",
                  [at],
                );
              }
              return work(uow);
            },
            options,
          );
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

let pw: PaymentsWorld;
let termsVersion: string;
before(async () => {
  pw = await paymentsWorld({ unbound: ["capacity"], wrapUnitOfWork: standing });
  const agency = await pw.w.row<{ terms_version: string }>("agencies", "agency_id = $1", [pw.w.A.agencyId]);
  assert.ok(agency !== null && typeof agency.terms_version === "string", "agency A accepted its terms");
  termsVersion = agency.terms_version;
});
after(async () => {
  await pw.stop();
});
afterEach(async () => {
  stand = null;
  for (const name of pw.w.holds.armedNames) await pw.w.holds.pass(name).catch(() => undefined);
  await endLiveJobs(pw);
});

// --- units and instants -------------------------------------------------------------------------------------------------------------

const MAX_SECONDS = 259_200;
const SECOND_US = 1_000_000n;
const HOUR_US = 3_600n * SECOND_US;
const usOf = (s: string | null): bigint => {
  assert.ok(s !== null, "the deadline is set");
  return BigInt(s);
};
const msOf = (us: bigint): number => Number(us / 1000n);
const isoOf = (ms: number): string => new Date(ms).toISOString();

// --- fixtures -------------------------------------------------------------------------------------------------------------------------

interface RecordRow {
  readonly retention_id: string;
  readonly version: string;
  readonly state: string;
  readonly class: string;
  readonly soft_us: string | null;
  readonly hard_us: string;
  readonly effective_us: string;
  readonly expired_at: string | null;
  readonly updated_at: string;
}

const RECORD_COLUMNS = `retention_id, version::text AS version, state, class,
  (extract(epoch FROM soft_deadline) * 1000000)::bigint::text AS soft_us,
  (extract(epoch FROM hard_deadline) * 1000000)::bigint::text AS hard_us,
  (extract(epoch FROM effective_deadline) * 1000000)::bigint::text AS effective_us,
  expired_at::text AS expired_at, updated_at::text AS updated_at`;

async function recordOf(retentionId: string): Promise<RecordRow> {
  const r = await pw.w.h.oracle.query<RecordRow>(`SELECT ${RECORD_COLUMNS} FROM kauro.retention_records WHERE retention_id = $1`, [retentionId]);
  assert.equal(r.rows.length, 1, "the record exists");
  return r.rows[0]!;
}

interface Governed {
  readonly projectId: string;
  readonly revisionId: string;
  readonly retentionId: string;
  readonly jobId: string;
}

/** A paid purchase executed to its first package: its revision's PAID_ORDINARY record carries the publication's soft deadline. */
async function published(label: string): Promise<Governed & { readonly record: RecordRow }> {
  const v = await verifyingJob(pw, label);
  const outcome = await publishJob(pw.w.h, pw.w.A, v.jobId);
  assert.equal(outcome.kind, "PUBLISHED");
  const g = await governed(v.sale, v.jobId);
  const record = await recordOf(g.retentionId);
  assert.notEqual(record.soft_us, null, "the first package set the soft deadline");
  assert.deepEqual([record.class, record.state], ["PAID_ORDINARY", "ACTIVE"]);
  assert.ok(usOf(record.soft_us) + BigInt(MAX_SECONDS) * SECOND_US < usOf(record.hard_us), "the fixture leaves 72 h of room under the hard cap");
  return { ...g, record };
}

async function governed(sale: Parameters<typeof revisionIdOf>[1], jobId: string): Promise<Governed> {
  const revisionId = await revisionIdOf(pw, sale);
  const r = await pw.w.h.oracle.query<{ retention_id: string }>("SELECT retention_id FROM kauro.retention_records WHERE revision_id = $1 AND class = 'PAID_ORDINARY'", [revisionId]);
  assert.equal(r.rows.length, 1, "one PAID_ORDINARY record governs the purchased source");
  return { projectId: sale.projectId, revisionId, retentionId: r.rows[0]!.retention_id, jobId };
}

/** Moves the soft deadline as the superuser with triggers off (a deadline the writers reach only with time), effective = minimum. */
async function placeSoft(retentionId: string, expression: "hard_deadline - interval '24 hours'" | "hard_deadline" | "hard_deadline - interval '48 hours'"): Promise<void> {
  const c = pw.w.h.oracle;
  try {
    await c.query("SET session_replication_role = replica");
    const r = await c.query(`UPDATE kauro.retention_records SET soft_deadline = ${expression}, effective_deadline = least(${expression}, hard_deadline) WHERE retention_id = $1`, [retentionId]);
    assert.equal(r.rowCount, 1);
  } finally {
    await c.query("RESET session_replication_role");
  }
}

// --- the command ----------------------------------------------------------------------------------------------------------------------

interface ExtensionView {
  readonly extensionId: string;
  readonly projectId: string;
  readonly retentionId: string;
  readonly retentionVersion: number;
  readonly requestedSeconds: number;
  readonly grantedSeconds: number;
  readonly previousSoftDeadline: string;
  readonly softDeadline: string;
  readonly hardDeadline: string;
  readonly effectiveDeadline: string;
  readonly cappedAtHardDeadline: boolean;
}

const extensionRoute = (projectId: string): string => `/api/v1/projects/${projectId}/retention-extensions`;

function extend(projectId: string, body: { readonly expectedVersion: number; readonly requestedSeconds: number }, options: { readonly key?: string; readonly token?: string; readonly agency?: string } = {}): Promise<Reply> {
  return call(pw.w, {
    url: extensionRoute(projectId),
    token: options.token ?? pw.w.owner.token,
    agency: options.agency ?? pw.w.A.agencyId,
    key: options.key ?? freshKey("cmd060"),
    body: { expectedVersion: body.expectedVersion, requestedSeconds: body.requestedSeconds, purpose: "CLIENT_REVIEW", termsVersion },
  });
}

/** `${status} ${code} ${reason}` of any reply, never throwing (an unexpected success or a non-problem body is shown as such). */
function answer(reply: Reply): string {
  if (reply.status < 400) return `${reply.status} SUCCESS ${reply.text.slice(0, 200)}`;
  try {
    const p = reply.json<{ code?: string; reason?: string }>();
    return `${reply.status} ${p.code ?? "?"} ${p.reason ?? "-"}`;
  } catch {
    return `${reply.status} ${reply.text.slice(0, 200)}`;
  }
}

/** The COMPLETED 200 of an extension (an assertion failure naming the reply otherwise). */
function granted(reply: Reply): { readonly replayed: boolean; readonly data: ExtensionView } {
  assert.equal(reply.status, 200, `CMD060 answered ${answer(reply)}`);
  const body = reply.json<{ kind: string; replayed: boolean; data: ExtensionView }>();
  assert.equal(body.kind, "COMPLETED");
  return body;
}

async function reached(hold: Hold, reply: Promise<Reply>, what: string): Promise<void> {
  const first = await Promise.race([hold.reached.then(() => null), reply]);
  if (first !== null) assert.fail(`${what} answered ${answer(first)} before reaching its hold point`);
}

/** The api backend of `reply` is observed blocked on a lock in a statement containing `fragment` (a reply that settles first fails). */
async function waitsOn(reply: Promise<Reply>, fragment: string, what: string): Promise<number> {
  const waiting = waitForApiLockWait(pw.w, fragment);
  waiting.catch(() => undefined);
  const first = await Promise.race([waiting, reply]);
  if (typeof first !== "number") assert.fail(`${what} answered ${answer(first)} without waiting on ${fragment}`);
  return first;
}

// HoldPoints.pass() removes a hold from armedNames the moment a unit of work REACHES it, so a guard on armedNames skipped the release
// of exactly the holds that are held (the held transaction then died of idle_in_transaction_session_timeout): releasing is idempotent.
function release(hold: Hold | null, _name: HoldName): void {
  if (hold !== null) hold.release();
}

// --- footprints -----------------------------------------------------------------------------------------------------------------------

/** Rows of the extension table for a project; -1 while the table does not exist (the base). */
async function extensionsOf(projectId: string): Promise<number> {
  const present = await pw.w.h.oracle.query<{ present: boolean }>("SELECT to_regclass('kauro.retention_extensions') IS NOT NULL AS present");
  if (present.rows[0]?.present !== true) return -1;
  return pw.w.count("retention_extensions", "project_id = $1", [projectId]);
}

async function eventsOf(retentionId: string): Promise<ReadonlyArray<{ readonly event_type: string; readonly aggregate_version: string }>> {
  return (await pw.w.h.oracle.query<{ event_type: string; aggregate_version: string }>("SELECT event_type, aggregate_version::text AS aggregate_version FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version", [retentionId])).rows;
}

async function journalOf(key: string): Promise<ReadonlyArray<{ readonly state: string; readonly response_status: number | null }>> {
  return (await pw.w.h.oracle.query<{ state: string; response_status: number | null }>("SELECT state, response_status FROM kauro.command_journal WHERE operation = 'CMD060' AND idempotency_key = $1", [key])).rows;
}

interface Footprint {
  readonly record: string;
  readonly extensions: number;
  readonly events: number;
  readonly committedCmd060: number;
  readonly tombstoneRoutes: number;
}

async function footprint(g: Governed): Promise<Footprint> {
  return {
    record: JSON.stringify(await recordOf(g.retentionId)),
    extensions: await extensionsOf(g.projectId),
    events: (await eventsOf(g.retentionId)).length,
    committedCmd060: await pw.w.count("command_journal", "operation = 'CMD060' AND agency_id = $1 AND state = 'COMMITTED'", [pw.w.A.agencyId]),
    tombstoneRoutes: Number(
      (await pw.w.h.oracle.query<{ n: string }>("SELECT count(*)::text AS n FROM kauro.outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id WHERE o.consumer = 'AUTHORITY_JOURNAL' AND e.agency_id = $1", [pw.w.A.agencyId])).rows[0]!.n,
    ),
  };
}

// --- the RETENTION sweeper's record step, as apps/control/src/sweepers/retention.ts takes it, on the TEST CLOCK ------------------------

/**
 * Step 1 of RETENTION for one record at `atMs` on the TEST CLOCK: the revision lock, the record re-read, its deadline on the server
 * clock, the version CAS (expireRecord) and retention_record.expired.v1; `written` fires after the writes, `hold` keeps the unit open.
 */
function sweeperExpiry(g: Governed, atMs: number, options: { readonly written?: () => void; readonly hold?: Promise<void> } = {}): Promise<string> {
  return pw.w.h.control.runSource(controlOf(pw.w.A.agencyId), async (uow) => {
    await controlledClock(atMs).onServer((uow as unknown as { readonly client: SqlSession }).client);
    if ((await uow.sources.revisions.lock(g.revisionId as never)) === null) return "NO_REVISION";
    const record = (await uow.sources.retention.recordsFor(g.revisionId as never)).find((r) => r.retentionId === g.retentionId);
    if (record === undefined || record.state !== "ACTIVE") return "NOT_ACTIVE";
    if (Date.parse(record.effectiveDeadline) > Date.parse(await uow.serverInstant())) return "NOT_DUE";
    const expired = await uow.sources.retention.expireRecord(record.retentionId, record.version);
    if (expired.kind !== "APPLIED") return expired.kind;
    const context = uow.context as { readonly serviceId: string; readonly correlationId: string };
    await uow.events.publish({
      aggregateKind: "retention_record",
      aggregateId: record.retentionId,
      aggregateVersion: expired.record.version,
      agencyId: pw.w.A.agencyId,
      eventType: "retention_record.expired.v1",
      actor: { kind: "SERVICE", serviceId: context.serviceId },
      causationId: ids.next() as never,
      correlationId: context.correlationId as never,
      payload: { retentionId: record.retentionId, agencyId: pw.w.A.agencyId, projectId: record.projectId, revisionId: g.revisionId, retentionClass: record.class },
    } as never);
    options.written?.();
    if (options.hold !== undefined) await options.hold;
    return "EXPIRED";
  });
}

/** RETENTION's discovery (findDue) at `atMs` on the TEST CLOCK: is the record due? */
function dueAt(g: Governed, atMs: number): Promise<boolean> {
  return pw.w.h.control.runSource(controlOf(pw.w.A.agencyId), async (uow) => {
    await controlledClock(atMs).onServer((uow as unknown as { readonly client: SqlSession }).client);
    return (await uow.sources.retention.findDue(1000)).some((r) => r.retentionId === g.retentionId);
  });
}

/** A control-plane transaction of agency A, left open (the caller commits or rolls back and releases). */
async function controlTx(): Promise<PoolClient> {
  const c = await pw.w.h.controlPool.connectUnverified();
  await c.query("BEGIN");
  await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true)", [pw.w.A.agencyId]);
  return c as unknown as PoolClient;
}

async function ownerTx(): Promise<PoolClient> {
  const c = await pw.w.h.appPool.connectUnverified();
  await c.query("BEGIN");
  await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [pw.w.A.agencyId, pw.w.owner.userId]);
  return c as unknown as PoolClient;
}

async function end(c: PoolClient, how: "COMMIT" | "ROLLBACK"): Promise<void> {
  try {
    await c.query(how);
  } finally {
    c.release();
  }
}

// --- OK and the cases -------------------------------------------------------------------------------------------------------------------

test("CMD060-OK: one extension of a PAID_ORDINARY soft deadline by <=259200 s inside the hard cap: exact endpoint returned, hard_deadline unchanged, retention_record.extended.v1 and the journal entry written, RETENTION and GetRevision read the new effective deadline", async () => {
  const g = await published("cmd060-ok");
  const soft = usOf(g.record.soft_us);
  const hard = usOf(g.record.hard_us);
  const version = Number(g.record.version);
  const endpoint = soft + BigInt(MAX_SECONDS) * SECOND_US;
  // before: RETENTION finds the record due one hour after its soft deadline
  assert.equal(await dueAt(g, msOf(soft + HOUR_US)), true, "before the extension the record is due an hour past its soft deadline");

  const key = freshKey("cmd060-ok");
  const done = granted(await extend(g.projectId, { expectedVersion: version, requestedSeconds: MAX_SECONDS }, { key }));
  assert.equal(done.replayed, false);
  const x = done.data;
  assert.deepEqual(
    [x.projectId, x.retentionId, x.retentionVersion, x.requestedSeconds, x.grantedSeconds, x.cappedAtHardDeadline],
    [g.projectId, g.retentionId, version + 1, MAX_SECONDS, MAX_SECONDS, false],
  );
  assert.equal(Date.parse(x.previousSoftDeadline), msOf(soft), "the previous soft deadline");
  assert.equal(Date.parse(x.softDeadline), msOf(endpoint), "the exact endpoint: soft + 259200 s");
  assert.equal(Date.parse(x.effectiveDeadline), msOf(endpoint), "effective = least(new soft, hard)");
  assert.equal(Date.parse(x.hardDeadline), msOf(hard), "the hard cap shown unchanged");

  // the record: one version, the soft and effective deadlines moved by exactly 259200 s, the hard cap untouched
  const row = await recordOf(g.retentionId);
  assert.deepEqual(
    [row.version, row.state, row.soft_us, row.effective_us, row.hard_us, row.expired_at],
    [String(version + 1), "ACTIVE", String(endpoint), String(endpoint), String(hard), null],
  );
  assert.equal(await extensionsOf(g.projectId), 1, "one extension row");
  assert.deepEqual((await eventsOf(g.retentionId)).filter((e) => Number(e.aggregate_version) > version), [{ event_type: "retention_record.extended.v1", aggregate_version: String(version + 1) }]);
  assert.deepEqual(await journalOf(key), [{ state: "COMMITTED", response_status: 200 }], "the journal entry of CMD060");

  // GAP-RET-9 consumers. GetRevision (the source screen): the record's new deadlines and dataAvailableUntil = the earliest ACTIVE one
  const view = readData<{ dataAvailableUntil?: string; retention?: ReadonlyArray<{ retentionId: string; softDeadline?: string; hardDeadline: string; effectiveDeadline: string }> }>(
    await read(pw.w, `/api/v1/revisions/${g.revisionId}`, pw.w.owner.token),
  );
  const shown = view.retention?.find((r) => r.retentionId === g.retentionId);
  assert.ok(shown !== undefined, "GetRevision shows the PAID_ORDINARY record");
  assert.deepEqual([Date.parse(shown.softDeadline ?? ""), Date.parse(shown.effectiveDeadline), Date.parse(shown.hardDeadline)], [msOf(endpoint), msOf(endpoint), msOf(hard)]);
  const earliest = (await pw.w.h.oracle.query<{ us: string }>("SELECT (extract(epoch FROM min(effective_deadline)) * 1000000)::bigint::text AS us FROM kauro.retention_records WHERE revision_id = $1 AND state = 'ACTIVE'", [g.revisionId])).rows[0]!.us;
  assert.equal(earliest, String(endpoint), "the extended record is the revision's earliest ACTIVE deadline");
  assert.equal(Date.parse(view.dataAvailableUntil ?? ""), msOf(endpoint), "dataAvailableUntil is the new effective deadline");
  // RETENTION reads the effective deadline: not due an hour past the old soft deadline, due just past the new one
  assert.equal(await dueAt(g, msOf(soft + HOUR_US)), false, "an hour past the old soft deadline the extended record is not due");
  assert.equal(await dueAt(g, msOf(endpoint) + 1), true, "just past the new effective deadline it is due");
});

test("R2-123: 72 h requested 24 h before the hard cap grants exactly the hard cap, discloses it and consumes the one extension", async () => {
  const g = await published("r2-123");
  // the superuser places the soft deadline 24 h before the hard cap (the writers reach it only with time)
  await placeSoft(g.retentionId, "hard_deadline - interval '24 hours'");
  const placed = await recordOf(g.retentionId);
  const hard = usOf(placed.hard_us);
  assert.equal(usOf(placed.soft_us), hard - 24n * HOUR_US);
  const version = Number(placed.version);

  const x = granted(await extend(g.projectId, { expectedVersion: version, requestedSeconds: MAX_SECONDS })).data;
  // at most the remaining 24 hours, disclosed: the exact endpoint is the hard cap, capped and said so
  assert.deepEqual([x.requestedSeconds, x.grantedSeconds, x.cappedAtHardDeadline, x.retentionVersion], [MAX_SECONDS, 86_400, true, version + 1]);
  assert.deepEqual([Date.parse(x.softDeadline), Date.parse(x.effectiveDeadline), Date.parse(x.hardDeadline)], [msOf(hard), msOf(hard), msOf(hard)]);
  const row = await recordOf(g.retentionId);
  assert.deepEqual([row.version, row.soft_us, row.effective_us, row.hard_us], [String(version + 1), String(hard), String(hard), String(hard)], "never past the hard cap, which never moves");
  assert.equal(await extensionsOf(g.projectId), 1);

  // the one extension is consumed: another request is EXTENSION_ALREADY_USED and changes nothing
  const before = await footprint(g);
  assert.equal(answer(await extend(g.projectId, { expectedVersion: version + 1, requestedSeconds: 3_600 })), "409 PRECONDITION_FAILED EXTENSION_ALREADY_USED");
  assert.deepEqual(await footprint(g), before);
});

test("R2-124: a second extension and one after expiry are refused; no clock, access or tombstone changes", async () => {
  // a second extension of a project that used its one
  const g = await published("r2-124-second");
  const version = Number(g.record.version);
  const first = granted(await extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 })).data;
  assert.equal(Date.parse(first.softDeadline), msOf(usOf(g.record.soft_us) + HOUR_US));
  const used = await footprint(g);
  assert.equal(answer(await extend(g.projectId, { expectedVersion: version + 1, requestedSeconds: 3_600 })), "409 PRECONDITION_FAILED EXTENSION_ALREADY_USED");
  assert.equal(answer(await extend(g.projectId, { expectedVersion: version + 1, requestedSeconds: MAX_SECONDS })), "409 PRECONDITION_FAILED EXTENSION_ALREADY_USED");
  assert.deepEqual(await footprint(g), used, "no clock reset, no second row, no event, no tombstone");

  // one after expiry: RETENTION expired the record (a second past its effective deadline on the TEST CLOCK)
  const e = await published("r2-124-expired");
  assert.equal(await sweeperExpiry(e, msOf(usOf(e.record.effective_us)) + 1_000), "EXPIRED");
  const expired = await recordOf(e.retentionId);
  assert.deepEqual([expired.state, expired.version], ["EXPIRED", String(Number(e.record.version) + 1)]);
  const revision = async () => JSON.stringify(await pw.w.row("dataset_revisions", "revision_id = $1", [e.revisionId]));
  const access = await revision();
  const before = await footprint(e);
  assert.equal(answer(await extend(e.projectId, { expectedVersion: Number(expired.version), requestedSeconds: 3_600 })), "409 PRECONDITION_FAILED RETENTION_EXPIRED");
  assert.deepEqual(await footprint(e), before, "the record stays EXPIRED with its deadlines; nothing written");
  assert.equal(await revision(), access, "the revision (access) is unchanged");
});

// --- RACE ------------------------------------------------------------------------------------------------------------------------------

test("CMD060-RACE: an extension held at the record lock against RETENTION expiry, both orders — first the sweeper's CAS misses and nothing expires, then the extension refuses RETENTION_EXPIRED; two extensions of one project: one 200, one 409 EXTENSION_ALREADY_USED or STALE_VERSION", async () => {
  // order 1: the extension holds the record (written, before its journal commit); RETENTION, a second past the old soft deadline on
  // the TEST CLOCK, read the committed record due and waits at its CAS; the extension commits; the CAS misses and nothing expires
  {
    const g = await published("cmd060-race-ext-first");
    const soft = usOf(g.record.soft_us);
    const version = Number(g.record.version);
    const hold = pw.w.holds.arm("journal.commit");
    const reply = extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 });
    let sweeper: Promise<string> | null = null;
    try {
      await reached(hold, reply, "the extension");
      sweeper = sweeperExpiry(g, msOf(soft) + 1_000);
      const waiting = waitForLockWait(pw.w.h.oracle, "kauro-test-control", "kauro.");
      waiting.catch(() => undefined);
      const first = await Promise.race([waiting, sweeper]);
      if (typeof first !== "number") assert.fail(`RETENTION settled ${first} without waiting on the extension's record lock`);
    } finally {
      release(hold, "journal.commit");
    }
    const ext = granted(await reply).data;
    assert.equal(await sweeper, "STALE", "the sweeper's CAS missed the extended version");
    assert.equal(Date.parse(ext.softDeadline), msOf(soft + HOUR_US));
    const row = await recordOf(g.retentionId);
    assert.deepEqual([row.state, row.version, row.expired_at, row.soft_us, row.effective_us], ["ACTIVE", String(version + 1), null, String(soft + HOUR_US), String(soft + HOUR_US)], "nothing expired");
    assert.equal((await eventsOf(g.retentionId)).some((e) => e.event_type === "retention_record.expired.v1"), false);
  }

  // order 2: RETENTION holds the record EXPIRED (written, uncommitted); the extension waits at the record lock; RETENTION commits;
  // the extension re-reads after the lock and refuses RETENTION_EXPIRED (a pre-lock judgement would have admitted it: the real clock
  // is a week before the soft deadline)
  {
    const g = await published("cmd060-race-sweep-first");
    const soft = usOf(g.record.soft_us);
    const version = Number(g.record.version);
    const gate = barrier();
    const written = barrier();
    const sweeper = sweeperExpiry(g, msOf(soft) + 1_000, { written: written.open, hold: gate.wait });
    let reply: Promise<Reply> | null = null;
    try {
      const first = await Promise.race([written.wait.then(() => null), sweeper]);
      if (first !== null) assert.fail(`RETENTION settled ${first} before holding the record`);
      reply = extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 });
      await waitsOn(reply, "retention_records", "the extension");
    } finally {
      gate.open();
    }
    assert.equal(await sweeper, "EXPIRED");
    const before = await footprint(g);
    assert.equal(answer(await reply), "409 PRECONDITION_FAILED RETENTION_EXPIRED");
    assert.deepEqual(await footprint(g), before, "the expired record is not extended");
    const row = await recordOf(g.retentionId);
    assert.deepEqual([row.state, row.version, row.soft_us], ["EXPIRED", String(version + 1), String(soft)]);
    assert.equal(await extensionsOf(g.projectId), 0);
  }

  // two extensions of one project: the first holds the record, the second waits at it, one extension is granted
  {
    const g = await published("cmd060-race-two");
    const soft = usOf(g.record.soft_us);
    const version = Number(g.record.version);
    const hold = pw.w.holds.arm("journal.commit");
    const a = extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 });
    let b: Promise<Reply> | null = null;
    try {
      await reached(hold, a, "the first extension");
      b = extend(g.projectId, { expectedVersion: version, requestedSeconds: 7_200 });
      await waitsOn(b, "retention_records", "the second extension");
    } finally {
      release(hold, "journal.commit");
    }
    granted(await a);
    assert.ok(["409 PRECONDITION_FAILED EXTENSION_ALREADY_USED", "409 STALE_VERSION -"].includes(answer(await b!)), `the second answered ${answer(await b!)}`);
    const row = await recordOf(g.retentionId);
    assert.deepEqual([row.version, row.soft_us], [String(version + 1), String(soft + HOUR_US)], "only the first extension moved the deadline");
    assert.equal(await extensionsOf(g.projectId), 1);
  }
});

test("CMD060-DENY: a VIEWER or BILLING member, another agency, more than 259200 s, a stale version, an UNPAID-only project and no room before the hard cap are refused with nothing written; before the first package there is no soft deadline: NO_SOFT_DEADLINE, and a publication in flight makes the extension wait and answer STALE_VERSION", async () => {
  const { w } = pw;
  const g = await published("cmd060-deny");
  const version = Number(g.record.version);
  const before = await footprint(g);
  const refusals: ReadonlyArray<readonly [string, () => Promise<Reply>, string]> = [
    ["a VIEWER", () => extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 }, { token: w.viewer.token }), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT"],
    ["a BILLING member", () => extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 }, { token: w.billing.token }), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT"],
    ["another agency's member", () => extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 }, { token: w.stranger.token, agency: w.B.agencyId }), "404 NOT_FOUND -"],
    ["259201 s", () => extend(g.projectId, { expectedVersion: version, requestedSeconds: MAX_SECONDS + 1 }), "400 INVALID_REQUEST SCHEMA_VIOLATION"],
    ["0 s", () => extend(g.projectId, { expectedVersion: version, requestedSeconds: 0 }), "400 INVALID_REQUEST SCHEMA_VIOLATION"],
    ["a stale version", () => extend(g.projectId, { expectedVersion: version - 1, requestedSeconds: 3_600 }), "409 STALE_VERSION -"],
  ];
  for (const [what, run, expected] of refusals) {
    assert.equal(answer(await run()), expected, what);
    assert.deepEqual(await footprint(g), before, `${what}: nothing written`);
  }

  // no room: the soft deadline at the hard cap (superuser) — refused and not consumed: with room again one extension is granted
  await placeSoft(g.retentionId, "hard_deadline");
  const full = await footprint(g);
  assert.equal(answer(await extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 })), "409 PRECONDITION_FAILED NO_EXTENSION_ROOM");
  assert.deepEqual(await footprint(g), full, "no room: nothing written, the extension not consumed");
  await placeSoft(g.retentionId, "hard_deadline - interval '48 hours'");
  const roomy = await recordOf(g.retentionId);
  const x = granted(await extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 })).data;
  assert.equal(Date.parse(x.softDeadline), msOf(usOf(roomy.soft_us) + HOUR_US), "the refused request did not consume the extension");

  // an UNPAID-only project (a sealed, quoted, unpaid source): no extendable record (C1: UNPAID gets none)
  const q = await pw.readyQuote("cmd060-deny-unpaid");
  const unpaid = (await w.h.oracle.query<{ retention_id: string; version: string }>("SELECT retention_id, version::text AS version FROM kauro.retention_records WHERE revision_id = $1 AND class = 'UNPAID'", [q.revisionId])).rows[0];
  assert.ok(unpaid !== undefined, "the unpaid source has its UNPAID record");
  const unpaidBefore = JSON.stringify(await recordOf(unpaid.retention_id));
  assert.equal(answer(await extend(q.plan.projectId, { expectedVersion: Number(unpaid.version), requestedSeconds: 3_600 })), "409 PRECONDITION_FAILED NO_EXTENDABLE_RECORD");
  assert.equal(JSON.stringify(await recordOf(unpaid.retention_id)), unpaidBefore);

  // before the first package (D vs A). Extension first: the record has no soft deadline: NO_SOFT_DEADLINE, nothing written, and the
  // publication then sets its soft deadline (+ 604800 s) as always
  {
    const v = await verifyingJob(pw, "cmd060-deny-nosoft");
    const n = await governed(v.sale, v.jobId);
    const bare = await recordOf(n.retentionId);
    assert.equal(bare.soft_us, null, "no package yet, no soft deadline");
    const nBefore = await footprint(n);
    assert.equal(answer(await extend(n.projectId, { expectedVersion: Number(bare.version), requestedSeconds: 3_600 })), "409 PRECONDITION_FAILED NO_SOFT_DEADLINE");
    assert.deepEqual(await footprint(n), nBefore, "NO_SOFT_DEADLINE: nothing written");
    assert.equal((await publishJob(w.h, w.A, v.jobId)).kind, "PUBLISHED");
    const set = await recordOf(n.retentionId);
    assert.deepEqual([set.version, set.soft_us === null], [String(Number(bare.version) + 1), false], "the publication set the soft deadline after the refusal");
  }
  // publication first, in flight: its soft-deadline write holds the record; the extension waits there, then answers from the
  // committed record — the version it named is gone (STALE_VERSION), nothing written; the current version then extends
  {
    const v = await verifyingJob(pw, "cmd060-deny-publishing");
    const n = await governed(v.sale, v.jobId);
    const bare = await recordOf(n.retentionId);
    const held = heldPublication(pw, v.jobId);
    let reply: Promise<Reply> | null = null;
    try {
      await held.written;
      reply = extend(n.projectId, { expectedVersion: Number(bare.version), requestedSeconds: 3_600 });
      await waitsOn(reply, "retention_records", "the extension behind the publication");
    } finally {
      held.release();
    }
    assert.equal((await held.outcome).kind, "PUBLISHED");
    const set = await recordOf(n.retentionId);
    const nBefore = await footprint(n);
    assert.equal(answer(await reply), "409 STALE_VERSION -");
    assert.deepEqual(await footprint(n), nBefore);
    const y = granted(await extend(n.projectId, { expectedVersion: Number(set.version), requestedSeconds: 3_600 })).data;
    assert.equal(Date.parse(y.softDeadline), msOf(usOf(set.soft_us) + HOUR_US));
  }
});

test("RACE (expiry): the extension's lock wait crosses the existing soft deadline — judged at effect_now after the record lock, refused SOFT_DEADLINE_PASSED, nothing written", async () => {
  const g = await published("cmd060-expiry");
  const soft = usOf(g.record.soft_us);
  const version = Number(g.record.version);
  const before = await footprint(g);
  // the api transaction opens 1.5 s before the soft deadline on the TEST CLOCK (server_now() stays there for the transaction); the
  // record is held by a control transaction until the waiting transaction has run > 2.5 s, so effect_now() after the lock is past it
  const startMs = msOf(soft) - 1_500;
  const holder = await controlTx();
  let reply: Promise<Reply> | null = null;
  let how: "COMMIT" | "ROLLBACK" = "ROLLBACK";
  try {
    const locked = await holder.query("SELECT retention_id FROM kauro.retention_records WHERE retention_id = $1 FOR UPDATE", [g.retentionId]);
    assert.equal(locked.rowCount, 1);
    stand = isoOf(startMs);
    reply = extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 });
    const pid = await waitsOn(reply, "retention_records", "the extension");
    let ranMs = 0;
    for (let i = 0; i < 100 && ranMs <= 2_500; i++) {
      ranMs = Number((await pw.w.h.oracle.query<{ ms: string }>("SELECT floor(extract(epoch FROM clock_timestamp() - xact_start) * 1000)::text AS ms FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0]?.ms ?? 0);
      if (ranMs <= 2_500) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // the bound: the waiting transaction's effect instant is now past the soft deadline its start stood before
    assert.ok(startMs < msOf(soft) && startMs + ranMs > msOf(soft), `the lock wait crossed the soft deadline (start ${isoOf(startMs)}, ran ${ranMs} ms, deadline ${isoOf(msOf(soft))})`);
    how = "COMMIT";
  } finally {
    stand = null;
    await end(holder, how);
  }
  assert.equal(answer(await reply), "409 PRECONDITION_FAILED SOFT_DEADLINE_PASSED");
  assert.deepEqual(await footprint(g), before, "nothing written");
});

test("RACE (crash before COMMIT): a crash after the journal row and the writes leaves the record unchanged and no extension; the same key then extends once", async () => {
  const g = await published("cmd060-crash-before");
  const soft = usOf(g.record.soft_us);
  const version = Number(g.record.version);
  const before = await footprint(g);
  const key = freshKey("cmd060-crash-before");
  pw.w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  assert.equal(answer(await extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 }, { key })), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(pw.w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true, "the crash fired at the journal commit");
  assert.deepEqual(await footprint(g), before, "record, extension, event and journal rolled back");
  assert.deepEqual(await journalOf(key), [], "no journal entry survives the crash");
  const again = granted(await extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 }, { key }));
  assert.equal(again.replayed, false, "the same key executes once, afresh");
  const row = await recordOf(g.retentionId);
  assert.deepEqual([row.version, row.soft_us], [String(version + 1), String(soft + HOUR_US)]);
  assert.equal(await extensionsOf(g.projectId), 1);
});

test("RACE (crash after COMMIT): the lost answer is recovered by the key; the extension is not consumed twice", async () => {
  const g = await published("cmd060-crash-after");
  const soft = usOf(g.record.soft_us);
  const version = Number(g.record.version);
  const key = freshKey("cmd060-crash-after");
  pw.w.holds.arm("after.commit", { fail: new SimulatedCrash("after COMMIT") });
  assert.equal(answer(await extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 }, { key })), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(pw.w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true, "the answer was lost after COMMIT");
  // committed: the record extended once, its row and event, the journal entry
  const committed = await recordOf(g.retentionId);
  assert.deepEqual([committed.version, committed.soft_us, committed.effective_us], [String(version + 1), String(soft + HOUR_US), String(soft + HOUR_US)]);
  assert.equal(await extensionsOf(g.projectId), 1);
  assert.deepEqual(await journalOf(key), [{ state: "COMMITTED", response_status: 200 }]);
  const after = await footprint(g);
  // the same key recovers the committed answer and writes nothing
  const recovered = granted(await extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 }, { key }));
  assert.equal(recovered.replayed, true);
  assert.deepEqual([recovered.data.retentionVersion, Date.parse(recovered.data.softDeadline)], [version + 1, msOf(soft + HOUR_US)]);
  assert.deepEqual(await footprint(g), after, "not consumed twice");
  assert.equal((await eventsOf(g.retentionId)).filter((e) => e.event_type === "retention_record.extended.v1").length, 1);
});

test("RETRY: an identical replay answers 200 byte for byte and writes nothing; the same key with another requestedSeconds is 409 IDEMPOTENCY_CONFLICT", async () => {
  const g = await published("cmd060-retry");
  const version = Number(g.record.version);
  const key = freshKey("cmd060-retry");
  const first = await extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 }, { key });
  assert.equal(granted(first).replayed, false);
  const after = await footprint(g);
  const replay = await extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 }, { key });
  assert.equal(replay.status, 200, answer(replay));
  assert.equal(replay.text, replayTextOf(first), "the replay is the first answer byte for byte");
  assert.deepEqual(await footprint(g), after, "the replay wrote nothing");
  assert.equal(answer(await extend(g.projectId, { expectedVersion: version, requestedSeconds: 7_200 }, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await footprint(g), after, "the conflicting body wrote nothing");
});

test("REVOCATION: a membership suspended before the extension is refused 403 MEMBERSHIP_SUSPENDED; one suspended in flight makes the extension wait on the authorizer and then refuses it, the record unchanged", async () => {
  const { w } = pw;
  const g = await published("cmd060-revocation");
  const version = Number(g.record.version);
  const before = await footprint(g);

  // committed first
  const early: { person: Person; membershipId: string } = await activePerson(w, "cmd060-admin-early", "ADMIN");
  await suspendMember(w, early.membershipId);
  assert.equal(answer(await extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 }, { token: early.person.token })), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  assert.deepEqual(await footprint(g), before);

  // in flight: the owner's suspension is written and uncommitted; the admin's extension waits on the membership; it commits; refused
  const late = await activePerson(w, "cmd060-admin-late", "ADMIN");
  const changer = await ownerTx();
  let how: "COMMIT" | "ROLLBACK" = "ROLLBACK";
  let reply: Promise<Reply> | null = null;
  try {
    const moved = await changer.query<{ version: string }>("UPDATE kauro.memberships SET state = 'SUSPENDED', version = version + 1 WHERE membership_id = $1 RETURNING version::text AS version", [late.membershipId]);
    assert.equal(moved.rowCount, 1);
    await rawEvent(changer, { aggregateKind: "membership", aggregateId: late.membershipId, aggregateVersion: Number(moved.rows[0]!.version), agencyId: w.A.agencyId, eventType: "membership.suspended.v1", actorUserId: w.owner.userId, payload: { membershipId: late.membershipId, agencyId: w.A.agencyId, byMembershipId: w.A.ownerMembershipId } } as never);
    reply = extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 }, { token: late.person.token });
    await waitsOn(reply, "await_transition('kauro.memberships'", "the in-flight admin's extension");
    how = "COMMIT";
  } finally {
    await end(changer, how);
  }
  assert.equal(answer(await reply), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  assert.deepEqual({ ...(await footprint(g)) }, before, "the record unchanged, no extension");
});

test("PARTIAL: a fault at the extension's event, after the record and extension writes, rolls back soft_deadline, the extension row, the event and the journal entry; the same key then extends once", async () => {
  const g = await published("cmd060-partial");
  const soft = usOf(g.record.soft_us);
  const version = Number(g.record.version);
  const before = await footprint(g);
  const key = freshKey("cmd060-partial");
  const o = pw.w.h.oracle;
  await o.query(`CREATE OR REPLACE FUNCTION public.b16_l2_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'KAURO_FAULT RETENTION_EXTENDED_EVENT' USING ERRCODE = 'KT001'; END $$`);
  await o.query("CREATE TRIGGER b16_l2_fault BEFORE INSERT ON kauro.domain_events FOR EACH ROW WHEN (NEW.event_type = 'retention_record.extended.v1') EXECUTE FUNCTION public.b16_l2_fault()");
  let faulted: Reply;
  try {
    faulted = await extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 }, { key });
  } finally {
    await o.query("DROP TRIGGER IF EXISTS b16_l2_fault ON kauro.domain_events");
    await o.query("DROP FUNCTION IF EXISTS public.b16_l2_fault()");
  }
  assert.equal(answer(faulted), "500 INTERNAL_ERROR -");
  assert.equal((rootCause(pw.w.internalErrors.at(-1)?.error) as { readonly code?: unknown } | undefined)?.code, "KT001", "the fault fired at the event INSERT");
  assert.deepEqual(await footprint(g), before, "the record's soft and effective deadlines, the extension row, the event and the journal rolled back");
  assert.deepEqual(await journalOf(key), [], "no journal entry of the faulted attempt");
  const again = granted(await extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 }, { key }));
  assert.equal(again.replayed, false);
  const row = await recordOf(g.retentionId);
  assert.deepEqual([row.version, row.soft_us], [String(version + 1), String(soft + HOUR_US)]);
  assert.equal(await extensionsOf(g.projectId), 1);
  assert.deepEqual(await journalOf(key), [{ state: "COMMITTED", response_status: 200 }]);
});

test("consumer: the extension's event is routed once to AUTHORITY_JOURNAL as a RETENTION_EXTENDED tombstone and a replay routes nothing more", async () => {
  const g = await published("cmd060-consumer");
  const version = Number(g.record.version);
  const key = freshKey("cmd060-consumer");
  granted(await extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 }, { key }));
  const routedOf = async () =>
    (await pw.w.h.oracle.query<{ event_id: string; consumer: string }>(
      "SELECT e.event_id, o.consumer FROM kauro.domain_events e JOIN kauro.outbox_records o ON o.event_id = e.event_id WHERE e.aggregate_id = $1 AND e.event_type = 'retention_record.extended.v1' ORDER BY o.consumer",
      [g.retentionId],
    )).rows;
  const routed = await routedOf();
  assert.equal(new Set(routed.map((r) => r.event_id)).size, 1, "one retention_record.extended.v1");
  assert.deepEqual(routed.filter((r) => r.consumer === "AUTHORITY_JOURNAL").length, 1, "routed once to AUTHORITY_JOURNAL (restore-journal event, 14)");
  const named = (AUTHORITY_TOMBSTONES as unknown as Readonly<Record<string, { readonly kind: string } | undefined>>)["retention_record.extended.v1"];
  assert.equal(named?.kind, "RETENTION_EXTENDED", "AUTHORITY_TOMBSTONES names the extension's tombstone kind");
  granted(await extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 }, { key }));
  assert.deepEqual(await routedOf(), routed, "a replay publishes and routes nothing more");
});

test("DENY (forged): a request session moving soft_deadline without an extension row is refused KA085", async () => {
  const g = await published("cmd060-forged");
  const before = JSON.stringify(await recordOf(g.retentionId));
  const forged = await ownerTx();
  let code: unknown = "NONE";
  try {
    await forged.query(
      "UPDATE kauro.retention_records SET soft_deadline = soft_deadline + interval '1 hour', effective_deadline = least(soft_deadline + interval '1 hour', hard_deadline), version = version + 1 WHERE retention_id = $1",
      [g.retentionId],
    );
  } catch (e) {
    code = (e as { code?: unknown }).code;
  } finally {
    await end(forged, "ROLLBACK");
  }
  assert.equal(code, "KA085", "the request role's soft-deadline move without its extension row is refused by the database (B16_L2_RETENTION_A)");
  assert.equal(JSON.stringify(await recordOf(g.retentionId)), before, "the record unchanged");
  // nor may the control plane's publication path move a soft deadline that is already set (it is set once; the extension is not its)
  const control = await controlTx();
  let controlCode: unknown = "NONE";
  try {
    await control.query("UPDATE kauro.retention_records SET soft_deadline = soft_deadline + interval '1 hour', effective_deadline = least(soft_deadline + interval '1 hour', hard_deadline) WHERE retention_id = $1", [g.retentionId]);
  } catch (e) {
    controlCode = (e as { code?: unknown }).code;
  } finally {
    await end(control, "ROLLBACK");
  }
  assert.ok(controlCode === "KA004" || controlCode === "KA085", `the control path is refused too (${String(controlCode)})`);
  assert.equal(JSON.stringify(await recordOf(g.retentionId)), before);
});

// --- R2-125: an extension against a deletion (CMD042) of the same project, and against a record already in deletion --------------------
// The oracle is the specification: R2-125 "One valid transaction wins; a later extension cannot undo committed deletion authority", and the
// handlers' own orders. CMD042 moves every ACTIVE or EXPIRED record of the project to DELETING under the project's exclusive transition lock;
// CMD060 takes the project's shared transition lock, then the paid records, and extends only an ACTIVE one (RETENTION_EXPIRED otherwise).
// CMD042 judges no retention deadline and no extension: a deletion the agency requests is never withheld by retention.

/** CMD042 as the owner with a fresh step-up, at the project's current version. */
async function requestDeletion(projectId: string, options: { readonly key?: string } = {}): Promise<Reply> {
  const project = await pw.w.h.oracle.query<{ version: string }>("SELECT version::text AS version FROM kauro.projects WHERE project_id = $1", [projectId]);
  assert.equal(project.rows.length, 1, "the project exists");
  return call(pw.w, {
    url: `/api/v1/projects/${projectId}/deletion-requests`,
    token: pw.w.owner.token,
    agency: pw.w.A.agencyId,
    key: options.key ?? freshKey("cmd042"),
    body: { expectedVersion: Number(project.rows[0]!.version), reasonCode: "AGENCY_REQUEST", assuranceProofRef: await pw.w.stepUp(pw.w.owner) },
  });
}

/** The 200 of a deletion request (an assertion failure naming the reply otherwise). */
function deletionGranted(reply: Reply): { readonly deletionId: string; readonly state: string; readonly projectState: string } {
  assert.equal(reply.status, 200, `CMD042 answered ${answer(reply)}`);
  return reply.json<{ data: { deletionId: string; state: string; projectState: string } }>().data;
}

async function projectStateOf(projectId: string): Promise<string> {
  return (await pw.w.h.oracle.query<{ state: string }>("SELECT state FROM kauro.projects WHERE project_id = $1", [projectId])).rows[0]!.state;
}

async function recordStatesOf(projectId: string): Promise<ReadonlyArray<string>> {
  return (await pw.w.h.oracle.query<{ class: string; state: string }>("SELECT class, state FROM kauro.retention_records WHERE project_id = $1 ORDER BY class", [projectId])).rows.map((r) => `${r.class}:${r.state}`);
}

test("R2-125: an extension and a deletion of one project, both orders — the deletion first (held at its COMMIT): the extension waits at the project's transition lock and is refused RETENTION_EXPIRED, nothing written; the extension first (held at its COMMIT): the deletion waits and then completes, the record DELETING with the extended soft deadline kept; a later extension never revives access", async () => {
  // order 1: the deletion holds its writes (project DELETION_REQUESTED, records DELETING; before its journal commit); the extension, which could
  // read the project OPEN and the record ACTIVE a moment ago, waits at the project's transition lock; the deletion commits; the extension
  // re-reads the records after the lock and finds none ACTIVE
  {
    const g = await published("r2-125-deletion-first");
    const soft = usOf(g.record.soft_us);
    const version = Number(g.record.version);
    const hold = pw.w.holds.arm("journal.commit");
    const deletion = requestDeletion(g.projectId);
    let extension: Promise<Reply> | null = null;
    try {
      await reached(hold, deletion, "the deletion request");
      extension = extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 });
      await waitsOn(extension, "await_transition('kauro.projects'", "the extension");
    } finally {
      release(hold, "journal.commit");
    }
    const asked = deletionGranted(await deletion);
    assert.deepEqual([asked.state, asked.projectState], ["REQUESTED", "DELETION_REQUESTED"], "the deletion committed first");
    assert.equal(answer(await extension!), "409 PRECONDITION_FAILED RETENTION_EXPIRED", "the extension that lost the race is refused: the record is no longer ACTIVE");
    const row = await recordOf(g.retentionId);
    assert.deepEqual([row.state, row.version, row.soft_us, row.effective_us], ["DELETING", String(version + 1), String(soft), String(soft)], "the record is DELETING at the deletion's version, its soft deadline untouched");
    assert.equal(await extensionsOf(g.projectId), 0, "no extension row");
    assert.equal((await eventsOf(g.retentionId)).filter((e) => e.event_type === "retention_record.extended.v1").length, 0, "no retention_record.extended.v1");
    assert.equal(await projectStateOf(g.projectId), "DELETION_REQUESTED", "the deletion authority stands");
    // a later extension, with the record's committed version, is the same refusal: it cannot undo the committed deletion
    const before = await footprint(g);
    assert.equal(answer(await extend(g.projectId, { expectedVersion: version + 1, requestedSeconds: 3_600 })), "409 PRECONDITION_FAILED RETENTION_EXPIRED");
    assert.deepEqual(await footprint(g), before, "a later extension writes nothing");
  }

  // order 2: the extension holds its writes (record extended, extension row, event; before its journal commit); the deletion waits at the
  // project's exclusive transition behind the extension's shared one; the extension commits; the deletion then completes and takes the
  // extended record to DELETING: R2 gives a retention extension no power over the agency's own deletion
  {
    const g = await published("r2-125-extension-first");
    const soft = usOf(g.record.soft_us);
    const version = Number(g.record.version);
    const hold = pw.w.holds.arm("journal.commit");
    const extension = extend(g.projectId, { expectedVersion: version, requestedSeconds: 3_600 });
    let deletion: Promise<Reply> | null = null;
    try {
      await reached(hold, extension, "the extension");
      deletion = requestDeletion(g.projectId);
      await waitsOn(deletion, "UPDATE kauro.projects SET state", "the deletion request");
    } finally {
      release(hold, "journal.commit");
    }
    const ext = granted(await extension).data;
    assert.equal(Date.parse(ext.softDeadline), msOf(soft + HOUR_US), "the extension committed first, one hour past the soft deadline");
    const asked = deletionGranted(await deletion!);
    assert.deepEqual([asked.state, asked.projectState], ["REQUESTED", "DELETION_REQUESTED"], "the deletion waited, then committed");
    const row = await recordOf(g.retentionId);
    assert.deepEqual([row.state, row.version, row.soft_us, row.effective_us], ["DELETING", String(version + 2), String(soft + HOUR_US), String(soft + HOUR_US)], "the record is DELETING two versions on, the extended soft deadline kept (not reverted)");
    assert.equal(await extensionsOf(g.projectId), 1, "the extension stays recorded");
    assert.deepEqual((await eventsOf(g.retentionId)).map((e) => e.event_type).slice(-2), ["retention_record.extended.v1", "retention_record.deleting.v1"], "the extension, then the deletion");
    assert.deepEqual(await recordStatesOf(g.projectId), ["PAID_ORDINARY:DELETING", "UNPAID:DELETING"], "every record of the project is DELETING");
    assert.equal(await projectStateOf(g.projectId), "DELETION_REQUESTED");
    // the one extension is spent and the record is in deletion: a second one is refused for the record, nothing written
    const before = await footprint(g);
    assert.equal(answer(await extend(g.projectId, { expectedVersion: version + 2, requestedSeconds: 3_600 })), "409 PRECONDITION_FAILED RETENTION_EXPIRED");
    assert.deepEqual(await footprint(g), before, "nothing written");
  }
});

test("CMD060-DENY (deletion): an extension against a record already DELETING, DELETED_WITH_RESIDUALS or DELETED is refused RETENTION_EXPIRED with nothing written, and the request role cannot write the extension row of a record in deletion", async () => {
  const g = await published("cmd060-deny-deletion");
  const soft = usOf(g.record.soft_us);
  const version = Number(g.record.version);
  deletionGranted(await requestDeletion(g.projectId));
  const states: Array<"DELETING" | "DELETED_WITH_RESIDUALS" | "DELETED"> = ["DELETING", "DELETED_WITH_RESIDUALS", "DELETED"];
  let at = version + 1;
  for (const state of states) {
    if (state !== "DELETING") {
      // the executor's close (apps/control b16-deletion-executor.test.ts runs the real one): the superuser places the state with triggers off
      const c = pw.w.h.oracle;
      try {
        await c.query("SET session_replication_role = replica");
        const r = await c.query("UPDATE kauro.retention_records SET state = $2, version = version + 1 WHERE project_id = $1 AND state IN ('DELETING', 'DELETED_WITH_RESIDUALS')", [g.projectId, state]);
        assert.equal(r.rowCount, 2, "both records of the project close");
      } finally {
        await c.query("RESET session_replication_role");
      }
      at += 1;
    }
    const row = await recordOf(g.retentionId);
    assert.deepEqual([row.state, row.version, row.soft_us], [state, String(at), String(soft)], `the record is ${state} at version ${at}`);
    const before = await footprint(g);
    assert.equal(answer(await extend(g.projectId, { expectedVersion: at, requestedSeconds: 3_600 })), "409 PRECONDITION_FAILED RETENTION_EXPIRED", `an extension against a ${state} record`);
    assert.deepEqual(await footprint(g), before, `against ${state}: no extension row, no event, no clock change`);
    assert.equal(await extensionsOf(g.projectId), 0);
  }
  // below the handler: the database refuses the request role's extension row for a record that is not ACTIVE (RLS), whatever the route says
  const forged = await ownerTx();
  let code: unknown = "NONE";
  try {
    await forged.query(
      `INSERT INTO kauro.retention_extensions (extension_id, agency_id, project_id, retention_id, requested_seconds, granted_seconds, previous_soft_deadline, soft_deadline, hard_deadline, capped_at_hard_deadline, purpose, terms_version, requested_by_membership_id, requested_by_user_id, created_at)
       SELECT $1, r.agency_id, r.project_id, r.retention_id, 3600, 3600, r.soft_deadline, r.soft_deadline + interval '3600 seconds', r.hard_deadline, false, 'CLIENT_REVIEW', $2, m.membership_id, m.user_id, kauro.server_now()
         FROM kauro.retention_records r, kauro.memberships m
        WHERE r.retention_id = $3 AND m.agency_id = r.agency_id AND m.user_id = $4`,
      [ids.next(), termsVersion, g.retentionId, pw.w.owner.userId],
    );
  } catch (e) {
    code = (e as { code?: unknown }).code;
  } finally {
    await end(forged, "ROLLBACK");
  }
  assert.equal(code, "42501", "the extension row of a record that is not ACTIVE violates the row-level policy of the request role");
  assert.equal(await extensionsOf(g.projectId), 0);
  assert.equal((await recordOf(g.retentionId)).soft_us, String(soft), "the soft deadline never moved");
});
