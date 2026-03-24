# Agentic Runtime Test Plan Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the historical `docs/ContextOverhaulTests.md` with a new
authoritative, execution-ready MCP-first agentic runtime test plan, including
mandatory live multi-agent validation and explicit `<persistent_memory>`
coverage.

**Architecture:** Keep the deliverable narrowly scoped to documentation
authority and validation procedure rather than code changes to the runtime
itself. Rewrite the test plan in place at `docs/ContextOverhaulTests.md`,
restructure it around automated verification and live agentic runtime scenarios,
and clean up stale repository references that would misdirect future operators
or test authors.

**Tech Stack:** Markdown documentation, existing repository architecture docs,
Deno task/test commands, OpenCode live subagent runtime assumptions,
Redis/FalkorDB and Graphiti local service defaults.

---

## File structure and responsibility lock-in

- `docs/ContextOverhaulTests.md`
  - The authoritative living runtime test plan. This file must be fully
    rewritten in place, not replaced with a dated path.
- `AGENTS.md`
  - Cleanup only: correct stale references to the old
    `plans/ContextOverhaul*.md` paths so the repository reading order,
    validation notes, and key-file hints point to the authoritative `docs/`
    paths.
- `docs/superpowers/specs/2026-03-24-agentic-runtime-test-plan-design.md`
  - Read-only grounding spec for the rewrite. Do not rewrite the spec during
    implementation unless the user explicitly asks for spec changes.

`docs/ContextOverhaul.md` is a historical design document. Do not broaden this
task into updating its historical references unless the user explicitly asks for
that cleanup as separate work. Treat any stale references encountered there as
deferred follow-up documentation cleanup, not as part of this plan's required
edits.

Known deferred stale references outside `AGENTS.md` may still exist in code or
tests (for example references inside `src/services/` tests/guidance comments).
Those are follow-up cleanup candidates, not part of this documentation-focused
rewrite unless the user explicitly expands scope.

Do not broaden this work into runtime code changes, unrelated docs refreshes, or
clean-slate architecture edits.

### Task 1: Add guardrail tests for stale doc-path references

**Files:**

- Modify: `AGENTS.md`
- Test: repository-wide path/reference verification via `grep`

- [ ] **Step 1: Write down the failing reference checks to satisfy**

Capture these reference expectations before editing:

- `AGENTS.md` must not reference the stale non-existent path
  `plans/ContextOverhaulTests.md`
- `AGENTS.md` must not reference the stale non-existent path
  `plans/ContextOverhaul.md`
- `AGENTS.md` must reference `docs/ContextOverhaulTests.md` wherever it points
  to the authoritative test plan
- `AGENTS.md` must reference `docs/ContextOverhaul.md` wherever it points to the
  historical design document

- [ ] **Step 2: Run the failing reference search**

Run:
`grep -n "plans/ContextOverhaul\.md\|plans/ContextOverhaulTests\.md\|docs/ContextOverhaul\.md\|docs/ContextOverhaulTests\.md" AGENTS.md`

Expected: FAIL in the sense that the output still shows stale `plans/` path
references that need correction.

- [ ] **Step 3: Make the minimal doc cleanup in `AGENTS.md`**

Update only the stale path references in:

- Validation Expectations
- Resume-Reading Order
- Key Files table

Also add a `docs/ContextOverhaulTests.md` row to the Key Files table if the
table would otherwise omit the repository's authoritative runtime test plan.
Also update the existing stale `plans/ContextOverhaul.md` Key Files row to
`docs/ContextOverhaul.md` rather than removing that historical design entry.

Do not rewrite surrounding architecture guidance.

- [ ] **Step 4: Re-run the reference search to verify the cleanup**

Run:
`grep -n "plans/ContextOverhaul\.md\|plans/ContextOverhaulTests\.md\|docs/ContextOverhaul\.md\|docs/ContextOverhaulTests\.md" AGENTS.md`

Expected: PASS in the sense that only `docs/ContextOverhaul.md` and
`docs/ContextOverhaulTests.md` remain as the authoritative/historical `docs/`
paths.

### Task 2: Build the new test-plan outline with mandatory sections

**Files:**

- Modify: `docs/ContextOverhaulTests.md`
- Grounding:
  `docs/superpowers/specs/2026-03-24-agentic-runtime-test-plan-design.md`
- Grounding: `README.md`
- Grounding: `AGENTS.md`
- Grounding: `docs/superpowers/plans/2026-03-20-context-mode-mcp-first.md`
- Grounding:
  `docs/superpowers/plans/2026-03-20-context-mode-mcp-first-implementation.md`
- Grounding:
  `docs/superpowers/plans/2026-03-23-context-mode-batch-index-gap-closure.md`
- Grounding: `docs/superpowers/plans/2026-03-23-mcp-first-gap-closure.md`
- Grounding:
  `docs/superpowers/specs/2026-03-23-clean-slate-architecture-design.md`

- [ ] **Step 1: Write the failing outline checklist**

Before rewriting the file, make a checklist of the required sections from the
spec that the current document does not satisfy:

- Purpose and Authority
- Runtime Guarantees Under Test
- Test Environment and Operators
- Evidence Model
- Automated Verification Matrix
- Live Agentic Runtime Scenarios
- Coverage Map
- Release Gates

- [ ] **Step 2: Confirm the current document fails the new shape**

If `docs/ContextOverhaulTests.md` already exists, run a manual read of it
against the spec and record which required sections are missing or
historical-only. If the file is absent in the working tree, treat that absence
itself as a failing precondition that the rewrite must correct by creating the
authoritative file at that path.

Expected: FAIL because the existing document is explicitly historical and does
not provide the new authoritative MCP-first structure, or because the
authoritative file is absent and must be created.

- [ ] **Step 3: Rewrite the document header and section skeleton in place**

The replacement must include near the top:

- `Status: Active`
- `Last Updated: 2026-03-24` (or the actual rewrite date if implementation
  slips)
- `Replaces: historical native-hook-first test plan`
- a short note about the file carrying both historical and replacement-era git
  history

Then create the full mandatory section structure before filling in all test
content, including an explicit `Runtime Guarantees Under Test` section scaffold
that later automated/live sections can reference.

The scaffold must explicitly name the proof targets from the spec, including:

- `session_*` as the primary bounded execution surface
- `session_batch_execute` mixed command/search ordering, boundedness, and typed
  results
- `session_index` replacement semantics for the same
  `(rootSessionId, source,
  label)` logical document
- canonical root-session sharing across parent/child agents
- local-first bounded corpus behavior
- Graphiti off the hot path
- optional bounded `<persistent_memory>` behavior
- compaction continuity
- restart and degradation expectations, including combined-backend boundaries

- [ ] **Step 4: Re-read the rewritten skeleton against the spec**

Expected: PASS in structure only — every mandatory top-level section exists,
even if the detailed test content is not complete yet.

### Task 3: Author the test environment and operator model

**Files:**

- Modify: `docs/ContextOverhaulTests.md`
- Verify against: `README.md`, `AGENTS.md`,
  `docs/superpowers/specs/2026-03-24-agentic-runtime-test-plan-design.md`

- [ ] **Step 1: Write the failing environment/operator checklist**

List the section content that must be written explicitly:

- required services and default endpoints/configuration assumptions
- any version/runtime assumptions the operator must know
- artifact capture locations
- CI-runnable versus live-runtime-only boundaries
- operator roles (`human operator`, `root agent`, `child agent`,
  `observer/evidence collector`)

- [ ] **Step 2: Confirm the current document does not provide this content**

Expected: FAIL because the historical document does not define the current
MCP-first runtime environment model or the required operator-role split.

- [ ] **Step 3: Write the `Test Environment and Operators` section**

Use:

- `README.md` for service defaults such as Redis/FalkorDB on `localhost:6379`
  and Graphiti MCP on `http://localhost:8000/mcp`
- `AGENTS.md` for hot-path, async-tier, and continuity constraints
- the spec for required operator-role definitions and CI-vs-live distinctions

- [ ] **Step 4: Re-read the section for execution readiness**

Expected: PASS if a fresh operator can tell what services must be running, what
assumptions hold, who performs each role in live testing, and what can run in CI
versus only in a live OpenCode runtime.

### Task 4: Author the automated verification matrix

**Files:**

- Modify: `docs/ContextOverhaulTests.md`
- Verify against: `README.md`, `AGENTS.md`,
  `docs/superpowers/plans/2026-03-20-context-mode-mcp-first.md`,
  `docs/superpowers/plans/2026-03-20-context-mode-mcp-first-implementation.md`,
  `docs/superpowers/plans/2026-03-23-context-mode-batch-index-gap-closure.md`,
  `docs/superpowers/plans/2026-03-23-mcp-first-gap-closure.md`,
  `docs/superpowers/specs/2026-03-23-clean-slate-architecture-design.md`

- [ ] **Step 1: Write the failing automated-coverage checklist**

List the mandatory automated suite groups that must exist, including:

- per-tool `session_*` contract coverage
- explicit `session_batch_execute` mixed command/search ordering, boundedness,
  and typed-result coverage
- bounded output and artifact spillover
- local corpus search/ranking/replacement semantics
- explicit `session_index` replacement semantics coverage for the same
  `(rootSessionId, source, label)` logical document
- `<persistent_memory>` cache-hit, cold-cache, refresh, omission, and stale-data
  behavior
- root-session propagation/lifecycle
- hook enforcement/attribution
- continuity assembly/compaction survival
- async Graphiti drain/cache refresh
- restart/recovery/degradation
- regression thresholds for payload size, latency, and storage growth

- [ ] **Step 2: Verify the current automated section is insufficient**

Compare the historical suites to the new checklist.

Expected: FAIL because the historical suites are hot-path/native-hook-first in
framing and under-specify current MCP-first runtime obligations.

- [ ] **Step 3: Write the automated matrix with execution-ready detail**

For each automated suite, include:

- objective
- prerequisites
- exact commands, primarily using the repo's existing `deno task` commands plus
  the built-in `deno test` command where test execution is required
- expected result
- artifacts/evidence to save
- common failure signatures
- release-gate severity

Also ensure the document states clearly when an additional helper harness would
need explicit justification rather than being assumed by default, and do not
invent a new `deno task test` alias as part of this docs-only rewrite.

The automated matrix documents expected verification commands and procedures for
future test execution. Do not create new test files or expand into runtime-test
implementation as part of this documentation rewrite.

- [ ] **Step 4: Re-read the automated matrix for architecture alignment**

Expected: PASS if every active runtime guarantee has at least one automated
proof path and none of the automated sections drift back to native-hook-first
framing.

### Task 5: Author the live agentic runtime scenarios

**Files:**

- Modify: `docs/ContextOverhaulTests.md`
- Verify against: `README.md`, `AGENTS.md`,
  `docs/superpowers/plans/2026-03-20-context-mode-mcp-first.md`,
  `docs/superpowers/plans/2026-03-20-context-mode-mcp-first-implementation.md`,
  `docs/superpowers/plans/2026-03-23-context-mode-batch-index-gap-closure.md`,
  `docs/superpowers/plans/2026-03-23-mcp-first-gap-closure.md`,
  `docs/superpowers/specs/2026-03-23-clean-slate-architecture-design.md`

- [ ] **Step 1: Write the failing live-scenario checklist**

List the required live runtime scenario families, including:

- two-subagent parallel investigation with root-session continuity roll-up
- child `session_search` / `session_index` effects visible to parent/root
- live mixed `session_batch_execute` + search workflow
- delegated work leading to later bounded `<persistent_memory>` recall
- native-tool fallback and routing/enforcement toward `session_*`
- compaction after delegated work and resumed execution from preserved memory
- restart after delegated/indexed work with continuity/corpus recovery
- Graphiti-unavailable delegated work with local-first continuity
- Redis/FalkorDB degradation or reconnect during delegated work
- combined-backend degradation, or explicit justification for automated-only
  coverage
- high-volume artifact generation proving boundedness in real agent use

- [ ] **Step 2: Verify the historical document does not satisfy live proof**

Expected: FAIL because the historical plan does not make full live agentic
runtime validation mandatory and does not provide execution-ready multi-agent
procedures.

- [ ] **Step 3: Write the live agentic runtime scenarios in full**

Requirements:

- use a root agent and at least two child agents unless a scenario explicitly
  justifies a single-child exception
- make at least one scenario fully concrete with exact prompts, topology,
  evidence capture, and pass/fail interpretation
- fully flesh out every scenario as an executable procedure, not a stub
- include operator roles (`human operator`, `root agent`, `child agent`,
  `observer/evidence collector`) where relevant

- [ ] **Step 4: Re-read the live section for true runtime proof**

Expected: PASS if the section proves real delegation behavior rather than merely
rephrasing mock or synthetic-hook coverage.

### Task 6: Add the evidence model, coverage map, and release gates

**Files:**

- Modify: `docs/ContextOverhaulTests.md`

- [ ] **Step 1: Write the failing proof-model checklist**

The document must explicitly define:

- mandatory evidence classes
- anti-evidence rules
- a table-based coverage map
- ship/no-ship release gates

The coverage map must include explicit rows for:

- `session_batch_execute` mixed-step behavior
- `session_index` replacement semantics
- `<persistent_memory>` presence/omission and bounded formatting
- stale-cache behavior
- cross-session recall
- Graphiti-unavailable degradation
- combined-backend degradation boundaries or explicit automated-only
  justification

- [ ] **Step 2: Confirm the current document fails the proof-model checklist**

Expected: FAIL because the historical plan does not define the new evidence
model or the required coverage mapping between automated and live proof.

- [ ] **Step 3: Write the evidence model, table coverage map, and release
      gates**

Be explicit that the following do **not** count as sufficient proof on their
own:

- mocked child-session routing
- passing unit tests alone
- synthetic hook invocation alone
- transcript claims without tool/log/state evidence when runtime proof is being
  claimed

Release gates should identify:

- the minimum automated suites that must pass
- the mandatory live scenarios that must pass
- degradation expectations
- allowed known gaps and their justification
- conditions that immediately fail release readiness

- [ ] **Step 4: Re-read the proof-model sections for completeness**

Expected: PASS if an operator can tell exactly what evidence must be collected,
what coverage exists, and what blocks release.

### Task 7: Final consistency pass and repository-facing cleanup

**Files:**

- Modify: `docs/ContextOverhaulTests.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Run a final doc consistency review against the grounding spec**

Read `docs/ContextOverhaulTests.md` side by side with
`docs/superpowers/specs/2026-03-24-agentic-runtime-test-plan-design.md`.

Check for:

- missing mandatory sections
- MCP-first drift
- missing `<persistent_memory>` coverage
- live multi-agent scenarios that are still too abstract
- stale path references in `AGENTS.md`

- [ ] **Step 2: Run repository verification commands**

Run: `deno task check && deno task lint && deno task fmt`

Expected: PASS. These tasks exist in `deno.json` for this repository. If
formatting changes are applied by `deno task fmt`, review the doc diff and
ensure only intended documentation formatting changed.

These are repository-health checks for the docs rewrite itself. They are not the
same as the `deno test` commands documented inside
`docs/ContextOverhaulTests.md` for future operators, and this plan does not
require adding a new `deno task test` alias.

- [ ] **Step 3: Run final reference searches**

Run:
`grep -n "plans/ContextOverhaul\.md\|plans/ContextOverhaulTests\.md\|docs/ContextOverhaul\.md\|docs/ContextOverhaulTests\.md" AGENTS.md`

Expected: PASS in the sense that `AGENTS.md` points only at
`docs/ContextOverhaul.md` and `docs/ContextOverhaulTests.md` for these
historical/authoritative references.

- [ ] **Step 4: Perform a final manual release-gate check**

Confirm the finished document now provides:

- an authoritative living runtime test plan
- extensive automated verification procedures
- extensive live agentic runtime procedures
- explicit `<persistent_memory>` validation
- proof/evidence criteria and release gates

- [ ] **Step 5: Commit the task**

Only perform this step if the user explicitly asks for a commit in the
implementation session.

```bash
git add docs/ContextOverhaulTests.md AGENTS.md
git commit -m "docs: rewrite the agentic runtime test plan"
```

If you intentionally updated
`docs/superpowers/plans/2026-03-24-agentic-runtime-test-plan-rewrite.md` during
execution (for example by marking checkboxes), stage it separately before
committing. Otherwise leave the plan file out of the commit.
