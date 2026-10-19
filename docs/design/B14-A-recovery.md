# B14-A recovery — diagnosis and target architecture (order 9, phase A)

Recovery of order 9 (B14-A, PR #111) after 21 rounds of independent review. Written before the product code was changed; the
implementation that follows it is described in [B14-A-worker-executor.md](B14-A-worker-executor.md). PR #111 (head `ab8de391`) stays
open as the historical reference; the uncommitted round-21 work found in its worktree is kept on branch `order9/b14a-r21-wip`.

## 1. The architecture under review and its five sources of complexity

PR #111 built a real executor (`LocalProcessWorkerHost`) that runs Migration Core 3.0.0 and the B13 report in a worker process under
B08's unchanged control plane. Around that functional core it built, in JavaScript and files, the guarantees a cloud task gets from
its provider:

1. **A security boundary inside the realm it restricts.** A process allowlist and a network preload loaded into the worker itself
   were asked to contain code that already runs in that worker. Each repair (frozen specs, closed command lines, shell refusal,
   fd replacement) opened the next way around it.
2. **Processes known by their pid.** A second host instance and a separate supervisor process signalled workers they had not
   spawned, so every signal needed a proof that the pid was still the worker (Linux start ticks, command lines, `/proc` states
   GONE/OTHER/UNKNOWN), and every proof had a failure mode of its own.
3. **Coordination between live processes through files.** Several host instances over one root, plus the supervisor, agreed on
   creation, start, ticket delivery, verdicts and ends through exclusive files, renames, hard links, stamps and heartbeats. Each
   added file added the states "absent", "half written", "unreadable" and "written by the other side first".
4. **Hard limits measured by polling.** Memory and disk bounds against a hostile worker were a supervisor reading `/proc` and walking
   directories every 500 ms — never complete (unlinked files, directory blocks, NTFS streams, unreadable subdirectories), never
   atomic, and on Windows not enforceable at all.
5. **A trusting IPC channel treated as untrusted input.** Node's IPC parses, buffers and interprets the other side's frames before
   any host code runs; each round found another frame Node accepted (internal commands, invalid serialization, 4 GiB lengths).

The common cause: **the local host was asked to resist a compromised worker, survive and arbitrate between several live instances,
and enforce hard quotas — without any operating-system primitive that provides those properties.** Every fix therefore added a new
mechanism with new states, and the reviewer found the next example of the same five causes in the new mechanism (the supervisor
alone produced R4-1 → R4-2 → R9-2 → R10-1 → R11-2 → R13-2).

## 2. The 54 findings, by family and by what holds now

Classification of the 54 findings of rounds 1–21 (verified against the Codex session logs; R1–R21 numbering as reviewed):

| Family | Findings | Status in the target architecture |
|---|---|---|
| 1. Isolation inside the restricted realm | R1, R2-1, R2-2, R2-3, R3-1, R4-3 (6) | The allowlist is removed. Containment of a compromised worker is **not** a property of the local host; it is the cloud task's, pending AWS qualification (§6). The local limit is shown by a test, not hidden. |
| 2. Identity and termination by pid | R7, R2-5, R3-2, R4-2, R5-2, R6-2, R9-2, R10-1, R11-1, R11-2, R13-2 (11) | Gone by construction: only the host that spawned a worker ever signals it, through its own unreaped child (whose pid and process group the kernel cannot reuse). No supervisor, no foreign termination, no `/proc` identity. |
| 3. File coordination races | R3, R4, R2-4, R5-1, R6-1, R6-3, R7-1, R7-2, R8-1, R8-2, R8-3, R9-1, R10-2, R11-3, R12-1 (15) | Gone by construction: one live host per root, held by an OS lock the kernel releases at the holder's death; all decisions in one thread's memory; files are a write-through journal read only at start. |
| 4. Polled hard limits | R2, R2-6, R3-3, R4-1, R5-3, R13-1, R14-1, R15-1 (8) | The supervisor is removed. Enforced locally: V8 heap caps, the attempt's scratch quota and the core's byte ledger (in-process, for the platform's own code), the deadline (host timer + OS kill). Hard memory and disk against hostile code: the task's limits on AWS (§6). |
| 5. Node IPC as an untrusted channel | R16-1, R17-1, R18-1, R19-1, R20-1, R21-1, R21-2 (7) | Node IPC is replaced by the protocol's own frames on a plain pipe (the round-21 WIP, kept). One invariant replaces the per-case budgets: the host holds at most 16 calls from the moment it reads one until its reply has left the process, and reads nothing more meanwhile. |
| Correct fixes, kept | R5, R6, R4-4, R8, R9, R10, R7-3 (7) | Kept as they are (broker revocation and late sessions, termination before cleanup, session cap, AWS document corrections, launcher IAM). |

The later audit's concerns (empty files, supervisor loss, read errors, false absences, instance states) all belong to families 2–4
and disappear with the mechanisms that produced them: the journal is read once, at start; after that the host answers from memory.

## 3. What is kept (reviewed and working)

- Migration Core 3.0.0 and its contracts, untouched; the B05 adapter with **F1** (execute builds the source profile validate builds:
  the package is byte for byte the validated one), **F2** (the plan binding applied in the worker), **F3** (the verifier bound with
  the plane's limits), **F4/F5** (permission-model constraints, Windows working directory).
- The attempt ticket (`KAURO_ATTEMPT_TICKET_V1`, digest and canonical bytes), the storage broker (capability checks, opaque session
  handles, revocation, late-session cancellation, session cap), the worker runtime (B13 inside the worker, the D8-STG decision order),
  `@kauro/migration-worker`, `attemptInputsOf`, `PlatformAttemptTickets`, `localExecutorOf`.
- B08 (execution model, authorization, idempotency, fencing, takeover) and B13 (renderer, template 2, legal-identity refusal) — no
  change.
- The AWS qualification (`SELECTED_NOT_QUALIFIED`) and the deployment contracts in `deploy/aws/worker/`.
- The useful adversarial tests: duplicate and concurrent launches, lost answers, configuration refusals, confinement of the platform's
  code, heap / scratch / deadline limits, termination at the three stages, cancellation, host death and recovery, missing legal
  identity, altered and forged sealed generations, broker refusals, protocol violations.

## 4. What is corrected

- The worker's channel: fd 3 in the protocol's frames (framing.ts), on both sides; the worker's main no longer uses `process.send`.
- Back-pressure instead of budgets: the broker's pending-call budget and the host's outbound budget become one channel invariant.
- Termination: the owning host ends its worker's tree through its own child — Linux: the worker's process group, while the worker is
  unreaped; Windows: the worker's handle, its children in its kill-on-close job object.

## 5. What is replaced

| PR #111 | Replaced by |
|---|---|
| Process allowlist preload (`worker-preload.ts`) | Nothing in the worker's realm. The trust model is explicit (§7) and the local limit is demonstrated by a test. |
| Supervisor process (`supervisor.ts`), verdict and stand-down files | The host's own timer and kill; on host death, the kernel (Windows: the host's kill-on-close job object; Linux: the worker's parent-death signal, `setpriv --pdeathsig KILL`). |
| Instance heartbeats, foreign termination by pid, `terminate.request` | One live host per root (an OS lock released at process death). A new host finalises the previous one's unfinished jobs at start. |
| Pending-creation stamps, tombstone renames, `start.claim`, `ticket.claim`, `end.json` hard links | One thread's in-memory state; atomic write-through records (temporary file, `fsync`, rename). |
| `/proc` and CIM identity checks, attempt-marked process sweeps | Unneeded: no process is signalled except the host's own unreaped child and its group. |

## 6. Guarantees that wait for AWS (pending real qualification)

These are required by the order and **not** delivered by the local host. They are not lowered; they are assigned to the boundary that
can provide them, and stay `PENDING_AWS_QUALIFICATION` until the live probes of the qualification document run:

- Containment of a **compromised** worker (code running in the worker that spawns a native program, reaches the network, or reads
  the host user's files): one Fargate task per attempt, its own filesystem, network policy and per-attempt IAM role.
- **Hard** memory and ephemeral-disk limits against code that bypasses the in-process quotas: the task's cgroup memory limit and
  ephemeral storage limit.
- Multi-tenant isolation between agencies on one machine.
- Everything already listed as blocked in the qualification document (token horizon, Chromium sandbox on Fargate, IAM life cycle,
  bucket policy, pull time, task retirement).

Safe behaviour meanwhile: the deployed control plane binds no executor (D8-PORT-1, unchanged); the local host's evidence class is
`EXECUTED_LOCAL`, never a provider's; and the host refuses a configuration that does not state its trust model
(`isolation: "SINGLE_TENANT_QUALIFICATION"`).

## 7. Target architecture (chosen)

**A local qualification host: real processes, real cores, real browser, real storage capability — and only the guarantees the
operating system actually provides.** Its trust model: it runs the platform's own worker code on synthetic data, one tenant, one
machine. The threat it resists is a malicious *input* (a customer file reaching Migration Core, a report reaching Chromium), whose
containment is B05's and B13's: the core child under the C++ permission model without child processes, Chromium sandboxed, offline,
JavaScript off. It does not claim to contain a compromised worker.

| Property | How it holds locally | Kind |
|---|---|---|
| One host per root | Windows named pipe / Linux abstract socket, exclusive, released by the kernel at the holder's death | OS |
| Creation by identity, ALREADY_EXISTS, REFUSED creates nothing, NOT_FOUND stays true | One thread decides; the record is written (temp, fsync, rename) before the worker exists; a termination of an absent identity leaves a tombstone; a launch's read is bounded by half the creation horizon | Single-owner state |
| Restart and recovery | The new owner (lock acquired = previous owner dead) finalises unfinished jobs `FAILED WORKER_CRASHED HOST_RESTARTED`; B08 takes over at fence + 1. A worker without its host has no broker, so it can produce no effect | OS + B08 |
| Termination of the whole tree | Linux: `kill(-pgid)` of the host's unreaped child's group; Windows: the worker's handle, its children in its kill-on-close job | OS |
| Host death | The kernel ends the worker, even one stuck in synchronous work. Windows: the host's kill-on-close job object (and the worker's own job ends its children). Linux: the worker's parent-death signal; its core child ends at its next report on the closed pipe, Chromium when its debugging pipe closes | OS |
| Storage capability | The broker in the host; the worker holds no credential, no session reference | Real boundary |
| No credentials | Empty environment; no database connection | Real boundary |
| Files | Node permission model (C++): worker reads code, browser, own attempt; writes own attempt. The core child has no child-process permission | Real for JS; see §6 for native children |
| Network | Network preload (worker and core child), Chromium offline | Platform code only; see §6 |
| Time | Host timer → tree kill, `DEADLINE_EXCEEDED` | OS |
| Memory | V8 heap caps of worker and core child; heap death recorded `MEMORY_EXHAUSTED` | V8 |
| Disk | AttemptScratchStore quota and the core's byte ledger → `SCRATCH_EXHAUSTED` | In-process |
| Channel | Own frames, bounded prefix, ≤ 16 calls held until their replies are flushed, reading paused meanwhile; a violation ends the attempt, never the host | By construction |

Why not the alternatives, in one line each: a container host (Docker) would give OS isolation locally, but no container runtime exists
on this machine or on the Windows CI leg, and Chromium's sandbox inside a container is itself an open AWS probe; an OS sandbox
(AppContainer, bubblewrap) needs native code per platform; continuing PR #111 keeps the five causes.

## 8. Dependencies and risks

- Node 24's `net` gives both locks (named pipe with first-instance semantics on Windows, verified on this machine; abstract sockets
  on Linux, verified in CI). Abstract sockets are per network namespace: one machine, one namespace (stated).
- Windows: the worker's channel must be an overlapped pipe; with a synchronous one the worker's pending read holds its own writes back
  (found while building this, before any review).
- Linux: Playwright starts Chromium in a session of its own, outside the worker's group. A termination reaches it through the
  worker's live process tree (`/proc` parent links from the host's pinned child); after a host death it relies on Chromium closing
  when its debugging pipe closes. The parent-death signal needs util-linux `setpriv` (present on Ubuntu; the host refuses to open
  without it). The termination and host-death tests check, at the OS, that no process of the attempt survives on both platforms.
- Windows: the job-object chain (host → worker → core child and browser) is libuv's; the same OS checks cover it.
- Residual (POSIX): the post-exit sweep of the worker's group signals a group whose leader has been reaped. The number cannot be
  reused while any member lives; it could be reused only after every member has gone and the pid space has wrapped — stated.
- The B08 and B13 suites, the PDF template of PR #113 and the end-to-end suite on PostgreSQL 17 are re-run unchanged.
- PR #114 (Windows EPERM in tools) is not touched; a Windows gate flake of that kind is reported, not patched here.
