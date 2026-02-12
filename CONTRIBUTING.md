# Contributing

## Development

```bash
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
creates a GitHub Release — all automatically. npm Trusted Publishers (OIDC) is
used, so no `NPM_TOKEN` secret is needed.

### Canary releases

Opening a PR against `main` publishes a canary version under the `canary` npm
dist-tag (e.g. `1.2.3-canary.abc1234.20260212091429`).

### Force a specific version

Add `Release-As: x.y.z` in a commit body:

```bash
# Graduate to 1.0.0
git commit -m "feat: stable release" -m "Release-As: 1.0.0"
```
