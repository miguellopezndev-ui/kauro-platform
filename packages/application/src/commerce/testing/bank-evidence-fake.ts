/**
 * BankEvidenceReadPortV1 and BankEvidenceStore — CONTRACT_FAKE of the bank-transfer evidence contract (Payments V1; docs/design/ACH-ROUTE.md
 * D-ACH-15, §6.1; decision D-FAKE-B1). Evidence class SIMULATED: nothing this fake answers is a bank or provider fact, and no case closes
 * on it. It is built only from the public contract of the port (the shapes, outcomes and refusals of §6 and §6.1) and from no vendor
 * document: the artifact format below, `contract-fake-bank-evidence/1`, is this fake's own synthetic JSON, carries no real account and is
 * NOT any provider's format. A real adapter (packages/adapters-wise, S-B) parses its own formats behind the same port.
 *
 * Fidelity points the application depends on:
 *  - the classifiers are pure, parse only the exact stored bytes and fail closed: an unauthenticated envelope, a digest that is not the
 *    bytes', an unknown format, normalizer or kind, and malformed or missing required fields are the four REJECTED codes, never a
 *    partial value; a status the fake does not know becomes UNRECOGNIZED, never success or failure;
 *  - an evidence field the bytes do not carry is null, never inferred (ACH-R7-03, K-8): no digest is derived from a full number, no
 *    execution time from a reference, no destination from an amount; an unknown fee is null, an observed zero is zero;
 *  - the port has no create, fund, cancel or resend method (D-ACH-20): the absence is the contract;
 *  - reads are scripted per method and otherwise answer what a quiet provider answers: an empty complete page, a PENDING lookup (a
 *    missing credit is never PROVED_NO_EFFECT), a stable account-details artifact; a dispatch past its deadline is not sent (AMBIGUOUS
 *    TIMEOUT, logged sent: false); a cursor of another account, environment or normalizer version is REFUSED VALIDATION_REJECTED;
 *  - the store is immutable and content-addressed; what `get` returns is a frozen copy; `corrupt` models bytes that no longer match
 *    their envelope digest (HASH_MISMATCH).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  AmbiguityReason,
  BankAccountRef,
  BankCreditId,
  BankOutcome,
  Clock,
  CreditPage,
  DebitPage,
  DestinationEvidence,
  EvidenceClassification,
  FundsState,
  IncomingCredit,
  ObservedBankRail,
  Operational,
  OutboundEvidence,
  PaymentEnvironment,
  BankReceiptEvidence,
  SettlementEvidence,
  StatementDebit,
  StatementPage,
  UsdBankAccountDetails,
} from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";
import type { BankEvidenceReadPortV1, BankEvidenceStore, StoredBankEvidence } from "../ports.js";
import type { RecipientRecordEvidence } from "../bank/ports.js";
import { CONTRACT_FAKE, FAKE_EVIDENCE_CLASS, instantOf, sha256Hex, uuidV8Of, type FakeCall } from "./labels.js";

export const BANK_FAKE_PROVIDER = "contract-fake-bank";
export const BANK_FAKE_FORMAT = "contract-fake-bank-evidence/1";
export const BANK_FAKE_NORMALIZER = "contract-fake-bank-v1";

// --- the fake's own artifact format -------------------------------------------------------------------------------------------------

export type BankFakeKind = "CREDIT" | "OUTBOUND" | "STATEMENT" | "SETTLEMENT" | "BANK_RECEIPT" | "RECIPIENT";

/** Fields of a credit line as an artifact states them; every optional field absent from the bytes is null in the classification. */
export interface FakeCreditFields {
  readonly creditId: string;
  readonly environment?: PaymentEnvironment;
  readonly rail?: string;
  readonly currency: string;
  readonly grossCents?: bigint | null;
  readonly netCents?: bigint | null;
  readonly feeCents?: bigint | null;
  readonly payeeDigest: Sha256Hex;
  readonly reference?: string | null;
  readonly payerDigest?: Sha256Hex | null;
  readonly payerEvidenceRef?: string | null;
  readonly status?: string;
  readonly reversedCents?: bigint | null;
  readonly fundsState?: FundsState;
  readonly bookedAt?: string | null;
  readonly observedAt: string;
}

export interface FakeDestinationFields {
  readonly accountDigest?: Sha256Hex | null;
  readonly accountLast4?: string | null;
  readonly routingDigest?: Sha256Hex | null;
  readonly full?: { readonly routingNumber: string; readonly accountNumber: string; readonly holderName: string } | null;
  readonly recipientRef?: string | null;
  readonly recipientVersion?: string | null;
}

export interface FakeOutboundFields {
  readonly bankExecutionId: string;
  readonly destination?: FakeDestinationFields;
  readonly reference?: string | null;
  readonly executedAt?: string | null;
  readonly amountCents: bigint;
  readonly currency: string;
  readonly feeCents?: bigint | null;
  readonly status?: string;
  readonly returnedCents?: bigint | null;
  readonly observedAt: string;
}

export interface FakeDebitFields {
  readonly debitId: string;
  readonly bankExecutionId?: string | null;
  readonly amountCents: bigint;
  readonly currency: string;
  readonly feeCents?: bigint | null;
  readonly destination?: FakeDestinationFields;
  readonly reference?: string | null;
  readonly executedAt?: string | null;
  readonly status?: string;
  readonly returnedCents?: bigint | null;
  readonly bookedAt?: string | null;
  readonly observedAt: string;
}

export interface FakeStatementFields {
  readonly coverageStart: string;
  readonly coverageEnd: string;
  readonly credits: ReadonlyArray<FakeCreditFields>;
  readonly debits: ReadonlyArray<FakeDebitFields>;
}

/** A provider settlement record of the route account (ST1, PV1-SETTLE D-SET-2). */
export interface FakeSettlementFields {
  readonly currency: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly withdrawalId: string;
  readonly grossCents: bigint | null;
  readonly feeCents: bigint | null;
  readonly heldCents: bigint | null;
  readonly withdrawnCents: bigint | null;
  readonly observedAt: string;
}

/** The receiving bank's record of a withdrawal's arrival (ST1, D-SET-2). */
export interface FakeBankReceiptFields {
  readonly receivingAccountRef: string;
  readonly withdrawalId: string;
  readonly bankTransactionId: string;
  readonly currency: string;
  readonly receivedCents: bigint | null;
  readonly bankAvailableCents: bigint | null;
  readonly bookedAt: string;
  readonly observedAt: string;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const cents = (v: bigint | null | undefined): Json => (v === undefined || v === null ? null : v.toString());

function destinationJson(d: FakeDestinationFields | undefined): Json {
  if (d === undefined) return null;
  return { accountDigest: d.accountDigest ?? null, accountLast4: d.accountLast4 ?? null, routingDigest: d.routingDigest ?? null, full: d.full ?? null, recipientRef: d.recipientRef ?? null, recipientVersion: d.recipientVersion ?? null };
}

function creditJson(c: FakeCreditFields): Json {
  return {
    creditId: c.creditId,
    environment: c.environment ?? null,
    rail: c.rail ?? null,
    currency: c.currency,
    grossCents: cents(c.grossCents),
    netCents: cents(c.netCents),
    feeCents: cents(c.feeCents),
    payeeDigest: c.payeeDigest,
    reference: c.reference ?? null,
    payerDigest: c.payerDigest ?? null,
    payerEvidenceRef: c.payerEvidenceRef ?? null,
    status: c.status ?? null,
    reversedCents: cents(c.reversedCents),
    fundsState: c.fundsState ?? null,
    bookedAt: c.bookedAt ?? null,
    observedAt: c.observedAt,
  };
}

function debitJson(d: FakeDebitFields): Json {
  return {
    debitId: d.debitId,
    bankExecutionId: d.bankExecutionId ?? null,
    amountCents: cents(d.amountCents),
    currency: d.currency,
    feeCents: cents(d.feeCents),
    destination: destinationJson(d.destination),
    reference: d.reference ?? null,
    executedAt: d.executedAt ?? null,
    status: d.status ?? null,
    returnedCents: cents(d.returnedCents),
    bookedAt: d.bookedAt ?? null,
    observedAt: d.observedAt,
  };
}

const bytesOfJson = (value: Json): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

export function fakeCreditBytes(accountRef: string, fields: FakeCreditFields): Uint8Array {
  return bytesOfJson({ format: BANK_FAKE_FORMAT, kind: "CREDIT", accountRef, credit: creditJson(fields) });
}

export function fakeOutboundBytes(accountRef: string, o: FakeOutboundFields): Uint8Array {
  return bytesOfJson({
    format: BANK_FAKE_FORMAT,
    kind: "OUTBOUND",
    accountRef,
    outbound: {
      bankExecutionId: o.bankExecutionId,
      destination: destinationJson(o.destination),
      reference: o.reference ?? null,
      executedAt: o.executedAt ?? null,
      amountCents: cents(o.amountCents),
      currency: o.currency,
      feeCents: cents(o.feeCents),
      status: o.status ?? null,
      returnedCents: cents(o.returnedCents),
      observedAt: o.observedAt,
    },
  });
}

export function fakeStatementBytes(accountRef: string, s: FakeStatementFields): Uint8Array {
  return bytesOfJson({ format: BANK_FAKE_FORMAT, kind: "STATEMENT", accountRef, coverageStart: s.coverageStart, coverageEnd: s.coverageEnd, credits: s.credits.map(creditJson), debits: s.debits.map(debitJson) });
}

export function fakeSettlementBytes(accountRef: string, f: FakeSettlementFields): Uint8Array {
  return bytesOfJson({
    format: BANK_FAKE_FORMAT,
    kind: "SETTLEMENT",
    accountRef,
    settlement: { currency: f.currency, periodStart: f.periodStart, periodEnd: f.periodEnd, withdrawalId: f.withdrawalId, grossCents: cents(f.grossCents), feeCents: cents(f.feeCents), heldCents: cents(f.heldCents), withdrawnCents: cents(f.withdrawnCents), observedAt: f.observedAt },
  });
}

export function fakeBankReceiptBytes(accountRef: string, r: FakeBankReceiptFields): Uint8Array {
  return bytesOfJson({
    format: BANK_FAKE_FORMAT,
    kind: "BANK_RECEIPT",
    accountRef,
    receipt: { receivingAccountRef: r.receivingAccountRef, withdrawalId: r.withdrawalId, bankTransactionId: r.bankTransactionId, currency: r.currency, receivedCents: cents(r.receivedCents), bankAvailableCents: cents(r.bankAvailableCents), bookedAt: r.bookedAt, observedAt: r.observedAt },
  });
}

// --- pure classification (fail closed) ----------------------------------------------------------------------------------------------

type Rejected = { readonly kind: "REJECTED"; readonly code: "UNKNOWN_EVIDENCE" | "MALFORMED_EVIDENCE" | "HASH_MISMATCH" | "UNAUTHENTICATED_EVIDENCE" };
const reject = (code: Rejected["code"]): Rejected => ({ kind: "REJECTED", code });

class Malformed extends Error {}

type Obj = { readonly [k: string]: unknown };
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(o: Obj, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0) throw new Malformed(k);
  return v;
}
function strOrNull(o: Obj, k: string): string | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Malformed(k);
  return v;
}
function centsOrNull(o: Obj, k: string): bigint | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !/^[0-9]{1,15}$/.test(v)) throw new Malformed(k);
  return BigInt(v);
}
function centsOf(o: Obj, k: string): bigint {
  const v = centsOrNull(o, k);
  if (v === null) throw new Malformed(k);
  return v;
}
function instant(o: Obj, k: string): UtcInstant {
  const v = instantOf(o[k]);
  if (v === null) throw new Malformed(k);
  return v;
}
function instantOrNull(o: Obj, k: string): UtcInstant | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  return instant(o, k);
}
function hex(o: Obj, k: string): Sha256Hex {
  const v = str(o, k);
  if (!/^[0-9a-f]{64}$/.test(v)) throw new Malformed(k);
  return v;
}
function hexOrNull(o: Obj, k: string): Sha256Hex | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  return hex(o, k);
}

const RAILS: ReadonlySet<string> = new Set(["ACH", "DOMESTIC_WIRE", "OTHER", "UNKNOWN"]);
const CREDIT_STATUSES = ["PENDING", "COMPLETED", "DENIED", "REVERSED"] as const;
const OUTBOUND_STATUSES = ["SENT", "COMPLETED", "BOUNCED", "CANCELLED"] as const;
const DEBIT_STATUSES = ["SENT", "COMPLETED", "RETURNED"] as const;
const FUNDS: ReadonlyArray<FundsState> = ["UNKNOWN", "HELD", "AVAILABLE"];

function statusOf<T extends string>(o: Obj, known: ReadonlyArray<T>): T | "UNRECOGNIZED" {
  const v = o["status"];
  if (v === undefined || v === null) return "UNRECOGNIZED";
  if (typeof v !== "string") throw new Malformed("status");
  return (known as ReadonlyArray<string>).includes(v) ? (v as T) : "UNRECOGNIZED";
}

function destinationOf(v: unknown): DestinationEvidence {
  const none: DestinationEvidence = { accountDigest: null, accountLast4: null, routingDigest: null, full: null, recipientRef: null, recipientVersion: null };
  if (v === undefined || v === null) return none;
  if (!isObj(v)) throw new Malformed("destination");
  const f = v["full"];
  let full: DestinationEvidence["full"] = null;
  if (f !== undefined && f !== null) {
    if (!isObj(f)) throw new Malformed("destination.full");
    full = { routingNumber: str(f, "routingNumber"), accountNumber: str(f, "accountNumber"), holderName: str(f, "holderName") };
  }
  const last4 = strOrNull(v, "accountLast4");
  if (last4 !== null && !/^[0-9]{1,4}$/.test(last4)) throw new Malformed("accountLast4");
  return { accountDigest: hexOrNull(v, "accountDigest"), accountLast4: last4, routingDigest: hexOrNull(v, "routingDigest"), full, recipientRef: strOrNull(v, "recipientRef"), recipientVersion: strOrNull(v, "recipientVersion") };
}

interface Envelope {
  readonly artifactRef: string;
  readonly sha256: Sha256Hex;
  readonly accountRef: BankAccountRef;
  readonly environment: PaymentEnvironment;
}

function creditOf(o: Obj, e: Envelope): IncomingCredit {
  const gross = centsOrNull(o, "grossCents");
  const net = centsOrNull(o, "netCents");
  const fee = centsOrNull(o, "feeCents");
  // when all three are known they must agree (D-ACH-12); a conflict is never repaired
  if (gross !== null && net !== null && fee !== null && gross - fee !== net) throw new Malformed("gross-fee-net");
  const rail = strOrNull(o, "rail");
  const funds = strOrNull(o, "fundsState");
  if (funds !== null && !(FUNDS as ReadonlyArray<string>).includes(funds)) throw new Malformed("fundsState");
  const env = strOrNull(o, "environment");
  if (env !== null && env !== e.environment) throw new Malformed("environment");
  return {
    evidenceHash: e.sha256,
    artifactRef: e.artifactRef,
    accountRef: e.accountRef,
    creditId: str(o, "creditId") as BankCreditId,
    environment: e.environment,
    rail: (rail !== null && RAILS.has(rail) ? rail : "UNKNOWN") as ObservedBankRail,
    currency: str(o, "currency"),
    grossCents: gross,
    netCents: net,
    feeCents: fee,
    payeeDigest: hex(o, "payeeDigest"),
    reference: strOrNull(o, "reference"),
    payerDigest: hexOrNull(o, "payerDigest"),
    payerEvidenceRef: strOrNull(o, "payerEvidenceRef"),
    status: statusOf(o, CREDIT_STATUSES),
    reversedCents: centsOrNull(o, "reversedCents"),
    fundsState: (funds ?? "UNKNOWN") as FundsState,
    bookedAt: instantOrNull(o, "bookedAt"),
    observedAt: instant(o, "observedAt"),
  };
}

function debitOf(o: Obj, e: Envelope): StatementDebit {
  return {
    evidenceHash: e.sha256,
    artifactRef: e.artifactRef,
    accountRef: e.accountRef,
    debitId: str(o, "debitId"),
    bankExecutionId: strOrNull(o, "bankExecutionId"),
    amountCents: centsOf(o, "amountCents"),
    currency: str(o, "currency"),
    feeCents: centsOrNull(o, "feeCents"),
    destination: destinationOf(o["destination"]),
    reference: strOrNull(o, "reference"),
    executedAt: instantOrNull(o, "executedAt"),
    status: statusOf(o, DEBIT_STATUSES),
    returnedCents: centsOrNull(o, "returnedCents"),
    bookedAt: instantOrNull(o, "bookedAt"),
    observedAt: instant(o, "observedAt"),
  };
}

function outboundOf(o: Obj, e: Envelope): OutboundEvidence {
  return {
    evidenceHash: e.sha256,
    artifactRef: e.artifactRef,
    bankExecutionId: str(o, "bankExecutionId"),
    accountRef: e.accountRef,
    destination: destinationOf(o["destination"]),
    reference: strOrNull(o, "reference"),
    executedAt: instantOrNull(o, "executedAt"),
    amountCents: centsOf(o, "amountCents"),
    currency: str(o, "currency"),
    feeCents: centsOrNull(o, "feeCents"),
    status: statusOf(o, OUTBOUND_STATUSES),
    returnedCents: centsOrNull(o, "returnedCents"),
    observedAt: instant(o, "observedAt"),
  };
}

function classify<T>(evidence: StoredBankEvidence, kind: BankFakeKind, read: (doc: Obj, e: Envelope) => T): EvidenceClassification<T> {
  if (evidence.authenticatedBy !== "VERIFIED_BANK_ARTIFACT" && evidence.authenticatedBy !== "PROVIDER_API_RESPONSE") return reject("UNAUTHENTICATED_EVIDENCE");
  if (sha256Hex(evidence.bytes) !== evidence.sha256) return reject("HASH_MISMATCH");
  if (evidence.normalizerVersion !== BANK_FAKE_NORMALIZER) return reject("UNKNOWN_EVIDENCE");
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(evidence.bytes));
  } catch {
    return reject("MALFORMED_EVIDENCE");
  }
  if (!isObj(doc)) return reject("MALFORMED_EVIDENCE");
  if (doc["format"] !== BANK_FAKE_FORMAT || doc["kind"] !== kind) return reject("UNKNOWN_EVIDENCE");
  try {
    if (str(doc, "accountRef") !== evidence.accountRef) throw new Malformed("accountRef");
    const e: Envelope = { artifactRef: evidence.artifactRef, sha256: evidence.sha256, accountRef: evidence.accountRef, environment: evidence.environment };
    return { kind: "CLASSIFIED", value: read(doc, e) };
  } catch (err) {
    if (err instanceof Malformed) return reject("MALFORMED_EVIDENCE");
    throw err;
  }
}

function sub(doc: Obj, k: string): Obj {
  const v = doc[k];
  if (!isObj(v)) throw new Malformed(k);
  return v;
}
function list(doc: Obj, k: string): ReadonlyArray<Obj> {
  const v = doc[k];
  if (!Array.isArray(v) || !v.every(isObj)) throw new Malformed(k);
  return v;
}

export function classifyFakeCredit(evidence: StoredBankEvidence): EvidenceClassification<IncomingCredit> {
  return classify(evidence, "CREDIT", (doc, e) => creditOf(sub(doc, "credit"), e));
}
export function classifyFakeOutbound(evidence: StoredBankEvidence): EvidenceClassification<OutboundEvidence> {
  return classify(evidence, "OUTBOUND", (doc, e) => outboundOf(sub(doc, "outbound"), e));
}
/** A recipient-record artifact (DP-RECIPIENT): the record id, its version (required: a record without a version proves nothing) and its full details. */
export function fakeRecipientBytes(accountRef: string, r: { readonly recipientRef: string; readonly recipientVersion: string; readonly full: { readonly routingNumber: string; readonly accountNumber: string; readonly holderName: string } }): Uint8Array {
  return bytesOfJson({ format: BANK_FAKE_FORMAT, kind: "RECIPIENT", accountRef, recipient: { recipientRef: r.recipientRef, recipientVersion: r.recipientVersion, full: { ...r.full } } });
}
export function classifyFakeRecipient(evidence: StoredBankEvidence): EvidenceClassification<RecipientRecordEvidence> {
  return classify(evidence, "RECIPIENT", (doc, e) => {
    const r = sub(doc, "recipient");
    const f = sub(r, "full");
    return { accountRef: e.accountRef, recipientRef: str(r, "recipientRef"), recipientVersion: str(r, "recipientVersion"), full: { routingNumber: str(f, "routingNumber"), accountNumber: str(f, "accountNumber"), holderName: str(f, "holderName") } };
  });
}
export function classifyFakeStatement(evidence: StoredBankEvidence): EvidenceClassification<StatementPage> {
  return classify(evidence, "STATEMENT", (doc, e) => ({
    evidenceHash: e.sha256,
    artifactRef: e.artifactRef,
    accountRef: e.accountRef,
    coverageStart: instant(doc, "coverageStart"),
    coverageEnd: instant(doc, "coverageEnd"),
    credits: list(doc, "credits").map((c) => creditOf(c, e)),
    debits: list(doc, "debits").map((d) => debitOf(d, e)),
  }));
}

/** ST1: a settlement record names a real period and a withdrawal; every amount is stated (an absent figure is malformed, never 0). */
export function classifyFakeSettlement(evidence: StoredBankEvidence): EvidenceClassification<SettlementEvidence> {
  return classify(evidence, "SETTLEMENT", (doc, e) => {
    const o = sub(doc, "settlement");
    const periodStart = instant(o, "periodStart");
    const periodEnd = instant(o, "periodEnd");
    if (!(Date.parse(periodStart) < Date.parse(periodEnd))) throw new Malformed("period");
    return {
      evidenceHash: e.sha256,
      artifactRef: e.artifactRef,
      accountRef: e.accountRef,
      currency: str(o, "currency"),
      periodStart,
      periodEnd,
      withdrawalId: str(o, "withdrawalId"),
      grossCents: centsOf(o, "grossCents"),
      feeCents: centsOf(o, "feeCents"),
      heldCents: centsOf(o, "heldCents"),
      withdrawnCents: centsOf(o, "withdrawnCents"),
      observedAt: instant(o, "observedAt"),
    };
  });
}
/** ST1: the receiving bank's receipt of a withdrawal, the only source of bank-available money. */
export function classifyFakeBankReceipt(evidence: StoredBankEvidence): EvidenceClassification<BankReceiptEvidence> {
  return classify(evidence, "BANK_RECEIPT", (doc, e) => {
    const o = sub(doc, "receipt");
    return {
      evidenceHash: e.sha256,
      artifactRef: e.artifactRef,
      accountRef: str(o, "receivingAccountRef"),
      withdrawalId: str(o, "withdrawalId"),
      bankTransactionId: str(o, "bankTransactionId"),
      currency: str(o, "currency"),
      receivedCents: centsOf(o, "receivedCents"),
      bankAvailableCents: centsOf(o, "bankAvailableCents"),
      bookedAt: instant(o, "bookedAt"),
      observedAt: instant(o, "observedAt"),
    };
  });
}

// --- the port, scripted -------------------------------------------------------------------------------------------------------------

export type BankFakeMethod = "getAccountDetails" | "listIncomingCredits" | "getCreditById" | "listStatementDebits";

/** One scripted answer for the next call of a method. */
export type BankFakeScript =
  | { readonly kind: "OUTCOME"; readonly outcome: BankOutcome<unknown> }
  | { readonly kind: "AMBIGUOUS"; readonly reason: AmbiguityReason }
  | { readonly kind: "REFUSED"; readonly operational: Omit<Operational, "requestHash"> };

export interface BankEvidenceFakeOptions {
  readonly clock: Clock;
  readonly environment: PaymentEnvironment;
  readonly accountRef: BankAccountRef;
  readonly payeeDigest: Sha256Hex;
}

export interface BankEvidenceFake extends BankEvidenceReadPortV1, BankEvidenceStore {
  readonly integrationClass: typeof CONTRACT_FAKE;
  readonly evidenceClass: typeof FAKE_EVIDENCE_CLASS;
  readonly calls: ReadonlyArray<FakeCall>;
  /** DP-RECIPIENT (DV1-10): classifies a recipient-record artifact of this fake. */
  classifyRecipient(evidence: StoredBankEvidence): EvidenceClassification<RecipientRecordEvidence>;
  /** Stores bytes under their content address with the provenance the store assigns; the same bytes answer the same reference. */
  put(input: { readonly bytes: Uint8Array; readonly accountRef?: BankAccountRef; readonly authenticatedBy?: StoredBankEvidence["authenticatedBy"]; readonly normalizerVersion?: string }): Promise<{ readonly artifactRef: string; readonly sha256: Sha256Hex }>;
  /** Replaces the stored bytes without touching the envelope digest: the next read no longer matches its hash. */
  corrupt(artifactRef: string, bytes: Uint8Array): void;
  /** Queues the answer of the next call of `method` (consumed in order). */
  script(method: BankFakeMethod, answer: BankFakeScript): void;
  /** The opaque cursor this fake would issue for a page of this account, environment and normalizer version. */
  cursorFor(position: string): string;
}

function frozenCopy(e: StoredBankEvidence): StoredBankEvidence {
  return Object.freeze({ ...e, bytes: Uint8Array.from(e.bytes) });
}

export function createBankEvidenceFake(options: BankEvidenceFakeOptions): BankEvidenceFake {
  const stored = new Map<string, StoredBankEvidence>();
  const calls: FakeCall[] = [];
  const scripts = new Map<BankFakeMethod, BankFakeScript[]>();
  const cursorPrefix = `${options.accountRef}|${options.environment}|${BANK_FAKE_NORMALIZER}|`;
  const log = (port: string, operation: string, identity: string | null, sent = true): void => void calls.push(Object.freeze({ port, operation, identity, at: options.clock.now(), sent }));
  const hashOf = (method: string, input: unknown): Sha256Hex => sha256Hex(`${method}|${JSON.stringify(input, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  const evidenceOf = (method: string, input: unknown): { evidenceHash: Sha256Hex; artifactRef: string } => {
    const evidenceHash = hashOf(method, input);
    return { evidenceHash, artifactRef: uuidV8Of(evidenceHash) };
  };

  /** The scripted answer, a deadline refusal, or undefined when the method answers its default. */
  function scripted<T>(method: BankFakeMethod, input: unknown, deadline: UtcInstant | null): BankOutcome<T> | undefined {
    if (deadline !== null && Date.parse(deadline) <= Date.parse(options.clock.now())) {
      log("BankEvidenceReadPortV1", method, null, false);
      return { kind: "AMBIGUOUS", reason: "TIMEOUT" };
    }
    const next = scripts.get(method)?.shift();
    if (next === undefined) return undefined;
    if (next.kind === "AMBIGUOUS") return { kind: "AMBIGUOUS", reason: next.reason };
    if (next.kind === "REFUSED") return { kind: "REFUSED", operational: { ...next.operational, requestHash: hashOf(method, input) } };
    return next.outcome as BankOutcome<T>;
  }

  const details: UsdBankAccountDetails = Object.freeze({
    accountRef: options.accountRef,
    detailsVersion: "contract-fake-details/1",
    currency: "USD",
    acceptedRails: Object.freeze(["ACH", "DOMESTIC_WIRE"] as const),
    payeeDigest: options.payeeDigest,
    beneficiaryName: "Contract Fake Beneficiary",
    bankName: "Contract Fake Bank",
    routingNumber: "000000000",
    accountNumber: "000000000000",
    accountType: "CHECKING",
    additionalFields: Object.freeze({}),
    verifiedAt: toUtcInstant(Date.parse("2026-01-01T00:00:00.000Z")),
  });

  const fake: BankEvidenceFake = {
    provider: BANK_FAKE_PROVIDER,
    environment: options.environment,
    integrationClass: CONTRACT_FAKE,
    evidenceClass: FAKE_EVIDENCE_CLASS,
    get calls() {
      return calls;
    },
    async getAccountDetails(account, deadline) {
      log("BankEvidenceReadPortV1", "getAccountDetails", account);
      const s = scripted<UsdBankAccountDetails>("getAccountDetails", { account }, deadline);
      if (s !== undefined) return s;
      if (account !== options.accountRef) return { kind: "REFUSED", operational: { code: "VALIDATION_REJECTED", requestHash: hashOf("getAccountDetails", { account }) } };
      return { kind: "COMPLETED", value: details, ...evidenceOf("getAccountDetails", { account }) };
    },
    async listIncomingCredits(input) {
      log("BankEvidenceReadPortV1", "listIncomingCredits", input.since);
      const s = scripted<CreditPage>("listIncomingCredits", input, input.deadline);
      if (s !== undefined) return s;
      if (input.accountRef !== options.accountRef || (input.since !== null && !input.since.startsWith(cursorPrefix))) return { kind: "REFUSED", operational: { code: "VALIDATION_REJECTED", requestHash: hashOf("listIncomingCredits", input) } };
      const now = options.clock.now();
      return { kind: "COMPLETED", value: { credits: [], nextCursor: fake.cursorFor("0"), complete: true, coverageStart: now, coverageEnd: now }, ...evidenceOf("listIncomingCredits", input) };
    },
    async getCreditById(input) {
      log("BankEvidenceReadPortV1", "getCreditById", input.creditId);
      const s = scripted<IncomingCredit>("getCreditById", input, input.deadline);
      if (s !== undefined) return s;
      // a credit this fake does not know is PENDING, never PROVED_NO_EFFECT: a list or lookup absence proves nothing
      return { kind: "PENDING", ...evidenceOf("getCreditById", input) };
    },
    async listStatementDebits(input) {
      log("BankEvidenceReadPortV1", "listStatementDebits", input.since);
      const s = scripted<DebitPage>("listStatementDebits", input, input.deadline);
      if (s !== undefined) return s;
      if (input.accountRef !== options.accountRef || (input.since !== null && !input.since.startsWith(cursorPrefix))) return { kind: "REFUSED", operational: { code: "VALIDATION_REJECTED", requestHash: hashOf("listStatementDebits", input) } };
      const now = options.clock.now();
      return { kind: "COMPLETED", value: { debits: [], nextCursor: fake.cursorFor("0"), complete: true, coverageStart: now, coverageEnd: now }, ...evidenceOf("listStatementDebits", input) };
    },
    classifyCredit: classifyFakeCredit,
    classifyOutbound: classifyFakeOutbound,
    classifyRecipient: classifyFakeRecipient,
    classifyStatement: classifyFakeStatement,
    classifySettlement: classifyFakeSettlement,
    classifyBankReceipt: classifyFakeBankReceipt,
    async put(input) {
      const sha256 = sha256Hex(input.bytes);
      const artifactRef = uuidV8Of(sha256);
      log("BankEvidenceStore", "PUT", artifactRef);
      if (!stored.has(artifactRef)) {
        stored.set(
          artifactRef,
          frozenCopy({
            artifactRef,
            kind: "PROVIDER_RESPONSE",
            provider: BANK_FAKE_PROVIDER,
            environment: options.environment,
            sha256,
            capturedAt: options.clock.now(),
            authenticatedBy: input.authenticatedBy ?? "VERIFIED_BANK_ARTIFACT",
            integrationClass: CONTRACT_FAKE,
            accountRef: input.accountRef ?? options.accountRef,
            normalizerVersion: input.normalizerVersion ?? BANK_FAKE_NORMALIZER,
            bytes: input.bytes,
          }),
        );
      }
      return { artifactRef, sha256 };
    },
    async get(artifactRef) {
      log("BankEvidenceStore", "GET", artifactRef);
      const e = stored.get(artifactRef);
      return e === undefined ? null : frozenCopy(e);
    },
    corrupt(artifactRef, bytes) {
      const e = stored.get(artifactRef);
      if (e === undefined) throw new Error("no such artifact");
      stored.set(artifactRef, frozenCopy({ ...e, bytes }));
    },
    script(method, answer) {
      const q = scripts.get(method) ?? [];
      q.push(answer);
      scripts.set(method, q);
    },
    cursorFor(position) {
      return `${cursorPrefix}${position}`;
    },
  };
  return fake;
}
