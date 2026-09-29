/**
 * planPostings — the FINANCE consumer's decision (design §8.1; D-LEDGER-B1..B5): the balanced posting set one delivered commerce
 * event records, sourced by that event (its id is the set's idempotency identity, UNIQUE (event_id, line_no), so a replayed delivery
 * posts nothing), the source reference being the event's own aggregate (ledger_entries_source_event, KP001), with the event's
 * instant as effective and observed date. Pure: amounts come only from the event's payload — every amount a set posts is fixed by
 * its event, so the balances a capture ends with do not depend on the order in which the consumer delivers the events.
 *
 *   capture.completed.v1        CAPTURE    capturePostings(allocation) + providerFeePostings(fee reported with it, UNKNOWN, the amount)
 *   capture.fee_observed.v1     FEE        providerFeePostings(fee, the funds state and the movable balance the event names)
 *   capture.funds_observed.v1   FUNDS      fundsPostings(previous, next, the movable balance the event carries)
 *   capture.reversed.v1         CHARGEBACK returnPostings(reversed components, the funds state and the movable balance the event names)
 *   refund.completed.v1         REFUND     returnPostings(returned components — the approved ones, none after the capture's reversal
 *                                          (D-LEDGER-B7) —, the funds state and the movable balance the event names)
 *   reconciliation_case.resolved.v1  CORRECTION  the reviewed resolution's reversing entries (mirrors) and adjusting lines
 *
 * Any other type posts nothing (NOT_APPLICABLE); a funds change that moves no money (a zero movable balance) posts nothing either.
 * A fee or a return takes from the balance its event names at most the capture's movable balance before it (movableBalanceCents)
 * and the rest — the fee the provider keeps — from the merchant's available balance (the domain's providerFeePostings and
 * returnPostings; D-LEDGER-B6, the re-check's residual N4).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AgencyId, EventId, EventPayload, FundsState, LedgerEntryRecord, LedgerSourceKind, PostingLine, PostingSet, RefundComponents } from "@kauro/domain";
import { DomainFailure, capturePostings, fundsPostings, isBalanced, payloadDigest, providerFeePostings, returnPostings } from "@kauro/domain";

/** A delivered commerce event as the consumer read it (B06 OutboxDelivery's event, with the instant it was recorded). */
export interface PostingSource {
  readonly eventId: EventId;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly agencyId: AgencyId;
  readonly payload: EventPayload;
  /** When the event was recorded: the movement's effective date and the instant the platform observed it. */
  readonly recordedAt: UtcInstant;
}

/** The reviewed resolution of a case (D-LEDGER-B4): the event-sourced entries it reverses and the lines that adjust them. */
export interface CaseCorrection {
  readonly reverse: ReadonlyArray<Pick<LedgerEntryRecord, "entryId" | "accountCode" | "direction" | "amountCents" | "currency">>;
  readonly adjust: ReadonlyArray<PostingLine>;
  readonly evidenceHash: Sha256Hex;
}

export type PostingPlan = { readonly kind: "POST"; readonly set: PostingSet } | { readonly kind: "NOT_APPLICABLE"; readonly eventType: string };

const FUNDS: ReadonlySet<string> = new Set(["UNKNOWN", "HELD", "AVAILABLE"]);

function malformed(source: PostingSource, key: string): DomainFailure {
  return new DomainFailure("INTEGRITY_FAILURE", `${source.eventType} ${source.eventId} carries no valid ${key}`, { reason: "EVENT_MISSING" });
}

function money(source: PostingSource, key: string, required = true): bigint {
  const v = source.payload[key];
  if (v === undefined && !required) return 0n;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw malformed(source, key);
  return BigInt(v);
}

function funds(source: PostingSource, key: string): FundsState {
  const v = source.payload[key];
  if (typeof v !== "string" || !FUNDS.has(v)) throw malformed(source, key);
  return v as FundsState;
}

function evidenceOf(source: PostingSource): Sha256Hex {
  const v = source.payload["evidenceHash"];
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : payloadDigest(source.payload);
}

function currencyOf(source: PostingSource): string {
  const v = source.payload["currency"];
  return typeof v === "string" && /^[A-Z]{3}$/.test(v) ? v : "USD";
}

function set(source: PostingSource, sourceKind: LedgerSourceKind, lines: ReadonlyArray<PostingLine>, extra: { readonly evidenceHash?: Sha256Hex; readonly reverses?: Readonly<Record<number, LedgerEntryRecord["entryId"]>>; readonly currency?: string } = {}): PostingPlan {
  if (lines.length === 0) return { kind: "NOT_APPLICABLE", eventType: source.eventType };
  if (!isBalanced(lines)) throw new DomainFailure("INTEGRITY_FAILURE", `the posting set of ${source.eventId} does not balance`, { reason: "LEDGER_UNBALANCED" });
  return {
    kind: "POST",
    set: {
      agencyId: source.agencyId,
      source: { kind: "EVENT", eventId: source.eventId },
      sourceKind,
      sourceRef: source.aggregateId,
      currency: extra.currency ?? currencyOf(source),
      effectiveAt: source.recordedAt,
      observedAt: source.recordedAt,
      evidenceHash: extra.evidenceHash ?? evidenceOf(source),
      lines,
      ...(extra.reverses !== undefined ? { reverses: extra.reverses } : {}),
    },
  };
}

function components(source: PostingSource, service: string, tax: string, excess: string): RefundComponents {
  return { serviceCents: money(source, service), taxCents: money(source, tax), excessCents: money(source, excess) };
}

/** The posting set of one delivered event (D-LEDGER-B5); `correction` is the reviewed resolution a case's resolved event needs. */
export function planPostings(source: PostingSource, correction?: CaseCorrection): PostingPlan {
  switch (source.eventType) {
    case "capture.completed.v1": {
      const allocation = components(source, "allocatedServiceCents", "allocatedTaxCents", "excessCents");
      // a fee the provider reported with the completion is taken from the receivable the completion debited (born UNKNOWN)
      // whose movable balance before the fee is the whole amount
      const fee = money(source, "providerFeeCents", false);
      const amount = allocation.serviceCents + allocation.taxCents + allocation.excessCents;
      return set(source, "CAPTURE", [...capturePostings(allocation), ...providerFeePostings(fee, "UNKNOWN", amount)]);
    }
    case "capture.fee_observed.v1":
      return set(source, "FEE", providerFeePostings(money(source, "providerFeeCents"), funds(source, "fundsState"), money(source, "movableBalanceCents")));
    case "capture.funds_observed.v1": {
      const next = funds(source, "fundsState");
      if (next === "UNKNOWN") throw malformed(source, "fundsState");
      return set(source, "FUNDS", fundsPostings(funds(source, "previousFundsState"), next, money(source, "amountCents")));
    }
    case "capture.reversed.v1":
      return set(source, "CHARGEBACK", returnPostings(components(source, "reversedServiceCents", "reversedTaxCents", "reversedExcessCents"), funds(source, "fundsState"), money(source, "movableBalanceCents")));
    case "refund.completed.v1": {
      // what the completion returns from the capture's unreturned components (D-LEDGER-B7; B09-R2): nothing when the capture's
      // reversal had already returned them, so every return nets against the capture exactly once whatever the observation order.
      // An event recorded before the member existed returned its approved components.
      const returned = source.payload["returnedServiceCents"] !== undefined ? components(source, "returnedServiceCents", "returnedTaxCents", "returnedExcessCents") : components(source, "serviceCents", "taxCents", "excessCents");
      return set(source, "REFUND", returnPostings(returned, funds(source, "fundsState"), money(source, "movableBalanceCents")));
    }
    case "reconciliation_case.resolved.v1": {
      if (correction === undefined) return { kind: "NOT_APPLICABLE", eventType: source.eventType };
      const currencies = new Set(correction.reverse.map((e) => e.currency));
      if (currencies.size > 1) throw new DomainFailure("INTEGRITY_FAILURE", "a correction reverses entries of one currency", { reason: "LEDGER_UNBALANCED" });
      const mirrors: PostingLine[] = correction.reverse.map((e) => ({ account: e.accountCode, direction: e.direction === "DEBIT" ? "CREDIT" : "DEBIT", amountCents: e.amountCents }));
      // PostingSet.reverses is keyed by the position of the reversing line in `lines` (0-based): the mirrors come first
      const reverses: Record<number, LedgerEntryRecord["entryId"]> = {};
      correction.reverse.forEach((e, i) => {
        reverses[i] = e.entryId;
      });
      const currency = [...currencies][0];
      return set(source, "CORRECTION", [...mirrors, ...correction.adjust], { evidenceHash: correction.evidenceHash, reverses, ...(currency !== undefined ? { currency } : {}) });
    }
    default:
      return { kind: "NOT_APPLICABLE", eventType: source.eventType };
  }
}
