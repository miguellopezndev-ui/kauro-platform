// O23A migration 0150 on real PostgreSQL 17: the authentication boundary ends every session of one person (recovery, credential change),
// keeps the acting one for "sign out everywhere", never sees or ends another person's, and without the person-wide declaration it still
// sees only the session it presents. Other roles gain nothing.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import type { Sha256Hex } from "@kauro/contracts";
import { identityUserId, toUtcInstant, type CorrelationId, type UserId } from "@kauro/domain";
import { createPool, PgWebSessionStore, type KauroPool } from "@kauro/persistence";
import { startTemporaryPostgres, testDatabaseEnvironment, type TemporaryPostgres } from "@kauro/persistence/testing";
import { PgPersonSessionRevoker } from "../../src/identity/pg-person-revoker.js";

let pg: TemporaryPostgres;
let app: Client;
let assurance: Client;
let pool: KauroPool;
let store: PgWebSessionStore;
let revoker: PgPersonSessionRevoker;

before(async () => {
  pg = await startTemporaryPostgres();
  app = await pg.connect("kauro_app_test");
  assurance = await pg.connect("kauro_assurance_test");
  pool = createPool({ environment: testDatabaseEnvironment("LOCAL"), host: "127.0.0.1", port: pg.port, database: "kauro", user: "kauro_assurance_test", max: 2, applicationName: "o23a-person-revoker-test" });
  store = new PgWebSessionStore(pool);
  revoker = new PgPersonSessionRevoker(pool);
});
after(async () => {
  await app?.end();
  await assurance?.end();
  await pool?.end();
  await pg?.stop();
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => toUtcInstant(Date.now());
let seq = 0;
const subjects = new Map<string, string>();

async function person(): Promise<UserId> {
  const subject = `o23a-${++seq}-${randomUUID()}`;
  const userId = identityUserId("identity-platform", subject) as UserId;
  await app.query("BEGIN");
  await app.query("SELECT set_config('kauro.user_id', $1, true)", [userId]);
  await app.query(
    `INSERT INTO kauro.identities (user_id, provider, subject_hash, email_verified_at, mfa_enrolled_at, created_at, updated_at)
     VALUES ($1, 'identity-platform', $2, now(), now(), now(), now())`,
    [userId, sha(subject)],
  );
  await app.query("COMMIT");
  subjects.set(userId, subject);
  return userId;
}

async function session(userId: UserId): Promise<Sha256Hex> {
  const subject = subjects.get(userId) as string;
  const hash = sha(`secret-${randomUUID()}`) as Sha256Hex;
  const at = Date.now();
  await store.open(
    { sessionId: uuidV7(), userId, provider: "identity-platform", subjectHash: sha(subject) as Sha256Hex, emailVerifiedAt: toUtcInstant(at), mfaAt: toUtcInstant(at), createdAt: toUtcInstant(at), lastSeenAt: toUtcInstant(at), idleExpiresAt: toUtcInstant(at + 1_800_000), absoluteExpiresAt: toUtcInstant(at + 43_200_000) },
    hash,
    randomUUID() as CorrelationId,
  );
  return hash;
}

function uuidV7(): string {
  const ms = Date.now().toString(16).padStart(12, "0");
  const r = randomUUID().replace(/-/g, "");
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${r.slice(13, 16)}-8${r.slice(17, 20)}-${r.slice(20, 32)}`;
}

const live = async (hash: Sha256Hex) => {
  const r = await store.resume(hash, now, 1_800, 60);
  return r !== null && r.revokedAt === null;
};

test("a recovery ends every live session of the person and none of anyone else's", async () => {
  const ana = await person();
  const ben = await person();
  const [a1, a2, b1] = [await session(ana), await session(ana), await session(ben)];
  assert.equal(await revoker.revokeAllOf(ana, now, "RECOVERY"), 2);
  assert.equal(await live(a1), false);
  assert.equal(await live(a2), false);
  assert.equal(await live(b1), true, "another person's session is untouched");
  assert.equal(await revoker.revokeAllOf(ana, now, "RECOVERY"), 0, "an ended session is never changed again");
  const reasons = await pg.connect("postgres").then(async (su) => {
    try {
      return (await su.query<{ revoke_reason: string }>("SELECT revoke_reason FROM kauro.web_sessions WHERE user_id = $1", [ana])).rows.map((r) => r.revoke_reason);
    } finally {
      await su.end();
    }
  });
  assert.deepEqual(reasons, ["RECOVERY", "RECOVERY"]);
});

test("sign out everywhere keeps the acting session; only that reason may keep one", async () => {
  const ana = await person();
  const [here, there] = [await session(ana), await session(ana)];
  await assert.rejects(revoker.revokeAllOf(ana, now, "RECOVERY", here), RangeError);
  assert.equal(await revoker.revokeAllOf(ana, now, "SIGN_OUT_EVERYWHERE", here), 1);
  assert.equal(await live(here), true);
  assert.equal(await live(there), false);
});

test("without the person-wide declaration the boundary still sees only the session it presents; a forged reason or a non-ending update is refused", async () => {
  const ana = await person();
  const [s1] = [await session(ana), await session(ana)];
  await assurance.query("BEGIN");
  try {
    await assurance.query("SELECT set_config('kauro.user_id', $1, true), set_config('kauro.session_sha256', $2, true)", [ana, s1]);
    const seen = await assurance.query("SELECT session_id FROM kauro.web_sessions WHERE user_id = $1", [ana]);
    assert.equal(seen.rowCount, 1, "only the presented session");
  } finally {
    await assurance.query("ROLLBACK");
  }
  await assurance.query("BEGIN");
  try {
    await assurance.query("SELECT set_config('kauro.user_id', $1, true), set_config('kauro.person_revocation', 'on', true)", [ana]);
    assert.equal((await assurance.query("SELECT session_id FROM kauro.web_sessions")).rowCount, 2, "the person's sessions, nobody else's");
    await assert.rejects(assurance.query("UPDATE kauro.web_sessions SET revoked_at = now(), revoke_reason = 'LOGOUT' WHERE user_id = $1", [ana]), (e: { code?: string }) => e.code === "42501", "a reason that is not person-wide");
  } finally {
    await assurance.query("ROLLBACK");
  }
  await assurance.query("BEGIN");
  try {
    await assurance.query("SELECT set_config('kauro.user_id', $1, true), set_config('kauro.person_revocation', 'on', true)", [ana]);
    await assert.rejects(assurance.query("UPDATE kauro.web_sessions SET last_seen_at = now() WHERE user_id = $1", [ana]), (e: { code?: string }) => e.code === "42501", "a person-wide transaction may only end sessions");
  } finally {
    await assurance.query("ROLLBACK");
  }
  for (const role of ["kauro_app_test"] as const) {
    const c = await pg.connect(role);
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('kauro.user_id', $1, true), set_config('kauro.person_revocation', 'on', true)", [ana]);
      const seen = await c.query("SELECT session_id FROM kauro.web_sessions").then((r) => r.rowCount, (e: { code?: string }) => e.code);
      assert.ok(seen === 0 || seen === "42501", `${role} gains nothing from the declaration (${String(seen)})`);
      await c.query("ROLLBACK");
    } finally {
      await c.end();
    }
  }
});
