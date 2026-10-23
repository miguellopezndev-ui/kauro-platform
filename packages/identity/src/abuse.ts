/**
 * Abuse limits of the identity flows (O23A; 08 "Abuse controls"; OWASP ASVS 4.0.3 V2.2.1 anti-automation, NIST SP 800-63B §5.2.2
 * rate limiting). Every attempt is counted twice, per account and per network, in fixed windows; a key past its limit is refused
 * with a retry-after, and repeated lock-outs of the same account key double the wait up to a ceiling. A success clears the account
 * key's failures (never the network key's: one address trying many accounts stays limited).
 *
 * Keys are digests the caller computes (the account's user id or the SHA-256 of a normalised e-mail, the SHA-256 of the client
 * address): this module never sees an e-mail, an address or a credential. The store is a port; the in-memory one is bounded.
 */
import type { Clock } from "@kauro/domain";

export type AbuseAction = "SIGN_IN" | "MFA_CODE" | "STEP_UP" | "RECOVERY_CODE" | "EMAIL_CHALLENGE_SEND" | "EMAIL_CHALLENGE_CONFIRM" | "PASSWORD_SCREEN";

export interface AbuseLimit {
  /** Failures (or, for a send, attempts) admitted per window and key. */
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface AbusePolicy {
  readonly perAccount: AbuseLimit;
  readonly perNetwork: AbuseLimit;
  /** The account key's wait doubles on each further lock-out, up to this. */
  readonly maxLockoutSeconds: number;
}

/** The default limits (no policy registry carries them; ASVS L2 orders of magnitude, recorded in the O23A report). */
export const DEFAULT_ABUSE_POLICIES: Readonly<Record<AbuseAction, AbusePolicy>> = Object.freeze({
  SIGN_IN: { perAccount: { limit: 5, windowSeconds: 900 }, perNetwork: { limit: 50, windowSeconds: 900 }, maxLockoutSeconds: 86_400 },
  MFA_CODE: { perAccount: { limit: 5, windowSeconds: 300 }, perNetwork: { limit: 30, windowSeconds: 300 }, maxLockoutSeconds: 86_400 },
  STEP_UP: { perAccount: { limit: 5, windowSeconds: 300 }, perNetwork: { limit: 30, windowSeconds: 300 }, maxLockoutSeconds: 3_600 },
  RECOVERY_CODE: { perAccount: { limit: 3, windowSeconds: 3_600 }, perNetwork: { limit: 10, windowSeconds: 3_600 }, maxLockoutSeconds: 86_400 },
  EMAIL_CHALLENGE_SEND: { perAccount: { limit: 3, windowSeconds: 3_600 }, perNetwork: { limit: 20, windowSeconds: 3_600 }, maxLockoutSeconds: 86_400 },
  EMAIL_CHALLENGE_CONFIRM: { perAccount: { limit: 5, windowSeconds: 900 }, perNetwork: { limit: 30, windowSeconds: 900 }, maxLockoutSeconds: 86_400 },
  PASSWORD_SCREEN: { perAccount: { limit: 30, windowSeconds: 60 }, perNetwork: { limit: 60, windowSeconds: 60 }, maxLockoutSeconds: 600 },
});

export interface AbuseKeys {
  /** A digest naming the account (user id, or SHA-256 of the normalised e-mail before sign-in). */
  readonly account: string;
  /** SHA-256 of the client address, when the transport supplies it. */
  readonly network: string | null;
}

export type AbuseDecision = { readonly kind: "ALLOWED" } | { readonly kind: "LIMITED"; readonly retryAfterSeconds: number };

/**
 * One admitted attempt, reserved against the limit when it was admitted. Exactly one of its three ends is taken: `fail` counts it as a
 * failure (or, for a send, as the attempt it is), `succeed` clears the account key's failures, `release` gives the place back without
 * counting (the attempt never reached the secret). A second call is ignored.
 */
export interface AbuseAttempt {
  fail(): AbuseDecision;
  succeed(): void;
  release(): void;
}

export type AbuseAdmission = { readonly kind: "ADMITTED"; readonly attempt: AbuseAttempt } | { readonly kind: "LIMITED"; readonly retryAfterSeconds: number };

export interface AbuseCounter {
  windowStartMs: number;
  count: number;
  lockedUntilMs: number;
  lockouts: number;
}

/** The counters' store (the in-memory one here; a shared one is the deployment's, O23B). */
export interface AbuseCounterStore {
  get(key: string): AbuseCounter | undefined;
  set(key: string, counter: AbuseCounter): void;
  delete(key: string): void;
}

export function inMemoryAbuseCounters(maxKeys = 100_000): AbuseCounterStore {
  const map = new Map<string, AbuseCounter>();
  return {
    get: (key) => map.get(key),
    set(key, counter) {
      map.delete(key);
      map.set(key, counter);
      // bounded memory: the least recently written key goes first
      while (map.size > maxKeys) map.delete(map.keys().next().value as string);
    },
    delete: (key) => void map.delete(key),
  };
}

export interface AbuseLimiter {
  /**
   * Decides and reserves in one synchronous step (O23A review M1): an attempt is admitted only while the failures counted in the
   * window plus the attempts still in flight are under the limit, and the admitted one holds its place until it ends. So N parallel
   * attempts against a limit L admit at most L, where `check` then `fail` admitted all N. Atomic within one process; a store shared by
   * several processes needs an atomic increment of its own (O23B).
   */
  attempt(action: AbuseAction, keys: AbuseKeys): AbuseAdmission;
  /** Whether an attempt may proceed now (it consumes nothing). */
  check(action: AbuseAction, keys: AbuseKeys): AbuseDecision;
  /** Counts a failure (or, for a send, an attempt); answers whether the next attempt would be limited. */
  fail(action: AbuseAction, keys: AbuseKeys): AbuseDecision;
  /** A success: the account key's failures are cleared; its lock-out history stays. */
  succeed(action: AbuseAction, keys: AbuseKeys): void;
}

export function createAbuseLimiter(clock: Clock, store: AbuseCounterStore = inMemoryAbuseCounters(), policies: Readonly<Record<AbuseAction, AbusePolicy>> = DEFAULT_ABUSE_POLICIES): AbuseLimiter {
  const keyOf = (action: AbuseAction, scope: "a" | "n", key: string) => `${action}:${scope}:${key}`;

  // attempts admitted by `attempt` and not yet ended, per counter key; they count against the limit as if they had failed
  const inFlight = new Map<string, number>();
  const pendingOf = (key: string): number => inFlight.get(key) ?? 0;
  const hold = (key: string, delta: number): void => {
    const next = pendingOf(key) + delta;
    if (next <= 0) inFlight.delete(key);
    else inFlight.set(key, next);
  };

  const judge = (key: string, limit: AbuseLimit, nowMs: number): number => {
    const c = store.get(key);
    const pending = pendingOf(key);
    if (c !== undefined && nowMs < c.lockedUntilMs) return Math.ceil((c.lockedUntilMs - nowMs) / 1000);
    const current = c !== undefined && nowMs - c.windowStartMs < limit.windowSeconds * 1000;
    if ((current ? (c as AbuseCounter).count : 0) + pending < limit.limit) return 0;
    // the window's own end, or, when the places are held by attempts still in flight, a second: they end shortly
    return current ? Math.max(1, Math.ceil(((c as AbuseCounter).windowStartMs + limit.windowSeconds * 1000 - nowMs) / 1000)) : 1;
  };

  const count = (key: string, limit: AbuseLimit, maxLockoutSeconds: number | null, nowMs: number): void => {
    const prior = store.get(key);
    const c: AbuseCounter = prior === undefined ? { windowStartMs: nowMs, count: 0, lockedUntilMs: 0, lockouts: 0 } : { ...prior };
    if (nowMs - c.windowStartMs >= limit.windowSeconds * 1000) {
      c.windowStartMs = nowMs;
      c.count = 0;
    }
    c.count += 1;
    if (c.count >= limit.limit && maxLockoutSeconds !== null) {
      // the first lock-out lasts the window; each further one doubles, to the ceiling
      const wait = Math.min(limit.windowSeconds * 2 ** c.lockouts, maxLockoutSeconds);
      c.lockedUntilMs = nowMs + wait * 1000;
      c.lockouts += 1;
      c.windowStartMs = nowMs;
      c.count = 0;
    }
    store.set(key, c);
  };

  const decide = (action: AbuseAction, keys: AbuseKeys): AbuseDecision => {
    const p = policies[action];
    const nowMs = clock.nowMs();
    const waits = [judge(keyOf(action, "a", keys.account), p.perAccount, nowMs)];
    if (keys.network !== null) waits.push(judge(keyOf(action, "n", keys.network), p.perNetwork, nowMs));
    const wait = Math.max(...waits);
    return wait > 0 ? { kind: "LIMITED", retryAfterSeconds: wait } : { kind: "ALLOWED" };
  };

  const fail = (action: AbuseAction, keys: AbuseKeys): AbuseDecision => {
    const p = policies[action];
    const nowMs = clock.nowMs();
    count(keyOf(action, "a", keys.account), p.perAccount, p.maxLockoutSeconds, nowMs);
    if (keys.network !== null) count(keyOf(action, "n", keys.network), p.perNetwork, null, nowMs);
    return decide(action, keys);
  };

  const succeed = (action: AbuseAction, keys: AbuseKeys): void => {
    const key = keyOf(action, "a", keys.account);
    const c = store.get(key);
    if (c !== undefined) store.set(key, { ...c, count: 0 });
  };

  return {
    attempt(action, keys) {
      // no await between the decision and the reservation: nothing else runs in between
      const gate = decide(action, keys);
      if (gate.kind === "LIMITED") return gate;
      const held = [keyOf(action, "a", keys.account), ...(keys.network === null ? [] : [keyOf(action, "n", keys.network)])];
      for (const key of held) hold(key, 1);
      let open = true;
      const end = (): boolean => {
        if (!open) return false;
        open = false;
        for (const key of held) hold(key, -1);
        return true;
      };
      return {
        kind: "ADMITTED",
        attempt: {
          fail: () => (end() ? fail(action, keys) : decide(action, keys)),
          succeed: () => {
            if (end()) succeed(action, keys);
          },
          release: () => void end(),
        },
      };
    },
    check: decide,
    fail,
    succeed,
  };
}
