# Auto-test failure — 2026-11-18T20:32:56.319Z

- queued id: `sent_mwmkvshr7e8e87`
- failing: 1 of transferring changes between versions lands them on the current tree (1513.2196ms) tests
  - ✖ transferring changes between versions lands them on the current tree (1513.2196ms)

## Output tail

```

✔ screen reads wait while the person at the desk is typing (1.0019ms)
✔ learned habits are offered as workarounds once the check keeps failing (0.7367ms)
✔ a check that never settles is declared stalled with a strategy suggestion (7.9843ms)
✔ a live step that has not moved for minutes is reported as blocked once (0.634ms)
✔ a failed run keeps its queued check as history and is not polled (0.842ms)
✔ each further review of the same run waits longer (0.8271ms)
✔ a queued check left open for hours is marked stale, not re-read (0.3783ms)
✔ one pass reviews only a handful of fresh runs (21.023ms)
✔ the loop starts, ticks and stops (1407.5274ms)
✔ identical screen signatures report no change (1.2732ms)
✔ a visible cell change is measured as a percentage (0.3185ms)
✔ small noise below the channel threshold is ignored (0.2241ms)
✔ hashes are stable and change with the grid (0.3683ms)
✔ copy and focus steps do not trigger false no-change warnings (0.416ms)
✔ screenshot and note steps are not re-audited with a second capture (0.2154ms)
✔ a finished run becomes a scored, reusable workflow episode (71.5901ms)
✔ similar goals recall the prior sequence and its hindrances (2.0091ms)
✔ a different subject is not reused as the remembered question (0.4338ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.814ms)
✔ a recalled episode can seed a plan with its conditions intact (0.5296ms)
✔ the same run is replaced instead of duplicated (0.4178ms)
✔ state summary exposes memory counts without full step payloads (0.2824ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.6743ms)
✔ a newer matching pass gets a recency advantage over an older one (16.3603ms)
✔ a recent failed run applies a success-trend penalty to matching memory (2.2205ms)
✔ template lookup backfills historical runs before selecting a live template (1.6372ms)
✔ a changed app version blocks reuse of a versioned memory (1.2549ms)
ℹ tests 418
ℹ suites 0
ℹ pass 413
ℹ fail 1
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 38276.1337

✖ failing tests:

test at test\snapshots.test.js:77:1
✖ transferring changes between versions lands them on the current tree (1513.2196ms)
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /safety/. Input:
  
  '“first” restored; what was here is kept as snapshot “before restore of “first””.'
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/snapshots.test.js:84:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: '“first” restored; what was here is kept as snapshot “before restore of “first””.',
    expected: /safety/,
    operator: 'match',
    diff: 'simple'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
