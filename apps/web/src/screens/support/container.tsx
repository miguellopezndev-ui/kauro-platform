"use client";
// The container of UI52 (design D-PRIV-1, D-OPS-1, D-STATE-1): the project's cases as a paged list, one case by its link, and the form that
// runs CMD044 under the key minted when the form opened. A refused read draws the shared state and nothing of the case.
import { useState } from "react";
import type { ReactElement } from "react";
import type { SupportCaseView } from "../../api/generated.ts";
import { message } from "../../copy/en.ts";
import { pathOf } from "../../screens.ts";
import { useShell } from "../../shell/shell-context.ts";
import { pageRunner, useCommand } from "../shared/run-command.ts";
import { StatePanel } from "../shared/state-panel.tsx";
import { usePagedRead } from "../shared/use-paged-read.ts";
import { useRead } from "../shared/use-read.ts";
import { type Category, caseSource, createdCase, createSupportCase, refusalOf, summaryProblem } from "./model.ts";
import { CaseCreated, CaseForm, CaseList, CaseOrRefusal, ChooseProject } from "./view.tsx";

export function SupportScreen({ agencyId, projectId, caseId }: { readonly agencyId: string; readonly projectId: string | null; readonly caseId: string | null }): ReactElement {
  if (caseId !== null) return <OneCase agencyId={agencyId} projectId={projectId} caseId={caseId} />;
  if (projectId === null) return <ChooseProject />;
  return <ProjectCases agencyId={agencyId} projectId={projectId} />;
}

function OneCase({ agencyId, projectId, caseId }: { readonly agencyId: string; readonly projectId: string | null; readonly caseId: string }): ReactElement {
  const { client } = useShell();
  const { state, refresh } = useRead((signal) => client.call("GetSupportCase", { path: { caseId }, signal }), caseId);
  if (state.kind === "LOADING") return <StatePanel decision={state.decision} />;
  const backProject = projectId ?? (state.answer.kind === "REPLY" ? state.answer.body.data.projectId : null);
  return <CaseOrRefusal answer={state.answer} backHref={backProject === null ? pathOf("UI52", { agencyId }) : listHref(agencyId, backProject)} onNext={refresh} />;
}

function listHref(agencyId: string, projectId: string): string {
  return `${pathOf("UI52", { agencyId })}?project=${encodeURIComponent(projectId)}`;
}

function ProjectCases({ agencyId, projectId }: { readonly agencyId: string; readonly projectId: string }): ReactElement {
  const { client } = useShell();
  const paged = usePagedRead(caseSource(client, projectId), projectId);
  const [category, setCategory] = useState<Category>("GENERAL");
  const [summary, setSummary] = useState("");
  const [attempted, setAttempted] = useState(false);
  // the key of this form: minted now, kept until a COMPLETED answer (a reload mints a new form, whose first run is a new case)
  const [form] = useState(() => pageRunner().openForm("CMD044"));
  const known = paged.state.status === "READY" ? new Set(paged.state.items.map((item) => item.caseId)) : null;
  const problem = summaryProblem(summary);
  const create = useCommand(() => createSupportCase(client, pageRunner(), form, projectId, { category, summary }, known));

  const done = create.state.kind === "DONE" ? create.state : null;
  const created: SupportCaseView | null = done === null ? null : createdCase(done.outcome);
  if (created !== null) return <CaseCreated item={created} listHref={listHref(agencyId, projectId)} />;
  const refusal = done === null ? null : refusalOf(done.outcome);
  const submit = (): void => {
    setAttempted(true);
    if (problem === null) create.run();
  };
  return (
    <>
      {paged.state.status === "FAILED" && paged.state.failure !== null ? <StatePanel decision={paged.state.failure} onNext={paged.reload} /> : null}
      {paged.state.status === "CHANGED" ? (
        <section role="status">
          <p>{message("screen.support.list.changed.body")}</p>
          <button type="button" className="kauro-button" onClick={paged.reload}>
            {message("screen.support.list.refresh.cta")}
          </button>
        </section>
      ) : null}
      {paged.state.status === "READY" || paged.state.status === "LOADING" ? (
        <CaseList cases={paged.state.items} hasMore={paged.state.hasMore} loading={paged.state.status === "LOADING"} onMore={paged.more} caseHref={(id) => `${pathOf("UI52", { agencyId })}?case=${encodeURIComponent(id)}&project=${encodeURIComponent(projectId)}`} />
      ) : null}
      <CaseForm category={category} summary={summary} onCategory={setCategory} onSummary={setSummary} onSubmit={submit} submitting={create.state.kind === "RUNNING"} summaryProblem={attempted ? problem : null} refusal={refusal} />
      {done === null || refusal !== null ? null : <StatePanel decision={done.decision} onNext={done.decision.next === "REQUERY" ? create.run : done.decision.next === "RELOAD" || done.decision.next === "COMPARE_VERSIONS" ? paged.reload : undefined} />}
    </>
  );
}
