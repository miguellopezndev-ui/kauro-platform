// Order 15 F-04 (review R-01; FAILURE-MATRIX-TEMPLATE rule 16): a logout that commits while a command sent under that browser session is in
// flight, for every command pipeline that is not B06's `runCommandIn` (o15-session-revocation.test.ts): the commerce and commercial pipeline
// (`runCommerceCommand`: the corporate owner's CMD056 RecordIncident in an OPERATOR unit, the agency's CMD031 RequestRefund in a TENANT unit),
// the provider-effect pipeline's intent (`runProviderCommand`: CMD028 CreatePaymentOrder), the quote pipeline (CMD027 CreateQuote) and the
// two-phase source reservation (CMD013 ReserveUpload). Each is held inside its unit after its journal reservation, the session is logged
// out through the real route, and the command is released: it must be refused 401 with nothing of it written. Each has a live-session
// control (it commits), and the commerce pipeline's control proves a logout sent while the command holds the session fence waits for its
// COMMIT. Real routes, real composition root, the real session boundary of B11 (contract-fake identity provider), real PostgreSQL 17.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { FaultPoints, openConnection, waitForLockWait } from "@kauro/persistence/testing";
import { SESSIONS_APPLICATION_NAME } from "../src/index.js";
import { paymentRoutes } from "./commerce-support.js";
import { agentOf, bought, integrationWorld, planOf, quoted, type Agent, type IntegrationWorld } from "./integration-support.js";
import { reserveBody, sourceRoutes } from "./source-support.js";
import { asProblem, call, freshKey, ids, type BrowserSession, type Person, type Reply, type World } from "./support.js";

let iw: IntegrationWorld;
let w: World;
let agent: Agent;
before(async () => {
  iw = await integrationWorld({ sessions: true });
  w = iw.w;
  agent = await agentOf(iw, "o15-r01");
});
after(async () => {
  await iw.stop();
});

const browser = (s: BrowserSession) => ({ cookie: s.cookie, origin: w.identity().origin, "x-kauro-csrf": s.view.csrfToken });
const logout = (s: BrowserSession): Promise<Reply> => call(w, { url: "/api/v1/sessions/current/revoke", token: null, agency: null, key: null, contentType: null, headers: browser(s) });
const count = (sql: string, params: ReadonlyArray<unknown>): Promise<number> => w.h.oracle.query<{ n: string }>(sql, [...params]).then((r) => Number(r.rows[0]?.n ?? 0));

interface Case {
  readonly name: string;
  readonly person: () => Person;
  /** Prepares what the command acts on and answers the request (agency selector, url, body) and the count of what it would write. */
  readonly prepare: (label: string) => Promise<{ readonly agency: string | null; readonly url: string; readonly body: unknown; readonly written: () => Promise<number> }>;
  /** The status a live session's command answers. */
  readonly committed: number;
}

const CASES: ReadonlyArray<Case> = [
  {
    name: "CMD056 RecordIncident (corporate owner; runCommerceCommand, OPERATOR)",
    person: () => iw.owner,
    committed: 201,
    async prepare(label) {
      const summary = `O15 R-01 incident ${label}`;
      return { agency: null, url: "/api/v1/operations/incidents", body: { severity: "S4", affectedScopeRefs: ["platform:o15-r01"], summary }, written: () => count("SELECT count(*)::text AS n FROM kauro.incidents WHERE summary = $1", [summary]) };
    },
  },
  {
    name: "CMD031 RequestRefund (agency BILLING; runCommerceCommand, TENANT)",
    person: () => agent.billing,
    committed: 201,
    async prepare(label) {
      const paid = await bought(iw, agent, `o15-r01-refund-${label}`);
      const projectId = paid.purchase.projectId;
      return { agency: agent.s.agency.agencyId, url: paymentRoutes.requestRefund(projectId), body: { reasonCode: "The client cancelled before execution", evidenceRef: ids.next() }, written: () => count("SELECT count(*)::text AS n FROM kauro.refunds WHERE project_id = $1", [projectId]) };
    },
  },
  {
    name: "CMD027 CreateQuote (agency BILLING; the quote pipeline)",
    person: () => agent.billing,
    committed: 201,
    async prepare(label) {
      const plan = await planOf(iw, agent, `o15-r01-quote-${label}`);
      return { agency: agent.s.agency.agencyId, url: `/api/v1/projects/${plan.projectId}/quotes`, body: { planId: plan.planId, billingProfileRef: agent.s.profileId }, written: () => count("SELECT count(*)::text AS n FROM kauro.quotes WHERE project_id = $1", [plan.projectId]) };
    },
  },
  {
    name: "CMD028 CreatePaymentOrder (agency BILLING; runProviderCommand's intent)",
    person: () => agent.billing,
    committed: 201,
    async prepare(label) {
      const plan = await planOf(iw, agent, `o15-r01-order-${label}`);
      const quote = await quoted(iw, agent, plan);
      const quoteId = quote.quote.quoteId;
      return { agency: agent.s.agency.agencyId, url: paymentRoutes.createPaymentOrder(quoteId), body: { termsHash: quote.quote.termsHash }, written: () => count("SELECT count(*)::text AS n FROM kauro.payment_orders WHERE quote_id = $1", [quoteId]) };
    },
  },
  {
    name: "CMD013 ReserveUpload (agency OPERATOR; the two-phase source reservation)",
    person: () => w.operator,
    committed: 201,
    async prepare() {
      const { revisionId } = await w.project(w.A, w.clientA);
      // what a refused reservation must never hold: a session secret (the upload's bearer credential) of that revision
      return { agency: w.A.agencyId, url: sourceRoutes.reserveUpload(revisionId), body: reserveBody(1), written: () => count("SELECT count(*)::text AS n FROM kauro.upload_session_secrets s JOIN kauro.upload_sessions u ON u.upload_id = s.upload_id WHERE u.revision_id = $1", [revisionId]) };
    },
  },
];

test("O15 F-04 (R-01): a command of every non-B06 pipeline whose browser session is logged out while it waits inside its unit is refused, with nothing of it written", async () => {
  const failures: string[] = [];
  for (const c of CASES) {
    const prepared = await c.prepare("revoked");
    const session = await w.identity().signIn(c.person());
    const hold = w.holds.arm("journal.reserved");
    const pending = call(w, { url: prepared.url, token: null, agency: prepared.agency, key: freshKey("o15-r01"), body: prepared.body, headers: browser(session) });
    let reached = false;
    try {
      await hold.reached;
      reached = true;
      const out = await logout(session);
      if (out.status !== 204 && out.status !== 200) failures.push(`${c.name}: the logout answered ${out.status}`);
    } finally {
      hold.release();
    }
    const reply = await pending;
    const got = reply.status >= 400 ? `${reply.status} ${asProblem(w, reply).code}` : `${reply.status}`;
    if (!reached || got !== "401 AUTHENTICATION_REQUIRED") failures.push(`${c.name}: after the logout it answered ${got} ${reply.text.slice(0, 160)}`);
    const written = await prepared.written();
    if (written !== 0) failures.push(`${c.name}: ${written} row(s) written after the logout`);
  }
  assert.deepEqual(failures, []);
});

test("O15 F-04 (R-01) control: under a live session each command commits", async () => {
  const failures: string[] = [];
  for (const c of CASES) {
    const prepared = await c.prepare("live");
    const session = await w.identity().signIn(c.person());
    const reply = await call(w, { url: prepared.url, token: null, agency: prepared.agency, key: freshKey("o15-r01-live"), body: prepared.body, headers: browser(session) });
    if (reply.status !== c.committed) failures.push(`${c.name}: ${reply.status} ${reply.text.slice(0, 200)}`);
    else if ((await prepared.written()) < 1) failures.push(`${c.name}: committed but wrote nothing`);
  }
  assert.deepEqual(failures, []);
});

test("O15 F-04 (R-01) control: a logout sent while a commerce command holds the session fence waits for that command's COMMIT", async () => {
  const session = await w.identity().signIn(iw.owner);
  const summary = "O15 R-01 incident before logout";
  // the command's unit routed over a harness connection of kauro_app, paused right after its session fence locked the row FOR SHARE
  const points = new FaultPoints();
  const label = "o15-r01-fence";
  const fenced = points.pause(`db.${label}.after`);
  const conn = await openConnection(iw.h.pg.clientConfig("kauro_app_test"));
  try {
    const running = iw.faults.on(conn, "kauro_app", points, [{ label, match: /FROM kauro\.web_sessions WHERE secret_sha256 = \$1 AND user_id = \$2 FOR SHARE/ }], () =>
      call(w, { url: "/api/v1/operations/incidents", token: null, agency: null, key: freshKey("o15-r01-fence"), body: { severity: "S4", affectedScopeRefs: ["platform:o15-r01"], summary }, headers: browser(session) }),
    );
    await fenced.reachedBy(running.then(() => undefined));
    const out = logout(session);
    try {
      await waitForLockWait(w.h.oracle, SESSIONS_APPLICATION_NAME, "web_sessions");
    } finally {
      fenced.release();
    }
    const reply = await running;
    assert.equal(reply.status, 201, reply.text);
    assert.equal(await count("SELECT count(*)::text AS n FROM kauro.incidents WHERE summary = $1", [summary]), 1);
    const ended = await out;
    assert.ok(ended.status === 204 || ended.status === 200, ended.text);
  } finally {
    await conn.end();
  }
});
