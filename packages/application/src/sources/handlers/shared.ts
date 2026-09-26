/**
 * What the six source-lifecycle handlers share (B07; docs/design/B07-upload-source-lifecycle.md §11): the runtime (B06's command
 * runtime over the source unit-of-work factory), the collaborators (the provider ports, the preview reader, the commercial-scope
 * inspector, the application origin), the pipeline itself — B06's `runCommandIn` in a `runSource` unit of work, so every command
 * keeps D-PIPE-1's order (access decision → journal reserve or replay → execute → journal commit) — and the instant helpers.
 *
 * Instants (D-CLOCK-1, D-PERS-1): every lifecycle instant is the database's transaction time, read back exactly (microseconds);
 * a deadline is compared with the server clock of the same unit of work (`uow.serverInstant()`), never with the process clock;
 * a view truncates an instant to manual 10's millisecond utc primitive.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { SourceUnitOfWork, SourceUnitOfWorkFactory } from "@kauro/domain";
import { DomainFailure, toUtcInstant } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { runCommandIn, type AcceptedOutcome, type CommandContext, type CommandOutcome, type CommandRuntime, type VersionOfView } from "../../commands/runtime.js";
import type { CommandSpec } from "../../ports/command-handler.js";
import type { CommercialScopeInspector, InspectionLimits, ObjectStoragePort, SessionVaultPort, TablePreviewPort } from "../../ports/source-providers.js";

/** B06's command runtime whose unit-of-work factory also opens source units of work (`runSource`, B07-PERSISTENCE). */
export interface SourceRuntime extends CommandRuntime {
  readonly unitOfWork: SourceUnitOfWorkFactory;
}

/** The provider ports a request of the source lifecycle reaches (09: object storage and the key service that seals sessions). */
export interface SourceProviders {
  readonly storage: ObjectStoragePort;
  readonly vault: SessionVaultPort;
}

/** The preview reader (the platform's own bounded parser, D-SAPI-7) with the limits and the scratch it runs under. */
export interface SourcePreview {
  readonly reader: TablePreviewPort;
  readonly limits: InspectionLimits;
  readonly scratchDir: string;
}

export interface B07Collaborators {
  /**
   * The provider adapters; null in a deployment of this edition, which binds none (D-SAPI-6): every command and read that needs
   * one answers INTEGRITY_FAILURE / SOURCE_SERVICES_UNAVAILABLE and reserves nothing. Tests bind the labelled contract fakes of
   * @kauro/application/testing (SIMULATED); B15 binds the real adapters.
   */
  readonly providers: SourceProviders | null;
  /** The preview reader; null when no storage is bound (a preview then answers SOURCE_SERVICES_UNAVAILABLE). */
  readonly preview: SourcePreview | null;
  /** CMD012's impact map of commercial authority (design §17 item 7): the edition's inspector answers none until B09 binds its reader. */
  readonly commercialScope: CommercialScopeInspector;
  /** The application origin a resumable session is bound to (09 "Resumable session security": bound to one destination and origin). */
  readonly origin: string;
}

/**
 * Runs one source-lifecycle command through B06's pipeline in a `runSource` unit of work (same transaction, same context, the
 * source store on the same connection). `versionOf` reads the COMPLETED envelope's version from the journaled view on replay.
 */
export function runSourceCommand<Body, View>(
  spec: CommandSpec<Body>,
  runtime: SourceRuntime,
  envelope: CommandEnvelope<Body>,
  body: (uow: SourceUnitOfWork, ctx: CommandContext) => Promise<CommandOutcome<View> | AcceptedOutcome>,
  versionOf: VersionOfView,
): Promise<CommandResult<View>> {
  return runCommandIn<Body, View, SourceUnitOfWork>(spec, runtime, envelope, (context, work) => runtime.unitOfWork.runSource(context, work), body, versionOf);
}

/** The provider ports, or SOURCE_SERVICES_UNAVAILABLE before anything is written (D-SAPI-6). */
export function requireProviders(collaborators: B07Collaborators): SourceProviders {
  if (collaborators.providers === null) {
    throw new DomainFailure("INTEGRITY_FAILURE", "no object-storage adapter is bound in this edition", { reason: "SOURCE_SERVICES_UNAVAILABLE" });
  }
  return collaborators.providers;
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
 * Whether a deadline has been reached on the server clock of this unit of work (`uow.serverInstant()`, D-CLOCK-1), compared to the
 * microsecond whatever the fractional digits of either instant.
 */
export function reachedOnServer(deadline: string, serverNow: string): boolean {
  return micros(serverNow) >= micros(deadline);
}

/** The version member of a journaled view at `path` (the aggregate the command edited or created). */
export function versionAt(...path: ReadonlyArray<string>): VersionOfView {
  return (view: unknown): number => {
    let node: unknown = view;
    for (const key of path) node = typeof node === "object" && node !== null ? (node as Record<string, unknown>)[key] : undefined;
    const version = typeof node === "object" && node !== null ? (node as Record<string, unknown>)["version"] : undefined;
    if (typeof version !== "number") throw new DomainFailure("INTEGRITY_FAILURE", "journaled response carries no aggregate version");
    return version;
  };
}
