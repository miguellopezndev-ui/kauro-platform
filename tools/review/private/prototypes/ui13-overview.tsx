"use client";
// UI13 Overview (registry: "The current revision and next required action."), rebuilt in Order 11 round 2 (research agency-workspace.md
// §5.3, app-shell-settings.md §9.5, §9.11). The project's name is the page's h1 (the shared header); "Overview" is the page's own heading.
// The page answers "where is it, what now, who, by when?" before anything else (Stripe's "currently due", Airbyte's status first):
//   1. one next-step card: the step as a verb, one sentence of what and why, then who takes it (by name), by when, and what happens if not;
//      a person whose role cannot take it reads who can, and no dead button;
//   2. "In the way" only when something blocks, written as the blocker and who clears it;
//   3. the project's facts, then the last three events with the way to all activity.
// One date per fact, from timeline.ts (C-1): when the files of the unpaid check end before the quote's price, the card says to pay before
// the files go, or to ask for the one extension. While Kauro works, the card says nothing is needed and that we email. A completed project
// offers the next project for the same client, and the repeat discount is said here, once. A company run by one person has nobody to wait
// on, so its cards show the next action directly.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { ProjectHeader, type ProjectStage } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { EXAMPLE_ID } from "../lib/world.ts";
import { actor } from "./board.ts";
import { EXAMPLE } from "./example.ts";
import { day, Facts, moment, NextStep, Only, ScreenButton, ScreenLink, type StepFact } from "./kit.tsx";
import { can, type Duty, onlyLine, soloWorkspace, whoCan } from "./people.ts";
import { listPriceOf, PAID_PROJECTS, quotedPriceOf, repeatProgress, usd } from "./projects-data.ts";
import { SERVICE } from "./service.ts";
import { RETENTION } from "./retention.ts";
import { FILES_END_FIRST, TIMELINE } from "./timeline.ts";

export const UI13_STATES: readonly StateDef[] = [
  { key: "normal", label: "Quote to pay", note: "The plan is approved and the quote issued: the billing person or an owner pays it. The files of the check go before the quote's price does, and the card says so." },
  { key: "sources", label: "Files to upload", note: "A new project: an operator uploads the exports; for HubSpot and Salesforce an approver confirms the destination first." },
  { key: "check", label: "Kauro is checking", note: "The free data health check runs on its own: nothing is needed, and the team is emailed when it is ready." },
  { key: "plan", label: "Plan to approve", note: "The check is done and the plan reviewed: an approver or an owner approves revision 6." },
  { key: "processing", label: "Kauro is preparing", note: "Paid and matched: Kauro prepares and verifies the package. Nothing is needed; no delivery time is promised." },
  { key: "delivered", label: "Ready to import", note: "The package is verified: download it before its date and import it stage by stage (or, for Clean your data, take the cleaned files)." },
  { key: "completed", label: "Completed", note: "Every stage verified: the next project for the same client, with the repeat discount said once." },
  { key: "extended", label: "Free check extended (proposed)", note: "Owner decision of 2026-10-21: the one extension, now also for the free check, keeps the files 3 more days; the card says the new date and that no second one exists." },
  { key: "held", label: "Transfer pending, within its hold (proposed)", note: "Owner decision of 2026-10-21: the transfer was sent and its proof given, so the files are held up to 5 business days; nothing is confirmed and preparation cannot start." },
  { key: "hold-expired", label: "Hold ended (proposed)", note: "Owner decision of 2026-10-21: the hold ended without the money; the files are deleted and the way forward is a new upload." },
  { key: "changed", label: "Changed elsewhere", note: "Someone changed this project in another tab or session: the page asks to reload before anything consequential." },
];

const STAGE: Readonly<Record<string, ProjectStage>> = { normal: "purchase", changed: "purchase", extended: "purchase", held: "purchase", "hold-expired": "purchase", sources: "files", check: "check", plan: "plan", processing: "preparation", delivered: "delivery", completed: "delivery" };
const STAGES: readonly ProjectStage[] = ["files", "check", "plan", "purchase", "preparation", "delivery"];
/** The way to look at a step's page for a person who cannot take the step. */
const VIEW: Readonly<Record<string, string>> = { UI23: "See the quote", UI22: "See the plan", UI14: "See the files", UI27: "See the import steps", UI11: "Go to projects" };

const STATUS: Readonly<Record<string, { readonly tone: "info" | "warning" | "success"; readonly text: string }>> = {
  normal: { tone: "warning", text: "Waiting for payment" },
  changed: { tone: "warning", text: "Waiting for payment" },
  extended: { tone: "warning", text: "Waiting for payment" },
  held: { tone: "warning", text: "Transfer pending" },
  "hold-expired": { tone: "warning", text: "Files deleted" },
  sources: { tone: "info", text: "Waiting for files" },
  check: { tone: "info", text: "Kauro is checking" },
  plan: { tone: "warning", text: "Waiting for approval" },
  processing: { tone: "info", text: "Kauro is preparing" },
  delivered: { tone: "success", text: "Ready to import" },
  completed: { tone: "success", text: "Completed" },
};

interface Card {
  readonly label?: string;
  readonly heading: string;
  readonly body: ReactNode;
  readonly facts: readonly StepFact[];
  /** Who may take the step; absent when it is Kauro's. */
  readonly duty?: Duty;
  readonly what?: string;
  readonly cta?: { readonly label: string; readonly screen: string };
  readonly link?: { readonly label: string; readonly screen: string };
}

function cardOf(key: string, ctx: PrototypeProps["ctx"], mode: "CLEAN" | "HUBSPOT" | "SALESFORCE", client: string): Card {
  const clean = mode === "CLEAN";
  const price = usd(quotedPriceOf(mode));
  switch (key) {
    case "extended":
      return {
        label: "Next step · proposed",
        heading: `Pay before ${moment(RETENTION.extendedUntil)}`,
        body: <p>The one extension was asked for on {moment(RETENTION.extensionRequestedAt)}: the free check&apos;s files stay until {moment(RETENTION.extendedUntil)}. The quote of {price} is unchanged, and no second extension exists.</p>,
        facts: [
          ["Who", whoCan(ctx, "pay")],
          ["By", moment(RETENTION.extendedUntil)],
          ["If not", "The files are deleted and the quote cannot be paid"],
        ],
        duty: "pay",
        what: "pay the quote",
        cta: { label: "Open the quote", screen: "P-30" },
      };
    case "held":
      return {
        label: "Waiting for the transfer · proposed",
        heading: `Files held until ${moment(RETENTION.holdUntil)}`,
        body: <p>A transfer for {price} was sent and its proof given on {moment(RETENTION.proofAt)}. Kauro holds the files while the money arrives. Nothing is confirmed yet, and the preparation cannot start until Kauro matches the exact amount.</p>,
        facts: [
          ["Who", "Kauro, when the money arrives"],
          ["Held until", moment(RETENTION.holdUntil)],
          ["If not", "The files are deleted and a late transfer is returned"],
        ],
        link: { label: "See the payment and its hold", screen: "P-31" },
      };
    case "hold-expired":
      return {
        label: "The files are gone · proposed",
        heading: "Upload the files again for a new quote",
        body: <p>The hold ended on {moment(RETENTION.holdUntil)} without a confirmed payment, so the files were deleted and this quote cannot be paid. A transfer that still arrives is reviewed and returned.</p>,
        facts: [
          ["Who", whoCan(ctx, "operate")],
          ["Deleted", moment(RETENTION.holdUntil)],
        ],
        duty: "operate",
        what: "upload the files",
        cta: { label: "Upload the files again", screen: "UI14" },
      };
    case "sources":
      return {
        heading: "Upload the exports",
        body: <p>CSV or XLSX exports of the contacts, companies or deals to prepare. Kauro checks every row for free once they are sealed.</p>,
        facts: [
          ["Who", whoCan(ctx, "operate")],
          ["By", "No date yet: nothing is kept until a file is uploaded"],
        ],
        duty: "operate",
        what: "upload files",
        cta: { label: "Upload the files", screen: "UI14" },
      };
    case "check":
      return {
        label: "Kauro is working",
        heading: "Kauro is checking every row",
        body: (
          <p>
            Nothing is needed from you. We email {soloWorkspace(ctx) ? "you" : "your team"} and show it on Projects when the results are ready, or if anything fails.
          </p>
        ),
        facts: [
          ["Who", "Kauro"],
          ["Results by", `${moment(TIMELINE.checkDeadline)} at the latest`],
        ],
        link: { label: "See where the check is", screen: "UI18" },
      };
    case "plan":
      return {
        heading: "Approve revision 6 of the plan",
        body: <p>Every change Kauro proposes, with what it affects. Nothing is quoted or prepared until one person approves this exact revision.</p>,
        facts: [
          ["Who", whoCan(ctx, "approve")],
          ["By", moment(TIMELINE.filesKeptUntil)],
          ["If not", "The files and the check's results are deleted; you would upload the files again"],
        ],
        duty: "approve",
        what: "approve the plan",
        cta: { label: "Review and approve", screen: "UI22" },
      };
    case "processing":
      return {
        label: "Kauro is working",
        heading: "Kauro is preparing the package",
        body: (
          <p>
            The approved plan runs on the sealed files; every file is read back and checked before it is released. Nothing is needed from you: we email {soloWorkspace(ctx) ? "you" : "your team"} when the package is verified, or if anything fails.
          </p>
        ),
        facts: [
          ["Who", "Kauro"],
          ["Paid", moment(TIMELINE.paidAt)],
          ["Ready by", "No time is promised; we email when it is verified"],
        ],
        link: { label: "See the preparation", screen: "UI25" },
      };
    case "delivered":
      return clean
        ? {
            heading: "Download the cleaned files",
            body: <p>The cleaned files, the report and the record of every change. Anyone in the team can download them, with a fresh authenticator code.</p>,
            facts: [
              ["Who", "Anyone in your team"],
              ["By", moment(TIMELINE.packageAvailableUntil)],
              ["If not", "The package is deleted and cannot be downloaded again"],
            ],
            cta: { label: "Open the delivery", screen: "UI26" },
          }
        : {
            heading: "Import stage 1 and return its result",
            body: <p>Download the package, import the companies with {SERVICE[mode].importer ?? "your importer"} as the import steps say, then return the export of what was created. Kauro checks it before stage 2 opens.</p>,
            facts: [
              ["Who", whoCan(ctx, "operate")],
              ["Package kept until", moment(TIMELINE.packageAvailableUntil)],
              ["If not", "The package is deleted; the stages left cannot continue"],
            ],
            duty: "operate",
            what: "return a stage's result",
            cta: { label: "Open the import steps", screen: "UI27" },
          };
    case "completed":
      return {
        label: "Completed",
        heading: "Every import stage is verified",
        body: (
          <p>
            The project is complete. Its files and package follow their deletion date ({moment(TIMELINE.packageAvailableUntil)}).
          </p>
        ),
        facts: [],
        duty: "operate",
        what: "start a project",
        cta: { label: `Start another project for ${client}`, screen: "UI11" },
      };
    default:
      return {
        heading: "Pay the quote",
        body: (
          <>
            <p>
              {price} for {EXAMPLE.unitsText} billable source units, by bank transfer. The preparation starts once Kauro matches the exact amount.
            </p>
            {FILES_END_FIRST ? (
              <p>
                <strong>The quote is valid until {moment(TIMELINE.quoteExpiresAt)}, but your files are kept only until {moment(TIMELINE.filesKeptUntil)}.</strong> Pay before then, or ask for the one 3-day extension (to {moment(TIMELINE.filesExtendedUntil)}).
              </p>
            ) : null}
          </>
        ),
        facts: [
          ["Who", whoCan(ctx, "pay")],
          ["By", moment(FILES_END_FIRST ? TIMELINE.filesKeptUntil : TIMELINE.quoteExpiresAt)],
          ["If not", FILES_END_FIRST ? "The files are deleted and the quote cannot be paid; you would upload again" : "The quote expires; a new one is issued from the approved plan"],
        ],
        duty: "pay",
        what: "pay the quote",
        cta: { label: "Open the quote", screen: "UI23" },
        ...(FILES_END_FIRST ? { link: { label: "Ask for the extension", screen: "UI29" } } : {}),
      };
  }
}

/** What happened, newest first: every event a fact of timeline.ts, up to where the project stands. */
function eventsOf(ctx: PrototypeProps["ctx"], stage: ProjectStage, price: string): readonly { readonly at: string; readonly what: string }[] {
  const reached = (one: ProjectStage): boolean => STAGES.indexOf(stage) >= STAGES.indexOf(one);
  const all: readonly { readonly at: string; readonly what: string; readonly from: ProjectStage }[] = [
    { at: TIMELINE.packageReadyAt, what: "Package verified and released", from: "delivery" },
    { at: TIMELINE.paidAt, what: `Transfer matched to the exact amount: ${price}`, from: "preparation" },
    { at: TIMELINE.quoteIssuedAt, what: `Quote issued: ${price}, valid until ${moment(TIMELINE.quoteExpiresAt)}`, from: "purchase" },
    { at: TIMELINE.approvedAt, what: `Plan revision 6 approved by ${actor(ctx, "APPROVER")}`, from: "purchase" },
    { at: TIMELINE.checkReadyAt, what: `Free data health check ready: ${EXAMPLE.groups} possible duplicate groups`, from: "plan" },
    { at: TIMELINE.sealedAt, what: `Files sealed by ${actor(ctx, "OPERATOR")}: 2 files, ${EXAMPLE.unitsText} billable source units`, from: "check" },
  ];
  return all.filter((event) => reached(event.from)).slice(0, 3);
}

export function Overview({ ctx, state, project }: PrototypeProps): ReactElement {
  const agencyId = ctx.agency?.agencyId ?? "";
  const example = agencyId === EXAMPLE_ID;
  const company = ctx.buyerType === "in-house";
  const clean = project.mode === "CLEAN";
  const words = SERVICE[project.mode];
  const key = example ? "delivered" : state;
  const stage = STAGE[key] ?? "purchase";
  const after = (one: ProjectStage): boolean => STAGES.indexOf(stage) > STAGES.indexOf(one);
  const price = usd(quotedPriceOf(project.mode));
  const estimate = usd(listPriceOf(project.mode));
  const card = cardOf(key, ctx, project.mode, project.clientLabel);
  const mine = card.duty === undefined || example ? false : can(ctx, card.duty);
  const recent = eventsOf(ctx, stage, price);
  const repeat = repeatProgress(company ? PAID_PROJECTS.company : PAID_PROJECTS.agency);
  const blocker = key === "sources" && !clean ? `The destination's settings are not confirmed: ${whoCan(ctx, "approve")} confirms them before the free check can start.` : null;

  return (
    <>
      {example ? (
        <Banner tone="info" title="The example project" announce="status">
          <p>
            Every record here is invented; nothing is anyone&apos;s data, and nothing you do here is sent. When you want your own files checked, <ScreenLink to="UI09" ctx={ctx}>set up your agency or company</ScreenLink>.
          </p>
        </Banner>
      ) : null}
      <ProjectHeader stage={stage} title="Overview" {...(STATUS[key] === undefined ? {} : { status: STATUS[key] })} />
      {state === "changed" ? (
        <Banner tone="warning" title="This project changed elsewhere" announce="alert">
          <p>Someone changed it in another tab or session after this page was opened. Reload to see the current version before you continue.</p>
          <p>
            <button type="button" className="kauro-button kauro-button-secondary" onClick={() => window.location.reload()}>
              Reload the project
            </button>
          </p>
        </Banner>
      ) : null}
      <NextStep
        id="overview-next"
        {...(card.label === undefined ? {} : { label: card.label })}
        heading={card.heading}
        facts={card.facts}
        action={
          <>
            {card.cta !== undefined && (card.duty === undefined || mine || example) ? (
              <ScreenButton to={card.cta.screen} ctx={ctx} project={project.projectId} variant="primary">
                {card.cta.label}
              </ScreenButton>
            ) : null}
            {card.link !== undefined && (card.duty === undefined || mine) && (card.link.screen !== "UI29" || can(ctx, "delete")) ? (
              <ScreenLink to={card.link.screen} ctx={ctx} project={project.projectId}>
                {card.link.label}
              </ScreenLink>
            ) : null}
            {card.duty !== undefined && !mine && card.what !== undefined && !example ? (
              <>
                <Only>{onlyLine(ctx, card.duty, card.what)}</Only>
                {card.cta === undefined ? null : (
                  <ScreenLink to={card.cta.screen} ctx={ctx} project={project.projectId}>
                    {VIEW[card.cta.screen] ?? "Open the page"}
                  </ScreenLink>
                )}
              </>
            ) : null}
          </>
        }
      >
        {card.body}
        {key === "completed" && repeat.percent > 0 ? (
          <p>
            The next project of this workspace gets the {repeat.percent}% repeat discount on its quote ({company ? PAID_PROJECTS.company : PAID_PROJECTS.agency} paid {(company ? PAID_PROJECTS.company : PAID_PROJECTS.agency) === 1 ? "project" : "projects"} in the last 365 days).
          </p>
        ) : null}
      </NextStep>
      {blocker === null ? null : (
        <section className="kauro-b-blocker" aria-labelledby="blockers-h">
          <h2 id="blockers-h">In the way</h2>
          <p>{blocker}</p>
        </section>
      )}
      <div className="kauro-b-overview">
        <section aria-labelledby="facts-h">
          <h2 id="facts-h">This project</h2>
          <Facts
            rows={[
              ["Service", words.name],
              ["What you receive", words.line],
              ["Files", stage === "files" ? "Not sealed yet" : `2 files sealed · ${EXAMPLE.unitsText} billable source units`],
              ...(clean ? [] : ([["Destination", stage === "files" ? "To confirm before the check" : `${words.destination ?? ""} ${project.mode === "SALESFORCE" ? "org" : "account"}, settings confirmed`]] as const)),
              ["Plan", after("plan") ? `Revision 6, approved ${moment(TIMELINE.approvedAt)}` : stage === "plan" ? "Revision 6, ready for approval" : "After the check"],
              ["Money", after("purchase") ? `${price}, paid ${moment(TIMELINE.paidAt)}` : stage === "purchase" ? `Quote ${price}, valid until ${moment(TIMELINE.quoteExpiresAt)}` : stage === "plan" ? `Estimate ${estimate} before the repeat discount; the quote comes after approval` : "Estimated after the check"],
              [
                after("purchase") ? "Package kept until" : "Files kept until",
                key === "held"
                  ? `Held until ${moment(RETENTION.holdUntil)} for the transfer (proposed)`
                  : key === "extended"
                    ? `${moment(RETENTION.extendedUntil)}, extended once (proposed)`
                    : key === "hold-expired"
                      ? `Deleted ${moment(RETENTION.holdUntil)}`
                      : stage === "files"
                  ? "Set when the files are sealed"
                  : stage === "check"
                    ? "7 days after the check is ready, if nothing is bought"
                    : stage === "preparation"
                      ? `7 days after the package is ready, never after ${moment(TIMELINE.packageHardLimit)}`
                      : after("purchase")
                        ? moment(TIMELINE.packageAvailableUntil)
                        : moment(TIMELINE.filesKeptUntil),
              ],
            ]}
          />
          {company || example ? null : <StatusLine client={project.clientLabel} stage={stage} />}
        </section>
        <section aria-labelledby="activity-h">
          <h2 id="activity-h">Recently</h2>
          {recent.length === 0 ? (
            <p className="kauro-muted">Nothing has happened yet: the project was just started.</p>
          ) : (
            <ol className="kauro-b-recent">
              {recent.map((event) => (
                <li key={event.at}>
                  <span className="kauro-b-recent-when">{moment(event.at)}</span>
                  <span>{event.what}</span>
                </li>
              ))}
            </ol>
          )}
          <ScreenLink to="P-08" ctx={ctx} project={project.projectId}>
            All activity
          </ScreenLink>
        </section>
      </div>
    </>
  );
}

/** PROPOSED: one plain line an agency can paste to its client (Kauro never contacts the client; research §5.3, hypothesis H-1). */
function StatusLine({ client, stage }: { readonly client: string; readonly stage: ProjectStage }): ReactElement {
  const [copied, setCopied] = useState(false);
  const line: Readonly<Record<ProjectStage, string>> = {
    files: "We are collecting the exported files to prepare.",
    check: "Your files are being checked; we expect the results shortly.",
    plan: "The check is done; we are reviewing the plan before it is approved.",
    purchase: `Plan approved on ${day(TIMELINE.approvedAt)}; preparation starts once the payment is matched.`,
    preparation: "The approved changes are being prepared and verified.",
    delivery: "The verified files are ready; the import runs in stages.",
  };
  return (
    <div className="kauro-b-statusline">
      <p className="kauro-b-statusline-head">
        For {client} <span className="kauro-proposed kauro-b-proposed">Proposed</span>
      </p>
      <p className="kauro-b-statusline-text">{line[stage]}</p>
      <Button
        onClick={() => {
          void navigator.clipboard?.writeText(line[stage]).then(() => setCopied(true), () => setCopied(false));
        }}
      >
        Copy this status line
      </Button>
      <span role="status" className="kauro-muted">
        {copied ? "Copied. Kauro never sends it to your client." : ""}
      </span>
    </div>
  );
}
