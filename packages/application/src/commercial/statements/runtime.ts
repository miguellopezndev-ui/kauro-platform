/**
 * What the statement and payout commands run on (package B10, mandate B10-STATEMENTS-PAYOUTS; design §7, §10, §13; decisions D10-STMT-1,
 * D10-STMT-4, D10-PAY-1, D10-PAY-2, D10-API-1).
 *
 * CMD052 ApproveCommissionPayout and the GetCommissionStatement read are request handlers: B09's request runtime (B06's pipeline over the
 * commerce unit of work of kauro_app) with the commercial authorizer, B06's step-up verifier and the statement, ledger and sales records
 * reached through accessors over the unit of work (B09's purchasedSubjectsOf pattern), so no shared factory is edited.
 *
 * CMD051 CloseCommissionPeriod and CMD053 ReconcileCommissionPayout are the commands of the two services of kauro_commission: they run in
 * SERVICE units of work of the commission group's own factory (the commission service's pools), as the verified service identity the
 * route authenticated or as the commission service itself (the PERIODS sweep), journaled under that identity with no agency (migration
 * 0034). The banking calendar and the payout evidence are the ports of design §11; the evidence verifier reaches a provider, so it is
 * called before the unit of work opens, never inside it.
 */
import type { UtcInstant } from "@kauro/contracts";
import type {
  Clock,
  CommerceUnitOfWork,
  CommissionLedgerRepository,
  CommissionPolicy,
  Environment,
  ExecutionContext,
  SalesRepository,
  StatementRepository,
  UnitOfWork,
} from "@kauro/domain";
import type { AssuranceVerifier } from "../../ports/assurance-and-admission.js";
import type { CommercialAuthorizer } from "../authorizer.js";
import type { BankingCalendarSource, PayoutEvidenceVerifier, ProviderCallTimer } from "../ports.js";

/** The records every statement command reads, as accessors over the unit of work (@kauro/persistence statementsOf, ledgerOf, salesOf). */
export interface StatementRecords {
  readonly statements: (uow: UnitOfWork) => StatementRepository;
  readonly ledger: (uow: UnitOfWork) => CommissionLedgerRepository;
  readonly sales: (uow: UnitOfWork) => SalesRepository;
  /** The server's instant of the unit of work (kauro.server_now(), D10-CLOCK-1): due dates, dated holds and reviews compare to it. */
  readonly serverNow: (uow: UnitOfWork) => Promise<UtcInstant>;
}

/** CMD052 and the read: the request side (kauro_app). */
export interface StatementRequestCollaborators extends StatementRecords {
  readonly authorizer: CommercialAuthorizer;
  /** B06's step-up verifier (08 "High-impact actions require recent step-up"): CMD052's authorizationRef. */
  readonly assurance: AssuranceVerifier;
}

/** Where a service command is held or crashed by a test (only tests bind it), inside its unit of work before COMMIT. */
export type StatementServiceHold = (command: "CMD051" | "CMD053", point: "BEFORE_COMMIT" | "LINES_LOCKED" | "SET_DISCOVERED", detail?: { readonly cutoffAt: string }) => Promise<void>;

/** A unit-of-work factory of the commission group (SERVICE contexts of the commission and finance services on kauro_commission). */
export interface CommissionGroupUnits {
  run<T>(context: ExecutionContext, work: (uow: CommerceUnitOfWork) => Promise<T>): Promise<T>;
}

/** The reads a close needs beyond the StatementRepository port (@kauro/persistence commissionWorkOf). */
export interface CloseReads {
  /** The adjustments an issued statement already itemizes: a close reports each adjustment once (D10-STMT-4). */
  reportedAdjustments(uow: UnitOfWork): Promise<ReadonlySet<string>>;
}

/** CMD051 and CMD053: the commission group's service commands. */
export interface StatementServiceRuntime extends StatementRecords {
  readonly units: CommissionGroupUnits;
  readonly environment: Environment;
  readonly clock: Clock;
  readonly authorizer: CommercialAuthorizer;
  readonly policy: CommissionPolicy;
  /** BankingCalendarSource: RecordedBankingCalendarSource in a deployment (D10-BIND-1), the labelled fixture in tests. */
  readonly calendar: BankingCalendarSource;
  /** PayoutEvidenceVerifier: UnavailablePayoutEvidenceVerifier in a deployment (D10-BIND-1), the labelled fake in tests. */
  readonly payoutEvidence: PayoutEvidenceVerifier;
  /** The bound of the verifier's call (PROVIDER_CALL_TIMEOUT_MS): realProviderCallTimer in a deployment, a clock-driven timer in fault cells. */
  readonly providerTimer: ProviderCallTimer;
  readonly reads: CloseReads;
  readonly hold?: StatementServiceHold;
}
