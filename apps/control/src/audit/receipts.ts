/**
 * The validator's side of the control plane's audit work (package B08, mandate B08-CONTROL-AUDIT; docs/design/B08-audit-approval-
 * jobs.md §3 step 3, §8.1 Plan valid_receipt and invalid_receipt_result; decisions D8-PLAN-2, D8-AUD-4, D8-ROLE-1, D8-CAU-3, D8-CAU-6,
 * D8-CAU-7; B03 IC-03).
 *
 * `ValidatePort` answers for exactly the request's plan body, source and target; the platform never takes that on trust. `judgeReceipt`
 * checks the answer against the intent the platform validated and the core it binds: a null receipt, a receipt missing a digest or a
 * count, one naming another body, source, target or core, or one whose outcome contradicts its findings is a contract failure — the
 * intent settles ERROR and nothing is recorded. A well-formed receipt of exactly the subject becomes the registry ValidationReceipt:
 * its hash is KAURO_VALIDATION_RECEIPT_V1 over every field, the receipt id included, so two validations of one body are two receipts;
 * it is written by the validator's own write path (`ValidationReceipts`: a second verified pool whose login is a member of
 * kauro_validator, D8-ROLE-1) before the settlement, as evidence of what the validator saw even when the intent or the audit moved
 * meanwhile. Only the settlement of the current intent moves the plan (D8-PLAN-2).
 */
import { join } from "node:path";
import type { CancellationChannel, CoreEvidenceClass, ExecutionLimits, ValidatePort, ValidateResult } from "@kauro/application";
import { DOMAINS, canonicalBytes, isSha256Hex, rawDigest, structuredDigest, type RowCounts, type Sha256Hex, type UtcInstant } from "@kauro/contracts";
import { AttemptScratchStore } from "@kauro/data-plane";
import type { AgencyId, Environment, PlanBody, PlanId, ValidationReceiptId, ValidationReceiptRecord } from "@kauro/domain";
import { PgValidationReceiptRecorder, connectionSecurityOf, createPool, type PoolErrorSink } from "@kauro/persistence";

/** The validator's write path: one append-only receipt, recorded by kauro_validator (persistence's PgValidationReceiptRecorder). */
export interface ValidationReceipts {
  record(receipt: ValidationReceiptRecord, recordedAt: UtcInstant): Promise<void>;
}

/** Platform domain of a validation receipt's hash (HASHING "Hash domain separation"; decision D8-CAU-7). */
export const VALIDATION_RECEIPT_DOMAIN = "KAURO_VALIDATION_RECEIPT_V1";

const ROW_COUNT_KEYS: ReadonlyArray<keyof RowCounts> = Object.freeze([
  "physicalSourceRows",
  "logicalSourceRecords",
  "billableSourceUnits",
  "associationEdges",
  "emittedRepresentatives",
  "mergedNonSurvivors",
  "rejected",
  "withheld",
  "unresolved",
  "emittedArtifactRows",
]);

const DIGESTS = ["revisionHash", "planHash", "corePackageHash", "profileEvidenceHash", "dispositionEvidenceHash", "artifactEvidenceHash"] as const;
const EVIDENCE_CLASSES: ReadonlySet<string> = new Set<CoreEvidenceClass>(["EXECUTED_LOCAL", "SIMULATED"]);
/** kauro.is_token: a finding is a safe token. */
const TOKEN = /^[A-Z][A-Z0-9_]{2,63}$/;
const MAX_FINDINGS = 64;

/** KAURO_PLAN_BODY_V1 of a body (B06 D-PLAN-5): every consumer recomputes it, a collaborator's claim is never taken on trust. */
export function planBodyHashOf(body: PlanBody): Sha256Hex {
  return structuredDigest(DOMAINS.PLAN_BODY, 1, body);
}

/** KAURO_VALIDATION_RECEIPT_V1 over every field of the receipt but its hash (decision D8-CAU-7). */
export function validationReceiptHashOf(receipt: Omit<ValidationReceiptRecord, "receiptHash">): Sha256Hex {
  const payload = {
    receiptId: receipt.receiptId,
    agencyId: receipt.agencyId,
    planId: receipt.planId,
    revisionHash: receipt.revisionHash,
    targetContractHash: receipt.targetContractHash,
    planHash: receipt.planHash,
    corePackageHash: receipt.corePackageHash,
    profileEvidenceHash: receipt.profileEvidenceHash,
    dispositionEvidenceHash: receipt.dispositionEvidenceHash,
    artifactEvidenceHash: receipt.artifactEvidenceHash,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    result: receipt.result,
    counts: receipt.counts,
    blockingIssueCodes: receipt.blockingIssueCodes,
  };
  return rawDigest(canonicalBytes({ domain: VALIDATION_RECEIPT_DOMAIN, version: 1, payload }));
}

/** The subject the platform validated: the intent's plan, body hash, source and target, in its agency. */
export interface ValidatedSubject {
  readonly agencyId: AgencyId;
  readonly planId: PlanId;
  readonly planHash: Sha256Hex;
  readonly revisionHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
}

/** What the validator's answer amounts to: a receipt of exactly the subject (VALID or INVALID), or a contract failure (ERROR). */
export type ReceiptJudgement =
  | { readonly kind: "RECEIPT"; readonly receipt: ValidationReceiptRecord; readonly evidenceClass: CoreEvidenceClass }
  | { readonly kind: "CONTRACT_FAILURE"; readonly reason: string; readonly evidenceClass: CoreEvidenceClass };

function countsOf(value: unknown): RowCounts | null {
  if (value === null || typeof value !== "object") return null;
  const source = value as Readonly<Record<string, unknown>>;
  const out: Record<string, number> = {};
  for (const key of ROW_COUNT_KEYS) {
    const n = source[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
    out[key] = n;
  }
  return out as unknown as RowCounts;
}

/** A problem string reduced to a safe token (the receipt's blocking issue codes name no customer value). */
function findingOf(problem: string): string {
  const token = (problem.split(":")[0] ?? problem).toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^[^A-Z]+/, "");
  return token.length >= 3 ? token.slice(0, 64) : "VALIDATION_ISSUE";
}

/**
 * The validator's answer judged against the subject and the core the platform binds (header). `receiptId`, `startedAt` and
 * `completedAt` are the platform's: the receipt's id and the server's instants around the call.
 */
export function judgeReceipt(
  result: ValidateResult | null | undefined,
  subject: ValidatedSubject,
  expectedCorePackageHash: Sha256Hex,
  receiptId: ValidationReceiptId,
  startedAt: UtcInstant,
  completedAt: UtcInstant,
): ReceiptJudgement {
  const evidenceClass: CoreEvidenceClass = result !== null && result !== undefined && EVIDENCE_CLASSES.has(result.evidenceClass) ? result.evidenceClass : "SIMULATED";
  const failure = (reason: string): ReceiptJudgement => ({ kind: "CONTRACT_FAILURE", reason, evidenceClass });
  if (result === null || result === undefined || typeof result !== "object" || !EVIDENCE_CLASSES.has(result.evidenceClass)) return failure("VALIDATOR_ANSWER_MALFORMED");
  if (result.outcome === "ERROR") return failure("VALIDATOR_ERROR");
  if (result.outcome !== "VALID" && result.outcome !== "INVALID") return failure("VALIDATOR_ANSWER_MALFORMED");
  const receipt = result.receipt as Readonly<Record<string, unknown>> | null;
  if (receipt === null || typeof receipt !== "object") return failure("RECEIPT_MISSING");
  // complete: every digest a SHA-256, the target named, every count a non-negative whole number (IC-03 "null, missing hashes")
  for (const key of DIGESTS) if (!isSha256Hex(receipt[key])) return failure("RECEIPT_INCOMPLETE");
  if (!isSha256Hex(receipt["targetContractHash"])) return failure("RECEIPT_INCOMPLETE");
  const counts = countsOf(receipt["counts"]);
  if (counts === null) return failure("RECEIPT_INCOMPLETE");
  // exactly the subject: the body, the source and the target the platform validated (IC-03 "a receipt for different inputs")
  if (receipt["planHash"] !== subject.planHash || receipt["revisionHash"] !== subject.revisionHash || receipt["targetContractHash"] !== subject.targetContractHash) {
    return failure("RECEIPT_FOREIGN_SUBJECT");
  }
  // the core the platform installed, not another (D8-CAU-3)
  if (receipt["corePackageHash"] !== expectedCorePackageHash) return failure("RECEIPT_FOREIGN_CORE");
  if (!Array.isArray(result.problems) || !result.problems.every((p) => typeof p === "string")) return failure("VALIDATOR_ANSWER_MALFORMED");
  const findings = [...new Set(result.problems.map(findingOf))].filter((f) => TOKEN.test(f)).slice(0, MAX_FINDINGS);
  // a VALID receipt carries no blocking issue; an INVALID one names at least one (validation_receipts_valid_has_no_blockers)
  if (result.outcome === "VALID" ? findings.length !== 0 : findings.length === 0) return failure("RECEIPT_CONTRADICTORY");
  const unhashed: Omit<ValidationReceiptRecord, "receiptHash"> = {
    receiptId,
    agencyId: subject.agencyId,
    planId: subject.planId,
    revisionHash: subject.revisionHash,
    targetContractHash: subject.targetContractHash,
    planHash: subject.planHash,
    corePackageHash: expectedCorePackageHash,
    profileEvidenceHash: receipt["profileEvidenceHash"] as Sha256Hex,
    dispositionEvidenceHash: receipt["dispositionEvidenceHash"] as Sha256Hex,
    artifactEvidenceHash: receipt["artifactEvidenceHash"] as Sha256Hex,
    startedAt,
    completedAt,
    result: result.outcome,
    counts,
    blockingIssueCodes: findings,
  };
  return { kind: "RECEIPT", receipt: { ...unhashed, receiptHash: validationReceiptHashOf(unhashed) }, evidenceClass };
}

/** What a validation of one intent needs (PLAN_VALIDATION's and the audit's VALIDATE step alike). */
export interface ValidationRun {
  readonly subject: ValidatedSubject;
  readonly body: PlanBody;
  readonly receiptId: ValidationReceiptId;
  readonly startedAt: UtcInstant;
  readonly cancellation: CancellationChannel;
  /** The server's instant once the validator answered (a unit of its own, D8-CLOCK-1). */
  readonly completedAt: () => Promise<UtcInstant>;
}

/** The validator's call and the receipt's recording, shared by PLAN_VALIDATION and AUDIT_ORCHESTRATION's VALIDATE (header). */
export class PlanValidator {
  constructor(
    private readonly deps: {
      readonly validate: ValidatePort;
      readonly receipts: ValidationReceipts;
      readonly corePackageHash: Sha256Hex;
      readonly limits: ExecutionLimits;
      /** An absolute directory: each validation owns, and removes, a scratch directory of its own under it. */
      readonly scratchRoot: string;
    },
  ) {}

  /**
   * Validates the stored body of the intent outside any transaction: its digest recomputed first (a body that is not its hash is never
   * validated), the core called in a scratch store of its own, the answer judged, a well-formed receipt recorded by the validator.
   */
  async run(run: ValidationRun): Promise<ReceiptJudgement> {
    if (planBodyHashOf(run.body) !== run.subject.planHash) return { kind: "CONTRACT_FAILURE", reason: "BODY_DIGEST_MISMATCH", evidenceClass: "EXECUTED_LOCAL" };
    const scratch = new AttemptScratchStore({ root: join(this.deps.scratchRoot, "validation"), attemptId: run.receiptId, quotaBytes: this.deps.limits.scratchBudgetBytes });
    let answer: ValidateResult;
    try {
      answer = await this.deps.validate.validate({
        revisionHash: run.subject.revisionHash,
        planBody: run.body,
        planHash: run.subject.planHash,
        targetContractHash: run.subject.targetContractHash,
        scratch,
        cancellation: run.cancellation,
      });
    } finally {
      scratch.dispose();
    }
    const completedAt = await run.completedAt();
    const judged = judgeReceipt(answer, run.subject, this.deps.corePackageHash, run.receiptId, run.startedAt, completedAt);
    if (judged.kind === "RECEIPT") await this.deps.receipts.record(judged.receipt, completedAt);
    return judged;
  }
}

/** The connection of the validator's write path: a verified pool of a kauro_validator login (never the control plane's own login). */
export interface ValidatorDatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password?: string;
  /** Outside LOCAL the connection is certificate-verified and its password is a file (I-2, I-3): see connectionSecurityOf. */
  readonly environment: Environment;
  readonly passwordFile?: string;
  readonly tlsCaFile?: string;
  readonly poolMax: number;
  readonly onPoolError?: PoolErrorSink;
}

/**
 * Opens the validator's write path of the control plane (D8-ROLE-1: receipts stay kauro_validator's through a second verified
 * control-plane pool): the pool refuses to start unless its login is a member of kauro_validator (08 "Database isolation").
 */
export async function openValidatorReceipts(config: ValidatorDatabaseConfig, applicationName: string): Promise<{ readonly receipts: ValidationReceipts; close(): Promise<void> }> {
  const pool = createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    ...connectionSecurityOf(config.environment, { host: config.host, ...(config.password === undefined ? {} : { password: config.password }), ...(config.passwordFile === undefined ? {} : { passwordFile: config.passwordFile }), ...(config.tlsCaFile === undefined ? {} : { tlsCaFile: config.tlsCaFile }) }),
    max: config.poolMax,
    applicationName,
    ...(config.onPoolError === undefined ? {} : { onError: config.onPoolError }),
  });
  try {
    const { client, connection } = await pool.acquire();
    client.release();
    if (connection.role !== "kauro_validator") throw new Error(`the validator's write path must run as a member of kauro_validator; ${connection.loginRole} is a member of ${connection.role} (08 Database isolation)`);
  } catch (e) {
    await pool.end();
    throw e;
  }
  return { receipts: new PgValidationReceiptRecorder(pool), close: () => pool.end() };
}
