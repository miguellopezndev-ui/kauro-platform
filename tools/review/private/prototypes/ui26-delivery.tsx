"use client";
// UI26 Delivery (registry: "Download the verified package before its deadline."). Round 2 (research agency-workspace.md §5.15): the page
// answers one question first, "until when can we take it?", so the availability date is the most visible date on the page, with the hard
// limit under it; then the proof (three reconciliation lines and the one stamp the identity allows, on a verdict); then the one primary
// action, "Download all files". The files follow as a table (rows and sizes right-aligned and tabular, the fingerprint's first 12 characters
// with the full value on copy, a quiet download link a row). Downloading asks for Kauro's code again, for everyone, viewers included
// (CMD038 is a step-up command), and returns links that work for 15 minutes; an issued link cannot be withdrawn before then (DownloadView:
// providerRevocation UNAVAILABLE). Two ends that look alike are kept apart: links that ran out ("Get new links", while the package is kept)
// and a package that is deleted ("Deleted on …", nothing to request). A download is not an import: a CRM project stays prepared for import
// until each stage's result is verified; "Clean your data" has no import, so its delivery is the end of the work.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { CopyValue } from "@web/screens/shared/copy-value.tsx";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { CodeField } from "./auth.tsx";
import { AVAILABLE_UNTIL, bytes, CORRECTED_AT, HARD_LIMIT, LINK_MINUTES, OUTPUT, packageFilesFor, READY_AT, stagesFor } from "./delivery.ts";
import { moment, ScreenButton, ScreenLink, Stamp } from "./kit.tsx";
import { n } from "./plan.tsx";
import { SERVICE } from "./service.ts";

export const UI26_STATES: readonly StateDef[] = [
  { key: "normal", label: "Ready to download", note: "Version 1, verified: the date to download by, the proof, one action, then each file with its count, size and fingerprint." },
  { key: "links", label: "Links issued", note: "After Kauro's code: one link a chosen file, each working for 15 minutes." },
  { key: "links-expired", label: "Links ran out", note: "The links worked for 15 minutes and ran out; the package is still kept, so new links can be asked for with the code." },
  { key: "corrected", label: "A corrected version", note: "Version 2 replaces version 1 and says what changed; version 1 has no links any more, and the dates do not move." },
  { key: "removed", label: "Deleted", note: "The keeping period ended: the files are deleted and nothing can be requested; what the package held stays listed." },
];

const ORDINAL = ["", "one", "two", "three", "four"];

export function Delivery({ ctx, state, project }: PrototypeProps): ReactElement {
  const removed = state === "removed";
  const version = state === "corrected" ? 2 : 1;
  const files = packageFilesFor(project.mode);
  const stages = stagesFor(project.mode);
  const words = SERVICE[project.mode];
  const crm = words.destination ?? "";
  const place = project.mode === "SALESFORCE" ? "org" : "account";
  const [step, setStep] = useState<"choose" | "code" | "links" | "ran-out">(state === "links" ? "links" : state === "links-expired" ? "ran-out" : "choose");
  const [chosen, setChosen] = useState<readonly string[]>(files.map((file) => file.name));
  const ask = (names: readonly string[]): void => {
    setChosen(names);
    setStep("code");
  };
  const all = chosen.length === files.length;
  const status = removed ? { tone: "neutral" as const, text: "Package deleted" } : { tone: "success" as const, text: version === 2 ? "Version 2 verified" : "Package verified" };
  const later = stages.find((stage) => stage.releasedAfter);

  return (
    <>
      <ProjectHeader stage="delivery" title="Delivery" lead="Download the verified package before its deadline." status={status} />

      {state === "corrected" ? (
        <Banner tone="info" title="Version 2 replaces version 1" announce="status">
          <p>
            Version 1 repeated 3 rows in {files[0]?.name}; version 2 removes them, and nothing else changed. Version 1 can no longer be downloaded. The dates below do not move: they count from
            the first package.{stages.length === 0 ? "" : " If your team already imported version 1, the report says what to do with those 3 rows."}
          </p>
        </Banner>
      ) : null}

      <section className="kauro-dl-package" aria-labelledby="package-h">
        <div className="kauro-dl-head">
          <div className="kauro-dl-title">
            <h2 id="package-h">{removed ? `Package version ${version} was deleted` : `Package version ${version} is verified`}</h2>
            <p className="kauro-dl-meta">Verified {moment(version === 2 ? CORRECTED_AT : READY_AT)}</p>
          </div>
          {removed ? null : <Stamp>Verified</Stamp>}
        </div>

        {removed ? (
          <p className="kauro-dl-when">
            <strong>Deleted on {moment(AVAILABLE_UNTIL)}</strong>
            <span>The keeping period ended, so the files are gone from Kauro and nothing can be requested. Copies your team downloaded stay with you; the record of the deletion is in Data and deletion.</span>
          </p>
        ) : (
          <p className="kauro-dl-when">
            <strong>Download by {moment(AVAILABLE_UNTIL)}</strong>
            <span>
              Deleted no later than {moment(HARD_LIMIT)}. One extension of up to 72 hours is possible before then:{" "}
              <ScreenLink to="UI29" ctx={ctx} project={project.projectId}>
                Data and deletion
              </ScreenLink>
              .
            </span>
          </p>
        )}

        <ul className="kauro-dl-checks">
          <li>
            The counts reconcile: {n(OUTPUT.source)} source rows, less {n(OUTPUT.contactsUnified + OUTPUT.companiesUnified)} unified with your approval, leave {n(OUTPUT.contacts)} contacts and {n(OUTPUT.companies)}{" "}
            {words.companies.toLowerCase()}.
          </li>
          <li>Every output row traces to the source rows it came from; the manifest lists each one.</li>
          <li>The checks recomputed the result from the sealed files, not from the totals.</li>
        </ul>

        {removed ? null : (
          <div className="kauro-dl-action">
            {step === "choose" ? (
              <>
                <Button variant="primary" onClick={() => ask(files.map((file) => file.name))}>
                  Download all files
                </Button>
                <p className="kauro-dl-hint">Downloading asks for your Kauro code again, for every member, viewers included.</p>
              </>
            ) : null}
            {step === "code" ? (
              <div className="kauro-dl-code">
                <p>{all ? `All ${files.length} files` : `${chosen.join(", ")}`}: enter the code from your authenticator app to get the links.</p>
                <CodeField id="download-code" label="Your Kauro code" hint="Six digits. You can paste it." />
                <div className="kauro-dl-code-actions">
                  <Button variant="primary" onClick={() => setStep("links")}>
                    Get the links
                  </Button>
                  <button type="button" className="kauro-text-button" onClick={() => setStep("choose")}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            {step === "links" ? (
              <div className="kauro-dl-links" aria-labelledby="links-h">
                <h3 id="links-h">Your links</h3>
                <p>Each link works for {LINK_MINUTES} minutes, for you only. A link already issued cannot be withdrawn before then.</p>
                <ul>
                  {files
                    .filter((file) => chosen.includes(file.name))
                    .map((file) => (
                      <li key={file.name}>
                        <a href="#download" onClick={(event) => event.preventDefault()}>
                          {file.name}
                        </a>
                        <span>{bytes(file.bytes)}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}
            {step === "ran-out" ? (
              <>
                <p className="kauro-dl-ranout">
                  <strong>Your links ran out.</strong> They work for {LINK_MINUTES} minutes; the package is still kept until {moment(AVAILABLE_UNTIL)}.
                </p>
                <Button variant="primary" onClick={() => ask(files.map((file) => file.name))}>
                  Get new links
                </Button>
              </>
            ) : null}
          </div>
        )}
      </section>

      <section className="kauro-dl-files" aria-labelledby="files-h">
        <h2 id="files-h">{removed ? "What the package held" : `The ${files.length} files`}</h2>
        <table className="kauro-rtable kauro-dl-table">
          <caption className="kauro-visually-hidden">The files of package version {version}</caption>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col" className="kauro-num">
                Rows
              </th>
              <th scope="col" className="kauro-num">
                Size
              </th>
              <th scope="col">Fingerprint (SHA-256)</th>
              {removed ? null : (
                <th scope="col">
                  <span className="kauro-visually-hidden">Download</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={file.name}>
                <td data-label="">
                  <code className="kauro-dl-name">{file.name}</code>
                  <span className="kauro-sub">{file.role}</span>
                </td>
                <td className="kauro-num" data-label="Rows">
                  {file.rows === null ? "—" : n(file.rows)}
                </td>
                <td className="kauro-num" data-label="Size">
                  {bytes(file.bytes)}
                </td>
                <td data-label="Fingerprint">
                  <span className="kauro-dl-sha">
                    <code>{file.sha.slice(0, 12)}…</code>
                    {removed ? null : <CopyValue value={file.sha} label={`the fingerprint of ${file.name}`} />}
                  </span>
                </td>
                {removed ? null : (
                  <td data-label="">
                    <button type="button" className="kauro-text-button" onClick={() => ask([file.name])}>
                      Download<span className="kauro-visually-hidden"> {file.name}</span>
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {later === undefined ? null : (
          <p className="kauro-dl-note">
            Stage {later.sequence}&apos;s file, {later.file}, is not in the package yet: Kauro releases it once stage {later.sequence - 1} is verified, with each {later.name.toLowerCase().replace(/s$/, "")}&apos;s
            AccountId taken from your stage {later.sequence - 1} success file.
          </p>
        )}
        {removed ? null : (
          <details className="kauro-dl-intact">
            <summary>Check that your files arrived intact</summary>
            <p>Compute each file&apos;s SHA-256 fingerprint and compare it with the full value you copy from the table. They must be identical.</p>
            <dl>
              <div>
                <dt>macOS or Linux</dt>
                <dd>
                  <code>shasum -a 256 {files[0]?.name}</code>
                </dd>
              </div>
              <div>
                <dt>Windows</dt>
                <dd>
                  <code>certutil -hashfile {files[0]?.name} SHA256</code>
                </dd>
              </div>
            </dl>
          </details>
        )}
      </section>

      {removed ? null : (
      <section className="kauro-dl-next" aria-labelledby="next-h">
        {stages.length === 0 ? (
          <>
            <h2 id="next-h">Next: use the cleaned files in any tool</h2>
            <p>
              There is no import for Kauro to check: once your team has the files, the work of this project is done. The report explains every change and the manifest shows where each row came from,
              so the files can be trusted wherever they go.
            </p>
          </>
        ) : (
          <>
            <h2 id="next-h">
              Next: import in {ORDINAL[stages.length] ?? stages.length} stages, in your own {crm} {place}
            </h2>
            <p>
              {stages.map((stage) => stage.name).join(", then ")}. After each stage your team returns its result, and Kauro checks it before the next. Until then the project stays prepared for
              import: a download is not an import.
            </p>
            <p>
              <ScreenButton to="UI27" ctx={ctx} project={project.projectId}>
                <span className="kauro-go">Open the import steps</span>
              </ScreenButton>
            </p>
          </>
        )}
      </section>
      )}
    </>
  );
}
