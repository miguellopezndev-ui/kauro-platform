// S048 sweep (Deny without resource-existence or data leakage; R2 B16 L1): every GET route that takes an id in its path, found in the
// api's OpenAPI contract and not in a hand-kept list, answers another agency's id and an id that never existed identically (same
// status, same problem except its correlation id, same headers), always with Cache-Control: no-store. A new id route fails this
// census until it is either swept here or named, with its reason, in UNSWEPT. Real routes, real composition root, real PostgreSQL 17.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { asProblem, call, completed, ids, routes, type Person, type Reply, type World } from "./support.js";

let pw: PaymentsWorld;
let w: World;
before(async () => {
  pw = await paymentsWorld();
  w = pw.w;
});
after(async () => {
  await pw.stop();
});

/** apps/api/openapi.json, from dist/test/*.js: three directories up is apps/api. */
const OPENAPI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "openapi.json");

/** The id GET routes of the contract: a path parameter, no public, session or health route. */
function idRoutes(): string[] {
  const doc = JSON.parse(readFileSync(OPENAPI, "utf8")) as { paths: Record<string, Record<string, unknown>> };
  return Object.entries(doc.paths)
    .filter(([path, ops]) => "get" in ops && /\{[A-Za-z]+\}/.test(path) && path.startsWith("/api/v1/") && !path.startsWith("/api/v1/public/") && !path.startsWith("/api/v1/sessions"))
    .map(([path]) => path)
    .sort();
}

/**
 * Id routes whose foreign resource this world cannot create (a job, an audit, an upload session, a bank route, a seller statement and
 * the operator's views need the execution, intake, bank or commission worlds). Each is still asked for a nonexistent id below (a refusal that names nothing); the foreign half of each is
 * gap R2-B16-S048-UNSWEPT (reported to the coordinator), and the set is fixed so that a new route cannot hide in it.
 */
const UNSWEPT: ReadonlySet<string> = new Set([
  "/api/v1/audits/{auditId}",
  "/api/v1/jobs/{jobId}",
  "/api/v1/operations/bank-routes/{routeId}",
  "/api/v1/operations/refunds/{refundId}",
  "/api/v1/payment-orders/{orderId}/transfer-instructions",
  "/api/v1/sales/statements/{statementId}",
  "/api/v1/uploads/{uploadId}",
  "/api/v1/uploads/{uploadId}/session",
]);

function read(url: string, person: Person, agency: string = w.A.agencyId): Promise<Reply> {
  return call(w, { method: "GET", url, token: person.token, key: null, contentType: null, agency });
}

/** A reply stripped of what legitimately differs between two requests: the correlation id (body and header) and the date. */
function shape(reply: Reply): { readonly status: number; readonly problem: Record<string, unknown>; readonly headers: Record<string, unknown> } {
  const { correlationId: _c, ...problem } = asProblem(w, reply);
  const { "x-correlation-id": _h, date: _d, ...headers } = reply.headers;
  return { status: reply.status, problem, headers };
}

test("S048 sweep: every id route answers a foreign and a nonexistent id identically, with Cache-Control no-store", async () => {
  const routesFound = idRoutes();
  assert.ok(routesFound.length >= 20, `the contract's id routes were found (${routesFound.length})`);
  for (const route of UNSWEPT) assert.ok(routesFound.includes(route), `UNSWEPT names a route that no longer exists: ${route}`);

  const foreignProject = await w.project(w.B, w.clientB);
  const own = await w.project(w.A, w.clientA);
  const sale = await pw.foreignRefund("s048-sweep");
  const foreignCase = completed<{ caseId: string }>(await call(w, { url: routes.createSupportCase(foreignProject.projectId), token: w.stranger.token, agency: w.B.agencyId, body: { category: "GENERAL", summary: "A question that belongs to the other agency and must stay there." } }), 201).data;
  const foreign: Record<string, string> = {
    quoteId: sale.sale.quoteId,
    orderId: sale.sale.orderId,
    refundId: sale.refundId,
    caseId: foreignCase.caseId,
    agencyId: w.B.agencyId,
    projectId: foreignProject.projectId,
    revisionId: foreignProject.revisionId,
    // sub-resources of a foreign revision that exist nowhere in A: any id is as foreign as the revision they hang from
    tableId: ids.next(),
    selectionManifestId: ids.next(),
  };
  const swept: string[] = [];
  for (const route of routesFound) {
    const params = [...route.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1] as string);
    const fill = (value: (name: string) => string): string => route.replace(/\{([A-Za-z]+)\}/g, (_m, name: string) => value(name));
    const nowhere = await read(fill(() => ids.next()), w.owner);
    if (UNSWEPT.has(route)) {
      // only the nonexistent half: a Problem that names nothing, never a 5xx and never data
      assert.ok([403, 404].includes(nowhere.status), `${route}: ${nowhere.status} ${nowhere.text}`);
      assert.equal(nowhere.headers["cache-control"], "no-store", route);
      continue;
    }
    for (const p of params) assert.ok(p in foreign, `${route}: no foreign fixture for {${p}} (extend the sweep or name the route in UNSWEPT with its reason)`);
    const foreignPath = fill((name) => foreign[name] as string);
    const other = await read(foreignPath, w.owner);
    assert.equal(other.headers["cache-control"], "no-store", route);
    assert.equal(nowhere.headers["cache-control"], "no-store", route);
    assert.equal(other.status, 404, `${route}: a foreign id is NOT_FOUND, not a malformed-request or selector refusal (${other.text})`);
    assert.deepEqual(shape(other), shape(nowhere), `${route}: a foreign and a nonexistent id answer alike`);
    swept.push(route);
  }
  assert.deepEqual([...swept, ...UNSWEPT].sort(), routesFound, "every id route is swept or named");
  // the control: the caller's own project is readable, so the refusals above are about the other agency and not about the route
  const mine = await read(`/api/v1/projects/${own.projectId}`, w.owner);
  assert.equal(mine.status, 200, "A's owner reads A's own project");
  const theirs = await read(`/api/v1/projects/${foreignProject.projectId}`, w.stranger, w.B.agencyId);
  assert.equal(theirs.status, 200, "and its own owner reads it: the refusal is about the caller's agency, not the route");
});
