# Kauro on AWS — infrastructure as code (Order 25)

**Status: built and tested offline; nothing created, applied or billed.** There is no AWS account (A9 §5). Every file here was
written, validated and tested without credentials. Activation needs the owner's authorization, the company's AWS organization and
the live qualification ([procedures/ACTIVATION.md](procedures/ACTIVATION.md)). The design and its decisions are in
[docs/design/B14-B-aws-infrastructure.md](../../docs/design/B14-B-aws-infrastructure.md).

## Layout

| Path | What it is |
|---|---|
| `policies/organization/` | The guard SCPs and the RCP (D-21 A): member baseline, data retention guard, data identity guard, workload guard, spend stop, data perimeter |
| `policies/data/` | The data account's bucket policies (customer data, authority journal, audit), the deletion identity's policy, the owner's deletion-publisher policy |
| `policies/workload/` | The GitHub image publisher's policy, the control plane's boundary and storage policy |
| `worker/` | The B14-A worker contracts (Order 9), unchanged in substance: Terraform renders them, it does not restate them |
| `terraform/accounts/{management,data,workload}/` | One root per account; each refuses any other account and any plan without the owner's activation reference |
| `terraform/modules/` | organization, identity-center, cost-guardrails, protected-bucket, audit-trail, deletion-function, network, worker, deploy-identity, database (PROPOSED), state-backend, policy-template |
| `checks/` | The offline IAM/SCP/RCP evaluator, the authority matrix, the static guards |
| `cost/` | Prices from AWS's Price List API, the labelled assumptions, the generated estimate |
| `procedures/` | Activation gates, provisioning and rollback, the deletion function's publication, the live qualification |
| [AUTHORITY-MATRIX.md](AUTHORITY-MATRIX.md) | Generated: who can do what to the protected data and to the guards (VERIFIED_STATIC) |
| [cost/COST-ESTIMATE.md](cost/COST-ESTIMATE.md) | Generated: monthly cost by scenario, every quantity labelled |

## Where each thing lives

| Account | Holds | Who applies it |
|---|---|---|
| management | the organization, OUs, the two member accounts, SCPs, the RCP, Identity Center permission sets, budgets and anomaly detection, its state bucket | the owner's session only |
| data | the customer-data and journal buckets (Object Lock GOVERNANCE), the organization trail and audit bucket, the guard alarms, the deletion identity's role, signing profile and code-signing configuration, its state bucket | the owner's session only (no automated identity exists here) |
| workload | the private VPC and endpoints, the worker's cluster, repository, roles and task definition, the control plane's role, the GitHub image publisher, the PROPOSED database, its state bucket | the owner's session (the GitHub identity only pushes images) |

## Running the checks (no AWS, no credentials)

```sh
node --test tools/test/aws-infrastructure.test.mjs        # evaluator, authority matrix, static guards, cost (also in pnpm verify)
node deploy/aws/checks/static-guards.mjs                  # the static guards, readable
node deploy/aws/checks/authority-matrix.mjs --write       # regenerate AUTHORITY-MATRIX.md
node deploy/aws/cost/estimate.mjs --write                 # regenerate cost/COST-ESTIMATE.md
node deploy/aws/cost/refresh-prices.mjs                   # re-read AWS's price list (network, no account)

cd deploy/aws/terraform/accounts/workload                 # same for management, data and the tested modules
tofu init -backend=false -lockfile=readonly && tofu validate && tofu test
```

`.github/workflows/aws-iac.yml` runs the same with OpenTofu and with Terraform, plus `fmt -check` and Checkov, on every change under
`deploy/aws/`. It holds no AWS credential and runs no `plan` against a backend, no `apply`, no `destroy`.

## Evidence classes used here

| Class | Meaning here |
|---|---|
| `VERIFIED_STATIC` | Proved over the files: the rendered policies through the offline evaluator, the static guards, the cost arithmetic |
| `TESTED_LOCAL` | Proved by `tofu test` / `terraform test` plans with a mocked provider: what the configuration asks AWS for |
| `PENDING_PROVIDER` | Needs the real account: AWS's own evaluation, eventual consistency, service behaviour, real prices on the bill |
| `BLOCKED_OWNER` | Needs an owner decision or act (account opening, budget ceiling, backup window, identity user) |
| `NOT_IMPLEMENTED` | Not built, because its contract is not determined yet (each with its owner in the design document) |

A simulation of IAM or a mocked Terraform plan does not prove the effective permissions of a real AWS account.
