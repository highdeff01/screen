# Auto-test failure — 2026-11-19T01:49:25.850Z

- queued id: `sent_mwmw6swqfa250d`
- failing: 1 of a repair that opens another app is adopted by the presenter and verifier (25060.143ms) tests
  - ✖ a repair that opens another app is adopted by the presenter and verifier

## Output tail

```
ait while the person at the desk is typing (0.2707ms)
✔ learned habits are offered as workarounds once the check keeps failing (0.6809ms)
✔ a check that never settles is declared stalled with a strategy suggestion (3.5776ms)
✔ a live step that has not moved for minutes is reported as blocked once (0.3308ms)
✔ a failed run keeps its queued check as history and is not polled (0.3209ms)
✔ each further review of the same run waits longer (0.3766ms)
✔ a queued check left open for hours is marked stale, not re-read (0.1968ms)
✔ one pass reviews only a handful of fresh runs (8.5233ms)
✔ the loop starts, ticks and stops (1415.0981ms)
✔ identical screen signatures report no change (1.3483ms)
✔ a visible cell change is measured as a percentage (0.1586ms)
✔ small noise below the channel threshold is ignored (0.116ms)
✔ hashes are stable and change with the grid (0.1814ms)
✔ copy and focus steps do not trigger false no-change warnings (0.2132ms)
✔ screenshot and note steps are not re-audited with a second capture (0.1078ms)
✔ a finished run becomes a scored, reusable workflow episode (50.9682ms)
✔ similar goals recall the prior sequence and its hindrances (1.3184ms)
✔ a different subject is not reused as the remembered question (0.2018ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.4262ms)
✔ a recalled episode can seed a plan with its conditions intact (0.2616ms)
✔ the same run is replaced instead of duplicated (0.2038ms)
✔ state summary exposes memory counts without full step payloads (0.1495ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.2732ms)
✔ a newer matching pass gets a recency advantage over an older one (7.4612ms)
✔ a recent failed run applies a success-trend penalty to matching memory (0.6511ms)
✔ template lookup backfills historical runs before selecting a live template (0.5189ms)
✔ a changed app version blocks reuse of a versioned memory (0.6726ms)
✔ unavailable backend falls back for every resolved live mode before queuing (9380.9801ms)
﹣ available backend permits both saved and explicit live modes (0.2387ms) # SKIP
ℹ tests 511
ℹ suites 0
ℹ pass 505
ℹ fail 1
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
ℹ duration_ms 179673.0543

✖ failing tests:

test at test\agent-replan.test.js:334:1
✖ a repair that opens another app is adopted by the presenter and verifier (25060.143ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'running'
  - 'passed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795052763222-19240/test/agent-replan.test.js:378:10)
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
