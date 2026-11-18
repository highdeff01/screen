# Auto-test failure — 2026-11-18T21:12:16.197Z

- queued id: `sent_mwmmaddw00bb39`
- failing: 1 of chat() reaches the console provider through the local gateway (1591.9948ms) tests
  - ✖ chat() reaches the console provider through the local gateway

## Output tail

```
drails (0.5922ms)
✔ a goal without an install phase gets no install methods (0.3082ms)
✔ a review that settles the check finishes the run and says so (65.7671ms)
✔ open checks are re-reviewed and the screen baseline is taken once (1.0178ms)
✔ screen reads wait while the person at the desk is typing (0.6022ms)
✔ learned habits are offered as workarounds once the check keeps failing (0.5832ms)
✔ a check that never settles is declared stalled with a strategy suggestion (7.7989ms)
✔ a live step that has not moved for minutes is reported as blocked once (0.6156ms)
✔ a failed run keeps its queued check as history and is not polled (0.6922ms)
✔ each further review of the same run waits longer (0.8335ms)
✔ a queued check left open for hours is marked stale, not re-read (0.4238ms)
✔ one pass reviews only a handful of fresh runs (15.5773ms)
✔ the loop starts, ticks and stops (1413.2369ms)
✔ identical screen signatures report no change (2.2308ms)
✔ a visible cell change is measured as a percentage (0.2923ms)
✔ small noise below the channel threshold is ignored (0.2524ms)
✔ hashes are stable and change with the grid (0.3587ms)
✔ copy and focus steps do not trigger false no-change warnings (0.3773ms)
✔ screenshot and note steps are not re-audited with a second capture (0.1641ms)
✔ a finished run becomes a scored, reusable workflow episode (63.8274ms)
✔ similar goals recall the prior sequence and its hindrances (2.0495ms)
✔ a different subject is not reused as the remembered question (0.3939ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.8729ms)
✔ a recalled episode can seed a plan with its conditions intact (0.596ms)
✔ the same run is replaced instead of duplicated (0.4425ms)
✔ state summary exposes memory counts without full step payloads (0.3111ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.6493ms)
✔ a newer matching pass gets a recency advantage over an older one (14.4381ms)
✔ a recent failed run applies a success-trend penalty to matching memory (1.0665ms)
✔ template lookup backfills historical runs before selecting a live template (0.937ms)
✔ a changed app version blocks reuse of a versioned memory (1.0575ms)
ℹ tests 437
ℹ suites 0
ℹ pass 432
ℹ fail 1
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 46574.0213

✖ failing tests:

test at test\gateway.test.js:130:1
✖ chat() reaches the console provider through the local gateway (1591.9948ms)
  AssertionError [ERR_ASSERTION]: fetch failed
  
  false !== true
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795036285351-19540/test/gateway.test.js:135:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: 'strictEqual',
    diff: 'simple'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
