// Order 24: the private web wired to the api's real reads. (1) The project a page is inside comes from GetProject and the agency's client
// list, so the project header and the project's areas in the menu are drawn from the api, never from the address alone; a foreign, missing
// or unreadable project leaves the frame's fallback (no project). (2) "Clean your data" under the O19A candidate (CP-02.01): a CLEAN audit
// without targetContractId is an INTEGRITY answer against the served contract and a readable audit against the candidate's AuditView, which
// the audit page uses only when the deployment switched the candidate on; the empty state of a CLEAN project asks for no destination.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OPERATIONS } from "../src/api/generated.ts";
import { CANDIDATE_CLEAN_SCHEMAS } from "../src/api/candidate-schemas.ts";
import { message } from "../src/copy/en.ts";
import { NoHealthCheck } from "../src/screens/health-check/view.tsx";
import { readProjectOfPage } from "../src/shell/project-of-page.ts";
import { viewOf } from "../src/shell/view.ts";
import { AGENCY, AUDIT, PROJECT, audit, harness, respond } from "./support/fixtures.ts";
import { project } from "./support/fixtures-sources.ts";
import { ProjectList } from "../src/screens/projects/view.tsx";
import { groupOf, projectHref, projectSource, stageHref } from "../src/screens/projects/model.ts";
import type { AgencyMembershipView, ProjectDashboardItem } from "../src/api/generated.ts";
import { AgencySwitcher } from "../src/screens/switcher/view.tsx";
import { membershipSource } from "../src/screens/switcher/container.tsx";
import { dashboardRowOf } from "../src/screens/overview/model.ts";
import { OverviewDetails } from "../src/screens/overview/view.tsx";
import { cancelHealthCheck, noDestinationNeeded, readCancelled } from "../src/screens/health-check/model.ts";

const CLIENT = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb9";
const OTHER_CLIENT = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fba";
const client = (clientId: string, displayName: string) => ({ clientId, agencyId: AGENCY, version: 1, displayName, state: "ACTIVE", processingAuthorityRef: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fbb", createdAt: "2026-10-01T10:00:00Z", permittedActions: [] });
const CURSOR = `pagetwo1.${"c".repeat(43)}`;
const read = (data: unknown) => respond(200, { kind: "READ", data });

test("O24: the project of the page is read from GetProject and the agency's clients (paged until found): its purpose, its client's name and its service", async () => {
  const { client: api, sent } = harness((s) => {
    if (s.url.startsWith(`/api/v1/projects/${PROJECT}`)) return read(project({ clientId: CLIENT, mode: "CLEAN", purpose: "Spring cleanup" }));
    if (s.url.includes(`cursor=${CURSOR}`)) return read({ items: [client(CLIENT, "Larch Studio")] });
    return read({ items: [client(OTHER_CLIENT, "Someone else")], nextCursor: CURSOR });
  });
  const read1 = await readProjectOfPage(api, AGENCY, PROJECT);
  assert.deepEqual(read1, { projectId: PROJECT, name: "Spring cleanup", clientLabel: "Larch Studio", mode: "CLEAN" });
  assert.deepEqual(sent.map((s) => s.url.split("?")[0]), [`/api/v1/projects/${PROJECT}`, `/api/v1/agencies/${AGENCY}/clients`, `/api/v1/agencies/${AGENCY}/clients`]);

  // the shell then nests the project's areas for its service under Projects and names the project in the header
  const view = viewOf({ phase: { kind: "SIGNED_IN" } as never, agency: { kind: "READY", agencyId: AGENCY, displayName: "Agency", state: "ACTIVE", role: "OWNER" } as never, pathname: `/agencies/${AGENCY}/projects/${PROJECT}/audit`, activeAgency: AGENCY, ...(read1 === null ? {} : { project: read1 }) });
  assert.deepEqual([view.project?.name, view.project?.clientLabel, view.project?.mode], ["Spring cleanup", "Larch Studio", "CLEAN"]);
});

test("O24: a project of another agency, a missing client, or a refused read leaves the project unknown (the frame's fallback), never a guessed name", async () => {
  const foreign = harness((s) => (s.url.startsWith("/api/v1/projects/") ? read(project({ agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fbc" })) : read({ items: [] })));
  assert.equal(await readProjectOfPage(foreign.client, AGENCY, PROJECT), null);
  assert.equal(foreign.sent.length, 1, "no client list is read for a foreign project");
  const missing = harness((s) => (s.url.startsWith("/api/v1/projects/") ? read(project({ clientId: CLIENT })) : read({ items: [client(OTHER_CLIENT, "Someone else")] })));
  assert.equal(await readProjectOfPage(missing.client, AGENCY, PROJECT), null);
  const refused = harness(() => respond(404, { type: "urn:kauro:problem:NOT_FOUND", title: "x", status: 404, code: "NOT_FOUND", correlationId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f99", retryable: false, nextActions: [] }));
  assert.equal(await readProjectOfPage(refused.client, AGENCY, PROJECT), null);
});

test("O24 + CP-02.01: a CLEAN audit without targetContractId fails the served contract and reads under the candidate's AuditView only", async () => {
  const { targetContractId: _none, ...clean } = audit();
  const served = harness(() => read(clean));
  const answer = await served.client.call("GetAudit", { path: { auditId: AUDIT } });
  assert.equal(answer.kind, "INTEGRITY", "the served contract requires targetContractId");
  const candidate = harness(() => read(clean));
  const switched = await candidate.client.send(OPERATIONS.GetAudit, { path: { auditId: AUDIT } }, CANDIDATE_CLEAN_SCHEMAS);
  assert.equal(switched.kind, "REPLY");
  // the candidate table is the served one but for that member: a CRM audit with its target reads the same under both
  const crm = harness(() => read(audit()));
  assert.equal((await crm.client.send(OPERATIONS.GetAudit, { path: { auditId: AUDIT } }, CANDIDATE_CLEAN_SCHEMAS)).kind, "REPLY");
});

test("O24: the empty health check of a CLEAN project asks for confirmed files only, never a destination", () => {
  const crm = renderToStaticMarkup(createElement(NoHealthCheck));
  const clean = renderToStaticMarkup(createElement(NoHealthCheck, { clean: true }));
  assert.ok(crm.includes(message("screen.health.none.body")));
  assert.ok(clean.includes(message("screen.health.none.clean.body")));
  assert.ok(!clean.includes("destination is set"));
});

// --- UI11 Projects: ListProjects, grouped for the reader -----------------------------------------------------------------------------
const dashboard = (overrides: Partial<ProjectDashboardItem> = {}): ProjectDashboardItem => ({
  projectId: PROJECT,
  clientId: CLIENT,
  clientLabel: "Larch Studio",
  mode: "HUBSPOT",
  revision: { revisionId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fbd", state: "SEALED" },
  phase: "HEALTH_CHECK",
  requiredAction: "START_HEALTH_CHECK",
  deadline: null,
  lastActivityAt: "2026-10-20T10:00:00Z",
  version: 3,
  ...overrides,
});

test("O24 UI11: the agency's projects come from ListProjects (keyset-paged) and are grouped: needs a step, Kauro is working, completed", async () => {
  const { client: api, sent } = harness(() => read({ items: [dashboard()] }));
  for (const filter of ["active", "failed", "delivered"] as const) {
    const answer = await projectSource(api, AGENCY, filter).load(null, new AbortController().signal);
    assert.equal(answer.kind, "REPLY");
  }
  assert.deepEqual(sent.map((s) => s.url), ["active", "failed", "delivered"].map((f) => `/api/v1/agencies/${AGENCY}/projects?limit=50&filter=${f}`), "one server filter per group");
  assert.deepEqual(
    [dashboard(), dashboard({ phase: "PROCESSING", requiredAction: "NONE" }), dashboard({ phase: "DELIVERED", requiredAction: "NONE" }), dashboard({ phase: "FAILED", requiredAction: "NONE" }), dashboard({ phase: "ARCHIVED", requiredAction: "NONE" })].map(groupOf),
    ["needs", "working", "done", "stopped", "done"],
  );
  const built = new Set(["UI14", "UI18"]);
  assert.equal(projectHref(AGENCY, dashboard(), built), `/agencies/${AGENCY}/projects/${PROJECT}/audit`, "the stage's own page when built");
  assert.equal(projectHref(AGENCY, dashboard({ phase: "PLAN", requiredAction: "APPROVE_PLAN" }), built), `/agencies/${AGENCY}/projects/${PROJECT}/sources`, "else the project's files");
  assert.equal(projectHref(AGENCY, dashboard(), new Set()), null);
  assert.equal(projectHref(AGENCY, dashboard(), new Set([...built, "UI13"])), `/agencies/${AGENCY}/projects/${PROJECT}`, "the list opens the Overview once built");
  assert.equal(stageHref(AGENCY, dashboard(), new Set([...built, "UI13"])), `/agencies/${AGENCY}/projects/${PROJECT}/audit`, "the Overview's next step opens the stage's page");
});

test("O24 UI11: the list draws only groups that have projects, the client as text, the stage in words, and the empty state when there are none", () => {
  const page = (projects: readonly ProjectDashboardItem[], hasMore = false) => ({ projects, hasMore, loading: false, onMore: () => undefined });
  const html = renderToStaticMarkup(createElement(ProjectList, { active: page([dashboard({ clientLabel: "<script>x</script>" })], true), failed: page([]), delivered: page([dashboard({ projectId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fbe", phase: "DELIVERED", requiredAction: "NONE", mode: "CLEAN" })]), projectHref: () => "/x" }));
  assert.ok(html.includes(message("screen.projects.group.needs.title")) && html.includes(message("screen.projects.group.done.title")));
  assert.ok(!html.includes(message("screen.projects.group.working.title")) && !html.includes(message("screen.projects.group.stopped.title")), "an empty group is not drawn");
  assert.equal(html.split(message("screen.projects.more.cta")).length - 1, 1, "the active page's more sits under its last drawn group");
  assert.ok(html.includes("&lt;script&gt;"), "the client's name is a text node");
  assert.ok(html.includes(message("screen.projects.action.START_HEALTH_CHECK")));
  assert.ok(html.includes(message("project.stage.delivery-clean.label")), "a CLEAN project's last stage is Delivery");
  const empty = renderToStaticMarkup(createElement(ProjectList, { active: page([]), failed: page([]), delivered: page([]), projectHref: () => null }));
  assert.ok(empty.includes(message("screen.projects.empty.title")));
});

// --- UI13 Overview: GetProject and the project's ListProjects row -------------------------------------------------------------------
test("O24 UI13: the project's row is found under each server filter in turn; the overview draws the next step, what is in the way and the facts", async () => {
  const { client: api, sent } = harness((s) => (s.url.includes("filter=delivered") ? read({ items: [dashboard({ phase: "DELIVERED", requiredAction: "NONE" })] }) : read({ items: [] })));
  const row = await dashboardRowOf(api, AGENCY, PROJECT);
  assert.equal(row?.phase, "DELIVERED");
  assert.deepEqual(sent.map((s) => new URL(s.url, "https://x").searchParams.get("filter")), ["active", "failed", "delivered"]);
  const none = harness(() => read({ items: [] }));
  assert.equal(await dashboardRowOf(none.client, AGENCY, PROJECT), null, "not found under any filter: no row, no guessed stage");

  const view = project({ readinessBlockers: ["NO_SEALED_REVISION", "PLAN_MISSING"], purpose: "<b>Spring</b>" });
  const html = renderToStaticMarkup(createElement(OverviewDetails, { project: view, row: dashboard({ phase: "SOURCES", requiredAction: "UPLOAD_SOURCES" }), clientLabel: "Larch Studio", nextHref: "/next" }));
  assert.ok(html.includes(message("screen.projects.action.UPLOAD_SOURCES")) && html.includes('href="/next"'));
  assert.ok(html.includes(message("screen.overview.blocker.NO_SEALED_REVISION")) && html.includes(message("screen.overview.blocker.PLAN_MISSING")));
  assert.ok(html.includes("&lt;b&gt;Spring&lt;/b&gt;"), "the purpose is a text node");
  const working = renderToStaticMarkup(createElement(OverviewDetails, { project: project(), row: dashboard({ phase: "PROCESSING", requiredAction: "NONE" }), clientLabel: null, nextHref: "/next" }));
  assert.ok(working.includes(message("screen.overview.next.working.body")) && !working.includes('href="/next"'), "while Kauro works there is no step to take");
  const unknown = renderToStaticMarkup(createElement(OverviewDetails, { project: project(), row: null, clientLabel: null, nextHref: null }));
  assert.ok(!unknown.includes(message("screen.overview.next.heading")), "no row: no next step");
});

// --- Order 24 review (F2, F3): the served behaviour is unchanged with the switch off; the CLEAN audit's cancel settles with it on --------
test("O24 review F2: the empty check drops the destination only under the candidate switch, for a CLEAN project", () => {
  assert.equal(noDestinationNeeded(false, "CLEAN"), false, "switch off: the served wording, a destination is asked for");
  assert.equal(noDestinationNeeded(true, "CLEAN"), true);
  assert.equal(noDestinationNeeded(true, "HUBSPOT"), false);
  assert.equal(noDestinationNeeded(true, undefined), false);
});

test("O24 review F3: CancelAudit and its durable re-read of a CLEAN audit settle under the candidate's AuditView; the served contract refuses them", async () => {
  const { targetContractId: _none, ...clean } = audit({ state: "CANCELLED", cancelVersion: 1 });
  const answers = (sent: { readonly url: string }) => (sent.url.endsWith("/cancel") ? respond(200, { kind: "COMPLETED", version: 2, replayed: false, data: clean }) : read(clean));
  const runner = { run: async (op: { send: (k: string) => Promise<unknown>; reread: () => Promise<unknown> }) => ({ sent: await op.send("0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fcc"), reread: await op.reread() }) } as never;
  const on = harness(answers);
  const switched = (await cancelHealthCheck(on.client, runner, audit(), true)) as unknown as { sent: { kind: string }; reread: { kind: string } };
  assert.deepEqual([switched.sent.kind, switched.reread.kind], ["REPLY", "RESOLVED"]);
  const off = harness(answers);
  const served = (await cancelHealthCheck(off.client, runner, audit())) as unknown as { sent: { kind: string }; reread: { kind: string } };
  assert.deepEqual([served.sent.kind, served.reread.kind], ["INTEGRITY", "NO_ANSWER"], "switch off: the served contract, unchanged");
  assert.equal((await readCancelled(on.client, AUDIT, true)()).kind, "RESOLVED");
});

// --- UI10 Agency switcher: ListAgencies, the person's own memberships -----------------------------------------------------------------
test("O24 UI10: only the person's memberships, a role in words, a way in for an active membership only, and the current agency marked", async () => {
  const membership = (o: Partial<AgencyMembershipView>): AgencyMembershipView => ({ agencyId: AGENCY, displayName: "Northwind Data", state: "ACTIVE", version: 2, membershipId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fd1", role: "OWNER", membershipState: "ACTIVE", permittedActions: ["VIEW"], ...o });
  const other = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fd2";
  const items = [
    membership({}),
    membership({ agencyId: other, displayName: "<i>Birch</i>", membershipId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fd3", role: "VIEWER", state: "RESTRICTED" }),
    membership({ agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fd4", displayName: "Fern", membershipId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fd5", membershipState: "SUSPENDED" }),
  ];
  const html = renderToStaticMarkup(createElement(AgencySwitcher, { memberships: items, hasMore: false, loading: false, onMore: () => undefined, current: AGENCY, openHref: (id) => `/agencies/${id}/projects` }));
  assert.ok(html.includes(message("screen.switcher.current.label")), "the current agency is marked");
  assert.ok(!html.includes(`href="/agencies/${AGENCY}/projects"`), "never linked to itself");
  assert.ok(html.includes(`href="/agencies/${other}/projects"`), "an active membership has its way in");
  assert.equal(html.split(message("screen.switcher.open.cta")).length - 1, 1, "a suspended membership has none");
  assert.ok(html.includes("&lt;i&gt;Birch&lt;/i&gt;") && html.includes(message("shell.role.VIEWER.label")) && html.includes(message("shell.agency.state.RESTRICTED.label")));
  const { client: api, sent } = harness(() => read({ items }));
  assert.equal((await membershipSource(api).load(null, new AbortController().signal)).kind, "REPLY");
  assert.equal(sent[0]?.url, "/api/v1/agencies?limit=50");
});
