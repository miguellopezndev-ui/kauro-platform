// The environment of the execution tests (package B08, mandate B08-PERSISTENCE-EXECUTION): the commerce environment of B09's
// adapter tests (one real PostgreSQL 17 cluster per test file, two ACTIVE agencies with reviewed fiscal profiles, an offered
// HUBSPOT capability, the qualified routes), paid purchases through B09's own fixtures (an ACTIVE CommercialAuthorization each),
// and the probes a database test runs as the runtime role that owns a write: the request handlers (kauro_app_test under the owner's
// TENANT context), the control plane (kauro_control_test bound to the agency) and the payment service (kauro_payment_test in the
// agency it adopted). The superuser oracle only reads.
import assert from "node:assert/strict";
import type { Client } from "pg";
import { isDomainFailure, type AgencyId, type UserId } from "@kauro/domain";
import type { AgencyFixture } from "../src/testing/harness.js";
import { closeCommerceEnv, openCommerceEnv, paid, type CommerceEnv } from "./commerce-adapter-support.js";
import { PAYMENT_SERVICE, commerceEvent, service, tenant, within } from "./commerce-support.js";
import { constraintOf, sqlState } from "./support.js";

export type ExecutionEnv = CommerceEnv;

export const openExecutionEnv = openCommerceEnv;
export const closeExecutionEnv = closeCommerceEnv;

/** A paid purchase of a fresh HUBSPOT project of the agency: its ACTIVE authorization and what the job binds. */
export interface Purchase {
  readonly authorizationId: string;
  readonly projectId: string;
  readonly orderId: string;
  readonly captureId: string;
}

export async function purchase(env: ExecutionEnv, ag: AgencyFixture, seed: string): Promise<Purchase> {
  const p = await paid(env, ag, seed);
  return { authorizationId: p.authorizationId, projectId: p.order.quote.projectId, orderId: p.order.orderId, captureId: p.captureId };
}

/** One oracle read (the superuser sees every row of every tenant). */
export async function oracle<R extends Record<string, unknown>>(env: ExecutionEnv, sql: string, params: ReadonlyArray<unknown> = []): Promise<R[]> {
  return (await env.h.oracle.query<R>(sql, params as unknown[])).rows;
}

/** The control plane's raw transaction bound to the agency (B07 D-CTRL-1). */
export function asControl<T>(env: ExecutionEnv, ag: AgencyFixture, fn: (c: Client) => Promise<T>): Promise<T> {
  return within(env.control, service(ag.agencyId), fn);
}

/** The request handlers' raw transaction under the owner's TENANT context. */
export function asTenant<T>(env: ExecutionEnv, ag: AgencyFixture, fn: (c: Client) => Promise<T>): Promise<T> {
  return within(env.app, tenant(ag), fn);
}

/** Runs `probe` under a savepoint of the caller's open transaction and expects the database to refuse it with `code`. */
export async function refused(c: Client, probe: () => Promise<unknown>, code: string, message: string, constraint?: string): Promise<void> {
  await c.query("SAVEPOINT probe");
  try {
    await assert.rejects(probe(), (e: unknown) => causeState(e) === code && (constraint === undefined || causeConstraint(e) === constraint), message);
  } finally {
    await c.query("ROLLBACK TO SAVEPOINT probe");
  }
}

/** Expects a transaction that runs `fn` to be refused with `code`, at a statement or at COMMIT; nothing of it remains. */
export async function refusedTransaction(client: Client, ctx: Parameters<typeof within>[1], fn: (c: Client) => Promise<unknown>, code: string, message: string): Promise<void> {
  await assert.rejects(within(client, ctx, fn), (e: unknown) => causeState(e) === code, message);
}

/** The SQLSTATE a unit of work's failure carries (the typed failure keeps the database error as its cause). */
export function causeState(e: unknown): string {
  if (isDomainFailure(e)) return sqlState(e.cause);
  return sqlState(e);
}

export function causeConstraint(e: unknown): string | undefined {
  return isDomainFailure(e) ? constraintOf(e.cause) : constraintOf(e);
}

/** The subject columns of an authorization as a job binds them, with the receipt and core package of its approval (oracle read). */
export async function jobSubjectOf(env: ExecutionEnv, authorizationId: string): Promise<Record<string, string>> {
  const rows = await oracle<Record<string, string>>(
    env,
    `SELECT a.agency_id, a.project_id, a.authorization_id, a.capture_id, a.plan_id, a.plan_hash, a.approval_id, a.approval_hash, a.revision_hash,
            a.target_contract_hash, a.capability_id, a.capability_version, a.mode, p.validation_receipt_hash, r.core_package_hash
       FROM kauro.commercial_authorizations a
       JOIN kauro.approvals p ON p.agency_id = a.agency_id AND p.approval_id = a.approval_id
       JOIN kauro.validation_receipts r ON r.agency_id = p.agency_id AND r.receipt_hash = p.validation_receipt_hash
      WHERE a.authorization_id = $1`,
    [authorizationId],
  );
  const row = rows[0];
  assert.ok(row, `authorization ${authorizationId}`);
  return row;
}

/** The payment service revokes an authorization the way B09's reconciler does (its phase from the state it leaves; S059). */
export async function revokeAuthorization(c: Client, ag: AgencyFixture, authorizationId: string, code = "CAPTURE_REVERSED"): Promise<number> {
  const r = await c.query<{ version: string }>(
    `UPDATE kauro.commercial_authorizations
        SET version = version + 1, state = 'REVOKED', revoked_at = now(), revocation_code = $2,
            revocation_phase = CASE state WHEN 'ACTIVE' THEN 'PRE_EXECUTION' WHEN 'CONSUMED' THEN 'DURING_EXECUTION' ELSE 'POST_DELIVERY' END
      WHERE authorization_id = $1 AND state <> 'REVOKED' RETURNING version::text AS version`,
    [authorizationId, code],
  );
  const version = Number(r.rows[0]?.version);
  assert.ok(Number.isInteger(version), `authorization ${authorizationId} was revoked`);
  await commerceEvent(c, "commercial_authorization", authorizationId, version, ag.agencyId, "commercial_authorization.revoked.v1", PAYMENT_SERVICE);
  return version;
}

/** The payment service's revocation of an authorization, committed in the agency it adopted. */
export function revokeCommitted(env: ExecutionEnv, ag: AgencyFixture, authorizationId: string, code?: string): Promise<number> {
  return within(env.payment, service(ag.agencyId), (c) => revokeAuthorization(c, ag, authorizationId, code));
}

export function userOf(ag: AgencyFixture): UserId {
  return ag.ownerUserId as UserId;
}

export function agencyOf(ag: AgencyFixture): AgencyId {
  return ag.agencyId as AgencyId;
}
