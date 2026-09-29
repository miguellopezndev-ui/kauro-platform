import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import type { ReactElement } from "react";
import {
  Banner,
  Button,
  ConfirmDialogView,
  Count,
  CountDenominators,
  DataTable,
  Deadline,
  ErrorSummary,
  Field,
  LinkButton,
  Money,
  PhaseList,
  SafeText,
  StatusBadge,
  COLOR,
  contrastRatio,
  renderComponentCss,
  renderTokenCss,
} from "../src/index.js";
import type { ColorToken, Tone } from "../src/index.js";
import { CLASS } from "../src/internal/class-names.js";
import { elementsOf, render } from "./support/markup.js";

const css = renderTokenCss();
const componentCss = renderComponentCss();
const noop = (): void => undefined;

/** Every primitive rendered once, in the states that add classes: errors, sort, tones, truncation, formula, pagination. */
function everyPrimitive(): ReactElement {
  const safe = { formulaMarker: "Formula", showFullValue: "Show full value" };
  const tones: Tone[] = ["neutral", "info", "success", "warning", "danger"];
  return createElement(
    "div",
    null,
    createElement(SafeText, { value: `=${"A".repeat(200)}`, copy: safe }),
    createElement(Count, { value: 1200 }),
    createElement(Money, { minor: "129500", currency: "USD" }),
    createElement(Deadline, { at: "2027-01-14T22:00:00Z", timeZone: "UTC" }),
    createElement(Button, { variant: "primary" }, "Save"),
    createElement(Button, { variant: "secondary", disabled: true }, "Cancel"),
    createElement(Button, { variant: "danger" }, "Remove"),
    createElement(LinkButton, { href: "/next" }, "Next"),
    createElement(Field, { id: "company", label: "Company", hint: "Legal name", error: "Required", children: (control) => createElement("input", { ...control, type: "text" }) }),
    createElement(ErrorSummary, { title: "Problem", errors: [{ fieldId: "company", message: "Required" }] }),
    createElement(ConfirmDialogView, {
      title: "Clear",
      summary: "Summary",
      effects: [{ id: "a", description: "Effect", count: 3, countLabel: "rows", acknowledgeLabel: "I understand" }],
      errors: [{ effectId: "a", message: "Changed" }],
      copy: { approve: "Approve", cancel: "Cancel", errorSummaryTitle: "Problem" },
      acknowledged: new Set<string>(),
      onToggle: noop,
      onApprove: noop,
      onCancel: noop,
    }),
    createElement(CountDenominators, {
      physicalRows: 10,
      billableSourceUnits: 9,
      outputFiles: [{ id: "f", name: "f.csv", rows: 9 }],
      copy: {
        heading: "Counts",
        physicalRows: { label: "Physical rows", definition: "d1" },
        billableSourceUnits: { label: "Billable source units", definition: "d2" },
        outputRows: { label: "Output rows", definition: "d3", empty: "none" },
        safeText: safe,
      },
    }),
    createElement(DataTable<{ readonly id: string }>, {
      caption: "Table",
      columns: [
        { id: "id", header: "Id", cell: (row) => row.id, rowHeader: true, sortable: true, align: "end" },
      ],
      rows: [{ id: "a" }],
      rowKey: (row) => row.id,
      sort: { columnId: "id", direction: "ascending" },
      onSort: noop,
      pagination: { shown: 1, total: 2, nextHref: "/n" },
      copy: { empty: "none", paginationLabel: "Pages", position: (a, b) => `${a}/${b}`, previous: "Prev", next: "Next" },
    }),
    createElement(DataTable<{ readonly id: string }>, {
      caption: "Empty",
      columns: [{ id: "id", header: "Id", cell: (row) => row.id, rowHeader: true }],
      rows: [],
      rowKey: (row) => row.id,
      copy: { empty: "none", paginationLabel: "Pages", position: (a, b) => `${a}/${b}`, previous: "Prev", next: "Next" },
    }),
    ...tones.map((tone) => createElement(StatusBadge, { key: tone, tone, children: tone })),
    ...tones.map((tone) => createElement(Banner, { key: `b-${tone}`, tone, title: "T", children: tone })),
    createElement(PhaseList, {
      label: "Progress",
      copy: { done: "Done", current: "Now", upcoming: "Later", failed: "Failed" },
      phases: [
        { id: "a", label: "A", state: "done" },
        { id: "b", label: "B", state: "current" },
        { id: "c", label: "C", state: "upcoming" },
        { id: "d", label: "D", state: "failed" },
      ],
    }),
  );
}

const ruleFor = (className: string): RegExp => new RegExp(`\\.${className}(?![\\w-])`);

/** The rules of the component stylesheet as [selector, declarations], read from the exact layout renderComponentCss writes. */
function componentRules(): Array<{ readonly selector: string; readonly declarations: Map<string, string> }> {
  const rules: Array<{ selector: string; declarations: Map<string, string> }> = [];
  for (const match of componentCss.matchAll(/^(\S[^{\n]*) \{\n((?: {2}[^\n]*\n)+?)\}$/gm)) {
    const selector = match[1] as string;
    if (selector.startsWith("@")) continue;
    const declarations = new Map<string, string>();
    for (const line of (match[2] as string).split("\n")) {
      const declaration = /^ {2}([a-z-]+): (.*);$/.exec(line);
      if (declaration !== null) declarations.set(declaration[1] as string, declaration[2] as string);
    }
    rules.push({ selector, declarations });
  }
  return rules;
}

const tokenOf = (value: string): ColorToken | null => {
  const match = /^var\(--kauro-color-([a-z-]+)\)$/.exec(value.trim());
  if (match === null) return null;
  const name = (match[1] as string).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  assert.ok(name in COLOR, `--kauro-color-${match[1]} is a colour token`);
  return name as ColorToken;
};

test("D-SEC-1: every class a primitive emits has a rule in tokens.css, because styling is only by class and never by style attribute", () => {
  const emitted = new Set<string>();
  for (const element of elementsOf(render(everyPrimitive()).root)) {
    for (const token of (element.attrs.get("class") ?? "").split(/\s+/)) if (token !== "") emitted.add(token);
    assert.equal(element.attrs.has("style"), false, `<${element.tag}> has no style attribute`);
  }
  assert.ok(emitted.size >= 40, `the fixture reaches most of the design system (${emitted.size} classes)`);
  for (const token of emitted) {
    assert.match(token, /^kauro-[a-z0-9-]+$/, `${token} is a design-system class`);
    assert.match(css, ruleFor(token), `${token} has a rule in tokens.css`);
  }
});

test("D-SEC-1: every class name the package declares is unique, prefixed, and styled", () => {
  const names = Object.values(CLASS);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    assert.match(name, /^kauro-[a-z0-9-]+$/);
    assert.match(css, ruleFor(name), `${name} has a rule in tokens.css`);
  }
});

test("D-DS-1: the component stylesheet reads only the tokens — no colour literal, no pixel size, no !important, no external resource — and every custom property it reads is defined", () => {
  assert.doesNotMatch(componentCss, /#[0-9A-Fa-f]{3,8}\b/, "no hex colour");
  assert.doesNotMatch(componentCss, /\b(?:rgb|rgba|hsl|hsla)\(/, "no colour function of literals");
  assert.doesNotMatch(componentCss, /\d(?:px)\b/, "no pixel size: lengths are tokens, rem or em");
  assert.doesNotMatch(componentCss, /!important/);
  assert.doesNotMatch(componentCss, /url\(|@import|@font-face/);
  const defined = new Set([...css.matchAll(/^ {2}(--kauro-[a-z0-9-]+):/gm)].map((m) => m[1] as string));
  const read = new Set([...componentCss.matchAll(/var\((--kauro-[a-z0-9-]+)\)/g)].map((m) => m[1] as string));
  assert.ok(read.size > 15);
  for (const name of read) assert.ok(defined.has(name), `${name} is defined in :root`);
  assert.ok(defined.has("--kauro-target-size") && defined.has("--kauro-border-width"));
});

test("D-DS-1, D-DS-2: no rule hides or replaces the focus indicator, and a pointer target is never smaller than the target size token", () => {
  assert.doesNotMatch(componentCss, /outline\s*:\s*(?:none|0)\b/);
  assert.doesNotMatch(componentCss, /outline-style\s*:\s*none/);
  assert.doesNotMatch(componentCss, /:focus/, "focus is drawn once, by the base rule");
  const rules = componentRules();
  const button = rules.find((r) => r.selector === `.${CLASS.button}`);
  assert.ok(button !== undefined);
  assert.equal(button.declarations.get("min-block-size"), "var(--kauro-target-size)");
  assert.equal(button.declarations.get("min-inline-size"), "var(--kauro-target-size)");
  const sort = rules.find((r) => r.selector === `.${CLASS.sortButton}`);
  assert.equal(sort?.declarations.get("min-block-size"), "var(--kauro-target-size)");
  const field = rules.find((r) => r.selector === `.${CLASS.field} :is(input, select, textarea)`);
  assert.equal(field?.declarations.get("min-block-size"), "var(--kauro-target-size)");
});

test("D-DS-1: every text colour the component stylesheet pairs with a background reaches 4.5:1, and a text colour it sets alone reaches 4.5:1 on white", () => {
  let pairs = 0;
  let alone = 0;
  for (const { selector, declarations } of componentRules()) {
    const text = tokenOf(declarations.get("color") ?? "");
    if (text === null) continue;
    const background = tokenOf(declarations.get("background") ?? "");
    if (background !== null) {
      pairs += 1;
      const ratio = contrastRatio(COLOR[text], COLOR[background]);
      assert.ok(ratio >= 4.5, `${selector}: ${text} on ${background} is ${ratio.toFixed(2)}:1`);
    } else if (text !== "onPrimary") {
      alone += 1;
      const ratio = contrastRatio(COLOR[text], COLOR.background);
      assert.ok(ratio >= 4.5, `${selector}: ${text} on white is ${ratio.toFixed(2)}:1`);
    }
  }
  assert.ok(pairs >= 8 && alone >= 8, `the check reached ${pairs} pairs and ${alone} lone colours`);
});

test("D-DS-3: a value is isolated as its own bidirectional run, a collapsed disclosure is really hidden, and forced colours keep the borders that carry a component's shape", () => {
  assert.match(css, /\.kauro-safe-text bdi \{\n {2}unicode-bidi: isolate;/);
  assert.match(css, /\.kauro-safe-text-full\[hidden\] \{\n {2}display: none;\n\}/);
  assert.match(css, /@media \(forced-colors: active\) \{\n {2}\.kauro-button, /);
  assert.match(css, /\.kauro-button:disabled \{ border-color: GrayText; color: GrayText; \}/);
});
