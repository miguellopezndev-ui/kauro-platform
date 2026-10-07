# @kauro/reports

B13 "Reports and package experience": the verified report model (design `docs/design/B13-report-model.md`).

Pure TypeScript over `@kauro/contracts` only. It reads bytes it is handed and never touches a filesystem, network or clock;
HTML and PDF are rendered in the worker over the model this package builds.

## Modules

- `package` — `readMigrationPackage(files)`: reads one Migration Core 3.0.0 package (format 2.1.0) and refuses it unless its
  closed inventory, every length, SHA-256 and record count, and the reconciliation's equations agree with the bytes; the
  reconciliation is cross-checked against the import files, the crosswalk and the lineage (CMD039).
- `model` — `buildReportModel(pkg, facts)`: every figure carries the package file and locator it came from; the billable
  source units come from the frozen quote and stand beside the physical rows and the output rows (R2-065); the import
  guide names only `01_IMPORT` machine files (R2-069); the issuer comes from the terms snapshot, never from branding (R2-070);
  the registry `ReportSnapshot` with the canonical model hash.
- `problems` — the closed refusal vocabulary; a refusal never quotes a value from inside a file.
- `csv` — strict UTF-8, RFC 4180 record reading.

## Tests

`test/fixtures/mc-3.0.0` holds byte-exact copies of the core's five acceptance packages (`PROVENANCE.json`; `.gitattributes`
keeps git from rewriting their bytes). The oracles are independent of this package: the core's own `acceptance.json`
manifest hashes and README table, and a separate implementation of `kauro-package-digest/1`.
