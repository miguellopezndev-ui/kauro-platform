# Amendment A9 — AWS is Kauro's primary cloud; Google Cloud leaves the critical path

Status: owner decision of 2026-10-05 (chat instruction). Supersedes every R2 manual, amendment, plan or document that names
Google Cloud (GCP, Vertex AI / Model Garden, Cloud Run, Cloud Tasks, Cloud SQL, GCS, Secret Manager, Identity Platform) as the
production provider. Everything provider-independent in R2, A2–A8 stands. Not yet hashed in PROVENANCE.md: added with the A7
re-issue.

## 1. Decision and evidence
- Google Cloud Support closed case OR-CBAT-14 on 2026-10-05: it cannot activate the account and will not say why. That is
  sufficient evidence to remove GCP from the critical path.
- **AWS is the primary cloud. Azure is contingency only**, used solely if AWS shows a demonstrated material blocker.
- No new GCP attempts, no alternative Google accounts, no changing e-mails or cards to get around the refusal, no waiting for
  a reopening. Any existing GCP account/project stays dormant as audit evidence; historical evidence and configuration that is
  still useful for audit is kept, not deleted.
- Unchanged: Google Workspace (miguel@kaurodata.com, Gmail), Cloudflare, Resend and every other external service.

## 2. Preserve, do not rebuild
Cores (MC, IC), domain, contracts, tests and provider-independent evidence are preserved. The migration is limited to
infrastructure (B14), adapters (B15 and the platform ports' cloud implementations), configuration and the tests those touch.
No case, threshold, evidence class or live requirement changes; isolation, recovery, RLS, fencing, idempotency, retention,
deletion and security are not lowered to save money.

## 3. Target architecture to qualify (starting point: the historical AWS "Uso bajo" research, re-checked against current code and current official AWS sources)
| Concern | Candidate | Note |
|---|---|---|
| Light API surfaces | Lambda + API Gateway + WAF | where the contracts allow (request limits, timeouts, streaming) |
| Heavy migration / preflight | AWS Batch on Fargate | the Batch worker host in `packages/data-plane` is the builder's |
| Persistence | Aurora PostgreSQL Serverless v2 + Data API (initial low-use candidate) | **fallback RDS PostgreSQL 17** if Aurora/Data API cannot preserve the contracts (transactions, advisory/row locks, RLS session settings, fencing, server_now semantics, migrations) |
| Objects | S3 | retention/deletion contracts as today |
| Queues | SQS | replaces Cloud Tasks |
| Secrets | Secrets Manager | |
| Images | ECR | |
| Identity | Cognito where it maps to Identity Platform | |
| Build/deploy | IAM + GitHub OIDC | no static keys |
| Observability | CloudWatch | |
| Models (IC / B04) | Amazon Bedrock (Claude Sonnet 5.5 / Opus 5.5) | replaces Vertex Model Garden |
Excluded: EKS/Kubernetes; NAT gateways, interface endpoints, permanent HA and other fixed-cost resources unless a security or
operations contract truly requires them (each exception justified in writing).

## 4. B04 on Bedrock
Model Garden stops being a dependency. Grants stand: **B04-A ≤ USD 40; B04-B ≤ USD 120, Sonnet, 4 runs; Opus needs a new
approval.** Before any paid call: verify region, effective routing (in-region vs cross-region inference profile), data
residency, endpoints, retention (no storage of inputs/outputs; invocation logging off), service quotas and current prices;
recompute the expected spend; never exceed the grants.

## 5. Account
The owner will not open a personal AWS account. When Kauro Data S.A.S. has its registration, NIT and RUT, the owner opens AWS
under the company with the professional e-mail and completes identity, billing, MFA/KYC and authorizations. Until then the
builder completes everything that needs no real access: the GCP→AWS delta, IaC (Terraform), adapters, configuration,
synthetic tests, IAM plan, budgets, deployment topology, qualification plan, rollback/cleanup, documentation.

## 6. Cost
The historical figures (USD 66.02/month with no customers for "Uso bajo"; USD 94.89 illustrative pilot; ~USD 133.89 if Aurora
did not pause) are references, not an accepted budget. The builder recomputes the cost sheet from current prices and the
current code and optimises total cost without giving up any contract.

## 7. Schedule
19-Oct-2026 stays the aggressive internal target; everything that does not need the AWS account runs in parallel. Production
(B19), live B14/B15 clauses and paid B04 runs are gated by the AWS account (section 5); the builder reports the new critical
path and any material change of date, cost or gate. No new owner decision is requested unless a real material incompatibility
appears.
