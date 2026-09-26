/**
 * Untrusted text as the inventory shows it (03 "Source identity": headers have positional identities independent of their labels;
 * duplicate headers, empty headers, Unicode-equivalent labels and labels differing only by whitespace are surfaced; a malicious
 * header remains inert data). A display label satisfies the database's label rule (kauro.is_label: 1..200 characters, no C0/C1
 * control character) and the domain's (isLabel: at most 200 UTF-16 code units), so it is cut at 200 code units without splitting a
 * surrogate pair and every control character is replaced by U+FFFD; the state says whether the display differs from the text.
 *
 * Loaded inside the isolated child process: only node built-ins.
 */
import { createHash } from "node:crypto";

export const LABEL_MAX_UNITS = 200;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export type LabelState = "PRESENT" | "EMPTY" | "DUPLICATE_LABEL" | "DISPLAY_TRUNCATED" | "UNDECODABLE" | "NO_HEADER";

export interface InventoryLabel {
  readonly label?: string;
  readonly labelState: LabelState;
}

/** Cuts a string to at most `units` UTF-16 code units without splitting a surrogate pair. */
export function cutUnits(value: string, units: number): string {
  if (value.length <= units) return value;
  let end = units;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** The display form of untrusted text and whether it had to change (control characters replaced, length cut). */
export function displayOf(raw: string): { readonly display: string; readonly changed: boolean } {
  const cleaned = raw.replace(CONTROL, "�");
  const display = cutUnits(cleaned, LABEL_MAX_UNITS);
  return { display, changed: display !== raw };
}

/** A safe label as is (no change needed), or undefined. */
export function safeLabel(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const { display, changed } = displayOf(raw);
  return changed ? undefined : display;
}

/** The comparison key of a header label: Unicode-equivalent forms and whitespace-only differences collide (03). */
export function labelKey(raw: string): string {
  return raw.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Positional labels of a header record: `raw[i]` is the decoded header text of column i, undefined for an empty or absent cell,
 * null for an undecodable one; columns at or beyond `headerWidth` had no header cell at all (NO_HEADER).
 */
export function inventoryLabels(raw: ReadonlyArray<string | null | undefined>, columnCount: number, headerWidth: number): InventoryLabel[] {
  const keys = new Map<string, number>();
  for (let i = 0; i < Math.min(columnCount, raw.length); i++) {
    const v = raw[i];
    if (typeof v === "string" && v.trim().length > 0) {
      const k = labelKey(v);
      keys.set(k, (keys.get(k) ?? 0) + 1);
    }
  }
  const out: InventoryLabel[] = [];
  for (let i = 0; i < columnCount; i++) {
    if (i >= headerWidth) {
      out.push({ labelState: "NO_HEADER" });
      continue;
    }
    const v = raw[i];
    if (v === null) out.push({ labelState: "UNDECODABLE" });
    else if (v === undefined || v.trim().length === 0) out.push({ labelState: "EMPTY" });
    else {
      const { display, changed } = displayOf(v);
      const duplicate = (keys.get(labelKey(v)) ?? 0) > 1;
      out.push({ label: display, labelState: duplicate ? "DUPLICATE_LABEL" : changed ? "DISPLAY_TRUNCATED" : "PRESENT" });
    }
  }
  return out;
}

/** SHA-256 (hex) of UTF-8 text: the identity digest of an archive part path or a label. */
export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Cuts decoded cell text to at most `chars` code points; reports whether it was cut. */
export function cutCodePoints(value: string, chars: number): { readonly text: string; readonly cut: boolean } {
  if (value.length <= chars) return { text: value, cut: false };
  let count = 0;
  let i = 0;
  while (i < value.length && count < chars) {
    const c = value.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < value.length ? 2 : 1;
    count += 1;
  }
  return { text: value.slice(0, i), cut: i < value.length };
}
