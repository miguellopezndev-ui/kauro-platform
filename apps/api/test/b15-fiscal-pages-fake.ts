/**
 * A labelled contract fake of a fiscal issuance route (CONTRACT_FAKE, evidence class SIMULATED; package B15 lane L6): the provider's
 * submit and its raw, unfiltered list query in pages of PAGE_SIZE, in the provider's order. No live provider is called (Alegra and the
 * DIAN route stay owner-blocked). The packet is prepared by M2's fiscal bridge fake (the exact request digest, issue_request_hash).
 *
 * A test scripts what the provider does with the next submit of a request digest (ACCEPT, PENDING, REJECT, CORRECTION, LOST after
 * accepting, LOST before reaching it, ACTION_PREPARED), can publish a document later (a pending acceptance concluded, a bridge's legal
 * number obtained), pads the list with other requests' documents, and makes a page time out.
 */
import type { FiscalDocumentPage, FiscalDocumentQuery, FiscalIssuanceRoute, FiscalSubmitAnswer, ProviderFiscalDocument } from "@kauro/application";
import type { FiscalBridgeFake } from "@kauro/application/testing";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { FiscalIssuerRecord, FiscalIssuerRef } from "@kauro/domain";
import { clock, sha } from "./support.js";

export const PAGE_SIZE = 30;

export type SubmitScript = "ACCEPT" | "ACCEPT_WITH_OBSERVATIONS" | "PENDING" | "REJECT" | "CORRECTION" | "LOST_AFTER_ACCEPT" | "LOST" | "ACTION_PREPARED";

export interface FiscalRouteFake extends FiscalIssuanceRoute {
  /** Submit calls received, by request digest. */
  submits(hash: string): number;
  totalSubmits(): number;
  /** Page calls received (cursor per call). */
  readonly pageReads: Array<string | null>;
  /** What the next submit of every request does (default ACCEPT). */
  script(next: SubmitScript): void;
  /** The provider now holds this request's document (it is listed). */
  publish(hash: Sha256Hex, acceptance: ProviderFiscalDocument["acceptance"], at?: "END" | number): ProviderFiscalDocument;
  /** Documents of other requests listed before anything submitted later (the exact identity must be found past page 1). */
  pad(count: number): void;
  /** Page index k (0-based) times out on every read while set. */
  failPage(k: number | null): void;
  /** An await placed inside submit (to pause after the intent committed, before the answer). */
  onSubmit: ((hash: string) => Promise<void>) | null;
  listed(): ReadonlyArray<ProviderFiscalDocument>;
}

let serial = 0;

export function fiscalRouteFake(input: { readonly bridge: FiscalBridgeFake; readonly issuerRef: FiscalIssuerRef; readonly routeKind?: FiscalIssuerRecord["routeKind"]; readonly absenceIsProof?: boolean }): FiscalRouteFake {
  const routeKind = input.routeKind ?? "PROVIDER_API";
  const list: ProviderFiscalDocument[] = [];
  const calls = new Map<string, number>();
  const pageReads: Array<string | null> = [];
  let next: SubmitScript = "ACCEPT";
  let failing: number | null = null;
  const documentOf = (hash: Sha256Hex, acceptance: ProviderFiscalDocument["acceptance"]): ProviderFiscalDocument => {
    serial += 1;
    const n = String(serial).padStart(6, "0");
    const issued = acceptance === "ACCEPTED" || acceptance === "ACCEPTED_WITH_OBSERVATIONS";
    return {
      providerDocumentId: `fake-doc-${n}`,
      issueRequestHash: hash,
      acceptance,
      evidenceHash: sha(`fake-fiscal-evidence-${n}`) as Sha256Hex,
      ...(issued ? { legalNumber: `SETP${n}`, issuedAt: clock.now(), verificationRef: `CUFE-${n}` } : {}),
      ...(acceptance === "REJECTED" ? { rejectionCode: "DIAN_RULE_FAU04" } : {}),
    };
  };
  const fake: FiscalRouteFake = {
    issuerRef: input.issuerRef,
    routeKind,
    integrationClass: routeKind === "MANUAL_BRIDGE" ? "PROVIDER" : "CONTRACT_FAKE",
    absenceIsProof: input.absenceIsProof ?? routeKind === "PROVIDER_API",
    prepare: (document, context) => input.bridge.prepare(document, context),
    onSubmit: null,
    async submit(packet, _deadline: UtcInstant): Promise<FiscalSubmitAnswer> {
      calls.set(packet.issueRequestHash, (calls.get(packet.issueRequestHash) ?? 0) + 1);
      if (fake.onSubmit !== null) await fake.onSubmit(packet.issueRequestHash);
      const script = next;
      next = "ACCEPT";
      switch (script) {
        case "ACCEPT":
        case "ACCEPT_WITH_OBSERVATIONS":
          return { kind: "RECEIVED", document: fake.publish(packet.issueRequestHash, script === "ACCEPT" ? "ACCEPTED" : "ACCEPTED_WITH_OBSERVATIONS") };
        case "PENDING":
          return { kind: "RECEIVED", document: fake.publish(packet.issueRequestHash, "PENDING") };
        case "REJECT":
          return { kind: "RECEIVED", document: fake.publish(packet.issueRequestHash, "REJECTED") };
        case "CORRECTION":
          return { kind: "RECEIVED", document: fake.publish(packet.issueRequestHash, "CORRECTION_REQUIRED") };
        case "LOST_AFTER_ACCEPT":
          fake.publish(packet.issueRequestHash, "ACCEPTED");
          throw new Error("the provider's response was lost (timeout)");
        case "LOST":
          throw new Error("the request never reached the provider (timeout)");
        case "ACTION_PREPARED":
          return { kind: "ACTION_PREPARED", actionRef: `bridge-action-${packet.documentId}` };
      }
    },
    pages: {
      async page(query: FiscalDocumentQuery, cursor: string | null): Promise<FiscalDocumentPage> {
        if (query.issuerRef !== input.issuerRef) throw new Error("the fake lists one issuer's documents");
        pageReads.push(cursor);
        const k = cursor === null ? 0 : Number(cursor);
        if (failing === k) throw new Error(`page ${k} timed out`);
        const documents = list.slice(k * PAGE_SIZE, (k + 1) * PAGE_SIZE);
        return { documents, nextCursor: (k + 1) * PAGE_SIZE < list.length ? String(k + 1) : null };
      },
    },
    submits: (hash) => calls.get(hash) ?? 0,
    totalSubmits: () => [...calls.values()].reduce((a, b) => a + b, 0),
    pageReads,
    script(s) {
      next = s;
    },
    publish(hash, acceptance, at = "END") {
      const d = documentOf(hash, acceptance);
      // a re-publication replaces what the provider lists for the request (a pending acceptance concluded)
      const existing = list.findIndex((x) => x.issueRequestHash === hash);
      if (existing >= 0) list.splice(existing, 1);
      if (at === "END") list.push(d);
      else list.splice(at, 0, d);
      return d;
    },
    pad(count) {
      for (let i = 0; i < count; i++) list.push(documentOf(sha(`other-request-${serial}-${i}`) as Sha256Hex, "ACCEPTED"));
    },
    failPage(k) {
      failing = k;
    },
    listed: () => list,
  };
  return fake;
}
