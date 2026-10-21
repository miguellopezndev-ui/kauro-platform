"use client";
// UI17 Target setup (registry: "Confirm the destination and import method."). The team gives Kauro its destination's own settings, exported
// from the CRM (CreateTargetContract: a metadata file and the importer's profile); Kauro reads them into a draft (TargetContractView: the
// instance, its objects, the importer and when the settings were read); the team confirms that exact draft (ConfirmTargetContract); then
// the free data health check can start on it (StartAudit). A fact Kauro could not establish (whether a field can be written by an import,
// whether it is required, which values a list accepts) stays Unknown and holds back the part of the plan it affects, never a guess
// (registry exceptions). CLEAN has no destination: it goes straight to the check.
import { Banner, Button, StatusBadge } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import { IDS } from "../lib/ids.ts";
import { Facts, PageHead, ScreenButton } from "./kit.tsx";

export const UI17_STATES: readonly StateDef[] = [
  { key: "normal", label: "Read, to confirm", note: "Kauro read the HubSpot settings: the instance, three objects and the importer. One fact is Unknown and holds back what depends on it." },
  { key: "provide", label: "Settings to give", note: "No settings yet: how to export them from HubSpot, and where to put the file." },
  { key: "confirmed", label: "Confirmed", note: "The team confirmed the exact settings: the free data health check can start." },
  { key: "stale", label: "Settings out of date", note: "The settings were read too long ago for a new delivery: export them again." },
  { key: "clean", label: "CLEAN: no destination", note: "A CLEAN project has no destination to set up: it goes straight to the free check." },
];

const OBJECTS = [
  { name: "Contacts", fields: 94, required: "Email", identity: "Email is unique: a row with an address already in HubSpot updates that contact." },
  { name: "Companies", fields: 61, required: "Company domain name", identity: "Domain names are not unique in HubSpot: two companies may share one." },
  { name: "Deals", fields: 48, required: "Deal name, Pipeline, Deal stage", identity: "Sales pipeline, 7 stages; a deal's stage must belong to its pipeline." },
] as const;

export function TargetSetup({ ctx, state }: PrototypeProps): ReactElement {
  const [confirmed, setConfirmed] = useState(state === "confirmed");
  const agencyId = ctx.agency?.agencyId ?? "";
  const days = POLICY_SNAPSHOT.retention.targetExecutionFreshnessDays;
  return (
    <>
      <ProjectHeader current="files" />
      <PageHead title="Target setup" lead="Confirm the destination and import method." />
      {state === "clean" ? (
        <section className="kauro-next" aria-labelledby="target-clean-h">
          <p className="kauro-next-label">No destination</p>
          <h2 id="target-clean-h">CLEAN prepares standard files</h2>
          <p>There is no destination to set up: the files Kauro prepares are cleaned, explained standard files your team imports with its own tools, into another CRM or a spreadsheet.</p>
          <div className="kauro-actions">
            <ScreenButton to="UI18" ctx={ctx} variant="primary">
              <span className="kauro-go">Start the free data health check</span>
            </ScreenButton>
          </div>
        </section>
      ) : state === "provide" ? (
        <>
          <section className="kauro-target-steps" aria-labelledby="target-provide-h">
            <h2 id="target-provide-h">Give Kauro your HubSpot settings</h2>
            <ol>
              <li>
                <strong>Export the properties</strong>
                <span>In HubSpot, open Settings, then Data Management, then Properties, and choose Export all properties.</span>
              </li>
              <li>
                <strong>Upload the exported file here</strong>
                <span>Kauro reads only the settings: no record leaves your HubSpot account, and Kauro never connects to it.</span>
              </li>
              <li>
                <strong>Confirm what Kauro read</strong>
                <span>The instance, the objects and the importer, exactly as the plan will use them.</span>
              </li>
            </ol>
          </section>
          <label className="kauro-dropzone">
            <span className="kauro-dropzone-title">Choose the exported settings, or drop them here</span>
            <span className="kauro-dropzone-label">HubSpot properties export (CSV or XLSX)</span>
            <span className="kauro-dropzone-limits">The settings are kept for up to {POLICY_SNAPSHOT.retention.targetMetadataDaysFromLastUse} days after their last use, and used for a new delivery for {days} days at most.</span>
            <input type="file" accept=".csv,.xlsx" />
          </label>
        </>
      ) : (
        <>
          {state === "stale" ? (
            <Banner tone="warning" title="These settings are too old for a new delivery" announce="status">
              <p>They were read on 12 Sep 2026. Settings are used to prepare a delivery for {days} days at most, so export them again before the free check.</p>
            </Banner>
          ) : null}
          <section className="kauro-set-status" aria-labelledby="target-status-h">
            <h2 id="target-status-h">The destination</h2>
            <p>
              <StatusBadge tone={confirmed ? "success" : state === "stale" ? "warning" : "info"}>{confirmed ? "Confirmed" : state === "stale" ? "Out of date" : "Read, waiting for your confirmation"}</StatusBadge>
            </p>
          </section>
          <Facts
            rows={[
              ["Destination", "HubSpot"],
              ["Account", "HubSpot account 24816309"],
              ["Import method", "HubSpot importer, as of October 2026"],
              ["Settings read", state === "stale" ? "12 Sep 2026, 10:15 UTC" : "20 Oct 2026, 09:40 UTC"],
            ]}
          />
          <section className="kauro-screen-section" aria-labelledby="target-objects-h">
            <h2 id="target-objects-h">What Kauro read</h2>
            <ul className="kauro-ledger-list">
              {OBJECTS.map((object) => (
                <li key={object.name} className="kauro-ledger-item">
                  <div className="kauro-ledger-item-head">
                    <h3>{object.name}</h3>
                    <span className="kauro-muted-text">{object.fields} properties</span>
                  </div>
                  <dl className="kauro-ledger-facts">
                    <div>
                      <dt>Required by HubSpot</dt>
                      <dd>{object.required}</dd>
                    </div>
                    <div className="kauro-ledger-wide">
                      <dt>How records are matched</dt>
                      <dd>{object.identity}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </section>
          <section className="kauro-screen-section" aria-labelledby="target-unknown-h">
            <h2 id="target-unknown-h">Not known yet</h2>
            <div className="kauro-unknown">
              <p className="kauro-unknown-what">
                <span className="kauro-unknown-tag">Unknown</span> Whether <strong>Deal owner</strong> can be set by an import in this account
              </p>
              <p>Until it is known, the plan leaves deal owners out. Everything else can be prepared. Ask your HubSpot administrator, then export the settings again, or go on without deal owners.</p>
            </div>
          </section>
          <div className="kauro-actions">
            {confirmed ? (
              <ScreenButton to="UI18" ctx={ctx} variant="primary">
                <span className="kauro-go">Start the free data health check</span>
              </ScreenButton>
            ) : state === "stale" ? (
              <ScreenButton to="UI17" ctx={ctx} variant="primary">
                Export and upload the settings again
              </ScreenButton>
            ) : (
              <Button variant="primary" onClick={() => setConfirmed(true)}>
                Confirm these settings
              </Button>
            )}
          </div>
          {confirmed ? <p className="kauro-muted">Confirmed on 20 Oct 2026. If HubSpot&apos;s settings change in a material way, Kauro stops using these and asks again.</p> : null}
        </>
      )}
    </>
  );
}
