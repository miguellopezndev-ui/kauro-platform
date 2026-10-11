// UI18 Free data health check (design D-STATE-1, D-OPS-1, A3 3.2; registry "Review findings and decisions."). The decisions, the markup of
// every state (loading, empty, running, needs a decision, used-up allowance, unsupported, failed, cancelled, expired, denied, stale, error)
// and the one command, CMD021, through the real api client over a scripted fetch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SCHEMAS } from "../src/api/generated.ts";
import { validateAgainst } from "../src/api/schema-guard.ts";
import { OperationRunner } from "../src/client/operation-runner.ts";
import { loading, stateOfAnswer } from "../src/client/states.ts";
import { cancelHealthCheck, healthCheckModel } from "../src/screens/health-check/model.ts";
import { HealthCheckDetails, NoHealthCheck } from "../src/screens/health-check/view.tsx";
import { StatePanel } from "../src/screens/shared/state-panel.tsx";
import { audit, AUDIT, harness, problem, respond } from "./support/fixtures.ts";

const noop = (): void => undefined;
const render = (value = audit(), cancelling = false): string => renderToStaticMarkup(createElement(HealthCheckDetails, { audit: value, onRefresh: noop, onCancel: noop, cancelling }));
const panel = (decision: Parameters<typeof StatePanel>[0]["decision"]): string => renderToStaticMarkup(createElement(StatePanel, { decision, onNext: noop }));
const fastRunner = (): OperationRunner => new OperationRunner({ now: () => Date.parse("2026-10-14T00:00:00Z"), randomBytes: (n) => new Uint8Array(n).fill(3), wait: async () => undefined });

test("fixtures: the health check is valid against the generated schema", () => {
  assert.deepEqual(validateAgainst(SCHEMAS as never, "AuditView", audit()), []);
});

test("UI18: the page is the free data health check, never an audit, and says what it shows with the registry sentence", () => {
  const html = render();
  assert.ok(html.includes("Review findings and decisions."));
  assert.doesNotMatch(html, /\baudit|diagnos/i);
  for (const text of ["Reading the full data", "Finishes by", "Free check allowance", "In use"]) assert.ok(html.includes(text), text);
});

test("UI18: a running check says it runs on its own and offers a re-read and a cancel; it shows no finding it was not told", () => {
  const model = healthCheckModel(audit());
  assert.equal(model.running, true);
  assert.equal(model.canCancel, true);
  const html = render();
  assert.ok(html.includes("This runs on its own.") && html.includes("Check the status again") && html.includes("Cancel this check"));
  assert.ok(html.includes("No decision is waiting."));
});

test("UI18: decisions waiting and unsupported capabilities are listed as the api names them, separate from each other", () => {
  const html = render(audit({ state: "NEEDS_DECISION", pendingDecisions: ["CONFIRM_KEY_COLUMN", "CHOOSE_DATE_FORMAT"], unsupportedCapabilities: ["CUSTOM_OBJECTS"] }));
  const decisions = html.slice(html.indexOf("Decisions waiting for you"), html.indexOf("Not supported for this project"));
  assert.ok(decisions.includes("CONFIRM_KEY_COLUMN") && decisions.includes("CHOOSE_DATE_FORMAT") && !decisions.includes("CUSTOM_OBJECTS"));
  assert.ok(html.slice(html.indexOf("Not supported for this project")).includes("CUSTOM_OBJECTS"));
  assert.ok(html.includes("Needs your decisions"));
});

test("UI18: a used-up allowance keeps the profile and states that the interpretation is incomplete", () => {
  for (const grantState of ["EXHAUSTED", "EXPIRED"] as const) {
    const html = render(audit({ grantState, state: "NEEDS_DECISION" }));
    assert.ok(html.includes("The free allowance is used up") && html.includes("explicitly incomplete"), grantState);
  }
  assert.equal(healthCheckModel(audit({ grantState: "AUTHORIZED" })).interpretationIncomplete, false);
});

test("UI18: every state has its own plain label; an ended check offers no cancel and no re-read; a ready draft offers no cancel", () => {
  const states = ["QUEUED", "PROFILING", "INTERPRETING", "VALIDATING", "DRAFT_READY", "NEEDS_DECISION", "UNSUPPORTED", "FAILED", "CANCELLED", "EXPIRED"] as const;
  const seen = new Set<string>();
  for (const state of states) {
    const html = render(audit({ state, ...(state === "FAILED" ? { terminalReason: "SOURCE_UNREADABLE" } : {}) }));
    seen.add(/<span>([^<]+)<\/span><\/span>/.exec(html)?.[1] ?? "");
    const ended = ["UNSUPPORTED", "FAILED", "CANCELLED", "EXPIRED"].includes(state);
    assert.equal(html.includes("Cancel this check"), !ended && state !== "DRAFT_READY", state);
    assert.equal(html.includes("Check the status again"), !ended, state);
  }
  assert.equal(seen.size, states.length, "a person can tell the states apart");
  assert.ok(render(audit({ state: "FAILED", terminalReason: "SOURCE_UNREADABLE" })).includes("SOURCE_UNREADABLE"));
  assert.equal(healthCheckModel(audit({ permittedActions: [] })).canCancel, false, "the api does not permit it");
});

test("UI18: while cancelling the control is disabled and the page says not to repeat the step", () => {
  const html = render(audit(), true);
  assert.match(html, /<button[^>]*disabled[^>]*>Cancel this check<\/button>/);
  assert.ok(html.includes("Do not repeat this step."));
});

test("UI18: no check in the address is an empty state with no action to invent one", () => {
  const html = renderToStaticMarkup(createElement(NoHealthCheck));
  assert.ok(html.includes("No free data health check yet") && !html.includes("<button"));
});

test("UI18: loading, denied, stale, expired and error states are the shared ones, with their one next step and the support reference", () => {
  assert.ok(panel(loading()).includes("Fetching the current information."));
  const denied = panel(stateOfAnswer({ kind: "PROBLEM", status: 404, correlationId: "c", problem: problem(404, "NOT_FOUND") }));
  assert.ok(denied.includes("This is not available") && !denied.includes("<button"), "denied has no next step");
  const stale = panel(stateOfAnswer({ kind: "PROBLEM", status: 409, correlationId: "c", problem: problem(409, "STALE_VERSION") }));
  assert.ok(stale.includes("This changed while you were working") && stale.includes("Compare versions"));
  const expired = panel(stateOfAnswer({ kind: "PROBLEM", status: 422, correlationId: "c", problem: problem(422, "SOURCE_EXPIRED") }));
  assert.ok(expired.includes("This has expired") && expired.includes("Request a new review"));
  const broken = panel(stateOfAnswer({ kind: "INTEGRITY", status: 200, correlationId: "corr-1", failure: "REPLY_FAILED_CONTRACT" }));
  assert.ok(broken.includes("We could not verify this answer") && broken.includes("Support reference: corr-1"));
  assert.ok(panel(stateOfAnswer({ kind: "NO_ANSWER", reason: "NETWORK", status: null })).includes("We are checking the result"));
});

test("CMD021: cancel sends the audit's cancel version, and the same version is the same key (a second click, a reload, a second tab)", async () => {
  const cancelled = audit({ state: "CANCELLED" });
  const { client, sent } = harness(async () => respond(200, { kind: "COMPLETED", version: 3, replayed: false, data: cancelled }));
  const first = await cancelHealthCheck(client, fastRunner(), audit());
  const second = await cancelHealthCheck(client, fastRunner(), audit());
  assert.equal(first.kind, "COMPLETED");
  assert.equal(second.kind, "COMPLETED");
  assert.equal(sent[0]?.url, `/api/v1/audits/${AUDIT}/cancel`);
  assert.deepEqual(JSON.parse(sent[0]?.init.body ?? "{}"), { expectedVersion: 2 });
  assert.equal(sent[0]?.init.headers["Idempotency-Key"], sent[1]?.init.headers["Idempotency-Key"]);
});

test("CMD021: a lost answer is recovered by reading the check: CANCELLED is a success, otherwise it stays Checking under the same key", async () => {
  const cancelled = audit({ state: "CANCELLED" });
  const lostThenCancelled = harness(async (sent) => {
    if (sent.init.method === "POST") throw new TypeError("network");
    return respond(200, { kind: "READ", data: cancelled });
  });
  const recovered = await cancelHealthCheck(lostThenCancelled.client, fastRunner(), audit());
  assert.equal(recovered.kind, "RECOVERED");
  assert.equal(new Set(lostThenCancelled.sent.filter((entry) => entry.init.method === "POST").map((entry) => entry.init.headers["Idempotency-Key"])).size, 1);

  const lostStillRunning = harness(async (sent) => {
    if (sent.init.method === "POST") throw new TypeError("network");
    return respond(200, { kind: "READ", data: audit() });
  });
  const checking = await cancelHealthCheck(lostStillRunning.client, fastRunner(), audit());
  assert.equal(checking.kind, "CHECKING");
});

test("CMD021: a stale cancel version is a stale state with the comparison, and nothing is shown as cancelled", async () => {
  const { client } = harness(async () => respond(409, problem(409, "STALE_VERSION", { current: { version: 5, state: "DRAFT_READY" } })));
  const outcome = await cancelHealthCheck(client, fastRunner(), audit());
  assert.equal(outcome.kind, "PROBLEM");
});
