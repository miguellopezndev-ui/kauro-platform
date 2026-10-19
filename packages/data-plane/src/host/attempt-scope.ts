/**
 * The operating-system boundary that holds one attempt's whole process tree (B14-A; docs/design/B14-A-recovery.md §7): the worker and
 * everything it starts — the core's child, the browser and the browser's own processes — end together, at once, when the host ends the
 * scope or when the host itself ends, however it ends. No process of the tree is ever known or signalled by its number.
 *
 * - Linux: a PID namespace. The worker is started as the namespace's first process, through util-linux: `setpriv --pdeathsig KILL --
 *   unshare --user --map-current-user --pid --fork --kill-child=SIGKILL -- node …`. The kernel ends every process of a PID namespace
 *   when its first process ends; `unshare` gives that process the parent-death signal KILL, and `setpriv` gives `unshare` the same
 *   towards the host. So the host ends the tree by killing its own unreaped child (`unshare`), and the host's death ends it too.
 * - Windows: job objects. A child Node starts without `detached` is assigned to its parent's kill-on-close job (libuv's), so the worker
 *   ends with the host, and the worker's own children (the core's child, the browser) end with the worker; the browser's own processes
 *   are in the browser's kill-on-close jobs. libuv does not report a failed assignment, so the host proves the nesting on this machine
 *   when it opens (qualifyAttemptScope) and refuses to open where it does not hold.
 *
 * Both need something of the environment (Linux: unprivileged user and PID namespaces; Windows: nested jobs, Windows 8 and later):
 * where it is missing the host does not open — it never runs an attempt outside its boundary.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export class AttemptScopeUnavailable extends Error {
  readonly code = "ATTEMPT_SCOPE_UNAVAILABLE";
  constructor(reason: string) {
    super(`the attempt's process boundary is not available on this machine: ${reason}`);
    this.name = "AttemptScopeUnavailable";
  }
}

const SETPRIV = ["/usr/bin/setpriv", "/bin/setpriv"];
const UNSHARE = ["/usr/bin/unshare", "/bin/unshare"];

export interface AttemptScope {
  /** The program and arguments that start `node <flags>` inside a new boundary. */
  command(nodeFlags: readonly string[]): readonly [string, readonly string[]];
}

function linuxScope(): AttemptScope {
  const setpriv = SETPRIV.find((p) => existsSync(p));
  const unshare = UNSHARE.find((p) => existsSync(p));
  if (setpriv === undefined || unshare === undefined) throw new AttemptScopeUnavailable("util-linux setpriv and unshare are required");
  return {
    command: (flags) => [setpriv, ["--pdeathsig", "KILL", "--", unshare, "--user", "--map-current-user", "--pid", "--fork", "--kill-child=SIGKILL", "--", process.execPath, ...flags]],
  };
}

const windowsScope: AttemptScope = { command: (flags) => [process.execPath, flags] };

/**
 * The attempt scope of this platform, proved on this machine: Linux starts a probe as the first process of a new PID namespace (it
 * must see itself as pid 1); Windows starts a probe whose own child must end when the probe is ended (its kill-on-close job, nested in
 * this process's). Throws AttemptScopeUnavailable otherwise.
 */
export async function qualifyAttemptScope(platform: NodeJS.Platform = process.platform): Promise<AttemptScope> {
  if (platform === "linux") {
    const scope = linuxScope();
    const [command, args] = scope.command(["-e", "process.exit(process.pid === 1 ? 0 : 3)"]);
    const probe = spawnSync(command, args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 10_000 });
    if (probe.status !== 0) throw new AttemptScopeUnavailable(`a new PID namespace could not be made (${probe.error?.message ?? `exit ${probe.status}`}: ${String(probe.stderr ?? "").trim().slice(0, 300)}); the runner user must be able to make a user namespace (Ubuntu 23.10 and later: an AppArmor profile granting \`userns\` to util-linux unshare, tools/ci/prepare-worker-scope.sh)`);
    return scope;
  }
  if (platform === "win32") {
    await windowsJobsHold();
    return windowsScope;
  }
  throw new AttemptScopeUnavailable(`no boundary is known for ${platform}`);
}

/**
 * Windows: a probe that starts a grandchild sharing this process's pipe, then is ended; the pipe closes only once the grandchild has
 * ended too — which proves the probe's kill-on-close job held it. The grandchild ends itself after 20 s in any case.
 */
async function windowsJobsHold(): Promise<void> {
  const grandchild = "process.stdout.write('up\\n'); setTimeout(() => process.exit(0), 20000)";
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'ignore'], windowsHide: true }); setInterval(() => {}, 1000)`;
  const probe = spawn(process.execPath, ["-e", parent], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const verdict = await new Promise<string | null>((resolve) => {
    let up = false;
    const timer = setTimeout(() => resolve(up ? "the probe's child outlived it: kill-on-close job objects do not hold here" : "the probe did not start"), 10_000);
    probe.stdout?.on("data", (chunk: Buffer) => {
      if (!up && chunk.toString("utf8").includes("up")) {
        up = true;
        probe.kill("SIGKILL");
      }
    });
    probe.stdout?.on("end", () => {
      clearTimeout(timer);
      resolve(up ? null : "the probe did not start");
    });
  });
  if (verdict !== null) {
    probe.kill("SIGKILL");
    throw new AttemptScopeUnavailable(verdict);
  }
}
