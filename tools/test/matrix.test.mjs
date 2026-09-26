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

test("the committed matrix is the generated one and every source check passes: every edge of the 12 registry and 12 platform machines (B06: 2, B09: 10) is owned, every served command has its catalogue and its applicability row", () => {
  assert.deepEqual(checkSources(sources), []);
  assert.equal(readFileSync(MATRIX_PATH, "utf8"), generateMatrix(sources));
  assert.equal(sources.machines.length, 24);
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
