"use client";
// UI27 Import steps (registry: "Use the specified tool and settings for each stage."). The import is the customer's: Kauro never writes to
// the CRM, so the page is a guide with checkpoints. Before the first stage, one prerequisite: a current export of the account, because Kauro
// cannot undo an import. Then the stages in order (ImportStageView: sequence, object, operation, parent stages), each with its file, its
// rows, the importer and the exact settings, and its state in words. A released stage waiting for the team reads "Import step needs your
// result" (registry exception for AWAITING_AGENCY_IMPORT), and a later stage stays locked until the stage before it is verified.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import { IDS } from "../lib/ids.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { STAGES } from "./delivery.ts";
import { PageHead, ScreenButton, ScreenLink } from "./kit.tsx";
import { n } from "./plan.tsx";

export const UI27_STATES: readonly StateDef[] = [
  { key: "normal", label: "Before the first stage", note: "The prerequisite to confirm, then stage 1 released; stages 2 and 3 wait for the result of the stage before." },
  { key: "waiting", label: "Needs your result", note: "Stage 1 imported by the team: the step needs its result before stage 2 is released." },
  { key: "second", label: "Stage 2 released", note: "Stage 1's result verified; stage 2 is released with its settings." },
  { key: "done", label: "All verified", note: "The three stages verified: the import is complete, as the results show." },
];

type StageState = "released" | "waiting" | "checking" | "verified" | "locked";
const WORD: Readonly<Record<StageState, string>> = {
  released: "Ready to import",
  waiting: "Import step needs your result",
  checking: "Checking your result",
  verified: "Result verified",
  locked: "After the stage before is verified",
};

function statesFor(state: string): readonly StageState[] {
  if (state === "waiting") return ["waiting", "locked", "locked"];
  if (state === "second") return ["verified", "released", "locked"];
  if (state === "done") return ["verified", "verified", "verified"];
  return ["released", "locked", "locked"];
}

export function ImportSteps({ ctx, state }: PrototypeProps): ReactElement {
  const agencyId = ctx.agency?.agencyId ?? "";
  const stages = statesFor(state);
  const [ready, setReady] = useState(state !== "normal");
  const done = state === "done";
  return (
    <>
      <ProjectHeader current="import" />
      <PageHead title="Import steps" lead="Use the specified tool and settings for each stage." />
      {done ? (
        <Banner tone="success" title="The import is complete" announce="status">
          <p>All three stages are verified against HubSpot&apos;s own results: {n(STAGES[0]?.rows ?? 0)} companies, {n(STAGES[1]?.rows ?? 0)} contacts and {n(STAGES[2]?.rows ?? 0)} links. The results page keeps each stage&apos;s figures.</p>
        </Banner>
      ) : null}
      <section className="kauro-import-before" aria-labelledby="before-h">
        <h2 id="before-h">Before the first stage</h2>
        <ul>
          <li>Your team imports, with its own HubSpot account and HubSpot&apos;s importer. Kauro does not connect to HubSpot at any step.</li>
          <li>Kauro cannot undo an import. Keep a current export of your companies and contacts before you start.</li>
          <li>Import the stages in order, with the settings each stage gives. A setting changed on the way can change the result.</li>
        </ul>
        <label className="kauro-confirm">
          <input type="checkbox" checked={ready} disabled={state !== "normal"} onChange={(event) => setReady(event.target.checked)} />
          <span>We have read the steps and hold a current export of our HubSpot companies and contacts.</span>
        </label>
      </section>
      <ol className="kauro-import-stages">
        {STAGES.map((stage, index) => {
          const at = stages[index] ?? "locked";
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
                  <ScreenButton to="UI28" ctx={ctx} variant="primary">
                    <span className="kauro-go">Return the result of stage {stage.sequence}</span>
                  </ScreenButton>
                </div>
              ) : null}
              {at === "verified" ? (
                <p className="kauro-import-stage-result">
                  {n(stage.rows)} of {n(stage.rows)} rows matched in HubSpot.{" "}
                  <ScreenLink to="UI28" ctx={ctx}>
                    See the result
                  </ScreenLink>
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="kauro-muted">A download is not an import, and a file HubSpot marks as a success is not proof on its own: each stage is verified from the result your team returns.</p>
    </>
  );
}
