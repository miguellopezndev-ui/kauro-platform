import { notFound } from "next/navigation";
import { message } from "../../../../../../../copy/en.ts";
import { SourcesScreen } from "../../../../../../../screens/sources/containers.tsx";
import { idOrNull } from "../../../../../../../screens/shared/params.ts";
import { ProjectStages } from "../../../../../../../screens/shared/project-stages.tsx";
import { uploadOrigin } from "../../../../../../../server/config/upload-origin.ts";

// UI14 Source intake (design D-ROUTE-1, D-SCR-3): the project and agency come from the path; the upload destination is the deployment's one configured origin.
export default async function Page({ params }: { readonly params: Promise<{ agencyId: string; id: string }> }) {
  const { agencyId, id } = await params;
  const agency = idOrNull(agencyId);
  const project = idOrNull(id);
  if (agency === null || project === null) notFound();
  return (
    <>
      <ProjectStages agencyId={agency} projectId={project} current="files" />
      <h1>{message("screen.sources.intake.title")}</h1>
      <SourcesScreen agencyId={agency} projectId={project} uploadOrigin={uploadOrigin()} />
    </>
  );
}
