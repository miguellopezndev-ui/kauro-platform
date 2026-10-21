// The parts the rebuilt public pages share (Order 11 round 2): one type scale, one section, one closing band, one way to write a list of
// facts and a table of limits. They exist because the round-2 research measured the old pages and found three faults behind most of what
// looked wrong: no shared type scale (h1 of 52, 68 or 84 px; h2 from 12 to 67 px), the same fact repeated on one page, and every page
// ending in a different action.
//   - A page that opens a path (Supported services, Pricing, How it works, Sample delivery) has the larger heading; a reference page (Data
//     handling, Help, Contact, Service status) the smaller one. Every section heading on every page is one size, and a closing heading is
//     never larger than the others.
//   - A decision page ends in the same closing band: one heading, one sentence, the site's one call to action, at most two text links.
// Plain semantic HTML with kauro-r2-* classes (public.css, the round-2 block at its end); nothing here holds state or uses an inline style.
import type { ReactElement, ReactNode } from "react";
import { PUBLIC_COPY } from "../copy/public.ts";
import type { Availability } from "./capabilities.ts";
import { Headline, stateText } from "./parts.tsx";
import type { ServiceMode } from "./pricing-bands.ts";
import { ROUTE } from "./site.ts";

/** The order the services are shown in on every rebuilt page: the two qualified destinations first, the cleanup without a destination last. */
export const SERVICE_ORDER: readonly ServiceMode[] = ["HUBSPOT", "SALESFORCE", "CLEAN"];

const join = (...names: ReadonlyArray<string | false | undefined>): string => names.filter((name): name is string => typeof name === "string" && name !== "").join(" ");

export interface HeadProps {
  /** "path" for a page that opens a journey, "reference" for a page read to check something. */
  readonly kind: "path" | "reference";
  readonly eyebrow: string;
  readonly title: string;
  readonly lead?: string | undefined;
  /** How many of the title's last words are set in the light accent weight (path pages only). */
  readonly accent?: number;
  /** Lines under the lead: the page's meta line, a badge, actions. */
  readonly children?: ReactNode;
  /** A figure beside the head on a wide screen. */
  readonly aside?: ReactNode;
}

export function Head({ kind, eyebrow, title, lead, accent = 0, children, aside }: HeadProps): ReactElement {
  return (
    <div className={join("kauro-r2-head", `kauro-r2-head--${kind}`, aside !== undefined && "kauro-r2-head--aside")}>
      <div className="kauro-site-wrap kauro-r2-head-inner">
        <div className="kauro-r2-head-text">
          <p className="kauro-site-eyebrow">{eyebrow}</p>
          <h1>{kind === "path" ? <Headline text={title} accent={accent} /> : title}</h1>
          {lead === undefined ? null : <p className="kauro-r2-lead">{lead}</p>}
          {children}
        </div>
        {aside === undefined ? null : <div className="kauro-r2-head-aside">{aside}</div>}
      </div>
    </div>
  );
}

export interface BlockProps {
  readonly id: string;
  readonly heading: string;
  readonly lead?: ReactNode;
  readonly children: ReactNode;
  /** "plain" sits on the page; "sunken" one step below it, to set a section apart without a border. */
  readonly tone?: "plain" | "sunken";
  /** "split" puts the heading beside the content on a wide screen (reference sections); "stack" above it. */
  readonly layout?: "stack" | "split";
  readonly variant?: string;
}

/** A section named by its own h2 (id `<id>-heading`), at the one section size of the site. */
export function Block({ id, heading, lead, children, tone = "plain", layout = "stack", variant }: BlockProps): ReactElement {
  return (
    <section id={id} className={join("kauro-r2-block", `kauro-r2-block--${tone}`, `kauro-r2-block--${layout}`, variant)} aria-labelledby={`${id}-heading`}>
      <div className="kauro-site-wrap kauro-r2-block-inner">
        <div className="kauro-r2-block-head">
          <h2 id={`${id}-heading`}>{heading}</h2>
          {lead === undefined ? null : <p className="kauro-r2-block-lead">{lead}</p>}
        </div>
        <div className="kauro-r2-block-body">{children}</div>
      </div>
    </section>
  );
}

export interface TextLink {
  readonly href: string;
  readonly label: string;
}

/**
 * The end of a decision page: one heading at the section size, one sentence, the site's one call to action as the only filled button, and
 * at most two quiet links. The same band on every page, so the reader learns where the next step is.
 */
export function Closing({ id, heading, body, primary, links = [] }: { readonly id: string; readonly heading: string; readonly body: string; readonly primary: TextLink; readonly links?: readonly TextLink[] }): ReactElement {
  return (
    <section id={id} className="kauro-r2-closing" aria-labelledby={`${id}-heading`}>
      <div className="kauro-site-wrap kauro-r2-closing-inner">
        <div>
          <h2 id={`${id}-heading`}>{heading}</h2>
          <p>{body}</p>
        </div>
        <div className="kauro-r2-closing-actions">
          <a className="kauro-site-button kauro-site-button--primary" href={primary.href}>
            {primary.label}
          </a>
          {links.slice(0, 2).map((link) => (
            <a key={link.href + link.label} className="kauro-site-arrow" href={link.href}>
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The site's one call to action, as the closing band carries it. */
export const CHECK_CTA: TextLink = Object.freeze({ href: ROUTE.contact, label: PUBLIC_COPY["public.cta.request-health-check.cta"] });

/** A service's availability as a tag: the words always, a mark of colour beside them, never the colour alone. */
export function StateTag({ availability }: { readonly availability: Availability }): ReactElement {
  return <p className={`kauro-r2-state kauro-r2-state--${availability.toLowerCase()}`}>{stateText(availability)}</p>;
}

/** Facts as label and value, each on its own row: the answer first, readable at a glance (a summary list). */
export function Facts({ rows, variant }: { readonly rows: ReadonlyArray<{ readonly key: string; readonly label: string; readonly value: ReactNode }>; readonly variant?: string }): ReactElement {
  return (
    <dl className={join("kauro-r2-facts", variant)}>
      {rows.map((row) => (
        <div key={row.key} className="kauro-r2-fact">
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface GroupedRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/**
 * A table of label and value, grouped by what each value applies to (a file, a set, a project). Every value is set at reading size, one weight
 * above its label and aligned on the right: a lookup, never a poster of figures.
 */
export function GroupedTable({ caption, groups }: { readonly caption: string; readonly groups: ReadonlyArray<{ readonly key: string; readonly label: string; readonly rows: readonly GroupedRow[] }> }): ReactElement {
  return (
    <div className="kauro-r2-table-region">
      <table className="kauro-r2-grouped">
        <caption>{caption}</caption>
        {groups.map((group) => (
          <tbody key={group.key}>
            <tr className="kauro-r2-grouped-group">
              <th scope="rowgroup" colSpan={2}>
                {group.label}
              </th>
            </tr>
            {group.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{row.value}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
