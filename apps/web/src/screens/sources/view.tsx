// UI14 source intake, UI15 selection and UI16 seal review as markup. Pure: the containers own the reads and the runs. Every customer
// string (a file name, a sheet name, a column label) goes through SafeText as one text node; every control is offered from the server's
// permittedActions through the model; every count keeps its own label and definition.
import { Banner, Button, Count, Deadline, LinkButton, SafeText, StatusBadge, type Tone } from "@kauro/ui";
import type { ReactElement } from "react";
import type { InspectionFileView, InspectionTableView, InspectionView, SourceRevisionView, UploadView } from "../../api/generated.ts";
import { message } from "../../copy/en.ts";
import { formatBytes, INPUT_LIMITS } from "../../public/limits.ts";
import {
  columnLabel,
  countsView,
  draftProblems,
  EXCLUSION_REASONS,
  exclusionReasonText,
  type Draft,
  type DraftTable,
  type FileProblem,
  type RevisionBlocker,
  sealMeasures,
  sealOffer,
  selectedTables,
  sourcesModel,
  uploadActions,
  uploadFacts,
  type UploadProgress,
} from "./model.ts";

const SAFE = (): { readonly formulaMarker: string; readonly showFullValue: string } => ({ formulaMarker: message("screen.sources.safe.formula"), showFullValue: message("screen.sources.safe.show-full") });
const safe = (value: string): ReactElement => <SafeText value={value} copy={SAFE()} />;

const REVISION_TONE: Readonly<Record<SourceRevisionView["state"], Tone>> = {
  DRAFT: "neutral",
  UPLOADING: "info",
  INSPECTING: "info",
  READY_TO_SEAL: "success",
  SEALED: "success",
  REJECTED: "danger",
  CANCELLED: "neutral",
  SUPERSEDED: "neutral",
  EXPIRED: "neutral",
  DELETED: "neutral",
};

/** The set's state and what still waits on it, as one quiet line above the page's work (Order 11). */
export function RevisionStatus({ revision }: { readonly revision: SourceRevisionView }): ReactElement {
  return (
    <section className="kauro-set-status" aria-labelledby="sources-revision">
      <h2 id="sources-revision">{message("screen.sources.revision.state.label")}</h2>
      <p role="status">
        <StatusBadge tone={REVISION_TONE[revision.state]}>{message(`screen.sources.revision.state.${revision.state}`)}</StatusBadge>
      </p>
      <Blockers blockers={revision.blockers} />
    </section>
  );
}

export function Blockers({ blockers }: { readonly blockers: readonly RevisionBlocker[] }): ReactElement {
  if (blockers.length === 0) return <p className="kauro-set-open">{message("screen.sources.blockers.none.body")}</p>;
  return (
    <div className="kauro-set-open">
      <h3>{message("screen.sources.blockers.heading")}</h3>
      <ul>
        {blockers.map((blocker) => (
          <li key={blocker}>{message(`screen.sources.blocker.${blocker}`)}</li>
        ))}
      </ul>
    </div>
  );
}

/** No project in the address. */
export function NoProject(): ReactElement {
  return (
    <section>
      <h2>{message("screen.sources.none.title")}</h2>
      <p>{message("screen.sources.none.body")}</p>
    </section>
  );
}

// ---------------------------------------------------------------- UI14

export interface SourcesViewProps {
  readonly revision: SourceRevisionView;
  readonly uploads: readonly UploadView[];
  readonly hasMore: boolean;
  /** The configured upload origin; null shows the upload-unavailable state. */
  readonly uploadOrigin: string | null;
  readonly nowMs: number;
  readonly progress: Readonly<Record<string, UploadProgress>>;
  readonly busy: boolean;
  /** What the last chosen file was refused for before anything was sent. */
  readonly refused: FileProblem | null;
  readonly hrefs: { readonly selection: string; readonly seal: string };
  readonly onFile: (file: File) => void;
  readonly onResume: (upload: UploadView, file: File) => void;
  readonly onCancel: (upload: UploadView) => void;
  readonly onMore: () => void;
  readonly onRefresh: () => void;
}

/**
 * A file input. As the page's way to add a file it is a drop area with the limits said before anything is chosen (Order 11); the input
 * covers the whole area, so a file dropped anywhere on it is the input's own, and the keyboard reaches it as one control.
 */
function FileInput({ label, onFile, zone = false }: { readonly label: string; readonly onFile: (file: File) => void; readonly zone?: boolean }): ReactElement {
  const input = (
    <input
      type="file"
      accept=".csv,.xlsx"
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        if (file !== undefined) onFile(file);
      }}
    />
  );
  if (!zone)
    return (
      <label className="kauro-file-input">
        {label}
        {input}
      </label>
    );
  return (
    <label className="kauro-dropzone">
      <span className="kauro-dropzone-title">{message("screen.sources.upload.drop.body")}</span>
      <span className="kauro-dropzone-label">{label}</span>
      <span className="kauro-dropzone-limits">{message("screen.sources.upload.limits.body", { files: INPUT_LIMITS.files, fileSize: INPUT_LIMITS.fileSize, setSize: INPUT_LIMITS.setSize })}</span>
      {input}
    </label>
  );
}

export function UploadFacts({ upload, progress }: { readonly upload: UploadView; readonly progress: UploadProgress | null }): ReactElement {
  const facts = uploadFacts(upload, progress);
  const scanner = facts.scanner;
  return (
    <dl className="kauro-file-facts">
      <div>
        <dt>{message("screen.sources.fact.declared.label")}</dt>
        <dd>
          {formatBytes(facts.declaredBytes)} <span className="kauro-file-bytes">({message("screen.sources.fact.bytes.body", { bytes: facts.declaredBytes })})</span>
        </dd>
      </div>
      <div>
        <dt>{message("screen.sources.fact.progress.label")}</dt>
        <dd>{facts.progress === null ? message("screen.sources.fact.progress.none.body") : message("screen.sources.fact.progress.value.body", { sent: facts.progress.sent, total: facts.progress.total })}</dd>
      </div>
      <div>
        <dt>{message("screen.sources.fact.observation.label")}</dt>
        <dd>{facts.observation === null ? message("screen.sources.fact.observation.none.body") : <>{message("screen.sources.fact.observation.value.body", { bytes: facts.observation.bytes })}{" "}<Deadline at={facts.observation.observedAt} timeZone="UTC" /></>}</dd>
      </div>
      <div>
        <dt>{message("screen.sources.fact.scanner.label")}</dt>
        <dd>
          {scanner.kind === "NOT_INSPECTED" ? (
            message("screen.sources.fact.scanner.none.body")
          ) : (
            <>
              <span className={scanner.state === "COVERED_CLEAN" && scanner.fullyChecked ? "kauro-file-ok" : "kauro-file-warn"}>
                {scanner.state === "COVERED_CLEAN" && !scanner.fullyChecked
                  ? message("screen.sources.fact.scanner.partial.body", { scanned: scanner.coverage.scannedParts, expected: scanner.coverage.expectedParts })
                  : message(`screen.sources.fact.scanner.${scanner.state}`)}
              </span>{" "}
              <span className="kauro-file-bytes">{message("screen.sources.fact.scanner.coverage.body", { ...scanner.coverage })}</span>
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>{message("screen.sources.fact.parser.label")}</dt>
        <dd>
          {facts.parser.kind === "NOT_PARSED" ? message("screen.sources.fact.parser.none.body") : message(`screen.sources.fact.parser.${facts.parser.structure}`)}
          {facts.parser.kind === "PARSED" && !facts.parser.claimConsistent ? <> {message("screen.sources.fact.format.mismatch.body", { format: upload.declaredFormat })}</> : null}
        </dd>
      </div>
      {facts.problems.length === 0 ? null : (
        <div>
          <dt>{message("screen.sources.fact.problems.label")}</dt>
          <dd>
            <ul>
              {facts.problems.map((problem) => (
                <li key={problem}>
                  <code>{problem}</code>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      )}
      {facts.terminalReason === null ? null : (
        <div>
          <dt>{message("screen.sources.fact.reason.label")}</dt>
          <dd>
            <code>{facts.terminalReason}</code>
          </dd>
        </div>
      )}
    </dl>
  );
}

const UPLOAD_TONE: Readonly<Record<UploadView["state"], Tone>> = {
  RESERVED: "neutral",
  UPLOADING: "info",
  VERIFYING: "info",
  ADMITTED: "success",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
  REJECTED: "danger",
};

function UploadRow({ upload, revision, props }: { readonly upload: UploadView; readonly revision: SourceRevisionView; readonly props: SourcesViewProps }): ReactElement {
  const actions = uploadActions(upload, revision, props.nowMs);
  const sending = props.progress[upload.uploadId] ?? null;
  return (
    <li className={`kauro-file kauro-file--${upload.state.toLowerCase()}`}>
      <div className="kauro-file-head">
        <span className="kauro-file-format" aria-hidden="true">
          {upload.declaredFormat}
        </span>
        <h3>{safe(upload.displayName)}</h3>
        <StatusBadge tone={UPLOAD_TONE[upload.state]}>{message(`screen.sources.upload.state.${upload.state}`)}</StatusBadge>
      </div>
      <UploadFacts upload={upload} progress={sending} />
      {upload.state === "RESERVED" || upload.state === "UPLOADING" ? (
        <p className="kauro-file-note">
          {message("screen.sources.expiry.label")}: <Deadline at={upload.applicationExpiresAt} timeZone="UTC" />
        </p>
      ) : null}
      {actions.resume === "OFFERED" ? <FileInput label={message("screen.sources.upload.resume.cta")} onFile={(file) => props.onResume(upload, file)} /> : null}
      {actions.resume === "OFFERED" ? <p className="kauro-file-note">{message("screen.sources.upload.resume.file.hint")}</p> : null}
      {actions.resume === "DISABLED_BY_CLOCK" ? (
        <p className="kauro-file-note">
          <Button variant="secondary" disabled>
            {message("screen.sources.upload.resume.cta")}
          </Button>{" "}
          {message("screen.sources.upload.resume.disabled.body")}
        </p>
      ) : null}
      {actions.newReservation ? (
        <>
          <p className="kauro-file-note">{message("screen.sources.upload.reserve.new.body")}</p>
          <FileInput label={message("screen.sources.upload.reserve.new.cta")} onFile={props.onFile} />
        </>
      ) : null}
      {actions.canCancel ? (
        <div className="kauro-file-actions">
          <Button variant="secondary" disabled={props.busy} onClick={() => (props.busy ? undefined : props.onCancel(upload))}>
            {message("screen.sources.upload.cancel.cta")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function SourcesView(props: SourcesViewProps): ReactElement {
  const { revision } = props;
  const model = sourcesModel(revision, props.uploadOrigin);
  return (
    <div className="kauro-sources">
      <p className="kauro-screen-lead">{message("screen.sources.intake.lead.body")}</p>
      <RevisionStatus revision={revision} />
      <section className="kauro-screen-section" aria-labelledby="sources-add">
        <h2 id="sources-add">{message("screen.sources.upload.heading")}</h2>
        {model.uploadUnavailable ? (
          <Banner tone="warning" title={message("screen.sources.upload.unavailable.title")} announce="status">
            <p>{message("screen.sources.upload.unavailable.body")}</p>
          </Banner>
        ) : null}
        {model.canAdd ? <FileInput zone label={message("screen.sources.upload.field.label")} onFile={props.onFile} /> : null}
        {props.refused === null ? null : <p role="alert">{props.refused === "FORMAT" ? message("screen.sources.upload.format.refused.body") : message("screen.sources.upload.name.refused.body")}</p>}
        {props.busy ? <p role="status">{message("screen.sources.upload.sending.body")}</p> : null}
      </section>
      <section className="kauro-screen-section" aria-labelledby="sources-files">
        <h2 id="sources-files">{message("screen.sources.uploads.heading")}</h2>
        {props.uploads.length === 0 ? (
          <p>{message("screen.sources.uploads.none.body")}</p>
        ) : (
          <ul className="kauro-files">
            {props.uploads.map((upload) => (
              <UploadRow key={upload.uploadId} upload={upload} revision={revision} props={props} />
            ))}
          </ul>
        )}
        {props.hasMore ? (
          <Button variant="secondary" onClick={props.onMore}>
            {message("screen.sources.uploads.more.cta")}
          </Button>
        ) : null}
      </section>
      <p className="kauro-actions">
        {model.canGoToSelection ? (
          <LinkButton href={props.hrefs.selection} variant="primary">
            {message("screen.sources.step.selection.link")}
          </LinkButton>
        ) : null}{" "}
        <Button variant="secondary" onClick={props.onRefresh}>
          {message("screen.sources.upload.refresh.cta")}
        </Button>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- UI15

export interface SelectionViewProps {
  readonly revision: SourceRevisionView;
  readonly inspection: InspectionView;
  readonly draft: Draft;
  readonly busy: boolean;
  readonly confirmed: boolean;
  readonly hrefs: { readonly sources: string; readonly seal: string };
  readonly onChange: (tableId: string, change: Partial<DraftTable>) => void;
  readonly onConfirm: () => void;
  readonly onRefresh: () => void;
}

function TableRow({ file, table, choice, props }: { readonly file: InspectionFileView; readonly table: InspectionTableView; readonly choice: DraftTable; readonly props: SelectionViewProps }): ReactElement {
  const problems = draftProblems(props.inspection, props.draft).filter((entry) => entry.tableId === table.tableId);
  const name = table.name ?? message("screen.sources.selection.table.unnamed.body", { ordinal: table.ordinal + 1 });
  const editable = file.admitted && props.revision.permittedActions.includes("SelectInputTables");
  return (
    <li className={`kauro-source-table${choice.include ? " kauro-source-table--included" : ""}`}>
      <div className="kauro-source-table-head">
        <h3>
          <span className="kauro-visually-hidden-text">{message("screen.sources.selection.table.heading")} </span>
          {safe(name)}
        </h3>
        <StatusBadge tone={table.visibility === "VISIBLE" ? "neutral" : "warning"}>{message(`screen.sources.selection.visibility.${table.visibility}`)}</StatusBadge>
        {table.hasFormulas ? (
          <>
            {" "}
            <StatusBadge tone="warning">{message("screen.sources.selection.formulas.present")}</StatusBadge>{" "}
            <span className="kauro-source-table-note">{message("screen.sources.selection.formulas.cache", { cache: message(`screen.sources.selection.formulas.cache.${table.formulaCache}`) })}</span>
          </>
        ) : null}
      </div>
      <p className="kauro-source-table-meta">
        {message("screen.sources.selection.counts.line", {
          columns: table.columnCount,
          rows: table.rowEstimate ?? message("screen.sources.selection.counts.rows.unknown"),
          merged: table.mergedCellCount,
          hiddenRows: table.hiddenRowCount,
          hiddenColumns: table.hiddenColumnCount,
        })}
      </p>
      {table.issues.length === 0 ? null : (
        <ul>
          {table.issues.map((issue) => (
            <li key={issue}>
              <code>{issue}</code>
            </li>
          ))}
        </ul>
      )}
      <h4 className="kauro-source-table-columns-heading">{message("screen.sources.selection.columns.heading")}</h4>
      <ol className="kauro-columns">
        {table.columns.map((column) => (
          <li key={column.ordinal} className={column.labelState === "PRESENT" ? undefined : "kauro-column--flag"}>
            {safe(columnLabel(column))}
          </li>
        ))}
      </ol>
      {editable ? (
        <div className="kauro-source-table-choice">
          <label className="kauro-source-table-include">
            <input type="checkbox" checked={choice.include} onChange={(event) => props.onChange(table.tableId, { include: event.currentTarget.checked })} />
            {message("screen.sources.selection.include.label")}
          </label>
          {choice.include && table.visibility !== "VISIBLE" ? (
            <label className="kauro-source-table-include">
              <input type="checkbox" checked={choice.hiddenAcknowledged} onChange={(event) => props.onChange(table.tableId, { hiddenAcknowledged: event.currentTarget.checked })} />
              {message("screen.sources.selection.hidden.ack.label")}
            </label>
          ) : null}
          {choice.include ? null : (
            <label className="kauro-source-table-reason">
              {message("screen.sources.selection.reason.label")}
              <select value={choice.reason} onChange={(event) => props.onChange(table.tableId, { reason: event.currentTarget.value })}>
                <option value="">{message("screen.sources.selection.reason.choose")}</option>
                {EXCLUSION_REASONS.map((token) => (
                  <option key={token} value={token}>
                    {exclusionReasonText(token)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      ) : null}
      {problems.map((entry) => (
        <p key={entry.problem} role="alert">
          {entry.problem === "REASON_REQUIRED" ? message("screen.sources.selection.reason.required.body") : message("screen.sources.selection.hidden.ack.required.body")}
        </p>
      ))}
    </li>
  );
}

export function SelectionView(props: SelectionViewProps): ReactElement {
  const { revision, inspection, draft } = props;
  const counts = countsView(revision, inspection, draft);
  const problems = draftProblems(inspection, draft);
  const canConfirm = revision.permittedActions.includes("SelectInputTables") && problems.length === 0 && !props.busy;
  const names = new Map(inspection.uploads.map((upload) => [upload.fileId ?? "", upload.displayName] as const));
  return (
    <div className="kauro-selection">
      <p className="kauro-screen-lead">{message("screen.sources.selection.lead.body")}</p>
      <RevisionStatus revision={revision} />
      {inspection.files.length === 0 ? <p>{message("screen.sources.selection.none.body")}</p> : null}
      {inspection.files.map((file) => (
        <section key={file.fileId} className="kauro-screen-section" aria-labelledby={`file-${file.fileId}`}>
          <h2 id={`file-${file.fileId}`} className="kauro-file-title">
            <span className="kauro-file-format" aria-hidden="true">
              {file.format}
            </span>
            <span className="kauro-visually-hidden-text">{message("screen.sources.selection.file.heading")} </span>
            {safe(names.get(file.fileId) ?? file.fileId)}
          </h2>
          {file.admitted ? null : <p role="alert">{message("screen.sources.selection.file.rejected.body")}</p>}
          <ul className="kauro-source-tables">
            {file.tables.map((table) => (
              <TableRow key={table.tableId} file={file} table={table} choice={draft[table.tableId] ?? { include: false, reason: "", hiddenAcknowledged: false }} props={props} />
            ))}
          </ul>
        </section>
      ))}
      <section className="kauro-screen-section" aria-labelledby="selection-counts">
        <h2 id="selection-counts">{message("screen.sources.selection.counts.heading")}</h2>
        {counts.stale ? (
          <Banner tone="warning" title={message("screen.sources.selection.counts.stale.title")} announce="status">
            <p>{message("screen.sources.selection.counts.stale.body")}</p>
          </Banner>
        ) : null}
        {counts.populations === null ? (
          <p>{message("screen.sources.selection.counts.none.body")}</p>
        ) : (
          <MeasureList measures={counts.populations} stale={counts.stale} />
        )}
        {inspection.evaluation?.result === "COMPLETE" || inspection.evaluation === undefined ? null : (
          <p role="alert">
            {message("screen.sources.selection.eval.failed.body")}{" "}
            {inspection.evaluation.failures.map((failure) => (
              <code key={`${failure.code}${failure.tableId ?? ""}`}>{failure.code} </code>
            ))}
          </p>
        )}
      </section>
      <p className="kauro-actions">
        {revision.state === "READY_TO_SEAL" ? (
          <LinkButton href={props.hrefs.seal} variant="primary">
            {message("screen.sources.step.seal.link")}
          </LinkButton>
        ) : null}{" "}
        {revision.permittedActions.includes("SelectInputTables") ? (
          <Button variant={revision.state === "READY_TO_SEAL" ? "secondary" : "primary"} disabled={!canConfirm} aria-busy={props.busy ? true : undefined} onClick={() => (canConfirm ? props.onConfirm() : undefined)}>
            {message("screen.sources.selection.confirm.cta")}
          </Button>
        ) : null}{" "}
        <Button variant="secondary" onClick={props.onRefresh}>
          {message("screen.sources.upload.refresh.cta")}
        </Button>{" "}
        <LinkButton href={props.hrefs.sources}>{message("screen.sources.step.sources.link")}</LinkButton>
      </p>
      {props.busy ? <p role="status">{message("screen.sources.selection.confirm.working.body")}</p> : null}
      {props.confirmed ? <p role="status">{message("screen.sources.selection.confirm.done.body")}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------- UI16 and the counts

function MeasureList({ measures, stale }: { readonly measures: { readonly physicalSourceRows: number; readonly billableSourceUnits: number; readonly associationEdges: number }; readonly stale: boolean }): ReactElement {
  const rows = [
    { key: "physical", value: measures.physicalSourceRows },
    { key: "units", value: measures.billableSourceUnits },
    { key: "edges", value: measures.associationEdges },
  ] as const;
  return (
    <dl className="kauro-measures" data-stale={stale ? "true" : undefined}>
      {rows.map((row) => (
        <div key={row.key}>
          <dt>{message(`screen.sources.seal.${row.key}.label`)}</dt>
          <dd>
            <Count value={row.value} />
          </dd>
          <dd>{message(`screen.sources.seal.${row.key}.definition`)}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface SealViewProps {
  readonly revision: SourceRevisionView;
  readonly inspection: InspectionView;
  readonly busy: boolean;
  readonly hrefs: { readonly selection: string };
  readonly onSeal: (selectionHash: string) => void;
  readonly onRefresh: () => void;
}

export function SealView({ revision, inspection, busy, hrefs, onSeal, onRefresh }: SealViewProps): ReactElement {
  const offer = sealOffer(revision, inspection);
  const measures = sealMeasures(revision, inspection);
  const selected = selectedTables(inspection);
  return (
    <div className="kauro-seal">
      <p className="kauro-screen-lead">{message("screen.sources.seal.lead.body")}</p>
      <RevisionStatus revision={revision} />
      <section className="kauro-screen-section" aria-labelledby="seal-measures">
        <h2 id="seal-measures">{message("screen.sources.seal.measures.heading")}</h2>
        {measures === null ? <p>{message("screen.sources.seal.measures.none.body")}</p> : <MeasureList measures={measures} stale={false} />}
      </section>
      <section className="kauro-screen-section" aria-labelledby="seal-selection">
        <h2 id="seal-selection">{message("screen.sources.seal.selection.heading")}</h2>
        <ul className="kauro-seal-tables">
          {selected
            .filter((table) => table.disposition === "INCLUDE")
            .map((table) => (
              <li key={table.tableId}>
                {safe(table.fileName)} / {safe(table.tableName)}
              </li>
            ))}
        </ul>
        {revision.selection === undefined ? null : (
          <details className="kauro-fingerprints">
            <summary>{message("screen.sources.seal.fingerprints.label")}</summary>
          <dl>
            <div>
              <dt>{message("screen.sources.seal.selection.hash.label")}</dt>
              <dd>
                <code>{revision.selection.selectionHash}</code>
              </dd>
            </div>
            <div>
              <dt>{message("screen.sources.seal.inventory.label")}</dt>
              <dd>
                <code>{inspection.inventoryHash}</code>
              </dd>
            </div>
          </dl>
          </details>
        )}
        {selected.some((table) => table.disposition === "EXCLUDE") ? (
          <>
            <h3>{message("screen.sources.seal.excluded.heading")}</h3>
            <ul className="kauro-seal-tables kauro-seal-tables--out">
              {selected
                .filter((table) => table.disposition === "EXCLUDE")
                .map((table) => (
                  <li key={table.tableId}>
                    {safe(table.fileName)} / {safe(table.tableName)} <span className="kauro-seal-reason">· {message("screen.sources.seal.excluded.reason.label")} {safe(exclusionReasonText(table.exclusionReason ?? ""))}</span>
                  </li>
                ))}
            </ul>
          </>
        ) : null}
      </section>
      {revision.dataAvailableUntil === undefined ? null : (
        <section className="kauro-screen-section" aria-labelledby="seal-retention">
          <h2 id="seal-retention">{message("screen.sources.seal.retention.heading")}</h2>
          <p>
            {message("screen.sources.seal.retention.until.label")}: <Deadline at={revision.dataAvailableUntil} timeZone="UTC" />
          </p>
        </section>
      )}
      <p className="kauro-seal-notice">{message("screen.sources.seal.notice.body")}</p>
      {offer.kind === "SEALED" ? (
        <Banner tone="success" title={message("screen.sources.seal.sealed.title")} announce="status">
          <p>{message("screen.sources.seal.sealed.body")}</p>
        </Banner>
      ) : null}
      {offer.kind === "BLOCKED" ? (
        <Banner tone="warning" title={message("screen.sources.seal.blocked.title")}>
          <Blockers blockers={offer.blockers} />
        </Banner>
      ) : null}
      {offer.kind === "STALE" ? (
        <Banner tone="warning" title={message("screen.sources.seal.stale.title")} announce="alert">
          <p>{message("screen.sources.seal.stale.body")}</p>
        </Banner>
      ) : null}
      {offer.kind === "NOT_PERMITTED" ? <p>{message("screen.sources.seal.notpermitted.body")}</p> : null}
      <p className="kauro-actions">
        {offer.kind === "OFFERED" ? (
          <Button variant="primary" disabled={busy} aria-busy={busy ? true : undefined} onClick={() => (busy ? undefined : onSeal(offer.selectionHash))}>
            {message("screen.sources.seal.cta")}
          </Button>
        ) : null}{" "}
        <Button variant="secondary" onClick={onRefresh}>
          {message("screen.sources.upload.refresh.cta")}
        </Button>{" "}
        <LinkButton href={hrefs.selection}>{message("screen.sources.step.selection.back")}</LinkButton>
      </p>
      {busy ? <p role="status">{message("screen.sources.seal.working.body")}</p> : null}
    </div>
  );
}

