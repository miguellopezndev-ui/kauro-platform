"use client";
// The containers of UI14, UI15 and UI16 (design D-PRIV-1, D-OPS-1, D-SCR-3): they read through the page's api client, hold what the person
// chose (the draft selection, the progress of the file this browser is sending) and the outcome of the last run, and hand everything to
// the pure views. Nothing private is stored; the page's heap is the only place. The browser clock comes only from useNow.
import { useCallback, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { InspectionView, SourceRevisionView, UploadView } from "../../api/generated.ts";
import { type StateDecision, stateOfAnswer, stateOfRun } from "../../client/states.ts";
import { message } from "../../copy/en.ts";
import { pathOf } from "../../screens.ts";
import { useShell } from "../../shell/shell-context.ts";
import { pageRunner } from "../shared/run-command.ts";
import { StatePanel } from "../shared/state-panel.tsx";
import { usePagedRead } from "../shared/use-paged-read.ts";
import { useNow } from "../shared/use-now.ts";
import { useRead } from "../shared/use-read.ts";
import {
  type ChosenFile,
  type Draft,
  type DraftTable,
  type FileProblem,
  type UploadFlowResult,
  type UploadProgress,
  cancelUpload,
  confirmSelection,
  initialDraft,
  resumeUpload,
  sealRevision,
  selectionDocument,
  uploadFile,
} from "./model.ts";
import { browserUploadTransport } from "./upload-transport.ts";
import { NoProject, SealView, SelectionView, SourcesView } from "./view.tsx";

const NO_ANSWER = { kind: "NO_ANSWER", reason: "ABORTED", status: null } as const;

/** The project in the address, then the revision it names (GetProject.currentRevision): both reads clear the earlier view while they load. */
function useRevisionOf(projectId: string | null) {
  const { client } = useShell();
  const project = useRead((signal) => (projectId === null ? Promise.resolve(NO_ANSWER) : client.call("GetProject", { path: { projectId }, signal })), projectId ?? "none");
  const revisionId = project.state.kind === "ANSWERED" && project.state.answer.kind === "REPLY" ? project.state.answer.body.data.currentRevision.revisionId : null;
  const revision = useRead((signal) => (revisionId === null ? Promise.resolve(NO_ANSWER) : client.call("GetRevision", { path: { revisionId }, signal })), revisionId ?? "none");
  const refreshProject = project.refresh;
  const refreshRevision = revision.refresh;
  const refresh = useCallback(() => {
    refreshProject();
    refreshRevision();
  }, [refreshProject, refreshRevision]);
  const loading = project.state.kind === "LOADING" || (revisionId !== null && revision.state.kind === "LOADING");
  const value: SourceRevisionView | null = revision.state.kind === "ANSWERED" && revision.state.answer.kind === "REPLY" ? revision.state.answer.body.data : null;
  const failure: StateDecision = revisionId === null ? project.state.decision : revision.state.decision;
  return { client, loading, revision: value, revisionId, failure, refresh };
}

/** One action at a time on a page: a second activation while one runs is ignored (the runner would join it anyway). */
function useAction<Result>() {
  const [state, setState] = useState<{ readonly kind: "IDLE" } | { readonly kind: "RUNNING" } | { readonly kind: "DONE"; readonly result: Result }>({ kind: "IDLE" });
  const running = useRef(false);
  const run = useCallback((work: () => Promise<Result>, after: () => void) => {
    if (running.current) return;
    running.current = true;
    setState({ kind: "RUNNING" });
    void work().then(
      (result) => {
        running.current = false;
        setState({ kind: "DONE", result });
        after();
      },
      () => {
        running.current = false;
        setState({ kind: "IDLE" });
      },
    );
  }, []);
  return { state, run };
}

type SourcesWork = { readonly kind: "FLOW"; readonly result: UploadFlowResult } | { readonly kind: "CANCEL"; readonly outcome: Awaited<ReturnType<typeof cancelUpload>> };

function decisionOf(work: SourcesWork): StateDecision | null {
  if (work.kind === "CANCEL") return work.outcome.kind === "COMPLETED" || work.outcome.kind === "RECOVERED" ? null : stateOfRun(work.outcome);
  const result = work.result;
  switch (result.kind) {
    case "RESERVE_ENDED":
      return stateOfRun(result.outcome);
    case "COMPLETE_ENDED":
      return result.outcome.kind === "COMPLETED" || result.outcome.kind === "RECOVERED" ? null : stateOfRun(result.outcome);
    default:
      return null;
  }
}

export function SourcesScreen({ agencyId, projectId, uploadOrigin }: { readonly agencyId: string; readonly projectId: string | null; readonly uploadOrigin: string | null }): ReactElement {
  const base = useRevisionOf(projectId);
  const { client } = base;
  const nowMs = useNow();
  const [progress, setProgress] = useState<Readonly<Record<string, UploadProgress>>>({});
  const action = useAction<SourcesWork>();
  const uploads = usePagedRead(
    {
      load: (cursor, signal) => (base.revisionId === null || base.revision === null ? Promise.resolve(NO_ANSWER) : client.call("ListUploads", { path: { revisionId: base.revisionId }, ...(cursor === null ? {} : { query: { cursor } }), signal })),
      pageOf: (body) => ({ items: body.data.items, nextCursor: body.data.nextCursor ?? null, version: "uploads" }),
    },
    `${base.revisionId ?? "none"}:${base.revision?.version ?? "none"}`,
  );
  if (projectId === null) return <NoProject />;
  if (base.loading) return <StatePanel decision={base.failure} />;
  if (base.revision === null) return <StatePanel decision={base.failure} onNext={base.refresh} />;
  const revision = base.revision;
  const deps = { client, runner: pageRunner(), transport: browserUploadTransport, uploadOrigin, onProgress: (uploadId: string, value: UploadProgress) => setProgress((held) => ({ ...held, [uploadId]: value })) };
  const after = (): void => {
    base.refresh();
    uploads.reload();
  };
  const chosen = (file: File): ChosenFile => ({ name: file.name, size: file.size, body: file });
  const done = action.state.kind === "DONE" ? action.state.result : null;
  const flow = done?.kind === "FLOW" ? done.result : null;
  const refused: FileProblem | null = flow?.kind === "REFUSED" ? flow.problem : null;
  const decision = done === null ? null : decisionOf(done);
  return (
    <>
      <SourcesView
        revision={revision}
        uploads={uploads.state.items}
        hasMore={uploads.state.hasMore}
        uploadOrigin={uploadOrigin}
        nowMs={nowMs}
        progress={progress}
        busy={action.state.kind === "RUNNING"}
        refused={refused}
        hrefs={{ selection: pathOf("UI15", { agencyId, id: projectId }), seal: pathOf("UI16", { agencyId, id: projectId }) }}
        onFile={(file) => action.run(async () => ({ kind: "FLOW", result: await uploadFile(deps, revision, chosen(file)) }), after)}
        onResume={(upload: UploadView, file) => action.run(async () => ({ kind: "FLOW", result: await resumeUpload(deps, upload, chosen(file)) }), after)}
        onCancel={(upload) => action.run(async () => ({ kind: "CANCEL", outcome: await cancelUpload(client, deps.runner, upload) }), after)}
        onMore={uploads.more}
        onRefresh={after}
      />
      {uploads.state.status === "FAILED" && uploads.state.failure !== null ? <StatePanel decision={uploads.state.failure} onNext={uploads.reload} /> : null}
      {uploads.state.status === "CHANGED" ? <StatePanel decision={stateOfAnswer({ kind: "PROBLEM", status: 409, correlationId: "list", problem: STALE_LIST })} onNext={uploads.reload} /> : null}
      {decision === null ? null : <StatePanel decision={decision} onNext={decision.next === "RELOAD" || decision.next === "REQUERY" ? after : undefined} />}
      {flow?.kind === "UNAVAILABLE" && flow.reason === "SESSION_UNAVAILABLE" ? <p role="alert">{message("screen.sources.upload.session.unavailable.body")}</p> : null}
      {flow?.kind === "UNAVAILABLE" && flow.reason === "ORIGIN_MISMATCH" ? <p role="alert">{message("screen.sources.upload.origin.refused.body")}</p> : null}
      {flow?.kind === "SEND_FAILED" ? <p role="alert">{message("screen.sources.upload.send.failed.body")}</p> : null}
    </>
  );
}

const STALE_LIST = { type: "urn:kauro:problem:STALE_VERSION", title: "The list changed", status: 409, code: "STALE_VERSION", correlationId: "list", retryable: false, nextActions: [] } as const;

function useInspection(revisionId: string | null, revision: SourceRevisionView | null) {
  const { client } = useShell();
  const inspection = useRead((signal) => (revisionId === null || revision === null ? Promise.resolve(NO_ANSWER) : client.call("GetInspection", { path: { revisionId }, signal })), `${revisionId ?? "none"}:${revision?.version ?? "none"}`);
  const value: InspectionView | null = inspection.state.kind === "ANSWERED" && inspection.state.answer.kind === "REPLY" ? inspection.state.answer.body.data : null;
  return { inspection: value, state: inspection.state, refresh: inspection.refresh };
}

export function SelectionScreen({ agencyId, projectId }: { readonly agencyId: string; readonly projectId: string | null }): ReactElement {
  const base = useRevisionOf(projectId);
  const read = useInspection(base.revisionId, base.revision);
  const [held, setHeld] = useState<{ readonly key: string; readonly value: Draft } | null>(null);
  const action = useAction<Awaited<ReturnType<typeof confirmSelection>>>();
  if (projectId === null) return <NoProject />;
  if (base.loading || read.state.kind === "LOADING") return <StatePanel decision={base.loading ? base.failure : read.state.decision} />;
  if (base.revision === null) return <StatePanel decision={base.failure} onNext={base.refresh} />;
  if (read.inspection === null) return <StatePanel decision={read.state.decision} onNext={read.refresh} />;
  const revision = base.revision;
  const inspection = read.inspection;
  const key = `${inspection.inventoryHash}:${inspection.selection?.selectionHash ?? "none"}:${revision.version}`;
  const draft = held?.key === key ? held.value : initialDraft(inspection);
  const refreshAll = (): void => {
    base.refresh();
    read.refresh();
  };
  const done = action.state.kind === "DONE" ? action.state.result : null;
  const outcome = done?.kind === "SELECT_ENDED" ? done.outcome : null;
  const confirmed = outcome !== null && (outcome.kind === "COMPLETED" || outcome.kind === "RECOVERED");
  const decision = done === null ? null : done.kind === "SUBMIT_ENDED" ? stateOfAnswer(done.answer) : confirmed ? null : stateOfRun(done.outcome);
  return (
    <>
      <SelectionView
        revision={revision}
        inspection={inspection}
        draft={draft}
        busy={action.state.kind === "RUNNING"}
        confirmed={confirmed}
        hrefs={{ sources: pathOf("UI14", { agencyId, id: projectId }), seal: pathOf("UI16", { agencyId, id: projectId }) }}
        onChange={(tableId: string, change: Partial<DraftTable>) => setHeld({ key, value: { ...draft, [tableId]: { include: false, reason: "", hiddenAcknowledged: false, ...draft[tableId], ...change } } })}
        onConfirm={() => action.run(() => confirmSelection(base.client, pageRunner(), revision, selectionDocument(inspection, draft)), refreshAll)}
        onRefresh={refreshAll}
      />
      {decision === null ? null : <StatePanel decision={decision} onNext={decision.next === "RELOAD" || decision.next === "REQUERY" ? refreshAll : undefined} />}
    </>
  );
}

export function SealScreen({ agencyId, projectId }: { readonly agencyId: string; readonly projectId: string | null }): ReactElement {
  const base = useRevisionOf(projectId);
  const read = useInspection(base.revisionId, base.revision);
  const action = useAction<Awaited<ReturnType<typeof sealRevision>>>();
  if (projectId === null) return <NoProject />;
  if (base.loading || read.state.kind === "LOADING") return <StatePanel decision={base.loading ? base.failure : read.state.decision} />;
  if (base.revision === null) return <StatePanel decision={base.failure} onNext={base.refresh} />;
  if (read.inspection === null) return <StatePanel decision={read.state.decision} onNext={read.refresh} />;
  const revision = base.revision;
  const refreshAll = (): void => {
    base.refresh();
    read.refresh();
  };
  const done = action.state.kind === "DONE" ? action.state.result : null;
  const decision = done === null || done.kind === "COMPLETED" || done.kind === "RECOVERED" ? null : stateOfRun(done);
  return (
    <>
      <SealView
        revision={revision}
        inspection={read.inspection}
        busy={action.state.kind === "RUNNING"}
        hrefs={{ selection: pathOf("UI15", { agencyId, id: projectId }) }}
        onSeal={(selectionHash) => action.run(() => sealRevision(base.client, pageRunner(), revision, selectionHash), refreshAll)}
        onRefresh={refreshAll}
      />
      {decision === null ? null : <StatePanel decision={decision} onNext={decision.next === "RELOAD" || decision.next === "REQUERY" || decision.next === "COMPARE_VERSIONS" ? refreshAll : undefined} />}
    </>
  );
}
