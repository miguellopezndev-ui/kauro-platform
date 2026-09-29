import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { Banner, PhaseList, StatusBadge } from "../src/index.js";
import type { Phase, PhaseState, Tone } from "../src/index.js";
import type { ElementNode } from "./support/markup.js";
import { byClass, findAll, findOne, render, textOf } from "./support/markup.js";

const TONES: readonly Tone[] = ["neutral", "info", "success", "warning", "danger"];

const PHASE_COPY: Readonly<Record<PhaseState, string>> = { done: "Done", current: "In progress", upcoming: "Not started", failed: "Failed" };

const PHASES: readonly Phase[] = [
  { id: "read", label: "Reading files", state: "done" },
  { id: "match", label: "Matching companies", state: "current", detail: "310 of 1,150 rows" },
  { id: "deliver", label: "Preparing delivery", state: "upcoming" },
];

const shapeOf = (root: ElementNode): string =>
  findAll(findOne(root, "svg"), "path")
    .map((path) => path.attrs.get("d"))
    .join("|");

test("D-DS-1: a status badge is an icon plus text on a tinted surface — never a colour alone — and each of the five tones has its own icon shape", () => {
  const shapes = new Set<string>();
  for (const tone of TONES) {
    const { root } = render(createElement(StatusBadge, { tone, children: `Status ${tone}` }));
    const badge = byClass(root, "kauro-status-badge")[0] as ElementNode;
    assert.equal(byClass(root, "kauro-status-badge").length, 1);
    assert.equal(badge.attrs.get("class"), `kauro-status-badge kauro-tone-${tone}`);
    assert.equal(textOf(badge), `Status ${tone}`);
    const icon = findOne(root, "svg");
    assert.equal(icon.attrs.get("aria-hidden"), "true", "the icon is decorative: the text carries the meaning");
    assert.equal(icon.attrs.get("focusable"), "false");
    assert.equal(icon.attrs.has("style"), false);
    shapes.add(shapeOf(root));
  }
  assert.equal(shapes.size, TONES.length, "no two tones share an icon");
  assert.throws(() => render(createElement(StatusBadge, { tone: "purple" as Tone, children: "x" })), RangeError);
});

test("D-DS-1, D-A11Y-1: a banner carries a tone icon, an optional title and its message, and is announced only when the caller says so — polite as status, assertive as alert, silent by default", () => {
  const silent = render(createElement(Banner, { tone: "info", title: "Import", children: "Rows are being read" })).root;
  const banner = byClass(silent, "kauro-banner")[0] as ElementNode;
  assert.equal(byClass(silent, "kauro-banner").length, 1);
  assert.equal(banner.attrs.has("role"), false);
  assert.equal(banner.attrs.get("class"), "kauro-banner kauro-tone-info");
  assert.equal(textOf(findOne(silent, "p")), "Import");
  assert.match(textOf(banner), /Rows are being read/);
  assert.equal(findAll(silent, "svg").length, 1);
  const polite = render(createElement(Banner, { tone: "success", announce: "status", children: "Saved" })).root;
  assert.equal(findAll(polite, "div").filter((d) => d.attrs.get("role") === "status").length, 1);
  assert.equal(findAll(polite, "p").length, 0, "no title, no title element");
  const assertive = render(createElement(Banner, { tone: "danger", announce: "alert", children: "The file was refused" })).root;
  assert.equal(findAll(assertive, "div").filter((d) => d.attrs.get("role") === "alert").length, 1);
  assert.equal(byClass(assertive, "kauro-tone-danger").length, 1);
  assert.throws(() => render(createElement(Banner, { tone: "loud" as Tone, children: "x" })), RangeError);
});

test("D-DS-3: the text of a badge, a banner and a phase is text — markup in it is escaped and never becomes an element", () => {
  const hostile = "<script>alert(1)</script><b>bold</b>";
  const badge = render(createElement(StatusBadge, { tone: "info", children: hostile }));
  const banner = render(createElement(Banner, { tone: "info", title: hostile, children: hostile }));
  const list = render(createElement(PhaseList, { label: hostile, copy: PHASE_COPY, phases: [{ id: "a", label: hostile, state: "current", detail: hostile }] }));
  for (const { root, html } of [badge, banner, list]) {
    assert.equal(findAll(root, "script").length, 0);
    assert.equal(findAll(root, "b").length, 0);
    assert.doesNotMatch(html, /<script|<b>/);
  }
});

test("D-DS-1: a phase list is an ordered, named list; each phase says its state in words and with an icon, and only the phase in progress is aria-current=step", () => {
  const { root } = render(createElement(PhaseList, { label: "Progress", phases: PHASES, copy: PHASE_COPY }));
  const list = findOne(root, "ol");
  assert.equal(list.attrs.get("aria-label"), "Progress");
  const items = findAll(list, "li");
  assert.deepEqual(items.map((li) => li.attrs.get("aria-current")), [undefined, "step", undefined]);
  assert.deepEqual(items.map((li) => byClass(li, "kauro-phase-label").map((e) => textOf(e))), [["Reading files"], ["Matching companies"], ["Preparing delivery"]]);
  assert.deepEqual(items.map((li) => byClass(li, "kauro-phase-state").map((e) => textOf(e))), [["Done"], ["In progress"], ["Not started"]]);
  assert.match(textOf(items[1] as ElementNode), /310 of 1,150 rows/);
  assert.deepEqual(items.map((li) => li.attrs.get("class")), ["kauro-phase kauro-phase-done", "kauro-phase kauro-phase-current", "kauro-phase kauro-phase-upcoming"]);
  assert.equal(new Set(items.map((li) => shapeOf(li as ElementNode))).size, 3, "the three states have three different icons");
});

test("D-DS-1: a job has phases, not a percentage — no progress bar, no progressbar role and no percent sign is ever drawn, and a failed phase is written as failed", () => {
  const failed: Phase[] = [
    { id: "read", label: "Reading files", state: "done" },
    { id: "match", label: "Matching companies", state: "failed", detail: "The file could not be read" },
  ];
  const { root, html } = render(createElement(PhaseList, { label: "Progress", phases: failed, copy: PHASE_COPY }));
  assert.equal(findAll(root, "progress").length, 0);
  assert.equal(findAll(root, "meter").length, 0);
  assert.doesNotMatch(html, /progressbar|aria-valuenow|aria-valuemax/);
  assert.doesNotMatch(textOf(root), /%/);
  assert.deepEqual(byClass(root, "kauro-phase-state").map((e) => textOf(e)), ["Done", "Failed"]);
  assert.equal(findAll(root, "li").filter((li) => li.attrs.has("aria-current")).length, 0, "nothing is in progress once a phase has failed");
});

test("D-DS-1: a phase list that would misreport a job is refused — a repeated phase, two phases in progress or a state it does not know", () => {
  assert.throws(() => render(createElement(PhaseList, { label: "p", copy: PHASE_COPY, phases: [PHASES[0] as Phase, PHASES[0] as Phase] })), /phase id repeated/);
  assert.throws(() => render(createElement(PhaseList, { label: "p", copy: PHASE_COPY, phases: [{ id: "a", label: "A", state: "current" }, { id: "b", label: "B", state: "current" }] })), /at most one/);
  assert.throws(() => render(createElement(PhaseList, { label: "p", copy: PHASE_COPY, phases: [{ id: "a", label: "A", state: "stuck" as PhaseState }] })), RangeError);
  assert.equal(findAll(render(createElement(PhaseList, { label: "p", copy: PHASE_COPY, phases: [] })).root, "li").length, 0);
  assert.equal(findOne(render(createElement(PhaseList, { label: "p", copy: PHASE_COPY, phases: [] })).root, "ol").attrs.get("aria-label"), "p");
});
