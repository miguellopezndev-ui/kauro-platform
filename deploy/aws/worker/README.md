# The migration worker on AWS — deployment contracts (B14-A)

**Status: contracts only.** Nothing in this directory has been built, registered, applied or run. There is no AWS account (A9 §5),
and no Terraform `apply` or push to ECR happened. The host these contracts are for is **selected but not qualified** (live proofs pending):
[docs/design/B14-A-aws-host-qualification.md](../../../docs/design/B14-A-aws-host-qualification.md). The code they deploy is
[docs/design/B14-A-worker-executor.md](../../../docs/design/B14-A-worker-executor.md).

| File | What it fixes |
|---|---|
| `Dockerfile` | The image: Node 24.20.0 on Debian bookworm pinned by digest, Chromium from a fixed `snapshot.debian.org` date, the workspace from its lockfile, the worker started as non-root user 10001 under the Node permission model, read-only root, scratch at `/scratch` |
| `task-definition.template.json` | Fargate, Linux/x86_64, 2 vCPU, 8 GiB (the attempt's hard memory), 72 GiB ephemeral storage (64 GiB hard scratch plus the image and the browser's profile), `stopTimeout` 30 s, `awslogs` |
| `run-task.template.json` | One `RunTask` per launch: `clientToken` = the attempt id, `startedBy` = the identity, `overrides.taskRoleArn` = the attempt's own role, and the ticket's key and SHA-256. Never a secret: `DescribeTasks` shows overrides |
| `iam/attempt-role.policy.template.json` | One attempt's capability as IAM: read its ticket and its sealed object versions; create (If-None-Match) under its prefix and its claim and result keys, the multipart steps that cannot carry the header allowed apart (`s3:ObjectCreationOperation` = false); abort its own multipart uploads; write its heartbeat; read its own prefix back |
| `iam/attempt-boundary.policy.json` | The ceiling no attempt role can exceed (the launcher may create roles only with it) |
| `iam/launcher.policy.template.json` | The control plane: run, observe and stop tasks in one cluster (tagging a task only as part of its own RunTask, with its two tag keys); create, pass and delete `kauro-attempts/*` roles within the boundary; write tickets once; read the protocol keys |
| `iam/execution-role.policy.template.json` | ECS's own role: pull the one repository, write the one log group |
| `bucket-policy.template.json` | TLS only; attempt roles only through the S3 gateway endpoint; no unconditional create of staging, ticket, claim or result keys; attempt roles never delete |

## The worker's protocol on S3 (what `EcsFargateWorkerHost` and the worker's S3 transport implement)

The local protocol (IPC; `packages/data-plane/src/host/protocol.ts`) and this one carry the same facts. The local host's job directory
plays the part of the claim object.

| Key | Written by | How | Read by |
|---|---|---|---|
| `tickets/<identity>` | the control plane, when it records the launch intent | `If-None-Match: *` | the worker (it refuses bytes whose SHA-256 is not `KAURO_TICKET_DIGEST`) |
| `claims/<identity>` | the worker, before anything else | `If-None-Match: *`; `412` → this task is a duplicate and exits before it reads a source byte | the host's `observe` |
| `heartbeat/<identity>` | the worker, at most every 30 s (each cancellation check) | overwrite | `observe` (`lastHeartbeatAt`) |
| `staging/<agency>/<project>/<job>/<attempt>/…` | the worker's `FencedArtifactWriter` | `If-None-Match: *`; read back by exact version | B08's submission and verification |
| `results/<identity>` | the worker, once | `If-None-Match: *`: `{state, cause, manifest, refusal, peaks}` (the same `WorkerResultReport`) | `observe` (SUCCEEDED / FAILED, manifest) |

`launch`: `RunTask` with `clientToken` = the attempt id; the task ARN of the answer is recorded at once; a lost answer is retried with the same token inside the hour the token is guaranteed (qualification §3), and an identity is never created again after that hour.

`observe(identity)` (never infers an end from absence):
- a result → its state;
- the recorded ARN described STOPPED → the end the task reports (no result: `FAILED WORKER_CRASHED`, taken over at fence + 1);
- a visible task, or a claim with no result and no visible task → still running, its last heartbeat as `lastHeartbeatAt` (a stale one lets B08's lease lapse, and B08 terminates before it abandons);
- no ARN, no claim, no task → `NOT_FOUND` only after a same-token retry inside the hour answered without a task; until then uncertain.

`terminate(identity)`: `StopTask` on every task the identity names, and the deletion of the attempt role, which revokes the
attempt's credentials. `resources(identity)`: from `DescribeTasks` (cpu, memory, ephemeral storage, start and stop) while visible,
then from the result's peaks; cost = runtime × the rates of the qualification's §7.

## Configuration per environment (no secret is configuration)

| Setting | dev / qualification | production |
|---|---|---|
| Region | us-east-1 | us-east-1 (legal checklist A-06) |
| Cluster, task definition family | `kauro-<env>`, `kauro-migration-worker` | same |
| Subnet | one private subnet, one AZ (A9: no permanent HA) | same until a reliability contract requires more |
| Endpoints | S3 gateway; `ecr.api`, `ecr.dkr`, `logs` interface endpoints in that AZ | same |
| Bucket | one per environment, SSE-S3, versioning on (B15 maps a version id to the platform's generation grammar: qualification §6 item 7) | same |
| Log group | `/kauro/<env>/migration-worker`, 30-day retention | per the retention schedule |
| `creationHorizonSeconds` | 3600 (the token's guaranteed hour) | 3600 |
| Limits | `EXECUTION_POLICY` and manual 04: 8 GiB, 64 GiB, 8 h | same |

## What is logged

Only identifiers, tokens and sizes: the identity, the stage (`STARTED`, `CORE_STARTED`, …), the result's cause and refusal token,
peaks and durations. The worker's diagnostic line is an error's name, code and message (`diagnosticOf`). A refusal's message names
closed codes only. No customer value, path content, credential or ticket byte is logged. The local host keeps that line in memory
and never writes it to its record.

## Recovery procedure (operator)

1. **Control plane restarted.** Nothing to do. Workers keep running on Fargate. `observe` reads the task and the S3 keys, so no
   attempt is lost or run twice. (Locally, the workers of a dead host end themselves and the attempt is taken over.)
2. **A task stuck or silent.** The lease lapses (120 s). ATTEMPT_MONITOR terminates the identity, observes it terminal, abandons
   the attempt and takes it over at fence + 1, up to three attempts inside the 8 h wall.
3. **A claim with no task and no result** (killed, or retired by Fargate). Same path: `FAILED WORKER_CRASHED` → takeover.
4. **Orphaned resources.** STAGING_JANITOR (D8-JAN-1) cleans one ended attempt at a time: terminate, list exactly its prefix,
   delete what no AVAILABLE package keeps, delete its scratch (the task's storage goes with the task), delete its role, record the
   pass. A role or task left behind by a crash is found by the identity's prefix (`kauro-attempts/kauro-attempt-*`,
   `startedBy`).
5. **Never** delete a REVOKED package's staging by hand: it is private evidence (R2-045) until its retention ends (B16).

## What the next phase needs first

An AWS account under Kauro Data S.A.S. (A9 §5) and a provisioning authorization; Terraform for the VPC, endpoints, bucket, cluster,
roles and log group (from these contracts); B15's S3 `ObjectStoragePort`; `EcsFargateWorkerHost` and the worker's S3 transport
(the AWS SDK added then, pinned); the first image build and scan; the live probes of the qualification's §6.
