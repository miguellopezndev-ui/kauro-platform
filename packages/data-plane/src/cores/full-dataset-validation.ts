/**
 * The host's full-dataset validation port for Intelligence Core (B05 D5-15, S045-S047; IC FullDatasetValidationPort): the
 * candidate configuration is translated with the core's own toMigrationConfig over the revision's profile, and the Migration Core
 * document it gives runs in the isolated core child over the revision's sealed generations (MigrationCoreAdapter.fullValidate).
 * The receipt is answered from what Migration Core itself produced: its loader's configHash, the staged manifest's sha256, the
 * digest of its verifier's report and the effects effectsFromMigrationRun read off the run before the scratch was disposed. Its
 * instant is the injected clock the core is handed (validatedAt, IC "one clock discipline"); this module reads no process clock.
 */
import type { CancellationChannel, ExecutionLimits, SourceReader } from "@kauro/application";
import type { HashedSourceProfile } from "@kauro/migration-core";
import { digestOf, toMigrationConfig, type CandidateConfiguration, type FullDatasetValidationPort, type FullDatasetValidationResult } from "@kauro/intelligence-core";
import { MIGRATION_CORE_VERSION, type FullValidationOutcome, type FullValidationRequest } from "./migration-core-adapter.js";

export interface CoreFullDatasetValidationOptions {
  readonly adapter: { fullValidate(request: FullValidationRequest): Promise<FullValidationOutcome> };
  /** The revision's sealed profile: what the configuration was compiled against and what it is translated with. */
  readonly profile: HashedSourceProfile;
  readonly revisionHash: string;
  readonly source: SourceReader;
  /** limits.effectsResidentBytes is required (the adapter refuses without it). */
  readonly limits: ExecutionLimits;
  readonly cancellation: CancellationChannel;
  readonly liveScratchBytes: () => number;
  /** The clock handed to Intelligence Core (IC Clock.now): the receipt is dated by it. */
  readonly clock: { now(): string };
}

export class CoreFullDatasetValidation implements FullDatasetValidationPort {
  readonly #o: CoreFullDatasetValidationOptions;

  constructor(options: CoreFullDatasetValidationOptions) {
    this.#o = options;
  }

  async validate(configuration: CandidateConfiguration): Promise<FullDatasetValidationResult> {
    const o = this.#o;
    const bound = {
      configurationRef: configuration.configurationRef,
      configurationDigest: digestOf(configuration),
      profileHash: configuration.profileHash,
      candidateSetHash: configuration.candidateSetHash,
      targetContractHash: configuration.targetContractHash,
      rowsInProfile: o.profile.profile.totals.dataRowCount,
      coreVersion: MIGRATION_CORE_VERSION,
    };
    const translation = toMigrationConfig(configuration, o.profile);
    if (translation.document === null) {
      // nothing ran: no evidence and no effects, and the verdict says so
      return { ...bound, ok: false, rowsValidated: 0, reconciliationHolds: false, packageVerified: false, problems: [...translation.problems], validatedAt: o.clock.now(), evidence: { packageDigest: null, reportDigest: null, coreConfigHash: null }, effects: null };
    }
    const run = await o.adapter.fullValidate({
      revisionHash: o.revisionHash,
      configDocument: translation.document,
      expectedConfigHash: null,
      source: o.source,
      limits: o.limits,
      cancellation: o.cancellation,
      liveScratchBytes: o.liveScratchBytes,
    });
    const reconciliation = run.reconciliation as unknown as { sourceRows: { total: number; equationHolds: boolean }; associations: { equationHolds: boolean } };
    const reconciliationHolds = reconciliation.sourceRows.equationHolds && reconciliation.associations.equationHolds;
    const ok = run.packageVerified && reconciliationHolds && run.problems.length === 0;
    return {
      ...bound,
      ok,
      rowsValidated: reconciliation.sourceRows.total,
      reconciliationHolds,
      packageVerified: run.packageVerified,
      problems: [...run.problems, ...(reconciliationHolds ? [] : ["RECONCILIATION_DOES_NOT_HOLD"])],
      validatedAt: o.clock.now(),
      coreVersion: run.coreVersion,
      evidence: { packageDigest: run.packageDigest, reportDigest: run.reportDigest, coreConfigHash: run.coreConfigHash },
      effects: run.effects,
    };
  }
}
