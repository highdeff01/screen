# Auto-test failure — 2026-11-18T23:16:12.141Z

- queued id: `sent_mwmqpqzx5df295`
- failing: 1 of a type step with a named window proves its destination instead of guessing from the screen (14003.4972ms) tests
  - ✖ a type step with a named window proves its destination instead of guessing from the screen

## Output tail

```
es the check finishes the run and says so (77.7485ms)
✔ open checks are re-reviewed and the screen baseline is taken once (1.2518ms)
✔ screen reads wait while the person at the desk is typing (0.5281ms)
✔ learned habits are offered as workarounds once the check keeps failing (0.3986ms)
✔ a check that never settles is declared stalled with a strategy suggestion (7.5139ms)
✔ a live step that has not moved for minutes is reported as blocked once (0.4326ms)
✔ a failed run keeps its queued check as history and is not polled (0.3758ms)
✔ each further review of the same run waits longer (1.0364ms)
✔ a queued check left open for hours is marked stale, not re-read (0.2651ms)
✔ one pass reviews only a handful of fresh runs (13.2423ms)
✔ the loop starts, ticks and stops (1451.3244ms)
✔ identical screen signatures report no change (1.7361ms)
✔ a visible cell change is measured as a percentage (0.1705ms)
✔ small noise below the channel threshold is ignored (0.1289ms)
✔ hashes are stable and change with the grid (0.2037ms)
✔ copy and focus steps do not trigger false no-change warnings (0.2183ms)
✔ screenshot and note steps are not re-audited with a second capture (0.1165ms)
✔ a finished run becomes a scored, reusable workflow episode (72.8719ms)
✔ similar goals recall the prior sequence and its hindrances (1.7863ms)
✔ a different subject is not reused as the remembered question (0.3904ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.4871ms)
✔ a recalled episode can seed a plan with its conditions intact (0.3018ms)
✔ the same run is replaced instead of duplicated (0.4387ms)
✔ state summary exposes memory counts without full step payloads (0.4076ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.5362ms)
✔ a newer matching pass gets a recency advantage over an older one (14.0246ms)
✔ a recent failed run applies a success-trend penalty to matching memory (1.4505ms)
✔ template lookup backfills historical runs before selecting a live template (1.2182ms)
✔ a changed app version blocks reuse of a versioned memory (1.9001ms)
ℹ tests 467
ℹ suites 0
ℹ pass 462
ℹ fail 1
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 121155.5878

✖ failing tests:

test at test\engine-screen.test.js:78:1
✖ a type step with a named window proves its destination instead of guessing from the screen (14003.4972ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'running'
  - 'passed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795043627632-29220/test/engine-screen.test.js:100:10)
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
