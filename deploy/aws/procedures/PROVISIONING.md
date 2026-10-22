# Provisioning, rollback and controlled destruction (Order 25 §9–10)

To be executed **only after** the gates of [ACTIVATION.md](ACTIVATION.md) allow it, in the owner's Identity Center session (MFA),
from a clean checkout of the reviewed `main`. Nothing here runs in CI. Commands use OpenTofu (`tofu`); Terraform (`terraform`)
works the same with `terraform-registry.lock.hcl` copied over `.terraform.lock.hcl` first.

Inputs the owner keeps outside this public repository (a `terraform.tfvars` per root and a `backend.hcl` per root, both ignored by
`deploy/aws/.gitignore`): account ids, the organization id, the owner's Identity Center user id, the activation reference, the
monthly ceiling. None of them is a secret, but none belongs in a public repository either.

## 0. Before the first apply

1. `git log -1` is the reviewed `main`; `node --test tools/test/aws-infrastructure.test.mjs` passes; in each root
   `tofu init -backend=false -lockfile=readonly && tofu validate && tofu test` passes.
2. `aws sts get-caller-identity` (the owner's session) shows the expected account and the `AWSReservedSSO_KauroOwnerAdministrator_…`
   role (or, for the very first management apply, the owner's administrator before Identity Center exists: see step 1).
3. `tofu plan -out=plan.bin` and read the whole plan. Apply only `plan.bin`, never an unreviewed plan.

## 1. Order of the first apply

| Step | Root | What it creates | Needs from before | Rollback if it fails or is wrong |
|---|---|---|---|---|
| 1 | management | organization (all features, SCP + RCP types), OUs, the data and workload accounts, guard SCPs/RCP, CloudTrail delegated administrator, permission sets, budget + spend stop, anomaly detection, state bucket | gates 1–2 | Detach the guard policies (`aws organizations detach-policy`) before anything else if a guard locks the owner out (the management account is never bound by them); member accounts are never closed by Terraform (`close_on_deletion = false`, `prevent_destroy`) |
| 2 | workload | VPC, subnets, route table, S3 gateway endpoint, security groups, ECR repository, cluster, log group, execution and control-plane roles, attempt boundary, launcher policy, GitHub OIDC provider and image publisher, state bucket. **Not**: interface endpoints, task definition, database | step 1 outputs: `owner_admin_role_pattern`, the account ids | `tofu destroy -target=…` of the failed resource only; nothing here holds data yet |
| 3 | data | customer-data and journal buckets (Object Lock), audit bucket, organization trail, guard alarms (confirm the SNS e-mail), deletion role, signing profile, code-signing configuration, signing bucket, state bucket | step 1 and step 2 outputs: `organization_id`, `s3_gateway_endpoint_id`, the role patterns | Buckets with Object Lock cannot be deleted while they hold locked versions and are `prevent_destroy`: a wrong bucket is left empty and renamed in configuration, never forced |
| 4 | management | (re-apply) assignments of the owner's permission sets once the user id is known | the owner's Identity Center user id | Remove the assignment |

### Bootstrap of each root's state

Each root starts on local state, creates its own state bucket (`tfstate-kauro-<account id>`), then moves its state there:

```sh
cat > backend_override.tf <<'EOF'
terraform {
  backend "local" {}
}
EOF
tofu init && tofu apply plan.bin            # the first apply, on local state
rm backend_override.tf
cat > backend.hcl <<'EOF'
bucket       = "tfstate-kauro-<account id>"
key          = "<management|data|workload>/terraform.tfstate"
region       = "us-east-1"
use_lockfile = true
EOF
tofu init -migrate-state -backend-config=backend.hcl
```

The local `terraform.tfstate` is then deleted only after `tofu state list` from the bucket matches it.

### Adopting an account that already exists

If the owner opened a member account by hand, adopt it instead of creating it again, in `accounts/management/imports.tf` (not
committed): `import { to = module.organization.aws_organizations_account.data  id = "<account id>" }`, then plan: the plan must
show no replacement.

## 2. Enabling the worker (qualification, then production)

1. Build the image from `deploy/aws/worker/Dockerfile` (CI or the owner's machine), scan it (ECR scan on push), record its digest.
2. Push with the GitHub `aws-<environment>` deployment environment (the owner approves the job; the image publisher can only push).
3. Set `worker_image_digest = "sha256:…"` and `worker_enabled = true` in the workload root, plan, read, apply. This creates the three
   interface endpoints (the only fixed cost of the worker, USD 21.90/month) and registers the task definition.
4. To stop the fixed cost when no attempt is expected: `worker_enabled = false`, apply. Running tasks end first (B08 terminates them);
   new RunTasks then fail closed (no image pull, no logs).

## 3. Rollback

| What | How | Data effect |
|---|---|---|
| A bad worker image | Set `worker_image_digest` back to the previous digest (ECR keeps ten images), apply: a new task-definition revision; attempts already running finish or are terminated by B08 | none |
| A guard SCP/RCP that blocks a legitimate operation | In the management account (never bound by SCPs): detach the one policy, fix it in a reviewed PR, re-attach. Record the window in the incident log | none; the bucket policies still deny the retention bypass while the SCP is detached |
| A wrong bucket policy | Re-apply the previous commit's data root (only the owner's session can) | none; Object Lock versions stay protected |
| A wrong lifecycle rule | Same; a locked version is never deleted by a lifecycle rule (S3 Object Lock considerations) | at most unlocked noncurrent versions |
| The spend stop attached by Budgets | The owner reviews the spend, then `aws organizations detach-policy --policy-id <kauro-spend-stop> --target-id <Workloads OU>` | none |
| A bad provider version | Revert the commit that changed `versions.tf` and both lock files | none |

## 4. Restore (G-RECOVERY, executed in the qualification: ACTIVATION gate 8)

- **Database**: `aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier kauro-<env> --target-db-instance-identifier kauro-<env>-restore-<date> --restore-time <instant> --db-subnet-group-name kauro-<env> --vpc-security-group-ids <database sg> --no-publicly-accessible`;
  then the recovery runner's steps S1–S8 against the copy (`apps/control/src/recovery/restore-runner.ts`), the authority journal
  replay from the journal bucket, and the comparison; the copy is deleted after the drill (its final snapshot kept per B16).
- **An object version**: `aws s3api list-object-versions` then `copy-object` of the wanted version over the key (a new version);
  never by deleting the newer version (only the deletion identity may).
- **The state of a root**: the state bucket is versioned; restore the previous version of the state object, then `tofu plan` must
  show the drift to repair.

## 5. Controlled destruction

Destroying Kauro's AWS presence is an owner decision with its own written authorization; nothing in this repository destroys it.

1. Stop new work: `worker_enabled = false`, `database_enabled` left as is; attach `kauro-spend-stop` to Workloads.
2. Customer data leaves only through B16's return-or-delete (legal checklist A-15) and the deletion function, never by deleting a
   bucket: buckets with Object Lock cannot be emptied of locked versions before their retention ends.
3. Database: final snapshot (automatic: `skip_final_snapshot = false`), then remove `deletion_protection` in a reviewed change.
4. Workload resources: `tofu destroy` of the workload root after removing `prevent_destroy` where needed, in a reviewed change.
5. Accounts: closed by the owner in the console after every retention period has ended; Terraform never closes an account.

## Provider pins

Both lock files of a root are regenerated together when the provider version changes (a reviewed PR of its own):

```sh
# OpenTofu's lock, in the root:
tofu providers lock -platform=linux_amd64 -platform=windows_amd64 -platform=darwin_arm64 -platform=darwin_amd64
# Terraform's lock, in a temporary copy of the root (so OpenTofu's file is untouched):
cp -r . "$TMP/root" && cd "$TMP/root" && rm .terraform.lock.hcl
terraform providers lock -platform=linux_amd64 -platform=windows_amd64
cp .terraform.lock.hcl "$OLDPWD/terraform-registry.lock.hcl"
```

The zh: hashes of the Terraform registry block equal the provider's `SHA256SUMS` on releases.hashicorp.com, whose signature is
checked against the key the Terraform registry publishes for the provider.
