// Package B12 kit K2: every B12 route is registered once (specs, closed request schemas, views, outcome catalogues, served lists) and bound to
// a NOT_BUILT stub, so the lanes replace handler bodies only. The four catalogue commands equal their registry rows; the operations no
// catalogue id names are exactly the domain's B12_OPERATIONS minus the producer operations (L-OWNER, GAP: no designed wire shape yet).
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS } from "@kauro/contracts";
import { B12_OUTREACH_OPERATIONS, B12_PRODUCER_OPERATIONS } from "@kauro/domain";
import {
  B12_SERVED_READ_IDS,
  COMMERCIAL_COMMANDS,
  COMMERCIAL_COMMAND_EVENTS,
  COMMERCIAL_COMMAND_OUTCOMES,
  COMMERCIAL_COMMAND_RESPONSES,
  COMMERCIAL_READ_OUTCOMES,
  COMMERCIAL_READ_ROUTES,
  COMMERCIAL_REQUEST_SCHEMAS,
  COMMERCIAL_SERVED_COMMAND_IDS,
  COMMERCIAL_SERVED_READ_IDS,
  OutreachNotBuilt,
  createOutreachStubCommandHandlers,
  createOutreachStubReadHandlers,
  isB12CommercialCommand,
  isB12RegistryLessOperation,
} from "../src/index.js";

const CATALOGUE = ["CMD061", "CMD062", "CMD063", "CMD064"] as const;

test("CMD061..CMD064 equal their registry rows: name, method, path, role, gate G-UX_PRIVATE, REQUIRED idempotency and the fields in order (CMD062 adds assuranceProofRef, decision K2-3)", () => {
  for (const id of CATALOGUE) {
    const row = COMMANDS.find((c) => c.id === id);
    assert.ok(row, id);
    const spec = COMMERCIAL_COMMANDS[id];
    assert.deepEqual([spec.id, spec.name, spec.method, spec.path, spec.role], [row.id, row.name, row.method, row.path, row.role], id);
    assert.equal(row.gate, "G-UX_PRIVATE", id);
    assert.equal(row.idempotency, "REQUIRED", id);
    const registryFields = row.fields.map((f) => f.name);
    const expected = id === "CMD062" ? [...registryFields, "assuranceProofRef"] : registryFields;
    assert.deepEqual([...spec.fields], expected, `${id} fields`);
  }
  assert.equal(COMMERCIAL_COMMANDS.CMD062.stepUp, true, "AuthorizeOutreach demands a fresh step-up (plan A16)");
});

test("the registry-less operations are exactly the outreach operations of the domain; the producer operations are a recorded GAP (no route, no spec)", () => {
  const registryLess = Object.keys(COMMERCIAL_COMMANDS).filter((id) => isB12RegistryLessOperation(id));
  assert.deepEqual(registryLess.sort(), [...B12_OUTREACH_OPERATIONS].filter((op) => !(CATALOGUE as ReadonlyArray<string>).includes(op)).sort());
  for (const op of B12_PRODUCER_OPERATIONS) assert.equal(isB12CommercialCommand(op), false, `${op} is L-OWNER's and has no designed wire shape`);
  for (const id of registryLess) assert.equal(COMMANDS.some((c) => c.id === id || c.name === id), false, `${id} has no registry row`);
});

test("every B12 command and read is served and carries a spec, a closed request schema, a reply, an outcome catalogue and its events", () => {
  const ids = Object.keys(COMMERCIAL_COMMANDS).filter(isB12CommercialCommand);
  assert.equal(ids.length, 15);
  for (const id of ids) {
    assert.ok((COMMERCIAL_SERVED_COMMAND_IDS as ReadonlyArray<string>).includes(id), `${id} served`);
    assert.ok(id in COMMERCIAL_REQUEST_SCHEMAS, `${id} request schema`);
    assert.ok(id in COMMERCIAL_COMMAND_RESPONSES, `${id} reply`);
    assert.ok(COMMERCIAL_COMMAND_OUTCOMES[id as keyof typeof COMMERCIAL_COMMAND_OUTCOMES].length > 0, `${id} outcomes`);
    assert.ok(id in COMMERCIAL_COMMAND_EVENTS, `${id} events`);
    const spec = COMMERCIAL_COMMANDS[id as keyof typeof COMMERCIAL_COMMANDS];
    if (spec.aggregateParam !== null) assert.ok(spec.path.includes(`{${spec.aggregateParam}}`), id);
    else assert.ok(!spec.path.includes("{"), id);
  }
  assert.deepEqual(COMMERCIAL_COMMAND_EVENTS.CMD063, ["outreach.send_intended.v1"], "the send publishes the intent event, every other B12 command none");
  for (const read of B12_SERVED_READ_IDS) {
    assert.ok((COMMERCIAL_SERVED_READ_IDS as ReadonlyArray<string>).includes(read), `${read} served`);
    assert.ok(COMMERCIAL_READ_OUTCOMES[read].length > 0, `${read} outcomes`);
    assert.ok(COMMERCIAL_READ_ROUTES[read].path.startsWith("/api/v1/ops/"), read);
  }
});

test("every B12 handler is a NOT_BUILT stub that rejects with OutreachNotBuilt and touches nothing", async () => {
  const commands = createOutreachStubCommandHandlers();
  assert.equal(Object.keys(commands).length, 15);
  for (const [id, handler] of Object.entries(commands)) {
    assert.equal(handler.spec.id, id);
    assert.equal(handler.admission.path, handler.spec.path);
    await assert.rejects(() => handler.execute({} as never), OutreachNotBuilt, id);
  }
  const reads = createOutreachStubReadHandlers();
  assert.equal(Object.keys(reads).length, 5);
  for (const [id, handler] of Object.entries(reads)) {
    assert.equal(handler.operationId, id);
    await assert.rejects(() => handler.execute({} as never), OutreachNotBuilt, id);
  }
});
