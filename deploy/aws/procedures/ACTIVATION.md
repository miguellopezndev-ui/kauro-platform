# Activation gates (Order 25 §9)

No account root of `deploy/aws/terraform` (`accounts/management`, `accounts/data`, `accounts/workload`, the only entry points:
the modules carry no provider configuration and are never applied on their own) can be planned until the owner records an
activation reference for that account
(`KAURO-ACT-YYYY-MM-DD-<MANAGEMENT|DATA|WORKLOAD>-<n>`, with gates 1–2 confirmed for the management account, which then builds gates 3–4, and gates 1–4 for the data and workload accounts): each root's `activation_authorization` variable refuses
any other value, so `plan` and `apply` stop before any AWS call that creates something. This page lists the gates in order. **None
of them is to be executed now**: they wait for the company's unblocking (A9 §5).

Every action that opens or configures an account is the owner's, from Kauro's **professional mailbox**. No builder, agent or
workflow asks for or receives a password, card number, MFA code, recovery code or access key. The owner never pastes one into a
chat, an issue, a pull request or a file of this repository.

| # | Gate | Who | Done when (evidence the owner keeps, outside this public repository) | Unblocks |
|---|---|---|---|---|
| 1 | **Legal identity and ownership of the company verified**: Kauro Data S.A.S. registered, NIT and RUT issued (D-14). | owner | Registration documents filed in the private company records. | Opening AWS in the company's name |
| 2 | **Company AWS account authorized and protected**: the management account is opened with the company's details and `aws-mgmt@kaurodata.com` (D-28); root user with a hardware or app MFA; no root access key; billing and tax data of the company; IAM Identity Center enabled in us-east-1 with MFA **"every time they sign in"** and the owner's user enrolled. | owner | Root MFA shown active and "no access keys" in the security credentials page; Identity Center MFA settings screenshot; the owner's user id. | Applying the management root |
| 3 | **AWS Organizations with the three accounts**: all features enabled; SCP and RCP policy types enabled; member accounts `aws-data@` and `aws-load@kaurodata.com` created by the management root (or adopted with `import`, PROVISIONING.md); no workload in the management account. | owner (Terraform in the owner's session) | `aws organizations list-accounts` shows exactly three accounts; the OUs Data and Workloads; the guard policies attached as in AUTHORITY-MATRIX.md. | Applying the workload and data roots |
| 4 | **Separation of permissions and spend limits**: the guard SCPs/RCP attached; the owner's permission sets assigned; the monthly ceiling stated by the owner (`monthly_ceiling_usd`, BLOCKED_OWNER today) with the spend stop wired; Cost Anomaly Detection subscribed; budget e-mails confirmed. | owner | The budget and its action visible in AWS Budgets; the alert e-mail subscription confirmed; the first anomaly report received. | Any resource that costs money |
| 5 | **Controlled qualification of the resources** (QUALIFICATION.md part A–C): the guards proved live with deliberately denied requests; the worker host's probes with synthetic data only. | owner authorizes; builder runs scripts in the owner's session | QUALIFICATION.md results file with every row PASS, dated, and the CloudTrail event ids of each denied probe. | `worker_enabled = true` for the qualification window |
| 6 | **Encryption, retention and authorizations verified**: SSE-S3 on every object; Object Lock GOVERNANCE behaves (a version can't be deleted without the bypass; the deletion identity can); noncurrent-version expiry lag measured (legal checklist A-20) and recorded; the deletion function published only through DELETION-FUNCTION.md. | owner + builder | A-20 measurement with date; QUALIFICATION.md part D rows PASS. | Publishing the deletion texts (ToS §13.4, DPA §13.2) |
| 7 | **Real tests of the worker and the storage**: the B14-A §6 probes (clientToken hour, Chromium sandbox on Fargate, IAM role life cycle, bucket policy enforcement, pull time and scratch, task retirement) and B15's S3 adapter against the real bucket. | builder in the owner's session | QUALIFICATION.md part B/C rows PASS; B14-A host status changed from `SELECTED_NOT_QUALIFIED` only by its own review. | Any real (customer) attempt |
| 8 | **Restore and continuity tests**: RDS point-in-time restore into an isolated instance, S3 version restore, authority-journal replay, recovery runner S1–S8 against the restored copy (R2-074, R2-076; G-RECOVERY). | builder in the owner's session | Restore drill record with times measured (RPO/RTO become MEASURED). | Production |
| 9 | **Express authorization before deploying production**: the owner's written go for `environment = "production"`, after G-CLOUD, G-RECOVERY and the legal activation checks (A-06, A-09, A-10, A-20). | owner | The owner's dated authorization; a new activation reference for production. | Production (B19) |

## How a reference is used

```hcl
# terraform.tfvars (kept by the owner, never committed: deploy/aws/.gitignore excludes *.tfvars)
activation_authorization = {
  reference       = "KAURO-ACT-2026-11-02-WORKLOAD-1"
  gates_confirmed = [1, 2, 3, 4]
}
```

A reference names one account and its date; a new phase (qualification, production) gets a new reference. The reference is a
guard against accidents, not against the owner: the owner can always act directly in the console.

## Owner activation inputs (no default; the roots refuse to plan without them)

| Input | Root | Gate | What it decides |
|---|---|---|---|
| `owner_principal_id` | management | 2 | the owner's Identity Center user, assigned to the owner's permission sets in every account at the first apply |
| `monthly_ceiling_usd` | management | 4 | the monthly cloud ceiling (at most the USD 220 funding row) |
| `spend_stop_approval` | management | 4 | whether Budgets applies the spend stop automatically or asks the owner first |
| `database_backup` | workload | before `database_enabled = true` | the database's automated-backup retention (PITR window) and daily backup window |

The control plane's role trusts ECS tasks by default (`control_plane_trusted_service`): that is a PROPOSED placeholder, not the
runtime decision (R-A1); nothing assumes the role until that decision is taken and built.
