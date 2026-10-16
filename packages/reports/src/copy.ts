/**
 * Every text the report prints that is not a value from the model, keyed by locale (owner R-E3: English, en-US, by default and
 * as the fallback for any missing key; another locale is added later as a catalog, never by default). Placeholders are `{name}`.
 * Wording follows amendment A3: "Prepared for import", never "Imported"; no AI in any heading; duplicates are "unified with
 * approval", never "deleted"; no compatibility or savings claims.
 */
export const REPORT_COPY = {
  "en-US": {
    "doc.title": "Import package report",
    "doc.preparedFor": "Prepared by {brand}",
    "doc.issuer": "Service provided by {legalName} ({jurisdiction}, {registrationId}) under terms {termsVersion}",
    "doc.status": "Prepared for import. Nothing has been written to any CRM; your team imports these files.",
    "counts.heading": "Counts",
    "counts.unbound": "These counts come from the package files. They have not yet been reconciled with the platform record for this order.",
    "counts.physicalSourceRows": "Source rows",
    "counts.physicalSourceRows.definition": "Data rows read from your files, before they were split into objects.",
    "counts.logicalSourceRecords": "Source records",
    "counts.logicalSourceRecords.definition": "Rows that describe a record (company, contact, deal or lead), as opposed to a relationship.",
    "counts.billableSourceUnits": "Billable source units",
    "counts.billableSourceUnits.definition": "The units your quote was priced on, fixed when the order was placed.",
    "counts.associationEdges": "Relationships found",
    "counts.associationEdges.definition": "Links between records found in your files.",
    "counts.emittedRepresentatives": "Rows delivered",
    "counts.emittedRepresentatives.definition": "Source rows represented in the import files.",
    "counts.mergedNonSurvivors": "Rows unified with approval",
    "counts.mergedNonSurvivors.definition": "Rows proven to describe the same record as another row and unified into it; each one is traced.",
    "counts.rejected": "Rows not readable",
    "counts.rejected.definition": "Rows that could not be read, each listed with its reason.",
    "counts.withheld": "Rows held back",
    "counts.withheld.definition": "Rows kept out of the import files on purpose, each listed with its reason.",
    "counts.unresolved": "Rows without a decision",
    "counts.unresolved.definition": "Always zero in a delivered package.",
    "counts.emittedArtifactRows": "Rows in the import files",
    "counts.emittedArtifactRows.definition": "Lines in the files to import, not counting headers. Not the same measure as source rows.",
    "objects.heading": "Records prepared for import, by object",
    "relationships.heading": "Relationships",
    "relationships.delivered": "Prepared for import",
    "relationships.leftover": "Not supported by the destination",
    "relationships.unresolved": "Endpoint not found",
    "relationships.deduplicated": "Repeated",
    "guide.heading": "Import guide",
    "guide.onlyImport": "Import the files under 01_IMPORT and nothing else, in the order below. Every other file is evidence for review.",
    "guide.object": "Object: {object}",
    "guide.records": "Expected records:",
    "guide.sha256": "SHA-256: {sha256}",
    "guide.part": "Part {part} of {parts}",
    "guide.association": "Relationship file: {from} to {to}",
    "exceptions.heading": "Exceptions to review",
    "exceptions.note": "Totals are complete. The full rows are in each file of the package, not in this report.",
    "artifacts.heading": "Package contents",
    "artifacts.use.IMPORT": "Import",
    "artifacts.use.EXCEPTION": "Review, not for import",
    "artifacts.use.TRACEABILITY": "Evidence, not for import",
    "artifacts.use.HUMAN_VIEW": "Safe to open in a spreadsheet, not for import",
    "artifacts.use.DOCUMENT": "Document, not for import",
    "lineage.heading": "Source files",
    "lineage.rows": "Data rows",
    "table.file": "File",
    "table.records": "Records",
    "table.use": "Use",
    "table.sha256": "SHA-256",
    "table.object": "Object",
    "table.count": "Count",
    "table.measure": "Measure",
    "table.definition": "Definition",
    "footer.identity": "Package {packageDigest}, manifest {manifestSha256}, core {coreVersion}, report model {modelHash}, renderer {rendererVersion}.",
  },
} as const;

export type ReportLocale = keyof typeof REPORT_COPY;
export type CopyKey = keyof (typeof REPORT_COPY)["en-US"];

const DEFAULT_LOCALE: ReportLocale = "en-US";

/** The catalog a document in `locale` is written from: `locale` itself when the catalog has it, else English. */
export function resolveLocale(locale: string): ReportLocale {
  return Object.hasOwn(REPORT_COPY, locale) ? (locale as ReportLocale) : DEFAULT_LOCALE;
}

/** The text for `key` in `locale`, falling back to English for an unknown locale or a missing key. */
export function copyText(locale: string, key: CopyKey, values: Readonly<Record<string, string>> = {}): string {
  const catalog = (REPORT_COPY as Record<string, Partial<Record<CopyKey, string>>>)[locale];
  const template = catalog?.[key] ?? REPORT_COPY[DEFAULT_LOCALE][key];
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new TypeError(`copy ${key}: no value for {${name}}`);
    return value;
  });
}
