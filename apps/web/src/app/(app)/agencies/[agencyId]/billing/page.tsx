import { notFound } from "next/navigation";
import { message } from "../../../../../copy/en.ts";
import { BillingScreen } from "../../../../../screens/billing/container.tsx";
import { idOrNull } from "../../../../../screens/shared/params.ts";

// UI30 Billing (design D-ROUTE-1): the agency comes from the path and the order from `?order=`; an id that is not the api's own shape is not found.
export default async function Page({ params, searchParams }: { readonly params: Promise<{ agencyId: string }>; readonly searchParams: Promise<{ order?: string | string[] }> }) {
  const { agencyId } = await params;
  const { order } = await searchParams;
  const agency = idOrNull(agencyId);
  if (agency === null || (order !== undefined && idOrNull(order) === null)) notFound();
  return (
    <>
      <h1>{message("screen.billing.title")}</h1>
      <BillingScreen agencyId={agency} orderId={idOrNull(order)} />
    </>
  );
}
