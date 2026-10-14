// RevokeOutreachAuthorization and WithdrawOutreachChannelPolicy through the real route (package B12, lane L-AUTH; plan docs/design/B12-outreach-plan.md
// §2, §M M6/M7 (revoke side), M10/M11 (withdraw side)). The handlers are landed (commercial/outreach/{revoke-authorization,withdraw-policy}.ts) and
// bound in apps/api/src/composition.ts; their writer-side cells (L4g X, L6p X, once-only) run in packages/persistence/test/b12-outreach-auth.test.ts.
// The route-level cells need the B12 api world (owner session, step-up proof, claim held at L4g/L6p by the dispatcher of lane L-SEND): todo with
// the exact titles. Owner sprint 2026-10-14: no test runs, compile only.
import { test } from "node:test";

const TODO = "route-level B12 world and the L-SEND dispatcher (claim held at L4g / L6p) not built yet; regen at batch, then write the body";

test("RACE (revocation): revoke against a claim held at L4g in both orders: order 1 NOT_SENT(GRANT_REVOKED) with zero calls, order 2 exactly one submission then revoked; red with D2's L4g removed", { todo: TODO }, () => {});

test("RETRY (revocation): an identical revoke replays; revoking a revoked grant is 200 with nothing written", { todo: TODO }, () => {});

test("TIMEOUT: withdraw waiting at L6p behind a claim answers 503 retryable, writes nothing", { todo: TODO }, () => {});

test("RETRY: identical withdraw replays; a second withdraw of a WITHDRAWN policy is 409", { todo: TODO }, () => {});

test("REVOCATION (withdraw): owner grant revoked held at L1 in both orders", { todo: TODO }, () => {});

test("RACE (withdraw): D2 against a withdraw held at L6p in both orders: NOT_SENT(POLICY_WITHDRAWN), or one call and then WITHDRAWN; CMD063 and CMD061 refuse OUTREACH_JURISDICTION_UNREVIEWED after it", { todo: TODO }, () => {});
