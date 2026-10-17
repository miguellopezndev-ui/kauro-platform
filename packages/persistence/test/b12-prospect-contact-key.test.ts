// Migration 0094 (order 4, independent review finding F2; owner decision of 2026-10-17, option A): the business contact's key on the prospect.
// Against a real PostgreSQL 17: the backfill of a cluster at 0093 (and its safe failure on a prospect whose contact cannot be found), the key derived at
// birth and never supplied, the database's own constraints behind the trigger, immutability for every role, the effective suppression every reader of
// the prospect derives from it (the registrar, the seller it is assigned to, the owner) without reading the contact, and the privileges and policies the
// migration leaves exactly as they were.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { MIGRATIONS_DIR, PgSalesRepository, applyMigrations, listMigrations } from "../src/index.js";
import { refusedWith } from "./b10-commission-support.js";
import { closeB12, ids, openB12, ownerOf, personOf, prospectIn, sha, freshDomain, suppressionIn, at, type B12World, type Seller } from "./b12-outreach-support.js";
import { within } from "./commerce-support.js";

const TARGET = "b12_prospect_contact_key";
const COLUMN = "business_contact_key";

let w: B12World;
before(async () => {
  w = await openB12("contact-key");
});
after(async () => {
  await closeB12(w);
});

interface Owned {
  readonly prospectId: string;
  readonly contactId: string | null;
  readonly contactKey: string | null;
}

/** A prospect the owner registers in its own session (prospects_register: owned by nobody, or by the seller it names), with its own contact or none. */
async function ownerProspect(world: B12World, owner: Seller | null, options: { readonly contact?: boolean } = {}): Promise<Owned> {
  const domain = freshDomain("owner-registered");
  const prospectId = ids.next();
  const contactId = options.contact === false ? null : ids.next();
  const contactKey = contactId === null ? null : sha(`KAURO_PROSPECT_CONTACT_V1\noperations@${domain}`);
  const evidenceHash = sha(`source-evidence-${prospectId}`);
  await within(world.app, ownerOf(world), async (c) => {
    await c.query(
      "INSERT INTO kauro.prospect_source_evidence (evidence_id, recorded_by_user_id, seller_id, evidence_hash, source_url_digest, observed_on, lawful_basis, segment, created_at) VALUES ($1, $2, NULL, $3, $4, current_date, 'LEGITIMATE_INTEREST', 'AGENCY', now())",
      [ids.next(), world.kora, evidenceHash, sha(`https://${domain}/`)],
    );
    if (contactId !== null) {
      await c.query("INSERT INTO kauro.prospect_contacts (contact_id, recorded_by_user_id, contact_key, contact_label, role_label, channel, created_at) VALUES ($1, $2, $3, 'Operations lead', 'Head of operations', 'EMAIL', now())", [contactId, world.kora, contactKey]);
    }
    await c.query(
      `INSERT INTO kauro.prospects (prospect_id, organization_label, organization_key, business_contact_id, source_evidence_hash, jurisdiction, registered_by_user_id, registered_by_seller_id, owner_seller_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'United States', $6, NULL, $7, now(), now())`,
      [prospectId, `${domain} agency`, sha(`organization:${domain}`), contactId, evidenceHash, world.kora, owner?.sellerId ?? null],
    );
  });
  return { prospectId, contactId, contactKey };
}

const storedKey = async (world: B12World, prospectId: string): Promise<string | null> =>
  (await world.h.oracle.query<{ k: string | null }>(`SELECT ${COLUMN} AS k FROM kauro.prospects WHERE prospect_id = $1`, [prospectId])).rows[0]!.k;

/** The prospect as the person's own session reads it through the product's reader (null: the session may not read it). */
const shownTo = async (world: B12World, userId: string, prospectId: string): Promise<{ state: string; suppressed: boolean; version: number; owner: string | null } | null> =>
  at(world.app, userId === world.kora ? ownerOf(world) : personOf(userId), world.base, async (c) => {
    const p = await new PgSalesRepository(c, ids).getProspect(prospectId as never);
    return p === null ? null : { state: p.state, suppressed: p.suppressed, version: p.version, owner: p.ownerSellerId ?? null };
  });

/** A raw INSERT of a prospect of the seller's own evidence and contact, with the columns given (the forgeries of the integrity cells). */
async function sellerInsert(c: Client, seller: Seller, contactId: string | null, key: string | null, evidenceHash: string): Promise<void> {
  const domain = freshDomain("forged");
  await c.query(
    `INSERT INTO kauro.prospects (prospect_id, organization_label, organization_key, business_contact_id, ${COLUMN}, source_evidence_hash, jurisdiction, registered_by_user_id, registered_by_seller_id, owner_seller_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'United States', $7, $8, $8, now(), now())`,
    [ids.next(), `${domain} agency`, sha(`organization:${domain}`), contactId, key, evidenceHash, seller.userId, seller.sellerId],
  );
}

/** A further contact and source evidence of the seller (its own rows), for the forgeries. */
async function sellerContact(world: B12World, seller: Seller): Promise<{ contactId: string; contactKey: string; evidenceHash: string }> {
  const domain = freshDomain("own-contact");
  const contactId = ids.next();
  const contactKey = sha(`KAURO_PROSPECT_CONTACT_V1\noperations@${domain}`);
  const evidenceHash = sha(`source-evidence-${contactId}`);
  await within(world.app, personOf(seller.userId), async (c) => {
    await c.query(
      "INSERT INTO kauro.prospect_source_evidence (evidence_id, recorded_by_user_id, seller_id, evidence_hash, source_url_digest, observed_on, lawful_basis, segment, created_at) VALUES ($1, $2, $3, $4, $5, current_date, 'LEGITIMATE_INTEREST', 'AGENCY', now())",
      [ids.next(), seller.userId, seller.sellerId, evidenceHash, sha(`https://${domain}/`)],
    );
    await c.query("INSERT INTO kauro.prospect_contacts (contact_id, recorded_by_user_id, contact_key, contact_label, role_label, channel, created_at) VALUES ($1, $2, $3, 'Operations lead', 'Head of operations', 'EMAIL', now())", [contactId, seller.userId, contactKey]);
  });
  return { contactId, contactKey, evidenceHash };
}

test("0094 backfill: on a cluster at 0093, a prospect whose business contact cannot be found fails the migration with its id and changes nothing; once it is gone every prospect gets its own contact's key (none without a contact), with no version step, no updated_at, no transition row, and FORCE RLS and every trigger restored", async () => {
  const all = listMigrations(MIGRATIONS_DIR);
  const target = all.find((m) => m.name === TARGET);
  assert.ok(target, "0094 is the contact-key migration");
  const pos = all.indexOf(target);
  const dir = mkdtempSync(join(tmpdir(), "kauro-0094-"));
  try {
    for (const m of all.slice(0, pos)) copyFileSync(join(MIGRATIONS_DIR, m.file), join(dir, m.file));
    const old = await openB12("contact-key-backfill", { migrationsDir: dir });
    try {
      const column = async (): Promise<number> =>
        (await old.h.oracle.query<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'kauro' AND table_name = 'prospects' AND column_name = $1", [COLUMN])).rows[0]!.n;
      assert.equal(await column(), 0, "the cluster is at 0093");
      // existing data: a seller's prospect, an owner's prospect assigned to a seller, an owner's prospect without a contact
      const bySeller = await prospectIn(old, old.s, freshDomain("backfill-seller"));
      const assigned = await ownerProspect(old, old.s2);
      const bare = await ownerProspect(old, null, { contact: false });
      const facts = async (): Promise<unknown> =>
        (
          await old.h.oracle.query(
            `SELECT p.prospect_id::text AS id, p.version::int AS version, p.updated_at::text AS updated, (SELECT count(*)::int FROM kauro.commercial_transitions t WHERE t.subject_id = p.prospect_id) AS transitions
               FROM kauro.prospects p WHERE p.prospect_id = ANY($1::uuid[]) ORDER BY p.prospect_id`,
            [[bySeller.prospectId, assigned.prospectId, bare.prospectId]],
          )
        ).rows;
      const before = await facts();
      // a historical inconsistency the foreign keys would refuse today: a prospect naming a contact nobody recorded (written with the triggers off)
      const orphan = ids.next();
      const orphanContact = ids.next();
      await old.h.oracle.query("BEGIN");
      await old.h.oracle.query("SET LOCAL session_replication_role = replica");
      await old.h.oracle.query(
        `INSERT INTO kauro.prospects (prospect_id, organization_label, organization_key, business_contact_id, source_evidence_hash, jurisdiction, registered_by_user_id, registered_by_seller_id, owner_seller_id, created_at, updated_at)
         VALUES ($1, 'orphan agency', $2, $3, $4, 'United States', $5, NULL, NULL, now(), now())`,
        [orphan, sha(`organization:orphan-${orphan}`), orphanContact, sha(`orphan-evidence-${orphan}`), old.kora],
      );
      await old.h.oracle.query("COMMIT");
      for (const m of all.slice(pos)) copyFileSync(join(MIGRATIONS_DIR, m.file), join(dir, m.file));
      const apply = async (): Promise<ReadonlyArray<string>> => {
        const owner = await old.h.pg.connect("kauro_owner");
        try {
          return (await applyMigrations(owner, { dir })).applied.map((m) => m.file);
        } finally {
          await owner.end();
        }
      };
      await assert.rejects(apply(), (e: unknown) => {
        const message = String((e as Error).message);
        return message.includes(`migration ${target.file} failed`) && message.includes("PROSPECT_CONTACT_KEY_BACKFILL: 1 prospect(s)") && message.includes(orphan);
      }, "the migration fails and names the prospect it could not backfill");
      assert.equal(await column(), 0, "nothing of 0094 remains: no column");
      assert.deepEqual((await old.h.oracle.query("SELECT version FROM kauro_meta.schema_migrations WHERE version = $1", [target.version])).rows, [], "0094 is not recorded");
      assert.deepEqual(await facts(), before, "no prospect changed");
      const guarded = async (): Promise<unknown> =>
        (
          await old.h.oracle.query(
            `SELECT c.relname AS rel, c.relforcerowsecurity AS forced,
                    (SELECT array_agg(t.tgname::text || ':' || t.tgenabled::text ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS triggers
               FROM pg_class c WHERE c.oid IN ('kauro.prospects'::regclass, 'kauro.prospect_contacts'::regclass) ORDER BY c.relname`,
          )
        ).rows as Array<{ rel: string; forced: boolean; triggers: string[] }>;
      const failed = (await guarded()) as Array<{ rel: string; forced: boolean; triggers: string[] }>;
      assert.deepEqual(failed.map((r) => [r.rel, r.forced]), [["prospect_contacts", true], ["prospects", true]], "FORCE ROW LEVEL SECURITY is as it was");
      assert.ok(failed.every((r) => r.triggers.every((t) => t.endsWith(":O"))), `every trigger is enabled: ${JSON.stringify(failed)}`);

      // the operator removes the inconsistency; the migration then applies
      await old.h.oracle.query("BEGIN");
      await old.h.oracle.query("SET LOCAL session_replication_role = replica");
      await old.h.oracle.query("DELETE FROM kauro.prospects WHERE prospect_id = $1", [orphan]);
      await old.h.oracle.query("COMMIT");
      assert.deepEqual(await apply(), all.slice(pos).map((m) => m.file));
      assert.equal(await storedKey(old, bySeller.prospectId), bySeller.contactKey, "the seller's prospect carries its contact's key");
      assert.equal(await storedKey(old, assigned.prospectId), assigned.contactKey, "the owner's assigned prospect carries its contact's key");
      assert.equal(await storedKey(old, bare.prospectId), null, "a prospect without a contact carries none");
      assert.deepEqual(await facts(), before, "no version step, no updated_at, no transition row");
      const done = (await guarded()) as Array<{ rel: string; forced: boolean; triggers: string[] }>;
      assert.deepEqual(done.map((r) => [r.rel, r.forced]), [["prospect_contacts", true], ["prospects", true]], "FORCE ROW LEVEL SECURITY restored");
      assert.ok(done.every((r) => r.triggers.every((t) => t.endsWith(":O"))), `every trigger is enabled: ${JSON.stringify(done)}`);
      assert.ok(done.find((r) => r.rel === "prospects")!.triggers.includes("prospects_contact_key_immutable:O"), "the key is immutable from now on");
      // the backfilled key reaches the readers: a CONTACT suppression shows the assigned prospect suppressed to its seller, who cannot read the contact
      await at(old.app, ownerOf(old), old.base, (c) => suppressionIn(c, old.kora, "CONTACT", assigned.contactKey!, "REFUSAL"));
      assert.deepEqual((await shownTo(old, old.s2.userId, assigned.prospectId))?.state, "SUPPRESSED", "the assigned seller's reader derives the exclusion from the backfilled key");
    } finally {
      await closeB12(old);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("0094 derived at birth: a seller's and the owner's registrations carry exactly their own contact's key, copied by the database; a prospect without a contact carries none", async () => {
  const bySeller = await prospectIn(w, w.s, freshDomain("born-seller"));
  assert.equal(await storedKey(w, bySeller.prospectId), bySeller.contactKey);
  const byOwner = await ownerProspect(w, w.s);
  assert.equal(await storedKey(w, byOwner.prospectId), byOwner.contactKey);
  const bare = await ownerProspect(w, null, { contact: false });
  assert.equal(await storedKey(w, bare.prospectId), null);
  // the product's own writer (CMD045's registerProspect) names no key: the database copies it
  const own = await sellerContact(w, w.s);
  const domain = freshDomain("born-product");
  const prospectId = ids.next();
  await within(w.app, personOf(w.s.userId), (c) =>
    new PgSalesRepository(c, ids).registerProspect({
      prospectId: prospectId as never,
      organizationLabel: `${domain} agency`,
      organizationKey: sha(`organization:${domain}`) as never,
      businessContactRef: own.contactId as never,
      sourceEvidenceHash: own.evidenceHash as never,
      jurisdiction: "United States",
      ownerSellerId: w.s.sellerId as never,
      registeredByUserId: w.s.userId as never,
      createdAt: w.base as never,
    }),
  );
  assert.equal(await storedKey(w, prospectId), own.contactKey, "CMD045's writer: the contact's key, copied by the database");
});

test("0094 never supplied: a key sent with the INSERT is refused whatever it is — a forged one, the contact's true key, a key without a contact (prospects_contact_key_derived)", async () => {
  const own = await sellerContact(w, w.s);
  const refused = refusedWith("23514", "prospects_contact_key_derived");
  await assert.rejects(within(w.app, personOf(w.s.userId), (c) => sellerInsert(c, w.s, own.contactId, sha("forged"), own.evidenceHash)), refused, "a forged key");
  await assert.rejects(within(w.app, personOf(w.s.userId), (c) => sellerInsert(c, w.s, own.contactId, own.contactKey, own.evidenceHash)), refused, "even the contact's true key");
  await assert.rejects(within(w.app, personOf(w.s.userId), (c) => sellerInsert(c, w.s, null, own.contactKey, own.evidenceHash)), refused, "a key without a contact");
  // and the owner alike
  await assert.rejects(
    within(w.app, ownerOf(w), (c) =>
      c.query(
        `INSERT INTO kauro.prospects (prospect_id, organization_label, organization_key, business_contact_id, ${COLUMN}, source_evidence_hash, jurisdiction, registered_by_user_id, registered_by_seller_id, owner_seller_id, created_at, updated_at)
         SELECT $1, 'owner forged agency', $2, NULL, $3, $4, 'United States', $5, NULL, NULL, now(), now()`,
        [ids.next(), sha(`organization:owner-forged-${ids.next()}`), sha("forged"), own.evidenceHash, w.kora],
      ),
    ),
    refused,
    "the owner's forged key",
  );
});

test("0094 the database's own constraints behind the trigger: with the derivation trigger switched off, a forged key, another contact's key of the same registrar and a contact without its key are each refused by a constraint (prospects_contact_key_fk, prospects_contact_key_present)", async () => {
  const one = await sellerContact(w, w.s);
  const two = await sellerContact(w, w.s);
  const oracle = w.h.oracle;
  const forge = async (contactId: string | null, key: string | null): Promise<void> => {
    await oracle.query("BEGIN");
    try {
      await oracle.query("ALTER TABLE kauro.prospects DISABLE TRIGGER prospects_business_contact_key");
      await sellerInsert(oracle, w.s, contactId, key, one.evidenceHash);
    } finally {
      await oracle.query("ROLLBACK");
    }
  };
  await assert.rejects(forge(one.contactId, sha("forged")), refusedWith("23503", "prospects_contact_key_fk"), "a forged key");
  await assert.rejects(forge(one.contactId, two.contactKey), refusedWith("23503", "prospects_contact_key_fk"), "the key of another contact of the same registrar");
  await assert.rejects(forge(one.contactId, null), refusedWith("23514", "prospects_contact_key_present"), "a contact without its key");
  await assert.rejects(forge(null, one.contactKey), refusedWith("23514", "prospects_contact_key_present"), "a key without a contact");
  assert.equal(
    (await oracle.query<{ e: string }>("SELECT tgenabled::text AS e FROM pg_trigger WHERE tgrelid = 'kauro.prospects'::regclass AND tgname = 'prospects_business_contact_key'")).rows[0]!.e,
    "O",
    "the trigger is on again",
  );
});

test("0094 immutable: no runtime role may update the key (42501: no column grant names it), and even a session with every privilege is refused by the guard (KA004), like business_contact_id", async () => {
  const p = await ownerProspect(w, w.s);
  const other = sha("another key");
  await assert.rejects(within(w.app, personOf(w.s.userId), (c) => c.query(`UPDATE kauro.prospects SET ${COLUMN} = $2, version = version + 1 WHERE prospect_id = $1`, [p.prospectId, other])), refusedWith("42501"), "the assigned seller");
  await assert.rejects(within(w.app, ownerOf(w), (c) => c.query(`UPDATE kauro.prospects SET ${COLUMN} = $2, version = version + 1 WHERE prospect_id = $1`, [p.prospectId, other])), refusedWith("42501"), "the owner");
  await assert.rejects(within(w.outreach, {}, (c) => c.query(`UPDATE kauro.prospects SET ${COLUMN} = $2 WHERE prospect_id = $1`, [p.prospectId, other])), refusedWith("42501"), "the outreach service");
  const oracle = w.h.oracle;
  for (const value of [other, null]) {
    await oracle.query("BEGIN");
    try {
      await assert.rejects(oracle.query(`UPDATE kauro.prospects SET ${COLUMN} = $2, version = version + 1 WHERE prospect_id = $1`, [p.prospectId, value]), refusedWith("KA004"), `the superuser setting it to ${value === null ? "NULL" : "another key"}`);
    } finally {
      await oracle.query("ROLLBACK");
    }
  }
  assert.equal(await storedKey(w, p.prospectId), p.contactKey, "the key is the contact's still");
});

test("0094 derivation and isolation: a prospect the owner registered and assigned to a seller — who reads none of its contact — is shown suppressed to that seller and to the owner once the contact key is suppressed, follows a reassignment, and stays unreadable to the other seller; the stored row moves not", async () => {
  const p = await ownerProspect(w, w.s);
  const asSeller = (seller: Seller, sql: string, params: ReadonlyArray<unknown>) => at(w.app, personOf(seller.userId), w.base, async (c) => (await c.query(sql, [...params])).rows);
  assert.deepEqual(await asSeller(w.s, "SELECT contact_id FROM kauro.prospect_contacts WHERE contact_id = $1 OR contact_key = $2", [p.contactId, p.contactKey]), [], "the assigned seller reads no row of the owner's contact");
  assert.equal((await shownTo(w, w.s.userId, p.prospectId))?.state, "RESEARCHED");
  assert.equal(await shownTo(w, w.s2.userId, p.prospectId), null, "the other seller reads not the prospect");
  const stored = (await w.h.oracle.query("SELECT state, suppressed, version::int AS version FROM kauro.prospects WHERE prospect_id = $1", [p.prospectId])).rows[0];
  await at(w.app, ownerOf(w), w.base, (c) => suppressionIn(c, w.kora, "CONTACT", p.contactKey!, "REFUSAL"));
  assert.deepEqual(await shownTo(w, w.s.userId, p.prospectId), { state: "SUPPRESSED", suppressed: true, version: (stored as { version: number }).version, owner: w.s.sellerId }, "the assigned seller is shown it suppressed");
  assert.deepEqual((await shownTo(w, w.kora, p.prospectId))?.state, "SUPPRESSED", "the owner too");
  assert.equal(await shownTo(w, w.s2.userId, p.prospectId), null, "the other seller still reads nothing");
  assert.deepEqual((await w.h.oracle.query("SELECT state, suppressed, version::int AS version FROM kauro.prospects WHERE prospect_id = $1", [p.prospectId])).rows[0], stored, "the stored row moved not");
  await within(w.app, ownerOf(w), (c) => c.query("UPDATE kauro.prospects SET owner_seller_id = $2, version = version + 1 WHERE prospect_id = $1", [p.prospectId, w.s2.sellerId]));
  assert.deepEqual([(await shownTo(w, w.s2.userId, p.prospectId))?.state, (await shownTo(w, w.s2.userId, p.prospectId))?.owner], ["SUPPRESSED", w.s2.sellerId], "the next seller is shown it suppressed at once");
  assert.equal(await shownTo(w, w.s.userId, p.prospectId), null, "the previous seller reads it no more");
  // a seller's own prospect of another contact is untouched by the suppression
  const unrelated = await prospectIn(w, w.s, freshDomain("unrelated"));
  assert.equal((await shownTo(w, w.s.userId, unrelated.prospectId))?.state, "RESEARCHED");
});

test("0094 boundary: no runtime role holds UPDATE on the key; kauro_outreach keeps SELECT only on prospects and on prospect_contacts; the contact policies are the ones 0029/0088/0089 wrote; no SECURITY DEFINER routine is added and the new trigger function is no definer and not PUBLIC's", async () => {
  const oracle = w.h.oracle;
  const updaters = await oracle.query<{ role: string }>(
    `SELECT r.rolname AS role FROM pg_roles r WHERE r.rolname LIKE 'kauro\\_%' AND r.rolname <> 'kauro_owner' AND has_column_privilege(r.oid, 'kauro.prospects'::regclass, $1, 'UPDATE') ORDER BY 1`,
    [COLUMN],
  );
  assert.deepEqual(updaters.rows, [], "no runtime role may update the key");
  const privileges = async (table: string): Promise<string[]> =>
    (
      await oracle.query<{ p: string }>(
        "SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege('kauro_outreach', $1::regclass, p) OR (p IN ('SELECT','INSERT','UPDATE','REFERENCES') AND has_any_column_privilege('kauro_outreach', $1::regclass, p)) ORDER BY p",
        [table],
      )
    ).rows.map((r) => r.p);
  assert.deepEqual(await privileges("kauro.prospects"), ["SELECT"], "kauro_outreach: SELECT on prospects, nothing more");
  assert.deepEqual(await privileges("kauro.prospect_contacts"), ["SELECT"], "kauro_outreach: SELECT on prospect_contacts, nothing more");
  const policies = await oracle.query<{ name: string; cmd: string; roles: string[]; qual: string | null }>(
    "SELECT policyname AS name, cmd, roles::text[] AS roles, qual FROM pg_policies WHERE schemaname = 'kauro' AND tablename = 'prospect_contacts' ORDER BY policyname",
  );
  assert.deepEqual(
    policies.rows.map((r) => [r.name, r.cmd, r.roles]),
    [
      ["prospect_contacts_outreach_read", "SELECT", ["kauro_outreach"]],
      ["prospect_contacts_owner_read", "SELECT", ["kauro_app"]],
      ["prospect_contacts_record", "INSERT", ["kauro_app"]],
      ["prospect_contacts_self_read", "SELECT", ["kauro_app"]],
    ],
  );
  assert.match(policies.rows.find((r) => r.name === "prospect_contacts_self_read")!.qual ?? "", /recorded_by_user_id = kauro\.current_user_id\(\)/, "a seller reads only the contacts it recorded");
  const definers = await oracle.query<{ fn: string }>("SELECT p.proname AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'kauro' AND p.prosecdef ORDER BY p.proname");
  assert.deepEqual(definers.rows.map((r) => r.fn), ["bank_owner_authority", "payment_session_fence", "register_bank_payment_route", "route_provider_available_cents"]);
  const fn = await oracle.query<{ definer: boolean; public: boolean }>(
    "SELECT p.prosecdef AS definer, has_function_privilege('public', p.oid, 'EXECUTE') AS public FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'kauro' AND p.proname = 'prospects_business_contact_key'",
  );
  assert.deepEqual(fn.rows, [{ definer: false, public: false }]);
});
