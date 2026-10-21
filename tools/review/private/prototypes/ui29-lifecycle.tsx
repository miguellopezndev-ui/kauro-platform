"use client";
// UI29 Data and deletion (registry: "See what remains and what will be deleted."), rebuilt in Order 11 round 2 (research
// agency-workspace.md §5.18; principles-craft.md C11, V22). What Kauro holds for this project, until when, and the two things a person can
// do about it:
//   - one verdict line first ("Files and package deleted on …, unless you extend once (to …)");
//   - the schedule as a table with absolute dates (RetentionView: class, soft and hard deadlines, state), every date from timeline.ts and the
//     policy: a purchased package stays 7 days after it is ready, never past 14 days from the payment; one extension of up to 72 hours,
//     never past that limit;
//   - two separate panels, not a pair of buttons: More time (only while possible) and Delete now (irreversible and early, so it asks for the
//     project's name typed, then the authenticator code). Both are owner and admin actions (CMD060, CMD042); every other role reads one line
//     naming who can, and no control;
//   - what deletion does not reach, said plainly.
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import { type FormEvent, type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { actor } from "./board.ts";
import { Badge, moment, Only } from "./kit.tsx";
import { can, onlyLine } from "./people.ts";
import { TIMELINE } from "./timeline.ts";

export const UI29_STATES: readonly StateDef[] = [
  { key: "normal", label: "Kept", note: "What the delivered project holds and when each goes; the one extension still available; early deletion with a typed confirmation." },
  { key: "extended", label: "Extended", note: "The one extension used: 3 more days, still inside the limit set by the payment date." },
  { key: "deletion", label: "Deletion requested", note: "An owner asked to delete the project's data now: what goes, and that the page says when it is done." },
  { key: "deleted", label: "Deleted", note: "The files and package are deleted on their date; nothing can bring them back." },
];

const R = POLICY_SNAPSHOT.retention;
const HOUR = 3_600_000;
const EXTENSION_HOURS = 72;
const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");
const until = TIMELINE.packageAvailableUntil;
const hard = TIMELINE.packageHardLimit;
const extendedUntil = iso(Math.min(Date.parse(until) + EXTENSION_HOURS * HOUR, Date.parse(hard)));
const requestedAt = iso(Date.parse(TIMELINE.packageReadyAt) + 18 * HOUR);

interface Row {
  readonly what: string;
  readonly holds: string;
  readonly until: string;
  readonly rule: string;
  readonly state: "kept" | "deleting" | "deleted";
}

export function Lifecycle({ ctx, state, project }: PrototypeProps): ReactElement {
  const clean = project.mode === "CLEAN";
  const extended = state === "extended";
  const gone = state === "deleted";
  const deleting = state === "deletion";
  const mayAct = can(ctx, "delete");
  const ends = extended ? extendedUntil : until;
  const files: Row["state"] = gone ? "deleted" : deleting ? "deleting" : "kept";
  const rows: readonly Row[] = [
    {
      what: "Files, plan and package",
      holds: "The sealed files, the approved plan, the package and its report",
      until: gone ? `Deleted ${moment(until)}` : moment(ends),
      rule: `${R.paidDaysFromFirstPackage} days after the package was ready; never after ${moment(hard)}, ${R.paidDaysHardFromCapture} days after the payment`,
      state: files,
    },
    ...(clean
      ? []
      : [
          {
            what: "Import results",
            holds: "The exports your team returned, and their checks",
            until: `${R.importReceiptDaysFromTerminal} days after each check is final`,
            rule: "Or with the project's files, while a stage still needs them",
            state: files,
          },
          {
            what: "Destination settings you confirmed",
            holds: "What your team uploaded and confirmed; never a password or a key",
            until: `Up to ${R.targetMetadataDaysFromLastUse} days after their last use`,
            rule: `Used for a new delivery for ${R.targetExecutionFreshnessDays} days at most`,
            state: "kept" as const,
          },
        ]),
    {
      what: "Financial and legal records",
      holds: "The quote, the order, the payment and the invoice; no CRM content",
      until: "For the period the law requires",
      rule: "Stored apart from CRM content",
      state: "kept",
    },
  ];
  const verdict = gone
    ? `The files, plan and package were deleted on ${moment(until)}.`
    : deleting
      ? `The files, plan and package are being deleted, at ${actor(ctx, "OWNER")}'s request.`
      : extended
        ? `Files, plan and package deleted on ${moment(extendedUntil)}. The one extension is used.`
        : `Files, plan and package deleted on ${moment(until)}, unless you extend once (to ${moment(extendedUntil)}).`;
  return (
    <>
      <ProjectHeader stage="delivery" title="Data and deletion" lead="See what remains and what will be deleted." />
      <p className="kauro-b-verdict">{verdict}</p>
      {deleting ? (
        <Banner tone="info" title={`Deletion requested on ${moment(requestedAt)}`} announce="status">
          <p>The project&apos;s files, package and import results are being deleted from Kauro&apos;s storage, staging and derived files. This page says when it is done, with the deletion record.</p>
        </Banner>
      ) : null}
      {gone ? (
        <Banner tone="neutral" title="The project's files are deleted" announce="status">
          <p>No extension can bring them back. To work on the same data again, start a new project and upload the files.</p>
        </Banner>
      ) : null}
      <section className="kauro-b-section" aria-labelledby="schedule-h">
        <h2 id="schedule-h">What Kauro holds for this project</h2>
        <table className="kauro-rtable kauro-b-schedule">
          <caption className="kauro-visually-hidden">What the project holds and when each kind is deleted</caption>
          <thead>
            <tr>
              <th scope="col">What is kept</th>
              <th scope="col">Until</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.what}>
                <td data-label="">
                  <span className="kauro-b-name-text">{row.what}</span>
                  <span className="kauro-sub">{row.holds}</span>
                </td>
                <td data-label="Until">
                  <span className="kauro-b-cell">
                    {row.until}
                    <span className="kauro-sub">{row.rule}</span>
                  </span>
                </td>
                <td data-label="State" className="kauro-b-nowrap">
                  {row.state === "deleted" ? <Badge tone="neutral">Deleted</Badge> : row.state === "deleting" ? <Badge tone="info">Being deleted</Badge> : <Badge tone="success">Kept</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {gone || deleting ? null : (
        <section className="kauro-b-section" aria-labelledby="actions-h">
          <h2 id="actions-h">More time, or delete now</h2>
          {mayAct ? null : <Only>{onlyLine(ctx, "delete", "extend the dates or delete this project's data")}</Only>}
          <div className="kauro-b-panels">
            <div className="kauro-b-panel">
              <h3>More time</h3>
              {extended ? (
                <p>The extension is used: the files now stay until {moment(extendedUntil)}. A project has one, and none is left.</p>
              ) : (
                <>
                  <p>A project can have one extension, of up to {EXTENSION_HOURS} hours, asked for before {moment(until)}. It never passes {moment(hard)}.</p>
                  <dl className="kauro-b-panel-fact">
                    <div>
                      <dt>New date</dt>
                      <dd>{moment(extendedUntil)}</dd>
                    </div>
                  </dl>
                  {mayAct ? <Button variant="secondary">Extend by 3 days</Button> : null}
                </>
              )}
            </div>
            <div className="kauro-b-panel">
              <h3>Delete now</h3>
              <p>Delete the files, plan, package and import results before their date. Copies already downloaded are not affected.</p>
              <dl className="kauro-b-panel-fact">
                <div>
                  <dt>Can be undone</dt>
                  <dd>No</dd>
                </div>
              </dl>
              {mayAct ? <DeleteNow name={project.name} /> : null}
            </div>
          </div>
        </section>
      )}
      <section className="kauro-b-section" aria-labelledby="residual-h">
        <h2 id="residual-h">What deletion does not reach</h2>
        <ul>
          <li>Copies your team downloaded stay with your team.</li>
          <li>Financial and legal records stay for the period the law requires, apart from CRM content.</li>
          <li>Nothing in your CRM: Kauro never had access to it.</li>
        </ul>
      </section>
    </>
  );
}

/** Early deletion: the project's name typed, then the authenticator code (CMD042 is a step-up command). */
function DeleteNow({ name }: { readonly name: string }): ReactElement {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!asking)
    return (
      <Button variant="secondary" onClick={() => setAsking(true)}>
        Request deletion
      </Button>
    );
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const typed = String(new FormData(event.currentTarget).get("confirm") ?? "").trim();
    setError(typed === name ? null : `Type the project's name exactly: ${name}`);
  };
  return (
    <form className="kauro-b-delete" noValidate onSubmit={submit}>
      <ErrorSummary title="There is a problem" errors={error === null ? [] : [{ fieldId: "delete-confirm", message: error }]} />
      <Field id="delete-confirm" label={`Type the project's name to confirm: ${name}`} hint="You confirm with your authenticator code next." error={error ?? undefined}>
        {(control) => <input {...control} name="confirm" autoComplete="off" spellCheck={false} />}
      </Field>
      <div className="kauro-actions">
        <Button type="submit" variant="danger">
          Delete the project&apos;s data
        </Button>
        <Button onClick={() => setAsking(false)}>Keep the data</Button>
      </div>
    </form>
  );
}
