import { createHash } from 'node:crypto';
import type { CanonicalObject } from '../domain/canonical.js';
import { relationshipShape } from '../domain/associations.js';
import type { MigrationConfig } from '../domain/config.js';

/**
 * The key two import files share so the destination can join them.
 *
 * Package format 1.1.0 used the Kauro trace key for this, on every import file
 * whether or not anything was associated. That put Kauro's own bookkeeping in
 * front of the operator as though it were data to import, and it meant the one
 * identifier that ties a delivered record to its source rows was handed to the
 * destination -- so an operator who mapped the column would have stored Kauro's
 * internal identity inside their CRM, and a later export of that CRM would have
 * carried it back out.
 *
 * So the import key is deliberately not the trace key. It is derived from the
 * run id and the migration key, which makes it:
 *
 *   deterministic -- the same run produces the same key for the same record,
 *   whatever order or chunk size the rows arrived in;
 *
 *   not derivable from the trace key -- the run identity is part of the
 *   digest, so a key left behind in a CRM cannot be matched against the
 *   traceability of some other package by hashing that package's trace keys.
 *   The engine is byte-reproducible, so re-running the same core over the same
 *   configuration and the same source bytes does produce the same key; what it
 *   is not is a stable pseudonym for the record independent of the run;
 *
 *   opaque -- it is a digest, so it discloses nothing about the source row, and
 *   nothing about the source can be read back out of a CRM that kept it.
 *
 * The only way back from an import key to a source row is
 * `03_TRACEABILITY/import-crosswalk.csv`, which is where the connection
 * belongs: whoever holds the package can follow it, and the destination cannot.
 */
const IMPORT_KEY_HEX = 24;

export function importKeyFor(runId: string, migrationKey: string): string {
  return createHash('sha256')
    .update(runId, 'utf8')
    .update(String.fromCharCode(0), 'utf8')
    .update(migrationKey, 'utf8')
    .digest('hex')
    .slice(0, IMPORT_KEY_HEX);
}

/**
 * The objects whose import file needs the association key column.
 *
 * Read from the plan, not from the edges that came out, for two reasons. The
 * verifier has to be able to rebuild the expected header set from the package's
 * own configuration without walking the association evidence; and a plan that
 * declares a relationship should produce files an operator can associate even
 * where this particular dataset happened to resolve none of them, because
 * otherwise the same configuration would produce two different file shapes
 * depending on the data.
 */
export function objectsNeedingImportKey(config: MigrationConfig): ReadonlySet<CanonicalObject> {
  const objects = new Set<CanonicalObject>();
  for (const association of config.associations) {
    const shape = relationshipShape(association.relationshipType);
    objects.add(shape.from);
    objects.add(shape.to);
  }
  return objects;
}
