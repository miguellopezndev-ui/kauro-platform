// What the B13 x B08 cases read from the world after a job ran: the staged and delivered artifacts of an attempt or a package, their bytes
// in the storage, and the one run that takes a purchase of an acceptance package to the end of JOB_EXECUTION's steps. The superuser
// connection is the oracle only.
import assert from "node:assert/strict";
import { REPORT_PDF_ROLE } from "@kauro/data-plane";
import { admitted, launched, observedDone, type Purchase } from "./execution-world.js";
import { reportFixtureOf, sha256, type PackageName, type ReportWorld } from "./report-world.js";

export interface Copy {
  readonly role: string;
  readonly object_name: string;
  readonly generation: string;
  readonly sha256: string;
  readonly byte_length: string;
}

export const OTHER_OBJECT_ID = "0192b000-0000-7000-8000-00000000ffff";

export function kitOf(w: ReportWorld) {
  const bytesOf = async (zone: "STAGING" | "DELIVERY", objectName: string, generation: string): Promise<Buffer> => {
    const parts: Buffer[] = [];
    for await (const chunk of w.storage.read(w.storage.location(zone), objectName, generation)) parts.push(Buffer.from(chunk));
    return Buffer.concat(parts);
  };

  const stagedOf = async (attemptId: string): Promise<Copy[]> =>
    (await w.h.oracle.query<Copy>("SELECT role, object_name, generation, sha256, byte_length::text AS byte_length FROM kauro.staged_artifacts WHERE attempt_id = $1 ORDER BY object_name", [attemptId])).rows;

  const deliveredOf = async (packageVersionId: string): Promise<Copy[]> =>
    (await w.h.oracle.query<Copy>("SELECT role, object_name, generation, sha256, byte_length::text AS byte_length FROM kauro.delivery_artifacts WHERE package_version_id = $1 ORDER BY object_name", [packageVersionId])).rows;

  /** The objects under an attempt's staging prefix. */
  const stagingObjects = async (prefix: string): Promise<Array<{ readonly objectName: string; readonly generation: string }>> =>
    (await w.objectsUnder("STAGING", prefix)).map((o) => {
      const [objectName, generation] = o.split("#");
      return { objectName: objectName!, generation: generation! };
    });

  /** The staged PDF of an attempt that has not been submitted yet: the one object under its prefix that starts as a PDF does. */
  const pdfObjectOf = async (prefix: string): Promise<{ readonly objectName: string; readonly generation: string }> => {
    const found: Array<{ objectName: string; generation: string }> = [];
    for (const o of await stagingObjects(prefix)) if ((await bytesOf("STAGING", o.objectName, o.generation)).subarray(0, 5).toString("latin1") === "%PDF-") found.push(o);
    assert.equal(found.length, 1, "one PDF under the attempt's prefix");
    return found[0]!;
  };

  const countOf = async (sql: string, params: unknown[]): Promise<number> => (await w.h.oracle.query(sql, params)).rowCount ?? 0;

  /** The state a job left that nothing of its report may have changed: no manifest, no package, no delivery copy, nothing delivered. */
  const assertNothingDelivered = async (jobId: string, agencyId: string): Promise<void> => {
    const attempt = await w.attempt(jobId);
    assert.equal(await countOf("SELECT 1 FROM kauro.staged_manifests WHERE attempt_id = $1", [attempt.attempt_id]), 0, "no staged manifest");
    assert.equal(await countOf("SELECT 1 FROM kauro.package_versions WHERE job_id = $1", [jobId]), 0, "no package version");
    assert.equal(await countOf("SELECT 1 FROM kauro.delivery_artifacts WHERE job_id = $1", [jobId]), 0, "no delivery copy");
    assert.deepEqual(await w.objectsUnder("DELIVERY", `delivery/${agencyId}/`), [], "nothing in the delivery location");
  };

  /** A paid purchase of `name` run through its worker (package and report) and JOB_EXECUTION's steps to the end. */
  const delivered = async (label: string, name: PackageName, options: { readonly rendererVersion?: string; readonly agency?: Awaited<ReturnType<ReportWorld["agency"]>> } = {}) => {
    const A = options.agency ?? (await w.agency(label));
    w.scenario(A, { packageName: name, ...(options.rendererVersion === undefined ? {} : { rendererVersion: options.rendererVersion }) });
    const p: Purchase = await w.paid(A, label, { mode: name === "A-clean-multi-object" ? "HUBSPOT" : "SALESFORCE", report: reportFixtureOf(name) });
    const { jobId, identity } = await admitted(w, p);
    await launched(w, jobId);
    await observedDone(w, identity);
    await w.drain(w.x.consumers.jobExecution);
    return { A, p, jobId, identity };
  };

  /** The delivered PDF of a published job: its delivery copy and bytes. */
  const deliveredPdf = async (jobId: string): Promise<{ readonly copy: Copy; readonly bytes: Buffer; readonly packageVersionId: string }> => {
    const [pkg] = await w.packages(jobId);
    assert.ok(pkg !== undefined);
    const copy = (await deliveredOf(pkg.package_version_id)).find((c) => c.role === REPORT_PDF_ROLE);
    assert.ok(copy !== undefined, "the package delivers a PDF");
    return { copy, bytes: await bytesOf("DELIVERY", copy.object_name, copy.generation), packageVersionId: pkg.package_version_id };
  };

  return { bytesOf, stagedOf, deliveredOf, stagingObjects, pdfObjectOf, countOf, assertNothingDelivered, delivered, deliveredPdf, sha256 };
}

export type ReportKit = ReturnType<typeof kitOf>;
