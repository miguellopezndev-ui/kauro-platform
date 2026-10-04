import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { COLOR, FOCUS, NON_TEXT_PAIRS, TEXT_PAIRS, TYPOGRAPHY, contrastRatio, relativeLuminance, renderTokenCss } from "../src/index.js";

// dist/test/tokens.test.js -> the package root
const packageRoot = join(import.meta.dirname, "..", "..");

test("D-DS-1: tokens.css is exactly the rendering of TOKENS, so the stylesheet the application loads cannot drift from the checked values", () => {
  const onDisk = readFileSync(join(packageRoot, "tokens.css"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(onDisk, renderTokenCss());
});

test("D-DS-1: the interface contract's fixed values — text #17212B on white, primary #0B6463 with white text, focus #005FCC, body 16px/1.5, dense text never below 14px, a two-pixel focus indicator with spacing, system-ui with no external font", () => {
  assert.equal(COLOR.text, "#17212B");
  assert.equal(COLOR.background, "#FFFFFF");
  assert.equal(COLOR.primary, "#0B6463");
  assert.equal(COLOR.onPrimary, "#FFFFFF");
  assert.equal(COLOR.focus, "#005FCC");
  assert.equal(TYPOGRAPHY.bodySizePx, 16);
  assert.equal(TYPOGRAPHY.bodyLineHeight, 1.5);
  assert.ok(TYPOGRAPHY.denseSizePx >= 14);
  assert.equal(FOCUS.widthPx, 2);
  assert.ok(FOCUS.offsetPx >= 2, "the focus indicator has spacing");
  assert.match(TYPOGRAPHY.fontFamily, /^system-ui,/);
  assert.doesNotMatch(renderTokenCss(), /url\(|@import|@font-face/, "no external font or resource request");
});

test("D-DS-1: every text pair reaches 4.5:1 and every non-text indicator 3:1 (WCAG 2.2 SC 1.4.3, 1.4.11)", () => {
  for (const [fg, bg] of TEXT_PAIRS) {
    const ratio = contrastRatio(COLOR[fg], COLOR[bg]);
    assert.ok(ratio >= 4.5, `${fg} on ${bg}: ${ratio.toFixed(2)}:1 < 4.5:1`);
  }
  for (const [fg, bg] of NON_TEXT_PAIRS) {
    const ratio = contrastRatio(COLOR[fg], COLOR[bg]);
    assert.ok(ratio >= 3, `${fg} against ${bg}: ${ratio.toFixed(2)}:1 < 3:1`);
  }
});

test("D-DS-2: the focus colour is not distinguishable against the primary fill (below 3:1), which is why the focus ring is an offset outline drawn over the surface, never adjacent to the fill", () => {
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
