/**
 * Stored core documents and plan bindings (package B05 L3; D5-14, D5-16; migration 0057). A document is stored verbatim under the hash the
 * core itself names it by (CORE_NATIVE, D5-3) and judged only by the core's own loader at the reader. Every write is idempotent: the same
 * content again is the same row; other content under the same key is an INTEGRITY_FAILURE, never an overwrite. The application's
 * CoreDocumentStore has the same members, written structurally.
 */
import type { Sha256Hex } from "@kauro/contracts";
import type { AgencyId } from "../model/ids.js";

export type CoreDocumentKindName = "SOURCE_PROFILE" | "TARGET_CONTRACT";

export interface CorePlanBindingRecord {
  readonly configDocument: unknown;
  readonly coreConfigHash: Sha256Hex;
}

export interface CoreDocumentRepository {
  document(agencyId: AgencyId, kind: CoreDocumentKindName, hash: Sha256Hex): Promise<unknown | null>;
  putDocument(agencyId: AgencyId, kind: CoreDocumentKindName, hash: Sha256Hex, document: unknown): Promise<void>;
  planBinding(planHash: Sha256Hex): Promise<CorePlanBindingRecord | null>;
  putPlanBinding(agencyId: AgencyId, planHash: Sha256Hex, binding: CorePlanBindingRecord): Promise<void>;
}
