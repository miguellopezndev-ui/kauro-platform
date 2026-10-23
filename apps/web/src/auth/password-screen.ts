// The browser's password screen (O23A; NIST SP 800-63B 5.1.1.2): run before a new password is handed to the identity provider. The
// password never leaves the page: the page hashes it (SHA-1 through WebCrypto, the k-anonymity range model's lookup key), asks the api
// only for the 5-hex-digit range, and compares the suffixes locally. The answer is a code; the words the person reads come from the copy
// catalogue. The api's range route lands with O23B's corpus decision: until then a page that has no range source refuses as UNSCREENED.

export const PASSWORD_LENGTH = Object.freeze({ min: 12, max: 128 });

export type PasswordScreenCode = "ACCEPTED" | "TOO_SHORT" | "TOO_LONG" | "CONTROL_CHARACTER" | "CONTEXT_WORD" | "BREACHED" | "UNSCREENED";

/** The breached suffixes (35 uppercase hex digits) of a range, or null when the range cannot be read. */
export type RangeSource = (prefix: string) => Promise<ReadonlySet<string> | null>;

const CONTROL = /[\u0000-\u001f\u007f]/;

export function passwordPolicyCode(password: string, email: string | null): PasswordScreenCode {
  const normalised = password.normalize("NFKC");
  const length = [...normalised].length;
  if (length < PASSWORD_LENGTH.min) return "TOO_SHORT";
  if (length > PASSWORD_LENGTH.max) return "TOO_LONG";
  if (CONTROL.test(normalised)) return "CONTROL_CHARACTER";
  const lower = normalised.toLowerCase();
  const local = email?.split("@")[0]?.toLowerCase();
  if (lower.includes("kauro") || (local !== undefined && local.length >= 4 && lower.includes(local))) return "CONTEXT_WORD";
  return "ACCEPTED";
}

export async function sha1Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export async function screenPassword(password: string, email: string | null, ranges: RangeSource | null): Promise<PasswordScreenCode> {
  const policy = passwordPolicyCode(password, email);
  if (policy !== "ACCEPTED") return policy;
  if (ranges === null) return "UNSCREENED";
  const hash = await sha1Hex(password.normalize("NFKC"));
  const suffixes = await ranges(hash.slice(0, 5));
  if (suffixes === null) return "UNSCREENED";
  return suffixes.has(hash.slice(5)) ? "BREACHED" : "ACCEPTED";
}
