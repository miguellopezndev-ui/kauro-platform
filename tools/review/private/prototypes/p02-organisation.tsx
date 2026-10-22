"use client";
// P-02 Workspace settings (proposed complete design of UI32; Order 11 round 2, research app-shell-settings.md §9.10 B). The workspace's own
// scope, reached from Settings in the menu. Four pages, ordered by frequency and then by irreversibility, so the dangerous control is last:
// General · Responsibility and agreements · Data and retention · Security and activity log. Each states its scope under its heading:
// "These settings apply to everyone in Northwind Data."
//
// What exists: the name and logo (UpdateBranding and SubmitBrandingLogo, CMD008, owner or admin), who buys (GetBuyerType, set once in setup),
// the accepted agreement versions (AgencyView.termsVersion, privacyAgreementVersion), the workspace's state, closure (CMD043, owner,
// step-up). What does not: the responsible person read, the deletion records list, the activity log (each marked where it appears).
// Deliberately not here: Team and Billing keep their own menu entries (money and people have one home each); there is no Integrations or API
// keys page, because Kauro connects to nothing. A control a role cannot use is not drawn: one line says who can, by name.
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import { type FormEvent, type ReactElement, useState } from "react";
import { RETENTION_ROWS } from "@web/public/retention.ts";
import { COMPANY_ID } from "../lib/contexts.ts";
import { appPathOf, type PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { WORLD_PROJECTS } from "../lib/world-projects.ts";
import { mattersText } from "./board.ts";
import { Badge, day, Facts, ScreenLink } from "./kit.tsx";
import { can, onlyLine, teamOf, whoCan } from "./people.ts";
import { AGENCY_BOARD, COMPANY_BOARD } from "./projects-data.ts";
import { Needs, SettingsFrame, type SettingsPage } from "./settings-frame.tsx";

export const P02_STATES: readonly StateDef[] = [
  { key: "normal", label: "General", note: "The name, the type set at creation, the logo for delivered documents, the reference for support, the state, and closing the workspace last." },
  { key: "invalid", label: "General: name or logo not accepted", note: "The name is too long and the logo is not a PNG: each error beside its field and in a summary." },
  { key: "saved", label: "General: saved", note: "The new name and logo are saved; deliveries already made keep the branding they were made with." },
  { key: "close", label: "General: closing the workspace", note: "The owner reads what closing does, types the workspace's name and confirms identity. Nothing else on the page competes with it." },
  { key: "closing", label: "General: closure requested", note: "After the owner requested closure: the page says what happens next and offers nothing more." },
  { key: "agreements", label: "Responsibility and agreements", note: "Who is responsible, and each accepted agreement with its version, date and the person who accepted it." },
  { key: "retention", label: "Data and retention", note: "How long Kauro keeps files and packages, in the Data handling page's words, and this workspace's projects with their dates. Nothing to edit." },
  { key: "security", label: "Security and activity log", note: "The rules in force, then who did what and when. The log is for owners and admins; everyone else reads who can see it." },
];

const PAGES: readonly SettingsPage[] = [
  { key: "normal", label: "General" },
  { key: "agreements", label: "Responsibility and agreements" },
  { key: "retention", label: "Data and retention" },
  { key: "security", label: "Security and activity log" },
];

const GENERAL = new Set(["normal", "invalid", "saved", "close", "closing"]);
/** The review's fixed moment (no clock in a prototype): the afternoon of Oct 21, 2026. */
const REVIEW_NOW = "2026-10-21T14:00:00Z";

export function OrganisationSettings({ ctx, state }: PrototypeProps): ReactElement {
  const company = ctx.agency?.agencyId === COMPANY_ID;
  const name = ctx.agency?.displayName ?? (company ? "Halden Outdoor" : "Northwind Data");
  const page = GENERAL.has(state) ? "normal" : PAGES.some((one) => one.key === state) ? state : "normal";
  const title = PAGES.find((one) => one.key === page)?.label ?? "General";
  return (
    <SettingsFrame
      ctx={ctx}
      path={appPathOf("UI32", ctx)}
      proposal="P-02"
      context={
        <>
          Workspace settings · <bdi>{name}</bdi>
        </>
      }
      pages={PAGES}
      current={page}
      title={title}
      scope={
        <>
          These settings apply to everyone in <bdi>{name}</bdi>.
        </>
      }
    >
      {page === "normal" ? <General ctx={ctx} state={state} name={name} company={company} /> : null}
      {page === "agreements" ? <Agreements ctx={ctx} name={name} company={company} /> : null}
      {page === "retention" ? <Retention ctx={ctx} company={company} /> : null}
      {page === "security" ? <SecurityLog ctx={ctx} name={name} /> : null}
    </SettingsFrame>
  );
}

function General({ ctx, state, name, company }: Pick<PrototypeProps, "ctx" | "state"> & { readonly name: string; readonly company: boolean }): ReactElement {
  const branding = can(ctx, "settings");
  const owner = can(ctx, "close");
  const [saved, setSaved] = useState(state === "saved");
  const [closing, setClosing] = useState(state === "close");
  const [errors, setErrors] = useState<readonly { fieldId: string; message: string }[]>(
    state === "invalid"
      ? [
          { fieldId: "org-name", message: "Use 120 characters or fewer." },
          ...(company ? [] : [{ fieldId: "org-logo", message: "Choose a PNG file. Other formats are not accepted." }]),
        ]
      : [],
  );
  const errorOf = (id: string): string | undefined => errors.find((entry) => entry.fieldId === id)?.message;
  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    const found = text === "" ? [{ fieldId: "org-name", message: "Enter a name." }] : text.length > 120 ? [{ fieldId: "org-name", message: "Use 120 characters or fewer." }] : [];
    setErrors(found);
    setSaved(found.length === 0);
  };

  if (state === "closing")
    return (
      <Banner tone="info" title="Closure requested on Oct 21, 2026" announce="status">
        <p>Open quotes were withdrawn and no new project can start. Paid work in progress, refunds and reconciliation finish with Kauro; then the workspace&apos;s data is deleted on the schedule in Data and retention.</p>
      </Banner>
    );

  return (
    <>
      {saved ? (
        <Banner tone="success" title="Saved" announce="status">
          <p>New deliveries use the new name{company ? "" : " and logo"}. Deliveries already made keep the branding they were made with.</p>
        </Banner>
      ) : null}
      <section aria-labelledby="org-name-h">
        <h2 id="org-name-h">{company ? "Name" : "Name and logo"}</h2>
        {branding ? (
          <form className="kauro-a-form" noValidate onSubmit={save}>
            <ErrorSummary title="Check these details" errors={errors} />
            <Field id="org-name" label="Workspace name" hint="Shown to your team and on the documents Kauro delivers. Up to 120 characters." error={errorOf("org-name")}>
              {(control) => <input {...control} name="name" defaultValue={state === "invalid" ? `${name} — Revenue Operations, Data Preparation and CRM Migration Services for Mid-Market Clients` : name} />}
            </Field>
            {company ? null : (
              <>
                <div className="kauro-a-logo">
                  <span className="kauro-logo-preview" aria-hidden="true">
                    NW
                  </span>
                  <Field id="org-logo" label="Logo for delivered documents" hint="A PNG you have the rights to use. Kauro re-encodes it before it appears on a report." error={errorOf("org-logo")}>
                    {(control) => <input {...control} name="logo" type="file" accept="image/png" />}
                  </Field>
                </div>
                <label className="kauro-confirm">
                  <input type="checkbox" name="rights" defaultChecked />
                  <span>We have the rights to use this logo on the documents Kauro prepares for us.</span>
                </label>
              </>
            )}
            <div className="kauro-actions">
              <Button type="submit" variant="primary">
                Save
              </Button>
            </div>
          </form>
        ) : (
          <>
            <Facts rows={[["Workspace name", <bdi key="n">{name}</bdi>], ...(company ? [] : ([["Logo for delivered documents", "Northwind Data's logo (PNG)"]] as const))]} />
            <p className="kauro-a-only">{onlyLine(ctx, "settings", company ? "change the name" : "change the name and the logo")}</p>
          </>
        )}
      </section>

      <section aria-labelledby="org-about-h">
        <h2 id="org-about-h">This workspace</h2>
        <Facts
          rows={[
            ["Type", company ? "A company preparing its own CRM data" : "An agency preparing CRM data for its clients"],
            ["State", <Badge key="s" tone="success">Active</Badge>],
            ["Created", day(ctx.agency?.createdAt ?? "2026-09-02T14:20:00Z")],
            ["Reference for support", <code key="r">{ctx.agency?.agencyId ?? ""}</code>],
          ]}
        />
        <p className="kauro-muted">The type was set when the workspace was created. It does not change prices, discounts or what Kauro can prepare.</p>
      </section>

      {owner ? (
      <section aria-labelledby="org-close-h" className="kauro-a-danger">
        <h2 id="org-close-h">Close this workspace</h2>
        {closing ? (
          <CloseConfirm name={name} onCancel={() => setClosing(false)} />
        ) : (
          <>
            <p>Closing withdraws open quotes and stops new projects. Paid work, refunds and reconciliation finish first; then the data is deleted on schedule. It cannot be undone.</p>
            <div className="kauro-actions">
              <Button variant="danger" onClick={() => setClosing(true)}>
                Close this workspace
              </Button>
            </div>
          </>
        )}
      </section>
      ) : null}
    </>
  );
}

/** The one place a typed confirmation belongs (research app-shell-settings.md §11.3): closing is irreversible and ends everyone's access. */
function CloseConfirm({ name, onCancel }: { readonly name: string; readonly onCancel: () => void }): ReactElement {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <form
      className="kauro-a-form kauro-a-close"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setError(typed.trim() === name ? undefined : `Type ${name} exactly as it is written`);
      }}
    >
      <p>Closing {name}:</p>
      <ul>
        <li>withdraws every open quote and stops new projects at once;</li>
        <li>lets paid work, refunds and reconciliation finish with Kauro;</li>
        <li>ends every member&apos;s access, then deletes the workspace&apos;s data on the schedule in Data and retention;</li>
        <li>cannot be undone or requested again.</li>
      </ul>
      <Field id="close-name" label={`Type the workspace's name to confirm: ${name}`} error={error}>
        {(control) => <input {...control} name="confirm" autoComplete="off" spellCheck={false} value={typed} onChange={(event) => setTyped(event.target.value)} />}
      </Field>
      <p className="kauro-muted">Kauro then asks for your code to confirm it is you.</p>
      <div className="kauro-actions">
        <Button type="submit" variant="danger">
          Close {name}
        </Button>
        <Button onClick={onCancel}>Keep the workspace</Button>
      </div>
    </form>
  );
}

function Agreements({ ctx, name, company }: Pick<PrototypeProps, "ctx"> & { readonly name: string; readonly company: boolean }): ReactElement {
  const owner = teamOf(ctx).find((person) => person.role === "OWNER");
  const accepted = `Accepted by ${owner?.name ?? "the owner"} on ${day(ctx.agency?.createdAt ?? "2026-09-02T14:20:00Z")}`;
  return (
    <>
      <section aria-labelledby="org-resp-h">
        <h2 id="org-resp-h">Responsible person</h2>
        <Facts
          rows={[
            ["Responsible for the data shared with Kauro", owner === undefined ? "—" : `${owner.name} (Owner)`],
            ["Since", day(ctx.agency?.createdAt ?? "2026-09-02T14:20:00Z")],
          ]}
        />
        {can(ctx, "close") ? (
          <p className="kauro-muted">To name someone else, transfer ownership in Team, or open a support case.</p>
        ) : (
          <p className="kauro-a-only">{onlyLine(ctx, "close", "change the responsible person")}</p>
        )}
        <Needs>Needs a read: the responsible person is the owner who activated the workspace; no read names them yet</Needs>
      </section>
      <section aria-labelledby="org-docs-h">
        <h2 id="org-docs-h">Accepted agreements</h2>
        <table className="kauro-rtable">
          <caption className="kauro-visually-hidden">The agreements {name} accepted</caption>
          <thead>
            <tr>
              <th scope="col">Agreement</th>
              <th scope="col">Version</th>
              <th scope="col">Accepted</th>
              <th scope="col">
                <span className="kauro-visually-hidden">Read</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td data-label="">Service terms</td>
              <td data-label="Version">2026-10</td>
              <td data-label="Accepted">{accepted}</td>
              <td data-label="">
                <a href="/legal/terms">Read</a>
              </td>
            </tr>
            <tr>
              <td data-label="">Data processing terms</td>
              <td data-label="Version">2026-10</td>
              <td data-label="Accepted">{accepted}</td>
              <td data-label="">
                <a href="/legal/data-processing">Read</a>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="kauro-muted">When a new version is published, the owner accepts it here before the next quote. A change of legal name, address or tax details goes through support.</p>
      </section>
      {company ? null : (
        <section aria-labelledby="org-clients-h">
          <h2 id="org-clients-h">Your clients&apos; instructions</h2>
          <p>
            Each client&apos;s authorisation to share its files is confirmed when you add the client. See it in each client&apos;s details in <ScreenLink to="UI12" ctx={ctx}>Clients</ScreenLink>.
          </p>
        </section>
      )}
    </>
  );
}

const DATED = new Set(["FILES", "PACKAGE", "UPLOAD", "DELETED"]);

function Retention({ ctx, company }: Pick<PrototypeProps, "ctx"> & { readonly company: boolean }): ReactElement {
  const board = company ? COMPANY_BOARD : AGENCY_BOARD;
  const names = WORLD_PROJECTS[ctx.agency?.agencyId ?? ""] ?? [];
  const nameOf = (projectId: string, fallback: string): string => names.find((one) => one.projectId === projectId)?.name ?? fallback;
  const dated = board.filter((one) => one.matters !== null && DATED.has(one.matters.ending));
  const live = dated.filter((one) => one.matters !== null && Date.parse(one.matters.at) > Date.parse(REVIEW_NOW));
  const done = dated.filter((one) => one.matters !== null && Date.parse(one.matters.at) <= Date.parse(REVIEW_NOW));
  return (
    <>
      <section aria-labelledby="org-ret-h">
        <h2 id="org-ret-h">How long Kauro keeps your data</h2>
        <table className="kauro-rtable kauro-a-retention">
          <caption className="kauro-visually-hidden">The retention schedule, as the Data handling page states it</caption>
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">How long</th>
            </tr>
          </thead>
          <tbody>
            {RETENTION_ROWS.map((row) => (
              <tr key={row.subject}>
                <td data-label="">{row.subject}</td>
                <td data-label="How long">{row.rule}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="kauro-muted">
          One extension per project, of up to 72 hours, never past the latest date. {whoCan(ctx, "delete")} can ask for it, or delete a project&apos;s data early, from the project&apos;s Data and deletion.
        </p>
      </section>
      <section aria-labelledby="org-ret-projects-h">
        <h2 id="org-ret-projects-h">This workspace&apos;s projects</h2>
        {live.length === 0 ? (
          <p>No project holds files right now.</p>
        ) : (
          <table className="kauro-rtable">
            <caption className="kauro-visually-hidden">Projects and the date their data ends</caption>
            <thead>
              <tr>
                <th scope="col">Project</th>
                {company ? null : <th scope="col">Client</th>}
                <th scope="col">What ends, and when</th>
              </tr>
            </thead>
            <tbody>
              {live.map((one) => (
                <tr key={one.item.projectId}>
                  <td data-label="">
                    <ScreenLink to="UI29" ctx={ctx} project={one.item.projectId}>
                      <bdi>{nameOf(one.item.projectId, one.name)}</bdi>
                    </ScreenLink>
                  </td>
                  {company ? null : (
                    <td data-label="Client">
                      <bdi>{one.item.clientLabel}</bdi>
                    </td>
                  )}
                  <td data-label="Ends">{one.matters === null ? "—" : mattersText(one.matters)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-labelledby="org-ret-records-h">
        <h2 id="org-ret-records-h">Deletion records</h2>
        {done.length === 0 ? (
          <p>No deletion records yet.</p>
        ) : (
          <ul className="kauro-a-records">
            {done.map((one) => (
              <li key={one.item.projectId}>
                <bdi>{nameOf(one.item.projectId, one.name)}</bdi>
                {company ? null : (
                  <>
                    {" "}
                    · <bdi>{one.item.clientLabel}</bdi>
                  </>
                )}{" "}
                · files and package deleted on {one.matters === null ? "—" : day(one.matters.at)}
              </li>
            ))}
          </ul>
        )}
        <Needs>Needs a read: the deletion records of a workspace</Needs>
      </section>
    </>
  );
}

const LOG: readonly { readonly at: string; readonly who: string; readonly what: string; readonly from: string }[] = [
  { at: "Oct 21, 2026, 9:30 AM UTC", who: "Kauro", what: "Payment matched to the quote of Contacts and companies", from: "Kauro" },
  { at: "Oct 20, 2026, 12:40 PM UTC", who: "Samuel Osei (Approver)", what: "Approved revision 6 of the plan of Contacts and companies", from: "Chrome on macOS" },
  { at: "Oct 18, 2026, 11:20 AM UTC", who: "Lena Ortiz (Owner)", what: "Invited a.kowalski@northwind.example as Operator", from: "Chrome on Windows" },
  { at: "Oct 10, 2026, 3:05 PM UTC", who: "Lena Ortiz (Owner)", what: "Suspended Tom Lindqvist (Viewer)", from: "Chrome on Windows" },
  { at: "Oct 1, 2026, 8:45 AM UTC", who: "Lena Ortiz (Owner)", what: "Changed Ines Duarte's role: Viewer → Billing", from: "Chrome on Windows" },
];

const COMPANY_LOG: typeof LOG = [
  { at: "Oct 20, 2026, 12:40 PM UTC", who: "Tomas Reyes (Owner)", what: "Approved revision 6 of the plan of Customer records", from: "Safari on macOS" },
  { at: "Oct 5, 2026, 10:00 AM UTC", who: "Kauro", what: "Deleted the files and package of Dealer list, on schedule", from: "Kauro" },
  { at: "Sep 20, 2026, 10:05 AM UTC", who: "Tomas Reyes (Owner)", what: "Accepted the service terms and the data processing terms, version 2026-10", from: "Safari on macOS" },
];

function SecurityLog({ ctx, name }: Pick<PrototypeProps, "ctx"> & { readonly name: string }): ReactElement {
  const sees = can(ctx, "team");
  const log = ctx.agency?.agencyId === COMPANY_ID ? COMPANY_LOG : LOG;
  const [kind, setKind] = useState("all");
  return (
    <>
      <section aria-labelledby="org-rules-h">
        <h2 id="org-rules-h">Rules in force</h2>
        <Facts
          rows={[
            ["Two-step verification", "Required for every member. It cannot be turned off."],
            ["Sessions", "End after 30 minutes without activity, and 12 hours after signing in at the latest."],
            ["Sensitive actions", "Changing a role, transferring ownership, approving a plan, downloading a package, deleting data and closing ask the person to confirm it is them again, when they last did so more than 15 minutes ago."],
            ["Joining", "Only by an invitation to one email address, used once, for 7 days. An email domain never adds anyone."],
          ]}
        />
        <p className="kauro-muted">These rules are Kauro&apos;s and are the same in every workspace; nothing here is edited.</p>
      </section>
      <section aria-labelledby="org-log-h">
        <h2 id="org-log-h">Activity log</h2>
        {!sees ? (
          <p className="kauro-a-only">{onlyLine(ctx, "team", `see the activity log of ${name}`)}</p>
        ) : (
          <>
            <form className="kauro-a-filters" onSubmit={(event) => event.preventDefault()}>
              <label>
                <span>Person</span>
                <select name="who" defaultValue="all">
                  <option value="all">Everyone</option>
                  {teamOf(ctx).map((person) => (
                    <option key={person.email} value={person.email}>
                      {person.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Kind</span>
                <select name="kind" value={kind} onChange={(event) => setKind(event.target.value)}>
                  <option value="all">All kinds</option>
                  <option value="team">Members and roles</option>
                  <option value="project">Approvals and payments</option>
                  <option value="data">Agreements and deletions</option>
                </select>
              </label>
              <label>
                <span>From</span>
                <input type="date" name="from" defaultValue="2026-10-01" />
              </label>
            </form>
            <table className="kauro-rtable kauro-a-log">
              <caption className="kauro-visually-hidden">Who did what in {name}, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">What</th>
                  <th scope="col">From</th>
                </tr>
              </thead>
              <tbody>
                {log.map((row) => (
                  <tr key={row.at}>
                    <td data-label="When" className="kauro-a-when">
                      {row.at}
                    </td>
                    <td data-label="Who">{row.who}</td>
                    <td data-label="What">{row.what}</td>
                    <td data-label="From">{row.from}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="kauro-actions">
              <Button>Download as CSV</Button>
            </div>
            <Needs>Needs a read: the workspace&apos;s activity log (members, roles, agreements, approvals, payments, deletions)</Needs>
          </>
        )}
      </section>
    </>
  );
}
