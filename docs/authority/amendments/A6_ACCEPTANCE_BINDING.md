# Amendment A6 — an accepted package stays bound to its acceptance commit

Status: owner decision of 2026-10-04. Amends A4 "Package acceptance" (b) and (c); everything else in A4 stands.

1. **Binding.** A package is ACCEPTED at one commit: the commit its full verify and its Codex review covered. Later commits do
   not reopen it. CI regression on every PR and on `main` covers them.
2. **No repeated checks.** After acceptance there is no new manual Windows or Linux verify and no new Codex review of that
   package, unless a later diff touches its files or its registry cases. Only then is the touched part re-verified and reviewed,
   limited to that diff.
3. **A4 (b) becomes:** at package close, the full verify is green on the exact commit in CI (the `verify` workflow runs on
   ubuntu and windows-latest on every PR). The local Windows verify is kept for package close only, not for intermediate
   lanes.
4. **Whole product once.** The exact-commit verify of the whole product on Windows, Linux and CI is done once, on the final
   release candidate (B18).
5. **Order.** PRs merge one at a time onto an up-to-date `main` (branch rule "require branches to be up to date"). Before a
   merge: update the branch with `main`, ci-local green, and the PR's CI green on that result.
