// BLK-MC: the architecture gate reads the consumer's observation off its verdict line. The line also carries the validity
// record, so a greedy `{...}` match spanned both objects, never parsed, and left consumer_report_bound false on every run.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { consumerObservation } from '../lib/consumer-observation.mjs';

const observed = { version: '0.6.0', state: 'PROPOSAL_READY', mcCore: '3.1.0', runDir: 'C:\\tmp\\run {x} "y"', nested: { a: [1, { b: '}' }] } };
const validity = { recordDigest: 'a'.repeat(64), binding: { migrationCoreVersion: '3.1.0' } };

test('the observation is the first object after the verdict, not the span to the validity record', () => {
  const stdout = `noise {"not":"this"}\nINTELLIGENCE-CONSUMER-01 = PASS: ${JSON.stringify(observed)} validity ${JSON.stringify(validity)} \n`;
  assert.deepEqual(consumerObservation(stdout), observed);
});

test('a FALSE verdict is read the same way, with its problems after the validity record', () => {
  const stdout = `INTELLIGENCE-CONSUMER-01 = FALSE: ${JSON.stringify(observed)} validity null the consumer run ended FAILED_COMPILER / NOT_DRAFTABLE\n`;
  assert.deepEqual(consumerObservation(stdout), observed);
});

test('no verdict line, or no object after it, is no observation', () => {
  assert.equal(consumerObservation('INTELLIGENCE-CONSUMER-01 = PASS: not json'), null);
  assert.equal(consumerObservation('{"state":"PROPOSAL_READY"}'), null);
  assert.equal(consumerObservation('INTELLIGENCE-CONSUMER-01 = PASS: {"cut":'), null);
});

test('the architecture gate reads the consumer through this parser, and consumer-check prints the line it parses', () => {
  const gate = readFileSync(new URL('../architecture-gate.mjs', import.meta.url), 'utf8');
  assert.match(gate, /const observed = consumerObservation\(consumer\.stdout\);/u);
  const consumer = readFileSync(new URL('../consumer-check.mjs', import.meta.url), 'utf8');
  assert.match(consumer, /'INTELLIGENCE-CONSUMER-01 = PASS' : 'INTELLIGENCE-CONSUMER-01 = FALSE'\}: \$\{JSON\.stringify\(report\.observed\)\} validity /u);
});

test('the sabotage copies carry the sealed corpus the B04 suites read', () => {
  const sabotage = readFileSync(new URL('../sabotage.mjs', import.meta.url), 'utf8');
  assert.match(sabotage, /for \(const entry of \[[^\]]*'corpus'[^\]]*\]\) cpSync\(join\(root, entry\), join\(copy, entry\)/u);
});
