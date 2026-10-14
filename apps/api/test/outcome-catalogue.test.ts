// The closed outcome catalogue of the served commands (re-check finding N13; 10 "Contract tests and compatibility": the release
// includes a command state matrix and an error catalogue; 10 "Responses and safe errors": frontend control flow uses the code,
// the reason and the typed fields). Three proofs: every listed outcome passes the send guard of its route and nothing else
// does (checkReply over the compiled Problem schema); every failure site of the pipeline and of each handler is an entry of the
// catalogue of the commands that reach it (read from the sources, so a new site cannot be added without its entry); and the
// route itself refuses an unlisted problem and answers a listed edition outcome over PostgreSQL 17.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProblemOutcome, ServedCommandId } from "@kauro/application";
import { AUDIT_COMMANDS, B06_COMMANDS, B07_COMMANDS, TEAM_COMMANDS, COMMAND_OUTCOMES, EXECUTION_COMMANDS, INTAKE_OUTCOMES, PROBLEM_STATUS, READ_OUTCOMES, ResponseContractViolation, RETENTION_COMMANDS, SERVED_COMMAND_IDS, SUPPORT_COMMANDS, checkReply, commandRouteResponses, outcomeOf, problemOf } from "@kauro/application";
import type { FailureCode, FailureReason, FieldError, ProjectId } from "@kauro/domain";
import { DomainFailure, FAILURE_CODES, FAILURE_REASONS } from "@kauro/domain";
import { assembleApi, createBearerTokenAuthenticator, loadContractSchemas } from "../src/index.js";
import { auditRoutes, decidedBody, driveTo, fundPool, startedAudit, storeDecisionArtifact, storedCandidates, storedData } from "./audit-support.js";
import { activate } from "./source-support.js";
import { approvalBodyOf, call, clock, completed, ids, outcome, routes, world, type World } from "./support.js";

const validator = loadContractSchemas();
const CONTENT_TYPE = "application/problem+json";
/** The specs of every served command: B06's seven, B07's six (mandate B07-COMMANDS), B08's two job commands (B08-COMMANDS-EXECUTION) and four audit commands (B08-COMMANDS-AUDIT), and B11's CMD044 (W4). */
const SPECS = { ...B06_COMMANDS, ...B07_COMMANDS, ...EXECUTION_COMMANDS, ...AUDIT_COMMANDS, ...SUPPORT_COMMANDS, ...TEAM_COMMANDS, ...RETENTION_COMMANDS };

function problemFor(entry: ProblemOutcome, overrides: { readonly fields?: ReadonlyArray<FieldError>; readonly current?: boolean } = {}) {
  const fields = overrides.fields ?? (entry.fieldCodes !== undefined ? entry.fieldCodes.map((code) => ({ field: "expectedVersion", code })) : undefined);
  const current = overrides.current ?? entry.current !== undefined;
  return problemOf(
    new DomainFailure(entry.code, "catalogue probe", {
      ...(entry.reason !== null ? { reason: entry.reason } : {}),
      ...(fields !== undefined && fields.length > 0 ? { fields } : {}),
      ...(current ? { currentVersion: 3, currentState: "ACTIVE" } : {}),
    }),
    ids.next(),
  );
}

function refused(command: ServedCommandId, problem: ReturnType<typeof problemOf>): ResponseContractViolation {
  try {
    checkReply(validator, commandRouteResponses(command, SPECS[command].name), problem.status, CONTENT_TYPE, problem);
  } catch (e) {
    if (e instanceof ResponseContractViolation) return e;
    throw e;
  }
  throw new Error(`${command}: ${problem.code}/${problem.reason ?? "-"} passed the send guard`);
}

test("N13: every listed outcome of every served command passes the send guard of its route — with its field codes and its current version — and a problem outside the catalogue, a field code or a current the entry does not list, or a missing current it always carries, is refused", () => {
  let listed = 0;
  for (const command of SERVED_COMMAND_IDS) {
    const contract = commandRouteResponses(command, SPECS[command].name);
    assert.equal(contract.outcomes, COMMAND_OUTCOMES[command]);
    for (const entry of COMMAND_OUTCOMES[command]) {
      const problem = problemFor(entry);
      assert.equal(problem.status, PROBLEM_STATUS[entry.code]);
      checkReply(validator, contract, problem.status, CONTENT_TYPE, problem);
      if (entry.current === "SOMETIMES") checkReply(validator, contract, problem.status, CONTENT_TYPE, problemFor(entry, { current: false }));
      if (entry.fieldCodes !== undefined) checkReply(validator, contract, problem.status, CONTENT_TYPE, problemFor(entry, { fields: [] }));
      listed += 1;
    }
    // every (code, reason) pair of the vocabulary that the command does not list is refused
    const unlisted: Array<[FailureCode, FailureReason | null]> = [];
    for (const code of FAILURE_CODES) for (const reason of [null, ...FAILURE_REASONS]) if (outcomeOf(COMMAND_OUTCOMES[command], code, reason ?? undefined) === null) unlisted.push([code, reason]);
    for (const [code, reason] of unlisted) {
      const violation = refused(command, problemOf(new DomainFailure(code, "unlisted", reason !== null ? { reason } : {}), ids.next()));
      assert.match(violation.message, /is not in the route's catalogue/);
      assert.ok(!violation.message.includes("unlisted"), "the failure message never reaches the violation");
    }
    assert.ok(unlisted.length > 0);
  }
  assert.ok(listed > 7 * 20, `${listed} listed outcomes`);
  // the shape rules of an entry: field codes, `current`
  assert.match(refused("CMD009", problemFor(outcomeOf(COMMAND_OUTCOMES.CMD009, "INVALID_REQUEST", "UNKNOWN_REFERENCE")!, { fields: [{ field: "processingAuthorityRef", code: "TYPE" }] })).message, /carries a field error its catalogue entry does not list/);
  assert.match(refused("CMD010", problemFor(outcomeOf(COMMAND_OUTCOMES.CMD010, "NOT_FOUND", undefined)!, { current: true })).message, /carries current, which its catalogue entry never does/);
  assert.match(refused("CMD026", problemFor(outcomeOf(COMMAND_OUTCOMES.CMD026, "PRECONDITION_FAILED", "PLAN_NOT_APPROVED")!, { current: false })).message, /lacks current, which its catalogue entry always carries/);
  assert.match(refused("CMD001", problemFor(outcomeOf(COMMAND_OUTCOMES.CMD001, "ADMISSION_LIMITED", "DRAFT_AGENCY_EXISTS")!, { fields: [{ field: "displayName", code: "FORMAT" }] })).message, /carries a field error/);
  // a command answers only its own outcomes: another command's reason is refused on it
  assert.match(refused("CMD001", problemFor(outcomeOf(COMMAND_OUTCOMES.CMD025, "SOURCE_EXPIRED", undefined)!)).message, /is not in the route's catalogue/);
  assert.match(refused("CMD009", problemFor(outcomeOf(COMMAND_OUTCOMES.CMD025, "ASSURANCE_REQUIRED", "STEP_UP_STALE")!)).message, /is not in the route's catalogue/);
});

// --- the failure sites, read from the sources ---------------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const source = (path: string): string => readFileSync(`${ROOT}${path}`, "utf8");

/** The text of every call `name(...)` in `text`, balanced over (), {}, [] and string literals. */
function callsOf(text: string, name: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(name + "(", from);
    if (at < 0) return out;
    let depth = 0;
    let quote: string | null = null;
    let end = at + name.length;
    for (; end < text.length; end++) {
      const c = text[end]!;
      if (quote !== null) {
        if (c === "\\") end++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(text.slice(at, end + 1));
    from = end + 1;
  }
}

/**
 * The reasons a non-literal `reason:` of a handler can take, resolved from the source it names. A new indirection has no entry
 * here and fails the scan, so no failure site goes unread.
 */
const INDIRECT_REASONS: ReadonlyArray<{ readonly expression: RegExp; readonly reasons: () => ReadonlyArray<FailureReason> }> = [
  // CreateAgency: the abuse limiter's LIMITED reasons (packages/authorization/src/admission.ts)
  { expression: /reason: admission\.reason/, reasons: () => [...source("packages/authorization/src/admission.ts").matchAll(/kind: "LIMITED", reason: "([A-Z_]+)"/g)].map((m) => m[1] as FailureReason) },
  // RevisePlan: refusalReason(state) returns one literal per terminal state
  { expression: /reason: refusalReason\(/, reasons: () => [...(/function refusalReason[\s\S]*?\n}/.exec(source("packages/application/src/commands/handlers/revise-plan.ts"))?.[0] ?? "").matchAll(/return "([A-Z_]+)"/g)].map((m) => m[1] as FailureReason) },
  // RevisePlan: a compiler rejection's reason, COMPILER_REASON[...]
  { expression: /\{ reason, fields/, reasons: () => [...(/const COMPILER_REASON[^\n]*Object\.freeze\(\{([\s\S]*?)\}\);/.exec(source("packages/application/src/commands/handlers/revise-plan.ts"))?.[1] ?? "").matchAll(/: "([A-Z_]+)"/g)].map((m) => m[1] as FailureReason) },
];

/** The reasons of the strict JSON parser (StrictJsonReason), which admission raises as invalid(e.reason). */
const strictJsonReasons = (): ReadonlyArray<FailureReason> =>
  [...(/export type StrictJsonReason = [^;]*;/.exec(source("packages/application/src/api/strict-json.ts"))?.[0] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as FailureReason);

/** The reason requireProviders raises when no provider adapter is bound (packages/application/src/sources/handlers/shared.ts, D-SAPI-6). */
const sourceServicesReason = (): FailureReason => /function requireProviders[\s\S]*?reason: "([A-Z_]+)"/.exec(source("packages/application/src/sources/handlers/shared.ts"))?.[1] as FailureReason;

/** The reason IdempotencyConflictFailure carries (packages/domain/src/model/errors.ts). */
const idempotencyConflictReason = (): FailureReason => /class IdempotencyConflictFailure[\s\S]*?reason: "([A-Z_]+)"/.exec(source("packages/domain/src/model/errors.ts"))?.[1] as FailureReason;

/**
 * Top-level helpers that build a failure from their parameters: their bodies are not sites, their call sites are (read below as
 * invalid("X"), invalid(e.reason), problemFor("X"), and a handler's checkExpectedVersion(...) or applied(...) as STALE_VERSION).
 */
const FAILURE_HELPERS = ["invalid", "problemFor", "checkExpectedVersion", "applied", "requireProviders"];

function withoutHelperBodies(text: string): string {
  let out = text;
  for (const name of FAILURE_HELPERS) {
    const found = new RegExp(`\\n(?:export )?function ${name}[<(]`).exec(out);
    if (found === null) continue;
    const end = out.indexOf("\n}\n", found.index);
    assert.ok(end > found.index, `the helper ${name} has a top-level body`);
    out = out.slice(0, found.index) + out.slice(end + 2);
  }
  return out;
}

/** Every (code, reason) a failure-constructing call in `text` can raise. */
function sitesOf(input: string, file: string): Array<{ code: FailureCode; reason: FailureReason | null; site: string }> {
  const text = withoutHelperBodies(input);
  const sites: Array<{ code: FailureCode; reason: FailureReason | null; site: string }> = [];
  const reasonsIn = (call: string): Array<FailureReason | null> => {
    const literal = /reason: "([A-Z_]+)"/.exec(call);
    if (literal) return [literal[1] as FailureReason];
    const indirect = INDIRECT_REASONS.find((i) => i.expression.test(call));
    if (indirect) {
      const reasons = indirect.reasons();
      assert.ok(reasons.length > 0, `${file}: the indirection ${String(indirect.expression)} resolved to no reason`);
      return [...reasons];
    }
    assert.ok(!/\breason\b/.test(call.replace(/"[^"]*"/g, "")), `${file}: a failure site with a reason the scan cannot resolve: ${call.slice(0, 160)}`);
    return [null];
  };
  for (const call of callsOf(text, "new DomainFailure")) {
    const code = /^new DomainFailure\(\s*"([A-Z_]+)"/.exec(call)?.[1];
    assert.ok(code !== undefined && (FAILURE_CODES as ReadonlyArray<string>).includes(code), `${file}: a DomainFailure without a literal code: ${call.slice(0, 120)}`);
    for (const reason of reasonsIn(call)) sites.push({ code: code as FailureCode, reason, site: call.slice(0, 100) });
  }
  for (const call of callsOf(text, "new StaleVersionFailure")) for (const reason of reasonsIn(call)) sites.push({ code: "STALE_VERSION", reason, site: call.slice(0, 100) });
  for (const helper of ["checkExpectedVersion", "applied"]) if (callsOf(text, helper).some((c) => !c.startsWith("function"))) sites.push({ code: "STALE_VERSION", reason: null, site: helper });
  for (const call of callsOf(text, "deny")) {
    const m = /^deny\("([A-Z_]+)", "([A-Z_]+)"\)/.exec(call);
    if (m) sites.push({ code: m[1] as FailureCode, reason: m[2] as FailureReason, site: call });
  }
  for (const m of text.matchAll(/return \{ kind: "(?:MISSING|STALE)", reason: "([A-Z_]+)" \}/g)) sites.push({ code: "ASSURANCE_REQUIRED", reason: m[1] as FailureReason, site: m[0] });
  for (const m of text.matchAll(/\binvalid\("([A-Z_]+)"/g)) sites.push({ code: "INVALID_REQUEST", reason: m[1] as FailureReason, site: m[0] });
  if (/\binvalid\(e\.reason\)/.test(text)) for (const reason of strictJsonReasons()) sites.push({ code: "INVALID_REQUEST", reason, site: "invalid(e.reason)" });
  if (/new IdempotencyConflictFailure\(/.test(text)) sites.push({ code: "IDEMPOTENCY_CONFLICT", reason: idempotencyConflictReason(), site: "new IdempotencyConflictFailure()" });
  // B07: a provider port reached through requireProviders(...) (sources/handlers/shared.ts) answers SOURCE_SERVICES_UNAVAILABLE unbound
  if (/\brequireProviders\(/.test(text)) sites.push({ code: "INTEGRITY_FAILURE", reason: sourceServicesReason(), site: "requireProviders(...)" });
  for (const m of text.matchAll(/\bproblemFor\("([A-Z_]+)"/g)) sites.push({ code: "INVALID_REQUEST", reason: m[1] as FailureReason, site: m[0] });
  const framework = /function frameworkReason[\s\S]*?\n}/.exec(text)?.[0];
  if (framework !== undefined) for (const m of framework.matchAll(/return "([A-Z_]+)";/g)) sites.push({ code: "INVALID_REQUEST", reason: m[1] as FailureReason, site: `frameworkReason → ${m[1]}` });
  for (const m of text.matchAll(/reason: FailureReason = [^;]*?\? "([A-Z_]+)" : "([A-Z_]+)"/g)) for (const r of [m[1], m[2]]) sites.push({ code: "INVALID_REQUEST", reason: r as FailureReason, site: m[0] });
  return sites;
}

/** A B06 handler: its own file (commands/handlers/shared.ts is part of the pipeline). */
const b06 = (file: string): ReadonlyArray<string> => [`commands/handlers/${file}`];
const b06team = (file: string): ReadonlyArray<string> => [`commands/handlers/${file}`, "commands/handlers/team-shared.ts"];
/**
 * A B07 handler (mandate B07-COMMANDS): its own file with the source lifecycle's shared helpers and projections, and the helpers it
 * alone calls — every file whose sites the command can reach.
 */
const b07 = (file: string, ...helpers: ReadonlyArray<string>): ReadonlyArray<string> => [file, "shared.ts", "projections.ts", ...helpers].map((f) => `sources/handlers/${f}`);
/**
 * A B08 handler (mandate B08-COMMANDS-EXECUTION): its own file with the execution package's shared helpers and the job projection —
 * every file whose sites the command can reach.
 */
const b08 = (file: string, ...helpers: ReadonlyArray<string>): ReadonlyArray<string> => [file, "shared.ts", "projections.ts", ...helpers].map((f) => `execution/handlers/${f}`);

/**
 * A B08 audit handler (mandate B08-COMMANDS-AUDIT): its own file with the audit package's shared helpers and the audit and plan projections.
 */
const b08audit = (file: string, ...helpers: ReadonlyArray<string>): ReadonlyArray<string> => [file, "shared.ts", "projections.ts", ...helpers].map((f) => `audit/handlers/${f}`);

/** The files of each served command's handler, under packages/application/src. */
const HANDLER_FILES: Readonly<Record<ServedCommandId, ReadonlyArray<string>>> = {
  CMD001: b06("create-agency.ts"),
  CMD009: b06("create-client.ts"),
  CMD010: b06("archive-client.ts"),
  CMD011: b06("create-project.ts"),
  CMD023: b06("revise-plan.ts"),
  CMD025: b06("approve-plan.ts"),
  CMD026: b06("withdraw-approval.ts"),
  CMD012: b07("create-revision.ts"),
  CMD013: b07("reserve-upload.ts"),
  CMD014: b07("complete-upload.ts"),
  CMD015: b07("cancel-upload.ts"),
  CMD016: b07("select-input-tables.ts", "selection-rules.ts"),
  CMD017: b07("seal-revision.ts"),
  CMD036: b08("execute-project.ts"),
  CMD037: b08("cancel-job.ts"),
  CMD038: b08("authorize-download.ts"),
  CMD018: b08audit("create-target-contract.ts"),
  CMD019: b08audit("confirm-target-contract.ts"),
  CMD040: b08audit("submit-stage-receipt.ts"),
  CMD041: b08audit("continue-stage.ts"),
  CMD020: b08audit("start-audit.ts"),
  CMD021: b08audit("cancel-audit.ts"),
  CMD022: b08audit("create-plan.ts"),
  CMD024: b08audit("validate-plan.ts"),
  CMD044: b06("create-support-case.ts"),
  CMD042: b07("request-deletion.ts"),
  CMD060: b07("request-retention-extension.ts"),
  CMD003: b06team("invite-member.ts"),
  CMD004: b06team("accept-invitation.ts"),
  CMD005: b06team("change-membership.ts"),
  CMD006: b06team("revoke-membership.ts"),
  CMD007: b06team("transfer-ownership.ts"),
};

const handlerSitesOf = (command: ServedCommandId) => HANDLER_FILES[command].flatMap((file) => sitesOf(source(`packages/application/src/${file}`), file));

/**
 * Pipeline sites no served route reaches, each with why (the scan reads them and this list says where they end): a new
 * unreachable site must be named here, and one named here must still exist.
 */
const UNREACHABLE_PIPELINE_SITES: ReadonlyArray<{ readonly code: FailureCode; readonly reason: FailureReason | null; readonly why: string }> = [
  { code: "NOT_FOUND", reason: null, why: "server.ts: the not-found handler answers an unrouted request (UNROUTED_RESPONSES); on a route NOT_FOUND is the handler's own site" },
  { code: "INVALID_REQUEST", reason: "REQUEST_TIMEOUT", why: "server.ts: the request timeout is answered below HTTP on the socket, where no route exists (UNROUTED_RESPONSES)" },
  { code: "INVALID_REQUEST", reason: "TENANT_CONTEXT_MISSING", why: "runtime.contextOf: admission refuses a tenant route without its selector first (AGENCY_SELECTOR_INVALID; an AGENCY_PATH id is a path parameter)" },
  { code: "NOT_AUTHORIZED", reason: "ROLE_INSUFFICIENT", why: "authorizer: a command without a registry role, or with a corporate or service role, is not served; tenant routes list ROLE_INSUFFICIENT for the membership role" },
];

test("N13: every failure site of the pipeline (transport, runtime, admission, authorizer, assurance verifier) and of each handler is an entry of the catalogue of every command that reaches it — read from the sources, with each non-literal reason resolved", () => {
  const pipeline = [
    ...sitesOf(source("packages/application/src/commands/runtime.ts"), "runtime.ts"),
    ...sitesOf(source("packages/application/src/api/admission.ts"), "admission.ts"),
    ...sitesOf(source("packages/application/src/commands/handlers/shared.ts"), "shared.ts"),
    ...sitesOf(source("packages/authorization/src/authorizer.ts"), "authorizer.ts"),
    ...sitesOf(source("apps/api/src/server.ts"), "server.ts"),
    // the credential decisions of the session authenticator (B11 D-AUTH-5), reached by every command before the journal
    ...sitesOf(source("packages/application/src/sessions/protocol.ts"), "protocol.ts"),
  ];
  const assurance = sitesOf(source("packages/authorization/src/assurance.ts"), "assurance.ts");
  assert.ok(pipeline.length >= 20 && new Set(assurance.map((s) => s.reason)).size === 3, `${pipeline.length} pipeline sites, ${assurance.length} assurance sites`);
  const tenantOnly = new Set(["TENANT_CONTEXT_MISSING", "NOT_A_MEMBER", "MEMBERSHIP_SUSPENDED", "MEMBERSHIP_NOT_ACTIVE", "ROLE_INSUFFICIENT", "PATH_ID_INVALID", "AGENCY_SELECTOR_INVALID"]);
  const unreachableSeen = new Set<string>();
  for (const command of SERVED_COMMAND_IDS) {
    const spec = SPECS[command];
    const handlerSites = handlerSitesOf(command);
    assert.ok(handlerSites.length > 0, `${command} has failure sites`);
    const reached = [...pipeline, ...(spec.stepUpRequired ? assurance : []), ...handlerSites];
    for (const site of reached) {
      const unreachable = UNREACHABLE_PIPELINE_SITES.find((u) => u.code === site.code && u.reason === site.reason);
      if (unreachable && !handlerSites.includes(site) && outcomeOf(COMMAND_OUTCOMES[command], site.code, site.reason ?? undefined) === null) {
        unreachableSeen.add(`${site.code}/${site.reason}`);
        continue;
      }
      // a tenant-only pipeline decision is not reachable on the identity-scoped route (CreateAgency: no agency, no path id)
      if (spec.scope === "NONE" && site.reason !== null && tenantOnly.has(site.reason) && !handlerSites.includes(site)) continue;
      // the header selector is decided only on AGENCY_HEADER routes
      if (spec.scope !== "AGENCY_HEADER" && site.reason === "AGENCY_SELECTOR_INVALID") continue;
      if (spec.scope === "NONE" && site.reason === "PATH_ID_INVALID") continue;
      assert.ok(outcomeOf(COMMAND_OUTCOMES[command], site.code, site.reason ?? undefined) !== null, `${command}: the failure site ${site.code}/${site.reason ?? "-"} (${site.site}) is not in its catalogue`);
    }
  }
  assert.deepEqual([...unreachableSeen].sort(), UNREACHABLE_PIPELINE_SITES.map((u) => `${u.code}/${u.reason}`).sort(), "every named unreachable site still exists and is still unreachable");
});

test("B07-COMMANDS: every failure site of the source reads and of the selection manifest intake is an entry of their catalogues — each read's own sites and the helpers it reaches, the intake's document rules; the access decisions of the reads on every source read and the intake's operating role", () => {
  const readSites = [...sitesOf(source("packages/application/src/sources/handlers/reads.ts"), "reads.ts"), ...sitesOf(source("packages/application/src/sources/handlers/shared.ts"), "shared.ts"), ...sitesOf(source("packages/application/src/sources/handlers/projections.ts"), "projections.ts")];
  const union = Object.entries(READ_OUTCOMES).filter(([op]) => !["ListAgencies", "GetAgency", "ListMembers", "ListClients", "GetProject"].includes(op)).flatMap(([, entries]) => entries);
  assert.ok(readSites.length >= 8, `${readSites.length} source read sites`);
  for (const site of readSites) assert.ok(union.some((o) => o.code === site.code && o.reason === site.reason), `the source read failure site ${site.code}/${site.reason ?? "-"} (${site.site}) is in no source read catalogue`);
  // the session read follows the command's own role; the other reads admit every role (D-SAPI-1)
  assert.ok(READ_OUTCOMES.GetUploadSession.some((o) => o.reason === "ROLE_INSUFFICIENT"));
  for (const op of ["GetSelectionManifest", "GetRevision", "GetInspection", "ListUploads", "GetUpload", "PreviewTable"] as const) assert.ok(!READ_OUTCOMES[op].some((o) => o.reason === "ROLE_INSUFFICIENT"), op);
  // the intake: its own sites and the document rules it applies (checkDocument of selection-rules.ts)
  const checkDocument = /export function checkDocument[\s\S]*?\n}\n/.exec(source("packages/application/src/sources/handlers/selection-rules.ts"))?.[0] ?? "";
  assert.ok(checkDocument.length > 0, "the document rules are found");
  const intakeSites = [...sitesOf(source("packages/application/src/sources/handlers/intake.ts"), "intake.ts"), ...sitesOf(checkDocument, "selection-rules.ts checkDocument")];
  for (const site of intakeSites) assert.ok(outcomeOf(INTAKE_OUTCOMES.SubmitSelectionManifest, site.code, site.reason ?? undefined) !== null, `the intake failure site ${site.code}/${site.reason ?? "-"} (${site.site}) is not in its catalogue`);
  assert.ok(intakeSites.some((s) => s.reason === "ROLE_INSUFFICIENT") && intakeSites.some((s) => s.reason === "SELECTION_MANIFEST_MISMATCH"));
});

test("B08-COMMANDS-AUDIT: every failure site of GetAudit and of the decision artifact intake is an entry of their catalogues — the read's own sites, the intake's own sites and the role it needs; GetAudit admits every role", () => {
  const readSites = sitesOf(source("packages/application/src/audit/handlers/reads.ts"), "reads.ts");
  assert.ok(readSites.length >= 2, `${readSites.length} audit read sites`);
  for (const site of readSites) assert.ok(outcomeOf(READ_OUTCOMES.GetAudit, site.code, site.reason ?? undefined) !== null, `the audit read failure site ${site.code}/${site.reason ?? "-"} (${site.site}) is not in its catalogue`);
  assert.ok(!READ_OUTCOMES.GetAudit.some((o) => o.reason === "ROLE_INSUFFICIENT"), "every role reads an audit");
  const intakeSites = sitesOf(source("packages/application/src/audit/handlers/intake.ts"), "intake.ts");
  for (const site of intakeSites) assert.ok(outcomeOf(INTAKE_OUTCOMES.SubmitDecisionArtifact, site.code, site.reason ?? undefined) !== null, `the intake failure site ${site.code}/${site.reason ?? "-"} (${site.site}) is not in its catalogue`);
  assert.ok(intakeSites.some((s) => s.reason === "ROLE_INSUFFICIENT") && intakeSites.some((s) => s.reason === "BODY_TOO_LARGE"));
});

test("N13/N16: every failure site of the reads (queries/reads.ts) is an entry of the read catalogues — the tenant-scoped decisions of every agency read, the query and cursor refusals of every list", () => {
  const sites = sitesOf(source("packages/application/src/queries/reads.ts"), "reads.ts");
  // the read's own selector guard: admission refuses a tenant read without its selector first (AGENCY_SELECTOR_INVALID; an
  // AGENCY_PATH id is a path parameter), so runRead's refusal is a defensive guard no request reaches
  const unreachable = new Set(["INVALID_REQUEST/TENANT_CONTEXT_MISSING"]);
  const union = Object.values(READ_OUTCOMES).flat();
  assert.ok(sites.length >= 8, `${sites.length} read sites`);
  for (const site of sites) {
    const key = `${site.code}/${site.reason ?? "-"}`;
    if (unreachable.has(key)) continue;
    assert.ok(union.some((o) => o.code === site.code && o.reason === site.reason), `the read failure site ${key} (${site.site}) is in no read catalogue`);
  }
  assert.ok(sites.some((s) => `${s.code}/${s.reason}` === "INVALID_REQUEST/TENANT_CONTEXT_MISSING"), "the named unreachable site still exists");
  // the membership decisions of authorizeRead reach every tenant read; ROLE_INSUFFICIENT reaches none (every role reads)
  for (const operationId of ["GetAgency", "ListMembers", "ListClients", "GetProject"] as const) {
    for (const reason of ["TENANT_CONTEXT_MISSING", "NOT_A_MEMBER", "MEMBERSHIP_SUSPENDED", "MEMBERSHIP_NOT_ACTIVE"] as const) assert.ok(READ_OUTCOMES[operationId].some((o) => o.reason === reason), `${operationId} ${reason}`);
    assert.ok(!READ_OUTCOMES[operationId].some((o) => o.reason === "ROLE_INSUFFICIENT"), operationId);
  }
});

// --- the route ------------------------------------------------------------------------------------------------------------------

const armed: { failure: DomainFailure | null } = { failure: null };
let w: World;
let projectId: ProjectId;
before(async () => {
  w = await world({
    collaborators: (base) => ({
      ...base,
      externalActions: {
        async completedForPlan(uow, planId) {
          if (armed.failure !== null) throw armed.failure;
          return base.externalActions.completedForPlan(uow, planId);
        },
      },
    }),
  });
  projectId = (await w.project(w.A, w.clientA)).projectId;
});
after(async () => {
  await w.stop();
});

test("N13: a command route never answers a problem its catalogue does not list — a collaborator's failure that the vocabulary knows but WithdrawApproval does not (PAYMENT_PENDING, or PLAN_NOT_APPROVED without its current version) answers 422 RESPONSE_CONTRACT_VIOLATION, the sink receives the violation, and nothing committed", async () => {
  const plan = await w.approvable(w.A, projectId, "n13-unlisted");
  completed(await call(w, { url: routes.approvePlan(plan.planId), token: w.approver.token, body: approvalBodyOf(plan, await w.stepUp(w.approver)) }), 201);
  for (const [failure, message] of [
    [new DomainFailure("PAYMENT_PENDING", "a later package's outcome"), /the outcome PAYMENT_PENDING\/- is not in the route's catalogue/],
    [new DomainFailure("PRECONDITION_FAILED", "missing current", { reason: "PLAN_NOT_APPROVED" }), /lacks current, which its catalogue entry always carries/],
  ] as const) {
    const sunk = w.internalErrors.length;
    armed.failure = failure;
    let reply;
    try {
      reply = await call(w, { url: routes.withdrawApproval(plan.planId), token: w.approver.token, body: { expectedVersion: 5, reasonCode: "CUSTOMER_REQUEST" } });
    } finally {
      armed.failure = null;
    }
    assert.equal(outcome(w, reply), "422 INTEGRITY_FAILURE RESPONSE_CONTRACT_VIOLATION");
    assert.equal(w.internalErrors.length, sunk + 1);
    const recorded = w.internalErrors.at(-1)!;
    assert.ok(recorded.error instanceof ResponseContractViolation);
    assert.equal(recorded.correlationId, reply.headers["x-correlation-id"]);
    assert.match(recorded.error.message, message);
    const row = await w.row<{ state: string; version: string }>("plans", "plan_id = $1", [plan.planId]);
    assert.deepEqual(row && [row.state, row.version], ["APPROVED", "5"], "nothing committed");
  }
  // the listed outcome of the same site is answered as it is
  const listed = await call(w, { url: routes.withdrawApproval(plan.planId), token: w.approver.token, body: { expectedVersion: 4, reasonCode: "CUSTOMER_REQUEST" } });
  assert.equal(outcome(w, listed), "409 STALE_VERSION -");
});

test("N13: the deployable edition's own outcome of CreatePlan and RevisePlan is in their catalogues — with the edition's collaborators and no core bound both answer 422 INTEGRITY_FAILURE CORE_SERVICES_UNAVAILABLE, nothing is journaled, no plan is written or changed, and no violation reaches the sink", async () => {
  const sunk: Array<{ correlationId: string; error: unknown }> = [];
  const edition = assembleApi({
    environment: "LOCAL",
    unitOfWork: w.db.unitOfWork,
    database: w.db,
    authenticator: createBearerTokenAuthenticator(new Map([[w.operator.token, w.operator.subject], [w.approver.token, w.approver.subject]])),
    validator: w.validator,
    clock,
    ids,
    onInternalError: (correlationId, error) => sunk.push({ correlationId, error }),
  });
  await edition.ready();
  try {
    // an audit that awaits the agency's decisions, and the two artifacts the agency stored for it through the intake (the platform's own)
    await activate(w);
    const aw = { w, poolId: null };
    await fundPool(aw);
    const started = await startedAudit(aw);
    await driveTo(w, started, "NEEDS_DECISION");
    const candidates = await storedCandidates(w, started.auditId, decidedBody(started.subject, "n13-edition"));
    const patchReply = await storeDecisionArtifact(w, started.auditId, { kind: "DECISION_PATCH", document: { candidate: "Phone", reasonCode: "X" } });
    assert.equal(patchReply.status, 201, patchReply.text);
    const patch = storedData(patchReply);
    const plan = await w.approvable(w.A, projectId, "n13-edition");
    const headers = { "content-type": "application/json", "x-kauro-agency": w.A.agencyId };
    const create = await edition.inject({ method: "POST", url: auditRoutes.createPlan(started.auditId), headers: { ...headers, authorization: `Bearer ${w.operator.token}`, "idempotency-key": `n13-edition-create-${started.auditId}` }, payload: JSON.stringify({ candidateDecisionArtifactRef: candidates.artifactRef }) });
    const revise = await edition.inject({ method: "POST", url: routes.revisePlan(plan.planId), headers: { ...headers, authorization: `Bearer ${w.operator.token}`, "idempotency-key": `n13-edition-revise-${plan.planId}` }, payload: JSON.stringify({ expectedVersion: plan.version, decisionPatchArtifactRef: patch.artifactRef }) });
    for (const reply of [create, revise]) {
      assert.equal(reply.statusCode, 422, reply.body);
      const problem = JSON.parse(reply.body) as { code: string; reason: string };
      assert.deepEqual([problem.code, problem.reason], ["INTEGRITY_FAILURE", "CORE_SERVICES_UNAVAILABLE"]);
    }
    assert.deepEqual(sunk, []);
    assert.equal(await w.count("command_journal", "idempotency_key LIKE 'n13-edition-%'"), 0);
    assert.equal(await w.count("plans", `project_id = '${started.subject.projectId}'`), 0, "CreatePlan wrote no plan");
    const row = await w.row<{ state: string; version: string }>("plans", "plan_id = $1", [plan.planId]);
    assert.deepEqual(row && [row.state, row.version], ["VALIDATED", String(plan.version)]);
  } finally {
    await edition.close();
  }
});
