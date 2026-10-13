/**
 * The wire protocol between the core child and its parent (B05 D5-2): constants and types only, so the parent can import it
 * without running the child entry. Loaded in both processes: node built-ins only.
 */
import type { FsMeter } from "./fs-meter.js";

export const FS_METER_KEY: unique symbol = Symbol.for("kauro.data-plane.core-fs-meter");

export const PROGRESS_MARK = "\u001eKAURO-CORE-PROGRESS ";

export interface CoreChildJob {
  readonly task: string;
  readonly payload: unknown;
  readonly workDir: string;
  /** The child's byte quota: the attempt budget minus the parent's live bytes at spawn. */
  readonly quotaBytes: number;
  /** Progress points the parent will hold the child at (empty in production). */
  readonly pausePoints: readonly string[];
}

export interface CoreChildContext {
  readonly workDir: string;
  readonly meter: FsMeter;
  /** Reports a progress point; resolves when the parent releases it (immediately unless the point is a pause point). */
  progress(point: string): Promise<void>;
}

