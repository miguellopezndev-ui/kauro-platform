// CMD025-OK golden vector for the approval hash (registry case CMD025-OK "Create immutable approval for exact
// plan/source/target/disclosures"; reference/HASHING_AND_ACCOUNTING_RULES "Hash domain separation": the approval hash has the
// domain KAVO_PLAN_APPROVAL_V1 — KAURO_PLAN_APPROVAL_V1 under amendment A2 — over exactly approvalId, actorId, agencyId,
// planHash, revisionHash, targetContractHash, validationReceiptHash, disclosuresHash and createdAt, and "the digest preimage is
// the UTF-8 bytes of a closed wrapper with domain, version and payload, serialized under the accepted canonical JSON profile";
// 21 "Independent oracles": expected results must not be calculated with the same helper being tested; "Golden files are useful
// only when their origin and review are known").
//
// Origin of GOLDEN_APPROVAL_HASH, derived once outside the product on 2026-09-25 (Ubuntu 24.04 under WSL):
//   1. GOLDEN_PREIMAGE was written by hand from the rules above: the wrapper {domain, payload, version}; object keys in
//      code-point order at every level; no whitespace; every member a JSON string; the version the integer 1;
//   2. `printf '%s' "$GOLDEN_PREIMAGE" | sha256sum` (GNU coreutils) printed the hex below;
//   3. cross-check: python3 `json.dumps(wrapper, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` over the same
//      nine members produced the same string, and `hashlib.sha256(s.encode("utf-8")).hexdigest()` the same hex.
// Neither step used @kauro/contracts or @kauro/application. The preimage members are deliberately distinct values, so a
// member read in place of another (planHash for disclosuresHash, agencyId for actorId) changes the digest.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DOMAINS, structuredDigest } from "@kauro/contracts";
import { approvalHashOf } from "../src/index.js";
import { independentApprovalHash, type ApprovalHashMembers } from "./support.js";

const GOLDEN_MEMBERS: ApprovalHashMembers = {
  approvalId: "01920000-0000-7000-8000-000000000a01",
  actorId: "5c3f2a10-6b7d-5e8f-9a0b-1c2d3e4f5a6b",
  agencyId: "01920000-0000-7000-8000-000000000a02",
  planHash: "1".repeat(64),
  revisionHash: "2".repeat(64),
  targetContractHash: "3".repeat(64),
  validationReceiptHash: "4".repeat(64),
  disclosuresHash: "5".repeat(64),
  createdAt: "2026-09-25T08:30:00.000Z",
};

const GOLDEN_PREIMAGE =
  '{"domain":"KAURO_PLAN_APPROVAL_V1","payload":{"actorId":"5c3f2a10-6b7d-5e8f-9a0b-1c2d3e4f5a6b","agencyId":"01920000-0000-7000-8000-000000000a02",' +
  '"approvalId":"01920000-0000-7000-8000-000000000a01","createdAt":"2026-09-25T08:30:00.000Z",' +
  '"disclosuresHash":"5555555555555555555555555555555555555555555555555555555555555555",' +
  '"planHash":"1111111111111111111111111111111111111111111111111111111111111111",' +
  '"revisionHash":"2222222222222222222222222222222222222222222222222222222222222222",' +
  '"targetContractHash":"3333333333333333333333333333333333333333333333333333333333333333",' +
  '"validationReceiptHash":"4444444444444444444444444444444444444444444444444444444444444444"},"version":1}';

const GOLDEN_APPROVAL_HASH = "d7e978a907f91024533df149e1430afbb933936eaf9b8eefc74c1edc70b3fb4b";

test("CMD025-OK golden vector: approvalHashOf over the fixed KAURO_PLAN_APPROVAL_V1 preimage equals the hex derived outside the product; the test oracle reproduces it", () => {
  // the literal and the hex agree in this runtime too (the vector is internally consistent)
  assert.equal(createHash("sha256").update(GOLDEN_PREIMAGE, "utf8").digest("hex"), GOLDEN_APPROVAL_HASH);
  // the product
  assert.equal(approvalHashOf(GOLDEN_MEMBERS), GOLDEN_APPROVAL_HASH);
  // the oracle the handler and api tests recompute with
  assert.equal(independentApprovalHash(GOLDEN_MEMBERS), GOLDEN_APPROVAL_HASH);
});

test("every one of the nine members is bound by the approval hash, and the domain separates it from every other digest class", () => {
  const base = approvalHashOf(GOLDEN_MEMBERS);
  const variants: Readonly<Record<keyof ApprovalHashMembers, string>> = {
    approvalId: "01920000-0000-7000-8000-000000000b01",
    actorId: "5c3f2a10-6b7d-5e8f-9a0b-1c2d3e4f5a6c",
    agencyId: "01920000-0000-7000-8000-000000000b02",
    planHash: "6".repeat(64),
    revisionHash: "7".repeat(64),
    targetContractHash: "8".repeat(64),
    validationReceiptHash: "9".repeat(64),
    disclosuresHash: "a".repeat(64),
    createdAt: "2026-09-25T08:30:00.001Z",
  };
  for (const member of Object.keys(variants) as Array<keyof ApprovalHashMembers>) {
    const changed = { ...GOLDEN_MEMBERS, [member]: variants[member] };
    const digest = approvalHashOf(changed);
    assert.notEqual(digest, base, `${member} is part of the preimage`);
    assert.equal(digest, independentApprovalHash(changed), `${member}: product and oracle agree`);
  }
  // the same payload under another domain is another digest (the domain prevents cross-class reuse)
  for (const domain of [DOMAINS.PLAN_BODY, DOMAINS.DECISION_EVIDENCE, DOMAINS.PROVIDER_REQUEST]) {
    assert.notEqual(structuredDigest(domain, 1, GOLDEN_MEMBERS), base, domain);
  }
});
