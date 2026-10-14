// UI52 Support cases as data (registry: "Track your questions and next actions."; CMD044 opens a case; Q-B11-1: cases are project-scoped, the
// project is named in the address). What the api says and nothing more:
//   - the form sends text only (the api admits no attachment yet: evidenceRefs is always empty), so the page says files go through the secure
//     upload; the api refuses text that looks like a secret or customer records (CONTENT_REFUSED, next action SECURE_UPLOAD with its route);
//   - a case is opened once per form: the key is minted when the form opens and kept until a COMPLETED answer, so a lost answer replays;
//   - a refused summary never leaves the person's screen and never enters a log or a link: the page only ever shows it back in the form.
import { isSafeHref } from "@kauro/ui";
import type { CreateSupportCaseRequest, ListSupportCasesReply, Problem, SupportCaseView } from "../../api/generated.ts";
import type { ApiClient } from "../../client/api-client.ts";
import type { DurableRead, FormHandle, OperationRunner, RunOutcome } from "../../client/operation-runner.ts";
import type { PagedSource } from "../shared/use-paged-read.ts";

export type Category = CreateSupportCaseRequest["category"];
export const CATEGORIES: readonly Category[] = ["PRODUCT_DEFECT", "IMPORT_GUIDANCE", "BILLING", "PRIVACY", "SECURITY", "GENERAL"];
export const SUMMARY_MIN = 20;
export const SUMMARY_MAX = 4000;
export const PAGE_SIZE = 20;

export type SummaryProblem = "SHORT" | "LONG";

/** The length rules of the request schema (code points, and not blank); the api checks the rest and its answer is shown as it comes. */
export function summaryProblem(summary: string): SummaryProblem | null {
  const length = [...summary].length;
  if (summary.trim().length === 0 || length < SUMMARY_MIN) return "SHORT";
  return length > SUMMARY_MAX ? "LONG" : null;
}

export interface CaseSource extends PagedSource<ListSupportCasesReply, SupportCaseView> {}

/** The project's cases, keyset-paged: the only cursor sent is the one the server issued. The page carries no version of its own. */
export function caseSource(client: ApiClient, projectId: string): CaseSource {
  return {
    load: (cursor, signal) => client.call("ListSupportCases", { path: { projectId }, query: cursor === null ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, cursor }, signal }),
    pageOf: (body) => ({ items: body.data.items, nextCursor: body.data.nextCursor ?? null, version: "cases" }),
  };
}

/** After a lost answer to CMD044 the project's cases say whether it took effect: a case of this topic and text that was not there before. */
export function readCreated(client: ApiClient, projectId: string, input: CreateSupportCaseRequest, known: ReadonlySet<string>): () => Promise<DurableRead<SupportCaseView>> {
  return async () => {
    const answer = await client.call("ListSupportCases", { path: { projectId }, query: { limit: PAGE_SIZE } });
    if (answer.kind !== "REPLY") return { kind: "NO_ANSWER" };
    const created = answer.body.data.items.find((item) => !known.has(item.caseId) && item.category === input.category && item.summary === input.summary);
    return created === undefined ? { kind: "NOT_YET" } : { kind: "RESOLVED", data: created };
  };
}

/**
 * CMD044 through the runner under the key the form minted when it opened. `known` is the set of case ids the list already held: with it a
 * lost answer is recovered by finding the one new case; without it (the list was never read) the run stays Checking under the same key.
 */
export function createSupportCase(client: ApiClient, runner: OperationRunner, form: FormHandle, projectId: string, input: CreateSupportCaseRequest, known: ReadonlySet<string> | null): Promise<RunOutcome<SupportCaseView>> {
  return runner.run<SupportCaseView>({
    command: "CMD044",
    subject: { kind: "FORM", form },
    send: (key) => client.call("CreateSupportCase", { path: { projectId }, body: input, idempotencyKey: key }),
    ...(known === null ? {} : { reread: readCreated(client, projectId, input, known) }),
  });
}

export interface Refusal {
  readonly reason: "SECRET_LIKE_CONTENT" | "RECORD_LIKE_CONTENT" | null;
  /** The route the api named for the secure upload, only when it is an application path. */
  readonly route: string | null;
}

/** An application path: one slash then a segment, never a protocol-relative or script address. */
export function safeRoute(href: string | undefined): string | null {
  if (href === undefined || !href.startsWith("/") || href.startsWith("//") || href.includes("\\") || !isSafeHref(href)) return null;
  return href;
}

/** The CONTENT_REFUSED refusal of a run, with the secure-upload route the api named; null for any other outcome. */
export function refusalOf(outcome: RunOutcome<unknown>): Refusal | null {
  if (outcome.kind !== "PROBLEM" || outcome.problem.code !== "CONTENT_REFUSED") return null;
  const reason = outcome.problem.reason === "SECRET_LIKE_CONTENT" || outcome.problem.reason === "RECORD_LIKE_CONTENT" ? outcome.problem.reason : null;
  const upload = (outcome.problem as Problem).nextActions.find((next) => next.action === "SECURE_UPLOAD");
  return { reason, route: safeRoute(upload?.href) };
}

/** The case a finished run created, found directly or read back. */
export function createdCase(outcome: RunOutcome<SupportCaseView>): SupportCaseView | null {
  return outcome.kind === "COMPLETED" || outcome.kind === "RECOVERED" ? outcome.data : null;
}
