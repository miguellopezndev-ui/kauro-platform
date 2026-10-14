/**
 * The account-details classifier of the CONTRACT_FAKE bank integration (lane L-ROUTE, R1; evidence class SIMULATED): parses the fake's own
 * synthetic artifact `{ format: contract-fake-bank-evidence/1, kind: "ACCOUNT_DETAILS", accountRef, details }` from the exact stored bytes
 * and fails closed — an unauthenticated envelope, bytes that are not the envelope's digest, an unknown format, normalizer or kind, and any
 * missing or malformed field are REJECTED, never a partial value (no snapshot is ever built from part of a document). Not a provider format.
 */
import type { BankRouteDetails, EvidenceClassification } from "@kauro/domain";
import type { BankEvidenceClassifier } from "../bank/inbound-ports.js";
import type { StoredBankEvidence } from "../ports.js";
import { BANK_FAKE_FORMAT, BANK_FAKE_NORMALIZER, classifyFakeBankReceipt, classifyFakeCredit, classifyFakeSettlement, classifyFakeStatement } from "./bank-evidence-fake.js";
import { sha256Hex } from "./labels.js";

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

class Malformed extends Error {}

function str(o: Obj, k: string, pattern?: RegExp): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0 || v.length > 200 || (pattern !== undefined && !pattern.test(v))) throw new Malformed(k);
  return v;
}

const RAILS = new Set(["ACH", "DOMESTIC_WIRE"]);

export function classifyFakeAccountDetails(evidence: StoredBankEvidence): EvidenceClassification<BankRouteDetails> {
  if (evidence.authenticatedBy !== "VERIFIED_BANK_ARTIFACT") return { kind: "REJECTED", code: "UNAUTHENTICATED_EVIDENCE" };
  if (sha256Hex(evidence.bytes) !== evidence.sha256) return { kind: "REJECTED", code: "HASH_MISMATCH" };
  if (evidence.normalizerVersion !== BANK_FAKE_NORMALIZER) return { kind: "REJECTED", code: "UNKNOWN_EVIDENCE" };
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(evidence.bytes));
  } catch {
    return { kind: "REJECTED", code: "MALFORMED_EVIDENCE" };
  }
  if (!isObj(doc) || doc["format"] !== BANK_FAKE_FORMAT || doc["kind"] !== "ACCOUNT_DETAILS") return { kind: "REJECTED", code: "UNKNOWN_EVIDENCE" };
  try {
    if (str(doc, "accountRef") !== evidence.accountRef) throw new Malformed("accountRef");
    const d = doc["details"];
    if (!isObj(d)) throw new Malformed("details");
    const rails = d["acceptedRails"];
    if (!Array.isArray(rails) || rails.length === 0 || !rails.every((r) => typeof r === "string" && RAILS.has(r))) throw new Malformed("acceptedRails");
    if (d["currency"] !== "USD") throw new Malformed("currency");
    const accountType = str(d, "accountType");
    if (accountType !== "CHECKING" && accountType !== "SAVINGS") throw new Malformed("accountType");
    if (!isObj(d["additionalFields"])) throw new Malformed("additionalFields");
    const validUntil = str(d, "validUntil");
    if (!Number.isFinite(Date.parse(validUntil))) throw new Malformed("validUntil");
    const value: BankRouteDetails = {
      accountRef: str(d, "accountRef"),
      detailsVersion: str(d, "detailsVersion"),
      currency: "USD",
      acceptedRails: rails as BankRouteDetails["acceptedRails"],
      beneficiaryName: str(d, "beneficiaryName"),
      bankName: str(d, "bankName"),
      routingNumber: str(d, "routingNumber", /^[0-9]{9}$/),
      accountNumber: str(d, "accountNumber", /^[0-9]{4,17}$/),
      accountType,
      payeeDigest: str(d, "payeeDigest", /^[0-9a-f]{64}$/) as BankRouteDetails["payeeDigest"],
      validUntil: new Date(Date.parse(validUntil)).toISOString(),
    };
    if (value.accountRef !== evidence.accountRef) throw new Malformed("accountRef");
    return { kind: "CLASSIFIED", value };
  } catch (e) {
    if (e instanceof Malformed) return { kind: "REJECTED", code: "MALFORMED_EVIDENCE" };
    throw e;
  }
}

/** The CONTRACT_FAKE classifier as the port the route commands read. */
export const contractFakeBankDetailsClassifier: BankEvidenceClassifier = Object.freeze({ classifyAccountDetails: classifyFakeAccountDetails, classifyCredit: classifyFakeCredit, classifyStatement: classifyFakeStatement, classifySettlement: classifyFakeSettlement, classifyBankReceipt: classifyFakeBankReceipt });
