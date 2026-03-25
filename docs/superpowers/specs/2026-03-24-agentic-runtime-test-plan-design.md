# Agentic Runtime Test Plan Design

## Goal

Replace the legacy historical test plan with a new authoritative,
execution-ready test plan for the current MCP-first agentic runtime.

The replacement document must validate the product as it now exists: an OpenCode
plugin whose primary execution surface is `session_*` MCP tools, whose
continuity model is rooted in canonical root-session state, and whose Graphiti
integration remains asynchronous and off the hot path.

The new plan must not be a loose strategy memo. It must be usable by an agent or
operator as a verification manual with exact setup, commands, procedures,
evidence requirements, and pass/fail gates.

## Why Replace The Old Plan

The existing `docs/ContextOverhaulTests.md` no longer matches the active product
center of gravity:

- it is explicitly marked superseded/historical
- it was written for the native-hook-first overhaul rather than the MCP-first
  runtime that now defines the product
- it under-specifies live multi-agent runtime validation, which is now a hard
  requirement

The replacement plan must therefore be written from scratch, even if some test
ideas are adapted and re-scoped.

The replacement document should live at the stable authoritative path
`docs/ContextOverhaulTests.md` by fully overwriting the historical content at
that path. It should not be moved to a dated filename because it is intended to
remain the living source of truth for runtime verification.

## Required Inputs

The new plan must be grounded in the current superpowers-era architecture and
gap-closure work, especially:

- `README.md`
- `AGENTS.md`
- `docs/superpowers/plans/2026-03-20-context-mode-mcp-first.md`
- `docs/superpowers/plans/2026-03-20-context-mode-mcp-first-implementation.md`
- `docs/superpowers/plans/2026-03-23-context-mode-batch-index-gap-closure.md`
- `docs/superpowers/plans/2026-03-23-mcp-first-gap-closure.md`
- `docs/superpowers/specs/2026-03-23-clean-slate-architecture-design.md`

These sources define what must be proven: bounded MCP-first execution, local
corpus behavior, canonical root-session sharing across subagents, continuity
capture through compaction, asynchronous Graphiti augmentation, and correct
optional `<persistent_memory>` behavior when Graphiti-backed recall is
available.

## Non-Negotiable Design Decisions

1. The new test plan is the authoritative runtime test plan for the repository.
2. Full agentic runtime testing is mandatory.
3. Mock-only or unit-only child-session coverage does not satisfy the
   multi-agent requirement.
4. The document must remain split for operator convenience:
   - automated verification
   - live agentic runtime verification
5. The document must be execution-ready rather than descriptive.
6. The document must state exactly what evidence counts as proof and what does
   not.
7. The replacement should correct stale legacy references encountered in the
   grounding docs when those references would otherwise misdirect future test
   authors or operators. In particular, stale `plans/ContextOverhaulTests.md`
   references in `AGENTS.md` should be treated as cleanup items during the
   rewrite or in immediate follow-up documentation work.

## Required Document Shape

All sections below are mandatory unless this spec explicitly marks them as
optional.

### 1. Purpose And Authority

- explain that the document replaces the legacy plan
- state that it is the current source of truth for validation
- identify the active architecture promises it proves
- include stable living-document metadata near the top of the replacement plan,
  at minimum:
  - `Status: Active`
  - `Last Updated: YYYY-MM-DD`
  - `Replaces: historical native-hook-first test plan`
  - a short note that git history at `docs/ContextOverhaulTests.md` will include
    both the historical and replacement eras of the document

### 2. Runtime Guarantees Under Test

Map the architecture to explicit proof targets, such as:

- `session_*` tools are the primary bounded execution surface
- `session_batch_execute` mixed command/search steps preserve order,
  boundedness, and typed results in both automated and live runtime usage
- `session_index` replacement semantics for the same
  `(rootSessionId, source,
  label)` replace prior logical documents rather than
  appending duplicates
- risky native tools are enforced or redirected by hooks rather than becoming
  the primary execution path
- parent and child agents share one canonical root-session continuity model
- local corpus indexing/search stays local-first and bounded
- Graphiti never blocks hot-path correctness
- `<persistent_memory>` appears only when supported by the current cache/runtime
  state, stays bounded/structured, and never becomes a hot-path dependency
- compaction preserves continuity for both direct and delegated work
- restart behavior preserves safe operation and state recovery expectations
- Graphiti-unavailable behavior degrades to local-first continuity without
  breaking hot-path correctness
- Redis/FalkorDB-unavailable behavior degrades safely according to the active
  runtime fallback rules
- combined-backend degradation boundaries are explicitly tested or explicitly
  justified as non-live-only coverage

### 3. Test Environment And Operators

Define:

- required services and optional degraded variants, including minimum expected
  endpoints/configuration and any version assumptions the operator must satisfy
- test accounts / local runtime assumptions
- artifact capture locations
- operator roles when live sessions require a root agent plus two child agents:
  - `human operator`: starts/stops services, launches the root session, issues
    scripted prompts when a manual trigger is required, and records evidence
  - `root agent`: receives the primary task and delegates to child agents
  - `child agent`: executes delegated work inside the same canonical runtime
    model
  - `observer/evidence collector`: may be the human operator or a separate
    agentic step, but the plan must say who captures logs, tool results, and
    state evidence for each scenario
- what can run in CI versus what requires a live OpenCode runtime

### 4. Evidence Model

Specify these mandatory evidence classes:

- command output
- `session_*` tool responses
- emitted `<session_memory>` envelopes
- emitted optional `<persistent_memory>` sections and their surrounding
  `<session_memory>` context
- Redis/FalkorDB state observations
- Graphiti cache/drain observations
- logs and warnings
- screenshots or copied transcripts only when necessary

Also define these mandatory anti-evidence rules:

- mocked child-session routing is supporting evidence only
- passing unit tests alone do not prove multi-agent runtime behavior
- synthetic hook invocation alone does not prove real delegation continuity
- transcript claims without corresponding tool/log/state evidence do not satisfy
  release gates when the scenario claims runtime proof

### 5. Automated Verification Matrix

This section should contain extensive, execution-ready suites with exact
commands, setup, assertions, expected artifacts, and pass/fail criteria.

Automated suites should run through the repository's existing test
infrastructure by default, using `deno test` unless the plan explicitly
justifies an additional helper harness.

Recommended suite groups:

- runtime contract tests for each `session_*` tool
- bounded output and artifact spillover tests
- local corpus indexing/search ranking and replacement tests
- `<persistent_memory>` cache-hit, cold-cache, refresh, omission, and
  stale-data-behavior tests
- root-session propagation and lifecycle tests
- hook enforcement and attribution tests
- continuity assembly and compaction survival tests
- async Graphiti drain/cache refresh tests
- restart/recovery/degradation tests
- regression thresholds for payload size, latency, and storage growth

The automated section should be at least as broad as the architecture coverage
represented by the historical plan, but rewritten for the MCP-first runtime and
its current `session_*` contracts rather than copied mechanically.

Each suite should include:

- objective
- prerequisites
- exact command(s)
- expected result
- artifacts/evidence to save
- common failure signatures
- severity / release gate classification

### 6. Live Agentic Runtime Scenarios

This is the mandatory section that makes the plan truly agentic.

It must define real session scenarios that exercise live delegation rather than
simulated hooks alone. Unless the scenario is explicitly justified as a
single-child exception, each scenario should use a root agent and at least two
subagent sessions.

At least one scenario template in the final plan must be fully concrete rather
than abstract, including exact prompts, expected subagent topology, evidence
capture steps, and pass/fail interpretation. The rest of the scenarios may reuse
that template shape, but they must still be fully fleshed out as executable
procedures rather than stubs.

Recommended scenario groups:

- two-subagent parallel investigation with root-session continuity roll-up
- child agent uses `session_search` and `session_index`, parent later sees the
  shared continuity effects
- mixed `session_batch_execute` + corpus search workflow in live runtime
- delegated work creates or refreshes Graphiti-backed recall that later appears
  as bounded `<persistent_memory>` in a subsequent live session
- native-tool fallback attempt followed by routing/enforcement toward
  `session_*`
- compaction after delegated work, followed by resumed execution from preserved
  memory
- session restart after delegated/indexed work with corpus and continuity
  recovery
- Graphiti unavailable during delegated work, followed by local-first continuity
  and later recovery
- Redis/FalkorDB unavailable or reconnecting during delegated work, followed by
  safe degraded operation and recovery evidence
- combined backend degradation boundaries, if safely reproducible in the live
  runtime harness; otherwise the final plan must explicitly justify why that
  proof remains automated-only
- high-volume artifact generation proving bounded response behavior under real
  agent usage

Every live scenario must specify:

- objective
- topology of root and child agents
- exact operator prompts or scripted actions
- expected runtime observations
- expected root-session state sharing behavior
- evidence to collect
- failure signatures and likely fault domains

### 7. Coverage Map

Add a matrix that maps each architecture promise to one or more automated suites
and one or more live runtime scenarios.

This should be presented as a table so operators can quickly verify that every
critical guarantee has both a proof path and an evidence path.

This section ensures nothing critical is validated only in mocks when it should
also be proven live.

The coverage map should include explicit rows for `<persistent_memory>`
presence/omission behavior, bounded formatting, stale-cache behavior,
cross-session recall, and Graphiti-unavailable degradation.

### 8. Release Gates

Define clear ship/no-ship criteria, for example:

- minimum automated suite pass set
- mandatory live scenario pass set
- degradation expectations
- allowed known gaps and why
- conditions that immediately fail the release

## Authoring Principles For The Replacement Test Plan

The new plan should be:

- specific enough that a fresh agent can execute it without inventing missing
  procedure
- honest about what requires real runtime proof
- explicit about evidence and artifacts
- architecture-aligned to the current MCP-first product
- strict about boundedness, continuity, and off-hot-path Graphiti behavior
- broad enough to cover failure recovery, not just happy-path success
- maintainable as a living document: when `session_*` contracts, continuity
  guarantees, or degradation behavior change, the authoritative plan should be
  updated in the same change stream or explicitly flagged for follow-up

## Out Of Scope For The Replacement Plan

The new plan should not:

- drift back into native-hook-first framing
- rely on undocumented OpenCode APIs
- present speculative future architecture as a test obligation unless already
  adopted in active plans
- treat clean-slate modularization as a prerequisite for runtime verification

## Expected Outcome

After implementation, the repository should have:

1. the legacy `docs/ContextOverhaulTests.md` removed or fully replaced
2. a new authoritative runtime test plan written from scratch in its place
3. an execution-ready verification manual with extensive automated and live
   agentic test cases
4. an explicit proof model for multi-agent runtime behavior that can be reused
   by future implementers and reviewers
