"use client";
// The plan of the review's project (Order 11), shared by its four pages: Mapping (UI19), Identity (UI20), Relationships (UI21) and Approval
// (UI22). The plan is reviewed as a task list (research: app-ui-patterns.md 3, GOV.UK's task list): the three parts can be reviewed in any
// order and resumed; approval comes last and lists everything, each part with a way back to change it. Every figure is the public site's
// worked example (sample-data.ts): 12,480 contacts and 3,204 companies, 207 duplicate candidate groups of which 200 are unified, 214
// contact rows unified; 191 invalid addresses and 1,137 contacts with an empty Company column, as the public sample report measures them.
// What the plan adds on top (how many empty rows were unified away, which named companies are missing) is the review's own invention and
// reconciles: every contact in the output is either linked or listed without a company. The plan's body has no read in the api yet: these
// pages are its visual design (VISUAL PROTOTYPE).
import { SAMPLE_GROUPS } from "@web/public/sample-data.ts";
import Link from "next/link";
import type { ReactElement } from "react";
import { appPathOf, type PrototypeProps } from "../lib/screens.tsx";
import { EXAMPLE } from "./example.ts";

export type PlanTask = "mapping" | "identity" | "relationships" | "approval";
export type TaskState = "done" | "review" | "blocked" | "waiting";

const TASKS: readonly { readonly key: PlanTask; readonly screen: string; readonly name: string }[] = [
  { key: "mapping", screen: "UI19", name: "Fields" },
  { key: "identity", screen: "UI20", name: "Duplicates" },
  { key: "relationships", screen: "UI21", name: "Links between records" },
  { key: "approval", screen: "UI22", name: "Approval" },
];
const STATE_WORD: Readonly<Record<TaskState, string>> = { done: "Reviewed", review: "To review", blocked: "Blocked", waiting: "After the other parts" };

/** The plan's parts and where each stands; the page's own part is marked as current. "Clean your data" has no links between records: its
 * Company column stays a column, and no association is prepared. */
export function PlanTasks({ ctx, project, current, states }: { readonly ctx: PrototypeProps["ctx"]; readonly project: PrototypeProps["project"]; readonly current: PlanTask; readonly states: Readonly<Record<PlanTask, TaskState>> }): ReactElement {
  const tasks = project.mode === "CLEAN" ? TASKS.filter((task) => task.key !== "relationships") : TASKS;
  return (
    <nav className="kauro-plan-tasks" aria-label="The parts of the plan">
      <ol>
        {tasks.map((task) => (
          <li key={task.key} className={`kauro-plan-task kauro-plan-task--${states[task.key]}${task.key === current ? " is-current" : ""}`}>
            <Link href={appPathOf(task.screen, ctx, project.projectId)} prefetch={false} aria-current={task.key === current ? "page" : undefined}>
              <span className="kauro-plan-task-name">{task.name}</span>
              <span className="kauro-plan-task-state">{task.key === "approval" && states[task.key] === "done" ? "Approved" : STATE_WORD[states[task.key]]}</span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

const groups = SAMPLE_GROUPS.pairs + SAMPLE_GROUPS.triples;
const unifiedRows = SAMPLE_GROUPS.pairs - SAMPLE_GROUPS.pairsKeptApart + SAMPLE_GROUPS.triples * 2;
/** Of the contacts with an empty Company column: rows unified into a record, and kept rows that took the company of a row unified into them. */
const EMPTY_UNIFIED = 61;
const EMPTY_FILLED = 18;
const emptyCompany = EXAMPLE.report.noCompany - EMPTY_UNIFIED - EMPTY_FILLED;
/** Contacts whose Company names a company that companies.xlsx does not hold (the Relationships page lists them). */
const NOT_FOUND = 163;
const output = EXAMPLE.contacts - unifiedRows;
/** The plan's figures, as one record: every page of the plan reads the same numbers. */
export const PLAN = Object.freeze({
  contacts: EXAMPLE.contacts,
  companies: EXAMPLE.companies,
  groups,
  pairs: SAMPLE_GROUPS.pairs,
  triples: SAMPLE_GROUPS.triples,
  groupContacts: SAMPLE_GROUPS.pairs * 2 + SAMPLE_GROUPS.triples * 3,
  unifyGroups: groups - SAMPLE_GROUPS.pairsKeptApart,
  keptApart: SAMPLE_GROUPS.pairsKeptApart,
  unifiedRows,
  output,
  emptySource: EXAMPLE.report.noCompany,
  emptyUnified: EMPTY_UNIFIED,
  emptyFilled: EMPTY_FILLED,
  emptyCompany,
  notFound: NOT_FOUND,
  noCompany: emptyCompany + NOT_FOUND,
  links: output - emptyCompany - NOT_FOUND,
  namesCapitalised: 610,
  emailsLowercased: 1_104,
  emailsInvalid: EXAMPLE.report.emailsInvalid,
});

export const n = (value: number): string => value.toLocaleString("en-US");
