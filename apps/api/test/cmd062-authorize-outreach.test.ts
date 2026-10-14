// CMD062 AuthorizeOutreach, PrepareOutreachReview and GetOutreachReview through the real route (package B12, lane L-AUTH; plan
// docs/design/B12-outreach-plan.md §1, §2, §M M31..M34, §W). The handlers are landed (packages/application commercial/outreach/{authorize,prepare-review,
// get-review}.ts) and bound in apps/api/src/composition.ts; the adapter-level cells run in packages/persistence/test/b12-outreach-auth.test.ts and
// packages/application/test/b12-outreach-review-digest.test.ts. The route-level cells below need the B12 api world (an owner session with a step-up
// proof, a verified sender, drafts of a seller's prospect, the TEST CLOCK) that no lane has landed yet: each is a todo with its exact title, kept so
// the titles stay unique repo-wide and the case map finds them. Owner sprint 2026-10-14: no test runs, compile only.
import { test } from "node:test";

const TODO = "route-level B12 world (owner session + step-up proof + verified sender + drafts + TEST CLOCK) not built yet; regen at batch, then write the body";

test("CMD062-OK: the owner with a fresh step-up consumes the server-issued review of two DRAFT hashes of one sender and seals them for 14 days, maximumSends 2: 201 one grant bound to the review, revoked false, policyVersion recorded, validFrom clamped to the database instant, no draft changed, no send queued", { todo: TODO }, () => {});

test("CMD062-DENY: a seller and an agency member are 403, a stale step-up is ASSURANCE_REQUIRED; then a client-computed digest of the same fields, a review issued under another step-up proof, a review of an earlier draft version, a consumed review, an expired review, expired/empty/duplicate/non-DRAFT hash, another sender's draft, maximumSends 0 or above the sealed drafts, window over 14 days, superseded resource, capability SUSPENDED by CMD059 after drafting: each 409 with nothing written", { todo: TODO }, () => {});

test("CMD062-RACE: identical retry replays one grant, same key other hashes is 409, two CMD062 consuming one review give one grant (UNIQUE review_id), CMD063 authorizing a sealed draft held at the draft subject L10 in both orders (grant then AUTHORIZED, or 409 non-DRAFT), CMD059 held at the capability subject L5 in both orders, owner grant revoked held at L1 in both orders, crash before COMMIT nothing and after COMMIT one grant", { todo: TODO }, () => {});

test("TIMEOUT: at the draft subject L10", { todo: TODO }, () => {});

test("EXPIRY: step-up, review expiry and expiresAt crossed while waiting at L10 judged after it", { todo: TODO }, () => {});

test("DENY: a sender REVOKED after the review", { todo: TODO }, () => {});

test("PARTIAL: failure at the second sealed-hash INSERT rolls back grant, first hash, fact, journal and leaves the review unconsumed", { todo: TODO }, () => {});

test("EXPIRY (review boundary): consumed 1 us before issued_at + 15 min admitted, at it refused", { todo: TODO }, () => {});

test("RACE: CMD063 authorizing a draft held at L10 vs the review: review refused non-DRAFT, or issued and then CMD062 refused", { todo: TODO }, () => {});

test("PARTIAL: failure at the second draft line rolls back the review", { todo: TODO }, () => {});

test("REVOCATION: PrepareOutreachReview with the owner grant revoked held at L1 in both orders", { todo: TODO }, () => {});
