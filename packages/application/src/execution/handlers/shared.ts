/**
 * What the execution handlers share (B08; docs/design/B08-audit-approval-jobs.md §4 item 1, §12): the runtime (B06's command
 * runtime over the execution unit-of-work factory), the pipeline itself — B06's `runCommandIn` in an execution unit of work, so
 * every command keeps D-PIPE-1's order (access decision → journal reserve or replay → execute → journal commit) — and the instant
 * helpers.
 *
 * Instants (D8-CLOCK-1, D-PERS-1): every lifecycle instant is the database's transaction time, read back exactly (microseconds);
 * a deadline is compared with the server clock of the same unit of work (`uow.serverInstant()`), never with the process clock;
 * a view truncates an instant to manual 10's millisecond utc primitive.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { ExecutionUnitOfWork, ExecutionUnitOfWorkFactory } from "@kauro/domain";
import { DomainFailure, toUtcInstant } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { runCommandIn, type AcceptedOutcome, type CommandContext, type CommandOutcome, type CommandRuntime, type VersionOfView } from "../../commands/runtime.js";
import type { CommandSpec } from "../../ports/command-handler.js";

/** B06's command runtime whose unit-of-work factory also opens execution units of work (`run` with the execution store, B08-PERSISTENCE). */
export interface ExecutionRuntime extends CommandRuntime {
  readonly unitOfWork: ExecutionUnitOfWorkFactory;
}

/**
 * Runs one execution command through B06's pipeline in an execution unit of work (same transaction, same context, the execution
 * store on the same connection). `versionOf` reads the COMPLETED envelope's version from the journaled view on replay.
 */
export function runExecutionCommand<Body, View>(
  spec: CommandSpec<Body>,
  runtime: ExecutionRuntime,
  envelope: CommandEnvelope<Body>,
  body: (uow: ExecutionUnitOfWork, ctx: CommandContext) => Promise<CommandOutcome<View> | AcceptedOutcome>,
  versionOf: VersionOfView,
): Promise<CommandResult<View>> {
  return runCommandIn<Body, View, ExecutionUnitOfWork>(spec, runtime, envelope, (context, work) => runtime.unitOfWork.run(context, work), body, versionOf);
}

/** An exact instant of the database as manual 10's millisecond utc primitive (D-PERS-1: a view truncates it). */
export function utc(instant: string): UtcInstant {
  return toUtcInstant(Date.parse(instant));
}

/** An ISO-8601 UTC instant as microseconds since the epoch (the database's exact instants carry six fractional digits, D-PERS-1). */
function micros(instant: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(instant);
  if (m === null) throw new DomainFailure("INTEGRITY_FAILURE", "an instant is not an ISO-8601 UTC instant");
  return Date.parse(`${m[1] as string}Z`) * 1000 + Number((m[2] ?? "").padEnd(6, "0"));
}

/**
 * Whether a deadline has been reached on the server clock of this unit of work (`uow.serverInstant()`, D8-CLOCK-1), compared to the
 * microsecond whatever the fractional digits of either instant.
 */
export function reachedOnServer(deadline: string, serverNow: string): boolean {
  return micros(serverNow) >= micros(deadline);
}

/** The version member of a journaled view at `path` (the aggregate the command edited or created); with no path, of the view itself. */
export function versionAt(...path: ReadonlyArray<string>): VersionOfView {
  return (view: unknown): number => {
    let node: unknown = view;
    for (const key of path) node = typeof node === "object" && node !== null ? (node as Record<string, unknown>)[key] : undefined;
    const version = typeof node === "object" && node !== null ? (node as Record<string, unknown>)["version"] : undefined;
    if (typeof version !== "number") throw new DomainFailure("INTEGRITY_FAILURE", "journaled response carries no aggregate version");
    return version;
  };
}
