// UI18 Free data health check as data (registry: "Review findings and decisions."; A3 3.2: the free step is never called an audit). What the
// api's AuditView says and nothing more: the screen separates the state, the measured facts the api reports, the decisions waiting, the
// unsupported capabilities and the allowance; it invents no finding, no count and no percentage.
import { CANDIDATE_CLEAN_SCHEMAS } from "../../api/candidate-schemas.ts";
import { type AuditView, OPERATIONS, SCHEMAS, type SuccessReply } from "../../api/generated.ts";
import type { ApiAnswer } from "../../client/answer.ts";
import type { ApiClient } from "../../client/api-client.ts";
import type { DurableRead, OperationRunner, RunOutcome } from "../../client/operation-runner.ts";

export type AuditState = AuditView["state"];

const RUNNING: ReadonlySet<AuditState> = new Set(["QUEUED", "PROFILING", "INTERPRETING", "VALIDATING"]);
const TERMINAL: ReadonlySet<AuditState> = new Set(["UNSUPPORTED", "FAILED", "CANCELLED", "EXPIRED"]);

export interface HealthCheckModel {
  readonly state: AuditState;
  /** Still working on its own: the page says so and offers a re-read, never a second request. */
  readonly running: boolean;
  readonly terminal: boolean;
  /** The free allowance is used up: the profile is kept and the interpretation is explicitly incomplete. */
  readonly interpretationIncomplete: boolean;
  readonly pendingDecisions: readonly string[];
  readonly unsupportedCapabilities: readonly string[];
  readonly terminalReason: string | null;
  /** CMD021 is offered only when the api permits it and the check has not ended. */
  readonly canCancel: boolean;
}

export function healthCheckModel(audit: AuditView): HealthCheckModel {
  const running = RUNNING.has(audit.state);
  const terminal = TERMINAL.has(audit.state);
  return {
    state: audit.state,
    running,
    terminal,
    interpretationIncomplete: audit.grantState === "EXHAUSTED" || audit.grantState === "EXPIRED",
    pendingDecisions: audit.pendingDecisions ?? [],
    unsupportedCapabilities: audit.unsupportedCapabilities ?? [],
    terminalReason: audit.terminalReason ?? null,
    canCancel: audit.permittedActions.includes("CancelAudit") && !terminal && audit.state !== "DRAFT_READY",
  };
}

/**
 * The schemas an audit reply is checked against: the served contract, or — only when the deployment switched on the O19A candidate's CLEAN
 * without a target (server/config/candidate.ts) — the candidate's AuditView, where a CLEAN audit has no targetContractId (CP-02.01). Every
 * read and command of an audit on this page goes through the same table (GetAudit, CancelAudit and its durable re-read).
 */
function schemasOf(cleanWithoutTarget: boolean) {
  return cleanWithoutTarget ? CANDIDATE_CLEAN_SCHEMAS : SCHEMAS;
}

/** The empty check of a CLEAN project asks for no destination only where CLEAN takes none: under the candidate switch (CP-01.01). */
export function noDestinationNeeded(cleanWithoutTarget: boolean, mode: string | undefined): boolean {
  return cleanWithoutTarget && mode === "CLEAN";
}

/** GetAudit against the schemas of this deployment's switch. */
export function readAudit(client: ApiClient, auditId: string, signal: AbortSignal | undefined, cleanWithoutTarget: boolean): Promise<ApiAnswer<SuccessReply<"GetAudit">>> {
  return client.send<SuccessReply<"GetAudit">>(OPERATIONS.GetAudit, { path: { auditId }, ...(signal === undefined ? {} : { signal }) }, schemasOf(cleanWithoutTarget));
}

/** After a lost answer to CMD021 the durable resource says whether it took effect: the check is CANCELLED, or not yet. */
export function readCancelled(client: ApiClient, auditId: string, cleanWithoutTarget = false): () => Promise<DurableRead<AuditView>> {
  return async () => {
    const answer = await readAudit(client, auditId, undefined, cleanWithoutTarget);
    if (answer.kind !== "REPLY") return { kind: "NO_ANSWER" };
    return answer.body.data.state === "CANCELLED" ? { kind: "RESOLVED", data: answer.body.data } : { kind: "NOT_YET" };
  };
}

/** CMD021 through the runner: the audit's cancel version is the subject version, so a second click, a reload and a second tab are one intent. */
export function cancelHealthCheck(client: ApiClient, runner: OperationRunner, audit: AuditView, cleanWithoutTarget = false): Promise<RunOutcome<AuditView>> {
  return runner.run<AuditView>({
    command: "CMD021",
    subject: { kind: "SUBJECT", subjectId: audit.auditId, subjectVersion: audit.cancelVersion },
    send: (key) => client.send<SuccessReply<"CancelAudit">>(OPERATIONS.CancelAudit, { path: { auditId: audit.auditId }, body: { expectedVersion: audit.cancelVersion }, idempotencyKey: key }, schemasOf(cleanWithoutTarget)),
    reread: readCancelled(client, audit.auditId, cleanWithoutTarget),
  });
}
