// B11 stage-1 integration (INT-1): the public pages (W5a) against the public routes the api now serves (W5b), through the generated client
// (D-GEN-1). W5a wrote its form and publication reader against the design while W5b built the routes; since the integration the served
// contract is in apps/web/src/api/generated.ts, so the page's own closed vocabularies and parsers are held equal to it here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OPERATIONS, SCHEMAS, isCreateInquiryRequest, isCreateInquiryResponse201, isGetCapabilityPublicationResponse200 } from "../src/api/generated.ts";
import { PUBLICATION_PATH, parsePublication } from "../src/public/capabilities.ts";
import { BUYER_TYPES, DESTINATIONS, INQUIRY_PATH, RECORD_BANDS, TIMINGS, classifyReply, validateInquiry } from "../src/public/inquiry.ts";

const enumOf = (member: string): readonly string[] => ((SCHEMAS.createInquiryRequest.properties as Record<string, { enum?: readonly string[] }>)[member]?.enum ?? []);

test("B11 INT-1 seam, the public pages against the served public routes (W5a x W5b, D-GEN-1): the fit form's closed vocabularies are the api's, every body it builds passes the generated request guard, and the api's 201 is a received inquiry", () => {
  assert.equal(OPERATIONS.createInquiry.path, INQUIRY_PATH);
  assert.equal(OPERATIONS.getCapabilityPublication.path, PUBLICATION_PATH);
  assert.deepEqual([...BUYER_TYPES], [...enumOf("buyerType")]);
  assert.deepEqual([...DESTINATIONS], [...enumOf("destination")]);
  assert.deepEqual([...TIMINGS], [...enumOf("timing")]);
  assert.deepEqual(RECORD_BANDS.map((band) => band.value), [...enumOf("recordBand")]);
  for (const buyerType of BUYER_TYPES) {
    for (const band of RECORD_BANDS) {
      const built = validateInquiry({ buyerType, contactName: "Ana Ruiz", contactEmail: "ana@example.test", companyName: "Ruiz & Co", destination: "other-crm", recordBand: band.value, timing: "flexible", description: "" });
      assert.ok(built.ok, `${buyerType} ${band.value}`);
      if (built.ok) assert.ok(isCreateInquiryRequest(built.body), `${buyerType} ${band.value}: the body the api's schema admits`);
    }
  }
  const received = { inquiryId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f01", receivedAt: "2026-09-29T10:00:00Z" };
  assert.ok(isCreateInquiryResponse201(received));
  assert.deepEqual(classifyReply(201, received), { kind: "RECEIVED", reference: received.inquiryId });
});

test("B11 INT-1 seam, the capability publication (W5a x W5b, D-GEN-1): the page reads a reply exactly when the generated guard admits it, and anything else is the honest unavailable state", () => {
  const listed = {
    observedAt: "2026-09-29T10:00:00Z",
    capabilities: [
      { capabilityId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f02", mode: "CLEAN", version: "R2-INITIAL", state: "AVAILABLE", validFrom: "2026-09-01T00:00:00Z" },
      { capabilityId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f03", mode: "HUBSPOT", version: "R2-INITIAL", state: "AVAILABLE_LIMITED", validFrom: "2026-09-01T00:00:00Z" },
    ],
  };
  const replies: ReadonlyArray<readonly [string, unknown]> = [
    ["two modes", listed],
    ["none listed", { observedAt: "2026-09-29T10:00:00Z", capabilities: [] }],
    ["an extra member", { ...listed, cached: true }],
    ["a state that is not offered", { ...listed, capabilities: [{ ...listed.capabilities[0], state: "DESIGN" }] }],
    ["no instant", { capabilities: [] }],
  ];
  for (const [name, reply] of replies) {
    assert.equal(parsePublication(reply).kind === "READ", isGetCapabilityPublicationResponse200(reply), name);
  }
});
