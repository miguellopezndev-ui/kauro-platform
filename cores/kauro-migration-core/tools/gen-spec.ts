/**
 * Writes the machine-readable specification files under spec/.
 *
 * The TypeScript declarations are the single source of truth; these JSON files
 * are generated from them so that an external reviewer can read the contract
 * without reading the code. `--check` re-generates and fails if the committed
 * files have drifted, which is what keeps the two honest.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_SCHEMA } from '../src/mapping/config-schema.js';
import { schemaToJson } from '../src/mapping/schema-validator.js';
import { REASON_CATEGORIES, REASON_CODES, REASON_CODE_LIST } from '../src/domain/reason-codes.js';
import { EDGE_DISPOSITIONS, ROW_DISPOSITIONS } from '../src/domain/disposition.js';
import { CANONICAL_FIELDS, CANONICAL_FIELD_LIST, CANONICAL_OBJECTS, SEMANTIC_TYPES } from '../src/domain/canonical.js';
import { RELATIONSHIP_SHAPES, RELATIONSHIP_TYPES } from '../src/domain/associations.js';
import { ERROR_CODES } from '../src/domain/errors.js';
import { ALL_ADAPTERS } from '../src/adapters/specs.js';
import { canonicalJsonText } from '../src/util/json.js';
import type { JsonObject, JsonValue } from '../src/util/json.js';
import { CORE_VERSION, PACKAGE_FORMAT_VERSION, SOURCE_REGISTRY_VERSION } from '../src/version.js';
import { CONFIG_SCHEMA_VERSION } from '../src/domain/config.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');

function targets(): { path: string; text: string }[] {
  const configSchema: JsonObject = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://kauro.dev/schema/migration-config/${CONFIG_SCHEMA_VERSION}`,
    title: `kauro-migration-core configuration ${CONFIG_SCHEMA_VERSION}`,
    ...(schemaToJson(CONFIG_SCHEMA) as JsonObject),
  };

  const reasonCodes: JsonObject = {
    version: CORE_VERSION,
    categories: [...REASON_CATEGORIES],
    codes: REASON_CODE_LIST.map((code) => ({
      code,
      category: REASON_CODES[code].category,
      description: REASON_CODES[code].description,
    })),
  };

  const contract: JsonObject = {
    coreVersion: CORE_VERSION,
    packageFormatVersion: PACKAGE_FORMAT_VERSION,
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    rowDispositions: [...ROW_DISPOSITIONS],
    edgeDispositions: [...EDGE_DISPOSITIONS],
    errorCodes: [...ERROR_CODES],
    canonicalObjects: [...CANONICAL_OBJECTS],
    semanticTypes: [...SEMANTIC_TYPES],
    canonicalFields: CANONICAL_FIELD_LIST.map((name) => ({
      name,
      object: CANONICAL_FIELDS[name].object,
      semanticsClass: CANONICAL_FIELDS[name].semanticsClass,
      description: CANONICAL_FIELDS[name].description,
    })),
    relationshipTypes: RELATIONSHIP_TYPES.map((type) => ({
      type,
      from: RELATIONSHIP_SHAPES[type].from,
      to: RELATIONSHIP_SHAPES[type].to,
      description: RELATIONSHIP_SHAPES[type].description,
    })),
  };

  const sourceRegistry: JsonObject = {
    sourceRegistryVersion: SOURCE_REGISTRY_VERSION,
    adapters: ALL_ADAPTERS.map((adapter) => ({
      vendor: adapter.mode,
      adapterVersion: adapter.version,
      fileConstraints: { ...adapter.fileConstraints } as unknown as JsonValue,
      associationKeyHeader: adapter.associationKeyHeader,
      booleanText: { ...adapter.booleanText },
      objects: adapter.objects.map((spec) => ({
        object: spec.object,
        fileName: spec.fileName,
        supportedModes: [...spec.supportedModes],
        requiredForCreate: [...spec.requiredForCreate],
        requiredAnyOf: spec.requiredAnyOf.map((group) => [...group]),
        destinationMatchingKeys: [...spec.destinationMatchingKeys],
        fields: spec.fields.map((field) => ({
          canonicalField: field.canonicalField,
          header: field.header,
          maxLength: field.maxLength,
        })),
        notes: [...spec.notes],
      })),
      relationships: Object.fromEntries(
        RELATIONSHIP_TYPES.map((type) => {
          const support = adapter.relationships[type];
          return [
            type,
            support.kind === 'SUPPORTED'
              ? { kind: support.kind, strategy: support.strategy, operatorInstructions: support.operatorInstructions }
              : { kind: support.kind, reason: support.reason },
          ];
        }),
      ),
      instanceVerification: adapter.instanceVerification.map((item) => ({ ...item })),
      sources: adapter.sources.map((source) => ({ ...source })),
    })),
  };

  return [
    { path: 'spec/contract/config.schema.json', text: canonicalJsonText(configSchema) },
    { path: 'spec/contract/reason-codes.json', text: canonicalJsonText(reasonCodes) },
    { path: 'spec/contract/contract.json', text: canonicalJsonText(contract) },
    { path: 'spec/vendor/source-registry.json', text: canonicalJsonText(sourceRegistry) },
  ];
}

function run(): void {
  const check = process.argv.includes('--check');
  const drift: string[] = [];

  for (const target of targets()) {
    const absolute = join(repoRoot, ...target.path.split('/'));
    if (check) {
      let current: string;
      try {
        current = readFileSync(absolute, 'utf8');
      } catch {
        drift.push(`${target.path} is missing`);
        continue;
      }
      if (current !== target.text) drift.push(`${target.path} is out of date`);
      continue;
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, Buffer.from(target.text, 'utf8'));
  }

  if (check) {
    if (drift.length > 0) {
      process.stderr.write(`the committed specification files do not match the code:\n`);
      for (const item of drift) process.stderr.write(`  ${item}\n`);
      process.stderr.write('Run "npm run spec:gen" and commit the result.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('specification files are up to date\n');
    return;
  }

  process.stdout.write(`wrote ${String(targets().length)} specification files\n`);
}

run();
