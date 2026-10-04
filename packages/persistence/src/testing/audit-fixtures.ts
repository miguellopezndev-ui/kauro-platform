/**
 * Audit fixtures of audit authority (package B08, mandate B08-PERSISTENCE-AUDIT; @kauro/persistence/testing), for the real-database
 * tests of this package and of the entrypoints (apps/api CMD020..CMD024, apps/control's AUDIT_ORCHESTRATION, PLAN_VALIDATION and
 * GRANT_RECONCILIATION). The platform's monthly model pool is funded by an operations act under kauro_control — the owner-approved
 * grant of A4 "Resources"; no catalogue command funds it (open question Q8-1) — which this fixture performs as the control plane's own
 * login: the pool born PREPARED and AUTHORIZED with the owner's funding evidence, its expiry the funding statement's. Every instant is
 * the database's (D8-CLOCK-1). A pool carries no event (it has no agency; decision D8-PAU-1).
 */
import { createHash, randomBytes } from "node:crypto";
import { createIdGenerator, toUtcInstant, type IdGenerator } from "@kauro/domain";
import type { SqlSession } from "./source-lifecycle.js";

const ids: IdGenerator = createIdGenerator({ now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() }, (n) => new Uint8Array(randomBytes(n)));

export interface FundedPoolOptions {
  /** The pool's ceiling in cents (default: the registry's monthly owner funding, money.monthlyOwnerFundingCents = 22,000). */
  readonly ceilingCents?: bigint;
  /** How long the funding statement lasts from now (default thirty days). */
  readonly expiresInSeconds?: number;
}

/**
 * The owner's funding act (Q8-1) on a control-plane connection with no transaction open: a PLATFORM_MONTHLY pool funded now — born
 * PREPARED, then AUTHORIZED under the owner's funding evidence — in one transaction of its own. Returns the pool's grant id.
 */
export async function fundPlatformPool(control: SqlSession, options: FundedPoolOptions = {}): Promise<string> {
  const grantId = ids.next();
  const ceiling = options.ceilingCents ?? 22_000n;
  const seconds = options.expiresInSeconds ?? 30 * 24 * 3_600;
  await control.query("BEGIN");
  try {
    await control.query("SELECT set_config('kauro.agency_id', '', true), set_config('kauro.user_id', '', true)");
    await control.query(
      `INSERT INTO kauro.cost_grants (grant_id, grant_kind, currency, ceiling_cents, price_profile_hash, expires_at)
       VALUES ($1, 'PLATFORM_MONTHLY', 'USD', $2, $3, kauro.server_now() + make_interval(secs => $4))`,
      [grantId, ceiling.toString(), createHash("sha256").update("price-profile-r2").digest("hex"), seconds],
    );
    await control.query("UPDATE kauro.cost_grants SET version = 2, state = 'AUTHORIZED', authorization_ref = $2 WHERE grant_id = $1", [grantId, ids.next()]);
    await control.query("COMMIT");
  } catch (e) {
    await control.query("ROLLBACK");
    throw e;
  }
  return grantId;
}
