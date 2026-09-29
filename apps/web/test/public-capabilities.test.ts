// UI03 and UI08 publish what the capability publication lists (D-TOPO-2: the public origin reads only public data, server-side and
// uncached). These tests hold the four promises that make that safe to say in public:
//   - the reply is read strictly: anything that is not exactly the published shape is "cannot be read", never a guess;
//   - a mode is available only if the publication lists it, and CLEAN's sentence names only the modes the publication lists as qualified;
//   - when the publication cannot be read (no origin, refused, malformed, redirected, too large, too slow) the pages say so in words
//     that claim neither "running" nor "stopped";
//   - the read sends no credential and does not follow a redirect.
// The api is a local HTTP server that answers the shape of GET /api/v1/public/capability-publication: CONTRACT_FAKE, the contract
// being packages/application/src/api/response-schemas.ts of the api package (W5b). No provider and no database is involved.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PUBLICATION_PATH,
  UNAVAILABLE,
  availabilityOf,
  cleanQualifiesId,
  formatInstant,
  parsePublication,
  publishedModes,
  type Publication,
} from "../src/public/capabilities.ts";
import { PUBLIC_COPY } from "../src/copy/public.ts";
import { publicationUrl } from "../src/server/public-origins.ts";
import { readPublication } from "../src/server/publication-reader.ts";
import { closedOrigin, withServer, type Answer } from "./support/local-api.ts";

const ID = "0192d3a4-5b6c-7d8e-9f01-23456789abcd";

function entry(mode: string, state = "AVAILABLE", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { capabilityId: ID, mode, version: "2026.10.0", state, validFrom: "2026-10-01T15:00:00.000Z", ...extra };
}

function reply(...capabilities: Record<string, unknown>[]): Record<string, unknown> {
  return { observedAt: "2026-10-02T09:30:45.123Z", capabilities };
}

function modes(publication: Publication): string[] {
  return publication.kind === "READ" ? publication.modes.map((entry) => entry.mode) : [];
}

test("a publication in the published shape is read, ordered by mode, with its instant", () => {
  const read = parsePublication(reply(entry("SALESFORCE", "AVAILABLE_LIMITED"), entry("CLEAN"), entry("HUBSPOT")));
  assert.equal(read.kind, "READ");
  assert.deepEqual(modes(read), ["CLEAN", "HUBSPOT", "SALESFORCE"]);
  assert.equal(read.kind === "READ" && read.observedAt, "2026-10-02T09:30:45.123Z");
  assert.equal(parsePublication(reply()).kind, "READ", "a publication that lists nothing is a reading, not a failure");
  assert.deepEqual(modes(parsePublication(reply())), []);
});

test("anything that is not exactly the published shape is unreadable, never partially believed", () => {
  const bad: unknown[] = [
    null,
    "text",
    [],
    {},
    { observedAt: "2026-10-02T09:30:45Z" },
    { capabilities: [] },
    { ...reply(entry("CLEAN")), extra: 1 },
    { ...reply(entry("CLEAN")), observedAt: "yesterday" },
    { ...reply(entry("CLEAN")), observedAt: "2026-10-02T09:30:45+02:00" },
    { ...reply(entry("CLEAN")), observedAt: "2026-13-45T09:30:45Z" },
    reply(entry("CLEAN"), entry("CLEAN")),
    reply(entry("DESIGN")),
    reply(entry("CLEAN", "PLANNED")),
    reply(entry("CLEAN", "QUALIFIED")),
    reply(entry("CLEAN", "AVAILABLE", { validFrom: "soon" })),
    reply(entry("CLEAN", "AVAILABLE", { version: "" })),
    reply(entry("CLEAN", "AVAILABLE", { version: "1\u0000" })),
    reply(entry("CLEAN", "AVAILABLE", { version: "v".repeat(201) })),
    reply(entry("CLEAN", "AVAILABLE", { unexpected: true })),
    reply(entry("CLEAN"), entry("HUBSPOT"), entry("SALESFORCE"), entry("CLEAN")),
    { observedAt: "2026-10-02T09:30:45Z", capabilities: "CLEAN" },
    { observedAt: "2026-10-02T09:30:45Z", capabilities: [null] },
    { observedAt: "2026-10-02T09:30:45Z", capabilities: [{ mode: "CLEAN" }] },
  ];
  for (const value of bad) assert.deepEqual(parsePublication(value), UNAVAILABLE, JSON.stringify(value));
});

test("a mode is available only when the publication lists it, and a publication that cannot be read makes no statement", () => {
  const read = parsePublication(reply(entry("CLEAN", "AVAILABLE_LIMITED"), entry("HUBSPOT")));
  assert.equal(availabilityOf(read, "CLEAN"), "LIMITED");
  assert.equal(availabilityOf(read, "HUBSPOT"), "AVAILABLE");
  assert.equal(availabilityOf(read, "SALESFORCE"), "CLOSED");
  for (const mode of ["CLEAN", "HUBSPOT", "SALESFORCE"] as const) assert.equal(availabilityOf(UNAVAILABLE, mode), "UNREAD");
  assert.deepEqual(publishedModes(read).map((entry) => entry.mode), ["CLEAN", "HUBSPOT"]);
  assert.deepEqual(publishedModes(UNAVAILABLE), []);
});

test("CLEAN's sentence names as qualified only the destinations the publication lists", () => {
  const cases: ReadonlyArray<readonly [Publication, string]> = [
    [parsePublication(reply(entry("CLEAN"), entry("HUBSPOT"), entry("SALESFORCE"))), "services.clean.qualifies.both"],
    [parsePublication(reply(entry("CLEAN"), entry("HUBSPOT", "AVAILABLE_LIMITED"), entry("SALESFORCE", "AVAILABLE_LIMITED"))), "services.clean.qualifies.both"],
    [parsePublication(reply(entry("CLEAN"), entry("HUBSPOT"))), "services.clean.qualifies.hubspot"],
    [parsePublication(reply(entry("CLEAN"), entry("SALESFORCE"))), "services.clean.qualifies.salesforce"],
    [parsePublication(reply(entry("CLEAN"))), "services.clean.qualifies.none"],
    [parsePublication(reply()), "services.clean.qualifies.none"],
    [UNAVAILABLE, "services.clean.qualifies.unknown"],
  ];
  for (const [publication, id] of cases) assert.equal(cleanQualifiesId(publication), id);
  const text = (id: keyof typeof PUBLIC_COPY): string => PUBLIC_COPY[id];
  assert.match(text("services.clean.qualifies.both"), /only for HubSpot and Salesforce\.$/);
  assert.match(text("services.clean.qualifies.hubspot"), /only for HubSpot\.$/);
  assert.doesNotMatch(text("services.clean.qualifies.hubspot"), /Salesforce/);
  assert.doesNotMatch(text("services.clean.qualifies.salesforce"), /HubSpot/);
  assert.doesNotMatch(text("services.clean.qualifies.none"), /HubSpot|Salesforce/);
  assert.doesNotMatch(text("services.clean.qualifies.unknown"), /HubSpot|Salesforce/);
});

test("an instant is written to the minute with its zone", () => {
  assert.equal(formatInstant("2026-10-02T09:30:45.123Z"), "2026-10-02 09:30 UTC");
  assert.equal(formatInstant("2026-12-31T23:59:59Z"), "2026-12-31 23:59 UTC");
  assert.throws(() => formatInstant("2026-10-02 09:30"));
});

test("the publication address comes from the public origin only: a local stack that names none reads nothing", () => {
  assert.equal(publicationUrl({ KAURO_ENV: "PRODUCTION", KAURO_PUBLIC_ORIGIN: "https://kauro.example" }), `https://kauro.example${PUBLICATION_PATH}`);
  assert.equal(publicationUrl({ KAURO_ENV: "STAGING", KAURO_PUBLIC_ORIGIN: "https://staging.kauro.example:8443" }), `https://staging.kauro.example:8443${PUBLICATION_PATH}`);
  assert.equal(publicationUrl({ KAURO_ENV: "LOCAL", KAURO_PUBLIC_ORIGIN: "http://localhost:3000" }), `http://localhost:3000${PUBLICATION_PATH}`);
  assert.equal(publicationUrl({ KAURO_ENV: "LOCAL", KAURO_PUBLIC_ORIGIN: undefined }), null);
  assert.equal(publicationUrl({ KAURO_ENV: "LOCAL", KAURO_PUBLIC_ORIGIN: "" }), null);
  assert.equal(publicationUrl({ KAURO_ENV: undefined, KAURO_PUBLIC_ORIGIN: undefined }), null);
  const refused = [
    { KAURO_ENV: "PRODUCTION", KAURO_PUBLIC_ORIGIN: "http://kauro.example" },
    { KAURO_ENV: undefined, KAURO_PUBLIC_ORIGIN: "http://localhost:3000" },
    { KAURO_ENV: "PRODUCTION", KAURO_PUBLIC_ORIGIN: "https://kauro.example/" },
    { KAURO_ENV: "PRODUCTION", KAURO_PUBLIC_ORIGIN: "https://kauro.example/path" },
    { KAURO_ENV: "PRODUCTION", KAURO_PUBLIC_ORIGIN: "https://user:secret@kauro.example" },
    { KAURO_ENV: "PRODUCTION", KAURO_PUBLIC_ORIGIN: "kauro.example" },
    { KAURO_ENV: "PRODUCTION", KAURO_PUBLIC_ORIGIN: "https://kauro.example,https://other.example" },
    { KAURO_ENV: "PRODUCTION", KAURO_PUBLIC_ORIGIN: "ftp://kauro.example" },
  ];
  for (const environment of refused) assert.equal(publicationUrl(environment), null, JSON.stringify(environment));
});

const good = (): Answer => ({ status: 200, body: JSON.stringify(reply(entry("CLEAN"), entry("HUBSPOT"))) });

test("the reader reads the api's answer, sends no credential, and asks for a fresh reading", async () => {
  await withServer(() => good(), async (origin, seen) => {
    const read = await readPublication(`${origin}${PUBLICATION_PATH}`, {});
    assert.deepEqual(modes(read), ["CLEAN", "HUBSPOT"]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.method, "GET");
    assert.equal(seen[0]?.url, PUBLICATION_PATH);
    for (const header of ["authorization", "cookie", "proxy-authorization", "x-kauro-agency"]) assert.equal(seen[0]?.headers[header], undefined, header);
    assert.match(String(seen[0]?.headers["cache-control"]), /no-store|no-cache/);
    assert.match(String(seen[0]?.headers["accept"]), /application\/json/);
  });
});

test("the reader turns every failure into UNAVAILABLE without throwing", async () => {
  assert.deepEqual(await readPublication(null, {}), UNAVAILABLE);
  const answers: Array<[string, () => Answer]> = [
    ["503", () => ({ status: 503, body: JSON.stringify({ code: "CAPACITY_UNAVAILABLE" }) })],
    ["500", () => ({ status: 500, body: "{}" })],
    ["404", () => ({ status: 404, body: "{}" })],
    ["not json", () => ({ status: 200, body: "<html>" })],
    ["wrong shape", () => ({ status: 200, body: JSON.stringify({ capabilities: [] }) })],
    ["redirect", () => ({ status: 302, body: "", headers: { location: "https://elsewhere.invalid/" } })],
    ["oversized", () => ({ status: 200, body: Buffer.alloc(70_000, 0x20) })],
    ["empty", () => ({ status: 200, body: "" })],
  ];
  for (const [name, answer] of answers) {
    await withServer(answer, async (origin, seen) => {
      assert.deepEqual(await readPublication(`${origin}${PUBLICATION_PATH}`, {}), UNAVAILABLE, name);
      assert.equal(seen.length, 1, `${name}: one request, no redirect followed`);
    });
  }
});

test("a refused connection and a server that never answers are both UNAVAILABLE", async () => {
  const closed = `${await closedOrigin()}${PUBLICATION_PATH}`;
  assert.deepEqual(await readPublication(closed, {}), UNAVAILABLE);
  await withServer(() => "HANG", async (origin) => {
    assert.deepEqual(await readPublication(`${origin}${PUBLICATION_PATH}`, { timeoutMs: 250 }), UNAVAILABLE);
  });
});
