/**
 * The producers of the evidence that request handlers consume but must never write.
 *
 * - Step-up proofs come from the authentication boundary (08 "Authentication and assurance": "Authentication produces an
 *   identity reference and assurance facts"; "A service account has only its technical role"). The recorder runs on a pool
 *   of the step-up verifier's group (kauro_assurance) and binds the identity whose reauthentication was verified, which is
 *   exactly what its insert policy checks.
 * - Validation receipts come from the independent Migration validator (registry ValidationReceipt: producer "MC validator",
 *   "All bindings and evidence digests are required, internally consistent and independently checked"; 06 "Migration
 *   validation and final states"). The recorder runs on a pool of the validator's group (kauro_validator) and binds the
 *   agency of the plan the receipt validated; the receipt's own composite key refuses a receipt for a plan body or subjects
 *   that do not exist.
 *
 * The request-handler role (kauro_app) holds SELECT only on both tables (migrations 0002 and 0004), so no request path can
 * mint the evidence that CMD025's step-up gate and the VALIDATED / APPROVED plan states depend on. Each recording is a short
 * transaction of its own: it commits the evidence and nothing else. The Identity Platform verifier (B15) and the validation
 * orchestration (CMD024, B01/B08) bind these recorders; in B06 the test harness is their only caller.
 */
import type { UtcInstant } from "@kauro/contracts";
import { DomainFailure, type AgencyId, type AssuranceProof, type CorrelationId, type UserId, type ValidationReceiptRecord } from "@kauro/domain";
import type { PoolClient } from "pg";
import type { KauroPool, RuntimeRole } from "./pool.js";
import { execute } from "./sql.js";

interface EvidenceContext {
  readonly agencyId: AgencyId | null;
  readonly userId: UserId | null;
}

/** One transaction on a verified connection of `role`, with only the given context bound; COMMIT is checked like a unit of work's. */
async function recordAs(pool: KauroPool, role: RuntimeRole, context: EvidenceContext, write: (client: PoolClient) => Promise<void>): Promise<void> {
  const { client, connection } = await pool.acquire();
  if (connection.role !== role) {
    client.release();
    throw new DomainFailure("INTEGRITY_FAILURE", `evidence of this kind is recorded only by ${role}; this pool is ${connection.role} (08 Database isolation)`);
  }
  let destroy: Error | undefined;
  try {
    await execute(client, "BEGIN");
    await execute(client, "SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [context.agencyId ?? "", context.userId ?? ""]);
    await write(client);
    const commit = await execute(client, "COMMIT");
    if (commit.command !== "COMMIT") throw new DomainFailure("INTEGRITY_FAILURE", "the evidence transaction was aborted by an earlier refusal and did not commit");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      destroy = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw e;
  } finally {
    client.release(destroy);
  }
}

/** The step-up verifier's write path (kauro_assurance): one append-only proof of the identity it verified. */
export class PgAssuranceProofRecorder {
  constructor(private readonly pool: KauroPool) {}

  async record(proof: AssuranceProof, correlationId: CorrelationId, recordedAt: UtcInstant): Promise<void> {
    await recordAs(this.pool, "kauro_assurance", { agencyId: null, userId: proof.userId }, async (client) => {
      await execute(
        client,
        `INSERT INTO kauro.assurance_proofs (proof_id, user_id, kind, method, issued_at, expires_at, correlation_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [proof.proofId, proof.userId, proof.kind, proof.method, proof.issuedAt, proof.expiresAt, correlationId, recordedAt],
      );
    });
  }
}

/** The validator's write path (kauro_validator): one append-only receipt, under the tenant context of the plan it validated. */
export class PgValidationReceiptRecorder {
  constructor(private readonly pool: KauroPool) {}

  async record(receipt: ValidationReceiptRecord, recordedAt: UtcInstant): Promise<void> {
    await recordAs(this.pool, "kauro_validator", { agencyId: receipt.agencyId, userId: null }, async (client) => {
      await execute(
        client,
        `INSERT INTO kauro.validation_receipts (receipt_id, agency_id, plan_id, receipt_hash, revision_hash, target_contract_hash, plan_hash, core_package_hash, profile_evidence_hash, disposition_evidence_hash, artifact_evidence_hash, started_at, completed_at, result, counts, blocking_issue_codes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17)`,
        [
          receipt.receiptId,
          receipt.agencyId,
          receipt.planId,
          receipt.receiptHash,
          receipt.revisionHash,
          receipt.targetContractHash,
          receipt.planHash,
          receipt.corePackageHash,
          receipt.profileEvidenceHash,
          receipt.dispositionEvidenceHash,
          receipt.artifactEvidenceHash,
          receipt.startedAt,
          receipt.completedAt,
          receipt.result,
          JSON.stringify(receipt.counts),
          JSON.stringify(receipt.blockingIssueCodes),
          recordedAt,
        ],
      );
    });
  }
}
