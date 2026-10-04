import assert from "node:assert/strict";
import { test } from "node:test";
import { STATIC_SECURITY_HEADERS, contentSecurityPolicy, newNonce } from "../src/server/security-headers.js";

const directives = (policy: string): Map<string, string[]> =>
  new Map(policy.split("; ").map((d) => { const [name, ...values] = d.split(" "); return [name as string, values]; }));

test("D-SEC-1: the policy admits only same-origin resources and the request's nonce — no inline script or style attribute, no eval, no plugin, frame, worker or foreign origin, no framing and no base or form retargeting", () => {
  const nonce = newNonce();
  const policy = contentSecurityPolicy({ nonce });
  const d = directives(policy);
  assert.deepEqual(d.get("default-src"), ["'none'"]);
  assert.deepEqual(d.get("script-src"), ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]);
  assert.deepEqual(d.get("style-src"), ["'self'", `'nonce-${nonce}'`]);
  assert.deepEqual(d.get("style-src-attr"), ["'none'"]);
  assert.deepEqual(d.get("img-src"), ["'self'"]);
  assert.deepEqual(d.get("connect-src"), ["'self'"]);
  for (const name of ["object-src", "frame-src", "worker-src", "frame-ancestors", "base-uri", "media-src"]) assert.deepEqual(d.get(name), ["'none'"], name);
  assert.deepEqual(d.get("form-action"), ["'self'"]);
  assert.ok(d.has("upgrade-insecure-requests"));
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|unsafe-hashes|\*|data:|blob:|http:/);
});

test("D-SEC-1: a foreign connect origin is admitted only as an exact https origin, and a malformed nonce is refused", () => {
  const nonce = newNonce();
  const policy = contentSecurityPolicy({ nonce, connectOrigins: ["https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com"] });
  assert.deepEqual(directives(policy).get("connect-src"), ["'self'", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com"]);
  for (const bad of ["http://identitytoolkit.googleapis.com", "https://*.googleapis.com", "https://securetoken.googleapis.com/v1", "https://example.com:8443", "'self'", "https:"]) {
    assert.throws(() => contentSecurityPolicy({ nonce, connectOrigins: [bad] }), RangeError, bad);
  }
  for (const bad of ["", "abc", "a".repeat(24), `${nonce}'; script-src *`]) assert.throws(() => contentSecurityPolicy({ nonce: bad }), RangeError);
  assert.ok(!directives(contentSecurityPolicy({ nonce, upgradeInsecureRequests: false })).has("upgrade-insecure-requests"));
});

test("D-SEC-1: nonces are 128 random bits in base64 and do not repeat", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const n = newNonce();
    assert.match(n, /^[A-Za-z0-9+/]{22}==$/);
    seen.add(n);
  }
  assert.equal(seen.size, 2000);
});

test("D-SEC-1: every response carries nosniff, no referrer, no framing, same-origin opener and resource policies, HSTS and a closed permissions policy", () => {
  const h = new Map(STATIC_SECURITY_HEADERS.map(({ key, value }) => [key.toLowerCase(), value]));
  assert.equal(h.get("x-content-type-options"), "nosniff");
  assert.equal(h.get("referrer-policy"), "no-referrer");
  assert.equal(h.get("x-frame-options"), "DENY");
  assert.equal(h.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(h.get("cross-origin-resource-policy"), "same-origin");
  assert.match(h.get("strict-transport-security") ?? "", /^max-age=\d{8,}; includeSubDomains$/);
  for (const feature of ["camera", "microphone", "geolocation", "payment", "browsing-topics"]) assert.match(h.get("permissions-policy") ?? "", new RegExp(`\\b${feature}=\\(\\)`));
});
