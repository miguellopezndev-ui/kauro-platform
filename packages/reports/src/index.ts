/**
 * @kauro/reports — B13 reports and package experience (design docs/design/B13-report-model.md).
 *
 * - package: reads one Migration Core 3.0.0 package from bytes and refuses it unless its inventory, bytes, record counts and
 *   reconciliation agree (`readMigrationPackage`);
 * - model: the verified report model, every figure with its source in the package (`buildReportModel`), and the registry
 *   ReportSnapshot with the model hash.
 *
 * Pure: the caller reads and stores bytes; HTML/PDF rendering happens in the worker over this model.
 */
export { readMigrationPackage, isSafePackagePath, SUPPORTED_CORE_VERSION, SUPPORTED_PACKAGE_FORMAT, OBJECT_ORDER, AREAS, ARTIFACT_KINDS } from "./package.js";
export type { VerifiedPackage, PackageArtifact, PackageInput, PackageFiles, Reconciliation, Area, ArtifactKind, CoreObject } from "./package.js";
export { buildReportModel, REPORT_MODEL_VERSION, REPORT_MODEL_DOMAIN } from "./model.js";
export type { ReportModel, VerifiedReport, PlatformFacts, Figure, FigureSource, Branding, LegalIssuer, ReportArtifact, ImportStep, ReportInput, ArtifactUse, PrivacyClass } from "./model.js";
export { ReportModelError, PROBLEM_CODES } from "./problems.js";
export type { Problem, ProblemCode } from "./problems.js";
