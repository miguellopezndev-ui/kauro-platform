"use client";
// The container of UI18 (design D-PRIV-1, D-OPS-1): reads the check named in the address, and runs CMD021 through the page's runner.
import { type ReactElement, useContext } from "react";
import { pathOf } from "../../screens.ts";
import { ImplementedScreens } from "../shared/implemented-screens.ts";
import { useShell } from "../../shell/shell-context.ts";
import { pageRunner, useCommand } from "../shared/run-command.ts";
import { StatePanel } from "../shared/state-panel.tsx";
import { useRead } from "../shared/use-read.ts";
import { cancelHealthCheck } from "./model.ts";
import { HealthCheckDetails, NoHealthCheck } from "./view.tsx";

export function HealthCheckScreen({ auditId, agencyId, projectId }: { readonly auditId: string | null; readonly agencyId?: string; readonly projectId?: string }): ReactElement {
  const { client } = useShell();
  const implemented = useContext(ImplementedScreens);
  const planHref = agencyId !== undefined && projectId !== undefined && implemented.has("UI19") ? pathOf("UI19", { agencyId, id: projectId }) : null;
  const { state, refresh } = useRead((signal) => (auditId === null ? Promise.resolve({ kind: "NO_ANSWER", reason: "ABORTED", status: null } as const) : client.call("GetAudit", { path: { auditId }, signal })), auditId ?? "none");
  const audit = state.kind === "ANSWERED" && state.answer.kind === "REPLY" ? state.answer.body.data : null;
  const cancel = useCommand(() => {
    if (audit === null) throw new Error("NO_AUDIT");
    return cancelHealthCheck(client, pageRunner(), audit);
  });
  if (auditId === null) return <NoHealthCheck />;
  if (state.kind === "LOADING") return <StatePanel decision={state.decision} />;
  if (audit === null) return <StatePanel decision={state.decision} onNext={refresh} />;
  const done = cancel.state.kind === "DONE" ? cancel.state : null;
  const cancelled = done !== null && (done.outcome.kind === "COMPLETED" || done.outcome.kind === "RECOVERED") ? done.outcome.data : null;
  return (
    <>
      <HealthCheckDetails audit={cancelled ?? audit} onRefresh={refresh} onCancel={cancel.run} cancelling={cancel.state.kind === "RUNNING"} planHref={planHref} />
      {done === null || cancelled !== null ? null : <StatePanel decision={done.decision} onNext={done.decision.next === "RELOAD" || done.decision.next === "REQUERY" ? refresh : undefined} />}
    </>
  );
}
