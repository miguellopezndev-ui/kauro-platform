import type { ReactElement } from "react";
import { CLASS } from "../internal/class-names.js";
import { SafeTextDisclosure } from "./safe-text-disclosure.js";

/**
 * SafeText (B11 D-DS-3, S069): every customer or agency string — a name, a label, a value — is shown through this component and
 * no other. The string is one text node inside <bdi>, so it can neither become markup (React escapes it) nor reorder the text
 * around it (a bidirectional override or isolate control inside a <bdi> cannot leave its isolate). A value that starts like a
 * spreadsheet formula is shown as it is, with a visible marker, and is never re-exported as a formula. A long value is cut on a
 * grapheme boundary and its full text stays one button away.
 *
 * The English words (the marker, the disclosure label) come from the caller's copy catalogue: this package holds none.
 */

export interface SafeTextCopy {
  /** Shown before a value that starts like a formula, for example "Formula". */
  readonly formulaMarker: string;
  /** The label of the button that reveals the full value of a cut one, for example "Show full value". */
  readonly showFullValue: string;
}

export interface SafeTextProps {
  readonly value: string;
  readonly copy: SafeTextCopy;
  /**
   * The most graphemes shown before the value is cut (default 120). `null` never cuts: use it where the text sits inside a link
   * or a button, which cannot also hold the disclosure button.
   */
  readonly maxChars?: number | null | undefined;
}

export const DEFAULT_MAX_CHARS = 120;

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

// = + - @ tab carriage-return, and the fullwidth forms of the four visible ones, which some spreadsheet programs fold to the ASCII ones.
const FORMULA_STARTS: ReadonlySet<string> = new Set(["=", "+", "-", "@", "\t", "\r", ...[0xff1d, 0xff0b, 0xff0d, 0xff20].map((code) => String.fromCodePoint(code))]);

/** True when a spreadsheet program could read the value as a formula (D-DS-3: = + - @ tab carriage-return first). */
export function isFormulaLike(value: string): boolean {
  const first = value.codePointAt(0);
  return first !== undefined && FORMULA_STARTS.has(String.fromCodePoint(first));
}

/** The first `max` grapheme clusters of the value, or null when the value has no more than that. */
export function truncateGraphemes(value: string, max: number): string | null {
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError(`the limit must be a whole number of at least 1: ${String(max)}`);
  if (value.length <= max) return null; // a grapheme is at least one UTF-16 unit, so this many units cannot exceed the limit
  const cut: string[] = [];
  for (const { segment } of segmenter.segment(value)) {
    if (cut.length === max) return cut.join("");
    cut.push(segment);
  }
  return null;
}

export function SafeText({ value, copy, maxChars }: SafeTextProps): ReactElement {
  const limit = maxChars === null ? null : (maxChars ?? DEFAULT_MAX_CHARS);
  const cut = limit === null ? null : truncateGraphemes(value, limit);
  return (
    <span className={CLASS.safeText}>
      {isFormulaLike(value) ? <span className={CLASS.safeTextMarker}>{copy.formulaMarker}</span> : null}
      {cut === null ? <bdi>{value}</bdi> : <SafeTextDisclosure preview={`${cut}…`} value={value} showFullValue={copy.showFullValue} />}
    </span>
  );
}
