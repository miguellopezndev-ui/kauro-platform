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

test("the committed matrix is the generated one and every source check passes: every edge of the 12 registry, 2 B06 platform and 4 B07 source-lifecycle machines is owned, every served command has its catalogue and its applicability row, every specified B07 command and route its catalogue", () => {
  assert.deepEqual(checkSources(sources), []);
  assert.equal(readFileSync(MATRIX_PATH, "utf8"), generateMatrix(sources));
  assert.equal(sources.machines.length, 18);
  for (const id of Object.keys(sources.sourceSpecs)) assert.ok(generateMatrix(sources).includes(`### ${id} `), id);
  for (const id of sources.served) assert.ok(generateMatrix(sources).includes(`### ${id} `), id);
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
  unregistered.Job.cancel_command = { command: "CMD037", event: "job.cancel_requested.v1" };
  assert.deepEqual(checkSources(sources, unregistered), ["Job: cancel_command names job.cancel_requested.v1, which EVENT_TYPES does not register"]);
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
