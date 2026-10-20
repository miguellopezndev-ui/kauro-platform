// Fragments of the product, drawn in HTML (A10 §5): small pieces of the Kauro window that show, beside a section, the thing its words
// describe — the files of a set, an import order, the settings a team confirms, a quote. Every value comes
// from the synthetic sample or the policy, every word from the catalogue. A fragment repeats what the section already says in words, so it
// is hidden from assistive technology; the section's text is the information.
import type { ReactElement, ReactNode } from "react";
import { FileName } from "./parts.tsx";

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
