# Cloud verify (all parallel sessions) — 2026-10-07

Every session that runs `pnpm run verify` (or one suite) in a cloud container uses this script, unchanged. It solves the three
recurring failures seen on PR #16, #18 and #19:

1. **initdb refuses root** ("cannot be run as root"): the script runs the whole verify as an unprivileged user `kauro-ci`.
2. **clean-consume / pnpm behind the container proxy**: the script hands the proxy variables and the proxy's CA bundle to Node
   (`NODE_EXTRA_CA_CERTS`) and to pnpm/npm (`npm_config_cafile`, `npm_config_https_proxy`, `npm_config_proxy`). TLS
   verification stays ON (`strict-ssl` is never disabled).
3. **PGBIN**: the script finds PostgreSQL 17 (`/usr/lib/postgresql/17/bin`) or installs it from the PGDG apt repository, and
   exports `PGBIN`.

Copy the block below to `/tmp/cloud-verify.sh` and run, from the repository root:

```
sudo bash /tmp/cloud-verify.sh            # full verify
sudo bash /tmp/cloud-verify.sh test       # or any root package.json script, e.g. "test", "build", "clean-consume"
```

It prints `CLOUD-VERIFY exit <n>` as its last line; report that line and the first failing test title in your PR, never
"exit code 1" alone. Nothing in it writes outside the repository, `/tmp` and the `kauro-ci` home.

```bash
#!/bin/bash
# cloud-verify.sh: pnpm verify in a cloud container as a non-root user, behind the container proxy, with PostgreSQL 17.
set -euo pipefail
SCRIPT="${1:-verify}"
REPO="$(pwd)"
[ -f "$REPO/package.json" ] && grep -q '"verify"' "$REPO/package.json" || { echo "run from the kauro-platform root"; exit 2; }

# 1. CA bundle of the proxy: the first that exists (never disable TLS verification)
CA=""
for f in "${NODE_EXTRA_CA_CERTS:-}" "${SSL_CERT_FILE:-}" "${REQUESTS_CA_BUNDLE:-}" "${CURL_CA_BUNDLE:-}" \
         /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt; do
  if [ -n "$f" ] && [ -s "$f" ]; then CA="$f"; break; fi
done
PROXY="${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}"
echo "proxy: ${PROXY:+set} ca: ${CA:-none}"

# 2. PostgreSQL 17 binaries
PGBIN="${PGBIN:-/usr/lib/postgresql/17/bin}"
if [ ! -x "$PGBIN/initdb" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q >/dev/null
  apt-get install -y -q curl ca-certificates gnupg lsb-release >/dev/null
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -q >/dev/null && apt-get install -y -q postgresql-17 >/dev/null
  PGBIN=/usr/lib/postgresql/17/bin
fi
"$PGBIN/initdb" --version

# 3. unprivileged user that owns a working copy of the tree (initdb refuses root)
id kauro-ci >/dev/null 2>&1 || useradd -m -s /bin/bash kauro-ci
chown -R kauro-ci: "$REPO"
NODE_DIR="$(dirname "$(command -v node)")"

ENVS=(PATH="$NODE_DIR:/home/kauro-ci/.local/bin:/usr/local/bin:/usr/bin:/bin" HOME=/home/kauro-ci PGBIN="$PGBIN" CI=true GITHUB_ACTIONS=true)
if [ -n "$PROXY" ]; then
  ENVS+=(HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" https_proxy="$PROXY" http_proxy="$PROXY"
         NO_PROXY="${NO_PROXY:-${no_proxy:-}},127.0.0.1,localhost" no_proxy="${NO_PROXY:-${no_proxy:-}},127.0.0.1,localhost"
         npm_config_https_proxy="$PROXY" npm_config_proxy="$PROXY")
fi
[ -n "$CA" ] && ENVS+=(NODE_EXTRA_CA_CERTS="$CA" npm_config_cafile="$CA" SSL_CERT_FILE="$CA")

set +e
runuser -u kauro-ci -- env -i "${ENVS[@]}" bash -lc '
  set -e
  cd "'"$REPO"'"
  PM=$(node -p "require(\"./package.json\").packageManager")      # e.g. pnpm@10.16.1: the workspace pins it
  command -v pnpm >/dev/null && [ "pnpm@$(pnpm -v)" = "$PM" ] || npm i -g "$PM" --prefix "$HOME/.local" >/dev/null
  pnpm install --frozen-lockfile
  pnpm run '"$SCRIPT"'
'
rc=$?
echo "CLOUD-VERIFY exit $rc"
exit $rc
```

Notes:
- 127.0.0.1 and localhost are always in `NO_PROXY`: the test PostgreSQL listens there and must never go through the proxy.
- If your container has no `apt-get` or no route to apt.postgresql.org, say so in the PR with the script's output; B runs the
  Linux leg for you (do not hand-edit PGBIN paths into the repository).
- If a step still fails because of the container (not the code), add the exact error under "Open" in your PR; B fixes this
  script, never the sessions.
