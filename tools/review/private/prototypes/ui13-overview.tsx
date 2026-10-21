"use client";
// UI13 Overview (registry: "The current revision and next required action."). The owner's decision of 2026-10-20 on project navigation:
// the overview shows where the project stands, what is blocking it, and the next recommended action, with who takes it and by when. The
// project's header (client, name, service, the step it is at) is drawn once, above; the areas are in the side menu, so the overview does not
// list them again. Then the project's facts, in the service's own terms, and the last few things that happened, with the way to all of its
// activity (a proposed area, P-08). A change made in another tab or by someone else is said before anything consequential (registry
// exception): the page asks to reload and compares nothing silently.
//
// The example project (opened from a new account's welcome) is the same page with synthetic data and says so at the top. The activity needs
// a read the api does not serve yet (D-UI13-1, F-06).
import { Banner } from "@kauro/ui";
import { type ReactElement } from "react";
import { ProjectHeader, type ProjectStep } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { EXAMPLE_ID } from "../lib/world.ts";
import { EXAMPLE } from "./example.ts";
import { Facts, PageHead, ScreenButton, ScreenLink } from "./kit.tsx";
import { SERVICE } from "./service.ts";

export const UI13_STATES: readonly StateDef[] = [
  { key: "normal", label: "Quote to pay", note: "The plan is approved and the quote issued: the next step is paying it, by the billing person or an owner." },
  { key: "sources", label: "Files to upload", note: "A new project: the next step is uploading the exports; the blocker is said in words." },
  { key: "check", label: "Kauro is checking", note: "The free data health check runs on its own: nothing to do until it is ready." },
  { key: "plan", label: "Plan to approve", note: "The check is done and the plan reviewed: an approver approves it." },
  { key: "processing", label: "Kauro is preparing", note: "Paid: Kauro prepares and verifies the package before its deadline." },
  { key: "delivered", label: "Delivered", note: "The package is ready: the next step is downloading it (and, for a CRM, importing it in order)." },
  { key: "changed", label: "Changed elsewhere", note: "Someone changed this project in another tab or session: the page asks to reload before anything consequential." },
];

const STEP: Readonly<Record<string, ProjectStep>> = { normal: "purchase", changed: "purchase", sources: "files", check: "check", plan: "plan", processing: "delivery", delivered: "delivery" };
const ORDER: readonly ProjectStep[] = ["files", "check", "plan", "purchase", "delivery", "import"];

interface Next {
  readonly title: string;
  readonly body: string;
  readonly who: string;
  readonly when?: string;
  readonly cta?: { readonly label: string; readonly screen: string };
  readonly link?: { readonly label: string; readonly screen: string };
}

function nextOf(state: string, actions: readonly string[], clean: boolean): Next {
  switch (state) {
    case "sources":
      return { title: "Upload the exports", body: "CSV or XLSX exports of the contacts, companies or deals you want prepared.", who: "Your team", cta: { label: "Upload the files", screen: "UI14" } };
    case "check":
      return { title: "Kauro is checking the files", body: "The free data health check reads every row of the sealed set. You can leave this page: nothing waits on you.", who: "Kauro", when: "Ready by Oct 20, 2026, 12:02 PM UTC at the latest", link: { label: "See where the check is", screen: "UI18" } };
    case "plan":
      return actions.includes("APPROVE_PLANS")
        ? { title: "Approve the plan", body: "Every change Kauro proposes, with what it affects. Nothing is prepared until the plan is approved.", who: "An approver or an owner", cta: { label: "Review and approve", screen: "UI22" } }
        : { title: "Waiting for an approver", body: "The plan is ready. Samuel Osei (approver) or Lena Ortiz (owner) approves it.", who: "An approver or an owner", link: { label: "See the plan", screen: "UI19" } };
    case "processing":
      return { title: "Kauro is preparing the package", body: "The approved plan runs on the sealed files, then every file is read back and checked before it is released.", who: "Kauro", when: "Delivered by Oct 22, 2026, 2:00 PM UTC", link: { label: "See the preparation", screen: "UI25" } };
    case "delivered":
      return clean
        ? { title: "Download the cleaned files", body: "The cleaned files, the report and the record of every change. Download them before Oct 27, 2026.", who: "Your team", when: "Available until Oct 27, 2026, 4:20 PM UTC", cta: { label: "Open the delivery", screen: "UI26" } }
        : { title: "Download the package and import it", body: "The files, the report, the manifest and the import steps. Import in stages and return each stage's result.", who: "Your team", when: "Available until Oct 27, 2026, 4:20 PM UTC", cta: { label: "Open the delivery", screen: "UI26" } };
    default:
      return actions.includes("MANAGE_BILLING")
        ? { title: "Pay the quote", body: `${EXAMPLE.price} for ${EXAMPLE.unitsText} billable source units, by bank transfer. Your team can start the preparation once the exact amount is matched.`, who: "The billing person or an owner", when: "The quote is valid until Nov 3, 2026, 1:00 PM UTC", cta: { label: "Review the quote", screen: "UI23" } }
        : { title: "Waiting for payment", body: `The quote is issued: ${EXAMPLE.price}. Ines Duarte (billing) or Lena Ortiz (owner) pays it by bank transfer.`, who: "The billing person or an owner", when: "The quote is valid until Nov 3, 2026, 1:00 PM UTC", link: { label: "See the quote", screen: "UI23" } };
  }
}

/** What stops the project going on, in words (ProjectView.readinessBlockers), for the states that have one. */
const BLOCKERS: Readonly<Record<string, readonly string[]>> = {
  sources: ["No sealed set of files yet: the check needs one"],
  plan: ["The plan is not approved yet: no quote can be issued"],
  normal: ["The quote is not paid yet: nothing is prepared until it is"],
  changed: ["The quote is not paid yet: nothing is prepared until it is"],
};

/** What happened, newest first, up to the project's step: every event a fact the project already holds. */
const EVENTS: readonly { readonly at: string; readonly what: string; readonly from: ProjectStep }[] = [
  { at: "Oct 21, 2026, 4:20 PM", what: "Package verified and released", from: "delivery" },
  { at: "Oct 21, 2026, 9:30 AM", what: "Payment matched to the exact amount: USD 1,295.00", from: "delivery" },
  { at: "Oct 20, 2026, 1:00 PM", what: "Quote issued: USD 1,295.00, valid until Nov 3", from: "purchase" },
  { at: "Oct 20, 2026, 12:40 PM", what: "Plan revision 6 approved by Samuel Osei (approver)", from: "purchase" },
  { at: "Oct 20, 2026, 11:05 AM", what: "Free data health check ready: 207 possible duplicate groups", from: "plan" },
  { at: "Oct 20, 2026, 9:58 AM", what: "Set sealed: 2 files, 15,684 billable source units", from: "check" },
  { at: "Oct 20, 2026, 9:14 AM", what: "contacts.csv and companies.xlsx uploaded by Priya Nair (operator)", from: "check" },
];

export function Overview({ ctx, state, project }: PrototypeProps): ReactElement {
  const agencyId = ctx.agency?.agencyId ?? "";
  const example = agencyId === EXAMPLE_ID;
  const clean = project.mode === "CLEAN";
  const words = SERVICE[project.mode];
  const key = example ? "delivered" : state;
  const step = STEP[key] ?? "purchase";
  const next = nextOf(key, example ? [] : (ctx.agency?.permittedActions ?? []), clean);
  const blockers = example ? [] : (BLOCKERS[key] ?? []);
  const recent = EVENTS.filter((event) => ORDER.indexOf(event.from) <= ORDER.indexOf(step)).slice(0, 3);
  const after = (target: ProjectStep): boolean => ORDER.indexOf(step) > ORDER.indexOf(target);
  return (
    <>
      {example ? (
        <Banner tone="info" title="The example project" announce="status">
          <p>
            Every record here is invented; nothing is anyone&apos;s data, and nothing you do here is sent. When you want your own files checked, <ScreenLink to="UI09" ctx={ctx}>set up your agency or company</ScreenLink>.
          </p>
        </Banner>
      ) : null}
      <ProjectHeader current={step} />
      <PageHead title="Overview" lead="Where the project stands, what is in the way, and what comes next." />
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
      <section className="kauro-next" aria-labelledby="next-h">
        <p className="kauro-next-label">Next step</p>
        <h2 id="next-h">{next.title}</h2>
        <p>{next.body}</p>
        <p className="kauro-next-who">
          <span>Who acts:</span> {next.who}
          {next.when === undefined ? null : (
            <>
              {" "}
              · <span>When:</span> {next.when}
            </>
          )}
        </p>
        <div className="kauro-actions">
          {next.cta === undefined ? null : (
            <ScreenButton to={next.cta.screen} ctx={ctx} project={project.projectId} variant="primary">
              <span className="kauro-go">{next.cta.label}</span>
            </ScreenButton>
          )}
          {next.link === undefined ? null : (
            <ScreenButton to={next.link.screen} ctx={ctx} project={project.projectId}>
              {next.link.label}
            </ScreenButton>
          )}
        </div>
      </section>
      {blockers.length === 0 ? null : (
        <section className="kauro-blockers" aria-labelledby="blockers-h">
          <h2 id="blockers-h">In the way</h2>
          <ul>
            {blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </section>
      )}
      <div className="kauro-project-grid">
        <section aria-labelledby="facts-h">
          <h2 id="facts-h">This project</h2>
          <Facts
            rows={[
              ["Service", words.name],
              ["What you receive", words.line],
              ["Files", step === "files" ? "Not sealed yet" : `${EXAMPLE.sources.length} files sealed · ${EXAMPLE.unitsText} billable source units`],
              ...(clean ? [] : ([["Destination", step === "files" ? "To confirm before the check" : `${words.destination ?? ""} ${project.mode === "SALESFORCE" ? "org" : "account"}, settings confirmed Oct 20, 2026`]] as const)),
              ["Plan", after("plan") ? "Revision 6, approved Oct 20, 2026" : step === "plan" ? "Revision 6, ready for approval" : "After the check"],
              ["Price", after("purchase") ? `${EXAMPLE.price}, paid` : step === "purchase" ? `${EXAMPLE.price}, quoted · valid until Nov 3, 2026` : after("check") ? `Estimate ${EXAMPLE.price}; the quote comes after approval` : "Estimated after the check"],
              ["Files kept until", step === "files" ? "Set when the files are sealed" : step === "check" ? "7 days after the check is ready, if nothing is bought" : after("purchase") ? "Oct 27, 2026, 7 days after the package" : "Oct 27, 2026, 7 days after the check, unless the quote is paid"],
            ]}
          />
        </section>
        <section aria-labelledby="activity-h">
          <h2 id="activity-h">Recently</h2>
          {recent.length === 0 ? (
            <p className="kauro-muted">Nothing has happened yet: the project was just started.</p>
          ) : (
            <ol className="kauro-activity">
              {recent.map((entry) => (
                <li key={entry.at}>
                  <span className="kauro-activity-when">{entry.at} UTC</span>
                  <span>{entry.what}</span>
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
