// Fragments of the product, drawn in HTML (A10 §5): small pieces of the Kauro window that show, beside a section, the thing its words
// describe — the counts a check finds, a change waiting for approval, a sum that reconciles, an import order, a quote. Every value comes
// from the synthetic sample or the policy, every word from the catalogue. A fragment repeats what the section already says in words, so it
// is hidden from assistive technology; the section's text is the information.
import type { ReactElement, ReactNode } from "react";
import { PUBLIC_COPY, copy } from "../copy/public.ts";
import { FileName } from "./parts.tsx";
import { formatCount } from "./pricing-bands.ts";

/** The frame of a fragment: a small raised panel, optionally titled like a pane of the product. */
export function Pane({ title, children, variant }: { readonly title?: string; readonly children: ReactNode; readonly variant?: string }): ReactElement {
  return (
    <div className={variant === undefined ? "kauro-site-frag" : `kauro-site-frag ${variant}`} aria-hidden="true">
      {title === undefined ? null : <span className="kauro-site-frag-title">{title}</span>}
      {children}
    </div>
  );
}

/** A note in the margin, in the editor's italic, with a short rule that leads to what it is about. */
export function MarginNote({ children, lead = "start" }: { readonly children: ReactNode; readonly lead?: "start" | "up" }): ReactElement {
  return (
    <span className={`kauro-site-margin kauro-site-margin--${lead}`} aria-hidden="true">
      {children}
    </span>
  );
}

/** Counts as the health check reports them: a figure and what it counts, one per line. */
export function Counts({ rows }: { readonly rows: ReadonlyArray<{ readonly value: number; readonly label: string }> }): ReactElement {
  return (
    <span className="kauro-site-frag-counts">
      {rows.map((row) => (
        <span key={row.label} className="kauro-site-frag-count">
          <span className="kauro-site-frag-figure">{formatCount(row.value)}</span>
          <span className="kauro-site-frag-label">{row.label}</span>
        </span>
      ))}
    </span>
  );
}

/** A proposed change that waits for the customer: what it does, its state, and the control that approves it (drawn, never live). */
export function Approval({ count }: { readonly count: number }): ReactElement {
  return (
    <span className="kauro-site-frag-approval">
      <span className="kauro-site-frag-change">{copy("home.frag.unify", { count })}</span>
      <span className="kauro-site-frag-waiting">{PUBLIC_COPY["home.frag.awaiting"]}</span>
      <span className="kauro-site-frag-button">{PUBLIC_COPY["home.frag.approve"]}</span>
    </span>
  );
}

/** A sum that reconciles: what came in, what goes out, and the word that says the two agree. */
export function Reconcile({ from, to, label }: { readonly from: number; readonly to: number; readonly label: string }): ReactElement {
  return (
    <span className="kauro-site-frag-reconcile">
      <span className="kauro-site-frag-figure">{formatCount(from)}</span>
      <span className="kauro-site-frag-arrow" />
      <span className="kauro-site-frag-figure kauro-site-frag-figure--out">{formatCount(to)}</span>
      <span className="kauro-site-frag-ok">{label}</span>
    </span>
  );
}

/** Files in the order they are imported, numbered. */
export function ImportOrder({ files, plain = false }: { readonly files: readonly string[]; readonly plain?: boolean }): ReactElement {
  return (
    <span className="kauro-site-frag-order">
      {files.map((file) => (
        <span key={file} className="kauro-site-frag-step">
          {plain ? file : <FileName>{file}</FileName>}
        </span>
      ))}
    </span>
  );
}

/** Files as chips, with an optional state beside them (sealed, prepared). */
export function FileChips({ files, state }: { readonly files: readonly string[]; readonly state?: string }): ReactElement {
  return (
    <span className="kauro-site-frag-files">
      {files.map((file) => (
        <span key={file} className="kauro-site-frag-file">
          <FileName>{file}</FileName>
        </span>
      ))}
      {state === undefined ? null : <span className="kauro-site-frag-state">{state}</span>}
    </span>
  );
}

/** Settings as the importer shows them, each with its value. */
export function Settings({ rows }: { readonly rows: ReadonlyArray<{ readonly label: string; readonly value: string }> }): ReactElement {
  return (
    <span className="kauro-site-frag-settings">
      {rows.map((row) => (
        <span key={row.label} className="kauro-site-frag-setting">
          <span>{row.label}</span>
          <span className="kauro-site-frag-switch">{row.value}</span>
        </span>
      ))}
    </span>
  );
}
