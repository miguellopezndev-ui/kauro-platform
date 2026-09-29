// The fit inquiry of a visitor without an account (UI07; A3 3.7: "the fit form collects business contact details, buyer type, destination,
// approximate record band and desired timing"), as the browser builds it and reads the api's answer (W5b: POST /api/v1/public/inquiries).
// Pure and free of the DOM: the form component (inquiry-form.tsx) only calls these, so node:test exercises everything that can be wrong.
//
// The vocabularies are the api's closed vocabularies. The record bands are the ladder's bands (from the vendored policy snapshot) followed
// by "more than the last band" and "not sure". The browser refuses first what the api's closed schema would refuse (the same limits and
// the same patterns), so a visitor is told which field to fix before anything is sent; the api still decides.
import type { PublicCopyId } from "../copy/public.ts";
import { PUBLIC_COPY } from "../copy/public.ts";
import { BANDS, bandLabel } from "./pricing-bands.ts";

export const INQUIRY_PATH = "/api/v1/public/inquiries";

export const BUYER_TYPES = ["agency", "in-house"] as const;
export const DESTINATIONS = ["listed-crm", "other-crm", "files-only", "not-chosen"] as const;
export const TIMINGS = ["within-2-weeks", "within-a-month", "within-a-quarter", "flexible"] as const;

export interface RecordBand {
  readonly value: string;
  readonly label: string;
}

const LAST_MAXIMUM = BANDS[BANDS.length - 1]?.maximum ?? 0;

export const RECORD_BANDS: readonly RecordBand[] = Object.freeze([
  ...BANDS.map((band, index): RecordBand => ({ value: `up-to-${band.maximum}`, label: bandLabel(index) })),
  { value: `over-${LAST_MAXIMUM}`, label: PUBLIC_COPY["contact.band.over"] },
  { value: "not-sure", label: PUBLIC_COPY["contact.band.not-sure"] },
]);

/** The longest description, in characters (the api's schema counts characters, not UTF-16 units). */
export const DESCRIPTION_MAX = 2000;
const LABEL_MAX = 200;

export interface InquiryValues {
  buyerType: string;
  contactName: string;
  contactEmail: string;
  companyName: string;
  destination: string;
  recordBand: string;
  timing: string;
  description: string;
}

export type FieldName = keyof InquiryValues;

export const EMPTY_VALUES: InquiryValues = Object.freeze({
  buyerType: "",
  contactName: "",
  contactEmail: "",
  companyName: "",
  destination: "",
  recordBand: "",
  timing: "",
  description: "",
});

/** The order the form shows its fields in, and the error summary lists them in. */
export const FIELD_ORDER: readonly FieldName[] = ["buyerType", "contactName", "contactEmail", "companyName", "destination", "recordBand", "timing", "description"];

/** The object the api's closed schema admits: the description is absent, never empty. */
export interface InquiryBody {
  readonly buyerType: (typeof BUYER_TYPES)[number];
  readonly contactName: string;
  readonly contactEmail: string;
  readonly companyName: string;
  readonly destination: (typeof DESTINATIONS)[number];
  readonly recordBand: string;
  readonly timing: (typeof TIMINGS)[number];
  readonly description?: string;
}

export type Validation =
  | { readonly ok: true; readonly body: InquiryBody }
  | { readonly ok: false; readonly errors: Readonly<Partial<Record<FieldName, PublicCopyId>>> };

// the patterns of the api's schema (packages/application/src/api/response-schemas.ts, W5b)
const LABEL = /^[^\u0000-\u001f\u007f-\u009f]+$/;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const TEXT = /^(?=[\s\S]*\S)[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]+$/;

const characters = (text: string): number => [...text].length;
const oneOf = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value);

function label(value: string): string | null {
  const text = value.trim();
  return text.length > 0 && characters(text) <= LABEL_MAX && LABEL.test(text) ? text : null;
}

export function validateInquiry(values: InquiryValues): Validation {
  const errors: Partial<Record<FieldName, PublicCopyId>> = {};
  const contactName = label(values.contactName);
  const companyName = label(values.companyName);
  const email = values.contactEmail.trim();
  const description = values.description.trim();
  if (!oneOf(BUYER_TYPES, values.buyerType)) errors.buyerType = "contact.error.buyer";
  if (contactName === null) errors.contactName = "contact.error.name";
  if (email.length < 3 || email.length > 254 || !EMAIL.test(email)) errors.contactEmail = "contact.error.email";
  if (companyName === null) errors.companyName = "contact.error.company";
  if (!oneOf(DESTINATIONS, values.destination)) errors.destination = "contact.error.destination";
  if (!RECORD_BANDS.some((band) => band.value === values.recordBand)) errors.recordBand = "contact.error.band";
  if (!oneOf(TIMINGS, values.timing)) errors.timing = "contact.error.timing";
  if (description.length > 0) {
    if (!TEXT.test(description)) errors.description = "contact.error.description-text";
    else if (characters(description) > DESCRIPTION_MAX) errors.description = "contact.error.description";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      buyerType: values.buyerType as InquiryBody["buyerType"],
      contactName: contactName ?? "",
      contactEmail: email,
      companyName: companyName ?? "",
      destination: values.destination as InquiryBody["destination"],
      recordBand: values.recordBand,
      timing: values.timing as InquiryBody["timing"],
      ...(description.length > 0 ? { description } : {}),
    },
  };
}

export type Outcome =
  | { readonly kind: "RECEIVED"; readonly reference: string }
  | { readonly kind: "REFUSED" }
  | { readonly kind: "LIMITED"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "FIELDS" }
  | { readonly kind: "FAILED" };

const FAILED: Outcome = Object.freeze({ kind: "FAILED" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The api's answer as one outcome. Anything the contract does not describe is FAILED: the visitor is told to send again, never that it worked. */
export function classifyReply(status: number, payload: unknown): Outcome {
  if (!isRecord(payload)) return FAILED;
  if (status === 201) {
    const id = payload["inquiryId"];
    return typeof id === "string" && UUID.test(id) ? { kind: "RECEIVED", reference: id } : FAILED;
  }
  const code = payload["code"];
  if (status === 422 && code === "CONTENT_REFUSED") return { kind: "REFUSED" };
  if (status === 429 && code === "ADMISSION_LIMITED") {
    const wait = payload["retryAfterSeconds"];
    return { kind: "LIMITED", retryAfterSeconds: typeof wait === "number" && Number.isInteger(wait) && wait >= 0 ? wait : null };
  }
  if (status === 400 && code === "INVALID_REQUEST") return { kind: "FIELDS" };
  return FAILED;
}

export interface SubmitOptions {
  /** The address to post to; the browser's relative path unless a test names a server. */
  readonly endpoint?: string;
  readonly fetcher?: typeof fetch;
}

/** Sends the inquiry, same origin, with no credential. Never throws: a network failure is FAILED, and the same inquiry is safe to send again. */
export async function submitInquiry(body: InquiryBody, options: SubmitOptions = {}): Promise<Outcome> {
  try {
    const response = await (options.fetcher ?? fetch)(options.endpoint ?? INQUIRY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return classifyReply(response.status, payload);
  } catch {
    return FAILED;
  }
}

/** A wait in the largest whole unit that does not understate it: "1 minute", "59 minutes", "2 hours". */
export function waitPhrase(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return PUBLIC_COPY["contact.limited.later"];
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.ceil(seconds / 3600);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}
