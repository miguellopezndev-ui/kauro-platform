// UI25 Processing and UI52 Support cases (design D-STATE-1, D-OPS-1, D-PRIV-1; registry "Your approved project is being prepared." and
// "Track your questions and next actions."). The decisions, the markup of every state and the three commands (CMD036 execute, CMD037 cancel,
// CMD044 open a case) through the real api client over a scripted fetch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SCHEMAS } from "../src/api/generated.ts";
import type { JobView, SupportCaseView } from "../src/api/generated.ts";
import { validateAgainst } from "../src/api/schema-guard.ts";
import { OperationRunner } from "../src/client/operation-runner.ts";
import { loading, stateOfAnswer } from "../src/client/states.ts";
import { EN } from "../src/copy/en.ts";
import { cancelJob, executeOffer, executeProject, jobModel, PHASE_ORDER } from "../src/screens/processing/model.ts";
import { ExecutePanel, NothingProcessing, ProcessingDetails } from "../src/screens/processing/view.tsx";
import { StatePanel } from "../src/screens/shared/state-panel.tsx";
import { caseSource, createdCase, createSupportCase, refusalOf, safeRoute, summaryProblem } from "../src/screens/support/model.ts";
import { CaseCreated, CaseForm, CaseList, CaseOrRefusal, ChooseProject } from "../src/screens/support/view.tsx";
import { PagedRead } from "../src/screens/shared/use-paged-read.ts";
import { harness, problem, respond } from "./support/fixtures.ts";
import { AGENCY, authorization, CASE, CASE_TWO, job, JOB, NOW_80_MIN, orderDetail, PLAN_HASH, PROJECT, QUEUED_AT, REVISION_HASH, SECRET_TEXT, supportCase } from "./support/fixtures-processing.ts";
import { screens as registryScreens } from "@kauro/contracts";

const noop = (): void => undefined;
const fastRunner = (): OperationRunner => new OperationRunner({ now: () => Date.parse("2026-10-14T00:00:00Z"), randomBytes: (n) => new Uint8Array(n).fill(3), wait: async () => undefined });
const SUPPORT_HREF = `/agencies/${AGENCY}/support?project=${PROJECT}`;
const details = (value: JobView, extra: { readonly cancelling?: boolean; readonly cancelRecorded?: boolean } = {}): string =>
  renderToStaticMarkup(createElement(ProcessingDetails, { job: value, nowMs: NOW_80_MIN, readAt: "2026-10-13T13:19:00Z", supportHref: SUPPORT_HREF, onRefresh: noop, onCancel: noop, cancelling: extra.cancelling ?? false, cancelRecorded: extra.cancelRecorded ?? false }));
const panel = (decision: Parameters<typeof StatePanel>[0]["decision"]): string => renderToStaticMarkup(createElement(StatePanel, { decision, onNext: noop }));
const current = { planHash: PLAN_HASH, revisionHash: REVISION_HASH };
const post = (sent: ReadonlyArray<{ readonly init: { readonly method?: string } }>) => sent.filter((entry) => entry.init.method === "POST");

test("fixtures: the job, the authorization, the order and the cases are valid against the generated schemas", () => {
  assert.deepEqual(validateAgainst(SCHEMAS as never, "JobView", job()), []);
  assert.deepEqual(validateAgainst(SCHEMAS as never, "CommercialAuthorizationView", authorization()), []);
  assert.deepEqual(validateAgainst(SCHEMAS as never, "PaymentOrderDetailView", orderDetail()), []);
  assert.deepEqual(validateAgainst(SCHEMAS as never, "SupportCaseView", supportCase()), []);
});

test("the screens say the registry's primary sentences word for word", () => {
  const registry = registryScreens() as unknown as readonly { readonly id: string; readonly primaryCopy: string }[];
  const sentence = (id: string): string | undefined => registry.find((row) => row.id === id)?.primaryCopy;
  assert.equal(EN["screen.processing.lead.body"], sentence("UI25"));
  assert.equal(EN["screen.support.lead.body"], sentence("UI52"));
  assert.ok(details(job()).includes("Your approved project is being prepared."));
});

test("UI25: queue, start, run, verify and publish are separate phases with elapsed time and last update; no progress percentage comes from a heartbeat", () => {
  const html = details(job({ state: "RUNNING", activeProviderState: "RUNNING" }));
  const order = ["Queue", "Startup", "Execution", "Verification", "Publication"].map((label) => html.indexOf(`>${label}<`));
  assert.ok(order.every((at) => at >= 0) && [...order].sort((a, b) => a - b).join() === order.join(), "five phases, in order, each its own item");
  assert.deepEqual(jobModel(job({ state: "RUNNING" }), NOW_80_MIN).phases, [
    { id: "QUEUE", status: "done" },
    { id: "START", status: "done" },
    { id: "RUN", status: "current" },
    { id: "VERIFY", status: "upcoming" },
    { id: "PUBLISH", status: "upcoming" },
  ]);
  assert.deepEqual(PHASE_ORDER, ["QUEUE", "START", "RUN", "VERIFY", "PUBLISH"]);
  // each in-progress state marks exactly its own phase, and only that one
  const marked = (state: JobView["state"]): string[] => (jobModel(job({ state }), NOW_80_MIN).phases ?? []).filter((phase) => phase.status === "current").map((phase) => phase.id);
  assert.deepEqual([marked("QUEUED"), marked("ADMITTED"), marked("RUNNING"), marked("VERIFYING")], [["QUEUE"], ["START"], ["RUN"], ["VERIFY"]]);
  assert.deepEqual(jobModel(job({ state: "READY", publishedPackageId: JOB }), NOW_80_MIN).phases?.map((phase) => phase.status), ["done", "done", "done", "done", "done"]);
  assert.equal(jobModel(job({ state: "READY" }), NOW_80_MIN).phases?.[4]?.status, "current", "ready without a published package is not published yet");
  // elapsed time and the last update are written; both are instants/durations, not a fraction
  assert.ok(html.includes("Elapsed time") && html.includes("1 h 20 min"), "80 minutes since the job was queued");
  assert.ok(html.includes("Last updated") && html.includes("13:19"));
  assert.ok(html.includes("Queued at") && html.includes("Delivery deadline"));
  // a heartbeat is a sign of life, labelled so, and never a percentage or a bar
  assert.ok(html.includes("Worker report") && html.includes("not how much work is done"));
  assert.doesNotMatch(html, /%|<progress|progressbar|aria-valuenow|style="[^"]*width/i);
  for (const state of ["QUEUED", "ADMITTED", "RUNNING", "VERIFYING", "READY", "FAILED", "CANCEL_REQUESTED", "CANCELLED", "EXPIRED"] as const) {
    assert.doesNotMatch(details(job({ state, activeProviderState: "LAUNCHING" })), /%|<progress|progressbar/i, state);
  }
  // an ended job states how it ended, shows no phase it may not have reached, no elapsed counter and no worker report
  for (const state of ["FAILED", "EXPIRED", "CANCELLED", "CANCEL_REQUESTED"] as const) {
    const ended = details(job({ state, activeProviderState: "RUNNING" }));
    assert.ok(!ended.includes("Verification") && !ended.includes("Elapsed time") && !ended.includes("Worker report"), state);
    assert.ok(ended.includes("Open support") && ended.includes("/support?project="), `${state}: the next action is support`);
  }
  assert.ok(details(job({ state: "FAILED" })).includes("This did not finish"));
  assert.ok(details(job({ state: "EXPIRED" })).includes("delivery window ended"));
  assert.equal(jobModel(job({ state: "FAILED" }), NOW_80_MIN).elapsedMs, null);
  assert.equal(jobModel(job({ state: "QUEUED", queuedAt: QUEUED_AT }), Date.parse(QUEUED_AT) - 5_000).elapsedMs, 0, "a clock behind the server never shows negative time");
});

test("UI25/R2-063: execute is offered only for an ACTIVE commercial authorization whose planHash and revisionHash match the project's current approved plan; a newer unapproved revision is stale with no execute control", async () => {
  const markup = (offer: ReturnType<typeof executeOffer>): string => renderToStaticMarkup(createElement(ExecutePanel, { offer, onExecute: noop, executing: false }));
  assert.deepEqual(executeOffer(authorization(), current, false), { kind: "OFFER" });
  assert.ok(/<button[^>]*>Start processing<\/button>/.test(markup(executeOffer(authorization(), current, false))));
  // a newer revision (or plan) that is not the one paid for: stale, and not one control
  for (const moved of [{ ...current, revisionHash: "c".repeat(64) }, { ...current, planHash: "d".repeat(64) }]) {
    const offer = executeOffer(authorization(), moved, false);
    assert.deepEqual(offer, { kind: "STALE" });
    const html = markup(offer);
    assert.ok(html.includes("A newer revision is not approved") && !html.includes("<button"));
  }
  // anything but ACTIVE, a plan that could not be confirmed, or a job that already exists: nothing to press
  for (const state of ["CONSUMED", "DELIVERED", "REVOKED"] as const) assert.deepEqual(executeOffer(authorization({ state }), current, false), { kind: "NONE" }, state);
  assert.deepEqual(executeOffer(authorization(), null, false), { kind: "NONE" });
  assert.deepEqual(executeOffer(authorization(), current, true), { kind: "NONE" });
  assert.deepEqual(executeOffer(null, current, false), { kind: "NONE" });
  assert.ok(!markup({ kind: "NONE" }).includes("<button"));
  assert.match(renderToStaticMarkup(createElement(ExecutePanel, { offer: { kind: "OFFER" }, onExecute: noop, executing: true })), /<button[^>]*disabled[^>]*>Start processing<\/button>/);
  // CMD036: the authorization's version is the key; a second click, a reload and a second tab send the same key and the same authorization
  const { client, sent } = harness(async () => respond(202, { kind: "ACCEPTED", operationId: JOB, state: "QUEUED", statusPath: `/api/v1/jobs/${JOB}`, pollAfterSeconds: 5 }));
  const first = await executeProject(client, fastRunner(), PROJECT, authorization());
  const second = await executeProject(client, fastRunner(), PROJECT, authorization());
  assert.equal(first.kind, "ACCEPTED");
  assert.equal(first.kind === "ACCEPTED" ? first.accepted.operationId : null, JOB);
  assert.equal(second.kind, "ACCEPTED");
  assert.equal(sent[0]?.url, `/api/v1/projects/${PROJECT}/execute`);
  assert.deepEqual(JSON.parse(sent[0]?.init.body ?? "{}"), { commercialAuthorizationId: authorization().authorizationId });
  assert.equal(sent[0]?.init.headers["Idempotency-Key"], sent[1]?.init.headers["Idempotency-Key"]);
  // a plan that moved is the server's PRECONDITION_FAILED: stale, shown as the shared state, never as started
  const refused = harness(async () => respond(409, problem(409, "PRECONDITION_FAILED", { reason: "PLAN_NOT_APPROVED", current: { version: 4, state: "SUPERSEDED" } })));
  const outcome = await executeProject(refused.client, fastRunner(), PROJECT, authorization());
  assert.equal(outcome.kind, "PROBLEM");
  assert.ok(panel(stateOfAnswer({ kind: "PROBLEM", status: 409, correlationId: "c", problem: problem(409, "PRECONDITION_FAILED", { reason: "PLAN_NOT_APPROVED" }) })).includes("This changed while you were working"));
});

test("UI25/CMD037: cancel explains the current phase, runs once under the job's cancel version, and the durable result is read back after a lost answer", async () => {
  // the explanation is the one of the phase the job is in, and only a permitted, unended job has a cancel control
  const explained = new Set<string>();
  for (const [state, phrase] of [["QUEUED", "removes it from the queue"], ["ADMITTED", "before any customer data is processed"], ["RUNNING", "the current step may finish first"], ["VERIFYING", "before publication"]] as const) {
    const html = details(job({ state }));
    assert.ok(html.includes(phrase), state);
    assert.match(html, /<button[^>]*>Cancel processing<\/button>/);
    explained.add(phrase);
  }
  assert.equal(explained.size, 4);
  assert.equal(jobModel(job({ permittedActions: [] }), NOW_80_MIN).canCancel, false, "the api does not permit it");
  for (const state of ["READY", "FAILED", "CANCEL_REQUESTED", "CANCELLED", "EXPIRED"] as const) assert.ok(!details(job({ state })).includes("Cancel processing"), state);
  assert.match(details(job(), { cancelling: true }), /<button[^>]*disabled[^>]*>Cancel processing<\/button>/);
  assert.ok(details(job(), { cancelling: true }).includes("Do not repeat this step."));
  // once under the job's cancel version: a second click, a reload and a second tab are one key; the body names the job's own version
  const cancelled = job({ state: "CANCEL_REQUESTED", version: 4, cancelVersion: 1, permittedActions: [] });
  const { client, sent } = harness(async () => respond(200, { kind: "COMPLETED", version: 4, replayed: false, data: cancelled }));
  const [one, two] = await Promise.all([cancelJob(client, fastRunner(), job()), cancelJob(client, fastRunner(), job())]);
  assert.equal(one.kind, "COMPLETED");
  assert.equal(two.kind, "COMPLETED");
  assert.equal(sent[0]?.url, `/api/v1/jobs/${JOB}/cancel`);
  assert.deepEqual(JSON.parse(sent[0]?.init.body ?? "{}"), { expectedVersion: 3, reasonCode: "CUSTOMER_REQUEST" });
  assert.equal(new Set(post(sent).map((entry) => (entry as { init: { headers: Record<string, string> } }).init.headers["Idempotency-Key"])).size, 1);
  const other = await cancelJob(client, fastRunner(), job({ cancelVersion: 5 }));
  assert.equal(other.kind, "COMPLETED");
  assert.notEqual(sent[sent.length - 1]?.init.headers["Idempotency-Key"], sent[0]?.init.headers["Idempotency-Key"], "another cancel version is another intent");
  // a lost answer: the same key is retried, then the job is read; a recorded cancellation is a success, anything else stays Checking
  const lostThenRecorded = harness(async (entry) => {
    if (entry.init.method === "POST") throw new TypeError("network");
    return respond(200, { kind: "READ", data: cancelled });
  });
  const recovered = await cancelJob(lostThenRecorded.client, fastRunner(), job());
  assert.equal(recovered.kind, "RECOVERED");
  assert.equal(new Set(post(lostThenRecorded.sent).map((entry) => (entry as { init: { headers: Record<string, string> } }).init.headers["Idempotency-Key"])).size, 1);
  assert.ok(lostThenRecorded.sent.some((entry) => entry.url === `/api/v1/jobs/${JOB}`), "the job is read back");
  const lostStillRunning = harness(async (entry) => {
    if (entry.init.method === "POST") throw new TypeError("network");
    return respond(200, { kind: "READ", data: job() });
  });
  assert.equal((await cancelJob(lostStillRunning.client, fastRunner(), job())).kind, "CHECKING");
  // the job moved meanwhile: stale, with the comparison, and nothing is shown as cancelled
  const stale = harness(async () => respond(409, problem(409, "STALE_VERSION", { current: { version: 5, state: "VERIFYING" } })));
  const refused = await cancelJob(stale.client, fastRunner(), job());
  assert.equal(refused.kind, "PROBLEM");
  assert.ok(panel(stateOfAnswer({ kind: "PROBLEM", status: 409, correlationId: "c", problem: problem(409, "STALE_VERSION") })).includes("Compare versions"));
  assert.ok(details(cancelled, { cancelRecorded: true }).includes("The cancellation was recorded."));
});

test("UI25: nothing in the address is an empty state with no control, and loading, denied and expired are the shared states", () => {
  const html = renderToStaticMarkup(createElement(NothingProcessing));
  assert.ok(html.includes("Nothing is being processed yet") && !html.includes("<button"));
  assert.ok(panel(loading()).includes("Fetching the current information."));
  const denied = panel(stateOfAnswer({ kind: "PROBLEM", status: 403, correlationId: "c", problem: problem(403, "NOT_AUTHORIZED") }));
  assert.ok(!denied.includes("<button"));
  assert.ok(panel(stateOfAnswer({ kind: "NO_ANSWER", reason: "NETWORK", status: null })).includes("We are checking the result"));
  assert.ok(panel(stateOfAnswer({ kind: "INTEGRITY", status: 200, correlationId: "corr-1", failure: "REPLY_FAILED_CONTRACT" })).includes("Support reference: corr-1"));
});

const formHtml = (overrides: Partial<Parameters<typeof CaseForm>[0]> = {}): string =>
  renderToStaticMarkup(createElement(CaseForm, { category: "GENERAL", summary: "", onCategory: noop, onSummary: noop, onSubmit: noop, submitting: false, summaryProblem: null, refusal: null, ...overrides }));

test("UI52/CMD044: the form warns against secrets and CRM rows, shows the SECURE_UPLOAD refusal with its route, and a lost answer shows the created case with its next response time", async () => {
  // the warning and the attachments policy are on the form before anything is typed
  const html = formHtml();
  assert.ok(html.includes("Do not send secrets or customer records here") && html.includes("rows from a CRM or spreadsheet"));
  assert.ok(html.includes("Files go through the secure upload"));
  assert.equal(summaryProblem("too short"), "SHORT");
  assert.equal(summaryProblem(" ".repeat(30)), "SHORT");
  assert.equal(summaryProblem("x".repeat(4001)), "LONG");
  assert.equal(summaryProblem("How do I import the cleaned file?"), null);
  assert.ok(formHtml({ summaryProblem: "SHORT" }).includes("Write at least 20 characters."));
  // the refusal: the server names the route; the text stays in the form for the person to edit; nothing was sent twice
  const route = `/agencies/${AGENCY}/projects/${PROJECT}/sources`;
  const refusedAnswer = problem(422, "CONTENT_REFUSED", { reason: "SECRET_LIKE_CONTENT", nextActions: [{ action: "SECURE_UPLOAD", href: route }] });
  const refused = harness(async () => respond(422, refusedAnswer));
  // the form opened earlier, with its own entropy: a key minted again at submit time would differ
  const form = new OperationRunner({ now: () => Date.parse("2026-10-13T12:00:00Z"), randomBytes: (n) => new Uint8Array(n).fill(9), wait: async () => undefined }).openForm("CMD044");
  const input = { category: "BILLING", summary: `my key is ${SECRET_TEXT} please help` } as const;
  const outcome = await createSupportCase(refused.client, fastRunner(), form, PROJECT, input, new Set());
  assert.equal(outcome.kind, "PROBLEM");
  assert.equal(post(refused.sent).length, 1, "a refusal is definitive: no retry");
  const refusal = refusalOf(outcome);
  assert.deepEqual(refusal, { reason: "SECRET_LIKE_CONTENT", route });
  const refusedHtml = formHtml({ summary: input.summary, refusal });
  assert.ok(refusedHtml.includes("This text was not accepted") && refusedHtml.includes(`href="${route}"`) && refusedHtml.includes("Go to the secure upload"));
  assert.ok(refusedHtml.includes("SECRET_LIKE_CONTENT"));
  assert.ok(refusedHtml.includes(SECRET_TEXT), "the person's own text stays in the form");
  assert.ok(!formHtml({ refusal: { reason: null, route: null } }).includes("<a "), "no route named, no link");
  // a route that is not an application path is never a link
  for (const bad of ["javascript:alert(1)", "//evil.example/upload", "https://evil.example/", "/\\evil", "data:text/html,x", undefined]) assert.equal(safeRoute(bad), null, String(bad));
  assert.equal(safeRoute(route), route);
  assert.equal(refusalOf({ ...outcome, kind: "CHECKING", attempts: 1, lastRead: "NOT_YET" } as never), null);
  // a lost answer: the same key goes again and the server replays the one case, which is shown with its next response time
  const created = supportCase({ caseId: CASE_TWO, summary: "How do I import the cleaned companies file into my CRM sandbox?" });
  const lost = harness(async (_entry, index) => (index === 0 ? Promise.reject(new TypeError("network")) : respond(201, { kind: "COMPLETED", version: 1, replayed: true, data: created })));
  const replayed = await createSupportCase(lost.client, fastRunner(), form, PROJECT, { category: created.category, summary: created.summary }, new Set([CASE]));
  assert.equal(replayed.kind, "COMPLETED");
  assert.equal(createdCase(replayed)?.caseId, CASE_TWO);
  const keys = post(lost.sent).map((entry) => (entry as { init: { headers: Record<string, string> } }).init.headers["Idempotency-Key"]);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], "the same key");
  assert.equal(keys[0], form.key, "the key the form minted when it opened");
  assert.equal(lost.sent[0]?.url, `/api/v1/projects/${PROJECT}/support-cases`);
  const shown = renderToStaticMarkup(createElement(CaseCreated, { item: created, listHref: SUPPORT_HREF }));
  assert.ok(shown.includes("Your case is open") && shown.includes("Next response by") && shown.includes("Oct 14, 2026, 10:00 AM GMT-5"), "the next response time is written");
  // every retry lost: the project's cases are read back; only a case that was not there before counts, so an older identical case is never claimed
  const allLost = (listed: SupportCaseView[]) =>
    harness(async (entry) => {
      if (entry.init.method === "POST") throw new TypeError("network");
      return respond(200, { kind: "READ", data: { items: listed } });
    });
  const found = allLost([created, supportCase()]);
  const recovered = await createSupportCase(found.client, fastRunner(), form, PROJECT, { category: created.category, summary: created.summary }, new Set([CASE]));
  assert.equal(recovered.kind, "RECOVERED");
  assert.equal(createdCase(recovered)?.caseId, CASE_TWO);
  const older = allLost([created]);
  const checking = await createSupportCase(older.client, fastRunner(), form, PROJECT, { category: created.category, summary: created.summary }, new Set([CASE_TWO]));
  assert.equal(checking.kind, "CHECKING", "the matching case was already listed before: it is not this one");
  const unread = allLost([created]);
  assert.equal((await createSupportCase(unread.client, fastRunner(), form, PROJECT, { category: created.category, summary: created.summary }, null)).kind, "CHECKING", "no earlier list, no guess");
  assert.ok(panel(stateOfAnswer({ kind: "NO_ANSWER", reason: "NETWORK", status: null })).includes("Check again"));
});

test("UI52 DENY: a revoked member's case link shows the server's refusal and no case text", () => {
  const caseWithText = supportCase({ summary: `Please look at ${SECRET_TEXT} in the export` });
  const backHref = SUPPORT_HREF;
  const render = (answer: Parameters<typeof CaseOrRefusal>[0]["answer"]): string => renderToStaticMarkup(createElement(CaseOrRefusal, { answer, backHref, onNext: noop }));
  // a member sees the case
  const open = render({ kind: "REPLY", status: 200, correlationId: "c", body: { kind: "READ", data: caseWithText } });
  assert.ok(open.includes(SECRET_TEXT) && open.includes("What you wrote"));
  // revoked or not a member: the server's refusal (403 or 404), drawn as the shared denied state, with none of the case
  for (const [status, code, reason] of [[403, "NOT_AUTHORIZED", "MEMBERSHIP_NOT_ACTIVE"], [403, "NOT_AUTHORIZED", "NOT_A_MEMBER"], [404, "NOT_FOUND", undefined]] as const) {
    const html = render({ kind: "PROBLEM", status, correlationId: "c", problem: problem(status, code, reason === undefined ? {} : { reason }) });
    assert.ok(html.includes('data-state="DENIED"') && html.includes("This is not available"), `${status} ${reason ?? ""}`);
    assert.ok(!html.includes(SECRET_TEXT) && !html.includes("What you wrote") && !html.includes("Open case") && !html.includes("<button"), "no case text, no case control");
  }
  // the previous private view is cleared while the next read is in flight
  assert.ok(!panel(loading()).includes(SECRET_TEXT));
  // a sign-in is asked for on 401, a lost answer is Checking: neither draws a case
  assert.ok(render({ kind: "PROBLEM", status: 401, correlationId: "c", problem: problem(401, "AUTHENTICATION_REQUIRED") }).includes("Sign in"));
  assert.ok(!render({ kind: "NO_ANSWER", reason: "NETWORK", status: null }).includes(SECRET_TEXT));
  assert.ok(!render({ kind: "INTEGRITY", status: 200, correlationId: "corr-9", failure: "REPLY_FAILED_CONTRACT" }).includes(SECRET_TEXT));
});

test("UI52: cases are listed per project with status and next response, from the server's cursor only, and an empty project says so", async () => {
  const cursor = `abcdefgh.${"A".repeat(43)}`;
  const list = harness(async (_entry, index) =>
    index === 0 ? respond(200, { kind: "READ", data: { items: [supportCase()], nextCursor: cursor } }) : respond(200, { kind: "READ", data: { items: [supportCase({ caseId: CASE_TWO, state: "WAITING_AGENCY" })] } }),
  );
  const read = new PagedRead(caseSource(list.client, PROJECT));
  await read.first();
  await read.more();
  assert.equal(list.sent[0]?.url, `/api/v1/projects/${PROJECT}/support-cases?limit=20`);
  assert.equal(list.sent[1]?.url, `/api/v1/projects/${PROJECT}/support-cases?limit=20&cursor=${cursor}`);
  assert.equal(read.state.items.length, 2);
  assert.equal(read.state.hasMore, false);
  const html = renderToStaticMarkup(createElement(CaseList, { cases: read.state.items, hasMore: false, loading: false, onMore: noop, caseHref: (id) => `/agencies/${AGENCY}/support?case=${id}` }));
  assert.ok(html.includes("Something else") === false && html.includes("Help with an import") && html.includes("Waiting for you") && html.includes("Next response by"));
  assert.ok(html.includes(`support?case=${CASE_TWO}`));
  assert.ok(renderToStaticMarkup(createElement(CaseList, { cases: [], hasMore: false, loading: false, onMore: noop, caseHref: () => "/" })).includes("No cases yet"));
  assert.ok(renderToStaticMarkup(createElement(ChooseProject)).includes("Choose a project"));
  assert.ok(renderToStaticMarkup(createElement(CaseList, { cases: read.state.items, hasMore: true, loading: false, onMore: noop, caseHref: () => "/" })).includes("Show more cases"));
});
