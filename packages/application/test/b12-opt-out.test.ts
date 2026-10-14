// Lane L-ACT: the pure parts of the public opt-out (no database): RFC 8058 admission, the self-verifying token, and the miss-only limiter.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OPT_OUT_MISS_LIMIT, admitOneClickOptOut, mintOptOutToken, optOutByToken, readOptOutToken, type OptOutKey, type OptOutStore } from "../src/index.js";

const KEY: OptOutKey = { version: "k1", secret: new Uint8Array(32).fill(7) };
const OLD: OptOutKey = { version: "k0", secret: new Uint8Array(32).fill(9) };
const INTENT = "0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
const form = (s: string): Buffer => Buffer.from(s, "utf8");

test("OPT-OUT OK (RFC 8058 form): the urlencoded one-click body is admitted", () => {
  assert.equal(admitOneClickOptOut("application/x-www-form-urlencoded", form("List-Unsubscribe=One-Click")).kind, "ADMITTED");
  assert.equal(admitOneClickOptOut("application/x-www-form-urlencoded; charset=utf-8", form("List-Unsubscribe=One-Click")).kind, "ADMITTED");
});

test("OPT-OUT OK (RFC 8058 multipart): a one-part multipart/form-data is admitted", () => {
  const body = form('--b1\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--b1--\r\n');
  assert.equal(admitOneClickOptOut("multipart/form-data; boundary=b1", body).kind, "ADMITTED");
});

test("OPT-OUT DENY (shape): other media types are 415, other bodies and a two-part multipart are 400", () => {
  for (const type of ["application/json", "text/plain", undefined]) assert.equal(admitOneClickOptOut(type, form("List-Unsubscribe=One-Click")).kind, "CONTENT_TYPE_UNSUPPORTED", String(type));
  for (const body of ["", "List-Unsubscribe=One-Click&x=1", "List-Unsubscribe=Other", "list-unsubscribe=One-Click"]) assert.equal(admitOneClickOptOut("application/x-www-form-urlencoded", form(body)).kind, "SCHEMA_VIOLATION", body);
  const two = form('--b1\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--b1\r\nContent-Disposition: form-data; name="x"\r\n\r\ny\r\n--b1--\r\n');
  assert.equal(admitOneClickOptOut("multipart/form-data; boundary=b1", two).kind, "SCHEMA_VIOLATION");
  assert.equal(admitOneClickOptOut("application/x-www-form-urlencoded", Buffer.alloc(2048, 65)).kind, "SCHEMA_VIOLATION");
});

test("the token names exactly one intent: rotation verifies, forgery and alteration are misses", () => {
  const token = mintOptOutToken(KEY, INTENT);
  assert.equal(readOptOutToken([KEY], token), INTENT);
  assert.equal(readOptOutToken([KEY, OLD], mintOptOutToken(OLD, INTENT)), INTENT);
  assert.equal(readOptOutToken([KEY], mintOptOutToken(OLD, INTENT)), null, "an unlisted version");
  const [v, i, m] = token.split(".") as [string, string, string];
  assert.equal(readOptOutToken([KEY], `${v}.${i.replace(/.$/, "0")}.${m}`), null, "another intent under the same MAC");
  assert.equal(readOptOutToken([KEY], `${v}.${i}.${m.replace(/.$/, m.endsWith("A") ? "B" : "A")}`), null);
  for (const junk of ["", "x", "a.b", "k1.zz.yy"]) assert.equal(readOptOutToken([KEY], junk), null, junk);
  assert.throws(() => mintOptOutToken({ version: "k1", secret: new Uint8Array(8) }, INTENT), RangeError);
});

function fakeStore(known: ReadonlySet<string>): { store: OptOutStore; misses: () => number } {
  let misses = 0;
  return {
    misses: () => misses,
    store: {
      async suppressContactOfIntent(id) { return known.has(id) ? "SUPPRESSED" : "UNKNOWN_INTENT"; },
      async recordMiss() { return ++misses; },
    },
  };
}

test("OPT-OUT: the 21st unknown-token miss of a network is LIMITED; a valid token is never counted and still suppresses", async () => {
  const { store, misses } = fakeStore(new Set([INTENT]));
  const deps = { keys: [KEY], store };
  for (let n = 1; n <= OPT_OUT_MISS_LIMIT; n += 1) assert.equal((await optOutByToken(deps, "junk", "net")).kind, "DONE", `miss ${n}`);
  assert.equal((await optOutByToken(deps, "junk", "net")).kind, "LIMITED");
  assert.equal(misses(), OPT_OUT_MISS_LIMIT + 1);
  assert.equal((await optOutByToken(deps, mintOptOutToken(KEY, INTENT), "net")).kind, "DONE");
  assert.equal(misses(), OPT_OUT_MISS_LIMIT + 1, "a valid token is not a miss");
});
