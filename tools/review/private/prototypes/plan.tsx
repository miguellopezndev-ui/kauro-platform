"use client";
// The plan of the review's project (Order 11 round 2), shared by its four pages: Fields (UI19), Duplicates (UI20), Links between records
// (UI21) and Approval (UI22), and by the health check results (P-07) that lead into it. Every figure any of these pages shows is in PLAN, so
// a count reads the same on every page (research agency-workspace.md §1.3, C-2 to C-4: the duplicates did not add up, Approval disagreed with
// Duplicates, and the contacts without a company went up between the check and the plan without a word).
//
// The figures are the public site's worked example (sample-data.ts): 12,480 contacts and 3,204 companies; 207 candidate groups (193 pairs,
// 14 groups of three) holding 428 contacts, of which 200 groups are unified and 7 pairs kept apart, so 214 contact rows join another record;
// 253 company rows join another company; 191 invalid addresses; 1,137 contacts with an empty Company column. What the plan adds is the
// review's own synthetic detail and reconciles exactly: the four evidence classes add up to 207 groups and 428 contacts; of the 1,137
// contacts without a company, 61 are unified into another record and 18 take a duplicate's company, so 1,058 stay without one; another 163
// name a company companies.xlsx does not hold; every one of the 12,266 contacts prepared is either linked (11,045) or listed without a company
// (1,221).
//
// The plan's parts are a GOV.UK task list inside stage 3 (research §5.8), not a second stepper beside the project's six stages: each part
// says Completed, Incomplete or Cannot start yet, and the whole row is the link. The plan's body has no read in the api yet: these pages are
// its visual design.
import { SAMPLE_GROUPS } from "@web/public/sample-data.ts";
import Link from "next/link";
import type { ReactElement } from "react";
import { appPathOf, type PrototypeProps } from "../lib/screens.tsx";
import { EXAMPLE } from "./example.ts";

export type PlanTask = "mapping" | "identity" | "relationships" | "approval";
/** GOV.UK's task statuses: done, still to do, or waiting on the other parts; plus "approved" for the last part once it is. */
export type TaskState = "completed" | "incomplete" | "cannot" | "approved";

const TASKS: readonly { readonly key: PlanTask; readonly screen: string; readonly name: string }[] = [
  { key: "mapping", screen: "UI19", name: "Fields" },
  { key: "identity", screen: "UI20", name: "Duplicates" },
  { key: "relationships", screen: "UI21", name: "Links between records" },
  { key: "approval", screen: "UI22", name: "Approval" },
];
const STATE_WORD: Readonly<Record<TaskState, string>> = { completed: "Completed", incomplete: "Incomplete", cannot: "Cannot start yet", approved: "Approved" };

/** The parts of the plan and where each stands; the page's own part is marked. "Clean your data" prepares no links between records. */
export function PlanTasks({ ctx, project, current, states }: { readonly ctx: PrototypeProps["ctx"]; readonly project: PrototypeProps["project"]; readonly current: PlanTask; readonly states: Readonly<Record<PlanTask, TaskState>> }): ReactElement {
  const tasks = project.mode === "CLEAN" ? TASKS.filter((task) => task.key !== "relationships") : TASKS;
  const done = tasks.filter((task) => task.key !== "approval" && states[task.key] === "completed").length;
  const parts = tasks.length - 1;
  return (
    <nav className="kauro-pl-tasks" aria-labelledby="plan-tasks-h">
      <p className="kauro-pl-tasks-head" id="plan-tasks-h">
        The plan, revision {PLAN.revision} · {done} of {parts} parts reviewed
      </p>
      <ol>
        {tasks.map((task) => {
          const state = states[task.key];
          const here = task.key === current;
          const body = (
            <>
              <span className="kauro-pl-task-name">{task.name}</span>
              <span className={`kauro-pl-tag kauro-pl-tag--${state}`}>{STATE_WORD[state]}</span>
            </>
          );
          return (
            <li key={task.key} className={here ? "kauro-pl-task is-current" : "kauro-pl-task"}>
              {state === "cannot" && !here ? (
                <span className="kauro-pl-task-row">{body}</span>
              ) : (
                <Link className="kauro-pl-task-row" href={appPathOf(task.screen, ctx, project.projectId)} prefetch={false} aria-current={here ? "page" : undefined}>
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Where each part stands for a page in one of its states (the parts before the page are completed when the page is reviewed). */
export function tasksFor(page: PlanTask, reviewed: boolean, mode: PrototypeProps["project"]["mode"]): Readonly<Record<PlanTask, TaskState>> {
  const order: PlanTask[] = mode === "CLEAN" ? ["mapping", "identity", "approval"] : ["mapping", "identity", "relationships", "approval"];
  const at = order.indexOf(page);
  const result: Record<PlanTask, TaskState> = { mapping: "incomplete", identity: "incomplete", relationships: mode === "CLEAN" ? "completed" : "incomplete", approval: "cannot" };
  for (const [index, key] of order.entries()) {
    if (key === "approval") continue;
    result[key] = index < at || (index === at && reviewed) ? "completed" : "incomplete";
  }
  const allReviewed = order.filter((key) => key !== "approval").every((key) => result[key] === "completed");
  result.approval = page === "approval" && reviewed ? "approved" : allReviewed ? "incomplete" : "cannot";
  return result;
}

/** The evidence classes of the contact duplicate groups (research §5.9): the reason Kauro grouped them, how strong it is, and how many. */
export const CLASSES = [
  { key: "email-name", evidence: "Same email address and same name", groups: 141, contacts: 282, bulk: true, samples: ["Leo Grant · Leo Grant — leo.grant@example.net", "Mia Chen · Mia Chen — mia.chen@example.com", "Omar Haddad · Omar Haddad — o.haddad@example.org"] },
  { key: "email-spelling", evidence: "Same email address, name spelt differently", groups: 38, contacts: 76, bulk: true, samples: ["Maria Lopez · M. Lopez — m.lopez@example.com", "Jonathan Ames · Jon Ames — j.ames@example.net", "Sofia Brandt · Sofia Brand — s.brandt@example.com"] },
  { key: "name-phone", evidence: "Same name and phone, email missing or different", groups: 14, contacts: 28, bulk: false, samples: [] },
  { key: "three", evidence: "Groups of three records", groups: 14, contacts: 42, bulk: false, samples: [] },
] as const;

const groups = SAMPLE_GROUPS.pairs + SAMPLE_GROUPS.triples;
const unifiedRows = SAMPLE_GROUPS.pairs - SAMPLE_GROUPS.pairsKeptApart + SAMPLE_GROUPS.triples * 2;
if (CLASSES.reduce((sum, one) => sum + one.groups, 0) !== groups) throw new Error("the evidence classes do not add up to the candidate groups");
if (CLASSES.reduce((sum, one) => sum + one.contacts, 0) !== EXAMPLE.report.inGroups) throw new Error("the evidence classes do not add up to the contacts in groups");
/** Of the contacts with an empty Company column: rows unified into a record, and kept rows that took the company of a row unified into them. */
const EMPTY_UNIFIED = 61;
const EMPTY_FILLED = 18;
const emptyCompany = EXAMPLE.report.noCompany - EMPTY_UNIFIED - EMPTY_FILLED;
/** Contacts whose Company names a company that companies.xlsx does not hold (the Links page lists them). */
const NOT_FOUND = 163;
const output = EXAMPLE.contacts - unifiedRows;
/** Contacts the check counted in two of its findings (a review value): the findings' sum is not the number of contacts affected. */
const COUNTED_TWICE = 173;
/** The one-by-one groups (the two weak classes) decided so far in the review's "in progress" state, and how. */
const ONE_BY_ONE = 28;
const ONE_BY_ONE_DECIDED = { unified: 4, apart: 3 };

/** The plan's figures, as one record: every page of the plan reads the same numbers. */
export const PLAN = Object.freeze({
  revision: 6,
  contacts: EXAMPLE.contacts,
  companies: EXAMPLE.companies,
  groups,
  pairs: SAMPLE_GROUPS.pairs,
  triples: SAMPLE_GROUPS.triples,
  groupContacts: EXAMPLE.report.inGroups,
  unifyGroups: groups - SAMPLE_GROUPS.pairsKeptApart,
  keptApart: SAMPLE_GROUPS.pairsKeptApart,
  unifiedRows,
  companiesUnified: 253,
  companiesOutput: EXAMPLE.companies - 253,
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
  columnsDisagree: 214,
  countedTwice: COUNTED_TWICE,
  oneByOne: ONE_BY_ONE,
  /** The review's "in progress" state of Duplicates: the two strong classes unified in bulk, seven of the one-by-one groups decided. */
  progress: Object.freeze({
    unify: 141 + 38 + ONE_BY_ONE_DECIDED.unified,
    apart: ONE_BY_ONE_DECIDED.apart,
    left: ONE_BY_ONE - ONE_BY_ONE_DECIDED.unified - ONE_BY_ONE_DECIDED.apart,
  }),
});
if (PLAN.progress.unify + PLAN.progress.apart + PLAN.progress.left !== PLAN.groups) throw new Error("the duplicates in progress do not add up");
if (PLAN.links + PLAN.noCompany !== PLAN.output) throw new Error("the contacts prepared do not add up");

export const n = (value: number): string => value.toLocaleString("en-US");
/** "1,137 of 12,480 contacts · 9.1%": every share says out of what. */
export const share = (count: number, of: number = EXAMPLE.contacts): string => `${((count / of) * 100).toFixed(1)}%`;
