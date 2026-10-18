/**
 * The attempt ticket (B14-A; docs/design/B14-A-worker-executor.md §3): the one closed input a worker process receives.
 *
 * The control plane builds it at launch from its own records — the launch spec B08 recorded (identity, capability, subject, limits,
 * fence), the core plan binding of the job's plan (D5-16: execute translates a plan only through `core_plan_bindings`), the revision's
 * input files as the core reads them, and the report's inputs as `PlatformReportInputs` reads them — and the worker reads nothing else
 * of the platform: no database connection, no credential, no other attempt's object. The ticket is the canonical
 * KAURO_ATTEMPT_TICKET_V1 wrapper; its raw SHA-256 travels apart from it (the local host's command line, a cloud task's override), so a
 * worker refuses a ticket that is not exactly the one it was started for. Bytes inside it (a logo, the issuer's identity document) are
 * carried as `{"$bytes": "<base64>"}`.
 *
 * `attemptTicketProblems` is the worker's first act and the host's last check before it creates anything: an incomplete or
 * contradictory ticket starts nothing (a host answers REFUSED; a worker ends REFUSED without touching storage).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { canonicalBytes, isSha256Hex, parseCanonical, rawDigest } from "@kauro/contracts";
import { attemptCapabilityProblems, attemptIdentityOf, isAttemptIdentity, type AttemptCapability, type CoreInputRef, type CorePlanBinding, type ExecutionLimits, type ExecutionSubject } from "@kauro/application";
import type { AuthorizedReportInputs } from "../report/facts.js";
import type { ReportRenderConfig } from "../report/stage.js";

export const ATTEMPT_TICKET_DOMAIN = "KAURO_ATTEMPT_TICKET_V1";
/** The largest ticket a worker accepts (a plan body, a logo and an identity document fit many times over). */
export const ATTEMPT_TICKET_MAX_BYTES = 8 * 1024 * 1024;

export interface AttemptTicket {
  readonly identity: string;
  readonly fence: number;
  readonly capability: AttemptCapability;
  readonly subject: ExecutionSubject;
  readonly limits: ExecutionLimits;
  /** The closed MigrationConfig the job's plan compiled to and its core-native hash (`core_plan_bindings`, D5-16). */
  readonly planBinding: CorePlanBinding;
  /** The revision's sealed input files as the core reads them: exactly the capability's accepted generations. */
  readonly inputs: readonly CoreInputRef[];
  /** The report's inputs as the control plane read them for this attempt's scope (null: it has none; the report stage refuses). */
  readonly reportInputs: AuthorizedReportInputs | null;
  readonly render: ReportRenderConfig;
  /** The SHA-256 of the vendored Migration core the platform expects (ValidationReceipt.corePackageHash). */
  readonly corePackageHash: Sha256Hex;
  /** The host's instant of issue (evidence only; the deadline is the subject's). */
  readonly issuedAt: UtcInstant;
}

// --- bytes inside canonical JSON ---------------------------------------------------------------------------------------------------

const BYTES_KEY = "$bytes";
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function encode(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BYTES_KEY]: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = encode(v);
    return out;
  }
  return value;
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const only = entries[0];
    if (entries.length === 1 && only !== undefined && only[0] === BYTES_KEY && typeof only[1] === "string" && BASE64.test(only[1])) return new Uint8Array(Buffer.from(only[1], "base64"));
    return Object.fromEntries(entries.map(([k, v]) => [k, decode(v)]));
  }
  return value;
}

/** The ticket's bytes: the canonical wrapper, so its raw SHA-256 is the digest the worker is started with. */
export function attemptTicketBytesOf(ticket: AttemptTicket): Uint8Array {
  return canonicalBytes({ domain: ATTEMPT_TICKET_DOMAIN, version: 1, payload: encode(ticket) });
}

export function attemptTicketDigestOf(bytes: Uint8Array): Sha256Hex {
  return rawDigest(bytes);
}

export type AttemptTicketReading = { readonly ok: true; readonly ticket: AttemptTicket } | { readonly ok: false; readonly problem: string };

/** Reads a ticket the worker received: its digest, the closed wrapper, then every problem `attemptTicketProblems` finds. */
export function readAttemptTicket(bytes: Uint8Array, expectedDigest: string): AttemptTicketReading {
  const refuse = (problem: string): AttemptTicketReading => ({ ok: false, problem });
  if (bytes.byteLength > ATTEMPT_TICKET_MAX_BYTES) return refuse("TICKET_TOO_LARGE");
  if (!isSha256Hex(expectedDigest) || rawDigest(bytes) !== expectedDigest) return refuse("TICKET_DIGEST_MISMATCH");
  let doc: unknown;
  try {
    doc = parseCanonical(Buffer.from(bytes).toString("utf8"));
  } catch {
    return refuse("TICKET_NOT_CANONICAL");
  }
  // one spelling only: the bytes are exactly the canonical form of what they parse to
  if (Buffer.compare(Buffer.from(canonicalBytes(doc)), Buffer.from(bytes)) !== 0) return refuse("TICKET_NOT_CANONICAL");
  const wrapper = doc as { readonly domain?: unknown; readonly version?: unknown; readonly payload?: unknown } | null;
  if (wrapper === null || typeof wrapper !== "object" || Object.keys(wrapper).sort().join() !== "domain,payload,version") return refuse("TICKET_NOT_A_WRAPPER");
  if (wrapper.domain !== ATTEMPT_TICKET_DOMAIN || wrapper.version !== 1) return refuse("TICKET_FOREIGN_DOMAIN");
  const ticket = decode(wrapper.payload) as AttemptTicket;
  const [problem] = attemptTicketProblems(ticket);
  return problem === undefined ? { ok: true, ticket } : refuse(problem);
}

// --- the closed shape ---------------------------------------------------------------------------------------------------------------

const TICKET_KEYS = "capability,corePackageHash,fence,identity,inputs,issuedAt,limits,planBinding,render,reportInputs,subject";
const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array);
const positive = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const isInstant = (v: unknown): boolean => typeof v === "string" && Number.isFinite(Date.parse(v));
const textOrNull = (v: unknown): boolean => v === null || (typeof v === "string" && v.length > 0 && v.length <= 64);

/** Every limit is a positive whole number of bytes or milliseconds, and each budget sits inside its hard bound (manual 04). */
export function executionLimitsProblems(limits: ExecutionLimits): readonly string[] {
  const problems: string[] = [];
  const { hardMemoryBytes, memoryBudgetBytes, hardScratchBytes, scratchBudgetBytes, wallClockMs, effectsResidentBytes } = limits;
  if (![hardMemoryBytes, memoryBudgetBytes, hardScratchBytes, scratchBudgetBytes, wallClockMs].every(positive)) return ["LIMITS_INCOMPLETE"];
  if (memoryBudgetBytes > hardMemoryBytes) problems.push("MEMORY_BUDGET_PAST_HARD_LIMIT");
  if (scratchBudgetBytes > hardScratchBytes) problems.push("SCRATCH_BUDGET_PAST_HARD_LIMIT");
  if (effectsResidentBytes !== undefined && !positive(effectsResidentBytes)) problems.push("LIMITS_INCOMPLETE");
  return problems;
}

/** Every way a ticket departs from one attempt's complete, self-consistent input; empty when it is exactly that. */
export function attemptTicketProblems(ticket: AttemptTicket): readonly string[] {
  if (!isPlainObject(ticket) || Object.keys(ticket).sort().join() !== TICKET_KEYS) return ["TICKET_NOT_CLOSED"];
  const { capability, subject, limits, planBinding, inputs, render, reportInputs } = ticket;
  if (!isPlainObject(capability) || !isPlainObject(subject) || !isPlainObject(limits) || !isPlainObject(planBinding) || !Array.isArray(inputs) || !isPlainObject(render)) return ["TICKET_INCOMPLETE"];
  const problems: string[] = [];
  if (!isAttemptIdentity(ticket.identity) || ticket.identity !== capability.identity || ticket.identity !== attemptIdentityOfSafe(subject.attemptId)) problems.push("IDENTITY_NOT_THE_ATTEMPTS");
  for (const p of attemptCapabilityProblemsSafe(capability)) problems.push(`CAPABILITY_${p}`);
  if (subject.jobId !== capability.jobId || subject.attemptId !== capability.attemptId || subject.agencyId !== capability.agencyId || subject.projectId !== capability.projectId) problems.push("SUBJECT_NOT_THE_CAPABILITYS");
  if (!isSha256Hex(subject.inputBindingHash) || !isSha256Hex(subject.revisionHash) || !isSha256Hex(subject.planHash) || !(subject.targetContractHash === null || isSha256Hex(subject.targetContractHash))) problems.push("SUBJECT_INCOMPLETE");
  if (!isInstant(subject.executionDeadlineAt)) problems.push("DEADLINE_MISSING");
  if (!positive(ticket.fence)) problems.push("FENCE_MALFORMED");
  problems.push(...executionLimitsProblems(limits));
  if (!isPlainObject(planBinding.configDocument) || !isSha256Hex(planBinding.coreConfigHash) || Object.keys(planBinding).sort().join() !== "configDocument,coreConfigHash") problems.push("PLAN_BINDING_INCOMPLETE");
  problems.push(...inputsProblems(capability, inputs));
  if ((render.pageSize !== "LETTER" && render.pageSize !== "A4") || typeof render.locale !== "string" || render.locale.length === 0 || typeof render.rendererVersion !== "string" || render.rendererVersion.length === 0) problems.push("RENDER_INCOMPLETE");
  if (!isSha256Hex(ticket.corePackageHash)) problems.push("CORE_PACKAGE_HASH_MISSING");
  if (!isInstant(ticket.issuedAt)) problems.push("ISSUED_AT_MISSING");
  if (reportInputs !== null && !isPlainObject(reportInputs)) problems.push("REPORT_INPUTS_MALFORMED");
  return [...new Set(problems)];
}

/** The inputs are exactly the capability's sealed generations (no more, no fewer, none twice), each with how the core reads it. */
function inputsProblems(capability: AttemptCapability, inputs: readonly CoreInputRef[]): readonly string[] {
  const key = (g: { readonly objectName: string; readonly generation: string; readonly sha256: string; readonly byteLength: number }): string => `${g.objectName}#${g.generation}#${g.sha256}#${g.byteLength}`;
  if (!Array.isArray(capability.acceptedGenerations)) return ["INPUTS_NOT_THE_CAPABILITYS"];
  const sealed = new Set(capability.acceptedGenerations.map(key));
  const named = new Set<string>();
  for (const input of inputs) {
    if (!isPlainObject(input) || !isPlainObject(input.readConfig)) return ["INPUTS_MALFORMED"];
    const k = key(input);
    if (!sealed.has(k) || named.has(k)) return ["INPUTS_NOT_THE_CAPABILITYS"];
    named.add(k);
    const { format, encoding, delimiter, sheets } = input.readConfig;
    if ((format !== "CSV" && format !== "XLSX") || !textOrNull(encoding) || !textOrNull(delimiter) || !(sheets === null || (Array.isArray(sheets) && sheets.every((s) => typeof s === "string")))) return ["INPUT_READ_CONFIG_MALFORMED"];
  }
  return named.size === sealed.size && sealed.size > 0 ? [] : ["INPUTS_NOT_THE_CAPABILITYS"];
}

function attemptIdentityOfSafe(attemptId: unknown): string | null {
  try {
    return attemptIdentityOf(attemptId as string);
  } catch {
    return null;
  }
}

function attemptCapabilityProblemsSafe(capability: AttemptCapability): readonly string[] {
  try {
    return attemptCapabilityProblems(capability);
  } catch {
    return ["MALFORMED"];
  }
}
