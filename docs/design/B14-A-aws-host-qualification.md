# B14-A — Qualifying the AWS worker host (on documentation)

Order 9, first part of B14. Under amendment A9 AWS is the primary cloud. This document qualifies the service that will run one
processing attempt as one isolated worker. The worker's own code is in [B14-A-worker-executor.md](B14-A-worker-executor.md). No AWS
account was opened and no AWS resource was created or called. Every fact about AWS below comes from AWS's official documentation and
pricing pages, read on **2026-10-18**; each one is cited in §8.

**Verdict: `QUALIFIED_ON_DOCUMENTATION` — Amazon ECS `RunTask` on AWS Fargate, Linux/x86_64.** Each attempt runs as one task. A
claim object in S3, written with a conditional write, makes sure an attempt runs only once. Each attempt gets its own task role.
This is a design verdict, not an execution verdict: §6 lists what only a real AWS account can prove. Until those proofs exist the
host is **not** declared operational, and no test result may be called `EXECUTED_PROVIDER`.

Region: **us-east-1**. The legal checklist requires US Regions in IaC (`docs/legal/CHECKLIST.md` A-06, DPA §9). The prices in §7 are
us-east-1 prices.

## 1. What the host must guarantee (from B08, unchanged)

`WorkerHostPort` (`packages/application/src/ports/worker-host.ts`) and the B08 control plane already define the contract. The host
adapts to the contract; the contract does not change for the host.

| # | B08 invariant | Where it is required |
|---|---|---|
| I1 | One provider job per deterministic identity `kauro-attempt-<attemptId>`, for good. A second launch adopts the first job (`ALREADY_EXISTS`). | D8-HOST-1, D8-DUP-1 |
| I2 | A launch whose answer is lost is `AMBIGUOUS`. Nothing is created again until `observe(identity)` answers, and only `NOT_FOUND` **after the creation horizon** proves that nothing was created. | D8-HOST-1, S056 |
| I3 | `observe`, `terminate` and `resources` act by identity, for the whole life of the job and after a control-plane restart. | D8-ATT-2, D8-JAN-1 |
| I4 | A worker can read only its attempt's sealed generations and write only under its own staging prefix (and its manifest name). | D8-STG-1, B14 registry "capability broker" |
| I5 | Termination ends exactly one identity. A cancellation, deadline or lost lease always leads to a termination. | D8-CANCEL-1, D8-DL-1 |
| I6 | The attempt runs within its limits: 8 GiB hard memory, 64 GiB hard scratch and an 8 h wall clock (manual 04 "Resources"). | `EXECUTION_POLICY`, `ExecutionLimits` |
| I7 | The worker holds no database credential and no privileged platform credential (order 9 §3). | D8-ATT-2 ("the worker opens no SQL pool") |

## 2. Candidates and what the documentation says

| Property | AWS Batch on Fargate | Amazon ECS `RunTask` on Fargate |
|---|---|---|
| Idempotent create | **None.** `SubmitJob` has no client token, and `jobName` is not documented as unique [A1]. | `clientToken` (≤ 64 chars). "Requests with the same token in the same cluster are idempotent" [B1]. |
| How long the idempotency lasts | — | TTL = the lower of **24 h** and **the task's lifetime + 1 h** [B1]. |
| Same token, different request | — | `ConflictException` naming the existing task ARNs [B1]. |
| Lookup by our identity | `ListJobs` filter `JOB_NAME`, case-insensitive prefix match, up to 100 results [A2]. A name is a label, not a key. | `startedBy` (≤ 128 chars) on `RunTask`. `ListTasks(startedBy=…)` is exact, and it must be the only filter [B2]. |
| How long a finished job stays visible | SUCCEEDED and FAILED jobs are kept "for at least 7 days" [A2]. | Stopped tasks appear "for at least one hour" [B3]. |
| Consistency | Not documented [A2]. | The ECS API is "eventual consistency" [B3]. |
| Per-attempt credentials | **No.** `jobRoleArn` is set only in the job definition. Overrides carry command, environment, instance type and resources only [A5]. | **Yes.** `overrides.taskRoleArn` applies to "all containers in this task" [B5]. |
| Termination by identity | `TerminateJob(jobId)` [A3] | `StopTask(taskArn)`: SIGTERM, then SIGKILL after `stopTimeout` (Fargate 2–120 s) [B6] |
| Time limit | `attemptDurationSeconds` ≥ 60 s, best effort; at most 14 days on Fargate [A3, A4] | No task time limit is documented. Fargate task retirement can stop a standalone task [B7]. |
| Memory / disk | 2 vCPU: 4–16 GiB; ephemeral storage 21–200 GiB [A4] | 2 vCPU: 4–16 GB; ephemeral storage 20 GiB included, up to 200 GiB [B7] |
| State events | — | EventBridge "ECS Task State Change", *durable* (at least once), may be duplicated [B8] |
| Service charge | None; you pay for Fargate [A4] | None; you pay for Fargate [D7] |

## 3. The decisive risk, and how it is closed

**Batch.** `SubmitJob` cannot be made idempotent. A retry after a lost answer can create a second job, and nothing in Batch prevents
or deduplicates it. Searching `ListJobs` by `jobName` is a prefix match over an eventually consistent list (its consistency is not
even documented), and the job name is not unique. So a lookup by name is **not** proof that a job was created once. Batch also cannot
give each job its own role (§2), so I4 would rest on one shared role that every attempt can use. Batch's other features (queues,
retries, job timeouts) duplicate what B08 already does (admission, takeover, `JOB_DEADLINES`).

**ECS RunTask.** It is idempotent with `clientToken = attemptId` (36 characters), but only within the token's lifetime: at most
24 h, and only the task's lifetime plus one hour once the task stops. B08 needs I1–I3 for the whole job, up to the 48 h delivery
deadline. The token alone therefore does not qualify, and **the platform does not rely on it past its lifetime.** Four mechanisms
carry the invariants instead:

1. **The claim object (I1, at most once).** The worker's first action is a conditional write
   (`PutObject … If-None-Match: *`) of `claims/<identity>`. S3 guarantees that "the first write operation to finish succeeds" and
   that every later one gets `412 Precondition Failed` [C4]. A second task of the same identity (a duplicate create, a retry after
   the token expired, a redelivery) loses that race. It exits **before it reads a source byte**, and its task role lets it write
   nothing else first (§4). S3 has strong read-after-write consistency for PUT [C4], so the check does not depend on ECS
   consistency or ECS retention.
2. **Durable observation (I3).** `observe(identity)` combines `ListTasks(startedBy=identity)` and `DescribeTasks` (for the minutes
   and hours while a task is visible) with the S3 objects the worker writes under its own claim: `claims/<identity>` (it started),
   `heartbeat/<identity>` (its last sign of life, at most every 30 s) and `results/<identity>` (its one result: manifest reference
   or cause; conditional write). These objects outlive ECS's one-hour visibility of stopped tasks. A missing task with a claim and no
   result is `FAILED WORKER_CRASHED`, which B08 resolves by abandoning the attempt and taking it over at fence + 1. A missing task with
   no claim is `NOT_FOUND`.
3. **The creation horizon (I2).** `RunTask` is a synchronous call. If its answer is lost, the adapter's observation does not
   answer `NOT_FOUND` before `creationHorizonSeconds` = **900 s** has passed since the launch was recorded. That covers ECS's
   eventual consistency (AWS recommends backing off "up to five minutes" [B3]). Because 900 s is far below the token's 24 h lifetime,
   every relaunch B08 makes after the horizon (D8-HOST-1) is still **deduplicated by the same token** (`clientToken = attemptId`). If a
   create ever lands after the horizon anyway, mechanism 1 stops it: the late task finds the claim taken, or takes the claim first
   and the earlier task exits. Either way exactly one runs.
4. **Fences for everything else.** B08 accepts staged rows only from the lease's current attempt (KA080), at its fence. A stale task
   that somehow wrote objects cannot get them submitted. Read-back by exact generation and the publication guard reject anything
   that is not the current attempt's (S056, S061).

A late `RunTask` retry with the same token but a different request answers `ConflictException` with the existing task's ARN [B1].
The adapter treats that as `ALREADY_EXISTS` (adopt). The local executor reproduces these semantics and runs them with real processes
(the exclusive job directory plays the claim's part; see B14-A-worker-executor.md §6). The AWS adapter itself is the next phase (§6).

## 4. Credentials, network and storage (I4, I7)

- **Per-attempt task role.** For each attempt, the launcher (the control plane) creates the role `kauro-attempt-<attemptId>`
  (50 characters; IAM names may be up to 64 [C6]) with an inline policy that allows exactly:
  - `s3:GetObject` with `s3:VersionId` on each sealed key of the capability;
  - `s3:PutObject` on `staging/<agency>/<project>/<job>/<attempt>/*`, `claims/<identity>`, `results/<identity>` and
    `heartbeat/<identity>`. A bucket-policy statement requires `s3:if-none-match` on every key except the heartbeat [C4];
  - `s3:GetObject` on its own prefix (read-back).

  The role is under a **permissions boundary** that the launcher's `iam:CreateRole` must attach (condition
  `iam:PermissionsBoundary`), so the launcher cannot create a broader role. `RunTask` names the role through
  `overrides.taskRoleArn` [B5]. When the attempt ends, STAGING_JANITOR deletes the role. The credentials on the task's metadata
  endpoint (169.254.170.2) [C2] are therefore the attempt's own credentials, and nothing can take them beyond the attempt's limits.
  That answers the B14 registry item "metadata credentials cannot bypass per-attempt storage limits". AWS warns that "containers are
  not a security boundary" [C2]. Here the boundary is the role: one attempt per task, one role per attempt.
- **IAM is eventually consistent** [C5]. A new role may not be assumable at once. The launcher creates the role while recording the
  launch intent, then calls `RunTask`. If ECS cannot assume the role yet, the task fails before the claim, the attempt is observed
  `NOT_FOUND`/failed and B08 retries (takeover or relaunch). The role quota (1 000 by default, up to 10 000 [C6]) is far above
  `heavyActive = 1`.
- **No database or platform credential in the task.** The ticket (KAURO_ATTEMPT_TICKET_V1) is written by the control plane to
  `tickets/<identity>` with a conditional write. Its SHA-256 goes into the task's `overrides.environment`, and the worker refuses any
  ticket with another hash. The report inputs travel inside the ticket (§3 of the executor design). The worker reads nothing from
  the database.
- **Network.** The task runs in **private subnets with no route to the internet and no NAT**. Its security group allows egress on
  443 only to the VPC endpoints. An S3 **gateway** endpoint is free [D2]. Pulling from ECR on Fargate 1.4 needs the `ecr.api` and
  `ecr.dkr` interface endpoints and S3. `awslogs` needs `logs` [C1]. On Fargate 1.4 all of the task's traffic, image pull and logs
  included, goes through the task's ENI [B7], so there is no separate unrestricted path. Interface endpoints are a fixed cost (§7).
  Amendment A9 allows them only when a security contract requires them. Order 9 §4 requires "sin acceso arbitrario a red". The
  alternative, a public IP with an internet route, would give customer-data code an open path to the internet and is rejected. Inside
  the task, the worker's own network entry points are refused and Chromium runs offline with every request aborted (executor
  design §5).
- **Storage encryption.** SSE-S3. SSE-KMS would add a `kms` interface endpoint and per-request charges that nothing here requires.

## 5. Alternatives discarded

| Alternative | Why not |
|---|---|
| AWS Batch on Fargate | No idempotent create, no per-job role, a name lookup is not proof of a single creation (§3); Batch's queue duplicates B08's scheduler. It could become usable only with the same claim object plus one job definition per attempt for the role: more moving parts, the same cost. |
| AWS Lambda | 15-minute limit, at most 10 GB memory and `/tmp` (manual 04 needs 8 h and 64 GiB). |
| EC2 (own instances, or Batch on EC2) | Fixed or warm capacity cost, image and patch operations; A9 asks for the cheapest option that keeps the contracts, and Fargate charges only for running tasks. |
| EKS / Kubernetes | Excluded by A9. |
| Public IP instead of interface endpoints | Unrestricted egress for code that handles customer data (§4). |
| Linux/ARM64 (Graviton) | About 20 % cheaper per second (§7). Not qualified yet: Chromium's sandbox and the image's ARM64 Chromium build need their own live test. It can be switched after the x86_64 qualification, at no cost to the design. |

## 6. Not proved without AWS (blockers of `EXECUTED_PROVIDER` and of G-CLOUD)

1. The `clientToken` behaviour, `ConflictException`, and the visibility of `startedBy` under load (a live probe).
2. That Chromium's **sandbox** starts as the image's non-root user on Fargate. Fargate grants no extra kernel capabilities, and the
   documentation does not say whether unprivileged user namespaces are available. The engine never disables the sandbox (B13): if
   Fargate refuses it, printing fails closed, and this host is **not** qualified for the report until it is resolved.
3. The per-attempt role life cycle under IAM's eventual consistency (create → `RunTask` → assume → delete).
4. That the S3 bucket policy actually rejects unconditional PUTs (`s3:if-none-match`) and that the gateway endpoint policy limits
   the task to the bucket.
5. Image pull time and size through the interface endpoints; the real `peakScratchBytes` against 72 GiB of ephemeral storage.
6. An attempt killed by Fargate task retirement [B7], observed as `FAILED WORKER_CRASHED` and taken over.
7. **The generation grammar.** B07 and B08 name an object's generation as a decimal string of up to 20 digits (Cloud Storage's
   int64; `GENERATION` in `ports/worker-host.ts`). An S3 version id is an opaque string. B15's S3 adapter must keep a reversible
   mapping between the two (for example a per-object version counter recorded with each version id), or the grammar has to change.
   That is a design decision for B15, not settled here, and the S3 side of every "exact generation" read depends on it.
8. The adapter itself (`EcsFargateWorkerHost`) and B15's S3 `ObjectStoragePort`. Their contracts are fixed in
   `deploy/aws/worker/` and in §3 here; their code needs the AWS SDK, which is not added before the account exists.

## 7. Cost (us-east-1; formula, rates and what is not qualified)

Rates read from AWS's own pricing pages on 2026-10-18 [D1–D6]. Where a page loads its table by script, the figure is the one the page
states in its own worked example, marked "(example)", and must be confirmed in the AWS Pricing Calculator before a budget is set.

| Item | Rate | Kind |
|---|---|---|
| Fargate Linux/x86, vCPU | $0.000011244 per vCPU-second (≈ $0.04048/h) | per run |
| Fargate Linux/x86, memory | $0.000001235 per GB-second (≈ $0.004446/h) | per run |
| Fargate ephemeral storage above 20 GB | $0.0000000308 per GB-second | per run |
| Fargate billing | per second, 1-minute minimum, from the start of the image pull | per run |
| Interface VPC endpoint | $0.01 per hour per endpoint ENI (example) + $0.01/GB processed | **fixed** |
| S3 gateway endpoint | no charge | — |
| ECR storage | $0.10 per GB-month (example; no Region named) | fixed |
| CloudWatch Logs ingestion | $0.50 per GB (example, US East) | per run |
| S3 GET | $0.0004 per 1,000 | per run |
| S3 PUT, S3 Standard storage | not readable in the page text — **unqualified** | per run |
| ECS, Batch | no service charge | — |

**Per run** (task 2 vCPU, 8 GB, 72 GiB ephemeral = 52 GB billed above 20):
`cost = T_seconds × (2 × 0.000011244 + 8 × 0.000001235 + 52 × 0.0000000308) = T × $0.0000339696` → **$0.00204 per minute**
(minimum one minute). Examples: 5 min ≈ $0.010; 15 min ≈ $0.031; 1 h ≈ $0.122; the 8 h wall ≈ $0.98, the most one attempt can cost.
B08 allows three attempts, so one job costs at most ≈ $2.94 in Fargate. The run duration of real packages is **not qualified**: the
local runs of §8 in the executor design (seconds, on a laptop) say nothing about Fargate.

**Fixed cost with no job running**: three interface endpoints (`ecr.api`, `ecr.dkr`, `logs`) in **one** Availability Zone (A9
excludes permanent HA): 3 × $0.01 × 730 h ≈ **$21.90 / month**, plus ECR storage of about 1 GB ≈ $0.10 / month. Everything else
(cluster, task definition, roles, S3 gateway endpoint) costs nothing at rest. A9's historical figures (USD 66.02 "Uso bajo") are not
reused (A9 §6). This sheet is the worker host's share only: the database, the API and the queues are B14's other parts.

**Not qualified**: S3 PUT and storage rates; endpoint data processing per launch (≈ image size × $0.01/GB); real durations; the
ARM64 discount (§5); Pricing Calculator confirmation of the "(example)" rates.

## 8. Sources (all official, all read 2026-10-18)

- [A1] Batch `SubmitJob`: https://docs.aws.amazon.com/batch/latest/APIReference/API_SubmitJob.html — the request parameters list no
  token; "jobName … It can be up to 128 letters long"; the 14-day Fargate note.
- [A2] Batch `ListJobs`: https://docs.aws.amazon.com/batch/latest/APIReference/API_ListJobs.html — "JOB_NAME — … a case-insensitive match
  … If the value ends with an asterisk (*), the filter matches any job name that begins with the string"; job states:
  https://docs.aws.amazon.com/batch/latest/userguide/job_states.html — "persisted in AWS Batch for at least 7 days".
- [A3] Batch `TerminateJob`: https://docs.aws.amazon.com/batch/latest/APIReference/API_TerminateJob.html; timeouts:
  https://docs.aws.amazon.com/batch/latest/userguide/job_timeouts.html — "Timeout terminations are handled on a best-effort basis."
- [A4] Batch Fargate resources: https://docs.aws.amazon.com/batch/latest/APIReference/API_ResourceRequirement.html,
  https://docs.aws.amazon.com/batch/latest/APIReference/API_EphemeralStorage.html; pricing: https://aws.amazon.com/batch/pricing/ — "There
  is no additional charge for AWS Batch."
- [A5] Batch overrides: https://docs.aws.amazon.com/batch/latest/APIReference/API_ContainerOverrides.html,
  https://docs.aws.amazon.com/batch/latest/APIReference/API_ContainerProperties.html — `jobRoleArn` in the job definition only.
- [B1] ECS idempotency: https://docs.aws.amazon.com/AmazonECS/latest/APIReference/ECS_Idempotency.html — "The time to live (TTL) for the
  RunTask client token is 24 hours… whichever of the following two values is lower: 24 hours; The lifetime of the resource plus one
  hour"; "the retry fails with a ConflictException". `RunTask`: https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html
- [B2] `ListTasks`: https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ListTasks.html — "When you specify startedBy as the
  filter, it must be the only filter that you use."
- [B3] `DescribeTasks`: https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DescribeTasks.html — "stopped tasks appear in the
  returned results for at least one hour"; `RunTask` — "The Amazon ECS API follows an eventual consistency model".
- [B5] `TaskOverride`: https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_TaskOverride.html — `taskRoleArn`: "All containers
  in this task are granted the permissions that are specified in this role."
- [B6] `StopTask`: https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_StopTask.html; `stopTimeout`:
  https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html — "The valid values for Fargate are 2-120 seconds."
- [B7] Fargate task sizes: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html; storage:
  https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-storage.html; networking:
  https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html — "all network traffic flows through that
  ENI"; retirement: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-maintenance.html
- [B8] EventBridge ECS events: https://docs.aws.amazon.com/eventbridge/latest/ref/events-ref-ecs.html — "Delivery type: Durable";
  duplicates: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_cwe_events.html
- [C1] ECR VPC endpoints: https://docs.aws.amazon.com/AmazonECR/latest/userguide/vpc-endpoints.html — "Amazon ECS tasks hosted on Fargate
  using platform version 1.4.0 or later require both Amazon ECR VPC endpoints and the Amazon S3 gateway endpoints."
- [C2] Task IAM roles: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-iam-roles.html,
  https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html — "Containers are not a security boundary".
- [C3] Role chaining: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_terms-and-concepts.html — "a maximum of one hour" (why the
  launcher does not hand the task chained credentials).
- [C4] S3 conditional writes: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html — "the first write operation
  to finish succeeds"; enforcement: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html; consistency:
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html — "strong read-after-write consistency for PUT and DELETE".
- [C5] IAM consistency: https://docs.aws.amazon.com/IAM/latest/UserGuide/troubleshoot_general.html
- [C6] IAM quotas: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html — "Roles per account | 1000 | 10000".
- [D1] https://aws.amazon.com/fargate/pricing/ — "CPU cost: $0.000011244 per vCPU second, memory cost: $0.000001235 per GB per second,
  and ephemeral storage cost: $0.0000000308 per GB per second"; "per second with a 1-minute minimum".
- [D2] https://aws.amazon.com/privatelink/pricing/; https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html — "There is
  no additional charge for using gateway endpoints."
- [D3] https://aws.amazon.com/ecr/pricing/ · [D4] https://aws.amazon.com/cloudwatch/pricing/ · [D5] https://aws.amazon.com/s3/pricing/ ·
  [D6] https://aws.amazon.com/vpc/pricing/ · [D7] https://aws.amazon.com/ecs/pricing/
