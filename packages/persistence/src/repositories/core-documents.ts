/**
 * Stored core documents and plan bindings over `pg` (package B05 L3; D5-14, D5-16; migration 0057). A write is idempotent: the same
 * content again is the same row; other content under the same key is an INTEGRITY_FAILURE and nothing is overwritten. The agency of a
 * write is the unit of work's current agency (the database refuses any other); a read of a missing key answers null.
 */
import type { Sha256Hex } from "@kauro/contracts";
import { DomainFailure, type AgencyId, type CoreDocumentKindName, type CoreDocumentRepository, type CorePlanBindingRecord } from "@kauro/domain";
import { execute, type Queryable } from "../sql.js";

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Key-sorted, so a jsonb round trip (which reorders keys) compares equal. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([k, x]) => [k, canonical(x)]));
  }
  return v;
}

export class PgCoreDocumentStore implements CoreDocumentRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async document(agencyId: AgencyId, kind: CoreDocumentKindName, hash: Sha256Hex): Promise<unknown | null> {
    const r = await execute<{ document: unknown }>(this.#db, "SELECT document FROM kauro.core_documents WHERE agency_id = $1 AND kind = $2 AND doc_hash = $3", [agencyId, kind, hash]);
    return r.rows[0]?.document ?? null;
  }

  async putDocument(agencyId: AgencyId, kind: CoreDocumentKindName, hash: Sha256Hex, document: unknown): Promise<void> {
    const inserted = await execute(
      this.#db,
      "INSERT INTO kauro.core_documents (agency_id, kind, doc_hash, document) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (agency_id, kind, doc_hash) DO NOTHING",
      [agencyId, kind, hash, JSON.stringify(document)],
    );
    if (inserted.rowCount === 1) return;
    const stored = await this.document(agencyId, kind, hash);
    if (stored === null || !sameJson(stored, document)) throw new DomainFailure("INTEGRITY_FAILURE", `a ${kind} is already stored under this hash with other content`);
  }

  async planBinding(planHash: Sha256Hex): Promise<CorePlanBindingRecord | null> {
    const r = await execute<{ config_document: unknown; core_config_hash: string }>(
      this.#db,
      "SELECT config_document, core_config_hash FROM kauro.core_plan_bindings WHERE plan_hash = $1",
      [planHash],
    );
    const row = r.rows[0];
    return row === undefined ? null : { configDocument: row.config_document, coreConfigHash: row.core_config_hash as Sha256Hex };
  }

  async putPlanBinding(agencyId: AgencyId, planHash: Sha256Hex, binding: CorePlanBindingRecord): Promise<void> {
    const inserted = await execute(
      this.#db,
      "INSERT INTO kauro.core_plan_bindings (plan_hash, agency_id, config_document, core_config_hash) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (plan_hash) DO NOTHING",
      [planHash, agencyId, JSON.stringify(binding.configDocument), binding.coreConfigHash],
    );
    if (inserted.rowCount === 1) return;
    const stored = await this.planBinding(planHash);
    if (stored === null || stored.coreConfigHash !== binding.coreConfigHash || !sameJson(stored.configDocument, binding.configDocument)) {
      throw new DomainFailure("INTEGRITY_FAILURE", "a plan binding is already stored under this plan hash with other content");
    }
  }
}
