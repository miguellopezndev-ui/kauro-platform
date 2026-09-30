/**
 * The labelled contract fakes of package B10's ports, on the TEST-ONLY subpath of @kauro/application (architecture.rules.json
 * testOnlySubpaths: only files under a package's test/ directory may import it; the main entry never reaches this directory, so no
 * composition root can bind a fake). Each declares CONTRACT_FAKE, the evidence class SIMULATED, a call log and hold points (never a
 * sleep). Nothing here is evidence of an integration (21 "Evidence classes"): the recorded calendar and the verified payout evidence
 * are B10-ADAPTERS-LEDGER's and B15's. Outcome catalogues are not this lane's.
 */
export type { CommercialFakeHold } from "./holds.js";
export { HoldPoints } from "./holds.js";
export { BUYER_TYPE_FAKE_PROVIDER, ContractFakeBuyerTypeReader } from "./buyer-type.js";
export type { RecordedCompletion } from "./preparation-completion.js";
export { PREPARATION_COMPLETION_FAKE_PROVIDER, ContractFakePreparationCompletion } from "./preparation-completion.js";
export {
  BANKING_CALENDAR_FAKE_PROVIDER,
  BANKING_CALENDAR_FIXTURE_COVERAGE,
  BANKING_CALENDAR_FIXTURE_NONBANKING,
  BANKING_CALENDAR_FIXTURE_VERSION,
  ContractFakeBankingCalendar,
} from "./banking-calendar.js";
export type { PayoutIntentFacts, PayoutMismatch } from "./payout-evidence.js";
export { PAYOUT_EVIDENCE_FAKE_PROVIDER, ContractFakePayoutEvidence } from "./payout-evidence.js";
