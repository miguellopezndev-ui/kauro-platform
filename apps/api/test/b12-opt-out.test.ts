/**
 * Lane L-ACT: the public opt-out routes over a real Fastify instance (fake store, no database): the HTTP shape of RFC 8058 (plan "Public opt-out").
 * The cells that need PostgreSQL (suppression rows, one activity, the prospect left alone, M35 concurrency, GAP-OO-1) are `todo` below with the reason.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { mintOptOutToken, type OptOutKey, type OptOutStore } from "@kauro/application";
import { registerOptOutRoutes } from "../src/outreach/opt-out-route.js";

const KEY: OptOutKey = { version: "k1", secret: new Uint8Array(32).fill(3) };
const INTENT = "0190aaaa-bbbb-7ccc-8ddd-eeeeffff0002";
const TOKEN = mintOptOutToken(KEY, INTENT);
const BODY = "List-Unsubscribe=One-Click";

function world(): { app: FastifyInstance; suppressed: string[]; misses: string[] } {
  const suppressed: string[] = [];
  const misses: string[] = [];
  const store: OptOutStore = {
    async suppressContactOfIntent(id) {
      if (id !== INTENT) return "UNKNOWN_INTENT";
      suppressed.push(id);
      return "SUPPRESSED";
    },
    async recordMiss(digest) {
      misses.push(digest);
      return misses.filter((d) => d === digest).length;
    },
  };
  const app = Fastify();
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  registerOptOutRoutes(app, { keys: [KEY], store, clientNetwork: () => "198.51.100.0", sink: (_c, e) => { throw e; } });
  return { app, suppressed, misses };
}
const post = (app: FastifyInstance, token: string, contentType: string, payload: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/api/v1/public/outreach/opt-out/${token}`, headers: { "content-type": contentType, ...headers }, payload });

test("OPT-OUT OK (RFC 8058 form): urlencoded List-Unsubscribe=One-Click with no other header suppresses and answers 200 without a redirect", async () => {
  const { app, suppressed } = world();
  const r = await post(app, TOKEN, "application/x-www-form-urlencoded", BODY);
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers.location, undefined);
  assert.deepEqual(r.json(), { status: "RECEIVED" });
  assert.deepEqual(suppressed, [INTENT]);
});

test("OPT-OUT OK (RFC 8058 multipart): a one-part multipart/form-data suppresses", async () => {
  const { app, suppressed } = world();
  const part = '--b1\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--b1--\r\n';
  assert.equal((await post(app, TOKEN, "multipart/form-data; boundary=b1", part)).statusCode, 200);
  assert.deepEqual(suppressed, [INTENT]);
});

test("OPT-OUT DENY (shape): application/json and text/plain and another form body are refused (INVALID_REQUEST), and nothing is written", async () => {
  const { app, suppressed, misses } = world();
  for (const type of ["application/json", "text/plain"]) {
    const r = await post(app, TOKEN, type, BODY);
    assert.equal(r.statusCode, 400, type); // the platform answers INVALID_REQUEST as 400; the plan prose says 415 (reported as a gap)
    assert.equal(r.json().reason, "CONTENT_TYPE_UNSUPPORTED");
  }
  const other = await post(app, TOKEN, "application/x-www-form-urlencoded", "List-Unsubscribe=One-Click&a=b");
  assert.equal(other.statusCode, 400);
  assert.equal(other.json().reason, "SCHEMA_VIOLATION");
  assert.deepEqual([suppressed, misses], [[], []]);
});

test("OPT-OUT OK (unknown token): the same 200 and nothing suppressed", async () => {
  const { app, suppressed } = world();
  const r = await post(app, "k1.00000000000000000000000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "application/x-www-form-urlencoded", BODY);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { status: "RECEIVED" });
  assert.deepEqual(suppressed, []);
});

test("OPT-OUT DENY (ambient): a cookie, an Authorization header and a foreign Origin change nothing: the token alone decides", async () => {
  const { app, suppressed } = world();
  const r = await post(app, TOKEN, "application/x-www-form-urlencoded", BODY, { cookie: "kauro_session=owner", authorization: "Bearer owner", origin: "https://evil.example" });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(suppressed, [INTENT]);
  assert.equal(r.headers["set-cookie"], undefined);
  assert.equal((await post(app, "junk", "application/x-www-form-urlencoded", BODY, { cookie: "kauro_session=owner" })).statusCode, 200);
});

test("OPT-OUT OK (GET redirect): GET answers 303 Location /unsubscribe/{token} with no body and no content type, and writes nothing", async () => {
  const { app, suppressed, misses } = world();
  const r = await app.inject({ method: "GET", url: `/api/v1/public/outreach/opt-out/${TOKEN}` });
  assert.equal(r.statusCode, 303);
  assert.equal(r.headers.location, `/unsubscribe/${TOKEN}`);
  assert.equal(r.body, "");
  assert.equal(r.headers["content-type"], undefined);
  assert.deepEqual([suppressed, misses], [[], []]);
});

test("OPT-OUT DENY (rate, misses): the 21st unknown-token POST from one network is 429 ADMISSION_LIMITED; OPT-OUT OK (rate, valid token): a valid token still suppresses", async () => {
  const { app, suppressed } = world();
  for (let n = 1; n <= 20; n += 1) assert.equal((await post(app, "junk", "application/x-www-form-urlencoded", BODY)).statusCode, 200, `miss ${n}`);
  const limited = await post(app, "junk", "application/x-www-form-urlencoded", BODY);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, "ADMISSION_LIMITED");
  assert.equal((await post(app, TOKEN, "application/x-www-form-urlencoded", BODY)).statusCode, 200);
  assert.deepEqual(suppressed, [INTENT]);
});

const NEEDS_PG = "needs PostgreSQL (real PgOptOutStore under kauro_outreach); sprint packet forbids runs: write at batch verification";
test("OPT-OUT OK (database): the known token writes one CONTACT suppression (recorded_by_service, OPT_OUT) and one SUPPRESSED activity, and leaves the prospect row alone (A17)", { todo: NEEDS_PG }, () => {});
test("OPT-OUT RETRY (M35): the same token twice concurrently, and a second token of the same contact: 200 each, one suppression row, one activity, never 42P10", { todo: NEEDS_PG }, () => {});
test("OPT-OUT PARTIAL (GAP-OO-1): failure at the activity INSERT rolls back the suppression row", { todo: NEEDS_PG }, () => {});
test("OPT-OUT DENY (GET): a link-scanner GET of the UI49 page writes nothing", { todo: NEEDS_PG }, () => {});
