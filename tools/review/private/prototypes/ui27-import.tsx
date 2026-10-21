"use client";
// UI27 Import steps (registry: "Use the specified tool and settings for each stage."). The import is the customer's: Kauro never writes to
// the CRM, so the page is a guide with checkpoints. Before the first stage, one prerequisite: a current export of the account, because Kauro
// cannot undo an import. Then the stages in order (ImportStageView: sequence, object, operation, parent stages), each with its file, its
// rows, the importer and the exact settings, and its state in words. A released stage waiting for the team reads "Import step needs your
// result" (registry exception for AWAITING_AGENCY_IMPORT), and a later stage stays locked until the stage before it is verified.
// Adapted to the service: HubSpot in three stages with its importer; Salesforce in two with Data Loader; "Clean your data" has no import.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { stagesFor } from "./delivery.ts";
import { PageHead, ScreenButton, ScreenLink } from "./kit.tsx";
import { n } from "./plan.tsx";
import { SERVICE } from "./service.ts";

export const UI27_STATES: readonly StateDef[] = [
  { key: "normal", label: "Before the first stage", note: "The prerequisite to confirm, then stage 1 released; later stages wait for the result of the stage before." },
  { key: "waiting", label: "Needs your result", note: "Stage 1 imported by the team: the step needs its result before stage 2 is released." },
  { key: "second", label: "Stage 2 released", note: "Stage 1's result verified; stage 2 is released with its settings." },
  { key: "done", label: "All verified", note: "Every stage verified: the import is complete, as the results show." },
];

type StageState = "released" | "waiting" | "verified" | "locked";
const WORD: Readonly<Record<StageState, string>> = {
  released: "Ready to import",
  waiting: "Import step needs your result",
  verified: "Result verified",
  locked: "After the stage before is verified",
};

function statesFor(state: string, count: number): readonly StageState[] {
  const rest = (from: number, value: StageState): StageState[] => Array.from({ length: Math.max(0, count - from) }, () => value);
  if (state === "waiting") return ["waiting", ...rest(1, "locked")];
  if (state === "second") return ["verified", "released", ...rest(2, "locked")];
  if (state === "done") return rest(0, "verified");
  return ["released", ...rest(1, "locked")];
}

export function ImportSteps({ ctx, state, project }: PrototypeProps): ReactElement {
  const words = SERVICE[project.mode];
  const crm = words.destination ?? "";
  const stages = stagesFor(project.mode);
  const states = statesFor(state, stages.length);
  const [ready, setReady] = useState(state !== "normal");
  const done = state === "done";
  if (project.mode === "CLEAN")
    return (
      <>
        <ProjectHeader current="delivery" />
        <PageHead title="Import steps" lead="Not part of this project." />
        <Banner tone="info" title="Clean your data has no import" announce="status">
          <p>The cleaned files are yours to use in any tool. Kauro gives no import steps for a particular CRM, and checks no import result.</p>
        </Banner>
        <div className="kauro-actions">
          <ScreenButton to="UI26" ctx={ctx} project={project.projectId} variant="primary">
            <span className="kauro-go">Go to the delivery</span>
          </ScreenButton>
        </div>
      </>
    );
  return (
    <>
      <ProjectHeader current="import" />
      <PageHead title="Import steps" lead="Use the specified tool and settings for each stage." />
      {done ? (
        <Banner tone="success" title="The import is complete" announce="status">
          <p>
            Every stage is verified against {crm}&apos;s own records: {stages.map((stage) => `${n(stage.rows)} ${stage.name.toLowerCase()}`).join(", ")}. The results page keeps each stage&apos;s figures.
          </p>
        </Banner>
      ) : null}
      <section className="kauro-import-before" aria-labelledby="before-h">
        <h2 id="before-h">Before the first stage</h2>
        <ul>
          <li>
            Your team imports, with its own {crm} {project.mode === "SALESFORCE" ? "org" : "account"} and {words.importer}. Kauro does not connect to {crm} at any step.
          </li>
          <li>Kauro cannot undo an import. Keep a current export of your {words.companies.toLowerCase()} and contacts before you start.</li>
          <li>Import the stages in order, with the settings each stage gives. A setting changed on the way can change the result.</li>
        </ul>
        <label className="kauro-confirm">
          <input type="checkbox" checked={ready} disabled={state !== "normal"} onChange={(event) => setReady(event.target.checked)} />
          <span>
            We have read the steps and hold a current export of our {crm} {words.companies.toLowerCase()} and contacts.
          </span>
        </label>
      </section>
      <ol className="kauro-import-stages">
        {stages.map((stage, index) => {
          const at = states[index] ?? "locked";
          const open = at === "released" || at === "waiting";
          return (
            <li key={stage.sequence} className={`kauro-import-stage kauro-import-stage--${at}`}>
              <div className="kauro-import-stage-head">
                <h2>
                  <span className="kauro-import-stage-number">Stage {stage.sequence}</span> {stage.name}
                </h2>
                <span className="kauro-import-stage-state">{WORD[at]}</span>
              </div>
              <p className="kauro-import-stage-file">
                <code>{stage.file}</code> · {n(stage.rows)} rows · {stage.operation}
                {stage.after === null ? null : <> · after {stage.after}</>}
              </p>
              {open || at === "verified" ? (
                <ul className="kauro-import-stage-settings">
                  {stage.settings.map((setting) => (
                    <li key={setting}>{setting}</li>
                  ))}
                </ul>
              ) : null}
              {at === "released" ? (
                <div className="kauro-actions">
                  <Button variant="primary" disabled={!ready}>
                    I have imported stage {stage.sequence}
                  </Button>
                  {ready ? null : <span className="kauro-muted-text">Confirm the prerequisite first.</span>}
                </div>
              ) : null}
              {at === "waiting" ? (
                <div className="kauro-actions">
                  <ScreenButton to="UI28" ctx={ctx} project={project.projectId} variant="primary">
                    <span className="kauro-go">Return the result of stage {stage.sequence}</span>
                  </ScreenButton>
                </div>
              ) : null}
              {at === "verified" ? (
                <p className="kauro-import-stage-result">
                  {n(stage.rows)} of {n(stage.rows)} rows found in {crm}.{" "}
                  <ScreenLink to="UI28" ctx={ctx} project={project.projectId}>
                    See the result
                  </ScreenLink>
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="kauro-muted">A download is not an import, and a file {crm} marks as a success is not proof on its own: each stage is verified from the result your team returns.</p>
    </>
  );
}
