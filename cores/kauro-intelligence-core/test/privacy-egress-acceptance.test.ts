/**
 * IC-05 acceptance (gate G-IC-PRIVACY), in every mode: target options, source
 * values and headers that are people's names or handles never leave — not in
 * the provider request bytes, the envelope parsed back out of them, the
 * transport metadata, the telemetry, the process logs, the run ledger or the
 * returned result, raw or encoded — whatever their case, digits, compactness,
 * cardinality or vendor suffix; and the run stays useful: the target field is
 * still offered with an empty option list, the provider is still reached,
 * Migration Core still validates the whole draft and the draft is a
 * SYSTEM_DRAFT with email and first name mapped. Useful vocabulary (Active,
 * Inactive, Open, Closed) still travels as options and as L1 exemplars.
 *
 * Every name and handle below is synthetic and written for this file.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { maskShape } from '../src/index.js';
import { MODES, leaks, opaque, runVector, targetFields, throughRepair, usefulness } from './support/egress-harness.js';
import type { Mode, Observed, Vector } from './support/egress-harness.js';

/** The historical audit witnesses, the useful controls, and one family per shape a name or handle takes. */
const VECTORS: readonly Vector[] = [
  { id: 'historical-segment', label: 'Segment', options: ['HENDERSON7', 'NDEBELE8'], safe: false, denied: ['HENDERSON7', 'NDEBELE8'], header: 'NDEBELE8' },
  { id: 'historical-vendedor', label: 'Vendedor', options: ['HENDERSON7', 'NDEBELE8'], safe: false, denied: ['HENDERSON7', 'NDEBELE8'] },
  { id: 'useful-status', label: 'Segment', options: ['Active', 'Inactive'], safe: true, denied: [] },
  { id: 'useful-open-closed', label: 'Estado', options: ['Open', 'Closed'], safe: true, denied: [] },
  { id: 'upper-handles', label: 'Segment', options: ['KORVATHEL52', 'MIRDASQO17'], safe: false, denied: ['KORVATHEL52', 'MIRDASQO17', 'mirdasqo17_rank'], header: 'KORVATHEL52', apiName: 'mirdasqo17_rank' },
  { id: 'lower-handles', label: 'Vendedor', options: ['vendrasko44', 'tolmequi29'], safe: false, denied: ['vendrasko44', 'tolmequi29', 'vendrasko'], header: 'tolmequi29', apiName: 'vendrasko44_rating' },
  { id: 'mixed-handles', label: 'Region', options: ['KorVathel52', 'MirDasqo17'], safe: false, denied: ['KorVathel52', 'MirDasqo17'], header: 'MirDasqo17' },
  { id: 'unicode-handles', label: 'Segmento', options: ['ŘEZVANI38', '瑛朔52'], safe: false, denied: ['ŘEZVANI38', '瑛朔52', '瑛朔'], header: '瑛朔52' },
  { id: 'plain-names', label: 'Vendedor', options: ['Ondriel Vaskemar', 'Pelsira Quontay'], safe: false, denied: ['Ondriel Vaskemar', 'Pelsira Quontay', 'Ondriel', 'Vaskemar', 'Pelsira', 'Quontay', 'ondriel_vaskemar'], header: 'Pelsira Quontay', apiName: 'ondriel_vaskemar' },
  { id: 'suffixed-names', label: 'Vendedor', options: ['Ondriel__c', 'Pelsira__c'], safe: false, denied: ['Ondriel__c', 'Pelsira__c', 'Ondriel', 'Pelsira', 'Vaskemar'], header: 'Pelsira__c', apiName: 'Ondriel_Vaskemar__c' },
  { id: 'lower-suffixed-names', label: 'Segment', options: ['ondriel__c', 'pelsira__c'], safe: false, denied: ['ondriel__c', 'pelsira__c', 'ondriel', 'pelsira'], header: 'ondriel__c', apiName: 'pelsira' },
  { id: 'snake-names', label: 'Segment', options: ['ondriel_vaskemar', 'pelsira_quontay'], safe: false, denied: ['ondriel_vaskemar', 'pelsira_quontay', 'ondriel', 'vaskemar', 'pelsira', 'quontay', 'ONDRIEL_VASKEMAR'], header: 'pelsira_quontay', apiName: 'ONDRIEL_VASKEMAR' },
  { id: 'pascal-names', label: 'Segment', options: ['OndrielVaskemar', 'PelsiraQuontay'], safe: false, denied: ['OndrielVaskemar', 'PelsiraQuontay', 'Ondriel', 'Vaskemar', 'Pelsira', 'Quontay'], header: 'PelsiraQuontay', apiName: 'OndrielVaskemar' },
  { id: 'upper-single-names', label: 'Vendedor', options: ['VASKEMAR', 'QUONTAY'], safe: false, denied: ['VASKEMAR', 'QUONTAY'], header: 'QUONTAY', apiName: 'VASKEMAR', text: true },
  { id: 'lower-single-names', label: 'Vendedor', options: ['vaskemar', 'quontay'], safe: false, denied: ['vaskemar', 'quontay'], header: 'quontay', apiName: 'vaskemar', text: true },
  { id: 'dotted-handles', label: 'Segment', options: ['o.vaskemar', 'p.quontay'], safe: false, denied: ['o.vaskemar', 'p.quontay', 'vaskemar', 'quontay'], header: 'p.quontay', text: true },
  // A vocabulary word that is also a surname (Klein) is the surname in a list that holds a suffixed name: the list is read whole.
  { id: 'homonym-beside-suffixed-name', label: 'Segment', options: ['Pelsira__c', 'Klein'], safe: false, denied: ['Pelsira__c', 'Pelsira', 'Klein'] },
  // A useful list under a deliverable field whose api name is a surname the lists know: the options travel, the api name does not, however it splits.
  { id: 'listed-surname-api-name', label: 'Segment', options: ['Active', 'Inactive'], safe: true, denied: ['rolland'], apiName: 'rolland' },
];

/** Every predicate a run of a vector must hold, as the list of those that failed. */
function judge(observed: Observed, vector: Vector): readonly string[] {
  const bad: string[] = [...usefulness(observed), ...leaks(observed, vector.denied)];
  // The contaminated column's own task still reaches the provider: withholding its values is not withholding the question.
  if (!observed.envelopes.some((envelope) => envelope.sourceProfile.fields.some((field) => field.fieldRef === observed.refs.status))) bad.push('status-task-sent');
  const statusExemplars = observed.envelopes.flatMap((envelope) => envelope.exemplars.filter((exemplar) => exemplar.fieldRef === observed.refs.status));
  const picklist = observed.envelopes.flatMap(targetFields).filter((field) => field.targetRef === observed.refs.picklist);
  if (vector.safe) {
    if (observed.mode !== 'CLEAN_ONLY' && !picklist.some((field) => vector.options.every((option) => field.options.includes(option)))) bad.push('useful-target-options');
    if (!statusExemplars.some((exemplar) => exemplar.dataLevel === 'L1' && vector.options.includes(exemplar.minimizedValueOrClass))) bad.push('useful-source-options');
  } else if (observed.mode === 'CLEAN_ONLY') {
    // No target lists the values as people here: a column the value channel reads as names or handles is withheld whole; one it reads as text may send a pure mask of a value as L2, never a value.
    if (vector.text === true ? statusExemplars.some((exemplar) => exemplar.dataLevel !== 'L2' || maskShape(exemplar.minimizedValueOrClass) !== exemplar.minimizedValueOrClass) : statusExemplars.length > 0) bad.push('unsafe-source-values-withheld');
  } else {
    if (picklist.length === 0) bad.push('target-field-retained');
    if (!picklist.every((field) => field.options.length === 0)) bad.push('unsafe-target-options-withheld');
    if (statusExemplars.length > 0) bad.push('unsafe-source-options-withheld');
  }
  if (vector.header !== undefined) {
    const headers = observed.envelopes.flatMap((envelope) => envelope.sourceProfile.fields.filter((field) => field.fieldRef === observed.refs.extra).map((field) => field.header));
    if (headers.length === 0 || !headers.every((header) => opaque('hdr').test(header))) bad.push(`opaque-header:${JSON.stringify([...new Set(headers)])}`);
    const patterns = observed.envelopes.flatMap((envelope) => envelope.memoryEvidence.map((item) => item.rule.sourceHeaderPattern));
    if (patterns.length === 0 || !patterns.every((pattern) => opaque('hdr').test(pattern))) bad.push(`opaque-memory-pattern:${JSON.stringify([...new Set(patterns)])}`);
  }
  if (vector.apiName !== undefined && observed.mode !== 'CLEAN_ONLY') {
    const apiNames = observed.envelopes.flatMap(targetFields).filter((field) => field.targetRef === observed.refs.apiField).map((field) => field.apiName);
    if (apiNames.length === 0 || !apiNames.every((apiName) => opaque('api').test(apiName))) bad.push(`opaque-api-name:${JSON.stringify([...new Set(apiNames)])}`);
  }
  return bad;
}

/** A repair round is a task that may carry masked shapes of text (SEMANTIC_REPAIR): the columns below must still send none of a value that is a name, whether the value channel reads the name itself or only the target's own list tells it. */
const THROUGH_REPAIR = ['historical-segment', 'suffixed-names', 'pascal-names', 'upper-single-names', 'lower-single-names', 'dotted-handles'];

for (const mode of MODES) {
  describe(`IC-05 ${mode} through a repair round: a repair round, which may carry masked shapes, carries none of a column its target lists as people`, () => {
    for (const vector of VECTORS.filter((entry) => THROUGH_REPAIR.includes(entry.id))) {
      it(`IC-05 ${mode} ${vector.id} through a repair round`, { timeout: 120_000 }, async () => {
        const observed = await runVector(mode as Mode, vector, { answer: throughRepair });
        const repaired = observed.envelopes.filter((envelope) => envelope.repairContext !== null && envelope.sourceProfile.fields.some((field) => field.fieldRef === observed.refs.status));
        assert.ok(repaired.length > 0 && repaired.every((envelope) => envelope.taskType === 'SEMANTIC_REPAIR'), `${mode} ${vector.id}: the Status column went through a repair round`);
        assert.deepEqual(judge(observed, vector), [], `${mode} ${vector.id}: ${JSON.stringify(observed.result.tasks.map((task) => [task.taskType, task.outcome, task.codes.slice(0, 2)]))}`);
      });
    }
  });
  describe(`IC-05 ${mode}: names and handles never leave through a whole public run, and the run stays useful`, () => {
    for (const vector of VECTORS) {
      it(`IC-05 ${mode} ${vector.id}`, { timeout: 120_000 }, async () => {
        const observed = await runVector(mode as Mode, vector);
        assert.deepEqual(judge(observed, vector), [], `${mode} ${vector.id}: ${JSON.stringify(observed.result.tasks.map((task) => [task.taskType, task.outcome, task.codes.slice(0, 2)]))}`);
      });
    }
  });
}
