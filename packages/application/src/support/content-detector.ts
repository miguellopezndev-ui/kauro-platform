/**
 * The bounded secret and record detector of a support summary (B11 D-SUP-2; owner manual 18: "Support metadata must not become an
 * unrestricted raw-data channel"). The server decides, once: there is no client copy of these rules. It answers the class of what
 * it found, never a value, a position or an excerpt, so a refusal cannot echo what it refused.
 *
 * Bounds: the summary is at most 4000 characters (the request schema and the table). No pattern here nests or overlaps its
 * quantifiers (single character classes and bounded repeats), so the worst case is small and polynomial, and the tests time the
 * shapes that hurt; the two scans that would otherwise rescan (e-mail addresses, entropy runs) walk the text once. The text is
 * never trimmed or cut, so nothing hides behind a length cut-off.
 *
 * A finding means "looks like": the rules are deliberately conservative, and the refusal points at the secure upload.
 */

export type ContentFinding = "SECRET_LIKE_CONTENT" | "RECORD_LIKE_CONTENT";

/** PEM, OpenSSH and PGP private-key blocks: the header alone is a refusal. */
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----/;

/** Cloud and API key shapes: AWS, Google, GitHub, Slack, Stripe and OpenAI-style prefixes. */
const KEY_SHAPES: ReadonlyArray<RegExp> = [
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bsk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{20,}/,
];

/** A JSON web token: header and payload are base64url JSON objects (they begin `eyJ`), then a signature that may be empty. */
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/;

/** `Bearer <token>`: the token is checked in code (a digit) so the word alone in prose is not a finding. */
const BEARER = /\bBearer\s{1,8}([A-Za-z0-9._~+/-]{16,})=*/gi;

/** `password=...`, `secret: ...`, `"token": "..."`, `api key = ...`: a secret name, a separator and a value of four or more characters. */
const NAME_VALUE = /(?:password|passwd|passphrase|pwd|secret|token|api[_ -]?key|apikey|access[_ -]?key|private[_ -]?key)["']?[ \t]{0,4}[:=][ \t]{0,4}["']?[^\s"']{4,}/i;

const ENTROPY_MIN_RUN = 32;
const ENTROPY_MIN_BITS = 4.0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRunCharacter(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 43 || // +
    code === 47 || // /
    code === 95 || // _
    code === 61 || // =
    code === 45 // -
  );
}

function shannonBitsPerCharacter(run: string): number {
  const counts = new Int32Array(128);
  for (let i = 0; i < run.length; i++) counts[run.charCodeAt(i)]! += 1;
  let bits = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / run.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function looksLikeRandomToken(run: string): boolean {
  if (run.length < ENTROPY_MIN_RUN || UUID.test(run)) return false;
  let letters = false;
  let digits = false;
  for (let i = 0; i < run.length; i++) {
    const c = run.charCodeAt(i);
    if (c >= 48 && c <= 57) digits = true;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters = true;
  }
  return letters && digits && shannonBitsPerCharacter(run) >= ENTROPY_MIN_BITS;
}

/** One pass over the text for runs of base64, hex or url-safe characters. */
function hasHighEntropyRun(text: string): boolean {
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    const inRun = i < text.length && isRunCharacter(text.charCodeAt(i));
    if (inRun && start < 0) start = i;
    if (!inRun && start >= 0) {
      if (i - start >= ENTROPY_MIN_RUN && looksLikeRandomToken(text.slice(start, i))) return true;
      start = -1;
    }
  }
  return false;
}

function hasSecret(text: string): boolean {
  if (PRIVATE_KEY_BLOCK.test(text) || JWT.test(text) || NAME_VALUE.test(text)) return true;
  if (KEY_SHAPES.some((shape) => shape.test(text))) return true;
  for (const m of text.matchAll(BEARER)) if (/\d/.test(m[1] ?? "")) return true;
  return hasHighEntropyRun(text);
}

function isLocalPartCharacter(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 46 || code === 95 || code === 37 || code === 43 || code === 45;
}
function isDomainCharacter(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 46 || code === 45;
}

/** The number of e-mail addresses: an `@` with a local part before it and a dotted domain after it, found by one walk over the `@` signs. */
function countEmailAddresses(text: string): number {
  let count = 0;
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (at === 0 || !isLocalPartCharacter(text.charCodeAt(at - 1))) continue;
    let end = at + 1;
    while (end < text.length && isDomainCharacter(text.charCodeAt(end))) end++;
    while (end > at + 1 && text.charCodeAt(end - 1) === 46) end--; // a full stop that ends a sentence is not part of the domain
    const domain = text.slice(at + 1, end);
    const labels = domain.split(".");
    const tld = labels[labels.length - 1] ?? "";
    if (labels.length >= 2 && labels.every((l) => l.length > 0) && /^[A-Za-z]{2,}$/.test(tld)) count++;
  }
  return count;
}

const DELIMITERS: ReadonlyArray<string> = [",", ";", "\t", "|"];
const RECORD_LINES = 3;
const RECORD_EMAILS = 3;
const RECORD_MIN_FIELDS = 3;

/** Three or more lines that split into the same number of fields (at least three) on the same delimiter: rows of a table. */
function hasDelimitedRows(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < RECORD_LINES) return false;
  for (const delimiter of DELIMITERS) {
    const byFields = new Map<number, number>();
    for (const line of lines) {
      let fields = 1;
      for (let at = line.indexOf(delimiter); at >= 0; at = line.indexOf(delimiter, at + 1)) fields++;
      if (fields < RECORD_MIN_FIELDS) continue;
      const rows = (byFields.get(fields) ?? 0) + 1;
      if (rows >= RECORD_LINES) return true;
      byFields.set(fields, rows);
    }
  }
  return false;
}

/** The class of what the text looks like, or null when it is safe to keep as metadata. Secrets are decided before records. */
export function detectRefusedContent(text: string): ContentFinding | null {
  if (hasSecret(text)) return "SECRET_LIKE_CONTENT";
  if (countEmailAddresses(text) >= RECORD_EMAILS || hasDelimitedRows(text)) return "RECORD_LIKE_CONTENT";
  return null;
}
