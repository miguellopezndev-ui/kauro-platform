# Amendment A4 — operating model

Status: owner decisions of 2026-09-28 and 2026-09-29. Supersedes A1 (the autonomy amendment) and every rule that required the
autonomous construction service, its qualification Q01-Q13, receipts, owner status page or ledger database. The service was
retired on 2026-09-29; its complete state is archived (construction-service archive of 2026-09-29, sha256
`c8da597f72c2bc213ba5cbc7b8854bd73551f3d1917962af731f492940289a6d`).

## Construction

Claude builds directly in the three repositories (`kauro-platform`, `kauro-migration-core`, `kauro-intelligence-core`) in lanes
of at most five concurrent agents. Acceptance tests are written first. Focused tests run while building. The full verify runs
once at package close. Written records are short: case, test, commit.

## Package acceptance

This replaces the retired service's ledger; the gate evidence rules of manual 21 are unchanged. A package is **ACCEPTED** when:

a. its case map gives every registry case its evidence class and test;
b. the full verify is green on the exact commit on Windows and Linux and in CI;
c. an independent reviewer from a different model provider (Codex) reviews that exact commit against the registry cases and
   answers ACCEPT or ACCEPT_WITH_MINOR, and the re-check covers only its findings;
d. the commit is on `main`.

A case whose expected outcome needs a live provider stays PARTIAL/SIMULATED until EXECUTED_PROVIDER evidence exists; nothing
simulated counts as live.

The 441-case ledger is computed by a tool in `kauro-platform` from the case maps and the review records; it is the only ledger.
Package dependencies of `registry/program.json` still order formal acceptance — a package is not ACCEPTED before its
dependencies — while construction may run ahead of formal acceptance.

## Dates

Unchanged: production target 2026-10-23; exclusive deadline 2026-10-28T05:00:00Z. Full scope, no cuts.

## Owner acts

Every personal procedure — RUT/DIAN, company registration, e-invoicing habilitation, Alegra, PayPal Business, Google Workspace,
Google Cloud project and billing, Resend — falls on 2026-10-08. Before that date, no personal act is requested and dependent
work is BLOCKED_OWNER. A single "ready to connect" sheet is delivered by 2026-10-07.

OA03 is DONE: domain `kaurodata.com` (Cloudflare registrar and DNS). DNS is managed as code with a Cloudflare token limited to
`Zone:DNS:Edit` on that zone, kept only in the secret store. No existing record is changed without a prior report.

## Resources

Claude Max 20x. Codex only for package-close reviews. API budget USD 20/month. No paid spend — inference, cloud, purchases —
without an owner-approved bounded grant.
