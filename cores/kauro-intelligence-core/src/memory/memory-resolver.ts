/**
 * The Memory Resolver, canon §44–§51: pure. Given the host's scoped snapshot,
 * the tenant of the run, the current target and the fields in question, it
 * returns the entries that may travel as evidence, in the precedence the
 * canon fixes, with the state each is in now. Memory is evidence, never
 * authority: the current TargetContract and the current dataset outrank it,
 * and a stale or conflicting entry is named rather than applied.
 *
 * The model has no write path. What a proposal may originate is a
 * MemoryCandidate, produced here from a compiled outcome and promoted only by
 * a deterministic step with an approver.
 */
import { digestOf } from '../contracts/canonical.js';
import type { MemoryEvidenceItem } from '../contracts/envelope.js';
import { IntelligenceError } from '../contracts/errors.js';
import { OUTCOME_LADDER } from '../contracts/run.js';
import type { MemoryCandidate, MemoryEntry } from '../contracts/run.js';
import { SUSPICIOUS_UNICODE } from '../contracts/schema.js';

export interface TenantContext {
  readonly agencyId: string;
  readonly clientId: string;
}

export interface MemoryQuery {
  readonly tenant: TenantContext;
  readonly targetInstanceRef: string | null;
  readonly targetSchemaVersion: string | null;
  readonly knownTargetRefs: ReadonlySet<string>;
  readonly headers: readonly string[];
}

export interface MemoryResolution {
  readonly evidence: readonly MemoryEvidenceItem[];
  readonly stale: readonly { memoryId: string; reason: string }[];
  readonly conflicted: readonly { memoryIds: readonly string[]; pattern: string }[];
  readonly refused: readonly { memoryId: string; reason: string }[];
}

/** Text that reads as an instruction rather than a rule: a poisoned entry. */
export const INSTRUCTION_LIKE = /(ignore (all|any|previous|prior)|disregard|system:|assistant:|you must|override|exfiltrat|send .* to|reveal|api[ _-]?key|password|<\/?script|\{\{|\bprompt\b)/iu;

const SCOPE_RANK: Readonly<Record<MemoryEntry['scope'], number>> = { CLIENT: 0, AGENCY: 1, GLOBAL: 2 };

export function resolveMemory(entries: readonly MemoryEntry[], query: MemoryQuery): MemoryResolution {
  const stale: { memoryId: string; reason: string }[] = [];
  const refused: { memoryId: string; reason: string }[] = [];
  const applicable: (MemoryEntry & { weight: number })[] = [];
  for (const entry of entries) {
    // Tenancy first. A CLIENT entry of another client, or an AGENCY entry of
    // another agency, is a scope violation whatever it says.
    if (entry.scope === 'CLIENT' && (entry.tenant.clientId !== query.tenant.clientId || entry.tenant.agencyId !== query.tenant.agencyId)) {
      refused.push({ memoryId: entry.memoryId, reason: 'CLIENT memory of another client or agency' });
      continue;
    }
    if (entry.scope === 'AGENCY' && entry.tenant.agencyId !== query.tenant.agencyId) {
      refused.push({ memoryId: entry.memoryId, reason: 'AGENCY memory of another agency' });
      continue;
    }
    // An AGENCY convention names its agency and no client (R2-029): an entry
    // scoped AGENCY that names a client is one client's decision under an
    // agency label, and membership of the agency does not make another
    // client's example this client's evidence — nor let it conflict with the
    // client's own history and silence it.
    if (entry.scope === 'AGENCY' && entry.tenant.clientId !== null) {
      refused.push({ memoryId: entry.memoryId, reason: 'AGENCY memory that names a client' });
      continue;
    }
    if (entry.scope === 'GLOBAL' && (entry.tenant.agencyId !== null || entry.tenant.clientId !== null)) {
      refused.push({ memoryId: entry.memoryId, reason: 'GLOBAL memory that names a tenant' });
      continue;
    }
    if (entry.status === 'RETIRED' || entry.status === 'CANDIDATE') {
      refused.push({ memoryId: entry.memoryId, reason: `${entry.status} memory is not evidence` });
      continue;
    }
    const text = `${entry.ruleOrPattern.sourceHeaderPattern} ${entry.provenance}`;
    if (INSTRUCTION_LIKE.test(text) || SUSPICIOUS_UNICODE.test(text)) {
      refused.push({ memoryId: entry.memoryId, reason: 'reads as an instruction or carries suspicious characters' });
      continue;
    }
    if (entry.ruleOrPattern.targetRef !== null && !query.knownTargetRefs.has(entry.ruleOrPattern.targetRef)) {
      stale.push({ memoryId: entry.memoryId, reason: 'names a target the current contract does not carry' });
      continue;
    }
    if (entry.targetSchemaVersion !== null && query.targetSchemaVersion !== null && entry.targetSchemaVersion !== query.targetSchemaVersion) {
      stale.push({ memoryId: entry.memoryId, reason: `for target schema ${entry.targetSchemaVersion}, current is ${query.targetSchemaVersion}` });
      continue;
    }
    if (entry.status === 'STALE' || entry.status === 'CONFLICTED') {
      stale.push({ memoryId: entry.memoryId, reason: `marked ${entry.status}` });
      continue;
    }
    const matchesHeader = query.headers.some((header) => header.normalize('NFKC').toLowerCase().includes(entry.ruleOrPattern.sourceHeaderPattern.normalize('NFKC').toLowerCase()));
    if (!matchesHeader) continue;
    // Same client and same instance verified history outranks an agency
    // convention, which outranks global knowledge; within a scope the
    // outcome ladder orders, and nothing on the ladder reaches authority.
    const sameInstance = entry.scope === 'CLIENT' && entry.targetInstanceRef !== null && entry.targetInstanceRef === query.targetInstanceRef;
    const weight = Math.min(0.99, OUTCOME_LADDER[entry.verificationOutcome] * (sameInstance ? 1 : entry.scope === 'CLIENT' ? 0.9 : entry.scope === 'AGENCY' ? 0.7 : 0.5));
    applicable.push({ ...entry, weight });
  }
  // Conflicts: two applicable entries for the same pattern that disagree.
  const byPattern = new Map<string, (MemoryEntry & { weight: number })[]>();
  for (const entry of applicable) {
    const key = entry.ruleOrPattern.sourceHeaderPattern.toLowerCase();
    byPattern.set(key, [...(byPattern.get(key) ?? []), entry]);
  }
  const conflicted: { memoryIds: readonly string[]; pattern: string }[] = [];
  const evidence: MemoryEvidenceItem[] = [];
  for (const [pattern, group] of byPattern) {
    const answers = new Set(group.map((entry) => `${entry.ruleOrPattern.targetRef ?? ''}|${entry.ruleOrPattern.semanticType ?? ''}`));
    if (answers.size > 1) {
      conflicted.push({ memoryIds: group.map((entry) => entry.memoryId), pattern });
      continue;
    }
    const best = [...group].sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || b.weight - a.weight || (a.memoryId < b.memoryId ? -1 : 1))[0];
    if (best === undefined) continue;
    evidence.push({ memoryId: best.memoryId, scope: best.scope, knowledgeType: best.knowledgeType, rule: { ...best.ruleOrPattern }, verificationOutcome: best.verificationOutcome, weight: best.weight, status: 'ACTIVE' });
  }
  evidence.sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || b.weight - a.weight || (a.memoryId < b.memoryId ? -1 : 1));
  return { evidence, stale, conflicted, refused };
}

/** A candidate from a compiled, accepted proposal item — never from the model directly. */
export function memoryCandidateFrom(input: { runId: string; taskId: string; tenant: TenantContext; header: string; targetRef: string | null; semanticType: string | null; scope: 'CLIENT' | 'AGENCY' }): MemoryCandidate {
  if (INSTRUCTION_LIKE.test(input.header) || SUSPICIOUS_UNICODE.test(input.header)) throw new IntelligenceError('MEMORY_SCOPE_VIOLATION', 'a header that reads as an instruction does not become memory');
  const knowledgeType = input.targetRef !== null ? 'FIELD_MAPPING_CONVENTION' : 'SEMANTIC_TYPE_CONVENTION';
  return {
    candidateId: `mem_${digestOf([input.runId, input.taskId, input.header, input.targetRef, input.semanticType]).slice(0, 16)}`,
    derivedFromRunId: input.runId,
    derivedFromTaskId: input.taskId,
    proposedRule: { sourceHeaderPattern: input.header, targetRef: input.targetRef, semanticType: input.semanticType },
    knowledgeType,
    scope: input.scope,
    tenant: { agencyId: input.tenant.agencyId, clientId: input.scope === 'CLIENT' ? input.tenant.clientId : null },
    status: 'CANDIDATE',
  };
}

/** Promotion is deterministic and needs an approver; the model never reaches this function. */
export function promoteCandidate(candidate: MemoryCandidate, approval: { approvedBy: string; verificationOutcome: MemoryEntry['verificationOutcome']; at: string; sourceProjectRef: string; sourcePlanVersion: string; targetInstanceRef: string | null; targetSchemaVersion: string | null }): MemoryEntry {
  if (approval.approvedBy.trim() === '' || approval.approvedBy.startsWith('model:')) throw new IntelligenceError('MEMORY_SCOPE_VIOLATION', 'promotion needs a human or policy approver; the model cannot approve memory');
  if (candidate.scope === 'AGENCY' && OUTCOME_LADDER[approval.verificationOutcome] < OUTCOME_LADDER.AGENCY_APPROVED) throw new IntelligenceError('MEMORY_SCOPE_VIOLATION', 'an AGENCY convention needs at least AGENCY_APPROVED');
  return {
    memoryId: candidate.candidateId,
    scope: candidate.scope,
    tenant: candidate.tenant,
    knowledgeType: candidate.knowledgeType,
    ruleOrPattern: candidate.proposedRule,
    sourceProjectRef: approval.sourceProjectRef,
    sourcePlanVersion: approval.sourcePlanVersion,
    targetInstanceRef: approval.targetInstanceRef,
    targetSchemaVersion: approval.targetSchemaVersion,
    approvedBy: approval.approvedBy,
    verificationOutcome: approval.verificationOutcome,
    provenance: `run ${candidate.derivedFromRunId} task ${candidate.derivedFromTaskId}`,
    createdAt: approval.at,
    lastUsedAt: null,
    status: 'ACTIVE',
    version: 1,
  };
}

/** Deletion invalidates: an entry whose client was deleted is retired, and nothing derived from it is served. */
export function retireForDeletedClient(entries: readonly MemoryEntry[], clientId: string): readonly MemoryEntry[] {
  return entries.map((entry) => (entry.tenant.clientId === clientId ? { ...entry, status: 'RETIRED', version: entry.version + 1 } : entry));
}
