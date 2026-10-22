import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BRAND, COLOR, FOCUS, NON_TEXT_PAIRS, TEXT_PAIRS, THEMES, TYPOGRAPHY, contrastRatio, relativeLuminance, renderTokenCss } from "../src/index.js";

// dist/test/tokens.test.js -> the package root
const packageRoot = join(import.meta.dirname, "..", "..");

test("D-DS-1: tokens.css is exactly the rendering of TOKENS, so the stylesheet the application loads cannot drift from the checked values", () => {
  const onDisk = readFileSync(join(packageRoot, "tokens.css"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(onDisk, renderTokenCss());
});

test("D-DS-1 (amendment A10; one dark theme, owner 2026-10-21): the brand's fixed values — carbon pages, clay as the primary with carbon text, body 16px/1.5, dense text never below 14px, a two-pixel focus indicator with spacing, and the web's system families (owner, 2026-10-19: the faces the site was reviewed with; Inter stays the printed report's) with Georgia for notes and no font resource", () => {
  assert.deepEqual({ ...BRAND }, { carbon: "#242426", porcelain: "#F8F6F3", wine: "#653A46", clay: "#C4A693" });
  assert.equal(COLOR.background, BRAND.carbon);
  assert.equal(COLOR.primary, BRAND.clay);
  assert.equal(COLOR.onPrimary, BRAND.carbon);
  assert.equal(COLOR.focus, COLOR.primary);
  assert.equal(COLOR.wine, BRAND.wine);
  assert.equal(COLOR.onWine, BRAND.porcelain);
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

test("D-DS-1: on the page and in each band every text pair reaches 4.5:1 and every non-text indicator 3:1 (WCAG 2.2 SC 1.4.3, 1.4.11)", () => {
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

test("One theme (owner, 2026-10-21): the page is dark on :root, with no light palette, no system switch and no stored choice; the bands follow", () => {
  const css = renderTokenCss();
  assert.match(css, /^:root \{\n {2}color-scheme: dark;\n {2}--kauro-color-text: #F1ECE6;/m);
  assert.doesNotMatch(css, /prefers-color-scheme|data-theme|color-scheme: light/, "nothing switches to another theme");
  const blocks = [...css.matchAll(/^( *)(:root|\.kauro-(?:inverse|wine)) \{\n([\s\S]*?)^\1\}$/gm)].filter((match) => (match[3] ?? "").includes("--kauro-color-"));
  assert.equal(blocks.length, 3, "the page, the inverse band and the wine band");
  const property = (name: string): string => `--kauro-color-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:`;
  for (const block of blocks) for (const name of Object.keys(COLOR)) assert.ok((block[3] ?? "").includes(property(name)), `${block[2]} defines ${name}`);
  assert.match(css, /^\.kauro-inverse \{\n {2}color-scheme: dark;/m);
  assert.match(css, /^\.kauro-wine \{\n {2}color-scheme: dark;/m);
  for (const palette of Object.values(THEMES)) assert.deepEqual(Object.keys(palette).sort(), Object.keys(COLOR).sort(), "every palette defines every token");
});

test("D-DS-2: the focus colour is the primary fill's own colour (below 3:1 against it), which is why the focus ring is an offset outline drawn over the surface, never adjacent to the fill", () => {
  assert.ok(contrastRatio(COLOR.focus, COLOR.primary) < 3);
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
