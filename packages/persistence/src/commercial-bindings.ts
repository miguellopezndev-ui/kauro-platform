/**
 * The platform bindings of B10's recorded ports (mandate B10-ADAPTERS-LEDGER; design §11; decision D10-BIND-1): until the real
 * implementer of a port lands, the composition binds an honest platform implementation — never a fake. They are written structurally
 * against @kauro/application's ports (this package depends on no application module, as B09's purchased subject and the sales
 * adapters' principal reader), and read through the accessors over the unit of work they are handed.
 *
 *  - RecordedBankingCalendarSource (BankingCalendarSource): the latest VERIFIED_FEED calendar version recorded in `banking_calendars`;
 *    none is no calendar, and CMD051 is refused CALENDAR_UNAVAILABLE. A TEST_FIXTURE version is never answered: no composition binds it.
 *  - AuthorizationDeliveryCompletionSource (PreparationCompletionSource): the FINAL completion of a single-stage purchase is B09's
 *    delivered authorization (commercial_authorization.delivered.v1, performed by B08): its delivery instant, with the digest of the
 *    delivered authorization as its evidence. B13's staged purchases report their stages through their own binding.
 */
import { canonicalBytes, rawDigest, type Sha256Hex, type UtcInstant } from "@kauro/contracts";
import { DomainFailure, type AgencyId, type BankingCalendarRecord, type CaptureId, type CompletionKind, type CompletionSource, type UnitOfWork } from "@kauro/domain";
import { statementsOf } from "./commercial-ledger-access.js";
import { canonical, instantOf } from "./repositories/commercial-ledger-rows.js";
import { execute, type Queryable } from "./sql.js";
import { PgCommerceUnitOfWork } from "./unit-of-work.js";

/** One version of a jurisdiction's banking calendar as the source serves it (the record before it has a row id). */
export type RecordedCalendarVersion = Omit<BankingCalendarRecord, "calendarVersionId">;

export class RecordedBankingCalendarSource {
  readonly binding = "PLATFORM" as const;

  /** The latest recorded VERIFIED_FEED version of the jurisdiction (the version in force: a newer recording supersedes an older), or null. */
  async currentCalendar(uow: UnitOfWork, request: { readonly jurisdiction: "CO"; readonly at: UtcInstant }): Promise<RecordedCalendarVersion | null> {
    const latest = await statementsOf(uow).latestCalendar(request.jurisdiction, "VERIFIED_FEED");
    if (latest === null) return null;
    const { calendarVersionId: _id, ...version } = latest;
    return version;
  }
}

/** One completion of a purchase as PreparationCompletionSource reports it. */
export interface RecordedCompletion {
  readonly kind: CompletionKind;
  readonly stageRef?: string;
  readonly completedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  readonly source: CompletionSource;
}

/** The domain of the evidence digest of a completion established by a delivered authorization. */
export const AUTHORIZATION_DELIVERY_EVIDENCE_DOMAIN = "KAURO_PURCHASE_COMPLETION_AUTHORIZATION_DELIVERY_V1";

export class AuthorizationDeliveryCompletionSource {
  readonly binding = "PLATFORM" as const;

  async completionsOf(uow: UnitOfWork, request: { readonly agencyId: AgencyId; readonly captureId: CaptureId }): Promise<ReadonlyArray<RecordedCompletion>> {
    if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the delivered authorization is read in a commerce unit of work of @kauro/persistence");
    const db = (uow as unknown as { readonly client: Queryable }).client;
    // the purchase's own authorization (never a re-bound one) of this capture, once DELIVERED; the delivery instant is the completion
    const r = await execute<{ authorization_id: string; delivered_at: string }>(
      db,
      `SELECT authorization_id, ${canonical("delivered_at")} FROM kauro.commercial_authorizations
        WHERE agency_id = $1 AND capture_id = $2 AND rebinding_id IS NULL AND state = 'DELIVERED' AND delivered_at IS NOT NULL ORDER BY delivered_at, authorization_id LIMIT 1`,
      [request.agencyId, request.captureId],
    );
    const row = r.rows[0];
    if (row === undefined) return [];
    const completedAt = instantOf(row.delivered_at);
    return [
      {
        kind: "FINAL",
        completedAt,
        evidenceHash: rawDigest(canonicalBytes({ domain: AUTHORIZATION_DELIVERY_EVIDENCE_DOMAIN, version: 1, payload: { authorizationId: row.authorization_id, deliveredAt: completedAt } })),
        source: "AUTHORIZATION_DELIVERY",
      },
    ];
  }
}
