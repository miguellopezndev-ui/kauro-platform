// CMD038 AuthorizeDownload (package B16, lane L5; .kauro plan B16-REST-PLAN section 2 "CMD038": one COMMIT writes the authorization rows, the
// audit event and the journal entry; signing is a port call AFTER COMMIT). Written before the product (tests first): the real route over the
// real authorizer, journal and PostgreSQL 17 through the runtime login roles. The package is the one the production writers leave: a paid
// purchase executed by the control plane's steps (admit, launch, stage, verify, publish), its delivery copies registered DELIVERY and its
// PAID_ORDINARY record governing the source. The signer is the labelled contract fake of ObjectReadSigningPort (SIMULATED; the S3 presign
// provider is B15's, PARTIAL). Where a title needs a state the writers reach only with time or by another package's command (a package
// revocation, a project's deletion request, a deleted delivery object, a deadline minutes away), the superuser writes it, said so where it
// does. The oracle is the superuser.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import type { Client, PoolClient } from "pg";
import { fixtureArtifacts, publishJob, stageJob, verifyJob, type SqlSession } from "@kauro/persistence/testing";
import { paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { endLiveJobs, runningJob } from "./execution-support.js";
import { activePerson, suspendMember } from "./team-support.js";
import { SimulatedCrash, call, freshKey, ids, rawEvent, replayTextOf, rootCause, routes, waitForApiLockWait, type Hold, type Person, type Reply } from "./support.js";

// --- the world: the api's units of work may stand on the TEST CLOCK -------------------------------------------------------------------

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
before(async () => {
  pw = await paymentsWorld({ unbound: ["capacity"], wrapUnitOfWork: standing });
});
after(async () => {
  await pw.stop();
});
afterEach(async () => {
  stand = null;
  for (const name of pw.w.holds.armedNames) await pw.w.holds.pass(name).catch(() => undefined);
  pw.w.signer.reset();
  await endLiveJobs(pw);
});

const LIFETIME_S = 900;
const isoOf = (ms: number): string => new Date(ms).toISOString();
const usOf = (s: string): bigint => BigInt(s);
const msOf = (us: bigint): number => Number(us / 1000n);

// --- fixtures -------------------------------------------------------------------------------------------------------------------------

interface Artifact {
  readonly object_id: string;
  readonly role: string;
  readonly sha256: string;
  readonly byte_length: string;
  readonly object_name: string;
  readonly generation: string;
}

interface Delivered {
  readonly packageId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly retentionId: string;
  readonly artifacts: ReadonlyArray<Artifact>;
}

/** A paid purchase executed to an AVAILABLE package with `count` delivery copies; its revision's PAID_ORDINARY record governs it. */
async function available(label: string, count = 2): Promise<Delivered> {
  const o = pw.w.h.oracle;
  const r = await runningJob(pw, label);
  const attempt = (await o.query<{ staging_prefix: string }>("SELECT a.staging_prefix FROM kauro.processing_attempts a JOIN kauro.processing_jobs j ON j.current_attempt_id = a.attempt_id WHERE j.job_id = $1", [r.jobId])).rows[0];
  assert.ok(attempt !== undefined, "the running job has its attempt");
  await stageJob(pw.w.h, pw.w.A, r.jobId, fixtureArtifacts({ stagingPrefix: attempt.staging_prefix } as never, count));
  const pkg = await verifyJob(pw.w.h, pw.w.A, r.jobId);
  assert.equal((await publishJob(pw.w.h, pw.w.A, r.jobId)).kind, "PUBLISHED");
  const artifacts = (
    await o.query<Artifact>(
      "SELECT d.object_id, d.role, d.sha256, d.byte_length::text AS byte_length, d.object_name, d.generation FROM kauro.delivery_artifacts d WHERE d.package_version_id = $1 ORDER BY d.role",
      [pkg.packageVersionId],
    )
  ).rows;
  assert.equal(artifacts.length, count, "one delivery copy per staged artifact");
  const retention = (
    await o.query<{ retention_id: string }>(
      `SELECT r.retention_id FROM kauro.retention_records r JOIN kauro.dataset_revisions d ON d.revision_id = r.revision_id
        JOIN kauro.processing_jobs j ON j.project_id = d.project_id AND j.revision_hash = d.manifest_hash
       WHERE j.job_id = $1 AND r.class = 'PAID_ORDINARY' AND r.state = 'ACTIVE'`,
      [r.jobId],
    )
  ).rows;
  assert.equal(retention.length, 1, "one ACTIVE PAID_ORDINARY record governs the package's source");
  return { packageId: pkg.packageVersionId, projectId: r.sale.projectId, jobId: r.jobId, retentionId: retention[0]!.retention_id, artifacts };
}

const authorizationRoute = (packageId: string): string => `/api/v1/packages/${packageId}/download-authorizations`;

interface Options {
  readonly key?: string;
  readonly person?: Person;
  readonly agency?: string;
  readonly proof?: string;
}

/** The step-up proof first sent with each named key: a retry with the same key is the identical request, its proof included (the digest binds it). */
const proofOfKey = new Map<string, string>();

async function authorize(packageId: string, artifactIds: ReadonlyArray<string>, options: Options = {}): Promise<Reply> {
  const person = options.person ?? pw.w.viewer;
  const key = options.key ?? freshKey("cmd038");
  let proof = options.proof ?? (options.key !== undefined ? proofOfKey.get(options.key) : undefined);
  if (proof === undefined) proof = await pw.w.stepUp(person);
  if (options.key !== undefined && !proofOfKey.has(options.key)) proofOfKey.set(options.key, proof);
  return call(pw.w, {
    url: authorizationRoute(packageId),
    token: person.token,
    agency: options.agency ?? pw.w.A.agencyId,
    key,
    body: { artifactIds: [...artifactIds], assuranceProofRef: proof },
  });
}

interface DownloadView {
  readonly authorizationId: string;
  readonly packageId: string;
  readonly projectId: string;
  readonly version: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lifetimeSeconds: number;
  readonly providerRevocation: string;
  readonly artifacts: ReadonlyArray<{ readonly artifactId: string; readonly role: string; readonly byteLength: number; readonly sha256: string; readonly url: string }>;
}

function answer(reply: Reply): string {
  if (reply.status < 400) return `${reply.status} SUCCESS ${reply.text.slice(0, 200)}`;
  try {
    const p = reply.json<{ code?: string; reason?: string }>();
    return `${reply.status} ${p.code ?? "?"} ${p.reason ?? "-"}`;
  } catch {
    return `${reply.status} ${reply.text.slice(0, 200)}`;
  }
}

function granted(reply: Reply): { readonly replayed: boolean; readonly data: DownloadView } {
  assert.equal(reply.status, 201, `CMD038 answered ${answer(reply)}`);
  const body = reply.json<{ kind: string; replayed: boolean; data: DownloadView }>();
  assert.equal(body.kind, "COMPLETED");
  return body;
}

async function reached(hold: Hold, reply: Promise<Reply>, what: string): Promise<void> {
  const first = await Promise.race([hold.reached.then(() => null), reply]);
  if (first !== null) assert.fail(`${what} answered ${answer(first)} before reaching its hold point`);
}

async function waitsOn(reply: Promise<Reply>, fragment: string, what: string): Promise<number> {
  const waiting = waitForApiLockWait(pw.w, fragment);
  waiting.catch(() => undefined);
  const first = await Promise.race([waiting, reply]);
  if (typeof first !== "number") assert.fail(`${what} answered ${answer(first)} without waiting on ${fragment}`);
  return first;
}

// --- footprints -----------------------------------------------------------------------------------------------------------------------

async function present(table: string): Promise<boolean> {
  return (await pw.w.h.oracle.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [`kauro.${table}`])).rows[0]?.present === true;
}

interface Footprint {
  readonly authorizations: number;
  readonly authorized: number;
  readonly events: number;
  readonly committed: number;
  readonly signed: number;
}

async function footprint(packageId: string): Promise<Footprint> {
  const tables = await present("download_authorizations");
  return {
    authorizations: tables ? await pw.w.count("download_authorizations", "package_version_id = $1", [packageId]) : -1,
    authorized: tables ? await pw.w.count("download_authorization_artifacts", "package_version_id = $1", [packageId]) : -1,
    events: await pw.w.count("domain_events", "event_type = 'download_authorization.issued.v1' AND agency_id = $1", [pw.w.A.agencyId]),
    committed: await pw.w.count("command_journal", "operation = 'CMD038' AND agency_id = $1 AND state = 'COMMITTED'", [pw.w.A.agencyId]),
    signed: pw.w.signer.calls.length,
  };
}

async function authorizationRow(authorizationId: string): Promise<{ readonly sign_state: string; readonly expires_us: string; readonly issued_us: string; readonly membership_version: string; readonly artifact_count: number }> {
  const r = await pw.w.h.oracle.query<{ sign_state: string; expires_us: string; issued_us: string; membership_version: string; artifact_count: number }>(
    `SELECT sign_state, (extract(epoch FROM expires_at) * 1000000)::bigint::text AS expires_us, (extract(epoch FROM issued_at) * 1000000)::bigint::text AS issued_us,
            membership_version::text AS membership_version, (SELECT count(*)::int FROM kauro.download_authorization_artifacts x WHERE x.authorization_id = a.authorization_id) AS artifact_count
       FROM kauro.download_authorizations a WHERE authorization_id = $1`,
    [authorizationId],
  );
  assert.equal(r.rows.length, 1, "the authorization row exists");
  return r.rows[0]!;
}

async function journalOf(key: string): Promise<ReadonlyArray<{ readonly state: string; readonly response_status: number | null; readonly body: string | null }>> {
  return (await pw.w.h.oracle.query<{ state: string; response_status: number | null; body: string | null }>("SELECT state, response_status, response_body::text AS body FROM kauro.command_journal WHERE operation = 'CMD038' AND idempotency_key = $1", [key])).rows;
}

/** A superuser transaction left open (the caller commits or rolls back): writes another package's command would write. */
async function superTx(): Promise<Client> {
  const c = await pw.w.h.pg.connect("postgres");
  await c.query("BEGIN");
  return c;
}

async function end(c: Client, how: "COMMIT" | "ROLLBACK"): Promise<void> {
  try {
    await c.query(how);
  } finally {
    await c.end();
  }
}

/** The control plane's revocation of an AVAILABLE package, as the superuser writes it with its event (B08's revocation path is not served yet). */
async function revokePackage(c: Client, packageId: string): Promise<void> {
  const moved = await c.query<{ version: string }>("UPDATE kauro.package_versions SET state = 'REVOKED', revocation_reason = 'OPERATOR_REVOKED', version = version + 1 WHERE package_version_id = $1 RETURNING version::text AS version", [packageId]);
  assert.equal(moved.rowCount, 1);
  await rawEvent(c as unknown as PoolClient, { aggregateKind: "package_version", aggregateId: packageId, aggregateVersion: Number(moved.rows[0]!.version), agencyId: pw.w.A.agencyId, eventType: "package_version.revoked.v1", actorUserId: pw.w.owner.userId, payload: { packageVersionId: packageId, agencyId: pw.w.A.agencyId } } as never);
}

/** CMD042's first write as it holds the project (its exclusive transition lock is taken by the state change): OPEN -> DELETION_REQUESTED.
 *  CMD042's event type is registered by its own lane's migration, not on this base, so the superuser registers it in this test database. */
async function requestDeletion(c: Client, projectId: string): Promise<void> {
  await c.query("INSERT INTO kauro.event_types (event_type) VALUES ('project.deletion_requested.v1') ON CONFLICT DO NOTHING");
  const moved = await c.query<{ version: string }>("UPDATE kauro.projects SET state = 'DELETION_REQUESTED', version = version + 1 WHERE project_id = $1 RETURNING version::text AS version", [projectId]);
  assert.equal(moved.rowCount, 1);
  await rawEvent(c as unknown as PoolClient, { aggregateKind: "project", aggregateId: projectId, aggregateVersion: Number(moved.rows[0]!.version), agencyId: pw.w.A.agencyId, eventType: "project.deletion_requested.v1", actorUserId: pw.w.owner.userId, payload: { projectId, agencyId: pw.w.A.agencyId } } as never);
}

/** Moves the governing record's soft (and so its effective) deadline as the superuser with triggers off (a deadline the writers reach only with time). */
async function placeDeadline(retentionId: string, expression: string): Promise<bigint> {
  const c = pw.w.h.oracle;
  try {
    await c.query("SET session_replication_role = replica");
    const r = await c.query<{ us: string }>(`UPDATE kauro.retention_records SET soft_deadline = ${expression}, effective_deadline = least(${expression}, hard_deadline) WHERE retention_id = $1 RETURNING (extract(epoch FROM effective_deadline) * 1000000)::bigint::text AS us`, [retentionId]);
    assert.equal(r.rowCount, 1);
    return usOf(r.rows[0]!.us);
  } finally {
    await c.query("RESET session_replication_role");
  }
}

/** A delivery object the deletion inventory moved on (the superuser writes its state, triggers off). */
async function markObject(objectId: string, state: "DELETION_REQUESTED" | "DELETED"): Promise<void> {
  const c = pw.w.h.oracle;
  try {
    await c.query("SET session_replication_role = replica");
    const r = await c.query(
      `UPDATE kauro.stored_objects SET state = $2, deletion_requested_at = now(), deletion_reason = 'RETENTION_EXPIRED',
              deleted_at = CASE WHEN $2 = 'DELETED' THEN now() END, deletion_result = CASE WHEN $2 = 'DELETED' THEN 'DELETED' END,
              provider_residual_basis = CASE WHEN $2 = 'DELETED' THEN 'LOCATION_POLICY' END WHERE object_id = $1`,
      [objectId, state],
    );
    assert.equal(r.rowCount, 1);
  } finally {
    await c.query("RESET session_replication_role");
  }
}

async function membershipOf(person: Person): Promise<{ readonly membership_id: string; readonly version: string }> {
  const m = await pw.w.row<{ membership_id: string; version: string }>("memberships", "user_id = $1 AND agency_id = $2", [person.userId, pw.w.A.agencyId]);
  assert.ok(m !== null, "the person is a member of agency A");
  return { membership_id: m.membership_id, version: String(m.version) };
}

// --- OK ---------------------------------------------------------------------------------------------------------------------------------

test("CMD038-OK: a reader authorizes two artifacts of an AVAILABLE package: one COMMIT writes the authorization and its artifact rows, download_authorization.issued.v1 and the journal entry; the URLs are signed after COMMIT, bound to the requester, valid for least(900 s, the retention deadline - now) and never journaled", async () => {
  const d = await available("cmd038-ok");
  const key = freshKey("cmd038-ok");
  const before = await footprint(d.packageId);
  const done = granted(await authorize(d.packageId, d.artifacts.map((a) => a.object_id), { key }));
  assert.equal(done.replayed, false);
  const x = done.data;
  assert.deepEqual([x.packageId, x.projectId, x.version, x.lifetimeSeconds, x.providerRevocation], [d.packageId, d.projectId, 1, LIFETIME_S, "UNAVAILABLE"]);
  assert.deepEqual(
    x.artifacts.map((a) => [a.artifactId, a.role, a.byteLength, a.sha256]),
    d.artifacts.map((a) => [a.object_id, a.role, Number(a.byte_length), a.sha256]),
    "exactly the requested artifacts, nothing unrelated",
  );
  const row = await authorizationRow(x.authorizationId);
  assert.equal(row.sign_state, "SIGNED");
  assert.equal(row.artifact_count, 2);
  assert.equal(usOf(row.expires_us) - usOf(row.issued_us) <= BigInt(LIFETIME_S) * 1_000_000n, true, "never longer than 900 s");
  assert.equal(Date.parse(x.expiresAt), msOf(usOf(row.expires_us)), "the disclosed expiry is the stored one");
  // every URL is valid for its requester until the disclosed expiry and for nobody else
  for (const a of x.artifacts) {
    assert.equal(pw.w.signer.verify(a.url, { userId: pw.w.viewer.userId, atMs: Date.parse(x.expiresAt) - 1 }), "VALID");
    assert.equal(pw.w.signer.verify(a.url, { userId: pw.w.operator.userId, atMs: Date.parse(x.expiresAt) - 1 }), "WRONG_REQUESTER");
    assert.equal(pw.w.signer.verify(a.url, { userId: pw.w.viewer.userId, atMs: Date.parse(x.expiresAt) + 1 }), "EXPIRED");
  }
  const after = await footprint(d.packageId);
  assert.deepEqual(
    [after.authorizations - before.authorizations, after.authorized - before.authorized, after.events - before.events, after.committed - before.committed, after.signed - before.signed],
    [1, 2, 1, 1, 2],
    "one authorization, two artifact rows, one audit event, one journal entry, two signatures",
  );
  const events = await pw.w.events("download_authorization", x.authorizationId);
  assert.deepEqual(events.map((e) => [e.type, e.version]), [["download_authorization.issued.v1", 1]]);
  const journal = await journalOf(key);
  assert.deepEqual(journal.map((j) => [j.state, j.response_status]), [["COMMITTED", 201]]);
  assert.ok(journal[0]!.body !== null && !journal[0]!.body.includes("\"url\"") && !x.artifacts.some((a) => journal[0]!.body!.includes(a.url)), "no signed URL is journaled");
  // the signer was called after COMMIT, once per artifact, with the stored expiry
  assert.deepEqual(pw.w.signer.calls.map((c) => [c.authorizationId, c.expiresAtMs]), x.artifacts.map(() => [x.authorizationId, Date.parse(x.expiresAt)]));
});

test("CMD038-OK (lifetime): the URL lifetime is least(900 s, the retention deadline - now): a deadline five minutes away bounds the expiry at the deadline", async () => {
  const d = await available("cmd038-lifetime");
  const deadline = await placeDeadline(d.retentionId, "now() + interval '300 seconds'");
  const x = granted(await authorize(d.packageId, [d.artifacts[0]!.object_id])).data;
  assert.equal(Date.parse(x.expiresAt), msOf(deadline), "the expiry is the retention deadline");
  assert.ok(x.lifetimeSeconds <= 300 && x.lifetimeSeconds >= 290, `lifetime ${x.lifetimeSeconds} s`);
  const row = await authorizationRow(x.authorizationId);
  assert.equal(row.expires_us, String(deadline), "stored exactly at the deadline");
});

// --- DENY -------------------------------------------------------------------------------------------------------------------------------

test("CMD038-DENY: deleted/quarantined artifacts, a package not AVAILABLE, a stale step-up, a suspended member and an unknown artifact deny with nothing written; a shared cache never reuses another user's URL (per-user Cache-Control no-store, URL bound to the requester)", async () => {
  const d = await available("cmd038-deny");
  const ids2 = d.artifacts.map((a) => a.object_id);
  const before = await footprint(d.packageId);
  // an artifact id the package does not have, and one of another package of the agency, look alike: 404, nothing exposed
  const other = await available("cmd038-deny-other");
  assert.equal(answer(await authorize(d.packageId, [ids.next()])), "404 NOT_FOUND ARTIFACT_NOT_FOUND");
  assert.equal(answer(await authorize(d.packageId, [other.artifacts[0]!.object_id])), "404 NOT_FOUND ARTIFACT_NOT_FOUND");
  // a stale step-up
  assert.equal(answer(await authorize(d.packageId, ids2, { proof: await pw.w.stepUp(pw.w.viewer, "STALE") })), "403 ASSURANCE_REQUIRED STEP_UP_STALE");
  // a suspended member
  const s = await activePerson(pw.w, "cmd038-suspended", "VIEWER");
  await suspendMember(pw.w, s.membershipId);
  assert.equal(answer(await authorize(d.packageId, ids2, { person: s.person })), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  // a duplicate or empty list is refused by the schema
  assert.equal((await authorize(d.packageId, [])).status, 400);
  assert.equal((await authorize(d.packageId, [ids2[0]!, ids2[0]!])).status, 400);
  assert.deepEqual(await footprint(d.packageId), before, "nothing written by any refusal");

  // a deleted delivery object: the whole request is refused
  await markObject(d.artifacts[1]!.object_id, "DELETED");
  assert.equal(answer(await authorize(d.packageId, ids2)), "409 PRECONDITION_FAILED ARTIFACT_UNAVAILABLE");
  assert.deepEqual(await footprint(d.packageId), before);

  // a package not AVAILABLE (revoked: quarantined from delivery)
  const c = await superTx();
  let how: "COMMIT" | "ROLLBACK" = "ROLLBACK";
  try {
    await revokePackage(c, other.packageId);
    how = "COMMIT";
  } finally {
    await end(c, how);
  }
  const beforeOther = await footprint(other.packageId);
  assert.equal(answer(await authorize(other.packageId, other.artifacts.map((a) => a.object_id))), "409 PRECONDITION_FAILED PACKAGE_NOT_AVAILABLE");
  assert.deepEqual(await footprint(other.packageId), beforeOther);

  // a shared cache: two users, the same artifact, two URLs, each bound to its requester; every reply is no-store (call() asserts it)
  const fresh = await available("cmd038-deny-cache");
  const a = granted(await authorize(fresh.packageId, [fresh.artifacts[0]!.object_id], { person: pw.w.viewer })).data;
  const b = granted(await authorize(fresh.packageId, [fresh.artifacts[0]!.object_id], { person: pw.w.operator })).data;
  assert.notEqual(a.artifacts[0]!.url, b.artifacts[0]!.url, "never another user's URL");
  assert.equal(pw.w.signer.verify(a.artifacts[0]!.url, { userId: pw.w.operator.userId, atMs: Date.now() }), "WRONG_REQUESTER");
  assert.equal(pw.w.signer.verify(b.artifacts[0]!.url, { userId: pw.w.viewer.userId, atMs: Date.now() }), "WRONG_REQUESTER");
});

test("S048 (download): another agency's package and a package that never existed answer identically, and nothing of either leaks", async () => {
  const d = await available("s048-download");
  const stranger = pw.w.stranger;
  const foreign = await authorize(d.packageId, [d.artifacts[0]!.object_id], { person: stranger, agency: pw.w.B.agencyId });
  const missing = await authorize(ids.next(), [d.artifacts[0]!.object_id], { person: stranger, agency: pw.w.B.agencyId });
  assert.equal(answer(foreign), "404 NOT_FOUND -");
  assert.equal(answer(missing), answer(foreign));
  const shape = (r: Reply): string => JSON.stringify({ ...r.json<Record<string, unknown>>(), correlationId: null, instance: null });
  assert.equal(shape(foreign), shape(missing), "identical problem bodies");
  assert.ok(!foreign.text.includes(d.projectId) && !foreign.text.includes(d.artifacts[0]!.object_name), "nothing of the package leaks");
  assert.equal(foreign.headers["cache-control"], "no-store");
  // the route serves the package's own agency: the 404 above is the tenant boundary, not a missing route
  assert.equal(granted(await authorize(d.packageId, [d.artifacts[0]!.object_id])).data.packageId, d.packageId);
});

// --- RACE -------------------------------------------------------------------------------------------------------------------------------

test("CMD038-RACE: issuance held at the package await against CMD042 and a package revocation, both orders; crash after COMMIT before signing and a lost answer are recovered by the key with the same scope; two keys are two authorizations", async () => {
  // order 1: the revocation is written (the package's exclusive transition lock held to COMMIT); the issuance waits on the package await,
  // then reads REVOKED: PACKAGE_NOT_AVAILABLE, nothing written
  {
    const d = await available("cmd038-race-revoke-first");
    const before = await footprint(d.packageId);
    const c = await superTx();
    let how: "COMMIT" | "ROLLBACK" = "ROLLBACK";
    let reply: Promise<Reply> | null = null;
    try {
      await revokePackage(c, d.packageId);
      reply = authorize(d.packageId, d.artifacts.map((a) => a.object_id));
      await waitsOn(reply, "await_transition('kauro.package_versions'", "the issuance");
      how = "COMMIT";
    } finally {
      await end(c, how);
    }
    assert.equal(answer(await reply), "409 PRECONDITION_FAILED PACKAGE_NOT_AVAILABLE");
    assert.deepEqual(await footprint(d.packageId), before);
  }
  // order 2: the issuance passed the package await and is held before its journal commit; the revocation waits on the package's
  // transition lock until the issuance commits; afterwards the issued grant is not re-signed (no new URL)
  {
    const d = await available("cmd038-race-issue-first");
    const key = freshKey("cmd038-race-issue-first");
    const hold = pw.w.holds.arm("journal.commit");
    const reply = authorize(d.packageId, d.artifacts.map((a) => a.object_id), { key });
    await reached(hold, reply, "the issuance");
    const c = await superTx();
    const revocation = revokePackage(c, d.packageId);
    revocation.catch(() => undefined);
    const waited = await Promise.race([
      (async () => {
        for (let i = 0; i < 200; i++) {
          const w = await pw.w.h.oracle.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE kauro.package_versions%'");
          if (w.rows[0]!.n !== "0") return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return false;
      })(),
      revocation.then(() => false),
    ]);
    assert.equal(waited, true, "the revocation waits behind the in-flight issuance");
    hold.release();
    const x = granted(await reply).data;
    await revocation;
    await end(c, "COMMIT");
    assert.equal((await authorizationRow(x.authorizationId)).sign_state, "SIGNED");
    // the issued URL keeps its disclosed residual lifetime (no provider revocation is promised); the same key signs nothing new
    assert.equal(pw.w.signer.verify(x.artifacts[0]!.url, { userId: pw.w.viewer.userId, atMs: Date.parse(x.expiresAt) - 1 }), "VALID");
    const signed = pw.w.signer.calls.length;
    assert.equal(answer(await authorize(d.packageId, d.artifacts.map((a) => a.object_id), { key })), "409 PRECONDITION_FAILED PACKAGE_NOT_AVAILABLE");
    assert.equal(pw.w.signer.calls.length, signed, "no new URL after the revocation");
  }
  // CMD042 first: the project's deletion request holds the project; the issuance waits on the project await and is refused
  {
    const d = await available("cmd038-race-cmd042-first");
    const before = await footprint(d.packageId);
    const c = await superTx();
    let how: "COMMIT" | "ROLLBACK" = "ROLLBACK";
    let reply: Promise<Reply> | null = null;
    try {
      await requestDeletion(c, d.projectId);
      reply = authorize(d.packageId, d.artifacts.map((a) => a.object_id));
      await waitsOn(reply, "await_transition('kauro.projects'", "the issuance");
      how = "COMMIT";
    } finally {
      await end(c, how);
    }
    assert.equal(answer(await reply), "409 PRECONDITION_FAILED PROJECT_NOT_OPEN");
    assert.deepEqual(await footprint(d.packageId), before);
  }
  // CMD042 second: the issuance holds its project await; the deletion request waits for it, then the grant is not re-signed
  {
    const d = await available("cmd038-race-cmd042-second");
    const key = freshKey("cmd038-race-cmd042-second");
    const hold = pw.w.holds.arm("journal.commit");
    const reply = authorize(d.packageId, d.artifacts.map((a) => a.object_id), { key });
    await reached(hold, reply, "the issuance");
    const c = await superTx();
    const deletion = requestDeletion(c, d.projectId);
    deletion.catch(() => undefined);
    const waited = await Promise.race([
      (async () => {
        for (let i = 0; i < 200; i++) {
          const w = await pw.w.h.oracle.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE kauro.projects%'");
          if (w.rows[0]!.n !== "0") return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return false;
      })(),
      deletion.then(() => false),
    ]);
    assert.equal(waited, true, "the deletion request waits behind the in-flight issuance");
    hold.release();
    granted(await reply);
    await deletion;
    await end(c, "COMMIT");
    assert.equal(answer(await authorize(d.packageId, d.artifacts.map((a) => a.object_id), { key })), "409 PRECONDITION_FAILED PROJECT_NOT_OPEN");
  }
  // CRASH-AFTER-COMMIT before signing: the authorization is committed, nothing signed; the same key signs the same scope at the same expiry
  {
    const d = await available("cmd038-crash-after");
    const key = freshKey("cmd038-crash-after");
    const signed = pw.w.signer.calls.length;
    pw.w.holds.arm("after.commit", { fail: new SimulatedCrash("after COMMIT, before signing") });
    assert.equal(answer(await authorize(d.packageId, [d.artifacts[0]!.object_id], { key })), "500 INTERNAL_ERROR -");
    assert.equal(rootCause(pw.w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
    assert.equal(pw.w.signer.calls.length, signed, "nothing was signed");
    const rows = await pw.w.h.oracle.query<{ authorization_id: string; sign_state: string }>("SELECT authorization_id, sign_state FROM kauro.download_authorizations WHERE package_version_id = $1", [d.packageId]);
    assert.deepEqual(rows.rows.map((r) => r.sign_state), ["PENDING"], "committed, unsigned");
    const stored = await authorizationRow(rows.rows[0]!.authorization_id);
    const recovered = granted(await authorize(d.packageId, [d.artifacts[0]!.object_id], { key }));
    assert.equal(recovered.replayed, true);
    assert.equal(recovered.data.authorizationId, rows.rows[0]!.authorization_id);
    assert.equal(Date.parse(recovered.data.expiresAt), msOf(usOf(stored.expires_us)), "the same expiry, never a later one");
    assert.deepEqual(recovered.data.artifacts.map((a) => a.artifactId), [d.artifacts[0]!.object_id], "the same scope, never a broader one");
    assert.equal((await authorizationRow(rows.rows[0]!.authorization_id)).sign_state, "SIGNED");
    assert.equal(await pw.w.count("download_authorizations", "package_version_id = $1", [d.packageId]), 1, "not authorized twice");
    // the same key with a broader body is a conflict, never a broader grant
    assert.equal(answer(await authorize(d.packageId, d.artifacts.map((a) => a.object_id), { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  }
  // CRASH-BEFORE-COMMIT: nothing survives; the same key then authorizes once
  {
    const d = await available("cmd038-crash-before");
    const key = freshKey("cmd038-crash-before");
    const before = await footprint(d.packageId);
    pw.w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
    assert.equal(answer(await authorize(d.packageId, [d.artifacts[0]!.object_id], { key })), "500 INTERNAL_ERROR -");
    assert.deepEqual(await footprint(d.packageId), before, "the authorization, its rows, the event and the journal rolled back; nothing signed");
    assert.equal(granted(await authorize(d.packageId, [d.artifacts[0]!.object_id], { key })).replayed, false);
  }
  // RETRY: an identical replay answers the first answer byte for byte (the deterministic signature of the same scope) and writes nothing
  {
    const d = await available("cmd038-retry");
    const key = freshKey("cmd038-retry");
    const proof = await pw.w.stepUp(pw.w.viewer);
    const first = await authorize(d.packageId, [d.artifacts[0]!.object_id], { key, proof });
    granted(first);
    const after = await footprint(d.packageId);
    const replay = await authorize(d.packageId, [d.artifacts[0]!.object_id], { key, proof });
    assert.equal(replay.text, replayTextOf(first), "the replay is the first answer byte for byte");
    const again = await footprint(d.packageId);
    assert.deepEqual([again.authorizations, again.authorized, again.events, again.committed], [after.authorizations, after.authorized, after.events, after.committed]);
    // two keys are two authorizations
    granted(await authorize(d.packageId, [d.artifacts[0]!.object_id]));
    assert.equal(await pw.w.count("download_authorizations", "package_version_id = $1", [d.packageId]), 2);
  }
});

test("CMD038-RACE (TIMEOUT): the signer times out after COMMIT: the authorization is recorded ISSUE_UNCERTAIN and answered 503 SIGNING_UNCERTAIN; the same key re-signs the same scope at the same expiry, never a broader one", async () => {
  const d = await available("cmd038-timeout");
  const key = freshKey("cmd038-timeout");
  pw.w.signer.script("TIMEOUT");
  assert.equal(answer(await authorize(d.packageId, [d.artifacts[0]!.object_id], { key })), "503 CAPACITY_UNAVAILABLE SIGNING_UNCERTAIN");
  const rows = await pw.w.h.oracle.query<{ authorization_id: string; sign_state: string }>("SELECT authorization_id, sign_state FROM kauro.download_authorizations WHERE package_version_id = $1", [d.packageId]);
  assert.deepEqual(rows.rows.map((r) => r.sign_state), ["ISSUE_UNCERTAIN"]);
  const stored = await authorizationRow(rows.rows[0]!.authorization_id);
  const x = granted(await authorize(d.packageId, [d.artifacts[0]!.object_id], { key }));
  assert.equal(x.replayed, true);
  assert.deepEqual([x.data.authorizationId, Date.parse(x.data.expiresAt), x.data.artifacts.map((a) => a.artifactId)], [rows.rows[0]!.authorization_id, msOf(usOf(stored.expires_us)), [d.artifacts[0]!.object_id]]);
  assert.equal((await authorizationRow(rows.rows[0]!.authorization_id)).sign_state, "SIGNED");
});

test("CMD038 EXPIRY: the retention effective deadline crossed during the issuance's wait on the record is refused RETENTION_EXPIRED (judged at effect_now after the lock), nothing written", async () => {
  const d = await available("cmd038-expiry");
  // a minute ahead: the stood clock stays inside the step-up proof's freshness window (900 s), so only the deadline decides
  const deadline = await placeDeadline(d.retentionId, "now() + interval '1 minute'");
  const before = await footprint(d.packageId);
  const startMs = msOf(deadline) - 1_500;
  const holder = await superTx();
  let reply: Promise<Reply> | null = null;
  let how: "COMMIT" | "ROLLBACK" = "ROLLBACK";
  try {
    await holder.query("SELECT retention_id FROM kauro.retention_records WHERE retention_id = $1 FOR UPDATE", [d.retentionId]);
    stand = isoOf(startMs);
    reply = authorize(d.packageId, [d.artifacts[0]!.object_id]);
    const pid = await waitsOn(reply, "retention_records", "the issuance");
    let ranMs = 0;
    for (let i = 0; i < 100 && ranMs <= 2_500; i++) {
      ranMs = Number((await pw.w.h.oracle.query<{ ms: string }>("SELECT floor(extract(epoch FROM clock_timestamp() - xact_start) * 1000)::text AS ms FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0]?.ms ?? 0);
      if (ranMs <= 2_500) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(startMs + ranMs > msOf(deadline), "the lock wait crossed the deadline");
    how = "COMMIT";
  } finally {
    stand = null;
    await end(holder, how);
  }
  assert.equal(answer(await reply), "409 PRECONDITION_FAILED RETENTION_EXPIRED");
  assert.deepEqual(await footprint(d.packageId), before);
});

test("CMD038 PARTIAL: one artifact of three deleted or quarantined refuses the whole request; nothing is issued or signed", async () => {
  const d = await available("cmd038-partial", 3);
  await markObject(d.artifacts[2]!.object_id, "DELETION_REQUESTED");
  const before = await footprint(d.packageId);
  assert.equal(answer(await authorize(d.packageId, d.artifacts.map((a) => a.object_id))), "409 PRECONDITION_FAILED ARTIFACT_UNAVAILABLE");
  assert.deepEqual(await footprint(d.packageId), before, "no authorization, no artifact row, no event, no journal entry, no signature");
  // the two live artifacts alone are authorized
  assert.equal(granted(await authorize(d.packageId, [d.artifacts[0]!.object_id, d.artifacts[1]!.object_id])).data.artifacts.length, 2);
});

// --- REVOCATION (R2-048) ----------------------------------------------------------------------------------------------------------------

test("R2-048: after a role change no new URL; an issued URL keeps its disclosed residual lifetime", async () => {
  const { w } = pw;
  const p = await activePerson(w, "r2-048-member", "OPERATOR");
  const d = await available("r2-048");
  // an issued URL before the change
  const issued = granted(await authorize(d.packageId, [d.artifacts[0]!.object_id], { person: p.person })).data;
  // the role changes between authorize (COMMIT) and sign: the grant is held after its COMMIT, the owner changes the role, no URL is signed
  const key = freshKey("r2-048-between");
  const signed = w.signer.calls.length;
  const hold = w.holds.arm("after.commit");
  const reply = authorize(d.packageId, [d.artifacts[1]!.object_id], { person: p.person, key });
  await reached(hold, reply, "the authorization");
  const m = await membershipOf(p.person);
  const changed = await call(w, { url: routes.changeMembership(m.membership_id), token: w.owner.token, key: freshKey("r2-048-role"), body: { assuranceProofRef: await w.stepUp(w.owner), expectedVersion: Number(m.version), role: "VIEWER" } });
  assert.equal(changed.status, 200, answer(changed));
  hold.release();
  assert.equal(answer(await reply), "403 NOT_AUTHORIZED MEMBERSHIP_CHANGED");
  assert.equal(w.signer.calls.length, signed, "no URL was signed after the role change");
  // the replay of the same key signs nothing either
  assert.equal(answer(await authorize(d.packageId, [d.artifacts[1]!.object_id], { person: p.person, key })), "403 NOT_AUTHORIZED MEMBERSHIP_CHANGED");
  assert.equal(w.signer.calls.length, signed);
  // the URL issued before the change keeps exactly its disclosed residual lifetime: valid until expiresAt, no provider revocation promised
  assert.equal(issued.providerRevocation, "UNAVAILABLE");
  assert.equal(w.signer.verify(issued.artifacts[0]!.url, { userId: p.person.userId, atMs: Date.parse(issued.expiresAt) - 1 }), "VALID");
  assert.equal(w.signer.verify(issued.artifacts[0]!.url, { userId: p.person.userId, atMs: Date.parse(issued.expiresAt) + 1 }), "EXPIRED");
  // a suspension stops new grants immediately
  await suspendMember(w, m.membership_id);
  assert.equal(answer(await authorize(d.packageId, [d.artifacts[0]!.object_id], { person: p.person })), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  assert.equal(w.signer.calls.length, signed);
});

test("CMD038 DENY (forged): a request session cannot insert an authorization for a package that is not AVAILABLE or longer than 900 s (KA094)", async () => {
  const d = await available("cmd038-forged");
  const m = await membershipOf(pw.w.viewer);
  const c = await pw.w.h.appPool.connectUnverified();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [pw.w.A.agencyId, pw.w.viewer.userId]);
    await assert.rejects(
      c.query(
        `INSERT INTO kauro.download_authorizations (authorization_id, agency_id, project_id, package_version_id, membership_id, membership_version, user_id, issued_at, expires_at, artifact_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, kauro.server_now(), kauro.server_now() + interval '1 hour', 1)`,
        [ids.next(), pw.w.A.agencyId, d.projectId, d.packageId, m.membership_id, Number(m.version), pw.w.viewer.userId],
      ),
      (e: { code?: string }) => e.code === "KA094",
    );
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
});
