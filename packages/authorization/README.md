# @kauro/authorization

Authorization decisions of the Kauro platform (manual 08). Implements the ports of `@kauro/application`:

- `createAuthorizer({ clock, assurance })` — the `Authorizer`: identity ACTIVE + verified email + enrolled MFA, verified-user
  commands without membership, live membership of the caller in the selected agency (a non-member gets NOT_FOUND, foreign and
  nonexistent alike), ACTIVE membership, role satisfaction per `COMMAND_ROLE_MEMBERS`, fresh step-up when the command names a
  proof. Default deny; every decision carries a safe reason and the policy version `B06-1`. The decision runs inside the unit of
  work so the membership it resolves is the one the command uses (no cached grant).
- `createAssuranceVerifier(freshnessSeconds = 900)` — `AssuranceVerifier`: a STEP_UP proof of the actor, issued inside the
  freshness window and before its expiry (decision D-ASSUR-1; the value is open question Q1 for the authority).
- `createAdmissionLimiter(limits)` — `AbuseLimiter`: process-local sliding windows per (operation, identity) and per
  (operation, client address hash); the structural limit (one DRAFT agency per creator) is the database's.

Denials are durable security events: the command runtime (`@kauro/application` `runCommand`) records every
AUTHENTICATION_REQUIRED / NOT_AUTHORIZED / ASSURANCE_REQUIRED outcome in its own transaction after the command rolled back.

Tests use the in-memory ports of `@kauro/application` (pure decision logic); the same decisions against real PostgreSQL rows
and policies are the integration mandate (`docs/design/B06-case-map.md`).
