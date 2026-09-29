/**
 * @kauro/application/testing — the test-only surface of the application package: the contract fake of the identity provider
 * (ContractFakeIdentityIssuer, label CONTRACT_FAKE, evidence class SIMULATED; B11 design §6, owner mandate W2) and the test
 * clock the api and the fake share. It is a separate export subpath: the package's main entry exports none of it, and the
 * architecture gate refuses an import of this subpath from any production source file (architecture.rules.json
 * `testOnlySubpaths`), so no deployment import graph carries it.
 */
export { ContractFakeIdentityIssuer, testClock, totpCode, CONTRACT_FAKE_LABEL, SIMULATED_EVIDENCE } from "./identity-issuer.js";
export type { TestClock, FakeAccount, FakeAccountSpec, FakeSignIn, FakeRefusal, FakeTotpEnrollment, MintOptions } from "./identity-issuer.js";
