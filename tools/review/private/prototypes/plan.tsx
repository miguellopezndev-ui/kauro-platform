"use client";
// The plan of the review's project (Order 11), shared by its four pages: Mapping (UI19), Identity (UI20), Relationships (UI21) and Approval
// (UI22). The plan is reviewed as a task list (research: app-ui-patterns.md 3, GOV.UK's task list): the three parts can be reviewed in any
// order and resumed; approval comes last and lists everything, each part with a way back to change it. Every figure is the public site's
// worked example (sample-data.ts): 12,480 contacts and 3,204 companies, 207 duplicate candidate groups of which 200 are unified, 214
// contact rows unified. The plan's body has no read in the api yet: these pages are its visual design (VISUAL PROTOTYPE).
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
const STATE_WORD: Readonly<Record<TaskState, string>> = { done: "Reviewed", review: "To review", blocked: "Blocked", waiting: "After the three parts" };

/** The plan's parts and where each stands; the page's own part is marked as current. */
export function PlanTasks({ ctx, current, states }: { readonly ctx: PrototypeProps["ctx"]; readonly current: PlanTask; readonly states: Readonly<Record<PlanTask, TaskState>> }): ReactElement {
  return (
    <nav className="kauro-plan-tasks" aria-label="The parts of the plan">
      <ol>
        {TASKS.map((task) => (
          <li key={task.key} className={`kauro-plan-task kauro-plan-task--${states[task.key]}${task.key === current ? " is-current" : ""}`}>
            <Link href={appPathOf(task.screen, ctx)} prefetch={false} aria-current={task.key === current ? "page" : undefined}>
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
  unifiedRows: SAMPLE_GROUPS.pairs - SAMPLE_GROUPS.pairsKeptApart + SAMPLE_GROUPS.triples * 2,
  links: 11_906,
  noCompany: 360,
  notFound: 214,
  namesCapitalised: 610,
  emailsLowercased: 1_104,
  emailsInvalid: 37,
});

export const n = (value: number): string => value.toLocaleString("en-US");
