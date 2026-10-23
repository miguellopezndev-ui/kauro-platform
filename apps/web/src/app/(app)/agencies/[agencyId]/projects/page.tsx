import { notFound } from "next/navigation";
import { message } from "../../../../../copy/en.ts";
import { PageHeader } from "../../../../../screens/shared/project-header.tsx";
import { idOrNull } from "../../../../../screens/shared/params.ts";
import { ProjectsScreen } from "../../../../../screens/projects/container.tsx";

// UI11 Projects (Order 24; design D-ROUTE-1): the agency comes from the path; the list is ListProjects, read by the browser.
export default async function Page({ params }: { readonly params: Promise<{ agencyId: string }> }) {
  const { agencyId } = await params;
  const agency = idOrNull(agencyId);
  if (agency === null) notFound();
  return (
    <>
      <PageHeader title={message("screen.projects.title")} lead={message("screen.projects.lead.body")} />
      <ProjectsScreen agencyId={agency} />
    </>
  );
}
