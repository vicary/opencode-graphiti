# Contributing

## Development

```bash
# Readiness check
deno test -A
deno task build
deno task check
deno task lint
deno fmt --check

# Format
deno fmt

# Lint
deno lint

# Type check
deno check src/index.ts

# Test
deno test -A

# Build
deno task build
```

## Benchmarking

The Redis benchmark helper lives at `scripts/bench-falkordb.ts`. It targets a
Redis/FalkorDB endpoint, defaults to `redis://localhost:6379` when no argument
is provided, and is intended for ad hoc local measurement rather than routine
CI/development.

## Releasing

Releases are fully automated via CI. The version in `deno.json` stays at
`0.0.0-development` — never bump it manually.

### How it works

Pushing to `main` triggers the publish workflow. The version calculator
(`.github/scripts/version.ts`) analyzes conventional commits since the last git
tag to determine the next semver version:

| Commit prefix                 | Bump (0.x) | Bump (1.x+) |
| ----------------------------- | ---------- | ----------- |
| `feat:`                       | patch      | minor       |
| `fix:` / `perf:`              | patch      | patch       |
| `BREAKING CHANGE` or `type!:` | minor      | major       |

CI creates a git tag (`v*`), publishes to npm under the `latest` dist-tag, and
creates a GitHub Release — all automatically. If a rerun finds that the npm
version already exists, it skips only the publish step and still backfills any
missing tag or GitHub Release metadata for that version. npm Trusted Publishers
(OIDC) is used, so no `NPM_TOKEN` secret is needed.

### Canary releases

Opening a PR against `main` runs the same publish workflow but publishes only a
canary version under the `canary` npm dist-tag (e.g.
`1.2.3-canary.abc1234.20260212091429`). PR runs do not create git tags or GitHub
Releases.

### Force a specific version

Add `Release-As: x.y.z` in a commit body:

```bash
# Graduate to 1.0.0
git commit -m "feat: stable release" -m "Release-As: 1.0.0"
```
