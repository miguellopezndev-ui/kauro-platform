/**
 * @kauro/reports — B13 reports and package experience (design docs/design/B13-report-model.md).
 *
 * - package: reads one Migration Core 3.0.0 package from bytes and refuses it unless its inventory, bytes, record counts and
 *   reconciliation agree with its evidence tables (`readMigrationPackage`);
 * - model: the verified report model, every figure with its source in the package (`buildReportModel`), bound to the platform's
 *   record of the package, and the registry ReportSnapshot with the model hash.
 *
 * Pure: the caller reads and stores bytes; HTML/PDF rendering happens in the worker over this model.
 */
export { readMigrationPackage, isVerifiedPackage, isSafePackagePath, SUPPORTED_CORE_VERSION, SUPPORTED_PACKAGE_FORMAT, OBJECT_ORDER, AREAS, ARTIFACT_KINDS, TARGET_MODES, IMPORT_MODES } from "./package.js";
export type { VerifiedPackage, PackageArtifact, PackageInput, PackageFiles, Reconciliation, ImportFile, UntrustedText, Area, ArtifactKind, CoreObject } from "./package.js";
export { buildReportModel, isVerifiedReport, REPORT_MODEL_VERSION } from "./model.js";
export type { ReportModel, VerifiedReport, PlatformFacts, CountsBinding, Figure, FigureSource, Branding, LegalIssuer, ReportArtifact, ImportStep, ReportInput, ArtifactUse, PrivacyClass } from "./model.js";
export { ReportModelError, PROBLEM_CODES } from "./problems.js";
export type { Problem, ProblemCode } from "./problems.js";
export { renderReportHtml, escapeHtml, LOGO_MAX_BYTES, LOGO_MAX_PIXELS } from "./html.js";
export type { RenderOptions, RenderedReport, PageSize } from "./html.js";
export { REPORT_COPY, copyText, resolveLocale } from "./copy.js";
export type { ReportLocale, CopyKey } from "./copy.js";
export { generateReportPdf, isGeneratedReportPdf, reportPdfProblems, ReportPdfError, PDF_ERROR_CODES, PDF_CONSISTENCY_PROBLEMS } from "./pdf.js";
export type { PdfEngine, PdfPrintRequest, PdfErrorCode, PdfConsistencyProblem, ReportPdf, ReportPdfIdentity, ReportPdfPublisher } from "./pdf.js";
