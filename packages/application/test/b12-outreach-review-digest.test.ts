// Lane L-AUTH of package B12 (plan §0 A16): the digest of a server-issued review binds the review id the server chose, the owner, the step-up
// proof, the sender and every line; it does not depend on the order of the lines. No database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { outreachReviewDigest } from "../src/index.js";

const h = (c: string): string => c.repeat(64);
const base = {
  reviewId: "018f0000-0000-7000-8000-000000000001",
  ownerUserId: "018f0000-0000-7000-8000-0000000000a1",
  proofId: "018f0000-0000-7000-8000-0000000000b1",
  senderId: "018f0000-0000-7000-8000-0000000000c1",
  items: [
    { draftId: "018f0000-0000-7000-8000-0000000000d1", draftVersion: 1, contentHash: h("a"), contactLabel: "Operations lead" },
    { draftId: "018f0000-0000-7000-8000-0000000000d2", draftVersion: 2, contentHash: h("b"), contactLabel: "Founder" },
  ],
};

test("the review digest is a sha256 hex that does not depend on the order of the lines", () => {
  const d = outreachReviewDigest(base);
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(outreachReviewDigest({ ...base, items: [...base.items].reverse() }), d);
});

test("the review digest changes with the review id, the proof, the sender, a version, a hash and a label (a client cannot reuse another review's digest)", () => {
  const d = outreachReviewDigest(base);
  const changed = [
    outreachReviewDigest({ ...base, reviewId: "018f0000-0000-7000-8000-000000000002" }),
    outreachReviewDigest({ ...base, proofId: "018f0000-0000-7000-8000-0000000000b2" }),
    outreachReviewDigest({ ...base, senderId: "018f0000-0000-7000-8000-0000000000c2" }),
    outreachReviewDigest({ ...base, items: [{ ...base.items[0]!, draftVersion: 2 }, base.items[1]!] }),
    outreachReviewDigest({ ...base, items: [{ ...base.items[0]!, contentHash: h("c") }, base.items[1]!] }),
    outreachReviewDigest({ ...base, items: [{ ...base.items[0]!, contactLabel: "Someone else" }, base.items[1]!] }),
  ];
  for (const c of changed) assert.notEqual(c, d);
  assert.equal(new Set(changed).size, changed.length);
});
