"use client";
// UI11 Projects (registry: "Your client preparation projects."), rebuilt in Order 11 round 2 (research agency-workspace.md §5.1,
// app-shell-settings.md §9.2, §9.8, §9.13). The page answers "what needs me, what waits on someone else, what is Kauro doing, what is
// finished?" every day, so its groups are named for the person reading it, in that order:
//   - Needs you: the projects whose next step this person's role takes (an owner holds every role);
//   - Waiting on someone in your team: the next step is another role's, and the row names the person ("Samuel Osei (Approver)");
//   - Kauro is working: nothing is needed; we email when it is done;
//   - Completed.
// Each group is a table (NN/g: tables compare, cards make readers reorient): the project with its client and service, the stage in words
// ("4 of 6 · Quote and payment", no segmented bar: colour-only progress), the date that matters (one rule, labelled with what ends), and
// the next step as a verb link with who takes it. An empty group is not drawn; no zero counts. "Imported" never appears (a download is not
// an import, kauro-baseline.md §6.1 rule 12). The repeat-discount line left this work page: it lives in Billing and on a completed
// project's Overview (round 2 decision; research §5.1 "marketing on a work page").
//
// Starting a project is offered only to owners, admins and operators (CMD011); the other roles see no button. A new workspace opens on an
// empty state that depends on the role (app-shell-settings.md §9.13). "Only mine" is proposed (no saved views in the contract).
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { ServiceMode } from "@web/screens.ts";
import { appPathOf, type PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { EXAMPLE_ID } from "../lib/world.ts";
import { stageText, waitingOn } from "./board.ts";
import { moment, ScreenLink } from "./kit.tsx";
import { can } from "./people.ts";
import { AGENCY_BOARD, type BoardProject, COMPANY_BOARD, ENDING_LABEL } from "./projects-data.ts";
import { SERVICE, SERVICE_ORDER } from "./service.ts";

export const UI11_STATES: readonly StateDef[] = [
  { key: "normal", label: "Projects", note: "Grouped for the person reading: what needs you, what waits on someone else in your team (named), what Kauro is doing, what is completed. Each row: stage in words, the date that matters, the next step and who takes it." },
  { key: "new", label: "Starting a project", note: "The start of a project on the board: the client, the service and a purpose the team will recognise. Owners, admins and operators only." },
  { key: "first", label: "No projects yet", note: "A new workspace. Owners, admins and operators are offered their first project and the example; approvers, billing members and viewers read that projects will appear here." },
  { key: "restricted", label: "Restricted workspace", note: "New work is paused; support, refunds and deletion stay open. No project can be started." },
];

type Group = "yours" | "others" | "kauro" | "completed";
const GROUP_HEAD: Readonly<Record<Group, { readonly title: string; readonly note: string }>> = {
  yours: { title: "Needs you", note: "Each project waits for one step you can take." },
  others: { title: "Waiting on someone in your team", note: "The next step belongs to another role; each row names who takes it." },
  kauro: { title: "Kauro is working", note: "Nothing is needed from you. We email you when each is done, or if anything fails." },
  completed: { title: "Completed", note: "Delivered and finished. Their files follow their deletion dates." },
};
const ORDER: readonly Group[] = ["yours", "others", "kauro", "completed"];

function groupOf(project: BoardProject, ctx: PrototypeProps["ctx"]): Group {
  if (project.group === "kauro") return "kauro";
  if (project.group === "completed") return "completed";
  return project.next !== null && can(ctx, project.next.duty) ? "yours" : "others";
}

function Row({ project, group, ctx, company }: { readonly project: BoardProject; readonly group: Group; readonly ctx: PrototypeProps["ctx"]; readonly company: boolean }): ReactElement {
  const { item } = project;
  return (
    <tr>
      <td data-label="">
        <Link className="kauro-b-name" href={appPathOf("UI13", ctx, item.projectId)} prefetch={false}>
          <bdi>{project.name}</bdi>
        </Link>
        <span className="kauro-sub">
          {company ? null : (
            <>
              <bdi>{item.clientLabel}</bdi> ·{" "}
            </>
          )}
          {SERVICE[item.mode].name}
        </span>
      </td>
      <td data-label="Stage">{stageText(project.stage, item.mode)}</td>
      <td data-label="Date that matters">
        <span className="kauro-b-cell">
        {project.matters === null ? (
          <>
            <span className="kauro-b-when" aria-hidden="true">—</span>
            <span className="kauro-sub">{project.noDate ?? "No date yet"}</span>
          </>
        ) : (
          <>
            <span className="kauro-b-when-label">{ENDING_LABEL[project.matters.ending]}</span>
            <span className="kauro-b-when">{moment(project.matters.at)}</span>
          </>
        )}
        </span>
      </td>
      <td data-label="Next step">
        <span className="kauro-b-cell">
        {group === "yours" && project.next !== null ? (
          <Link className="kauro-b-verb" href={appPathOf(project.next.screen, ctx, item.projectId)} prefetch={false}>
            <span className="kauro-go">{project.next.label}</span>
          </Link>
        ) : group === "others" && project.next !== null ? (
          <>
            <span>{project.next.label}</span>
            <span className="kauro-sub">Waiting on {waitingOn(ctx, project.next.duty)}</span>
          </>
        ) : project.kauro !== null ? (
          <>
            <span>{project.kauro.label}</span>
            <span className="kauro-sub">
              <ScreenLink to={project.kauro.screen} ctx={ctx} project={item.projectId}>
                See where it is
              </ScreenLink>
            </span>
          </>
        ) : (
          <ScreenLink to="UI13" ctx={ctx} project={item.projectId}>
            Open the project
          </ScreenLink>
        )}
        </span>
      </td>
    </tr>
  );
}

export function Projects({ ctx, state }: PrototypeProps): ReactElement {
  const company = ctx.buyerType === "in-house";
  const params = useSearchParams();
  const all = state === "first" ? [] : company ? COMPANY_BOARD : AGENCY_BOARD;
  const clients = [...new Set(all.map((one) => one.item.clientLabel))];
  const asked = params.get("client") ?? "";
  const [client, setClient] = useState<string>(clients.includes(asked) ? asked : "");
  const [service, setService] = useState<ServiceMode | "">("");
  const [mine, setMine] = useState(false);
  const canStart = can(ctx, "operate") && state !== "restricted";
  const [starting, setStarting] = useState(state === "new" && can(ctx, "operate"));
  const filtered = all
    .map((project) => ({ project, group: groupOf(project, ctx) }))
    .filter(({ project, group }) => (client === "" || project.item.clientLabel === client) && (service === "" || project.item.mode === service) && (!mine || group === "yours"));
  const filtering = client !== "" || service !== "" || mine;
  const clear = (): void => {
    setClient("");
    setService("");
    setMine(false);
  };

  return (
    <>
      <ProjectHeader
        stage="files"
        title="Projects"
        lead={company ? "Your preparation projects." : "Your client preparation projects."}
        action={
          canStart && !starting && all.length > 0 ? (
            <Button variant="primary" onClick={() => setStarting(true)}>
              Start a project
            </Button>
          ) : undefined
        }
      />
      {state === "restricted" ? (
        <Banner tone="warning" title="New work is paused for this workspace" announce="status">
          <p>
            Kauro restricted this workspace, so no new project, check or payment can start. Support, refunds and data deletion stay open. <ScreenLink to="UI52" ctx={ctx}>Open a support case</ScreenLink>
          </p>
        </Banner>
      ) : null}
      {starting ? <StartProject ctx={ctx} clients={company ? [] : clients} onCancel={() => setStarting(false)} /> : null}
      {all.length === 0 ? (
        <FirstVisit ctx={ctx} canStart={canStart} starting={starting} onStart={() => setStarting(true)} />
      ) : (
        <>
          <div className="kauro-b-filters" role="group" aria-label="Filter the projects">
            {company || clients.length < 2 ? null : (
              <label className="kauro-b-filter">
                <span>Client</span>
                <select value={client} onChange={(event) => setClient(event.target.value)}>
                  <option value="">All clients</option>
                  {clients.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="kauro-b-filter">
              <span>Service</span>
              <select value={service} onChange={(event) => setService(event.target.value as ServiceMode | "")}>
                <option value="">All services</option>
                {SERVICE_ORDER.map((mode) => (
                  <option key={mode} value={mode}>
                    {SERVICE[mode].name}
                  </option>
                ))}
              </select>
            </label>
            <label className="kauro-b-check">
              <input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} />
              <span>Only mine</span>
              <span className="kauro-proposed kauro-b-proposed">Proposed</span>
            </label>
            {filtering ? (
              <button type="button" className="kauro-text-button kauro-b-clear" onClick={clear}>
                Clear the filters
              </button>
            ) : null}
          </div>
          {filtered.length === 0 ? (
            <section className="kauro-empty" aria-labelledby="board-none-h">
              <h2 id="board-none-h">No project matches these filters</h2>
              <p>{mine ? "Nothing waits on you right now." : "Change or clear the filters to see the other projects."}</p>
            </section>
          ) : (
            ORDER.map((group) => {
              const rows = filtered.filter((one) => one.group === group);
              if (rows.length === 0) return null;
              return (
                <section key={group} className="kauro-b-group" aria-labelledby={`board-${group}`}>
                  <h2 id={`board-${group}`}>
                    {GROUP_HEAD[group].title} <span className="kauro-b-count">{rows.length}</span>
                  </h2>
                  <p className="kauro-b-note">{GROUP_HEAD[group].note}</p>
                  <table className="kauro-rtable kauro-b-table">
                    <caption className="kauro-visually-hidden">{GROUP_HEAD[group].title}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Project</th>
                        <th scope="col">Stage</th>
                        <th scope="col">Date that matters</th>
                        <th scope="col">Next step</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(({ project }) => (
                        <Row key={project.item.projectId} project={project} group={group} ctx={ctx} company={company} />
                      ))}
                    </tbody>
                  </table>
                </section>
              );
            })
          )}
        </>
      )}
    </>
  );
}

/** A workspace with no project: the empty state for the role (app-shell-settings.md §9.13): a heading, one sentence, at most one action. */
function FirstVisit({ ctx, canStart, starting, onStart }: { readonly ctx: PrototypeProps["ctx"]; readonly canStart: boolean; readonly starting: boolean; readonly onStart: () => void }): ReactElement {
  if (!can(ctx, "operate"))
    return (
      <section className="kauro-empty" aria-labelledby="board-first-h">
        <h2 id="board-first-h">No projects yet</h2>
        <p>When someone starts a project, it appears here. You will be asked when a step needs you.</p>
      </section>
    );
  return (
    <section className="kauro-empty" aria-labelledby="board-first-h">
      <h2 id="board-first-h">Start your first project</h2>
      <p>Upload your exported files. Kauro runs a free data health check on everything you seal; you pay only after approving a plan and its quote.</p>
      {canStart && !starting ? (
        <Button variant="primary" onClick={onStart}>
          Start a project
        </Button>
      ) : null}
      <p className="kauro-b-example">
        Not ready yet?{" "}
        <Link href={`/agencies/${EXAMPLE_ID}/projects/${AGENCY_BOARD[0]?.item.projectId ?? ""}`} prefetch={false}>
          Explore the example project
        </Link>{" "}
        (synthetic data, every stage from the files to the import).
      </p>
    </section>
  );
}

const SERVICES = (["HUBSPOT", "SALESFORCE", "CLEAN"] as const).map((mode) => ({ mode, name: SERVICE[mode].name, body: SERVICE[mode].line }));

/** The start of a project (CreateProject: the service and a purpose; an agency names the client first). The destination is set later. */
function StartProject({ ctx, clients, onCancel }: { readonly ctx: PrototypeProps["ctx"]; readonly clients: readonly string[]; readonly onCancel: () => void }): ReactElement {
  const router = useRouter();
  const [mode, setMode] = useState<"HUBSPOT" | "SALESFORCE" | "CLEAN">("HUBSPOT");
  const [errors, setErrors] = useState<readonly { fieldId: string; message: string }[]>([]);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const found: { fieldId: string; message: string }[] = [];
    if (clients.length > 0 && String(data.get("client") ?? "") === "") found.push({ fieldId: "start-client", message: "Choose the client this project is for" });
    if (String(data.get("purpose") ?? "").trim() === "") found.push({ fieldId: "start-purpose", message: "Enter what this project is for" });
    if (mode !== "CLEAN" && String(data.get("instance") ?? "").trim() === "") found.push({ fieldId: "start-instance", message: mode === "SALESFORCE" ? "Enter your Salesforce organization ID" : "Enter your HubSpot account ID" });
    setErrors(found);
    if (found.length === 0) router.push(appPathOf("UI14", ctx));
  };
  return (
    <section className="kauro-board-start" aria-labelledby="board-start-h">
      <form className="kauro-form" noValidate onSubmit={submit}>
        <h2 id="board-start-h">Start a project</h2>
        <ErrorSummary title="There is a problem" errors={errors} />
        {clients.length === 0 ? null : (
          <Field id="start-client" label="Client" hint="Each client keeps its own projects and files." error={errors.find((entry) => entry.fieldId === "start-client")?.message}>
            {(control) => (
              <select {...control} name="client" defaultValue="">
                <option value="">Choose a client</option>
                {clients.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <fieldset className="kauro-choice kauro-choice--row">
          <legend>Service</legend>
          {SERVICES.map((one) => (
            <label key={one.mode}>
              <input type="radio" name="mode" value={one.mode} checked={mode === one.mode} onChange={() => setMode(one.mode)} />
              <span>
                <strong>{one.name}</strong>
                <small>{one.body}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {mode === "CLEAN" ? null : (
          <Field
            id="start-instance"
            label={mode === "SALESFORCE" ? "Salesforce organization ID" : "HubSpot account ID"}
            hint={mode === "SALESFORCE" ? "In Salesforce Setup, under Company Information. Kauro uses it only to name the destination; it never connects to it." : "In HubSpot, in your account menu. Kauro uses it only to name the destination; it never connects to it."}
            error={errors.find((entry) => entry.fieldId === "start-instance")?.message}
          >
            {(control) => <input {...control} name="instance" spellCheck={false} autoComplete="off" />}
          </Field>
        )}
        <Field id="start-purpose" label="What this project is for" hint="A few words your team will recognise, such as: spring clean-up before the move." error={errors.find((entry) => entry.fieldId === "start-purpose")?.message}>
          {(control) => <input {...control} name="purpose" maxLength={200} />}
        </Field>
        <p className="kauro-muted">{mode === "CLEAN" ? "No destination is needed. Nothing is charged to start a project." : "The destination's settings are confirmed later, before the free check. Nothing is charged to start a project."}</p>
        <div className="kauro-actions">
          <Button type="submit" variant="primary">
            Create the project
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
        {clients.length === 0 ? null : (
          <p className="kauro-muted">
            A new client? <ScreenLink to="UI12" ctx={ctx}>Add it first</ScreenLink>.
          </p>
        )}
      </form>
    </section>
  );
}
