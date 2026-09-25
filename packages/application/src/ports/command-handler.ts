/**
 * Command handler port. A handler executes exactly one catalogue command inside one unit of work: reserve the journal entry,
 * authorize, check preconditions against locked rows, write state + events + outbox, commit the journal entry, return the
 * view. The transport (apps/api) owns parsing, structural validation and the problem translation; a handler never sees a raw
 * body and never builds an HTTP response.
 */
import type { CommandId } from "@kauro/contracts";
import type { UnitOfWorkFactory } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../api/envelope.js";

export interface CommandSpec<Body> {
  readonly id: CommandId;
  readonly name: string;
  readonly method: "POST";
  readonly path: string;
  /** Registry role (commands.json); the authorizer maps it to membership roles. */
  readonly role: string;
  /** Where the agency selector comes from: the path (agencyId) or the active-agency header (D-SCOPE-1); NONE for CMD001. */
  readonly scope: "NONE" | "AGENCY_PATH" | "AGENCY_HEADER";
  /** The path parameter that names the aggregate the command edits (locked and version-checked), if any. */
  readonly aggregateParam: string | null;
  readonly expectedVersionRequired: boolean;
  /** The command names a step-up proof (assuranceProofRef) that must be fresh (08 "Authentication and assurance"). */
  readonly stepUpRequired: boolean;
  /** Fields whose values are hashes the server recomputes and compares (10: high-impact commands name exact authority hashes). */
  readonly authorityHashFields: ReadonlyArray<keyof Body & string>;
  /** Registry field names, in catalogue order; a test proves the request schema exposes exactly these. */
  readonly fields: ReadonlyArray<keyof Body & string>;
}

export interface CommandHandler<Body, View> {
  readonly spec: CommandSpec<Body>;
  execute(envelope: CommandEnvelope<Body>): Promise<CommandResult<View>>;
}

export interface CommandBus {
  readonly unitOfWork: UnitOfWorkFactory;
  dispatch<Body, View>(handler: CommandHandler<Body, View>, envelope: CommandEnvelope<Body>): Promise<CommandResult<View>>;
}
