# Package-Relative Runtime Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed `opencode-graphiti` package resolve `cosmiconfig`
and `@modelcontextprotocol/sdk` from the plugin package instead of
`process.cwd()`, and prove it works when OpenCode launches from an unrelated
directory.

**Architecture:** Introduce a package-relative `createRequire(...)` anchor
derived from `import.meta.url` in the two runtime loaders, keep MCP SDK loading
lazy, and update generated npm package metadata so the published package
declares all runtime dependencies it resolves at runtime. Validate the fix with
a Node package-name regression that runs from a bare temp cwd rather than the
repository tree.

**Tech Stack:** Deno, TypeScript, DNT, Node ESM interop, `cosmiconfig`,
`@modelcontextprotocol/sdk`, OpenCode packaging regression tests.

**Done when:** `deno test -A packaging.test.ts` passes with the Node
package-name regression running from a bare cwd, and `deno test -A`,
`deno task check`, `deno task lint`, and `deno task fmt` all pass.

---

### File Map

**Modify:**

- `packaging.test.ts` Responsibility: package build regression coverage and
  runtime dependency assertions
- `src/config.ts` Responsibility: runtime config discovery loading through
  package-relative `require`
- `src/services/connection-manager.ts` Responsibility: lazy MCP SDK runtime
  loading through package-relative resolution
- `dnt.ts` Responsibility: generated `dist/package.json` dependency metadata

**Create:**

- None required unless the implementation needs a very small shared runtime
  helper for the package-relative `createRequire(...)` anchor

**Spec Reference:**

- `docs/superpowers/specs/2026-04-07-package-relative-runtime-resolution-design.md`

### Task 1: Add the Failing Packaging Regression First

**Files:**

- Modify: `packaging.test.ts`

- [ ] **Step 1: Add the failing Node package-name import regression**

In `packaging.test.ts`, add a new Node runner that imports the package by name:

```js
import * as plugin from "opencode-graphiti";
console.log(JSON.stringify(Object.keys(plugin).sort()));
```

Use a temp `node_modules/opencode-graphiti -> dist` symlink and run Node from a
separate bare temp cwd that is not the repository root.

The existing Bun runner already imports by package name. Keep it as secondary
coverage, but add a Node package-name runner because the current Node runner
only imports the built entrypoint by absolute `file://` URL and does not
exercise the cwd-sensitive bug.

Expected initial failure mode before the fix:

- package import fails because runtime dependency resolution still follows
  `process.cwd()` instead of the plugin package

- [ ] **Step 2: Add the failing OpenCode package-name regression path**

If `OPENCODE_BIN` is available, update the OpenCode regression setup so it loads
`opencode-graphiti` by package name from isolated config and launches with a cwd
outside the repository tree.

Example config payload to write into isolated config:

```jsonc
{
  "plugin": ["opencode-graphiti"]
}
```

Keep the cwd pointed at a separate temp directory without matching dependency
entries.

- [ ] **Step 3: Keep any DNT output inspection diagnostic-only**

If you inspect emitted `dist/esm/...` files for debugging, do not fail the test
suite solely because DNT emitted `import-meta-ponyfill-esmodule`.

The required contract is emitted package behavior:

- Node package-name loading from a bare cwd reproduces the current bug
- the later fix makes package-relative runtime resolution work correctly

- [ ] **Step 4: Run the targeted packaging test and verify it fails for the
      right reason**

Run: `deno test -A packaging.test.ts`

Expected:

- FAIL
- failure proves the package-name runtime regression is real under the installed
  package simulation

- [ ] **Step 5: Commit the red test change**

```bash
git add packaging.test.ts
git commit -m "test: cover package-relative runtime resolution"
```

### Task 2: Fix Config Runtime Resolution

Status: local implementation started; continue from the current `src/config.ts`
state instead of redoing the old `process.cwd()` anchor change.

**Files:**

- Modify: `src/config.ts`

- [ ] **Step 1: Introduce a package-relative `createRequire(...)` anchor**

The old code was:

```ts
const nodeRequire = createRequire(
  join(process.cwd(), "graphiti.config.runtime.cjs"),
);
```

Continue using a module-relative anchor derived from `import.meta.url`,
targeting the plugin package location rather than the caller cwd.

Use the same URL-based `createRequire(...)` input form intended for
`connection-manager.ts`.

- [ ] **Step 2: Keep the implementation minimal**

Do not change config semantics. Only change how `cosmiconfig` is resolved at
runtime.

- [ ] **Step 3: Run the targeted packaging test to confirm the config side is no
      longer the blocker**

Run: `deno test -A packaging.test.ts`

Expected:

- still FAIL or partially progress because the MCP SDK path is still broken
- config-only runtime loading no longer fails through `process.cwd()`

Add the smallest targeted check needed to make that intermediate state explicit,
for example a Node snippet that exercises only the config loader path rather
than the full plugin bootstrap.

Do not require the emitted `config.js` to avoid DNT's `import-meta` helper; only
require the config loader to behave correctly from the installed package shape.

- [ ] **Step 4: Commit the config fix**

```bash
git add src/config.ts packaging.test.ts
git commit -m "fix: resolve config runtime deps from package"
```

### Task 3: Fix MCP SDK Runtime Resolution

**Files:**

- Modify: `src/services/connection-manager.ts`

- [ ] **Step 1: Replace the cwd-anchored runtime require**

Replace the current:

```ts
const nodeRequire = createRequire(
  pathToFileURL(join(process.cwd(), "graphiti.runtime.cjs")).href,
);
```

with the same package-relative anchor strategy used in `src/config.ts`.

- [ ] **Step 2: Preserve lazy runtime loading behavior**

Keep the current shape:

```ts
const resolvedPath = nodeRequire.resolve(specifier);
return await import(pathToFileURL(resolvedPath).href) as T;
```

Do not refactor the MCP connection manager beyond what is needed for package
relative resolution.

- [ ] **Step 3: Keep JSON manifest behavior unchanged unless it blocks the
      test**

The `deno.json` import for `manifest.name` and `manifest.version` is not part of
this change. Only touch it if the packaging regression proves it is necessary.

- [ ] **Step 4: Run the targeted packaging test and verify the runtime
      regression turns green**

Run: `deno test -A packaging.test.ts`

Expected:

- PASS for the runtime regression coverage added in Task 1
- Node package-name import succeeds from the bare temp cwd
- optional OpenCode regression succeeds when `OPENCODE_BIN` is present

- [ ] **Step 5: Commit the MCP SDK resolution fix**

```bash
git add src/services/connection-manager.ts packaging.test.ts
git commit -m "fix: resolve MCP runtime deps from package"
```

### Task 4: Update Generated Package Metadata

**Files:**

- Modify: `dnt.ts`

- [ ] **Step 1: Write the failing dependency metadata assertion**

Add an assertion that generated `dist/package.json` contains:

```ts
assertEquals(
  builtPackage.dependencies?.["@modelcontextprotocol/sdk"],
  expectedSdkVersionFromDenoJson,
  "generated npm package must declare the MCP SDK for runtime loading",
);
```

Run: `deno test -A packaging.test.ts`

Expected before the metadata change is applied:

- FAIL on the missing generated dependency assertion

- [ ] **Step 2: Add generated runtime dependency metadata for the MCP SDK**

Update `dnt.ts` package dependencies to include:

```ts
dependencies: {
  "@modelcontextprotocol/sdk": sdkVersionFromDenoJson,
  cosmiconfig: "^9.0.0",
},
```

Mirror the version range already declared in `deno.json`.

- [ ] **Step 3: Keep existing generated metadata intact**

Do not change:

- package name/version/entrypoint metadata
- `@types/node` in `devDependencies`
- hook registration metadata

- [ ] **Step 4: Run the targeted packaging test and verify metadata assertions
      pass**

Run: `deno test -A packaging.test.ts`

Expected:

- PASS
- built `dist/package.json` contains both runtime dependencies

- [ ] **Step 5: Commit the generated package metadata change**

```bash
git add dnt.ts packaging.test.ts
git commit -m "fix: declare MCP SDK in generated package"
```

### Task 5: Refactor Only If the Anchor Logic Is Clearly Duplicated

**Files:**

- Modify: `src/config.ts`
- Modify: `src/services/connection-manager.ts`
- Create: only if a tiny shared helper is clearly justified

- [ ] **Step 1: Compare the final package-relative anchor logic in both files**

If the logic is identical and awkwardly duplicated, extract the smallest helper
that keeps emitted behavior obvious.

- [ ] **Step 2: Do not extract a helper unless it simplifies both files**

Prefer duplication over an unnecessary abstraction if the helper would only save
one or two lines.

- [ ] **Step 3: Re-run the focused regression after any refactor**

Run: `deno test -A packaging.test.ts`

Expected: PASS

- [ ] **Step 4: Commit the refactor only if one was actually needed**

```bash
git add src/config.ts src/services/connection-manager.ts
git commit -m "refactor: share package-relative runtime anchor"
```

If no refactor was needed, skip this commit.

### Task 6: Full Verification

**Files:**

- No new files

- [ ] **Step 1: Run the focused regression one more time**

Run: `deno test -A packaging.test.ts`

Expected: PASS

- [ ] **Step 2: Run the full test suite**

Run: `deno test -A`

Expected: PASS

- [ ] **Step 3: Run type checking**

Run: `deno task check`

Expected: PASS

- [ ] **Step 4: Run linting**

Run: `deno task lint`

Expected: PASS

- [ ] **Step 5: Run formatting**

Run: `deno task fmt`

Expected: PASS or only intentional formatting updates

- [ ] **Step 6: If formatting changed files, re-run the focused regression**

Run: `deno test -A packaging.test.ts`

Expected: PASS

- [ ] **Step 7: Commit final verification-safe cleanup**

```bash
git add packaging.test.ts src/config.ts src/services/connection-manager.ts dnt.ts
git commit -m "fix: anchor plugin runtime deps to package"
```

Skip this commit if the earlier per-task commits already cleanly capture the
final state and no additional changes were made.

### Task 7: Completion Notes

**Files:**

- Modify only if needed: `README.md`

- [ ] **Step 1: Check whether docs need a narrow clarification**

Only update `README.md` if the local development testing guidance now needs a
small clarification that package-name install simulation is the preferred local
regression path for this bug class.

- [ ] **Step 2: Keep documentation scope narrow**

Do not rewrite installation docs unless the implementation changed the
documented contract.

- [ ] **Step 3: Run affected verification again if docs stayed untouched**

No command required if code did not change.

- [ ] **Step 4: Commit doc clarification only if you actually changed docs**

```bash
git add README.md
git commit -m "docs: clarify local package regression workflow"
```

Skip this commit if no doc change was necessary.
