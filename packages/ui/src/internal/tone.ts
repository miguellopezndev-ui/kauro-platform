import { CLASS } from "./class-names.js";

/** The status tones of D-DS-1. Colour is never the only signal: every tone has its own icon shape and every use carries text. */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export const TONE_CLASS: Readonly<Record<Tone, string>> = Object.freeze({
  neutral: CLASS.toneNeutral,
  info: CLASS.toneInfo,
  success: CLASS.toneSuccess,
  warning: CLASS.toneWarning,
  danger: CLASS.toneDanger,
});

export function assertTone(tone: string): asserts tone is Tone {
  if (!Object.hasOwn(TONE_CLASS, tone)) throw new RangeError(`unknown tone: ${JSON.stringify(tone)}`);
}
