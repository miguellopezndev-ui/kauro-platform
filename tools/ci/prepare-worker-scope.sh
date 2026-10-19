#!/usr/bin/env bash
# Prepares the boundary the local worker host runs each attempt in on the Linux runner (packages/data-plane/src/host/attempt-scope.ts):
# a PID namespace, made by util-linux `unshare --user --map-current-user --pid --fork --kill-child` as the unprivileged runner user.
# Ubuntu 23.10 and later restrict unprivileged user namespaces through AppArmor (kernel.apparmor_restrict_unprivileged_userns=1): a
# process may create one with capabilities only under a profile naming its binary, as Ubuntu's own profile for Chrome does. As for the
# browser (tools/ci/prepare-chromium.sh), the global sysctl is never changed: if the probe is refused, one profile is loaded for
# /usr/bin/unshare alone (unconfined, plus `userns`), and the probe must then pass, or the job stops with the evidence.
# Output: lines to stdout and to $GITHUB_STEP_SUMMARY.
set -euo pipefail

summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
report() { printf '%s\n' "$*" | tee -a "$summary"; }
probe() { setpriv --pdeathsig KILL -- unshare --user --map-current-user --pid --fork --kill-child=SIGKILL -- sh -c 'test "$$" = 1' 2>&1; }

report '## The local worker host: the attempt boundary (PID namespace)'
report '```'
report "util-linux: $(unshare --version)"
report "kernel.apparmor_restrict_unprivileged_userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>&1 || true)"
if out="$(probe)"; then
  report "PID namespace as $(id -un): OK (no profile needed)"
else
  report "PID namespace as $(id -un): REFUSED ($out); loading a profile for /usr/bin/unshare alone"
  sudo tee /etc/apparmor.d/kauro-unshare > /dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile kauro-unshare /usr/bin/unshare flags=(unconfined) {
  userns,
}
PROFILE
  sudo apparmor_parser -r /etc/apparmor.d/kauro-unshare
  if out="$(probe)"; then
    report "PID namespace as $(id -un), with the unshare profile: OK"
  else
    report "PID namespace as $(id -un), with the unshare profile: REFUSED ($out)"
    report '```'
    echo "::error::the local worker host's attempt boundary cannot be made on this runner"
    exit 1
  fi
fi
report '```'
