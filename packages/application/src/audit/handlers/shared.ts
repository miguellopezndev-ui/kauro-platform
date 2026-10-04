/**
 * What the audit handlers share (B08; docs/design/B08-audit-approval-jobs.md §4, §12): the runtime (B06's command runtime over the
 * audit unit-of-work factory) and the pipeline itself — B06's `runCommandIn` in an audit unit of work, so every command keeps
 * D-PIPE-1's order (access decision → journal reserve or replay → execute → journal commit). The instant helpers are the execution
 * package's (D8-CLOCK-1, D-PERS-1): a deadline is compared with the server clock of the same unit of work, never the process clock.
 */
import type { AuditUnitOfWork, AuditUnitOfWorkFactory } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { runCommandIn, type AcceptedOutcome, type CommandContext, type CommandOutcome, type CommandRuntime, type VersionOfView } from "../../commands/runtime.js";
import type { CommandSpec } from "../../ports/command-handler.js";

export { reachedOnServer, utc, versionAt } from "../../execution/handlers/shared.js";

/** B06's command runtime whose unit-of-work factory also opens audit units of work (`run` with the audit store, B08-PERSISTENCE-AUDIT). */
export interface AuditRuntime extends CommandRuntime {
  readonly unitOfWork: AuditUnitOfWorkFactory;
}

/**
 * Runs one audit command through B06's pipeline in an audit unit of work (same transaction, same context, the audit store on the same
 * connection). `versionOf` reads the COMPLETED envelope's version from the journaled view on replay.
 */
export function runAuditCommand<Body, View>(
  spec: CommandSpec<Body>,
  runtime: AuditRuntime,
  envelope: CommandEnvelope<Body>,
  body: (uow: AuditUnitOfWork, ctx: CommandContext) => Promise<CommandOutcome<View> | AcceptedOutcome>,
  versionOf: VersionOfView,
): Promise<CommandResult<View>> {
  return runCommandIn<Body, View, AuditUnitOfWork>(spec, runtime, envelope, (context, work) => runtime.unitOfWork.run(context, work), body, versionOf);
}
