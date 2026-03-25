# Review Protocol Deduped Issue-Class Sweep Design

## Goal

Update `docs/ReviewProtocol.md` so PR review handling no longer stops at
per-comment verification. Once a review claim is found `verified`, the protocol
must require a repo-wide sweep for the same issue class, deduped across all
verified comments in the current batch, with all resulting class sweeps launched
in parallel when their scopes do not overlap.

## Why

The current review protocol treats each unresolved review thread as an isolated
fix unit. That is useful for truth-tracking, but it leaves an execution gap:
when one review comment exposes a broader issue pattern, the protocol does not
require the agent to search for and fix the same class elsewhere in the repo.

That gap has already shown up in practice. The repository now has an explicit
issue-class sweep design in
`docs/superpowers/specs/2026-03-24-review-issue-class-sweep-design.md`, but
`docs/ReviewProtocol.md` still documents the older per-thread-only workflow. The
protocol should reflect the stronger workflow so future review handling is
systematic rather than opportunistic.

## Non-Goals

- Do not change the authoritative live-GitHub query requirement.
- Do not remove per-comment verification as the first gate.
- Do not require broad speculative refactors unrelated to a verified issue
  class.
- Do not force parallel execution when verified issue classes overlap in the
  same risky area.

## Required Workflow Changes

### 1. Preserve per-comment verification as the first gate

The protocol must continue to verify each unresolved review claim against the
current working tree before any broader action is taken.

Each review-item verification session still needs to classify the claim as one
of:

- `verified`
- `already satisfied`
- `stale`
- `invalid`
- `unclear`

Only `verified` claims are eligible to seed repo-wide class sweeps.

### 2. Add a deduped issue-class normalization phase

After the per-comment verification pass completes for the current unresolved
batch, the main flow must group all `verified` claims into deduped issue
classes.

The protocol should require each class entry to capture at least:

- issue-class label
- seed review thread ids
- seed files / evidence locations
- risky area / likely search scope
- whether the class can run in parallel with other classes

Multiple verified comments that describe the same underlying pattern must be
collapsed into one issue class for that batch. The protocol must explicitly say
that the agent should not launch duplicate repo-wide sweep subagents for the
same class.

If the current batch produces zero `verified` claims, this normalization phase
must be skipped entirely and the protocol should continue with thread handling
for the non-verified classifications only.

### 3. Require one subagent per deduped verified class

For the class-sweep phase, the protocol must require:

- one subagent per deduped verified issue class
- all non-overlapping class sweeps launched at the same time
- overlapping classes serialized when they touch the same risky area or files

For this protocol update, overlap should be defined conservatively as either:

- any shared touched or seed file already known from verification, or
- the same explicitly identified risky area / search scope

If overlap is unknown, the protocol should direct the agent to serialize rather
than guess.

This changes the current mental model from “one review comment equals one full
fix unit” to “one review comment verifies a seed example, and one deduped class
sweep handles the repo-wide fix unit.”

This dispatch-time serialization rule should be treated as authoritative for the
review protocol, even if earlier repo-wide sweep examples resolved overlap at
integration time instead.

### 4. Define each class-sweep subagent’s contract

The protocol should state that each issue-class sweep subagent must:

1. take the verified review comment(s) as seed evidence
2. identify the reusable class definition from those seeds
3. search the repo for the same class of issue
4. fix all locally-supported matches within scope, not just the seed location
5. add or extend focused tests where appropriate
6. run targeted validation for every touched scope
7. report touched files, validations, and any residual risk or skipped matches

The wording should be explicit that the sweep is repo-wide within the evidence-
supported scope, but not a license for unrelated cleanup.

The protocol should also allow a clean no-op outcome: if the sweep subagent
finds no further supported instances beyond the seed fix, it may report “no
further instances found” and exit successfully.

### 5. Separate thread handling from class-sweep execution

The protocol must continue to resolve GitHub review threads as thread-level
artifacts, but the implementation evidence used in replies/resolution should now
reference the broader class-sweep result where applicable.

That means the status model should distinguish:

- per-thread verification status
- deduped issue classes discovered in the batch
- repo-wide class-sweep outcomes per class

The protocol should explicitly say this intermediate model can live in the same
working checklist or local artifact already created for unresolved items, as
long as thread-level and class-level states stay distinct.

### 6. Update reporting requirements

The final report section in `docs/ReviewProtocol.md` should now require:

- unresolved threads found
- per-thread classifications
- deduped verified issue classes
- repo-wide sweep fixes per class
- threads resolved / replied to
- remaining unresolved threads with reasons

## Recommended `docs/ReviewProtocol.md` Edit Shape

The document should stay concise and procedural. The best update is to revise
the existing workflow steps rather than bolt on a disconnected appendix.

Recommended structure:

- keep Steps 1-3 mostly unchanged
- rewrite Step 4 into two phases:
  - `4a.` verify each unresolved claim independently
  - `4b.` dedupe verified claims into issue classes and launch one sweep
    subagent per class
- keep existing top-level numbering after Step 4 unchanged; `4a` and `4b` are
  sub-steps, not new top-level numbered steps
- update Step 5 to mention thread replies/resolution can cite the repo-wide
  sweep result for that class
- update Step 8 reporting bullets to include per-thread classifications and
  deduped issue classes
- update the guardrails so “keep fixes local to the verified claim” applies to
  the verification decision itself, while verified class sweeps are allowed to
  expand repo-wide within the evidence-supported issue class
- add a guardrail that duplicate sweeps for the same verified class are not
  allowed within one batch

## Acceptance Criteria

The update is complete when `docs/ReviewProtocol.md` clearly states all of the
following:

1. verified review comments are only the seed, not the full endpoint of work
2. verified comments in the same issue class must be deduped
3. one subagent per deduped verified class is required
4. all non-overlapping class sweeps run in parallel
5. overlapping risky areas are serialized
6. each class-sweep subagent must search the repo for the same issue class and
   fix all supported matches in scope
7. final reporting distinguishes per-thread results from per-class sweep results
8. the protocol explicitly skips class-sweep dispatch when no claims are
   classified as `verified`
9. the protocol defines overlap conservatively enough to avoid conflicting
   parallel edits
10. the guardrails no longer contradict the required repo-wide sweep behavior

## Risks and Mitigations

- **Over-broad sweeps**
  - Mitigation: require issue classes to be seeded by verified comments and keep
    the search bounded to evidence-supported patterns.
- **Duplicate or conflicting edits**
  - Mitigation: dedupe verified comments into one class before dispatch and
    serialize overlapping risky areas.
- **Loss of review-thread accountability**
  - Mitigation: preserve per-thread verification status as a first-class output
    even though execution expands to class-level sweeps.

## Implementation Note

This design updates the protocol document only. It does not itself require
changes to runtime code or GitHub automation; it changes the documented review
handling workflow that future agents must follow.
