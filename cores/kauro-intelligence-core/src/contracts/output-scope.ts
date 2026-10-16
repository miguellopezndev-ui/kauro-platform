/**
 * The output scope of a claim, D3-SCOPE-1 (review finding B03-R5).
 *
 * A mapping claims an output: one destination field of one record mapping —
 * a source file and the canonical object it is delivered as. Two independent
 * record mappings may name the same target (two Contact files each deliver
 * their own contact.email); two claims inside one scope compete, and only an
 * explicit resolution decides between them (CONSISTENCY_REVIEW, CAP11). The
 * resolver, the compiler and the assembler key every claim with this one
 * function, so the three can never scope a claim differently again.
 */

/** The record mapping a source file's rows are delivered through: the file and the canonical object, in the form the configuration names it. */
export function recordMappingIdOf(fileId: string, object: string): string {
  return `${fileId}-${object.toLowerCase()}`;
}

/**
 * The scope a claim lives in. `recordMappingId` is null while the file's
 * object is undecided; such a claim is still scoped to the target alone and
 * never to the run. `target` is the destination the claim writes: the
 * canonical field a target ref is delivered as — for CLEAN_ONLY the ref and
 * the field are one; a vendor field is named by the destination Migration
 * Core delivers it through, so two vendor fields delivered as one
 * destination compete in one scope, as Migration Core's own loader requires.
 */
export function outputScopeOf(recordMappingId: string | null, target: string): string {
  return `${recordMappingId ?? '(no record mapping)'}|${target}`;
}
