"use client";
// UI20 Identity, shown as "Duplicates" (registry: "Similarity is a signal; merging needs a decision."; Order 11 round 2, research
// agency-workspace.md §3.4 and §5.9; the owner's decision of Orders 11–12 on batch unification). The candidate groups of contacts.csv (207
// groups holding 428 contacts, found in every row) are decided by the team in three ways, and the page never mixes them up:
//   - Demonstrated identities (the same email address and the same name) may be applied together, but only the groups that no blocking
//     conflict touches, and only after an exact preview of the effects, the exclusions and the conflicts;
//   - Probable duplicates (every other class) may be reviewed, selected and decided many at once (by class, by page or one by one), with
//     the same preview; such a decision is recorded as decided by the person who made it and is never labelled a demonstrated identity;
//   - A group with a blocking conflict (two records that already exist apart in the CRM, an address shared by different people) is kept
//     out of every batch and decided on its own, with its reason and the action that resolves it.
// Every decision is a draft of the plan until the plan is approved: it can be undone or changed before then, and the record of who decided
// what, when, on which evidence, is kept (after an approval, a change makes a new revision: see Approval). Nothing is written to any CRM: the
// decisions shape the files Kauro prepares, and the import is the customer's. One progress line always adds up to the 207 groups.
import { Banner, Button, type Tone } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { moment, Only, ScreenButton } from "./kit.tsx";
import { can, onlyLine } from "./people.ts";
import { BLOCKED, CLASSES, deciders, type EvidenceClass, n, PLAN, PlanTasks, tasksFor, traceOf } from "./plan.tsx";
import { SERVICE } from "./service.ts";

export const UI20_STATES: readonly StateDef[] = [
  { key: "normal", label: "Probable duplicates, many at once", note: "(b) The 138 demonstrated identities are applied. The probable groups are listed with checkboxes: select by class, by page or one by one; the preview gives the exact effects, exclusions and conflicts; one action decides them, recorded as decided by the person, never as demonstrated." },
  { key: "demonstrated", label: "Demonstrated identities, applied together", note: "(a) Nothing decided yet. The 138 groups with the same email address and the same name and no blocking conflict can be applied together; the exact preview of effects, exclusions (3 groups) and conflicts comes before the button." },
  { key: "blocked", label: "A blocking conflict", note: "(c) Group 7 is kept out of every batch: both rows already exist as separate records in HubSpot. The page gives the reason and the actions; the other four blocked groups are listed with theirs." },
  { key: "changed", label: "A batch decision changed", note: "(d) Before approval, one group of the batch of 36 is taken out and kept apart: the trace keeps the batch, the change, who and when; the batch can still be undone as a whole." },
  { key: "decided", label: "All decided", note: "Every group is decided: 200 unified, 7 kept apart, with the full record of who decided what, when and on which evidence. Duplicates is completed." },
];

/** One row of the selectable list: a group of probable duplicates. */
interface Row {
  readonly group: number;
  readonly records: string;
  readonly differs: string;
  readonly companyFilled: boolean;
  readonly consent: boolean;
}

const FIRST = ["Hana", "Ravi", "Lucia", "Tomas", "Greta", "Idris", "Mei", "Oskar", "Zara", "Felix", "Nadia", "Bruno", "Elif", "Jonas", "Amara", "Viktor", "Leila", "Mateo", "Sanna", "Theo"];
const LAST = ["Kato", "Mehta", "Ferraro", "Vidal", "Lund", "Bakr", "Tanaka", "Strand", "Osei", "Roth", "Haddad", "Costa", "Aydin", "Weber", "Nwosu", "Petrov", "Farah", "Rojas", "Virta", "Blake"];
/** Page 1 of "same email address, name spelt differently", as the check found it. */
const SPELLING_PAGE_ONE: readonly Row[] = [
  { group: 142, records: "Maria Lopez · M. Lopez — m.lopez@example.com", differs: "Name spelt differently", companyFilled: true, consent: false },
  { group: 143, records: "Jonathan Ames · Jon Ames — j.ames@example.net", differs: "Name spelt differently", companyFilled: false, consent: false },
  { group: 144, records: "Sofia Brandt · Sofia Brand — s.brandt@example.com", differs: "Name spelt differently", companyFilled: false, consent: false },
  { group: 145, records: "Daniel Okoye · Dan Okoye — d.okoye@example.org", differs: "Name spelt differently", companyFilled: false, consent: false },
  { group: 146, records: "Hannah Weiss · H. Weiss — h.weiss@example.com", differs: "Name spelt differently; company in one row only", companyFilled: true, consent: false },
  { group: 147, records: "Rafael Souza · Rafael Sousa — r.souza@example.net", differs: "Name spelt differently", companyFilled: false, consent: false },
  { group: 148, records: "Ingrid Holm · Ingrid Holm-Berg — i.holm@example.com", differs: "Name spelt differently", companyFilled: false, consent: false },
  { group: 149, records: "Yusuf Demir · Yusef Demir — y.demir@example.org", differs: "Name spelt differently; marketing consent differs", companyFilled: false, consent: true },
  { group: 150, records: "Chloe Martin · Chloé Martin — c.martin@example.com", differs: "Accent differs", companyFilled: false, consent: false },
  { group: 152, records: "Ethan Brooks · E. Brooks — e.brooks@example.net", differs: "Name spelt differently; marketing consent differs", companyFilled: false, consent: true },
];
/** Of the 36 selectable groups of that class: the kept records that take the company of the row that joins, and the consent conflicts. */
const SPELLING_TOTALS = { companyFilled: 7, consent: 2 };

/** The selectable groups of a class (its groups less those a blocking conflict keeps out), page by page; synthetic names beyond page 1. */
function rowsOf(one: EvidenceClass): readonly Row[] {
  const blocked = new Set(BLOCKED.filter((group) => group.classKey === one.key).map((group) => group.group));
  const numbers = Array.from({ length: one.groups }, (_, index) => one.first + index).filter((group) => !blocked.has(group));
  return numbers.map((group, index) => {
    if (one.key === "email-spelling" && index < SPELLING_PAGE_ONE.length) return SPELLING_PAGE_ONE[index] as Row;
    if (one.key === "name-phone" && group === 188) return { group, records: "Ana Ruiz · Ana Ruiz — +44 20 7946 0958", differs: "Email addresses differ; company in one row only", companyFilled: false, consent: false };
    const first = FIRST[(group * 7) % FIRST.length] ?? "Alex";
    const last = LAST[(group * 3) % LAST.length] ?? "Doe";
    const handle = `${first.toLowerCase()}.${last.toLowerCase()}`;
    if (one.key === "three") return { group, records: `${first} ${last} ×3 — ${handle}@example.org`, differs: "Three rows: phone or company in some rows only", companyFilled: false, consent: false };
    if (one.key === "name-phone") return { group, records: `${first} ${last} · ${first} ${last} — +44 20 7946 0${String(100 + group).slice(-3)}`, differs: "Email addresses differ", companyFilled: false, consent: false };
    return { group, records: `${first} ${last} · ${first[0] ?? ""}. ${last} — ${handle}@example.com`, differs: "Name spelt differently", companyFilled: false, consent: false };
  });
}

const PAGE = 10;
type Phase = "demonstrated" | "normal" | "blocked" | "changed" | "decided";

/** What each class stands at in a state of the review (applied together, decided together, one by one, or not yet). */
function startOf(state: Phase): { readonly applied: boolean; readonly decided: ReadonlySet<EvidenceClass["key"]>; readonly blockedDone: number; readonly changed: boolean } {
  switch (state) {
    case "demonstrated":
      return { applied: false, decided: new Set(), blockedDone: 0, changed: false };
    case "normal":
      return { applied: true, decided: new Set(), blockedDone: 0, changed: false };
    case "changed":
      return { applied: true, decided: new Set(["email-spelling"]), blockedDone: 0, changed: true };
    case "blocked":
      return { applied: true, decided: new Set(["email-spelling", "three"]), blockedDone: 0, changed: true };
    case "decided":
      return { applied: true, decided: new Set(["email-spelling", "three", "name-phone"]), blockedDone: BLOCKED.length, changed: true };
  }
}

export function Identity({ ctx, state, project }: PrototypeProps): ReactElement {
  const phase: Phase = (["demonstrated", "normal", "blocked", "changed", "decided"] as const).find((one) => one === state) ?? "normal";
  const start = startOf(phase);
  const editor = can(ctx, "operate");
  const who = deciders(ctx);
  const crm = SERVICE[project.mode].destination ?? "your CRM";
  const demonstrated = CLASSES[0];
  const eligible = demonstrated.groups - demonstrated.blocked;

  const [applied, setApplied] = useState(start.applied);
  const [decided, setDecided] = useState<ReadonlyMap<EvidenceClass["key"], { readonly unify: number; readonly apart: number; readonly by: string }>>(
    new Map(
      [...start.decided].map((key) => {
        const one = CLASSES.find((candidate) => candidate.key === key);
        const selectable = (one?.groups ?? 0) - (one?.blocked ?? 0);
        const apart = key === "email-spelling" && start.changed ? 1 : key === "name-phone" ? 1 : 0;
        return [key, { unify: selectable - apart, apart, by: who.operator }];
      }),
    ),
  );
  const [blockedDone, setBlockedDone] = useState(start.blockedDone);
  const [changedBack, setChangedBack] = useState(false);
  const open = CLASSES.filter((one) => one.identity === "probable" && !decided.has(one.key));
  const [classKey, setClassKey] = useState<EvidenceClass["key"]>(open[0]?.key ?? "email-spelling");
  const current = CLASSES.find((one) => one.key === classKey) ?? CLASSES[1];
  const rows = rowsOf(current);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [lastBatch, setLastBatch] = useState<string | null>(null);
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);

  // the progress line: every group is unified, kept apart or left to decide, and the three always add up to 207
  const fromClasses = [...decided.values()].reduce((sum, one) => ({ unify: sum.unify + one.unify, apart: sum.apart + one.apart }), { unify: 0, apart: 0 });
  const changeApart = start.changed && changedBack ? -1 : 0;
  const unify = (applied ? eligible : 0) + fromClasses.unify - changeApart;
  const apart = fromClasses.apart + blockedDone + changeApart;
  const left = PLAN.groups - unify - apart;
  const reviewed = left === 0;
  const status: { readonly tone: Tone; readonly text: string } = reviewed ? { tone: "success", text: "Duplicates decided" } : { tone: "info", text: "Plan in review" };
  const next = project.mode === "CLEAN" ? { to: "UI22", label: "Continue to approval" } : { to: "UI21", label: "Continue to links between records" };
  const blockedOpen = phase === "blocked" && blockedDone === 0;

  // the exact preview of a batch of probable groups
  const all = selected.size === rows.length;
  const picked = rows.filter((row) => selected.has(row.group));
  const filled = all && current.key === "email-spelling" ? SPELLING_TOTALS.companyFilled : picked.filter((row) => row.companyFilled).length;
  const consent = all && current.key === "email-spelling" ? SPELLING_TOTALS.consent : picked.filter((row) => row.consent).length;
  const perGroup = current.key === "three" ? 3 : 2;
  const decide = (how: "unify" | "apart"): void => {
    const count = selected.size;
    setDecided((old) => {
      const copy = new Map(old);
      const before = copy.get(current.key) ?? { unify: 0, apart: 0, by: who.operator };
      copy.set(current.key, { unify: before.unify + (how === "unify" ? count : 0), apart: before.apart + (how === "apart" ? count : 0), by: who.operator });
      return copy;
    });
    setLastBatch(`${n(count)} ${count === 1 ? "group" : "groups"} of "${current.evidence.toLowerCase()}" ${how === "unify" ? "unified" : "kept apart"}: decided together by ${who.operator}. Recorded as probable duplicates decided by a person.`);
    setSelected(new Set());
    const remaining = open.filter((one) => one.key !== current.key);
    if (remaining[0] !== undefined) setClassKey(remaining[0].key);
    setPage(0);
  };
  const trace = traceOf(who.owner, who.operator);
  const traceShown = phase === "decided" ? trace : phase === "blocked" ? trace.slice(0, 4) : phase === "changed" ? trace.slice(0, 3) : phase === "normal" ? trace.slice(0, 1) : [];

  return (
    <>
      <ProjectHeader stage="plan" title="Duplicates" lead="Kauro groups records that may be the same person. A group is a signal: nothing is unified without your team's decision." status={status} />
      <PlanTasks ctx={ctx} project={project} current="identity" states={tasksFor("identity", reviewed, project.mode)} />
      <p className="kauro-pl-progress">
        <span>
          {n(PLAN.groups)} candidate groups holding {n(PLAN.groupContacts)} contacts, found in all {n(PLAN.contacts)} rows of contacts.csv:
        </span>{" "}
        <strong>
          {n(unify)} to unify · {n(apart)} kept apart · {n(left)} left to decide
        </strong>
      </p>
      <p className="kauro-pl-meta kauro-pl-crm">Nothing here is written to {crm} or to any other CRM. These decisions shape the files Kauro prepares; the import is your team&apos;s, with its own tools.</p>

      <section className="kauro-pl-section" aria-labelledby="demonstrated-h">
        <h2 id="demonstrated-h">Demonstrated identities</h2>
        <p>
          {demonstrated.evidence}, after spaces and capitals are made consistent: {n(demonstrated.groups)} groups, {n(demonstrated.contacts)} contacts. The {n(eligible)} that no blocking conflict touches can be
          applied together.
        </p>
        {applied ? (
          <div className="kauro-pl-applied">
            <p>
              <strong>
                {n(eligible)} groups applied together: unified.
              </strong>{" "}
              {phase === "demonstrated" ? `By ${ctx.who.split(",")[0] ?? who.owner}, just now` : `By ${who.owner} on ${moment("2026-10-20T11:40:00Z")}`} · demonstrated identity · {n(demonstrated.blocked)} groups kept out.
            </p>
            {editor ? (
              <button type="button" className="kauro-pl-link" onClick={() => setApplied(false)}>
                Undo the batch of {n(eligible)}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="kauro-pl-preview" aria-labelledby="preview-demonstrated-h">
            <h3 id="preview-demonstrated-h">Preview: unify {n(eligible)} groups</h3>
            <dl>
              <div>
                <dt>Effects</dt>
                <dd>
                  {n(eligible * 2)} contacts become {n(eligible)}; {n(eligible)} rows join the row they match, each listed in the report with the row it joined. 11 kept records take the company of the row
                  that joins; nothing else changes value.
                </dd>
              </div>
              <div>
                <dt>Exclusions</dt>
                <dd>
                  {n(demonstrated.blocked)} groups of this class are kept out: both rows already exist as separate records in {crm} (groups {BLOCKED.filter((one) => one.classKey === "email-name").map((one) => one.group).join(", ")}). Each is decided on its own, below.
                </dd>
              </div>
              <div>
                <dt>Conflicts</dt>
                <dd>No blocking conflict among the {n(eligible)}. The phone differs in 9 groups (the kept record&apos;s phone is used; the other is listed) and marketing consent in 4 (the most restrictive choice is kept).</dd>
              </div>
              <div>
                <dt>Until approval</dt>
                <dd>The batch can be undone or any group changed. After an approval, a change makes a new revision of the plan, to validate and approve again.</dd>
              </div>
            </dl>
            {editor ? (
              <div className="kauro-pl-preview-actions">
                <Button variant="primary" onClick={() => setApplied(true)}>
                  Apply to {n(eligible)} groups
                </Button>
                <details className="kauro-pl-samples">
                  <summary>See 3 of these groups</summary>
                  <ul>
                    {demonstrated.samples.map((sample) => (
                      <li key={sample}>{sample}</li>
                    ))}
                  </ul>
                </details>
              </div>
            ) : (
              <Only>{onlyLine(ctx, "operate", "apply the demonstrated identities")}</Only>
            )}
          </div>
        )}
      </section>

      <section className="kauro-pl-section" aria-labelledby="probable-h">
        <h2 id="probable-h">Probable duplicates</h2>
        <p>
          Every other class is a probable duplicate. Review, select and decide many groups at once: a decision here is recorded under the name of the person who makes it, and is never counted as a
          demonstrated identity.
        </p>
        {lastBatch === null ? null : (
          <p className="kauro-pl-batch-done" role="status">
            {lastBatch}
          </p>
        )}
        <ul className="kauro-pl-classlist">
          {CLASSES.filter((one) => one.identity === "probable").map((one) => {
            const done = decided.get(one.key);
            return (
              <li key={one.key}>
                <span className="kauro-pl-classlist-name">{one.evidence}</span>
                <span className="kauro-pl-classlist-count">
                  {n(one.groups - one.blocked)} groups{one.blocked > 0 ? ` (${n(one.blocked)} more kept out)` : ""}
                </span>
                <span className="kauro-pl-classlist-state">
                  {done === undefined ? "Not decided" : `${n(done.unify)} unified${done.apart > 0 ? `, ${n(done.apart)} kept apart` : ""} · by ${done.by}`}
                </span>
              </li>
            );
          })}
        </ul>
        {open.length === 0 ? (
          <p className="kauro-pl-meta">Every probable group is decided.</p>
        ) : !editor ? (
          <Only>{onlyLine(ctx, "operate", "decide duplicates")}</Only>
        ) : (
          <div className="kauro-pl-picker">
            <div className="kauro-pl-picker-bar">
              <label className="kauro-pl-picker-class">
                <span>Class</span>
                <select
                  value={current.key}
                  onChange={(event) => {
                    setClassKey(event.target.value as EvidenceClass["key"]);
                    setSelected(new Set());
                    setPage(0);
                  }}
                >
                  {open.map((one) => (
                    <option key={one.key} value={one.key}>
                      {one.evidence} ({n(one.groups - one.blocked)})
                    </option>
                  ))}
                </select>
              </label>
              <span className="kauro-pl-picker-select">
                <button type="button" className="kauro-pl-link" onClick={() => setSelected(new Set(rows.map((row) => row.group)))}>
                  Select all {n(rows.length)} in this class
                </button>
                <button type="button" className="kauro-pl-link" onClick={() => setSelected((old) => new Set([...old, ...shown.map((row) => row.group)]))}>
                  Select this page ({n(shown.length)})
                </button>
                {selected.size > 0 ? (
                  <button type="button" className="kauro-pl-link" onClick={() => setSelected(new Set())}>
                    Clear the selection
                  </button>
                ) : null}
              </span>
            </div>
            <table className="kauro-rtable kauro-pl-rtable kauro-pl-groups">
              <caption className="kauro-visually-hidden">
                {current.evidence}: page {page + 1} of {pages}, {n(selected.size)} selected
              </caption>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="kauro-visually-hidden">Selected</span>
                  </th>
                  <th scope="col">Group</th>
                  <th scope="col">Records</th>
                  <th scope="col">What differs</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.group} className={selected.has(row.group) ? "is-selected" : undefined}>
                    <td data-label="">
                      <input
                        type="checkbox"
                        className="kauro-pl-check"
                        aria-label={`Select group ${row.group}`}
                        checked={selected.has(row.group)}
                        onChange={(event) => {
                          const on = event.target.checked;
                          setSelected((old) => {
                            const copy = new Set(old);
                            if (on) copy.add(row.group);
                            else copy.delete(row.group);
                            return copy;
                          });
                        }}
                      />
                    </td>
                    <th scope="row">{row.group}</th>
                    <td data-label="Records">{row.records}</td>
                    <td data-label="What differs">{row.differs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="kauro-pl-pages">
              <span>
                Page {page + 1} of {pages} · {PAGE} groups a page · {n(selected.size)} of {n(rows.length)} selected
              </span>
              {page > 0 ? (
                <button type="button" className="kauro-pl-link" onClick={() => setPage(page - 1)}>
                  Previous page
                </button>
              ) : null}
              {page < pages - 1 ? (
                <button type="button" className="kauro-pl-link" onClick={() => setPage(page + 1)}>
                  Next page
                </button>
              ) : null}
            </p>
            {selected.size === 0 ? (
              <p className="kauro-pl-meta">Select groups to see the exact effect before deciding them.</p>
            ) : (
              <div className="kauro-pl-preview" aria-labelledby="preview-probable-h">
                <h3 id="preview-probable-h">
                  Preview: {n(selected.size)} selected {selected.size === 1 ? "group" : "groups"} of probable duplicates
                </h3>
                <dl>
                  <div>
                    <dt>If unified</dt>
                    <dd>
                      {n(selected.size * perGroup)} contacts become {n(selected.size)}; {n(selected.size * (perGroup - 1))} rows join another record, each listed with the row it joined. The kept
                      record&apos;s {current.key === "name-phone" ? "email address" : "name"} is used and the other is listed in the report.{filled > 0 ? ` ${n(filled)} kept ${filled === 1 ? "record takes" : "records take"} the company of the row that joins.` : ""}
                    </dd>
                  </div>
                  <div>
                    <dt>If kept apart</dt>
                    <dd>{n(selected.size * perGroup)} contacts are prepared as they are, and each group is listed in the report as kept apart.</dd>
                  </div>
                  <div>
                    <dt>Exclusions</dt>
                    <dd>{current.blocked === 0 ? "None: no group of this class has a blocking conflict." : `${n(current.blocked)} groups of this class cannot be selected: an address shared by different people (groups ${BLOCKED.filter((one) => one.classKey === current.key).map((one) => one.group).join(", ")}).`}</dd>
                  </div>
                  <div>
                    <dt>Conflicts</dt>
                    <dd>No blocking conflict among the selected.{consent > 0 ? ` Marketing consent differs in ${n(consent)}: the most restrictive choice is kept.` : ""}</dd>
                  </div>
                </dl>
                <div className="kauro-pl-preview-actions">
                  {blockedOpen ? (
                    <Button variant="secondary" onClick={() => decide("unify")}>
                      Unify the {n(selected.size)} selected
                    </Button>
                  ) : (
                    <Button variant="primary" onClick={() => decide("unify")}>
                      Unify the {n(selected.size)} selected
                    </Button>
                  )}
                  <Button variant="secondary" onClick={() => decide("apart")}>
                    Keep the {n(selected.size)} selected apart
                  </Button>
                </div>
                <p className="kauro-pl-meta">Recorded as decided by {who.operator}, with the time and the class. You can change any group until the plan is approved.</p>
              </div>
            )}
          </div>
        )}
        {phase === "changed" || phase === "blocked" || phase === "decided" ? (
          <div className="kauro-pl-applied kauro-pl-changed">
            <p>
              <strong>Group 171 taken out of the batch of 36 and kept apart</strong> by {who.operator} on {moment("2026-10-20T11:58:00Z")}: &ldquo;Two people at Osprey Freight share r.costa@example.com.&rdquo;
              The batch stays in the record as it was decided; the change is recorded beside it.
            </p>
            {editor && phase === "changed" ? (
              <span className="kauro-pl-applied-actions">
                <button type="button" className="kauro-pl-link" onClick={() => setChangedBack((old) => !old)}>
                  {changedBack ? "Keep group 171 apart again" : "Unify group 171 again"}
                </button>
                <button
                  type="button"
                  className="kauro-pl-link"
                  onClick={() =>
                    setDecided((old) => {
                      const copy = new Map(old);
                      copy.delete("email-spelling");
                      return copy;
                    })
                  }
                >
                  Undo the batch of 36
                </button>
              </span>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="kauro-pl-section" aria-labelledby="blocked-h">
        <h2 id="blocked-h">Kept out of every batch</h2>
        <p>A blocking conflict keeps a group out of any batch, whatever its evidence. Each is decided on its own.</p>
        <table className="kauro-rtable kauro-pl-rtable kauro-pl-blocked">
          <caption className="kauro-visually-hidden">Groups with a blocking conflict, the reason and the action</caption>
          <thead>
            <tr>
              <th scope="col">Group</th>
              <th scope="col">Records</th>
              <th scope="col">Why it is kept out</th>
              <th scope="col">Decision</th>
            </tr>
          </thead>
          <tbody>
            {BLOCKED.map((one, index) => (
              <tr key={one.group}>
                <th scope="row">{one.group}</th>
                <td data-label="Records">{one.records}</td>
                <td data-label="Why it is kept out">
                  <span>
                    {one.reason.replace("HubSpot", crm)}
                    <span className="kauro-sub">{one.action.replace("HubSpot", crm)}</span>
                  </span>
                </td>
                <td data-label="Decision">{index < blockedDone ? `Kept apart by ${who.operator}` : "Not decided"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {blockedOpen ? (
          <div className="kauro-pl-blockgroup">
            <h3>Group 7: kept out of every batch</h3>
            <Banner tone="warning" title={`Both rows already exist as separate records in ${crm}`}>
              <p>
                Rows 1,904 and 8,377 carry {crm} Record IDs 4021 and 7710. Unifying them in the files would leave two records in {crm} and could make the import update the wrong one. Kauro never
                merges or changes records in {crm}.
              </p>
            </Banner>
            <table className="kauro-pl-compare">
              <caption className="kauro-visually-hidden">The two records of group 7, field by field</caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Row 1,904</th>
                  <th scope="col">Row 8,377</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Name</th>
                  <td data-label="Row 1,904">Noor Saleh</td>
                  <td data-label="Row 8,377">Noor Saleh</td>
                </tr>
                <tr>
                  <th scope="row">Email</th>
                  <td data-label="Row 1,904">n.saleh@example.com</td>
                  <td data-label="Row 8,377">n.saleh@example.com</td>
                </tr>
                <tr className="is-conflict">
                  <th scope="row">{crm} Record ID</th>
                  <td data-label="Row 1,904">4021</td>
                  <td data-label="Row 8,377">7710</td>
                </tr>
              </tbody>
            </table>
            {editor ? (
              <div className="kauro-pl-decide">
                <Button variant="primary" onClick={() => setBlockedDone(1)}>
                  Keep them apart
                </Button>
                <span className="kauro-pl-meta">To unify them instead, merge the two records in {crm} yourselves, export again and upload the new file: the next check finds one record.</span>
              </div>
            ) : (
              <Only>{onlyLine(ctx, "operate", "decide this group")}</Only>
            )}
          </div>
        ) : null}
      </section>

      {traceShown.length === 0 && !applied ? null : (
        <section className="kauro-pl-section" aria-labelledby="trace-h">
          <h2 id="trace-h">Decisions and who made them</h2>
          <table className="kauro-rtable kauro-pl-rtable kauro-pl-trace">
            <caption className="kauro-visually-hidden">Every decision on the duplicates of revision {PLAN.revision}, oldest first</caption>
            <thead>
              <tr>
                <th scope="col">When (UTC)</th>
                <th scope="col">Who</th>
                <th scope="col">Decision</th>
                <th scope="col">Evidence</th>
                <th scope="col" className="kauro-num">
                  Groups
                </th>
              </tr>
            </thead>
            <tbody>
              {(traceShown.length === 0 ? trace.slice(0, 1) : traceShown).map((line) => (
                <tr key={`${line.at}-${line.what}`}>
                  <th scope="row">{phase === "demonstrated" ? "Just now" : moment(line.at).replace(" UTC", "")}</th>
                  <td data-label="Who">{line.who}</td>
                  <td data-label="Decision">{line.what}</td>
                  <td data-label="Evidence">{line.evidence}</td>
                  <td data-label="Groups" className="kauro-num">
                    {n(line.groups)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="kauro-pl-meta">This record stays with the plan. A later revision keeps it and adds its own; an undo is recorded as an undo, never erased.</p>
        </section>
      )}

      {reviewed && editor ? (
        <div className="kauro-actions">
          <ScreenButton to={next.to} ctx={ctx} project={project.projectId} variant="primary">
            {next.label}
          </ScreenButton>
        </div>
      ) : null}
    </>
  );
}
