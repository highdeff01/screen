# Auto-test failure — 2026-11-18T22:24:11.996Z

- queued id: `sent_mwmouvh834c257`
- failing: 2 of a type step with a named window that types identical text passes via corroboration (16066.3101ms),repairs that fail are reported and safe later steps still run (6695.5407ms) tests
  - ✖ a type step with a named window that types identical text passes via corroboration
  - ✖ repairs that fail are reported and safe later steps still run

## Output tail

```
(15.2821ms)
✔ the loop starts, ticks and stops (1408.5907ms)
✔ identical screen signatures report no change (2.9859ms)
✔ a visible cell change is measured as a percentage (0.2903ms)
✔ small noise below the channel threshold is ignored (0.2521ms)
✔ hashes are stable and change with the grid (0.3495ms)
✔ copy and focus steps do not trigger false no-change warnings (0.3226ms)
✔ screenshot and note steps are not re-audited with a second capture (0.1748ms)
✔ a finished run becomes a scored, reusable workflow episode (62.6901ms)
✔ similar goals recall the prior sequence and its hindrances (1.9831ms)
✔ a different subject is not reused as the remembered question (0.3563ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.8489ms)
✔ a recalled episode can seed a plan with its conditions intact (0.4381ms)
✔ the same run is replaced instead of duplicated (0.2742ms)
✔ state summary exposes memory counts without full step payloads (0.2323ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.3836ms)
✔ a newer matching pass gets a recency advantage over an older one (10.7539ms)
✔ a recent failed run applies a success-trend penalty to matching memory (1.2696ms)
✔ template lookup backfills historical runs before selecting a live template (0.8343ms)
✔ a changed app version blocks reuse of a versioned memory (1.2273ms)
ℹ tests 452
ℹ suites 0
ℹ pass 446
ℹ fail 2
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 89247.4218

✖ failing tests:

test at test\engine-screen.test.js:78:1
✖ a type step with a named window that types identical text passes via corroboration (16066.3101ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'running'
  - 'needs_review'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795040558813-33540/test/engine-screen.test.js:100:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'running',
    expected: 'needs_review',
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\repair.test.js:290:1
✖ repairs that fail are reported and safe later steps still run (6695.5407ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  'passed' !== 'failed'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795040558813-33540/test/repair.test.js:304:10)
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
