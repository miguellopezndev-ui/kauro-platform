import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { Count, DataTable, SafeText } from "../src/index.js";
import type { DataTableColumn, DataTableCopy, DataTableProps } from "../src/index.js";
import { byClass, findAll, findOne, render, textOf, tokensOf } from "./support/markup.js";
import type { ElementNode } from "./support/markup.js";

interface Client {
  readonly id: string;
  readonly name: string;
  readonly rows: number;
}

const copy: DataTableCopy = {
  empty: "No clients yet",
  paginationLabel: "Pages",
  position: (shown, total) => `Showing ${shown} of ${total}`,
  previous: "Previous page",
  next: "Next page",
};

const columns: DataTableColumn<Client>[] = [
  { id: "name", header: "Client", cell: (row) => row.name, rowHeader: true, sortable: true },
  { id: "rows", header: "Rows", cell: (row) => createElement(Count, { value: row.rows }), align: "end", sortable: true },
  { id: "id", header: "Reference", cell: (row) => row.id },
];

const rows: Client[] = [
  { id: "c-1", name: "Acme Ltd", rows: 1200 },
  { id: "c-2", name: "Birch & Co", rows: 310 },
];

const table = (overrides: Partial<DataTableProps<Client>> = {}) =>
  createElement(DataTable<Client>, { caption: "Clients", columns, rows, rowKey: (row) => row.id, onSort: () => undefined, copy, ...overrides });

test("D-DS-1: a data table is a real table — named by its caption, with a column header per column, a row header per row and the cells under them — inside a named, keyboard-reachable region", () => {
  const { root } = render(table());
  const [region, ...otherRegions] = findAll(root, "div").filter((d) => d.attrs.get("role") === "region");
  assert.ok(region !== undefined && otherRegions.length === 0, "exactly one region");
  assert.equal(region.attrs.get("tabindex"), "0", "a scrolling region is reachable from the keyboard");
  const caption = findOne(root, "caption");
  assert.deepEqual(tokensOf(region, "aria-labelledby"), [caption.attrs.get("id")]);
  assert.equal(textOf(caption), "Clients");
  assert.deepEqual(findAll(root, "thead").length, 1);
  const headerCells = findAll(findOne(root, "thead"), "th");
  assert.deepEqual(headerCells.map((th) => th.attrs.get("scope")), ["col", "col", "col"]);
  assert.deepEqual(headerCells.map((th) => textOf(th)), ["Client", "Rows", "Reference"]);
  const bodyRows = findAll(findOne(root, "tbody"), "tr");
  assert.equal(bodyRows.length, 2);
  for (const row of bodyRows) {
    assert.deepEqual(findAll(row, "th").map((th) => th.attrs.get("scope")), ["row"], "exactly one row header per row");
    assert.equal(findAll(row, "td").length, 2);
  }
  assert.deepEqual(bodyRows.map((row) => findAll(row, "th").map((th) => textOf(th))), [["Acme Ltd"], ["Birch & Co"]]);
  assert.deepEqual(bodyRows.map((row) => findAll(row, "td").map((td) => textOf(td))), [["1,200", "c-1"], ["310", "c-2"]]);
  assert.equal(byClass(root, "kauro-table-end").length, 3, "the numeric column's header and two cells align to the end");
});

test("D-DS-1: a sortable header is a button with a name, says its sort state with aria-sort, and shows the direction with an icon and never with colour alone", () => {
  const ascending = render(table({ sort: { columnId: "name", direction: "ascending" } })).root;
  const heads = findAll(findOne(ascending, "thead"), "th");
  assert.deepEqual(heads.map((th) => th.attrs.get("aria-sort")), ["ascending", "none", undefined], "the unsortable column has no aria-sort");
  const buttons = findAll(ascending, "button");
  assert.deepEqual(buttons.map((b) => textOf(b)), ["Client", "Rows"]);
  assert.deepEqual(buttons.map((b) => b.attrs.get("type")), ["button", "button"]);
  for (const button of buttons) assert.equal(findAll(button, "svg").length, 1);
  assert.equal(findAll(buttons[0] as ElementNode, "svg")[0]?.attrs.get("aria-hidden"), "true");
  const descending = render(table({ sort: { columnId: "rows", direction: "descending" } })).root;
  assert.deepEqual(findAll(findOne(descending, "thead"), "th").map((th) => th.attrs.get("aria-sort")), ["none", "descending", undefined]);
  const unsorted = render(table()).root;
  assert.deepEqual(findAll(findOne(unsorted, "thead"), "th").map((th) => th.attrs.get("aria-sort")), ["none", "none", undefined]);
  // The active column's three icons (ascending, descending, not sorted) differ, so the state is readable without colour.
  const shapes = [[ascending, 0], [descending, 1], [unsorted, 0]].map(([r, at]) => findAll(findAll(r as ElementNode, "button")[at as number] as ElementNode, "path").map((p) => p.attrs.get("d")).join("|"));
  assert.equal(new Set(shapes).size, 3);
});

test("D-DS-1: with no rows the table says so in a single cell that spans every column, and with no pagination it has no navigation", () => {
  const { root } = render(table({ rows: [] }));
  const cells = findAll(findOne(root, "tbody"), "td");
  assert.equal(cells.length, 1);
  assert.equal(cells[0]?.attrs.get("colspan"), "3");
  assert.equal(textOf(cells[0] as ElementNode), "No clients yet");
  assert.equal(findAll(root, "nav").length, 0);
});

test("D-DS-1: keyset pagination says 'n of N' with exact counts and moves by links; a page with no neighbour has no link for it", () => {
  const both = render(table({ pagination: { shown: 25, total: "1204", previousHref: "/clients?before=c-1", nextHref: "/clients?after=c-2" } })).root;
  const nav = findOne(both, "nav");
  assert.equal(nav.attrs.get("aria-label"), "Pages");
  assert.equal(textOf(findOne(nav, "p")), "Showing 25 of 1,204");
  assert.deepEqual(findAll(nav, "a").map((a) => [a.attrs.get("href"), textOf(a)]), [["/clients?before=c-1", "Previous page"], ["/clients?after=c-2", "Next page"]]);
  const first = render(table({ pagination: { shown: 25n, total: 25n, nextHref: "/clients?after=c-2" } })).root;
  assert.deepEqual(findAll(first, "a").map((a) => textOf(a)), ["Next page"]);
  assert.equal(textOf(findOne(first, "p")), "Showing 25 of 25");
  const last = render(table({ pagination: { shown: 4, total: 4, previousHref: "/clients" } })).root;
  assert.deepEqual(findAll(last, "a").map((a) => textOf(a)), ["Previous page"]);
  assert.throws(() => render(table({ pagination: { shown: 1, total: 2, nextHref: "javascript:alert(1)" } })), RangeError);
  assert.throws(() => render(table({ pagination: { shown: -1, total: 2 } })), RangeError);
  assert.throws(() => render(table({ pagination: { shown: 1, total: "1.5" } })), RangeError);
});

test("D-DS-1: a table that could not be read by a screen reader is refused — no columns, a repeated column, no row header or two, a repeated row, a sort that no header offers", () => {
  assert.throws(() => render(table({ columns: [] })), RangeError);
  assert.throws(() => render(table({ columns: [...columns, { id: "name", header: "Again", cell: () => "" }] })), /column id repeated/);
  assert.throws(() => render(table({ columns: columns.map((c) => ({ ...c, rowHeader: undefined })) })), /exactly one column/);
  assert.throws(() => render(table({ columns: columns.map((c) => ({ ...c, rowHeader: true })) })), /exactly one column/);
  assert.throws(() => render(table({ rows: [...rows, rows[0] as Client] })), /row key repeated/);
  assert.throws(() => render(table({ sort: { columnId: "id", direction: "ascending" } })), /not a sortable column/);
  assert.throws(() => render(table({ sort: { columnId: "missing", direction: "ascending" } })), /not a sortable column/);
  assert.throws(() => render(createElement(DataTable<Client>, { caption: "Clients", columns, rows, rowKey: (row) => row.id, copy })), /no onSort/);
});

test("D-DS-3: an untrusted value in a cell stays inert text inside the table, and a header or caption with markup is escaped", () => {
  const hostile = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';
  const { root, html } = render(
    table({
      caption: hostile,
      columns: [
        { id: "name", header: hostile, cell: (row) => createElement(SafeText, { value: row.name, copy: { formulaMarker: "Formula", showFullValue: "Show full value" } }), rowHeader: true },
      ],
      rows: [{ id: "c-1", name: hostile, rows: 1 }],
    }),
  );
  assert.equal(findAll(root, "script").length, 0);
  assert.equal(findAll(root, "img").length, 0);
  assert.doesNotMatch(html, /<script|<img/);
  assert.equal(textOf(findOne(root, "caption")), hostile);
  assert.equal(textOf(findOne(findOne(root, "tbody"), "th")), hostile);
});
