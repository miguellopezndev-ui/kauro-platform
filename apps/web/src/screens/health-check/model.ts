// UI18 Free data health check as data (registry: "Review findings and decisions."; A3 3.2: the free step is never called an audit). What the
// api's AuditView says and nothing more: the screen separates the state, the measured facts the api reports, the decisions waiting, the
// unsupported capabilities and the allowance; it invents no finding, no count and no percentage.
import type { AuditView } from "../../api/generated.ts";
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

/** After a lost answer to CMD021 the durable resource says whether it took effect: the check is CANCELLED, or not yet. */
export function readCancelled(client: ApiClient, auditId: string): () => Promise<DurableRead<AuditView>> {
  return async () => {
    const answer = await client.call("GetAudit", { path: { auditId } });
    if (answer.kind !== "REPLY") return { kind: "NO_ANSWER" };
    return answer.body.data.state === "CANCELLED" ? { kind: "RESOLVED", data: answer.body.data } : { kind: "NOT_YET" };
  };
}

/** CMD021 through the runner: the audit's cancel version is the subject version, so a second click, a reload and a second tab are one intent. */
export function cancelHealthCheck(client: ApiClient, runner: OperationRunner, audit: AuditView): Promise<RunOutcome<AuditView>> {
  return runner.run<AuditView>({
    command: "CMD021",
    subject: { kind: "SUBJECT", subjectId: audit.auditId, subjectVersion: audit.cancelVersion },
    send: (key) => client.call("CancelAudit", { path: { auditId: audit.auditId }, body: { expectedVersion: audit.cancelVersion }, idempotencyKey: key }),
    reread: readCancelled(client, audit.auditId),
  });
}
