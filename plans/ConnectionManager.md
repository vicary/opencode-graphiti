# Graphiti Connection Manager Refactor Plan

## Goal

Remove session-creation stalls caused by Graphiti connection setup by moving MCP
transport lifecycle management into a dedicated connection manager that starts
on plugin launch, stays alive for the process lifetime, reconnects
automatically, buffers requests while connecting, and transparently drops new
requests while offline so higher-level memory features fail open.

## Current Problem

- `src/index.ts` awaits `client.connect()` during plugin initialization.
- OpenCode appears to instantiate the plugin lazily on first real session use,
  so the first session pays the MCP connection warmup cost.
- Higher-level methods in `src/services/client.ts` mix transport lifecycle,
  retry logic, request execution, and response parsing in one class.
- Timeouts and disconnects are handled per call, but there is no separate
  always-on connection state machine.

## Target Design

Introduce a dedicated `GraphitiConnectionManager` layer under `src/services/`.

Responsibilities:

- Own the MCP `Client` and `StreamableHTTPClientTransport` lifecycle.
- Start connecting as soon as the plugin launches, without blocking hook
  registration.
- Maintain explicit connection state: `connecting`, `connected`, `offline`, and
  `closing`.
- Auto-reconnect after disconnect with exponential backoff (see
  [Reconnect Strategy](#reconnect-strategy)).
- Classify transport-level failures (session expiry, network errors, timeouts)
  internally so callers never inspect raw transport errors.
- Queue requests that arrive while state is `connecting`, subject to per-request
  deadlines.
- Reject requests that arrive while state is `offline` with a typed error,
  allowing higher-level APIs to degrade gracefully instead of stalling.
- Expose a readiness signal (`ready(): Promise<boolean>`) that resolves when the
  first connection succeeds or a caller-supplied timeout elapses, so
  first-message hooks can bound their wait.
- Expose a single request API for tool execution so `GraphitiClient` becomes a
  thin domain adapter.

Non-goals:

- No durable disk-backed queue.
- No guaranteed delivery while Graphiti is offline.
- No change to memory search, injection, or compaction semantics beyond their
  behavior during transport failure.

## Proposed Architecture

### 1. New connection-manager service

Create `src/services/connection-manager.ts` with:

- A connection-state union type:
  `"connecting" | "connected" | "offline" |
  "closing"`.
- A manager class that stores:
  - endpoint
  - MCP client instance
  - transport instance
  - current state
  - in-flight connect promise (serialized; see below)
  - bounded queue of pending requests created during `connecting`
  - reconnect backoff metadata (attempt count, next delay, timer handle)
  - a readiness `Promise<boolean>` that resolves on first successful connect or
    on a configurable startup timeout
- Methods:
  - `start()` — begin background connection on plugin launch; transitions
    immediately to `connecting`.
  - `stop()` — transition to `closing`, drain or reject queued requests, close
    the MCP client, cancel any pending reconnect timer, then become inert. After
    `stop()` all subsequent `callTool` calls reject immediately.
  - `ready(timeoutMs?)` — returns a promise that resolves `true` when the
    manager reaches `connected`, or `false` if the timeout elapses first.
    Callers such as first-message hooks can use this to bound their wait.
  - `callTool(name, args, deadlineMs?)` — route requests according to current
    state; accepts an optional per-request deadline.
  - `reconnect()` — rebuild client and transport after disconnect/session loss.
    Serialized: concurrent callers share a single in-flight attempt.

#### State behavior

- **`connecting`** — execute `client.connect()`. Incoming `callTool` requests
  are enqueued. Each queued request carries a per-request deadline (default:
  configurable, e.g. 15 s). If the deadline fires before the connection is
  established, the request rejects with a typed timeout error so hook flows do
  not hang indefinitely.
- **`connected`** — execute `callTool` immediately. If a call fails with a
  transport error (network reset, socket hang-up, etc.) or an MCP 404
  session-expiry error, the manager transitions to `connecting` and triggers a
  serialized reconnect. The failed request is retried once after the reconnect
  succeeds.
- **`offline`** — the manager enters this state when a connect or reconnect
  attempt fails after exhausting the current backoff step. Incoming `callTool`
  requests reject immediately with a typed offline error. A background reconnect
  timer continues with exponential backoff; on success the manager transitions
  back to `connected`.
- **`closing`** — entered by `stop()`. All queued requests are rejected. No new
  requests are accepted. The MCP client is closed and the reconnect timer is
  cancelled.

#### Failure classification

The connection manager owns all transport-error classification so that callers
never inspect raw error shapes:

- **Session expiry** — MCP error code 404. Action: rebuild client + transport,
  retry the request once.
- **Transport failure** — network errors, socket resets, connection refused,
  unexpected stream termination. Action: transition to `connecting`, trigger
  serialized reconnect.
- **Request timeout** — MCP error code -32001 or message matching
  `request timed out`. Action: surface to caller as a typed timeout error (no
  reconnect needed).

This keeps transport concerns encapsulated inside the connection manager.

#### Serialized reconnects

All reconnect triggers (failed requests, transport errors, backoff timer) funnel
through a single `reconnect()` path that deduplicates concurrent attempts. If a
reconnect is already in flight, additional callers await the same promise. This
prevents thundering-herd behavior when multiple concurrent requests fail
simultaneously.

#### Reconnect strategy

Auto-reconnect is mandatory, not optional. Use exponential backoff with jitter:

- Initial delay: 1 s.
- Max delay: 60 s.
- Multiplier: 2.
- Jitter: +/- 25%.
- Reset delay to initial on successful connect.

The backoff timer runs in `offline` state. On each tick the manager transitions
to `connecting` and attempts a reconnect. If the attempt fails, the manager
returns to `offline` with an increased delay.

### 2. Refactor GraphitiClient into a domain adapter

Update `src/services/client.ts` so it:

- Depends on the new connection manager instead of directly owning MCP transport
  state.
- Keeps response parsing and Graphiti-specific helpers such as `searchFacts`,
  `searchNodes`, `getEpisodes`, and `addEpisode`.
- Treats offline errors as soft failures for **read** operations by returning
  empty results and logging at warn/debug level.
- Treats offline errors as soft failures for **write** operations by logging and
  **re-throwing** the error so higher-level code can decide whether to retry. In
  particular, `SessionManager.flushPendingMessages` already re-queues messages
  on failure; silently dropping writes here would break that retry path. The
  connection manager's typed offline error makes it easy for callers to
  distinguish "server unreachable" from permanent failures.

### 3. Update plugin initialization and impacted files

**`src/index.ts`** — primary changes:

- Construct the connection manager first.
- Call `connectionManager.start()` without awaiting a full connect.
- Pass the manager into `GraphitiClient`.
- Optionally expose a cleanup hook that calls `connectionManager.stop()` if the
  plugin API supports lifecycle teardown.

**`src/session.ts`** — `SessionManager.flushPendingMessages` already re-queues
messages on `addEpisode` failure. No semantic change needed, but verify that the
new typed offline error propagates correctly through the catch block so the
re-queue path still triggers.

**`src/handlers/event.ts`** — calls `flushPendingMessages` and
`client.addEpisode` in session-idle and session-delete flows. These call sites
should continue to catch and log failures; no behavioral change beyond receiving
typed errors instead of raw transport errors.

**`src/handlers/chat.ts`** — calls `searchFacts`, `searchNodes` during memory
injection. These are read operations that already return empty on failure.
Optionally, the chat handler can call `connectionManager.ready(timeoutMs)`
before the first memory injection to avoid injecting empty context when the
connection is still warming up.

**`src/handlers/compacting.ts`** — calls `searchFacts` and `getEpisodes` via
`getCompactionContext`. Read-path only; same fail-open behavior as today.

**`src/services/client.ts`** — refactored as described in section 2.

### 4. Error model

Add typed internal errors or discriminators for:

- **offline** — request rejected because the manager is in `offline` or
  `closing` state.
- **queue-timeout** — request was queued during `connecting` but its per-request
  deadline elapsed before the connection was established.
- **transport-failure** — a connected call failed due to a network-level error
  (not a Graphiti application error); the manager is now reconnecting.
- **session-expired** — MCP 404; the manager is rebuilding the session.

These typed errors let `GraphitiClient` and `SessionManager` distinguish
transient transport problems from permanent failures without inspecting raw
error text.

### 5. Queue policy

Use a small bounded in-memory queue only for the `connecting` state.

- FIFO dispatch order.
- Cap queue length (e.g. 32) to avoid unbounded growth if many requests arrive
  during a slow connect.
- Each queued request carries a per-request deadline (default configurable, e.g.
  15 s). When the deadline fires, the request is removed from the queue and
  rejected with a `queue-timeout` error.
- When the queue is full, **drop the oldest entry** (reject it with a
  `queue-timeout` error) and enqueue the new request. Rationale: in a
  hook-driven system the most recent request is likelier to carry the most
  relevant context (e.g. the latest user message). Older queued requests are
  already stale by the time the connection recovers.

This preserves the requested semantics: buffering while connecting, but
rejecting requests when the manager is offline.

## Implementation Steps

1. Add `src/services/connection-manager.ts` with state machine, queue with
   per-request deadlines, serialized reconnect, exponential backoff, readiness
   signal, and typed error classes.
2. Refactor `src/services/client.ts` to delegate raw tool calls to the manager.
   Remove transport/session-expiry logic from `GraphitiClient`. Preserve
   write-error propagation for `addEpisode` so
   `SessionManager.flushPendingMessages` retry semantics are maintained.
3. Update `src/index.ts` to construct the connection manager, call `start()`
   without awaiting, and pass it into `GraphitiClient`.
4. Verify `src/session.ts` — confirm `flushPendingMessages` catch block handles
   the new typed offline error correctly (re-queue path).
5. Verify `src/handlers/event.ts`, `src/handlers/chat.ts`, and
   `src/handlers/compacting.ts` — confirm read-path fail-open behavior is
   unchanged. Optionally add `ready()` call in `chat.ts` before first memory
   injection.
6. Update tests in `src/services/client.test.ts` and add focused tests for the
   connection manager (see [Testing Plan](#testing-plan)).
7. Run `deno test`, `deno check src/index.ts`, and any relevant linting.

## Testing Plan

Add or update tests for:

- startup does not block on a successful or failed background connect
- `ready()` resolves `true` on successful connect, `false` on timeout
- requests issued during `connecting` are queued and later resolved
- queued requests that exceed their per-request deadline reject with
  `queue-timeout`
- requests issued during `offline` reject immediately with typed offline error
- mid-session transport disconnect triggers serialized reconnect and retries the
  failed request once
- expired-session (MCP 404) errors trigger one reconnect and one retry
- concurrent transport failures share a single reconnect attempt (no thundering
  herd)
- auto-reconnect backoff fires in `offline` state and transitions back to
  `connected` on success
- read APIs return empty collections on offline/timeout conditions
- write APIs (`addEpisode`) propagate offline errors so
  `SessionManager.flushPendingMessages` can re-queue
- queue-full policy drops oldest entry, not newest
- `stop()` transitions to `closing`, rejects queued requests, cancels reconnect
  timer

## Resolved Design Decisions

- **Auto-reconnect is mandatory.** The manager always runs exponential backoff
  in `offline` state. There is no "stay offline until explicit trigger" mode.
- **No `idle` state.** `start()` transitions directly to `connecting`. Before
  `start()` is called the manager does not exist; after `stop()` it is inert.
- **Write errors propagate to callers.** `addEpisode` failures (offline or
  otherwise) throw so that higher-level retry logic such as
  `SessionManager.flushPendingMessages` can re-queue. Read operations continue
  to fail open with empty results.

## Open Questions

- Exact default values for per-request deadline and queue capacity (proposed: 15
  s and 32; confirm during implementation).
- Whether `ready()` timeout should be configurable per call site or set once at
  construction.

## Expected Outcome

The first OpenCode session should no longer stall on Graphiti warmup. Graphiti
availability becomes a background concern managed by one process-wide transport
layer, while memory features continue to operate on a best-effort basis with
fast failure when the backend is unavailable.
