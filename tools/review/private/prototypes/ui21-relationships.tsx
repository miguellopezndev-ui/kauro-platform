"use client";
// UI21 Relationships (registry: "Confirm how records stay connected."). Contacts linked to their company by the Company column: how many
// link, how many cannot and why, and the order the import takes (companies first, then contacts with their company). A contact whose
// company is not in companies.xlsx stays explicitly without a link: Kauro never creates the missing company and never shows a link it will
// not prepare as made (registry exceptions). The team approves the links that can be made and says what happens to the rest.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement } from "react";
import { ProjectStages } from "@web/screens/shared/project-stages.tsx";
import { IDS } from "../lib/ids.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { PageHead, ScreenButton } from "./kit.tsx";
import { n, PLAN, PlanTasks } from "./plan.tsx";

export const UI21_STATES: readonly StateDef[] = [
  { key: "normal", label: "Links to confirm", note: "11,906 contacts link to their company; 360 cannot, each reason counted and shown." },
  { key: "confirmed", label: "Confirmed", note: "The links are approved for the plan, and the contacts without a company are imported without one, on purpose." },
];

const NOT_FOUND = [
  { name: "Harbour Mill Ltd", rows: 61, near: "Harbor Mill" },
  { name: "Osprey Freight Group", rows: 48, near: "Osprey Freight" },
  { name: "Larch Studios", rows: 37, near: "Larch Studio" },
  { name: "Juniper & Co", rows: 29, near: null },
  { name: "38 other names", rows: 39, near: null },
] as const;

const STATES = { mapping: "done", identity: "done", relationships: "review", approval: "waiting" } as const;

export function Relationships({ ctx, state }: PrototypeProps): ReactElement {
  const agencyId = ctx.agency?.agencyId ?? "";
  const confirmed = state === "confirmed";
  const output = PLAN.contacts - PLAN.unifiedRows;
  return (
    <>
      <ProjectStages agencyId={agencyId} projectId={IDS.project} current="decide" />
      <PageHead title="Links between records" lead="Confirm how records stay connected." />
      <PlanTasks ctx={ctx} current="relationships" states={confirmed ? { ...STATES, relationships: "done" } : STATES} />
      <section className="kauro-links" aria-labelledby="links-h">
        <h2 id="links-h">Contacts and their companies</h2>
        <div className="kauro-links-map" aria-hidden="true">
          <span className="kauro-links-node">
            Companies <strong>{n(PLAN.companies)}</strong>
          </span>
          <span className="kauro-links-edge">
            <span>{n(PLAN.links)} links</span>
          </span>
          <span className="kauro-links-node">
            Contacts <strong>{n(output)}</strong>
          </span>
        </div>
        <dl className="kauro-identity-counts">
          <div>
            <dt>Linked to their company</dt>
            <dd>{n(PLAN.links)}</dd>
            <dd>The company named in the Company column is in companies.xlsx</dd>
          </div>
          <div>
            <dt>Company not found</dt>
            <dd>{n(PLAN.notFound)}</dd>
            <dd>Listed below, with the closest company when there is one</dd>
          </div>
          <div>
            <dt>No company named</dt>
            <dd>{n(PLAN.noCompany - PLAN.notFound)}</dd>
            <dd>The Company column is empty</dd>
          </div>
        </dl>
        <p className="kauro-muted">
          {n(output)} contacts in all, after {n(PLAN.unifiedRows)} rows were unified: {n(PLAN.links)} linked, {n(PLAN.noCompany)} without a company.
        </p>
      </section>
      <section className="kauro-screen-section" aria-labelledby="notfound-h">
        <h2 id="notfound-h">Companies named but not found</h2>
        <div className="kauro-table-region">
          <table className="kauro-table">
            <caption className="kauro-visually-hidden">Company names in contacts.csv that are not in companies.xlsx</caption>
            <thead>
              <tr>
                <th scope="col">Name in contacts.csv</th>
                <th scope="col" className="kauro-table-end">
                  Contacts
                </th>
                <th scope="col">Closest company in companies.xlsx</th>
              </tr>
            </thead>
            <tbody>
              {NOT_FOUND.map((row) => (
                <tr key={row.name}>
                  <th scope="row">
                    <bdi>{row.name}</bdi>
                  </th>
                  <td className="kauro-table-end">{n(row.rows)}</td>
                  <td>{row.near === null ? <span className="kauro-muted-text">None close</span> : <bdi>{row.near}</bdi>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="kauro-muted">A close name is a hint, not a link: to link these contacts, correct the names in the file and upload it again. The plan never links them on a guess.</p>
      </section>
      <section className="kauro-screen-section" aria-labelledby="order-h">
        <h2 id="order-h">The order of the import</h2>
        <ol className="kauro-import-order">
          <li>
            <strong>Companies</strong> — {n(PLAN.companies - 253)} records, from companies.xlsx
          </li>
          <li>
            <strong>Contacts with their company</strong> — {n(output)} records; {n(PLAN.links)} carry their company
          </li>
        </ol>
      </section>
      {confirmed ? (
        <Banner tone="success" title="The links are confirmed" announce="status">
          <p>
            {n(PLAN.links)} links go into the plan. {n(PLAN.noCompany)} contacts are imported without a company, on purpose; the report lists each.
          </p>
        </Banner>
      ) : (
        <fieldset className="kauro-choice kauro-screen-choice">
          <legend>Contacts without a company ({n(PLAN.noCompany)})</legend>
          <label>
            <input type="radio" name="unlinked" defaultChecked />
            <span>
              <strong>Import them without a company</strong>
              <small>Each is listed in the report, with the name it carried.</small>
            </span>
          </label>
          <label>
            <input type="radio" name="unlinked" />
            <span>
              <strong>Leave them out of this delivery</strong>
              <small>They are not prepared; correct the file and add them in a later project.</small>
            </span>
          </label>
        </fieldset>
      )}
      <div className="kauro-actions">
        {confirmed ? (
          <ScreenButton to="UI22" ctx={ctx} variant="primary">
            <span className="kauro-go">Continue to approval</span>
          </ScreenButton>
        ) : (
          <Button variant="primary">Confirm the links</Button>
        )}
      </div>
    </>
  );
}
