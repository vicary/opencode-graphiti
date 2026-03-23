# GitHub PR Review Protocol

Use this protocol when the current branch is linked to an open GitHub pull
request and review feedback needs to be handled systematically.

## Purpose

- use live GitHub review state as the source of truth
- verify each review claim before changing code
- keep fixes narrow and scoped to the verified issue
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
   - Treat the checklist as execution tracking only, not as the code-change
     plan.

4. Verify each unresolved claim independently.
   - Spawn one swarm session per unresolved review item.
   - Run independent sessions concurrently when scopes do not overlap.
   - Serialize items that touch the same risky area.
   - Each session must:
     - verify the claim against the current working tree
     - classify it as verified, already satisfied, stale, invalid, or unclear
     - apply a narrow fix only if verified
     - add or update focused tests when needed
     - run targeted validation for the touched scope

5. Resolve review items on GitHub.
   - For each handled item:
     - reply if a short explanation is useful
     - resolve the review thread when the issue is fixed or already satisfied
   - If a claim is exaggerated, stale, or invalid, leave a brief factual reply
     before resolving when appropriate.
   - If all reviews under a higher-level comment/review wrapper are handled,
     hide that umbrella comment with reason `resolved` when GitHub permissions
     and tooling allow it.
   - If replies were added through a pending personal review, explicitly submit
     that review so the comments are visible to reviewers and no replies remain
     stuck in `PENDING` state.

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
     - unresolved items found
     - items fixed
     - items resolved/commented
     - commit sha
     - push status
     - final unresolved review count

## Guardrails

- always use live `gh` data, not stale local notes, as the source of truth
- preserve unrelated uncommitted work
- do not perform opportunistic refactors while addressing reviews
- keep fixes local to the verified claim
- prefer focused tests and validation per review item before broader checks
- treat resolved or outdated threads as historical context, not current work
