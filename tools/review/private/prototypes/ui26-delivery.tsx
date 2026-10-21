"use client";
// UI26 Delivery (registry: "Download the verified package before its deadline."). The package as one immutable version: its verification,
// its files with their counts, sizes and fingerprints, and the date it goes. Downloading is a request for chosen files that asks for Kauro's
// code again and returns links that work for 15 minutes; a link once issued cannot be withdrawn before it expires (DownloadView:
// providerRevocation UNAVAILABLE), so the page says so. An expired package has no links at all, and a correction is a new version that says
// what changed (registry exceptions). Downloading is not importing: a CRM project stays prepared for import (How it works); "Clean your data"
// has no import, so its delivery is the end of the work.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import { IDS } from "../lib/ids.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { CodeField } from "./auth.tsx";
import { bytes, HARD_DEADLINE, LINK_MINUTES, OUTPUT, packageFilesFor, READY_AT, SOFT_DEADLINE, stagesFor } from "./delivery.ts";
import { moment, PageHead, ScreenButton, ScreenLink, Stamp } from "./kit.tsx";
import { n, PLAN } from "./plan.tsx";
import { SERVICE } from "./service.ts";

export const UI26_STATES: readonly StateDef[] = [
  { key: "normal", label: "Ready to download", note: "Version 1, verified: seven files, their counts and fingerprints, and the date the package goes." },
  { key: "links", label: "Links issued", note: "After Kauro's code: one link a chosen file, each working for 15 minutes." },
  { key: "corrected", label: "A corrected version", note: "Version 2 replaces version 1 and says what changed; version 1 has no links any more." },
  { key: "expired", label: "Removed", note: "The keeping period ended: the package is removed and nothing can be downloaded." },
];

export function Delivery({ ctx, state, project }: PrototypeProps): ReactElement {
  const agencyId = ctx.agency?.agencyId ?? "";
  const expired = state === "expired";
  const version = state === "corrected" ? 2 : 1;
  const PACKAGE_FILES = packageFilesFor(project.mode);
  const stages = stagesFor(project.mode);
  const words = SERVICE[project.mode];
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(PACKAGE_FILES.map((file) => file.name)));
  const [step, setStep] = useState<"choose" | "code" | "links">(state === "links" ? "links" : "choose");
  const toggle = (name: string): void =>
    setChosen((now) => {
      const next = new Set(now);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  return (
    <>
      <ProjectHeader current="delivery" />
      <PageHead title="Delivery" lead="Download the verified package before its deadline." />
      {expired ? (
        <Banner tone="neutral" title="This package was removed on Oct 27, 2026" announce="status">
          <p>Its keeping period ended, so the files are deleted from Kauro and cannot be downloaded again. Copies your team downloaded stay with you. The report of what was delivered stays below.</p>
        </Banner>
      ) : null}
      {state === "corrected" ? (
        <Banner tone="info" title="Version 2 replaces version 1" announce="status">
          <p>Version 1 repeated 3 rows in {PACKAGE_FILES[0]?.name}; version 2 removes them, and nothing else changed. Version 1 can no longer be downloaded, and version 2's report lists exactly what changed{stages.length === 0 ? "" : ", with what to do if your team already imported version 1"}.</p>
        </Banner>
      ) : null}
      <section className="kauro-package" aria-labelledby="package-h">
        <div className="kauro-package-head">
          <div>
            <h2 id="package-h">Package version {version}</h2>
            <p className="kauro-muted-text">Verified {moment(state === "corrected" ? "2026-10-21T10:05:00Z" : READY_AT)}</p>
          </div>
          {expired ? null : <Stamp>Verified</Stamp>}
        </div>
        <ul className="kauro-package-checks">
          <li>The counts reconcile: {n(OUTPUT.source)} source rows, less {n(OUTPUT.contactsUnified + OUTPUT.companiesUnified)} unified with approval, leave {n(OUTPUT.contacts)} contacts and {n(OUTPUT.companies)} companies.</li>
          <li>Every output row traces to the source rows it came from; the manifest lists each one.</li>
          <li>The checks recomputed the result from the sealed files, not from the totals.</li>
        </ul>
        {expired ? null : (
          <p className="kauro-package-deadline">
            <strong>Available until {moment(SOFT_DEADLINE)}</strong>
            <span>Removed no later than {moment(HARD_DEADLINE)}. Data lifecycle shows each date, and the one extension this project can have.</span>
          </p>
        )}
      </section>
      <section className="kauro-screen-section" aria-labelledby="files-h">
        <h2 id="files-h">{expired ? "What the package held" : "Files"}</h2>
        <div className="kauro-table-region">
          <table className="kauro-table kauro-package-files">
            <caption className="kauro-visually-hidden">The files of package version {version}</caption>
            <thead>
              <tr>
                {expired || step !== "choose" ? null : (
                  <th scope="col">
                    <span className="kauro-visually-hidden">Download</span>
                  </th>
                )}
                <th scope="col">File</th>
                <th scope="col" className="kauro-table-end">
                  Rows
                </th>
                <th scope="col" className="kauro-table-end">
                  Size
                </th>
                <th scope="col">Fingerprint</th>
              </tr>
            </thead>
            <tbody>
              {PACKAGE_FILES.map((file) => (
                <tr key={file.name}>
                  {expired || step !== "choose" ? null : (
                    <td className="kauro-package-pick">
                      <input type="checkbox" id={`pick-${file.name}`} checked={chosen.has(file.name)} onChange={() => toggle(file.name)} />
                    </td>
                  )}
                  <th scope="row">
                    <label htmlFor={`pick-${file.name}`} className="kauro-package-name">
                      {file.name}
                    </label>
                    <span className="kauro-package-role">{file.role}</span>
                  </th>
                  <td className="kauro-table-end" data-label="Rows">
                    {file.rows === null ? "—" : n(file.rows)}
                  </td>
                  <td className="kauro-table-end" data-label="Size">
                    {bytes(file.bytes)}
                  </td>
                  <td data-label="Fingerprint">
                    <code>sha256 {file.sha}…</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {expired ? null : step === "links" ? (
        <section className="kauro-links-issued" aria-labelledby="issued-h">
          <h2 id="issued-h">Your links</h2>
          <p>Each link works for {LINK_MINUTES} minutes, until 4:47 PM UTC, for the person who asked for it. A link that was issued cannot be withdrawn before then.</p>
          <ul>
            {PACKAGE_FILES.filter((file) => chosen.has(file.name)).map((file) => (
              <li key={file.name}>
                <a href="#download" onClick={(event) => event.preventDefault()}>
                  Download {file.name}
                </a>
                <span>{bytes(file.bytes)}</span>
              </li>
            ))}
          </ul>
          <Button onClick={() => setStep("choose")}>Choose other files</Button>
        </section>
      ) : (
        <section className="kauro-approve" aria-labelledby="download-h">
          <h2 id="download-h">Download</h2>
          {step === "code" ? (
            <div className="kauro-approve-code">
              <CodeField id="download-code" label="Your Kauro code" hint="Downloading customer data asks who you are again." />
              <Button variant="primary" onClick={() => setStep("links")}>
                Get the links
              </Button>
            </div>
          ) : (
            <Button variant="primary" disabled={chosen.size === 0} onClick={() => setStep("code")}>
              {chosen.size === PACKAGE_FILES.length ? "Download all files" : `Download ${chosen.size} ${chosen.size === 1 ? "file" : "files"}`}
            </Button>
          )}
          <p className="kauro-muted">
            {stages.length === 0
              ? "Nothing more is needed from your team: download the files you want before their deletion date."
              : "Downloading is not importing: the project stays prepared for import until your team returns each stage's result."}
          </p>
        </section>
      )}
      <section className="kauro-next" aria-labelledby="next-h">
        <p className="kauro-next-label">Next</p>
        {stages.length === 0 ? (
          <>
            <h2 id="next-h">Use the cleaned files in any tool</h2>
            <p>There is no import for Kauro to check. The report explains every change, and the manifest shows where each row came from, so your team can trust the files wherever they go.</p>
          </>
        ) : (
          <>
            <h2 id="next-h">
              Import in {stages.length === 2 ? "two" : "three"} stages, in your own {words.destination} {project.mode === "SALESFORCE" ? "org" : "account"}
            </h2>
            <p>
              {stages.map((stage) => stage.name).join(", then ")}. After each stage, your team returns its result and Kauro checks it before the next.
            </p>
          </>
        )}
        <div className="kauro-actions">
          {stages.length === 0 ? null : (
            <ScreenButton to="UI27" ctx={ctx} project={project.projectId} variant="primary">
              <span className="kauro-go">Open the import steps</span>
            </ScreenButton>
          )}
          <ScreenLink to="UI29" ctx={ctx} project={project.projectId}>
            Data lifecycle
          </ScreenLink>
        </div>
      </section>
    </>
  );
}
