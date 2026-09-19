/**
 * Canonical JSON profile (authority: reference/HASHING_AND_ACCOUNTING_RULES.md, "Hash domain separation").
 *
 * The profile is what every producer, consumer and evaluator agrees on before hashing structured content:
 * - duplicate object keys are rejected at parse time (they are silently collapsed by JSON.parse, so the profile parses itself);
 * - invalid Unicode (lone surrogates) is rejected; strings are otherwise preserved byte for byte — no normalization of a
 *   customer string happens merely to make hashing convenient;
 * - non-finite numbers are rejected; integers outside the exactly representable range are rejected as numbers — business
 *   values that could exceed JSON number precision travel as decimal strings and stay strings;
 * - object keys are serialized in code-point order, arrays preserve their order (a schema that declares a set sorts before
 *   canonicalizing — that is the schema's job, not this profile's);
 * - the output is the UTF-8 bytes of the serialization with no whitespace.
 */

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export class CanonicalError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${message} at ${path || "$"}`);
    this.name = "CanonicalError";
    this.path = path;
  }
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function assertValidUnicode(s: string, path: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) throw new CanonicalError("lone high surrogate", path);
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new CanonicalError("lone low surrogate", path);
    }
  }
}

function serializeString(s: string): string {
  // JSON.stringify escapes control characters, quotes and backslashes; it never escapes non-ASCII (kept as UTF-8 bytes).
  return JSON.stringify(s);
}

function serializeNumber(n: number, path: string): string {
  if (!Number.isFinite(n)) throw new CanonicalError("non-finite number", path);
  if (Number.isInteger(n)) {
    if (Math.abs(n) > MAX_SAFE) {
      throw new CanonicalError("integer outside the exactly representable range; carry it as a decimal string", path);
    }
    // -0 is not a distinct business value
    return Object.is(n, -0) ? "0" : String(n);
  }
  // Shortest round-trip representation (ES2023 Number#toString) is deterministic across engines for the same double.
  return String(n);
}

/** Serializes a value under the canonical profile. Throws CanonicalError on anything the profile rejects. */
export function canonicalize(value: unknown, path = ""): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value, path);
    case "string":
      assertValidUnicode(value, path);
      return serializeString(value);
    case "bigint":
      throw new CanonicalError("bigint is not a JSON value; carry it as a decimal string", path);
    case "undefined":
    case "function":
    case "symbol":
      throw new CanonicalError(`${typeof value} is not a JSON value`, path);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(",") + "]";
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalError("only plain objects are canonical JSON objects", path);
  }
  const keys = Object.keys(value as object).sort(compareCodePoints);
  const parts: string[] = [];
  for (const k of keys) {
    assertValidUnicode(k, `${path}.${k}`);
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) throw new CanonicalError("undefined property value (omit the key instead)", `${path}.${k}`);
    parts.push(serializeString(k) + ":" + canonicalize(v, `${path}.${k}`));
  }
  return "{" + parts.join(",") + "}";
}

/** Code-point order (not UTF-16 unit order): this is what "sorted keys" means across languages. */
export function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** UTF-8 bytes of the canonical serialization. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/**
 * Parses JSON text under the profile: duplicate keys are rejected (JSON.parse would keep the last one silently), and the result
 * is re-validated by canonicalize. Big integers that arrived as JSON numbers are rejected because they already lost precision.
 */
export function parseCanonical(text: string): CanonicalValue {
  assertNoDuplicateKeys(text);
  const value: unknown = JSON.parse(text, (_k, v: unknown) => v);
  // any number that is not exactly representable was already rounded by JSON.parse: detect by re-serializing digits
  assertExactNumbers(text);
  canonicalize(value);
  return value as CanonicalValue;
}

function assertExactNumbers(text: string): void {
  // integer literals with more than 15 significant digits cannot be trusted as JSON numbers under this profile
  const re = /(?<![\w.\-"])-?\d{16,}(?![\d.eE"])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const digits = m[0].replace("-", "");
    if (BigInt(digits) > BigInt(MAX_SAFE)) {
      throw new CanonicalError(`integer literal ${m[0]} exceeds the exactly representable range; it must be a decimal string`, `offset ${m.index}`);
    }
  }
}

/** A small tokenizer pass that fails on duplicate keys within one object; strings are scanned with JSON escaping rules. */
function assertNoDuplicateKeys(text: string): void {
  const stack: Array<Set<string> | null> = [];
  let i = 0;
  const n = text.length;
  let expectKey = false;
  while (i < n) {
    const ch = text[i]!;
    if (ch === "{") {
      stack.push(new Set());
      expectKey = true;
      i++;
    } else if (ch === "[") {
      stack.push(null);
      expectKey = false;
      i++;
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      expectKey = false;
      i++;
    } else if (ch === ",") {
      expectKey = stack.length > 0 && stack[stack.length - 1] !== null;
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      let raw = "";
      while (j < n && text[j] !== '"') {
        if (text[j] === "\\") {
          raw += text[j]! + (text[j + 1] ?? "");
          j += 2;
        } else {
          raw += text[j]!;
          j++;
        }
      }
      const literal = text.slice(i, j + 1);
      i = j + 1;
      if (expectKey) {
        const key = JSON.parse(literal) as string;
        const set = stack[stack.length - 1];
        if (set) {
          if (set.has(key)) throw new CanonicalError(`duplicate object key ${JSON.stringify(key)}`, `offset ${i}`);
          set.add(key);
        }
        expectKey = false;
      }
    } else {
      i++;
    }
  }
}
