/**
 * The design tokens of the Kauro web surfaces (reference UI_STATE_AND_COPY_CONTRACT "Visual and interaction tokens", as amended by
 * docs/authority/amendments/A10_VISUAL_IDENTITY.md: the Kauro palette — carbon #242426, porcelain #F8F6F3, wine #653A46 and clay #C4A693 — in a light theme
 * and a dark theme; system-ui typography and no external font request; body text 16px with 1.5 line height; dense secondary table
 * metadata never below 14px; a visible two-pixel focus indicator with spacing; status uses text or icon plus colour; manual 11 "Design
 * system": colour is never the only signal; WCAG 2.2 AA in both themes).
 *
 * TOKENS is the single source of truth; tokens.css is its rendering (renderTokenCss), checked byte for byte by the tests, so the stylesheet
 * the application loads can never drift from the values the contrast checks bind. Both themes bind the same pairs.
 *
 * Themes: the light theme is the default. The dark theme applies when the document says so (`<html data-theme="dark">`, from the visitor's
 * stored preference) or, with no stored preference, when the system asks for it (prefers-color-scheme) and the document does not say light.
 *
 * Focus (B11 design D-DS-2): the focus colour is the primary colour of its theme, so the focus ring is always drawn as an outline offset by
 * FOCUS.offsetPx from the control, over the surface it sits on — never adjacent to a primary fill. The contrast checks bind the focus colour
 * against every surface, not against the primary fill. On an inverse band (ink or wine) the page draws the ring in inkAccent, which the
 * checks bind against both bands.
 *
 * The rules of the primitives (styles.ts) are rendered after the base rules, into the same file: components emit class names only,
 * never a style attribute (B11 D-SEC-1), and every value a rule reads is one of the properties above.
 */

import { renderComponentCss } from "./styles.js";

/** The four colours of the brand; every token below is one of them or a tint of one, except the four status families. */
export const BRAND = Object.freeze({
  carbon: "#242426",
  porcelain: "#F8F6F3",
  wine: "#653A46",
  clay: "#C4A693",
});

export const COLOR = Object.freeze({
  text: BRAND.carbon,
  textMuted: "#5F5955",
  background: BRAND.porcelain,
  surface: "#F1EDE8",
  raised: "#FFFFFF",
  border: "#E3DCD4",
  controlBorder: "#8C837D",
  primary: BRAND.wine,
  primaryHover: "#4F2C37",
  onPrimary: BRAND.porcelain,
  focus: BRAND.wine,
  accent: BRAND.clay,
  accentText: "#7A5A45",
  accentSurface: "#ECE2D9",
  ink: BRAND.carbon,
  onInk: BRAND.porcelain,
  inkMuted: "#B5ADA6",
  inkBorder: "#3D3B3F",
  inkAccent: BRAND.clay,
  wine: BRAND.wine,
  onWine: BRAND.porcelain,
  wineMuted: "#E3D3D2",
  dangerText: "#9E2F26",
  dangerSurface: "#F7E3DF",
  warningText: "#7A4D0C",
  warningSurface: "#F5E8D2",
  successText: "#2E5B38",
  successSurface: "#E3EDE2",
  infoText: "#344E6B",
  infoSurface: "#E4E9EF",
});

export type ColorToken = keyof typeof COLOR;

/** The dark theme: the same tokens, so every rule that reads a token follows the theme without a rule of its own. */
export const COLOR_DARK: Readonly<Record<ColorToken, string>> = Object.freeze({
  text: "#F1ECE6",
  textMuted: "#ADA59E",
  background: BRAND.carbon,
  surface: "#1D1D1F",
  raised: "#2D2C2F",
  border: "#3A393D",
  controlBorder: "#857D77",
  primary: BRAND.clay,
  primaryHover: "#D6BFAE",
  onPrimary: BRAND.carbon,
  focus: BRAND.clay,
  accent: BRAND.clay,
  accentText: BRAND.clay,
  accentSurface: "#352E2A",
  ink: "#19191B",
  onInk: "#F1ECE6",
  inkMuted: "#ADA59E",
  inkBorder: "#333236",
  inkAccent: BRAND.clay,
  wine: BRAND.wine,
  onWine: BRAND.porcelain,
  wineMuted: "#E3D3D2",
  dangerText: "#F0A49A",
  dangerSurface: "#3A2422",
  warningText: "#E3BC74",
  warningSurface: "#352A1B",
  successText: "#A3CDA9",
  successSurface: "#213026",
  infoText: "#AFC3DA",
  infoSurface: "#242D38",
});

/**
 * The inverse band (`.kauro-inverse`): a carbon section inside a light page, drawn with the dark theme's tokens. Inside a dark page the
 * band sinks one step below the page instead (COLOR_INVERSE_DARK), so it still reads as a band.
 */
export const COLOR_INVERSE: Readonly<Record<ColorToken, string>> = COLOR_DARK;

export const COLOR_INVERSE_DARK: Readonly<Record<ColorToken, string>> = Object.freeze({
  ...COLOR_DARK,
  background: "#19191B",
  surface: "#141416",
  raised: "#262528",
  border: "#323135",
  accentSurface: "#2B2623",
});

/** The wine band (`.kauro-wine`): a wine section in either theme; its primary action is porcelain with wine text. */
export const COLOR_WINE: Readonly<Record<ColorToken, string>> = Object.freeze({
  ...COLOR_DARK,
  text: BRAND.porcelain,
  textMuted: "#E3D3D2",
  background: BRAND.wine,
  surface: "#5B3440",
  raised: "#71434F",
  border: "#80555F",
  controlBorder: "#C7A6AE",
  primary: BRAND.porcelain,
  primaryHover: "#FFFFFF",
  onPrimary: BRAND.wine,
  focus: BRAND.clay,
  accentText: "#E8D3C4",
  accentSurface: "#5B3440",
  dangerText: "#F6BDB4",
  warningText: "#EDCB8C",
  successText: "#B5D8BA",
  infoText: "#C2D2E5",
});

export const THEMES = Object.freeze({ light: COLOR, dark: COLOR_DARK, inverse: COLOR_INVERSE, inverseDark: COLOR_INVERSE_DARK, wine: COLOR_WINE });

export type ThemeName = keyof typeof THEMES;

/**
 * The web's families (owner, 2026-10-19): the system faces the site was designed and reviewed with, kept by the owner's decision after
 * comparing them with Inter (which stays the face of the printed B13 report). No web font is served.
 */
export const TYPOGRAPHY = Object.freeze({
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  /** Headlines: the optical display cut of the system face where the platform has one by name, else the same system face. */
  displayFamily: '"Segoe UI Variable Display", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  monoFamily: 'ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, "Liberation Mono", monospace',
  /** The editor's notes (margin notes and quiet asides), set in italic by their rules. */
  noteFamily: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
  bodySizePx: 16,
  bodyLineHeight: 1.5,
  denseSizePx: 14,
  headingLineHeight: 1.2,
});

export const SPACING_PX = Object.freeze([0, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128] as const);

export const FOCUS = Object.freeze({ widthPx: 2, offsetPx: 2 });

/** The radius of a control; RADIUS_LARGE_PX is the radius of a card, a panel and a dialog. */
export const RADIUS_PX = 4;
export const RADIUS_LARGE_PX = 10;

/** The smallest pointer target of a control (WCAG 2.2 SC 2.5.8 asks 24px; the primitives use the 44px of the interface contract). */
export const TARGET_SIZE_PX = 44;

/** The width of the border of a control, a table rule and a card. */
export const BORDER_WIDTH_PX = 1;

/** Text colours and the surfaces they are drawn on: each pair must reach 4.5:1 in both themes (WCAG 2.2 SC 1.4.3, normal text). */
export const TEXT_PAIRS: ReadonlyArray<readonly [ColorToken, ColorToken]> = Object.freeze([
  ["text", "background"],
  ["text", "surface"],
  ["text", "raised"],
  ["text", "accentSurface"],
  ["textMuted", "background"],
  ["textMuted", "surface"],
  ["textMuted", "raised"],
  ["textMuted", "accentSurface"],
  ["onPrimary", "primary"],
  ["onPrimary", "primaryHover"],
  ["primary", "background"],
  ["primary", "surface"],
  ["primary", "raised"],
  ["primary", "accentSurface"],
  ["accentText", "background"],
  ["accentText", "raised"],
  ["accentText", "accentSurface"],
  ["onInk", "ink"],
  ["inkMuted", "ink"],
  ["inkAccent", "ink"],
  ["onWine", "wine"],
  ["wineMuted", "wine"],
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

/** Non-text indicators and the surfaces they are drawn on: each pair must reach 3:1 in both themes (WCAG 2.2 SC 1.4.11). */
export const NON_TEXT_PAIRS: ReadonlyArray<readonly [ColorToken, ColorToken]> = Object.freeze([
  ["focus", "background"],
  ["focus", "surface"],
  ["focus", "raised"],
  ["focus", "accentSurface"],
  ["focus", "dangerSurface"],
  ["focus", "warningSurface"],
  ["focus", "successSurface"],
  ["focus", "infoSurface"],
  ["inkAccent", "ink"],
  ["inkAccent", "wine"],
  ["controlBorder", "background"],
  ["controlBorder", "surface"],
  ["controlBorder", "raised"],
  ["primary", "background"],
  ["primary", "surface"],
  ["primary", "raised"],
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

const colorLines = (palette: Readonly<Record<ColorToken, string>>, indent: string): string[] =>
  Object.entries(palette).map(([name, value]) => `${indent}--kauro-color-${kebab(name)}: ${value};`);

/** The stylesheet the web surfaces load (@kauro/ui/tokens.css): custom properties, the base rules they bind and the component rules. */
export function renderTokenCss(): string {
  const lines: string[] = [
    "/* Generated from packages/ui/src/tokens.ts (renderTokenCss); packages/ui/test/tokens.test.ts checks it. Do not edit by hand. */",
    ":root {",
    "  color-scheme: light;",
  ];
  lines.push(...colorLines(COLOR, "  "));
  lines.push(`  --kauro-font-family: ${TYPOGRAPHY.fontFamily};`);
  lines.push(`  --kauro-display-family: ${TYPOGRAPHY.displayFamily};`);
  lines.push(`  --kauro-mono-family: ${TYPOGRAPHY.monoFamily};`);
  lines.push(`  --kauro-note-family: ${TYPOGRAPHY.noteFamily};`);
  lines.push(`  --kauro-font-size-body: ${TYPOGRAPHY.bodySizePx}px;`);
  lines.push(`  --kauro-font-size-dense: ${TYPOGRAPHY.denseSizePx}px;`);
  lines.push(`  --kauro-line-height-body: ${TYPOGRAPHY.bodyLineHeight};`);
  lines.push(`  --kauro-line-height-heading: ${TYPOGRAPHY.headingLineHeight};`);
  SPACING_PX.forEach((px, i) => lines.push(`  --kauro-space-${i}: ${px}px;`));
  lines.push(`  --kauro-focus-width: ${FOCUS.widthPx}px;`);
  lines.push(`  --kauro-focus-offset: ${FOCUS.offsetPx}px;`);
  lines.push(`  --kauro-radius: ${RADIUS_PX}px;`);
  lines.push(`  --kauro-radius-large: ${RADIUS_LARGE_PX}px;`);
  lines.push(`  --kauro-target-size: ${TARGET_SIZE_PX}px;`);
  lines.push(`  --kauro-border-width: ${BORDER_WIDTH_PX}px;`);
  lines.push("}");
  lines.push("@media (prefers-color-scheme: dark) {");
  lines.push('  :root:not([data-theme="light"]) {');
  lines.push("    color-scheme: dark;");
  lines.push(...colorLines(COLOR_DARK, "    "));
  lines.push("  }");
  lines.push("}");
  lines.push(':root[data-theme="dark"] {');
  lines.push("  color-scheme: dark;");
  lines.push(...colorLines(COLOR_DARK, "  "));
  lines.push("}");
  // The bands: an element that carries the class draws its own background and text, and every token inside it follows the band.
  lines.push(".kauro-inverse {");
  lines.push("  color-scheme: dark;");
  lines.push(...colorLines(COLOR_INVERSE, "  "));
  lines.push("  color: var(--kauro-color-text);");
  lines.push("  background: var(--kauro-color-background);");
  lines.push("}");
  lines.push("@media (prefers-color-scheme: dark) {");
  lines.push('  :root:not([data-theme="light"]) .kauro-inverse {');
  lines.push(...colorLines(COLOR_INVERSE_DARK, "    "));
  lines.push("  }");
  lines.push("}");
  lines.push(':root[data-theme="dark"] .kauro-inverse {');
  lines.push(...colorLines(COLOR_INVERSE_DARK, "  "));
  lines.push("}");
  lines.push(".kauro-wine {");
  lines.push("  color-scheme: dark;");
  lines.push(...colorLines(COLOR_WINE, "  "));
  lines.push("  color: var(--kauro-color-text);");
  lines.push("  background: var(--kauro-color-background);");
  lines.push("}");
  lines.push("html {");
  lines.push("  color: var(--kauro-color-text);");
  lines.push("  background: var(--kauro-color-background);");
  lines.push("  font-family: var(--kauro-font-family);");
  lines.push("  font-size: var(--kauro-font-size-body);");
  lines.push("  line-height: var(--kauro-line-height-body);");
  lines.push("  -webkit-text-size-adjust: 100%;");
  lines.push("  text-size-adjust: 100%;");
  lines.push("  -webkit-font-smoothing: antialiased;");
  lines.push("  -moz-osx-font-smoothing: grayscale;");
  lines.push("  text-rendering: optimizeLegibility;");
  lines.push("  font-kerning: normal;");
  lines.push("}");
  lines.push("::selection {");
  lines.push("  background: var(--kauro-color-accent);");
  lines.push(`  color: ${BRAND.carbon};`);
  lines.push("}");
  lines.push(":focus-visible {");
  lines.push("  outline: var(--kauro-focus-width) solid var(--kauro-color-focus);");
  lines.push("  outline-offset: var(--kauro-focus-offset);");
  lines.push("}");
  // While the theme changes, nothing transitions: the page is redrawn in its new colours in one step.
  lines.push(":root[data-theme-switching] *, :root[data-theme-switching] *::before, :root[data-theme-switching] *::after { transition: none !important; }");
  lines.push("@media (prefers-reduced-motion: reduce) {");
  lines.push("  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }");
  lines.push("}");
  lines.push("@media (forced-colors: active) {");
  lines.push("  :focus-visible { outline-color: Highlight; }");
  lines.push("}");
  lines.push(renderComponentCss());
  return `${lines.join("\n")}\n`;
}
