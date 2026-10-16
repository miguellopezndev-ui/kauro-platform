import { CoreInvariantError } from '../util/assert.js';

/**
 * Where each artifact lives inside a package.
 *
 * Package format 2.0.0 separated the four things a package is for, physically
 * rather than by convention:
 *
 * ```text
 * 01_IMPORT/          what the operator feeds to the destination
 * 02_EXCEPTIONS/      what did not go, and why, for someone to act on
 * 03_TRACEABILITY/    what Kauro did, for someone to prove
 * 04_DOCUMENTATION/   what a person reads
 * manifest.json
 * ```
 *
 * In 1.1.0 all of these sat in one flat directory, so the file an operator must
 * import and the file that exists only to prove what happened looked alike. An
 * operator who imported the wrong one would have loaded Kauro's bookkeeping into
 * their CRM. The directory is the safeguard: everything under `01_IMPORT` is
 * meant to be imported, and nothing outside it is.
 *
 * The rest of the engine goes on naming artifacts by what they are — the
 * verifier asks for `leftovers.csv`, not for its address — and this module is
 * the single place that knows where that lands. A name with no area here is a
 * mistake rather than a default, because a new artifact that silently landed at
 * the package root would be a new file the operator cannot classify.
 */
export const IMPORT_AREA = '01_IMPORT';
export const EXCEPTIONS_AREA = '02_EXCEPTIONS';
export const TRACEABILITY_AREA = '03_TRACEABILITY';
export const DOCUMENTATION_AREA = '04_DOCUMENTATION';

const AREAS = [EXCEPTIONS_AREA, TRACEABILITY_AREA, DOCUMENTATION_AREA] as const;

/**
 * Neutralised copies of the import files that carry a cell a spreadsheet would
 * execute (package format 2.1.0, D72). One file per such import file, at the
 * import file's own path below this directory.
 */
export const DATA_VIEW_AREA = `${DOCUMENTATION_AREA}/data-view`;

/**
 * What a file in the package is, declared in the manifest for every artifact.
 *
 * `MACHINE_*` files hold exactly the values the engine decided on and the
 * verifier compares them byte for byte; `HUMAN_VIEW_CSV` files are for a person
 * with a spreadsheet and never hold a cell that spreadsheet would execute;
 * `DOCUMENT` is JSON or Markdown.
 */
export const ARTIFACT_KINDS = [
  'MACHINE_IMPORT_CSV',
  'MACHINE_EVIDENCE_CSV',
  'MACHINE_EXCEPTION_CSV',
  'HUMAN_VIEW_CSV',
  'DOCUMENT',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * The kind of every CSV this layout places, by name. A CSV with no entry here is
 * a mistake, never a default: a new table that silently became "exact" (or
 * "neutralised") would change what a verifier insists on.
 *
 * The 02_EXCEPTIONS inventory, one line each:
 *   isolated, leftovers, rejected-input, unmapped-fields, unresolved-associations,
 *   destination-conflicts, duplicate-candidates  MACHINE_EXCEPTION_CSV  they carry
 *       source text byte-exact, because the verifier joins them to the import files
 *       and the lineage on those values; a person reads them as text, or reads the
 *       neutralised data view of the import files
 *   formula-risk  HUMAN_VIEW_CSV  it exists to be read by a person: its value column
 *       is neutralised and value_sha256 names the exact value
 */
const CSV_KIND_BY_NAME = new Map<string, ArtifactKind>([
  ['isolated.csv', 'MACHINE_EXCEPTION_CSV'],
  ['leftovers.csv', 'MACHINE_EXCEPTION_CSV'],
  ['rejected-input.csv', 'MACHINE_EXCEPTION_CSV'],
  ['unmapped-fields.csv', 'MACHINE_EXCEPTION_CSV'],
  ['unresolved-associations.csv', 'MACHINE_EXCEPTION_CSV'],
  ['destination-conflicts.csv', 'MACHINE_EXCEPTION_CSV'],
  ['duplicate-candidates.csv', 'MACHINE_EXCEPTION_CSV'],
  ['formula-risk.csv', 'HUMAN_VIEW_CSV'],

  ['source-lineage.csv', 'MACHINE_EVIDENCE_CSV'],
  ['import-crosswalk.csv', 'MACHINE_EVIDENCE_CSV'],
  ['changes.csv', 'MACHINE_EVIDENCE_CSV'],
  ['flags.csv', 'MACHINE_EVIDENCE_CSV'],
  ['associations.csv', 'MACHINE_EVIDENCE_CSV'],
  ['destination-matching.csv', 'MACHINE_EVIDENCE_CSV'],
  ['instance-verification.csv', 'MACHINE_EVIDENCE_CSV'],
]);

/**
 * Which area each artifact belongs to.
 *
 * An artifact is an exception when a person has to decide something about it: a
 * row that reached no destination, a field nothing mapped, a relationship whose
 * endpoint was never found, a pair that looked like one record and was not
 * merged. It is traceability when it is evidence of what the run did: lineage,
 * changes, flags, merges, matching decisions, the reconciliation and the exact
 * configuration the run was given.
 */
const AREA_BY_NAME = new Map<string, string>([
  // 02_EXCEPTIONS — someone has to look at these.
  ['isolated.csv', EXCEPTIONS_AREA],
  ['leftovers.csv', EXCEPTIONS_AREA],
  ['rejected-input.csv', EXCEPTIONS_AREA],
  ['unmapped-fields.csv', EXCEPTIONS_AREA],
  ['unresolved-associations.csv', EXCEPTIONS_AREA],
  ['destination-conflicts.csv', EXCEPTIONS_AREA],
  ['duplicate-candidates.csv', EXCEPTIONS_AREA],
  ['formula-risk.csv', EXCEPTIONS_AREA],

  // 03_TRACEABILITY — what happened, so it can be proved.
  ['source-lineage.csv', TRACEABILITY_AREA],
  ['import-crosswalk.csv', TRACEABILITY_AREA],
  ['changes.csv', TRACEABILITY_AREA],
  ['flags.csv', TRACEABILITY_AREA],
  ['associations.csv', TRACEABILITY_AREA],
  ['destination-matching.csv', TRACEABILITY_AREA],
  ['instance-verification.csv', TRACEABILITY_AREA],
  ['merges.json', TRACEABILITY_AREA],
  ['reconciliation.json', TRACEABILITY_AREA],
  ['config.normalized.json', TRACEABILITY_AREA],

  // 04_DOCUMENTATION — what a person reads.
  ['audit.md', DOCUMENTATION_AREA],
  ['import-instructions.md', DOCUMENTATION_AREA],
]);

/**
 * The kind a package of this format must declare for the artifact at `path`.
 *
 * Derived from the path alone, so the writer declares it and the verifier
 * re-derives it without trusting the manifest.
 */
export function artifactKind(path: string): ArtifactKind {
  if (path.startsWith(`${IMPORT_AREA}/`) && path.endsWith('.csv')) return 'MACHINE_IMPORT_CSV';
  if (path.startsWith(`${DATA_VIEW_AREA}/`) && path.endsWith('.csv')) return 'HUMAN_VIEW_CSV';
  if (!path.endsWith('.csv')) return 'DOCUMENT';
  const kind = CSV_KIND_BY_NAME.get(logicalName(path));
  if (kind === undefined) {
    throw new CoreInvariantError('PACKAGE_LAYOUT_COMPLETE', `${path} is a CSV with no declared kind`, { path });
  }
  return kind;
}

/** Where the neutralised copy of an import file lives: `01_IMPORT/x/y.csv` becomes `04_DOCUMENTATION/data-view/x/y.csv`. */
export function dataViewPathFor(importPath: string): string {
  if (!importPath.startsWith(`${IMPORT_AREA}/`)) {
    throw new CoreInvariantError('PACKAGE_LAYOUT_COMPLETE', `${importPath} is not an import file`, { importPath });
  }
  return `${DATA_VIEW_AREA}/${importPath.slice(IMPORT_AREA.length + 1)}`;
}

/** The import file a data view is a copy of, or null when `path` is not a data view. */
export function importPathForDataView(path: string): string | null {
  return path.startsWith(`${DATA_VIEW_AREA}/`) ? `${IMPORT_AREA}/${path.slice(DATA_VIEW_AREA.length + 1)}` : null;
}

/** The manifest names every other artifact, so it sits above all of them. */
export const MANIFEST_PATH = 'manifest.json';

/**
 * The path an artifact is written to and read from, given what it is called.
 *
 * A name that already carries a directory is already a path — import files are
 * addressed by the vendor layout the operator sees, not by a lookup here.
 */
export function packagePath(name: string): string {
  if (name.includes('/')) return name;
  if (name === MANIFEST_PATH) return name;
  const area = AREA_BY_NAME.get(name);
  if (area === undefined) {
    throw new CoreInvariantError(
      'PACKAGE_LAYOUT_COMPLETE',
      `${name} belongs to no area of the package layout`,
      { name },
    );
  }
  return `${area}/${name}`;
}

/**
 * The name an artifact is known by, given where it was found.
 *
 * The inverse of `packagePath` for everything the layout places, and the
 * identity for import files, which are addressed by their path everywhere.
 */
export function logicalName(path: string): string {
  for (const area of AREAS) {
    const prefix = `${area}/`;
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}

/** Every artifact this layout knows how to place, by name. */
export function placedArtifactNames(): readonly string[] {
  return [...AREA_BY_NAME.keys()];
}
