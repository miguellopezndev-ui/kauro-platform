/**
 * The fit inquiry of a visitor without an account (02 "Intake and project boundaries"; A3 3.7 "the fit form collects business
 * contact details, buyer type, destination, approximate record band and desired timing"; B11 D-PUB-2..D-PUB-6). An inquiry has no
 * tenant: nobody has signed in, and it names no agency, client or project. It carries no price, quote or third-party CRM name, and
 * the buyer type never changes price or admission (A3 3.7).
 *
 * The vocabularies are closed. A destination says how the buyer will receive the cleaned data, not which product they use; the
 * bands are the vendored pricing bands followed by "over the last band" and "not sure".
 */
import type { Sha256Hex } from "@kauro/contracts";

export const INQUIRY_BUYER_TYPES = ["agency", "in-house"] as const;
export type InquiryBuyerType = (typeof INQUIRY_BUYER_TYPES)[number];

export const INQUIRY_DESTINATIONS = ["listed-crm", "other-crm", "files-only", "not-chosen"] as const;
export type InquiryDestination = (typeof INQUIRY_DESTINATIONS)[number];

export const INQUIRY_RECORD_BANDS = ["up-to-50000", "up-to-150000", "up-to-500000", "up-to-1000000", "over-1000000", "not-sure"] as const;
export type InquiryRecordBand = (typeof INQUIRY_RECORD_BANDS)[number];

export const INQUIRY_TIMINGS = ["within-2-weeks", "within-a-month", "within-a-quarter", "flexible"] as const;
export type InquiryTiming = (typeof INQUIRY_TIMINGS)[number];

/** The event an accepted inquiry emits: it carries the inquiry id and nothing else (no name, e-mail, company or text). */
export const INQUIRY_RECEIVED_EVENT = "inquiry.received.v1" as const;

/** The three admission keys, in the order the kinds are stored. */
export const INQUIRY_ADMISSION_KINDS = ["ADDRESS", "CONTENT", "EMAIL"] as const;
export type InquiryAdmissionKind = (typeof INQUIRY_ADMISSION_KINDS)[number];

const HOUR_MS = 3_600_000;

/** The windows and budgets of the public inquiry (D-PUB-3, D-PUB-5). Every window is trailing and measured from admission instants. */
export const INQUIRY_LIMITS = Object.freeze({
  /** Accepted inquiries one client-address hash may have in the trailing hour. */
  addressPerHour: 5,
  addressWindowMs: HOUR_MS,
  /** Accepted inquiries one e-mail hash may have in the trailing day. */
  emailPerDay: 3,
  emailWindowMs: 24 * HOUR_MS,
  /** The same content inside this window from its first acceptance is the same inquiry. */
  replayWindowMs: 24 * HOUR_MS,
  descriptionMaxCharacters: 2000,
});

/** The normalized content of an inquiry: the fields as submitted, the description absent as null. */
export interface InquiryContent {
  readonly buyerType: InquiryBuyerType;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly companyName: string;
  readonly destination: InquiryDestination;
  readonly recordBand: InquiryRecordBand;
  readonly timing: InquiryTiming;
  readonly description: string | null;
}

/**
 * The keyed digests an inquiry is admitted under (never the values): the client network, the whole content (with the e-mail
 * address compared without regard to case) and the e-mail address. The application derives them; the store never sees a value
 * they were derived from.
 */
export interface InquiryAdmissionKeys {
  readonly address: Sha256Hex;
  readonly content: Sha256Hex;
  readonly email: Sha256Hex;
}
