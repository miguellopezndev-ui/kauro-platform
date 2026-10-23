/**
 * Internal alerts (CP-01.06, CP-01.07; candidate contracts Alert, AlertCondition, SellerAlertView of CP-02.11). Pure: the caller gives
 * the subjects and their facts, the clock instant, and receives one alert per subject under its most urgent kind (BLOCKED >
 * DEADLINE_PASSED > DEADLINE_SOON > INACTIVE), with every other condition of the same subject on that alert's second line, never as a
 * second alert. Inactivity counts only from the material acts of alerts.relevantProgress; the excluded acts never reset it, and nothing
 * here moves a retention, legal or quote date. Alerts are internal: they promise nothing to anyone.
 */
import { canonicalBytes, rawDigest } from "@kauro/contracts";
import { ALERTS_POLICY, ALERTS_POLICY_VERSION, type AlertKind } from "./policy.js";

const DAY_MS = 86_400_000;

export const RELEVANT_PROGRESS_COUNTS = Object.freeze([
  "NEW_SEALED_REVISION",
  "CHECK_CONCLUDED",
  "PLAN_DECISION_EFFECTIVE",
  "APPROVAL_GIVEN",
  "QUOTE_ISSUED",
  "PAYMENT_RECONCILED",
  "PREPARATION_COMPLETED",
  "DELIVERY_MADE",
  "IMPORT_RECORDED",
] as const);

export const RELEVANT_PROGRESS_NEVER_COUNTS = Object.freeze([
  "READ",
  "DOWNLOAD",
  "SIGN_IN",
  "REMINDER_OR_NOTIFICATION",
  "ORDINARY_SUPPORT_MESSAGE",
  "COMMAND_WITHOUT_MATERIAL_EFFECT",
  "FAILED_ATTEMPT_OR_RETRY",
  "REPEATED_ACTION_WITHOUT_STATE_CHANGE",
] as const);

export interface ProjectAct {
  readonly kind: string;
  readonly at: string;
  /** False for an act that changed no state (a replay, a failed attempt): it never counts, whatever its kind. */
  readonly changedState: boolean;
}

/** The latest material act, or null: only the nine counted kinds that changed state count; any other act is ignored. */
export function lastMaterialProgressAt(acts: ReadonlyArray<ProjectAct>): string | null {
  let latest: string | null = null;
  for (const a of acts) {
    if (!a.changedState || !(RELEVANT_PROGRESS_COUNTS as ReadonlyArray<string>).includes(a.kind)) continue;
    if (latest === null || Date.parse(a.at) > Date.parse(latest)) latest = a.at;
  }
  return latest;
}

export interface AlertCondition {
  readonly kind: AlertKind;
  readonly conditionCode: string;
  readonly dueAt?: string;
  readonly since: string;
  /** The threshold crossed (days before dueAt) for a DEADLINE_SOON; part of the key so the 3-day alert is not swallowed by the 14-day one. */
  readonly leadDays?: number;
}

export type AlertSubject =
  | { readonly subjectKind: "PROJECT"; readonly subjectId: string; readonly agencyId: string; readonly blockedSince: string | null; readonly blockedCode?: string; readonly deadlines: ReadonlyArray<{ readonly conditionCode: string; readonly dueAt: string }>; readonly acts: ReadonlyArray<ProjectAct>; readonly openedAt: string }
  | { readonly subjectKind: "CLAIM"; readonly subjectId: string; readonly sellerId: string; readonly endsAt: string }
  | { readonly subjectKind: "PILOT_REVIEW"; readonly subjectId: string; readonly endsAt: string };

export interface Alert {
  readonly alertKey: string;
  readonly subjectKind: AlertSubject["subjectKind"];
  readonly subjectId: string;
  readonly agencyId?: string;
  readonly sellerId?: string;
  readonly kind: AlertKind;
  readonly conditionCode: string;
  readonly dueAt?: string;
  readonly since: string;
  readonly lastMaterialProgressAt?: string;
  readonly otherConditions: ReadonlyArray<{ readonly kind: AlertKind; readonly conditionCode: string; readonly dueAt?: string }>;
  readonly policyVersion: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The deadline conditions of one date: passed at once, or soon from the latest lead threshold crossed. */
function deadline(conditionCode: string, dueAt: string, leads: ReadonlyArray<number>, now: number): AlertCondition | null {
  const due = Date.parse(dueAt);
  if (now >= due) return { kind: "DEADLINE_PASSED", conditionCode, dueAt, since: dueAt };
  const crossed = [...leads].sort((a, b) => a - b).find((d) => now >= due - d * DAY_MS);
  if (crossed === undefined) return null;
  return { kind: "DEADLINE_SOON", conditionCode, dueAt, since: iso(due - crossed * DAY_MS), leadDays: crossed };
}

function conditionsOf(s: AlertSubject, now: number): { readonly conditions: AlertCondition[]; readonly lastProgress?: string } {
  const out: AlertCondition[] = [];
  switch (s.subjectKind) {
    case "PROJECT": {
      if (s.blockedSince !== null) out.push({ kind: "BLOCKED", conditionCode: s.blockedCode ?? "BLOCKED", since: s.blockedSince });
      for (const d of s.deadlines) {
        const c = deadline(d.conditionCode, d.dueAt, [ALERTS_POLICY.deadlineLeadDays], now);
        if (c !== null) out.push(c);
      }
      const last = lastMaterialProgressAt(s.acts) ?? s.openedAt;
      const idleFrom = Date.parse(last) + ALERTS_POLICY.inactivityDays * DAY_MS;
      if (now >= idleFrom) out.push({ kind: "INACTIVE", conditionCode: "NO_MATERIAL_PROGRESS", since: iso(idleFrom) });
      return { conditions: out, lastProgress: last };
    }
    case "CLAIM": {
      const c = deadline("CLAIM_END", s.endsAt, ALERTS_POLICY.claimEndAlertDays, now);
      if (c !== null) out.push(c);
      return { conditions: out };
    }
    case "PILOT_REVIEW": {
      const c = deadline("PILOT_REVIEW", s.endsAt, [ALERTS_POLICY.pilotReviewLeadDays], now);
      if (c !== null) out.push(c);
      return { conditions: out };
    }
  }
}

const RANK: Readonly<Record<AlertKind, number>> = Object.freeze(Object.fromEntries(ALERTS_POLICY.precedence.map((k, i) => [k, i])) as Record<AlertKind, number>);

/** The deterministic key of a subject's alert: subject, kind, condition and the threshold crossed. */
export function alertKeyOf(subjectKind: string, subjectId: string, c: AlertCondition): string {
  return rawDigest(canonicalBytes({ domain: "KAURO_ALERT_KEY_V1", subjectKind, subjectId, kind: c.kind, conditionCode: c.conditionCode, dueAt: c.dueAt ?? null, leadDays: c.leadDays ?? null }));
}

/** One alert per subject with any condition, most urgent first (then by since, then subject id): CP-01.06's "one alert per fact". */
export function alertsAt(subjects: ReadonlyArray<AlertSubject>, nowIso: string): ReadonlyArray<Alert> {
  const now = Date.parse(nowIso);
  const seen = new Set<string>();
  const alerts: Alert[] = [];
  for (const s of subjects) {
    const subjectKey = `${s.subjectKind}:${s.subjectId}`;
    if (seen.has(subjectKey)) throw new RangeError(`subject ${subjectKey} is given twice`);
    seen.add(subjectKey);
    const { conditions, lastProgress } = conditionsOf(s, now);
    if (conditions.length === 0) continue;
    const ordered = [...conditions].sort((a, b) => RANK[a.kind] - RANK[b.kind] || Date.parse(a.dueAt ?? a.since) - Date.parse(b.dueAt ?? b.since) || (a.conditionCode < b.conditionCode ? -1 : 1));
    const main = ordered[0] as AlertCondition;
    alerts.push({
      alertKey: alertKeyOf(s.subjectKind, s.subjectId, main),
      subjectKind: s.subjectKind,
      subjectId: s.subjectId,
      ...(s.subjectKind === "PROJECT" ? { agencyId: s.agencyId } : {}),
      ...(s.subjectKind === "CLAIM" ? { sellerId: s.sellerId } : {}),
      kind: main.kind,
      conditionCode: main.conditionCode,
      ...(main.dueAt === undefined ? {} : { dueAt: main.dueAt }),
      since: main.since,
      ...(main.kind === "INACTIVE" && lastProgress !== undefined ? { lastMaterialProgressAt: lastProgress } : {}),
      otherConditions: ordered.slice(1).map((c) => ({ kind: c.kind, conditionCode: c.conditionCode, ...(c.dueAt === undefined ? {} : { dueAt: c.dueAt }) })),
      policyVersion: ALERTS_POLICY_VERSION,
    });
  }
  return alerts.sort((a, b) => RANK[a.kind] - RANK[b.kind] || Date.parse(b.since) - Date.parse(a.since) || (a.subjectId < b.subjectId ? -1 : 1));
}

/** The seller's view (SellerAlertView): only the seller's own claim alerts, without agency or any other subject. */
export interface SellerAlertView {
  readonly alertKey: string;
  readonly subjectKind: "CLAIM";
  readonly claimId: string;
  readonly kind: "DEADLINE_PASSED" | "DEADLINE_SOON";
  readonly conditionCode: string;
  readonly dueAt: string;
  readonly since: string;
  readonly policyVersion: string;
}

export function sellerAlertsOf(alerts: ReadonlyArray<Alert>, sellerId: string): ReadonlyArray<SellerAlertView> {
  const out: SellerAlertView[] = [];
  for (const a of alerts) {
    if (a.subjectKind !== "CLAIM" || a.sellerId !== sellerId) continue;
    if ((a.kind !== "DEADLINE_PASSED" && a.kind !== "DEADLINE_SOON") || a.dueAt === undefined) continue;
    out.push({ alertKey: a.alertKey, subjectKind: "CLAIM", claimId: a.subjectId, kind: a.kind, conditionCode: a.conditionCode, dueAt: a.dueAt, since: a.since, policyVersion: a.policyVersion });
  }
  return out;
}
