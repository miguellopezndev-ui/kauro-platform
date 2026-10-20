import { notFound } from "next/navigation";
import { message } from "../../../../../../../copy/en.ts";
import { QuoteScreen } from "../../../../../../../screens/payments/containers.tsx";
import { idOrNull } from "../../../../../../../screens/shared/params.ts";
import { ProjectStages } from "../../../../../../../screens/shared/project-stages.tsx";

// UI23 Quote (design D-ROUTE-1): the project and the agency come from the path, the quote from `?quote=`.
export default async function Page({ params, searchParams }: { readonly params: Promise<{ agencyId: string; id: string }>; readonly searchParams: Promise<{ quote?: string | string[] }> }) {
  const { agencyId, id } = await params;
  const { quote } = await searchParams;
  const agency = idOrNull(agencyId);
  const project = idOrNull(id);
  if (agency === null || project === null || (quote !== undefined && idOrNull(quote) === null)) notFound();
  return (
    <>
      <ProjectStages agencyId={agency} projectId={project} current="quote" />
      <h1>{message("screen.quote.title")}</h1>
      <QuoteScreen agencyId={agency} projectId={project} quoteId={idOrNull(quote)} />
    </>
  );
}
