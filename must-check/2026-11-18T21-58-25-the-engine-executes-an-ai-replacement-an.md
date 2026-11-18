# Auto-test failure — 2026-11-18T21:58:25.973Z

- queued id: `sent_mwmnxqk5119a92`
- failing: 2 of the engine executes an AI replacement and records the repair (6714.083ms),the engine rewrites the remainder after an irreparable action and still passes (13520.5951ms) tests
  - ✖ the engine executes an AI replacement and records the repair
  - ✖ the engine rewrites the remainder after an irreparable action and still passes

## Output tail

```
is marked stale, not re-read (0.4945ms)
✔ one pass reviews only a handful of fresh runs (16.7866ms)
✔ the loop starts, ticks and stops (1413.7653ms)
✔ identical screen signatures report no change (2.3673ms)
✔ a visible cell change is measured as a percentage (0.3059ms)
✔ small noise below the channel threshold is ignored (0.2404ms)
✔ hashes are stable and change with the grid (0.3105ms)
✔ copy and focus steps do not trigger false no-change warnings (0.3601ms)
✔ screenshot and note steps are not re-audited with a second capture (0.2439ms)
✔ a finished run becomes a scored, reusable workflow episode (106.3966ms)
✔ similar goals recall the prior sequence and its hindrances (2.3133ms)
✔ a different subject is not reused as the remembered question (0.3978ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.7461ms)
✔ a recalled episode can seed a plan with its conditions intact (0.5228ms)
✔ the same run is replaced instead of duplicated (0.4157ms)
✔ state summary exposes memory counts without full step payloads (0.2635ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.3984ms)
✔ a newer matching pass gets a recency advantage over an older one (10.8536ms)
✔ a recent failed run applies a success-trend penalty to matching memory (1.2388ms)
✔ template lookup backfills historical runs before selecting a live template (0.9319ms)
✔ a changed app version blocks reuse of a versioned memory (0.9873ms)
ℹ tests 445
ℹ suites 0
ℹ pass 439
ℹ fail 2
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 68628.2765

✖ failing tests:

test at test\agent-replan.test.js:295:1
✖ the engine executes an AI replacement and records the repair (6714.083ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  0 !== 1
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795039035386-20372/test/agent-replan.test.js:326:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 0,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\agent-replan.test.js:391:1
✖ the engine rewrites the remainder after an irreparable action and still passes (13520.5951ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  0 !== 1
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/data/worktrees/sentinel-1795039035386-20372/test/agent-replan.test.js:425:10)
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
