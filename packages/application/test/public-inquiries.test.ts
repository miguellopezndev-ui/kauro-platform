// The pure parts of the fit inquiry (B11 W5b, D-PUB-3..D-PUB-6): the keyed digests that stand for an address, a content and an
// e-mail address, and the closed request schema of the route. The service's use of the store is exercised against real
// PostgreSQL through the routes (apps/api/test/b11-public-routes.test.ts); nothing here stands in for a store.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { InquiryContent } from "@kauro/domain";
import type { ContractSchemaBundle, InquiryBody } from "../src/index.js";
import { UNKNOWN_CLIENT_NETWORK, createSchemaValidator, inquiryContentOf, inquiryKeysOf, operationalRequestSchemaId } from "../src/index.js";

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(8);

const body: InquiryBody = {
  buyerType: "agency",
  contactName: "Ana Ruiz",
  contactEmail: "Ana.Ruiz@Example.com",
  companyName: "Ruiz Studio",
  destination: "files-only",
  recordBand: "up-to-50000",
  timing: "within-a-month",
};

const content = (extra: Partial<InquiryContent> = {}): InquiryContent => ({ ...inquiryContentOf(body), ...extra });

test("an absent description is null in the content the store keeps, and a present one is kept as sent", () => {
  assert.equal(inquiryContentOf(body).description, null);
  assert.equal(inquiryContentOf({ ...body, description: "Two portals, one export." }).description, "Two portals, one export.");
});

test("the three keys are hex digests of one domain each: the same material under the three labels gives three unrelated values", () => {
  const keys = inquiryKeysOf(KEY, content(), "203.0.113.0");
  for (const digest of [keys.address, keys.content, keys.email]) assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(new Set([keys.address, keys.content, keys.email]).size, 3);
  const mailAsAddress = inquiryKeysOf(KEY, content(), "ana.ruiz@example.com");
  assert.notEqual(mailAsAddress.address, mailAsAddress.email, "a network string equal to the e-mail address is still another domain");
});

test("the keys are stable for one key and change with the key: the digest is compared across requests and instances", () => {
  assert.deepEqual(inquiryKeysOf(KEY, content(), "203.0.113.0"), inquiryKeysOf(KEY, content(), "203.0.113.0"));
  const other = inquiryKeysOf(OTHER_KEY, content(), "203.0.113.0");
  const same = inquiryKeysOf(KEY, content(), "203.0.113.0");
  assert.notEqual(other.address, same.address);
  assert.notEqual(other.content, same.content);
  assert.notEqual(other.email, same.email);
});

test("the e-mail address is compared without regard to case in the e-mail key and in the content key, and every other field exactly", () => {
  const lower = inquiryKeysOf(KEY, content({ contactEmail: "ana.ruiz@example.com" }), "203.0.113.0");
  const mixed = inquiryKeysOf(KEY, content(), "203.0.113.0");
  assert.equal(lower.email, mixed.email);
  assert.equal(lower.content, mixed.content);
  const changed: ReadonlyArray<Partial<InquiryContent>> = [
    { buyerType: "in-house" },
    { contactName: "ana ruiz" },
    { companyName: "Ruiz Studio " },
    { destination: "not-chosen" },
    { recordBand: "not-sure" },
    { timing: "flexible" },
    { description: "Two portals." },
  ];
  for (const extra of changed) assert.notEqual(inquiryKeysOf(KEY, content(extra), "203.0.113.0").content, mixed.content, JSON.stringify(extra));
});

test("the client network is the address key only, and an unknown or empty network shares one bucket", () => {
  const a = inquiryKeysOf(KEY, content(), "203.0.113.0");
  const b = inquiryKeysOf(KEY, content(), "198.51.100.0");
  assert.notEqual(a.address, b.address);
  assert.equal(a.content, b.content);
  assert.equal(a.email, b.email);
  const unknown = inquiryKeysOf(KEY, content(), null);
  assert.equal(unknown.address, inquiryKeysOf(KEY, content(), "").address);
  assert.equal(unknown.address, inquiryKeysOf(KEY, content(), UNKNOWN_CLIENT_NETWORK).address);
});

test("the content key is over the fields, not their concatenation: moving text between two fields changes it", () => {
  const first = inquiryKeysOf(KEY, content({ contactName: "Ana", companyName: "Ruiz Studio" }), "203.0.113.0");
  const second = inquiryKeysOf(KEY, content({ contactName: "AnaRuiz", companyName: " Studio" }), "203.0.113.0");
  assert.notEqual(first.content, second.content);
});

const bundle = JSON.parse(readFileSync(new URL(import.meta.resolve("@kauro/contracts/schemas.json")), "utf8")) as ContractSchemaBundle;
const validator = createSchemaValidator(bundle);
const schemaId = operationalRequestSchemaId("createInquiry");

test("the request schema is closed: an unknown member, a buyer type outside the two, a CRM name as a destination and an over-long description are each refused", () => {
  assert.equal(validator.validate(schemaId, body).kind, "VALID");
  assert.equal(validator.validate(schemaId, { ...body, buyerType: "in-house", description: "x".repeat(2000) }).kind, "VALID");
  const refused: ReadonlyArray<Record<string, unknown>> = [
    { ...body, extra: 1 },
    { ...body, buyerType: "freelancer" },
    { ...body, destination: "HUBSPOT" },
    { ...body, destination: "hubspot" },
    { ...body, recordBand: "up-to-1" },
    { ...body, timing: "someday" },
    { ...body, description: "x".repeat(2001) },
    { ...body, description: "" },
    { ...body, contactEmail: "not an address" },
  ];
  for (const candidate of refused) assert.equal(validator.validate(schemaId, candidate).kind, "INVALID", JSON.stringify(candidate).slice(0, 80));
  for (const member of ["buyerType", "contactName", "contactEmail", "companyName", "destination", "recordBand", "timing"]) {
    const { [member]: _dropped, ...rest } = body as unknown as Record<string, unknown>;
    assert.equal(validator.validate(schemaId, rest).kind, "INVALID", `${member} is required`);
  }
});
