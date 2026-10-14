/**
 * CONTRACT FAKES — evidence class SIMULATED. The labelled fakes of package B12's OutreachSendPort (plan docs/design/B12-outreach-plan.md
 * A3, A9, §M, §W; lane K1), on the TEST-ONLY subpath of @kauro/application (architecture testOnlySubpaths): no composition root binds
 * them and nothing they produce is evidence of a provider integration (the live Gmail half is PART(B15/B19)).
 *
 * ContractFakeGmailSend models what the dispatcher's correctness depends on:
 * - it records every call with the exact MIME it received, the intent, the fence and the sender (credentials of a race cell come
 *   only from this record: tokenFromSentMime, rule 24b), and an ordered event log (submit, abort, answer) for event-order cells;
 * - a call can be HELD open (hold()) until the test releases it or the caller's AbortSignal fires; an abort while held is recorded
 *   before the call answers UNKNOWN(ABORTED) (GAP-DI-27: "admitted only after the fake recorded the abort");
 * - answers are scripted per intent (or for the next call): ACCEPTED (a provider message reference), REJECTED, WARNING (403/429),
 *   UNKNOWN, or LATE: the caller sees UNKNOWN(LOST_ANSWER) while the fake keeps the acceptance the provider made, which the test
 *   delivers later as late evidence (lateAnswerOf).
 * ContractFakeResend records every call to the transactional route; outreach must never reach it (R2-131: zero calls).
 */
import type { OutreachSendPort, OutreachSubmission, OutreachSubmitAnswer } from "../outreach/ports.js";
import { HoldPoints, type CommercialFakeHold } from "./holds.js";

export const GMAIL_SEND_FAKE_PROVIDER = "contract-fake-gmail-send";
export const RESEND_FAKE_PROVIDER = "contract-fake-resend";

export type FakeSendScript = OutreachSubmitAnswer | { readonly kind: "LATE"; readonly providerMessageRef: string };

export interface RecordedSend {
  readonly seq: number;
  readonly intentId: string;
  readonly fence: number;
  readonly senderId: string;
  readonly senderAddress: string;
  readonly mime: string;
  /** What the caller received; null while the call is open. */
  answer: OutreachSubmitAnswer | null;
  aborted: boolean;
  /** The provider's acceptance the caller never saw (a LATE script), delivered later as evidence. */
  lateAcceptedRef: string | null;
}

export type FakeSendEvent = { readonly kind: "submit" | "abort" | "answer"; readonly intentId: string; readonly seq: number };

abstract class RecordingSendFake implements OutreachSendPort {
  readonly label = "CONTRACT_FAKE" as const;
  readonly evidenceClass = "SIMULATED" as const;
  abstract readonly route: OutreachSendPort["route"];
  protected abstract readonly refPrefix: string;
  readonly calls: RecordedSend[] = [];
  readonly events: FakeSendEvent[] = [];
  private readonly holds = new HoldPoints<"submit">();
  private readonly byIntent = new Map<string, FakeSendScript[]>();
  private readonly next: FakeSendScript[] = [];

  /** Scripts the answer of the next call of `intentId` (or of the next call of any intent when intentId is null). */
  script(intentId: string | null, answer: FakeSendScript): void {
    if (intentId === null) this.next.push(answer);
    else this.byIntent.set(intentId, [...(this.byIntent.get(intentId) ?? []), answer]);
  }

  /** Holds the next call open after it is recorded, until release() or the caller's abort. */
  hold(): CommercialFakeHold {
    return this.holds.hold("submit");
  }

  callsOf(intentId: string): ReadonlyArray<RecordedSend> {
    return this.calls.filter((c) => c.intentId === intentId);
  }

  /** The MIME of the first call of `intentId`, or undefined when the provider never received it. */
  sentMime(intentId: string): string | undefined {
    return this.calls.find((c) => c.intentId === intentId)?.mime;
  }

  /** The acceptance a LATE call kept (the provider sent it; the caller saw a lost answer). */
  lateAnswerOf(intentId: string): string | undefined {
    return this.calls.find((c) => c.intentId === intentId && c.lateAcceptedRef !== null)?.lateAcceptedRef ?? undefined;
  }

  async submit(submission: OutreachSubmission, signal: AbortSignal): Promise<OutreachSubmitAnswer> {
    const seq = this.calls.length + 1;
    const call: RecordedSend = { seq, intentId: submission.intentId, fence: submission.fence, senderId: submission.senderId, senderAddress: submission.senderAddress, mime: submission.mime, answer: null, aborted: false, lateAcceptedRef: null };
    this.calls.push(call);
    this.events.push({ kind: "submit", intentId: call.intentId, seq });
    const scripted = this.byIntent.get(call.intentId)?.shift() ?? this.next.shift() ?? { kind: "ACCEPTED", providerMessageRef: `${this.refPrefix}-${call.intentId}-${seq}` };
    const abort = new Promise<"aborted">((resolve) => {
      if (signal.aborted) resolve("aborted");
      else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    const held = this.holds.arrive("submit").then(() => "released" as const);
    const how = await Promise.race([held, abort]);
    if (how === "aborted") {
      call.aborted = true;
      this.events.push({ kind: "abort", intentId: call.intentId, seq });
      return this.answer(call, { kind: "UNKNOWN", reason: "ABORTED" });
    }
    if (scripted.kind === "LATE") {
      call.lateAcceptedRef = scripted.providerMessageRef;
      return this.answer(call, { kind: "UNKNOWN", reason: "LOST_ANSWER" });
    }
    return this.answer(call, scripted);
  }

  private answer(call: RecordedSend, answer: OutreachSubmitAnswer): OutreachSubmitAnswer {
    call.answer = answer;
    this.events.push({ kind: "answer", intentId: call.intentId, seq: call.seq });
    return answer;
  }
}

export class ContractFakeGmailSend extends RecordingSendFake {
  readonly provider = GMAIL_SEND_FAKE_PROVIDER;
  readonly route = "GMAIL_API" as const;
  protected readonly refPrefix = "gmail-fake";
}

export class ContractFakeResend extends RecordingSendFake {
  readonly provider = RESEND_FAKE_PROVIDER;
  readonly route = "RESEND_TRANSACTIONAL" as const;
  protected readonly refPrefix = "resend-fake";
}
