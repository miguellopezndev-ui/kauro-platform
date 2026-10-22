"use client";
// UI12 Clients (registry: "Keep each end client's work separate."), rebuilt in Order 11 round 2 (research agency-workspace.md §5.2,
// app-shell-settings.md §9.13). Agencies only: a company buying for its own data has no clients, and the page says so if reached.
//
// The list is a table, not cards (NN/g: tables compare, cards make readers reorient): per client, its open projects, the earliest next step,
// the money waiting (a quote and a payment order named in words, never summed), the earliest date that ends something, and what was
// delivered in the last 12 months. The open-projects figure opens Projects filtered to that client; the name opens the client's details,
// where the processing authority (mono) and archiving live. Archiving shows its impact first and never deletes anything; only owners and
// admins archive (CMD010), while owners, admins and operators add clients (CMD009). Two clients with similar names stay two clients.
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import Link from "next/link";
import { type FormEvent, type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import { appPathOf, type PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { waitingOn } from "./board.ts";
import { day, Only } from "./kit.tsx";
import { can, onlyLine } from "./people.ts";
import { AGENCY_BOARD, AGENCY_MONEY, type BoardProject, ENDING_LABEL, usd } from "./projects-data.ts";

export const UI12_STATES: readonly StateDef[] = [
  { key: "normal", label: "Clients", note: "One row a client: open projects, the earliest next step, the money waiting, the earliest date, what was delivered in 12 months." },
  { key: "add", label: "Adding a client", note: "The client's name and the processing authority the agency holds for its data. Owners, admins and operators." },
  { key: "similar", label: "A similar name", note: "A new name close to an existing one: both stay separate clients, and the page says so before adding." },
  { key: "detail", label: "A client's details", note: "The client's authority, since when, its projects, and archiving with its impact first." },
  { key: "archive", label: "Archive: what it affects", note: "Before archiving: the open projects, what stays, and what archiving does not do. Owners and admins only." },
  { key: "archived", label: "Archived clients", note: "The archived tab: the clients no new project can start for." },
  { key: "first", label: "No clients yet", note: "A new agency: one heading, one sentence, one action." },
];

interface Client {
  readonly name: string;
  readonly authority: string;
  readonly since: string;
  readonly archivedOn?: string;
}
const CLIENTS: readonly Client[] = [
  { name: "Larch Studio", authority: "DPA-LARCH-2026-014", since: "2026-09-03T10:00:00Z" },
  { name: "Osprey Freight", authority: "DPA-OSPREY-2026-021", since: "2026-09-12T15:30:00Z" },
  { name: "Tidewell", authority: "DPA-TIDEWELL-2026-030", since: "2026-09-20T09:10:00Z" },
  { name: "Harbor Mill", authority: "DPA-HARBOR-2026-041", since: "2026-10-19T17:00:00Z" },
  { name: "Fenwick & Rowe", authority: "DPA-FENWICK-2026-002", since: "2026-06-01T12:00:00Z", archivedOn: "2026-09-30T12:00:00Z" },
];

interface Summary {
  readonly open: readonly BoardProject[];
  readonly delivered: number;
  readonly next: BoardProject | null;
  /** The first quote or payment order waiting, named in words: never summed with another kind. */
  readonly money: { readonly cents: number; readonly kind: string } | null;
  readonly earliest: BoardProject | null;
}

const at = (project: BoardProject): number => (project.matters === null || project.matters.ending === "RESULTS" ? Number.POSITIVE_INFINITY : Date.parse(project.matters.at));

function summaryOf(name: string): Summary {
  const mine = AGENCY_BOARD.filter((project) => project.item.clientLabel === name);
  const open = mine.filter((project) => project.group !== "completed");
  const byDate = [...open].sort((a, b) => at(a) - at(b));
  const next = byDate.find((project) => project.next !== null) ?? null;
  const earliest = byDate.find((project) => at(project) !== Number.POSITIVE_INFINITY) ?? null;
  const ids = new Set(open.map((project) => project.item.projectId));
  const waiting = AGENCY_MONEY.filter((line) => ids.has(line.projectId) && (line.kind === "WAITING" || line.kind === "QUOTE"));
  const line = waiting[0];
  const money = line === undefined ? null : { cents: line.cents, kind: line.kind === "WAITING" ? "Payment order, waiting for the transfer" : "Quote to accept" };
  return { open, delivered: mine.filter((project) => project.stage === 5).length, next, money, earliest };
}

export function Clients({ ctx, state }: PrototypeProps): ReactElement {
  const company = ctx.buyerType === "in-house";
  const canAdd = (ctx.agency?.permittedActions ?? []).includes("CREATE_CLIENTS");
  const canArchive = (ctx.agency?.permittedActions ?? []).includes("MANAGE_CLIENTS");
  const [adding, setAdding] = useState((state === "add" || state === "similar") && canAdd);
  const [open, setOpen] = useState<string | null>(state === "detail" ? "Larch Studio" : state === "archive" ? "Osprey Freight" : null);
  const [tab, setTab] = useState<"active" | "archived">(state === "archived" ? "archived" : "active");
  const clients = state === "first" ? [] : CLIENTS;
  const active = clients.filter((client) => client.archivedOn === undefined);
  const archived = clients.filter((client) => client.archivedOn !== undefined);

  if (company)
    return (
      <>
        <ProjectHeader stage="files" title="Clients" />
        <section className="kauro-empty" aria-labelledby="clients-company-h">
          <h2 id="clients-company-h">Clients are for agencies</h2>
          <p>
            <bdi>{ctx.agency?.displayName ?? ""}</bdi> prepares its own data, so every project belongs to it. An agency uses this page to keep each client&apos;s work apart.
          </p>
          <Link href={appPathOf("UI11", ctx)} prefetch={false}>
            Open your projects
          </Link>
        </section>
      </>
    );

  const detail = open === null ? undefined : clients.find((client) => client.name === open);
  if (detail !== undefined) return <ClientDetail ctx={ctx} client={detail} canArchive={canArchive} archiving={state === "archive"} onBack={() => setOpen(null)} />;

  return (
    <>
      <ProjectHeader
        stage="files"
        title="Clients"
        lead="Keep each end client's work separate."
        action={
          canAdd && !adding && clients.length > 0 ? (
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add a client
            </Button>
          ) : undefined
        }
      />
      {adding ? <AddClient similar={state === "similar"} onCancel={() => setAdding(false)} /> : null}
      {clients.length === 0 ? (
        <section className="kauro-empty" aria-labelledby="clients-first-h">
          <h2 id="clients-first-h">Add your first client</h2>
          <p>Each project belongs to a client. Kauro never contacts your clients.</p>
          {canAdd && !adding ? (
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add a client
            </Button>
          ) : null}
          {canAdd ? null : <Only>{onlyLine(ctx, "operate", "add clients")}</Only>}
        </section>
      ) : (
        <>
          <div className="kauro-b-switch" role="group" aria-label="Which clients">
            <button type="button" aria-pressed={tab === "active"} onClick={() => setTab("active")}>
              Active ({active.length})
            </button>
            {archived.length === 0 ? null : (
              <button type="button" aria-pressed={tab === "archived"} onClick={() => setTab("archived")}>
                Archived ({archived.length})
              </button>
            )}
          </div>
          <div>
            {tab === "active" ? (
              <table className="kauro-rtable kauro-b-clients kauro-b-clients--active">
                <caption className="kauro-visually-hidden">Active clients, with their open work and what waits</caption>
                <thead>
                  <tr>
                    <th scope="col">Client</th>
                    <th scope="col" className="kauro-num">
                      Open projects
                    </th>
                    <th scope="col">Next step</th>
                    <th scope="col">Money waiting</th>
                    <th scope="col">Earliest date</th>
                    <th scope="col" className="kauro-num">
                      Delivered
                      <span className="kauro-b-thsub">last 12 months</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((client) => {
                    const sum = summaryOf(client.name);
                    return (
                      <tr key={client.name}>
                        <td data-label="">
                          <button type="button" className="kauro-text-button kauro-b-name" onClick={() => setOpen(client.name)}>
                            <bdi>{client.name}</bdi>
                          </button>
                          <span className="kauro-sub">Since {day(client.since)}</span>
                        </td>
                        <td data-label="Open projects" className="kauro-num">
                          {sum.open.length === 0 ? (
                            "None"
                          ) : (
                            <Link href={`${appPathOf("UI11", ctx)}?client=${encodeURIComponent(client.name)}`} prefetch={false} aria-label={`${sum.open.length} open projects of ${client.name}`}>
                              {sum.open.length}
                            </Link>
                          )}
                        </td>
                        <td data-label="Next step">
                          <span className="kauro-b-cell">
                            {sum.next === null || sum.next.next === null ? (
                              "Nothing waits on your team"
                            ) : can(ctx, sum.next.next.duty) ? (
                              <Link className="kauro-b-verb" href={appPathOf(sum.next.next.screen, ctx, sum.next.item.projectId)} prefetch={false}>
                                {sum.next.next.label}
                              </Link>
                            ) : (
                              <>
                                {sum.next.next.label}
                                <span className="kauro-sub">Waiting on {waitingOn(ctx, sum.next.next.duty)}</span>
                              </>
                            )}
                          </span>
                        </td>
                        <td data-label="Money waiting">
                          <span className="kauro-b-cell">
                            {sum.money === null ? (
                              "None"
                            ) : (
                              <>
                                <span className="kauro-b-when">{usd(sum.money.cents)}</span>
                                <span className="kauro-sub">{sum.money.kind}</span>
                              </>
                            )}
                          </span>
                        </td>
                        <td data-label="Earliest date">
                          <span className="kauro-b-cell">
                            {sum.earliest === null || sum.earliest.matters === null ? (
                              "—"
                            ) : (
                              <>
                                <span className="kauro-b-when">{day(sum.earliest.matters.at)}</span>
                                <span className="kauro-sub">{ENDING_LABEL[sum.earliest.matters.ending].replace(/ on$/, "")}</span>
                              </>
                            )}
                          </span>
                        </td>
                        <td data-label="Delivered, 12 months" className="kauro-num">
                          {sum.delivered === 0 ? "None" : sum.delivered}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <table className="kauro-rtable kauro-b-clients">
                <caption className="kauro-visually-hidden">Archived clients</caption>
                <thead>
                  <tr>
                    <th scope="col">Client</th>
                    <th scope="col">Archived on</th>
                    <th scope="col">What it means</th>
                  </tr>
                </thead>
                <tbody>
                  {archived.map((client) => (
                    <tr key={client.name}>
                      <td data-label="">
                        <bdi>{client.name}</bdi>
                        <span className="kauro-sub">Since {day(client.since)}</span>
                      </td>
                      <td data-label="Archived on">{day(client.archivedOn ?? client.since)}</td>
                      <td data-label="What it means">No new project can start; its projects&apos; files follow their own deletion dates.</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {canAdd ? null : <Only>{onlyLine(ctx, "operate", "add clients")}</Only>}
        </>
      )}
    </>
  );
}

/** One client: what Kauro holds about it, its projects, and archiving, whose impact is said before the button. */
function ClientDetail({ ctx, client, canArchive, archiving, onBack }: { readonly ctx: PrototypeProps["ctx"]; readonly client: Client; readonly canArchive: boolean; readonly archiving: boolean; readonly onBack: () => void }): ReactElement {
  const sum = summaryOf(client.name);
  const [asking, setAsking] = useState(archiving && canArchive);
  return (
    <>
      <p className="kauro-b-back">
        <button type="button" className="kauro-text-button" onClick={onBack}>
          ‹ All clients
        </button>
      </p>
      <ProjectHeader stage="files" title={client.name} lead="A client of your agency. Kauro never contacts it." />
      <section className="kauro-b-section" aria-labelledby="client-facts-h">
        <h2 id="client-facts-h">About this client</h2>
        <dl className="kauro-b-facts">
          <div>
            <dt>Processing authority</dt>
            <dd>
              <code>{client.authority}</code>
              <span className="kauro-sub">The reference of what lets your agency process this client&apos;s data. Kauro keeps the reference, not the document.</span>
            </dd>
          </div>
          <div>
            <dt>Client since</dt>
            <dd>{day(client.since)}</dd>
          </div>
          <div>
            <dt>Open projects</dt>
            <dd>
              {sum.open.length === 0 ? (
                "None"
              ) : (
                <Link href={`${appPathOf("UI11", ctx)}?client=${encodeURIComponent(client.name)}`} prefetch={false}>
                  {sum.open.map((project) => project.name).join(", ")}
                </Link>
              )}
            </dd>
          </div>
          <div>
            <dt>Delivered, 12 months</dt>
            <dd>{sum.delivered === 0 ? "None" : `${sum.delivered} ${sum.delivered === 1 ? "project" : "projects"}`}</dd>
          </div>
        </dl>
      </section>
      <section className="kauro-b-section" aria-labelledby="client-archive-h">
        <h2 id="client-archive-h">Archive this client</h2>
        <ul className="kauro-b-impact">
          <li>{sum.open.length === 0 ? "No project is open." : `${sum.open.length} open ${sum.open.length === 1 ? "project stays" : "projects stay"} open and can be finished: ${sum.open.map((project) => project.name).join(", ")}.`}</li>
          <li>No new project can be started for this client.</li>
          <li>Nothing is deleted: each project&apos;s files follow their own deletion dates. A client is never deleted.</li>
        </ul>
        {!canArchive ? (
          <Only>{onlyLine(ctx, "delete", "archive a client")}</Only>
        ) : asking ? (
          <div className="kauro-b-confirm" role="group" aria-labelledby="client-archive-confirm">
            <p id="client-archive-confirm">
              Archive <bdi>{client.name}</bdi>? You can still open its projects; new ones cannot start.
            </p>
            <div className="kauro-actions">
              <Button variant="secondary">Archive {client.name}</Button>
              <Button onClick={() => setAsking(false)}>Keep it active</Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" onClick={() => setAsking(true)}>
            Archive this client
          </Button>
        )}
      </section>
    </>
  );
}

/** Adding a client (CreateClient): its name, and the authority the agency holds to process its data. */
function AddClient({ similar, onCancel }: { readonly similar: boolean; readonly onCancel: () => void }): ReactElement {
  const [errors, setErrors] = useState<readonly { fieldId: string; message: string }[]>([]);
  const [warned, setWarned] = useState(similar);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const found: { fieldId: string; message: string }[] = [];
    if (String(data.get("name") ?? "").trim() === "") found.push({ fieldId: "client-name", message: "Enter the client's name." });
    if (String(data.get("authority") ?? "").trim() === "") found.push({ fieldId: "client-authority", message: "Enter the reference of the authority you hold for this client's data." });
    setErrors(found);
    if (found.length === 0 && /larch/i.test(String(data.get("name")))) setWarned(true);
  };
  return (
    <section className="kauro-board-start" aria-labelledby="client-add-h">
      <form className="kauro-form" noValidate onSubmit={submit}>
        <h2 id="client-add-h">Add a client</h2>
        <ErrorSummary title="Check these details" errors={errors} />
        <Field id="client-name" label="Client name" hint="As your team calls it. You can change it later." error={errors.find((entry) => entry.fieldId === "client-name")?.message}>
          {(control) => <input {...control} name="name" maxLength={120} defaultValue={similar ? "Larch Studio Ltd" : ""} />}
        </Field>
        <Field
          id="client-authority"
          label="Processing authority"
          hint="The reference of what lets you process this client's data, such as your data processing agreement with them. Kauro keeps the reference, not the document."
          error={errors.find((entry) => entry.fieldId === "client-authority")?.message}
        >
          {(control) => <input {...control} name="authority" maxLength={120} defaultValue={similar ? "DPA-LARCH-2026-052" : ""} spellCheck={false} />}
        </Field>
        {warned ? (
          <Banner tone="info" title="A client with a similar name exists" announce="status">
            <p>
              <bdi>Larch Studio Ltd</bdi> looks like <bdi>Larch Studio</bdi>. If you add it, they stay two separate clients, with their own projects and files: Kauro never merges clients. If it is the same client, open its projects instead.
            </p>
          </Banner>
        ) : null}
        <div className="kauro-actions">
          <Button type="submit" variant="primary">
            {warned ? "Add as a separate client" : "Add the client"}
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}
