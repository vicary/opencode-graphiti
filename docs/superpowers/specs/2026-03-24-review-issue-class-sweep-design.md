# Review Issue-Class Sweep Design

## Goal

Systematically hunt for every instance of each issue class raised in resolved PR
review comments and fix them repo-wide wherever local evidence supports the
change. The sweep operates on issue _classes_, not individual review threads: a
class may yield fixes in files that were never mentioned in the original review.

## Scope

### Issue Classes

Each class below is an independent sweep track. A dedicated subagent session
handles exactly one class.

#### 1. Abort/Cancellation Semantics and Typed Abort Normalization

**Pattern**: The codebase has two independent `isAbortError` implementations
(`connection-manager.ts:217` and `session-executor.ts:208`) with slightly
different shapes. Abort reasons are constructed ad-hoc
(`new GraphitiRequestTimeoutError()`, raw
`DOMException("aborted",
"AbortError")` in tests).

**Sweep target**:

- Unify `isAbortError` into a single shared utility (likely in `utils.ts` or a
  dedicated abort module).
- Audit every `AbortController.abort(reason)` call site to ensure the abort
  reason is a typed error, not a bare string or untyped value.
- Verify test doubles construct abort errors via the shared helper or the
  canonical `DOMException` constructor.

**Files likely in scope**: `src/services/connection-manager.ts`,
`src/services/session-executor.ts`, `src/services/session-corpus.ts`,
`src/services/connection-manager.test.ts`,
`src/services/session-executor.test.ts`,
`src/services/session-mcp-runtime.test.ts`, `src/utils.ts`.

#### 2. Endpoint Validation/Redaction Consistency

**Pattern**: `redactEndpointUserInfo` is applied in `index.ts` startup warnings
and `connection-manager.ts` logging, but not necessarily at every other site
that formats an endpoint for user-visible output (log messages, error messages,
warning toasts).

**Sweep target**:

- Grep every log/warn/error/toast call that interpolates a config endpoint
  string.
- Ensure `redactEndpointUserInfo` is applied before any endpoint reaches a
  user-visible surface.
- Verify `isValidUrlString` is used consistently for explicit-URL validation
  (config layer) and that no call site silently swallows malformed URLs outside
  the config validator.

**Files likely in scope**: `src/index.ts`, `src/config.ts`,
`src/services/connection-manager.ts`, `src/services/endpoint-redaction.ts`,
`src/services/graphiti-mcp.ts`, `src/services/opencode-warning.ts`,
`src/services/redis-client.ts`, `src/services/session-mcp-runtime.ts`.

#### 3. Stable User-Facing Denial/Error Messaging

**Pattern**: Denial and degradation messages must be stable strings that do not
leak internal state. The codebase already uses structured patterns like
`"Graphiti MCP unavailable at …; continuing without persistent memory."` and
`"Redis unavailable at …; continuing with in-memory hot-tier fallback."` but
`graphiti-mcp.ts` uses shorter forms like
`"Graphiti unavailable; memory was not
saved."`.

**Sweep target**:

- Audit every user-facing warning/error string for consistency in phrasing,
  structure, and information density.
- Ensure no message leaks raw error `.message` content, stack traces, or
  internal keys to the user-visible surface (logger.warn payloads shown via
  toast vs. structured-only fields).
- Verify tool denial messages in `tool-routing.ts` / `tool-guidance.ts` are
  stable and do not embed variable internal state.

**Files likely in scope**: `src/services/graphiti-mcp.ts`,
`src/services/opencode-warning.ts`, `src/services/redis-client.ts`,
`src/services/redis-events.ts`, `src/services/session-mcp-runtime.ts`,
`src/services/tool-routing.ts`, `src/services/tool-guidance.ts`, `src/index.ts`.

#### 4. Public Type Reuse in Tests

**Pattern**: Multiple test files independently define identical local types
(`type RedisEvent = "close" | "end" | "error" | "ready"` appears in at least 5
test files). Test-local type aliases for public shapes create maintenance drift.

**Sweep target**:

- Identify types duplicated across test files that mirror or subset public
  exports from `src/types/index.ts` or service modules.
- Extract shared test-utility types to a common test-helper module or re-export
  from the source module, whichever is simpler.
- The `RedisEvent` union duplicated in `batch-drain.test.ts`,
  `redis-events.test.ts`, `session-mcp-runtime.test.ts`, `redis-client.test.ts`,
  `hot-tier-slice.test.ts`, `redis-cache.test.ts` is the primary target.

**Files likely in scope**: All `*.test.ts` files under `src/services/` that
define `type RedisEvent`, plus any shared test-helper file created or extended.

#### 5. Config/Docs Consistency and Dead-Path Simplification

**Pattern**: Config defaults live in `config.ts` (`DEFAULT_CONFIG`), in
`AGENTS.md` (§ Configuration), and in `README.md` (§ Configuration). The three
must agree. Legacy config paths and deprecated keys may still be referenced in
docs but removed from code, or vice versa.

**Sweep target**:

- Cross-check `DEFAULT_CONFIG` values in `config.ts` against every doc that
  states defaults (`AGENTS.md`, `README.md`).
- Verify documented config keys match the actual `RawGraphitiConfig` /
  `GraphitiConfig` types — no phantom keys, no missing keys.
- Identify dead code paths in `config.ts` (e.g. `loadLegacyConfig` if legacy
  path is no longer documented or tested) and simplify or document their
  retention rationale.
- Check `deno.json` task names match any doc references.

**Files likely in scope**: `src/config.ts`, `src/config.test.ts`, `AGENTS.md`,
`README.md`, `deno.json`.

## Non-Goals

- Unrelated refactors outside the five issue classes.
- Stylistic churn (formatting, import ordering, naming preferences) unless it is
  directly part of an issue-class fix.
- Speculative API redesigns or public contract changes.
- Touching files that are dirty in the worktree for reasons unrelated to the
  sweep.

## Execution Model

```
Main session
├── Class 1 subagent  ─ abort/cancellation
├── Class 2 subagent  ─ endpoint validation/redaction
├── Class 3 subagent  ─ user-facing messaging
├── Class 4 subagent  ─ type reuse in tests
├── Class 5 subagent  ─ config/docs consistency
│
├── Integration pass   ─ merge non-conflicting changes, resolve overlaps
├── Broad verification ─ full test suite, type check, lint
└── Thread follow-up   ─ update unresolved review threads if changes apply
```

Each subagent:

1. Receives its single issue class, the target file list, and the evidence
   standard.
2. Greps/reads to find all instances of the class pattern.
3. Fixes only instances with clear local evidence.
4. Runs targeted verification (the specific test files affected).
5. Returns: changed files, verification commands + results, any instances it
   chose _not_ to fix with rationale.

The main session:

1. Reviews each subagent's summary for correctness.
2. Integrates changes, resolving file overlaps (especially `utils.ts`,
   `connection-manager.ts`, `index.ts` which appear in multiple classes).
3. Runs `deno task check` and `deno test` across the full repo.
4. Only after green: updates review threads with evidence of repo-wide fixes.

## Evidence Standard

A fix is applied only when:

- The code pattern matches the issue class definition above.
- The fix is locally verifiable (tests pass, types check, behavior is equivalent
  or strictly improved).
- No intentional contract is changed (e.g., a message string that is part of a
  stable API or documented interface must not be altered without explicit
  confirmation).

If no further instances exist beyond what was already fixed in the review, the
subagent reports "no further instances found" and exits cleanly.

## Verification Strategy

**Per-class (subagent)**:

- Run only the test files that import or exercise the changed modules.
- Run `deno check` on changed files.
- Report exact commands and their exit codes.

**Integrated (main session)**:

- `deno task check` — full type check.
- `deno test` — full test suite.
- `deno task build` — DNT build (catches Node.js compat regressions).
- Report pass/fail with truncated output on failure.

## Git Hygiene

- `git diff --name-only` before and after sweep to confirm only sweep-related
  files are touched.
- Do not `git add` files that were already dirty before the sweep started.
- Commit only validated changes. One commit per integrated sweep is acceptable;
  per-class commits are preferred if they are independently green.

## Risks

| Risk                                                                                             | Mitigation                                                                                          |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Overlapping files between classes (e.g., `connection-manager.ts` touched by class 1 and class 2) | Main session integrates sequentially; later class rebases on earlier class's changes.               |
| False positives from grep (pattern match ≠ actual issue)                                         | Evidence standard requires local verification, not just pattern match.                              |
| Changing intentional contracts (stable error messages used in downstream parsing)                | Check for downstream consumers before changing any string constant.                                 |
| Review-thread state drifts during sweep (new comments, re-reviews)                               | Fetch fresh thread state immediately before posting follow-up; skip threads that have new activity. |
| Subagent scope creep                                                                             | Each subagent prompt includes explicit non-goals and a "stop if unsure" directive.                  |

## Deliverables

Per class:

- List of changed files with one-line description of each change.
- Verification commands executed and their results.
- List of instances inspected but intentionally not changed, with rationale.

Integrated:

- Final `deno task check` + `deno test` + `deno task build` results.
- Combined changed-files summary.
- Live unresolved-thread status after any follow-up posts.
