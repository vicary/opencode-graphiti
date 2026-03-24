# GitHub PR Review Protocol

Use this protocol when the current branch is linked to an open GitHub pull
request and review feedback needs to be handled systematically.

## Purpose

- use live GitHub review state as the source of truth
- verify each review claim before changing code
- treat verified claims as seed evidence for repo-wide issue-class sweeps, not
  as the full endpoint of work
- dedupe verified claims into issue classes and sweep the repo for each class
- keep per-thread verification evidence narrow; keep class-sweep fixes within
  the evidence-supported issue class
- resolve handled review threads and leave review re-requesting to the user

## Required Unresolved-Batch Query

Use this command exactly as written for metadata-first traversal across
review-thread pages until it collects the first 10 unresolved threads. The 10
unresolved items may be sparse, non-contiguous, and spread across multiple
pages. After that metadata pass, fetch narrow details only for that unresolved
batch. Do not rewrite, broaden, or replace it with an equivalent query.

If this command fails for any reason, stop and report the failure explicitly
before taking any further review-handling action.

```bash
deno eval 'const o="OWNER",r="REPO",n="PR_NUMBER",maxUnresolved=10,mq="query($o:String!,$r:String!,$n:Int!,$a:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:20,after:$a){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated path}}}}}",dq="query($ids:[ID!]!){nodes(ids:$ids){... on PullRequestReviewThread{id path isResolved isOutdated comments(first:10){nodes{author{login}body url createdAt}}}}}";let a=null,t={pageInfo:{hasNextPage:false,endCursor:null},nodes:[]},u=[];for(;;){const c=new Deno.Command("gh",{args:["api","graphql","-f",`query=${mq}`,"-F",`o=${o}`,"-F",`r=${r}`,"-F",`n=${n}`,...(a?["-F",`a=${a}`]:[])]});const x=await c.output();if(!x.success){console.error(new TextDecoder().decode(x.stderr));Deno.exit(x.code)}t=JSON.parse(new TextDecoder().decode(x.stdout)).data.repository.pullRequest.reviewThreads;for(const node of t.nodes){if(!node.isResolved)u.push(node);if(u.length===maxUnresolved)break}if(u.length===maxUnresolved||!t.pageInfo.hasNextPage)break;a=t.pageInfo.endCursor}const ids=u.slice(0,maxUnresolved).map(x=>x.id);let d=[];if(ids.length){const c=new Deno.Command("gh",{args:["api","graphql","-f",`query=${dq}`,...ids.flatMap(id=>["-F",`ids[]=${id}`])]});const x=await c.output();if(!x.success){console.error(new TextDecoder().decode(x.stderr));Deno.exit(x.code)}d=JSON.parse(new TextDecoder().decode(x.stdout)).data.nodes.filter(Boolean)}console.log(JSON.stringify({pageInfo:t.pageInfo,batchSize:ids.length,exhausted:!t.pageInfo.hasNextPage&&ids.length<maxUnresolved,unresolved:d.length?d:u.slice(0,maxUnresolved)}))'
```

## Workflow

1. Detect the active PR.
   - Run `gh pr status` or `gh pr view`.
   - If the current branch is not linked to an open PR, stop and report that PR
     review handling is skipped.

2. Fetch live review state.
   - Use GraphQL `reviewThreads` as the source of truth for unresolved state;
     REST review comments do not expose thread resolution and cannot be filtered
     to unresolved-only.
   - Run the required unresolved-batch query command exactly as written in
     `Required Unresolved-Batch Query`.
   - If the command fails, stop and report the failure explicitly.
   - Keep GraphQL payloads narrow: request small pages (`first: 20` or similar)
     and fetch only thread metadata first (`id`, `isResolved`, `isOutdated`,
     `path`, `pageInfo`) while paginating. Do not request full comment bodies
     for every thread in the first pass.
   - Traverse metadata pages sequentially until you either collect 10 unresolved
     threads or exhaust pagination.
   - Expect unresolved threads to be sparse and split across multiple pages; do
     not assume they are contiguous on one page.
   - If unresolved items are found, run a second narrow GraphQL query only for
     those unresolved thread IDs in the current batch to fetch review contents.
   - Re-run the same query after resolving a batch so the protocol can process
     the next 10 unresolved items in a pseudo while loop until none remain.
   - If you need latest-first lightweight browsing, use REST review comments as
     a secondary view (`/pulls/{number}/comments?sort=updated&direction=desc`),
     but do not use REST as the authoritative unresolved-thread source.
   - Normalize unresolved items into discrete review claims with:
     - thread id
     - file/path
     - claim summary
     - overlapping scope/risk area

3. Create a working checklist.
   - Write the current unresolved items into a local artifact or todo list.
   - The checklist tracks execution state, not the code-change plan. It must
     carry three distinct state layers:
     - per-thread verification status (verified / already satisfied / stale /
       invalid / unclear)
     - deduped issue classes discovered in the batch (populated after Step 4a)
     - per-class sweep outcomes (populated after Step 4b)
   - These layers may live in the same artifact but must remain distinguishable.

4. Verify claims and sweep issue classes.

   **4a. Verify each unresolved claim independently.**
   - Spawn one swarm session per unresolved review item.
   - Run independent sessions concurrently when scopes do not overlap.
   - Serialize items that touch the same risky area.
   - Each session must:
     - verify the claim against the current working tree
     - classify it as: verified, already satisfied, stale, invalid, or unclear
   - A verified classification means the claim is confirmed as a real issue in
     the current working tree. It becomes seed evidence for the class-sweep
     phase, not the endpoint of work.
   - Non-verified classifications (already satisfied, stale, invalid, unclear)
     proceed directly to thread handling in Step 5.

   **4b. Dedupe verified claims into issue classes and dispatch class sweeps.**

   _Zero-verified short-circuit:_ if no claims in the current batch are
   classified as `verified`, skip this sub-step entirely and proceed to Step 5.

   For all `verified` claims, normalize into deduped issue classes. Each class
   entry must capture:
   - issue-class label
   - seed review thread IDs
   - seed files / evidence locations
   - risky area / likely search scope
   - whether the class can run in parallel with other classes

   Multiple verified comments that describe the same underlying pattern must be
   collapsed into one issue class. Do not launch duplicate class sweeps for the
   same issue class within one batch.

   Dispatch one subagent per deduped verified issue class:
   - Launch all non-overlapping class sweeps in parallel.
   - Serialize classes that overlap. Overlap is defined conservatively as:
     - any shared seed or touched file already known from verification, or
     - the same explicitly identified risky area / search scope.
   - If overlap between two classes is unknown, serialize rather than guess.
   - This dispatch-time serialization rule is authoritative for the review
     protocol, even if earlier repo-wide sweep examples resolved overlap at
     integration time instead.

   Each class-sweep subagent must:
   1. take the verified review comment(s) as seed evidence
   2. identify the reusable issue-class definition from those seeds
   3. search the repo for the same class of issue
   4. fix all locally-supported matches within scope, not just the seed location
   5. add or extend focused tests where appropriate
   6. run targeted validation for every touched scope
   7. report touched files, validations, and any residual risk or skipped
      matches

   The sweep is repo-wide within the evidence-supported scope, but not a license
   for unrelated cleanup. If the sweep subagent finds no further instances
   beyond the seed fix, it may report "no further instances found" and exit
   successfully.

5. Resolve review items on GitHub.
   - For each handled item:
     - reply if a short explanation is useful; cite the repo-wide class-sweep
       result where applicable rather than only the seed fix
     - resolve the review thread when the issue is fixed or already satisfied
   - If a claim is exaggerated, stale, or invalid, leave a brief factual reply
     before resolving when appropriate.
   - If all reviews under a higher-level comment/review wrapper are handled,
     hide that umbrella comment with reason `resolved` when GitHub permissions
     and tooling allow it.
   - If replies were added through a pending personal review, explicitly submit
     that review so the comments are visible to reviewers and no replies remain
     stuck in `PENDING` state.
   - Thread resolution remains a per-thread artifact. The broader class-sweep
     outcome is valid evidence for the reply, but each thread is still resolved
     individually.

6. Re-check live review state.
   - Query GitHub again.
   - Confirm the remaining unresolved review count.
   - If items remain unresolved, report them explicitly with reasons.

7. Commit and push.
   - Run focused validation on the touched files while iterating.
   - Before commit, run the full test suite and confirm it passes.
   - Run `deno task build` as a readiness check before push.
   - Create a review-follow-up commit.
   - Push the branch to the PR remote.

8. Report status.
   - Include:
     - PR number and URL
     - unresolved threads found
     - per-thread verification classifications
     - deduped verified issue classes
     - repo-wide sweep fixes per class (files touched, validations, residual
       risk)
     - threads resolved / replied to
     - commit sha
     - push status
     - final unresolved review count with reasons for any remaining items

## Guardrails

- always use live `gh` data, not stale local notes, as the source of truth
- preserve unrelated uncommitted work
- do not perform opportunistic refactors while addressing reviews
- keep per-thread verification evidence narrow and local to the specific claim
- once a claim is verified, the resulting class sweep may expand repo-wide but
  only within the evidence-supported issue class
- never launch duplicate sweeps for the same verified issue class in one batch
- serialize overlapping or unknown-overlap class sweeps at dispatch time
- prefer focused tests and validation per review item and per class sweep before
  broader checks
- treat resolved or outdated threads as historical context, not current work
