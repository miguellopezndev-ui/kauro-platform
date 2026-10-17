/**
 * @kauro/data-plane/testing — test-only (architecture rule testOnlySubpaths: importable only from a package's test/ directory;
 * no composition root binds anything from here). CONTRACT FAKE — SIMULATED: the single labelled contract fake of
 * MalwareScannerPort (owner: mandate B07-DATA-PLANE); B07-CONTROL binds it in its tests with the database clock and the
 * object-storage fake of @kauro/application/testing.
 */
export {
  ContractFakeMalwareScanner,
  FAKE_SCANNER_ENGINE,
  FAKE_SCANNER_ENGINE_VERSION,
  FAKE_SCANNER_EVIDENCE_CLASS,
  FAKE_SCANNER_SIGNATURE_VERSION,
  eicarTestToken,
  type ContractFakeScannerOptions,
  type FakeScanCall,
  type FakeScannerLimits,
  type FakeScannerScript,
  type FakeScannerSignatures,
} from "./malware-scanner-fake.js";

/**
 * CONTRACT SIMULATOR — SIMULATED: the platform's report inputs (B13 x B08; docs/design/B13-report-delivery.md §3). Nothing records the
 * issuer's legal identity yet, so there is no real source; this answers with synthetic values and labels itself.
 */
export {
  SIMULATED_ISSUER,
  SIMULATED_REPORT_INPUTS_TOKEN,
  SIMULATED_TERMS_VERSION,
  SimulatedReportInputs,
  simulatedReportInputsOf,
  type SimulatedReportInputsSpec,
} from "./report-inputs.js";
