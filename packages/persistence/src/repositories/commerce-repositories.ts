/**
 * The commerce repositories of one connection (package B09; @kauro/domain ports/commerce.ts CommerceRepositories and ScopeIndex):
 * what a commerce unit of work hands to its work, all on the same transaction as B06's repositories, publisher and journal.
 */
import type { CommerceRepositories, ScopeIndex } from "@kauro/domain";
import { PgCaptureFactRepository, PgCommercialAuthorizationRepository, PgPurchaseRebindingRepository } from "./commerce-captures.js";
import { PgLedgerRepository, PgPaymentInboxRepository, PgSettlementRepository, PgTaxDocumentRepository } from "./commerce-finance.js";
import { PgPaymentAttemptRepository, PgPaymentOrderRepository, PgProviderObservationRepository } from "./commerce-orders.js";
import { PgCorporateGrantRepository, PgFiscalRepository, PgPaymentRouteRepository, PgPricePolicyRepository, PgRefundPolicyRepository, PgScopeIndex } from "./commerce-platform.js";
import { PgQuoteRepository } from "./commerce-quotes.js";
import { PgProviderExceptionRepository, PgReconciliationCaseRepository, PgRefundRepository } from "./commerce-refunds.js";
import type { CommerceWriteContext } from "./commerce-shared.js";

export function createCommerceRepositories(ctx: CommerceWriteContext): { readonly repositories: CommerceRepositories; readonly scopes: ScopeIndex } {
  const repositories: CommerceRepositories = {
    routes: new PgPaymentRouteRepository(ctx.db),
    fiscal: new PgFiscalRepository(ctx.db),
    corporateGrants: new PgCorporateGrantRepository(ctx.db),
    refundPolicies: new PgRefundPolicyRepository(ctx.db),
    pricePolicies: new PgPricePolicyRepository(ctx.db),
    quotes: new PgQuoteRepository(ctx),
    orders: new PgPaymentOrderRepository(ctx),
    attempts: new PgPaymentAttemptRepository(ctx),
    captures: new PgCaptureFactRepository(ctx),
    observations: new PgProviderObservationRepository(ctx),
    authorizations: new PgCommercialAuthorizationRepository(ctx),
    rebindings: new PgPurchaseRebindingRepository(ctx.db),
    refunds: new PgRefundRepository(ctx),
    taxDocuments: new PgTaxDocumentRepository(ctx),
    ledger: new PgLedgerRepository(ctx),
    settlements: new PgSettlementRepository(ctx),
    cases: new PgReconciliationCaseRepository(ctx),
    inbox: new PgPaymentInboxRepository(ctx.db),
    exceptions: new PgProviderExceptionRepository(ctx),
  };
  return { repositories: Object.freeze(repositories), scopes: new PgScopeIndex(ctx.db) };
}
