# Package-Relative Runtime Resolution Design

## Goal

Make the published `opencode-graphiti` package initialize correctly no matter
which directory launches OpenCode, by resolving runtime dependencies relative to
the plugin package rather than `process.cwd()`.

The hard requirement is the installed package contract:

```jsonc
{
  "plugin": ["opencode-graphiti"]
}
```

This change should make a package-shaped local regression the primary test flow
for this bug, while keeping any still-documented built-file coverage as
secondary compatibility coverage.

## Why This Change

The current DNT-generated runtime still relies on a `process.cwd()`-derived
`createRequire(...)` anchor in:

- `src/services/connection-manager.ts`

The same bug existed in `src/config.ts` and has already been corrected locally;
the remaining design work is to carry the same package-relative rule through the
rest of the runtime and generated package metadata.

This is incorrect for an installed plugin package because the plugin's runtime
dependencies (`cosmiconfig` and `@modelcontextprotocol/sdk`) belong to the
plugin package, not to the directory from which OpenCode was launched.

As a result, the plugin can fail to initialize when OpenCode is started from a
directory whose package tree does not provide those dependencies, even though
the plugin itself is properly installed.

`src/config.ts` now derives runtime package resolution from `import.meta.url`.
`src/services/connection-manager.ts` still needs the same package-relative
treatment. The key requirement is that the generated ESM package resolves
runtime dependencies correctly from the plugin package.

## Required Behavior

### Installed Package Mode

- When OpenCode loads `opencode-graphiti` by package name, the plugin must
  resolve `cosmiconfig` and `@modelcontextprotocol/sdk` from the plugin package
  itself.
- Launch directory must not affect whether those dependencies resolve.
- The plugin must initialize successfully from directories other than the user's
  home directory, assuming its own package dependencies are present.

### Runtime Resolution Strategy

- Remove the dependency on `process.cwd()` for Node-side runtime dependency
  resolution in generated package code.
- Anchor `createRequire(...)` to the plugin package location derived from the
  current module, not from the caller's working directory.
- Standardize both runtime loaders on the same `createRequire(...)` input shape
  so they do not diverge across files.
- `src/config.ts` should use this package-relative require for `cosmiconfig`.
- `src/services/connection-manager.ts` should use the same package-relative
  anchor to resolve and dynamically import `@modelcontextprotocol/sdk` runtime
  modules.

### Packaging Metadata

- The generated npm package must declare both required runtime dependencies:
  - `cosmiconfig`
  - `@modelcontextprotocol/sdk`
- `@types/node` remains a generated development-only dependency for package
  type-checking.

### Local Development Validation

- Direct `file:///.../dist/esm/mod.js` loading is no longer treated as the
  primary local-dev compatibility target for this issue.
- Local regression coverage should instead simulate a real installed package
  shape by placing `dist/` under an isolated `node_modules/opencode-graphiti`
  path.
- The OpenCode regression should launch from a directory different from the
  isolated home/config root so the test explicitly covers the cwd-sensitive bug.

## Recommended Approach

### Option A: Package-Relative Runtime Resolution

Recommended.

- Compute a stable runtime anchor from `import.meta.url` so the generated code
  can locate the plugin package it lives in.
- Create a `require` instance from a synthetic file path inside that package.
- Use that `require` for CommonJS/Node package resolution.
- Keep MCP SDK loading lazy at runtime so initialization behavior remains close
  to the existing shape.
- Standardize on a `file://` URL-based anchor for `createRequire(...)` in both
  modules so the implementation does not mix bare filesystem paths and URL
  strings.
- Accept DNT's emitted `import.meta` helper wiring if needed, as long as the
  generated ESM package still resolves runtime dependencies relative to the
  plugin package instead of the caller's cwd.

This approach fixes the actual bug at the correct boundary: module resolution
should follow the plugin package, not the caller's cwd.

### Option B: Bundle Runtime Dependencies

Not recommended.

- Remove runtime package resolution by bundling dependency code into the build.

This is a larger and less stable change than necessary. It increases build
complexity without improving the supported package contract.

### Option C: Preserve Raw `file://dist` Loading as First-Class

Not recommended.

- Continue optimizing the runtime specifically for bare built-file loading.

That mode is useful for ad hoc debugging, but it should not drive the package
runtime design when the supported contract is package-name installation.

## Implementation Shape

### `src/config.ts`

- Preserve the local fix that replaced the old `process.cwd()`-based
  `createRequire(...)` anchor.
- Derive a package-relative anchor from the current module location.
- Ensure the resulting Node resolution path works after DNT emission inside
  `dist/esm/...`.
- `import.meta.url` is now part of the implementation in this file.
- Continue using `nodeRequire("cosmiconfig")` for the actual runtime load.

### `src/services/connection-manager.ts`

- Replace the current `process.cwd()`-based `createRequire(...)` anchor.
- Reuse the same package-relative anchoring strategy as `src/config.ts`.
- Standardize the `createRequire(...)` input form with `src/config.ts` instead
  of preserving the current mismatch between bare path and `file://` URL styles.
- Keep lazy runtime resolution of:
  - `@modelcontextprotocol/sdk/client/index.js`
  - `@modelcontextprotocol/sdk/client/streamableHttp.js`
- Continue resolving first, then dynamic-importing the resolved file URL, so the
  runtime stays compatible with the current Node/Bun packaging behavior.

### `dnt.ts`

- Add `@modelcontextprotocol/sdk` to generated package `dependencies`, mirroring
  the version range already declared in `deno.json` unless there is a deliberate
  documented reason to diverge.
- Retain `cosmiconfig` in generated package `dependencies`.
- Retain `@types/node` in `devDependencies`.

### `packaging.test.ts`

- Keep `deno task build` as the packaging prerequisite.
- Assert that generated `dist/package.json` contains:
  - `cosmiconfig`
  - `@modelcontextprotocol/sdk`
- Add a package-name regression that specifically exercises the installed
  package contract under Node from a cwd that does not provide the plugin's
  dependencies:
  - create a temp directory
  - create `temp/node_modules/opencode-graphiti` pointing at `dist/`
  - configure isolated OpenCode home/config to load `opencode-graphiti` by
    package name
  - run OpenCode from a separate arbitrary cwd
  - assert initialization does not fail due to missing plugin dependency
    resolution
- Keep any existing direct `file:///.../dist/esm/mod.js` coverage only as
  compatibility coverage while README continues to document local built-file
  installation.
- Do not fail the regression solely because DNT emitted
  `import-meta-ponyfill-esmodule`; only fail when emitted package behavior is
  wrong.

## Testing Strategy

Follow TDD for the behavior change.

### Red

- Add or adjust packaging coverage so the installed-package simulation fails
  with the current cwd-anchored runtime resolution.
- Add metadata assertions that fail until `@modelcontextprotocol/sdk` is present
  in generated package dependencies.
- Ensure the failing regression runs from a cwd outside the repository tree;
  running from the workspace can mask the bug because the workspace already has
  matching `node_modules` entries.

### Green

- Implement only the package-relative resolution and package metadata changes
  needed to satisfy the new failing test coverage.

### Refactor

- If the package-relative anchor logic is duplicated between modules, extract
  the smallest clear helper only if it keeps the emitted/runtime behavior
  obvious.

## Validation Plan

At minimum, verify:

- `deno test -A packaging.test.ts`
- `deno test -A`
- `deno task check`
- `deno task lint`
- `deno task fmt`

The critical regression evidence is that the packaged plugin loads by package
name from a non-home, non-package cwd without missing `cosmiconfig` or MCP SDK
resolution failures.

The published package entrypoint remains the generated ESM output
(`./esm/mod.js` in `dnt.ts`). This design targets that supported ESM package
path; it does not expand support guarantees for DNT's separate CommonJS/script
output.

The design does not require DNT to preserve native source-level
`import.meta.url` syntax verbatim in emitted ESM. It only requires the emitted
package to resolve runtime dependencies correctly relative to the plugin
package.

## Non-Goals

- Do not make direct `file:///.../dist/esm/mod.js` loading the primary contract
  that drives this fix.
- Do not redesign the plugin's public package surface.
- Do not change the plugin's config semantics beyond the runtime dependency
  resolution boundary.
