"use client";
// The container of UI25 (design D-PRIV-1, D-OPS-1, D-STATE-1): reads the paid order named in the address (its commercial authorization) and
// the job, and runs CMD036 (execute) and CMD037 (cancel) through the page's runner. The clock is read only through shared/use-now.ts and only
// words the elapsed time.
import { useContext, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { pathOf } from "../../screens.ts";
import { useShell } from "../../shell/shell-context.ts";
import { pageRunner, useCommand } from "../shared/run-command.ts";
import { ImplementedScreens } from "../shared/project-stages.tsx";
import { StatePanel } from "../shared/state-panel.tsx";
import { useNow } from "../shared/use-now.ts";
import { useRead } from "../shared/use-read.ts";
import { cancelJob, executeOffer, executeProject } from "./model.ts";
import { ExecutePanel, NothingProcessing, ProcessingDetails } from "./view.tsx";

const NO_ANSWER = { kind: "NO_ANSWER", reason: "ABORTED", status: null } as const;

export function ProcessingScreen({ agencyId, projectId, orderId, jobId }: { readonly agencyId: string; readonly projectId: string; readonly orderId: string | null; readonly jobId: string | null }): ReactElement {
  const { client } = useShell();
  const nowMs = useNow();
  const implemented = useContext(ImplementedScreens);
  const deliveryHref = implemented.has("UI26") ? pathOf("UI26", { agencyId, id: projectId }) : null;
  const [startedJob, setStartedJob] = useState<string | null>(null);
  const activeJob = jobId ?? startedJob;
  const order = useRead((signal) => (orderId === null ? Promise.resolve(NO_ANSWER) : client.call("GetPaymentOrder", { path: { orderId }, signal })), orderId ?? "none");
  const jobRead = useRead((signal) => (activeJob === null ? Promise.resolve(NO_ANSWER) : client.call("GetJob", { path: { jobId: activeJob }, signal })), activeJob ?? "none");
  const authorization = order.state.kind === "ANSWERED" && order.state.answer.kind === "REPLY" ? (order.state.answer.body.data.commercialAuthorization ?? null) : null;
  const job = jobRead.state.kind === "ANSWERED" && jobRead.state.answer.kind === "REPLY" ? jobRead.state.answer.body.data : null;

  // the instant of the last read: it moves when a read answers, never with the tick
  const readAt = useMemo(() => new Date(nowMs).toISOString(), [jobRead.state]);

  const execute = useCommand(() => {
    if (authorization === null) throw new Error("NO_AUTHORIZATION");
    return executeProject(client, pageRunner(), projectId, authorization).then((outcome) => {
      if (outcome.kind === "ACCEPTED") setStartedJob(outcome.accepted.operationId);
      return outcome;
    });
  });
  const cancel = useCommand(() => {
    if (job === null) throw new Error("NO_JOB");
    return cancelJob(client, pageRunner(), job);
  });

  if (activeJob === null && orderId === null) return <NothingProcessing />;
  const supportHref = `${pathOf("UI52", { agencyId })}?project=${encodeURIComponent(projectId)}`;
  const refreshAll = (): void => {
    order.refresh();
    jobRead.refresh();
  };

  if (activeJob !== null) {
    if (jobRead.state.kind === "LOADING") return <StatePanel decision={jobRead.state.decision} />;
    if (job === null) return <StatePanel decision={jobRead.state.decision} onNext={jobRead.refresh} />;
    const done = cancel.state.kind === "DONE" ? cancel.state : null;
    const recorded = done !== null && (done.outcome.kind === "COMPLETED" || done.outcome.kind === "RECOVERED");
    const shown = done !== null && done.outcome.kind === "COMPLETED" ? done.outcome.data : done !== null && done.outcome.kind === "RECOVERED" ? done.outcome.data : job;
    return (
      <>
        <ProcessingDetails job={shown} nowMs={nowMs} readAt={readAt} supportHref={supportHref} onRefresh={jobRead.refresh} onCancel={cancel.run} cancelling={cancel.state.kind === "RUNNING"} cancelRecorded={recorded} deliveryHref={deliveryHref} />
        {done === null || recorded ? null : <StatePanel decision={done.decision} onNext={done.decision.next === "RELOAD" || done.decision.next === "REQUERY" || done.decision.next === "COMPARE_VERSIONS" ? jobRead.refresh : undefined} />}
      </>
    );
  }

  if (order.state.kind === "LOADING") return <StatePanel decision={order.state.decision} />;
  if (order.state.kind === "ANSWERED" && order.state.answer.kind !== "REPLY") return <StatePanel decision={order.state.decision} onNext={refreshAll} />;
  // GAP (B08): no plan read exists, so the current approved plan is unknown and no execute control is offered (see model.ts)
  const offer = executeOffer(authorization, null, false);
  const done = execute.state.kind === "DONE" ? execute.state : null;
  return (
    <>
      <ExecutePanel offer={offer} onExecute={execute.run} executing={execute.state.kind === "RUNNING"} />
      {done === null || done.outcome.kind === "ACCEPTED" ? null : <StatePanel decision={done.decision} onNext={done.decision.next === "REQUERY" ? execute.run : done.decision.next === "RELOAD" || done.decision.next === "COMPARE_VERSIONS" ? refreshAll : undefined} />}
    </>
  );
}
