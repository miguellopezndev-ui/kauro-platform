// B16 lane L6, the restore runner (R2 14 "External-effect recovery journal", 09 "Deletion receipts and restoration", CMD057; plan
// B16-REST-PLAN §6, conflicts C2 and C6). Written before the product (tests first). The world is one real PostgreSQL 17 cluster
// (@kauro/persistence/testing) holding three kinds of database:
//   - the PRIMARY ("kauro"): the platform as it runs, its control plane assembled by this package's composition root;
//   - the JOURNAL ("kauro_journal"): the authority journal outside the restore boundary, its own database and its own writer role
//     (kauro_journal_writer_test), provisioned by its owner through @kauro/persistence provisionAuthorityJournal;
//   - each RESTORED database: a backup of the primary taken with pg_dump at a named instant and restored with pg_restore into a fresh,
//     isolated database (S2's local adapter; the provider's snapshot restore and its measured RPO/RTO are BLOCKED_OWNER D-14: PART),
//     the runtime roles' units of work and the migration owner's one connection opened on it.
// The facts after the backup are the platform's own writes (CMD006's and CMD060's effects as their handlers perform them, the control
// plane's sweeps and consumers) journaled by the journal's own writers (the AUTHORITY_JOURNAL consumer, the recovery journal tail, the
// NOTIFICATIONS consumer); where a writer belongs to another lane (a project's deletion: L3; a provider capture event: B09's webhook) the
// journal entry is written through the journal's own port and said so. SIMULATED: the worker host, the cores, the object storage and
// the notification sender are the labelled contract fakes; the provider payment observation never answers (PART). The superuser
// connection is the oracle only (and the backup's pg_dump).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import type { AuditUnits, AuthorityTombstone, NotificationSenderPort, PaymentObservationPort } from "@kauro/application";
import {
  authorityTombstoneHashOf,
  effectNowOf,
  revokeMembership,
  withProvenance,
  type AgencyId,
  type CausationId,
  type CorrelationId,
  type MembershipId,
  type RecoveryId,
  type RestoreCandidateId,
  type RetentionExtensionId,
  type RetentionId,
  type UserId,
} from "@kauro/domain";
import { PgAuthorityJournal, PgOutboxDispatchStore, createPool, operationsOf, provisionAuthorityJournal, type KauroPool } from "@kauro/persistence";
import { ROLES, raceStatementTimeoutMs, testDatabaseEnvironment, waitForLockWait, type AgencyFixture } from "@kauro/persistence/testing";
import { AuthorityJournal, NotificationJournal, RecoveryJournalTail, RestoreRunner, notificationIdentityOf, type ControlPlane, type RestorePlan, type RestoredDatabase } from "../src/index.js";
import { admitted, clock, ids, launched, observedDone, startExecutionWorld, TestClockExecutionUnits, type ExecutionWorld, type Purchase } from "./support/execution-world.js";

// --- the world ---------------------------------------------------------------------------------------------------------------------

/** A pg connection of the oracle's own Client class (it opens the owner's and the claimants' connections). */
type SqlClient = ExecutionWorld["h"]["oracle"];

const JOURNAL_DB = "kauro_journal";
const JOURNAL_WRITER = "kauro_journal_writer_test";
const CLAIM_APPLICATION = "kauro-test-restore-claim";
const OWNER_APPLICATION = "kauro-test-restore-owner";

let w: ExecutionWorld;
let scratch: string;
let journalClient: SqlClient;
let journal: PgAuthorityJournal<AuthorityTombstone>;
let tail: RecoveryJournalTail;
let authorityJournal: AuthorityJournal;
let operator: UserId;
const sent: Array<{ readonly identity: string; readonly eventId: string }> = [];
/** The notification provider (PART B15): records each dispatch by its identity. */
const sender: NotificationSenderPort = {
  evidenceClass: "SIMULATED",
  async send(n) {
    sent.push({ identity: n.identity, eventId: n.eventId });
  },
};
/** The provider's payment answer (PART D-14): it never answers. */
const silentProvider: PaymentObservationPort = {
  evidenceClass: "SIMULATED",
  async observe() {
    return { kind: "TIMEOUT" };
  },
};
let notifications: NotificationJournal;

function pgbin(name: string): string {
  const dir = process.env["PGBIN"] && existsSync(process.env["PGBIN"]) ? process.env["PGBIN"] : process.platform === "win32" ? "C:\\Tools\\pgsql17\\bin" : "/usr/lib/postgresql/17/bin";
  return join(dir, process.platform === "win32" ? `${name}.exe` : name);
}

function clientClass(): new (config: object) => SqlClient {
  return w.h.oracle.constructor as unknown as new (config: object) => SqlClient;
}

async function connectAs(role: "kauro_owner" | "kauro_control_test", database: string, applicationName: string): Promise<SqlClient> {
  const Client = clientClass();
  const c = new Client({ ...w.h.pg.clientConfig(role), database, application_name: applicationName });
  // a restored database is dropped WITH (FORCE) at the end of its test: a connection still open then ends without an unhandled event
  c.on("error", () => undefined);
  await c.connect();
  return c;
}

before(async () => {
  w = await startExecutionWorld("b16-restore");
  scratch = mkdtempSync(join(tmpdir(), "kauro-b16-restore-"));
  // the journal database: its own owner-created schema and its own writer role
  await w.h.oracle.query(`CREATE ROLE ${JOURNAL_WRITER} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB`);
  await w.h.oracle.query(`CREATE DATABASE ${JOURNAL_DB} OWNER ${ROLES.owner}`);
  const owner = await connectAs("kauro_owner", JOURNAL_DB, "kauro-test-journal-owner");
  try {
    await provisionAuthorityJournal(owner, JOURNAL_WRITER);
  } finally {
    await owner.end();
  }
  const Client = clientClass();
  journalClient = new Client({ ...w.h.pg.clientConfig("kauro_control_test"), user: JOURNAL_WRITER, database: JOURNAL_DB, application_name: "kauro-test-journal" });
  await journalClient.connect();
  journal = new PgAuthorityJournal<AuthorityTombstone>(journalClient);
  tail = new RecoveryJournalTail({ journal, ids });
  authorityJournal = new AuthorityJournal({ journal });
  notifications = new NotificationJournal({ journal, sender });
  operator = await w.h.person("b16-restore-operator");
  await w.h.grantKauroOwner(operator);
});

// every test ends with no job holding an execution slot (the next test's purchase is admitted)
afterEach(async () => {
  await w.quiesce();
});

after(async () => {
  await journalClient?.end().catch(() => undefined);
  await w?.stop();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

// --- backup, restore and the journal's writers ---------------------------------------------------------------------------------------

let seq = 0;

/** A backup of the primary at this instant (pg_dump, custom format). */
function backup(label: string): string {
  const file = join(scratch, `${label}-${++seq}.dump`);
  const r = spawnSync(pgbin("pg_dump"), ["-h", "127.0.0.1", "-p", String(w.h.pg.port), "-U", ROLES.superuser, "-d", ROLES.database, "-Fc", "-f", file], { encoding: "utf8", windowsHide: true, timeout: 300_000 });
  assert.equal(r.status, 0, `pg_dump: ${r.stderr}`);
  return file;
}

interface Restored extends RestoredDatabase {
  readonly name: string;
  readonly owner: SqlClient;
  readonly units: TestClockExecutionUnits;
  readonly plane: ControlPlane;
  /** The migration owner's connection again, as a restarted runner opens it (the previous one ended). */
  reconnectOwner(): Promise<Restored>;
  stop(): Promise<void>;
}

/** S2's local adapter: the backup restored into a fresh, isolated database, its runtime pools and its owner's connection. */
async function restore(file: string, label: string): Promise<Restored> {
  const name = `kauro_rs_${label.replace(/[^a-z0-9]/g, "_")}_${++seq}`;
  await w.h.oracle.query(`CREATE DATABASE ${name} OWNER ${ROLES.owner}`);
  // a database's own ACL is not in a pg_dump archive: the restored database loses PUBLIC's TEMPORARY and CREATE as 0060 does
  await w.h.oracle.query(`REVOKE TEMPORARY, CREATE ON DATABASE ${name} FROM PUBLIC`);
  const r = spawnSync(pgbin("pg_restore"), ["-h", "127.0.0.1", "-p", String(w.h.pg.port), "-U", ROLES.superuser, "-d", name, "--exit-on-error", file], { encoding: "utf8", windowsHide: true, timeout: 300_000 });
  assert.equal(r.status, 0, `pg_restore: ${r.stderr}`);
  const base = { environment: testDatabaseEnvironment("LOCAL"), host: "127.0.0.1", port: w.h.pg.port, database: name, max: 3 } as const;
  const pools: KauroPool[] = [
    createPool({ ...base, user: ROLES.appLogin, applicationName: `kauro-test-restored-api` }),
    createPool({ ...base, user: ROLES.paymentLogin, applicationName: `kauro-test-restored-payment` }),
    createPool({ ...base, user: ROLES.controlLogin, applicationName: `kauro-test-restored-control` }),
  ];
  const units = new TestClockExecutionUnits({ app: pools[0]!, payment: pools[1]!, control: pools[2]! }, { clock, defaultStatementTimeoutMs: raceStatementTimeoutMs() });
  units.offsetSeconds = w.units.offsetSeconds;
  const make = async (owner: SqlClient): Promise<Restored> => ({
    name,
    owner,
    units,
    plane: w.planeWith({ units }),
    reconnectOwner: async () => make(await connectAs("kauro_owner", name, OWNER_APPLICATION)),
    async stop() {
      await owner.end().catch(() => undefined);
      for (const p of pools) await p.end().catch(() => undefined);
      await w.h.oracle.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  });
  return make(await connectAs("kauro_owner", name, OWNER_APPLICATION));
}

/** The journal's writers catch up: the AUTHORITY_JOURNAL consumer's tombstones and the tail's revocations, extensions and payments. */
async function journalNow(): Promise<void> {
  await w.drain(authorityJournal);
  await tail.sweep(w.units);
}

function runnerFor(r: Restored, options: { readonly observationSeconds?: number } = {}): RestoreRunner {
  return new RestoreRunner({
    journal,
    primary: w.units,
    ids,
    observations: silentProvider,
    ...(options.observationSeconds === undefined ? {} : { observationSeconds: options.observationSeconds }),
    cleanup: (units: AuditUnits) => r.plane.sweepers.retention.sweep(units as never, 200),
  });
}

/** The corporate owner's CMD057 authorization of the candidate, written by its own adapter (the route is covered by cmd056-cmd057). */
async function authorize(candidateId: string, deletionJournalHash: string): Promise<string> {
  return w.h.commerce.run(w.h.operator(operator), async (uow) => {
    const ops = operationsOf(uow);
    const candidate = await ops.lockCandidate(candidateId as RestoreCandidateId);
    assert.ok(candidate !== null && candidate.deletionJournalHash === deletionJournalHash, "the owner authorizes the candidate's own journal hash");
    const recoveryId = ids.next() as RecoveryId;
    const done = await ops.authorizeRecovery({ recoveryId, candidate, authorizationRef: ids.next(), by: operator });
    assert.equal(done.kind, "APPLIED");
    return recoveryId;
  });
}

async function gateOf(r: Restored): Promise<{ readonly state: string; readonly run_id: string | null }> {
  return (await oracleOf<{ state: string; run_id: string | null }>(r, "SELECT state, run_id::text FROM kauro.recovery_gate"))[0]!;
}

/** The restored database as the superuser reads it (assertions only). */
async function oracleOf<R>(r: Restored, text: string, values: unknown[] = []): Promise<R[]> {
  const Client = clientClass();
  const c = new Client({ ...w.h.pg.clientConfig("postgres"), database: r.name, application_name: "kauro-test-restore-oracle" });
  await c.connect();
  try {
    return (await c.query(text, values)).rows as R[];
  } finally {
    await c.end();
  }
}

/** A dispatcher claim on the restored database, on its own control connection inside an open transaction (the caller ends it). */
async function claimant(r: Restored): Promise<SqlClient> {
  const c = await connectAs("kauro_control_test", r.name, CLAIM_APPLICATION);
  await c.query("BEGIN");
  return c;
}

const claimOn = (c: SqlClient, consumer: string) => new PgOutboxDispatchStore(c as never).claim(consumer, 50, clock.now(), 60);
const sqlstateOf = (e: unknown): string | undefined => (e as { code?: string }).code;
/** A claim refused at the closed gate: KA091 raw, or the dispatcher's mapped refusal naming it. */
const atGate = (e: unknown): boolean => sqlstateOf(e) === "KA091" || /\(KA091\)/.test(String((e as Error).message));

// --- the platform's own writes after a backup ---------------------------------------------------------------------------------------

/** CMD006's effect as its handler performs it: the owner revokes an ACTIVE membership (membership.revoked.v1). */
async function revokeLive(ag: AgencyFixture, membershipId: MembershipId): Promise<void> {
  await w.h.app.run(w.h.tenant(ag.agencyId, ag.ownerUserId), async (uow) => {
    const target = await uow.memberships.lock(membershipId);
    const actor = await uow.memberships.get(ag.ownerMembershipId);
    const agency = await uow.agencies.lock(ag.agencyId);
    assert.ok(target !== null && actor !== null && agency !== null);
    const now = await effectNowOf(uow);
    const outcome = revokeMembership({ membership: target, actor, agency, expectedVersion: target.version, reasonCode: "OFFBOARDED", now, activeOwnerCount: await uow.memberships.countActiveOwners(ag.agencyId) });
    const moved = await uow.memberships.transition(target.membershipId, target.version, { state: "REVOKED", revokedAt: now }, now);
    assert.equal(moved.kind, "APPLIED");
    await uow.events.publish(withProvenance(outcome.event, { actor: { kind: "USER", userId: ag.ownerUserId }, causationId: ids.next() as CausationId, correlationId: ids.next() as CorrelationId }));
  });
}

/** CMD060's effect as its handler performs it: the project's one extension of its soft deadline (retention_record.extended.v1). */
async function extendLive(ag: AgencyFixture, p: Purchase, requestedSeconds: number): Promise<{ readonly extensionId: string; readonly retentionId: string }> {
  const terms = (await w.h.oracle.query<{ terms_version: string }>("SELECT terms_version FROM kauro.agencies WHERE agency_id = $1", [ag.agencyId])).rows[0]!.terms_version;
  return w.units.runSource(w.h.tenant(ag.agencyId, ag.ownerUserId), async (uow) => {
    const retention = uow.sources.retention;
    const record = (await retention.lockPaidRecordsOfProject(p.projectId)).find((r) => r.state === "ACTIVE");
    assert.ok(record !== undefined, "an ACTIVE paid record governs the project");
    const extensionId = uow.ids.next() as RetentionExtensionId;
    const { extension, record: moved } = await retention.extendSoftDeadline({ extensionId, retentionId: record.retentionId as RetentionId, expectedVersion: record.version, requestedSeconds, purpose: "CLIENT_REVIEW", termsVersion: terms, membershipId: ag.ownerMembershipId });
    await uow.events.publish({
      aggregateKind: "retention_record",
      aggregateId: moved.retentionId,
      aggregateVersion: moved.version,
      agencyId: moved.agencyId,
      eventType: "retention_record.extended.v1",
      actor: { kind: "USER", userId: ag.ownerUserId },
      causationId: ids.next() as CausationId,
      correlationId: ids.next() as CorrelationId,
      payload: {
        retentionId: moved.retentionId,
        agencyId: moved.agencyId,
        projectId: moved.projectId,
        ...(moved.revisionId === undefined ? {} : { revisionId: moved.revisionId }),
        extensionId,
        retentionClass: moved.class,
        requestedSeconds: extension.requestedSeconds,
        grantedSeconds: extension.grantedSeconds,
        cappedAtHardDeadline: extension.cappedAtHardDeadline,
      },
    });
    return { extensionId, retentionId: record.retentionId };
  });
}

/** A paid purchase executed and published (the first package sets the soft deadline: + 604,800 s). */
async function published(ag: AgencyFixture, label: string): Promise<Purchase> {
  const p = await w.paid(ag, label);
  const { jobId, identity } = await admitted(w, p);
  await launched(w, jobId);
  await observedDone(w, identity);
  await w.drain(w.x.consumers.jobExecution);
  assert.equal((await w.job(jobId)).state, "READY", `${label}: published`);
  return p;
}

interface RecordRow {
  readonly retention_id: string;
  readonly state: string;
  readonly soft_deadline: Date | null;
  readonly effective_deadline: Date;
}
const recordSql = "SELECT retention_id, state, soft_deadline, effective_deadline FROM kauro.retention_records WHERE revision_id = $1 AND class = 'PAID_ORDINARY'";

async function prepared(r: Restored): Promise<{ readonly runner: RestoreRunner; readonly candidateId: string; readonly plan: RestorePlan; readonly hash: string }> {
  const runner = runnerFor(r);
  const c = await runner.prepare(`local:${r.name}`);
  return { runner, candidateId: c.candidateId, plan: c.plan, hash: c.deletionJournalHash };
}

// --- the cells ------------------------------------------------------------------------------------------------------------------------

test("CMD057-OK (run): the authorized candidate is restored, reconciled and released only after the checks", { timeout: 600_000 }, async () => {
  const A = await w.agency("rs-ok");
  await published(A, "rs-ok");
  await journalNow();
  const file = backup("ok");
  const r = await restore(file, "ok");
  try {
    const { runner, candidateId, plan, hash } = await prepared(r);
    assert.equal(plan.journalThrough, await journal.head(), "S1 names the journal through its head");
    // without the owner's authorization every step runs, the checks pass, and the gate stays closed
    const waiting = await runner.run(candidateId, plan, r);
    assert.equal(waiting.kind, "AWAITING_AUTHORIZATION");
    assert.equal(waiting.run.state, "CHECKED");
    assert.deepEqual([(await gateOf(r)).state, (await gateOf(r)).run_id], ["CLOSED", waiting.run.runId]);
    const [row] = await oracleOf<{ checks_hash: string | null; applied_through: string; journal_through: string }>(r, "SELECT checks_hash, applied_through::text, journal_through::text FROM kauro.restore_runs WHERE candidate_id = $1", [candidateId]);
    assert.ok(row !== undefined && row.checks_hash !== null && row.applied_through === row.journal_through, "the journal applied whole and the checks recorded");
    assert.equal((await oracleOf<{ n: string }>(r, "SELECT count(*)::text AS n FROM kauro.leases WHERE expires_at > kauro.server_now()"))[0]!.n, "0", "S5: no restored lease is live");
    // the gate refuses the database's own opening for a run that is not RELEASED
    await assert.rejects(r.owner.query("UPDATE kauro.recovery_gate SET state = 'OPEN', revision = revision + 1 WHERE gate_id"), (e: unknown) => sqlstateOf(e) === "KA092");
    // the owner authorizes this candidate (CMD057): the run is released and the gate opens in one transaction
    const recoveryId = await authorize(candidateId, hash);
    const released = await runner.run(candidateId, plan, r);
    assert.equal(released.kind, "RELEASED");
    assert.equal((await gateOf(r)).state, "OPEN");
    const [done] = await oracleOf<{ state: string; recovery_id: string; released_at: Date | null }>(r, "SELECT state, recovery_id, released_at FROM kauro.restore_runs WHERE candidate_id = $1", [candidateId]);
    assert.deepEqual([done?.state, done?.recovery_id, done?.released_at !== null], ["RELEASED", recoveryId, true]);
    // a second run of the same candidate is the released one, nothing twice
    assert.equal((await runner.run(candidateId, plan, r)).kind, "RELEASED");
    // the tail now follows the restored database from its own horizon
    assert.ok((await journal.cursor("platform-events")) !== null);
  } finally {
    await r.stop();
  }
});

test("GAP-RS-1 RACE: a dispatcher claim held at the gate FOR SHARE against S8's UPDATE, both orders: no claim before the gate opens", { timeout: 600_000 }, async () => {
  const A = await w.agency("rs-race");
  await published(A, "rs-race");
  await journalNow();
  const file = backup("race");
  // a consumer with records to claim on every restored database: the published purchase's NOTIFICATIONS records
  const consumer = "NOTIFICATIONS";

  // order 1: S8's UPDATE holds the gate (uncommitted); the claim's FOR SHARE waits for it, then claims under the OPEN gate
  const r1 = await restore(file, "race-one");
  try {
    const { runner, candidateId, plan, hash } = await prepared(r1);
    assert.equal((await runner.run(candidateId, plan, r1)).kind, "AWAITING_AUTHORIZATION");
    // before S8 a claim is refused at the gate (KA091) and claims nothing
    const early = await claimant(r1);
    await assert.rejects(claimOn(early, consumer), atGate);
    await early.query("ROLLBACK");
    await early.end();
    await authorize(candidateId, hash);
    let signal: () => void = () => undefined;
    let releaseHold: () => void = () => undefined;
    const reached = new Promise<void>((res) => (signal = res));
    const held = new Promise<void>((res) => (releaseHold = res));
    const releasing = runner.run(candidateId, plan, r1, { releaseHold: async () => (signal(), held) });
    releasing.catch(() => undefined);
    await reached;
    const c = await claimant(r1);
    let claimedAt = 0;
    let committedAt = 0;
    const claim = claimOn(c, consumer).then((rows) => ((claimedAt = Date.now()), rows));
    await waitForLockWait(w.h.oracle, CLAIM_APPLICATION, "outbox_records");
    committedAt = Date.now();
    releaseHold();
    assert.equal((await releasing).kind, "RELEASED");
    const rows = await claim;
    assert.ok(rows.length > 0, "the claim proceeds once the gate is OPEN");
    assert.ok(claimedAt >= committedAt, "the claim completed only after S8 committed");
    await c.query("ROLLBACK");
    await c.end();
  } finally {
    await r1.stop();
  }

  // order 2: the claim first. A claim whose trigger reads the CLOSED gate FOR SHARE is refused at once, and PostgreSQL aborts its
  // transaction there (its share lock ends with the error): S8 never waits for it and it never claims. A claim whose snapshot was
  // taken before S8 committed (REPEATABLE READ) cannot claim on that view either: its FOR SHARE meets the gate row S8 updated after
  // its snapshot and is refused (40001). Only a claim that reads the OPEN gate S8 committed proceeds.
  const r2 = await restore(file, "race-two");
  try {
    const { runner, candidateId, plan, hash } = await prepared(r2);
    assert.equal((await runner.run(candidateId, plan, r2)).kind, "AWAITING_AUTHORIZATION");
    await authorize(candidateId, hash);
    const refused = await claimant(r2);
    await assert.rejects(claimOn(refused, consumer), atGate);
    const stale = await connectAs("kauro_control_test", r2.name, CLAIM_APPLICATION);
    await stale.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    assert.equal((await stale.query<{ state: string }>("SELECT state FROM kauro.recovery_gate")).rows[0]?.state, "CLOSED", "the stale claim's snapshot sees the gate closed");
    // S8 completes while the refused claim's transaction is still open (it holds nothing)
    assert.equal((await runner.run(candidateId, plan, r2)).kind, "RELEASED");
    assert.equal((await gateOf(r2)).state, "OPEN");
    await assert.rejects(claimOn(stale, consumer), (e: unknown) => sqlstateOf(e) === "40001" || /40001/.test(String((e as Error).message)) || sqlstateOf((e as { cause?: unknown }).cause) === "40001");
    await stale.query("ROLLBACK");
    await stale.end();
    await refused.query("ROLLBACK");
    await refused.end();
    const c = await claimant(r2);
    assert.ok((await claimOn(c, consumer)).length > 0, "after the gate opens the claim succeeds");
    await c.query("ROLLBACK");
    await c.end();
  } finally {
    await r2.stop();
  }
});

test("GAP-RS-2 TIMEOUT: a provider observation timeout keeps the gate closed", { timeout: 600_000 }, async () => {
  const A = await w.agency("rs-timeout");
  await published(A, "rs-timeout");
  await journalNow();
  const file = backup("timeout");
  // after the backup the provider completes a capture the platform records (capture.completed.v1); the tail journals its state
  const late = await w.paid(A, "rs-timeout-late");
  await journalNow();
  assert.ok((await journal.entries(0, await journal.head())).some((e) => e.entryId === `capture:${late.captureId}:COMPLETED`), "the late capture is journaled");
  const r = await restore(file, "timeout");
  try {
    const runner = runnerFor(r, { observationSeconds: 600 });
    const c = await runner.prepare(`local:${r.name}`);
    await authorize(c.candidateId, c.deletionJournalHash);
    const paused = await runner.run(c.candidateId, c.plan, r);
    assert.equal(paused.kind, "PAUSED");
    assert.ok(paused.kind === "PAUSED" && paused.observations.length === 1 && paused.observations[0]!.subjectId === late.captureId && paused.observations[0]!.mismatch === "CAPTURE_MISSING");
    assert.equal(paused.kind === "PAUSED" ? paused.observations[0]!.state : "", "OPEN", "the provider never answered; the deadline is not reached");
    assert.equal((await gateOf(r)).state, "CLOSED");
    // the database refuses a timeout before the deadline on its own clock
    await assert.rejects(r.owner.query("UPDATE kauro.restore_observations SET state = 'TIMED_OUT' WHERE state = 'OPEN'"), (e: unknown) => sqlstateOf(e) === "KA092");
    // the deadline passes on the database clock: the observation closes TIMED_OUT, and the run stays PAUSED, the gate closed
    await r.owner.query("SELECT set_config('kauro_test.clock_offset_seconds', $1, false)", [String(w.units.offsetSeconds + 601)]);
    const again = await runner.run(c.candidateId, c.plan, r);
    assert.equal(again.kind, "PAUSED");
    assert.equal(again.kind === "PAUSED" ? again.observations[0]!.state : "", "TIMED_OUT");
    assert.equal((await gateOf(r)).state, "CLOSED", "a timed-out observation never opens the gate");
    await assert.rejects(r.owner.query("UPDATE kauro.restore_runs SET state = 'RECONCILED', revision = revision + 1"), (e: unknown) => sqlstateOf(e) === "KA092" || sqlstateOf(e) === "KA008");
    const claim = await claimant(r);
    await assert.rejects(claimOn(claim, "NOTIFICATIONS"), atGate);
    await claim.query("ROLLBACK");
    await claim.end();
  } finally {
    await r.stop();
  }
});

test("GAP-RS-3 CRASH: a crash after S4 before S8; the rerun is idempotent (journal sequence) and the gate stays closed", { timeout: 600_000 }, async () => {
  const A = await w.agency("rs-crash");
  const m1 = await w.h.addMember(A, await w.h.person("rs-crash-m1"), "VIEWER");
  const m2 = await w.h.addMember(A, await w.h.person("rs-crash-m2"), "VIEWER");
  const file = backup("crash");
  await revokeLive(A, m1);
  await revokeLive(A, m2);
  await journalNow();
  let r = await restore(file, "crash");
  try {
    let crashes = 1;
    const base = runnerFor(r);
    const c = await base.prepare(`local:${r.name}`);
    const crashing = new RestoreRunner({
      journal,
      primary: w.units,
      ids,
      cleanup: async () => {
        if (crashes-- > 0) throw new Error("the runner process died after S4");
      },
    });
    const crashed = await crashing.run(c.candidateId, c.plan, r).then((o) => o, (e: unknown) => e);
    assert.ok(crashed instanceof Error && /died after S4/.test(crashed.message), `the run died after S4: ${JSON.stringify(crashed)}`);
    const [mid] = await oracleOf<{ state: string; applied_through: string; journal_through: string }>(r, "SELECT state, applied_through::text, journal_through::text FROM kauro.restore_runs WHERE candidate_id = $1", [c.candidateId]);
    assert.deepEqual([mid?.state, mid?.applied_through], ["APPLYING", mid?.journal_through], "S4 applied every entry; the run did not reach S5");
    assert.equal((await gateOf(r)).state, "CLOSED");
    const claim = await claimant(r);
    await assert.rejects(claimOn(claim, "NOTIFICATIONS"), atGate);
    await claim.query("ROLLBACK");
    await claim.end();
    // the process restarts with a fresh owner connection: nothing is applied twice (the journal sequence it recorded), the gate stays
    // closed until the authorization, then the run is released
    await r.owner.end();
    r = await r.reconnectOwner();
    const rerun = await crashing.run(c.candidateId, c.plan, r);
    assert.equal(rerun.kind, "AWAITING_AUTHORIZATION");
    assert.equal((await gateOf(r)).state, "CLOSED");
    const replayed = await oracleOf<{ aggregate_id: string }>(r, "SELECT aggregate_id::text FROM kauro.domain_events WHERE event_type = 'membership.revoked.v1' AND aggregate_id = ANY($1::uuid[])", [[m1, m2]]);
    assert.equal(replayed.length, 2, "each revocation replayed once");
    const applied = await oracleOf<{ n: string; d: string }>(r, "SELECT count(*)::text AS n, count(DISTINCT journal_seq)::text AS d FROM kauro.restore_applied_entries");
    assert.equal(applied[0]!.n, applied[0]!.d);
    await authorize(c.candidateId, c.deletionJournalHash);
    assert.equal((await crashing.run(c.candidateId, c.plan, r)).kind, "RELEASED");
  } finally {
    await r.stop();
  }
});

test("GAP-RS-4 PARTIAL: S4 fails at entry k; the gate stays closed, k is recorded, the run resumes from k", { timeout: 600_000 }, async () => {
  const A = await w.agency("rs-partial");
  const members = [await w.h.addMember(A, await w.h.person("rs-partial-1"), "VIEWER"), await w.h.addMember(A, await w.h.person("rs-partial-2"), "VIEWER"), await w.h.addMember(A, await w.h.person("rs-partial-3"), "VIEWER")];
  const file = backup("partial");
  for (const m of members) await revokeLive(A, m);
  await journalNow();
  const r = await restore(file, "partial");
  try {
    const runner = runnerFor(r);
    const c = await runner.prepare(`local:${r.name}`);
    const entries = await journal.entries(0, c.plan.journalThrough);
    const k = entries.find((e) => e.kind === "REVOCATION" && e.body["membershipId"] === members[1])!.journalSeq;
    // the restored database's request role drops its connection while entry k is applied (the replay of the second revocation)
    let failing = true;
    const faulty: AuditUnits = new Proxy(r.units, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop !== "run" || typeof value !== "function") return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        return (context: { kind: string }, work: (uow: { memberships: { lock(id: string): Promise<unknown> } }) => Promise<unknown>, options?: unknown) =>
          (value as (...a: unknown[]) => Promise<unknown>).call(
            target,
            context,
            async (uow: { memberships: { lock(id: string): Promise<unknown> } }) => {
              const lock = uow.memberships.lock.bind(uow.memberships);
              uow.memberships.lock = async (id: string) => {
                if (failing && id === members[1]) {
                  failing = false;
                  throw Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
                }
                return lock(id);
              };
              return work(uow);
            },
            options,
          );
      },
    }) as AuditUnits;
    const failed = await runner.run(c.candidateId, c.plan, { owner: r.owner, units: faulty });
    assert.equal(failed.kind, "FAILED_AT");
    assert.ok(failed.kind === "FAILED_AT" && failed.entry === k && failed.code === "SQLSTATE_57P01", `k = ${k}: ${JSON.stringify(failed)}`);
    const [row] = await oracleOf<{ state: string; applied_through: string; failed_at_entry: string; failure_code: string }>(r, "SELECT state, applied_through::text, failed_at_entry::text, failure_code FROM kauro.restore_runs WHERE candidate_id = $1", [c.candidateId]);
    assert.deepEqual([row?.state, row?.applied_through, row?.failed_at_entry, row?.failure_code], ["APPLYING", String(k - 1), String(k), "SQLSTATE_57P01"]);
    assert.equal((await gateOf(r)).state, "CLOSED");
    const states = async () => (await oracleOf<{ membership_id: string; state: string }>(r, "SELECT membership_id::text, state FROM kauro.memberships WHERE membership_id = ANY($1::uuid[]) ORDER BY membership_id", [members])).map((x) => x.state);
    assert.deepEqual((await states()).sort(), ["ACTIVE", "ACTIVE", "REVOKED"], "entries before k applied, k and after not");
    // the database refuses an applied row out of order (k + 1 before k)
    await assert.rejects(
      r.owner.query("INSERT INTO kauro.restore_applied_entries (run_id, journal_seq, entry_id, kind, outcome, recorded_at) SELECT run_id, $2, 'x', 'REVOCATION', 'APPLIED', now() FROM kauro.restore_runs WHERE candidate_id = $1", [c.candidateId, k + 1]),
      (e: unknown) => sqlstateOf(e) === "KA092",
    );
    // the run resumes from k: k and the rest applied once, then released with the authorization
    await authorize(c.candidateId, c.deletionJournalHash);
    assert.equal((await runner.run(c.candidateId, c.plan, r)).kind, "RELEASED");
    assert.deepEqual(await states(), ["REVOKED", "REVOKED", "REVOKED"]);
    const seqs = (await oracleOf<{ journal_seq: string }>(r, "SELECT journal_seq::text FROM kauro.restore_applied_entries ORDER BY journal_seq")).map((x) => Number(x.journal_seq));
    assert.deepEqual(seqs, Array.from({ length: c.plan.journalThrough }, (_, i) => i + 1), "every entry applied once, in journal order");
  } finally {
    await r.stop();
  }
});

test("R2-074: a sent notification identity in the journal is never dispatched again from the restored outbox", { timeout: 600_000 }, async () => {
  const A = await w.agency("rs-notify");
  await published(A, "rs-notify");
  const pending = (await w.h.oracle.query<{ event_id: string }>("SELECT o.event_id FROM kauro.outbox_records o JOIN kauro.domain_events e USING (event_id) WHERE o.consumer = 'NOTIFICATIONS' AND o.state = 'PENDING' AND e.agency_id = $1", [A.agencyId])).rows.map((x) => x.event_id);
  assert.ok(pending.length > 0, "the purchase left notifications to dispatch");
  const file = backup("notify");
  // after the backup NOTIFICATIONS dispatches them: each identity sent once and journaled
  sent.length = 0;
  await w.drain(notifications);
  const identities = new Set(pending.map(notificationIdentityOf));
  assert.deepEqual(sent.filter((s) => identities.has(s.identity as never)).length, pending.length);
  for (const id of identities) assert.equal(await journal.has(id), true);
  await journalNow();
  const r = await restore(file, "notify");
  try {
    const restoredPending = await oracleOf<{ event_id: string }>(r, "SELECT event_id FROM kauro.outbox_records WHERE consumer = 'NOTIFICATIONS' AND state = 'PENDING' AND event_id = ANY($1::uuid[])", [pending]);
    assert.equal(restoredPending.length, pending.length, "the backup still holds them PENDING");
    const runner = runnerFor(r);
    const c = await runner.prepare(`local:${r.name}`);
    await authorize(c.candidateId, c.deletionJournalHash);
    assert.equal((await runner.run(c.candidateId, c.plan, r)).kind, "RELEASED");
    const outcomes = await oracleOf<{ outcome: string }>(r, "SELECT outcome FROM kauro.restore_applied_entries WHERE kind = 'NOTIFICATION' AND entry_id = ANY($1::text[])", [[...identities]]);
    assert.deepEqual(outcomes.map((o) => o.outcome), pending.map(() => "SUPPRESSED"));
    // the restored control plane dispatches NOTIFICATIONS: none of the sent identities goes out again
    sent.length = 0;
    await r.plane.drain(notifications, clock.now());
    assert.deepEqual(sent.filter((s) => identities.has(s.identity as never)), [], "no sent identity is dispatched again");
    // and a record that slipped past the suppression is answered from the journal, never sent
    const [row] = await oracleOf<{ event_type: string }>(r, "SELECT event_type FROM kauro.domain_events WHERE event_id = $1", [pending[0]]);
    const handled = await notifications.handle({ eventId: pending[0], eventType: row!.event_type, agencyId: A.agencyId } as never, w.h.system() as never, r.units as never);
    assert.deepEqual(handled, { kind: "DONE" });
    assert.deepEqual(sent.filter((s) => identities.has(s.identity as never)), []);
  } finally {
    await r.stop();
  }
});

test("R2-076 (restore): a RUNNING attempt in the backup is fenced and rerun under the same authorization; nothing resumes from scratch", { timeout: 600_000 }, async () => {
  const A = await w.agency("rs-attempt");
  const p = await w.paid(A, "rs-attempt");
  const { jobId, identity } = await admitted(w, p);
  // the worker is live and held before its manifest: the attempt is RUNNING when the backup is taken
  const beforeManifest = w.host.holdNext("manifest", identity);
  await launched(w, jobId);
  await beforeManifest.reached;
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  const live = await w.attempt(jobId, 1);
  assert.equal(live.state, "RUNNING");
  await journalNow();
  const file = backup("attempt");
  const r = await restore(file, "attempt");
  try {
    const [leaseBefore] = await oracleOf<{ fence: string; live: boolean }>(r, "SELECT fence::text, expires_at > kauro.server_now() AS live FROM kauro.leases WHERE resource_kind = 'JOB_ATTEMPT' AND resource_id = $1", [jobId]);
    assert.deepEqual([leaseBefore?.fence, leaseBefore?.live], ["1", true], "the backup holds the attempt's live lease");
    const runner = runnerFor(r);
    const c = await runner.prepare(`local:${r.name}`);
    await authorize(c.candidateId, c.deletionJournalHash);
    assert.equal((await runner.run(c.candidateId, c.plan, r)).kind, "RELEASED");
    const [leaseAfter] = await oracleOf<{ fence: string; live: boolean }>(r, "SELECT fence::text, expires_at > kauro.server_now() AS live FROM kauro.leases WHERE resource_kind = 'JOB_ATTEMPT' AND resource_id = $1", [jobId]);
    assert.deepEqual([leaseAfter?.fence, leaseAfter?.live], ["1", false], "S5 ended the restored lease");
    // nothing resumes the restored attempt from scratch: a takeover of its lease that names no checkpoint is refused by the lease
    // guard itself (the oracle bypasses row security, never the guard)
    const [held] = await oracleOf<{ checkpoint_hash: string | null }>(r, "SELECT checkpoint_hash FROM kauro.leases WHERE resource_kind = 'JOB_ATTEMPT' AND resource_id = $1", [jobId]);
    assert.ok(held?.checkpoint_hash !== null && held?.checkpoint_hash !== undefined, "the backup holds the attempt's durable checkpoint");
    await assert.rejects(
      oracleOf(r, "UPDATE kauro.leases SET owner_id = $2, fence = fence + 1, checkpoint_hash = NULL, heartbeat_at = kauro.server_now(), expires_at = least(kauro.server_now() + interval '60 seconds', deadline_at) WHERE resource_kind = 'JOB_ATTEMPT' AND resource_id = $1", [jobId, ids.next()]),
      (e: unknown) => sqlstateOf(e) === "KA005" && /RESUME_WITHOUT_CHECKPOINT/.test(String((e as Error).message)),
    );
    // the restored control plane's ATTEMPT_MONITOR abandons the attempt and reruns the job as a new attempt at fence + 1
    await r.plane.execution!.sweepers.attemptMonitor.sweep(r.units, 20);
    const attempts = await oracleOf<{ ordinal: number; state: string; fence: string | null; terminal_cause: string | null; identity: string }>(r, "SELECT ordinal, state, fence::text, terminal_cause, identity FROM kauro.processing_attempts WHERE job_id = $1 ORDER BY ordinal", [jobId]);
    assert.deepEqual(attempts.map((a) => [a.ordinal, a.state, a.terminal_cause]), [
      [1, "ABANDONED", "LEASE_LAPSED"],
      [2, "CLAIMED", null],
    ]);
    assert.equal(attempts[1]!.fence, "2");
    assert.notEqual(attempts[1]!.identity, attempts[0]!.identity, "the rerun is a new attempt identity");
    const [job] = await oracleOf<{ authorization_id: string; attempt_count: number }>(r, "SELECT authorization_id::text, attempt_count FROM kauro.processing_jobs WHERE job_id = $1", [jobId]);
    assert.equal(job?.authorization_id, p.authorizationId, "under the same authorization");
  } finally {
    await r.stop();
  }
});

// after every test that admits a job: it moves the world clock past a package soft deadline (seven days), after which a new purchase of the shared world is not
// admitted on the same terms
test("R2-126: a restored earlier deadline never deletes data promised by a journaled extension; a later tombstone still wins", { timeout: 600_000 }, async () => {
  const A = await w.agency("rs-retention");
  const p = await published(A, "rs-retention-kept");
  const q = await published(A, "rs-retention-ended");
  const [pBefore] = (await w.h.oracle.query<RecordRow>(recordSql, [p.revisionId])).rows;
  assert.ok(pBefore?.soft_deadline !== null && pBefore !== undefined, "the first package set the soft deadline");
  const file = backup("retention");
  // after the backup: p is extended by three days, q by one hour; the clock passes q's extended deadline (the RETENTION sweep expires
  // q: a later tombstone) but not p's, while both restored soft deadlines are already in the past
  await extendLive(A, p, 259_200);
  await extendLive(A, q, 3_600);
  const toPast = Math.ceil((pBefore.soft_deadline!.getTime() - Date.now()) / 1000) + 2 * 3_600;
  w.advance(toPast);
  await w.plane.sweepers.retention.sweep(w.units, 200);
  assert.equal((await w.h.oracle.query<RecordRow>(recordSql, [q.revisionId])).rows[0]!.state, "EXPIRED", "q expired after its extended deadline");
  assert.equal((await w.h.oracle.query<RecordRow>(recordSql, [p.revisionId])).rows[0]!.state, "ACTIVE", "p's extension keeps it");
  await journalNow();
  const kinds = (await journal.entries(0, await journal.head())).filter((e) => e.agencyId === A.agencyId).map((e) => e.kind);
  assert.ok(kinds.includes("EXTENSION") && kinds.includes("TOMBSTONE"), "the extensions and q's tombstones are journaled");
  const r = await restore(file, "retention");
  try {
    const [pRestored] = await oracleOf<RecordRow>(r, recordSql, [p.revisionId]);
    assert.equal(pRestored?.state, "ACTIVE");
    // without the journal the restored deadline is already past: the cleanup alone would expire p (what the journal must prevent)
    const due = await oracleOf<{ past: boolean }>(r, `SELECT effective_deadline <= now() + make_interval(secs => ${w.units.offsetSeconds}) AS past FROM kauro.retention_records WHERE revision_id = $1 AND class = 'PAID_ORDINARY'`, [p.revisionId]);
    assert.equal(due[0]!.past, true, "the restored deadline of p is in the past");
    const runner = runnerFor(r);
    const c = await runner.prepare(`local:${r.name}`);
    await authorize(c.candidateId, c.deletionJournalHash);
    const done = await runner.run(c.candidateId, c.plan, r);
    assert.equal(done.kind, "RELEASED", JSON.stringify(done));
    const [pAfter] = await oracleOf<RecordRow>(r, recordSql, [p.revisionId]);
    assert.equal(pAfter?.state, "ACTIVE", "the journaled extension was applied before the cleanup: p's promised data is kept");
    assert.equal(pAfter?.soft_deadline?.getTime(), pBefore.soft_deadline!.getTime() + 259_200_000, "the soft deadline is the extended one");
    const [qAfter] = await oracleOf<RecordRow>(r, recordSql, [q.revisionId]);
    assert.equal(qAfter?.state, "EXPIRED", "q's later expiry wins over its restored ACTIVE record");
    // each revision the restored database holds is in the live one's state (q's revision ends with its last ACTIVE record, not its paid one)
    for (const x of [p, q]) {
      const [restoredRevision] = await oracleOf<{ state: string }>(r, "SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1", [x.revisionId]);
      const live = (await w.h.oracle.query<{ state: string }>("SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1", [x.revisionId])).rows[0];
      assert.equal(restoredRevision?.state, live?.state);
    }
  } finally {
    await r.stop();
  }
});

// last of all: its deletion tombstone has no writer here (L3), so every later restore stops at it, fail closed
test("S065: a membership revoked and a project deleted after the backup stay revoked and deleted before any request", { timeout: 600_000 }, async () => {
  const A = await w.agency("rs-s065");
  const p = await w.paid(A, "rs-s065");
  const member = await w.h.addMember(A, await w.h.person("rs-s065-member"), "VIEWER");
  const file = backup("s065");
  await revokeLive(A, member);
  await journalNow();
  // the project's deletion after the backup: lane L3 writes it; here its durable tombstone alone, as the AUTHORITY_JOURNAL consumer
  // appends it for dataset_revision.deleted.v1 (PART: the deletion writer)
  const members = { tombstoneId: ids.next(), kind: "REVISION_DELETED", agencyId: A.agencyId, revisionId: p.revisionId, subjectId: p.revisionId, state: "DELETED", occurredAt: clock.now(), sequence: 900_000_000 + seq } as const;
  assert.equal(await journal.append({ ...members, evidenceHash: authorityTombstoneHashOf(members) } as AuthorityTombstone), "APPENDED");
  await journalNow();
  const r = await restore(file, "s065");
  try {
    assert.equal((await oracleOf<{ state: string }>(r, "SELECT state FROM kauro.memberships WHERE membership_id = $1", [member]))[0]?.state, "ACTIVE", "the backup holds the member ACTIVE");
    const runner = runnerFor(r);
    const c = await runner.prepare(`local:${r.name}`);
    await authorize(c.candidateId, c.deletionJournalHash);
    const out = await runner.run(c.candidateId, c.plan, r);
    // the revocation is applied before anything is served; the deleted revision the backup still holds stops the run at its tombstone
    assert.equal((await oracleOf<{ state: string }>(r, "SELECT state FROM kauro.memberships WHERE membership_id = $1", [member]))[0]?.state, "REVOKED");
    assert.equal(out.kind, "FAILED_AT");
    assert.ok(out.kind === "FAILED_AT" && out.code === "TOMBSTONE_NOT_APPLICABLE");
    assert.equal((await gateOf(r)).state, "CLOSED", "the restored database never serves the deleted project");
    const claim = await claimant(r);
    await assert.rejects(claimOn(claim, "NOTIFICATIONS"), atGate);
    await claim.query("ROLLBACK");
    await claim.end();
  } finally {
    await r.stop();
  }
});

void ({} as AgencyId);
