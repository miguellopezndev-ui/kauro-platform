import { notFound } from "next/navigation";
import { OverviewScreen } from "../../../../../../screens/overview/container.tsx";
import { idOrNull } from "../../../../../../screens/shared/params.ts";

// UI13 Overview (Order 24; design D-ROUTE-1): the agency and project come from the path; the project and its row are read by the browser.
export default async function Page({ params }: { readonly params: Promise<{ agencyId: string; id: string }> }) {
  const { agencyId, id } = await params;
  const agency = idOrNull(agencyId);
  const project = idOrNull(id);
  if (agency === null || project === null) notFound();
  return <OverviewScreen agencyId={agency} projectId={project} />;
}
