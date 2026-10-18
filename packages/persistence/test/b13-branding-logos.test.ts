// Migration 0096 (order 7, CMD008; docs/design/B13-branding.md): the agency's stored logos and the logo a branding version names, on a
// real PostgreSQL 17 through the runtime login roles.
//   1. From the schema before it: a cluster at 0095 holding branding versions is migrated; no version changes, none names a logo, no
//      logo is invented, and agency.branding_versioned.v1 is registered.
//   2. The stored logos: written by the agency's ACTIVE OWNER or ADMIN as itself, once per content; content-addressed, a PNG of the
//      recorded size, at most 512 KiB, or refused whoever writes; append-only for every role; read by the agency and the control plane
//      bound to it only — another agency's logo is invisible.
//   3. A branding version names one of its own agency's logos or none: another agency's logo is refused by the composite foreign key
//      even when the request handlers name it directly; a version, once recorded, never changes its logo.
// Every image is synthetic (written by @kauro/domain's encoder). The superuser connection is the oracle, and the writer of nothing but
// the deliberate superuser probes of the append-only guards.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Client } from "pg";
import { admitLogo, encodePng, isDomainFailure, LOGO_MAX_BYTES, type AdmittedLogo, type AgencyId, type MembershipId, type UserId } from "@kauro/domain";
import { MIGRATIONS_DIR, applyMigrations, listMigrations, reportSourcesOf } from "../src/index.js";
import { agencyWith, closeWorld, openWorld, type Agency, type World } from "./b10-commission-support.js";
import { ids, sqlState } from "./support.js";

const TARGET = "0096_b13_branding_logos.sql";
let w: World | null = null;
let dir: string | null = null;
let A: Agency;
let B: Agency;

after(async () => {
  if (w !== null) await closeWorld(w);
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
});

const world = (): World => {
  assert.ok(w !== null, "the world of the first test");
  return w;
};

/** Runs `fn` on `c` in one transaction with the agency (or none) and the person bound, as a unit of work binds them. */
async function bound<T>(c: Client, agencyId: string | null, userId: string | null, fn: () => Promise<T>): Promise<T> {
  await c.query("BEGIN");
  try {
    await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [agencyId ?? "", userId ?? ""]);
    const out = await fn();
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}

/** A synthetic logo the pipeline admits: a w x h gradient with the seed in its red channel. */
function syntheticLogo(seed: number, width = 24, height = 12): AdmittedLogo {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) px.set([seed & 0xff, (x * 10) & 0xff, (y * 20) & 0xff, 255], (y * width + x) * 4);
  const admitted = admitLogo(encodePng(width, height, px));
  assert.ok(admitted.ok);
  return admitted.logo;
}

const storeAs = (agency: Agency, userId: UserId, membershipId: string, logo: AdmittedLogo, logoId = ids.next()) =>
  world().h.app.run(world().h.tenant(agency.agencyId as AgencyId, userId), (uow) =>
    reportSourcesOf(uow).brandingVersions.recordLogo({ agencyId: agency.agencyId as AgencyId, logoId, recordedByMembershipId: membershipId as MembershipId, bytes: logo.bytes, sha256: logo.sha256, width: logo.width, height: logo.height }),
  );

test("0096 from 0095: the branding versions already recorded are unchanged and name no logo; no logo is invented; agency.branding_versioned.v1 is registered", async () => {
  const all = listMigrations(MIGRATIONS_DIR);
  const target = all.find((m) => m.file === TARGET);
  assert.ok(target, "0096 is the branding logos migration");
  const pos = all.indexOf(target);
  dir = mkdtempSync(join(tmpdir(), "kauro-0096-"));
  for (const m of all.slice(0, pos)) copyFileSync(join(MIGRATIONS_DIR, m.file), join(dir, m.file));
  w = await openWorld("b13-logos", { migrationsDir: dir });
  const x = world();
  A = await agencyWith(x, "Logos Alpha");
  B = await agencyWith(x, "Logos Bravo");
  const exists = async (name: string): Promise<boolean> => (await x.h.oracle.query<{ r: string | null }>("SELECT to_regclass($1)::text AS r", [name])).rows[0]?.r !== null;
  assert.equal(await exists("kauro.agency_branding_logos"), false, "the cluster is at 0095");
  // two versions recorded as 0095 admitted them (no logo column yet), by the owner as itself
  for (const [n, name] of [[1, "Logos Alpha"], [2, "Logos Alpha Studio"]] as const) {
    await bound(x.app, A.agencyId, A.ownerUserId, () =>
      x.app.query("INSERT INTO kauro.agency_branding_versions (agency_id, branding_version, display_name, recorded_by_membership_id, recorded_by_user_id) VALUES ($1, $2, $3, $4, $5)", [A.agencyId, n, name, A.ownerMembershipId, A.ownerUserId]),
    );
  }
  const columns = "agency_id, branding_version, display_name, recorded_by_membership_id, recorded_by_user_id, recorded_at";
  const before = (await x.h.oracle.query(`SELECT ${columns} FROM kauro.agency_branding_versions ORDER BY agency_id, branding_version`)).rows;
  copyFileSync(join(MIGRATIONS_DIR, target.file), join(dir, target.file));
  const owner = await x.h.pg.connect("kauro_owner");
  try {
    assert.deepEqual((await applyMigrations(owner, { dir })).applied.map((m) => m.file), [TARGET]);
    assert.deepEqual((await applyMigrations(owner, { dir })).applied, [], "applied once");
    for (const m of all.slice(pos + 1)) copyFileSync(join(MIGRATIONS_DIR, m.file), join(dir, m.file));
    assert.deepEqual((await applyMigrations(owner, { dir })).applied.map((m) => m.file), all.slice(pos + 1).map((m) => m.file));
  } finally {
    await owner.end();
  }
  assert.deepEqual((await x.h.oracle.query(`SELECT ${columns} FROM kauro.agency_branding_versions ORDER BY agency_id, branding_version`)).rows, before, "no version changed");
  assert.deepEqual((await x.h.oracle.query("SELECT logo_id FROM kauro.agency_branding_versions")).rows, [{ logo_id: null }, { logo_id: null }], "none names a logo");
  assert.equal((await x.h.oracle.query("SELECT 1 FROM kauro.agency_branding_logos")).rowCount, 0, "no logo is invented");
  assert.equal((await x.h.oracle.query("SELECT 1 FROM kauro.event_types WHERE event_type = 'agency.branding_versioned.v1'")).rowCount, 1);
  const versions = await x.h.app.run(x.h.tenant(A.agencyId as AgencyId, A.ownerUserId), (uow) => reportSourcesOf(uow).brandingVersions.versionsOf(A.agencyId as AgencyId));
  assert.deepEqual(versions.map((v) => [v.version, v.displayName, v.logo]), [[1, "Logos Alpha", null], [2, "Logos Alpha Studio", null]]);
});

test("stored logos: the agency's OWNER or ADMIN stores the pipeline's PNG as itself, once per content; another role, another person's membership and another agency are refused", async () => {
  const x = world();
  const logo = syntheticLogo(1);
  const first = await storeAs(A, A.ownerUserId, A.ownerMembershipId, logo);
  assert.equal(first.created, true);
  assert.deepEqual([first.logo.agencyId, first.logo.sha256, first.logo.mediaType, first.logo.width, first.logo.height, first.logo.byteLength], [A.agencyId, logo.sha256, "image/png", 24, 12, logo.bytes.byteLength]);
  // the same image again, under another minted id: the logo already stored, nothing new
  const again = await storeAs(A, A.ownerUserId, A.ownerMembershipId, logo);
  assert.deepEqual([again.created, again.logo.logoId], [false, first.logo.logoId]);
  const bytes = await x.h.app.run(x.h.tenant(A.agencyId as AgencyId, A.ownerUserId), (uow) => reportSourcesOf(uow).brandingVersions.logoBytesOf(A.agencyId as AgencyId, first.logo.logoId));
  assert.deepEqual(Buffer.from(bytes ?? []), Buffer.from(logo.bytes), "the stored bytes are the pipeline's");
  // an ADMIN stores as itself; an OPERATOR, a VIEWER, an APPROVER and a BILLING member cannot
  const admin = await x.h.person("logos-alpha-admin");
  const adminMembership = await x.h.addMember(A, admin, "ADMIN");
  assert.equal((await storeAs(A, admin, adminMembership, syntheticLogo(2))).created, true);
  for (const role of ["OPERATOR", "VIEWER", "APPROVER", "BILLING"] as const) {
    const person = await x.h.person(`logos-alpha-${role.toLowerCase()}`);
    const membership = await x.h.addMember(A, person, role);
    await assert.rejects(storeAs(A, person, membership, syntheticLogo(3)), (e: unknown) => isDomainFailure(e), role);
  }
  // another person's membership, and another agency's owner writing into this agency, are refused
  await assert.rejects(storeAs(A, A.ownerUserId, adminMembership, syntheticLogo(4)), (e: unknown) => isDomainFailure(e));
  await assert.rejects(
    x.h.app.run(x.h.tenant(B.agencyId as AgencyId, B.ownerUserId), (uow) =>
      reportSourcesOf(uow).brandingVersions.recordLogo({ agencyId: A.agencyId as AgencyId, logoId: ids.next(), recordedByMembershipId: B.ownerMembershipId as MembershipId, bytes: logo.bytes, sha256: logo.sha256, width: 24, height: 12 }),
    ),
    (e: unknown) => isDomainFailure(e),
  );
  // the same image is another agency's own logo, stored for it apart
  const forB = await storeAs(B, B.ownerUserId, B.ownerMembershipId, logo);
  assert.equal(forB.created, true);
  assert.notEqual(forB.logo.logoId, first.logo.logoId);
});

test("stored logos: the database admits only a content-addressed PNG of the recorded size, at most 512 KiB, whoever writes; append-only for every role", async () => {
  const x = world();
  const raw = (fields: { readonly sha?: string; readonly media?: string; readonly width?: number; readonly height?: number; readonly content: Buffer }) =>
    bound(x.app, A.agencyId, A.ownerUserId, () =>
      x.app.query(
        "INSERT INTO kauro.agency_branding_logos (agency_id, logo_id, logo_sha256, media_type, width, height, content, recorded_by_membership_id, recorded_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [A.agencyId, ids.next(), fields.sha ?? createHash("sha256").update(fields.content).digest("hex"), fields.media ?? "image/png", fields.width ?? 24, fields.height ?? 12, fields.content, A.ownerMembershipId, A.ownerUserId],
      ),
    );
  const png = Buffer.from(syntheticLogo(9).bytes);
  await assert.rejects(raw({ content: png, sha: "a".repeat(64) }), (e: unknown) => sqlState(e) === "23514", "a hash that is not the content's");
  await assert.rejects(raw({ content: png, width: 25 }), (e: unknown) => sqlState(e) === "23514", "a width the PNG does not state");
  await assert.rejects(raw({ content: png, height: 11 }), (e: unknown) => sqlState(e) === "23514", "a height the PNG does not state");
  await assert.rejects(raw({ content: png, media: "image/svg+xml" }), (e: unknown) => sqlState(e) === "23514", "another media type");
  await assert.rejects(raw({ content: png, media: "image/jpeg" }), (e: unknown) => sqlState(e) === "23514", "JPEG is not stored by this pipeline");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>fetch("https://evil.test")</script>' + " ".repeat(64) + "</svg>");
  await assert.rejects(raw({ content: svg }), (e: unknown) => sqlState(e) === "23514", "an SVG under its own hash");
  await assert.rejects(raw({ content: Buffer.concat([png, Buffer.alloc(LOGO_MAX_BYTES)]) }), (e: unknown) => sqlState(e) === "23514", "larger than 512 KiB");
  await assert.rejects(raw({ content: png, width: 4096 }), (e: unknown) => sqlState(e) === "23514", "more than 2048 pixels a side");
  // append-only: the request handlers cannot rewrite or remove a logo; the guard refuses the superuser too
  await assert.rejects(bound(x.app, A.agencyId, A.ownerUserId, () => x.app.query("UPDATE kauro.agency_branding_logos SET width = width")), (e: unknown) => sqlState(e) === "42501");
  await assert.rejects(bound(x.app, A.agencyId, A.ownerUserId, () => x.app.query("DELETE FROM kauro.agency_branding_logos")), (e: unknown) => sqlState(e) === "42501");
  await assert.rejects(x.h.oracle.query("UPDATE kauro.agency_branding_logos SET content = content"), (e: unknown) => sqlState(e) === "KA004");
  await assert.rejects(x.h.oracle.query("DELETE FROM kauro.agency_branding_logos"), (e: unknown) => sqlState(e) === "KA004");
  await assert.rejects(x.h.oracle.query("TRUNCATE kauro.agency_branding_logos CASCADE"), (e: unknown) => sqlState(e) === "KA004");
  // the control plane only reads
  await assert.rejects(bound(x.control, A.agencyId, null, () => x.control.query("INSERT INTO kauro.agency_branding_logos (agency_id) VALUES ($1)", [A.agencyId])), (e: unknown) => sqlState(e) === "42501");
});

test("isolation: a logo is read by its agency and the control plane bound to it only; a branding version names one of its own agency's logos or none — another agency's is refused by the foreign key, whatever the request handlers write", async () => {
  const x = world();
  const mine = await storeAs(A, A.ownerUserId, A.ownerMembershipId, syntheticLogo(20));
  const theirs = await storeAs(B, B.ownerUserId, B.ownerMembershipId, syntheticLogo(21));
  const logosAs = async (c: Client, agencyId: string | null, userId: string | null): Promise<string[]> =>
    bound(c, agencyId, userId, async () => (await c.query<{ id: string }>("SELECT logo_id AS id FROM kauro.agency_branding_logos WHERE logo_id = ANY($1::uuid[]) ORDER BY 1", [[mine.logo.logoId, theirs.logo.logoId]])).rows.map((r) => r.id));
  assert.deepEqual(await logosAs(x.app, A.agencyId, A.ownerUserId), [mine.logo.logoId]);
  assert.deepEqual(await logosAs(x.control, A.agencyId, null), [mine.logo.logoId]);
  assert.deepEqual(await logosAs(x.app, B.agencyId, B.ownerUserId), [theirs.logo.logoId]);
  assert.deepEqual(await logosAs(x.control, null, null), [], "the unbound control plane reads none");
  const asA = <T>(fn: (r: ReturnType<typeof reportSourcesOf>["brandingVersions"]) => Promise<T>) => x.h.app.run(x.h.tenant(A.agencyId as AgencyId, A.ownerUserId), (uow) => fn(reportSourcesOf(uow).brandingVersions));
  assert.equal(await asA((r) => r.logoOf(A.agencyId as AgencyId, theirs.logo.logoId)), null, "another agency's logo is not one of A's");
  assert.equal(await asA((r) => r.logoBytesOf(A.agencyId as AgencyId, theirs.logo.logoId)), null);
  assert.equal(await asA((r) => r.logoOf(B.agencyId as AgencyId, theirs.logo.logoId)), null, "nor readable by naming B");
  // a version naming its own agency's logo
  const latest = await asA((r) => r.latestOf(A.agencyId as AgencyId));
  const next = (latest?.version ?? 0) + 1;
  const recorded = await asA((r) => r.record({ agencyId: A.agencyId as AgencyId, recordedByMembershipId: A.ownerMembershipId as MembershipId, displayName: "Logos Alpha Branded", version: next, logoId: mine.logo.logoId }));
  assert.deepEqual([recorded.version, recorded.logo?.logoId, recorded.logo?.sha256], [next, mine.logo.logoId, mine.logo.sha256]);
  assert.deepEqual((await asA((r) => r.latestOf(A.agencyId as AgencyId)))?.logo?.logoId, mine.logo.logoId);
  // another agency's logo: refused by the composite foreign key, through the repository and a direct insert alike
  await assert.rejects(asA((r) => r.record({ agencyId: A.agencyId as AgencyId, recordedByMembershipId: A.ownerMembershipId as MembershipId, displayName: "Borrowed Logo", version: next + 1, logoId: theirs.logo.logoId })), (e: unknown) => isDomainFailure(e));
  await assert.rejects(
    bound(x.app, A.agencyId, A.ownerUserId, () =>
      x.app.query("INSERT INTO kauro.agency_branding_versions (agency_id, branding_version, display_name, recorded_by_membership_id, recorded_by_user_id, logo_id) VALUES ($1, $2, 'Borrowed Logo', $3, $4, $5)", [A.agencyId, next + 1, A.ownerMembershipId, A.ownerUserId, theirs.logo.logoId]),
    ),
    (e: unknown) => sqlState(e) === "23503",
  );
  // a version never changes its logo, not even for the superuser
  await assert.rejects(bound(x.app, A.agencyId, A.ownerUserId, () => x.app.query("UPDATE kauro.agency_branding_versions SET logo_id = NULL")), (e: unknown) => sqlState(e) === "42501");
  await assert.rejects(x.h.oracle.query("UPDATE kauro.agency_branding_versions SET logo_id = NULL"), (e: unknown) => sqlState(e) === "KA004");
});
