# Smoke Tests

- Status: Active
- Last Updated: 2026-05-10
- Replaces: historical native-hook-first test plan

This file, `docs/SmokeTests.md`, replaces the retiring
`docs/ContextOverhaulTests.md` and is now the authoritative validation manual
for the current MCP-first runtime.

## 1. Purpose and Authority

- This document is the active source of truth for runtime validation.
- It proves the current MCP-first architecture rather than the retired
  native-hook-first framing.
- It defines the current validation procedures, commands, evidence requirements,
  and pass/fail gates for runtime release readiness.

## 2. Runtime Guarantees Under Test

Later automated and live-runtime sections must reference the guarantees below by
identifier and prove them with explicit evidence.

### RG-1. `session_*` primary bounded execution surface

- Proof target: `session_*` is the primary bounded execution surface for
  data-heavy runtime work.
- Future proof sources: automated contract coverage, live delegation coverage,
  hook-enforcement evidence.

### RG-2. `session_batch_execute` ordering, boundedness, and typed results

- Proof target: `session_batch_execute` preserves mixed command/search step
  ordering, bounded execution behavior, and typed per-step results.
- Future proof sources: automated mixed-step contract tests, live mixed-workflow
  scenarios.

### RG-3. `session_index` logical-document replacement semantics

- Proof target: `session_index` replaces the prior logical document when the
  same `(rootSessionId, source, label)` tuple is indexed again.
- Future proof sources: automated replacement tests, live shared-corpus update
  scenarios.

### RG-4. Canonical root-session sharing across parent/child agents

- Proof target: parent and child agents share one canonical root-session
  continuity model and root-visible state.
- Future proof sources: automated lifecycle tests, live multi-agent scenarios.

### RG-5. Local-first bounded corpus behavior

- Proof target: indexing and search remain local-first, session-scoped, and
  bounded.
- Future proof sources: automated corpus/search tests, live retrieval flows.

### RG-6. Graphiti off the hot path

- Proof target: Graphiti augmentation remains asynchronous and never blocks
  hot-path correctness.
- Future proof sources: automated async/drain coverage, degraded live runs.

### RG-7. Optional bounded `<persistent_memory>` behavior

- Proof target: `<persistent_memory>` is optional, bounded, structured, and
  never a hot-path dependency.
- Future proof sources: automated cache-state coverage, live recall scenarios.

### RG-8. Compaction continuity

- Proof target: continuity survives compaction for both direct and delegated
  work.
- Future proof sources: automated compaction tests, live resume-after-
  compaction scenarios.

### RG-9. Restart and degradation boundaries

- Proof target: restart behavior, Redis/FalkorDB degradation, Graphiti
  degradation, and combined-backend boundaries behave according to active safe
  runtime expectations.
- Future proof sources: automated recovery/degradation coverage, live degraded
  scenarios where safely reproducible.

## 3. Test Environment and Operators

This section defines the baseline environment assumptions for every later
automated suite and live runtime scenario.

### 3.1 Required services and default configuration assumptions

- **Hot-path store:** Redis/FalkorDB is the default required local store at
  `redis://localhost:6379`.
- **Async tier:** Graphiti MCP is the default optional long-term-memory service
  at `http://localhost:8000/mcp`.
- **Default config assumptions:** unless a scenario explicitly overrides them,
  use the repository defaults documented in `README.md` and `AGENTS.md`:
  - `redis.endpoint = redis://localhost:6379`
  - `redis.batchSize = 20`
  - `redis.batchMaxBytes = 51200`
  - `redis.sessionTtlSeconds = 86400`
  - `redis.cacheTtlSeconds = 600`
  - `redis.drainRetryMax = 3`
  - `graphiti.endpoint = http://localhost:8000/mcp`
  - `graphiti.groupIdPrefix = opencode`
  - `graphiti.driftThreshold = 0.5`
- **Architecture boundary assumption:** hot-path correctness must rely only on
  Redis/FalkorDB-backed local state. Graphiti must remain off the hot path and
  is validated as an asynchronous background dependency only.
- **Delegation continuity assumption:** child sessions resolve to the canonical
  root session via the `parentID` chain, child events are recorded in the root
  event log, and parent/child activity must appear in the same
  `<memory version="2">` continuity model.
- **Degraded variants allowed by design:**
  - Graphiti may be unavailable for local-only or degraded-mode coverage; the
    plugin is still expected to operate with Redis/FalkorDB-backed session
    memory and without `<persistent_memory>` augmentation.
  - Redis/FalkorDB unavailability is a separate degradation case. Tests that
    claim persistence, compaction survival across turns, shared root-session
    state, or cache-backed recall must not treat an in-memory fallback run as
    equivalent proof of the default persisted path.

### 3.2 Runtime and operator assumptions

- Automated verification assumes the current repository checkout and the
  repository's existing Deno-based test/task entrypoints once those commands are
  specified in later sections.
- Live verification assumes a real OpenCode runtime with this plugin loaded and
  with delegation available to a root agent plus child agents inside the same
  canonical runtime model.
- No separate pinned service-version matrix is defined in this section. The
  operator must use the current repository-supported runtime and the default
  local service topology above unless a scenario explicitly states an override.
- When a scenario exercises compaction, idle drain, or post-compaction refresh,
  the operator must allow the runtime to reach those states naturally rather
  than substituting mocked hook calls as primary proof.

### 3.3 Artifact capture locations

- **Runtime-resident artifacts and state evidence** are captured from the same
  local stores the product uses:
  - Redis/FalkorDB at `redis://localhost:6379` for session events, snapshots,
    memory cache, and pending drain batches.
  - Graphiti MCP at `http://localhost:8000/mcp` for async-tier availability and
    drain/cache-refresh observations when Graphiti-backed behavior is under
    test.
- **Operator-managed evidence bundles** must be recorded for each run in a
  single run-scoped location chosen before execution and named in the scenario
  notes. That bundle is where copied command output, `session_*` tool responses,
  relevant logs, and copied `<memory version="2">` or optional
  `<persistent_memory>` excerpts are retained.
- Later sections may define per-scenario filenames, but every scenario must say
  both where the operator-kept evidence bundle lives and which runtime store is
  the source of truth for any claimed state observation.

### 3.4 Operator roles

- **`human operator`**: starts and stops required services, launches the root
  session, issues scripted prompts when manual triggering is required, and
  records or exports the evidence bundle for the run.
- **`root agent`**: receives the primary task, drives the main workflow, and
  delegates work to child agents while remaining accountable for root-session
  continuity.
- **`child agent`**: executes delegated work inside the same canonical runtime
  model; its events, indexed content, and continuity effects must roll up to the
  root session rather than forming an isolated proof path.
- **`observer/evidence collector`**: captures logs, tool results, transcripts,
  and state observations for the scenario. This role may be filled by the human
  operator or by a separate agentic step, but the scenario must name who owns
  evidence capture.

### 3.5 CI-runnable versus live-runtime-only boundaries

- **CI-runnable coverage**: automated suites that verify bounded `session_*`
  contracts, ordering and typed-result behavior, indexing/replacement semantics,
  cache and degradation logic, and other repo-driven checks that can run through
  the repository test harness without requiring a live delegated operator
  session.
- **Live-runtime-only coverage**: any proof that depends on real OpenCode
  delegation, a root agent with child agents, emitted live
  `<memory version="2">` continuity, compaction survival across delegated work,
  runtime routing/enforcement behavior, or human-observed degraded-service
  recovery.
- **Hard boundary:** CI and mocked/unit coverage support the release argument
  but do not replace the mandatory live multi-agent runtime scenarios required
  by this plan.
- **Allowed split:** when a degradation boundary is unsafe or impractical to
  reproduce in a live operator session, the later scenario or matrix entry must
  say that the proof remains automated-only and justify the exception
  explicitly.

## 4. Evidence Model

Release claims in §§5-8 are valid only when the run bundle contains the
mandatory evidence classes applicable to the claim being made. If a scenario or
suite claims live runtime proof, the evidence must show what the runtime did,
what state changed, and what the next-turn continuity surface emitted.

### 4.1 Mandatory evidence classes

| Evidence class                                                                        | Mandatory when                                                                                                               | Minimum proof required                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scripted prompts and operator actions                                                 | Any live scenario                                                                                                            | Exact root prompt, child prompts or delegated instructions, and any manual operator action that changes service availability, compaction timing, or restart state. |
| Command output                                                                        | Any suite or scenario that claims shell/runtime behavior                                                                     | The exact bounded command output or saved artifact ref for each command whose result is part of the claim.                                                         |
| `session_*` tool responses                                                            | Any suite or scenario that claims MCP-first runtime behavior                                                                 | Raw bounded responses for each relevant `session_*` call, including typed batch results, refs, metadata, warnings, and failure shapes where applicable.            |
| Emitted `<memory version="2">` envelopes                                              | Any claim about continuity, compaction survival, delegated roll-up, or omission/presence behavior                            | The next-turn injected envelope or equivalent prompt/log export showing the continuity surface actually emitted by the runtime.                                    |
| Emitted `<persistent_memory>` section with surrounding `<memory version="2">` context | Any claim about Graphiti-backed recall, presence/omission, bounded formatting, stale-cache handling, or cross-session recall | The full surrounding `<memory version="2">` block, not an isolated excerpt, so operators can verify presence, omission, bounded structure, and additive behavior.  |
| Redis/FalkorDB state observations                                                     | Any claim about root-session sharing, local corpus state, compaction persistence, restart recovery, or hot-tier degradation  | Direct store observations, exported state snapshots, or repo-supported inspection output tied to the same run and root session.                                    |
| Graphiti cache/drain observations                                                     | Any claim about async drain, cache refresh, stale-cache handling, later recall, or Graphiti degradation                      | Cache metadata, drain logs, warning output, doctor/status results, or equivalent runtime observations showing Graphiti activity stayed off the hot path.           |
| Logs and warnings                                                                     | Any degraded, restarted, denied, or policy-enforced path                                                                     | Relevant warnings, denial text, routing guidance, reconnect logs, or health output that explain what degraded or was enforced.                                     |
| Screenshots or copied transcript excerpts                                             | Only when another class cannot capture the UI/runtime surface cleanly                                                        | Supplemental only; include them only alongside the underlying tool/log/state evidence they illustrate.                                                             |

### 4.2 Anti-evidence rules

The following do **not** count as sufficient proof on their own:

- mocked child-session routing;
- passing unit tests alone;
- synthetic hook invocation alone;
- transcript claims without corresponding tool, log, or state evidence when
  runtime proof is being claimed.

Additional proof rules:

- A live PASS claim requires the relevant `session_*` responses **plus** at
  least one corroborating state or envelope class from §4.1.
- A continuity or recall PASS claim requires the emitted envelope evidence, not
  just a model-generated summary of what it "remembered."
- A degradation PASS claim requires explicit degraded-state evidence (warnings,
  doctor output, or state observations), not silence plus continued task output.
- Screenshots and copied transcript snippets are illustrative only; they do not
  replace raw tool, log, or state evidence.

### 4.3 Evidence retention and run-bundle minimum

Each automated suite run or live scenario run must retain one run-scoped bundle
containing, at minimum:

- the suite command or exact live prompt sequence;
- all relevant `session_*` responses or saved refs;
- the required envelope/log/state evidence for the guarantees being claimed;
- a short operator note for any intentional exception, degraded topology, or
  automated-only justification used by the release packet.

## 5. Automated Verification Matrix

This matrix documents the **expected automated verification commands and
procedures for future test execution**. This documentation task does **not** add
new test files, helper harnesses, or runtime-test implementation. By default,
automated coverage must run through the repository's existing `deno test`
surfaces plus the existing repository health tasks in `deno.json`
(`deno task check`, `deno task lint`, `deno task fmt`). Any additional helper
harness, benchmark runner, or custom test task must be justified explicitly in
the change that introduces it; do not assume one here, and do not invent a new
`deno task test` alias.

### 5.1 Suite A — Per-tool `session_*` contract coverage

- **Objective:** Prove that every public `session_*` tool remains registered,
  schema-valid, bounded, and attributable through the MCP-first runtime.
- **Prerequisites:** Current workspace checkout; Deno available; use repository
  defaults from §3.1. Redis-backed and degraded/in-memory cases are both in
  scope where existing tests already model them.
- **Exact commands:**

  ```bash
  deno test src/services/session-mcp-runtime.test.ts src/services/session-executor.test.ts src/services/session-corpus.test.ts src/services/session-notes.test.ts src/index.test.ts
  deno task check
  ```

- **Expected result:** PASS. Coverage must include each public tool:
  `session_execute`, `session_execute_file`, `session_batch_execute`,
  `session_index`, `session_search`, `session_fetch_and_index`, `session_stats`,
  `session_doctor`, `session_notes_write`, and `session_notes_read`. Public
  note/search coverage must prove the root-session identity is derived from the
  runtime session context rather than accepted as a caller argument. Note-tool
  coverage must prove explicit write outcomes (`created`, `replaced`,
  `deleted`), delete-on-miss no-op success returning
  `{ action: "deleted", id
  }`, exact single-note reads via
  `session_notes_read({ id })`, `{ note: null }` for unknown ids, and
  status-less response shapes. Non-empty `session_notes_write` calls that would
  make the eventual `session_notes_read` JSON exceed the shared 32 KB serialized
  response budget must be rejected before storage, while delete operations with
  empty text remain valid.
- **Artifacts/evidence to save:** Full `deno test` output; failing test names if
  any; bounded serialized examples for each tool response; any type-check output
  from `deno task check`.
- **Common failure signatures:** Missing tool registration; schema drift;
  acceptance of caller-supplied `root_session_id`; placeholder or shape-invalid
  responses; type drift between schemas and runtime handlers.
- **Release-gate severity:** Critical.

### 5.2 Suite B — Explicit `session_batch_execute` mixed command/search ordering, boundedness, and typed-result coverage

- **Objective:** Prove that `session_batch_execute` preserves request order for
  mixed command and search steps, returns typed per-step results, and keeps the
  combined response bounded.
- **Prerequisites:** Same as Suite A. No hidden parallelism is allowed in v1.
- **Exact commands:**

  ```bash
  deno test src/services/session-mcp-runtime.test.ts src/services/session-executor.test.ts
  deno task check
  ```

- **Expected result:** PASS. Mixed `steps` and legacy command-only `commands`
  inputs both remain valid; command and search step results remain
  distinguishable by kind; later steps stay in original order after earlier
  steps complete or fail; oversized sub-results spill to local refs rather than
  inflating the combined transcript payload.
- **Artifacts/evidence to save:** Full test output; any serialized batch result
  fixture emitted by the tests; proof of mixed-step ordering assertions.
- **Common failure signatures:** Search steps coerced into command-shaped
  results; reordered results; hidden parallelism; concatenated raw output;
  response budget overflow; legacy `commands` compatibility broken.
- **Release-gate severity:** Critical.

### 5.3 Suite C — Bounded output and artifact spillover

- **Objective:** Prove that large command, file, fetch, and batch outputs stay
  bounded at the tool surface and spill to local artifact/corpus storage instead
  of entering the transcript unbounded.
- **Prerequisites:** Same as Suite A.
- **Exact commands:**

  ```bash
  deno test src/services/session-mcp-runtime.test.ts src/services/session-executor.test.ts src/services/session-corpus.test.ts
  deno task check
  ```

- **Expected result:** PASS. Tool responses stay within the locked response
  budget, set truncation metadata when applicable, and produce searchable local
  refs for oversized content.
- **Artifacts/evidence to save:** Full test output; any reported artifact refs,
  corpus refs, truncation flags, byte counters, and bytes-saved metrics.
- **Common failure signatures:** Oversized inline payloads; missing artifact
  refs; duplicate full-body storage; truncated content not surfaced in metadata;
  raw output concatenated into batch summaries.
- **Release-gate severity:** Critical.

### 5.4 Suite D — Local corpus and session-note search, ranking, and bounded retrieval semantics

- **Objective:** Prove local-first corpus behavior plus session-note recall,
  including indexing, lexical retrieval, note-hit merging, freshness-aware
  ranking, snippet boundedness, and durable note persistence without TTL expiry.
- **Prerequisites:** Same as Suite A. Graphiti must remain irrelevant to PASS
  for this suite because local corpus behavior is a hot-tier proof target.
- **Exact commands:**

  ```bash
  deno test src/services/session-corpus.test.ts src/services/session-mcp-runtime.test.ts src/services/session-notes.test.ts src/services/redis-client.test.ts
  deno task check
  ```

- **Expected result:** PASS. The small-corpus ranking baseline holds, snippets
  are bounded, partial-string/fuzzy/stemming/proximity behaviors remain covered
  in the local corpus tests, and `session_search` can merge matching pinned-note
  hits with `type: "note"` plus `id`, `root_session_id`, and
  `scope: "local" | "project"`. Each note hit includes `created_at` and
  `updated_at` timestamps. `session_notes_read` can reopen exact note text from
  a note `id` and records a `last_read_at` timestamp for freshness scoring.
  Same-project foreign note hits rank by freshness rather than a flat locality
  penalty (local tie-break only applies when scores are effectively equal).
  Session notes persist in Redis without a TTL until explicitly deleted.

  Required note-specific evidence:
  - Session notes persist without TTL expiry until explicitly deleted.
  - `session_search` note hits include `created_at` and `updated_at`.
  - Same-project sessions can delete obsolete note ids from earlier sessions
    without being blocked by ownership checks on the delete path.
  - Reopening a note through `session_notes_read` contributes to read freshness,
    which can keep an older but useful note competitive in later searches.
- **Artifacts/evidence to save:** Full test output; any asserted corpus refs,
  snippets, note-hit metadata including timestamps, exact note-read assertions,
  and freshness ranking evidence.
- **Common failure signatures:** Wrong top-ranked corpus for the baseline query;
  flat unstructured retrieval; missing `type: "note"` / `id` / `root_session_id`
  / `scope` metadata for pinned-note hits; missing `created_at` or `updated_at`
  on note hits; TTL set on session-local note hash; foreign-session delete
  rejected on the delete path; read freshness not updating `last_read_at`;
  project-scoped note hits outranking equivalent local hits when scores are
  genuinely equal; snippet overflow; search behavior depending on Graphiti
  availability.
- **Release-gate severity:** Critical.

### 5.5 Suite E — Explicit `session_index` replacement semantics for the same `(rootSessionId, source, label)` logical document

- **Objective:** Prove that re-indexing the same logical document replaces prior
  searchable state rather than appending duplicates.
- **Prerequisites:** Same as Suite A. Tests must exercise both corpus-level and
  runtime-level pass-through behavior.
- **Exact commands:**

  ```bash
  deno test src/services/session-corpus.test.ts src/services/session-mcp-runtime.test.ts
  deno task check
  ```

- **Expected result:** PASS. Re-indexing with the same root session plus
  `source`/`label` removes prior postings and metadata, makes only the new
  content discoverable, and leaves no duplicate logical-document state behind.
- **Artifacts/evidence to save:** Full test output; previous and replacement
  corpus refs where exposed; search assertions showing old content absent and
  new content present.
- **Common failure signatures:** Old content still searchable; duplicate corpus
  manifests for one logical document; postings for replaced content left behind;
  runtime failing to pass `source`/`label` through to the corpus layer.
- **Release-gate severity:** Critical.

### 5.6 Suite F — `<persistent_memory>` cache-hit, cold-cache, refresh, omission, and stale-data behavior

- **Objective:** Prove that optional `<persistent_memory>` behavior is
  cache-only, state-dependent, bounded, and never required for current-turn
  correctness.
- **Prerequisites:** Same as Suite A. Where tests exercise cached
  Graphiti-backed data, they must still prove that cold-cache or stale-cache
  cases degrade to local-first `<memory version="2">` continuity rather than
  failing the hot path.
- **Exact commands:**

  ```bash
  deno test src/handlers/messages.test.ts src/handlers/chat.test.ts src/services/redis-cache.test.ts src/services/hot-tier-slice.test.ts src/services/graphiti-async.test.ts
  deno task check
  ```

- **Expected result:** PASS. Coverage must include cache hit, cold cache,
  refresh scheduling, omission when unavailable, and stale-data handling where
  the current turn still injects the best local/cached envelope while refresh is
  deferred.
- **Artifacts/evidence to save:** Full test output; representative emitted
  `<memory version="2">` envelopes with and without `<persistent_memory>`; cache
  metadata observations; refresh scheduling assertions.
- **Common failure signatures:** `<persistent_memory>` required on cold start;
  synchronous Graphiti dependency introduced on the hot path; stale memory not
  scrubbed or superseded; cache refresh clobbering unrelated metadata; missing
  omission behavior when Graphiti is unavailable.
- **Release-gate severity:** Critical.

### 5.7 Suite G — Root-session propagation and lifecycle

- **Objective:** Prove canonical root-session sharing across parent/child work,
  temporary-root handling, child deletion safety, and runtime lifecycle/teardown
  correctness.
- **Prerequisites:** Same as Suite A.
- **Exact commands:**

  ```bash
  deno test src/session.test.ts src/handlers/tool-before.test.ts src/services/session-corpus.test.ts src/services/session-mcp-runtime.test.ts src/index.test.ts src/services/runtime-teardown.test.ts
  deno task check
  ```

- **Expected result:** PASS. Child and parent activity shares one canonical root
  namespace for corpus and continuity state; temporary-root migration behavior
  remains safe; deleting a child session does not delete root-owned state;
  root-session note state migrates with canonical-root repair; runtime teardown
  disposes owned resources exactly once.
- **Artifacts/evidence to save:** Full test output; any asserted canonical root
  IDs, migrated namespace refs including session-note state, teardown/dispose
  assertions, and child-deletion safety evidence.
- **Common failure signatures:** Child-local instead of root-local state;
  mismatched `root_session_id` accepted; orphaned provisional-root keys;
  duplicate teardown calls; child deletion removing root-owned artifacts;
  session notes stranded under the provisional root after canonicalization.
- **Release-gate severity:** Critical.

### 5.8 Suite H — Hook enforcement and attribution

- **Objective:** Prove that hooks remain secondary enforcement and attribution
  layers that steer risky native-tool usage toward `session_*` without becoming
  the primary execution engine.
- **Prerequisites:** Same as Suite A.
- **Exact commands:**

  ```bash
  deno test src/handlers/tool-before.test.ts src/handlers/tool-after.test.ts src/services/tool-routing.test.ts src/handlers/event.test.ts
  deno task check
  ```

- **Expected result:** PASS. `session_*` calls rely on canonical root-session
  resolution from runtime context rather than caller-supplied `root_session_id`;
  risky native tools such as `WebFetch` are denied or guided toward the correct
  `session_*` replacement; `Task` guidance remains MCP-first;
  `tool.execute.after` stays attribution-only.
- **Artifacts/evidence to save:** Full test output; routing outcome assertions;
  denial/guidance messages; attribution metadata assertions.
- **Common failure signatures:** Native-tool-first drift; missing root
  injection; `tool.execute.after` rewriting output bodies; `Task` guidance
  omitting `session_*` preference; risky native tools allowed without
  enforcement.
- **Release-gate severity:** Critical.

### 5.9 Suite I — Continuity assembly and compaction survival

- **Objective:** Prove that `session_*` activity folds into local continuity,
  `<memory version="2">` assembly stays deterministic, and continuity survives
  compaction.
- **Prerequisites:** Same as Suite A.
- **Exact commands:**

  ```bash
  deno test src/session.test.ts src/handlers/chat.test.ts src/handlers/messages.test.ts src/handlers/compacting.test.ts src/handlers/event.test.ts src/services/session-snapshot.test.ts src/services/hot-tier-slice.test.ts
  deno task check
  ```

- **Expected result:** PASS. Local continuity sections and snapshots are
  assembled from hot-tier state, optional cached `<persistent_memory>` is
  additive only, stale envelopes are scrubbed, normal chat-turn injection omits
  `<session_notes>`, compaction-only injection includes complete pinned note
  bodies inside `<session_notes source="note_tools">` from the current root
  session only (same-project foreign-session note bodies are excluded), and
  compaction preserves continuity for both direct and delegated work.
- **Artifacts/evidence to save:** Full test output; representative emitted
  `<memory version="2">` blocks with and without `<session_notes>` as
  applicable; compaction-hook assertions; snapshot-related assertions.
- **Common failure signatures:** Missing or duplicated `<memory version="2">`
  injection; compaction losing `session_*` continuity; stale envelopes left in
  message bodies; notes injected on ordinary chat turns; compaction omitting or
  pre-summarizing pinned note bodies; foreign same-project note bodies being
  injected or promoted into compaction; Graphiti moved onto the synchronous
  path.
- **Release-gate severity:** Critical.

### 5.10 Suite J — Async Graphiti drain and cache refresh

- **Objective:** Prove that Graphiti augmentation remains asynchronous, drain
  batching/retry behavior stays correct, and cache refreshes coalesce without
  blocking hot-path work.
- **Prerequisites:** Same as Suite A. Graphiti-backed tests may use fakes or
  stubs already present in the repo's test suite, but no new helper harness is
  assumed here.
- **Exact commands:**

  ```bash
  deno test src/services/graphiti-async.test.ts src/services/batch-drain.test.ts src/services/redis-cache.test.ts src/services/hot-tier-slice.test.ts src/services/graphiti-mcp.test.ts src/services/connection-manager.test.ts
  deno task check
  ```

- **Expected result:** PASS. Drain retries and dead-letter handling remain
  bounded, same-group refreshes coalesce correctly, latest queued query wins
  after in-flight refreshes, and Graphiti connectivity problems do not block
  local correctness.
- **Artifacts/evidence to save:** Full test output; drain/retry assertions;
  cache refresh ordering assertions; degraded Graphiti connectivity assertions.
- **Common failure signatures:** Synchronous Graphiti dependency; overlapping or
  lost refreshes; retries not bounded; dead-letter handling broken; cache
  updates committed for the wrong query.
- **Release-gate severity:** Critical.

### 5.11 Suite K — Restart, recovery, and degradation

- **Objective:** Prove safe degraded startup/runtime behavior for Redis,
  Graphiti, and combined-backend failures, plus clean recovery and resource
  teardown expectations.
- **Prerequisites:** Same as Suite A.
- **Exact commands:**

  ```bash
  deno test src/index.test.ts src/services/session-mcp-runtime.test.ts src/services/runtime-teardown.test.ts src/services/redis-client.test.ts src/services/connection-manager.test.ts
  deno task check
  ```

- **Expected result:** PASS. Graphiti-unavailable cases continue without
  `<persistent_memory>`; Redis-unavailable cases degrade to the documented
  in-memory hot-tier fallback; warnings are emitted; startup does not fail
  closed when a safe degraded mode is available; teardown remains idempotent.
- **Artifacts/evidence to save:** Full test output; warning/log assertions;
  degraded `session_doctor` assertions; teardown idempotency assertions.
- **Common failure signatures:** Startup aborts instead of degrading; warning
  paths missing; degraded states misreported as healthy; teardown leaks or
  double dispose; restart/reinitialization reuses stale process-local state
  incorrectly.
- **Release-gate severity:** Critical.

### 5.12 Suite L — Regression thresholds for payload size, latency, and storage growth

- **Objective:** Hold the automated suite to explicit regression thresholds for
  bounded payload size, hot-path-friendly latency behavior, and local-storage
  growth discipline.
- **Prerequisites:** Same as Suite A. Threshold assertions should be colocated
  in the existing runtime/corpus/async/degradation test files rather than moved
  into a new harness by default. If a future change proposes a dedicated
  benchmark or helper harness, that change must justify why the existing
  `deno test` surfaces are insufficient.
- **Exact commands:**

  ```bash
  deno test src/services/session-mcp-runtime.test.ts src/services/session-corpus.test.ts src/services/session-executor.test.ts src/services/graphiti-async.test.ts src/services/batch-drain.test.ts src/index.test.ts scripts/bench-falkordb.test.ts
  deno task check
  deno task lint
  ```

- **Expected result:** PASS. At minimum, automated coverage must continue to
  enforce the locked 32 KB bounded-response budget, artifact spillover rules,
  bytes saved/accounting expectations, and no-unbounded-growth invariants
  already owned by the runtime and corpus tests. `session_notes_read` remains
  under the normal runtime guard, so accepted notes must stay readable within
  that shared limit. Any future latency or storage-growth numeric threshold
  added to the suite must be asserted in these existing test surfaces unless a
  separately justified harness is approved.
- **Artifacts/evidence to save:** Full test output; any serialized payload-size
  assertions; corpus/artifact/stats counters relevant to storage growth; any
  threshold-failure logs added in future colocated tests.
- **Common failure signatures:** Response budget regressions; storage-key family
  proliferation outside the locked namespace; duplicate full-body storage;
  threshold assertions added only to ad hoc scripts without documented
  justification; future latency thresholds measured outside `deno test` without
  an explicit exception note.
- **Release-gate severity:** High.

## 6. Live Agentic Runtime Scenarios

This section is mandatory live proof. Mocked child-session routing, synthetic
hook calls, and passing unit tests remain supporting evidence only and do not
replace these runs.

Unless a scenario explicitly declares an exception, use this default topology:

- `human operator`: starts/stops services, issues the scripted root prompts, and
  owns the run log.
- `root agent`: receives the scenario prompt and delegates work.
- `child agent A` and `child agent B`: execute delegated work inside the same
  canonical root session.
- `observer/evidence collector`: copies prompts, `session_*` responses,
  warnings, and emitted `<memory version="2">` / optional `<persistent_memory>`
  evidence into one run-scoped bundle.

For every scenario below, save evidence in one operator-chosen run bundle such
as `artifacts/live/<run-id>/` or an equivalent external bundle. Each scenario
must capture, at minimum, the root prompt, delegated child prompts, all relevant
`session_*` responses, any routing/warning text, and the next root-turn memory
envelope or equivalent prompt-body/log export when the runtime exposes it.

### 6.1 Scenario L1 — Fully concrete two-child parallel investigation with root-session continuity roll-up

- **Objective:** Prove live delegated work uses one canonical root session,
  child `session_index` / `session_search` effects are visible across children,
  and the next root turn rolls child activity into one continuity model.
- **Guarantees covered:** RG-1, RG-2, RG-4, RG-5.
- **Topology:** one `root agent`; two children launched in parallel; one
  `observer/evidence collector`.
- **Preconditions:** Redis/FalkorDB available; Graphiti may be either available
  or unavailable because this scenario does not require `<persistent_memory>`.
- **Exact operator prompt to the root agent:**

  ```text
  Live smoke scenario L1. Spawn exactly two child agents in parallel and keep all work in this workspace.

  Child agent A prompt:
  Use `session_index` to add this exact text to the shared root-session corpus with `source="live-smoke-L1"` and `label="parallel-note"`:
  "Sentinel ALPHA-ROOT-17: child indexing completed; owner=root-session; proof=parallel-rollup."
  Then run `session_search` for `ALPHA-ROOT-17` and return the bounded result plus any corpus or chunk refs.

  Child agent B prompt:
  Use `session_batch_execute` once with ordered steps:
  1. command: `pwd`
  2. search: `ALPHA-ROOT-17`
  Report whether step 2 can see child agent A's indexed note. Do not use native `WebFetch`, raw `curl`, or unbounded file dumps.

  After both children finish, summarize what each child observed and whether the runtime behaved like one shared root session.
  ```

- **Observer actions:**
  1. Save the exact root prompt.
  2. Save both child prompts as sent by the root agent.
  3. Save child A's `session_index` response and child A's `session_search`
     response.
  4. Save child B's raw `session_batch_execute` response, including per-step
     ordering and typed results.
  5. Immediately ask the root agent a follow-up prompt:
     `What sentinel did the
     delegated work add, and which child proved cross-child visibility?`
  6. Save the next root-turn `<memory version="2">` envelope or equivalent
     injected prompt/log export.
- **Expected runtime observations:**
  - child A indexes `ALPHA-ROOT-17` under the canonical root session;
  - child B's search step can see `ALPHA-ROOT-17` without re-indexing it;
  - the root follow-up answer names both child actions without the operator
    restating them;
  - the next root-turn continuity evidence contains child-derived activity in
    one shared root-session model.
- **Pass interpretation:** PASS only if all four observations above hold and no
  child is isolated into a child-local corpus or continuity branch.
- **Fail interpretation:** FAIL if child B cannot search child A's content, if
  the root cannot answer the follow-up from preserved continuity, if the batch
  result order is not command-then-search, or if the evidence shows different
  root-session identities for parent and children.
- **Likely fault domains on failure:** root-session canonicalization,
  `session_batch_execute` ordering, child-event roll-up, local corpus namespace.

### 6.2 Scenario L2 — Child `session_index` replacement and root-visible shared search

- **Objective:** Prove child-created corpus state is shared at the root level
  and that re-indexing the same `(rootSessionId, source, label)` logical
  document replaces prior searchable content instead of appending duplicates.
- **Guarantees covered:** RG-3, RG-4, RG-5.
- **Topology:** default topology.
- **Procedure:**
  1. Prompt the root agent to delegate sequentially:
     - child agent A indexes `"BETA-V1 replacement sentinel"` with
       `source="live-smoke-L2"` and `label="shared-doc"`;
     - child agent B re-indexes the same `source` and `label` with
       `"BETA-V2 replacement sentinel"`.
  2. Prompt the root agent to run or delegate one `session_search` for
     `BETA-V1 replacement sentinel` and one for `BETA-V2 replacement sentinel`.
  3. Prompt the root agent to explain which version is live and why.
- **Expected runtime observations:**
  - child B can update the same logical document created by child A;
  - the root-visible search path finds `BETA-V2` and does not return `BETA-V1`
    as still-live corpus content;
  - continuity references both child actions as part of one shared session.
- **Evidence to collect:** both `session_index` responses; both root-visible
  search responses; the root summary; the next root-turn memory envelope.
- **Pass interpretation:** PASS only if `BETA-V2` is discoverable, `BETA-V1`
  replacement content is absent from the live result set, and the root summary
  attributes both changes to one shared workstream.
- **Common failure signatures:** old content remains searchable; duplicate live
  hits for both versions; child B writes to a child-local namespace; root answer
  lacks child continuity.

### 6.3 Scenario L3 — Live mixed `session_batch_execute` plus local search workflow

- **Objective:** Prove a live mixed batch preserves request order, typed
  results, and bounded output when a delegated workflow combines command
  execution with local corpus search.
- **Guarantees covered:** RG-1, RG-2, RG-5.
- **Topology:** default topology.
- **Procedure:**
  1. Prompt the root agent to have child agent A index a note containing
     `GAMMA-BATCH-41` with `source="live-smoke-L3"` and `label="batch-seed"`.
  2. Prompt the root agent to have child agent B call `session_batch_execute`
     with exactly three ordered steps:
     - command: `pwd`
     - search: `GAMMA-BATCH-41`
     - command: `ls docs`
  3. Prompt the root agent to summarize the three step results in order and to
     name which result items were command results versus search results.
- **Expected runtime observations:**
  - the batch result contains three ordered items matching the request order;
  - the middle result is a typed search result, not a coerced command-shaped
    blob;
  - the root summary preserves the same order and kind distinctions.
- **Evidence to collect:** child A index response; child B raw batch response;
  root summary; any artifact refs if a command step spills over.
- **Pass interpretation:** PASS only if the response order is preserved exactly,
  step kinds remain distinguishable, and the combined reply stays bounded.
- **Common failure signatures:** reordered results; search result coerced into a
  command-like payload; full raw output concatenated into the root reply.

### 6.4 Scenario L4 — Delegated work leading to later bounded `<persistent_memory>` recall

- **Objective:** Prove delegated work can become later bounded Graphiti-backed
  recall, while remaining optional and absent from the original hot-path turn.
- **Guarantees covered:** RG-6, RG-7.
- **Topology:** two sequential live phases, each using the default topology.
- **Preconditions:** Graphiti available; Redis/FalkorDB available; begin from a
  fresh root session with no preexisting cached recall for the chosen sentinel.
- **Procedure:**
  1. In phase A, prompt the root agent to delegate two children to investigate
     and then converge on one explicit fact sentence containing the sentinel
     `DELTA-MEM-82`.
  2. Require the root agent to produce a final parent-level sentence such as
     `Decision DELTA-MEM-82: use the root-session corpus as the source of truth
     for live runtime evidence.`
  3. Allow the session to idle naturally long enough for the background drain to
     run, or complete one normal compaction cycle if that is the easier natural
     path in the operator environment.
  4. Start a later live phase in a fresh root session for the same workspace.
     Prompt the new root agent to spawn two children: one asks what
     `DELTA-MEM-82` means, and the other checks `session_doctor` or equivalent
     runtime health.
  5. Ask the root agent to answer the question and cite only bounded recall.
- **Expected runtime observations:**
  - the original phase-A hot-path turn succeeds before any fresh Graphiti read
    is required;
  - the later phase can emit a bounded `<persistent_memory>` block or equivalent
    cached recall evidence containing `node_refs` for `DELTA-MEM-82`;
  - the recalled memory appears as additive context, not as a requirement for
    the current turn to function.
- **Evidence to collect:** phase-A delegated transcript; idle/compaction timing
  note; Graphiti drain or cache-refresh observations if exposed; phase-B root
  prompt; phase-B `<memory version="2">` with `<persistent_memory>`; final root
  answer.
- **Pass interpretation:** PASS only if the later recall is bounded and cache-
  backed, while the original delegated work completed without any synchronous
  Graphiti dependency.
- **Common failure signatures:** no later recall despite successful drain/cache
  evidence; `<persistent_memory>` required on the first turn; synchronous
  Graphiti error blocks delegated work.

### 6.5 Scenario L5 — Native-tool fallback and routing or enforcement toward `session_*`

- **Objective:** Prove risky native-tool attempts remain secondary and are
  denied or steered toward the corresponding `session_*` tool in a live
  delegated run.
- **Guarantees covered:** RG-1, RG-4.
- **Topology:** default topology.
- **Procedure:**
  1. Prompt the root agent to launch two children in parallel.
  2. Instruct child agent A to attempt a native network or raw-fetch path first
     for a repository doc URL or equivalent safe target, such as native
     `WebFetch` or raw `curl`, and to follow any runtime guidance it receives.
  3. Instruct child agent B to use the intended MCP-first path immediately via
     `session_fetch_and_index` for the same target.
  4. Prompt the root agent to compare the denied or guided native attempt with
     the successful `session_fetch_and_index` path, then run `session_search`
     over the fetched content.
- **Expected runtime observations:**
  - the native-tool attempt is denied, rewritten, or guided toward `session_*`;
  - the `session_fetch_and_index` path succeeds and yields bounded local-search
    results;
  - the root answer clearly states that hooks enforced policy but did not become
    the primary data path.
- **Evidence to collect:** native-tool denial/guidance text; successful
  `session_fetch_and_index` response; subsequent `session_search` result; root
  comparison summary.
- **Pass interpretation:** PASS only if enforcement occurs and the corrected
  `session_*` path succeeds without unbounded native output entering the
  transcript.
- **Common failure signatures:** risky native tool allowed without guidance;
  native tool becomes the actual data path; no successful `session_*` follow-up.

### 6.6 Scenario L6 — Compaction after delegated work and resumed execution from preserved memory

- **Objective:** Prove delegated work survives compaction and the root agent can
  resume from preserved continuity without the operator restating the work.
- **Guarantees covered:** RG-4, RG-5, RG-8.
- **Topology:** default topology.
- **Procedure:**
  1. Prompt the root agent to delegate two children that create at least two
     memorable sentinels and one explicit pending-task list item.
  2. Before compaction, require one child to call `session_notes_write` with a
     concise markdown note that pins the pending task, at least one sentinel,
     and the intended next step for resumed execution.
  3. Have the root agent or a child confirm the note is readable via
     `session_notes_read` before compaction occurs.
  4. Drive the live runtime to a natural compaction event. Use ordinary
     conversation pressure or the product's normal compaction control; do not
     use synthetic hook invocation as proof.
  5. After compaction completes, prompt the root agent:
     `Resume the delegated
     task. What were the two sentinels and what work is still pending?`
  6. Require the root agent to spawn child agent A to verify one sentinel via
     `session_search` and child agent B to reopen the pinned note with
     `session_notes_read` before continuing one pending task step.
- **Expected runtime observations:**
  - pre-compaction delegated work appears in the compaction-preserved memory
    envelope;
  - the compaction-time `<memory version="2">` evidence includes a
    `<session_notes source="note_tools">` section with the complete pinned note
    body as input material;
  - the root resumes correctly after compaction without the operator replaying
    the history;
  - the resumed children continue from the preserved state rather than starting
    a fresh branch, and the reopened note text still matches the pinned
    pre-compaction note.
- **Evidence to collect:** pre-compaction prompt/evidence; compaction occurrence
  note or log; `session_notes_write` and `session_notes_read` responses;
  post-compaction root answer; post-compaction child tool results; post-
  compaction `<memory version="2">` envelope.
- **Pass interpretation:** PASS only if delegated continuity survives compaction
  and the resumed execution demonstrably uses preserved memory, including the
  compaction-fed pinned note contents.
- **Common failure signatures:** post-compaction amnesia; missing child-derived
  continuity; resumed search cannot find pre-compaction indexed content; pinned
  note omitted from compaction input; resumed note read returns empty or
  paraphrased content instead of the stored note body.

### 6.7 Scenario L7 — Restart after delegated and indexed work with continuity and corpus recovery

- **Objective:** Prove a real process restart preserves recoverable root-session
  continuity and local corpus state when Redis/FalkorDB remains intact.
- **Guarantees covered:** RG-4, RG-5, RG-9.
- **Topology:** two phases; each phase uses the default topology.
- **Procedure:**
  1. In phase A, prompt the root agent to delegate two children that create one
     searchable sentinel `ETA-RESTART-29` and one explicit pending task.
  2. Save the root-session identifier or equivalent session-resume handle
     exposed by the runtime, plus the resulting corpus refs.
  3. Fully stop the OpenCode runtime or plugin host process without clearing
     Redis/FalkorDB.
  4. Restart the runtime and resume the same root session lineage using the
     product's normal resume mechanism.
  5. Prompt the resumed root agent to spawn child agent A to search for
     `ETA-RESTART-29` and child agent B to inspect `session_stats` or
     `session_doctor`.
  6. Ask the root agent to explain which continuity and corpus state was
     recovered after restart.
- **Expected runtime observations:**
  - the resumed run can still search for `ETA-RESTART-29`;
  - continuity about the pending task survives the process restart;
  - health or stats output reflects a healthy local runtime after reconnect.
- **Evidence to collect:** phase-A tool responses; saved resume handle; restart
  timestamp note; phase-B search, stats, and root summary outputs.
- **Pass interpretation:** PASS only if the resumed root session can recover
  both corpus and continuity state without the operator manually recreating
  them.
- **Common failure signatures:** corpus empty after restart; root session cannot
  be resumed; continuity survives only in copied human notes rather than runtime
  state.

### 6.8 Scenario L8 — Graphiti-unavailable delegated work with local-first continuity

- **Objective:** Prove Graphiti loss does not break delegated hot-path work and
  that `<persistent_memory>` is omitted while local continuity remains correct.
- **Guarantees covered:** RG-5, RG-6, RG-7, RG-9.
- **Topology:** default topology.
- **Preconditions:** stop Graphiti before the run; keep Redis/FalkorDB healthy.
- **Procedure:**
  1. Prompt the root agent to spawn two children: one indexes and searches a
     sentinel `THETA-LOCAL-11`, and the other runs `session_doctor` plus one
     ordinary `session_batch_execute` command/search flow.
  2. Ask the root agent to summarize the delegated work and to state whether any
     Graphiti-backed recall was available.
  3. Ask one additional root follow-up question so the observer can capture the
     next root-turn memory envelope.
- **Expected runtime observations:**
  - delegated indexing, search, and batch execution still succeed from local
    hot-tier state;
  - `session_doctor` or warning output reports Graphiti degradation;
  - the captured `<memory version="2">` envelope omits `<persistent_memory>`
    rather than blocking the turn.
- **Evidence to collect:** Graphiti-down confirmation note; child tool results;
  warnings or doctor output; captured root-turn memory envelope; root summary.
- **Pass interpretation:** PASS only if local-first continuity stays correct and
  Graphiti absence changes only the optional persistent-memory portion.
- **Common failure signatures:** delegated work blocked by Graphiti; fabricated
  `<persistent_memory>` claims; empty local continuity despite successful child
  work.

### 6.9 Scenario L9 — Redis/FalkorDB degradation or reconnect during delegated work

- **Objective:** Prove the runtime degrades safely during hot-tier loss,
  surfaces the degraded state, and can continue or recover cleanly after
  reconnect.
- **Guarantees covered:** RG-4, RG-5, RG-9.
- **Topology:** default topology.
- **Procedure:**
  1. Start with Redis/FalkorDB healthy. Prompt the root agent to launch two
     children and record a sentinel `IOTA-REDIS-7` plus one pending action.
  2. While the session remains active, have the `human operator` interrupt or
     restart Redis/FalkorDB.
  3. Prompt child agent A to run `session_doctor` during the outage and child
     agent B to continue one bounded task without claiming durable persistence.
  4. Restore Redis/FalkorDB connectivity.
  5. Prompt the root agent to launch both children again: one checks
     `session_doctor`, the other performs a fresh index/search cycle using a new
     sentinel `IOTA-REDIS-RECOVERED-8`.
  6. Ask the root agent to explain what degraded correctly, what recovered, and
     which continuity claims are intentionally out of scope for this scenario.
- **Expected runtime observations:**
  - the runtime surfaces a degraded hot-tier state instead of crashing silently;
  - delegated work can continue only within the documented degraded boundary;
  - after reconnect, health checks improve and fresh local corpus work succeeds.
- **Evidence to collect:** outage timing note; warnings; doctor output before,
  during, and after reconnect; post-reconnect index/search evidence; root
  explanation of the boundary.
- **Pass interpretation:** PASS only if degraded behavior is explicit, bounded,
  and recoverable. Do **not** treat this scenario as proof that a temporary
  degraded in-memory path is equivalent to the default persisted Redis path.
- **Common failure signatures:** silent crash or hang during outage; degraded
  state reported as healthy; no recovery after reconnect; root overclaims
  persistence semantics.

### 6.10 Scenario L10 — Combined-backend degradation boundary (explicit automated-only exception)

- **Objective:** Record the one allowed non-live exception: simultaneous loss of
  Redis/FalkorDB and Graphiti is covered by automated degradation testing rather
  than by a mandatory live delegated run.
- **Guarantees covered:** RG-9.
- **Justification:** with both backends unavailable at once, the plugin's hot-
  tier proof surface and async-tier proof surface are both absent. A live run in
  that state primarily measures base OpenCode survivability and operator
  recovery, not the plugin's bounded continuity guarantees. The repository's
  automated degradation suites are therefore the release gate for this specific
  boundary.
- **Procedure:**
  1. The `human operator` confirms that Suite K and any related automated
     degradation coverage passed for the release candidate.
  2. The `observer/evidence collector` records the automated evidence bundle and
     an exception note stating that no live delegated proof is claimed for
     simultaneous Redis/FalkorDB-plus-Graphiti outage.
  3. If an ad hoc live attempt is still run in a disposable environment, label
     it informational only and do not count it as required release proof.
- **Pass interpretation:** PASS only if the release packet contains the explicit
  automated-only justification and does not mislabel an unsafe or low-signal
  live outage run as equivalent proof.
- **Common failure signatures:** missing exception note; release checklist
  claims live proof that was never actually collected; automated degradation
  evidence absent.

### 6.11 Scenario L11 — High-volume artifact generation proving boundedness in real agent use

- **Objective:** Prove real delegated high-volume work stays bounded at the tool
  surface and spills large bodies to local artifacts or corpus refs instead of
  flooding the transcript.
- **Guarantees covered:** RG-1, RG-2, RG-5.
- **Topology:** default topology.
- **Procedure:**
  1. Prompt the root agent to launch two children in parallel.
  2. Instruct child agent A to run `session_execute` with a deterministic large-
     output command, for example:

     ```text
     deno eval "for (let i = 0; i < 4000; i++) console.log('KAPPA-A-' + i)"
     ```

  3. Instruct child agent B to run a second deterministic large-output command,
     for example:

     ```text
     deno eval "for (let i = 0; i < 4000; i++) console.log('KAPPA-B-' + i)"
     ```

  4. Prompt the root agent to use `session_stats` and one or more
     `session_search` queries for `KAPPA-A-3999` and `KAPPA-B-3999`.
  5. Ask the root agent to summarize what was stored locally versus what was
     kept inline.
- **Expected runtime observations:**
  - both child tool responses stay bounded rather than returning all 8,000 lines
    inline;
  - artifact or corpus refs are returned for the oversized bodies;
  - `session_stats` reflects bytes saved, artifact growth, or equivalent
    bounded- response accounting;
  - `session_search` can retrieve bounded snippets for the stored large outputs.
- **Evidence to collect:** both large-output `session_execute` responses;
  artifact or corpus refs; `session_stats` output; bounded `session_search`
  snippets; root summary.
- **Pass interpretation:** PASS only if the transcript remains bounded while the
  large outputs remain retrievable through local refs and search.
- **Common failure signatures:** raw large output dumped inline; missing
  artifact refs; `session_stats` shows no accounting change; local search cannot
  retrieve the stored large-output sentinel lines.

### 6.12 Graceful-shutdown host-lifecycle proof and dreaming wait requirement

- **Objective:** Prove the currently supported graceful-shutdown behavior per
  host lifecycle before relying on it for dreaming handoff decisions.
- **Scope note:** Detached shutdown continuation is not a supported release
  behavior yet. The earlier proof attempt established that a generic plugin
  export plus unsupported plugin `dispose` handling is not enough. The current
  proof setup instead exposes separate TUI and server host proof tools so each
  host lifecycle can be validated directly.
- **Proof plugin wiring:** a proof config should load three plugins:
  - the main runtime plugin at `dist/esm/mod.js`
  - `.opencode/plugins/detached-dream-proof-tui.js` with `tui` export and tool
    `detached_dream_proof_tui`
  - `.opencode/plugins/detached-dream-proof-server.js` with `server` export and
    tool `detached_dream_proof_server`
- **Expected proof artifacts:**
  - TUI host writes `.opencode-detached-dream-proof-tui.json`
  - server/web/serve host writes `.opencode-detached-dream-proof-server.json`
- **Manual validation flow:**
  1. Start the target host with the proof config from the previous step loaded.
  2. In the TUI, invoke `detached_dream_proof_tui` once.
  3. In `opencode web` or `opencode serve`, invoke `detached_dream_proof_server`
     once.
  4. Confirm the immediate warning toast says the matching host proof is armed.
  5. Trigger each required graceful-exit path separately:
     - TUI: `CTRL+D`
     - TUI: `CTRL+C`
     - TUI: `CTRL+P`, then choose Exit
     - `opencode web`: `CTRL+C`
     - `opencode serve`: `CTRL+C`
  6. For each path, verify whether the host exits immediately or remains open
     long enough for the proof wait to complete.
  7. If the host stays open, wait about 10-15 seconds and verify the matching
     proof artifact now exists.
  8. Open the proof artifact and verify it contains
     `mode:
     "runtime_teardown_wait"`, the matching `host`, and a completion
     timestamp.
  9. Treat detached continuation as non-viable for that host if the process
     exits immediately with no later artifact, or if the artifact appears only
     while the foreground host is still clearly alive.
  10. Until every required host path is proven, keep the product behavior and
      operator guidance on the conservative path: graceful shutdown may require
      waiting for dreaming completion on the foreground path.

- **Operator handoff text:** Host-lifecycle proof is ready. Run
  `detached_dream_proof_tui` in the TUI and `detached_dream_proof_server` in
  `opencode web` and `opencode serve`, then verify the required exit paths
  above. Each passing path should either wait long enough to produce its proof
  artifact or prove conclusively that foreground waiting is required for that
  host.

## 7. Coverage Map

Every release packet must be able to point from each critical proof target to
its automated suite coverage, its live-runtime proof path or justified
exception, and the evidence classes required by §4.

| Coverage row                                                   | Guarantees covered | Automated proof path | Live proof path                                  | Required evidence focus                                                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ------------------ | -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_*` primary bounded execution surface                  | RG-1               | Suites A, C, H       | Scenarios L1, L3, L5, L11                        | `session_*` responses, command output, logs/warnings when enforcement occurs                                                                                              | Baseline MCP-first proof row; native-tool success paths do not substitute.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `session_batch_execute` mixed-step behavior                    | RG-2               | Suites B, C          | Scenarios L1, L3, L8                             | Raw batch response with ordered typed results, bounded output evidence, follow-up summary                                                                                 | Must prove mixed command/search ordering and boundedness, not just command-only batching.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `session_index` replacement semantics                          | RG-3               | Suite E              | Scenario L2                                      | Both index responses, replacement search results, root-visible continuity evidence                                                                                        | Required explicit row: same `(rootSessionId, source, label)` logical document must replace, not append.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Canonical root-session sharing across parent/child agents      | RG-4               | Suite G              | Scenarios L1, L2, L6, L7, L9                     | Root/child prompts, tool responses, root-session state observations, emitted envelopes                                                                                    | Mocked child routing never closes this row by itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Local-first bounded corpus behavior                            | RG-5               | Suites C, D, E       | Scenarios L1, L2, L3, L8, L11                    | Search results, corpus refs, Redis/FalkorDB observations where persistence is claimed                                                                                     | Graphiti-backed proof is additive only here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Pinned session notes and compaction-only note injection        | RG-4, RG-5, RG-8   | Suites A, D, G, I    | Scenario L6                                      | `session_notes_write` / `session_notes_read` responses, note-tagged `session_search` hits with `created_at` and `updated_at`, compaction envelopes with `<session_notes>` | Required explicit row. Proof must show: (1) exact note reads plus compaction-only injection of complete note bodies, not note summaries on ordinary chat turns; (2) session notes persist without TTL until explicitly deleted; (3) `session_search` note hits include `created_at` and `updated_at`; (4) same-project sessions can delete obsolete note ids from earlier sessions; (5) `session_notes_read` updates `last_read_at`, keeping an older but useful note competitive in freshness-aware ranking; (6) compaction injects only current-session notes. |
| `<persistent_memory>` presence/omission and bounded formatting | RG-7               | Suites F, I, J       | Scenarios L4, L8                                 | Full surrounding `<memory version="2">` block with and without `<persistent_memory>`; bounded formatting evidence                                                         | Required explicit row. Presence and omission are both first-class proof targets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Stale-cache behavior                                           | RG-7               | Suites F, J          | Scenario L4 (bounded-recall surface only)        | Cache metadata, refresh observations, emitted envelope before/after refresh when exposed                                                                                  | Required explicit row. Deterministic stale-cache injection is automated-primary; live proof checks that recall stays additive and bounded rather than forcing a brittle stale-cache setup.                                                                                                                                                                                                                                                                                                                                                                       |
| Cross-session recall                                           | RG-6, RG-7         | Suites F, I, J, K    | Scenario L4                                      | Phase-A and phase-B evidence, Graphiti drain/cache observations, later emitted `<persistent_memory>` context                                                              | Required explicit row. Proof fails if later recall is claimed without cache/drain evidence or emitted bounded context.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Graphiti off the hot path                                      | RG-6               | Suites F, J          | Scenarios L4, L8                                 | Hot-path success evidence plus drain/cache or degraded Graphiti observations                                                                                              | Must show original work succeeded before any fresh Graphiti read was required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Compaction continuity                                          | RG-8               | Suite I              | Scenario L6                                      | Pre- and post-compaction envelopes, post-compaction tool responses, continuity observations                                                                               | Synthetic hook calls alone do not satisfy this row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Restart and recovery with Redis/FalkorDB intact                | RG-9               | Suite K              | Scenario L7                                      | Restart timing note, resumed-session proof, search/stats results, state observations                                                                                      | Requires true stop/start evidence, not same-process simulation only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Graphiti-unavailable degradation                               | RG-6, RG-7, RG-9   | Suite K              | Scenario L8                                      | Graphiti-down confirmation, warnings or doctor output, emitted omission of `<persistent_memory>`                                                                          | Required explicit row. Live proof must show omission without hot-path failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Redis/FalkorDB degradation and reconnect boundaries            | RG-9               | Suite K              | Scenario L9                                      | Before/during/after doctor output, warnings, post-reconnect fresh index/search evidence                                                                                   | Do not overclaim persisted continuity from temporary degraded fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Combined-backend degradation boundary                          | RG-9               | Suite K              | Scenario L10 (explicit automated-only exception) | Automated degradation evidence bundle plus written exception note                                                                                                         | Required explicit row. This is the one sanctioned automated-only live exception.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 8. Release Gates

Release readiness is binary: **SHIP** only when the minimum automated set, the
mandatory live set, the degradation expectations, and the evidence model are all
satisfied for the release candidate. Otherwise the verdict is **NO-SHIP**.

### 8.1 Minimum automated suites that must pass

- **Mandatory critical automated set:** Suites A through K must pass on the
  release candidate revision.
- **High-severity regression set:** Suite L must also pass for any release that
  changes runtime behavior, payload shapes, storage behavior, batching,
  continuity assembly, or degradation handling. If Suite L is not run because a
  change is documentation-only or otherwise provably runtime-inert, the release
  packet must say so explicitly.
- **No substitution rule:** passing `deno task check`, `deno task lint`, or
  `deno task fmt` alone is never sufficient; they support but do not replace the
  required suites above.

### 8.2 Mandatory live scenarios that must pass

For any release that claims runtime readiness for the MCP-first plugin, the
following live scenarios are mandatory:

- L1 — shared root-session parallel investigation;
- L2 — `session_index` replacement semantics in shared runtime use;
- L3 — live mixed `session_batch_execute` ordering and typed-result behavior;
- L4 — later bounded cross-session recall;
- L5 — native-tool routing or enforcement toward `session_*`;
- L6 — compaction survival after delegated work;
- L7 — restart recovery with Redis/FalkorDB intact;
- L8 — Graphiti-unavailable local-first degradation;
- L9 — Redis/FalkorDB degradation or reconnect boundaries;
- L11 — high-volume bounded artifact generation.

Scenario L10 is not a live pass requirement; it is a required documented
exception proving that simultaneous Redis/FalkorDB-plus-Graphiti loss is gated
by automated evidence instead of a mandatory live run.

### 8.3 Degradation expectations for a SHIP verdict

- **Graphiti unavailable:** local hot-path work must still pass, warnings or
  doctor output must surface the degraded state, and `<persistent_memory>` must
  be omitted rather than fabricated or treated as required.
- **Redis/FalkorDB unavailable or reconnecting:** the runtime must surface the
  degraded boundary explicitly, avoid overclaiming persisted continuity, and
  recover cleanly when connectivity returns.
- **Combined backend outage:** release readiness depends on Suite K plus the L10
  automated-only exception note; do not claim equivalent live proof.
- **Hot-path invariant:** any evidence that Graphiti became a synchronous
  dependency on current-turn correctness is an automatic NO-SHIP.

### 8.4 Allowed known gaps and required justification

Only the following gaps are allowed in a SHIP packet:

- **Combined-backend live outage not run:** allowed because L10 explicitly
  classifies this boundary as automated-only; the packet must include the
  automated evidence bundle and the written exception note.
- **Deterministic stale-cache live injection not run as a separate scenario:**
  allowed because Suites F and J are the authoritative proof for stale-cache
  replacement/refresh behavior, while L4 proves the live bounded-recall surface.
  The packet must not mislabel L4 as a dedicated stale-cache fault-injection
  run.

No other gap is allowed without updating this manual in the same change stream.

### 8.5 Immediate NO-SHIP conditions

Any one of the conditions below immediately fails release readiness:

- any mandatory automated suite in §8.1 fails, is skipped without justification,
  or produces unresolved critical failures;
- any mandatory live scenario in §8.2 fails, is skipped, or lacks the evidence
  classes required by §4;
- release claims rely on mocked child-session routing, passing unit tests alone,
  synthetic hook invocation alone, or transcript-only assertions for runtime
  proof;
- emitted evidence shows child-local instead of canonical root-shared state for
  a scenario that claims delegated continuity;
- emitted evidence shows unbounded tool output entering the transcript where the
  plan requires bounded responses or artifact spillover;
- emitted evidence shows `<persistent_memory>` required for hot-path success,
  fabricated during Graphiti outage, or emitted without the surrounding bounded
  `<memory version="2">` context;
- degraded states are silent, misreported as healthy, or overclaimed as
  equivalent to the default persisted Redis/FalkorDB path;
- the release packet omits the run bundle, omits the L10 exception note when
  applicable, or otherwise cannot map a shipped guarantee to the §7 coverage
  map.
