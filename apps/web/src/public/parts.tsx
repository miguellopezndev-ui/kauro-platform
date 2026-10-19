// The small pieces the public pages are built from: a page head, a labelled section, a link styled as a button, the state of a service, a
// figure inside a sentence and a table. Plain semantic HTML with kauro-site-* classes (see public.css); nothing here holds state, reads a
// router or uses an inline style.
//
// Tones (amendment A10): a section is drawn on the page ("plain"), one step below it ("sunken"), on clay ("clay"), as a carbon band
// ("inverse") or as a wine band ("wine"). The two bands are the design system's .kauro-inverse and .kauro-wine, so every token inside them
// follows the band, in either theme.
import { Fragment, type ReactElement, type ReactNode } from "react";
import { PUBLIC_COPY, copy, type CopyValues, type PublicCopyId } from "../copy/public.ts";
import type { Availability } from "./capabilities.ts";
import type { ServiceMode } from "./pricing-bands.ts";

export type Tone = "plain" | "sunken" | "clay" | "inverse" | "wine";

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  plain: "kauro-site-tone-plain",
  sunken: "kauro-site-tone-sunken",
  clay: "kauro-site-tone-clay",
  inverse: "kauro-inverse kauro-site-tone-band",
  wine: "kauro-wine kauro-site-tone-band",
};

const classes = (...names: ReadonlyArray<string | false | undefined>): string => names.filter((name): name is string => typeof name === "string" && name !== "").join(" ");

/** The small label above a heading: a short rule and a word or two that say which part of the site this is. */
export function Eyebrow({ children }: { readonly children: ReactNode }): ReactElement {
  return <p className="kauro-site-eyebrow">{children}</p>;
}

export interface PageHeadProps {
  readonly title: string;
  readonly lead?: string | undefined;
  readonly eyebrow?: string | undefined;
  /** Actions and notes under the lead. */
  readonly children?: ReactNode;
  /** A figure beside the head on a wide screen (below it on a narrow one). */
  readonly aside?: ReactNode;
  readonly tone?: Tone;
  /** "compact" for a page whose content is the point (prices, a form, a reference): less room above the fold goes to the head. */
  readonly size?: "default" | "compact";
  /** How many of the headline's last words are set in the light accent weight (the words themselves never change). */
  readonly accent?: number;
  /** A modifier of the head's own look, for the page that owns it. */
  readonly variant?: string | undefined;
}

/**
 * A headline with its last words set apart: the same text, in two weights. The split is at a space of the catalogue's own sentence, so the
 * heading reads exactly as the registry writes it (a screen reader and the tests read one sentence).
 */
export function Headline({ text, accent = 0 }: { readonly text: string; readonly accent?: number }): ReactElement {
  const words = text.split(" ");
  if (accent <= 0 || accent >= words.length) return <>{text}</>;
  return (
    <>
      {words.slice(0, words.length - accent).join(" ")} <span className="kauro-site-accent">{words.slice(words.length - accent).join(" ")}</span>
    </>
  );
}

/** A rubber stamp: the label a synthetic sample must carry, set at an angle like a mark on a printed proof. */
export function Stamp({ children }: { readonly children: ReactNode }): ReactElement {
  return <span className="kauro-site-stamp">{children}</span>;
}

export function PageHead({ title, lead, eyebrow, children, aside, tone = "plain", size = "default", accent = 0, variant }: PageHeadProps): ReactElement {
  return (
    <div className={classes("kauro-site-pagehead", TONE_CLASS[tone], aside !== undefined && "kauro-site-pagehead--aside", size === "compact" && "kauro-site-pagehead--compact", variant)}>
      <div className="kauro-site-wrap kauro-site-pagehead-inner">
        <div className="kauro-site-pagehead-title">
          {eyebrow === undefined ? null : <Eyebrow>{eyebrow}</Eyebrow>}
          <h1>
            <Headline text={title} accent={accent} />
          </h1>
        </div>
        {lead === undefined && children === undefined ? null : (
          <div className="kauro-site-pagehead-body">
            {lead === undefined ? null : <p className="kauro-site-lead">{lead}</p>}
            {children}
          </div>
        )}
        {aside === undefined ? null : <div className="kauro-site-pagehead-aside">{aside}</div>}
      </div>
    </div>
  );
}

export interface SectionProps {
  readonly id: string;
  readonly heading: string;
  readonly children: ReactNode;
  readonly eyebrow?: string | undefined;
  readonly lead?: ReactNode;
  /** Anything that belongs with the heading rather than the content (a legend, a key). */
  readonly headExtra?: ReactNode;
  /** "split" puts the heading beside the content on a wide screen; "stack" (the default) above it. */
  readonly layout?: "stack" | "split";
  readonly tone?: Tone;
  /** A modifier of the section's own look, for the page that owns it. */
  readonly variant?: string | undefined;
}

/** A section named by its own h2: the heading's id is `<id>-heading`, and the section's id is the anchor `#<id>`. */
export function Section({ id, heading, children, eyebrow, lead, headExtra, layout = "stack", tone = "plain", variant }: SectionProps): ReactElement {
  return (
    <section id={id} className={classes("kauro-site-section", `kauro-site-section--${layout}`, TONE_CLASS[tone], variant)} aria-labelledby={`${id}-heading`}>
      <div className="kauro-site-wrap kauro-site-section-inner">
        <div className="kauro-site-section-head">
          {eyebrow === undefined ? null : <Eyebrow>{eyebrow}</Eyebrow>}
          <h2 id={`${id}-heading`}>{heading}</h2>
          {lead === undefined ? null : <p className="kauro-site-section-lead">{lead}</p>}
          {headExtra}
        </div>
        <div className="kauro-site-section-body">{children}</div>
      </div>
    </section>
  );
}

export type ButtonKind = "primary" | "secondary" | "text";

/** A link that looks like a button; at most one primary action leads a page. "text" is a quiet link with an arrow. */
export function LinkButton({ href, primary = false, kind, children }: { readonly href: string; readonly primary?: boolean; readonly kind?: ButtonKind; readonly children: ReactNode }): ReactElement {
  const shown: ButtonKind = kind ?? (primary ? "primary" : "secondary");
  const name = shown === "primary" ? "kauro-site-button kauro-site-button--primary" : shown === "text" ? "kauro-site-arrow" : "kauro-site-button";
  return (
    <a className={name} href={href}>
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

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/**
 * A message with its figures set apart: the same words as copy(id, values) — copy() is called first, so a missing or unused value throws
 * exactly as it does there — with each filled placeholder wrapped in a figure, so a number reads as the point of the sentence.
 */
export function rich(id: PublicCopyId, values: CopyValues): ReactNode {
  copy(id, values);
  const text: string = PUBLIC_COPY[id];
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <strong key={`${match[1]}-${at}`} className="kauro-site-figure">
        {String(values[match[1] ?? ""])}
      </strong>,
    );
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.map((part, index) => <Fragment key={index}>{part}</Fragment>);
}

/** A price as the ladder shows it: the currency set small before the amount ("USD 695"), the same words a sentence would write. */
export function PriceFigure({ amount }: { readonly amount: string }): ReactElement {
  const [currency, ...rest] = amount.split(" ");
  return (
    <p className="kauro-site-price">
      <span className="kauro-site-price-currency">{currency}</span> {rest.join(" ")}
    </p>
  );
}

/** A file name as the delivery writes it: monospaced, never translated. */
export function FileName({ children }: { readonly children: string }): ReactElement {
  return <span className="kauro-site-file">{children}</span>;
}

/** A table with its caption first and a scope on every header cell; `rowHeaders` makes the first cell of a body row a row header. */
export function DataTable({
  caption,
  columns,
  rows,
  variant,
}: {
  readonly caption: string;
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<{ readonly key: string; readonly head: string; readonly cells: readonly string[] }>;
  readonly variant?: string | undefined;
}): ReactElement {
  // A table of four columns or more is laid out row by row on a phone (Order 10): each value carries its column's name, so no word has to
  // break inside a narrow column. The table stays a table for assistive technology.
  const stacked = columns.length >= 4;
  return (
    <div className={classes("kauro-site-table-region", variant)}>
      <table className={classes("kauro-site-table", stacked ? "kauro-site-table--stack" : undefined)}>
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
                <td key={`${row.key}-${columns[index + 1] ?? index}`} data-label={stacked ? columns[index + 1] : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
