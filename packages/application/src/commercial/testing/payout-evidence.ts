/**
 * The contract fake of PayoutEvidenceVerifier (design §9, §11, D10-PAY-1, D10-PAY-2): the bank or payout provider's verified
 * evidence, scripted by reference. `matching(intent, status)` builds the evidence a provider would report for that intent in one of
 * the four statuses (SUBMITTED, SETTLED, FAILED, RETURNED); `mismatching` differs from the intent in exactly one named member
 * (REFERENCE, DESTINATION or AMOUNT), for the cases that must refuse to reconcile it. Anything a test did not script is UNAVAILABLE,
 * never guessed. Amounts are integer cents (bigint). `integrationClass: CONTRACT_FAKE`, evidence class SIMULATED, a call log and
 * a hold point; reachable only from the testing subpath.
 */
import type { Sha256Hex } from "@kauro/contracts";
import type { Clock } from "@kauro/domain";
import { CONTRACT_FAKE, FAKE_EVIDENCE_CLASS, sha256Hex, type FakeCall } from "../../commerce/testing/labels.js";
import { PAYOUT_EVIDENCE_UNAVAILABLE } from "../bindings.js";
import type { PayoutEvidence, PayoutEvidenceAnswer, PayoutEvidenceStatus, PayoutEvidenceVerifier } from "../ports.js";
import { HoldPoints, type CommercialFakeHold } from "./holds.js";

export const PAYOUT_EVIDENCE_FAKE_PROVIDER = "contract-fake-payout-evidence" as const;

/** The stored payout intent a fake builds evidence for: the reference, the destination digest and the amount the platform sent. */
export interface PayoutIntentFacts {
  readonly reference: string;
  readonly destinationDigest: Sha256Hex;
  readonly amountCents: bigint;
  readonly currency: string;
}

/** The member a mismatching evidence differs in. */
export type PayoutMismatch = "REFERENCE" | "DESTINATION" | "AMOUNT";

export class ContractFakePayoutEvidence implements PayoutEvidenceVerifier {
  readonly provider = PAYOUT_EVIDENCE_FAKE_PROVIDER;
  readonly integrationClass = CONTRACT_FAKE;
  readonly evidenceClass = FAKE_EVIDENCE_CLASS;
  readonly contractFake = true as const;

  private readonly scripted = new Map<string, PayoutEvidence>();
  private readonly log: FakeCall[] = [];
  private readonly holds = new HoldPoints<"VERIFY">();

  constructor(private readonly options: { readonly clock: Clock }) {}

  /** The calls received so far, oldest first; a frozen copy. */
  get calls(): ReadonlyArray<FakeCall> {
    return Object.freeze([...this.log]);
  }

  /** The evidence a provider would report for the intent in the given status, observed now; its hash is a function of what it states. */
  matching(intent: PayoutIntentFacts, status: PayoutEvidenceStatus): PayoutEvidence {
    return this.evidenceOf(status, intent.reference, intent.destinationDigest, intent.amountCents, intent.currency);
  }

  /** The evidence of the given status that differs from the intent in exactly the named member. */
  mismatching(intent: PayoutIntentFacts, status: PayoutEvidenceStatus, member: PayoutMismatch): PayoutEvidence {
    const reference = member === "REFERENCE" ? `${intent.reference}-other` : intent.reference;
    const destinationDigest = member === "DESTINATION" ? sha256Hex(`other-destination|${intent.destinationDigest}`) : intent.destinationDigest;
    const amountCents = member === "AMOUNT" ? intent.amountCents + 1n : intent.amountCents;
    return this.evidenceOf(status, reference, destinationDigest, amountCents, intent.currency);
  }

  /** Scripts what `verify` answers for the stored evidence reference. */
  script(evidenceRef: string, evidence: PayoutEvidence): void {
    this.scripted.set(evidenceRef, evidence);
  }

  /** Stops the next `verify` after it was recorded, until the test releases it. */
  hold(operation: "VERIFY"): CommercialFakeHold {
    return this.holds.hold(operation);
  }

  async verify(request: { readonly evidenceRef: string }): Promise<PayoutEvidenceAnswer> {
    this.log.push(Object.freeze({ port: "PayoutEvidenceVerifier", operation: "VERIFY", identity: request.evidenceRef, at: this.options.clock.now(), sent: true }));
    await this.holds.arrive("VERIFY");
    const evidence = this.scripted.get(request.evidenceRef);
    return evidence === undefined ? { kind: "UNAVAILABLE", reason: PAYOUT_EVIDENCE_UNAVAILABLE } : { kind: "VERIFIED", evidence };
  }

  private evidenceOf(status: PayoutEvidenceStatus, reference: string, destinationDigest: Sha256Hex, amountCents: bigint, currency: string): PayoutEvidence {
    const observedAt = this.options.clock.now();
    return Object.freeze({
      status,
      reference,
      destinationDigest,
      amountCents,
      currency,
      observedAt,
      evidenceHash: sha256Hex(["payout-evidence", status, reference, destinationDigest, amountCents.toString(), currency, observedAt].join("|")),
    });
  }
}
