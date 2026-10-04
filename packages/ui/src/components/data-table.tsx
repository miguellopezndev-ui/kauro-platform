import { useId } from "react";
import type { ReactElement, ReactNode } from "react";
import { formatCount } from "../format.js";
import type { CountValue } from "../format.js";
import { CLASS, cx } from "../internal/class-names.js";
import { Icon } from "../internal/icon.js";
import { LinkButton } from "./button.js";

/**
 * DataTable (B11 D-DS-1): a real table — a caption that names it, header cells with scope, one row-header cell per row that
 * gives the row its identity, sortable headers that are buttons and say their state with aria-sort, and keyset pagination that
 * says "n of N" and moves by links (a cursor in the address, not a page number). Wider than the screen, it scrolls inside a
 * focusable, named region, so the page itself never scrolls sideways (WCAG 2.2 SC 1.4.10).
 *
 * A sortable column needs `onSort`, a function, so a table with sortable columns is rendered from a client component.
 * The words come from the caller's copy catalogue: this package holds none.
 */

export type SortDirection = "ascending" | "descending";

export interface DataTableColumn<Row> {
  /** Stable id of the column. */
  readonly id: string;
  /** The header text. */
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
  /** The column whose cell names the row (rendered as a row header). Exactly one column has it. */
  readonly rowHeader?: boolean | undefined;
  readonly sortable?: boolean | undefined;
  /** Numbers and amounts align to the end. */
  readonly align?: "start" | "end" | undefined;
}

export interface DataTablePagination {
  /** How many rows this page shows. */
  readonly shown: CountValue;
  /** How many rows there are in all. */
  readonly total: CountValue;
  /** Where the previous and next keyset pages are; a page with no such neighbour has none. */
  readonly previousHref?: string | undefined;
  readonly nextHref?: string | undefined;
}

export interface DataTableCopy {
  /** Shown in place of the rows when there are none. */
  readonly empty: string;
  /** The name of the pagination navigation, for example "Pages". */
  readonly paginationLabel: string;
  /** Shown as the position, given the formatted counts: ("25", "1,204") gives "Showing 25 of 1,204". */
  readonly position: (shown: string, total: string) => string;
  readonly previous: string;
  readonly next: string;
}

export interface DataTableProps<Row> {
  /** The table's accessible name. */
  readonly caption: string;
  readonly columns: readonly DataTableColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly sort?: { readonly columnId: string; readonly direction: SortDirection } | undefined;
  readonly onSort?: ((columnId: string) => void) | undefined;
  readonly pagination?: DataTablePagination | undefined;
  readonly copy: DataTableCopy;
}

function assertColumns<Row>(columns: readonly DataTableColumn<Row>[], sort: DataTableProps<Row>["sort"], onSort: DataTableProps<Row>["onSort"]): void {
  if (columns.length === 0) throw new RangeError("a table needs at least one column");
  const ids = new Set<string>();
  for (const column of columns) {
    if (ids.has(column.id)) throw new RangeError(`column id repeated: ${column.id}`);
    ids.add(column.id);
    if (column.sortable === true && onSort === undefined) throw new RangeError(`column ${column.id} is sortable but the table has no onSort`);
  }
  if (columns.filter((column) => column.rowHeader === true).length !== 1) throw new RangeError("exactly one column must be the row header");
  if (sort !== undefined && columns.find((column) => column.id === sort.columnId)?.sortable !== true) {
    throw new RangeError(`the table is sorted by ${sort.columnId}, which is not a sortable column`);
  }
}

export function DataTable<Row>({ caption, columns, rows, rowKey, sort, onSort, pagination, copy }: DataTableProps<Row>): ReactElement {
  const captionId = useId();
  assertColumns(columns, sort, onSort);
  const keys = new Set<string>();
  for (const row of rows) {
    const key = rowKey(row);
    if (keys.has(key)) throw new RangeError(`row key repeated: ${key}`);
    keys.add(key);
  }
  return (
    <div>
      <div className={CLASS.tableRegion} role="region" aria-labelledby={captionId} tabIndex={0}>
        <table className={CLASS.table}>
          <caption id={captionId} className={CLASS.tableCaption}>
            {caption}
          </caption>
          <thead>
            <tr>
              {columns.map((column) => {
                const active = sort?.columnId === column.id ? sort.direction : undefined;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={column.sortable === true ? (active ?? "none") : undefined}
                    className={cx(column.align === "end" && CLASS.tableEnd)}
                  >
                    {column.sortable === true ? (
                      <button type="button" className={CLASS.sortButton} onClick={() => onSort?.(column.id)}>
                        {column.header}
                        <Icon name={active === "ascending" ? "sort-ascending" : active === "descending" ? "sort-descending" : "sort"} />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className={CLASS.tableEmpty}>
                  {copy.empty}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={rowKey(row)}>
                  {columns.map((column) =>
                    column.rowHeader === true ? (
                      <th key={column.id} scope="row" className={cx(column.align === "end" && CLASS.tableEnd)}>
                        {column.cell(row)}
                      </th>
                    ) : (
                      <td key={column.id} className={cx(column.align === "end" && CLASS.tableEnd)}>
                        {column.cell(row)}
                      </td>
                    ),
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {pagination === undefined ? null : (
        <nav className={CLASS.pagination} aria-label={copy.paginationLabel}>
          <p>{copy.position(formatCount(pagination.shown, "shown"), formatCount(pagination.total, "total"))}</p>
          {pagination.previousHref === undefined ? null : <LinkButton href={pagination.previousHref}>{copy.previous}</LinkButton>}
          {pagination.nextHref === undefined ? null : <LinkButton href={pagination.nextHref}>{copy.next}</LinkButton>}
        </nav>
      )}
    </div>
  );
}
