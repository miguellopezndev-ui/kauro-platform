/**
 * The runtime bounds of package B12's outreach (policy outreach v1, plan §W, D-B12O-20). The database stamps and judges every instant
 * (kauro.effect_now(), migration 0072: uncertain_after = submitted_at + startGate + providerCallBound + margin); the only app-side
 * time is D3's abort timer, a DURATION started after its gate statement returns, never compared with a stored instant.
 */
export const OUTREACH_POLICY_VERSION = "outreach-v1";

export const OUTREACH_RUNTIME = Object.freeze({
  startGateMs: 5_000,
  providerCallBoundMs: 30_000,
  marginMs: 2_000,
  d4GraceMs: 60_000,
  leaseTtlMs: 120_000,
});

/** submitted_at -> uncertain_after, the interval the migration stamps (37 s); startGate + callBound + margin < the lease TTL. */
export const OUTREACH_UNCERTAIN_AFTER_MS = OUTREACH_RUNTIME.startGateMs + OUTREACH_RUNTIME.providerCallBoundMs + OUTREACH_RUNTIME.marginMs;

if (!(OUTREACH_UNCERTAIN_AFTER_MS < OUTREACH_RUNTIME.leaseTtlMs)) throw new Error("outreach bounds: startGate + callBound + margin must be below the lease TTL");

/** The abort signal of one provider call, created synchronously after the start gate (no await between the gate and port.submit). */
export function providerCallSignal(): AbortSignal {
  return AbortSignal.timeout(OUTREACH_RUNTIME.providerCallBoundMs);
}
