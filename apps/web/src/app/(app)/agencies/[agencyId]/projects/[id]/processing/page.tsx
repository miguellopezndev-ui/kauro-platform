import { notFound } from "next/navigation";
import { message } from "../../../../../../../copy/en.ts";
import { ProcessingScreen } from "../../../../../../../screens/processing/container.tsx";
import { idOrNull } from "../../../../../../../screens/shared/params.ts";
import { ProjectHeader } from "../../../../../../../screens/shared/project-header.tsx";

// UI25 Processing (design D-ROUTE-1): the project and agency come from the path, the paid order from `?order=`, a job already started from `?job=`.
export default async function Page({ params, searchParams }: { readonly params: Promise<{ agencyId: string; id: string }>; readonly searchParams: Promise<{ order?: string | string[]; job?: string | string[] }> }) {
  const { agencyId, id } = await params;
  const { order, job } = await searchParams;
  const agency = idOrNull(agencyId);
  const project = idOrNull(id);
  if (agency === null || project === null || (order !== undefined && idOrNull(order) === null) || (job !== undefined && idOrNull(job) === null)) notFound();
  return (
    <>
      <ProjectHeader current="delivery" />
      <h1>{message("screen.processing.title")}</h1>
      <ProcessingScreen agencyId={agency} projectId={project} orderId={idOrNull(order)} jobId={idOrNull(job)} />
    </>
  );
}
