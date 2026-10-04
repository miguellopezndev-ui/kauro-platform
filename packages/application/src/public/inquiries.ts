/**
 * The fit inquiry of a visitor without an account (B11 W5b, D-PUB-3..D-PUB-6; A3 3.7). The request has already passed admission
 * (content type, size, strict JSON, the closed schema of the route); what is decided here is what a valid inquiry means:
 *
 *   1. the description goes through the bounded detector of D-SUP-2 — a text that looks like a secret or like customer records is
 *      refused with the class of the finding and never stored, counted or echoed;
 *   2. three keyed digests are derived from the process's stable key — the client network, the whole content and the e-mail
 *      address — so the store can hold the content-idempotence record and both limiters without holding an address, a text or a
 *      name. Each digest has its own domain label, so no two of them can collide;
 *   3. the store admits the inquiry (or answers the same one, or a limit), and the receipt is its identity and its instant.
 *
 * Nothing here reads the database or the request: the client network arrives as a string the transport derived from the socket
 * (or from the configured trusted proxy hops), and the store is a port.
 */
import { createHmac } from "node:crypto";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { DomainFailure } from "@kauro/domain";
import type { Clock, EventId, IdGenerator, InquiryAdmissionKeys, InquiryContent, InquiryId, InquiryStore } from "@kauro/domain";
import { detectRefusedContent } from "../support/content-detector.js";

/** The body of `POST /api/v1/public/inquiries` after the closed schema of the route (INQUIRY_REQUEST_SCHEMA). */
export interface InquiryBody {
  readonly buyerType: InquiryContent["buyerType"];
  readonly contactName: string;
  readonly contactEmail: string;
  readonly companyName: string;
  readonly destination: InquiryContent["destination"];
  readonly recordBand: InquiryContent["recordBand"];
  readonly timing: InquiryContent["timing"];
  readonly description?: string;
}

export interface InquiryReceipt {
  readonly inquiryId: InquiryId;
  readonly receivedAt: UtcInstant;
}

export interface InquiryServiceDependencies {
  readonly store: InquiryStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** At least 32 bytes, stable across the instances that share one database: the digests are compared across requests. */
  readonly hashKey: Uint8Array;
}

/** Distinct labels: the same input under two labels gives unrelated digests. */
const DOMAIN = Object.freeze({
  address: "kauro/public/inquiry/address/v1",
  content: "kauro/public/inquiry/content/v1",
  email: "kauro/public/inquiry/email/v1",
});

/** The bucket of a request whose client address is unknown: all such requests share one limiter, so it cannot be avoided by hiding. */
export const UNKNOWN_CLIENT_NETWORK = "unknown";

const MIN_KEY_BYTES = 32;

function digest(key: Uint8Array, label: string, material: string): Sha256Hex {
  return createHmac("sha256", key).update(label, "utf8").update("\n", "utf8").update(material, "utf8").digest("hex") as Sha256Hex;
}

/** The schema-valid body as the content the store keeps: an absent description is null. */
export function inquiryContentOf(body: InquiryBody): InquiryContent {
  return {
    buyerType: body.buyerType,
    contactName: body.contactName,
    contactEmail: body.contactEmail,
    companyName: body.companyName,
    destination: body.destination,
    recordBand: body.recordBand,
    timing: body.timing,
    description: body.description ?? null,
  };
}

/**
 * The three admission keys of an inquiry. The e-mail address is compared without regard to case (its schema admits ASCII only),
 * in the e-mail key and in the content key; every other field is compared exactly. The content key is over a JSON array of the
 * fields in a fixed order, so two contents differ in the key exactly when they differ in a field.
 */
export function inquiryKeysOf(key: Uint8Array, content: InquiryContent, clientNetwork: string | null): InquiryAdmissionKeys {
  const email = content.contactEmail.toLowerCase();
  const canonical = JSON.stringify([content.buyerType, content.contactName, email, content.companyName, content.destination, content.recordBand, content.timing, content.description]);
  return {
    address: digest(key, DOMAIN.address, clientNetwork === null || clientNetwork === "" ? UNKNOWN_CLIENT_NETWORK : clientNetwork),
    content: digest(key, DOMAIN.content, canonical),
    email: digest(key, DOMAIN.email, email),
  };
}

function refuseContent(finding: NonNullable<ReturnType<typeof detectRefusedContent>>): never {
  throw new DomainFailure("CONTENT_REFUSED", `the inquiry description looks like ${finding === "SECRET_LIKE_CONTENT" ? "a secret" : "customer records"}`, { reason: finding });
}

/**
 * Receives one inquiry. Throws CONTENT_REFUSED (a description the detector refuses) or ADMISSION_LIMITED with the seconds until
 * the first counted inquiry leaves its window; any other failure is the store's and is answered opaquely by the transport.
 */
export async function receiveInquiry(deps: InquiryServiceDependencies, body: InquiryBody, clientNetwork: string | null): Promise<InquiryReceipt> {
  if (deps.hashKey.byteLength < MIN_KEY_BYTES) throw new RangeError(`the inquiry hash key must be at least ${MIN_KEY_BYTES} bytes`);
  const content = inquiryContentOf(body);
  if (content.description !== null) {
    const finding = detectRefusedContent(content.description);
    if (finding !== null) refuseContent(finding);
  }
  const admission = await deps.store.admit({
    inquiryId: deps.ids.next() as InquiryId,
    eventId: deps.ids.next() as EventId,
    now: deps.clock.now(),
    keys: inquiryKeysOf(deps.hashKey, content, clientNetwork),
    content,
  });
  if (admission.kind === "LIMITED") {
    throw new DomainFailure("ADMISSION_LIMITED", "too many inquiries from this network or for this address", { reason: "INQUIRY_RATE_LIMITED", retryAfterSeconds: admission.retryAfterSeconds });
  }
  return { inquiryId: admission.inquiryId, receivedAt: admission.receivedAt };
}
