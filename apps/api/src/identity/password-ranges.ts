/**
 * The answer of the password range lookup (O23A, k-anonymity): GET /api/v1/public/password-ranges/{prefix} answers every breached
 * SHA-1 suffix of a 5-hex-digit range, one per line, so the browser decides locally and the api never sees a password or its hash.
 * Not registered yet: the route lands with the corpus O23B selects (REQUESTS.md); this is its transport-neutral answer.
 */
import { isRangePrefix, type BreachedPasswordCorpus } from "@kauro/identity";

export type PasswordRangeReply =
  | { readonly status: 200; readonly body: string; readonly cacheControl: "public, max-age=86400" }
  | { readonly status: 400 }
  | { readonly status: 503; readonly retryAfterSeconds: number };

export async function passwordRangeReply(prefix: string, corpus: BreachedPasswordCorpus): Promise<PasswordRangeReply> {
  if (!isRangePrefix(prefix)) return { status: 400 };
  const answer = await corpus.range(prefix);
  if (answer.kind === "UNAVAILABLE") return { status: 503, retryAfterSeconds: 5 };
  // sorted: the answer of a range never depends on insertion order (cacheable, comparable)
  return { status: 200, body: [...answer.suffixes].sort().join("\n"), cacheControl: "public, max-age=86400" };
}
