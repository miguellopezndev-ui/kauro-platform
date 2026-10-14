// What the browser's generated client must put on the wire for an operational route (B11 P0, D-GEN-1). The operational routes carry no registry
// command, so nothing else tells the generated document which of them are journaled (Idempotency-Key), which read under the active agency
// (X-Kauro-Agency), which the session cookie authenticates on an unsafe method (X-Kauro-CSRF) and which role the api demands. The path
// parameters are not listed here: they are read from the `{name}` template of the route itself (the api admits a UUID there).
// apps/api/src/payments/bank-route-routes.ts is the oracle for the bank routes: the key (IDEMPOTENCY_KEY_MISSING), the agency selector
// (AGENCY_SELECTOR_INVALID) and the cookie CSRF rule.
export interface OperationalWire {
  readonly idempotency: "REQUIRED" | "NONE";
  readonly agencySelector: boolean;
  readonly csrf: boolean;
  readonly role: string | null;
}

const entry = (idempotency: OperationalWire["idempotency"], csrf: boolean, role: string | null, agencySelector = false): OperationalWire => Object.freeze({ idempotency, agencySelector, csrf, role });

export const OPERATIONAL_WIRE: Readonly<Record<string, OperationalWire>> = Object.freeze({
  // the browser session boundary and the public inquiry: none is journaled; the cookie routes carry the CSRF token once a session exists
  openSession: entry("NONE", false, null),
  revokeCurrentSession: entry("NONE", true, null),
  createStepUp: entry("NONE", true, null),
  createInquiry: entry("NONE", false, null),
  // Payments V1 bank routes: the owner's five commands are journaled and cookie-authenticated; the route read is owner-only
  configureBankRoute: entry("REQUIRED", true, "KAURO_OWNER"),
  verifyBankRoute: entry("REQUIRED", true, "KAURO_OWNER"),
  enableBankRoute: entry("REQUIRED", true, "KAURO_OWNER"),
  disableBankRoute: entry("REQUIRED", true, "KAURO_OWNER"),
  replaceBankRouteDetails: entry("REQUIRED", true, "KAURO_OWNER"),
  getBankRoute: entry("NONE", false, "KAURO_OWNER"),
  // the buyer's bank details: an agency member under the active agency
  getTransferInstructions: entry("NONE", false, null, true),
  // Payments V1 inbound credits (CMD210-CMD213): the owner's journaled, cookie-authenticated commands and the owner-only reads;
  // the buyer's checkout retirement (CMD214) is journaled under the active agency by a billing member (bank-route-routes.ts)
  enterBankCredit: entry("REQUIRED", true, "KAURO_OWNER"),
  confirmBankCredit: entry("REQUIRED", true, "KAURO_OWNER"),
  attributeBankCredit: entry("REQUIRED", true, "KAURO_OWNER"),
  importBankStatement: entry("REQUIRED", true, "KAURO_OWNER"),
  // Payments V1 settlement (CMD215): the owner's journaled, cookie-authenticated observation of one withdrawal (PV1-SETTLE D-SET-1)
  recordBankSettlement: entry("REQUIRED", true, "KAURO_OWNER"),
  getBankCredit: entry("NONE", false, "KAURO_OWNER"),
  getBankSettlementRequest: entry("NONE", false, "KAURO_OWNER"),
  listBankSettlementsInTransit: entry("NONE", false, "KAURO_OWNER"),
  getBankOrderMatchKeys: entry("NONE", false, "KAURO_OWNER"),
  retireBankCheckout: entry("REQUIRED", true, "AGENCY_BILLING", true),
  // B12 (D-B12S-2, D-B12S-3): the owner's content-addressed evidence upload is not journaled (the same bytes answer the same reference) but is an
  // unsafe cookie request; the credit queue is an owner-only read
  uploadBankEvidenceArtifact: entry("NONE", true, "KAURO_OWNER"),
  listBankCredits: entry("NONE", false, "KAURO_OWNER"),
  // B11 A1: the agency owner records the buyer type once (CMD101), journaled and cookie-authenticated; the agency is the path id
  setBuyerType: entry("REQUIRED", true, "AGENCY_OWNER"),
});
