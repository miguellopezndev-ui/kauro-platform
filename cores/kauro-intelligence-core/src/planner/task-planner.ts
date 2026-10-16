/**
 * The Task Planner, canon §62–§63 and D3-PART-1: open questions are
 * partitioned into at most MAX_SEMANTIC_TASKS_PER_AUDIT tasks with stable ids
 * and a stable order. The order is the families' dependency order — the
 * object of a file first, then the field-level families, then identity,
 * duplicates, associations and target requirements, then the consistency
 * review — and inside a family one record mapping's questions stay together.
 * A batch is closed by its semantic complexity, by its number of questions
 * and by the estimated size of the envelope it would send, which must fit
 * one request under the per-request bound. There is no task per row or per
 * cell; a question the resolver already answered never becomes a task; and
 * what the plan cannot carry is pending by name — beyond the task cap, or a
 * question whose envelope alone would not fit one request — never dropped.
 */
import { digestOf } from '../contracts/canonical.js';
import type { TaskType } from '../contracts/envelope.js';
import { BUDGET_LIMITS } from '../contracts/run.js';
import type { TaskRecord } from '../contracts/run.js';
import type { OpenQuestion } from '../resolver/deterministic-resolver.js';

/** Why a question is pending: the task cap was reached, or its envelope alone would not fit one request under the per-request bound. */
export type PendingReason = 'TASK_CAP_REACHED' | 'REQUEST_BOUND_EXCEEDED';

export interface PendingQuestion {
  readonly question: OpenQuestion;
  readonly reason: PendingReason;
}

export interface Plan {
  readonly tasks: readonly TaskRecord[];
  /** Questions no task carries; each has its reason in `pending`, and its candidates are PENDING_CAP in the accounting. */
  readonly leftOut: readonly OpenQuestion[];
  readonly pending: readonly PendingQuestion[];
  readonly partitions: number;
}

/**
 * The families in dependency order (D3-PART-1): the object a file holds
 * before anything about its fields; the field-level families; then what reads
 * the fields — identity, duplicate signals, associations, target
 * requirements; the consistency review over all of them last. A repair is
 * never planned: it is the second attempt of the task it repairs.
 */
export const FAMILY_PHASES: readonly (readonly TaskType[])[] = Object.freeze([
  Object.freeze(['OBJECT_MAPPING'] as const),
  Object.freeze(['FIELD_MAPPING', 'SEMANTIC_TYPE', 'TRANSFORMATION_SELECTION', 'VALUE_MAP', 'UNMAPPED_HANDLING'] as const),
  Object.freeze(['IDENTITY_STRATEGY', 'DUPLICATE_SIGNAL_STRATEGY', 'ASSOCIATION_MAPPING', 'TARGET_REQUIREMENT'] as const),
  Object.freeze(['CONSISTENCY_REVIEW'] as const),
]);
const ORDER: readonly TaskType[] = [...FAMILY_PHASES.flat(), 'SEMANTIC_REPAIR'];

/** Complexity a batch may carry before it is split: plausible answers across its questions. */
export const MAX_COMPLEXITY_PER_TASK = 48;
export const MAX_QUESTIONS_PER_TASK = 12;

export interface PlanOptions {
  /** The task cap; MAX_SEMANTIC_TASKS_PER_AUDIT unless a test says otherwise. */
  readonly maxTasks?: number;
  /**
   * An upper bound, in UTF-8 bytes, of the whole provider request a batch of
   * questions would send — the envelope, the prompt bundle around it and the
   * room a repair round adds. A byte-level tokenizer never emits more tokens
   * than bytes, so a batch within `maxRequestBytes` fits the per-request
   * token bound whatever the provider counts. Without one, only complexity
   * and the question count close a batch.
   */
  readonly estimateRequestBytes?: (questions: readonly OpenQuestion[]) => number;
  /** The per-request bound the estimate is held to: MAX_INPUT_TOKENS_PER_REQUEST. */
  readonly maxRequestBytes?: number;
}

export function plan(projectRevisionHash: string, questions: readonly OpenQuestion[], options: PlanOptions = {}): Plan {
  const maxTasks = options.maxTasks ?? BUDGET_LIMITS.MAX_SEMANTIC_TASKS_PER_AUDIT;
  const bound = options.maxRequestBytes ?? BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST;
  const estimate = options.estimateRequestBytes;
  /** Whether the questions, sent together, fit one request under the per-request bound. */
  const fits = (batch: readonly OpenQuestion[]): boolean => estimate === undefined || estimate(batch) <= bound;
  const sorted = [...questions].sort((a, b) => ORDER.indexOf(a.taskType) - ORDER.indexOf(b.taskType) || ((a.recordMappingId ?? '') < (b.recordMappingId ?? '') ? -1 : (a.recordMappingId ?? '') > (b.recordMappingId ?? '') ? 1 : 0) || (a.questionRef < b.questionRef ? -1 : 1));
  const batches: { taskType: TaskType; questions: OpenQuestion[]; complexity: number }[] = [];
  const pending: PendingQuestion[] = [];
  for (const question of sorted) {
    // A question whose envelope alone would not fit one request is never sent: it is pending by name, never trimmed to fit.
    if (!fits([question])) {
      pending.push({ question, reason: 'REQUEST_BOUND_EXCEEDED' });
      continue;
    }
    const last = batches[batches.length - 1];
    if (last !== undefined && last.taskType === question.taskType && last.questions.length < MAX_QUESTIONS_PER_TASK && last.complexity + question.complexity <= MAX_COMPLEXITY_PER_TASK && fits([...last.questions, question])) {
      last.questions.push(question);
      last.complexity += question.complexity;
    } else {
      batches.push({ taskType: question.taskType, questions: [question], complexity: question.complexity });
    }
  }
  const tasks: TaskRecord[] = [];
  batches.forEach((batch, index) => {
    if (tasks.length >= maxTasks) {
      for (const question of batch.questions) pending.push({ question, reason: 'TASK_CAP_REACHED' });
      return;
    }
    const partitionKey = `${batch.taskType}:${String(index)}`;
    tasks.push({
      taskId: `task_${digestOf([projectRevisionHash, partitionKey, batch.questions.map((question) => question.questionRef)]).slice(0, 16)}`,
      taskType: batch.taskType,
      partitionKey,
      candidateRefs: batch.questions.flatMap((question) => question.candidateRefs),
      order: tasks.length,
    });
  });
  return { tasks, leftOut: pending.map((entry) => entry.question), pending, partitions: batches.length };
}

/**
 * The review phase, after every other family (D3-PART-1, D3-CAP-11): the
 * questions the consistency detector asks once the earlier phases are
 * compiled, partitioned under the same rules inside what the earlier plan
 * left of the task cap, and appended to it — the tasks after its tasks, in
 * order; what the cap or the per-request bound cannot carry pending by name
 * beside its pending. Only CONSISTENCY_REVIEW questions belong here.
 */
export function planReview(projectRevisionHash: string, questions: readonly OpenQuestion[], earlier: Plan, options: PlanOptions = {}): Plan {
  const foreign = questions.filter((question) => question.taskType !== 'CONSISTENCY_REVIEW');
  if (foreign.length > 0) throw new Error(`the review phase plans CONSISTENCY_REVIEW questions only, not ${foreign[0]?.taskType ?? ''}`);
  const maxTasks = options.maxTasks ?? BUDGET_LIMITS.MAX_SEMANTIC_TASKS_PER_AUDIT;
  const review = plan(projectRevisionHash, questions, { ...options, maxTasks: Math.max(0, maxTasks - earlier.tasks.length) });
  return {
    tasks: [...earlier.tasks, ...review.tasks.map((task) => ({ ...task, order: earlier.tasks.length + task.order }))],
    leftOut: [...earlier.leftOut, ...review.leftOut],
    pending: [...earlier.pending, ...review.pending],
    partitions: earlier.partitions + review.partitions,
  };
}
