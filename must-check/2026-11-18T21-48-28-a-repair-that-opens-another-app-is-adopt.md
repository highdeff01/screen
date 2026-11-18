# Auto-test failure — 2026-11-18T21:48:28.133Z

- queued id: `sent_mwmnkx9h7d8b57`
- failing: 1 of a repair that opens another app is adopted by the presenter and verifier (25057.481ms) tests
  - ✖ a repair that opens another app is adopted by the presenter and verifier

## Output tail

```
ms)
✔ a review that settles the check finishes the run and says so (65.6454ms)
✔ open checks are re-reviewed and the screen baseline is taken once (0.9217ms)
✔ screen reads wait while the person at the desk is typing (0.5801ms)
✔ learned habits are offered as workarounds once the check keeps failing (1.2715ms)
✔ a check that never settles is declared stalled with a strategy suggestion (7.5877ms)
✔ a live step that has not moved for minutes is reported as blocked once (1.0131ms)
✔ a failed run keeps its queued check as history and is not polled (0.7729ms)
✔ each further review of the same run waits longer (0.8273ms)
✔ a queued check left open for hours is marked stale, not re-read (0.8808ms)
✔ one pass reviews only a handful of fresh runs (16.3308ms)
✔ the loop starts, ticks and stops (1413.607ms)
✔ identical screen signatures report no change (1.665ms)
✔ a visible cell change is measured as a percentage (0.1922ms)
✔ small noise below the channel threshold is ignored (0.122ms)
✔ hashes are stable and change with the grid (0.1896ms)
✔ copy and focus steps do not trigger false no-change warnings (0.2223ms)
✔ screenshot and note steps are not re-audited with a second capture (0.1153ms)
✔ a finished run becomes a scored, reusable workflow episode (58.6108ms)
✔ similar goals recall the prior sequence and its hindrances (1.5808ms)
✔ a different subject is not reused as the remembered question (0.2233ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.4337ms)
✔ a recalled episode can seed a plan with its conditions intact (0.3053ms)
✔ the same run is replaced instead of duplicated (0.2456ms)
✔ state summary exposes memory counts without full step payloads (0.2124ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.3333ms)
✔ a newer matching pass gets a recency advantage over an older one (10.0592ms)
✔ a recent failed run applies a success-trend penalty to matching memory (1.0594ms)
✔ template lookup backfills historical runs before selecting a live template (1.1985ms)
✔ a changed app version blocks reuse of a versioned memory (1.3911ms)
ℹ tests 441
ℹ suites 0
ℹ pass 436
ℹ fail 1
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 61673.7092

✖ failing tests:

test at test\agent-replan.test.js:334:1
✖ a repair that opens another app is adopted by the presenter and verifier (25057.481ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'running'
  - 'passed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038438083-7876/test/agent-replan.test.js:378:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'running',
    expected: 'passed',
    operator: 'strictEqual',
    diff: 'simple'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
