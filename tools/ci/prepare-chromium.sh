#!/usr/bin/env bash
# Prepares the Chromium the report PDF tests run on (packages/data-plane/test/report-pdf.test.ts) on the Linux runner, and records
# what the host does. The browser's own sandbox is never turned off and no profile or sysctl is changed here: Ubuntu 24.04 restricts
# unprivileged user namespaces through AppArmor (kernel.apparmor_restrict_unprivileged_userns=1) and lets a browser create its
# namespace sandbox only through a profile naming that binary (Ubuntu ships one for /opt/google/chrome/chrome). This script proves the
# sandboxed browser starts as the unprivileged runner user; if it does not, it fails with the evidence and the job stops (the answer is
# then an AppArmor profile for that one binary, never --no-sandbox and never a global sysctl).
# Output: lines to stdout and to $GITHUB_STEP_SUMMARY; exports KAURO_PDF_BROWSER, KAURO_REQUIRE_PDF_ENGINE and KAURO_PDF_EVIDENCE_DIR.
set -euo pipefail

summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
report() { printf '%s\n' "$*" | tee -a "$summary"; }

chrome="$(command -v google-chrome-stable || command -v google-chrome || true)"
if [ -z "$chrome" ]; then echo "::error::no Google Chrome on the runner"; exit 1; fi

report '## Chromium for the PDF tests'
report '```'
report "runner: $(. /etc/os-release; echo "$PRETTY_NAME"), kernel $(uname -r), user $(id -un) (uid $(id -u))"
report "executable: $chrome -> $(readlink -f "$chrome")"
report "version: $("$chrome" --version)"
report "kernel.apparmor_restrict_unprivileged_userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>&1 || true)"
report "unshare -U (plain user, no profile): $(unshare -U true 2>&1 && echo allowed || echo refused)"
report "AppArmor profiles naming chrome: $(sudo aa-status 2>/dev/null | grep -i chrome | tr -s '[:space:]' ' ' || true)"

# the sandbox is on (no --no-sandbox): "No usable sandbox" here means the host refuses the browser's namespace sandbox
probe_out="${RUNNER_TEMP:-/tmp}/chrome-probe.out"
probe_err="${RUNNER_TEMP:-/tmp}/chrome-probe.err"
if timeout 60 "$chrome" --headless=new --disable-gpu --dump-dom about:blank > "$probe_out" 2> "$probe_err"; then
  report "sandboxed headless launch: OK"
else
  report "sandboxed headless launch: REFUSED"
  report "$(head -c 1500 "$probe_err")"
  report '```'
  echo "::error::the sandboxed Chromium cannot start on this runner; the sandbox is not disabled"
  exit 1
fi
report '```'

{
  echo "KAURO_PDF_BROWSER=$chrome"
  echo "KAURO_REQUIRE_PDF_ENGINE=1"
  echo "KAURO_PDF_EVIDENCE_DIR=${GITHUB_WORKSPACE:-$PWD}/pdf-evidence"
} >> "${GITHUB_ENV:-/dev/null}"
