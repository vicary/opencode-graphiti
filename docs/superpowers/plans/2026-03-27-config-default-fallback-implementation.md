# Config Default Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make config loading fail open with localhost defaults, OpenCode
warning notifications for malformed or legacy-file problems, and sibling
endpoint inference when only one endpoint is configured.

**Architecture:** Keep `src/config.ts` as the single source of truth for config
discovery, normalization, recovery, and final resolution. Convert recoverable
config failures into warning-and-fallback behavior, add explicit sibling
endpoint inference after canonical source selection, and verify the new
semantics through focused config and warning-service tests before broader Deno
validation.

**Tech Stack:** Deno, TypeScript, `cosmiconfig`, existing config loader in
`src/config.ts`, OpenCode warning service in `src/services/opencode-warning.ts`,
Deno test/lint/fmt tasks.

---

## File Structure And Responsibility Lock-In

- Modify: `src/config.ts`
  - Owns config discovery, legacy fallback handling, endpoint normalization,
    recoverable error policy, sibling endpoint inference, and final resolved
    config assembly.
- Modify: `src/config.test.ts`
  - Owns behavior-level regression coverage for config discovery, malformed
    config recovery, legacy fallback semantics, and endpoint inference.
- Modify: `src/services/opencode-warning.ts`
  - Provides the neutral warning helper used by config loading and existing
    Graphiti availability warnings.
- Modify: `src/services/opencode-warning.test.ts`
  - Verifies the neutral warning helper still routes structured logs, toasts,
    and console fallback safely.
- Reference:
  `docs/superpowers/specs/2026-03-27-config-default-fallback-design.md`
  - The approved design and source of truth for behavior.

Do not add new config modules. Keep the recovery logic in `src/config.ts` and
reuse the existing warning infrastructure instead of introducing a parallel
notification path.

### Task 1: Add Neutral Warning Plumbing For Config Recovery

**Files:**

- Modify: `src/services/opencode-warning.ts`
- Test: `src/services/opencode-warning.test.ts`

- [ ] **Step 1: Read the warning service and approved spec together**

Read:

- `src/services/opencode-warning.ts`
- `src/services/opencode-warning.test.ts`
- `docs/superpowers/specs/2026-03-27-config-default-fallback-design.md`

Expected: confirm the current composed helper is availability-specific and the
plan needs a neutral wrapper or rename for config warnings.

- [ ] **Step 2: Write a failing warning-service test for neutral plugin
      warnings**

Add one focused test in `src/services/opencode-warning.test.ts` that calls the
new neutral helper and asserts it schedules the same structured warning/toast
behavior as the current availability helper.

Suggested shape:

```ts
it("delivers neutral plugin warnings through the shared warning path", async () => {
  const logCalls: unknown[] = [];
  const toastCalls: unknown[] = [];
  const scheduledTasks: Array<() => void> = [];

  setWarningTaskScheduler((callback) => {
    scheduledTasks.push(callback);
  });
  setOpenCodeClient({
    app: {
      log: (input: unknown) => {
        logCalls.push(input);
        return Promise.resolve();
      },
    },
    tui: {
      showToast: (input: unknown) => {
        toastCalls.push(input);
        return Promise.resolve();
      },
    },
  });

  notifyPluginWarning("config warning", { source: "legacy" });

  assertEquals(logCalls.length, 0);
  assertEquals(toastCalls.length, 0);
  assertEquals(scheduledTasks.length, 2);

  for (const task of scheduledTasks) task();
  await Promise.resolve();

  assertEquals(logCalls.length, 1);
  assertEquals(toastCalls.length, 1);
});
```

- [ ] **Step 3: Run the new warning-service test to verify RED**

Run:
`deno test src/services/opencode-warning.test.ts --filter "neutral plugin warnings"`

Expected: FAIL because the neutral helper does not exist yet.

- [ ] **Step 4: Implement the minimal neutral warning helper**

In `src/services/opencode-warning.ts`, add a neutral exported helper such as
`notifyPluginWarning()` that composes the existing structured log + warning
toast path. Keep `notifyGraphitiAvailabilityIssue()` as a thin compatibility
wrapper that delegates to the neutral helper.

Target shape:

```ts
export const notifyPluginWarning = (
  message: string,
  extra?: unknown,
): void => {
  const logged = scheduleStructuredWarning(message, extra);
  const toasted = scheduleWarningToast(message, extra);
  if (!logged && !toasted) {
    warnToConsole(message, extra);
  }
};

export const notifyGraphitiAvailabilityIssue = (
  message: string,
  extra?: unknown,
): void => {
  notifyPluginWarning(message, extra);
};
```

- [ ] **Step 5: Re-run the warning-service test to verify GREEN**

Run:
`deno test src/services/opencode-warning.test.ts --filter "neutral plugin warnings"`

Expected: PASS.

- [ ] **Step 6: Run the full warning-service test file**

Run: `deno test src/services/opencode-warning.test.ts`

Expected: PASS with existing warning behavior unchanged.

- [ ] **Step 7: Add a direct compatibility-wrapper regression test**

In `src/services/opencode-warning.test.ts`, add one focused test that calls
`notifyGraphitiAvailabilityIssue()` and asserts it produces the same scheduled
warning side effects as `notifyPluginWarning()`.

Expected: this directly proves the compatibility wrapper delegates correctly.
Treat this as a verification assertion, not a RED-first step.

### Task 2: Make Invalid Config Recoverable And Silent On Discovery Failure

**Files:**

- Modify: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 1: Add the warning-capture test seam first**

Before writing config tests, add the minimal warning-capture seam they depend
on. Export a tiny test-only setter such as
`setConfigWarningNotifierForTesting()` from `src/config.ts` or reuse a similarly
small seam in `src/services/opencode-warning.ts`, then reset it in `afterEach`.

The seam is required for these tests; it is not optional.

Preferred wiring: keep a module-level notifier in `src/config.ts`, for example
`let notifyConfigWarning = notifyPluginWarning`, export
`setConfigWarningNotifierForTesting()` to override it during tests, and have the
config loader call `notifyConfigWarning(...)` wherever it reports recoverable
config problems.

Add the matching reset call to the existing `afterEach` block in
`src/config.test.ts` so the notifier seam does not leak across tests.

- [ ] **Step 2: Add a failing test for malformed discovered config fallback**

In `src/config.test.ts`, replace the current throwing expectation for malformed
discovered config with a new test that asserts:

- `loadConfig()` does not throw
- the result falls back to defaults when the discovered source is unreadable
- a plugin warning is emitted
- the warning message identifies the source as discovered config

Suggested shape:

```ts
it("warns and falls back when discovered config is malformed", () => {
  const warnings: Array<{ message: string; extra: unknown }> = [];
  setConfigWarningNotifierForTesting((message, extra) => {
    warnings.push({ message, extra });
  });
  setConfigExplorerAdapterForTesting(() =>
    makeAdapter({
      searchResult: {
        graphiti: { endpoint: "not a valid url" },
      },
    })
  );

  const config = loadConfig();

  assertEquals(config.graphiti.endpoint, "http://localhost:8000/mcp");
  assertEquals(config.redis.endpoint, "redis://localhost:6379");
  assertEquals(warnings.length, 1);
});
```

- [ ] **Step 3: Add a failing test for malformed legacy config fallback**

Add a test where discovery returns `null`, legacy `load()` returns malformed
data, and the loader falls back to defaults with one warning.

Assert that the warning message identifies the source as legacy config.

At least one malformed-config warning test in this task should use an endpoint
containing credentials such as `http://user:secret@bad host` and assert the
captured warning message redacts the sensitive user info.

- [ ] **Step 4: Add a failing test for legacy load failure warning**

Add a test where discovery returns `null`, legacy `load()` throws, and the
loader returns defaults with one warning instead of throwing.

Assert that the warning message identifies the source as legacy config.

- [ ] **Step 5: Augment the existing discovery search failure test with silence
      assertions**

Update the existing discovery-search failure test so it also asserts:

- `loadConfig()` returns localhost defaults
- no plugin warning is emitted
- legacy load is not attempted
- `logger.warn(...)` is not called

Use a counter in the adapter stub to prove `load()` was not called. This should
remain GREEN for the existing default-resolution and no-legacy-attempt
assertions; only the new warning-path assertions should drive RED if any warning
reporting still leaks through the wrong path.

Add a `logger.warn` spy so the test fails until the old logging path is removed.

Implementation hint: import `logger` from `src/services/logger.ts` and use
`stub(logger, "warn", () => {})` so the test can assert no logger warning was
emitted.

- [ ] **Step 6: Augment the existing discovery init failure test with silence
      assertions**

Update the existing discovery-init failure test so it also asserts
`loadConfig()` returns defaults without emitting a plugin warning and without
calling `logger.warn`, and that legacy `load()` was not attempted. The defaults
assertion may remain GREEN; the warning assertions are the intended RED signal
until the catch path is corrected.

Use the same `logger.warn` spy pattern here so the test cannot pass for the
wrong reason.

- [ ] **Step 7: Run malformed-config RED checks**

Run: `deno test src/config.test.ts --filter "malformed|legacy load failure"`

Expected: FAIL because the loader still throws or warns incorrectly.

Note: some pre-existing throw-based tests in `src/config.test.ts` will conflict
with the new fail-open behavior after Step 8 lands. That temporary conflict is
expected and is resolved in Task 4 Step 1.

- [ ] **Step 8: Run discovery-failure RED checks**

Run: `deno test src/config.test.ts --filter "discovery"`

Expected: FAIL until discovery failures stop calling `logger.warn(...)`.

- [ ] **Step 9: Implement recoverable config warning injection in
      `src/config.ts`**

Update `src/config.ts` so:

- discovery init/search failures return `resolveConfig(null)` silently, without
  calling `logger.warn` or `notifyConfigWarning`
- `config-invalid` joins the recoverable error set for file-based config loading
- malformed discovered config and malformed legacy config are treated as an
  unreadable source and resolved by falling back to the next source/defaults
- legacy load failures trigger the neutral plugin warning path instead of throw

Preserve source provenance while doing this so warning messages can identify
whether the ignored source was discovered config or legacy config.

Keep the file-source discard behavior simple: if one source throws
`ConfigLoadError` with a recoverable code during normalization/loading, discard
that entire source and continue.

Call out the existing implementation points explicitly while editing:

- update `isRecoverableConfigLoadFailure()` so it includes `config-invalid`
- branch the `loadConfig()` catch block explicitly:
  - `config-discovery-init` and `config-discovery-search` -> silent fallback
  - `config-file-load` and `config-invalid` -> `notifyConfigWarning(...)`
- keep discovery init/search failures silent
- route legacy/malformed-file warnings through `notifyConfigWarning(...)`

If needed, use separate try/catch handling for discovered config and legacy
fallback loading so `config-invalid` warnings can name the correct source.

- [ ] **Step 10: Re-run malformed-config checks to verify GREEN**

Run: `deno test src/config.test.ts --filter "malformed|legacy load failure"`

Expected: PASS.

- [ ] **Step 11: Re-run discovery-failure checks to verify GREEN**

Run: `deno test src/config.test.ts --filter "discovery"`

Expected: PASS.

- [ ] **Step 12: Run the legacy fallback regression test**

Run:
`deno test src/config.test.ts --filter "legacy fallback file when discovery finds nothing"`

Expected: PASS, proving successful legacy fallback still wins when discovery
returns no config.

### Task 3: Add Sibling Endpoint Inference

**Files:**

- Modify: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 1: Add a failing test for graphiti-only endpoint inference**

Add a test where only `graphiti.endpoint` is configured and assert the resolved
Redis endpoint uses the same hostname with `redis://` and port `6379`.

Suggested expectation:

```ts
assertEquals(config.graphiti.endpoint, "http://graphiti.internal:9000/custom");
assertEquals(config.redis.endpoint, "redis://graphiti.internal:6379");
```

- [ ] **Step 2: Add a failing test for redis-only endpoint inference**

Add a test where only `redis.endpoint` is configured and assert the resolved
Graphiti endpoint uses the same hostname with `http://`, port `8000`, and path
`/mcp`.

- [ ] **Step 3: Add a failing test for explicit-both-endpoints no-inference
      behavior**

Add a test where both endpoints are provided and assert both are preserved as
configured.

- [ ] **Step 4: Add a both-endpoints-absent defaults verification test**

Add a test where the config source provides only non-endpoint fields, such as
`redis.batchSize`, and assert both resolved endpoints remain the localhost
defaults while the non-endpoint value is preserved.

Suggested assertion shape:

```ts
setConfigExplorerAdapterForTesting(() =>
  makeAdapter({
    searchResult: {
      redis: { batchSize: 10 },
    },
  })
);

assertEquals(config.graphiti.endpoint, "http://localhost:8000/mcp");
assertEquals(config.redis.endpoint, "redis://localhost:6379");
assertEquals(config.redis.batchSize, 10);
```

Treat this as a verification assertion rather than a RED-first step.

- [ ] **Step 5: Add a whole-source discard regression test on mixed
      valid/invalid endpoints**

Add a test where one source contains one valid endpoint and one malformed
endpoint, then assert the loader discards the entire source and returns defaults
rather than partially recovering the valid endpoint.

This may already pass once Task 2 makes `config-invalid` recoverable. If so,
treat it as a verification assertion instead of forcing an artificial RED step.

- [ ] **Step 6: Add a failing test for IPv6 hostname transfer**

Add a test using `http://[::1]:9000/custom` or `redis://[::1]:6380` and assert
the inferred sibling endpoint uses the same IPv6 hostname with the target
service's canonical port and remains a valid URL string, for example
`redis://[::1]:6379`.

The assertion should prove the inferred value parses as a URL, not just that it
contains the host text.

- [ ] **Step 7: Add a failing test for `rediss://` canonical Graphiti
      inference**

Add a test where the Redis source uses `rediss://cache.internal:6380` and assert
the inferred Graphiti endpoint remains `http://cache.internal:8000/mcp` per the
approved non-TLS-propagation rule.

- [ ] **Step 8: Add a failing test for nested endpoint precedence before
      inference**

Add a test where the source provides both top-level legacy `endpoint` and nested
`graphiti.endpoint`, omits `redis.endpoint`, and assert the inferred Redis host
comes from the nested Graphiti endpoint rather than the legacy alias.

Suggested assertion shape:

```ts
assertEquals(
  config.graphiti.endpoint,
  "http://nested-host.example:9000/custom",
);
assertEquals(config.redis.endpoint, "redis://nested-host.example:6379");
```

- [ ] **Step 9: Add a failing test for invalid explicit scheme fallback**

Add a test where a configured endpoint uses a disallowed explicit scheme such as
`ftp://bad.example/mcp`, then assert the loader emits one warning, does not
throw, and falls back to defaults.

Also assert the warning message identifies the source type and redacts any
sensitive endpoint user info.

- [ ] **Step 10: Run the expanded focused inference tests to verify RED**

Run:
`deno test src/config.test.ts --filter "infers|IPv6|both endpoints|whole source|scheme|nested|non-endpoint"`

Expected: FAIL because sibling inference and invalid-scheme recovery are not
implemented yet.

- [ ] **Step 11: Implement endpoint sibling inference in `src/config.ts`**

Add a small helper in `src/config.ts` that:

- inspects the canonical configured endpoints after source selection
- parses the present endpoint with `new URL(...)`
- copies only `hostname`
- builds the missing sibling endpoint with the target service's canonical
  scheme/port/path
- leaves the source endpoint untouched
- skips inference when both endpoints are already present or both are absent
- uses the same precedence ordering already established elsewhere in
  `src/config.ts`, so nested Graphiti values remain authoritative over the
  top-level legacy alias
- re-brackets IPv6 hostnames before interpolating them into inferred URLs

Suggested helper shape:

```ts
const formatHostForUrl = (hostname: string): string => {
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
};

const getCanonicalGraphitiEndpoint = (
  value: RawGraphitiConfig | null,
): string | undefined => {
  return value?.graphiti?.endpoint ?? value?.endpoint;
};

const inferSiblingEndpoints = (
  value: RawGraphitiConfig | null,
): RawGraphitiConfig | null => {
  if (!value) return value;

  const graphitiEndpoint = getCanonicalGraphitiEndpoint(value);
  const redisEndpoint = value.redis?.endpoint;

  if (graphitiEndpoint && !redisEndpoint) {
    // Safe because inference runs after normalizeConfiguredEndpoints(...).
    const host = formatHostForUrl(new URL(graphitiEndpoint).hostname);
    return {
      ...value,
      redis: {
        ...value.redis,
        endpoint: `redis://${host}:6379`,
      },
    };
  }

  if (redisEndpoint && !graphitiEndpoint) {
    // Safe because inference runs after normalizeConfiguredEndpoints(...).
    const host = formatHostForUrl(new URL(redisEndpoint).hostname);
    return {
      ...value,
      graphiti: {
        ...value.graphiti,
        endpoint: `http://${host}:8000/mcp`,
      },
    };
  }

  return value;
};
```

Wire the helper into resolution after `normalizeConfiguredEndpoints(...)` and
before `resolveConfig()` applies numeric defaults. Extract the Graphiti endpoint
precedence expression into one small helper that both `resolveConfig()` and
inference can share, rather than duplicating it in multiple places.

Update `resolveConfig()` itself to call the shared helper, then verify the
existing nested-over-legacy precedence test still passes.

The existing
`prefers nested graphiti and redis values over legacy top-level
graphiti keys`
test in `src/config.test.ts` is the regression guard for this shared-precedence
refactor.

- [ ] **Step 12: Re-run the expanded focused inference tests to verify GREEN**

Run:
`deno test src/config.test.ts --filter "infers|IPv6|both endpoints|whole source|scheme|nested|non-endpoint"`

Expected: PASS.

### Task 4: Clean Up Test Coverage And Run Full Verification

**Files:**

- Modify: `src/config.test.ts`
- Modify: `src/services/opencode-warning.test.ts`

- [ ] **Step 1: Reconcile old throwing tests with the new fail-open behavior**

Remove or rewrite any remaining tests in `src/config.test.ts` that still expect
`ConfigLoadError` for malformed endpoint values. Keep direct unit coverage for
`ConfigLoadError` only where constructor semantics are still relevant.

Preserve the existing passing tests that already match the approved behavior,
including:

- `returns defaults when no config is found`
- `uses legacy fallback file when discovery finds nothing`

That second test is the regression guard for the spec requirement that a
successful legacy fallback still wins when discovery returns no config.

- [ ] **Step 2: Run the full config test file**

Run: `deno test src/config.test.ts`

Expected: PASS.

- [ ] **Step 3: Run the combined focused test files**

Run: `deno test src/config.test.ts src/services/opencode-warning.test.ts`

Expected: PASS.

- [ ] **Step 4: Run project type-check validation**

Run: `deno task check`

Expected: PASS.

- [ ] **Step 5: Run project lint validation**

Run: `deno task lint`

Expected: PASS.

- [ ] **Step 6: Run project formatting validation**

Run: `deno fmt --check`

Expected: PASS.

- [ ] **Step 7: Update the plan checklist with any deviations discovered during
      validation**

If any command requires a narrower or alternate invocation in practice, record
that directly in the execution notes when implementing so the final artifact
stays reproducible.
