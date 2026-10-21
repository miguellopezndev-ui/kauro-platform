"use client";
// UI12 Clients (registry: "Keep each end client's work separate."). Each end client is its own space: its projects, its files and the
// authority under which the agency processes its data (EndClientView.processingAuthorityRef, given when the client is added: CreateClient).
// A client is added with its name and that authority; archiving is offered only after its impact is shown, and it never deletes anything
// (registry exceptions). Two clients with similar names stay two clients: Kauro never merges them, and says so when a new name looks like
// one already there. A company buying for its own data has one client, itself.
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import Link from "next/link";
import { type FormEvent, type ReactElement, useState } from "react";
import { appPathOf, type PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { day, Monogram, PageHead } from "./kit.tsx";
import { AGENCY_PROJECTS } from "./projects-data.ts";

export const UI12_STATES: readonly StateDef[] = [
  { key: "normal", label: "Clients", note: "Each client with its projects and the authority the agency holds to process its data." },
  { key: "add", label: "Adding a client", note: "The client's name and the processing authority the agency holds for its data." },
  { key: "similar", label: "A similar name", note: "A new name close to an existing one: both stay separate clients, and the page says so before adding." },
  { key: "archive", label: "Archive: what it affects", note: "Before archiving: the open projects, what stays and what archiving does not do." },
];

interface Client {
  readonly name: string;
  readonly authority: string;
  readonly since: string;
  readonly state: "ACTIVE" | "ARCHIVED";
}
const CLIENTS: readonly Client[] = [
  { name: "Larch Studio", authority: "DPA-LARCH-2026-014", since: "2026-09-03T10:00:00Z", state: "ACTIVE" },
  { name: "Osprey Freight", authority: "DPA-OSPREY-2026-021", since: "2026-09-12T15:30:00Z", state: "ACTIVE" },
  { name: "Tidewell", authority: "DPA-TIDEWELL-2026-030", since: "2026-09-20T09:10:00Z", state: "ACTIVE" },
  { name: "Harbor Mill", authority: "DPA-HARBOR-2026-041", since: "2026-10-19T17:00:00Z", state: "ACTIVE" },
  { name: "Fenwick & Rowe", authority: "DPA-FENWICK-2026-002", since: "2026-06-01T12:00:00Z", state: "ARCHIVED" },
];

const counts = (name: string): { readonly open: number; readonly delivered: number } => {
  const mine = AGENCY_PROJECTS.filter((item) => item.clientLabel === name);
  return { open: mine.filter((item) => item.phase !== "DELIVERED").length, delivered: mine.filter((item) => item.phase === "DELIVERED").length };
};

export function Clients({ ctx, state }: PrototypeProps): ReactElement {
  const company = ctx.buyerType === "in-house";
  const name = ctx.agency?.displayName ?? "";
  const canManage = (ctx.agency?.permittedActions ?? []).includes("CREATE_CLIENTS");
  const [adding, setAdding] = useState(state === "add" || state === "similar");
  const [archiving, setArchiving] = useState<string | null>(state === "archive" ? "Osprey Freight" : null);
  const active = CLIENTS.filter((client) => client.state === "ACTIVE");
  const archived = CLIENTS.filter((client) => client.state === "ARCHIVED");

  if (company)
    return (
      <>
        <PageHead title="Clients" lead="Keep each end client's work separate." />
        <section className="kauro-clients-company" aria-labelledby="clients-company-h">
          <h2 id="clients-company-h">
            <bdi>{name}</bdi> prepares its own data
          </h2>
          <p>A company buying for itself has one client, itself: every project belongs to it. Agencies use this page to keep each client&apos;s work apart.</p>
          <Link className="kauro-button kauro-button-secondary" href={appPathOf("UI11", ctx)} prefetch={false}>
            Open your projects
          </Link>
        </section>
      </>
    );

  return (
    <>
      <PageHead
        title="Clients"
        lead="Keep each end client's work separate."
        aside={
          canManage && !adding ? (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <span className="kauro-go">Add a client</span>
            </Button>
          ) : undefined
        }
      />
      {adding ? <AddClient similar={state === "similar"} onCancel={() => setAdding(false)} /> : null}
      <ul className="kauro-clients" aria-label="Clients">
        {active.map((client) => {
          const projects = counts(client.name);
          return (
            <li key={client.name} className="kauro-client">
              <Monogram name={client.name} />
              <div className="kauro-client-main">
                <h2>
                  <bdi>{client.name}</bdi>
                </h2>
                <p className="kauro-client-facts">
                  <span>
                    {projects.open} open · {projects.delivered} delivered
                  </span>
                  <span>Since {day(client.since)}</span>
                </p>
                <p className="kauro-client-authority">
                  Processing authority <code>{client.authority}</code>
                </p>
              </div>
              <div className="kauro-client-actions">
                <Link className="kauro-button kauro-button-secondary" href={appPathOf("UI11", ctx)} prefetch={false}>
                  Open projects
                </Link>
                {canManage ? (
                  <button type="button" className="kauro-text-button" onClick={() => setArchiving(client.name)}>
                    Archive
                  </button>
                ) : null}
              </div>
              {archiving === client.name ? <ArchiveImpact name={client.name} open={projects.open} onCancel={() => setArchiving(null)} /> : null}
            </li>
          );
        })}
      </ul>
      {archived.length === 0 ? null : (
        <details className="kauro-clients-archived">
          <summary>Archived clients ({archived.length})</summary>
          <ul className="kauro-clients">
            {archived.map((client) => (
              <li key={client.name} className="kauro-client kauro-client--archived">
                <Monogram name={client.name} />
                <div className="kauro-client-main">
                  <h2>
                    <bdi>{client.name}</bdi>
                  </h2>
                  <p className="kauro-client-facts">
                    <span>Archived · its projects and files follow their own deletion dates</span>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
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
          hint="The reference of what lets you process this client's data for them, such as your data processing agreement with them. Kauro keeps the reference, not the document."
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
            <span className="kauro-go">{warned ? "Add as a separate client" : "Add the client"}</span>
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}

/** What archiving a client affects, said before it is offered. */
function ArchiveImpact({ name, open, onCancel }: { readonly name: string; readonly open: number; readonly onCancel: () => void }): ReactElement {
  return (
    <div className="kauro-client-impact" role="group" aria-label={`Archive ${name}`}>
      <h3>
        Archive <bdi>{name}</bdi>?
      </h3>
      <ul>
        <li>{open === 0 ? "No project is open." : `${open} open ${open === 1 ? "project stays" : "projects stay"} open and can be finished.`}</li>
        <li>No new project can be started for this client.</li>
        <li>Archiving does not delete anything: each project&apos;s files follow their own deletion dates.</li>
      </ul>
      <div className="kauro-actions">
        <Button variant="primary">Archive the client</Button>
        <Button onClick={onCancel}>Keep it</Button>
      </div>
    </div>
  );
}
