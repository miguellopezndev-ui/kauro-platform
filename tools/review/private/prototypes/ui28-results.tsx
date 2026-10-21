"use client";
// UI28 Import results (registry: "Match the actual target result to this stage."). The team returns what HubSpot actually holds after a
// stage: the export of the records that import created, with HubSpot's record IDs. Kauro matches each prepared row to a record by its
// identifying value (domain, email), never by its position in a file (registry exception), and counts the result as the api does
// (ImportStageView: matched, failed, unresolved rows) beside what was prepared. A shortfall shows its consequence for the stages after it,
// and only a scope the plan supports can be approved as partial; a second, final result that differs from the first opens a reconciliation
// and holds the next stage.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import { IDS } from "../lib/ids.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { STAGES } from "./delivery.ts";
import { PageHead, ScreenButton, Stamp } from "./kit.tsx";
import { n } from "./plan.tsx";

export const UI28_STATES: readonly StateDef[] = [
  { key: "normal", label: "Waiting for the result", note: "Stage 1 imported: the team returns HubSpot's export of the companies that import created." },
  { key: "checking", label: "Checking", note: "The result is received and being matched, record by record." },
  { key: "verified", label: "Verified", note: "Every prepared company found in HubSpot: stage 2 is released." },
  { key: "partial", label: "A shortfall", note: "12 companies failed in HubSpot: what that means for stage 3, and the two ways on." },
  { key: "mismatch", label: "Results disagree", note: "A second, final result differs from the first: a reconciliation is opened and stage 2 waits." },
];

const stage = STAGES[0] ?? { sequence: 1, name: "Companies", file: "companies-clean.csv", rows: 2_951 };

function Counts({ matched, failed, unresolved }: { readonly matched: number; readonly failed: number; readonly unresolved: number }): ReactElement {
  return (
    <dl className="kauro-identity-counts kauro-result-counts">
      <div>
        <dt>Prepared</dt>
        <dd>{n(stage.rows)}</dd>
        <dd>Rows prepared for this stage</dd>
      </div>
      <div className="is-good">
        <dt>Found in HubSpot</dt>
        <dd>{n(matched)}</dd>
        <dd>Each matched to its record ID by its domain</dd>
      </div>
      <div className={failed > 0 ? "is-bad" : undefined}>
        <dt>Failed in HubSpot</dt>
        <dd>{n(failed)}</dd>
        <dd>{failed > 0 ? "HubSpot refused them; each is listed" : "None"}</dd>
      </div>
      <div className={unresolved > 0 ? "is-bad" : undefined}>
        <dt>Not accounted for</dt>
        <dd>{n(unresolved)}</dd>
        <dd>{unresolved > 0 ? "Neither found nor refused" : "None"}</dd>
      </div>
    </dl>
  );
}

export function ImportResults({ ctx, state }: PrototypeProps): ReactElement {
  const agencyId = ctx.agency?.agencyId ?? "";
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
            <li>In HubSpot, open the import of {stage.file} and choose to view its companies.</li>
            <li>Export them, with the Record ID and Company domain name columns.</li>
            <li>Upload that export here. It stays private to this project and is deleted 7 days after its check is final.</li>
          </ol>
          <label className="kauro-dropzone" htmlFor="receipt-file">
            <strong>Choose HubSpot&apos;s export</strong>
            <span className="kauro-muted-text">CSV or XLSX, as HubSpot gives it</span>
            <input id="receipt-file" type="file" className="kauro-visually-hidden" accept=".csv,.xlsx" />
          </label>
          <p className="kauro-muted">HubSpot&apos;s message that an import succeeded is not enough on its own: Kauro checks the records themselves.</p>
        </section>
      ) : null}
      {state === "checking" ? (
        <Banner tone="info" title="Checking the result" announce="status">
          <p>hubspot-companies-export.csv, received 21 Oct 2026 at 09:14 UTC. Each prepared company is being looked for in it by its domain; this page updates by itself.</p>
        </Banner>
      ) : null}
      {state === "verified" ? (
        <>
          <Counts matched={stage.rows} failed={0} unresolved={0} />
          <section className="kauro-approved" aria-labelledby="verified-h">
            <h2 id="verified-h">Stage 1 is verified</h2>
            <p>Every prepared company is in HubSpot, each with its record ID. Stage 2, Contacts, is released.</p>
            <ScreenButton to="UI27" ctx={ctx} variant="primary">
              <span className="kauro-go">Continue to stage 2</span>
            </ScreenButton>
            <Stamp>Verified</Stamp>
          </section>
        </>
      ) : null}
      {state === "partial" ? (
        <>
          <Counts matched={stage.rows - 12} failed={12} unresolved={0} />
          <section className="kauro-screen-section" aria-labelledby="failed-h">
            <h2 id="failed-h">What the 12 failures change</h2>
            <p>HubSpot refused 12 companies: 9 because a company with the same domain already existed, 3 because the domain was not valid for HubSpot. Their 41 contacts are still imported in stage 2; in stage 3, the 41 links to these companies cannot be made.</p>
            <fieldset className="kauro-choice kauro-screen-choice">
              <legend>How to go on</legend>
              <label>
                <input type="radio" name="partial" defaultChecked />
                <span>
                  <strong>Continue with the 2,939 companies found</strong>
                  <small>Stage 3 leaves out the 41 links to the 12 companies and lists them in the report. The plan supports this scope.</small>
                </span>
              </label>
              <label>
                <input type="radio" name="partial" />
                <span>
                  <strong>Correct them in HubSpot, then return a new result</strong>
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
            <p>The result returned at 11:02 UTC counts 2,951 companies; the one returned at 09:14 counted 2,948. A reconciliation is open, and stage 2 is not released until it is closed.</p>
          </Banner>
          <Counts matched={2_948} failed={0} unresolved={3} />
          <section className="kauro-next" aria-labelledby="recon-h">
            <p className="kauro-next-label">Reconciliation open</p>
            <h2 id="recon-h">Kauro compares the two results, record by record</h2>
            <p>You will hear from Kauro in this project, in writing. Nothing is needed from your team until then, and nothing in HubSpot is changed by Kauro.</p>
          </section>
        </>
      ) : null}
    </>
  );
}
