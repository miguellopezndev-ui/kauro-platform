/**
 * The commission service's sweeps (docs/design/B10-commercial-domain.md §14; mandate B10-COMMISSION-SERVICE).
 */
import { DomainFailure } from "@kauro/domain";
import type { CommissionRuntime } from "./runtime.js";

export const COMMISSION_SWEEPS = ["QUOTE_EXPIRY", "ACCRUAL_RECONCILIATION", "CLAIM_WINDOWS", "ENTITLEMENT_WINDOWS", "ELIGIBILITY"] as const;
export type CommissionSweepName = (typeof COMMISSION_SWEEPS)[number];

export interface SweepReport {
  readonly sweep: string;
  readonly items: ReadonlyArray<{ readonly subject: string; readonly outcome: string }>;
}

export interface CycleSweep {
  readonly sweep: string;
  run(options: { readonly limit: number }): Promise<SweepReport>;
}

export async function runSweep(_rt: CommissionRuntime, _sweep: CommissionSweepName, _options: { readonly limit?: number } = {}): Promise<SweepReport> {
  throw new DomainFailure("INTEGRITY_FAILURE", "the commission sweeps are not built");
}
