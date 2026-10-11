/**
 * The import stage store (package B17; CMD040 SubmitStageReceipt, CMD041 ContinueStage): the port over migration 0052 through which the
 * request handlers read a stage, serialize on it, append a validated receipt revision and advance the stage under its version fence.
 * Every instant is the database's (kauro.server_now()); the database refuses an edge the state machine does not list and a second
 * continuation. The pg implementation is @kauro/persistence's.
 */
import type { ImportStageRecord, ImportStageState, NewStageReceipt, StageReceiptRecord } from "../model/import-stage.js";
import type { MembershipId } from "../model/ids.js";
import type { Sha256Hex } from "@kauro/contracts";
import type { VersionedWrite } from "./repositories.js";

export interface ImportStageStore {
  /** The stage without a lock (null when it does not exist or is another tenant's). */
  get(stageId: string): Promise<ImportStageRecord | null>;
  /** The stage's row locked FOR UPDATE: the one serialization point of a receipt or a continuation, held until the unit of work ends. */
  lock(stageId: string): Promise<ImportStageRecord | null>;
  /** The listed stages of the caller's agency (a stage's parents). */
  getMany(stageIds: ReadonlyArray<string>): Promise<ReadonlyArray<ImportStageRecord>>;
  /** The stage's latest receipt revision, or null when none was submitted. */
  latestReceipt(stageId: string): Promise<StageReceiptRecord | null>;
  /** Whether these exact receipt bytes (file hash) were already submitted for the stage. */
  hasReceiptFile(stageId: string, receiptFileHash: Sha256Hex): Promise<boolean>;
  /** Appends the next receipt revision (revision = the stage's latest + 1; never an overwrite); the validation instant is the database's. */
  appendReceipt(input: NewStageReceipt): Promise<StageReceiptRecord>;
  /** Advances the stage to `to` at `expectedVersion` (version + 1); a version miss is STALE and nothing changes. */
  advance(stageId: string, expectedVersion: number, to: ImportStageState): Promise<VersionedWrite<ImportStageRecord>>;
  /** Records the continuation (once; the instant is the database's) and advances the stage to `to` at `expectedVersion`. */
  recordContinuation(
    stageId: string,
    expectedVersion: number,
    to: ImportStageState,
    continuation: { readonly membershipId: MembershipId; readonly receiptHash: Sha256Hex },
  ): Promise<VersionedWrite<ImportStageRecord>>;
}
