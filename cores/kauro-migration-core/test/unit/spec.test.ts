import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { REASON_CATEGORIES, REASON_CODES, REASON_CODE_LIST, isReasonCode } from '../../src/domain/reason-codes.js';
import { EDGE_DISPOSITIONS, ROW_DISPOSITIONS } from '../../src/domain/disposition.js';
import { ERROR_CODES } from '../../src/domain/errors.js';
import { CANONICAL_FIELDS, CANONICAL_FIELD_LIST } from '../../src/domain/canonical.js';
import { CORE_VERSION, PACKAGE_FORMAT_VERSION, SOURCE_REGISTRY_VERSION } from '../../src/version.js';
import { canonicalJsonText, parseJson } from '../../src/util/json.js';
import { repoRoot } from '../support/harness.js';
import type { JsonObject } from '../../src/util/json.js';

describe('versions', () => {
  it('the declared core version matches package.json', () => {
    const pkg = parseJson(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as JsonObject;
    assert.equal(pkg['version'], CORE_VERSION);
  });

  it('the package format and source registry versions are declared', () => {
    assert.match(PACKAGE_FORMAT_VERSION, /^\d+\.\d+\.\d+$/u);
    assert.match(SOURCE_REGISTRY_VERSION, /^\d{4}-\d{2}-\d{2}$/u);
  });
});

describe('the reason code registry', () => {
  it('describes every code in plain English', () => {
    for (const code of REASON_CODE_LIST) {
      const definition = REASON_CODES[code];
      assert.ok(REASON_CATEGORIES.includes(definition.category), `${code} has no valid category`);
      assert.ok(definition.description.length > 25, `${code} needs a real description`);
      assert.ok(
        definition.description.endsWith('.'),
        `${code} description should be a sentence`,
      );
      assert.ok(
        !/\b(leverage|utilize|optimi[sz]e|intelligen|AI|robust)\b/iu.test(definition.description),
        `${code} description reads like filler`,
      );
    }
  });

  it('is exported in sorted order', () => {
    assert.deepEqual([...REASON_CODE_LIST], [...REASON_CODE_LIST].sort());
  });

  it('recognises its own codes and nothing else', () => {
    assert.equal(isReasonCode('TRANSFORM_UNCHANGED'), true);
    assert.equal(isReasonCode('NOT_A_REAL_CODE'), false);
    assert.equal(isReasonCode('toString'), false);
  });
});

describe('the committed specification', () => {
  const read = (relativePath: string): JsonObject =>
    parseJson(readFileSync(join(repoRoot(), ...relativePath.split('/')), 'utf8')) as JsonObject;

  it('lists the same reason codes as the registry', () => {
    const spec = read('spec/contract/reason-codes.json');
    const codes = (spec['codes'] as { code: string; description: string }[]).map((entry) => entry.code);
    assert.deepEqual(codes, [...REASON_CODE_LIST]);
  });

  it('lists the same dispositions, error codes and canonical fields', () => {
    const contract = read('spec/contract/contract.json');
    assert.deepEqual(contract['rowDispositions'], [...ROW_DISPOSITIONS]);
    assert.deepEqual(contract['edgeDispositions'], [...EDGE_DISPOSITIONS]);
    assert.deepEqual(contract['errorCodes'], [...ERROR_CODES]);
    const fields = (contract['canonicalFields'] as { name: string }[]).map((entry) => entry.name);
    assert.deepEqual(fields, [...CANONICAL_FIELD_LIST]);
  });

  it('marks the consent fields as consent fields', () => {
    const contract = read('spec/contract/contract.json');
    const consent = (contract['canonicalFields'] as { name: string; semanticsClass: string }[])
      .filter((entry) => entry.semanticsClass === 'CONSENT')
      .map((entry) => entry.name);
    assert.deepEqual(consent, [
      'contact.doNotCall',
      'contact.doNotEmail',
      'contact.marketingConsent',
      'lead.doNotCall',
      'lead.doNotEmail',
    ]);
    for (const name of consent) {
      assert.equal(CANONICAL_FIELDS[name as keyof typeof CANONICAL_FIELDS].semanticsClass, 'CONSENT');
    }
  });

  it('is written in the canonical JSON form the engine uses everywhere', () => {
    for (const path of [
      'spec/contract/reason-codes.json',
      'spec/contract/contract.json',
      'spec/contract/config.schema.json',
      'spec/vendor/source-registry.json',
    ]) {
      const text = readFileSync(join(repoRoot(), ...path.split('/')), 'utf8');
      assert.equal(text, canonicalJsonText(parseJson(text)), `${path} is not canonical JSON`);
      assert.ok(!text.includes('\r'), `${path} must not contain carriage returns`);
    }
  });
});

describe('the contract document', () => {
  const contract = readFileSync(join(repoRoot(), 'docs', 'CONTRACT.md'), 'utf8');

  it('names every row disposition', () => {
    for (const disposition of ROW_DISPOSITIONS) {
      assert.ok(contract.includes(disposition), `CONTRACT.md does not mention ${disposition}`);
    }
  });

  it('states the row conservation equation', () => {
    assert.ok(contract.includes('SOURCE_ROWS = OUTPUT + MERGED_PROVEN + ISOLATED + LEFTOVER + REJECTED_INPUT'));
  });
});
