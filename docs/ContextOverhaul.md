# Context Overhaul — Context-Mode-Aligned Hot Path on FalkorDB

**Status:** Superseded — retained as historical context only\
**Superseded by:**

- `docs/superpowers/plans/2026-03-20-context-mode-mcp-first.md` (architecture)
- `docs/superpowers/plans/2026-03-20-context-mode-mcp-first-implementation.md`
  (implementation)

> **Historical-only note:** This document preserves the earlier native-routing
> overhaul proposal and its original section numbering. Any implementation
> phases, file-change lists, or acceptance checklists below are historical notes
> only and are **not** the active backlog for the repository. For current
> architecture and acceptance criteria, use the two superseding MCP-first plan
> documents above together with `README.md`.

**Date:** 2026-03-20\
**Historical refs:** `README.md`, `docs/ContextOverhaulTests.md`

---

## 1 Problem

The current plugin is only partially aligned with the hot-path behavior that
makes `context-mode` effective.

Today, this repository does well at:

- keeping Graphiti off the steady-state chat path
- extracting compact continuity events instead of replaying full transcripts
- rebuilding a deterministic `<session_memory>` envelope from local state

But it still falls short in the most important real-time token-saving area:

- native heavy tool calls are usually allowed to run first
- large tool outputs can still enter the live OpenCode transcript
- the plugin mainly compresses what it remembers and re-injects later
- it does not yet consistently prevent high-volume context from being created at
  the source

In contrast, `context-mode` achieves most of its context savings by intercepting
tool calls before execution and routing them toward lighter, bounded behavior.
For this plugin to follow that design closely enough, the hot path must shift
from "compact after the fact" to "prevent or bound transcript growth before it
happens."

This plan updates the architecture to target at least **80% behavioral
alignment** with `context-mode` on the hot path while preserving this repo's two
intentional differences:

1. **Storage layer:** short-term state remains in FalkorDB via the Redis
   protocol and existing `redis.*` config keys.
2. **Session lineage model:** child sessions remain first-class participants in
   the root session's continuity state rather than being reduced to summarized
   agent-tool output only.

---

## 2 Goals

1. **Adopt source-side token reduction.** Heavy native tool calls must be
   intercepted before execution and denied, bounded, or rewritten so raw
   payloads do not enter the live transcript unnecessarily.
2. **Reach >=80% context-mode hot-path alignment.** Match `context-mode` on
   pre-tool routing, deterministic enforcement, compact event extraction, and
   conservative session snapshotting.
3. **Keep Graphiti off the hot path.** No synchronous Graphiti call may block
   `tool.execute.before`, `chat.message`, `messages.transform`,
   `session.compacting`, or any per-message event hook.
4. **Keep short-term state in FalkorDB.** The hot tier continues to use the
   Redis-compatible FalkorDB endpoint configured through canonical `redis.*`
   settings only.
5. **Preserve session continuity.** The plugin must still inject deterministic
   `<session_memory>` derived from local typed events, snapshots, and optional
   cached Graphiti recall.
6. **Preserve intentional divergence for child sessions.** Child/subagent work
   must continue to accumulate into the canonical root session instead of being
   flattened to opaque tool summaries.

---

## 3 Alignment Target

### 3.1 What "80% aligned" means

This repo does **not** need to become a clone of `context-mode`. It does need to
match its core hot-path mechanics closely enough that the same practical
benefits appear in OpenCode sessions.

The required alignment surface is:

- **Pre-tool interception** for heavy tools
- **Deterministic routing policy** implemented in code, not by a separate LLM
- **Allow / modify / deny** style decisions at tool-call time
- **Compact post-tool continuity extraction** from metadata and short summaries
- **Priority-tiered session snapshot building** from typed events
- **Stable reinjection** of compact continuity state before LLM calls

#### 3.1.1 Concrete alignment checklist

The 80% target is met when **all** of the following are true:

| #  | Criterion                           | Measurement                                                                                                    |
| -- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A1 | Pre-tool interception exists        | `tool.execute.before` hook is registered and exercised for every tool in the minimum set (§6.2).               |
| A2 | Deterministic routing decisions     | Each tool in the minimum set has a coded policy that returns allow / modify / deny without calling an LLM.     |
| A3 | Source-side token prevention        | At least one heavy-tool class (`Read`, `Bash`, `WebFetch`) is demonstrably bounded or denied before execution. |
| A4 | Compact event extraction            | No `SessionEvent.body` exceeds 4 KB; no raw tool output stored as a hot-tier event.                            |
| A5 | Priority-tiered snapshot            | Snapshot respects P0–P3 tiers and stays within `SNAPSHOT_BODY_BUDGET`.                                         |
| A6 | Stable reinjection                  | `<session_memory>` is injected on every `messages.transform` and `session.compacting` call.                    |
| A7 | No Graphiti on hot path             | Zero synchronous MCP calls during any hook return (existing invariant, must not regress).                      |
| A8 | Context-mode-style routing guidance | Read/Grep/Bash guidance is injected once per session; WebFetch is blocked; Task prompt routing is rewritten.   |

Criteria A1–A3 are the **new** requirements from this plan. Criteria A4–A7 are
**existing** invariants that must not regress. Criterion A8 captures the
session-scoped guidance and prompt-rewrite mechanics that make `context-mode`'s
OpenCode routing practical without replacing native tools.

The allowed divergence surface is:

- FalkorDB/Redis instead of SQLite for local state
- root-session promotion for child/subagent continuity
- Graphiti-backed async long-term memory and cache refresh
- this repo's existing `<session_memory>` envelope instead of `context-mode`'s
  `<session_resume>` format

### 3.2 Non-goals

This plan does **not** include:

- replacing FalkorDB with SQLite
- moving Graphiti back onto the hot path
- removing the existing Graphiti async drain/cache architecture
- reverting child-session aggregation to summarized-only agent events
- introducing a second LLM summarization pass for the hot tier

---

## 4 Architecture

```text
opencode-graphiti plugin (TypeScript / Deno)
  |
  |- Hot path — OpenCode hooks + FalkorDB over Redis protocol
  |    |- tool.execute.before
  |    |    - inspect native tool call
  |    |    - allow / modify / deny based on deterministic routing rules
  |    |    - prevent oversized raw outputs from entering transcript
  |    |
  |    |- event / chat.message / messages.transform / session.compacting
  |    |    - extract typed continuity events
  |    |    - rebuild compact snapshot from FalkorDB state
  |    |    - inject canonical <session_memory>
  |    |
  |    '- FalkorDB storage via Redis commands
  |         - session events
  |         - snapshots
  |         - memory cache
  |         - pending async drain batches
  |
  '- Async tier — Graphiti MCP
       - drain semantic episodes
       - refresh cached long-term recall
       - prime cold sessions opportunistically
       - never block hook returns
```

### 4.1 Architectural shift

The old hot-path posture was:

- let native tools run
- observe their output afterward
- store only a compact continuity representation

The revised hot-path posture becomes:

- intercept the tool call first
- prevent or rewrite the expensive form when appropriate
- only then observe the resulting bounded tool activity
- store compact continuity from the bounded result

This is the single biggest design change in the plan.

---

## 5 Hook Model

### 5.1 Required hooks

| Hook                                   | Purpose                                                        |
| -------------------------------------- | -------------------------------------------------------------- |
| `tool.execute.before`                  | Pre-tool routing, deny/modify/allow decisions                  |
| `event`                                | Session lifecycle + typed event capture                        |
| `chat.message`                         | Prepare local continuity state for the current turn            |
| `experimental.chat.messages.transform` | Inject canonical `<session_memory>` into the last user message |
| `experimental.session.compacting`      | Inject the same continuity envelope into compaction            |

### 5.2 Hook API contract (from `@opencode-ai/plugin@1.2.26`)

The OpenCode plugin SDK exposes these tool-lifecycle hooks:

```ts
// tool.execute.before — fires before tool execution
"tool.execute.before"?: (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any },
) => Promise<void>;

// tool.execute.after — fires after tool execution
"tool.execute.after"?: (
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: { title: string; output: string; metadata: any },
) => Promise<void>;
```

**Key constraint:** `tool.execute.before` can only mutate `output.args`. There
is no first-class `deny` return value in the SDK.

`context-mode`'s published OpenCode plugin resolves this by **throwing an
Error** from `tool.execute.before` for `deny` and `ask` decisions, and by using
in-place arg mutation for `modify` decisions. This plan adopts the same
mechanism.

Therefore:

1. **Hard deny** = throw an error from `tool.execute.before`.
2. **Modify** = mutate args in place before native tool execution.
3. **Context guidance** = no-op at the SDK layer; routing guidance should reach
   the model through `AGENTS.md`, injected subagent prompt blocks, or bounded
   tool-arg rewrites.

### 5.3 `tool.execute.after`

Unlike the speculative earlier draft, `context-mode`'s OpenCode plugin does not
use `tool.execute.after` to rewrite or truncate visible tool output. It uses the
after-hook for continuity capture only.

This plan follows that design:

- `tool.execute.after` remains available for event extraction and metadata
  capture
- it is **not** part of the primary routing/token-reduction mechanism
- source-side prevention must happen in `tool.execute.before`

### 5.4 New hot-path invariant

`tool.execute.before` becomes part of the core hot-path contract.

No heavy native tool class should be considered fully supported unless it has:

1. an explicit routing decision policy
2. tests for allow / modify / deny behavior
3. a documented bounded-output rationale

---

## 6 Pre-Tool Routing Design

### 6.1 Decision model

The plugin should adopt a `context-mode`-style routing engine that returns one
of these decisions:

- `allow` — safe to run unchanged
- `modify` — safe only after input is rewritten or bounded
- `deny` — unsafe/raw-output-heavy; reject with actionable guidance

Unlike `context-mode`, this repo does not need to reproduce every external
sandbox tool. But it must reproduce the same **mechanical behavior**:

- decisions are deterministic and local
- decisions happen before execution
- decisions are based on tool name, arguments, and risk heuristics
- denial/modification prevents transcript blow-up at the source

#### 6.1.1 Routing principles

1. **Deterministic, not heuristic-heavy.** Each tool's policy is a short
   decision tree based on argument inspection (file extension, path pattern,
   presence/absence of `limit`, command prefix). No LLM calls, no embedding
   lookups.
2. **Follow context-mode's guidance-first posture.** Prefer a once-per-session
   routing nudge for broad native tools (`Read`, `Grep`, general `Bash`) and
   reserve hard blocks for tools/patterns that are known context sinks (for
   example `WebFetch`, raw `curl`, `wget`, and certain build-tool invocations).
3. **Composable policies.** Each tool's policy is a pure function
   `(toolName, args) => RoutingDecision`. The routing engine dispatches by tool
   name and delegates to the per-tool policy. New tools are added by registering
   a new policy function.
4. **No cross-tool state.** Routing decisions are stateless per call. The engine
   does not track how many times a tool has been called or accumulate context
   across calls.
5. **Fail-open for unknown tools.** Tools not in the minimum set (§6.2) are
   allowed unchanged. This mirrors `context-mode`'s OpenCode posture more
   closely than an aggressive deny-by-default design.

#### 6.1.2 `RoutingDecision` type

```ts
type RoutingDecision =
  | { action: "allow" }
  | { action: "modify"; args: Record<string, unknown>; reason: string }
  | { action: "deny"; guidance: string }
  | { action: "context"; guidance: string };
```

The routing engine applies the decision:

- `allow` → no mutation to `output.args`
- `modify` → replace `output.args` with the rewritten args
- `deny` → throw an error from `tool.execute.before`
- `context` → deliver once-per-session guidance through the routing layer

#### 6.1.3 Session-scoped guidance throttling

`context-mode` only emits its advisory guidance once per session so the model is
nudged without flooding the transcript with repeated routing instructions. This
plan should do the same.

The guidance throttle should be:

- keyed by the **canonical root session ID**, not the raw child session ID
- keyed by guidance type (`read`, `grep`, `bash`, etc.)
- held in local process state only; no FalkorDB round-trip is required
- shared across parent and child sessions in the same lineage because child work
  contributes to the same continuity stream

This preserves the intentional child-session model while still matching
`context-mode`'s once-per-session guidance behavior closely.

### 6.2 Tool classes in scope

Initial routing coverage must include at least:

- `Read`
- `WebFetch`
- `Bash`
- `Grep`
- `Glob`
- `Task`

Additional coverage may later expand to tools such as browser snapshots or other
large-payload integrations, but these six are the minimum alignment set.

### 6.3 Routing policy matrix

The following matrix defines the concrete routing policy for each tool in the
minimum set. Each row describes the argument conditions that trigger each
decision.

#### Summary matrix

| Tool       | Allow when                                             | Modify when                                  | Deny when                                                          |
| ---------- | ------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------ |
| `Read`     | Usually allow                                          | Never rewrite args by default                | Never hard deny by default; emit once-per-session guidance         |
| `WebFetch` | —                                                      | —                                            | Always hard deny and redirect to the safer context-mode-style path |
| `Bash`     | Allow by default                                       | Rewrite known bad patterns to safe guidance  | Hard deny only for explicit security/policy matches                |
| `Grep`     | Usually allow                                          | Never rewrite args by default                | Never hard deny by default; emit once-per-session guidance         |
| `Glob`     | Allow                                                  | Optionally scope `path` only if clearly safe | Avoid speculative rewrites; do not invent unsupported excludes     |
| `Task`     | Allow, but rewrite delegated prompt with routing block | Rewrite prompt field to append routing block | —                                                                  |

#### `Read` — detailed policy

```text
if tool is Read:
  → emit a once-per-session routing guidance block that nudges the agent toward
    the safer bounded/file-processing path
  → otherwise allow the native tool call to proceed unchanged
```

This follows `context-mode`'s OpenCode behavior more closely than silently
rewriting read limits. The goal is to change agent behavior at the source while
preserving the native tool contract unless a stricter block is truly necessary.

#### `WebFetch` — detailed policy

```text
if tool is WebFetch:
  → hard deny by throwing an error
  → denial guidance must redirect to the safer fetch/index/search flow rather
    than allowing raw page content into transcript
```

This is the clearest source-side prevention mechanism in `context-mode`'s
OpenCode plugin and should be copied directly.

#### `Bash` — detailed policy

```text
if command hits explicit security-policy deny pattern:
  → hard deny (same as context-mode security layer)

if command contains raw network patterns (`curl`, `wget`, inline HTTP clients):
  → modify command into a short guidance command that redirects to the safer
    fetch/index or sandbox-execute path

if command invokes high-volume build tools (`gradle`, `mvn`, wrappers):
  → modify command into a short guidance command that redirects to a safer
    sandboxed execution path

otherwise:
  → allow, but emit once-per-session routing guidance for Bash
```

**Design note:** `Bash` should follow `context-mode`'s actual OpenCode strategy:
pattern-based rewrites for the worst offenders, not an oversized allowlist plus
post-hoc truncation design.

**Ordering note:** the Bash policy should run in this order:

1. repo security-policy deny/ask checks
2. raw network rewrite checks (`curl`, `wget`, inline HTTP)
3. high-volume build-tool rewrite checks
4. once-per-session Bash guidance fallback
5. otherwise passthrough

This keeps security authoritative while preserving the same routing shape as
`context-mode`.

#### `Grep` — detailed policy

```text
if tool is Grep:
  → emit a once-per-session routing guidance block that nudges the agent toward
    safer bounded execution/search behavior
  → otherwise allow the native tool call to proceed unchanged
```

#### `Glob` — detailed policy

```text
if `path` is omitted:
  → allow (native tool already defaults to cwd)

if `pattern` is pathologically broad:
  → prefer guidance in docs/tests rather than speculative arg mutation

→ allow unless a future verified-safe rewrite exists
```

**Implementation note:** the native OpenCode `Glob` tool only accepts `pattern`
and optional `path`. It has no exclusion parameter, so this plan should not rely
on synthetic exclude rewrites.

#### `Task` — detailed policy

```text
detect prompt field (`prompt`, `request`, `objective`, `question`, `query`, or
`task`)
append a routing block to the delegated prompt
preserve `subagent_type` unless a validated future change is explicitly chosen
→ modify
```

**Rationale:** this follows `context-mode`'s actual delegated-prompt rewrite
mechanic while preserving this repo's child-session-first continuity model.

### 6.4 Guardrails against over-copying `context-mode`

This section documents where this repo **intentionally does not** follow
`context-mode`, even when the behavior looks similar:

1. **No SQLite local store.** `context-mode` uses SQLite for local state. This
   repo uses FalkorDB via Redis protocol. The routing engine must not assume
   SQLite-style queries or schema.
2. **No second LLM summarization pass.** `context-mode` may use an LLM to
   summarize tool output. This repo's hot tier is deterministic and
   programmatic. Summaries come from structured event extraction, not LLM calls.
3. **No flattened subagent events.** `context-mode` records subagent work as
   summarized tool events. This repo promotes child sessions to first-class
   participants in the root session (§11).
4. **No `<session_resume>` envelope.** This repo uses `<session_memory>` with
   its own section taxonomy (§9). The envelope shape is not a copy target.
5. **No external sandbox tools in Phase 1.** `context-mode` routes users toward
   its own custom tooling. This repo copies the pre-tool mechanics first without
   requiring the full tool ecosystem in the initial phase.
6. **Hard deny is supported by thrown errors.** This repo should follow
   `context-mode`'s OpenCode implementation and treat thrown errors in
   `tool.execute.before` as the authoritative deny mechanism.

### 6.5 User-facing denial behavior

When a tool call is denied, the plugin should return a concise actionable error
that explains the safer bounded path.

The goal is not just to block. It is to steer the agent toward the same safer
workflow that `context-mode` would have chosen.

Denial messages must:

- be ≤ 200 characters
- name the denied tool and the problematic argument
- suggest a concrete alternative (e.g. "Use Read with limit=200 instead")
- not include raw argument values that could themselves be large

Guidance messages should follow the same philosophy:

- concise enough to fit comfortably in a single tool result or prompt suffix
- specific about the safer path to take next
- stable across repeated runs so tests can assert against them

---

## 7 Short-Term Storage Layer

### 7.1 Storage decision

Short-term state remains in FalkorDB, accessed over the Redis protocol using the
existing `RedisClient` and canonical `redis.*` config.

There is **no new `falkordb.*` config section** in the revised plan.

`redis.*` remains canonical because:

- the transport is Redis-compatible
- the runtime already uses Redis-oriented primitives
- FalkorDB is the deployment choice behind that endpoint

### 7.2 Key layout

| Key                           | Type   | Purpose                                    |
| ----------------------------- | ------ | ------------------------------------------ |
| `session:{id}:events`         | List   | typed hot-tier continuity events           |
| `session:{id}:snapshot`       | String | compact snapshot XML                       |
| `memory-cache:{groupId}`      | String | cached Graphiti-derived recall             |
| `memory-cache:{groupId}:meta` | Hash   | cache query / refresh metadata             |
| `drain:pending:{groupId}`     | List   | queued semantic drain entries for Graphiti |
| `drain:dead:{groupId}`        | List   | dead-lettered drain entries                |

### 7.3 Invariant

FalkorDB is the hot-path system of record for:

- session continuity
- compact restore snapshots
- cached long-term memory projections
- pending async Graphiti consolidation work

Graphiti is never required for the current turn to proceed.

---

## 8 Revised Hot-Tier Data Contract

### 8.1 Event contract

The hot tier should continue using compact typed events rather than raw copied
transcripts, but the contract becomes stricter:

1. **pre-tool routing first**
2. **sanitize before extraction**
3. **extract compact typed events only**
4. **build conservative snapshot**
5. **inject stable canonical memory envelope**
6. **drain semantic episodes asynchronously**

### 8.2 Event policy

Keep:

- file paths
- search queries
- tool names
- exit/error signals
- explicit task/decision state
- terse subagent summaries
- concrete environment/git state

Reject as durable hot-tier memory:

- raw file contents from `Read`
- large shell/web transcripts
- wrapper tags like `<path>` / `<content>` when they come from replayed output
- assistant operational narration
- previously injected memory blocks
- verbose delegated reports

### 8.3 Snapshot policy

The snapshot should move even closer to `context-mode`'s priority-tiered style:

- P0/P1: last request, active tasks, user decisions, files in play, rules
- P2: unresolved blockers, environment, git state
- P3: subagent summaries, low-volume integration markers
- drop low-value residue aggressively under budget pressure

The point is resumability, not archival completeness.

---

## 9 Injection Strategy

The canonical injected shape remains:

```xml
<session_memory source="falkordb+graphiti-cache" version="1">
  <last_request>...</last_request>
  <active_tasks>...</active_tasks>
  <key_decisions>...</key_decisions>
  <files_in_play>...</files_in_play>
  <project_rules>...</project_rules>
  <unresolved_errors>...</unresolved_errors>
  <git_state>...</git_state>
  <subagent_work>...</subagent_work>
  <session_snapshot>...</session_snapshot>
  <persistent_memory node_refs="...">...</persistent_memory>
</session_memory>
```

This is intentionally different from `context-mode`'s resume envelope, but it
must be generated from the same style of compact typed state.

### 9.1 Important distinction

This plugin's injection layer is **not** the primary token-saving mechanism.

Under the revised plan, token savings come from two layers together:

1. **source-side prevention** via `tool.execute.before`
2. **compact continuity reinjection** via `<session_memory>`

Without the first layer, alignment remains incomplete.

---

## 10 Async Tier

The async tier remains structurally the same:

- Graphiti MCP drains semantic episodes in the background
- cache refreshes happen asynchronously on drift or after new facts land
- primers remain best-effort
- no Graphiti request may block a hot-path hook return

This is an intentional divergence from `context-mode`, not an alignment gap.

---

## 10A Hook Interaction Model

This section documents how the new `tool.execute.before` and
`tool.execute.after` hooks interact with the existing hook pipeline.

### 10A.1 Hook execution order (per user turn)

```text
1. chat.message
   → Prepare session state from FalkorDB.
   → Stage <session_memory> for injection.

2. experimental.chat.messages.transform
   → Inject <session_memory> into last user message.
   → LLM generates response (may include tool calls).

3. [For each tool call in the LLM response:]
    a. tool.execute.before          ← NEW: routing decision
      → allow / modify / deny the tool call args, with optional once-per-session guidance.
   b. [Native tool executes with (possibly modified) args.]
   c. tool.execute.after           ← continuity capture / metadata only
      → Observe resulting bounded tool activity.
   d. event (tool.called / tool.completed)
      → Extract compact SessionEvent from tool activity.
      → Store in FalkorDB via RedisEventsService.

4. event (message.updated)
   → Finalize assistant message as SessionEvent.

5. [If idle:] event (session.idle)
   → Drain pending events to Graphiti (async).
   → Rebuild snapshot.

6. [If compacting:] experimental.session.compacting
   → Inject <session_memory> into compaction context.
   → event (session.compacted) → async drain + snapshot rebuild.
```

### 10A.2 Data flow between hooks

| Producer hook            | Data produced                                   | Consumer hook                                                  |
| ------------------------ | ----------------------------------------------- | -------------------------------------------------------------- |
| `chat.message`           | Staged `<session_memory>` envelope              | `messages.transform`                                           |
| `tool.execute.before`    | Modified args / thrown deny / one-time guidance | Native tool execution, routed failure, or prompt/tool guidance |
| `tool.execute.after`     | Tool metadata for continuity capture            | `event` extraction / hot-tier state                            |
| `event` (tool.completed) | Compact `SessionEvent`                          | FalkorDB → snapshot → next `chat.message`                      |
| `session.compacting`     | Injected compaction context                     | OpenCode compaction summarizer                                 |

### 10A.3 Invariants across hooks

1. **No hook reads Graphiti synchronously.** This applies to the new hooks too.
2. **`tool.execute.before` must not call FalkorDB.** Routing decisions are pure
   functions of tool name and args. No Redis round-trip.
3. **No hook-level output rewriting is required for alignment.**
   `tool.execute.after` may remain metadata/event focused; token prevention
   should be achieved in `tool.execute.before`.
4. **Event extraction happens after tool execution or routed denial handling**,
   not during routing policy evaluation. `tool.execute.before` may cache compact
   routing metadata, but routed `SessionEvent`s are only emitted later through
   `tool.execute.after` and the existing event extraction pipeline.

---

## 11 Session Lifecycle and Child Sessions

### 11.1 Kept divergence

This repo continues to resolve child/subagent sessions to a canonical root
session and stores their work as first-class continuity events in the root
session state.

This diverges from `context-mode`, which summarizes subagent work more narrowly,
but the divergence remains intentional and in-scope.

### 11.2 Constraint on new routing logic

The new pre-tool routing layer must work correctly for both parent and child
sessions.

Specifically:

- routed decisions should be evaluated per live tool call regardless of lineage
- post-tool compact event extraction should still aggregate into the root
  session
- child session teardown must never delete canonical root continuity state

---

## 12 Configuration

Canonical config shape remains:

```jsonc
{
  "redis": {
    "endpoint": "redis://localhost:6379",
    "batchSize": 20,
    "batchMaxBytes": 51200,
    "sessionTtlSeconds": 86400,
    "cacheTtlSeconds": 600,
    "drainRetryMax": 3
  },
  "graphiti": {
    "endpoint": "http://localhost:8000/mcp",
    "groupIdPrefix": "opencode",
    "driftThreshold": 0.5
  }
}
```

### 12.1 Config decision

- `redis.*` stays canonical for the FalkorDB-backed hot tier
- `graphiti.*` stays canonical for async Graphiti integration
- legacy compatibility may remain temporarily in implementation if needed, but
  the plan no longer treats `falkordb.*` as a target configuration shape

---

## 13 File Changes

### 13.1 New files

```text
src/handlers/tool-before.ts      — OpenCode tool.execute.before hook handler
src/services/tool-routing.ts     — deterministic routing engine + per-tool policy functions
src/services/tool-guidance.ts    — shared once-per-session guidance blocks / routing text
src/services/tool-guidance-cache.ts — in-memory per-session guidance throttle keyed by canonical session
```

### 13.2 Modified files

```text
src/index.ts                     — register tool.execute.before; wire routing deps
src/handlers/event.ts            — extract compact events from routed tool activity (deny/modify/context signals)
src/handlers/chat.ts             — no structural change; continues local prep from FalkorDB state
src/handlers/messages.ts         — no structural change; continues canonical injection from local state
src/handlers/compacting.ts       — no structural change; continues local-only compaction injection
src/services/event-extractor.ts  — add extraction rules for routing denial/modification events
src/services/redis-snapshot.ts   — classify routing events as P2; tighten budget enforcement
src/session.ts                   — ensure routing hooks resolve canonical session ID for child sessions and guidance throttling
README.md                        — document source-side routing and updated hot-path mechanics
AGENTS.md                        — add tool.execute.before to hot-path section
docs/ContextOverhaulTests.md    — add Suite N (pre-tool routing) test cases
```

---

## 14 Implementation Phases

### Phase 1: Routing contract

**Scope:** `src/services/tool-routing.ts`, `src/services/tool-guidance.ts`

**Tasks:**

1. Implement the `tool.execute.before` deny path by throwing an error, matching
   `context-mode`'s OpenCode plugin (§5.2).
2. Define the `RoutingDecision` type (§6.1.2).
3. Implement the routing engine: dispatch by tool name, delegate to per-tool
   policy functions.
4. Implement once-per-session guidance for `Read`, `Grep`, and general `Bash`.
5. Implement hard deny for `WebFetch`.
6. Implement delegated prompt rewriting for `Task`.
7. Implement the guidance throttle keyed by canonical root session ID.
8. Write unit tests for the engine dispatch and the `RoutingDecision` type.

**Acceptance criteria:**

- [ ] `RoutingDecision` type exists and is exported.
- [ ] Routing engine accepts `(toolName: string, args: unknown)` and returns
      `RoutingDecision`.
- [ ] Policies exist for `Read`, `WebFetch`, `Bash`, `Grep`, `Glob`, `Task`.
- [ ] Hard deny uses thrown errors from `tool.execute.before`.
- [ ] Guidance is emitted at most once per canonical session lineage per type.
- [ ] `deno test` passes; `deno run build` passes; `deno task check` passes.

### Phase 2: Pre-tool hook wiring

**Scope:** `src/handlers/tool-before.ts`, `src/index.ts`

**Tasks:**

1. Create `tool-before.ts` handler that calls the routing engine and applies the
   decision to `output.args` or throws for deny.
2. Wire the hook in `src/index.ts` alongside the existing hooks.
3. Ensure the hook resolves the canonical session ID via `SessionManager` so
   child sessions are handled correctly.
4. Thread canonical session identity into the guidance throttle so parent and
   child sessions share the same once-per-session routing nudges.

**Acceptance criteria:**

- [ ] `tool.execute.before` hook is registered in the plugin return value.
- [ ] The hook fires for parent and child sessions.
- [ ] `tool.execute.before` does not call FalkorDB or Graphiti.
- [ ] Parent and child sessions share one guidance throttle namespace.
- [ ] `deno test` passes; `deno run build` passes; `deno task check` passes.

### Phase 3: Heavy-tool policies

**Scope:** `src/services/tool-routing.ts`, `src/services/tool-guidance.ts`

**Tasks:**

1. Implement the `Read` guidance policy per §6.3.
2. Implement the `WebFetch` policy per §6.3.
3. Implement the `Bash` policy per §6.3 with command-pattern rewrites and
   once-per-session guidance.
4. Implement the `Grep` and `Glob` policies per §6.3.
5. Implement the `Task` prompt-rewrite policy.
6. Write unit tests for each policy covering allow, modify, and deny cases.

**Acceptance criteria:**

- [ ] Each tool in the minimum set has ≥ 3 test cases (allow, modify, deny).
- [ ] `Read` emits guidance once per session and otherwise preserves native
      args.
- [ ] `WebFetch` is denied with actionable redirect guidance.
- [ ] `Bash` rewrites `curl`/`wget`/inline HTTP/build-tool patterns.
- [ ] Bash routing preserves the documented evaluation order from §6.3.
- [ ] `Grep` emits guidance once per session and otherwise preserves native
      args.
- [ ] `Glob` does not rely on unsupported exclusion args.
- [ ] `Task` rewrites delegated prompt text with routing instructions.
- [ ] `deno test` passes; `deno run build` passes; `deno task check` passes.

### Phase 4: Extraction tightening

**Scope:** `src/handlers/event.ts`, `src/services/event-extractor.ts`

**Tasks:**

1. Ensure `tool.called` and `tool.completed` events from routed tool calls
   extract only compact metadata (tool name, file path, exit code, summary).
2. Verify that `SessionEvent.body` never contains raw tool output.
3. Add extraction rules for the new `tool.execute.before` deny/modify/context
   signals so they appear as lightweight events.

**Acceptance criteria:**

- [ ] No `SessionEvent.body` exceeds 4 KB after routing is active.
- [ ] Denied tool calls produce a compact event with the denial reason.
- [ ] Modified/context-guided tool calls produce a compact event noting the
      routing action.
- [ ] `deno test` passes; `deno run build` passes; `deno task check` passes.

### Phase 5: Snapshot tightening

**Scope:** `src/services/redis-snapshot.ts`

**Tasks:**

1. Review snapshot builder against the P0–P3 tier definitions in §8.3.
2. Ensure routing-related events (denials, modifications, guidance nudges) are
   classified as P2 or P3 and dropped first under budget pressure.
3. Verify snapshot stays within `SNAPSHOT_BODY_BUDGET` with the new event types.

**Acceptance criteria:**

- [ ] Snapshot with 50+ events (including routing events) stays within budget.
- [ ] P0/P1 content (last request, active tasks, decisions) is never dropped.
- [ ] Routing denial events are classified as P2.
- [ ] `deno test` passes; `deno run build` passes; `deno task check` passes.

### Phase 6: Integration validation + documentation

**Scope:** tests, `README.md`, `docs/ContextOverhaulTests.md`, `AGENTS.md`

**Tasks:**

1. Add Suite N (pre-tool routing) to `docs/ContextOverhaulTests.md`.
2. Run the full test suite including new routing tests.
3. Update `README.md` to document source-side routing.
4. Update `AGENTS.md` hot-path section to include `tool.execute.before`.
5. Verify all alignment checklist items from §3.1.1.

**Acceptance criteria:**

- [ ] All §3.1.1 alignment criteria (A1–A8) are met.
- [ ] `deno test` passes; `deno run build` passes; `deno task check` passes;
      `deno lint` passes; `deno fmt --check` passes.
- [ ] `README.md` documents the pre-tool routing behavior.
- [ ] `AGENTS.md` lists `tool.execute.before` in the hot-path section.
- [ ] `docs/ContextOverhaulTests.md` includes Suite N with ≥ 10 test cases.

---

## 15 Validation Requirements

### 15.1 Required tests — Suite N (Pre-Tool Routing)

Add to `docs/ContextOverhaulTests.md` as Suite N:

| ID   | Test case                                                            | Tier        |
| ---- | -------------------------------------------------------------------- | ----------- |
| N-1  | `Read` with ordinary args passes through after guidance handling     | Unit        |
| N-2  | `Read` emits guidance once, then falls through                       | Unit        |
| N-3  | `WebFetch` throws hard deny with actionable guidance                 | Unit        |
| N-4  | `Bash` with `curl` rewrites to guidance command                      | Unit        |
| N-5  | `Bash` with inline HTTP rewrites to guidance command                 | Unit        |
| N-6  | `Bash` with build tool command rewrites to guidance command          | Unit        |
| N-7  | `Bash` with ordinary command emits guidance once, then falls through | Unit        |
| N-8  | `Grep` emits guidance once, then falls through                       | Unit        |
| N-9  | `Glob` with ordinary args passes through unchanged                   | Unit        |
| N-10 | `Task` appends routing block to delegated prompt                     | Unit        |
| N-11 | guidance throttle emits once per canonical root session              | Unit        |
| N-12 | child-session tool calls share the same guidance throttle            | Integration |
| N-13 | `Task` preserves child-session-first continuity model                | Integration |
| N-14 | `tool.execute.before` does not call FalkorDB                         | Unit        |
| N-15 | `tool.execute.before` fires for child session tool calls             | Integration |
| N-16 | Unknown tool name → allow (fail-open)                                | Unit        |

### 15.2 Required full-suite checks

Before merging any part of this plan:

- `deno test`
- `deno run build`
- `deno task check`
- `deno lint`
- `deno fmt --check`

### 15.3 Behavioral success criteria

The implementation is only considered successful when all of these are true:

1. large native tool outputs are materially reduced because the expensive call
   is prevented or bounded before execution
2. hot-tier memory no longer depends on observing large transcript dumps first
3. `<session_memory>` remains compact and deterministic
4. Graphiti remains fully async
5. FalkorDB remains the hot-tier storage backend through `redis.*`
6. child-session aggregation still works as designed
7. all §3.1.1 alignment criteria (A1–A8) are met
8. Suite N tests all pass

---

## 16 Tradeoffs

| Tradeoff                        | Impact                                                        | Mitigation                                                                                |
| ------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| More pre-tool blocking          | Some previously tolerated raw tool usage will now be rejected | Return clear actionable denial messages and safe bounded defaults                         |
| More policy complexity          | Routing adds maintenance cost                                 | Centralize all heuristics in `tool-routing.ts` and `tool-guidance.ts`                     |
| Not a full context-mode clone   | Some behavior still differs                                   | Alignment target is explicit: hot-path mechanics, not storage or session-lineage identity |
| Bounded results may omit detail | Some calls will return less raw data                          | Agent can make additional focused bounded calls when needed                               |

---

## 17 Confirmed Decisions

- The repo should move to **>=80% context-mode alignment on the hot path**.
- The key missing mechanic to copy is **pre-tool routing and source-side token
  prevention**.
- The storage layer remains **FalkorDB over the Redis protocol**.
- Canonical config remains **`redis.*` + `graphiti.*`** only.
- Graphiti remains **async-only**.
- Child sessions remain **first-class entries in root continuity state**.
- The hot tier remains **deterministic and programmatic**, not LLM-summarized.

---

## 18 Immediate Next Step

Implement Phase 1 first:

1. **Implement thrown-error deny** in `tool.execute.before`, matching
   `context-mode`'s OpenCode plugin.
2. **Define `RoutingDecision`** and the routing engine dispatch.
3. **Implement actual context-mode-aligned baseline policies** for `Read`,
   `WebFetch`, `Bash`, `Grep`, `Glob`, and `Task`.
4. **Write unit tests** for the engine and these baseline policies.
5. **Cleanly document any repo-specific divergence** only where required by the
   child-session model or FalkorDB storage boundary.
