/**
 * Order 27A: refund execution through a generic, simulated refund rail, with the never-resend rule (O27A spec: "No refund POST when the
 * status is uncertain, only GET/reconcile and manual resolution"; Refund machine SUBMITTING -> UNCERTAIN "No blind duplicate; reconcile
 * by provider refund identity"; DV1-08 NEVER-RESEND fence).
 *
 * `nextRefundStep` is the only place that may answer SUBMIT, and it does so exactly once per refund: in APPROVED with no attempt ever
 * declared. SUBMITTING and UNCERTAIN only reconcile by GET; NOT_FOUND is never proof of no effect here (the owner's manual resolution,
 * with its own predicates, is the only way out without a found refund). `driveRefund` runs the loop against a `RefundRail` and the
 * simulator proves the POST count. No real provider exists in this order; money never moves.
 */
import { canonicalBytes, rawDigest, type Sha256Hex } from "@kauro/contracts";
import { assertMoney } from "./money.js";

export type RefundExecutionState = "APPROVED" | "SUBMITTING" | "UNCERTAIN" | "COMPLETED" | "FAILED" | "MANUAL_RESOLUTION";

export type RefundStep = { readonly kind: "SUBMIT"; readonly idempotencyKey: Sha256Hex } | { readonly kind: "RECONCILE_GET" } | { readonly kind: "MANUAL_RESOLUTION" } | { readonly kind: "NONE" };

export interface RefundExecution {
  readonly refundId: string;
  readonly amountCents: bigint;
  readonly currency: "USD";
  readonly state: RefundExecutionState;
  /** True once any POST was ever declared for this refund (whatever came back). */
  readonly attemptDeclared: boolean;
  /** GET reconciliations made while SUBMITTING or UNCERTAIN. */
  readonly reconciliations: number;
}

/** After this many unresolved GETs the refund goes to the owner's manual resolution (never to a new POST). */
export const MAX_RECONCILIATIONS_BEFORE_MANUAL = 3;
export const REFUND_IDEMPOTENCY_DOMAIN = "KAURO_REFUND_RAIL_IDEMPOTENCY_V1";

export function refundIdempotencyKey(refundId: string): Sha256Hex {
  return rawDigest(canonicalBytes({ domain: REFUND_IDEMPOTENCY_DOMAIN, version: 1, payload: { refundId } }));
}

export function nextRefundStep(r: RefundExecution): RefundStep {
  switch (r.state) {
    case "APPROVED":
      return r.attemptDeclared ? { kind: "MANUAL_RESOLUTION" } : { kind: "SUBMIT", idempotencyKey: refundIdempotencyKey(r.refundId) };
    case "SUBMITTING":
    case "UNCERTAIN":
      return r.reconciliations >= MAX_RECONCILIATIONS_BEFORE_MANUAL ? { kind: "MANUAL_RESOLUTION" } : { kind: "RECONCILE_GET" };
    case "MANUAL_RESOLUTION":
    case "COMPLETED":
    case "FAILED":
      return { kind: "NONE" };
  }
}

/** What the rail answers. TIMEOUT and an unreadable answer are ambiguous: the refund may or may not exist at the provider. */
export type RailSubmitResult = { readonly kind: "ACCEPTED_COMPLETED"; readonly providerRef: string } | { readonly kind: "REFUSED"; readonly code: string } | { readonly kind: "AMBIGUOUS" };
export type RailLookup = { readonly kind: "FOUND_COMPLETED"; readonly providerRef: string; readonly amountCents: bigint; readonly currency: string } | { readonly kind: "FOUND_REFUSED"; readonly code: string } | { readonly kind: "NOT_FOUND" };

export interface RefundRail {
  submit(idempotencyKey: Sha256Hex, amountCents: bigint, currency: "USD"): Promise<RailSubmitResult>;
  lookup(idempotencyKey: Sha256Hex): Promise<RailLookup>;
}

/** Applies one step's result to the execution (pure). A found refund of another amount or currency is a manual case, never completion. */
export function afterSubmit(r: RefundExecution, result: RailSubmitResult): RefundExecution {
  if (r.state !== "APPROVED" || r.attemptDeclared) throw new Error("a refund is submitted once, from APPROVED");
  const declared = { ...r, attemptDeclared: true };
  switch (result.kind) {
    case "ACCEPTED_COMPLETED":
      return { ...declared, state: "COMPLETED" };
    case "REFUSED":
      return { ...declared, state: "FAILED" };
    case "AMBIGUOUS":
      return { ...declared, state: "UNCERTAIN" };
  }
}

export function afterLookup(r: RefundExecution, result: RailLookup): RefundExecution {
  if (r.state !== "SUBMITTING" && r.state !== "UNCERTAIN") throw new Error("only a SUBMITTING or UNCERTAIN refund is reconciled");
  const counted = { ...r, reconciliations: r.reconciliations + 1 };
  switch (result.kind) {
    case "FOUND_COMPLETED":
      if (result.currency !== r.currency || assertMoney(result.amountCents) !== r.amountCents) return { ...counted, state: "MANUAL_RESOLUTION" };
      return { ...counted, state: "COMPLETED" };
    case "FOUND_REFUSED":
      return { ...counted, state: "FAILED" };
    case "NOT_FOUND":
      return { ...counted, state: counted.reconciliations >= MAX_RECONCILIATIONS_BEFORE_MANUAL ? "MANUAL_RESOLUTION" : "UNCERTAIN" };
  }
}

/** Runs steps until nothing automatic is left. Returns the final execution; the rail sees at most one submit. */
export async function driveRefund(start: RefundExecution, rail: RefundRail, maxSteps = 10): Promise<RefundExecution> {
  let r = start;
  for (let i = 0; i < maxSteps; i += 1) {
    const step = nextRefundStep(r);
    if (step.kind === "SUBMIT") r = afterSubmit(r, await rail.submit(step.idempotencyKey, r.amountCents, r.currency));
    else if (step.kind === "RECONCILE_GET") r = afterLookup(r, await rail.lookup(refundIdempotencyKey(r.refundId)));
    else if (step.kind === "MANUAL_RESOLUTION") return { ...r, state: "MANUAL_RESOLUTION" };
    else return r;
  }
  return r;
}

/**
 * The simulated refund rail. A scenario decides what the provider did and what it answers; the simulator counts POSTs and GETs per
 * idempotency key and moves no money (spentCents stays 0: the simulator has no funds).
 */
export class SimulatedRefundRail implements RefundRail {
  readonly spentCents = 0n;
  readonly posts = new Map<string, number>();
  readonly gets = new Map<string, number>();
  private readonly executed = new Map<string, { amountCents: bigint }>();
  constructor(
    private readonly scenario: {
      /** What the provider actually does with a submit. */
      readonly effect: "EXECUTES" | "REFUSES" | "DROPS";
      /** What the caller sees from the submit. */
      readonly answer: "TRUTHFUL" | "TIMEOUT";
      /** Lookups that answer NOT_FOUND before the provider shows an executed refund (provider lag). */
      readonly lagLookups?: number;
    },
  ) {}

  async submit(key: Sha256Hex, amountCents: bigint): Promise<RailSubmitResult> {
    this.posts.set(key, (this.posts.get(key) ?? 0) + 1);
    if (this.scenario.effect === "EXECUTES" && !this.executed.has(key)) this.executed.set(key, { amountCents });
    if (this.scenario.answer === "TIMEOUT") return { kind: "AMBIGUOUS" };
    if (this.scenario.effect === "EXECUTES") return { kind: "ACCEPTED_COMPLETED", providerRef: `sim-${key.slice(0, 12)}` };
    if (this.scenario.effect === "REFUSES") return { kind: "REFUSED", code: "SIM_REFUSED" };
    return { kind: "AMBIGUOUS" };
  }

  async lookup(key: Sha256Hex): Promise<RailLookup> {
    const n = (this.gets.get(key) ?? 0) + 1;
    this.gets.set(key, n);
    if (n <= (this.scenario.lagLookups ?? 0)) return { kind: "NOT_FOUND" };
    const done = this.executed.get(key);
    if (done !== undefined) return { kind: "FOUND_COMPLETED", providerRef: `sim-${key.slice(0, 12)}`, amountCents: done.amountCents, currency: "USD" };
    if (this.scenario.effect === "REFUSES" && (this.posts.get(key) ?? 0) > 0) return { kind: "FOUND_REFUSED", code: "SIM_REFUSED" };
    return { kind: "NOT_FOUND" };
  }

  totalPosts(): number {
    let n = 0;
    for (const v of this.posts.values()) n += v;
    return n;
  }
}
