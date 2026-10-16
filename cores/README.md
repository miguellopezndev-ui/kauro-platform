# Cores: editable sources and archive

The two cores Kauro consumes are maintained here. Their former repositories (`miguellopezndev-ui/kauro-migration-core`,
`miguellopezndev-ui/kauro-intelligence-core`) are no longer needed: this directory holds the sources of the pinned versions,
the complete git history of both repositories and every release asset they published.

The platform does not build from these sources. It consumes the pinned tarballs under `vendor/` (`vendor/MANIFEST.json`,
`pnpm-workspace.yaml` overrides, `tools/vendor-cores.mjs check`), through the wrappers `packages/migration-core` and
`packages/intelligence-core`. `cores/` is outside the pnpm workspace (`packages/*`, `apps/*`) and no gate walks it.

| directory | core | version | source commit | status |
|---|---|---|---|---|
| `kauro-migration-core/` | Migration Core | 3.0.0 | `3b4b0aea4f1879ffb4189a55a16f22f4520787d4` (tag `v3.0.0`, `main`) | RELEASED |
| `kauro-intelligence-core/` | Intelligence Core | 0.6.0 | `4fee8d1bd5045552326f022837525b247f0e1a21` (branch `b04/preflight-fixes`) | PROVISIONAL_UNRELEASED |

Each directory is the exact tree of its commit (`git archive`), byte-exact (`cores/** -text -eol` in `.gitattributes`). Each
rebuilds to the vendored tarball byte for byte (verified 2026-10-15, Node 24.20.0, npm 11.19.0):

```
cd cores/kauro-migration-core && npm ci && npm run build && node tools/pack.mjs --out <dir>
#   sha256 2686ee65228ed9c0acc72ebbccfba7599398a7b127dc468eabd2b05fcb5a5312 == vendor/kauro-migration-core-3.0.0.tgz
cd cores/kauro-intelligence-core && npm ci && npm run build && npm pack --pack-destination <dir>
#   sha256 4270f797e19e2b451cf1ad1ad53523fafa97ad34ccb8ac15351f3aa6e26215bc == vendor/kauro-intelligence-core-0.6.0.tgz
```

Both are standalone npm projects with their own `package-lock.json`; `npm ci` needs only the public npm registry. Intelligence
Core resolves Migration Core from its own `vendor/kauro-migration-core-3.0.0.tgz`, the same bytes as `vendor/` here. Build in a
copy or rely on each core's own `.gitignore` (`node_modules/`, `dist/`, `*.tgz`).

Intelligence Core 0.6.0 stays provisional: it was never released, `vendor/MANIFEST.json` keeps it `PROVISIONAL_UNRELEASED`, and
`node tools/vendor-cores.mjs check --release` refuses it.

## Changing a core

1. Edit the source here and run the core's own gate (`npm run gate`; see its README).
2. Build its tarball as above and copy it to `vendor/` (a new version gets a new file name).
3. Update the core's entry in `vendor/MANIFEST.json` (`bytes`, `sha256`, `source`; a release also replaces its SHA256SUMS
   file), the exact version in the wrapper's `package.json` and the `pnpm-workspace.yaml` override when the name changes, then
   `pnpm install` so `pnpm-lock.yaml` carries the new integrity.
4. A new Migration Core tarball also replaces `cores/kauro-intelligence-core/vendor/` and that core's lock entry.
5. `node tools/vendor-cores.mjs check --installed` (after `pnpm run build`) proves the pin and the wrapper exports.

## Archive (`archive/`)

| file | content |
|---|---|
| `kauro-migration-core.bundle` | `git clone --mirror` of the repository: 31 branches, 6 tags, 16 pull-request heads, `HEAD` -> `main` |
| `kauro-intelligence-core.bundle` | the same: 70 branches, 1 tag, 23 pull-request heads, `HEAD` -> `main` |
| `<repo>.refs` | every ref of the bundle and its commit, as captured on 2026-10-15 |
| `releases/<repo>/releases.json` | every GitHub release (tag, target, dates, notes, assets with their digests) |
| `releases/<repo>/<tag>/` | every release asset, verbatim (`sha256sum -c SHA256SUMS` inside each tag directory) |
| `SHA256SUMS` | sha256 of every file above (`cd cores/archive && sha256sum -c SHA256SUMS`) |

Releases with assets: Migration Core `v3.0.0` and `v2.0.1`, Intelligence Core `v0.4.0`; Migration Core `v1.0.0`–`v1.0.2` had none.

Restore a repository, with all its history and branches: `git clone cores/archive/<repo>.bundle <dir>` (all branches:
`git clone --mirror`). The bundles hold every commit the platform cites, including Intelligence Core `main`
(`09ce4f9e4711b878ecdfe75325314761121624f1`, later than the 0.6.0 pin and not consumed by Kauro) and the case-map commits
`docs/acceptance/ledger/inputs.json` pins (`tools/ledger.mjs --mc|--ic <checkout>/<path>@<sha>` reads a checkout of them).
