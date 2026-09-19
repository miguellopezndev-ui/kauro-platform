/**
 * Strict JSON parser for request bodies (10 "Request envelope": the server validates JSON syntax and duplicate keys where the
 * parser permits detection; the request parser has bounded depth and string lengths).
 *
 * JSON.parse silently keeps the last of two duplicate keys and accepts any depth, so it cannot enforce the boundary. This
 * parser implements RFC 8259 exactly (no comments, no trailing commas, no NaN/Infinity, no leading zeros, no control
 * characters inside strings, no lone surrogate escapes), refuses duplicate object keys, bounds nesting depth and string length,
 * and refuses the prototype-polluting member names `__proto__`, `constructor` and `prototype` at any level. It returns plain
 * values; the closed request schema is validated next.
 */
import type { FailureReason } from "@kauro/domain";
import { REQUEST_LIMITS } from "./envelope.js";

export type StrictJsonReason = Extract<FailureReason, "JSON_SYNTAX" | "JSON_DUPLICATE_KEY" | "JSON_DEPTH_EXCEEDED" | "JSON_STRING_TOO_LONG">;

export class StrictJsonError extends Error {
  readonly reason: StrictJsonReason;
  /** Character offset in the input (safe to log: never a value). */
  readonly offset: number;
  constructor(reason: StrictJsonReason, offset: number) {
    super(`${reason} at offset ${offset}`);
    this.name = "StrictJsonError";
    this.reason = reason;
    this.offset = offset;
  }
}

export interface StrictJsonOptions {
  readonly maxDepth?: number;
  readonly maxStringLength?: number;
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function parseStrictJson(text: string, options: StrictJsonOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? REQUEST_LIMITS.maxDepth;
  const maxStringLength = options.maxStringLength ?? REQUEST_LIMITS.maxStringLength;
  let i = 0;
  const n = text.length;

  const fail = (reason: StrictJsonReason = "JSON_SYNTAX"): never => {
    throw new StrictJsonError(reason, i);
  };

  const skipWs = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };

  const parseString = (): string => {
    // opening quote already checked
    i++;
    let out = "";
    let start = i;
    for (;;) {
      if (i >= n) fail();
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(start, i);
        i++;
        break;
      }
      if (c < 0x20) fail();
      if (c === 0x5c) {
        out += text.slice(start, i);
        i++;
        if (i >= n) fail();
        const e = text[i] as string;
        switch (e) {
          case '"': out += '"'; i++; break;
          case "\\": out += "\\"; i++; break;
          case "/": out += "/"; i++; break;
          case "b": out += "\b"; i++; break;
          case "f": out += "\f"; i++; break;
          case "n": out += "\n"; i++; break;
          case "r": out += "\r"; i++; break;
          case "t": out += "\t"; i++; break;
          case "u": {
            const unit = readHex4(i + 1);
            i += 5;
            if (unit >= 0xd800 && unit <= 0xdbff) {
              // a high surrogate must be followed by an escaped low surrogate
              if (text[i] !== "\\" || text[i + 1] !== "u") fail();
              const low = readHex4(i + 2);
              if (low < 0xdc00 || low > 0xdfff) fail();
              i += 6;
              out += String.fromCharCode(unit, low);
            } else if (unit >= 0xdc00 && unit <= 0xdfff) {
              fail();
            } else {
              out += String.fromCharCode(unit);
            }
            break;
          }
          default:
            fail();
        }
        start = i;
        continue;
      }
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = i + 1 < n ? text.charCodeAt(i + 1) : -1;
        if (next < 0xdc00 || next > 0xdfff) fail();
        i += 2;
        continue;
      }
      if (c >= 0xdc00 && c <= 0xdfff) fail();
      i++;
    }
    if (out.length > maxStringLength) fail("JSON_STRING_TOO_LONG");
    return out;
  };

  const readHex4 = (at: number): number => {
    if (at + 4 > n) fail();
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const c = text.charCodeAt(at + k);
      let d: number;
      if (c >= 0x30 && c <= 0x39) d = c - 0x30;
      else if (c >= 0x41 && c <= 0x46) d = c - 0x41 + 10;
      else if (c >= 0x61 && c <= 0x66) d = c - 0x61 + 10;
      else return fail();
      v = v * 16 + d;
    }
    return v;
  };

  const parseNumber = (): number => {
    const start = i;
    if (text[i] === "-") i++;
    if (i >= n) fail();
    if (text[i] === "0") {
      i++;
    } else if ((text[i] as string) >= "1" && (text[i] as string) <= "9") {
      while (i < n && (text[i] as string) >= "0" && (text[i] as string) <= "9") i++;
    } else {
      fail();
    }
    if (text[i] === ".") {
      i++;
      const fracStart = i;
      while (i < n && (text[i] as string) >= "0" && (text[i] as string) <= "9") i++;
      if (i === fracStart) fail();
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      const expStart = i;
      while (i < n && (text[i] as string) >= "0" && (text[i] as string) <= "9") i++;
      if (i === expStart) fail();
    }
    const v = Number(text.slice(start, i));
    if (!Number.isFinite(v)) fail();
    return v;
  };

  const parseLiteral = (word: string, value: unknown): unknown => {
    if (text.startsWith(word, i)) {
      i += word.length;
      return value;
    }
    return fail();
  };

  const parseValue = (depth: number): unknown => {
    skipWs();
    if (i >= n) fail();
    const c = text[i] as string;
    switch (c) {
      case "{": return parseObject(depth + 1);
      case "[": return parseArray(depth + 1);
      case '"': return parseString();
      case "t": return parseLiteral("true", true);
      case "f": return parseLiteral("false", false);
      case "n": return parseLiteral("null", null);
      default:
        if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
        return fail();
    }
  };

  const parseObject = (depth: number): Record<string, unknown> => {
    if (depth > maxDepth) fail("JSON_DEPTH_EXCEEDED");
    i++;
    const out: Record<string, unknown> = {};
    skipWs();
    if (text[i] === "}") {
      i++;
      return out;
    }
    for (;;) {
      skipWs();
      if (text[i] !== '"') fail();
      const key = parseString();
      if (FORBIDDEN_KEYS.has(key)) fail();
      if (Object.prototype.hasOwnProperty.call(out, key)) fail("JSON_DUPLICATE_KEY");
      skipWs();
      if (text[i] !== ":") fail();
      i++;
      out[key] = parseValue(depth);
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return out;
      }
      fail();
    }
  };

  const parseArray = (depth: number): unknown[] => {
    if (depth > maxDepth) fail("JSON_DEPTH_EXCEEDED");
    i++;
    const out: unknown[] = [];
    skipWs();
    if (text[i] === "]") {
      i++;
      return out;
    }
    for (;;) {
      out.push(parseValue(depth));
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return out;
      }
      fail();
    }
  };

  if (text.charCodeAt(0) === 0xfeff) fail();
  const value = parseValue(0);
  skipWs();
  if (i !== n) fail();
  return value;
}
