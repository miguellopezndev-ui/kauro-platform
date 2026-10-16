/**
 * The final-delivery gate (B04 integrate, coordinator decision D4-MC3-2).
 *
 * A SYSTEM_DRAFT is a draft, not a validated plan: when Migration Core refuses to validate a plan that maps nothing to a field the
 * target contract requires (CAP10's blocking requirement), the draft waits for the agency's decision with `validation.status`
 * DEFERRED_FOR_AGENCY_DECISION and no receipt. Migration Core's validation of the whole dataset is mandatory before any final
 * delivery, so a host asks this gate before it delivers anything: a draft is deliverable only when Migration Core validated exactly
 * this configuration (a receipt that passed, whose package verified and whose reconciliation holds), and no requirement is blocking.
 * The gate reads the draft alone and decides nothing about the agency's approval; that is a different question.
 */
import { digestOf } from '../contracts/canonical.js';
import { IntelligenceError } from '../contracts/errors.js';
import type { DraftMigrationPlan } from './intelligence-core.js';

export const DELIVERY_BLOCKERS = Object.freeze([
  'NOT_DRAFTABLE',
  'NO_CONFIGURATION',
  'VALIDATION_DEFERRED',
  'NO_MIGRATION_CORE_VALIDATION',
  'MIGRATION_CORE_VALIDATION_FAILED',
  'RECEIPT_NOT_BOUND_TO_CONFIGURATION',
  'BLOCKING_REQUIREMENT',
] as const);
export type DeliveryBlocker = (typeof DELIVERY_BLOCKERS)[number];

/** Every reason this draft cannot be delivered, in a fixed order; empty when Migration Core validated it and nothing blocks it. */
export function finalDeliveryBlockers(draft: DraftMigrationPlan): readonly DeliveryBlocker[] {
  const blockers: DeliveryBlocker[] = [];
  if (draft.status !== 'SYSTEM_DRAFT') blockers.push('NOT_DRAFTABLE');
  if (draft.configuration === null) blockers.push('NO_CONFIGURATION');
  const receipt = draft.fullValidation;
  if (draft.validation.status === 'DEFERRED_FOR_AGENCY_DECISION') blockers.push('VALIDATION_DEFERRED');
  else if (draft.validation.status !== 'VALIDATED' || receipt === null) blockers.push('NO_MIGRATION_CORE_VALIDATION');
  else if (!receipt.ok || !receipt.packageVerified || !receipt.reconciliationHolds) blockers.push('MIGRATION_CORE_VALIDATION_FAILED');
  else if (draft.configuration !== null && receipt.configurationDigest !== digestOf(draft.configuration)) blockers.push('RECEIPT_NOT_BOUND_TO_CONFIGURATION');
  if (draft.requirements.some((entry) => entry.status === 'BLOCKING')) blockers.push('BLOCKING_REQUIREMENT');
  return blockers;
}

/** Throws CONTRACT_VIOLATION naming every blocker when the draft may not be delivered. */
export function assertFinalDeliveryAllowed(draft: DraftMigrationPlan): void {
  const blockers = finalDeliveryBlockers(draft);
  if (blockers.length > 0) throw new IntelligenceError('CONTRACT_VIOLATION', `final delivery refused: ${blockers.join(', ')}`);
}
