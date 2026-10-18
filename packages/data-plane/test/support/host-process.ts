// TEST ONLY — a control plane that dies (B14-A; docs/design/B14-A-worker-executor.md §8, recovery): this process opens a local process
// host over the roots it is given, launches one real attempt, holds its worker at CORE_STARTED, prints the identity, the worker's pid
// and the attempt's scratch directory, and waits to be killed. The test then kills this process alone (never its tree) and checks
// that the worker ended itself and that a new host over the same roots answers the identity from its durable record.
import { realpathSync } from "node:fs";
import { attemptScratchDirectoryOf } from "../../src/index.js";
import { localRig, plantedAttempt, readsFor } from "./local-host.js";

const root = process.argv[2] as string;
let atCore: () => void = () => undefined;
const reached = new Promise<void>((resolve) => (atCore = resolve));
const rig = localRig({
  root,
  hooks: {
    atStage: (_identity, stage) => {
      if (stage !== "CORE_STARTED") return undefined;
      atCore();
      return new Promise<void>(() => undefined);
    },
  },
});
const planted = plantedAttempt(rig.storage, 61);
await readsFor(rig, planted);
const spec = planted.fixture.spec(1);
const launch = await rig.host.launch(spec);
await reached;
const attemptDir = attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), planted.fixture.attemptId);
process.stdout.write(`${JSON.stringify({ outcome: launch.outcome, identity: spec.identity, pid: rig.host.record(spec.identity)?.pid ?? null, attemptDir, spec })}\n`);
setInterval(() => undefined, 60_000);
