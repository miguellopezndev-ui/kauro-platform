// UI07: the fit inquiry a visitor without an account sends to the api (W5b: POST /api/v1/public/inquiries; A3 3.7). These tests hold:
//   - the form's vocabularies equal the api's closed vocabularies, and the record bands are the ladder's bands plus "more" and "not sure";
//   - a value the api's closed schema would refuse is refused in the browser first, with the message that names the field;
//   - the request is exactly the schema's object (no other member, the empty description absent) and carries no credential;
//   - each answer of the api becomes one outcome, and the two outcomes that keep the visitor's words (limited, failed) say so.
// The api is CONTRACT_FAKE (test/support/local-api.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUYER_TYPES,
  DESCRIPTION_MAX,
  DESTINATIONS,
  EMPTY_VALUES,
  INQUIRY_PATH,
  RECORD_BANDS,
  TIMINGS,
  classifyReply,
  submitInquiry,
  validateInquiry,
  waitPhrase,
  type InquiryValues,
} from "../src/public/inquiry.ts";
import { PUBLIC_COPY } from "../src/copy/public.ts";
import { closedOrigin, withServer } from "./support/local-api.ts";

// the api's closed vocabularies (packages/domain/src/model/inquiry.ts, W5b); the integration branch holds them equal by its own test
const API_BUYER_TYPES = ["agency", "in-house"];
const API_DESTINATIONS = ["listed-crm", "other-crm", "files-only", "not-chosen"];
const API_RECORD_BANDS = ["up-to-50000", "up-to-150000", "up-to-500000", "up-to-1000000", "over-1000000", "not-sure"];
const API_TIMINGS = ["within-2-weeks", "within-a-month", "within-a-quarter", "flexible"];

function filled(overrides: Partial<InquiryValues> = {}): InquiryValues {
  return {
    buyerType: "agency",
    contactName: "Ada Tester",
    contactEmail: "ada@fixture.example",
    companyName: "Fixture Agency",
    destination: "listed-crm",
    recordBand: "up-to-150000",
    timing: "within-a-month",
    description: "",
    ...overrides,
  };
}

test("the form offers exactly the api's closed vocabularies, and the record bands are the ladder's bands", () => {
  assert.deepEqual([...BUYER_TYPES], API_BUYER_TYPES);
  assert.deepEqual([...DESTINATIONS], API_DESTINATIONS);
  assert.deepEqual([...TIMINGS], API_TIMINGS);
  assert.deepEqual(RECORD_BANDS.map((band) => band.value), API_RECORD_BANDS);
  assert.deepEqual(RECORD_BANDS.map((band) => band.label), ["Up to 50,000", "50,001 to 150,000", "150,001 to 500,000", "500,001 to 1,000,000", PUBLIC_COPY["contact.band.over"], PUBLIC_COPY["contact.band.not-sure"]]);
  assert.equal(DESCRIPTION_MAX, 2000);
});

test("a complete inquiry becomes the api's object, trimmed, with an empty description left out", () => {
  const result = validateInquiry(filled({ contactName: "  Ada Tester ", contactEmail: " ada@fixture.example ", companyName: " Fixture Agency  ", description: "   " }));
  assert.deepEqual(result, {
    ok: true,
    body: {
      buyerType: "agency",
      contactName: "Ada Tester",
      contactEmail: "ada@fixture.example",
      companyName: "Fixture Agency",
      destination: "listed-crm",
      recordBand: "up-to-150000",
      timing: "within-a-month",
    },
  });
  const withText = validateInquiry(filled({ description: "  We are moving a client between two systems.\nAbout 90,000 contacts.  " }));
  assert.equal(withText.ok && withText.body.description, "We are moving a client between two systems.\nAbout 90,000 contacts.");
});

test("every value the api's schema would refuse is refused first, with the message that names the field", () => {
  assert.deepEqual(validateInquiry(EMPTY_VALUES), {
    ok: false,
    errors: {
      buyerType: "contact.error.buyer",
      contactName: "contact.error.name",
      contactEmail: "contact.error.email",
      companyName: "contact.error.company",
      destination: "contact.error.destination",
      recordBand: "contact.error.band",
      timing: "contact.error.timing",
    },
  });
  const single = (overrides: Partial<InquiryValues>, field: string, message: string): void => {
    const result = validateInquiry(filled(overrides));
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.deepEqual(result.ok ? {} : result.errors, { [field]: message }, JSON.stringify(overrides));
  };
  single({ buyerType: "reseller" }, "buyerType", "contact.error.buyer");
  single({ contactName: "   " }, "contactName", "contact.error.name");
  single({ contactName: "x".repeat(201) }, "contactName", "contact.error.name");
  single({ contactName: "Ada\u0007" }, "contactName", "contact.error.name");
  single({ companyName: "Line\nbreak" }, "companyName", "contact.error.company");
  single({ destination: "HubSpot" }, "destination", "contact.error.destination");
  single({ recordBand: "up-to-75000" }, "recordBand", "contact.error.band");
  single({ timing: "yesterday" }, "timing", "contact.error.timing");
  for (const email of ["ada", "ada@fixture", "ada@@fixture.example", "ada @fixture.example", "\"ada\"@fixture.example", "ada@[127.0.0.1]", "@fixture.example", "ada@fixture..example", `${"a".repeat(65)}@fixture.example`, "ada@für.example"]) {
    single({ contactEmail: email }, "contactEmail", "contact.error.email");
  }
  for (const email of ["ada@fixture.example", "ada.tester+crm@sub.fixture.example", "A_B-C@x-y.example.org"]) assert.equal(validateInquiry(filled({ contactEmail: email })).ok, true, email);
  single({ description: "x".repeat(DESCRIPTION_MAX + 1) }, "description", "contact.error.description");
  single({ description: "bell\u0007" }, "description", "contact.error.description-text");
  assert.equal(validateInquiry(filled({ description: "x".repeat(DESCRIPTION_MAX) })).ok, true);
  assert.equal(validateInquiry(filled({ description: "\u{1F600}".repeat(DESCRIPTION_MAX) })).ok, true, "the limit counts characters, as the api's schema does, not UTF-16 units");
});

test("the request is the schema's object and nothing else, and it carries no credential", async () => {
  await withServer(() => ({ status: 201, body: JSON.stringify({ inquiryId: "0192d3a4-5b6c-7d8e-9f01-23456789abcd", receivedAt: "2026-10-02T09:30:45.123Z" }) }), async (origin, seen) => {
    const validated = validateInquiry(filled({ description: "A migration." }));
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const outcome = await submitInquiry(validated.body, { endpoint: `${origin}${INQUIRY_PATH}` });
    assert.deepEqual(outcome, { kind: "RECEIVED", reference: "0192d3a4-5b6c-7d8e-9f01-23456789abcd" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.method, "POST");
    assert.equal(seen[0]?.url, "/api/v1/public/inquiries");
    assert.match(String(seen[0]?.headers["content-type"]), /^application\/json/);
    for (const header of ["authorization", "cookie", "x-kauro-agency"]) assert.equal(seen[0]?.headers[header], undefined, header);
    assert.deepEqual(JSON.parse(seen[0]?.body ?? "null"), { ...validated.body });
    assert.deepEqual(Object.keys(JSON.parse(seen[0]?.body ?? "{}") as object).sort(), ["buyerType", "companyName", "contactEmail", "contactName", "description", "destination", "recordBand", "timing"]);
  });
});

test("each answer of the api is one outcome", () => {
  const problem = (status: number, code: string, extra: Record<string, unknown> = {}): unknown => ({ type: `urn:kauro:problem:${code}`, title: "t", status, code, correlationId: "c", retryable: false, nextActions: [], ...extra });
  assert.deepEqual(classifyReply(201, { inquiryId: "0192d3a4-5b6c-7d8e-9f01-23456789abcd", receivedAt: "2026-10-02T09:30:45Z" }), { kind: "RECEIVED", reference: "0192d3a4-5b6c-7d8e-9f01-23456789abcd" });
  assert.deepEqual(classifyReply(201, { receivedAt: "2026-10-02T09:30:45Z" }), { kind: "FAILED" }, "a receipt with no identity is not a receipt");
  assert.deepEqual(classifyReply(201, { inquiryId: "not an id", receivedAt: "x" }), { kind: "FAILED" });
  assert.deepEqual(classifyReply(422, problem(422, "CONTENT_REFUSED", { reason: "SECRET_LIKE_CONTENT" })), { kind: "REFUSED" });
  assert.deepEqual(classifyReply(429, problem(429, "ADMISSION_LIMITED", { reason: "INQUIRY_RATE_LIMITED", retryAfterSeconds: 1800 })), { kind: "LIMITED", retryAfterSeconds: 1800 });
  assert.deepEqual(classifyReply(429, problem(429, "ADMISSION_LIMITED")), { kind: "LIMITED", retryAfterSeconds: null });
  assert.deepEqual(classifyReply(429, problem(429, "ADMISSION_LIMITED", { retryAfterSeconds: -5 })), { kind: "LIMITED", retryAfterSeconds: null });
  assert.deepEqual(classifyReply(400, problem(400, "INVALID_REQUEST")), { kind: "FIELDS" });
  for (const [status, body] of [
    [403, problem(403, "NOT_AUTHORIZED", { reason: "ORIGIN_REJECTED" })],
    [500, problem(500, "INTERNAL_ERROR")],
    [503, problem(503, "CAPACITY_UNAVAILABLE")],
    [502, null],
    [200, {}],
    [404, "text"],
    [422, null],
  ] as const) {
    assert.deepEqual(classifyReply(status, body), { kind: "FAILED" }, String(status));
  }
});

test("submitting reaches each outcome over the wire, and a network failure is FAILED", async () => {
  const body = { buyerType: "in-house", contactName: "Ada", contactEmail: "ada@fixture.example", companyName: "Fixture", destination: "files-only", recordBand: "not-sure", timing: "flexible" } as const;
  const answers: ReadonlyArray<readonly [number, unknown, string]> = [
    [422, { code: "CONTENT_REFUSED", status: 422 }, "REFUSED"],
    [429, { code: "ADMISSION_LIMITED", status: 429, retryAfterSeconds: 90 }, "LIMITED"],
    [400, { code: "INVALID_REQUEST", status: 400 }, "FIELDS"],
    [503, { code: "CAPACITY_UNAVAILABLE", status: 503 }, "FAILED"],
  ];
  for (const [status, payload, kind] of answers) {
    await withServer(() => ({ status, body: JSON.stringify(payload) }), async (origin) => {
      assert.equal((await submitInquiry(body, { endpoint: `${origin}${INQUIRY_PATH}` })).kind, kind);
    });
  }
  await withServer(() => ({ status: 502, body: "<html>bad gateway</html>", headers: { "content-type": "text/html" } }), async (origin) => {
    assert.deepEqual(await submitInquiry(body, { endpoint: `${origin}${INQUIRY_PATH}` }), { kind: "FAILED" });
  });
  assert.deepEqual(await submitInquiry(body, { endpoint: `${await closedOrigin()}${INQUIRY_PATH}` }), { kind: "FAILED" });
});

test("a wait is written in the largest whole unit that does not understate it, and an unknown wait is said as such", () => {
  assert.equal(waitPhrase(null), PUBLIC_COPY["contact.limited.later"]);
  assert.equal(waitPhrase(0), "1 minute");
  assert.equal(waitPhrase(59), "1 minute");
  assert.equal(waitPhrase(60), "1 minute");
  assert.equal(waitPhrase(61), "2 minutes");
  assert.equal(waitPhrase(3_540), "59 minutes");
  assert.equal(waitPhrase(3_600), "1 hour");
  assert.equal(waitPhrase(3_601), "2 hours");
  assert.equal(waitPhrase(86_400), "24 hours");
});
