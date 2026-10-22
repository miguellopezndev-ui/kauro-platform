// The figures screens and documents state, computed from a world, never typed: a seller's money (both figures the owner asked for: net
// attributable revenue and commission generated, pending and paid, with the retainer and offsets kept apart), Kauro's money (revenue is
// the service collected net of refunds; tax is collected for the state and never revenue; an order waiting for a transfer is not money),
// and the alerts due now under the owner's rules of 2026-10-21. Pure functions: the same world gives the same figures everywhere.
import { bogotaDay, daysBetween, dayPlus, ms } from "./calendar.ts";
import { ALERT_RULES } from "./policy.ts";
import type { World } from "./types.ts";

const sum = (values: readonly number[]): number => values.reduce((total, one) => total + one, 0);

export interface SellerFigures {
  /** What the seller's acquired customers paid for the service, after discount, net of refunds, without tax; each collection once. */
  readonly netAttributableRevenueMinor: number;
  /** Commission on that revenue: lines less offsets. The retainer is not commission. */
  readonly commissionGeneratedMinor: number;
  readonly commissionPendingMinor: number;
  readonly commissionPaidMinor: number;
  /** Part of pending held by an open question (a defect report). */
  readonly commissionHeldMinor: number;
  /** Offsets not yet applied against payable commission. */
  readonly offsetBalanceMinor: number;
  readonly retainerPaidMinor: number;
  readonly retainerPendingMinor: number;
  readonly payoutsConfirmedMinor: number;
}

export function sellerFigures(world: World, sellerId: string): SellerFigures {
  const lines = world.commissionLines.filter((one) => one.sellerId === sellerId);
  const offsets = world.offsets.filter((one) => one.sellerId === sellerId);
  const paidStatement = (id: string | null): boolean => id !== null && world.statements.some((one) => one.id === id && one.state === "PAID");
  const payments = lines.map((line) => world.payments.find((one) => one.id === line.paymentId));
  const refundedService = (paymentId: string): number => sum(world.refunds.filter((one) => one.paymentId === paymentId).map((one) => one.serviceMinor));
  const retainers = world.retainerLines.filter((one) => one.sellerId === sellerId);
  return {
    netAttributableRevenueMinor: sum(payments.map((one) => (one === undefined ? 0 : one.serviceMinor - refundedService(one.id)))),
    commissionGeneratedMinor: sum(lines.map((one) => one.amountMinor)) - sum(offsets.map((one) => one.basisMinor)),
    commissionPaidMinor: sum(lines.filter((one) => paidStatement(one.statementId)).map((one) => one.amountMinor)) - sum(offsets.filter((one) => paidStatement(one.statementId)).map((one) => one.appliedMinor)),
    // computed on its own (not as generated less paid), so that "pending + paid = generated" is a real check
    commissionPendingMinor:
      sum(lines.filter((one) => !paidStatement(one.statementId)).map((one) => one.amountMinor)) -
      sum(offsets.filter((one) => !paidStatement(one.statementId)).map((one) => one.basisMinor)) -
      sum(offsets.filter((one) => paidStatement(one.statementId)).map((one) => one.basisMinor - one.appliedMinor)),
    commissionHeldMinor: sum(lines.filter((one) => one.state === "HELD").map((one) => one.amountMinor)),
    offsetBalanceMinor: sum(offsets.map((one) => one.balanceMinor)),
    retainerPaidMinor: sum(retainers.filter((one) => paidStatement(one.statementId)).map((one) => one.amountMinor)),
    retainerPendingMinor: sum(retainers.filter((one) => !paidStatement(one.statementId)).map((one) => one.amountMinor)),
    payoutsConfirmedMinor: sum(world.payouts.filter((one) => one.sellerId === sellerId && one.confirmedOn !== null).map((one) => one.amountMinor)),
  };
}

export interface KauroFigures {
  /** Money received, tax included (cash, not revenue). */
  readonly receivedMinor: number;
  /** The service collected net of refunds: Kauro's revenue. Never includes tax. */
  readonly revenueMinor: number;
  /** Tax collected net of tax refunded: owed to the state, never revenue. */
  readonly taxMinor: number;
  readonly refundedMinor: number;
  /** Orders waiting for a transfer (held or not): not money until a payment is confirmed. */
  readonly awaitingMinor: number;
  /** Seller commission and retainer not yet paid. */
  readonly owedToSellersMinor: number;
}

export function kauroFigures(world: World): KauroFigures {
  const refundsService = sum(world.refunds.map((one) => one.serviceMinor));
  const refundsTax = sum(world.refunds.map((one) => one.taxMinor));
  const sellers = world.sellers.map((one) => sellerFigures(world, one.id));
  return {
    receivedMinor: sum(world.payments.map((one) => one.amountMinor)),
    revenueMinor: sum(world.payments.map((one) => one.serviceMinor)) - refundsService,
    taxMinor: sum(world.payments.map((one) => one.taxMinor)) - refundsTax,
    refundedMinor: refundsService + refundsTax,
    awaitingMinor: sum(world.orders.filter((one) => one.state === "AWAITING_TRANSFER" || one.state === "HELD_PENDING_TRANSFER").map((one) => one.amountMinor)),
    owedToSellersMinor: sum(sellers.map((one) => one.commissionPendingMinor + one.retainerPendingMinor)),
  };
}

export interface Alert {
  readonly kind: "INACTIVITY" | "DEADLINE" | "BLOCKED" | "CLAIM_ENDING" | "PILOT_REVIEW";
  readonly subjectId: string;
  /** The date the alert is about (the deadline, the claim's end, the last progress). */
  readonly about: string;
  /** For CLAIM_ENDING, the warning reached (14 or 3 days before the end). */
  readonly threshold: number | null;
}

/**
 * The alerts due at the world's "now" (owner, 2026-10-21): inactivity after 14 days without relevant progress; a deadline 2 days before
 * it, or at once once passed; blocked work; a claim 14 and 3 days before its end (only the nearer warning shows, never both); a pilot's
 * review 14 days before it ends. An unfinished upload's 24 hours are the operator's own session and raise no alert.
 */
export function computeAlerts(world: World): readonly Alert[] {
  const today = bogotaDay(world.asOf);
  const now = ms(world.asOf);
  const window = ALERT_RULES.deadlineDaysBefore * 86_400_000;
  const alerts: Alert[] = [];
  for (const seller of world.sellers) {
    if (seller.state === "ACTIVE" && seller.lastProgressOn !== null && daysBetween(seller.lastProgressOn, today) >= ALERT_RULES.inactivityDays) alerts.push({ kind: "INACTIVITY", subjectId: seller.id, about: seller.lastProgressOn, threshold: null });
    if (seller.state === "ACTIVE" && seller.pilot !== null && today >= dayPlus(seller.pilot.to, -ALERT_RULES.pilotReviewDaysBefore) && today <= seller.pilot.to) alerts.push({ kind: "PILOT_REVIEW", subjectId: seller.id, about: seller.pilot.to, threshold: null });
  }
  for (const project of world.projects) {
    const matters = project.matters;
    if (matters !== null && matters.ends !== "UPLOAD" && ms(matters.at) - now <= window) alerts.push({ kind: "DEADLINE", subjectId: project.id, about: matters.at, threshold: null });
    const workspace = world.workspaces.find((one) => one.id === project.workspaceId);
    if (workspace?.state === "RESTRICTED" && (project.step === "QUOTE" || project.step === "PAYMENT")) alerts.push({ kind: "BLOCKED", subjectId: project.id, about: project.dates.lastProgressAt, threshold: null });
  }
  for (const order of world.orders) {
    if (order.state === "AWAITING_TRANSFER" && ms(order.sendBy) - now <= window) alerts.push({ kind: "DEADLINE", subjectId: order.id, about: order.sendBy, threshold: null });
  }
  const [far, near] = [...ALERT_RULES.claimWarningDays].sort((a, b) => b - a) as [number, number];
  for (const claim of world.claims) {
    if (claim.state !== "ACCEPTED" || claim.endsOn === null) continue;
    const left = daysBetween(today, claim.endsOn);
    if (left < 0 || left > far) continue;
    alerts.push({ kind: "CLAIM_ENDING", subjectId: claim.id, about: claim.endsOn, threshold: left <= near ? near : far });
  }
  return alerts.sort((a, b) => a.kind.localeCompare(b.kind) || a.about.localeCompare(b.about) || a.subjectId.localeCompare(b.subjectId));
}
