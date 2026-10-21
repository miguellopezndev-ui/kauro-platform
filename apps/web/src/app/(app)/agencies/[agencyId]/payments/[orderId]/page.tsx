import { notFound } from "next/navigation";
import { message } from "../../../../../../copy/en.ts";
import { PaymentScreen } from "../../../../../../screens/payments/containers.tsx";
import { idOrNull } from "../../../../../../screens/shared/params.ts";
import { ProjectHeader } from "../../../../../../screens/shared/project-header.tsx";

// UI24 Payment (design D-ROUTE-1): the order is named in the path, so a return from the bank lands on the same page and reads the same order.
export default async function Page({ params }: { readonly params: Promise<{ agencyId: string; orderId: string }> }) {
  const { agencyId, orderId } = await params;
  const agency = idOrNull(agencyId);
  const order = idOrNull(orderId);
  if (agency === null || order === null) notFound();
  return (
    <>
      <ProjectHeader current="purchase" />
      <h1>{message("screen.payment.title")}</h1>
      <PaymentScreen agencyId={agency} orderId={order} />
    </>
  );
}
