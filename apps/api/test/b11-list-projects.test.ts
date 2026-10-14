// ListProjects (B11 lane A1; SCREENS-PLAN section 3 row "A1 ListProjects", screen UI11) — GET /api/v1/agencies/{agencyId}/projects
// ?filter=active|awaiting_agency|delivered|failed|archived — any member of the agency — keyset pages. R2 11 "Project dashboard": client,
// mode, current revision, phase, last meaningful event, required agency action, deadline and safe commercial status, with the filters
// active, awaiting agency, delivered, failed and archived; business status labels. Every member of an item is read from a durable fact
// of the project (the client's display name, the current revision, the latest plan, quote, entitlement and job): nothing is inferred.
//
// Phase and required action, the first rule that holds:
//   ARCHIVED   the project is not OPEN or its client is ARCHIVED                                       NONE
//   DELIVERED  the latest job is READY                                                                 NONE
//   FAILED     the latest job is FAILED, EXPIRED or CANCELLED                                           NONE
//   PROCESSING the latest job is live (deadline: its delivery deadline)                                 NONE
//   PURCHASE   a live entitlement without a job                                                         START_PROCESSING
//              an ISSUED (or checkout-accepted) quote (deadline: the quote's expiry)                    PAY_QUOTE
//              an APPROVED plan                                                                         REQUEST_QUOTE
//   PLAN       the latest plan VALIDATED                                                                APPROVE_PLAN
//              the latest plan DRAFT or VALIDATION_REQUIRED                                             VALIDATE_PLAN
//   HEALTH_CHECK the current revision SEALED and no plan                                                START_HEALTH_CHECK
//   SOURCES    the current revision DRAFT (or closed without a seal)                                    UPLOAD_SOURCES
// Filters: archived, delivered and failed are those phases; active is every other project; awaiting_agency is an active project whose
// required action is not NONE.
import { INJECTED_STATEMENT_TIMEOUT_MS, LOCK_WAIT_OBSERVATION_MS, activateAgency, admitJob, deliverThroughExecution, endJob, invariantsAfterEach, issueQuote, launchJob, paidPurchase, queueJob, recordReviewedFiscalProfile, type AgencyFixture } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FiscalProfileId, PlanId, UserId } from "@kauro/domain";
import { API_APPLICATION_NAME } from "../src/index.js";
import { track, until } from "./agency-lock-cells.js";
import { paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { approveThroughRoute, call, freshKey, outcome, routes, type Person, type Reply } from "./support.js";

const injected: { statementTimeoutMs: number | null } = { statementTimeoutMs: null };
type RunFn = (context: unknown, work: (uow: unknown) => Promise<unknown>, options?: Record<string, unknown>) => Promise<unknown>;
/** The api's units of work under the statement bound the TIMEOUT cell injects (null: the world's own bound). */
function wrapUnitOfWork<F extends object>(inner: F): F {
  return new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if ((property === "run" || property === "runSource") && typeof value === "function") {
        const run = value as RunFn;
        return (context: unknown, work: (uow: unknown) => Promise<unknown>, options?: Record<string, unknown>) =>
          run.call(target, context, work, injected.statementTimeoutMs === null ? options : { ...(options ?? {}), statementTimeoutMs: injected.statementTimeoutMs });
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

let pw: PaymentsWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => pw.w.h.oracle);
before(async () => {
  pw = await paymentsWorld({ wrapUnitOfWork });
});
after(async () => {
  await pw.stop();
});

const listUrl = (agencyId: string, query = ""): string => `/api/v1/agencies/${agencyId}/projects${query}`;
const oracle = () => pw.w.h.oracle;

interface DashboardItem {
  readonly projectId: string;
  readonly clientId: string;
  readonly clientLabel: string;
  readonly mode: string;
  readonly revision: { readonly revisionId: string; readonly state: string } | null;
  readonly phase: string;
  readonly requiredAction: string;
  readonly deadline: string | null;
  readonly lastActivityAt: string;
  readonly version: number;
}
interface DashboardPage {
  readonly items: ReadonlyArray<DashboardItem>;
  readonly nextCursor?: string;
}

function list(agencyId: string, who: Person, query = ""): Promise<Reply> {
  return call(pw.w, { method: "GET", url: listUrl(agencyId, query), token: who.token, agency: null, key: null, contentType: null });
}

function page(reply: Reply): DashboardPage {
  assert.equal(reply.status, 200, reply.text);
  const body = reply.json<{ kind: string; data: DashboardPage }>();
  assert.equal(body.kind, "READ");
  return body.data;
}

const iso = async (sql: string, params: ReadonlyArray<unknown>): Promise<string | null> =>
  (await oracle().query<{ at: string | null }>(`SELECT to_char((${sql}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`, [...params])).rows[0]?.at ?? null;

interface Dashboard {
  readonly agency: AgencyFixture;
  readonly owner: Person;
  readonly viewer: Person;
  /** project id by fixture name */
  readonly projects: Readonly<Record<string, string>>;
  readonly revisions: Readonly<Record<string, string>>;
  readonly clientIds: Readonly<Record<string, string>>;
}

/**
 * An ACTIVE selling agency with one project at every phase of the dashboard, each created after the previous one (keyset order:
 * newest first), written through the production adapters and routes (CMD025 approvals, B09's purchase fixtures, B08's job writers).
 */
async function dashboard(label: string): Promise<Dashboard> {
  const { w } = pw;
  const owner = await w.person(`${label}-owner`);
  const agency = await w.h.createAgency(owner.userId, `Agency ${label}`);
  const viewer = await w.person(`${label}-viewer`);
  await w.h.addMember(agency, viewer.userId, "VIEWER");
  await activateAgency(w.h, agency);
  const authority = await w.h.processingAuthority(agency);
  const clientId = await w.h.endClient(agency, authority, `${label} Acme Client`);
  const archivedClientId = await w.h.endClient(agency, authority, `${label} Archived Client`);
  const profileId: FiscalProfileId = await recordReviewedFiscalProfile(w.h, { operatorUserId: pw.kora.userId as UserId, agencyId: agency.agencyId, issuerRef: pw.issuerRef });
  const projects: Record<string, string> = {};
  const revisions: Record<string, string> = {};
  const fresh = async (name: string, client = clientId) => {
    const p = await w.project(agency, client as never);
    projects[name] = p.projectId;
    revisions[name] = p.revisionId;
    return p.projectId;
  };
  const approved = async (name: string, approve: boolean) => {
    const projectId = await fresh(name);
    const plan = await w.approvable(agency, projectId as never, `${label}-${name}`, "SET", { recent: true });
    revisions[name] = (await oracle().query<{ id: string }>("SELECT current_revision_id::text AS id FROM kauro.projects WHERE project_id = $1", [projectId])).rows[0]!.id;
    if (approve) await approveThroughRoute(w, plan, owner, agency.agencyId);
    return plan;
  };
  const paid = async (name: string) => {
    const plan = await approved(name, true);
    return paidPurchase(w.h, { agency, planId: plan.planId as PlanId, route: pw.route, issuerRef: pw.issuerRef, profileId, treatment: "EXEMPT_EXPORT" });
  };
  await fresh("sources");
  const sealedProject = await fresh("healthCheck");
  revisions["healthCheck"] = (await w.revision(agency, sealedProject as never, "SEALED")).revisionId;
  await approved("plan", false);
  await approved("quote", true);
  const quotePlan = await approved("issued", true);
  await issueQuote(w.h, { agency, planId: quotePlan.planId as PlanId, issuerRef: pw.issuerRef, profileId });
  await paid("paid");
  const processing = await paid("processing");
  await queueJob(w.h, agency, processing.authorizationId);
  const failed = await paid("failed");
  const failedJob = await queueJob(w.h, agency, failed.authorizationId);
  await admitJob(w.h, agency, failedJob.jobId);
  await launchJob(w.h, agency, failedJob.jobId);
  await endJob(w.h, agency, failedJob.jobId);
  const delivered = await paid("delivered");
  await deliverThroughExecution(w.h, agency, delivered.authorizationId);
  await fresh("archived", archivedClientId);
  const archive = await call(w, { url: routes.archiveClient(archivedClientId), token: owner.token, agency: agency.agencyId, key: freshKey("a1-archive"), body: { expectedVersion: 1 } });
  assert.equal(archive.status, 200, archive.text);
  const clientIds: Record<string, string> = Object.fromEntries(Object.keys(projects).map((k) => [k, k === "archived" ? archivedClientId : clientId]));
  return { agency, owner, viewer, projects, revisions, clientIds };
}

/** name -> [phase, requiredAction] as the rules above derive them from the fixtures. */
const EXPECTED: Readonly<Record<string, readonly [string, string]>> = {
  sources: ["SOURCES", "UPLOAD_SOURCES"],
  healthCheck: ["HEALTH_CHECK", "START_HEALTH_CHECK"],
  plan: ["PLAN", "APPROVE_PLAN"],
  quote: ["PURCHASE", "REQUEST_QUOTE"],
  issued: ["PURCHASE", "PAY_QUOTE"],
  paid: ["PURCHASE", "START_PROCESSING"],
  processing: ["PROCESSING", "NONE"],
  failed: ["FAILED", "NONE"],
  delivered: ["DELIVERED", "NONE"],
  archived: ["ARCHIVED", "NONE"],
};
const ORDER = ["archived", "delivered", "failed", "processing", "paid", "issued", "quote", "plan", "healthCheck", "sources"] as const;

let fixture: Dashboard | null = null;
async function sharedDashboard(): Promise<Dashboard> {
  fixture ??= await dashboard("a1-list");
  return fixture;
}

test("UI11: the dashboard shows client, mode, revision, phase, required action and deadline with the five R2 filters, labels from durable facts only", async () => {
  const d = await sharedDashboard();
  const nameOf = (projectId: string) => Object.keys(d.projects).find((k) => d.projects[k] === projectId) ?? `unknown ${projectId}`;
  const names = async (filter: string) => page(await list(d.agency.agencyId, d.viewer, `?filter=${filter}`)).items.map((i) => nameOf(i.projectId));
  // the five filters, newest first
  assert.deepEqual(await names("active"), ["processing", "paid", "issued", "quote", "plan", "healthCheck", "sources"]);
  assert.deepEqual(await names("awaiting_agency"), ["paid", "issued", "quote", "plan", "healthCheck", "sources"]);
  assert.deepEqual(await names("delivered"), ["delivered"]);
  assert.deepEqual(await names("failed"), ["failed"]);
  assert.deepEqual(await names("archived"), ["archived"]);
  // no filter is the active one
  assert.deepEqual(page(await list(d.agency.agencyId, d.viewer)).items.map((i) => nameOf(i.projectId)), await names("active"));

  // every item from its durable facts: the client's display name, the project's mode and version, its current revision
  const all: DashboardItem[] = [];
  for (const filter of ["active", "delivered", "failed", "archived"]) all.push(...page(await list(d.agency.agencyId, d.owner, `?filter=${filter}`)).items);
  assert.deepEqual(all.map((i) => nameOf(i.projectId)).sort(), [...ORDER].sort(), "every project is in exactly one of active, delivered, failed and archived");
  for (const item of all) {
    const name = nameOf(item.projectId);
    const facts = (await oracle().query<{ client_id: string; display_name: string; mode: string; version: string; revision_state: string; current_revision_id: string }>(
      "SELECT p.client_id::text AS client_id, c.display_name, p.mode, p.version::text AS version, r.state AS revision_state, p.current_revision_id::text AS current_revision_id FROM kauro.projects p JOIN kauro.end_clients c ON c.client_id = p.client_id JOIN kauro.dataset_revisions r ON r.revision_id = p.current_revision_id WHERE p.project_id = $1",
      [item.projectId],
    )).rows[0]!;
    assert.deepEqual(
      { clientId: item.clientId, clientLabel: item.clientLabel, mode: item.mode, version: item.version, revision: item.revision, phase: item.phase, requiredAction: item.requiredAction },
      { clientId: d.clientIds[name], clientLabel: facts.display_name, mode: facts.mode, version: Number(facts.version), revision: { revisionId: facts.current_revision_id, state: facts.revision_state }, phase: EXPECTED[name]![0], requiredAction: EXPECTED[name]![1] },
      name,
    );
    assert.equal(item.clientLabel, name === "archived" ? "a1-list Archived Client" : "a1-list Acme Client", `${name}: the label is the client's display name`);
    assert.match(item.lastActivityAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  const byName = (name: string) => all.find((i) => i.projectId === d.projects[name])!;
  assert.equal(byName("healthCheck").revision?.revisionId, d.revisions["healthCheck"], "the sealed revision is the project's current one");
  assert.equal(byName("healthCheck").revision?.state, "SEALED");
  assert.equal(byName("sources").revision?.state, "DRAFT");
  // deadlines: the issued quote's expiry and the queued job's delivery deadline; no other phase has one
  assert.equal(byName("issued").deadline, await iso("SELECT expires_at FROM kauro.quotes WHERE project_id = $1 AND state = 'ISSUED'", [d.projects["issued"]]));
  assert.equal(byName("processing").deadline, await iso("SELECT delivery_deadline_at FROM kauro.processing_jobs WHERE project_id = $1", [d.projects["processing"]]));
  for (const name of ORDER.filter((n) => n !== "issued" && n !== "processing")) assert.equal(byName(name).deadline, null, `${name} has no deadline`);
  assert.notEqual(byName("issued").deadline, null);
  assert.notEqual(byName("processing").deadline, null);
  // the last meaningful activity of the delivered project is its job's delivery
  assert.equal(byName("delivered").lastActivityAt, await iso("SELECT updated_at FROM kauro.processing_jobs WHERE project_id = $1", [d.projects["delivered"]]));
});

test("DENY: a non-member is 404 NOT_A_MEMBER, an unknown filter or query member is 400 SCHEMA_VIOLATION, and a VIEWER reads the dashboard", async () => {
  const { w } = pw;
  const d = await sharedDashboard();
  const refused = await list(d.agency.agencyId, w.stranger, "?filter=active");
  assert.equal(outcome(w, refused), "404 NOT_FOUND NOT_A_MEMBER");
  for (const id of Object.values(d.projects)) assert.ok(!refused.text.includes(id), "no project of the agency in the refusal");
  for (const query of ["?filter=open", "?filter=ACTIVE", "?filter=active&filter=failed", "?state=OPEN", "?limit=0", "?limit=101"]) {
    assert.equal(outcome(w, await list(d.agency.agencyId, d.viewer, query)), "400 INVALID_REQUEST SCHEMA_VIOLATION", query);
  }
  assert.equal(page(await list(d.agency.agencyId, d.viewer, "?filter=failed")).items.length, 1);
});

test("PARTIAL: keyset pages of a filter cover it exactly once, and a cursor is bound to its filter", async () => {
  const { w } = pw;
  const d = await sharedDashboard();
  const seen: string[] = [];
  const pages: number[] = [];
  let cursor: string | undefined;
  do {
    const p = page(await list(d.agency.agencyId, d.owner, `?filter=active&limit=3${cursor === undefined ? "" : `&cursor=${cursor}`}`));
    pages.push(p.items.length);
    seen.push(...p.items.map((i) => i.projectId));
    cursor = p.nextCursor;
  } while (cursor !== undefined && pages.length < 10);
  assert.deepEqual(pages, [3, 3, 1]);
  assert.deepEqual(seen, page(await list(d.agency.agencyId, d.owner, "?filter=active")).items.map((i) => i.projectId), "the pages are the whole list, in order, no duplicate and no gap");
  // the first page's cursor continues only the list it came from
  const first = page(await list(d.agency.agencyId, d.owner, "?filter=active&limit=3"));
  assert.ok(first.nextCursor !== undefined);
  assert.equal(outcome(w, await list(d.agency.agencyId, d.owner, `?filter=awaiting_agency&limit=3&cursor=${first.nextCursor}`)), "400 INVALID_REQUEST CURSOR_INVALID");
  assert.equal(outcome(w, await list(d.agency.agencyId, d.viewer, `?filter=active&limit=3&cursor=${first.nextCursor}`)), "400 INVALID_REQUEST CURSOR_INVALID", "another caller");
  assert.equal(outcome(w, await list(d.agency.agencyId, d.owner, "?filter=active&limit=3&cursor=not-a-cursor")), "400 INVALID_REQUEST CURSOR_INVALID");
});

test("TIMEOUT: a dashboard read waiting past the statement timeout is 503 CAPACITY_UNAVAILABLE, and the next read answers", async () => {
  const { w } = pw;
  const d = await sharedDashboard();
  const locker = await w.h.pg.connect("postgres");
  let reply: Reply | undefined;
  let elapsed = 0;
  try {
    await locker.query("BEGIN");
    await locker.query("LOCK TABLE kauro.projects IN ACCESS EXCLUSIVE MODE");
    injected.statementTimeoutMs = INJECTED_STATEMENT_TIMEOUT_MS;
    const started = Date.now();
    const pending = track(list(d.agency.agencyId, d.viewer, "?filter=active"));
    let waiter: number | null = null;
    await until("the read waits on the projects table, or answers", async () => {
      if (pending.done()) return true;
      await oracle().query("SELECT pg_stat_clear_snapshot()");
      const r = await oracle().query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND position('kauro.projects' in query) > 0", [API_APPLICATION_NAME]);
      waiter = r.rows[0]?.pid ?? null;
      return waiter !== null;
    });
    assert.notEqual(waiter, null, "the read waited on the projects table before it answered");
    const answer = await pending.settled;
    assert.equal(answer.status, "fulfilled");
    reply = answer.status === "fulfilled" ? answer.value : undefined;
    elapsed = Date.now() - started;
  } finally {
    injected.statementTimeoutMs = null;
    await locker.query("ROLLBACK");
    await locker.end();
  }
  assert.ok(reply);
  assert.equal(outcome(w, reply), "503 CAPACITY_UNAVAILABLE -");
  assert.ok(!reply.text.includes(d.projects["sources"]!), "no project in the refusal");
  assert.ok(elapsed >= INJECTED_STATEMENT_TIMEOUT_MS && elapsed < INJECTED_STATEMENT_TIMEOUT_MS + LOCK_WAIT_OBSERVATION_MS, `the bound fired at the injected statement timeout (${elapsed} ms)`);
  assert.equal(page(await list(d.agency.agencyId, d.viewer, "?filter=active")).items.length, 7);
});
