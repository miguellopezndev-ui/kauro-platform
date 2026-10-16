import type { DestinationAdapter } from '../adapters/adapter.js';
import type { MigrationConfig, TargetMode } from '../domain/config.js';
import type { CanonicalObject } from '../domain/canonical.js';
import { isMigrationError } from '../domain/errors.js';
import { omit, preserve } from '../domain/value-intent.js';
import type { ResolvedValue } from '../identity/resolve-identity.js';
import { headerForField } from '../artifacts/render-package.js';
import { loadTargetContract, serializeTargetContract, TARGET_CONTRACT_VERSION } from '../target/contract.js';
import type { HashedTargetContract } from '../target/contract.js';
import { instanceFinding, instancePlan } from '../run/validate-destination.js';
import type { InstanceMappingPlan } from '../run/validate-destination.js';
import { deliveredRows } from './import-rows.js';

/**
 * Verification against the destination's own facts.
 *
 * A package names the target contract it was shaped against by digest and by
 * nothing else: the contract is not an artifact of the package, so a
 * verification that reads only the package can say that a digest is recorded
 * and cannot say whether any value in `01_IMPORT` is one that instance takes.
 * That is the question the permission boundary (defects R-MC-TYPE and
 * R-MC-ENUM) needs answered after the fact, so the host supplies the contract
 * it trusts and this module answers it:
 *
 *   1. the supplied body re-establishes its digest, through the same loader a
 *      run uses, so a changed body under an old digest is refused;
 *   2. that digest is the one the package recorded, and the contract describes
 *      an instance of the package's mode, so a different valid contract is
 *      refused;
 *   3. the package's own plan, read back from `config.normalized.json`, is
 *      re-decided against the contract by the rule the producer applies
 *      (`instancePlan`): object and field presence, writeability for the
 *      package's import mode, an implemented and compatible type, a vocabulary
 *      that admits anything at all, and every required field mapped;
 *   4. every cell the import files actually carry is held to the value-level
 *      facts by the same rule (`instanceFinding`): length, precision and
 *      scale, an active option's value, and a value for every field the
 *      instance requires on create.
 *
 * The contract is trusted host input. It is not inferred from a digest and it
 * is not authority the package can supply about itself.
 */
export interface TargetEvidenceInput {
  readonly packageDir: string;
  readonly mode: TargetMode;
  readonly recordedContractHash: string | null;
  readonly adapter: DestinationAdapter;
  readonly config: MigrationConfig;
  readonly supplied: HashedTargetContract | null;
  readonly required: boolean;
  readonly limits: { readonly delimiter: string; readonly maxCellLength: number; readonly maxColumns: number; readonly maxRows: number };
  readonly record: (check: string) => void;
  readonly fail: (check: string, detail: string) => void;
}

/** How many offending cells are named one by one before the rest are counted. */
const NAMED_CELL_LIMIT = 20;

export function verifyTargetEvidence(input: TargetEvidenceInput): void {
  const { mode, supplied, fail, record } = input;

  record('target.contractSupplied');
  if (supplied === null) {
    if (input.required && mode !== 'CLEAN_ONLY') {
      fail(
        'target.contractSupplied',
        `target-aware verification was required and no trusted target contract was supplied; this ${mode} package names ` +
          `${input.recordedContractHash ?? 'no contract'}, and a digest alone says nothing about which values that instance takes`,
      );
    }
    return;
  }
  if (mode === 'CLEAN_ONLY') {
    fail('target.contractSupplied', 'a CLEAN_ONLY package addresses no destination instance, and a target contract was supplied for it');
    return;
  }

  record('target.contractBody');
  let trusted: HashedTargetContract;
  try {
    if (typeof supplied !== 'object' || supplied.contract === null || typeof supplied.contract !== 'object') {
      throw new Error('the supplied target contract is not a hashed target contract');
    }
    trusted = loadTargetContract(serializeTargetContract(supplied), 'the supplied target contract');
    if (trusted.contract.contractVersion !== TARGET_CONTRACT_VERSION) {
      throw new Error(`it declares contract version ${String(trusted.contract.contractVersion)} and this core reads ${TARGET_CONTRACT_VERSION}`);
    }
    if (typeof supplied.canonicalJson === 'string' && supplied.canonicalJson !== trusted.canonicalJson) {
      throw new Error('it carries canonical bytes that are not the bytes of its body');
    }
  } catch (error) {
    fail('target.contractBody', `the supplied target contract does not re-establish its own digest ${String(supplied.contractHash)}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  record('target.contractBound');
  if (input.recordedContractHash !== trusted.contractHash) {
    fail(
      'target.contractBound',
      `the package was shaped against ${input.recordedContractHash ?? 'no target contract'}, and the supplied contract is ${trusted.contractHash}`,
    );
    return;
  }
  if (trusted.contract.instance.mode !== mode) {
    fail('target.contractBound', `the supplied contract describes a ${trusted.contract.instance.mode} instance, and the package is ${mode}`);
    return;
  }

  record('target.plan');
  const importMode = input.config.target.importMode;
  const creates = importMode === 'CREATE_ONLY' || importMode === 'UPSERT';
  const updates = importMode === 'UPDATE_ONLY' || importMode === 'UPSERT';
  let plans: ReadonlyMap<string, InstanceMappingPlan>;
  try {
    plans = instancePlan(input.config, input.adapter, trusted, creates, updates);
  } catch (error) {
    if (!isMigrationError(error)) throw error;
    fail('target.plan', `the package's plan is not one the instance takes (${error.code}): ${error.message}`);
    return;
  }

  record('target.values');
  // Per object, the header each planned field is written under, and the plan
  // that decides it. Two mappings onto one object share its columns, and a
  // field both deliver is decided by the same contract field either way.
  const byObject = new Map<CanonicalObject, { plan: InstanceMappingPlan; headers: Map<string, string> }>();
  for (const mapping of input.config.records) {
    const plan = plans.get(mapping.id);
    if (plan === undefined) continue;
    const entry = byObject.get(mapping.object) ?? { plan: { object: plan.object, fields: [], requiredOnCreate: [] }, headers: new Map<string, string>() };
    const fields = [...entry.plan.fields];
    const required = [...entry.plan.requiredOnCreate];
    for (const field of plan.fields) {
      if (entry.headers.has(field.destinationField)) continue;
      const header = headerForField(input.adapter, mapping.object, field.destinationField);
      if (header === null) continue;
      entry.headers.set(field.destinationField, header);
      fields.push(field);
    }
    for (const field of plan.requiredOnCreate) {
      if (!required.some((known) => known.destinationField === field.destinationField)) required.push(field);
    }
    byObject.set(mapping.object, { plan: { object: plan.object, fields, requiredOnCreate: required }, headers: entry.headers });
  }

  const clearToken = input.adapter.clearRepresentation.kind === 'EXPLICIT_TOKEN' ? input.adapter.clearRepresentation.token : null;
  let offending = 0;
  for (const { v: delivered } of deliveredRows(input.packageDir, input.adapter, input.config, input.limits)) {
    const entry = byObject.get(delivered.object);
    if (entry === undefined) continue;
    const values = new Map<string, ResolvedValue>();
    for (const [destinationField, header] of entry.headers) {
      const cell = delivered.row[header];
      values.set(destinationField, {
        intent: cell === undefined || cell === '' || cell === clearToken ? omit('NO_VALUE_PRODUCED') : preserve(cell),
      });
    }
    const finding = instanceFinding({ values }, entry.plan, creates);
    if (finding === null) continue;
    offending += 1;
    if (offending <= NAMED_CELL_LIMIT) {
      fail('target.values', `${delivered.path}: ${finding.detail}`);
    }
  }
  if (offending > NAMED_CELL_LIMIT) {
    fail('target.values', `${String(offending - NAMED_CELL_LIMIT)} further delivered rows carry values the instance does not take`);
  }
}
