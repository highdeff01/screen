# Auto-test failure — 2026-11-18T22:23:10.221Z

- queued id: `sent_mwmotjt94aa0d4`
- failing: 2 of an unguarded type step that types identical text passes via corroboration (2812.9357ms),repairs that fail are reported and safe later steps still run (8329.5244ms) tests
  - ✖ an unguarded type step that types identical text passes via corroboration
  - ✖ repairs that fail are reported and safe later steps still run

## Output tail

```
k left open for hours is marked stale, not re-read (0.6038ms)
✔ one pass reviews only a handful of fresh runs (20.7159ms)
✔ the loop starts, ticks and stops (1424.6227ms)
✔ identical screen signatures report no change (1.3651ms)
✔ a visible cell change is measured as a percentage (0.3217ms)
✔ small noise below the channel threshold is ignored (0.2352ms)
✔ hashes are stable and change with the grid (0.3277ms)
✔ copy and focus steps do not trigger false no-change warnings (0.3642ms)
✔ screenshot and note steps are not re-audited with a second capture (0.2075ms)
✔ a finished run becomes a scored, reusable workflow episode (83.2989ms)
✔ similar goals recall the prior sequence and its hindrances (2.1981ms)
✔ a different subject is not reused as the remembered question (0.4537ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.8223ms)
✔ a recalled episode can seed a plan with its conditions intact (0.627ms)
✔ the same run is replaced instead of duplicated (0.4837ms)
✔ state summary exposes memory counts without full step payloads (0.3325ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.5948ms)
✔ a newer matching pass gets a recency advantage over an older one (15.9189ms)
✔ a recent failed run applies a success-trend penalty to matching memory (2.042ms)
✔ template lookup backfills historical runs before selecting a live template (1.3218ms)
✔ a changed app version blocks reuse of a versioned memory (12.4159ms)
ℹ tests 451
ℹ suites 0
ℹ pass 445
ℹ fail 2
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 79292.8306

✖ failing tests:

test at test\engine-screen.test.js:55:1
✖ an unguarded type step that types identical text passes via corroboration (2812.9357ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'skipped'
  - 'passed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/engine-screen.test.js:78:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'skipped',
    expected: 'passed',
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\repair.test.js:290:1
✖ repairs that fail are reported and safe later steps still run (8329.5244ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  'passed' !== 'failed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/repair.test.js:304:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'passed',
    expected: 'failed',
    operator: 'strictEqual',
    diff: 'simple'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
