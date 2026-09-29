// The small pieces the public pages are built from: a page head, a labelled section, a link styled as a button, the state of a service and
// a table. Plain semantic HTML with kauro-site-* classes (see public.css); nothing here holds state, reads a router or uses an inline style.
import type { ReactElement, ReactNode } from "react";
import { PUBLIC_COPY, type PublicCopyId } from "../copy/public.ts";
import type { Availability } from "./capabilities.ts";
import type { ServiceMode } from "./pricing-bands.ts";

export function PageHead({ title, lead }: { readonly title: string; readonly lead?: string }): ReactElement {
  return (
    <div className="kauro-site-pagehead">
      <h1>{title}</h1>
      {lead === undefined ? null : <p className="kauro-site-lead">{lead}</p>}
    </div>
  );
}

/** A section named by its own h2: the heading's id is `<id>-heading`, and the section's id is the anchor `#<id>`. */
export function Section({ id, heading, children }: { readonly id: string; readonly heading: string; readonly children: ReactNode }): ReactElement {
  return (
    <section id={id} className="kauro-site-section" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>{heading}</h2>
      {children}
    </section>
  );
}

/** A link that looks like a button; at most one primary action leads a page. */
export function LinkButton({ href, primary = false, children }: { readonly href: string; readonly primary?: boolean; readonly children: ReactNode }): ReactElement {
  return (
    <a className={primary ? "kauro-site-button kauro-site-button--primary" : "kauro-site-button"} href={href}>
      {children}
    </a>
  );
}

const STATE_ID: Readonly<Record<Availability, PublicCopyId>> = {
  AVAILABLE: "services.mode.available",
  LIMITED: "services.mode.limited",
  CLOSED: "services.mode.unavailable",
  UNREAD: "services.mode.unread",
};

/** The words for a service's availability; the state is always written out, never only a colour. */
export function stateText(availability: Availability): string {
  return PUBLIC_COPY[STATE_ID[availability]];
}

export function ServiceState({ availability }: { readonly availability: Availability }): ReactElement {
  return <p className={`kauro-site-state kauro-site-state--${availability.toLowerCase()}`}>{stateText(availability)}</p>;
}

export const MODE_ORDER: readonly ServiceMode[] = ["CLEAN", "HUBSPOT", "SALESFORCE"];

/** A table with its caption first and a scope on every header cell; `rowHeaders` makes the first cell of a body row a row header. */
export function DataTable({
  caption,
  columns,
  rows,
}: {
  readonly caption: string;
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<{ readonly key: string; readonly head: string; readonly cells: readonly string[] }>;
}): ReactElement {
  return (
    <table className="kauro-site-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <th scope="row">{row.head}</th>
            {row.cells.map((cell, index) => (
              <td key={`${row.key}-${columns[index + 1] ?? index}`}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
