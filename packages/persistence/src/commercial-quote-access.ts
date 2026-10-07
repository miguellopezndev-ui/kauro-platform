/**
 * The reads CMD027 relies on beyond B06's and B09's repositories (mandate B10-COMMANDS-QUOTE; design §3.4, §3.5; decision D10-STAGE-1): the
 * sealed revision's frozen billable population, the project's live quote and the replacement of it that is still pending. They are
 * reached through an accessor over the unit of work (B09's purchasedSubjectsOf pattern), so no shared factory is edited.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { DomainFailure, type AgencyId, type ProjectId, type QuoteId, type UnitOfWork } from "@kauro/domain";
import { SERVER_NOW_EXACT, exact } from "./source/rows.js";
import { execute, type Queryable } from "./sql.js";
import { PgCommerceUnitOfWork } from "./unit-of-work.js";

export class PgQuoteReads {
  constructor(private readonly db: Queryable) {}

  /** kauro.server_now() of this transaction, exactly to the microsecond: the issuance instant of a quote (D10-CLOCK-1). */
  async serverNow(): Promise<UtcInstant> {
    const r = await execute<{ now: string }>(this.db, `SELECT ${SERVER_NOW_EXACT} AS now`);
    return r.rows[0]!.now as UtcInstant;
  }

  /** The shared half of an approval's transition lock, held to COMMIT (a withdrawal in flight is ordered before or after this unit of work). */
  async awaitApproval(approvalId: string): Promise<void> {
    await execute(this.db, "SELECT kauro.await_transition('kauro.approvals', $1)", [approvalId]);
  }

  /**
   * The instants of a quote issued at `issuedAt`, computed by the database so they are exact to the microsecond (it compares them for
   * equality): the price expiry `quoteSeconds` later, the start of the repeat lookback `lookbackSeconds` earlier and the source
   * promise, the earlier of the expiry and B07's effective deadline.
   */
  async boundsAt(issuedAt: UtcInstant, quoteSeconds: number, lookbackSeconds: number, sourceDeadline: UtcInstant): Promise<{ readonly expiresAt: UtcInstant; readonly lookbackStartsAt: UtcInstant; readonly sourceAvailableUntil: UtcInstant }> {
    const r = await execute<{ expires_at: string; lookback_starts_at: string; source_available_until: string }>(
      this.db,
      `SELECT ${exact("x.expires_at")}, ${exact("x.lookback_starts_at")}, ${exact("least(x.expires_at, $4::timestamptz)", "source_available_until")}
         FROM (SELECT $1::timestamptz + make_interval(secs => $2::double precision) AS expires_at, $1::timestamptz - make_interval(secs => $3::double precision) AS lookback_starts_at) x`,
      [issuedAt, quoteSeconds, lookbackSeconds, sourceDeadline],
    );
    const row = r.rows[0]!;
    return { expiresAt: row.expires_at as UtcInstant, lookbackStartsAt: row.lookback_starts_at as UtcInstant, sourceAvailableUntil: row.source_available_until as UtcInstant };
  }

  /**
   * The billable source units the sealed revision of `revisionHash` froze (03 "Count the correct population": the evaluation's
   * billableSourceUnits, immutable once sealed), or null when the project has no such revision or it counted nothing yet.
   */
  async billableUnitsOf(request: { readonly agencyId: AgencyId; readonly projectId: ProjectId; readonly revisionHash: Sha256Hex }): Promise<number | null> {
    const r = await execute<{ units: string | null }>(
      this.db,
      "SELECT billable_source_units::text AS units FROM kauro.dataset_revisions WHERE agency_id = $1 AND project_id = $2 AND manifest_hash = $3",
      [request.agencyId, request.projectId, request.revisionHash],
    );
    const units = r.rows[0]?.units;
    return units === null || units === undefined ? null : Number(units);
  }

  /**
   * The project's live quote: the one `quotes_one_live_per_project` admits — an unpaid quote being drafted, issued or accepted for
   * checkout, or the accepted quote a paid purchase stands on (a replacement counts once the re-binding accepted it).
   */
  async liveQuoteOf(agencyId: AgencyId, projectId: ProjectId): Promise<QuoteId | null> {
    const r = await execute<{ quote_id: string }>(
      this.db,
      `SELECT quote_id FROM kauro.quotes
        WHERE agency_id = $1 AND project_id = $2
          AND ((replaces_quote_id IS NULL AND state IN ('DRAFT', 'ISSUED', 'ACCEPTED_FOR_CHECKOUT')) OR state = 'ACCEPTED_FOR_CHECKOUT')`,
      [agencyId, projectId],
    );
    return (r.rows[0]?.quote_id as QuoteId | undefined) ?? null;
  }

  /** D10-GAP-25: the exclusive transaction-level advisory lock of the project's first issuance (only CreateQuote takes it). */
  async serializeFirstIssuance(_agencyId: AgencyId, projectId: ProjectId, wait: boolean): Promise<boolean> {
    if (wait) {
      await execute(this.db, "SELECT pg_advisory_xact_lock(kauro.transition_key('kauro.quotes:first-issuance', $1))", [projectId]);
      return true;
    }
    const r = await execute<{ ok: boolean }>(this.db, "SELECT pg_try_advisory_xact_lock(kauro.transition_key('kauro.quotes:first-issuance', $1)) AS ok", [projectId]);
    return r.rows[0]?.ok === true;
  }

  /** The project's live quote's version and state, else its latest quote's (null: the project has no quote). */
  async currentQuoteOf(agencyId: AgencyId, projectId: ProjectId): Promise<{ readonly version: number; readonly state: string } | null> {
    const r = await execute<{ version: string | number; state: string }>(
      this.db,
      `SELECT version, state FROM kauro.quotes
        WHERE agency_id = $1 AND project_id = $2
        ORDER BY ((replaces_quote_id IS NULL AND state IN ('DRAFT', 'ISSUED', 'ACCEPTED_FOR_CHECKOUT')) OR state = 'ACCEPTED_FOR_CHECKOUT') DESC, created_at DESC
        LIMIT 1`,
      [agencyId, projectId],
    );
    const row = r.rows[0];
    return row === undefined ? null : { version: Number(row.version), state: row.state };
  }

  /** The replacement of `quoteId` that is drafted or issued and not yet accepted by a re-binding (at most one: quotes_one_pending_replacement). */
  async pendingReplacementOf(agencyId: AgencyId, quoteId: QuoteId): Promise<QuoteId | null> {
    const r = await execute<{ quote_id: string }>(
      this.db,
      "SELECT quote_id FROM kauro.quotes WHERE agency_id = $1 AND replaces_quote_id = $2 AND state IN ('DRAFT', 'ISSUED')",
      [agencyId, quoteId],
    );
    return (r.rows[0]?.quote_id as QuoteId | undefined) ?? null;
  }
}

const bound = new WeakMap<PgCommerceUnitOfWork, PgQuoteReads>();

/** CMD027's reads on the unit of work's own connection and transaction. A foreign unit of work is refused, never given a connection. */
export function quoteReadsOf(uow: UnitOfWork): PgQuoteReads {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the quote reads need a commerce unit of work of @kauro/persistence");
  let reads = bound.get(uow);
  if (reads === undefined) {
    reads = new PgQuoteReads((uow as unknown as { readonly client: Queryable }).client);
    bound.set(uow, reads);
  }
  return reads;
}
