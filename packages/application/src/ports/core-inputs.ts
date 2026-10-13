/**
 * Inputs the cores are driven from (B05 D5-5, D5-14, D5-16): the sealed revision's input files as the adapter must read them, and
 * the stored documents the intelligence adapter and the plan binding rely on. Application ports only: the persistence
 * implementations belong to the control-documents lane (L3d). A resolver never reads a customer value; it names generations.
 */
import type { Sha256Hex } from "@kauro/contracts";
import type { AgencyId } from "@kauro/domain";

/** What a sealed revision's file is read as (the stored facts of the revision, never a guess of the adapter). */
export interface CoreInputReadConfig {
  readonly format: "CSV" | "XLSX";
  readonly encoding: string | null;
  readonly delimiter: string | null;
  readonly sheets: readonly string[] | null;
}

/** One ACCEPTED generation of the revision, with the digest and length its seal recorded. */
export interface CoreInputRef {
  readonly objectName: string;
  readonly generation: string;
  readonly sha256: Sha256Hex;
  readonly byteLength: number;
  readonly readConfig: CoreInputReadConfig;
}

/** One function for profile, compile and execute: the revision's input files (D5-5). */
export interface CoreInputResolver {
  resolve(revisionHash: Sha256Hex): Promise<readonly CoreInputRef[]>;
}

/** The configuration a plan was bound to when it was compiled (D5-16, row J5b). */
export interface CorePlanBinding {
  /** The closed MigrationConfig document the plan compiled to; its file paths are the revision's object names. */
  readonly configDocument: unknown;
  /** The Migration Core loadConfig hash of the configuration, core-native, stored verbatim. */
  readonly coreConfigHash: Sha256Hex;
}

/** Stored core documents (D5-14): the persistence implementation is L3d's. */
export interface CoreDocumentPort {
  planBinding(planHash: Sha256Hex): Promise<CorePlanBinding | null>;
}

/** The core documents the intelligence adapter relies on, retained with the revision's derived data (09), keyed by their core-native hash. */
export type CoreDocumentKind = "SOURCE_PROFILE" | "TARGET_CONTRACT";

/**
 * The read and write side of the stored core documents (D5-14, D5-16). A document is stored verbatim under the hash the core itself
 * names it by (CORE_NATIVE, D5-3) and checked only by the core's own loader at the reader; a plan binding is content-addressed by the
 * platform's plan hash. Every write is idempotent: the same content again is the same row, other content under the same key is an
 * INTEGRITY_FAILURE (never an overwrite).
 */
export interface CoreDocumentStore extends CoreDocumentPort {
  document(agencyId: AgencyId, kind: CoreDocumentKind, hash: Sha256Hex): Promise<unknown | null>;
  putDocument(agencyId: AgencyId, kind: CoreDocumentKind, hash: Sha256Hex, document: unknown): Promise<void>;
  putPlanBinding(agencyId: AgencyId, planHash: Sha256Hex, binding: CorePlanBinding): Promise<void>;
}
