// UI14 source intake, UI15 selection and UI16 seal review as markup. Pure: the containers own the reads and the runs. Every customer
// string (a file name, a sheet name, a column label) goes through SafeText as one text node; every control is offered from the server's
// permittedActions through the model; every count keeps its own label and definition.
import { Banner, Button, Count, Deadline, LinkButton, SafeText, StatusBadge, type Tone } from "@kauro/ui";
import type { ReactElement } from "react";
import type { InspectionFileView, InspectionTableView, InspectionView, SourceRevisionView, UploadView } from "../../api/generated.ts";
import { message } from "../../copy/en.ts";
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

export function RevisionStatus({ revision }: { readonly revision: SourceRevisionView }): ReactElement {
  return (
    <section aria-labelledby="sources-revision">
      <h2 id="sources-revision">{message("screen.sources.revision.state.label")}</h2>
      <p role="status">
        <StatusBadge tone={REVISION_TONE[revision.state]}>{message(`screen.sources.revision.state.${revision.state}`)}</StatusBadge>
      </p>
      <Blockers blockers={revision.blockers} />
    </section>
  );
}

export function Blockers({ blockers }: { readonly blockers: readonly RevisionBlocker[] }): ReactElement {
  return (
    <>
      <h3>{message("screen.sources.blockers.heading")}</h3>
      {blockers.length === 0 ? (
        <p>{message("screen.sources.blockers.none.body")}</p>
      ) : (
        <ul>
          {blockers.map((blocker) => (
            <li key={blocker}>{message(`screen.sources.blocker.${blocker}`)}</li>
          ))}
        </ul>
      )}
    </>
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

function FileInput({ label, onFile }: { readonly label: string; readonly onFile: (file: File) => void }): ReactElement {
  return (
    <label>
      {label}
      <input
        type="file"
        accept=".csv,.xlsx"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file !== undefined) onFile(file);
        }}
      />
    </label>
  );
}

export function UploadFacts({ upload, progress }: { readonly upload: UploadView; readonly progress: UploadProgress | null }): ReactElement {
  const facts = uploadFacts(upload, progress);
  const scanner = facts.scanner;
  return (
    <dl>
      <div>
        <dt>{message("screen.sources.fact.declared.label")}</dt>
        <dd>
          <Count value={facts.declaredBytes} />
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
              <span>
                {scanner.state === "COVERED_CLEAN" && !scanner.fullyChecked
                  ? message("screen.sources.fact.scanner.partial.body", { scanned: scanner.coverage.scannedParts, expected: scanner.coverage.expectedParts })
                  : message(`screen.sources.fact.scanner.${scanner.state}`)}
              </span>{" "}
              <span>{message("screen.sources.fact.scanner.coverage.body", { ...scanner.coverage })}</span>
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

function UploadRow({ upload, revision, props }: { readonly upload: UploadView; readonly revision: SourceRevisionView; readonly props: SourcesViewProps }): ReactElement {
  const actions = uploadActions(upload, revision, props.nowMs);
  const sending = props.progress[upload.uploadId] ?? null;
  return (
    <li>
      <h3>{safe(upload.displayName)}</h3>
      <p>
        <StatusBadge tone={upload.state === "ADMITTED" ? "success" : upload.state === "REJECTED" ? "danger" : "neutral"}>{message(`screen.sources.upload.state.${upload.state}`)}</StatusBadge>
      </p>
      <UploadFacts upload={upload} progress={sending} />
      {upload.state === "RESERVED" || upload.state === "UPLOADING" ? (
        <p>
          {message("screen.sources.expiry.label")}: <Deadline at={upload.applicationExpiresAt} timeZone="UTC" />
        </p>
      ) : null}
      {actions.resume === "OFFERED" ? <FileInput label={message("screen.sources.upload.resume.cta")} onFile={(file) => props.onResume(upload, file)} /> : null}
      {actions.resume === "OFFERED" ? <p>{message("screen.sources.upload.resume.file.hint")}</p> : null}
      {actions.resume === "DISABLED_BY_CLOCK" ? (
        <p>
          <Button variant="secondary" disabled>
            {message("screen.sources.upload.resume.cta")}
          </Button>{" "}
          {message("screen.sources.upload.resume.disabled.body")}
        </p>
      ) : null}
      {actions.newReservation ? (
        <>
          <p>{message("screen.sources.upload.reserve.new.body")}</p>
          <FileInput label={message("screen.sources.upload.reserve.new.cta")} onFile={props.onFile} />
        </>
      ) : null}
      {actions.canCancel ? (
        <Button variant="secondary" disabled={props.busy} onClick={() => (props.busy ? undefined : props.onCancel(upload))}>
          {message("screen.sources.upload.cancel.cta")}
        </Button>
      ) : null}
    </li>
  );
}

export function SourcesView(props: SourcesViewProps): ReactElement {
  const { revision } = props;
  const model = sourcesModel(revision, props.uploadOrigin);
  return (
    <div className="kauro-sources">
      <p>{message("screen.sources.intake.lead.body")}</p>
      <RevisionStatus revision={revision} />
      <section aria-labelledby="sources-add">
        <h2 id="sources-add">{message("screen.sources.upload.heading")}</h2>
        {model.uploadUnavailable ? (
          <Banner tone="warning" title={message("screen.sources.upload.unavailable.title")} announce="status">
            <p>{message("screen.sources.upload.unavailable.body")}</p>
          </Banner>
        ) : null}
        {model.canAdd ? <FileInput label={message("screen.sources.upload.field.label")} onFile={props.onFile} /> : null}
        {props.refused === null ? null : <p role="alert">{props.refused === "FORMAT" ? message("screen.sources.upload.format.refused.body") : message("screen.sources.upload.name.refused.body")}</p>}
        {props.busy ? <p role="status">{message("screen.sources.upload.sending.body")}</p> : null}
      </section>
      <section aria-labelledby="sources-files">
        <h2 id="sources-files">{message("screen.sources.uploads.heading")}</h2>
        {props.uploads.length === 0 ? (
          <p>{message("screen.sources.uploads.none.body")}</p>
        ) : (
          <ul>
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
        <Button variant="secondary" onClick={props.onRefresh}>
          {message("screen.sources.upload.refresh.cta")}
        </Button>{" "}
        {model.canGoToSelection ? <LinkButton href={props.hrefs.selection}>{message("screen.sources.step.selection.link")}</LinkButton> : null}
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
    <li>
      <h4>{message("screen.sources.selection.table.heading")} {safe(name)}</h4>
      <p>
        <StatusBadge tone={table.visibility === "VISIBLE" ? "neutral" : "warning"}>{message(`screen.sources.selection.visibility.${table.visibility}`)}</StatusBadge>
        {table.hasFormulas ? (
          <>
            {" "}
            <StatusBadge tone="warning">{message("screen.sources.selection.formulas.present")}</StatusBadge>{" "}
            {message("screen.sources.selection.formulas.cache", { cache: message(`screen.sources.selection.formulas.cache.${table.formulaCache}`) })}
          </>
        ) : null}
      </p>
      <p>
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
      <h5>{message("screen.sources.selection.columns.heading")}</h5>
      <ol>
        {table.columns.map((column) => (
          <li key={column.ordinal}>{safe(columnLabel(column))}</li>
        ))}
      </ol>
      {editable ? (
        <>
          <label>
            <input type="checkbox" checked={choice.include} onChange={(event) => props.onChange(table.tableId, { include: event.currentTarget.checked })} />
            {message("screen.sources.selection.include.label")}
          </label>
          {choice.include && table.visibility !== "VISIBLE" ? (
            <label>
              <input type="checkbox" checked={choice.hiddenAcknowledged} onChange={(event) => props.onChange(table.tableId, { hiddenAcknowledged: event.currentTarget.checked })} />
              {message("screen.sources.selection.hidden.ack.label")}
            </label>
          ) : null}
          {choice.include ? null : (
            <label>
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
        </>
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
      <p>{message("screen.sources.selection.lead.body")}</p>
      <RevisionStatus revision={revision} />
      {inspection.files.length === 0 ? <p>{message("screen.sources.selection.none.body")}</p> : null}
      {inspection.files.map((file) => (
        <section key={file.fileId} aria-labelledby={`file-${file.fileId}`}>
          <h2 id={`file-${file.fileId}`}>{message("screen.sources.selection.file.heading")} {safe(names.get(file.fileId) ?? file.fileId)}</h2>
          {file.admitted ? null : <p role="alert">{message("screen.sources.selection.file.rejected.body")}</p>}
          <ul>
            {file.tables.map((table) => (
              <TableRow key={table.tableId} file={file} table={table} choice={draft[table.tableId] ?? { include: false, reason: "", hiddenAcknowledged: false }} props={props} />
            ))}
          </ul>
        </section>
      ))}
      <section aria-labelledby="selection-counts">
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
        {revision.permittedActions.includes("SelectInputTables") ? (
          <Button variant="primary" disabled={!canConfirm} aria-busy={props.busy ? true : undefined} onClick={() => (canConfirm ? props.onConfirm() : undefined)}>
            {message("screen.sources.selection.confirm.cta")}
          </Button>
        ) : null}{" "}
        <Button variant="secondary" onClick={props.onRefresh}>
          {message("screen.sources.upload.refresh.cta")}
        </Button>{" "}
        <LinkButton href={props.hrefs.sources}>{message("screen.sources.step.sources.link")}</LinkButton>{" "}
        {revision.state === "READY_TO_SEAL" ? <LinkButton href={props.hrefs.seal}>{message("screen.sources.step.seal.link")}</LinkButton> : null}
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
      <p>{message("screen.sources.seal.lead.body")}</p>
      <RevisionStatus revision={revision} />
      <section aria-labelledby="seal-measures">
        <h2 id="seal-measures">{message("screen.sources.seal.measures.heading")}</h2>
        {measures === null ? <p>{message("screen.sources.seal.measures.none.body")}</p> : <MeasureList measures={measures} stale={false} />}
      </section>
      <section aria-labelledby="seal-selection">
        <h2 id="seal-selection">{message("screen.sources.seal.selection.heading")}</h2>
        <ul>
          {selected
            .filter((table) => table.disposition === "INCLUDE")
            .map((table) => (
              <li key={table.tableId}>
                {safe(table.fileName)} / {safe(table.tableName)}
              </li>
            ))}
        </ul>
        {revision.selection === undefined ? null : (
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
        )}
        {selected.some((table) => table.disposition === "EXCLUDE") ? (
          <>
            <h3>{message("screen.sources.seal.excluded.heading")}</h3>
            <ul>
              {selected
                .filter((table) => table.disposition === "EXCLUDE")
                .map((table) => (
                  <li key={table.tableId}>
                    {safe(table.fileName)} / {safe(table.tableName)}: {message("screen.sources.seal.excluded.reason.label")} {safe(exclusionReasonText(table.exclusionReason ?? ""))}
                  </li>
                ))}
            </ul>
          </>
        ) : null}
      </section>
      {revision.dataAvailableUntil === undefined ? null : (
        <section aria-labelledby="seal-retention">
          <h2 id="seal-retention">{message("screen.sources.seal.retention.heading")}</h2>
          <p>
            {message("screen.sources.seal.retention.until.label")}: <Deadline at={revision.dataAvailableUntil} timeZone="UTC" />
          </p>
        </section>
      )}
      <p>{message("screen.sources.seal.notice.body")}</p>
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

