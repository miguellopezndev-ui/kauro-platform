/**
 * The sealed message of an outreach intent (package B12, lane L-SEND; plan docs/design/B12-outreach-plan.md A13, D-B12O-13).
 *
 * One pure function builds the RFC 5322 text/plain message the Gmail route submits: the bound From, the draft's subject, the commercial
 * identification line and the postal address of the deployment's compliance configuration in the body, exactly one https List-Unsubscribe
 * URI that names the intent's opt-out token, List-Unsubscribe-Post: List-Unsubscribe=One-Click (RFC 8058 s.3.1), and the same opt-out URL
 * in the body. It carries no image and no remote resource. The intent's payload hash is the sha256 of these exact bytes: CMD063 seals
 * it at the intent's birth and D2/D3 rebuild the same bytes from the same inputs, so a changed configuration or secret is observable as a
 * different hash and refuses the send (the intent never submits bytes it did not seal).
 *
 * The opt-out token is HMAC-SHA-256(secret of version v, intent id): it reveals no address and is derivable only by the platform; the
 * public opt-out (lane L-ACT) looks it up by its sha256.
 */
import { createHash, createHmac } from "node:crypto";

/** The deployment's compliance configuration (A13): absent until the owner configures it (D-16), which is OUTREACH_COMPLIANCE_UNCONFIGURED. */
export interface OutreachCompliance {
  readonly postalAddress: string;
  /** https origin of the public opt-out (no trailing slash). */
  readonly optOutOrigin: string;
  readonly commercialIdentification: string;
}

/** The HMAC secret of the opt-out tokens and its version. */
export interface OptOutKey {
  readonly version: number;
  readonly secret: string;
}

export interface OutreachMessage {
  readonly intentId: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

const CRLF = "\r\n";
const OPT_OUT_PATH = "/api/v1/public/outreach/opt-out/";

/** The opt-out token of an intent: `v<version>` and the base64url HMAC of the intent id (characters A-Za-z0-9_- only). */
export function optOutTokenOf(key: OptOutKey, intentId: string): string {
  return `v${key.version}${createHmac("sha256", key.secret).update(intentId, "utf8").digest("base64url")}`;
}

export function optOutUrlOf(compliance: OutreachCompliance, token: string): string {
  return `${compliance.optOutOrigin}${OPT_OUT_PATH}${token}`;
}

/** A header value: one line, no CR or LF (a draft subject is a label, but the message is built defensively). */
function headerValue(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

export function buildOutreachMime(m: OutreachMessage, compliance: OutreachCompliance, key: OptOutKey): string {
  const url = optOutUrlOf(compliance, optOutTokenOf(key, m.intentId));
  const lines = [
    `From: ${headerValue(m.from)}`,
    `To: ${headerValue(m.to)}`,
    `Subject: ${headerValue(m.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    `List-Unsubscribe: <${url}>`,
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  ];
  const body = [m.body.replace(/\r?\n/g, CRLF), "", "--", compliance.commercialIdentification, compliance.postalAddress, `To stop receiving messages from us: ${url}`].join(CRLF);
  return `${lines.join(CRLF)}${CRLF}${CRLF}${body}${CRLF}`;
}

/** The payload hash of a sealed message: sha256 of its exact bytes. */
export function payloadHashOf(mime: string): string {
  return createHash("sha256").update(mime, "utf8").digest("hex");
}
