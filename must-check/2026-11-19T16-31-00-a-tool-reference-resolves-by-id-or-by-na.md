# Auto-test failure — 2026-11-19T16:31:00.448Z

- queued id: `sent_mwnroin42d05b4`
- failing: 1 of a tool reference resolves by id or by name and refuses anything else (1.472ms) tests
  - ✖ a tool reference resolves by id or by name and refuses anything else

## Output tail

```
 moved for minutes is reported as blocked once (0.3519ms)
✔ a failed run keeps its queued check as history and is not polled (0.3227ms)
✔ each further review of the same run waits longer (0.3568ms)
✔ a queued check left open for hours is marked stale, not re-read (0.1869ms)
✔ one pass reviews only a handful of fresh runs (7.6013ms)
✔ the loop starts, ticks and stops (1414.9699ms)
✔ identical screen signatures report no change (1.6007ms)
✔ a visible cell change is measured as a percentage (0.2221ms)
✔ small noise below the channel threshold is ignored (0.2093ms)
✔ hashes are stable and change with the grid (0.235ms)
✔ copy and focus steps do not trigger false no-change warnings (0.2571ms)
✔ screenshot and note steps are not re-audited with a second capture (0.1421ms)
✔ a finished run becomes a scored, reusable workflow episode (52.3848ms)
✔ similar goals recall the prior sequence and its hindrances (1.4156ms)
✔ a different subject is not reused as the remembered question (0.2373ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.6542ms)
✔ a recalled episode can seed a plan with its conditions intact (0.4583ms)
✔ the same run is replaced instead of duplicated (0.3461ms)
✔ state summary exposes memory counts without full step payloads (0.2323ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.3229ms)
✔ a newer matching pass gets a recency advantage over an older one (7.7374ms)
✔ a recent failed run applies a success-trend penalty to matching memory (0.6597ms)
✔ template lookup backfills historical runs before selecting a live template (0.5921ms)
✔ a changed app version blocks reuse of a versioned memory (0.7409ms)
✔ unavailable backend falls back for every resolved live mode before queuing (1229.6803ms)
﹣ available backend permits both saved and explicit live modes (0.4166ms) # SKIP
ℹ tests 567
ℹ suites 0
ℹ pass 561
ℹ fail 1
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
ℹ duration_ms 95338.7875

✖ failing tests:

test at test\planner.test.js:160:1
✖ a tool reference resolves by id or by name and refuses anything else (1.472ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + undefined
  - 'tool_window_list'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795105764059-17524/test/planner.test.js:167:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: undefined,
    expected: 'tool_window_list',
    operator: 'strictEqual',
    diff: 'simple'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.

## Resolution — fixed

The failure was my own new test asserting a rule the code did not yet implement
(the id form also matching an approved tool by name). The rule is now in
`resolveToolRef` (`server/planner.js`), and the three new tests in
`test/planner.test.js` pass: `npm test` → 567 tests, 562 pass, 0 fail, 5 skipped.

Same change fixes the live failure `Tool not found: (missing id)`: a `runTool`
step that named its tool by name survived planning but execution only looked up
`params.toolId`. Plans now resolve the name to the tool's id, unapproved tools
are dropped when a plan is aligned or a supervisor replan is applied, and the
executor resolves either form so workflows saved earlier keep working.

## Dismissed — 2026-11-19

`runTool` now resolves a tool by id or name (commit 806ad54); the test passes. Verified on `d6711c9`: `npm test` → 589 tests, 584 pass, 0 fail, 5 skipped.

Dismissed in the repair queue after that run; re-open it if the same failure returns.
