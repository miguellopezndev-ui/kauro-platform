import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BRAND, COLOR, COLOR_DARK, FOCUS, NON_TEXT_PAIRS, TEXT_PAIRS, THEMES, TYPOGRAPHY, contrastRatio, relativeLuminance, renderTokenCss } from "../src/index.js";

// dist/test/tokens.test.js -> the package root
const packageRoot = join(import.meta.dirname, "..", "..");

test("D-DS-1: tokens.css is exactly the rendering of TOKENS, so the stylesheet the application loads cannot drift from the checked values", () => {
  const onDisk = readFileSync(join(packageRoot, "tokens.css"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(onDisk, renderTokenCss());
});

test("D-DS-1 (amendment A10): the brand's fixed values — carbon text on porcelain, wine primary with porcelain text, clay as the dark theme's primary on carbon, body 16px/1.5, dense text never below 14px, a two-pixel focus indicator with spacing, and the web's system families (owner, 2026-10-19: the faces the site was reviewed with; Inter stays the printed report's) with Georgia for notes and no font resource", () => {
  assert.deepEqual({ ...BRAND }, { carbon: "#242426", porcelain: "#F8F6F3", wine: "#653A46", clay: "#C4A693" });
  assert.equal(COLOR.text, BRAND.carbon);
  assert.equal(COLOR.background, BRAND.porcelain);
  assert.equal(COLOR.primary, BRAND.wine);
  assert.equal(COLOR.onPrimary, BRAND.porcelain);
  assert.equal(COLOR.focus, COLOR.primary);
  assert.equal(COLOR_DARK.background, BRAND.carbon);
  assert.equal(COLOR_DARK.primary, BRAND.clay);
  assert.equal(COLOR_DARK.onPrimary, BRAND.carbon);
  assert.equal(COLOR_DARK.focus, COLOR_DARK.primary);
  assert.deepEqual(Object.keys(COLOR_DARK), Object.keys(COLOR), "the dark theme defines every token, so no rule falls back to a light value");
  assert.equal(TYPOGRAPHY.bodySizePx, 16);
  assert.equal(TYPOGRAPHY.bodyLineHeight, 1.5);
  assert.ok(TYPOGRAPHY.denseSizePx >= 14);
  assert.equal(FOCUS.widthPx, 2);
  assert.ok(FOCUS.offsetPx >= 2, "the focus indicator has spacing");
  assert.match(TYPOGRAPHY.fontFamily, /^system-ui,/);
  assert.match(TYPOGRAPHY.displayFamily, /^"Segoe UI Variable Display", system-ui,/);
  assert.match(TYPOGRAPHY.monoFamily, /^ui-monospace,/);
  assert.match(TYPOGRAPHY.noteFamily, /^Georgia,/);
  // no web font: no face is named that a visitor would not have
  for (const stack of [TYPOGRAPHY.fontFamily, TYPOGRAPHY.displayFamily, TYPOGRAPHY.monoFamily]) assert.doesNotMatch(stack, /Inter|JetBrains/, stack);
  assert.doesNotMatch(renderTokenCss(), /url\(|@import|@font-face/, "no external font or resource request");
});

test("D-DS-1: in both themes every text pair reaches 4.5:1 and every non-text indicator 3:1 (WCAG 2.2 SC 1.4.3, 1.4.11)", () => {
  for (const [theme, palette] of Object.entries(THEMES)) {
    for (const [fg, bg] of TEXT_PAIRS) {
      const ratio = contrastRatio(palette[fg], palette[bg]);
      assert.ok(ratio >= 4.5, `${theme}: ${fg} on ${bg}: ${ratio.toFixed(2)}:1 < 4.5:1`);
    }
    for (const [fg, bg] of NON_TEXT_PAIRS) {
      const ratio = contrastRatio(palette[fg], palette[bg]);
      assert.ok(ratio >= 3, `${theme}: ${fg} against ${bg}: ${ratio.toFixed(2)}:1 < 3:1`);
    }
  }
});

test("A10: the dark theme applies when the document asks for it, or when the system asks and the document does not say light; the light theme is the default", () => {
  const css = renderTokenCss();
  assert.match(css, /^:root \{\n {2}color-scheme: light;\n {2}--kauro-color-text: #242426;/m);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\[data-theme="light"\]\) \{\n {4}color-scheme: dark;\n {4}--kauro-color-text: #F1ECE6;/);
  assert.match(css, /^:root\[data-theme="dark"\] \{\n {2}color-scheme: dark;\n {2}--kauro-color-text: #F1ECE6;/m);
  const blocks = [...css.matchAll(/^( *)(:root[^{\n]*|\.kauro-(?:inverse|wine)|:root[^{\n]* \.kauro-inverse) \{\n([\s\S]*?)^\1\}$/gm)].filter((match) => (match[3] ?? "").includes("--kauro-color-"));
  assert.equal(blocks.length, 7, "light, system dark, chosen dark, the inverse band in light, in system dark and in chosen dark, and the wine band");
  const property = (name: string): string => `--kauro-color-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:`;
  for (const block of blocks) for (const name of Object.keys(COLOR)) assert.ok((block[3] ?? "").includes(property(name)), `${block[2]} defines ${name}`);
  assert.match(css, /^\.kauro-inverse \{\n {2}color-scheme: dark;/m);
  assert.match(css, /^\.kauro-wine \{\n {2}color-scheme: dark;/m);
  for (const palette of Object.values(THEMES)) assert.deepEqual(Object.keys(palette).sort(), Object.keys(COLOR).sort(), "every palette defines every token");
});

test("D-DS-2: in each theme the focus colour is the primary fill's own colour (below 3:1 against it), which is why the focus ring is an offset outline drawn over the surface, never adjacent to the fill", () => {
  assert.ok(contrastRatio(COLOR.focus, COLOR.primary) < 3);
  assert.ok(contrastRatio(COLOR_DARK.focus, COLOR_DARK.primary) < 3);
  const css = renderTokenCss();
  assert.match(css, /:focus-visible \{\n {2}outline: var\(--kauro-focus-width\) solid var\(--kauro-color-focus\);\n {2}outline-offset: var\(--kauro-focus-offset\);/);
  assert.match(css, /@media \(forced-colors: active\)/, "the outline survives forced colours (high contrast)");
});

test("the contrast arithmetic is the WCAG 2.2 definition: black on white is 21:1, a colour against itself 1:1, and a malformed colour is refused", () => {
  assert.equal(contrastRatio("#000000", "#FFFFFF"), 21);
  assert.equal(contrastRatio("#0B6463", "#0B6463"), 1);
  assert.equal(relativeLuminance("#FFFFFF"), 1);
  assert.throws(() => relativeLuminance("#fff"), RangeError);
  assert.throws(() => relativeLuminance("#0b6463"), RangeError);
});
