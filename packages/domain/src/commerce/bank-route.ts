/**
 * The bank-transfer route of Payments V1 (docs/design/ACH-ROUTE.md r12 §7.1-§7.3, §7.24 I2Δ, §7.29; DV1-01 rail-agnostic names, DV1-07
 * transfer window): the route's states and rollouts, its two aggregates' events, the 23-character transfer reference (D-ACH-04) and the
 * instruction deadline. Pure: no clock is read here; the caller passes the effect instant it read after its locks.
 */
import type { Sha256Hex } from "@kauro/contracts";

export const BANK_ROUTE_STATES = ["PENDING_VERIFICATION", "VERIFIED", "ENABLED", "DISABLED"] as const;
export type BankRouteState = (typeof BANK_ROUTE_STATES)[number];
export const BANK_ROUTE_ROLLOUTS = ["CONTROLLED", "GENERAL"] as const;
export type BankRouteRollout = (typeof BANK_ROUTE_ROLLOUTS)[number];
/** The route kind CMD028 names to issue bank-transfer instructions instead of a provider checkout. */
export const BANK_TRANSFER_ROUTE_KIND = "BANK_TRANSFER";

export const BANK_ROUTE_AGGREGATE_KINDS = ["bank_route", "bank_transfer_instruction"] as const;
export const BANK_ROUTE_EVENT_TYPES = [
  "bank_route.configured.v1",
  "bank_route.verified.v1",
  "bank_route.enabled.v1",
  "bank_route.disabled.v1",
  "bank_route.details_replaced.v1",
  "bank_transfer_instruction.issued.v1",
] as const;
export type BankRouteEventType = (typeof BANK_ROUTE_EVENT_TYPES)[number];

/** References, hashes and tokens only: never an account or routing number, never the reference itself (a payment secret of the buyer). */
export const BANK_ROUTE_EVENT_PAYLOAD_ALLOWLIST: Readonly<Record<BankRouteEventType, ReadonlyArray<string>>> = Object.freeze({
  "bank_route.configured.v1": ["routeId", "routeVersion", "environment", "detailsEvidenceHash", "state"],
  "bank_route.verified.v1": ["routeId", "routeVersion", "detailsEvidenceHash", "previousState"],
  "bank_route.enabled.v1": ["routeId", "routeVersion", "rollout", "participantCount", "previousState"],
  "bank_route.disabled.v1": ["routeId", "routeVersion", "previousState"],
  "bank_route.details_replaced.v1": ["routeId", "routeVersion", "detailsEvidenceHash", "previousState"],
  "bank_transfer_instruction.issued.v1": ["orderId", "agencyId", "routeId", "routeVersion", "state"],
});

/** The owner learns of every route change; the buyer's agency of its instructions (no route or account data in either). */
export const BANK_ROUTE_EVENT_SUBSCRIPTIONS: ReadonlyArray<{ readonly eventType: BankRouteEventType; readonly consumer: "NOTIFICATIONS" }> = Object.freeze(
  BANK_ROUTE_EVENT_TYPES.map((eventType) => Object.freeze({ eventType, consumer: "NOTIFICATIONS" as const })),
);

// --- the transfer reference (D-ACH-04) ---------------------------------------------------------------------------------------------

/** Crockford base32 without I, L, O, U. */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const TRANSFER_REFERENCE_PATTERN = /^K[0-9A-HJKMNP-TV-Z]{22}$/;

function checksumOf(body: string): string {
  // a weighted sum mod 1021 (prime < 32^2) over the 20 symbols: any single substitution or adjacent transposition changes it
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum = (sum + (i + 1) * CROCKFORD.indexOf(body[i]!)) % 1021;
  return CROCKFORD[Math.floor(sum / 32)]! + CROCKFORD[sum % 32]!;
}

/** `K`, 20 symbols drawn from `entropy` (20 bytes or more, 5 bits each), 2 checksum symbols: 23 characters. */
export function transferReferenceOf(entropy: Uint8Array): string {
  if (entropy.length < 20) throw new RangeError("a transfer reference needs 20 bytes of entropy");
  let body = "";
  for (let i = 0; i < 20; i++) body += CROCKFORD[entropy[i]! & 31]!;
  return `K${body}${checksumOf(body)}`;
}

export function isTransferReference(value: string): boolean {
  return TRANSFER_REFERENCE_PATTERN.test(value) && checksumOf(value.slice(1, 21)) === value.slice(21);
}

// --- the instruction deadline (DV1-07) ---------------------------------------------------------------------------------------------

export type TransferWindow = { readonly kind: "ISSUABLE"; readonly transferExpiresAtMs: number; readonly sendByMs: number } | { readonly kind: "TOO_SHORT" };

/**
 * The deadline of new instructions is the earlier of the route's instruction lifetime from the effect instant and the quote's price
 * expiry (never an extension of the price); the buyer must be left at least the minimum window: `deadline - effectNow < window` is
 * TRANSFER_WINDOW_TOO_SHORT, otherwise sendBy = deadline - window (frozen in the snapshot).
 */
export function transferWindowOf(effectNowMs: number, quoteExpiresAtMs: number, route: { readonly instructionLifetimeMs: number; readonly minimumTransferWindowMs: number }): TransferWindow {
  const deadline = Math.min(quoteExpiresAtMs, effectNowMs + route.instructionLifetimeMs);
  if (deadline - effectNowMs < route.minimumTransferWindowMs) return { kind: "TOO_SHORT" };
  return { kind: "ISSUABLE", transferExpiresAtMs: deadline, sendByMs: deadline - route.minimumTransferWindowMs };
}

/** The classified details of an owner-supplied account-details artifact (R1): every field the instructions show, none inferred. */
export interface BankRouteDetails {
  readonly accountRef: string;
  readonly detailsVersion: string;
  readonly currency: "USD";
  readonly acceptedRails: ReadonlyArray<"ACH" | "DOMESTIC_WIRE">;
  readonly beneficiaryName: string;
  readonly bankName: string;
  readonly routingNumber: string;
  readonly accountNumber: string;
  readonly accountType: "CHECKING" | "SAVINGS";
  readonly payeeDigest: Sha256Hex;
  readonly validUntil: string;
}

// --- records ----------------------------------------------------------------------------------------------------------------------

export interface BankRouteRecord {
  readonly routeId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly provider: string;
  readonly integrationClass: "PROVIDER" | "CONTRACT_FAKE";
  readonly currency: "USD";
  readonly paymentRouteId: string;
  readonly state: BankRouteState;
  readonly rollout: BankRouteRollout | null;
  /** The details/configuration version (what expectedVersion names). */
  readonly currentVersion: number;
  /** The aggregate version whose allowlist is in force (null: never enabled). */
  readonly participantsVersion: number | null;
  /** The aggregate version: bumped by every route command, one event each. */
  readonly version: number;
}

export interface BankRouteVersionRecord {
  readonly routeId: string;
  readonly routeVersion: number;
  readonly detailsArtifactRef: string;
  readonly detailsEvidenceHash: Sha256Hex;
  readonly payeeDigest: Sha256Hex;
  readonly acceptedRails: ReadonlyArray<string>;
  readonly minimumTransferWindowMs: number;
  readonly instructionLifetimeMs: number;
  readonly providerTimeToleranceMs: number;
  readonly feePolicyVersion: string;
  readonly timingSourceUrl: string;
  readonly timingSourceAccessedOn: string;
  readonly verifiedAt: string | null;
}

export interface BankTransferInstructionRecord {
  readonly orderId: string;
  readonly agencyId: string;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly reference: string;
  readonly amountCents: bigint;
  readonly currency: "USD";
  readonly orderState: string;
  readonly transferExpiresAt: string;
  readonly sendBy: string;
  readonly issuedAt: string;
  readonly version: number;
}
