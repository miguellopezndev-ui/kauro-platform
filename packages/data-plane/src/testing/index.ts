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
  eicarTestToken,
  type ContractFakeScannerOptions,
  type FakeScanCall,
  type FakeScannerLimits,
  type FakeScannerScript,
  type FakeScannerSignatures,
} from "./malware-scanner-fake.js";
