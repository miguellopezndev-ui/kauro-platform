// Case R2-049 (SIM), package B16 lane L4: the worker sandbox reaches no instance-metadata endpoint and holds no broad credential; only
// the broker issues prefix-scoped capabilities. LOCAL SIMULATION ONLY: the isolated child of @kauro/data-plane (runIsolated: empty
// environment, the permission model, the network preload) and the capability check every attempt reader and writer runs. The provider
// half (the deployed worker's network policy blocking 169.254.169.254 / fd00:ec2::254, an IMDSv2 hop limit of 1 and a task role
// without broad storage rights) needs the AWS account and stays BLOCKED_OWNER in the case map (PARTIAL).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { attemptCapabilityProblems, attemptIdentityOf, attemptStagingPrefixOf, stagedManifestObjectNameOf, type AttemptCapability, type ObjectStoragePort } from "@kauro/application";
import type { Id } from "@kauro/contracts";
import type { AgencyId, ProjectId } from "@kauro/domain";
import { ARCHIVE_BOUNDS, GenerationSourceReader, runIsolated } from "../src/index.js";
import { freshDir, removeDir } from "./support/harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WINDOWS_PROCESS_DEFAULTS: ReadonlySet<string> = new Set(["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "TEMP", "TMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"]);
const FAKE_CREDENTIALS: Readonly<Record<string, string>> = {
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  AWS_SESSION_TOKEN: "simulated-session-token",
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/simulated",
  GOOGLE_APPLICATION_CREDENTIALS: "/var/run/secrets/simulated.json",
};

test("R2-049 (SIM): the worker sandbox reaches no metadata endpoint and holds no broad credential; only the broker issues prefix-scoped capabilities", { timeout: 120_000 }, async () => {
  const work = freshDir("metadata");
  const creds = freshDir("credentials");
  const saved = Object.fromEntries(Object.keys(FAKE_CREDENTIALS).map((k) => [k, process.env[k]]));
  try {
    // the parent holds credentials (a host with a task role would): a credentials file and the provider's variables
    const credentialsFile = join(creds, "credentials");
    writeFileSync(credentialsFile, `[default]\naws_access_key_id = ${FAKE_CREDENTIALS["AWS_ACCESS_KEY_ID"]}\naws_secret_access_key = ${FAKE_CREDENTIALS["AWS_SECRET_ACCESS_KEY"]}\n`);
    for (const [k, v] of Object.entries(FAKE_CREDENTIALS)) process.env[k] = v;
    const run = await runIsolated<Record<string, string>>({
      task: join(HERE, "probes", "metadata-probe.js"),
      payload: { credentialsFile },
      readPaths: [],
      workDir: work,
      timeoutMs: 60_000,
      heapMegabytes: ARCHIVE_BOUNDS.childHeapMegabytes,
    });
    assert.ok(run.outcome?.ok === true, JSON.stringify(run.outcome));
    const seen = run.outcome.value;
    // every metadata route is refused by the hooks and counted: IMDS over IPv4 and IPv6, the ECS credential endpoint, GCP by name
    for (const attempt of ["imdsConnect", "imdsV6Connect", "imdsFetch", "ecsHttp", "gcpLookup"]) assert.equal(seen[attempt], "KAURO_NETWORK_REFUSED", attempt);
    assert.equal(run.observers.networkAttempts, 5);
    assert.deepEqual(run.observers.network, ["net.connect", "net.connect", "fetch", "http.get", "dns.lookup"]);
    // no credential reaches the child: not the parent's variables, not the credentials file (the permission model refuses the read)
    // Linux: nothing at all. Windows: only the variables the operating system derives for every new process from the account (an exact
    // allowlist, none of them a credential); the parent's own variables never cross
    const names = seen["env"] === "EMPTY" ? [] : (seen["env"] ?? "").split(",");
    if (process.platform === "win32") assert.deepEqual(names.filter((n) => !WINDOWS_PROCESS_DEFAULTS.has(n)), [], seen["env"]);
    else assert.deepEqual(names, []);
    for (const k of Object.keys(FAKE_CREDENTIALS)) assert.ok(!names.includes(k), k);
    assert.equal(seen["awsKey"], "ABSENT");
    assert.equal(seen["credentialsFile"], "ERR_ACCESS_DENIED:FileSystemRead");
    assert.ok(!run.flags.some((f) => f.includes(creds)), "the credentials directory is in no read allowance");
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    removeDir(work);
    removeDir(creds);
  }

  // the broker's capability: exactly the attempt's own prefix and its project's sealed generations; anything broader is refused by the
  // reader before a byte moves
  const agencyId = randomUUID() as AgencyId;
  const projectId = randomUUID() as ProjectId;
  const jobId = randomUUID() as Id;
  const attemptId = randomUUID() as Id;
  const prefix = attemptStagingPrefixOf(agencyId, projectId, jobId, attemptId);
  const own: AttemptCapability = {
    agencyId,
    projectId,
    jobId,
    attemptId,
    identity: attemptIdentityOf(attemptId),
    stagingPrefix: prefix,
    manifestObjectName: stagedManifestObjectNameOf(prefix, attemptId),
    acceptedGenerations: [{ objectName: `accepted/${agencyId}/${projectId}/${randomUUID()}`, generation: "1", sha256: "a".repeat(64), byteLength: 10 }],
  };
  assert.deepEqual(attemptCapabilityProblems(own), [], "the broker's capability is canonical");
  const storage = { location: () => ({ bucket: "simulated" }) } as unknown as ObjectStoragePort;
  assert.doesNotThrow(() => new GenerationSourceReader({ capability: own, storage }));
  const broad: ReadonlyArray<readonly [string, AttemptCapability, string]> = [
    ["the whole staging area", { ...own, stagingPrefix: "staging/" }, "PREFIX_NOT_THE_ATTEMPTS"],
    ["the agency's whole staging", { ...own, stagingPrefix: `staging/${agencyId}/` }, "PREFIX_NOT_THE_ATTEMPTS"],
    ["another attempt's prefix", { ...own, stagingPrefix: attemptStagingPrefixOf(agencyId, projectId, jobId, randomUUID() as Id) }, "PREFIX_NOT_THE_ATTEMPTS"],
    ["the whole accepted area", { ...own, acceptedGenerations: [{ ...own.acceptedGenerations[0]!, objectName: "accepted/" }] }, "SOURCE_NOT_THE_PROJECTS_ACCEPTED_OBJECT"],
    ["another project's source", { ...own, acceptedGenerations: [{ ...own.acceptedGenerations[0]!, objectName: `accepted/${agencyId}/${randomUUID()}/${randomUUID()}` }] }, "SOURCE_NOT_THE_PROJECTS_ACCEPTED_OBJECT"],
    ["another attempt's identity", { ...own, identity: attemptIdentityOf(randomUUID() as Id) }, "IDENTITY_NOT_THE_ATTEMPTS"],
  ];
  for (const [label, capability, problem] of broad) {
    assert.ok(attemptCapabilityProblems(capability).includes(problem), `${label}: ${problem}`);
    assert.throws(() => new GenerationSourceReader({ capability, storage }), new RegExp(problem), `${label}: the reader refuses it`);
  }
});
