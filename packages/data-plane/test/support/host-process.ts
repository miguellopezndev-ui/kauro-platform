// TEST ONLY — a control plane that dies (B14-A; docs/design/B14-A-worker-executor.md §8, recovery): this process opens a local process
// host over the roots it is given, launches one real attempt, holds its worker at CORE_STARTED, prints the identity, the worker's pid
// and the attempt's scratch directory, and waits to be killed. The test then kills this process alone (never its tree) and checks
// that the worker ended itself and that a new host over the same roots answers the identity from its durable record.
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { attemptScratchDirectoryOf } from "../../src/index.js";
import { HOSTILE_ENTRY, localRig, plantedAttempt, readsFor } from "./local-host.js";

const root = process.argv[2] as string;
// a second argument names a hostile behaviour (the hostile worker reads it from its ticket's render): no stage is reported then
const hostile = process.argv[3];
let atCore: () => void = () => undefined;
const reached = new Promise<void>((resolve) => (atCore = resolve));
const rig = localRig({
  root,
  ...(hostile === undefined ? {} : { workerEntry: HOSTILE_ENTRY, render: { pageSize: "LETTER" as const, locale: hostile, rendererVersion: "x" } }),
  hooks: {
    atStage: (_identity, stage) => {
      if (stage !== "CORE_STARTED") return undefined;
      atCore();
      return new Promise<void>(() => undefined);
    },
  },
});
const planted = plantedAttempt(rig.storage, 61);
if (hostile === undefined) await readsFor(rig, planted);
else rig.reads.set(planted.fixture.attemptId, { planBinding: { configDocument: planted.configDocument, coreConfigHash: planted.coreConfigHash }, inputs: planted.inputs, reportInputs: null });
const spec = planted.fixture.spec(1);
const launch = await rig.host.launch(spec);
if (hostile === undefined) await reached;
// a hostile worker reports no stage: the attempt has begun once the worker has been given its ticket
else while (!existsSync(join(rig.hostRoot, "jobs", spec.identity, "ticket.claim"))) await new Promise((r) => setTimeout(r, 50));
const attemptDir = attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), planted.fixture.attemptId);
process.stdout.write(`${JSON.stringify({ outcome: launch.outcome, identity: spec.identity, pid: rig.host.record(spec.identity)?.pid ?? null, attemptDir, spec })}\n`);
setInterval(() => undefined, 60_000);
