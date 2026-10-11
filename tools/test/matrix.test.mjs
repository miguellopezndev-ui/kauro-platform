// tools/matrix.mjs — the generated state/command/event matrix, error catalogue and contract-test applicability record (re-check
// finding N13): the committed document is the generated one, and the check refuses an unowned edge, an owner that names an
// unknown command or event, a served edge whose event its handler never publishes, and an applicability row whose citation does
// not resolve or that answers a mutation with neither tests nor a reason.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APPLICABILITY, EDGE_OWNERS, MATRIX_PATH, checkSources, generateMatrix, loadMatrixSources } from "../matrix.mjs";

const sources = await loadMatrixSources();
const clone = (v) => JSON.parse(JSON.stringify(v));

test("the committed matrix is the generated one and every source check passes: every edge of the 12 registry, 2 B06 platform, 4 B07 source-lifecycle, 10 B09 platform machines and the B11 SupportCase machine is owned, every served command has its catalogue and its applicability row, every specified B07 command and route its catalogue", () => {
  assert.deepEqual(checkSources(sources), []);
  assert.equal(readFileSync(MATRIX_PATH, "utf8"), generateMatrix(sources));
  assert.equal(sources.machines.length, 29);
  for (const id of Object.keys(sources.sourceSpecs)) assert.ok(generateMatrix(sources).includes(`### ${id} `), id);
  for (const id of sources.served) assert.ok(generateMatrix(sources).includes(`### ${id} `), id);
});

test("B09-F17: the CostGrant funding edge is not claimed by the payments package, which funds no cost grant (Q-B09-9)", () => {
  const edge = EDGE_OWNERS.CostGrant.actual_authorization_and_funding;
  assert.notEqual(edge.owner, "B09");
  assert.equal(edge.owner, "B03");
  assert.match(edge.why, /Q-B09-9/);
});

test("an unowned edge, an owner of an edge the machine does not list, an unknown command, an unregistered event and a served edge naming an event its handler never publishes fail the check", () => {
  const unowned = clone(EDGE_OWNERS);
  delete unowned.Plan.withdraw_plan;
  assert.deepEqual(checkSources(sources, unowned), ["Plan: withdraw_plan has no owner"]);
  const invented = clone(EDGE_OWNERS);
  invented.Plan.teleport = { owner: "B08", why: "none", event: null };
  assert.deepEqual(checkSources(sources, invented), ["Plan: the owner table names teleport, which the machine does not list"]);
  const unknown = clone(EDGE_OWNERS);
  unknown.Agency.agreements_and_profile_accepted = { command: "CMD999", event: "agency.activated.v1" };
  assert.deepEqual(checkSources(sources, unknown), ["Agency: agreements_and_profile_accepted names CMD999, which the registry does not have"]);
  const unregistered = clone(EDGE_OWNERS);
  unregistered.Job.provider_start_observed = { command: "CMD035", event: "job.cancel_requested.v1" };
  assert.deepEqual(checkSources(sources, unregistered), ["Job: provider_start_observed names job.cancel_requested.v1, which EVENT_TYPES does not register"]);
  const unpublished = clone(EDGE_OWNERS);
  unpublished.EndClient.archive_client = { command: "CMD010", event: "end_client.created.v1" };
  assert.deepEqual(checkSources(sources, unpublished), ["EndClient: archive_client says CMD010 publishes end_client.created.v1, which its handler never publishes"]);
});

test("an applicability row citing a test that does not exist, or answering a mutation with neither tests nor a reason, fails the check", () => {
  const missing = clone(APPLICABILITY);
  missing.CMD010["stale version"] = [["cmd010-archive-client.test.ts", "DENY: a title nobody wrote"]];
  assert.deepEqual(checkSources(sources, EDGE_OWNERS, missing), ['CMD010: "stale version" cites a test of cmd010-archive-client.test.ts starting "DENY: a title nobody wrote", which does not exist']);
  const unexplained = clone(APPLICABILITY);
  unexplained.CMD001["stale version"] = "not applicable";
  assert.deepEqual(checkSources(sources, EDGE_OWNERS, unexplained), ['CMD001: "stale version" is neither cited tests nor NOT_APPLICABLE with its reason']);
  const absent = clone(APPLICABILITY);
  delete absent.CMD026;
  assert.deepEqual(checkSources(sources, EDGE_OWNERS, absent), ["CMD026 is served but has no applicability row"]);
});

test("B07-COMMANDS: every specified source-lifecycle command is served with its applicability row, every source read is a served read and the intake a served intake — a command left unserved, a source read that is not a served read, an unserved intake and a missing applicability row fail the check", () => {
  const unserved = { ...sources, served: new Set([...sources.served].filter((id) => id !== "CMD017")) };
  assert.deepEqual(checkSources(unserved), ["CMD017 is specified but not served"]);
  const { GetInspection: _inspection, ...reads } = sources.reads;
  assert.deepEqual(checkSources({ ...sources, reads }), ["the source read GetInspection is not a served read"]);
  assert.deepEqual(checkSources({ ...sources, intakes: {} }), ["the source intake SubmitSelectionManifest is not a served intake"]);
  const absent = clone(APPLICABILITY);
  delete absent.CMD016;
  assert.deepEqual(checkSources(sources, EDGE_OWNERS, absent), ["CMD016 is served but has no applicability row"]);
});

test("B08-COMMANDS-AUDIT: the four audit commands are served, their events are read from the audit store and CMD022's handler, the decision artifact intake and GetAudit are served, and an edge naming an event the store never writes fails the check", () => {
  for (const id of ["CMD020", "CMD021", "CMD022", "CMD024"]) assert.ok(sources.served.has(id), id);
  assert.deepEqual([...sources.published.CMD020].sort(), ["audit.queued.v1", "cost_grant.authorized.v1", "cost_grant.prepared.v1"]);
  assert.deepEqual(sources.published.CMD021, ["audit.cancelled.v1"]);
  assert.deepEqual([...sources.published.CMD022].sort(), ["plan.created.v1", "plan.validation_required.v1"]);
  assert.deepEqual(sources.published.CMD024, ["plan.validating.v1"]);
  assert.ok("GetAudit" in sources.reads);
  assert.ok("SubmitDecisionArtifact" in sources.intakes);
  assert.equal(EDGE_OWNERS.Plan.valid_receipt.owner, "B08", "the receipt edges belong to PLAN_VALIDATION, not to the command that records the intent");
  assert.equal(EDGE_OWNERS.CostGrant["(initial PREPARED)"].command, "CMD020");
  const unpublished = clone(EDGE_OWNERS);
  unpublished.Plan.validation_admitted = { command: "CMD024", event: "plan.validated.v1" };
  assert.deepEqual(checkSources(sources, unpublished), ["Plan: validation_admitted says CMD024 publishes plan.validated.v1, which its handler never publishes"]);
  assert.deepEqual(checkSources({ ...sources, intakes: {} }), ["the source intake SubmitSelectionManifest is not a served intake"]);
});

// PV1R-05 (Codex r1 on db5f0e3): the Payments V1 Refund edges (DV1-08, ACH-ROUTE r12) are enumerated from the candidate's own machine,
// independently of the matrix tool's machine list, and each must have a truthful owner entry; the matrix check itself must complete.
// Truthful: an edge no served command performs names its owner lane with its reason ({ owner, why, event }), never a command; an edge
// that names a command names one the registry has, and if that command is served its handler publishes the edge's event.
const MANUAL_REFUND_EDGES = ["manual_execution_declared", "manual_execution_window_lapsed", "manual_return_recorded", "owner_attested_no_effect"];

test("PV1R-05 every Refund transition event of the candidate machine (@kauro/domain COMMERCE_PLATFORM_MACHINES) has a truthful owner entry: a registry command whose served handler publishes its event, or an owner lane with its reason; no Refund source diagnostic", async () => {
  const domain = await import(new URL("../../packages/domain/dist/src/index.js", import.meta.url).href);
  const refund = domain.COMMERCE_PLATFORM_MACHINES.find((m) => m.contract === "Refund");
  assert.ok(refund !== undefined, "the candidate declares the Refund machine");
  const events = [...new Set(refund.transitions.map((t) => t.event))];
  for (const e of MANUAL_REFUND_EDGES) assert.ok(events.includes(e), `the candidate's Refund machine lists ${e}`);
  assert.equal(refund.transitions.filter((t) => t.event === "manual_return_recorded").length, 2, "manual_return_recorded is two edges (SUBMITTING and UNCERTAIN)");
  const table = EDGE_OWNERS.Refund;
  assert.deepEqual(events.filter((e) => !(e in table)), [], "every Refund event has an entry in EDGE_OWNERS.Refund");
  for (const e of events) {
    const o = table[e];
    if (o.command !== undefined) {
      assert.ok(sources.commands.has(o.command), `Refund ${e}: ${o.command} is a registry command`);
      if (sources.served.has(o.command) && o.event !== null) assert.ok(sources.published[o.command].includes(o.event), `Refund ${e}: served ${o.command} publishes ${o.event}`);
      if (MANUAL_REFUND_EDGES.includes(e)) assert.ok(sources.served.has(o.command), `Refund ${e}: a manual edge credited to ${o.command} must be served (else name its owner lane)`);
    } else {
      assert.equal(typeof o.owner, "string", `Refund ${e}: names an owner`);
      assert.ok(typeof o.why === "string" && o.why.length > 0, `Refund ${e}: states why`);
    }
    assert.ok(o.event === null || sources.eventTypes.has(o.event), `Refund ${e}: event ${o.event} is registered or null`);
  }
  assert.deepEqual(checkSources(sources).filter((f) => f.startsWith("Refund")), [], "no Refund source diagnostic");
});

test("PV1R-05 pnpm run matrix completes: the generator renders every machine without an exception and `node tools/matrix.mjs check` exits 0 with no missing-owner diagnostic", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  let rendered = "";
  assert.doesNotThrow(() => {
    rendered = generateMatrix(sources);
  }, "generateMatrix renders the candidate's machines");
  assert.ok(rendered.includes("### Refund"), "the Refund machine is rendered");
  const run = spawnSync(process.execPath, ["tools/matrix.mjs", "check"], { cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8" });
  const output = `${run.stdout}\n${run.stderr}`;
  assert.doesNotMatch(output, /has no owner|TypeError/, "no missing-owner diagnostic and no generator exception");
  assert.equal(run.status, 0, `the matrix check exits 0:\n${output.slice(0, 2000)}`);
});
