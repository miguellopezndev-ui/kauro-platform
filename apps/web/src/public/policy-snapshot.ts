// The numbers the public pages and the legal templates state, vendored from the policy registry (packages/contracts/registry/policy.json,
// the owning numeric registry: manual 16 "The owning numeric registry uses minor units. The table is a human rendering of that policy and
// is checked against it"). The contract package reads its registry files with `fs`, which a Next bundle cannot do, so a page cannot call
// policy(); it carries this snapshot instead, and test/policy-snapshot.test.ts fails on any drift between the two. A number changes in
// the registry first and here second, in the same commit.
//
// Money is in minor units (cents) exactly as in the registry; only formatUsd turns it into words.

export const SERVICE_MODES = ["CLEAN", "HUBSPOT", "SALESFORCE"] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];

export interface PriceBand {
  /** The largest billable source-unit count of the band; the band starts one unit after the previous band's maximum. */
  readonly maximum: number;
  /** Price in minor units by mode. */
  readonly minor: Readonly<Record<ServiceMode, number>>;
}

export interface RepeatTier {
  /** Prior qualifying projects in the lookback window from which the discount applies. */
  readonly minimum: number;
  readonly percent: number;
}

export const POLICY_SNAPSHOT = Object.freeze({
  scheduleVersion: "R2-INITIAL",
  quoteDays: 14,
  repeatLookbackDays: 365,
  /** Discount tiers by prior qualifying projects (0 prior projects: no discount). */
  repeatTiers: [
    { minimum: 0, percent: 0 },
    { minimum: 1, percent: 5 },
    { minimum: 10, percent: 10 },
    { minimum: 25, percent: 15 },
  ] as readonly RepeatTier[],
  bands: [
    { maximum: 50_000, minor: { CLEAN: 69_500, HUBSPOT: 129_500, SALESFORCE: 149_500 } },
    { maximum: 150_000, minor: { CLEAN: 109_500, HUBSPOT: 199_500, SALESFORCE: 229_500 } },
    { maximum: 500_000, minor: { CLEAN: 179_500, HUBSPOT: 299_500, SALESFORCE: 349_500 } },
    { maximum: 1_000_000, minor: { CLEAN: 269_500, HUBSPOT: 449_500, SALESFORCE: 499_500 } },
  ] as readonly PriceBand[],
  /** The largest source-unit count the launch envelope admits; a band above it is listed but not offered. */
  launchSourceUnits: 500_000,
  input: {
    files: 50,
    fileBytes: 2_000_000_000,
    revisionBytes: 5_000_000_000,
    columns: 800,
  },
  retention: {
    uploadReservationSeconds: 86_400,
    unpaidDaysFromReady: 7,
    unpaidDaysHardFromSeal: 14,
    paidDaysFromFirstPackage: 7,
    paidDaysHardFromCapture: 14,
    stagedDaysFromFirstRelease: 21,
    stagedDaysHardFromCapture: 30,
    stagedFinalDays: 7,
    importReceiptDaysFromTerminal: 7,
    targetMetadataDaysFromLastUse: 180,
    targetExecutionFreshnessDays: 30,
    ordinaryLogsDays: 30,
    securityLogsDays: 180,
    signedDownloadSeconds: 900,
  },
  support: {
    /** Days after the contracted package preparation completes in which a defect claim is made (18 "defect claim window"). */
    defectReportDays: 30,
    /** The initial repair or regeneration target of a verified material Kauro defect, in business days of the published coverage calendar. */
    defectRepairTargetBusinessDays: 5,
  },
});

/** The registry's numbers under the same names, for the drift test: `path` is where each value lives in policy.json. */
export const SNAPSHOT_PATHS: ReadonlyArray<readonly [path: string, value: number]> = Object.freeze([
  ["pricing.quoteDays", POLICY_SNAPSHOT.quoteDays],
  ["pricing.repeatLookbackDays", POLICY_SNAPSHOT.repeatLookbackDays],
  ["capacity.launchSourceUnits", POLICY_SNAPSHOT.launchSourceUnits],
  ["input.files", POLICY_SNAPSHOT.input.files],
  ["input.fileBytes", POLICY_SNAPSHOT.input.fileBytes],
  ["input.revisionBytes", POLICY_SNAPSHOT.input.revisionBytes],
  ["input.columns", POLICY_SNAPSHOT.input.columns],
  ["support.defectReportDays", POLICY_SNAPSHOT.support.defectReportDays],
  ["support.defectRepairTargetBusinessDays", POLICY_SNAPSHOT.support.defectRepairTargetBusinessDays],
  ...Object.entries(POLICY_SNAPSHOT.retention).map(([name, value]): readonly [string, number] => [`retention.${name}`, value]),
]);
