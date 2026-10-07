/**
 * The bank-transfer route's tables over `pg` (migration 0046, lane L-ROUTE; docs/design/ACH-ROUTE.md r12 §7.1-§7.3): routes, their
 * versions and participants, and the transfer instructions an issuance freezes. Every statement runs in the caller's unit of work under
 * its policies: the corporate owner configures (OPERATOR context), an agency member locks and reads what it may buy through (TENANT).
 *
 * Locks (migration 0046 lock-order note): `lockForUpdate` is Kroute's route lock (taken before the owner's access decision), `lockShare`
 * the issuance's and the projection's (it conflicts with Kroute, never with another issuance), `lockProject` the issuance's project lock
 * (after its access decision and journal, before the purchased subject's shared halves). Tenant sessions hold no SELECT on the owner
 * identifiers and the verification reference (column grants of 0046), so no statement here names them.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { BankRouteRecord, BankRouteVersionRecord, BankTransferInstructionRecord } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { ConstraintViolation, execute, instant, int, type Queryable } from "../sql.js";

interface RouteRow {
  route_id: string;
  environment: "SANDBOX" | "LIVE";
  account_ref: string;
  provider: string;
  integration_class: "PROVIDER" | "CONTRACT_FAKE";
  currency: "USD";
  payment_route_id: string;
  state: BankRouteRecord["state"];
  rollout: BankRouteRecord["rollout"];
  current_version: number;
  participants_version: string | null;
  version: string;
}
const ROUTE_COLUMNS = "route_id, environment, account_ref, provider, integration_class, currency, payment_route_id, state, rollout, current_version, participants_version, version";

function routeOf(r: RouteRow): BankRouteRecord {
  return {
    routeId: r.route_id,
    environment: r.environment,
    accountRef: r.account_ref,
    provider: r.provider,
    integrationClass: r.integration_class,
    currency: r.currency,
    paymentRouteId: r.payment_route_id,
    state: r.state,
    rollout: r.rollout,
    currentVersion: int(r.current_version),
    participantsVersion: r.participants_version === null ? null : int(r.participants_version),
    version: int(r.version),
  };
}

interface VersionRow {
  route_id: string;
  route_version: number;
  details_artifact_ref: string;
  details_evidence_hash: string;
  payee_digest: string | null;
  accepted_rails: string[];
  minimum_transfer_window_ms: string;
  instruction_lifetime_ms: string;
  provider_time_tolerance_ms: string;
  fee_policy_version: string;
  timing_source_url: string;
  timing_source_accessed_on: string;
  verified_at: Date | null;
  details_valid_until: Date | null;
}
const VERSION_COLUMNS =
  "route_id, route_version, details_artifact_ref, details_evidence_hash, payee_digest, accepted_rails, minimum_transfer_window_ms, instruction_lifetime_ms, provider_time_tolerance_ms, fee_policy_version, timing_source_url, to_char(timing_source_accessed_on, 'YYYY-MM-DD') AS timing_source_accessed_on, verified_at, details_valid_until";

function versionOf(r: VersionRow): BankRouteVersionRecord {
  return {
    routeId: r.route_id,
    routeVersion: int(r.route_version),
    detailsArtifactRef: r.details_artifact_ref,
    detailsEvidenceHash: r.details_evidence_hash as Sha256Hex,
    payeeDigest: r.payee_digest as Sha256Hex | null,
    acceptedRails: r.accepted_rails,
    minimumTransferWindowMs: int(r.minimum_transfer_window_ms),
    instructionLifetimeMs: int(r.instruction_lifetime_ms),
    providerTimeToleranceMs: int(r.provider_time_tolerance_ms),
    feePolicyVersion: r.fee_policy_version,
    timingSourceUrl: r.timing_source_url,
    timingSourceAccessedOn: r.timing_source_accessed_on,
    verifiedAt: r.verified_at === null ? null : instant(r.verified_at),
    detailsValidUntil: r.details_valid_until === null ? null : instant(r.details_valid_until),
  };
}

interface InstructionRow {
  order_id: string;
  agency_id: string;
  route_id: string;
  route_version: number;
  environment: "SANDBOX" | "LIVE";
  account_ref: string;
  reference: string;
  amount_cents: string;
  currency: "USD";
  order_state: string;
  transfer_expires_at: Date;
  send_by: Date;
  issued_at: Date;
  version: string;
}
const INSTRUCTION_COLUMNS = "order_id, agency_id, route_id, route_version, environment, account_ref, reference, amount_cents, currency, order_state, transfer_expires_at, send_by, issued_at, version";

function instructionOf(r: InstructionRow): BankTransferInstructionRecord {
  return {
    orderId: r.order_id,
    agencyId: r.agency_id,
    routeId: r.route_id,
    routeVersion: int(r.route_version),
    environment: r.environment,
    accountRef: r.account_ref,
    reference: r.reference,
    amountCents: BigInt(r.amount_cents),
    currency: r.currency,
    orderState: r.order_state,
    transferExpiresAt: instant(r.transfer_expires_at),
    sendBy: instant(r.send_by),
    issuedAt: instant(r.issued_at),
    version: int(r.version),
  };
}

export interface NewBankRoute {
  readonly routeId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly provider: string;
  readonly integrationClass: "PROVIDER" | "CONTRACT_FAKE";
  readonly paymentRouteId: string;
  readonly createdBy: string;
}

export interface NewBankRouteVersion {
  readonly routeId: string;
  readonly routeVersion: number;
  readonly detailsArtifactRef: string;
  readonly detailsEvidenceHash: string;
  readonly payeeDigest: string | null;
  readonly acceptedRails: ReadonlyArray<string>;
  readonly minimumTransferWindowMs: number;
  readonly instructionLifetimeMs: number;
  readonly providerTimeToleranceMs: number;
  readonly feePolicyVersion: string;
  readonly timingSourceUrl: string;
  readonly timingSourceAccessedOn: string;
  readonly createdBy: string;
}

export interface NewTransferInstructions {
  readonly orderId: string;
  readonly agencyId: string;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly reference: string;
  readonly amountCents: bigint;
  readonly transferExpiresAt: UtcInstant;
  readonly sendBy: UtcInstant;
  readonly issuedAt: UtcInstant;
}

export class PgBankRoutes {
  constructor(private readonly db: Queryable) {}

  /** The route as committed (no lock): what a command observed before it queued for the route lock. */
  async read(routeId: string): Promise<BankRouteRecord | null> {
    const r = await execute<RouteRow>(this.db, `SELECT ${ROUTE_COLUMNS} FROM kauro.bank_routes WHERE route_id = $1`, [routeId]);
    return r.rows[0] ? routeOf(r.rows[0]) : null;
  }

  /** Kroute's route lock, held to COMMIT. */
  async lockForUpdate(routeId: string): Promise<BankRouteRecord | null> {
    const r = await execute<RouteRow>(this.db, `SELECT ${ROUTE_COLUMNS} FROM kauro.bank_routes WHERE route_id = $1 FOR UPDATE`, [routeId]);
    return r.rows[0] ? routeOf(r.rows[0]) : null;
  }

  /** The issuance's and the projection's route lock (FOR SHARE: it conflicts with Kroute's FOR UPDATE and any writer's row lock, never with another issuance), held to COMMIT. */
  async lockShare(routeId: string): Promise<BankRouteRecord | null> {
    const r = await execute<RouteRow>(this.db, `SELECT ${ROUTE_COLUMNS} FROM kauro.bank_routes WHERE route_id = $1 FOR SHARE`, [routeId]);
    return r.rows[0] ? routeOf(r.rows[0]) : null;
  }

  async findByAccount(environment: string, accountRef: string): Promise<BankRouteRecord | null> {
    const r = await execute<RouteRow>(this.db, `SELECT ${ROUTE_COLUMNS} FROM kauro.bank_routes WHERE environment = $1 AND account_ref = $2`, [environment, accountRef]);
    return r.rows[0] ? routeOf(r.rows[0]) : null;
  }

  async version(routeId: string, routeVersion: number): Promise<BankRouteVersionRecord | null> {
    const r = await execute<VersionRow>(this.db, `SELECT ${VERSION_COLUMNS} FROM kauro.bank_route_versions WHERE route_id = $1 AND route_version = $2`, [routeId, routeVersion]);
    return r.rows[0] ? versionOf(r.rows[0]) : null;
  }

  /** The payment_routes row of a bank route, through the one SECURITY DEFINER function (decision #2): CONFIGURED, never qualified here. */
  async registerPaymentRoute(input: { readonly paymentRouteId: string; readonly provider: string; readonly environment: string; readonly merchantRef: string; readonly payeeDigest: string; readonly integrationClass: string }): Promise<void> {
    await execute(this.db, "SELECT kauro.register_bank_payment_route($1, $2, $3, $4, $5, $6)", [input.paymentRouteId, input.provider, input.environment, input.merchantRef, input.payeeDigest, input.integrationClass]);
  }

  async insertRoute(route: NewBankRoute): Promise<BankRouteRecord> {
    try {
      const r = await execute<RouteRow>(
        this.db,
        `INSERT INTO kauro.bank_routes (route_id, agency_id, environment, account_ref, provider, integration_class, currency, payment_route_id, state, current_version, version, created_by)
         VALUES ($1, NULL, $2, $3, $4, $5, 'USD', $6, 'PENDING_VERIFICATION', 1, 1, $7) RETURNING ${ROUTE_COLUMNS}`,
        [route.routeId, route.environment, route.accountRef, route.provider, route.integrationClass, route.paymentRouteId, route.createdBy],
      );
      return routeOf(r.rows[0]!);
    } catch (e) {
      if (e instanceof ConstraintViolation && e.constraint === "bank_routes_environment_account_ref_key") {
        throw new DomainFailure("PRECONDITION_FAILED", "a route of this account and environment exists", { reason: "UNLISTED_TRANSITION" });
      }
      throw e;
    }
  }

  async insertVersion(v: NewBankRouteVersion): Promise<void> {
    await execute(
      this.db,
      `INSERT INTO kauro.bank_route_versions (route_id, route_version, details_artifact_ref, details_evidence_hash, payee_digest, accepted_rails, minimum_transfer_window_ms, instruction_lifetime_ms, provider_time_tolerance_ms, fee_policy_version, timing_source_url, timing_source_accessed_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11, $12::date, $13)`,
      [v.routeId, v.routeVersion, v.detailsArtifactRef, v.detailsEvidenceHash, v.payeeDigest, [...v.acceptedRails], v.minimumTransferWindowMs, v.instructionLifetimeMs, v.providerTimeToleranceMs, v.feePolicyVersion, v.timingSourceUrl, v.timingSourceAccessedOn, v.createdBy],
    );
  }

  /** The route's next aggregate version (and its new state, rollout and details version) under the route lock. */
  async update(routeId: string, expectedVersion: number, to: { readonly state: BankRouteRecord["state"]; readonly rollout: BankRouteRecord["rollout"]; readonly currentVersion: number; readonly participantsVersion?: number }): Promise<BankRouteRecord> {
    const r = await execute<RouteRow>(
      this.db,
      `UPDATE kauro.bank_routes SET state = $3, rollout = $4, current_version = $5, participants_version = coalesce($6, participants_version), version = version + 1 WHERE route_id = $1 AND version = $2 RETURNING ${ROUTE_COLUMNS}`,
      [routeId, expectedVersion, to.state, to.rollout, to.currentVersion, to.participantsVersion ?? null],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "the locked route changed under its lock");
    return routeOf(row);
  }

  async markVerified(routeId: string, routeVersion: number, evidenceRef: string, userId: string, at: UtcInstant, detailsValidUntil: UtcInstant): Promise<void> {
    const r = await execute(
      this.db,
      "UPDATE kauro.bank_route_versions SET verification_evidence_ref = $3, verified_by = $4, verified_at = $5, details_valid_until = $6 WHERE route_id = $1 AND route_version = $2 AND verified_at IS NULL",
      [routeId, routeVersion, evidenceRef, userId, at, detailsValidUntil],
    );
    if (r.rowCount !== 1) throw new DomainFailure("INTEGRITY_FAILURE", "the route version was verified twice");
  }

  /** Appends the allowlist of the aggregate version `setVersion` (append-only; the route names the set in force). */
  async appendParticipants(routeId: string, setVersion: number, agencyIds: ReadonlyArray<string>): Promise<void> {
    for (const agencyId of [...new Set(agencyIds)].sort()) {
      await execute(this.db, "INSERT INTO kauro.bank_route_participants (route_id, set_version, agency_id) VALUES ($1, $2, $3)", [routeId, setVersion, agencyId]);
    }
  }

  /** Whether the agency is on the allowlist in force (the route's participants_version). */
  async isParticipant(route: Pick<BankRouteRecord, "routeId" | "participantsVersion">, agencyId: string): Promise<boolean> {
    if (route.participantsVersion === null) return false;
    const r = await execute(this.db, "SELECT 1 FROM kauro.bank_route_participants WHERE route_id = $1 AND set_version = $2 AND agency_id = $3", [route.routeId, route.participantsVersion, agencyId]);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Runs `work` under a savepoint rolled back once it settled: whatever it locked (a transition lock's shared half, a row) is released at
   * once and nothing it wrote survives; its answer (or its failure) is the caller's. The projection's first access decision runs here, so
   * no membership half is held across the store read that follows it.
   */
  async released<T>(work: () => Promise<T>): Promise<T> {
    await execute(this.db, "SAVEPOINT kauro_bank_access");
    try {
      return await work();
    } finally {
      await execute(this.db, "ROLLBACK TO SAVEPOINT kauro_bank_access");
      await execute(this.db, "RELEASE SAVEPOINT kauro_bank_access");
    }
  }

  /**
   * The issuance's project lock (FOR NO KEY UPDATE): one issuance of a project at a time. Taken after the access decision and the journal
   * and BEFORE the purchased subject's shared halves, the order of every project writer (CreateRevision: project, then agency, then
   * revision), so no writer holding the project waits for a half the issuance holds. False: not visible.
   */
  async lockProject(agencyId: string, projectId: string): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.projects WHERE agency_id = $1 AND project_id = $2 FOR NO KEY UPDATE", [agencyId, projectId]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Inserts the snapshot; false when the reference collides with an existing one of the account (the caller draws another). */
  async insertInstructions(i: NewTransferInstructions): Promise<BankTransferInstructionRecord | null> {
    const r = await execute<InstructionRow>(
      this.db,
      `INSERT INTO kauro.bank_transfer_instructions (order_id, agency_id, version, route_id, route_version, environment, account_ref, reference, amount_cents, currency, order_state, transfer_expires_at, send_by, issued_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, 'USD', 'AWAITING_TRANSFER', $9, $10, $11)
       ON CONFLICT ON CONSTRAINT bank_transfer_instructions_reference_unique DO NOTHING RETURNING ${INSTRUCTION_COLUMNS}`,
      [i.orderId, i.agencyId, i.routeId, i.routeVersion, i.environment, i.accountRef, i.reference, i.amountCents.toString(), i.transferExpiresAt, i.sendBy, i.issuedAt],
    );
    return r.rows[0] ? instructionOf(r.rows[0]) : null;
  }

  async instructionsOf(orderId: string): Promise<BankTransferInstructionRecord | null> {
    const r = await execute<InstructionRow>(this.db, `SELECT ${INSTRUCTION_COLUMNS} FROM kauro.bank_transfer_instructions WHERE order_id = $1`, [orderId]);
    return r.rows[0] ? instructionOf(r.rows[0]) : null;
  }
}
