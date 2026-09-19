/**
 * Helpers the tenant-scoped handlers share: the resolved membership (never null once a tenant command is authorized), the
 * stale-version answer of a compare-and-swap miss, and the version check on a locked row (10 "Concurrency and preconditions":
 * a stale edit returns the current safe version and a code directing the UI to reload or compare).
 */
import type { ResolvedMembership, VersionedWrite } from "@kauro/domain";
import { DomainFailure, StaleVersionFailure } from "@kauro/domain";
import type { CommandContext } from "../runtime.js";

export function requireMembership(ctx: CommandContext): ResolvedMembership {
  if (ctx.membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "a tenant command was authorized without a membership");
  return ctx.membership;
}

/** The locked row must be at the version the caller edited; otherwise the current safe version and state come back. */
export function checkExpectedVersion(row: { readonly version: number; readonly state: string }, expected: number, extra: { readonly successorId?: string } = {}): void {
  if (row.version !== expected) throw new StaleVersionFailure(row.version, row.state, extra);
}

/** Unwraps a compare-and-swap write; a miss after the lock means a concurrent writer won on the same version. */
export function applied<T>(write: VersionedWrite<T>, extra: { readonly successorId?: string } = {}): T {
  if (write.kind === "STALE") throw new StaleVersionFailure(write.currentVersion, write.currentState, extra);
  return write.record;
}
