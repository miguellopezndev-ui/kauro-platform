/**
 * Admission limiter (08 "Abuse controls": rate limiting combines IP, verified identity, agency and operation; the initial
 * anti-abuse design uses admission and measured limits). Decision D-CMD-1 / open question Q2: the structural half of the
 * CreateAgency limit (one DRAFT agency per creator) lives in the database; this limiter adds the measured half — a sliding
 * window per (operation, identity) and, when the transport supplies a hashed client address, per (operation, address).
 *
 * The window is process-local: it bounds a single API instance and is exact for it; a fleet-wide counter is an operations
 * package concern (the port stays the same). Memory is bounded: expired stamps are pruned on every decision and the subject
 * table is swept when it exceeds `maxTrackedSubjects`.
 */
import type { CommandId } from "@kauro/contracts";
import type { AbuseLimiter, Admission, AdmissionSubject } from "@kauro/application";

export interface AdmissionWindow {
  /** Admissions allowed per window; a request beyond it is CREATION_RATE_LIMITED with retryAfterSeconds. */
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface AdmissionLimits {
  readonly perIdentity: AdmissionWindow;
  readonly perAddress: AdmissionWindow;
  readonly maxTrackedSubjects: number;
}

/** Interim values (Q2): five agency creations per identity per hour, twenty per client address per hour. */
export const DEFAULT_ADMISSION_LIMITS: AdmissionLimits = Object.freeze({
  perIdentity: Object.freeze({ limit: 5, windowSeconds: 3600 }),
  perAddress: Object.freeze({ limit: 20, windowSeconds: 3600 }),
  maxTrackedSubjects: 100_000,
});

function assertWindow(w: AdmissionWindow, name: string): void {
  if (!Number.isInteger(w.limit) || w.limit < 1) throw new RangeError(`${name}.limit must be a positive integer`);
  if (!Number.isInteger(w.windowSeconds) || w.windowSeconds < 1) throw new RangeError(`${name}.windowSeconds must be a positive integer`);
}

export function createAdmissionLimiter(limits: AdmissionLimits = DEFAULT_ADMISSION_LIMITS): AbuseLimiter {
  assertWindow(limits.perIdentity, "perIdentity");
  assertWindow(limits.perAddress, "perAddress");
  if (!Number.isInteger(limits.maxTrackedSubjects) || limits.maxTrackedSubjects < 1) throw new RangeError("maxTrackedSubjects must be a positive integer");
  const stamps = new Map<string, number[]>();

  function prune(key: string, nowMs: number, windowMs: number): number[] {
    const list = (stamps.get(key) ?? []).filter((t) => nowMs - t < windowMs);
    if (list.length === 0) stamps.delete(key);
    else stamps.set(key, list);
    return list;
  }

  function sweep(nowMs: number): void {
    if (stamps.size <= limits.maxTrackedSubjects) return;
    const longest = Math.max(limits.perIdentity.windowSeconds, limits.perAddress.windowSeconds) * 1000;
    for (const [key, list] of stamps) {
      if (list.every((t) => nowMs - t >= longest)) stamps.delete(key);
    }
    // still above the bound: the oldest subjects go first (insertion order of the Map)
    while (stamps.size > limits.maxTrackedSubjects) {
      const first = stamps.keys().next();
      if (first.done) break;
      stamps.delete(first.value);
    }
  }

  function check(key: string, w: AdmissionWindow, nowMs: number): number | null {
    const list = prune(key, nowMs, w.windowSeconds * 1000);
    if (list.length < w.limit) return null;
    const oldest = list[0] as number;
    return Math.max(1, Math.ceil((oldest + w.windowSeconds * 1000 - nowMs) / 1000));
  }

  return {
    async admit(operation: CommandId, subject: AdmissionSubject, now): Promise<Admission> {
      const nowMs = Date.parse(now);
      if (!Number.isFinite(nowMs)) throw new RangeError("now must be a UTC instant");
      sweep(nowMs);
      const identityKey = `${operation}|identity|${subject.userId}`;
      const addressKey = subject.clientAddressHash !== undefined ? `${operation}|address|${subject.clientAddressHash}` : null;
      const identityWait = check(identityKey, limits.perIdentity, nowMs);
      if (identityWait !== null) return { kind: "LIMITED", reason: "CREATION_RATE_LIMITED", retryAfterSeconds: identityWait };
      const addressWait = addressKey === null ? null : check(addressKey, limits.perAddress, nowMs);
      if (addressWait !== null) return { kind: "LIMITED", reason: "CREATION_RATE_LIMITED", retryAfterSeconds: addressWait };
      stamps.set(identityKey, [...(stamps.get(identityKey) ?? []), nowMs]);
      if (addressKey !== null) stamps.set(addressKey, [...(stamps.get(addressKey) ?? []), nowMs]);
      return { kind: "ADMITTED" };
    },
  };
}
