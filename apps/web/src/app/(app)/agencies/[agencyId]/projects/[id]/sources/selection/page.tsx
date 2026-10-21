import { notFound } from "next/navigation";
import { message } from "../../../../../../../../copy/en.ts";
import { SelectionScreen } from "../../../../../../../../screens/sources/containers.tsx";
import { idOrNull } from "../../../../../../../../screens/shared/params.ts";
import { ProjectHeader } from "../../../../../../../../screens/shared/project-header.tsx";

// UI15 Selection (design D-ROUTE-1): the project and agency come from the path.
export default async function Page({ params }: { readonly params: Promise<{ agencyId: string; id: string }> }) {
  const { agencyId, id } = await params;
  const agency = idOrNull(agencyId);
  const project = idOrNull(id);
  if (agency === null || project === null) notFound();
  return (
    <>
      <ProjectHeader stage="files" title={message("screen.sources.selection.title")} lead={message("screen.sources.selection.lead.body")} />
      <SelectionScreen agencyId={agency} projectId={project} />
    </>
  );
}
