import { notFound } from "next/navigation";
import { message } from "../../../../copy/en.ts";
import { FinanceScreen } from "../../../../screens/finance/containers.tsx";
import { idOrNull } from "../../../../screens/shared/params.ts";

// UI39 Company finance (design D-SCR-1, B12 D-B12S-5): the owner's bank route (O1) from `?route=`, and the inbound credit queue (O2).
export default async function Page({ searchParams }: { readonly searchParams: Promise<{ route?: string | string[] }> }) {
  const { route } = await searchParams;
  if (route !== undefined && idOrNull(route) === null) notFound();
  return (
    <>
      <h1>{message("screen.finance.title")}</h1>
      <p>{message("screen.finance.lead.body")}</p>
      <FinanceScreen routeId={idOrNull(route)} />
    </>
  );
}
