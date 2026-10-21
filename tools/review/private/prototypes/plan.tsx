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
import { teamOf } from "./people.ts";

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

/**
 * The evidence classes of the contact duplicate groups (research §5.9; the owner's decision of Orders 11–12 on batch unification). Only one
 * class is a demonstrated identity: the same email address and the same name after normalisation; its groups may be applied together
 * when no blocking conflict touches them. Every other class is a probable duplicate: a person may review, select and decide many of its
 * groups in one action, recorded as decided by that person, and it is never labelled demonstrated. A group with a blocking conflict is kept
 * out of every batch and decided on its own. Group numbers run class by class (1 to 141, 142 to 179, 180 to 193, 194 to 207).
 * `final` is how revision 6 of the plan decides each class: it adds up to 200 unified and 7 kept apart.
 */
export const CLASSES = [
  {
    key: "email-name",
    evidence: "Same email address and same name",
    identity: "demonstrated",
    groups: 141,
    contacts: 282,
    first: 1,
    blocked: 3,
    final: { unified: 138, apart: 3 },
    samples: ["Leo Grant · Leo Grant — leo.grant@example.net", "Mia Chen · Mia Chen — mia.chen@example.com", "Omar Haddad · Omar Haddad — o.haddad@example.org"],
  },
  {
    key: "email-spelling",
    evidence: "Same email address, name spelt differently",
    identity: "probable",
    groups: 38,
    contacts: 76,
    first: 142,
    blocked: 2,
    final: { unified: 35, apart: 3 },
    samples: ["Maria Lopez · M. Lopez — m.lopez@example.com", "Jonathan Ames · Jon Ames — j.ames@example.net", "Sofia Brandt · Sofia Brand — s.brandt@example.com"],
  },
  { key: "name-phone", evidence: "Same name and phone, email missing or different", identity: "probable", groups: 14, contacts: 28, first: 180, blocked: 0, final: { unified: 13, apart: 1 }, samples: [] },
  { key: "three", evidence: "Groups of three records", identity: "probable", groups: 14, contacts: 42, first: 194, blocked: 0, final: { unified: 14, apart: 0 }, samples: [] },
] as const;
export type EvidenceClass = (typeof CLASSES)[number];

/** A conflict that keeps a group out of every batch: the reason in the customer's words and what the team can do. */
export interface BlockedGroup {
  readonly group: number;
  readonly classKey: EvidenceClass["key"];
  readonly records: string;
  readonly reason: string;
  readonly action: string;
}
export const BLOCKED: readonly BlockedGroup[] = [
  { group: 7, classKey: "email-name", records: "Noor Saleh · Noor Saleh — n.saleh@example.com", reason: "Both rows already exist as separate records in HubSpot (Record IDs 4021 and 7710).", action: "Keep them apart, or merge the two records in HubSpot and upload a new export." },
  { group: 33, classKey: "email-name", records: "Pavel Novak · Pavel Novak — p.novak@example.org", reason: "Both rows already exist as separate records in HubSpot (Record IDs 6034 and 6035).", action: "Keep them apart, or merge the two records in HubSpot and upload a new export." },
  { group: 96, classKey: "email-name", records: "Lina Berg · Lina Berg — l.berg@example.net", reason: "Both rows already exist as separate records in HubSpot (Record IDs 2290 and 9105).", action: "Keep them apart, or merge the two records in HubSpot and upload a new export." },
  { group: 151, classKey: "email-spelling", records: "Ana Ruiz · Tom Lee — sales@larch.example", reason: "A shared address: two different people use sales@larch.example.", action: "Keep them apart; unify only after checking that this is one person." },
  { group: 166, classKey: "email-spelling", records: "Kai Brennan · Dana Brennan — info@osprey.example", reason: "A shared address: two different people use info@osprey.example.", action: "Keep them apart; unify only after checking that this is one person." },
];

/** One line of the record of who decided what: when, who, what, on which evidence, how many groups. */
export interface Trace {
  readonly at: string;
  readonly who: string;
  readonly what: string;
  readonly evidence: string;
  readonly groups: number;
}

/** The decisions behind revision 6's duplicates, in the order they were made (synthetic, between the draft at 11:20 and the check at 12:20). */
export function traceOf(owner: string, operator: string): readonly Trace[] {
  return [
    { at: "2026-10-20T11:40:00Z", who: owner, what: "Applied together: unify", evidence: "Same email address and same name (demonstrated identity)", groups: 138 },
    { at: "2026-10-20T11:52:00Z", who: operator, what: "Decided together: unify", evidence: "Same email address, name spelt differently (probable)", groups: 36 },
    { at: "2026-10-20T11:58:00Z", who: operator, what: "Changed before approval: group 171 kept apart instead", evidence: "Same email address, name spelt differently (probable)", groups: 1 },
    { at: "2026-10-20T12:02:00Z", who: operator, what: "Decided together: unify", evidence: "Groups of three records (probable)", groups: 14 },
    { at: "2026-10-20T12:09:00Z", who: operator, what: "Decided one by one: 13 unified, 1 kept apart", evidence: "Same name and phone, email missing or different (probable)", groups: 14 },
    { at: "2026-10-20T12:14:00Z", who: operator, what: "Kept apart: a blocking conflict", evidence: "Kept out of every batch", groups: BLOCKED.length },
  ];
}

const groups = SAMPLE_GROUPS.pairs + SAMPLE_GROUPS.triples;
const unifiedRows = SAMPLE_GROUPS.pairs - SAMPLE_GROUPS.pairsKeptApart + SAMPLE_GROUPS.triples * 2;
if (CLASSES.reduce((sum, one) => sum + one.groups, 0) !== groups) throw new Error("the evidence classes do not add up to the candidate groups");
if (CLASSES.reduce((sum, one) => sum + one.contacts, 0) !== EXAMPLE.report.inGroups) throw new Error("the evidence classes do not add up to the contacts in groups");
if (CLASSES.some((one) => one.final.unified + one.final.apart !== one.groups)) throw new Error("a class's decisions do not add up to its groups");
if (CLASSES.reduce((sum, one) => sum + one.final.apart, 0) !== SAMPLE_GROUPS.pairsKeptApart) throw new Error("the groups kept apart do not add up");
if (CLASSES.reduce((sum, one) => sum + one.blocked, 0) !== BLOCKED.length) throw new Error("the blocked groups do not add up");
/** Of the contacts with an empty Company column: rows unified into a record, and kept rows that took the company of a row unified into them. */
const EMPTY_UNIFIED = 61;
const EMPTY_FILLED = 18;
const emptyCompany = EXAMPLE.report.noCompany - EMPTY_UNIFIED - EMPTY_FILLED;
/** Contacts whose Company names a company that companies.xlsx does not hold (the Links page lists them). */
const NOT_FOUND = 163;
const output = EXAMPLE.contacts - unifiedRows;
/** Contacts the check counted in two of its findings (a review value): the findings' sum is not the number of contacts affected. */
const COUNTED_TWICE = 173;

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
  /** Revision 7 (the Approval page's "changed after approval" state): group 188 is kept apart instead of unified, one contact more is
   *  prepared, and that contact names a company that companies.xlsx holds, so one link more. */
  revision7: Object.freeze({ unify: groups - SAMPLE_GROUPS.pairsKeptApart - 1, apart: SAMPLE_GROUPS.pairsKeptApart + 1, unifiedRows: unifiedRows - 1, output: output + 1, links: output - emptyCompany - NOT_FOUND + 1 }),
});
if (PLAN.revision7.unify + PLAN.revision7.apart !== PLAN.groups) throw new Error("revision 7 does not add up");
if (PLAN.links + PLAN.noCompany !== PLAN.output) throw new Error("the contacts prepared do not add up");

export const n = (value: number): string => value.toLocaleString("en-US");
/** "1,137 of 12,480 contacts · 9.1%": every share says out of what. */
export const share = (count: number, of: number = EXAMPLE.contacts): string => `${((count / of) * 100).toFixed(1)}%`;

/** Who made the review's decisions in a workspace: its owner and its operator (one person in a one-person company). */
export function deciders(ctx: PrototypeProps["ctx"]): { readonly owner: string; readonly operator: string } {
  const team = teamOf(ctx);
  const named = (role: string): string | undefined => {
    const person = team.find((one) => one.role === role);
    return person === undefined ? undefined : `${person.name} (${role === "OWNER" ? "Owner" : "Operator"})`;
  };
  const owner = named("OWNER") ?? "An owner";
  return { owner, operator: named("OPERATOR") ?? owner };
}
