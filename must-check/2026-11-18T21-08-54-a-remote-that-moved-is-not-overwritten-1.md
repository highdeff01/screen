# Auto-test failure — 2026-11-18T21:08:54.742Z

- queued id: `sent_mwmm61xy314996`
- failing: 1 of a remote that moved is not overwritten (1.2133ms) tests
  - ✖ a remote that moved is not overwritten (1.2133ms)

## Output tail

```
 order, attempts, lessons, continuations and guardrails (0.3698ms)
✔ a goal without an install phase gets no install methods (0.2677ms)
✔ a review that settles the check finishes the run and says so (60.3542ms)
✔ open checks are re-reviewed and the screen baseline is taken once (0.9147ms)
✔ screen reads wait while the person at the desk is typing (0.6078ms)
✔ learned habits are offered as workarounds once the check keeps failing (0.5335ms)
✔ a check that never settles is declared stalled with a strategy suggestion (5.5694ms)
✔ a live step that has not moved for minutes is reported as blocked once (0.52ms)
✔ a failed run keeps its queued check as history and is not polled (0.4046ms)
✔ each further review of the same run waits longer (0.4226ms)
✔ a queued check left open for hours is marked stale, not re-read (0.2284ms)
✔ one pass reviews only a handful of fresh runs (8.514ms)
✔ the loop starts, ticks and stops (1406.1794ms)
✔ identical screen signatures report no change (1.5753ms)
✔ a visible cell change is measured as a percentage (0.4498ms)
✔ small noise below the channel threshold is ignored (0.2529ms)
✔ hashes are stable and change with the grid (0.3625ms)
✔ copy and focus steps do not trigger false no-change warnings (0.4165ms)
✔ screenshot and note steps are not re-audited with a second capture (0.2471ms)
✔ a finished run becomes a scored, reusable workflow episode (54.6925ms)
✔ similar goals recall the prior sequence and its hindrances (1.2555ms)
✔ a different subject is not reused as the remembered question (0.1988ms)
✔ a passed episode whose typed question contradicts its goal is excluded (0.4022ms)
✔ a recalled episode can seed a plan with its conditions intact (0.2597ms)
✔ the same run is replaced instead of duplicated (0.2021ms)
✔ state summary exposes memory counts without full step payloads (0.1585ms)
✔ the memory list exposes typed detail and hindrances for the UI (0.2598ms)
✔ a newer matching pass gets a recency advantage over an older one (9.329ms)
✔ a recent failed run applies a success-trend penalty to matching memory (1.1088ms)
✔ template lookup backfills historical runs before selecting a live template (0.8986ms)
✔ a changed app version blocks reuse of a versioned memory (1.7549ms)
ℹ tests 424
ℹ suites 0
ℹ pass 419
ℹ fail 1
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 40862.5047

✖ failing tests:

test at test\git-sync.test.js:96:1
✖ a remote that moved is not overwritten (1.2133ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  true !== false
  
      at TestContext.<anonymous> (file:///C:/Users/Dan/.config/freebuff-desktop/local-projects/40af3ced-48bf-4a9d-a8b7-cb42815bab8f/test/git-sync.test.js:109:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: true,
    expected: false,
    operator: 'strictEqual',
    diff: 'simple'
  }
```

Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.
