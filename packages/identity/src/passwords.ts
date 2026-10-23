/**
 * Password screening (O23A; NIST SP 800-63B §5.1.1.2, OWASP ASVS 4.0.3 V2.1). Kauro never receives a password: the browser hands
 * it to the identity provider. What Kauro adds is a screen the browser runs before it does:
 *
 *  - the policy: 12..128 characters after NFKC normalisation, every printable character and space allowed, no composition rules,
 *    no hints; refused when it contains the account's e-mail local part or the product name (context-specific words);
 *  - the breached-password check by k-anonymity (the Pwned Passwords range model): the browser sends only the first 5 hex digits
 *    of the password's SHA-1, the api answers every breached suffix of that range, and the browser compares locally. The api's
 *    corpus is a port: the offline corpus here, a live one is O23B's (no remote resource is fetched by the browser: CSP).
 *
 * A corpus that cannot answer leaves the password UNSCREENED; the policy refuses an unscreened password by default (fail closed),
 * a deployment may decide otherwise only by setting `onUnavailable` explicitly.
 */
import { createHash } from "node:crypto";

export const PASSWORD_POLICY = Object.freeze({ minLength: 12, maxLength: 128, rangePrefixLength: 5 });

export type PasswordRefusal = "TOO_SHORT" | "TOO_LONG" | "CONTROL_CHARACTER" | "CONTEXT_WORD" | "BREACHED" | "UNSCREENED";

export type PasswordScreen = { readonly kind: "ACCEPTED" } | { readonly kind: "REFUSED"; readonly reason: PasswordRefusal };

/** The breached-password corpus: the SHA-1 suffixes (35 uppercase hex) of a 5-hex-digit range, or UNAVAILABLE. */
export interface BreachedPasswordCorpus {
  range(prefix: string): Promise<{ readonly kind: "RANGE"; readonly suffixes: ReadonlySet<string> } | { readonly kind: "UNAVAILABLE" }>;
}

const RANGE_PREFIX = /^[0-9A-F]{5}$/;

export function isRangePrefix(value: unknown): value is string {
  return typeof value === "string" && RANGE_PREFIX.test(value);
}

/** Uppercase hex SHA-1 of the NFKC password (the range model's hash; SHA-1 here is a lookup key, never a stored credential). */
export function passwordSha1(password: string): string {
  return createHash("sha1").update(password.normalize("NFKC"), "utf8").digest("hex").toUpperCase();
}

/** The local policy, before any corpus is consulted. */
export function judgePasswordPolicy(password: string, context: { readonly email?: string | null } = {}): PasswordScreen {
  const normalised = password.normalize("NFKC");
  const length = [...normalised].length;
  if (length < PASSWORD_POLICY.minLength) return { kind: "REFUSED", reason: "TOO_SHORT" };
  if (length > PASSWORD_POLICY.maxLength) return { kind: "REFUSED", reason: "TOO_LONG" };
  if (/[\u0000-\u001f\u007f]/.test(normalised)) return { kind: "REFUSED", reason: "CONTROL_CHARACTER" };
  const lower = normalised.toLowerCase();
  const words = ["kauro"];
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local !== undefined && local.length >= 4) words.push(local);
  if (words.some((w) => lower.includes(w))) return { kind: "REFUSED", reason: "CONTEXT_WORD" };
  return { kind: "ACCEPTED" };
}

/** The whole screen: the policy, then the corpus by range. */
export async function screenPassword(
  password: string,
  corpus: BreachedPasswordCorpus,
  options: { readonly email?: string | null; readonly onUnavailable?: "REFUSE" | "ACCEPT" } = {},
): Promise<PasswordScreen> {
  const policy = judgePasswordPolicy(password, { email: options.email ?? null });
  if (policy.kind === "REFUSED") return policy;
  const sha1 = passwordSha1(password);
  const answer = await corpus.range(sha1.slice(0, PASSWORD_POLICY.rangePrefixLength));
  if (answer.kind === "UNAVAILABLE") return (options.onUnavailable ?? "REFUSE") === "REFUSE" ? { kind: "REFUSED", reason: "UNSCREENED" } : { kind: "ACCEPTED" };
  return answer.suffixes.has(sha1.slice(PASSWORD_POLICY.rangePrefixLength)) ? { kind: "REFUSED", reason: "BREACHED" } : { kind: "ACCEPTED" };
}

/** An offline corpus over a list of breached passwords (fixtures, or a local list a deployment ships). */
export function offlineBreachCorpus(passwords: Iterable<string>): BreachedPasswordCorpus {
  const ranges = new Map<string, Set<string>>();
  for (const p of passwords) {
    const sha1 = passwordSha1(p);
    const prefix = sha1.slice(0, PASSWORD_POLICY.rangePrefixLength);
    let set = ranges.get(prefix);
    if (set === undefined) ranges.set(prefix, (set = new Set()));
    set.add(sha1.slice(PASSWORD_POLICY.rangePrefixLength));
  }
  return {
    async range(prefix) {
      if (!isRangePrefix(prefix)) throw new RangeError("a range prefix is 5 uppercase hex digits");
      return { kind: "RANGE", suffixes: ranges.get(prefix) ?? new Set() };
    },
  };
}
