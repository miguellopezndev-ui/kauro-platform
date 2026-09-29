import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scanSource } from "./support/source-rules.js";
import type { Violation } from "./support/source-rules.js";

// dist/test/source-rules.test.js -> packages/ui/dist/test -> the repository root
const repositoryRoot = join(import.meta.dirname, "..", "..", "..", "..");

const SOURCE_FILE = /\.(?:tsx?|mts|jsx?|mjs)$/;
const NOT_SOURCE = new Set(["node_modules", "dist", ".next", "test-results", "playwright-report"]);

function sourceFilesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!NOT_SOURCE.has(entry.name)) files.push(...sourceFilesUnder(path));
    } else if (SOURCE_FILE.test(entry.name)) {
      files.push(path);
    }
  }
  return files.sort();
}

const rules = (source: string, file = "sample.tsx"): string[] => scanSource(file, source).map((v) => `${v.rule}:${v.line}`);

test("D-SEC-1, D-DS-3: no source of packages/ui or apps/web sets an inline style or writes markup into the page", () => {
  assert.ok(existsSync(join(repositoryRoot, "pnpm-workspace.yaml")), "the test is run from the workspace it guards");
  const roots = [join(repositoryRoot, "packages", "ui", "src"), join(repositoryRoot, "apps", "web", "src")];
  const violations: Violation[] = [];
  for (const root of roots) {
    const files = sourceFilesUnder(root);
    assert.ok(files.length > 0, `${root} holds source files, so an empty scan cannot pass`);
    for (const file of files) violations.push(...scanSource(file, readFileSync(file, "utf8")));
  }
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} ${v.rule} (${v.detail})`),
    [],
    "style only through tokens.css classes (the policy is style-src-attr 'none'), and render strings only as text nodes",
  );
  assert.ok(sourceFilesUnder(roots[0] as string).length >= 20, "the scan reaches every component of the design system");
});

test("the scanner finds an inline style however it is written: a JSX attribute, a createElement or jsx prop, a spread, the element's style, cssText or setAttribute", () => {
  assert.deepEqual(rules("const a = <div style={{ color: 'red' }} />;"), ["inline-style:1"]);
  assert.deepEqual(rules("const a = <Panel style={s} />;"), ["inline-style:1"]);
  assert.deepEqual(rules("const a = createElement('div', { style: { color: 'red' } });"), ["inline-style:1"]);
  assert.deepEqual(rules("const a = React.createElement('div', { 'style': s });"), ["inline-style:1"]);
  assert.deepEqual(rules("const a = jsx('div', { style });"), ["inline-style:1"]);
  assert.deepEqual(rules("const a = <div {...{ ...rest, style: s }} />;"), ["inline-style:1"]);
  assert.deepEqual(rules("element.style.color = 'red';"), ["inline-style:1"]);
  assert.deepEqual(rules("element['style'].color = 'red';"), ["inline-style:1"]);
  assert.deepEqual(rules("element.style.cssText = 'color: red';").sort(), ["inline-style:1", "inline-style:1"]);
  assert.deepEqual(rules("element.setAttribute('style', 'color: red');"), ["inline-style:1"]);
  assert.deepEqual(rules("element.setAttribute('STYLE', 'color: red');"), ["inline-style:1"]);
  assert.deepEqual(rules("const a = 1;\nconst b = <p style={x}>text</p>;"), ["inline-style:2"], "the line is reported");
});

test("the scanner finds every way to write markup into the page: dangerouslySetInnerHTML as an attribute, property, binding or computed key, innerHTML, outerHTML, insertAdjacentHTML, createContextualFragment and document.write", () => {
  assert.deepEqual(rules("const a = <div dangerouslySetInnerHTML={{ __html: v }} />;"), ["html-injection:1"]);
  assert.deepEqual(rules("const a = createElement('div', { dangerouslySetInnerHTML: h });"), ["html-injection:1"]);
  assert.deepEqual(rules("const p = { 'dangerouslySetInnerHTML': h };"), ["html-injection:1"]);
  assert.deepEqual(rules("const { dangerouslySetInnerHTML } = props;"), ["html-injection:1"]);
  assert.deepEqual(rules("const h = props['dangerouslySetInnerHTML'];"), ["html-injection:1"]);
  assert.deepEqual(rules("const h = props.dangerouslySetInnerHTML;"), ["html-injection:1"]);
  assert.deepEqual(rules("element.innerHTML = v;"), ["html-injection:1"]);
  assert.deepEqual(rules("element.outerHTML = v;"), ["html-injection:1"]);
  assert.deepEqual(rules("element.insertAdjacentHTML('beforeend', v);"), ["html-injection:1"]);
  assert.deepEqual(rules("range.createContextualFragment(v);"), ["html-injection:1"]);
  assert.deepEqual(rules("document.write(v);"), ["html-injection:1"]);
  assert.deepEqual(rules("document.writeln(v);"), ["html-injection:1"]);
});

test("the scanner does not mistake a comment, a type or a harmless name for a violation: a mention in prose, an Omit of the forbidden props, a style word in a string or an Intl option", () => {
  assert.deepEqual(rules("// dangerouslySetInnerHTML and style={{}} are refused here\nconst a = 1;"), []);
  assert.deepEqual(rules("/** element.innerHTML = x is never used */ const a = 1;"), []);
  assert.deepEqual(rules("type P = Omit<Props, 'style' | 'dangerouslySetInnerHTML'>;"), []);
  assert.deepEqual(rules("const label = 'style' + ' innerHTML';"), []);
  assert.deepEqual(rules("const f = new Intl.NumberFormat('en-US', { style: 'percent' });"), []);
  assert.deepEqual(rules("const a = <p className='kauro-hint'>text</p>;"), []);
  assert.deepEqual(rules("element.setAttribute('class', 'kauro-hint');"), []);
  assert.deepEqual(rules("const write = (v: string) => v; write('x'); log.write('x');"), []);
  assert.deepEqual(rules("const a = <p>{'<script>'}</p>;"), []);
});

test("the scanner reads plain JavaScript and TypeScript files as well as TSX", () => {
  assert.deepEqual(rules("element.style.color = 'red';", "sample.mjs"), ["inline-style:1"]);
  assert.deepEqual(rules("element.innerHTML = v as string;", "sample.ts"), ["html-injection:1"]);
  assert.deepEqual(rules("const a = <div style={s} />;", "sample.jsx"), ["inline-style:1"]);
});
