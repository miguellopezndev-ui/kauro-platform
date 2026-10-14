import { notFound } from "next/navigation";
import { message } from "../../../../../../../../copy/en.ts";
import { SealScreen } from "../../../../../../../../screens/sources/containers.tsx";
import { idOrNull } from "../../../../../../../../screens/shared/params.ts";

// UI16 Seal review (design D-ROUTE-1): the project and agency come from the path.
export default async function Page({ params }: { readonly params: Promise<{ agencyId: string; id: string }> }) {
  const { agencyId, id } = await params;
  const agency = idOrNull(agencyId);
  const project = idOrNull(id);
  if (agency === null || project === null) notFound();
  return (
    <>
      <h1>{message("screen.sources.seal.title")}</h1>
      <SealScreen agencyId={agency} projectId={project} />
    </>
  );
}
