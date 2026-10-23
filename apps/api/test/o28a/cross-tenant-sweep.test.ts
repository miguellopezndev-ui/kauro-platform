// O28A cross-tenant sweep over the whole served surface: every route of apps/api/openapi.json is called by a member of agency B (the
// stranger) with agency A's real ids — A holds a project, a sealed revision with its confirmed target contract and approved plan, an issued
// quote with a paid payment order, and the resources A's owner creates through the routes themselves (support case, invitation, upload,
// refund request, audit, revision) — under B's own agency header and under A's forged one. No answer is 2xx, no reply carries A's facts, no
// row of any kauro table is written, and while it runs the api process opens no network connection or datagram beyond the loopback.
// The route list is read from the generated document, so a route a later order adds is swept without editing this test; a customer route
// whose path id the sweep cannot fill with an A-owned id fails the sweep unless it is in RANDOM_ID_ROUTES with its reason (review F-1).
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { call, freshKey, ids, type World } from "../support.js";
import { paymentsWorld } from "../commerce-support.js";

const here = dirname(fileURLToPath(import.meta.url));
const OPENAPI = JSON.parse(readFileSync(join(here, "..", "..", "..", "openapi.json"), "utf8")) as { paths: Record<string, Record<string, { requestBody?: { content?: Record<string, { schema?: Schema }> } }>>; components: { schemas: Record<string, Schema> } };

type Schema = { $ref?: string; type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; const?: unknown; format?: string; pattern?: string; minLength?: number; maxLength?: number; minimum?: number; items?: Schema; minItems?: number; oneOf?: Schema[]; anyOf?: Schema[]; allOf?: Schema[] };

/** A minimal schema-valid instance of a request body, ids filled from agency A where the member names one (best effort: a body the
 * generator cannot satisfy still reaches the schema check, which the sweep records). */
function instance(schema: Schema | undefined, name: string, fillId: (name: string) => string, depth = 0): unknown {
  if (schema === undefined || depth > 8) return {};
  if (schema.$ref !== undefined) return instance(OPENAPI.components.schemas[schema.$ref.split("/").pop() as string], name, fillId, depth + 1);
  if (schema.const !== undefined) return schema.const;
  if (schema.enum !== undefined) return schema.enum[0];
  const variant = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (variant !== undefined) return instance(variant, name, fillId, depth + 1);
  if (schema.allOf !== undefined) return Object.assign({}, ...schema.allOf.map((s) => instance(s, name, fillId, depth + 1) as object));
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (type === "object" || schema.properties !== undefined) {
    const out: Record<string, unknown> = {};
    for (const k of schema.required ?? []) out[k] = instance(schema.properties?.[k], k, fillId, depth + 1);
    return out;
  }
  if (type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => instance(schema.items, name, fillId, depth + 1));
  if (type === "integer" || type === "number") return schema.minimum ?? 1;
  if (type === "boolean") return false;
  if (schema.format === "uuid" || /Id$|Ref$/.test(name)) {
    const id = fillId(name.replace(/Ref$/, "Id"));
    if (schema.pattern === undefined || new RegExp(schema.pattern).test(id)) return id;
  }
  if (schema.format === "date-time") return new Date().toISOString();
  if (schema.format === "date") return new Date().toISOString().slice(0, 10);
  if (schema.format === "email") return "sweep@example.test";
  const candidates = ["a".repeat(64), ids.next(), "Sweep", "SWEEP", "sweep", "CO", "es-CO", "https://example.test", "a".repeat(schema.minLength ?? 1)];
  const fits = (c: string) => (schema.pattern === undefined || new RegExp(schema.pattern, "u").test(c)) && c.length >= (schema.minLength ?? 0) && c.length <= (schema.maxLength ?? Infinity);
  return candidates.find(fits) ?? "a".repeat(Math.max(1, schema.minLength ?? 1));
}

// --- egress observation: every outbound socket and datagram the process opens while the sweep runs -------------------------------
const outbound: string[] = [];
let loopbackConnections = 0;
const originalConnect = net.Socket.prototype.connect;
const originalSend = dgram.Socket.prototype.send;
const originalDgramConnect = dgram.Socket.prototype.connect;
/** Loopback by address only: 127.0.0.0/8, ::1 and the name localhost; a host name that merely starts with "127." is not loopback. */
function isLoopback(host: unknown): boolean {
  if (host === undefined || host === null || host === "localhost") return true;
  if (typeof host !== "string") return false;
  if (net.isIPv4(host)) return host.startsWith("127.");
  return net.isIPv6(host) && (host === "::1" || host === "0:0:0:0:0:0:0:1");
}
before(() => {
  net.Socket.prototype.connect = function observedConnect(this: net.Socket, ...args: unknown[]) {
    const first = args[0];
    const options = (Array.isArray(first) ? first[0] : first) as { host?: unknown; path?: unknown; port?: unknown } | number | string | undefined;
    if (typeof options === "object" && options !== null && options.path === undefined) {
      if (isLoopback(options.host)) loopbackConnections += 1;
      else outbound.push(`${String(options.host)}:${String(options.port)}`);
    }
    if (typeof options === "number") {
      if (isLoopback(args[1])) loopbackConnections += 1;
      else outbound.push(`${String(args[1])}:${options}`);
    }
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  dgram.Socket.prototype.send = function observedSend(this: dgram.Socket, ...args: unknown[]) {
    const host = args.find((a, i) => i > 0 && typeof a === "string");
    if (!isLoopback(host)) outbound.push(`udp ${String(host)}`);
    return (originalSend as (...a: unknown[]) => void).apply(this, args);
  } as typeof dgram.Socket.prototype.send;
  dgram.Socket.prototype.connect = function observedDgramConnect(this: dgram.Socket, ...args: unknown[]) {
    if (!isLoopback(args[1])) outbound.push(`udp ${String(args[1])}:${String(args[0])}`);
    return (originalDgramConnect as (...a: unknown[]) => void).apply(this, args);
  } as typeof dgram.Socket.prototype.connect;
});

let w: World;
let stopWorld: (() => Promise<void>) | undefined;
const known: Record<string, string> = {};
const created: string[] = [];
before(async () => {
  const pw = await paymentsWorld();
  w = pw.w;
  stopWorld = () => pw.stop();
  const base = await w.project(w.A, w.clientA);
  const paid = await pw.paidProject("o28a-sweep");
  const one = async (sql: string, params: ReadonlyArray<unknown>): Promise<string> => {
    const r = await w.h.oracle.query<{ id: string }>(sql, [...params]);
    const id = r.rows[0]?.id;
    if (id === undefined) throw new Error(`the sweep's fixture lacks: ${sql}`);
    return id;
  };
  Object.assign(known, {
    agencyId: w.A.agencyId,
    clientId: w.clientA,
    projectId: base.projectId,
    membershipId: w.memberships.admin,
    processingAuthorityId: w.authorityA,
    planId: paid.plan.planId,
    quoteId: paid.quoteId,
    orderId: paid.orderId,
    captureId: paid.captureId,
    revisionId: await one("SELECT revision_id::text AS id FROM kauro.dataset_revisions WHERE manifest_hash = $1", [paid.plan.revisionHash]),
    contractId: await one("SELECT contract_id::text AS id FROM kauro.target_contracts WHERE body_hash = $1", [paid.plan.targetContractHash]),
  });
  // the resources A's owner creates through the routes themselves: their ids are harvested from the owner's own answers
  known["targetContractId"] = known["contractId"] as string;
  const creations: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
    ["/api/v1/projects/{projectId}/support-cases", base.projectId, {}],
    ["/api/v1/agencies/{agencyId}/invitations", w.A.agencyId, { role: "OPERATOR", intendedIdentityRef: (await w.person("o28a-invitee")).userId }],
    ["/api/v1/revisions/{revisionId}/uploads", base.revisionId, { declaredBytes: 1024, displayName: "o28a-sweep.csv" }],
    ["/api/v1/projects/{projectId}/refund-requests", paid.projectId, {}],
    ["/api/v1/revisions/{revisionId}/audits", known["revisionId"] as string, {}],
  ];
  const harvest = (value: unknown, depth: number): void => {
    if (depth > 3 || typeof value !== "object" || value === null) return;
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" && /Id$/.test(k) && known[k] === undefined) known[k] = v;
      else harvest(v, depth + 1);
    }
  };
  for (const [path, id, overrides] of creations) {
    const url = path.replace(/\{[A-Za-z]+\}/, id);
    const body = { ...(instance(OPENAPI.paths[path]?.["post"]?.requestBody?.content?.["application/json"]?.schema, "", fillId) as object), ...overrides } as Record<string, unknown>;
    let reply = await call(w, { url, body, key: freshKey("o28a-seed") });
    // a versioned command answers the current version: the owner retries once at it, as the client does
    const current = reply.status === 409 ? reply.json<{ current?: { version?: number } }>().current?.version : undefined;
    if (current !== undefined) reply = await call(w, { url, body: { ...body, expectedVersion: current }, key: freshKey("o28a-seed") });
    if (reply.status < 300) harvest(reply.json<{ data?: unknown }>().data, 0);
    created.push(`${path}: ${reply.status}${reply.status < 300 ? "" : ` ${reply.text.slice(0, 300)} body=${JSON.stringify(body).slice(0, 300)}`}`);
  }
  if (known["supportCaseId"] !== undefined) known["caseId"] ??= known["supportCaseId"];
});
after(async () => {
  net.Socket.prototype.connect = originalConnect;
  dgram.Socket.prototype.send = originalSend;
  dgram.Socket.prototype.connect = originalDgramConnect;
  await stopWorld?.();
});

/** Agency A's id of a parameter or member name; any other is a fresh, unknown id. */
function fillId(name: string): string {
  return known[name] ?? ids.next();
}
function fill(path: string): { readonly url: string; readonly random: ReadonlyArray<string> } {
  const random: string[] = [];
  const url = path.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => {
    if (known[name] === undefined) random.push(name);
    return fillId(name);
  });
  return { url, random };
}

const PUBLIC = /^\/api\/v1\/(public|sessions|assurance)\b|^\/(livez|readyz)$|^\/api\/v1\/payments\/webhooks\//;
/** Corporate surfaces: the stranger lacks every corporate role, so the refusal (CORPORATE_ROLE_MISSING) holds whatever the id. */
const CORPORATE = /^\/api\/v1\/(operations|ops)\//;
/** Customer routes whose path id names a resource this fixture does not hold, with the reason (each is proved by its own command tests). */
const REASON = {
  audits: "an audit needs a target contract confirmed by the control plane's observation on a CRM project (B08); its isolation: apps/api cmd020/cmd021/audit-reads tests",
  jobs: "a processing job exists only after the control plane admits an executed purchase (B08 JOB_ADMISSION); isolation: cmd036/cmd037 and apps/control tests",
  packages: "a package exists only after a job publishes it (B08); isolation: cmd038 download-authorization tests",
  stages: "an import stage exists only for a CRM execution (B17); isolation: b17 import-stage tests",
  manifests: "a selection manifest needs an inspected upload (B07 inspection pipeline); isolation: B07 source-lifecycle tests",
  tables: "a table preview needs an inspected upload (B07); isolation: B07 preview tests",
  sales: "seller-side resources (claims, periods, prospects, sellers, statements) belong to seller principals, not to an agency tenant: agency A owns none; isolation: O22 and B10 sales tests",
} as const;
const RANDOM_ID_ROUTES: Readonly<Record<string, string>> = {
  "POST /api/v1/audits/{auditId}/cancel": REASON.audits,
  "POST /api/v1/audits/{auditId}/decision-artifacts": REASON.audits,
  "POST /api/v1/audits/{auditId}/plans": REASON.audits,
  "GET /api/v1/audits/{auditId}": REASON.audits,
  "POST /api/v1/jobs/{jobId}/cancel": REASON.jobs,
  "GET /api/v1/jobs/{jobId}": REASON.jobs,
  "POST /api/v1/packages/{packageId}/download-authorizations": REASON.packages,
  "POST /api/v1/projects/{projectId}/import-stages/{stageId}/continue": REASON.stages,
  "POST /api/v1/projects/{projectId}/import-stages/{stageId}/receipts": REASON.stages,
  "GET /api/v1/revisions/{revisionId}/selection-manifests/{selectionManifestId}": REASON.manifests,
  "GET /api/v1/revisions/{revisionId}/tables/{tableId}/preview": REASON.tables,
  "POST /api/v1/sales/claims/{claimId}/accept": REASON.sales,
  "POST /api/v1/sales/commission-periods/{periodId}/close": REASON.sales,
  "POST /api/v1/sales/prospects/{prospectId}/claims": REASON.sales,
  "POST /api/v1/sales/sellers/{sellerId}/activate": REASON.sales,
  "POST /api/v1/sales/sellers/{sellerId}/terminate": REASON.sales,
  "POST /api/v1/sales/statements/{statementId}/approve-payout": REASON.sales,
  "POST /api/v1/sales/statements/{statementId}/reconcile-payout": REASON.sales,
  "GET /api/v1/sales/statements/{statementId}": REASON.sales,
};
/** Tables a refusal itself writes: the denial facts and the journal reservation. */
const REFUSAL_RECORDS = new Set(["security_events", "command_journal"]);

function routes(): ReadonlyArray<{ readonly method: "GET" | "POST"; readonly path: string }> {
  const out: Array<{ method: "GET" | "POST"; path: string }> = [];
  for (const [path, ops] of Object.entries(OPENAPI.paths)) {
    if (PUBLIC.test(path)) continue;
    for (const m of Object.keys(ops)) if (m === "get" || m === "post") out.push({ method: m.toUpperCase() as "GET" | "POST", path });
  }
  return out.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}

/** The row count of every kauro table, read from the catalog at run time (no remembered list). */
async function tableCounts(): Promise<Record<string, number>> {
  const tables = await w.h.oracle.query<{ relname: string }>("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'kauro' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1");
  const r = await w.h.oracle.query<Record<string, string>>(`SELECT ${tables.rows.map((t) => `(SELECT count(*) FROM kauro."${t.relname}")::text AS "${t.relname}"`).join(", ")}`);
  return Object.fromEntries(Object.entries(r.rows[0] ?? {}).map(([k, v]) => [k, Number(v)]));
}

test("a member of agency B reaches nothing of agency A through any served route, under its own or a forged agency header", async () => {
  const all = routes();
  assert.ok(all.length >= 100, `the sweep reads the served surface (${all.length} routes)`);
  // positive controls: the sweep's ids are A's real resources, read by A's owner (a vacuous sweep would pass on garbage ids)
  for (const url of [`/api/v1/agencies/${known["agencyId"]}`, `/api/v1/projects/${known["projectId"]}`, `/api/v1/quotes/${known["quoteId"]}`, `/api/v1/payment-orders/${known["orderId"]}`, `/api/v1/revisions/${known["revisionId"]}`]) {
    const reply = await call(w, { method: "GET", url, key: null, contentType: null, agency: url.includes("/agencies/") ? null : w.A.agencyId });
    assert.equal(reply.status, 200, `${url} as A's owner: ${reply.text}`);
  }

  const before = await tableCounts();
  const sentinels = ["Acme Agency", w.owner.userId, w.authorityA, known["quoteId"] as string, known["orderId"] as string, known["planId"] as string];
  const leaks: string[] = [];
  const admitted: string[] = [];
  const statuses = new Map<string, number>();
  const badReads: string[] = [];
  const unfilled: string[] = [];
  for (const r of all) {
    const { url, random } = fill(r.path);
    if (random.length > 0 && !CORPORATE.test(r.path) && RANDOM_ID_ROUTES[`${r.method} ${r.path}`] === undefined) unfilled.push(`${r.method} ${r.path} (${random.join(", ")})`);
    for (const agency of [w.B.agencyId, w.A.agencyId]) {
      const reply = await call(w, { method: r.method, url, token: w.stranger.token, agency, key: r.method === "POST" ? freshKey("sweep") : null, ...(r.method === "POST" ? { body: instance(OPENAPI.paths[r.path]?.["post"]?.requestBody?.content?.["application/json"]?.schema, "", fillId) } : { contentType: null }) });
      const k = `${r.method} ${reply.status}`;
      statuses.set(k, (statuses.get(k) ?? 0) + 1);
      if (r.method === "GET" && reply.status === 400) badReads.push(`${r.path}: ${reply.text}`);
      if (reply.status >= 200 && reply.status < 300) admitted.push(`${r.method} ${r.path} (${reply.status}, agency ${agency === w.A.agencyId ? "A forged" : "B"})`);
      for (const s of sentinels) if (!url.includes(s) && reply.text.includes(s)) leaks.push(`${r.method} ${r.path} leaks ${s}`);
      assert.ok(reply.status < 500, `${r.method} ${r.path}: ${reply.status} ${reply.text}`);
    }
  }
  process.stdout.write(`# o28a sweep: ${all.length} routes x 2 headers; seeded ${JSON.stringify(created)}; statuses ${JSON.stringify([...statuses].sort())}\n`);
  assert.deepEqual(unfilled, [], "every customer route is called with A's real ids (or is listed in RANDOM_ID_ROUTES with its reason)");
  // a collection read of B's own data (GET /api/v1/agencies) is legitimately 2xx: it must name nothing of A
  const allowedOwnReads = new Set(["GET /api/v1/agencies (200, agency B)", "GET /api/v1/agencies (200, agency A forged)"]);
  assert.deepEqual(admitted.filter((a) => !allowedOwnReads.has(a)), [], "no foreign route admitted");
  assert.deepEqual(leaks, [], "no reply carries A's facts");
  assert.deepEqual(badReads, [], "no read refuses the sweep for its shape instead of its authority");
  // the commands get a minimal schema-valid body, so most of them meet authorization (or non-disclosure) rather than their schema
  const posts = [...statuses].filter(([k]) => k.startsWith("POST ")).reduce((n, [, c]) => n + c, 0);
  const byAuthority = ["POST 401", "POST 403", "POST 404"].reduce((n, k) => n + (statuses.get(k) ?? 0), 0);
  assert.ok(byAuthority * 4 >= posts * 3, `commands refused by authority: ${byAuthority} of ${posts}`);
  const after = await tableCounts();
  const written = Object.keys(after).filter((t) => !REFUSAL_RECORDS.has(t) && after[t] !== before[t]).map((t) => `${t} ${before[t]} -> ${after[t]}`);
  assert.deepEqual(written, [], "no row of any kauro table was written by the sweep (refusal records aside)");
});

test("egress: the api process opened no connection or datagram beyond the loopback while it served the sweep", () => {
  assert.ok(loopbackConnections > 0, "the observer saw the api's own loopback connections (positive control)");
  assert.deepEqual(outbound, []);
});
