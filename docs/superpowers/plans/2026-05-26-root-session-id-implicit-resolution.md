# Root Session ID Implicit Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove legacy `root_session_id` request plumbing from public
`session_*` tools and resolve the canonical root session implicitly everywhere.

**Architecture:** Public MCP request schemas become context-only and no longer
accept `root_session_id`. The runtime resolves the canonical root session once
from `context.sessionID` for every tool execution and threads that value
internally to services that need it. Tool descriptions, tests, and design docs
are updated to match the implicit-resolution contract.

**Tech Stack:** Deno, TypeScript, Zod, in-process MCP runtime, OpenCode plugin
hooks.

---

### Task 1: Remove Public `root_session_id` Request Inputs

**Files:**

- Modify: `src/services/session-mcp-types.ts`
- Modify: `src/services/session-mcp-runtime.ts`
- Test: `src/services/session-mcp-runtime.test.ts`

- [ ] **Step 1: Write the failing schema/runtime assertions**

Add or update tests in `src/services/session-mcp-runtime.test.ts` so every
public `session_*` request rejects `root_session_id`, and valid requests omit
it:

```ts
const validRequests: Record<SessionMcpToolName, Record<string, unknown>> = {
  session_execute: { command: "pwd" },
  session_execute_file: { paths: ["README.md"] },
  session_batch_execute: { commands: [{ command: "first" }] },
  session_index: { content: "hello world" },
  session_search: { query: "hello" },
  session_fetch_and_index: { url: "https://example.com" },
  session_stats: {},
  session_doctor: {},
  session_notes_write: { text: "remember this" },
  session_notes_read: { id: "note-1" },
};
```

- [ ] **Step 2: Run targeted tests to verify they fail first**

Run: `deno test src/services/session-mcp-runtime.test.ts` Expected: failures
around request schemas or runtime assumptions that still require
`root_session_id`.

- [ ] **Step 3: Remove `root_session_id` from public request schemas and request
      types**

Update `src/services/session-mcp-types.ts` so request types no longer include
`root_session_id`, and all public schemas are strict without that field. Keep
`root_session_id` in response metadata where already documented:

```ts
type SessionExecuteRequest = {
  command: string;
  timeout_seconds?: number;
};

type SessionBatchExecuteRequest = {
  commands: SessionExecuteStep[];
  steps?: SessionBatchStep[];
};

export const sessionMcpRequestSchemas = {
  session_execute: z.object({
    command: z.string().min(1),
    timeout_seconds: z.number().int().positive().max(120).optional(),
  }).strict(),
  // same pattern for execute_file, batch_execute, index,
  // fetch_and_index, stats, doctor, notes_write, notes_read, search
};
```

- [ ] **Step 4: Move canonical root-session resolution fully into runtime
      execution**

Update `src/services/session-mcp-runtime.ts` so every tool resolves the
canonical root session from `context` inside `executeTool`, then passes that
resolved value into handlers or helper calls without relying on request
payloads:

```ts
const executeTool = async <TToolName extends SessionMcpToolName>(
  toolName: TToolName,
  rawRequest: unknown,
  context: ToolContext,
): Promise<string> => {
  const request = parseRequest(toolName, rawRequest);
  const rootSessionId = await resolveCanonicalRootSessionId(context);

  await validateRuntimeRootSessionContract(
    toolName,
    rootSessionId,
    context,
    sessionCanonicalizer,
  );

  const response = await handlerMap[toolName](request, {
    ...context,
    rootSessionId,
  });
  // ...
};
```

Use the smallest internal-context change that keeps handlers readable; avoid
spreading synthetic `root_session_id` back into parsed public requests.

- [ ] **Step 5: Run targeted tests to verify the contract passes**

Run: `deno test src/services/session-mcp-runtime.test.ts` Expected: PASS.

### Task 2: Remove Hook-Level Injection And Legacy Plumbing

**Files:**

- Modify: `src/handlers/tool-before.ts`
- Modify: `src/handlers/tool-before.test.ts`
- Modify: `src/services/session-executor.ts` (only if types or internal helper
  signatures require cleanup)
- Modify: `src/index.test.ts`

- [ ] **Step 1: Write/update failing hook tests**

Update `src/handlers/tool-before.test.ts` so session tools no longer gain a
`root_session_id` field during `tool.execute.before`, while routing still
receives the canonical session context it needs:

```ts
assertEquals(output.args, { query: "indexed" });
assertEquals(routedArgs, { query: "original" });
```

- [ ] **Step 2: Run hook-focused tests to verify they fail first**

Run: `deno test src/handlers/tool-before.test.ts src/index.test.ts` Expected:
failures because the hook still injects `root_session_id` and tests still expect
it.

- [ ] **Step 3: Remove root-session argument injection from the before hook**

Simplify `src/handlers/tool-before.ts` so it resolves the canonical session only
for routing decisions, not for mutating session-tool args:

```ts
const canonicalSessionId = await resolveCanonicalSessionId(
  deps.sessionCanonicalizer,
  sessionID,
);
const args = toRecord(output.args);

const decision = route({
  canonicalSessionId,
  toolName: tool,
  args,
  guidanceThrottle: deps.guidanceThrottle,
});
```

If the modify path rewrites args, preserve only the rewritten public args.

- [ ] **Step 4: Remove now-dead root-session plumbing helpers or request
      assumptions**

Delete or simplify helper code that exists only to inject, normalize, or
preserve `root_session_id` in public tool args. Keep internal artifact/corpus
storage keyed by the canonical root session where needed.

- [ ] **Step 5: Run hook/integration tests to verify behavior**

Run: `deno test src/handlers/tool-before.test.ts src/index.test.ts` Expected:
PASS.

### Task 3: Align Tool Descriptions, Specs, And Historical Docs

**Files:**

- Modify: `src/services/session-mcp-runtime.ts`
- Modify: `docs/SmokeTests.md`
- Modify: `docs/superpowers/plans/2026-03-20-context-mode-mcp-first.md`
- Modify:
  `docs/superpowers/plans/2026-03-20-context-mode-mcp-first-implementation.md`
- Test: `src/services/session-mcp-runtime.test.ts`
- Test: `src/index.test.ts`

- [ ] **Step 1: Update description assertions first**

Adjust tests so shipped tool descriptions explicitly state that canonical root
session resolution is automatic and callers must not provide `root_session_id`:

```ts
assertStringIncludes(
  runtime.tools.session_search.description,
  "Do not pass `root_session_id`; the runtime resolves the current canonical root session automatically.",
);
```

- [ ] **Step 2: Run description tests to verify they fail first**

Run: `deno test src/services/session-mcp-runtime.test.ts src/index.test.ts`
Expected: failures because descriptions/docs still reflect the old contract.

- [ ] **Step 3: Update shipped tool descriptions**

Edit the `SESSION_*_DESCRIPTION` strings in
`src/services/session-mcp-runtime.ts` so every public session tool describes
implicit root resolution and no longer suggests caller-supplied root targeting.

- [ ] **Step 4: Update docs that still claim all session tools require
      `root_session_id`**

Revise old plan/spec text so it records the current contract instead of the
obsolete one. Keep historical context where useful, but mark the old requirement
as superseded rather than leaving contradictory guidance in place.

- [ ] **Step 5: Run the targeted tests again**

Run: `deno test src/services/session-mcp-runtime.test.ts src/index.test.ts`
Expected: PASS.

### Task 4: Verify Repo-Wide Behavior

**Files:**

- No new source files expected

- [ ] **Step 1: Run the focused affected suites**

Run:
`deno test src/services/session-mcp-runtime.test.ts src/handlers/tool-before.test.ts src/index.test.ts`
Expected: PASS.

- [ ] **Step 2: Run repo type-check**

Run: `deno task check` Expected: PASS.

- [ ] **Step 3: Run lint**

Run: `deno lint` Expected: PASS.

- [ ] **Step 4: Run format**

Run: `deno fmt` Expected: files are already formatted or formatting is applied
cleanly.
