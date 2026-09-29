import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { SafeText, isFormulaLike, truncateGraphemes } from "../src/index.js";
import type { SafeTextCopy } from "../src/index.js";
import { BIDI_CONTROLS, byClass, byId, elementsOf, findAll, findOne, render, textOf } from "./support/markup.js";
import type { ElementNode, Node } from "./support/markup.js";

const copy: SafeTextCopy = { formulaMarker: "Formula", showFullValue: "Show full value" };

/** A sentence around the value, so a value that escapes its element would visibly disturb the surrounding text. */
const sentence = (value: string, maxChars?: number | null) =>
  render(createElement("p", null, "Client ", createElement(SafeText, { value, copy, maxChars }), " was removed"));

/** Every text node of the tree that is not inside a <bdi>. */
function textOutsideBidi(node: ElementNode, inside = false): string {
  return node.children
    .map((child: Node): string => {
      if (child.kind === "text") return inside ? "" : child.text;
      return textOutsideBidi(child, inside || child.tag === "bdi");
    })
    .join("");
}

const HOSTILE_MARKUP = [
  '<img src=x onerror="alert(1)">',
  "<script>alert(1)</script>",
  '"><svg onload=alert(1)>',
  "</bdi></span><script>alert(1)</script><span><bdi>",
  "javascript:alert(1)",
  "&lt;b&gt;already escaped&lt;/b&gt; &amp; &#x3C;",
  "a & b < c > d ' e \" f",
];

const HOSTILE_BIDI = [
  "\u{202E}fdp.exe",
  "invoice\u{2066}\u{2069}\u{202E}txt",
  "\u{202B}open\u{202A}\u{202D} never closed",
  "abc\u{202E}\u{2066}def",
  "\u{2067}",
];

const FORMULAS = ["=HYPERLINK(\"http://example.invalid\",\"x\")", "+1+1", "-2+3", "@SUM(A1:A9)", "\t=1+1", "\r=1+1", "\u{FF1D}1+1"];

test("S069: an untrusted label renders as inert text inside a bidi-isolated element — markup, script, formula prefixes and U+202E/U+2066 controls are neither executed nor allowed to reorder the surrounding text", () => {
  for (const value of [...HOSTILE_MARKUP, ...HOSTILE_BIDI]) {
    const { html, root } = sentence(value);
    const label = JSON.stringify(value);

    // Inert: the only elements are the sentence, SafeText's wrapper and its bdi; no element or attribute comes from the value.
    assert.deepEqual([...new Set([...elementsOf(root)].map((e) => e.tag))].sort(), ["bdi", "p", "span"], label);
    assert.deepEqual([...new Set([...elementsOf(root)].flatMap((e) => [...e.attrs.keys()]))].sort(), ["class"], label);
    assert.doesNotMatch(html, /<(script|img|svg|iframe|a)\b/i, label);

    // Isolated: the whole value is one text node, verbatim, inside exactly one <bdi>.
    const bdi = findOne(root, "bdi", `the bdi of ${label}`);
    assert.equal(bdi.children.length, 1, label);
    assert.deepEqual(bdi.children[0], { kind: "text", text: value }, label);

    // Contained: no direction-changing control exists anywhere outside the <bdi>, so nothing can reorder the sentence.
    assert.equal(textOutsideBidi(root), "Client  was removed", label);
    assert.doesNotMatch(html.replace(/<bdi\b[^>]*>[\s\S]*?<\/bdi>/g, ""), BIDI_CONTROLS, label);
  }

  // The controls really are in the value and stay in it: an unclosed override cannot leave its isolate.
  const hostile = sentence("abc\u{202E}\u{2066}def");
  assert.match(textOf(findOne(hostile.root, "bdi")), /\u{202E}\u{2066}/u);

  // Formula prefixes are shown, verbatim, with a visible marker outside the bdi — never as a formula, never dropped.
  for (const value of FORMULAS) {
    assert.equal(isFormulaLike(value), true, JSON.stringify(value));
    const { root } = sentence(value);
    const wrapper = byClass(root, "kauro-safe-text");
    assert.equal(wrapper.length, 1);
    const markers = byClass(root, "kauro-safe-text-marker");
    assert.equal(markers.length, 1, JSON.stringify(value));
    assert.equal(textOf(markers[0] as ElementNode), copy.formulaMarker);
    const children = (wrapper[0] as ElementNode).children.filter((c): c is ElementNode => c.kind === "element");
    assert.deepEqual(children.map((c) => c.tag), ["span", "bdi"], "the marker precedes the value");
    assert.equal(textOf(findOne(root, "bdi")), value, "the value is shown exactly as it is");
  }
  for (const value of ["Acme Ltd", " =1", "a=b", "1+1", "", "x\t=1", "$SUM"]) {
    assert.equal(isFormulaLike(value), false, JSON.stringify(value));
    assert.equal(byClass(sentence(value).root, "kauro-safe-text-marker").length, 0, JSON.stringify(value));
  }
});

test("a long value is cut on grapheme boundaries and keeps its full text behind a disclosure button a screen reader can reach; a null limit never cuts", () => {
  const value = `${"A".repeat(100)}${String.fromCodePoint(0x202e)}${"B".repeat(100)}`;
  const { root, html } = sentence(value, 40);
  const [visible, full] = findAll(root, "bdi");
  assert.equal(textOf(visible as ElementNode), `${"A".repeat(40)}…`);
  const button = findOne(root, "button");
  assert.equal(button.attrs.get("type"), "button");
  assert.equal(button.attrs.get("aria-expanded"), "false");
  assert.equal(textOf(button), copy.showFullValue);
  const region = byId(root, button.attrs.get("aria-controls") as string);
  assert.equal(region.attrs.has("hidden"), true, "the full value stays hidden until the button is used");
  assert.equal(region.children.length, 1);
  assert.equal(textOf(full as ElementNode), value, "the full value is available verbatim");
  assert.ok((full as ElementNode).parent === region);
  assert.doesNotMatch(html.replace(/<bdi\b[^>]*>[\s\S]*?<\/bdi>/g, ""), BIDI_CONTROLS, "still contained");

  assert.equal(findAll(sentence("short", 40).root, "button").length, 0, "a short value has no disclosure");
  assert.equal(findAll(sentence("A".repeat(40), 40).root, "button").length, 0, "exactly the limit is not cut");
  assert.equal(findAll(sentence("A".repeat(5000), null).root, "button").length, 0, "a null limit never cuts (a value inside a link cannot hold a button)");
  assert.equal(textOf(findOne(sentence("A".repeat(5000), null).root, "bdi")), "A".repeat(5000));

  assert.equal(truncateGraphemes("e\u{301}".repeat(30), 30), null, "30 graphemes of two code points each fit in 30");
  assert.equal(truncateGraphemes("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}".repeat(5), 3), "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", "a ZWJ family is never split");
  assert.equal(truncateGraphemes("\u{1F1E8}\u{1F1F4}\u{1F1E8}\u{1F1F4}\u{1F1E8}\u{1F1F4}", 2), "\u{1F1E8}\u{1F1F4}\u{1F1E8}\u{1F1F4}", "a flag pair is never split");
  assert.throws(() => truncateGraphemes("abc", 0), RangeError);
  assert.throws(() => sentence("abc", 1.5), RangeError);
});
