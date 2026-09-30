/**
 * Ports of package B10, the agency recurrence and commission domain (docs/design/B10-commercial-domain.md §11 "Ports, fakes and
 * implementers"; decisions D10-BIND-1, D10-FAKE-1, D10-CTX-1). Everything the package needs from a package that is not on main yet
 * (B11's recorded buyer type, B13's stage completions, B15's verified banking calendar and payout evidence) is reached only through
 * these interfaces; the shipped binding of each is either an adapter over B10's own tables or a binding that answers the refusal
 * the design names (bindings.ts), and tests bind the labelled contract fakes of the ./testing subpath (commercial/testing).
 *
 * B10-PORTS-FAKES first spelled their vocabularies here, beside B10-MODEL; since stage 1 every shape a port answers is the domain's own
 * record or vocabulary (commercial/records.ts, COMMERCIAL_VOCABULARY; D10-STAGE-2), so what a port reports is what the database
 * records — a calendar version with the dates it covers, a completion with a registered source and its stage, payout evidence with
 * its observation instant — and no adapter or handler converts a token.
 *
 * No port that reaches a provider is called inside a database transaction (07 "No database transaction remains open across ...
 * calls"): PayoutEvidenceVerifier therefore takes no unit of work. The three ports that read platform state (buyer type,
 * completions, calendar) run in the caller's unit of work, so what they answer is read at the caller's snapshot.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  AgencyId,
  BankingCalendarRecord,
  BuyerType as DomainBuyerType,
  CalendarSource,
  CaptureId,
  CommerceUnitOfWork,
  CompletionKind,
  CompletionSource,
  FoundingOfferView,
  IntegrationClass,
  PayoutEvidenceFacts,
  PayoutEvidenceStatus as DomainPayoutEvidenceStatus,
  SellerState,
  UnitOfWork,
  UserId,
} from "@kauro/domain";
import type { PlatformBinding } from "../commerce/ports.js";

// --- BuyerTypeReader (A3 3.7; design §3.4 CMD027 precondition BUYER_TYPE_UNSET) --------------------------------------------------

/** The agency's recorded buyer type (B11 stores `agency` / `in-house`; the adapter maps). Only an AGENCY buyer earns a commission (A3 3.7). */
export type BuyerType = DomainBuyerType;

/**
 * The agency's recorded buyer type, or null while none is recorded — which CMD027 refuses BUYER_TYPE_UNSET and CMD047 refuses as an
 * unset attribution. Read in the caller's unit of work; never a request member, so a caller cannot state it.
 */
export interface BuyerTypeReader {
  readonly binding: PlatformBinding;
  buyerTypeOf(uow: UnitOfWork, request: { readonly agencyId: AgencyId }): Promise<BuyerType | null>;
}

// --- PreparationCompletionSource (design §7 "Completion and eligibility"; Q10-8) -----------------------------------------------

/** STAGE: one stage of a staged purchase was completed; FINAL: the purchase's preparation is complete (B08 and B13 own the fact). */
export type PreparationCompletionKind = CompletionKind;

/**
 * One completion of a qualifying purchase as purchase_completions records it: its kind — a STAGE names the stage it completes, a
 * FINAL names none — its instant, the evidence that establishes it and the binding that reported it (AUTHORIZATION_DELIVERY for
 * B09's delivered authorization of a single-stage purchase, STAGED_PREPARATION for the stages of a staged one).
 */
export interface PreparationCompletion {
  readonly kind: PreparationCompletionKind;
  readonly stageRef?: string;
  readonly completedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  readonly source: CompletionSource;
}

/** The completions of one purchase, in instant order with a STAGE before a FINAL of the same instant; empty while nothing is complete. */
export interface PreparationCompletionSource {
  readonly binding: PlatformBinding;
  completionsOf(uow: UnitOfWork, request: { readonly agencyId: AgencyId; readonly captureId: CaptureId }): Promise<ReadonlyArray<PreparationCompletion>>;
}

// --- BankingCalendarSource (design §8, D10-CAL-1) --------------------------------------------------------------------------------

/**
 * Where a calendar version came from: a verified feed (B15, owner-reviewed) or the controlled fixture of a test. A fixture is never
 * presented as a feed: the source travels with the version into the commission period, which records it and whether it is SIMULATED.
 */
export type BankingCalendarSourceKind = CalendarSource;

/**
 * One version of a jurisdiction's banking calendar, as banking_calendars records it before it has a row id. Weekends are nonbanking
 * by rule; `nonbankingDates` lists the other nonbanking days only (YYYY-MM-DD, the jurisdiction's calendar dates), all inside
 * [coversFrom, coversTo], the dates the version knows: a day outside them is never counted as a banking day (commercial
 * bankingDayAfterMonthEnd, kauro.banking_day_after). The evidence hash is the digest of the version as recorded.
 */
export type BankingCalendarVersion = Omit<BankingCalendarRecord, "calendarVersionId">;

/** The calendar version in force at `at` for the jurisdiction, or null when none is recorded (CMD051 then refuses CALENDAR_UNAVAILABLE). */
export interface BankingCalendarSource {
  readonly binding: PlatformBinding;
  currentCalendar(uow: UnitOfWork, request: { readonly jurisdiction: "CO"; readonly at: UtcInstant }): Promise<BankingCalendarVersion | null>;
}

// --- PayoutEvidenceVerifier (design §9, D10-PAY-1, D10-PAY-2) -------------------------------------------------------------------

/** What the bank or payout provider says happened to one payout (B15's adapter; a fake in tests). */
export type PayoutEvidenceStatus = DomainPayoutEvidenceStatus;

/**
 * Authenticated payout evidence, as payout_reconciliations records it. The verifier states what the provider reported — the payout's
 * reference, the digest of the destination it paid and the amount in integer minor units — and CMD053 compares each with the stored
 * intent: evidence that names another reference, destination or amount reconciles nothing (D10-PAY-1).
 */
export type PayoutEvidence = PayoutEvidenceFacts;

/** The refusal reason of a verifier that has no evidence to give (CMD053 PRECONDITION_FAILED PAYOUT_EVIDENCE_UNAVAILABLE). */
export type PayoutEvidenceAnswer =
  | { readonly kind: "VERIFIED"; readonly evidence: PayoutEvidence }
  | { readonly kind: "UNAVAILABLE"; readonly reason: "PAYOUT_EVIDENCE_UNAVAILABLE" };

/** Verifies the stored evidence reference `evidenceRef` against the provider. Reaches a provider, so it is never called in a transaction. */
export interface PayoutEvidenceVerifier {
  readonly integrationClass: IntegrationClass;
  verify(request: { readonly evidenceRef: string }): Promise<PayoutEvidenceAnswer>;
}

// --- CommercialPrincipalReader (design §2, D10-CTX-1, D10-CTX-2) ---------------------------------------------------------------

/** A seller's lifecycle state (design §4: CANDIDATE, ACTIVE, SUSPENDED, TERMINATED). Only ACTIVE may act. */
export type SellerPrincipalState = SellerState;

/** The seller row of an identity, as the database finds it in the caller's own unit of work. */
export interface SellerPrincipal {
  readonly sellerId: string;
  readonly userId: UserId;
  readonly state: SellerPrincipalState;
  readonly version: number;
}

/** A corporate KAURO_OWNER grant of an identity. */
export interface OwnerGrantPrincipal {
  readonly userId: UserId;
  readonly state: "ACTIVE" | "REVOKED";
}

/**
 * The seller row and the corporate grant of an identity, read AFTER their transition lock inside the decision's own unit of work
 * (B06 D-TX-2): a suspension or a revocation in flight is ordered before or after the decision, never beside it. Implemented by
 * B10-ADAPTERS-SALES; the authorizer holds no state and never caches an answer.
 */
export interface CommercialPrincipalReader {
  readonly binding: PlatformBinding;
  sellerOf(uow: CommerceUnitOfWork, userId: UserId): Promise<SellerPrincipal | null>;
  ownerGrantOf(uow: CommerceUnitOfWork, userId: UserId): Promise<OwnerGrantPrincipal | null>;
}

// --- FoundingOfferReader (design §3.3; consumed by B11's pricing page) ------------------------------------------------------------

/**
 * The reservable slots of the current founding cohort (FoundingRepository.offer's view at an instant): its policy version, the cohort's
 * slots, how many are reservable and the founding discount. Deliberately carries no agency, quote or seller data: the pricing page is
 * public.
 */
export interface FoundingOffer extends FoundingOfferView {
  readonly asOf: UtcInstant;
}

/** How many founding slots a visitor could still be offered. Reads only; a reservation is CMD027's alone (D10-FOUND-1). */
export interface FoundingOfferReader {
  readonly binding: PlatformBinding;
  currentOffer(uow: UnitOfWork, request: { readonly at: UtcInstant }): Promise<FoundingOffer | null>;
}
