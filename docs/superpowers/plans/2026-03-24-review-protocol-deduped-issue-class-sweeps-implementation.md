# Review Protocol Deduped Issue-Class Sweeps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update `docs/ReviewProtocol.md` so verified review comments are
deduped into issue classes and each non-overlapping class is swept repo-wide by
one subagent in parallel.

**Architecture:** Keep the change doc-only and local to the review protocol.
Preserve the existing live-GitHub query and per-thread verification flow, then
extend Step 4 into a two-phase model (`4a` verification, `4b` deduped class
sweeps), update downstream thread-resolution/reporting language, and align the
guardrails so they no longer contradict repo-wide class sweeps.

**Tech Stack:** Markdown docs, existing review workflow in
`docs/ReviewProtocol.md`, approved spec in
`docs/superpowers/specs/2026-03-24-review-protocol-deduped-issue-class-sweeps-design.md`.

---

## File Structure And Responsibility Lock-In

- Modify: `docs/ReviewProtocol.md`
  - The only implementation target. It must absorb the approved workflow changes
    without drifting into a broader process rewrite.
- Reference:
  `docs/superpowers/specs/2026-03-24-review-protocol-deduped-issue-class-sweeps-design.md`
  - The authoritative design for the protocol update.
- Reference:
  `docs/superpowers/specs/2026-03-24-review-issue-class-sweep-design.md`
  - Supporting evidence for the repo-wide issue-class sweep model and expected
    subagent contract.

No code files should change. No additional docs should be created during
implementation.

### Task 1: Update Purpose And Step 4 Workflow

**Files:**

- Modify: `docs/ReviewProtocol.md`
- Reference:
  `docs/superpowers/specs/2026-03-24-review-protocol-deduped-issue-class-sweeps-design.md`

- [ ] **Step 1: Read the current protocol and approved spec side by side**

Read:

- `docs/ReviewProtocol.md`
- `docs/superpowers/specs/2026-03-24-review-protocol-deduped-issue-class-sweeps-design.md`

Expected: identify exactly which bullets in `Purpose` and `Workflow` still
describe a per-thread-only process.

- [ ] **Step 2: Write the failing expectation checklist in notes**

Capture these required deltas before editing:

- `Purpose` must no longer imply the workflow stops at the single verified
  claim.
- Step `4` must become two explicit sub-steps: `4a` per-thread verification and
  `4b` deduped issue-class sweeps.
- `4b` must state one subagent per deduped verified class.
- `4b` must state all non-overlapping classes run in parallel.
- `4b` must state overlapping risky areas/files are serialized.
- `4b` must state unknown overlap is serialized rather than guessed.
- the protocol must make dispatch-time serialization authoritative even if older
  sweep examples discuss overlap resolution later during integration.

- [ ] **Step 3: Edit the Purpose bullets minimally**

Update `docs/ReviewProtocol.md` so `Purpose` still emphasizes verification and
narrow evidence, but no longer contradicts repo-wide issue-class sweeps.

Expected result:

- verification remains the gate
- repo-wide class sweeps are allowed only after `verified` classification
- thread handling remains explicit

- [ ] **Step 4: Rewrite Workflow Step 4 into `4a` and `4b`**

Implement this structure in `docs/ReviewProtocol.md`:

- `4a.` verify each unresolved claim independently
- `4b.` dedupe all `verified` claims into issue classes, then dispatch one
  subagent per deduped class

The `4a` bullets must keep the existing classifications:

- `verified`
- `already satisfied`
- `stale`
- `invalid`
- `unclear`

The `4b` bullets must include:

- zero-verified short-circuit
- per-class normalized fields (`class label`, `seed thread ids`, `seed files`,
  `risky area/search scope`)
- dedupe rule (no duplicate class sweeps in one batch)
- parallel/non-parallel dispatch rule
- serialize-when-unknown default
- dispatch-time serialization authority over older integration-time examples

- [ ] **Step 5: Verify the doc now mentions the zero-verified edge case**

Run:

```bash
rg -n "zero|verified|issue class|dedupe|parallel|serialize" docs/ReviewProtocol.md
```

Expected: the rewritten Step `4` includes a clear skip path when no claims are
classified as `verified`.

### Task 2: Update Class-Sweep Contract, Thread Handling, And Reporting

**Files:**

- Modify: `docs/ReviewProtocol.md`
- Reference:
  `docs/superpowers/specs/2026-03-24-review-protocol-deduped-issue-class-sweeps-design.md`
- Reference:
  `docs/superpowers/specs/2026-03-24-review-issue-class-sweep-design.md`

- [ ] **Step 1: Update Step `3` so the working checklist carries the status
      model**

Edit Step `3` in `docs/ReviewProtocol.md` so the working checklist/local
artifact explicitly tracks distinct states for:

- per-thread verification status
- deduped issue classes for the batch
- per-class sweep outcomes

Expected: the protocol says these states may live in the same artifact, but must
remain distinct, and the existing "execution tracking only" wording is softened
enough to allow classification and sweep-outcome tracking without turning the
checklist into a separate implementation plan.

- [ ] **Step 2: Add the class-sweep subagent contract to Step `4b`**

Edit `docs/ReviewProtocol.md` so the class-sweep subagent responsibilities
explicitly include:

- using verified review comments as seed evidence
- identifying the reusable issue-class definition from those seeds
- searching the repo for the same issue class
- fixing all locally-supported matches in scope
- adding/extending focused tests when needed
- running targeted validation for touched scope
- reporting touched files, validation, and residual risk
- allowing a clean "no further instances found" outcome

- [ ] **Step 3: Make the overlap rules explicit and authoritative**

Edit `docs/ReviewProtocol.md` so `4b` explicitly says:

- known overlap means shared seed/touched files or the same risky area/search
  scope
- unknown overlap must be serialized rather than guessed
- this dispatch-time serialization rule is authoritative for the review
  protocol, even if older sweep examples handled overlap later during
  integration

- [ ] **Step 4: Update Step `5` thread-resolution wording**

Edit Step `5` so thread replies and resolutions can cite repo-wide class-sweep
evidence where useful, while preserving thread-level accountability.

Expected: Step `5` still resolves GitHub review threads individually, but the
prose now recognizes broader class-sweep fixes as valid evidence.

- [ ] **Step 5: Update Step `8` reporting bullets**

Edit the report section so it requires:

- unresolved threads found
- per-thread classifications
- deduped verified issue classes
- repo-wide sweep fixes per class
- threads resolved/commented
- final unresolved review count

- [ ] **Step 6: Re-read the step numbering for consistency**

Manual check:

- top-level steps remain `1` through `8`
- Step `4` uses substeps `4a` and `4b`
- downstream steps remain `5`, `6`, `7`, `8`

Expected: no accidental renumbering drift.

### Task 3: Align Guardrails And Verify The Final Document

**Files:**

- Modify: `docs/ReviewProtocol.md`
- Test: manual doc read + targeted `rg`

- [ ] **Step 1: Update the contradictory guardrails**

Adjust the guardrails so they say, in effect:

- avoid opportunistic unrelated refactors
- keep per-thread verification evidence local and narrow
- allow repo-wide fixes only within the verified, evidence-supported issue class
- never launch duplicate sweeps for the same class in one batch

- [ ] **Step 2: Run targeted verification searches**

Run:

```bash
rg -n "verified|issue class|dedupe|parallel|serialize|guardrails|local to the verified claim|duplicate sweeps" docs/ReviewProtocol.md
```

Expected: all accepted concepts from the spec are visibly present in the final
doc and the old contradictory guardrail text is gone or qualified.

- [ ] **Step 3: Manually read the final protocol end to end**

Read `docs/ReviewProtocol.md` from top to bottom.

Expected checks:

- the workflow is still concise
- the new class-sweep rules are understandable without reading the spec
- the guardrails no longer contradict the workflow
- thread-level verification and class-level execution are clearly distinct

- [ ] **Step 4: Verify the implementation against the acceptance checklist**

Check each item from
`docs/superpowers/specs/2026-03-24-review-protocol-deduped-issue-class-sweeps-design.md`:

1. verified comments are seed evidence, not the endpoint
2. same-class verified comments are deduped
3. one subagent per deduped verified class
4. non-overlapping classes run in parallel
5. overlapping scopes serialize
6. each class sweep searches repo-wide in evidence-supported scope
7. reporting distinguishes per-thread and per-class results
8. zero-verified batches skip class-sweep dispatch
9. overlap is defined conservatively
10. guardrails do not contradict the sweep behavior

Expected: every item is satisfied directly in `docs/ReviewProtocol.md`.
