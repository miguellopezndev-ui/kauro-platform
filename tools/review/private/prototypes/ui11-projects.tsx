"use client";
// UI11 Projects (registry: "Your client preparation projects."): the board every member opens first. Drawn from the api's own board read
// (ListProjects → ProjectDashboardItem: client, service, phase, the team's required action, deadline, last activity), grouped by who must
// act, in a fixed order (research: app-ui-patterns.md 1, Linear's My Issues): what needs your team, what Kauro is doing, what waits on
// someone else in your team, what was delivered. Each project is one row with its one next verb; an empty group is not drawn.
//
// A person sees an action as theirs only when their role allows it (B06): an operator does not approve or pay, so a plan to approve or a
// quote to pay waits on someone else in their team. A new workspace never opens on an empty page: it offers its first project beside the
// synthetic example, labelled as one (registry: "Empty state uses synthetic examples"). A restricted agency keeps its support, refund and
// deletion routes (registry exceptions).
//
// PROPOSED (D-UI11-1): the repeat-discount line. The policy's ladder is public (Pricing), but no read tells a workspace how many paid
// projects it has; shown as reachable progress, never as the far tier (research: onboarding-vs-discounts.md 6).
import type { ProjectDashboardItem } from "@web/api/generated.ts";
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactElement, useState } from "react";
import { appPathOf, type PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { EXAMPLE_ID } from "../lib/world.ts";
import { day, PageHead, ScreenButton, ScreenLink } from "./kit.tsx";
import { AGENCY_PROJECTS, COMPANY_PROJECTS, PAID_PROJECTS } from "./projects-data.ts";

export const UI11_STATES: readonly StateDef[] = [
  { key: "normal", label: "Projects", note: "Every project grouped by who must act; each row says its one next step. Seen as an operator, approving and paying wait on others." },
  { key: "new", label: "Starting a project", note: "The start of a project, on the board itself: the client, the service and a purpose the team will recognise. The destination comes later." },
  { key: "first", label: "First visit", note: "A workspace with no project yet: its first project offered beside the synthetic example." },
  { key: "restricted", label: "Restricted agency", note: "New work is paused; support, refunds and deletion stay open." },
];

type Group = "yours" | "kauro" | "others" | "delivered" | "stopped";
const GROUPS: readonly { readonly key: Group; readonly title: string; readonly note: string }[] = [
  { key: "yours", title: "Needs your team", note: "Each waits for one step from you." },
  { key: "kauro", title: "Kauro is working", note: "Nothing to do until Kauro is done." },
  { key: "others", title: "Waiting on someone else in your team", note: "A step your role does not take: an approver or the billing person takes it." },
  { key: "delivered", title: "Delivered", note: "Ready to import, or imported." },
  { key: "stopped", title: "Stopped", note: "Something ended the project's run: open it to see why and what is safe." },
];

const STAGE_OF: Readonly<Record<ProjectDashboardItem["phase"], number>> = { SOURCES: 0, HEALTH_CHECK: 1, PLAN: 2, PURCHASE: 3, PROCESSING: 4, DELIVERED: 5, FAILED: -1, ARCHIVED: -1 };
const STAGE_NAME = ["Upload and seal", "Free data health check", "Review and approve the plan", "Quote and payment", "Preparation and verification", "Delivery and import"] as const;
const MODE: Readonly<Record<ProjectDashboardItem["mode"], string>> = { CLEAN: "CLEAN", HUBSPOT: "HubSpot", SALESFORCE: "Salesforce" };

const ACTION: Readonly<Record<Exclude<ProjectDashboardItem["requiredAction"], "NONE">, { readonly label: string; readonly screen: string; readonly needs?: "APPROVE_PLANS" | "MANAGE_BILLING" }>> = {
  UPLOAD_SOURCES: { label: "Upload the files", screen: "UI14" },
  START_HEALTH_CHECK: { label: "Start the free check", screen: "UI17" },
  VALIDATE_PLAN: { label: "Check the plan", screen: "UI19" },
  APPROVE_PLAN: { label: "Approve the plan", screen: "UI22", needs: "APPROVE_PLANS" },
  REQUEST_QUOTE: { label: "Ask for the quote", screen: "UI23" },
  PAY_QUOTE: { label: "Pay the quote", screen: "UI23", needs: "MANAGE_BILLING" },
  START_PROCESSING: { label: "Start the preparation", screen: "UI25" },
};
const WAITING: Readonly<Record<"APPROVE_PLANS" | "MANAGE_BILLING", string>> = { APPROVE_PLANS: "Waiting for an approver", MANAGE_BILLING: "Waiting for payment" };
const AT_KAURO: Readonly<Partial<Record<ProjectDashboardItem["phase"], { readonly label: string; readonly screen: string }>>> = {
  HEALTH_CHECK: { label: "Kauro is checking the files", screen: "UI18" },
  PROCESSING: { label: "Kauro is preparing the package", screen: "UI25" },
  DELIVERED: { label: "Open the delivery", screen: "UI26" },
  FAILED: { label: "See what happened", screen: "UI13" },
};

interface Row {
  readonly item: ProjectDashboardItem;
  readonly group: Group;
  readonly label: string;
  readonly screen: string;
}

function rowOf(item: ProjectDashboardItem, actions: readonly string[]): Row {
  if (item.phase === "FAILED") return { item, group: "stopped", label: "See what happened", screen: "UI13" };
  if (item.requiredAction !== "NONE") {
    const action = ACTION[item.requiredAction];
    if (action.needs !== undefined && !actions.includes(action.needs)) return { item, group: "others", label: WAITING[action.needs], screen: "UI13" };
    return { item, group: "yours", label: action.label, screen: action.screen };
  }
  const kauro = AT_KAURO[item.phase] ?? { label: "Open the project", screen: "UI13" };
  return { item, group: item.phase === "DELIVERED" ? "delivered" : "kauro", label: kauro.label, screen: kauro.screen };
}

/** Six marks, one a stage, filled up to the project's stage: where it is, at a glance, and said in words beside. */
function StageMarks({ stage }: { readonly stage: number }): ReactElement {
  return (
    <span className="kauro-stage-marks" aria-hidden="true">
      {STAGE_NAME.map((name, index) => (
        <span key={name} className={index < stage ? "is-done" : index === stage ? "is-current" : undefined} />
      ))}
    </span>
  );
}

function ProjectRow({ row, ctx }: { readonly row: Row; readonly ctx: PrototypeProps["ctx"] }): ReactElement {
  const { item } = row;
  const stage = STAGE_OF[item.phase];
  const href = appPathOf(row.screen, ctx, item.projectId);
  return (
    <li className={`kauro-board-row kauro-board-row--${row.group}`}>
      <Link className="kauro-board-link" href={href} prefetch={false}>
        <span className="kauro-board-client">
          <bdi>{item.clientLabel}</bdi>
          <span className="kauro-board-mode">{MODE[item.mode]}</span>
        </span>
        <span className="kauro-board-stage">
          {stage < 0 ? <span className="kauro-board-stopped">Stopped</span> : <StageMarks stage={stage} />}
          <span className="kauro-board-stage-name">{stage < 0 ? "The run ended" : `${stage + 1}. ${STAGE_NAME[stage]}`}</span>
        </span>
        <span className="kauro-board-when">
          {item.deadline === null ? <>Updated {day(item.lastActivityAt)}</> : row.group === "yours" ? <>Due {day(item.deadline)}</> : <>Deadline {day(item.deadline)}</>}
        </span>
        <span className="kauro-board-next">
          <span className="kauro-go">{row.label}</span>
        </span>
      </Link>
    </li>
  );
}

/** The repeat discount as reachable progress: the next project's discount, and how far the next step of the ladder is. */
function RepeatLine({ paid }: { readonly paid: number }): ReactElement | null {
  const tiers = POLICY_SNAPSHOT.repeatTiers.filter((tier) => tier.percent > 0);
  const current = [...tiers].reverse().find((tier) => paid >= tier.minimum);
  const next = tiers.find((tier) => paid < tier.minimum);
  if (current === undefined && next === undefined) return null;
  return (
    <p className="kauro-board-repeat">
      <span className="kauro-proposed">Proposed — D-UI11-1</span>{" "}
      {current === undefined ? (
        <>Your second project gets the repeat discount.</>
      ) : (
        <>
          Your next project gets the <strong>{current.percent}% repeat discount</strong>.
        </>
      )}
      {next === undefined ? null : (
        <>
          {" "}
          {next.minimum - paid} more paid {next.minimum - paid === 1 ? "project" : "projects"} to reach {next.percent}%.
        </>
      )}
    </p>
  );
}

export function Projects({ ctx, state }: PrototypeProps): ReactElement {
  const company = ctx.buyerType === "in-house";
  const actions = ctx.agency?.permittedActions ?? [];
  const all = state === "first" ? [] : company ? COMPANY_PROJECTS : AGENCY_PROJECTS;
  const clients = [...new Set(all.map((item) => item.clientLabel))];
  const [client, setClient] = useState<string>("");
  const rows = all.filter((item) => client === "" || item.clientLabel === client).map((item) => rowOf(item, actions));
  const workspace = ctx.agency?.displayName ?? "";
  const canStart = actions.includes("OPERATE_PROJECTS") && state !== "restricted";
  const [starting, setStarting] = useState(state === "new");

  return (
    <>
      <PageHead
        eyebrow={<bdi>{workspace}</bdi>}
        title="Your projects"
        accent={1}
        lead={company ? "Your preparation projects." : "Your client preparation projects."}
        aside={
          canStart && !starting && all.length > 0 ? (
            <Button variant="primary" onClick={() => setStarting(true)}>
              <span className="kauro-go">Start a project</span>
            </Button>
          ) : undefined
        }
      />
      {starting ? <StartProject ctx={ctx} clients={company ? [] : clients} onCancel={() => setStarting(false)} /> : null}
      {state === "restricted" ? (
        <Banner tone="warning" title="New work is paused for this agency" announce="status">
          <p>
            Kauro restricted this agency, so no new project, check or payment can start. Support, refunds and data deletion stay open. <ScreenLink to="UI52" ctx={ctx}>Open a support case</ScreenLink>
          </p>
        </Banner>
      ) : null}
      {all.length === 0 ? (
        <section className="kauro-board-first" aria-labelledby="board-first-h">
          <div className="kauro-board-first-start">
            <h2 id="board-first-h">Your first project</h2>
            <p>Upload the exports you want prepared. The free data health check shows what Kauro finds in them, and the exact price, before you pay anything.</p>
            {canStart && !starting ? (
              <Button variant="primary" onClick={() => setStarting(true)}>
                <span className="kauro-go">Start your first project</span>
              </Button>
            ) : null}
          </div>
          <ul className="kauro-board-list" aria-label="The example project">
            <li className="kauro-board-row kauro-board-row--example">
              <Link className="kauro-board-link" href={`/agencies/${EXAMPLE_ID}/projects/${AGENCY_PROJECTS[0]?.projectId ?? ""}`} prefetch={false}>
                <span className="kauro-board-client">
                  <bdi>Larch Studio</bdi>
                  <span className="kauro-board-mode">HubSpot</span>
                  <span className="kauro-board-example">Example · synthetic</span>
                </span>
                <span className="kauro-board-stage">
                  <StageMarks stage={6} />
                  <span className="kauro-board-stage-name">Delivered, from upload to import</span>
                </span>
                <span className="kauro-board-when">Synthetic data</span>
                <span className="kauro-board-next">
                  <span className="kauro-go">Explore the example</span>
                </span>
              </Link>
            </li>
          </ul>
        </section>
      ) : (
        <>
          <div className="kauro-board-tools">
            {company || clients.length < 2 ? null : (
              <label className="kauro-filter">
                Client
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
            {client === "" ? null : (
              <button type="button" className="kauro-filter-chip" onClick={() => setClient("")}>
                Showing {client} only · Show all
              </button>
            )}
            <RepeatLine paid={PAID_PROJECTS[ctx.key] ?? 0} />
          </div>
          {GROUPS.map((group) => {
            const inGroup = rows.filter((row) => row.group === group.key);
            if (inGroup.length === 0) return null;
            return (
              <section key={group.key} className="kauro-board-group" aria-labelledby={`board-${group.key}`}>
                <div className="kauro-board-group-head">
                  <h2 id={`board-${group.key}`}>
                    {group.title} <span className="kauro-board-count">{inGroup.length}</span>
                  </h2>
                  <p>{group.note}</p>
                </div>
                <ul className="kauro-board-list">
                  {inGroup.map((row) => (
                    <ProjectRow key={row.item.projectId} row={row} ctx={ctx} />
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </>
  );
}

const SERVICES = [
  { mode: "HUBSPOT", name: "HubSpot", body: "Import files and the steps for HubSpot's own importer." },
  { mode: "SALESFORCE", name: "Salesforce", body: "Import files and the steps for Salesforce Data Loader." },
  { mode: "CLEAN", name: "CLEAN", body: "Cleaned, explained standard files for another CRM or for spreadsheets." },
] as const;

/** The start of a project (CreateProject: the service and a purpose; an agency names the client first). The destination is set later. */
function StartProject({ ctx, clients, onCancel }: { readonly ctx: PrototypeProps["ctx"]; readonly clients: readonly string[]; readonly onCancel: () => void }): ReactElement {
  const router = useRouter();
  const [errors, setErrors] = useState<readonly { fieldId: string; message: string }[]>([]);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const found: { fieldId: string; message: string }[] = [];
    if (clients.length > 0 && String(data.get("client") ?? "") === "") found.push({ fieldId: "start-client", message: "Choose the client this project is for." });
    if (String(data.get("purpose") ?? "").trim() === "") found.push({ fieldId: "start-purpose", message: "Say in a few words what this project is for." });
    setErrors(found);
    if (found.length === 0) router.push(appPathOf("UI14", ctx));
  };
  return (
    <section className="kauro-board-start" aria-labelledby="board-start-h">
      <form className="kauro-form" noValidate onSubmit={submit}>
        <h2 id="board-start-h">Start a project</h2>
        <ErrorSummary title="Check these details" errors={errors} />
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
          {SERVICES.map((service, index) => (
            <label key={service.mode}>
              <input type="radio" name="mode" value={service.mode} defaultChecked={index === 0} />
              <span>
                <strong>{service.name}</strong>
                <small>{service.body}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <Field id="start-purpose" label="What this project is for" hint="A few words your team will recognise, such as: spring cleanup before the HubSpot move." error={errors.find((entry) => entry.fieldId === "start-purpose")?.message}>
          {(control) => <input {...control} name="purpose" maxLength={200} />}
        </Field>
        <p className="kauro-muted">The destination&apos;s settings come later, before the free check. Nothing is charged to start a project.</p>
        <div className="kauro-actions">
          <Button type="submit" variant="primary">
            <span className="kauro-go">Create the project</span>
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
