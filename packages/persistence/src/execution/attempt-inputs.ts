/**
 * The records a worker's ticket is built from (B14-A; docs/design/B14-A-worker-executor.md §3), over `pg`, read by the control plane in a
 * SYSTEM unit of work bound to the job's agency (kauro_control under forced row security, D-CTRL-1):
 *
 *   - the core plan binding of the job's plan (`core_plan_bindings`, migration 0058; D5-16: execute translates a plan only through it),
 *     keyed by the job's plan hash and its agency;
 *   - the sealed revision's INCLUDED files as the core reads them: the accepted object, its provider generation, the SHA-256 and length
 *     the seal recorded, and the format the inspection admitted (`source_files.format`).
 *
 * It decides nothing: a missing binding is null, and the ticket's own check (@kauro/data-plane attemptTicketProblems) holds the files to
 * the attempt's capability. No grant is new: kauro_control already reads both tables (0058, 0021).
 */
import type { Sha256Hex } from "@kauro/contracts";
import type { AgencyId, ProjectId } from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
import { str } from "../source/rows.js";

export interface RecordedAttemptFile {
  readonly objectName: string;
  readonly generation: string;
  readonly sha256: Sha256Hex;
  readonly byteLength: number;
  readonly format: "CSV" | "XLSX";
}

export interface RecordedAttemptInputs {
  readonly planBinding: { readonly configDocument: unknown; readonly coreConfigHash: Sha256Hex } | null;
  readonly files: readonly RecordedAttemptFile[];
}

export class PgAttemptInputs {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async read(job: { readonly agencyId: AgencyId; readonly projectId: ProjectId; readonly planHash: Sha256Hex; readonly revisionHash: Sha256Hex }): Promise<RecordedAttemptInputs> {
    const binding = await execute<{ config_document: unknown; core_config_hash: string }>(
      this.#db,
      "SELECT config_document, core_config_hash FROM kauro.core_plan_bindings WHERE agency_id = $1 AND plan_hash = $2",
      [job.agencyId, job.planHash],
    );
    const files = await execute<{ object_name: string; generation: string; sha256: string; bytes: string; format: string }>(
      this.#db,
      `SELECT o.object_name, s.provider_generation AS generation, s.sha256, s.bytes::text AS bytes, f.format
         FROM kauro.dataset_revisions r
         JOIN kauro.sealed_revision_files s ON s.agency_id = r.agency_id AND s.revision_id = r.revision_id AND s.disposition = 'INCLUDED'
         JOIN kauro.source_files f ON f.agency_id = s.agency_id AND f.file_id = s.file_id
         JOIN kauro.stored_objects o ON o.agency_id = f.agency_id AND o.object_id = f.accepted_object_id
        WHERE r.agency_id = $1 AND r.project_id = $2 AND r.manifest_hash = $3
        ORDER BY s.ordinal`,
      [job.agencyId, job.projectId, job.revisionHash],
    );
    const row = binding.rows[0];
    return {
      planBinding: row === undefined ? null : { configDocument: row.config_document, coreConfigHash: str(row.core_config_hash) as Sha256Hex },
      files: files.rows.map((f) => {
        const format = str(f.format);
        if (format !== "CSV" && format !== "XLSX") throw new TypeError(`a sealed file of an unknown format ${format}`);
        return { objectName: str(f.object_name), generation: str(f.generation), sha256: str(f.sha256) as Sha256Hex, byteLength: int(f.bytes), format };
      }),
    };
  }
}
