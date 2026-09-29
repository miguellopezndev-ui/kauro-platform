/**
 * What the isolated inspection task returns to the parent (JSON across the process boundary). The parent adds what it measured
 * itself — the streamed SHA-256 and byte count, the container part at its verified length, the observers — and builds the
 * ContainerInspection of the port. Types only.
 */
import type { DetectedTable, InspectionLimits } from "@kauro/application";
import type { ScanPartKind } from "@kauro/domain";
import type { RefusalClass } from "../errors.js";

export interface InspectPayload {
  /** The attempt input: the exact generation, streamed into the scratch by the parent. */
  readonly input: string;
  readonly declaredFormat: "CSV" | "XLSX";
  readonly limits: InspectionLimits;
  readonly archive: {
    readonly ratioGraceBytes: number;
    readonly centralDirectoryBytes: number;
    readonly inventoryColumns: number;
  };
}

export interface RawProblem {
  readonly code: string;
  /** SHA-256 of the part identity (a normalized archive path), never the path. */
  readonly partDigest?: string;
}

export interface RawInspection {
  readonly detectedFormat: "CSV" | "XLSX" | "UNSUPPORTED";
  readonly structureStatus: "STRUCTURE_VALID" | "STRUCTURE_INVALID";
  readonly refusal?: RefusalClass;
  readonly problems: ReadonlyArray<RawProblem>;
  /** The allowed parts of an archive the scan must cover besides the container, with their verified expanded lengths. */
  readonly parts: ReadonlyArray<{ readonly partDigest: string; readonly partKind: ScanPartKind; readonly bytes: number }>;
  readonly tables: ReadonlyArray<DetectedTable>;
  readonly profile: Readonly<Record<string, string | number | boolean>>;
  readonly checksCompleted: ReadonlyArray<string>;
  readonly decompressedBytes: number;
}
