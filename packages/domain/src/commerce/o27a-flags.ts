/**
 * Order 27A activation flags (sprint rules: work built against the O19A candidate ships with its activation OFF). Every flag is a frozen
 * `false` here; nothing in the platform turns one on. Each names what must hold before a later order may switch it, so a reader of the
 * code knows why it is off. A test passes its own activation explicitly to the pure rules; the defaults below never change at runtime.
 */
export interface O27AActivation {
  /** CP-01.11 pending-payment hold (CONDITIONAL, PV1-blocked). */
  readonly pendingPaymentHold: boolean;
  /** A real receipt source (Wise Business ACH details and statements). Only the simulator exists. */
  readonly realReceiptSource: boolean;
  /** Electronic invoice issuance through DIAN (needs RUT, issuer qualification and verification). */
  readonly dianIssuance: boolean;
}

export const O27A_ACTIVATION: O27AActivation = Object.freeze({ pendingPaymentHold: false, realReceiptSource: false, dianIssuance: false });

/** What unlocks each flag (recorded in O27A-READY.json as well). */
export const O27A_UNLOCKS: Readonly<Record<keyof O27AActivation, string>> = Object.freeze({
  pendingPaymentHold:
    "CP-01.11 pending points: Wise Business enabled and PV1 qualification of the ACH route (O27B/O31), real verifiable proof evidence, abuse controls proved in the database, LR-02 counsel review, O19B adoption of CP-02.17",
  realReceiptSource: "PV1 (O27B): Wise Business enabled with real ACH receiving details and statement evidence; no PayPal (parked)",
  dianIssuance: "RUT registered, fiscal issuer QUALIFIED with entitlement evidence and numbering authorization, DIAN verification recorded (O31/O27B)",
});
