/**
 * The design tokens of the Kauro web surfaces (reference UI_STATE_AND_COPY_CONTRACT "Visual and interaction tokens": a light
 * professional default with system-ui typography and no external font request; body text 16px with 1.5 line height; dense
 * secondary table metadata never below 14px; text #17212B on white, primary action #0B6463 with white text, focus #005FCC; a
 * visible two-pixel focus indicator with spacing; status uses text or icon plus colour; manual 11 "Design system": colour is
 * never the only signal; WCAG 2.2 AA).
 *
 * TOKENS is the single source of truth; tokens.css is its rendering (renderTokenCss), checked byte for byte by the tests, so
 * the stylesheet the application loads can never drift from the values the contrast checks bind.
 *
 * Focus (B11 design D-DS-2): #005FCC is 1.16:1 against the primary action colour, so the focus ring is always drawn as an
 * outline offset by FOCUS.offsetPx from the control, over the surface it sits on — never adjacent to a primary fill. The
 * contrast checks bind the focus colour against every surface, not against the primary fill.
 */

export const COLOR = Object.freeze({
  text: "#17212B",
  textMuted: "#4A5561",
  background: "#FFFFFF",
  surface: "#F5F7F9",
  border: "#C3CAD2",
  controlBorder: "#6B7682",
  primary: "#0B6463",
  primaryHover: "#084F4E",
  onPrimary: "#FFFFFF",
  focus: "#005FCC",
  dangerText: "#A4262C",
  dangerSurface: "#FDECEC",
  warningText: "#7A4B00",
  warningSurface: "#FFF4E0",
  successText: "#1E6B35",
  successSurface: "#E8F5EC",
  infoText: "#0B4F8A",
  infoSurface: "#E7F0FA",
});

export type ColorToken = keyof typeof COLOR;

export const TYPOGRAPHY = Object.freeze({
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  monoFamily: 'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace',
  bodySizePx: 16,
  bodyLineHeight: 1.5,
  denseSizePx: 14,
  headingLineHeight: 1.25,
});

export const SPACING_PX = Object.freeze([0, 4, 8, 12, 16, 24, 32, 48, 64] as const);

export const FOCUS = Object.freeze({ widthPx: 2, offsetPx: 2 });

export const RADIUS_PX = 4;

/** Text colours and the surfaces they are drawn on: each pair must reach 4.5:1 (WCAG 2.2 SC 1.4.3, normal text). */
export const TEXT_PAIRS: ReadonlyArray<readonly [ColorToken, ColorToken]> = Object.freeze([
  ["text", "background"],
  ["text", "surface"],
  ["textMuted", "background"],
  ["textMuted", "surface"],
  ["onPrimary", "primary"],
  ["onPrimary", "primaryHover"],
  ["primary", "background"],
  ["dangerText", "background"],
  ["dangerText", "dangerSurface"],
  ["warningText", "background"],
  ["warningText", "warningSurface"],
  ["successText", "background"],
  ["successText", "successSurface"],
  ["infoText", "background"],
  ["infoText", "infoSurface"],
  ["text", "dangerSurface"],
  ["text", "warningSurface"],
  ["text", "successSurface"],
  ["text", "infoSurface"],
] as const);

/** Non-text indicators and the surfaces they are drawn on: each pair must reach 3:1 (WCAG 2.2 SC 1.4.11). */
export const NON_TEXT_PAIRS: ReadonlyArray<readonly [ColorToken, ColorToken]> = Object.freeze([
  ["focus", "background"],
  ["focus", "surface"],
  ["focus", "dangerSurface"],
  ["focus", "warningSurface"],
  ["focus", "successSurface"],
  ["focus", "infoSurface"],
  ["controlBorder", "background"],
  ["controlBorder", "surface"],
  ["primary", "background"],
  ["primary", "surface"],
] as const);

const HEX = /^#[0-9A-F]{6}$/;

/** WCAG 2.2 relative luminance of an sRGB colour written #RRGGBB. */
export function relativeLuminance(hex: string): number {
  if (!HEX.test(hex)) throw new RangeError(`not an uppercase #RRGGBB colour: ${hex}`);
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2.2 contrast ratio of two colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The stylesheet the web surfaces load (@kauro/ui/tokens.css): custom properties plus the base rules they bind. */
export function renderTokenCss(): string {
  const lines: string[] = [
    "/* Generated from packages/ui/src/tokens.ts (renderTokenCss); packages/ui/test/tokens.test.ts checks it. Do not edit by hand. */",
    ":root {",
  ];
  for (const [name, value] of Object.entries(COLOR)) lines.push(`  --kauro-color-${kebab(name)}: ${value};`);
  lines.push(`  --kauro-font-family: ${TYPOGRAPHY.fontFamily};`);
  lines.push(`  --kauro-mono-family: ${TYPOGRAPHY.monoFamily};`);
  lines.push(`  --kauro-font-size-body: ${TYPOGRAPHY.bodySizePx}px;`);
  lines.push(`  --kauro-font-size-dense: ${TYPOGRAPHY.denseSizePx}px;`);
  lines.push(`  --kauro-line-height-body: ${TYPOGRAPHY.bodyLineHeight};`);
  lines.push(`  --kauro-line-height-heading: ${TYPOGRAPHY.headingLineHeight};`);
  SPACING_PX.forEach((px, i) => lines.push(`  --kauro-space-${i}: ${px}px;`));
  lines.push(`  --kauro-focus-width: ${FOCUS.widthPx}px;`);
  lines.push(`  --kauro-focus-offset: ${FOCUS.offsetPx}px;`);
  lines.push(`  --kauro-radius: ${RADIUS_PX}px;`);
  lines.push("}");
  lines.push("html {");
  lines.push("  color: var(--kauro-color-text);");
  lines.push("  background: var(--kauro-color-background);");
  lines.push("  font-family: var(--kauro-font-family);");
  lines.push("  font-size: var(--kauro-font-size-body);");
  lines.push("  line-height: var(--kauro-line-height-body);");
  lines.push("  -webkit-text-size-adjust: 100%;");
  lines.push("  text-size-adjust: 100%;");
  lines.push("}");
  lines.push(":focus-visible {");
  lines.push("  outline: var(--kauro-focus-width) solid var(--kauro-color-focus);");
  lines.push("  outline-offset: var(--kauro-focus-offset);");
  lines.push("}");
  lines.push("@media (prefers-reduced-motion: reduce) {");
  lines.push("  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }");
  lines.push("}");
  lines.push("@media (forced-colors: active) {");
  lines.push("  :focus-visible { outline-color: Highlight; }");
  lines.push("}");
  return `${lines.join("\n")}\n`;
}
