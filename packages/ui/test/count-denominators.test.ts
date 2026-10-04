import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CountDenominators } from "../src/index.js";
import type { CountDenominatorsCopy, OutputFileCount } from "../src/index.js";
import { byClass, findAll, findOne, render, textOf } from "./support/markup.js";
import type { ElementNode } from "./support/markup.js";

const copy: CountDenominatorsCopy = {
  heading: "What was counted",
  physicalRows: { label: "Physical rows", definition: "Rows read from the admitted files, before any exclusion." },
  billableSourceUnits: { label: "Billable source units", definition: "The units the price is quoted on: the denominator of the Billable unit." },
  outputRows: { label: "Output rows", definition: "Rows in each delivered file, counted file by file.", empty: "No file has been delivered yet." },
  safeText: { formulaMarker: "Formula", showFullValue: "Show full value" },
};

// A flat source projected into a companies file, a contacts file and a relationships file.
const files: readonly OutputFileCount[] = [
  { id: "companies", name: "companies.csv", rows: 310 },
  { id: "contacts", name: "contacts.csv", rows: "1150" },
  { id: "relationships", name: "relationships.csv", rows: 1462n },
];

const panel = (overrides: Partial<Parameters<typeof CountDenominators>[0]> = {}) =>
  createElement(CountDenominators, { physicalRows: 1200, billableSourceUnits: "1150", outputFiles: files, copy, ...overrides });

function measure(root: ElementNode, label: string): { readonly group: ElementNode; readonly terms: ElementNode; readonly values: ElementNode[] } {
  const terms = findAll(root, "dt").filter((dt) => textOf(dt) === label);
  assert.equal(terms.length, 1, `one term labelled ${label}`);
  const term = terms[0] as ElementNode;
  const group = term.parent as ElementNode;
  assert.equal(group.tag, "div");
  return { group, terms: term, values: findAll(group, "dd") };
}

test("R2-065: the count panel shows physical rows, billable source units and output rows as three labelled measures with their definitions, never one records figure", () => {
  const { root } = render(panel());

  // Three separately labelled measures in one description list, in a fixed order.
  const list = findOne(root, "dl");
  const terms = findAll(list, "dt");
  assert.deepEqual(terms.map((t) => textOf(t)), [copy.physicalRows.label, copy.billableSourceUnits.label, copy.outputRows.label]);
  assert.equal(findAll(list, "div").filter((d) => d.parent === list).length, 3, "each measure is its own group");
  const section = findOne(root, "section");
  const heading = findOne(root, "h3");
  assert.equal(section.attrs.get("aria-labelledby"), heading.attrs.get("id"));
  assert.equal(textOf(heading), copy.heading);

  // Each measure carries its own value and its own definition, in that order, inside its own group.
  const physical = measure(root, copy.physicalRows.label);
  assert.deepEqual(physical.values.map((d) => textOf(d)), ["1,200", copy.physicalRows.definition]);
  const billable = measure(root, copy.billableSourceUnits.label);
  assert.deepEqual(billable.values.map((d) => textOf(d)), ["1,150", copy.billableSourceUnits.definition]);
  const output = measure(root, copy.outputRows.label);
  assert.equal(output.values.length, 2);
  assert.equal(textOf(output.values[1] as ElementNode), copy.outputRows.definition);

  // Output rows are those of each delivered file, one line per file, each with its own count.
  const lines = findAll(output.group, "li");
  assert.deepEqual(lines.map((li) => textOf(findOne(li, "bdi"))), ["companies.csv", "contacts.csv", "relationships.csv"]);
  assert.deepEqual(lines.map((li) => textOf(byClass(li, "kauro-count")[0] as ElementNode)), ["310", "1,150", "1,462"]);

  // Never one figure: the physical and billable figures differ here and are shown as such, nothing is added up, and the
  // only words on the panel are the copy the caller supplied.
  const text = textOf(root);
  assert.equal(text.includes("2,922"), false, "the sum of the output files is not presented as a figure");
  assert.equal(text.includes("2,350"), false, "physical rows plus billable units is not presented either");
  assert.equal(findAll(list, "dd").filter((d) => byClass(d, "kauro-count").length > 0 && findAll(d, "ul").length === 0).length, 2, "exactly two single-figure measures");
  const words = [copy.heading, copy.physicalRows.label, copy.physicalRows.definition, copy.billableSourceUnits.label, copy.billableSourceUnits.definition, copy.outputRows.label, copy.outputRows.definition, "1,200", "1,150", "310", "1,150", "1,462", "companies.csv", "contacts.csv", "relationships.csv"];
  assert.equal(words.reduce((rest, word) => rest.replace(word, ""), text).trim(), "", "no text the caller did not supply");
  assert.doesNotMatch(text.toLowerCase(), /\brecords?\b/);

  // The measures cannot be made to look the same: identical labels or definitions are refused, and so is a count that is not
  // a whole non-negative number.
  const refuse = (element: ReturnType<typeof panel>) => () => renderToStaticMarkup(element);
  assert.throws(refuse(panel({ copy: { ...copy, billableSourceUnits: { ...copy.billableSourceUnits, label: copy.physicalRows.label } } })), RangeError);
  assert.throws(refuse(panel({ copy: { ...copy, outputRows: { ...copy.outputRows, definition: copy.physicalRows.definition } } })), RangeError);
  assert.throws(refuse(panel({ physicalRows: -1 })), RangeError);
  assert.throws(refuse(panel({ billableSourceUnits: "1.5" })), RangeError);
  assert.throws(refuse(panel({ physicalRows: Number.NaN })), RangeError);
  assert.throws(refuse(panel({ outputFiles: [{ id: "a", name: "a.csv", rows: -3 }] })), RangeError);
  assert.throws(refuse(panel({ outputFiles: [files[0] as OutputFileCount, files[0] as OutputFileCount] })), RangeError, "two lines for one file");
});

test("a source with no delivered file yet shows the empty statement instead of an output figure, and a hostile file name stays inert text", () => {
  const empty = render(panel({ outputFiles: [] }));
  const output = measure(empty.root, copy.outputRows.label);
  assert.deepEqual(output.values.map((d) => textOf(d)), [copy.outputRows.empty, copy.outputRows.definition]);
  assert.equal(findAll(output.group, "li").length, 0);

  const hostile = render(panel({ outputFiles: [{ id: "x", name: '<img src=x onerror="alert(1)">.csv', rows: 3 }] }));
  assert.equal(findAll(hostile.root, "img").length, 0);
  assert.equal(textOf(findOne(hostile.root, "bdi")), '<img src=x onerror="alert(1)">.csv');
});
