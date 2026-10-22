// The eleven private screens the web already implements, mounted through their own page modules (Order 11 §2): the review renders exactly
// the page the application renders for that route (its heading, its container, its parameters), never a recreation. Server-only.
import type { ReactElement } from "react";
import BillingPage from "@web/app/(app)/agencies/[agencyId]/billing/page.tsx";
import PaymentPage from "@web/app/(app)/agencies/[agencyId]/payments/[orderId]/page.tsx";
import AuditPage from "@web/app/(app)/agencies/[agencyId]/projects/[id]/audit/page.tsx";
import ProcessingPage from "@web/app/(app)/agencies/[agencyId]/projects/[id]/processing/page.tsx";
import PurchasePage from "@web/app/(app)/agencies/[agencyId]/projects/[id]/purchase/page.tsx";
import SourcesPage from "@web/app/(app)/agencies/[agencyId]/projects/[id]/sources/page.tsx";
import SealPage from "@web/app/(app)/agencies/[agencyId]/projects/[id]/sources/seal/page.tsx";
import SelectionPage from "@web/app/(app)/agencies/[agencyId]/projects/[id]/sources/selection/page.tsx";
import SettingsPage from "@web/app/(app)/agencies/[agencyId]/settings/page.tsx";
import SupportPage from "@web/app/(app)/agencies/[agencyId]/support/page.tsx";
import FinancePage from "@web/app/(ops)/ops/finance/page.tsx";
import { ROUTE_ID } from "./fixtures/account-states.ts";
import { IDS } from "./ids.ts";

type Query = Readonly<Record<string, string>>;
const p = <T,>(value: T): Promise<T> => Promise.resolve(value);

/** The real page of an implemented screen at the address's own parameters (the agency, the project, the order), or null. */
export async function realPage(id: string, agencyId: string, query: Query = {}, params: Readonly<Record<string, string>> = {}): Promise<ReactElement | null> {
  const project = { agencyId, id: params["id"] ?? IDS.project };
  switch (id) {
    case "UI14":
      return SourcesPage({ params: p(project) });
    case "UI15":
      return SelectionPage({ params: p(project) });
    case "UI16":
      return SealPage({ params: p(project) });
    case "UI18":
      return AuditPage({ params: p(project), searchParams: p({ audit: query["audit"] ?? IDS.audit }) });
    case "UI23":
      return PurchasePage({ params: p(project), searchParams: p({ quote: query["quote"] ?? IDS.quote }) });
    case "UI24":
      return PaymentPage({ params: p({ agencyId, orderId: params["orderId"] ?? IDS.order }) });
    case "UI25":
      return ProcessingPage({ params: p(project), searchParams: p({ order: IDS.order, job: query["job"] ?? IDS.job }) });
    case "UI30":
      return BillingPage({ params: p({ agencyId }), searchParams: p({ order: IDS.order }) });
    case "UI32":
      return SettingsPage({ params: p({ agencyId }) });
    case "UI39":
      return FinancePage({ searchParams: p({ route: query["route"] ?? ROUTE_ID }) });
    case "UI52":
      return SupportPage({ params: p({ agencyId }), searchParams: p({ project: query["project"] ?? IDS.project, ...(query["case"] === undefined ? {} : { case: query["case"] }) }) });
    default:
      return null;
  }
}
