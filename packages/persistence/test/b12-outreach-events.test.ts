// B12's send-intent event on real PostgreSQL 17 (migration 0072, lane K1b; plan docs/design/B12-outreach-plan.md rev 4 §1 CMD063: "One
// COMMIT: intent QUEUED + draft AUTHORIZED + event outreach.send_intended.v1 + outbox"; 07 "one event per committed version").
//
// The aggregate kind outreach_send_intent is the first registered with agency_scoped = false: its table (outreach_send_intents) must NOT
// carry agency_id (B12's static gate: kauro_outreach holds no grant on an agency_id table), so the registry, the event binding and the
// event-per-version rule accept an explicitly agency-less kind and refuse any agency on it. Every write is performed as the role that
// would perform it (the seller's session, kauro_app_test); the migration owner (kauro_owner) registers kinds; the superuser oracle only
// reads, except where a test plays an adversary inside a transaction it rolls back.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Client } from "pg";
import { AGGREGATE_KINDS, EVENT_TYPES, UNSCOPED_AGGREGATE_KINDS, type UserId } from "@kauro/domain";
import { at, closeB12, draft, freshDomain, grant, ids, nextSlot, openB12, personCtx, personOf, plus, prospectIn, queue, queueIn, sendIntendedIn, sender, type B12World, type Draft, type Sender } from "./b12-outreach-support.js";
import { sqlState } from "./support.js";

let w: B12World;
let snd: Sender;
let owner: Client;
let agencyId: string;

before(async () => {
  w = await openB12("b12-events");
  snd = await sender(w, w.s.userId);
  owner = await w.h.pg.connect("kauro_owner");
  // an agency with its own events (the contrast: an agency aggregate's events keep the agency rule)
  agencyId = (await w.h.createAgency((await w.h.person("alice-b12-events")) as UserId, "K1b agency")).agencyId;
});
after(async () => {
  await owner.end();
  await closeB12(w);
});

async function granted(): Promise<{ d: Draft; authorizationId: string; slot: string }> {
  const slot = await nextSlot(w);
  const p = await prospectIn(w, w.s, freshDomain("events"));
  const d = await draft(w, snd, p);
  const g = await grant(w, snd, [d], slot);
  return { d, authorizationId: g.authorizationId, slot };
}

const refusedWith = (code: string) => (e: unknown): boolean => sqlState(e) === code;

/** Runs `probe` under a savepoint of the caller's open transaction and expects the SQLSTATE `code`; the transaction stays usable. */
async function refusedIn(c: Client, probe: () => Promise<unknown>, code: string, message: string): Promise<void> {
  await c.query("SAVEPOINT probe");
  try {
    await assert.rejects(probe(), refusedWith(code), message);
  } finally {
    await c.query("ROLLBACK TO SAVEPOINT probe");
  }
}

/** A seller-session transaction at the TEST CLOCK instant that queues an intent WITHOUT its event, then runs `fn` with it. */
async function bareIntent<T>(instant: string, fn: (c: Client, intent: Awaited<ReturnType<typeof queueIn>>) => Promise<T>): Promise<T | undefined> {
  const { d, authorizationId } = await granted();
  let out: T | undefined;
  await assert.rejects(
    at(w.app, personCtx(w, d.personUserId), instant, async (c) => {
      const intent = await queueIn(c, d, authorizationId, { noEvent: true });
      out = await fn(c, intent);
      throw new Error("ROLLBACK-THE-PROBE");
    }),
    /ROLLBACK-THE-PROBE/,
  );
  return out;
}

describe("B12 K1b: the agency-less aggregate kind (registry, binding, event-per-version)", () => {
  test("registry: outreach_send_intent is registered agency_scoped = false and every other kind true; the domain mirror agrees", async () => {
    const r = await w.h.oracle.query<{ aggregate_kind: string; table_name: string; id_column: string; owner_package: string; agency_scoped: boolean }>(
      "SELECT aggregate_kind, table_name, id_column, owner_package, agency_scoped FROM kauro.aggregate_kinds WHERE aggregate_kind = 'outreach_send_intent' OR NOT agency_scoped ORDER BY 1",
    );
    assert.deepEqual(r.rows, [{ aggregate_kind: "outreach_send_intent", table_name: "outreach_send_intents", id_column: "intent_id", owner_package: "B12", agency_scoped: false }]);
    assert.deepEqual(r.rows.map((x) => x.aggregate_kind), [...UNSCOPED_AGGREGATE_KINDS]);
    const all = await w.h.oracle.query<{ aggregate_kind: string }>("SELECT aggregate_kind FROM kauro.aggregate_kinds ORDER BY 1");
    assert.deepEqual(all.rows.map((x) => x.aggregate_kind).sort(), [...AGGREGATE_KINDS].sort());
    const types = await w.h.oracle.query<{ event_type: string }>("SELECT event_type FROM kauro.event_types WHERE event_type = 'outreach.send_intended.v1'");
    assert.equal(types.rowCount, 1);
    assert.ok((EVENT_TYPES as ReadonlyArray<string>).includes("outreach.send_intended.v1"));
  });

  test("registry validation: agency_scoped = true needs the agency_id uuid column, agency_scoped = false refuses a table that has one; either needs the version bigint", async () => {
    await owner.query("BEGIN");
    try {
      await owner.query("CREATE TABLE kauro.k1b_probe (probe_id uuid PRIMARY KEY, version bigint NOT NULL)");
      await owner.query("CREATE TABLE kauro.k1b_probe_scoped (probe_id uuid PRIMARY KEY, agency_id uuid, version bigint NOT NULL)");
      await owner.query("CREATE TABLE kauro.k1b_probe_noversion (probe_id uuid PRIMARY KEY)");
      const reg = (kind: string, table: string, scoped: boolean) =>
        owner.query("INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package, agency_scoped) VALUES ($1, $2, 'probe_id', 'B12', $3)", [kind, table, scoped]);
      // a scoped kind over a table without agency_id: refused (the old rule, unchanged)
      await refusedIn(owner, () => reg("k1b_a", "k1b_probe", true), "23514", "agency_scoped = true over a table lacking agency_id");
      // an unscoped kind over a table that carries agency_id: refused (the table would be both)
      await refusedIn(owner, () => reg("k1b_b", "k1b_probe_scoped", false), "23514", "agency_scoped = false over a table that has agency_id");
      // the version column is required either way
      await refusedIn(owner, () => reg("k1b_c", "k1b_probe_noversion", false), "23514", "agency_scoped = false over a table lacking version");
      // the two legitimate registrations still commit
      await reg("k1b_d", "k1b_probe", false);
      await reg("k1b_e", "k1b_probe_scoped", true);
      const seen = await owner.query<{ aggregate_kind: string; agency_scoped: boolean }>("SELECT aggregate_kind, agency_scoped FROM kauro.aggregate_kinds WHERE aggregate_kind LIKE 'k1b\\_%' ORDER BY 1");
      assert.deepEqual(seen.rows, [{ aggregate_kind: "k1b_d", agency_scoped: false }, { aggregate_kind: "k1b_e", agency_scoped: true }]);
    } finally {
      await owner.query("ROLLBACK");
    }
  });

  test("birth: CMD063's one commit carries the intent at version 1, its agency-less event and its OUTREACH_SENDER outbox record", async () => {
    const { d, authorizationId, slot } = await granted();
    const i = await at(w.app, personCtx(w, d.personUserId), plus(slot, 2), (c) => queueIn(c, d, authorizationId));
    const e = await w.h.oracle.query(
      `SELECT e.agency_id, e.aggregate_kind, e.aggregate_version::int AS version, e.event_type, e.actor_kind, o.consumer, o.state
         FROM kauro.domain_events e JOIN kauro.outbox_records o ON o.event_id = e.event_id WHERE e.aggregate_id = $1`,
      [i.intentId],
    );
    assert.deepEqual(e.rows, [{ agency_id: null, aggregate_kind: "outreach_send_intent", version: 1, event_type: "outreach.send_intended.v1", actor_kind: "USER", consumer: "OUTREACH_SENDER", state: "PENDING" }]);
    const v = await w.h.oracle.query("SELECT version::int AS version FROM kauro.outreach_send_intents WHERE intent_id = $1", [i.intentId]);
    assert.deepEqual(v.rows, [{ version: 1 }]);
    const cols = await w.h.oracle.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'kauro' AND table_name = 'outreach_send_intents' AND column_name = 'agency_id'");
    assert.equal(cols.rowCount, 0, "the outreach table gains no agency_id");
  });

  test("event-per-version (KA003): an intent that commits without its event is refused at COMMIT, and rolled back whole", async () => {
    const { d, authorizationId, slot } = await granted();
    const intentId = ids.next();
    await assert.rejects(
      at(w.app, personCtx(w, d.personUserId), plus(slot, 2), (c) => queueIn(c, d, authorizationId, { intentId, noEvent: true })),
      refusedWith("KA003"),
    );
    const left = await w.h.oracle.query("SELECT 1 FROM kauro.outreach_send_intents WHERE intent_id = $1", [intentId]);
    assert.equal(left.rowCount, 0);
  });

  test("binding (KA006): an event of an agency-less kind naming an agency is refused like an unknown aggregate, whoever writes it", async () => {
    const { d, authorizationId, slot } = await granted();
    const i = await queue(w, d, authorizationId, plus(slot, 2));
    // the oracle (RLS-exempt) isolates the trigger from the policies: it is the binding that refuses
    await w.h.oracle.query("BEGIN");
    try {
      await refusedIn(w.h.oracle, () => sendIntendedIn(w.h.oracle, i, { agencyId, version: 1, noOutbox: true }), "KA006", "an event naming an agency, written by the oracle");
    } finally {
      await w.h.oracle.query("ROLLBACK");
    }
    await at(w.app, personCtx(w, d.personUserId), plus(slot, 3), async (c) => {
      await refusedIn(c, () => sendIntendedIn(c, i, { agencyId, version: 1, noOutbox: true }), "KA006", "the seller's own event naming an agency");
    });
  });

  test("binding (KA006): an unknown intent id and an unregistered kind are refused; an event ahead of the intent's version is KA002", async () => {
    await bareIntent(plus(await nextSlot(w), 2), async (c, intent) => {
      await refusedIn(c, () => sendIntendedIn(c, intent, { aggregateId: ids.next(), noOutbox: true }), "KA006", "unknown aggregate id");
      await refusedIn(c, () => sendIntendedIn(c, intent, { kind: "outreach_nothing", noOutbox: true }), "KA006", "unregistered kind");
      await refusedIn(c, () => sendIntendedIn(c, intent, { version: 2, noOutbox: true }), "KA002", "ahead of the aggregate");
      // the legitimate event still commits-side: version 1 is accepted
      await sendIntendedIn(c, intent, { noOutbox: true });
    });
  });

  test("binding: an agency kind keeps its rule: agency A's aggregate named under agency B stays KA006", async () => {
    const other = (await w.h.createAgency((await w.h.person("bob-b12-events")) as UserId, "K1b other agency")).agencyId;
    await w.h.oracle.query("BEGIN");
    try {
      await refusedIn(
        w.h.oracle,
        () =>
          w.h.oracle.query(
            `INSERT INTO kauro.domain_events (event_id, aggregate_kind, aggregate_id, aggregate_version, agency_id, event_type, actor_kind, actor_id, causation_id, correlation_id, payload, payload_hash, schema_version, created_at)
             VALUES ($1, 'agency', $2, 1, $3, 'agency.created.v1', 'SYSTEM', NULL, $4, $5, '{}', $6, '1', now())`,
            [ids.next(), agencyId, other, ids.next(), ids.next(), "0".repeat(64)],
          ),
        "KA006",
        "agency A's aggregate named under agency B",
      );
    } finally {
      await w.h.oracle.query("ROLLBACK");
    }
  });
});

describe("B12 K1b: who may write and read the event and its outbox record (RLS)", () => {
  test("the binding refuses a person or an agency session that cannot see the intent (KA006) and the policy refuses a wrong event type (42501); the seller's own commit is the legitimate write beside them", async () => {
    const outsider = (await w.h.person("outsider-b12-events")) as UserId;
    const { d, authorizationId, slot } = await granted();
    const i = await queue(w, d, authorizationId, plus(slot, 2));
    // a person who is neither the intent's person nor its owner does not see the aggregate: the binding refuses it first
    await at(w.app, personOf(outsider), plus(slot, 3), async (c) => {
      await refusedIn(c, () => sendIntendedIn(c, i, { version: 1, noOutbox: true }), "KA006", "a person who cannot see the intent");
    });
    // an agency-bound session is no sender of an agency-less event either
    await at(w.app, { userId: outsider, agencyId }, plus(slot, 3), async (c) => {
      await refusedIn(c, () => sendIntendedIn(c, i, { version: 1, noOutbox: true }), "KA006", "an agency session");
    });
    // the intent's own seller reaches the policy: only outreach.send_intended.v1 of the kind is admitted
    await at(w.app, personCtx(w, d.personUserId), plus(slot, 3), async (c) => {
      await refusedIn(c, () => sendIntendedIn(c, i, { eventType: "agency.created.v1", version: 1, noOutbox: true }), "42501", "another event type");
    });
  });

  test("outbox: only OUTREACH_SENDER, only for an agency-less outreach event; an agency event's record and another consumer are refused", async () => {
    await bareIntent(plus(await nextSlot(w), 2), async (c, intent) => {
      await refusedIn(c, () => sendIntendedIn(c, intent, { consumer: "NOTIFICATIONS" }), "42501", "another consumer");
      const eventId = await sendIntendedIn(c, intent, { noOutbox: true });
      // a record for an event of another kind (an agency event) is no outreach record
      const other = await w.h.oracle.query<{ event_id: string }>("SELECT event_id FROM kauro.domain_events WHERE agency_id = $1 LIMIT 1", [agencyId]);
      assert.equal(other.rowCount, 1, "the agency has an event");
      const record = (event: string) =>
        c.query("INSERT INTO kauro.outbox_records (outbox_id, event_id, consumer, state, attempts, next_attempt_at, created_at, updated_at) VALUES ($1, $2, 'OUTREACH_SENDER', 'PENDING', 0, now(), now(), now())", [ids.next(), event]);
      await refusedIn(c, () => record(other.rows[0]!.event_id), "42501", "a record of an agency event");
      await record(eventId);
    });
  });

  test("reads: the seller's session sees none of these events or records (the agency-less rows are the control plane's), kauro_control dispatches them, kauro_outreach holds no privilege on either table", async () => {
    const { d, authorizationId, slot } = await granted();
    const i = await at(w.app, personCtx(w, d.personUserId), plus(slot, 2), (c) => queueIn(c, d, authorizationId));
    await at(w.app, personCtx(w, d.personUserId), plus(slot, 3), async (c) => {
      assert.equal((await c.query("SELECT 1 FROM kauro.domain_events WHERE aggregate_kind = 'outreach_send_intent'")).rowCount, 0, "events");
      assert.equal((await c.query("SELECT 1 FROM kauro.outbox_records WHERE consumer = 'OUTREACH_SENDER'")).rowCount, 0, "records");
    });
    const ctl = await w.control.query("SELECT e.event_id FROM kauro.domain_events e JOIN kauro.outbox_records o ON o.event_id = e.event_id WHERE e.aggregate_id = $1 AND o.consumer = 'OUTREACH_SENDER'", [i.intentId]);
    assert.equal(ctl.rowCount, 1, "the control plane dispatches the record");
    // the outreach service holds no grant on a table with agency_id (A17: domain_events has one); it reads no outbox either
    const g = await w.h.oracle.query("SELECT t, p FROM unnest(ARRAY['kauro.domain_events', 'kauro.outbox_records']) t, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) p WHERE has_table_privilege('kauro_outreach', t, p)");
    assert.deepEqual(g.rows, []);
  });

  test("outreach_event(event_id): STABLE SECURITY DEFINER with a pinned search_path, owned by the migration owner, executable by kauro_app alone; true for this kind only", async () => {
    const { d, authorizationId, slot } = await granted();
    const i = await at(w.app, personCtx(w, d.personUserId), plus(slot, 2), (c) => queueIn(c, d, authorizationId));
    const f = await w.h.oracle.query<{ sig: string; secdef: boolean; volatile: string; owner: string; config: string[] | null; runtime: string[]; public_exec: boolean }>(
      `SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS secdef, p.provolatile AS volatile, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
              ARRAY(SELECT g FROM unnest(ARRAY['kauro_app','kauro_control','kauro_assurance','kauro_validator','kauro_ingress','kauro_payment','kauro_commission','kauro_outreach']) g
                     WHERE has_function_privilege(g, p.oid, 'EXECUTE') ORDER BY g) AS runtime,
              EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec
         FROM pg_proc p WHERE p.oid = 'kauro.outreach_event(uuid)'::regprocedure`,
    );
    assert.deepEqual(f.rows, [{ sig: "kauro.outreach_event(uuid)", secdef: true, volatile: "s", owner: "kauro_owner", config: ["search_path=pg_catalog, pg_temp"], runtime: ["kauro_app"], public_exec: false }]);
    const ev = await w.h.oracle.query<{ event_id: string }>("SELECT event_id FROM kauro.domain_events WHERE aggregate_id = $1", [i.intentId]);
    const agencyEvent = await w.h.oracle.query<{ event_id: string }>("SELECT event_id FROM kauro.domain_events WHERE agency_id = $1 LIMIT 1", [agencyId]);
    const answers = await w.h.oracle.query("SELECT kauro.outreach_event($1) AS yes, kauro.outreach_event($2) AS agency, kauro.outreach_event($3) AS unknown", [ev.rows[0]!.event_id, agencyEvent.rows[0]!.event_id, ids.next()]);
    assert.deepEqual(answers.rows, [{ yes: true, agency: false, unknown: false }]);
  });
});
