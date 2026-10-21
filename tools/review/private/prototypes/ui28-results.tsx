"use client";
// UI28 Import results (registry: "Match the actual target result to this stage."). The team returns what the CRM actually holds after a
// stage. Kauro matches each prepared row to a record by its identifying values, never by its position in a file (registry exception), and
// counts the result as the api does (ImportStageView: matched, failed, unresolved rows) beside what was prepared, in the CRM's own words: a
// record HubSpot created, a row Data Loader's error file refused. A shortfall shows its consequence for the stages after it, and only a
// scope the plan supports can be approved as partial; a second, final result that differs from the first opens a reconciliation and holds
// the next stage. Adapted to the service: HubSpot returns the export of the records an import created, with their record IDs; Salesforce
// returns Data Loader's success and error files; "Clean your data" has no import.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { stagesFor } from "./delivery.ts";
import { PageHead, ScreenButton, Stamp } from "./kit.tsx";
import { n } from "./plan.tsx";
import { SERVICE } from "./service.ts";

export const UI28_STATES: readonly StateDef[] = [
  { key: "normal", label: "Waiting for the result", note: "Stage 1 imported: the team returns what the CRM holds for it (HubSpot's export, or Data Loader's success and error files)." },
  { key: "checking", label: "Checking", note: "The result is received and being matched, record by record." },
  { key: "verified", label: "Verified", note: "Every prepared record found in the CRM: the next stage is released." },
  { key: "partial", label: "A shortfall", note: "12 records were refused by the CRM: what that means for the next stages, and the two ways on." },
  { key: "mismatch", label: "Results disagree", note: "A second, final result differs from the first: a reconciliation is opened and the next stage waits." },
];

export function ImportResults({ ctx, state, project }: PrototypeProps): ReactElement {
  const words = SERVICE[project.mode];
  const crm = words.destination ?? "";
  const salesforce = project.mode === "SALESFORCE";
  const stages = stagesFor(project.mode);
  const stage = stages[0];
  const nextStage = stages[1];
  if (stage === undefined)
    return (
      <>
        <ProjectHeader current="delivery" />
        <PageHead title="Import results" lead="Not part of this project." />
        <Banner tone="info" title="Clean your data has no import" announce="status">
          <p>No import result is returned or checked: the cleaned files are yours to use in any tool.</p>
        </Banner>
      </>
    );
  const thing = stage.name.toLowerCase();
  const found = salesforce ? "Inserted" : "Created in HubSpot";
  const refused = salesforce ? "In the error file" : "Refused by HubSpot";
  const Counts = ({ matched, failed, unresolved }: { readonly matched: number; readonly failed: number; readonly unresolved: number }): ReactElement => (
    <dl className="kauro-identity-counts kauro-result-counts">
      <div>
        <dt>Prepared</dt>
        <dd>{n(stage.rows)}</dd>
        <dd>Rows prepared for this stage</dd>
      </div>
      <div className="is-good">
        <dt>{found}</dt>
        <dd>{n(matched)}</dd>
        <dd>{salesforce ? "Each matched to its Salesforce ID by its name and website" : "Each matched to its record ID by its domain"}</dd>
      </div>
      <div className={failed > 0 ? "is-bad" : undefined}>
        <dt>{refused}</dt>
        <dd>{n(failed)}</dd>
        <dd>{failed > 0 ? `${crm} refused them; each is listed with its reason` : "None"}</dd>
      </div>
      <div className={unresolved > 0 ? "is-bad" : undefined}>
        <dt>Not accounted for</dt>
        <dd>{n(unresolved)}</dd>
        <dd>{unresolved > 0 ? "Neither found nor refused" : "None"}</dd>
      </div>
    </dl>
  );
  return (
    <>
      <ProjectHeader current="import" />
      <PageHead title="Import results" lead="Match the actual target result to this stage." />
      <p className="kauro-result-stage">
        <strong>
          Stage {stage.sequence}, {stage.name}
        </strong>{" "}
        · package version 1 · <code>{stage.file}</code>
      </p>
      {state === "normal" ? (
        <section className="kauro-screen-section" aria-labelledby="return-h">
          <h2 id="return-h">Return the result</h2>
          <ol className="kauro-import-order">
            {salesforce ? (
              <>
                <li>When Data Loader finishes, it writes a success file and an error file for {stage.file}.</li>
                <li>Upload both here, as Data Loader wrote them.</li>
              </>
            ) : (
              <>
                <li>In HubSpot, open the import of {stage.file} and choose to view its {thing}.</li>
                <li>Export them, with the Record ID and Company domain name columns.</li>
                <li>Upload that export here.</li>
              </>
            )}
            <li>It stays private to this project and is deleted 7 days after its check is final.</li>
          </ol>
          <label className="kauro-dropzone" htmlFor="receipt-file">
            <strong>{salesforce ? "Choose Data Loader's success and error files" : "Choose HubSpot's export"}</strong>
            <span className="kauro-muted-text">{salesforce ? "CSV files" : "CSV or XLSX, as HubSpot gives it"}</span>
            <input id="receipt-file" type="file" className="kauro-visually-hidden" accept=".csv,.xlsx" multiple={salesforce} />
          </label>
          <p className="kauro-muted">A message that an import succeeded is not enough on its own: Kauro checks the records themselves.</p>
        </section>
      ) : null}
      {state === "checking" ? (
        <Banner tone="info" title="Checking the result" announce="status">
          <p>
            {salesforce ? "success.csv and error.csv" : "hubspot-companies-export.csv"}, received Oct 21, 2026 at 9:14 AM UTC. Each prepared row is being looked for in it by its identifying values; this page updates by itself.
          </p>
        </Banner>
      ) : null}
      {state === "verified" ? (
        <>
          <Counts matched={stage.rows} failed={0} unresolved={0} />
          <section className="kauro-approved" aria-labelledby="verified-h">
            <h2 id="verified-h">Stage {stage.sequence} is verified</h2>
            <p>
              Every prepared row is in {crm}, each with its {salesforce ? "Salesforce ID" : "record ID"}. {nextStage === undefined ? "The import is complete." : `Stage ${nextStage.sequence}, ${nextStage.name}, is released.`}
            </p>
            <ScreenButton to="UI27" ctx={ctx} project={project.projectId} variant="primary">
              <span className="kauro-go">{nextStage === undefined ? "Back to the import steps" : `Continue to stage ${nextStage.sequence}`}</span>
            </ScreenButton>
            <Stamp>Verified</Stamp>
          </section>
        </>
      ) : null}
      {state === "partial" ? (
        <>
          <Counts matched={stage.rows - 12} failed={12} unresolved={0} />
          <section className="kauro-screen-section" aria-labelledby="failed-h">
            <h2 id="failed-h">What the 12 refusals change</h2>
            <p>
              {crm} refused 12 {thing}: 9 because a record with the same {salesforce ? "name" : "domain"} already existed, 3 because a value was not valid for {crm}. Their 41 contacts are still
              imported in stage 2, without {salesforce ? "their account" : "a link to their company"}.
            </p>
            <fieldset className="kauro-choice kauro-screen-choice">
              <legend>How to go on</legend>
              <label>
                <input type="radio" name="partial" defaultChecked />
                <span>
                  <strong>
                    Continue with the {n(stage.rows - 12)} {thing} found
                  </strong>
                  <small>The 41 contacts go on without {salesforce ? "an account" : "the link"}, and the report lists them. The plan supports this scope.</small>
                </span>
              </label>
              <label>
                <input type="radio" name="partial" />
                <span>
                  <strong>Correct them in {crm}, then return a new result</strong>
                  <small>Stage 2 waits until the new result is checked.</small>
                </span>
              </label>
            </fieldset>
            <Button variant="primary">Confirm how to go on</Button>
          </section>
        </>
      ) : null}
      {state === "mismatch" ? (
        <>
          <Banner tone="warning" title="Two final results disagree" announce="alert">
            <p>
              The result returned at 11:02 AM UTC counts {n(stage.rows)} {thing}; the one returned at 9:14 AM counted {n(stage.rows - 3)}. A reconciliation is open, and stage 2 is not released until it is closed.
            </p>
          </Banner>
          <Counts matched={stage.rows - 3} failed={0} unresolved={3} />
          <section className="kauro-next" aria-labelledby="recon-h">
            <p className="kauro-next-label">Reconciliation open</p>
            <h2 id="recon-h">Kauro compares the two results, record by record</h2>
            <p>You will hear from Kauro in this project, in writing. Nothing is needed from your team until then, and nothing in {crm} is changed by Kauro.</p>
          </section>
        </>
      ) : null}
    </>
  );
}
