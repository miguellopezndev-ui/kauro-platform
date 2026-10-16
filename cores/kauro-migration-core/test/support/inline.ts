import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_SCHEMA_VERSION } from '../../src/domain/config.js';
import { loadConfig } from '../../src/mapping/load-config.js';
import { runMigration } from '../../src/run/run-migration.js';
import type { RunResult } from '../../src/run/run-migration.js';
import { writeAndPromotePackage } from '../../src/artifacts/write-package.js';
import { verifyPackage } from '../../src/verify/verify-package.js';
import type { VerificationReport } from '../../src/verify/verify-package.js';
import { renderCsv } from '../../src/artifacts/csv-writer.js';
import { caseScratch, scratchDir, verifyScratch } from './harness.js';

/**
 * A small migration written in the test itself.
 *
 * The bytes the engine reads are the bytes the test wrote, so the expected
 * truth can be stated from the input and never from the engine's own output.
 * The configuration version is the engine's own, so one helper serves the
 * schema before and after a version change.
 */
export interface InlineRun {
  readonly run: RunResult;
  readonly packageDir: string;
  readonly verification: VerificationReport;
}

export type InlineField = Record<string, unknown>;

export interface InlineOptions {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly fields: readonly InlineField[];
  /** The whole record mapping is merged over these. */
  readonly record?: Record<string, unknown>;
  /** The whole configuration is merged over these. */
  readonly config?: Record<string, unknown>;
}

export function inlineConfig(options: Pick<InlineOptions, 'fields' | 'record' | 'config'>, namespace: string): Record<string, unknown> {
  return {
    configVersion: CONFIG_SCHEMA_VERSION,
    source: { system: 'generic_csv', namespace },
    target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
    files: [{ id: 'contacts', path: 'contacts.csv', format: 'CSV' }],
    records: [
      {
        id: 'contacts',
        fileId: 'contacts',
        object: 'CONTACT',
        sourceRecordIdColumn: { header: 'Contact ID' },
        fields: options.fields,
        ...(options.record ?? {}),
      },
    ],
    ...(options.config ?? {}),
  };
}

export function runInline(name: string, options: InlineOptions): InlineRun {
  const root = scratchDir('inline', name);
  const inputDir = join(root, 'input');
  mkdirSync(inputDir, { recursive: true });
  writeFileSync(
    join(inputDir, 'contacts.csv'),
    Buffer.from(renderCsv([...options.headers], options.rows.map((row) => [...row])), 'utf8'),
  );
  const config = inlineConfig(options, name);
  const loaded = loadConfig(JSON.stringify(config), `inline:${name}`);
  const run = runMigration({
    scratch: caseScratch(`inline-${name}`),
    inputRoot: inputDir,
    config: loaded.config,
    configHash: loaded.configHash,
  });
  const packageDir = join(root, 'package');
  writeAndPromotePackage({
    result: run,
    config: loaded.config,
    normalizedConfig: loaded.normalizedJson,
    outputDir: packageDir,
    force: true,
  });
  const verification = verifyPackage(packageDir, { scratch: verifyScratch(packageDir) });
  return { run, packageDir, verification };
}

export function textField(header: string, destinationField: string, options: Record<string, unknown> = {}): InlineField {
  return {
    column: { header },
    destinationField,
    semanticType: 'TEXT',
    ...(Object.keys(options).length === 0 ? {} : { options }),
  };
}
