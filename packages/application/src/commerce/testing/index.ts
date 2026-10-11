/**
 * @kauro/application/testing — the TEST-ONLY subpath of package B09's implementation mandate M2 (architecture.rules.json
 * testOnlySubpaths: only files under a package's test/ directory may import it; no production source, so no deployment wiring can
 * reach a fake). It holds the labelled contract fakes of every external and platform port (integrationClass / binding
 * CONTRACT_FAKE, evidence class SIMULATED; decision D-FAKE-B1) and the in-memory commerce store for pure orchestration tests.
 * Nothing here is evidence of an integration (21 "Evidence classes"): the real adapters are packages B15, B07 and B08's.
 */
export type { FakeCall } from "./labels.js";
export { CONTRACT_FAKE, FAKE_EVIDENCE_CLASS, sha256Hex, uuidV8Of, decimalOf, centsOf, instantOf } from "./labels.js";
export type { PayPalEndpoint, CaptureOverrides, PayPalScript, PayPalContractFakeOptions, PayPalContractFake } from "./paypal-fake.js";
export { PAYPAL_FAKE_PROVIDER, createPayPalContractFake } from "./paypal-fake.js";
export type { WebhookVerifierFakeOptions, WebhookVerifierFake } from "./webhook-verifier-fake.js";
export { PAYPAL_WEBHOOK_HEADERS, normalizePayPalWebhook, createWebhookVerifierFake } from "./webhook-verifier-fake.js";
export type { EvidenceStoreFake, FiscalBridgeFake, ServiceAuthenticatorFake, ServiceAuthenticatorFakeOptions } from "./evidence-and-services.js";
export { FISCAL_ISSUANCE_DOMAIN, createEvidenceStoreFake, createFiscalBridgeFake, createServiceAuthenticatorFake } from "./evidence-and-services.js";
export type { CapacityAnswer, DeliveryCapacityFake } from "./platform-fakes.js";
export { CapacityUnansweredError, createDeliveryCapacityFake } from "./platform-fakes.js";
export type { InMemoryCommerceStore, InMemoryCommercePorts, InMemoryCommerceOptions } from "./in-memory-commerce.js";
export { emptyCommerceStore, createInMemoryCommercePorts } from "./in-memory-commerce.js";
export type {
  BankFakeKind,
  BankFakeMethod,
  BankFakeScript,
  BankEvidenceFakeOptions,
  BankEvidenceFake,
  FakeCreditFields,
  FakeDestinationFields,
  FakeOutboundFields,
  FakeDebitFields,
  FakeStatementFields,
} from "./bank-evidence-fake.js";
export {
  BANK_FAKE_PROVIDER,
  BANK_FAKE_FORMAT,
  BANK_FAKE_NORMALIZER,
  createBankEvidenceFake,
  fakeCreditBytes,
  fakeOutboundBytes,
  fakeStatementBytes,
  classifyFakeCredit,
  classifyFakeOutbound,
  classifyFakeStatement,
} from "./bank-evidence-fake.js";
// the CONTRACT_FAKE account-details classifier of the bank-transfer route (lane L-ROUTE, R1)
export { classifyFakeAccountDetails, contractFakeBankDetailsClassifier } from "./bank-details-fake.js";
