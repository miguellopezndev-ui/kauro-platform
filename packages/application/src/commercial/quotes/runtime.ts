/**
 * What CMD027 CreateQuote runs on (package B10, mandate B10-COMMANDS-QUOTE): B09's request runtime — the one pipeline of B06 over the
 * commerce unit of work — and the collaborators a deployment binds. The recurrence history and the issuance core are reached through an
 * accessor over the unit of work (B09's purchasedSubjectsOf pattern; the persistence adapter's `recurrenceOf`), so no shared factory is
 * edited; the buyer type is the platform port B11 will answer (the composition binds UnrecordedBuyerTypeReader); the re-binding of a paid
 * purchase is B09's PurchaseRebinder, called in a SERVICE unit of work of the payment service (D-M3-B6).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AgencyId, ProjectId, QuoteId, RecurrenceRepository, UnitOfWork } from "@kauro/domain";
import type { CommerceRequestCollaborators } from "../../commerce/request/runtime.js";
import type { PurchaseRebinder } from "../../commerce/ports.js";
import type { LateFailureSink } from "../call-bound.js";
import type { BuyerTypeReader, ProviderCallTimer } from "../ports.js";

/** The reads CMD027 relies on beyond B06's and B09's repositories (@kauro/persistence quoteReadsOf). */
export interface QuoteReads {
  /** The billable source units the sealed revision froze; null when the project has no such revision or it counted nothing. */
  billableUnitsOf(request: { readonly agencyId: AgencyId; readonly projectId: ProjectId; readonly revisionHash: Sha256Hex }): Promise<number | null>;
  /** The project's live quote (the one `quotes_one_live_per_project` admits), or null. */
  liveQuoteOf(agencyId: AgencyId, projectId: ProjectId): Promise<QuoteId | null>;
  /**
   * The exclusive half of the project's first-issuance subject, held to COMMIT (D10-GAP-25): taken by CreateQuote only, when the project has
   * no live quote to lock, so two first issuances of one project serialize.
   */
  serializeFirstIssuance(agencyId: AgencyId, projectId: ProjectId): Promise<void>;
  /** The version and state of the project's live quote, else of its latest quote; null when the project has none (STALE_VERSION's current). */
  currentQuoteOf(agencyId: AgencyId, projectId: ProjectId): Promise<{ readonly version: number; readonly state: string } | null>;
  /** The replacement of `quoteId` that is drafted or issued and not yet accepted by a re-binding, or null. */
  pendingReplacementOf(agencyId: AgencyId, quoteId: QuoteId): Promise<QuoteId | null>;
  /** kauro.server_now() of this transaction, exact to the microsecond: the issuance instant of a quote. */
  serverNow(): Promise<UtcInstant>;
  /** The shared half of an approval's transition lock, held to COMMIT. */
  awaitApproval(approvalId: string): Promise<void>;
  /** The price expiry, the lookback start and the source promise of a quote issued at an instant, exact to the microsecond. */
  boundsAt(issuedAt: UtcInstant, quoteSeconds: number, lookbackSeconds: number, sourceDeadline: UtcInstant): Promise<{ readonly expiresAt: UtcInstant; readonly lookbackStartsAt: UtcInstant; readonly sourceAvailableUntil: UtcInstant }>;
}

/**
 * The points of a replacement a test may stop at (never bound by a deployment): the recurrence lock's shared half taken before the
 * snapshot, the replacement's intent before and after its commit, and the re-binding's settlement. A throw ends the request like a
 * process death there; the same key later converges from whatever became durable (D10-QUOTE-4).
 */
export type QuoteHoldPoint = "AFTER_RECURRENCE_LOCK" | "INTENT_BEFORE_COMMIT" | "AFTER_INTENT" | "AFTER_SETTLE";

export interface QuoteCollaborators {
  /**
   * B09's request-side collaborators: the payment service's units of work and identity for the re-binding, and the readers of the quote's
   * view (purchased subject, request queries, B07's source availability, B08's capacity, the provider adapter).
   */
  readonly request: CommerceRequestCollaborators;
  /** The agency's recorded buyer type (B11); the shipped edition answers none, so a quote is refused BUYER_TYPE_UNSET (A3 3.7). */
  readonly buyerType: BuyerTypeReader;
  /** The recurrence history and the issuance core of a unit of work (@kauro/persistence recurrenceOf). */
  readonly recurrence: (uow: UnitOfWork) => RecurrenceRepository;
  readonly reads: (uow: UnitOfWork) => QuoteReads;
  /** B09's re-binding of a paid capture to the replacement quote (D-QUOTE-B6); null: not bound (a replacement answers PROVIDER_SERVICES_UNAVAILABLE). */
  readonly rebinder: PurchaseRebinder | null;
  /** The bound of the re-binding's call (PROVIDER_CALL_TIMEOUT_MS): realProviderCallTimer when absent; a fault cell binds a clock-driven one. */
  readonly providerTimer?: ProviderCallTimer;
  /** Where the failure of a re-binding after its bound elapsed goes (stderr when absent). */
  readonly onLateFailure?: LateFailureSink;
  /** Test-only hold of the replacement protocol. */
  readonly hold?: (point: QuoteHoldPoint) => Promise<void>;
}
