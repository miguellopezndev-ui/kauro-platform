# The migration worker's container (B14-A; docs/design/B14-A-worker-executor.md §9, deploy/aws/worker/README.md).
# CONTRACT, NOT YET BUILT: no image has been built or pushed (no AWS account, no Docker on the build machine). Its first build is a
# step of the next phase, before any push to ECR.
#
# Reproducible inputs: the base image by digest (node 24.20.0 on Debian bookworm, linux/amd64, pushed 2026-08-27), Debian packages from a
# fixed snapshot of the archive, the workspace from its lockfile (pnpm install --frozen-lockfile), the cores from vendor/ by hash.
FROM node:24.20.0-bookworm-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.16.1 --activate
COPY . .
RUN pnpm install --frozen-lockfile && node tools/vendor-cores.mjs check && pnpm run build \
 && pnpm deploy --filter @kauro/migration-worker --prod /app

FROM node:24.20.0-bookworm-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa
# Chromium from the Debian archive as it stood on 2026-10-01 (snapshot.debian.org): one fixed version, its sandbox helper included.
# The report engine never turns the sandbox off; if Fargate refuses it, printing fails closed (qualification §6 item 2).
RUN printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261001T000000Z bookworm main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261001T000000Z bookworm-security main\n' > /etc/apt/sources.list \
 && rm -f /etc/apt/sources.list.d/* \
 && apt-get update && apt-get install -y --no-install-recommends chromium fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
# the same two preloads as the local host gives every worker: the network entry points refused, the process allowlist
# a non-root worker; the attempt's scratch is the task's ephemeral volume mounted at /scratch, the root filesystem read-only
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin kauro && mkdir -p /scratch && chown kauro:kauro /scratch
USER 10001:10001
ENV NODE_ENV=production
WORKDIR /app
ENTRYPOINT ["node", "--permission", "--allow-fs-read=/app", "--allow-fs-read=/usr/lib/chromium", "--allow-fs-read=/usr/bin/chromium", "--allow-fs-read=/proc/version", "--allow-fs-read=/proc/sys/fs/binfmt_misc/WSLInterop", "--allow-fs-read=/run/WSL", "--allow-fs-read=/run/.containerenv", "--allow-fs-read=/.dockerenv", "--allow-fs-read=/proc/self/cgroup", "--allow-fs-read=/scratch", "--allow-fs-write=/scratch", "--allow-child-process", "--max-old-space-size=1024", "--import", "./node_modules/@kauro/data-plane/dist/src/sandbox/preload.js", "--import", "./node_modules/@kauro/data-plane/dist/src/host/worker-preload.js", "dist/src/main.js"]
