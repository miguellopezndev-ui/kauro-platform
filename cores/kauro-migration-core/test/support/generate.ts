import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { renderCsv } from '../../src/artifacts/csv-writer.js';
import { scratchDir } from './harness.js';

/**
 * Arbitrary contact sheets for the property suite.
 *
 * Values deliberately include the characters that break naive CSV handling —
 * quotes, commas, newlines, leading and trailing spaces, non-Latin scripts —
 * because the properties are only worth anything if the generator can produce
 * the inputs that would break them.
 */

export const awkwardText = fc.oneof(
  fc.string({ minLength: 0, maxLength: 12 }),
  fc.constantFrom(
    '',
    ' ',
    '  padded  ',
    'quote"inside',
    'comma,inside',
    'line\nbreak',
    'Núñez',
    '山田',
    '=SUM(A1)',
    '+15551234567',
    '-not-a-number',
    '@mention',
    '007',
    '0000000000000001',
  ),
);

export interface GeneratedSheet {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export const contactSheet = (options: { minRows?: number; maxRows?: number } = {}): fc.Arbitrary<GeneratedSheet> =>
  fc
    .array(fc.tuple(awkwardText, awkwardText, awkwardText, awkwardText), {
      minLength: options.minRows ?? 1,
      maxLength: options.maxRows ?? 12,
    })
    .map((rows) => ({
      headers: ['Contact ID', 'First Name', 'Last Name', 'Email'],
      rows: rows.map((row, index) => [String(index + 1), row[1], row[2], row[3]]),
    }));

/** Writes a generated sheet plus a configuration into a fresh scratch directory. */
export function materialize(
  name: string,
  sheet: GeneratedSheet,
  configOverrides: Record<string, unknown> = {},
): { inputDir: string; configPath: string } {
  const root = scratchDir('generated', name);
  const inputDir = join(root, 'input');
  mkdirSync(inputDir, { recursive: true });
  writeFileSync(join(inputDir, 'contacts.csv'), Buffer.from(renderCsv(sheet.headers, sheet.rows), 'utf8'));

  const config = {
    configVersion: '3.0.0',
    source: { system: 'generated', namespace: name },
    target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
    files: [{ id: 'contacts', path: 'contacts.csv', format: 'CSV' }],
    records: [
      {
        id: 'contacts',
        fileId: 'contacts',
        object: 'CONTACT',
        sourceRecordIdColumn: { header: 'Contact ID' },
        fields: [
          { column: { header: 'First Name' }, destinationField: 'contact.firstName', semanticType: 'TEXT' },
          { column: { header: 'Last Name' }, destinationField: 'contact.lastName', semanticType: 'TEXT' },
          { column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' },
        ],
      },
    ],
    ...configOverrides,
  };

  const configPath = join(root, 'config.json');
  writeFileSync(configPath, Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'));
  return { inputDir, configPath };
}

/** Deterministic shuffle driven by a generated permutation, so failures reproduce exactly. */
export function applyPermutation<T>(items: readonly T[], permutation: readonly number[]): T[] {
  const remaining = [...items];
  const out: T[] = [];
  for (const raw of permutation) {
    if (remaining.length === 0) break;
    const index = Math.abs(raw) % remaining.length;
    out.push(...remaining.splice(index, 1));
  }
  out.push(...remaining);
  return out;
}

export { fc };
