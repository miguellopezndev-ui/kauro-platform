# @kauro/authorization

Authorization decisions of the Kauro platform (manual 08). Implements the ports of `@kauro/application`:

- `createAuthorizer({ clock, assurance })` — the `Authorizer`, two decisions. `authorize` (access, before anything
  tenant-scoped is written): identity ACTIVE by the token's facts and by the stored identity row, verified email + enrolled MFA,
  verified-user commands without membership, live membership of the caller in the selected agency read with a share lock held to
  the end of the unit of work (a non-member gets NOT_FOUND, foreign and nonexistent alike; a concurrent suspension, revocation or
  role change serializes with the command), ACTIVE membership, role satisfaction per `COMMAND_ROLE_MEMBERS`. `assure` (a new
  execution only, never a replay): fresh step-up when the command names a proof. Default deny; every decision carries a safe
  reason and the policy version `B06-1`. The decisions run inside the unit of work so the membership resolved is the one the
  command uses (no cached grant).
- `createAssuranceVerifier(freshnessSeconds = 900)` — `AssuranceVerifier`: a STEP_UP proof of the actor, issued inside the
  freshness window and before its expiry (decision D-ASSUR-1; the value is open question Q1 for the authority).
- `createAdmissionLimiter(limits)` — `AbuseLimiter`: process-local sliding windows per (operation, identity) and per
  (operation, client address hash); the structural limit (one DRAFT agency per creator) is the database's.

Denials are durable security events: the command runtime (`@kauro/application` `runCommand`) records every DENY decision (a
non-member's NOT_FOUND included) and every handler-level NOT_AUTHORIZED / ASSURANCE_REQUIRED in its own transaction after the
command rolled back — in the agency's stream only when that transaction proves the caller's live membership, otherwise in the
caller's own identity stream; an unauthenticated command leaves an anonymous fact (`refuseUnauthenticated`). Review record
`docs/design/B06-review/A-pipeline-authorization.md`.

Tests use the in-memory ports of `@kauro/application` (pure decision logic); the same decisions against real PostgreSQL rows
and policies are the integration mandate (`docs/design/B06-case-map.md`).
