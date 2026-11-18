# Auto-test failure — 2026-11-18T22:25:30.816Z

- queued id: `sent_mwmowkao456162`
- failing: 2 of a type step with a named window that types identical text passes via corroboration (12324.5724ms),repairs that fail are reported and safe later steps still run (5454.317ms) tests
  - ✖ a type step with a named window that types identical text passes via corroboration
  - ✖ repairs that fail are reported and safe later steps still run

## Output tail

```
s)
✔ one pass reviews only a handful of fresh runs (15.6582ms)
✔ the loop starts, ticks and stops (1402.4223ms)
✔ identical screen signatures report no change (2.8379ms)
✔ a visible cell change is measured as a percentage (0.4465ms)
✔ small noise below the channel threshold is ignored (0.2306ms)
✔ hashes are stable and change with the grid (0.3212ms)
✔ copy and focus steps do not trigger false no-change warnings (0.4937ms)
✔ screenshot and note steps are not re-audited with a second capture (0.3294ms)
✔ a finished run becomes a scored, reusable workflow episode (71.8023ms)
✔ similar goals recall the prior sequence and its hindrances (2.1244ms)
✔ a different subject is not reused as the remembered question (0.4531ms)
✔ a passed episode whose typed question contradicts its goal is excluded (1.4826ms)
✔ a recalled episode can seed a plan with its conditions intact (1.1232ms)
✔ the same run is replaced instead of duplicated (0.9682ms)
✔ state summary exposes memory counts without full step payloads (0.5062ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.6706ms)
✔ a newer matching pass gets a recency advantage over an older one (17.4425ms)
✔ a recent failed run applies a success-trend penalty to matching memory (1.8448ms)
✔ template lookup backfills historical runs before selecting a live template (1.0655ms)
✔ a changed app version blocks reuse of a versioned memory (1.2368ms)
ℹ tests 452
ℹ suites 0
ℹ pass 446
ℹ fail 2
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 78450.8661

✖ failing tests:

test at test\engine-screen.test.js:78:1
✖ a type step with a named window that types identical text passes via corroboration (12324.5724ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  undefined !== 0
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795040650820-32912/test/engine-screen.test.js:102:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: undefined,
    expected: 0,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\repair.test.js:290:1
✖ repairs that fail are reported and safe later steps still run (5454.317ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  'passed' !== 'failed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795040650820-32912/test/repair.test.js:304:10)
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
