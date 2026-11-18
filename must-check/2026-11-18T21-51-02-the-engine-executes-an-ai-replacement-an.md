# Auto-test failure — 2026-11-18T21:51:02.206Z

- queued id: `sent_mwmno85a09a2dc`
- failing: 1 of the engine executes an AI replacement and records the repair (20437.5227ms) tests
  - ✖ the engine executes an AI replacement and records the repair

## Output tail

```
✔ a goal without an install phase gets no install methods (0.2168ms)
✔ a review that settles the check finishes the run and says so (52.8982ms)
✔ open checks are re-reviewed and the screen baseline is taken once (1.0678ms)
✔ screen reads wait while the person at the desk is typing (0.7613ms)
✔ learned habits are offered as workarounds once the check keeps failing (0.8575ms)
✔ a check that never settles is declared stalled with a strategy suggestion (9.2242ms)
✔ a live step that has not moved for minutes is reported as blocked once (0.8748ms)
✔ a failed run keeps its queued check as history and is not polled (0.6738ms)
✔ each further review of the same run waits longer (0.8189ms)
✔ a queued check left open for hours is marked stale, not re-read (0.4038ms)
✔ one pass reviews only a handful of fresh runs (14.807ms)
✔ the loop starts, ticks and stops (1407.1096ms)
✔ identical screen signatures report no change (3.1358ms)
✔ a visible cell change is measured as a percentage (0.4483ms)
✔ small noise below the channel threshold is ignored (0.2821ms)
✔ hashes are stable and change with the grid (0.4525ms)
✔ copy and focus steps do not trigger false no-change warnings (0.6027ms)
✔ screenshot and note steps are not re-audited with a second capture (0.4025ms)
✔ a finished run becomes a scored, reusable workflow episode (59.1349ms)
✔ similar goals recall the prior sequence and its hindrances (1.9315ms)
✔ a different subject is not reused as the remembered question (0.2663ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.5732ms)
✔ a recalled episode can seed a plan with its conditions intact (0.3738ms)
✔ the same run is replaced instead of duplicated (0.2831ms)
✔ state summary exposes memory counts without full step payloads (0.186ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.3319ms)
✔ a newer matching pass gets a recency advantage over an older one (9.8606ms)
✔ a recent failed run applies a success-trend penalty to matching memory (1.1716ms)
✔ template lookup backfills historical runs before selecting a live template (1.0032ms)
✔ a changed app version blocks reuse of a versioned memory (1.3415ms)
ℹ tests 441
ℹ suites 0
ℹ pass 436
ℹ fail 1
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 59493.6741

✖ failing tests:

test at test\agent-replan.test.js:295:1
✖ the engine executes an AI replacement and records the repair (20437.5227ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  0 !== 1
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795038600781-7876/test/agent-replan.test.js:326:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 0,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
