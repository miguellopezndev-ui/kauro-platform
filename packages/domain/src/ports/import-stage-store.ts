/**
 * The import stage store (package B17; CMD040 SubmitStageReceipt, CMD041 ContinueStage): the port over migrations 0052 and 0072 through
 * which the request handlers read a stage, serialize on it, read its parents under a shared lock, append a validated receipt revision or
 * open a receipt reconciliation, and advance the stage under its version fence. Every instant is the database's (kauro.server_now()); the
 * database refuses an edge the state machine does not list, a second continuation and a reconciliation of an unfinalized stage. The pg
 * implementation is @kauro/persistence's.
 */
import type { ImportStageRecord, ImportStageState, NewStageReceipt, NewStageReceiptReconciliation, StageReceiptReconciliationRecord, StageReceiptRecord, StageReceiptStatus } from "../model/import-stage.js";
import type { MembershipId } from "../model/ids.js";
import type { Sha256Hex } from "@kauro/contracts";
import type { VersionedWrite } from "./repositories.js";

export interface ImportStageStore {
  /** The stage without a lock (null when it does not exist or is another tenant's). */
  get(stageId: string): Promise<ImportStageRecord | null>;
  /**
   * The stage's row locked FOR NO KEY UPDATE: the one serialization point of a receipt or a continuation, held until the unit of work
   * ends (the receipt and reconciliation foreign keys take KEY SHARE, so they never wait on it).
   */
  lock(stageId: string): Promise<ImportStageRecord | null>;
  /** The listed stages of the caller's agency (a stage's parents), unlocked. */
  getMany(stageIds: ReadonlyArray<string>): Promise<ReadonlyArray<ImportStageRecord>>;
  /**
   * The listed parent stages locked FOR SHARE in ascending stage_id (one statement): a parent's own writer (its receipt, its continuation,
   * a reconciliation of it) waits until this unit ends, and this unit waits for a writer that holds it.
   */
  lockParents(stageIds: ReadonlyArray<string>): Promise<ReadonlyArray<ImportStageRecord>>;
  /** The latest receipt revision of each listed stage that has one (one statement). */
  latestReceipts(stageIds: ReadonlyArray<string>): Promise<ReadonlyMap<string, StageReceiptRecord>>;
  /** The listed stages that hold an OPEN receipt reconciliation (one statement). */
  stagesUnderReconciliation(stageIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>>;
  /** The stage's latest receipt revision, or null when none was submitted. */
  latestReceipt(stageId: string): Promise<StageReceiptRecord | null>;
  /** Whether these exact receipt bytes (file hash) were already submitted for the stage. */
  hasReceiptFile(stageId: string, receiptFileHash: Sha256Hex): Promise<boolean>;
  /** In one statement: the receipt revision of these exact bytes and the reconciliation opened for them (R2-025 idempotency by content). */
  receiptStatus(stageId: string, contentHash: Sha256Hex): Promise<StageReceiptStatus>;
  /** Appends the next receipt revision (revision = the stage's latest + 1; never an overwrite); the validation instant is the database's. */
  appendReceipt(input: NewStageReceipt): Promise<StageReceiptRecord>;
  /** Opens a receipt reconciliation of a finalized stage (born OPEN, the instant the database's; one per stage and content hash). */
  openReconciliation(input: NewStageReceiptReconciliation): Promise<StageReceiptReconciliationRecord>;
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
