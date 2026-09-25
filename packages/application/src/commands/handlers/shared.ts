/**
 * Helpers the tenant-scoped handlers share: the resolved membership (never null once a tenant command is authorized), the
 * stale-version answer of a compare-and-swap miss, and the version check on a locked row (10 "Concurrency and preconditions":
 * a stale edit returns the current safe version and a code directing the UI to reload or compare).
 */
import type { Sha256Hex } from "@kauro/contracts";
import { DOMAINS, structuredDigest } from "@kauro/contracts";
import type { PlanBody, ResolvedMembership, VersionedWrite } from "@kauro/domain";
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

/**
 * Whether the membership controls an approval (D-AUTHZ-3: the approving actor or any OWNER; CMD026 precondition "The actor
 * controls this approval"; Plan edge withdraw_approval "Current organization authority withdraws future use"). Every command
 * that ends a live approval's future use — withdrawing it, or superseding the approved plan — requires this authority, and the
 * permitted actions of a view apply the same rule (api/permitted-actions).
 */
export { controlsApproval } from "../../api/permitted-actions.js";

/** Unwraps a compare-and-swap write; a miss after the lock means a concurrent writer won on the same version. */
export function applied<T>(write: VersionedWrite<T>, extra: { readonly successorId?: string } = {}): T {
  if (write.kind === "STALE") throw new StaleVersionFailure(write.currentVersion, write.currentState, extra);
  return write.record;
}

/**
 * The Plan bodyHash of a body: the KAURO_PLAN_BODY_V1 digest (reference/HASHING_AND_ACCOUNTING_RULES; the preimage excludes
 * planId, version and state). A command that relies on a plan's hash recomputes it from the body it read (re-check finding N10:
 * "the consumer recomputes the relevant preimage"); a collaborator's claim is never taken on trust.
 */
export function planBodyDigest(body: PlanBody): Sha256Hex {
  return structuredDigest(DOMAINS.PLAN_BODY, 1, body);
}
