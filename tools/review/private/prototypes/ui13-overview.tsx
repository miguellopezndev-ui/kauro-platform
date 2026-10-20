"use client";
// UI13 Overview (registry: "The current revision and next required action."): the project's own page. Its head names the client and the
// service and says what the project is for; the six stages say where it is; one panel says the next step, who takes it and by when; the
// facts are the project's own (the sealed set, the plan, the quote, how long the files are kept); the activity says what happened, in
// plain words, newest first. A change made in another tab or by someone else is said before anything consequential (registry exception):
// the page asks to reload and compares nothing silently.
//
// The example project (opened from a new account's welcome) is the same page with synthetic data and says so at the top, with the way to
// check one's own files. PROPOSED (D-UI13-1): the activity's names and events need a read the api does not serve yet.
import { ProjectStages, type ProjectStage } from "@web/screens/shared/project-stages.tsx";
import { Banner } from "@kauro/ui";
import { type ReactElement } from "react";
import { IDS } from "../lib/ids.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { EXAMPLE_ID } from "../lib/world.ts";
import { EXAMPLE } from "./example.ts";
import { Eyebrow, Facts, ScreenButton, ScreenLink } from "./kit.tsx";

export const UI13_STATES: readonly StateDef[] = [
  { key: "normal", label: "Quote to pay", note: "The plan is approved and the quote issued: the next step is paying it, by the billing person or an owner." },
  { key: "sources", label: "Files to upload", note: "A new project: the next step is uploading the exports." },
  { key: "check", label: "Kauro is checking", note: "The free data health check runs on its own: nothing to do until it is ready." },
  { key: "plan", label: "Plan to approve", note: "The check is done and the plan reviewed: an approver approves it." },
  { key: "processing", label: "Kauro is preparing", note: "Paid: Kauro prepares and verifies the package before its deadline." },
  { key: "delivered", label: "Delivered", note: "The package is ready: the next step is downloading it and importing in order." },
  { key: "changed", label: "Changed elsewhere", note: "Someone changed this project in another tab or session: the page asks to reload before anything consequential." },
];

const AT: Readonly<Record<string, ProjectStage>> = { normal: "quote", changed: "quote", sources: "files", check: "check", plan: "decide", processing: "prepare", delivered: "import" };

interface Next {
  readonly title: string;
  readonly body: string;
  readonly who: string;
  readonly cta?: { readonly label: string; readonly screen: string };
  readonly link?: { readonly label: string; readonly screen: string };
}

function nextOf(state: string, actions: readonly string[]): Next {
  switch (state) {
    case "sources":
      return { title: "Upload the exports", body: "CSV or spreadsheet files of the contacts, companies and deals you want prepared.", who: "Your team", cta: { label: "Upload the files", screen: "UI14" } };
    case "check":
      return { title: "Kauro is checking the files", body: "The free data health check reads every row of the sealed set. You can leave this page: nothing waits on you.", who: "Kauro", link: { label: "See where the check is", screen: "UI18" } };
    case "plan":
      return actions.includes("APPROVE_PLANS")
        ? { title: "Approve the plan", body: "Every change Kauro proposes, with what it affects. Nothing is prepared until the plan is approved.", who: "An approver or an owner", cta: { label: "Review and approve", screen: "UI22" } }
        : { title: "Waiting for an approver", body: "The plan is ready for approval. An approver or an owner of the workspace approves it.", who: "An approver or an owner", link: { label: "See the plan", screen: "UI19" } };
    case "processing":
      return { title: "Kauro is preparing the package", body: "The approved plan is prepared on the sealed files, then every file is verified before it is published.", who: "Kauro", link: { label: "See the preparation", screen: "UI25" } };
    case "delivered":
      return { title: "Download the package and import it", body: "The files, the report, the manifest and the importer's steps, in order. Download them before their deadline.", who: "Your team", cta: { label: "Open the delivery", screen: "UI26" } };
    default:
      return actions.includes("MANAGE_BILLING")
        ? { title: "Pay the quote", body: `${EXAMPLE.price} for ${EXAMPLE.unitsText} billable source units, by bank transfer. The preparation starts once the exact amount is matched.`, who: "The billing person or an owner", cta: { label: "Review the quote", screen: "UI23" } }
        : { title: "Waiting for payment", body: `The quote is issued: ${EXAMPLE.price}. The billing person or an owner pays it by bank transfer.`, who: "The billing person or an owner", link: { label: "See the quote", screen: "UI23" } };
  }
}

/** What happened, newest first, up to the project's stage: every event a fact the project already holds. */
const EVENTS: readonly { readonly at: string; readonly what: string; readonly from: ProjectStage }[] = [
  { at: "21 Oct 2026, 16:20", what: "Package verified and published: 2 files, the report, the manifest and the importer's steps", from: "import" },
  { at: "21 Oct 2026, 09:30", what: "Payment matched to the exact amount: USD 1,295.00", from: "prepare" },
  { at: "20 Oct 2026, 13:00", what: "Quote issued: USD 1,295.00, valid until 3 Nov", from: "quote" },
  { at: "20 Oct 2026, 12:40", what: "Plan approved by Samuel Osei (approver)", from: "quote" },
  { at: "20 Oct 2026, 11:05", what: "Free data health check ready: 207 possible duplicate groups", from: "decide" },
  { at: "20 Oct 2026, 09:58", what: "Set sealed: 2 files, 15,684 billable source units", from: "check" },
  { at: "20 Oct 2026, 09:14", what: "contacts.csv and companies.xlsx uploaded by Priya Nair (operator)", from: "check" },
];
const ORDER: readonly ProjectStage[] = ["files", "check", "decide", "quote", "prepare", "import"];

export function Overview({ ctx, state }: PrototypeProps): ReactElement {
  const agencyId = ctx.agency?.agencyId ?? "";
  const example = agencyId === EXAMPLE_ID;
  const stage = example ? "import" : (AT[state] ?? "quote");
  const next = example ? nextOf("delivered", []) : nextOf(state, ctx.agency?.permittedActions ?? []);
  const activity = EVENTS.filter((event) => ORDER.indexOf(event.from) <= ORDER.indexOf(stage));
  return (
    <>
      {example ? (
        <Banner tone="info" title="The example project" announce="status">
          <p>
            Synthetic data from start to finish: nothing here is anyone&apos;s. When you want your own files checked, <ScreenLink to="UI09" ctx={ctx}>set up your agency or company</ScreenLink>.
          </p>
        </Banner>
      ) : null}
      <ProjectStages agencyId={agencyId} projectId={IDS.project} current={stage} />
      <header className="kauro-project-head">
        <Eyebrow>
          <bdi>{EXAMPLE.client.replace(" (synthetic)", "")}</bdi> · {EXAMPLE.destination}
        </Eyebrow>
        <h1>Contacts and companies into HubSpot</h1>
        <p className="kauro-screen-lead">The current revision and next required action.</p>
      </header>
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
        </p>
        <div className="kauro-actions">
          {next.cta === undefined ? null : (
            <ScreenButton to={next.cta.screen} ctx={ctx} variant="primary">
              <span className="kauro-go">{next.cta.label}</span>
            </ScreenButton>
          )}
          {next.link === undefined ? null : (
            <ScreenButton to={next.link.screen} ctx={ctx}>
              {next.link.label}
            </ScreenButton>
          )}
        </div>
      </section>
      <div className="kauro-project-grid">
        <section aria-labelledby="facts-h">
          <h2 id="facts-h">This project</h2>
          <Facts
            rows={[
              ["Service", "Prepare for HubSpot"],
              ["Sealed set", `${EXAMPLE.sources.length} files · ${EXAMPLE.unitsText} billable source units`],
              ["Plan", stage === "files" || stage === "check" ? "Not yet" : stage === "decide" ? "Ready for approval" : "Approved 20 Oct 2026"],
              ["Quote", stage === "quote" || stage === "prepare" || stage === "import" ? `${EXAMPLE.price} · valid until 3 Nov 2026` : "After the plan is approved"],
              ["Files kept until", stage === "files" ? "Set when the files are sealed" : "3 Nov 2026"],
            ]}
          />
        </section>
        <section aria-labelledby="activity-h">
          <h2 id="activity-h">What happened</h2>
          <p className="kauro-proposed">Proposed — the activity needs a read (D-UI13-1)</p>
          {activity.length === 0 ? (
            <p className="kauro-muted">Nothing has happened yet: the project was just started.</p>
          ) : (
            <ol className="kauro-activity">
              {activity.map((entry) => (
                <li key={entry.at}>
                  <span className="kauro-activity-when">{entry.at} UTC</span>
                  <span>{entry.what}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
      <p className="kauro-muted">
        A question about this project? <ScreenLink to="UI52" ctx={ctx}>Open a support case</ScreenLink>. What is kept, and until when: <ScreenLink to="UI29" ctx={ctx}>data lifecycle</ScreenLink>.
      </p>
    </>
  );
}
