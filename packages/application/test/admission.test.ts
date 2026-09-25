// Request admission in the order of manual 10 "Request envelope": content type, byte size, JSON syntax and duplicate keys,
// closed schema, then the envelope (idempotency key, path ids, agency selector). Each step names its reason; nothing here
// touches a database or echoes a value. The transport resolves the correlation id once (correlationIdOf) and reports the
// header fields a request repeated; admission refuses a repeated envelope header first and decodes the body bytes as strict
// UTF-8 (review findings R28, R40, R41).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Sha256Hex } from "@kauro/contracts";
import type { CorrelationId } from "@kauro/domain";
import type { ContractSchemaBundle, RawRequest, RequestHead } from "../src/index.js";
import { ARCHIVE_CLIENT, CREATE_AGENCY, CREATE_CLIENT, CREATE_PROJECT, admitHeaders, admitStructure, correlationIdOf, createSchemaValidator, envelopeOf, fixedClock, repeatedHeaderNames, sequentialIds } from "../src/index.js";
import { subject } from "./support.js";

const bundle = JSON.parse(readFileSync(new URL(import.meta.resolve("@kauro/contracts/schemas.json")), "utf8")) as ContractSchemaBundle;
const validator = createSchemaValidator(bundle);
const clock = fixedClock();
const ids = sequentialIds(clock);
const KEY = "0123456789abcdef-key";
const CLIENT = "018f0000-0000-7000-8000-000000000010";
const AGENCY = "018f0000-0000-7000-8000-000000000020";
const CORRELATION = "018f0000-0000-7000-8000-0000000000c1" as CorrelationId;
const ADDRESS_HASH = "a".repeat(64) as Sha256Hex;

type RawOverrides = Partial<Omit<RawRequest, "headers" | "body">> & { headers?: Record<string, string | undefined>; bodyText?: string | null; body?: Uint8Array | null };

function raw(overrides: RawOverrides = {}, body: unknown = { mode: "CLEAN", purpose: "Import" }): RawRequest {
  const bytes = overrides.body !== undefined ? overrides.body : overrides.bodyText === null ? null : Buffer.from(overrides.bodyText ?? JSON.stringify(body), "utf8");
  return {
    headers: { "content-type": "application/json", "idempotency-key": KEY, "x-kauro-agency": AGENCY, ...(overrides.headers ?? {}) },
    repeatedHeaders: overrides.repeatedHeaders ?? [],
    correlationId: overrides.correlationId ?? CORRELATION,
    params: overrides.params ?? { clientId: CLIENT },
    body: bytes,
    clientAddressHash: overrides.clientAddressHash !== undefined ? overrides.clientAddressHash : null,
  };
}

function reasonOf(r: ReturnType<typeof admitStructure>): string {
  assert.equal(r.kind, "PROBLEM");
  return r.kind === "PROBLEM" ? `${r.problem.status} ${r.problem.code} ${r.problem.reason ?? "-"}` : "";
}

test("the order of manual 10: content type, size, syntax, duplicate keys, schema, idempotency key, path id, agency selector", () => {
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ headers: { "content-type": "text/plain", "idempotency-key": undefined } }), validator, clock)), "400 INVALID_REQUEST CONTENT_TYPE_UNSUPPORTED");
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ body: new Uint8Array(1_048_577).fill(0x7b) }), validator, clock)), "400 INVALID_REQUEST BODY_TOO_LARGE");
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ bodyText: "{" }), validator, clock)), "400 INVALID_REQUEST JSON_SYNTAX");
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ bodyText: null }), validator, clock)), "400 INVALID_REQUEST JSON_SYNTAX");
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ bodyText: '{"mode":"CLEAN","mode":"HUBSPOT","purpose":"x"}' }), validator, clock)), "400 INVALID_REQUEST JSON_DUPLICATE_KEY");
  const unknown = admitStructure(CREATE_PROJECT, raw({ headers: { "idempotency-key": undefined } }, { mode: "CLEAN", purpose: "x", verified: true, agencyOwner: true }), validator, clock);
  assert.equal(reasonOf(unknown), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  if (unknown.kind === "PROBLEM") assert.deepEqual(unknown.problem.errors, [{ field: "verified", code: "UNKNOWN_FIELD" }, { field: "agencyOwner", code: "UNKNOWN_FIELD" }]);
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ headers: { "idempotency-key": undefined } }), validator, clock)), "400 INVALID_REQUEST IDEMPOTENCY_KEY_MISSING");
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ headers: { "idempotency-key": "short" } }), validator, clock)), "400 INVALID_REQUEST IDEMPOTENCY_KEY_INVALID");
  const badPath = admitStructure(CREATE_PROJECT, raw({ params: { clientId: "not-a-uuid" } }), validator, clock);
  assert.equal(reasonOf(badPath), "400 INVALID_REQUEST PATH_ID_INVALID");
  if (badPath.kind === "PROBLEM") assert.deepEqual(badPath.problem.errors, [{ field: "clientId", code: "FORMAT" }]);
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ headers: { "x-kauro-agency": undefined } }), validator, clock)), "400 INVALID_REQUEST AGENCY_SELECTOR_INVALID");
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ headers: { "x-kauro-agency": "acme" } }), validator, clock)), "400 INVALID_REQUEST AGENCY_SELECTOR_INVALID");
});

test("the header-only head of the order (a repeated envelope header, then the content type) is decided before a body exists; everything else waits for the body", () => {
  const head = (h: Record<string, string | undefined>, repeatedHeaders: ReadonlyArray<string> = []): RequestHead => ({ headers: { "content-type": "application/json", ...h }, repeatedHeaders, correlationId: CORRELATION });
  const problem = (h: RequestHead) => {
    const r = admitHeaders(h);
    return r === null ? "ADMITTED" : `${r.problem.status} ${r.problem.code} ${r.problem.reason ?? "-"}`;
  };
  assert.equal(problem(head({ "content-type": "text/plain" })), "400 INVALID_REQUEST CONTENT_TYPE_UNSUPPORTED");
  assert.equal(problem(head({ "content-type": undefined })), "400 INVALID_REQUEST CONTENT_TYPE_UNSUPPORTED");
  // every single-valued envelope header, repeated, is refused before its (first) value is used — even ahead of the content type
  for (const name of ["authorization", "content-type", "x-correlation-id", "idempotency-key", "x-kauro-agency"]) {
    assert.equal(problem(head({ "content-type": "text/plain" }, [name])), "400 INVALID_REQUEST HEADER_REPEATED", name);
  }
  // a repeated header outside the envelope (Accept, a proxy's Via) is none of admission's business
  assert.equal(problem(head({}, ["accept", "via"])), "ADMITTED");
  const answered = admitHeaders(head({ "content-type": "text/plain" }));
  assert.equal(answered?.problem.correlationId, CORRELATION, "the problem carries the correlation id the transport resolved");
  // the key, the selector and the body are not header-only decisions of this step
  assert.equal(problem(head({ "idempotency-key": undefined, "x-kauro-agency": undefined })), "ADMITTED");
  // the transport's raw list (name, value, name, value ...) names each repeated field once, lowercased
  assert.deepEqual(repeatedHeaderNames(["Content-Type", "application/json", "Authorization", "Bearer a", "authorization", "Bearer b", "AUTHORIZATION", "Bearer c", "Accept", "x"]), ["authorization"]);
  assert.deepEqual(repeatedHeaderNames(["Host", "x", "Content-Type", "application/json"]), []);
});

test("an admitted request carries the validated body, the path ids, the selector of its scope and the client address hash; the envelope binds the subject", () => {
  const header = admitStructure(CREATE_PROJECT, raw({ clientAddressHash: ADDRESS_HASH }), validator, clock);
  assert.equal(header.kind, "ADMITTED");
  if (header.kind === "ADMITTED") {
    assert.equal(header.admission.agencyId, AGENCY);
    assert.deepEqual(header.admission.path, { clientId: CLIENT });
    assert.deepEqual(header.admission.body, { mode: "CLEAN", purpose: "Import" });
    assert.equal(header.admission.correlationId, CORRELATION);
    assert.equal(header.admission.idempotencyKey, KEY);
    assert.equal(header.admission.clientAddressHash, ADDRESS_HASH);
    const s = subject("someone");
    const env = envelopeOf("CMD011", "LOCAL", header.admission, s);
    assert.equal(env.userId, s.identity.userId);
    assert.equal(env.command, "CMD011");
    assert.equal(env.receivedAt, clock.now());
    assert.equal(env.clientAddressHash, ADDRESS_HASH, "the keyed address hash reaches the handler; the address itself never does");
  }
  const path = admitStructure(CREATE_CLIENT, raw({ params: { agencyId: AGENCY }, headers: { "x-kauro-agency": undefined } }, { displayName: "C", processingAuthorityRef: CLIENT }), validator, clock);
  assert.equal(path.kind, "ADMITTED");
  if (path.kind === "ADMITTED") assert.equal(path.admission.agencyId, AGENCY, "the path agencyId is the selector; no header is needed");
  const none = admitStructure(CREATE_AGENCY, raw({ params: {}, headers: { "x-kauro-agency": undefined } }, { displayName: "A" }), validator, clock);
  assert.equal(none.kind, "ADMITTED");
  if (none.kind === "ADMITTED") assert.equal(none.admission.agencyId, null);
});

test("R28: a malformed client correlation id is never refused and never adopted — the server mints its own; a well-formed one is adopted; a missing one is minted", () => {
  const minted = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.equal(correlationIdOf({ "x-correlation-id": CORRELATION }, ids), CORRELATION);
  for (const given of [undefined, "", "req-7f3a-proxy", "bad value with spaces", CORRELATION.toUpperCase(), `${CORRELATION}-1`, "abc\u0000<script>"]) {
    const id = correlationIdOf({ "x-correlation-id": given }, ids);
    assert.match(id, minted, String(given));
    assert.notEqual(id, given);
  }
  assert.notEqual(correlationIdOf({}, ids), correlationIdOf({}, ids), "each request gets its own");
  // and admission itself no longer judges the header: the resolved id is simply carried
  const admitted = admitStructure(ARCHIVE_CLIENT, raw({ headers: { "x-correlation-id": "bad value with spaces" }, correlationId: CORRELATION }, { expectedVersion: 1 }), validator, clock);
  assert.equal(admitted.kind, "ADMITTED");
});

test("R40: the body is decoded as strict UTF-8 — an invalid byte sequence or a byte order mark is JSON_SYNTAX, never replaced; valid multi-byte text is admitted unchanged", () => {
  const invalid = Buffer.concat([Buffer.from('{"expectedVersion":1,"x":"Bad'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]);
  assert.equal(reasonOf(admitStructure(ARCHIVE_CLIENT, raw({ body: invalid }), validator, clock)), "400 INVALID_REQUEST JSON_SYNTAX");
  const truncated = Buffer.concat([Buffer.from('{"displayName":"Caf'), Buffer.from([0xc3])]);
  assert.equal(reasonOf(admitStructure(CREATE_AGENCY, raw({ body: truncated, params: {} }), validator, clock)), "400 INVALID_REQUEST JSON_SYNTAX");
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"expectedVersion":1}')]);
  assert.equal(reasonOf(admitStructure(ARCHIVE_CLIENT, raw({ body: bom }), validator, clock)), "400 INVALID_REQUEST JSON_SYNTAX");
  const accented = admitStructure(CREATE_AGENCY, raw({ params: {}, headers: { "x-kauro-agency": undefined } }, { displayName: "Agência Ñandú 東京" }), validator, clock);
  assert.equal(accented.kind, "ADMITTED");
  if (accented.kind === "ADMITTED") assert.deepEqual(accented.admission.body, { displayName: "Agência Ñandú 東京" });
});

test("a charset parameter is accepted only as utf-8", () => {
  assert.equal(admitStructure(ARCHIVE_CLIENT, raw({ headers: { "content-type": "application/json; charset=utf-8" } }, { expectedVersion: 1 }), validator, clock).kind, "ADMITTED");
  assert.equal(reasonOf(admitStructure(ARCHIVE_CLIENT, raw({ headers: { "content-type": "application/json; charset=latin1" } }, { expectedVersion: 1 }), validator, clock)), "400 INVALID_REQUEST CONTENT_TYPE_UNSUPPORTED");
});
