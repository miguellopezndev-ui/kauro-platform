"use client";
// P-08 Activity (proposed; the owner's decision of 2026-10-20: Activity is reachable from every project and never a step). What happened in
// the project, newest first, one typed event a fact: who, when (with the time zone), what, and the reference it names in monospace, so the
// page doubles as the project's record (research: app-operations-ux.md §1.3 proposal 1.4, Basecamp's activity filters). A void, a reissue
// or a cancellation keeps its reason. Filters narrow by area and by person; nothing here can be edited. Needs an activity read (F-06).
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { PageHead } from "./kit.tsx";

export const P08_STATES: readonly StateDef[] = [
  { key: "normal", label: "Activity", note: "Every event of the project, newest first, with who, when and the reference; filters by area and by person." },
  { key: "empty", label: "Nothing yet", note: "A project just started: the page says what will appear here." },
];

type Area = "Files" | "Health check" | "Plan" | "Purchase" | "Delivery" | "Import";
const EVENTS: readonly { readonly at: string; readonly area: Area; readonly what: string; readonly who: string; readonly ref?: string }[] = [
  { at: "Oct 21, 2026, 4:32 PM", area: "Delivery", what: "Links issued for 7 files, 15 minutes each", who: "Lena Ortiz", ref: "DL-0003" },
  { at: "Oct 21, 2026, 4:20 PM", area: "Delivery", what: "Package version 1 verified and released", who: "Kauro", ref: "PKG-0001 · sha256 4f1c9a2e…" },
  { at: "Oct 21, 2026, 9:30 AM", area: "Purchase", what: "Transfer received and matched: USD 1,295.00", who: "Kauro", ref: "ORD-2026-0147" },
  { at: "Oct 20, 2026, 1:10 PM", area: "Purchase", what: "Payment order created", who: "Ines Duarte", ref: "ORD-2026-0147" },
  { at: "Oct 20, 2026, 1:00 PM", area: "Purchase", what: "Quote issued: USD 1,295.00, valid until Nov 3, 2026", who: "Kauro", ref: "QT-2026-0211-1" },
  { at: "Oct 20, 2026, 12:40 PM", area: "Plan", what: "Revision 6 approved, with a fresh Kauro code", who: "Samuel Osei", ref: "PLAN r6" },
  { at: "Oct 20, 2026, 12:31 PM", area: "Plan", what: "Revision 6 proposed: 3 duplicate groups decided again", who: "Priya Nair", ref: "PLAN r6" },
  { at: "Oct 20, 2026, 12:05 PM", area: "Plan", what: "Changes requested on revision 5: keep group 112 apart, two people share a team inbox", who: "Samuel Osei", ref: "PLAN r5" },
  { at: "Oct 20, 2026, 11:05 AM", area: "Health check", what: "Free data health check ready: 207 possible duplicate groups", who: "Kauro", ref: "AUD-0042" },
  { at: "Oct 20, 2026, 9:58 AM", area: "Files", what: "Set sealed: 2 files, 15,684 billable source units", who: "Priya Nair", ref: "REV-0007" },
  { at: "Oct 20, 2026, 9:14 AM", area: "Files", what: "contacts.csv and companies.xlsx uploaded", who: "Priya Nair" },
];
const AREAS: readonly (Area | "All")[] = ["All", "Files", "Health check", "Plan", "Purchase", "Delivery", "Import"];
const PEOPLE = ["Everyone", ...new Set(EVENTS.map((event) => event.who))];

export function Activity({ state }: PrototypeProps): ReactElement {
  const [area, setArea] = useState<Area | "All">("All");
  const [person, setPerson] = useState("Everyone");
  const shown = state === "empty" ? [] : EVENTS.filter((event) => (area === "All" || event.area === area) && (person === "Everyone" || event.who === person));
  return (
    <>
      <ProjectHeader current={state === "empty" ? "files" : "delivery"} area="nav.project.activity.label" />
      <PageHead title="Activity" lead="Everything that happened in this project, newest first." />
      <p className="kauro-proposed kauro-proposed--page">Proposed — the activity needs a read the API does not have yet (F-06)</p>
      {state === "empty" ? (
        <p className="kauro-muted">Nothing has happened yet. Uploads, the check, each plan revision, the quote, the payment and the delivery appear here as they happen, with who and when.</p>
      ) : (
        <>
          <div className="kauro-filter kauro-activity-filters">
            <label>
              Area
              <select value={area} onChange={(event) => setArea(event.target.value as Area | "All")}>
                {AREAS.map((one) => (
                  <option key={one}>{one}</option>
                ))}
              </select>
            </label>
            <label>
              Person
              <select value={person} onChange={(event) => setPerson(event.target.value)}>
                {PEOPLE.map((one) => (
                  <option key={one}>{one}</option>
                ))}
              </select>
            </label>
          </div>
          {shown.length === 0 ? (
            <p className="kauro-muted">Nothing matches these filters.</p>
          ) : (
            <ol className="kauro-timeline">
              {shown.map((event) => (
                <li key={`${event.at}-${event.what}`}>
                  <span className="kauro-timeline-when">{event.at} UTC</span>
                  <span className="kauro-timeline-area">{event.area}</span>
                  <span className="kauro-timeline-what">{event.what}</span>
                  <span className="kauro-timeline-who">
                    {event.who}
                    {event.ref === undefined ? null : <code>{event.ref}</code>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </>
  );
}
