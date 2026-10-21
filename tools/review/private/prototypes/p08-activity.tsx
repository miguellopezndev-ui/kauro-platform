"use client";
// P-08 Activity (proposed; the owner's decision of 2026-10-20: reachable from every project, never a step), rebuilt in Order 11 round 2
// (research agency-workspace.md §5.17, NN/g status trackers: latest first, keep history). The project's record for the team, support and
// audit: a dated list, newest first, grouped by day; each event its time (UTC), who did it (name and role, or Kauro), what happened, and the
// reference it names in monospace. Filters by stage and by person. Nothing is editable; no icons, no avatars. Every time comes from
// timeline.ts; the events between two of its facts (a revision proposed, changes requested, links issued) are placed relative to them.
// Needs an activity read (F-06).
import { type ReactElement, useState } from "react";
import { ProjectHeader, type ProjectStage, stageLabel } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { actor } from "./board.ts";
import { EXAMPLE } from "./example.ts";
import { day, moment } from "./kit.tsx";
import { quotedPriceOf, usd } from "./projects-data.ts";
import { TIMELINE } from "./timeline.ts";

export const P08_STATES: readonly StateDef[] = [
  { key: "normal", label: "Activity", note: "Every event of a delivered project, newest first, grouped by day, with who, when and the reference; filters by stage and by person." },
  { key: "empty", label: "Nothing yet", note: "A project just started: one heading and one sentence of what will appear here." },
];

const STAGES: readonly ProjectStage[] = ["files", "check", "plan", "purchase", "preparation", "delivery"];
const MINUTE = 60_000;
const after = (iso: string, minutes: number): string => new Date(Date.parse(iso) + minutes * MINUTE).toISOString().replace(".000Z", "Z");
/** "4:32 PM UTC" */
const time = (iso: string): string => moment(iso).replace(/^.*, (\d{1,2}:\d{2} [AP]M UTC)$/, "$1");

/** The order's payment reference, as the payment page shows it: grouped in fours for reading. */
const REFERENCE = "K0123456789ABCDEFGHJKMN".replace(/(.{4})(?=.)/g, "$1 ");

interface Event {
  readonly at: string;
  readonly stage: ProjectStage;
  readonly what: string;
  readonly who: string;
  readonly ref?: string;
}

function eventsOf(ctx: PrototypeProps["ctx"], mode: "CLEAN" | "HUBSPOT" | "SALESFORCE"): readonly Event[] {
  const price = usd(quotedPriceOf(mode));
  return [
    { at: after(TIMELINE.packageReadyAt, 12), stage: "delivery", what: "Download links issued for the package's files, each working 15 minutes", who: actor(ctx, "OWNER"), ref: "Package version 1" },
    { at: TIMELINE.packageReadyAt, stage: "delivery", what: "Package version 1 verified and released", who: "Kauro", ref: "Package version 1" },
    { at: TIMELINE.preparationStartedAt, stage: "preparation", what: "Preparation started on the approved plan", who: actor(ctx, "OPERATOR"), ref: "Plan revision 6" },
    { at: TIMELINE.paidAt, stage: "purchase", what: `Transfer received and matched to the exact amount: ${price}`, who: "Kauro", ref: REFERENCE },
    { at: TIMELINE.orderCreatedAt, stage: "purchase", what: "Payment order created", who: actor(ctx, "BILLING"), ref: REFERENCE },
    { at: TIMELINE.quoteIssuedAt, stage: "purchase", what: `Quote issued: ${price}, valid until ${moment(TIMELINE.quoteExpiresAt)}`, who: "Kauro" },
    { at: TIMELINE.approvedAt, stage: "plan", what: "Revision 6 approved, with a fresh authenticator code", who: actor(ctx, "APPROVER"), ref: "Plan revision 6" },
    { at: after(TIMELINE.planProposedAt, 50), stage: "plan", what: "Revision 6 proposed: 3 duplicate groups decided again", who: actor(ctx, "OPERATOR"), ref: "Plan revision 6" },
    { at: after(TIMELINE.planProposedAt, 25), stage: "plan", what: "Changes requested on revision 5: keep 3 groups apart, two people share a team inbox", who: actor(ctx, "APPROVER"), ref: "Plan revision 5" },
    { at: TIMELINE.planProposedAt, stage: "plan", what: "Revision 5 proposed", who: actor(ctx, "OPERATOR"), ref: "Plan revision 5" },
    { at: TIMELINE.checkReadyAt, stage: "check", what: `Free data health check ready: ${EXAMPLE.groups} possible duplicate groups`, who: "Kauro" },
    { at: TIMELINE.checkStartedAt, stage: "check", what: "Free data health check started", who: actor(ctx, "OPERATOR") },
    { at: TIMELINE.sealedAt, stage: "files", what: `Files sealed: 2 files, ${EXAMPLE.unitsText} billable source units`, who: actor(ctx, "OPERATOR"), ref: "Sealed set 1" },
    { at: TIMELINE.uploadedAt, stage: "files", what: "contacts.csv and companies.xlsx uploaded", who: actor(ctx, "OPERATOR") },
  ];
}

export function Activity({ ctx, state, project }: PrototypeProps): ReactElement {
  const [stage, setStage] = useState<ProjectStage | "">("");
  const [person, setPerson] = useState("");
  const all = state === "empty" ? [] : eventsOf(ctx, project.mode);
  const people = [...new Set(all.map((event) => event.who))];
  const shown = all.filter((event) => (stage === "" || event.stage === stage) && (person === "" || event.who === person));
  const days = [...new Set(shown.map((event) => day(event.at)))];
  return (
    <>
      <ProjectHeader stage={state === "empty" ? "files" : "delivery"} title="Activity" lead="Everything that happened in this project, newest first." />
      <p className="kauro-proposed kauro-b-proposed kauro-b-proposed--page">Proposed: the activity needs a read the API does not have yet (F-06)</p>
      {all.length === 0 ? (
        <section className="kauro-empty" aria-labelledby="activity-none-h">
          <h2 id="activity-none-h">No activity yet</h2>
          <p>Uploads, the check, each plan revision, the quote, the payment and the delivery appear here as they happen, with who and when.</p>
        </section>
      ) : (
        <>
          <div className="kauro-b-filters" role="group" aria-label="Filter the activity">
            <label className="kauro-b-filter">
              <span>Stage</span>
              <select value={stage} onChange={(event) => setStage(event.target.value as ProjectStage | "")}>
                <option value="">All stages</option>
                {STAGES.map((one) => (
                  <option key={one} value={one}>
                    {stageLabel(one, project.mode)}
                  </option>
                ))}
              </select>
            </label>
            <label className="kauro-b-filter">
              <span>Person</span>
              <select value={person} onChange={(event) => setPerson(event.target.value)}>
                <option value="">Everyone</option>
                {people.map((one) => (
                  <option key={one} value={one}>
                    {one}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {shown.length === 0 ? (
            <section className="kauro-empty" aria-labelledby="activity-filtered-h">
              <h2 id="activity-filtered-h">Nothing matches these filters</h2>
              <p>Choose another stage or person to see their events.</p>
            </section>
          ) : (
            days.map((date) => (
              <section key={date} className="kauro-b-day" aria-labelledby={`day-${date.replace(/\W+/g, "-")}`}>
                <h2 id={`day-${date.replace(/\W+/g, "-")}`}>{date}</h2>
                <ol className="kauro-b-events">
                  {shown
                    .filter((event) => day(event.at) === date)
                    .map((event) => (
                      <li key={`${event.at}-${event.what}`}>
                        <span className="kauro-b-event-time">{time(event.at)}</span>
                        <span className="kauro-b-event-main">
                          <span className="kauro-b-event-what">{event.what}</span>
                          <span className="kauro-b-event-meta">
                            {event.who} · {stageLabel(event.stage, project.mode)}
                            {event.ref === undefined ? null : (
                              <>
                                {" · "}
                                {event.ref === REFERENCE ? <code>{event.ref}</code> : event.ref}
                              </>
                            )}
                          </span>
                        </span>
                      </li>
                    ))}
                </ol>
              </section>
            ))
          )}
        </>
      )}
    </>
  );
}
